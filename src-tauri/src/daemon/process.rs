//! Server-side image processing: `POST /api/images/{id}/process`.
//!
//! Runs the native processinator pipeline (see [`crate::processing`]) over
//! the image's FITS asset in the caller's HoardFS volume and stores the
//! result as the image's Preview/Thumbnail variants — the same variants
//! `/api/images/{id}/preview` and `/thumbnail` serve, so the processed look
//! replaces the auto-generated stretch everywhere the API serves bytes.
//! The `UNIQUE(source_blob_id, quality)` constraint in the variant store
//! makes the replacement atomic per quality; re-processing overwrites.
//!
//! Synchronous by design (seconds-scale work, web `listen()` is a no-op)
//! with a per-user concurrency cap of 1 to protect the VM: a second
//! concurrent request from the same user gets 429.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use hoardfs_core::Quality;
use serde::Deserialize;

use super::api::{image_out, internal, not_found};
use super::auth::AuthedUser;
use super::DaemonState;
use crate::commands::hoardfs::resolve_hfs_path;
use crate::commands::images::get_image_core;
use crate::db::models::Image;
use crate::db::tenancy;
use crate::processing;
use crate::python::image_process::ProcessingParams;

/// Per-user in-flight processing registry. One entry per user currently
/// processing; a second request 429s instead of queueing a second worker.
#[derive(Clone, Default)]
pub struct ProcessingLocks(Arc<Mutex<HashSet<String>>>);

impl ProcessingLocks {
    /// Acquire the user's slot; None when a run is already in flight.
    pub fn try_acquire(&self, user_id: &str) -> Option<ProcessingPermit> {
        let mut held = self.0.lock().expect("processing lock poisoned");
        if !held.insert(user_id.to_string()) {
            return None;
        }
        Some(ProcessingPermit {
            locks: self.clone(),
            user_id: user_id.to_string(),
        })
    }
}

/// RAII slot handle — releases the user's slot on drop (including panics
/// and early returns).
pub struct ProcessingPermit {
    locks: ProcessingLocks,
    user_id: String,
}

impl Drop for ProcessingPermit {
    fn drop(&mut self) {
        if let Ok(mut held) = self.locks.0.lock() {
            held.remove(&self.user_id);
        }
    }
}

/// Whether this image has a FITS asset the daemon can process. The
/// server-truth flag behind the web Process button.
pub(crate) fn processable(image: &Image) -> bool {
    let Some(path) = resolve_hfs_path(image) else {
        return false;
    };
    let lower = path.to_lowercase();
    lower.ends_with(".fit")
        || lower.ends_with(".fits")
        || image
            .content_type
            .as_deref()
            .is_some_and(|t| t.to_lowercase().contains("fits"))
}

/// Request body — the desktop `ProcessImageInput` minus the id (which is
/// in the path). Absent fields take the `ProcessingParams` defaults.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessBody {
    target_type: Option<String>,
    stretch_method: Option<String>,
    stretch_factor: Option<f64>,
    background_removal: Option<bool>,
    star_reduction: Option<bool>,
    color_calibration: Option<bool>,
    noise_reduction: Option<f64>,
    contrast: Option<f64>,
}

impl ProcessBody {
    fn into_params(self) -> ProcessingParams {
        let d = ProcessingParams::default();
        ProcessingParams {
            target_type: self.target_type.unwrap_or(d.target_type),
            stretch_method: self.stretch_method.unwrap_or(d.stretch_method),
            stretch_factor: self.stretch_factor.unwrap_or(d.stretch_factor),
            background_removal: self.background_removal.unwrap_or(d.background_removal),
            star_reduction: self.star_reduction.unwrap_or(d.star_reduction),
            color_calibration: self.color_calibration.unwrap_or(d.color_calibration),
            noise_reduction: self.noise_reduction.unwrap_or(d.noise_reduction),
            contrast: self.contrast.unwrap_or(d.contrast),
        }
    }
}

