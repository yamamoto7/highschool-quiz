// 質問の定義。各質問は「その高校の出身者が『はい』と答えそうな確率」を、地形・立地データと
// Wikipedia 由来の学校情報から決める。
// データは推定を含むので、確率は 0/1 に振り切らず、1問の食い違いで正解が消えないようにしている。

import { mentions, PREFS, type School } from "./data";
import type { DenseQuestion, Question, SparseQuestion } from "./engine";
import RANKS from "./question-ranks.json";

/** 手動のランクづけ（lib/question-ranks.json）。S〜C は優先度を上書きし、X はその質問を出さない。 */
const RANK_DRAMA: Record<string, number> = { S: 1.4, A: 1.15, B: 0.9, C: 0.4, D: 0.12 };
const rankKey = (id: string) => id.replace(/^(peak|kanji|st|pref|region|river)_.*$/, "$1");
function applyRanks(questions: Question[]): Question[] {
  const ranks = RANKS as Record<string, string>;
  return questions
    .filter((q) => ranks[rankKey(q.id)] !== "X")
    .map((q) => {
      const d = RANK_DRAMA[ranks[rankKey(q.id)]];
      // C は「他に手がないときだけ」なので、元の優先度より上げることはしない
      return d ? { ...q, drama: /[CD]/.test(ranks[rankKey(q.id)]) ? Math.min(q.drama, d) : d } : q;
    });
}

const sig = (x: number, mid: number, width: number) => 1 / (1 + Math.exp(-(x - mid) / width));
const clamp = (p: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, p));

/** 2地点間の距離(km) */
const km = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const k = Math.PI / 180;
  const x = (lon2 - lon1) * k * Math.cos(((lat1 + lat2) / 2) * k);
  return Math.hypot(x, (lat2 - lat1) * k) * 6371;
};
const nearestKm = (s: School, pts: [number, number][]) => Math.min(...pts.map(([lat, lon]) => km(s.lat, s.lon, lat, lon)));
/** 都道府県コードごとの確率表 */
const byPref = (table: Record<number, number>, rest: number) => (s: School) => table[s.pref] ?? rest;
const range = (a: number, b: number, v: number) => Object.fromEntries(Array.from({ length: b - a + 1 }, (_, i) => [a + i, v]));

// 空港・航空基地（緯度, 経度）
const AIRFIELDS: [number, number][] = [
  [35.553, 139.781],
  [35.765, 140.386],
  [34.785, 135.438],
  [34.434, 135.244],
  [34.858, 136.805],
  [33.585, 130.451],
  [42.775, 141.692],
  [26.196, 127.646],
  [38.14, 140.917],
  [34.436, 132.919],
  [31.803, 130.719],
  [32.837, 130.855],
  [32.917, 129.914],
  [31.877, 131.449],
  [33.827, 132.7],
  [34.214, 134.016],
  [34.633, 135.224],
  [36.395, 136.407],
  [37.956, 139.121],
  [35.455, 139.45],
  [35.748, 139.348],
  [26.356, 127.768],
  [26.274, 127.756],
  [34.144, 132.236],
  [40.703, 141.368],
  [35.842, 139.411],
  [36.181, 140.415],
  [35.255, 136.924],
  [34.596, 135.603],
  [35.672, 139.528],
  [41.77, 140.822],
  [43.671, 142.447],
  [33.479, 131.737],
  [33.546, 133.669],
  [34.757, 133.855],
  [39.616, 140.219],
  [40.735, 140.691],
  [34.133, 134.607],
  [33.846, 131.035],
  [33.685, 131.04],
  [32.084, 131.451],
  [34.75, 137.703],
  [35.394, 136.87],
  [38.405, 141.22],
  [34.813, 138.298],
  [35.799, 140.011],
  [35.398, 139.91],
  [35.71, 139.403],
];

/** buildQuestions の冒頭で作る、学校全体を見渡した集計 */
let ctx = { hsInMuni: new Map<string, number>(), tramMuni: new Set<string>() };

type Def = {
  id: string;
  text: string;
  drama: number;
  p: (s: School) => number;
  /** 確率の下限・上限（省略時 0.05〜0.95） */
  range?: [number, number];
  minAsked?: number;
};

const bool = (v: unknown, yes = 0.97, no = 0.02) => (v ? yes : no);
/**
 * Wikipedia 本文に記述があるかどうかで確率を決める。
 * 記述あり→hi、なし→lo（記事が長いのに書かれていなければ loLong）。記事がなければ unknown（省略時は全体平均）。
 */
const said =
  (k: string, hi: number, lo: number, loLong: number, unknown: (s: School) => number = () => NaN) =>
  (s: School) =>
    !s.wiki ? unknown(s) : mentions(s, k) ? hi : s.wlen >= 8 ? loLong : lo;
const HARD: [number, number] = [0.02, 0.98];

// 冬に雪が積もるのが当たり前かどうか（都道府県ごとの目安。標高で補正する）
const SNOW: Record<number, number> = {
  1: 0.97,
  2: 0.97,
  3: 0.9,
  4: 0.45,
  5: 0.97,
  6: 0.97,
  7: 0.55,
  15: 0.9,
  16: 0.9,
  17: 0.8,
  18: 0.8,
  20: 0.7,
  21: 0.3,
  10: 0.15,
  9: 0.12,
  19: 0.15,
  31: 0.6,
  32: 0.4,
  25: 0.35,
  26: 0.12,
  28: 0.1,
};
const LANDLOCKED = new Set([9, 10, 11, 19, 20, 21, 25, 29]);
const CAPITALS: Record<number, string> = {
  1: "札幌市",
  2: "青森市",
  3: "盛岡市",
  4: "仙台市",
  5: "秋田市",
  6: "山形市",
  7: "福島市",
  8: "水戸市",
  9: "宇都宮市",
  10: "前橋市",
  11: "さいたま市",
  12: "千葉市",
  14: "横浜市",
  15: "新潟市",
  16: "富山市",
  17: "金沢市",
  18: "福井市",
  19: "甲府市",
  20: "長野市",
  21: "岐阜市",
  22: "静岡市",
  23: "名古屋市",
  24: "津市",
  25: "大津市",
  26: "京都市",
  27: "大阪市",
  28: "神戸市",
  29: "奈良市",
  30: "和歌山市",
  31: "鳥取市",
  32: "松江市",
  33: "岡山市",
  34: "広島市",
  35: "山口市",
  36: "徳島市",
  37: "高松市",
  38: "松山市",
  39: "高知市",
  40: "福岡市",
  41: "佐賀市",
  42: "長崎市",
  43: "熊本市",
  44: "大分市",
  45: "宮崎市",
  46: "鹿児島市",
  47: "那覇市",
};
const muniNo = (s: School) => Number(s.code.slice(2));
/** 政令指定都市・東京23区 */
const isWardCity = (s: School) => muniNo(s) >= 100 && muniNo(s) < 200;
const isCapital = (s: School) => (s.pref === 13 ? isWardCity(s) : s.muni === CAPITALS[s.pref]);
const seaTo = (s: School, dirs: number[]) =>
  s.coast >= 0 && s.coast < 8000 && (dirs.includes(s.coastDir) || dirs.some((d) => s.seaMask & (1 << d)));

