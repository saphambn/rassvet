# rassvet — next-gen OpenStack dashboard

Single-binary dashboard for OpenStack, written in Rust with an embedded React UI.
*Rassvet* (рассвет) means "dawn".

- **Backend**: Rust (axum + tokio + reqwest). Keystone tokens stay on the server; the browser gets an opaque HttpOnly session cookie.
- **Frontend**: React + TypeScript + Tailwind, built into `ui/dist` and embedded into the binary.
- **OpenStack**: targets 2026.2 (Hibiscus) APIs, oldest supported release 2026.1 (Gazpacho). Microversions are negotiated per cloud.
- **Core services**: Keystone, Glance, Nova, Placement, Neutron, Cinder, Barbican.
- **Extensions**: other services (Octavia load balancers, Magnum Kubernetes clusters, Designate DNS, DBaaS on Genestack database clusters, and Monitors: instance and physical server dashboards from Prometheus, defined in YAML) are compile-time extension crates under `extensions/`.

## Documentation

The user guide is in [`docs/`](docs/README.md): a feature overview, step-by-step guides for
project users ([`docs/project`](docs/project)) and for cloud administrators ([`docs/admin`](docs/admin)).

## Layout

```
crates/os-client     OpenStack client: Keystone, Glance, generic REST, catalog, microversions, API errors
crates/ext-api       Extension contract (Extension trait, NavItem, RequestContext, ApiError)
crates/server        rassvet binary: config, sessions, core API, embedded UI
extensions/octavia   Reference extension: Rust crate + ui/ (React pages)
extensions/magnum    Kubernetes clusters (Magnum): gateway, kubeconfig signing + ui/
extensions/designate DNS zones (Designate): gateway, zone file import / export + ui/
extensions/dbaas     Database clusters (DBaaS on Genestack): gateway + ui/
extensions/monitors  Monitors: dashboards from Prometheus; panels/default.yaml = built-in panels + ui/
ui/                  Host UI (Vite + React); `@rassvet/sdk` is the API exposed to extension UIs
```

## Build

Requirements: Rust 1.88+ (edition 2024), Node 22+, pnpm 10+.

```sh
cd ui && pnpm install && pnpm build && cd ..
cargo build --release
./target/release/rassvet --config rassvet.toml
```

Copy `rassvet.example.toml` to `rassvet.toml` and set your Keystone `auth_url`.

Build without an extension: `cargo build --release --no-default-features`.

### Sessions and memcached

By default login sessions live in the server's memory (a restart signs everyone out). Add a
`[memcached]` section to keep them in memcached instead, so they survive restarts and can be
shared by several Rassvet instances behind a load balancer:

```toml
[memcached]
servers = ["10.0.0.11:11211", "10.0.0.12:11211"]
key_prefix = "rassvet"
timeout_ms = 500
secret_key_file = "/etc/rassvet/session.key"   # or secret_key = "…" (≥ 16 chars, same on every instance)
```

- Sessions are encrypted with ChaCha20-Poly1305 when a secret key is set (they contain Keystone
  tokens); keys are a hash of the cookie, so neither appears in memcached. A key is required:
  without one Rassvet refuses to start, unless `allow_unencrypted = true` (plain JSON, not
  recommended).
- Memory stays the fallback: if memcached isn't configured, can't be reached at startup, or fails
  later (per-request timeout, then the server is skipped for 15 s), logins and requests keep
  working from memory. Sessions created meanwhile, or lost by a memcached restart, are written back
  once it answers again. Logging out leaves a short tombstone so other instances drop their copy.
- Sessions are deleted, from memory and from memcached, at the first of: no request for
  `session_idle_minutes` (default 60), `session_max_minutes` after login however active (default 720;
  0 = no limit), or the expiry of the Keystone token. The memcached TTL is set to exactly that
  deadline (the idle part is refreshed at most once a minute), and memory is swept every
  `session_cleanup_seconds` (default 60). An expired session found on a request is deleted at once.

### Several clouds in one session

A session can be signed in to several `[[cloud]]`s at once: the UI's cloud menu signs in to another one
(`POST /api/session/clouds`) and switches between them without signing in again. Each request names its
cloud in the `X-Rassvet-Cloud` header (downloads: `?rassvet_cloud=`), so every browser tab can work on its
own cloud; requests without it use the cloud chosen last. Each cloud keeps its own Keystone tokens: when one
expires only that cloud is signed out, and the session lasts until its last token expires (or the idle and
maximum limits above). Cloud `id`s must be letters, digits, `-`, `_` or `.`. Sessions stored in memcached by
older versions are still read after an upgrade.

### Security

- Run behind HTTPS and set `[server] secure_cookies = true`: the session cookie becomes
  `Secure` and responses carry `Strict-Transport-Security`. Rassvet warns at startup when it is
  off on a non-loopback address.
- The browser holds only an opaque, HttpOnly, SameSite=Strict session cookie; Keystone tokens
  stay on the server. Changes need the `X-Rassvet-CSRF` header and are refused when the
  browser reports a cross-site origin (`Sec-Fetch-Site`). API responses are `no-store`.
- Sign-in is throttled per account: after 10 failed attempts in 15 minutes the account's
  sign-ins are refused (429, `Retry-After`) until the window ends; a success resets it. Each
  instance counts on its own; Keystone's own lockout (`[security_compliance]`) still applies.
