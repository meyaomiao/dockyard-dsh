import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import * as http2 from "node:http2";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  nativeProviderError,
  validateNativeEndpoint,
} from "../../../packages/providers/src/native-transport.mjs";
import {
  cursorNativeProtocolConstants,
  decodeCursorTruncateFlag,
  cursorTurnComplete,
  cursorFrameMetadata,
  decodeConnectFrames,
  decodeCursorConnectTrailer,
  decodeCursorKvRequest,
  decodeCursorText,
  encodeAgentRunRequest,
  encodeHeartbeat,
  encodeKvResponse,
} from "./native-protocol.mjs";

const PROVIDER_ID = "cursor";
const DEFAULT_ENDPOINT = cursorNativeProtocolConstants.endpoint;
const CURSOR_SESSION_KEYS = [
  "cursorAuth/accessToken",
  "cursorAuth/refreshToken",
  "cursorAuth/cachedEmail",
  "cursorAuth/stripeMembershipType",
];

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0) ?? null;
}

function createAsyncQueue() {
  const values = [];
  const waiters = [];
  let closed = false;
  let failure = null;
  return {
    push(value) {
      if (closed || failure) return;
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ value, done: false });
      else values.push(value);
    },
    close() {
      if (closed || failure) return;
      closed = true;
      while (waiters.length) waiters.shift().resolve({ value: undefined, done: true });
    },
    fail(error) {
      if (closed || failure) return;
      failure = error;
      while (waiters.length) waiters.shift().reject(error);
    },
    async next() {
      if (values.length) return { value: values.shift(), done: false };
      if (failure) throw failure;
      if (closed) return { value: undefined, done: true };
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    [Symbol.asyncIterator]() { return this; },
  };
}

/**
 * Read Cursor's official desktop OAuth session without starting cursor-agent.
 * The token is returned only to the provider module/native transport and is
 * never included in a public DSH snapshot.
 */
export function readCursorDesktopSession({
  credential,
  env = process.env,
  home = homedir(),
} = {}) {
  const stored = firstString(credential?.access, credential?.token);
  if (stored) {
    return {
      token: stored,
      refreshToken: firstString(credential?.refresh, credential?.refreshToken),
      expiresAt: firstString(credential?.expiresAt, credential?.expires_at),
      email: firstString(credential?.email),
      plan: firstString(credential?.plan),
      kind: "oauth",
      source: "dockyard_credential",
    };
  }
  const fromEnv = firstString(env.CURSOR_API_KEY, env.DOCKYARD_CURSOR_ACCESS_TOKEN);
  if (fromEnv) return { token: fromEnv, kind: "apiKey", source: "environment" };
  if (process.platform !== "darwin") return null;
  const dbPath = join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  try {
    const quotedKeys = CURSOR_SESSION_KEYS.map((key) => `'${key}'`).join(",");
    const output = execFileSync("sqlite3", ["-json", dbPath, `SELECT key, CAST(value AS TEXT) AS value FROM ItemTable WHERE key IN (${quotedKeys});`], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const rows = JSON.parse(output || "[]");
    const valueFor = (key) => rows.find((row) => row.key === key)?.value;
    const access = valueFor("cursorAuth/accessToken");
    return access ? {
      token: access,
      refreshToken: firstString(valueFor("cursorAuth/refreshToken")),
      email: firstString(valueFor("cursorAuth/cachedEmail")),
      plan: firstString(valueFor("cursorAuth/stripeMembershipType")),
      kind: "oauth",
      source: "cursor_desktop_app",
    } : null;
  } catch {
    return null;
  }
}

/** Resolve Cursor's access token without starting cursor-agent. */
export function resolveCursorAccessToken(options = {}) {
  const session = readCursorDesktopSession(options);
  return session
    ? { token: session.token, kind: session.kind, ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}) }
    : null;
}

function cursorHeaders(endpoint, token, requestId, env) {
  const clientVersion = env.DOCKYARD_CURSOR_CLIENT_VERSION
    ?? `cli-${new Date().toISOString().slice(0, 10).replace(/-/g, ".")}-agent-host`;
  const clientKey = randomBytes(32).toString("hex");
  return {
    ":method": "POST",
    ":path": `${endpoint.pathname}${endpoint.search}`,
    ":scheme": "https",
    ":authority": endpoint.host,
    authorization: `Bearer ${token}`,
    "content-type": "application/connect+proto",
    accept: "application/connect+proto",
    "connect-protocol-version": "1",
    "x-request-id": requestId,
    "x-cursor-client-version": clientVersion,
    "x-cursor-client-type": "cli",
    "x-cursor-client-key": clientKey,
    "x-cursor-streaming": "true",
  };
}


