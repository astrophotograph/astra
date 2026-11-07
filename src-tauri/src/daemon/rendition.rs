//! Externally processed renditions: `PUT /api/images/{id}/rendition`.
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
//! Provenance lives in `metadata.processing` next to what the in-app path
//! records: `{ engine: "external", tool, filename, content_hash,
//! processed_at, width, height }`. The in-app process route reads it and
//! refuses (409) to clobber an external result unless told to.
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

/// The `processing` object of an image's metadata, if present.
pub(crate) fn processing_info(image: &Image) -> Option<serde_json::Value> {
    let root = serde_json::from_str::<serde_json::Value>(image.metadata.as_deref()?).ok()?;
    root.get("processing").filter(|p| p.is_object()).cloned()
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
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({ "error": "processing already in progress" })),
        )
            .into_response();
    };

    let db = state.db.clone();
    let user_id = user.user_id.clone();
    let lookup_id = id.clone();
    let image = match tokio::task::spawn_blocking(move || {
        get_image_core(&db, &user_id, &lookup_id)
    })
    .await
    {
        Ok(Ok(Some(image))) => image,
        Ok(Ok(None)) => return not_found(),
        Ok(Err(e)) => return internal("rendition lookup", e),
        Err(e) => return internal("rendition lookup task", e.to_string()),
    };
    let Some(hfs_path) = resolve_hfs_path(&image) else {
        return unprocessable("image has no stored original to attach a rendition to");
    };
    let solver = super::solve::solver_available_for(&state);

    // Same bytes as last time: nothing to do
    let content_hash = computed.to_string();
    let already = processing_info(&image)
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
        let generator = ImageGenerator::new();
        let preview = rt
            .block_on(generator.generate(&bytes_for_task, content_type, &Quality::Preview))
            .map_err(|e| format!("preview generation: {e}"))?
            .ok_or_else(|| "undecodable".to_string())?;
        let thumbnail = rt
            .block_on(generator.generate(&bytes_for_task, content_type, &Quality::Thumbnail))
            .map_err(|e| format!("thumbnail generation: {e}"))?
            .ok_or_else(|| "undecodable".to_string())?;

        let hfs = hfs_arc
            .lock()
            .map_err(|_| "HoardFS lock poisoned".to_string())?;
        rt.block_on(hfs.add_variant(
            &volume,
            &path_for_task,
            Quality::Full,
            &bytes_for_task,
            content_type,
        ))
        .map_err(|e| format!("store full variant: {e}"))?;
        rt.block_on(hfs.add_variant(
            &volume,
            &path_for_task,
            Quality::Preview,
            &preview.data,
            &preview.content_type,
        ))
        .map_err(|e| format!("store preview variant: {e}"))?;
        rt.block_on(hfs.add_variant(
            &volume,
            &path_for_task,
            Quality::Thumbnail,
            &thumbnail.data,
            &thumbnail.content_type,
        ))
        .map_err(|e| format!("store thumbnail variant: {e}"))?;
        Ok::<_, String>((preview.width, preview.height))
    })
    .await;

    let preview_dims = match stored {
        Ok(Ok(dims)) => dims,
        Ok(Err(e)) if e == "undecodable" => {
            return unprocessable("rendition could not be decoded as an image");
        }
        Ok(Err(e)) => return internal("rendition store", e),
        Err(e) => return internal("rendition store task", e.to_string()),
    };

    // Record provenance and bump updated_at (the web app versions its
    // preview URLs on it), then let the digest/signing layer follow the
    // rewritten renditions
    let db = state.db.clone();
    let hoardfs_for_hook = state.hoardfs.clone();
    let signer_for_hook = state.signer.clone();
    let record_id = image.id.clone();
    let blob_for_hook = image.blob_id.clone();
    let existing_metadata = image.metadata.clone();
    let tool = query.tool.filter(|t| !t.trim().is_empty());
    let filename = query
        .filename
        .filter(|f| !f.trim().is_empty())
        .map(|f| f.rsplit(['/', '\\']).next().unwrap_or("").to_string());
    let updated = tokio::task::spawn_blocking(move || {
        use crate::db::schema::images;
        use diesel::prelude::*;

        let mut root = existing_metadata
            .as_deref()
            .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        if let Some(obj) = root.as_object_mut() {
            let mut processing = serde_json::json!({
                "processed_at": chrono::Utc::now().to_rfc3339(),
                "engine": ENGINE_EXTERNAL,
                "content_hash": content_hash,
                "content_type": content_type,
            });
            if let Some(tool) = tool {
                processing["tool"] = serde_json::Value::String(tool);
            }
            if let Some(filename) = filename {
                processing["filename"] = serde_json::Value::String(filename);
            }
            if let Some((w, h)) = full_dims {
                processing["width"] = serde_json::json!(w);
                processing["height"] = serde_json::json!(h);
            }
            obj.insert("processing".to_string(), processing);
        }

        let mut conn = db.get().map_err(|e| e.to_string())?;
        diesel::update(images::table.find(&record_id))
            .set((
                images::metadata.eq(Some(root.to_string())),
                images::updated_at.eq(chrono::Utc::now().naive_utc()),
            ))
            .execute(&mut conn)
            .map_err(|e| e.to_string())?;
        let image = images::table
            .find(&record_id)
            .first::<Image>(&mut conn)
            .map_err(|e| e.to_string())?;
        drop(conn);

        if let Some(blob_id) = blob_for_hook.as_deref() {
            if let Err(e) = crate::share::records::on_variant_written(
                &db,
                &hoardfs_for_hook,
                signer_for_hook.as_deref(),
                blob_id,
                &crate::share::records::PUBLIC_RENDITIONS,
            ) {
                log::warn!(
                    "rendition {record_id}: digest invalidation after variant rewrite failed: {e}"
                );
            }
        }
        Ok::<_, String>(image)
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
        let metadata: serde_json::Value =
            serde_json::from_str(body["image"]["metadata"].as_str().unwrap()).unwrap();
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
        let metadata: serde_json::Value =
            serde_json::from_str(body["image"]["metadata"].as_str().unwrap()).unwrap();
        assert_eq!(metadata["processing"]["engine"], "processinator-native");
        assert_ne!(preview_dims(&router, &alice, &image.id).await, (120, 80));
    }
}
