//! S3 credential storage for share uploads.
//!
//! File-based store with restricted permissions (0o600 on Unix).

use std::path::{Path, PathBuf};

/// S3 credentials for share upload.
#[derive(Debug, Clone)]
pub struct S3Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
}

const CRED_DIR: &str = ".credentials";
const CRED_FILE: &str = "astra-share-r2";

fn credentials_file_path(data_dir: &Path) -> PathBuf {
    data_dir.join(CRED_DIR).join(CRED_FILE)
}

/// Store S3 credentials.
pub fn store_credentials(
    data_dir: &Path,
    access_key_id: &str,
    secret_access_key: &str,
) -> Result<(), String> {
    let value = format!("{}:{}", access_key_id, secret_access_key);
    let file_path = credentials_file_path(data_dir);

    if let Some(parent) = file_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create credentials dir: {}", e))?;
    }
    std::fs::write(&file_path, &value)
        .map_err(|e| format!("Failed to write credentials: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&file_path, std::fs::Permissions::from_mode(0o600));
    }

    Ok(())
}

/// Load S3 credentials.
pub fn load_credentials(data_dir: &Path) -> Result<S3Credentials, String> {
    let file_path = credentials_file_path(data_dir);
    let data = std::fs::read_to_string(&file_path)
        .map_err(|_| "Share credentials not found. Configure sharing in Settings.".to_string())?;
    parse_credentials(data.trim())
}

/// Delete S3 credentials.
pub fn delete_credentials(data_dir: &Path) -> Result<(), String> {
    let file_path = credentials_file_path(data_dir);
    if file_path.exists() {
        std::fs::remove_file(&file_path)
            .map_err(|e| format!("Failed to delete credentials: {}", e))?;
    }
    Ok(())
}

fn parse_credentials(data: &str) -> Result<S3Credentials, String> {
    let parts: Vec<&str> = data.splitn(2, ':').collect();
    if parts.len() != 2 {
        return Err("Invalid credential format".to_string());
    }
    Ok(S3Credentials {
        access_key_id: parts[0].to_string(),
        secret_access_key: parts[1].to_string(),
    })
}
