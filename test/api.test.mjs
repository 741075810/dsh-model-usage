import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

const time = new Date(2026, 9, 11, 12).getTime();
const connection = { requestRejection: (req) => req.headers.authorization === "fixture" ? undefined : 401 };

async function host(t, auth = connection) {
  const root = await mkdtemp(join(tmpdir(), "mu-api-"));
  const cleanups = [];
  let route;
  const ctx = {
    dshHomePath: (...parts) => join(root, ...parts),
    connection: auth,
    effect: (setup) => cleanups.push(setup()),
    webServer: { register: (entry) => { route = entry; return () => { route = null; }; } }
  };
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) if (typeof cleanup === "function") await cleanup();
    await rm(root, { recursive: true, force: true });
  });
  for (const [id, provider, model, input] of [["a", "p1", "model/a", 100], ["b", "p2", "model/a", 1000]]) {
    const dir = join(root, "sessions", "project", id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "session.jsonl"), [
      { type: "session", version: 4, id, createdAt: time, delegationDepth: 0 },
      { type: "assistant/message", time, data: {
        message: { source: { provider, model } }, usage: { inputTokens: input, outputTokens: 10 }
      } }
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  apply(ctx);
  const request = async (path, { authorized = true, method = "GET" } = {}) => {
    let status;
    let body;
    await route.handler({ url: "/model-usage/api" + path, method, headers: authorized ? { authorization: "fixture" } : {} }, {
      writeHead: (code) => { status = code; },
      end: (text) => { body = JSON.parse(text); }
    });
    return { status, body };
  };
  request.root = root;
  request.restart = async () => {
    for (const cleanup of cleanups.reverse()) if (typeof cleanup === "function") await cleanup();
    cleanups.length = 0;
    apply(ctx);
  };
  return request;
}

test("API accepts provider/model/date selectors and returns the historical catalog", async (t) => {
  const request = await host(t);
  const { status, body } = await request("/summary?refresh=1&provider=p1&model=model%2Fa&from=2026-10-11&to=2026-10-11");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.result.totals.total, 110);
  assert.equal(body.result.totals.sessions, 1);
  assert.deepEqual(body.result.filters, { provider: "p1", model: "model/a" });
  assert.deepEqual(body.result.catalog.providers, ["p1", "p2"]);
  assert.equal(body.result.sessions[0].id, "a");
  assert.equal(body.result.status.files, 2);
});

test("API returns zero usage without discarding filter options", async (t) => {
  const request = await host(t);
  const { status, body } = await request("/summary?refresh=1&provider=p1&from=2030-01-01");
  assert.equal(status, 200);
  assert.equal(body.result.totals.total, 0);
  assert.equal(body.result.catalog.models.length, 2);
});

test("API rejects invalid dates and reversed ranges before scanning", async (t) => {
  const request = await host(t);
  for (const query of ["from=bad", "from=2026-02-30", "to=2026-13-01", "from=2026-10-12&to=2026-10-11"]) {
    const { status, body } = await request("/summary?" + query);
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  }
  assert.equal((await request("/status")).body.result.lastScanAt, null);
});

test("API retains authentication for filtered queries", async (t) => {
  const request = await host(t);
  const { status, body } = await request("/summary?provider=p1", { authorized: false });
  assert.equal(status, 401);
  assert.equal(body.ok, false);
});

test("API fails closed when the connection admission service is missing", async (t) => {
  const request = await host(t, null);
  assert.equal((await request("/summary?provider=p1")).status, 503);
});

test("refresh evicts deleted sessions from a warm cache and historical filter catalog", async (t) => {
  const request = await host(t);
  const before = await request("/summary?refresh=1");
  assert.equal(before.body.result.totals.total, 1120);
  assert.equal(before.body.result.status.files, 2);

  await rm(join(request.root, "sessions", "project", "a"), { recursive: true });
  const after = await request("/summary");
  assert.equal(after.status, 200);
  assert.equal(after.body.result.totals.total, 1010);
  assert.equal(after.body.result.totals.sessions, 1);
  assert.equal(after.body.result.status.files, 1);
  assert.deepEqual(after.body.result.sessions.map((s) => s.id), ["b"]);
  assert.deepEqual(after.body.result.catalog.providers, ["p2"]);
  assert.deepEqual(after.body.result.catalog.models, [{ provider: "p2", model: "model/a" }]);
  assert.deepEqual(Object.keys(after.body.result.days[0].byModel), ["p2|model/a"]);
  const deletedProvider = await request("/summary?provider=p1");
  assert.equal(deletedProvider.body.result.totals.total, 0);
  assert.deepEqual(deletedProvider.body.result.sessions, []);
  const cachePath = join(request.root, "dsh-model-usage", "cache.json");
  const cache = JSON.parse(await readFile(cachePath, "utf8"));
  assert.deepEqual(Object.values(cache.files).map((e) => e.record.id), ["b"]);

  await rm(join(request.root, "sessions", "project", "b"), { recursive: true });
  const empty = await request("/summary");
  assert.equal(empty.body.result.totals.total, 0);
  assert.equal(empty.body.result.status.files, 0);
  assert.deepEqual(empty.body.result.models, []);
  assert.deepEqual(empty.body.result.days, []);
  assert.deepEqual(empty.body.result.sessions, []);
  assert.deepEqual(empty.body.result.catalog, { providers: [], models: [] });
  assert.deepEqual(JSON.parse(await readFile(cachePath, "utf8")).files, {});
});

