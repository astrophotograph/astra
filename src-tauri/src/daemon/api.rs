//! Authenticated read API: the caller's library as JSON plus image bytes
//! from HoardFS variants.
//!
//! JSON shapes are the database models serialized as-is (snake_case) — the
//! exact serialization the desktop's `invoke()` layer returns, matching the
//! zod schemas in `src/lib/models.ts`. One deviation: the legacy embedded
//! base64 `thumbnail` field is always stripped (`null`) from responses —
//! bytes come from `/api/images/{id}/thumbnail`, backed by HoardFS. The
//! `/api/me` endpoint (in `daemon::mod`) is a daemon-native shape and stays
//! camelCase.
//!
//! Every handler takes [`AuthedUser`] and passes `user_id` to the command
//! cores, which enforce the tenancy boundary (not-owned reads as 404/empty).

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use hoardfs_core::Quality;
use serde::{Deserialize, Serialize};

use super::auth::AuthedUser;
use super::DaemonState;
use crate::commands::collections::{get_collection_core, get_collections_core};
use crate::commands::hoardfs::resolve_hfs_path;
use crate::commands::images::{get_collection_images_core, get_image_core, get_images_core};
use crate::commands::publish::{
    get_publish_status_core, publish_collection_core, unpublish_collection_core,
    PublishVisibility,
};
use crate::db::models::{Collection, Image};
use crate::db::tenancy;

const DEFAULT_PAGE_LIMIT: usize = 100;
const MAX_PAGE_LIMIT: usize = 500;

#[derive(Debug, Deserialize)]
pub struct PageParams {
    limit: Option<usize>,
    offset: Option<usize>,
}

#[derive(Debug, Serialize)]
struct PageOut<T> {
    items: Vec<T>,
    total: usize,
    limit: usize,
    offset: usize,
}

#[derive(Debug, Serialize)]
struct CollectionDetail {
    collection: Collection,
    images: Vec<Image>,
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "error": "not found" })),
    )
        .into_response()
}

fn internal(context: &str, detail: String) -> Response {
    log::error!("{context}: {detail}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "error": "internal error" })),
    )
        .into_response()
}

/// The embedded base64 thumbnail is legacy storage being decommissioned —
/// never ship it over the API.
fn strip_thumbnail(mut image: Image) -> Image {
    image.thumbnail = None;
    image
}

pub async fn list_images(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Query(page): Query<PageParams>,
) -> Response {
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    let all = match tokio::task::spawn_blocking(move || get_images_core(&db, &user_id)).await {
        Ok(Ok(images)) => images,
        Ok(Err(e)) => return internal("list_images", e),
        Err(e) => return internal("list_images task", e.to_string()),
    };

    let limit = page.limit.unwrap_or(DEFAULT_PAGE_LIMIT).min(MAX_PAGE_LIMIT);
    let offset = page.offset.unwrap_or(0);
    let total = all.len();
    let items: Vec<Image> = all
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(strip_thumbnail)
        .collect();

    Json(PageOut {
        items,
        total,
        limit,
        offset,
    })
    .into_response()
}

pub async fn get_image(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(id): Path<String>,
) -> Response {
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    match tokio::task::spawn_blocking(move || get_image_core(&db, &user_id, &id)).await {
        Ok(Ok(Some(image))) => Json(strip_thumbnail(image)).into_response(),
        Ok(Ok(None)) => not_found(),
        Ok(Err(e)) => internal("get_image", e),
        Err(e) => internal("get_image task", e.to_string()),
    }
}

pub async fn list_collections(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
) -> Response {
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    match tokio::task::spawn_blocking(move || get_collections_core(&db, &user_id)).await {
        Ok(Ok(collections)) => Json(collections).into_response(),
        Ok(Err(e)) => internal("list_collections", e),
        Err(e) => internal("list_collections task", e.to_string()),
    }
}

pub async fn get_collection(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(id): Path<String>,
) -> Response {
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        let collection = get_collection_core(&db, &user_id, &id)?;
        match collection {
            None => Ok(None),
            Some(collection) => {
                let images = get_collection_images_core(&db, &user_id, &id)?;
                Ok(Some((collection, images)))
            }
        }
    })
    .await;

    match result {
        Ok(Ok(Some((collection, images)))) => Json(CollectionDetail {
            collection,
            images: images.into_iter().map(strip_thumbnail).collect(),
        })
        .into_response(),
        Ok(Ok(None)) => not_found(),
        Ok(Err(e)) => internal("get_collection", e),
        Err(e) => internal("get_collection task", e.to_string()),
    }
}

