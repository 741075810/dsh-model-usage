/**
 * dsh-model-usage — Client half.
 *
 * Conversation-tab entry opens a dashboard overlay (shell.overlay):
 * provider/model/date filters, summary cards, per-model table (expandable kind
 * breakdown), daily stacked bars, and top sessions by token usage.
 *
 * No build step: DSH loads this file as a client bundle via package.json
 * dsh.client.
 */
window.__ModuleLoader__.load({
  id: "dsh-model-usage",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createPortal } = require("react-dom");
    const { useState, useEffect, useMemo, useCallback, useSyncExternalStore } = React;
    const h = (type, props, ...children) => React.createElement(type, props, ...children);

    const NS = "model-usage";
    const API = "/model-usage/api";

    const zh = {
      "lang": "zh",
      "title": "模型用量",
      "sub": "{n} 个会话 · {files} 个日志 · 扫描于 {time}",
      "scanning": "正在扫描会话日志… {done}/{total}",
      "loading": "正在统计…",
      "refresh": "刷新",
      "rebuild": "重建缓存",
      "close": "关闭",
      "range.today": "今天",
      "range.7d": "近 7 天",
      "range.30d": "近 30 天",
      "range.all": "全部",
      "range.custom": "自定义",
      "filter.provider": "Provider",
      "filter.model": "模型",
      "filter.allProviders": "全部 Provider",
      "filter.allModels": "全部模型",
      "filter.from": "开始日期",
      "filter.to": "结束日期",
      "filter.reset": "重置筛选",
      "filter.invalidDates": "开始日期应早于或等于结束日期",
      "subagents": "含子代理",
      "card.total": "总 Token",
      "card.requests": "请求数",
      "card.input": "输入（未缓存）",
      "card.output": "输出",
      "card.cacheRead": "缓存命中",
      "card.hitRate": "缓存命中率",
      "col.model": "模型",
      "col.requests": "请求",
      "col.input": "输入",
      "col.output": "输出",
      "col.cacheRead": "缓存读",
      "col.cacheWrite": "缓存写",
      "col.total": "合计",
      "col.share": "占比",
      "kind.chat": "对话",
      "kind.failed": "失败重试",
      "kind.compaction": "上下文压缩",
      "detail.sessions": "{n} 个会话",
      "detail.span": "{from} ~ {to}",
      "section.models": "按模型",
      "section.daily": "每日趋势",
      "section.sessions": "用量最高的会话",
      "other": "其他",
      "empty": "当前筛选条件下没有用量记录",
      "error": "读取失败：{message}",
      "errors": "{n} 个日志读取失败",
      "untitled": "（未命名会话）",
      "subagentTag": "子代理",
      "note": "数字来自各 provider 上报的用量；输入为未命中缓存部分，合计 = 输入 + 缓存读 + 缓存写 + 输出。"
    };
    const en = {
      "lang": "en",
      "title": "Model usage",
      "sub": "{n} sessions · {files} logs · scanned {time}",
      "scanning": "Scanning session logs… {done}/{total}",
      "loading": "Aggregating…",
      "refresh": "Refresh",
      "rebuild": "Rebuild cache",
      "close": "Close",
      "range.today": "Today",
      "range.7d": "7 days",
      "range.30d": "30 days",
      "range.all": "All",
      "range.custom": "Custom",
      "filter.provider": "Provider",
      "filter.model": "Model",
      "filter.allProviders": "All providers",
      "filter.allModels": "All models",
      "filter.from": "Start date",
      "filter.to": "End date",
      "filter.reset": "Reset filters",
      "filter.invalidDates": "Start date must be on or before end date",
      "subagents": "Include subagents",
      "card.total": "Total tokens",
      "card.requests": "Requests",
      "card.input": "Input (uncached)",
      "card.output": "Output",
      "card.cacheRead": "Cache read",
      "card.hitRate": "Cache hit rate",
      "col.model": "Model",
      "col.requests": "Req",
      "col.input": "Input",
      "col.output": "Output",
      "col.cacheRead": "Cache R",
      "col.cacheWrite": "Cache W",
      "col.total": "Total",
      "col.share": "Share",
      "kind.chat": "Chat",
      "kind.failed": "Failed attempts",
      "kind.compaction": "Compaction",
      "detail.sessions": "{n} sessions",
      "detail.span": "{from} – {to}",
      "section.models": "By model",
      "section.daily": "Daily",
      "section.sessions": "Top sessions",
      "other": "Other",
      "empty": "No usage matches these filters",
      "error": "Failed to load: {message}",
      "errors": "{n} logs failed to read",
      "untitled": "(untitled)",
      "subagentTag": "subagent",
      "note": "Numbers are provider-reported usage. Input excludes cache hits; total = input + cache read + cache write + output."
    };

    const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] !== undefined ? String(vars[k]) : "{" + k + "}"));

    // Compact numbers: 万/亿 for zh, K/M/B for en. Full value goes in title.
    const compact = (n, lang) => {
      if (!Number.isFinite(n)) return "–";
      const abs = Math.abs(n);
      const fx = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
      if (lang === "zh") {
        if (abs >= 1e8) return fx(n / 1e8) + "亿";
        if (abs >= 1e4) return fx(n / 1e4) + "万";
        return String(Math.round(n));
      }
      if (abs >= 1e9) return fx(n / 1e9) + "B";
      if (abs >= 1e6) return fx(n / 1e6) + "M";
      if (abs >= 1e3) return fx(n / 1e3) + "K";
      return String(Math.round(n));
    };
    const full = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString() : "–");
    const pct = (a, b) => (b > 0 ? (a / b * 100).toFixed(1) + "%" : "–");

    const pad = (n) => String(n).padStart(2, "0");
    const dayOf = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    const rangeBounds = (range) => {
      const now = new Date();
      if (range === "all") return {};
      const back = range === "today" ? 0 : range === "7d" ? 6 : 29;
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
      return { from: dayOf(start), to: dayOf(now) };
    };
    const timeText = (ms) => {
      if (!ms) return "–";
      const d = new Date(ms);
      return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    };

    const getJson = (path, init) => fetch(API + path, { cache: "no-store", ...init }).then(async (r) => {
      const body = await r.json().catch(() => null);
      if (!body || !body.ok) throw new Error((body && body.error) || ("HTTP " + r.status));
      return body.result;
    });

    // ───────── theme ─────────
    function detectTheme() {
      try {
        const color = getComputedStyle(document.body).color || "";
        const parts = color.match(/\d+(?:\.\d+)?/g);
        if (parts && parts.length >= 3) {
          const lum = 0.2126 * Number(parts[0]) + 0.7152 * Number(parts[1]) + 0.0722 * Number(parts[2]);
          if (lum > 160) return "dark";
          if (lum < 96) return "light";
        }
        if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
      } catch { /* default below */ }
      return "light";
    }
    function useTheme() {
      const [theme, setTheme] = useState(detectTheme);
      useEffect(() => {
        const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
        const on = () => setTheme(detectTheme());
        if (mq && mq.addEventListener) { mq.addEventListener("change", on); return () => mq.removeEventListener("change", on); }
        return undefined;
      }, []);
      return theme;
    }
    const paletteFor = (theme) => theme === "dark" ? {
      layer: "rgba(0,0,0,.55)", panel: "#232326", border: "rgba(255,255,255,.14)", row: "rgba(255,255,255,.08)",
      shadow: "0 8px 28px rgba(0,0,0,.5)", text: "#f1f1f3", sub: "#a9a9b2", card: "#2c2c30", accent: "#7ab0ff",
      danger: "#f0616d", track: "rgba(255,255,255,.08)", chipOn: "#3b3d44"
    } : {
      layer: "rgba(0,0,0,.4)", panel: "#ffffff", border: "rgba(0,0,0,.12)", row: "rgba(0,0,0,.06)",
      shadow: "0 8px 28px rgba(0,0,0,.18)", text: "#1f2328", sub: "#67707c", card: "#f6f7f9", accent: "#1a6bed",
      danger: "#d92d20", track: "rgba(0,0,0,.06)", chipOn: "#e6e9ee"
    };
    const SERIES = ["#4f8cff", "#2fbf71", "#f5a524", "#e5484d", "#9b6bff", "#8a8f98"];

    const CSS = `
.mu-layer{position:fixed;inset:0;z-index:11000;display:flex;align-items:center;justify-content:center}
.mu-panel{position:relative;width:960px;max-width:95vw;max-height:88vh;overflow:auto;border-radius:8px;padding:16px 20px 14px;font-size:13px;line-height:18px;box-sizing:border-box}
.mu-head{display:flex;align-items:flex-start;gap:12px;margin-bottom:12px}
.mu-headMain{flex:1;min-width:0}
.mu-title{margin:0;font-size:16px;font-weight:600}
.mu-sub{font-size:12px;margin-top:3px}
.mu-iconBtn{width:28px;height:28px;display:flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;cursor:pointer;font-size:16px;color:inherit;padding:0}
.mu-iconBtn:hover{background:rgba(127,127,127,.18)}
.mu-controls{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.mu-chip{height:28px;padding:0 12px;border-radius:999px;border:1px solid transparent;background:transparent;cursor:pointer;font-size:12px;color:inherit}
.mu-check{display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;margin-left:6px}
.mu-spacer{flex:1}
.mu-btn{height:28px;padding:0 12px;border-radius:7px;border:1px solid transparent;background:transparent;cursor:pointer;font-size:12px;color:inherit}
.mu-btn:disabled,.mu-chip:disabled{opacity:.5;cursor:default}
.mu-filters{display:grid;grid-template-columns:minmax(120px,1fr) minmax(160px,1.5fr) minmax(130px,.9fr) minmax(130px,.9fr) auto;align-items:end;gap:8px;margin-bottom:14px}
.mu-field{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:11px}
.mu-input{width:100%;min-width:0;height:30px;box-sizing:border-box;border:1px solid;border-radius:6px;padding:4px 8px;font-family:inherit;font-size:12px}
.mu-input:focus-visible,.mu-btn:focus-visible,.mu-chip:focus-visible,.mu-tab-btn:focus-visible{outline:2px solid;outline-offset:2px}
.mu-input:disabled{opacity:.5}
.mu-reset{height:30px;white-space:nowrap}
.mu-tableWrap{max-width:100%;overflow-x:auto}
.mu-cards{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin-bottom:14px}
.mu-card{border-radius:8px;padding:9px 11px;min-width:0}
.mu-cardLabel{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mu-cardValue{font-size:18px;font-weight:600;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mu-section{margin:14px 0 6px;font-size:13px;font-weight:600}
.mu-table{width:100%;min-width:680px;border-collapse:collapse;font-variant-numeric:tabular-nums}
.mu-table th{font-size:11px;font-weight:500;text-align:right;padding:5px 6px;white-space:nowrap}
.mu-table th:first-child,.mu-table td:first-child{text-align:left}
.mu-table td{padding:6px;text-align:right;white-space:nowrap}
.mu-sortBtn{border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:0}
.mu-modelCell{display:flex;align-items:center;gap:7px;min-width:0;max-width:300px}
.mu-dot{width:8px;height:8px;border-radius:50%;flex:0 0 8px}
.mu-modelName{overflow:hidden;text-overflow:ellipsis;font-weight:500}
.mu-provider{font-size:11px}
.mu-rowBtn{cursor:pointer}
.mu-rowBtn:hover td{background:rgba(127,127,127,.07)}
.mu-share{display:flex;align-items:center;gap:6px;justify-content:flex-end}
.mu-shareBar{width:60px;height:6px;border-radius:3px;overflow:hidden}
.mu-shareFill{height:100%;border-radius:3px}
.mu-detail td{padding:2px 6px 8px;font-size:12px}
.mu-chart{display:flex;align-items:flex-end;gap:3px;height:150px;padding:6px 0 0}
.mu-barCol{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:flex-end;height:100%;position:relative}
.mu-barSeg{width:100%}
.mu-barCol:hover{opacity:.8}
.mu-axis{display:flex;justify-content:space-between;font-size:11px;margin-top:4px}
.mu-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;margin-top:6px}
.mu-legendItem{display:flex;align-items:center;gap:5px}
.mu-sessions{display:flex;flex-direction:column;gap:4px}
.mu-sessRow{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:7px}
.mu-sessMain{flex:1;min-width:0}
.mu-sessTitle{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mu-sessMeta{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mu-tag{font-size:10px;padding:0 6px;border-radius:8px;margin-left:6px;background:rgba(127,127,127,.2);font-weight:400}
.mu-sessNum{font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:500}
.mu-empty{padding:40px 0;text-align:center}
.mu-note{font-size:11px;margin-top:12px;padding-top:10px}
.mu-tab-chip{display:inline-flex;align-items:flex-end;flex:0 0 auto}
.mu-tab-btn{appearance:none;position:relative;border:0;background:transparent;cursor:pointer;padding:0 0 9px;font-family:inherit;font-size:13px;font-weight:500;line-height:16px;color:var(--dsw-alias-label-tertiary,currentColor);white-space:nowrap}
.mu-tab-btn:hover{color:var(--dsw-alias-label-primary,currentColor)}
.mu-tab-btn.on{color:var(--dsw-alias-brand-primary,#1a6bed)}
.mu-tab-btn.on:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;background:var(--dsw-alias-brand-primary,#1a6bed)}
@media (max-width:760px){.mu-cards{grid-template-columns:repeat(3,minmax(0,1fr))}.mu-filters{grid-template-columns:repeat(2,minmax(0,1fr))}.mu-reset{justify-self:start}.mu-panel{max-width:calc(100vw - 16px);max-height:94vh;padding:14px 12px}.mu-controls{row-gap:8px}.mu-legendItem{min-width:0;overflow-wrap:anywhere}}
`;
    function injectStyle() {
      if (document.getElementById("dsh-model-usage-style")) return () => {};
      const tag = document.createElement("style");
      tag.id = "dsh-model-usage-style";
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => { try { tag.remove(); } catch { /* already gone */ } };
    }

    // Overlay open state: module-level store shared by the tab-row entry and
    // the overlay rendered in shell.overlay.
    let uiOpen = false;
    const uiListeners = new Set();
    const uiStore = {
      subscribe(l) { uiListeners.add(l); return () => uiListeners.delete(l); },
      get: () => uiOpen,
      set(v) { if (uiOpen !== v) { uiOpen = v; uiListeners.forEach((l) => l()); } }
    };
    const useUiOpen = () => useSyncExternalStore(uiStore.subscribe, uiStore.get, uiStore.get);
    const openUi = () => uiStore.set(true);
    const closeUi = () => uiStore.set(false);

    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = { failed: false }; }
      static getDerivedStateFromError() { return { failed: true }; }
      componentDidCatch(error) { try { console.error("model-usage:", error); } catch { /* ignore */ } }
      render() { return this.state.failed ? null : this.props.children; }
    }

    function TabRowUsageMount({ t }) {
      const open = useUiOpen();
      const [host, setHost] = useState(null);
      useEffect(() => {
        const owned = new Set();
        const ensure = () => {
          const row = document.querySelector("[data-conversation-tabs]");
          let el = row && row.querySelector(":scope > .mu-tab-chip");
          if (row && !el) {
            el = document.createElement("div");
            el.className = "mu-tab-chip";
            row.appendChild(el);
            owned.add(el);
          }
          for (const old of owned) {
            if (old !== el && !old.isConnected) { old.remove(); owned.delete(old); }
          }
          setHost((prev) => prev === el ? prev : el);
        };
        ensure();
        const observer = new MutationObserver(ensure);
        observer.observe(document.body, { childList: true, subtree: true });
        const timer = setInterval(ensure, 1000);
        return () => {
          observer.disconnect();
          clearInterval(timer);
          owned.forEach((el) => el.remove());
        };
      }, []);
      return host ? createPortal(h("button", {
        type: "button", className: "mu-tab-btn" + (open ? " on" : ""),
        title: t("title"), "aria-haspopup": "dialog", "aria-expanded": open,
        "aria-controls": "model-usage-dialog", onClick: openUi
      }, t("title")), host) : null;
    }
    const modelKey = (m) => m.provider + "|" + m.model;

    /** Keep an even time axis; bin long ranges without dropping their tail. */
    function fillDays(days, from, to) {
      if (days.length === 0) return [];
      const dayMs = 86400000;
      const stamp = (day) => Date.parse(day + "T00:00:00Z");
      const start = stamp(from || days[0].day);
      const end = stamp(to || days[days.length - 1].day);
      const count = Math.floor((end - start) / dayMs) + 1;
      if (!Number.isFinite(count) || count <= 0) return [];
      const step = Math.max(1, Math.ceil(count / 180));
      const out = [];
      for (let i = 0; i < count; i += step) {
        out.push({
          day: new Date(start + i * dayMs).toISOString().slice(0, 10),
          endDay: new Date(start + Math.min(count - 1, i + step - 1) * dayMs).toISOString().slice(0, 10),
          total: 0, byModel: {}
        });
      }
      for (const row of days) {
        const column = out[Math.floor((stamp(row.day) - start) / (step * dayMs))];
        if (!column) continue;
        column.total += row.total;
        for (const [key, total] of Object.entries(row.byModel)) column.byModel[key] = (column.byModel[key] || 0) + total;
      }
      return out;
    }

    function useSummary(open, bounds, provider, model, subagents, reload, invalidDates) {
      const from = bounds.from || "";
      const to = bounds.to || "";
      const key = JSON.stringify([from, to, provider, model, subagents, reload.n]);
      const [state, setState] = useState({ key: null, data: null, catalog: null, error: null, loading: false, progress: null });
      useEffect(() => {
        if (!open || invalidDates) return undefined;
        let alive = true;
        const controller = new AbortController();
        const init = { signal: controller.signal };
        setState((s) => ({ ...s, key, data: null, loading: true, error: null, progress: null }));
        const qs = new URLSearchParams();
        if (from) qs.set("from", from);
        if (to) qs.set("to", to);
        if (provider) qs.set("provider", provider);
        if (model) qs.set("model", model);
        if (!subagents) qs.set("subagents", "0");
        if (reload.force) qs.set("refresh", "1");
        const poll = setInterval(() => {
          getJson("/status", init).then((s) => { if (alive) setState((p) => ({ ...p, progress: s.progress })); }).catch(() => {});
        }, 800);
        getJson("/summary?" + qs.toString(), init)
          .then((data) => { if (alive) setState({ key, data, catalog: data.catalog, error: null, loading: false, progress: null }); })
          .catch((e) => { if (alive) setState((p) => ({ ...p, error: String((e && e.message) || e), loading: false, progress: null })); })
          .finally(() => clearInterval(poll));
        return () => { alive = false; controller.abort(); clearInterval(poll); };
      }, [open, from, to, provider, model, subagents, reload, invalidDates]);
      return {
        ...state,
        data: state.key === key ? state.data : null,
        error: state.key === key ? state.error : null,
        loading: open && !invalidDates && (state.loading || state.key !== key)
      };
    }

    function Filters({ provider, model, catalog, bounds, setProvider, setModel, setDate, reset, t, pal, theme, invalidDates }) {
      const models = catalog ? catalog.models.filter((m) => m.provider === provider) : [];
      const style = { color: pal.text, background: pal.panel, borderColor: pal.border, colorScheme: theme };
      const field = (label, control) => {
        const id = "mu-" + label.replaceAll(".", "-");
        return h("div", { className: "mu-field", style: { color: pal.sub } },
          h("label", { htmlFor: id }, t(label)), React.cloneElement(control, { id }));
      };
      return h("div", { className: "mu-filters" },
        field("filter.provider", h("select", {
          className: "mu-input", style, value: provider, disabled: !catalog,
          onChange: (e) => { setProvider(e.target.value); setModel(""); }
        }, h("option", { value: "" }, t("filter.allProviders")),
        (catalog ? catalog.providers : []).map((p) => h("option", { key: p, value: p }, p)))),
        field("filter.model", h("select", {
          className: "mu-input", style, value: model, disabled: !provider || !catalog,
          onChange: (e) => setModel(e.target.value)
        }, h("option", { value: "" }, t("filter.allModels")),
        models.map((m) => h("option", { key: m.model, value: m.model }, m.model)))),
        field("filter.from", h("input", {
          type: "date", className: "mu-input", style, value: bounds.from || "", max: bounds.to || undefined,
          "aria-invalid": invalidDates, "aria-describedby": invalidDates ? "mu-date-error" : undefined,
          onChange: (e) => setDate("from", e.target.value)
        })),
        field("filter.to", h("input", {
          type: "date", className: "mu-input", style, value: bounds.to || "", min: bounds.from || undefined,
          "aria-invalid": invalidDates, "aria-describedby": invalidDates ? "mu-date-error" : undefined,
          onChange: (e) => setDate("to", e.target.value)
        })),
        h("button", { type: "button", className: "mu-btn mu-reset", style: { borderColor: pal.border }, onClick: reset }, t("filter.reset"))
      );
    }

    function Cards({ totals, t, lang, pal }) {
      const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
      const items = [
        ["card.total", compact(totals.total, lang), full(totals.total)],
        ["card.requests", full(totals.requests), full(totals.requests)],
        ["card.input", compact(totals.input, lang), full(totals.input)],
        ["card.output", compact(totals.output, lang), full(totals.output)],
        ["card.cacheRead", compact(totals.cacheRead, lang), full(totals.cacheRead)],
        ["card.hitRate", pct(totals.cacheRead, prompt), full(totals.cacheRead) + " / " + full(prompt)]
      ];
      return h("div", { className: "mu-cards" }, items.map(([label, value, tip]) =>
        h("div", { key: label, className: "mu-card", style: { background: pal.card }, title: tip },
          h("div", { className: "mu-cardLabel", style: { color: pal.sub } }, t(label)),
          h("div", { className: "mu-cardValue" }, value)
        )
      ));
    }

    const COLS = ["requests", "input", "output", "cacheRead", "cacheWrite", "total"];

    function ModelTable({ models, colors, grand, t, lang, pal }) {
      const [sort, setSort] = useState({ key: "total", desc: true });
      const [open, setOpen] = useState(() => new Set());
      const rows = useMemo(() => {
        const list = [...models];
        list.sort((a, b) => {
          const va = sort.key === "model" ? a.model : a[sort.key];
          const vb = sort.key === "model" ? b.model : b[sort.key];
          const c = va < vb ? -1 : va > vb ? 1 : 0;
          return sort.desc ? -c : c;
        });
        return list;
      }, [models, sort]);
      const toggle = (k) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
      const head = (key, label) => h("th", { key, style: { color: pal.sub }, "aria-sort": sort.key === key ? (sort.desc ? "descending" : "ascending") : "none" },
        h("button", { type: "button", className: "mu-sortBtn", onClick: () => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "model" })) },
          t(label) + (sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""))
      );
      return h("table", { className: "mu-table" },
        h("thead", null, h("tr", { style: { borderBottom: "1px solid " + pal.border } },
          head("model", "col.model"),
          ...COLS.map((c) => head(c, "col." + c)),
          h("th", { key: "share", style: { color: pal.sub } }, t("col.share"))
        )),
        h("tbody", null, rows.flatMap((m) => {
          const k = modelKey(m);
          const color = colors.get(k) || SERIES[SERIES.length - 1];
          const share = grand > 0 ? m.total / grand : 0;
          const expanded = open.has(k);
          const main = h("tr", {
            key: k, className: "mu-rowBtn", style: { borderBottom: expanded ? "none" : "1px solid " + pal.row },
            tabIndex: 0, "aria-expanded": expanded,
            onClick: () => toggle(k),
            onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(k); } }
          },
            h("td", null, h("div", { className: "mu-modelCell", title: m.provider + " / " + m.model },
              h("span", { className: "mu-dot", style: { background: color } }),
              h("span", { className: "mu-modelName" }, m.model),
              h("span", { className: "mu-provider", style: { color: pal.sub } }, m.provider)
            )),
            ...COLS.map((c) => h("td", { key: c, title: full(m[c]) }, c === "requests" ? full(m[c]) : compact(m[c], lang))),
            h("td", null, h("div", { className: "mu-share" },
              h("div", { className: "mu-shareBar", style: { background: pal.track } },
                h("div", { className: "mu-shareFill", style: { width: (share * 100).toFixed(1) + "%", background: color } })),
              h("span", null, (share * 100).toFixed(1) + "%")
            ))
          );
          if (!expanded) return [main];
          const kinds = Object.entries(m.kinds || {}).sort((a, b) => b[1].total - a[1].total);
          const detail = h("tr", { key: k + ":detail", className: "mu-detail", style: { borderBottom: "1px solid " + pal.row } },
            h("td", { style: { color: pal.sub } },
              fill(t("detail.sessions"), { n: m.sessions }) + " · " + fill(t("detail.span"), { from: m.firstDay, to: m.lastDay })),
            h("td", { colSpan: COLS.length + 1, style: { color: pal.sub, textAlign: "left" } },
              kinds.map(([kind, v]) => t("kind." + kind) + " " + full(v.requests) + " / " + compact(v.total, lang)).join("　·　"))
          );
          return [main, detail];
        }))
      );
    }

    function DailyChart({ days, colors, order, t, lang, pal }) {
      if (days.length === 0) return null;
      const max = Math.max(1, ...days.map((d) => d.total));
      const top = order.slice(0, SERIES.length - 1);
      const legend = top.map((k) => ({ k, label: k.split("|").slice(1).join("|"), color: colors.get(k) }));
      const hasOther = order.length > top.length;
      return h("div", null,
        h("div", { className: "mu-chart", role: "img", "aria-label": t("section.daily"), style: { gap: days.length > 60 ? 1 : 3 } },
          days.map((d) => {
            let rest = d.total;
            const segs = top.map((k) => {
              const v = d.byModel[k] || 0;
              rest -= v;
              return { k, v, color: colors.get(k) };
            });
            if (rest > 0) segs.push({ k: "other", v: rest, color: SERIES[SERIES.length - 1] });
            const span = d.endDay && d.endDay !== d.day ? d.day + " ~ " + d.endDay : d.day;
            const tip = span + "  " + full(d.total) + "\n" + segs.filter((s) => s.v > 0)
              .map((s) => (s.k === "other" ? t("other") : s.k.split("|").slice(1).join("|")) + ": " + compact(s.v, lang)).join("\n");
            return h("div", { key: d.day, className: "mu-barCol", title: tip, style: { background: pal.track, borderRadius: 3 } },
              h("div", { style: { height: (d.total / max * 100).toFixed(2) + "%", display: "flex", flexDirection: "column-reverse", borderRadius: 3, overflow: "hidden" } },
                segs.filter((s) => s.v > 0).map((s) => h("div", { key: s.k, className: "mu-barSeg", style: { height: (s.v / d.total * 100).toFixed(2) + "%", background: s.color } })))
            );
          })
        ),
        h("div", { className: "mu-axis", style: { color: pal.sub } },
          h("span", null, days[0].day), h("span", null, "max " + compact(max, lang)), h("span", null, days[days.length - 1].endDay || days[days.length - 1].day)),
        h("div", { className: "mu-legend", style: { color: pal.sub } },
          legend.map((l) => h("span", { key: l.k, className: "mu-legendItem" }, h("span", { className: "mu-dot", style: { background: l.color } }), l.label)),
          hasOther ? h("span", { className: "mu-legendItem" }, h("span", { className: "mu-dot", style: { background: SERIES[SERIES.length - 1] } }), t("other")) : null
        )
      );
    }

    function SessionList({ sessions, t, lang, pal }) {
      return h("div", { className: "mu-sessions" }, sessions.map((s) =>
        h("div", { key: s.id, className: "mu-sessRow", style: { border: "1px solid " + pal.row } },
          h("div", { className: "mu-sessMain" },
            h("div", { className: "mu-sessTitle", title: s.id },
              s.title || t("untitled"),
              s.depth > 0 ? h("span", { className: "mu-tag" }, t("subagentTag")) : null),
            h("div", { className: "mu-sessMeta", style: { color: pal.sub }, title: (s.models || []).join(", ") },
              [s.cwd, (s.models || []).join(", "), s.lastAt ? new Date(s.lastAt).toLocaleString() : null].filter(Boolean).join(" · "))
          ),
          h("div", { className: "mu-sessNum", title: full(s.total) }, compact(s.total, lang)),
          h("div", { style: { color: pal.sub, fontSize: 11, whiteSpace: "nowrap" } }, full(s.requests) + " req")
        )
      ));
    }

    function UsageOverlay({ useUiOpen, closeUi, t }) {
      const open = useUiOpen();
      const theme = useTheme();
      const pal = paletteFor(theme);
      const lang = t("lang") === "zh" ? "zh" : "en";
      const [range, setRange] = useState("30d");
      const [custom, setCustom] = useState(() => rangeBounds("30d"));
      const [provider, setProvider] = useState("");
      const [model, setModel] = useState("");
      const [subagents, setSubagents] = useState(true);
      const [reload, setReload] = useState({ n: 0, force: false });
      const [busy, setBusy] = useState(false);
      const [actionError, setActionError] = useState(null);
      const bounds = useMemo(() => range === "custom" ? custom : rangeBounds(range), [open, range, custom, reload.n]);
      const invalidDates = !!(bounds.from && bounds.to && bounds.from > bounds.to);
      const { data, catalog, error, loading, progress } = useSummary(open, bounds, provider, model, subagents, reload, invalidDates);
      const setDate = (key, value) => {
        setCustom({ from: bounds.from || "", to: bounds.to || "", [key]: value });
        setRange("custom");
      };
      const reset = () => {
        setProvider(""); setModel(""); setRange("30d");
        setCustom(rangeBounds("30d")); setSubagents(true); setActionError(null);
      };

      useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => { if (e.key === "Escape") closeUi(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [open]);

      const rebuild = useCallback(async () => {
        setBusy(true);
        setActionError(null);
        try {
          await getJson("/rebuild", { method: "POST" });
          setReload((r) => ({ n: r.n + 1, force: false }));
        } catch (e) { setActionError(String(e.message || e)); }
        finally { setBusy(false); }
      }, []);

      const order = useMemo(() => (data ? data.models.map(modelKey) : []), [data]);
      const colors = useMemo(() => {
        const m = new Map();
        order.forEach((k, i) => m.set(k, SERIES[Math.min(i, SERIES.length - 1)]));
        return m;
      }, [order]);
      const days = useMemo(() => (data ? fillDays(data.days, data.range.from, data.range.to) : []), [data]);

      if (!open) return null;
      const st = data && data.status;
      const chip = (key) => h("button", {
        type: "button", key, className: "mu-chip", "aria-pressed": range === key,
        style: { borderColor: pal.border, background: range === key ? pal.chipOn : "transparent", fontWeight: range === key ? 600 : 400 },
        onClick: () => {
          if (key === "custom" && range !== "custom") setCustom({ from: bounds.from || "", to: bounds.to || "" });
          setRange(key);
        }
      }, t("range." + key));

      let body;
      if (invalidDates) body = h("div", { id: "mu-date-error", className: "mu-empty", role: "alert", style: { color: pal.danger } }, t("filter.invalidDates"));
      else if (error) body = h("div", { className: "mu-empty", role: "alert", style: { color: pal.danger } }, fill(t("error"), { message: error }));
      else if (!data) body = h("div", { className: "mu-empty", style: { color: pal.sub } },
        progress ? fill(t("scanning"), progress) : t("loading"));
      else body = h("div", null,
        h(Cards, { totals: data.totals, t, lang, pal }),
        data.models.length === 0 ? h("div", { className: "mu-empty", style: { color: pal.sub } }, t("empty")) : h(React.Fragment, null,
          h("div", { className: "mu-section" }, t("section.models")),
          h("div", { className: "mu-tableWrap" }, h(ModelTable, { models: data.models, colors, grand: data.totals.total, t, lang, pal })),
          h("div", { className: "mu-section" }, t("section.daily")),
          h(DailyChart, { days, colors, order, t, lang, pal }),
          h("div", { className: "mu-section" }, t("section.sessions")),
          h(SessionList, { sessions: data.sessions, t, lang, pal }))
      );

      return h("div", {
        className: "mu-layer", style: { background: pal.layer }, role: "presentation",
        onMouseDown: (e) => { if (e.target === e.currentTarget) closeUi(); }
      },
        h("section", {
          id: "model-usage-dialog", className: "mu-panel", role: "dialog", "aria-modal": "true", "aria-label": t("title"), "aria-busy": loading || busy,
          style: { background: pal.panel, border: "1px solid " + pal.border, boxShadow: pal.shadow, color: pal.text }
        },
          h("div", { className: "mu-head" },
            h("div", { className: "mu-headMain" },
              h("h2", { className: "mu-title" }, t("title")),
              h("div", { className: "mu-sub", style: { color: pal.sub } },
                loading && progress ? fill(t("scanning"), progress)
                  : st ? fill(t("sub"), { n: data.totals.sessions, files: st.files, time: timeText(st.lastScanAt) }) : "\u00a0",
                st && st.errors && st.errors.length ? h("span", { style: { color: pal.danger, marginLeft: 8 }, title: st.errors.map((e) => e.file + ": " + e.error).join("\n") },
                  fill(t("errors"), { n: st.errors.length })) : null)
            ),
            h("button", { type: "button", className: "mu-iconBtn", "aria-label": t("close"), onClick: closeUi }, "×")
          ),
          h("div", { className: "mu-controls" },
            ["today", "7d", "30d", "all", "custom"].map(chip),
            h("label", { className: "mu-check" },
              h("input", { type: "checkbox", checked: subagents, onChange: (e) => setSubagents(e.target.checked) }),
              t("subagents")),
            h("div", { className: "mu-spacer" }),
            h("button", { type: "button", className: "mu-btn", style: { borderColor: pal.border }, disabled: loading || busy,
              onClick: () => { setActionError(null); setReload((r) => ({ n: r.n + 1, force: true })); } }, t("refresh")),
            h("button", { type: "button", className: "mu-btn", style: { borderColor: pal.border }, disabled: loading || busy, onClick: rebuild }, t("rebuild"))
          ),
          h(Filters, { provider, model, catalog, bounds, setProvider, setModel, setDate, reset, t, pal, theme, invalidDates }),
          actionError ? h("div", { role: "alert", style: { color: pal.danger, fontSize: 12, marginBottom: 8 } }, fill(t("error"), { message: actionError })) : null,
          body,
          h("div", { className: "mu-note", style: { color: pal.sub, borderTop: "1px solid " + pal.row } }, t("note"))
        )
      );
    }
    function SafeOverlay(props) {
      return h(React.Fragment, null,
        h(Boundary, null, h(TabRowUsageMount, props)),
        h(Boundary, null, h(UsageOverlay, props)));
    }

    function apply(ctx) {
      ctx.effect(() => injectStyle(), "model-usage: styles");
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "model-usage: dictionaries");

      ctx.slots.inject("shell.overlay", function* () {
        yield ctx.slots.register({
          name: "shell.overlay",
          id: "model-usage-overlay",
          locale: NS,
          inject: () => ({ useUiOpen, closeUi })
        }, SafeOverlay);
      });

      // Closing on dispose keeps HMR reloads from leaving a stale open flag.
      ctx.effect(() => () => closeUi(), "model-usage: close on dispose");
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    return module.exports;
  }
});
