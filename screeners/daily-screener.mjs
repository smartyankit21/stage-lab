// PDV_Persist+Mom. Copied verbatim from Accumulation Lab (accumulation-lab-ankit.pages.dev/daily-screener.mjs),
// read on 2 Oct 2026. Do not edit the calculation here; change it in Accumulation Lab first and copy it again.
const finite = Number.isFinite;
export const LOOKBACK = 30;
export const SMA_WINDOW = 20;
export const Z_WINDOW = 21;
export const Z_THRESH = 15;
export const MOM_WINDOW = 10;
export const MOM_THRESH = 8;
export const DAILY_SCORE_MAX = 2;

const ratio = (a, b) => finite(a) && finite(b) && b !== 0 ? a / b : null;
const windowReady = (values, i, n) => {
  if (i < n - 1) return null;
  const slice = values.slice(i - n + 1, i + 1);
  return slice.every(finite) ? slice : null;
};
const rollingMean = (values, i, n) => {
  const slice = windowReady(values, i, n);
  return slice ? slice.reduce((s, v) => s + v, 0) / n : null;
};
const rollingSum = (values, i, n) => {
  const slice = windowReady(values, i, n);
  return slice ? slice.reduce((s, v) => s + v, 0) : null;
};

function seriesOk(row) {
  return !row.series || row.series === 'EQ' || row.series === 'BE';
}

export function classifyDaily(row) {
  const signals = [];
  if (finite(row.z21) && row.z21 > Z_THRESH && finite(row.mom10) && row.mom10 >= MOM_THRESH) {
    signals.push('PDV_PERSIST+MOM');
  }
  return {signals};
}

export function dailyConditions(metrics) {
  const zPass = finite(metrics.z21) && metrics.z21 > Z_THRESH;
  const momPass = finite(metrics.mom10) && metrics.mom10 >= MOM_THRESH;
  const conditions = [
    {group: 'PDV_PERSIST+MOM', name: 'z21 > 15', value: metrics.z21, operator: '>', threshold: Z_THRESH, passed: zPass},
    {group: 'PDV_PERSIST+MOM', name: '10-day momentum ≥ 8%', value: metrics.mom10, operator: '≥', threshold: MOM_THRESH, passed: momPass}
  ];
  return {
    conditions,
    score: conditions.filter(c => c.passed).length,
    persistScore: [zPass, momPass].filter(Boolean).length,
    persistMom: zPass && momPass
  };
}

function datedSeries(input, asof) {
  const byDate = new Map();
  for (const row of input) {
    if (!row?.date || row.date > asof || !seriesOk(row)) continue;
    const prior = byDate.get(row.date);
    if (prior?.series === 'EQ' && row.series !== 'EQ') continue;
    byDate.set(row.date, row);
  }
  const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length < LOOKBACK) return null;
  if (rows.at(-1).date !== asof) return null;
  return rows;
}

