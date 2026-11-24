// 黒板に描く点描の日本地図。学校をマス目に割り当て、事後確率から各マスの状態を決める。

export const COLS = 43;
export const ROWS = 47;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 学校の位置 → マス番号。沖縄・奄美は左上の空きに寄せる */
export function cellOf(s: { lat: number; lon: number }): number {
  let { lat, lon } = s;
  if (lat < 30 && lon < 132) {
    lon += 3.2;
    lat += 15.5;
  }
  const x = clamp(Math.floor((lon - 128.6) * 0.8 * 3.05), 0, COLS - 1);
  const y = clamp(Math.floor((45.7 - lat) * 3.05), 0, ROWS - 1);
  return y * COLS + x;
}

export const OFF = 1;
export const ON = 2;
export const HOT = 3;

/** 地方（バツ印のラベル用）。都道府県コード → 地方番号 */
const REGION_NAMES = ["北海道", "東北", "関東", "中部", "近畿", "中国", "四国", "九州", "沖縄"];
function regionOf(pref: number): number {
  if (pref === 1) return 0;
  if (pref <= 7) return 1;
  if (pref <= 14) return 2;
  if (pref <= 23) return 3;
  if (pref <= 30) return 4;
  if (pref <= 35) return 5;
  if (pref <= 39) return 6;
  if (pref <= 46) return 7;
  return 8;
}

export type Box = { x0: number; y0: number; x1: number; y1: number };
export type Geo = {
  /** 学校ごとのマス番号 */
  cells: Int32Array;
  /** 学校ごとの地方番号 */
  regions: Int8Array;
  /** 地方ごとの、地図上のおおよその範囲（マス座標） */
  boxes: Box[];
};

export function buildGeo(schools: { lat: number; lon: number; pref: number }[]): Geo {
  const cells = Int32Array.from(schools, cellOf);
  const regions = Int8Array.from(schools, (s) => regionOf(s.pref));
  const boxes = REGION_NAMES.map((_, r) => {
    const xs: number[] = [];
    const ys: number[] = [];
    cells.forEach((c, i) => {
      if (regions[i] !== r) return;
      xs.push(c % COLS);
      ys.push(Math.floor(c / COLS));
    });
    xs.sort((a, b) => a - b);
    ys.sort((a, b) => a - b);
    // 離島で範囲が広がりすぎないよう、両端3%は捨てる
    const q = (v: number[], t: number) => v[Math.min(v.length - 1, Math.floor(v.length * t))] ?? 0;
    return { x0: q(xs, 0.03), y0: q(ys, 0.03), x1: q(xs, 0.97) + 1, y1: q(ys, 0.97) + 1 };
  });
  return { cells, regions, boxes };
}

export type Marks = {
  /** 直前の答えで消えた地方に付けるバツ印 */
  crosses: (Box & { label: string })[];
  /** 怪しい場所を指す矢印の先（マス座標）。強い順 */
  arrows: { x: number; y: number }[];
  /** 候補が帯状に残っているときの波線。a→b に沿って、(nx, ny) の側にずらして引く */
  wave: { ax: number; ay: number; bx: number; by: number; nx: number; ny: number } | null;
};

export type MapView = {
  /** マスごとの状態: 0=海, 1=消えた, 2=残っている, 3=かなり怪しい */
  state: Uint8Array;
  /** 残っている学校の数（確率の高い順に並べて、合計95%に届くまでの校数） */
  alive: number;
  marks: Marks;
};

const NO_MARKS: Marks = { crosses: [], arrows: [], wave: null };

export function mapView(geo: Geo, w: Float64Array | null, focus: number | null, prev: Float64Array | null = null): MapView {
  const { cells } = geo;
  const state = new Uint8Array(COLS * ROWS);
  for (const c of cells) state[c] = OFF;

  if (focus !== null) {
    state[cells[focus]] = HOT;
    return { state, alive: 1, marks: NO_MARKS };
  }
  if (!w) {
    for (const c of cells) state[c] = ON;
    return { state, alive: cells.length, marks: NO_MARKS };
  }

  const order = Array.from(w.keys()).sort((a, b) => w[b] - w[a]);
  const mass = new Float64Array(COLS * ROWS);
  for (let i = 0; i < w.length; i++) mass[cells[i]] += w[i];
  let alive = 0;
  let cum = 0;
  for (const i of order) {
    if (!(w[i] > 0) || cum >= 0.95) break;
    cum += w[i];
    alive++;
    state[cells[i]] = ON;
  }

  let top = 0;
  for (let c = 1; c < mass.length; c++) if (mass[c] > mass[top]) top = c;
  if (mass[top] >= 0.04) {
    for (let c = 0; c < mass.length; c++) if (state[c] === ON && mass[c] >= mass[top] * 0.35) state[c] = HOT;
  }

  if (alive <= 1) return { state, alive, marks: NO_MARKS };
  // 書き込みが重ならないよう、バツを付けるターンは矢印・波線を出さない
  const xs = crosses(geo, w, prev);
  return { state, alive, marks: xs.length ? { crosses: xs, arrows: [], wave: null } : { crosses: xs, ...pointers(mass, alive) } };
}

