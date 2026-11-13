// "Refresh" button backend. GET: is an update running, and when did the last one finish?
// POST: start the daily update now (only on main, and not if one is running or started in the last 10 minutes).
// Needs the Netlify environment variable GH_TOKEN: a GitHub fine-grained token for smartyankit21/stage-lab
// with "Actions: Read and write" only. The token never reaches the browser.
const REPO = "smartyankit21/stage-lab", WORKFLOW = "daily.yml", GAP_MIN = 10;

const gh = (path, init = {}) => fetch(`https://api.github.com/repos/${REPO}${path}`, {
  ...init,
  headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${process.env.GH_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "stage-lab-refresh", ...(init.headers || {}) },
});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function latest() {
  const r = await gh(`/actions/workflows/${WORKFLOW}/runs?branch=main&per_page=1`);
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const run = (await r.json()).workflow_runs?.[0];
  return run ? { status: run.status, conclusion: run.conclusion, started: run.run_started_at || run.created_at, updated: run.updated_at } : null;
}

export default async (req) => {
  if (!process.env.GH_TOKEN) return json({ error: "not-configured" }, 503);
  try {
    let run = await latest();
    const running = run && run.status !== "completed";
    if (req.method !== "POST") return json({ running, run });
    const recent = run && Date.now() - Date.parse(run.started) < GAP_MIN * 60e3;
    if (running || recent) return json({ started: false, running, run, reason: running ? "running" : "recent" });
    const d = await gh(`/actions/workflows/${WORKFLOW}/dispatches`, { method: "POST", body: JSON.stringify({ ref: "main" }) });
    if (!d.ok) return json({ error: `GitHub ${d.status}` }, 502);
    return json({ started: true, running: true, run: { status: "queued", started: new Date().toISOString() } });
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }
};

export const config = { path: "/api/refresh" };
