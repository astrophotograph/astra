//! Externally processed renditions: `PUT /api/images/{id}/rendition` and
//! `POST /api/images/{id}/rendition/revert`.
//!
//! An image row is anchored to one HoardFS path — the original (usually a
//! stacked FITS). Everything the API serves for it is a *variant* of that
//! path: Preview and Thumbnail, which [`super::process`] rewrites when the
//! user processes in Astra. This route is the same idea for processing done
//! elsewhere (PixInsight, Siril, GraXpert, …): the caller sends the finished
//! JPEG/PNG/TIFF and the daemon stores it as the image's `Full` variant,
//! then derives Preview and Thumbnail from it with HoardFS's own image
//! generator — so the processed look replaces the auto-stretch everywhere
//! the API serves bytes, while the FITS stays untouched as the source of
//! truth for headers, plate solving and re-processing.
//!
//! Two metadata keys record this:
//! - `metadata.rendition` — the attached master: `{ tool, filename,
//!   content_hash, content_type, attached_at, width, height }`. Durable: it
//!   describes the `Full` variant, which in-app processing never touches.
//! - `metadata.processing` — what the *current* Preview/Thumbnail came
//!   from, shared with the in-app path (`engine: "processinator-native"`);
//!   attaching writes `engine: "external"`. The process route reads it and
//!   refuses (409) to clobber an external result unless told to.
//!
//! Revert re-derives Preview/Thumbnail from the stored `Full` variant and
//! flips `processing` back to external — the undo for a forced in-app
//! process over an attached rendition.
//!
//! Idempotent: re-sending bytes whose blake3 matches the recorded
//! `content_hash` is a `skipped` no-op, so a watch loop can retry freely.
//! Shares the per-user processing slot with the process route so the two
//! can't race on the same variants.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use hoardfs_core::Quality;
use hoardfs_variant::{ImageGenerator, VariantGenerator};
use serde::Deserialize;

use super::api::{image_out, internal, not_found};
use super::auth::AuthedUser;
use super::ingest::CONTENT_HASH_HEADER;
use super::DaemonState;
use crate::commands::hoardfs::resolve_hfs_path;
use crate::commands::images::get_image_core;
use crate::db::models::Image;
use crate::db::tenancy;

/// `metadata.processing.engine` value this route records.
pub const ENGINE_EXTERNAL: &str = "external";

/// Rendition content types accepted (the ones HoardFS's image generator can
/// turn into Preview/Thumbnail). FITS is deliberately absent: a processed
/// FITS is a new original, not a rendition.
const ACCEPTED_TYPES: [&str; 4] = ["image/jpeg", "image/png", "image/tiff", "image/webp"];

#[derive(Debug, Default, Deserialize)]
pub struct RenditionQuery {
    /// Tool that produced the rendition, free text (recorded, not used).
    pub tool: Option<String>,
    /// Original filename of the rendition (recorded, not used).
    pub filename: Option<String>,
}

fn metadata_object(image: &Image, key: &str) -> Option<serde_json::Value> {
    let root = serde_json::from_str::<serde_json::Value>(image.metadata.as_deref()?).ok()?;
    root.get(key).filter(|p| p.is_object()).cloned()
}

/// The `processing` object of an image's metadata, if present.
pub(crate) fn processing_info(image: &Image) -> Option<serde_json::Value> {
    metadata_object(image, "processing")
}

/// The `rendition` object (the attached master), if one was ever attached.
pub(crate) fn rendition_info(image: &Image) -> Option<serde_json::Value> {
    metadata_object(image, "rendition")
}

/// Whether the image's current Preview/Thumbnail came from outside Astra.
pub(crate) fn is_externally_processed(image: &Image) -> bool {
    processing_info(image)
        .and_then(|p| p.get("engine").and_then(|e| e.as_str().map(str::to_string)))
        .is_some_and(|engine| engine == ENGINE_EXTERNAL)
}

