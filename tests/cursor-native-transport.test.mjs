import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const PROTOCOL = await import("../modules/provider-cursor/src/native-protocol.mjs");
const { createCursorNativeExecutor } = await import("../modules/provider-cursor/src/native-transport.mjs");
const { decodeCursorTruncateFlag } = PROTOCOL;

test("cursor truncate flag frame is recognized", () => {
  assert.equal(decodeCursorTruncateFlag(Buffer.from("000000000f0a0d0a0b0a097472756e63617465", "hex")), true);
  assert.equal(decodeCursorTruncateFlag(Buffer.from("0000000004deadbeef", "hex")), false);
});

test("decodeCursorText reads composer thinking_delta on interaction field 4", () => {
  const { decodeCursorText } = PROTOCOL;
  const thinking = PROTOCOL.bytesField(1, PROTOCOL.bytesField(4, PROTOCOL.stringField(1, "planning the next step")));
  const answer = PROTOCOL.bytesField(1, PROTOCOL.bytesField(1, PROTOCOL.stringField(1, "PONG")));
  assert.equal(decodeCursorText(thinking), "planning the next step");
  assert.equal(decodeCursorText(answer), "PONG");
});

// ---- fake http2：第 N 次尝试由 handlers[N] 同步往 stream 上推帧 ----
function createFakeHttp2(handlers, writes) {
  let attempt = 0;
  return {
    constants: {},
    attempts: () => attempt,
    connect() {
      const session = new EventEmitter();
      session.closed = false;
      session.destroyed = false;
      session.close = () => { session.closed = true; };
      session.request = () => {
        const handler = handlers[Math.min(attempt, handlers.length - 1)];
        attempt += 1;
        const stream = new EventEmitter();
        stream.destroyed = false;
        stream.closed = false;
        stream.write = (chunk) => { writes.push(Buffer.from(chunk)); return true; };
        stream.close = () => { stream.closed = true; };
        stream.destroy = () => {};
        stream.end = () => {};
        queueMicrotask(() => handler(stream, attempt));
        return stream;
      };
      return session;
    },
  };
}

const OK_RESPONSE = { ":status": 200, "content-type": "application/connect+proto" };
const TRUNCATE_LEFTOVER = Buffer.from("000000000f0a0d0a0b0a097472756e63617465", "hex");

function textFrame(text) {
  // decodeCursorText 需要 message.1 -> interaction.1 -> update.1(string)
  return PROTOCOL.frameConnectMessage(
    PROTOCOL.bytesField(1, PROTOCOL.bytesField(1, PROTOCOL.stringField(1, text))),
  );
}

function completeTrailer() {
  // flags=2 的 end-stream 帧，payload "{}" 无 error => 服务端视角正常完成
  return PROTOCOL.frameConnectMessage(Buffer.from("{}"), 2);
}

function heartbeatDiagFrame() {
  // 线上 F7：1.8.1 心跳/诊断帧。有字节但没有助手文本，不能续命进度超时。
  return PROTOCOL.frameConnectMessage(
    PROTOCOL.bytesField(1, PROTOCOL.bytesField(8, PROTOCOL.varintField(1, 0))),
  );
}

const MESSAGES = [
  { role: "user", content: "x".repeat(400) },
  { role: "assistant", content: "y" },
  { role: "user", content: "question" },
];

function createExecutor(http2Module) {
  return createCursorNativeExecutor({
    endpoint: "https://agent.api5.cursor.sh/agent.v1.AgentService/Run",
    tokenResolver: async () => ({ token: "test-token" }),
    http2Module,
  });
}

async function collect(executor) {
  const chunks = [];
  for await (const chunk of executor({ request: { messages: MESSAGES, model: "composer-2.5" }, invocation: {}, context: {} })) {
    chunks.push(chunk);
  }
  return chunks;
}

