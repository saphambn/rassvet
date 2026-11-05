//! The DBaaS gateway against a mocked dbaas-api.

use std::sync::Arc;

use rassvet_ext_api::{
    Extension, RequestContext,
    axum::{Extension as Ext, Router},
    os::{Catalog, Endpoint, IdName, Interface, ProjectRef, ServiceEntry, Token},
};
use rassvet_ext_dbaas::Dbaas;
use serde_json::{Value, json};
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{body_json, header, method, path},
};

/// Serve the extension's router for a session whose catalog points `dbaas` at `api`
/// (registered without the `/v1` suffix, as deploy/keystone/register-endpoint.sh does).
async fn serve(api: &MockServer) -> String {
    serve_with(api, &[]).await
}

async fn serve_with(api: &MockServer, roles: &[&str]) -> String {
    let token = Token {
        value: "tok".into(),
        expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
        user: ProjectRef {
            id: "u1".into(),
            name: "alice".into(),
            domain: None,
        },
        project: Some(ProjectRef {
            id: "p1".into(),
            name: "demo".into(),
            domain: None,
        }),
        domain: None,
        system: false,
        roles: roles
            .iter()
            .map(|r| IdName {
                id: format!("r-{r}"),
                name: (*r).into(),
            })
            .collect(),
        methods: vec!["password".into()],
        catalog: Catalog(vec![ServiceEntry {
            service_type: "dbaas".into(),
            name: Some("dbaas".into()),
            endpoints: vec![Endpoint {
                interface: "public".into(),
                region_id: Some("RegionOne".into()),
                region: Some("RegionOne".into()),
                url: api.uri(),
            }],
        }]),
    };
    let ctx = RequestContext {
        cloud_id: "c".into(),
        auth_url: "http://keystone/v3".into(),
        http: reqwest::Client::new(),
        token: Arc::new(token),
        region: Some("RegionOne".into()),
        interface: Interface::Public,
    };
    let app = Router::new().merge(Dbaas.router()).layer(Ext(ctx));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { rassvet_ext_api::axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

#[tokio::test]
async fn forwards_with_the_token() {
    let api = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/clusters"))
        .and(header("X-Auth-Token", "tok"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({"clusters": [{"name": "orders", "engine": "mysql", "status": "ready"}]}),
        ))
        .mount(&api)
        .await;
    Mock::given(method("PUT"))
        .and(path("/v1/clusters/orders/allowed-cidrs"))
        .and(body_json(json!({"allowed_cidrs": ["10.1.0.0/24"]})))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"allowed_cidrs": ["10.1.0.0/24"]})),
        )
        .mount(&api)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/v1/clusters/orders"))
        .respond_with(ResponseTemplate::new(202))
        .mount(&api)
        .await;
    let base = serve(&api).await;
    let http = reqwest::Client::new();

    let got: Value = http
        .get(format!("{base}/os/clusters?all_pages=1"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(got["clusters"][0]["name"], "orders");

    let r = http
        .put(format!("{base}/os/clusters/orders/allowed-cidrs"))
        .json(&json!({"allowed_cidrs": ["10.1.0.0/24"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);

    let r = http
        .delete(format!("{base}/os/clusters/orders"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 202);
}

#[tokio::test]
async fn passes_errors_through() {
    let api = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/clusters"))
        .respond_with(ResponseTemplate::new(403).set_body_json(
            json!({"error": {"code": 403, "title": "Forbidden", "message": "quota exceeded: clusters"}}),
        ))
        .mount(&api)
        .await;
    let base = serve(&api).await;
    let r = reqwest::Client::new()
        .post(format!("{base}/os/clusters"))
        .json(&json!({"name": "a"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    let body: Value = r.json().await.unwrap();
    assert_eq!(body["error"]["message"], "quota exceeded: clusters");
}

#[tokio::test]
async fn refuses_what_is_not_allowed() {
    let api = MockServer::start().await;
    let base = serve(&api).await;
    let http = reqwest::Client::new();
    let r = http.get(format!("{base}/os/healthz")).send().await.unwrap();
    assert_eq!(r.status(), 404);
    let r = http
        .put(format!("{base}/os/clusters/a"))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);
    let r = http
        .patch(format!("{base}/os/clusters/a"))
        .json(&json!([{"op": "replace", "path": "/replicas", "value": 5}]))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);
    assert!(api.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn passes_query_parameters() {
    let api = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/clusters/orders/logs"))
        .and(wiremock::matchers::query_param("member", "orders-pxc-1"))
        .and(wiremock::matchers::query_param("tail", "500"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"lines": ["a"]})))
        .mount(&api)
        .await;
    let base = serve(&api).await;
    let got: Value = reqwest::get(format!(
        "{base}/os/clusters/orders/logs?member=orders-pxc-1&tail=500"
    ))
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(got["lines"], json!(["a"]));
}

const P: &str = "a96f5b3f61c14c2181ab92d068ec1785";

#[tokio::test]
async fn admin_api_needs_the_admin_role() {
    let api = MockServer::start().await;
    let base = serve_with(&api, &["member"]).await;
    let r = reqwest::get(format!("{base}/os/admin/projects"))
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    let r = reqwest::Client::new()
        .put(format!("{base}/os/admin/projects/{P}/quota"))
        .json(&json!({"clusters": 6}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    assert!(api.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn admins_act_on_behalf_of_a_project() {
    let api = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/admin/clusters"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({"clusters": [{"name": "om2", "project_id": P, "status": "ready"}]}),
        ))
        .mount(&api)
        .await;
    Mock::given(method("PUT"))
        .and(path(format!("/v1/admin/projects/{P}/quota")))
        .and(body_json(json!({"clusters": 6, "cpu": 10.0})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"project_id": P})))
        .mount(&api)
        .await;
    Mock::given(method("POST"))
        .and(path(format!(
            "/v1/admin/projects/{P}/clusters/om2/force-delete"
        )))
        .and(body_json(json!({"network": true})))
        .respond_with(ResponseTemplate::new(202).set_body_json(json!({"action": "force-delete"})))
        .mount(&api)
        .await;
    let base = serve_with(&api, &["admin"]).await;
    let http = reqwest::Client::new();

    let got: Value = http
        .get(format!("{base}/os/admin/clusters?project={P}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(got["clusters"][0]["project_id"], P);

    let r = http
        .put(format!("{base}/os/admin/projects/{P}/quota"))
        .json(&json!({"clusters": 6, "cpu": 10.0}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);

    let r = http
        .post(format!(
            "{base}/os/admin/projects/{P}/clusters/om2/force-delete"
        ))
        .json(&json!({"network": true}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 202);

    // Credentials stay with the project's users.
    let r = http
        .get(format!(
            "{base}/os/admin/projects/{P}/clusters/om2/credentials"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);
}