/// Resolve the rendition's MIME type: the request's `Content-Type` when it
/// names an accepted image type, else sniffed from the bytes. `None` when
/// neither yields something the generator can decode.
fn rendition_content_type(headers: &HeaderMap, bytes: &[u8]) -> Option<&'static str> {
    let declared = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or("").trim().to_ascii_lowercase());
    if let Some(declared) = declared.as_deref() {
        let declared = match declared {
            "image/jpg" => "image/jpeg",
            "image/tif" => "image/tiff",
            other => other,
        };
        if let Some(accepted) = ACCEPTED_TYPES.iter().find(|t| **t == declared) {
            return Some(accepted);
        }
    }
    match image::guess_format(bytes).ok()? {
        image::ImageFormat::Jpeg => Some("image/jpeg"),
        image::ImageFormat::Png => Some("image/png"),
        image::ImageFormat::Tiff => Some("image/tiff"),
        image::ImageFormat::WebP => Some("image/webp"),
        _ => None,
    }
}

fn unprocessable(message: &str) -> Response {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        Json(serde_json::json!({ "error": message })),
    )
        .into_response()
}

fn busy() -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        Json(serde_json::json!({ "error": "processing already in progress" })),
    )
        .into_response()
}

/// Owner-scoped lookup: someone else's image id is indistinguishable from
/// a missing one.
async fn owned_image(state: &DaemonState, user_id: &str, id: &str) -> Result<Image, Response> {
    let db = state.db.clone();
    let user_id = user_id.to_string();
    let lookup_id = id.to_string();
    match tokio::task::spawn_blocking(move || get_image_core(&db, &user_id, &lookup_id)).await {
        Ok(Ok(Some(image))) => Ok(image),
        Ok(Ok(None)) => Err(not_found()),
        Ok(Err(e)) => Err(internal("rendition lookup", e)),
        Err(e) => Err(internal("rendition lookup task", e.to_string())),
    }
}

/// Failure of deriving/storing the renditions.
enum StoreError {
    /// The generator could not decode the bytes (or doesn't know the type).
    Undecodable,
    Other(String),
}

impl From<String> for StoreError {
    fn from(e: String) -> Self {
        Self::Other(e)
    }
}

/// Derive Preview + Thumbnail from `full` with HoardFS's image generator
/// and store them (plus, when `store_full`, the master itself as `Full`)
/// as variants of `path`. Blocking (HoardFS + decode); run inside
/// `spawn_blocking`. Returns the preview dimensions.
fn store_renditions(
    hfs_arc: &Arc<std::sync::Mutex<hoardfs_volume::HoardFs>>,
    rt: &tokio::runtime::Handle,
    volume: &str,
    path: &str,
    full: &[u8],
    content_type: &str,
    store_full: bool,
) -> Result<(u32, u32), StoreError> {
    let generator = ImageGenerator::new();
    let preview = rt
        .block_on(generator.generate(full, content_type, &Quality::Preview))
        .map_err(|e| format!("preview generation: {e}"))?
        .ok_or(StoreError::Undecodable)?;
    let thumbnail = rt
        .block_on(generator.generate(full, content_type, &Quality::Thumbnail))
        .map_err(|e| format!("thumbnail generation: {e}"))?
        .ok_or(StoreError::Undecodable)?;

    let hfs = hfs_arc
        .lock()
        .map_err(|_| "HoardFS lock poisoned".to_string())?;
    if store_full {
        rt.block_on(hfs.add_variant(volume, path, Quality::Full, full, content_type))
            .map_err(|e| format!("store full variant: {e}"))?;
    }
    rt.block_on(hfs.add_variant(
        volume,
        path,
        Quality::Preview,
        &preview.data,
        &preview.content_type,
    ))
    .map_err(|e| format!("store preview variant: {e}"))?;
    rt.block_on(hfs.add_variant(
        volume,
        path,
        Quality::Thumbnail,
        &thumbnail.data,
        &thumbnail.content_type,
    ))
    .map_err(|e| format!("store thumbnail variant: {e}"))?;
    Ok((preview.width, preview.height))
}

