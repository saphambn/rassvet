//! DBaaS on Genestack extension: MongoDB, MySQL and PostgreSQL clusters that run on the
//! undercloud Kubernetes (OpenEverest) and are reachable on the tenant's own Neutron network.
//!
//! Backend: an allowlisted gateway to the DBaaS v1 API at `/api/ext/dbaas/os/{*path}` (paths
//! are relative to `<endpoint>/v1/`, e.g. `clusters/<name>/backups`). The catalog service type
//! is `dbaas` (not `database`, which is Trove's). Clusters are addressed by name; the tenant API
//! is scoped to the token's project and dbaas-api checks roles itself (reader / member / admin).
//!
//! The admin API (`admin/...`, DBaaS Phase 8) lists every project's clusters, sets quotas, locks
//! projects, shows where a cluster runs and repairs it. dbaas-api only accepts a token of one of
//! its configured admin projects (or a system-scoped one) with an admin role; the rules here are
//! also admin-only in Rassvet. Admins act on a project's clusters on its behalf through
//! `admin/projects/{project}/clusters/...` (every cluster route except reading credentials).
//!
//! Phase 12 adds member restarts for the project (`members/{m}/restart`; admins may pass
//! `force=true`), PostgreSQL switchover (`switchover {target}`), the floating IP of a MySQL/PostgreSQL VIP and parameter changes kept for later.
//!
//! Query parameters (e.g. `range` of metrics, `member` / `tail` of logs) are passed through.
//! Request bodies must be JSON objects; dbaas-api validates their fields (unknown ones are
//! refused with 400).

use rassvet_ext_api::{
    ApiError, Extension, Manifest, NavItem, NavSection, RequestContext,
    axum::{
        Router,
        body::Bytes,
        extract::{Path, Query},
        http::{Method, StatusCode},
        response::Response,
        routing::any,
    },
    gateway::{self, Rule, Service, admin as a, rule as r},
};
use serde_json::Value;

pub struct Dbaas;

pub const ID: &str = "dbaas";

/// dbaas-api `/v1`; no microversions.
const SERVICE: Service = Service {
    service_type: "dbaas",
    version: "v1",
    microversion: None,
};

impl Extension for Dbaas {
    fn manifest(&self) -> Manifest {
        Manifest {
            id: ID,
            name: "Databases",
            version: env!("CARGO_PKG_VERSION"),
            description: "Manage DBaaS on Genestack database clusters (MongoDB, MySQL, PostgreSQL): endpoints, credentials, allowed networks, backups and restores, metrics, logs, events slow queries and engine parameters",
            service_types: &["dbaas"],
        }
    }

    fn nav(&self) -> Vec<NavItem> {
        let item = |id: &str, label: &str, path: &str, icon: &str, section: NavSection| NavItem {
            id: format!("{ID}.{id}"),
            group: "Database".into(),
            label: label.into(),
            path: path.into(),
            icon: icon.into(),
            section,
            role: (section == NavSection::Admin).then(|| "admin".into()),
        };
        vec![
            item(
                "clusters",
                "Database clusters",
                &format!("/ext/{ID}/clusters"),
                "database",
                NavSection::Project,
            ),
            item(
                "admin-clusters",
                "All database clusters",
                &format!("/admin/ext/{ID}/clusters"),
                "database",
                NavSection::Admin,
            ),
            item(
                "projects",
                "Database service",
                &format!("/admin/ext/{ID}/projects"),
                "sliders-horizontal",
                NavSection::Admin,
            ),
        ]
    }

    fn router(&self) -> Router {
        Router::new().route("/os/{*path}", any(handle))
    }
}

// ---------------------------------------------------------------------------- rules

use Method as M;

