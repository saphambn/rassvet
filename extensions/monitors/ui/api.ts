/**
 * The Monitors extension's API (`/api/ext/monitors/...`): who may see what, the dashboards and
 * panels defined in the cloud's YAML panel files, what can be picked on a dashboard, and the
 * data of one panel. The server fills every PromQL template and scopes a project user's
 * `$project_id` to their own project.
 */
import { type Range, type Series, type Unit, api, useQuery } from "@rassvet/sdk";

export const BASE = "/ext/monitors";

export type Kind = "instance" | "physical";
export type ChartType = "time_series" | "pie_chart" | "stat" | "gauge";
export type { Range, Series, Unit } from "@rassvet/sdk";

export interface Info {
  admin: boolean;
  /** How far back the session may look. */
  max_range_days: number;
  project: { id: string; name: string } | null;
  region: string | null;
}

export interface Panel {
  name: string;
  title: string;
  description?: string;
  unit: Unit;
  width: "half" | "full";
  min?: number;
  max?: number;
  /** `target`: needs a picked instance / server; `overview`: the project / fleet. */
  scope: "target" | "overview";
  queries: { type: ChartType; unit: Unit }[];
  /** Legend rows shown before the legend scrolls. */
  legend_rows: number;
}

export interface Dashboard {
  id: string;
  title: string;
  kind: Kind;
  /** The dashboard's variables; `query` ones (label_values) are picked on the page. */
  variables: { name: string; query: boolean }[];
  /** Show Rassvet's instance / server picker; off when the dashboard picks servers with its own variables. */
  server_picker: boolean;
  panels: Panel[];
}

/** A query variable resolved by the server: its values and the one in use. */
export interface ResolvedVar {
  name: string;
  values: string[];
  value: string;
}

export interface GuestItem {
  guest_id: string;
  guest_name: string;
  project_id: string;
  project_name: string;
}

export interface HostItem {
  compute_node_id: string;
  hostname: string;
  region: string;
}

export type Targets = { kind: "instance"; guests: GuestItem[] } | { kind: "physical"; hosts: HostItem[] };

/** `values` of a series: [unix seconds, value]; one point for stat, gauge and pie chart queries. */

export interface PanelData {
  start: number;
  end: number;
  step: number;
  /** `unit`: of a stat, gauge or pie chart query; a time series chart uses the panel's. */
  results: { type: ChartType; unit: Unit; series: Series[] }[];
  /** Quiet time series left out of the chart. */
  hidden: number;
}


const qs = (p: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  return s.toString();
};

export const useInfo = () =>
  useQuery({ queryKey: ["monitors", "info"], queryFn: () => api.get<Info>(`${BASE}/info`), staleTime: 300_000 });

/** Panel files are re-read by the server when they change: refresh every few minutes. */
export const useDashboards = (kind: Kind, enabled = true) =>
  useQuery({
    queryKey: ["monitors", "dashboards", kind],
    queryFn: () => api.get<Dashboard[]>(`${BASE}/dashboards?${qs({ kind })}`),
    staleTime: 120_000,
    enabled,
  });

/** Lists only change as instances come and go: keep them a minute, keyed by whole hours. */
const listKey = (r: Range) => [Math.floor(r.start / 3600), Math.floor(r.end / 3600)];

export const useTargets = (dashboard: string | undefined, range: Range) =>
  useQuery({
    queryKey: ["monitors", "targets", dashboard, listKey(range)],
    queryFn: () => api.get<Targets>(`${BASE}/targets?${qs({ dashboard, ...range })}`),
    staleTime: 60_000,
    enabled: !!dashboard,
  });

/** What a panel is drawn for. */
export interface Target {
  project_id?: string;
  guest_id?: string;
  compute_node_id?: string;
  hostname?: string;
  /** Values of the dashboard's query variables. */
  vars?: Record<string, string>;
}

/** `{a: "1"}` → `{"var-a": "1"}` */
const varParams = (vars: Record<string, string> | undefined) =>
  Object.fromEntries(Object.entries(vars ?? {}).map(([k, v]) => [`var-${k}`, v]));

/**
 * Resolve the dashboard's query variables from the picked values (`picked`, by name): the
 * server lists each one's values in order, keeping a picked value when it is listed.
 */
export const useVariables = (dashboard: Dashboard | undefined, picked: Record<string, string>, target: Target, range: Range) => {
  const enabled = !!dashboard && dashboard.variables.some((v) => v.query);
  return useQuery({
    queryKey: ["monitors", "variables", dashboard?.id, picked, target, listKey(range)],
    queryFn: () =>
      api.get<ResolvedVar[]>(
        `${BASE}/variables?${qs({
          dashboard: dashboard!.id,
          project_id: target.project_id,
          guest_id: target.guest_id,
          compute_node_id: target.compute_node_id,
          hostname: target.hostname,
          ...varParams(picked),
          ...range,
        })}`,
      ),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
    enabled,
  });
};

export const usePanelData = (dashboard: string, panel: string, target: Target, range: Range) =>
  useQuery({
    queryKey: ["monitors", "panel", dashboard, panel, target, range],
    queryFn: ({ signal }) => {
      const { vars, ...rest } = target;
      return api.get<PanelData>(`${BASE}/query?${qs({ dashboard, panel, ...rest, ...varParams(vars), ...range })}`, { signal });
    },
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
