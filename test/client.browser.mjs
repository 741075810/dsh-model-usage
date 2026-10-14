import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate } from "../lib/aggregate.js";

// Reuse installed React 18 and Playwright; no browser packages ship with the plugin.
const require = createRequire(join(resolve(process.env.MU_BROWSER_MODULE_BASE || "."), "package.json"));
const { chromium } = require("playwright");
const domRequire = createRequire(require.resolve("react-dom"));
const sources = {};
for (const name of ["react", "react-dom", "scheduler"]) {
  const path = (name === "scheduler" ? domRequire : require).resolve(name);
  sources[name] = await readFile(join(dirname(path), "cjs", name + ".development.js"), "utf8");
}
sources["react-dom/client"] = await readFile(join(dirname(require.resolve("react-dom")), "client.js"), "utf8");
const dayOf = (d) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
const now = new Date();
const today = dayOf(now);
const previous = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
const yesterday = dayOf(previous);
const records = [
  { id: "a", title: "Fixture A", depth: 0, buckets: {
    [`${yesterday}|p1|shared/a|chat`]: [1, 100, 10, 0, 0, 0, 110],
    [`${today}|p1|beta|chat`]: [1, 200, 20, 0, 0, 0, 220],
    [`${today}|p2|shared/a|chat`]: [1, 300, 30, 0, 0, 0, 330]
  } },
  { id: "b", title: "Fixture B", depth: 0, buckets: { [`${today}|p1|shared/a|chat`]: [1, 500, 50, 0, 0, 0, 550] } },
  { id: "sub", title: "Fixture subagent", depth: 1, buckets: { [`${today}|p1|shared/a|chat`]: [1, 50, 5, 0, 0, 0, 55] } }
];
const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><style>
body{margin:0;font:13px system-ui;color:#1f2328;background:#f7f8fa}header{padding:20px;display:flex;gap:20px;align-items:flex-end;border-bottom:1px solid #ddd}
</style><header data-conversation-tabs><span>Chat</span><span>Trace</span><span>Context</span></header><div id="root"></div></html>`;
const origin = process.env.MU_BROWSER_ORIGIN || "http://127.0.0.1:19387";
const artifacts = resolve(process.env.MU_BROWSER_ARTIFACTS || join("test", "artifacts"));
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.MU_BROWSER_CHANNEL || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const requests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  let delay = false;
  let refreshDelay = false;
  let reopenDelay = false;
  let noCache = false;
  await page.route(origin + "/__model_usage_fixture", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.route(origin + "/model-usage/api/**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const q = url.searchParams;
    if (q.get("refresh") === "1") noCache = false;
    const summary = aggregate(noCache ? [] : records, {
      from: q.get("from"), to: q.get("to"), provider: q.get("provider"), model: q.get("model"), includeSubagents: q.get("subagents") !== "0"
    });
    const status = { files: noCache ? 0 : 3, cacheReady: !noCache, mode: "manual", scanning: false,
      lastScanAt: noCache ? null : Date.now(), errors: [], progress: null };
    if (delay && q.get("provider") === "p1") await new Promise((done) => setTimeout(done, 300));
    if ((refreshDelay && q.get("refresh") === "1") || reopenDelay) await new Promise((done) => setTimeout(done, 300));
    await route.fulfill({ json: { ok: true, result: url.pathname.endsWith("/summary") ? { ...summary, status } : status } }).catch(() => {});
  });
  await page.goto(origin + "/__model_usage_fixture");
  await page.evaluate((sources) => {
    const cache = {};
    const require = (name) => {
      if (cache[name]) return cache[name].exports;
      const module = cache[name] = { exports: {} };
      new Function("require", "module", "exports", "process", sources[name])(require, module, module.exports, { env: { NODE_ENV: "development" } });
      return module.exports;
    };
    const React = require("react");
    const dom = require("react-dom/client");
    window.__ModuleLoader__ = {
      load({ factory }) {
        const plugin = factory(require);
        window.__mountUsage = () => {
          const cleanups = [];
          let dict;
          let slot;
          const ctx = {
            effect: (setup) => cleanups.push(setup()),
            locale: { register: (_, dictionaries) => { dict = dictionaries.zh; return () => {}; } },
            slots: {
              inject: (name, register) => { assertSlot(name); [...register()]; },
              register: (meta, Component) => { slot = { meta, Component }; return () => {}; }
            }
          };
          function assertSlot(name) { if (name !== "shell.overlay") throw new Error("Unexpected sidebar slot: " + name); }
          plugin.apply(ctx);
          const root = dom.createRoot(document.getElementById("root"));
          root.render(React.createElement(slot.Component, { ...slot.meta.inject(), t: (key) => dict[key] || key }));
          window.__disposeUsage = () => { root.unmount(); for (const cleanup of cleanups.reverse()) if (typeof cleanup === "function") cleanup(); };
        };
        window.__mountUsage();
      }
    };
  }, sources);
  await page.addScriptTag({ path: fileURLToPath(new URL("../lib/client.js", import.meta.url)) });
  const provider = page.getByLabel("Provider", { exact: true });
  const model = page.getByLabel("\u6a21\u578b", { exact: true });
  const from = page.getByLabel("\u5f00\u59cb\u65e5\u671f", { exact: true });
  const to = page.getByLabel("\u7ed3\u675f\u65e5\u671f", { exact: true });
  const waitTotal = async (total) => {
    await page.waitForFunction((total) => {
      const dialog = document.querySelector(".mu-panel");
      return dialog?.getAttribute("aria-busy") === "false" && document.querySelector(".mu-card")?.title === total.toLocaleString();
    }, total);
  };
  await page.locator(".mu-tab-btn").click();
  await waitTotal(1265);
  assert.equal(await model.isDisabled(), true);
  await provider.selectOption("p1");
  await waitTotal(935);
  assert.deepEqual(await model.locator("option").evaluateAll((options) => options.map((o) => o.value)), ["", "beta", "shared/a"]);
  await model.selectOption("shared/a");
  await waitTotal(715);
  await page.getByRole("button", { name: "\u4eca\u5929", exact: true }).click();
  await waitTotal(605);
  await page.getByRole("checkbox").uncheck();
  await waitTotal(550);
  await from.fill(yesterday);
  await to.fill(yesterday);
  await waitTotal(110);
  assert.equal(await page.locator(".mu-axis span").last().textContent(), yesterday);
  await to.fill(today);
  await from.fill("2020-01-01");
  await waitTotal(660);
  assert.equal(await page.locator(".mu-axis span").last().textContent(), today);
  assert.ok(await page.locator(".mu-barCol").count() <= 180);
  const chartTotal = await page.locator(".mu-barCol").evaluateAll((columns) => columns.reduce((sum, col) => sum + Number(col.title.split("\n")[0].split("  ").at(-1).replaceAll(",", "")), 0));
  assert.equal(chartTotal, 660);
  const beforeInvalid = requests.length;
  await from.fill("2099-01-01");
  await page.locator("#mu-date-error").waitFor();
  assert.equal(requests.length, beforeInvalid);
  await from.fill(today);
  await waitTotal(550);
  await provider.selectOption("p2");
  await waitTotal(330);
  assert.equal(await model.inputValue(), "");
  assert.deepEqual(await model.locator("option").evaluateAll((options) => options.map((o) => o.value)), ["", "shared/a"]);
  await page.getByRole("button", { name: "\u91cd\u7f6e\u7b5b\u9009", exact: true }).click();
  await waitTotal(1265);
  assert.equal(await provider.inputValue(), "");
  assert.equal(await model.inputValue(), "");
  assert.equal(await page.getByRole("checkbox").isChecked(), true);
  await from.fill("2099-01-01");
  await to.fill("2099-01-01");
  await waitTotal(0);
  assert.equal(await provider.isEnabled(), true);
  await from.fill("");
  await to.fill(today);
  await waitTotal(1265);
  await to.fill("");
  await from.fill(today);
  await waitTotal(1155);
  await page.getByRole("button", { name: "\u91cd\u7f6e\u7b5b\u9009", exact: true }).click();
  await waitTotal(1265);
  delay = true;
  await provider.selectOption("p1");
  await provider.selectOption("p2");
  await waitTotal(330);
  await page.waitForTimeout(400);
  await waitTotal(330);
  delay = false;
  await page.screenshot({ path: join(artifacts, "desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(artifacts, "mobile.png") });
  const overflow = await page.locator(".mu-panel").evaluate((el) => el.scrollWidth - el.clientWidth);
  assert.ok(overflow <= 1, "Modal content must stay inside the narrow viewport");
  assert.equal(await provider.isVisible(), true);
  assert.equal(await to.isVisible(), true);
  await from.fill("2020-01-01");
  await waitTotal(330);
  assert.ok(await page.locator(".mu-panel").evaluate((el) => el.scrollWidth - el.clientWidth) <= 1, "Long-range chart must also fit the narrow viewport");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".mu-layer").count(), 0);
  await page.evaluate(() => {
    const old = document.querySelector("[data-conversation-tabs]");
    const next = document.createElement("header");
    next.setAttribute("data-conversation-tabs", "");
    next.textContent = "Replacement tabs";
    old.replaceWith(next);
  });
  await page.locator(".mu-tab-btn").waitFor();
  assert.equal(await page.locator(".mu-tab-chip").count(), 1);
  await page.evaluate(() => window.__disposeUsage());
  assert.equal(await page.locator(".mu-tab-chip").count(), 0);
  await page.evaluate(() => window.__mountUsage());
  await page.locator(".mu-tab-btn").waitFor();
  assert.equal(await page.locator(".mu-tab-chip").count(), 1);
  await page.evaluate(() => {
    window.__disposeUsage();
    document.body.style.color = "#f1f1f3";
    document.body.style.background = "#171719";
    window.__mountUsage();
  });
  await page.locator(".mu-tab-btn").click();
  await waitTotal(1265);
  assert.equal(await page.locator(".mu-panel").evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(35, 35, 38)");
  assert.equal(await from.evaluate((el) => getComputedStyle(el).colorScheme), "dark");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: join(artifacts, "dark.png") });

  // Manual refresh is one action, not a sticky mode inherited by later filters/opens.
  const forced = () => requests.filter((url) => url.searchParams.get("refresh") === "1").length;
  const forcedBefore = forced();
  refreshDelay = true;
  await page.getByRole("button", { name: "\u5237\u65b0", exact: true }).click();
  assert.equal(await page.locator(".mu-card").first().getAttribute("title"), "1,265");
  await waitTotal(1265);
  assert.equal(forced(), forcedBefore + 1);
  refreshDelay = false;
  await provider.selectOption("p2");
  await waitTotal(330);
  assert.equal(forced(), forcedBefore + 1);
  await page.keyboard.press("Escape");
  reopenDelay = true;
  await page.locator(".mu-tab-btn").click();
  assert.equal(await page.locator(".mu-card").first().getAttribute("title"), "330");
  await waitTotal(330);
  reopenDelay = false;
  assert.equal(forced(), forcedBefore + 1);
  const idleRequests = requests.length;
  await page.waitForTimeout(1100);
  assert.equal(requests.length, idleRequests, "Idle dashboards must not keep polling or importing logs");
  assert.equal(await page.locator(".mu-snapshot").isVisible(), true);

  // A fresh install waits for explicit Refresh instead of importing logs on open.
  await page.evaluate(() => window.__disposeUsage());
  noCache = true;
  await page.evaluate(() => window.__mountUsage());
  await page.locator(".mu-tab-btn").click();
  await page.getByText("\u5c1a\u672a\u5efa\u7acb\u7edf\u8ba1\u7f13\u5b58\uff0c\u70b9\u51fb\u300c\u5237\u65b0\u300d\u5f00\u59cb\u7edf\u8ba1\u3002", { exact: true }).waitFor();
  assert.equal(forced(), forcedBefore + 1);
  await page.getByRole("button", { name: "\u5237\u65b0", exact: true }).click();
  await waitTotal(1265);
  assert.equal(forced(), forcedBefore + 2);
  assert.deepEqual(errors, []);
  console.log("PASS: filters, dates, layouts, tab lifecycle, snapshot reopen, one-shot refresh, idle and cold-cache behavior");
  console.log("Screenshots: " + artifacts);
} finally {
  await browser.close();
}
