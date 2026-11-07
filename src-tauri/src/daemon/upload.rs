//! Single-image upload for non-browser clients (`astra-cli`): register one
//! image, then stream its bytes through the push asset route.
//!
//! The push protocol ([`super::ingest`]) is a whole-collection sync — the
//! pushed set *is* the collection. A CLI dropping one stacked frame into a
//! collection must not have to know the rest of its membership, so this
//! route is additive instead:
//!
//! 1. `POST /api/upload/images` — body carries the file's blake3 hash and
//!    its metadata. If the caller already owns an image with exactly that
//!    content the existing row is reused (`created: false`, asset
//!    `present`), so a watch loop that restarts, or a file that is copied
//!    twice, never produces duplicates. A row registered for that content
//!    whose bytes never arrived (a run cut off mid-upload) is reused too
//!    (`created: false`, asset `needed`), so a chunked upload resumes into
//!    the same image. Otherwise a row is inserted with a server-minted id
//!    (`created: true`, asset `needed`). Either way the
//!    image is linked into the target collection — by id, or by name,
//!    creating the collection on first use — without touching the rest of
//!    that collection.
//! 2. `PUT /api/push/images/{id}/asset` — the existing hash-verified asset
//!    route stores the bytes. For FITS content it also fills in what the
//!    desktop importer would have ([`fits_enrichment`]): header map into
//!    `metadata`, target name as `summary`, exposure/frames/filter as
//!    `description` — only where the client left them blank.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use diesel::prelude::*;
use serde::Deserialize;

use super::auth::AuthedUser;
use super::DaemonState;
use crate::commands::auto_import::{describe_stack, extract_target_name};
use crate::commands::collections::fetch_owned_collection;
use crate::commands::scan::parse_fits_metadata;
use crate::db::models::{Image, NewCollection, NewCollectionImage, NewImage};
use crate::db::schema::{collections, images};
use crate::db::{repository, DbPool};

#[derive(Debug, Deserialize)]
pub struct UploadImageBody {
    /// Display filename; any directory part is dropped.
    filename: String,
    /// blake3 of the file bytes, hex, optionally `blake3:`-prefixed.
    content_hash: String,
    content_type: Option<String>,
    summary: Option<String>,
    description: Option<String>,
    /// Comma-separated, as the desktop stores them.
    tags: Option<String>,
    visibility: Option<String>,
    /// Link into this collection (must be the caller's) …
    collection_id: Option<String>,
    /// … or into the caller's collection with this name, created if absent.
    /// Ignored when `collection_id` is set.
    collection_name: Option<String>,
    /// JSON object string merged into `images.metadata`.
    metadata: Option<String>,
    /// Where the file lived on the client — kept in metadata and used as a
    /// target-name hint for FITS files without an OBJECT header (ASI Air
    /// and SharpCap put the target in the directory name).
    source_path: Option<String>,
}

enum UploadError {
    Bad(&'static str),
    CollectionNotFound,
    Db(String),
}

impl From<diesel::result::Error> for UploadError {
    fn from(e: diesel::result::Error) -> Self {
        Self::Db(e.to_string())
    }
}

impl UploadError {
    fn into_response(self) -> Response {
        match self {
            Self::Bad(message) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "bad request", "message": message })),
            )
                .into_response(),
            Self::CollectionNotFound => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "collection not found" })),
            )
                .into_response(),
            Self::Db(e) => {
                log::error!("upload: {e}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": "internal error" })),
                )
                    .into_response()
            }
        }
    }
}

/// `blake3:<hex>` — the form `images.blob_id` holds (HoardFS `BlobId`
/// `Display`).
fn normalize_blob_id(hash: &str) -> Result<String, UploadError> {
    let hex = hash
        .trim()
        .trim_start_matches("blake3:")
        .to_ascii_lowercase();
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(UploadError::Bad(
            "content_hash must be 64 hex characters (blake3)",
        ));
    }
    Ok(format!("blake3:{hex}"))
}

fn basename(filename: &str) -> Result<String, UploadError> {
    let name = filename
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() {
        return Err(UploadError::Bad("filename is required"));
    }
    Ok(name)
}

