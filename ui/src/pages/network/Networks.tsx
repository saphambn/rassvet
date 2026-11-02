import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { Link, useNavigate } from "@/components/Link";
import { type Column, DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { ActionMenu } from "@/components/Menu";
import { useToast } from "@/components/Toast";
import { Badge, Button, Card, Detail, ErrorNotice, Field, Icon, Input, Mono, PageHeader, StatusDot, Switch, Tabs } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { useProjects } from "@/lib/identity";
import { type Agent, useQosPolicies, useSubnetPools } from "@/lib/neutron";
import { Picker } from "@/components/Picker";
import {
  type Network,
  type Port,
  type Subnet,
  networkStatus,
  os,
  portLabel,
  portOwner,
  useInvalidate,
  useListOrPages,
  useOsGet,
  usePorts,
  useSecurityGroups,
  useSubnets,
} from "@/lib/os";
import { useSession } from "@/lib/session";
import { useTab, useNewParam } from "@/lib/useTab";
import { NEUTRON_STATUSES, choice, filters, statusLabel, useProjectFilter, idFilter, nameRegex } from "@/lib/filters";
import { useServerNames } from "../storage/Volumes";
import { PortDialog, SubnetDialog, useNetworkActions, usePortActions, useSubnetActions } from "./networkActions";
import { type SubnetSourceState, SubnetSourceFields, useSubnetSource } from "./subnetSource";
import { QosPolicyPicker } from "./QosPolicies";
import { NetworkSharing } from "./Rbac";
import { DnsDomainField, FixedIps, dnsDomain, dnsNameOk, useNeutronDns } from "./dns";
import { tr } from "@/lib/i18n";

export default function Networks({ admin = false }: { admin?: boolean }) {
  const session = useSession().data!;
  const filterProject = useProjectFilter(admin);
  // Neutron returns every project's networks to admins, and "own, shared or external" isn't one
  // query, so an admin's project view loads the whole list and filters it; everyone else pages.
  const paged = admin || !session.is_admin;
  const yesNo = [
    { value: "true", label: tr("Yes") },
    { value: "false", label: tr("No") },
  ];
  const networks = useListOrPages<Network>(paged, "network", "networks", "networks", undefined, {
    filters: filters(
      nameRegex(),
      idFilter("networks", "network"),
      filterProject,
      admin && choice("type", tr("Network type"), "provider:network_type", ["flat", "vlan", "vxlan", "geneve", "gre", "local"]),
      { key: "external", label: tr("External"), param: "router:external", options: yesNo },
      { key: "shared", label: tr("Shared"), param: "shared", options: yesNo },
      choice("status", tr("Status"), "status", NEUTRON_STATUSES, statusLabel),
    ),
    sort: { name: "name", status: "status", mtu: "mtu", ...(admin ? { project: "project_id" } : {}) },
    tableId: admin ? "admin-networks" : "networks",
  });
  const projects = useProjects(admin);
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? id;
  const rows =
    admin || !session.is_admin
      ? networks.rows
      : networks.rows?.filter((n) => n.project_id === session.project?.id || n.shared || n["router:external"]);
  const subnets = useSubnets();
  const invalidate = useInvalidate();
  const actions = useNetworkActions();
  const [creating, setCreating] = useState(false);
  useNewParam(setCreating);
  const cidrs = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of subnets.data ?? []) m.set(s.network_id, [...(m.get(s.network_id) ?? []), s.cidr]);
    return (n: Network) => (m.get(n.id) ?? []).join(", ");
  }, [subnets.data]);
  const mine = (n: Network) => n.project_id === session.project?.id || session.is_admin;

  const columns: Column<Network>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (n) => (
        <span className="inline-flex max-w-full items-center gap-2">
          <Link to={`/network/networks/${n.id}`} className="truncate font-medium text-cable hover:underline">
            {n.name || n.id}
          </Link>
          {n["router:external"] && <Badge tone="warn">{tr("external")}</Badge>}
          {n.shared && <Badge>{tr("shared")}</Badge>}
        </span>
      ),
      value: (n) => n.name,
    },
    ...(admin
      ? [
          { key: "project", header: tr("Project"), width: "9rem", hideBelow: "md", cell: (n: Network) => projectName(n.project_id), value: (n: Network) => projectName(n.project_id) } as Column<Network>,
          {
            key: "provider",
            header: tr("Provider"),
            width: "10rem",
            hideBelow: "lg",
            cell: (n: Network) => [n["provider:network_type"], n["provider:physical_network"], n["provider:segmentation_id"]].filter((x) => x != null && x !== "").join(" · "),
            value: (n: Network) => [n["provider:network_type"], n["provider:physical_network"], n["provider:segmentation_id"]].filter((x) => x != null && x !== "").join(" · "),
          } as Column<Network>,
        ]
      : []),
    { key: "subnets", header: tr("Subnets"), hideBelow: "md", mono: true, cell: cidrs, value: cidrs },
    { key: "status", header: tr("Status"), width: "7.5rem", cell: (n) => <StatusDot status={networkStatus(n.status)} label={n.status.toLowerCase()} />, value: (n) => n.status },
    { key: "mtu", header: "MTU", width: "5rem", hideBelow: "lg", cell: (n) => n.mtu ?? "", value: (n) => n.mtu ?? 0 },
    { key: "admin", header: tr("Admin state"), width: "7rem", hideBelow: "xl", cell: (n) => (n.admin_state_up ? tr("Up") : tr("Down")), value: (n) => (n.admin_state_up ? "Up" : "Down") },
  ];

  return (
    <>
      <PageHeader
        title={admin ? tr("All networks") : tr("Networks")}
        description={
          admin
            ? tr("Networks of every project. Create provider networks (flat, VLAN) and external networks here.")
            : tr("Private networks for this project's instances, plus shared and external networks you can use.")
        }
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            {admin ? tr("Create provider network") : tr("Create network")}
          </Button>
        }
      />
      <ErrorNotice error={networks.error} className="mb-4" />
      <DataTable
        rows={rows}
        remote={networks.remote}
        loadingMore={networks.partial}
        columns={columns}
        rowKey={(n) => n.id}
        loading={networks.isPending}
        tableId={admin ? "admin-networks" : "networks"}
        noun={tr("networks")}
        rowLabel={(n) => n.name || n.id}
        filterPlaceholder={tr("Filter by name or CIDR")}
        empty={tr("No networks yet.")}
        onRefresh={() => networks.refetch()}
        refreshing={networks.isFetching}
        onBulkDone={() => invalidate("network")}
        rowActions={actions.items}
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete networks?"),
            past: tr("deleted"),
            body: tr("Networks and their subnets are deleted. Neutron refuses while instances or router interfaces still use them."),
            check: (n) => (n["router:external"] ? tr("External network") : mine(n) ? true : tr("Owned by another project")),
            run: (n) => os.del("network", `networks/${n.id}`),
          },
        ]}
      />
      <CreateNetworkDialog open={creating} onClose={() => setCreating(false)} provider={admin} />
      {actions.dialogs}
    </>
  );
}

