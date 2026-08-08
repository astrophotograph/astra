//! Database module for Astra
//!
//! Provides SQLite database access via Diesel ORM.

pub mod models;
pub mod repository;
pub mod schema;
pub mod tenancy;

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

/// Per-connection SQLite pragmas. The WAL journal mode itself is a
/// persistent database property flipped once in [`init_database`] — doing it
/// per-connection races pool pre-fill on fresh databases (the delete→WAL
/// transition needs an exclusive lock and SQLite bypasses the busy handler
/// on that upgrade), logging spurious "database is locked" errors.
#[derive(Debug)]
struct SqlitePragmas;

impl r2d2::CustomizeConnection<SqliteConnection, r2d2::Error> for SqlitePragmas {
    fn on_acquire(&self, conn: &mut SqliteConnection) -> Result<(), r2d2::Error> {
        use diesel::connection::SimpleConnection;
        conn.batch_execute("PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;")
            .map_err(r2d2::Error::QueryError)
    }
}

/// Establish a connection pool to the SQLite database
pub fn establish_connection(database_url: &str) -> Result<DbPool, r2d2::PoolError> {
    let manager = ConnectionManager::<SqliteConnection>::new(database_url);
    r2d2::Pool::builder()
        .max_size(5)
        .connection_customizer(Box::new(SqlitePragmas))
        .build(manager)
}

/// Run pending database migrations
pub fn run_migrations(
    conn: &mut SqliteConnection,
) -> Result<(), Box<dyn std::error::Error + Send + Sync + 'static>> {
    conn.run_pending_migrations(MIGRATIONS)?;
    Ok(())
}

/// Shared fixtures for command-core and repository tests.
#[cfg(test)]
pub mod test_support {
    use super::*;

    /// In-memory pool (single connection — each :memory: connection is its
    /// own database) with all migrations applied.
    pub fn test_pool() -> DbPool {
        let manager = ConnectionManager::<SqliteConnection>::new(":memory:");
        let pool = r2d2::Pool::builder().max_size(1).build(manager).unwrap();
        run_migrations(&mut pool.get().unwrap()).unwrap();
        pool
    }

    /// Insert a minimal user row so user_id foreign keys are satisfied.
    pub fn insert_user(pool: &DbPool, user_id: &str) {
        use crate::db::schema::users;
        use diesel::prelude::*;
        diesel::insert_into(users::table)
            .values((
                users::id.eq(user_id),
                users::name.eq(format!("Test {user_id}")),
            ))
            .execute(&mut pool.get().unwrap())
            .unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use diesel::sql_query;
    use diesel::sql_types::Text;

    #[derive(QueryableByName)]
    struct TableName {
        #[diesel(sql_type = Text)]
        name: String,
    }

    fn kith_table_names(conn: &mut SqliteConnection) -> Vec<String> {
        sql_query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'kith_%' ORDER BY name",
        )
        .load::<TableName>(conn)
        .unwrap()
        .into_iter()
        .map(|t| t.name)
        .collect()
    }

    /// Pop migrations until the given version is no longer applied, so tests
    /// stay valid as newer migrations land on top of the stack.
    fn revert_through(conn: &mut SqliteConnection, version: &str) {
        while conn
            .applied_migrations()
            .unwrap()
            .iter()
            .any(|v| v.to_string() == version)
        {
            conn.revert_last_migration(MIGRATIONS).unwrap();
        }
    }

    #[test]
    fn kith_social_migration_creates_tables() {
        let pool = test_support::test_pool();
        let mut conn = pool.get().unwrap();
        assert_eq!(
            kith_table_names(&mut conn),
            ["kith_edges", "kith_notifications", "kith_subscriptions"]
        );
    }

    #[test]
    fn kith_social_migration_reverts_and_reapplies() {
        let pool = test_support::test_pool();
        let mut conn = pool.get().unwrap();

        // The canonical-kind codec migration doesn't drop tables; the
        // table-creating kith_social migration beneath it does.
        revert_through(&mut conn, "20260712000000");
        assert_eq!(kith_table_names(&mut conn).len(), 3);
        revert_through(&mut conn, "20250112000000");
        assert!(kith_table_names(&mut conn).is_empty());

        // Re-applying on a database that already has every prior migration
        // exercises the incremental (existing-DB) path.
        run_migrations(&mut conn).unwrap();
        assert_eq!(kith_table_names(&mut conn).len(), 3);
    }

