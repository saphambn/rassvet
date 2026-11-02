/**
 * Nova, Neutron, Cinder and Placement through Rassvet's allowlisted gateway
 * (`/api/os/{service}/{path}`): helpers, types and query hooks.
 */
import { type QueryClient, keepPreviousData, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Status } from "@/components/ui";
import { ApiError, api } from "./api";
import { limiter } from "./limiter";
import { usePref } from "./prefs";
import { findFilter, useFindParam } from "./useTab";
import { lang, tr } from "@/lib/i18n";

/** Core services, or `ext:<id>` for an extension's own allowlisted gateway (`/api/ext/<id>/os/...`). */
export type Svc = "compute" | "network" | "volume" | "placement" | "identity" | "image" | "key-manager" | `ext:${string}`;

/** Query parameters; an array repeats the parameter (OpenStack APIs read that as "any of"). */
type Query = Record<string, string | number | boolean | string[] | undefined | null>;

function qs(q?: Query) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q ?? {})) {
    if (Array.isArray(v)) for (const x of v) p.append(k, x);
    else if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");
const url = (svc: Svc, path: string, q?: Query) =>
  svc.startsWith("ext:") ? `/ext/${svc.slice(4)}/os/${enc(path)}${qs(q)}` : `/os/${svc}/${enc(path)}${qs(q)}`;

export const os = {
  get: <T>(svc: Svc, path: string, q?: Query, opts?: { signal?: AbortSignal }) => api.get<T>(url(svc, path, q), opts),
  /** GET a list following every page; returns the array under `key`. */
  list: <T>(svc: Svc, path: string, key: string, q?: Query) =>
    api.get<Record<string, unknown>>(url(svc, path, { ...q, all_pages: 1 })).then((r) => (r[key] ?? []) as T[]),
  post: <T>(svc: Svc, path: string, body?: object) => api.post<T>(url(svc, path), body as never),
  put: <T>(svc: Svc, path: string, body?: object) => api.put<T>(url(svc, path), body as never),
  patch: <T>(svc: Svc, path: string, body?: object) => api.patch<T>(url(svc, path), body as never),
  del: (svc: Svc, path: string, q?: Query, body?: object) => api.del<void>(url(svc, path, q), body as never),
  /** `POST .../action` with a single action key, e.g. `{ "os-start": null }`. */
  action: <T = unknown>(svc: Svc, path: string, body: object) => api.post<T>(url(svc, `${path}/action`), body as never),
};

/** Refresh every cached query of these services after a change. */
export function invalidate(qc: QueryClient, ...svcs: Svc[]) {
  for (const s of svcs) qc.invalidateQueries({ queryKey: ["os", s] });
}
export const useInvalidate = () => {
  const qc = useQueryClient();
  return (...svcs: Svc[]) => invalidate(qc, ...svcs);
};

/**
 * Lists whose APIs accept `limit` (Nova, Neutron, Cinder collections). For these the
 * first rows are fetched with a small `limit` and shown at once while the full list
 * (every page) loads, so big projects don't stare at a spinner.
 */
const PROGRESSIVE = new Set([
  "compute servers/detail",
  "compute flavors/detail",
  "network networks",
  "network subnets",
  "network ports",
  "network routers",
  "network floatingips",
  "network security-groups",
  "network trunks",
  "volume volumes/detail",
  "volume snapshots/detail",
  "volume backups/detail",
]);
const FIRST_PAGE = 25;

/** Overrides the default retry of a query, e.g. for an error a service is known to return for a while. */
export interface RetryOpts {
  retry?: (failures: number, error: Error) => boolean;
  retryDelay?: number;
}

const retryOpts = (o: RetryOpts) => ({
  ...(o.retry ? { retry: o.retry } : {}),
  ...(o.retryDelay !== undefined ? { retryDelay: o.retryDelay } : {}),
});

/** Shared list hook; `poll` refetches every 4 s while it returns true. `partial` = only the first rows so far. */
export function useOsList<T>(
  svc: Svc,
  path: string,
  key: string,
  q?: Query,
  opts: { enabled?: boolean; poll?: (rows: T[]) => boolean } & RetryOpts = {},
) {
  const enabled = opts.enabled ?? true;
  const full = useQuery({
    queryKey: ["os", svc, path, q ?? {}],
    queryFn: () => os.list<T>(svc, path, key, q),
    enabled,
    refetchInterval: (query) => (opts.poll && query.state.data && opts.poll(query.state.data) ? 4000 : false),
    ...retryOpts(opts),
  });
  const progressive = PROGRESSIVE.has(`${svc} ${path}`) && !q?.limit;
  const first = useQuery({
    queryKey: ["os", svc, path, q ?? {}, "first"],
    queryFn: () => os.get<Record<string, unknown>>(svc, path, { ...q, limit: FIRST_PAGE }).then((r) => (r[key] ?? []) as T[]),
    enabled: enabled && progressive && full.isPending,
    staleTime: 30_000,
  });
  const partial = full.data === undefined && first.data !== undefined;
  // A new object: react-query's tracked result has read-only getters.
  return {
    ...full,
    data: full.data ?? (partial ? first.data : undefined),
    isPending: full.isPending && !partial,
    partial,
  } as typeof full & { partial: boolean };
}

/** A server-side filter of a paged list: a text box, or a picker when it has options. */
export interface ServerFilter {
  key: string;
  label: string;
  /** Query parameter the value goes to, or a function building the parameters. */
  param: string | ((v: string) => Query);
  /**
   * Picker choices. A choice with `input` also shows a text box once picked; the filter
   * value is then `<choice>\t<text>` (see `splitChoice`).
   */
  options?: { value: string; label: string; description?: string; input?: { placeholder?: string } }[];
  placeholder?: string;
  /**
   * Work out the query parameters asynchronously (e.g. look other resources up first);
   * `null` = nothing can match (no rows, no list call). Takes precedence over `param`.
   */
  resolve?: (v: string) => Promise<Query | null>;
  /** Look the value up as an ID instead (`GET <path>`), for APIs that can't filter on IDs. */
  byId?: (v: string) => { path: string; key: string };
  /**
   * Match in the browser instead, for what the API can't filter (e.g. a regex on Neutron
   * names): the whole list (other query + sort) is fetched once, filtered here and paged locally.
   */
  client?: (row: never, v: string) => boolean;
  /**
   * Like `client`, but only once the API refuses `param` (HTTP 400): e.g. Cinder's `name~`,
   * which needs microversion 3.34 and a `name` entry in the cloud's resource filters.
   */
  fallback?: (row: never, v: string) => boolean;
}

/** Filters an API refused (`<svc> <path> <filter key>`): they're matched in the browser from then on. */
const refused = new Set<string>();

/** `"instance\tweb-.*"` → `["instance", "web-.*"]` (a picker choice and its text box). */
export const splitChoice = (v: string): [string, string] => {
  const i = v.indexOf("\t");
  return i < 0 ? [v, ""] : [v.slice(0, i), v.slice(i + 1)];
};

/** How each service spells "sort by": Nova / Neutron sort_key + sort_dir, Cinder sort=key:dir. */
function sortQuery(svc: Svc, key: string, dir: 1 | -1): Query {
  const d = dir === 1 ? "asc" : "desc";
  return svc === "volume" || svc === "key-manager" || svc.startsWith("ext:") ? { sort: `${key}:${d}` } : { sort_key: key, sort_dir: d };
}

/**
 * One page at a time from a marker-paginated API (Nova, Neutron, Cinder): `limit` is the
 * table's rows per page and `marker` the last row of the previous page, so huge lists are
 * never fetched whole. `filters` become server-side filters (field picker + value in the
 * table toolbar) and `sort` maps column keys to the API's sort keys (other columns can't
 * be sorted, since only one page is loaded).
 */
/**
 * Paged lists loaded in two steps: the light list (`GET servers`, `GET volumes`, … with the
 * same filters, sort and marker; only id + name per row) is shown at once, then each row's
 * detail (`GET servers/{id}`, …) is fetched on its own, a few at a time, and every row fills
 * in as soon as its own call returns. Busy rows are polled one by one.
 */
const SPLIT: Record<string, { list: string; one: string }> = {
  "compute servers/detail": { list: "servers", one: "server" },
  "volume volumes/detail": { list: "volumes", one: "volume" },
  "volume snapshots/detail": { list: "snapshots", one: "snapshot" },
  "volume backups/detail": { list: "backups", one: "backup" },
};
/** Shared by every per-row detail call; priority = row position, so top rows come first. */
const rowSlot = limiter(6);
const rowQueryKey = (svc: Svc, list: string, id: string) => ["os", svc, list, "row", id];

/** Where a row of a two-step list stands: details still loading, or failed (the message). */
export type RowState = "pending" | { error: string } | undefined;

export function useOsPaged<T extends { id: string }>(
  svc: Svc,
  path: string,
  key: string,
  q: Query = {},
  opts: { filters?: ServerFilter[]; sort?: Record<string, string>; tableId?: string; poll?: (rows: T[]) => boolean; enabled?: boolean } = {},
) {
  const sizeKey = opts.tableId ? `rassvet.table.${opts.tableId}.pageSize` : undefined;
  const [pageSize, setPageSizeState] = useState<number>(() => {
    try {
      return (sizeKey && Number(JSON.parse(localStorage.getItem(sizeKey) ?? "0"))) || 20;
    } catch {
      return 20;
    }
  });
  const [markers, setMarkers] = useState<(string | undefined)[]>([undefined]);
  // The last filter and sort of this table come back when the user returns to the page.
  const [saved, save] = usePref<{ filter?: { key: string; value: string }; sort?: { key: string; dir: 1 | -1 } | null }>(opts.tableId && `paged.${opts.tableId}`);
  const known = (k?: string) => !!k && !!opts.filters?.some((f) => f.key === k);
  const find = useFindParam();
  const [filter, setFilterState] = useState<{ key: string; value: string }>(
    () => findFilter(find, opts.filters) ?? (known(saved?.filter?.key) ? saved!.filter! : { key: opts.filters?.[0]?.key ?? "", value: "" }),
  );
  const [sort, setSortState] = useState<{ key: string; dir: 1 | -1 } | null>(() => (saved?.sort && opts.sort?.[saved.sort.key] ? saved.sort : null));
  const page = markers.length - 1;
  const split = SPLIT[`${svc} ${path}`];
  const listPath = split ? split.list : path;
  const def = opts.filters?.find((f) => f.key === filter.key);
  const value = filter.value.trim();
  const qc = useQueryClient();
  const lookup = def?.byId && value ? def.byId(value) : null;
  const refusedKey = `${svc} ${listPath} ${def?.key}`;
  const match = !value ? null : (def?.client ?? (def?.fallback && refused.has(refusedKey) ? def.fallback : null));
  const resolve = def?.resolve && value && !lookup && !match ? def.resolve : null;
  const fq: Query = def && value && !lookup && !match && !resolve ? (typeof def.param === "string" ? { [def.param]: value } : def.param(value)) : {};
  const sq: Query = sort && opts.sort?.[sort.key] ? sortQuery(svc, opts.sort[sort.key], sort.dir) : {};
  const query = useQuery({
    queryKey: ["os", svc, listPath, "paged", q, pageSize, match ? page : markers[page], fq, sq, lookup?.path, (match || resolve) && value],
    queryFn: async () => {
      /** The whole list, fetched once, matched and paged here. */
      const inBrowser = async (m: (row: never, v: string) => boolean, at: number) => {
        const all = await qc.fetchQuery({
          queryKey: ["os", svc, listPath, "all", q, sq],
          queryFn: () => os.list<T>(svc, listPath, key, { ...q, ...sq }),
          staleTime: 30_000,
        });
        const hits = all.filter((r) => m(r as never, value));
        return { rows: hits.slice(at * pageSize, (at + 1) * pageSize), hasNext: hits.length > (at + 1) * pageSize };
      };
      if (match) return inBrowser(match, page);
      if (lookup) {
        // One item by ID; not found (or another project's, in a project view) = no rows.
        const one = await os
          .get<Record<string, unknown>>(svc, lookup.path)
          .then((r) => r[lookup.key] as T & { project_id?: string; tenant_id?: string })
          .catch((e) => {
            if (e?.status === 404 || e?.status === 400) return undefined;
            throw e;
          });
        const owner = one && (one.project_id ?? one.tenant_id);
        const wrongProject = one && q.project_id && owner && owner !== q.project_id;
        // Already the full item: the row's detail query starts from it.
        if (one && !wrongProject && split) qc.setQueryData(rowQueryKey(svc, split.list, one.id), one);
        return { rows: one && !wrongProject ? [one as T] : [], hasNext: false };
      }
      // Ask for one row more than shown: OpenStack APIs add a "next" link whenever a page
      // is full, even when nothing follows (40 rows at 20 per page gave an empty 3rd page).
      // The extra row only tells whether another page exists; the marker stays the last shown row.
      let rq = fq;
      if (resolve) {
        const got = await qc.fetchQuery({ queryKey: ["os", svc, listPath, "resolve", def!.key, value], queryFn: () => resolve(value), staleTime: 30_000 });
        if (!got) return { rows: [], hasNext: false };
        rq = got;
      }
      let r: Record<string, unknown>;
      try {
        r = await os.get<Record<string, unknown>>(svc, listPath, { ...q, ...rq, ...sq, limit: pageSize + 1, marker: markers[page] });
      } catch (e) {
        // The API refused the filter: match in the browser, now and from then on.
        if (!def?.fallback || !(e instanceof ApiError) || e.status !== 400) throw e;
        refused.add(refusedKey);
        return inBrowser(def.fallback, 0);
      }
      const got = (r[key] ?? []) as T[];
      return { rows: got.slice(0, pageSize), hasNext: got.length > pageSize };
    },
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
    // Two-step lists poll busy rows one by one (below) instead of the whole page.
    refetchInterval: (qq) => (!split && opts.poll && qq.state.data && opts.poll(qq.state.data.rows) ? 4000 : false),
  });
  const listRows = query.data?.rows;
  const details = useQueries({
    queries: (split ? (listRows ?? []) : []).map((row, i) => ({
      queryKey: rowQueryKey(svc, split!.list, row.id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        rowSlot(
          () =>
            os
              .get<Record<string, unknown>>(svc, `${split!.list}/${row.id}`, undefined, { signal })
              .then((r) => r[split!.one] as T)
              // Deleted since the list was read: the row is dropped.
              .catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e))),
          { signal, priority: i },
        ),
      retry: false,
      staleTime: 15_000,
      refetchInterval: (qq: { state: { data?: T | null } }) => (opts.poll && qq.state.data && opts.poll([qq.state.data]) ? 4000 : false),
    })),
  });
  const states = new Map<string, RowState>();
  const rows = !split
    ? listRows
    : listRows?.flatMap((row, i) => {
        const d = details[i];
        if (d?.data === null) return [];
        if (d?.data) return [d.data];
        states.set(row.id, d?.error ? { error: d.error instanceof Error ? d.error.message : String(d.error) } : "pending");
        return [row];
      });
  const failed = [...states.values()].filter((x) => x && x !== "pending").length;
  const detailsFetching = details.some((d) => d.isFetching);
  const refetch = () => {
    if (split) qc.invalidateQueries({ queryKey: ["os", svc, split.list, "row"] });
    return query.refetch();
  };
  const reset = () => setMarkers([undefined]);
  return {
    query,
    rows,
    refetch,
    fetching: query.isFetching || detailsFetching,
    remote: {
      rowState: split ? (id: string) => states.get(id) : undefined,
      details: split
        ? {
            loaded: (rows?.length ?? 0) - states.size + failed,
            total: rows?.length ?? 0,
            failed,
            retry: () =>
              qc.refetchQueries({ predicate: (qq) => qq.state.status === "error" && qq.queryKey[1] === svc && qq.queryKey[2] === split.list && qq.queryKey[3] === "row" }),
          }
        : undefined,
      page,
      hasNext: !!query.data?.hasNext,
      pageSize,
      fetching: query.isFetching,
      onPageSize: (n: number) => {
        setPageSizeState(n);
        reset();
      },
      onNext: () => rows?.length && setMarkers((m) => [...m, rows[rows.length - 1].id]),
      onPrev: () => setMarkers((m) => (m.length > 1 ? m.slice(0, -1) : m)),
      onFirst: reset,
      filters: opts.filters?.map(({ key, label, options, placeholder }) => ({ key, label, options, placeholder })),
      filter,
      onFilter: (k: string, v: string) => {
        if (filter.key === k && filter.value === v) return;
        setFilterState({ key: k, value: v });
        reset();
        save({ filter: { key: k, value: v }, sort });
      },
      sort,
      sortable: opts.sort ? Object.keys(opts.sort) : undefined,
      onSort: opts.sort
        ? (s: { key: string; dir: 1 | -1 } | null) => {
            setSortState(s);
            reset();
            save({ filter, sort: s });
          }
        : undefined,
    },
  };
}

