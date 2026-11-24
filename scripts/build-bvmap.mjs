// 学校のまわり（半径800m）に何があるかを、地理院地図のベクトルタイル（experimental_bvmap, ズーム14）から集計する。
// 田・畑・茶畑・果樹園・林、神社・寺・墓地・城跡、灯台・港・電波塔・煙突、川や湖、高速道路 など。
// タイルは取得後すぐ必要な地物だけに要約して data/cache/bv/ に保存する（再実行で続きから）。
//
// 使い方: node scripts/build-bvmap.mjs  → data/bvmap.json（public/data/schools.json があれば反映）

import fs from "node:fs";
import path from "node:path";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";

const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE = path.join(ROOT, "data/cache/bv");
const OUT = path.join(ROOT, "data/bvmap.json");
const SCHOOLS_JSON = path.join(ROOT, "public/data/schools.json");
const Z = 14, EXT = 4096, R = 800, G = 64; // G: 水域マスクの1辺のセル数

const SYMBOLS = new Set([6311, 6312, 6313, 6314, 6321, 6322, 6323, 3231, 3232, 6301, 6342, 6341, 3221, 6361, 6362, 8105, 4101, 4102, 3205, 3206, 3243, 3216, 3217]);

const toUnit = (lon, lat) => {
  const n = 2 ** Z * EXT;
  const s = Math.sin((lat * Math.PI) / 180);
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
};
const unitM = (lat) => (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (2 ** Z * EXT);

const p29 = JSON.parse(fs.readFileSync(path.join(ROOT, "data/raw/P29-21.geojson"), "utf8"))
  .features.filter((f) => f.properties.P29_003 === 16004 || f.properties.P29_003 === 16003)
  .map((f) => ({ key: `${f.properties.P29_001}:${f.properties.P29_004}`, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));

function inRings(rings, x, y) {
  let inside = false;
  for (const ring of rings)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  return inside;
}
function mask(layer) {
  const m = new Uint8Array(G * G);
  if (!layer) return "";
  const cell = EXT / G;
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== 3) continue;
    const rings = f.loadGeometry();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const r of rings) for (const p of r) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    for (let gy = Math.max(0, Math.floor(y0 / cell)); gy <= Math.min(G - 1, Math.floor(y1 / cell)); gy++)
      for (let gx = Math.max(0, Math.floor(x0 / cell)); gx <= Math.min(G - 1, Math.floor(x1 / cell)); gx++)
        if (!m[gy * G + gx] && inRings(rings, (gx + 0.5) * cell, (gy + 0.5) * cell)) m[gy * G + gx] = 1;
  }
  return m.includes(1) ? Buffer.from(m).toString("base64") : "";
}

function summarize(buf) {
  const t = new VectorTile(new PbfReader(buf));
  const sym = [];
  const S = t.layers.symbol;
  for (let i = 0; S && i < S.length; i++) {
    const f = S.feature(i);
    if (!SYMBOLS.has(f.properties.ftCode)) continue;
    const p = f.loadGeometry()[0][0];
    sym.push([f.properties.ftCode, p.x, p.y]);
  }
  const lab = [];
  const L = t.layers.label;
  for (let i = 0; L && i < L.length; i++) {
    const f = L.feature(i);
    const { annoCtg: c, knj } = f.properties;
    if (!knj || !((c >= 300 && c < 700) || /温泉/.test(knj))) continue;
    const p = f.loadGeometry()[0][0];
    lab.push([c, knj, p.x, p.y]);
  }
  const mw = [];
  const Rd = t.layers.road;
  for (let i = 0; Rd && i < Rd.length; i++) {
    const f = Rd.feature(i);
    if (f.properties.motorway !== 1) continue;
    for (const line of f.loadGeometry()) for (let k = 0; k < line.length; k += 2) mw.push([line[k].x, line[k].y]);
  }
  return { sym, lab, mw, water: mask(t.layers.waterarea), lake: mask(t.layers.lake) };
}

