//! Multi-tenant helpers: user provisioning and per-user HoardFS volumes.
//!
//! # Volume mapping
//!
//! The desktop app's local user keeps the original `default` volume — all
//! pre-tenancy blobs already live there. Every other (hosted) user gets a
//! `user-{user_id}` volume, created on demand at provisioning time.
//!
//! # Enumerated columns
//!
//! SQLite cannot add CHECK constraints via ALTER TABLE, so the allowed
//! values of `users.role` and `users.status` are enforced here through
//! [`UserRole`] and [`UserStatus`] — provision users through this module,
//! not with raw inserts.

use diesel::prelude::*;

use crate::db::models::User;
use crate::db::schema::users;

/// The desktop app's constant user id.
pub const LOCAL_USER_ID: &str = "local-user";
/// The pre-tenancy volume; remains the local user's desktop volume.
pub const LOCAL_USER_VOLUME: &str = "default";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserRole {
    Owner,
    Member,
}

impl UserRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Member => "member",
        }
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "owner" => Ok(Self::Owner),
            "member" => Ok(Self::Member),
            other => Err(format!("unknown user role '{other}'")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserStatus {
    Active,
    Invited,
    Disabled,
}

impl UserStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Invited => "invited",
            Self::Disabled => "disabled",
        }
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "active" => Ok(Self::Active),
            "invited" => Ok(Self::Invited),
            "disabled" => Ok(Self::Disabled),
            other => Err(format!("unknown user status '{other}'")),
        }
    }
}

/// Parameters for provisioning a new (hosted) user.
#[derive(Debug, Clone)]
pub struct NewTenant {
    pub id: String,
    /// URL-safe @handle; validated by [`validate_username`].
    pub username: String,
    /// Maps to `users.name` — the profile display name.
    pub display_name: Option<String>,
    pub email: Option<String>,
    /// External identity subject (Zitadel `sub`); None until first OIDC login.
    pub external_subject: Option<String>,
    pub role: UserRole,
    pub status: UserStatus,
}

/// HoardFS volume name for a user.
pub fn volume_name(user_id: &str) -> String {
    if user_id == LOCAL_USER_ID {
        LOCAL_USER_VOLUME.to_string()
    } else {
        format!("user-{user_id}")
    }
}

/// The @handle rules: 2–32 chars of lowercase ASCII alphanumerics, `-` or
/// `_`, starting with an alphanumeric. Keeps handles URL- and volume-safe.
pub fn validate_username(username: &str) -> Result<(), String> {
    let n = username.chars().count();
    if !(2..=32).contains(&n) {
        return Err(format!(
            "username '{username}' must be 2-32 characters (got {n})"
        ));
    }
    let mut chars = username.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return Err(format!(
            "username '{username}' must start with a lowercase letter or digit"
        ));
    }
    if let Some(bad) = chars.find(|c| !c.is_ascii_lowercase() && !c.is_ascii_digit() && *c != '-' && *c != '_') {
        return Err(format!("username '{username}' contains invalid character '{bad}'"));
    }
    Ok(())
}

/// Ensure the user's HoardFS volume exists (idempotent); returns its name.
pub fn ensure_user_volume(
    hfs: &hoardfs_volume::HoardFs,
    user_id: &str,
) -> Result<String, String> {
    let name = volume_name(user_id);
    let exists = hfs
        .list_volumes()
        .map_err(|e| format!("list volumes: {e}"))?
        .iter()
        .any(|v| v.name == name);
    if !exists {
        hfs.create_volume(&name)
            .map_err(|e| format!("create volume '{name}': {e}"))?;
    }
    Ok(name)
}

