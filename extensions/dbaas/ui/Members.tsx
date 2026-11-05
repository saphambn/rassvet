/**
 * The instances of a cluster (DBaaS Phase 12): its members (database and proxy pods, PostgreSQL primary and
 * replicas), restarted one at a time, and the addresses it has on the project's subnet: the load balancer VIP
 * (and floating IP) of MySQL/PostgreSQL with the HAProxy/PgBouncer members behind it, or one address per
 * MongoDB member. Database instances of MySQL/PostgreSQL never have an address on the project's network.
 * Admins also see each pod's node and pod IP, and can force a restart.
 */
import { useState } from "react";
import {
  ActionDialog,
  Badge,
  Button,
  Card,
  type Column,
  CopyButton,
  DataTable,
  ErrorNotice,
  Field,
  Icon,
  Picker,
  StatusDot,
  Switch,
  fmtDate,
  tr,
} from "@rassvet/sdk";
import { type AdminClusterDetail, type ClusterMember, DB, type DbCluster, type Member, hasProxies, proxyName, restartMember, switchover, useEndpoints, useMembers } from "./api";

type AddressRow = { name: string; role: string; hostname?: string; address?: string; ready?: boolean; note?: string };

const roleLabel = (m: ClusterMember, engine: string) =>
  m.kind === "proxy" ? proxyName(engine) : m.role === "primary" ? tr("Primary") : m.role === "replica" ? tr("Replica") : tr("Database");

function memberState(m: ClusterMember) {
  if (m.restarting) return <StatusDot status="warn" label={tr("Restarting…")} />;
  return <StatusDot status={m.ready ? "ok" : "warn"} label={m.ready ? tr("Ready") : tr("Not ready")} />;
}

