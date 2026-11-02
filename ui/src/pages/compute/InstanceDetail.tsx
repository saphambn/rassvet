import { useMutation, useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { Link, useNavigate } from "@/components/Link";
import { type Column, DataTable } from "@/components/DataTable";
import { ActionMenu } from "@/components/Menu";
import { Picker } from "@/components/Picker";
import { Badge, Button, Card, Detail, ErrorNotice, Icon, Mono, PageHeader, StatusDot, Tabs } from "@/components/ui";
import { CopyButton } from "@/components/CodeBlock";
import { TagList } from "@/components/TagInput";
import { fmtDate } from "@/lib/format";
import { useProjects } from "@/lib/identity";
import { useImage } from "@/lib/image";
import {
  POLICY_TEXT,
  POWER_STATES,
  groupPolicy,
  useServerGroups,
  type Port,
  type SecurityGroup,
  type Server,
  type Volume,
  age,
  gib,
  networkStatus,
  os,
  portLabel,
  ruleText,
  serverAction,
  serverLabel,
  serverStatus,
  useFloatingIps,
  useNetworks,
  useOsGet,
  usePorts,
  useSecurityGroups,
  useSubnets,
  useServer,
  useVolumesById,
  volumeStatus,
} from "@/lib/os";
import { useSession } from "@/lib/session";
import { useTab } from "@/lib/useTab";
import { cn } from "@/lib/utils";
import { useNetName, usePortActions } from "../network/networkActions";
import { FixedIps, floatingName, useNeutronDns } from "../network/dns";
import { useVolumeActions } from "../storage/volumeActions";
import { useServerActions } from "./serverActions";
import { UserDataCard } from "./UserData";
import { tr, trx } from "@/lib/i18n";

const TABS = ["overview", "interfaces", "volumes", "log", "console", "actions"] as const;

export default function InstanceDetail({ admin = false }: { admin?: boolean }) {
  const { id = "" } = useParams();
  const server = useServer(id);
  const navigate = useNavigate();
  const base = admin ? "/admin/compute/instances" : "/compute/instances";
  const actions = useServerActions({ admin, base, onDeleted: () => navigate(base) });
  const [tab, setTab] = useTab(TABS, "overview");
  const s = server.data;

  return (
    <>
      <Link to={base} className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <Icon name="arrow-left" className="size-3.5" />
        {admin ? tr("All instances") : tr("Instances")}
      </Link>
      <PageHeader
        title={s?.name ?? tr("Instance")}
        description={
          s && (
            <span className="inline-flex items-center gap-2">
              <StatusDot status={serverStatus(s)} label={serverLabel(s)} />
              <span>
                {trx("· {v} · {v2} · up {age}", { v: s.flavor.original_name ?? tr("unknown flavor"), v2: s.image === "" ? tr("boots from a volume") : tr("boots from an image"), age: age(s["OS-SRV-USG:launched_at"] ?? s.created) })}
              </span>
            </span>
          )
        }
        actions={
          s && (
            <>
              <Button onClick={() => setTab("console")} disabled={s.status !== "ACTIVE"}>
                <Icon name="terminal" />
                {tr("Console")}
              </Button>
              <ActionMenu variant="button" items={() => actions.items(s, "detail")} />
            </>
          )
        }
      />
      <ErrorNotice error={server.error} className="mb-4" />

      {s?.fault && <FaultPanel fault={s.fault} status={s.status} admin={admin} onActionLog={() => setTab("actions")} />}
      {s?.locked && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-led-amber/40 bg-led-amber/10 px-4 py-2.5 text-sm">
          <Icon name="lock" className="text-[#9a6412] dark:text-led-amber" />
          {tr("Locked: actions that change the instance are refused until it's unlocked.")}
        </div>
      )}

      {s && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            className="mb-5"
            tabs={[
              { id: "overview", label: tr("Overview") },
              { id: "interfaces", label: tr("Interfaces") },
              { id: "volumes", label: tr("Volumes ({v})", { v: s["os-extended-volumes:volumes_attached"]?.length ?? 0 }) },
              { id: "log", label: tr("Log") },
              { id: "console", label: tr("Console") },
              { id: "actions", label: tr("Action log") },
            ]}
          />
          {tab === "overview" && <Overview server={s} admin={admin} onEditMetadata={() => actions.openDialog("metadata", s)} onEditTags={() => actions.openDialog("tags", s)} />}
          {tab === "interfaces" && <InterfacesTab server={s} onAttach={() => actions.openDialog("attachIface", s)} />}
          {tab === "volumes" && <VolumesTab server={s} onAttach={() => actions.openDialog("attachVolume", s)} />}
          {tab === "log" && <LogTab id={s.id} />}
          {tab === "console" && <ConsoleTab server={s} />}
          {tab === "actions" && <ActionLog id={s.id} />}
        </>
      )}
      {actions.dialogs}
    </>
  );
}

