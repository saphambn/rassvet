/** Database clusters: list (project and admin view), create dialog and the per-cluster actions (scale / resize, backup, delete, force delete). */
import { useState } from "react";
import {
  ActionDialog,
  Button,
  type Column,
  DataTable,
  ErrorNotice,
  Field,
  Icon,
  Input,
  KeyValueEditor,
  type KvRow,
  kvError,
  Link,
  type MenuEntry,
  PageHeader,
  Picker,
  StatusDot,
  Switch,
  Textarea,
  age,
  cn,
  fmtDate,
  tr,
  useInAdmin,
  useQuery,
  useInvalidate,
  useNavigate,
  useNetworks,
  useNewParam,
  useProjects,
  useSearchParams,
  useSubnets,
} from "@rassvet/sdk";
import {
  DB,
  type CreateClusterRequest,
  type DbCluster,
  type EngineName,
  type UpdateClusterRequest,
  busy,
  clusterStatus,
  createCluster,
  deleteCluster,
  detailPath,
  engineLabel,
  forceDelete,
  flavorText,
  hasProxies,
  nameProblem,
  preflightParameters,
  proxyName,
  statusText,
  takeBackup,
  updateCluster,
  useAdminClusters,
  useCatalog,
  useAdminProjects,
  useBackups,
  useDbClusters,
  useDbFlavors,
  useEngines,
  useQuota,
  validCidr,
} from "./api";
import { suggestionsOf } from "./Parameters";
import { ConfEditor, ModeSwitch, parseConf, toConf } from "./ConfText";

