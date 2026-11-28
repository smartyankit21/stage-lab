// Copied verbatim from Accumulation Lab (accumulation-lab-ankit.pages.dev/market-cap.mjs), read on 2 Oct 2026.
// Market cap = Accumulation Lab's dated snapshot, scaled by each stock's NSE close on the as-of date.
const finite = Number.isFinite;

export function scaleMarketCap(snapshotCapCrore, snapshotClose, asofClose) {
  if (!finite(snapshotCapCrore) || !finite(snapshotClose) || !finite(asofClose) || snapshotClose === 0) return null;
  if (snapshotCapCrore <= 0 || asofClose <= 0) return null;
  return snapshotCapCrore * (asofClose / snapshotClose);
}

export function latestCloseOnOrBefore(rows, symbol, asof) {
  let best = null;
  for (const row of rows) {
    if (row.symbol !== symbol || row.date > asof) continue;
    if (row.series && row.series !== 'EQ') continue;
    if (!finite(row.close) || row.close <= 0) continue;
    if (!best || row.date >= best.date) best = {date: row.date, close: row.close};
  }
  return best;
}

export function attachMarketCaps(master = [], rows = [], asof, snapshot) {
  const records = snapshot?.records || snapshot?.stocks || [];
  const bySymbol = new Map(records.map(r => [r.symbol, r]));
  const closes = new Map();
  for (const row of rows) {
    if (!asof || row.date > asof) continue;
    if (row.series && row.series !== 'EQ') continue;
    if (!finite(row.close) || row.close <= 0) continue;
    const prior = closes.get(row.symbol);
    if (!prior || row.date >= prior.date) closes.set(row.symbol, {date: row.date, close: row.close});
  }
  const apply = (meta, snap, px) => {
    const scaled = snap ? scaleMarketCap(Number(snap.marketCapCrore), Number(snap.close), px?.close) : null;
    const raw = snap && finite(Number(snap.marketCapCrore)) ? Number(snap.marketCapCrore) : null;
    const prior = finite(Number(meta?.marketCapCrore)) ? Number(meta.marketCapCrore) : null;
    const cap = finite(scaled) ? scaled : (finite(raw) ? raw : prior);
    return {
      ...meta,
      marketCapCrore: finite(cap) ? cap : null,
      marketCapAsOf: finite(scaled) && px ? px.date : (finite(raw) ? snap.date || snap.asof || null : null),
      marketCapSnapshotDate: snap?.date || null,
      marketCapBasis: finite(scaled) ? 'snapshot-scaled-by-nse-close' : (finite(raw) ? 'snapshot' : meta?.marketCapBasis || null)
    };
  };
  const attached = master.map(meta => apply(meta, bySymbol.get(meta.symbol), closes.get(meta.symbol)));
  const seen = new Set(attached.map(m => m.symbol));
  for (const rec of records) {
    if (seen.has(rec.symbol)) continue;
    attached.push(apply({symbol: rec.symbol}, rec, closes.get(rec.symbol)));
  }
  return attached;
}
