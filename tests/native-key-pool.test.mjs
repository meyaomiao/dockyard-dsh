import test from "node:test";
import assert from "node:assert/strict";

import { NativeKeyPoolHost } from "../packages/dsh-plugin/src/native-key-pool-host.mjs";
import { TokenUsageLedger } from "../packages/dsh-plugin/src/token-usage-ledger.mjs";

function createMemoryHost({ providerId, profile, adapterConfig, values }) {
  const listeners = new Map();
  const llm = {
    adapters: new Map([[providerId, { adapter: { config: adapterConfig } }]]),
    listConfigurableProviders: () => [{
      provider: providerId,
      settingsNs: "llm-pi-ai",
      settingsPath: ["providers", providerId],
    }],
  };
  const settings = {
    get: () => ({ providers: { [providerId]: profile } }),
  };
  const credentials = {
    async describe(ref) {
      return {
        configured: values.has(ref),
        source: "test",
        writable: true,
      };
    },
    async resolve(ref) {
      return values.has(ref) ? { value: values.get(ref) } : undefined;
    },
  };
  const stateStore = {
    state: {},
    async load() {
      return this.state;
    },
    async save(next) {
      this.state = { ...this.state, ...next };
      return this.state;
    },
  };
  const ctx = {
    llm,
    settings,
    credentials,
    get(name) {
      return this[name];
    },
    on(name, callback) {
      listeners.set(name, callback);
      return () => listeners.delete(name);
    },
    logger: () => ({ warn() {}, error() {} }),
  };
  return { ctx, llm, credentials, stateStore, listeners };
}

test("native API-key pool rotates pi-ai credentials at request resolution", async () => {
  const values = new Map([
    ["DEEPSEEK_KEY_A", "secret-a"],
    ["DEEPSEEK_KEY_B", "secret-b"],
  ]);
  const calls = [];
  const adapterConfig = {
    async resolveApiKey(provider, profile) {
      calls.push([provider, profile.apiKeyEnv]);
      return values.get(profile.apiKeyEnv);
    },
  };
  const { ctx, llm, stateStore } = createMemoryHost({
    providerId: "deepseek",
    profile: { apiKeyEnv: "DEEPSEEK_KEY_A" },
    adapterConfig,
    values,
  });
  const host = new NativeKeyPoolHost(ctx, { stateStore });
  await host.start();
  await host.register("deepseek", "DEEPSEEK_KEY_B", "备用 Key");
  await host.setPolicy("deepseek", "round_robin");

  const wrapped = llm.adapters.get("deepseek").adapter.config.resolveApiKey;
  assert.equal(await wrapped("deepseek", { apiKeyEnv: "DEEPSEEK_KEY_A" }), "secret-a");
  assert.equal(await wrapped("deepseek", { apiKeyEnv: "DEEPSEEK_KEY_A" }), "secret-b");
  assert.equal(await wrapped("deepseek", { apiKeyEnv: "DEEPSEEK_KEY_A" }), "secret-a");
  assert.deepEqual(calls, []);

  const status = await host.status("deepseek");
  assert.equal(status.runtimeMode, "request-key-pool");
  assert.equal(status.policy, "round_robin");
  assert.deepEqual(status.keys.map((entry) => entry.ref), ["DEEPSEEK_KEY_A", "DEEPSEEK_KEY_B"]);
  assert.equal(stateStore.state.nativeKeyPools.deepseek.keys.length, 2);
  host.dispose();
});

test("native API-key pool does not crash when an optional host seam is absent", async () => {
  const ctx = {
    get() { return undefined; },
    logger: () => ({ warn() {}, error() {} }),
  };
  const stateStore = {
    async load() { return {}; },
    async save(value) { return value; },
  };
  const host = new NativeKeyPoolHost(ctx, { stateStore });
  await host.start();
  assert.equal((await host.status("deepseek")).keys.length, 0);
  host.dispose();
});

