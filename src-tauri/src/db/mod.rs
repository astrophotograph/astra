//! Database module for Astra
//!
//! Provides SQLite database access via Diesel ORM.

pub mod models;
pub mod repository;
pub mod schema;

use diesel::prelude::*;
use diesel::r2d2::{self, ConnectionManager};
use diesel::sqlite::SqliteConnection;
use diesel_migrations::{embed_migrations, EmbeddedMigrations, MigrationHarness};
use std::path::PathBuf;
use tauri::Manager;

pub type DbPool = r2d2::Pool<ConnectionManager<SqliteConnection>>;
pub type DbConnection = r2d2::PooledConnection<ConnectionManager<SqliteConnection>>;

pub const MIGRATIONS: EmbeddedMigrations = embed_migrations!("migrations");

/// Get the database path in the app data directory
pub fn get_database_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .expect("Failed to get app data directory");

    // Create directory if it doesn't exist
    std::fs::create_dir_all(&app_data_dir).expect("Failed to create app data directory");

    app_data_dir.join("astra.db")
}

/// Establish a connection pool to the SQLite database
pub fn establish_connection(database_url: &str) -> Result<DbPool, r2d2::PoolError> {
    let manager = ConnectionManager::<SqliteConnection>::new(database_url);
    r2d2::Pool::builder().max_size(5).build(manager)
}

/// Run pending database migrations
pub fn run_migrations(
    conn: &mut SqliteConnection,
) -> Result<(), Box<dyn std::error::Error + Send + Sync + 'static>> {
    conn.run_pending_migrations(MIGRATIONS)?;
    Ok(())
}

/// Initialize the database with a connection pool
pub fn init_database(database_path: &PathBuf) -> Result<DbPool, Box<dyn std::error::Error + Send + Sync>> {
    let database_url = format!("sqlite://{}?mode=rwc", database_path.display());

    let pool = establish_connection(&database_url)?;

    // Run migrations
    let mut conn = pool.get()?;
    run_migrations(&mut conn)?;

    Ok(pool)
}
