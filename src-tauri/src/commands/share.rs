//! Tauri commands for gallery sharing — desktop → daemon push.
//!
//! Publishing pushes the collection (metadata + assets) to the hosted Astra
//! daemon over its `/api/push/*` endpoints and flips the server-side publish
//! record, replacing the worker-era Clerk + presigned-R2 upload path. Sync
//! is simply a re-push: the ingest protocol is idempotent (assets transfer
//! once, keyed by content hash).
//!
//! The daemon connection (base URL + personal access token, minted with
//! `astra_daemon --mint-token`) lives in `gallery-daemon.json`; an OIDC
//! device flow can replace the pasted token later.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::repository;
use crate::db::DbPool;
use crate::share::daemon_client::DaemonClient;
use crate::share::config;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishProgress {
    step: String,
    detail: String,
    current: usize,
    total: usize,
}

fn emit_progress(app: &AppHandle, step: &str, detail: &str, current: usize, total: usize) {
    let _ = app.emit(
        "publish-progress",
        PublishProgress {
            step: step.to_string(),
            detail: detail.to_string(),
            current,
            total,
        },
    );
}

// ============================================================================
// Types
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureGalleryDaemonInput {
    pub base_url: String,
    pub token: String,
}

/// What the UI sees — never echoes the token back.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryDaemonStatus {
    pub base_url: String,
    pub has_token: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub share_id: String,
    pub public_url: String,
    pub images_uploaded: usize,
    pub thumbs_uploaded: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishStatus {
    pub share_id: String,
    pub published_at: String,
    pub public_url: String,
    pub last_synced_at: String,
    pub uploaded_image_ids: Vec<String>,
}

// ============================================================================
// Config Commands
// ============================================================================

fn data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))
}

fn client_from_config(app: &AppHandle) -> Result<DaemonClient, String> {
    let cfg = config::load_config(&data_dir(app)?)?
        .ok_or("Gallery daemon not configured. Add the daemon URL and token in Admin → Sharing.")?;
    Ok(DaemonClient::new(&cfg.base_url, &cfg.token))
}

#[tauri::command]
pub fn configure_gallery_daemon(
    app: AppHandle,
    input: ConfigureGalleryDaemonInput,
) -> Result<(), String> {
    let cfg = config::GalleryDaemonConfig {
        base_url: input.base_url.trim().trim_end_matches('/').to_string(),
        token: input.token.trim().to_string(),
    };
    if cfg.base_url.is_empty() || cfg.token.is_empty() {
        return Err("Daemon URL and token are both required".to_string());
    }
    config::save_config(&data_dir(&app)?, &cfg)
}

#[tauri::command]
pub fn get_gallery_daemon_config(app: AppHandle) -> Result<Option<GalleryDaemonStatus>, String> {
    Ok(config::load_config(&data_dir(&app)?)?.map(|cfg| GalleryDaemonStatus {
        base_url: cfg.base_url,
        has_token: !cfg.token.is_empty(),
    }))
}

/// Verify the configured daemon + token; returns the @handle it maps to.
#[tauri::command]
pub async fn test_gallery_daemon(app: AppHandle) -> Result<String, String> {
    let client = client_from_config(&app)?;
    let me = client.me().await?;
    Ok(me.username.unwrap_or(me.user_id))
}

#[tauri::command]
pub fn clear_gallery_daemon_config(app: AppHandle) -> Result<(), String> {
    config::delete_config(&data_dir(&app)?)
}

// ============================================================================
// Publish / Sync / Unpublish
// ============================================================================

fn mime_for_path(path: &std::path::Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "fit" | "fits" => "image/fits",
        _ => "application/octet-stream",
    }
}

