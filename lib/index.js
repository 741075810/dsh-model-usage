/**
 * dsh-model-usage — Host half.
 *
 * Scans every durable session log under <dshHome>/sessions, folds the
 * provider-reported token usage into per-file records (cached on disk by
 * size + mtime so only changed sessions are re-read), and serves a per-model
 * usage summary over HTTP for the client dashboard (lib/client.js).
 *
 * Read-only: this plugin never writes to session directories. Its only
 * write is its own cache file under <dshHome>/dsh-model-usage/.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RECORD_VERSION, fileStamp, foldFile, listArtifacts } from "./scan.js";
import { aggregate } from "./aggregate.js";

export const name = "dsh-model-usage";
// `connection` provides the GUI's Host/Origin fence + signed browser-cookie
// check; webServer routes carry no auth of their own.
export const inject = ["webServer", "dshHomePath", "connection"];

const API_PREFIX = "/model-usage/api";
const VERSION = "0.1.0";
/** A summary request rescans (stat-only for unchanged files) if the last scan is older than this. */
const FRESH_MS = 10_000;
/** Background warm-up scan delay after the plugin starts. */
const WARMUP_MS = 8_000;

function errorText(error) {
  if (error && typeof error.message === "string" && error.message) return error.message;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function getService(ctx, key) {
  try {
    const value = typeof ctx?.get === "function" ? ctx.get(key) : undefined;
    if (value !== undefined) return value;
  } catch { /* fall back to the injected property */ }
  return ctx && ctx[key];
}

export function apply(ctx) {
  const homePath = getService(ctx, "dshHomePath");
  if (typeof homePath !== "function") {
    ctx?.logger?.warn?.("model-usage: dshHomePath unavailable, plugin disabled");
    return;
  }
  ctx?.logger?.info?.(`dsh-model-usage v${VERSION}`);

  const sessionsRoot = homePath("sessions");
  const cacheDir = homePath("dsh-model-usage");
  const cacheFile = join(cacheDir, "cache.json");

  /** path -> { size, mtimeMs, record } */
  let cache = new Map();
  let cacheLoaded = false;
  let disposed = false;
  let scanning = null;
  const state = { lastScanAt: 0, lastScanMs: 0, files: 0, reparsed: 0, errors: [], progress: null };

  const loadCache = async () => {
    if (cacheLoaded) return;
    cacheLoaded = true;
    try {
      const raw = JSON.parse(await readFile(cacheFile, "utf8"));
      if (raw && raw.version === RECORD_VERSION && raw.files && typeof raw.files === "object") {
        cache = new Map(Object.entries(raw.files));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") ctx?.logger?.warn?.("model-usage: cache unreadable, rebuilding: " + errorText(error));
    }
  };

  const saveCache = async () => {
    await mkdir(cacheDir, { recursive: true });
    const tmp = cacheFile + "." + process.pid + ".tmp";
    await writeFile(tmp, JSON.stringify({ version: RECORD_VERSION, savedAt: Date.now(), files: Object.fromEntries(cache) }));
    await rename(tmp, cacheFile);
  };

  const runScan = async () => {
    const started = Date.now();
    await loadCache();
    const files = await listArtifacts(sessionsRoot);
    const seen = new Set(files);
    let reparsed = 0;
    let changed = false;
    const errors = [];
    state.progress = { done: 0, total: files.length };
    for (const file of files) {
      if (disposed) return;
      try {
        const stamp = await fileStamp(file);
        const hit = cache.get(file);
        if (!hit || hit.size !== stamp.size || hit.mtimeMs !== stamp.mtimeMs) {
          const record = await foldFile(file);
          cache.set(file, { ...stamp, record });
          reparsed++;
          changed = true;
        }
      } catch (error) {
        errors.push({ file, error: errorText(error) });
      }
      state.progress.done++;
    }
    for (const key of [...cache.keys()]) {
      if (!seen.has(key)) { cache.delete(key); changed = true; }
    }
    if (changed) {
      try { await saveCache(); }
      catch (error) { errors.push({ file: cacheFile, error: "cache write failed: " + errorText(error) }); }
    }
    Object.assign(state, {
      lastScanAt: Date.now(),
      lastScanMs: Date.now() - started,
      files: files.length,
      reparsed,
      errors: errors.slice(0, 20),
      progress: null
    });
  };

  /** Coalesce concurrent scans into one in-flight promise. */
  const scan = () => {
    if (!scanning) {
      scanning = runScan().finally(() => { scanning = null; });
    }
    return scanning;
  };

  const ensureFresh = async (force) => {
    if (force || Date.now() - state.lastScanAt > FRESH_MS) await scan();
    else if (scanning) await scanning;
  };

  const status = () => ({
    version: VERSION,
    scanning: scanning !== null,
    progress: state.progress,
    lastScanAt: state.lastScanAt || null,
    lastScanMs: state.lastScanMs,
    files: state.files,
    reparsed: state.reparsed,
    errors: state.errors
  });

  const send = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  ctx.effect(() => {
    const timer = setTimeout(() => { scan().catch((e) => ctx?.logger?.warn?.("model-usage: warm-up scan failed: " + errorText(e))); }, WARMUP_MS);
    return () => { disposed = true; clearTimeout(timer); };
  }, "model-usage: warm-up scan");

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: API_PREFIX,
    handler: async (req, res) => {
      // Same admission as the GUI's /api channel; fail closed if unavailable.
      const connection = getService(ctx, "connection");
      const rejection = connection && typeof connection.requestRejection === "function"
        ? connection.requestRejection(req)
        : 503;
      if (rejection !== undefined) {
        return send(res, rejection, { ok: false, error: rejection === 401 ? "unauthorized" : rejection === 403 ? "forbidden" : "auth unavailable" });
      }
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) || "/" : "/";
        if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true, result: { plugin: name, version: VERSION } });
        if (req.method === "GET" && path === "/status") return send(res, 200, { ok: true, result: status() });
        if (req.method === "GET" && path === "/summary") {
          const q = url.searchParams;
          await ensureFresh(q.get("refresh") === "1");
          const summary = aggregate([...cache.values()].map((e) => e.record), {
            from: q.get("from") ?? undefined,
            to: q.get("to") ?? undefined,
            includeSubagents: q.get("subagents") !== "0",
            topSessions: 20
          });
          return send(res, 200, { ok: true, result: { ...summary, status: status() } });
        }
        if (req.method === "POST" && path === "/rebuild") {
          if (scanning) await scanning;
          cache = new Map();
          await scan();
          return send(res, 200, { ok: true, result: status() });
        }
        return send(res, 404, { ok: false, error: "not found: " + req.method + " " + path });
      } catch (error) {
        ctx?.logger?.warn?.("model-usage: api error: " + errorText(error));
        return send(res, 500, { ok: false, error: errorText(error) });
      }
    }
  }), "model-usage: http api");
}
