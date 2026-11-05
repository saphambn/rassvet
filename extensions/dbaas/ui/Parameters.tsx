/**
 * Engine parameters (DBaaS Phase 9): the Parameters tab of a cluster (the effective settings and where each
 * comes from, changes reviewed with a dry run, the last revisions and rollback) and the editor that the create
 * dialog reuses. dbaas-api checks every value against the catalog of the cluster's version and flavor, follows
 * the change and reverts it by itself if the engine stops starting.
 */
import { useState } from "react";
import {
  ActionDialog,
  Badge,
  Button,
  type Column,
  DataTable,
  Dialog,
  ErrorNotice,
  Icon,
  KeyValueEditor,
  type KvRow,
  Mono,
  fmtBytes,
  fmtDate,
  kvError,
  tr,
  useInvalidate,
  useQuery,
  useToast,
} from "@rassvet/sdk";
import {
  type ApplyMode,
  type CatalogParameter,
  DB,
  type DbCluster,
  type Parameter,
  type ParamSource,
  type ParameterRevision,
  type ParametersPlan,
  applyPending,
  applyingParams,
  discardPending,
  paramErrors,
  patchParameters,
  rollbackParameters,
  useCatalog,
  useParameterHistory,
  useParameters,
} from "./api";
import { ConfEditor, ModeSwitch, parseConf, toConf } from "./ConfText";

// =========================================================================== helpers

const SOURCE: Record<ParamSource, { label: () => string; hint: () => string; tone: "neutral" | "accent" | "warn" }> = {
  engine: { label: () => tr("DBaaS default"), hint: () => tr("DBaaS's default for the engine; set it to replace it."), tone: "neutral" },
  flavor: { label: () => tr("Flavor"), hint: () => tr("Sized from the flavor's memory and recomputed on resize; set it to replace it, within the flavor's limits."), tone: "neutral" },
  tenant: { label: () => tr("Set by you"), hint: () => tr("Set for this cluster by the project."), tone: "accent" },
  admin: { label: () => tr("Cloud operator"), hint: () => tr("Set by the cloud operator (or no longer offered): only an admin changes it."), tone: "warn" },
  locked: { label: () => tr("Locked"), hint: () => tr("Required by DBaaS (logs, TLS): can't be changed."), tone: "warn" },
};

export function SourceBadge({ s }: { s: ParamSource }) {
  const x = SOURCE[s] ?? { label: () => s, hint: () => "", tone: "neutral" as const };
  return (
    <span title={x.hint()}>
      <Badge tone={x.tone}>{x.label()}</Badge>
    </span>
  );
}

/** Whether a parameter can be changed here: admins (on behalf of the project) also change the operator's. */
const editable = (s: ParamSource, admin: boolean) => s !== "locked" && (s !== "admin" || admin);

/** "integer 64kB–2GB, at most 47 MiB for this flavor · default 4MB · restarts" */
export function paramHint(p?: CatalogParameter) {
  if (!p) return "";
  const parts: string[] = [];
  const range = p.min || p.max ? `${p.min ?? ""}–${p.max ?? ""}${p.unit ? ` ${p.unit}` : ""}` : p.unit;
  parts.push([p.type, range].filter(Boolean).join(" "));
  if (p.flavor_max) parts.push(tr("at most {v} for this flavor", { v: p.name === "max_connections" ? String(p.flavor_max) : fmtBytes(p.flavor_max) }));
  if (p.default) parts.push(tr("default {v}", { v: p.default }));
  if (p.flavor) parts.push(tr("sized from the flavor"));
  if (p.restart) parts.push(tr("restarts"));
  if (p.admin_only) parts.push(tr("admins only"));
  const head = parts.filter(Boolean).join(" · ");
  return p.description ? `${head} — ${p.description}` : head;
}

/** Suggestions for the key/value editor: every catalog parameter, enum and bool values offered. */
export function suggestionsOf(catalog?: CatalogParameter[]) {
  return (catalog ?? []).map((p) => ({
    key: p.name,
    hint: paramHint(p),
    values: p.values?.length ? p.values : /^bool/.test(p.type ?? "") ? ["on", "off"] : undefined,
  }));
}

