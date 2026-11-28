// Turns one Stage Lab delivery file (column arrays) back into the row objects Accumulation Lab's
// screener code expects (same field names as its engine.mjs normalizeRows).
export function toRows(doc) {
  const n = doc.d.length, out = new Array(n), series = i => Array.isArray(doc.s) ? doc.s[i] : doc.s;
  for (let i = 0; i < n; i++) {
    out[i] = {
      symbol: doc.symbol, series: series(i), date: doc.d[i], prevClose: doc.pc[i],
      open: doc.o[i], high: doc.h[i], low: doc.l[i], close: doc.c[i], volume: doc.v[i],
      delivery: doc.dq[i], trades: doc.t[i], turnover: doc.to[i]
    };
  }
  return out;
}