test("native API-key pool preserves the direct DeepSeek connection resolver", async () => {
  const values = new Map([
    ["DEEPSEEK_KEY_A", "secret-a"],
    ["DEEPSEEK_KEY_B", "secret-b"],
  ]);
  const calls = [];
  const adapterConfig = {
    options: () => ({ apiKeyEnv: "DEEPSEEK_KEY_A" }),
    resolveUserId: () => "test-user",
    async resolveApiKey(connection) {
      calls.push(connection.apiKeyEnv);
      return values.get(connection.apiKeyEnv);
    },
  };
  const { ctx, llm, stateStore } = createMemoryHost({
    providerId: "deepseek-official",
    profile: { apiKeyEnv: "DEEPSEEK_KEY_A" },
    adapterConfig,
    values,
  });
  const host = new NativeKeyPoolHost(ctx, { stateStore });
  await host.start();
  await host.register("deepseek-official", "DEEPSEEK_KEY_B", "备用 Key");
  await host.setPolicy("deepseek-official", "round_robin");

  const wrapped = llm.adapters.get("deepseek-official").adapter.config.resolveApiKey;
  assert.equal(await wrapped({ apiKeyEnv: "DEEPSEEK_KEY_A" }), "secret-a");
  assert.equal(await wrapped({ apiKeyEnv: "DEEPSEEK_KEY_A" }), "secret-b");
  assert.deepEqual(calls, []);
  host.dispose();
});

test("failover keeps the primary Key for healthy requests", async () => {
  const values = new Map([
    ["DEEPSEEK_KEY_A", "secret-a"],
    ["DEEPSEEK_KEY_B", "secret-b"],
  ]);
  const { ctx, llm, stateStore } = createMemoryHost({
    providerId: "deepseek-official",
    profile: { apiKeyEnv: "DEEPSEEK_KEY_A" },
    adapterConfig: {
      options: () => ({ apiKeyEnv: "DEEPSEEK_KEY_A" }),
      resolveUserId: () => "test-user",
      async resolveApiKey(connection) {
        return values.get(connection.apiKeyEnv);
      },
    },
    values,
  });
  const host = new NativeKeyPoolHost(ctx, { stateStore });
  await host.start();
  await host.register("deepseek-official", "DEEPSEEK_KEY_B", "备用 Key");
  await host.setPolicy("deepseek-official", "failover");

  const wrapped = llm.adapters.get("deepseek-official").adapter.config.resolveApiKey;
  // Failover must pin healthy requests to the primary Key instead of rotating
  // through the pool on every call (round_robin behaviour).
  assert.equal(await wrapped({ apiKeyEnv: "DEEPSEEK_KEY_A" }), "secret-a");
  assert.equal(await wrapped({ apiKeyEnv: "DEEPSEEK_KEY_A" }), "secret-a");
  assert.equal(await wrapped({ apiKeyEnv: "DEEPSEEK_KEY_A" }), "secret-a");
  host.dispose();
});

test("failover retries a retryable stream exception before visible output", async () => {
  const values = new Map([
    ["DEEPSEEK_KEY_A", "secret-a"],
    ["DEEPSEEK_KEY_B", "secret-b"],
  ]);
  const { ctx, stateStore } = createMemoryHost({
    providerId: "deepseek",
    profile: { apiKeyEnv: "DEEPSEEK_KEY_A" },
    adapterConfig: { async resolveApiKey(_provider, profile) { return values.get(profile.apiKeyEnv); } },
    values,
  });
  const host = new NativeKeyPoolHost(ctx, { stateStore });
  await host.start();
  await host.register("deepseek", "DEEPSEEK_KEY_B", "备用 Key");
  await host.setPolicy("deepseek", "failover");

  let calls = 0;
  const chunks = [];
  for await (const chunk of host.stream({ provider: "deepseek" }, () => (async function* () {
    calls += 1;
    if (calls === 1) {
      const error = new Error("quota exhausted");
      error.rateLimited = true;
      throw error;
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "ok" };
    yield { type: "finish", reason: { kind: "stop" } };
  })())) chunks.push(chunk);

  assert.equal(calls, 2);
  assert.equal(chunks.find((chunk) => chunk.type === "text-delta")?.text, "ok");
  host.dispose();
});