type SubnetVals = { name: string; gateway: boolean; dhcp: boolean; dns: string; publish?: boolean };

function SubnetFields({ v, set, src }: { v: SubnetVals; set: (p: Partial<SubnetVals>) => void; src: SubnetSourceState }) {
  const dns = useNeutronDns();
  return (
    <>
      <Field label={tr("Subnet name")}>{(id) => <Input id={id} value={v.name} onChange={(e) => set({ name: e.target.value })} />}</Field>
      <SubnetSourceFields src={src} />
      <Field label={tr("DNS servers")} hint={tr("Comma-separated. Leave empty to use the cloud's default.")}>
        {(id) => <Input id={id} value={v.dns} onChange={(e) => set({ dns: e.target.value })} placeholder="1.1.1.1, 8.8.8.8" className="font-mono text-[13px]" />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Switch checked={v.gateway} onChange={(gateway) => set({ gateway })} label={tr("Gateway")} hint={tr("First address of the subnet. Needed to reach other networks through a router.")} />
        <Switch checked={v.dhcp} onChange={(dhcp) => set({ dhcp })} label="DHCP" hint={tr("Instances get their address automatically.")} />
      </div>
      {dns.publishFixedIp && (
        <Switch checked={!!v.publish} onChange={(publish) => set({ publish })} label={tr("Publish fixed IPs in DNS")} hint={tr("Neutron also publishes the fixed IPs of named ports in Designate, not only floating IPs. Needs a DNS domain on the network or the port.")} />
      )}
    </>
  );
}

function subnetBody(networkId: string, v: SubnetVals, src: SubnetSourceState) {
  const body: Record<string, unknown> = {
    network_id: networkId,
    name: v.name || undefined,
    ...src.body(),
    enable_dhcp: v.dhcp,
    dns_nameservers: v.dns.split(",").map((s) => s.trim()).filter(Boolean),
    ...(v.publish ? { dns_publish_fixed_ip: true } : {}),
  };
  if (!v.gateway) body.gateway_ip = null;
  return { subnet: body };
}

const NET_TYPES = [
  { value: "", label: tr("Cloud default"), description: tr("Tenant network type (VXLAN/Geneve)") },
  { value: "flat", label: tr("flat"), description: tr("Untagged, on a physical network") },
  { value: "vlan", label: tr("vlan"), description: tr("802.1Q tag on a physical network") },
  { value: "vxlan", label: tr("vxlan") },
  { value: "geneve", label: tr("geneve") },
  { value: "gre", label: tr("gre") },
  { value: "local", label: tr("local"), description: tr("Only on one host (testing)") },
];

function CreateNetworkDialog({ open, onClose, provider }: { open: boolean; onClose: () => void; provider?: boolean }) {
  const session = useSession().data!;
  const projects = useProjects(!!provider);
  const [project, setProject] = useState("");
  const [netType, setNetType] = useState("");
  const [physnet, setPhysnet] = useState("");
  const [segId, setSegId] = useState("");
  const [external, setExternal] = useState(false);
  const [shared, setShared] = useState(false);
  const [qos, setQos] = useState("");
  const dns = useNeutronDns();
  const [domain, setDomain] = useState("");
  const invalidate = useInvalidate();
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [withSubnet, setWithSubnet] = useState(true);
  const [sub, setSub] = useState<SubnetVals>({ name: "", gateway: true, dhcp: true, dns: "" });
  const src = useSubnetSource({ cidr: "10.0.0.0/24" });
  const m = useMutation({
    mutationFn: async () => {
      const n = await os.post<{ network: Network }>("network", "networks", {
        network: {
          name: name.trim(),
          admin_state_up: true,
          ...(qos ? { qos_policy_id: qos } : {}),
          ...(dns.on && domain.trim() ? { dns_domain: dnsDomain(domain) } : {}),
          ...(provider
            ? {
                ...(project ? { project_id: project } : {}),
                ...(netType ? { "provider:network_type": netType } : {}),
                ...(physnet.trim() && (netType === "flat" || netType === "vlan") ? { "provider:physical_network": physnet.trim() } : {}),
                ...(segId && netType && netType !== "flat" && netType !== "local" ? { "provider:segmentation_id": Number(segId) } : {}),
                "router:external": external,
                shared,
              }
            : {}),
        },
      });
      if (withSubnet) {
        try {
          await os.post("network", "subnets", subnetBody(n.network.id, { ...sub, name: sub.name || `${name.trim()}-subnet` }, src));
        } catch (e) {
          // Keep the network; tell the user the subnet part failed.
          throw Object.assign(e as Error, { message: tr("Network created, but the subnet failed: {message}", { message: (e as Error).message }) });
        }
      }
      return n.network;
    },
    onSuccess: (n) => {
      toast(tr("Network {name} created", { name: n.name }));
      invalidate("network");
      onClose();
      navigate(`/network/networks/${n.id}`);
    },
    onError: () => invalidate("network"),
  });
  return (
    <Dialog
      open={open}
      onClose={() => {
        m.reset();
        onClose();
      }}
      title={provider ? tr("Create provider network") : tr("Create network")}
      onSubmit={() => m.mutate()}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {tr("Cancel")}
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending} disabled={!name.trim() || (withSubnet && !src.valid) || !dnsNameOk(domain)}>
            {tr("Create network")}
          </Button>
        </>
      }
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={provider ? tr("provider-vlan120") : tr("app-net")} />}</Field>
      {provider && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tr("Project")}>
              {(id) => (
                <Picker
                  id={id}
                  value={project}
                  onChange={setProject}
                  searchable
                  loading={projects.isPending}
                  options={[{ value: "", label: tr("{v} (current)", { v: session.project?.name ?? tr("Current project") }) }, ...(projects.data ?? []).filter((p) => p.id !== session.project?.id).map((p) => ({ value: p.id, label: p.name, icon: "folder" }))]}
                />
              )}
            </Field>
            <Field label={tr("Network type")}>{(id) => <Picker id={id} value={netType} onChange={setNetType} options={NET_TYPES} />}</Field>
          </div>
          {(netType === "flat" || netType === "vlan" || (netType && netType !== "local")) && (
            <div className="grid gap-4 sm:grid-cols-2">
              {(netType === "flat" || netType === "vlan") && (
                <Field label={tr("Physical network")} hint={tr("Name from the agents' bridge mappings, e.g. physnet1.")}>
                  {(id) => <Input id={id} value={physnet} onChange={(e) => setPhysnet(e.target.value)} placeholder={tr("physnet1")} className="font-mono text-[13px]" />}
                </Field>
              )}
              {netType !== "flat" && (
                <Field label={netType === "vlan" ? tr("VLAN ID") : tr("Segmentation ID")} hint={netType === "vlan" ? "1–4094" : tr("VNI; empty lets Neutron choose.")}>
                  {(id) => <Input id={id} type="number" min={1} value={segId} onChange={(e) => setSegId(e.target.value)} />}
                </Field>
              )}
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Switch checked={external} onChange={setExternal} label={tr("External network")} hint={tr("Usable for router gateways and floating IPs.")} />
            <Switch checked={shared} onChange={setShared} label={tr("Shared")} hint={tr("Every project can attach ports to it.")} />
          </div>
        </>
      )}
      <Field label={tr("QoS policy")}>{(id) => <QosPolicyPicker id={id} value={qos} onChange={setQos} />}</Field>
      {dns.on && <DnsDomainField value={domain} onChange={setDomain} />}
      <Switch checked={withSubnet} onChange={setWithSubnet} label={tr("Create a subnet")} hint={tr("Instances need a subnet to get an IP address.")} />
      {withSubnet && <SubnetFields v={sub} set={(p) => setSub((s) => ({ ...s, ...p }))} src={src} />}
      <ErrorNotice error={m.error} />
    </Dialog>
  );
}

