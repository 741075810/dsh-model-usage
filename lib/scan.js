/**
 * dsh-model-usage — scan core (pure Node, no Cordis dependency).
 *
 * Reads DSH durable session logs (concatenated zstd frames of JSONL, or plain
 * JSONL) and folds every provider-reported token usage sample into buckets
 * keyed by local day + provider + model + kind.
 *
 * Kinds:
 *   chat        assistant/message usage (normal model replies, incl. subagents)
 *   failed      assistant/attempt usage (attempt billed, then failed / retried)
 *   compaction  compaction/summary usage (context compaction summaries)
 */
import { open, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { setImmediate as yieldLoop } from "node:timers/promises";

/** Bump when the per-file record format or fold semantics change. */
export const RECORD_VERSION = 1;

/** Artifact preference inside one session directory (first match wins). */
export const ARTIFACT_NAMES = [
  "session.v4.jsonl.zstd",
  "session.v3.jsonl.zstd",
  "session.v2.jsonl.zstd",
  "session.jsonl.zstd",
  "session.jsonl"
];

export const KINDS = ["chat", "failed", "compaction"];

const ZSTD_MAGIC = 0xfd2fb528;

/**
 * Split a buffer of concatenated zstd frames into frame ranges. A torn
 * trailing frame (a write in progress) is ignored rather than treated as
 * corruption. Skippable frames are skipped.
 * @param {Buffer} buffer
 * @returns {{ start: number, end: number }[]}
 */
export function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 8) break;
    const magic = buffer.readUint32LE(offset);
    // Skippable frame: magic 0x184D2A5? followed by a 4-byte size.
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      const size = buffer.readUint32LE(offset + 4);
      offset += 8 + size;
      continue;
    }
    if (magic !== ZSTD_MAGIC) throw new Error(`invalid zstd frame magic at byte ${offset}`);
    offset += 4;
    const descriptor = buffer.readUint8(offset++);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    let torn = false;
    for (;;) {
      if (buffer.length - offset < 3) { torn = true; break; }
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) throw new Error(`reserved zstd block type at byte ${offset - 3}`);
      const payload = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payload) { torn = true; break; }
      offset += payload;
      if (lastBlock) break;
    }
    if (!torn && checksum) {
      if (buffer.length - offset < 4) torn = true;
      else offset += 4;
    }
    if (torn) break;
    frames.push({ start, end: offset });
  }
  return frames;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * Normalize one provider usage sample. `input` is uncached prompt input
 * (DSH convention); cache buckets are separate. Returns undefined for a
 * missing or all-zero sample.
 */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const input = num(usage.inputTokens);
  const output = num(usage.outputTokens);
  const cacheRead = num(usage.cacheReadTokens);
  const cacheWrite = num(usage.cacheWriteTokens);
  const reasoning = num(usage.reasoningTokens);
  const summed = input + output + cacheRead + cacheWrite;
  const total = Math.max(num(usage.totalTokens), summed);
  if (total === 0) return undefined;
  return { input, output, cacheRead, cacheWrite, reasoning, total };
}

/** Last `usage` chunk of an assistant stream, if any. */
export function streamUsage(stream) {
  if (!Array.isArray(stream)) return undefined;
  for (let i = stream.length - 1; i >= 0; i--) {
    const chunk = stream[i] && stream[i].chunk;
    if (chunk && chunk.type === "usage" && chunk.usage) return chunk.usage;
  }
  return undefined;
}

