// ベイズ推定エンジン。各質問は「その高校の出身者が『はい』と答える確率」を全校ぶん持つ。
// 回答のたびに事後確率を更新し、次は「期待情報量 × ドキドキ度」が大きい質問を選ぶ。

export type Answer = "yes" | "probably" | "unknown" | "probably_not" | "no";

type QuestionBase = {
  id: string;
  text: string;
  /** 演出上の重み。風景・体感系は高く、直球の質問（県名など）は低く。 */
  drama: number;
  /** 出題条件: 実質候補数がこの値以下になったら解禁 */
  maxEff?: number;
  /** 出題条件: これだけ質問した後なら解禁（maxEff と OR） */
  minAsked?: number;
};
export type DenseQuestion = QuestionBase & { kind: "dense"; p: Float32Array };
/** members に含まれる学校は hi、それ以外は lo の確率で「はい」 */
export type SparseQuestion = QuestionBase & { kind: "sparse"; members: Int32Array; hi: number; lo: number };
export type Question = DenseQuestion | SparseQuestion;

export type Turn = { q: Question; a: Answer };

export function likelihood(a: Answer, p: number): number {
  switch (a) {
    case "yes":
      return p;
    case "probably":
      return 0.25 + 0.5 * p;
    case "unknown":
      return 1;
    case "probably_not":
      return 0.75 - 0.5 * p;
    case "no":
      return 1 - p;
  }
}

export function probOf(q: Question, i: number): number {
  if (q.kind === "dense") return q.p[i];
  // members は昇順
  let lo = 0,
    hi = q.members.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (q.members[mid] === i) return q.hi;
    if (q.members[mid] < i) lo = mid + 1;
    else hi = mid - 1;
  }
  return q.lo;
}

export function posterior(n: number, turns: Turn[], rejected: Iterable<number> = []): Float64Array {
  const w = new Float64Array(n).fill(1 / n);
  for (const { q, a } of turns) {
    if (a === "unknown") continue;
    if (q.kind === "dense") {
      for (let i = 0; i < n; i++) w[i] *= likelihood(a, q.p[i]);
    } else {
      const lo = likelihood(a, q.lo);
      const ratio = likelihood(a, q.hi) / lo;
      for (let i = 0; i < n; i++) w[i] *= lo;
      for (const m of q.members) w[m] *= ratio;
    }
    normalize(w);
  }
  for (const r of rejected) w[r] = 0;
  normalize(w);
  return w;
}

function normalize(w: Float64Array) {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i];
  if (s > 0) for (let i = 0; i < w.length; i++) w[i] /= s;
}

export function entropy(w: Float64Array): number {
  let h = 0;
  for (let i = 0; i < w.length; i++) if (w[i] > 0) h -= w[i] * Math.log(w[i]);
  return h;
}

/** 実質的な候補数（エントロピーの指数） */
export const effectiveCount = (w: Float64Array) => Math.exp(entropy(w));

const xlogx = (x: number) => (x > 0 ? x * Math.log(x) : 0);

/** 質問ごとの期待情報量（nat）。はい/いいえの2択で近似する。 */
export function expectedGains(w: Float64Array, questions: Question[]): Float64Array {
  const n = w.length;
  const logw = new Float64Array(n);
  let T = 0; // Σ w log w
  for (let i = 0; i < n; i++) {
    logw[i] = w[i] > 0 ? Math.log(w[i]) : 0;
    T += w[i] * logw[i];
  }
  const h0 = -T;
  const out = new Float64Array(questions.length);
  questions.forEach((q, qi) => {
    let hExp: number;
    if (q.kind === "dense") {
      let zy = 0,
        sy = 0,
        zn = 0,
        sn = 0;
      const p = q.p;
      for (let i = 0; i < n; i++) {
        const wi = w[i];
        if (wi <= 0) continue;
        const y = wi * p[i];
        const no = wi - y;
        zy += y;
        zn += no;
        sy += y * (logw[i] + Math.log(p[i]));
        sn += no * (logw[i] + Math.log(1 - p[i]));
      }
      hExp = xlogx(zy) - sy + xlogx(zn) - sn;
    } else {
      let A = 0,
        B = 0;
      for (const m of q.members) {
        A += w[m];
        B += w[m] * logw[m];
      }
      const part = (hi: number, lo: number) => {
        const z = hi * A + lo * (1 - A);
        const s = hi * (B + A * Math.log(hi)) + lo * (T - B + (1 - A) * Math.log(lo));
        return xlogx(z) - s;
      };
      hExp = part(q.hi, q.lo) + part(1 - q.hi, 1 - q.lo);
    }
    out[qi] = Math.max(0, h0 - hExp);
  });
  return out;
}

export type Decision = { type: "ask"; q: Question } | { type: "guess"; index: number } | { type: "giveup" };

export const MAX_GUESSES = 3;
const BASE_MAX_QUESTIONS = 45;

export function decide(
  n: number,
  questions: Question[],
  turns: Turn[],
  rejected: Set<number>,
  rng: () => number = Math.random,
): Decision {
  if (rejected.size >= MAX_GUESSES) return { type: "giveup" };
  const w = posterior(n, turns, rejected);
  let top = 0;
  for (let i = 1; i < n; i++) if (w[i] > w[top]) top = i;
  if (!(w[top] > 0)) return { type: "giveup" };

  const asked = turns.length;
  const threshold = rejected.size === 0 ? 0.8 : 0.7;
  if (w[top] >= threshold) return { type: "guess", index: top };
  if (asked >= BASE_MAX_QUESTIONS + 8 * rejected.size) return { type: "guess", index: top };

  const eff = effectiveCount(w);
  const askedIds = new Set(turns.map((t) => t.q.id));
  const pool = questions.filter((q) => {
    if (askedIds.has(q.id)) return false;
    if (q.maxEff === undefined && q.minAsked === undefined) return true;
    return (q.maxEff !== undefined && eff <= q.maxEff) || (q.minAsked !== undefined && asked >= q.minAsked);
  });
  const gains = expectedGains(w, pool);
  const scored = pool
    .map((q, i) => ({ q, gain: gains[i], score: gains[i] * q.drama }))
    .filter((x) => x.gain > 0.004)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { type: "guess", index: top };
  // 毎回同じ展開にならないよう、上位の僅差からランダムに選ぶ
  const close = scored.slice(0, 3).filter((x) => x.score >= scored[0].score * 0.8);
  return { type: "ask", q: close[Math.floor(rng() * close.length)].q };
}
