/** The panel grid of a dashboard for one target (or the overview) and the time range bar. */
import { useEffect, useState } from "react";
import { Button, Card, Chart, ErrorNotice, Field, Icon, Input, Picker, cn, tr } from "@rassvet/sdk";
import {
  type ChartType,
  type Dashboard,
  type Panel,
  type Range,
  type ResolvedVar,
  type Series,
  type Target,
  type Unit,
  usePanelData,
  useVariables,
} from "./api";
import { type RangeSpec, formatSpec, fromLocalInput, presetsFor, toLocalInput } from "./range";
import { Gauges, Pie, Stats } from "./Viz";

export function PanelGrid({
  dashboard,
  panels,
  target,
  range,
}: {
  dashboard: string;
  panels: Panel[];
  target: Target;
  range: Range;
}) {
  if (!panels.length) return <p className="text-sm text-muted">{tr("This dashboard has no panels for this view.")}</p>;
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {panels.map((p) => (
        <PanelCard key={p.name} dashboard={dashboard} panel={p} target={target} range={range} />
      ))}
    </div>
  );
}

/** Single values first, then the time series chart, then pie charts. */
const ORDER: ChartType[] = ["stat", "gauge", "time_series", "pie_chart"];

/** 0-1 values are drawn as percentages. */
function normalize(unit: Unit, series: Series[]): [Unit, Series[]] {
  if (unit !== "percent_unit") return [unit, series];
  return ["percent", series.map((s) => ({ ...s, values: s.values.map(([t, v]) => [t, v * 100] as [number, number]) }))];
}

/** One block per run of queries of the same type and unit (all time series share one chart). */
interface Block {
  type: ChartType;
  unit: Unit;
  series: Series[];
}

function blocks(panel: Panel, results: { type: ChartType; unit: Unit; series: Series[] }[]): Block[] {
  const out: Block[] = [];
  for (const type of ORDER) {
    for (const r of results.filter((r) => r.type === type)) {
      const [unit, series] = normalize(type === "time_series" ? panel.unit : r.unit, r.series);
      const prev = out.at(-1);
      if (prev && prev.type === type && (type === "time_series" || prev.unit === unit)) prev.series.push(...series);
      else out.push({ type, unit, series: [...series] });
    }
  }
  return out.filter((b) => b.series.length);
}

function PanelCard({ dashboard, panel, target, range }: { dashboard: string; panel: Panel; target: Target; range: Range }) {
  const q = usePanelData(dashboard, panel.name, target, range);
  const list = q.data ? blocks(panel, q.data.results) : [];
  const pct = panel.unit === "percent_unit" ? 100 : 1;

  return (
    <Card
      className={cn(panel.width === "full" && "xl:col-span-2")}
      title={<span title={panel.description}>{panel.title}</span>}
      actions={q.isFetching ? <Icon name="refresh" className="size-3.5 animate-spin text-muted" /> : undefined}
    >
      {panel.description && <p className="-mt-1 mb-3 text-xs text-muted">{panel.description}</p>}
      {q.error ? (
        <ErrorNotice error={q.error} />
      ) : !q.data ? (
        <div className="h-[190px] animate-pulse rounded-md bg-surface" />
      ) : list.length === 0 ? (
        <p className="flex h-[120px] items-center justify-center text-sm text-muted">{tr("No data in this time range")}</p>
      ) : (
        <div className="space-y-4">
          {list.map((b, i) => {
            switch (b.type) {
              case "stat":
                return <Stats key={i} series={b.series} unit={b.unit} />;
              case "gauge":
                return (
                  <Gauges
                    key={i}
                    series={b.series}
                    unit={b.unit}
                    min={panel.min == null ? undefined : panel.min * pct}
                    max={panel.max == null ? undefined : panel.max * pct}
                  />
                );
              case "pie_chart":
                return <Pie key={i} series={b.series} unit={b.unit} legendRows={panel.legend_rows} />;
              default:
                return (
                  <div key={i}>
                    <Chart
                      series={b.series}
                      unit={b.unit}
                      range={{ start: q.data!.start, end: q.data!.end }}
                      step={q.data!.step}
                      legendRows={panel.legend_rows}
                    />
                    {q.data!.hidden > 0 && (
                      <p className="mt-2 text-xs text-muted">{tr("{n} quieter series not shown", { n: q.data!.hidden })}</p>
                    )}
                  </div>
                );
            }
          })}
        </div>
      )}
    </Card>
  );
}

/** `var-<name>` URL parameters → `{name: value}`. */
export function pickedVars(params: URLSearchParams) {
  const out: Record<string, string> = {};
  params.forEach((v, k) => {
    if (k.startsWith("var-") && v) out[k.slice(4)] = v;
  });
  return out;
}

