import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { dayKey, foldFile, listArtifacts, normalizeUsage, scanZstdFrames } from "../lib/scan.js";
import { aggregate, parseKey } from "../lib/aggregate.js";

const T1 = new Date(2026, 9, 10, 12, 0, 0).getTime();
const T2 = new Date(2026, 9, 11, 12, 0, 0).getTime();

const events = [
  { type: "session", version: 4, id: "s-1", createdAt: T1, cwd: "E:\\proj", delegationDepth: 0 },
  { type: "session/title", seq: 1, time: T1, data: { title: "demo" } },
  { type: "request/header", seq: 2, time: T1, data: { header: { config: { provider: "p1", model: "m/a" } } } },
  // Normal reply: route from message.source.
  { type: "assistant/message", seq: 3, time: T1, data: { turn: 1, step: 1, message: { source: { provider: "p1", model: "m/a" } },
    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, totalTokens: 1010 } } },
  { type: "model/selection", seq: 4, time: T2, data: { provider: "p2", model: "m-b" } },
  // Failed attempt: route from latest selection, usage from the stream.
  { type: "assistant/attempt", seq: 5, time: T2, data: { turn: 2, step: 1,
    stream: [{ type: "chunk", chunk: { type: "usage", usage: { inputTokens: 50, outputTokens: 5 } } }] } },
  // Reply with usage only in the stream.
  { type: "assistant/message", seq: 6, time: T2, data: { turn: 2, step: 1, message: { source: { provider: "p2", model: "m-b" } },
    stream: [{ type: "chunk", chunk: { type: "usage", usage: { inputTokens: 20, outputTokens: 2, cacheWriteTokens: 3 } } }] } },
  { type: "compaction/summary", seq: 7, time: T2, data: { provider: "p2", model: "m-b", usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 } } },
  // Zero usage is ignored.
  { type: "assistant/message", seq: 8, time: T2, data: { turn: 3, step: 1, message: { source: { provider: "p2", model: "m-b" } }, usage: { inputTokens: 0, outputTokens: 0 } } }
];

async function writeLog(dir, name, evs, { frames = 3, torn = true } = {}) {
  await mkdir(dir, { recursive: true });
  const lines = evs.map((e) => JSON.stringify(e) + "\n");
  const per = Math.ceil(lines.length / frames);
  const parts = [];
  for (let i = 0; i < lines.length; i += per) parts.push(zstdCompressSync(Buffer.from(lines.slice(i, i + per).join(""))));
  if (torn) parts.push(zstdCompressSync(Buffer.from(JSON.stringify(evs[3]) + "\n")).subarray(0, 12));
  const file = join(dir, name);
  await writeFile(file, Buffer.concat(parts));
  return file;
}

test("normalizeUsage fills total and rejects empty samples", () => {
  assert.equal(normalizeUsage(undefined), undefined);
  assert.equal(normalizeUsage({ inputTokens: 0, outputTokens: 0 }), undefined);
  assert.deepEqual(normalizeUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 }),
    { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, reasoning: 0, total: 6 });
  assert.equal(normalizeUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 50 }).total, 50);
  assert.equal(normalizeUsage({ inputTokens: -5, outputTokens: "x", totalTokens: 7 }).input, 0);
});

test("scanZstdFrames ignores a torn trailing frame", () => {
  const a = zstdCompressSync(Buffer.from("a\n"));
  const b = zstdCompressSync(Buffer.from("b\n"));
  const frames = scanZstdFrames(Buffer.concat([a, b, b.subarray(0, 7)]));
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[1], { start: a.length, end: a.length + b.length });
});

test("foldFile attributes usage per day, provider, model and kind", async () => {
  const root = await mkdtemp(join(tmpdir(), "mu-"));
  try {
    const file = await writeLog(join(root, "proj", "s-1"), "session.v4.jsonl.zstd", events);
    const rec = await foldFile(file);
    assert.equal(rec.id, "s-1");
    assert.equal(rec.title, "demo");
    assert.equal(rec.cwd, "E:\\proj");
    const d1 = dayKey(T1);
    const d2 = dayKey(T2);
    assert.deepEqual(rec.buckets, {
      [`${d1}|p1|m/a|chat`]: [1, 100, 10, 900, 0, 0, 1010],
      [`${d2}|p2|m-b|failed`]: [1, 50, 5, 0, 0, 0, 55],
      [`${d2}|p2|m-b|chat`]: [1, 20, 2, 0, 3, 0, 25],
      [`${d2}|p2|m-b|compaction`]: [1, 1000, 100, 0, 0, 0, 1100]
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listArtifacts picks one preferred artifact per session directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "mu-"));
  try {
    const dir = join(root, "proj", "s-1");
    await writeLog(dir, "session.jsonl.zstd", events, { torn: false });
    await writeLog(dir, "session.v4.jsonl.zstd", events, { torn: false });
    await mkdir(join(root, "proj", "s-2"), { recursive: true });
    await writeFile(join(root, "proj", "s-2", "session.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"));
    const files = (await listArtifacts(root)).map((f) => f.slice(root.length + 1).replaceAll("\\", "/")).sort();
    assert.deepEqual(files, ["proj/s-1/session.v4.jsonl.zstd", "proj/s-2/session.jsonl"]);
    const plain = await foldFile(join(root, "proj", "s-2", "session.jsonl"));
    assert.equal(Object.keys(plain.buckets).length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aggregate sums models, filters range and subagents", () => {
  const d1 = dayKey(T1);
  const d2 = dayKey(T2);
  const main = { id: "a", depth: 0, title: "A", buckets: {
    [`${d1}|p1|m/a|chat`]: [1, 100, 10, 900, 0, 0, 1010],
    [`${d2}|p2|m-b|chat`]: [2, 20, 2, 0, 3, 0, 25]
  } };
  const sub = { id: "b", depth: 1, buckets: { [`${d2}|p1|m/a|chat`]: [1, 1, 1, 0, 0, 0, 2] } };

  const all = aggregate([main, sub]);
  assert.equal(all.totals.total, 1037);
  assert.equal(all.totals.sessions, 2);
  assert.equal(all.models[0].model, "m/a");
  assert.equal(all.models[0].total, 1012);
  assert.equal(all.models[0].sessions, 2);
  assert.equal(all.days.length, 2);
  assert.equal(all.sessions[0].id, "a");

  const day2 = aggregate([main, sub], { from: d2, to: d2 });
  assert.equal(day2.totals.total, 27);
  assert.deepEqual(day2.models.map((m) => m.model), ["m-b", "m/a"]);

  const noSub = aggregate([main, sub], { from: d2, to: d2, includeSubagents: false });
  assert.equal(noSub.totals.total, 25);
  assert.equal(noSub.models.length, 1);
});

test("parseKey keeps slashes in model ids", () => {
  assert.deepEqual(parseKey("2026-10-10|cline|cline-pass/deepseek-v4.1-flash|chat"),
    { day: "2026-10-10", provider: "cline", model: "cline-pass/deepseek-v4.1-flash", kind: "chat" });
});