const TABS = ["overview", "subnets", "ports", "sharing", "dhcp"] as const;

export function NetworkDetail() {
  const { id = "" } = useParams();
  const session = useSession().data!;
  const net = useOsGet<Network>("network", `networks/${id}`, (r: { network: Network }) => r.network);
  const subnets = useSubnets({ network_id: id });
  const ports = usePorts({ network_id: id });
  const projects = useProjects(session.is_admin);
  const actions = useNetworkActions();
  const qos = useQosPolicies();
  const dns = useNeutronDns();
  const [tab, setTab] = useTab(TABS, "overview");
  const n = net.data;
  const projectName = (pid: string) => projects.data?.find((p) => p.id === pid)?.name ?? session.projects.find((p) => p.id === pid)?.name ?? pid;

  return (
    <>
      <Link to="/network/networks" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <Icon name="arrow-left" className="size-3.5" />
        {tr("Networks")}
      </Link>
      <PageHeader
        title={n?.name || tr("Network")}
        description={n ? n.description || tr("{v} network in {projectName}", { v: n["router:external"] ? tr("External") : n.shared ? tr("Shared") : tr("Project"), projectName: projectName(n.project_id) }) : undefined}
        actions={n && <ActionMenu variant="button" items={() => actions.items(n).slice(2)} />}
      />
      <ErrorNotice error={net.error} className="mb-4" />
      {n && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            className="mb-5"
            tabs={[
              { id: "overview", label: tr("Overview") },
              { id: "subnets", label: tr("Subnets ({v})", { v: subnets.data?.length ?? "…" }) },
              { id: "ports", label: tr("Ports ({v})", { v: ports.data?.length ?? "…" }) },
              { id: "sharing", label: tr("Sharing") },
              ...(session.is_admin ? [{ id: "dhcp" as const, label: tr("DHCP agents") }] : []),
            ]}
          />
          {tab === "overview" && (
            <div className="grid items-start gap-6 lg:grid-cols-2">
              <Card title={tr("Details")}>
                <dl>
                  <Detail label={tr("Name")}>{n.name || "—"}</Detail>
                  <Detail label="ID">
                    <Mono>{n.id}</Mono>
                  </Detail>
                  <Detail label={tr("Project")}>{projectName(n.project_id)}</Detail>
                  <Detail label={tr("Status")}>
                    <StatusDot status={networkStatus(n.status)} label={n.status.toLowerCase()} />
                  </Detail>
                  <Detail label={tr("Admin state")}>{n.admin_state_up ? tr("Up") : tr("Down")}</Detail>
                  <Detail label={tr("Shared")}>{n.shared ? tr("Yes") : tr("No")}</Detail>
                  <Detail label={tr("External")}>{n["router:external"] ? tr("Yes") : tr("No")}</Detail>
                  {n.description && (
                    <Detail label={tr("Description")} wrap>
                      {n.description}
                    </Detail>
                  )}
                  {n.created_at && <Detail label={tr("Created")}>{fmtDate(n.created_at)}</Detail>}
                </dl>
              </Card>
              <Card title={tr("Configuration")}>
                <dl>
                  <Detail label="MTU">{n.mtu ?? "—"}</Detail>
                  <Detail label={tr("QoS policy")}>
                    {n.qos_policy_id ? (
                      <Link to={`/network/qos/${n.qos_policy_id}`} className="text-cable hover:underline">
                        {qos.data?.find((q) => q.id === n.qos_policy_id)?.name ?? n.qos_policy_id}
                      </Link>
                    ) : (
                      tr("None")
                    )}
                  </Detail>
                  <Detail label={tr("Port security")}>{n.port_security_enabled === false ? tr("Off by default") : tr("On by default")}</Detail>
                  {dns.on && <Detail label={tr("DNS domain")}>{n.dns_domain ? <Mono>{n.dns_domain}</Mono> : tr("None")}</Detail>}
                  {n["provider:network_type"] && <Detail label={tr("Network type")}>{n["provider:network_type"]}</Detail>}
                  {n["provider:physical_network"] && <Detail label={tr("Physical network")}>{n["provider:physical_network"]}</Detail>}
                  {n["provider:segmentation_id"] != null && <Detail label={tr("Segmentation ID")}>{n["provider:segmentation_id"]}</Detail>}
                  {!!n.availability_zones?.length && <Detail label={tr("Zones")}>{n.availability_zones.join(", ")}</Detail>}
                  <Detail label={tr("Subnets")}>{subnets.data?.map((s) => s.cidr).join(", ") || tr("None")}</Detail>
                  <Detail label={tr("Ports")}>{ports.data?.length ?? "…"}</Detail>
                </dl>
              </Card>
            </div>
          )}
          {tab === "subnets" && <SubnetsTab network={n} subnets={subnets} />}
          {tab === "ports" && <PortsTab network={n} ports={ports} subnets={subnets.data ?? []} />}
          {tab === "sharing" && <NetworkSharing network={n} />}
          {tab === "dhcp" && session.is_admin && <DhcpAgents networkId={n.id} />}
        </>
      )}
      {actions.dialogs}
    </>
  );
}

