//! Application state management

use std::sync::Mutex;

use crate::db::DbPool;
use crate::share::auth::AuthSession;

/// Application state shared across Tauri commands
pub struct AppState {
    /// Database connection pool
    pub db: DbPool,
    /// Current user ID (for standalone mode, always "local-user")
    pub user_id: String,
    /// Active astra.gallery auth session (if signed in)
    pub auth_session: Mutex<Option<AuthSession>>,
}

impl AppState {
    pub fn new(db: DbPool) -> Self {
        Self {
            db,
            user_id: "local-user".to_string(),
            auth_session: Mutex::new(None),
        }
    }
}
