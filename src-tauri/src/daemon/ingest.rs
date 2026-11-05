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
//! 2b. `PUT /api/push/images/{id}/asset/parts` — the same upload in
//!    sequential pieces, for paths that cap one request body (Cloudflare's
//!    edge allows 100 MB; stacked APS-C FITS files are larger). Each part
//!    carries the whole-file hash header plus `Content-Range: bytes
//!    <start>-<end>/<total>`; the daemon spools parts under
//!    `{data_dir}/uploads/` and the final part answers exactly what the
//!    whole-body PUT would. A part whose start is not the spooled length
//!    answers 409 with `received`, from which a client resumes.
//!
//! Server-owned fields: `images.blob_id` and the `hoardfs` key inside
//! `images.metadata` are never taken from the client on upsert (a client's
//! `hoardfs.hfs_path` is honored as a placement hint only when the daemon
//! has none yet). Per-user storage accounting is deferred to the
//! hosted-scale leaf.

use std::path::PathBuf;
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

/// Largest single part of a chunked asset upload; the whole-body route
/// takes up to `max_asset_bytes`. Sized to Cloudflare's 100 MB edge cap
/// (clients default to 64 MiB parts).
pub const MAX_PART_BYTES: usize = 100 << 20;

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

/// After a sync lands rows for a collection that is already published,
/// re-sign its records so the public gallery follows the pushed state.
/// The push itself has committed, so a signing failure is reported in the
/// response (`signed: false`, `signing_error`) rather than failing it.
fn resign_if_published(
    state: &DaemonState,
    user_id: &str,
    collection_id: &str,
    response: &mut serde_json::Value,
) {
    let Some(signer) = state.signer.as_ref() else {
        return;
    };
    let published = state.db.get().ok().and_then(|mut conn| {
        use crate::db::schema::published_collections;
        published_collections::table
            .filter(published_collections::collection_id.eq(collection_id))
            .filter(published_collections::user_id.eq(user_id))
            .count()
            .get_result::<i64>(&mut conn)
            .ok()
    });
    if published != Some(1) {
        return;
    }
    let Some(obj) = response.as_object_mut() else {
        return;
    };
    match crate::share::records::publish_signed(
        &state.db,
        &state.hoardfs,
        signer,
        user_id,
        collection_id,
    ) {
        Ok(Some(signed)) => {
            obj.insert("signed".into(), serde_json::json!(true));
            obj.insert("record".into(), serde_json::json!(signed));
        }
        Ok(None) => {
            obj.insert("signed".into(), serde_json::json!(false));
        }
        Err(e) => {
            log::warn!("push ingest: re-sign of {collection_id} failed: {e}");
            obj.insert("signed".into(), serde_json::json!(false));
            obj.insert("signing_error".into(), serde_json::json!(e.to_string()));
        }
    }
}

pub async fn push_collection(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Json(body): Json<PushCollectionBody>,
) -> Response {
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    let limits = state.limits;
    let state2 = state.clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut response = upsert_push(&db, &user_id, &body, limits)?;
        resign_if_published(&state2, &user_id, &body.collection.id, &mut response);
        Ok::<_, PushError>(response)
    })
    .await;
    match result {
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

    store_asset(state, user.user_id, id, computed, body).await
}

