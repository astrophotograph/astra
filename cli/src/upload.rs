//! One file → one image: hash, register, send bytes if the server lacks
//! them, remember in the ledger.

use std::path::Path;

use anyhow::{Context, Result};

use crate::client::{Client, Register};
use crate::ledger::{self, Ledger};
use crate::UploadOpts;

/// Matches the daemon's default `max_asset_bytes` (1 GiB).
const MAX_ASSET_BYTES: u64 = 1 << 30;

#[derive(Debug, Default)]
pub struct Outcome {
    pub uploaded: usize,
    pub reused: usize,
    pub skipped: usize,
    pub failed: usize,
}

impl Outcome {
    pub fn print_summary(&self) {
        println!(
            "{} uploaded, {} already on server, {} skipped, {} failed",
            self.uploaded, self.reused, self.skipped, self.failed
        );
    }
}

pub fn hash_file(path: &Path) -> Result<String> {
    let mut file =
        std::fs::File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let mut hasher = blake3::Hasher::new();
    std::io::copy(&mut file, &mut hasher).with_context(|| format!("reading {}", path.display()))?;
    Ok(hasher.finalize().to_hex().to_string())
}

#[derive(Debug, PartialEq, Eq)]
pub enum Status {
    /// Bytes were sent and stored.
    Uploaded,
    /// The server already had this content (or the ledger did).
    Reused,
    /// Dry run, or not sent for a benign reason.
    Skipped,
}

/// Upload a single file. Prints one line per file.
pub fn upload_one(
    client: &Client,
    ledger: &mut Ledger,
    path: &Path,
    opts: &UploadOpts,
) -> Result<Status> {
    let display = path.display();
    let stamp = ledger::stamp(path)?;

    if !opts.force {
        if let Some(entry) = ledger.lookup(path, stamp) {
            println!("= {display}  (already uploaded as {})", entry.image_id);
            return Ok(Status::Reused);
        }
    }
    if stamp.size > MAX_ASSET_BYTES {
        anyhow::bail!(
            "{display}: {} bytes exceeds the 1 GiB asset limit",
            stamp.size
        );
    }
    if opts.dry_run {
        println!("? {display}  (would upload)");
        return Ok(Status::Skipped);
    }

    let hash = hash_file(path)?;
    let filename = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| display.to_string());
    let source_path = std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string();

    let registered = client.register(&Register {
        filename: &filename,
        content_hash: &hash,
        summary: opts.summary.as_deref(),
        description: opts.description.as_deref(),
        tags: opts.tags.as_deref(),
        visibility: opts.visibility.as_deref(),
        collection_id: opts.collection_id.as_deref(),
        collection_name: opts.collection.as_deref(),
        source_path: Some(&source_path),
    })?;

    let where_ = match (&registered.collection_id, registered.collection_created) {
        (Some(_), true) => format!(
            "  → new collection {}",
            opts.collection.as_deref().unwrap_or("?")
        ),
        (Some(_), false) if opts.collection.is_some() => {
            format!("  → {}", opts.collection.as_deref().unwrap_or("?"))
        }
        _ => String::new(),
    };

    let status = if registered.asset_status == "present" {
        println!(
            "= {display}  (server already has it: {}){where_}",
            registered.id
        );
        Status::Reused
    } else {
        let stored = client.put_asset(&registered.id, &hash, path)?;
        let kind = if registered.created {
            "new"
        } else {
            "existing"
        };
        println!(
            "+ {display}  ({} {kind} image {}){where_}",
            stored.status, registered.id
        );
        Status::Uploaded
    };
    ledger.record(path, stamp, &hash, &registered.id)?;
    Ok(status)
}

pub fn upload_all(
    client: &Client,
    ledger: &mut Ledger,
    files: &[std::path::PathBuf],
    opts: &UploadOpts,
) -> Outcome {
    let mut outcome = Outcome::default();
    for path in files {
        match upload_one(client, ledger, path, opts) {
            Ok(Status::Uploaded) => outcome.uploaded += 1,
            Ok(Status::Reused) => outcome.reused += 1,
            Ok(Status::Skipped) => outcome.skipped += 1,
            Err(e) => {
                eprintln!("! {}  {e:#}", path.display());
                outcome.failed += 1;
            }
        }
    }
    outcome
}
