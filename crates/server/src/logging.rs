//! Logging: level / format from `[log]` in rassvet.toml, to stdout and/or a file that
//! rotates by time or size and keeps a bounded number of old files. `RUST_LOG` overrides
//! the level. SIGHUP reopens the file (for an external logrotate with `rotation = "never"`).
//!
//! Every browser request gets an id (`req-<uuid>`): it is logged with the request, returned
//! as `X-Request-Id`, and sent to OpenStack as `X-OpenStack-Request-ID` (see
//! `rassvet_os_client::trace`), whose own request ids are logged with each call.

use std::{
    fs::{self, File, OpenOptions},
    io::{self, IsTerminal, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};

use anyhow::{Context, bail};
use axum::{
    extract::Request,
    http::{HeaderValue, header::HeaderName},
    middleware::Next,
    response::Response,
};
use chrono::{DateTime, Utc};
use rassvet_os_client::trace;
use serde::Deserialize;
use tracing::Instrument;
use tracing_subscriber::{
    EnvFilter, Layer, field::MakeExt, fmt::MakeWriter, fmt::format, layer::SubscriberExt,
    util::SubscriberInitExt,
};

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Text,
    Json,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Rotation {
    Never,
    Hourly,
    Daily,
    Size,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct LogConfig {
    /// `info`, `debug`… or a full filter such as `rassvet=debug,tower_http=warn`.
    pub level: String,
    pub format: Format,
    /// Also log to standard output.
    pub stdout: bool,
    /// Log file path; its directory is created if missing. Empty = no file.
    pub file: Option<PathBuf>,
    pub rotation: Rotation,
    /// With `rotation = "size"`: rotate when the file reaches this many MiB.
    pub max_size_mb: u64,
    /// Rotated files to keep (oldest deleted first); 0 = keep all.
    pub max_files: usize,
}

impl Default for LogConfig {
    fn default() -> Self {
        Self {
            level: "info".into(),
            format: Format::Text,
            stdout: true,
            file: None,
            rotation: Rotation::Daily,
            max_size_mb: 100,
            max_files: 14,
        }
    }
}

impl LogConfig {
    pub fn validate(&self) -> anyhow::Result<()> {
        if self.rotation == Rotation::Size && self.max_size_mb == 0 {
            bail!("[log] max_size_mb must be at least 1 with rotation = \"size\"");
        }
        if !self.stdout && self.file.is_none() {
            bail!("[log] needs stdout = true or a file");
        }
        filter(&self.level).map(|_| ())
    }
}

/// `info` → `rassvet*=info` for Rassvet's own crates and `warn` for libraries;
/// anything with `=` or `,` is used as given.
fn filter(level: &str) -> anyhow::Result<EnvFilter> {
    let spec = if level.contains('=') || level.contains(',') {
        level.to_owned()
    } else {
        format!(
            "warn,rassvet={level},rassvet_os_client={level},rassvet_ext_api={level},rassvet_ext_octavia={level},rassvet_ext_magnum={level},rassvet_ext_designate={level},rassvet_ext_monitors={level},rassvet_ext_dbaas={level}"
        )
    };
    EnvFilter::try_new(&spec)
        .with_context(|| format!("[log] level \"{level}\" is not a valid filter"))
}

/// Install the global subscriber. Returns the file writer (if any) so SIGHUP can reopen it.
pub fn init(cfg: &LogConfig) -> anyhow::Result<Option<RollingFile>> {
    let env = match std::env::var("RUST_LOG") {
        Ok(v) if !v.is_empty() => EnvFilter::try_new(v).context("RUST_LOG")?,
        _ => filter(&cfg.level)?,
    };
    let file = cfg
        .file
        .as_deref()
        .map(|p| RollingFile::open(p, cfg.rotation, cfg.max_size_mb, cfg.max_files))
        .transpose()?;

    let mut layers: Vec<Box<dyn Layer<_> + Send + Sync>> = Vec::new();
    if cfg.stdout {
        // Colours only on a terminal (not in journald / docker logs).
        let l = tracing_subscriber::fmt::layer()
            .with_ansi(io::stdout().is_terminal())
            .with_writer(io::stdout);
        layers.push(match cfg.format {
            Format::Json => l.json().flatten_event(true).boxed(),
            Format::Text => l.boxed(),
        });
    }
    if let Some(f) = &file {
        let l = tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(f.clone());
        layers.push(match cfg.format {
            Format::Json => l.json().flatten_event(true).boxed(),
            // Own field formatter type: span fields are cached per formatter type, and the
            // stdout layer's copy may contain colour codes.
            Format::Text => l
                .fmt_fields(
                    format::debug_fn(|w, field, value| {
                        if field.name() == "message" {
                            write!(w, "{value:?}")
                        } else {
                            write!(w, "{field}={value:?}")
                        }
                    })
                    .delimited(" "),
                )
                .boxed(),
        });
    }
    tracing_subscriber::registry().with(layers).with(env).init();
    Ok(file)
}

/// Reopen the log file on SIGHUP (Unix), e.g. after logrotate moved it.
pub fn reopen_on_sighup(file: RollingFile) {
    #[cfg(unix)]
    tokio::spawn(async move {
        let Ok(mut hup) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())
        else {
            return;
        };
        while hup.recv().await.is_some() {
            match file.reopen() {
                Ok(()) => tracing::info!("log file reopened (SIGHUP)"),
                Err(e) => eprintln!("rassvet: reopening log file failed: {e}"),
            }
        }
    });
    #[cfg(not(unix))]
    let _ = file;
}

// ---------------------------------------------------------------------------- rolling file

/// A log file that rotates by hour / day / size: the current file keeps its configured name
/// and rotated ones get a timestamp suffix (`rassvet.log.2026-10-22T05-00-00`).
#[derive(Clone)]
pub struct RollingFile(Arc<Mutex<Inner>>);

struct Inner {
    path: PathBuf,
    rotation: Rotation,
    max_bytes: u64,
    max_files: usize,
    file: File,
    size: u64,
    period: String,
}

fn period(rotation: Rotation, t: DateTime<Utc>) -> String {
    match rotation {
        Rotation::Hourly => t.format("%Y-%m-%dT%H").to_string(),
        Rotation::Daily => t.format("%Y-%m-%d").to_string(),
        Rotation::Never | Rotation::Size => String::new(),
    }
}

fn open_append(path: &Path) -> io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

impl RollingFile {
    pub fn open(
        path: &Path,
        rotation: Rotation,
        max_size_mb: u64,
        max_files: usize,
    ) -> anyhow::Result<Self> {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            fs::create_dir_all(dir)
                .with_context(|| format!("creating log directory {}", dir.display()))?;
        }
        let file =
            open_append(path).with_context(|| format!("opening log file {}", path.display()))?;
        let meta = file.metadata()?;
        // An existing file from an earlier period rotates at the first write.
        let modified: DateTime<Utc> = meta
            .modified()
            .map(Into::into)
            .unwrap_or_else(|_| Utc::now());
        Ok(Self(Arc::new(Mutex::new(Inner {
            path: path.to_owned(),
            rotation,
            max_bytes: max_size_mb.saturating_mul(1024 * 1024),
            max_files,
            size: meta.len(),
            period: period(rotation, modified),
            file,
        }))))
    }

    pub fn reopen(&self) -> io::Result<()> {
        let mut g = self.0.lock().unwrap_or_else(|e| e.into_inner());
        g.file = open_append(&g.path)?;
        g.size = g.file.metadata()?.len();
        Ok(())
    }
}