/// Record `processing` (and, when given, `rendition`) in the image's
/// metadata, bump `updated_at` (the web app versions its preview URLs on
/// it), and let the digest/signing layer follow the rewritten renditions.
/// Blocking; run inside `spawn_blocking`.
fn record_processing(
    state: &DaemonState,
    image: &Image,
    processing: serde_json::Value,
    rendition: Option<serde_json::Value>,
) -> Result<Image, String> {
    use crate::db::schema::images;
    use diesel::prelude::*;

    let mut root = image
        .metadata
        .as_deref()
        .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(obj) = root.as_object_mut() {
        obj.insert("processing".to_string(), processing);
        if let Some(rendition) = rendition {
            obj.insert("rendition".to_string(), rendition);
        }
    }

    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    diesel::update(images::table.find(&image.id))
        .set((
            images::metadata.eq(Some(root.to_string())),
            images::updated_at.eq(chrono::Utc::now().naive_utc()),
        ))
        .execute(&mut conn)
        .map_err(|e| e.to_string())?;
    let updated = images::table
        .find(&image.id)
        .first::<Image>(&mut conn)
        .map_err(|e| e.to_string())?;
    drop(conn);

    if let Some(blob_id) = image.blob_id.as_deref() {
        if let Err(e) = crate::share::records::on_variant_written(
            &state.db,
            &state.hoardfs,
            state.signer.as_deref(),
            blob_id,
            &crate::share::records::PUBLIC_RENDITIONS,
        ) {
            log::warn!(
                "rendition {}: digest invalidation after variant rewrite failed: {e}",
                image.id
            );
        }
    }
    Ok(updated)
}

/// The `processing` block for an externally attached rendition: the
/// rendition's identity plus the engine marker the process route gates on.
fn external_processing(rendition: &serde_json::Value, reverted: bool) -> serde_json::Value {
    let mut processing = serde_json::json!({
        "processed_at": chrono::Utc::now().to_rfc3339(),
        "engine": ENGINE_EXTERNAL,
    });
    for key in [
        "tool",
        "filename",
        "content_hash",
        "content_type",
        "width",
        "height",
    ] {
        if let Some(v) = rendition.get(key) {
            processing[key] = v.clone();
        }
    }
    if reverted {
        processing["reverted"] = serde_json::Value::Bool(true);
    }
    processing
}

