/** Single-value panels: stat tiles, gauges and a pie (donut) chart, from the last value of each series. */
import { useState } from "react";
import { cn, tr } from "@rassvet/sdk";
import type { Series, Unit } from "./api";
import { fmt, seriesColor, useChartStyle, useLegendPick } from "@rassvet/sdk";

const last = (s: Series) => s.values.at(-1)?.[1] ?? null;

export function Stats({ series, unit }: { series: Series[]; unit: Unit }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3">
      {series.map((s) => (
        <div key={s.name} className="min-w-0 rounded-md bg-surface px-4 py-3">
          <div className="truncate text-xs text-muted" title={s.name}>
            {s.name}
          </div>
          <div className="mt-1 truncate text-2xl font-semibold tracking-tight">{fmt(last(s), unit)}</div>
        </div>
      ))}
    </div>
  );
}

/** A 180° gauge per series, from `min` (default 0) to `max` (default 100 for percentages). */
export function Gauges({ series, unit, min, max }: { series: Series[]; unit: Unit; min?: number; max?: number }) {
  useChartStyle();
  const lo = min ?? 0;
  const hi = max ?? (unit === "percent" ? 100 : Math.max(lo + 1, ...series.map((s) => last(s) ?? 0)));
  return (
    <div className="mon-chart grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3">
      {series.map((s, i) => {
        const v = last(s);
        const share = v == null ? 0 : Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
        const r = 60;
        const arc = (f: number) => {
          const a = Math.PI * (1 - f);
          return `${70 + r * Math.cos(a)},${72 - r * Math.sin(a)}`;
        };
        return (
          <div key={s.name} className="flex min-w-0 flex-col items-center">
            <svg viewBox="0 0 140 96" className="w-full max-w-48" role="img" aria-label={`${s.name}: ${fmt(v, unit)}`}>
              <path d={`M${arc(0)} A${r},${r} 0 0 1 ${arc(1)}`} fill="none" stroke="var(--color-line)" strokeWidth={12} strokeLinecap="round" />
              {share > 0 && (
                <path
                  d={`M${arc(0)} A${r},${r} 0 0 1 ${arc(share)}`}
                  fill="none"
                  stroke={seriesColor(i)}
                  strokeWidth={12}
                  strokeLinecap="round"
                />
              )}
              <text x={70} y={68} textAnchor="middle" className="fill-ink text-[17px] font-semibold">
                {fmt(v, unit)}
              </text>
              <text x={10} y={93} textAnchor="middle" className="fill-muted text-[9px]">
                {fmt(lo, unit)}
              </text>
              <text x={130} y={93} textAnchor="middle" className="fill-muted text-[9px]">
                {fmt(hi, unit)}
              </text>
            </svg>
            <div className="mt-1 max-w-full truncate text-xs text-muted" title={s.name}>
              {s.name}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const MAX_SLICES = 8;

/**
 * A donut of the series' last values: the 7 largest and "Other". The legend lists every series
 * (`legendRows` rows before it scrolls); ticking some draws only those.
 */
export function Pie({ series, unit, legendRows = 4 }: { series: Series[]; unit: Unit; legendRows?: number }) {
  useChartStyle();
  const [hover, setHover] = useState<number | null>(null);
  const pick = useLegendPick();
  const all = series
    .map((s) => ({ name: s.name, value: Math.max(0, last(s) ?? 0) }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value);
  const shown = pick.isShown(all.map((x) => x.name));
  let items = all.filter((x) => shown(x.name));
  if (items.length > MAX_SLICES) {
    const rest = items.slice(MAX_SLICES - 1).reduce((t, x) => t + x.value, 0);
    items = [...items.slice(0, MAX_SLICES - 1), { name: tr("Other"), value: rest }];
  }
  const total = items.reduce((t, x) => t + x.value, 0);
  if (!total) return <p className="py-6 text-center text-sm text-muted">{tr("No data in this time range")}</p>;

  const color = (i: number) => (items.length === MAX_SLICES && i === MAX_SLICES - 1 ? "var(--color-muted)" : seriesColor(i));
  let angle = -Math.PI / 2;
  const R = 70;
  const r = 44;
  const slices = items.map((x, i) => {
    const a0 = angle;
    const a1 = angle + (x.value / total) * Math.PI * 2;
    angle = a1;
    const p = (a: number, rad: number) => `${80 + rad * Math.cos(a)},${80 + rad * Math.sin(a)}`;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const d =
      items.length === 1
        ? `M${p(-Math.PI / 2, R)} A${R},${R} 0 1 1 ${p(Math.PI * 1.5 - 0.0001, R)} L${p(Math.PI * 1.5 - 0.0001, r)} A${r},${r} 0 1 0 ${p(-Math.PI / 2, r)} Z`
        : `M${p(a0, R)} A${R},${R} 0 ${large} 1 ${p(a1, R)} L${p(a1, r)} A${r},${r} 0 ${large} 0 ${p(a0, r)} Z`;
    return { ...x, d, i };
  });
  const focused = hover === null ? null : items[hover];

  return (
    <div className="mon-chart flex flex-wrap items-center gap-4">
      <svg viewBox="0 0 160 160" className="w-40 shrink-0" role="img" aria-label={items.map((x) => `${x.name}: ${fmt(x.value, unit)}`).join(", ")}>
        {slices.map((s) => (
          <path
            key={s.name}
            d={s.d}
            fill={color(s.i)}
            stroke="var(--color-panel)"
            strokeWidth={2}
            opacity={hover === null || hover === s.i ? 1 : 0.45}
            onPointerEnter={() => setHover(s.i)}
            onPointerLeave={() => setHover(null)}
          >
            <title>{`${s.name}: ${fmt(s.value, unit)}`}</title>
          </path>
        ))}
        <text x={80} y={78} textAnchor="middle" className="fill-ink text-[13px] font-semibold">
          {fmt(focused ? focused.value : total, unit)}
        </text>
        <text x={80} y={94} textAnchor="middle" className="fill-muted text-[10px]">
          {focused ? `${((focused.value / total) * 100).toFixed(1)}%` : tr("Total")}
        </text>
      </svg>
      <div className="min-w-0 flex-1 overflow-y-auto" style={{ maxHeight: 28 * (legendRows + (pick.picked.size ? 1 : 0)) }}>
        {all.some((x) => pick.picked.has(x.name)) && (
          <button type="button" className="h-7 text-xs text-cable hover:underline" onClick={pick.clear}>
            {tr("Show all")}
          </button>
        )}
        <table className="w-full table-fixed text-xs">
          <tbody>
            {all.map((x) => {
              const k = items.findIndex((it) => it.name === x.name);
              const on = shown(x.name);
              return (
                <tr
                  key={x.name}
                  className={cn("h-7 border-t border-line first:border-0", !on && "opacity-50")}
                  onPointerEnter={() => k >= 0 && setHover(k)}
                  onPointerLeave={() => setHover(null)}
                >
                  <td className="truncate" title={x.name}>
                    <label className="flex min-w-0 cursor-pointer items-center gap-2">
                      {all.length > 1 && (
                        <input
                          type="checkbox"
                          className="size-3.5 shrink-0 accent-[var(--color-cable)]"
                          checked={pick.picked.has(x.name)}
                          onChange={() => pick.toggle(x.name)}
                          aria-label={tr("Show only the ticked series")}
                        />
                      )}
                      <span
                        className="inline-block size-2.5 shrink-0 rounded-sm"
                        style={{ background: k >= 0 ? color(k) : "var(--color-line)" }}
                      />
                      <span className="truncate">{x.name}</span>
                    </label>
                  </td>
                  <td className="w-24 text-right font-mono">{fmt(x.value, unit)}</td>
                  <td className="w-14 text-right font-mono text-muted">{on && total ? `${((x.value / total) * 100).toFixed(1)}%` : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
