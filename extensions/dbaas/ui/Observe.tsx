/**
 * Observing a database cluster (DBaaS Phase 7): metrics charts from the cloud's Prometheus, member
 * logs, Kubernetes events, the slow query threshold and MySQL's busiest statements. Every query
 * is built by dbaas-api and pinned to the project; nothing here sends PromQL.
 */
import { type ReactNode, useEffect, useState } from "react";
import {
  ActionDialog,
  Badge,
  Button,
  Card,
  Chart,
  type Column,
  DataTable,
  Detail,
  ErrorNotice,
  Field,
  Icon,
  Input,
  Mono,
  Picker,
  type Series,
  StatusDot,
  Switch,
  type Unit,
  age,
  downloadText,
  fmt,
  fmtDate,
  tr,
} from "@rassvet/sdk";
import {
  type ClusterEvent,
  DB,
  type DbCluster,
  METRIC_RANGES,
  type MetricRange,
  type MetricSeries,
  type TopOrder,
  type TopQuery,
  errStatus,
  putSlowQueryLog,
  useEvents,
  useLogs,
  useMetrics,
  useSlowQueryLog,
  useTopQueries,
} from "./api";

/** What the cloud doesn't offer (501) is said once, in plain words. */
function Unoffered({ what }: { what: string }) {
  return <p className="text-sm text-muted">{tr("This cloud doesn't offer {what} for database clusters.", { what })}</p>;
}

// =========================================================================== metrics

/** Chart order and titles; series the engine doesn't have are simply absent. */
const METRICS: { name: string; title: () => string }[] = [
  { name: "cpu", title: () => tr("CPU (cores)") },
  { name: "memory", title: () => tr("Memory") },
  { name: "disk_used", title: () => tr("Disk used") },
  { name: "connections", title: () => tr("Connections") },
  { name: "operations", title: () => tr("Operations") },
  { name: "network_in", title: () => tr("Network in (your network)") },
  { name: "network_out", title: () => tr("Network out (your network)") },
  { name: "replication_lag", title: () => tr("Replication lag") },
  { name: "replication_queue", title: () => tr("Replication queue") },
  { name: "cache_hit_ratio", title: () => tr("Cache hit ratio") },
  { name: "queued_operations", title: () => tr("Queued operations") },
  { name: "slow_queries", title: () => tr("Slow queries") },
  { name: "row_lock_waits", title: () => tr("Row lock waits") },
  { name: "deadlocks", title: () => tr("Deadlocks") },
];

/** dbaas-api units → chart units; rates other than ops/s keep their name in the title. */
function chartUnit(u: string): Unit {
  switch (u) {
    case "bytes":
      return "bytes";
    case "bytes/s":
      return "bytes_per_sec";
    case "ops/s":
      return "ops_per_sec";
    case "seconds":
      return "seconds";
    case "ratio":
      return "percent_unit";
    default:
      return "count";
  }
}
const unitNote = (u: string) => (["bytes", "bytes/s", "ops/s", "seconds", "ratio", "cores"].includes(u) ? "" : ` (${u})`);

const RANGE_LABEL: Record<MetricRange, () => string> = {
  "15m": () => tr("15 minutes"),
  "1h": () => tr("1 hour"),
  "6h": () => tr("6 hours"),
  "24h": () => tr("24 hours"),
  "7d": () => tr("7 days"),
};

