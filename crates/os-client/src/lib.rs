//! Minimal, typed OpenStack client used by the dashboard server and extensions.
//!
//! Target API baseline: OpenStack 2026.2 (Hibiscus), oldest supported: 2026.1 (Gazpacho).
//! Microversions are negotiated per cloud at runtime instead of being hardcoded per release.

pub mod auth;
pub mod catalog;
pub mod error;
pub mod identity;
pub mod image;
pub mod microversion;
pub mod rest;
pub mod trace;

pub use auth::{AuthMethod, IdName, Keystone, ProjectRef, Scope, Token};
pub use catalog::{Catalog, Endpoint, Interface, ServiceEntry};
pub use error::{Error, Result};
pub use identity::Identity;
pub use image::Glance;
pub use microversion::Microversion;
pub use rest::Rest;

/// Seconds an idle pooled connection is kept by default: reqwest's own default (90 s). A cloud
/// whose API gateway closes idle connections sooner needs a lower value; see [`http_client_with`].
pub const DEFAULT_POOL_IDLE_TIMEOUT_SECS: u64 = 90;

/// Build the shared HTTP client used for all OpenStack calls, with the default idle timeout.
pub fn http_client(insecure_tls: bool, ca_pem: Option<&[u8]>) -> Result<reqwest::Client> {
    http_client_with(
        insecure_tls,
        ca_pem,
        std::time::Duration::from_secs(DEFAULT_POOL_IDLE_TIMEOUT_SECS),
    )
}

/// Like [`http_client`], keeping idle connections for `pool_idle_timeout`. Keep it below the
/// idle timeout of the cloud's API gateway, e.g. 4 s behind Genestack's Envoy Gateway, which
/// closes connections idle for 5 s.
pub fn http_client_with(
    insecure_tls: bool,
    ca_pem: Option<&[u8]>,
    pool_idle_timeout: std::time::Duration,
) -> Result<reqwest::Client> {
    let mut b = reqwest::Client::builder()
        .user_agent(concat!("rassvet/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(10))
        // Idle connections must be dropped before the API gateway closes them: a request sent on
        // a connection being closed fails with "error sending request". Genestack's Envoy Gateway
        // closes client connections idle for 5 s (ClientTrafficPolicy idleTimeout), so a cloud
        // behind it sets `pool_idle_timeout_secs = 4` in its `[[cloud]]`; the default stays at
        // reqwest's 90 s. The retry in `trace::exec` covers the remaining race.
        .pool_idle_timeout(pool_idle_timeout)
        .timeout(std::time::Duration::from_secs(120))
        // Every request carries an X-Auth-Token header, which reqwest (unlike Authorization)
        // would forward on a redirect to another host. Follow redirects only within the same
        // origin, so a misconfigured or hostile endpoint can't collect the token.
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let same = attempt
                .previous()
                .first()
                .is_some_and(|first| same_origin(first, attempt.url()));
            if attempt.previous().len() >= 5 {
                attempt.error("too many redirects")
            } else if same {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .danger_accept_invalid_certs(insecure_tls);
    if let Some(pem) = ca_pem {
        for cert in reqwest::Certificate::from_pem_bundle(pem)? {
            b = b.add_root_certificate(cert);
        }
    }
    Ok(b.build()?)
}

/// Same scheme, host and port.
fn same_origin(a: &reqwest::Url, b: &reqwest::Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// A `next` link from a paginated response, joined to `root` only when it is a plain
/// absolute path (`/v2/images?marker=…`). Anything else (`//host`, `@host`, a full URL)
/// is refused, so a crafted link can't send the token to another server.
pub fn join_next(root: &str, next: &str) -> Option<String> {
    (next.starts_with('/') && !next.starts_with("//") && !next.contains('\\'))
        .then(|| format!("{root}{next}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_links_stay_on_the_endpoint() {
        assert_eq!(
            join_next("https://g:9292", "/v2/images?marker=a").as_deref(),
            Some("https://g:9292/v2/images?marker=a")
        );
        assert!(join_next("https://g:9292", "@evil.example/v2/images").is_none());
        assert!(join_next("https://g:9292", "//evil.example/v2").is_none());
        assert!(join_next("https://g:9292", "https://evil.example/v2").is_none());
        let a = reqwest::Url::parse("https://k:5000/v3").unwrap();
        assert!(!same_origin(
            &a,
            &reqwest::Url::parse("https://k/x").unwrap()
        ));
        assert!(same_origin(
            &a,
            &reqwest::Url::parse("https://k:5000/y").unwrap()
        ));
    }
}
