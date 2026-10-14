/**
 * dsh-model-usage — Host half.
 *
 * Serves persisted usage snapshots without decoding logs on open/filter.
 * Only an explicit refresh reads changed files, resuming validated cursors;
 * an explicit rebuild imports every preferred session artifact from scratch.
 *
 * Read-only: this plugin never writes to session directories. Its only
 * write is its own cache file under <dshHome>/dsh-model-usage/.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, relative, isAbsolute } from "node:path";
import { RECORD_VERSION, fileStamp, readUsageFile, listArtifacts } from "./scan.js";
import { aggregate, parseDay } from "./aggregate.js";

export const name = "dsh-model-usage";
// `connection` provides the GUI's Host/Origin fence + signed browser-cookie
// check; webServer routes carry no auth of their own.
export const inject = ["webServer", "dshHomePath", "connection"];

const API_PREFIX = "/model-usage/api";
const VERSION = "0.2.0";

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

  /** path -> { stamp, record, optional cursor }; legacy v1 records remain usable. */
  let cache = new Map();
  let cacheReady = false;
  let loading = null;
  let pruning = null;
  let saving = Promise.resolve();
  let disposed = false;
  let scanning = null;
  const state = { lastScanAt: 0, lastScanMs: 0, files: 0, reparsed: 0, incrementalFiles: 0,
    fullFiles: 0, bytesRead: 0, scanCount: 0, needsRefresh: false, errors: [], progress: null };

  const loadCache = () => loading ||= (async () => {
    try {
      const raw = JSON.parse(await readFile(cacheFile, "utf8"));
      if (raw && raw.version === RECORD_VERSION && raw.files && typeof raw.files === "object") {
        cache = new Map(Object.entries(raw.files).filter(([file, entry]) => {
          const rel = relative(sessionsRoot, file);
          return rel && !rel.startsWith("..") && !isAbsolute(rel) && entry?.record?.buckets
            && typeof entry.record.buckets === "object" && Number.isSafeInteger(entry.size);
        }));
        cacheReady = true;
        state.files = cache.size;
        state.lastScanAt = raw.scannedAt || raw.savedAt || 0;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") ctx?.logger?.warn?.("model-usage: cache unreadable; use refresh: " + errorText(error));
    }
  })();

  const saveCache = () => {
    const content = JSON.stringify({ version: RECORD_VERSION, savedAt: Date.now(),
      scannedAt: state.lastScanAt, files: Object.fromEntries(cache) });
    const pending = saving.catch(() => {}).then(async () => {
      await mkdir(cacheDir, { recursive: true });
      const tmp = cacheFile + "." + randomUUID() + ".tmp";
      await writeFile(tmp, content);
      await rename(tmp, cacheFile);
    });
    saving = pending;
    return pending;
  };

  const different = (hit, stamp) => !hit || hit.size !== stamp.size || hit.mtimeMs !== stamp.mtimeMs
    || (hit.identity && hit.identity !== stamp.identity) || (hit.mtimeNs && hit.mtimeNs !== stamp.mtimeNs)
    || (hit.ctimeNs && hit.ctimeNs !== stamp.ctimeNs);

  // Metadata checks remove deleted contributions without reading or decoding logs.
  const pruneMissing = () => pruning ||= (async () => {
    await loadCache();
    let changed = false;
    for (const [file, hit] of [...cache]) {
      try { if (different(hit, await fileStamp(file))) state.needsRefresh = true; }
      catch (error) {
        if (error.code !== "ENOENT") continue;
        if (cache.get(file) === hit) { cache.delete(file); changed = true; }
      }
    }
    state.files = cache.size;
    if (changed) {
      try { await saveCache(); }
      catch (error) { ctx?.logger?.warn?.("model-usage: cache prune save failed: " + errorText(error)); }
    }
  })().finally(() => { pruning = null; });

  const runScan = async (rebuild) => {
    const started = Date.now();
    await loadCache();
    if (pruning) await pruning;
    const files = await listArtifacts(sessionsRoot);
    const seen = new Set(files);
    let reparsed = 0;
    let incrementalFiles = 0;
    let fullFiles = 0;
    let bytesRead = 0;
    let changed = rebuild;
    const next = rebuild ? new Map() : new Map(cache);
    const errors = [];
    state.progress = { done: 0, total: files.length };
    for (const file of files) {
      if (disposed) return;
      try {
        const stamp = await fileStamp(file);
        const hit = next.get(file);
        if (different(hit, stamp)) {
          const { bytesRead: read, mode, ...entry } = await readUsageFile(file, hit);
          next.set(file, entry);
          bytesRead += read;
          if (mode === "incremental") incrementalFiles++; else fullFiles++;
          reparsed++;
          changed = true;
        }
      } catch (error) {
        if (error.code === "ENOENT") { next.delete(file); changed = true; }
        else errors.push({ file, error: errorText(error) });
      }
      state.progress.done++;
    }
    for (const key of [...next.keys()]) {
      try {
        if (seen.has(key)) { await fileStamp(key); continue; }
      } catch (error) { if (error.code !== "ENOENT") continue; }
      next.delete(key);
      changed = true;
    }
    if (disposed) return;
    cache = next;
    const firstSnapshot = !cacheReady;
    cacheReady = true;
    Object.assign(state, {
      lastScanAt: Date.now(),
      lastScanMs: Date.now() - started,
      files: cache.size, reparsed, incrementalFiles, fullFiles, bytesRead,
      scanCount: state.scanCount + 1, needsRefresh: false,
      errors: errors.slice(0, 20),
      progress: null
    });
    if (changed || firstSnapshot) {
      try { await saveCache(); }
      catch (error) { state.errors = [...state.errors, { file: cacheFile, error: "cache write failed: " + errorText(error) }].slice(0, 20); }
    }
  };

  /** Coalesce concurrent scans into one in-flight promise. */
  const scan = (rebuild = false) => {
    if (!scanning) {
      scanning = runScan(rebuild).finally(() => { scanning = null; });
    }
    return scanning;
  };

  const status = () => ({
    version: VERSION,
    mode: "manual", cacheReady, needsRefresh: state.needsRefresh,
    scanning: scanning !== null,
    progress: state.progress,
    lastScanAt: state.lastScanAt || null,
    lastScanMs: state.lastScanMs,
    files: state.files,
    reparsed: state.reparsed,
    incrementalFiles: state.incrementalFiles, fullFiles: state.fullFiles,
    bytesRead: state.bytesRead, scanCount: state.scanCount,
    errors: state.errors
  });

  const send = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  ctx.effect(() => () => { disposed = true; }, "model-usage: lifecycle");

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
          const from = q.get("from") || undefined;
          const to = q.get("to") || undefined;
          if ((from && !parseDay(from)) || (to && !parseDay(to)) || (from && to && from > to)) {
            return send(res, 400, { ok: false, error: "Expected valid YYYY-MM-DD dates with from <= to" });
          }
          await loadCache();
          if (q.get("refresh") === "1") await scan();
          else await pruneMissing();
          const summary = aggregate([...cache.values()].map((e) => e.record), {
            from,
            to,
            provider: q.get("provider") || undefined,
            model: q.get("model") || undefined,
            includeSubagents: q.get("subagents") !== "0",
            topSessions: 20
          });
          return send(res, 200, { ok: true, result: { ...summary, status: status() } });
        }
        if (req.method === "POST" && path === "/rebuild") {
          if (scanning) await scanning;
          await scan(true);
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
