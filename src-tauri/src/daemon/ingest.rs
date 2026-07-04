//! Push ingest: a client uploads a collection (metadata + image records +
//! image assets) into its own user's HoardFS volume.
//!
//! Two-step protocol, designed as a dumb sync primitive (last-write-wins,
//! no conflict UI):
//!
//! 1. `POST /api/push/collections` — upserts the collection row, its image
//!    rows, and replaces the collection's membership with the pushed set.
//!    The response tells the client which image assets the daemon is
//!    missing (`asset_status: "needed" | "present"`).
//! 2. `PUT /api/push/images/{id}/asset` — raw bytes with an
//!    `x-astra-content-hash: <blake3-hex>` header. The daemon verifies the
//!    hash (422 on mismatch), skips the write when the image already holds
//!    that exact content (idempotent re-push: assets transfer once,
//!    variants generate once), otherwise stores into `user-{id}`'s volume
//!    at the migrate_library path scheme `/{YYYY-MM}/{stem}__{id}.{ext}`
//!    and lets the variant pipeline run.
//!
//! Server-owned fields: `images.blob_id` and the `hoardfs` key inside
//! `images.metadata` are never taken from the client on upsert (a client's
//! `hoardfs.hfs_path` is honored as a placement hint only when the daemon
//! has none yet). Per-user storage accounting is deferred to the
//! hosted-scale leaf.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use diesel::prelude::*;
use serde::Deserialize;

use super::auth::AuthedUser;
use super::DaemonState;
use crate::db::schema::{collection_images, collections, images};
use crate::db::tenancy;
use crate::db::DbPool;

/// Per-request ingest limits; breaches answer 413.
#[derive(Debug, Clone, Copy)]
pub struct IngestLimits {
    pub max_images_per_push: usize,
    pub max_asset_bytes: usize,
}

impl Default for IngestLimits {
    fn default() -> Self {
        Self {
            max_images_per_push: 500,
            max_asset_bytes: 1 << 30, // 1 GiB — stacked FITS files are large
        }
    }
}

pub const CONTENT_HASH_HEADER: &str = "x-astra-content-hash";

#[derive(Debug, Deserialize)]
pub struct PushCollectionBody {
    collection: PushCollection,
    #[serde(default)]
    images: Vec<PushImage>,
}

#[derive(Debug, Deserialize)]
struct PushCollection {
    id: String,
    name: String,
    description: Option<String>,
    visibility: Option<String>,
    template: Option<String>,
    tags: Option<String>,
    metadata: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PushImage {
    id: String,
    filename: String,
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

enum PushError {
    /// Pushed id exists but belongs to another user.
    Conflict(String),
    TooManyImages(usize, usize),
    Db(String),
}

impl From<diesel::result::Error> for PushError {
    fn from(e: diesel::result::Error) -> Self {
        Self::Db(e.to_string())
    }
}

impl PushError {
    fn into_response(self) -> Response {
        match self {
            Self::Conflict(id) => (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "error": "conflict",
                    "message": format!("id '{id}' belongs to another user"),
                })),
            )
                .into_response(),
            Self::TooManyImages(got, max) => (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(serde_json::json!({
                    "error": "too many images",
                    "message": format!("{got} images exceeds the per-push limit of {max}"),
                })),
            )
                .into_response(),
            Self::Db(e) => {
                log::error!("push ingest: {e}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": "internal error" })),
                )
                    .into_response()
            }
        }
    }
}

/// Merge client-supplied image metadata with the server-owned `hoardfs` key
/// from the existing row. Server placement wins; the client's `hoardfs` is
/// kept only when the server has none yet (placement hint).
fn merged_metadata(client: Option<&str>, existing: Option<&str>) -> Option<String> {
    let parse = |s: &str| serde_json::from_str::<serde_json::Value>(s).ok();
    let server_hoardfs = existing.and_then(parse).and_then(|v| v.get("hoardfs").cloned());

    match (client.and_then(parse), server_hoardfs, client) {
        (Some(mut c), Some(h), _) => {
            if let Some(obj) = c.as_object_mut() {
                obj.insert("hoardfs".to_string(), h);
            }
            Some(c.to_string())
        }
        (None, Some(h), _) => Some(serde_json::json!({ "hoardfs": h }).to_string()),
        // No server placement: pass the client value through untouched
        // (including an unparseable string — LWW, not a validator).
        (_, None, client) => client.map(str::to_string),
    }
}