export default function Clusters() {
  const admin = useInAdmin();
  const own = useDbClusters(!admin);
  const all = useAdminClusters(admin);
  const clusters = admin ? all : own;
  const quota = useQuota(!admin);
  const projects = useProjects(admin);
  const known = useAdminProjects(admin);
  const [params, setParams] = useSearchParams();
  const project = admin ? (params.get("project") ?? "") : "";
  const invalidate = useInvalidate();
  const actions = useClusterActions();
  const [creating, setCreating] = useState(false);
  useNewParam(setCreating);

  const projectName = (id?: string) => (id ? (projects.data?.find((p) => p.id === id)?.name ?? known.data?.find((p) => p.id === id)?.name ?? id) : "");

  const columns: Column<DbCluster>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (c) => (
        <div className="min-w-0">
          <Link to={detailPath(c)} className="block truncate font-medium text-cable hover:underline">
            {c.name}
          </Link>
          <p className="truncate text-xs text-muted">
            {engineLabel(c.engine)} {c.version}
          </p>
        </div>
      ),
      value: (c) => `${c.name} ${c.engine} ${c.version}`,
      csv: (c) => c.name,
    },
    ...(admin
      ? [
          {
            key: "project",
            header: tr("Project"),
            width: "10rem",
            hideBelow: "md" as const,
            cell: (c: DbCluster) => <span title={c.project_id}>{projectName(c.project_id)}</span>,
            value: (c: DbCluster) => `${projectName(c.project_id)} ${c.project_id ?? ""}`,
            csv: (c: DbCluster) => c.project_id ?? "",
          },
        ]
      : []),
    {
      key: "members",
      header: tr("Members"),
      width: "7rem",
      className: "text-right",
      cell: (c) => (
        <span className="font-mono text-[12.5px]">
          {c.ready_replicas ?? "?"} / {c.replicas}
        </span>
      ),
      value: (c) => c.replicas,
    },
    { key: "flavor", header: tr("Flavor"), width: "8rem", hideBelow: "md", cell: (c) => c.flavor, value: (c) => c.flavor },
    { key: "storage", header: tr("Storage"), width: "7rem", hideBelow: "lg", className: "text-right", cell: (c) => `${c.storage_gb} GB`, value: (c) => c.storage_gb },
    {
      key: "status",
      header: tr("Status"),
      width: "10rem",
      cell: (c) => (
        <span title={c.status_reason}>
          <StatusDot status={clusterStatus(c.status)} label={statusText(c.status)} />
        </span>
      ),
      value: (c) => `${c.status} ${c.status_reason ?? ""}`,
    },
    { key: "age", header: tr("Age"), width: "7rem", hideBelow: "xl", cell: (c) => <span title={fmtDate(c.created_at) ?? ""}>{age(c.created_at)}</span>, value: (c) => c.created_at ?? "" },
  ];

  const used = quota.data?.usage.clusters;
  const limit = quota.data?.limits.clusters;
  const locked = quota.data?.locked;
  const rows = project ? clusters.data?.filter((c) => c.project_id === project) : clusters.data;
  return (
    <>
      <PageHeader
        title={admin ? tr("All database clusters") : tr("Database clusters")}
        description={
          admin
            ? tr("Every project's DBaaS clusters. Admins act on them on behalf of the project; creating clusters and reading their credentials stay with the project's users.")
            : `${tr("MongoDB, MySQL and PostgreSQL clusters run by the cloud and reachable on your own network.")}${
                limit != null && used != null && limit >= 0 ? " " + tr("{used} of {limit} clusters used.", { used, limit }) : ""
              }`
        }
        actions={
          !admin && (
            <Button variant="primary" onClick={() => setCreating(true)} disabled={!!locked} title={locked ? tr("The project is locked") : undefined}>
              <Icon name="plus" />
              {tr("Create database")}
            </Button>
          )
        }
      />
      {locked && (
        <p className="mb-4 rounded-md border border-led-amber/40 bg-led-amber/10 px-3 py-2 text-sm">
          <Icon name="lock" className="mr-1.5 inline size-3.5 align-[-2px]" />
          {tr("The cloud operator locked this project: clusters keep running, but nothing can be created, changed or deleted. Reason: {reason}", { reason: locked })}
        </p>
      )}
      {project && (
        <p className="mb-4 flex flex-wrap items-center gap-2 text-sm text-muted">
          {tr("Project {name}", { name: projectName(project) })}
          <button
            type="button"
            className="text-cable hover:underline"
            onClick={() => {
              params.delete("project");
              setParams(params, { replace: true });
            }}
          >
            {tr("Show all projects")}
          </button>
        </p>
      )}
      <ErrorNotice error={clusters.error} className="mb-4" />
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(c) => `${c.project_id ?? ""}/${c.name}`}
        loading={clusters.isPending}
        tableId={admin ? "dbaas-admin-clusters" : "dbaas-clusters"}
        noun={tr("clusters")}
        rowLabel={(c) => c.name}
        onRefresh={() => clusters.refetch()}
        refreshing={clusters.isFetching}
        onBulkDone={() => invalidate(DB)}
        empty={admin ? tr("No database clusters in this region.") : tr("This project has no database clusters yet.")}
        filterPlaceholder={tr("Filter by name, engine or status")}
        rowActions={(c) => actions.items(c)}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete database clusters?"),
            past: tr("deleted"),
            body: tr("Each cluster is deleted with its data, backups, ports, load balancer and security group. This can't be undone."),
            check: (c) => (c.status === "deleting" ? tr("Already being deleted") : true),
            run: (c) => deleteCluster(c),
          },
        ]}
      />
      {creating && !admin && <CreateClusterDialog onClose={() => setCreating(false)} />}
      {actions.dialogs}
    </>
  );
}

// =========================================================================== actions

export type ClusterAction = "scale" | "backup" | "delete" | "force-delete";