// =========================================================================== fault

/**
 * Nova's fault record: message and code for everyone, plus the time and — for admins (Nova's
 * default policy) — the details, usually a Python traceback from the compute host.
 */
function FaultPanel({ fault, status, admin, onActionLog }: { fault: NonNullable<Server["fault"]>; status: string; admin: boolean; onActionLog: () => void }) {
  const [open, setOpen] = useState(false);
  const details = fault.details?.trim();
  const copyText = [`${fault.code} ${fault.message}`, fault.created && `at ${fault.created}`, details].filter(Boolean).join("\n\n");
  return (
    <div className="mb-4 rounded-lg border border-led-red/30 bg-led-red/8 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <Icon name="warning" className="mt-0.5 shrink-0 text-led-red" />
        <div className="min-w-0 flex-1">
          <p className="font-medium break-words">
            {status === "ERROR" ? tr("The instance failed: ") : tr("Last fault: ")}
            {fault.message}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {trx("Error {code}", { code: fault.code })}
            {fault.created && <>{" "}{trx("· {created} ({created2} ago)", { created: fmtDate(fault.created), created2: age(fault.created) })}</>}
            {" · "}
            <button type="button" onClick={onActionLog} className="text-cable hover:underline">
              {tr("see the action log")}
            </button>
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {details && (
            <Button className="h-8" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
              <Icon name={open ? "chevron-up" : "chevron-down"} />
              {open ? tr("Hide details") : tr("Show details")}
            </Button>
          )}
          <CopyButton className="h-8" text={copyText} label={tr("Copy")} />
        </div>
      </div>
      {details && open && (
        <pre className="mt-3 max-h-96 overflow-auto rounded-md border border-line bg-panel p-3 font-mono text-[12px] leading-5 break-all whitespace-pre-wrap select-text">{details}</pre>
      )}
      {!details && admin && <p className="mt-2 text-xs text-muted">{tr("Nova gave no details (traceback) for this fault.")}</p>}
      {!details && !admin && <p className="mt-2 text-xs text-muted">{tr("The full error details are only visible to admins.")}</p>}
    </div>
  );
}

// =========================================================================== overview

function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <Card title={title} actions={actions}>
      <dl>{children}</dl>
    </Card>
  );
}