/// Every tenant route of dbaas-api `/v1` (`{id}` matches cluster names and backup ids).
static RULES: &[Rule] = &[
    // Catalog of what the cloud offers, and the project's quota
    r(M::GET, "engines"),
    r(M::GET, "flavors"),
    r(M::GET, "quota"),
    // Engine parameters a tenant may set, for a version and flavor (Phase 9)
    r(M::GET, "engines/{id}/parameters"),
    // Clusters
    r(M::GET, "clusters"),
    r(M::POST, "clusters"),
    r(M::GET, "clusters/{id}"),
    r(M::PATCH, "clusters/{id}"),
    r(M::DELETE, "clusters/{id}"),
    // Connecting: endpoints, the admin user (member / admin role), allowed source CIDRs
    r(M::GET, "clusters/{id}/endpoints"),
    // Phase 12: members (pods, no IPs) restarted one at a time; the floating IP of a MySQL/PostgreSQL VIP.
    r(M::GET, "clusters/{id}/members"),
    r(M::POST, "clusters/{id}/members/{id}/restart"),
    // Phase 12.5: hand the PostgreSQL primary role to a replica (Patroni).
    r(M::POST, "clusters/{id}/switchover"),
    r(M::GET, "clusters/{id}/floating-ip"),
    r(M::PUT, "clusters/{id}/floating-ip"),
    r(M::GET, "clusters/{id}/credentials"),
    r(M::GET, "clusters/{id}/allowed-cidrs"),
    r(M::PUT, "clusters/{id}/allowed-cidrs"),
    // Observing (Phase 7): metrics from the cloud's Prometheus (DBaaS builds every query, tenants
    // send no PromQL), Kubernetes events, member logs, the slow query threshold and MySQL's
    // busiest statements. Logs and top queries need the member / admin role (dbaas-api checks).
    r(M::GET, "clusters/{id}/metrics"),
    r(M::GET, "clusters/{id}/events"),
    r(M::GET, "clusters/{id}/logs"),
    r(M::GET, "clusters/{id}/slow-query-log"),
    r(M::PUT, "clusters/{id}/slow-query-log"),
    r(M::GET, "clusters/{id}/top-queries"),
    // Engine parameters (Phase 9): the effective settings and their source, changes (with a dry run),
    // the last revisions, whether they fit another version or flavor, and rollback
    r(M::GET, "clusters/{id}/parameters"),
    r(M::PATCH, "clusters/{id}/parameters"),
    r(M::GET, "clusters/{id}/parameters/history"),
    r(M::GET, "clusters/{id}/parameters/preflight"),
    r(M::POST, "clusters/{id}/parameters/rollback"),
    // Phase 12.3: a change kept for later (PATCH with apply "pending"), applied or discarded.
    r(M::POST, "clusters/{id}/parameters/apply"),
    r(M::DELETE, "clusters/{id}/parameters/pending"),
    // Backups, backup policy and restores
    r(M::GET, "clusters/{id}/backups"),
    r(M::POST, "clusters/{id}/backups"),
    r(M::GET, "clusters/{id}/backups/{id}"),
    r(M::DELETE, "clusters/{id}/backups/{id}"),
    r(M::GET, "clusters/{id}/backup-policy"),
    r(M::PUT, "clusters/{id}/backup-policy"),
    r(M::POST, "clusters/{id}/restore"),
    r(M::GET, "clusters/{id}/restores"),
    // ---- admin (Phase 8) ----
    // Projects known to DBaaS, their quota overrides and locks
    a(M::GET, "admin/projects"),
    a(M::GET, "admin/projects/{id}"),
    a(M::GET, "admin/projects/{id}/quota"),
    a(M::PUT, "admin/projects/{id}/quota"),
    a(M::DELETE, "admin/projects/{id}/quota"),
    a(M::PUT, "admin/projects/{id}/lock"),
    a(M::DELETE, "admin/projects/{id}/lock"),
    // Every project's clusters, where one runs, and the repairs only admins make
    a(M::GET, "admin/clusters"),
    // What admins may set (with the policy group); set on behalf of the project below
    a(M::GET, "admin/engines/{id}/parameters"),
    a(M::GET, "admin/projects/{id}/clusters/{id}/detail"),
    a(
        M::POST,
        "admin/projects/{id}/clusters/{id}/members/{id}/restart",
    ),
    a(
        M::POST,
        "admin/projects/{id}/clusters/{id}/ports/{id}/retry",
    ),
    a(M::POST, "admin/projects/{id}/clusters/{id}/force-delete"),
    // Write the flavor layer of a cluster created before DBaaS sized its configuration (rolling restart)
    a(M::POST, "admin/projects/{id}/clusters/{id}/apply-sizing"),
    // On behalf of a project: the tenant cluster routes, without creating clusters (the network
    // check needs the tenant's token) and reading credentials (left to the project's users)
    a(M::GET, "admin/projects/{id}/clusters"),
    a(M::GET, "admin/projects/{id}/clusters/{id}"),
    a(M::PATCH, "admin/projects/{id}/clusters/{id}"),
    a(M::DELETE, "admin/projects/{id}/clusters/{id}"),
    a(M::GET, "admin/projects/{id}/clusters/{id}/endpoints"),
    a(M::GET, "admin/projects/{id}/clusters/{id}/members"),
    a(M::POST, "admin/projects/{id}/clusters/{id}/switchover"),
    a(M::GET, "admin/projects/{id}/clusters/{id}/floating-ip"),
    a(M::PUT, "admin/projects/{id}/clusters/{id}/floating-ip"),
    a(M::GET, "admin/projects/{id}/clusters/{id}/allowed-cidrs"),
    a(M::PUT, "admin/projects/{id}/clusters/{id}/allowed-cidrs"),
    a(M::GET, "admin/projects/{id}/clusters/{id}/metrics"),
    a(M::GET, "admin/projects/{id}/clusters/{id}/events"),
    a(M::GET, "admin/projects/{id}/clusters/{id}/logs"),
    a(M::GET, "admin/projects/{id}/clusters/{id}/slow-query-log"),
    a(M::PUT, "admin/projects/{id}/clusters/{id}/slow-query-log"),
    a(M::GET, "admin/projects/{id}/clusters/{id}/top-queries"),
    a(M::GET, "admin/projects/{id}/clusters/{id}/parameters"),
    a(M::PATCH, "admin/projects/{id}/clusters/{id}/parameters"),
    a(
        M::GET,
        "admin/projects/{id}/clusters/{id}/parameters/history",
    ),
    a(
        M::GET,
        "admin/projects/{id}/clusters/{id}/parameters/preflight",
    ),
    a(
        M::POST,
        "admin/projects/{id}/clusters/{id}/parameters/rollback",
    ),
    a(
        M::POST,
        "admin/projects/{id}/clusters/{id}/parameters/apply",
    ),
    a(
        M::DELETE,
        "admin/projects/{id}/clusters/{id}/parameters/pending",
    ),
    a(M::GET, "admin/projects/{id}/clusters/{id}/backups"),
    a(M::POST, "admin/projects/{id}/clusters/{id}/backups"),
    a(M::GET, "admin/projects/{id}/clusters/{id}/backups/{id}"),
    a(M::DELETE, "admin/projects/{id}/clusters/{id}/backups/{id}"),
    a(M::GET, "admin/projects/{id}/clusters/{id}/backup-policy"),
    a(M::PUT, "admin/projects/{id}/clusters/{id}/backup-policy"),
    a(M::POST, "admin/projects/{id}/clusters/{id}/restore"),
    a(M::GET, "admin/projects/{id}/clusters/{id}/restores"),
];

