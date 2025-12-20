//! Repository functions for database CRUD operations

use diesel::prelude::*;
use diesel::sqlite::SqliteConnection;

use super::models::*;
use super::schema::*;

// ============================================================================
// User Repository
// ============================================================================

pub fn get_user_by_id(conn: &mut SqliteConnection, user_id: &str) -> QueryResult<Option<User>> {
    users::table
        .filter(users::id.eq(user_id))
        .first(conn)
        .optional()
}

pub fn get_default_user(conn: &mut SqliteConnection) -> QueryResult<User> {
    users::table
        .filter(users::id.eq("local-user"))
        .first(conn)
}

pub fn update_user(
    conn: &mut SqliteConnection,
    user_id: &str,
    update: &UpdateUser,
) -> QueryResult<User> {
    diesel::update(users::table.filter(users::id.eq(user_id)))
        .set(update)
        .execute(conn)?;

    users::table.filter(users::id.eq(user_id)).first(conn)
}

// ============================================================================
// Collection Repository
// ============================================================================

pub fn get_collections(conn: &mut SqliteConnection, user_id: &str) -> QueryResult<Vec<Collection>> {
    collections::table
        .filter(collections::user_id.eq(user_id))
        .order(collections::created_at.desc())
        .load(conn)
}

pub fn get_collection_by_id(
    conn: &mut SqliteConnection,
    collection_id: &str,
) -> QueryResult<Option<Collection>> {
    collections::table
        .filter(collections::id.eq(collection_id))
        .first(conn)
        .optional()
}

pub fn create_collection(
    conn: &mut SqliteConnection,
    new_collection: &NewCollection,
) -> QueryResult<Collection> {
    diesel::insert_into(collections::table)
        .values(new_collection)
        .execute(conn)?;

    collections::table
        .filter(collections::id.eq(&new_collection.id))
        .first(conn)
}

pub fn update_collection(
    conn: &mut SqliteConnection,
    collection_id: &str,
    update: &UpdateCollection,
) -> QueryResult<Collection> {
    diesel::update(collections::table.filter(collections::id.eq(collection_id)))
        .set(update)
        .execute(conn)?;

    collections::table
        .filter(collections::id.eq(collection_id))
        .first(conn)
}

pub fn delete_collection(conn: &mut SqliteConnection, collection_id: &str) -> QueryResult<usize> {
    diesel::delete(collections::table.filter(collections::id.eq(collection_id))).execute(conn)
}

// ============================================================================
// Image Repository
// ============================================================================

pub fn get_images_by_user(conn: &mut SqliteConnection, user_id: &str) -> QueryResult<Vec<Image>> {
    images::table
        .filter(images::user_id.eq(user_id))
        .order(images::created_at.desc())
        .load(conn)
}

pub fn get_images_by_collection(
    conn: &mut SqliteConnection,
    collection_id: &str,
) -> QueryResult<Vec<Image>> {
    images::table
        .filter(images::collection_id.eq(collection_id))
        .order(images::created_at.desc())
        .load(conn)
}

pub fn get_image_by_id(
    conn: &mut SqliteConnection,
    image_id: &str,
) -> QueryResult<Option<Image>> {
    images::table
        .filter(images::id.eq(image_id))
        .first(conn)
        .optional()
}

pub fn create_image(conn: &mut SqliteConnection, new_image: &NewImage) -> QueryResult<Image> {
    diesel::insert_into(images::table)
        .values(new_image)
        .execute(conn)?;

    images::table
        .filter(images::id.eq(&new_image.id))
        .first(conn)
}

pub fn update_image(
    conn: &mut SqliteConnection,
    image_id: &str,
    update: &UpdateImage,
) -> QueryResult<Image> {
    diesel::update(images::table.filter(images::id.eq(image_id)))
        .set(update)
        .execute(conn)?;

    images::table.filter(images::id.eq(image_id)).first(conn)
}

pub fn delete_image(conn: &mut SqliteConnection, image_id: &str) -> QueryResult<usize> {
    diesel::delete(images::table.filter(images::id.eq(image_id))).execute(conn)
}

// ============================================================================
// AstronomyTodo Repository
// ============================================================================

pub fn get_todos(conn: &mut SqliteConnection, user_id: &str) -> QueryResult<Vec<AstronomyTodo>> {
    astronomy_todos::table
        .filter(astronomy_todos::user_id.eq(user_id))
        .order(astronomy_todos::created_at.desc())
        .load(conn)
}

pub fn get_todo_by_id(
    conn: &mut SqliteConnection,
    todo_id: &str,
) -> QueryResult<Option<AstronomyTodo>> {
    astronomy_todos::table
        .filter(astronomy_todos::id.eq(todo_id))
        .first(conn)
        .optional()
}

pub fn create_todo(
    conn: &mut SqliteConnection,
    new_todo: &NewAstronomyTodo,
) -> QueryResult<AstronomyTodo> {
    diesel::insert_into(astronomy_todos::table)
        .values(new_todo)
        .execute(conn)?;

    astronomy_todos::table
        .filter(astronomy_todos::id.eq(&new_todo.id))
        .first(conn)
}

