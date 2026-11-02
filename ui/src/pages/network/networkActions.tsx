/**
 * Actions and dialogs for networks, subnets and ports, shared by the list pages,
 * the network detail tabs and the instance detail page.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import type { MenuEntry } from "@/components/Menu";
import { MultiPicker, type PickOption, Picker } from "@/components/Picker";
import { Field, Input, Switch, Textarea } from "@/components/ui";
import {
  type FloatingIp,
  type Network,
  type Port,
  type Subnet,
  os,
  portLabel,
  useFloatingIps,
  useNetworks,
  useSecurityGroups,
  useSubnets,
} from "@/lib/os";
import { useSession } from "@/lib/session";
import { QosPolicyPicker } from "./QosPolicies";
import { SubnetSourceFields, useSubnetSource } from "./subnetSource";
import { DnsDomainField, dnsDomain, dnsNameOk, useNeutronDns } from "./dns";
import { tr, trx } from "@/lib/i18n";

// =========================================================================== shared bits

export function useNetName() {
  const networks = useNetworks();
  return useMemo(() => {
    const m = new Map(networks.data?.map((n) => [n.id, n.name || n.id]));
    return (id: string) => m.get(id) ?? id;
  }, [networks.data]);
}

/** Security groups of the current project as picker options (rule count as meta). */
export function useSgOptions(projectId?: string) {
  const session = useSession().data!;
  const pid = projectId ?? session.project?.id;
  const groups = useSecurityGroups(pid ? { project_id: pid } : undefined);
  const options: PickOption[] = (groups.data ?? [])
    .slice()
    .sort((a, b) => (a.name === "default" ? -1 : b.name === "default" ? 1 : a.name.localeCompare(b.name)))
    .map((g) => ({
      value: g.id,
      label: g.name,
      description: g.description || undefined,
      meta: tr("{v} in", { v: g.security_group_rules?.filter((r) => r.direction === "ingress").length ?? 0 }),
    }));
  return { options, groups, loading: groups.isPending };
}

export function SgPicker({ id, value, onChange, projectId, disabled }: { id?: string; value: string[]; onChange: (v: string[]) => void; projectId?: string; disabled?: boolean }) {
  const { options, loading } = useSgOptions(projectId);
  return (
    <MultiPicker
      id={id}
      values={value}
      onChange={onChange}
      options={options}
      loading={loading}
      disabled={disabled}
      placeholder={tr("No security groups (all traffic blocked)")}
      searchPlaceholder={tr("Search security groups")}
      searchable
    />
  );
}

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

// =========================================================================== networks