const DEFS: Def[] = [
  // ---- 風景 ----
  {
    id: "sea_view",
    text: "校舎や通学路から、海が見えましたか？",
    drama: 1.25,
    p: (s) =>
      s.seaVis >= 6
        ? 0.92
        : s.seaVis >= 2
          ? 0.75
          : s.seaVis === 1
            ? 0.5
            : s.coast >= 0 && s.coast < 700
              ? 0.45
              : s.coast >= 0 && s.coast < 2000
                ? 0.15
                : 0.02,
    range: [0.02, 0.95],
  },
  {
    id: "sea_bike",
    text: "海まで、自転車でふらっと行ける距離でしたか？",
    drama: 1.0,
    p: (s) => (s.coast < 0 ? 0.03 : 1 - sig(s.coast, 5000, 1200)),
    range: [0.03, 0.96],
  },
  {
    id: "sea_sunset",
    text: "海に夕日が沈む町でしたか？",
    drama: 1.1,
    p: (s) => (seaTo(s, [5, 6, 7]) ? 0.8 : s.coast >= 0 && s.coast < 8000 ? 0.12 : 0.03),
    range: [0.03, 0.9],
  },
  {
    id: "sea_sunrise",
    text: "海から朝日が昇る町でしたか？",
    drama: 1.05,
    p: (s) => (seaTo(s, [1, 2, 3]) ? 0.8 : s.coast >= 0 && s.coast < 8000 ? 0.12 : 0.03),
    range: [0.03, 0.9],
  },
  {
    id: "hill",
    text: "学校は、坂をのぼった先にありましたか？",
    drama: 1.25,
    p: (s) => sig(Math.max(s.rise, (s.stUp ?? 0) * 0.8), 15, 5),
  },
  {
    id: "foot",
    text: "校舎のすぐ裏手に、山や丘がせまっていましたか？",
    drama: 1.1,
    p: (s) => sig(s.drop, 30, 8),
  },
  {
    id: "mt_view",
    text: "教室の窓から、山並みが見えましたか？",
    drama: 1.0,
    p: (s) => (s.mt >= 20 ? 0.9 : s.mt >= 8 ? 0.7 : s.mt >= 2 ? 0.4 : 0.1),
    range: [0.08, 0.92],
  },
  {
    id: "basin",
    text: "ぐるりと四方を山に囲まれた土地でしたか？",
    drama: 1.1,
    p: (s) => (s.mt >= 52 ? 0.85 : s.mt >= 38 ? 0.5 : s.mt >= 25 ? 0.2 : 0.04),
    range: [0.04, 0.9],
  },
  {
    id: "highland",
    text: "夏でも朝晩は涼しい、標高の高い土地でしたか？",
    drama: 1.0,
    p: (s) => sig(s.elev, 450, 90),
    range: [0.03, 0.95],
  },
  {
    id: "snow",
    text: "冬、校庭が雪で真っ白になるのは当たり前でしたか？",
    drama: 1.15,
    p: (s) => Math.max(SNOW[s.pref] ?? 0.03, 0.85 * sig(s.elev, 600, 120)),
    range: [0.03, 0.97],
  },
  {
    id: "sakura",
    text: "桜が咲くのは、入学式よりも後でしたか？",
    drama: 1.15,
    p: (s) => sig(s.lat + s.elev / 250, 38.0, 0.45),
    range: [0.03, 0.96],
  },
  // ---- 通学・まわりの様子 ----
  {
    id: "walk",
    text: "最寄り駅から、歩いて10分かからずに着きましたか？",
    drama: 0.95,
    p: (s) => (s.stDist < 0 ? 0.03 : 1 - sig(s.stDist, 800, 180)),
  },
  {
    id: "far",
    text: "最寄り駅から歩くのはきつく、バスや自転車が頼りでしたか？",
    drama: 0.95,
    p: (s) => (s.stDist < 0 ? 0.95 : sig(s.stDist, 2300, 450)),
  },
  {
    id: "jr",
    text: "最寄り駅は、JRの駅でしたか？",
    drama: 0.85,
    p: (s) => {
      const jr = s.stJr < 0 ? 1e6 : s.stJr;
      const ot = s.stOther < 0 ? 1e6 : s.stOther;
      if (Math.min(jr, ot) > 6000) return 0.4;
      return sig(ot - jr, 0, 250);
    },
    range: [0.08, 0.92],
    minAsked: 4,
  },
  {
    id: "many_st",
    text: "歩ける範囲に、駅が3つ以上ありましたか？",
    drama: 0.9,
    p: (s) => (s.stCount >= 4 ? 0.9 : s.stCount === 3 ? 0.7 : s.stCount === 2 ? 0.25 : 0.04),
    range: [0.04, 0.92],
  },
  {
    id: "shinkansen",
    text: "新幹線の停まる駅が、同じ街にありましたか？",
    drama: 0.95,
    p: (s) => (s.stShin < 0 ? 0.02 : 0.92 * (1 - sig(s.stShin, 6000, 1500))),
    range: [0.02, 0.92],
  },
  {
    id: "urban",
    text: "学校のまわりは、ビルやマンションの立ち並ぶ街なかでしたか？",
    drama: 0.95,
    p: (s) => sig(s.dens, 24, 5),
    range: [0.08, 0.9],
  },
  {
    id: "univ",
    text: "歩いて行けるところに、大学がありましたか？",
    drama: 0.9,
    p: (s) => bool(s.univ, 0.8, 0.1),
  },
  {
    id: "hs",
    text: "目と鼻の先に、別の高校がありましたか？",
    drama: 0.95,
    p: (s) => bool(s.hs, 0.85, 0.1),
  },
  {
    id: "jh",
    text: "同じ敷地に、中学校（中等部）がありましたか？",
    drama: 0.85,
    p: (s) => bool(s.jh, 0.85, 0.06),
    minAsked: 5,
  },
  // ---- 土地柄 ----
  { id: "landlocked", text: "海のない県でしたか？", drama: 0.9, p: (s) => bool(LANDLOCKED.has(s.pref)), range: HARD, minAsked: 5 },
  {
    id: "capital",
    text: "県庁所在地（東京なら23区内）にありましたか？",
    drama: 0.75,
    p: (s) => bool(isCapital(s)),
    range: HARD,
    minAsked: 7,
  },
  {
    id: "ward_city",
    text: "「区」のある大きな市（政令指定都市か東京23区）にありましたか？",
    drama: 0.7,
    p: (s) => bool(isWardCity(s)),
    range: HARD,
    minAsked: 7,
  },
  {
    id: "town",
    text: "学校の住所は、「市」ではなく「町」や「村」でしたか？",
    drama: 0.8,
    p: (s) => bool(muniNo(s) >= 300),
    range: HARD,
    minAsked: 6,
  },
  { id: "honshu", text: "本州にありましたか？", drama: 0.6, p: (s) => bool(s.pref >= 2 && s.pref <= 35), range: HARD, minAsked: 9 },
  // ---- 学校のまわりの景色（地理院地図の地図記号・水面・道路から） ----
  {
    id: "riverside",
    text: "川の土手や河川敷が、すぐ近くにありましたか？",
    drama: 1.3,
    p: (s) => {
      // 地図の「水面」には海も含まれるので、海辺の学校は川の名前が近くにある場合だけ川とみなす
      const seaside = s.coast >= 0 && s.coast < 800 && !s.river;
      if (s.lake || seaside) return 0.2;
      return s.water >= 6 ? 0.9 : s.water >= 2 ? 0.7 : s.waterD >= 0 && s.waterD < 300 ? 0.45 : s.waterD >= 0 ? 0.2 : 0.06;
    },
    range: [0.05, 0.92],
  },
  {
    id: "lake",
    text: "湖や大きな池のほとりにある学校でしたか？",
    drama: 1.3,
    // 名前のついた湖沼が近い、または内陸で川の名前がないのに水面が広い
    p: (s) => (s.lake ? 0.8 : s.water >= 8 && s.coast < 0 && !s.river ? 0.35 : 0.03),
    range: [0.03, 0.85],
  },
  {
    id: "paddy",
    text: "学校のまわりに、田んぼが広がっていましたか？",
    drama: 1.3,
    p: (s) => (s.paddy >= 10 ? 0.9 : s.paddy >= 4 ? 0.65 : s.paddy >= 1 ? 0.3 : 0.05),
  },
  {
    id: "tea",
    text: "通学路に、茶畑がありましたか？",
    drama: 1.3,
    p: (s) => (s.tea >= 3 ? 0.88 : s.tea >= 1 ? 0.5 : 0.02),
    range: [0.02, 0.9],
  },
  {
    id: "orchard",
    text: "学校のまわりに、果樹園（りんご・みかん・ぶどう・梨など）がありましたか？",
    drama: 1.3,
    p: (s) => (s.orchard >= 4 ? 0.85 : s.orchard >= 1 ? 0.5 : 0.04),
    range: [0.04, 0.88],
  },
  {
    id: "field",
    text: "学校のまわりは、田んぼではなく畑が多い土地でしたか？",
    drama: 1.1,
    p: (s) => (s.field >= 8 && s.field > s.paddy * 2 ? 0.8 : s.field >= 4 && s.field > s.paddy ? 0.45 : 0.08),
    range: [0.06, 0.85],
  },
  {
    id: "forest",
    text: "校舎のすぐ裏が、林や森でしたか？",
    drama: 1.25,
    p: (s) => (s.forest >= 5 ? 0.85 : s.forest >= 2 ? 0.55 : s.forest === 1 ? 0.25 : 0.05),
  },
  {
    id: "bamboo",
    text: "学校の近くに、竹林がありましたか？",
    drama: 1.2,
    p: (s) => (s.bamboo >= 2 ? 0.75 : s.bamboo === 1 ? 0.45 : 0.06),
    range: [0.05, 0.8],
  },
  { id: "shrine", text: "学校のすぐ隣に、神社がありましたか？", drama: 1.3, p: (s) => bool(s.shrine, 0.8, 0.06) },
  { id: "temple", text: "学校のすぐ隣に、お寺がありましたか？", drama: 1.3, p: (s) => bool(s.temple, 0.8, 0.06) },
  {
    id: "teramachi",
    text: "学校のまわりに、お寺がいくつも集まっていましたか？",
    drama: 1.2,
    p: (s) => (s.temples >= 6 ? 0.85 : s.temples >= 3 ? 0.45 : 0.04),
    range: [0.04, 0.88],
  },
  { id: "grave", text: "校舎の窓から、お墓（墓地）が見えましたか？", drama: 1.35, p: (s) => bool(s.grave, 0.75, 0.05), range: [0.05, 0.8] },
  {
    id: "historic",
    text: "すぐ近くに、史跡や名勝がありましたか？",
    drama: 1.1,
    p: (s) => bool(s.historic, 0.7, 0.08),
    range: [0.08, 0.75],
  },
  {
    id: "lighthouse",
    text: "学校の近くに、灯台がありましたか？",
    drama: 1.3,
    p: (s) => bool(s.lighthouse, 0.8, 0.01),
    range: [0.01, 0.85],
  },
  {
    id: "port",
    text: "港（漁港）が、すぐ近くにありましたか？",
    drama: 1.3,
    p: (s) => bool(s.port, 0.85, s.coast >= 0 && s.coast < 1500 ? 0.15 : 0.01),
    range: [0.01, 0.88],
  },
  {
    id: "tower",
    text: "学校のすぐそばに、電波塔（大きな鉄塔）が立っていましたか？",
    drama: 1.2,
    p: (s) => bool(s.tower, 0.7, 0.05),
    range: [0.05, 0.75],
  },
  { id: "chimney", text: "学校から、工場の煙突が見えましたか？", drama: 1.25, p: (s) => bool(s.chimney, 0.75, 0.06), range: [0.05, 0.8] },
  {
    id: "windmill",
    text: "学校から、風力発電の風車が見えましたか？",
    drama: 1.3,
    p: (s) => bool(s.windmill, 0.85, 0.02),
    range: [0.02, 0.88],
  },
  { id: "cityhall", text: "市役所（町役場）が、歩いてすぐのところにありましたか？", drama: 1.1, p: (s) => bool(s.cityhall, 0.85, 0.06) },
  {
    id: "hospital",
    text: "学校のすぐ隣に、大きな病院がありましたか？",
    drama: 1.15,
    p: (s) => bool(s.hospital, 0.75, 0.05),
    range: [0.05, 0.8],
  },
  { id: "onsen", text: "温泉街の近くにある学校でしたか？", drama: 1.3, p: (s) => bool(s.onsen, 0.8, 0.02), range: [0.02, 0.85] },
  { id: "park", text: "学校のすぐ隣に、大きな公園がありましたか？", drama: 1.15, p: (s) => bool(s.park, 0.8, 0.1) },
  {
    id: "motorway",
    text: "校舎のすぐそばを、高速道路が走っていましたか？",
    drama: 1.25,
    p: (s) => (s.mw < 0 ? 0.03 : s.mw < 300 ? 0.85 : s.mw < 600 ? 0.5 : 0.2),
    range: [0.03, 0.88],
  },

  // ---- 街の音・空・暮らし ----
  {
    id: "only_hs",
    text: "その市や町に、高校はそこ1校だけでしたか？",
    drama: 1.25,
    p: (s) => (ctx.hsInMuni.get(s.code) === 1 ? 0.9 : ctx.hsInMuni.get(s.code) === 2 ? 0.12 : 0.02),
    range: [0.02, 0.92],
  },
  {
    id: "wildlife",
    text: "校内や通学路に、鹿・猿・熊・イノシシなどが出たことがありますか？",
    drama: 1.3,
    p: (s) => (s.dens <= 4 && s.mt >= 20 ? 0.75 : s.dens <= 8 && s.mt >= 10 ? 0.45 : s.dens >= 20 ? 0.05 : 0.15),
    range: [0.05, 0.8],
  },
  {
    id: "tsunami",
    text: "海抜が低く、津波や高潮の避難訓練がやけに真剣な学校でしたか？",
    drama: 1.1,
    p: (s) => (s.coast < 0 ? 0.03 : s.elev <= 6 && s.coast < 2500 ? 0.7 : s.elev < 10 && s.coast < 5000 ? 0.35 : 0.06),
    range: [0.03, 0.8],
  },
  {
    id: "ash",
    text: "風向きによって、火山灰が降ってくる日がありましたか？",
    drama: 1.3,
    p: (s) => {
      const sakura = km(s.lat, s.lon, 31.585, 130.657);
      if (sakura < 25) return 0.93;
      if (sakura < 50) return 0.6;
      if (km(s.lat, s.lon, 32.884, 131.104) < 20) return 0.5;
      if (km(s.lat, s.lon, 31.91, 130.886) < 20) return 0.4;
      return 0.01;
    },
    range: [0.01, 0.95],
  },
  {
    id: "airfield",
    text: "授業中、飛行機の音で先生の声が聞こえなくなることがありましたか？",
    drama: 1.25,
    p: (s) => {
      const d = nearestKm(s, AIRFIELDS);
      return d < 4 ? 0.7 : d < 8 ? 0.4 : 0.05;
    },
    range: [0.05, 0.8],
  },
  {
    id: "train_sound",
    text: "教室まで、電車の走る音が聞こえましたか？",
    drama: 1.2,
    p: (s) => (s.rail < 0 ? 0.03 : s.rail < 120 ? 0.85 : s.rail < 300 ? 0.55 : s.rail < 600 ? 0.2 : 0.05),
    range: [0.03, 0.9],
  },
  {
    id: "shin_view",
    text: "校舎から、新幹線が走るのが見えましたか？",
    drama: 1.25,
    p: (s) => (s.shinRail < 0 ? 0.01 : s.shinRail < 500 ? 0.75 : s.shinRail < 1500 ? 0.4 : 0.12),
    range: [0.01, 0.85],
  },
  {
    id: "tram",
    text: "路面電車の走る街でしたか？",
    drama: 1.25,
    p: (s) => (s.tram ? 0.93 : ctx.tramMuni.has(s.code) ? 0.6 : 0.02),
    range: [0.02, 0.95],
  },
  { id: "subway", text: "地下鉄で通学する生徒がいましたか？", drama: 1.0, p: (s) => bool(s.subway, 0.9, 0.04) },
  {
    id: "mono",
    text: "モノレールや新交通システムが、近くを走っていましたか？",
    drama: 1.1,
    p: (s) => bool(s.mono, 0.85, 0.02),
    range: [0.02, 0.9],
  },
  {
    id: "es",
    text: "すぐ隣に小学校があって、チャイムや運動会の音が聞こえてきましたか？",
    drama: 1.1,
    p: (s) => bool(s.es, 0.75, 0.08),
  },
  {
    id: "island",
    text: "橋か船でしか渡れない、島にある学校でしたか？",
    drama: 1.3,
    p: (s) => (s.island ? 0.9 : s.pref === 47 ? 0.5 : 0.01),
    range: [0.01, 0.92],
  },
  {
    id: "cape",
    text: "岬や半島の先のように、三方を海に囲まれた土地でしたか？",
    drama: 1.15,
    p: (s) => (s.seaSec >= 6 ? 0.8 : s.seaSec === 5 ? 0.5 : s.seaSec === 4 ? 0.2 : 0.03),
    range: [0.03, 0.85],
  },
  {
    id: "japan_sea",
    text: "冬に雷が鳴ると、「そろそろ雪が来るな」と思う土地でしたか？",
    drama: 1.1,
    p: (s) => {
      if ([5, 6, 15, 16, 17, 18, 31, 32].includes(s.pref)) return 0.93;
      if (s.pref === 1) return s.lon < 141.9 && s.lat > 42.7 ? 0.6 : 0.1;
      if (s.pref === 2) return s.lon < 140.9 ? 0.85 : 0.1;
      if (s.pref === 7) return s.lon < 140.0 ? 0.6 : 0.03;
      if (s.pref === 26) return s.lat > 35.35 ? 0.9 : 0.05;
      if (s.pref === 28) return s.lat > 35.25 ? 0.9 : 0.03;
      if (s.pref === 25) return s.lat > 35.35 ? 0.5 : 0.1;
      if (s.pref === 35) return s.lat > 34.3 ? 0.6 : 0.1;
      if (s.pref === 20) return s.lat > 36.6 ? 0.5 : 0.05;
      if (s.pref === 21) return s.lat > 35.9 ? 0.4 : 0.03;
      if ([40, 41, 42].includes(s.pref)) return 0.3;
      return 0.02;
    },
    range: [0.02, 0.95],
  },
  {
    id: "ski",
    text: "体育の授業や学校行事で、スキーやスケートをしましたか？",
    drama: 1.15,
    p: (s) =>
      s.pref === 7
        ? s.lon < 140.3
          ? 0.6
          : 0.15
        : s.pref === 21
          ? s.lat > 35.9
            ? 0.6
            : 0.05
          : byPref({ 1: 0.9, 2: 0.75, 3: 0.6, 5: 0.8, 6: 0.8, 15: 0.7, 20: 0.75, 16: 0.5, 17: 0.3, 18: 0.4, 10: 0.2, 31: 0.3 }, 0.03)(s),
    range: [0.03, 0.92],
  },
  {
    id: "typhoon",
    text: "台風で休校になることが、毎年のようにありましたか？",
    drama: 1.1,
    p: byPref(
      {
        47: 0.9,
        46: 0.7,
        45: 0.55,
        39: 0.55,
        30: 0.4,
        40: 0.35,
        41: 0.35,
        42: 0.35,
        43: 0.35,
        44: 0.35,
        36: 0.3,
        37: 0.3,
        38: 0.3,
        24: 0.25,
      },
      0.06,
    ),
    range: [0.05, 0.92],
  },

  // ---- ことば・学校文化（地域のあたりをつける、遠回しな質問） ----
  {
    id: "asakagai",
    text: "朝のホームルームの前に、「朝課外」（0時間目）がありましたか？",
    drama: 1.3,
    p: byPref({ ...range(40, 46, 0.7), 47: 0.3, 35: 0.15 }, 0.03),
    range: [0.03, 0.8],
  },
  {
    id: "d_bshi",
    text: "模造紙のことを、「B紙」と呼んでいましたか？",
    drama: 1.3,
    p: byPref({ 23: 0.8, 21: 0.75, 24: 0.2 }, 0.01),
    range: [0.01, 0.85],
  },
  { id: "d_taiyo", text: "模造紙のことを、「大洋紙」と呼んでいましたか？", drama: 1.3, p: byPref({ 15: 0.75 }, 0.01), range: [0.01, 0.85] },
  {
    id: "d_koyo",
    text: "模造紙のことを、「広用紙」と呼んでいましたか？",
    drama: 1.3,
    p: byPref({ ...range(40, 46, 0.25), 43: 0.8 }, 0.01),
    range: [0.01, 0.85],
  },
  {
    id: "d_torinoko",
    text: "模造紙のことを、「鳥の子用紙」と呼んでいましたか？",
    drama: 1.3,
    p: byPref({ 37: 0.75, 38: 0.7 }, 0.01),
    range: [0.01, 0.85],
  },
  { id: "d_ganpi", text: "模造紙のことを、「ガンピ」と呼んでいましたか？", drama: 1.3, p: byPref({ 16: 0.75 }, 0.01), range: [0.01, 0.85] },
  {
    id: "d_hoka",
    text: "授業の合間の休み時間を、「放課」と呼んでいましたか？",
    drama: 1.3,
    p: byPref({ 23: 0.85, 21: 0.15 }, 0.01),
    range: [0.01, 0.9],
  },
  {
    id: "d_tsuru",
    text: "掃除のとき、机を運ぶことを「机をつる」と言いましたか？",
    drama: 1.3,
    p: byPref({ 23: 0.85, 21: 0.8, 24: 0.6 }, 0.01),
    range: [0.01, 0.9],
  },
  { id: "d_jasu", text: "ジャージのことを、「ジャス」と呼んでいましたか？", drama: 1.3, p: byPref({ 4: 0.75 }, 0.01), range: [0.01, 0.85] },
  {
    id: "d_rafuru",
    text: "黒板消しのことを、「ラーフル」と呼んでいましたか？",
    drama: 1.3,
    p: byPref({ 46: 0.85, 45: 0.7, 38: 0.3 }, 0.01),
    range: [0.01, 0.9],
  },
  {
    id: "d_sankaku",
    text: "体育座りのことを、「三角座り」と呼んでいましたか？",
    drama: 1.25,
    p: byPref({ ...range(25, 30, 0.75), 24: 0.3, 36: 0.4, 33: 0.2 }, 0.05),
    range: [0.04, 0.85],
  },

  // ---- 学校そのもの ----
  { id: "private", text: "私立の高校でしたか？", drama: 0.8, p: (s) => bool(s.admin === 4), range: HARD, minAsked: 6 },
  {
    id: "municipal",
    text: "市立（区立・町立）の高校でしたか？",
    drama: 0.7,
    p: (s) => bool(s.admin === 3, 0.95, 0.03),
    range: HARD,
    minAsked: 8,
  },
  {
    id: "affil",
    text: "大学の附属校・系列校でしたか？",
    drama: 0.9,
    p: (s) => (/大学|附属|付属/.test(s.base) ? 0.93 : s.admin === 4 ? 0.1 : 0.02),
    range: HARD,
  },

  // ---- 校風・しくみ（Wikipedia の基本情報・カテゴリ由来。記事のない学校は全体の平均で埋める） ----
  {
    id: "rel_any",
    text: "授業や行事に、宗教の時間（礼拝・聖書・仏教など）がありましたか？",
    drama: 1.3,
    p: (s) => (s.rel > 0 ? 0.93 : s.admin !== 4 ? 0.01 : mentions(s, "chapel") ? 0.5 : s.wiki ? 0.08 : 0.2),
    range: [0.01, 0.95],
  },
  {
    id: "rel_chr",
    text: "チャペルや礼拝のある、キリスト教系の学校でしたか？",
    drama: 1.3,
    p: (s) => (s.rel === 1 ? 0.93 : s.rel > 1 || s.admin !== 4 ? 0.01 : mentions(s, "chapel") ? 0.45 : s.wiki ? 0.05 : 0.12),
    range: [0.01, 0.95],
  },
  {
    id: "rel_bud",
    text: "仏教系の学校でしたか？",
    drama: 1.25,
    p: (s) => (s.rel === 2 ? 0.93 : s.rel > 0 || s.admin !== 4 ? 0.01 : s.wiki ? 0.04 : 0.08),
    range: [0.01, 0.95],
  },
  {
    id: "betsugaku",
    text: "文化祭は、他校の異性と出会える貴重な機会でしたか？",
    drama: 1.3,
    p: (s) => (s.gender >= 2 ? 0.85 : s.gender === 1 ? 0.1 : /女子/.test(s.base) ? 0.85 : NaN),
    range: [0.05, 0.9],
  },
  {
    id: "skirt",
    text: "校内で、スカート姿の生徒を見かけることはありましたか？",
    drama: 1.2,
    p: (s) => (s.gender === 2 ? 0.04 : s.gender ? 0.95 : /女子/.test(s.base) ? 0.95 : NaN),
    range: [0.03, 0.97],
  },
  {
    id: "night",
    text: "夕方になると、定時制の生徒が登校してくる学校でしたか？",
    drama: 1.25,
    p: (s) => (s.course ? (s.course & 2 ? 0.85 : 0.04) : NaN),
    range: [0.03, 0.9],
  },
  {
    id: "tsushin",
    text: "通信制の課程がある学校でしたか？",
    drama: 1.1,
    p: (s) => (s.course ? (s.course & 4 ? 0.9 : 0.03) : /通信/.test(s.name) ? 0.9 : NaN),
    range: [0.02, 0.93],
  },
  {
    id: "unit",
    text: "単位制で、時間割を自分で組み立てる学校でしたか？",
    drama: 1.1,
    p: (s) => (s.unit ? (s.unit === 2 ? 0.8 : 0.05) : NaN),
    range: [0.04, 0.85],
  },
  {
    id: "dept",
    text: "普通科のほかに、専門の学科（工業・商業・農業・理数・国際など）がありましたか？",
    drama: 1.0,
    p: (s) =>
      s.dept
        ? s.dept & 2
          ? 0.9
          : 0.06
        : /工業|商業|農業|水産|農林|工科|商科|実業|農芸|園芸|海洋|工芸|産業|技術|総合/.test(s.base)
          ? 0.9
          : NaN,
  },
  {
    id: "no_futsu",
    text: "普通科のない、専門高校でしたか？",
    drama: 1.0,
    p: (s) =>
      s.dept ? (s.dept & 1 ? 0.04 : 0.9) : /工業|商業|農業|水産|農林|工科|商科|実業|農芸|園芸|海洋|工芸/.test(s.base) ? 0.85 : NaN,
  },
  {
    id: "term2",
    text: "2学期制（前期・後期）でしたか？",
    drama: 1.0,
    p: (s) => (s.term ? (s.term === 2 ? 0.85 : 0.08) : NaN),
  },
  {
    id: "old",
    text: "創立から100年を超える、歴史の長い学校でしたか？",
    drama: 0.55,
    minAsked: 12,
    p: (s) => (s.founded ? (s.founded <= 1926 ? 0.92 : s.founded <= 1936 ? 0.5 : 0.05) : NaN),
  },
  {
    id: "new",
    text: "平成になってから開校した、新しい学校でしたか？",
    drama: 1.05,
    p: (s) => (s.founded ? (s.founded >= 1989 ? 0.85 : s.founded >= 1975 ? 0.15 : 0.04) : NaN),
  },
  {
    id: "koshien",
    text: "野球部が、甲子園に出たことがありますか？",
    drama: 1.25,
    p: (s) => (s.sports & 1 ? 0.78 : s.wiki ? 0.05 : 0.1),
  },
  {
    id: "hanazono",
    text: "ラグビー部が、花園に出たことがありますか？",
    drama: 1.15,
    p: (s) => (s.sports & 2 ? 0.75 : s.wiki ? 0.03 : 0.05),
    range: [0.03, 0.92],
  },
  {
    id: "soccer",
    text: "サッカー部が、冬の全国選手権に出たことがありますか？",
    drama: 1.15,
    p: (s) => (s.sports & 4 ? 0.75 : s.wiki ? 0.04 : 0.07),
    range: [0.03, 0.92],
  },
  {
    id: "ssh",
    text: "スーパーサイエンスハイスクール（SSH）の指定校でしたか？",
    drama: 1.0,
    p: (s) => (s.sports & 8 ? 0.85 : s.wiki ? 0.04 : 0.06),
    range: [0.03, 0.9],
  },
  {
    id: "alumni",
    text: "卒業生に、名前を聞けば誰でもわかるような有名人がいますか？",
    drama: 0.6,
    minAsked: 15,
    p: (s) => (s.alum >= 30 ? 0.9 : s.alum >= 10 ? 0.7 : s.alum >= 3 ? 0.45 : 0.15),
    range: [0.1, 0.92],
  },

  // ---- 学校生活（Wikipedia 本文に記述があるかどうか。書かれていない＝無い、ではないので弱めの手がかり） ----
  { id: "bus", text: "スクールバスが走っていましたか？", drama: 1.3, p: said("bus", 0.85, 0.2, 0.12, (s) => (s.admin === 4 ? 0.4 : 0.1)) },
  { id: "cafe", text: "校内に食堂（学食）がありましたか？", drama: 1.3, p: said("cafe", 0.9, 0.4, 0.3), range: [0.1, 0.92] },
  { id: "dorm", text: "寮がありましたか？", drama: 1.25, p: said("dorm", 0.85, 0.1, 0.06) },
  { id: "shifuku", text: "制服がなく、私服で通えましたか？", drama: 1.25, p: said("shifuku", 0.6, 0.05, 0.03), range: [0.03, 0.8] },
  { id: "sailor", text: "女子の制服は、セーラー服でしたか？", drama: 1.15, p: said("sailor", 0.8, 0.3, 0.25), range: [0.1, 0.85] },
  { id: "gakuran", text: "男子の制服は、学ラン（詰襟）でしたか？", drama: 1.15, p: said("gakuran", 0.8, 0.35, 0.3), range: [0.1, 0.85] },
  {
    id: "kyusei",
    text: "前身は、戦前の旧制中学でしたか？",
    drama: 1.15,
    p: (s) => (s.founded > 1948 ? 0.03 : said("kyusei", 0.7, 0.12, 0.06)(s)),
  },
  {
    id: "jogakko",
    text: "前身は、戦前の高等女学校でしたか？",
    drama: 1.15,
    p: (s) => (s.founded > 1948 ? 0.03 : said("jogakko", 0.65, 0.1, 0.05)(s)),
  },
  {
    id: "hanko",
    text: "ルーツをたどると、江戸時代の藩校に行き着きますか？",
    drama: 1.2,
    p: said("hanko", 0.75, 0.03, 0.02),
    range: [0.02, 0.85],
  },
  {
    id: "castle",
    text: "お城や城跡の、すぐそばにある学校でしたか？",
    drama: 1.2,
    p: (s) => (s.castleNear ? 0.85 : mentions(s, "castle") ? 0.4 : 0.03),
    range: [0.03, 0.88],
  },
  {
    id: "merge",
    text: "いくつかの学校が統合・再編されてできた学校でしたか？",
    drama: 1.0,
    p: said("merge", 0.5, 0.15, 0.1),
    range: [0.08, 0.7],
  },
  {
    id: "shingaku",
    text: "いわゆる進学校（あるいは「自称進学校」）でしたか？",
    drama: 1.25,
    p: (s) =>
      !s.wiki ? NaN : mentions(s, "shingaku") ? 0.85 : mentions(s, "saturday") || mentions(s, "tokushin") ? 0.5 : s.wlen >= 8 ? 0.2 : 0.3,
    range: [0.1, 0.9],
  },
  { id: "overseas", text: "修学旅行の行き先は、海外でしたか？", drama: 1.2, p: said("overseas", 0.6, 0.2, 0.12), range: [0.08, 0.88] },
  {
    id: "ensoku",
    text: "何十キロも歩く（走る）ような、名物の伝統行事がありましたか？",
    drama: 1.25,
    p: said("ensoku", 0.75, 0.2, 0.12),
    range: [0.08, 0.85],
  },
  { id: "ouendan", text: "応援団が活躍する学校でしたか？", drama: 1.1, p: said("ouendan", 0.7, 0.25, 0.18), range: [0.1, 0.8] },
];

