// public/data/schools.json（scripts/build-data.mjs の出力）を読み込んで扱いやすい形にする。

export type RawSchool = {
  name: string;
  /** 市区町村コード（5桁） */
  code: string;
  addr: string;
  /** 1=国立 2=都道府県立 3=市区町村立 4=私立 */
  admin: number;
  lat: number;
  lon: number;
  /** 標高(m) */
  elev: number;
  /** 周囲700mの低い側との高低差(m)。大きいほど「坂の上」 */
  rise: number;
  /** 周囲700mの高い側との高低差(m)。大きいほど「山すそ・谷あい」 */
  drop: number;
  /** 最寄りの海までの距離(m)。10km圏内に海がなければ -1 */
  coast: number;
  /** 最寄りの海の方角 0=北 2=東 4=南 6=西 */
  coastDir: number;
  /** 72方位のうち海が見通せる本数 */
  seaVis: number;
  /** 海が見える方角のビットマスク（8方位） */
  seaMask: number;
  /** 72方位のうち山の稜線が見える本数 */
  mt: number;
  /** 最寄り駅 */
  st: string;
  stDist: number;
  stJr: number;
  stOther: number;
  stShin: number;
  /** 最寄り駅から見た学校の高さ(m)。駅が遠い場合 null */
  stUp: number | null;
  /** 1.5km以内の駅数 */
  stCount: number;
  /** 1.5km以内の学校・園の数（市街地度の目安） */
  dens: number;
  univ: number;
  hs: number;
  jh: number;
  /** すぐ隣(200m)に小学校がある */
  es: number;
  /** 8km以内に海がある方角の数（0〜8） */
  seaSec: number;
  /** 本土と陸続きでない島にある */
  island: number;
  /** 見通せる名峰（peaks のインデックス） */
  pk: number[];
  /** pk と同じ並び: 稜線の上に出ている見かけの高さ（0.01度単位、負は惜しくも隠れる） */
  pka: number[];
  /** pk と同じ並び: 峰までの距離(km) */
  pkd: number[];
  tram: number;
  subway: number;
  mono: number;
  /** 最寄りの線路までの距離(m)。3km以内になければ -1 */
  rail: number;
  /** 最寄りの新幹線の線路までの距離(m)。3km以内になければ -1 */
  shinRail: number;
  /** 県境の近さ: 他県の学校までの距離(m)。8km以内になければ -1 */
  border: number;
  // ---- 学校のまわり800mの地物（scripts/build-bvmap.mjs。地理院地図の地図記号などの数） ----
  paddy: number;
  field: number;
  tea: number;
  orchard: number;
  /** 400m以内の林（広葉樹・針葉樹の記号数） */
  forest: number;
  bamboo: number;
  /** 250m以内の神社・寺の数 */
  shrine: number;
  temple: number;
  /** 800m以内の寺の数 */
  temples: number;
  /** 400m以内の墓地 */
  grave: number;
  castleNear: number;
  historic: number;
  lighthouse: number;
  port: number;
  tower: number;
  chimney: number;
  windmill: number;
  cityhall: number;
  hospital: number;
  onsen: number;
  park: number;
  /** 500m以内に占める川・池などの水面の割合(%) */
  water: number;
  /** 最寄りの水面までの距離(m)。600m以内になければ -1 */
  waterD: number;
  lake: number;
  /** 最寄りの川の名前（地図に注記がある場合） */
  river: string;
  /** 最寄りの高速道路までの距離(m)。800m以内になければ -1 */
  mw: number;
  // ---- Wikipedia 由来（scripts/build-wiki.mjs）。記事が見つからない学校は wiki=0 で、以下すべて 0 ----
  wiki: number;
  /** 0=不明 1=共学 2=男子校 3=女子校 */
  gender: number;
  /** 課程のビット: 1=全日制 2=定時制 4=通信制（0=不明） */
  course: number;
  /** 0=不明 1=学年制 2=単位制 */
  unit: number;
  /** 学科のビット: 1=普通科 2=普通科以外 4=総合学科（0=不明） */
  dept: number;
  /** 0=不明 2=2学期制 3=3学期制 */
  term: number;
  /** 創立年（0=不明） */
  founded: number;
  ikkan: number;
  /** 0=なし/不明 1=キリスト教系 2=仏教系 3=その他の宗教系 */
  rel: number;
  /** 本文中に記述のあるキーワード（kwKeys のインデックス） */
  kw: number[];
  /** 1=甲子園 2=花園 4=冬の高校サッカー 8=SSH 16=SGH/IB */
  sports: number;
  /** 著名な出身者として挙がっている人数 */
  alum: number;
  /** 記事の長さ（千文字） */
  wlen: number;
  /** 1学年のクラス数（記事に書かれている場合のみ。0=不明） */
  classes: number;
  /** 生徒数（記事に書かれている場合のみ。0=不明） */
  students: number;
};

/** Wikipedia 記事にその話題の記述があるか（キーワード名は scripts/build-wiki.mjs を参照） */
export const mentions = (s: School, k: string) => s.kws.has(k);

