use std::{net::SocketAddr, path::Path};

use anyhow::{Context, bail};
use rassvet_os_client::Interface;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    pub server: ServerConfig,
    /// Optional shared session store. Without it (or while it's unreachable) sessions live in memory.
    #[serde(default)]
    pub memcached: Option<MemcachedConfig>,
    /// Log level, format, file and rotation.
    #[serde(default)]
    pub log: crate::logging::LogConfig,
    #[serde(rename = "cloud")]
    pub clouds: Vec<CloudConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct ServerConfig {
    pub listen: SocketAddr,
    /// Idle timeout of a browser session, in minutes: deleted (memory and memcached) after
    /// this long without a request.
    pub session_idle_minutes: i64,
    /// Absolute lifetime of a session in minutes, however active it is; 0 = only the idle
    /// timeout and the Keystone token's expiry apply.
    pub session_max_minutes: i64,
    /// How often expired sessions are swept from memory, in seconds (memcached expires its
    /// copies by itself through their TTL).
    pub session_cleanup_seconds: u64,
    /// Set the `Secure` flag on the session cookie (enable behind HTTPS).
    pub secure_cookies: bool,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            listen: "0.0.0.0:8080".parse().unwrap(),
            session_idle_minutes: 60,
            session_max_minutes: 720,
            session_cleanup_seconds: 60,
            secure_cookies: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemcachedConfig {
    /// `host:port` of each memcached server; sessions are spread over them by key.
    pub servers: Vec<String>,
    /// Prefix of every key, so several dashboards can share one memcached.
    #[serde(default = "default_prefix")]
    pub key_prefix: String,
    /// Per-request timeout; a slower or dead server is skipped for 15 s.
    #[serde(default = "default_mc_timeout")]
    pub timeout_ms: u64,
    /// Encrypts sessions (ChaCha20-Poly1305) so Keystone tokens aren't readable in memcached.
    /// All Rassvet instances sharing the memcached need the same value.
    #[serde(default)]
    pub secret_key: Option<String>,
    /// Read `secret_key` from a file instead (first line).
    #[serde(default)]
    pub secret_key_file: Option<String>,
    /// Allow storing sessions (with their Keystone tokens) unencrypted when no secret key
    /// is set. Off by default: anyone who can read memcached could reuse the tokens.
    #[serde(default)]
    pub allow_unencrypted: bool,
}

fn default_prefix() -> String {
    "rassvet".into()
}

fn default_mc_timeout() -> u64 {
    500
}

impl MemcachedConfig {
    pub fn secret(&self) -> anyhow::Result<Option<String>> {
        if let Some(p) = &self.secret_key_file {
            let raw = std::fs::read_to_string(p)
                .with_context(|| format!("reading memcached secret_key_file {p}"))?;
            let key = raw.lines().next().unwrap_or("").trim().to_owned();
            if key.len() < 16 {
                bail!("memcached secret_key_file {p} must hold at least 16 characters");
            }
            return Ok(Some(key));
        }
        match &self.secret_key {
            Some(k) if k.len() < 16 => {
                bail!("[memcached] secret_key must be at least 16 characters")
            }
            Some(k) => Ok(Some(k.clone())),
            None => Ok(None),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CloudConfig {
    pub id: String,
    pub name: String,
    pub auth_url: String,
    /// Keystone URL written into downloaded `openrc` / `clouds.yaml` files. Defaults to the
    /// public identity endpoint from the catalog, then to `auth_url`.
    #[serde(default)]
    pub public_auth_url: Option<String>,
    #[serde(default = "default_domain")]
    pub default_domain: String,
    #[serde(default)]
    pub interface: Interface,
    /// Region to select after login; defaults to the first region in the catalog.
    #[serde(default)]
    pub default_region: Option<String>,
    #[serde(default)]
    pub insecure_tls: bool,
    #[serde(default)]
    pub ca_file: Option<String>,
    /// Seconds an idle connection to this cloud's APIs is kept for reuse (default 90, reqwest's
    /// own). Keep it below the idle timeout of the cloud's API gateway: 4 behind Genestack's
    /// Envoy Gateway, which closes connections idle for 5 s.
    #[serde(default = "default_pool_idle_timeout_secs")]
    pub pool_idle_timeout_secs: u64,
    /// Settings of compiled-in extensions for this cloud: `[cloud.extensions.<id>]` tables,
    /// read by each extension (e.g. `[cloud.extensions.monitors]` for its Prometheus).
    #[serde(default)]
    pub extensions: std::collections::BTreeMap<String, toml::Value>,
}

fn default_domain() -> String {
    "Default".into()
}

fn default_pool_idle_timeout_secs() -> u64 {
    rassvet_os_client::DEFAULT_POOL_IDLE_TIMEOUT_SECS
}

impl Config {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("reading config {}", path.display()))?;
        let cfg: Config =
            toml::from_str(&raw).with_context(|| format!("parsing config {}", path.display()))?;
        if cfg.clouds.is_empty() {
            bail!("config must define at least one [[cloud]]");
        }
        let mut ids: Vec<&str> = cfg.clouds.iter().map(|c| c.id.as_str()).collect();
        ids.sort();
        if ids.windows(2).any(|w| w[0] == w[1]) {
            bail!("duplicate [[cloud]] id");
        }
        // The UI names the cloud of each request in a header and in download links.
        if let Some(bad) = ids.iter().find(|id| {
            id.is_empty()
                || id.len() > 64
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        }) {
            bail!("[[cloud]] id {bad:?} must be 1-64 letters, digits, '-', '_' or '.'");
        }
        if let Some(c) = cfg
            .clouds
            .iter()
            .find(|c| !(1..=3600).contains(&c.pool_idle_timeout_secs))
        {
            bail!(
                "[[cloud]] {}: pool_idle_timeout_secs must be 1-3600 (seconds)",
                c.id
            );
        }
        if let Some(m) = &cfg.memcached {
            if m.key_prefix.is_empty()
                || m.key_prefix.len() > 64
                || !m.key_prefix.bytes().all(|b| b.is_ascii_graphic())
            {
                bail!(
                    "[memcached] key_prefix must be 1-64 visible ASCII characters without spaces"
                );
            }
            if m.servers.iter().any(|s| {
                s.rsplit_once(':')
                    .is_none_or(|(_, port)| port.parse::<u16>().is_err())
            }) {
                bail!("[memcached] servers must be host:port, e.g. \"127.0.0.1:11211\"");
            }
            if m.secret()?.is_none() && !m.allow_unencrypted {
                bail!(
                    "[memcached] needs secret_key or secret_key_file (sessions hold Keystone tokens); \
                     set allow_unencrypted = true to store them in plain text anyway"
                );
            }
        }
        cfg.log.validate()?;
        Ok(cfg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_example() {
        let cfg: Config = toml::from_str(include_str!("../../../rassvet.example.toml")).unwrap();
        assert_eq!(cfg.clouds[0].id, "lab");
        assert_eq!(cfg.server.session_idle_minutes, 60);
        assert_eq!(cfg.server.session_max_minutes, 720);
        assert_eq!(cfg.server.session_cleanup_seconds, 60);
        assert!(cfg.memcached.is_none());
        assert_eq!(cfg.log.max_files, 14);
        assert!(cfg.log.file.is_none());
        assert_eq!(cfg.clouds[0].pool_idle_timeout_secs, 90);
    }

    #[test]
    fn pool_idle_timeout_per_cloud() {
        let cloud = |extra: &str| {
            format!(
                "[[cloud]]\nid = \"lab\"\nname = \"Lab\"\nauth_url = \"http://keystone/v3\"\n{extra}"
            )
        };
        let load = |raw: String| {
            let path = std::env::temp_dir().join(format!(
                "rassvet-pool-{}-{}.toml",
                std::process::id(),
                raw.len()
            ));
            std::fs::write(&path, raw).unwrap();
            let r = Config::load(&path);
            let _ = std::fs::remove_file(&path);
            r
        };
        let cfg = load(cloud("")).unwrap();
        assert_eq!(cfg.clouds[0].pool_idle_timeout_secs, 90);
        let cfg = load(cloud("pool_idle_timeout_secs = 4")).unwrap();
        assert_eq!(cfg.clouds[0].pool_idle_timeout_secs, 4);
        let err = load(cloud("pool_idle_timeout_secs = 0")).unwrap_err();
        assert!(err.to_string().contains("pool_idle_timeout_secs"), "{err}");
    }

    #[test]
    fn parses_extension_settings() {
        let cfg: Config = toml::from_str(
            r#"
[[cloud]]
id = "lab"
name = "Lab"
auth_url = "http://keystone/v3"

[cloud.extensions.monitors]
prometheus_url = "http://prom:9090"
"#,
        )
        .unwrap();
        let m = &cfg.clouds[0].extensions["monitors"];
        assert_eq!(m["prometheus_url"].as_str(), Some("http://prom:9090"));
    }

    #[test]
    fn parses_memcached() {
        let cfg: Config = toml::from_str(
            r#"
            [memcached]
            servers = ["127.0.0.1:11211", "mc-2:11211"]
            secret_key = "0123456789abcdef-long-enough"
            [[cloud]]
            id = "a"
            name = "A"
            auth_url = "http://x/v3"
            "#,
        )
        .unwrap();
        let m = cfg.memcached.unwrap();
        assert_eq!(m.servers.len(), 2);
        assert_eq!(m.key_prefix, "rassvet");
        assert_eq!(m.timeout_ms, 500);
        assert!(m.secret().unwrap().is_some());
    }
}
