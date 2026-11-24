"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { adminLabel, loadSchools, PREFS, type School } from "@/lib/data";
import { decide, effectiveCount, MAX_GUESSES, posterior, probOf, type Answer, type Question, type Turn } from "@/lib/engine";
import { buildGeo, mapView } from "@/lib/map";
import { buildQuestions } from "@/lib/questions";
import ChalkMap from "./ChalkMap";

type Db = { schools: School[]; questions: Question[] };
type Phase = "intro" | "ask" | "reveal" | "won" | "giveup";

const TOP_N = 100;
const MAIN_ANSWERS: { a: Answer; label: string; tone: string }[] = [
  { a: "yes", label: "はい", tone: "yes" },
  { a: "no", label: "いいえ", tone: "no" },
];
const SUB_ANSWERS: { a: Answer; label: string; tone: string }[] = [
  { a: "probably", label: "たぶんそう", tone: "paper" },
  { a: "unknown", label: "わからない", tone: "faint" },
  { a: "probably_not", label: "たぶん違う", tone: "paper" },
];
const ANSWER_LABEL: Record<Answer, string> = { yes: "はい", probably: "たぶんそう", unknown: "わからない", probably_not: "たぶん違う", no: "いいえ" };

function murmur(eff: number, total: number, asked: number): string {
  if (asked === 0) return "では、はじめましょう。";
  if (eff > total * 0.4) return "まだ、日本じゅうに点が残っています……";
  if (eff > 800) return "ふむ。景色がぼんやり浮かんできました。";
  if (eff > 150) return "なるほど……通学路が見えてきましたよ。";
  if (eff > 30) return "校舎の輪郭が、はっきりしてきました。";
  if (eff > 6) return "もう、校門の前まで来ています。";
  return "……ほとんど、見えました。";
}

/** 数字がするすると変わる演出 */
function useAnimatedNumber(target: number, ms = 700): number {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const v = a + (target - a) * (1 - Math.pow(1 - t, 3));
      from.current = v;
      setValue(v);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

function SchoolCard({ s }: { s: School }) {
  const label = adminLabel(s);
  return (
    <div className="text-center">
      <p className="text-sm tracking-widest text-[var(--gold)]">
        {PREFS[s.pref]} {s.muni}
      </p>
      <p className="mt-1 font-serif text-3xl leading-snug">{s.name}</p>
      <p className="mt-2 text-sm text-[var(--muted)]">
        {label && `${label}・`}
        {s.st && s.stDist >= 0 && s.stDist < 5000 ? `最寄りは${s.st}駅` : s.addr}
      </p>
    </div>
  );
}

/** いま有力な候補の一覧（確率の高い順） */
function Candidates({ schools, w, asked }: { schools: School[]; w: Float64Array; asked: number }) {
  const [open, setOpen] = useState(true);
  const top = useMemo(() => {
    const idx = Array.from(w.keys()).filter((i) => w[i] > 0);
    idx.sort((a, b) => w[b] - w[a]);
    return idx.slice(0, TOP_N);
  }, [w]);
  const max = top.length ? w[top[0]] : 1;
  const pct = (p: number) => (p >= 0.0995 ? `${(p * 100).toFixed(0)}%` : p >= 0.001 ? `${(p * 100).toFixed(1)}%` : "<0.1%");
  return (
    <aside className="w-full max-w-md px-4 pb-10 lg:sticky lg:top-0 lg:w-80 lg:shrink-0 lg:px-0 lg:pt-5">
      <div className="rounded border border-[var(--line)] bg-[var(--paper)] px-4 py-3.5">
      <div className="flex items-baseline justify-between border-b-2 border-[var(--fg)] pb-1.5">
        <h2 className="text-sm font-bold tracking-[0.2em]">出席簿（候補 TOP{TOP_N}）</h2>
        <button className="text-xs text-[var(--muted)] underline underline-offset-4" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "隠す" : "見る"}
        </button>
      </div>
      {open &&
        (asked === 0 ? (
          <p className="mt-4 text-sm text-[var(--muted)]">まだ白紙です。質問に答えると、候補の名前が並びます。</p>
        ) : (
          <ol className="mt-3 max-h-[60dvh] overflow-y-auto pr-1 text-sm lg:max-h-[calc(100dvh-8rem)]">
            {top.map((i, rank) => (
              <li key={i} className="relative flex items-baseline gap-2 overflow-hidden rounded px-2 py-1">
                <span className="absolute inset-y-0 left-0 bg-[var(--gold)]/15" style={{ width: `${(w[i] / max) * 100}%` }} aria-hidden />
                <span className="relative w-6 shrink-0 text-right text-xs text-[var(--muted)] tabular-nums">{rank + 1}</span>
                <span className="relative min-w-0 flex-1 truncate">
                  {schools[i].name}
                  <span className="ml-1.5 text-xs text-[var(--muted)]">
                    {PREFS[schools[i].pref]}
                    {schools[i].muni}
                  </span>
                </span>
                <span className="relative shrink-0 text-xs font-bold text-[var(--gold)] tabular-nums">{pct(w[i])}</span>
              </li>
            ))}
          </ol>
        ))}
      </div>
    </aside>
  );
}

