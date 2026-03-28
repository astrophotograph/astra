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

/// Get all image URLs for a user (for efficient duplicate checking during bulk import)
pub fn get_all_image_urls(
    conn: &mut SqliteConnection,
    user_id: &str,
) -> QueryResult<Vec<String>> {
    images::table
        .filter(images::user_id.eq(user_id))
        .filter(images::url.is_not_null())
        .select(images::url)
        .load::<Option<String>>(conn)
        .map(|urls| urls.into_iter().flatten().collect())
}

/// Get all FITS URLs for a user (for efficient duplicate checking during auto-import)
pub fn get_all_fits_urls(
    conn: &mut SqliteConnection,
    user_id: &str,
) -> QueryResult<Vec<String>> {
    images::table
        .filter(images::user_id.eq(user_id))
        .filter(images::fits_url.is_not_null())
        .select(images::fits_url)
        .load::<Option<String>>(conn)
        .map(|v| v.into_iter().flatten().collect())
}

/// Get all unique non-null tags from images
pub fn get_all_tags(conn: &mut SqliteConnection, user_id: &str) -> QueryResult<Vec<String>> {
    images::table
        .filter(images::user_id.eq(user_id))
        .filter(images::tags.is_not_null())
        .select(images::tags)
        .load::<Option<String>>(conn)
        .map(|v| v.into_iter().flatten().collect())
}

/// Get all non-null metadata from images (for extracting cameras etc.)
pub fn get_all_metadata(conn: &mut SqliteConnection, user_id: &str) -> QueryResult<Vec<String>> {
    images::table
        .filter(images::user_id.eq(user_id))
        .filter(images::metadata.is_not_null())
        .select(images::metadata)
        .load::<Option<String>>(conn)
        .map(|v| v.into_iter().flatten().collect())
}

/// Get all collection-image mappings for efficient duplicate checking
pub fn get_all_collection_image_pairs(
    conn: &mut SqliteConnection,
) -> QueryResult<Vec<(String, String)>> {
    collection_images::table
        .select((collection_images::collection_id, collection_images::image_id))
        .load(conn)
}