pub async fn process_image(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(id): Path<String>,
    body: Option<Json<ProcessBody>>,
) -> Response {
    let started = std::time::Instant::now();
    let params = body.map(|Json(b)| b).unwrap_or_default().into_params();

    // One run per user at a time — the permit lives until this handler
    // returns, covering the fetch + pipeline + store sequence
    let Some(_permit) = state.processing.try_acquire(&user.user_id) else {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({ "error": "processing already in progress" })),
        )
            .into_response();
    };

    // Owner-scoped lookup: someone else's image id is indistinguishable
    // from a missing one
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
        Ok(Err(e)) => return internal("process lookup", e),
        Err(e) => return internal("process lookup task", e.to_string()),
    };

    if !processable(&image) {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({ "error": "image has no processable FITS asset" })),
        )
            .into_response();
    }
    let hfs_path = resolve_hfs_path(&image).expect("processable implies hfs path");

    // Object name for auto-classification, matching the desktop flow:
    // metadata.object_name, then the summary
    let object_name = image
        .metadata
        .as_deref()
        .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok())
        .and_then(|v| v.get("object_name").and_then(|n| n.as_str().map(String::from)))
        .or_else(|| image.summary.clone());

    // Fetch FITS bytes, run the pipeline, and store the processed variants
    // in one blocking task (pipeline is seconds of CPU)
    enum PipelineError {
        /// The fetch came back with non-FITS bytes: the original is an
        /// external ref whose source path isn't reachable from this host,
        /// so HoardFS substituted the cached JPEG variant (the right call
        /// for serving, useless for processing).
        SourceUnavailable,
        Other(String),
    }
    impl From<String> for PipelineError {
        fn from(e: String) -> Self {
            Self::Other(e)
        }
    }

    let hfs_arc = state.hoardfs.clone();
    let rt = tokio::runtime::Handle::current();
    let volume = tenancy::volume_name(&user.user_id);
    let path_for_task = hfs_path.clone();
    let params_for_task = params.clone();
    let result = tokio::task::spawn_blocking(move || {
        let hfs = hfs_arc
            .lock()
            .map_err(|_| "HoardFS lock poisoned".to_string())?;
        let bytes = rt
            .block_on(hfs.get_file(&volume, &path_for_task))
            .map_err(|e| format!("FITS fetch {path_for_task}: {e}"))?;

        // Every FITS file begins with a "SIMPLE" card; anything else means
        // we got the variant fallback, not the original
        if !bytes.starts_with(b"SIMPLE") {
            return Err(PipelineError::SourceUnavailable);
        }

        let processed = processing::process_fits_bytes(
            bytes,
            &params_for_task,
            object_name.as_deref(),
        )?;

        rt.block_on(hfs.add_variant(
            &volume,
            &path_for_task,
            Quality::Preview,
            &processed.preview_jpeg,
            "image/jpeg",
        ))
        .map_err(|e| format!("store preview variant: {e}"))?;
        rt.block_on(hfs.add_variant(
            &volume,
            &path_for_task,
            Quality::Thumbnail,
            &processed.thumbnail_jpeg,
            "image/jpeg",
        ))
        .map_err(|e| format!("store thumbnail variant: {e}"))?;

        Ok::<_, PipelineError>(processed)
    })
    .await;

    let processed = match result {
        Ok(Ok(processed)) => processed,
        Ok(Err(PipelineError::SourceUnavailable)) => {
            log::warn!(
                "process {id} for {}: original FITS at {hfs_path} unreachable from this host",
                user.user_id
            );
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({
                    "error": "the original FITS file isn't reachable from the server, only its cached preview; processing needs the original"
                })),
            )
                .into_response();
        }
        Ok(Err(PipelineError::Other(e))) => return internal("process pipeline", e),
        Err(e) => return internal("process pipeline task", e.to_string()),
    };

    // Record the processing on the image row; bumping updated_at busts the
    // versioned preview/thumbnail URLs and the variant ETag
    let db = state.db.clone();
    let record_id = id.clone();
    let applied = serde_json::to_value(&processed.applied).unwrap_or_default();
    let applied_for_row = applied.clone();
    let existing_metadata = image.metadata.clone();
    let updated = tokio::task::spawn_blocking(move || {
        use crate::db::schema::images;
        use diesel::prelude::*;

        let mut root = existing_metadata
            .as_deref()
            .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        if let Some(obj) = root.as_object_mut() {
            obj.insert(
                "processing".to_string(),
                serde_json::json!({
                    "processed_at": chrono::Utc::now().to_rfc3339(),
                    "engine": "processinator-native",
                    "params": applied_for_row,
                }),
            );
        }

        let mut conn = db.get().map_err(|e| e.to_string())?;
        diesel::update(images::table.find(&record_id))
            .set((
                images::metadata.eq(Some(root.to_string())),
                images::updated_at.eq(chrono::Utc::now().naive_utc()),
            ))
            .execute(&mut conn)
            .map_err(|e| e.to_string())?;
        images::table
            .find(&record_id)
            .first::<Image>(&mut conn)
            .map_err(|e| e.to_string())
    })
    .await;

    let image = match updated {
        Ok(Ok(image)) => image,
        Ok(Err(e)) => return internal("process record update", e),
        Err(e) => return internal("process record update task", e.to_string()),
    };

    log::info!(
        "processed image {id} for {} ({}x{} preview) in {:?}",
        user.user_id,
        processed.preview_dims.0,
        processed.preview_dims.1,
        started.elapsed()
    );

    Json(serde_json::json!({
        "success": true,
        "targetType": processed.applied.target_type,
        "processingTime": started.elapsed().as_secs_f64(),
        "processingParams": applied,
        "image": image_out(image),
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultsQuery {
    target_type: String,
}

/// `GET /api/processing/defaults?targetType=…` — the per-target parameter
/// table (native port of the desktop command).
pub async fn processing_defaults(Query(q): Query<DefaultsQuery>) -> Response {
    Json(processing::processing_defaults(&q.target_type)).into_response()
}

#[derive(Debug, Deserialize)]
pub struct ClassifyQuery {
    name: String,
}

/// `GET /api/processing/classify?name=…` — table/pattern classification
/// (no SIMBAD fallback; unmatched names come back "unknown").
pub async fn classify_target(Query(q): Query<ClassifyQuery>) -> Response {
    Json(processing::classify_target_native(&q.name)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::images::{create_image_core, CreateImageInput};
    use crate::daemon::auth::mint_token;
    use crate::db::test_support::{insert_user, test_pool};
    use axum::body::to_bytes;
    use axum::http::header;
    use tower::ServiceExt;

    fn synthetic_fits() -> Vec<u8> {
        let field = processinator::make_test_image(&processinator::SyntheticParams {
            rgb: true,
            seed: 7,
            ..Default::default()
        });
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("seed.fits");
        processinator::write_fits(&field.data, &path).unwrap();
        std::fs::read(&path).unwrap()
    }

    /// alice + bob, one FITS-backed image for alice with variants from the
    /// FITS generator (the daemon's real pipeline configuration).
    async fn seeded() -> (Arc<DaemonState>, tempfile::TempDir, String, String, Image) {
        let tmp = tempfile::tempdir().unwrap();
        let db = test_pool();
        insert_user(&db, "alice");
        insert_user(&db, "bob");

        let mut hfs = hoardfs_volume::HoardFs::init(&tmp.path().join("hoardfs"))
            .await
            .unwrap();
        hfs.set_variant_pipeline(
            hoardfs_variant::VariantPipeline::new()
                .with_image_generator()
                .register(Box::new(crate::fits_variant::FitsVariantGenerator::new())),
        );

        tenancy::ensure_user_volume(&hfs, "alice").unwrap();
        hfs.put_file("user-alice", "/2026/m42.fits", &synthetic_fits())
            .await
            .unwrap();
        let blob_id = hfs
            .get_file_info("user-alice", "/2026/m42.fits")
            .unwrap()
            .current_version
            .blob_id;

        let image = create_image_core(
            &db,
            "alice",
            CreateImageInput {
                collection_id: None,
                filename: "m42.fits".to_string(),
                url: None,
                summary: Some("M42".to_string()),
                description: None,
                content_type: Some("image/fits".to_string()),
                tags: None,
                visibility: None,
                location: None,
                annotations: None,
                metadata: None,
                thumbnail: None,
            },
        )
        .unwrap();
        {
            use crate::db::schema::images;
            use diesel::prelude::*;
            let metadata = serde_json::json!({ "hoardfs": { "hfs_path": "/2026/m42.fits" } });
            diesel::update(images::table.find(&image.id))
                .set((
                    images::blob_id.eq(Some(blob_id)),
                    images::metadata.eq(Some(metadata.to_string())),
                ))
                .execute(&mut db.get().unwrap())
                .unwrap();
        }

        let alice = mint_token(&db, "alice", "t").unwrap().token;
        let bob = mint_token(&db, "bob", "t").unwrap().token;

        let state = Arc::new(DaemonState {
            db,
            hoardfs: Arc::new(Mutex::new(hfs)),
            oidc: None,
            limits: Default::default(),
            session_key: [7u8; 32],
            processing: Default::default(),
        });
        (state, tmp, alice, bob, image)
    }

    async fn request(
        router: &axum::Router,
        method: &str,
        token: &str,
        uri: &str,
        body: Option<serde_json::Value>,
    ) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let mut req = axum::http::Request::builder()
            .method(method)
            .uri(uri)
            .header("Authorization", format!("Bearer {token}"));
        let body = match body {
            Some(v) => {
                req = req.header(header::CONTENT_TYPE, "application/json");
                axum::body::Body::from(v.to_string())
            }
            None => axum::body::Body::empty(),
        };
        let resp = router.clone().oneshot(req.body(body).unwrap()).await.unwrap();
        let status = resp.status();
        let headers = resp.headers().clone();
        let bytes = to_bytes(resp.into_body(), 64 << 20).await.unwrap().to_vec();
        (status, headers, bytes)
    }

    fn json(body: &[u8]) -> serde_json::Value {
        serde_json::from_slice(body).unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn processing_replaces_preview_and_busts_etag() {
        let (state, _tmp, alice, _bob, img) = seeded().await;
        let router = crate::daemon::router(state.clone());
        let preview_uri = format!("/api/images/{}/preview", img.id);

        let (status, headers, before) =
            request(&router, "GET", &alice, &preview_uri, None).await;
        assert_eq!(status, StatusCode::OK);
        let etag_before = headers.get(header::ETAG).unwrap().to_str().unwrap().to_string();

        let (status, _, body) = request(
            &router,
            "POST",
            &alice,
            &format!("/api/images/{}/process", img.id),
            Some(serde_json::json!({ "stretchMethod": "arcsinh", "contrast": 1.5 })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        let result = json(&body);
        assert_eq!(result["success"], true);
        assert_eq!(result["targetType"], "emission_nebula"); // classified from "M42"
        assert_eq!(result["processingParams"]["stretchMethod"], "arcsinh");
        assert_eq!(result["image"]["processable"], true);
        assert!(result["processingTime"].as_f64().unwrap() > 0.0);

        // The served preview is now the processed JPEG with a fresh ETag
        let (status, headers, after) =
            request(&router, "GET", &alice, &preview_uri, None).await;
        assert_eq!(status, StatusCode::OK);
        let etag_after = headers.get(header::ETAG).unwrap().to_str().unwrap();
        assert_ne!(etag_before, etag_after);
        assert_ne!(before, after);
        assert_eq!(
            headers.get(header::CONTENT_TYPE).unwrap(),
            "image/jpeg"
        );

        // Metadata records the run
        let (_, _, body) =
            request(&router, "GET", &alice, &format!("/api/images/{}", img.id), None).await;
        let record = json(&body);
        let metadata: serde_json::Value =
            serde_json::from_str(record["metadata"].as_str().unwrap()).unwrap();
        assert_eq!(metadata["processing"]["engine"], "processinator-native");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cross_user_processing_is_404() {
        let (state, _tmp, _alice, bob, img) = seeded().await;
        let router = crate::daemon::router(state.clone());
        let (status, _, _) = request(
            &router,
            "POST",
            &bob,
            &format!("/api/images/{}/process", img.id),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn non_fits_image_is_unprocessable() {
        let (state, _tmp, alice, _bob, _img) = seeded().await;
        // A PNG-backed image: present in HoardFS but not FITS
        {
            let png = {
                let img = image::RgbImage::from_pixel(8, 8, image::Rgb([9, 9, 9]));
                let mut bytes = std::io::Cursor::new(Vec::new());
                image::DynamicImage::ImageRgb8(img)
                    .write_to(&mut bytes, image::ImageFormat::Png)
                    .unwrap();
                bytes.into_inner()
            };
            let hfs_arc = state.hoardfs.clone();
            tokio::task::block_in_place(|| {
                let hfs = hfs_arc.lock().unwrap();
                tokio::runtime::Handle::current()
                    .block_on(hfs.put_file("user-alice", "/2026/flat.png", &png))
                    .unwrap();
            });
        }
        let png_image = create_image_core(
            &state.db,
            "alice",
            CreateImageInput {
                collection_id: None,
                filename: "flat.png".to_string(),
                url: None,
                summary: None,
                description: None,
                content_type: Some("image/png".to_string()),
                tags: None,
                visibility: None,
                location: None,
                annotations: None,
                metadata: Some(
                    serde_json::json!({ "hoardfs": { "hfs_path": "/2026/flat.png" } }).to_string(),
                ),
                thumbnail: None,
            },
        )
        .unwrap();

        let router = crate::daemon::router(state.clone());
        let (status, _, body) = request(
            &router,
            "POST",
            &alice,
            &format!("/api/images/{}/process", png_image.id),
            None,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{}",
            String::from_utf8_lossy(&body)
        );
    }

    /// FITS-named file whose bytes aren't FITS — what HoardFS's
    /// variant fallback serves when an external source path is offline.
    /// Must come back 422 with a pointed message, not a parse-error 500.
    #[tokio::test(flavor = "multi_thread")]
    async fn variant_fallback_bytes_are_422() {
        let (state, _tmp, alice, _bob, _img) = seeded().await;
        {
            let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0];
            let hfs_arc = state.hoardfs.clone();
            tokio::task::block_in_place(|| {
                let hfs = hfs_arc.lock().unwrap();
                tokio::runtime::Handle::current()
                    .block_on(hfs.put_file("user-alice", "/2026/offline.fits", &jpeg))
                    .unwrap();
            });
        }
        let fake = create_image_core(
            &state.db,
            "alice",
            CreateImageInput {
                collection_id: None,
                filename: "offline.fits".to_string(),
                url: None,
                summary: None,
                description: None,
                content_type: Some("image/fits".to_string()),
                tags: None,
                visibility: None,
                location: None,
                annotations: None,
                metadata: Some(
                    serde_json::json!({ "hoardfs": { "hfs_path": "/2026/offline.fits" } })
                        .to_string(),
                ),
                thumbnail: None,
            },
        )
        .unwrap();

        let router = crate::daemon::router(state.clone());
        let (status, _, body) = request(
            &router,
            "POST",
            &alice,
            &format!("/api/images/{}/process", fake.id),
            None,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{}",
            String::from_utf8_lossy(&body)
        );
        let err = json(&body);
        assert!(
            err["error"].as_str().unwrap().contains("original"),
            "{err}"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn concurrent_run_from_same_user_is_429() {
        let (state, _tmp, alice, _bob, img) = seeded().await;
        let router = crate::daemon::router(state.clone());

        let _held = state.processing.try_acquire("alice").unwrap();
        let (status, _, _) = request(
            &router,
            "POST",
            &alice,
            &format!("/api/images/{}/process", img.id),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);

        // Slot frees on drop
        drop(_held);
        assert!(state.processing.try_acquire("alice").is_some());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn defaults_and_classify_routes() {
        let (state, _tmp, alice, _bob, _img) = seeded().await;
        let router = crate::daemon::router(state.clone());

        let (status, _, body) = request(
            &router,
            "GET",
            &alice,
            "/api/processing/defaults?targetType=galaxy",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let defaults = json(&body);
        assert_eq!(defaults["stretchFactor"], 0.12);
        assert_eq!(defaults["targetType"], "galaxy");

        let (status, _, body) = request(
            &router,
            "GET",
            &alice,
            "/api/processing/classify?name=Sh2-155",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let info = json(&body);
        assert_eq!(info["targetType"], "emission_nebula");
        assert_eq!(info["confidence"], 0.9);

        // Auth required
        let (status, _, _) =
            request(&router, "GET", "nope", "/api/processing/classify?name=M42", None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
}
