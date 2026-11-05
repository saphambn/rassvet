use std::{collections::HashMap, sync::Arc};

use anyhow::Context;
use rassvet_ext_api::Extension;
use rassvet_os_client::Keystone;

use crate::{
    config::{CloudConfig, Config},
    session::{SessionLimits, SessionStore},
};

pub struct Cloud {
    pub cfg: CloudConfig,
    pub http: reqwest::Client,
    pub keystone: Keystone,
}

pub struct Inner {
    pub config: Config,
    /// Clouds in config order.
    pub clouds: Vec<Arc<Cloud>>,
    pub by_id: HashMap<String, Arc<Cloud>>,
    pub sessions: SessionStore,
    pub extensions: Vec<Arc<dyn Extension>>,
    /// Negotiated microversions per cloud/region/service.
    pub versions: crate::gateway::Versions,
    /// Results of nav policy probes: (cloud, region, user, project, path) → (allowed, when).
    pub probes: std::sync::Mutex<HashMap<String, (bool, std::time::Instant)>>,
    /// Failed sign-ins per account (brute-force protection).
    pub login_throttle: crate::throttle::LoginThrottle,
}

pub type AppState = Arc<Inner>;

pub fn build(config: Config, extensions: Vec<Arc<dyn Extension>>) -> anyhow::Result<AppState> {
    let mut clouds = Vec::new();
    for c in &config.clouds {
        let ca = match &c.ca_file {
            Some(p) => Some(std::fs::read(p).with_context(|| format!("reading CA file {p}"))?),
            None => None,
        };
        let http = rassvet_os_client::http_client_with(
            c.insecure_tls,
            ca.as_deref(),
            std::time::Duration::from_secs(c.pool_idle_timeout_secs),
        )
        .with_context(|| format!("HTTP client for cloud '{}'", c.id))?;
        clouds.push(Arc::new(Cloud {
            keystone: Keystone::new(http.clone(), &c.auth_url),
            http,
            cfg: c.clone(),
        }));
    }
    let by_id = clouds
        .iter()
        .map(|c| (c.cfg.id.clone(), c.clone()))
        .collect();
    let sessions = SessionStore::new(
        SessionLimits::from(&config.server),
        config.memcached.as_ref(),
    )?;
    sessions.spawn_reaper();
    Ok(Arc::new(Inner {
        config,
        clouds,
        by_id,
        sessions,
        extensions,
        versions: Default::default(),
        probes: Default::default(),
        login_throttle: Default::default(),
    }))
}
