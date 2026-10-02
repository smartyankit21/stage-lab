// Runs Accumulation Lab's own screener code on Stage Lab's delivery files and writes the lists.
//   node engine/run_screeners.mjs [site/data]
// Reads  <out>/screener/master.json and <out>/dseries/*.json (written by engine/screener_data.py)
// Writes <out>/screener/match.json and <out>/screener/pdv_persist.json
import {readFileSync, writeFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {scanMatch} from '../site/screeners/match-score.mjs';
import {scanDailyScore} from '../site/screeners/daily-screener.mjs';
import {toRows} from '../site/screeners/rows.mjs';

const out = process.argv[2] || 'site/data';
const {info, stocks: master} = JSON.parse(readFileSync(join(out, 'screener', 'master.json'), 'utf8'));
const rows = [];
for (const f of readdirSync(join(out, 'dseries'))) {
  if (!f.endsWith('.json')) continue;
  rows.push(...toRows(JSON.parse(readFileSync(join(out, 'dseries', f), 'utf8'))));
}
const asof = info.asof;
const pick = (r, extra = {}) => ({
  symbol: r.symbol, status: r.status, score: r.score, observations: r.observations, issues: r.issues,
  name: r.meta?.name || null, file: r.meta?.file || null, page: r.meta?.page || null,
  latest: {date: r.latest.date, close: r.latest.close}, metrics: r.metrics, ...extra
});
const t0 = Date.now();
const match = scanMatch(rows, asof, master).map(r => pick(r, {analysisScore: r.analysisScore}));
const t1 = Date.now();
const persist = scanDailyScore(rows, asof, master).map(r => pick(r, {persistScore: r.persistScore, signalLabel: r.signalLabel}));
const t2 = Date.now();
const meta = {...info, computed_at: new Date().toISOString()};
writeFileSync(join(out, 'screener', 'match.json'), JSON.stringify({info: meta, results: match}));
writeFileSync(join(out, 'screener', 'pdv_persist.json'), JSON.stringify({info: meta, results: persist}));
const q = a => a.filter(r => r.status === 'candidate').length;
console.log(`screeners as of ${asof}: Match Score ${match.length} stocks, ${q(match)} qualified (${t1 - t0} ms); ` +
  `PDV_Persist+Mom ${persist.length} stocks, ${q(persist)} qualified (${t2 - t1} ms)`);
