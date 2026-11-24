// 高校ごとの「地形・立地の事実」を公開データから事前計算して public/data/schools.json に書き出す。
// プレイ中はこの JSON だけを使う（LLM も外部 API も呼ばない）。
//
// 入力（data/raw/ に置く。README 参照）:
//   - P29-21.geojson            国土数値情報 学校データ（令和3年度）
//   - N02-22_Station.geojson    国土数値情報 鉄道データ（令和4年度）駅
//   - 標高: 地理院タイル dem_png（自動ダウンロードして data/cache/dem にキャッシュ）
//
// 使い方: node scripts/build-data.mjs

import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const RAW = path.join(ROOT, "data/raw");
const CACHE = path.join(ROOT, "data/cache/dem");
const OUT = path.join(ROOT, "public/data/schools.json");

const Z = 11;
const N = 256 * 2 ** Z;
const VIEW_M = 10000; // 見通し計算の半径
const EARTH_R = 6371000;
const RAYS = 72;

// ---------- 座標 ----------
const toPx = (lon, lat) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return [((lon + 180) / 360) * N, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * N];
};
const mppAt = (lat) => (40075016.686 * Math.cos((lat * Math.PI) / 180)) / N;
const distM = (lon1, lat1, lon2, lat2) => {
  const k = Math.PI / 180;
  const x = (lon2 - lon1) * k * Math.cos(((lat1 + lat2) / 2) * k);
  const y = (lat2 - lat1) * k;
  return Math.sqrt(x * x + y * y) * EARTH_R;
};

// ---------- 入力 ----------
const p29 = JSON.parse(fs.readFileSync(path.join(RAW, "P29-21.geojson"), "utf8")).features.map((f) => ({
  code: f.properties.P29_001,
  type: f.properties.P29_003,
  name: f.properties.P29_004,
  addr: f.properties.P29_005,
  admin: f.properties.P29_006,
  lon: f.geometry.coordinates[0],
  lat: f.geometry.coordinates[1],
}));
const HS_TYPES = new Set([16004, 16003]); // 高等学校・中等教育学校
const schools = p29.filter((s) => HS_TYPES.has(s.type));

const SUBWAY = /^(東京地下鉄|東京都|大阪市高速電気軌道|名古屋市|札幌市|横浜市|京都市|神戸市|福岡市|仙台市)$/;
const stationsRaw = JSON.parse(fs.readFileSync(path.join(RAW, "N02-22_Station.geojson"), "utf8")).features;
// 同じ駅（グループコード）を1点にまとめる
const stGroups = new Map();
for (const f of stationsRaw) {
  const p = f.properties;
  const cs = f.geometry.type === "LineString" ? f.geometry.coordinates : f.geometry.coordinates.flat();
  const lon = cs.reduce((a, c) => a + c[0], 0) / cs.length;
  const lat = cs.reduce((a, c) => a + c[1], 0) / cs.length;
  const key = p.N02_005g || `${p.N02_005}:${p.N02_003}`;
  let g = stGroups.get(key);
  if (!g) stGroups.set(key, (g = { name: p.N02_005, lon: 0, lat: 0, n: 0, jr: false, other: false, shinkansen: false, tram: false, subway: false, mono: false }));
  if (p.N02_001 === "21" && p.N02_004 !== "大阪市高速電気軌道" && !/けいはんな線|豊川線/.test(p.N02_003)) g.tram = true;
  if (SUBWAY.test(p.N02_004) && !/荒川線|上野懸垂線|舎人|南港ポートタウン/.test(p.N02_003)) g.subway = true;
  if (["14", "15", "22", "23", "24", "25"].includes(p.N02_001)) g.mono = true;
  g.lon += lon;
  g.lat += lat;
  g.n++;
  const t = Number(p.N02_002);
  if (t === 1) g.shinkansen = true;
  if (t === 1 || t === 2) g.jr = true;
  else g.other = true;
}
const stations = [...stGroups.values()].map((g) => ({ ...g, lon: g.lon / g.n, lat: g.lat / g.n }));