export function Instances({ c }: { c: DbCluster }) {
  const d = c as AdminClusterDetail;
  const admin = !!c.project_id;
  const live = c.status !== "creating" && c.status !== "deleting";
  const members = useMembers(c, c.status !== "deleting");
  const ep = useEndpoints(c, live);
  const [restart, setRestart] = useState<ClusterMember | null>(null);
  // PostgreSQL only (Patroni); null: closed, "": the first ready replica.
  const [switchTo, setSwitchTo] = useState<string | null>(null);
  const pg = c.engine === "postgresql";
  // Admins: where each pod runs, from the detail view.
  const pods = new Map((d.members ?? []).map((m) => [m.name, m]));
  const lb = hasProxies(c.engine);

  const memberCols: Column<ClusterMember>[] = [
    { key: "name", header: tr("Member"), mono: true, cell: (m) => m.name, value: (m) => m.name },
    {
      key: "role",
      header: tr("Role"),
      width: "8rem",
      cell: (m) => <Badge tone={m.role === "primary" ? "accent" : "neutral"}>{roleLabel(m, c.engine)}</Badge>,
      value: (m) => `${m.kind} ${m.role ?? ""}`,
    },
    { key: "state", header: tr("State"), width: "9rem", cell: memberState, value: (m) => (m.restarting ? "restarting" : String(m.ready)) },
    {
      key: "restarts",
      header: tr("Restarts"),
      width: "6rem",
      hideBelow: "md",
      className: "text-right",
      cell: (m) => <span className={m.restarts > 3 ? "text-led-amber" : undefined}>{m.restarts}</span>,
      value: (m) => m.restarts,
    },
    { key: "started", header: tr("Started"), width: "11rem", hideBelow: "lg", cell: (m) => fmtDate(m.started) ?? "—", value: (m) => m.started ?? "" },
    ...(admin
      ? ([
          { key: "pod", header: tr("Pod IP"), width: "9rem", mono: true, hideBelow: "md", cell: (m) => pods.get(m.name)?.pod_ip || "—", value: (m) => pods.get(m.name)?.pod_ip ?? "" },
          { key: "node", header: tr("Node"), width: "10rem", hideBelow: "xl", cell: (m) => pods.get(m.name)?.node || "—", value: (m) => pods.get(m.name)?.node ?? "" },
        ] as Column<ClusterMember>[])
      : []),
  ];

  const addresses: AddressRow[] = [];
  const e = ep.data;
  if (e?.type === "load_balancer" && (e.address || e.floating_ip)) {
    const online = d.load_balancer?.online_members;
    addresses.push({
      name: e.hostname?.split(".")[0] || c.name,
      role: tr("Load balancer"),
      hostname: e.hostname,
      address: e.address,
      ready: online != null ? online > 0 : c.status === "ready",
      note: [e.floating_ip && tr("floating IP {ip}", { ip: e.floating_ip }), online != null && tr("{n} members online", { n: online })].filter(Boolean).join(" · ") || undefined,
    });
  }
  (e?.members ?? []).forEach((m: Member, i) =>
    addresses.push({
      name: m.hostname?.split(".")[0] || tr("Member {n}", { n: i + 1 }),
      role: m.role === "proxy" ? proxyName(c.engine) : tr("Database"),
      hostname: m.hostname,
      address: m.address,
      ready: m.ready,
      // A PgBouncer row is a slot of the pool port, held by any of its pods; a spare slot isn't ready.
      note: m.role === "proxy" ? (m.ready ? tr("connect through the load balancer") : tr("spare, not held by a pod")) : undefined,
    }),
  );
  const addressCols: Column<AddressRow>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (r) => (
        <div className="min-w-0">
          <p className="truncate font-mono text-[12.5px]">{r.name}</p>
          {r.note && <p className="truncate text-xs text-muted">{r.note}</p>}
        </div>
      ),
      value: (r) => r.name,
    },
    { key: "role", header: tr("Role"), width: "9rem", cell: (r) => <Badge tone={r.role === tr("Load balancer") ? "accent" : "neutral"}>{r.role}</Badge>, value: (r) => r.role },
    {
      key: "address",
      header: tr("Address"),
      width: "11rem",
      mono: true,
      cell: (r) =>
        r.address ? (
          <span className="inline-flex items-center gap-1">
            {r.address}
            <CopyButton text={r.address} label="" className="h-6 px-1.5" />
          </span>
        ) : (
          <span className="text-muted">—</span>
        ),
      value: (r) => r.address ?? "",
    },
    { key: "hostname", header: tr("Hostname"), mono: true, hideBelow: "lg", cell: (r) => r.hostname || <span className="text-muted">—</span>, value: (r) => r.hostname ?? "" },
    {
      key: "ready",
      header: tr("Ready"),
      width: "6rem",
      cell: (r) => (r.ready == null ? <span className="text-muted">—</span> : <StatusDot status={r.ready ? "ok" : "warn"} label={r.ready ? tr("Yes") : tr("No")} />),
      value: (r) => String(!!r.ready),
    },
  ];

  const replicas = (members.data ?? []).filter((m) => m.kind === "database" && m.role === "replica");
  const readyReplicas = replicas.filter((m) => m.ready && !m.restarting);
  const switchBlocked =
    c.status !== "ready"
      ? tr("The cluster isn't ready")
      : /applying parameter change/i.test(c.status_reason ?? "")
        ? tr("A parameter change is being applied")
        : !replicas.length
          ? tr("The cluster has a single member: there is no replica to switch to")
          : !readyReplicas.length
            ? tr("No replica is ready")
            : false;
  const blocked = c.status === "deleting" ? tr("The cluster is being deleted") : /applying parameter change/i.test(c.status_reason ?? "") ? tr("A parameter change is being applied") : false;

  return (
    <>
      <Card
        title={tr("Members")}
        actions={
          pg && (
            <Button className="h-8" onClick={() => setSwitchTo("")} disabled={!!switchBlocked} title={switchBlocked || tr("Make a replica the primary")}>
              <Icon name="refresh" />
              {tr("Switch primary")}
            </Button>
          )
        }
      >
        <p className="mb-3 text-sm text-muted">
          {lb
            ? tr("The database instances and the {proxy} instances in front of them. Restarting one recreates its pod with the same volume and network port.", { proxy: proxyName(c.engine) })
            : tr("The replica set members. Restarting one recreates its pod with the same volume and network port.")}
        </p>
        <ErrorNotice error={members.error} className="mb-3" />
        <DataTable
          rows={members.data}
          columns={memberCols}
          rowKey={(m) => m.name}
          loading={members.isPending}
          tableId={admin ? "dbaas-members-admin" : "dbaas-members"}
          noun={tr("members")}
          rowLabel={(m) => m.name}
          onRefresh={() => members.refetch()}
          refreshing={members.isFetching}
          empty={c.status === "creating" ? tr("The members appear while the cluster is created.") : tr("No members.")}
          rowActions={(m) => [
            ...(pg && m.role === "replica"
              ? [{ label: tr("Make primary"), icon: "arrow-up", disabled: switchBlocked || ((!m.ready || m.restarting) && tr("This replica isn't ready")), onSelect: () => setSwitchTo(m.name) }]
              : []),
            { label: tr("Restart"), icon: "refresh", disabled: blocked || (m.restarting && tr("Already restarting")), onSelect: () => setRestart(m) },
          ]}
        />
      </Card>
      <Card title={tr("Addresses on your network")}>
        <p className="mb-3 text-sm text-muted">
          {lb
            ? tr("Connect through the load balancer. The {proxy} addresses are listed for diagnosis and firewall rules; the database instances run on DBaaS's own network and have no address on your subnet.", { proxy: proxyName(c.engine) })
            : tr("Each member has its own address on your subnet; clients connect to the replica set with all of them.")}
        </p>
        <ErrorNotice error={ep.error} className="mb-3" />
        <DataTable
          rows={live ? (e ? addresses : undefined) : []}
          columns={addressCols}
          rowKey={(r) => `${r.role}/${r.name}/${r.address ?? ""}`}
          loading={live && ep.isPending}
          tableId="dbaas-addresses"
          noun={tr("addresses")}
          rowLabel={(r) => r.name}
          empty={c.status === "creating" ? tr("The addresses appear once the cluster is created.") : tr("No address yet.")}
        />
      </Card>
      {switchTo !== null && <SwitchoverDialog c={c} members={members.data ?? []} initial={switchTo} onClose={() => setSwitchTo(null)} />}
      {restart && <RestartDialog c={c} m={restart} admin={admin} onClose={() => setRestart(null)} />}
    </>
  );
}