function SubnetsTab({ network, subnets }: { network: Network; subnets: ReturnType<typeof useSubnets> }) {
  const [creating, setCreating] = useState(false);
  const dns = useNeutronDns();
  const actions = useSubnetActions(network);
  const pools = (s: Subnet) => (s.allocation_pools ?? []).map((p) => `${p.start} – ${p.end}`).join(", ");
  const subnetPools = useSubnetPools(undefined, !!subnets.data?.some((s) => s.subnetpool_id));
  const poolName = (s: Subnet) => (s.subnetpool_id ? (subnetPools.data?.find((p) => p.id === s.subnetpool_id)?.name || s.subnetpool_id.slice(0, 8)) : "");
  const columns: Column<Subnet>[] = [
    { key: "name", header: tr("Name"), cell: (s) => <span className="font-medium">{s.name || <span className="text-muted">({s.id.slice(0, 13)})</span>}</span>, value: (s) => s.name },
    { key: "cidr", header: tr("Network address"), width: "11rem", mono: true, cell: (s) => s.cidr, value: (s) => s.cidr },
    { key: "ver", header: "IP", width: "4.5rem", hideBelow: "lg", cell: (s) => tr("IPv{ip_version}", { ip_version: s.ip_version }), value: (s) => s.ip_version },
    { key: "gw", header: tr("Gateway"), width: "9rem", mono: true, hideBelow: "sm", cell: (s) => s.gateway_ip ?? <span className="font-sans text-muted">{tr("none")}</span>, value: (s) => s.gateway_ip ?? "" },
    { key: "dhcp", header: "DHCP", width: "5.5rem", hideBelow: "md", cell: (s) => (s.enable_dhcp ? tr("On") : tr("Off")), value: (s) => (s.enable_dhcp ? "On" : "Off") },
    { key: "pools", header: tr("Allocation pools"), hideBelow: "xl", mono: true, cell: pools, value: pools },
    {
      key: "subnetpool",
      header: tr("Subnet pool"),
      width: "9rem",
      hideBelow: "2xl",
      cell: (s) =>
        s.subnetpool_id ? (
          <Link to={`/network/subnet-pools/${s.subnetpool_id}`} className="text-cable hover:underline">
            {poolName(s)}
          </Link>
        ) : (
          <span className="text-muted">—</span>
        ),
      value: poolName,
    },
    { key: "dns", header: "DNS", hideBelow: "2xl", mono: true, cell: (s) => (s.dns_nameservers ?? []).join(", "), value: (s) => (s.dns_nameservers ?? []).join(", ") },
    ...(dns.publishFixedIp
      ? [{ key: "publish", header: tr("Fixed IPs in DNS"), width: "9rem", hideBelow: "lg" as const, cell: (s: Subnet) => (s.dns_publish_fixed_ip ? tr("Published") : tr("No")), value: (s: Subnet) => (s.dns_publish_fixed_ip ? "Published" : "No") }]
      : []),
  ];
  return (
    <>
      <DataTable
        rows={subnets.data}
        columns={columns}
        rowKey={(s) => s.id}
        loading={subnets.isPending}
        tableId="network-subnets"
        noun={tr("subnets")}
        rowLabel={(s) => s.name || s.cidr}
        filterPlaceholder={tr("Filter by name, CIDR or gateway")}
        empty={tr("No subnets. Add one so instances get addresses.")}
        onRefresh={() => subnets.refetch()}
        refreshing={subnets.isFetching}
        rowActions={actions.items}
        toolbar={
          <Button className="h-9" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            {tr("Create subnet")}
          </Button>
        }
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete subnets?"),
            past: tr("deleted"),
            body: tr("Neutron refuses while ports still have addresses on a subnet."),
            run: (s) => os.del("network", `subnets/${s.id}`),
          },
        ]}
      />
      {creating && <SubnetDialog network={network} onClose={() => setCreating(false)} />}
      {actions.dialogs}
    </>
  );
}

