// 各高校の日本語版 Wikipedia 記事（ウィキテキスト）を取得して data/cache/wiki/ にキャッシュする。
// 記事の特定は「都道府県別カテゴリの記事一覧 → 校名で突き合わせ → 本文に市区町村名があるか」で行う。
// Wikipedia の API に負荷をかけないよう、直列・1.5秒間隔で取得する（途中経過はキャッシュされ、再実行で続きから）。
//
// 使い方: node scripts/fetch-wiki.mjs   （続けて node scripts/build-wiki.mjs で特徴を抽出）

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE = path.join(ROOT, "data/cache/wiki");
const PAGES = path.join(CACHE, "pages.jsonl"); // {title, text} 1行1記事
const MATCH = path.join(CACHE, "match.json"); // 学校キー -> 実タイトル
const API = "https://ja.wikipedia.org/w/api.php";
const UA = "highschool-quiz-data-builder/0.1 (hobby project; batch, serial requests)";

const PREFS = ["", "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"];

export function municipality(addr, code) {
  let a = addr;
  if (Number(code.slice(2)) >= 300) a = a.replace(/^.+?郡/, "");
  const m = a.match(/^.+?[市区町村]/);
  if (!m) return "";
  let name = m[0];
  while (/[市区町村]/.test(a[name.length] ?? "") && name.length < 6) name += a[name.length];
  return name;
}

export function loadSchools() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "data/raw/P29-21.geojson"), "utf8"))
    .features.filter((f) => f.properties.P29_003 === 16004 || f.properties.P29_003 === 16003)
    .map((f) => {
      const p = f.properties;
      const name = p.P29_004.normalize("NFKC");
      const addr = p.P29_005.normalize("NFKC");
      const pref = PREFS[Number(p.P29_001.slice(0, 2))];
      return {
        key: `${p.P29_001}:${p.P29_004}:${f.geometry.coordinates[1].toFixed(4)}`,
        name,
        pref,
        admin: p.P29_006,
        muni: municipality(addr, p.P29_001),
      };
    });
}

/** 記事タイトルの候補（優先順） */
export function candidates(s) {
  // 分校・校舎などは本校の記事を見る
  const main = s.name.replace(/(高等学校|中等教育学校).+$/, "$1");
  const out = [];
  for (const n of new Set([s.name, main])) {
    if (s.admin === 2) out.push(`${s.pref}立${n}`, `${s.pref}${n}`);
    if (s.admin === 3) out.push(`${s.muni}立${n}`, `${s.pref}立${n}`, `${s.pref}${n}`);
    out.push(`${n} (${s.pref})`, n);
    if (s.admin !== 2 && s.admin !== 3) out.push(`${s.pref}立${n}`, `${s.muni}立${n}`);
  }
  return [...new Set(out)];
}

let lastCall = 0;
/** 直列・1.5秒間隔。429/503 は Retry-After を守って待つ。 */
async function api(params) {
  const body = new URLSearchParams({ format: "json", formatversion: "2", maxlag: "5", ...params });
  for (let attempt = 0; ; attempt++) {
    const wait = lastCall + 1500 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    const res = await fetch(API, { method: "POST", headers: { "User-Agent": UA }, body });
    if (res.ok) {
      const json = await res.json();
      if (!json.error) return json;
      if (json.error.code !== "maxlag") throw new Error(`API error: ${json.error.code}`);
    } else if (res.status !== 429 && res.status !== 503) {
      throw new Error(`HTTP ${res.status}`);
    }
    if (attempt >= 4) throw new Error("rate limited; try again later (progress is cached)");
    const retry = Number(res.headers.get("retry-after")) || 0;
    const pause = Math.max(retry, 30 * 2 ** attempt);
    console.log(`  throttled, waiting ${pause}s`);
    await new Promise((r) => setTimeout(r, pause * 1000));
  }
}

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const norm = (t) => t.normalize("NFKC").replace(/ケ/g, "ヶ").replace(/\s/g, "");
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);

/** 都道府県ごとの高校記事タイトル一覧（カテゴリをたどる） */
async function listTitles() {
  const file = path.join(CACHE, "titles.json");
  const titles = readJson(file, {});
  for (const pref of PREFS.slice(1)) {
    if (titles[pref]) continue;
    const pagesOf = new Set();
    const seen = new Set();
    const queue = [[`${pref}の高等学校`, 0], [`${pref}の中等教育学校`, 0]];
    while (queue.length) {
      const [cat, depth] = queue.shift();
      if (seen.has(cat)) continue;
      seen.add(cat);
      let cont = {};
      for (;;) {
        const j = await api({ action: "query", list: "categorymembers", cmtitle: `Category:${cat}`, cmlimit: "500", cmtype: "page|subcat", ...cont });
        for (const m of j.query.categorymembers) {
          if (m.ns === 0) pagesOf.add(m.title);
          else if (m.ns === 14 && depth < 2) {
            const sub = m.title.replace(/^Category:/, "");
            if (/高等学校|中等教育学校|高校/.test(sub) && !/廃|出身|人物|画像|スタブ|教員|関係者|部$|テンプレート/.test(sub)) queue.push([sub, depth + 1]);
          }
        }
        if (!j.continue) break;
        cont = j.continue;
      }
    }
    titles[pref] = [...pagesOf];
    fs.writeFileSync(file, JSON.stringify(titles));
    console.log(`  ${pref}: ${pagesOf.size} articles`);
  }
  return titles;
}

