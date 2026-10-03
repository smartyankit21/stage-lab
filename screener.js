/* Screener page: Match Score and PDV_Persist+Mom, ported from Accumulation Lab.
   The calculations are Accumulation Lab's own code (site/screeners/*.mjs), run unchanged:
   - the lists are computed every evening by the daily job (engine/run_screeners.mjs);
   - clicking a stock runs the same code in the browser on that stock's file, for the detail view.
   This file only handles the page: tables, charts, filters and downloads. */
import { matchStock, matchExport, COUNT_LIMITS, SUM_LIMITS, MATCH_MIN_MARKET_CAP_CRORE } from "./screeners/match-score.mjs";
import { dailyScoreStock, dailyScoreExport, DAILY_SCORE_MAX } from "./screeners/daily-screener.mjs";
import { toRows } from "./screeners/rows.mjs";

const SCREENERS = {
  match: {
    label: "Match Score", file: "screener/match.json", max: 12,
    title: "Match Score screener",
    blurb: `Your 12-condition PDV screen. One point per condition, qualifying score 9 of 12. Stocks with a known market cap below ₹${MATCH_MIN_MARKET_CAP_CRORE.toLocaleString("en-IN")} crore are left out; stocks with no market cap on record are kept and marked.`,
    filters: [["candidate", "Qualified: score ≥ 9"], ["all", "All scores"], ["none", "Below 9"]],
    sorts: [["score", "Match Score"], ["marketCapCrore", "Market cap ₹ crore"], ["pdvRatio", "PDV/SMA(20)"], ["dGreaterT", "D ≥ T"],
      ["dGreaterTGreaterV", "D ≥ T ≥ V"], ["dAtLeast1", "D ≥ 1"], ["dAtLeast2", "PDV/SMA(20) ≥ 2 (40 days)"]],
    cols: [
      { label: "Score", num: true, v: (r) => `<b>${r.score}</b>/12` },
      { label: "Market cap<br>₹ crore", num: true, v: (r) => capCell(r) },
      { label: "PDV/SMA<br>(20)", num: true, v: (r) => n2(r.metrics.pdvRatio) },
      { label: "D ≥ T", num: true, v: (r) => n0(r.metrics.dGreaterT) },
      { label: "D ≥ T ≥ V", num: true, v: (r) => n0(r.metrics.dGreaterTGreaterV) },
      { label: "D ≥ 1", num: true, v: (r) => n0(r.metrics.dAtLeast1) },
      { label: "PDV/SMA(20)<br>≥ 2 · 40D", num: true, v: (r) => n0(r.metrics.dAtLeast2) },
      { label: "Latest<br>date", v: (r) => shortDate(r.latest.date) },
    ],
    stats: (rs) => [["candidate", "Qualified", count(rs, "candidate"), `Match Score ≥ 9 / 12 · market cap ≥ ₹1,000 crore`],
      ["none", "Below threshold", count(rs, "none"), "Match Score < 9 / 12"],
      ["all", "Stocks screened", rs.length, "NSE stocks after the market-cap filter"],
      ["all", "Maximum score", 12, "One point per condition"]],
    caption: "Ordered by Match Score · market cap ≥ ₹1,000 crore · qualifying score ≥ 9 / 12",
  },
  pdv: {
    label: "PDV_Persist+Mom", file: "screener/pdv_persist.json", max: DAILY_SCORE_MAX,
    title: "PDV_Persist+Mom screener",
    blurb: "z21 > 15 and 10-day momentum ≥ 8%. EQ/BE stocks that traded on the as-of date, with at least 30 sessions of history.",
    filters: [["candidate", "Qualified: z21 > 15 and mom10 ≥ 8%"], ["all", "All scores"], ["none", "Below threshold"]],
    sorts: [["score", "PDV_Persist+Mom"], ["change", "Change %"], ["z21", "z21"], ["mom10", "10-day momentum"], ["pdvRatio", "PDVr"],
      ["ptvRatio", "PTVr"], ["volumeRatio", "VOLr"], ["marketCapCrore", "Market cap ₹ crore"]],
    cols: [
      { label: "Score", num: true, v: (r) => `<b>${r.score}</b>/${DAILY_SCORE_MAX}` },
      { label: "z21", num: true, v: (r) => n0(r.metrics.z21) },
      { label: "mom10", num: true, v: (r) => n1(r.metrics.mom10) },
      { label: "Chg %", num: true, v: (r) => n2(r.metrics.change) },
      { label: "PTVr", num: true, v: (r) => n2(r.metrics.ptvRatio) },
      { label: "PDVr", num: true, v: (r) => n2(r.metrics.pdvRatio) },
      { label: "VOLr", num: true, v: (r) => n2(r.metrics.volumeRatio) },
      { label: "Cap ₹ cr", num: true, v: (r) => capCell(r) },
      { label: "Date", v: (r) => shortDate(r.latest.date) },
    ],
    stats: (rs) => [["candidate", "Qualified", count(rs, "candidate"), "z21 > 15 and mom10 ≥ 8%"],
      ["none", "Below threshold", count(rs, "none"), "Missing z21 or 10-day momentum"],
      ["all", "Stocks scored", rs.length, `EQ/BE · traded on as-of · ≥ 30 sessions · ${DAILY_SCORE_MAX} conditions`],
      ["all", "Maximum score", DAILY_SCORE_MAX, "One point for z21, one for mom10"]],
    caption: "Ordered by PDV_Persist+Mom · qualify at 2/2 (z21 > 15 and mom10 ≥ 8%)",
  },
};

