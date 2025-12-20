//! Application state management

use crate::db::DbPool;

/// Application state shared across Tauri commands
pub struct AppState {
    /// Database connection pool
    pub db: DbPool,
    /// Current user ID (for standalone mode, always "local-user")
    pub user_id: String,
}

impl AppState {
    pub fn new(db: DbPool) -> Self {
        Self {
            db,
            user_id: "local-user".to_string(),
        }
    }
}
