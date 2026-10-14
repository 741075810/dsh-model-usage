import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, parseDay } from "../lib/aggregate.js";

const records = [
  { id: "a", title: "A", depth: 0, buckets: {
    "2026-10-10|p1|shared/a|chat": [1, 100, 10, 900, 0, 0, 1010],
    "2026-10-11|p1|other|chat": [1, 20, 2, 0, 0, 0, 22],
    "2026-10-11|p2|shared/a|chat": [1, 5000, 500, 0, 0, 0, 5500]
  } },
  { id: "b", title: "B", depth: 0, buckets: {
    "2026-10-11|p1|shared/a|chat": [2, 2000, 200, 0, 0, 0, 2200],
    "2026-10-11|p1|shared/a|failed": [1, 50, 5, 0, 0, 0, 55],
    "2026-10-12|p1|shared/a|compaction": [1, 100, 10, 0, 3, 0, 113]
  } },
  { id: "sub", depth: 1, buckets: {
    "2026-10-11|p1|shared/a|chat": [1, 1, 1, 0, 0, 0, 2],
    "2026-10-11|sub-only|m|chat": [1, 2, 1, 0, 0, 0, 3]
  } }
];

test("provider filter recomputes totals, days, models and session ranking", () => {
  const result = aggregate(records, { provider: "p1" });
  assert.deepEqual(result.filters, { provider: "p1", model: null });
  assert.equal(result.totals.total, 3402);
  assert.equal(result.totals.requests, 7);
  assert.equal(result.totals.sessions, 3);
  assert.ok(result.models.every((m) => m.provider === "p1"));
  assert.deepEqual(result.providers.map((p) => p.provider), ["p1"]);
  assert.deepEqual(result.sessions.map((s) => s.id), ["b", "a", "sub"]);
  assert.equal(result.sessions[0].total, 2368);
  assert.ok(result.sessions.every((s) => s.models.every((m) => m.startsWith("p1/"))));
  assert.equal(result.days.reduce((sum, d) => sum + d.total, 0), result.totals.total);
  assert.ok(result.days.every((d) => Object.keys(d.byModel).every((k) => k.startsWith("p1|"))));
});

test("provider and model filters isolate identical model IDs on different providers", () => {
  const result = aggregate(records, { provider: "p2", model: "shared/a" });
  assert.equal(result.totals.total, 5500);
  assert.equal(result.totals.sessions, 1);
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].provider, "p2");
  assert.deepEqual(result.sessions[0].models, ["p2/shared/a"]);
});

test("provider, model, inclusive date range and subagent filter compose", () => {
  const result = aggregate(records, {
    provider: "p1", model: "shared/a", from: "2026-10-11", to: "2026-10-11", includeSubagents: false
  });
  assert.equal(result.totals.total, 2255);
  assert.equal(result.totals.requests, 3);
  assert.equal(result.totals.sessions, 1);
  assert.equal(result.models[0].sessions, 1);
  assert.equal(result.models[0].firstDay, "2026-10-11");
  assert.equal(result.models[0].lastDay, "2026-10-11");
  assert.equal(result.models[0].kinds.failed.total, 55);
  assert.equal(result.models[0].kinds.compaction, undefined);
  assert.deepEqual(result.days[0].byModel, { "p1|shared/a": 2255 });
  assert.equal(result.sessions[0].total, 2255);
});

test("one-sided dates and model-only filters are supported", () => {
  assert.equal(aggregate(records, { provider: "p1", from: "2026-10-12" }).totals.total, 113);
  assert.equal(aggregate(records, { provider: "p1", to: "2026-10-10" }).totals.total, 1010);
  assert.equal(aggregate(records, { model: "shared/a" }).totals.total, 8880);
});

test("filter catalog remains complete, deduplicated and stable for empty results", () => {
  const all = aggregate(records);
  const none = aggregate(records, { provider: "missing", from: "2030-01-01", includeSubagents: false });
  assert.equal(none.totals.total, 0);
  assert.equal(none.totals.sessions, 0);
  assert.deepEqual(none.models, []);
  assert.deepEqual(none.days, []);
  assert.deepEqual(none.sessions, []);
  assert.deepEqual(none.catalog, all.catalog);
  assert.deepEqual(none.catalog.providers, ["p1", "p2", "sub-only"]);
  assert.equal(none.catalog.models.length, 4);
  assert.equal(aggregate(records, { provider: "p2", model: "other" }).totals.total, 0);
});

test("date validation rejects malformed and impossible dates", () => {
  for (const date of [null, "", "2026-2-01", "2026-02-29", "2026-02-30", "2026-13-01", "2026-10-00", "2026-10-11x"]) {
    assert.equal(parseDay(date), undefined);
  }
  assert.equal(parseDay("2024-02-29"), "2024-02-29");
  assert.equal(parseDay("2026-10-11"), "2026-10-11");
  assert.throws(() => aggregate(records, { from: "2026-10-12", to: "2026-10-11" }), RangeError);
});