test("agent request carries the system prompt in the inlined user text", () => {
  // 置空 conversation state 后，system 消息只能靠 userText 内联携带
  const encoded = PROTOCOL.encodeAgentRunRequest({
    messages: [
      { role: "system", content: "You are TESTSYS-7f3, follow the rules." },
      { role: "user", content: "hello" },
    ],
    model: "composer-2.5", requestId: "req-sys", conversationId: "req-sys", tools: [], timeZone: "Asia/Shanghai"
  });
  const run = PROTOCOL.decodeProtoFields(encoded.frame.slice(5)).find((f) => f.field === 1).value;
  const action = PROTOCOL.decodeProtoFields(run).find((f) => f.field === 2).value;
  const userMessage = PROTOCOL.decodeProtoFields(action).find((f) => f.field === 1).value;
  const text = Buffer.from(PROTOCOL.decodeProtoFields(userMessage).find((f) => f.field === 1).value).toString("utf8");
  assert.ok(text.includes("You are TESTSYS-7f3"), "system prompt must be inlined into user text");
  assert.ok(text.includes("hello"), "current user message must be present");
});

test("executor halves messages and retries when the server sends a truncated flag leftover", async () => {
  const writes = [];
  const http2 = createFakeHttp2([
    (stream) => {
      // 第一次：只吐 19B 的 truncate 残帧（声明 15B payload、实际 14B），随后关流。
      // 修复前：残帧永远进不了帧循环 => CURSOR_INCOMPLETE_RESPONSE 且不对半重试。
      stream.emit("response", OK_RESPONSE);
      stream.emit("data", TRUNCATE_LEFTOVER);
      stream.emit("end");
    },
    (stream) => {
      // 第二次：历史已对半，正常完成
      stream.emit("response", OK_RESPONSE);
      stream.emit("data", textFrame("recovered"));
      stream.emit("data", completeTrailer());
      stream.emit("end");
    },
  ], writes);
  const chunks = await collect(createExecutor(http2));
  assert.equal(http2.attempts(), 2, "truncate must trigger exactly one retry");
  assert.ok(writes.length >= 2, "both attempts must send a request frame");
  assert.ok(writes[0].length > writes[1].length, "halved history must produce a smaller request frame");
  const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
  assert.equal(text, "recovered");
  assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "stop" } });
});

test("executor fails over to a retry when the server goes byte-silent (idle timeout)", async () => {
  process.env.DOCKYARD_CURSOR_IDLE_TIMEOUT_MS = "300";
  try {
    const writes = [];
    const http2 = createFakeHttp2([
      (stream) => {
        // 第一次：响应头之后服务端一个字节都不发（黑洞），靠空闲超时主动断掉
        stream.emit("response", OK_RESPONSE);
      },
      (stream) => {
        stream.emit("response", OK_RESPONSE);
        stream.emit("data", textFrame("late"));
        stream.emit("data", completeTrailer());
        stream.emit("end");
      },
    ], writes);
    const chunks = await collect(createExecutor(http2));
    assert.equal(http2.attempts(), 2, "byte-silent stream must be retried");
    const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
    assert.equal(text, "late");
    assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "stop" } });
  } finally {
    delete process.env.DOCKYARD_CURSOR_IDLE_TIMEOUT_MS;
  }
});

test("executor fails over when the server only sends diagnostic heartbeats", async () => {
  process.env.DOCKYARD_CURSOR_IDLE_TIMEOUT_MS = "300";
  try {
    const writes = [];
    const http2 = createFakeHttp2([
      (stream) => {
        stream.emit("response", OK_RESPONSE);
        const tick = setInterval(() => {
          if (stream.closed || stream.destroyed) {
            clearInterval(tick);
            return;
          }
          stream.emit("data", heartbeatDiagFrame());
        }, 80);
        const stop = () => clearInterval(tick);
        const originalClose = stream.close;
        stream.close = (...args) => { stop(); return originalClose?.(...args); };
      },
      (stream) => {
        stream.emit("response", OK_RESPONSE);
        stream.emit("data", textFrame("pong"));
        stream.emit("data", completeTrailer());
        stream.emit("end");
      },
    ], writes);
    const chunks = await collect(createExecutor(http2));
    assert.equal(http2.attempts(), 2, "heartbeat-only stream must be retried");
    const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
    assert.equal(text, "pong");
    assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "stop" } });
  } finally {
    delete process.env.DOCKYARD_CURSOR_IDLE_TIMEOUT_MS;
  }
});

