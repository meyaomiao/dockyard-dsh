import test from "node:test";
import assert from "node:assert/strict";

import {
  RECENT_LIMIT,
  TokenUsageLedger,
  applyUsage,
  dayKey,
  emptyUsageEntry,
  reviveUsageEntry,
  sumUsageEntries,
} from "../packages/dsh-plugin/src/token-usage-ledger.mjs";

test("applyUsage accumulates tokens, daily buckets, and recent rows", () => {
  let entry = emptyUsageEntry();
  const at = "2026-08-23T10:00:00.000Z";
  entry = applyUsage(entry, {
    at,
    status: "success",
    model: "deepseek-chat",
    usage: { inputTokens: 100, outputTokens: 30, cacheReadTokens: 20, reasoningTokens: 12 },
  }, () => new Date(at));
  entry = applyUsage(entry, {
    at: "2026-08-23T11:00:00.000Z",
    status: "failure",
    model: "deepseek-reasoner",
    usage: null,
  }, () => new Date("2026-08-23T11:00:00.000Z"));

  assert.equal(entry.requests, 2);
  assert.equal(entry.ok, 1);
  assert.equal(entry.errors, 1);
  assert.equal(entry.inputTokens, 100);
  assert.equal(entry.outputTokens, 30);
  assert.equal(entry.cacheReadTokens, 20);
  // Provider total absent -> billed total excludes reasoning tokens.
  assert.equal(entry.totalTokens, 150);
  assert.equal(entry.lastModel, "deepseek-reasoner");
  assert.equal(entry.lastStatus, "failure");

  const day = entry.days[dayKey(new Date(at))];
  assert.equal(day.requests, 2);
  assert.equal(day.errors, 1);
  assert.equal(day.inputTokens, 100);
  assert.equal(entry.recent.length, 2);
  assert.equal(entry.recent.at(-1).status, "failure");
});

test("recent list is capped and revive drops malformed fields", () => {
  let entry = emptyUsageEntry();
  for (let index = 0; index < RECENT_LIMIT + 10; index += 1) {
    entry = applyUsage(entry, { usage: { inputTokens: 1 } });
  }
  assert.equal(entry.requests, RECENT_LIMIT + 10);
  assert.equal(entry.recent.length, RECENT_LIMIT);

  const revived = reviveUsageEntry({
    ...entry,
    requests: "not-a-number",
    inputTokens: -5,
    recent: [{ at: "2026-08-23T00:00:00.000Z" }, null, "junk"],
    days: { "1999-01-01": { requests: 9 }, "2099-01-01": { requests: 3 } },
  });
  assert.equal(revived.requests, 0);
  assert.equal(revived.inputTokens, 0);
  assert.equal(revived.recent.length, 1);
  // Days older than the retention window are pruned on load.
  assert.deepEqual(Object.keys(revived.days), ["2099-01-01"]);
});

test("sumUsageEntries aggregates provider totals", () => {
  const total = sumUsageEntries([
    { requests: 2, ok: 1, errors: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15, firstUsedAt: "2026-08-20T00:00:00Z", lastUsedAt: "2026-08-21T00:00:00Z" },
    { requests: 3, ok: 3, errors: 0, inputTokens: 7, outputTokens: 2, totalTokens: 9, firstUsedAt: "2026-08-19T00:00:00Z", lastUsedAt: "2026-08-25T00:00:00Z" },
  ]);
  assert.equal(total.requests, 5);
  assert.equal(total.inputTokens, 17);
  assert.equal(total.totalTokens, 24);
  assert.equal(total.firstUsedAt, "2026-08-19T00:00:00Z");
  assert.equal(total.lastUsedAt, "2026-08-25T00:00:00Z");
});


test("day buckets roll over at 08:00 local, not midnight", () => {
  // 07:59 属于前一个统计日，08:00 起才是新统计日
  assert.equal(dayKey(new Date(2026, 7, 25, 7, 59, 59)), "2026-08-24");
  assert.equal(dayKey(new Date(2026, 7, 25, 8, 0, 0)), "2026-08-25");
  assert.equal(dayKey("2026-08-25T23:59:59"), "2026-08-25");
  // 凌晨 00:30 记入前一天
  assert.equal(dayKey(new Date(2026, 7, 26, 0, 30, 0)), "2026-08-25");

  let entry = emptyUsageEntry();
  entry = applyUsage(entry, { at: "2026-08-25T23:30:00.000", usage: { inputTokens: 10 } });
  entry = applyUsage(entry, { at: "2026-08-26T06:30:00.000", usage: { inputTokens: 5 } });
  entry = applyUsage(entry, { at: "2026-08-26T08:01:00.000", usage: { inputTokens: 100 } });
  const dayA = entry.days["2026-08-25"];
  const dayB = entry.days["2026-08-26"];
  assert.equal(dayA.requests, 2);   // 23:30 + 次日 06:30 同属统计日 08-25
  assert.equal(dayA.inputTokens, 15);
  assert.equal(dayB.requests, 1);   // 08:01 起才算新统计日
  assert.equal(dayB.inputTokens, 100);
});

test("ledger records, snapshots, resets, and persists across reloads", async () => {
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
  const logger = { warn() {}, error() {} };
  const ledger = new TokenUsageLedger({ stateStore, logger });
  await ledger.load();

  ledger.record("deepseek", "KEY_A", { status: "success", usage: { inputTokens: 10, outputTokens: 4 }, model: "m" });
  ledger.record("deepseek", "KEY_B", { status: "failure", usage: null, model: "m" });
  ledger.record("claude", "account-1", { status: "success", usage: { inputTokens: 1 } });

  const snapshot = ledger.snapshot("deepseek");
  assert.equal(snapshot.subjects.KEY_A.requests, 1);
  assert.equal(snapshot.subjects.KEY_A.outputTokens, 4);
  assert.equal(snapshot.totals.requests, 2);

  // A broken sink-like record call must not corrupt state or throw.
  ledger.record(null, undefined, {});
  ledger.record("", "", {});

  assert.deepEqual(ledger.reset("deepseek", "KEY_A"), { providers: 0, subjects: 1 });
  assert.equal(ledger.entryFor("deepseek", "KEY_A"), null);
  assert.equal(ledger.entryFor("deepseek", "KEY_B").requests, 1);
  assert.deepEqual(ledger.reset("deepseek"), { providers: 1, subjects: 1 });
  assert.equal(ledger.snapshot("deepseek").subjects.KEY_B, undefined);

  await ledger.flush();

  const reloaded = new TokenUsageLedger({ stateStore, logger });
  await reloaded.load();
  assert.equal(reloaded.entryFor("deepseek", "KEY_A"), null);
});
