//! Server-side plate solving: `POST /api/images/{id}/plate-solve`.
//!
//! Runs the native tetra3 solver (pure Rust — the daemon links no Python)
//! over the image's FITS asset in the caller's HoardFS volume and persists
//! the solution to the image record in the same `metadata.plate_solve`
//! shape the desktop solve writes, so every existing consumer (overlay,
//! sky map footprints, gallery pages) works unchanged. Catalog annotation
//! is a client-side concern on the web (`src/lib/solve-annotations.ts`) —
//! the desktop's astroquery path is PyO3 and stays desktop-only.
//!
//! Synchronous, sharing the per-user processing slot with `/process` and
//! `/stretch-data`: solves are CPU-bound and the daemon shares a VM, so a
//! second concurrent request from the same user gets 429.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use super::api::{image_out, internal, not_found};
use super::auth::AuthedUser;
use super::process::{processable, source_unavailable, PipelineError};
use super::DaemonState;
use crate::commands::hoardfs::resolve_hfs_path;
use crate::commands::images::get_image_core;
use crate::commands::plate_solve::{read_fits_dimensions, solve_with_tetra3};
use crate::db::models::Image;
use crate::db::tenancy;
use crate::processing;
use crate::python::plate_solve::PlateSolveResult;

/// Request body. All optional — with nothing given, the FOV estimate comes
/// from the FITS headers (FOCALLEN/XPIXSZ) when present, else tetra3's
/// multiscale search runs with its default estimate.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolveBody {
    /// Horizontal field of view estimate in degrees
    fov_estimate: Option<f64>,
    /// Lower bound of expected image scale (arcsec/pixel)
    scale_lower: Option<f64>,
    /// Upper bound of expected image scale (arcsec/pixel)
    scale_upper: Option<f64>,
    /// Timeout in seconds
    timeout: Option<i32>,
}

/// Whether `/api/images/{id}/plate-solve` can run on this image: a FITS
/// asset exists AND this server has a solver database. The server-truth
/// flag behind the web Plate Solve button.
pub(crate) fn solvable(state: &DaemonState, image: &Image) -> bool {
    solver_available_for(state) && processable(image)
}

/// Does this server have a usable tetra3 database? Compute once per
/// request when mapping many rows.
pub(crate) fn solver_available_for(state: &DaemonState) -> bool {
    state.tetra3_db.as_ref().is_some_and(|p| p.exists())
}

/// `GET /api/solvers` — the web answer to the desktop `detect_plate_solvers`
/// command: which solvers this server offers (tetra3 only).
pub async fn solver_capabilities(
    State(state): State<Arc<DaemonState>>,
    _user: AuthedUser,
) -> Response {
    let details = match &state.tetra3_db {
        None => "no solver database configured on this server",
        Some(p) if !p.exists() => "configured solver database file is missing",
        Some(_) => "server-side tetra3 (unified 0.5\u{b0}\u{2013}5\u{b0} database)",
    };
    Json(serde_json::json!({
        "tetra3": {
            "available": solver_available_for(&state),
            "version": null,
            "details": details,
        }
    }))
    .into_response()
}

/// The 503 for a missing/unconfigured solver database — a clear error, not
/// a hang, per the provisioning contract (the DB ships via deploy config).
fn solver_unavailable(state: &DaemonState) -> Response {
    let error = match &state.tetra3_db {
        None => "plate solving is unavailable: no tetra3 solver database is configured on this server".to_string(),
        Some(p) => format!(
            "plate solving is unavailable: solver database missing at {}",
            p.display()
        ),
    };
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({ "error": error })),
    )
        .into_response()
}

/// Estimate the horizontal FOV in degrees from FITS headers: needs
/// FOCALLEN (mm) + XPIXSZ (µm) + NAXIS1. The native stand-in for the
/// desktop's Python `extract_solve_hints`.
fn fov_hint_from_headers(path: &std::path::Path) -> Option<f64> {
    let fits = fitrs::Fits::open(path).ok()?;
    let hdu = fits.into_iter().next()?;

    let mut focal_mm: Option<f64> = None;
    let mut pixel_um: Option<f64> = None;
    let mut width_px: Option<f64> = None;
    for (key, value) in hdu.iter() {
        let v = format!("{value:?}");
        match key.to_string().as_str() {
            "FOCALLEN" => focal_mm = extract_float(&v),
            "XPIXSZ" => pixel_um = extract_float(&v),
            "NAXIS1" => width_px = extract_float(&v),
            _ => {}
        }
    }

    let (focal, pixel, width) = (focal_mm?, pixel_um?, width_px?);
    if focal <= 0.0 || pixel <= 0.0 || width <= 0.0 {
        return None;
    }
    let sensor_width_mm = width * pixel / 1000.0;
    let fov_deg = 2.0 * (sensor_width_mm / (2.0 * focal)).atan().to_degrees();
    (fov_deg.is_finite() && fov_deg > 0.0).then_some(fov_deg)
}