function GiveUp({ db, turns, onRestart }: { db: Db; turns: Turn[]; onRestart: () => void }) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<number | null>(null);
  const hits = useMemo(() => {
    const q = query.trim().normalize("NFKC");
    if (q.length < 1) return [];
    const out: number[] = [];
    for (let i = 0; i < db.schools.length && out.length < 30; i++) if (db.schools[i].name.includes(q)) out.push(i);
    return out;
  }, [db, query]);

  const analysis = useMemo(() => {
    if (picked === null) return null;
    const w = posterior(db.schools.length, turns);
    let rank = 1;
    for (let i = 0; i < w.length; i++) if (w[i] > w[picked]) rank++;
    const misses = turns.filter(({ q, a }) => {
      const p = probOf(q, picked);
      return ((a === "yes" || a === "probably") && p < 0.3) || ((a === "no" || a === "probably_not") && p > 0.7);
    });
    return { rank, misses };
  }, [db, turns, picked]);

  if (picked !== null && analysis) {
    return (
      <div className="flex w-full flex-col items-center gap-6">
        <p className="font-serif text-lg text-[var(--muted)]">そうでしたか……。覚えておきます。</p>
        <SchoolCard s={db.schools[picked]} />
        <p className={turns.some((t) => t.a !== "unknown") ? "text-sm text-[var(--muted)]" : "hidden"}>
          黒板の上では、{db.schools.length.toLocaleString()}校中{" "}
          <span className="text-[var(--gold)]">{analysis.rank.toLocaleString()}番目</span> に映っていました。
        </p>
        {analysis.misses.length > 0 && (
          <div className="w-full rounded border border-[var(--line)] bg-[var(--paper)] p-4 text-sm">
            <p className="mb-2 text-[var(--muted)]">見立てがずれた質問</p>
            <ul className="space-y-1.5">
              {analysis.misses.map(({ q, a }) => (
                <li key={q.id}>
                  {q.text} <span className="font-bold text-[var(--gold)]">→ {ANSWER_LABEL[a]}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <button className="btn btn-yes w-full" onClick={onRestart}>
          もう一度あそぶ
        </button>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col items-center gap-5">
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="校名の一部を入力"
        className="w-full rounded-lg border-2 border-[var(--fg)] bg-[var(--paper)] px-4 py-3 text-base outline-none focus:border-[#2f5d9b]"
      />
      <ul className="max-h-72 w-full overflow-y-auto">
        {hits.map((i) => (
          <li key={i}>
            <button className="w-full rounded-lg px-3 py-2 text-left hover:bg-black/5" onClick={() => setPicked(i)}>
              {db.schools[i].name}
              <span className="ml-2 text-xs text-[var(--muted)]">
                {PREFS[db.schools[i].pref]} {db.schools[i].muni}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <button className="text-sm text-[var(--muted)] underline underline-offset-4" onClick={onRestart}>
        最初からやり直す
      </button>
    </div>
  );
}

export default function Game() {
  const [db, setDb] = useState<Db | null>(null);
  const [failed, setFailed] = useState(false);
  const [phase, setPhase] = useState<Phase>("intro");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [rejected, setRejected] = useState<Set<number>>(new Set());
  const [current, setCurrent] = useState<Question | null>(null);
  const [guess, setGuess] = useState<number | null>(null);
  const [thinking, setThinking] = useState(false);
  const [revealStep, setRevealStep] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadSchools()
      .then(({ schools, peaks }) => setDb({ schools, questions: buildQuestions(schools, peaks) }))
      .catch(() => setFailed(true));
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const total = db?.schools.length ?? 0;
  const geo = useMemo(() => (db ? buildGeo(db.schools) : null), [db]);
  const w = useMemo(() => (db ? posterior(db.schools.length, turns, rejected) : null), [db, turns, rejected]);
  const eff = useMemo(() => (w ? effectiveCount(w) : 0), [w]);
  const view = useMemo(() => {
    if (!geo) return null;
    const untouched = phase === "intro" || (turns.every((t) => t.a === "unknown") && rejected.size === 0);
    const focus = guess !== null && (phase === "won" || (phase === "reveal" && revealStep >= 2)) ? guess : null;
    // 直前の答えで消えた地方にバツを付けるため、ひとつ前の状態も渡す
    const last = turns[turns.length - 1];
    const prev = phase === "ask" && last && last.a !== "unknown" ? posterior(geo.cells.length, turns.slice(0, -1), rejected) : null;
    return mapView(geo, untouched ? null : w, focus, prev);
  }, [geo, w, phase, turns, rejected, guess, revealStep]);
  const shown = useAnimatedNumber(view?.alive ?? 0);

  // 予想を出すときは、少しもったいぶってから校名を見せる
  useEffect(() => {
    if (phase !== "reveal") return;
    const t1 = setTimeout(() => setRevealStep(1), 1400);
    const t2 = setTimeout(() => setRevealStep(2), 3400);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [phase, guess]);

  /** 少し「考える間」を置いてから、次の質問か予想に進む */
  const advance = (nextTurns: Turn[], nextRejected: Set<number>) => {
    if (!db) return;
    setThinking(true);
    timer.current = setTimeout(() => {
      const d = decide(db.schools.length, db.questions, nextTurns, nextRejected);
      if (d.type === "ask") {
        setCurrent(d.q);
        setPhase("ask");
      } else if (d.type === "guess") {
        setRevealStep(0);
        setGuess(d.index);
        setPhase("reveal");
      } else {
        setPhase("giveup");
      }
      setThinking(false);
    }, 700);
  };

  const start = () => {
    setTurns([]);
    setRejected(new Set());
    setGuess(null);
    setCurrent(null);
    setPhase("ask");
    advance([], new Set());
  };

  const answer = (a: Answer) => {
    if (!current || thinking) return;
    const next = [...turns, { q: current, a }];
    setTurns(next);
    advance(next, rejected);
  };

  const undo = () => {
    if (thinking || turns.length === 0) return;
    const last = turns[turns.length - 1];
    setTurns(turns.slice(0, -1));
    setCurrent(last.q);
  };

  const wrong = () => {
    if (guess === null) return;
    const next = new Set(rejected).add(guess);
    setRejected(next);
    setGuess(null);
    setCurrent(null);
    setPhase("ask");
    advance(turns, next);
  };

  const asking = phase === "ask" && !!db;
  const revealed = phase === "reveal" && guess !== null && revealStep >= 2;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col items-center lg:flex-row lg:items-start lg:justify-center lg:gap-10">
      <main className={`flex w-full max-w-md flex-col px-4 pt-5 pb-6 lg:min-h-dvh ${asking ? "" : "min-h-dvh"}`}>
        <div className="board flex flex-col gap-2 px-3.5 pt-3.5 pb-4">
          <p className="text-[13px] text-[var(--muted)]">※ 2021〜2026年の情報をもとに当てています</p>
          {view ? (
            <ChalkMap view={view} total={total} shown={shown} />
          ) : (
            <div className="flex aspect-[301/329] items-center justify-center text-[var(--muted)]">
              {failed ? "データを読み込めませんでした。ページを再読み込みしてください。" : "ロード中"}
            </div>
          )}

          <div className="flex min-h-28 flex-col justify-center border-t-2 border-[#9db3a5] pt-2">
            {!failed && phase === "intro" && (
              <>
                <h1 className="text-[26px] leading-normal">出身高校、当てます。</h1>
                <p className="mt-1 text-sm leading-relaxed text-[var(--muted)]">
                  海は見えましたか。坂はきつかったですか。そんな質問に答えるだけで、地図の点が消えていき、最後にあなたの母校が残ります。
                </p>
              </>
            )}

            {asking && (
              <>
                <p className="text-xs tracking-[0.2em] text-[var(--gold)]">{current ? `第 ${turns.length + 1} 問` : " "}</p>
                {current && !thinking ? (
                  <h2 key={current.id} className="rise mt-1 text-2xl leading-normal">
                    {current.text}
                  </h2>
                ) : (
                  <p className="dots mt-1 text-2xl text-[var(--muted)]" aria-label="考え中">
                    <span>・</span>
                    <span>・</span>
                    <span>・</span>
                  </p>
                )}
              </>
            )}

            {!failed && phase === "reveal" && db && guess !== null && (
              <div className="flex flex-col items-center gap-2 py-1">
                <p className="rise text-base text-[var(--muted)]">{rejected.size === 0 ? "……見えました。" : "……では、こちらでしょうか。"}</p>
                {revealStep >= 1 && <p className="rise text-lg">あなたの出身高校は</p>}
                {revealStep >= 2 && (
                  <div className="reveal">
                    <SchoolCard s={db.schools[guess]} />
                  </div>
                )}
              </div>
            )}

            {!failed && phase === "won" && db && guess !== null && (
              <div className="flex flex-col items-center gap-2 py-1">
                <p className="text-base text-[var(--gold)]">
                  {turns.length}問で、言い当てました。{rejected.size > 0 && `（${rejected.size + 1}度目の正直）`}
                </p>
                <SchoolCard s={db.schools[guess]} />
              </div>
            )}

            {!failed && phase === "giveup" && (
              <>
                <p className="text-2xl">……参りました。</p>
                <p className="mt-1 text-sm text-[var(--muted)]">正解の高校を教えてください。</p>
              </>
            )}
          </div>
        </div>
        <div className="tray" aria-hidden>
          <span className="w-8 bg-[#f3f1e6]" />
          <span className="w-5 bg-[#f3a6a0]" />
          <span className="w-7 bg-[#f6d977]" />
        </div>

        <div className="mt-4 flex w-full flex-1 flex-col">
          {!failed && phase === "intro" && (
            <button className="btn btn-yes w-full" disabled={!db} onClick={start}>
              {db ? "高校を思い浮かべて、はじめる" : "ロード中"}
            </button>
          )}

          {asking && (
            <>
              <div className="grid grid-cols-2 gap-2.5">
                {MAIN_ANSWERS.map(({ a, label, tone }) => (
                  <button key={a} className={`btn btn-${tone}`} disabled={!current || thinking} onClick={() => answer(a)}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="mt-2.5 grid grid-cols-3 gap-2">
                {SUB_ANSWERS.map(({ a, label, tone }) => (
                  <button key={a} className={`btn btn-${tone}`} disabled={!current || thinking} onClick={() => answer(a)}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="mt-4 text-center">
                <p className="font-serif text-sm text-[var(--muted)]">{murmur(eff, total, turns.length)}</p>
                {turns.length > 0 && (
                  <button className="mt-3 text-xs text-[var(--muted)] underline underline-offset-4 disabled:opacity-40" disabled={thinking} onClick={undo}>
                    ひとつ前の質問に戻る
                  </button>
                )}
              </div>
            </>
          )}

          {revealed && (
            <div className="rise grid grid-cols-2 gap-2.5">
              <button className="btn btn-yes" onClick={() => setPhase("won")}>
                正解！
              </button>
              <button className="btn btn-no" onClick={wrong}>
                ちがいます
              </button>
            </div>
          )}

          {!failed && phase === "won" && (
            <div className="flex flex-col gap-4">
              <details className="rounded border border-[var(--line)] bg-[var(--paper)] p-4 text-sm">
                <summary className="cursor-pointer text-[var(--muted)]">質問と回答をふりかえる</summary>
                <ol className="mt-3 list-decimal space-y-1.5 pl-5">
                  {turns.map(({ q, a }) => (
                    <li key={q.id}>
                      {q.text} <span className="font-bold text-[var(--gold)]">→ {ANSWER_LABEL[a]}</span>
                    </li>
                  ))}
                </ol>
              </details>
              <button className="btn btn-yes w-full" onClick={start}>
                もう一度あそぶ
              </button>
            </div>
          )}

          {!failed && phase === "giveup" && db && <GiveUp db={db} turns={turns} onRestart={start} />}
        </div>

        <footer className="mt-10 text-center text-[10px] leading-relaxed text-[var(--muted)]">
          最大{MAX_GUESSES}回まで予想します。学校一覧は2021年度、鉄道は2022年度、地図記号とWikipediaは2026年11月時点。
          <br />
          出典: 国土数値情報（学校・鉄道）国土交通省 ／ 地理院タイル（標高・地図記号）国土地理院 を加工して作成。学校情報の一部は Wikipedia 日本語版（CC BY-SA）をもとに抽出
        </footer>
      </main>
      {asking && w && <Candidates schools={db.schools} w={w} asked={turns.length} />}
    </div>
  );
}