// ---- さらに具体的な質問（Wikipedia 本文・基本情報欄・出身者一覧の記述から） ----
// [キーワード, 質問文, ドキドキ度, 記述あり, 記述なし, 記事が長いのに記述なし]
const SAID: [string, string, number, number, number, number][] = [
  ["all_dorm", "全寮制の学校でしたか？", 1.3, 0.9, 0.01, 0.01],
  ["moped", "原付やバイクでの通学が、認められていましたか？", 1.3, 0.75, 0.08, 0.05],
  ["kyushoku", "高校なのに、給食がありましたか？", 1.25, 0.7, 0.03, 0.02],
  ["no_chime", "チャイムが鳴らない学校でしたか？", 1.25, 0.8, 0.04, 0.03],
  ["odd_period", "授業は1コマ50分ではなく、65分や90分などの変則でしたか？", 1.25, 0.75, 0.1, 0.07],
  ["saturday", "土曜日にも、授業や講習がありましたか？", 1.1, 0.8, 0.3, 0.25],
  ["tokushin", "「特進」など、成績や進路で分かれたコースがありましたか？", 1.15, 0.85, 0.15, 0.1],
  ["sports_course", "スポーツ専門のコースや、体育科がありましたか？", 1.15, 0.85, 0.05, 0.03],
  ["kofun", "敷地の中や隣に、古墳や遺跡がありましたか？", 1.25, 0.5, 0.04, 0.03],
  ["bunkazai", "校舎や講堂・門などが、文化財に指定されていましたか？", 1.3, 0.7, 0.03, 0.02],
  ["air_raid", "戦争中の空襲や火事で、校舎が焼けた歴史がありますか？", 1.1, 0.65, 0.12, 0.08],
  ["coed_later", "もともとは男子校か女子校で、のちに共学になった学校でしたか？", 1.2, 0.75, 0.1, 0.06],
  ["bunbu", "「文武両道」が、合言葉のように語られていましたか？", 1.2, 0.8, 0.3, 0.25],
  ["shitsujitsu", "校訓や校風に、「質実剛健」が掲げられていましたか？", 1.25, 0.8, 0.08, 0.05],
  ["jiyu", "「自由な校風」で知られる学校でしたか？", 1.2, 0.8, 0.15, 0.1],
  ["ouen_practice", "新入生は、応援団から応援歌の猛練習をさせられましたか？", 1.3, 0.85, 0.1, 0.07],
  ["famous_song", "校歌を作ったのは、教科書に載るような有名な詩人や作曲家でしたか？", 1.25, 0.8, 0.15, 0.1],
  ["trip_okinawa", "修学旅行で、沖縄に行きましたか？", 1.2, 0.55, 0.2, 0.15],
  ["trip_hokkaido", "修学旅行で、北海道に行きましたか？", 1.2, 0.55, 0.1, 0.08],
  ["trip_kansai", "修学旅行で、京都・奈良など関西に行きましたか？", 1.2, 0.55, 0.2, 0.15],
  ["trip_tokyo", "修学旅行で、東京やディズニーなど関東に行きましたか？", 1.2, 0.55, 0.12, 0.1],
  ["trip_kyushu", "修学旅行で、長崎や広島に行きましたか？", 1.2, 0.55, 0.12, 0.1],
  ["enei", "海で泳ぐ、遠泳や臨海学校の行事がありましたか？", 1.3, 0.8, 0.04, 0.03],
  ["tozan", "全校で山に登る、学校登山の行事がありましたか？", 1.3, 0.8, 0.05, 0.04],
  ["ski_trip", "スキー教室やスキー合宿がありましたか？", 1.15, 0.8, 0.12, 0.1],
  ["fire", "文化祭の締めくくりに、後夜祭やファイヤーストームがありましたか？", 1.15, 0.8, 0.3, 0.25],
  ["kibasen", "体育祭で、騎馬戦や棒倒しがありましたか？", 1.15, 0.8, 0.25, 0.2],
  ["kaso", "体育祭や文化祭で、仮装が名物でしたか？", 1.2, 0.75, 0.12, 0.1],
  ["chorus", "合唱コンクール（合唱祭）がありましたか？", 1.1, 0.85, 0.3, 0.25],
  ["observatory", "校舎に、天文台や天体ドームがありましたか？", 1.3, 0.85, 0.04, 0.03],
  ["indoor_pool", "屋内プール（温水プール）がありましたか？", 1.2, 0.85, 0.05, 0.04],
  ["turf", "グラウンドは、人工芝でしたか？", 1.2, 0.85, 0.08, 0.06],
  ["night_light", "グラウンドに、ナイター照明がありましたか？", 1.1, 0.8, 0.2, 0.15],
  ["clock", "校舎に、時計台（時計塔）がありましたか？", 1.25, 0.8, 0.08, 0.06],
  ["tea", "校内に、茶室がありましたか？", 1.2, 0.8, 0.1, 0.08],
  ["kyudo", "弓道場（弓道部）がありましたか？", 1.15, 0.85, 0.25, 0.2],
  ["tree", "校内に、シンボルになっている大きな木や並木がありましたか？", 1.15, 0.8, 0.3, 0.25],
  ["farm", "学校に、農場や牛舎・演習林がありましたか？", 1.3, 0.9, 0.03, 0.02],
  ["ship", "学校が、実習船を持っていましたか？", 1.3, 0.9, 0.01, 0.01],
  ["ekiden", "陸上部が、都大路（全国高校駅伝）を走ったことがありますか？", 1.25, 0.72, 0.04, 0.03],
  ["volley", "バレー部が、春高バレーに出たことがありますか？", 1.2, 0.72, 0.05, 0.04],
  ["basket", "バスケ部が、ウインターカップに出たことがありますか？", 1.2, 0.72, 0.05, 0.04],
  ["suiso", "吹奏楽部が、全国大会に出るような強豪でしたか？", 1.25, 0.8, 0.06, 0.05],
  ["quiz", "「高校生クイズ」の全国大会に出たことがありますか？", 1.25, 0.75, 0.03, 0.02],
  ["robocon", "ロボコンなど、ものづくりの大会で知られていましたか？", 1.15, 0.75, 0.03, 0.02],
  ["haiku", "俳句甲子園や書道パフォーマンス甲子園など、文化系の「甲子園」に出たことがありますか？", 1.25, 0.8, 0.03, 0.02],
  ["koshien_win", "甲子園で、優勝したことがありますか？", 1.3, 0.6, 0.01, 0.01],
];
for (const [k, text, drama, hi, lo, loLong] of SAID)
  DEFS.push({ id: `w_${k}`, text, drama, p: said(k, hi, lo, loLong), range: [Math.min(lo, loLong), Math.max(hi, 0.9)] });