/// Push a collection to the daemon and (re)publish it. Idempotent — sync is
/// the same call. Only assets the daemon reports missing are read and
/// uploaded; metadata upserts every time (last-write-wins).
pub async fn push_and_publish_core(
    db: &DbPool,
    client: &DaemonClient,
    collection_id: &str,
    mut progress: impl FnMut(&str, &str, usize, usize),
) -> Result<PublishResult, String> {
    progress("auth", "Checking daemon connection...", 0, 0);
    let me = client.me().await?;
    let username = me.username.clone().unwrap_or(me.user_id.clone());

    progress("loading", "Loading collection...", 0, 0);
    let (collection, images) = {
        let mut conn = db.get().map_err(|e| e.to_string())?;
        let collection = repository::get_collection_by_id(&mut conn, collection_id)
            .map_err(|e| e.to_string())?
            .ok_or("Collection not found")?;
        let images = repository::get_images_in_collection(&mut conn, collection_id)
            .map_err(|e| e.to_string())?;
        (collection, images)
    };

    // Metadata push: every image record, whether or not its asset is here.
    let push_body = serde_json::json!({
        "collection": {
            "id": collection.id,
            "name": collection.name,
            "description": collection.description,
            "visibility": collection.visibility,
            "template": collection.template,
            "tags": collection.tags,
            "metadata": collection.metadata,
        },
        "images": images.iter().map(|img| serde_json::json!({
            "id": img.id,
            "filename": img.filename,
            "summary": img.summary,
            "description": img.description,
            "content_type": img.content_type.clone().or_else(|| {
                img.url.as_deref().map(|u| mime_for_path(std::path::Path::new(u)).to_string())
            }),
            "favorite": img.favorite,
            "tags": img.tags,
            "visibility": img.visibility,
            "location": img.location,
            "annotations": img.annotations,
            "metadata": img.metadata,
        })).collect::<Vec<_>>(),
    });

    progress("pushing", "Pushing collection metadata...", 0, 0);
    let push_response = client.push_collection(&push_body).await?;

    let needed: std::collections::HashSet<&str> = push_response
        .images
        .iter()
        .filter(|s| s.asset_status == "needed")
        .map(|s| s.id.as_str())
        .collect();

    let mut images_uploaded = 0usize;
    let mut uploaded_ids = Vec::new();
    let to_upload: Vec<_> = images.iter().filter(|i| needed.contains(i.id.as_str())).collect();
    let total = to_upload.len();

    for (idx, image) in to_upload.into_iter().enumerate() {
        let Some(file_path) = &image.url else {
            log::warn!("skipping asset for {} — no local file path", image.id);
            continue;
        };
        let path = std::path::Path::new(file_path);
        if !path.exists() {
            log::warn!("skipping asset for {} — file missing: {file_path}", image.id);
            continue;
        }

        progress(
            "uploading",
            &format!("Uploading {} ({}/{})...", image.filename, idx + 1, total),
            idx + 1,
            total,
        );
        let bytes =
            std::fs::read(path).map_err(|e| format!("Failed to read {file_path}: {e}"))?;
        let hash = blake3::hash(&bytes).to_hex().to_string();
        client.put_asset(&image.id, &hash, bytes).await?;
        images_uploaded += 1;
        uploaded_ids.push(image.id.clone());
    }

    // Every image whose asset the daemon holds counts as uploaded state.
    let mut all_present_ids: Vec<String> = push_response
        .images
        .iter()
        .filter(|s| s.asset_status == "present")
        .map(|s| s.id.clone())
        .collect();
    all_present_ids.extend(uploaded_ids);

    progress("publishing", "Publishing gallery...", 0, 0);
    let record = client.publish(&collection.id).await?;
    let public_url = format!("{}/@{}/{}", client.base_url(), username, record.slug);

    // Keep the desktop-side status in collection metadata — same shape the
    // UI has always read.
    let now = chrono::Utc::now().to_rfc3339();
    let existing = get_publish_status_from_metadata(&collection.metadata);
    let status = PublishStatus {
        share_id: record.id.clone(),
        published_at: existing
            .map(|s| s.published_at)
            .unwrap_or_else(|| now.clone()),
        public_url: public_url.clone(),
        last_synced_at: now,
        uploaded_image_ids: all_present_ids,
    };
    save_publish_status(db, collection_id, &collection.metadata, &status)?;

    progress("done", "Published!", total, total);

    Ok(PublishResult {
        share_id: record.id,
        public_url,
        images_uploaded,
        thumbs_uploaded: 0,
    })
}

/// Remove the daemon publish record and clear the local status.
pub async fn unpublish_core(
    db: &DbPool,
    client: &DaemonClient,
    collection_id: &str,
) -> Result<(), String> {
    client.unpublish(collection_id).await?;

    let mut conn = db.get().map_err(|e| e.to_string())?;
    let collection = repository::get_collection_by_id(&mut conn, collection_id)
        .map_err(|e| e.to_string())?
        .ok_or("Collection not found")?;
    let mut meta: serde_json::Value = collection
        .metadata
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(m) = meta.as_object_mut() {
        m.remove("share");
    }
    let update = crate::db::models::UpdateCollection {
        metadata: Some(meta.to_string()),
        ..Default::default()
    };
    repository::update_collection(&mut conn, collection_id, &update)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn publish_collection(
    app: AppHandle,
    state: State<'_, AppState>,
    collection_id: String,
) -> Result<PublishResult, String> {
    let client = client_from_config(&app)?;
    let db = state.db.clone();
    let progress_app = app.clone();
    push_and_publish_core(&db, &client, &collection_id, move |step, detail, cur, total| {
        emit_progress(&progress_app, step, detail, cur, total)
    })
    .await
}

/// Sync is a re-push: the ingest protocol is idempotent.
#[tauri::command]
pub async fn sync_collection(
    app: AppHandle,
    state: State<'_, AppState>,
    collection_id: String,
) -> Result<PublishResult, String> {
    publish_collection(app, state, collection_id).await
}

#[tauri::command]
pub async fn unpublish_collection(
    app: AppHandle,
    state: State<'_, AppState>,
    collection_id: String,
) -> Result<(), String> {
    let client = client_from_config(&app)?;
    let db = state.db.clone();
    unpublish_core(&db, &client, &collection_id).await
}

#[tauri::command]
pub fn get_publish_status(
    state: State<'_, AppState>,
    collection_id: String,
) -> Result<Option<PublishStatus>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    let collection = repository::get_collection_by_id(&mut conn, &collection_id)
        .map_err(|e| e.to_string())?;

    match collection {
        Some(c) => Ok(get_publish_status_from_metadata(&c.metadata)),
        None => Ok(None),
    }
}

