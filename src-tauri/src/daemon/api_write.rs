//! Authenticated JSON write API over the extracted command cores:
//! collections CRUD, image update/delete, collection membership add/remove.
//!
//! Semantics are exactly the desktop cores' — not-owned reads as not-found
//! (404) and mutates nothing. Notably, DELETE on a collection matches
//! `delete_collection_core`: join rows are cleaned but a publish record is
//! NOT removed — unpublishing stays an explicit DELETE on
//! `/api/collections/{id}/publish`, same as the desktop flow.
//!
//! Request bodies mirror the desktop input shapes (snake_case, models.ts
//! compatible) minus the `id`, which comes from the path. The legacy
//! embedded base64 `thumbnail` field is write-ignored, symmetric with the
//! read API stripping it from responses.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use super::api::{internal, not_found, strip_thumbnail};
use super::auth::AuthedUser;
use super::DaemonState;
use crate::commands::collections::{
    create_collection_core, delete_collection_core, update_collection_core,
    CreateCollectionInput, UpdateCollectionInput,
};
use crate::commands::images::{
    add_image_to_collection_core, delete_image_core, remove_image_from_collection_core,
    update_image_core, UpdateImageInput,
};
use crate::commands::schedules::{
    add_schedule_item_core, create_schedule_core, delete_schedule_core,
    remove_schedule_item_core, update_schedule_core, CreateScheduleInput, UpdateScheduleInput,
};
use crate::commands::todos::{
    create_todo_core, delete_todo_core, sync_todos_core, update_todo_core, CreateTodoInput,
    UpdateTodoInput,
};
use crate::db::models::ScheduleItem;

/// Map a core error to a response: the cores signal not-owned/missing rows
/// with "... not found: {id}" strings; everything else is a real failure.
fn core_error(context: &str, e: String) -> Response {
    let is_not_found = ["Collection", "Image", "Todo", "Schedule"]
        .iter()
        .any(|kind| e.starts_with(&format!("{kind} not found")));
    if is_not_found {
        not_found()
    } else {
        internal(context, e)
    }
}

pub async fn create_collection(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Json(input): Json<CreateCollectionInput>,
) -> Response {
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    match tokio::task::spawn_blocking(move || create_collection_core(&db, &user_id, input)).await
    {
        Ok(Ok(collection)) => (StatusCode::CREATED, Json(collection)).into_response(),
        Ok(Err(e)) => internal("create_collection", e),
        Err(e) => internal("create_collection task", e.to_string()),
    }
}

/// `UpdateCollectionInput` minus `id` (path-supplied). A body `id` field is
/// ignored — the path wins.
#[derive(Debug, Deserialize)]
pub struct UpdateCollectionBody {
    name: Option<String>,
    description: Option<String>,
    visibility: Option<String>,
    template: Option<String>,
    favorite: Option<bool>,
    tags: Option<String>,
    metadata: Option<String>,
    archived: Option<bool>,
}

pub async fn update_collection(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(id): Path<String>,
    Json(body): Json<UpdateCollectionBody>,
) -> Response {
    let input = UpdateCollectionInput {
        id,
        name: body.name,
        description: body.description,
        visibility: body.visibility,
        template: body.template,
        favorite: body.favorite,
        tags: body.tags,
        metadata: body.metadata,
        archived: body.archived,
    };
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    match tokio::task::spawn_blocking(move || update_collection_core(&db, &user_id, input)).await
    {
        Ok(Ok(collection)) => Json(collection).into_response(),
        Ok(Err(e)) => core_error("update_collection", e),
        Err(e) => internal("update_collection task", e.to_string()),
    }
}

pub async fn delete_collection(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(id): Path<String>,
) -> Response {
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    match tokio::task::spawn_blocking(move || delete_collection_core(&db, &user_id, &id)).await {
        Ok(Ok(true)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Ok(false)) => not_found(),
        Ok(Err(e)) => internal("delete_collection", e),
        Err(e) => internal("delete_collection task", e.to_string()),
    }
}

/// `UpdateImageInput` minus `id` (path-supplied) and minus `thumbnail`
/// (legacy embedded base64 — write-ignored, bytes live in HoardFS).
#[derive(Debug, Deserialize)]
pub struct UpdateImageBody {
    collection_id: Option<String>,
    filename: Option<String>,
    url: Option<String>,
    summary: Option<String>,
    description: Option<String>,
    content_type: Option<String>,
    favorite: Option<bool>,
    tags: Option<String>,
    visibility: Option<String>,
    location: Option<String>,
    annotations: Option<String>,
    metadata: Option<String>,
}