export function useOsGet<T>(
  svc: Svc,
  path: string,
  pick: (r: never) => T,
  opts: { enabled?: boolean; poll?: (v: T) => boolean; q?: Query } & RetryOpts = {},
) {
  return useQuery({
    queryKey: ["os", svc, path, opts.q ?? {}],
    queryFn: () => os.get<never>(svc, path, opts.q).then(pick),
    enabled: opts.enabled ?? true,
    refetchInterval: (query) => (opts.poll && query.state.data && opts.poll(query.state.data) ? 4000 : false),
    ...retryOpts(opts),
  });
}

// =========================================================================== Nova

export interface Address {
  addr: string;
  version: number;
  "OS-EXT-IPS:type"?: "fixed" | "floating";
  "OS-EXT-IPS-MAC:mac_addr"?: string;
}

export interface Server {
  id: string;
  name: string;
  status: string;
  description?: string | null;
  "OS-EXT-STS:task_state"?: string | null;
  "OS-EXT-STS:vm_state"?: string;
  "OS-EXT-STS:power_state"?: number;
  "OS-EXT-AZ:availability_zone"?: string;
  "OS-EXT-SRV-ATTR:host"?: string | null;
  "OS-EXT-SRV-ATTR:hypervisor_hostname"?: string | null;
  "OS-EXT-SRV-ATTR:instance_name"?: string;
  "OS-EXT-SRV-ATTR:hostname"?: string;
  "OS-EXT-SRV-ATTR:root_device_name"?: string | null;
  "OS-EXT-SRV-ATTR:launch_index"?: number;
  /** base64 cloud-init user data (2.3+, admin-only by default policy); absent when not allowed. */
  "OS-EXT-SRV-ATTR:user_data"?: string | null;
  "OS-SRV-USG:launched_at"?: string | null;
  "OS-DCF:diskConfig"?: string;
  hostId?: string;
  host_status?: string;
  config_drive?: string;
  pinned_availability_zone?: string | null;
  /** 2.71+: ids of the server groups the instance belongs to. */
  server_groups?: string[];
  "os-extended-volumes:volumes_attached"?: { id: string; delete_on_termination?: boolean }[];
  addresses: Record<string, Address[]>;
  flavor: {
    original_name?: string;
    id?: string;
    vcpus?: number;
    ram?: number;
    disk?: number;
    ephemeral?: number;
    swap?: number;
    extra_specs?: Record<string, string>;
  };
  image: "" | { id: string };
  key_name?: string | null;
  security_groups?: { name: string }[];
  metadata?: Record<string, string>;
  locked?: boolean;
  tenant_id: string;
  user_id: string;
  created: string;
  updated: string;
  /** 2.26+: free-form tags (no "/" or ","; Nova filters lists by them). */
  tags?: string[];
  /** Set by Nova on ERROR (and DELETED) instances; `details` (traceback) only for admins by default. */
  fault?: { message: string; code: number; details?: string; created?: string };
}