// ============================================================================
// Helpers
// ============================================================================

fn get_publish_status_from_metadata(metadata: &Option<String>) -> Option<PublishStatus> {
    let meta_str = metadata.as_deref()?;
    let meta: serde_json::Value = serde_json::from_str(meta_str).ok()?;
    let share = meta.get("share")?;
    serde_json::from_value(share.clone()).ok()
}

fn save_publish_status(
    db: &DbPool,
    collection_id: &str,
    existing_metadata: &Option<String>,
    status: &PublishStatus,
) -> Result<(), String> {
    let mut meta: serde_json::Value = existing_metadata
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    meta["share"] = serde_json::to_value(status)
        .map_err(|e| format!("Failed to serialize status: {}", e))?;

    let meta_str = serde_json::to_string(&meta)
        .map_err(|e| format!("Failed to serialize metadata: {}", e))?;

    let mut conn = db.get().map_err(|e| e.to_string())?;
    let update = crate::db::models::UpdateCollection {
        metadata: Some(meta_str),
        ..Default::default()
    };
    repository::update_collection(&mut conn, collection_id, &update)
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::collections::{create_collection_core, CreateCollectionInput};
    use crate::commands::images::{
        add_image_to_collection_core, create_image_core, CreateImageInput,
    };
    use crate::daemon::{auth::mint_token, DaemonState};
    use crate::db::test_support::{insert_user, test_pool};
    use std::sync::{Arc, Mutex};

    fn tiny_png(seed: u8) -> Vec<u8> {
        let img = image::RgbImage::from_pixel(32, 32, image::Rgb([seed, 90, 160]));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }

    /// Boot the real daemon router on an ephemeral port with its own state
    /// (separate DB + HoardFS — like a real remote daemon).
    async fn spawn_daemon() -> (String, String, Arc<DaemonState>, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let db = test_pool();
        // Daemon's local-user is the hosted account (username erewhon from
        // the tenancy backfill); mint the PAT the desktop will paste.
        let token = mint_token(&db, "local-user", "desktop").unwrap().token;

        let mut hfs = hoardfs_volume::HoardFs::init(&tmp.path().join("hoardfs"))
            .await
            .unwrap();
        hfs.set_variant_pipeline(hoardfs_variant::VariantPipeline::new().with_image_generator());

        let state = Arc::new(DaemonState {
            db,
            hoardfs: Arc::new(Mutex::new(hfs)),
            oidc: None,
            limits: Default::default(),
            session_key: [7u8; 32],
        });

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let router = crate::daemon::router(state.clone());
        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (base_url, token, state, tmp)
    }

    /// Desktop-side library: a collection with two images whose files exist.
    fn seed_desktop(dir: &std::path::Path) -> (crate::db::DbPool, String, Vec<String>) {
        let db = test_pool();
        insert_user(&db, "desktop-user");
        let collection = create_collection_core(
            &db,
            "desktop-user",
            CreateCollectionInput {
                name: "Summer Nebulae".to_string(),
                description: Some("first light".to_string()),
                visibility: None,
                template: None,
                tags: None,
            },
        )
        .unwrap();

        let mut image_ids = Vec::new();
        for i in 0..2u8 {
            let file = dir.join(format!("frame-{i}.png"));
            std::fs::write(&file, tiny_png(i * 40 + 10)).unwrap();
            let image = create_image_core(
                &db,
                "desktop-user",
                CreateImageInput {
                    collection_id: None,
                    filename: format!("frame-{i}.png"),
                    url: Some(file.to_string_lossy().to_string()),
                    summary: Some(format!("M{}", 42 + i as u32)),
                    description: None,
                    content_type: Some("image/png".to_string()),
                    tags: None,
                    visibility: None,
                    location: None,
                    annotations: None,
                    metadata: None,
                    thumbnail: None,
                },
            )
            .unwrap();
            add_image_to_collection_core(&db, "desktop-user", &image.id, &collection.id)
                .unwrap();
            image_ids.push(image.id);
        }
        (db, collection.id, image_ids)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn publish_sync_unpublish_round_trip_against_real_daemon() {
        let (base_url, token, daemon_state, _daemon_tmp) = spawn_daemon().await;
        let desktop_tmp = tempfile::tempdir().unwrap();
        let (desktop_db, collection_id, image_ids) = seed_desktop(desktop_tmp.path());

        let client = DaemonClient::new(&base_url, &token);
        let mut steps: Vec<String> = Vec::new();

        // Publish: metadata + 2 assets + publish record.
        let result = push_and_publish_core(&desktop_db, &client, &collection_id, |s, _, _, _| {
            steps.push(s.to_string())
        })
        .await
        .unwrap();
        assert_eq!(result.images_uploaded, 2);
        assert!(result.public_url.contains("/@erewhon/summer-nebulae"));
        assert!(steps.contains(&"uploading".to_string()) && steps.contains(&"done".to_string()));

        // Daemon side: rows, volume files, publish record all landed.
        let daemon_images =
            crate::commands::images::get_images_core(&daemon_state.db, "local-user").unwrap();
        assert_eq!(daemon_images.len(), 2);
        assert!(daemon_images.iter().all(|i| i.blob_id.is_some()));
        {
            let hfs = daemon_state.hoardfs.lock().unwrap();
            assert_eq!(hfs.list_files("default", "/").unwrap().len(), 2);
        }
        assert!(crate::commands::publish::resolve_public_collection(
            &daemon_state.db,
            "erewhon",
            "summer-nebulae"
        )
        .unwrap()
        .is_some());

        // Desktop side: share status saved into collection metadata.
        let status = {
            let mut conn = desktop_db.get().unwrap();
            let c = repository::get_collection_by_id(&mut conn, &collection_id)
                .unwrap()
                .unwrap();
            get_publish_status_from_metadata(&c.metadata).unwrap()
        };
        assert_eq!(status.public_url, result.public_url);
        assert_eq!(status.uploaded_image_ids.len(), 2);

        // Sync (re-push): idempotent — nothing re-uploads.
        let synced = push_and_publish_core(&desktop_db, &client, &collection_id, |_, _, _, _| {})
            .await
            .unwrap();
        assert_eq!(synced.images_uploaded, 0);
        assert_eq!(synced.public_url, result.public_url);

        // A new image syncs incrementally: only the new asset transfers.
        let file = desktop_tmp.path().join("frame-2.png");
        std::fs::write(&file, tiny_png(230)).unwrap();
        let new_image = create_image_core(
            &desktop_db,
            "desktop-user",
            CreateImageInput {
                collection_id: None,
                filename: "frame-2.png".to_string(),
                url: Some(file.to_string_lossy().to_string()),
                summary: None,
                description: None,
                content_type: Some("image/png".to_string()),
                tags: None,
                visibility: None,
                location: None,
                annotations: None,
                metadata: None,
                thumbnail: None,
            },
        )
        .unwrap();
        add_image_to_collection_core(&desktop_db, "desktop-user", &new_image.id, &collection_id)
            .unwrap();
        let incremental =
            push_and_publish_core(&desktop_db, &client, &collection_id, |_, _, _, _| {})
                .await
                .unwrap();
        assert_eq!(incremental.images_uploaded, 1);

        // Unpublish: record gone daemon-side, local share status cleared.
        unpublish_core(&desktop_db, &client, &collection_id)
            .await
            .unwrap();
        assert!(crate::commands::publish::resolve_public_collection(
            &daemon_state.db,
            "erewhon",
            "summer-nebulae"
        )
        .unwrap()
        .is_none());
        let cleared = {
            let mut conn = desktop_db.get().unwrap();
            let c = repository::get_collection_by_id(&mut conn, &collection_id)
                .unwrap()
                .unwrap();
            get_publish_status_from_metadata(&c.metadata)
        };
        assert!(cleared.is_none());
        let _ = image_ids;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bad_token_surfaces_authentication_errors() {
        let (base_url, _token, _state, _tmp) = spawn_daemon().await;
        let desktop_tmp = tempfile::tempdir().unwrap();
        let (desktop_db, collection_id, _) = seed_desktop(desktop_tmp.path());

        let client = DaemonClient::new(&base_url, "astra_wrong_token");
        let err = push_and_publish_core(&desktop_db, &client, &collection_id, |_, _, _, _| {})
            .await
            .unwrap_err();
        assert!(err.contains("401"), "expected 401 in error, got: {err}");

        let err = client.me().await.unwrap_err();
        assert!(err.contains("401"));
    }
}
