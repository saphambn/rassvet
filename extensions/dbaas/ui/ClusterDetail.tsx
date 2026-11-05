/**
 * Database cluster detail: overview, how to connect, allowed networks, backups and restores, observing.
 * Admins open it as `projects/:project/clusters/:id` and act on behalf of the project; they also get the
 * Runtime tab (pods, volumes, ports, load balancer, problems) and no credentials.
 */
import { type ReactNode, useState } from "react";
import {
  ActionDialog,
  ActionMenu,
  Badge,
  Button,
  Card,
  type Column,
  CopyButton,
  DataTable,
  Detail,
  ErrorNotice,
  Field,
  Icon,
  Input,
  Link,
  Mono,
  PageHeader,
  Picker,
  StatusDot,
  Switch,
  Tabs,
  Textarea,
  downloadText,
  fmtDate,
  tr,
  useMutation,
  useNavigate,
  useNetworks,
  useParams,
  useSubnets,
  useTab,
  useToast,
  useInvalidate,
} from "@rassvet/sdk";
import {
  BASE,
  type Backup,
  type BackupPolicy,
  type Credentials,
  DB,
  type DbCluster,
  type Restore,
  clusterStatus,
  deleteBackup,
  engineLabel,
  fetchCredentials,
  hasProxies,
  jobStatus,
  proxyName,
  putAllowedCidrs,
  putFloatingIp,
  putBackupPolicy,
  restoreCluster,
  statusText,
  takeBackup,
  uriWithUser,
  useAdminCluster,
  useAllowedCidrs,
  useBackupPolicy,
  useBackups,
  useDbCluster,
  useEndpoints,
  useFloatingIp,
  useRestores,
  validCidr,
} from "./api";
import { parseCidrs, toUtc, useClusterActions } from "./Clusters";
import { RuntimeTab } from "./Admin";
import { EventsTab, LogsTab, MonitoringTab, QueriesTab } from "./Observe";
import { ParametersTab } from "./Parameters";
import { Instances } from "./Members";

export function Back({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
      <Icon name="arrow-left" className="size-3.5" />
      {children}
    </Link>
  );
}

const TABS = ["overview", "monitoring", "connect", "access", "backups", "logs", "events", "queries", "parameters", "runtime"] as const;

export default function ClusterDetail() {
  const { id: name = "", project = "" } = useParams();
  const navigate = useNavigate();
  // Admins (projects/:project/clusters/:id) read the detail view, which also says where the cluster runs.
  const own = useDbCluster({ name: project ? "" : name });
  const adm = useAdminCluster({ name, project_id: project || undefined });
  const q = project ? adm : own;
  const c = q.data;
  const list = project ? `${BASE}/clusters?project=${project}` : `${BASE}/clusters`;
  const actions = useClusterActions({ onDeleted: () => navigate(list) });
  const [tab, setTab] = useTab(TABS, "overview");

  return (
    <>
      <Back to={list}>{project ? tr("All database clusters") : tr("Database clusters")}</Back>
      <PageHeader
        title={c?.name ?? name}
        description={
          c && (
            <span className="inline-flex flex-wrap items-center gap-x-4 gap-y-1">
              <StatusDot status={clusterStatus(c.status)} label={statusText(c.status)} />
              <span>
                {engineLabel(c.engine)} {c.version}
              </span>
            </span>
          )
        }
        actions={c && <ActionMenu variant="button" items={() => actions.items(c, "detail")} />}
      />
      <ErrorNotice error={q.error} className="mb-4" />
      {c && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            className="mb-5"
            tabs={[
              { id: "overview", label: tr("Overview") },
              { id: "monitoring", label: tr("Monitoring") },
              { id: "connect", label: tr("Connect") },
              { id: "access", label: tr("Access") },
              { id: "backups", label: tr("Backups") },
              { id: "logs", label: tr("Logs") },
              { id: "events", label: tr("Events") },
              { id: "queries", label: tr("Queries") },
              { id: "parameters", label: tr("Parameters") },
              ...(project ? [{ id: "runtime" as const, label: tr("Runtime") }] : []),
            ]}
          />
          {tab === "overview" && <Overview c={c} />}
          {tab === "connect" && <Connect c={c} />}
          {tab === "access" && <Access c={c} />}
          {tab === "backups" && <Backups c={c} />}
          {tab === "monitoring" && <MonitoringTab c={c} />}
          {tab === "logs" && <LogsTab c={c} />}
          {tab === "events" && <EventsTab c={c} />}
          {tab === "queries" && <QueriesTab c={c} />}
          {tab === "parameters" && <ParametersTab c={c} />}
          {tab === "runtime" && adm.data && <RuntimeTab c={adm.data} onRefresh={() => adm.refetch()} refreshing={adm.isFetching} />}
        </>
      )}
      {actions.dialogs}
    </>
  );
}