export function MonitoringTab({ c }: { c: DbCluster }) {
  const [range, setRange] = useState<MetricRange>("1h");
  const q = useMetrics(c, range, c.status !== "creating");
  if (errStatus(q.error) === 501) return <Unoffered what={tr("metrics")} />;
  const m = q.data;
  const byName = new Map<string, MetricSeries[]>();
  for (const s of m?.series ?? []) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
  const range_ = m ? { start: Date.parse(m.start) / 1000, end: Date.parse(m.end) / 1000 } : undefined;
  // The newest value of the volume's capacity, to show next to "Disk used".
  const capacity = (member: string) => byName.get("disk_capacity")?.find((s) => s.member === member)?.points.at(-1)?.[1];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {(m?.members ?? []).map((x) => (
            <span key={x.name} className="inline-flex items-center gap-2 rounded-md border border-line px-2.5 py-1 text-sm">
              <StatusDot status={x.up ? "ok" : "error"} label={x.name} />
              {x.role && <Badge tone={x.role === "primary" || x.role === "synced" ? "accent" : "neutral"}>{x.role}</Badge>}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Picker
            value={range}
            onChange={(v) => setRange(v as MetricRange)}
            size="sm"
            options={METRIC_RANGES.map((r) => ({ value: r, label: RANGE_LABEL[r]() }))}
          />
          <Button className="h-8" onClick={() => q.refetch()} disabled={q.isFetching} title={tr("Refresh")}>
            <Icon name="refresh" />
          </Button>
        </div>
      </div>
      <ErrorNotice error={q.error} />
      {q.isPending && <p className="text-sm text-muted">{tr("Loading…")}</p>}
      {m && range_ && (
        <div className="grid items-start gap-6 xl:grid-cols-2">
          {METRICS.filter((x) => byName.has(x.name)).map((x) => {
            const rows = byName.get(x.name)!;
            const unit = rows[0].unit;
            const series: Series[] = rows.map((s) => ({ name: s.member, labels: { member: s.member }, values: s.points }));
            const caps = x.name === "disk_used" ? rows.map((s) => capacity(s.member)).filter((v): v is number => v != null) : [];
            return (
              <Card key={x.name} title={`${x.title()}${unitNote(unit)}`} actions={caps.length ? <span className="text-xs text-muted">{tr("of {cap} each", { cap: fmt(Math.max(...caps), "bytes") })}</span> : undefined}>
                <Chart series={series} unit={chartUnit(unit)} range={range_} step={m.step_seconds} legendRows={3} />
              </Card>
            );
          })}
          {byName.size === 0 && <p className="text-sm text-muted">{tr("No data yet: the exporters start reporting a minute or two after the cluster is ready.")}</p>}
        </div>
      )}
    </div>
  );
}

// =========================================================================== logs

const TAILS = [100, 200, 500, 1000, 5000];
const SINCE = [
  { value: "", label: () => tr("Any time") },
  { value: "15m", label: () => tr("Last 15 minutes") },
  { value: "1h", label: () => tr("Last hour") },
  { value: "6h", label: () => tr("Last 6 hours") },
  { value: "24h", label: () => tr("Last 24 hours") },
];

export function LogsTab({ c }: { c: DbCluster }) {
  const [member, setMember] = useState<string>();
  const [container, setContainer] = useState<string>();
  const [tail, setTail] = useState(200);
  const [since, setSince] = useState("");
  const [all, setAll] = useState(false);
  const [previous, setPrevious] = useState(false);
  const [follow, setFollow] = useState(false);
  const [filter, setFilter] = useState("");
  const q = useLogs(c, { member, container, tail, since: since || undefined, all, previous }, c.status !== "creating");
  // Follow: refetch every 5 s while switched on.
  useFollow(follow, () => q.refetch());
  if (errStatus(q.error) === 501) return <Unoffered what={tr("logs")} />;
  const d = q.data;
  const lines = (d?.lines ?? []).filter((l) => !filter || l.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Field label={tr("Member")}>
          {(id) => (
            <Picker
              id={id}
              value={d?.member ?? member ?? ""}
              onChange={(v) => {
                setMember(v);
                setContainer(undefined);
              }}
              loading={q.isPending}
              options={(d?.members ?? []).map((x) => ({ value: x, label: x }))}
            />
          )}
        </Field>
        <Field label={tr("Container")}>
          {(id) => <Picker id={id} value={d?.container ?? container ?? ""} onChange={setContainer} loading={q.isPending} options={(d?.containers ?? []).map((x) => ({ value: x, label: x }))} />}
        </Field>
        <Field label={tr("Lines")}>
          {(id) => <Picker id={id} value={String(tail)} onChange={(v) => setTail(Number(v))} options={TAILS.map((n) => ({ value: String(n), label: tr("Last {n}", { n }) }))} />}
        </Field>
        <Field label={tr("Since")}>
          {(id) => <Picker id={id} value={since} onChange={setSince} options={SINCE.map((s) => ({ value: s.value, label: s.label() }))} />}
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Switch checked={follow} onChange={setFollow} label={tr("Follow (every 5 s)")} />
        <Switch checked={previous} onChange={setPrevious} label={tr("Before the last restart")} />
        {c.engine === "mongodb" && <Switch checked={all} onChange={setAll} label={tr("Connection and authentication lines")} />}
      </div>
      <ErrorNotice error={q.error} />
      <Card
        flush
        title={
          d ? (
            <span className="font-mono text-[13px]">
              {d.member} / {d.container}
            </span>
          ) : (
            tr("Log")
          )
        }
        actions={
          <div className="flex items-center gap-2">
            <Input className="h-8 w-44" placeholder={tr("Find in lines")} value={filter} onChange={(e) => setFilter(e.target.value)} />
            <Button className="h-8" onClick={() => q.refetch()} disabled={q.isFetching} title={tr("Refresh")}>
              <Icon name="refresh" />
            </Button>
            <Button className="h-8" disabled={!d?.lines.length} onClick={() => d && downloadText(`${c.name}-${d.member}-${d.container}.log`, `${d.lines.join("\n")}\n`)} title={tr("Download")}>
              <Icon name="download" />
            </Button>
          </div>
        }
      >
        <pre className="max-h-[60vh] min-h-40 overflow-auto whitespace-pre-wrap break-all p-4 font-mono text-[12px] leading-5">
          {lines.length ? lines.join("\n") : q.isPending ? tr("Loading…") : tr("No lines.")}
        </pre>
      </Card>
      {!!d?.filtered && !all && <p className="text-xs text-muted">{tr("{n} connection and authentication lines hidden.", { n: d.filtered })}</p>}
      <p className="text-xs text-muted">{tr("Logs are kept as long as the container runs. Reading them needs the member or admin role, as they can contain data.")}</p>
    </div>
  );
}

function useFollow(on: boolean, tick: () => void) {
  useEffect(() => {
    if (!on) return;
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, [on]); // eslint-disable-line react-hooks/exhaustive-deps
}

// =========================================================================== events

export function EventsTab({ c }: { c: DbCluster }) {
  const q = useEvents(c);
  const rows = q.data ? [...q.data].reverse() : undefined;
  const cols: Column<ClusterEvent>[] = [
    { key: "last", header: tr("Last seen"), width: "8rem", cell: (e) => <span title={fmtDate(e.last_seen) ?? ""}>{age(e.last_seen)}</span>, value: (e) => e.last_seen },
    { key: "type", header: tr("Type"), width: "8rem", cell: (e) => <StatusDot status={e.type === "Warning" ? "warn" : "ok"} label={e.type === "Warning" ? tr("Warning") : tr("Normal")} />, value: (e) => e.type },
    { key: "reason", header: tr("Reason"), width: "11rem", cell: (e) => e.reason, value: (e) => e.reason },
    { key: "object", header: tr("Object"), width: "14rem", hideBelow: "lg", mono: true, cell: (e) => e.object, value: (e) => e.object },
    { key: "message", header: tr("Message"), wrap: true, cell: (e) => e.message, value: (e) => e.message },
    { key: "count", header: tr("Count"), width: "5rem", hideBelow: "md", className: "text-right", cell: (e) => e.count, value: (e) => e.count },
  ];
  return (
    <>
      <ErrorNotice error={q.error} className="mb-3" />
      <DataTable
        rows={rows}
        columns={cols}
        rowKey={(e) => `${e.object}|${e.reason}|${e.first_seen}`}
        loading={q.isPending}
        tableId="dbaas-events"
        noun={tr("events")}
        onRefresh={() => q.refetch()}
        refreshing={q.isFetching}
        empty={tr("No events in the last hour.")}
        filterPlaceholder={tr("Filter by reason, object or message")}
      />
      <p className="mt-3 text-xs text-muted">{tr("Events of the cluster, its members, ports, backups and restores. Kubernetes keeps them for about an hour.")}</p>
    </>
  );
}

// =========================================================================== queries

export function QueriesTab({ c }: { c: DbCluster }) {
  return (
    <div className="space-y-6">
      <SlowQueryCard c={c} />
      {c.engine === "mysql" && <TopQueriesTable c={c} />}
    </div>
  );
}

function SlowQueryCard({ c }: { c: DbCluster }) {
  const q = useSlowQueryLog(c);
  const [editing, setEditing] = useState(false);
  if (errStatus(q.error) === 501) return <Unoffered what={tr("slow query settings")} />;
  const t = q.data;
  const where: Record<string, () => string> = {
    mongodb: () => tr("Slower statements are logged as \"Slow query\" in the mongod log (Logs tab)."),
    postgresql: () => tr("Slower statements are logged as \"duration: … statement: …\" in the database log (Logs tab)."),
    mysql: () => tr("Slower statements are counted in the Slow queries chart; see the busiest statements below."),
  };
  return (
    <Card
      title={tr("Slow query threshold")}
      className="max-w-2xl"
      actions={
        <Button className="h-8" onClick={() => setEditing(true)} disabled={!t || c.status !== "ready"}>
          <Icon name="edit" />
          {tr("Change")}
        </Button>
      }
    >
      <ErrorNotice error={q.error} className="mb-3" />
      {t && (
        <dl>
          <Detail label={tr("Threshold")}>
            {t.threshold_ms < 0 ? tr("Off") : `${t.threshold_ms} ms`} {t.default && <Badge>{tr("engine default")}</Badge>}
          </Detail>
        </dl>
      )}
      <p className="mt-3 text-sm text-muted">{where[c.engine]?.()}</p>
      {editing && t && <SlowQueryDialog c={c} current={t.threshold_ms} onClose={() => setEditing(false)} />}
    </Card>
  );
}

function SlowQueryDialog({ c, current, onClose }: { c: DbCluster; current: number; onClose: () => void }) {
  const [value, setValue] = useState(String(current));
  const n = Number(value);
  const valid = value.trim() !== "" && Number.isInteger(n) && n >= (c.engine === "postgresql" ? -1 : 0) && n <= 3_600_000;
  return (
    <ActionDialog
      onClose={onClose}
      title={tr("Slow query threshold of {name}", { name: c.name })}
      submitLabel={tr("Save")}
      canSubmit={valid && n !== current}
      done={tr("Slow query threshold of {name} saved", { name: c.name })}
      refresh={[DB]}
      run={() => putSlowQueryLog(c, n)}
    >
      <Field label={tr("Threshold (ms)")} hint={c.engine === "postgresql" ? tr("-1 stops logging statements. Applied without a restart.") : tr("0 to 3600000.")}>
        {(id) => <Input id={id} type="number" min={c.engine === "postgresql" ? -1 : 0} max={3_600_000} value={value} onChange={(e) => setValue(e.target.value)} />}
      </Field>
      {c.engine !== "postgresql" && <p className="text-sm text-led-amber">{tr("The members restart one by one to apply it.")}</p>}
    </ActionDialog>
  );
}

const ORDERS: { value: TopOrder; label: () => string }[] = [
  { value: "total", label: () => tr("Total time") },
  { value: "avg", label: () => tr("Average time") },
  { value: "calls", label: () => tr("Calls") },
  { value: "rows", label: () => tr("Rows examined") },
];
const ms = (v: number) => fmt(v / 1000, "seconds");

function TopQueriesTable({ c }: { c: DbCluster }) {
  const [member, setMember] = useState<string>();
  const [order, setOrder] = useState<TopOrder>("total");
  const [limit, setLimit] = useState(20);
  const q = useTopQueries(c, { member, order, limit }, c.status !== "creating");
  if (errStatus(q.error) === 501) return null;
  const d = q.data;
  const cols: Column<TopQuery>[] = [
    {
      key: "query",
      header: tr("Statement"),
      wrap: true,
      cell: (x) => (
        <div className="min-w-0">
          <Mono className="block whitespace-pre-wrap break-words text-[12px]">{x.query}</Mono>
          {x.schema && <p className="mt-0.5 text-xs text-muted">{x.schema}</p>}
        </div>
      ),
      value: (x) => `${x.query} ${x.schema ?? ""}`,
    },
    { key: "calls", header: tr("Calls"), width: "6rem", className: "text-right", cell: (x) => x.calls.toLocaleString(), value: (x) => x.calls },
    { key: "total", header: tr("Total"), width: "7rem", className: "text-right", cell: (x) => ms(x.total_ms), value: (x) => x.total_ms },
    { key: "avg", header: tr("Average"), width: "7rem", className: "text-right", hideBelow: "md", cell: (x) => ms(x.avg_ms), value: (x) => x.avg_ms },
    { key: "max", header: tr("Max"), width: "7rem", className: "text-right", hideBelow: "lg", cell: (x) => ms(x.max_ms), value: (x) => x.max_ms },
    { key: "rows", header: tr("Rows examined / sent"), width: "10rem", className: "text-right", hideBelow: "xl", cell: (x) => `${x.rows_examined.toLocaleString()} / ${x.rows_sent.toLocaleString()}`, value: (x) => x.rows_examined },
    { key: "last", header: tr("Last seen"), width: "7rem", hideBelow: "2xl", cell: (x) => <span title={fmtDate(x.last_seen) ?? ""}>{age(x.last_seen)}</span>, value: (x) => x.last_seen },
  ];
  return (
    <div>
      <Heading
        actions={
          <>
            <Picker value={d?.member ?? member ?? ""} onChange={setMember} size="sm" loading={q.isPending} options={(d?.members ?? []).map((x) => ({ value: x, label: x }))} />
            <Picker value={order} onChange={(v) => setOrder(v as TopOrder)} size="sm" options={ORDERS.map((o) => ({ value: o.value, label: o.label() }))} />
            <Picker value={String(limit)} onChange={(v) => setLimit(Number(v))} size="sm" options={[10, 20, 50, 100].map((n) => ({ value: String(n), label: tr("Top {n}", { n }) }))} />
          </>
        }
      >
        {tr("Busiest statements")}
      </Heading>
      <ErrorNotice error={q.error} className="mb-3" />
      <DataTable
        rows={d?.queries}
        columns={cols}
        rowKey={(x) => x.digest}
        loading={q.isPending}
        tableId="dbaas-top-queries"
        noun={tr("statements")}
        onRefresh={() => q.refetch()}
        refreshing={q.isFetching}
        empty={tr("No statements recorded on this member yet.")}
        filterPlaceholder={tr("Filter statements")}
      />
      <p className="mt-3 text-xs text-muted">{tr("From performance_schema of one member, since it started. Literals are replaced by ?. Needs the member or admin role.")}</p>
    </div>
  );
}

function Heading({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-base font-semibold">{children}</h2>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}