test("failover drops a failed partial stream before trying the next Key", async () => {
  const values = new Map([
    ["DEEPSEEK_KEY_A", "secret-a"],
    ["DEEPSEEK_KEY_B", "secret-b"],
  ]);
  const { ctx, stateStore } = createMemoryHost({
    providerId: "deepseek",
    profile: { apiKeyEnv: "DEEPSEEK_KEY_A" },
    adapterConfig: {
      async resolveApiKey(_provider, profile) {
        return values.get(profile.apiKeyEnv);
      },
    },
    values,
  });
  const host = new NativeKeyPoolHost(ctx, { stateStore });
  await host.start();
  await host.register("deepseek", "DEEPSEEK_KEY_B", "备用 Key");
  await host.setPolicy("deepseek", "failover");

  let calls = 0;
  const chunks = [];
  for await (const chunk of host.stream({ provider: "deepseek" }, () => (async function* () {
    calls += 1;
    if (calls === 1) {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "finish", reason: { kind: "error" } };
      return;
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "ok" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "ok" } };
    yield { type: "finish", reason: { kind: "stop" } };
  })())) chunks.push(chunk);

  assert.equal(calls, 2);
  assert.equal(chunks.some((chunk) => chunk.reason?.kind === "error"), false);
  assert.equal(chunks.find((chunk) => chunk.type === "text-delta")?.text, "ok");
  host.dispose();
});

test("failover leaves shared upstream rate limits to the DSH retry policy", async () => {
  const values = new Map([
    ["OPENROUTER_KEY_A", "secret-a"],
    ["OPENROUTER_KEY_B", "secret-b"],
  ]);
  const { ctx, llm, stateStore } = createMemoryHost({
    providerId: "openrouter",
    profile: { apiKeyEnv: "OPENROUTER_KEY_A" },
    adapterConfig: { async resolveApiKey(_provider, profile) { return values.get(profile.apiKeyEnv); } },
    values,
  });
  const { ledger } = memoryLedger();
  await ledger.load();
  const host = new NativeKeyPoolHost(ctx, { stateStore, usageLedger: ledger });
  await host.start();
  await host.register("openrouter", "OPENROUTER_KEY_B", "备用 Key");
  await host.setPolicy("openrouter", "failover");

  let calls = 0;
  const chunks = [];
  for await (const chunk of host.stream({ provider: "openrouter", model: "stealth/ox-alpha" }, () => (async function* () {
    calls += 1;
    const wrapped = llm.adapters.get("openrouter").adapter.config.resolveApiKey;
    void (await wrapped("openrouter", { apiKeyEnv: "OPENROUTER_KEY_A" }));
    yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
    yield {
      type: "finish",
      reason: {
        kind: "error",
        failure: {
          code: "RATE_LIMIT",
          message: "429: upstream_provider_shared_pool is temporarily rate-limited upstream",
        },
      },
    };
  })())) chunks.push(chunk);

  assert.equal(calls, 1);
  assert.equal(chunks.at(-1)?.reason?.kind, "error");
  assert.equal(host.usageSnapshot("openrouter").subjects.OPENROUTER_KEY_A.errors, 1);
  assert.equal(host.usageSnapshot("openrouter").subjects.OPENROUTER_KEY_B, undefined);
  host.dispose();
});

test("failover clears excluded Keys after every exhausted request", async () => {
  const values = new Map([
    ["DEEPSEEK_KEY_A", "secret-a"],
    ["DEEPSEEK_KEY_B", "secret-b"],
  ]);
  const resolved = [];
  const { ctx, llm, stateStore } = createMemoryHost({
    providerId: "deepseek",
    profile: { apiKeyEnv: "DEEPSEEK_KEY_A" },
    adapterConfig: { async resolveApiKey(_provider, profile) { return values.get(profile.apiKeyEnv); } },
    values,
  });
  const host = new NativeKeyPoolHost(ctx, { stateStore });
  await host.start();
  await host.register("deepseek", "DEEPSEEK_KEY_B", "备用 Key");
  await host.setPolicy("deepseek", "failover");

  await assert.rejects(async () => {
    for await (const _chunk of host.stream({ provider: "deepseek" }, () => (async function* () {
      const wrapped = llm.adapters.get("deepseek").adapter.config.resolveApiKey;
      resolved.push(await wrapped("deepseek", { apiKeyEnv: "DEEPSEEK_KEY_A" }));
      const error = new Error("quota exhausted");
      error.rateLimited = true;
      throw error;
    })())) {}
  }, /quota exhausted/);

  for await (const _chunk of host.stream({ provider: "deepseek" }, () => (async function* () {
    const wrapped = llm.adapters.get("deepseek").adapter.config.resolveApiKey;
    resolved.push(await wrapped("deepseek", { apiKeyEnv: "DEEPSEEK_KEY_A" }));
    yield { type: "text-delta", index: 0, text: "ok" };
    yield { type: "finish", reason: { kind: "stop" } };
  })())) {}

  assert.deepEqual(resolved, ["secret-a", "secret-b", "secret-a"]);
  host.dispose();
});

