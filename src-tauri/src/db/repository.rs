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

pub fn get_collection_by_name(
    conn: &mut SqliteConnection,
    user_id: &str,
    name: &str,
) -> QueryResult<Option<Collection>> {
    collections::table
        .filter(collections::user_id.eq(user_id))
        .filter(collections::name.eq(name))
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
    // Also delete from collection_images join table (cascade should handle this, but be explicit)
    diesel::delete(collection_images::table.filter(collection_images::collection_id.eq(collection_id)))
        .execute(conn)?;
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

pub fn get_image_by_url(
    conn: &mut SqliteConnection,
    url: &str,
) -> QueryResult<Option<Image>> {
    images::table
        .filter(images::url.eq(url))
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
    // Also delete from collection_images join table
    diesel::delete(collection_images::table.filter(collection_images::image_id.eq(image_id)))
        .execute(conn)?;
    diesel::delete(images::table.filter(images::id.eq(image_id))).execute(conn)
}

// ============================================================================
// CollectionImage Repository (Many-to-Many)
// ============================================================================

/// Add an image to a collection
pub fn add_image_to_collection(
    conn: &mut SqliteConnection,
    new_entry: &NewCollectionImage,
) -> QueryResult<CollectionImage> {
    diesel::insert_into(collection_images::table)
        .values(new_entry)
        .execute(conn)?;

    collection_images::table
        .filter(collection_images::id.eq(&new_entry.id))
        .first(conn)
}

/// Remove an image from a collection
pub fn remove_image_from_collection(
    conn: &mut SqliteConnection,
    collection_id: &str,
    image_id: &str,
) -> QueryResult<usize> {
    diesel::delete(
        collection_images::table
            .filter(collection_images::collection_id.eq(collection_id))
            .filter(collection_images::image_id.eq(image_id)),
    )
    .execute(conn)
}

/// Get all images in a collection (via join table)
pub fn get_collection_image_ids(
    conn: &mut SqliteConnection,
    collection_id: &str,
) -> QueryResult<Vec<String>> {
    log::info!("get_collection_image_ids: querying for collection_id {}", collection_id);
    let result = collection_images::table
        .filter(collection_images::collection_id.eq(collection_id))
        .select(collection_images::image_id)
        .load(conn);
    match &result {
        Ok(ids) => log::info!("get_collection_image_ids: found {} ids", ids.len()),
        Err(e) => log::error!("get_collection_image_ids: error: {}", e),
    }
    result
}

/// Get all collections an image belongs to
pub fn get_image_collection_ids(
    conn: &mut SqliteConnection,
    image_id: &str,
) -> QueryResult<Vec<String>> {
    collection_images::table
        .filter(collection_images::image_id.eq(image_id))
        .select(collection_images::collection_id)
        .load(conn)
}

/// Get images for a collection with full image data
pub fn get_images_in_collection(
    conn: &mut SqliteConnection,
    collection_id: &str,
) -> QueryResult<Vec<Image>> {
    log::info!("get_images_in_collection: looking up image_ids for collection {}", collection_id);
    let image_ids = get_collection_image_ids(conn, collection_id)?;
    log::info!("get_images_in_collection: found {} image_ids: {:?}", image_ids.len(), image_ids);

    if image_ids.is_empty() {
        log::info!("get_images_in_collection: no images found, returning empty vec");
        return Ok(vec![]);
    }

    let result = images::table
        .filter(images::id.eq_any(image_ids))
        .order(images::created_at.desc())
        .load(conn);

    match &result {
        Ok(imgs) => log::info!("get_images_in_collection: query returned {} images", imgs.len()),
        Err(e) => log::error!("get_images_in_collection: query error: {}", e),
    }

    result
}

/// Get collections for an image with full collection data
pub fn get_collections_for_image(
    conn: &mut SqliteConnection,
    image_id: &str,
) -> QueryResult<Vec<Collection>> {
    let collection_ids = get_image_collection_ids(conn, image_id)?;

    if collection_ids.is_empty() {
        return Ok(vec![]);
    }

    collections::table
        .filter(collections::id.eq_any(collection_ids))
        .order(collections::created_at.desc())
        .load(conn)
}

/// Get count of images in a collection
pub fn get_collection_image_count(
    conn: &mut SqliteConnection,
    collection_id: &str,
) -> QueryResult<i64> {
    collection_images::table
        .filter(collection_images::collection_id.eq(collection_id))
        .count()
        .get_result(conn)
}

/// Check if an image is in a collection
pub fn is_image_in_collection(
    conn: &mut SqliteConnection,
    collection_id: &str,
    image_id: &str,
) -> QueryResult<bool> {
    let count: i64 = collection_images::table
        .filter(collection_images::collection_id.eq(collection_id))
        .filter(collection_images::image_id.eq(image_id))
        .count()
        .get_result(conn)?;
    Ok(count > 0)
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
