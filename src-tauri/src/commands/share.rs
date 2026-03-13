//! Tauri commands for gallery sharing.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::db::repository;
use crate::share::{auth, config, credentials, manifest, upload, viewer};
use crate::state::AppState;

// ============================================================================
// Types
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureShareInput {
    pub endpoint_url: String,
    pub bucket: String,
    pub region: String,
    pub path_prefix: String,
    pub public_url_base: String,
    pub access_key_id: String,
    pub secret_access_key: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectionShareMeta {
    share: Option<PublishStatus>,
}

// ============================================================================
// Config Commands
// ============================================================================

#[tauri::command]
pub fn configure_share_upload(
    app: AppHandle,
    input: ConfigureShareInput,
) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    let cfg = config::ShareUploadConfig {
        endpoint_url: input.endpoint_url,
        bucket: input.bucket,
        region: input.region,
        path_prefix: input.path_prefix,
        public_url_base: input.public_url_base,
    };

    config::save_config(&data_dir, &cfg)?;
    credentials::store_credentials(&data_dir, &input.access_key_id, &input.secret_access_key)?;

    Ok(())
}

#[tauri::command]
pub fn get_share_config(
    app: AppHandle,
) -> Result<Option<config::ShareUploadConfig>, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    config::load_config(&data_dir)
}

#[tauri::command]
pub async fn test_share_upload(app: AppHandle) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    let cfg = config::load_config(&data_dir)?
        .ok_or("Share config not found. Configure sharing first.")?;
    let creds = credentials::load_credentials(&data_dir)?;

    upload::test_upload(&cfg, &creds).await
}

#[tauri::command]
pub fn clear_share_config(app: AppHandle) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    config::delete_config(&data_dir)?;
    credentials::delete_credentials(&data_dir)?;
    Ok(())
}

// ============================================================================
// Publish Commands
// ============================================================================

