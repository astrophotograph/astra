//! Schedule commands for managing observation schedules

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::models::{NewObservationSchedule, ObservationSchedule, ScheduleItem, UpdateObservationSchedule};
use crate::db::repository;
use crate::state::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateScheduleInput {
    pub name: String,
    pub description: Option<String>,
    pub scheduled_date: Option<String>,
    pub location: Option<String>,
    pub is_active: Option<bool>,
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
}

#[tauri::command]
pub fn get_schedules(state: State<'_, AppState>) -> Result<Vec<ObservationSchedule>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    repository::get_schedules(&mut conn, &state.user_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_active_schedule(
    state: State<'_, AppState>,
) -> Result<Option<ObservationSchedule>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    repository::get_active_schedule(&mut conn, &state.user_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_schedule(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<ObservationSchedule>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    repository::get_schedule_by_id(&mut conn, &id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_schedule(
    state: State<'_, AppState>,
    input: CreateScheduleInput,
) -> Result<ObservationSchedule, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;

    let new_schedule = NewObservationSchedule {
        id: uuid::Uuid::new_v4().to_string(),
        user_id: state.user_id.clone(),
        name: input.name,
        description: input.description,
        scheduled_date: input.scheduled_date,
        location: input.location,
        items: "[]".to_string(),
        is_active: input.is_active.unwrap_or(false),
    };

    repository::create_schedule(&mut conn, &new_schedule)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_schedule(
    state: State<'_, AppState>,
    input: UpdateScheduleInput,
) -> Result<ObservationSchedule, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;

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
    };

    repository::update_schedule(&mut conn, &input.id, &update)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_schedule(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    repository::delete_schedule(&mut conn, &id)
        .map(|count| count > 0)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_schedule_item(
    state: State<'_, AppState>,
    schedule_id: String,
    item: ScheduleItem,
) -> Result<ObservationSchedule, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;

    // Get current schedule
    let schedule = repository::get_schedule_by_id(&mut conn, &schedule_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Schedule not found".to_string())?;

    // Parse existing items and add new one
    let mut items: Vec<ScheduleItem> =
        serde_json::from_str(&schedule.items).unwrap_or_default();
    items.push(item);

    // Sort by start time
    items.sort_by(|a, b| a.start_time.cmp(&b.start_time));

    let update = UpdateObservationSchedule {
        items: Some(serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string())),
        ..Default::default()
    };

    repository::update_schedule(&mut conn, &schedule_id, &update)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_schedule_item(
    state: State<'_, AppState>,
    schedule_id: String,
    item_id: String,
) -> Result<ObservationSchedule, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;

    // Get current schedule
    let schedule = repository::get_schedule_by_id(&mut conn, &schedule_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Schedule not found".to_string())?;

    // Parse existing items and remove the specified one
    let mut items: Vec<ScheduleItem> =
        serde_json::from_str(&schedule.items).unwrap_or_default();
    items.retain(|i| i.id != item_id);

    let update = UpdateObservationSchedule {
        items: Some(serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string())),
        ..Default::default()
    };

    repository::update_schedule(&mut conn, &schedule_id, &update)
        .map_err(|e| e.to_string())
}