export function useClusterActions({ onDeleted }: { onDeleted?: () => void } = {}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState<{ kind: ClusterAction; c: DbCluster } | null>(null);
  const close = () => setOpen(null);
  const items = (c: DbCluster, where: "list" | "detail" = "list"): MenuEntry[] => {
    const wait = busy(c) ? tr("Busy ({status})", { status: statusText(c.status) }) : false;
    const deleting = c.status === "deleting" && tr("Being deleted");
    return [
      where === "list" && { label: tr("View details"), icon: "eye", onSelect: () => navigate(detailPath(c)) },
      where === "list" && { label: tr("Connect"), icon: "plug", onSelect: () => navigate(`${detailPath(c)}?tab=connect`) },
      where === "list" && "-",
      { label: tr("Scale or resize"), icon: "scaling", disabled: wait || deleting, onSelect: () => setOpen({ kind: "scale", c }) },
      { label: tr("Back up now"), icon: "database-backup", disabled: (c.status !== "ready" && tr("The cluster isn't ready")) || false, onSelect: () => setOpen({ kind: "backup", c }) },
      "-",
      { label: tr("Delete cluster"), icon: "trash", danger: true, disabled: deleting, onSelect: () => setOpen({ kind: "delete", c }) },
      // Admins only (a cluster seen on behalf of its project): finish a deletion that is stuck.
      !!c.project_id && {
        label: tr("Force delete"),
        icon: "trash",
        danger: true,
        disabled: c.status !== "deleting" && tr("Delete the cluster first; force delete only finishes a stuck deletion"),
        onSelect: () => setOpen({ kind: "force-delete", c }),
      },
    ];
  };
  const o = open;
  const dialogs = o && (
    <>
      {o.kind === "scale" && <ScaleDialog cluster={o.c} onClose={close} />}
      {o.kind === "force-delete" && <ForceDeleteDialog cluster={o.c} onClose={close} onDone={onDeleted} />}
      {o.kind === "backup" && (
        <ActionDialog
          onClose={close}
          title={tr("Back up {name}?", { name: o.c.name })}
          submitLabel={tr("Back up now")}
          done={tr("Backing up {name}", { name: o.c.name })}
          refresh={[DB]}
          run={() => takeBackup(o.c)}
        >
          <p className="text-sm">{tr("A full backup is taken now and kept in the cloud's object storage. It counts against the backups quota until you delete it.")}</p>
        </ActionDialog>
      )}
      {o.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete {name}?", { name: o.c.name })}
          submitLabel={tr("Delete cluster")}
          done={tr("Deleting cluster {name}", { name: o.c.name })}
          refresh={[DB]}
          onDone={onDeleted}
          run={() => deleteCluster(o.c)}
        >
          <p className="text-sm">
            {tr("The {engine} cluster is deleted with its data, its ports on your network, its load balancer and security group.", { engine: engineLabel(o.c.engine) })}
          </p>
          <p className="text-sm text-led-red">{tr("Its backups are deleted too: take a copy of the data first if you need it.")}</p>
        </ActionDialog>
      )}
    </>
  );
  return { items, dialogs, openDialog: (c: DbCluster, kind: ClusterAction) => setOpen({ kind, c }) };
}

function ForceDeleteDialog({ cluster: c, onClose, onDone }: { cluster: DbCluster; onClose: () => void; onDone?: () => void }) {
  const [network, setNetwork] = useState(false);
  const [confirm, setConfirm] = useState("");
  return (
    <ActionDialog
      onClose={onClose}
      danger
      size="md"
      title={tr("Force delete {name}?", { name: c.name })}
      description={tr("For a deletion that is stuck: drops the finalizers of the database cluster and its operator resource and deletes the remaining pods at once.")}
      submitLabel={tr("Force delete")}
      canSubmit={confirm === c.name}
      done={tr("Force-deleting {name}", { name: c.name })}
      refresh={[DB]}
      onDone={onDone}
      run={() => forceDelete(c, network)}
    >
      <Switch
        checked={network}
        onChange={setNetwork}
        label={tr("Also release the network resources")}
        hint={tr("Drops the finalizers of the ports and the attachment too, leaving the Neutron ports, security group and load balancer to the garbage collector. Use it when Neutron or Octavia can't delete them.")}
      />
      <Field label={tr("Type {name} to confirm", { name: c.name })}>
        {(id) => <Input id={id} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />}
      </Field>
    </ActionDialog>
  );
}

