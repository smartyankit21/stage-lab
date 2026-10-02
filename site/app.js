/* Stage Lab - personal market analytics. Reads the engine's JSON files from ./data */
"use strict";

const STAGE_NAMES = { 1: "Stage 1: base", 2: "Stage 2: advancing", 3: "Stage 3: topping", 4: "Stage 4: declining" };
const STAGE_SHORT = { 1: "Base", 2: "Advancing", 3: "Topping", 4: "Declining" };
const RULE_LABELS = {
  "rule_c>10w": "Price above 50-day average",
  "rule_c>30w": "Price above 150-day average",
  "rule_c>40w": "Price above 200-day average",
  "rule_30w>=40w": "150-day average above 200-day",
  "rule_40w rising": "200-day average rising for a month",
  "rule_off_low": "At least 15% above 52-week low",
  "rule_near_high": "Within 25% of 52-week high",
  "rule_rs": "Relative strength floor met",
};

const cache = {};
let SPARKS = {};
const off = (c) => ({ ...c, hidden: true });
const $ = (sel, el = document) => el.querySelector(sel);
const view = () => $("#view");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function load(name) {
  if (!cache[name]) {
    cache[name] = fetch(`data/${name}`).then((r) => {
      if (!r.ok) throw new Error(`${name}: ${r.status}`);
      return r.json();
    });
  }
  return cache[name];
}

/* ---------- preferences ---------- */
const prefs = {
  get rs() { try { return localStorage.getItem("rsPeriod") || "rs12"; } catch { return "rs12"; } },
  set rs(v) { try { localStorage.setItem("rsPeriod", v); } catch { /* private mode */ } },
};
const rsLabel = () => (prefs.rs === "rs3" ? "RS 3M" : "RS 12M");

/* ---------- formatting ---------- */
const fmt = {
  px: (v) => (v == null ? "–" : v >= 1000 ? v.toLocaleString("en-IN", { maximumFractionDigits: 0 }) : v.toLocaleString("en-IN", { maximumFractionDigits: 2 })),
  pct: (v) => (v == null ? "–" : `<span class="${v >= 0 ? "up" : "down"}">${v >= 0 ? "+" : ""}${v.toFixed(2)}%</span>`),
  int: (v) => (v == null ? "–" : Math.round(v).toLocaleString("en-IN")),
  chg: (v) => (v == null || v === 0 ? (v === 0 ? "0" : "–") : `<span class="${v > 0 ? "up" : "down"}">${v > 0 ? "+" : ""}${Math.round(v)}</span>`),
  cr: (v) => (v == null ? "–" : v >= 1e5 ? `${(v / 1e5).toFixed(2)} L Cr` : `${Math.round(v).toLocaleString("en-IN")} Cr`),
  rs: (v) => (v == null ? "–" : `<span class="rsbar">${Math.round(v)}<i><b style="width:${v}%"></b></i></span>`),
  stage: (s, cand) => {
    if (s == null) return "–";
    const b = `<span class="badge st${s}" title="${STAGE_NAMES[s]}">S${s}</span>`;
    return cand ? `${b} <span class="badge cand" title="Close to qualifying for Stage 2">S2*</span>` : b;
  },
  date: (d) => (d ? new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "–"),
};
const sym = (key) => key.split(":")[1];
/* "ACE MEN ENGG WORKS LIMITED" -> "Ace Men Engg Works" */
function nice(name, key) {
  if (!name) return key ? sym(key) : "";
  let n = String(name).trim().replace(/\s+(L|LI|LIM|LIMI|LIMIT|LIMITE|LIMITED|LTD\.?|LT)$/i, "").replace(/\s+/g, " ");
  if (n !== n.toUpperCase()) return n.replace(/\s+(Limited|Ltd\.?)$/i, "");
  return n.toLowerCase().replace(/(^|[\s(&\-/.])([a-z])/g, (m, p, c) => p + c.toUpperCase())
    .replace(/\b([B-DF-HJ-NP-TV-Z]{2,4})\b/gi, (w) => (/[aeiou]/i.test(w) ? w : w.toUpperCase()));
}
const stockLink = (s) => `#/stock/${encodeURIComponent(s.file)}`;

/* ---------- sortable, filterable table ---------- */
/* Sortable table. Columns with hidden:true start hidden; the Columns menu lets you pick, remembered per table `id`. */
function stockTable(el, rows, cols, { sort = prefs.rs, dir = -1, pageSize = 100, id = null } = {}) {
  let shown = pageSize;
  const storeKey = id ? `cols:${id}` : null;
  let visible;
  try { visible = storeKey && JSON.parse(localStorage.getItem(storeKey) || "null"); } catch { visible = null; }
  if (!Array.isArray(visible)) visible = cols.filter((c) => !c.hidden).map((c) => c.key);
  const save = () => { try { if (storeKey) localStorage.setItem(storeKey, JSON.stringify(visible)); } catch { /* private mode */ } };
  const draw = () => {
    const show = cols.filter((c) => c.fixed || visible.includes(c.key));
    const c = cols.find((x) => x.key === sort);
    const val = c?.sortVal || ((r) => r[sort]);
    const sorted = [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null) return 1;
      if (y == null) return -1;
      return (x > y ? 1 : x < y ? -1 : 0) * dir;
    });
    const head = show.map((c) => `<th scope="col" class="${c.num ? "num" : ""}${c.nosort ? " nosort" : ""}" data-k="${c.key}" ${c.nosort ? "" : `tabindex="0" aria-sort="${c.key === sort ? (dir > 0 ? "ascending" : "descending") : "none"}"`}>${c.label}</th>`).join("");
    const body = sorted.slice(0, shown).map((r) => `<tr data-href="${r._href || stockLink(r)}">${show
      .map((c) => `<td class="${c.num ? "num" : ""} ${c.cls || ""}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join("")}</tr>`).join("");
    const chooser = id ? `<details class="colmenu"><summary>Columns</summary><div class="colmenu-pop">${cols.filter((c) => !c.fixed)
      .map((c) => `<label><input type="checkbox" data-col="${c.key}" ${visible.includes(c.key) ? "checked" : ""}> ${c.label}</label>`).join("")}</div></details>` : "";
    el.innerHTML = `<div class="table-top"><p class="rowcount">${rows.length.toLocaleString("en-IN")} ${rows.length === 1 ? "row" : "rows"}</p>${chooser}</div>
      <div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body ||
      `<tr><td colspan="${show.length}" class="empty">No stocks match these filters. Loosen a filter to see more.</td></tr>`}</tbody></table></div>
      ${sorted.length > shown ? `<button class="more">Show ${Math.min(pageSize, sorted.length - shown)} more</button>` : ""}`;
    el.querySelectorAll("th:not(.nosort)").forEach((th) => {
      const go = () => { const k = th.dataset.k; dir = k === sort ? -dir : (cols.find((c) => c.key === k).num ? -1 : 1); sort = k; draw(); };
      th.onclick = go;
      th.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
    });
    el.querySelectorAll("tbody tr[data-href]").forEach((tr) => { tr.onclick = () => (location.hash = tr.dataset.href); });
    el.querySelectorAll("[data-col]").forEach((cb) => (cb.onchange = () => {
      visible = cols.filter((c) => (c.key === cb.dataset.col ? cb.checked : visible.includes(c.key))).map((c) => c.key);
      save(); const open = true; draw(); if (open) $(".colmenu", el)?.setAttribute("open", "");
    }));
    const more = $(".more", el);
    if (more) more.onclick = () => { shown += pageSize; draw(); };
  };
  draw();
}

const COL = {
  name: { key: "name", label: "Company", cls: "name", fixed: true, render: (r) => `<b>${esc(sym(r.key))}</b> <span class="muted">${esc(nice(r.name, r.key))}</span>`, sortVal: (r) => sym(r.key) },
  spark: { key: "_spark", label: "3 months", nosort: true, cls: "sparkcell", render: (r) => sparkSVG(SPARKS[r.key]) },
  sector: { key: "sector", label: "Sector", render: (r) => esc(r.sector) },
  stage: { key: "stage", label: "Stage", render: (r) => fmt.stage(r.stage, r.candidate) },
  close: { key: "close", label: "Price", num: true, render: (r) => fmt.px(r.close) },
  chg: { key: "chg_pct", label: "Day", num: true, render: (r) => fmt.pct(r.chg_pct) },
  rs: () => ({ key: prefs.rs, label: rsLabel(), num: true, render: (r) => fmt.rs(r[prefs.rs]) }),
  rsd7: { key: "rs12_d7", label: "RS 1W", num: true, render: (r) => fmt.chg(r.rs12_d7) },
  rsd30: { key: "rs12_d30", label: "RS 1M", num: true, render: (r) => fmt.chg(r.rs12_d30) },
  days: { key: "days_in_s2", label: "Days in S2", num: true, render: (r) => (r.stage === 2 ? fmt.int(r.days_in_s2) : "–") },
  fromEntry: { key: "_fromEntry", label: "Since entry", num: true, render: (r) => (r._fromEntry == null ? "–" : fmt.pct(r._fromEntry)) },
  offHigh: { key: "_offHigh", label: "From 52w high", num: true, render: (r) => (r._offHigh == null ? "–" : fmt.pct(r._offHigh)) },
  industry: { key: "industry", label: "Industry", render: (r) => esc(r.industry) },
  mcap: { key: "mcap_cr", label: "Market cap", num: true, render: (r) => fmt.cr(r.mcap_cr) },
  turnover: { key: "turnover_cr", label: "Turnover", num: true, render: (r) => fmt.cr(r.turnover_cr) },
};

