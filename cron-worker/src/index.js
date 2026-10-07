// Every 20 minutes on weekday evenings (IST): if the live site doesn't show today's close yet,
// and no update is running or started in the last 45 minutes, start the `daily-update` workflow.
// Needs the secret GH_TOKEN (GitHub fine-grained token, stage-lab only, Actions: read and write).
const REPO = "smartyankit21/stage-lab", WORKFLOW = "daily.yml", SITE = "https://stage-lab.pages.dev", RETRY_MIN = 45;

const gh = (env, path, init = {}) => fetch(`https://api.github.com/repos/${REPO}${path}`, {
  ...init,
  headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GH_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "stage-lab-nightly", ...(init.headers || {}) },
});
const ist = () => new Date(Date.now() + 5.5 * 3600e3);

async function check(env, force = false) {
  if (!env.GH_TOKEN) return "GH_TOKEN secret is not set";
  const now = ist(), today = now.toISOString().slice(0, 10);
  if (!force && now.getUTCHours() < 18) return "after midnight IST: nothing to do";
  const shown = await fetch(`${SITE}/data/summary.json?t=${Date.now()}`).then((r) => (r.ok ? r.json() : null)).then((s) => s?.date).catch(() => null);
  if (shown === today && !force) return `site already shows ${today}`;
  const r = await gh(env, `/actions/workflows/${WORKFLOW}/runs?branch=main&per_page=1`);
  if (!r.ok) return `GitHub said ${r.status} when listing runs`;
  if (force) {
    const w = await gh(env, `/actions/workflows/${WORKFLOW}`);
    return `self-test: site shows ${shown} (today ${today}); GitHub key works: ${r.ok && w.ok ? "yes" : "no"}; nothing was started`;
  }
  const run = (await r.json()).workflow_runs?.[0];
  if (run && run.status !== "completed") return "an update is already running";
  if (run && Date.now() - Date.parse(run.run_started_at || run.created_at) < RETRY_MIN * 60e3) return "an update ran recently; will retry later";
  const d = await gh(env, `/actions/workflows/${WORKFLOW}/dispatches`, { method: "POST", body: JSON.stringify({ ref: "main" }) });
  return d.ok ? `started the update (site showed ${shown}, today ${today})` : `GitHub refused to start it: ${d.status}`;
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(check(env).then((m) => console.log(m))); },
  // Visiting the worker's address runs a safe self-test (never starts an update).
  async fetch(req, env) { return new Response(await check(env, true), { headers: { "content-type": "text/plain" } }); },
};
