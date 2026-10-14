import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { constants, zstdCompressSync } from "node:zlib";
import { aggregate } from "../lib/aggregate.js";
import { fileStamp, foldFile, readUsageFile } from "../lib/scan.js";

const time = new Date(2026, 9, 14, 12).getTime();
const header = { type: "session", version: 4, id: "s", createdAt: time, cwd: "E:\\fixture", delegationDepth: 1 };
const route = { type: "model/selection", time, data: { provider: "p", model: "model/x" } };
const usage = (input) => ({ type: "assistant/attempt", time, data: { stream: [
  { chunk: { type: "usage", usage: { inputTokens: input, outputTokens: 1 } } }
] } });
const lines = (events) => Buffer.from(events.map((e) => JSON.stringify(e) + "\n").join(""));
const frame = (events) => zstdCompressSync(lines(events), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
const total = (entry) => aggregate([entry.record]).totals.total;
async function fixture(t, name = "session.v4.jsonl.zstd") {
  const root = await mkdtemp(join(tmpdir(), "mu-incremental-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, name);
}

test("append resumes persisted route and record while reading only new frames plus guards", async (t) => {
  const file = await fixture(t);
  const ignored = { type: "tool/result", data: randomBytes(64000).toString("hex") };
  await writeFile(file, Buffer.concat([frame([header, route]), frame([ignored]), frame([usage(10)])]));
  const first = await readUsageFile(file);
  assert.equal(first.mode, "full");
  const persisted = JSON.parse(JSON.stringify(first));
  const frozen = structuredClone(persisted);
  const nextFrame = frame([usage(20)]);
  await appendFile(file, nextFrame);
  const next = await readUsageFile(file, persisted);
  assert.equal(next.mode, "incremental");
  assert.equal(total(next), 32);
  assert.ok(next.bytesRead < first.size / 10, "Old history must not be read/decompressed again");
  assert.deepEqual(next.record, await foldFile(file));
  assert.deepEqual(persisted, frozen, "Incremental fold must not mutate its prior checkpoint");
  const s = await stat(file, { bigint: true });
  assert.equal((await fileStamp(file)).identity, [s.dev, s.ino, s.birthtimeNs].join(":"));
});

test("torn trailing frame resumes at the last verified frame without duplicate usage", async (t) => {
  const file = await fixture(t);
  const committed = Buffer.concat([frame([header, route]), frame([usage(10)])]);
  const tail = frame([usage(20)]);
  const cut = Math.floor(tail.length / 2);
  await writeFile(file, Buffer.concat([committed, tail.subarray(0, cut)]));
  const first = await readUsageFile(file);
  assert.equal(first.cursor.offset, committed.length);
  assert.equal(total(first), 11);
  await appendFile(file, tail.subarray(cut));
  const next = await readUsageFile(file, JSON.parse(JSON.stringify(first)));
  assert.equal(next.mode, "incremental");
  assert.equal(total(next), 32);
  assert.equal(next.cursor.offset, committed.length + tail.length);
});

test("raw UTF-8 and JSONL carry survives a frame boundary and process restart", async (t) => {
  const file = await fixture(t);
  const title = "title-\u9f99";
  const event = lines([{ type: "session/title", time, data: { title } }]);
  const cut = event.indexOf(Buffer.from("\u9f99")) + 1;
  await writeFile(file, Buffer.concat([frame([header]), zstdCompressSync(event.subarray(0, cut))]));
  const first = await readUsageFile(file);
  assert.equal(first.record.title, undefined);
  assert.ok(first.cursor.carry);
  await appendFile(file, zstdCompressSync(event.subarray(cut)));
  const next = await readUsageFile(file, JSON.parse(JSON.stringify(first)));
  assert.equal(next.record.title, title);
  assert.deepEqual(next.record, await foldFile(file));
});

test("plain JSONL waits for LF and counts a completed tail exactly once", async (t) => {
  const file = await fixture(t, "session.jsonl");
  await writeFile(file, Buffer.concat([lines([header, route]), lines([usage(10)]).subarray(0, -1)]));
  const first = await readUsageFile(file);
  assert.equal(total(first), 0);
  await appendFile(file, Buffer.concat([Buffer.from("\n"), lines([usage(20)])]));
  const next = await readUsageFile(file, JSON.parse(JSON.stringify(first)));
  assert.equal(next.mode, "incremental");
  assert.equal(total(next), 32);
  assert.deepEqual(next.record, await foldFile(file));
});

test("truncate and same-inode regrow replace the prior contribution", async (t) => {
  const file = await fixture(t);
  const prefix = frame([header, route]);
  await writeFile(file, Buffer.concat([prefix, frame([usage(10)])]));
  const first = await readUsageFile(file);
  await writeFile(file, Buffer.concat([prefix, frame([usage(50)]), frame([usage(100)])]));
  const regrown = await readUsageFile(file, first);
  assert.equal(regrown.mode, "full");
  assert.equal(total(regrown), 152);
  await writeFile(file, prefix);
  const truncated = await readUsageFile(file, regrown);
  assert.equal(truncated.mode, "full");
  assert.equal(total(truncated), 0);
});

test("same-size overwrite is detected by exact revision metadata", async (t) => {
  const file = await fixture(t, "session.jsonl");
  await writeFile(file, lines([header, route, usage(1)]));
  const first = await readUsageFile(file);
  await writeFile(file, lines([header, route, usage(9)]));
  assert.equal((await fileStamp(file)).size, first.size);
  const next = await readUsageFile(file, first);
  assert.equal(next.mode, "full");
  assert.equal(total(next), 10);
});

test("replacement at the same path invalidates the file identity", async (t) => {
  const file = await fixture(t);
  await writeFile(file, frame([header, route, usage(10)]));
  const first = await readUsageFile(file);
  const replacement = file + ".new";
  await writeFile(replacement, frame([header, route, usage(20), usage(30)]));
  await rename(replacement, file);
  const next = await readUsageFile(file, first);
  assert.equal(next.mode, "full");
  assert.equal(total(next), 52);
});

test("a corrupt checksummed frame leaves the prior checkpoint intact", async (t) => {
  const file = await fixture(t);
  await writeFile(file, frame([header, route, usage(10)]));
  const first = await readUsageFile(file);
  const frozen = structuredClone(first);
  const valid = frame([usage(20)]);
  const broken = Buffer.from(valid);
  broken[broken.length - 1] ^= 1;
  await appendFile(file, broken);
  await assert.rejects(readUsageFile(file, first));
  assert.deepEqual(first, frozen);
  const base = (await readFile(file)).subarray(0, first.size);
  await writeFile(file, Buffer.concat([base, valid]));
  assert.equal(total(await readUsageFile(file, first)), 32);
});

test("legacy record-only cache bootstraps a cursor instead of guessing route", async (t) => {
  const file = await fixture(t);
  await writeFile(file, frame([header, route, usage(10)]));
  const first = await readUsageFile(file);
  const legacy = { size: first.size, mtimeMs: first.mtimeMs, record: first.record };
  await appendFile(file, frame([usage(20)]));
  const next = await readUsageFile(file, legacy);
  assert.equal(next.mode, "full");
  assert.equal(total(next), 32);
  assert.deepEqual(next.cursor.route, { provider: "p", model: "model/x" });
});
