// Runs the browser's copy of the scoring rules (the "scoring" section of
// site/app.js) on cases scored by courtcast/score.py and reports any mismatch.
// Used by tests/test_score_parity.py.
import { readFileSync } from "node:fs";

const [appPath, casesPath] = process.argv.slice(2);
const src = readFileSync(appPath, "utf8");
const block = src.slice(src.indexOf("// ---------- scoring"), src.indexOf("// ---------- live forecasts"));
const { score: config, cases } = JSON.parse(readFileSync(casesPath, "utf8"));
const DATA = { score: config };
const clamp01 = (t) => Math.max(0, Math.min(1, t));
const { scoreHour, windBand } = new Function("DATA", "clamp01", `${block}; return { scoreHour, windBand };`)(DATA, clamp01);

const bad = [];
for (const c of cases) {
  const i = c.in;
  const [s, b, why] = scoreHour({ temp: i.temp, chance: i.rain_chance, rain: i.rain, prev1: i.rain_prev1,
    prev23: i.rain_prev2_3, wind: i.wind, gust: i.gust });
  const wb = windBand(i.gust, i.wind);
  if (Math.abs(s - c.s) > 1e-9 || b !== c.b || wb !== c.wb || JSON.stringify(why) !== JSON.stringify(c.why)) {
    bad.push({ in: i, python: [c.s, c.b, c.wb, c.why], browser: [s, b, wb, why] });
  }
}
console.log(JSON.stringify({ total: cases.length, mismatches: bad.length, examples: bad.slice(0, 3) }));