export function EditNetworkDialog({ network, onClose }: { network: Network; onClose: () => void }) {
  const session = useSession().data!;
  const [name, setName] = useState(network.name);
  const [description, setDescription] = useState(network.description ?? "");
  const [up, setUp] = useState(network.admin_state_up);
  const [shared, setShared] = useState(network.shared);
  const [portSecurity, setPortSecurity] = useState(network.port_security_enabled ?? true);
  const [mtu, setMtu] = useState(network.mtu ? String(network.mtu) : "");
  const [qos, setQos] = useState(network.qos_policy_id ?? "");
  const dns = useNeutronDns();
  const [domain, setDomain] = useState(network.dns_domain ?? "");
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Edit {v}", { v: network.name || tr("network") })}
      canSubmit={dnsNameOk(domain)}
      submitLabel={tr("Save")}
      done={tr("Network {v} updated", { v: name || network.id })}
      refresh={["network"]}
      run={() =>
        os.put("network", `networks/${network.id}`, {
          network: {
            name: name.trim(),
            description,
            admin_state_up: up,
            ...(session.is_admin ? { shared } : {}),
            ...(network.port_security_enabled !== undefined ? { port_security_enabled: portSecurity } : {}),
            ...(mtu && Number(mtu) !== network.mtu ? { mtu: Number(mtu) } : {}),
            ...(qos !== (network.qos_policy_id ?? "") ? { qos_policy_id: qos || null } : {}),
            // Neutron clears the domain with an empty string.
            ...(dns.on && dnsDomain(domain) !== (network.dns_domain ?? "") ? { dns_domain: dnsDomain(domain) } : {}),
          },
        })
      }
    >
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label={tr("Description")}>{(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <Field label="MTU" hint={tr("Leave as is unless you know the underlay supports it.")}>
        {(id) => <Input id={id} type="number" min={68} value={mtu} onChange={(e) => setMtu(e.target.value)} className="w-32" />}
      </Field>
      <Field label={tr("QoS policy")} hint={tr("Applies to every port on the network that has no policy of its own.")}>{(id) => <QosPolicyPicker id={id} value={qos} onChange={setQos} />}</Field>
      {dns.on && (
        <DnsDomainField
          value={domain}
          onChange={setDomain}
          hint={tr("Zone for the records of this network's ports. A change applies to the records Neutron publishes from now on; empty stops publishing.")}
        />
      )}
      <Switch checked={up} onChange={setUp} label={tr("Admin state up")} hint={tr("A network that is down passes no traffic.")} />
      {network.port_security_enabled !== undefined && (
        <Switch checked={portSecurity} onChange={setPortSecurity} label={tr("Port security")} hint={tr("Default for new ports: security groups and anti-spoofing apply.")} />
      )}
      {session.is_admin && <Switch checked={shared} onChange={setShared} label={tr("Shared")} hint={tr("Every project can attach instances to this network.")} />}
    </ActionDialog>
  );
}

// =========================================================================== subnets

/**
 * Create or edit a subnet. Without `network` (creating from a subnet pool's page) the
 * network is picked here; `poolId` preselects "Allocate from a subnet pool".
 */
export function SubnetDialog({ network, subnet, poolId, onClose }: { network?: Network; subnet?: Subnet; poolId?: string; onClose: () => void }) {
  const session = useSession().data!;
  const editing = !!subnet;
  const nets = useNetworks(undefined, !network);
  const [netChoice, setNetChoice] = useState("");
  const net = network ?? nets.data?.find((n) => n.id === netChoice);
  const src = useSubnetSource(poolId ? { mode: "pool", pool: poolId } : undefined);
  const [name, setName] = useState(subnet?.name ?? "");
  const [description, setDescription] = useState(subnet?.description ?? "");
  const [gwMode, setGwMode] = useState<"auto" | "custom" | "none">(subnet ? (subnet.gateway_ip ? "custom" : "none") : "auto");
  const [gw, setGw] = useState(subnet?.gateway_ip ?? "");
  const [dhcp, setDhcp] = useState(subnet?.enable_dhcp ?? true);
  const [dns, setDns] = useState((subnet?.dns_nameservers ?? []).join("\n"));
  const [pools, setPools] = useState((subnet?.allocation_pools ?? []).map((p) => `${p.start}, ${p.end}`).join("\n"));
  const [routes, setRoutes] = useState((subnet?.host_routes ?? []).map((r) => `${r.destination}, ${r.nexthop}`).join("\n"));

  const pair = (l: string) => l.replace(/\s+-\s+/, ",").split(/[,\s]+/).filter(Boolean);
  const poolList = lines(pools).map(pair);
  const routeList = lines(routes).map(pair);
  const valid =
    (editing || (!!net && src.valid)) &&
    (gwMode !== "custom" || gw.trim() !== "") &&
    poolList.every((p) => p.length === 2) &&
    routeList.every((r) => r.length === 2);

  const body = () => {
    const b: Record<string, unknown> = {
      name: name.trim(),
      description,
      enable_dhcp: dhcp,
      dns_nameservers: lines(dns.replace(/,/g, "\n")),
      host_routes: routeList.map(([destination, nexthop]) => ({ destination, nexthop })),
    };
    if (pools.trim() || editing) {
      const list = poolList.map(([start, end]) => ({ start, end }));
      if (list.length || !editing) b.allocation_pools = list.length ? list : undefined;
    }
    if (gwMode === "none") b.gateway_ip = null;
    else if (gwMode === "custom") b.gateway_ip = gw.trim();
    if (!editing) {
      b.network_id = net!.id;
      Object.assign(b, src.body());
      if (b.ip_version === 6) {
        b.ipv6_ra_mode = "slaac";
        b.ipv6_address_mode = "slaac";
      }
    }
    return { subnet: b };
  };

  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={editing ? tr("Edit subnet {v}", { v: subnet.name || subnet.cidr }) : network ? tr("Create subnet on {name}", { name: network.name }) : tr("Create subnet")}
      submitLabel={editing ? tr("Save") : tr("Create subnet")}
      canSubmit={valid}
      done={editing ? tr("Subnet updated") : tr("Subnet {v} created", { v: name || src.label })}
      refresh={["network"]}
      run={() => (editing ? os.put("network", `subnets/${subnet.id}`, body()) : os.post("network", "subnets", body()))}
    >
      {!network && !editing && (
        <Field label={tr("Network")}>
          {(id) => (
            <Picker
              id={id}
              value={netChoice}
              onChange={setNetChoice}
              searchable
              loading={nets.isPending}
              placeholder={tr("Choose a network")}
              options={(nets.data ?? [])
                .filter((n) => !n["router:external"] && (session.is_admin || n.project_id === session.project?.id))
                .map((n) => ({ value: n.id, label: n.name || n.id, icon: "network", description: n.subnets?.length ? tr("{n} subnet(s)", { n: n.subnets.length }) : tr("No subnets yet") }))}
            />
          )}
        </Field>
      )}
      {editing ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label={tr("Network address (CIDR)")} hint={tr("Can't be changed after creation.")}>
            {(id) => <Input id={id} value={subnet.cidr} disabled className="font-mono text-[13px]" />}
          </Field>
        </div>
      ) : (
        <>
          <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={net ? tr("{name}-subnet", { name: net.name }) : undefined} />}</Field>
          <SubnetSourceFields src={src} />
        </>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("Gateway")}>
          {(id) => (
            <Picker
              id={id}
              value={gwMode}
              onChange={(v) => setGwMode(v as typeof gwMode)}
              options={[
                ...(editing ? [] : [{ value: "auto", label: tr("First address"), description: tr("Neutron picks the first usable IP") }]),
                { value: "custom", label: tr("Specific address") },
                { value: "none", label: tr("No gateway"), description: tr("Isolated subnet; no route out") },
              ]}
            />
          )}
        </Field>
        {gwMode === "custom" && (
          <Field label={tr("Gateway IP")}>{(id) => <Input id={id} value={gw} onChange={(e) => setGw(e.target.value)} placeholder="10.0.0.1" className="font-mono text-[13px]" />}</Field>
        )}
      </div>
      <Switch checked={dhcp} onChange={setDhcp} label="DHCP" hint={tr("Instances get their address automatically.")} />
      <Field label={tr("DNS servers")} hint={tr("One per line (or comma-separated). Empty uses the cloud's default.")}>
        {(id) => <Textarea id={id} rows={2} value={dns} onChange={(e) => setDns(e.target.value)} placeholder={"1.1.1.1\n8.8.8.8"} className="font-mono text-[13px]" />}
      </Field>
      <Field label={tr("Allocation pools")} hint={tr("One range per line: start, end. Empty uses the whole subnet.")}>
        {(id) => <Textarea id={id} rows={2} value={pools} onChange={(e) => setPools(e.target.value)} placeholder="10.0.0.10, 10.0.0.200" className="font-mono text-[13px]" />}
      </Field>
      <Field label={tr("Host routes")} hint={tr("One per line: destination CIDR, next hop. Pushed to instances by DHCP.")}>
        {(id) => <Textarea id={id} rows={2} value={routes} onChange={(e) => setRoutes(e.target.value)} placeholder="192.168.0.0/16, 10.0.0.254" className="font-mono text-[13px]" />}
      </Field>
      <Field label={tr("Description")}>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
    </ActionDialog>
  );
}