/* ---------- formatting (Indian locale, IST dates) ---------- */
const fin = Number.isFinite;
const nf = (v, d) => (fin(v) ? v.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }) : "–");
const n0 = (v) => nf(v, 0), n1 = (v) => nf(v, 1), n2 = (v) => nf(v, 2);
const shortDate = (d) => (d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }) : "–");
const longDate = (d) => (d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "–");
const capOf = (r) => (fin(r.metrics?.marketCapCrore) ? r.metrics.marketCapCrore : null);
const capCell = (r) => (capOf(r) == null ? `<span class="muted">n/a</span>` : n0(capOf(r)));
const capLine = (r) => (capOf(r) == null ? "Market cap unavailable" : `₹${n0(capOf(r))} crore`);
const count = (rs, s) => rs.filter((r) => r.status === s).length;
const qualified = (r) => r.status === "candidate";
const displayName = (r) => nice(r.name || r.meta?.name || "", "NSE:" + r.symbol);

/* ---------- page state (kept while you stay on the page) ---------- */
const st = { kind: "match", data: {}, filter: "candidate", sort: "score", dir: "desc", q: "", size: 50, page: 0, selected: null, lookback: 180, detail: null, cleanups: [] };

async function getList(kind) {
  if (!st.data[kind]) st.data[kind] = await load(SCREENERS[kind].file);
  return st.data[kind];
}

