// エンジンの自己診断。ランダムに選んだ高校の「出身者」を演じ、データどおり（+ゆらぎ）に答えて
// 何問で当たるかを測る。データ自体の正しさは測れない点に注意。
//
// 使い方: npx tsx scripts/simulate.ts [試行回数] [trace]

import fs from "node:fs";
import path from "node:path";
import { hydrate } from "../lib/data";
import { decide, probOf, type Answer, type Turn } from "../lib/engine";
import { buildQuestions } from "../lib/questions";

const { schools, peaks } = hydrate(JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../public/data/schools.json"), "utf8")));
const questions = buildQuestions(schools, peaks);
const trials = Number(process.argv[2] ?? 300);
const trace = process.argv[3] === "trace";

let seed = 12345;
const rng = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

function answerFor(p: number): Answer {
  if (rng() < 0.08) return "unknown";
  const yes = rng() < p;
  const sure = rng() < 0.75;
  return yes ? (sure ? "yes" : "probably") : sure ? "no" : "probably_not";
}

let hitFirst = 0, hit = 0, sumQ = 0;
const usage = new Map<string, number>();
const firstQ = new Map<string, number>();
for (let t = 0; t < trials; t++) {
  const target = Math.floor(rng() * schools.length);
  const turns: Turn[] = [];
  const rejected = new Set<number>();
  if (trace) console.log(`\n=== ${schools[target].name}（${schools[target].addr}）`);
  for (;;) {
    const d = decide(schools.length, questions, turns, rejected, rng);
    if (d.type === "giveup") break;
    if (d.type === "guess") {
      if (trace) console.log(`  → 予想: ${schools[d.index].name} ${d.index === target ? "◎" : "×"}`);
      if (d.index === target) {
        hit++;
        if (rejected.size === 0) hitFirst++;
        sumQ += turns.length;
        break;
      }
      rejected.add(d.index);
      continue;
    }
    const a = answerFor(probOf(d.q, target));
    if (trace) console.log(`  Q${turns.length + 1} ${d.q.text} … ${a}`);
    const kind = d.q.id.replace(/_.*/, (m) => (/^(kanji|st|pref|region|peak|river)_/.test(d.q.id) ? "" : m));
    usage.set(kind, (usage.get(kind) ?? 0) + 1);
    if (turns.length === 0) firstQ.set(d.q.id, (firstQ.get(d.q.id) ?? 0) + 1);
    turns.push({ q: d.q, a });
  }
}
console.log(`\n${schools.length}校 / 質問${questions.length}種 / ${trials}試行`);
console.log(`一発的中 ${((hitFirst / trials) * 100).toFixed(1)}%  3回以内 ${((hit / trials) * 100).toFixed(1)}%  的中時の平均質問数 ${(sumQ / Math.max(1, hit)).toFixed(1)}`);
console.log("最初の質問:", Object.fromEntries([...firstQ].sort((a, b) => b[1] - a[1])));
console.log("質問の出題回数/試行:", Object.fromEntries([...usage].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +(v / trials).toFixed(2)])));
