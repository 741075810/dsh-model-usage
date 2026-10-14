import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
    for (const cleanup of cleanups.reverse()) if (typeof cleanup === "function") cleanup();
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
  return request;
}

test("API accepts provider/model/date selectors and returns the historical catalog", async (t) => {
  const request = await host(t);
  const { status, body } = await request("/summary?provider=p1&model=model%2Fa&from=2026-10-11&to=2026-10-11");
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
  const { status, body } = await request("/summary?provider=p1&from=2030-01-01");
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
  const before = await request("/summary");
  assert.equal(before.body.result.totals.total, 1120);
  assert.equal(before.body.result.status.files, 2);

  await rm(join(request.root, "sessions", "project", "a"), { recursive: true });
  const after = await request("/summary?refresh=1");
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
  const empty = await request("/summary?refresh=1");
  assert.equal(empty.body.result.totals.total, 0);
  assert.equal(empty.body.result.status.files, 0);
  assert.deepEqual(empty.body.result.models, []);
  assert.deepEqual(empty.body.result.days, []);
  assert.deepEqual(empty.body.result.sessions, []);
  assert.deepEqual(empty.body.result.catalog, { providers: [], models: [] });
  assert.deepEqual(JSON.parse(await readFile(cachePath, "utf8")).files, {});
});