window.pageScreener = async function pageScreener(kindArg, params) {
  const kind = SCREENERS[kindArg] ? kindArg : "match";
  if (kind !== st.kind) { st.kind = kind; st.filter = "candidate"; st.sort = "score"; st.dir = "desc"; st.page = 0; st.selected = null; st.lookback = kind === "match" ? 180 : 90; }
  if (params?.get("s")) st.selected = params.get("s");
  const cfg = SCREENERS[kind];
  let data;
  try { data = await getList(kind); }
  catch {
    view().innerHTML = `<h1>Screener</h1><div class="notice">The screener lists aren't ready yet. They are built by the evening update once NSE's delivery files have been downloaded. Check back after the next update.</div>`;
    return;
  }
  const info = data.info || {};
  view().innerHTML = `
    <div class="scr-head">
      <div><p class="eyebrow">Screens</p><h1>${cfg.title}</h1><p class="muted scr-blurb">${cfg.blurb}</p></div>
      <div class="scr-controls">
        <label>As of<select disabled><option>${longDate(info.asof)}</option></select></label>
        <button type="button" id="scr-export">Export scan</button>
      </div>
    </div>
    <p class="muted small scr-ribbon">NSE delivery data · ${n0(info.stocks)} stocks · ${n0(info.sessions)} sessions · ${longDate(info.first)} to ${longDate(info.asof)} · updated every evening${info.market_cap_asof ? ` · market caps: Accumulation Lab snapshot of ${longDate(info.market_cap_asof)} (${n0(info.market_cap_count)} names), scaled by each day's close` : " · market caps: Stage Lab (BSE)"}</p>
    <div class="scr-stats" id="scr-stats"></div>
    <div class="scr-work">
      <section class="scr-list">
        <div class="scr-toolbar">
          <input type="search" id="scr-q" placeholder="Find a stock" aria-label="Find a stock" value="${esc(st.q)}">
          <select id="scr-filter" aria-label="Filter">${cfg.filters.map(([v, l]) => `<option value="${v}" ${v === st.filter ? "selected" : ""}>${l}</option>`).join("")}</select>
          <select id="scr-sort" aria-label="Sort by">${cfg.sorts.map(([v, l]) => `<option value="${v}" ${v === st.sort ? "selected" : ""}>${l}</option>`).join("")}</select>
          <select id="scr-dir" aria-label="Sort direction"><option value="desc" ${st.dir === "desc" ? "selected" : ""}>Highest first</option><option value="asc" ${st.dir === "asc" ? "selected" : ""}>Lowest first</option></select>
        </div>
        <p class="rowcount" id="scr-caption">${cfg.caption}</p>
        <div class="scr-table-wrap"><table class="scr-table"><thead><tr><th scope="col">Stock</th>${cfg.cols.map((c) => `<th scope="col" class="${c.num ? "num" : ""}">${c.label}</th>`).join("")}</tr></thead><tbody id="scr-rows"></tbody></table></div>
        <div class="scr-pager"><span id="scr-count" class="muted small"></span>
          <span><label class="muted small">Show <select id="scr-size">${[25, 50, 100, "all"].map((n) => `<option value="${n}" ${String(n) === String(st.size) ? "selected" : ""}>${n === "all" ? "All" : n}</option>`).join("")}</select></label>
          <button type="button" id="scr-prev" aria-label="Previous page">←</button><button type="button" id="scr-next" aria-label="Next page">→</button></span></div>
      </section>
      <section class="scr-detail" id="scr-detail" aria-live="polite"><p class="muted">Select a stock to see its details.</p></section>
    </div>
    <div id="scr-below"></div>`;

  $("#scr-q").oninput = (e) => { st.q = e.target.value; st.page = 0; drawList(); };
  $("#scr-filter").onchange = (e) => { st.filter = e.target.value; st.page = 0; drawStats(); drawList(); };
  $("#scr-sort").onchange = (e) => { st.sort = e.target.value; drawList(); };
  $("#scr-dir").onchange = (e) => { st.dir = e.target.value; drawList(); };
  $("#scr-size").onchange = (e) => { st.size = e.target.value === "all" ? "all" : +e.target.value; st.page = 0; drawList(); };
  $("#scr-prev").onclick = () => { st.page = Math.max(0, st.page - 1); drawList(); };
  $("#scr-next").onclick = () => { st.page += 1; drawList(); };
  $("#scr-export").onclick = () => exportScan(kind, data);
  drawStats();
  const rows = drawList();
  if (!rows.some((r) => r.symbol === st.selected)) st.selected = rows[0]?.symbol || null;
  if (st.selected) select(st.selected, { scroll: false });
  else showEmpty();
};

function filtered() {
  const { results } = st.data[st.kind];
  const q = st.q.trim().toLowerCase();
  return results.filter((r) => {
    if (q && !(r.symbol.toLowerCase().includes(q) || (r.name || "").toLowerCase().includes(q))) return false;
    return st.filter === "all" || r.status === st.filter;
  });
}

function sortVal(r, k) {
  if (k === "score") return r.score;
  if (k === "marketCapCrore") return capOf(r);
  return r.metrics?.[k];
}

function drawStats() {
  const cfg = SCREENERS[st.kind], rs = st.data[st.kind].results;
  $("#scr-stats").innerHTML = cfg.stats(rs).map(([key, title, n, sub]) =>
    `<button type="button" class="scr-stat ${st.filter === key && key !== "all" ? "on" : ""}" data-f="${key}"><span>${title}</span><strong>${n0(n)}</strong><small>${sub}</small></button>`).join("");
  document.querySelectorAll(".scr-stat").forEach((b) => (b.onclick = () => {
    st.filter = b.dataset.f === st.filter ? "all" : b.dataset.f; st.page = 0;
    $("#scr-filter").value = st.filter; drawStats(); drawList();
  }));
}

function drawList() {
  const cfg = SCREENERS[st.kind], dir = st.dir === "asc" ? 1 : -1;
  const rows = filtered().sort((a, b) => {
    const x = sortVal(a, st.sort), y = sortVal(b, st.sort);
    const xn = fin(x) ? x : -Infinity, yn = fin(y) ? y : -Infinity;
    return (xn - yn) * dir || a.symbol.localeCompare(b.symbol);
  });
  const size = st.size === "all" ? rows.length || 1 : st.size;
  const pages = Math.max(1, Math.ceil(rows.length / size));
  st.page = Math.min(st.page, pages - 1);
  const shown = rows.slice(st.page * size, st.page * size + size);
  $("#scr-rows").innerHTML = shown.length ? shown.map((r) => `<tr class="${r.symbol === st.selected ? "on" : ""}" data-s="${esc(r.symbol)}" tabindex="0">
      <td class="scr-who"><b>${esc(displayName(r))}</b><span class="tick">${esc(r.symbol)}</span><small class="${qualified(r) ? "q" : ""}">${qualified(r) ? "Qualified" : "Below threshold"}${capOf(r) == null ? " · market cap n/a" : ""}</small></td>
      ${cfg.cols.map((c) => `<td class="${c.num ? "num" : ""}">${c.v(r)}</td>`).join("")}</tr>`).join("")
    : `<tr><td colspan="${cfg.cols.length + 1}" class="empty">No stocks match this view. Try another filter or search.</td></tr>`;
  $("#scr-count").textContent = rows.length ? `${n0(st.page * size + 1)}–${n0(Math.min((st.page + 1) * size, rows.length))} of ${n0(rows.length)} stocks` : "0 stocks";
  $("#scr-prev").disabled = st.page === 0;
  $("#scr-next").disabled = st.page >= pages - 1;
  document.querySelectorAll("#scr-rows tr[data-s]").forEach((tr) => {
    const go = () => select(tr.dataset.s, { scroll: true });
    tr.onclick = go;
    tr.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
  });
  return rows;
}

function showEmpty() {
  $("#scr-detail").innerHTML = `<p class="muted">No stocks qualify in this view. Widen the filter to inspect other names.</p>`;
  $("#scr-below").innerHTML = "";
}

/* ---------- detail ---------- */
async function select(symbol, { scroll }) {
  st.selected = symbol;
  document.querySelectorAll("#scr-rows tr[data-s]").forEach((tr) => tr.classList.toggle("on", tr.dataset.s === symbol));
  history.replaceState(null, "", `#/screener/${st.kind}?s=${encodeURIComponent(symbol)}`);
  const item = st.data[st.kind].results.find((r) => r.symbol === symbol);
  if (!item) return;
  const box = $("#scr-detail");
  box.innerHTML = `<p class="muted">Loading ${esc(symbol)}…</p>`;
  let doc;
  try { doc = await load(`dseries/${item.file}.json`); }
  catch { box.innerHTML = `<p class="muted">This stock's daily file didn't load. Reload to try again.</p>`; return; }
  if (st.selected !== symbol) return;
  const asof = st.data[st.kind].info.asof;
  const meta = { symbol, name: item.name, file: item.file, page: item.page, ...(capOf(item) == null ? {} : { marketCapCrore: capOf(item) }) };
  const r = st.kind === "match" ? matchStock(toRows(doc), asof, meta) : dailyScoreStock(toRows(doc), asof, meta);
  if (!r) { box.innerHTML = `<p class="muted">${esc(symbol)} has too little history for this screener.</p>`; return; }
  st.detail = r;
  st.cleanups.splice(0).forEach((f) => { try { f(); } catch { /* already gone */ } });
  if (st.kind === "match") renderMatch(r, item); else renderDaily(r, item);
  if (scroll && window.innerWidth < 1100) box.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

function header(r, item, scoreText) {
  const pageLink = item.page ? `<a class="btn" href="#/stock/${encodeURIComponent(item.page)}">Stage Lab page</a>` : "";
  return `<div class="scr-dhead">
      <div><h2 class="scr-sym">${esc(displayName(item))} <span class="tick">${esc(r.symbol)}</span></h2><p class="muted small">${longDate(r.latest.date)}</p><p class="small">${capLine(r)}</p></div>
      <div class="scr-score"><strong>${scoreText}</strong><span class="${qualified(r) ? "q" : "muted"}">${qualified(r) ? "Qualified" : "Below threshold"}</span></div>
    </div>
    <div class="scr-actions"><button type="button" id="scr-watch">Watch</button><a class="btn" href="#/journal/new?s=${encodeURIComponent("NSE:" + r.symbol)}">Log a trade</a>${pageLink}<button type="button" id="scr-dl">Download Excel-compatible analysis</button></div>`;
}

function wireHeader(r, filename) {
  const key = "NSE:" + r.symbol;
  const watchBtn = $("#scr-watch");
  if (typeof watchDialog === "function") {
    watchBtn.onclick = () => watchDialog({ key, close: r.latest.close }).then(() => markIt()).catch((e) => toast(esc(e.message), true));
    const markIt = async () => {
      if (typeof db !== "function" || !db() || !(await currentUser())) return;
      const q = await db().from("watchlist_items").select("id").eq("key", key).limit(1);
      const yes = !q.error && q.data.length > 0;
      watchBtn.textContent = yes ? "Watching" : "Watch"; watchBtn.setAttribute("aria-pressed", yes);
    };
    markIt().catch(() => {});
  } else watchBtn.hidden = true;
  $("#scr-dl").onclick = () => {
    const t = $(".scr-analysis table");
    download(filename, `<html><head><meta charset="utf-8"></head><body>${t.outerHTML}</body></html>`, "application/vnd.ms-excel");
  };
}

function conditionsTable(conds, withBlock) {
  return `<div class="scr-scroll"><table class="plain scr-mini"><thead><tr>${withBlock ? "<th>Block</th>" : "<th>Group</th>"}<th>Condition</th><th class="num">Actual</th><th>Required</th><th>Result</th></tr></thead><tbody>${conds.map((c) =>
    `<tr><td>${withBlock ? c.block : esc(c.group)}</td><td>${esc(c.kind || c.name)}</td><td class="num">${fin(c.value) ? nf(c.value, Number.isInteger(c.value) ? 0 : 2) : "–"}</td><td>${esc(c.operator)} ${c.threshold}</td><td class="${c.passed ? "up" : "down"}">${c.passed ? "Pass" : "Fail"}</td></tr>`).join("")}</tbody></table></div>`;
}

const MATCH_COLS = [["Date", "date"], ["Change %", "change"], ["Close", "close"], ["Closs %", "closs"], ["Closss %", "closss"], ["P T V", "ptv"],
  ["Turnover ₹cr", "turnover"], ["Volume ratio", "volumeRatio"], ["PTV / SMA(20)", "ptvRatio"], ["PDV", "pdv"], ["PDV SMA(15)", "pdvSMA15"],
  ["PDV SMA(45)", "pdvSMA45"], ["PDV/SMA(20)", "pdvRatio"], ["30 days", "blockCounts"], ["PDV sums", "blockSums"], ["D ≥ T (10)", "dGreaterT"],
  ["D ≥ T ≥ V (21)", "dGreaterTGreaterV"], ["D ≥ T ≥ V (prev)", "dGreaterTGreaterV2"], ["D ≥ 1 (40)", "dAtLeast1"], ["D ≥ 2 (40)", "dAtLeast2"],
  ["1 day ratio", "oneDay"], ["Return %", "return"], ["30D return %", "return30"]];

function renderMatch(r, item) {
  const box = $("#scr-detail");
  box.innerHTML = `${header(r, item, `${r.score} / 12`)}
    ${r.issues.length ? `<p class="notice small">${esc(r.issues.join(" "))}</p>` : ""}
    <p class="muted small">PDV ratio = delivery per trade ÷ its 20-session average, including the current session.</p>
    ${priceBlock()}
    <details class="scr-conds"><summary>The 12 conditions (${r.score} passed)</summary>${conditionsTable(r.conditions, true)}
      <p class="muted small">Blocks are five sessions each, newest first. Days with PDV ratio ≥ 1 must reach ${COUNT_LIMITS.join(", ")}; PDV sums must be ≥ ${SUM_LIMITS.slice(0, 4).join(", ")} for blocks 1–4 and ≤ ${SUM_LIMITS.slice(4).join(", ")} for blocks 5–6.</p></details>`;
  const metrics = Object.entries(matchExport(r)).filter(([k]) => !["SYMBOL", "DATE", "Match_Score"].includes(k));
  const rows = r.analysisRows.slice().reverse();
  $("#scr-below").innerHTML = `
    <section class="scr-full"><h2>PDV trend</h2><p class="muted small">Delivery per trade with its 15- and 45-session averages, over the full history held for this stock.</p>
      <div class="legend" style="margin:0 0 6px"><span><i style="background:var(--c1)"></i>SMA(15)</span><span><i style="background:var(--c2)"></i>SMA(45)</span></div>
      <div id="scr-pdv" class="chart mid"></div></section>
    <section class="scr-full"><h2>Daily analysis table</h2><p class="muted small">Every field from the analysis, newest session first. The return columns look forward from each date, so they are history, not a forecast.</p>
      <div class="scr-analysis"><table><thead><tr>${MATCH_COLS.map(([h]) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((q) =>
        `<tr>${MATCH_COLS.map(([, k]) => `<td>${k === "date" ? q.date : fin(q[k]) ? n2(q[k]) : esc(q[k] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div></section>
    <section class="scr-full"><h2>Screening metrics</h2>
      <table class="plain scr-metrics"><tbody>${metrics.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v ?? "Unavailable")}</td></tr>`).join("")}</tbody></table>
      <details class="scr-conds"><summary>Stock analysis score: ${r.analysisScore} of ${r.analysisConditions.length}</summary>${conditionsTable(r.analysisConditions.map((c) => ({ ...c, group: "" })), false)}</details>
      <p class="muted small">D ≥ T ≥ V counts the latest 21 sessions where normalised delivery per trade ≥ normalised volume per trade ≥ normalised volume. It adds no points. D ≥ 1 and PDV ratio ≥ 2 count over 40 sessions; D ≥ T over 10. The six PDV sums are rounded to two decimals before scoring. Turnover is in ₹ crore.</p>
      <p class="muted small">Each stock's latest available day is used. The accumulation screener's liquidity and price-pattern exclusions do not apply here. A research tool, not investment advice.</p></section>`;
  wireHeader(r, `${r.symbol}-daily-analysis.xls`);
  drawPrice(r.analysisRows);
  drawPdv(r.analysisRows);
}

const DAILY_COLS = [["Date", "date", 0], ["Change %", "change", 2], ["Close", "close", 2], ["PTVr", "ptvRatio", 2], ["PDVr", "pdvRatio", 2], ["VOLr", "volumeRatio", 2], ["z21", "z21", 0], ["mom10", "mom10", 1]];

function renderDaily(r, item) {
  const m = r.metrics;
  $("#scr-detail").innerHTML = `${header(r, item, `${r.score} / ${DAILY_SCORE_MAX}`)}
    <p class="muted small">PDV_PERSIST+MOM: z21 > 15 (sessions with PDVr ≥ 1 in the last 21) and 10-session compounded close return ≥ 8%. EQ/BE only, at least 30 sessions, must have traded on the as-of date.</p>
    ${r.issues.length ? `<p class="notice small">${esc(r.issues.join(" "))}</p>` : ""}
    ${conditionsTable(r.conditions, false)}
    <div class="scr-strip">${[["Change", n2(m.change) + "%"], ["PTVr", n2(m.ptvRatio)], ["PDVr", n2(m.pdvRatio)], ["VOLr", n2(m.volumeRatio)], ["z21", n0(m.z21)], ["mom10", n1(m.mom10) + "%"]]
      .map(([l, v]) => `<div><span>${l}</span>${v}</div>`).join("")}</div>
    ${priceBlock()}`;
  const rows = r.analysisRows.slice().reverse();
  $("#scr-below").innerHTML = `<section class="scr-full"><h2>Daily ratios</h2><p class="muted small">Newest session first. Ratios use a 20-session average that includes the current session. z21 counts days with PDVr ≥ 1 in the latest 21 sessions.</p>
    <div class="scr-analysis"><table><thead><tr>${DAILY_COLS.map(([h]) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((q) =>
      `<tr>${DAILY_COLS.map(([, k, d]) => `<td>${k === "date" ? q.date : nf(q[k], d)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    <p class="muted small">A research tool, not investment advice.</p></section>`;
  wireHeader(r, `${r.symbol}-pdv-persist.xls`);
  drawPrice(r.analysisRows);
}

/* ---------- charts ---------- */
function priceBlock() {
  return `<div class="chart-head" style="margin-top:16px"><h3 style="margin:0">Price &amp; delivery</h3><div class="ranges" id="scr-rng">${[30, 90, 180, 365]
    .map((n) => `<button type="button" data-n="${n}" aria-pressed="${n === st.lookback}">${n}D</button>`).join("")}</div></div>
    <div id="scr-price" class="chart scr-price"></div>
    <div class="legend"><span>Daily candles, ₹</span><span><i style="background:var(--c1)"></i>Delivery vs its previous 60-session average (bars; darker at 1.5× or more)</span><span>Hover for daily values</span></div>`;
}

/* Delivery relative to the preceding 60-session mean, as Accumulation Lab's chart shows it. */
function deliveryRatio(rows) {
  return rows.map((q, j) => {
    if (j < 60) return null;
    const w = rows.slice(j - 60, j).map((x) => x.delivery);
    if (!w.every(fin)) return null;
    const m = w.reduce((a, b) => a + b, 0) / 60;
    return fin(q.delivery) && m > 0 ? q.delivery / m : null;
  });
}

function drawPrice(all) {
  const el = $("#scr-price");
  if (!el || !window.LightweightCharts) { if (el) el.innerHTML = `<p class="empty" style="padding:16px">The chart library didn't load. Reload to try again.</p>`; return; }
  const rd = deliveryRatio(all);
  const n = Math.min(st.lookback, all.length);
  const rows = all.slice(-n), rdv = rd.slice(-n);
  el.innerHTML = "";
  el.style.position = "relative";
  const chart = LightweightCharts.createChart(el, chartOpts(el, { crosshair: { mode: 0 } }));
  const ro = new ResizeObserver(() => { if (el.isConnected && el.clientWidth) chart.applyOptions({ width: el.clientWidth }); });
  const dispose = () => { ro.disconnect(); chart.remove(); };
  st.cleanups.push(dispose);
  const candles = chart.addCandlestickSeries({ upColor: cssVar("--up"), downColor: cssVar("--down"), wickUpColor: cssVar("--up"), wickDownColor: cssVar("--down"), borderVisible: false, priceLineVisible: false });
  candles.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.3 } });
  candles.setData(rows.map((q) => (fin(q.close) ? { time: q.date, open: q.open ?? q.close, high: q.high ?? q.close, low: q.low ?? q.close, close: q.close } : { time: q.date })));
  const bars = chart.addHistogramSeries({ priceScaleId: "dl", priceLineVisible: false, lastValueVisible: false, priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
  chart.priceScale("dl").applyOptions({ scaleMargins: { top: 0.76, bottom: 0 }, visible: false });
  const c1 = cssVar("--c1"), soft = cssVar("--rule-strong");
  bars.setData(rows.map((q, i) => (fin(rdv[i]) ? { time: q.date, value: rdv[i], color: rdv[i] >= 1.5 ? c1 : soft } : { time: q.date })));
  chart.timeScale().fitContent();
  const tip = document.createElement("div");
  tip.className = "tip"; tip.hidden = true; el.appendChild(tip);
  const byDate = new Map(rows.map((q, i) => [q.date, [q, rdv[i]]]));
  chart.subscribeCrosshairMove((p) => {
    if (!p.time || !p.point || p.point.x < 0 || p.point.y < 0) { tip.hidden = true; return; }
    const hit = byDate.get(p.time);
    if (!hit) { tip.hidden = true; return; }
    const [q, r] = hit;
    tip.innerHTML = `<div class="tip-d">${longDate(q.date)}</div>O ${n2(q.open)} · H ${n2(q.high)} · L ${n2(q.low)} · C ${n2(q.close)}<br>Volume ${n0(q.volume)} · Delivery ${n0(q.delivery)} · Trades ${n0(q.trades)}<br>Delivery vs 60-day average ${fin(r) ? n2(r) + "×" : "–"}${fin(q.pdvRatio) ? ` · PDV ratio ${n2(q.pdvRatio)}` : ""}`;
    tip.hidden = false;
    const x = Math.min(p.point.x + 14, el.clientWidth - tip.offsetWidth - 4);
    tip.style.left = `${Math.max(4, x)}px`; tip.style.top = "8px";
  });
  ro.observe(el);
  document.querySelectorAll("#scr-rng button").forEach((b) => (b.onclick = () => {
    st.lookback = +b.dataset.n;
    document.querySelectorAll("#scr-rng button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    st.cleanups = st.cleanups.filter((f) => f !== dispose);
    try { dispose(); } catch { /* gone */ }
    drawPrice(all);
  }));
}

function drawPdv(rows) {
  const el = $("#scr-pdv");
  if (!el || !window.LightweightCharts) return;
  if (!rows.some((q) => fin(q.pdvSMA15) || fin(q.pdvSMA45))) { el.outerHTML = `<p class="muted">Not enough trade history for SMA(15)/SMA(45).</p>`; return; }
  const data = { d: rows.map((q) => q.date), a: rows.map((q) => (fin(q.pdvSMA15) ? q.pdvSMA15 : null)), b: rows.map((q) => (fin(q.pdvSMA45) ? q.pdvSMA45 : null)) };
  tsChart(el, data, [{ key: "a", label: "SMA(15)", color: cssVar("--c1") }, { key: "b", label: "SMA(45)", color: cssVar("--c2") }], { precision: 2, fmt: (v) => n2(v) });
}

/* ---------- downloads ---------- */
function download(name, body, type) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
/* CSV cell: quoted, and text that a spreadsheet would run as a formula is neutralised. */
const cell = (v) => {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
};
async function exportScan(kind, data) {
  const asof = data.info.asof;
  const btn = $("#scr-export");
  btn.disabled = true; btn.textContent = "Preparing…";
  try {
    // The export needs each stock's block detail, so recompute from the daily files shown in the current view.
    const list = filtered(), out = new Array(list.length);
    let next = 0;
    const work = async () => {
      while (next < list.length) {
        const i = next++, it = list[i];
        btn.textContent = `Preparing ${n0(i + 1)} of ${n0(list.length)}…`;
        const doc = await fetch(`data/dseries/${it.file}.json`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
        if (!doc) continue;
        const meta = { symbol: it.symbol, name: it.name, ...(capOf(it) == null ? {} : { marketCapCrore: capOf(it) }) };
        const r = kind === "match" ? matchStock(toRows(doc), asof, meta) : dailyScoreStock(toRows(doc), asof, meta);
        if (r) out[i] = kind === "match" ? matchExport(r) : dailyScoreExport(r);
      }
    };
    await Promise.all(Array.from({ length: 8 }, work));
    const rowsOut = out.filter(Boolean);
    if (!rowsOut.length) { toast("Nothing to export in this view."); return; }
    const cols = Object.keys(rowsOut[0]);
    const csv = [cols.map(cell).join(","), ...rowsOut.map((o) => cols.map((c) => cell(o[c])).join(","))].join("\r\n");
    download(`${kind === "match" ? "match-score" : "pdv-persist-mom"}-${asof}.csv`, "﻿" + csv, "text/csv;charset=utf-8");
  } finally { btn.disabled = false; btn.textContent = "Export scan"; }
}