/// Insert a user row and create its HoardFS volume on demand.
pub fn provision_user(
    conn: &mut SqliteConnection,
    hfs: &hoardfs_volume::HoardFs,
    tenant: &NewTenant,
) -> Result<User, String> {
    validate_username(&tenant.username)?;

    diesel::insert_into(users::table)
        .values((
            users::id.eq(&tenant.id),
            users::username.eq(&tenant.username),
            users::name.eq(&tenant.display_name),
            users::email.eq(&tenant.email),
            users::external_subject.eq(&tenant.external_subject),
            users::role.eq(tenant.role.as_str()),
            users::status.eq(tenant.status.as_str()),
        ))
        .execute(conn)
        .map_err(|e| format!("insert user '{}': {e}", tenant.id))?;

    ensure_user_volume(hfs, &tenant.id)?;

    users::table
        .find(&tenant.id)
        .first(conn)
        .map_err(|e| format!("load user '{}': {e}", tenant.id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use diesel::r2d2::{ConnectionManager, Pool};
    use diesel_migrations::MigrationHarness;

    fn test_conn() -> crate::db::DbConnection {
        let manager = ConnectionManager::<SqliteConnection>::new(":memory:");
        let pool = Pool::builder().max_size(1).build(manager).unwrap();
        let mut conn = pool.get().unwrap();
        conn.run_pending_migrations(crate::db::MIGRATIONS).unwrap();
        conn
    }

    fn test_hoardfs(dir: &std::path::Path) -> hoardfs_volume::HoardFs {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(hoardfs_volume::HoardFs::init(dir))
            .unwrap()
    }

    #[test]
    fn migration_backfills_local_user_as_active_owner() {
        let mut conn = test_conn();
        let user: User = users::table.find(LOCAL_USER_ID).first(&mut conn).unwrap();
        assert_eq!(user.role, "owner");
        assert_eq!(user.status, "active");
        assert_eq!(user.username.as_deref(), Some("erewhon"));
        assert_eq!(user.external_subject, None);
    }

    #[test]
    fn volume_name_maps_local_user_to_default() {
        assert_eq!(volume_name(LOCAL_USER_ID), "default");
        assert_eq!(volume_name("abc-123"), "user-abc-123");
    }

    #[test]
    fn username_validation() {
        assert!(validate_username("erewhon").is_ok());
        assert!(validate_username("a2").is_ok());
        assert!(validate_username("star_gazer-9").is_ok());
        assert!(validate_username("x").is_err()); // too short
        assert!(validate_username("-dash").is_err()); // bad first char
        assert!(validate_username("Upper").is_err()); // uppercase
        assert!(validate_username("with space").is_err());
        assert!(validate_username(&"a".repeat(33)).is_err()); // too long
    }

    #[test]
    fn provision_user_creates_volume_on_demand_idempotently() {
        let mut conn = test_conn();
        let tmp = tempfile::tempdir().unwrap();
        let hfs = test_hoardfs(&tmp.path().join("hoardfs"));

        let tenant = NewTenant {
            id: "u-42".to_string(),
            username: "stargazer".to_string(),
            display_name: Some("Star Gazer".to_string()),
            email: None,
            external_subject: Some("zitadel|12345".to_string()),
            role: UserRole::Member,
            status: UserStatus::Invited,
        };
        let user = provision_user(&mut conn, &hfs, &tenant).unwrap();
        assert_eq!(user.role, "member");
        assert_eq!(user.status, "invited");
        assert_eq!(user.name.as_deref(), Some("Star Gazer"));

        let volumes = hfs.list_volumes().unwrap();
        assert!(volumes.iter().any(|v| v.name == "user-u-42"));

        // Idempotent: re-ensuring neither fails nor duplicates.
        ensure_user_volume(&hfs, "u-42").unwrap();
        let count = hfs
            .list_volumes()
            .unwrap()
            .iter()
            .filter(|v| v.name == "user-u-42")
            .count();
        assert_eq!(count, 1);

        // Unique handles: a second user with the same username is rejected.
        let dup = NewTenant {
            id: "u-43".to_string(),
            external_subject: None,
            ..tenant.clone()
        };
        assert!(provision_user(&mut conn, &hfs, &dup).is_err());
    }
}