// =========================================================================== overview

function Overview({ c }: { c: DbCluster }) {
  const networks = useNetworks();
  const subnets = useSubnets();
  const net = networks.data?.find((n) => n.id === c.network_id);
  const sub = subnets.data?.find((s) => s.id === c.subnet_id);
  return (
    <div className="grid items-start gap-6 xl:grid-cols-2">
      <Card title={tr("Details")}>
        <dl>
          <Detail label={tr("Name")}>{c.name}</Detail>
          <Detail label={tr("Engine")}>
            {engineLabel(c.engine)} {c.version}
          </Detail>
          <Detail label={tr("Status")}>
            <StatusDot status={clusterStatus(c.status)} label={statusText(c.status)} />
          </Detail>
          {c.status_reason && (
            <Detail label={tr("Status reason")} wrap>
              {c.status_reason}
            </Detail>
          )}
          {c.created_at && <Detail label={tr("Created")}>{fmtDate(c.created_at)}</Detail>}
        </dl>
      </Card>
      <div className="space-y-6">
        <Card title={tr("Size")}>
          <dl>
            <Detail label={tr("Members")}>{tr("{ready} of {n} ready", { ready: c.ready_replicas ?? "?", n: c.replicas })}</Detail>
            <Detail label={tr("Flavor")}>{c.flavor}</Detail>
            <Detail label={tr("Storage per member")}>{c.storage_gb} GB</Detail>
            {hasProxies(c.engine) && <Detail label={proxyName(c.engine)}>{c.proxy_replicas ?? "—"}</Detail>}
          </dl>
        </Card>
        <Card title={tr("Network")}>
          <dl>
            <Detail label={tr("Network")}>
              <Link to={`/network/networks/${c.network_id}`} className="text-cable hover:underline">
                {net?.name || <Mono>{c.network_id}</Mono>}
              </Link>
            </Detail>
            <Detail label={tr("Subnet")}>
              {sub ? (
                <>
                  {sub.name || sub.id} <Mono className="text-muted">{sub.cidr}</Mono>
                </>
              ) : (
                <Mono>{c.subnet_id}</Mono>
              )}
            </Detail>
            {hasProxies(c.engine) && <Detail label={tr("Floating IP")}>{c.floating_ip ? tr("Yes") : tr("No")}</Detail>}
            <Detail label={tr("Other allowed CIDRs")} wrap>
              {c.allowed_cidrs?.length ? <Mono>{c.allowed_cidrs.join(", ")}</Mono> : tr("None")}
            </Detail>
          </dl>
        </Card>
      </div>
      <div className="space-y-6 xl:col-span-2">
        <Instances c={c} />
      </div>
    </div>
  );
}

// =========================================================================== connect

