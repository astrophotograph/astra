//! Schedule commands for managing observation schedules
//!
//! Each `#[tauri::command]` is a thin wrapper over a `*_core` fn taking
//! explicit `db` + `user_id` so the daemon can serve the same logic without
//! Tauri (same pattern as `commands/collections.rs`). The core fns enforce
//! the tenancy boundary: rows belonging to another user read as not-found
//! and cannot be mutated.

use diesel::SqliteConnection;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::models::{
    NewObservationSchedule, ObservationSchedule, ScheduleItem, UpdateObservationSchedule,
};
use crate::db::{repository, DbPool};
use crate::state::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateScheduleInput {
    pub name: String,
    pub description: Option<String>,
    pub scheduled_date: Option<String>,
    pub location: Option<String>,
    pub is_active: Option<bool>,
    pub equipment_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateScheduleInput {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub scheduled_date: Option<String>,
    pub location: Option<String>,
    pub items: Option<Vec<ScheduleItem>>,
    pub is_active: Option<bool>,
    pub equipment_id: Option<String>,
}

/// Load a schedule only if it belongs to `user_id`.
pub(crate) fn fetch_owned_schedule(
    conn: &mut SqliteConnection,
    user_id: &str,
    schedule_id: &str,
) -> Result<Option<ObservationSchedule>, String> {
    let schedule =
        repository::get_schedule_by_id(conn, schedule_id).map_err(|e| e.to_string())?;
    Ok(schedule.filter(|s| s.user_id == user_id))
}

// ============================================================================
// Core functions (no Tauri types — shared with the daemon)
// ============================================================================

pub fn get_schedules_core(
    db: &DbPool,
    user_id: &str,
) -> Result<Vec<ObservationSchedule>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    repository::get_schedules(&mut conn, user_id).map_err(|e| e.to_string())
}

pub fn get_active_schedule_core(
    db: &DbPool,
    user_id: &str,
) -> Result<Option<ObservationSchedule>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    repository::get_active_schedule(&mut conn, user_id).map_err(|e| e.to_string())
}

pub fn get_active_schedules_core(
    db: &DbPool,
    user_id: &str,
) -> Result<Vec<ObservationSchedule>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    repository::get_active_schedules(&mut conn, user_id).map_err(|e| e.to_string())
}

pub fn get_schedule_core(
    db: &DbPool,
    user_id: &str,
    id: &str,
) -> Result<Option<ObservationSchedule>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    fetch_owned_schedule(&mut conn, user_id, id)
}

pub fn create_schedule_core(
    db: &DbPool,
    user_id: &str,
    input: CreateScheduleInput,
) -> Result<ObservationSchedule, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    let new_schedule = NewObservationSchedule {
        id: uuid::Uuid::new_v4().to_string(),
        user_id: user_id.to_string(),
        name: input.name,
        description: input.description,
        scheduled_date: input.scheduled_date,
        location: input.location,
        items: "[]".to_string(),
        is_active: input.is_active.unwrap_or(false),
        equipment_id: input.equipment_id,
    };

    repository::create_schedule(&mut conn, &new_schedule).map_err(|e| e.to_string())
}

pub fn update_schedule_core(
    db: &DbPool,
    user_id: &str,
    input: UpdateScheduleInput,
) -> Result<ObservationSchedule, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    fetch_owned_schedule(&mut conn, user_id, &input.id)?
        .ok_or_else(|| format!("Schedule not found: {}", input.id))?;

    let items_json = input
        .items
        .map(|items| serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string()));

    let update = UpdateObservationSchedule {
        name: input.name,
        description: input.description,
        scheduled_date: input.scheduled_date,
        location: input.location,
        items: items_json,
        is_active: input.is_active,
        equipment_id: input.equipment_id,
    };

    repository::update_schedule(&mut conn, &input.id, &update).map_err(|e| e.to_string())
}

pub fn delete_schedule_core(db: &DbPool, user_id: &str, id: &str) -> Result<bool, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    if fetch_owned_schedule(&mut conn, user_id, id)?.is_none() {
        return Ok(false);
    }

    repository::delete_schedule(&mut conn, id)
        .map(|count| count > 0)
        .map_err(|e| e.to_string())
}

pub fn add_schedule_item_core(
    db: &DbPool,
    user_id: &str,
    schedule_id: &str,
    item: ScheduleItem,
) -> Result<ObservationSchedule, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    let schedule = fetch_owned_schedule(&mut conn, user_id, schedule_id)?
        .ok_or_else(|| format!("Schedule not found: {schedule_id}"))?;

    let mut items: Vec<ScheduleItem> = serde_json::from_str(&schedule.items).unwrap_or_default();
    items.push(item);
    items.sort_by(|a, b| a.start_time.cmp(&b.start_time));

    let update = UpdateObservationSchedule {
        items: Some(serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string())),
        ..Default::default()
    };

    repository::update_schedule(&mut conn, schedule_id, &update).map_err(|e| e.to_string())
}

pub fn remove_schedule_item_core(
    db: &DbPool,
    user_id: &str,
    schedule_id: &str,
    item_id: &str,
) -> Result<ObservationSchedule, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    let schedule = fetch_owned_schedule(&mut conn, user_id, schedule_id)?
        .ok_or_else(|| format!("Schedule not found: {schedule_id}"))?;

    let mut items: Vec<ScheduleItem> = serde_json::from_str(&schedule.items).unwrap_or_default();
    items.retain(|i| i.id != item_id);

    let update = UpdateObservationSchedule {
        items: Some(serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string())),
        ..Default::default()
    };

    repository::update_schedule(&mut conn, schedule_id, &update).map_err(|e| e.to_string())
}

