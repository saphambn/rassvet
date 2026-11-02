/**
 * Terraform / OpenTofu export: HCL for the terraform-provider-openstack/openstack provider
 * (3.x) from resources of the current project, with `import {}` blocks (Terraform 1.5+,
 * OpenTofu 1.6+) so `terraform plan` adopts the existing resources instead of creating new
 * ones. References between exported resources use resource addresses. Anything else the
 * code needs (an external network, a shared subnet, an image, a volume…) is read at plan
 * time with a `data` source looked up by name; when a name can't find it unambiguously, it
 * becomes a `variable` whose default is today's ID. With `lookups: "literal"` the IDs are
 * written in place instead.
 *
 * The host exports core OpenStack resources; an extension adds its own kinds with a
 * `TerraformContribution` (`ExtensionUi.terraform`): a hook that loads them and lists them on
 * the page, and the code that writes their blocks with the `TfGen` helpers.
 */
import type { FloatingIp, Keypair, Network, Port, Router, SecurityGroup, SecurityGroupRule, Server, Subnet, Volume } from "./os";

export interface TfInput {
  servers: Server[];
  volumes: Volume[];
  networks: Network[];
  subnets: Subnet[];
  routers: Router[];
  ports: Port[];
  secgroups: SecurityGroup[];
  fips: FloatingIp[];
  keypairs: Keypair[];
  /** Glance images (id + name), to look images up by name. */
  images?: { id: string; name?: string | null }[];
}

export type TfKind = "servers" | "volumes" | "networks" | "routers" | "secgroups" | "fips" | "keypairs";
export const CORE_KINDS: TfKind[] = ["servers", "volumes", "networks", "routers", "secgroups", "fips", "keypairs"];
/** Picked IDs per kind: the core kinds, and `<extension>.<kind>` for an extension's. */
export type TfSelection = Record<string, Set<string>>;

export const emptySelection = (kinds: string[] = CORE_KINDS): TfSelection => Object.fromEntries(kinds.map((k) => [k, new Set<string>()]));
const ids = (sel: TfSelection, kind: string) => sel[kind] ?? new Set<string>();

// ---------------------------------------------------------------- extension contract

/** A row in a section of the page. */
export interface TfItem {
  id: string;
  name: string;
  sub?: string;
}

/** One list of pickable resources on the page. */
export interface TfSection {
  /** Unique: `<extension>.<kind>`. */
  kind: string;
  icon: string;
  title: string;
  /** Undefined while loading. */
  items?: TfItem[];
  loading: boolean;
  error: unknown;
}

export interface TfContext {
  /** The current project; an extension lists only its resources. */
  projectId: string;
}

/** What an extension contributes to one export. */
export interface TfSource {
  sections: TfSection[];
  /** Adds what the picked resources need to `sel` (core kinds too, e.g. a key pair). */
  dependencies?: (sel: TfSelection, input: TfInput) => void;
  /** First pass: `g.name()` every picked resource, so references work in any order. */
  names?: (g: TfGen, sel: TfSelection) => void;
  /** Second pass, after the core resources: the blocks. */
  generate: (g: TfGen, sel: TfSelection) => void;
}

export interface TerraformContribution {
  /** A hook (called on every render of the page) that loads the extension's resources. */
  useSource: (c: TfContext) => TfSource;
}

/** The helpers `generate` hands to extensions. */
export interface TfGen {
  /** The core resources (to resolve references). */
  input: TfInput;
  imports: boolean;
  /** IDs in place instead of data sources / variables. */
  literal: boolean;
  /** Resource types of the core blocks (`T.keypair`…), for `addr`. */
  T: typeof T;
  /** Reserves the Terraform name of a resource (unique per type) and returns it. */
  name: (type: string, id: string, base: string | null | undefined) => string;
  /** The name of a resource written in this file, if any. */
  addr: (type: string, id: string) => string | undefined;
  /** A `resource` block (and its `import` block); see the core's for `ignore` / `always`. */
  block: (type: string, name: string, body: string[], importId?: string, ignore?: string[], always?: string[]) => void;
  /** `# --- title ---` before a group of blocks. */
  section: (title: string) => void;
  /** Aligned `key = value` lines; pairs with an empty value are left out. */
  attrs: (pairs: [string, string | undefined | null | false][]) => string[];
  /** HCL map lines (`{`, `k = "v"`…, `}`) of string values. */
  map: (m: Record<string, string>) => string[];
  str: (s: string) => string;
  /** One-line comment-safe text. */
  note: (s: string) => string;
  /** A network / subnet / image / key pair expression: exported address, lookup or ID. */
  network: (id: string) => string;
  subnet: (id: string) => string;
  image: (id: string, hint?: string | null) => string;
  keypair: (name: string) => string;
  /** A `variable` holding today's ID (or the literal in literal mode). */
  variable: (kind: string, id: string, label?: string | null) => string;
  /** Shown above the code. */
  notes: string[];
}