function Connect({ c }: { c: DbCluster }) {
  const ep = useEndpoints(c, c.status !== "creating" && c.status !== "deleting");
  const e = ep.data;
  const [creds, setCreds] = useState<Credentials | null>(null);
  const reveal = useMutation({ mutationFn: () => fetchCredentials(c), onSuccess: setCreds });

  const memberCols: Column<{ hostname?: string; address?: string; ready?: boolean }>[] = [
    { key: "hostname", header: tr("Hostname"), mono: true, cell: (m) => m.hostname || "—", value: (m) => m.hostname ?? "" },
    { key: "address", header: tr("Address"), width: "10rem", mono: true, cell: (m) => m.address || "—", value: (m) => m.address ?? "" },
    { key: "ready", header: tr("Ready"), width: "7rem", cell: (m) => <StatusDot status={m.ready ? "ok" : "warn"} label={m.ready ? tr("Yes") : tr("No")} />, value: (m) => String(!!m.ready) },
  ];

  if (c.status === "creating") return <p className="text-sm text-muted">{tr("Connection details appear once the cluster is created.")}</p>;
  return (
    <div className="grid items-start gap-6 xl:grid-cols-2">
      <div className="space-y-6">
        <ErrorNotice error={ep.error} />
        {e && (
          <Card title={tr("Endpoint")} actions={e.uri ? <CopyButton className="h-8" text={creds ? uriWithUser(e.uri, creds.username) : e.uri} label={tr("Copy URI")} /> : undefined}>
            <dl>
              <Detail label={tr("Type")}>{e.type === "replica_set" ? tr("Replica set (one address per member)") : tr("Load balancer")}</Detail>
              {e.hostname && (
                <Detail label={tr("Hostname")}>
                  <Mono>{e.hostname}</Mono>
                </Detail>
              )}
              {e.address && (
                <Detail label={tr("Address")}>
                  <Mono>{e.address}</Mono>
                </Detail>
              )}
              {e.floating_ip && (
                <Detail label={tr("Floating IP")}>
                  <Mono>{e.floating_ip}</Mono>
                </Detail>
              )}
              <Detail label={tr("Port")}>{e.port}</Detail>
              {e.uri && (
                <Detail label="URI" wrap>
                  <Mono>{creds ? uriWithUser(e.uri, creds.username) : e.uri}</Mono>
                </Detail>
              )}
              {e.ca_certificate && (
                <Detail label={tr("CA certificate")}>
                  <button type="button" className="text-cable hover:underline" onClick={() => downloadText(`${c.name}-ca.pem`, e.ca_certificate as string, "application/x-pem-file")}>
                    {tr("Download")}
                  </button>
                </Detail>
              )}
            </dl>
          </Card>
        )}
        {/* MySQL/PostgreSQL proxies are listed in the overview: clients use the VIP. */}
        {e?.type === "replica_set" && e.members && e.members.length > 0 && (
          <DataTable rows={e.members} columns={memberCols} rowKey={(m) => m.hostname ?? m.address ?? ""} tableId="dbaas-members" noun={tr("members")} empty={tr("No members yet.")} />
        )}
        <p className="text-sm text-muted">
          {tr("The database is only reachable from the cluster's subnet and the allowed CIDRs. Hostnames resolve through the network's internal DNS.")}
          {c.engine === "mongodb" && " " + tr("Connections use TLS: give clients the CA certificate.")}
        </p>
      </div>
      {c.project_id ? (
        <Card title={tr("Administrative user")}>
          <p className="text-sm text-muted">{tr("Database credentials are only shown to the project's own users.")}</p>
        </Card>
      ) : (
      <Card
        title={tr("Administrative user")}
        actions={
          creds ? (
            <Button className="h-8" onClick={() => setCreds(null)}>
              <Icon name="eye-off" />
              {tr("Hide")}
            </Button>
          ) : (
            <Button className="h-8" onClick={() => reveal.mutate()} disabled={reveal.isPending}>
              <Icon name="eye" />
              {tr("Show")}
            </Button>
          )
        }
      >
        <ErrorNotice error={reveal.error} className="mb-3" />
        {creds ? (
          <dl>
            <Detail label={tr("Username")}>
              <span className="inline-flex items-center gap-2">
                <Mono>{creds.username}</Mono>
                <CopyButton className="h-7" text={creds.username} />
              </span>
            </Detail>
            <Detail label={tr("Password")}>
              <span className="inline-flex items-center gap-2">
                <Mono>{creds.password}</Mono>
                <CopyButton className="h-7" text={creds.password} />
              </span>
            </Detail>
          </dl>
        ) : (
          <p className="text-sm text-muted">{tr("The user that owns every database of the cluster. Showing it needs the member or admin role in the project.")}</p>
        )}
      </Card>
      )}
    </div>
  );
}