function enrich(stocks) {
  for (const s of stocks) {
    s._fromEntry = s.stage === 2 && s.s2_entry_price ? (s.close / s.s2_entry_price - 1) * 100 : null;
    s._offHigh = s.h52 ? (s.close / s.h52 - 1) * 100 : null;
  }
  return stocks;
}

/* Filter bar shared by stock lists. Returns a function that filters rows. */
function filterBar(el, stocks, onChange, { rsMin = 0 } = {}) {
  const inds = [...new Set(stocks.map((s) => s.industry))].sort();
  const caps = ["Large Cap", "Mid Cap", "Small Cap", "Unknown"];
  el.innerHTML = `<div class="toolbar">
    <label>Search<input type="search" id="fq" placeholder="Name or symbol"></label>
    <label>Industry<select id="fi"><option value="">All industries</option>${inds.map((i) => `<option>${esc(i)}</option>`).join("")}</select></label>
    <label>Size<select id="fc"><option value="">All sizes</option>${caps.map((c) => `<option>${c}</option>`).join("")}</select></label>
    <label>Exchange<select id="fx"><option value="">NSE and BSE</option><option>NSE</option><option>BSE</option></select></label>
    <label>${rsLabel()} from<input type="number" id="fmin" min="1" max="100" value="${rsMin}"></label>
    <label>to<input type="number" id="fmax" min="1" max="100" value="100"></label>
  </div>`;
  const get = () => {
    const q = $("#fq", el).value.trim().toLowerCase(), ind = $("#fi", el).value, cap = $("#fc", el).value, ex = $("#fx", el).value;
    const lo = +$("#fmin", el).value || 0, hi = +$("#fmax", el).value || 100;
    return (r) => (!q || (r.name || "").toLowerCase().includes(q) || r.key.toLowerCase().includes(q))
      && (!ind || r.industry === ind) && (!cap || r.mcap_cat === cap) && (!ex || r.exchange === ex)
      && (r[prefs.rs] ?? 0) >= lo && (r[prefs.rs] ?? 0) <= hi;
  };
  el.querySelectorAll("input,select").forEach((i) => i.addEventListener("input", () => onChange(get())));
  return get();
}

/* ---------- pages ---------- */
/* ---------- small building blocks ---------- */
function sparkSVG(vals, w = 76, h = 22) {
  const v = (vals || []).filter((x) => x != null);
  if (v.length < 2) return `<span class="spark"></span>`;
  const pts = v.map((y, i) => `${((i / (v.length - 1)) * w).toFixed(1)},${(h - 2 - (y / 100) * (h - 4)).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"/></svg>`;
}
function addRanges(el, charts, dates, initial = "1Y") {
  charts = Array.isArray(charts) ? charts : [charts];
  const spans = { "1M": 21, "3M": 63, "6M": 126, "1Y": 252 };
  el.innerHTML = Object.keys(spans).map((k) => `<button type="button" data-r="${k}" aria-pressed="${k === initial}">${k}</button>`).join("");
  const set = (k) => {
    const last = dates.length - 1, n = Math.min(spans[k], last);
    charts.forEach((c) => c.timeScale().setVisibleLogicalRange({ from: last - n, to: last + 3 }));
    el.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.r === k));
  };
  el.querySelectorAll("button").forEach((b) => (b.onclick = () => set(b.dataset.r)));
  set(initial);
}
const skeleton = () => `<div class="sk" style="height:14px;width:180px;margin-bottom:14px"></div>
  <div class="sk" style="height:34px;width:min(560px,90%);margin-bottom:24px"></div>
  <div class="sk" style="height:10px;width:100%;margin-bottom:40px"></div>
  ${Array.from({ length: 6 }, () => `<div class="sk" style="height:14px;width:100%;margin:14px 0"></div>`).join("")}`;