#[tauri::command]
pub async fn publish_collection(
    app: AppHandle,
    state: State<'_, AppState>,
    collection_id: String,
) -> Result<PublishResult, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    let cfg = config::load_config(&data_dir)?
        .ok_or("Share config not found. Configure sharing in Settings.")?;
    let creds = credentials::load_credentials(&data_dir)?;

    // Load collection
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    let collection = repository::get_collection_by_id(&mut conn, &collection_id)
        .map_err(|e| e.to_string())?
        .ok_or("Collection not found")?;

    // Load images
    let images = repository::get_images_in_collection(&mut conn, &collection_id)
        .map_err(|e| e.to_string())?;
    drop(conn);

    // Generate or reuse share_id
    let existing_status = get_publish_status_from_metadata(&collection.metadata);
    let share_id = existing_status
        .map(|s| s.share_id)
        .unwrap_or_else(|| generate_share_id());

    // Upload all images + thumbnails
    let mut manifest_images = Vec::new();
    let mut images_uploaded = 0usize;
    let mut thumbs_uploaded = 0usize;
    let mut uploaded_ids = Vec::new();

    for image in &images {
        let Some(file_path) = &image.url else { continue };
        let path = std::path::Path::new(file_path);
        if !path.exists() {
            log::warn!("Skipping missing file: {}", file_path);
            continue;
        }

        let file_data = std::fs::read(path)
            .map_err(|e| format!("Failed to read {}: {}", file_path, e))?;

        let content_type = mime_for_path(path);
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("jpg");

        // Upload full image
        let image_key = upload::share_key(&cfg, &share_id, &format!("images/{}.{}", image.id, ext));
        upload::upload_file(
            &cfg,
            &creds,
            &image_key,
            &file_data,
            content_type,
            Some("max-age=31536000, immutable"),
        )
        .await?;
        images_uploaded += 1;

        // Generate and upload thumbnail
        let thumb_data = generate_thumbnail(&file_data)?;
        let thumb_key = upload::share_key(&cfg, &share_id, &format!("thumbs/{}.jpg", image.id));
        upload::upload_file(
            &cfg,
            &creds,
            &thumb_key,
            &thumb_data,
            "image/jpeg",
            Some("max-age=31536000, immutable"),
        )
        .await?;
        thumbs_uploaded += 1;

        manifest_images.push(manifest::ManifestImage {
            id: image.id.clone(),
            filename: image.filename.clone(),
            summary: image.summary.clone(),
            content_type: content_type.to_string(),
            image_path: format!("images/{}.{}", image.id, ext),
            thumb_path: format!("thumbs/{}.jpg", image.id),
            created_at: image.created_at.to_string(),
        });

        uploaded_ids.push(image.id.clone());
    }

    // Build and upload manifest
    let share_manifest = manifest::build_manifest(
        &collection.name,
        collection.description.as_deref(),
        collection.template.as_deref(),
        manifest_images,
    );
    let manifest_json = serde_json::to_string_pretty(&share_manifest)
        .map_err(|e| format!("Failed to serialize manifest: {}", e))?;
    let manifest_key = upload::share_key(&cfg, &share_id, "manifest.json");
    upload::upload_file(
        &cfg,
        &creds,
        &manifest_key,
        manifest_json.as_bytes(),
        "application/json; charset=utf-8",
        Some("max-age=10"),
    )
    .await?;

    // Upload viewer
    let viewer_key = upload::share_key(&cfg, &share_id, "index.html");
    upload::upload_file(
        &cfg,
        &creds,
        &viewer_key,
        viewer::VIEWER_HTML.as_bytes(),
        "text/html; charset=utf-8",
        Some("max-age=10"),
    )
    .await?;

    // Save publish status to collection metadata
    let public_url = upload::public_url(&cfg, &share_id);
    let now = chrono::Utc::now().to_rfc3339();
    let status = PublishStatus {
        share_id: share_id.clone(),
        published_at: now.clone(),
        public_url: public_url.clone(),
        last_synced_at: now,
        uploaded_image_ids: uploaded_ids,
    };

    save_publish_status(&state, &collection_id, &collection.metadata, &status)?;

    Ok(PublishResult {
        share_id,
        public_url,
        images_uploaded,
        thumbs_uploaded,
    })
}