function PortsTab({ network, ports, subnets }: { network: Network; ports: ReturnType<typeof usePorts>; subnets: Subnet[] }) {
  const serverName = useServerNames();
  const actions = usePortActions({ serverName });
  const groups = useSecurityGroups();
  const [creating, setCreating] = useState(false);
  const sgName = useMemo(() => {
    const m = new Map(groups.data?.map((g) => [g.id, g.name]));
    return (id: string) => m.get(id) ?? id.slice(0, 8);
  }, [groups.data]);
  const subnetName = (id: string) => subnets.find((s) => s.id === id)?.name;
  const ips = (p: Port) => p.fixed_ips.map((f) => f.ip_address).join(", ");
  const dns = useNeutronDns();
  const device = (p: Port) => (p.device_owner?.startsWith("compute:") ? serverName(p.device_id) : portOwner(p));
  const sgs = (p: Port) => (p.port_security_enabled === false ? tr("port security off") : (p.security_groups ?? []).map(sgName).join(", "));

  const columns: Column<Port>[] = [
    {
      key: "name",
      header: tr("Name"),
      cell: (p) => <span className={p.name ? "font-medium" : "text-muted"}>{portLabel(p)}</span>,
      value: (p) => `${portLabel(p)} ${p.id}`,
    },
    {
      key: "ips",
      header: tr("Fixed IPs"),
      width: dns.on ? "13rem" : "10rem",
      wrap: dns.on,
      mono: true,
      cell: (p) =>
        dns.on && p.dns_name ? (
          <FixedIps port={p} subnets={subnets} dnsOn />
        ) : (
          <span title={p.fixed_ips.map((f) => `${f.ip_address} on ${subnetName(f.subnet_id) ?? f.subnet_id}`).join("\n")}>{ips(p)}</span>
        ),
      value: ips,
    },
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
    { key: "status", header: tr("Status"), width: "6.5rem", cell: (p) => <StatusDot status={networkStatus(p.status)} label={p.status.toLowerCase()} />, value: (p) => p.status },
    { key: "admin", header: tr("Admin"), width: "5rem", hideBelow: "lg", cell: (p) => (p.admin_state_up === false ? tr("Down") : tr("Up")), value: (p) => (p.admin_state_up === false ? "Down" : "Up") },
  ];
  return (
    <>
      <DataTable
        rows={ports.data}
        columns={columns}
        rowKey={(p) => p.id}
        loading={ports.isPending}
        tableId="network-ports"
        noun={tr("ports")}
        rowLabel={portLabel}
        filterPlaceholder={tr("Filter by name, IP, MAC or device")}
        empty={tr("No ports on this network.")}
        onRefresh={() => ports.refetch()}
        refreshing={ports.isFetching}
        rowActions={actions.items}
        toolbar={
          <Button className="h-9" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            {tr("Create port")}
          </Button>
        }
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
      {creating && <PortDialog network={network} onClose={() => setCreating(false)} />}
      {actions.dialogs}
    </>
  );
}