test("progress timeout does not kill a stream after assistant text has started", async () => {
  process.env.DOCKYARD_CURSOR_IDLE_TIMEOUT_MS = "250";
  try {
    const writes = [];
    const http2 = createFakeHttp2([
      (stream) => {
        stream.emit("response", OK_RESPONSE);
        stream.emit("data", textFrame("正在分析"));
        const tick = setInterval(() => {
          if (stream.closed || stream.destroyed) {
            clearInterval(tick);
            return;
          }
          stream.emit("data", heartbeatDiagFrame());
        }, 60);
        setTimeout(() => {
          clearInterval(tick);
          stream.emit("data", textFrame(" 完成。"));
          stream.emit("data", completeTrailer());
          stream.emit("end");
        }, 700);
        const originalClose = stream.close;
        stream.close = (...args) => { clearInterval(tick); return originalClose?.(...args); };
      },
    ], writes);
    const chunks = await collect(createExecutor(http2));
    assert.equal(http2.attempts(), 1, "started text must not be progress-killed");
    const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
    assert.equal(text, "正在分析 完成。");
    assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "stop" } });
  } finally {
    delete process.env.DOCKYARD_CURSOR_IDLE_TIMEOUT_MS;
  }
});

test("executor retries transient stream errors (ETIMEDOUT) before any content is forwarded", async () => {
  const writes = [];
  const http2 = createFakeHttp2([
    (stream) => {
      stream.emit("response", OK_RESPONSE);
      stream.emit("error", Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" }));
    },
    (stream) => {
      stream.emit("response", OK_RESPONSE);
      stream.emit("data", textFrame("ok"));
      stream.emit("data", completeTrailer());
      stream.emit("end");
    },
  ], writes);
  const chunks = await collect(createExecutor(http2));
  assert.equal(http2.attempts(), 2, "transient stream error must be retried once");
  const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
  assert.equal(text, "ok");
  assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "stop" } });
});

test("executor regenerates once when a forwarded stream dies mid-turn (idle timeout)", async () => {
  process.env.DOCKYARD_CURSOR_IDLE_TIMEOUT_MS = "300";
  try {
    const writes = [];
    const http2 = createFakeHttp2([
      (stream) => {
        // 第一次：吐了一半内容后服务端停滞（15:20/16:17 两次事故的形态）
        stream.emit("response", OK_RESPONSE);
        stream.emit("data", textFrame("partial "));
        setTimeout(() => stream.emit("end"), 500);
      },
      (stream) => {
        // 第二次：换个健康实例，完整跑完
        stream.emit("response", OK_RESPONSE);
        stream.emit("data", textFrame("partial and full answer"));
        stream.emit("data", completeTrailer());
        stream.emit("end");
      },
    ], writes);
    const chunks = await collect(createExecutor(http2));
    assert.equal(http2.attempts(), 2, "mid-turn stall must get exactly one regeneration");
    const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
    assert.ok(text.includes("partial "), "forwarded partial text stays");
    assert.ok(text.includes("full answer"), "regenerated attempt completes the turn");
    assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "stop" } });
  } finally {
    delete process.env.DOCKYARD_CURSOR_IDLE_TIMEOUT_MS;
  }
});

test("executor surfaces the error after exhausting retries (no infinite loop)", async () => {
  const writes = [];
  const http2 = createFakeHttp2([
    (stream) => {
      stream.emit("response", OK_RESPONSE);
      stream.emit("data", TRUNCATE_LEFTOVER);
      stream.emit("end");
    },
  ], writes);
  const executor = createExecutor(http2);
  await assert.rejects(
    () => collect(executor),
    (error) => {
      // 每次都对半，3 次尝试用尽后把最后一个错误抛出去
      return error?.code === "CURSOR_TRUNCATE_REQUESTED" || error?.code === "CURSOR_INCOMPLETE_RESPONSE";
    },
  );
  assert.equal(http2.attempts(), 3);
});