/// A body, when there is one, must be a JSON object.
fn check_body(_: &Method, _: &str, body: &Value) -> Result<(), ApiError> {
    if body.is_object() {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "the body must be a JSON object",
        ))
    }
}

/// `/api/ext/dbaas/os/{*path}`
async fn handle(
    ctx: RequestContext,
    method: Method,
    Path(path): Path<String>,
    Query(raw): Query<Vec<(String, String)>>,
    body: Bytes,
) -> Result<Response, ApiError> {
    gateway::proxy(
        &ctx,
        &SERVICE,
        RULES,
        Some(check_body),
        method,
        &path,
        raw,
        body,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn find(method: &Method, path: &str) -> Option<&'static Rule> {
        gateway::find_rule(RULES, method, path)
    }

    #[test]
    fn allowlist() {
        assert!(find(&M::GET, "engines").is_some());
        assert!(find(&M::POST, "clusters").is_some());
        assert!(find(&M::PATCH, "clusters/orders-db").is_some());
        assert!(find(&M::GET, "clusters/orders-db/credentials").is_some());
        assert!(find(&M::PUT, "clusters/orders-db/allowed-cidrs").is_some());
        assert!(find(&M::DELETE, "clusters/orders-db/backups/orders-db-20261103").is_some());
        assert!(find(&M::POST, "clusters/orders-db/restore").is_some());
        assert!(find(&M::GET, "clusters/orders-db/metrics").is_some());
        assert!(find(&M::GET, "clusters/orders-db/logs").is_some());
        assert!(find(&M::PUT, "clusters/orders-db/slow-query-log").is_some());
        assert!(find(&M::GET, "clusters/orders-db/top-queries").is_some());
        assert!(find(&M::PUT, "clusters/orders-db/top-queries").is_none());
        assert!(find(&M::GET, "engines/postgresql/parameters").is_some());
        assert!(find(&M::PATCH, "clusters/orders-db/parameters").is_some());
        assert!(find(&M::PUT, "clusters/orders-db/parameters").is_none());
        assert!(find(&M::POST, "clusters/orders-db/parameters/rollback").is_some());
        assert!(find(&M::GET, "clusters/orders-db/parameters/preflight").is_some());
        assert!(find(&M::POST, "clusters/orders-db/parameters/apply").is_some());
        assert!(find(&M::DELETE, "clusters/orders-db/parameters/pending").is_some());
        assert!(find(&M::GET, "clusters/orders-db/members").is_some());
        assert!(
            find(
                &M::POST,
                "clusters/orders-db/members/orders-db-instance1-x5gl-0/restart"
            )
            .is_some()
        );
        assert!(
            find(
                &M::DELETE,
                "clusters/orders-db/members/orders-db-instance1-x5gl-0"
            )
            .is_none()
        );
        assert!(find(&M::PUT, "clusters/orders-db/floating-ip").is_some());
        assert!(find(&M::POST, "clusters/orders-db/switchover").is_some());
        assert!(find(&M::GET, "clusters/orders-db/switchover").is_none());
        assert!(find(&M::DELETE, "clusters/orders-db/floating-ip").is_none());
        // The tenant API is open to the project's users, the admin API to Rassvet admins only.
        assert!(
            RULES
                .iter()
                .all(|r| r.admin == r.path.starts_with("admin/"))
        );
        assert!(find(&M::PUT, "clusters/orders-db").is_none());
        assert!(find(&M::POST, "clusters/orders-db/credentials").is_none());
        assert!(find(&M::GET, "clusters/../quota").is_none());
        assert!(find(&M::GET, "clusters/a/b/c/d").is_none());
        assert!(find(&M::GET, "healthz").is_none());
    }

    #[test]
    fn admin_allowlist() {
        let p = "admin/projects/a96f5b3f61c14c2181ab92d068ec1785";
        assert!(find(&M::GET, "admin/projects").is_some());
        assert!(find(&M::PUT, &format!("{p}/quota")).is_some());
        assert!(find(&M::DELETE, &format!("{p}/lock")).is_some());
        assert!(find(&M::GET, "admin/clusters").is_some());
        assert!(find(&M::GET, &format!("{p}/clusters/om2/detail")).is_some());
        assert!(
            find(
                &M::POST,
                &format!("{p}/clusters/om2/members/om2-rs0-0/restart")
            )
            .is_some()
        );
        assert!(find(&M::POST, &format!("{p}/clusters/om2/ports/om2-rs0-0/retry")).is_some());
        assert!(find(&M::POST, &format!("{p}/clusters/om2/force-delete")).is_some());
        assert!(find(&M::PATCH, &format!("{p}/clusters/om2")).is_some());
        assert!(find(&M::GET, &format!("{p}/clusters/om2/logs")).is_some());
        assert!(find(&M::PATCH, &format!("{p}/clusters/om2/parameters")).is_some());
        assert!(find(&M::POST, &format!("{p}/clusters/om2/apply-sizing")).is_some());
        assert!(find(&M::GET, &format!("{p}/clusters/om2/members")).is_some());
        assert!(find(&M::POST, &format!("{p}/clusters/om2/switchover")).is_some());
        assert!(find(&M::PUT, &format!("{p}/clusters/om2/floating-ip")).is_some());
        assert!(find(&M::POST, &format!("{p}/clusters/om2/parameters/apply")).is_some());
        assert!(find(&M::GET, "admin/engines/mysql/parameters").is_some());
        assert!(find(&M::GET, &format!("{p}/engines/mysql/parameters")).is_none());
        assert!(
            find(
                &M::DELETE,
                &format!("{p}/clusters/om2/backups/om2-20261103")
            )
            .is_some()
        );
        // Left to the project's own users
        assert!(find(&M::POST, &format!("{p}/clusters")).is_none());
        assert!(find(&M::GET, &format!("{p}/clusters/om2/credentials")).is_none());
        assert!(find(&M::GET, &format!("{p}/engines")).is_none());
        assert!(find(&M::POST, &format!("{p}/clusters/om2/detail")).is_none());
        assert!(find(&M::GET, "admin/projects/../quota").is_none());
    }

    #[test]
    fn urls() {
        assert_eq!(
            SERVICE.base_url("https://dbaas.example.com"),
            "https://dbaas.example.com/v1"
        );
        assert_eq!(
            SERVICE.base_url("https://dbaas.example.com/v1/"),
            "https://dbaas.example.com/v1"
        );
        assert_eq!(SERVICE.base_url("https://h/dbaas/"), "https://h/dbaas/v1");
    }

    #[test]
    fn bodies() {
        assert!(check_body(&M::POST, "clusters", &json!({"name": "a"})).is_ok());
        assert!(
            check_body(
                &M::PUT,
                "clusters/a/allowed-cidrs",
                &json!({"allowed_cidrs": []})
            )
            .is_ok()
        );
        assert!(check_body(&M::PATCH, "clusters/a", &json!([{"op": "replace"}])).is_err());
        assert!(check_body(&M::POST, "clusters", &json!("x")).is_err());
    }
}
