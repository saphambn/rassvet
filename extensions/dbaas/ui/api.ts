/**
 * DBaaS on Genestack v1 through the extension's allowlisted gateway (`/api/ext/dbaas/os/...`,
 * service name `ext:dbaas` in the SDK's `os` helpers): types, hooks, constants and helpers.
 * Clusters are addressed by name within the token's project. DBaaS admins (Phase 8: a token of a
 * configured admin project, with the admin role) also reach every project's clusters through
 * `admin/projects/{project}/clusters/...`: a cluster with a `project_id` (the admin view) uses that path.
 */
import { type Status, os, tr, useOsGet, useOsList } from "@rassvet/sdk";

export const DB = "ext:dbaas" as const;
export const BASE = "/ext/dbaas";

// =========================================================================== types

export type EngineName = "mongodb" | "mysql" | "postgresql";

export interface Engine {
  name: EngineName;
  default_version: string;
  versions: string[];
  replicas: number[];
  port: number;
  /** Default number of proxies (HAProxy, PgBouncer); 0 or absent for mongodb. */
  proxy_replicas?: number;
}

export interface DbFlavor {
  name: string;
  cpu: string;
  memory: string;
}

export type ClusterStatus = "creating" | "ready" | "updating" | "degraded" | "error" | "deleting";

export interface DbCluster {
  name: string;
  engine: EngineName;
  version: string;
  flavor: string;
  replicas: number;
  ready_replicas?: number;
  storage_gb: number;
  proxy_replicas?: number;
  network_id: string;
  subnet_id: string;
  allowed_cidrs?: string[];
  floating_ip?: boolean;
  status: ClusterStatus;
  status_reason?: string;
  created_at?: string;
  /** Admin view only (GET admin/clusters): the cluster's Keystone project. */
  project_id?: string;
  namespace?: string;
}

/** A cluster: its name, and its project in the admin view. */
export type Ref = { name: string; project_id?: string };

/** API path of a cluster: `clusters/<name>`, or on behalf of its project for admins. */
export const cp = (c: Ref) => (c.project_id ? `admin/projects/${c.project_id}/` : "") + `clusters/${c.name}`;

/** UI path of a cluster's detail page (relative to the extension base). */
export const detailPath = (c: Ref) => (c.project_id ? `${BASE}/projects/${c.project_id}/clusters/${c.name}` : `${BASE}/clusters/${c.name}`);

export interface Member {
  hostname?: string;
  address?: string;
  ready?: boolean;
  /** "proxy" for the HAProxy/PgBouncer members of mysql and postgresql (Phase 12.4); MongoDB members have none. */
  role?: "proxy";
}

/** A pod of the cluster (GET clusters/{name}/members, Phase 12.2): no addresses. */
export interface ClusterMember {
  name: string;
  kind: "database" | "proxy";
  /** postgresql: primary or replica. */
  role?: string;
  ready: boolean;
  restarting?: boolean;
  restarts: number;
  started?: string;
}

/** The floating IP of a mysql/postgresql VIP (Phase 12.1). */
export interface FloatingIp {
  enabled: boolean;
  address?: string;
  /** Attached outside DBaaS (by the cloud operator): DBaaS neither manages nor removes it. */
  external?: boolean;
  message?: string;
}

export interface Endpoints {
  type: "replica_set" | "load_balancer";
  port: number;
  members?: Member[];
  address?: string;
  hostname?: string;
  floating_ip?: string;
  uri?: string;
  ca_certificate?: string;
}

export interface Credentials {
  username: string;
  password: string;
}

export interface QuotaSet {
  clusters?: number;
  cpu?: number;
  memory_mb?: number;
  storage_gb?: number;
  ports?: number;
  backups?: number;
}

export interface Quota {
  project_id: string;
  limits: QuotaSet;
  usage: QuotaSet;
  /** Why the cloud operator locked the project (no create, change or delete); absent: not locked. */
  locked?: string;
}

export type BackupStatus = "pending" | "running" | "succeeded" | "failed" | "deleting";

export interface Backup {
  id: string;
  cluster: string;
  type: "manual" | "scheduled";
  status: BackupStatus;
  status_reason?: string;
  size?: string;
  created_at: string;
  completed_at?: string;
  latest_restorable_time?: string;
}

export interface BackupPolicy {
  schedule: string;
  retention?: number;
  pitr?: boolean;
}