/// Get image ID by URL (returns just the ID for efficiency)
pub fn get_image_id_by_url(
    conn: &mut SqliteConnection,
    url: &str,
) -> QueryResult<Option<String>> {
    images::table
        .filter(images::url.eq(url))
        .select(images::id)
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

/// Get all active schedules for a user (one per equipment set)
pub fn get_active_schedules(
    conn: &mut SqliteConnection,
    user_id: &str,
) -> QueryResult<Vec<ObservationSchedule>> {
    observation_schedules::table
        .filter(observation_schedules::user_id.eq(user_id))
        .filter(observation_schedules::is_active.eq(true))
        .order(observation_schedules::created_at.desc())
        .load(conn)
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
    // If this schedule is active, deactivate other schedules with the same equipment_id
    if new_schedule.is_active {
        // Only deactivate schedules with matching equipment_id (or both null)
        if let Some(ref eq_id) = new_schedule.equipment_id {
            // Deactivate schedules with the same equipment_id
            diesel::update(
                observation_schedules::table.filter(
                    observation_schedules::user_id
                        .eq(&new_schedule.user_id)
                        .and(observation_schedules::is_active.eq(true))
                        .and(observation_schedules::equipment_id.eq(eq_id)),
                ),
            )
            .set(observation_schedules::is_active.eq(false))
            .execute(conn)?;
        } else {
            // Deactivate schedules with null equipment_id
            diesel::update(
                observation_schedules::table.filter(
                    observation_schedules::user_id
                        .eq(&new_schedule.user_id)
                        .and(observation_schedules::is_active.eq(true))
                        .and(observation_schedules::equipment_id.is_null()),
                ),
            )
            .set(observation_schedules::is_active.eq(false))
            .execute(conn)?;
        }
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
    // If activating this schedule, deactivate other schedules with the same equipment_id
    if update.is_active == Some(true) {
        if let Some(schedule) = get_schedule_by_id(conn, schedule_id)? {
            // Determine which equipment_id to match:
            // If update has equipment_id set, use that; otherwise use the existing schedule's equipment_id
            let effective_equipment_id = update.equipment_id.as_ref().or(schedule.equipment_id.as_ref());

            if let Some(eq_id) = effective_equipment_id {
                // Deactivate schedules with the same equipment_id (excluding this one)
                diesel::update(
                    observation_schedules::table.filter(
                        observation_schedules::user_id
                            .eq(&schedule.user_id)
                            .and(observation_schedules::is_active.eq(true))
                            .and(observation_schedules::id.ne(schedule_id))
                            .and(observation_schedules::equipment_id.eq(eq_id)),
                    ),
                )
                .set(observation_schedules::is_active.eq(false))
                .execute(conn)?;
            } else {
                // Deactivate schedules with null equipment_id (excluding this one)
                diesel::update(
                    observation_schedules::table.filter(
                        observation_schedules::user_id
                            .eq(&schedule.user_id)
                            .and(observation_schedules::is_active.eq(true))
                            .and(observation_schedules::id.ne(schedule_id))
                            .and(observation_schedules::equipment_id.is_null()),
                    ),
                )
                .set(observation_schedules::is_active.eq(false))
                .execute(conn)?;
            }
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

// ============================================================================
// Target Browser Repository - Aggregate images by target/object
// ============================================================================

/// A target with its image count
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetWithCount {
    pub name: String,
    pub image_count: i64,
    pub latest_image_id: Option<String>,
    pub latest_thumbnail: Option<String>,
}

/// Extract object names from annotations JSON
fn extract_annotation_names(annotations: &str) -> Vec<String> {
    if let Ok(parsed) = serde_json::from_str::<Vec<serde_json::Value>>(annotations) {
        parsed
            .iter()
            .filter_map(|ann| ann.get("name").and_then(|n| n.as_str()).map(String::from))
            .collect()
    } else {
        vec![]
    }
}

/// Get unique targets (from summary and annotations) with image counts
pub fn get_targets_with_counts(
    conn: &mut SqliteConnection,
    user_id: &str,
) -> QueryResult<Vec<TargetWithCount>> {
    // Get all images for this user
    let images = images::table
        .filter(images::user_id.eq(user_id))
        .order(images::created_at.desc())
        .load::<Image>(conn)?;

    // Group by target name (from summary and annotations) and count
    // Key: target name, Value: (count, latest_image_id, latest_thumbnail)
    let mut target_map: std::collections::HashMap<String, (i64, Option<String>, Option<String>)> =
        std::collections::HashMap::new();

    for image in &images {
        // Collect all target names for this image
        let mut target_names: Vec<String> = Vec::new();

        // Add summary if present
        if let Some(summary) = &image.summary {
            let trimmed = summary.trim();
            if !trimmed.is_empty() {
                target_names.push(trimmed.to_string());
            }
        }

        // Add names from annotations (plate solving results)
        if let Some(annotations) = &image.annotations {
            target_names.extend(extract_annotation_names(annotations));
        }

        // Update counts for each target name
        for name in target_names {
            let entry = target_map.entry(name).or_insert((0, None, None));
            entry.0 += 1;
            // Keep the first (most recent) image's id and thumbnail
            if entry.1.is_none() {
                entry.1 = Some(image.id.clone());
                entry.2 = image.thumbnail.clone();
            }
        }
    }

    // Convert to vec and sort by count descending
    let mut targets: Vec<TargetWithCount> = target_map
        .into_iter()
        .map(|(name, (count, latest_id, thumbnail))| TargetWithCount {
            name,
            image_count: count,
            latest_image_id: latest_id,
            latest_thumbnail: thumbnail,
        })
        .collect();

    targets.sort_by(|a, b| b.image_count.cmp(&a.image_count));
    Ok(targets)
}

/// Search images by target name (partial match in summary or annotations)
pub fn search_images_by_target(
    conn: &mut SqliteConnection,
    user_id: &str,
    query: &str,
) -> QueryResult<Vec<Image>> {
    let pattern = format!("%{}%", query);
    // Search in both summary and annotations fields
    images::table
        .filter(images::user_id.eq(user_id))
        .filter(
            images::summary.like(&pattern)
                .or(images::annotations.like(&pattern))
        )
        .order(images::created_at.desc())
        .load(conn)
}

/// Get images for a specific target (matches summary or annotation names)
pub fn get_images_by_target(
    conn: &mut SqliteConnection,
    user_id: &str,
    target_name: &str,
) -> QueryResult<Vec<Image>> {
    // First try exact match on summary
    let mut results: Vec<Image> = images::table
        .filter(images::user_id.eq(user_id))
        .filter(images::summary.eq(target_name))
        .order(images::created_at.desc())
        .load(conn)?;

    // Also search in annotations - use LIKE since it's JSON
    // This pattern matches the target name in annotations JSON
    let annotation_pattern = format!("%\"name\":\"{}%", target_name);
    let annotation_results: Vec<Image> = images::table
        .filter(images::user_id.eq(user_id))
        .filter(images::annotations.like(&annotation_pattern))
        .order(images::created_at.desc())
        .load(conn)?;

    // Merge results, avoiding duplicates
    let existing_ids: std::collections::HashSet<String> = results.iter().map(|i| i.id.clone()).collect();
    for image in annotation_results {
        if !existing_ids.contains(&image.id) {
            results.push(image);
        }
    }

    // Sort by created_at descending
    results.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(results)
}

// ============================================================================
// ScannedDirectory Repository - Directory scan caching
// ============================================================================

/// Get a scanned directory entry by path
pub fn get_scanned_directory(
    conn: &mut SqliteConnection,
    user_id: &str,
    path: &str,
) -> QueryResult<Option<ScannedDirectory>> {
    scanned_directories::table
        .filter(scanned_directories::user_id.eq(user_id))
        .filter(scanned_directories::path.eq(path))
        .first(conn)
        .optional()
}

/// Get all scanned directories for a user that are subdirectories of a given path
pub fn get_scanned_subdirectories(
    conn: &mut SqliteConnection,
    user_id: &str,
    parent_path: &str,
) -> QueryResult<Vec<ScannedDirectory>> {
    // Use LIKE to find all paths that start with the parent path
    let pattern = format!("{}%", parent_path);
    scanned_directories::table
        .filter(scanned_directories::user_id.eq(user_id))
        .filter(scanned_directories::path.like(pattern))
        .load(conn)
}

/// Create or update a scanned directory entry
pub fn upsert_scanned_directory(
    conn: &mut SqliteConnection,
    entry: &NewScannedDirectory,
) -> QueryResult<()> {
    diesel::insert_into(scanned_directories::table)
        .values(entry)
        .on_conflict((scanned_directories::user_id, scanned_directories::path))
        .do_update()
        .set((
            scanned_directories::fs_modified_at.eq(&entry.fs_modified_at),
            scanned_directories::last_scanned_at.eq(&entry.last_scanned_at),
            scanned_directories::image_count.eq(&entry.image_count),
        ))
        .execute(conn)?;
    Ok(())
}

/// Delete a scanned directory entry
pub fn delete_scanned_directory(
    conn: &mut SqliteConnection,
    user_id: &str,
    path: &str,
) -> QueryResult<usize> {
    diesel::delete(
        scanned_directories::table
            .filter(scanned_directories::user_id.eq(user_id))
            .filter(scanned_directories::path.eq(path)),
    )
    .execute(conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::*;
    use crate::db::DbPool;
    use diesel::r2d2::{self, ConnectionManager};
    use diesel::sqlite::SqliteConnection;
    use diesel_migrations::{embed_migrations, EmbeddedMigrations, MigrationHarness};

    const MIGRATIONS: EmbeddedMigrations = embed_migrations!("migrations");

    fn setup_test_db() -> DbPool {
        let manager = ConnectionManager::<SqliteConnection>::new(":memory:");
        let pool = r2d2::Pool::builder().max_size(1).build(manager).unwrap();
        let mut conn = pool.get().unwrap();
        conn.run_pending_migrations(MIGRATIONS).unwrap();
        pool
    }

    /// Insert a test user so foreign key constraints are satisfied.
    fn insert_test_user(conn: &mut SqliteConnection, user_id: &str) {
        diesel::insert_into(users::table)
            .values(&NewUser {
                id: user_id.to_string(),
                email: None,
                name: Some("Test User".to_string()),
                image: None,
                username: None,
                first_name: None,
                last_name: None,
            })
            .execute(conn)
            .unwrap();
    }

    // ========================================================================
    // Collection CRUD
    // ========================================================================

    #[test]
    fn collection_create_and_get() {
        let pool = setup_test_db();
        let mut conn = pool.get().unwrap();
        insert_test_user(&mut conn, "user-1");

        let new = NewCollection {
            id: "coll-1".to_string(),
            user_id: "user-1".to_string(),
            name: "My Collection".to_string(),
            description: Some("Test description".to_string()),
            visibility: "private".to_string(),
            template: None,
            favorite: false,
            tags: None,
            metadata: None,
            archived: false,
        };
        let created = create_collection(&mut conn, &new).unwrap();
        assert_eq!(created.name, "My Collection");
        assert_eq!(created.description, Some("Test description".to_string()));

        let fetched = get_collection_by_id(&mut conn, "coll-1").unwrap();
        assert!(fetched.is_some());
        assert_eq!(fetched.unwrap().name, "My Collection");
    }

    #[test]
    fn collection_get_by_name() {
        let pool = setup_test_db();
        let mut conn = pool.get().unwrap();
        insert_test_user(&mut conn, "user-1");

        let new = NewCollection {
            id: "coll-1".to_string(),
            user_id: "user-1".to_string(),
            name: "2026-01-15".to_string(),
            description: None,
            visibility: "private".to_string(),
            template: None,
            favorite: false,
            tags: None,
            metadata: None,
            archived: false,
        };
        create_collection(&mut conn, &new).unwrap();

        let found = get_collection_by_name(&mut conn, "user-1", "2026-01-15").unwrap();
        assert!(found.is_some());

        let not_found = get_collection_by_name(&mut conn, "user-1", "nonexistent").unwrap();
        assert!(not_found.is_none());
    }

    #[test]
    fn collection_update() {
        let pool = setup_test_db();
        let mut conn = pool.get().unwrap();
        insert_test_user(&mut conn, "user-1");

        let new = NewCollection {
            id: "coll-1".to_string(),
            user_id: "user-1".to_string(),
            name: "Original".to_string(),
            description: None,
            visibility: "private".to_string(),
            template: None,
            favorite: false,
            tags: None,
            metadata: None,
            archived: false,
        };
        create_collection(&mut conn, &new).unwrap();

        let update = UpdateCollection {
            name: Some("Updated".to_string()),
            favorite: Some(true),
            ..Default::default()
        };
        let updated = update_collection(&mut conn, "coll-1", &update).unwrap();
        assert_eq!(updated.name, "Updated");
        assert!(updated.favorite);
    }

    #[test]
    fn collection_delete() {
        let pool = setup_test_db();
        let mut conn = pool.get().unwrap();
        insert_test_user(&mut conn, "user-1");

        let new = NewCollection {
            id: "coll-del".to_string(),
            user_id: "user-1".to_string(),
            name: "To Delete".to_string(),
            description: None,
            visibility: "private".to_string(),
            template: None,
            favorite: false,
            tags: None,
            metadata: None,
            archived: false,
        };
        create_collection(&mut conn, &new).unwrap();

        let deleted = delete_collection(&mut conn, "coll-del").unwrap();
        assert_eq!(deleted, 1);

        let fetched = get_collection_by_id(&mut conn, "coll-del").unwrap();
        assert!(fetched.is_none());
    }

    #[test]
    fn collection_list_by_user() {
        let pool = setup_test_db();
        let mut conn = pool.get().unwrap();
        insert_test_user(&mut conn, "user-1");
        insert_test_user(&mut conn, "user-2");

        for i in 0..3 {
            let new = NewCollection {
                id: format!("coll-{}", i),
                user_id: "user-1".to_string(),
                name: format!("Collection {}", i),
                description: None,
                visibility: "private".to_string(),
                template: None,
                favorite: false,
                tags: None,
                metadata: None,
                archived: false,
            };
            create_collection(&mut conn, &new).unwrap();
        }

        let colls = get_collections(&mut conn, "user-1").unwrap();
        assert_eq!(colls.len(), 3);

        let colls2 = get_collections(&mut conn, "user-2").unwrap();
        assert!(colls2.is_empty());
    }

    // ========================================================================
    // Image CRUD
    // ========================================================================

    fn make_new_image(id: &str, user_id: &str) -> NewImage {
        NewImage {
            id: id.to_string(),
            user_id: user_id.to_string(),
            collection_id: None,
            filename: format!("{}.jpg", id),
            url: Some(format!("/images/{}.jpg", id)),
            summary: Some("M42".to_string()),
            description: None,
            content_type: Some("image/jpeg".to_string()),
            favorite: false,
            tags: None,
            visibility: Some("private".to_string()),
            location: None,
            annotations: None,
            metadata: None,
            thumbnail: None,
            fits_url: None,
        }
    }

    #[test]
    fn image_create_and_get_by_id() {
        let pool = setup_test_db();
        let mut conn = pool.get().unwrap();
        insert_test_user(&mut conn, "user-1");

        let new = make_new_image("img-1", "user-1");
        let created = create_image(&mut conn, &new).unwrap();
        assert_eq!(created.filename, "img-1.jpg");

        let fetched = get_image_by_id(&mut conn, "img-1").unwrap();
        assert!(fetched.is_some());
        assert_eq!(fetched.unwrap().summary, Some("M42".to_string()));
    }

    #[test]
    fn image_get_by_url() {
        let pool = setup_test_db();
        let mut conn = pool.get().unwrap();
        insert_test_user(&mut conn, "user-1");

        let new = make_new_image("img-url", "user-1");
        create_image(&mut conn, &new).unwrap();

        let found = get_image_by_url(&mut conn, "/images/img-url.jpg").unwrap();
        assert!(found.is_some());
        assert_eq!(found.unwrap().id, "img-url");

        let not_found = get_image_by_url(&mut conn, "/nonexistent.jpg").unwrap();
        assert!(not_found.is_none());
    }

    #[test]
    fn image_delete() {
        let pool = setup_test_db();
        let mut conn = pool.get().unwrap();
        insert_test_user(&mut conn, "user-1");

        let new = make_new_image("img-del", "user-1");
        create_image(&mut conn, &new).unwrap();

        let deleted = delete_image(&mut conn, "img-del").unwrap();
        assert_eq!(deleted, 1);

        let fetched = get_image_by_id(&mut conn, "img-del").unwrap();
        assert!(fetched.is_none());
    }

    // ========================================================================
    // Collection-Image relationships
    // ========================================================================

    #[test]
    fn add_and_check_image_in_collection() {
        let pool = setup_test_db();
        let mut conn = pool.get().unwrap();
        insert_test_user(&mut conn, "user-1");

        let coll = NewCollection {
            id: "coll-1".to_string(),
            user_id: "user-1".to_string(),
            name: "Session".to_string(),
            description: None,
            visibility: "private".to_string(),
            template: None,
            favorite: false,
            tags: None,
            metadata: None,
            archived: false,
        };
        create_collection(&mut conn, &coll).unwrap();

        let img = make_new_image("img-1", "user-1");
        create_image(&mut conn, &img).unwrap();

        // Not in collection yet
        assert!(!is_image_in_collection(&mut conn, "coll-1", "img-1").unwrap());

        // Add to collection
        let entry = NewCollectionImage {
            id: "ci-1".to_string(),
            collection_id: "coll-1".to_string(),
            image_id: "img-1".to_string(),
        };
        add_image_to_collection(&mut conn, &entry).unwrap();

        // Now in collection
        assert!(is_image_in_collection(&mut conn, "coll-1", "img-1").unwrap());

        // Check count
        let count = get_collection_image_count(&mut conn, "coll-1").unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn remove_image_from_collection_works() {
        let pool = setup_test_db();
        let mut conn = pool.get().unwrap();
        insert_test_user(&mut conn, "user-1");

        let coll = NewCollection {
            id: "coll-1".to_string(),
            user_id: "user-1".to_string(),
            name: "Session".to_string(),
            description: None,
            visibility: "private".to_string(),
            template: None,
            favorite: false,
            tags: None,
            metadata: None,
            archived: false,
        };
        create_collection(&mut conn, &coll).unwrap();

        let img = make_new_image("img-1", "user-1");
        create_image(&mut conn, &img).unwrap();

        let entry = NewCollectionImage {
            id: "ci-1".to_string(),
            collection_id: "coll-1".to_string(),
            image_id: "img-1".to_string(),
        };
        add_image_to_collection(&mut conn, &entry).unwrap();
        assert!(is_image_in_collection(&mut conn, "coll-1", "img-1").unwrap());

        remove_image_from_collection(&mut conn, "coll-1", "img-1").unwrap();
        assert!(!is_image_in_collection(&mut conn, "coll-1", "img-1").unwrap());
    }

    #[test]
    fn get_images_in_collection_returns_images() {
        let pool = setup_test_db();
        let mut conn = pool.get().unwrap();
        insert_test_user(&mut conn, "user-1");

        let coll = NewCollection {
            id: "coll-1".to_string(),
            user_id: "user-1".to_string(),
            name: "Session".to_string(),
            description: None,
            visibility: "private".to_string(),
            template: None,
            favorite: false,
            tags: None,
            metadata: None,
            archived: false,
        };
        create_collection(&mut conn, &coll).unwrap();

        for i in 0..3 {
            let img = make_new_image(&format!("img-{}", i), "user-1");
            create_image(&mut conn, &img).unwrap();
            let entry = NewCollectionImage {
                id: format!("ci-{}", i),
                collection_id: "coll-1".to_string(),
                image_id: format!("img-{}", i),
            };
            add_image_to_collection(&mut conn, &entry).unwrap();
        }

        let images = get_images_in_collection(&mut conn, "coll-1").unwrap();
        assert_eq!(images.len(), 3);
    }

    // ========================================================================
    // Todo CRUD
    // ========================================================================

    fn make_new_todo(id: &str, user_id: &str, name: &str) -> NewAstronomyTodo {
        NewAstronomyTodo {
            id: id.to_string(),
            user_id: user_id.to_string(),
            name: name.to_string(),
            ra: "05h35m17s".to_string(),
            dec: "-05d23m28s".to_string(),
            magnitude: "4.0".to_string(),
            size: "85'".to_string(),
            object_type: Some("Nebula".to_string()),
            added_at: "2026-01-15T00:00:00Z".to_string(),
            completed: false,
            completed_at: None,
            goal_time: None,
            notes: None,
            flagged: false,
            last_updated: None,
            tags: None,
        }
    }

    #[test]
    fn todo_create_and_get() {
        let pool = setup_test_db();
        let mut conn = pool.get().unwrap();
        insert_test_user(&mut conn, "user-1");

        let new = make_new_todo("todo-1", "user-1", "M42");
        let created = create_todo(&mut conn, &new).unwrap();
        assert_eq!(created.name, "M42");
        assert!(!created.completed);

        let fetched = get_todo_by_id(&mut conn, "todo-1").unwrap();
        assert!(fetched.is_some());
    }

    #[test]
    fn todo_update() {
        let pool = setup_test_db();
        let mut conn = pool.get().unwrap();
        insert_test_user(&mut conn, "user-1");

        let new = make_new_todo("todo-1", "user-1", "M42");
        create_todo(&mut conn, &new).unwrap();

        let update = UpdateAstronomyTodo {
            completed: Some(true),
            notes: Some("Great view tonight!".to_string()),
            ..Default::default()
        };
        let updated = update_todo(&mut conn, "todo-1", &update).unwrap();
        assert!(updated.completed);
        assert_eq!(updated.notes, Some("Great view tonight!".to_string()));
    }

    #[test]
    fn todo_delete() {
        let pool = setup_test_db();
        let mut conn = pool.get().unwrap();
        insert_test_user(&mut conn, "user-1");

        let new = make_new_todo("todo-del", "user-1", "M31");
        create_todo(&mut conn, &new).unwrap();

        let deleted = delete_todo(&mut conn, "todo-del").unwrap();
        assert_eq!(deleted, 1);

        let fetched = get_todo_by_id(&mut conn, "todo-del").unwrap();
        assert!(fetched.is_none());
    }

    #[test]
    fn todo_list_by_user() {
        let pool = setup_test_db();
        let mut conn = pool.get().unwrap();
        insert_test_user(&mut conn, "user-1");

        for i in 0..3 {
            let new = make_new_todo(&format!("todo-{}", i), "user-1", &format!("M{}", i + 1));
            create_todo(&mut conn, &new).unwrap();
        }

        let todos = get_todos(&mut conn, "user-1").unwrap();
        assert_eq!(todos.len(), 3);
    }

    // ========================================================================
    // Query tests
    // ========================================================================

    #[test]
    fn get_targets_with_counts_groups_by_summary() {
        let pool = setup_test_db();
        let mut conn = pool.get().unwrap();
        insert_test_user(&mut conn, "user-1");

        // Create 2 images with summary "M42" and 1 with "M31"
        for i in 0..2 {
            let mut img = make_new_image(&format!("m42-{}", i), "user-1");
            img.summary = Some("M42".to_string());
            create_image(&mut conn, &img).unwrap();
        }
        let mut img = make_new_image("m31-0", "user-1");
        img.summary = Some("M31".to_string());
        create_image(&mut conn, &img).unwrap();

        let targets = get_targets_with_counts(&mut conn, "user-1").unwrap();
        assert_eq!(targets.len(), 2);
        // Sorted by count descending, so M42 first
        assert_eq!(targets[0].name, "M42");
        assert_eq!(targets[0].image_count, 2);
        assert_eq!(targets[1].name, "M31");
        assert_eq!(targets[1].image_count, 1);
    }

    #[test]
    fn search_images_by_target_partial_match() {
        let pool = setup_test_db();
        let mut conn = pool.get().unwrap();
        insert_test_user(&mut conn, "user-1");

        let mut img = make_new_image("img-1", "user-1");
        img.summary = Some("Orion Nebula M42".to_string());
        create_image(&mut conn, &img).unwrap();

        let mut img2 = make_new_image("img-2", "user-1");
        img2.summary = Some("Andromeda M31".to_string());
        create_image(&mut conn, &img2).unwrap();

        let results = search_images_by_target(&mut conn, "user-1", "M42").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "img-1");

        // Partial match
        let results = search_images_by_target(&mut conn, "user-1", "Nebula").unwrap();
        assert_eq!(results.len(), 1);

        // No match
        let results = search_images_by_target(&mut conn, "user-1", "NGC 7000").unwrap();
        assert!(results.is_empty());
    }
}