function Overview({ server: s, admin, onEditMetadata, onEditTags }: { server: Server; admin: boolean; onEditMetadata: () => void; onEditTags?: () => void }) {
  const serverGroups = useServerGroups();
  // 2.71+ lists the groups on the server; older clouds: find it among the groups' members.
  const myGroups = (serverGroups.data ?? []).filter((g) => s.server_groups?.includes(g.id) ?? g.members.includes(s.id));
  const session = useSession().data!;
  const showAdmin = admin || session.is_admin;
  const projects = useProjects(showAdmin);
  const ports = usePorts({ device_id: s.id });
  const groups = useSecurityGroups();
  const attached = s["os-extended-volumes:volumes_attached"] ?? [];
  const volumes = useVolumesById(attached.map((a) => a.id));
  const imageId = s.image && typeof s.image === "object" ? s.image.id : "";
  const image = useImage(imageId, !!imageId);
  const projectName = (pid: string) => projects.data?.find((p) => p.id === pid)?.name ?? session.projects.find((p) => p.id === pid)?.name;

  // Security groups actually applied: from the ports (ids), else by name from Nova.
  const sgs = useMemo(() => {
    const byId = new Map(groups.data?.map((g) => [g.id, g]));
    const ids = new Set(ports.data?.flatMap((p) => p.security_groups ?? []));
    const list: SecurityGroup[] = [...ids].map((i) => byId.get(i)).filter(Boolean) as SecurityGroup[];
    if (!list.length)
      for (const n of new Set(s.security_groups?.map((g) => g.name))) {
        const g = groups.data?.find((x) => x.name === n && x.project_id === s.tenant_id);
        if (g) list.push(g);
      }
    return list;
  }, [groups.data, ports.data, s]);
  const sgName = (gid: string) => groups.data?.find((g) => g.id === gid)?.name ?? gid.slice(0, 8);

  const root = attached
    .map((a) => volumes.data?.find((v) => v.id === a.id))
    .find((v) => v?.attachments.some((x) => x.server_id === s.id && /[sv]da$/.test(x.device ?? "")));
  const extraSpecs = Object.entries(s.flavor.extra_specs ?? {});

  return (
    <div className="grid items-start gap-6 xl:grid-cols-2">
      <div className="space-y-6">
        <Section title={tr("Overview")}>
          <Detail label={tr("Name")}>{s.name}</Detail>
          <Detail label="ID">
            <Mono>{s.id}</Mono>
          </Detail>
          <Detail label={tr("Description")} wrap>
            {s.description || <span className="text-muted">—</span>}
          </Detail>
          <Detail label={tr("Project")}>
            {projectName(s.tenant_id) ?? ""} <Mono className="text-muted">{s.tenant_id}</Mono>
          </Detail>
          <Detail label={tr("Status")}>
            <StatusDot status={serverStatus(s)} label={serverLabel(s)} />
          </Detail>
          <Detail label={tr("Power state")}>{POWER_STATES[s["OS-EXT-STS:power_state"] ?? 0] ?? "—"}</Detail>
          {s["OS-EXT-STS:task_state"] && <Detail label={tr("Task")}>{s["OS-EXT-STS:task_state"]}</Detail>}
          <Detail label={tr("Locked")}>{s.locked ? tr("Yes") : tr("No")}</Detail>
          <Detail label={tr("Availability zone")}>{s["OS-EXT-AZ:availability_zone"] ?? "—"}</Detail>
          <Detail label={tr("Created")}>{fmtDate(s.created)}</Detail>
          <Detail label={tr("Age")}>{age(s.created)}</Detail>
          {s["OS-SRV-USG:launched_at"] && <Detail label={tr("Launched")}>{fmtDate(s["OS-SRV-USG:launched_at"])}</Detail>}
          <Detail label={tr("Updated")}>{fmtDate(s.updated)}</Detail>
        </Section>

        <Section title={tr("Specs")}>
          <Detail label={tr("Flavor")}>{s.flavor.original_name ?? s.flavor.id ?? "—"}</Detail>
          {s.flavor.id && (
            <Detail label={tr("Flavor ID")}>
              <Mono>{s.flavor.id}</Mono>
            </Detail>
          )}
          {s.flavor.ram != null && <Detail label="RAM">{gib(s.flavor.ram)}</Detail>}
          {s.flavor.vcpus != null && <Detail label={tr("vCPUs")}>{trx("{vcpus} vCPU", { vcpus: s.flavor.vcpus })}</Detail>}
          <Detail label={tr("Root disk")}>
            {s.image === "" ? (
              root ? (
                <>
                  <Link to={`/storage/volumes/${root.id}`} className="text-cable hover:underline">
                    {root.name || root.id.slice(0, 8)}
                  </Link>{" "}{trx("({size} GiB {v} volume)", { size: root.size, v: root.volume_type ?? "" })}
                </>
              ) : (
                tr("Cinder volume")
              )
            ) : (
              tr("{v} GB local", { v: s.flavor.disk ?? 0 })
            )}
          </Detail>
          {!!s.flavor.ephemeral && <Detail label={tr("Ephemeral")}>{s.flavor.ephemeral} GB</Detail>}
          {!!s.flavor.swap && <Detail label={tr("Swap")}>{trx("{swap} MiB", { swap: s.flavor.swap })}</Detail>}
          {extraSpecs.length > 0 && (
            <Detail label={tr("Extra specs")} wrap>
              <span className="flex flex-col gap-0.5 font-mono text-[12.5px]">
                {extraSpecs.map(([k, v]) => (
                  <span key={k}>
                    {k}=<span className="text-muted">{v}</span>
                  </span>
                ))}
              </span>
            </Detail>
          )}
        </Section>

        {showAdmin && (
          <Section title={tr("Hypervisor")}>
            <Detail label={tr("Host")}>{s["OS-EXT-SRV-ATTR:host"] ?? "—"}</Detail>
            <Detail label={tr("Hypervisor")}>{s["OS-EXT-SRV-ATTR:hypervisor_hostname"] ?? "—"}</Detail>
            {s["OS-EXT-SRV-ATTR:instance_name"] && (
              <Detail label={tr("Instance name")}>
                <Mono>{s["OS-EXT-SRV-ATTR:instance_name"]}</Mono>
              </Detail>
            )}
            {s["OS-EXT-SRV-ATTR:hostname"] && <Detail label={tr("Guest hostname")}>{s["OS-EXT-SRV-ATTR:hostname"]}</Detail>}
            {s["OS-EXT-SRV-ATTR:root_device_name"] && (
              <Detail label={tr("Root device")}>
                <Mono>{s["OS-EXT-SRV-ATTR:root_device_name"]}</Mono>
              </Detail>
            )}
            {s.host_status && <Detail label={tr("Host status")}>{s.host_status}</Detail>}
            {s.hostId && (
              <Detail label={tr("Host ID")}>
                <Mono>{s.hostId}</Mono>
              </Detail>
            )}
            {s.pinned_availability_zone && <Detail label={tr("Pinned zone")}>{s.pinned_availability_zone}</Detail>}
          </Section>
        )}
      </div>

      <div className="space-y-6">
        <Card title={tr("IP addresses")} flush>
          <ul>
            {Object.entries(s.addresses ?? {}).map(([net, list]) => (
              <li key={net} className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-4 border-b border-line px-5 py-2.5 text-sm last:border-0">
                <span className="truncate font-medium" title={net}>
                  {net}
                </span>
                <span className="flex min-w-0 flex-col gap-1">
                  {list.map((a) => (
                    <span key={a.addr} className="flex min-w-0 items-center gap-2">
                      <Mono>{a.addr}</Mono>
                      {a["OS-EXT-IPS:type"] === "floating" && <Badge tone="accent">{tr("floating")}</Badge>}
                      {a.version === 6 && <Badge>{tr("IPv6")}</Badge>}
                    </span>
                  ))}
                </span>
              </li>
            ))}
            {Object.keys(s.addresses ?? {}).length === 0 && <li className="px-5 py-5 text-sm text-muted">{tr("No addresses.")}</li>}
          </ul>
        </Card>

        <Card title={tr("Security groups")} flush>
          <ul>
            {sgs.map((g) => (
              <li key={g.id} className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-4 border-b border-line px-5 py-2.5 text-sm last:border-0">
                <Link to={`/network/security-groups/${g.id}`} className="truncate font-medium text-cable hover:underline" title={g.name}>
                  {g.name}
                </Link>
                <span className="flex min-w-0 flex-col gap-0.5 font-mono text-[12.5px]">
                  {g.security_group_rules.map((r) => (
                    <span key={r.id} className="truncate" title={r.description || undefined}>
                      {ruleText(r, sgName)}
                    </span>
                  ))}
                  {g.security_group_rules.length === 0 && <span className="font-sans text-muted">{tr("No rules: all traffic blocked")}</span>}
                </span>
              </li>
            ))}
            {groups.data && sgs.length === 0 && (
              <li className="px-5 py-5 text-sm text-muted">{s.security_groups?.map((g) => g.name).join(", ") || tr("No security groups.")}</li>
            )}
          </ul>
        </Card>

        <Card title={tr("Scheduling")}>
          <dl>
            <Detail label={tr("Server group")}>
              {myGroups.length
                ? myGroups.map((g) => {
                    const p = groupPolicy(g);
                    return (
                      <span key={g.id} className="mr-3 inline-flex items-center gap-2">
                        <Link to="/compute/server-groups" className="text-cable hover:underline">
                          {g.name}
                        </Link>
                        {p && <Badge>{POLICY_TEXT[p].label}</Badge>}
                      </span>
                    );
                  })
                : (s.server_groups?.length ?? 0) > 0
                  ? s.server_groups!.join(", ")
                  : <span className="text-muted">{tr("None")}</span>}
            </Detail>
            <Detail label={tr("Zone")}>{s["OS-EXT-AZ:availability_zone"] ?? "—"}</Detail>
          </dl>
          <p className="mt-2 text-xs text-muted">{tr("The server group and scheduler hints are fixed at launch; Nova also applies them when the instance is migrated or resized.")}</p>
        </Card>

        <Section
          title={tr("Metadata")}
          actions={
            <Button className="h-8" onClick={onEditMetadata}>
              <Icon name="edit" />
              {tr("Edit")}
            </Button>
          }
        >
          <Detail label={tr("Tags")} wrap>
            <span className="flex flex-wrap items-center gap-2">
              <TagList tags={s.tags} empty={tr("None")} />
              {onEditTags && (
                <button type="button" className="text-xs text-cable hover:underline" onClick={onEditTags}>
                  {tr("Edit tags")}
                </button>
              )}
            </span>
          </Detail>
          <Detail label={tr("Key name")}>{s.key_name ?? <span className="text-muted">{tr("None")}</span>}</Detail>
          <Detail label={tr("Image")}>
            {imageId ? (
              <Link to={`/compute/images/${imageId}`} className="text-cable hover:underline">
                {image.data?.name ?? imageId}
              </Link>
            ) : root?.volume_image_metadata?.image_name ? (
              <span>
                {root.volume_image_metadata.image_name} <span className="text-muted">{tr("(on the root volume)")}</span>
              </span>
            ) : (
              <span className="text-muted">{tr("None (booted from a volume)")}</span>
            )}
          </Detail>
          <Detail label={tr("Volumes")}>{attached.length}</Detail>
          {s.config_drive !== undefined && <Detail label={tr("Config drive")}>{s.config_drive ? tr("Yes") : tr("No")}</Detail>}
          {Object.entries(s.metadata ?? {}).map(([k, v]) => (
            <Detail key={k} label={k}>
              <Mono>{v}</Mono>
            </Detail>
          ))}
        </Section>
      </div>

      <div className="xl:col-span-2">
        <UserDataCard value={s["OS-EXT-SRV-ATTR:user_data"]} visible={"OS-EXT-SRV-ATTR:user_data" in s} />
      </div>
    </div>
  );
}