export interface Restore {
  id: string;
  cluster: string;
  backup?: string;
  restore_time?: string;
  status: "pending" | "running" | "succeeded" | "failed";
  status_reason?: string;
  created_at: string;
  completed_at?: string;
}

export interface CreateClusterRequest {
  name: string;
  engine: EngineName;
  version?: string;
  flavor: string;
  replicas?: number;
  storage_gb: number;
  proxy_replicas?: number;
  network_id: string;
  subnet_id: string;
  allowed_cidrs?: string[];
  floating_ip?: boolean;
  /** mongodb, deprecated (read as parameters): a mongod.conf fragment. */
  config?: string;
  /** Engine parameters, checked for the version and flavor. Restoring to a new cluster copies the source's unless given (`{}`: none). */
  parameters?: Record<string, string>;
  restore_from?: { backup: string; restore_time?: string };
}

export interface UpdateClusterRequest {
  replicas?: number;
  flavor?: string;
  storage_gb?: number;
  proxy_replicas?: number;
}

// =========================================================================== labels

export const ENGINE_LABEL: Record<EngineName, string> = { mongodb: "MongoDB", mysql: "MySQL", postgresql: "PostgreSQL" };
export const engineLabel = (e?: string) => (e && e in ENGINE_LABEL ? ENGINE_LABEL[e as EngineName] : (e ?? ""));

/** MySQL and PostgreSQL sit behind proxies and a load balancer VIP; MongoDB members are reached one by one. */
export const hasProxies = (e?: string) => e === "mysql" || e === "postgresql";
export const proxyName = (e?: string) => (e === "mysql" ? "HAProxy" : e === "postgresql" ? "PgBouncer" : tr("Proxies"));

/** Cluster names: dbaas-api's pattern (also used in Kubernetes object names). */
export const NAME_RE = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
export const NAME_MAX = 20;
export function nameProblem(name: string) {
  if (!name) return tr("Enter a name");
  if (name.length > NAME_MAX) return tr("At most {n} characters", { n: NAME_MAX });
  if (!NAME_RE.test(name)) return tr("Lowercase letters, digits and '-'; start with a letter, end with a letter or digit");
  return false;
}

/** An IPv4 or IPv6 CIDR (or a bare address). */
const V4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/(3[0-2]|[12]?\d))?$/;
const V6 = /^[0-9a-fA-F:]+(\/(12[0-8]|1[01]\d|\d?\d))?$/;
export const validCidr = (s: string) => V4.test(s) || (s.includes(":") && V6.test(s));

// =========================================================================== status

export const busy = (c?: { status?: string }) => c?.status === "creating" || c?.status === "updating" || c?.status === "deleting";

export function clusterStatus(s?: string): Status {
  switch (s) {
    case "ready":
      return "ok";
    case "creating":
    case "updating":
    case "degraded":
      return "warn";
    case "error":
      return "error";
    default:
      return "off";
  }
}

export function jobStatus(s?: string): Status {
  switch (s) {
    case "succeeded":
      return "ok";
    case "pending":
    case "running":
    case "deleting":
      return "warn";
    case "failed":
      return "error";
    default:
      return "off";
  }
}

const STATUS_TEXT: Record<string, () => string> = {
  creating: () => tr("Creating"),
  ready: () => tr("Ready"),
  updating: () => tr("Updating"),
  degraded: () => tr("Degraded"),
  error: () => tr("Error"),
  deleting: () => tr("Deleting"),
  pending: () => tr("Pending"),
  running: () => tr("Running"),
  succeeded: () => tr("Succeeded"),
  failed: () => tr("Failed"),
};
export const statusText = (s?: string) => (s ? (STATUS_TEXT[s]?.() ?? s) : tr("Unknown"));

const jobBusy = (rows: { status?: string }[]) => rows.some((r) => r.status === "pending" || r.status === "running" || r.status === "deleting");

/** "500m" → 0.5, "2" → 2. */
export const cpuCores = (s: string) => (s.endsWith("m") ? Number(s.slice(0, -1)) / 1000 : Number(s));
export const flavorText = (f?: DbFlavor) => (f ? tr("{cpu} vCPU · {mem} RAM", { cpu: cpuCores(f.cpu), mem: f.memory }) : "");

// =========================================================================== hooks

export const useEngines = () => useOsList<Engine>(DB, "engines", "engines");
export const useDbFlavors = () => useOsList<DbFlavor>(DB, "flavors", "flavors");
export const useQuota = (enabled = true) => useOsGet<Quota>(DB, "quota", (r: Quota) => r, { enabled });