export function useSubnetActions(network?: Network) {
  const [open, setOpen] = useState<{ kind: "edit" | "delete"; subnet: Subnet } | null>(null);
  const close = () => setOpen(null);
  const items = (s: Subnet): MenuEntry[] => [
    network && { label: tr("Edit subnet"), icon: "edit", onSelect: () => setOpen({ kind: "edit", subnet: s }) },
    "-",
    { label: tr("Delete subnet"), icon: "trash", danger: true, onSelect: () => setOpen({ kind: "delete", subnet: s }) },
  ];
  const dialogs = (
    <>
      {open?.kind === "edit" && network && <SubnetDialog network={network} subnet={open.subnet} onClose={close} />}
      {open?.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete subnet {v}?", { v: open.subnet.name || open.subnet.cidr })}
          submitLabel={tr("Delete subnet")}
          done={tr("Subnet deleted")}
          refresh={["network"]}
          run={() => os.del("network", `subnets/${open.subnet.id}`)}
        >
          <p className="text-sm">{tr("Neutron refuses while ports (instances, router interfaces) still have addresses on it.")}</p>
        </ActionDialog>
      )}
    </>
  );
  return { items, dialogs };
}

// =========================================================================== ports

/** Create a port on a network, or edit an existing one. */
export function PortDialog({ port, network, onClose }: { port?: Port; network?: Network; onClose: () => void }) {
  const editing = !!port;
  const session = useSession().data!;
  // Opened from the Ports page there is no network yet: pick one first.
  const [netChoice, setNetChoice] = useState("");
  const networks = useNetworks(undefined, !editing && !network);
  const netId = port?.network_id ?? network?.id ?? netChoice;
  const subnets = useSubnets({ network_id: netId });
  const [name, setName] = useState(port?.name ?? "");
  const [description, setDescription] = useState(port?.description ?? "");
  const [up, setUp] = useState(port?.admin_state_up ?? true);
  const [portSecurity, setPortSecurity] = useState(port?.port_security_enabled ?? network?.port_security_enabled ?? true);
  const [sgs, setSgs] = useState<string[] | null>(port?.security_groups ?? null);
  const [subnetId, setSubnetId] = useState("");
  const [ip, setIp] = useState("");
  const [mac, setMac] = useState("");
  const [qos, setQos] = useState(port?.qos_policy_id ?? "");
  const dns = useNeutronDns();
  const [dnsName, setDnsName] = useState(port?.dns_name ?? "");
  const [portDomain, setPortDomain] = useState(port?.dns_domain ?? "");
  const sgOpts = useSgOptions(port?.project_id);
  const defaultSg = sgOpts.groups.data?.filter((g) => g.name === "default").map((g) => g.id) ?? [];
  const chosenSgs = sgs ?? defaultSg;

  const run = () => {
    const b: Record<string, unknown> = { name: name.trim(), description, admin_state_up: up };
    if (port?.port_security_enabled !== undefined || !editing) b.port_security_enabled = portSecurity;
    b.security_groups = portSecurity ? chosenSgs : [];
    if (qos !== (port?.qos_policy_id ?? "")) b.qos_policy_id = qos || null;
    if (dns.on && dnsName.trim() !== (port?.dns_name ?? "")) b.dns_name = dnsName.trim();
    if (dns.portDomain && dnsDomain(portDomain) !== (port?.dns_domain ?? "")) b.dns_domain = dnsDomain(portDomain);
    if (editing) return os.put("network", `ports/${port.id}`, { port: b });
    b.network_id = netId;
    if (subnetId || ip.trim()) b.fixed_ips = [{ ...(subnetId ? { subnet_id: subnetId } : {}), ...(ip.trim() ? { ip_address: ip.trim() } : {}) }];
    if (mac.trim()) b.mac_address = mac.trim();
    return os.post("network", "ports", { port: b });
  };

  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={editing ? tr("Edit port {portLabel}", { portLabel: portLabel(port) }) : network ? tr("Create port on {name}", { name: network.name }) : tr("Create port")}
      canSubmit={(editing || !!netId) && dnsNameOk(dnsName) && dnsNameOk(portDomain)}
      submitLabel={editing ? tr("Save") : tr("Create port")}
      done={editing ? tr("Port updated") : tr("Port created")}
      refresh={["network", "compute"]}
      run={run}
    >
      {!editing && !network && (
        <Field label={tr("Network")}>
          {(id) => (
            <Picker
              id={id}
              value={netChoice}
              onChange={(v) => {
                setNetChoice(v);
                setSubnetId("");
              }}
              searchable
              loading={networks.isPending}
              placeholder={tr("Choose a network")}
              options={(networks.data ?? [])
                .filter((n) => !n["router:external"] || session.is_admin)
                .map((n) => ({ value: n.id, label: n.name || n.id, icon: "network", description: n.shared ? tr("shared") : undefined }))}
            />
          )}
        </Field>
      )}
      <Field label={tr("Name")}>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      {!editing && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={tr("Subnet")}>
            {(id) => (
              <Picker
                id={id}
                value={subnetId}
                onChange={setSubnetId}
                clearable
                placeholder={tr("Any subnet")}
                options={(subnets.data ?? []).filter((s) => s.network_id === netId).map((s) => ({ value: s.id, label: s.name || s.cidr, meta: s.cidr }))}
              />
            )}
          </Field>
          <Field label={tr("Fixed IP")} hint={tr("Optional; Neutron picks a free one.")}>
            {(id) => <Input id={id} value={ip} onChange={(e) => setIp(e.target.value)} placeholder="10.0.0.50" className="font-mono text-[13px]" />}
          </Field>
        </div>
      )}
      {!editing && session.is_admin && (
        <Field label={tr("MAC address")} hint={tr("Optional.")}>
          {(id) => <Input id={id} value={mac} onChange={(e) => setMac(e.target.value)} placeholder="fa:16:3e:00:00:01" className="font-mono text-[13px]" />}
        </Field>
      )}
      <Switch
        checked={portSecurity}
        onChange={setPortSecurity}
        label={tr("Port security")}
        hint={tr("Security groups and anti-spoofing rules apply. Turn off for routers, VPN gateways or VIPs.")}
      />
      <Field label={tr("Security groups")}>{(id) => <SgPicker id={id} value={chosenSgs} onChange={setSgs} projectId={port?.project_id} disabled={!portSecurity} />}</Field>
      <Field label={tr("QoS policy")}>{(id) => <QosPolicyPicker id={id} value={qos} onChange={setQos} inheritLabel={tr("Network's policy (none of its own)")} />}</Field>
      {dns.on && (
        <Field
          label={tr("DNS name")}
          hint={
            dnsNameOk(dnsName)
              ? tr("Host name of this port, e.g. web01. Nova sets it to the instance's name for instance ports.")
              : tr("Use letters, digits and hyphens, e.g. web01.")
          }
        >
          {(id) => <Input id={id} value={dnsName} onChange={(e) => setDnsName(e.target.value)} placeholder="web01" className={dnsNameOk(dnsName) ? "font-mono text-[13px]" : "border-led-red font-mono text-[13px]"} />}
        </Field>
      )}
      {dns.portDomain && (
        <DnsDomainField
          value={portDomain}
          onChange={setPortDomain}
          hint={tr("Optional: a zone for this port's records instead of the network's DNS domain.")}
        />
      )}
      {port?.dns_assignment?.some((a) => a.fqdn) && (
        <p className="text-xs text-muted">
          {tr("Names now:")} <span className="font-mono">{[...new Set(port.dns_assignment.map((a) => a.fqdn))].join(", ")}</span>
        </p>
      )}
      <Switch checked={up} onChange={setUp} label={tr("Admin state up")} />
      <Field label={tr("Description")}>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      {!IPV4.test(ip.trim()) && ip.trim() && !ip.includes(":") && <p className="text-xs text-led-red">{tr("That doesn't look like an IP address.")}</p>}
    </ActionDialog>
  );
}

