//! Compile-time extension registry. To add an extension:
//! 1. create `extensions/<name>` implementing `rassvet_ext_api::Extension`,
//! 2. add it to the workspace + a `ext-<name>` feature in crates/server/Cargo.toml,
//! 3. register it below.
//!
//! Extensions with settings get their `[cloud.extensions.<id>]` tables from the config here.

use std::sync::Arc;

use rassvet_ext_api::Extension;

use crate::config::Config;

#[allow(clippy::vec_init_then_push, unused_variables)]
pub fn registered(cfg: &Config) -> anyhow::Result<Vec<Arc<dyn Extension>>> {
    #[allow(unused_mut)]
    let mut v: Vec<Arc<dyn Extension>> = Vec::new();
    #[cfg(feature = "ext-octavia")]
    v.push(Arc::new(rassvet_ext_octavia::Octavia));
    #[cfg(feature = "ext-magnum")]
    v.push(Arc::new(rassvet_ext_magnum::Magnum));
    #[cfg(feature = "ext-designate")]
    v.push(Arc::new(rassvet_ext_designate::Designate));
    #[cfg(feature = "ext-monitors")]
    v.push(Arc::new(rassvet_ext_monitors::Monitors::from_settings(
        settings_of(cfg, rassvet_ext_monitors::ID),
    )?));
    #[cfg(feature = "ext-dbaas")]
    v.push(Arc::new(rassvet_ext_dbaas::Dbaas));

    for c in &cfg.clouds {
        for id in c.extensions.keys() {
            if !v.iter().any(|e| e.manifest().id == id) {
                tracing::warn!(
                    cloud = c.id,
                    extension = id,
                    "[cloud.extensions.{id}] is set but that extension isn't compiled in"
                );
            }
        }
    }
    Ok(v)
}

/// `(cloud id, settings)` of every cloud with a `[cloud.extensions.<id>]` table.
#[allow(dead_code)]
fn settings_of(cfg: &Config, id: &str) -> Vec<(String, toml::Value)> {
    cfg.clouds
        .iter()
        .filter_map(|c| c.extensions.get(id).map(|v| (c.id.clone(), v.clone())))
        .collect()
}