const tileFile = (x, y) => path.join(CACHE, `${x}_${y}.json`);
async function fetchTiles() {
  fs.mkdirSync(CACHE, { recursive: true });
  const need = new Set();
  for (const s of p29) {
    const [ux, uy] = toUnit(s.lon, s.lat);
    const r = R / unitM(s.lat);
    for (let x = Math.floor((ux - r) / EXT); x <= Math.floor((ux + r) / EXT); x++)
      for (let y = Math.floor((uy - r) / EXT); y <= Math.floor((uy + r) / EXT); y++) need.add(`${x},${y}`);
  }
  const todo = [...need].map((k) => k.split(",").map(Number)).filter(([x, y]) => !fs.existsSync(tileFile(x, y)));
  console.log(`tiles: need ${need.size}, to fetch ${todo.length}`);
  let done = 0;
  const worker = async () => {
    for (let t; (t = todo.pop()); ) {
      const [x, y] = t;
      const url = `https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/${Z}/${x}/${y}.pbf`;
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(url);
          if (res.status === 404) fs.writeFileSync(tileFile(x, y), "{}");
          else if (res.ok) fs.writeFileSync(tileFile(x, y), JSON.stringify(summarize(Buffer.from(await res.arrayBuffer()))));
          else throw new Error(`HTTP ${res.status}`);
          break;
        } catch (e) {
          if (attempt >= 4) throw new Error(`${url}: ${e.message}`);
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
      if (++done % 500 === 0) console.log(`  fetched ${done}`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
}

const tiles = new Map();
function tile(x, y) {
  const k = `${x},${y}`;
  if (!tiles.has(k)) {
    const t = JSON.parse(fs.readFileSync(tileFile(x, y), "utf8"));
    t.w = t.water ? Buffer.from(t.water, "base64") : null;
    t.l = t.lake ? Buffer.from(t.lake, "base64") : null;
    if (tiles.size > 400) tiles.delete(tiles.keys().next().value);
    tiles.set(k, t);
  }
  return tiles.get(k);
}

function analyze(s) {
  const [ux, uy] = toUnit(s.lon, s.lat);
  const m = unitM(s.lat);
  const r = R / m;
  const count = {}; // ftCode -> [300m以内, 800m以内]
  let castle = 0, onsen = 0, park = 0, river = "", riverD = Infinity, lakeLabel = 0, mwD = Infinity;
  let waterCells = 0, cells = 0, waterD = Infinity, lakeD = Infinity;
  const cell = EXT / G;
  for (let tx = Math.floor((ux - r) / EXT); tx <= Math.floor((ux + r) / EXT); tx++)
    for (let ty = Math.floor((uy - r) / EXT); ty <= Math.floor((uy + r) / EXT); ty++) {
      const t = tile(tx, ty);
      const dist = (x, y) => Math.hypot(tx * EXT + x - ux, ty * EXT + y - uy) * m;
      for (const [code, x, y] of t.sym ?? []) {
        const d = dist(x, y);
        if (d > R) continue;
        const c = (count[code] ??= [0, 0, 0]);
        c[2]++;
        if (d <= 400) c[1]++;
        if (d <= 250) c[0]++;
      }
      for (const [c, knj, x, y] of t.lab ?? []) {
        const d = dist(x, y);
        if (d > R) continue;
        if (c === 531 || /城跡|城址/.test(knj)) castle = 1;
        if (/温泉/.test(knj)) onsen = 1;
        if (c === 534 && d <= 350) park = 1;
        if (c === 321 && d <= 600 && /湖|沼|池|潟/.test(knj)) lakeLabel = 1;
        if (c === 322 && /川$/.test(knj) && d < riverD) { riverD = d; river = knj; }
      }
      for (const [x, y] of t.mw ?? []) mwD = Math.min(mwD, dist(x, y));
      for (let gy = 0; gy < G; gy++)
        for (let gx = 0; gx < G; gx++) {
          const d = dist((gx + 0.5) * cell, (gy + 0.5) * cell);
          if (d > 600) continue;
          if (d <= 500) cells++;
          if (t.w?.[gy * G + gx]) { if (d <= 500) waterCells++; waterD = Math.min(waterD, d); }
          if (t.l?.[gy * G + gx]) lakeD = Math.min(lakeD, d);
        }
    }
  const n = (code, i = 2) => count[code]?.[i] ?? 0;
  return {
    paddy: n(6311), field: n(6312), tea: n(6313), orchard: n(6314),
    forest: n(6321, 1) + n(6322, 1), bamboo: n(6323),
    shrine: n(3231, 0), temple: n(3232, 0), temples: n(3232), grave: n(6301, 1),
    castleNear: castle || n(6342) ? 1 : 0, historic: n(6341, 1) ? 1 : 0,
    lighthouse: n(3221) ? 1 : 0, port: n(6361) + n(6362) ? 1 : 0,
    tower: n(8105, 1) ? 1 : 0, chimney: n(4101) ? 1 : 0, windmill: n(4102) ? 1 : 0,
    cityhall: n(3205, 1) + n(3206, 1) ? 1 : 0, hospital: n(3243, 0) ? 1 : 0,
    onsen, park,
    water: cells ? Math.round((waterCells / cells) * 100) : 0,
    waterD: waterD === Infinity ? -1 : Math.round(waterD),
    lake: lakeD <= 500 || lakeLabel ? 1 : 0,
    river,
    mw: mwD > R ? -1 : Math.round(mwD),
  };
}

await fetchTiles();
const order = p29.map((s) => ({ s, u: toUnit(s.lon, s.lat) })).sort((a, b) => Math.floor(a.u[0] / EXT) - Math.floor(b.u[0] / EXT) || a.u[1] - b.u[1]);
const result = {};
for (const [i, { s }] of order.entries()) {
  result[s.key] = analyze(s);
  if ((i + 1) % 1000 === 0) console.log(`analyzed ${i + 1}/${order.length}`);
}
const empty = Object.fromEntries(Object.entries(Object.values(result)[0]).map(([k, v]) => [k, typeof v === "string" ? "" : 0]));
fs.writeFileSync(OUT, JSON.stringify({ empty, schools: result }));
const stat = {};
for (const f of Object.values(result)) for (const [k, v] of Object.entries(f)) if (v && v !== -1) stat[k] = (stat[k] ?? 0) + 1;
console.log(`wrote ${OUT}`, stat);

if (fs.existsSync(SCHOOLS_JSON)) {
  const j = JSON.parse(fs.readFileSync(SCHOOLS_JSON, "utf8"));
  const fields = [...j.fields, ...Object.keys(empty).filter((k) => !j.fields.includes(k))];
  const iCode = j.fields.indexOf("code"), iName = j.fields.indexOf("name");
  const rows = j.rows.map((r) => {
    const f = result[`${r[iCode]}:${r[iName]}`] ?? empty;
    return fields.map((k, i) => (k in empty ? f[k] : r[i]));
  });
  fs.writeFileSync(SCHOOLS_JSON, JSON.stringify({ ...j, fields, rows }));
  console.log(`patched ${SCHOOLS_JSON}`);
}