export interface Flavor {
  id: string;
  name: string;
  vcpus: number;
  ram: number;
  disk: number;
  swap?: number | "";
  "OS-FLV-EXT-DATA:ephemeral"?: number;
  "os-flavor-access:is_public"?: boolean;
  description?: string | null;
  extra_specs?: Record<string, string>;
  rxtx_factor?: number;
}

export interface Keypair {
  name: string;
  fingerprint: string;
  type?: string;
  public_key: string;
}

export const SERVER_BUSY = new Set([
  "BUILD", "REBOOT", "HARD_REBOOT", "RESIZE", "VERIFY_RESIZE", "REVERT_RESIZE", "MIGRATING",
  "REBUILD", "PASSWORD", "RESCUE",
]);
export const serverBusy = (s: Server) => SERVER_BUSY.has(s.status) || !!s["OS-EXT-STS:task_state"];

export function serverStatus(s: Server): Status {
  if (s.status === "ERROR") return "error";
  if (serverBusy(s)) return "warn";
  if (s.status === "ACTIVE") return "ok";
  return "off";
}

/** "Active", "Shelved offloaded", or the running task ("Spawning"). */
export function serverLabel(s: Server) {
  const t = s["OS-EXT-STS:task_state"];
  const base = (t ?? s.status).replace(/[_-]/g, " ").toLowerCase();
  return tr(base.charAt(0).toUpperCase() + base.slice(1));
}