/// MIME type from the extension; what the desktop importer would record.
pub fn content_type_for(filename: &str) -> &'static str {
    let ext = filename
        .rsplit('.')
        .next()
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "fit" | "fits" | "fts" => "image/fits",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "tif" | "tiff" => "image/tiff",
        "xisf" => "application/x-xisf",
        _ => "application/octet-stream",
    }
}

/// Resolve (or create) the target collection. `Ok(None)` when the body
/// names none.
fn resolve_collection(
    conn: &mut SqliteConnection,
    user_id: &str,
    body: &UploadImageBody,
) -> Result<Option<(String, bool)>, UploadError> {
    if let Some(id) = body
        .collection_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return match fetch_owned_collection(conn, user_id, id).map_err(UploadError::Db)? {
            Some(c) => Ok(Some((c.id, false))),
            None => Err(UploadError::CollectionNotFound),
        };
    }
    let Some(name) = body
        .collection_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return Ok(None);
    };

    // Case-insensitive match among the caller's live collections; the
    // oldest wins so repeated uploads always land in the same one.
    let existing: Option<String> = collections::table
        .filter(collections::user_id.eq(user_id))
        .filter(collections::archived.eq(false))
        .filter(
            diesel::dsl::sql::<diesel::sql_types::Bool>("lower(name) = lower(")
                .bind::<diesel::sql_types::Text, _>(name)
                .sql(")"),
        )
        .order(collections::created_at.asc())
        .select(collections::id)
        .first(conn)
        .optional()?;
    if let Some(id) = existing {
        return Ok(Some((id, false)));
    }

    let created = repository::create_collection(
        conn,
        &NewCollection {
            id: uuid::Uuid::new_v4().to_string(),
            user_id: user_id.to_string(),
            name: name.to_string(),
            description: None,
            visibility: "private".to_string(),
            template: None,
            favorite: false,
            tags: None,
            metadata: None,
            archived: false,
        },
    )?;
    Ok(Some((created.id, true)))
}

fn link(
    conn: &mut SqliteConnection,
    collection_id: &str,
    image_id: &str,
) -> Result<(), UploadError> {
    if repository::is_image_in_collection(conn, collection_id, image_id)? {
        return Ok(());
    }
    repository::add_image_to_collection(
        conn,
        &NewCollectionImage {
            id: uuid::Uuid::new_v4().to_string(),
            collection_id: collection_id.to_string(),
            image_id: image_id.to_string(),
        },
    )?;
    Ok(())
}

/// Metadata key naming the content a registered-but-assetless image waits
/// for; lets a repeat registration find the pending row. Dropped once the
/// bytes land.
pub const PENDING_HASH_KEY: &str = "pending_content_hash";

/// Client metadata (a JSON object string, or nothing) plus `source_path`
/// and the pending content hash.
fn initial_metadata(body: &UploadImageBody, blob_id: &str) -> Result<Option<String>, UploadError> {
    let mut value = match body
        .metadata
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(raw) => serde_json::from_str::<serde_json::Value>(raw)
            .ok()
            .filter(serde_json::Value::is_object)
            .ok_or(UploadError::Bad("metadata must be a JSON object"))?,
        None => serde_json::json!({}),
    };
    if let Some(path) = body
        .source_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        value["source_path"] = serde_json::Value::String(path.to_string());
    }
    value[PENDING_HASH_KEY] = serde_json::Value::String(blob_id.to_string());
    Ok(Some(value.to_string()))
}