const T = {
  server: "openstack_compute_instance_v2",
  volume: "openstack_blockstorage_volume_v3",
  attach: "openstack_compute_volume_attach_v2",
  network: "openstack_networking_network_v2",
  subnet: "openstack_networking_subnet_v2",
  router: "openstack_networking_router_v2",
  routerIf: "openstack_networking_router_interface_v2",
  secgroup: "openstack_networking_secgroup_v2",
  rule: "openstack_networking_secgroup_rule_v2",
  fip: "openstack_networking_floatingip_v2",
  keypair: "openstack_compute_keypair_v2",
} as const;

const ROUTER_IF = new Set(["network:router_interface", "network:router_interface_distributed", "network:ha_router_replicated_interface"]);

/** HCL string literal. */
export function str(s: string) {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t").replace(/\$\{/g, "$${").replace(/%\{/g, "%%{")}"`;
}

/** Comment-safe text (one line). */
const note = (s: string) => s.replace(/[\r\n]+/g, " ").slice(0, 120);

/** Unique Terraform names per resource type, from resource names. */
class Namer {
  private used = new Map<string, Set<string>>();
  private byId = new Map<string, string>();
  name(type: string, id: string, base: string | null | undefined) {
    const key = `${type}:${id}`;
    const have = this.byId.get(key);
    if (have) return have;
    let n = (base || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "");
    if (!n) n = `${type.split("_")[2] ?? "res"}_${id.replace(/-/g, "").slice(0, 8)}`;
    if (!/^[a-z_]/.test(n)) n = `r_${n}`;
    const set = this.used.get(type) ?? new Set<string>();
    let out = n;
    for (let i = 2; set.has(out); i++) out = `${n}_${i}`;
    set.add(out);
    this.used.set(type, set);
    this.byId.set(key, out);
    return out;
  }
  get(type: string, id: string) {
    return this.byId.get(`${type}:${id}`);
  }
}

/**
 * The selection plus what it needs to stand on its own: an instance's key pair, security
 * groups, networks (and their subnets), volumes and floating IPs that belong to the project.
 */
export function withDependencies(input: TfInput, sel: TfSelection, projectId: string, exts: TfSource[] = []): TfSelection {
  const out: TfSelection = Object.fromEntries(Object.entries(sel).map(([k, v]) => [k, new Set(v)]));
  for (const k of CORE_KINDS) out[k] ??= new Set();
  const own = (p?: string) => !projectId || p === projectId;
  const netByName = new Map(input.networks.map((n) => [n.name, n]));
  for (const s of input.servers.filter((x) => ids(sel, "servers").has(x.id))) {
    if (s.key_name && input.keypairs.some((k) => k.name === s.key_name)) out.keypairs.add(s.key_name);
    for (const g of s.security_groups ?? []) {
      const sg = input.secgroups.find((x) => x.name === g.name && own(x.project_id));
      if (sg && sg.name !== "default") out.secgroups.add(sg.id);
    }
    for (const name of Object.keys(s.addresses ?? {})) {
      const n = netByName.get(name);
      if (n && own(n.project_id) && !n["router:external"] && !n.shared) out.networks.add(n.id);
    }
    for (const v of s["os-extended-volumes:volumes_attached"] ?? []) if (input.volumes.some((x) => x.id === v.id)) out.volumes.add(v.id);
    const ports = new Set(input.ports.filter((p) => p.device_id === s.id).map((p) => p.id));
    for (const f of input.fips) if (f.port_id && ports.has(f.port_id) && own(f.project_id)) out.fips.add(f.id);
  }
  for (const e of exts) e.dependencies?.(out, input);
  return out;
}

export interface TfResult {
  hcl: string;
  resources: number;
  notes: string[];
}

export function generate(
  input: TfInput,
  sel: TfSelection,
  opts: { imports: boolean; lookups?: "data" | "literal"; project?: string; region?: string | null; cloud?: string; date?: string },
  exts: TfSource[] = [],
): TfResult {
  const nm = new Namer();
  const notes: string[] = [];
  const out: string[] = [];
  /** data + variable blocks for what isn't exported, emitted after the provider. */
  const looked: string[] = [];
  const literal = opts.lookups === "literal";
  let count = 0;

  const servers = input.servers.filter((x) => ids(sel, "servers").has(x.id));
  const volumes = input.volumes.filter((x) => ids(sel, "volumes").has(x.id));
  const networks = input.networks.filter((x) => ids(sel, "networks").has(x.id));
  const subnets = input.subnets.filter((x) => ids(sel, "networks").has(x.network_id));
  const routers = input.routers.filter((x) => ids(sel, "routers").has(x.id));
  const secgroups = input.secgroups.filter((x) => ids(sel, "secgroups").has(x.id));
  const fips = input.fips.filter((x) => ids(sel, "fips").has(x.id));
  const keypairs = input.keypairs.filter((x) => ids(sel, "keypairs").has(x.name));

  // Names first, so references work in any order.
  for (const k of keypairs) nm.name(T.keypair, k.name, k.name);
  for (const g of secgroups) nm.name(T.secgroup, g.id, g.name);
  for (const n of networks) nm.name(T.network, n.id, n.name);
  for (const s of subnets) nm.name(T.subnet, s.id, s.name || `${networks.find((n) => n.id === s.network_id)?.name ?? "subnet"}_${s.ip_version === 6 ? "v6" : "v4"}`);
  for (const r of routers) nm.name(T.router, r.id, r.name);
  for (const v of volumes) nm.name(T.volume, v.id, v.name);
  for (const s of servers) nm.name(T.server, s.id, s.name);
  for (const f of fips) nm.name(T.fip, f.id, f.description || `fip_${f.floating_ip_address.replace(/[.:]/g, "_")}`);

  const netName = (id: string) => input.networks.find((n) => n.id === id)?.name;
  const subnetName = (id: string) => input.subnets.find((n) => n.id === id)?.name;
  // ------------------------------------------------------------ lookups (not exported)
  const lkNames = new Namer();
  const lkDone = new Map<string, string>();
  const unique = <X,>(list: X[], key: (x: X) => string | null | undefined, v: string) => list.filter((x) => key(x) === v).length === 1;
  /** `variable "<x>_id"` with today's ID as default; returns `var.<x>_id`. */
  const variable = (kind: string, id: string, label?: string | null) => {
    const key = `var:${id}`;
    const have = lkDone.get(key);
    if (have) return have;
    const n = lkNames.name("variable", id, `${kind}_${label || id.slice(0, 8)}_id`).replace(/-/g, "_");
    looked.push(
      [
        `variable "${n}" {`,
        `  description = ${str(`${`${kind.replace(/_/g, " ")} ${label ?? ""}`.trim()} (its ID at export time: no unique name to look it up by)`)}`,
        "  type        = string",
        `  default     = ${str(id)}`,
        "}",
      ].join("\n"),
    );
    lkDone.set(key, `var.${n}`);
    return `var.${n}`;
  };
  /** `data "<type>" "<name>" { … }` once per (type, id); returns its address. */
  const data = (type: string, id: string, base: string | null | undefined, body: [string, string | null | undefined | false][]) => {
    const key = `${type}:${id}`;
    const have = lkDone.get(key);
    if (have) return have;
    const n = lkNames.name(type, id, base);
    looked.push([`data "${type}" "${n}" {`, ...attrs(body).map((l) => `  ${l}`), "}"].join("\n"));
    lkDone.set(key, `data.${type}.${n}`);
    return `data.${type}.${n}`;
  };
  /** The project of the credentials Terraform runs with (security group names repeat across projects). */
  const scope = () => `${data("openstack_identity_auth_scope_v3", "current", "current", [["name", str("current")]])}.project_id`;

  const lookNetwork = (id: string): string => {
    const n = input.networks.find((x) => x.id === id);
    if (n?.name && unique(input.networks, (x) => x.name, n.name))
      return `${data("openstack_networking_network_v2", id, n.name, [
        ["name", str(n.name)],
        ["external", n["router:external"] ? "true" : null],
      ])}.id`;
    return variable("network", id, n?.name);
  };
  const netExpr = (id: string) => (nm.get(T.network, id) ? `${T.network}.${nm.get(T.network, id)}.id` : literal ? str(id) : lookNetwork(id));
  const lookSubnet = (id: string): string => {
    const sn = input.subnets.find((x) => x.id === id);
    if (!sn) return variable("subnet", id);
    const same = input.subnets.filter((x) => x.network_id === sn.network_id);
    if (sn.name && unique(same, (x) => x.name, sn.name))
      return `${data("openstack_networking_subnet_v2", id, sn.name, [
        ["name", str(sn.name)],
        ["network_id", netExpr(sn.network_id)],
      ])}.id`;
    if (unique(same, (x) => x.cidr, sn.cidr))
      return `${data("openstack_networking_subnet_v2", id, `subnet_${sn.cidr}`, [
        ["cidr", str(sn.cidr)],
        ["network_id", netExpr(sn.network_id)],
      ])}.id`;
    return variable("subnet", id, sn.name || sn.cidr);
  };
  const lookSecgroup = (id: string): string => {
    const g = input.secgroups.find((x) => x.id === id);
    if (g?.name && unique(input.secgroups, (x) => x.name, g.name))
      return `${data("openstack_networking_secgroup_v2", id, g.name, [
        ["name", str(g.name)],
        ["tenant_id", scope()],
      ])}.id`;
    return variable("security_group", id, g?.name);
  };
  const lookVolume = (id: string): string => {
    const v = input.volumes.find((x) => x.id === id);
    if (v?.name && unique(input.volumes, (x) => x.name, v.name)) return `${data("openstack_blockstorage_volume_v3", id, v.name, [["name", str(v.name)]])}.id`;
    return variable("volume", id, v?.name);
  };
  const lookImage = (id: string, hint?: string | null): string => {
    if (literal) return `${str(id)}${hint ? ` # ${note(hint)}` : ""}`;
    const name = input.images?.find((x) => x.id === id)?.name ?? null;
    if (name && input.images && unique(input.images, (x) => x.name, name))
      return `${data("openstack_images_image_v2", id, name, [
        ["name", str(name)],
        // A later upload under the same name would otherwise make the lookup ambiguous.
        ["most_recent", "true"],
      ])}.id`;
    return variable("image", id, name ?? hint);
  };
  /** No data source to find it by name here: a variable (or the literal in literal mode). */
  const plain = (kind: string, id: string, label?: string | null) => (literal ? `${str(id)}${label ? ` # ${note(label)}` : ""}` : variable(kind, id, label));

  /** `addr.id` when exported, else a lookup (or the literal ID in literal mode). */
  const ref = (type: string, id: string | null | undefined, label?: string | null, attr = "id") => {
    if (!id) return { expr: "null", comment: "" };
    const n = nm.get(type, id);
    if (n) return { expr: `${type}.${n}.${attr}`, comment: "" };
    if (literal) return { expr: str(id), comment: label ? ` # ${note(label)} (not exported)` : " # not exported" };
    const expr =
      type === T.network ? lookNetwork(id) : type === T.subnet ? lookSubnet(id) : type === T.secgroup ? lookSecgroup(id) : type === T.volume ? lookVolume(id) : variable(type.split("_")[2] ?? "resource", id, label);
    return { expr, comment: "" };
  };

  const refText = (type: string, id: string, label?: string) => {
    const r = ref(type, id, label);
    return `${r.expr}${r.comment}`;
  };

  /**
   * `ignore`: attributes an import can't compare (not returned by the API, or in another
   * order); `always`: ones that drift by design (an image looked up by name moves to a
   * newer upload of the same name, which must not rebuild the instance or volume).
   */
  const block = (type: string, name: string, body: string[], importId?: string, ignore?: string[], always?: string[]) => {
    count++;
    const lines = [`resource "${type}" "${name}" {`, ...body.map((l) => (l ? `  ${l}` : ""))];
    const keep = [...new Set([...(always ?? []), ...(opts.imports ? (ignore ?? []) : [])])];
    if (keep.length) {
      lines.push(
        "",
        "  lifecycle {",
        opts.imports && ignore?.length
          ? "    # Not comparable after an import (not returned by the API, or listed in another order)."
          : "    # The image is looked up by name: a newer upload must not rebuild this.",
        `    ignore_changes = [${keep.join(", ")}]`,
        "  }",
      );
    }
    lines.push("}");
    if (opts.imports && importId) lines.push("", "import {", `  to = ${type}.${name}`, `  id = ${str(importId)}`, "}");
    out.push(lines.join("\n"));
  };
  const kv = (k: string, v: string, width: number) => `${k.padEnd(width)} = ${v}`;
  const attrs = (pairs: [string, string | undefined | null | false][]) => {
    const keep = pairs.filter((p): p is [string, string] => !!p[1]);
    const w = Math.max(0, ...keep.map(([k]) => k.length));
    return keep.map(([k, v]) => kv(k, v, w));
  };
  const map = (m: Record<string, string>) => ["{", ...Object.entries(m).map(([k, v]) => `  ${/^[A-Za-z_][\w-]*$/.test(k) ? k : str(k)} = ${str(v)}`), "}"];
  const list = (xs: string[]) => `[${xs.join(", ")}]`;
  const section = (title: string) => out.push(`# ${"-".repeat(3)} ${title} ${"-".repeat(Math.max(3, 70 - title.length))}`);
  const gen: TfGen = {
    input,
    imports: opts.imports,
    literal,
    T,
    name: (type, id, base) => nm.name(type, id, base),
    addr: (type, id) => nm.get(type, id),
    block,
    section,
    attrs,
    map,
    str,
    note,
    network: netExpr,
    subnet: (id) => refText(T.subnet, id),
    image: lookImage,
    keypair: (name) => (nm.get(T.keypair, name) ? `${T.keypair}.${nm.get(T.keypair, name)}.name` : str(name)),
    variable: (kind, id, label) => (literal ? `${str(id)}${label ? ` # ${note(label)}` : ""}` : variable(kind, id, label)),
    notes,
  };
  for (const e of exts) e.names?.(gen, sel);

  // ---- header
  out.push(
    [
      `# Generated by Rassvet${opts.date ? ` on ${opts.date}` : ""}${opts.project ? ` from project "${note(opts.project)}"` : ""}${opts.region ? `, region ${opts.region}` : ""}.`,
      opts.imports
        ? "# The import blocks adopt the existing resources (Terraform 1.5+ / OpenTofu 1.6+): `terraform plan`\n# should show only imports. Review any other change before `terraform apply`."
        : "# No import blocks: `terraform apply` creates NEW resources from this. To manage the existing\n# ones instead, export again with import blocks (or run `terraform import` for each).",
      "",
      "terraform {",
      "  required_providers {",
      "    openstack = {",
      '      source  = "terraform-provider-openstack/openstack"',
      '      version = "~> 3.0"',
      "    }",
      "  }",
      "}",
      "",
      "# Credentials come from clouds.yaml (OS_CLOUD) or the OS_* variables of an openrc file.",
      'provider "openstack" {',
      ...(opts.cloud ? [`  # cloud  = ${str(opts.cloud)}`] : []),
      ...(opts.region ? [`  region = ${str(opts.region)}`] : []),
      "}",
    ].join("\n"),
  );

  // ---- key pairs
  if (keypairs.length) section("Key pairs");
  for (const k of keypairs) {
    block(T.keypair, nm.get(T.keypair, k.name)!, attrs([["name", str(k.name)], ["public_key", str(k.public_key.trim())]]), k.name);
  }

  // ---- security groups
  if (secgroups.length) section("Security groups");
  for (const g of secgroups) {
    const gname = nm.get(T.secgroup, g.id)!;
    block(
      T.secgroup,
      gname,
      [
        ...attrs([
          ["name", str(g.name)],
          ["description", g.description ? str(g.description) : null],
          // Every rule is managed below, including the default egress ones.
          ["delete_default_rules", "true"],
          ["stateful", g.stateful === false ? "false" : null],
        ]),
      ],
      g.id,
    );
    for (const r of g.security_group_rules ?? []) block(T.rule, nm.name(T.rule, r.id, ruleName(gname, r)), ruleBody(r, g, ref), r.id);
  }

  // ---- networks
  if (networks.length) section("Networks");
  for (const n of networks) {
    block(
      T.network,
      nm.get(T.network, n.id)!,
      attrs([
        ["name", str(n.name)],
        ["description", n.description ? str(n.description) : null],
        ["admin_state_up", n.admin_state_up ? null : "false"],
        ["mtu", n.mtu ? String(n.mtu) : null],
        ["port_security_enabled", n.port_security_enabled === false ? "false" : null],
        ["shared", n.shared ? "true" : null],
        ["external", n["router:external"] ? "true" : null],
        ["dns_domain", n.dns_domain ? str(n.dns_domain) : null],
      ]),
      n.id,
    );
    for (const s of subnets.filter((x) => x.network_id === n.id)) {
      const body = attrs([
        ["name", str(s.name)],
        ["network_id", `${T.network}.${nm.get(T.network, n.id)}.id`],
        ["cidr", str(s.cidr)],
        ["ip_version", String(s.ip_version)],
        ["gateway_ip", s.gateway_ip ? str(s.gateway_ip) : null],
        ["no_gateway", s.gateway_ip ? null : "true"],
        ["enable_dhcp", s.enable_dhcp ? null : "false"],
        ["dns_nameservers", s.dns_nameservers?.length ? list(s.dns_nameservers.map(str)) : null],
        ["dns_publish_fixed_ip", s.dns_publish_fixed_ip ? "true" : null],
        ["ipv6_address_mode", s.ipv6_address_mode ? str(s.ipv6_address_mode) : null],
        ["ipv6_ra_mode", s.ipv6_ra_mode ? str(s.ipv6_ra_mode) : null],
        ["subnetpool_id", s.subnetpool_id ? plain("subnet_pool", s.subnetpool_id) : null],
        ["description", s.description ? str(s.description) : null],
      ]);
      for (const p of s.allocation_pools ?? []) body.push("", "allocation_pool {", `  start = ${str(p.start)}`, `  end   = ${str(p.end)}`, "}");
      if (s.host_routes?.length) {
        body.push("", `# ${s.host_routes.length} host route(s) not exported: use openstack_networking_subnet_route_v2.`);
        notes.push(`Subnet ${s.name || s.id}: host routes need openstack_networking_subnet_route_v2 (not exported).`);
      }
      block(T.subnet, nm.get(T.subnet, s.id)!, body, s.id);
    }
  }

  // ---- routers
  if (routers.length) section("Routers");
  for (const r of routers) {
    const rname = nm.get(T.router, r.id)!;
    const gw = r.external_gateway_info;
    const ext = gw ? ref(T.network, gw.network_id, netName(gw.network_id) ?? "external network") : null;
    const body = attrs([
      ["name", str(r.name)],
      ["description", r.description ? str(r.description) : null],
      ["admin_state_up", r.admin_state_up ? null : "false"],
      ["external_network_id", ext ? `${ext.expr}${ext.comment}` : null],
      ["enable_snat", gw && gw.enable_snat === false ? "false" : null],
    ]);
    if (gw?.external_fixed_ips?.length) body.push(`# external address: ${gw.external_fixed_ips.map((x) => x.ip_address).join(", ")}`);
    block(T.router, rname, body, r.id);
    // One interface per port (an IPv6 subnet can share the port of an IPv4 one): it's
    // declared with the port's first subnet and imported by the port ID.
    for (const p of input.ports.filter((x) => x.device_id === r.id && ROUTER_IF.has(x.device_owner))) {
      const [first, ...more] = p.fixed_ips;
      if (!first) continue;
      const sn = ref(T.subnet, first.subnet_id, subnetName(first.subnet_id) ?? first.ip_address);
      const body = attrs([
        ["router_id", `${T.router}.${rname}.id`],
        ["subnet_id", `${sn.expr}${sn.comment}`],
      ]);
      if (more.length) body.push(`# the same port also has ${more.map((x) => `${x.ip_address} (${subnetName(x.subnet_id) ?? x.subnet_id})`).join(", ")}`);
      block(T.routerIf, nm.name(T.routerIf, p.id, `${rname}_${subnetName(first.subnet_id) || first.ip_address.replace(/[.:]/g, "_")}`), body, p.id);
    }
  }

  // ---- volumes
  if (volumes.length) section("Volumes");
  for (const v of volumes) {
    const img = v.volume_image_metadata?.image_id;
    block(
      T.volume,
      nm.get(T.volume, v.id)!,
      attrs([
        ["name", v.name ? str(v.name) : null],
        ["size", String(v.size)],
        ["volume_type", v.volume_type ? str(v.volume_type) : null],
        ["availability_zone", v.availability_zone ? str(v.availability_zone) : null],
        ["description", v.description ? str(v.description) : null],
        ["image_id", img ? lookImage(img, v.volume_image_metadata?.image_name) : null],
        ["snapshot_id", v.snapshot_id ? plain("snapshot", v.snapshot_id) : null],
        ["source_vol_id", v.source_volid ? refText(T.volume, v.source_volid, "source volume") : null],
      ]),
      v.id,
      ["image_id", "snapshot_id", "source_vol_id"].filter((k) => (k === "image_id" ? img : k === "snapshot_id" ? v.snapshot_id : v.source_volid)),
      img && !literal ? ["image_id"] : undefined,
    );
  }

  // ---- instances
  const attachments: { server: Server; vol: string }[] = [];
  if (servers.length) section("Instances");
  for (const s of servers) {
    const sname = nm.get(T.server, s.id)!;
    const attached = (s["os-extended-volumes:volumes_attached"] ?? []).map((a) => a.id);
    const root = s.image ? null : bootVolume(s, input.volumes);
    for (const vid of attached) if (vid !== root?.id) attachments.push({ server: s, vol: vid });
    const sgNames = [...new Set((s.security_groups ?? []).map((g) => g.name))];
    const sgExprs = sgNames.map((n) => {
      const g = secgroups.find((x) => x.name === n);
      return g ? `${T.secgroup}.${nm.get(T.secgroup, g.id)}.name` : str(n);
    });
    const key = s.key_name ? (keypairs.some((k) => k.name === s.key_name) ? `${T.keypair}.${nm.get(T.keypair, s.key_name)}.name` : str(s.key_name)) : null;
    const body = attrs([
      ["name", str(s.name)],
      ["flavor_name", s.flavor.original_name ? str(s.flavor.original_name) : null],
      ["flavor_id", !s.flavor.original_name && s.flavor.id ? plain("flavor", s.flavor.id) : null],
      ["image_id", s.image ? lookImage(s.image.id) : null],
      ["key_pair", key],
      ["availability_zone", s["OS-EXT-AZ:availability_zone"] ? str(s["OS-EXT-AZ:availability_zone"]) : null],
      ["security_groups", sgExprs.length ? list(sgExprs) : null],
      ["config_drive", s.config_drive === "True" || s.config_drive === "true" ? "true" : null],
      ["tags", s.tags?.length ? list(s.tags.map(str)) : null],
    ]);
    if (s.metadata && Object.keys(s.metadata).length) body.push("", `metadata = ${map(s.metadata).join("\n  ")}`);
    if (root) {
      const rv = ref(T.volume, root.id, root.name);
      body.push(
        "",
        "block_device {",
        `  uuid                  = ${rv.expr}${rv.comment}`,
        '  source_type           = "volume"',
        '  destination_type      = "volume"',
        "  boot_index            = 0",
        `  delete_on_termination = ${(s["os-extended-volumes:volumes_attached"] ?? []).find((a) => a.id === root.id)?.delete_on_termination ? "true" : "false"}`,
        "}",
      );
    } else if (!s.image) {
      body.push("", "# Boots from a volume that couldn't be identified: add a block_device for it.");
      notes.push(`${s.name}: boot volume not found; add its block_device by hand.`);
    }
    for (const n of serverNetworks(s, input)) {
      const net = ref(T.network, n.networkId, n.name);
      body.push("", "network {", `  uuid        = ${net.expr}${net.comment}`, ...(n.ip ? [`  fixed_ip_v4 = ${str(n.ip)}`] : []), "}");
    }
    // network: Nova may list the NICs in another order than here, and a changed network
    // block would replace the instance.
    block(
      T.server,
      sname,
      body,
      s.id,
      ["block_device", "user_data", "image_id", "image_name", "admin_pass", "config_drive", "network"].filter((k) => k !== "image_id" || !!s.image),
      s.image && !literal ? ["image_id"] : undefined,
    );
  }
  for (const { server, vol } of attachments) {
    const sname = nm.get(T.server, server.id)!;
    const v = input.volumes.find((x) => x.id === vol);
    const vr = ref(T.volume, vol, v?.name ?? vol);
    block(
      T.attach,
      nm.name(T.attach, `${server.id}/${vol}`, `${sname}_${v?.name || vol.slice(0, 8)}`),
      attrs([
        ["instance_id", `${T.server}.${sname}.id`],
        ["volume_id", `${vr.expr}${vr.comment}`],
      ]),
      `${server.id}/${vol}`,
    );
  }

  /**
   * port_id of a floating IP. Exported instance without imports: its network[n].port (the
   * port is created with it). Otherwise the port is looked up by its fixed IP on its network
   * (and by its instance when that is exported).
   */
  const fipPortExpr = (portId: string) => {
    const port = input.ports.find((p) => p.id === portId);
    const s = port && servers.find((x) => x.id === port.device_id);
    if (!opts.imports && s && port) {
      const idx = serverNetworks(s, input).findIndex((n) => n.networkId === port.network_id);
      if (idx >= 0) return `${T.server}.${nm.get(T.server, s.id)}.network[${idx}].port`;
    }
    const ip = port?.fixed_ips[0]?.ip_address;
    if (literal) return `${str(portId)}${port ? ` # ${s ? `${note(s.name)} ` : ""}${ip ?? ""}` : ""}`.trimEnd();
    if (!port || !ip) return variable("port", portId, ip);
    return `${data("openstack_networking_port_v2", portId, `port_${s?.name ?? ""}_${ip.replace(/[.:]/g, "_")}`, [
      ["network_id", netExpr(port.network_id)],
      ["fixed_ip", str(ip)],
      ["device_id", s ? `${T.server}.${nm.get(T.server, s.id)}.id` : null],
    ])}.id`;
  };

  // ---- floating IPs
  if (fips.length) section("Floating IPs");
  for (const f of fips) {
    const pool = netName(f.floating_network_id);
    if (!pool) notes.push(`Floating IP ${f.floating_ip_address}: external network ${f.floating_network_id} not visible; set its pool name.`);
    const portRef = f.port_id ? fipPortExpr(f.port_id) : null;
    block(
      T.fip,
      nm.get(T.fip, f.id)!,
      [
        ...attrs([
          ["pool", str(pool ?? f.floating_network_id)],
          ["description", f.description ? str(f.description) : null],
          ["port_id", portRef],
          ["dns_name", f.dns_name ? str(f.dns_name) : null],
          ["dns_domain", f.dns_name && f.dns_domain ? str(f.dns_domain) : null],
        ]),
        `# address: ${f.floating_ip_address}`,
      ],
      f.id,
    );
  }

  // ---- what the extensions export
  for (const e of exts) e.generate(gen, sel);

  if (!count) return { hcl: "", resources: 0, notes };
  if (looked.length) {
    // Right after the provider block: what the resources refer to but don't manage.
    out.splice(1, 0, "# --- Looked up, not managed here ----------------------------------------\n# Read at plan time by name; a variable stands in where the name isn't unique.", ...looked);
  }
  return { hcl: `${out.join("\n\n")}\n`, resources: count, notes };
}

function ruleName(group: string, r: SecurityGroupRule) {
  const proto = r.protocol ?? "any";
  const ports = r.port_range_min != null ? (r.port_range_max != null && r.port_range_max !== r.port_range_min ? `${r.port_range_min}_${r.port_range_max}` : `${r.port_range_min}`) : "";
  return [group, r.direction === "ingress" ? "in" : "out", r.ethertype === "IPv6" ? "v6" : "v4", proto, ports].filter(Boolean).join("_");
}

function ruleBody(r: SecurityGroupRule, g: SecurityGroup, ref: (type: string, id: string | null | undefined, label?: string | null) => { expr: string; comment: string }) {
  const self = ref(T.secgroup, g.id).expr;
  const remote = r.remote_group_id ? (r.remote_group_id === g.id ? { expr: self, comment: "" } : ref(T.secgroup, r.remote_group_id, "remote group")) : null;
  const pairs: [string, string | null][] = [
    ["direction", str(r.direction)],
    ["ethertype", str(r.ethertype)],
    ["protocol", r.protocol ? str(r.protocol) : null],
    ["port_range_min", r.port_range_min != null ? String(r.port_range_min) : null],
    ["port_range_max", r.port_range_max != null ? String(r.port_range_max) : null],
    ["remote_ip_prefix", r.remote_ip_prefix ? str(r.remote_ip_prefix) : null],
    ["remote_group_id", remote ? `${remote.expr}${remote.comment}` : null],
    ["description", r.description ? str(r.description) : null],
    ["security_group_id", self],
  ];
  const keep = pairs.filter((p): p is [string, string] => !!p[1]);
  const w = Math.max(...keep.map(([k]) => k.length));
  return keep.map(([k, v]) => `${k.padEnd(w)} = ${v}`);
}

/** The volume an instance boots from (volume-backed instances have no image). */
function bootVolume(s: Server, volumes: Volume[]) {
  const ids = new Set((s["os-extended-volumes:volumes_attached"] ?? []).map((a) => a.id));
  const mine = volumes.filter((v) => ids.has(v.id));
  const dev = s["OS-EXT-SRV-ATTR:root_device_name"];
  const at = (v: Volume) => v.attachments.find((a) => a.server_id === s.id)?.device;
  return (
    (dev && mine.find((v) => at(v) === dev)) ||
    mine.find((v) => /^\/dev\/[sv]da$/.test(at(v) ?? "")) ||
    mine.find((v) => v.bootable === "true") ||
    null
  );
}

/** Networks of an instance in port order, with its fixed IPv4 on each. */
function serverNetworks(s: Server, input: TfInput) {
  const ports = input.ports.filter((p) => p.device_id === s.id);
  if (ports.length) {
    return ports.map((p) => ({
      networkId: p.network_id,
      name: input.networks.find((n) => n.id === p.network_id)?.name ?? p.network_id,
      ip: p.fixed_ips.find((x) => !x.ip_address.includes(":"))?.ip_address,
    }));
  }
  return Object.entries(s.addresses ?? {}).map(([name, addrs]) => ({
    networkId: input.networks.find((n) => n.name === name)?.id ?? name,
    name,
    ip: addrs.find((a) => a["OS-EXT-IPS:type"] !== "floating" && a.version === 4)?.addr,
  }));
}
