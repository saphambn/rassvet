/**
 * Admin (DBaaS Phase 8): the Database service page (projects known to DBaaS, their quota overrides and
 * locks) and the Runtime tab of a cluster (pods, volumes, network ports, load balancer, problems), with
 * the repairs only admins make: restart a member, retry a port.
 */
import { type ReactNode, useState } from "react";
import {
  ActionDialog,
  Badge,
  Button,
  Card,
  type Column,
  DataTable,
  Detail,
  ErrorNotice,
  Field,
  Icon,
  Input,
  Link,
  Mono,
  PageHeader,
  StatusDot,
  Textarea,
  fmtDate,
  tr,
  useInvalidate,
  useNavigate,
  useProjects,
} from "@rassvet/sdk";
import {
  BASE,
  DB,
  type AdminClusterDetail,
  type AdminCondition,
  type AdminMember,
  type AdminPort,
  type AdminProblem,
  type AdminProject,
  type AdminQuota,
  type AdminVolume,
  type QuotaOverrides,
  type QuotaSet,
  applySizing,
  clusterStatus,
  lockProject,
  putAdminQuota,
  resetAdminQuota,
  retryPort,
  statusText,
  unlockProject,
  useAdminProjects,
  useAdminQuota,
} from "./api";
import { RestartDialog } from "./Members";

// =========================================================================== projects

/** Quota resources in display order; `unit` follows the number. */
const RESOURCES: { key: keyof QuotaSet; label: () => string; unit?: string; step?: string }[] = [
  { key: "clusters", label: () => tr("Clusters") },
  { key: "cpu", label: () => tr("vCPU"), step: "0.5" },
  { key: "memory_mb", label: () => tr("Memory (MB)"), unit: "MB" },
  { key: "storage_gb", label: () => tr("Storage (GB)"), unit: "GB" },
  { key: "ports", label: () => tr("Ports") },
  { key: "backups", label: () => tr("Backups") },
];

const limitText = (n?: number) => (n == null ? "—" : n < 0 ? "∞" : String(n));

/** "used / limit", amber from 80 %, red when full. */
function Usage({ used, limit }: { used?: number; limit?: number }) {
  const full = limit != null && limit >= 0 && (used ?? 0) >= limit;
  const near = limit != null && limit > 0 && (used ?? 0) / limit >= 0.8;
  return (
    <span className={full ? "text-led-red" : near ? "text-led-amber" : undefined}>
      <span className="font-mono text-[12.5px]">
        {used ?? 0} / {limitText(limit)}
      </span>
    </span>
  );
}