    #[test]
    fn kith_canonical_kinds_migration_rewrites_legacy_rows() {
        use diesel::connection::SimpleConnection;

        let pool = test_support::test_pool();
        let mut conn = pool.get().unwrap();

        // Wind back the codec migration and plant legacy serde-JSON rows,
        // exactly as the pre-codec AstraKithStore wrote them.
        revert_through(&mut conn, "20260712000000");
        conn.batch_execute(
            r#"
            INSERT INTO kith_edges (actor_id, target_kind, target_id, edge_kind, weight, metadata, created_at)
            VALUES
                ('alice', '"User"', 'bob', '"Follow"', 1.0, '{}', '2026-07-01T00:00:00+00:00'),
                ('alice', '"User"', 'bob', '{"Vouch":{"axis":"Identity"}}', 1.0, '{}', '2026-07-01T00:00:00+00:00'),
                ('alice', '{"Custom":"room"}', 'r1', '{"Circle":"close:friends"}', 1.0, '{}', '2026-07-01T00:00:00+00:00');
            INSERT INTO kith_subscriptions (id, actor_id, topic_kind, topic_id, filter_json, created_at)
            VALUES ('sub_legacy', 'alice', '"Object"', 'M42', '{}', '2026-07-01T00:00:00+00:00');
            INSERT INTO kith_notifications (id, recipient_id, source_id, entity_kind, entity_id, event_kind, payload_json, created_at, read)
            VALUES ('n_legacy', 'alice', 'bob', '"User"', 'bob', '"NewContent"', '{}', '2026-07-01T00:00:00+00:00', 0);
            "#,
        )
        .unwrap();

        run_migrations(&mut conn).unwrap();

        #[derive(QueryableByName)]
        struct Kind {
            #[diesel(sql_type = Text)]
            kind: String,
        }
        let edge_kinds: Vec<String> = sql_query(
            "SELECT edge_kind AS kind FROM kith_edges ORDER BY 1",
        )
        .load::<Kind>(&mut conn)
        .unwrap()
        .into_iter()
        .map(|k| k.kind)
        .collect();
        assert_eq!(
            edge_kinds,
            ["circle:close:friends", "follow", "vouch:identity"]
        );

        let target_kinds: Vec<String> = sql_query(
            "SELECT DISTINCT target_kind AS kind FROM kith_edges ORDER BY 1",
        )
        .load::<Kind>(&mut conn)
        .unwrap()
        .into_iter()
        .map(|k| k.kind)
        .collect();
        assert_eq!(target_kinds, ["custom:room", "user"]);

        let topic_kind: Vec<String> = sql_query(
            "SELECT topic_kind AS kind FROM kith_subscriptions",
        )
        .load::<Kind>(&mut conn)
        .unwrap()
        .into_iter()
        .map(|k| k.kind)
        .collect();
        assert_eq!(topic_kind, ["object"]);

        let entity_kind: Vec<String> = sql_query(
            "SELECT entity_kind AS kind FROM kith_notifications",
        )
        .load::<Kind>(&mut conn)
        .unwrap()
        .into_iter()
        .map(|k| k.kind)
        .collect();
        assert_eq!(entity_kind, ["user"]);

        // event_kind is not part of the codec and stays serde-JSON.
        let event_kind: Vec<String> = sql_query(
            "SELECT event_kind AS kind FROM kith_notifications",
        )
        .load::<Kind>(&mut conn)
        .unwrap()
        .into_iter()
        .map(|k| k.kind)
        .collect();
        assert_eq!(event_kind, ["\"NewContent\""]);
    }
}

/// Initialize the database with a connection pool
pub fn init_database(database_path: &PathBuf) -> Result<DbPool, Box<dyn std::error::Error + Send + Sync>> {
    let database_url = format!("sqlite://{}?mode=rwc", database_path.display());

    // Enable WAL once, on a lone connection, before the pool exists: WAL is
    // a persistent database property, and it lets multiple processes
    // (desktop app, daemon, one-shot binaries) share the database safely —
    // many readers plus one writer, writers queueing on busy_timeout.
    {
        use diesel::connection::SimpleConnection;
        use diesel::Connection;
        let mut conn = SqliteConnection::establish(&database_url)?;
        conn.batch_execute("PRAGMA journal_mode = WAL;")?;
    }

    let pool = establish_connection(&database_url)?;

    // Run migrations
    let mut conn = pool.get()?;
    run_migrations(&mut conn)?;

    Ok(pool)
}