// 部活: 記事に部活動の節があるのに名前が出てこなければ「無い」寄り
const CLUBS: [string, string][] = [
  ["c_boat", "ボート部（カヌー部）"],
  ["c_yacht", "ヨット部"],
  ["c_horse", "馬術部"],
  ["c_ski", "スキー部"],
  ["c_skate", "スケート部やアイスホッケー部"],
  ["c_sangaku", "山岳部（ワンダーフォーゲル部）"],
  ["c_sumo", "相撲部"],
  ["c_naginata", "なぎなた部"],
  ["c_archery", "アーチェリー部"],
  ["c_fencing", "フェンシング部"],
  ["c_rifle", "ライフル射撃部"],
  ["c_bike", "自転車競技部"],
  ["c_weight", "ウエイトリフティング部"],
  ["c_wrestle", "レスリング部"],
  ["c_boxing", "ボクシング部"],
  ["c_hockey", "ホッケー部"],
  ["c_waterpolo", "水球部"],
  ["c_amefuto", "アメフト部"],
  ["c_lacrosse", "ラクロス部"],
  ["c_golf", "ゴルフ部"],
  ["c_karuta", "かるた部（百人一首部）"],
  ["c_tetsu", "鉄道研究部"],
  ["c_tenmon", "天文部（地学部）"],
  ["c_mandolin", "マンドリン部"],
  ["c_kyodo", "和太鼓や郷土芸能の部"],
  ["c_cheer", "チアリーディング部やバトン部"],
  ["c_shinbun", "新聞部"],
];
for (const [k, name] of CLUBS)
  DEFS.push({
    id: `w_${k}`,
    text: `${name}がありましたか？`,
    drama: 1.2,
    p: (s) => (!s.wiki ? NaN : mentions(s, k) ? 0.85 : mentions(s, "club_any") ? 0.07 : 0.2),
    range: [0.05, 0.9],
  });