export function Projects() {
  const q = useAdminProjects();
  const projects = useProjects(true);
  const navigate = useNavigate();
  const [open, setOpen] = useState<{ kind: "quota" | "reset" | "lock" | "unlock"; p: AdminProject } | null>(null);
  const close = () => setOpen(null);
  const name = (p: AdminProject) => projects.data?.find((x) => x.id === p.id)?.name ?? p.name ?? "";

  const columns: Column<AdminProject>[] = [
    {
      key: "name",
      header: tr("Project"),
      cell: (p) => (
        <div className="min-w-0">
          <p className="truncate font-medium">
            {name(p) || <Mono>{p.id}</Mono>}
            {p.locked && (
              <span className="ml-2 inline-flex align-middle" title={p.locked}>
                <Badge tone="warn">
                  <Icon name="lock" className="mr-1 size-3" />
                  {tr("Locked")}
                </Badge>
              </span>
            )}
          </p>
          {name(p) && <p className="truncate font-mono text-xs text-muted">{p.id}</p>}
        </div>
      ),
      value: (p) => `${name(p)} ${p.id} ${p.locked ? "locked" : ""}`,
      csv: (p) => p.id,
    },
    {
      key: "clusters",
      header: tr("Clusters"),
      width: "13rem",
      cell: (p) => {
        const entries = Object.entries(p.clusters ?? {}).filter(([, n]) => n > 0);
        if (!entries.length) return <span className="text-muted">{tr("None")}</span>;
        return (
          <Link to={`${BASE}/clusters?project=${p.id}`} className="flex flex-wrap gap-x-3 gap-y-0.5 hover:underline">
            {entries.map(([s, n]) => (
              <StatusDot key={s} status={clusterStatus(s)} label={`${n} ${statusText(s).toLowerCase()}`} />
            ))}
          </Link>
        );
      },
      value: (p) => Object.values(p.clusters ?? {}).reduce((a, b) => a + b, 0),
    },
    {
      key: "cluster-quota",
      header: tr("Cluster quota"),
      width: "8rem",
      hideBelow: "md",
      className: "text-right",
      cell: (p) => <Usage used={p.quota.usage.clusters} limit={p.quota.limits.clusters} />,
      value: (p) => p.quota.usage.clusters ?? 0,
    },
    ...RESOURCES.filter((r) => r.key !== "clusters").map(
      (r): Column<AdminProject> => ({
        key: r.key,
        header: r.label(),
        width: "8rem",
        hideBelow: r.key === "ports" || r.key === "backups" ? "xl" : "lg",
        className: "text-right",
        cell: (p) => <Usage used={p.quota.usage[r.key]} limit={p.quota.limits[r.key]} />,
        value: (p) => p.quota.usage[r.key] ?? 0,
      }),
    ),
  ];

  return (
    <>
      <PageHeader
        title={tr("Database service")}
        description={tr("Projects that use DBaaS: their clusters, usage and quota. Quotas differ from the cloud defaults only where they are overridden; a locked project keeps its clusters running but can't change anything.")}
      />
      <p className="mb-4 text-sm text-muted">
        {tr("DBaaS only accepts admin requests from its configured admin projects (or a system-scoped token). If this page says the request needs a DBaaS admin token, switch to such a project.")}
      </p>
      <ErrorNotice error={q.error} className="mb-4" />
      <DataTable
        rows={q.data}
        columns={columns}
        rowKey={(p) => p.id}
        loading={q.isPending}
        tableId="dbaas-admin-projects"
        noun={tr("projects")}
        rowLabel={(p) => name(p) || p.id}
        onRefresh={() => q.refetch()}
        refreshing={q.isFetching}
        empty={tr("No project uses DBaaS yet.")}
        filterPlaceholder={tr("Filter by project name or ID")}
        rowActions={(p) => [
          { label: tr("View clusters"), icon: "database", onSelect: () => navigate(`${BASE}/clusters?project=${p.id}`) },
          "-",
          { label: tr("Edit quota"), icon: "sliders-horizontal", onSelect: () => setOpen({ kind: "quota", p }) },
          { label: tr("Reset quota to defaults"), icon: "rotate-ccw", onSelect: () => setOpen({ kind: "reset", p }) },
          "-",
          p.locked
            ? { label: tr("Unlock project"), icon: "lock-open", onSelect: () => setOpen({ kind: "unlock", p }) }
            : { label: tr("Lock project"), icon: "lock", danger: true, onSelect: () => setOpen({ kind: "lock", p }) },
        ]}
      />
      {open?.kind === "quota" && <QuotaDialog project={open.p} name={name(open.p)} onClose={close} />}
      {open?.kind === "reset" && (
        <ActionDialog
          onClose={close}
          title={tr("Reset the quota of {name}?", { name: name(open.p) || open.p.id })}
          submitLabel={tr("Reset")}
          done={tr("Quota of {name} reset to the defaults", { name: name(open.p) || open.p.id })}
          refresh={[DB]}
          run={() => resetAdminQuota(open.p.id)}
        >
          <p className="text-sm">{tr("Every override is removed and the project gets the cloud's default limits. A limit below the current usage only blocks new usage; running clusters stay.")}</p>
        </ActionDialog>
      )}
      {open?.kind === "lock" && <LockDialog project={open.p} name={name(open.p)} onClose={close} />}
      {open?.kind === "unlock" && (
        <ActionDialog
          onClose={close}
          title={tr("Unlock {name}?", { name: name(open.p) || open.p.id })}
          submitLabel={tr("Unlock")}
          done={tr("{name} unlocked", { name: name(open.p) || open.p.id })}
          refresh={[DB]}
          run={() => unlockProject(open.p.id)}
        >
          <p className="text-sm">{tr("The project's users can create, change and delete clusters again.")}</p>
          {open.p.locked && <p className="text-sm text-muted">{tr("Locked because: {reason}", { reason: open.p.locked })}</p>}
        </ActionDialog>
      )}
    </>
  );
}

function QuotaDialog({ project, name, onClose }: { project: AdminProject; name: string; onClose: () => void }) {
  const q = useAdminQuota(project.id);
  return q.data ? <QuotaForm project={project} name={name} quota={q.data} onClose={onClose} /> : (
    <ActionDialog onClose={onClose} title={tr("Quota of {name}", { name: name || project.id })} submitLabel={tr("Save")} canSubmit={false} run={async () => undefined}>
      <ErrorNotice error={q.error} />
      {!q.error && <p className="text-sm text-muted">{tr("Loading…")}</p>}
    </ActionDialog>
  );
}

