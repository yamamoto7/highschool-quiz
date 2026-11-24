import { COLS, HOT, ON, ROWS, type MapView } from "@/lib/map";

const PITCH = 7;
const W = COLS * PITCH;
const H = ROWS * PITCH;
const CLASS = ["", "dot-off", "dot-on", "dot-hot"];
const px = (cell: number) => cell * PITCH + PITCH / 2;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const f = (v: number) => v.toFixed(1);

type CrossBox = { x0: number; y0: number; x1: number; y1: number; label: string };

/** 消えた地方に付けるバツ印と「◯◯では なさそう」（文字は1か所にまとめる） */
function Crosses({ boxes }: { boxes: CrossBox[] }) {
  const rects = boxes.map((b) => ({ x0: b.x0 * PITCH - 3, y0: b.y0 * PITCH - 3, x1: b.x1 * PITCH + 3, y1: b.y1 * PITCH + 3 }));
  const { x0, y0, x1, y1 } = rects[0];
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const label = boxes.map((b) => b.label).join("・");
  const width = label.length * 15 + 34;
  // 文字は地図の左側（日本海側）の空きに置く。入らなければバツの下
  const left = x0 > width + 12;
  const tx = left ? Math.max(4, x0 - width - 4) : clamp(mx - width / 2, 4, W - width);
  const ty = left ? clamp(my - 6, 16, H - 30) : Math.min(y1 + 20, H - 26);
  return (
    <g className="mark">
      {rects.map((r, i) => {
        const cx = (r.x0 + r.x1) / 2;
        const cy = (r.y0 + r.y1) / 2;
        return (
          <path
            key={i}
            d={`M${f(r.x0)} ${f(r.y0)} Q${f(cx + 6)} ${f(cy - 4)} ${f(r.x1)} ${f(r.y1)} M${f(r.x1)} ${f(r.y0)} Q${f(cx - 4)} ${f(cy - 6)} ${f(r.x0)} ${f(r.y1)}`}
          />
        );
      })}
      <text x={tx} y={ty} transform={`rotate(-4 ${tx} ${ty})`}>
        <tspan x={tx}>{label}では</tspan>
        <tspan x={tx} dy={19}>
          なさそう
        </tspan>
      </text>
    </g>
  );
}

/** 怪しい場所へ、外側（海のほう）から伸ばす矢印 */
function arrowGeom(a: { x: number; y: number }) {
  const cx = px(a.x);
  const cy = px(a.y);
  // 列島のまんなかあたりから見て外向き
  let dx = cx - px(22);
  let dy = cy - px(29);
  const l = Math.hypot(dx, dy);
  if (l < 20) [dx, dy] = [0.8, -0.6];
  else [dx, dy] = [dx / l, dy / l];
  // 地図の外にはみ出すなら向きを変える
  if (cx + dx * 60 > W - 6 || cx + dx * 60 < 6) dx = -dx;
  if (cy + dy * 60 > H - 6 || cy + dy * 60 < 6) dy = -dy;
  const hx = cx + dx * 13;
  const hy = cy + dy * 13;
  const tx = cx + dx * 56;
  const ty = cy + dy * 56;
  const qx = (hx + tx) / 2 - dy * 9;
  const qy = (hy + ty) / 2 + dx * 9;
  // 矢じり: 進行方向（曲線の終端の向き）から左右に開く
  const vx = hx - qx;
  const vy = hy - qy;
  const vl = Math.hypot(vx, vy) || 1;
  const bx = -vx / vl;
  const by = -vy / vl;
  const wing = (s: number) => `l${f((bx * 0.82 - by * 0.57 * s) * 11)} ${f((by * 0.82 + bx * 0.57 * s) * 11)}`;
  return { d: `M${f(tx)} ${f(ty)} Q${f(qx)} ${f(qy)} ${f(hx)} ${f(hy)} M${f(hx)} ${f(hy)} ${wing(1)} M${f(hx)} ${f(hy)} ${wing(-1)}`, tx, ty, dx, dy };
}

function Arrows({ arrows }: { arrows: { x: number; y: number }[] }) {
  const geoms = arrows.map(arrowGeom);
  const g = geoms[0];
  // 文字はいちばん怪しい矢印の根元に
  const lx = clamp(g.tx + (g.dx >= 0 ? 4 : -66), 4, W - 66);
  const ly = clamp(g.ty + (g.dy >= 0 ? 16 : -24), 16, H - 26);
  return (
    <g className="mark">
      {geoms.map((a, i) => (
        <path key={i} d={a.d} />
      ))}
      <text x={lx} y={ly} transform={`rotate(4 ${lx} ${ly})`}>
        <tspan x={lx}>あやしい</tspan>
        <tspan x={lx} dy={19}>
          におい
        </tspan>
      </text>
    </g>
  );
}

/** 帯状に残った候補に沿って引く波線と「このあたり…？」 */
function Wave({ wave }: { wave: NonNullable<MapView["marks"]["wave"]> }) {
  const ax = px(wave.ax);
  const ay = px(wave.ay);
  const bx = px(wave.bx);
  const by = px(wave.by);
  const len = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(8, Math.round(len / 3));
  let d = "";
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const s = Math.sin((t * len * Math.PI * 2) / 17) * 3.2;
    const x = clamp(ax + (bx - ax) * t + wave.nx * s, 3, W - 3);
    const y = clamp(ay + (by - ay) * t + wave.ny * s, 3, H - 3);
    d += `${i ? "L" : "M"}${f(x)} ${f(y)} `;
  }
  const tx = clamp((ax + bx) / 2 + wave.nx * 20 - 44, 4, W - 92);
  const ty = clamp((ay + by) / 2 + wave.ny * 20, 16, H - 8);
  return (
    <g className="mark">
      <path d={d} />
      <text x={tx} y={ty} transform={`rotate(-5 ${tx} ${ty})`}>
        このあたり…？
      </text>
    </g>
  );
}

/** チョークの点で描いた日本地図。残っている候補の点だけが白く残る */
export default function ChalkMap({ view, total, shown }: { view: MapView; total: number; shown: number }) {
  const dots = [];
  for (let c = 0; c < view.state.length; c++) {
    const s = view.state[c];
    if (!s) continue;
    dots.push(<circle key={c} cx={px(c % COLS)} cy={px(Math.floor(c / COLS))} r={s === HOT ? 3.4 : 2.5} className={CLASS[s]} />);
  }
  const lit = view.state.reduce((n, s) => n + (s === ON || s === HOT ? 1 : 0), 0);
  const { crosses, arrows, wave } = view.marks;
  return (
    <div className="relative mx-auto w-full" style={{ maxWidth: W }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full"
        role="img"
        aria-label={`候補の高校が残っている場所を点で示した日本地図。${lit}か所に点が残っています`}
      >
        {dots}
        {crosses.length > 0 && <Crosses key={crosses.map((c) => c.label).join()} boxes={crosses} />}
        {arrows.length > 0 && <Arrows key={arrows.map((a) => `${a.x},${a.y}`).join("|")} arrows={arrows} />}
        {wave && <Wave wave={wave} />}
      </svg>
      <p className="absolute right-0 bottom-0 text-right text-[13px] leading-normal text-[var(--muted)]">
        のこり
        <br />
        <span className="text-[44px] leading-none text-[var(--gold)] tabular-nums">{Math.max(1, Math.round(shown)).toLocaleString()}</span>
        <span className="text-lg text-[var(--fg)]"> / {total.toLocaleString()}</span>
      </p>
    </div>
  );
}
