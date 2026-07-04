//! Collection commands for managing observation collections
//!
//! Each `#[tauri::command]` is a thin wrapper over a `*_core` fn taking
//! explicit `db` + `user_id` so the daemon can serve the same logic without
//! Tauri (same pattern as `migrate_library_core` in `hoardfs.rs`). The core
//! fns enforce the tenancy boundary: rows belonging to another user read as
//! not-found and cannot be mutated.

use diesel::SqliteConnection;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::models::{Collection, NewCollection, UpdateCollection};
use crate::db::{repository, DbPool};
use crate::state::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateCollectionInput {
    pub name: String,
    pub description: Option<String>,
    pub visibility: Option<String>,
    pub template: Option<String>,
    pub tags: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateCollectionInput {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub visibility: Option<String>,
    pub template: Option<String>,
    pub favorite: Option<bool>,
    pub tags: Option<String>,
    pub metadata: Option<String>,
    pub archived: Option<bool>,
}

/// Load a collection only if it belongs to `user_id`.
pub(crate) fn fetch_owned_collection(
    conn: &mut SqliteConnection,
    user_id: &str,
    collection_id: &str,
) -> Result<Option<Collection>, String> {
    let collection =
        repository::get_collection_by_id(conn, collection_id).map_err(|e| e.to_string())?;
    Ok(collection.filter(|c| c.user_id == user_id))
}

// ============================================================================
// Core functions (no Tauri types — shared with the daemon)
// ============================================================================

pub fn get_collections_core(db: &DbPool, user_id: &str) -> Result<Vec<Collection>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    repository::get_collections(&mut conn, user_id).map_err(|e| e.to_string())
}

pub fn get_collection_core(
    db: &DbPool,
    user_id: &str,
    id: &str,
) -> Result<Option<Collection>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    fetch_owned_collection(&mut conn, user_id, id)
}

pub fn create_collection_core(
    db: &DbPool,
    user_id: &str,
    input: CreateCollectionInput,
) -> Result<Collection, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    let new_collection = NewCollection {
        id: uuid::Uuid::new_v4().to_string(),
        user_id: user_id.to_string(),
        name: input.name,
        description: input.description,
        visibility: input.visibility.unwrap_or_else(|| "private".to_string()),
        template: input.template,
        favorite: false,
        tags: input.tags,
        metadata: None,
        archived: false,
    };

    repository::create_collection(&mut conn, &new_collection).map_err(|e| e.to_string())
}

pub fn update_collection_core(
    db: &DbPool,
    user_id: &str,
    input: UpdateCollectionInput,
) -> Result<Collection, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    fetch_owned_collection(&mut conn, user_id, &input.id)?
        .ok_or_else(|| format!("Collection not found: {}", input.id))?;

    let update = UpdateCollection {
        name: input.name,
        description: input.description,
        visibility: input.visibility,
        template: input.template,
        favorite: input.favorite,
        tags: input.tags,
        metadata: input.metadata,
        archived: input.archived,
    };

    repository::update_collection(&mut conn, &input.id, &update).map_err(|e| e.to_string())
}

pub fn delete_collection_core(db: &DbPool, user_id: &str, id: &str) -> Result<bool, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    if fetch_owned_collection(&mut conn, user_id, id)?.is_none() {
        return Ok(false);
    }

    repository::delete_collection(&mut conn, id)
        .map(|count| count > 0)
        .map_err(|e| e.to_string())
}

// ============================================================================
// Tauri command wrappers
// ============================================================================

#[tauri::command]
pub fn get_collections(state: State<'_, AppState>) -> Result<Vec<Collection>, String> {
    get_collections_core(&state.db, &state.user_id)
}

#[tauri::command]
pub fn get_collection(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<Collection>, String> {
    get_collection_core(&state.db, &state.user_id, &id)
}

#[tauri::command]
pub fn create_collection(
    state: State<'_, AppState>,
    input: CreateCollectionInput,
) -> Result<Collection, String> {
    create_collection_core(&state.db, &state.user_id, input)
}

#[tauri::command]
pub fn update_collection(
    state: State<'_, AppState>,
    input: UpdateCollectionInput,
) -> Result<Collection, String> {
    update_collection_core(&state.db, &state.user_id, input)
}

#[tauri::command]
pub fn delete_collection(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    delete_collection_core(&state.db, &state.user_id, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::{insert_user, test_pool};

    fn make_collection(db: &DbPool, user_id: &str, name: &str) -> Collection {
        create_collection_core(
            db,
            user_id,
            CreateCollectionInput {
                name: name.to_string(),
                description: None,
                visibility: None,
                template: None,
                tags: None,
            },
        )
        .unwrap()
    }

    #[test]
    fn collection_crud_round_trip_core() {
        let db = test_pool();
        insert_user(&db, "alice");

        let created = make_collection(&db, "alice", "Nebulae");
        assert_eq!(created.visibility, "private");

        let listed = get_collections_core(&db, "alice").unwrap();
        assert_eq!(listed.len(), 1);

        let fetched = get_collection_core(&db, "alice", &created.id).unwrap();
        assert_eq!(fetched.unwrap().name, "Nebulae");

        let updated = update_collection_core(
            &db,
            "alice",
            UpdateCollectionInput {
                id: created.id.clone(),
                name: Some("Emission Nebulae".to_string()),
                description: None,
                visibility: None,
                template: None,
                favorite: Some(true),
                tags: None,
                metadata: None,
                archived: None,
            },
        )
        .unwrap();
        assert_eq!(updated.name, "Emission Nebulae");
        assert!(updated.favorite);

        assert!(delete_collection_core(&db, "alice", &created.id).unwrap());
        assert!(get_collections_core(&db, "alice").unwrap().is_empty());
    }

    #[test]
    fn collection_cross_user_isolation() {
        let db = test_pool();
        insert_user(&db, "alice");
        insert_user(&db, "bob");

        let alices = make_collection(&db, "alice", "Galaxies");

        // Bob can't see, mutate, or delete Alice's collection.
        assert!(get_collections_core(&db, "bob").unwrap().is_empty());
        assert!(get_collection_core(&db, "bob", &alices.id)
            .unwrap()
            .is_none());
        assert!(update_collection_core(
            &db,
            "bob",
            UpdateCollectionInput {
                id: alices.id.clone(),
                name: Some("hijacked".to_string()),
                description: None,
                visibility: None,
                template: None,
                favorite: None,
                tags: None,
                metadata: None,
                archived: None,
            },
        )
        .is_err());
        assert!(!delete_collection_core(&db, "bob", &alices.id).unwrap());

        // Alice still owns an untouched collection.
        let still = get_collection_core(&db, "alice", &alices.id)
            .unwrap()
            .unwrap();
        assert_eq!(still.name, "Galaxies");
    }
}
