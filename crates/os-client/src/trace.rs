//! Request correlation and logging of OpenStack calls.
//!
//! Each browser request handled by Rassvet gets an id like `req-<uuid>` ([`new_request_id`]),
//! kept in a task-local while the request runs ([`scope`]). Every OpenStack call made for it
//! sends that id as `X-OpenStack-Request-ID` — oslo.middleware records it as the
//! `global_request_id` in the services' logs — and logs one line with the service's own
//! request id (`x-openstack-request-id` / `x-compute-request-id`), status and duration, so
//! a Rassvet log line can be matched with Nova, Neutron, Cinder… logs.

use std::{error::Error as _, future::Future, time::Instant};

use reqwest::{Method, RequestBuilder, Response, header::HeaderMap};

use crate::error::{Result, check};

tokio::task_local! {
    static GLOBAL_ID: String;
}

/// A new id in the format oslo.middleware accepts as a global request id.
pub fn new_request_id() -> String {
    let mut b: [u8; 16] = rand::random();
    b[6] = (b[6] & 0x0f) | 0x40; // UUID v4
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "req-{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

/// Run `f` with `id` as the current request id.
pub async fn scope<F: Future>(id: String, f: F) -> F::Output {
    GLOBAL_ID.scope(id, f).await
}

/// The request id of the browser request being handled, if any.
pub fn current() -> Option<String> {
    GLOBAL_ID.try_with(Clone::clone).ok()
}

/// The service's own request id from a response.
pub fn upstream_id(h: &HeaderMap) -> Option<&str> {
    h.get("x-openstack-request-id")
        .or_else(|| h.get("x-compute-request-id"))
        .and_then(|v| v.to_str().ok())
}

/// Send an OpenStack request (with the global request id) and log it; no status check.
pub async fn exec(service: &str, rb: RequestBuilder) -> reqwest::Result<Response> {
    let rb = match current() {
        Some(id) => rb.header("X-OpenStack-Request-ID", id),
        None => rb,
    };
    let (client, req) = rb.build_split();
    let req = req?;
    let method = req.method().clone();
    let path = match req.url().query() {
        Some(q) => format!("{}?{q}", req.url().path()),
        None => req.url().path().to_owned(),
    };
    // A copy to send again if a pooled connection turns out to be closed (bodies are bytes, so
    // this only fails for streamed uploads, which are then not retried).
    let again = if idempotent(&method) {
        req.try_clone()
    } else {
        None
    };
    let start = Instant::now();
    let mut res = client.execute(req).await;
    if let (Err(e), Some(req)) = (&res, again)
        && stale_connection(e)
    {
        tracing::info!(target: "rassvet::openstack", service, %method, path, error = %chain(e), "connection closed by the server, sending again");
        res = client.execute(req).await;
    }
    let ms = start.elapsed().as_millis() as u64;
    match &res {
        Ok(r) => {
            let status = r.status().as_u16();
            let upstream = upstream_id(r.headers()).unwrap_or("-");
            if status >= 500 {
                tracing::warn!(target: "rassvet::openstack", service, %method, path, status, ms, upstream_request_id = upstream, "OpenStack call");
            } else {
                tracing::info!(target: "rassvet::openstack", service, %method, path, status, ms, upstream_request_id = upstream, "OpenStack call");
            }
        }
        Err(e) => {
            tracing::warn!(target: "rassvet::openstack", service, %method, path, ms, error = %chain(e), "OpenStack call failed");
        }
    }
    res
}

/// Methods that may be sent twice (RFC 9110 §9.2.2).
fn idempotent(m: &Method) -> bool {
    matches!(
        *m,
        Method::GET | Method::HEAD | Method::OPTIONS | Method::PUT | Method::DELETE
    )
}

/// The request failed on the connection itself, before any response: a pooled keep-alive
/// connection that the server (or a gateway in front of it) closed meanwhile. Timeouts and
/// errors that came with a response are not retried.
fn stale_connection(e: &reqwest::Error) -> bool {
    if e.is_timeout() || e.is_status() || e.is_body() || e.is_decode() || !e.is_request() {
        return false;
    }
    let mut src = e.source();
    while let Some(s) = src {
        if let Some(io) = s.downcast_ref::<std::io::Error>() {
            use std::io::ErrorKind::*;
            if matches!(
                io.kind(),
                ConnectionReset | ConnectionAborted | BrokenPipe | UnexpectedEof
            ) {
                return true;
            }
        }
        let t = s.to_string();
        if t.contains("connection closed before message completed")
            || t.contains("IncompleteMessage")
            || t.contains("connection reset")
        {
            return true;
        }
        src = s.source();
    }
    false
}

/// An error with its causes: reqwest's own message ("error sending request for url (…)") says
/// nothing of what went wrong.
fn chain(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        out.push_str(": ");
        out.push_str(&s.to_string());
        src = s.source();
    }
    out
}

/// [`exec`], then turn non-2xx into [`crate::Error::Api`].
pub async fn send(service: &str, rb: RequestBuilder) -> Result<Response> {
    check(service, exec(service, rb).await?).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_ids_look_like_oslo_ones() {
        let a = new_request_id();
        let b = new_request_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 40);
        assert!(a.starts_with("req-"));
        let parts: Vec<_> = a[4..].split('-').map(str::len).collect();
        assert_eq!(parts, [8, 4, 4, 4, 12]);
        assert_eq!(&a[18..19], "4");
    }

    /// A server that answers the first request of each connection, then closes the connection
    /// when the next request arrives on it: what a gateway closing idle connections looks like
    /// to a client that reuses one at the wrong moment.
    async fn closing_server() -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let conns = Arc::new(AtomicUsize::new(0));
        let n = conns.clone();
        tokio::spawn(async move {
            loop {
                let (mut s, _) = l.accept().await.unwrap();
                n.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    if s.read(&mut buf).await.unwrap_or(0) == 0 {
                        return;
                    }
                    let _ = s
                        .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok")
                        .await;
                    // The next request on this connection: close without answering.
                    let _ = s.read(&mut buf).await;
                });
            }
        });
        (format!("http://{addr}/"), conns)
    }

    #[tokio::test]
    async fn idempotent_requests_survive_a_closed_pooled_connection() {
        let (url, conns) = closing_server().await;
        let c = crate::http_client(false, None).unwrap();
        assert!(
            exec("test", c.get(&url))
                .await
                .unwrap()
                .status()
                .is_success()
        );
        // Reuses the pooled connection, which the server closes: sent again on a new one.
        let r = exec("test", c.get(&url)).await.expect("retried");
        assert!(r.status().is_success());
        assert_eq!(conns.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn posts_are_not_sent_twice() {
        let (url, _) = closing_server().await;
        let c = crate::http_client(false, None).unwrap();
        assert!(
            exec("test", c.post(&url).body("{}"))
                .await
                .unwrap()
                .status()
                .is_success()
        );
        let e = exec("test", c.post(&url).body("{}")).await.unwrap_err();
        assert!(stale_connection(&e), "{}", chain(&e));
    }

    #[tokio::test]
    async fn scope_sets_current() {
        assert_eq!(current(), None);
        let got = scope("req-x".into(), async { current() }).await;
        assert_eq!(got.as_deref(), Some("req-x"));
    }
}