#[tauri::command]
pub async fn sync_collection(
    app: AppHandle,
    state: State<'_, AppState>,
    collection_id: String,
) -> Result<PublishResult, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    let cfg = config::load_config(&data_dir)?
        .ok_or("Share config not found")?;
    let creds = credentials::load_credentials(&data_dir)?;

    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    let collection = repository::get_collection_by_id(&mut conn, &collection_id)
        .map_err(|e| e.to_string())?
        .ok_or("Collection not found")?;

    let images = repository::get_images_in_collection(&mut conn, &collection_id)
        .map_err(|e| e.to_string())?;
    drop(conn);

    let status = get_publish_status_from_metadata(&collection.metadata)
        .ok_or("Collection is not published")?;

    let share_id = &status.share_id;
    let already_uploaded: std::collections::HashSet<String> =
        status.uploaded_image_ids.into_iter().collect();

    let mut manifest_images = Vec::new();
    let mut images_uploaded = 0usize;
    let mut thumbs_uploaded = 0usize;
    let mut all_uploaded_ids = Vec::new();

    for image in &images {
        let Some(file_path) = &image.url else { continue };
        let path = std::path::Path::new(file_path);
        if !path.exists() { continue; }

        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("jpg");
        let content_type = mime_for_path(path);

        // Only upload new images
        if !already_uploaded.contains(&image.id) {
            let file_data = std::fs::read(path)
                .map_err(|e| format!("Failed to read {}: {}", file_path, e))?;

            let image_key = upload::share_key(&cfg, share_id, &format!("images/{}.{}", image.id, ext));
            upload::upload_file(
                &cfg,
                &creds,
                &image_key,
                &file_data,
                content_type,
                Some("max-age=31536000, immutable"),
            )
            .await?;
            images_uploaded += 1;

            let thumb_data = generate_thumbnail(&file_data)?;
            let thumb_key = upload::share_key(&cfg, share_id, &format!("thumbs/{}.jpg", image.id));
            upload::upload_file(
                &cfg,
                &creds,
                &thumb_key,
                &thumb_data,
                "image/jpeg",
                Some("max-age=31536000, immutable"),
            )
            .await?;
            thumbs_uploaded += 1;
        }

        manifest_images.push(manifest::ManifestImage {
            id: image.id.clone(),
            filename: image.filename.clone(),
            summary: image.summary.clone(),
            content_type: content_type.to_string(),
            image_path: format!("images/{}.{}", image.id, ext),
            thumb_path: format!("thumbs/{}.jpg", image.id),
            created_at: image.created_at.to_string(),
        });

        all_uploaded_ids.push(image.id.clone());
    }

    // Always rebuild and upload manifest
    let share_manifest = manifest::build_manifest(
        &collection.name,
        collection.description.as_deref(),
        collection.template.as_deref(),
        manifest_images,
    );
    let manifest_json = serde_json::to_string_pretty(&share_manifest)
        .map_err(|e| format!("Failed to serialize manifest: {}", e))?;
    let manifest_key = upload::share_key(&cfg, share_id, "manifest.json");
    upload::upload_file(
        &cfg,
        &creds,
        &manifest_key,
        manifest_json.as_bytes(),
        "application/json; charset=utf-8",
        Some("max-age=10"),
    )
    .await?;

    // Update viewer too
    let viewer_key = upload::share_key(&cfg, share_id, "index.html");
    upload::upload_file(
        &cfg,
        &creds,
        &viewer_key,
        viewer::VIEWER_HTML.as_bytes(),
        "text/html; charset=utf-8",
        Some("max-age=10"),
    )
    .await?;

    // Update status
    let public_url = upload::public_url(&cfg, share_id);
    let now = chrono::Utc::now().to_rfc3339();
    let new_status = PublishStatus {
        share_id: share_id.clone(),
        published_at: status.published_at,
        public_url: public_url.clone(),
        last_synced_at: now,
        uploaded_image_ids: all_uploaded_ids,
    };

    save_publish_status(&state, &collection_id, &collection.metadata, &new_status)?;

    Ok(PublishResult {
        share_id: share_id.clone(),
        public_url,
        images_uploaded,
        thumbs_uploaded,
    })
}

#[tauri::command]
pub async fn unpublish_collection(
    app: AppHandle,
    state: State<'_, AppState>,
    collection_id: String,
) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    let cfg = config::load_config(&data_dir)?
        .ok_or("Share config not found")?;
    let creds = credentials::load_credentials(&data_dir)?;

    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    let collection = repository::get_collection_by_id(&mut conn, &collection_id)
        .map_err(|e| e.to_string())?
        .ok_or("Collection not found")?;
    drop(conn);

    let status = get_publish_status_from_metadata(&collection.metadata)
        .ok_or("Collection is not published")?;

    let share_id = &status.share_id;

    // Delete known files (best-effort)
    for image_id in &status.uploaded_image_ids {
        // We don't know the extension, try common ones
        for ext in &["jpg", "jpeg", "png", "webp", "gif"] {
            let key = upload::share_key(&cfg, share_id, &format!("images/{}.{}", image_id, ext));
            let _ = upload::delete_file(&cfg, &creds, &key).await;
        }
        let thumb_key = upload::share_key(&cfg, share_id, &format!("thumbs/{}.jpg", image_id));
        let _ = upload::delete_file(&cfg, &creds, &thumb_key).await;
    }

    // Delete manifest and viewer
    let manifest_key = upload::share_key(&cfg, share_id, "manifest.json");
    let _ = upload::delete_file(&cfg, &creds, &manifest_key).await;
    let viewer_key = upload::share_key(&cfg, share_id, "index.html");
    let _ = upload::delete_file(&cfg, &creds, &viewer_key).await;

    // Clear publish status from metadata
    save_publish_status(&state, &collection_id, &collection.metadata, &PublishStatus {
        share_id: String::new(),
        published_at: String::new(),
        public_url: String::new(),
        last_synced_at: String::new(),
        uploaded_image_ids: Vec::new(),
    }).ok();

    // Actually remove the share key entirely
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    let mut meta: serde_json::Value = collection
        .metadata
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    meta.as_object_mut().map(|m| m.remove("share"));
    let meta_str = serde_json::to_string(&meta).unwrap_or_else(|_| "{}".to_string());
    let update = crate::db::models::UpdateCollection {
        metadata: Some(meta_str),
        ..Default::default()
    };
    repository::update_collection(&mut conn, &collection_id, &update)
        .map_err(|e| e.to_string())?;

    Ok(())
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
    state: &State<'_, AppState>,
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

    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    let update = crate::db::models::UpdateCollection {
        metadata: Some(meta_str),
        ..Default::default()
    };
    repository::update_collection(&mut conn, collection_id, &update)
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn generate_share_id() -> String {
    // 12 hex chars from UUID
    uuid::Uuid::new_v4().to_string().replace('-', "")[..12].to_string()
}