/** 直前の答えで、まとまった候補がほぼ消えた地方 */
function crosses(geo: Geo, w: Float64Array, prev: Float64Array | null): Marks["crosses"] {
  if (!prev) return [];
  const before = new Float64Array(REGION_NAMES.length);
  const after = new Float64Array(REGION_NAMES.length);
  for (let i = 0; i < w.length; i++) {
    before[geo.regions[i]] += prev[i];
    after[geo.regions[i]] += w[i];
  }
  return REGION_NAMES.map((label, r) => ({ label, r }))
    .filter(({ r }) => before[r] >= 0.04 && after[r] < 0.03 && after[r] <= before[r] * 0.2)
    .sort((a, b) => before[b.r] - before[a.r])
    .slice(0, 2)
    .map(({ label, r }) => ({ label, ...geo.boxes[r] }));
}

/** 怪しい場所への矢印（数か所にまとまっているとき）か、帯状に残る候補への波線 */
function pointers(mass: Float64Array, alive: number): Pick<Marks, "arrows" | "wave"> {
  // まわり込みで確率が集まっているマスを、離れた場所から順に最大4つ拾う
  const near = new Float64Array(mass.length);
  for (let c = 0; c < mass.length; c++) {
    if (!mass[c]) continue;
    const cx = c % COLS;
    const cy = Math.floor(c / COLS);
    for (let y = Math.max(0, cy - 1); y <= Math.min(ROWS - 1, cy + 1); y++)
      for (let x = Math.max(0, cx - 1); x <= Math.min(COLS - 1, cx + 1); x++) near[y * COLS + x] += mass[c];
  }
  const arrows: Marks["arrows"] = [];
  let covered = 0;
  let first = 0;
  for (let k = 0; k < 4; k++) {
    let best = -1;
    for (let c = 0; c < near.length; c++) {
      if (near[c] <= (best < 0 ? 0 : near[best])) continue;
      const x = c % COLS;
      const y = Math.floor(c / COLS);
      if (arrows.some((a) => Math.hypot(a.x - x, a.y - y) < 4.5)) continue;
      best = c;
    }
    if (best < 0) break;
    if (k === 0) first = near[best];
    if (near[best] < 0.07 || near[best] < first * 0.3) break;
    covered += near[best];
    arrows.push({ x: best % COLS, y: Math.floor(best / COLS) });
  }
  // ある程度絞れてから（人口の多い都市部は最初から濃いので、早い段階では指さない）
  if (alive <= 300 && covered >= 0.5) return { arrows, wave: null };
  if (alive > 2500) return { arrows: [], wave: null };

  // 帯: 確率の重心と広がり（主軸）を求め、ほどよく細長くまとまっていれば波線でなぞる
  let m = 0, mx = 0, my = 0;
  for (let c = 0; c < mass.length; c++) {
    m += mass[c];
    mx += mass[c] * (c % COLS);
    my += mass[c] * Math.floor(c / COLS);
  }
  mx /= m;
  my /= m;
  let sxx = 0, syy = 0, sxy = 0;
  for (let c = 0; c < mass.length; c++) {
    const dx = (c % COLS) - mx;
    const dy = Math.floor(c / COLS) - my;
    sxx += mass[c] * dx * dx;
    syy += mass[c] * dy * dy;
    sxy += mass[c] * dx * dy;
  }
  sxx /= m;
  syy /= m;
  sxy /= m;
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l2 = tr - l1;
  const s1 = Math.sqrt(l1);
  const s2 = Math.sqrt(Math.max(0, l2));
  if (s1 < 2 || s1 > 9) return { arrows: [], wave: null };
  let ux = sxy, uy = l1 - sxx;
  if (Math.hypot(ux, uy) < 1e-9) [ux, uy] = sxx >= syy ? [1, 0] : [0, 1];
  const ul = Math.hypot(ux, uy);
  ux /= ul;
  uy /= ul;
  // 波線は左上（日本海・大陸側）に寄せる。右下は「のこり」の数字とぶつかるため
  let nx = -uy, ny = ux;
  if (nx + ny > 0) [nx, ny] = [-nx, -ny];
  const off = s2 * 1.5 + 1.5;
  const len = s1 * 1.5;
  return {
    arrows: [],
    wave: { ax: mx - ux * len + nx * off, ay: my - uy * len + ny * off, bx: mx + ux * len + nx * off, by: my + uy * len + ny * off, nx, ny },
  };
}
