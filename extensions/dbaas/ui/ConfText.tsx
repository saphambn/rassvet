/**
 * Engine parameters as text: one "key = value" per line, the way postgresql.conf, my.cnf and mongod.conf are
 * written, so a list can be pasted or a configuration file loaded instead of filling one row per parameter.
 *
 * Accepted: `key = value`, `key=value`, `key: value`; comments after `#` (and `;` at the start of a line, as in
 * my.cnf); `[mysqld]`-style section headers, ignored; quoted values ('64MB'); and nested YAML keys as in
 * mongod.conf, flattened to dotted names (`operationProfiling:` then `  slowOpThresholdMs: 200` gives
 * `operationProfiling.slowOpThresholdMs`). Names are matched to the catalog's spelling (case, and MySQL's
 * dashes for underscores).
 */
import { useRef } from "react";
import { Icon, cn, tr } from "@rassvet/sdk";
import type { CatalogParameter } from "./api";

export type ConfLine = { line: number; message: string };
export interface ParsedConf {
  values: Record<string, string>;
  /** Line of each key, to point at the server's messages. */
  lines: Record<string, number>;
  errors: ConfLine[];
  warnings: ConfLine[];
}

/** Value without its quotes or trailing comment. */
function cleanValue(raw: string): { value: string; error?: string } {
  const v = raw.trim();
  const q = v[0];
  if (q === "'" || q === '"') {
    // postgresql.conf doubles a quote inside a quoted value.
    let out = "";
    for (let i = 1; i < v.length; i++) {
      if (v[i] === q) {
        if (v[i + 1] === q) {
          out += q;
          i++;
          continue;
        }
        const rest = v.slice(i + 1).trim();
        return rest && !rest.startsWith("#") ? { value: out, error: tr("Unexpected text after the quoted value") } : { value: out };
      }
      out += v[i];
    }
    return { value: out, error: tr("Missing closing quote") };
  }
  // A comment starts at a # after a space; a # inside a value (a URL fragment, a JSON string) stays.
  const m = /\s#/.exec(v);
  return { value: (m ? v.slice(0, m.index) : v).trim() };
}

export function parseConf(text: string, catalog?: CatalogParameter[]): ParsedConf {
  const known = new Map<string, string>();
  for (const p of catalog ?? []) known.set(p.name.toLowerCase(), p.name);
  const canonical = (k: string) => known.get(k.toLowerCase()) ?? known.get(k.toLowerCase().replace(/-/g, "_")) ?? k;

  const out: ParsedConf = { values: {}, lines: {}, errors: [], warnings: [] };
  // Open YAML parents: their indentation and name.
  const stack: { indent: number; key: string }[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) return;
    if (/^\[[^\]]*\]$/.test(trimmed)) {
      stack.length = 0;
      return;
    }
    if (trimmed === "---") return;
    const indent = raw.length - raw.trimStart().length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();

    const eq = trimmed.indexOf("=");
    const colon = trimmed.search(/:(\s|$)/);
    let key: string;
    let rest: string;
    // "=" wins unless a YAML colon comes first (a MongoDB value may hold "=").
    if (eq > 0 && (colon < 0 || eq < colon)) {
      key = trimmed.slice(0, eq).trim();
      rest = trimmed.slice(eq + 1);
    } else if (colon > 0) {
      key = trimmed.slice(0, colon).trim();
      rest = trimmed.slice(colon + 1);
      if (!cleanValue(rest).value) {
        // "parent:" opens a nested block.
        stack.push({ indent, key });
        return;
      }
      key = [...stack.map((s) => s.key), key].join(".");
    } else {
      out.errors.push({ line, message: tr("Expected \"name = value\"") });
      return;
    }
    if (!/^[\w.-]+$/.test(key)) {
      out.errors.push({ line, message: tr("\"{k}\" isn't a parameter name", { k: key }) });
      return;
    }
    const { value, error } = cleanValue(rest);
    if (error) out.errors.push({ line, message: error });
    if (!value) {
      out.errors.push({ line, message: tr("{k} has no value; delete the line to go back to the default", { k: key }) });
      return;
    }
    const name = canonical(key);
    if (name in out.values) {
      out.errors.push({ line, message: tr("{k} is already set on line {n}", { k: name, n: out.lines[name] }) });
      return;
    }
    if (catalog?.length && !known.has(name.toLowerCase())) out.warnings.push({ line, message: tr("{k} isn't in the catalog of this version: DBaaS will refuse it", { k: name }) });
    out.values[name] = value;
    out.lines[name] = line;
  });
  return out;
}

