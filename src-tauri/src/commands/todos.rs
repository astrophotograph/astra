//! Todo commands for managing astronomical observation targets
//!
//! Each `#[tauri::command]` is a thin wrapper over a `*_core` fn taking
//! explicit `db` + `user_id` so the daemon can serve the same logic without
//! Tauri (same pattern as `commands/collections.rs`). The core fns enforce
//! the tenancy boundary: rows belonging to another user read as not-found
//! and cannot be mutated.

use diesel::SqliteConnection;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::models::{AstronomyTodo, NewAstronomyTodo, UpdateAstronomyTodo};
use crate::db::{repository, DbPool};
use crate::state::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateTodoInput {
    pub name: String,
    pub ra: String,
    pub dec: String,
    pub magnitude: String,
    pub size: String,
    pub object_type: Option<String>,
    pub goal_time: Option<String>,
    pub notes: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateTodoInput {
    pub id: String,
    pub name: Option<String>,
    pub ra: Option<String>,
    pub dec: Option<String>,
    pub magnitude: Option<String>,
    pub size: Option<String>,
    pub object_type: Option<String>,
    pub completed: Option<bool>,
    pub completed_at: Option<String>,
    pub goal_time: Option<String>,
    pub notes: Option<String>,
    pub flagged: Option<bool>,
    pub tags: Option<Vec<String>>,
}

/// Load a todo only if it belongs to `user_id`.
pub(crate) fn fetch_owned_todo(
    conn: &mut SqliteConnection,
    user_id: &str,
    todo_id: &str,
) -> Result<Option<AstronomyTodo>, String> {
    let todo = repository::get_todo_by_id(conn, todo_id).map_err(|e| e.to_string())?;
    Ok(todo.filter(|t| t.user_id == user_id))
}

fn new_todo_from_input(user_id: &str, input: CreateTodoInput) -> NewAstronomyTodo {
    NewAstronomyTodo {
        id: uuid::Uuid::new_v4().to_string(),
        user_id: user_id.to_string(),
        name: input.name,
        ra: input.ra,
        dec: input.dec,
        magnitude: input.magnitude,
        size: input.size,
        object_type: input.object_type,
        added_at: chrono::Utc::now().to_rfc3339(),
        completed: false,
        completed_at: None,
        goal_time: input.goal_time,
        notes: input.notes,
        flagged: false,
        last_updated: Some(chrono::Utc::now().to_rfc3339()),
        tags: input
            .tags
            .map(|t| serde_json::to_string(&t).unwrap_or_default()),
    }
}

// ============================================================================
// Core functions (no Tauri types — shared with the daemon)
// ============================================================================

pub fn get_todos_core(db: &DbPool, user_id: &str) -> Result<Vec<AstronomyTodo>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    repository::get_todos(&mut conn, user_id).map_err(|e| e.to_string())
}

pub fn get_todo_core(
    db: &DbPool,
    user_id: &str,
    id: &str,
) -> Result<Option<AstronomyTodo>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    fetch_owned_todo(&mut conn, user_id, id)
}

pub fn create_todo_core(
    db: &DbPool,
    user_id: &str,
    input: CreateTodoInput,
) -> Result<AstronomyTodo, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    repository::create_todo(&mut conn, &new_todo_from_input(user_id, input))
        .map_err(|e| e.to_string())
}

pub fn update_todo_core(
    db: &DbPool,
    user_id: &str,
    input: UpdateTodoInput,
) -> Result<AstronomyTodo, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    fetch_owned_todo(&mut conn, user_id, &input.id)?
        .ok_or_else(|| format!("Todo not found: {}", input.id))?;

    let update = UpdateAstronomyTodo {
        name: input.name,
        ra: input.ra,
        dec: input.dec,
        magnitude: input.magnitude,
        size: input.size,
        object_type: input.object_type,
        completed: input.completed,
        completed_at: input.completed_at,
        goal_time: input.goal_time,
        notes: input.notes,
        flagged: input.flagged,
        last_updated: Some(chrono::Utc::now().to_rfc3339()),
        tags: input
            .tags
            .map(|t| serde_json::to_string(&t).unwrap_or_default()),
    };

    repository::update_todo(&mut conn, &input.id, &update).map_err(|e| e.to_string())
}

pub fn delete_todo_core(db: &DbPool, user_id: &str, id: &str) -> Result<bool, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    if fetch_owned_todo(&mut conn, user_id, id)?.is_none() {
        return Ok(false);
    }

    repository::delete_todo(&mut conn, id)
        .map(|count| count > 0)
        .map_err(|e| e.to_string())
}

/// Replace-all sync: drops the user's todos and inserts the given set.
/// Scoped to `user_id` at the repository level — other tenants unaffected.
pub fn sync_todos_core(
    db: &DbPool,
    user_id: &str,
    todos: Vec<CreateTodoInput>,
) -> Result<Vec<AstronomyTodo>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    let new_todos: Vec<NewAstronomyTodo> = todos
        .into_iter()
        .map(|input| new_todo_from_input(user_id, input))
        .collect();

    repository::sync_todos(&mut conn, user_id, &new_todos).map_err(|e| e.to_string())
}