const APPLY: Record<ApplyMode, () => string> = {
  none: () => tr("Nothing changes."),
  reload: () => tr("PostgreSQL reloads its configuration: no restart, in effect within seconds."),
  restart: () => tr("Each member restarts in place, replicas first: connections drop for a few seconds per member."),
  rolling: () => tr("Members are recreated one at a time (about 90 s per MySQL member, 45 s per MongoDB member); a single-member cluster is down meanwhile."),
};

export function PlanView({ plan }: { plan: ParametersPlan }) {
  if (!plan.changes.length) return <p className="text-sm text-muted">{tr("Nothing to change: the parameters already have these values.")}</p>;
  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-md border border-line">
        <table className="w-full text-sm">
          <thead className="bg-ink/[0.03] text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-1.5 font-medium">{tr("Parameter")}</th>
              <th className="px-3 py-1.5 font-medium">{tr("Now")}</th>
              <th className="px-3 py-1.5 font-medium">{tr("After")}</th>
            </tr>
          </thead>
          <tbody>
            {plan.changes.map((ch) => (
              <tr key={ch.name} className="border-t border-line">
                <td className="px-3 py-1.5 font-mono text-[12.5px]">
                  {ch.name}
                  {ch.restart && (
                    <span className="ml-1.5 text-led-amber" title={tr("Restarts the server")}>
                      <Icon name="refresh" className="inline size-3" />
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 font-mono text-[12.5px] text-muted">{ch.old ?? <i>{tr("default")}</i>}</td>
                <td className="px-3 py-1.5 font-mono text-[12.5px]">{ch.new ?? <i className="text-muted">{tr("default")}</i>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {plan.pending && <p className="text-sm font-medium">{tr("Kept for later: nothing changes on the cluster until the pending change is applied. The table lists every pending change.")}</p>}
      <p className={plan.apply === "reload" || plan.apply === "none" ? "text-sm" : "text-sm text-led-amber"}>
        {plan.pending && tr("When applied:") + " "}
        {APPLY[plan.apply]?.() ?? plan.apply}
      </p>
      {plan.apply !== "none" && !plan.pending && (
        <p className="text-sm text-muted">{tr("If the database stops starting because of the change, DBaaS writes the previous parameters back by itself and says why in the cluster's status.")}</p>
      )}
    </div>
  );
}

/** Messages per parameter of a refused change. */
function KeyErrors({ errors }: { errors: Record<string, string> }) {
  const e = Object.entries(errors);
  if (!e.length) return null;
  return (
    <ul className="space-y-1 rounded-md border border-led-red/40 bg-led-red/10 px-3 py-2 text-sm">
      {e.map(([k, m]) => (
        <li key={k}>
          <Mono>{k}</Mono>: {m}
        </li>
      ))}
    </ul>
  );
}

// =========================================================================== tab

export function ParametersTab({ c }: { c: DbCluster }) {
  const admin = !!c.project_id;
  const q = useParameters(c, c.status !== "creating");
  const history = useParameterHistory(c, c.status !== "creating");
  const catalog = useCatalog(c.engine, { version: c.version, flavor: c.flavor }, admin);
  const [open, setOpen] = useState<
    { kind: "change"; set?: Record<string, string>; unset?: string[]; text?: boolean } | { kind: "rollback"; r: ParameterRevision } | { kind: "apply-pending" } | { kind: "discard-pending" } | null
  >(null);
  const close = () => setOpen(null);
  const byName = new Map((catalog.data?.parameters ?? []).map((p) => [p.name.toLowerCase(), p]));
  const info = (name: string) => byName.get(name.toLowerCase());

  const applying = !!applyingParams(c);
  const blocked = applying ? tr("A parameter change is being applied") : c.status !== "ready" ? tr("The cluster isn't ready") : false;
  // While a change is applied, another one can still be kept for later.
  const changeBlocked = applying ? false : blocked;
  const pending = q.data?.pending;
  const pendingOf = (name: string) => {
    const k = Object.keys(pending?.set ?? {}).find((x) => x.toLowerCase() === name.toLowerCase());
    if (k) return pending!.set![k];
    return pending?.unset?.some((x) => x.toLowerCase() === name.toLowerCase()) ? null : undefined;
  };

  const cols: Column<Parameter>[] = [
    {
      key: "name",
      header: tr("Parameter"),
      cell: (p) => (
        <div className="min-w-0">
          <p className="truncate font-mono text-[12.5px]">{p.name}</p>
          {info(p.name)?.description && <p className="truncate text-xs text-muted">{info(p.name)?.description}</p>}
        </div>
      ),
      value: (p) => `${p.name} ${info(p.name)?.description ?? ""}`,
      csv: (p) => p.name,
    },
    {
      key: "value",
      header: tr("Value"),
      width: "14rem",
      mono: true,
      cell: (p) => {
        const next = pendingOf(p.name);
        return (
          <span className="break-all">
            {p.value}
            {next !== undefined && (
              <span className="ml-1.5 text-led-amber" title={tr("Pending change, not applied yet")}>
                → {next ?? <i className="font-sans">{tr("default")}</i>}
              </span>
            )}
          </span>
        );
      },
      value: (p) => p.value,
    },
    { key: "source", header: tr("Source"), width: "9rem", cell: (p) => <SourceBadge s={p.source} />, value: (p) => p.source },
    {
      key: "restart",
      header: tr("Restart"),
      width: "6rem",
      hideBelow: "md",
      cell: (p) => (p.restart ? <span title={tr("Changing it restarts the server")}>{tr("Yes")}</span> : <span className="text-muted">—</span>),
      value: (p) => String(!!p.restart),
    },
  ];

  const tenantKeys = (q.data?.parameters ?? []).filter((p) => p.source === "tenant" || (admin && p.source === "admin"));

  return (
    <div className="space-y-6">
      {c.status_reason && /parameter change/i.test(c.status_reason) && (
        <p className={`rounded-md border px-3 py-2 text-sm ${/reverted|not applied/i.test(c.status_reason) ? "border-led-red/40 bg-led-red/10" : "border-led-amber/40 bg-led-amber/10"}`}>{c.status_reason}</p>
      )}
      {pending && (Object.keys(pending.set ?? {}).length > 0 || (pending.unset ?? []).length > 0) && (
        <div className="rounded-md border border-led-amber/40 bg-led-amber/10 px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{tr("Pending change, not applied yet")}</p>
              <p className="mt-1 break-all font-mono text-[12.5px]">
                {[...Object.entries(pending.set ?? {}).map(([k, v]) => `${k}=${v}`), ...(pending.unset ?? []).map((k) => `−${k}`)].join("  ")}
              </p>
              <p className="mt-1 text-xs text-muted">
                {tr("Last changed by {user} on {time}.", { user: pending.user || "—", time: fmtDate(pending.time) ?? pending.time })}
                {pending.admin && " " + tr("(cloud operator)")}
                {" " + tr("Changes kept for later add up; the cluster keeps running with the values above until you apply them.")}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button onClick={() => setOpen({ kind: "discard-pending" })}>{tr("Discard")}</Button>
              <Button variant="primary" onClick={() => setOpen({ kind: "apply-pending" })} disabled={!!blocked} title={blocked || undefined}>
                {tr("Review and apply")}
              </Button>
            </div>
          </div>
        </div>
      )}
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold">{tr("Effective parameters")}</h2>
            <p className="text-sm text-muted">
              {tr("What DBaaS writes into the configuration; anything not listed keeps the engine's own default.")}
              {catalog.data && " " + tr("{n} parameters can be set on {engine} {major}.", { n: catalog.data.parameters.length, engine: c.engine, major: catalog.data.catalog })}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setOpen({ kind: "change", text: true })} disabled={!!changeBlocked} title={changeBlocked || tr("The parameters set for this cluster as a configuration file")}>
              <Icon name="file-code" />
              {tr("Edit as text")}
            </Button>
            <Button variant="primary" onClick={() => setOpen({ kind: "change" })} disabled={!!changeBlocked} title={changeBlocked || (applying ? tr("A change is being applied: a new one can be kept for later") : undefined)}>
              <Icon name="sliders-horizontal" />
              {tr("Change parameters")}
            </Button>
          </div>
        </div>
        <ErrorNotice error={q.error ?? catalog.error} className="mb-3" />
        <DataTable
          rows={q.data?.parameters}
          columns={cols}
          rowKey={(p) => p.name}
          loading={q.isPending}
          tableId="dbaas-parameters"
          noun={tr("parameters")}
          rowLabel={(p) => p.name}
          onRefresh={() => q.refetch()}
          refreshing={q.isFetching}
          empty={tr("Nothing set: the engine runs with its defaults.")}
          filterPlaceholder={tr("Filter by name, value or source")}
          rowActions={(p) => [
            { label: tr("Change"), icon: "edit", disabled: changeBlocked || (!editable(p.source, admin) && SOURCE[p.source]?.hint()), onSelect: () => setOpen({ kind: "change", set: { [p.name]: p.value } }) },
            {
              label: p.source === "flavor" || p.source === "engine" ? tr("Reset to default") : tr("Remove (back to the default)"),
              icon: "rotate-ccw",
              disabled: changeBlocked || ((p.source !== "tenant" && !(admin && p.source === "admin")) && tr("Only parameters set for this cluster can be removed")),
              onSelect: () => setOpen({ kind: "change", unset: [p.name] }),
            },
          ]}
        />
      </div>

      <div>
        <h2 className="mb-1 text-base font-semibold">{tr("History")}</h2>
        <p className="mb-3 text-sm text-muted">{tr("The last 10 changes of the parameters set for this cluster. Rolling back writes that revision's parameters as a new change.")}</p>
        <ErrorNotice error={history.error} className="mb-3" />
        <DataTable
          rows={history.data}
          columns={historyCols()}
          rowKey={(r) => String(r.revision)}
          loading={history.isPending}
          tableId="dbaas-parameter-history"
          noun={tr("revisions")}
          rowLabel={(r) => tr("Revision {n}", { n: r.revision })}
          empty={tr("No changes yet.")}
          rowActions={(r) => [{ label: tr("Roll back to this revision"), icon: "history", disabled: blocked, onSelect: () => setOpen({ kind: "rollback", r }) }]}
        />
      </div>

      {open?.kind === "change" && (
        <ChangeDialog
          c={c}
          catalog={catalog.data?.parameters}
          current={q.data?.parameters ?? []}
          tenantKeys={tenantKeys.map((p) => p.name)}
          initialSet={open.set}
          initialUnset={open.unset}
          initialMode={open.text ? "text" : "form"}
          applying={applying}
          onClose={close}
        />
      )}
      {open?.kind === "rollback" && <RollbackDialog c={c} r={open.r} onClose={close} />}
      {open?.kind === "apply-pending" && <ApplyPendingDialog c={c} onClose={close} />}
      {open?.kind === "discard-pending" && (
        <ActionDialog
          onClose={close}
          title={tr("Discard the pending change of {name}?", { name: c.name })}
          submitLabel={tr("Discard")}
          danger
          done={tr("Pending change of {name} discarded", { name: c.name })}
          refresh={[DB]}
          run={() => discardPending(c)}
        >
          <p className="text-sm">{tr("The changes kept for later are forgotten; the parameters in effect don't change.")}</p>
        </ActionDialog>
      )}
    </div>
  );
}

function historyCols(): Column<ParameterRevision>[] {
  return [
    { key: "rev", header: "#", width: "4rem", className: "text-right", cell: (r) => r.revision, value: (r) => r.revision },
    { key: "time", header: tr("Time"), width: "11rem", cell: (r) => fmtDate(r.time) ?? r.time, value: (r) => r.time },
    {
      key: "user",
      header: tr("By"),
      width: "12rem",
      hideBelow: "md",
      cell: (r) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span className="truncate">{r.user || "—"}</span>
          {r.admin && <Badge tone="warn">{tr("admin")}</Badge>}
        </span>
      ),
      value: (r) => r.user ?? "",
    },
    {
      key: "change",
      header: tr("Change"),
      cell: (r) => (
        <span className="whitespace-normal font-mono text-[12.5px]">
          {r.rollback_of != null && <span className="mr-1.5 font-sans text-muted">{tr("rollback to {n}:", { n: r.rollback_of })}</span>}
          {[...Object.entries(r.set ?? {}).map(([k, v]) => `${k}=${v}`), ...(r.unset ?? []).map((k) => `−${k}`)].join("  ") || "—"}
        </span>
      ),
      value: (r) => JSON.stringify([r.set, r.unset]),
    },
  ];
}

// =========================================================================== change

function ChangeDialog({
  c,
  catalog,
  current,
  tenantKeys,
  initialSet,
  initialUnset,
  initialMode = "form",
  applying = false,
  onClose,
}: {
  c: DbCluster;
  catalog?: CatalogParameter[];
  current: Parameter[];
  tenantKeys: string[];
  initialSet?: Record<string, string>;
  initialUnset?: string[];
  initialMode?: "form" | "text";
  /** A change is being applied: this one can only be kept for later. */
  applying?: boolean;
  onClose: () => void;
}) {
  const [when, setWhen] = useState<"immediate" | "pending">(applying ? "pending" : "immediate");
  const toast = useToast();
  const invalidate = useInvalidate();
  const [rows, setRows] = useState<KvRow[]>(() => (initialSet ? Object.entries(initialSet).map(([key, value]) => ({ key, value })) : initialUnset ? [] : [{ key: "", value: "" }]));
  const [unset, setUnset] = useState<string[]>(initialUnset ?? []);
  // Text mode edits the whole set of this cluster's own parameters, like a configuration file: a changed or new
  // line sets it, a deleted line goes back to the default.
  const base: Record<string, string> = Object.fromEntries(current.filter((p) => tenantKeys.includes(p.name)).map((p) => [p.name, p.value]));
  const [mode, setMode] = useState(initialMode);
  const [text, setText] = useState(() => (initialMode === "text" ? toConf(base) : ""));
  const parsed = mode === "text" ? parseConf(text, catalog) : null;
  const [plan, setPlan] = useState<ParametersPlan | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const formSet = Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value.trim()]));
  const textSet = parsed ? Object.fromEntries(Object.entries(parsed.values).filter(([k, v]) => base[k] !== v)) : {};
  const textUnset = parsed ? tenantKeys.filter((k) => !(k in parsed.values)) : [];
  const set = parsed ? textSet : formSet;
  const unsetKeys = parsed ? textUnset : unset;
  const rowProblem = kvError(rows) ?? (rows.some((r) => r.key.trim() && !r.value.trim()) ? tr("Every parameter needs a value; remove it to go back to the default") : null);
  const both = Object.keys(set).find((k) => unset.includes(k));
  const problem = parsed
    ? parsed.errors.length
      ? tr("Fix the lines marked in red first")
      : null
    : (rowProblem ?? (both ? tr("{k} is both set and removed", { k: both }) : null));
  const empty = !Object.keys(set).length && !unsetKeys.length;
  const switchMode = (m: "form" | "text") => {
    if (m === mode) return;
    if (m === "text") {
      const doc = Object.fromEntries(Object.entries(base).filter(([k]) => !unset.includes(k)));
      setText(toConf({ ...doc, ...formSet }));
    } else if (parsed) {
      // Unparsable lines are dropped; the form shows only what changes.
      setRows(Object.entries(textSet).map(([key, value]) => ({ key, value })));
      setUnset(textUnset);
    }
    setMode(m);
    setPlan(null);
    setError(null);
  };
  const errors = paramErrors(error);
  const generic = error && !Object.keys(errors).length ? error : null;
  const body = { ...(Object.keys(set).length ? { set } : {}), ...(unsetKeys.length ? { unset: unsetKeys } : {}), ...(when === "pending" ? { apply: "pending" as const } : {}) };

  const run = async (dry: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await patchParameters(c, { ...body, ...(dry ? { dry_run: true } : {}) });
      if (dry) setPlan(r);
      else {
        toast(r.pending ? tr("Change kept for later on {name}", { name: c.name }) : r.apply === "none" ? tr("Parameters of {name} unchanged", { name: c.name }) : tr("Applying parameter change {n} to {name}", { n: r.revision ?? "", name: c.name }));
        invalidate(DB);
        onClose();
      }
    } catch (e) {
      setError(e);
      setPlan(null);
    } finally {
      setBusy(false);
    }
  };
  const edit = (f: () => void) => {
    f();
    setPlan(null);
    setError(null);
  };
  const value = (k: string) => current.find((p) => p.name.toLowerCase() === k.toLowerCase())?.value;

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={tr("Change parameters of {name}", { name: c.name })}
      description={tr("Values as in the engine's own configuration: PostgreSQL units (64MB, 30s), MySQL numbers with K/M/G, MongoDB numbers, true/false or JSON. Review shows what changes and how it is applied; nothing is written before you apply.")}
      onSubmit={() => !busy && !problem && !empty && run(!plan)}
      footer={
        <>
          <Button type="button" onClick={plan ? () => setPlan(null) : onClose} disabled={busy}>
            {plan ? tr("Back") : tr("Cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !!problem || empty || (!!plan && !plan.changes.length)}>
            {plan ? (plan.pending ? tr("Keep for later") : tr("Apply")) : tr("Review changes")}
          </Button>
        </>
      }
    >
      {plan ? (
        <PlanView plan={plan} />
      ) : parsed ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted">{tr("The parameters set for this cluster. Change or add lines; delete a line to go back to the default.")}</p>
            <ModeSwitch value={mode} onChange={switchMode} />
          </div>
          <WhenPicker value={when} onChange={(v) => edit(() => setWhen(v))} applying={applying} />
          <ConfEditor
            value={text}
            onChange={(v) => edit(() => setText(v))}
            parsed={parsed}
            serverErrors={errors}
            rows={14}
            placeholder={c.engine === "mongodb" ? "operationProfiling:\n  slowOpThresholdMs: 200\nsetParameter.cursorTimeoutMillis = 600000" : c.engine === "mysql" ? "[mysqld]\nwait_timeout = 600\nmax_connections = 300" : "work_mem = 16MB\nlog_min_duration_statement = 500ms"}
          />
          {!parsed.errors.length && !empty && (
            <p className="text-xs text-muted">
              {[Object.keys(set).length && tr("{n} to set", { n: Object.keys(set).length }), unsetKeys.length && tr("{n} back to the default: {k}", { n: unsetKeys.length, k: unsetKeys.join(", ") })].filter(Boolean).join(" · ")}
            </p>
          )}
          {problem && <p className="text-sm text-led-red">{problem}</p>}
          <KeyErrors errors={Object.fromEntries(Object.entries(errors).filter(([k]) => !(k in parsed.lines)))} />
          <ErrorNotice error={generic} />
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <WhenPicker value={when} onChange={(v) => edit(() => setWhen(v))} applying={applying} />
            <ModeSwitch value={mode} onChange={switchMode} />
          </div>
          <KeyValueEditor
            rows={rows}
            onChange={(r) => edit(() => setRows(r))}
            suggestions={suggestionsOf(catalog)}
            keyPlaceholder={c.engine === "mongodb" ? "setParameter.cursorTimeoutMillis" : c.engine === "mysql" ? "wait_timeout" : "work_mem"}
            valuePlaceholder={tr("value")}
            addLabel={tr("Add parameter")}
            empty={tr("No parameter to set.")}
          />
          {rows.some((r) => r.key.trim() && value(r.key.trim()) != null) && (
            <p className="text-xs text-muted">
              {tr("Now:")}{" "}
              {rows
                .filter((r) => value(r.key.trim()) != null)
                .map((r) => `${r.key.trim()}=${value(r.key.trim())}`)
                .join(", ")}
            </p>
          )}
          {tenantKeys.length > 0 && (
            <div>
              <p className="mb-1.5 text-sm font-medium">{tr("Back to the default")}</p>
              <div className="flex flex-wrap gap-2">
                {tenantKeys.map((k) => {
                  const on = unset.includes(k);
                  return (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={on}
                      onClick={() => edit(() => setUnset(on ? unset.filter((x) => x !== k) : [...unset, k]))}
                      className={`rounded-md border px-2 py-1 font-mono text-xs ${on ? "border-led-red/60 bg-led-red/10 text-led-red line-through" : "border-line text-muted hover:border-cable hover:text-cable"}`}
                      title={on ? tr("Keep {k}", { k }) : tr("Remove {k}", { k })}
                    >
                      {k}={value(k)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {problem && <p className="text-sm text-led-red">{problem}</p>}
          <KeyErrors errors={errors} />
          <ErrorNotice error={generic} />
        </>
      )}
      {plan && <ErrorNotice error={error} />}
    </Dialog>
  );
}

// =========================================================================== rollback

function RollbackDialog({ c, r, onClose }: { c: DbCluster; r: ParameterRevision; onClose: () => void }) {
  // The dry run says what the rollback would change, before anything is written.
  const dry = useQuery({ queryKey: [DB, "rollback-dry", c.project_id ?? "", c.name, r.revision], queryFn: () => rollbackParameters(c, r.revision, true), retry: false, staleTime: 0 });
  const errors = paramErrors(dry.error);
  return (
    <ActionDialog
      onClose={onClose}
      size="lg"
      title={tr("Roll back {name} to revision {n}?", { name: c.name, n: r.revision })}
      description={tr("The parameters set for the cluster become those of revision {n} ({time}); the values are checked again as for any change.", { n: r.revision, time: fmtDate(r.time) ?? r.time })}
      submitLabel={tr("Roll back")}
      canSubmit={!!dry.data && dry.data.changes.length > 0}
      done={(p: ParametersPlan) => tr("Applying parameter change {n} to {name}", { n: p.revision ?? "", name: c.name })}
      refresh={[DB]}
      run={() => rollbackParameters(c, r.revision)}
    >
      {dry.isPending && <p className="text-sm text-muted">{tr("Checking…")}</p>}
      {dry.data && <PlanView plan={dry.data} />}
      <KeyErrors errors={errors} />
      {!Object.keys(errors).length && <ErrorNotice error={dry.error} />}
    </ActionDialog>
  );
}

// =========================================================================== pending

function WhenPicker({ value, onChange, applying }: { value: "immediate" | "pending"; onChange: (v: "immediate" | "pending") => void; applying: boolean }) {
  const opts = [
    { id: "immediate" as const, label: tr("Apply now"), hint: applying ? tr("Not while another change is applied") : tr("Reviewed, then applied: may restart members") },
    { id: "pending" as const, label: tr("Keep for later"), hint: tr("Nothing restarts; apply it in a quiet hour") },
  ];
  return (
    <div role="radiogroup" aria-label={tr("When")} className="flex flex-wrap gap-2">
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          disabled={o.id === "immediate" && applying}
          title={o.hint}
          onClick={() => onChange(o.id)}
          className={`rounded-md border px-2.5 py-1 text-left text-xs disabled:opacity-50 ${value === o.id ? "border-cable bg-cable/10 text-ink" : "border-line text-muted hover:text-ink"}`}
        >
          <span className="font-medium">{o.label}</span>
          <span className="ml-1.5 hidden text-muted sm:inline">{o.hint}</span>
        </button>
      ))}
    </div>
  );
}

function ApplyPendingDialog({ c, onClose }: { c: DbCluster; onClose: () => void }) {
  // Checked again: the cluster may have been resized or upgraded since the change was kept.
  const dry = useQuery({ queryKey: [DB, "apply-pending-dry", c.project_id ?? "", c.name], queryFn: () => applyPending(c, true), retry: false, staleTime: 0 });
  const errors = paramErrors(dry.error);
  return (
    <ActionDialog
      onClose={onClose}
      size="lg"
      title={tr("Apply the pending change of {name}?", { name: c.name })}
      description={tr("The values are checked again against the cluster's current version and flavor.")}
      submitLabel={tr("Apply")}
      canSubmit={!!dry.data}
      done={(p: ParametersPlan) => (p.apply === "none" ? tr("Nothing left to change: pending change of {name} cleared", { name: c.name }) : tr("Applying parameter change {n} to {name}", { n: p.revision ?? "", name: c.name }))}
      refresh={[DB]}
      run={() => applyPending(c)}
    >
      {dry.isPending && <p className="text-sm text-muted">{tr("Checking…")}</p>}
      {dry.data && <PlanView plan={{ ...dry.data, pending: false }} />}
      <KeyErrors errors={errors} />
      {Object.keys(errors).length > 0 && <p className="text-sm text-muted">{tr("The pending change is kept: change or discard it.")}</p>}
      {!Object.keys(errors).length && <ErrorNotice error={dry.error} />}
    </ActionDialog>
  );
}
