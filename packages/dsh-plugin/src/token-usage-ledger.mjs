/**
 * Per-credential token usage ledger for Dockyard DSH.
 *
 * Every credential of every provider — a native API-key ref or an OAuth
 * accountId — gets its own cumulative counters, per-day buckets, and a capped
 * list of recent requests. The ledger is host-side only: it never sees key
 * material, only opaque refs/account ids, and it degrades to in-memory state
 * when persistence fails.
 */
import { JsonStateStore, defaultDockyardHome } from "../../runtime/src/state-store.mjs";
import { join } from "node:path";

export const RECENT_LIMIT = 50;
export const DAY_RETENTION_DAYS = 90;
/**
 * 统计日切点：每天本地时间 08:00 重置。00:00–07:59 的请求记入前一天的日桶，
 * 即「统计日 D」= D 日 08:00 至 D+1 日 07:59。客户端 UI 的"今日"取值必须
 * 使用同一偏移（见 dockyard-client.mjs 的 usageDayKey）。
 */
export const DAY_RESET_HOUR = 8;
const SAVE_DEBOUNCE_MS = 750;

const TOKEN_FIELDS = Object.freeze([
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
]);

function nonNegativeInteger(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isoNow(clock) {
  try {
    return (clock ?? new Date)().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/** Billing-style day bucket: the calendar date of (timestamp − DAY_RESET_HOUR). */
export function dayKey(date) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return null;
  const shifted = new Date(value.getTime() - DAY_RESET_HOUR * 60 * 60 * 1000);
  const year = shifted.getFullYear();
  const month = String(shifted.getMonth() + 1).padStart(2, "0");
  const day = String(shifted.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function emptyUsageEntry() {
  return {
    requests: 0,
    ok: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    firstUsedAt: null,
    lastUsedAt: null,
    lastModel: null,
    lastStatus: null,
    days: {},
    recent: [],
  };
}

function emptyDayBucket() {
  return {
    requests: 0,
    ok: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

function pruneDays(days, nowMs = Date.now()) {
  if (!days || typeof days !== "object") return {};
  const cutoff = nowMs - DAY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const kept = {};
  for (const [key, bucket] of Object.entries(days)) {
    const parsed = new Date(`${key}T00:00:00`);
    if (!Number.isNaN(parsed.getTime()) && parsed.getTime() < cutoff) continue;
    kept[key] = bucket;
  }
  return kept;
}

/**
 * Merge one request outcome into an existing entry. Pure: returns the next
 * entry and does not mutate the input. `info` accepts `{ usage, status,
 * model, at }`; unknown shapes still count as a request so failures leave a
 * trace even when the provider emitted no usage chunk.
 */
export function applyUsage(entry, info = {}, clock = null) {
  const next = entry && typeof entry === "object" ? { ...emptyUsageEntry(), ...entry } : emptyUsageEntry();
  const at = typeof info.at === "string" && info.at ? info.at : isoNow(clock);
  const status = info.status === "success" || info.status === "failure" ? info.status : "success";
  const usage = info.usage && typeof info.usage === "object" ? info.usage : null;

  const tokens = {};
  for (const field of TOKEN_FIELDS) tokens[field] = nonNegativeInteger(usage?.[field]) ?? 0;
  // Prefer the provider's own total when present; otherwise approximate the
  // billed total as input + output + cache (reasoning is usually a subset of
  // output, so counting it again would double-charge).
  const totalTokens = nonNegativeInteger(usage?.totalTokens)
    ?? tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens;

  next.requests += 1;
  next[status === "success" ? "ok" : "errors"] += 1;
  for (const field of TOKEN_FIELDS) next[field] += tokens[field];
  next.totalTokens += totalTokens;
  next.firstUsedAt ??= at;
  next.lastUsedAt = at;
  next.lastModel = text(info.model);
  next.lastStatus = status;

  const day = dayKey(at);
  if (day) {
    next.days = pruneDays(next.days, Date.parse(at));
    const bucket = { ...emptyDayBucket(), ...(next.days[day] ?? {}) };
    bucket.requests += 1;
    bucket[status === "success" ? "ok" : "errors"] += 1;
    for (const field of TOKEN_FIELDS) bucket[field] += tokens[field];
    bucket.totalTokens += totalTokens;
    next.days = { ...next.days, [day]: bucket };
  }

  const recent = Array.isArray(next.recent) ? next.recent.filter((row) => row && typeof row === "object") : [];
  recent.push({
    at,
    model: text(info.model),
    status,
    ...tokens,
    totalTokens,
  });
  next.recent = recent.slice(-RECENT_LIMIT);
  return next;
}

/** Restore a persisted entry, dropping malformed fields defensively. */
export function reviveUsageEntry(raw) {
  const base = emptyUsageEntry();
  if (!raw || typeof raw !== "object") return base;
  const revived = { ...base };
  for (const field of ["requests", "ok", "errors", ...TOKEN_FIELDS, "totalTokens"]) {
    revived[field] = nonNegativeInteger(raw[field]) ?? 0;
  }
  for (const field of ["firstUsedAt", "lastUsedAt", "lastModel", "lastStatus"]) {
    revived[field] = raw[field] ?? null;
  }
  revived.days = pruneDays(raw.days);
  revived.recent = Array.isArray(raw.recent)
    ? raw.recent.filter((row) => row && typeof row === "object").slice(-RECENT_LIMIT)
    : [];
  return revived;
}

/** Sum several entries into one aggregate row (per-provider totals). */
export function sumUsageEntries(entries) {
  const total = emptyUsageEntry();
  for (const entry of entries) {
    if (!entry) continue;
    total.requests += entry.requests ?? 0;
    total.ok += entry.ok ?? 0;
    total.errors += entry.errors ?? 0;
    for (const field of [...TOKEN_FIELDS, "totalTokens"]) total[field] += entry[field] ?? 0;
    if (!total.firstUsedAt || (entry.firstUsedAt && entry.firstUsedAt < total.firstUsedAt)) {
      total.firstUsedAt = entry.firstUsedAt;
    }
    if (!total.lastUsedAt || (entry.lastUsedAt && entry.lastUsedAt > total.lastUsedAt)) {
      total.lastUsedAt = entry.lastUsedAt;
      total.lastModel = entry.lastModel ?? total.lastModel;
      total.lastStatus = entry.lastStatus ?? total.lastStatus;
    }
  }
  return total;
}

/**
 * In-process ledger with debounced JSON persistence. One instance is shared
 * by the native key-pool host and the Dockyard runtime's provider routes.
 */
export class TokenUsageLedger {
  #providers = new Map();
  #stateStore;
  #clock;
  #logger;
  #saveTimer = null;
  #savePromise = Promise.resolve();
  #disposed = false;

  constructor({ stateStore = null, filePath = null, logger = console, clock = null } = {}) {
    this.#stateStore = stateStore ?? TokenUsageLedger.defaultStateStore(filePath);
    this.#clock = clock;
    this.#logger = logger;
  }

  static defaultStateStore(filePath) {
    return new JsonStateStore({
      filePath: filePath ?? join(defaultDockyardHome(), "token-usage.json"),
    });
  }

  async load() {
    let state = null;
    try {
      state = await this.#stateStore.load();
    } catch (error) {
      this.#logger.warn?.(`token 用量记录读取失败：${error instanceof Error ? error.message : error}`);
      return this;
    }
    const providers = state?.usage?.providers;
    if (providers && typeof providers === "object") {
      for (const [providerId, subjects] of Object.entries(providers)) {
        if (!subjects || typeof subjects !== "object") continue;
        const map = new Map();
        for (const [subjectId, entry] of Object.entries(subjects)) {
          if (!text(subjectId)) continue;
          map.set(subjectId, reviveUsageEntry(entry));
        }
        if (map.size > 0) this.#providers.set(providerId, map);
      }
    }
    return this;
  }

  /** Record one finished request. Never throws; never blocks on disk. */
  record(providerId, subjectId, info = {}) {
    if (this.#disposed) return;
    const provider = text(providerId);
    const subject = text(subjectId);
    if (!provider || !subject) return;
    let subjects = this.#providers.get(provider);
    if (!subjects) {
      subjects = new Map();
      this.#providers.set(provider, subjects);
    }
    subjects.set(subject, applyUsage(subjects.get(subject), info, this.#clock));
    this.#scheduleSave();
  }

  /** Public snapshot: `{ subjectId -> entry }` plus provider totals. */
  snapshot(providerId) {
    const subjects = this.#providers.get(text(providerId)) ?? new Map();
    const rows = Object.fromEntries([...subjects].map(([subjectId, entry]) => [subjectId, entry]));
    return {
      subjects: rows,
      totals: sumUsageEntries([...subjects.values()]),
      updatedAt: isoNow(this.#clock),
    };
  }

  /** Merge helper for status payloads: `{ ref -> entry }` lookup. */
  entryFor(providerId, subjectId) {
    return this.#providers.get(text(providerId))?.get(text(subjectId)) ?? null;
  }

  /** Reset one credential or the whole provider. Returns what was cleared. */
  reset(providerId, subjectId = null) {
    const provider = text(providerId);
    if (!provider) return { providers: 0, subjects: 0 };
    if (subjectId === null || subjectId === undefined) {
      const subjects = this.#providers.get(provider)?.size ?? 0;
      this.#providers.delete(provider);
      this.#scheduleSave();
      return { providers: 1, subjects };
    }
    const subjects = this.#providers.get(provider);
    if (!subjects?.has(text(subjectId))) return { providers: 0, subjects: 0 };
    subjects.delete(text(subjectId));
    if (subjects.size === 0) this.#providers.delete(provider);
    this.#scheduleSave();
    return { providers: 0, subjects: 1 };
  }

  #scheduleSave() {
    if (this.#disposed || this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.#savePromise = this.#savePromise.then(() => this.flush(), () => this.flush());
    }, SAVE_DEBOUNCE_MS);
    this.#saveTimer.unref?.();
  }

  async flush() {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    const payload = {
      schema: 1,
      usage: {
        providers: Object.fromEntries([...this.#providers].map(([providerId, subjects]) => [
          providerId,
          Object.fromEntries(subjects),
        ])),
      },
    };
    try {
      await this.#stateStore.save(payload);
    } catch (error) {
      this.#logger.warn?.(`token 用量记录写入失败：${error instanceof Error ? error.message : error}`);
    }
    return payload;
  }

  async dispose() {
    this.#disposed = true;
    await this.flush();
  }
}