fn upsert_push(
    db: &DbPool,
    user_id: &str,
    body: &PushCollectionBody,
    limits: IngestLimits,
) -> Result<serde_json::Value, PushError> {
    if body.images.len() > limits.max_images_per_push {
        return Err(PushError::TooManyImages(
            body.images.len(),
            limits.max_images_per_push,
        ));
    }

    let mut conn = db.get().map_err(|e| PushError::Db(e.to_string()))?;

    conn.transaction::<serde_json::Value, PushError, _>(|conn| {
        // --- collection upsert -------------------------------------------
        let existing_owner: Option<String> = collections::table
            .find(&body.collection.id)
            .select(collections::user_id)
            .first(conn)
            .optional()
            .map_err(|e| PushError::Db(e.to_string()))?;

        match existing_owner.as_deref() {
            Some(owner) if owner != user_id => {
                return Err(PushError::Conflict(body.collection.id.clone()))
            }
            Some(_) => {
                diesel::update(collections::table.find(&body.collection.id))
                    .set((
                        collections::name.eq(&body.collection.name),
                        collections::description.eq(&body.collection.description),
                        collections::visibility
                            .eq(body.collection.visibility.as_deref().unwrap_or("private")),
                        collections::template.eq(&body.collection.template),
                        collections::tags.eq(&body.collection.tags),
                        collections::metadata.eq(&body.collection.metadata),
                        collections::updated_at.eq(chrono::Utc::now().naive_utc()),
                    ))
                    .execute(conn)
                    .map_err(|e| PushError::Db(e.to_string()))?;
            }
            None => {
                diesel::insert_into(collections::table)
                    .values((
                        collections::id.eq(&body.collection.id),
                        collections::user_id.eq(user_id),
                        collections::name.eq(&body.collection.name),
                        collections::description.eq(&body.collection.description),
                        collections::visibility
                            .eq(body.collection.visibility.as_deref().unwrap_or("private")),
                        collections::template.eq(&body.collection.template),
                        collections::favorite.eq(false),
                        collections::tags.eq(&body.collection.tags),
                        collections::metadata.eq(&body.collection.metadata),
                        collections::archived.eq(false),
                    ))
                    .execute(conn)
                    .map_err(|e| PushError::Db(e.to_string()))?;
            }
        }

        // --- image upserts ------------------------------------------------
        let mut image_statuses = Vec::with_capacity(body.images.len());
        for img in &body.images {
            let existing: Option<(String, Option<String>, Option<String>)> = images::table
                .find(&img.id)
                .select((images::user_id, images::blob_id, images::metadata))
                .first(conn)
                .optional()
                .map_err(|e| PushError::Db(e.to_string()))?;

            let blob_id = match existing {
                Some((owner, _, _)) if owner != user_id => {
                    return Err(PushError::Conflict(img.id.clone()))
                }
                Some((_, blob_id, existing_metadata)) => {
                    diesel::update(images::table.find(&img.id))
                        .set((
                            images::filename.eq(&img.filename),
                            images::summary.eq(&img.summary),
                            images::description.eq(&img.description),
                            images::content_type.eq(&img.content_type),
                            images::favorite.eq(img.favorite.unwrap_or(false)),
                            images::tags.eq(&img.tags),
                            images::visibility.eq(&img.visibility),
                            images::location.eq(&img.location),
                            images::annotations.eq(&img.annotations),
                            images::metadata.eq(merged_metadata(
                                img.metadata.as_deref(),
                                existing_metadata.as_deref(),
                            )),
                            images::updated_at.eq(chrono::Utc::now().naive_utc()),
                        ))
                        .execute(conn)
                        .map_err(|e| PushError::Db(e.to_string()))?;
                    blob_id
                }
                None => {
                    diesel::insert_into(images::table)
                        .values((
                            images::id.eq(&img.id),
                            images::user_id.eq(user_id),
                            images::filename.eq(&img.filename),
                            images::summary.eq(&img.summary),
                            images::description.eq(&img.description),
                            images::content_type.eq(&img.content_type),
                            images::favorite.eq(img.favorite.unwrap_or(false)),
                            images::tags.eq(&img.tags),
                            images::visibility.eq(&img.visibility),
                            images::location.eq(&img.location),
                            images::annotations.eq(&img.annotations),
                            images::metadata.eq(&img.metadata),
                        ))
                        .execute(conn)
                        .map_err(|e| PushError::Db(e.to_string()))?;
                    None
                }
            };

            image_statuses.push(serde_json::json!({
                "id": img.id,
                "asset_status": if blob_id.is_some() { "present" } else { "needed" },
                "blob_id": blob_id,
            }));
        }

        // --- membership: the pushed set IS the collection ------------------
        diesel::delete(
            collection_images::table
                .filter(collection_images::collection_id.eq(&body.collection.id)),
        )
        .execute(conn)
        .map_err(|e| PushError::Db(e.to_string()))?;
        for img in &body.images {
            diesel::insert_into(collection_images::table)
                .values((
                    collection_images::id.eq(uuid::Uuid::new_v4().to_string()),
                    collection_images::collection_id.eq(&body.collection.id),
                    collection_images::image_id.eq(&img.id),
                ))
                .execute(conn)
                .map_err(|e| PushError::Db(e.to_string()))?;
        }

        Ok(serde_json::json!({
            "collection_id": body.collection.id,
            "images": image_statuses,
        }))
    })
}