export function serverIps(s: Server) {
  return Object.entries(s.addresses ?? {}).flatMap(([net, list]) =>
    list.map((a) => ({ net, addr: a.addr, floating: a["OS-EXT-IPS:type"] === "floating", version: a.version })),
  );
}

/** Power state names (OS-EXT-STS:power_state). */
export const POWER_STATES: Record<number, string> = { 0: tr("No state"), 1: tr("Running"), 3: tr("Paused"), 4: tr("Shut down"), 6: tr("Crashed"), 7: tr("Suspended") };

export const useServers = (q?: Query) =>
  useOsList<Server>("compute", "servers/detail", "servers", q, { poll: (rows) => rows.some(serverBusy) });

export const useServer = (id: string) =>
  useOsGet<Server>("compute", `servers/${id}`, (r: { server: Server }) => r.server, { poll: serverBusy, enabled: !!id });

export type ServerGroupPolicy = "affinity" | "anti-affinity" | "soft-affinity" | "soft-anti-affinity";

export interface ServerGroup {
  id: string;
  name: string;
  /** 2.64+ */
  policy?: ServerGroupPolicy;
  /** before 2.64 */
  policies?: ServerGroupPolicy[];
  rules?: { max_server_per_host?: number };
  members: string[];
  project_id?: string;
  user_id?: string;
}