function memoryLedger() {
  const stateStore = {
    state: {},
    async load() {
      return this.state;
    },
    async save(next) {
      this.state = { ...this.state, ...next };
      return this.state;
    },
  };
  const ledger = new TokenUsageLedger({ stateStore, logger: { warn() {}, error() {} } });
  return { ledger, stateStore };
}

test("round-robin usage is attributed per key and survives a ledger reload", async () => {
  const values = new Map([
    ["DEEPSEEK_KEY_A", "secret-a"],
    ["DEEPSEEK_KEY_B", "secret-b"],
  ]);
  const { ctx, llm, stateStore } = createMemoryHost({
    providerId: "deepseek",
    profile: { apiKeyEnv: "DEEPSEEK_KEY_A" },
    adapterConfig: { async resolveApiKey(_provider, profile) { return values.get(profile.apiKeyEnv); } },
    values,
  });
  const { ledger, stateStore: ledgerStore } = memoryLedger();
  await ledger.load();
  const host = new NativeKeyPoolHost(ctx, { stateStore, usageLedger: ledger });
  await host.start();
  await host.register("deepseek", "DEEPSEEK_KEY_B", "备用 Key");
  await host.setPolicy("deepseek", "round_robin");

  // Mimic the pi-ai adapter: resolveApiKey runs inside the stream pull chain.
  const makeNext = () => (async function* () {
    const wrapped = llm.adapters.get("deepseek").adapter.config.resolveApiKey;
    void (await wrapped("deepseek", { apiKeyEnv: "DEEPSEEK_KEY_A" }));
    yield { type: "usage", usage: { inputTokens: 100, outputTokens: 10 } };
    yield { type: "finish", reason: { kind: "stop" } };
  })();

  for await (const _chunk of host.stream({ provider: "deepseek", model: "deepseek-chat" }, makeNext)) {}
  for await (const _chunk of host.stream({ provider: "deepseek", model: "deepseek-chat" }, makeNext)) {}

  const snapshot = host.usageSnapshot("deepseek");
  assert.equal(snapshot.subjects.DEEPSEEK_KEY_A.requests, 1);
  assert.equal(snapshot.subjects.DEEPSEEK_KEY_A.inputTokens, 100);
  assert.equal(snapshot.subjects.DEEPSEEK_KEY_B.requests, 1);
  assert.equal(snapshot.totals.requests, 2);
  assert.equal(snapshot.totals.outputTokens, 20);
  assert.equal(snapshot.subjects.DEEPSEEK_KEY_A.recent.length, 1);
  assert.ok(snapshot.subjects.DEEPSEEK_KEY_A.days);

  // Status rows carry the per-key usage payload for the composer UI.
  const status = await host.status("deepseek");
  assert.equal(status.keys.find((entry) => entry.ref === "DEEPSEEK_KEY_B").tokenUsage.requests, 1);
  assert.equal(status.tokenTotals.requests, 2);

  // Persistence: a fresh ledger over the same store sees the same history.
  await ledger.flush();
  const reloaded = new TokenUsageLedger({ stateStore: ledgerStore, logger: { warn() {}, error() {} } });
  await reloaded.load();
  assert.equal(reloaded.entryFor("deepseek", "DEEPSEEK_KEY_A").requests, 1);

  // Reset one key only; the other keeps its records.
  await host.resetUsage("deepseek", "DEEPSEEK_KEY_A");
  const afterReset = await host.status("deepseek");
  assert.equal(afterReset.keys.find((entry) => entry.ref === "DEEPSEEK_KEY_A").tokenUsage, null);
  assert.equal(afterReset.keys.find((entry) => entry.ref === "DEEPSEEK_KEY_B").tokenUsage.requests, 1);
  host.dispose();
});