pub async fn update_image(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(id): Path<String>,
    Json(body): Json<UpdateImageBody>,
) -> Response {
    let input = UpdateImageInput {
        id,
        collection_id: body.collection_id,
        filename: body.filename,
        url: body.url,
        summary: body.summary,
        description: body.description,
        content_type: body.content_type,
        favorite: body.favorite,
        tags: body.tags,
        visibility: body.visibility,
        location: body.location,
        annotations: body.annotations,
        metadata: body.metadata,
        thumbnail: None,
    };
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    match tokio::task::spawn_blocking(move || update_image_core(&db, &user_id, input)).await {
        Ok(Ok(image)) => Json(strip_thumbnail(image)).into_response(),
        Ok(Err(e)) => core_error("update_image", e),
        Err(e) => internal("update_image task", e.to_string()),
    }
}

pub async fn delete_image(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(id): Path<String>,
) -> Response {
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    match tokio::task::spawn_blocking(move || delete_image_core(&db, &user_id, &id)).await {
        Ok(Ok(true)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Ok(false)) => not_found(),
        Ok(Err(e)) => internal("delete_image", e),
        Err(e) => internal("delete_image task", e.to_string()),
    }
}

/// PUT is idempotent: linking an already-linked image is 204, same as the
/// first link. Both endpoints must belong to the caller or this is a 404.
pub async fn add_collection_image(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path((collection_id, image_id)): Path<(String, String)>,
) -> Response {
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        add_image_to_collection_core(&db, &user_id, &image_id, &collection_id)
    })
    .await;
    match result {
        Ok(Ok(_)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(e)) => core_error("add_collection_image", e),
        Err(e) => internal("add_collection_image task", e.to_string()),
    }
}

/// DELETE converges but reports: removing a link that isn't there (or a
/// collection that isn't yours — the core can't tell them apart) is a 404.
pub async fn remove_collection_image(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path((collection_id, image_id)): Path<(String, String)>,
) -> Response {
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        remove_image_from_collection_core(&db, &user_id, &image_id, &collection_id)
    })
    .await;
    match result {
        Ok(Ok(true)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Ok(false)) => not_found(),
        Ok(Err(e)) => core_error("remove_collection_image", e),
        Err(e) => internal("remove_collection_image task", e.to_string()),
    }
}

pub async fn create_todo(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Json(input): Json<CreateTodoInput>,
) -> Response {
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    match tokio::task::spawn_blocking(move || create_todo_core(&db, &user_id, input)).await {
        Ok(Ok(todo)) => (StatusCode::CREATED, Json(todo)).into_response(),
        Ok(Err(e)) => internal("create_todo", e),
        Err(e) => internal("create_todo task", e.to_string()),
    }
}

/// `UpdateTodoInput` minus `id` (path-supplied). A body `id` field is
/// ignored — the path wins.
#[derive(Debug, Deserialize)]
pub struct UpdateTodoBody {
    name: Option<String>,
    ra: Option<String>,
    dec: Option<String>,
    magnitude: Option<String>,
    size: Option<String>,
    object_type: Option<String>,
    completed: Option<bool>,
    completed_at: Option<String>,
    goal_time: Option<String>,
    notes: Option<String>,
    flagged: Option<bool>,
    tags: Option<Vec<String>>,
}

pub async fn update_todo(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(id): Path<String>,
    Json(body): Json<UpdateTodoBody>,
) -> Response {
    let input = UpdateTodoInput {
        id,
        name: body.name,
        ra: body.ra,
        dec: body.dec,
        magnitude: body.magnitude,
        size: body.size,
        object_type: body.object_type,
        completed: body.completed,
        completed_at: body.completed_at,
        goal_time: body.goal_time,
        notes: body.notes,
        flagged: body.flagged,
        tags: body.tags,
    };
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    match tokio::task::spawn_blocking(move || update_todo_core(&db, &user_id, input)).await {
        Ok(Ok(todo)) => Json(todo).into_response(),
        Ok(Err(e)) => core_error("update_todo", e),
        Err(e) => internal("update_todo task", e.to_string()),
    }
}

pub async fn delete_todo(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(id): Path<String>,
) -> Response {
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    match tokio::task::spawn_blocking(move || delete_todo_core(&db, &user_id, &id)).await {
        Ok(Ok(true)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Ok(false)) => not_found(),
        Ok(Err(e)) => internal("delete_todo", e),
        Err(e) => internal("delete_todo task", e.to_string()),
    }
}

