//! Application state management

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

use crate::db::DbPool;
use crate::share::auth::AuthSession;

/// Status of the auto-import background task
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AutoImportStatus {
    pub enabled: bool,
    pub last_scan_time: Option<String>,
    pub last_import_count: usize,
    pub total_imported: usize,
    pub is_scanning: bool,
    pub errors: Vec<String>,
}

/// Application state shared across Tauri commands
pub struct AppState {
    /// Database connection pool
    pub db: DbPool,
    /// Current user ID (for standalone mode, always "local-user")
    pub user_id: String,
    /// Active astra.gallery auth session (if signed in)
    pub auth_session: Mutex<Option<AuthSession>>,
    /// Cancellation sender for the auto-import background task
    pub auto_import_cancel: Mutex<Option<tokio::sync::watch::Sender<bool>>>,
    /// Current auto-import status (Arc for sharing with background task)
    pub auto_import_status: Arc<Mutex<AutoImportStatus>>,
}

impl AppState {
    pub fn new(db: DbPool) -> Self {
        Self {
            db,
            user_id: "local-user".to_string(),
            auth_session: Mutex::new(None),
            auto_import_cancel: Mutex::new(None),
            auto_import_status: Arc::new(Mutex::new(AutoImportStatus::default())),
        }
    }
}