test("manual policy attributes usage to the active DSH key", async () => {
  const values = new Map([["DEEPSEEK_KEY_A", "secret-a"]]);
  const { ctx, llm } = createMemoryHost({
    providerId: "deepseek",
    profile: { apiKeyEnv: "DEEPSEEK_KEY_A" },
    adapterConfig: { async resolveApiKey(_provider, profile) { return values.get(profile.apiKeyEnv); } },
    values,
  });
  const { ledger } = memoryLedger();
  await ledger.load();
  const host = new NativeKeyPoolHost(ctx, { stateStore: { async load() { return {}; }, async save(value) { return value; } }, usageLedger: ledger });
  await host.start();

  const next = () => (async function* () {
    const wrapped = llm.adapters.get("deepseek").adapter.config.resolveApiKey;
    void (await wrapped("deepseek", { apiKeyEnv: "DEEPSEEK_KEY_A" }));
    yield { type: "usage", usage: { inputTokens: 7, outputTokens: 3 } };
    yield { type: "finish", reason: { kind: "stop" } };
  })();
  const chunks = [];
  for await (const chunk of host.stream({ provider: "deepseek", model: "deepseek-chat" }, next)) chunks.push(chunk);
  assert.equal(chunks.length, 2);

  const snapshot = host.usageSnapshot("deepseek");
  assert.equal(snapshot.subjects.DEEPSEEK_KEY_A.requests, 1);
  assert.equal(snapshot.subjects.DEEPSEEK_KEY_A.ok, 1);
  host.dispose();
});

test("failover records the failed attempt and the successful retry on separate keys", async () => {
  const values = new Map([
    ["DEEPSEEK_KEY_A", "secret-a"],
    ["DEEPSEEK_KEY_B", "secret-b"],
  ]);
  const { ctx, llm, stateStore } = createMemoryHost({
    providerId: "deepseek",
    profile: { apiKeyEnv: "DEEPSEEK_KEY_A" },
    adapterConfig: { async resolveApiKey(_provider, profile) { return values.get(profile.apiKeyEnv); } },
    values,
  });
  const { ledger } = memoryLedger();
  await ledger.load();
  const host = new NativeKeyPoolHost(ctx, { stateStore, usageLedger: ledger });
  await host.start();
  await host.register("deepseek", "DEEPSEEK_KEY_B", "备用 Key");
  await host.setPolicy("deepseek", "failover");

  let calls = 0;
  const next = () => (async function* () {
    calls += 1;
    const wrapped = llm.adapters.get("deepseek").adapter.config.resolveApiKey;
    void (await wrapped("deepseek", { apiKeyEnv: "DEEPSEEK_KEY_A" }));
    if (calls === 1) {
      yield { type: "usage", usage: { inputTokens: 50, outputTokens: 5 } };
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "finish", reason: { kind: "error" } };
      return;
    }
    yield { type: "usage", usage: { inputTokens: 70, outputTokens: 7 } };
    yield { type: "text-delta", index: 0, text: "ok" };
    yield { type: "finish", reason: { kind: "stop" } };
  })();

  const chunks = [];
  for await (const chunk of host.stream({ provider: "deepseek", model: "deepseek-chat" }, next)) chunks.push(chunk);
  assert.equal(calls, 2);
  assert.equal(chunks.some((chunk) => chunk.reason?.kind === "error"), false);

  const snapshot = host.usageSnapshot("deepseek");
  assert.equal(snapshot.subjects.DEEPSEEK_KEY_A.requests, 1);
  assert.equal(snapshot.subjects.DEEPSEEK_KEY_A.errors, 1);
  assert.equal(snapshot.subjects.DEEPSEEK_KEY_A.inputTokens, 50);
  assert.equal(snapshot.subjects.DEEPSEEK_KEY_B.requests, 1);
  assert.equal(snapshot.subjects.DEEPSEEK_KEY_B.ok, 1);
  assert.equal(snapshot.subjects.DEEPSEEK_KEY_B.inputTokens, 70);
  host.dispose();
});