function assessDaily(input, asof, meta, requireSignal) {
  const rows = datedSeries(input, asof);
  if (!rows) return null;
  const latest = rows.at(-1);
  const trades = rows.map(r => finite(r.trades) && r.trades !== 0 ? r.trades : null);
  const ptv = rows.map((r, i) => ratio(r.volume, trades[i]));
  const pdv = rows.map((r, i) => ratio(r.delivery, trades[i]));
  const ptvRatio = ptv.map((v, i) => ratio(v, rollingMean(ptv, i, SMA_WINDOW)));
  const pdvRatio = pdv.map((v, i) => ratio(v, rollingMean(pdv, i, SMA_WINDOW)));
  const volumeRatio = rows.map((r, i) => ratio(r.volume, rollingMean(rows.map(q => q.volume), i, SMA_WINDOW)));
  const change = rows.map(r => {
    const prev = finite(r.prevClose) ? r.prevClose : null;
    return ratio((r.close - prev) * 100, prev);
  });
  const pdvGe1 = pdvRatio.map(v => finite(v) && v >= 1 ? 1 : 0);
  const z21 = pdvGe1.map((_, i) => rollingSum(pdvGe1, i, Z_WINDOW));
  const idx = [];
  for (let i = 0; i < rows.length; i++) {
    const factor = finite(change[i]) ? 1 + change[i] / 100 : null;
    if (!finite(factor) || (i && !finite(idx[i - 1]))) idx.push(null);
    else idx.push(i === 0 ? 100 * factor : idx[i - 1] * factor);
  }
  const mom10 = idx.map((v, i) => i < MOM_WINDOW ? null : ratio((v - idx[i - MOM_WINDOW]) * 100, idx[i - MOM_WINDOW]));
  const i = rows.length - 1;
  const metrics = {
    change: change[i],
    ptvRatio: ptvRatio[i],
    pdvRatio: pdvRatio[i],
    volumeRatio: volumeRatio[i],
    z21: z21[i],
    mom10: mom10[i]
  };
  const {signals} = classifyDaily(metrics);
  if (requireSignal && !signals.length) return null;
  const scored = dailyConditions(metrics);
  const analysisRows = rows.map((r, j) => ({
    date: r.date, open: r.open, high: r.high, low: r.low, close: r.close,
    prevClose: r.prevClose, volume: r.volume, delivery: r.delivery, trades: r.trades,
    change: change[j], ptvRatio: ptvRatio[j], pdvRatio: pdvRatio[j], volumeRatio: volumeRatio[j],
    z21: z21[j], mom10: mom10[j]
  }));
  const cap = finite(Number(meta?.marketCapCrore)) ? Number(meta.marketCapCrore) : null;
  const qualified = scored.persistMom;
  return {
    symbol: latest.symbol,
    asof,
    status: qualified ? 'candidate' : 'none',
    score: scored.score,
    persistScore: scored.persistScore,
    signals,
    signalLabel: signals.join(' + ') || 'None',
    conditions: scored.conditions,
    meta: meta ? {...meta, marketCapCrore: cap} : meta,
    latest,
    observations: rows.length,
    issues: rows.length < LOOKBACK + SMA_WINDOW ? ['Fewer than 50 observations: early SMA windows can be missing.'] : [],
    rows,
    analysisRows,
    metrics: {...metrics, marketCapCrore: cap}
  };
}

export function dailyStock(input, asof, meta = null) {
  return assessDaily(input, asof, meta, true);
}

export function dailyScoreStock(input, asof, meta = null) {
  return assessDaily(input, asof, meta, false);
}

function groupBySymbol(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.symbol)) groups.set(row.symbol, []);
    groups.get(row.symbol).push(row);
  }
  return groups;
}

export function scanDaily(rows, asof, master = []) {
  const names = new Map(master.map(m => [m.symbol, m]));
  return [...groupBySymbol(rows)].map(([, series]) => dailyStock(series, asof, names.get(series[0].symbol))).filter(Boolean)
    .sort((a, b) => (b.metrics.change ?? -Infinity) - (a.metrics.change ?? -Infinity) || a.symbol.localeCompare(b.symbol));
}

export function scanDailyScore(rows, asof, master = []) {
  const names = new Map(master.map(m => [m.symbol, m]));
  return [...groupBySymbol(rows)].map(([, series]) => dailyScoreStock(series, asof, names.get(series[0].symbol))).filter(Boolean)
    .sort((a, b) => b.score - a.score || (b.metrics.change ?? -Infinity) - (a.metrics.change ?? -Infinity) || a.symbol.localeCompare(b.symbol));
}

export function dailyScoreExport(r) {
  const m = r.metrics;
  const num = (v, d) => finite(v) ? Number(v.toFixed(d)) : '';
  return {
    DATE: r.asof,
    SYMBOL: r.symbol,
    SIGNALS: r.signalLabel,
    PDV_Persist_Mom: r.score,
    Qualified: r.status === 'candidate' ? 'YES' : 'NO',
    price_chg: num(m.change, 2),
    PTVr: num(m.ptvRatio, 2),
    PDVr: finite(m.pdvRatio) ? Number(m.pdvRatio.toFixed(2)) : '-',
    VOLr: num(m.volumeRatio, 2),
    z21: finite(m.z21) ? Math.trunc(m.z21) : '-',
    mom10: finite(m.mom10) ? Number(m.mom10.toFixed(1)) : '-',
    MARKET_CAP_CRORE: finite(m.marketCapCrore) ? Number(m.marketCapCrore.toFixed(2)) : ''
  };
}