// 学科: 基本情報欄に学科が書かれている学校だけ判定
const DEPTS: [string, string][] = [
  ["d_risu", "理数科"],
  ["d_kokusai", "国際系・英語系の学科"],
  ["d_art", "音楽や美術など、芸術系の学科"],
  ["d_kango", "看護の学科"],
  ["d_fukushi", "福祉の学科"],
  ["d_katei", "家政・食物・調理などの学科"],
  ["d_joho", "情報系の学科"],
  ["d_sogo", "総合学科"],
  ["d_nogyo", "農業系の学科"],
  ["d_suisan", "水産・海洋系の学科"],
  ["d_kogyo", "工業系の学科"],
  ["d_shogyo", "商業系の学科"],
];
for (const [k, name] of DEPTS)
  DEFS.push({
    id: `w_${k}`,
    text: `${name}がありましたか？`,
    drama: 1.1,
    p: (s) => (s.dept ? (mentions(s, k) ? 0.9 : 0.03) : NaN),
    range: [0.03, 0.92],
  });

// 卒業生: 出身者一覧が長いのに該当なしなら「いない」寄り
const ALUMNI: [string, string][] = [
  ["a_yakyu", "プロ野球選手"],
  ["a_soccer", "Jリーガー"],
  ["a_olympic", "オリンピック選手"],
  ["a_rikishi", "大相撲の力士"],
  ["a_seiji", "国会議員や知事・市長になった人"],
  ["a_pm", "総理大臣になった人"],
  ["a_nobel", "ノーベル賞を受賞した人"],
  ["a_ana", "アナウンサー"],
  ["a_geino", "俳優・歌手・タレントなどの芸能人"],
  ["a_owarai", "お笑い芸人"],
  ["a_sakka", "作家や漫画家"],
];
for (const [k, name] of ALUMNI)
  DEFS.push({
    id: `w_${k}`,
    text: `卒業生に、${name}がいますか？`,
    drama: 0.6,
    minAsked: 15,
    p: (s) => (!s.wiki ? NaN : mentions(s, k) ? 0.8 : s.alum >= 10 ? 0.06 : 0.15),
    range: [0.01, 0.88],
  });