test("round-robin walks to the next key inside one request on transient failure", async () => {
  const values = new Map([
    ["DEEPSEEK_KEY_A", "secret-a"],
    ["DEEPSEEK_KEY_B", "secret-b"],
  ]);
  const { ctx, llm, stateStore } = createMemoryHost({
    providerId: "deepseek",
    profile: { apiKeyEnv: "DEEPSEEK_KEY_A" },
    adapterConfig: { async resolveApiKey(_provider, profile) { return values.get(profile.apiKeyEnv); } },
    values,
  });
  const { ledger } = memoryLedger();
  await ledger.load();
  const host = new NativeKeyPoolHost(ctx, { stateStore, usageLedger: ledger });
  await host.start();
  await host.register("deepseek", "DEEPSEEK_KEY_B", "备用 Key");
  await host.setPolicy("deepseek", "round_robin");

  let calls = 0;
  const usedKeys = [];
  const next = () => (async function* () {
    calls += 1;
    const wrapped = llm.adapters.get("deepseek").adapter.config.resolveApiKey;
    usedKeys.push(await wrapped("deepseek", { apiKeyEnv: "DEEPSEEK_KEY_A" }));
    if (calls === 1) {
      const error = new Error("429 rate limited");
      error.rateLimited = true;
      throw error;
    }
    yield { type: "text-delta", index: 0, text: "ok" };
    yield { type: "finish", reason: { kind: "stop" } };
  })();

  const chunks = [];
  for await (const chunk of host.stream({ provider: "deepseek", model: "m" }, next)) chunks.push(chunk);

  // 轮询起点 A 失败后，同一请求内顺延到 B 成功
  assert.deepEqual(usedKeys, ["secret-a", "secret-b"]);
  assert.equal(chunks.find((chunk) => chunk.type === "text-delta")?.text, "ok");
  const snapshot = host.usageSnapshot("deepseek");
  assert.equal(snapshot.subjects.DEEPSEEK_KEY_A.requests, 1);
  assert.equal(snapshot.subjects.DEEPSEEK_KEY_A.errors, 1);
  assert.equal(snapshot.subjects.DEEPSEEK_KEY_B.ok, 1);
  host.dispose();
});

test("round-robin does not walk keys on upstream shared-pool limits", async () => {
  const values = new Map([
    ["DEEPSEEK_KEY_A", "secret-a"],
    ["DEEPSEEK_KEY_B", "secret-b"],
  ]);
  const { ctx, llm, stateStore } = createMemoryHost({
    providerId: "deepseek",
    profile: { apiKeyEnv: "DEEPSEEK_KEY_A" },
    adapterConfig: { async resolveApiKey(_provider, profile) { return values.get(profile.apiKeyEnv); } },
    values,
  });
  const { ledger } = memoryLedger();
  await ledger.load();
  const host = new NativeKeyPoolHost(ctx, { stateStore, usageLedger: ledger });
  await host.start();
  await host.register("deepseek", "DEEPSEEK_KEY_B", "备用 Key");
  await host.setPolicy("deepseek", "round_robin");

  let calls = 0;
  const next = () => (async function* () {
    calls += 1;
    const wrapped = llm.adapters.get("deepseek").adapter.config.resolveApiKey;
    void (await wrapped("deepseek", { apiKeyEnv: "DEEPSEEK_KEY_A" }));
    yield { type: "finish", reason: { kind: "error", failure: { message: "429 upstream_provider_shared_pool is temporarily rate-limited upstream" } } };
  })();

  const chunks = [];
  for await (const chunk of host.stream({ provider: "deepseek", model: "m" }, next)) chunks.push(chunk);

  // 共享池限流：只尝试当前 key 一次，不烧其余 key
  assert.equal(calls, 1);
  assert.equal(chunks.some((chunk) => chunk.reason?.kind === "error"), true);
  const snapshot = host.usageSnapshot("deepseek");
  assert.equal(snapshot.subjects.DEEPSEEK_KEY_A.requests, 1);
  assert.equal(snapshot.subjects.DEEPSEEK_KEY_A.errors, 1);
  assert.equal(snapshot.subjects.DEEPSEEK_KEY_B, undefined);
  host.dispose();
});