fn register(
    db: &DbPool,
    user_id: &str,
    body: &UploadImageBody,
) -> Result<(StatusCode, serde_json::Value), UploadError> {
    let blob_id = normalize_blob_id(&body.content_hash)?;
    let filename = basename(&body.filename)?;
    let metadata = initial_metadata(body, &blob_id)?;
    let mut conn = db.get().map_err(|e| UploadError::Db(e.to_string()))?;

    conn.transaction::<_, UploadError, _>(|conn| {
        let collection = resolve_collection(conn, user_id, body)?;
        let collection_id = collection.as_ref().map(|(id, _)| id.clone());
        let collection_created = collection.as_ref().is_some_and(|(_, created)| *created);

        let existing: Option<String> = images::table
            .filter(images::user_id.eq(user_id))
            .filter(images::blob_id.eq(&blob_id))
            .order(images::created_at.asc())
            .select(images::id)
            .first(conn)
            .optional()?;
        // Registered earlier for this content, bytes never arrived.
        let pending: Option<String> = match existing {
            Some(_) => None,
            None => images::table
                .filter(images::user_id.eq(user_id))
                .filter(images::blob_id.is_null())
                .filter(images::metadata.like(format!(
                    "%{}%",
                    serde_json::json!({ PENDING_HASH_KEY: &blob_id })
                        .to_string()
                        .trim_matches(|c| c == '{' || c == '}')
                )))
                .order(images::created_at.asc())
                .select(images::id)
                .first(conn)
                .optional()?,
        };

        let (status, id, created, present) = match (existing, pending) {
            (Some(id), _) => (StatusCode::OK, id, false, true),
            (None, Some(id)) => (StatusCode::OK, id, false, false),
            (None, None) => {
                let content_type = body
                    .content_type
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| content_type_for(&filename).to_string());
                let image = repository::create_image(
                    conn,
                    &NewImage {
                        id: uuid::Uuid::new_v4().to_string(),
                        user_id: user_id.to_string(),
                        collection_id: collection_id.clone(),
                        filename: filename.clone(),
                        url: None,
                        summary: body.summary.clone().filter(|s| !s.trim().is_empty()),
                        description: body.description.clone().filter(|s| !s.trim().is_empty()),
                        content_type: Some(content_type),
                        favorite: false,
                        tags: body.tags.clone().filter(|s| !s.trim().is_empty()),
                        visibility: Some(
                            body.visibility
                                .clone()
                                .filter(|s| !s.trim().is_empty())
                                .unwrap_or_else(|| "private".to_string()),
                        ),
                        location: None,
                        annotations: None,
                        metadata,
                        thumbnail: None,
                        fits_url: None,
                        blob_id: None,
                    },
                )?;
                (StatusCode::CREATED, image.id, true, false)
            }
        };

        if let Some(cid) = &collection_id {
            link(conn, cid, &id)?;
        }

        Ok((
            status,
            serde_json::json!({
                "id": id,
                "created": created,
                "assetStatus": if present { "present" } else { "needed" },
                "collectionId": collection_id,
                "collectionCreated": collection_created,
            }),
        ))
    })
}

/// `POST /api/upload/images` — see the module docs. 201 with
/// `assetStatus: "needed"` for a new image (follow with the asset PUT),
/// 200 with `"present"` when the caller already holds that content.
pub async fn create_upload(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Json(body): Json<UploadImageBody>,
) -> Response {
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    match tokio::task::spawn_blocking(move || register(&db, &user_id, &body)).await {
        Ok(Ok((status, value))) => (status, Json(value)).into_response(),
        Ok(Err(e)) => e.into_response(),
        Err(e) => UploadError::Db(format!("upload task: {e}")).into_response(),
    }
}

// ============================================================================
// FITS enrichment at asset time
// ============================================================================

/// What a FITS asset contributes to its row, each part only where the row
/// has nothing yet.
#[derive(Debug, Default)]
pub struct FitsEnrichment {
    pub summary: Option<String>,
    pub description: Option<String>,
    pub headers: HashMap<String, String>,
}

/// A FITS primary HDU starts with the `SIMPLE  =` card; one header block
/// is the minimum size.
pub fn looks_like_fits(bytes: &[u8]) -> bool {
    bytes.len() >= 2880 && bytes.starts_with(b"SIMPLE  =")
}

