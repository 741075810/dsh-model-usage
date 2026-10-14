/**
 * dsh-model-usage — aggregation over per-file usage records (pure).
 *
 * A record's `buckets` map "day|provider|model|kind" to
 * [requests, input, output, cacheRead, cacheWrite, reasoning, total].
 */

const FIELDS = ["requests", "input", "output", "cacheRead", "cacheWrite", "reasoning", "total"];

const zero = () => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 });

const addInto = (target, arr) => {
  for (let i = 0; i < FIELDS.length; i++) target[FIELDS[i]] += arr[i] || 0;
};

/** Split a bucket key; provider/model may not contain "|" in practice, but model ids can contain "/". */
export function parseKey(key) {
  const first = key.indexOf("|");
  const last = key.lastIndexOf("|");
  const day = key.slice(0, first);
  const kind = key.slice(last + 1);
  const mid = key.slice(first + 1, last);
  const sep = mid.indexOf("|");
  return { day, provider: mid.slice(0, sep), model: mid.slice(sep + 1), kind };
}

/** Validate an inclusive "YYYY-MM-DD" bound, or undefined. */
export function parseDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : undefined;
}

/**
 * Aggregate records into the dashboard summary.
 * @param {Iterable<object>} records  per-file usage records
 * @param {{ from?: string, to?: string, provider?: string, model?: string, includeSubagents?: boolean, topSessions?: number }} options
 */
export function aggregate(records, options = {}) {
  const from = parseDay(options.from);
  const to = parseDay(options.to);
  if (from && to && from > to) throw new RangeError("from must be on or before to");
  const selectedProvider = options.provider || undefined;
  const selectedModel = options.model || undefined;
  const includeSubagents = options.includeSubagents !== false;
  const topN = Number.isInteger(options.topSessions) && options.topSessions > 0 ? options.topSessions : 20;

  const totals = { ...zero(), sessions: 0 };
  const models = new Map();
  const providers = new Map();
  const days = new Map();
  const sessions = [];
  const availableModels = new Map();
  const availableProviders = new Set();

  for (const rec of records) {
    if (!rec || !rec.buckets) continue;
    const sessionSum = zero();
    const sessionModels = new Set();
    for (const [key, arr] of Object.entries(rec.buckets)) {
      const { day, provider, model, kind } = parseKey(key);
      const mk = provider + "|" + model;
      // Keep choices stable even when the active range or filters have no usage.
      availableProviders.add(provider);
      availableModels.set(mk, { provider, model });
      if ((!includeSubagents && rec.depth > 0)
        || (from && day < from) || (to && day > to)
        || (selectedProvider && provider !== selectedProvider)
        || (selectedModel && model !== selectedModel)) continue;
      let m = models.get(mk);
      if (!m) {
        m = { provider, model, ...zero(), sessions: 0, firstDay: day, lastDay: day, kinds: {}, _sessions: new Set() };
        models.set(mk, m);
      }
      addInto(m, arr);
      if (day < m.firstDay) m.firstDay = day;
      if (day > m.lastDay) m.lastDay = day;
      const k = m.kinds[kind] || (m.kinds[kind] = zero());
      addInto(k, arr);
      m._sessions.add(rec.id || rec.file);

      let p = providers.get(provider);
      if (!p) { p = { provider, ...zero() }; providers.set(provider, p); }
      addInto(p, arr);

      let dd = days.get(day);
      if (!dd) { dd = { day, ...zero(), byModel: {} }; days.set(day, dd); }
      addInto(dd, arr);
      dd.byModel[mk] = (dd.byModel[mk] || 0) + (arr[6] || 0);

      addInto(sessionSum, arr);
      sessionModels.add(provider + "/" + model);
    }
    if (sessionSum.requests > 0) {
      totals.sessions += 1;
      for (const f of FIELDS) totals[f] += sessionSum[f];
      sessions.push({
        id: rec.id,
        title: rec.title,
        cwd: rec.cwd,
        depth: rec.depth,
        lastAt: rec.lastAt,
        ...sessionSum,
        models: [...sessionModels]
      });
    }
  }

  const modelList = [...models.values()].map((m) => {
    const { _sessions, ...rest } = m;
    return { ...rest, sessions: _sessions.size };
  }).sort((a, b) => b.total - a.total);

  sessions.sort((a, b) => b.total - a.total);

  return {
    range: { from: from ?? null, to: to ?? null, includeSubagents },
    filters: { provider: selectedProvider ?? null, model: selectedModel ?? null },
    catalog: {
      providers: [...availableProviders].sort(),
      models: [...availableModels.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
    },
    totals,
    models: modelList,
    providers: [...providers.values()].sort((a, b) => b.total - a.total),
    days: [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
    sessions: sessions.slice(0, topN)
  };
}