export const useDbClusters = (enabled = true) => useOsList<DbCluster>(DB, "clusters", "clusters", undefined, { enabled, poll: (rows) => rows.some(busy) });

export const useDbCluster = (c: Ref) =>
  useOsGet<DbCluster>(DB, `${cp(c)}`, (r: DbCluster) => r, { enabled: !!c.name, poll: busy, retry: (n, e) => !("status" in e && e.status === 404) && n < 2 });

export const useEndpoints = (c: Ref, enabled = true) =>
  useOsGet<Endpoints>(DB, `${cp(c)}/endpoints`, (r: Endpoints) => r, { enabled: enabled && !!c.name });

export const useMembers = (c: Ref, enabled = true) =>
  useOsList<ClusterMember>(DB, `${cp(c)}/members`, "members", undefined, {
    enabled: enabled && !!c.name,
    poll: (rows) => rows.some((m) => m.restarting || !m.ready),
  });

export const useFloatingIp = (c: Ref, enabled = true) =>
  useOsGet<FloatingIp>(DB, `${cp(c)}/floating-ip`, (r: FloatingIp) => r, {
    enabled: enabled && !!c.name,
    retry: noRetry4xx,
    poll: (r) => !!r && !r.external && (r.enabled !== !!r.address || /being (allocated|released)/.test(r.message ?? "")),
  });
export const putFloatingIp = (c: Ref, enabled: boolean) => os.put<FloatingIp>(DB, `${cp(c)}/floating-ip`, { enabled });

export const useAllowedCidrs = (c: Ref) =>
  useOsGet<string[]>(DB, `${cp(c)}/allowed-cidrs`, (r: { allowed_cidrs?: string[] }) => r.allowed_cidrs ?? [], { enabled: !!c.name });

export const useBackups = (c: Ref, enabled = true) =>
  useOsList<Backup>(DB, `${cp(c)}/backups`, "backups", undefined, { enabled: enabled && !!c.name, poll: jobBusy });

/** 501 when the cloud offers no backups. */
export const useBackupPolicy = (c: Ref, enabled = true) =>
  useOsGet<BackupPolicy>(DB, `${cp(c)}/backup-policy`, (r: BackupPolicy) => r, { enabled: enabled && !!c.name, retry: () => false });

export const useRestores = (c: Ref, enabled = true) =>
  useOsList<Restore>(DB, `${cp(c)}/restores`, "restores", undefined, { enabled: enabled && !!c.name, poll: jobBusy });

// =========================================================================== observing (Phase 7)

export const METRIC_RANGES = ["15m", "1h", "6h", "24h", "7d"] as const;
export type MetricRange = (typeof METRIC_RANGES)[number];

export interface MetricSeries {
  name: string;
  /** cores, bytes, bytes/s, connections, ops/s, queries/s, transactions/s, seconds, ratio… */
  unit: string;
  /** Pod (or volume claim, for disk series) of a database member or proxy. */
  member: string;
  /** [unix seconds, value] */
  points: [number, number][];
}

export interface MemberStatus {
  name: string;
  up: boolean;
  /** mongodb primary/secondary/…; mysql synced/donor/joining/joined; postgresql primary/replica. */
  role?: string;
}

export interface Metrics {
  cluster: string;
  start: string;
  end: string;
  step_seconds: number;
  members: MemberStatus[];
  series: MetricSeries[];
}

export interface Logs {
  cluster: string;
  member: string;
  container: string;
  members: string[];
  containers: string[];
  lines: string[];
  /** MongoDB connection / authentication lines left out (`all=true` keeps them). */
  filtered?: number;
}

export interface LogQuery {
  member?: string;
  container?: string;
  since?: string;
  tail?: number;
  all?: boolean;
  previous?: boolean;
}

export interface ClusterEvent {
  type: "Normal" | "Warning";
  reason: string;
  message: string;
  /** Kind/name */
  object: string;
  count: number;
  first_seen: string;
  last_seen: string;
}

export interface SlowQueryLog {
  threshold_ms: number;
  /** The engine's default applies (no threshold set through the API). */
  default?: boolean;
}

export interface TopQuery {
  digest: string;
  query: string;
  schema?: string;
  calls: number;
  total_ms: number;
  avg_ms: number;
  max_ms: number;
  rows_examined: number;
  rows_sent: number;
  first_seen: string;
  last_seen: string;
}