/* ---------- overview ---------- */
async function pageHome() {
  const [sum, stocks, sectors, breadth, hist, sparks] = await Promise.all([
    load("summary.json"), load("stocks.json"), load(`groups_sector_${prefs.rs === "rs3" ? "3m" : "12m"}.json`),
    load("breadth.json").catch(() => null), load("stage_history.json"), load("sparks.json").catch(() => ({}))]);
  const byKey = Object.fromEntries(stocks.map((s) => [s.key, s]));
  const total = Object.values(sum.stage_counts).reduce((a, b) => a + b, 0);
  const n2 = sum.stage_counts[2] || 0;
  const B = breadth?.all?.latest;
  const day = new Date(sum.date + "T00:00:00").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const row = (k, right) => {
    const key = k.key || k, s = byKey[key] || { key, file: key.replace(":", "_") };
    return `<li><a class="row" href="${stockLink(s)}"><span class="who"><b>${esc(sym(key))}</b><span>${esc(nice(s.name, key))}</span></span>
      ${sparkSVG(sparks[key])}<span class="val">${right(s, k)}</span></a></li>`;
  };
  const list = (keys, right, n = 8) => (keys.length ? `<ul class="rows">${keys.slice(0, n).map((k) => row(k, right)).join("")}</ul>` : `<ul class="rows"><li class="empty">None today.</li></ul>`);
  const rsVal = (s) => (s[prefs.rs] == null ? "–" : `${Math.round(s[prefs.rs])}<small>RS</small>`);
  const chg = (s, k) => `${fmt.chg(k.change)}<small>to ${Math.round(s.rs12 ?? 0)}</small>`;
  const stageOf = (s) => (s.stage ? `<span class="badge st${s.stage}">S${s.stage}</span>` : "–");
  const topSec = sectors.slice(0, 8);
  view().innerHTML = `
    <p class="dateline">Close of ${day}</p>
    <h1 class="hero">${B ? `The market is ${B.label.toLowerCase()}. ` : ""}${n2.toLocaleString("en-IN")} stocks are in Stage 2, ${Math.round((n2 / total) * 100)}% of the ${total.toLocaleString("en-IN")} tracked.</h1>
    <div class="stagebar" role="img" aria-label="Stocks by stage">${[1, 2, 3, 4].map((n) => `<span class="st${n}" style="flex:${sum.stage_counts[n] || 0}"></span>`).join("")}</div>
    <div class="stagelegend">${[[1, "Base"], [2, "Advancing"], [3, "Topping"], [4, "Declining"]].map(([n, l]) => `<a href="#/stages/${n}"><i class="st${n}"></i>${l} <b>${(sum.stage_counts[n] || 0).toLocaleString("en-IN")}</b><span>${Math.round(((sum.stage_counts[n] || 0) / total) * 100)}%</span></a>`).join("")}</div>
    <div class="figures">
      ${B ? `<div><div class="lbl">Health score</div><div class="val">${B.score}</div><div class="sub">${B.label}, out of 100</div></div>
      <div><div class="lbl">Rising and falling</div><div class="val"><span class="up">${B.adv.toLocaleString("en-IN")}</span> / <span class="down">${B.dec.toLocaleString("en-IN")}</span></div><div class="sub">A/D ratio ${B.ad_ratio ?? "–"}</div></div>
      <div><div class="lbl">52-week highs and lows</div><div class="val">${B.nh} / ${B.nl}</div><div class="sub">Net ${B.net_highs > 0 ? "+" : ""}${B.net_highs}</div></div>` : ""}
      <div><div class="lbl">Close to Stage 2</div><div class="val">${sum.candidates.toLocaleString("en-IN")}</div><div class="sub"><a href="#/stages/c">See candidates</a></div></div>
    </div>
    <div class="cols">
      <section class="section"><div class="section-head"><h2>Entered Stage 2 <span class="count">${sum.entered_stage2.length} today</span></h2><a href="#/stages/2">All Stage 2</a></div>
        ${list(sum.entered_stage2, rsVal)}</section>
      <section class="section"><div class="section-head"><h2>Left Stage 2 <span class="count">${sum.exited_stage2.length} today</span></h2></div>
        ${list(sum.exited_stage2, stageOf)}</section>
      <section class="section"><div class="section-head"><h2>Biggest RS gains <span class="count">this week</span></h2><a href="#/rs">RS screen</a></div>
        ${list(sum.rs_gainers_week, chg)}</section>
      <section class="section"><div class="section-head"><h2>Biggest RS drops <span class="count">this week</span></h2></div>
        ${list(sum.rs_losers_week, chg)}</section>
    </div>
    <section class="section"><div class="chart-head"><h2>Stocks in Stage 2</h2><div class="ranges" id="rng"></div></div>
      <div class="chart mid" id="c-s2"></div></section>
    <section class="section"><div class="section-head"><h2>Strongest sectors <span class="count">by average ${rsLabel()}</span></h2><a href="#/industries">All industries</a></div>
      ${topSec.length ? `<ul class="rows">${topSec.map((g) => `<li><a class="barrow" href="${groupLink("sector", g.name)}"><span>${esc(g.name)}</span>
        <span class="track"><b style="width:${g.avg_rs}%"></b></span><span class="val" style="text-align:right">${g.avg_rs.toFixed(0)}</span></a></li>`).join("")}</ul>`
        : `<p class="empty">Industry data hasn't loaded yet. Run the engine with <code>--classify</code>.</p>`}
    </section>`;
  const all = Object.entries(hist).map(([d, v]) => [d, v["2"] || 0, Object.values(v).reduce((a, b) => a + b, 0)]);
  const full = Math.max(...all.map((p) => p[2]));
  const pts = all.filter((p) => p[2] >= 0.9 * full);
  const S = { d: pts.map((p) => p[0]), n: pts.map((p) => p[1]) };
  const chart = tsChart($("#c-s2"), S, [{ key: "n", label: "In Stage 2", color: cssVar("--s2") }], { fmt: (v) => Math.round(v).toLocaleString("en-IN") });
  if (chart) addRanges($("#rng"), chart, S.d, "1Y");
}

async function pageStages(stage) {
  const stocks = enrich(await load("stocks.json"));
  const tab = stage === "c" ? "c" : +stage || 2;
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, c: 0 };
  stocks.forEach((s) => { if (s.stage) counts[s.stage]++; if (s.candidate) counts.c++; });
  const pick = tab === "c" ? (s) => s.candidate : (s) => s.stage === tab;
  const base = stocks.filter(pick);
  const intro = {
    2: "Stocks in an established uptrend: above their 50, 150 and 200-day averages, with the long average rising and price near its high.",
    c: "Stocks that meet most Stage 2 rules but not all yet, often a pullback inside an uptrend.",
    1: "Stocks moving sideways after a decline, building a base.",
    3: "Stocks whose uptrend is losing steam; price is choppy around the long averages.",
    4: "Stocks in a downtrend, below falling long averages.",
  }[tab];
  view().innerHTML = `<h1>${tab === "c" ? "Stage 2 candidates" : STAGE_NAMES[tab]}</h1><p class="muted">${intro}</p>
    <nav class="tabs">${[2, "c", 1, 3, 4].map((t) => `<a href="#/stages/${t}" class="${t === tab ? "on" : ""}">${t === "c" ? "Candidates" : `Stage ${t}`}<span class="count">${counts[t]}</span></a>`).join("")}</nav>
    <div id="filters"></div><div id="tbl"></div>`;
  const cols = tab === 2
    ? [COL.name, COL.spark, COL.close, COL.chg, COL.rs(), COL.days, COL.fromEntry, COL.offHigh, off(COL.rsd7), off(COL.rsd30), off(COL.sector), off(COL.industry), off(COL.mcap), off(COL.turnover)]
    : [COL.name, COL.spark, COL.stage, COL.close, COL.chg, COL.rs(), COL.rsd30, COL.offHigh, off(COL.rsd7), off(COL.sector), off(COL.industry), off(COL.mcap), off(COL.turnover)];
  const render = (f) => stockTable($("#tbl"), base.filter(f), cols, { sort: prefs.rs, dir: -1, id: tab === 2 ? "stage2" : "stages" });
  render(filterBar($("#filters"), base, render));
}

async function pageRS() {
  const stocks = enrich(await load("stocks.json"));
  view().innerHTML = `<h1>Relative strength screen</h1>
    <p class="muted">Every stock ranked 1–100 by how its price has performed against all others. 90 means it beat 90% of the market.
    ${prefs.rs === "rs3" ? "Using the 3-month rating, which reacts faster." : "Using the 12-month rating; switch to 3 months in the sidebar for a faster read."}</p>
    <div class="toolbar"><label><span><input type="checkbox" id="only2"> Stage 2 only</span></label></div>
    <div id="filters"></div><div id="tbl"></div>`;
  let f = () => true;
  const cols = [COL.name, COL.spark, COL.stage, COL.close, COL.chg, COL.rs(), COL.rsd7, COL.rsd30, off(COL.offHigh), off(COL.sector), off(COL.industry), off(COL.mcap), off(COL.turnover)];
  const render = () => stockTable($("#tbl"), stocks.filter((s) => f(s) && (!$("#only2").checked || s.stage === 2)), cols, { id: "rs" });
  f = filterBar($("#filters"), stocks, (nf) => { f = nf; render(); }, { rsMin: 81 });
  $("#only2").onchange = render;
  render();
}

const LEVELS = { sector: "Sectors", industry: "Industries", basic_industry: "Sub-industries" };
const LEVEL_ONE = { sector: "sector", industry: "industry", basic_industry: "sub-industry" };
const groupLink = (level, name) => `#/group/${level}/${encodeURIComponent(name)}`;

async function pageIndustries(params) {
  const level = params.get("level") || "sector";
  const per = prefs.rs === "rs3" ? "3m" : "12m";
  const [groups, rot] = await Promise.all([load(`groups_${level}_${per}.json`), load("rrg.json").catch(() => null)]);
  const rows = groups.filter((g) => g.name !== "Unclassified").map((g) => ({ ...g, key: g.name, _href: groupLink(level, g.name) }));
  const pts = rot?.levels?.[level] || [];
  view().innerHTML = `<h1>Industries ranked by strength</h1>
    <p class="muted">Each group's rank is the average ${rsLabel()} of its stocks. Select a group to see its stocks.</p>
    <nav class="tabs">${Object.entries(LEVELS).map(([k, v]) => `<a href="#/industries?level=${k}" class="${k === level ? "on" : ""}">${v}</a>`).join("")}</nav>
    ${pts.length ? `<section class="panel" style="margin-top:20px"><h2>Rotation <small>against ${rot.benchmark === "Nifty 500" ? "the Nifty 500" : "all tracked stocks"}, weekly</small></h2>
      <div class="toolbar" style="margin-top:0">
        <label>Show<select id="rq"><option value="">All quadrants</option><option>Leading</option><option>Improving</option><option>Weakening</option><option>Lagging</option><option value="moved">Changed quadrant this week</option></select></label>
        <label>Highlight<select id="rh"><option value="">None</option>${pts.map((p) => p.name).sort().map((n) => `<option>${esc(n)}</option>`).join("")}</select></label>
        <label><span><input type="checkbox" id="rt" checked> Five-week trails</span></label>
      </div>
      <div id="rrg" class="rrg"></div>
      <p class="muted small">Right of centre: doing better than the market over the last quarter. Above centre: that edge is growing. Groups tend to move clockwise, from Improving to Leading to Weakening to Lagging. This week's point uses prices so far this week.</p>
    </section>` : ""}
    <div class="toolbar"><label>Search<input type="search" id="gq" value="${esc(params.get("q") || "")}" placeholder="Group name"></label></div><div id="tbl"></div>`;
  if (!rows.length) {
    $("#tbl").innerHTML = `<div class="notice">Industry data hasn't loaded yet. Run the engine with <code>--classify</code> to fetch it.</div>`;
    return;
  }
  const quad = Object.fromEntries(pts.map((p) => [p.name, p.quadrant]));
  const cols = [
    { key: "rank", label: "Rank", num: true },
    { key: "name", label: "Group", render: (r) => esc(r.name) },
    { key: "avg_rs", label: "Avg RS", num: true, render: (r) => fmt.rs(r.avg_rs) },
    { key: "median_rs", label: "Median RS", num: true, render: (r) => fmt.int(r.median_rs) },
    { key: "stage2_pct", label: "% in Stage 2", num: true, render: (r) => `${r.stage2_pct.toFixed(0)}%` },
    { key: "rs_change_wow", label: "RS 1W", num: true, render: (r) => fmt.chg(r.rs_change_wow) },
    { key: "rs_change_5w", label: "RS 5W", num: true, render: (r) => fmt.chg(r.rs_change_5w) },
    { key: "_quad", label: "Rotation", render: (r) => (quad[r.name] ? `<span class="q q-${quad[r.name].toLowerCase()}">${quad[r.name]}</span>` : "–"), sortVal: (r) => quad[r.name] || "" },
    { key: "total_stocks", label: "Stocks", num: true },
  ];
  const render = () => { const q = $("#gq").value.toLowerCase(); stockTable($("#tbl"), rows.filter((r) => r.name.toLowerCase().includes(q)), cols, { sort: "rank", dir: 1 }); };
  $("#gq").oninput = render;
  render();
  if (pts.length) {
    const draw = () => drawRRG($("#rrg"), pts, { quadrant: $("#rq").value, highlight: $("#rh").value, trails: $("#rt").checked, level });
    ["rq", "rh", "rt"].forEach((id) => ($("#" + id).onchange = draw));
    draw();
    const ro = new ResizeObserver(() => ($("#rrg") ? draw() : ro.disconnect()));
    ro.observe($("#rrg"));
  }
}

const QUAD_COLOR = { Leading: "--up", Weakening: "--s3", Lagging: "--down", Improving: "--c1" };
function drawRRG(el, pts, { quadrant = "", highlight = "", trails = true, level }) {
  const W = el.clientWidth, H = Math.max(360, Math.min(560, W * 0.62)), pad = 36;
  const shown = pts.filter((p) => !quadrant || (quadrant === "moved" ? p.quadrant !== p.prev_quadrant : p.quadrant === quadrant));
  const all = (highlight ? pts.filter((p) => p.name === highlight) : shown).flatMap((p) => p.trail);
  const span = (k) => Math.max(2, ...all.map((v) => Math.abs(v[k] - 100))) * 1.12;
  const sx = span(0), sy = span(1);
  const X = (v) => pad + ((v - (100 - sx)) / (2 * sx)) * (W - 2 * pad);
  const Y = (v) => H - pad - ((v - (100 - sy)) / (2 * sy)) * (H - 2 * pad);
  const cx = X(100), cy = Y(100);
  const col = (q) => `var(${QUAD_COLOR[q]})`;
  const list = highlight ? shown.filter((p) => p.name === highlight).concat(shown.filter((p) => p.name !== highlight)) : shown;
  const marks = list.slice().reverse().map((p) => {
    const dim = highlight && p.name !== highlight;
    const [hx, hy] = p.trail.at(-1);
    const path = p.trail.map(([a, b]) => `${X(a).toFixed(1)},${Y(b).toFixed(1)}`).join(" ");
    return `<g class="rrg-g${dim ? " dim" : ""}" data-name="${esc(p.name)}">
      ${trails || p.name === highlight ? `<polyline points="${path}" fill="none" stroke="${col(p.quadrant)}" stroke-width="${p.name === highlight ? 2.5 : 1.5}" stroke-opacity="${p.name === highlight ? 0.9 : 0.28}" class="trail"/>
        ${p.trail.slice(0, -1).map(([a, b]) => `<circle cx="${X(a)}" cy="${Y(b)}" r="2.5" fill="${col(p.quadrant)}" fill-opacity="${p.name === highlight ? 0.9 : 0.3}" class="trail"/>`).join("")}` : ""}
      <circle cx="${X(hx)}" cy="${Y(hy)}" r="${p.name === highlight ? 8 : 6}" fill="${col(p.quadrant)}" stroke="var(--surface)" stroke-width="2"/>
      ${p.name === highlight ? `<text x="${X(hx) + 11}" y="${Y(hy) + 4}" class="rrg-lbl">${esc(p.name)}</text>` : ""}
      <circle cx="${X(hx)}" cy="${Y(hy)}" r="14" fill="transparent" class="hit"/>
    </g>`;
  }).join("");
  el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Rotation chart of ${shown.length} groups">
    <rect x="${cx}" y="${pad}" width="${W - pad - cx}" height="${cy - pad}" class="qbg" />
    <rect x="${pad}" y="${cy}" width="${cx - pad}" height="${H - pad - cy}" class="qbg" />
    <line x1="${pad}" x2="${W - pad}" y1="${cy}" y2="${cy}" class="axis"/><line x1="${cx}" x2="${cx}" y1="${pad}" y2="${H - pad}" class="axis"/>
    <text x="${W - pad - 6}" y="${pad + 16}" text-anchor="end" class="qlbl" fill="var(--up)">Leading</text>
    <text x="${W - pad - 6}" y="${H - pad - 8}" text-anchor="end" class="qlbl" fill="var(--s3)">Weakening</text>
    <text x="${pad + 6}" y="${H - pad - 8}" class="qlbl" fill="var(--down)">Lagging</text>
    <text x="${pad + 6}" y="${pad + 16}" class="qlbl" fill="var(--c1)">Improving</text>
    <text x="${W - pad}" y="${cy - 6}" text-anchor="end" class="ax">Stronger than market →</text>
    <text x="${cx + 6}" y="${pad - 10}" class="ax">↑ Gaining strength</text>
    ${marks}</svg><div class="tip" hidden></div>`;
  if (!shown.length) el.insertAdjacentHTML("beforeend", `<p class="empty">No groups in that quadrant this week.</p>`);
  const tip = $(".tip", el);
  el.querySelectorAll(".rrg-g").forEach((g) => {
    const p = pts.find((x) => x.name === g.dataset.name);
    g.onmouseenter = (ev) => {
      const [a, b] = p.trail.at(-1);
      tip.innerHTML = `<div><b>${esc(p.name)}</b></div><div>${p.quadrant}${p.prev_quadrant !== p.quadrant ? ` (was ${p.prev_quadrant})` : ""}</div>
        <div class="tip-d">Strength ${a.toFixed(1)}, momentum ${b.toFixed(1)}</div>`;
      tip.hidden = false;
      const r = el.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
      tip.style.left = `${x + 14 + tip.offsetWidth > W ? x - tip.offsetWidth - 14 : x + 14}px`; tip.style.top = `${Math.max(4, y - 30)}px`;
    };
    g.onmouseleave = () => { tip.hidden = true; g.classList.remove("hot"); };
    g.addEventListener("mouseenter", () => { g.classList.add("hot"); g.parentNode.appendChild(g); });
    g.onclick = () => (location.hash = groupLink(level, p.name));
  });
}

async function pageGroup(level, name) {
  const stocks = enrich(await load("stocks.json"));
  const per = prefs.rs === "rs3" ? "3m" : "12m";
  const groups = await load(`groups_${level}_${per}.json`);
  const g = groups.find((x) => x.name === name);
  const members = stocks.filter((s) => s[level] === name);
  if (!g || !members.length) { view().innerHTML = `<h1>Group not found</h1><p><a href="#/industries">Back to industries</a></p>`; return; }
  const parent = level !== "sector" ? members[0].sector : null;
  const byStage = [2, 1, 3, 4].map((n) => [n, members.filter((s) => s.stage === n).length]);
  view().innerHTML = `<p class="muted"><a href="#/industries?level=${level}">${LEVELS[level]}</a>${parent ? `, part of <a href="${groupLink("sector", parent)}">${esc(parent)}</a>` : ""}</p>
    <h1>${esc(name)}</h1>
    <p class="muted">Ranked ${g.rank} of ${g.total_groups} ${LEVELS[level].toLowerCase()} by average ${rsLabel()}.</p>
    <div class="grid3">
      <section class="panel"><h2>Average ${rsLabel()}</h2><p class="big">${g.avg_rs.toFixed(0)}</p><p class="muted small">${fmt.chg(g.rs_change_wow)} this week, ${fmt.chg(g.rs_change_5w)} over five weeks</p></section>
      <section class="panel"><h2>In Stage 2</h2><p class="big">${g.stage2_pct.toFixed(0)}%</p><p class="muted small">${byStage.map(([n, c]) => `${c} in Stage ${n}`).join(", ")}</p></section>
      <section class="panel"><h2>Stocks</h2><p class="big">${members.length}</p><p class="muted small">${members.filter((s) => s.candidate).length} close to Stage 2</p></section>
    </div>
    <div id="tbl" style="margin-top:20px"></div>`;
  stockTable($("#tbl"), members, [COL.name, COL.spark, COL.stage, COL.close, COL.chg, COL.rs(), COL.rsd30, off(COL.rsd7), off(COL.offHigh), off(COL.industry), off(COL.mcap), off(COL.turnover)], { id: "group" });
}

async function pageHistory() {
  const [eps, stocks] = await Promise.all([load("stage2_episodes.json"), load("stocks.json")]);
  const byKey = Object.fromEntries(stocks.map((s) => [s.key, s]));
  const rows = eps.map((e) => ({ ...e, key: e.symbol, name: byKey[e.symbol]?.name, industry: byKey[e.symbol]?.industry,
    file: byKey[e.symbol]?.file || e.symbol.replace(":", "_") }));
  const avg = (k) => rows.reduce((a, r) => a + r[k], 0) / (rows.length || 1);
  const big = rows.filter((r) => r.peak_pct >= 50).length;
  view().innerHTML = `<h1>Stage 2 history</h1>
    <p class="muted">Every completed Stage 2 run in the stored history: when it started, when it ended, and the best gain along the way. Weekly, on Friday closes; runs shorter than two weeks are left out.</p>
    <div class="grid2" style="margin-top:12px">
      <section class="panel"><h2>${rows.length.toLocaleString("en-IN")} runs</h2><p class="muted">Average peak gain ${avg("peak_pct").toFixed(1)}%, reached in ${avg("weeks_to_peak").toFixed(1)} weeks on average.</p></section>
      <section class="panel"><h2>${((big / (rows.length || 1)) * 100).toFixed(1)}% big winners</h2><p class="muted">${big} runs peaked 50% or more above entry. Average run lasted ${avg("weeks").toFixed(1)} weeks.</p></section>
    </div>
    <div class="toolbar"><label>Search<input type="search" id="hq" placeholder="Name or symbol"></label></div><div id="tbl"></div>`;
  const cols = [COL.name,
    { key: "entry", label: "Entered", render: (r) => fmt.date(r.entry) }, { key: "exit", label: "Left", render: (r) => fmt.date(r.exit) },
    { key: "weeks", label: "Weeks", num: true }, { key: "peak_pct", label: "Peak gain", num: true, render: (r) => fmt.pct(r.peak_pct) },
    { key: "weeks_to_peak", label: "Weeks to peak", num: true }, COL.industry];
  const render = () => { const q = $("#hq").value.toLowerCase(); stockTable($("#tbl"), rows.filter((r) => !q || (r.name || "").toLowerCase().includes(q) || r.key.toLowerCase().includes(q)), cols, { sort: "exit", dir: -1 }); };
  $("#hq").oninput = render;
  render();
}

function stockSummary(s) {
  const bits = [];
  if (s.stage === 2) bits.push(s.days_in_s2 > 0 ? `In Stage 2 for ${s.days_in_s2} day${s.days_in_s2 === 1 ? "" : "s"}` : "Entered Stage 2 today");
  else if (s.candidate) bits.push(`Close to Stage 2, with ${s.rules_met} of 8 rules met`);
  else if (s.stage) bits.push(`In Stage ${s.stage}, ${STAGE_SHORT[s.stage].toLowerCase()}`);
  if (s.rs12 != null) {
    const d = s.rs12_d7 || 0;
    bits.push(`RS ${Math.round(s.rs12)}${d ? `, ${d > 0 ? "up" : "down"} ${Math.abs(Math.round(d))} this week` : ""}`);
  }
  if (s._offHigh != null) bits.push(s._offHigh > -0.5 ? "at its 52-week high" : `${Math.abs(s._offHigh).toFixed(1)}% below its 52-week high`);
  return bits.join(". ").replace(/^./, (c) => c.toUpperCase()) + ".";
}

async function pageStock(file) {
  const stocks = enrich(await load("stocks.json"));
  const s = stocks.find((x) => x.file === file);
  if (!s) { view().innerHTML = `<h1>Stock not found</h1><p>No stock with that code is in today's list. Press <kbd>⌘K</kbd> to search.</p>`; return; }
  const ticks = Object.entries(RULE_LABELS).map(([k, label]) => `<li class="${s[k] ? "ok" : "no"}" title="${s[k] ? "Met" : "Not met"}">${label}</li>`).join("");
  const crumbs = s.industry !== "Unclassified" ? [["sector", s.sector], ["industry", s.industry], ...(s.basic_industry !== s.industry ? [["basic_industry", s.basic_industry]] : [])]
    .map(([l, n]) => `<a href="${groupLink(l, n)}">${esc(n)}</a>`).join(" / ") : "";
  view().innerHTML = `
    <p class="dateline"><a href="javascript:history.back()">Back</a></p>
    <div class="stock-title"><h1>${esc(sym(s.key))}</h1><span class="muted">${esc(nice(s.name, s.key))}</span>
      <span class="stock-actions"><button type="button" id="btn-watch" aria-pressed="false">Watch</button><a class="btn" href="#/journal/new?s=${encodeURIComponent(s.key)}">Log a trade</a></span></div>
    <p class="muted small" style="margin:0 0 18px">${esc(s.exchange)}${crumbs ? `, ${crumbs}` : ""}</p>
    <div class="stock-head"><div class="px">${fmt.px(s.close)}</div><div class="big" style="margin:0">${fmt.pct(s.chg_pct)}</div><div>${fmt.stage(s.stage, s.candidate)}</div></div>
    <p class="summary">${stockSummary(s)}</p>
    <div class="facts">
      <div><span>RS 12M</span>${fmt.int(s.rs12)}</div><div><span>RS 3M</span>${fmt.int(s.rs3)}</div>
      <div><span>52-week range</span>${fmt.px(s.l52)} – ${fmt.px(s.h52)}</div>
      ${s.stage === 2 ? `<div><span>Stage 2 entry</span>${fmt.date(s.s2_entry_date)} at ${fmt.px(s.s2_entry_price)} (${fmt.pct(s._fromEntry)})</div>` : ""}
      <div><span>Market cap</span>${fmt.cr(s.mcap_cr)}</div><div><span>P/E</span>${s.pe == null ? "–" : s.pe.toFixed(1)}</div><div><span>Turnover</span>${fmt.cr(s.turnover_cr)} a day</div>
    </div>
    <div class="chart-head" style="margin-top:28px"><div class="legend" style="margin:0"><span><i style="background:var(--c1)"></i>50-day</span><span><i style="background:var(--c2)"></i>150-day</span><span><i style="background:var(--c3)"></i>200-day</span><span>Strip at the bottom shows the stage</span></div><div class="ranges" id="rng"></div></div>
    <div id="pchart" class="chart"></div>
    <div id="rchart" class="chart small"></div>
    <div class="legend"><span><i style="background:var(--ink)"></i>RS 12M</span><span><i style="background:var(--s1)"></i>RS 3M</span><span>Dotted line marks 70</span></div>
    <section class="section"><h2>Stage 2 checklist <span class="count">${s.rules_met} of 8 met</span></h2><ul class="checks">${ticks}</ul></section>`;
  $("#btn-watch").onclick = () => watchDialog(s).catch((e) => toast(esc(e.message), true));
  markWatched(s).catch(() => {});
  const [d, su] = await Promise.all([load(`series/${file}.json`), load("setups.json").catch(() => null)]);
  const setup = su?.setups.find((x) => x.key === s.key);
  if (setup) {
    $(".summary").insertAdjacentHTML("afterend", `<p class="setup-note"><b>${PATTERN[setup.pattern]}</b>, ${STATUS[setup.status].toLowerCase()}:
      breakout level ${fmt.px(setup.pivot)} (${fmt.pct(setup.dist_to_pivot)} away), base of ${setup.base_weeks} weeks from ${fmt.date(setup.base_start)}.
      <a href="#/setups?p=${setup.pattern}&s=${setup.status}">See all setups</a></p>`);
  }
  const charts = drawStockCharts(d, setup);
  if (charts) addRanges($("#rng"), charts, d.d, "1Y");
}

function drawStockCharts(d, setup = null) {
  if (!window.LightweightCharts) { $("#pchart").innerHTML = `<p class="empty" style="padding:16px">The chart library didn't load. Check your internet connection and reload.</p>`; return; }
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  const opts = (el) => ({
    width: el.clientWidth, height: el.clientHeight,
    layout: { background: { color: v("--surface") }, textColor: v("--muted"), fontFamily: v("--font"), attributionLogo: false },
    grid: { vertLines: { visible: false }, horzLines: { color: v("--rule") } },
    rightPriceScale: { borderColor: v("--rule"), minimumWidth: 72 }, timeScale: { borderColor: v("--rule") },
    crosshair: { mode: 0 },
    localization: { locale: "en-IN" },
  });
  const pel = $("#pchart"), rel = $("#rchart");
  const pc = LightweightCharts.createChart(pel, opts(pel));
  // Every series gets a point for every date (blank where there's no value) so both charts share one axis.
  const pts = (arr) => d.d.map((t, i) => (arr[i] == null ? { time: t } : { time: t, value: arr[i] }));
  const bars = d.d.map((t, i) => (d.c[i] == null ? { time: t }
    : { time: t, open: d.o[i] ?? d.c[i], high: d.h[i] ?? d.c[i], low: d.l[i] ?? d.c[i], close: d.c[i] }));
  // stage ribbon along the bottom edge
  const stageCol = { 1: v("--s1"), 2: v("--s2"), 3: v("--s3"), 4: v("--s4") };
  const ribbon = pc.addHistogramSeries({ priceScaleId: "stage", lastValueVisible: false, priceLineVisible: false });
  pc.priceScale("stage").applyOptions({ scaleMargins: { top: 0.955, bottom: 0 }, visible: false });
  ribbon.setData(d.d.map((t, i) => (d.st[i] ? { time: t, value: 1, color: stageCol[d.st[i]] } : { time: t })));
  pc.priceScale("right").applyOptions({ scaleMargins: { top: 0.06, bottom: 0.08 } });
  const candles = pc.addCandlestickSeries({ upColor: v("--up"), downColor: v("--down"), wickUpColor: v("--up"), wickDownColor: v("--down"), borderVisible: false });
  candles.setData(bars);
  const line = (key, color) => pc.addLineSeries({ color, lineWidth: 1.5, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false }).setData(pts(d[key]));
  line("s50", v("--c1")); line("s150", v("--c2")); line("s200", v("--c3"));
  if (setup) {
    candles.createPriceLine({ price: setup.pivot, color: v("--ink"), lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: "Breakout level" });
    const marks = [{ time: setup.base_start, position: "aboveBar", color: v("--ink"), shape: "arrowDown", text: "Base starts" }];
    if (setup.breakout_date) marks.push({ time: setup.breakout_date, position: "belowBar", color: v("--up"), shape: "arrowUp", text: "" });
    candles.setMarkers(marks);
  }
  pc.timeScale().fitContent();

  const rc = LightweightCharts.createChart(rel, opts(rel));
  const whole = { type: "price", precision: 0, minMove: 1 };
  rc.priceScale("right").applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 } });
  const rs12 = rc.addLineSeries({ color: v("--ink"), lineWidth: 2, priceLineVisible: false, priceFormat: whole,
    autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
  rs12.setData(pts(d.rs12));
  rc.addLineSeries({ color: v("--s1"), lineWidth: 1, priceLineVisible: false, priceFormat: whole }).setData(pts(d.rs3));
  rs12.createPriceLine({ price: 70, color: v("--muted"), lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
  rc.timeScale().fitContent();
  // keep both charts scrolled together
  pc.timeScale().subscribeVisibleLogicalRangeChange((r) => r && rc.timeScale().setVisibleLogicalRange(r));
  rc.timeScale().subscribeVisibleLogicalRangeChange((r) => r && pc.timeScale().setVisibleLogicalRange(r));
  new ResizeObserver(() => { pc.applyOptions({ width: pel.clientWidth }); rc.applyOptions({ width: rel.clientWidth }); }).observe(pel);
  return [pc, rc];
}

/* ---------- shared time-series chart with hover readout ---------- */
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function chartOpts(el, extra = {}) {
  return {
    width: el.clientWidth, height: el.clientHeight,
    layout: { background: { color: cssVar("--surface") }, textColor: cssVar("--muted"), fontFamily: cssVar("--font"), attributionLogo: false },
    grid: { vertLines: { visible: false }, horzLines: { color: cssVar("--rule") } },
    rightPriceScale: { borderColor: cssVar("--rule"), minimumWidth: 56 }, timeScale: { borderColor: cssVar("--rule") },
    crosshair: { mode: 0 }, localization: { locale: "en-IN" }, handleScale: false, handleScroll: false, ...extra,
  };
}
/* defs: [{key, label, color, type: "line"|"hist", sign: 1|-1, width}] ; data: {d:[], key:[]} */
function tsChart(el, data, defs, { lines = [], fmt = (v) => v.toLocaleString("en-IN"), abs = false, precision = 0 } = {}) {
  if (!window.LightweightCharts) { el.innerHTML = `<p class="empty" style="padding:16px">The chart library didn't load. Reload to try again.</p>`; return; }
  el.style.position = "relative";
  const chart = LightweightCharts.createChart(el, chartOpts(el, abs ? { localization: { locale: "en-IN", priceFormatter: (v) => Math.abs(Math.round(v)).toLocaleString("en-IN") } } : {}));
  const made = defs.map((s) => {
    const opts = { color: s.color, priceLineVisible: false, lastValueVisible: false, priceFormat: { type: "price", precision, minMove: 1 / 10 ** precision } };
    const series = s.type === "hist" ? chart.addHistogramSeries(opts)
      : chart.addLineSeries({ ...opts, lineWidth: s.width || 2, crosshairMarkerRadius: 4 });
    series.setData(data.d.map((t, i) => (data[s.key][i] == null ? { time: t } : { time: t, value: (s.sign || 1) * data[s.key][i] })));
    return { s, series };
  });
  lines.forEach((l) => made[0].series.createPriceLine({ price: l.price, color: cssVar("--muted"), lineStyle: 2, lineWidth: 1, axisLabelVisible: false, title: l.label || "" }));
  chart.timeScale().fitContent();
  const tip = document.createElement("div");
  tip.className = "tip"; tip.hidden = true; el.appendChild(tip);
  chart.subscribeCrosshairMove((p) => {
    if (!p.time || !p.point || p.point.x < 0 || p.point.y < 0) { tip.hidden = true; return; }
    const rows = made.map(({ s, series }) => {
      const v = p.seriesData.get(series)?.value;
      return v == null ? "" : `<div><i style="background:${s.color}"></i>${s.label} <b>${fmt(Math.abs(v))}</b></div>`;
    }).join("");
    tip.innerHTML = `<div class="tip-d">${fmtDate(p.time)}</div>${rows}`;
    tip.hidden = false;
    const x = p.point.x + 14, w = tip.offsetWidth;
    tip.style.left = `${x + w > el.clientWidth ? p.point.x - w - 14 : x}px`;
    tip.style.top = `8px`;
  });
  new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth })).observe(el);
  return chart;
}
const fmtDate = (t) => fmt.date(typeof t === "string" ? t : `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`);
const legend = (defs) => `<div class="legend">${defs.map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join("")}</div>`;

