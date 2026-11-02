/** Ports of the project (or of every project, admin view): one page at a time from Neutron. */
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useInAdmin } from "@/components/Link";
import { type Column, DataTable } from "@/components/DataTable";
import { Button, ErrorNotice, Icon, PageHeader, StatusDot } from "@/components/ui";
import { NEUTRON_STATUSES, choice, filters, idFilter, nameRegex, statusLabel, text, useProjectFilter } from "@/lib/filters";
import { useProjects } from "@/lib/identity";
import { type Port, networkStatus, os, portLabel, portOwner, useInvalidate, useListOrPages, useNetworks, useSecurityGroups, splitChoice } from "@/lib/os";
import { useSession } from "@/lib/session";
import { useServerNames } from "../storage/volumeActions";
import { PortDialog, usePortActions } from "./networkActions";
import { useNeutronDns } from "./dns";
import { tr } from "@/lib/i18n";

/** Instances whose IDs go into one ports query (keeps the URL well under server limits). */
const MAX_DEVICES = 150;

/**
 * "Attached to" choices. Neutron matches device_owner exactly (no prefix or wildcard), so
 * each choice sends every owner value it covers as a repeated parameter (= any of them).
 * Nova sets instance ports to "compute:<availability zone>", hence one value per zone.
 */
const OWNER_GROUPS: { value: string; label: string; owners: (zones: string[]) => string[] }[] = [
  { value: "instance", label: tr("Instance"), owners: (zones) => [...new Set(["compute:nova", "compute:None", ...zones.map((z) => `compute:${z}`)])] },
  {
    value: "router_interface",
    label: tr("Router interface"),
    owners: () => ["network:router_interface", "network:router_interface_distributed", "network:ha_router_replicated_interface"],
  },
  { value: "router_gateway", label: tr("Router gateway"), owners: () => ["network:router_gateway"] },
  { value: "dhcp", label: tr("DHCP"), owners: () => ["network:dhcp"] },
  { value: "floatingip", label: tr("Floating IP"), owners: () => ["network:floatingip"] },
  { value: "metadata", label: tr("Metadata"), owners: () => ["network:distributed"] },
  { value: "subport", label: tr("Trunk subport"), owners: () => ["trunk:subport"] },
  { value: "octavia", label: tr("Load balancer (Octavia)"), owners: () => ["Octavia"] },
];