export const groupPolicy = (g: ServerGroup): ServerGroupPolicy | undefined => g.policy ?? g.policies?.[0];

export const POLICY_TEXT: Record<ServerGroupPolicy, { label: string; help: string }> = {
  affinity: { label: tr("Affinity"), help: tr("All members on the same host. Launch fails if it's full.") },
  "anti-affinity": { label: tr("Anti-affinity"), help: tr("Every member on a different host. Launch fails when there are no free hosts left.") },
  "soft-affinity": { label: tr("Soft affinity"), help: tr("Same host when possible, otherwise anywhere.") },
  "soft-anti-affinity": { label: tr("Soft anti-affinity"), help: tr("Different hosts when possible, otherwise shares hosts.") },
};

export const useServerGroups = (q?: Query) => useOsList<ServerGroup>("compute", "os-server-groups", "server_groups", q);

export const useFlavors = (q?: Query) => useOsList<Flavor>("compute", "flavors/detail", "flavors", q);

export const useKeypairs = () =>
  useQuery({
    queryKey: ["os", "compute", "os-keypairs"],
    queryFn: () => os.get<{ keypairs: { keypair: Keypair }[] }>("compute", "os-keypairs").then((r) => r.keypairs.map((k) => k.keypair)),
  });

export const useComputeAZs = () =>
  useQuery({
    queryKey: ["os", "compute", "os-availability-zone"],
    queryFn: () =>
      os
        .get<{ availabilityZoneInfo: { zoneName: string; zoneState: { available: boolean } }[] }>("compute", "os-availability-zone")
        .then((r) => r.availabilityZoneInfo.filter((z) => z.zoneState.available).map((z) => z.zoneName)),
    staleTime: 5 * 60_000,
  });

export interface ComputeLimits {
  maxTotalInstances: number;
  totalInstancesUsed: number;
  maxTotalCores: number;
  totalCoresUsed: number;
  maxTotalRAMSize: number;
  totalRAMUsed: number;
}
export const useComputeLimits = () =>
  useQuery({
    queryKey: ["os", "compute", "limits"],
    queryFn: () => os.get<{ limits: { absolute: ComputeLimits } }>("compute", "limits").then((r) => r.limits.absolute),
  });