#[derive(Debug, Default, Deserialize)]
pub struct PublishBody {
    visibility: Option<PublishVisibility>,
    slug: Option<String>,
}

pub async fn publish_collection(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(id): Path<String>,
    body: Option<Json<PublishBody>>,
) -> Response {
    let PublishBody { visibility, slug } = body.map(|Json(b)| b).unwrap_or_default();
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        publish_collection_core(
            &db,
            &user_id,
            &id,
            visibility.unwrap_or(PublishVisibility::Public),
            slug.as_deref(),
        )
    })
    .await;

    match result {
        Ok(Ok(record)) => Json(record).into_response(),
        Ok(Err(e)) if e.starts_with("Collection not found") => not_found(),
        Ok(Err(e)) => internal("publish_collection", e),
        Err(e) => internal("publish_collection task", e.to_string()),
    }
}

pub async fn publish_status(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(id): Path<String>,
) -> Response {
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    match tokio::task::spawn_blocking(move || get_publish_status_core(&db, &user_id, &id)).await
    {
        Ok(Ok(Some(record))) => Json(record).into_response(),
        Ok(Ok(None)) => not_found(),
        Ok(Err(e)) => internal("publish_status", e),
        Err(e) => internal("publish_status task", e.to_string()),
    }
}

pub async fn unpublish_collection(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(id): Path<String>,
) -> Response {
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    match tokio::task::spawn_blocking(move || unpublish_collection_core(&db, &user_id, &id))
        .await
    {
        Ok(Ok(true)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Ok(false)) => not_found(),
        Ok(Err(e)) => internal("unpublish_collection", e),
        Err(e) => internal("unpublish_collection task", e.to_string()),
    }
}

pub async fn image_thumbnail(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    serve_variant(state, user, id, Quality::Thumbnail, headers).await
}

pub async fn image_preview(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    serve_variant(state, user, id, Quality::Preview, headers).await
}

fn etag_for(blob_id: &str) -> String {
    format!("\"{blob_id}\"")
}

fn if_none_match_hits(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .map(|inm| inm.split(',').any(|c| c.trim() == etag || c.trim() == "*"))
        .unwrap_or(false)
}

