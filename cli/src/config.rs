//! Saved login: `{server, token}` in a 0600 TOML file.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub server: String,
    pub token: String,
}

impl Credentials {
    pub fn new(server: &str, token: &str) -> Self {
        Self {
            server: server.trim().trim_end_matches('/').to_string(),
            token: token.trim().to_string(),
        }
    }
}

pub fn default_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("astra-cli")
        .join("config.toml")
}

pub fn load(path: &Path) -> Result<Option<Credentials>> {
    if !path.exists() {
        return Ok(None);
    }
    let text =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let creds: Credentials =
        toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
    Ok(Some(creds))
}

pub fn save(path: &Path, creds: &Credentials) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let text = toml::to_string(creds).context("serializing config")?;
    write_private(path, text.as_bytes())
}

pub fn remove(path: &Path) -> Result<bool> {
    if !path.exists() {
        return Ok(false);
    }
    std::fs::remove_file(path).with_context(|| format!("removing {}", path.display()))?;
    Ok(true)
}

/// Explicit flags/env win over the saved file; both halves must come from
/// somewhere.
pub fn resolve(path: &Path, server: Option<String>, token: Option<String>) -> Result<Credentials> {
    let saved = load(path)?;
    let server = server
        .filter(|s| !s.trim().is_empty())
        .or_else(|| saved.as_ref().map(|c| c.server.clone()));
    let token = token
        .filter(|s| !s.trim().is_empty())
        .or_else(|| saved.as_ref().map(|c| c.token.clone()));
    match (server, token) {
        (Some(server), Some(token)) => Ok(Credentials::new(&server, &token)),
        _ => bail!(
            "not signed in — run `astra-cli login --server <url>` or set ASTRA_SERVER and ASTRA_TOKEN"
        ),
    }
}

/// Write with owner-only permissions; the file holds a bearer secret.
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("writing {}", path.display()))?;
        f.write_all(bytes)?;
        return Ok(());
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes).with_context(|| format!("writing {}", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_precedence() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("config.toml");
        assert!(load(&path).unwrap().is_none());
        save(
            &path,
            &Credentials::new("https://astra.gallery/", "astra_abc"),
        )
        .unwrap();
        let loaded = load(&path).unwrap().unwrap();
        assert_eq!(loaded.server, "https://astra.gallery");
        assert_eq!(loaded.token, "astra_abc");

        let resolved = resolve(&path, Some("http://localhost:27872".into()), None).unwrap();
        assert_eq!(resolved.server, "http://localhost:27872");
        assert_eq!(resolved.token, "astra_abc");

        assert!(remove(&path).unwrap());
        assert!(!remove(&path).unwrap());
        assert!(resolve(&path, None, None).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn config_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        save(&path, &Credentials::new("x", "y")).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