/** Delete an instance, plus the ports Rassvet created for it at launch. */
export const deleteServer = (id: string) => api.del<void>(`/compute/servers/${encodeURIComponent(id)}`);

/** Plain server action, e.g. serverAction(id, { "os-start": null }). */
export const serverAction = (id: string, body: object) => os.action("compute", `servers/${id}`, body);

// =========================================================================== Cinder

export interface Volume {
  id: string;
  name: string | null;
  status: string;
  size: number;
  volume_type: string | null;
  bootable: "true" | "false";
  attachments: { server_id: string; device?: string; attachment_id?: string; id?: string }[];
  availability_zone?: string;
  created_at: string;
  updated_at?: string | null;
  description?: string | null;
  snapshot_id?: string | null;
  source_volid?: string | null;
  volume_image_metadata?: Record<string, string>;
  multiattach?: boolean;
  encrypted?: boolean;
  "os-vol-tenant-attr:tenant_id"?: string;
  group_id?: string | null;
  /** Admin-only: backend host "host@backend#pool". */
  "os-vol-host-attr:host"?: string | null;
  /** Admin-only: migrating, success, error… */
  migration_status?: string | null;
}

export interface Snapshot {
  id: string;
  name: string | null;
  status: string;
  size: number;
  volume_id: string;
  created_at: string;
  description?: string | null;
  /** Admin lists with all_tenants. */
  "os-extended-snapshot-attributes:project_id"?: string;
  /** Set when the snapshot was taken as part of a group snapshot (Cinder 3.14+); it can't be deleted on its own. */
  group_snapshot_id?: string | null;
}

export interface VolumeType {
  id: string;
  name: string;
  description?: string | null;
  is_public?: boolean;
  extra_specs?: Record<string, string>;
  qos_specs_id?: string | null;
  "os-volume-type-access:is_public"?: boolean;
}

const VOLUME_BUSY = /^(creating|attaching|detaching|extending|deleting|downloading|uploading|reserved|backing-up|restoring-backup|retyping|maintenance|awaiting-transfer)$/;
export const volumeBusy = (v: { status: string }) => VOLUME_BUSY.test(v.status);
export function volumeStatus(v: { status: string }): Status {
  if (v.status.startsWith("error")) return "error";
  if (volumeBusy(v)) return "warn";
  if (v.status === "available" || v.status === "in-use") return "ok";
  return "off";
}

/** Volume type to preselect: "__DEFAULT__" when the cloud has it, otherwise the first one listed. */
export function defaultVolumeType(types?: { name: string }[]) {
  return types?.find((t) => t.name === "__DEFAULT__")?.name ?? types?.[0]?.name ?? "";
}

export const useVolumes = (q?: Query) =>
  useOsList<Volume>("volume", "volumes/detail", "volumes", q, { poll: (rows) => rows.some(volumeBusy) });
/**
 * Volumes by ID (`GET volumes/{id}` each), e.g. the ones attached to an instance. Works for
 * admins looking at another project's instance, where the project's volume list has none
 * of them. Polls while one is busy (attaching, detaching…).
 */
export function useVolumesById(ids: string[]) {
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["os", "volume", `volumes/${id}`, {}],
      queryFn: () => os.get<{ volume: Volume }>("volume", `volumes/${id}`).then((r) => r.volume),
      retry: false,
      refetchInterval: (q: { state: { data?: Volume } }) => (q.state.data && volumeBusy(q.state.data) ? 4000 : false),
    })),
  });
  const pending = results.some((r) => r.isPending);
  return {
    data: pending ? undefined : (results.map((r) => r.data).filter(Boolean) as Volume[]),
    isPending: pending,
    isFetching: results.some((r) => r.isFetching),
    error: results.find((r) => r.error)?.error ?? null,
    refetch: () => Promise.all(results.map((r) => r.refetch())),
  };
}

export const useSnapshots = (q?: Query) =>
  useOsList<Snapshot>("volume", "snapshots/detail", "snapshots", q, { poll: (rows) => rows.some(volumeBusy) });
export const useVolumeTypes = () => useOsList<VolumeType>("volume", "types", "volume_types");

export const useVolumeAZs = () =>
  useQuery({
    queryKey: ["os", "volume", "os-availability-zone"],
    queryFn: () =>
      os
        .get<{ availabilityZoneInfo: { zoneName: string; zoneState: { available: boolean } }[] }>("volume", "os-availability-zone")
        .then((r) => r.availabilityZoneInfo.filter((z) => z.zoneState.available).map((z) => z.zoneName)),
    staleTime: 5 * 60_000,
  });

export interface VolumeLimits {
  maxTotalVolumes: number;
  totalVolumesUsed: number;
  maxTotalVolumeGigabytes: number;
  totalGigabytesUsed: number;
  maxTotalSnapshots: number;
  totalSnapshotsUsed: number;
}
export const useVolumeLimits = () =>
  useQuery({
    queryKey: ["os", "volume", "limits"],
    queryFn: () => os.get<{ limits: { absolute: VolumeLimits } }>("volume", "limits").then((r) => r.limits.absolute),
  });