export function PortSecurityGroupsDialog({ port, onClose, context }: { port: Port; onClose: () => void; context?: string }) {
  const [sgs, setSgs] = useState(port.security_groups ?? []);
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Edit security groups")}
      description={tr("Port {portLabel} ({map}){v}. Changes apply immediately.", { portLabel: portLabel(port), map: port.fixed_ips.map((f) => f.ip_address).join(", "), v: context ? tr(" of {context}", { context }) : "" })}
      submitLabel={tr("Save")}
      done={tr("Security groups updated")}
      refresh={["network", "compute"]}
      run={() => os.put("network", `ports/${port.id}`, { port: { security_groups: sgs } })}
    >
      {port.port_security_enabled === false ? (
        <p className="text-sm text-muted">{tr("Port security is off for this port, so security groups don't apply. Edit the port to turn it on.")}</p>
      ) : (
        <Field label={tr("Security groups")}>{(id) => <SgPicker id={id} value={sgs} onChange={setSgs} projectId={port.project_id} />}</Field>
      )}
    </ActionDialog>
  );
}

/** Pick a free floating IP (or allocate one) and point it at one of `ports`. */
export function AssociateFipDialog({ ports, serverName, onClose }: { ports: Port[]; serverName?: string; onClose: () => void }) {
  const netName = useNetName();
  const fips = useFloatingIps();
  const ext = useNetworks({ "router:external": true });
  const free = (fips.data ?? []).filter((f) => !f.port_id);
  const [choice, setChoice] = useState("");
  const [pool, setPool] = useState("");
  const [portId, setPortId] = useState(ports[0]?.id ?? "");
  const selected = choice || free[0]?.id || "new";
  const extNet = pool || ext.data?.[0]?.id || "";
  const target = ports.find((p) => p.id === portId);
  return (
    <ActionDialog<FloatingIp>
      onClose={onClose}
      title={tr("Associate floating IP")}
      description={tr("Makes {v} reachable from an external network.", { v: serverName ?? tr("the port") })}
      submitLabel={tr("Associate")}
      canSubmit={!!target && (selected !== "new" || !!extNet)}
      done={(f) => tr("{floating_ip_address} now points to {v}", { floating_ip_address: f.floating_ip_address, v: serverName ?? portLabel(target!) })}
      refresh={["network", "compute"]}
      run={async () => {
        if (selected === "new")
          return (await os.post<{ floatingip: FloatingIp }>("network", "floatingips", { floatingip: { floating_network_id: extNet, port_id: portId } })).floatingip;
        return (await os.put<{ floatingip: FloatingIp }>("network", `floatingips/${selected}`, { floatingip: { port_id: portId } })).floatingip;
      }}
    >
      {ports.length > 1 && (
        <Field label={tr("Port")}>
          {(id) => (
            <Picker
              inlineDescription
              id={id}
              value={portId}
              onChange={setPortId}
              options={ports.map((p) => ({ value: p.id, label: portLabel(p), description: `${netName(p.network_id)} · ${p.fixed_ips.map((f) => f.ip_address).join(", ")}` }))}
            />
          )}
        </Field>
      )}
      <Field label={tr("Floating IP")}>
        {(id) => (
          <Picker
            id={id}
            value={selected}
            onChange={setChoice}
            loading={fips.isPending}
            options={[
              ...free.map((f) => ({ value: f.id, label: f.floating_ip_address, icon: "globe", description: f.description || undefined })),
              { value: "new", label: tr("Allocate a new floating IP"), icon: "plus" },
            ]}
          />
        )}
      </Field>
      {selected === "new" && (
        <Field label={tr("From external network")} hint={ext.data?.length ? undefined : tr("No external network is available to this project.")}>
          {(id) => <Picker id={id} value={extNet} onChange={setPool} options={(ext.data ?? []).map((n) => ({ value: n.id, label: n.name }))} />}
        </Field>
      )}
    </ActionDialog>
  );
}