export type School = RawSchool & {
  /** 都道府県コード 1..47 */
  pref: number;
  /** 「高等学校」などを除いた校名 */
  base: string;
  /** 市区町村名（例: 鎌倉市） */
  muni: string;
  /** Wikipedia 記事に記述のあるキーワード */
  kws: Set<string>;
};

export const PREFS = [
  "",
  "北海道",
  "青森県",
  "岩手県",
  "宮城県",
  "秋田県",
  "山形県",
  "福島県",
  "茨城県",
  "栃木県",
  "群馬県",
  "埼玉県",
  "千葉県",
  "東京都",
  "神奈川県",
  "新潟県",
  "富山県",
  "石川県",
  "福井県",
  "山梨県",
  "長野県",
  "岐阜県",
  "静岡県",
  "愛知県",
  "三重県",
  "滋賀県",
  "京都府",
  "大阪府",
  "兵庫県",
  "奈良県",
  "和歌山県",
  "鳥取県",
  "島根県",
  "岡山県",
  "広島県",
  "山口県",
  "徳島県",
  "香川県",
  "愛媛県",
  "高知県",
  "福岡県",
  "佐賀県",
  "長崎県",
  "熊本県",
  "大分県",
  "宮崎県",
  "鹿児島県",
  "沖縄県",
];

export function adminLabel(s: School): string {
  if (/[都道府県市区町村]立|国立/.test(s.name)) return "";
  if (s.admin === 1) return "国立";
  if (s.admin === 2) return s.pref === 1 ? "道立" : s.pref === 13 ? "都立" : s.pref === 26 || s.pref === 27 ? "府立" : "県立";
  if (s.admin === 3) return "市立";
  if (s.admin === 4) return "私立";
  return "";
}

const SUFFIX = /高等学校|中等教育学校|高等学院|高等学園|高等学部|高等部|高等科|高校/g;

function municipality(addr: string, code: string): string {
  let a = addr;
  if (Number(code.slice(2)) >= 300) a = a.replace(/^.+?郡/, "");
  const m = a.match(/^.+?[市区町村]/);
  if (!m) return "";
  let name = m[0];
  // 四日市市・玉村町・大町町 のように、区切り文字が名前の一部になっている場合
  while (/[市区町村]/.test(a[name.length] ?? "") && name.length < 6) name += a[name.length];
  return name;
}

export type Db = { schools: School[]; peaks: string[] };
type SchoolsJson = { peaks?: string[]; kwKeys?: string[]; fields: string[]; rows: unknown[][] };
const MAP_DEFAULTS = {
  paddy: 0,
  field: 0,
  tea: 0,
  orchard: 0,
  forest: 0,
  bamboo: 0,
  shrine: 0,
  temple: 0,
  temples: 0,
  grave: 0,
  castleNear: 0,
  historic: 0,
  lighthouse: 0,
  port: 0,
  tower: 0,
  chimney: 0,
  windmill: 0,
  cityhall: 0,
  hospital: 0,
  onsen: 0,
  park: 0,
  water: 0,
  waterD: -1,
  lake: 0,
  river: "",
  mw: -1,
};
const WIKI_DEFAULTS = {
  wiki: 0,
  gender: 0,
  course: 0,
  unit: 0,
  dept: 0,
  term: 0,
  founded: 0,
  ikkan: 0,
  rel: 0,
  kw: [] as number[],
  sports: 0,
  alum: 0,
  wlen: 0,
  classes: 0,
  students: 0,
};

export function hydrate(json: SchoolsJson): Db {
  const seen = new Map<string, School[]>();
  const out: School[] = [];
  for (const row of json.rows) {
    const raw = { ...MAP_DEFAULTS, ...WIKI_DEFAULTS, ...Object.fromEntries(json.fields.map((f, i) => [f, row[i]])) } as RawSchool;
    const name = raw.name.normalize("NFKC");
    const addr = raw.addr.normalize("NFKC");
    const s: School = {
      ...raw,
      name,
      addr,
      pref: Number(raw.code.slice(0, 2)),
      base: name.replace(SUFFIX, "").replace(/[()（）\s]/g, ""),
      muni: municipality(addr, raw.code),
      kws: new Set((Array.isArray(raw.kw) ? raw.kw : []).map((i) => json.kwKeys?.[i] ?? "")),
    };
    // 全日制・定時制などで同じ学校が二重に載っているものをまとめる
    const key = `${s.pref}:${s.name}:${s.admin}`;
    const dup = seen.get(key)?.some((o) => Math.abs(o.lat - s.lat) < 0.01 && Math.abs(o.lon - s.lon) < 0.01);
    if (dup) continue;
    seen.set(key, [...(seen.get(key) ?? []), s]);
    out.push(s);
  }
  return { schools: out, peaks: json.peaks ?? [] };
}

export async function loadSchools(): Promise<Db> {
  const res = await fetch("/data/schools.json");
  if (!res.ok) throw new Error(`schools.json: ${res.status}`);
  return hydrate(await res.json());
}
