/** Number formatting per unit, and the scale and ticks of a chart's value axis. */

/** Units of the values of a time series chart. */
export type Unit =
  | "count"
  | "percent"
  | "percent_unit"
  | "bytes"
  | "bytes_per_sec"
  | "bits_per_sec"
  | "ops_per_sec"
  | "packets_per_sec"
  | "seconds";

/** One line of a chart. */
export interface Series {
  name: string;
  labels: Record<string, string>;
  /** [unix seconds, value], sorted by time. */
  values: [number, number][];
}

/** A time range in unix seconds. */
export interface Range {
  start: number;
  end: number;
}

interface Scale {
  div: number;
  suffix: string;
}

const BIN = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
const BITS = ["b/s", "kb/s", "Mb/s", "Gb/s", "Tb/s"];
const SI = ["", "k", "M", "G", "T"];

function stepScale(max: number, base: number, names: string[], tail = ""): Scale {
  let i = 0;
  let div = 1;
  while (max >= div * base && i < names.length - 1) {
    div *= base;
    i++;
  }
  return { div, suffix: names[i] + tail };
}

/** The unit prefix that suits values up to `max`. */
export function scaleFor(unit: Unit, max: number): Scale {
  const m = Math.abs(max);
  switch (unit) {
    case "percent":
    case "percent_unit":
      return { div: 1, suffix: "%" };
    case "bytes":
      return stepScale(m, 1024, BIN);
    case "bytes_per_sec":
      return stepScale(m, 1024, BIN, "/s");
    case "bits_per_sec":
      return stepScale(m, 1000, BITS);
    case "seconds":
      if (m > 0 && m < 1e-3) return { div: 1e-6, suffix: "µs" };
      if (m > 0 && m < 1) return { div: 1e-3, suffix: "ms" };
      return { div: 1, suffix: "s" };
    case "ops_per_sec": {
      const s = stepScale(m, 1000, SI);
      return { div: s.div, suffix: `${s.suffix} ops/s` };
    }
    case "packets_per_sec": {
      const s = stepScale(m, 1000, SI);
      return { div: s.div, suffix: `${s.suffix} pkt/s` };
    }
    default:
      return stepScale(m, 1000, SI);
  }
}

const join = (n: string, suffix: string) => (suffix === "%" || suffix === "" ? `${n}${suffix}` : `${n} ${suffix.trim()}`);

function digits(v: number) {
  const a = Math.abs(v);
  return a === 0 || a >= 100 ? 0 : a >= 10 ? 1 : 2;
}

/** A value with its own best unit prefix, e.g. 1.5 GiB, 120 Mb/s, 3.2 ms. */
export function fmt(v: number | null | undefined, unit: Unit): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (unit === "percent_unit") return fmt(v * 100, "percent");
  const s = scaleFor(unit, v);
  const x = v / s.div;
  if (unit === "count" && s.div === 1) return Number.isInteger(x) ? String(x) : x.toFixed(digits(x));
  return join(x.toFixed(digits(x)), s.suffix);
}

/** Round numbers from 0 to at least `max` for the value axis (in raw units). */
export function niceTicks(max: number, unit: Unit, count = 4): { ticks: number[]; scale: Scale; top: number } {
  const scale = scaleFor(unit, max);
  let top = max / scale.div;
  if (!(top > 0)) top = unit === "percent" ? 100 : 1;
  const raw = top / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const n = Math.max(1, Math.ceil(top / step - 1e-9));
  const ticks = Array.from({ length: n + 1 }, (_, i) => i * step * scale.div);
  return { ticks, scale, top: n * step * scale.div };
}

/** An axis label in a fixed scale: "1.5", "200 MiB"… */
export function fmtTick(v: number, scale: Scale) {
  const x = v / scale.div;
  return join(String(Math.round(x * 100) / 100), scale.suffix);
}