fn generate_thumbnail(image_data: &[u8]) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(image_data)
        .map_err(|e| format!("Failed to decode image for thumbnail: {}", e))?;

    let thumb = img.thumbnail(400, 400);

    let mut buf = std::io::Cursor::new(Vec::new());
    thumb
        .write_to(&mut buf, image::ImageFormat::Jpeg)
        .map_err(|e| format!("Failed to encode thumbnail: {}", e))?;

    Ok(buf.into_inner())
}

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
        _ => "application/octet-stream",
    }
}

// ============================================================================
// Auth Commands (Clerk OAuth for astra.gallery)
// ============================================================================

#[tauri::command]
pub async fn clerk_sign_in(app: AppHandle) -> Result<auth::AuthSession, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    let clerk_publishable_key = std::env::var("CLERK_PUBLISHABLE_KEY")
        .map_err(|_| "CLERK_PUBLISHABLE_KEY environment variable not set".to_string())?;

    let session = auth::sign_in(&clerk_publishable_key).await?;
    auth::save_session(&data_dir, &session)?;

    Ok(session)
}

#[tauri::command]
pub fn clerk_sign_out(app: AppHandle) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    auth::delete_session(&data_dir)
}

#[tauri::command]
pub fn get_auth_session(app: AppHandle) -> Result<Option<auth::AuthSession>, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    auth::load_session(&data_dir)
}

// ============================================================================
// Dual-mode Publish (astra.gallery or self-hosted S3)
// ============================================================================

/// Presigned URL response from the Worker API.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresignResponse {
    share_id: String,
    uploads: Vec<PresignUpload>,
    public_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresignUpload {
    key: String,
    presigned_url: String,
    expires_at: String,
}

