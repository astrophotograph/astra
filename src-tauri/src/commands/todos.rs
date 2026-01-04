//! Todo commands for managing astronomical observation targets

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::models::{AstronomyTodo, NewAstronomyTodo, UpdateAstronomyTodo};
use crate::db::repository;
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

#[tauri::command]
pub fn get_todos(state: State<'_, AppState>) -> Result<Vec<AstronomyTodo>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    repository::get_todos(&mut conn, &state.user_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_todo(state: State<'_, AppState>, id: String) -> Result<Option<AstronomyTodo>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    repository::get_todo_by_id(&mut conn, &id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_todo(
    state: State<'_, AppState>,
    input: CreateTodoInput,
) -> Result<AstronomyTodo, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;

    let new_todo = NewAstronomyTodo {
        id: uuid::Uuid::new_v4().to_string(),
        user_id: state.user_id.clone(),
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
        tags: input.tags.map(|t| serde_json::to_string(&t).unwrap_or_default()),
    };

    repository::create_todo(&mut conn, &new_todo)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_todo(
    state: State<'_, AppState>,
    input: UpdateTodoInput,
) -> Result<AstronomyTodo, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;

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
        tags: input.tags.map(|t| serde_json::to_string(&t).unwrap_or_default()),
    };

    repository::update_todo(&mut conn, &input.id, &update)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_todo(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    repository::delete_todo(&mut conn, &id)
        .map(|count| count > 0)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_todos(
    state: State<'_, AppState>,
    todos: Vec<CreateTodoInput>,
) -> Result<Vec<AstronomyTodo>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;

    let new_todos: Vec<NewAstronomyTodo> = todos
        .into_iter()
        .map(|input| NewAstronomyTodo {
            id: uuid::Uuid::new_v4().to_string(),
            user_id: state.user_id.clone(),
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
            tags: input.tags.map(|t| serde_json::to_string(&t).unwrap_or_default()),
        })
        .collect();

    repository::sync_todos(&mut conn, &state.user_id, &new_todos)
        .map_err(|e| e.to_string())
}