pub async fn push_collection(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Json(body): Json<PushCollectionBody>,
) -> Response {
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    let limits = state.limits;
    match tokio::task::spawn_blocking(move || upsert_push(&db, &user_id, &body, limits)).await {
        Ok(Ok(response)) => Json(response).into_response(),
        Ok(Err(e)) => e.into_response(),
        Err(e) => PushError::Db(format!("push task: {e}")).into_response(),
    }
}

/// `/{YYYY-MM}/{stem}__{image_id}.{ext}` — the migrate_library scheme; the
/// image id suffix keeps duplicate filenames from colliding on the volume's
/// unique path index.
fn hfs_path_for(image: &crate::db::models::Image) -> String {
    let date_prefix = image.created_at.format("%Y-%m").to_string();
    let path = std::path::Path::new(&image.filename);
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let stem = if !ext.is_empty()
        && image
            .filename
            .to_lowercase()
            .ends_with(&format!(".{}", ext.to_lowercase()))
    {
        &image.filename[..image.filename.len() - ext.len() - 1]
    } else {
        image.filename.as_str()
    };
    if ext.is_empty() {
        format!("/{date_prefix}/{stem}__{}", image.id)
    } else {
        format!("/{date_prefix}/{stem}__{}.{ext}", image.id)
    }
}