export type TopOrder = "total" | "avg" | "calls" | "rows";

export interface TopQueries {
  cluster: string;
  member: string;
  members: string[];
  order: TopOrder;
  queries: TopQuery[];
}

/** HTTP status of an API error (501: the cloud doesn't offer it). */
export const errStatus = (e: unknown) => (e && typeof e === "object" && "status" in e ? Number((e as { status: unknown }).status) : undefined);
const noRetry4xx = (n: number, e: Error) => !((errStatus(e) ?? 500) < 500 || errStatus(e) === 501) && n < 2;

export const useMetrics = (c: Ref, range: MetricRange, enabled = true) =>
  useOsGet<Metrics>(DB, `${cp(c)}/metrics`, (r: Metrics) => r, { q: { range }, enabled: enabled && !!c.name, retry: noRetry4xx });

export const useEvents = (c: Ref, enabled = true) =>
  useOsList<ClusterEvent>(DB, `${cp(c)}/events`, "events", undefined, { enabled: enabled && !!c.name });

export const useLogs = (c: Ref, q: LogQuery, enabled = true) =>
  useOsGet<Logs>(DB, `${cp(c)}/logs`, (r: Logs) => r, {
    q: { member: q.member, container: q.container, since: q.since, tail: q.tail, all: q.all || undefined, previous: q.previous || undefined },
    enabled: enabled && !!c.name,
    retry: noRetry4xx,
  });

export const useSlowQueryLog = (c: Ref, enabled = true) =>
  useOsGet<SlowQueryLog>(DB, `${cp(c)}/slow-query-log`, (r: SlowQueryLog) => r, { enabled: enabled && !!c.name, retry: noRetry4xx });

export const useTopQueries = (c: Ref, q: { member?: string; order: TopOrder; limit: number }, enabled = true) =>
  useOsGet<TopQueries>(DB, `${cp(c)}/top-queries`, (r: TopQueries) => r, { q, enabled: enabled && !!c.name, retry: noRetry4xx });

export const putSlowQueryLog = (c: Ref, threshold_ms: number) => os.put<SlowQueryLog>(DB, `${cp(c)}/slow-query-log`, { threshold_ms });

// =========================================================================== calls

export const createCluster = (body: CreateClusterRequest) => os.post<DbCluster>(DB, "clusters", body);
export const updateCluster = (c: Ref, body: UpdateClusterRequest) => os.patch<DbCluster>(DB, `${cp(c)}`, body);
export const deleteCluster = (c: Ref) => os.del(DB, `${cp(c)}`);
export const fetchCredentials = (c: Ref) => os.get<Credentials>(DB, `${cp(c)}/credentials`);
export const putAllowedCidrs = (c: Ref, cidrs: string[]) => os.put<{ allowed_cidrs: string[] }>(DB, `${cp(c)}/allowed-cidrs`, { allowed_cidrs: cidrs });
export const takeBackup = (c: Ref) => os.post<Backup>(DB, `${cp(c)}/backups`);
export const deleteBackup = (c: Ref, id: string) => os.del(DB, `${cp(c)}/backups/${id}`);
export const putBackupPolicy = (c: Ref, p: BackupPolicy) => os.put<BackupPolicy>(DB, `${cp(c)}/backup-policy`, p);
export const restoreCluster = (c: Ref, body: { backup?: string; restore_time?: string }) => os.post<Restore>(DB, `${cp(c)}/restore`, body);

/** Connection string with the user filled in (the password stays a placeholder). */
export function uriWithUser(uri: string, user: string) {
  return uri.replace(/^([a-z+]+:\/\/)/, `$1${encodeURIComponent(user)}:<password>@`);
}

// =========================================================================== admin (Phase 8)

/** GET admin/projects: a Keystone project known to DBaaS (it has a namespace or a quota). */
export interface AdminProject {
  id: string;
  /** Seen on the project's last cluster create (may be stale after a rename). */
  name?: string;
  namespace?: string;
  /** Clusters by status. */
  clusters: Record<string, number>;
  quota: Quota;
  locked?: string;
}

/** Limits that differ from the cloud defaults; an absent field uses the default. */
export type QuotaOverrides = QuotaSet;

export interface AdminQuota extends Quota {
  defaults: QuotaSet;
  overrides: QuotaOverrides;
}

export interface AdminMember {
  name: string;
  node?: string;
  phase: string;
  ready: boolean;
  restarts: number;
  pod_ip?: string;
}

