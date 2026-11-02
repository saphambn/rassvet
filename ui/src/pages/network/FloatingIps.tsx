import { useMutation } from "@tanstack/react-query";
import { useNewParam } from "@/lib/useTab";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "@/components/Link";
import { ActionDialog } from "@/components/ActionDialog";
import { type Column, DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { Picker } from "@/components/Picker";
import { useToast } from "@/components/Toast";
import { Button, ErrorNotice, Field, Icon, Input, PageHeader, StatusDot } from "@/components/ui";
import { NEUTRON_STATUSES, choice, filters, statusLabel, text, idFilter, useProjectFilter } from "@/lib/filters";
import { useProjects } from "@/lib/identity";
import { type FloatingIp, networkStatus, os, useInvalidate, useListOrPages, useNetworks, usePorts, useServers } from "@/lib/os";
import { useSession } from "@/lib/session";
import { tr } from "@/lib/i18n";
import { DnsDomainField, dnsDomain, dnsNameOk, floatingName, useNeutronDns } from "./dns";

export default function FloatingIps({ admin = false }: { admin?: boolean }) {
  const session = useSession().data!;
  const nets = useNetworks();
  const filterProject = useProjectFilter(admin);
  const projects = useProjects(admin);
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? id;
  // One page at a time; the project view passes project_id because Neutron shows admins every
  // project's addresses, the admin view lists them all (with a project filter).
  const fips = useListOrPages<FloatingIp>(true, "network", "floatingips", "floatingips", admin ? undefined : { project_id: session.project?.id }, {
    filters: filters(
      text("address", tr("Address"), "floating_ip_address", tr("Exact address, e.g. 203.0.113.20")),
      idFilter("floatingips", "floatingip"),
      filterProject,
      choice("status", tr("Status"), "status", NEUTRON_STATUSES, statusLabel),
      {
        key: "pool",
        label: tr("Pool"),
        param: "floating_network_id",
        options: (nets.data ?? []).filter((n) => n["router:external"]).map((n) => ({ value: n.id, label: n.name || n.id })),
      },
    ),
    sort: { address: "floating_ip_address", status: "status", pool: "floating_network_id", ...(admin ? { project: "project_id" } : {}) },
    tableId: admin ? "admin-floating-ips" : "floating-ips",
  });
  const ports = usePorts();
  const servers = useServers(admin ? { all_tenants: 1 } : undefined);
  const dns = useNeutronDns();
  // Published name: the floating IP's own, else the DNS name of the port it points to.
  const fipName = (f: FloatingIp) => {
    const port = f.port_id ? ports.data?.find((p) => p.id === f.port_id) : undefined;
    return floatingName(f, port, port && nets.data?.find((n) => n.id === port.network_id));
  };
  const invalidate = useInvalidate();
  const toast = useToast();
  const [allocating, setAllocating] = useState(false);
  useNewParam(setAllocating);
  const [associating, setAssociating] = useState<FloatingIp | null>(null);
  const [releasing, setReleasing] = useState<FloatingIp | null>(null);
  const [editing, setEditing] = useState<FloatingIp | null>(null);
  const navigate = useNavigate();

  const netName = (id: string) => nets.data?.find((n) => n.id === id)?.name ?? id;
  const target = useMemo(() => {
    const portServer = new Map(ports.data?.map((p) => [p.id, p.device_id]));
    const serverName = new Map(servers.data?.map((s) => [s.id, s.name]));
    return (f: FloatingIp) => {
      if (!f.port_id) return null;
      const sid = portServer.get(f.port_id);
      return { id: sid, name: (sid && serverName.get(sid)) || f.fixed_ip_address || f.port_id };
    };
  }, [ports.data, servers.data]);

  const disassociate = useMutation({
    mutationFn: (f: FloatingIp) => os.put("network", `floatingips/${f.id}`, { floatingip: { port_id: null } }),
    onSuccess: (_, f) => {
      toast(tr("{floating_ip_address} disassociated", { floating_ip_address: f.floating_ip_address }));
      invalidate("network", "compute");
    },
  });

  const columns: Column<FloatingIp>[] = [
    { key: "address", header: tr("Address"), width: "10rem", mono: true, cell: (f) => f.floating_ip_address, value: (f) => f.floating_ip_address },
    { key: "status", header: tr("Status"), width: "7rem", cell: (f) => <StatusDot status={networkStatus(f.status)} label={f.status.toLowerCase()} />, value: (f) => f.status },
    {
      key: "target",
      header: tr("Points to"),
      cell: (f) => {
        const t = target(f);
        if (!t) return <span className="text-muted">{tr("nothing")}</span>;
        return t.id ? (
          <Link to={`/compute/instances/${t.id}`} className="hover:text-cable">
            {t.name} <span className="font-mono text-xs text-muted">{f.fixed_ip_address}</span>
          </Link>
        ) : (
          t.name
        );
      },
      value: (f) => target(f)?.name ?? "",
    },
    ...(admin
      ? [{ key: "project", header: tr("Project"), width: "9rem", hideBelow: "md", cell: (f: FloatingIp) => projectName(f.project_id), value: (f: FloatingIp) => projectName(f.project_id) } as Column<FloatingIp>]
      : []),
    { key: "pool", header: tr("Pool"), width: "9rem", hideBelow: "md", cell: (f) => netName(f.floating_network_id), value: (f) => netName(f.floating_network_id) },
    ...(dns.on ? [{ key: "dns", header: tr("DNS name"), hideBelow: "xl" as const, mono: true, cell: fipName, value: fipName }] : []),
    { key: "description", header: tr("Description"), hideBelow: "xl", cell: (f) => <span className="text-muted">{f.description || "—"}</span>, value: (f) => f.description ?? "" },
  ];

  return (
    <>
      <PageHeader
        title={admin ? tr("All floating IPs") : tr("Floating IPs")}
        description={
          admin
            ? tr("Floating IPs of every project. Allocate one for any project (optionally a specific address), point it at a port of that project, or release it.")
            : tr("Public addresses from an external network that you can point at an instance's port.")
        }
        actions={
          <Button variant="primary" onClick={() => setAllocating(true)}>
            <Icon name="plus" />
            {tr("Allocate IP")}
          </Button>
        }
      />
      <ErrorNotice error={fips.error ?? disassociate.error} className="mb-4" />
      <DataTable
        rows={fips.rows}
        remote={fips.remote}
        columns={columns}
        rowKey={(f) => f.id}
        loading={fips.isPending}
        tableId={admin ? "admin-floating-ips" : "floating-ips"}
        noun={tr("floating IPs")}
        rowLabel={(f) => f.floating_ip_address}
        empty={admin ? tr("No floating IPs in the cloud.") : tr("No floating IPs allocated to this project.")}
        onRefresh={() => fips.refetch()}
        refreshing={fips.isFetching}
        onBulkDone={() => invalidate("network", "compute")}
        rowActions={(f) => {
          const t = target(f);
          return [
            f.port_id
              ? { label: tr("Disassociate"), icon: "unlink", onSelect: () => disassociate.mutate(f) }
              : { label: tr("Associate"), icon: "link", onSelect: () => setAssociating(f) },
            f.port_id && { label: tr("Move to another instance"), icon: "arrow-right-left", onSelect: () => setAssociating(f) },
            t?.id && { label: tr("Open instance"), icon: "server", onSelect: () => navigate(`/compute/instances/${t.id}`) },
            { label: tr("Edit description"), icon: "edit", onSelect: () => setEditing(f) },
            "-",
            { label: tr("Release"), icon: "trash", danger: true, onSelect: () => setReleasing(f) },
          ];
        }}
        bulkActions={[
          {
            id: "disassociate",
            label: tr("Disassociate"),
            icon: "x",
            title: tr("Disassociate floating IPs?"),
            past: tr("disassociated"),
            body: tr("The addresses stay allocated to the project."),
            check: (f) => (f.port_id ? true : tr("Not associated")),
            run: (f) => os.put("network", `floatingips/${f.id}`, { floatingip: { port_id: null } }),
          },
          {
            id: "release",
            label: tr("Release"),
            icon: "trash",
            danger: true,
            title: tr("Release floating IPs?"),
            past: tr("released"),
            body: tr("The addresses go back to the pool and someone else may get them."),
            run: (f) => os.del("network", `floatingips/${f.id}`),
          },
        ]}
      />
      <AllocateDialog open={allocating} admin={admin} onClose={() => setAllocating(false)} />
      {associating && <AssociateDialog fip={associating} admin={admin} onClose={() => setAssociating(null)} />}
      {editing && <EditFipDialog fip={editing} onClose={() => setEditing(null)} />}
      {releasing && (
        <ActionDialog
          onClose={() => setReleasing(null)}
          danger
          title={tr("Release {floating_ip_address}?", { floating_ip_address: releasing.floating_ip_address })}
          submitLabel={tr("Release")}
          done={tr("{floating_ip_address} released", { floating_ip_address: releasing.floating_ip_address })}
          refresh={["network", "compute"]}
          run={() => os.del("network", `floatingips/${releasing.id}`)}
        >
          <p className="text-sm">{tr("The address goes back to the pool and someone else may get it. DNS records pointing at it will break.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

function AllocateDialog({ open, admin, onClose }: { open: boolean; admin: boolean; onClose: () => void }) {
  const session = useSession().data!;
  const ext = useNetworks({ "router:external": true });
  const projects = useProjects(admin);
  const [pool, setPool] = useState("");
  // Admin extras: the owner project, a specific address, a description.
  const [project, setProject] = useState(session.project?.id ?? "");
  const [address, setAddress] = useState("");
  const [description, setDescription] = useState("");
  const dns = useNeutronDns();
  const [dnsName, setDnsName] = useState("");
  const [domain, setDomain] = useState("");
  const invalidate = useInvalidate();
  const toast = useToast();
  const net = pool || ext.data?.[0]?.id || "";
  // Neutron takes both or neither.
  const dnsOk = dnsNameOk(dnsName) && dnsNameOk(domain) && !dnsName.trim() === !domain.trim();
  const ipOk = !address.trim() || /^[0-9a-fA-F:.]+$/.test(address.trim());
  const m = useMutation({
    mutationFn: () =>
      os.post<{ floatingip: FloatingIp }>("network", "floatingips", {
        floatingip: {
          floating_network_id: net,
          ...(admin && project ? { project_id: project } : {}),
          ...(admin && address.trim() ? { floating_ip_address: address.trim() } : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(dns.on && dnsName.trim() ? { dns_name: dnsName.trim(), dns_domain: dnsDomain(domain) } : {}),
        },
      }),
    onSuccess: (r) => {
      toast(tr("Allocated {floating_ip_address}", { floating_ip_address: r.floatingip.floating_ip_address }));
      invalidate("network");
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onClose={() => {
        m.reset();
        onClose();
      }}
      size="sm"
      title={tr("Allocate floating IP")}
      onSubmit={() => m.mutate()}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {tr("Cancel")}
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending} disabled={!net || !ipOk || (admin && !project) || (dns.on && !dnsOk)}>
            {tr("Allocate")}
          </Button>
        </>
      }
    >
      <Field label={tr("Pool (external network)")} hint={ext.data?.length === 0 ? tr("No external network is available to this project.") : undefined}>
        {(id) => (
          <Picker id={id} value={net} onChange={setPool} options={(ext.data ?? []).map((n) => ({ value: n.id, label: n.name, icon: "globe" }))} />
        )}
      </Field>
      {admin && (
        <>
          <Field label={tr("Project")} hint={tr("The floating IP counts against this project's quota.")}>
            {(id) => (
              <Picker
                id={id}
                value={project}
                onChange={setProject}
                searchable
                loading={projects.isPending}
                options={(projects.data ?? [])
                  .filter((p) => !p.is_domain)
                  .map((p) => ({ value: p.id, label: p.name, description: p.id }))}
              />
            )}
          </Field>
          <Field label={tr("Specific address")} hint={tr("Optional: an exact address from the pool (admins only). Empty picks the next free one.")}>
            {(id) => (
              <Input id={id} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="203.0.113.50" className={!ipOk ? "border-led-red font-mono" : "font-mono"} />
            )}
          </Field>
        </>
      )}
      <Field label={tr("Description")}>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={tr("What this address is for")} />}</Field>
      {dns.on && (
        <>
          <Field
            label={tr("DNS name")}
            hint={dnsName.trim() && !domain.trim() ? tr("Also choose a DNS domain.") : tr("Optional: publish this address in Designate as <name>.<domain>, whatever it points to. Can't be changed later.")}
          >
            {(id) => <Input id={id} value={dnsName} onChange={(e) => setDnsName(e.target.value)} placeholder="www" className={dnsNameOk(dnsName) ? "font-mono text-[13px]" : "border-led-red font-mono text-[13px]"} />}
          </Field>
          <DnsDomainField value={domain} onChange={setDomain} hint={!dnsName.trim() && domain.trim() ? tr("Also enter a DNS name.") : tr("The zone must exist in Designate, e.g. example.com.")} />
        </>
      )}
      <ErrorNotice error={m.error} />
    </Dialog>
  );
}

function AssociateDialog({ fip, admin, onClose }: { fip: FloatingIp; admin: boolean; onClose: () => void }) {
  const ports = usePorts(admin ? { project_id: fip.project_id } : undefined);
  const servers = useServers(admin ? { all_tenants: 1, project_id: fip.project_id } : undefined);
  const nets = useNetworks();
  const [port, setPort] = useState("");
  const invalidate = useInvalidate();
  const toast = useToast();
  const serverName = new Map(servers.data?.map((s) => [s.id, s.name]));
  const netName = (id: string) => nets.data?.find((n) => n.id === id)?.name ?? id;
  const candidates = (ports.data ?? []).filter((p) => p.device_owner.startsWith("compute:") && p.network_id !== fip.floating_network_id);
  const m = useMutation({
    mutationFn: () => os.put("network", `floatingips/${fip.id}`, { floatingip: { port_id: port } }),
    onSuccess: () => {
      toast(tr("{floating_ip_address} associated", { floating_ip_address: fip.floating_ip_address }));
      invalidate("network", "compute");
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={tr("Associate {floating_ip_address}", { floating_ip_address: fip.floating_ip_address })}
      description={
        admin
          ? tr("Instances of the floating IP's project. Their network must be connected to a router with a gateway on the IP's pool.")
          : tr("The instance's network must be connected to a router with a gateway on the IP's pool.")
      }
      onSubmit={() => m.mutate()}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {tr("Cancel")}
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending} disabled={!port}>
            {tr("Associate")}
          </Button>
        </>
      }
    >
      <Field label={tr("Instance port")}>
        {(id) => (
          <Picker
            inlineDescription
            id={id}
            value={port}
            onChange={setPort}
            searchable
            loading={ports.isPending}
            placeholder={tr("Choose an instance")}
            searchPlaceholder={tr("Search instances or IPs")}
            emptyText={tr("No instance ports to point at.")}
            options={candidates.map((p) => ({
              value: p.id,
              label: serverName.get(p.device_id) ?? p.device_id,
              icon: "server",
              description: tr("{map} on {netName}", { map: p.fixed_ips.map((f) => f.ip_address).join(", "), netName: netName(p.network_id) }),
              disabled: p.id === fip.port_id ? tr("Already associated here") : false,
            }))}
          />
        )}
      </Field>
      <ErrorNotice error={m.error} />
    </Dialog>
  );
}

function EditFipDialog({ fip, onClose }: { fip: FloatingIp; onClose: () => void }) {
  const [description, setDescription] = useState(fip.description ?? "");
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Edit {floating_ip_address}", { floating_ip_address: fip.floating_ip_address })}
      submitLabel={tr("Save")}
      done={tr("Floating IP updated")}
      refresh={["network"]}
      run={() => os.put("network", `floatingips/${fip.id}`, { floatingip: { description } })}
    >
      <Field label={tr("Description")}>{(id) => <Input id={id} autoFocus value={description} onChange={(e) => setDescription(e.target.value)} placeholder={tr("What this address is for")} />}</Field>
    </ActionDialog>
  );
}