/// Pull the first numeric token out of a fitrs debug-formatted header value
/// (e.g. `RealFloatingNumber(250.0)` or `IntegerNumber(1080)`).
fn extract_float(debug_value: &str) -> Option<f64> {
    let start = debug_value.find(|c: char| c.is_ascii_digit() || c == '-')?;
    let token: String = debug_value[start..]
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '-' || *c == 'e' || *c == 'E')
        .collect();
    token.parse().ok()
}

/// Persist a solve outcome to the image row, in the exact shape the desktop
/// solve writes (`metadata.plate_solve` / `metadata.plate_solve_failed`),
/// plus the daemon's `updated_at` bump. Returns the fresh row.
pub(crate) fn persist_solve_outcome(
    db: &crate::db::DbPool,
    image_id: &str,
    existing_metadata: Option<&str>,
    solve: &PlateSolveResult,
) -> Result<Image, String> {
    use crate::db::schema::images;
    use diesel::prelude::*;

    let mut root = existing_metadata
        .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let obj = root
        .as_object_mut()
        .ok_or_else(|| "image metadata is not a JSON object".to_string())?;

    let mut location: Option<String> = None;
    if solve.success {
        obj.insert(
            "plate_solve".to_string(),
            serde_json::json!({
                "solved_at": chrono::Utc::now().to_rfc3339(),
                "solver": solve.solver,
                "center_ra": solve.center_ra,
                "center_dec": solve.center_dec,
                "pixel_scale": solve.pixel_scale,
                "rotation": solve.rotation,
                "width_deg": solve.width_deg,
                "height_deg": solve.height_deg,
                "solve_time": solve.solve_time,
                "wcs": solve.wcs,
            }),
        );
        obj.remove("plate_solve_failed");
        location = Some(format!(
            "RA: {:.4}\u{b0}, Dec: {:.4}\u{b0}",
            solve.center_ra, solve.center_dec
        ));
    } else {
        obj.insert(
            "plate_solve_failed".to_string(),
            serde_json::json!({
                "failed_at": chrono::Utc::now().to_rfc3339(),
                "solver": solve.solver,
                "error_message": solve.error_message,
            }),
        );
    }

    let mut conn = db.get().map_err(|e| e.to_string())?;
    match location {
        Some(loc) => diesel::update(images::table.find(image_id))
            .set((
                images::metadata.eq(Some(root.to_string())),
                images::location.eq(Some(loc)),
                images::updated_at.eq(chrono::Utc::now().naive_utc()),
            ))
            .execute(&mut conn)
            .map_err(|e| e.to_string())?,
        None => diesel::update(images::table.find(image_id))
            .set((
                images::metadata.eq(Some(root.to_string())),
                images::updated_at.eq(chrono::Utc::now().naive_utc()),
            ))
            .execute(&mut conn)
            .map_err(|e| e.to_string())?,
    };
    images::table
        .find(image_id)
        .first::<Image>(&mut conn)
        .map_err(|e| e.to_string())
}