async function pageBreadth(params) {
  const b = await load("breadth.json");
  const uni = params.get("u") === "nifty500" && b.nifty500 ? "nifty500" : "all";
  const { latest: L, series: S } = b[uni];
  const pctFmt = (v) => `${v.toFixed(1)}%`;
  const trend = (now, then) => (then == null ? "–" : now > then ? `<span class="up">Improving</span>` : now < then ? `<span class="down">Weakening</span>` : "Unchanged");
  const advPct = (L.adv / Math.max(L.adv + L.dec, 1)) * 100;
  const zone = L.score >= 60 ? "bull" : L.score <= 40 ? "bear" : "neutral";
  const rot = b.rotation;
  view().innerHTML = `
    <h1>Market breadth</h1>
    <p class="muted">How many stocks are taking part in the market's move, as of the close on ${fmt.date(L.date)}.</p>
    <nav class="tabs">
      <a href="#/breadth" class="${uni === "all" ? "on" : ""}">All tracked stocks<span class="count">${b.all.latest.stocks.toLocaleString("en-IN")}</span></a>
      ${b.nifty500 ? `<a href="#/breadth?u=nifty500" class="${uni === "nifty500" ? "on" : ""}">Nifty 500<span class="count">${b.nifty500.latest.stocks}</span></a>` : ""}
    </nav>
    <section class="health">
      <div class="health-score ${zone}"><span class="n">${L.score}</span><span class="lbl">${L.label}</span></div>
      <div class="health-body">
        <div class="meter" role="img" aria-label="Health score ${L.score} of 100">
          <span class="z bear" style="width:40%"></span><span class="z neutral" style="width:20%"></span><span class="z bull" style="width:40%"></span>
          <b style="left:${L.score}%"></b>
        </div>
        <div class="meter-scale"><span>0, bearish</span><span style="left:40%">40</span><span style="left:60%">60</span><span>bullish, 100</span></div>
        <ul class="parts">
          <li><span>Rising vs falling stocks</span><b>${L.parts.ad}</b></li>
          <li><span>New highs vs new lows</span><b>${L.parts.highs}</b></li>
          <li><span>Stocks above their 50, 100 and 200-day averages</span><b>${L.parts.averages}</b></li>
        </ul>
        <p class="muted small">The score is the plain average of these three parts, each on a 0–100 scale.</p>
      </div>
    </section>
    <div class="grid3">
      <section class="panel"><h2>Advancing vs declining</h2>
        <p class="big"><span class="up">${L.adv.toLocaleString("en-IN")}</span> rose, <span class="down">${L.dec.toLocaleString("en-IN")}</span> fell</p>
        <div class="split" role="img" aria-label="${advPct.toFixed(0)}% of moving stocks rose"><span class="upbg" style="width:${advPct}%"></span><span class="downbg"></span></div>
        <p class="muted small">A/D ratio ${L.ad_ratio ?? "–"}</p></section>
      <section class="panel"><h2>52-week highs and lows</h2>
        <p class="big"><span class="up">${L.nh}</span> highs, <span class="down">${L.nl}</span> lows</p>
        <p class="muted small">Net ${L.net_highs > 0 ? "+" : ""}${L.net_highs}</p></section>
      <section class="panel"><h2>In Stage 2</h2><p class="big">${L.stage2_pct}%</p><p class="muted small">of stocks are in an established uptrend</p></section>
    </div>
    <div class="chart-head section"><h2 style="margin:0">History</h2><div class="ranges" id="rng"></div></div>
    <div class="grid2 charts" style="margin-top:12px">
      <section class="panel"><h2>Health score</h2><div class="chart mid" id="c-score"></div><div id="l-score"></div><p class="muted small">Dashed lines mark 40 and 60.</p></section>
      <section class="panel"><h2>Advance–decline line</h2><div class="chart mid" id="c-ad"></div><p class="muted small">Running total of rising minus falling stocks. A falling line while the index rises means fewer stocks are carrying it.</p></section>
      <section class="panel"><h2>New highs and new lows</h2><div class="chart mid" id="c-hl"></div><div id="l-hl"></div></section>
      <section class="panel"><h2>Stocks above their averages</h2><div class="chart mid" id="c-ma"></div><div id="l-ma"></div></section>
      <section class="panel"><h2>Stocks in Stage 2</h2><div class="chart mid" id="c-s2"></div></section>
      <section class="panel"><h2>Large caps or mid and small caps?</h2>
        ${rot ? `<p class="big">${rot.leading} are leading</p>
          <p class="muted small">Nifty MidSmallcap 400 relative to Nifty 100 is ${Math.abs(rot.gap_pct)}% ${rot.above ? "above" : "below"} its 200-day average, and has been since ${fmt.date(rot.since)}.</p>
          <div class="chart mid" id="c-rot"></div><div id="l-rot"></div>`
        : `<p class="empty">Index data hasn't been downloaded yet. It arrives with the next daily run.</p>`}
      </section>
    </div>
    <div class="grid2">
      <section class="panel"><h2>Participation</h2>
        <table class="plain"><thead><tr><th>Above the</th><th class="num">Today</th><th class="num">1 week ago</th><th class="num">1 month ago</th><th>Trend</th></tr></thead>
        <tbody>${["50", "100", "200"].map((n) => { const p = L.participation[n]; return `<tr><td>${n}-day average</td><td class="num">${pctFmt(p.now)}</td><td class="num">${p.w1 == null ? "–" : pctFmt(p.w1)}</td><td class="num">${p.m1 == null ? "–" : pctFmt(p.m1)}</td><td>${trend(p.now, p.w1)}</td></tr>`; }).join("")}</tbody></table></section>
      <section class="panel"><h2>Sharp moves</h2>
        <table class="plain"><thead><tr><th>Stocks that moved</th><th class="num">Today</th><th class="num">1 week ago</th></tr></thead>
        <tbody>${[["up4", "Up 4% or more in a day"], ["down4", "Down 4% or more in a day"], ["up10_5d", "Up 10% or more over 5 days"], ["down10_5d", "Down 10% or more over 5 days"]]
          .map(([k, lbl]) => `<tr><td>${lbl}</td><td class="num">${L.moves[k].now}</td><td class="num">${L.moves[k].w1 ?? "–"}</td></tr>`).join("")}</tbody></table>
        <p class="muted small">Many more sharp rises than falls is a sign of strong demand.</p></section>
    </div>`;
  const num = (v) => Math.round(v).toLocaleString("en-IN");
  const pct = (v) => `${v.toFixed(1)}%`;
  S.score_avg = S.score.map((_, i) => { const w = S.score.slice(Math.max(0, i - 9), i + 1).filter((x) => x != null); return i < 9 ? null : w.reduce((a, b) => a + b, 0) / w.length; });
  const sc = [{ key: "score", label: "Daily", color: cssVar("--s1"), width: 1 }, { key: "score_avg", label: "10-day average", color: cssVar("--ink") }];
  const bc = [];
  bc.push(tsChart($("#c-score"), S, sc, { lines: [{ price: 40 }, { price: 60 }], fmt: num })); $("#l-score").innerHTML = legend(sc);
  bc.push(tsChart($("#c-ad"), S, [{ key: "ad_line", label: "A/D line", color: cssVar("--c1") }], { fmt: num }));
  const hl = [{ key: "nh", label: "New highs", color: cssVar("--up"), type: "hist" }, { key: "nl", label: "New lows", color: cssVar("--down"), type: "hist", sign: -1 }];
  bc.push(tsChart($("#c-hl"), S, hl, { fmt: num, abs: true })); $("#l-hl").innerHTML = legend(hl);
  const ma = [{ key: "above50", label: "Above 50-day", color: cssVar("--c1") }, { key: "above100", label: "Above 100-day", color: cssVar("--c2") }, { key: "above200", label: "Above 200-day", color: cssVar("--c3") }];
  bc.push(tsChart($("#c-ma"), S, ma, { fmt: pct, precision: 0 })); $("#l-ma").innerHTML = legend(ma);
  bc.push(tsChart($("#c-s2"), S, [{ key: "stage2_pct", label: "In Stage 2", color: cssVar("--s2") }], { fmt: pct }));
  if (rot) {
    const rd = [{ key: "ratio", label: "MidSmallcap 400 ÷ Nifty 100", color: cssVar("--c1") }, { key: "sma200", label: "200-day average", color: cssVar("--muted"), width: 1 }];
    bc.push(tsChart($("#c-rot"), rot.series, rd, { fmt: (v) => v.toFixed(3) })); $("#l-rot").innerHTML = legend(rd);
  }
  if (bc.filter(Boolean).length) addRanges($("#rng"), bc.filter(Boolean), S.d, "1Y");
}

const PATTERN = { vcp: "Cup & handle (VCP)", htf: "High tight flag" };
const STATUS = { forming: "Forming", fresh: "Fresh breakout", continuation: "Continuation" };
const STATUS_HELP = {
  forming: "The pause is still building: price hasn't closed above the breakout level yet. These are ones to watch.",
  fresh: "Closed above the breakout level within the last five sessions and still holding near it.",
  continuation: "Broke out earlier and is still above the breakout level and the 50-day average.",
};

async function pageSetups(params) {
  const [su, stocks] = await Promise.all([load("setups.json"), load("stocks.json")]);
  const byKey = Object.fromEntries(enrich(stocks).map((s) => [s.key, s]));
  const pat = params.get("p") === "htf" ? "htf" : "vcp";
  const st = ["forming", "fresh", "continuation"].includes(params.get("s")) ? params.get("s") : "forming";
  const mode = params.get("v") === "charts" ? "charts" : "table";
  const all = su.setups.map((x) => ({ ...byKey[x.key], ...x, name: byKey[x.key]?.name, file: byKey[x.key]?.file || x.key.replace(":", "_") }));
  const count = (p, s) => all.filter((x) => x.pattern === p && (!s || x.status === s)).length;
  const rows = all.filter((x) => x.pattern === pat && x.status === st);
  const link = (o) => { const q = new URLSearchParams({ p: pat, s: st, v: mode, ...o }); return `#/setups?${q}`; };
  view().innerHTML = `<h1>Chart setups</h1>
    <p class="muted">Stocks pausing after a run, found automatically as of ${fmt.date(su.date)}. A pattern is a starting point for your own chart review, not a signal on its own.</p>
    <div class="cards">${["vcp", "htf"].map((p) => `<a class="card ${p === pat ? "on" : ""}" href="${link({ p, s: "forming" })}">
      <b>${PATTERN[p]}</b><span class="big">${count(p)}</span>
      <span class="muted small">${p === "vcp" ? "A rounded base with pullbacks that get smaller, ending in a tight pause near the top." : "A sharp run of 60% or more, then a short, shallow pause near the highs."}</span></a>`).join("")}</div>
    <nav class="tabs">${Object.keys(STATUS).map((s) => `<a href="${link({ s })}" class="${s === st ? "on" : ""}">${STATUS[s]}<span class="count">${count(pat, s)}</span></a>`).join("")}
      <span class="tabs-right"><a href="${link({ v: "table" })}" class="${mode === "table" ? "on" : ""}">Table</a><a href="${link({ v: "charts" })}" class="${mode === "charts" ? "on" : ""}">Charts</a></span></nav>
    <p class="muted small" style="margin-top:10px">${STATUS_HELP[st]}</p>
    <div id="out"></div>
    <details class="rules-box"><summary>How these are found</summary>${pat === "vcp"
      ? `<p>Base of 3 to 52 weeks, no deeper than 30%, after a rise of at least 25%. At least two pullbacks inside the base, the last one no deeper than 12% and no more than 60% of the deepest. Volume in the last pullback under 75% of the base average. 50-day above 150-day above 200-day average, price within 30% of its 52-week high. RS of 70 or more when the breakout level formed, 60 or more now. Median daily turnover of ₹3 crore or more. Thresholds follow a widely used VCP screen; the way pullbacks are measured is our own.</p>`
      : `<p>A rise of 60% or more within 40 sessions (the pole), then a 10 to 30 session pause that gives back no more than 25%. RS of 70 or more and median daily turnover of ₹3 crore or more. These are our own rules.</p>`}</details>`;
  if (!rows.length) { $("#out").innerHTML = `<p class="empty">No ${PATTERN[pat].toLowerCase()} setups are ${STATUS[st].toLowerCase()} today. Try another tab.</p>`; return; }
  if (mode === "table") {
    const cols = [COL.name,
      { key: "pivot", label: "Breakout level", num: true, render: (r) => fmt.px(r.pivot) },
      { key: "dist_to_pivot", label: "From level", num: true, render: (r) => fmt.pct(r.dist_to_pivot) },
      ...(st !== "forming" ? [{ key: "breakout_date", label: "Broke out", render: (r) => fmt.date(r.breakout_date) }] : []),
      { key: "base_weeks", label: pat === "vcp" ? "Base, weeks" : "Pause, weeks", num: true },
      { key: "depth", label: "Depth", num: true, render: (r) => `${r.depth.toFixed(0)}%` },
      pat === "vcp" ? { key: "contractions", label: "Pullbacks", render: (r) => r.contractions.map((x) => `${Math.round(x)}%`).join(" → "), sortVal: (r) => r.contractions.at(-1) }
        : { key: "pole_gain", label: "Pole", num: true, render: (r) => `+${Math.round(r.pole_gain)}%` },
      COL.rs(), off(COL.industry), off(COL.turnover)];
    stockTable($("#out"), rows, [cols[0], COL.spark, ...cols.slice(1)], { sort: "dist_to_pivot", dir: -1, id: `setups-${pat}` });
  } else {
    $("#out").innerHTML = `<div class="chart-grid">${rows.map((r, i) => `<a class="mini-card" href="${stockLink(r)}">
      <div class="mini-head"><b>${esc(nice(r.name, r.key))}</b><span>${fmt.pct(r.dist_to_pivot)} from level</span></div>
      <div class="mini-chart" data-i="${i}"></div></a>`).join("")}</div>`;
    const io = new IntersectionObserver((ents) => ents.forEach((e) => { if (e.isIntersecting) { io.unobserve(e.target); miniSetupChart(e.target, rows[+e.target.dataset.i]); } }), { rootMargin: "200px" });
    document.querySelectorAll(".mini-chart").forEach((el) => io.observe(el));
  }
}