// ---------- 空間インデックス ----------
const CELL = 0.05;
const makeGrid = (pts) => {
  const grid = new Map();
  for (const p of pts) {
    const k = `${Math.floor(p.lon / CELL)},${Math.floor(p.lat / CELL)}`;
    let a = grid.get(k);
    if (!a) grid.set(k, (a = []));
    a.push(p);
  }
  return (lon, lat, radiusM) => {
    const dLat = radiusM / 111000;
    const dLon = radiusM / (111000 * Math.cos((lat * Math.PI) / 180));
    const out = [];
    for (let i = Math.floor((lon - dLon) / CELL); i <= Math.floor((lon + dLon) / CELL); i++)
      for (let j = Math.floor((lat - dLat) / CELL); j <= Math.floor((lat + dLat) / CELL); j++)
        for (const p of grid.get(`${i},${j}`) ?? []) {
          const d = distM(lon, lat, p.lon, p.lat);
          if (d <= radiusM) out.push({ p, d });
        }
    return out.sort((a, b) => a.d - b.d);
  };
};
const nearStations = makeGrid(stations);
const nearSchools = makeGrid(p29);

// 線路（100mおきの点に分解して近傍検索）
const railPts = [];
for (const f of JSON.parse(fs.readFileSync(path.join(RAW, "N02-22_RailroadSection.geojson"), "utf8")).features) {
  const shin = f.properties.N02_002 === "1";
  const lines = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const cs of lines)
    for (let i = 0; i + 1 < cs.length; i++) {
      const n = Math.max(1, Math.ceil(distM(cs[i][0], cs[i][1], cs[i + 1][0], cs[i + 1][1]) / 100));
      for (let k = 0; k <= n; k++)
        railPts.push({ lon: cs[i][0] + ((cs[i + 1][0] - cs[i][0]) * k) / n, lat: cs[i][1] + ((cs[i + 1][1] - cs[i][1]) * k) / n, shin });
    }
}
const nearRail = makeGrid(railPts);

// 名峰（緯度, 経度, 標高m, 見える可能性を調べる最大距離km）
const PEAKS = [
  ["富士山", 35.3606, 138.7274, 3776, 160], ["羊蹄山", 42.827, 140.811, 1898, 60], ["大雪山", 43.663, 142.854, 2291, 70],
  ["利尻山", 45.179, 141.242, 1721, 60], ["北海道駒ヶ岳", 42.063, 140.677, 1131, 45], ["岩木山", 40.656, 140.303, 1625, 60],
  ["八甲田山", 40.659, 140.877, 1585, 50], ["岩手山", 39.853, 141.001, 2038, 60], ["鳥海山", 39.099, 140.049, 2236, 70],
  ["月山", 38.549, 140.027, 1984, 60], ["蔵王", 38.144, 140.44, 1841, 50], ["磐梯山", 37.601, 140.072, 1816, 50],
  ["筑波山", 36.225, 140.107, 877, 45], ["赤城山", 36.56, 139.193, 1828, 50], ["榛名山", 36.477, 138.878, 1449, 40],
  ["男体山", 36.765, 139.491, 2486, 60], ["浅間山", 36.406, 138.523, 2568, 60], ["妙高山", 36.891, 138.113, 2454, 50],
  ["八ヶ岳", 35.971, 138.37, 2899, 60], ["立山連峰", 36.576, 137.62, 3015, 70], ["白山", 36.155, 136.771, 2702, 70],
  ["御嶽山", 35.893, 137.48, 3067, 70], ["伊吹山", 35.418, 136.406, 1377, 45], ["比叡山", 35.066, 135.834, 848, 25],
  ["六甲山", 34.778, 135.264, 931, 25], ["生駒山", 34.678, 135.679, 642, 20], ["大山", 35.371, 133.546, 1729, 60],
  ["石鎚山", 33.768, 133.115, 1982, 50], ["剣山", 33.854, 134.094, 1955, 40], ["由布岳", 33.282, 131.39, 1583, 35],
  ["阿蘇山", 32.884, 131.104, 1592, 45], ["雲仙岳", 32.761, 130.299, 1483, 45], ["霧島連山", 31.934, 130.862, 1700, 45],
  ["桜島", 31.593, 130.657, 1117, 40], ["開聞岳", 31.18, 130.528, 924, 35],
];