impl Inner {
    fn due(&self, now: DateTime<Utc>, incoming: usize) -> bool {
        match self.rotation {
            Rotation::Never => false,
            Rotation::Size => self.size > 0 && self.size + incoming as u64 > self.max_bytes,
            Rotation::Hourly | Rotation::Daily => period(self.rotation, now) != self.period,
        }
    }

    fn rotate(&mut self, now: DateTime<Utc>) -> io::Result<()> {
        self.file.flush()?;
        let stamp = now.format("%Y-%m-%dT%H-%M-%S");
        let mut target = PathBuf::from(format!("{}.{stamp}", self.path.display()));
        let mut n = 1;
        while target.exists() {
            target = PathBuf::from(format!("{}.{stamp}.{n}", self.path.display()));
            n += 1;
        }
        fs::rename(&self.path, &target)?;
        self.file = open_append(&self.path)?;
        self.size = 0;
        self.period = period(self.rotation, now);
        self.prune();
        Ok(())
    }

    /// Delete the oldest rotated files beyond `max_files`.
    fn prune(&self) {
        if self.max_files == 0 {
            return;
        }
        let Some(name) = self.path.file_name().and_then(|n| n.to_str()) else {
            return;
        };
        let dir = self
            .path
            .parent()
            .filter(|d| !d.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let prefix = format!("{name}.");
        let Ok(rd) = fs::read_dir(dir) else { return };
        let mut old: Vec<PathBuf> = rd
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .is_some_and(|n| n.starts_with(&prefix))
            })
            .map(|e| e.path())
            .collect();
        old.sort(); // timestamp suffixes sort chronologically
        let extra = old.len().saturating_sub(self.max_files);
        for p in &old[..extra] {
            let _ = fs::remove_file(p);
        }
    }
}

