//! Folder watch: upload stacked images as they appear, once they have
//! stopped changing.
//!
//! Stacking software (and SMB copies) write a file over seconds to
//! minutes, so a path is only uploaded after it has gone `settle` seconds
//! with no further events and an unchanged size. inotify does not fire
//! for writes made by another host on an SMB/NFS mount, so `--poll`
//! switches to notify's polling backend.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use notify::{Config, Event, EventKind, PollWatcher, RecommendedWatcher, RecursiveMode, Watcher};

use crate::client::Client;
use crate::ledger::Ledger;
use crate::select;
use crate::upload::{self, Status};
use crate::UploadOpts;

pub struct Settings {
    pub settle_secs: u64,
    pub initial_sweep: bool,
    pub poll_secs: Option<u64>,
}

struct Pending {
    last_event: Instant,
    last_size: u64,
}

enum AnyWatcher {
    Native(RecommendedWatcher),
    Poll(PollWatcher),
}

pub fn run(
    client: &Client,
    mut ledger: Ledger,
    dir: &Path,
    opts: &UploadOpts,
    settings: Settings,
) -> Result<()> {
    if !dir.is_dir() {
        anyhow::bail!("{} is not a directory", dir.display());
    }
    let dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());

    if settings.initial_sweep {
        let existing = select::walk(&dir, true, opts.all)?;
        if existing.is_empty() {
            println!("initial sweep: nothing new under {}", dir.display());
        } else {
            println!(
                "initial sweep: {} candidate(s) under {}",
                existing.len(),
                dir.display()
            );
            let outcome = upload::upload_all(client, &mut ledger, &existing, opts);
            outcome.print_summary();
        }
    }

    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = match settings.poll_secs {
        Some(secs) => {
            let config = Config::default().with_poll_interval(Duration::from_secs(secs.max(1)));
            AnyWatcher::Poll(PollWatcher::new(tx, config).context("creating poll watcher")?)
        }
        None => AnyWatcher::Native(
            RecommendedWatcher::new(tx, Config::default()).context("creating watcher")?,
        ),
    };
    match &mut watcher {
        AnyWatcher::Native(w) => w.watch(&dir, RecursiveMode::Recursive),
        AnyWatcher::Poll(w) => w.watch(&dir, RecursiveMode::Recursive),
    }
    .with_context(|| format!("watching {}", dir.display()))?;

    println!(
        "watching {} (settle {}s{}; Ctrl-C to stop)",
        dir.display(),
        settings.settle_secs,
        match settings.poll_secs {
            Some(s) => format!(", polling every {s}s"),
            None => String::new(),
        }
    );

    let settle = Duration::from_secs(settings.settle_secs);
    let mut pending: HashMap<PathBuf, Pending> = HashMap::new();
    loop {
        match rx.recv_timeout(Duration::from_secs(1)) {
            Ok(Ok(event)) => {
                if matches!(event.kind, EventKind::Remove(_) | EventKind::Access(_)) {
                    for path in &event.paths {
                        if matches!(event.kind, EventKind::Remove(_)) {
                            pending.remove(path);
                        }
                    }
                    continue;
                }
                for path in event.paths {
                    if path.is_file() && select::wanted(&path, opts.all) {
                        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                        pending.insert(
                            path,
                            Pending {
                                last_event: Instant::now(),
                                last_size: size,
                            },
                        );
                    }
                }
            }
            Ok(Err(e)) => eprintln!("watch error: {e}"),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => anyhow::bail!("watcher stopped"),
        }

        let now = Instant::now();
        let ready: Vec<PathBuf> = pending
            .iter_mut()
            .filter_map(|(path, p)| {
                if now.duration_since(p.last_event) < settle {
                    return None;
                }
                let size = match std::fs::metadata(path) {
                    Ok(m) => m.len(),
                    Err(_) => return Some(path.clone()), // vanished; drop below
                };
                if size != p.last_size {
                    // Still growing: restart the clock.
                    p.last_size = size;
                    p.last_event = now;
                    return None;
                }
                Some(path.clone())
            })
            .collect();

        for path in ready {
            pending.remove(&path);
            if !path.is_file() {
                continue;
            }
            // A file that settled with the same stamp we already sent is
            // a no-op through the ledger; anything else goes up.
            match upload::upload_one(client, &mut ledger, &path, opts) {
                Ok(Status::Uploaded) | Ok(Status::Reused) | Ok(Status::Skipped) => {}
                Err(e) => eprintln!("! {}  {e:#}", path.display()),
            }
        }
    }
}
