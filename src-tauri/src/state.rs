//! Application state management

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

use crate::db::DbPool;
use crate::share::auth::AuthSession;
pub use hoardfs_volume::HoardFs;

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
    /// HoardFS content-addressed storage (None if init failed — graceful degradation)
    /// Wrapped in std::sync::Mutex because rusqlite::Connection is not Sync.
    /// Lock must NOT be held across .await points.
    pub hoardfs: Option<Arc<Mutex<HoardFs>>>,
}

impl AppState {
    pub fn new(db: DbPool, hoardfs: Option<Arc<Mutex<HoardFs>>>) -> Self {
        Self {
            db,
            user_id: "local-user".to_string(),
            auth_session: Mutex::new(None),
            auto_import_cancel: Mutex::new(None),
            auto_import_status: Arc::new(Mutex::new(AutoImportStatus::default())),
            hoardfs,
        }
    }
}