pub async fn attach_rendition(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(id): Path<String>,
    Query(query): Query<RenditionQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let started = std::time::Instant::now();
    if body.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "empty body" })),
        )
            .into_response();
    }

    // Optional integrity check, same header as the asset route; browsers
    // have no cheap blake3 so it is not required.
    let computed = hoardfs_core::BlobId::from_hash(blake3::hash(&body));
    if let Some(claimed) = headers
        .get(CONTENT_HASH_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim_start_matches("blake3:").to_lowercase())
    {
        if computed.to_hex() != claimed {
            return unprocessable("body does not match x-astra-content-hash");
        }
    }

    let Some(content_type) = rendition_content_type(&headers, &body) else {
        return unprocessable("rendition must be a JPEG, PNG, TIFF or WebP image");
    };

    // Same slot as the process route: never two writers on one user's
    // variants at once
    let Some(_permit) = state.processing.try_acquire(&user.user_id) else {
        return busy();
    };

    let image = match owned_image(&state, &user.user_id, &id).await {
        Ok(image) => image,
        Err(response) => return response,
    };
    let Some(hfs_path) = resolve_hfs_path(&image) else {
        return unprocessable("image has no stored original to attach a rendition to");
    };
    let solver = super::solve::solver_available_for(&state);

    // Same bytes as last time, still the served look: nothing to do
    let content_hash = computed.to_string();
    let already = is_externally_processed(&image)
        && processing_info(&image)
            .and_then(|p| p.get("content_hash").and_then(|h| h.as_str().map(str::to_string)))
            .is_some_and(|h| h == content_hash);
    if already {
        return Json(serde_json::json!({
            "status": "skipped",
            "image": image_out(image, solver),
        }))
        .into_response();
    }

    // Decode header only for the recorded dimensions; the generator
    // decodes the pixels itself
    let full_dims = image::ImageReader::new(std::io::Cursor::new(&body[..]))
        .with_guessed_format()
        .ok()
        .and_then(|r| r.into_dimensions().ok());

    let hfs_arc = state.hoardfs.clone();
    let rt = tokio::runtime::Handle::current();
    let volume = tenancy::volume_name(&user.user_id);
    let path_for_task = hfs_path.clone();
    let bytes_for_task = body.clone();
    let stored = tokio::task::spawn_blocking(move || {
        store_renditions(
            &hfs_arc,
            &rt,
            &volume,
            &path_for_task,
            &bytes_for_task,
            content_type,
            true,
        )
    })
    .await;
    let preview_dims = match stored {
        Ok(Ok(dims)) => dims,
        Ok(Err(StoreError::Undecodable)) => {
            return unprocessable("rendition could not be decoded as an image");
        }
        Ok(Err(StoreError::Other(e))) => return internal("rendition store", e),
        Err(e) => return internal("rendition store task", e.to_string()),
    };

    let mut rendition = serde_json::json!({
        "attached_at": chrono::Utc::now().to_rfc3339(),
        "content_hash": content_hash,
        "content_type": content_type,
    });
    if let Some(tool) = query.tool.filter(|t| !t.trim().is_empty()) {
        rendition["tool"] = serde_json::Value::String(tool);
    }
    if let Some(filename) = query
        .filename
        .filter(|f| !f.trim().is_empty())
        .map(|f| f.rsplit(['/', '\\']).next().unwrap_or("").to_string())
    {
        rendition["filename"] = serde_json::Value::String(filename);
    }
    if let Some((w, h)) = full_dims {
        rendition["width"] = serde_json::json!(w);
        rendition["height"] = serde_json::json!(h);
    }
    let processing = external_processing(&rendition, false);

    let state_for_task = state.clone();
    let image_for_task = image.clone();
    let updated = tokio::task::spawn_blocking(move || {
        record_processing(&state_for_task, &image_for_task, processing, Some(rendition))
    })
    .await;
    let image = match updated {
        Ok(Ok(image)) => image,
        Ok(Err(e)) => return internal("rendition record update", e),
        Err(e) => return internal("rendition record update task", e.to_string()),
    };

    log::info!(
        "attached external rendition to image {id} for {} ({content_type}, {} bytes, {}x{} preview) in {:?}",
        user.user_id,
        body.len(),
        preview_dims.0,
        preview_dims.1,
        started.elapsed()
    );

    Json(serde_json::json!({
        "status": "stored",
        "preview": { "width": preview_dims.0, "height": preview_dims.1 },
        "image": image_out(image, solver),
    }))
    .into_response()
}