export default function Ports({ admin = false }: { admin?: boolean }) {
  const session = useSession().data!;
  const inAdmin = useInAdmin();
  const all = admin || inAdmin;
  const nets = useNetworks();
  const groups = useSecurityGroups(all ? undefined : { project_id: session.project?.id });
  const projects = useProjects(all);
  const serverName = useServerNames();
  const actions = usePortActions({ serverName });
  const invalidate = useInvalidate();
  const filterProject = useProjectFilter(all);
  const qc = useQueryClient();
  // Every compute zone, available or not: ports keep the zone their instance was booted in.
  // Fetched before the ports query runs (a filter remembered across a reload must not miss zones).
  const loadZones = () =>
    qc.fetchQuery({
      queryKey: ["os", "compute", "os-availability-zone", "all-names"],
      queryFn: () =>
        os
          .get<{ availabilityZoneInfo: { zoneName: string }[] }>("compute", "os-availability-zone")
          .then((r) => r.availabilityZoneInfo.map((z) => z.zoneName).filter((z) => z !== "internal")),
      staleTime: 5 * 60_000,
    });
  /** device_owner values of a choice; an old remembered "compute:nova" counts as Instance. */
  const ownersOf = async (v: string) => {
    const [choice] = splitChoice(v);
    const g = OWNER_GROUPS.find((x) => x.value === (choice.startsWith("compute:") ? "instance" : choice));
    return g ? g.owners(choice.startsWith("compute:") || choice === "instance" ? await loadZones() : []) : [choice];
  };
  const [creating, setCreating] = useState(false);

  const ports = useListOrPages<Port>(true, "network", "ports", "ports", all ? undefined : { project_id: session.project?.id }, {
    filters: filters(
      nameRegex(),
      idFilter("ports", "port"),
      { key: "ip", label: tr("IP address"), param: (v: string) => ({ fixed_ips: `ip_address=${v.trim()}` }), placeholder: tr("Exact address, e.g. 10.0.0.15") },
      text("mac", tr("MAC address"), "mac_address", "fa:16:3e:…"),
      {
        key: "network",
        label: tr("Network"),
        param: "network_id",
        options: (nets.data ?? []).map((n) => ({ value: n.id, label: n.name || n.id })),
      },
      {
        key: "owner",
        label: tr("Attached to"),
        param: "device_owner",
        // Instance + a name regex: Neutron can't match instance names, so ask Nova for the
        // matching instances (its `name` filter is a regex) and filter ports by their IDs
        // (device_id alone identifies instance ports).
        resolve: async (v: string) => {
          const [choice, rx] = splitChoice(v);
          if (choice !== "instance" || !rx) return { device_owner: await ownersOf(v) };
          const found = await os.get<{ servers: { id: string }[] }>("compute", "servers", { name: rx, limit: MAX_DEVICES, ...(all ? { all_tenants: 1 } : {}) });
          return found.servers.length ? { device_id: found.servers.map((x) => x.id) } : null;
        },
        options: OWNER_GROUPS.map((g) => ({
          value: g.value,
          label: g.label,
          ...(g.value === "instance" ? { input: { placeholder: tr("Instance name (regex), optional") } } : {}),
        })),
      },
      choice("status", tr("Status"), "status", NEUTRON_STATUSES, statusLabel),
      filterProject,
    ),
    sort: { name: "name", status: "status", mac: "mac_address", ...(all ? { project: "project_id" } : {}) },
    tableId: all ? "admin-ports" : "ports",
  });

  const netName = useMemo(() => {
    const m = new Map(nets.data?.map((n) => [n.id, n.name || n.id]));
    return (id: string) => m.get(id) ?? id.slice(0, 8);
  }, [nets.data]);
  const sgName = useMemo(() => {
    const m = new Map(groups.data?.map((g) => [g.id, g.name]));
    return (id: string) => m.get(id) ?? id.slice(0, 8);
  }, [groups.data]);
  const projectName = (id?: string) => (id ? (projects.data?.find((p) => p.id === id)?.name ?? id) : "");
  const ips = (p: Port) => p.fixed_ips.map((f) => f.ip_address).join(", ");
  const device = (p: Port) => (p.device_owner?.startsWith("compute:") ? serverName(p.device_id) : portOwner(p));
  const sgs = (p: Port) => (p.port_security_enabled === false ? tr("port security off") : (p.security_groups ?? []).map(sgName).join(", "));
  const dns = useNeutronDns();
  const fqdn = (p: Port) => [...new Set((p.dns_assignment ?? []).map((a) => a.fqdn).filter(Boolean))].join(", ") || p.dns_name || "";

  const columns: Column<Port>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (p) => (
        <div className="min-w-0">
          <p className={p.name ? "truncate font-medium" : "truncate text-muted"} title={p.id}>
            {portLabel(p)}
          </p>
          <Link to={`/network/networks/${p.network_id}?tab=ports`} className="block truncate text-xs text-muted hover:text-cable">
            {netName(p.network_id)}
          </Link>
        </div>
      ),
      value: (p) => `${portLabel(p)} ${netName(p.network_id)}`,
      csv: (p) => p.name,
    },
    ...(all
      ? [{ key: "project", header: tr("Project"), width: "9rem", hideBelow: "md" as const, cell: (p: Port) => projectName(p.project_id), value: (p: Port) => projectName(p.project_id) }]
      : []),
    { key: "ips", header: tr("Fixed IPs"), width: "10rem", mono: true, cell: ips, value: ips },
    { key: "mac", header: tr("MAC address"), width: "10.5rem", mono: true, hideBelow: "xl", cell: (p) => p.mac_address, value: (p) => p.mac_address },
    {
      key: "device",
      header: tr("Attached device"),
      hideBelow: "sm",
      cell: (p) =>
        p.device_owner?.startsWith("compute:") && p.device_id ? (
          <Link to={`/compute/instances/${p.device_id}`} className="text-cable hover:underline">
            {serverName(p.device_id)}
          </Link>
        ) : p.device_owner?.startsWith("network:router") && p.device_id ? (
          <Link to={`/network/routers/${p.device_id}`} className="text-cable hover:underline">
            {portOwner(p)}
          </Link>
        ) : (
          <span className="text-muted">{portOwner(p)}</span>
        ),
      value: device,
      csv: (p) => `${p.device_owner} ${p.device_id}`.trim(),
    },
    { key: "sgs", header: tr("Security groups"), hideBelow: "2xl", cell: sgs, value: sgs },
    ...(dns.on ? [{ key: "dns", header: tr("DNS name"), hideBelow: "2xl" as const, mono: true, cell: fqdn, value: fqdn }] : []),
    { key: "status", header: tr("Status"), width: "6.5rem", cell: (p) => <StatusDot status={networkStatus(p.status)} label={p.status.toLowerCase()} />, value: (p) => p.status },
    { key: "admin", header: tr("Admin"), width: "5rem", hideBelow: "lg", cell: (p) => (p.admin_state_up === false ? tr("Down") : tr("Up")), value: (p) => (p.admin_state_up === false ? "Down" : "Up") },
  ];

  return (
    <>
      <PageHeader
        title={all ? tr("All ports") : tr("Ports")}
        description={
          all
            ? tr("Every Neutron port in the cloud: instance interfaces, router and DHCP ports, VIPs and free ports.")
            : tr("Network interfaces of this project. Create a port to reserve an address or MAC, then attach it to an instance or use it as a VIP.")
        }
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            {tr("Create port")}
          </Button>
        }
      />
      <ErrorNotice error={ports.error} className="mb-4" />
      <DataTable
        rows={ports.rows}
        remote={ports.remote}
        columns={columns}
        rowKey={(p) => p.id}
        loading={ports.isPending}
        tableId={all ? "admin-ports" : "ports"}
        noun={tr("ports")}
        rowLabel={portLabel}
        empty={all ? tr("No ports match.") : tr("No ports in this project.")}
        onRefresh={() => ports.refetch()}
        refreshing={ports.isFetching}
        onBulkDone={() => invalidate("network", "compute")}
        rowActions={actions.items}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete ports?"),
            past: tr("deleted"),
            body: tr("Instances lose the interfaces immediately. Router and DHCP ports are skipped."),
            check: (p) => (p.device_owner?.startsWith("network:") ? tr("Managed by Neutron") : true),
            run: (p) => os.del("network", `ports/${p.id}`),
          },
        ]}
      />
      {creating && <PortDialog onClose={() => setCreating(false)} />}
      {actions.dialogs}
    </>
  );
}