/** Parameters as text, sorted by name. */
export function toConf(values: Record<string, string>) {
  return Object.keys(values)
    .sort((a, b) => a.localeCompare(b))
    .map((k) => `${k} = ${/^\s|\s$|\s#|^['"]/.test(values[k]) ? `'${values[k].replace(/'/g, "''")}'` : values[k]}`)
    .join("\n");
}

/** Form or text. */
export function ModeSwitch({ value, onChange }: { value: "form" | "text"; onChange: (v: "form" | "text") => void }) {
  return (
    <div role="radiogroup" aria-label={tr("Edit as")} className="inline-flex rounded-md border border-line p-0.5 text-xs">
      {(
        [
          ["form", tr("Form"), "list-checks"],
          ["text", tr("Text"), "file-code"],
        ] as const
      ).map(([id, label, icon]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          onClick={() => onChange(id)}
          className={cn("inline-flex items-center gap-1 rounded px-2 py-1", value === id ? "bg-cable/15 text-ink" : "text-muted hover:text-ink")}
        >
          <Icon name={icon} className="size-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}

/** Text area with line numbers; the lines with a problem are marked. */
export function ConfEditor({
  value,
  onChange,
  parsed,
  serverErrors = {},
  placeholder,
  rows = 12,
}: {
  value: string;
  onChange: (v: string) => void;
  parsed: ParsedConf;
  /** Messages per parameter from dbaas-api, shown at the parameter's line. */
  serverErrors?: Record<string, string>;
  placeholder?: string;
  rows?: number;
}) {
  const gutter = useRef<HTMLDivElement>(null);
  const n = Math.max(rows, value.split("\n").length);
  const bad = new Set(parsed.errors.map((e) => e.line));
  const warn = new Set(parsed.warnings.map((e) => e.line));
  const fromServer: ConfLine[] = Object.entries(serverErrors).map(([k, m]) => ({ line: parsed.lines[k] ?? 0, message: `${k}: ${m}` }));
  for (const e of fromServer) if (e.line) bad.add(e.line);
  const notes = [...parsed.errors.map((e) => ({ ...e, tone: "err" })), ...fromServer.filter((e) => e.line).map((e) => ({ ...e, tone: "err" })), ...parsed.warnings.map((e) => ({ ...e, tone: "warn" }))].sort((a, b) => a.line - b.line);

  return (
    <div className="space-y-2">
      <div className="flex overflow-hidden rounded-md border border-line bg-panel focus-within:border-cable">
        <div ref={gutter} aria-hidden className="select-none overflow-hidden border-r border-line bg-ink/[0.03] py-2 text-right font-mono text-[12.5px] leading-5 text-muted" style={{ height: `calc(${rows} * 1.25rem + 1rem)` }}>
          {Array.from({ length: n }, (_, i) => (
            <div key={i} className={cn("px-2", bad.has(i + 1) ? "bg-led-red/15 text-led-red" : warn.has(i + 1) && "bg-led-amber/15 text-led-amber")}>
              {i + 1}
            </div>
          ))}
        </div>
        <textarea
          aria-label={tr("Parameters, one per line")}
          spellCheck={false}
          wrap="off"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => gutter.current && (gutter.current.scrollTop = e.currentTarget.scrollTop)}
          onKeyDown={(e) => {
            // Tab indents (nested mongod.conf keys) instead of leaving the field.
            if (e.key !== "Tab" || e.shiftKey) return;
            e.preventDefault();
            const t = e.currentTarget;
            const { selectionStart: s, selectionEnd: end } = t;
            onChange(value.slice(0, s) + "  " + value.slice(end));
            requestAnimationFrame(() => t.setSelectionRange(s + 2, s + 2));
          }}
          className="min-w-0 flex-1 resize-none bg-transparent px-3 py-2 font-mono text-[12.5px] leading-5 outline-none"
          style={{ height: `calc(${rows} * 1.25rem + 1rem)` }}
        />
      </div>
      {notes.length > 0 && (
        <ul className="max-h-32 space-y-0.5 overflow-y-auto text-xs">
          {notes.map((e, i) => (
            <li key={i} className={e.tone === "err" ? "text-led-red" : "text-led-amber"}>
              {tr("Line {n}", { n: e.line })}: {e.message}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
        <span>{tr("One \"name = value\" per line; # starts a comment. A postgresql.conf, my.cnf or mongod.conf can be pasted as is.")}</span>
        <label className="inline-flex cursor-pointer items-center gap-1 text-cable hover:underline">
          <Icon name="upload" className="size-3.5" />
          {tr("Load from a file")}
          <input
            type="file"
            accept=".conf,.cnf,.ini,.yaml,.yml,.txt,text/plain"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) onChange(await f.text());
              e.target.value = "";
            }}
          />
        </label>
      </div>
    </div>
  );
}