type PortDlg = "edit" | "sgs" | "fip" | "unfip" | "delete" | "detach";

/** Actions for a port row. `serverName` names the instance a port belongs to, when known. */
export function usePortActions(opts: { serverName?: (id: string) => string } = {}) {
  const navigate = useNavigate();
  const fips = useFloatingIps();
  const [open, setOpen] = useState<{ kind: PortDlg; port: Port } | null>(null);
  const close = () => setOpen(null);
  const fipOf = (p: Port) => fips.data?.find((f) => f.port_id === p.id);
  const isCompute = (p: Port) => p.device_owner?.startsWith("compute:");
  const isInfra = (p: Port) => p.device_owner?.startsWith("network:");

  const items = (p: Port): MenuEntry[] => {
    const fip = fipOf(p);
    return [
      { label: tr("Edit port"), icon: "edit", onSelect: () => setOpen({ kind: "edit", port: p }) },
      {
        label: tr("Edit security groups"),
        icon: "shield",
        disabled: p.port_security_enabled === false ? tr("Port security is off for this port") : isInfra(p) ? tr("Not used on router or DHCP ports") : false,
        onSelect: () => setOpen({ kind: "sgs", port: p }),
      },
      isCompute(p) && !fip && { label: tr("Associate floating IP"), icon: "globe", onSelect: () => setOpen({ kind: "fip", port: p }) },
      fip && { label: tr("Disassociate floating IP"), icon: "unlink", hint: fip.floating_ip_address, onSelect: () => setOpen({ kind: "unfip", port: p }) },
      isCompute(p) && p.device_id && { label: tr("Open instance"), icon: "server", onSelect: () => navigate(`/compute/instances/${p.device_id}`) },
      p.device_owner?.startsWith("network:router") && p.device_id && { label: tr("Open router"), icon: "router", onSelect: () => navigate(`/network/routers/${p.device_id}`) },
      isCompute(p) && p.device_id && { label: tr("Detach from instance"), icon: "unplug", onSelect: () => setOpen({ kind: "detach", port: p }) },
      "-",
      {
        label: tr("Delete port"),
        icon: "trash",
        danger: true,
        disabled: isInfra(p) ? tr("Managed by Neutron; remove it from the router or network instead") : false,
        onSelect: () => setOpen({ kind: "delete", port: p }),
      },
    ];
  };

  const o = open;
  const owner = o && isCompute(o.port) ? opts.serverName?.(o.port.device_id) : undefined;
  const dialogs = o && (
    <>
      {o.kind === "edit" && <PortDialog port={o.port} onClose={close} />}
      {o.kind === "sgs" && <PortSecurityGroupsDialog port={o.port} context={owner} onClose={close} />}
      {o.kind === "fip" && <AssociateFipDialog ports={[o.port]} serverName={owner} onClose={close} />}
      {o.kind === "unfip" && (
        <ActionDialog
          onClose={close}
          title={tr("Disassociate {floating_ip_address}?", { floating_ip_address: fipOf(o.port)?.floating_ip_address })}
          submitLabel={tr("Disassociate")}
          done={tr("Floating IP disassociated; it stays allocated to the project")}
          refresh={["network", "compute"]}
          run={() => os.put("network", `floatingips/${fipOf(o.port)!.id}`, { floatingip: { port_id: null } })}
        >
          <p className="text-sm">{trx("The address stops reaching {v} and stays in your project for reuse.", { v: owner ?? tr("this port") })}</p>
        </ActionDialog>
      )}
      {o.kind === "detach" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Detach port from {v}?", { v: owner ?? tr("the instance") })}
          submitLabel={tr("Detach")}
          done={tr("Port detached")}
          refresh={["network", "compute"]}
          run={() => os.del("compute", `servers/${o.port.device_id}/os-interface/${o.port.id}`)}
        >
          <p className="text-sm">
            {tr("The instance loses the interface")}{" "}{o.port.fixed_ips.map((f) => f.ip_address).join(", ")}{tr(". A port Nova created at launch is deleted; a port you created yourself is kept.")}
          </p>
        </ActionDialog>
      )}
      {o.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete port {portLabel}?", { portLabel: portLabel(o.port) })}
          submitLabel={tr("Delete port")}
          done={tr("Port deleted")}
          refresh={["network", "compute"]}
          run={() => os.del("network", `ports/${o.port.id}`)}
        >
          <p className="text-sm">
            {trx("{v}Its addresses are released. This can't be undone.", { v: isCompute(o.port) ? tr("{v} loses this interface immediately. ", { v: owner ?? tr("The instance") }) : "" })}
          </p>
        </ActionDialog>
      )}
    </>
  );
  return { items, dialogs };
}