/// `POST /api/images/{id}/rendition/revert` — make the attached rendition
/// the served Preview/Thumbnail again after an in-app process replaced
/// them. 404 `no_attached_rendition` when the image has no `Full` variant.
pub async fn revert_rendition(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(id): Path<String>,
) -> Response {
    let started = std::time::Instant::now();
    let Some(_permit) = state.processing.try_acquire(&user.user_id) else {
        return busy();
    };
    let image = match owned_image(&state, &user.user_id, &id).await {
        Ok(image) => image,
        Err(response) => return response,
    };
    let Some(hfs_path) = resolve_hfs_path(&image) else {
        return unprocessable("image has no stored original");
    };
    let solver = super::solve::solver_available_for(&state);

    if is_externally_processed(&image) {
        return Json(serde_json::json!({
            "status": "skipped",
            "image": image_out(image, solver),
        }))
        .into_response();
    }

    // The master must be a Full variant: get_file_quality falls back to
    // lesser variants (or the original), which would be re-deriving the
    // auto-stretch from itself
    let hfs_arc = state.hoardfs.clone();
    let rt = tokio::runtime::Handle::current();
    let volume = tenancy::volume_name(&user.user_id);
    let path_for_task = hfs_path.clone();
    let result = tokio::task::spawn_blocking(move || {
        let full = {
            let hfs = hfs_arc
                .lock()
                .map_err(|_| "HoardFS lock poisoned".to_string())?;
            rt.block_on(hfs.get_file_quality(&volume, &path_for_task, Quality::Full))
                .map_err(|e| format!("fetch full variant {path_for_task}: {e}"))?
        };
        let (bytes, quality, content_type) = full;
        if quality != Quality::Full {
            return Ok::<_, StoreError>(None);
        }
        store_renditions(
            &hfs_arc,
            &rt,
            &volume,
            &path_for_task,
            &bytes,
            &content_type,
            false,
        )
        .map(Some)
    })
    .await;
    let preview_dims = match result {
        Ok(Ok(Some(dims))) => dims,
        Ok(Ok(None)) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": "no_attached_rendition",
                    "message": "this image has no attached rendition to revert to",
                })),
            )
                .into_response();
        }
        Ok(Err(StoreError::Undecodable)) => {
            return unprocessable("the attached rendition could no longer be decoded");
        }
        Ok(Err(StoreError::Other(e))) => return internal("rendition revert", e),
        Err(e) => return internal("rendition revert task", e.to_string()),
    };

    // Images attached before `metadata.rendition` existed carry the same
    // fields in their (now overwritten) processing block; fall back to an
    // empty record rather than refusing
    let rendition = rendition_info(&image).unwrap_or_else(|| serde_json::json!({}));
    let processing = external_processing(&rendition, true);
    let state_for_task = state.clone();
    let image_for_task = image.clone();
    let updated = tokio::task::spawn_blocking(move || {
        record_processing(&state_for_task, &image_for_task, processing, None)
    })
    .await;
    let image = match updated {
        Ok(Ok(image)) => image,
        Ok(Err(e)) => return internal("rendition revert record update", e),
        Err(e) => return internal("rendition revert record update task", e.to_string()),
    };

    log::info!(
        "reverted image {id} for {} to its attached rendition ({}x{} preview) in {:?}",
        user.user_id,
        preview_dims.0,
        preview_dims.1,
        started.elapsed()
    );
    Json(serde_json::json!({
        "status": "stored",
        "preview": { "width": preview_dims.0, "height": preview_dims.1 },
        "image": image_out(image, solver),
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::process::tests::{json, request, seeded};
    use axum::body::to_bytes;
    use tower::ServiceExt;

    fn png(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
        let img = image::RgbImage::from_pixel(width, height, image::Rgb(rgb));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }

    async fn put_rendition(
        router: &axum::Router,
        token: &str,
        uri: &str,
        content_type: Option<&str>,
        body: Vec<u8>,
    ) -> (StatusCode, serde_json::Value) {
        let mut req = axum::http::Request::builder()
            .method("PUT")
            .uri(uri)
            .header("Authorization", format!("Bearer {token}"));
        if let Some(ct) = content_type {
            req = req.header(header::CONTENT_TYPE, ct);
        }
        let resp = router
            .clone()
            .oneshot(req.body(axum::body::Body::from(body)).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, value)
    }

    async fn preview_dims(router: &axum::Router, token: &str, id: &str) -> (u32, u32) {
        let (status, _, bytes) =
            request(router, "GET", token, &format!("/api/images/{id}/preview"), None).await;
        assert_eq!(status, StatusCode::OK);
        let decoded = image::load_from_memory(&bytes).unwrap();
        (decoded.width(), decoded.height())
    }

    fn metadata_of(body: &serde_json::Value) -> serde_json::Value {
        serde_json::from_str(body["image"]["metadata"].as_str().unwrap()).unwrap()
    }

    #[tokio::test]
    async fn attach_replaces_preview_and_records_provenance() {
        let (state, _tmp, alice, _bob, image) = seeded().await;
        let router = crate::daemon::router(state.clone());

        let before = preview_dims(&router, &alice, &image.id).await;
        let (status, body) = put_rendition(
            &router,
            &alice,
            &format!(
                "/api/images/{}/rendition?tool=PixInsight&filename=C%3A%5Cout%5Cm42_final.png",
                image.id
            ),
            Some("image/png"),
            png(300, 200, [200, 30, 30]),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["status"], "stored");
        assert_eq!(body["preview"]["width"], 300);
        assert_eq!(body["preview"]["height"], 200);

        // Served preview is now the rendition (small enough to be kept as-is)
        let after = preview_dims(&router, &alice, &image.id).await;
        assert_ne!(before, after);
        assert_eq!(after, (300, 200));

        // Provenance on the row, the Full master in HoardFS
        let metadata = metadata_of(&body);
        let processing = &metadata["processing"];
        assert_eq!(processing["engine"], ENGINE_EXTERNAL);
        assert_eq!(processing["tool"], "PixInsight");
        assert_eq!(processing["filename"], "m42_final.png");
        assert_eq!(processing["content_type"], "image/png");
        assert_eq!(processing["width"], 300);
        assert_eq!(processing["height"], 200);
        assert!(processing["content_hash"]
            .as_str()
            .unwrap()
            .starts_with("blake3:"));
        let rendition = &metadata["rendition"];
        assert_eq!(rendition["tool"], "PixInsight");
        assert_eq!(rendition["content_hash"], processing["content_hash"]);
        assert!(rendition["attached_at"].is_string());
        let variants = state
            .hoardfs
            .lock()
            .unwrap()
            .list_variants("user-alice", "/2026/m42.fits")
            .unwrap();
        assert!(variants.iter().any(|v| v.quality == Quality::Full));

        // The row still says it is processable: the FITS is untouched
        assert_eq!(body["image"]["processable"], true);
    }

    #[tokio::test]
    async fn attach_same_bytes_is_skipped() {
        let (state, _tmp, alice, _bob, image) = seeded().await;
        let router = crate::daemon::router(state);
        let bytes = png(64, 64, [1, 2, 3]);
        let uri = format!("/api/images/{}/rendition", image.id);
        let (status, body) = put_rendition(&router, &alice, &uri, None, bytes.clone()).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["status"], "stored");
        let (status, body) = put_rendition(&router, &alice, &uri, None, bytes).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["status"], "skipped");
    }

    #[tokio::test]
    async fn attach_verifies_declared_hash() {
        let (state, _tmp, alice, _bob, image) = seeded().await;
        let router = crate::daemon::router(state);
        let req = axum::http::Request::builder()
            .method("PUT")
            .uri(format!("/api/images/{}/rendition", image.id))
            .header("Authorization", format!("Bearer {alice}"))
            .header(CONTENT_HASH_HEADER, "0".repeat(64))
            .body(axum::body::Body::from(png(8, 8, [0, 0, 0])))
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn attach_rejects_non_image_bytes() {
        let (state, _tmp, alice, _bob, image) = seeded().await;
        let router = crate::daemon::router(state);
        let (status, body) = put_rendition(
            &router,
            &alice,
            &format!("/api/images/{}/rendition", image.id),
            Some("image/png"),
            b"definitely not a png".to_vec(),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    }

    #[tokio::test]
    async fn attach_to_someone_elses_image_is_not_found() {
        let (state, _tmp, _alice, bob, image) = seeded().await;
        let router = crate::daemon::router(state);
        let (status, _) = put_rendition(
            &router,
            &bob,
            &format!("/api/images/{}/rendition", image.id),
            Some("image/png"),
            png(8, 8, [0, 0, 0]),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn process_refuses_to_clobber_external_rendition_without_force() {
        let (state, _tmp, alice, _bob, image) = seeded().await;
        let router = crate::daemon::router(state);
        let (status, body) = put_rendition(
            &router,
            &alice,
            &format!("/api/images/{}/rendition", image.id),
            Some("image/png"),
            png(120, 80, [9, 9, 9]),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");

        let process_uri = format!("/api/images/{}/process", image.id);
        let (status, _, bytes) =
            request(&router, "POST", &alice, &process_uri, Some(serde_json::json!({}))).await;
        assert_eq!(status, StatusCode::CONFLICT);
        let body = json(&bytes);
        assert_eq!(body["error"], "external_processing");
        assert_eq!(body["processing"]["engine"], ENGINE_EXTERNAL);
        // Preview untouched by the refused call
        assert_eq!(preview_dims(&router, &alice, &image.id).await, (120, 80));

        // The MTF live-stretch Apply goes through the same gate
        let (status, _, _) = request(
            &router,
            "POST",
            &alice,
            &process_uri,
            Some(serde_json::json!({ "stretchMethod": "mtf" })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);

        let (status, _, bytes) = request(
            &router,
            "POST",
            &alice,
            &format!("{process_uri}?force=1"),
            Some(serde_json::json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&bytes));
        let body = json(&bytes);
        let metadata = metadata_of(&body);
        assert_eq!(metadata["processing"]["engine"], "processinator-native");
        assert_ne!(preview_dims(&router, &alice, &image.id).await, (120, 80));
        // The attached master's record survives the in-app process
        assert_eq!(metadata["rendition"]["content_type"], "image/png");
    }

    #[tokio::test]
    async fn revert_restores_attached_rendition_after_in_app_processing() {
        let (state, _tmp, alice, bob, image) = seeded().await;
        let router = crate::daemon::router(state);
        let revert_uri = format!("/api/images/{}/rendition/revert", image.id);

        // Nothing attached yet: nothing to revert to
        let (status, _, bytes) = request(&router, "POST", &alice, &revert_uri, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(json(&bytes)["error"], "no_attached_rendition");

        let (status, body) = put_rendition(
            &router,
            &alice,
            &format!("/api/images/{}/rendition?tool=Siril", image.id),
            Some("image/png"),
            png(120, 80, [9, 9, 9]),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");

        // Already the served look: a no-op
        let (status, _, bytes) = request(&router, "POST", &alice, &revert_uri, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json(&bytes)["status"], "skipped");

        // Force an in-app process over it, then undo
        let (status, _, _) = request(
            &router,
            "POST",
            &alice,
            &format!("/api/images/{}/process?force=1", image.id),
            Some(serde_json::json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_ne!(preview_dims(&router, &alice, &image.id).await, (120, 80));

        let (status, _, _) = request(&router, "POST", &bob, &revert_uri, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let (status, _, bytes) = request(&router, "POST", &alice, &revert_uri, None).await;
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&bytes));
        let body = json(&bytes);
        assert_eq!(body["status"], "stored");
        assert_eq!(body["preview"]["width"], 120);
        assert_eq!(preview_dims(&router, &alice, &image.id).await, (120, 80));
        let processing = &metadata_of(&body)["processing"];
        assert_eq!(processing["engine"], ENGINE_EXTERNAL);
        assert_eq!(processing["tool"], "Siril");
        assert_eq!(processing["reverted"], true);

        // And the process route gates on it again
        let (status, _, _) = request(
            &router,
            "POST",
            &alice,
            &format!("/api/images/{}/process", image.id),
            Some(serde_json::json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
    }
}