export interface AdminVolume {
  claim: string;
  volume?: string;
  phase: string;
  capacity?: string;
  storage_class?: string;
}

export interface AdminPort {
  claim: string;
  phase: string;
  port_id?: string;
  ip?: string;
  host?: string;
  message?: string;
}

export interface AdminLB {
  id?: string;
  vip?: string;
  floating_ip?: string;
  online_members: number;
}

export interface AdminProblem {
  member: string;
  reason: string;
  since: string;
  detail: string;
}

export interface AdminCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

/** GET admin/projects/{p}/clusters/{name}/detail: the tenant view plus where it runs. */
export interface AdminClusterDetail extends DbCluster {
  project_id: string;
  members?: AdminMember[];
  volumes?: AdminVolume[];
  ports?: AdminPort[];
  load_balancer?: AdminLB;
  problems?: AdminProblem[];
  conditions?: AdminCondition[];
  /** Parameters that differ from the flavor layer (clusters created before DBaaS sized the configuration). */
  sizing_drift?: string[];
  /** DatabaseCluster status and message. */
  operator?: { status?: string; message?: string };
}

export interface AdminAction {
  action: string;
  target: string;
  message?: string;
}

export const useAdminProjects = (enabled = true) => useOsList<AdminProject>(DB, "admin/projects", "projects", undefined, { enabled });

export const useAdminClusters = (enabled = true) =>
  useOsList<DbCluster>(DB, "admin/clusters", "clusters", undefined, { enabled, poll: (rows) => rows.some(busy) });

export const useAdminCluster = (c: Ref) =>
  useOsGet<AdminClusterDetail>(DB, `${cp(c)}/detail`, (r: AdminClusterDetail) => r, {
    enabled: !!c.name && !!c.project_id,
    poll: busy,
    retry: (n, e) => !("status" in e && e.status === 404) && n < 2,
  });

export const useAdminQuota = (project: string, enabled = true) =>
  useOsGet<AdminQuota>(DB, `admin/projects/${project}/quota`, (r: AdminQuota) => r, { enabled: enabled && !!project });

export const putAdminQuota = (project: string, o: QuotaOverrides) => os.put<AdminQuota>(DB, `admin/projects/${project}/quota`, o);
export const resetAdminQuota = (project: string) => os.del(DB, `admin/projects/${project}/quota`);
export const lockProject = (project: string, reason: string) => os.put<AdminAction>(DB, `admin/projects/${project}/lock`, { reason });
export const unlockProject = (project: string) => os.del(DB, `admin/projects/${project}/lock`);
/** postgresql: make a replica the primary (Patroni; answered once done). No target: the first ready replica. */
export const switchover = (c: Ref, target?: string) => os.post<AdminAction>(DB, `${cp(c)}/switchover`, target ? { target } : {});

/** Delete the pod; its operator recreates it. 409 while another member of the same kind isn't ready, unless an admin forces it. */
export const restartMember = (c: Ref, member: string, force = false) =>
  os.post<AdminAction>(DB, `${cp(c)}/members/${member}/restart`, undefined, force ? { force: true } : undefined);
export const retryPort = (c: Ref, claim: string) => os.post<AdminAction>(DB, `${cp(c)}/ports/${claim}/retry`);
export const forceDelete = (c: Ref, network: boolean) => os.post<AdminAction>(DB, `${cp(c)}/force-delete`, { network });

// =========================================================================== engine parameters (Phase 9)

/** One parameter a tenant (or, in the admin catalog, an admin) may set. */
export interface CatalogParameter {
  name: string;
  /** postgresql: bool, enum, integer, real, string; mysql: integer, boolean, enum, string, …; mongodb: int, bool, string, object, … */
  type?: string;
  unit?: string;
  min?: string;
  max?: string;
  /** The largest value for the flavor of the query (bytes, or a count for max_connections). */
  flavor_max?: number;
  values?: string[];
  default?: string;
  /** postgresql: changing it restarts the server. mongodb and mysql members always restart one by one. */
  restart: boolean;
  /** DBaaS sets it from the flavor; a tenant value replaces it. */
  flavor?: boolean;
  description?: string;
  /** Admin catalog only. */
  group?: string;
  admin_only?: boolean;
}

export interface EngineParameters {
  engine: EngineName;
  version: string;
  /** Major version of the catalog. */
  catalog: string;
  flavor?: string;
  parameters: CatalogParameter[];
}