// =========================================================================== interfaces

function InterfacesTab({ server, onAttach }: { server: Server; onAttach: () => void }) {
  const ports = usePorts({ device_id: server.id });
  const fips = useFloatingIps();
  const groups = useSecurityGroups();
  const netName = useNetName();
  const actions = usePortActions({ serverName: () => server.name });
  const sgName = useMemo(() => {
    const m = new Map(groups.data?.map((g) => [g.id, g.name]));
    return (id: string) => m.get(id) ?? id.slice(0, 8);
  }, [groups.data]);
  const fip = (p: Port) => fips.data?.filter((f) => f.port_id === p.id).map((f) => f.floating_ip_address).join(", ") ?? "";
  const ips = (p: Port) => p.fixed_ips.map((f) => f.ip_address).join(", ");
  const sgs = (p: Port) => (p.port_security_enabled === false ? tr("port security off") : (p.security_groups ?? []).map(sgName).join(", ") || "none");
  const dns = useNeutronDns();
  const subnets = useSubnets();
  const nets = useNetworks(undefined, dns.on);
  // The public name of each floating IP (its own, or the port's DNS name in the network's domain).
  const fipNames = (p: Port) =>
    [...new Set((fips.data ?? []).filter((f) => f.port_id === p.id).map((f) => floatingName(f, p, nets.data?.find((n) => n.id === p.network_id))).filter(Boolean))];

  const columns: Column<Port>[] = [
    { key: "name", header: tr("Name"), width: "11rem", cell: (p) => <span className={p.name ? "font-medium" : "text-muted"}>{portLabel(p)}</span>, value: (p) => `${portLabel(p)} ${p.id}` },
    {
      key: "network",
      header: tr("Network"),
      cell: (p) => (
        <Link to={`/network/networks/${p.network_id}`} className="text-cable hover:underline">
          {netName(p.network_id)}
        </Link>
      ),
      value: (p) => netName(p.network_id),
    },
    { key: "ips", header: tr("Fixed IPs"), width: dns.on ? "13rem" : "10rem", wrap: dns.on, mono: true, cell: (p) => (dns.on && p.dns_name ? <FixedIps port={p} subnets={subnets.data} dnsOn /> : ips(p)), value: ips },
    {
      key: "fip",
      header: tr("Floating IP"),
      width: dns.on ? "13rem" : "9rem",
      wrap: dns.on,
      mono: true,
      hideBelow: "sm",
      cell: (p) =>
        fip(p) ? (
          <span className="inline-flex flex-col">
            {fip(p)}
            {dns.on &&
              fipNames(p).map((n) => (
                <span key={n} className="block font-sans text-xs break-all text-muted" title={tr("Name Neutron publishes in Designate for this floating IP.")}>
                  {n}
                </span>
              ))}
          </span>
        ) : (
          <span className="font-sans text-muted">—</span>
        ),
      value: fip,
    },
    { key: "mac", header: tr("MAC address"), width: "10.5rem", mono: true, hideBelow: "lg", cell: (p) => p.mac_address, value: (p) => p.mac_address },
    { key: "sgs", header: tr("Security groups"), hideBelow: "md", cell: sgs, value: sgs },
    { key: "status", header: tr("Status"), width: "6.5rem", hideBelow: "xl", cell: (p) => <StatusDot status={networkStatus(p.status)} label={p.status.toLowerCase()} />, value: (p) => p.status },
    { key: "admin", header: tr("Admin"), width: "5rem", hideBelow: "2xl", cell: (p) => (p.admin_state_up === false ? tr("Down") : tr("Up")), value: (p) => (p.admin_state_up === false ? "Down" : "Up") },
  ];
  return (
    <>
      <DataTable
        rows={ports.data}
        columns={columns}
        rowKey={(p) => p.id}
        loading={ports.isPending}
        tableId="instance-interfaces"
        noun={tr("interfaces")}
        rowLabel={(p) => ips(p) || portLabel(p)}
        empty={tr("This instance has no network interfaces.")}
        onRefresh={() => ports.refetch()}
        refreshing={ports.isFetching}
        rowActions={actions.items}
        toolbar={
          <Button className="h-9" onClick={onAttach} disabled={server.locked}>
            <Icon name="cable" />
            {tr("Attach interface")}
          </Button>
        }
      />
      {actions.dialogs}
    </>
  );
}