// ============================================================================
// Tauri command wrappers
// ============================================================================

#[tauri::command]
pub fn get_todos(state: State<'_, AppState>) -> Result<Vec<AstronomyTodo>, String> {
    get_todos_core(&state.db, &state.user_id)
}

#[tauri::command]
pub fn get_todo(state: State<'_, AppState>, id: String) -> Result<Option<AstronomyTodo>, String> {
    get_todo_core(&state.db, &state.user_id, &id)
}

#[tauri::command]
pub fn create_todo(
    state: State<'_, AppState>,
    input: CreateTodoInput,
) -> Result<AstronomyTodo, String> {
    create_todo_core(&state.db, &state.user_id, input)
}

#[tauri::command]
pub fn update_todo(
    state: State<'_, AppState>,
    input: UpdateTodoInput,
) -> Result<AstronomyTodo, String> {
    update_todo_core(&state.db, &state.user_id, input)
}

#[tauri::command]
pub fn delete_todo(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    delete_todo_core(&state.db, &state.user_id, &id)
}

#[tauri::command]
pub fn sync_todos(
    state: State<'_, AppState>,
    todos: Vec<CreateTodoInput>,
) -> Result<Vec<AstronomyTodo>, String> {
    sync_todos_core(&state.db, &state.user_id, todos)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::{insert_user, test_pool};

    fn make_input(name: &str) -> CreateTodoInput {
        CreateTodoInput {
            name: name.to_string(),
            ra: "05h 35m".to_string(),
            dec: "-05° 27′".to_string(),
            magnitude: "4.0".to_string(),
            size: "65'".to_string(),
            object_type: Some("nebula".to_string()),
            goal_time: None,
            notes: None,
            tags: Some(vec!["winter".to_string()]),
        }
    }

    #[test]
    fn todo_crud_round_trip_core() {
        let db = test_pool();
        insert_user(&db, "alice");

        let created = create_todo_core(&db, "alice", make_input("M42")).unwrap();
        assert!(!created.completed);
        assert_eq!(created.tags.as_deref(), Some("[\"winter\"]"));

        assert_eq!(get_todos_core(&db, "alice").unwrap().len(), 1);
        assert_eq!(
            get_todo_core(&db, "alice", &created.id).unwrap().unwrap().name,
            "M42"
        );

        let updated = update_todo_core(
            &db,
            "alice",
            UpdateTodoInput {
                id: created.id.clone(),
                name: None,
                ra: None,
                dec: None,
                magnitude: None,
                size: None,
                object_type: None,
                completed: Some(true),
                completed_at: Some("2026-07-05T00:00:00Z".to_string()),
                goal_time: None,
                notes: Some("done at last".to_string()),
                flagged: None,
                tags: None,
            },
        )
        .unwrap();
        assert!(updated.completed);
        assert_eq!(updated.notes.as_deref(), Some("done at last"));

        assert!(delete_todo_core(&db, "alice", &created.id).unwrap());
        assert!(get_todos_core(&db, "alice").unwrap().is_empty());
    }

    #[test]
    fn todo_sync_replaces_only_own_rows() {
        let db = test_pool();
        insert_user(&db, "alice");
        insert_user(&db, "bob");

        create_todo_core(&db, "alice", make_input("M42")).unwrap();
        create_todo_core(&db, "bob", make_input("M31")).unwrap();

        let synced =
            sync_todos_core(&db, "alice", vec![make_input("M45"), make_input("M13")]).unwrap();
        assert_eq!(synced.len(), 2);

        // Bob's list is untouched by alice's replace-all.
        let bobs = get_todos_core(&db, "bob").unwrap();
        assert_eq!(bobs.len(), 1);
        assert_eq!(bobs[0].name, "M31");
    }

    #[test]
    fn todo_cross_user_isolation() {
        let db = test_pool();
        insert_user(&db, "alice");
        insert_user(&db, "bob");

        let alices = create_todo_core(&db, "alice", make_input("M42")).unwrap();

        assert!(get_todo_core(&db, "bob", &alices.id).unwrap().is_none());
        assert!(update_todo_core(
            &db,
            "bob",
            UpdateTodoInput {
                id: alices.id.clone(),
                name: Some("hijacked".to_string()),
                ra: None,
                dec: None,
                magnitude: None,
                size: None,
                object_type: None,
                completed: None,
                completed_at: None,
                goal_time: None,
                notes: None,
                flagged: None,
                tags: None,
            },
        )
        .is_err());
        assert!(!delete_todo_core(&db, "bob", &alices.id).unwrap());

        let still = get_todo_core(&db, "alice", &alices.id).unwrap().unwrap();
        assert_eq!(still.name, "M42");
    }
}