// ============================================================================
// Tauri command wrappers
// ============================================================================

#[tauri::command]
pub fn get_schedules(state: State<'_, AppState>) -> Result<Vec<ObservationSchedule>, String> {
    get_schedules_core(&state.db, &state.user_id)
}

#[tauri::command]
pub fn get_active_schedule(
    state: State<'_, AppState>,
) -> Result<Option<ObservationSchedule>, String> {
    get_active_schedule_core(&state.db, &state.user_id)
}

#[tauri::command]
pub fn get_active_schedules(
    state: State<'_, AppState>,
) -> Result<Vec<ObservationSchedule>, String> {
    get_active_schedules_core(&state.db, &state.user_id)
}

#[tauri::command]
pub fn get_schedule(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<ObservationSchedule>, String> {
    get_schedule_core(&state.db, &state.user_id, &id)
}

#[tauri::command]
pub fn create_schedule(
    state: State<'_, AppState>,
    input: CreateScheduleInput,
) -> Result<ObservationSchedule, String> {
    create_schedule_core(&state.db, &state.user_id, input)
}

#[tauri::command]
pub fn update_schedule(
    state: State<'_, AppState>,
    input: UpdateScheduleInput,
) -> Result<ObservationSchedule, String> {
    update_schedule_core(&state.db, &state.user_id, input)
}

#[tauri::command]
pub fn delete_schedule(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    delete_schedule_core(&state.db, &state.user_id, &id)
}

#[tauri::command]
pub fn add_schedule_item(
    state: State<'_, AppState>,
    schedule_id: String,
    item: ScheduleItem,
) -> Result<ObservationSchedule, String> {
    add_schedule_item_core(&state.db, &state.user_id, &schedule_id, item)
}

#[tauri::command]
pub fn remove_schedule_item(
    state: State<'_, AppState>,
    schedule_id: String,
    item_id: String,
) -> Result<ObservationSchedule, String> {
    remove_schedule_item_core(&state.db, &state.user_id, &schedule_id, &item_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::{insert_user, test_pool};

    fn make_schedule(db: &DbPool, user: &str, name: &str, active: bool) -> ObservationSchedule {
        create_schedule_core(
            db,
            user,
            CreateScheduleInput {
                name: name.to_string(),
                description: None,
                scheduled_date: None,
                location: None,
                is_active: Some(active),
                equipment_id: None,
            },
        )
        .unwrap()
    }

    fn make_item(id: &str, start: &str) -> ScheduleItem {
        ScheduleItem {
            id: id.to_string(),
            todo_id: format!("todo-{id}"),
            object_name: "M42".to_string(),
            start_time: start.to_string(),
            end_time: "23:59".to_string(),
            priority: 1,
            notes: None,
            completed: false,
        }
    }

    #[test]
    fn schedule_crud_and_items_round_trip_core() {
        let db = test_pool();
        insert_user(&db, "alice");

        let created = make_schedule(&db, "alice", "July new moon", true);
        assert_eq!(created.items, "[]");
        assert_eq!(get_schedules_core(&db, "alice").unwrap().len(), 1);
        assert_eq!(
            get_active_schedules_core(&db, "alice").unwrap().len(),
            1
        );

        // Items keep start-time order regardless of insertion order.
        add_schedule_item_core(&db, "alice", &created.id, make_item("b", "22:00")).unwrap();
        let after_add =
            add_schedule_item_core(&db, "alice", &created.id, make_item("a", "21:00")).unwrap();
        let items: Vec<ScheduleItem> = serde_json::from_str(&after_add.items).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, "a");

        let after_remove =
            remove_schedule_item_core(&db, "alice", &created.id, "b").unwrap();
        let items: Vec<ScheduleItem> = serde_json::from_str(&after_remove.items).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "a");

        let updated = update_schedule_core(
            &db,
            "alice",
            UpdateScheduleInput {
                id: created.id.clone(),
                name: Some("July session".to_string()),
                description: None,
                scheduled_date: None,
                location: None,
                items: None,
                is_active: Some(false),
                equipment_id: None,
            },
        )
        .unwrap();
        assert_eq!(updated.name, "July session");
        assert!(get_active_schedules_core(&db, "alice").unwrap().is_empty());

        assert!(delete_schedule_core(&db, "alice", &created.id).unwrap());
        assert!(get_schedules_core(&db, "alice").unwrap().is_empty());
    }

    #[test]
    fn schedule_cross_user_isolation() {
        let db = test_pool();
        insert_user(&db, "alice");
        insert_user(&db, "bob");

        let alices = make_schedule(&db, "alice", "Dark site trip", true);

        assert!(get_schedule_core(&db, "bob", &alices.id).unwrap().is_none());
        assert!(get_active_schedules_core(&db, "bob").unwrap().is_empty());
        assert!(update_schedule_core(
            &db,
            "bob",
            UpdateScheduleInput {
                id: alices.id.clone(),
                name: Some("hijacked".to_string()),
                description: None,
                scheduled_date: None,
                location: None,
                items: None,
                is_active: None,
                equipment_id: None,
            },
        )
        .is_err());
        assert!(add_schedule_item_core(&db, "bob", &alices.id, make_item("x", "21:00")).is_err());
        assert!(remove_schedule_item_core(&db, "bob", &alices.id, "x").is_err());
        assert!(!delete_schedule_core(&db, "bob", &alices.id).unwrap());

        let still = get_schedule_core(&db, "alice", &alices.id).unwrap().unwrap();
        assert_eq!(still.name, "Dark site trip");
        assert_eq!(still.items, "[]");
    }
}