function ScaleDialog({ cluster: c, onClose }: { cluster: DbCluster; onClose: () => void }) {
  const engines = useEngines();
  const flavors = useDbFlavors();
  const engine = engines.data?.find((e) => e.name === c.engine);
  const [replicas, setReplicas] = useState(String(c.replicas));
  const [flavor, setFlavor] = useState(c.flavor);
  const [storage, setStorage] = useState(String(c.storage_gb));
  const [proxies, setProxies] = useState(String(c.proxy_replicas ?? ""));

  const body: UpdateClusterRequest = {};
  if (Number(replicas) !== c.replicas) body.replicas = Number(replicas);
  if (flavor !== c.flavor) body.flavor = flavor;
  if (Number(storage) !== c.storage_gb) body.storage_gb = Number(storage);
  if (hasProxies(c.engine) && proxies !== "" && Number(proxies) !== (c.proxy_replicas ?? 0)) body.proxy_replicas = Number(proxies);
  let problem: string | false = false;
  if (!(Number(storage) >= c.storage_gb)) problem = tr("Storage can only grow (now {n} GB).", { n: c.storage_gb });
  if (hasProxies(c.engine) && proxies !== "" && !(Number(proxies) >= 1)) problem = tr("At least one proxy");
  // A new flavor must fit the parameters set for the cluster (memory limits follow the flavor).
  const pre = useQuery({
    queryKey: [DB, "preflight", c.project_id ?? "", c.name, flavor],
    queryFn: () => preflightParameters(c, { flavor }),
    enabled: flavor !== c.flavor,
    retry: false,
  });
  const misfit = flavor !== c.flavor && pre.data && !pre.data.ok ? Object.entries(pre.data.errors ?? {}) : [];
  if (misfit.length) problem = tr("The cluster's parameters don't fit the {flavor} flavor; lower them first (Parameters tab).", { flavor });

  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Scale or resize {name}", { name: c.name })}
      description={tr("Members are replaced one at a time, so the cluster stays available; a new flavor restarts every member.")}
      submitLabel={tr("Apply")}
      canSubmit={Object.keys(body).length > 0 && !problem}
      done={tr("Updating {name}", { name: c.name })}
      refresh={[DB]}
      run={() => updateCluster(c, body)}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("Members")}>
          {(id) => (
            <Picker
              id={id}
              value={replicas}
              onChange={setReplicas}
              loading={engines.isPending}
              options={(engine?.replicas ?? [c.replicas]).map((n) => ({ value: String(n), label: String(n) }))}
            />
          )}
        </Field>
        <Field label={tr("Flavor")}>
          {(id) => (
            <Picker
              id={id}
              value={flavor}
              onChange={setFlavor}
              loading={flavors.isPending}
              options={(flavors.data ?? []).map((f) => ({ value: f.name, label: f.name, description: flavorText(f) }))}
            />
          )}
        </Field>
        <Field label={tr("Storage per member (GB)")} hint={tr("Volumes can grow, not shrink.")}>
          {(id) => <Input id={id} type="number" min={c.storage_gb} value={storage} onChange={(e) => setStorage(e.target.value)} />}
        </Field>
        {hasProxies(c.engine) && (
          <Field label={tr("{proxy} replicas", { proxy: proxyName(c.engine) })}>
            {(id) => <Input id={id} type="number" min={1} value={proxies} onChange={(e) => setProxies(e.target.value)} />}
          </Field>
        )}
      </div>
      {problem && <p className="text-sm text-led-red">{problem}</p>}
      {misfit.length > 0 && (
        <ul className="space-y-0.5 text-sm text-led-red">
          {misfit.map(([k, m]) => (
            <li key={k}>
              <span className="font-mono">{k}</span>: {m}
            </li>
          ))}
        </ul>
      )}
    </ActionDialog>
  );
}

// =========================================================================== create

const STEPS = ["engine", "size", "network", "advanced"] as const;
type Step = (typeof STEPS)[number];

/** CIDRs typed one per line or separated by commas / spaces. */
export const parseCidrs = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