// =========================================================================== Neutron

export interface Network {
  id: string;
  name: string;
  status: string;
  admin_state_up: boolean;
  shared: boolean;
  "router:external"?: boolean;
  subnets: string[];
  project_id: string;
  mtu?: number;
  description?: string;
  "provider:network_type"?: string;
  "provider:segmentation_id"?: number | null;
  "provider:physical_network"?: string | null;
  port_security_enabled?: boolean;
  availability_zones?: string[];
  created_at?: string;
  qos_policy_id?: string | null;
  /** DNS integration (dns-integration extension): zone for the records of its ports. */
  dns_domain?: string;
}

export interface Subnet {
  id: string;
  name: string;
  network_id: string;
  cidr: string;
  ip_version: 4 | 6;
  gateway_ip: string | null;
  enable_dhcp: boolean;
  dns_nameservers?: string[];
  allocation_pools?: { start: string; end: string }[];
  host_routes?: { destination: string; nexthop: string }[];
  description?: string;
  project_id?: string;
  ipv6_address_mode?: string | null;
  ipv6_ra_mode?: string | null;
  /** Pool the CIDR was allocated from (subnet_allocation), if any. */
  subnetpool_id?: string | null;
}

export interface Port {
  id: string;
  name: string;
  network_id: string;
  device_id: string;
  device_owner: string;
  mac_address: string;
  status: string;
  fixed_ips: { subnet_id: string; ip_address: string }[];
  security_groups?: string[];
  admin_state_up?: boolean;
  port_security_enabled?: boolean;
  description?: string;
  project_id?: string;
  "binding:host_id"?: string;
  "binding:vnic_type"?: string;
  allowed_address_pairs?: { ip_address: string; mac_address?: string }[];
  created_at?: string;
  updated_at?: string;
  qos_policy_id?: string | null;
  /** DNS integration: host name, its own zone (dns-domain-ports) and the names it got. */
  dns_name?: string;
  dns_domain?: string;
  dns_assignment?: { hostname: string; ip_address: string; fqdn: string }[];
  /** Set on a trunk's parent port (trunk-details extension). */
  trunk_details?: { trunk_id: string; sub_ports: { port_id: string; segmentation_type: string; segmentation_id: number; mac_address?: string }[] };
}

/** Horizon shows unnamed ports as "(568f079b-2ab9)". */
export const portLabel = (p: Pick<Port, "id" | "name">) => p.name || `(${p.id.slice(0, 13)})`;

/** Who owns a port, in words. */
export function portOwner(p: Port) {
  const o = p.device_owner ?? "";
  if (o.startsWith("compute:")) return tr("Instance");
  return tr(
    {
      "network:router_interface": "Router interface",
      "network:router_interface_distributed": "Router interface",
      "network:ha_router_replicated_interface": "Router interface",
      "network:router_gateway": "Router gateway",
      "network:dhcp": "DHCP",
      "network:floatingip": "Floating IP",
      "network:distributed": "Metadata",
      "trunk:subport": "Trunk subport",
    }[o] ?? (o || "Unattached")
  );
}

export interface Router {
  id: string;
  name: string;
  status: string;
  admin_state_up: boolean;
  project_id: string;
  description?: string;
  created_at?: string;
  external_gateway_info: null | {
    network_id: string;
    enable_snat?: boolean;
    external_fixed_ips?: { subnet_id: string; ip_address: string }[];
  };
  /** router-extend-ndp-proxy: NDP proxies can be created on this router. */
  enable_ndp_proxy?: boolean;
}

export interface SecurityGroupRule {
  id: string;
  security_group_id: string;
  direction: "ingress" | "egress";
  ethertype: "IPv4" | "IPv6";
  protocol: string | null;
  port_range_min: number | null;
  port_range_max: number | null;
  remote_ip_prefix: string | null;
  remote_group_id: string | null;
  description?: string;
}

export interface SecurityGroup {
  id: string;
  name: string;
  description: string;
  project_id: string;
  security_group_rules: SecurityGroupRule[];
  stateful?: boolean;
  created_at?: string;
}

export interface FloatingIp {
  id: string;
  floating_ip_address: string;
  floating_network_id: string;
  port_id: string | null;
  fixed_ip_address: string | null;
  router_id: string | null;
  status: string;
  description?: string;
  project_id: string;
  created_at?: string;
  updated_at?: string;
  /** DNS integration: record published in Designate for this address (set at allocation). */
  dns_name?: string;
  dns_domain?: string;
}

export const useNetworks = (q?: Query, enabled = true) => useOsList<Network>("network", "networks", "networks", q, { enabled });
export const useSubnets = (q?: Query) => useOsList<Subnet>("network", "subnets", "subnets", q);
export const usePorts = (q?: Query, enabled = true) => useOsList<Port>("network", "ports", "ports", q, { enabled });
export const useRouters = (q?: Query) => useOsList<Router>("network", "routers", "routers", q);
export const useSecurityGroups = (q?: Query) => useOsList<SecurityGroup>("network", "security-groups", "security_groups", q);
export const useFloatingIps = (q?: Query) => useOsList<FloatingIp>("network", "floatingips", "floatingips", q);