// =========================================================================== volumes

function VolumesTab({ server, onAttach }: { server: Server; onAttach: () => void }) {
  const attached = server["os-extended-volumes:volumes_attached"] ?? [];
  // By ID: an admin viewing another project's instance can't find them in a list.
  const volumes = useVolumesById(attached.map((a) => a.id));
  const actions = useVolumeActions();
  const byId = new Map(volumes.data?.map((v) => [v.id, v]));
  const rows = volumes.data ? (attached.map((a) => byId.get(a.id)).filter(Boolean) as Volume[]) : undefined;
  const device = (v: Volume) => v.attachments.find((x) => x.server_id === server.id)?.device ?? "";
  const dot = (v: Volume) => (attached.find((a) => a.id === v.id)?.delete_on_termination ? "Yes" : "No");
  const isRoot = (v: Volume) => server.image === "" && /[sv]da$/.test(device(v));

  const columns: Column<Volume>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (v) => (
        <span className="inline-flex max-w-full items-center gap-2">
          <Link to={`/storage/volumes/${v.id}`} className="truncate font-medium text-cable hover:underline">
            {v.name || v.id}
          </Link>
          {isRoot(v) && <Badge tone="accent">{tr("root")}</Badge>}
        </span>
      ),
      value: (v) => v.name || v.id,
    },
    { key: "device", header: tr("Device"), width: "7rem", mono: true, cell: device, value: device },
    { key: "size", header: tr("Size"), width: "5.5rem", className: "text-right", cell: (v) => tr("{size} GiB", { size: v.size }), value: (v) => v.size },
    { key: "type", header: tr("Type"), width: "8rem", hideBelow: "md", cell: (v) => v.volume_type ?? "—", value: (v) => v.volume_type ?? "" },
    { key: "status", header: tr("Status"), width: "8rem", hideBelow: "sm", cell: (v) => <StatusDot status={volumeStatus(v)} label={v.status} />, value: (v) => v.status },
    { key: "dot", header: tr("Deleted with instance"), width: "11rem", hideBelow: "lg", cell: dot, value: dot },
  ];
  return (
    <>
      <ErrorNotice error={volumes.error} className="mb-3" />
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(v) => v.id}
        loading={volumes.isPending}
        tableId="instance-volumes"
        noun={tr("volumes")}
        rowLabel={(v) => v.name || v.id}
        empty={tr("No volumes attached.")}
        onRefresh={() => volumes.refetch()}
        refreshing={volumes.isFetching}
        rowActions={(v) => actions.items(v)}
        toolbar={
          <Button className="h-9" onClick={onAttach} disabled={server.locked}>
            <Icon name="plus" />
            {tr("Attach volume")}
          </Button>
        }
      />
      {actions.dialogs}
    </>
  );
}