impl Write for RollingFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut g = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let now = Utc::now();
        if g.due(now, buf.len())
            && let Err(e) = g.rotate(now)
        {
            eprintln!("rassvet: log rotation failed: {e}");
        }
        g.file.write_all(buf)?;
        g.size += buf.len() as u64;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .file
            .flush()
    }
}

impl<'a> MakeWriter<'a> for RollingFile {
    type Writer = RollingFile;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

// ---------------------------------------------------------------------------- requests

static X_REQUEST_ID: HeaderName = HeaderName::from_static("x-request-id");

/// Give each request an id, log it once done (method, path, status, time) and run it with
/// the id as the OpenStack global request id.
pub async fn request_layer(req: Request, next: Next) -> Response {
    let id = trace::new_request_id();
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    let quiet = path == "/healthz" || !path.starts_with("/api/");
    let span = tracing::info_span!("request", request_id = %id);
    let start = Instant::now();
    let mut res = trace::scope(id.clone(), next.run(req).instrument(span.clone())).await;
    let ms = start.elapsed().as_millis() as u64;
    let status = res.status().as_u16();
    let _e = span.enter();
    if status >= 500 {
        tracing::error!(target: "rassvet::http", %method, path, status, ms, "request");
    } else if quiet {
        tracing::debug!(target: "rassvet::http", %method, path, status, ms, "request");
    } else {
        tracing::info!(target: "rassvet::http", %method, path, status, ms, "request");
    }
    if let Ok(v) = HeaderValue::from_str(&id) {
        res.headers_mut().insert(X_REQUEST_ID.clone(), v);
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("rassvet-log-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d.join("rassvet.log")
    }

    fn rotated(p: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(p.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| n.starts_with("rassvet.log."))
            .collect();
        v.sort();
        v
    }

    #[test]
    fn rotates_by_size_and_keeps_max_files() {
        let p = tmp("size");
        let mut f = RollingFile::open(&p, Rotation::Size, 1, 2).unwrap();
        let line = vec![b'x'; 400 * 1024];
        for _ in 0..12 {
            f.write_all(&line).unwrap();
        }
        assert!(fs::metadata(&p).unwrap().len() <= 1024 * 1024);
        assert_eq!(
            rotated(&p).len(),
            2,
            "only max_files rotated files are kept"
        );
    }

    #[test]
    fn rotates_when_the_day_changes() {
        let p = tmp("daily");
        let f = RollingFile::open(&p, Rotation::Daily, 0, 0).unwrap();
        f.0.lock().unwrap().period = "2000-01-01".into();
        let mut w = f.clone();
        w.write_all(b"hello\n").unwrap();
        assert_eq!(rotated(&p).len(), 1);
        assert_eq!(fs::read_to_string(&p).unwrap(), "hello\n");
    }

    #[test]
    fn level_shorthand_and_full_filters() {
        assert!(filter("debug").is_ok());
        assert!(filter("rassvet=debug,tower_http=warn").is_ok());
        assert!(
            LogConfig {
                rotation: Rotation::Size,
                max_size_mb: 0,
                ..Default::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            LogConfig {
                stdout: false,
                file: None,
                ..Default::default()
            }
            .validate()
            .is_err()
        );
    }
}