pub async fn plate_solve_image(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(id): Path<String>,
    body: Option<Json<SolveBody>>,
) -> Response {
    let started = std::time::Instant::now();
    let body = body.map(|Json(b)| b).unwrap_or_default();

    // One CPU-bound run per user at a time, shared with /process
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
    let image =
        match tokio::task::spawn_blocking(move || get_image_core(&db, &user_id, &lookup_id)).await
        {
            Ok(Ok(Some(image))) => image,
            Ok(Ok(None)) => return not_found(),
            Ok(Err(e)) => return internal("solve lookup", e),
            Err(e) => return internal("solve lookup task", e.to_string()),
        };

    if !processable(&image) {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({ "error": "image has no FITS asset to solve" })),
        )
            .into_response();
    }
    let Some(db_path) = state.tetra3_db.clone().filter(|p| p.exists()) else {
        return solver_unavailable(&state);
    };
    let hfs_path = resolve_hfs_path(&image).expect("processable implies hfs path");

    // Fetch FITS bytes and solve in one blocking task (seconds of CPU)
    let hfs_arc = state.hoardfs.clone();
    let rt = tokio::runtime::Handle::current();
    let volume = tenancy::volume_name(&user.user_id);
    let path_for_task = hfs_path.clone();
    let result = tokio::task::spawn_blocking(move || {
        let bytes = {
            let hfs = hfs_arc
                .lock()
                .map_err(|_| "HoardFS lock poisoned".to_string())?;
            rt.block_on(hfs.get_file(&volume, &path_for_task))
                .map_err(|e| format!("FITS fetch {path_for_task}: {e}"))?
        };
        if !bytes.starts_with(b"SIMPLE") {
            return Err(PipelineError::SourceUnavailable);
        }

        processing::with_temp_fits(bytes, |tmp| {
            let (w, h) = read_fits_dimensions(tmp)?;
            let fov = body.fov_estimate.or_else(|| fov_hint_from_headers(tmp));
            let tmp_str = tmp
                .to_str()
                .ok_or_else(|| "temp path not UTF-8".to_string())?;
            solve_with_tetra3(
                tmp_str,
                &db_path.to_string_lossy(),
                fov,
                body.scale_lower,
                body.scale_upper,
                w,
                h,
                body.timeout.map(|t| (t as u64) * 1000),
            )
        })
        .map_err(PipelineError::Other)
    })
    .await;

    let solve = match result {
        Ok(Ok(solve)) => solve,
        Ok(Err(PipelineError::SourceUnavailable)) => {
            log::warn!(
                "solve {id} for {}: original FITS at {hfs_path} unreachable from this host",
                user.user_id
            );
            return source_unavailable();
        }
        Ok(Err(PipelineError::Other(e))) => return internal("plate solve", e),
        Err(e) => return internal("plate solve task", e.to_string()),
    };

    // Persist in the desktop's metadata shape; updated_at bump busts caches
    let db = state.db.clone();
    let record_id = id.clone();
    let existing_metadata = image.metadata.clone();
    let solve_for_row = solve.clone();
    let updated = tokio::task::spawn_blocking(move || {
        persist_solve_outcome(&db, &record_id, existing_metadata.as_deref(), &solve_for_row)
    })
    .await;
    let image = match updated {
        Ok(Ok(image)) => image,
        Ok(Err(e)) => return internal("solve record update", e),
        Err(e) => return internal("solve record update task", e.to_string()),
    };

    log::info!(
        "plate solve {id} for {}: success={} in {:?}",
        user.user_id,
        solve.success,
        started.elapsed()
    );

    // Mirror the desktop PlateSolveResponse (flattened camelCase result +
    // objects), plus the fresh image row. Catalog objects are computed
    // client-side on the web — always empty here.
    let mut out = serde_json::to_value(&solve).unwrap_or_else(|_| serde_json::json!({}));
    out["objects"] = serde_json::json!([]);
    out["image"] = serde_json::to_value(image_out(image, solver_available_for(&state)))
        .unwrap_or_else(|_| serde_json::json!({}));
    Json(out).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::images::{create_image_core, CreateImageInput};
    use crate::db::test_support::{insert_user, test_pool};

    fn fabricated_result(success: bool) -> PlateSolveResult {
        PlateSolveResult {
            success,
            center_ra: 83.822,
            center_dec: -5.391,
            pixel_scale: 2.4,
            rotation: 12.5,
            width_deg: 1.28,
            height_deg: 0.72,
            image_width: 1920,
            image_height: 1080,
            solver: "tetra3".to_string(),
            solve_time: 1.5,
            error_message: (!success).then(|| "No match found".to_string()),
            wcs: None,
        }
    }

    #[test]
    fn persist_writes_desktop_shape_and_bumps_updated_at() {
        let pool = test_pool();
        insert_user(&pool, "u1");
        let image = create_image_core(
            &pool,
            "u1",
            CreateImageInput {
                collection_id: None,
                filename: "m42.fits".to_string(),
                url: None,
                summary: None,
                description: None,
                content_type: None,
                tags: None,
                visibility: None,
                location: None,
                annotations: None,
                metadata: Some(r#"{"plate_solve_failed":{"solver":"tetra3"},"other":1}"#.to_string()),
                thumbnail: None,
            },
        )
        .unwrap();
        let before = image.updated_at;

        let updated =
            persist_solve_outcome(&pool, &image.id, image.metadata.as_deref(), &fabricated_result(true))
                .unwrap();

        let meta: serde_json::Value = serde_json::from_str(&updated.metadata.unwrap()).unwrap();
        let ps = &meta["plate_solve"];
        assert_eq!(ps["solver"], "tetra3");
        assert_eq!(ps["center_ra"], 83.822);
        assert_eq!(ps["width_deg"], 1.28);
        // Failed flag cleared, unrelated keys preserved
        assert!(meta.get("plate_solve_failed").is_none());
        assert_eq!(meta["other"], 1);
        assert!(updated.location.unwrap().starts_with("RA: 83.8220"));
        assert!(updated.updated_at >= before);
    }

    #[test]
    fn persist_failure_records_failed_flag_only() {
        let pool = test_pool();
        insert_user(&pool, "u1");
        let image = create_image_core(
            &pool,
            "u1",
            CreateImageInput {
                collection_id: None,
                filename: "m42.fits".to_string(),
                url: None,
                summary: None,
                description: None,
                content_type: None,
                tags: None,
                visibility: None,
                location: None,
                annotations: None,
                metadata: None,
                thumbnail: None,
            },
        )
        .unwrap();

        let updated =
            persist_solve_outcome(&pool, &image.id, None, &fabricated_result(false)).unwrap();

        let meta: serde_json::Value = serde_json::from_str(&updated.metadata.unwrap()).unwrap();
        assert_eq!(meta["plate_solve_failed"]["error_message"], "No match found");
        assert!(meta.get("plate_solve").is_none());
        assert!(updated.location.is_none());
    }

    #[test]
    fn extract_float_reads_fitrs_debug_values() {
        assert_eq!(extract_float("RealFloatingNumber(250.0)"), Some(250.0));
        assert_eq!(extract_float("IntegerNumber(1080)"), Some(1080.0));
        assert_eq!(extract_float("CharacterString(\"abc\")"), None);
    }
}
