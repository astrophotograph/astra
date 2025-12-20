//! Database models for Astra
//!
//! These structs map to the database tables defined in schema.rs

use chrono::NaiveDateTime;
use diesel::prelude::*;
use serde::{Deserialize, Serialize};

use super::schema::*;

// ============================================================================
// User
// ============================================================================

#[derive(Debug, Clone, Queryable, Selectable, Serialize, Deserialize)]
#[diesel(table_name = users)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct User {
    pub id: String,
    pub email: Option<String>,
    pub name: Option<String>,
    pub image: Option<String>,
    pub username: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub summary: Option<String>,
    pub bio: Option<String>,
    pub description: Option<String>,
    pub metadata: Option<String>,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

#[derive(Debug, Clone, Insertable, Serialize, Deserialize)]
#[diesel(table_name = users)]
pub struct NewUser {
    pub id: String,
    pub email: Option<String>,
    pub name: Option<String>,
    pub image: Option<String>,
    pub username: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
}

#[derive(Debug, Clone, AsChangeset, Serialize, Deserialize)]
#[diesel(table_name = users)]
pub struct UpdateUser {
    pub email: Option<String>,
    pub name: Option<String>,
    pub image: Option<String>,
    pub username: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub summary: Option<String>,
    pub bio: Option<String>,
    pub description: Option<String>,
    pub metadata: Option<String>,
}

// ============================================================================
// Collection
// ============================================================================

#[derive(Debug, Clone, Queryable, Selectable, Serialize, Deserialize)]
#[diesel(table_name = collections)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct Collection {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub description: Option<String>,
    pub visibility: String,
    pub template: Option<String>,
    pub favorite: bool,
    pub tags: Option<String>,
    pub metadata: Option<String>,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

#[derive(Debug, Clone, Insertable, Serialize, Deserialize)]
#[diesel(table_name = collections)]
pub struct NewCollection {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub description: Option<String>,
    pub visibility: String,
    pub template: Option<String>,
    pub favorite: bool,
    pub tags: Option<String>,
    pub metadata: Option<String>,
}

#[derive(Debug, Clone, AsChangeset, Serialize, Deserialize, Default)]
#[diesel(table_name = collections)]
pub struct UpdateCollection {
    pub name: Option<String>,
    pub description: Option<String>,
    pub visibility: Option<String>,
    pub template: Option<String>,
    pub favorite: Option<bool>,
    pub tags: Option<String>,
    pub metadata: Option<String>,
}

// ============================================================================
// Image
// ============================================================================

#[derive(Debug, Clone, Queryable, Selectable, Serialize, Deserialize)]
#[diesel(table_name = images)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct Image {
    pub id: String,
    pub user_id: String,
    pub collection_id: Option<String>,
    pub filename: String,
    pub url: Option<String>,
    pub summary: Option<String>,
    pub description: Option<String>,
    pub content_type: Option<String>,
    pub favorite: bool,
    pub tags: Option<String>,
    pub visibility: Option<String>,
    pub location: Option<String>,
    pub annotations: Option<String>,
    pub metadata: Option<String>,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

#[derive(Debug, Clone, Insertable, Serialize, Deserialize)]
#[diesel(table_name = images)]
pub struct NewImage {
    pub id: String,
    pub user_id: String,
    pub collection_id: Option<String>,
    pub filename: String,
    pub url: Option<String>,
    pub summary: Option<String>,
    pub description: Option<String>,
    pub content_type: Option<String>,
    pub favorite: bool,
    pub tags: Option<String>,
    pub visibility: Option<String>,
    pub location: Option<String>,
    pub annotations: Option<String>,
    pub metadata: Option<String>,
}

#[derive(Debug, Clone, AsChangeset, Serialize, Deserialize, Default)]
#[diesel(table_name = images)]
pub struct UpdateImage {
    pub collection_id: Option<String>,
    pub filename: Option<String>,
    pub url: Option<String>,
    pub summary: Option<String>,
    pub description: Option<String>,
    pub content_type: Option<String>,
    pub favorite: Option<bool>,
    pub tags: Option<String>,
    pub visibility: Option<String>,
    pub location: Option<String>,
    pub annotations: Option<String>,
    pub metadata: Option<String>,
}