/** 一覧の中から、その学校の記事かもしれないタイトルを優先順に返す */
function shortlist(s, byNorm) {
  const out = [];
  for (const c of candidates(s)) {
    const t = byNorm.get(norm(c));
    if (t) out.push(t);
  }
  const names = [...new Set([s.name, s.name.replace(/(高等学校|中等教育学校).+$/, "$1")])].map(norm);
  for (const [n, t] of byNorm) if (names.some((x) => n.replace(/\(.+\)$/, "").endsWith(x))) out.push(t);
  // 「○○中学校・高等学校」「○○学園高等部」のように校名の形が違う記事（私立に多い）
  const base = norm(s.name).replace(/(高等学校|中等教育学校|高等学院|高等学園|高等部|高等科|高校).*$/, "");
  if (base.length >= 2) {
    for (const [n, t] of byNorm) if (n.startsWith(base)) out.push(t);
    if (base.length >= 3) for (const [n, t] of byNorm) if (n.includes(base)) out.push(t);
  }
  return [...new Set(out)].slice(0, 6);
}

/**
 * 記事タイトルの「学校種別より前の部分」が校名と一致するか。
 * 「南高等学校」が「厚木清南高等学校」に、「帝京高等学校」が「帝京大学中学校・高等学校」に化けるのを防ぐ。
 */
function plausible(s, title) {
  if (/一覧/.test(title)) return false;
  const core = norm(title).replace(/\(.+\)$/, "").replace(/(小学校|初等|幼稚園|中学|中等|高等|高校).*$/, "");
  const base = norm(s.name).replace(/(高等|中等教育|高校).*$/, "");
  const muni = norm(s.muni), pref = norm(s.pref);
  return [base, `${pref}立${base}`, `${pref}${base}`, `${muni}立${base}`, `${pref}${muni}立${base}`, `市立${base}`].includes(core);
}

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  const schools = loadSchools();

  // 1) 都道府県別のカテゴリから記事タイトルを集め、校名で突き合わせる
  const titles = await listTitles();
  const byPref = Object.fromEntries(Object.entries(titles).map(([p, ts]) => [p, new Map(ts.map((t) => [norm(t), t]))]));
  const short = new Map(schools.map((s) => [s.key, shortlist(s, byPref[s.pref])]));

  // 2) 本文の取得
  const pages = new Map();
  if (fs.existsSync(PAGES))
    for (const line of fs.readFileSync(PAGES, "utf8").split("\n")) if (line) { const p = JSON.parse(line); pages.set(p.title, p.text); }
  const want = [...new Set([...short.values()].flat())].filter((t) => !pages.has(t));
  console.log(`fetch: ${want.length} pages`);
  const out = fs.createWriteStream(PAGES, { flags: "a" });
  for (const [i, batch] of chunk(want, 40).entries()) {
    let cont = {};
    for (;;) {
      const j = await api({ action: "query", prop: "revisions", rvprop: "content", rvslots: "main", titles: batch.join("|"), ...cont });
      for (const p of j.query.pages) {
        const text = p.revisions?.[0]?.slots?.main?.content;
        if (text !== undefined && !pages.has(p.title)) {
          pages.set(p.title, text);
          out.write(JSON.stringify({ title: p.title, text }) + "\n");
        }
      }
      if (!j.continue) break;
      cont = j.continue;
    }
    if (i % 10 === 9) console.log(`  ${(i + 1) * 40}/${want.length}`);
  }
  await new Promise((r) => out.end(r));

  // 3) 学校と記事の対応づけ: 本文に市区町村名がある最初の候補
  const match = {};
  let hit = 0;
  for (const s of schools) {
    const m = s.muni.replace(/[市区町村]$/, "");
    const list = short.get(s.key);
    const ok = list.filter((t) => plausible(s, t));
    const title = ok.find((t) => pages.get(t)?.includes(m)) ?? (ok.length === 1 && pages.has(ok[0]) ? ok[0] : undefined);
    if (!title) continue;
    match[s.key] = title;
    hit++;
  }
  fs.writeFileSync(MATCH, JSON.stringify(match));
  console.log(`matched ${hit}/${schools.length}`);
}

if (process.argv[1] === import.meta.filename) await main();