export function CreateClusterDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const engines = useEngines();
  const flavors = useDbFlavors();
  const networks = useNetworks();
  const subnets = useSubnets();
  const clusters = useDbClusters();
  const [step, setStep] = useState<Step>("engine");
  const [name, setName] = useState("");
  const [engineName, setEngineName] = useState<EngineName | "">("");
  const [version, setVersion] = useState("");
  const [flavor, setFlavor] = useState("");
  const [replicas, setReplicas] = useState("");
  const [storage, setStorage] = useState("10");
  const [proxies, setProxies] = useState("");
  const [networkId, setNetworkId] = useState("");
  const [subnetId, setSubnetId] = useState("");
  const [floatingIp, setFloatingIp] = useState(false);
  const [cidrs, setCidrs] = useState("");
  const [params, setParams] = useState<KvRow[]>([]);
  const [paramMode, setParamMode] = useState<"form" | "text">("form");
  const [paramText, setParamText] = useState("");
  const [source, setSource] = useState("");
  const [sourceBackup, setSourceBackup] = useState("");
  const [restoreTime, setRestoreTime] = useState("");

  const engine = engines.data?.find((e) => e.name === engineName);
  const ver = version || engine?.default_version || "";
  const reps = replicas || (engine?.replicas.includes(3) ? "3" : String(engine?.replicas[0] ?? ""));
  const prox = proxies || String(engine?.proxy_replicas ?? "");
  // DBaaS attaches a port with port security to the tenant network: external, provider-only and
  // port-security-disabled networks are refused, so they aren't offered.
  const usableNets = (networks.data ?? []).filter((n) => !n["router:external"] && n.port_security_enabled !== false);
  const netSubnets = (subnets.data ?? []).filter((s) => s.network_id === networkId);
  const sources = (clusters.data ?? []).filter((c) => c.engine === engineName);
  const sourceBackups = useBackups({ name: source }, !!source);
  const catalog = useCatalog(engineName || undefined, { version: ver, flavor }, false, !!engineName && step === "advanced");
  const restorable = (sourceBackups.data ?? []).filter((b) => b.status === "succeeded");
  const cidrList = parseCidrs(cidrs);

  const problems: Partial<Record<Step, string>> = {};
  const np = nameProblem(name.trim());
  if (np) problems.engine = np;
  else if (clusters.data?.some((c) => c.name === name.trim())) problems.engine = tr("A cluster with this name exists");
  if (!engine) problems.engine = tr("Choose an engine");
  if (!flavor) problems.size = tr("Choose a flavor");
  if (!(Number(storage) >= 1)) problems.size = tr("Enter the storage size in GB");
  if (hasProxies(engineName) && !(Number(prox) >= 1)) problems.size = tr("At least one proxy");
  if (!networkId || !subnetId) problems.network = tr("Choose a network and a subnet");
  const badCidr = cidrList.find((c) => !validCidr(c));
  if (badCidr) problems.network = tr("Not a CIDR: {c}", { c: badCidr });
  if (cidrList.length > 50) problems.network = tr("At most 50 CIDRs");
  const parsedParams = paramMode === "text" ? parseConf(paramText, catalog.data?.parameters) : null;
  const paramValues = parsedParams ? parsedParams.values : Object.fromEntries(params.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value.trim()]));
  const paramProblem = parsedParams
    ? parsedParams.errors.length
      ? tr("Fix the parameter lines marked in red")
      : null
    : (kvError(params) ?? (params.some((r) => r.key.trim() && !r.value.trim()) ? tr("Every parameter needs a value") : null));
  const switchParamMode = (m: "form" | "text") => {
    if (m === paramMode) return;
    if (m === "text") setParamText(toConf(paramValues));
    else setParams(Object.entries(paramValues).map(([key, value]) => ({ key, value })));
    setParamMode(m);
  };
  if (paramProblem) problems.advanced = paramProblem;
  if (source && !sourceBackup) problems.advanced = tr("Choose a backup to restore");
  if (restoreTime && Number.isNaN(Date.parse(restoreTime))) problems.advanced = tr("Enter a valid date and time");

  const create = () => {
    const body: CreateClusterRequest = {
      name: name.trim(),
      engine: engineName as EngineName,
      ...(version ? { version } : {}),
      flavor,
      replicas: Number(reps),
      storage_gb: Number(storage),
      ...(hasProxies(engineName) ? { proxy_replicas: Number(prox), floating_ip: floatingIp } : {}),
      network_id: networkId,
      subnet_id: subnetId,
      ...(cidrList.length ? { allowed_cidrs: cidrList } : {}),
      ...(Object.keys(paramValues).length ? { parameters: paramValues } : {}),
      ...(source && sourceBackup ? { restore_from: { backup: sourceBackup, ...(restoreTime ? { restore_time: toUtc(restoreTime) } : {}) } } : {}),
    };
    return createCluster(body);
  };

  const stepLabel: Record<Step, string> = { engine: tr("Engine"), size: tr("Size"), network: tr("Network"), advanced: tr("Advanced") };
  const idx = STEPS.indexOf(step);
  return (
    <ActionDialog<DbCluster>
      onClose={onClose}
      size="xl"
      title={tr("Create database cluster")}
      description={tr("The cluster is built in the background in a few minutes. The first cluster of an engine in a project also installs that engine's operator, which takes a few minutes more.")}
      submitLabel={tr("Create cluster")}
      canSubmit={Object.keys(problems).length === 0}
      done={tr("Creating cluster {name}", { name: name.trim() })}
      refresh={[DB]}
      onDone={(r) => navigate(detailPath(r))}
      run={create}
    >
      <div className="grid items-start gap-5 sm:grid-cols-[10.5rem_minmax(0,1fr)]">
        <StepRail steps={STEPS} labels={stepLabel} current={step} problems={problems} onPick={setStep} />
        <div className="min-w-0 space-y-4">
          {step === "engine" && (
            <>
              <Field label={tr("Name")} hint={tr("Up to {n} lowercase letters, digits and '-'. It can't be changed later.", { n: 20 })}>
                {(id) => <Input id={id} autoFocus value={name} maxLength={20} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="orders-db" />}
              </Field>
              <Field label={tr("Engine")}>
                {(id) => (
                  <Picker
                    id={id}
                    value={engineName}
                    onChange={(v) => {
                      setEngineName(v as EngineName);
                      setVersion("");
                      setReplicas("");
                      setProxies("");
                      setSource("");
                      setSourceBackup("");
                    }}
                    loading={engines.isPending}
                    options={(engines.data ?? []).map((e) => ({
                      value: e.name,
                      label: engineLabel(e.name),
                      icon: "database",
                      description: hasProxies(e.name)
                        ? tr("Port {port} · {proxy} behind a load balancer", { port: e.port, proxy: proxyName(e.name) })
                        : tr("Port {port} · replica set, one address per member", { port: e.port }),
                    }))}
                  />
                )}
              </Field>
              {engine && (
                <Field label={tr("Version")}>
                  {(id) => (
                    <Picker
                      id={id}
                      value={ver}
                      onChange={setVersion}
                      options={engine.versions.map((v) => ({ value: v, label: v, description: v === engine.default_version ? tr("default") : undefined }))}
                    />
                  )}
                </Field>
              )}
              <ErrorNotice error={engines.error} />
            </>
          )}
          {step === "size" && (
            <>
              <Field label={tr("Flavor")} hint={tr("CPU and memory of each member.")}>
                {(id) => (
                  <Picker
                    id={id}
                    value={flavor}
                    onChange={setFlavor}
                    loading={flavors.isPending}
                    options={(flavors.data ?? []).map((f) => ({ value: f.name, label: f.name, description: flavorText(f) }))}
                  />
                )}
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={tr("Members")} hint={tr("3 or more for high availability.")}>
                  {(id) => (
                    <Picker
                      id={id}
                      value={reps}
                      onChange={setReplicas}
                      disabled={!engine}
                      options={(engine?.replicas ?? []).map((n) => ({ value: String(n), label: String(n) }))}
                    />
                  )}
                </Field>
                <Field label={tr("Storage per member (GB)")} hint={tr("Can grow later, not shrink.")}>
                  {(id) => <Input id={id} type="number" min={1} value={storage} onChange={(e) => setStorage(e.target.value)} />}
                </Field>
                {hasProxies(engineName) && (
                  <Field label={tr("{proxy} replicas", { proxy: proxyName(engineName) })} hint={tr("Proxies in front of the members; clients connect to them through the load balancer.")}>
                    {(id) => <Input id={id} type="number" min={1} value={prox} onChange={(e) => setProxies(e.target.value)} />}
                  </Field>
                )}
              </div>
            </>
          )}
          {step === "network" && (
            <>
              <p className="text-sm text-muted">
                {hasProxies(engineName)
                  ? tr("A load balancer address on this subnet is where clients connect. Only the subnet and the CIDRs below can reach the database.")
                  : tr("Each member gets an address and a hostname on this subnet. Only the subnet and the CIDRs below can reach the database.")}
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={tr("Network")}>
                  {(id) => (
                    <Picker
                      id={id}
                      value={networkId}
                      onChange={(v) => {
                        setNetworkId(v);
                        const own = (subnets.data ?? []).filter((s) => s.network_id === v);
                        setSubnetId(own.find((s) => s.ip_version === 4)?.id ?? own[0]?.id ?? "");
                      }}
                      searchable
                      loading={networks.isPending}
                      options={usableNets.map((n) => ({ value: n.id, label: n.name || n.id, description: n.shared ? tr("shared") : undefined }))}
                    />
                  )}
                </Field>
                <Field label={tr("Subnet")}>
                  {(id) => (
                    <Picker
                      id={id}
                      value={subnetId}
                      onChange={setSubnetId}
                      disabled={!networkId}
                      options={netSubnets.map((s) => ({ value: s.id, label: s.name || s.id, description: s.cidr }))}
                    />
                  )}
                </Field>
              </div>
              {hasProxies(engineName) && (
                <Switch
                  checked={floatingIp}
                  onChange={setFloatingIp}
                  label={tr("Floating IP")}
                  hint={tr("Also reach the load balancer from outside through a floating IP. The allowed CIDRs still apply.")}
                />
              )}
              <Field label={tr("Other allowed CIDRs")} hint={tr("One per line. Clients on other networks (through a router or VPN) need their CIDR here.")}>
                {(id) => <Textarea id={id} rows={3} value={cidrs} onChange={(e) => setCidrs(e.target.value)} placeholder={"10.20.0.0/24\n192.168.5.10/32"} className="font-mono" />}
              </Field>
            </>
          )}
          {step === "advanced" && (
            <>
              <div>
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">{tr("Engine parameters (optional)")}</p>
                  <ModeSwitch value={paramMode} onChange={switchParamMode} />
                </div>
                <p className="mb-2 text-xs text-muted">
                  {catalog.data
                    ? tr("{n} parameters of {engine} {major} can be set, checked for the {flavor} flavor. Memory settings are sized from the flavor unless you set them.", {
                        n: catalog.data.parameters.length,
                        engine: engineLabel(engineName),
                        major: catalog.data.catalog,
                        flavor: flavor || "—",
                      })
                    : tr("Choose an engine and a flavor first.")}
                  {source && " " + tr("Without parameters here, the new cluster gets those of the backup's cluster.")}
                </p>
                <ErrorNotice error={catalog.error} className="mb-2" />
                {parsedParams ? (
                  <ConfEditor
                    value={paramText}
                    onChange={setParamText}
                    parsed={parsedParams}
                    rows={8}
                    placeholder={engineName === "mongodb" ? "operationProfiling:\n  slowOpThresholdMs: 200" : engineName === "mysql" ? "[mysqld]\nwait_timeout = 600\nmax_connections = 300" : "work_mem = 16MB\nlog_min_duration_statement = 500ms"}
                  />
                ) : (
                  <KeyValueEditor
                    rows={params}
                    onChange={setParams}
                    suggestions={suggestionsOf(catalog.data?.parameters)}
                    keyPlaceholder={engineName === "mongodb" ? "operationProfiling.slowOpThresholdMs" : engineName === "mysql" ? "wait_timeout" : "work_mem"}
                    valuePlaceholder={tr("value")}
                    addLabel={tr("Add parameter")}
                    empty={tr("None: DBaaS's defaults and the flavor's sizing.")}
                  />
                )}
              </div>
              <Field label={tr("Start from a backup")} hint={tr("Seed the new cluster with the data of a backup of another {engine} cluster of this project.", { engine: engineLabel(engineName) || tr("database") })}>
                {(id) => (
                  <Picker
                    id={id}
                    value={source}
                    onChange={(v) => {
                      setSource(v);
                      setSourceBackup("");
                    }}
                    disabled={!engine}
                    options={[{ value: "", label: tr("Empty database") }, ...sources.map((c) => ({ value: c.name, label: c.name, description: `${engineLabel(c.engine)} ${c.version}` }))]}
                  />
                )}
              </Field>
              {source && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={tr("Backup")}>
                    {(id) => (
                      <Picker
                        id={id}
                        value={sourceBackup}
                        onChange={setSourceBackup}
                        loading={sourceBackups.isPending}
                        emptyText={tr("No finished backups")}
                        options={restorable.map((b) => ({ value: b.id, label: fmtDate(b.completed_at ?? b.created_at) ?? b.id, description: [b.type === "scheduled" ? tr("scheduled") : tr("manual"), b.size].filter(Boolean).join(" · ") }))}
                      />
                    )}
                  </Field>
                  <Field label={tr("Point in time (optional)")} hint={tr("Your local time. Needs point-in-time recovery on the source.")}>
                    {(id) => <Input id={id} type="datetime-local" step={1} value={restoreTime} onChange={(e) => setRestoreTime(e.target.value)} />}
                  </Field>
                </div>
              )}
            </>
          )}
          <div className="flex items-center gap-2 border-t border-line pt-3">
            {problems[step] && <p className="text-xs text-[#9a6412] dark:text-led-amber">{problems[step]}</p>}
            <span className="ml-auto" />
            <Button type="button" disabled={idx === 0} onClick={() => setStep(STEPS[idx - 1])}>
              <Icon name="chevron-left" />
              {tr("Back")}
            </Button>
            {idx < STEPS.length - 1 && (
              <Button type="button" onClick={() => setStep(STEPS[idx + 1])}>
                {tr("Next")}
                <Icon name="chevron-right" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </ActionDialog>
  );
}