/** engine: DBaaS default · flavor: sized from the flavor · tenant: set by the project · admin: set by the cloud operator · locked: required by DBaaS. */
export type ParamSource = "engine" | "flavor" | "tenant" | "admin" | "locked";

export interface Parameter {
  name: string;
  value: string;
  source: ParamSource;
  restart?: boolean;
}

export interface ClusterParameters {
  cluster: string;
  engine: EngineName;
  version: string;
  parameters: Parameter[];
  /** A change kept for later (Phase 12.3). */
  pending?: PendingParameters;
}

export interface PendingParameters {
  set?: Record<string, string>;
  unset?: string[];
  user?: string;
  time: string;
  admin?: boolean;
}

export interface ParameterChange {
  name: string;
  old?: string;
  new?: string;
  restart?: boolean;
}

/** reload: postgresql reloads · restart: postgresql restarts each member in place · rolling: members recreated one by one. */
export type ApplyMode = "none" | "reload" | "restart" | "rolling";

export interface ParametersPlan {
  cluster: string;
  changes: ParameterChange[];
  apply: ApplyMode;
  revision?: number;
  dry_run?: boolean;
  /** Kept for later: the changes and apply mode describe every pending change. */
  pending?: boolean;
}

export interface ParameterRevision {
  revision: number;
  time: string;
  user?: string;
  set?: Record<string, string>;
  unset?: string[];
  rollback_of?: number;
  admin?: boolean;
  /** The tenant layer after the change. */
  parameters: Record<string, string>;
}

export interface ParametersPreflight {
  cluster: string;
  version: string;
  flavor?: string;
  ok: boolean;
  errors: Record<string, string>;
}

/** The catalog for a version and flavor; admins get theirs (with the policy group and admin-only keys). */
export const useCatalog = (engine: string | undefined, q: { version?: string; flavor?: string }, admin = false, enabled = true) =>
  useOsGet<EngineParameters>(DB, `${admin ? "admin/" : ""}engines/${engine}/parameters`, (r: EngineParameters) => r, {
    q: { version: q.version || undefined, flavor: q.flavor || undefined },
    enabled: enabled && !!engine,
    retry: noRetry4xx,
  });

export const useParameters = (c: Ref, enabled = true) =>
  useOsGet<ClusterParameters>(DB, `${cp(c)}/parameters`, (r: ClusterParameters) => r, { enabled: enabled && !!c.name, retry: noRetry4xx });

export const useParameterHistory = (c: Ref, enabled = true) =>
  useOsList<ParameterRevision>(DB, `${cp(c)}/parameters/history`, "revisions", undefined, { enabled: enabled && !!c.name });

export const patchParameters = (c: Ref, body: { set?: Record<string, string>; unset?: string[]; dry_run?: boolean; apply?: "immediate" | "pending" }) =>
  os.patch<ParametersPlan>(DB, `${cp(c)}/parameters`, body);
export const applyPending = (c: Ref, dry_run = false) => os.post<ParametersPlan>(DB, `${cp(c)}/parameters/apply`, dry_run ? { dry_run } : {});
export const discardPending = (c: Ref) => os.del(DB, `${cp(c)}/parameters/pending`);
export const rollbackParameters = (c: Ref, revision: number, dry_run = false) =>
  os.post<ParametersPlan>(DB, `${cp(c)}/parameters/rollback`, { revision, ...(dry_run ? { dry_run } : {}) });
export const preflightParameters = (c: Ref, q: { version?: string; flavor?: string }) =>
  os.get<ParametersPreflight>(DB, `${cp(c)}/parameters/preflight`, { version: q.version || undefined, flavor: q.flavor || undefined });
export const applySizing = (c: Ref) => os.post<AdminAction>(DB, `${cp(c)}/apply-sizing`);

/** Per-parameter messages of a 400 ("invalid parameters: a: …; b: …"), else {}. */
export function paramErrors(e: unknown): Record<string, string> {
  const msg = e instanceof Error ? e.message : "";
  const m = /invalid parameters?: (.*)$/s.exec(msg);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const part of m[1].split(/; (?=[\w.-]+: )/)) {
    const i = part.indexOf(": ");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 2);
  }
  return out;
}

/** The cluster is applying a parameter change (one at a time; others get 409). */
export const applyingParams = (c?: { status?: string; status_reason?: string }) => c?.status === "updating" && /applying parameter change/i.test(c.status_reason ?? "");
