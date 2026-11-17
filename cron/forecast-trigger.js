/**
 * CourtCast forecast timer (Cloudflare Worker with a Cron Trigger).
 *
 * GitHub's own schedule is best-effort and often runs hours late, so this Worker asks GitHub to
 * run the "Update forecast" workflow every 2 hours instead (the same as pressing "Run workflow").
 *
 * Setup (Cloudflare dashboard):
 *   1. Workers & Pages -> Create -> Worker -> name it "courtcast-forecast-timer" -> Deploy,
 *      then "Edit code", paste this file, Deploy.
 *   2. Settings -> Variables and Secrets -> add a Secret named GH_TOKEN: a GitHub fine-grained token
 *      with access to grant-jape/tennis-courtcast only, permission "Actions: Read and write".
 *   3. Settings -> Triggers -> Cron Triggers -> add:  15 *\/2 * * *   (every 2 hours, at :15, UTC)
 *
 * Opening the Worker's URL shows when it last ran (no secrets).
 */
const REPO = "grant-jape/tennis-courtcast";
const WORKFLOW = "update.yml";

async function runForecast(env) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "courtcast-forecast-timer",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  // GitHub answers 204 No Content when the run is queued.
  if (res.status !== 204) throw new Error(`GitHub said ${res.status}: ${await res.text()}`);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runForecast(env));   // errors show up in the Worker's Logs tab
  },
  async fetch() {
    return new Response("CourtCast forecast timer: starts the forecast update every 2 hours.\n", {
      headers: { "content-type": "text/plain" },
    });
  },
};