// [临时诊断] Cursor 流式黑匣子：记录每帧与终态，便于定位 premature EOF 类上游截断
const CURSOR_DEBUG_FILE = "/tmp/dockyard-cursor-debug.log";
let cursorDebugSeq = 0;
function cursorDebug(line) {
  try { appendFileSync(CURSOR_DEBUG_FILE, `${new Date().toISOString()} #${++cursorDebugSeq} ${line}\n`); } catch {}
}

function cursorStatusError(status) {
  return nativeProviderError(PROVIDER_ID, `Cursor AgentService returned HTTP ${status}`, { status });
}

function streamCursor({ endpoint, token, request, context, http2Module = http2 }) {
  return (async function* cursorStream() {
    const requestId = firstString(request.requestId, context.requestId, randomUUID());
    const conversationId = firstString(request.sessionId, context.sessionId, requestId);
    const model = firstString(request.model);
    if (!model) throw nativeProviderError(PROVIDER_ID, "Cursor model is missing");
    const timeZone = (() => {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
    })();
    const encoded = encodeAgentRunRequest({
      messages: request.messages,
      model,
      requestId,
      conversationId,
      // Cursor's AgentService uses its own native tool/exec protocol. Keep
      // this request on the text path until DSH's tool bridge answers those
      // bidirectional ExecServer messages; no CLI prompt is involved.
      tools: [],
      timeZone,
    });
    const url = new URL(endpoint);
    const sid = `S${Date.now().toString(36)}`;
    const tokenFP = createHash("sha256").update(String(token)).digest("hex").slice(0, 8);
    cursorDebug(`${sid} BEGIN model=${model} endpoint=${url.host} token=${tokenFP}`);
    const session = http2Module.connect(url.origin);
    const queue = createAsyncQueue();
    let stream = null;
    let responseStatus = 0;
    let responseBuffer = new Uint8Array();
    const responseDiagnostics = [];
    const protocolError = (message, code) => {
      const error = nativeProviderError(PROVIDER_ID, message, { code });
      if (responseDiagnostics.length > 0) error.cursorDiagnostics = responseDiagnostics.slice(0, 32);
      return error;
    };
    let completed = false;
    let truncated = null;
    // 服务端活跃时间：只有对端来的字节（响应头/数据帧）才算数。
    // 健康的 turn 每几秒就有帧流动；连续 IDLE_TIMEOUT_MS 一个字节都没有
    // 说明被服务端黑洞了，主动断掉交给 executor 重试，别让用户干等 4-9 分钟。
    let lastActivityAt = Date.now();
    const idleTimeoutMs = Number(process.env.DOCKYARD_CURSOR_IDLE_TIMEOUT_MS ?? 60_000);
    let cleaned = false;
    let heartbeat;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      context.signal?.removeEventListener?.("abort", onAbort);
      if (stream && !stream.destroyed && !stream.closed) stream.close();
      if (!session.closed && !session.destroyed) session.close();
    };
    const onAbort = () => {
      const error = nativeProviderError(PROVIDER_ID, "Cursor request aborted");
      error.code = "ABORT_ERR";
      queue.fail(error);
      stream?.close(http2Module.constants?.NGHTTP2_CANCEL);
      session.close();
    };
    const wrapTransportError = (error) => {
      // 保留原始 code（ETIMEDOUT/ECONNRESET/...），让 executor 重试判定和
      // harness 的失败分类都能认出来；原始错误挂在 cause 上不丢信息。
      const wrapped = nativeProviderError(PROVIDER_ID, error?.message ?? String(error), { code: error?.code });
      wrapped.cause = error;
      return wrapped;
    };
    session.once("error", (error) => { cursorDebug(`${sid} SESSION-ERROR ${error.message} code=${error.code ?? ""}`); queue.fail(wrapTransportError(error)); });
    try {
      stream = session.request(cursorHeaders(url, token, requestId, context.env ?? process.env));
      stream.once("response", (headers) => {
        responseStatus = Number(headers[":status"] ?? 0);
        lastActivityAt = Date.now();
        cursorDebug(`${sid} STATUS ${responseStatus} ct=${headers["content-type"] ?? "?"}`);
        if (responseStatus >= 400) queue.fail(cursorStatusError(responseStatus));
      });
      stream.on("data", (chunk) => {
        lastActivityAt = Date.now();
        const incoming = new Uint8Array(chunk);
        const merged = new Uint8Array(responseBuffer.byteLength + incoming.byteLength);
        merged.set(responseBuffer);
        merged.set(incoming, responseBuffer.byteLength);
        const decoded = decodeConnectFrames(merged);
        responseBuffer = decoded.rest;
        for (const frame of decoded.frames) {
          if (process.env.DOCKYARD_CURSOR_TRACE === "1") cursorDebug(`${sid} FRAME flags=${frame.flags} len=${frame.payload.length}`);
          if ((frame.flags & 0x02) !== 0) {
            const trailer = decodeCursorConnectTrailer(frame.payload);
            if (trailer) {
              cursorDebug(`${sid} TRAILER-ERROR code=${trailer.code} msg=${trailer.message}`);
              queue.fail(nativeProviderError(PROVIDER_ID, trailer.message, {
                code: trailer.code,
                body: { code: trailer.code, message: trailer.message },
              }));
            } else {
              completed = true;
              queue.push({ type: "complete" });
            }
            continue;
          }
          if ((frame.flags & 0x01) !== 0) {
            responseDiagnostics.push(cursorFrameMetadata(frame.payload, frame.flags));
            queue.fail(protocolError("Cursor returned a compressed protobuf frame", "CURSOR_COMPRESSED_RESPONSE"));
            continue;
          }
          if (truncated === null && frame.payload.length < 64 && decodeCursorTruncateFlag(frame.payload)) {
            truncated = true;
            cursorDebug(`${sid} TRUNCATE-FLAG received — server asks to shorten conversation`);
            continue;
          }
          const kv = decodeCursorKvRequest(frame.payload);
          if (kv) {
            try {
              stream?.write(Buffer.from(encodeKvResponse(kv, encoded.blobs)));
            } catch (error) {
              queue.fail(error);
            }
            continue;
          }
          const text = decodeCursorText(frame.payload);
          const turnComplete = cursorTurnComplete(frame.payload);
          if (text) queue.push({ type: "text", text });
          if (!text) responseDiagnostics.push(cursorFrameMetadata(frame.payload, frame.flags));
          if (turnComplete) {
            completed = true;
            queue.push({ type: "complete" });
          }
        }
      });
      stream.once("end", () => {
        // 服务端发完 truncate 标志会立刻关流，标志帧本身常被拦腰截断
        // （19B leftover：声明 15B payload、实际只有 14B），decodeConnectFrames
        // 永远不会把它当完整帧吐出来 —— 所以在 end 时对残包再识别一次。
        if (!completed && truncated === null && responseBuffer.byteLength > 0 && responseBuffer.byteLength < 128 && decodeCursorTruncateFlag(responseBuffer)) {
          truncated = true;
          cursorDebug(`${sid} TRUNCATE-FLAG leftover ${responseBuffer.byteLength}B — server asks to shorten conversation`);
        }
        if (truncated) {
          queue.fail(nativeProviderError(PROVIDER_ID, "Cursor requested conversation truncation", { code: "CURSOR_TRUNCATE_REQUESTED" }));
        }
        cursorDebug(`${sid} END completed=${completed} leftover=${responseBuffer.byteLength}B diag=${responseDiagnostics.length}${responseBuffer.byteLength > 0 ? ` leftoverHex=${Buffer.from(responseBuffer.slice(0, 64)).toString("hex")}` : ""}`);
        if (responseBuffer.byteLength > 0) {
          responseDiagnostics.push({
            payloadLength: responseBuffer.byteLength,
            incomplete: true,
          });
          queue.fail(protocolError("Cursor AgentService returned an incomplete Connect frame", "CURSOR_INCOMPLETE_RESPONSE"));
        } else {
          queue.close();
        }
      });
      stream.once("error", (error) => { cursorDebug(`${sid} STREAM-ERROR ${error.message} code=${error.code ?? ""}`); queue.fail(wrapTransportError(error)); });
      stream.write(Buffer.from(encoded.frame));
      const idleTickMs = Math.max(250, Math.min(5_000, Math.floor(idleTimeoutMs / 2)));
      heartbeat = setInterval(() => {
        if (completed) return;
        const idleForMs = Date.now() - lastActivityAt;
        if (idleForMs > idleTimeoutMs) {
          cursorDebug(`${sid} IDLE-TIMEOUT ${Math.round(idleForMs / 1000)}s without server bytes`);
          queue.fail(nativeProviderError(PROVIDER_ID, `Cursor connection idle for ${Math.round(idleForMs / 1000)}s`, { code: "CURSOR_IDLE_TIMEOUT" }));
          return;
        }
        if (!stream || stream.destroyed || stream.closed) return;
        try { stream.write(Buffer.from(encodeHeartbeat())); } catch { /* stream is closing */ }
      }, idleTickMs);
      context.signal?.addEventListener?.("abort", onAbort, { once: true });

      let text = "";
      let failed = false;
      yield { type: "block-start", index: 0, blockType: "text" };
      try {
        for await (const item of queue) {
          if (item.type === "text") {
            text += item.text;
            yield { type: "text-delta", index: 0, text: item.text };
          } else if (item.type === "complete") {
            completed = true;
            break;
          }
        }
      } catch (error) {
        failed = true;
        if (error?.status === 401 || error?.status === 403) error.authExpired = error.status === 401;
        throw error;
      } finally {
        cleanup();
      }
      if (!failed) {
        if (!completed) {
          throw protocolError("Cursor AgentService ended before completing the turn", "CURSOR_INCOMPLETE_RESPONSE");
        }
        if (text.trim().length === 0) {
          throw protocolError("Cursor AgentService completed without assistant text", "CURSOR_EMPTY_RESPONSE");
        }
        yield { type: "block-end", index: 0, block: { type: "text", text } };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    } catch (error) {
      cleanup();
      throw error;
    }
  })();
}