/// Replace-all sync of the caller's todo list (desktop `sync_todos`).
pub async fn sync_todos(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Json(todos): Json<Vec<CreateTodoInput>>,
) -> Response {
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    match tokio::task::spawn_blocking(move || sync_todos_core(&db, &user_id, todos)).await {
        Ok(Ok(todos)) => Json(todos).into_response(),
        Ok(Err(e)) => internal("sync_todos", e),
        Err(e) => internal("sync_todos task", e.to_string()),
    }
}

pub async fn create_schedule(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Json(input): Json<CreateScheduleInput>,
) -> Response {
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    match tokio::task::spawn_blocking(move || create_schedule_core(&db, &user_id, input)).await {
        Ok(Ok(schedule)) => (StatusCode::CREATED, Json(schedule)).into_response(),
        Ok(Err(e)) => internal("create_schedule", e),
        Err(e) => internal("create_schedule task", e.to_string()),
    }
}

/// `UpdateScheduleInput` minus `id` (path-supplied). A body `id` field is
/// ignored — the path wins.
#[derive(Debug, Deserialize)]
pub struct UpdateScheduleBody {
    name: Option<String>,
    description: Option<String>,
    scheduled_date: Option<String>,
    location: Option<String>,
    items: Option<Vec<ScheduleItem>>,
    is_active: Option<bool>,
    equipment_id: Option<String>,
}

pub async fn update_schedule(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(id): Path<String>,
    Json(body): Json<UpdateScheduleBody>,
) -> Response {
    let input = UpdateScheduleInput {
        id,
        name: body.name,
        description: body.description,
        scheduled_date: body.scheduled_date,
        location: body.location,
        items: body.items,
        is_active: body.is_active,
        equipment_id: body.equipment_id,
    };
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    match tokio::task::spawn_blocking(move || update_schedule_core(&db, &user_id, input)).await {
        Ok(Ok(schedule)) => Json(schedule).into_response(),
        Ok(Err(e)) => core_error("update_schedule", e),
        Err(e) => internal("update_schedule task", e.to_string()),
    }
}

pub async fn delete_schedule(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(id): Path<String>,
) -> Response {
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    match tokio::task::spawn_blocking(move || delete_schedule_core(&db, &user_id, &id)).await {
        Ok(Ok(true)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Ok(false)) => not_found(),
        Ok(Err(e)) => internal("delete_schedule", e),
        Err(e) => internal("delete_schedule task", e.to_string()),
    }
}

/// Returns the updated schedule (desktop `add_schedule_item` semantics —
/// items are a JSON column, the whole row comes back).
pub async fn add_schedule_item(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(id): Path<String>,
    Json(item): Json<ScheduleItem>,
) -> Response {
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        add_schedule_item_core(&db, &user_id, &id, item)
    })
    .await;
    match result {
        Ok(Ok(schedule)) => Json(schedule).into_response(),
        Ok(Err(e)) => core_error("add_schedule_item", e),
        Err(e) => internal("add_schedule_item task", e.to_string()),
    }
}