/**
 * The dashboard's query variables, resolved from the picked values in the URL. `vars` is
 * undefined while they load (panels wait for them), `{}` when there are none.
 */
export function useDashboardVars(dash: Dashboard | undefined, params: URLSearchParams, target: Target, range: Range) {
  const picked = pickedVars(params);
  const q = useVariables(dash, picked, target, range);
  const hasVars = !!dash?.variables.some((v) => v.query);
  const vars = !hasVars ? {} : q.data ? Object.fromEntries(q.data.map((v) => [v.name, v.value])) : undefined;
  return { resolved: q.data ?? [], vars, error: q.error, loading: q.isLoading };
}

/** One dropdown per query variable, like Grafana's template variables. */
export function VariableBar({
  resolved,
  loading,
  onChange,
}: {
  resolved: ResolvedVar[];
  loading: boolean;
  onChange: (name: string, value: string) => void;
}) {
  return (
    <>
      {resolved.map((v) => (
        <Field key={v.name} label={v.name}>
          {(id) => (
            <Picker
              id={id}
              className="w-56"
              value={v.value}
              onChange={(x) => onChange(v.name, x)}
              loading={loading}
              searchable
              emptyText={tr("No values in this time range")}
              options={v.values.map((x) => ({ value: x, label: x }))}
            />
          )}
        </Field>
      ))}
    </>
  );
}

/** Picks one of several dashboards of a kind (hidden when there is only one). */
export function DashboardPicker({ list, value, onChange }: { list: Dashboard[]; value: string; onChange: (id: string) => void }) {
  if (list.length < 2) return null;
  return (
    <Field label={tr("Dashboard")}>
      {(id) => (
        <Picker
          id={id}
          className="w-56"
          value={value}
          onChange={onChange}
          options={list.map((d) => ({ value: d.id, label: d.title, description: d.title !== d.id ? d.id : undefined, icon: "layout-dashboard" }))}
        />
      )}
    </Field>
  );
}

const CUSTOM = "custom";

/** Preset ranges within the session's limit, a custom from / to, and refresh. */
export function RangeBar({
  spec,
  maxDays,
  onChange,
  onRefresh,
}: {
  spec: RangeSpec;
  maxDays: number;
  onChange: (s: RangeSpec) => void;
  onRefresh: () => void;
}) {
  const isCustom = !("preset" in spec);
  const [custom, setCustom] = useState(isCustom);
  const now = Math.floor(Date.now() / 1000);
  const [from, setFrom] = useState(toLocalInput(isCustom ? spec.start : now - 86400));
  const [to, setTo] = useState(toLocalInput(isCustom ? spec.end : now));
  useEffect(() => setCustom(isCustom), [isCustom]);

  const start = fromLocalInput(from);
  const end = fromLocalInput(to);
  const oldest = now - maxDays * 86400;
  const problem =
    start === null || end === null
      ? tr("Enter a start and an end")
      : start >= end
        ? tr("The end must be after the start")
        : start < oldest
          ? tr("You can look back at most {n} days", { n: maxDays })
          : null;

  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label={tr("Time range")}>
        {(id) => (
        <Picker
          id={id}
          className="w-52"
          value={custom ? CUSTOM : formatSpec(spec)}
          onChange={(v) => {
            if (v === CUSTOM) return setCustom(true);
            setCustom(false);
            const p = presetsFor(maxDays).find((x) => x.id === v);
            if (p) onChange({ preset: p });
          }}
          options={[
            ...presetsFor(maxDays).map((p) => ({ value: p.id, label: p.label })),
            { value: CUSTOM, label: tr("Custom range…"), icon: "history" },
          ]}
        />
        )}
      </Field>
      {custom && (
        <>
          <Field label={tr("From")}>
            {(id) => <Input id={id} type="datetime-local" value={from} min={toLocalInput(oldest)} onChange={(e) => setFrom(e.target.value)} />}
          </Field>
          <Field label={tr("To")}>
            {(id) => <Input id={id} type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />}
          </Field>
          <Button disabled={!!problem} title={problem ?? undefined} onClick={() => start !== null && end !== null && onChange({ start, end })}>
            {tr("Apply")}
          </Button>
        </>
      )}
      <Button onClick={onRefresh} title={tr("Refresh")} aria-label={tr("Refresh")}>
        <Icon name="refresh" />
      </Button>
      {custom && problem && <p className="basis-full text-xs text-muted">{problem}</p>}
    </div>
  );
}

/** "Now" for preset ranges: moves on every minute and on refresh. */
export function useNow() {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 60_000);
    return () => clearInterval(t);
  }, []);
  return [now, () => setNow(Date.now() / 1000)] as const;
}