// ---------- 広域の標高（ズーム8, 約500m/px）: 島かどうか・名峰が見えるか ----------
const Z8 = { z: 8, x0: 215, x1: 231, y0: 88, y1: 111 };
const z8W = (Z8.x1 - Z8.x0 + 1) * 256, z8H = (Z8.y1 - Z8.y0 + 1) * 256;
const z8 = new Float32Array(z8W * z8H).fill(NaN);
const z8Path = (x, y) => path.join(CACHE, `8_${x}_${y}.png`);
const decode = (buf) => {
  const { data } = PNG.sync.read(buf);
  const t = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) {
    const x = data[i * 4] * 65536 + data[i * 4 + 1] * 256 + data[i * 4 + 2];
    t[i] = x === 8388608 ? NaN : x < 8388608 ? x * 0.01 : (x - 16777216) * 0.01;
  }
  return t;
};
const toPx8 = (lon, lat) => {
  const n = 256 * 2 ** 8;
  const s = Math.sin((lat * Math.PI) / 180);
  return [((lon + 180) / 360) * n - Z8.x0 * 256, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n - Z8.y0 * 256];
};
const z8At = (x, y) => (x < 0 || y < 0 || x >= z8W || y >= z8H ? NaN : z8[Math.floor(y) * z8W + Math.floor(x)]);
let comp; // 陸地の連結成分ID
const mainland = new Set();
async function loadZ8() {
  fs.mkdirSync(CACHE, { recursive: true });
  const todo = [];
  for (let x = Z8.x0; x <= Z8.x1; x++) for (let y = Z8.y0; y <= Z8.y1; y++) if (!fs.existsSync(z8Path(x, y))) todo.push([x, y]);
  console.log(`z8 tiles to download: ${todo.length}`);
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let t; (t = todo.pop()); ) {
        const res = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/dem_png/8/${t[0]}/${t[1]}.png`);
        if (res.status === 404) fs.writeFileSync(z8Path(...t), "");
        else if (res.ok) fs.writeFileSync(z8Path(...t), Buffer.from(await res.arrayBuffer()));
        else throw new Error(`z8 tile HTTP ${res.status}`);
      }
    }),
  );
  for (let x = Z8.x0; x <= Z8.x1; x++)
    for (let y = Z8.y0; y <= Z8.y1; y++) {
      const buf = fs.readFileSync(z8Path(x, y));
      if (!buf.length) continue;
      const t = decode(buf);
      for (let j = 0; j < 256; j++) z8.set(t.subarray(j * 256, j * 256 + 256), ((y - Z8.y0) * 256 + j) * z8W + (x - Z8.x0) * 256);
    }
  // 陸地の連結成分
  comp = new Int32Array(z8W * z8H);
  let id = 0;
  const stack = [];
  for (let i = 0; i < comp.length; i++) {
    if (comp[i] || Number.isNaN(z8[i])) continue;
    comp[i] = ++id;
    stack.push(i);
    while (stack.length) {
      const c = stack.pop();
      const cx = c % z8W;
      for (const nb of [c - z8W, c + z8W, cx > 0 ? c - 1 : -1, cx < z8W - 1 ? c + 1 : -1])
        if (nb >= 0 && nb < comp.length && !comp[nb] && !Number.isNaN(z8[nb])) { comp[nb] = id; stack.push(nb); }
    }
  }
  // 本土（北海道・本州・四国・九州・沖縄本島）
  for (const [lat, lon] of [[43.2, 142.5], [36.2, 138.3], [33.75, 133.5], [32.6, 131.0], [26.45, 127.85]]) {
    const [x, y] = toPx8(lon, lat);
    mainland.add(comp[Math.floor(y) * z8W + Math.floor(x)]);
  }
}
function wide(s, elev) {
  const [x, y] = toPx8(s.lon, s.lat);
  // 島かどうか: 最寄りの陸地ピクセルが本土につながっているか
  let c = 0;
  for (let k = 0; !c && k <= 3; k++)
    for (let dy = -k; dy <= k && !c; dy++)
      for (let dx = -k; dx <= k && !c; dx++) {
        const xi = Math.floor(x) + dx, yi = Math.floor(y) + dy;
        if (xi >= 0 && yi >= 0 && xi < z8W && yi < z8H) c = comp[yi * z8W + xi];
      }
  const island = c && !mainland.has(c) ? 1 : 0;
  // 名峰への見通し（地球の丸み込み。手前の陸地には建物・木立ち+12mがあるとみなす）
  const mpp = (40075016.686 * Math.cos((s.lat * Math.PI) / 180)) / (256 * 2 ** 8);
  const h0 = elev + 10;
  const R = EARTH_R * (7 / 6);
  // pk: 候補の峰、pka: 稜線の上に出ている山の見かけの高さ（0.01度単位。負なら「惜しくも隠れる」）、pkd: 距離km
  const pk = [], pka = [], pkd = [];
  PEAKS.forEach(([, plat, plon, ph, maxKm], pi) => {
    const D = distM(s.lon, s.lat, plon, plat);
    if (D > maxKm * 1000 || D < 3000) return;
    const [tx, ty] = toPx8(plon, plat);
    const target = (ph - h0 - (D * D) / (2 * R)) / D;
    if (target <= 0) return;
    const steps = Math.ceil(D / mpp);
    let obst = -Infinity;
    for (let k = 1; k < steps; k++) {
      const d = (D * k) / steps;
      if (d > D - 5000) break;
      const v = z8At(x + ((tx - x) * k) / steps, y + ((ty - y) * k) / steps);
      if (Number.isNaN(v)) continue;
      const a = (v + 12 - h0 - (d * d) / (2 * R)) / d;
      if (a > obst) obst = a;
    }
    // 山そのものの見かけの高さを上限に（手前が海や平野だけのとき）
    const deg = (Math.min(target - obst, target) * 180) / Math.PI;
    if (deg < -0.2) return;
    pk.push(pi);
    pka.push(Math.round(deg * 100));
    pkd.push(Math.round(D / 1000));
  });
  return { island, pk, pka, pkd };
}

// ---------- 標高タイル ----------
const tilePath = (tx, ty) => path.join(CACHE, `${Z}_${tx}_${ty}.png`);
async function downloadTiles() {
  fs.mkdirSync(CACHE, { recursive: true });
  const need = new Set();
  for (const s of schools) {
    const [px, py] = toPx(s.lon, s.lat);
    const r = Math.ceil(VIEW_M / mppAt(s.lat)) + 2;
    for (let tx = Math.floor((px - r) / 256); tx <= Math.floor((px + r) / 256); tx++)
      for (let ty = Math.floor((py - r) / 256); ty <= Math.floor((py + r) / 256); ty++) need.add(`${tx},${ty}`);
  }
  const todo = [...need].map((k) => k.split(",").map(Number)).filter(([tx, ty]) => !fs.existsSync(tilePath(tx, ty)));
  console.log(`tiles: need ${need.size}, to download ${todo.length}`);
  let done = 0;
  const worker = async () => {
    for (;;) {
      const t = todo.pop();
      if (!t) return;
      const [tx, ty] = t;
      const url = `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${Z}/${tx}/${ty}.png`;
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(url);
          if (res.status === 404) fs.writeFileSync(tilePath(tx, ty), ""); // 全面が海
          else if (res.ok) fs.writeFileSync(tilePath(tx, ty), Buffer.from(await res.arrayBuffer()));
          else throw new Error(`HTTP ${res.status}`);
          break;
        } catch (e) {
          if (attempt >= 4) throw new Error(`${url}: ${e.message}`);
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
      if (++done % 200 === 0) console.log(`  downloaded ${done}`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

const tileCache = new Map();
function loadTile(tx, ty) {
  const k = tx * 4096 + ty;
  let t = tileCache.get(k);
  if (t !== undefined) return t;
  const buf = fs.readFileSync(tilePath(tx, ty));
  if (buf.length === 0) t = null;
  else {
    const { data } = PNG.sync.read(buf);
    t = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) {
      const x = data[i * 4] * 65536 + data[i * 4 + 1] * 256 + data[i * 4 + 2];
      t[i] = x === 8388608 ? NaN : x < 8388608 ? x * 0.01 : (x - 16777216) * 0.01;
    }
  }
  if (tileCache.size > 300) tileCache.delete(tileCache.keys().next().value);
  tileCache.set(k, t);
  return t;
}

/** 学校を中心とした標高ウィンドウ（NaN = 海/データなし） */
function windowAround(cx, cy, r) {
  const W = 2 * r + 1;
  const a = new Float32Array(W * W).fill(NaN);
  const x0 = cx - r;
  const y0 = cy - r;
  for (let ty = y0 >> 8; ty <= (y0 + W - 1) >> 8; ty++)
    for (let tx = x0 >> 8; tx <= (x0 + W - 1) >> 8; tx++) {
      const t = loadTile(tx, ty);
      if (!t) continue;
      const xs = Math.max(x0, tx * 256), xe = Math.min(x0 + W, tx * 256 + 256);
      const ys = Math.max(y0, ty * 256), ye = Math.min(y0 + W, ty * 256 + 256);
      for (let y = ys; y < ye; y++)
        for (let x = xs; x < xe; x++) a[(y - y0) * W + (x - x0)] = t[(y - ty * 256) * 256 + (x - tx * 256)];
    }
  return { a, W };
}

// ---------- 学校ごとの計算 ----------
function analyze(s) {
  const [fx, fy] = toPx(s.lon, s.lat);
  const cx = Math.floor(fx), cy = Math.floor(fy);
  const mpp = mppAt(s.lat);
  const r = Math.ceil(VIEW_M / mpp);
  const { a, W } = windowAround(cx, cy, r);
  const at = (dx, dy) => a[(dy + r) * W + (dx + r)];

  // 学校の標高（水際でデータなしなら近傍から拾う）
  let elev = at(0, 0);
  for (let k = 1; Number.isNaN(elev) && k <= 4; k++)
    for (let dy = -k; dy <= k && Number.isNaN(elev); dy++)
      for (let dx = -k; dx <= k; dx++) if (!Number.isNaN(at(dx, dy))) { elev = at(dx, dy); break; }
  if (Number.isNaN(elev)) elev = 0;

  // 周囲700mとの高低差
  const rr = Math.round(700 / mpp);
  const near = [];
  for (let dy = -rr; dy <= rr; dy++)
    for (let dx = -rr; dx <= rr; dx++) {
      if (dx * dx + dy * dy > rr * rr) continue;
      const v = at(dx, dy);
      near.push(Number.isNaN(v) ? 0 : v);
    }
  near.sort((p, q) => p - q);
  const rise = elev - near[Math.floor(near.length * 0.15)];
  const drop = near[Math.floor(near.length * 0.85)] - elev;

  // 最寄りの海（孤立したデータ欠損は無視）
  let coast = Infinity, coastDir = -1;
  for (let dy = -r + 1; dy < r; dy++)
    for (let dx = -r + 1; dx < r; dx++) {
      if (!Number.isNaN(at(dx, dy))) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 >= coast) continue;
      let n = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (Number.isNaN(at(dx + i, dy + j))) n++;
      if (n < 6) continue;
      coast = d2;
      coastDir = Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) / 45) % 8; // 0=北,2=東,4=南,6=西
    }
  const coastM = coast === Infinity ? -1 : Math.round(Math.sqrt(coast) * mpp);
  // 8km以内に海がある方角の数（8方位）。多いほど岬・半島・小さな島
  let secMask = 0;
  const r8 = Math.min(r - 1, Math.round(8000 / mpp));
  for (let dy = -r8; dy <= r8; dy += 2)
    for (let dx = -r8; dx <= r8; dx += 2) {
      if (dx * dx + dy * dy > r8 * r8 || !Number.isNaN(at(dx, dy)) || !Number.isNaN(at(dx + 1, dy)) || !Number.isNaN(at(dx, dy + 1))) continue;
      secMask |= 1 << (Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) / 45) % 8);
    }
  let seaSec = 0;
  for (let i = 0; i < 8; i++) if (secMask & (1 << i)) seaSec++;

  // 見通し: 3階の窓(+10m)から。陸地には建物・木立ち(+12m)があるとみなす
  const h0 = elev + 10;
  let seaVis = 0, seaMask = 0, mt = 0;
  for (let i = 0; i < RAYS; i++) {
    const th = (i / RAYS) * 2 * Math.PI;
    const ux = Math.sin(th), uy = -Math.cos(th);
    let maxAng = -Infinity, maxTerrain = -Infinity, sees = false;
    for (let k = 1; k <= r; k++) {
      const v = at(Math.round(ux * k), Math.round(uy * k));
      const d = k * mpp;
      const curv = (d * d) / (2 * EARTH_R);
      if (Number.isNaN(v)) {
        if ((0 - curv - h0) / d >= maxAng) sees = true;
      } else {
        const clutter = d > 150 ? 12 : 0;
        maxAng = Math.max(maxAng, (v + clutter - curv - h0) / d);
        if (d > 1500) maxTerrain = Math.max(maxTerrain, (v - curv - h0) / d);
      }
    }
    if (sees) { seaVis++; seaMask |= 1 << (Math.round(i / (RAYS / 8)) % 8); }
    if (maxTerrain > 0.0437) mt++; // 仰角2.5°以上の稜線
  }

  // 駅
  const sts = nearStations(s.lon, s.lat, 30000);
  const nearest = sts[0];
  const jr = sts.find((x) => x.p.jr);
  const other = sts.find((x) => x.p.other);
  const shin = sts.find((x) => x.p.shinkansen);
  let stUp = null;
  if (nearest && nearest.d < 3000) {
    const [sx, sy] = toPx(nearest.p.lon, nearest.p.lat);
    const v = at(Math.floor(sx) - cx, Math.floor(sy) - cy);
    if (!Number.isNaN(v)) stUp = Math.round(elev - v);
  }
  const stCount = sts.filter((x) => x.d <= 1500).length;
  const tram = sts.some((x) => x.p.tram && x.d <= 1200);
  const subway = sts.some((x) => x.p.subway && x.d <= 1200);
  const mono = sts.some((x) => x.p.mono && x.d <= 1500);
  const rails = nearRail(s.lon, s.lat, 3000);
  const rail = rails[0] ? Math.round(rails[0].d) : -1;
  const shinRail = rails.find((x) => x.p.shin);
  // 県境: 他県の学校・園がいちばん近くて何mか
  const pref = s.code.slice(0, 2);
  const other2 = nearSchools(s.lon, s.lat, 8000).find((x) => x.p.code.slice(0, 2) !== pref);
  const es = nearSchools(s.lon, s.lat, 200).some((x) => x.p.type === 16001);
  const w = wide(s, elev);

  // 周辺の学校
  const around = nearSchools(s.lon, s.lat, 1500).filter((x) => x.p !== s);
  const dens = around.length;
  const univ = around.some((x) => x.p.type === 16007 && x.d <= 1000);
  const hs = around.some((x) => HS_TYPES.has(x.p.type) && x.d <= 500 && x.d > 30 && x.p.name !== s.name);
  const jh = s.type === 16003 || around.some((x) => x.p.type === 16002 && x.d <= 150);

  return {
    name: s.name,
    code: s.code,
    addr: s.addr,
    admin: s.admin,
    lat: +s.lat.toFixed(5),
    lon: +s.lon.toFixed(5),
    elev: Math.round(elev),
    rise: Math.round(rise),
    drop: Math.round(drop),
    coast: coastM,
    coastDir,
    seaVis,
    seaMask,
    mt,
    st: nearest ? nearest.p.name : "",
    stDist: nearest ? Math.round(nearest.d) : -1,
    stJr: jr ? Math.round(jr.d) : -1,
    stOther: other ? Math.round(other.d) : -1,
    stShin: shin ? Math.round(shin.d) : -1,
    stUp,
    stCount,
    dens,
    univ: univ ? 1 : 0,
    hs: hs ? 1 : 0,
    jh: jh ? 1 : 0,
    es: es ? 1 : 0,
    seaSec,
    island: w.island,
    pk: w.pk,
    pka: w.pka,
    pkd: w.pkd,
    tram: tram ? 1 : 0,
    subway: subway ? 1 : 0,
    mono: mono ? 1 : 0,
    rail,
    shinRail: shinRail ? Math.round(shinRail.d) : -1,
    border: other2 ? Math.round(other2.d) : -1,
  };
}

await downloadTiles();
await loadZ8();
// タイルキャッシュが効くよう、タイル順に処理
const order = schools
  .map((s) => ({ s, k: toPx(s.lon, s.lat).map((v) => Math.floor(v / 256)) }))
  .sort((p, q) => p.k[0] - q.k[0] || p.k[1] - q.k[1]);
const rows = [];
for (const [i, { s }] of order.entries()) {
  rows.push(analyze(s));
  if ((i + 1) % 500 === 0) console.log(`analyzed ${i + 1}/${order.length}`);
}
rows.sort((p, q) => p.code.localeCompare(q.code) || p.name.localeCompare(q.name, "ja"));
// Wikipedia 由来の特徴（scripts/build-wiki.mjs の出力）があれば合流させる
const WIKI = path.join(ROOT, "data/wiki.json");
let kwKeys = [];
if (fs.existsSync(WIKI)) {
  const wiki = JSON.parse(fs.readFileSync(WIKI, "utf8"));
  kwKeys = wiki.kwKeys;
  for (const r of rows) Object.assign(r, wiki.empty, wiki.schools[`${r.code}:${r.name}`]);
}
const BV = path.join(ROOT, "data/bvmap.json");
if (fs.existsSync(BV)) {
  const bv = JSON.parse(fs.readFileSync(BV, "utf8"));
  for (const r of rows) Object.assign(r, bv.empty, bv.schools[`${r.code}:${r.name}`]);
}
const fields = Object.keys(rows[0]);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ peaks: PEAKS.map((p) => p[0]), kwKeys, fields, rows: rows.map((r) => fields.map((f) => r[f])) }));
console.log(`wrote ${rows.length} schools -> ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