async function miniSetupChart(el, r) {
  if (!window.LightweightCharts) return;
  const d = await load(`series/${r.file}.json`).catch(() => null);
  if (!d) { el.innerHTML = `<p class="empty">No chart data.</p>`; return; }
  const from = Math.max(0, d.d.indexOf(r.base_start) - 40);
  const chart = LightweightCharts.createChart(el, chartOpts(el, { rightPriceScale: { visible: false }, timeScale: { visible: false }, crosshair: { mode: 2 } }));
  const c = chart.addCandlestickSeries({ upColor: cssVar("--up"), downColor: cssVar("--down"), wickUpColor: cssVar("--up"), wickDownColor: cssVar("--down"), borderVisible: false, priceLineVisible: false, lastValueVisible: false });
  c.setData(d.d.slice(from).map((t, j) => { const i = j + from; return d.c[i] == null ? { time: t } : { time: t, open: d.o[i] ?? d.c[i], high: d.h[i] ?? d.c[i], low: d.l[i] ?? d.c[i], close: d.c[i] }; }));
  chart.addLineSeries({ color: cssVar("--c1"), lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
    .setData(d.d.slice(from).map((t, j) => (d.s50[j + from] == null ? { time: t } : { time: t, value: d.s50[j + from] })));
  c.createPriceLine({ price: r.pivot, color: cssVar("--ink"), lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
  c.setMarkers([{ time: r.base_start, position: "aboveBar", color: cssVar("--muted"), shape: "arrowDown" }]);
  chart.timeScale().fitContent();
}

function pageSoon(title, what) {
  view().innerHTML = `<h1>${title}</h1><div class="notice">${what}</div>`;
}

/* ---------- router ---------- */
async function route() {
  const [path, query] = location.hash.replace(/^#/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  const params = new URLSearchParams(query || "");
  const name = parts[0] || "home";
  const navName = name === "group" ? "industries" : name === "stock" ? "" : name;
  document.querySelectorAll("a[data-route]").forEach((a) => a.classList.toggle("active", a.dataset.route === navName));
  $(".side").classList.remove("open");
  view().innerHTML = skeleton();
  try {
    if (name === "home") await pageHome();
    else if (name === "stages") await pageStages(parts[1]);
    else if (name === "rs") await pageRS();
    else if (name === "industries") await pageIndustries(params);
    else if (name === "group") await pageGroup(parts[1], decodeURIComponent(parts.slice(2).join("/")));
    else if (name === "history") await pageHistory();
    else if (name === "stock") await pageStock(decodeURIComponent(parts[1] || ""));
    else if (name === "breadth") await pageBreadth(params);
    else if (name === "setups") await pageSetups(params);
    else if (name === "watchlist") await pageWatchlist(parts[1]);
    else if (name === "journal") await pageJournal(parts[1], parts[2], params);
    else pageSoon("Page not found", `There's no page at this address. <a href="#/">Go to the market overview</a>.`);
    if (name === "stages" && params.get("ind")) { const sel = $("#fi"); if (sel) { sel.value = params.get("ind"); sel.dispatchEvent(new Event("input")); } }
  } catch (e) {
    view().innerHTML = `<h1>Data didn't load</h1><p>${esc(e.message)}. Run the engine to produce today's files, then reload.</p>`;
  }
  view().focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

/* ---------- search palette (⌘K) ---------- */
let searchIndex = null;
async function openSearch() {
  if ($(".palette-back")) return;
  const back = document.createElement("div");
  back.className = "palette-back";
  back.innerHTML = `<div class="palette" role="dialog" aria-label="Search">
    <input type="text" placeholder="Search stocks, sectors and industries" aria-label="Search" autocomplete="off">
    <ul role="listbox"></ul>
    <div class="hint"><span><kbd>↑</kbd> <kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to open</span><span><kbd>Esc</kbd> to close</span></div></div>`;
  document.body.appendChild(back);
  const input = $("input", back), ul = $("ul", back);
  const close = () => { back.remove(); document.removeEventListener("keydown", onKey, true); };
  back.onclick = (e) => { if (e.target === back) close(); };
  if (!searchIndex) {
    const stocks = await load("stocks.json");
    const groups = [];
    for (const lvl of ["sector", "industry", "basic_industry"]) {
      [...new Set(stocks.map((s) => s[lvl]))].filter((g) => g && g !== "Unclassified")
        .forEach((g) => groups.push({ kind: LEVEL_ONE[lvl], label: g, sub: "", href: groupLink(lvl, g), hay: g.toLowerCase() }));
    }
    searchIndex = stocks.map((s) => ({ kind: s.stage ? `Stage ${s.stage}` : "", label: sym(s.key), sub: nice(s.name, s.key), href: stockLink(s),
      hay: `${sym(s.key)} ${nice(s.name, s.key)}`.toLowerCase(), symbol: sym(s.key).toLowerCase() })).concat(groups);
  }
  let sel = 0, hits = [];
  const render = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { ul.innerHTML = `<li class="empty" style="display:block">Type a symbol like BHEL or a name like Bharat.</li>`; hits = []; return; }
    const score = (x) => (x.symbol === q ? 0 : x.symbol?.startsWith(q) ? 1 : x.hay.startsWith(q) ? 2 : x.hay.includes(` ${q}`) ? 3 : x.hay.includes(q) ? 4 : 9);
    hits = searchIndex.map((x) => [score(x), x]).filter(([s]) => s < 9).sort((a, b) => a[0] - b[0] || a[1].label.length - b[1].label.length).slice(0, 12).map(([, x]) => x);
    sel = Math.min(sel, Math.max(0, hits.length - 1));
    ul.innerHTML = hits.length ? hits.map((x, i) => `<li role="option" aria-selected="${i === sel}" data-i="${i}"><b>${esc(x.label)}</b><span>${esc(x.sub)}</span><span class="kind">${esc(x.kind)}</span></li>`).join("")
      : `<li class="empty" style="display:block">Nothing matches "${esc(q)}".</li>`;
    ul.querySelectorAll("li[data-i]").forEach((li) => { li.onclick = () => go(+li.dataset.i); li.onmousemove = () => { if (sel !== +li.dataset.i) { sel = +li.dataset.i; render(); } }; });
  };
  const go = (i) => { if (hits[i]) { location.hash = hits[i].href; close(); } };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, hits.length - 1); render(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
    else if (e.key === "Enter") { e.preventDefault(); go(sel); }
  };
  document.addEventListener("keydown", onKey, true);
  input.oninput = () => { sel = 0; render(); };
  render();
  input.focus();
}

/* ---------- theme ---------- */
const theme = {
  get() { try { return localStorage.getItem("theme") || "auto"; } catch { return "auto"; } },
  set(v) {
    try { localStorage.setItem("theme", v); } catch { /* private mode */ }
    if (v === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = v;
    document.querySelectorAll("[data-theme-set]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.themeSet === v));
  },
};

document.addEventListener("DOMContentLoaded", async () => {
  theme.set(theme.get());
  document.querySelectorAll("[data-theme-set]").forEach((b) => (b.onclick = () => { theme.set(b.dataset.themeSet); route(); }));
  const rsButtons = document.querySelectorAll("[data-rs]");
  const markRs = () => rsButtons.forEach((b) => b.setAttribute("aria-pressed", b.dataset.rs === prefs.rs));
  rsButtons.forEach((b) => (b.onclick = () => { prefs.rs = b.dataset.rs; markRs(); route(); }));
  markRs();
  document.querySelectorAll("[data-open-search]").forEach((b) => (b.onclick = openSearch));
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openSearch(); }
    else if (e.key === "/" && !/input|textarea|select/i.test(document.activeElement.tagName)) { e.preventDefault(); openSearch(); }
  });
  $("[data-open-menu]").onclick = () => $(".side").classList.toggle("open");
  $(".side").addEventListener("click", (e) => { if (e.target.closest("a")) $(".side").classList.remove("open"); });
  load("summary.json").then((s) => ($("#asof").textContent = `Data as of the close on ${fmt.date(s.date)}`)).catch(() => {});
  SPARKS = await load("sparks.json").catch(() => ({}));
  await finishSignIn().catch(() => {});
  window.addEventListener("hashchange", route);
  route();
});
