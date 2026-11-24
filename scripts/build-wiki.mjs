// キャッシュ済みの Wikipedia 記事から、学校ごとの特徴を抽出して data/wiki.json に書き出し、
// public/data/schools.json があればそこにも反映する。
//   - 基本情報欄・カテゴリ由来: 宗教系統、男女別、課程、学科、創立年、全国大会の出場歴 …（確度が高い）
//   - 本文の記述の有無: 食堂、スクールバス、部活、行事、施設、卒業生の顔ぶれ …（書かれていない＝無い、ではない）
//
// 使い方: node scripts/build-wiki.mjs [--explore]

import fs from "node:fs";
import path from "node:path";
import { loadSchools } from "./fetch-wiki.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE = path.join(ROOT, "data/cache/wiki");
const OUT = path.join(ROOT, "data/wiki.json");
const SCHOOLS_JSON = path.join(ROOT, "public/data/schools.json");

const plain = (v) =>
  v
    .replace(/<ref[^>]*\/>|<ref[\s\S]*?<\/ref>/g, "")
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .trim();

function infobox(text) {
  const start = text.search(/\{\{\s*(Infobox 日本の学校|日本の高校|Infobox School)/i);
  if (start < 0) return {};
  const end = text.indexOf("\n}}", start);
  const body = text.slice(start, end < 0 ? start + 6000 : end);
  const out = {};
  for (const part of body.split(/\n\s*\|/).slice(1)) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = plain(part.slice(i + 1));
  }
  return out;
}

const ERA = { 明治: 1867, 大正: 1911, 昭和: 1925, 平成: 1988, 令和: 2018 };
function year(v) {
  if (!v) return 0;
  const m = v.match(/(1[6-9]\d\d|20[0-2]\d)年?/);
  if (m) return Number(m[1]);
  const e = v.match(/(明治|大正|昭和|平成|令和)(\d+|元)年/);
  return e ? ERA[e[1]] + (e[2] === "元" ? 1 : Number(e[2])) : 0;
}

// ---- 記事全文（カテゴリ含む）に対するキーワード ----
const TEXT = {
  // 学校生活
  bus: /スクールバス|通学バス|送迎バス/,
  cafe: /食堂|学食|カフェテリア/,
  dorm: /学生寮|生徒寮|寄宿舎|寮生|男子寮|女子寮|寮を/,
  all_dorm: /全寮制/,
  shifuku: /私服|制服(は|が)?(ない|なし|無|存在し)|服装(は|が)?自由|標準服/,
  sailor: /セーラー服/,
  gakuran: /学ラン|詰襟|詰め襟|学生服/,
  blazer: /ブレザー/,
  moped: /原付|バイク通学|オートバイ通学|二輪車通学/,
  kyushoku: /給食/,
  no_chime: /ノーチャイム|チャイム(が|は)(鳴ら|な[いし])/,
  odd_period: /(4[05]|5[5-9]|[6-9]\d|1[0-2]\d)分(間)?(の)?授業/,
  saturday: /土曜(日)?(の)?(授業|講習|講座|補習|セミナー)/,
  tokushin: /特進|特別進学|選抜コース|アドバンス/,
  sports_course: /体育コース|スポーツコース|アスリートコース|体育科|スポーツ科/,
  // 歴史・由緒
  kyusei: /旧制中学|尋常中学|中学校 \(旧制\)|旧制.{0,12}中学校/,
  jogakko: /高等女学校|女学校/,
  hanko: /藩校/,
  merge: /統合|合併|再編/,
  castle: /城跡|城址|城内|[^ー]城の|天守|お堀|外堀|内堀/,
  kofun: /古墳|遺跡|貝塚/,
  bunkazai: /登録有形文化財|重要文化財|文化財に(指定|登録)/,
  air_raid: /空襲|戦災|焼失/,
  coed_later: /共学化|男女共学(に|へ)(移行|変更|改組|なっ)/,
  number: /ナンバースクール/,
  // 校風
  shingaku: /進学校/,
  todai: /東京大学|京都大学|旧帝|国公立大学/,
  bunbu: /文武両道/,
  shitsujitsu: /質実剛健/,
  jiyu: /自由な校風|自由闊達|自主自律|自主・自律|自主自立/,
  bankara: /バンカラ|蛮カラ/,
  ouendan: /応援団|応援歌/,
  ouen_practice: /応援歌練習|応援練習|応援歌指導/,
  famous_song: /山田耕筰|信時潔|北原白秋|土井晩翠|佐佐木信綱|古関裕而|團伊玖磨|団伊玖磨|谷川俊太郎|サトウハチロー|西條八十|西条八十|相馬御風|高野辰之|岡野貞一|中田喜直|芥川也寸志|黛敏郎|堀内敬三|折口信夫|草野心平|大木惇夫|三好達治|室生犀星|古賀政男|服部良一|いずみたく|阿久悠/,
  chapel: /礼拝|チャペル|聖書|ミサ/,
  // 行事
  overseas: /修学旅行[^。\n]{0,60}(海外|台湾|韓国|シンガポール|マレーシア|オーストラリア|アメリカ|ハワイ|グアム|カナダ|イギリス|ヨーロッパ|ベトナム|中国)|海外修学旅行/,
  trip_okinawa: /修学旅行[^。\n]{0,40}沖縄/,
  trip_hokkaido: /修学旅行[^。\n]{0,40}北海道/,
  trip_kansai: /修学旅行[^。\n]{0,40}(京都|奈良|関西|大阪)/,
  trip_tokyo: /修学旅行[^。\n]{0,40}(東京|ディズニー|関東)/,
  trip_kyushu: /修学旅行[^。\n]{0,40}(長崎|九州|広島)/,
  ensoku: /強歩|歩行祭|競歩大会|歩く会|遠歩|夜行軍|マラソン大会|ロードレース|耐久遠足|耐寒/,
  enei: /遠泳|臨海学校|臨海実習|水泳訓練/,
  tozan: /学校登山|集団登山|登山行事|全校登山/,
  ski_trip: /スキー教室|スキー合宿|スキー研修|スキー授業|スキー学習|スケート教室/,
  fire: /ファイヤーストーム|ファイアーストーム|後夜祭/,
  kibasen: /騎馬戦|棒倒し/,
  kaso: /仮装/,
  chorus: /合唱コンクール|合唱祭|合唱大会/,
  ball: /クラスマッチ|球技大会/,
  // 施設
  observatory: /天文台|天体観測ドーム|プラネタリウム|天体ドーム/,
  indoor_pool: /屋内プール|温水プール|室内プール/,
  turf: /人工芝/,
  night_light: /ナイター|夜間照明/,
  clock: /時計台|時計塔/,
  tea: /茶室/,
  kyudo: /弓道/,
  tree: /桜並木|銀杏並木|イチョウ並木|ポプラ並木|ケヤキ並木|欅並木|クスノキ|楠|大銀杏|大イチョウ|シンボルツリー|メタセコイア|ヒマラヤ杉|ヒマラヤスギ/,
  farm: /農場|牛舎|演習林|実習田|果樹園|畜舎/,
  ship: /実習船|練習船/,
  // 全国大会（カテゴリ・本文）
  ekiden: /全国高等学校駅伝競走大会|都大路/,
  volley: /全日本バレーボール高等学校選手権|春高バレー|春の高校バレー/,
  basket: /全国高等学校バスケットボール選手権|ウインターカップ|ウィンターカップ/,
  suiso: /全日本吹奏楽コンクール|全日本マーチングコンテスト|全国大会[^。\n]{0,20}吹奏楽|吹奏楽[^。\n]{0,30}全国大会/,
  quiz: /全国高等学校クイズ選手権|高校生クイズ/,
  sobun: /全国高等学校総合文化祭|総文祭/,
  robocon: /ロボコン|ロボットコンテスト|ロボット競技/,
  haiku: /俳句甲子園|書道パフォーマンス甲子園|まんが甲子園|写真甲子園/,
  koshien_win: /全国高等学校野球選手権大会優勝校|選抜高等学校野球大会優勝校|甲子園[^。\n]{0,20}(優勝|全国制覇)/,
  // 部活
  club_any: /==+\s*[^=\n]*(部活動|クラブ活動|部・同好会|課外活動)[^=\n]*==+/,
  c_boat: /ボート部|漕艇|端艇|カヌー部/,
  c_yacht: /ヨット部/,
  c_horse: /馬術部/,
  c_ski: /スキー部/,
  c_skate: /スケート部|アイスホッケー部/,
  c_sangaku: /山岳部|ワンダーフォーゲル|登山部/,
  c_sumo: /相撲部/,
  c_naginata: /なぎなた|薙刀/,
  c_archery: /アーチェリー/,
  c_fencing: /フェンシング/,
  c_rifle: /ライフル射撃|射撃部/,
  c_bike: /自転車競技/,
  c_weight: /ウエイトリフティング|重量挙/,
  c_wrestle: /レスリング/,
  c_boxing: /ボクシング/,
  c_hockey: /(?<!アイス)ホッケー部/,
  c_waterpolo: /水球/,
  c_amefuto: /アメリカンフットボール/,
  c_lacrosse: /ラクロス/,
  c_golf: /ゴルフ部/,
  c_karuta: /かるた|百人一首/,
  c_tetsu: /鉄道研究|鉄道同好会/,
  c_tenmon: /天文部|地学部|天文同好会|天文気象/,
  c_mandolin: /マンドリン|ギター・マンドリン/,
  c_kyodo: /郷土芸能|和太鼓|太鼓部|民謡|神楽|三味線|箏曲|琴部/,
  c_cheer: /チアリーディング|チアダンス|バトン部|バトントワ/,
  c_shinbun: /新聞部/,
  c_hoso: /放送部|放送局|放送委員会/,
};
// ---- 学科（基本情報欄の「設置学科」に対して） ----
const DEPT = {
  d_risu: /理数/,
  d_kokusai: /国際|英語|外国語/,
  d_art: /音楽|美術|芸術|デザイン/,
  d_taiiku: /体育|スポーツ/,
  d_kango: /看護/,
  d_fukushi: /福祉/,
  d_nogyo: /農業|園芸|畜産|酪農|林業|森林|生物生産|食品/,
  d_suisan: /水産|海洋|漁業/,
  d_kogyo: /工業|電気|電子|建築|工学/,
  d_shogyo: /商業|ビジネス|会計|流通/,
  d_katei: /家政|食物|調理|被服|生活|服飾/,
  d_joho: /情報/,
  d_sogo: /総合学科/,
};
// ---- 「著名な出身者」節に対して ----
const ALUMNI = {
  a_yakyu: /プロ野球|野球選手/,
  a_soccer: /サッカー選手|Jリーグ/,
  a_olympic: /オリンピック|五輪/,
  a_rikishi: /力士|大相撲/,
  a_seiji: /政治家|議員|知事|市長|大臣/,
  a_pm: /内閣総理大臣/,
  a_nobel: /ノーベル/,
  a_ana: /アナウンサー/,
  a_geino: /俳優|女優|タレント|歌手|アイドル|声優|ミュージシャン|モデル/,
  a_owarai: /お笑い|漫才|芸人|落語家/,
  a_sakka: /漫画家|小説家|作家|芥川賞|直木賞/,
};
const KW_KEYS = [...Object.keys(TEXT), ...Object.keys(DEPT), ...Object.keys(ALUMNI)];
const KW_INDEX = Object.fromEntries(KW_KEYS.map((k, i) => [k, i]));

const num = (v) => Number(String(v).replace(/[,，]/g, "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)));

function extract(text) {
  const ib = infobox(text);
  const catList = [...text.matchAll(/\[\[(?:Category|カテゴリ):([^\]|]+)/g)].map((m) => m[1].trim());
  // 「○○ (廃止)」は、その学科・課程・別学が過去のものであることを示す
  const cats = catList.filter((c) => !c.includes("(廃止)")).join("\n");
  const catsOld = catList.filter((c) => c.includes("(廃止)")).join("\n");
  const body = text.replace(/==\s*(脚注|出典|参考文献|外部リンク|関連項目)\s*==[\s\S]*$/, "");
  const all = body + "\n" + cats;
  const get = (...keys) => keys.map((k) => ib[k]).find((v) => v) ?? "";

  const g = get("共学・別学", "共学・別学の別");
  const gender = /男子校|男子高等学校/.test(cats) || /^男子/.test(g) ? 2 : /女子校|女子高等学校/.test(cats) || /^女子/.test(g) ? 3 : /共学|別学|併学/.test(g) ? 1 : 0;

  const c = get("課程");
  const course = c
    ? (/全日/.test(c) ? 1 : 0) | (/定時/.test(c) || /定時制高等学校/.test(cats) ? 2 : 0) | (/通信/.test(c) || /通信制高等学校/.test(cats) ? 4 : 0)
    : 0;

  const u = get("単位制・学年制");
  const unit = u ? (/単位制/.test(u.replace(/学年制(と|による)単位制/g, "")) ? 2 : 1) : 0;

  const d = get("設置学科");
  const rest = d.replace(/普通科/g, "").replace(/[\s、,・（）()]/g, "");
  const dept = d ? (/普通科/.test(d) ? 1 : 0) | (rest.length >= 2 ? 2 : 0) | (/総合学科/.test(d) ? 4 : 0) : 0;

  const t = get("学期");
  const term = /2学期|二学期|前期/.test(t) ? 2 : /3学期|三学期/.test(t) ? 3 : 0;

  const founded = year(get("設立年月日", "創立年月日", "創立", "設立"));

  const ikkanV = get("中高一貫教育", "小中高大一貫教育", "小中高一貫教育", "中高大一貫教育", "幼小中高一貫教育");
  const ikkan = /中高一貫校/.test(cats) || /併設|連携|完全|中等/.test(ikkanV) ? 1 : 0;

  const rel = /カトリック|プロテスタント|キリスト教|聖公会|ルーテル|バプテスト|メソジスト|正教/.test(cats)
    ? 1
    : /仏教|浄土|真言|曹洞|日蓮|天台|臨済|禅宗/.test(cats)
      ? 2
      : /神道|天理教|金光教|PL教|創価|立正佼成|新宗教|黒住|霊友会|世界救世|モルモン|統一教会/.test(cats)
        ? 3
        : 0;

  const sports =
    (/野球選手権大会出場校|選抜高等学校野球大会出場校/.test(cats) ? 1 : 0) |
    (/ラグビーフットボール大会出場校/.test(cats) ? 2 : 0) |
    (/サッカー選手権大会出場校/.test(cats) ? 4 : 0) |
    (/スーパーサイエンスハイスクール/.test(cats) ? 8 : 0) |
    (/スーパーグローバルハイスクール|国際バカロレア/.test(cats) ? 16 : 0);

  // 著名な出身者
  const sec = body.match(/==+\s*[^=\n]*(出身者|卒業生|関係者)[^=\n]*==+([\s\S]*?)(?=\n==[^=]|$)/);
  const alumText = sec ? sec[2] : "";
  const alum = (alumText.match(/^\*+/gm) ?? []).length;

  const kw = [];
  for (const [k, re] of Object.entries(TEXT)) if (re.test(all)) kw.push(KW_INDEX[k]);
  for (const [k, re] of Object.entries(DEPT)) if (d && re.test(d)) kw.push(KW_INDEX[k]);
  for (const [k, re] of Object.entries(ALUMNI)) if (re.test(alumText)) kw.push(KW_INDEX[k]);
  const add = (k) => !kw.includes(KW_INDEX[k]) && kw.push(KW_INDEX[k]);
  if (/(男子|女子)高等学校 \(廃止\)/.test(catsOld) && gender === 1) add("coed_later");
  if (/登録有形文化財|重要文化財/.test(cats)) add("bunkazai");

  // 規模（書かれている場合のみ）
  const cl = body.match(/(?:1|一|各)学年(?:あたり)?\s*([0-9０-９]{1,2})\s*(?:学級|クラス)/);
  const classes = cl ? num(cl[1]) : 0;
  const stu = body.match(/(?:生徒数|在籍(?:者|生徒)数|全校生徒)[^0-9０-９\n]{0,12}([0-9０-９,，]{2,6})\s*(?:人|名)/);
  const students = stu ? num(stu[1]) : 0;

  return { wiki: 1, gender, course, unit, dept, term, founded, ikkan, rel, kw, sports, alum: Math.min(alum, 999), wlen: Math.round(body.length / 1000), classes, students };
}

const EMPTY = { wiki: 0, gender: 0, course: 0, unit: 0, dept: 0, term: 0, founded: 0, ikkan: 0, rel: 0, kw: [], sports: 0, alum: 0, wlen: 0, classes: 0, students: 0 };

if (process.argv[1] === import.meta.filename) {
  const pages = new Map();
  for (const line of fs.readFileSync(path.join(CACHE, "pages.jsonl"), "utf8").split("\n"))
    if (line) { const p = JSON.parse(line); pages.set(p.title, p.text); }
  const match = JSON.parse(fs.readFileSync(path.join(CACHE, "match.json"), "utf8"));
  const schools = loadSchools();

  if (process.argv.includes("--explore")) {
    const cat = new Map(), keys = new Map();
    for (const title of new Set(Object.values(match))) {
      const text = pages.get(title);
      for (const m of text.matchAll(/\[\[(?:Category|カテゴリ):([^\]|]+)/g)) {
        const k = m[1].replace(/^(北海道|東京都|.{2,3}[府県])の/, "X県の").replace(/^.{1,6}[市区町村]の/, "X市の");
        cat.set(k, (cat.get(k) ?? 0) + 1);
      }
      for (const k of Object.keys(infobox(text))) keys.set(k, (keys.get(k) ?? 0) + 1);
    }
    const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}:${v}`).join(" | ");
    console.log("CATEGORIES\n" + top(cat, 150));
    console.log("\nINFOBOX KEYS\n" + top(keys, 60));
  }

  const result = {};
  const stat = {};
  let matched = 0;
  for (const s of schools) {
    const key = s.key.split(":").slice(0, 2).join(":");
    const title = match[s.key];
    const f = title ? extract(pages.get(title)) : EMPTY;
    result[key] = f;
    if (!f.wiki) continue;
    matched++;
    for (const [k, v] of Object.entries(f)) if (k !== "kw" && v) stat[k] = (stat[k] ?? 0) + 1;
    for (const i of f.kw) stat[`kw.${KW_KEYS[i]}`] = (stat[`kw.${KW_KEYS[i]}`] ?? 0) + 1;
  }
  fs.writeFileSync(OUT, JSON.stringify({ kwKeys: KW_KEYS, empty: EMPTY, schools: result }));
  console.log(`wrote ${OUT}: ${matched}/${schools.length} 校に記事あり`);
  console.log("値が入っている校数:", stat);

  if (fs.existsSync(SCHOOLS_JSON)) {
    const j = JSON.parse(fs.readFileSync(SCHOOLS_JSON, "utf8"));
    const fields = [...j.fields, ...Object.keys(EMPTY).filter((k) => !j.fields.includes(k))];
    const iCode = j.fields.indexOf("code"), iName = j.fields.indexOf("name");
    const rows = j.rows.map((r) => {
      const f = result[`${r[iCode]}:${r[iName]}`] ?? EMPTY;
      return fields.map((k, i) => (k in EMPTY ? f[k] : r[i]));
    });
    fs.writeFileSync(SCHOOLS_JSON, JSON.stringify({ ...j, kwKeys: KW_KEYS, fields, rows }));
    console.log(`patched ${SCHOOLS_JSON}`);
  }
}

export { extract, KW_KEYS };