DEFS.push(
  {
    id: "intl",
    text: "留学や国際交流に力を入れた、国際派の学校でしたか？",
    drama: 1.1,
    p: (s) => (!s.wiki ? NaN : s.sports & 16 || mentions(s, "d_kokusai") ? 0.8 : 0.12),
  },
  {
    id: "big",
    text: "1学年が8クラス以上ある、大きな学校でしたか？",
    drama: 1.2,
    p: (s) => (s.classes ? (s.classes >= 8 ? 0.85 : 0.08) : s.students ? (s.students >= 900 ? 0.8 : 0.1) : NaN),
  },
  {
    id: "small",
    text: "1学年が3クラス以下の、小さな学校でしたか？",
    drama: 1.2,
    p: (s) => (s.classes ? (s.classes <= 3 ? 0.85 : 0.05) : s.students ? (s.students < 330 ? 0.8 : 0.08) : NaN),
  },
);

const REGIONS: [string, number, number][] = [
  ["東北地方", 2, 7],
  ["関東地方", 8, 14],
  ["中部地方（北陸・甲信越・東海）", 15, 23],
  ["近畿地方", 24, 30],
  ["中国地方", 31, 35],
  ["四国", 36, 39],
  ["九州・沖縄", 40, 47],
];

function sparse(q: Omit<SparseQuestion, "kind" | "members">, schools: School[], test: (s: School) => boolean): SparseQuestion {
  const members: number[] = [];
  schools.forEach((s, i) => test(s) && members.push(i));
  return { ...q, kind: "sparse", members: Int32Array.from(members) };
}