// =========================================================================== network row actions

export function useNetworkActions() {
  const session = useSession().data!;
  const navigate = useNavigate();
  const [open, setOpen] = useState<{ kind: "edit" | "subnet" | "port" | "delete"; network: Network } | null>(null);
  const close = () => setOpen(null);
  const mine = (n: Network) => n.project_id === session.project?.id || session.is_admin;
  const items = (n: Network): MenuEntry[] => [
    { label: tr("View details"), icon: "eye", onSelect: () => navigate(`/network/networks/${n.id}`) },
    "-",
    { label: tr("Edit network"), icon: "edit", disabled: mine(n) ? false : tr("Owned by another project"), onSelect: () => setOpen({ kind: "edit", network: n }) },
    { label: tr("Create subnet"), icon: "plus", disabled: mine(n) ? false : tr("Owned by another project"), onSelect: () => setOpen({ kind: "subnet", network: n }) },
    { label: tr("Create port"), icon: "cable", onSelect: () => setOpen({ kind: "port", network: n }) },
    { label: tr("Launch instance here"), icon: "rocket", disabled: n["router:external"] ? tr("External network") : false, onSelect: () => navigate(`/compute/instances/launch?network=${n.id}`) },
    "-",
    {
      label: tr("Delete network"),
      icon: "trash",
      danger: true,
      disabled: n["router:external"] && !session.is_admin ? tr("External network") : mine(n) ? false : tr("Owned by another project"),
      onSelect: () => setOpen({ kind: "delete", network: n }),
    },
  ];
  const o = open;
  const dialogs = o && (
    <>
      {o.kind === "edit" && <EditNetworkDialog network={o.network} onClose={close} />}
      {o.kind === "subnet" && <SubnetDialog network={o.network} onClose={close} />}
      {o.kind === "port" && <PortDialog network={o.network} onClose={close} />}
      {o.kind === "delete" && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete {v}?", { v: o.network.name || tr("network") })}
          submitLabel={tr("Delete network")}
          done={tr("Network {name} deleted", { name: o.network.name })}
          refresh={["network"]}
          onDone={() => navigate("/network/networks")}
          run={() => os.del("network", `networks/${o.network.id}`)}
        >
          <p className="text-sm">{tr("The network and its subnets are deleted. Neutron refuses while instances or router interfaces still use it.")}</p>
        </ActionDialog>
      )}
    </>
  );
  return { items, dialogs };
}