/**
 * Steps of a create dialog, one under the other (a row on narrow screens): number, ✓ once
 * passed, amber when the step still has a problem. Any step can be opened directly.
 */
function StepRail<S extends string>({
  steps,
  labels,
  current,
  problems,
  onPick,
}: {
  steps: readonly S[];
  labels: Record<S, string>;
  current: S;
  problems: Partial<Record<S, string>>;
  onPick: (s: S) => void;
}) {
  const idx = steps.indexOf(current);
  return (
    <nav aria-label={tr("Steps")} className="flex gap-1 overflow-x-auto sm:sticky sm:top-0 sm:flex-col">
      {steps.map((s, i) => (
        <button
          key={s}
          type="button"
          onClick={() => onPick(s)}
          aria-current={s === current ? "step" : undefined}
          title={problems[s]}
          className={cn(
            "flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm whitespace-nowrap transition-colors",
            s === current ? "bg-cable-soft font-medium text-cable" : "text-muted hover:bg-ink/5 hover:text-ink",
          )}
        >
          <span
            className={cn(
              "grid size-5 shrink-0 place-items-center rounded-full border text-[11px] tabular-nums",
              problems[s] && i <= idx ? "border-led-amber text-[#9a6412] dark:text-led-amber" : i < idx ? "border-cable bg-cable text-white" : "border-line",
            )}
          >
            {i < idx && !problems[s] ? <Icon name="check" className="size-3" /> : i + 1}
          </span>
          {labels[s]}
        </button>
      ))}
    </nav>
  );
}

/** `datetime-local` value (local time) → UTC RFC 3339 with second precision. */
export const toUtc = (local: string) => new Date(local).toISOString().replace(/\.\d{3}Z$/, "Z");