// =========================================================================== log & console

function LogTab({ id }: { id: string }) {
  const [length, setLength] = useState("200");
  const q = useQuery({
    queryKey: ["os", "compute", "console-log", id, length],
    queryFn: () => serverAction(id, { "os-getConsoleOutput": length === "all" ? {} : { length: Number(length) } }).then((r) => (r as { output: string }).output),
  });
  const pre = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [q.data]);
  return (
    <div className="overflow-hidden rounded-lg border border-rack-line bg-rack">
      <div className="flex items-center gap-2 border-b border-rack-line px-3 py-2 text-xs text-rack-dim">
        <span>{tr("Show")}</span>
        <Picker
          aria-label={tr("Lines")}
          size="sm"
          className="w-32 border-rack-line bg-rack-2 text-rack-ink"
          panelWidth={160}
          value={length}
          onChange={setLength}
          options={[
            { value: "50", label: tr("Last 50 lines") },
            { value: "200", label: tr("Last 200 lines") },
            { value: "1000", label: tr("Last 1000 lines") },
            { value: "all", label: tr("Full log") },
          ]}
        />
        <button onClick={() => q.refetch()} className="ml-auto inline-flex items-center gap-1 hover:text-white">
          <Icon name="refresh" className={cn("size-3.5", q.isFetching && "animate-spin")} />
          {tr("Refresh")}
        </button>
      </div>
      {q.error ? (
        <ErrorNotice error={q.error} className="m-3" />
      ) : (
        <pre ref={pre} className="max-h-[36rem] overflow-auto p-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-rack-ink">
          {q.isPending ? tr("Loading…") : q.data || tr("The console log is empty.")}
        </pre>
      )}
    </div>
  );
}

