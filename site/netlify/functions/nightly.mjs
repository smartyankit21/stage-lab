// Reliable evening update. GitHub's own timer often starts the daily job hours late (or skips it),
// so Netlify's scheduler checks every 20 minutes from 6:30 pm to 12:30 am IST on weekdays:
//   - if the live site already shows today's close, it does nothing;
//   - otherwise, if no update is running and none started in the last 45 minutes, it starts one.
// Needs the same GH_TOKEN environment variable as the Refresh button (Actions: read and write).
const REPO = "smartyankit21/stage-lab", WORKFLOW = "daily.yml", RETRY_MIN = 45;

const gh = (path, init = {}) => fetch(`https://api.github.com/repos/${REPO}${path}`, {
  ...init,
  headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${process.env.GH_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "stage-lab-nightly", ...(init.headers || {}) },
});
const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

export default async () => {
  if (!process.env.GH_TOKEN) { console.log("GH_TOKEN not set"); return; }
  const today = istToday();
  const site = process.env.URL || "https://stage-lab-tkku.netlify.app";
  const shown = await fetch(`${site}/data/summary.json?t=${Date.now()}`).then((r) => (r.ok ? r.json() : null)).then((s) => s?.date).catch(() => null);
  if (shown === today) { console.log(`site already shows ${today}`); return; }
  const r = await gh(`/actions/workflows/${WORKFLOW}/runs?branch=main&per_page=1`);
  const run = r.ok ? (await r.json()).workflow_runs?.[0] : null;
  if (run && run.status !== "completed") { console.log("update already running"); return; }
  if (run && Date.now() - Date.parse(run.run_started_at || run.created_at) < RETRY_MIN * 60e3) { console.log("an update ran recently; waiting before retrying"); return; }
  const d = await gh(`/actions/workflows/${WORKFLOW}/dispatches`, { method: "POST", body: JSON.stringify({ ref: "main" }) });
  console.log(d.ok ? `started update (site shows ${shown}, today ${today})` : `GitHub refused: ${d.status}`);
};

// 13:00–18:59 UTC = 6:30 pm–12:29 am IST, Monday to Friday, every 20 minutes
export const config = { schedule: "*/20 13-18 * * 1-5" };
