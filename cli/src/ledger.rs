//! Local record of what has been uploaded where, so a restarted watch or
//! a repeated `upload` of the same folder does not re-hash and re-send
//! files the server already has. Keyed by server + absolute path; a file
//! whose size or mtime changed is treated as new (the server then dedups
//! by content anyway).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Entry {
    pub size: u64,
    pub mtime: u64,
    pub hash: String,
    pub image_id: String,
    pub uploaded_at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct File {
    #[serde(default)]
    uploads: BTreeMap<String, Entry>,
}

pub struct Ledger {
    path: PathBuf,
    server: String,
    data: File,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stamp {
    pub size: u64,
    pub mtime: u64,
}

pub fn stamp(path: &Path) -> Result<Stamp> {
    let meta = std::fs::metadata(path).with_context(|| format!("stat {}", path.display()))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(Stamp {
        size: meta.len(),
        mtime,
    })
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn default_path() -> PathBuf {
    dirs::state_dir()
        .or_else(dirs::data_local_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("astra-cli")
        .join("ledger.json")
}

impl Ledger {
    pub fn open(server: &str) -> Result<Self> {
        Self::open_at(&default_path(), server)
    }

    pub fn open_at(path: &Path, server: &str) -> Result<Self> {
        let data = if path.exists() {
            let text = std::fs::read_to_string(path)
                .with_context(|| format!("reading {}", path.display()))?;
            serde_json::from_str(&text).unwrap_or_else(|e| {
                eprintln!(
                    "warning: ledger {} is unreadable ({e}); starting fresh",
                    path.display()
                );
                File::default()
            })
        } else {
            File::default()
        };
        Ok(Self {
            path: path.to_path_buf(),
            server: server.to_string(),
            data,
        })
    }

    fn key(&self, path: &Path) -> String {
        let abs = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        format!("{}|{}", self.server, abs.display())
    }

    /// The recorded upload of this exact (size, mtime) of the file.
    pub fn lookup(&self, path: &Path, stamp: Stamp) -> Option<&Entry> {
        self.data
            .uploads
            .get(&self.key(path))
            .filter(|e| e.size == stamp.size && e.mtime == stamp.mtime)
    }

    pub fn record(&mut self, path: &Path, stamp: Stamp, hash: &str, image_id: &str) -> Result<()> {
        let key = self.key(path);
        self.data.uploads.insert(
            key,
            Entry {
                size: stamp.size,
                mtime: stamp.mtime,
                hash: hash.to_string(),
                image_id: image_id.to_string(),
                uploaded_at: now(),
            },
        );
        self.flush()
    }

    fn flush(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        let text = serde_json::to_string_pretty(&self.data)?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, text).with_context(|| format!("writing {}", tmp.display()))?;
        std::fs::rename(&tmp, &self.path)
            .with_context(|| format!("replacing {}", self.path.display()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remembers_by_size_and_mtime_per_server() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("Stack_1.fit");
        std::fs::write(&file, b"abc").unwrap();
        let ledger_path = dir.path().join("state/ledger.json");

        let mut ledger = Ledger::open_at(&ledger_path, "https://a").unwrap();
        let st = stamp(&file).unwrap();
        assert!(ledger.lookup(&file, st).is_none());
        ledger.record(&file, st, "deadbeef", "img-1").unwrap();
        assert_eq!(ledger.lookup(&file, st).unwrap().image_id, "img-1");

        // Persisted, and scoped to the server.
        let reopened = Ledger::open_at(&ledger_path, "https://a").unwrap();
        assert!(reopened.lookup(&file, st).is_some());
        let other = Ledger::open_at(&ledger_path, "https://b").unwrap();
        assert!(other.lookup(&file, st).is_none());

        // A changed file is a new upload.
        let changed = Stamp {
            size: st.size + 1,
            mtime: st.mtime,
        };
        assert!(reopened.lookup(&file, changed).is_none());
    }
}