pub fn update_todo(
    conn: &mut SqliteConnection,
    todo_id: &str,
    update: &UpdateAstronomyTodo,
) -> QueryResult<AstronomyTodo> {
    diesel::update(astronomy_todos::table.filter(astronomy_todos::id.eq(todo_id)))
        .set(update)
        .execute(conn)?;

    astronomy_todos::table
        .filter(astronomy_todos::id.eq(todo_id))
        .first(conn)
}

pub fn delete_todo(conn: &mut SqliteConnection, todo_id: &str) -> QueryResult<usize> {
    diesel::delete(astronomy_todos::table.filter(astronomy_todos::id.eq(todo_id))).execute(conn)
}

pub fn sync_todos(
    conn: &mut SqliteConnection,
    user_id: &str,
    todos: &[NewAstronomyTodo],
) -> QueryResult<Vec<AstronomyTodo>> {
    // Delete existing todos for user
    diesel::delete(astronomy_todos::table.filter(astronomy_todos::user_id.eq(user_id)))
        .execute(conn)?;

    // Insert all new todos
    for todo in todos {
        diesel::insert_into(astronomy_todos::table)
            .values(todo)
            .execute(conn)?;
    }

    // Return all todos
    astronomy_todos::table
        .filter(astronomy_todos::user_id.eq(user_id))
        .order(astronomy_todos::created_at.desc())
        .load(conn)
}

// ============================================================================
// ObservationSchedule Repository
// ============================================================================

pub fn get_schedules(
    conn: &mut SqliteConnection,
    user_id: &str,
) -> QueryResult<Vec<ObservationSchedule>> {
    observation_schedules::table
        .filter(observation_schedules::user_id.eq(user_id))
        .order(observation_schedules::created_at.desc())
        .load(conn)
}

pub fn get_active_schedule(
    conn: &mut SqliteConnection,
    user_id: &str,
) -> QueryResult<Option<ObservationSchedule>> {
    observation_schedules::table
        .filter(observation_schedules::user_id.eq(user_id))
        .filter(observation_schedules::is_active.eq(true))
        .first(conn)
        .optional()
}

pub fn get_schedule_by_id(
    conn: &mut SqliteConnection,
    schedule_id: &str,
) -> QueryResult<Option<ObservationSchedule>> {
    observation_schedules::table
        .filter(observation_schedules::id.eq(schedule_id))
        .first(conn)
        .optional()
}

pub fn create_schedule(
    conn: &mut SqliteConnection,
    new_schedule: &NewObservationSchedule,
) -> QueryResult<ObservationSchedule> {
    // If this schedule is active, deactivate others first
    if new_schedule.is_active {
        diesel::update(
            observation_schedules::table.filter(
                observation_schedules::user_id
                    .eq(&new_schedule.user_id)
                    .and(observation_schedules::is_active.eq(true)),
            ),
        )
        .set(observation_schedules::is_active.eq(false))
        .execute(conn)?;
    }

    diesel::insert_into(observation_schedules::table)
        .values(new_schedule)
        .execute(conn)?;

    observation_schedules::table
        .filter(observation_schedules::id.eq(&new_schedule.id))
        .first(conn)
}

pub fn update_schedule(
    conn: &mut SqliteConnection,
    schedule_id: &str,
    update: &UpdateObservationSchedule,
) -> QueryResult<ObservationSchedule> {
    // If activating this schedule, deactivate others first
    if update.is_active == Some(true) {
        if let Some(schedule) = get_schedule_by_id(conn, schedule_id)? {
            diesel::update(
                observation_schedules::table.filter(
                    observation_schedules::user_id
                        .eq(&schedule.user_id)
                        .and(observation_schedules::is_active.eq(true))
                        .and(observation_schedules::id.ne(schedule_id)),
                ),
            )
            .set(observation_schedules::is_active.eq(false))
            .execute(conn)?;
        }
    }

    diesel::update(observation_schedules::table.filter(observation_schedules::id.eq(schedule_id)))
        .set(update)
        .execute(conn)?;

    observation_schedules::table
        .filter(observation_schedules::id.eq(schedule_id))
        .first(conn)
}

pub fn delete_schedule(conn: &mut SqliteConnection, schedule_id: &str) -> QueryResult<usize> {
    diesel::delete(observation_schedules::table.filter(observation_schedules::id.eq(schedule_id)))
        .execute(conn)
}

// ============================================================================
// SimbadCache Repository
// ============================================================================

pub fn get_cached_object(
    conn: &mut SqliteConnection,
    object_name: &str,
) -> QueryResult<Option<SimbadCache>> {
    simbad_cache::table
        .filter(simbad_cache::object_name.eq(object_name))
        .first(conn)
        .optional()
}

pub fn cache_object(conn: &mut SqliteConnection, cache_entry: &NewSimbadCache) -> QueryResult<()> {
    diesel::insert_into(simbad_cache::table)
        .values(cache_entry)
        .on_conflict(simbad_cache::object_name)
        .do_update()
        .set((
            simbad_cache::data.eq(&cache_entry.data),
            simbad_cache::cached_at.eq(diesel::dsl::now),
        ))
        .execute(conn)?;
    Ok(())
}