/** Restart one member. dbaas-api refuses (409) while another member of the same kind isn't ready; admins can force it. */
export function RestartDialog({ c, m, admin, onClose }: { c: DbCluster; m: { name: string; kind?: string; role?: string; ready?: boolean }; admin: boolean; onClose: () => void }) {
  const [force, setForce] = useState(false);
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Restart {pod}?", { pod: m.name })}
      submitLabel={force ? tr("Force restart") : tr("Restart")}
      danger={force}
      done={(r: { message?: string }) => r?.message || tr("Restarting {pod}", { pod: m.name })}
      refresh={[DB]}
      run={() => restartMember(c, m.name, force)}
    >
      <div className="space-y-3 text-sm">
        <p>{tr("The pod is deleted; its operator recreates it with the same volume and network port. Clients connected to it reconnect.")}</p>
        {m.role === "primary" && <p className="text-led-amber">{tr("This is the primary: a replica takes over while it restarts, and writes stop for a few seconds.")}</p>}
        {m.kind === "database" && m.role !== "primary" && c.replicas === 1 && <p className="text-led-amber">{tr("The cluster has a single member: the database is down until it is back.")}</p>}
        <p className="text-muted">{tr("Refused while a parameter change is applied, or while another member of the same kind isn't ready.")}</p>
        {admin && (
          <Switch
            checked={force}
            onChange={setForce}
            label={tr("Force")}
            hint={tr("Skip these checks (cloud operators only), e.g. to unstick a cluster whose members are all failing.")}
          />
        )}
      </div>
    </ActionDialog>
  );
}

/** Hand the primary role to a replica (PostgreSQL, Patroni). dbaas-api answers once the switch is done. */
function SwitchoverDialog({ c, members, initial, onClose }: { c: DbCluster; members: ClusterMember[]; initial: string; onClose: () => void }) {
  const [target, setTarget] = useState(initial);
  const primary = members.find((m) => m.role === "primary");
  const replicas = members.filter((m) => m.kind === "database" && m.role === "replica");
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Switch the primary of {name}?", { name: c.name })}
      submitLabel={tr("Switch primary")}
      done={(r: { target?: string; message?: string }) => r?.message || tr("{pod} is now the primary of {name}", { pod: r?.target ?? target, name: c.name })}
      refresh={[DB]}
      run={() => switchover(c, target || undefined)}
    >
      <div className="space-y-3 text-sm">
        <p>
          {tr("The chosen replica becomes the primary and {primary} becomes a replica. Writes stop for a few seconds; clients reconnect through the load balancer. Nothing restarts.", {
            primary: primary?.name ?? tr("the current primary"),
          })}
        </p>
        <Field label={tr("New primary")}>
          {(id) => (
            <Picker
              id={id}
              value={target}
              onChange={setTarget}
              options={[
                { value: "", label: tr("First ready replica"), description: tr("Chosen by DBaaS") },
                ...replicas.map((m) => ({
                  value: m.name,
                  label: m.name,
                  description: m.ready && !m.restarting ? tr("ready") : tr("not ready"),
                  disabled: !m.ready || !!m.restarting,
                })),
              ]}
            />
          )}
        </Field>
        <p className="text-muted">{tr("Refused while a parameter change is applied or the cluster isn't ready, and when Patroni declines (e.g. the replica lags too far behind).")}</p>
      </div>
    </ActionDialog>
  );
}