function QuotaForm({ project, name, quota, onClose }: { project: AdminProject; name: string; quota: AdminQuota; onClose: () => void }) {
  const invalidate = useInvalidate();
  // Backups only count when the cloud offers them (the default is then set).
  const resources = RESOURCES.filter((r) => r.key !== "backups" || (quota.defaults.backups ?? 0) > 0);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(resources.map((r) => [r.key, quota.overrides[r.key] != null ? String(quota.overrides[r.key]) : ""])),
  );
  const body: QuotaOverrides = {};
  let problem: string | false = false;
  for (const r of resources) {
    const v = values[r.key].trim();
    if (v === "") continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || (r.key !== "cpu" && !Number.isInteger(n))) problem = tr("{what}: a whole number, 0 or more", { what: r.label() });
    else body[r.key] = n;
  }
  const label = name || project.id;
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Quota of {name}", { name: label })}
      description={tr("Leave a field empty for the cloud's default. A limit below the current usage only blocks new usage; running clusters stay.")}
      submitLabel={tr("Save")}
      canSubmit={!problem}
      done={tr("Quota of {name} saved", { name: label })}
      refresh={[DB]}
      onDone={() => invalidate(DB)}
      run={() => putAdminQuota(project.id, body)}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {resources.map((r) => (
          <Field key={r.key} label={r.label()} hint={tr("In use {used} · default {def}", { used: quota.usage[r.key] ?? 0, def: limitText(quota.defaults[r.key]) })}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min={0}
                step={r.step ?? "1"}
                value={values[r.key]}
                placeholder={limitText(quota.defaults[r.key])}
                onChange={(e) => setValues({ ...values, [r.key]: e.target.value })}
              />
            )}
          </Field>
        ))}
      </div>
      {problem && <p className="text-sm text-led-red">{problem}</p>}
    </ActionDialog>
  );
}