export type NeutronQuota = Record<string, { limit: number; used: number; reserved: number }>;
export const useNetworkQuota = (projectId?: string) =>
  useQuery({
    queryKey: ["os", "network", "quotas", projectId],
    queryFn: () => os.get<{ quota: NeutronQuota }>("network", `quotas/${projectId}/details`).then((r) => r.quota),
    enabled: !!projectId,
  });

export function networkStatus(s: string): Status {
  if (s === "ACTIVE") return "ok";
  if (s === "ERROR") return "error";
  if (s === "BUILD") return "warn";
  return "off";
}

/** "TCP 22", "ICMP", "Any protocol", "TCP 8000–8080". */
export function ruleSummary(r: SecurityGroupRule) {
  const proto = r.protocol ? r.protocol.toUpperCase() : tr("Any protocol");
  if (r.port_range_min == null) return proto;
  if (r.protocol === "icmp" || r.protocol === "ipv6-icmp") {
    return `${proto} type ${r.port_range_min}${r.port_range_max != null ? ` code ${r.port_range_max}` : ""}`;
  }
  return r.port_range_min === r.port_range_max ? `${proto} ${r.port_range_min}` : `${proto} ${r.port_range_min}–${r.port_range_max}`;
}

/** Horizon-style rule line: "ALLOW IPv4 tcp 22 from 0.0.0.0/0". */
export function ruleText(r: SecurityGroupRule, groupName?: (id: string) => string) {
  const proto = r.protocol ?? "any";
  let ports = "";
  if (r.port_range_min != null && r.protocol !== "icmp" && r.protocol !== "ipv6-icmp")
    ports = r.port_range_min === r.port_range_max ? ` ${r.port_range_min}` : ` ${r.port_range_min}-${r.port_range_max}`;
  const remote = r.remote_ip_prefix ?? (r.remote_group_id ? `group ${groupName?.(r.remote_group_id) ?? r.remote_group_id}` : r.ethertype === "IPv6" ? "::/0" : "0.0.0.0/0");
  return `ALLOW ${r.ethertype} ${proto}${ports} ${r.direction === "ingress" ? "from" : "to"} ${remote}`;
}

// =========================================================================== shared

/** Usage bar data: used of limit (-1 = unlimited). */
export function quotaPct(used: number, limit: number) {
  if (limit < 0) return 0;
  if (limit === 0) return used > 0 ? 100 : 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

const AGE_UNITS = [
  [365 * 86400, "year"],
  [30 * 86400, "month"],
  [86400, "day"],
  [3600, "hour"],
  [60, "minute"],
] as const;

const AGE_VI = { year: "năm", month: "tháng", day: "ngày", hour: "giờ", minute: "phút" } as const;

/** Time since a timestamp in its two largest units: "1 year, 2 months", "2 hours, 5 minutes". */
export function age(iso?: string | null) {
  if (!iso) return "";
  // Barbican (and some other services) send naive UTC timestamps without "Z".
  const t = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`).getTime();
  let s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return tr("just now");
  const parts: string[] = [];
  for (const [n, u] of AGE_UNITS) {
    const k = Math.floor(s / n);
    if (k > 0) parts.push(lang === "vi" ? `${k} ${AGE_VI[u]}` : `${k} ${u}${k === 1 ? "" : "s"}`);
    else if (parts.length) break; // "1 year, 3 days" would skip months: stop at the gap
    s -= k * n;
    if (parts.length === 2) break;
  }
  return parts.join(", ");
}

export const gib = (mib: number) => (mib >= 1024 ? `${+(mib / 1024).toFixed(1)} GiB` : `${mib} MiB`);

/**
 * `paged`: one page at a time from the server (limit + marker, Previous / Next, server
 * filters and sort); otherwise the whole list, first rows shown while the rest load.
 * Same shape either way.
 */
export function useListOrPages<T extends { id: string }>(
  paged: boolean,
  svc: Svc,
  path: string,
  key: string,
  q?: Query,
  opts: { filters?: ServerFilter[]; sort?: Record<string, string>; tableId?: string; poll?: (rows: T[]) => boolean } = {},
) {
  const all = useOsList<T>(svc, path, key, q, { enabled: !paged, poll: opts.poll });
  const pages = useOsPaged<T>(svc, path, key, q, { ...opts, enabled: paged });
  if (!paged) {
    return { rows: all.data, isPending: all.isPending, error: all.error, isFetching: all.isFetching, refetch: all.refetch, partial: all.partial, remote: undefined };
  }
  const pq = pages.query;
  return { rows: pages.rows, isPending: pq.isPending, error: pq.error, isFetching: pages.fetching, refetch: pages.refetch, partial: false, remote: pages.remote };
}
