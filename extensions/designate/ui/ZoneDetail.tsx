/** Zone detail: record sets, overview (name servers, delegation) and shares with other projects. */
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
  type MenuEntry,
  Mono,
  PageHeader,
  Picker,
  StatusDot,
  Tabs,
  Textarea,
  age,
  fmtDate,
  tr,
  useInvalidate,
  useNavigate,
  useNetworks,
  useNeutronExtensions,
  useParams,
  useProjects,
  useTab,
} from "@rassvet/sdk";
import {
  BASE,
  DNS,
  RECORD_TYPES,
  type RecordSet,
  type Zone,
  type ZoneShare,
  dns,
  dnsStatus,
  fqdn,
  managed,
  parseRecords,
  recordsProblem,
  relName,
  statusText,
  undot,
  useAll,
  useNameservers,
  useRecordSets,
  useShares,
  useZone,
  zoneName,
} from "./api";
import { useZoneActions } from "./Zones";

export function Back({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
      <Icon name="arrow-left" className="size-3.5" />
      {children}
    </Link>
  );
}

const TABS = ["records", "overview", "shares"] as const;

export default function ZoneDetail() {
  const { id = "" } = useParams();
  const { admin } = useAll();
  const navigate = useNavigate();
  const q = useZone(id);
  const z = q.data;
  const back = `${admin ? "/admin" : ""}${BASE}/zones`;
  const actions = useZoneActions({ onDeleted: () => navigate(back) });
  const [tab, setTab] = useTab(TABS, "records");
  return (
    <>
      <Back to={back}>{admin ? tr("All DNS zones") : tr("DNS zones")}</Back>
      <PageHeader
        title={z ? zoneName(z) : tr("DNS zone")}
        description={z && <StatusDot status={dnsStatus(z.status)} label={statusText(z)} />}
        actions={z && <ActionMenu variant="button" items={() => actions.items(z, "detail")} />}
      />
      <ErrorNotice error={q.error} className="mb-4" />
      {z && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            className="mb-5"
            tabs={[
              { id: "records", label: tr("Record sets") },
              { id: "overview", label: tr("Overview") },
              { id: "shares", label: tr("Shares") },
            ]}
          />
          {tab === "records" && <RecordSets zone={z} />}
          {tab === "overview" && <Overview zone={z} />}
          {tab === "shares" && <Shares zone={z} />}
        </>
      )}
      {actions.dialogs}
    </>
  );
}

// =========================================================================== overview

function Overview({ zone: z }: { zone: Zone }) {
  const { admin } = useAll();
  const ns = useNameservers(z.id);
  const projects = useProjects(admin);
  const delegation = (ns.data ?? [])
    .slice()
    .sort((a, b) => a.priority - b.priority)
    .map((n) => `${z.name} IN NS ${n.hostname}`)
    .join("\n");
  return (
    <div className="grid items-start gap-6 xl:grid-cols-2">
      <Card title={tr("Details")}>
        <dl>
          <Detail label={tr("Name")}>{z.name}</Detail>
          <Detail label="ID">
            <Mono>{z.id}</Mono>
          </Detail>
          {admin && (
            <Detail label={tr("Project")}>
              {projects.data?.find((p) => p.id === z.project_id)?.name ?? ""} <Mono className="text-muted">{z.project_id}</Mono>
            </Detail>
          )}
          <Detail label={tr("Status")}>
            <StatusDot status={dnsStatus(z.status)} label={statusText(z)} />
          </Detail>
          <Detail label={tr("Type")}>{z.type === "SECONDARY" ? tr("Secondary") : tr("Primary")}</Detail>
          {z.type === "SECONDARY" && (
            <Detail label={tr("Primary servers")} wrap>
              <Mono>{(z.masters ?? []).join(", ") || "—"}</Mono>
            </Detail>
          )}
          {z.email && <Detail label={tr("Email")}>{z.email}</Detail>}
          <Detail label="TTL">{z.ttl ?? "—"}</Detail>
          <Detail label={tr("Serial")}>
            <Mono>{z.serial ?? "—"}</Mono>
          </Detail>
          {z.description && (
            <Detail label={tr("Description")} wrap>
              {z.description}
            </Detail>
          )}
          {admin && z.pool_id && (
            <Detail label={tr("Pool")}>
              <Mono>{z.pool_id}</Mono>
            </Detail>
          )}
          {z.created_at && <Detail label={tr("Created")}>{fmtDate(z.created_at)}</Detail>}
          {z.updated_at && <Detail label={tr("Updated")}>{fmtDate(z.updated_at)}</Detail>}
          {z.transferred_at && <Detail label={tr("Transferred")}>{fmtDate(z.transferred_at)}</Detail>}
        </dl>
      </Card>
      <Card title={tr("Name servers")} actions={delegation ? <CopyButton className="h-8" text={delegation} label={tr("Copy NS records")} /> : undefined}>
        <ErrorNotice error={ns.error} className="mb-3" />
        {ns.isPending ? (
          <p className="text-sm text-muted">{tr("Loading…")}</p>
        ) : (
          <>
            <ul className="mb-3 space-y-1">
              {(ns.data ?? []).map((n) => (
                <li key={n.hostname} className="flex items-center justify-between gap-3 text-sm">
                  <Mono>{n.hostname}</Mono>
                  <span className="text-xs text-muted">{tr("Priority {n}", { n: n.priority })}</span>
                </li>
              ))}
            </ul>
            <p className="text-sm text-muted">
              {tr("To make the zone answer on the Internet, set these name servers for {name} at its registrar (or as NS records in the parent zone).", { name: undot(z.name) })}
            </p>
          </>
        )}
      </Card>
      <NeutronRecords zone={z} />
    </div>
  );
}