export function buildQuestions(schools: School[], peaks: string[] = []): Question[] {
  const out: Question[] = [];

  ctx = { hsInMuni: new Map(), tramMuni: new Set() };
  for (const s of schools) {
    ctx.hsInMuni.set(s.code, (ctx.hsInMuni.get(s.code) ?? 0) + 1);
    if (s.tram) ctx.tramMuni.add(s.code);
  }

  for (const d of DEFS) {
    const [lo, hi] = d.range ?? [0.05, 0.95];
    const q: DenseQuestion = {
      kind: "dense",
      id: d.id,
      text: d.text,
      drama: d.drama,
      minAsked: d.minAsked,
      p: Float32Array.from(schools, (s) => d.p(s)),
    };
    // データのない学校（NaN）は、データのある学校の平均で埋める＝その質問では動かさない
    let sum = 0,
      n = 0;
    for (const v of q.p)
      if (!Number.isNaN(v)) {
        sum += v;
        n++;
      }
    const mean = n ? sum / n : 0.5;
    for (let i = 0; i < q.p.length; i++) q.p[i] = clamp(Number.isNaN(q.p[i]) ? mean : q.p[i], lo, hi);
    out.push(q);
  }

  // 地方: 序盤から直球で聞くと興ざめなので、少し質問が進んでから
  for (const [label, a, b] of REGIONS)
    out.push(
      sparse(
        { id: `region_${a}`, text: `${label}にありましたか？`, drama: 0.45, hi: 0.98, lo: 0.01, minAsked: 10 },
        schools,
        (s) => s.pref >= a && s.pref <= b,
      ),
    );

  // 名峰: 「学校から◯◯が見えましたか」
  // 木立ちや建物、立地で見え方が大きく変わるので、確率は控えめ・優先度も低め。
  peaks.forEach((name, pi) => {
    const p = new Float32Array(schools.length);
    let n = 0;
    schools.forEach((s, i) => {
      const k = s.pk?.indexOf(pi) ?? -1;
      if (k < 0) {
        p[i] = 0.03;
        return;
      }
      const deg = (s.pka?.[k] ?? 50) / 100;
      const km = s.pkd?.[k] ?? 50;
      // 稜線の上にどれだけ山が出ているか
      let v = deg >= 2 ? 0.85 : deg >= 1 ? 0.7 : deg >= 0.5 ? 0.55 : deg >= 0.2 ? 0.4 : deg >= 0 ? 0.25 : 0.1;
      // 遠いと霞んで見えない日が多い
      if (deg >= 0) v *= km >= 160 ? 0.6 : km >= 120 ? 0.8 : 1;
      // 市街地は建物に遮られやすい
      if (deg >= 0) v *= s.dens >= 40 ? 0.6 : s.dens >= 20 ? 0.75 : 1;
      p[i] = Math.max(0.08, v);
      if (deg >= 0) n++;
    });
    if (n >= 3)
      out.push({ kind: "dense", id: `peak_${pi}`, text: `晴れた日、学校から「${name}」が見えましたか？`, drama: 0.4, minAsked: 8, p });
  });

  // 近くを流れる川の名前
  const rivers = new Map<string, number>();
  for (const s of schools) if (s.river) rivers.set(s.river, (rivers.get(s.river) ?? 0) + 1);
  for (const [river, cnt] of rivers)
    if (cnt >= 2)
      out.push(
        sparse(
          {
            id: `river_${river}`,
            text: `学校の近くを流れていたのは、「${river}」でしたか？`,
            drama: 1.0,
            hi: 0.8,
            lo: 0.01,
            maxEff: 80,
            minAsked: 10,
          },
          schools,
          (s) => s.river === river,
        ),
      );

  // 最後の手段: 校名の漢字（興ざめなので、ほぼ絞り切ってから）
  const kanji = new Map<string, number>();
  for (const s of schools) for (const ch of new Set(s.base)) if (/\p{Script=Han}/u.test(ch)) kanji.set(ch, (kanji.get(ch) ?? 0) + 1);
  for (const ch of kanji.keys())
    out.push(
      sparse(
        {
          id: `kanji_${ch}`,
          text: `校名に、「${ch}」という字が入っていましたか？`,
          drama: 0.35,
          hi: 0.97,
          lo: 0.01,
          maxEff: 8,
          minAsked: 28,
        },
        schools,
        (s) => s.base.includes(ch),
      ),
    );

  // 最後の手段: 最寄り駅（ほぼ絞り切ってから）
  const stations = new Set(schools.filter((s) => s.st && s.stDist >= 0 && s.stDist < 2500).map((s) => s.st));
  for (const st of stations)
    out.push(
      sparse(
        { id: `st_${st}`, text: `最寄り駅は、「${st}」駅でしたか？`, drama: 0.4, hi: 0.85, lo: 0.02, maxEff: 5, minAsked: 26 },
        schools,
        (s) => s.st === st && s.stDist < 2500,
      ),
    );

  // 最後の手段: 都道府県
  for (let p = 1; p <= 47; p++)
    out.push(
      sparse(
        { id: `pref_${p}`, text: `${PREFS[p]}にありましたか？`, drama: 0.3, hi: 0.99, lo: 0.005, maxEff: 12, minAsked: 22 },
        schools,
        (s) => s.pref === p,
      ),
    );

  return applyRanks(out);
}