// =========================================================================== access

function Access({ c }: { c: DbCluster }) {
  return (
    <div className="max-w-2xl space-y-6">
      {hasProxies(c.engine) && <FloatingIpCard c={c} />}
      <AllowedCidrs c={c} />
    </div>
  );
}

/** Floating IP of the VIP (mysql, postgresql): allocated in DBaaS's project on the cloud's external network. */
function FloatingIpCard({ c }: { c: DbCluster }) {
  const q = useFloatingIp(c, c.status !== "creating" && c.status !== "deleting");
  const cidrs = useAllowedCidrs(c);
  const [confirm, setConfirm] = useState<boolean | null>(null);
  const f = q.data;
  const busy = !!f && f.enabled !== !!f.address && !f.external;
  return (
    <Card title={tr("Floating IP")}>
      <p className="mb-3 text-sm text-muted">
        {tr("A public address for the load balancer, on the cloud's external network. Clients still need their CIDR in the allowed CIDRs below: the load balancer keeps the client's source address.")}
      </p>
      <ErrorNotice error={q.error} className="mb-3" />
      {f && (
        <div className="space-y-3">
          <Switch
            checked={f.enabled || !!f.external}
            onChange={(v) => setConfirm(v)}
            disabled={!!f.external || c.status === "deleting"}
            label={f.enabled || f.external ? tr("On") : tr("Off")}
            hint={f.external ? tr("Attached by the cloud operator: DBaaS neither manages nor removes it.") : undefined}
          />
          <dl>
            <Detail label={tr("Address")}>
              {f.address ? (
                <span className="inline-flex items-center gap-1">
                  <Mono>{f.address}</Mono>
                  <CopyButton text={f.address} label="" className="h-6 px-1.5" />
                  {f.external && <Badge tone="warn">{tr("external")}</Badge>}
                </span>
              ) : busy ? (
                <span className="text-muted">{tr("Being allocated…")}</span>
              ) : (
                <span className="text-muted">—</span>
              )}
            </Detail>
          </dl>
          {f.message && <p className={/only the cluster's subnet/.test(f.message) ? "text-sm text-led-amber" : "text-sm text-muted"}>{f.message}</p>}
        </div>
      )}
      {confirm !== null && (
        <ActionDialog
          onClose={() => setConfirm(null)}
          title={confirm ? tr("Give {name} a floating IP?", { name: c.name }) : tr("Remove the floating IP of {name}?", { name: c.name })}
          submitLabel={confirm ? tr("Turn on") : tr("Remove")}
          danger={!confirm}
          done={(r: { message?: string }) => r?.message || (confirm ? tr("Allocating a floating IP for {name}", { name: c.name }) : tr("Releasing the floating IP of {name}", { name: c.name }))}
          refresh={[DB]}
          run={() => putFloatingIp(c, confirm)}
        >
          {confirm ? (
            <div className="space-y-2 text-sm">
              <p>{tr("The address is allocated within seconds and shown here. It makes the database reachable from outside, for the CIDRs you allow.")}</p>
              {!cidrs.data?.length && <p className="text-led-amber">{tr("No other CIDR is allowed yet: only the cluster's subnet could connect. Add the clients' CIDRs below.")}</p>}
            </div>
          ) : (
            <p className="text-sm">{tr("The address {ip} is released: clients that use it can no longer connect. A new one may differ.", { ip: f?.address ?? "" })}</p>
          )}
        </ActionDialog>
      )}
    </Card>
  );
}

function AllowedCidrs({ c }: { c: DbCluster }) {
  const q = useAllowedCidrs(c);
  const toast = useToast();
  const invalidate = useInvalidate();
  const [text, setText] = useState<string | null>(null);
  const value = text ?? (q.data ?? []).join("\n");
  const list = parseCidrs(value);
  const bad = list.find((x) => !validCidr(x));
  const save = useMutation({
    mutationFn: () => putAllowedCidrs(c, list),
    onSuccess: () => {
      toast(tr("Allowed CIDRs of {name} saved", { name: c.name }));
      setText(null);
      invalidate(DB);
    },
  });
  const changed = text !== null && list.join(",") !== (q.data ?? []).join(",");
  return (
    <Card title={tr("Allowed CIDRs")}>
      <p className="mb-3 text-sm text-muted">
        {tr("The cluster's subnet can always reach the database. Add the CIDRs of other networks (behind a router, a VPN or, with a floating IP, the internet) that should reach it too; they go into the cluster's security group.")}
      </p>
      <ErrorNotice error={q.error ?? save.error} className="mb-3" />
      <Field label={tr("One CIDR per line")} hint={bad ? <span className="text-led-red">{tr("Not a CIDR: {c}", { c: bad })}</span> : tr("{n} of 50", { n: list.length })}>
        {(id) => <Textarea id={id} rows={6} className="font-mono" value={value} onChange={(e) => setText(e.target.value)} placeholder="10.20.0.0/24" disabled={q.isPending} />}
      </Field>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={() => setText(null)} disabled={!changed || save.isPending}>
          {tr("Reset")}
        </Button>
        <Button variant="primary" onClick={() => save.mutate()} disabled={!changed || !!bad || list.length > 50 || save.isPending}>
          {tr("Save")}
        </Button>
      </div>
    </Card>
  );
}

// =========================================================================== backups

function Backups({ c }: { c: DbCluster }) {
  const backups = useBackups(c);
  const policy = useBackupPolicy(c);
  const restores = useRestores(c);
  const [open, setOpen] = useState<{ kind: "policy"; enable?: boolean } | { kind: "off" } | { kind: "take" } | { kind: "restore"; b?: Backup } | { kind: "delete"; b: Backup } | null>(null);
  const close = () => setOpen(null);
  // 501: the cloud has no backup storage.
  const unsupported = !!policy.error && "status" in policy.error && policy.error.status === 501;
  if (unsupported) return <p className="text-sm text-muted">{tr("This cloud doesn't offer database backups.")}</p>;
  const p = policy.data;

  const cols: Column<Backup>[] = [
    { key: "created", header: tr("Started"), cell: (b) => fmtDate(b.created_at), value: (b) => b.created_at },
    { key: "type", header: tr("Type"), width: "8rem", cell: (b) => (b.type === "scheduled" ? <Badge>{tr("Scheduled")}</Badge> : <Badge tone="accent">{tr("Manual")}</Badge>), value: (b) => b.type },
    {
      key: "status",
      header: tr("Status"),
      width: "10rem",
      cell: (b) => (
        <span title={b.status_reason}>
          <StatusDot status={jobStatus(b.status)} label={statusText(b.status)} />
        </span>
      ),
      value: (b) => `${b.status} ${b.status_reason ?? ""}`,
    },
    { key: "size", header: tr("Size"), width: "7rem", hideBelow: "md", className: "text-right", cell: (b) => b.size || "—", value: (b) => b.size ?? "" },
    { key: "completed", header: tr("Completed"), hideBelow: "lg", cell: (b) => fmtDate(b.completed_at) ?? "—", value: (b) => b.completed_at ?? "" },
    { key: "pitr", header: tr("Restorable until"), hideBelow: "xl", cell: (b) => fmtDate(b.latest_restorable_time) ?? "—", value: (b) => b.latest_restorable_time ?? "" },
  ];
  const restoreCols: Column<Restore>[] = [
    { key: "created", header: tr("Started"), cell: (r) => fmtDate(r.created_at), value: (r) => r.created_at },
    { key: "backup", header: tr("Backup"), mono: true, hideBelow: "md", cell: (r) => r.backup || "—", value: (r) => r.backup ?? "" },
    { key: "time", header: tr("Point in time"), hideBelow: "lg", cell: (r) => fmtDate(r.restore_time) ?? "—", value: (r) => r.restore_time ?? "" },
    {
      key: "status",
      header: tr("Status"),
      width: "10rem",
      cell: (r) => (
        <span title={r.status_reason}>
          <StatusDot status={jobStatus(r.status)} label={statusText(r.status)} />
        </span>
      ),
      value: (r) => `${r.status} ${r.status_reason ?? ""}`,
    },
  ];
  const notReady = c.status !== "ready" && tr("The cluster isn't ready");
  /** Scheduled backups or point-in-time recovery. */
  const auto = !!p && (!!p.schedule || !!p.pitr);

  return (
    <div className="space-y-6">
      <Card
        title={tr("Backup policy")}
        actions={
          <div className="flex items-center gap-4">
            {p && <Switch checked={auto} onChange={(on) => setOpen(on ? { kind: "policy", enable: true } : { kind: "off" })} label={auto ? tr("On") : tr("Off")} />}
            <Button className="h-8" onClick={() => setOpen({ kind: "policy" })} disabled={!p}>
              <Icon name="edit" />
              {tr("Edit")}
            </Button>
          </div>
        }
      >
        <ErrorNotice error={policy.error} className="mb-3" />
        {p && !auto && <p className="text-sm text-muted">{tr("Automatic backups are off: only the backups you take with Back up now are made. Turn them on to back up on a schedule and, optionally, restore to any point in time.")}</p>}
        {p && auto && (
          <dl>
            <Detail label={tr("Schedule (UTC)")}>{p.schedule ? <Mono>{p.schedule}</Mono> : tr("No scheduled backups")}</Detail>
            <Detail label={tr("Scheduled backups kept")}>{p.retention ?? "—"}</Detail>
            <Detail label={tr("Point-in-time recovery")}>{p.pitr ? tr("On") : tr("Off")}</Detail>
          </dl>
        )}
      </Card>
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">{tr("Backups")}</h2>
          <div className="flex gap-2">
            <Button onClick={() => setOpen({ kind: "restore" })} disabled={!!notReady} title={notReady || undefined}>
              <Icon name="archive-restore" />
              {tr("Restore")}
            </Button>
            <Button variant="primary" onClick={() => setOpen({ kind: "take" })} disabled={!!notReady} title={notReady || undefined}>
              <Icon name="database-backup" />
              {tr("Back up now")}
            </Button>
          </div>
        </div>
        <ErrorNotice error={backups.error} className="mb-3" />
        <DataTable
          rows={backups.data}
          columns={cols}
          rowKey={(b) => b.id}
          loading={backups.isPending}
          tableId="dbaas-backups"
          noun={tr("backups")}
          rowLabel={(b) => fmtDate(b.created_at) ?? b.id}
          onRefresh={() => backups.refetch()}
          refreshing={backups.isFetching}
          empty={tr("No backups yet.")}
          rowActions={(b) => [
            { label: tr("Restore from this backup"), icon: "archive-restore", disabled: (b.status !== "succeeded" && tr("Not finished")) || notReady, onSelect: () => setOpen({ kind: "restore", b }) },
            "-",
            { label: tr("Delete backup"), icon: "trash", danger: true, disabled: b.status === "running" && tr("Running"), onSelect: () => setOpen({ kind: "delete", b }) },
          ]}
        />
      </div>
      <div>
        <h2 className="mb-3 text-base font-semibold">{tr("Restores")}</h2>
        <ErrorNotice error={restores.error} className="mb-3" />
        <DataTable rows={restores.data} columns={restoreCols} rowKey={(r) => r.id} loading={restores.isPending} tableId="dbaas-restores" noun={tr("restores")} empty={tr("No restores.")} />
      </div>

      {open?.kind === "policy" && p && <PolicyDialog c={c} policy={p} enable={open.enable} onClose={close} />}
      {open?.kind === "off" && p && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Turn off automatic backups of {name}?", { name: c.name })}
          submitLabel={tr("Turn off")}
          done={tr("Automatic backups of {name} turned off", { name: c.name })}
          refresh={[DB]}
          run={() => putBackupPolicy(c, { schedule: "", pitr: false })}
        >
          <p className="text-sm">
            {p.pitr
              ? tr("Scheduled backups stop and point-in-time recovery is turned off: the cluster can then only be restored to a full backup.")
              : tr("Scheduled backups stop.")}{" "}
            {tr("Backups already taken are kept (and count against the quota) until you delete them; Back up now still works.")}
          </p>
          {p.pitr && <p className="text-sm text-led-amber">{tr("Turning point-in-time recovery off may restart the database members once.")}</p>}
        </ActionDialog>
      )}
      {open?.kind === "take" && (
        <ActionDialog onClose={close} title={tr("Back up {name}?", { name: c.name })} submitLabel={tr("Back up now")} done={tr("Backing up {name}", { name: c.name })} refresh={[DB]} run={() => takeBackup(c)}>
          <p className="text-sm">{tr("A full backup is taken now and kept in the cloud's object storage. It counts against the backups quota until you delete it.")}</p>
        </ActionDialog>
      )}
      {open?.kind === "restore" && <RestoreDialog c={c} backups={backups.data ?? []} initial={open.b} pitr={!!p?.pitr} onClose={close} />}
      {open?.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete this backup?")}
          submitLabel={tr("Delete backup")}
          done={tr("Deleting the backup")}
          refresh={[DB]}
          run={() => deleteBackup(c, open.b.id)}
        >
          <p className="text-sm">{tr("The backup of {date} is deleted from the object storage. It can't be restored afterwards.", { date: fmtDate(open.b.created_at) ?? open.b.id })}</p>
        </ActionDialog>
      )}
    </div>
  );
}