- OpenStack calls follow redirects only within the same origin and pagination links only on
  the same endpoint, so the token is never sent to another host.
- Object downloads are attachments with `Content-Security-Policy: sandbox`; Swift object
  names with `.` / `..` segments are refused (they would address another path).
- Image import from a URL (`web-download`) is fetched by Glance, not Rassvet: restrict it in
  glance-api.conf (`[import_filtering_opts]` allowed schemes, hosts and ports) so users can't
  reach internal addresses.

### Menus follow the cloud's policy

Some menu entries are only shown when the cloud's policy lets the user use them: Rassvet asks the
service once (e.g. `GET groups/detail?limit=1` for Volume groups / Group snapshots) and hides the
entry on 401, 403 or 404. Results are kept for 10 minutes per user, project and region.

### Logs and request ids

`[log]` sets the level (`info`, `debug`… or a full filter; `RUST_LOG` overrides it), the format
(`text` or `json`), standard output and an optional `file` that rotates `hourly`, `daily` or by
size (`rotation = "size"`, `max_size_mb`), keeping `max_files` rotated files
(`rassvet.log.2026-10-22T05-00-00`). With `rotation = "never"` an external logrotate can move
the file and send SIGHUP; Rassvet reopens it.

Every browser request gets an id like `req-6df3735c-…`: it is in every log line written while
the request runs, returned as the `X-Request-Id` header, and sent to OpenStack as
`X-OpenStack-Request-ID`, which oslo.middleware records as the **global_request_id** in Nova,
Neutron, Cinder… logs. Each OpenStack call is logged (`rassvet::openstack`) with the service,
method, path, status, time and the service's own request id (`upstream_request_id`, the
`x-openstack-request-id` / `x-compute-request-id` header), which is also returned in API errors:

```
INFO request{request_id=req-6df3…}: rassvet::openstack: OpenStack call service="compute" method=GET path="/compute/v2.1/servers/…" status=404 ms=3 upstream_request_id="req-6b79…"
INFO request{request_id=req-6df3…}: rassvet::http: request method=GET path="/api/os/compute/servers/…" status=404 ms=12
```

## Develop

```sh
cargo run -p rassvet -- -c rassvet.toml   # API on :8080
cd ui && pnpm dev                       # UI on :5173, proxies /api to :8080
cargo test && cargo clippy --all-targets
```

## Writing an extension

1. `extensions/<id>/Cargo.toml` + `src/lib.rs` implementing `rassvet_ext_api::Extension`
   (manifest with required `service_types`, nav items, axum routes mounted at `/api/ext/<id>`).
   Handlers take `RequestContext` to get the endpoint and an authenticated request builder.
2. `extensions/<id>/ui/index.tsx` default-exporting an `ExtensionUi` (routes mounted at `/ext/<id>/...`).
   Import shared components and the API client only from `@rassvet/sdk`.
3. Add the crate to the workspace, add an `ext-<id>` feature in `crates/server/Cargo.toml`,
   and register it in `crates/server/src/extensions.rs`.

An extension is shown only when all its service types have endpoints in the user's current region.

### Plugging into host features

Besides `routes`, an `ExtensionUi` can contribute to features the host owns. Each contribution lives in its
own file of the extension, so the host has no extension-specific code (see `extensions/magnum/ui/` for all
three):

```
extensions/<id>/ui/
  index.tsx       routes + the contributions below
  palette.ts      palette:   PaletteContribution    (command palette)
  terraform.ts    terraform: TerraformContribution  (Operations › Export to Terraform)
  cleanup.tsx     cleanup:   CleanupContribution    (Operations › Cleanup)
```

- **Command palette** — `keywords` (extra words that find the extension's pages), `actions` ("Create …"
  entries; `path` is relative to `/ext/<id>`) and `resources`: one `ResourceKind` per kind of resource, with
  `aliases` (for `<alias>:<name>` searches, e.g. `vol:db`), `get(id)` to find it by a pasted UUID, `search(q)` (the API filters names) or `list()` (cached, matched
  here), and `path(row, ctx)` to open it (`ctx.base` is `/ext/<id>` or `/admin/ext/<id>`). The host's own
  kinds are in `ui/src/lib/palette.ts`; a list page without a detail page can be opened on one row with
  `findPath(list, id)` (`?find=<id>`).
- **Export to Terraform** — `useSource({ projectId })` is a hook that loads the extension's resources and
  returns a `TfSource`: `sections` (the pickable lists; kinds named `<id>.<kind>`), `dependencies` (what a
  picked resource needs, core kinds included), `names` and `generate`, which write blocks with the `TfGen`
  helpers (`block`, `attrs`, `str`, `network`, `subnet`, `image`, `keypair`, `variable`…) so references to
  exported resources, lookups and import blocks work like the core ones.
- **Cleanup** — `useFindings(ctx)` is a hook returning `Finder`s (a card and the table it opens). The context
  carries the view (`admin`, `projectId`), the chosen age (`idle(...timestamps)`) and the helpers that make
  the tables look like the host's (`table`, `projectCol`, `ageCol`).

Contributions are optional; the host only calls those an available extension provides.