/** noVNC embedded in the page (Horizon's Console tab). */
function ConsoleTab({ server }: { server: Server }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const running = server.status === "ACTIVE" || server.status === "RESCUE";
  const consoleUrl = useMutation({
    mutationFn: () =>
      os
        .post<{ remote_console: { url: string } }>("compute", `servers/${server.id}/remote-consoles`, { remote_console: { protocol: "vnc", type: "novnc" } })
        .then((r) => {
          // The URL is put in an iframe and a link: only http(s), never javascript: or data:.
          if (!/^https?:\/\//i.test(r.remote_console.url)) throw new Error(tr("The console address from Nova isn't an http(s) URL."));
          return r.remote_console.url;
        }),
  });
  // Ask for a fresh console token when the tab opens (tokens are short-lived).
  useEffect(() => {
    if (running) consoleUrl.mutate();
  }, [server.id, running]);
  const url = consoleUrl.data;

  if (!running)
    return (
      <Card>
        <p className="py-6 text-center text-sm text-muted">{trx("The console is available while the instance is running (now {toLowerCase}).", { toLowerCase: serverLabel(server).toLowerCase() })}</p>
      </Card>
    );
  return (
    <div className="overflow-hidden rounded-lg border border-rack-line bg-rack">
      <div className="flex flex-wrap items-center gap-2 border-b border-rack-line px-3 py-2 text-xs text-rack-dim">
        <Icon name="monitor" className="size-3.5" />
        <span className="min-w-0 flex-1 truncate">{tr("Click inside the screen to type. If it stops responding, reconnect.")}</span>
        <button onClick={() => consoleUrl.mutate()} className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-rack-2 hover:text-white">
          <Icon name="refresh" className={cn("size-3.5", consoleUrl.isPending && "animate-spin")} />
          {tr("Reconnect")}
        </button>
        <button
          onClick={() => frame.current?.requestFullscreen?.()}
          disabled={!url}
          className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-rack-2 hover:text-white disabled:opacity-40"
        >
          <Icon name="maximize" className="size-3.5" />
          {tr("Full screen")}
        </button>
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          aria-disabled={!url}
          className={cn("inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-rack-2 hover:text-white", !url && "pointer-events-none opacity-40")}
        >
          <Icon name="external-link" className="size-3.5" />
          {tr("New window")}
        </a>
      </div>
      {consoleUrl.error ? (
        <ErrorNotice error={consoleUrl.error} className="m-3" />
      ) : url ? (
        <iframe ref={frame} key={url} src={url} title={tr("Console of {name}", { name: server.name })} className="block h-[min(75vh,52rem)] min-h-[28rem] w-full bg-black" allow="fullscreen; clipboard-read; clipboard-write" />
      ) : (
        <div className="grid h-[28rem] place-items-center text-sm text-rack-dim">{tr("Connecting…")}</div>
      )}
    </div>
  );
}

function ActionLog({ id }: { id: string }) {
  const q = useOsGet<{ action: string; start_time: string; request_id: string; message?: string | null; user_id?: string; project_id?: string }[]>(
    "compute",
    `servers/${id}/os-instance-actions`,
    (r: { instanceActions: never[] }) => r.instanceActions,
  );
  const rows = useMemo(() => [...(q.data ?? [])].sort((a, b) => b.start_time.localeCompare(a.start_time)), [q.data]);
  type Row = (typeof rows)[number];
  const columns: Column<Row>[] = [
    { key: "action", header: tr("Action"), width: "12rem", cell: (a) => <span className="font-medium capitalize">{a.action.replace(/_/g, " ")}</span>, value: (a) => a.action },
    { key: "time", header: tr("Start time"), width: "11rem", cell: (a) => fmtDate(a.start_time), value: (a) => a.start_time },
    { key: "req", header: tr("Request ID"), mono: true, hideBelow: "md", cell: (a) => a.request_id, value: (a) => a.request_id },
    { key: "user", header: tr("User ID"), mono: true, hideBelow: "xl", cell: (a) => a.user_id ?? "", value: (a) => a.user_id ?? "" },
    { key: "msg", header: tr("Message"), hideBelow: "sm", cell: (a) => (a.message ? <span className="text-led-red">{a.message}</span> : <span className="text-muted">—</span>), value: (a) => a.message ?? "" },
  ];
  return (
    <DataTable
      rows={q.data ? rows : undefined}
      columns={columns}
      rowKey={(a) => a.request_id}
      loading={q.isPending}
      tableId="instance-actions"
      noun={tr("actions")}
      empty={tr("No actions recorded.")}
      onRefresh={() => q.refetch()}
      refreshing={q.isFetching}
    />
  );
}
