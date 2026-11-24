// 質問の一覧を JSON で書き出す（ランクづけ用の一覧ページの元データ）。
// 使い方: npx tsx scripts/export-questions.ts 出力先.json
import fs from "node:fs";
import path from "node:path";
import { hydrate } from "../lib/data";
import { decide, expectedGains, probOf, type Answer, type Question, type Turn } from "../lib/engine";
import { buildQuestions } from "../lib/questions";

const { schools, peaks } = hydrate(JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../public/data/schools.json"), "utf8")));
const questions = buildQuestions(schools, peaks);
const n = schools.length;

const FAMILY: [RegExp, string, string][] = [
  [/^peak_/, "peak", "晴れた日、学校から「◯◯（富士山・桜島など35の名峰）」が見えましたか？"],
  [/^river_/, "river", "学校の近くを流れていたのは、「◯◯川」でしたか？"],
  [/^kanji_/, "kanji", "校名に、「◯」という字が入っていましたか？"],
  [/^st_/, "st", "最寄り駅は、「◯◯」駅でしたか？"],
  [/^pref_/, "pref", "◯◯県にありましたか？"],
  [/^region_/, "region", "◯◯地方にありましたか？"],
];
const fam = (q: Question) => FAMILY.find(([re]) => re.test(q.id));
const key = (q: Question) => fam(q)?.[1] ?? q.id;

const CATS: [RegExp, string, string][] = [
  [/^(sea_|hill$|foot$|mt_view$|basin$|highland$|island$|cape$|peak$|wildlife$|tsunami$|ash$)/, "風景・自然", "標高・地形の計算"],
  [/^(riverside|lake|paddy|tea|orchard|field|forest|bamboo|shrine|temple|teramachi|grave|historic|lighthouse|port|tower|chimney|windmill|cityhall|hospital|onsen|park|motorway|river)$/, "まわりの景色", "地理院地図の地図記号・水面・道路"],
  [/^(snow|sakura|japan_sea|ski|typhoon)$/, "気候", "都道府県・緯度・標高からの推定"],
  [/^(walk|far|jr|many_st|shinkansen|train_sound|shin_view|tram|subway|mono)$/, "駅・鉄道", "駅・線路データ"],
  [/^(urban|rural|univ|hs|jh|es|only_hs|airfield)$/, "街・まわり", "周辺の学校データなど"],
  [/^(d_|asakagai)/, "ことば・学校文化", "裏付けデータなし（知識ベースの推定）"],
  [/^(landlocked|capital|ward_city|town|honshu|region|pref)$/, "土地（直球）", "住所"],
  [/^(private|municipal|affil)$/, "学校の種別", "設置者・校名"],
  [/^(rel_|betsugaku$|skirt$|night$|tsushin$|unit$|dept$|no_futsu$|term2$|intl$|big$|small$|w_d_)/, "学校のしくみ", "Wikipedia 基本情報欄・カテゴリ"],
  [/^(old|new|kyusei|jogakko|hanko|castle|merge|w_kofun|w_bunkazai|w_air_raid|w_coed_later)$/, "歴史・由緒", "Wikipedia"],
  [/^(koshien|hanazono|soccer|ssh|w_ekiden|w_volley|w_basket|w_suiso|w_quiz|w_robocon|w_haiku|w_koshien_win)$/, "全国大会・実績", "Wikipedia カテゴリ・本文"],
  [/^w_c_/, "部活", "Wikipedia 本文"],
  [/^(w_a_|alumni$)/, "卒業生", "Wikipedia 出身者一覧"],
  [/^(w_bunbu|w_shitsujitsu|w_jiyu|w_bankara|w_ouen_practice|w_famous_song|ouendan|shingaku)$/, "校風", "Wikipedia 本文"],
  [/^(w_trip_|w_enei|w_tozan|w_ski_trip|w_fire|w_kibasen|w_kaso|w_chorus|ensoku|overseas)/, "行事", "Wikipedia 本文"],
  [/^(w_observatory|w_indoor_pool|w_turf|w_night_light|w_clock|w_tea|w_kyudo|w_tree|w_farm|w_ship)$/, "施設", "Wikipedia 本文"],
  [/^(bus|cafe|dorm|shifuku|sailor|gakuran|w_all_dorm|w_moped|w_kyushoku|w_no_chime|w_odd_period|w_saturday|w_tokushin|w_sports_course)$/, "学校生活", "Wikipedia 本文"],
  [/^(kanji|st)$/, "最後の手段", "校名・駅データ"],
];

// 自己対戦での出題回数
let seed = 777;
const rng = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const GAMES = 300;
const usage = new Map<string, number>();
for (let t = 0; t < GAMES; t++) {
  const target = Math.floor(rng() * n);
  const turns: Turn[] = [];
  const rejected = new Set<number>();
  for (;;) {
    const d = decide(n, questions, turns, rejected, rng);
    if (d.type === "giveup") break;
    if (d.type === "guess") {
      if (d.index === target) break;
      rejected.add(d.index);
      continue;
    }
    const p = probOf(d.q, target);
    const a: Answer = rng() < 0.08 ? "unknown" : rng() < p ? (rng() < 0.75 ? "yes" : "probably") : rng() < 0.75 ? "no" : "probably_not";
    usage.set(key(d.q), (usage.get(key(d.q)) ?? 0) + 1);
    turns.push({ q: d.q, a });
  }
}

const gains = expectedGains(new Float64Array(n).fill(1 / n), questions);
const rows = new Map<string, Record<string, unknown>>();
questions.forEach((q, qi) => {
  const k = key(q);
  let yes = 0;
  for (let i = 0; i < n; i++) if (probOf(q, i) >= 0.5) yes++;
  const prev = rows.get(k);
  if (prev) {
    prev.count = (prev.count as number) + 1;
    prev.gain = Math.max(prev.gain as number, gains[qi] / Math.LN2);
    return;
  }
  const cat = CATS.find(([re]) => re.test(k));
  rows.set(k, {
    id: k,
    text: fam(q)?.[2] ?? q.text,
    cat: cat?.[1] ?? "その他",
    source: cat?.[2] ?? "",
    drama: q.drama,
    minAsked: q.minAsked ?? 0,
    maxEff: q.maxEff ?? 0,
    yes: fam(q) ? null : yes,
    gain: gains[qi] / Math.LN2,
    count: 1,
  });
});
const out = [...rows.values()].map((r) => ({ ...r, gain: +(r.gain as number).toFixed(3), usage: +((usage.get(r.id as string) ?? 0) / GAMES).toFixed(2) }));
fs.writeFileSync(process.argv[2], JSON.stringify({ schools: n, games: GAMES, questions: out }));
console.log(`${out.length} rows -> ${process.argv[2]}`);