/**
 * Records Neutron publishes in this zone: networks whose DNS domain it is (their ports'
 * floating IPs, or fixed IPs on provider networks, get records), or why nothing is published.
 */
function NeutronRecords({ zone: z }: { zone: Zone }) {
  const ext = useNeutronExtensions();
  const on = ext.data?.has("dns-integration") ?? false;
  const nets = useNetworks(undefined, on);
  if (ext.isPending) return null;
  const using = (nets.data ?? []).filter((n) => n.dns_domain === z.name);
  return (
    <Card title={tr("Automatic records")}>
      {!on ? (
        <p className="text-sm text-muted">
          {tr("This cloud's Neutron isn't integrated with Designate, so instances and floating IPs get no records here automatically; add them as record sets. Your operator can turn the integration on (Neutron's external_dns_driver = designate).")}
        </p>
      ) : (
        <>
          <ErrorNotice error={nets.error} className="mb-3" />
          {using.length ? (
            <ul className="mb-3 space-y-1">
              {using.map((n) => (
                <li key={n.id} className="flex items-center gap-2 text-sm">
                  <Icon name="network" className="size-3.5 text-muted" />
                  <Link to={`/network/networks/${n.id}`} className="text-cable hover:underline">
                    {n.name || n.id}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            !nets.isPending && <p className="mb-3 text-sm">{tr("No network uses this zone yet.")}</p>
          )}
          <p className="text-sm text-muted">
            {tr("Neutron adds records here for the ports of networks whose DNS domain is {name}, e.g. web01.{name} for an instance's floating IP. Set it in Network → Edit → DNS domain.", { name: undot(z.name) })}
          </p>
        </>
      )}
    </Card>
  );
}

// =========================================================================== record sets

function RecordSets({ zone }: { zone: Zone }) {
  const { admin } = useAll();
  const sets = useRecordSets(zone.id);
  const invalidate = useInvalidate();
  const [open, setOpen] = useState<{ kind: "create" | "edit" | "delete"; rs?: RecordSet } | null>(null);
  const close = () => setOpen(null);
  const readOnly = zone.type === "SECONDARY";
  const columns: Column<RecordSet>[] = [
    {
      key: "name",
      header: tr("Name"),
      width: "16rem",
      cell: (rs) => (
        <span className="font-mono text-sm" title={rs.name}>
          {relName(rs.name, zone.name)}
        </span>
      ),
      value: (rs) => rs.name,
    },
    { key: "type", header: tr("Type"), width: "6rem", wrap: true, cell: (rs) => <Badge tone={managed(rs, zone.name) ? "neutral" : "accent"}>{rs.type}</Badge>, value: (rs) => rs.type },
    {
      key: "records",
      header: tr("Values"),
      wrap: true,
      cell: (rs) => (
        <ul className="min-w-0 space-y-0.5">
          {rs.records.map((r) => (
            <li key={r} className="break-all font-mono text-xs">
              {r}
            </li>
          ))}
        </ul>
      ),
      value: (rs) => rs.records.join(" "),
    },
    { key: "ttl", header: "TTL", width: "6rem", hideBelow: "md", className: "text-right", cell: (rs) => rs.ttl ?? <span className="text-muted">{zone.ttl ?? "—"}</span>, value: (rs) => rs.ttl ?? zone.ttl ?? 0 },
    { key: "status", header: tr("Status"), width: "9rem", hideBelow: "lg", cell: (rs) => <StatusDot status={dnsStatus(rs.status)} label={statusText(rs)} />, value: (rs) => statusText(rs) },
    { key: "updated", header: tr("Updated"), width: "7rem", hideBelow: "xl", cell: (rs) => <span title={fmtDate(rs.updated_at ?? rs.created_at) ?? ""}>{age(rs.updated_at ?? rs.created_at)}</span>, value: (rs) => rs.updated_at ?? rs.created_at ?? "" },
  ];
  const locked = (rs: RecordSet) => (readOnly ? tr("Records of a secondary zone come from its primaries") : managed(rs, zone.name) ? tr("Managed by Designate") : false);
  const items = (rs: RecordSet): MenuEntry[] => [
    { label: tr("Edit record set"), icon: "edit", disabled: locked(rs) || (rs.action === "DELETE" && tr("Being deleted")), onSelect: () => setOpen({ kind: "edit", rs }) },
    { label: tr("Clone record set"), icon: "copy-plus", disabled: locked(rs), onSelect: () => setOpen({ kind: "create", rs }) },
    "-",
    { label: tr("Delete record set"), icon: "trash", danger: true, disabled: locked(rs), onSelect: () => setOpen({ kind: "delete", rs }) },
  ];
  return (
    <>
      <ErrorNotice error={sets.error} className="mb-4" />
      <DataTable
        rows={sets.data}
        columns={columns}
        rowKey={(rs) => rs.id}
        loading={sets.isPending}
        tableId="designate-recordsets"
        noun={tr("record sets")}
        rowLabel={(rs) => `${relName(rs.name, zone.name)} ${rs.type}`}
        onRefresh={() => sets.refetch()}
        refreshing={sets.isFetching}
        onBulkDone={() => invalidate(DNS)}
        empty={tr("No record sets yet.")}
        filterPlaceholder={tr("Filter by name, type or value")}
        rowActions={items}
        toolbar={
          !readOnly && (
            <Button variant="primary" onClick={() => setOpen({ kind: "create" })} disabled={zone.action === "DELETE"}>
              <Icon name="plus" />
              {tr("Create record set")}
            </Button>
          )
        }
        bulkActions={[
          {
            id: "delete",
            label: tr("Delete"),
            icon: "trash",
            danger: true,
            title: tr("Delete record sets?"),
            past: tr("deleted"),
            check: (rs) => {
              const l = locked(rs);
              return l || true;
            },
            run: (rs) => dns.del(`zones/${zone.id}/recordsets/${rs.id}`, admin),
          },
        ]}
      />
      {open?.kind === "create" && <RecordSetDialog zone={zone} from={open.rs} onClose={close} />}
      {open?.kind === "edit" && open.rs && <RecordSetDialog zone={zone} recordset={open.rs} onClose={close} />}
      {open?.kind === "delete" && open.rs && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Delete {name} {type}?", { name: relName(open.rs.name, zone.name), type: open.rs.type })}
          submitLabel={tr("Delete record set")}
          done={tr("Record set deleted")}
          refresh={[DNS]}
          run={() => dns.del(`zones/${zone.id}/recordsets/${open.rs!.id}`, admin)}
        >
          <p className="text-sm">{tr("Resolvers may keep answering with the old values until their cached copy expires (the record set's TTL).")}</p>
        </ActionDialog>
      )}
    </>
  );
}

/** `recordset`: edit its values, TTL and description; `from`: a copy; neither: a new one. */
function RecordSetDialog({ zone, recordset, from, onClose }: { zone: Zone; recordset?: RecordSet; from?: RecordSet; onClose: () => void }) {
  const { admin } = useAll();
  const base = recordset ?? from;
  const [name, setName] = useState(base ? relName(base.name, zone.name) : "");
  const [type, setType] = useState(base?.type ?? "A");
  const [values, setValues] = useState((base?.records ?? []).join("\n"));
  const [ttl, setTtl] = useState(base?.ttl ? String(base.ttl) : "");
  const [description, setDescription] = useState(base?.description ?? "");
  const info = RECORD_TYPES.find((t) => t.type === type);
  const records = parseRecords(type, values);
  const full = fqdn(name, zone.name);
  const problem =
    (!recordset && !/^(@|\*|[a-zA-Z0-9_*-]+(\.[a-zA-Z0-9_-]+)*\.?)$/.test(name.trim() || "@") && tr("Enter a name in the zone, @ for the zone itself")) ||
    (!recordset && name.trim().endsWith(".") && !full.endsWith(zone.name) && tr("The name must be in {zone}", { zone: zone.name })) ||
    (!recordset && type === "CNAME" && full === zone.name && tr("The zone itself can't have a CNAME")) ||
    recordsProblem(type, records) ||
    (ttl.trim() !== "" && !/^\d+$/.test(ttl.trim()) && tr("The TTL is a whole number of seconds"));
  const run = () => {
    const body = { records, ttl: ttl.trim() ? Number(ttl) : null, description: description.trim() || null };
    if (recordset) return dns.put<RecordSet>(`zones/${zone.id}/recordsets/${recordset.id}`, body, admin);
    return dns.post<RecordSet>(`zones/${zone.id}/recordsets`, { ...body, name: full, type }, admin);
  };
  return (
    <ActionDialog<RecordSet>
      onClose={onClose}
      size="lg"
      title={recordset ? tr("Edit {name} {type}", { name: relName(recordset.name, zone.name), type: recordset.type }) : tr("Create record set")}
      description={tr("A record set is every value of one type for one name, e.g. all the A records of www.")}
      submitLabel={recordset ? tr("Save") : tr("Create record set")}
      canSubmit={!problem}
      done={recordset ? tr("Record set updated") : tr("Record set created")}
      refresh={[DNS]}
      run={run}
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
        <Field label={tr("Name")} hint={recordset ? undefined : tr("Full name: {name}", { name: full })}>
          {(id) =>
            recordset ? (
              <Input id={id} value={recordset.name} disabled />
            ) : (
              <div className="flex items-center gap-1">
                <Input id={id} autoFocus className="font-mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="www" />
                <span className="shrink-0 font-mono text-sm text-muted">.{zone.name}</span>
              </div>
            )
          }
        </Field>
        <Field label={tr("Type")}>
          {(id) =>
            recordset ? (
              <Input id={id} value={recordset.type} disabled />
            ) : (
              <Picker id={id} value={type} onChange={setType} options={RECORD_TYPES.map((t) => ({ value: t.type, label: t.type, description: t.hint }))} />
            )
          }
        </Field>
      </div>
      <Field
        label={tr("Values")}
        hint={
          <>
            {info?.hint}. {tr("One per line, e.g.")} <Mono>{info?.example}</Mono>
            {(type === "TXT" || type === "SPF") && <> {tr("Unquoted text is quoted and split into 255-character strings for you.")}</>}
          </>
        }
      >
        {(id) => <Textarea id={id} rows={5} className="font-mono text-sm" value={values} onChange={(e) => setValues(e.target.value)} placeholder={info?.example} />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
        <Field label="TTL" hint={tr("Empty: the zone's ({ttl})", { ttl: zone.ttl ?? "—" })}>
          {(id) => <Input id={id} inputMode="numeric" value={ttl} onChange={(e) => setTtl(e.target.value)} />}
        </Field>
        <Field label={tr("Description")}>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      </div>
    </ActionDialog>
  );
}

// =========================================================================== shares

function Shares({ zone }: { zone: Zone }) {
  const { admin } = useAll();
  const shares = useShares(zone.id);
  const projects = useProjects(admin);
  const invalidate = useInvalidate();
  const [open, setOpen] = useState<{ kind: "create" | "delete"; s?: ZoneShare } | null>(null);
  const close = () => setOpen(null);
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name;
  const columns: Column<ZoneShare>[] = [
    {
      key: "project",
      header: tr("Shared with"),
      cell: (s) => (
        <span>
          {projectName(s.target_project_id) ?? ""} <Mono className="text-muted">{s.target_project_id}</Mono>
        </span>
      ),
      value: (s) => `${projectName(s.target_project_id) ?? ""} ${s.target_project_id}`,
    },
    { key: "age", header: tr("Since"), width: "8rem", cell: (s) => <span title={fmtDate(s.created_at) ?? ""}>{age(s.created_at)}</span>, value: (s) => s.created_at ?? "" },
  ];
  return (
    <>
      <p className="mb-4 text-sm text-muted">
        {tr("Projects the zone is shared with can create record sets in it (e.g. for their own hosts), but not change or delete the zone. Needs Designate 2023.1 or later.")}
      </p>
      <ErrorNotice error={shares.error} className="mb-4" />
      <DataTable
        rows={shares.data}
        columns={columns}
        rowKey={(s) => s.id}
        loading={shares.isPending}
        tableId="designate-shares"
        noun={tr("shares")}
        rowLabel={(s) => projectName(s.target_project_id) ?? s.target_project_id}
        onRefresh={() => shares.refetch()}
        refreshing={shares.isFetching}
        onBulkDone={() => invalidate(DNS)}
        empty={tr("The zone isn't shared.")}
        rowActions={(s) => [{ label: tr("Stop sharing"), icon: "unlink", danger: true, onSelect: () => setOpen({ kind: "delete", s }) }]}
        toolbar={
          <Button onClick={() => setOpen({ kind: "create" })}>
            <Icon name="share" />
            {tr("Share zone")}
          </Button>
        }
        bulkActions={[{ id: "delete", label: tr("Stop sharing"), icon: "unlink", danger: true, title: tr("Stop sharing with these projects?"), past: tr("removed"), run: (s) => dns.del(`zones/${zone.id}/shares/${s.id}`, admin) }]}
      />
      {open?.kind === "create" && <ShareDialog zone={zone} onClose={close} />}
      {open?.kind === "delete" && open.s && (
        <ActionDialog
          onClose={close}
          danger
          title={tr("Stop sharing {name}?", { name: zoneName(zone) })}
          submitLabel={tr("Stop sharing")}
          done={tr("Share removed")}
          refresh={[DNS]}
          run={() => dns.del(`zones/${zone.id}/shares/${open.s!.id}`, admin)}
        >
          <p className="text-sm">{tr("Designate refuses while the project still has record sets in the zone; delete those first.")}</p>
        </ActionDialog>
      )}
    </>
  );
}

function ShareDialog({ zone, onClose }: { zone: Zone; onClose: () => void }) {
  const { admin } = useAll();
  const projects = useProjects(admin);
  const [target, setTarget] = useState("");
  return (
    <ActionDialog
      onClose={onClose}
      size="md"
      title={tr("Share {name}", { name: zoneName(zone) })}
      submitLabel={tr("Share zone")}
      canSubmit={/^[a-zA-Z0-9-]+$/.test(target.trim())}
      done={tr("Zone shared")}
      refresh={[DNS]}
      run={() => dns.post(`zones/${zone.id}/shares`, { target_project_id: target.trim() }, admin)}
    >
      <Field label={tr("Project")} hint={tr("ID of the project to share with.")}>
        {(id) =>
          admin && projects.data ? (
            <Picker
              id={id}
              value={target}
              onChange={setTarget}
              options={projects.data.filter((p) => p.id !== zone.project_id).map((p) => ({ value: p.id, label: p.name, description: p.id }))}
            />
          ) : (
            <Input id={id} autoFocus className="font-mono" value={target} onChange={(e) => setTarget(e.target.value)} />
          )
        }
      </Field>
    </ActionDialog>
  );
}