/// Parse the FITS headers of an asset that arrived for `image` and derive
/// the fields the desktop importer fills. `None` when the bytes are not
/// FITS or the row already carries headers (a desktop push sends the
/// header map itself — `BITPIX` is the tell).
pub fn fits_enrichment(image: &Image, bytes: &[u8]) -> Option<FitsEnrichment> {
    if !looks_like_fits(bytes) {
        return None;
    }
    let metadata = image
        .metadata
        .as_deref()
        .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok());
    if metadata.as_ref().is_some_and(|m| m.get("BITPIX").is_some()) {
        return None;
    }

    // fitrs reads from a path; spool the bytes to a temp file.
    let mut tmp = tempfile::Builder::new()
        .prefix("astra-upload-")
        .suffix(".fits")
        .tempfile()
        .ok()?;
    std::io::Write::write_all(&mut tmp, bytes).ok()?;
    let parsed = match parse_fits_metadata(tmp.path()) {
        Ok(m) => m,
        Err(e) => {
            log::warn!("fits enrichment for {}: {e}", image.id);
            return None;
        }
    };

    let hint = metadata
        .as_ref()
        .and_then(|m| m.get("source_path"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| image.filename.clone());
    let summary = extract_target_name(std::path::Path::new(&hint), &parsed);
    let description = describe_stack(&image.filename, &parsed);

    Some(FitsEnrichment {
        summary,
        description,
        headers: parsed.raw_headers,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::daemon::auth::mint_token;
    use crate::daemon::ingest::CONTENT_HASH_HEADER;
    use crate::db::test_support::{insert_user, test_pool};
    use axum::body::to_bytes;
    use std::sync::Mutex;
    use tower::ServiceExt;

    fn tiny_png(seed: u8) -> Vec<u8> {
        let img = image::RgbImage::from_pixel(32, 32, image::Rgb([seed, 120, 220]));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }

    /// Minimal valid FITS: a 2×2 16-bit primary image with a few headers.
    pub(crate) fn tiny_fits(object: Option<&str>) -> Vec<u8> {
        let mut cards: Vec<String> = vec![
            "SIMPLE  =                    T".into(),
            "BITPIX  =                   16".into(),
            "NAXIS   =                    2".into(),
            "NAXIS1  =                    2".into(),
            "NAXIS2  =                    2".into(),
            "EXPTIME =                 10.0".into(),
            "NCOMBINE=                   20".into(),
            "FILTER  = 'LP      '".into(),
        ];
        if let Some(object) = object {
            cards.push(format!("OBJECT  = '{object:<8}'"));
        }
        cards.push("END".into());
        let mut out = Vec::new();
        for card in cards {
            out.extend(format!("{card:<80}").into_bytes());
        }
        out.resize(2880, b' ');
        out.resize(2880 * 2, 0);
        out
    }

    fn hash_of(bytes: &[u8]) -> String {
        hoardfs_core::BlobId::from_hash(blake3::hash(bytes)).to_hex()
    }

    async fn seeded() -> (Arc<DaemonState>, tempfile::TempDir, String, String) {
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
            limits: Default::default(),
            session_key: [7u8; 32],
            processing: Default::default(),
            tetra3_db: None,
            tetra3_cache: Default::default(),
            uploads_dir: std::env::temp_dir().join("astra-test-uploads"),
            handles: Default::default(),
            signer: None,
            mailer: Arc::new(crate::mail::LogMailer::default()),
            magic: Default::default(),
        });
        (state, tmp, alice, bob)
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

    async fn register_json(
        router: &axum::Router,
        token: &str,
        body: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        send(
            router,
            "POST",
            "/api/upload/images",
            token,
            body.to_string().into_bytes(),
            &[],
        )
        .await
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn upload_registers_stores_and_dedups_by_content() {
        let (state, _tmp, alice, bob) = seeded().await;
        let router = crate::daemon::router(state.clone());
        let png = tiny_png(1);
        let hash = hash_of(&png);

        let (status, first) = register_json(
            &router,
            &alice,
            serde_json::json!({
                "filename": "/mnt/seestar/MyWorks/M42/Stacked_120_M42.jpg",
                "content_hash": format!("blake3:{hash}"),
                "tags": "seestar, m42",
                "collection_name": "Seestar",
            }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{first}");
        assert_eq!(first["created"], true);
        assert_eq!(first["assetStatus"], "needed");
        assert_eq!(first["collectionCreated"], true);
        let id = first["id"].as_str().unwrap().to_string();
        let collection_id = first["collectionId"].as_str().unwrap().to_string();

        let (status, image) = send(
            &router,
            "GET",
            &format!("/api/images/{id}"),
            &alice,
            vec![],
            &[],
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            image["filename"], "Stacked_120_M42.jpg",
            "directory part dropped"
        );
        assert_eq!(image["content_type"], "image/jpeg");
        assert_eq!(image["tags"], "seestar, m42");
        assert_eq!(image["visibility"], "private");

        let (status, stored) = send(
            &router,
            "PUT",
            &format!("/api/push/images/{id}/asset"),
            &alice,
            png.clone(),
            &[(CONTENT_HASH_HEADER, hash.as_str())],
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{stored}");
        assert_eq!(stored["status"], "stored");

        // Same bytes again (watch loop restarted, file copied twice): reused,
        // and the collection name matches case-insensitively.
        let (status, again) = register_json(
            &router,
            &alice,
            serde_json::json!({
                "filename": "copy-of-M42.jpg",
                "content_hash": hash,
                "collection_name": "seestar",
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{again}");
        assert_eq!(again["created"], false);
        assert_eq!(again["assetStatus"], "present");
        assert_eq!(again["id"], id);
        assert_eq!(again["collectionId"], collection_id);
        assert_eq!(again["collectionCreated"], false);

        let (_, detail) = send(
            &router,
            "GET",
            &format!("/api/collections/{collection_id}"),
            &alice,
            vec![],
            &[],
        )
        .await;
        assert_eq!(detail["images"].as_array().unwrap().len(), 1);
        let (_, all) = send(&router, "GET", "/api/collections", &alice, vec![], &[]).await;
        assert_eq!(all.as_array().unwrap().len(), 1, "one collection, not two");

        // Bob's identical bytes are Bob's own image; Alice's collection is
        // invisible to him.
        let (status, bobs) = register_json(
            &router,
            &bob,
            serde_json::json!({ "filename": "mine.jpg", "content_hash": hash }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_ne!(bobs["id"], id);
        let (status, _) = register_json(
            &router,
            &bob,
            serde_json::json!({
                "filename": "mine.jpg",
                "content_hash": hash,
                "collection_id": collection_id,
            }),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn pending_registration_is_reused_until_the_asset_lands() {
        let (state, _tmp, alice, bob) = seeded().await;
        let router = crate::daemon::router(state.clone());
        let png = tiny_png(3);
        let hash = hash_of(&png);
        let body = serde_json::json!({ "filename": "Stack_M31.fit", "content_hash": hash });

        let (status, first) = register_json(&router, &alice, body.clone()).await;
        assert_eq!(status, StatusCode::CREATED);
        let id = first["id"].as_str().unwrap().to_string();

        // Cut off before the bytes arrived; the next run lands on the same row.
        let (status, again) = register_json(&router, &alice, body.clone()).await;
        assert_eq!(status, StatusCode::OK, "{again}");
        assert_eq!(again["id"], id);
        assert_eq!(again["created"], false);
        assert_eq!(again["assetStatus"], "needed");

        // Another user's pending row is theirs alone.
        let (status, bobs) = register_json(&router, &bob, body.clone()).await;
        assert_eq!(status, StatusCode::CREATED);
        assert_ne!(bobs["id"], id);

        let (_, image) = send(&router, "GET", &format!("/api/images/{id}"), &alice, vec![], &[]).await;
        let meta: serde_json::Value =
            serde_json::from_str(image["metadata"].as_str().unwrap()).unwrap();
        assert_eq!(meta[PENDING_HASH_KEY], format!("blake3:{hash}"));

        let (status, _) = send(
            &router,
            "PUT",
            &format!("/api/push/images/{id}/asset"),
            &alice,
            png.clone(),
            &[(CONTENT_HASH_HEADER, hash.as_str())],
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (_, image) = send(&router, "GET", &format!("/api/images/{id}"), &alice, vec![], &[]).await;
        let meta: serde_json::Value =
            serde_json::from_str(image["metadata"].as_str().unwrap()).unwrap();
        assert!(meta.get(PENDING_HASH_KEY).is_none(), "dropped once stored: {meta}");
        let (status, third) = register_json(&router, &alice, body).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(third["assetStatus"], "present");
        assert_eq!(third["id"], id);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn upload_validates_hash_and_filename() {
        let (state, _tmp, alice, _bob) = seeded().await;
        let router = crate::daemon::router(state.clone());
        for body in [
            serde_json::json!({ "filename": "a.fit", "content_hash": "nope" }),
            serde_json::json!({ "filename": "   ", "content_hash": "0".repeat(64) }),
            serde_json::json!({ "filename": "a.fit", "content_hash": "0".repeat(64), "metadata": "[1]" }),
        ] {
            let (status, _) = register_json(&router, &alice, body.clone()).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fits_asset_fills_summary_description_and_headers() {
        let (state, _tmp, alice, _bob) = seeded().await;
        let router = crate::daemon::router(state.clone());
        let fits = tiny_fits(Some("M42 (Orion Nebula)"));
        let hash = hash_of(&fits);

        let (status, reg) = register_json(
            &router,
            &alice,
            serde_json::json!({
                "filename": "Stack_16bits_20frames_200s.fit",
                "content_hash": hash,
                "source_path": "/asiair/Autorun/Light/M42/Stacked/Stack_16bits_20frames_200s.fit",
            }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{reg}");
        let id = reg["id"].as_str().unwrap().to_string();

        let (status, stored) = send(
            &router,
            "PUT",
            &format!("/api/push/images/{id}/asset"),
            &alice,
            fits,
            &[(CONTENT_HASH_HEADER, hash.as_str())],
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{stored}");

        let (_, image) = send(
            &router,
            "GET",
            &format!("/api/images/{id}"),
            &alice,
            vec![],
            &[],
        )
        .await;
        assert_eq!(
            image["summary"], "M42",
            "OBJECT header, parenthetical stripped"
        );
        let description = image["description"].as_str().unwrap();
        assert!(description.contains("10.0s exposure"), "{description}");
        assert!(description.contains("20 frames stacked"), "{description}");
        assert!(description.contains("Filter: LP"), "{description}");
        let metadata: serde_json::Value =
            serde_json::from_str(image["metadata"].as_str().unwrap()).unwrap();
        assert!(metadata.get("BITPIX").is_some(), "{metadata}");
        assert!(metadata.get("NCOMBINE").is_some(), "{metadata}");
        assert_eq!(
            metadata["source_path"],
            "/asiair/Autorun/Light/M42/Stacked/Stack_16bits_20frames_200s.fit"
        );
        assert!(metadata.get("hoardfs").is_some(), "server placement kept");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fits_without_object_falls_back_to_the_source_directory() {
        let (state, _tmp, alice, _bob) = seeded().await;
        let router = crate::daemon::router(state.clone());
        let fits = tiny_fits(None);
        let hash = hash_of(&fits);
        let (_, reg) = register_json(
            &router,
            &alice,
            serde_json::json!({
                "filename": "Stacked_42.fit",
                "content_hash": hash,
                "summary": "  ",
                "source_path": "/asiair/Autorun/Light/NGC 7000/Stacked/Stacked_42.fit",
            }),
        )
        .await;
        let id = reg["id"].as_str().unwrap().to_string();
        send(
            &router,
            "PUT",
            &format!("/api/push/images/{id}/asset"),
            &alice,
            fits,
            &[(CONTENT_HASH_HEADER, hash.as_str())],
        )
        .await;
        let (_, image) = send(
            &router,
            "GET",
            &format!("/api/images/{id}"),
            &alice,
            vec![],
            &[],
        )
        .await;
        assert_eq!(image["summary"], "NGC 7000");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn client_summary_wins_over_fits_enrichment() {
        let (state, _tmp, alice, _bob) = seeded().await;
        let router = crate::daemon::router(state.clone());
        let fits = tiny_fits(Some("M42"));
        let hash = hash_of(&fits);
        let (_, reg) = register_json(
            &router,
            &alice,
            serde_json::json!({
                "filename": "x.fit",
                "content_hash": hash,
                "summary": "Orion, first light",
                "description": "hand-written",
            }),
        )
        .await;
        let id = reg["id"].as_str().unwrap().to_string();
        send(
            &router,
            "PUT",
            &format!("/api/push/images/{id}/asset"),
            &alice,
            fits,
            &[(CONTENT_HASH_HEADER, hash.as_str())],
        )
        .await;
        let (_, image) = send(
            &router,
            "GET",
            &format!("/api/images/{id}"),
            &alice,
            vec![],
            &[],
        )
        .await;
        assert_eq!(image["summary"], "Orion, first light");
        assert_eq!(image["description"], "hand-written");
    }

    #[test]
    fn content_types() {
        assert_eq!(content_type_for("a.FIT"), "image/fits");
        assert_eq!(content_type_for("a.jpeg"), "image/jpeg");
        assert_eq!(content_type_for("a.xisf"), "application/x-xisf");
        assert_eq!(content_type_for("noext"), "application/octet-stream");
    }
}