pub async fn put_image_asset(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(claimed_hash) = headers
        .get(CONTENT_HASH_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim_start_matches("blake3:").to_lowercase())
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "missing content hash",
                "message": format!("{CONTENT_HASH_HEADER} header (blake3 hex) is required"),
            })),
        )
            .into_response();
    };

    let computed = hoardfs_core::BlobId::from_hash(blake3::hash(&body));
    if computed.to_hex() != claimed_hash {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({
                "error": "content hash mismatch",
                "message": "body does not match x-astra-content-hash",
            })),
        )
            .into_response();
    }

    let db = state.db.clone();
    let hoardfs = state.hoardfs.clone();
    let user_id = user.user_id.clone();
    let rt = tokio::runtime::Handle::current();

    let result = tokio::task::spawn_blocking(move || -> Result<Response, String> {
        let mut conn = db.get().map_err(|e| e.to_string())?;
        let Some(image) =
            crate::commands::images::fetch_owned_image(&mut conn, &user_id, &id)?
        else {
            return Ok((
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "not found" })),
            )
                .into_response());
        };

        // Idempotent re-push: the image already holds exactly this content.
        if image.blob_id.as_deref() == Some(&computed.to_string()) {
            return Ok(Json(serde_json::json!({
                "status": "skipped",
                "blob_id": computed.to_string(),
            }))
            .into_response());
        }

        let hfs_path = crate::commands::hoardfs::resolve_hfs_path(&image)
            .unwrap_or_else(|| hfs_path_for(&image));
        let volume = tenancy::volume_name(&user_id);

        let stored_blob = {
            let hfs = hoardfs
                .lock()
                .map_err(|_| "HoardFS lock poisoned".to_string())?;
            tenancy::ensure_user_volume(&hfs, &user_id)?;
            rt.block_on(hfs.put_file(&volume, &hfs_path, &body))
                .map_err(|e| format!("put_file {hfs_path}: {e}"))?;
            hfs.get_file_info(&volume, &hfs_path)
                .map_err(|e| e.to_string())?
                .current_version
                .blob_id
        };

        let metadata = {
            let mut value = image
                .metadata
                .as_deref()
                .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok())
                .unwrap_or_else(|| serde_json::json!({}));
            if let Some(obj) = value.as_object_mut() {
                obj.insert(
                    "hoardfs".to_string(),
                    serde_json::json!({ "hfs_path": hfs_path }),
                );
            }
            value.to_string()
        };
        diesel::update(images::table.find(&image.id))
            .set((
                images::blob_id.eq(Some(&stored_blob)),
                images::metadata.eq(Some(&metadata)),
                images::updated_at.eq(chrono::Utc::now().naive_utc()),
            ))
            .execute(&mut conn)
            .map_err(|e| e.to_string())?;

        Ok(Json(serde_json::json!({
            "status": "stored",
            "blob_id": stored_blob,
        }))
        .into_response())
    })
    .await;

    match result {
        Ok(Ok(response)) => response,
        Ok(Err(e)) => {
            log::error!("put_image_asset: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "internal error" })),
            )
                .into_response()
        }
        Err(e) => {
            log::error!("put_image_asset task panicked: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "internal error" })),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::auth::mint_token;
    use crate::db::test_support::{insert_user, test_pool};
    use axum::body::to_bytes;
    use std::sync::Mutex;
    use tower::ServiceExt;

    fn tiny_png() -> Vec<u8> {
        let img = image::RgbImage::from_pixel(48, 48, image::Rgb([10, 120, 220]));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }

    fn hash_of(bytes: &[u8]) -> String {
        hoardfs_core::BlobId::from_hash(blake3::hash(bytes)).to_hex()
    }

    async fn seeded(limits: IngestLimits) -> (Arc<DaemonState>, tempfile::TempDir, String, String)
    {
        let tmp = tempfile::tempdir().unwrap();
        let db = test_pool();
        insert_user(&db, "alice");
        insert_user(&db, "bob");
        let alice = mint_token(&db, "alice", "t").unwrap().token;
        let bob = mint_token(&db, "bob", "t").unwrap().token;

        let mut hfs = hoardfs_volume::HoardFs::init(&tmp.path().join("hoardfs"))
            .await
            .unwrap();
        hfs.set_variant_pipeline(hoardfs_variant::VariantPipeline::new().with_image_generator());

        let state = Arc::new(DaemonState {
            db,
            hoardfs: Arc::new(Mutex::new(hfs)),
            oidc: None,
            limits,
        });
        (state, tmp, alice, bob)
    }

    fn push_body(collection_id: &str, image_ids: &[String], description: &str) -> String {
        serde_json::json!({
            "collection": {
                "id": collection_id,
                "name": "Trip",
                "description": description,
            },
            "images": image_ids.iter().enumerate().map(|(i, id)| serde_json::json!({
                "id": id,
                "filename": format!("img-{i}.png"),
                "summary": format!("frame {i}"),
            })).collect::<Vec<_>>(),
        })
        .to_string()
    }

    async fn send(
        router: &axum::Router,
        method: &str,
        uri: &str,
        token: &str,
        body: Vec<u8>,
        headers: &[(&str, &str)],
    ) -> (StatusCode, serde_json::Value) {
        let mut req = axum::http::Request::builder()
            .method(method)
            .uri(uri)
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/json");
        for (name, value) in headers {
            req = req.header(*name, *value);
        }
        let resp = router
            .clone()
            .oneshot(req.body(axum::body::Body::from(body)).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let value = if bytes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
        };
        (status, value)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn push_round_trip_is_idempotent() {
        let (state, _tmp, alice, _bob) = seeded(IngestLimits::default()).await;
        let router = crate::daemon::router(state.clone());

        let collection_id = uuid::Uuid::new_v4().to_string();
        let image_ids: Vec<String> = (0..10).map(|_| uuid::Uuid::new_v4().to_string()).collect();
        let png = tiny_png();
        let png_hash = hash_of(&png);

        // First metadata push: everything is new, all assets needed.
        let (status, body) = send(
            &router,
            "POST",
            "/api/push/collections",
            &alice,
            push_body(&collection_id, &image_ids, "v1").into_bytes(),
            &[],
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let statuses = body["images"].as_array().unwrap();
        assert_eq!(statuses.len(), 10);
        assert!(statuses.iter().all(|s| s["asset_status"] == "needed"));

        // Upload every asset (identical bytes — HoardFS dedups the blob).
        for id in &image_ids {
            let (status, body) = send(
                &router,
                "PUT",
                &format!("/api/push/images/{id}/asset"),
                &alice,
                png.clone(),
                &[(CONTENT_HASH_HEADER, png_hash.as_str())],
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(body["status"], "stored");
        }

        // Variants resolve through the read API.
        let (status, _, ) = {
            let (s, _h, b) = {
                let resp = router
                    .clone()
                    .oneshot(
                        axum::http::Request::builder()
                            .uri(format!("/api/images/{}/thumbnail", image_ids[0]))
                            .header("Authorization", format!("Bearer {alice}"))
                            .body(axum::body::Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                let s = resp.status();
                let h = resp.headers().clone();
                let b = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
                (s, h, b)
            };
            assert!(!b.is_empty());
            (s, ())
        };
        assert_eq!(status, StatusCode::OK);

        // Second metadata push: upsert (description changes), assets present.
        let (status, body) = send(
            &router,
            "POST",
            "/api/push/collections",
            &alice,
            push_body(&collection_id, &image_ids, "v2").into_bytes(),
            &[],
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["images"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["asset_status"] == "present"));
        let detail = crate::commands::collections::get_collection_core(
            &state.db,
            "alice",
            &collection_id,
        )
        .unwrap()
        .unwrap();
        assert_eq!(detail.description.as_deref(), Some("v2"));

        // Re-uploading an identical asset is skipped, no new file version.
        let (status, body) = send(
            &router,
            "PUT",
            &format!("/api/push/images/{}/asset", image_ids[0]),
            &alice,
            png.clone(),
            &[(CONTENT_HASH_HEADER, png_hash.as_str())],
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "skipped");

        let hfs = state.hoardfs.lock().unwrap();
        let files = hfs.list_files("user-alice", "/").unwrap();
        assert_eq!(files.len(), 10);
        let info = hfs
            .get_file_info("user-alice", &files[0].path)
            .unwrap();
        assert_eq!(info.version_count, 1, "skip path must not create versions");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn hash_mismatch_and_missing_header_are_rejected() {
        let (state, _tmp, alice, _bob) = seeded(IngestLimits::default()).await;
        let router = crate::daemon::router(state.clone());

        let collection_id = uuid::Uuid::new_v4().to_string();
        let image_ids = vec![uuid::Uuid::new_v4().to_string()];
        send(
            &router,
            "POST",
            "/api/push/collections",
            &alice,
            push_body(&collection_id, &image_ids, "x").into_bytes(),
            &[],
        )
        .await;

        let uri = format!("/api/push/images/{}/asset", image_ids[0]);
        let (status, _) = send(&router, "PUT", &uri, &alice, tiny_png(), &[]).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let wrong = hash_of(b"other bytes");
        let (status, _) = send(
            &router,
            "PUT",
            &uri,
            &alice,
            tiny_png(),
            &[(CONTENT_HASH_HEADER, wrong.as_str())],
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

        // Nothing was stored.
        let image =
            crate::commands::images::get_image_core(&state.db, "alice", &image_ids[0])
                .unwrap()
                .unwrap();
        assert!(image.blob_id.is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cross_user_ids_conflict_and_assets_isolate() {
        let (state, _tmp, alice, bob) = seeded(IngestLimits::default()).await;
        let router = crate::daemon::router(state.clone());

        let collection_id = uuid::Uuid::new_v4().to_string();
        let image_ids = vec![uuid::Uuid::new_v4().to_string()];
        send(
            &router,
            "POST",
            "/api/push/collections",
            &alice,
            push_body(&collection_id, &image_ids, "alice's").into_bytes(),
            &[],
        )
        .await;

        // Bob pushing a body that reuses alice's image id → 409.
        let bob_collection = uuid::Uuid::new_v4().to_string();
        let (status, body) = send(
            &router,
            "POST",
            "/api/push/collections",
            &bob,
            push_body(&bob_collection, &image_ids, "hijack").into_bytes(),
            &[],
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "conflict");

        // Bob pushing alice's collection id → 409 too.
        let (status, _) = send(
            &router,
            "POST",
            "/api/push/collections",
            &bob,
            push_body(&collection_id, &[], "hijack").into_bytes(),
            &[],
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);

        // Bob PUTting an asset for alice's image → 404; alice volume stays
        // empty (no write happened), bob has no volume content at all.
        let png = tiny_png();
        let (status, _) = send(
            &router,
            "PUT",
            &format!("/api/push/images/{}/asset", image_ids[0]),
            &bob,
            png.clone(),
            &[(CONTENT_HASH_HEADER, hash_of(&png).as_str())],
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let hfs = state.hoardfs.lock().unwrap();
        assert!(hfs
            .list_volumes()
            .unwrap()
            .iter()
            .all(|v| v.name != "user-bob"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn limits_answer_413() {
        let (state, _tmp, alice, _bob) = seeded(IngestLimits {
            max_images_per_push: 2,
            max_asset_bytes: 64,
        })
        .await;
        let router = crate::daemon::router(state.clone());

        let collection_id = uuid::Uuid::new_v4().to_string();
        let image_ids: Vec<String> = (0..3).map(|_| uuid::Uuid::new_v4().to_string()).collect();
        let (status, _) = send(
            &router,
            "POST",
            "/api/push/collections",
            &alice,
            push_body(&collection_id, &image_ids, "big").into_bytes(),
            &[],
        )
        .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);

        // Asset over the byte limit: rejected by the body-limit layer.
        let two = &image_ids[..2].to_vec();
        send(
            &router,
            "POST",
            "/api/push/collections",
            &alice,
            push_body(&collection_id, two, "ok").into_bytes(),
            &[],
        )
        .await;
        let big = vec![0u8; 256];
        let (status, _) = send(
            &router,
            "PUT",
            &format!("/api/push/images/{}/asset", image_ids[0]),
            &alice,
            big.clone(),
            &[(CONTENT_HASH_HEADER, hash_of(&big).as_str())],
        )
        .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[test]
    fn metadata_merge_preserves_server_placement() {
        // Server placement survives a client push that lacks (or lies about)
        // the hoardfs key.
        let server = r#"{"hoardfs":{"hfs_path":"/2026-07/a__1.png"},"old":true}"#;
        let client = r#"{"exposure":"120s","hoardfs":{"hfs_path":"/evil"}}"#;
        let merged = merged_metadata(Some(client), Some(server)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(v["hoardfs"]["hfs_path"], "/2026-07/a__1.png");
        assert_eq!(v["exposure"], "120s");
        assert!(v.get("old").is_none(), "client wins everywhere else");

        // No server placement: client value passes through.
        assert_eq!(
            merged_metadata(Some(client), None).as_deref(),
            Some(client)
        );
        // Server placement survives a client None.
        let kept = merged_metadata(None, Some(server)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&kept).unwrap();
        assert_eq!(v["hoardfs"]["hfs_path"], "/2026-07/a__1.png");
    }
}