test("opening a missing cache and advancing idle timers never decodes logs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const request = await host(t);
  const first = await request("/summary");
  assert.equal(first.body.result.status.cacheReady, false);
  assert.equal(first.body.result.status.scanCount, 0);
  assert.equal(first.body.result.totals.total, 0);
  t.mock.timers.tick(60000);
  await new Promise((done) => setImmediate(done));
  const status = (await request("/status")).body.result;
  assert.equal(status.scanning, false);
  assert.equal(status.lastScanAt, null);
  await assert.rejects(readFile(join(request.root, "dsh-model-usage", "cache.json")), { code: "ENOENT" });
});

test("opens and filters preserve the snapshot until an explicit incremental refresh", async (t) => {
  const request = await host(t);
  const first = (await request("/summary?refresh=1")).body.result;
  const append = JSON.stringify({ type: "assistant/message", time, data: {
    message: { source: { provider: "p1", model: "model/a" } }, usage: { inputTokens: 5, outputTokens: 1 }
  } }) + "\n";
  await appendFile(join(request.root, "sessions", "project", "a", "session.jsonl"), append);
  const cached = (await request("/summary")).body.result;
  assert.equal(cached.totals.total, 1120);
  assert.equal(cached.status.lastScanAt, first.status.lastScanAt);
  assert.equal(cached.status.scanCount, 1);
  assert.equal(cached.status.needsRefresh, true);
  assert.equal((await request("/summary?provider=p1")).body.result.totals.total, 110);
  const updated = (await request("/summary?refresh=1")).body.result;
  assert.equal(updated.totals.total, 1126);
  assert.equal(updated.status.incrementalFiles, 1);
  assert.equal(updated.status.fullFiles, 0);
  assert.equal(updated.status.scanCount, 2);
  assert.equal(updated.status.needsRefresh, false);
  assert.equal((await request("/summary?provider=p1")).body.result.status.scanCount, 2);
});

test("restart serves the persisted snapshot without decoding changed or corrupt logs", async (t) => {
  const request = await host(t);
  await request("/summary?refresh=1");
  await writeFile(join(request.root, "sessions", "project", "a", "session.jsonl"), "corrupt fixture");
  await request.restart();
  const cached = (await request("/summary")).body.result;
  assert.equal(cached.totals.total, 1120);
  assert.equal(cached.status.cacheReady, true);
  assert.equal(cached.status.scanCount, 0);
  assert.equal(cached.status.bytesRead, 0);
});

test("new sessions enter the snapshot on refresh; rebuild explicitly rereads all logs", async (t) => {
  const request = await host(t);
  await request("/summary?refresh=1");
  const directory = join(request.root, "sessions", "project", "c");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "session.jsonl"), [
    { type: "session", version: 4, id: "c", createdAt: time },
    { type: "assistant/message", time, data: { message: { source: { provider: "p3", model: "other" } }, usage: { inputTokens: 50 } } }
  ].map((e) => JSON.stringify(e) + "\n").join(""));
  assert.equal((await request("/summary")).body.result.totals.total, 1120);
  const updated = (await request("/summary?refresh=1")).body.result;
  assert.equal(updated.totals.total, 1170);
  assert.equal(updated.status.fullFiles, 1);
  const rebuilt = await request("/rebuild", { method: "POST" });
  assert.equal(rebuilt.body.result.fullFiles, 3);
  assert.equal(rebuilt.body.result.incrementalFiles, 0);
  assert.equal((await request("/summary")).body.result.totals.total, 1170);
});

test("directory read failure preserves the prior snapshot rather than deleting its usage", async (t) => {
  const request = await host(t);
  await request("/summary?refresh=1");
  const sessions = join(request.root, "sessions");
  const backup = join(request.root, "sessions-offline");
  await rename(sessions, backup);
  await writeFile(sessions, "directory-error fixture");
  const failed = await request("/summary?refresh=1");
  assert.equal(failed.status, 500);
  await rm(sessions);
  await rename(backup, sessions);
  const preserved = (await request("/summary")).body.result;
  assert.equal(preserved.totals.total, 1120);
  assert.equal(preserved.status.scanCount, 1);
  const cache = JSON.parse(await readFile(join(request.root, "dsh-model-usage", "cache.json"), "utf8"));
  assert.equal(Object.keys(cache.files).length, 2);
});