/// Serve image bytes at the requested quality from the caller's HoardFS
/// volume. `blob_id` is the natural ETag: content-addressed, so it changes
/// exactly when the bytes do.
async fn serve_variant(
    state: Arc<DaemonState>,
    user: AuthedUser,
    image_id: String,
    quality: Quality,
    headers: HeaderMap,
) -> Response {
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    let lookup_id = image_id.clone();
    let image = match tokio::task::spawn_blocking(move || {
        get_image_core(&db, &user_id, &lookup_id)
    })
    .await
    {
        Ok(Ok(Some(image))) => image,
        Ok(Ok(None)) => return not_found(),
        Ok(Err(e)) => return internal("serve_variant lookup", e),
        Err(e) => return internal("serve_variant lookup task", e.to_string()),
    };

    let etag = image.blob_id.as_deref().map(etag_for);
    if let Some(etag) = &etag {
        if if_none_match_hits(&headers, etag) {
            let mut response = StatusCode::NOT_MODIFIED.into_response();
            let response_headers = response.headers_mut();
            if let Ok(etag) = etag.parse() {
                response_headers.insert(header::ETAG, etag);
            }
            response_headers.insert(
                header::CACHE_CONTROL,
                header::HeaderValue::from_static("private, max-age=3600"),
            );
            return response;
        }
    }

    let Some(hfs_path) = resolve_hfs_path(&image) else {
        log::debug!("image {image_id} has no HoardFS path");
        return not_found();
    };

    let volume = tenancy::volume_name(&user.user_id);
    let hfs_arc = state.hoardfs.clone();
    let rt = tokio::runtime::Handle::current();
    let fetched = tokio::task::spawn_blocking(move || {
        let hfs = hfs_arc.lock().map_err(|_| "HoardFS lock poisoned".to_string())?;
        rt.block_on(hfs.get_file_quality(&volume, &hfs_path, quality))
            .map_err(|e| e.to_string())
    })
    .await;

    match fetched {
        Ok(Ok((data, _served_quality, content_type))) => {
            let mut response = (StatusCode::OK, data).into_response();
            let headers = response.headers_mut();
            headers.insert(
                header::CONTENT_TYPE,
                content_type
                    .parse()
                    .unwrap_or(header::HeaderValue::from_static("application/octet-stream")),
            );
            headers.insert(
                header::CACHE_CONTROL,
                header::HeaderValue::from_static("private, max-age=3600"),
            );
            if let Some(etag) = etag.and_then(|e| e.parse().ok()) {
                headers.insert(header::ETAG, etag);
            }
            response
        }
        Ok(Err(e)) => {
            log::debug!("variant fetch for image {image_id} failed: {e}");
            not_found()
        }
        Err(e) => internal("serve_variant fetch task", e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::collections::{create_collection_core, CreateCollectionInput};
    use crate::commands::images::{
        add_image_to_collection_core, create_image_core, CreateImageInput,
    };
    use crate::daemon::auth::mint_token;
    use crate::db::test_support::{insert_user, test_pool};
    use crate::db::DbPool;
    use axum::body::to_bytes;
    use diesel::prelude::*;
    use std::sync::Mutex;
    use tower::ServiceExt;

    fn tiny_png() -> Vec<u8> {
        let img = image::RgbImage::from_pixel(64, 64, image::Rgb([200, 30, 80]));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
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

    /// State with alice + bob, tokens for both, and one HoardFS-backed image
    /// for alice (real PNG through the variant pipeline).
    async fn seeded() -> (
        Arc<DaemonState>,
        tempfile::TempDir,
        String, // alice token
        String, // bob token
        Image,  // alice's hoardfs-backed image
    ) {
        let tmp = tempfile::tempdir().unwrap();
        let db = test_pool();
        insert_user(&db, "alice");
        insert_user(&db, "bob");

        let mut hfs = hoardfs_volume::HoardFs::init(&tmp.path().join("hoardfs"))
            .await
            .unwrap();
        hfs.set_variant_pipeline(hoardfs_variant::VariantPipeline::new().with_image_generator());

        tenancy::ensure_user_volume(&hfs, "alice").unwrap();
        hfs.put_file("user-alice", "/gallery/m42.png", &tiny_png())
            .await
            .unwrap();
        let blob_id = hfs
            .get_file_info("user-alice", "/gallery/m42.png")
            .unwrap()
            .current_version
            .blob_id;

        let image = seed_image(&db, "alice", "m42.png");
        let metadata = serde_json::json!({ "hoardfs": { "hfs_path": "/gallery/m42.png" } });
        {
            use crate::db::schema::images;
            diesel::update(images::table.find(&image.id))
                .set((
                    images::blob_id.eq(Some(blob_id)),
                    images::metadata.eq(Some(metadata.to_string())),
                ))
                .execute(&mut db.get().unwrap())
                .unwrap();
        }

        let alice_token = mint_token(&db, "alice", "t").unwrap().token;
        let bob_token = mint_token(&db, "bob", "t").unwrap().token;

        let state = Arc::new(DaemonState {
            db,
            hoardfs: Arc::new(Mutex::new(hfs)),
            oidc: None,
            limits: Default::default(),
        });
        (state, tmp, alice_token, bob_token, image)
    }

    async fn get(
        router: &axum::Router,
        token: &str,
        uri: &str,
        extra: &[(header::HeaderName, &str)],
    ) -> (StatusCode, HeaderMap, Vec<u8>) {
        let mut req = axum::http::Request::builder()
            .uri(uri)
            .header("Authorization", format!("Bearer {token}"));
        for (name, value) in extra {
            req = req.header(name, *value);
        }
        let resp = router
            .clone()
            .oneshot(req.body(axum::body::Body::empty()).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        let headers = resp.headers().clone();
        let body = to_bytes(resp.into_body(), 16 << 20).await.unwrap().to_vec();
        (status, headers, body)
    }

    fn json(body: &[u8]) -> serde_json::Value {
        serde_json::from_slice(body).unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn images_paginate_strip_thumbnails_and_isolate() {
        let (state, _tmp, alice, bob, _img) = seeded().await;
        for i in 0..4 {
            seed_image(&state.db, "alice", &format!("extra-{i}.png"));
        }
        let router = crate::daemon::router(state.clone());

        let (status, _, body) = get(&router, &alice, "/api/images?limit=2&offset=2", &[]).await;
        assert_eq!(status, StatusCode::OK);
        let page = json(&body);
        assert_eq!(page["total"], 5);
        assert_eq!(page["items"].as_array().unwrap().len(), 2);
        assert_eq!(page["limit"], 2);
        assert_eq!(page["offset"], 2);
        // models.ts shape: snake_case fields, legacy thumbnail stripped.
        assert!(page["items"][0].get("user_id").is_some());
        assert!(page["items"][0]["thumbnail"].is_null());

        let (status, _, body) = get(&router, &bob, "/api/images", &[]).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json(&body)["total"], 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn single_image_scoped_to_owner() {
        let (state, _tmp, alice, bob, img) = seeded().await;
        let router = crate::daemon::router(state.clone());

        let (status, _, body) = get(&router, &alice, &format!("/api/images/{}", img.id), &[]).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json(&body)["filename"], "m42.png");

        let (status, _, _) = get(&router, &bob, &format!("/api/images/{}", img.id), &[]).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn collections_list_and_detail() {
        let (state, _tmp, alice, bob, img) = seeded().await;
        let collection = create_collection_core(
            &state.db,
            "alice",
            CreateCollectionInput {
                name: "Nebulae".to_string(),
                description: None,
                visibility: None,
                template: None,
                tags: None,
            },
        )
        .unwrap();
        add_image_to_collection_core(&state.db, "alice", &img.id, &collection.id).unwrap();
        let router = crate::daemon::router(state.clone());

        let (status, _, body) = get(&router, &alice, "/api/collections", &[]).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json(&body).as_array().unwrap().len(), 1);

        let uri = format!("/api/collections/{}", collection.id);
        let (status, _, body) = get(&router, &alice, &uri, &[]).await;
        assert_eq!(status, StatusCode::OK);
        let detail = json(&body);
        assert_eq!(detail["collection"]["name"], "Nebulae");
        assert_eq!(detail["images"].as_array().unwrap().len(), 1);
        assert!(detail["images"][0]["thumbnail"].is_null());

        let (status, _, _) = get(&router, &bob, &uri, &[]).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn publish_endpoints_round_trip() {
        let (state, _tmp, alice, bob, _img) = seeded().await;
        let collection = create_collection_core(
            &state.db,
            "alice",
            CreateCollectionInput {
                name: "Deep Sky".to_string(),
                description: None,
                visibility: None,
                template: None,
                tags: None,
            },
        )
        .unwrap();
        let router = crate::daemon::router(state.clone());
        let uri = format!("/api/collections/{}/publish", collection.id);

        // Unpublished: status 404.
        let (status, _, _) = get(&router, &alice, &uri, &[]).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // POST publish (empty body defaults to public).
        let resp = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri(&uri)
                    .header("Authorization", format!("Bearer {alice}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let record = json(&to_bytes(resp.into_body(), 1 << 20).await.unwrap());
        assert_eq!(record["slug"], "deep-sky");
        assert_eq!(record["visibility"], "public");

        let (status, _, body) = get(&router, &alice, &uri, &[]).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json(&body)["slug"], "deep-sky");

        // Bob can't see or delete alice's publish state.
        let (status, _, _) = get(&router, &bob, &uri, &[]).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let resp = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("DELETE")
                    .uri(&uri)
                    .header("Authorization", format!("Bearer {bob}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        // Owner unpublishes; status is gone.
        let resp = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("DELETE")
                    .uri(&uri)
                    .header("Authorization", format!("Bearer {alice}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        let (status, _, _) = get(&router, &alice, &uri, &[]).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn thumbnail_bytes_with_etag_and_304() {
        let (state, _tmp, alice, bob, img) = seeded().await;
        let router = crate::daemon::router(state.clone());
        let uri = format!("/api/images/{}/thumbnail", img.id);

        let (status, headers, body) = get(&router, &alice, &uri, &[]).await;
        assert_eq!(status, StatusCode::OK);
        assert!(!body.is_empty());
        assert!(headers
            .get(header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("image/"));
        assert_eq!(
            headers.get(header::CACHE_CONTROL).unwrap(),
            "private, max-age=3600"
        );
        let etag = headers.get(header::ETAG).unwrap().to_str().unwrap().to_string();
        assert!(etag.starts_with('"') && etag.ends_with('"'));

        // Conditional round trip: 304, no body, ETag repeated.
        let (status, headers, body) =
            get(&router, &alice, &uri, &[(header::IF_NONE_MATCH, &etag)]).await;
        assert_eq!(status, StatusCode::NOT_MODIFIED);
        assert!(body.is_empty());
        assert_eq!(headers.get(header::ETAG).unwrap().to_str().unwrap(), etag);

        // Preview resolves too (falls back to best available quality).
        let (status, _, body) = get(
            &router,
            &alice,
            &format!("/api/images/{}/preview", img.id),
            &[],
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(!body.is_empty());

        // Cross-user: bytes are invisible, like the row itself.
        let (status, _, _) = get(&router, &bob, &uri, &[]).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}