/** Local calendar day (host timezone) for an epoch-ms time. */
export function dayKey(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Only lines of these types are JSON-parsed; everything else is skipped by a
// cheap prefix test (assistant/message lines are huge, but they are exactly
// the ones we need).
const WANTED = /^\{"type":"(session|session\/title|request\/header|model\/selection|assistant\/message|assistant\/attempt|compaction\/summary)"/;

/**
 * Incremental per-file fold. Feed complete JSONL lines with `line()`, then
 * read `record()`.
 */
export function createFold(snapshot) {
  const rec = {
    id: undefined,
    title: undefined,
    cwd: undefined,
    depth: 0,
    firstAt: undefined,
    lastAt: undefined,
    ...snapshot?.record,
    buckets: snapshot?.record
      ? Object.fromEntries(Object.entries(snapshot.record.buckets).map(([key, value]) => [key, [...value]])) : {}
  };
  let route = snapshot?.route ? { ...snapshot.route } : { provider: "unknown", model: "unknown" };

  const add = (time, provider, model, kind, usage) => {
    const u = normalizeUsage(usage);
    if (!u) return;
    const t = typeof time === "number" ? time : (rec.lastAt ?? Date.now());
    const key = `${dayKey(t)}|${provider || "unknown"}|${model || "unknown"}|${kind}`;
    const b = rec.buckets[key] || (rec.buckets[key] = [0, 0, 0, 0, 0, 0, 0]);
    b[0] += 1; // requests
    b[1] += u.input;
    b[2] += u.output;
    b[3] += u.cacheRead;
    b[4] += u.cacheWrite;
    b[5] += u.reasoning;
    b[6] += u.total;
  };

  const line = (text) => {
    if (!WANTED.test(text)) return;
    let e;
    try { e = JSON.parse(text); } catch { return; }
    const d = e.data;
    if (typeof e.time === "number") {
      if (rec.firstAt === undefined || e.time < rec.firstAt) rec.firstAt = e.time;
      if (rec.lastAt === undefined || e.time > rec.lastAt) rec.lastAt = e.time;
    }
    switch (e.type) {
      case "session":
        // Header line: no data envelope.
        rec.id = typeof e.id === "string" ? e.id : rec.id;
        rec.cwd = typeof e.cwd === "string" ? e.cwd : rec.cwd;
        rec.depth = typeof e.delegationDepth === "number" ? e.delegationDepth : rec.depth;
        if (typeof e.createdAt === "number" && rec.firstAt === undefined) rec.firstAt = e.createdAt;
        return;
      case "session/title":
        if (d && typeof d.title === "string" && d.title.trim() !== "") rec.title = d.title;
        return;
      case "request/header": {
        const c = d && d.header && d.header.config;
        if (c && typeof c.provider === "string" && typeof c.model === "string") route = { provider: c.provider, model: c.model };
        return;
      }
      case "model/selection":
        if (d && typeof d.provider === "string" && typeof d.model === "string") route = { provider: d.provider, model: d.model };
        return;
      case "assistant/message": {
        if (!d) return;
        const src = d.message && d.message.source;
        const provider = src && typeof src.provider === "string" && src.provider ? src.provider : route.provider;
        const model = src && typeof src.model === "string" && src.model ? src.model : route.model;
        add(e.time, provider, model, "chat", d.usage ?? streamUsage(d.stream));
        return;
      }
      case "assistant/attempt":
        if (d) add(e.time, route.provider, route.model, "failed", streamUsage(d.stream));
        return;
      case "compaction/summary":
        if (d) add(e.time, d.provider || route.provider, d.model || route.model, "compaction", d.usage);
        return;
      default:
        return;
    }
  };

  return { line, record: () => rec, snapshot: () => ({ record: rec, route: { ...route } }) };
}

/**
 * Fold one session artifact file into a usage record. Decodes zstd frame by
 * frame (bounded memory) and yields to the event loop periodically.
 * @param {string} file
 */
export async function foldFile(file) {
  return (await readUsageFile(file)).record;
}

const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");
const changedDuringRead = () => Object.assign(new Error("session artifact changed during read"), { code: "EAGAIN" });

function stampOf(s) {
  const size = Number(s.size);
  if (!Number.isSafeInteger(size)) throw new Error("session artifact exceeds supported byte range");
  return {
    size, mtimeMs: Number(s.mtimeNs / 1000000n),
    mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs),
    identity: [s.dev, s.ino, s.birthtimeNs].join(":")
  };
}

/** Resume only a validated, complete prefix; old caches migrate lazily on refresh. */
async function readSnapshot(file, previous) {
  const handle = await open(file, "r");
  let bytesRead = 0;
  const range = async (start, size) => {
    const buffer = Buffer.allocUnsafe(size);
    let done = 0;
    while (done < size) {
      const part = await handle.read(buffer, done, size - done, start + done);
      if (!part.bytesRead) throw changedDuringRead();
      bytesRead += part.bytesRead;
      done += part.bytesRead;
    }
    return buffer;
  };
  try {
    const stamp = stampOf(await handle.stat({ bigint: true }));
    const cursor = previous?.cursor;
    const validGuard = (g) => g && Number.isSafeInteger(g.start) && Number.isSafeInteger(g.end)
      && g.start >= 0 && g.end >= g.start && g.end <= cursor.offset && typeof g.hash === "string";
    let resume = cursor?.version === 1 && cursor.encoding === (file.endsWith(".zstd") ? "zstd" : "jsonl")
      && previous.identity === stamp.identity && stamp.size >= previous.size
      && Number.isSafeInteger(cursor.offset) && cursor.offset >= 0 && cursor.offset <= stamp.size
      && typeof cursor.carry === "string" && typeof cursor.route?.provider === "string" && typeof cursor.route?.model === "string"
      && Number.isSafeInteger(cursor.head?.size) && cursor.head.size >= 0 && cursor.head.size <= stamp.size
      && typeof cursor.head.hash === "string" && validGuard(cursor.guard)
      && (stamp.size > previous.size || (stamp.mtimeNs === previous.mtimeNs && stamp.ctimeNs === previous.ctimeNs));
    if (resume) {
      const head = await range(0, cursor.head.size);
      const tail = await range(cursor.guard.start, cursor.guard.end - cursor.guard.start);
      resume = digest(head) === cursor.head.hash && digest(tail) === cursor.guard.hash;
    }
    const start = resume ? cursor.offset : 0;
    const fold = createFold(resume ? { record: previous.record, route: cursor.route } : undefined);
    let carry = resume ? Buffer.from(cursor.carry, "base64") : Buffer.alloc(0);
    const feed = (data) => {
      const text = carry.length ? Buffer.concat([carry, data]) : data;
      let from = 0;
      for (let end = text.indexOf(10); end !== -1; end = text.indexOf(10, from)) {
        if (end > from) fold.line(text.subarray(from, end).toString("utf8"));
        from = end + 1;
      }
      carry = Buffer.from(text.subarray(from));
    };
    const buffer = await range(start, stamp.size - start);
    let offset = start;
    let guard = resume ? cursor.guard : { start: 0, end: 0, hash: digest(Buffer.alloc(0)) };
    if (file.endsWith(".zstd")) {
      const frames = scanZstdFrames(buffer);
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const raw = buffer.subarray(frame.start, frame.end);
        feed(zstdDecompressSync(raw));
        offset = start + frame.end;
        guard = { start: start + frame.start, end: offset, hash: digest(raw) };
        if (i % 256 === 255) await yieldLoop();
      }
    } else {
      feed(buffer);
      offset = stamp.size;
      const tailStart = Math.max(0, offset - 256);
      const tail = tailStart >= start ? buffer.subarray(tailStart - start) : await range(tailStart, offset - tailStart);
      guard = { start: tailStart, end: offset, hash: digest(tail) };
    }
    const headSize = resume ? cursor.head.size : Math.min(stamp.size, 256);
    const head = resume ? cursor.head : { size: headSize, hash: digest(buffer.subarray(0, headSize)) };
    const after = stampOf(await handle.stat({ bigint: true }));
    const pathStamp = await fileStamp(file);
    for (const current of [after, pathStamp]) {
      if (current.identity !== stamp.identity || current.size < stamp.size
        || (current.size === stamp.size && (current.mtimeNs !== stamp.mtimeNs || current.ctimeNs !== stamp.ctimeNs))) throw changedDuringRead();
    }
    if (after.size > stamp.size || pathStamp.size > stamp.size) {
      if (digest(await range(0, head.size)) !== head.hash
        || digest(await range(guard.start, guard.end - guard.start)) !== guard.hash) throw changedDuringRead();
    }
    return {
      ...stamp, record: fold.record(), bytesRead, mode: resume ? "incremental" : "full",
      cursor: { version: 1, encoding: file.endsWith(".zstd") ? "zstd" : "jsonl", offset,
        carry: carry.toString("base64"), route: fold.snapshot().route, head, guard }
    };
  } finally { await handle.close(); }
}

/** Read appended bytes on manual refresh; retry a concurrent truncate/replace once. */
export async function readUsageFile(file, previous) {
  for (let attempt = 0; ; attempt++) {
    try { return await readSnapshot(file, previous); }
    catch (error) { if (error.code !== "EAGAIN" || attempt >= 1) throw error; }
  }
}

/**
 * List one preferred artifact per session directory under `root`.
 * @param {string} root  <dshHome>/sessions
 * @param {number} maxDepth
 * @returns {Promise<string[]>}
 */
export async function listArtifacts(root, maxDepth = 6) {
  const out = [];
  const walk = async (dir, depth) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    const names = new Set();
    for (const ent of entries) {
      if (ent.isDirectory()) { if (depth < maxDepth) await walk(join(dir, ent.name), depth + 1); }
      else if (ent.isFile()) names.add(ent.name);
    }
    const pick = ARTIFACT_NAMES.find((n) => names.has(n));
    if (pick) out.push(join(dir, pick));
  };
  await walk(root, 0);
  return out;
}

/** File identity used as the cache key validator. */
export async function fileStamp(file) {
  return stampOf(await stat(file, { bigint: true }));
}