pub async fn remove_schedule_item(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path((id, item_id)): Path<(String, String)>,
) -> Response {
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        remove_schedule_item_core(&db, &user_id, &id, &item_id)
    })
    .await;
    match result {
        Ok(Ok(schedule)) => Json(schedule).into_response(),
        Ok(Err(e)) => core_error("remove_schedule_item", e),
        Err(e) => internal("remove_schedule_item task", e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::collections::get_collection_core;
    use crate::commands::images::{create_image_core, get_image_core, CreateImageInput};
    use crate::daemon::auth::mint_token;
    use crate::db::models::{Collection, Image};
    use crate::db::test_support::{insert_user, test_pool};
    use crate::db::DbPool;
    use axum::body::to_bytes;
    use axum::http::header;
    use std::sync::Mutex;
    use tower::ServiceExt;

    /// Minimal daemon state: no variant pipeline — writes never touch bytes.
    async fn state_with_users() -> (Arc<DaemonState>, tempfile::TempDir, String, String) {
        let tmp = tempfile::tempdir().unwrap();
        let db = test_pool();
        insert_user(&db, "alice");
        insert_user(&db, "bob");
        let hfs = hoardfs_volume::HoardFs::init(&tmp.path().join("hoardfs"))
            .await
            .unwrap();
        let alice = mint_token(&db, "alice", "t").unwrap().token;
        let bob = mint_token(&db, "bob", "t").unwrap().token;
        let state = Arc::new(DaemonState {
            db,
            hoardfs: Arc::new(Mutex::new(hfs)),
            oidc: None,
            limits: Default::default(),
            session_key: [7u8; 32],
            processing: Default::default(),
            tetra3_db: None,
        });
        (state, tmp, alice, bob)
    }

    fn seed_collection(db: &DbPool, user: &str, name: &str) -> Collection {
        create_collection_core(
            db,
            user,
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

    fn seed_image(db: &DbPool, user: &str, filename: &str) -> Image {
        create_image_core(
            db,
            user,
            CreateImageInput {
                collection_id: None,
                filename: filename.to_string(),
                url: None,
                summary: None,
                description: None,
                content_type: None,
                tags: None,
                visibility: None,
                location: None,
                annotations: None,
                metadata: None,
                thumbnail: Some("data:image/jpeg;base64,legacy".to_string()),
            },
        )
        .unwrap()
    }

    async fn send(
        router: &axum::Router,
        token: &str,
        method: &str,
        uri: &str,
        body: Option<serde_json::Value>,
    ) -> (StatusCode, Vec<u8>) {
        let mut req = axum::http::Request::builder()
            .method(method)
            .uri(uri)
            .header("Authorization", format!("Bearer {token}"));
        let body = match body {
            Some(json) => {
                req = req.header(header::CONTENT_TYPE, "application/json");
                axum::body::Body::from(json.to_string())
            }
            None => axum::body::Body::empty(),
        };
        let resp = router.clone().oneshot(req.body(body).unwrap()).await.unwrap();
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap().to_vec();
        (status, bytes)
    }

    fn json(body: &[u8]) -> serde_json::Value {
        serde_json::from_slice(body).unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn collection_crud_round_trip_http() {
        let (state, _tmp, alice, _bob) = state_with_users().await;
        let router = crate::daemon::router(state.clone());

        let (status, body) = send(
            &router,
            &alice,
            "POST",
            "/api/collections",
            Some(serde_json::json!({ "name": "Nebulae", "description": null,
                "visibility": null, "template": null, "tags": null })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let created = json(&body);
        assert_eq!(created["name"], "Nebulae");
        assert_eq!(created["visibility"], "private");
        let id = created["id"].as_str().unwrap().to_string();

        let (status, body) = send(
            &router,
            &alice,
            "PATCH",
            &format!("/api/collections/{id}"),
            Some(serde_json::json!({ "name": "Emission Nebulae", "favorite": true })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let updated = json(&body);
        assert_eq!(updated["name"], "Emission Nebulae");
        assert_eq!(updated["favorite"], true);

        let (status, _) = send(&router, &alice, "DELETE", &format!("/api/collections/{id}"), None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, _) = send(&router, &alice, "GET", &format!("/api/collections/{id}"), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        // Second delete: the row is gone, so the core reports no-op.
        let (status, _) = send(&router, &alice, "DELETE", &format!("/api/collections/{id}"), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn image_patch_ignores_legacy_thumbnail_writes() {
        let (state, _tmp, alice, _bob) = state_with_users().await;
        let img = seed_image(&state.db, "alice", "m42.png");
        let router = crate::daemon::router(state.clone());

        let (status, body) = send(
            &router,
            &alice,
            "PATCH",
            &format!("/api/images/{}", img.id),
            Some(serde_json::json!({
                "favorite": true,
                "tags": "nebula,ha",
                "thumbnail": "data:image/jpeg;base64,attacker-controlled"
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let updated = json(&body);
        assert_eq!(updated["favorite"], true);
        assert_eq!(updated["tags"], "nebula,ha");
        // Response strips the legacy field...
        assert!(updated["thumbnail"].is_null());
        // ...and the write never reached the row: the seeded value survives.
        let row = get_image_core(&state.db, "alice", &img.id).unwrap().unwrap();
        assert_eq!(row.thumbnail.as_deref(), Some("data:image/jpeg;base64,legacy"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn image_delete_cleans_membership() {
        let (state, _tmp, alice, _bob) = state_with_users().await;
        let img = seed_image(&state.db, "alice", "m42.png");
        let coll = seed_collection(&state.db, "alice", "Nebulae");
        add_image_to_collection_core(&state.db, "alice", &img.id, &coll.id).unwrap();
        let router = crate::daemon::router(state.clone());

        let (status, _) = send(&router, &alice, "DELETE", &format!("/api/images/{}", img.id), None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        let (status, _) = send(&router, &alice, "GET", &format!("/api/images/{}", img.id), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (_, body) = send(&router, &alice, "GET", &format!("/api/collections/{}", coll.id), None).await;
        assert_eq!(json(&body)["images"].as_array().unwrap().len(), 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn membership_put_delete_idempotency() {
        let (state, _tmp, alice, _bob) = state_with_users().await;
        let img = seed_image(&state.db, "alice", "m42.png");
        let coll = seed_collection(&state.db, "alice", "Nebulae");
        let router = crate::daemon::router(state.clone());
        let uri = format!("/api/collections/{}/images/{}", coll.id, img.id);

        // PUT twice: both 204, one membership row.
        let (status, _) = send(&router, &alice, "PUT", &uri, None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, _) = send(&router, &alice, "PUT", &uri, None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (_, body) = send(&router, &alice, "GET", &format!("/api/collections/{}", coll.id), None).await;
        assert_eq!(json(&body)["images"].as_array().unwrap().len(), 1);

        // DELETE removes; a second DELETE finds nothing to remove.
        let (status, _) = send(&router, &alice, "DELETE", &uri, None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, _) = send(&router, &alice, "DELETE", &uri, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (_, body) = send(&router, &alice, "GET", &format!("/api/collections/{}", coll.id), None).await;
        assert_eq!(json(&body)["images"].as_array().unwrap().len(), 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn todos_http_round_trip_sync_and_isolation() {
        let (state, _tmp, alice, bob) = state_with_users().await;
        let router = crate::daemon::router(state.clone());
        let todo_json = serde_json::json!({
            "name": "M42", "ra": "05h 35m", "dec": "-05° 27′",
            "magnitude": "4.0", "size": "65'", "object_type": "nebula",
            "goal_time": null, "notes": null, "tags": ["winter"]
        });

        let (status, body) = send(&router, &alice, "POST", "/api/todos", Some(todo_json.clone())).await;
        assert_eq!(status, StatusCode::CREATED);
        let created = json(&body);
        assert_eq!(created["name"], "M42");
        assert_eq!(created["completed"], false);
        let id = created["id"].as_str().unwrap().to_string();

        let (status, body) = send(
            &router,
            &alice,
            "PATCH",
            &format!("/api/todos/{id}"),
            Some(serde_json::json!({ "completed": true, "flagged": true })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json(&body)["completed"], true);

        // Cross-user: bob can't read, patch, or delete alice's todo.
        let (status, _) = send(&router, &bob, "GET", &format!("/api/todos/{id}"), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = send(
            &router,
            &bob,
            "PATCH",
            &format!("/api/todos/{id}"),
            Some(serde_json::json!({ "name": "hijacked" })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = send(&router, &bob, "DELETE", &format!("/api/todos/{id}"), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // Sync replaces alice's list wholesale; bob's list stays empty of hers.
        let mut second = todo_json.clone();
        second["name"] = serde_json::json!("M45");
        let (status, body) = send(
            &router,
            &alice,
            "POST",
            "/api/todos/sync",
            Some(serde_json::json!([todo_json, second])),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json(&body).as_array().unwrap().len(), 2);
        let (_, body) = send(&router, &alice, "GET", "/api/todos", None).await;
        assert_eq!(json(&body).as_array().unwrap().len(), 2);
        let (_, body) = send(&router, &bob, "GET", "/api/todos", None).await;
        assert_eq!(json(&body).as_array().unwrap().len(), 0);

        // Delete one of the synced todos.
        let (_, body) = send(&router, &alice, "GET", "/api/todos", None).await;
        let target = json(&body)[0]["id"].as_str().unwrap().to_string();
        let (status, _) = send(&router, &alice, "DELETE", &format!("/api/todos/{target}"), None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (_, body) = send(&router, &alice, "GET", "/api/todos", None).await;
        assert_eq!(json(&body).as_array().unwrap().len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn schedules_http_round_trip_items_and_isolation() {
        let (state, _tmp, alice, bob) = state_with_users().await;
        let router = crate::daemon::router(state.clone());

        let (status, body) = send(
            &router,
            &alice,
            "POST",
            "/api/schedules",
            Some(serde_json::json!({
                "name": "July new moon", "description": null, "scheduled_date": null,
                "location": null, "is_active": true, "equipment_id": null
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let created = json(&body);
        let id = created["id"].as_str().unwrap().to_string();
        assert_eq!(created["is_active"], true);

        let (status, body) = send(&router, &alice, "GET", "/api/schedules/active", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json(&body).as_array().unwrap().len(), 1);

        // Items: add two out of order, verify sort, remove one.
        let item = |item_id: &str, start: &str| {
            serde_json::json!({
                "id": item_id, "todo_id": format!("todo-{item_id}"), "object_name": "M42",
                "start_time": start, "end_time": "23:59", "priority": 1,
                "notes": null, "completed": false
            })
        };
        let (status, _) = send(
            &router,
            &alice,
            "POST",
            &format!("/api/schedules/{id}/items"),
            Some(item("b", "22:00")),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, body) = send(
            &router,
            &alice,
            "POST",
            &format!("/api/schedules/{id}/items"),
            Some(item("a", "21:00")),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let items: Vec<serde_json::Value> =
            serde_json::from_str(json(&body)["items"].as_str().unwrap()).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["id"], "a");

        let (status, body) = send(
            &router,
            &alice,
            "DELETE",
            &format!("/api/schedules/{id}/items/b"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let items: Vec<serde_json::Value> =
            serde_json::from_str(json(&body)["items"].as_str().unwrap()).unwrap();
        assert_eq!(items.len(), 1);

        // Cross-user: every schedule route 404s for bob.
        for (method, uri, body) in [
            ("GET", format!("/api/schedules/{id}"), None),
            (
                "PATCH",
                format!("/api/schedules/{id}"),
                Some(serde_json::json!({ "name": "hijacked" })),
            ),
            (
                "POST",
                format!("/api/schedules/{id}/items"),
                Some(item("x", "20:00")),
            ),
            ("DELETE", format!("/api/schedules/{id}/items/a"), None),
            ("DELETE", format!("/api/schedules/{id}"), None),
        ] {
            let (status, _) = send(&router, &bob, method, &uri, body).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method} {uri} should 404 for bob");
        }

        // Owner PATCH deactivates; then delete.
        let (status, body) = send(
            &router,
            &alice,
            "PATCH",
            &format!("/api/schedules/{id}"),
            Some(serde_json::json!({ "is_active": false })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json(&body)["is_active"], false);
        let (_, body) = send(&router, &alice, "GET", "/api/schedules/active", None).await;
        assert!(json(&body).as_array().unwrap().is_empty());
        let (status, _) = send(&router, &alice, "DELETE", &format!("/api/schedules/{id}"), None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cross_user_isolation_on_every_write_route() {
        let (state, _tmp, _alice, bob) = state_with_users().await;
        let img = seed_image(&state.db, "alice", "m42.png");
        let coll = seed_collection(&state.db, "alice", "Nebulae");
        add_image_to_collection_core(&state.db, "alice", &img.id, &coll.id).unwrap();
        let bobs_coll = seed_collection(&state.db, "bob", "Bob's");
        let router = crate::daemon::router(state.clone());

        let attempts: Vec<(&str, String, Option<serde_json::Value>)> = vec![
            (
                "PATCH",
                format!("/api/collections/{}", coll.id),
                Some(serde_json::json!({ "name": "hijacked" })),
            ),
            ("DELETE", format!("/api/collections/{}", coll.id), None),
            (
                "PATCH",
                format!("/api/images/{}", img.id),
                Some(serde_json::json!({ "favorite": true })),
            ),
            ("DELETE", format!("/api/images/{}", img.id), None),
            ("PUT", format!("/api/collections/{}/images/{}", coll.id, img.id), None),
            ("DELETE", format!("/api/collections/{}/images/{}", coll.id, img.id), None),
            // Cross-tenant link: bob's own collection, alice's image.
            ("PUT", format!("/api/collections/{}/images/{}", bobs_coll.id, img.id), None),
        ];
        for (method, uri, body) in attempts {
            let (status, _) = send(&router, &bob, method, &uri, body).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method} {uri} should 404 for bob");
        }

        // Alice's data is untouched: name, image, and membership all intact.
        let still = get_collection_core(&state.db, "alice", &coll.id).unwrap().unwrap();
        assert_eq!(still.name, "Nebulae");
        let row = get_image_core(&state.db, "alice", &img.id).unwrap().unwrap();
        assert!(!row.favorite);
        let (_, body) = send(
            &router,
            &mint_token(&state.db, "alice", "t2").unwrap().token,
            "GET",
            &format!("/api/collections/{}", coll.id),
            None,
        )
        .await;
        assert_eq!(json(&body)["images"].as_array().unwrap().len(), 1);
    }
}