/// Verified bytes → the user's HoardFS volume + the image row. Shared by
/// the whole-body PUT and the last part of a chunked upload.
async fn store_asset(
    state: Arc<DaemonState>,
    user_id: String,
    id: String,
    computed: hoardfs_core::BlobId,
    body: Bytes,
) -> Response {
    let db = state.db.clone();
    let hoardfs = state.hoardfs.clone();
    let rt = tokio::runtime::Handle::current();
    let state2 = state.clone();

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

        // A FITS asset for a row without headers (the CLI upload path)
        // gets what the desktop importer would have recorded; a desktop
        // push already carries the header map and is left alone.
        let enrichment = super::upload::fits_enrichment(&image, &body);
        let metadata = {
            let mut value = image
                .metadata
                .as_deref()
                .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok())
                .unwrap_or_else(|| serde_json::json!({}));
            if let Some(obj) = value.as_object_mut() {
                if let Some(enrichment) = &enrichment {
                    for (key, header) in &enrichment.headers {
                        obj.entry(key.clone())
                            .or_insert_with(|| serde_json::Value::String(header.clone()));
                    }
                }
                obj.remove(super::upload::PENDING_HASH_KEY);
                obj.insert(
                    "hoardfs".to_string(),
                    serde_json::json!({ "hfs_path": hfs_path }),
                );
            }
            value.to_string()
        };
        let blank = |s: &Option<String>| s.as_deref().map_or(true, |s| s.trim().is_empty());
        let summary = match &enrichment {
            Some(e) if blank(&image.summary) && e.summary.is_some() => e.summary.clone(),
            _ => image.summary.clone(),
        };
        let description = match &enrichment {
            Some(e) if blank(&image.description) && e.description.is_some() => {
                e.description.clone()
            }
            _ => image.description.clone(),
        };
        diesel::update(images::table.find(&image.id))
            .set((
                images::blob_id.eq(Some(&stored_blob)),
                images::metadata.eq(Some(&metadata)),
                images::summary.eq(&summary),
                images::description.eq(&description),
                images::updated_at.eq(chrono::Utc::now().naive_utc()),
            ))
            .execute(&mut conn)
            .map_err(|e| e.to_string())?;
        // put_file regenerated the renditions of `stored_blob` (a re-push
        // of already-known content rewrites them in place): forget their
        // cached digests so the re-sign below hashes the bytes it has.
        crate::share::records::drop_variant_digests(
            &mut conn,
            &stored_blob,
            &crate::share::records::PUBLIC_RENDITIONS,
        )?;
        drop(conn);

        // The bytes behind a published image changed (or arrived): re-sign
        // every published collection that contains it so the records'
        // blob references follow. Best-effort; failures are logged.
        let resigned = match state2.signer.as_ref() {
            Some(signer) => crate::share::records::resign_collections_with_image(
                &db,
                &state2.hoardfs,
                signer,
                &user_id,
                &image.id,
            )
            .unwrap_or_else(|e| {
                log::warn!("put_image_asset: re-sign after upload failed: {e}");
                0
            }),
            None => 0,
        };

        Ok(Json(serde_json::json!({
            "status": "stored",
            "blob_id": stored_blob,
            "resigned_collections": resigned,
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

/// Parsed `Content-Range: bytes <start>-<end>/<total>` (inclusive end).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PartRange {
    pub start: u64,
    pub end: u64,
    pub total: u64,
}

pub(crate) fn parse_content_range(value: &str) -> Option<PartRange> {
    let rest = value.trim().strip_prefix("bytes")?.trim_start();
    let (range, total) = rest.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let r = PartRange {
        start: start.trim().parse().ok()?,
        end: end.trim().parse().ok()?,
        total: total.trim().parse().ok()?,
    };
    (r.start <= r.end && r.end < r.total).then_some(r)
}

/// Where one user's in-flight upload of `hash` for image `id` spools. The
/// name is a hash of the three, so nothing from the request reaches the
/// filesystem as a path component.
fn spool_path(dir: &std::path::Path, user_id: &str, image_id: &str, hash: &str) -> PathBuf {
    let key = blake3::hash(format!("{user_id}\n{image_id}\n{hash}").as_bytes()).to_hex();
    dir.join(format!("{key}.part"))
}

/// Remove spool files untouched for a week (an aborted client run that
/// never resumed). Called once at daemon startup.
pub fn sweep_stale_uploads(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(7 * 86_400);
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "part") {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|m| m < cutoff)
            .unwrap_or(false);
        if stale {
            match std::fs::remove_file(&path) {
                Ok(()) => log::info!("removed stale upload spool {}", path.display()),
                Err(e) => log::warn!("stale upload spool {}: {e}", path.display()),
            }
        }
    }
}

fn error_response(status: StatusCode, error: &str, message: String) -> Response {
    (
        status,
        Json(serde_json::json!({ "error": error, "message": message })),
    )
        .into_response()
}

enum PartOutcome {
    Reply(Response),
    Complete(hoardfs_core::BlobId, Bytes),
}

/// `PUT /api/push/images/{id}/asset/parts` — see the module docs. Parts
/// must arrive in order and each one must be the next byte of the file;
/// the last part completes the upload (hash verified over the spooled
/// whole) and answers like the whole-body route.
pub async fn put_image_asset_part(
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
        return error_response(
            StatusCode::BAD_REQUEST,
            "missing content hash",
            format!("{CONTENT_HASH_HEADER} header (blake3 hex of the whole file) is required"),
        );
    };
    if claimed_hash.len() != 64 || !claimed_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid content hash",
            format!("{CONTENT_HASH_HEADER} must be 64 hex characters"),
        );
    }
    let Some(range) = headers
        .get(axum::http::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_content_range)
    else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "missing content range",
            "Content-Range: bytes <start>-<end>/<total> is required".to_string(),
        );
    };
    if range.total > state.limits.max_asset_bytes as u64 {
        return error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "asset too large",
            format!(
                "{} bytes exceeds the {} byte asset limit",
                range.total, state.limits.max_asset_bytes
            ),
        );
    }
    if range.end - range.start + 1 != body.len() as u64 {
        return error_response(
            StatusCode::BAD_REQUEST,
            "part length mismatch",
            format!(
                "Content-Range covers {} bytes but the body has {}",
                range.end - range.start + 1,
                body.len()
            ),
        );
    }

    let spool = spool_path(&state.uploads_dir, &user.user_id, &id, &claimed_hash);
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    let image_id = id.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<PartOutcome, String> {
        let mut conn = db.get().map_err(|e| e.to_string())?;
        let Some(image) =
            crate::commands::images::fetch_owned_image(&mut conn, &user_id, &image_id)?
        else {
            return Ok(PartOutcome::Reply(
                (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({ "error": "not found" })),
                )
                    .into_response(),
            ));
        };
        drop(conn);

        let blob_id = format!("blake3:{claimed_hash}");
        if image.blob_id.as_deref() == Some(blob_id.as_str()) {
            let _ = std::fs::remove_file(&spool);
            return Ok(PartOutcome::Reply(
                Json(serde_json::json!({ "status": "skipped", "blob_id": blob_id }))
                    .into_response(),
            ));
        }

        if let Some(parent) = spool.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        let received = std::fs::metadata(&spool).map(|m| m.len()).unwrap_or(0);
        if received != range.start {
            return Ok(PartOutcome::Reply(
                (
                    StatusCode::CONFLICT,
                    Json(serde_json::json!({
                        "error": "out of order part",
                        "message": format!("expected the part starting at byte {received}"),
                        "received": received,
                        "total": range.total,
                    })),
                )
                    .into_response(),
            ));
        }
        {
            use std::io::Write as _;
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&spool)
                .map_err(|e| format!("open {}: {e}", spool.display()))?;
            file.write_all(&body)
                .map_err(|e| format!("write {}: {e}", spool.display()))?;
        }
        let received = range.end + 1;
        if received < range.total {
            return Ok(PartOutcome::Reply(
                (
                    StatusCode::ACCEPTED,
                    Json(serde_json::json!({
                        "status": "partial",
                        "received": received,
                        "total": range.total,
                    })),
                )
                    .into_response(),
            ));
        }

        let whole = std::fs::read(&spool).map_err(|e| format!("read {}: {e}", spool.display()))?;
        let _ = std::fs::remove_file(&spool);
        let computed = hoardfs_core::BlobId::from_hash(blake3::hash(&whole));
        if whole.len() as u64 != range.total || computed.to_hex() != claimed_hash {
            return Ok(PartOutcome::Reply(error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "content hash mismatch",
                "the assembled parts do not match x-astra-content-hash; start over".to_string(),
            )));
        }
        Ok(PartOutcome::Complete(computed, Bytes::from(whole)))
    })
    .await;

    match result {
        Ok(Ok(PartOutcome::Reply(response))) => response,
        Ok(Ok(PartOutcome::Complete(computed, whole))) => {
            store_asset(state, user.user_id, id, computed, whole).await
        }
        Ok(Err(e)) => {
            log::error!("put_image_asset_part: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "internal error" })),
            )
                .into_response()
        }
        Err(e) => {
            log::error!("put_image_asset_part task panicked: {e}");
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
            session_key: [7u8; 32],
            processing: Default::default(),
            tetra3_db: None,
            uploads_dir: std::env::temp_dir().join("astra-test-uploads"),
            handles: Default::default(),
            signer: None,
            mailer: Arc::new(crate::mail::LogMailer::default()),
            magic: Default::default(),
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

    #[tokio::test(flavor = "multi_thread")]
    async fn chunked_asset_assembles_in_order_and_resumes() {
        let (state, tmp, alice, bob) = seeded(IngestLimits::default()).await;
        let router = crate::daemon::router(state.clone());
        let collection_id = uuid::Uuid::new_v4().to_string();
        let image_ids = vec![uuid::Uuid::new_v4().to_string()];
        send(
            &router,
            "POST",
            "/api/push/collections",
            &alice,
            push_body(&collection_id, &image_ids, "chunks").into_bytes(),
            &[],
        )
        .await;
        let png = tiny_png();
        let hash = hash_of(&png);
        let uri = format!("/api/push/images/{}/asset/parts", image_ids[0]);
        let cut = png.len() / 3;
        let (a, rest) = png.split_at(cut);
        let (b, c) = rest.split_at(cut);
        let range =
            |start: usize, len: usize| format!("bytes {start}-{}/{}", start + len - 1, png.len());

        // Missing/invalid headers are 400s before anything is spooled.
        let (status, _) = send(
            &router,
            "PUT",
            &uri,
            &alice,
            a.to_vec(),
            &[(CONTENT_HASH_HEADER, &hash)],
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = send(
            &router,
            "PUT",
            &uri,
            &alice,
            a.to_vec(),
            &[
                (CONTENT_HASH_HEADER, &hash),
                ("content-range", &range(0, a.len() + 1)),
            ],
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "body/range length mismatch"
        );

        // Out of order: nothing spooled yet, so a part at offset `cut` is refused with received=0.
        let (status, body) = send(
            &router,
            "PUT",
            &uri,
            &alice,
            b.to_vec(),
            &[
                (CONTENT_HASH_HEADER, &hash),
                ("content-range", &range(cut, b.len())),
            ],
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["received"], 0);

        let (status, body) = send(
            &router,
            "PUT",
            &uri,
            &alice,
            a.to_vec(),
            &[
                (CONTENT_HASH_HEADER, &hash),
                ("content-range", &range(0, a.len())),
            ],
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED, "{body}");
        assert_eq!(body["received"], a.len());
        assert_eq!(body["total"], png.len());

        // A repeat of the first part (client restarted) is told where to resume.
        let (status, body) = send(
            &router,
            "PUT",
            &uri,
            &alice,
            a.to_vec(),
            &[
                (CONTENT_HASH_HEADER, &hash),
                ("content-range", &range(0, a.len())),
            ],
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["received"], a.len());

        // Bob cannot append to Alice's upload, nor see the image.
        let (status, _) = send(
            &router,
            "PUT",
            &uri,
            &bob,
            b.to_vec(),
            &[
                (CONTENT_HASH_HEADER, &hash),
                ("content-range", &range(cut, b.len())),
            ],
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let (status, _) = send(
            &router,
            "PUT",
            &uri,
            &alice,
            b.to_vec(),
            &[
                (CONTENT_HASH_HEADER, &hash),
                ("content-range", &range(cut, b.len())),
            ],
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        let (status, body) = send(
            &router,
            "PUT",
            &uri,
            &alice,
            c.to_vec(),
            &[
                (CONTENT_HASH_HEADER, &hash),
                ("content-range", &range(2 * cut, c.len())),
            ],
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["status"], "stored");
        assert_eq!(body["blob_id"], format!("blake3:{hash}"));
        assert!(
            std::fs::read_dir(&state.uploads_dir)
                .map(|d| d
                    .flatten()
                    .all(|e| e.path().extension().is_none_or(|x| x != "part")
                        || !e.file_name().to_string_lossy().contains(
                            &blake3::hash(format!("alice\n{}\n{hash}", image_ids[0]).as_bytes())
                                .to_hex()
                                .to_string()
                        )))
                .unwrap_or(true),
            "spool removed after completion"
        );

        // The bytes landed: the whole-body route now reports them as already held…
        let (status, body) = send(
            &router,
            "PUT",
            &format!("/api/push/images/{}/asset", image_ids[0]),
            &alice,
            png.clone(),
            &[(CONTENT_HASH_HEADER, &hash)],
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "skipped");
        // …and so does the parts route, without spooling anything.
        let (status, body) = send(
            &router,
            "PUT",
            &uri,
            &alice,
            a.to_vec(),
            &[
                (CONTENT_HASH_HEADER, &hash),
                ("content-range", &range(0, a.len())),
            ],
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "skipped");

        // Wrong bytes under a claimed hash: refused at the end, spool discarded.
        let image2 = uuid::Uuid::new_v4().to_string();
        send(
            &router,
            "POST",
            "/api/push/collections",
            &alice,
            push_body(
                &collection_id,
                &[image_ids[0].clone(), image2.clone()],
                "chunks",
            )
            .into_bytes(),
            &[],
        )
        .await;
        let uri2 = format!("/api/push/images/{image2}/asset/parts");
        let wrong = vec![9u8; png.len()];
        let (status, _) = send(
            &router,
            "PUT",
            &uri2,
            &alice,
            wrong[..cut].to_vec(),
            &[
                (CONTENT_HASH_HEADER, &hash),
                ("content-range", &range(0, cut)),
            ],
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        let (status, _) = send(
            &router,
            "PUT",
            &uri2,
            &alice,
            wrong[cut..].to_vec(),
            &[
                (CONTENT_HASH_HEADER, &hash),
                ("content-range", &range(cut, png.len() - cut)),
            ],
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        let (status, body) = send(
            &router,
            "PUT",
            &uri2,
            &alice,
            wrong[..cut].to_vec(),
            &[
                (CONTENT_HASH_HEADER, &hash),
                ("content-range", &range(0, cut)),
            ],
        )
        .await;
        assert_eq!(
            status,
            StatusCode::ACCEPTED,
            "spool was discarded, so offset 0 is accepted again: {body}"
        );

        // Total over the asset limit → 413 before spooling.
        let (small, _tmp2, carol, _) = seeded(IngestLimits {
            max_images_per_push: 10,
            max_asset_bytes: 64,
        })
        .await;
        let small_router = crate::daemon::router(small.clone());
        let (status, _) = send(
            &small_router,
            "PUT",
            &uri,
            &carol,
            vec![0u8; 10],
            &[
                (CONTENT_HASH_HEADER, &hash),
                ("content-range", "bytes 0-9/1000"),
            ],
        )
        .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        drop(tmp);
    }

    #[test]
    fn content_range_parsing() {
        let r = parse_content_range("bytes 0-99/1000").unwrap();
        assert_eq!((r.start, r.end, r.total), (0, 99, 1000));
        assert_eq!(
            parse_content_range("bytes 999-999/1000").map(|r| r.end),
            Some(999)
        );
        assert!(
            parse_content_range("bytes 0-1000/1000").is_none(),
            "end past total"
        );
        assert!(parse_content_range("bytes 5-4/10").is_none());
        assert!(parse_content_range("bytes */10").is_none());
        assert!(parse_content_range("0-9/10").is_none());
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