/** Admin: DHCP agents serving a network. */
function DhcpAgents({ networkId }: { networkId: string }) {
  const navigate = useNavigate();
  const agents = useQuery({
    queryKey: ["os", "network", "networks", networkId, "dhcp-agents"],
    queryFn: () => os.get<{ agents: Agent[] }>("network", `networks/${networkId}/dhcp-agents`).then((r) => r.agents),
  });
  const columns: Column<Agent>[] = [
    { key: "host", header: tr("Host"), cell: (a) => <span className="font-medium">{a.host}</span>, value: (a) => a.host },
    { key: "state", header: tr("State"), width: "8.5rem", cell: (a) => <StatusDot status={a.alive ? (a.admin_state_up ? "ok" : "warn") : "error"} label={!a.alive ? tr("down") : a.admin_state_up ? tr("alive") : tr("disabled")} />, value: (a) => (a.alive ? 1 : 0) },
    { key: "beat", header: tr("Last heartbeat"), width: "10.5rem", hideBelow: "md", cell: (a) => fmtDate(a.heartbeat_timestamp), value: (a) => a.heartbeat_timestamp },
  ];
  return (
    <>
      <ErrorNotice error={agents.error} className="mb-4" />
      <DataTable
        rows={agents.data}
        columns={columns}
        rowKey={(a) => a.id}
        loading={agents.isPending}
        noun={tr("agents")}
        empty={tr("No DHCP agent serves this network (DHCP is off on its subnets, or the cloud uses OVN's built-in DHCP).")}
        onRefresh={() => agents.refetch()}
        refreshing={agents.isFetching}
        rowActions={() => [{ label: tr("Manage in Network agents"), icon: "activity", onSelect: () => navigate("/admin/network/agents") }]}
      />
    </>
  );
}