/// Publish a collection via astra.gallery (presigned URLs).
#[tauri::command]
pub async fn publish_collection_gallery(
    app: AppHandle,
    state: State<'_, AppState>,
    collection_id: String,
) -> Result<PublishResult, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    let session = auth::load_session(&data_dir)?
        .ok_or("Not signed in to astra.gallery. Sign in first.")?;

    // Load collection and images
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    let collection = repository::get_collection_by_id(&mut conn, &collection_id)
        .map_err(|e| e.to_string())?
        .ok_or("Collection not found")?;
    let images = repository::get_images_in_collection(&mut conn, &collection_id)
        .map_err(|e| e.to_string())?;
    drop(conn);

    // Generate or reuse share_id
    let existing_status = get_publish_status_from_metadata(&collection.metadata);
    let share_id = existing_status
        .map(|s| s.share_id)
        .unwrap_or_else(|| generate_share_id());

    // Build file list for presign request
    let collection_slug = slugify(&collection.name);
    let mut files_to_upload: Vec<(String, String, Vec<u8>)> = Vec::new(); // (key, content_type, data)
    let mut manifest_images = Vec::new();
    let mut uploaded_ids = Vec::new();

    for image in &images {
        let Some(file_path) = &image.url else { continue };
        let path = std::path::Path::new(file_path);
        if !path.exists() {
            log::warn!("Skipping missing file: {}", file_path);
            continue;
        }

        let file_data = std::fs::read(path)
            .map_err(|e| format!("Failed to read {}: {}", file_path, e))?;
        let content_type = mime_for_path(path);
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("jpg");

        // Full image
        let image_key = format!("images/{}.{}", image.id, ext);
        files_to_upload.push((image_key.clone(), content_type.to_string(), file_data.clone()));

        // Thumbnail
        let thumb_data = generate_thumbnail(&file_data)?;
        let thumb_key = format!("thumbs/{}.jpg", image.id);
        files_to_upload.push((thumb_key.clone(), "image/jpeg".to_string(), thumb_data));

        manifest_images.push(manifest::ManifestImage {
            id: image.id.clone(),
            filename: image.filename.clone(),
            summary: image.summary.clone(),
            content_type: content_type.to_string(),
            image_path: image_key,
            thumb_path: thumb_key,
            created_at: image.created_at.to_string(),
        });

        uploaded_ids.push(image.id.clone());
    }

    // Build manifest
    let share_manifest = manifest::build_manifest(
        &collection.name,
        collection.description.as_deref(),
        collection.template.as_deref(),
        manifest_images,
    );
    let manifest_json = serde_json::to_string_pretty(&share_manifest)
        .map_err(|e| format!("Failed to serialize manifest: {}", e))?;
    files_to_upload.push(("manifest.json".to_string(), "application/json".to_string(), manifest_json.into_bytes()));
    files_to_upload.push(("index.html".to_string(), "text/html".to_string(), viewer::VIEWER_HTML.as_bytes().to_vec()));

    // Request presigned URLs from Worker
    let presign_body = serde_json::json!({
        "shareId": share_id,
        "collectionSlug": collection_slug,
        "collectionName": collection.name,
        "files": files_to_upload.iter().map(|(key, ct, data)| {
            serde_json::json!({
                "key": key,
                "contentType": ct,
                "size": data.len(),
            })
        }).collect::<Vec<_>>(),
    });

    let client = reqwest::Client::new();
    let presign_resp = client
        .post(format!("{}/api/presign", "https://astra.gallery"))
        .header("Authorization", format!("Bearer {}", session.api_token))
        .json(&presign_body)
        .send()
        .await
        .map_err(|e| format!("Presign request failed: {}", e))?;

    if !presign_resp.status().is_success() {
        let status = presign_resp.status();
        let body = presign_resp.text().await.unwrap_or_default();
        return Err(format!("Presign request failed ({}): {}", status, body));
    }

    let presign: PresignResponse = presign_resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse presign response: {}", e))?;

    // Upload each file to its presigned URL
    let mut images_uploaded = 0usize;
    let mut thumbs_uploaded = 0usize;

    for (key, content_type, data) in &files_to_upload {
        let upload_info = presign.uploads.iter().find(|u| &u.key == key)
            .ok_or_else(|| format!("No presigned URL for {}", key))?;

        upload::upload_file_presigned(&upload_info.presigned_url, data, content_type).await?;

        if key.starts_with("images/") {
            images_uploaded += 1;
        } else if key.starts_with("thumbs/") {
            thumbs_uploaded += 1;
        }
    }

    // Save publish status
    let now = chrono::Utc::now().to_rfc3339();
    let status = PublishStatus {
        share_id: presign.share_id.clone(),
        published_at: now.clone(),
        public_url: presign.public_url.clone(),
        last_synced_at: now,
        uploaded_image_ids: uploaded_ids,
    };

    save_publish_status(&state, &collection_id, &collection.metadata, &status)?;

    Ok(PublishResult {
        share_id: presign.share_id,
        public_url: presign.public_url,
        images_uploaded,
        thumbs_uploaded,
    })
}

fn slugify(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}