// ============================================================================
// AstronomyTodo
// ============================================================================

#[derive(Debug, Clone, Queryable, Selectable, Serialize, Deserialize)]
#[diesel(table_name = astronomy_todos)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct AstronomyTodo {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub ra: String,
    pub dec: String,
    pub magnitude: String,
    pub size: String,
    pub object_type: Option<String>,
    pub added_at: String,
    pub completed: bool,
    pub completed_at: Option<String>,
    pub goal_time: Option<String>,
    pub notes: Option<String>,
    pub flagged: bool,
    pub last_updated: Option<String>,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

#[derive(Debug, Clone, Insertable, Serialize, Deserialize)]
#[diesel(table_name = astronomy_todos)]
pub struct NewAstronomyTodo {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub ra: String,
    pub dec: String,
    pub magnitude: String,
    pub size: String,
    pub object_type: Option<String>,
    pub added_at: String,
    pub completed: bool,
    pub completed_at: Option<String>,
    pub goal_time: Option<String>,
    pub notes: Option<String>,
    pub flagged: bool,
    pub last_updated: Option<String>,
}

#[derive(Debug, Clone, AsChangeset, Serialize, Deserialize, Default)]
#[diesel(table_name = astronomy_todos)]
pub struct UpdateAstronomyTodo {
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
    pub last_updated: Option<String>,
}

// ============================================================================
// ObservationSchedule
// ============================================================================

#[derive(Debug, Clone, Queryable, Selectable, Serialize, Deserialize)]
#[diesel(table_name = observation_schedules)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct ObservationSchedule {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub description: Option<String>,
    pub scheduled_date: Option<String>,
    pub location: Option<String>,
    pub items: String,
    pub is_active: bool,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

#[derive(Debug, Clone, Insertable, Serialize, Deserialize)]
#[diesel(table_name = observation_schedules)]
pub struct NewObservationSchedule {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub description: Option<String>,
    pub scheduled_date: Option<String>,
    pub location: Option<String>,
    pub items: String,
    pub is_active: bool,
}

#[derive(Debug, Clone, AsChangeset, Serialize, Deserialize, Default)]
#[diesel(table_name = observation_schedules)]
pub struct UpdateObservationSchedule {
    pub name: Option<String>,
    pub description: Option<String>,
    pub scheduled_date: Option<String>,
    pub location: Option<String>,
    pub items: Option<String>,
    pub is_active: Option<bool>,
}

/// Schedule item stored as JSON in the items field
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleItem {
    pub id: String,
    pub todo_id: String,
    pub object_name: String,
    pub start_time: String,
    pub end_time: String,
    pub priority: i32,
    pub notes: Option<String>,
    pub completed: bool,
}

// ============================================================================
// AstroObject (catalog cache)
// ============================================================================

#[derive(Debug, Clone, Queryable, Selectable, Serialize, Deserialize)]
#[diesel(table_name = astro_objects)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct AstroObject {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub object_type: Option<String>,
    pub seq: Option<i32>,
    pub aliases: Option<String>,
    pub notes: Option<String>,
    pub metadata: Option<String>,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

#[derive(Debug, Clone, Insertable, Serialize, Deserialize)]
#[diesel(table_name = astro_objects)]
pub struct NewAstroObject {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub object_type: Option<String>,
    pub seq: Option<i32>,
    pub aliases: Option<String>,
    pub notes: Option<String>,
    pub metadata: Option<String>,
}

// ============================================================================
// SimbadCache
// ============================================================================

#[derive(Debug, Clone, Queryable, Selectable, Serialize, Deserialize)]
#[diesel(table_name = simbad_cache)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct SimbadCache {
    pub id: String,
    pub object_name: String,
    pub data: String,
    pub cached_at: NaiveDateTime,
}

#[derive(Debug, Clone, Insertable, Serialize, Deserialize)]
#[diesel(table_name = simbad_cache)]
pub struct NewSimbadCache {
    pub id: String,
    pub object_name: String,
    pub data: String,
}