export function createCursorNativeExecutor({
  endpoint = process.env.DOCKYARD_CURSOR_ENDPOINT || DEFAULT_ENDPOINT,
  env = process.env,
  home = homedir(),
  tokenResolver = resolveCursorAccessToken,
  http2Module = http2,
} = {}) {
  const safeEndpoint = validateNativeEndpoint(endpoint, { providerId: PROVIDER_ID });
  // 上游偶发截断/断流。重试循环必须在 executor 里真正消费流：
  // streamCursor 是惰性 async generator，错误在消费阶段才抛，
  // 旧写法 return guard() 让外层 catch 永远接不到 → 重试是死代码。
  const RETRYABLE_CODES = new Set(["CURSOR_INCOMPLETE_RESPONSE", "UNKNOWN", "CURSOR_TRUNCATE_REQUESTED", "CURSOR_IDLE_TIMEOUT"]);
  const RETRYABLE_STREAM_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "EPIPE", "ERR_HTTP2_STREAM_CANCEL"]);
  const executor = async function* ({ request = {}, invocation, context = {} } = {}) {
    let credential = null;
    if (context.secretStore) {
      const ref = invocation?.auth?.credentialRef ?? invocation?.account?.auth?.credentialRef ?? invocation?.account?.credentialRef;
      if (ref) credential = await context.secretStore.read(ref);
    }
    const auth = await tokenResolver({ credential, env: { ...env, ...(context.env ?? {}) }, home });
    if (!auth?.token) {
      const error = nativeProviderError(PROVIDER_ID, "Cursor OAuth token is unavailable; authorize Cursor first");
      error.authExpired = true;
      throw error;
    }
    if (auth.expiresAt) {
      const expiry = Date.parse(auth.expiresAt);
      if (Number.isFinite(expiry) && expiry <= Date.now()) {
        const error = nativeProviderError(PROVIDER_ID, "Cursor OAuth access token expired; authorize Cursor again", {
          code: "CURSOR_TOKEN_EXPIRED",
        });
        error.authExpired = true;
        throw error;
      }
    }
    let lastError = null;
    let messages = request.messages;
    let retriedAfterForward = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // block-start 先扣住不下发：本次尝试若还没产出内容就失败，
      // 重试时直接丢弃，避免下游收到重复的 block-start。
      let pendingStart = null;
      let forwarded = false;
      try {
        for await (const chunk of streamCursor({ endpoint: safeEndpoint, token: auth.token, request: { ...request, messages }, context, http2Module })) {
          if (chunk?.type === "block-start" && !forwarded) {
            pendingStart = chunk;
            continue;
          }
          forwarded = true;
          if (pendingStart) {
            yield pendingStart;
            pendingStart = null;
          }
          yield chunk;
        }
        return;
      } catch (error) {
        lastError = error;
        if (error?.status === 401 || error?.status === 403) error.authExpired = error.status === 401;
        const code = error?.code ?? "";
        const retriable = (RETRYABLE_CODES.has(code) || RETRYABLE_STREAM_CODES.has(code)) && !(error?.status >= 400);
        // 服务端要求截断：把历史对半减掉再重试
        if (code === "CURSOR_TRUNCATE_REQUESTED" && !forwarded && Array.isArray(messages) && messages.length > 1) {
          messages = messages.slice(Math.ceil(messages.length / 2));
          continue;
        }
        if (retriable && !forwarded) continue;
        // 已转发过内容后撞上瞬断（idle/断流/空收尾）：线上实测同一内容换个
        // 后端实例几秒就能跑完（2026-08-28 15:20/16:17 两次事故），允许重新
        // 生成一次——重复半句话好过整轮报废。只放宽这一次，防止循环复读。
        if (retriable && forwarded && !retriedAfterForward) {
          retriedAfterForward = true;
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  };

  executor.nativeTransport = "cursor-connect-agent-service";
  return executor;
}

export const cursorNativeTransportConstants = Object.freeze({
  providerId: PROVIDER_ID,
  endpoint: DEFAULT_ENDPOINT,
});