function LockDialog({ project, name, onClose }: { project: AdminProject; name: string; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const r = reason.trim();
  const label = name || project.id;
  return (
    <ActionDialog
      onClose={onClose}
      danger
      size="md"
      title={tr("Lock {name}?", { name: label })}
      description={tr("The project's clusters keep running and can be read, but its users can't create, change or delete anything until it is unlocked. Admins are not blocked.")}
      submitLabel={tr("Lock project")}
      canSubmit={r.length > 0 && r.length <= 500}
      done={tr("{name} locked", { name: label })}
      refresh={[DB]}
      run={() => lockProject(project.id, r)}
    >
      <Field label={tr("Reason")} hint={tr("Shown to the project's users when a change is refused. {n} of 500.", { n: r.length })}>
        {(id) => <Textarea id={id} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={tr("e.g. Unpaid invoice, contact billing")} />}
      </Field>
    </ActionDialog>
  );
}

// =========================================================================== runtime tab

const podStatus = (m: AdminMember) => (m.ready ? "ok" : m.phase === "Failed" ? "error" : "warn");
const phaseStatus = (p: string) => (p === "Bound" ? "ok" : p === "Failed" || p === "Lost" ? "error" : "warn");

export function RuntimeTab({ c, onRefresh, refreshing }: { c: AdminClusterDetail; onRefresh: () => void; refreshing: boolean }) {
  const [open, setOpen] = useState<{ kind: "restart"; m: AdminMember } | { kind: "retry"; p: AdminPort } | { kind: "sizing" } | null>(null);
  const close = () => setOpen(null);

  const memberCols: Column<AdminMember>[] = [
    { key: "name", header: tr("Pod"), mono: true, cell: (m) => m.name, value: (m) => m.name },
    { key: "status", header: tr("Status"), width: "9rem", cell: (m) => <StatusDot status={podStatus(m)} label={m.ready ? tr("Ready") : m.phase} />, value: (m) => `${m.phase} ${m.ready}` },
    { key: "restarts", header: tr("Restarts"), width: "6rem", className: "text-right", cell: (m) => <span className={m.restarts > 0 ? "text-led-amber" : undefined}>{m.restarts}</span>, value: (m) => m.restarts },
    { key: "node", header: tr("Node"), width: "12rem", hideBelow: "md", mono: true, cell: (m) => m.node || "—", value: (m) => m.node ?? "" },
    { key: "ip", header: tr("Pod IP"), width: "9rem", hideBelow: "lg", mono: true, cell: (m) => m.pod_ip || "—", value: (m) => m.pod_ip ?? "" },
  ];
  const volumeCols: Column<AdminVolume>[] = [
    { key: "claim", header: tr("Claim"), mono: true, cell: (v) => v.claim, value: (v) => v.claim },
    { key: "phase", header: tr("Status"), width: "8rem", cell: (v) => <StatusDot status={phaseStatus(v.phase)} label={v.phase} />, value: (v) => v.phase },
    { key: "capacity", header: tr("Capacity"), width: "7rem", className: "text-right", cell: (v) => v.capacity || "—", value: (v) => v.capacity ?? "" },
    { key: "class", header: tr("Storage class"), width: "10rem", hideBelow: "md", cell: (v) => v.storage_class || "—", value: (v) => v.storage_class ?? "" },
    { key: "volume", header: tr("Volume"), hideBelow: "lg", mono: true, cell: (v) => v.volume || "—", value: (v) => v.volume ?? "" },
  ];
  const portCols: Column<AdminPort>[] = [
    { key: "claim", header: tr("Port claim"), mono: true, cell: (p) => p.claim, value: (p) => p.claim },
    {
      key: "phase",
      header: tr("Status"),
      width: "9rem",
      cell: (p) => (
        <span title={p.message}>
          <StatusDot status={phaseStatus(p.phase)} label={p.phase} />
        </span>
      ),
      value: (p) => `${p.phase} ${p.message ?? ""}`,
    },
    { key: "ip", header: tr("Address"), width: "9rem", mono: true, cell: (p) => p.ip || "—", value: (p) => p.ip ?? "" },
    { key: "host", header: tr("Host"), width: "12rem", hideBelow: "md", mono: true, cell: (p) => p.host || "—", value: (p) => p.host ?? "" },
    {
      key: "port",
      header: tr("Neutron port"),
      hideBelow: "lg",
      cell: (p) =>
        p.port_id ? (
          <Link to={`/network/ports?q=${p.port_id}`} className="font-mono text-[12.5px] text-cable hover:underline">
            {p.port_id}
          </Link>
        ) : (
          "—"
        ),
      value: (p) => p.port_id ?? "",
    },
  ];
  const condCols: Column<AdminCondition>[] = [
    { key: "type", header: tr("Condition"), width: "12rem", cell: (x) => x.type, value: (x) => x.type },
    { key: "status", header: tr("Status"), width: "7rem", cell: (x) => <StatusDot status={x.status === "True" ? "ok" : x.status === "False" ? "error" : "warn"} label={x.status} />, value: (x) => x.status },
    { key: "reason", header: tr("Reason"), width: "12rem", hideBelow: "md", cell: (x) => x.reason || "—", value: (x) => x.reason ?? "" },
    { key: "message", header: tr("Message"), hideBelow: "lg", cell: (x) => <span className="whitespace-normal">{x.message || "—"}</span>, value: (x) => x.message ?? "" },
  ];
  const lb = c.load_balancer;

  return (
    <div className="space-y-6">
      {(c.sizing_drift?.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-led-amber/40 bg-led-amber/10 px-3 py-2 text-sm">
          <div className="min-w-0">
            <p className="font-medium">{tr("The configuration isn't sized for the flavor")}</p>
            <p className="text-muted">
              {tr("These parameters differ from what DBaaS computes for {flavor} (the cluster was made before DBaaS sized configurations):", { flavor: c.flavor })}{" "}
              <span className="font-mono text-xs">{c.sizing_drift?.join(", ")}</span>
            </p>
          </div>
          <Button className="h-8" onClick={() => setOpen({ kind: "sizing" })} disabled={c.status !== "ready"} title={c.status !== "ready" ? tr("The cluster isn't ready") : undefined}>
            <Icon name="scaling" />
            {tr("Apply sizing")}
          </Button>
        </div>
      )}
      {(c.problems ?? []).map((p: AdminProblem) => (
        <div key={`${p.member}-${p.reason}`} className="rounded-md border border-led-red/40 bg-led-red/10 px-3 py-2 text-sm">
          <p className="font-medium">
            <Icon name="warning" className="mr-1.5 inline size-3.5 align-[-2px]" />
            {tr("{member}: {reason} since {since}", { member: p.member, reason: p.reason, since: fmtDate(p.since) ?? p.since })}
          </p>
          {p.detail && <p className="mt-1 whitespace-pre-wrap font-mono text-xs text-muted">{p.detail}</p>}
        </div>
      ))}
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Card title={tr("Placement")}>
          <dl>
            <Detail label={tr("Project")}>
              <Mono>{c.project_id}</Mono>
            </Detail>
            <Detail label={tr("Namespace")}>
              <Mono>{c.namespace ?? "—"}</Mono>
            </Detail>
            {c.operator && (
              <Detail label={tr("Operator status")} wrap>
                {c.operator.status || "—"}
                {c.operator.message && <span className="block text-xs text-muted">{c.operator.message}</span>}
              </Detail>
            )}
          </dl>
        </Card>
        {lb && (
          <Card title={tr("Load balancer")}>
            <dl>
              {lb.id && (
                <Detail label="ID">
                  <Link to={`/ext/octavia/load-balancers/${lb.id}`} className="font-mono text-[12.5px] text-cable hover:underline">
                    {lb.id}
                  </Link>
                </Detail>
              )}
              {lb.vip && (
                <Detail label="VIP">
                  <Mono>{lb.vip}</Mono>
                </Detail>
              )}
              {lb.floating_ip && (
                <Detail label={tr("Floating IP")}>
                  <Mono>{lb.floating_ip}</Mono>
                </Detail>
              )}
              <Detail label={tr("Members online")}>{lb.online_members}</Detail>
            </dl>
          </Card>
        )}
      </div>
      <Section title={tr("Pods")}>
        <DataTable
          rows={c.members ?? []}
          columns={memberCols}
          rowKey={(m) => m.name}
          tableId="dbaas-admin-pods"
          noun={tr("pods")}
          onRefresh={onRefresh}
          refreshing={refreshing}
          empty={tr("No pods.")}
          rowActions={(m) => [{ label: tr("Restart"), icon: "refresh", onSelect: () => setOpen({ kind: "restart", m }) }]}
        />
      </Section>
      <Section title={tr("Network ports")}>
        <DataTable
          rows={c.ports ?? []}
          columns={portCols}
          rowKey={(p) => p.claim}
          tableId="dbaas-admin-ports"
          noun={tr("ports")}
          empty={tr("No port claims.")}
          rowActions={(p) => [{ label: tr("Retry"), icon: "refresh", disabled: p.phase === "Bound" && tr("Already bound"), onSelect: () => setOpen({ kind: "retry", p }) }]}
        />
      </Section>
      <Section title={tr("Volumes")}>
        <DataTable rows={c.volumes ?? []} columns={volumeCols} rowKey={(v) => v.claim} tableId="dbaas-admin-volumes" noun={tr("volumes")} empty={tr("No volumes.")} />
      </Section>
      <Section title={tr("Conditions")}>
        <DataTable rows={c.conditions ?? []} columns={condCols} rowKey={(x) => x.type} tableId="dbaas-admin-conditions" noun={tr("conditions")} empty={tr("No conditions.")} />
      </Section>

      {open?.kind === "restart" && <RestartDialog c={c} m={{ name: open.m.name, ready: open.m.ready }} admin onClose={close} />}
      {open?.kind === "sizing" && (
        <ActionDialog
          onClose={close}
          title={tr("Apply the flavor sizing to {name}?", { name: c.name })}
          submitLabel={tr("Apply sizing")}
          done={tr("Applying the flavor sizing to {name}", { name: c.name })}
          refresh={[DB]}
          run={() => applySizing(c)}
        >
          <p className="text-sm">{tr("DBaaS writes the parameters it computes for the flavor (buffer pool, connections, caches…) and keeps the others. MySQL and MongoDB members restart one by one; PostgreSQL restarts in place.")}</p>
          <p className="text-sm text-muted">{tr("Tell the project first: this is their cluster.")}</p>
        </ActionDialog>
      )}
      {open?.kind === "retry" && (
        <ActionDialog
          onClose={close}
          title={tr("Retry port {claim}?", { claim: open.p.claim })}
          submitLabel={tr("Retry")}
          done={tr("Retrying port {claim}", { claim: open.p.claim })}
          refresh={[DB]}
          run={() => retryPort(c, open.p.claim)}
        >
          <p className="text-sm">{tr("dbaas-controller reconciles the port claim now instead of waiting for its back-off.")}</p>
          {open.p.message && <p className="text-sm text-muted">{open.p.message}</p>}
        </ActionDialog>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h2 className="mb-3 text-base font-semibold">{title}</h2>
      {children}
    </div>
  );
}
