import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, rm, truncate, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { zstdCompressSync } from "node:zlib";
import { apply } from "../lib/index.js";
import { fileStamp, listArtifacts, readUsageFile } from "../lib/scan.js";

// Isolate derived caches and log copies. The actual sessions/cache remain read-only.
const home = process.env.MU_BENCH_HOME || process.env.DSH_HOME;
assert.ok(home, "Set MU_BENCH_HOME or run inside DSH");
const temporary = await mkdtemp(join(tmpdir(), "mu-manual-benchmark-"));
const cleanups = [];
try {
  const cache = await readFile(join(home, "dsh-model-usage", "cache.json"), "utf8");
  await mkdir(join(temporary, "dsh-model-usage"));
  await writeFile(join(temporary, "dsh-model-usage", "cache.json"), cache);
  let route;
  apply({
    dshHomePath: (first, ...rest) => join(first === "sessions" ? home : temporary, first, ...rest),
    connection: { requestRejection: (req) => req.headers.authorization === "fixture" ? undefined : 401 },
    effect: (setup) => cleanups.push(setup()),
    webServer: { register: (entry) => { route = entry; return () => {}; } }
  });
  const durations = [];
  let snapshot;
  for (const query of ["", "", "?provider=gpt", "?provider=gpt", ""]) {
    let status;
    const start = performance.now();
    await route.handler({ method: "GET", url: "/model-usage/api/summary" + query, headers: { authorization: "fixture" } }, {
      writeHead: (code) => { status = code; }, end: (text) => { snapshot = JSON.parse(text).result; }
    });
    durations.push(performance.now() - start);
    assert.equal(status, 200);
    assert.equal(snapshot.status.cacheReady, true);
    assert.equal(snapshot.status.scanCount, 0);
    assert.equal(snapshot.status.bytesRead, 0);
  }

  const files = await listArtifacts(join(home, "sessions"));
  const candidates = [];
  for (const file of files) {
    if (!file.endsWith(".zstd")) continue;
    const stamp = await fileStamp(file);
    if (stamp.size <= 128 * 1048576) candidates.push({ file, ...stamp });
  }
  candidates.sort((a, b) => b.size - a.size);
  assert.ok(candidates[0]);
  const source = candidates[0];
  const copy = join(temporary, "session.v4.jsonl.zstd");
  await copyFile(source.file, copy);
  let checkpoint = await readUsageFile(copy);
  if (checkpoint.cursor.offset !== checkpoint.size) {
    await truncate(copy, checkpoint.cursor.offset);
    checkpoint = await readUsageFile(copy);
  }
  assert.equal(checkpoint.cursor.carry, "");
  await writeFile(join(temporary, "checkpoint.json"), JSON.stringify(checkpoint));
  const persisted = JSON.parse(await readFile(join(temporary, "checkpoint.json"), "utf8"));
  const appended = zstdCompressSync(Buffer.from(JSON.stringify({
    type: "assistant/message", time: Date.now(), data: {
      message: { source: { provider: "_benchmark", model: "fixture" } },
      usage: { inputTokens: 7, outputTokens: 1 }
    }
  }) + "\n"));
  await appendFile(copy, appended);
  let start = performance.now();
  const incremental = await readUsageFile(copy, persisted);
  const incrementalMs = performance.now() - start;
  assert.equal(incremental.mode, "incremental");

  const old = spawnSync("git", ["show", (process.env.MU_BENCH_BASELINE || "c96fcf8") + ":lib/scan.js"], { encoding: "utf8" });
  if (old.error) throw old.error;
  assert.equal(old.status, 0, old.stderr);
  const baseline = await import("data:text/javascript;base64," + Buffer.from(old.stdout).toString("base64"));
  start = performance.now();
  const full = await baseline.foldFile(copy);
  const fullMs = performance.now() - start;
  assert.deepEqual(incremental.record.buckets, full.buckets);
  assert.equal(incremental.record.id, full.id);

  const round = (n) => +n.toFixed(2);
  const result = {
    cachedOpens: durations.map(round), cachedOpenAverageMs: round(durations.reduce((a, b) => a + b) / durations.length),
    logsInSnapshot: snapshot.status.files, logReadsOnOpen: 0, scansOnOpen: snapshot.status.scanCount,
    sourceLogMiB: round(checkpoint.size / 1048576), fullReadBytes: incremental.size,
    appendedBytes: appended.length, incrementalReadBytesIncludingGuards: incremental.bytesRead,
    fullReadMs: round(fullMs), incrementalReadMs: round(incrementalMs),
    fullVsIncrementalUsage: "identical", actualSessionsModified: false
  };
  if (process.env.MU_BENCH_OUTPUT) {
    const output = resolve(process.env.MU_BENCH_OUTPUT);
    await mkdir(resolve(output, ".."), { recursive: true });
    await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  for (const cleanup of cleanups.reverse()) if (typeof cleanup === "function") await cleanup();
  await rm(temporary, { recursive: true, force: true });
}