/** Cron presets; anything else can be typed. */
const SCHEDULES = [
  { value: "", label: () => tr("No scheduled backups") },
  { value: "0 * * * *", label: () => tr("Every hour") },
  { value: "0 */6 * * *", label: () => tr("Every 6 hours") },
  { value: "0 2 * * *", label: () => tr("Every day at 02:00 UTC") },
  { value: "0 2 * * 0", label: () => tr("Every Sunday at 02:00 UTC") },
];
const CRON = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/;

/** `enable`: opened by the On switch, so start from a daily schedule when there is none. */
function PolicyDialog({ c, policy, enable, onClose }: { c: DbCluster; policy: BackupPolicy; enable?: boolean; onClose: () => void }) {
  const preset = SCHEDULES.some((s) => s.value === policy.schedule);
  const [mode, setMode] = useState(enable && !policy.schedule ? "0 2 * * *" : preset ? policy.schedule : "custom");
  const [custom, setCustom] = useState(preset ? "" : policy.schedule);
  const [retention, setRetention] = useState(String(policy.retention ?? ""));
  const [pitr, setPitr] = useState(!!policy.pitr);
  const schedule = mode === "custom" ? custom.trim() : mode;
  const problem = mode === "custom" && !CRON.test(schedule) ? tr("Five fields: minute hour day month weekday") : retention !== "" && !(Number(retention) >= 1) ? tr("Keep at least one backup") : false;
  const restarts = !!policy.schedule !== !!schedule || policy.pitr !== pitr;
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={enable ? tr("Turn on automatic backups of {name}", { name: c.name }) : tr("Backup policy of {name}", { name: c.name })}
      submitLabel={enable ? tr("Turn on") : tr("Save")}
      canSubmit={!problem}
      done={tr("Backup policy of {name} saved", { name: c.name })}
      refresh={[DB]}
      run={() => putBackupPolicy(c, { schedule, ...(retention !== "" ? { retention: Number(retention) } : {}), pitr })}
    >
      <Field label={tr("Schedule")}>
        {(id) => (
          <Picker
            id={id}
            value={mode}
            onChange={setMode}
            options={[...SCHEDULES.map((s) => ({ value: s.value, label: s.label(), description: s.value || undefined })), { value: "custom", label: tr("Custom (cron, UTC)") }]}
          />
        )}
      </Field>
      {mode === "custom" && (
        <Field label={tr("Cron expression (UTC)")} hint={tr("At most every 15 minutes.")}>
          {(id) => <Input id={id} className="font-mono" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="30 1 * * *" />}
        </Field>
      )}
      <Field label={tr("Scheduled backups kept")} hint={c.engine === "postgresql" ? tr("PostgreSQL applies it to every full backup, manual ones included.") : tr("Empty: the cloud's default.")}>
        {(id) => <Input id={id} type="number" min={1} value={retention} onChange={(e) => setRetention(e.target.value)} />}
      </Field>
      <Switch checked={pitr} onChange={setPitr} label={tr("Point-in-time recovery")} hint={tr("Ship the oplog / binlog / WAL continuously, to restore to any second after a backup.")} />
      {restarts && <p className="text-sm text-led-amber">{tr("Turning backups or point-in-time recovery on or off may restart the database members once.")}</p>}
      {problem && <p className="text-sm text-led-red">{problem}</p>}
    </ActionDialog>
  );
}

function RestoreDialog({ c, backups, initial, pitr, onClose }: { c: DbCluster; backups: Backup[]; initial?: Backup; pitr: boolean; onClose: () => void }) {
  const done = backups.filter((b) => b.status === "succeeded");
  const [backup, setBackup] = useState(initial?.id ?? "");
  const [time, setTime] = useState("");
  const [confirm, setConfirm] = useState("");
  const badTime = time !== "" && Number.isNaN(Date.parse(time));
  return (
    <ActionDialog
      onClose={onClose}
      danger
      size="md"
      title={tr("Restore {name}", { name: c.name })}
      description={tr("Overwrites the cluster's data in place. The cluster shows Updating until done; addresses and hostnames stay the same and clients reconnect.")}
      submitLabel={tr("Restore")}
      canSubmit={(!!backup || !!time) && !badTime && confirm === c.name}
      done={tr("Restoring {name}", { name: c.name })}
      refresh={[DB]}
      run={() => restoreCluster(c, { ...(backup ? { backup } : {}), ...(time ? { restore_time: toUtc(time) } : {}) })}
    >
      <Field label={tr("Backup")} hint={pitr ? tr("Empty with a point in time: the newest backup before it.") : undefined}>
        {(id) => (
          <Picker
            id={id}
            value={backup}
            onChange={setBackup}
            emptyText={tr("No finished backups")}
            options={[
              ...(pitr ? [{ value: "", label: tr("Newest before the point in time") }] : []),
              ...done.map((b) => ({ value: b.id, label: fmtDate(b.completed_at ?? b.created_at) ?? b.id, description: [b.type === "scheduled" ? tr("scheduled") : tr("manual"), b.size].filter(Boolean).join(" · ") })),
            ]}
          />
        )}
      </Field>
      {pitr && (
        <Field label={tr("Point in time (optional)")} hint={tr("Your local time, to the second.")}>
          {(id) => <Input id={id} type="datetime-local" step={1} value={time} onChange={(e) => setTime(e.target.value)} />}
        </Field>
      )}
      <Field label={tr("Type {name} to confirm", { name: c.name })}>
        {(id) => <Input id={id} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />}
      </Field>
    </ActionDialog>
  );
}
