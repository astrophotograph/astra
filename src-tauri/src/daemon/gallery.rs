//! Public gallery pages, served live from the daemon.
//!
//! - `GET /@{username}/{slug}` — the embedded Preact viewer with an injected
//!   `<base>` tag (the viewer fetches `manifest.json` and image paths
//!   relatively).
//! - `GET /@{username}/{slug}/manifest.json` — built live from the publish
//!   record + image rows, so a published gallery updates the moment the
//!   library does (the viewer polls every 30s).
//! - `GET /@{username}/{slug}/images/{file}` + `/thumbs/{file}` — HoardFS
//!   variant bytes with `Cache-Control: public` (the hot artifacts
//!   Cloudflare caches at the edge) and blob-id ETags.
//! - `GET /@{username}` — minimal profile page listing public galleries.
//!
//! # Access model
//!
//! These routes bypass `AuthedUser`, gated instead by publish-record
//! resolution: no `published_collections` row → 404, always. Unlisted
//! galleries resolve only at their exact slug and never appear on the
//! profile page. Nothing here ever reads a collection or image that the
//! resolved record doesn't own — probing ids of unpublished content 404s.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use diesel::prelude::*;
use hoardfs_core::Quality;

use super::api::variant_response;
use super::DaemonState;
use crate::commands::publish::{
    list_public_for_user_core, resolve_public_collection, user_id_for_username,
};
use crate::db::models::{Collection, Image, PublishedCollection};
use crate::db::schema::published_collections;
use crate::db::{repository, tenancy, DbPool};
use crate::share::{manifest, viewer};

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}

/// `/{user}` path params carry the leading `@`; anything else 404s.
fn handle_from_path(user: &str) -> Option<&str> {
    user.strip_prefix('@').filter(|h| !h.is_empty())
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Resolve a public gallery or 404. Blocking (diesel).
fn resolve(
    db: &DbPool,
    handle: &str,
    slug: &str,
) -> Result<Option<(PublishedCollection, Collection)>, String> {
    resolve_public_collection(db, handle, slug)
}

pub async fn profile_page(
    State(state): State<Arc<DaemonState>>,
    Path(user): Path<String>,
) -> Response {
    let Some(handle) = handle_from_path(&user).map(str::to_string) else {
        return not_found();
    };

    let db = state.db.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let mut conn = db.get().map_err(|e| e.to_string())?;
        let Some(owner_id) = user_id_for_username(&mut conn, &handle)? else {
            return Ok(None);
        };
        drop(conn);
        let galleries = list_public_for_user_core(&db, &handle)?;
        Ok(Some((handle, owner_id, galleries)))
    })
    .await;

    match result {
        Ok(Ok(Some((handle, owner_id, galleries)))) => {
            let items: String = galleries
                .iter()
                .map(|g| {
                    format!(
                        r#"<li><a href="/@{handle}/{slug}">{title}</a></li>"#,
                        handle = html_escape(&handle),
                        slug = html_escape(&g.slug),
                        title = html_escape(&g.title),
                    )
                })
                .collect();
            let body = format!(
                "<!doctype html><html><head><meta charset=\"utf-8\">\
                 <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
                 <title>@{h} — Astra Gallery</title>\
                 <style>body{{font-family:system-ui;background:#0b1020;color:#e6e8f0;\
                 max-width:640px;margin:4rem auto;padding:0 1rem}}a{{color:#8ab4ff}}\
                 li{{margin:.5rem 0}}</style></head>\
                 <body><h1>@{h}</h1>{widget}{list}</body></html>",
                h = html_escape(&handle),
                widget = super::social_widgets::embed(&owner_id, &handle),
                list = if items.is_empty() {
                    "<p>No public galleries yet.</p>".to_string()
                } else {
                    format!("<ul>{items}</ul>")
                },
            );
            let mut response = Html(body).into_response();
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                header::HeaderValue::from_static("public, max-age=60"),
            );
            response
        }
        Ok(Ok(None)) => not_found(),
        Ok(Err(e)) => {
            log::error!("profile page: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            log::error!("profile page task: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn gallery_page(
    State(state): State<Arc<DaemonState>>,
    Path((user, slug)): Path<(String, String)>,
) -> Response {
    let Some(handle) = handle_from_path(&user).map(str::to_string) else {
        return not_found();
    };

    let db = state.db.clone();
    let slug_owned = slug.clone();
    let resolved = tokio::task::spawn_blocking(move || {
        let hit = resolve(&db, &handle, &slug_owned)?;
        if let Some((record, _)) = &hit {
            // Best-effort view counter; never fails the page.
            if let Ok(mut conn) = db.get() {
                let _ = diesel::update(published_collections::table.find(&record.id))
                    .set(
                        published_collections::view_count
                            .eq(published_collections::view_count + 1),
                    )
                    .execute(&mut conn);
            }
        }
        Ok::<_, String>(hit)
    })
    .await;

    match resolved {
        Ok(Ok(Some((record, collection)))) => {
            let viewer_html = match collection.template.as_deref() {
                Some("messier") | Some("caldwell") => viewer::CATALOG_VIEWER_HTML,
                _ => viewer::VIEWER_HTML,
            };
            // The viewer fetches manifest.json and image paths relatively;
            // anchor them regardless of a trailing slash in the request URL.
            let base = format!(
                "<head><base href=\"/@{}/{}/\">",
                html_escape(&user[1..]),
                html_escape(&record.slug)
            );
            let body = viewer_html.replacen("<head>", &base, 1);
            // Follow widget + bell for the publisher, floated over the
            // viewer chrome. Identical markup for every viewer — per-viewer
            // state hydrates client-side, so the cache headers stay valid.
            let snippet = super::social_widgets::embed_floating(&record.user_id, &user[1..]);
            let body = if body.contains("</body>") {
                body.replacen("</body>", &format!("{snippet}</body>"), 1)
            } else {
                body + &snippet
            };
            let mut response = Html(body).into_response();
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                header::HeaderValue::from_static("public, max-age=300"),
            );
            response
        }
        Ok(Ok(None)) => not_found(),
        Ok(Err(e)) => {
            log::error!("gallery page: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            log::error!("gallery page task: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn gallery_manifest(
    State(state): State<Arc<DaemonState>>,
    Path((user, slug)): Path<(String, String)>,
) -> Response {
    let Some(handle) = handle_from_path(&user).map(str::to_string) else {
        return not_found();
    };

    let db = state.db.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let Some((_, collection)) = resolve(&db, &handle, &slug)? else {
            return Ok(None);
        };
        let mut conn = db.get().map_err(|e| e.to_string())?;
        let images = repository::get_images_in_collection(&mut conn, &collection.id)
            .map_err(|e| e.to_string())?;
        Ok(Some(manifest::build_manifest_for_collection(
            &collection,
            &images,
        )))
    })
    .await;

    match result {
        Ok(Ok(Some(manifest))) => {
            let mut response = axum::Json(manifest).into_response();
            // Short: the viewer polls for live updates every 30s.
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                header::HeaderValue::from_static("public, max-age=10"),
            );
            response
        }
        Ok(Ok(None)) => not_found(),
        Ok(Err(e)) => {
            log::error!("gallery manifest: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            log::error!("gallery manifest task: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn gallery_image(
    state: State<Arc<DaemonState>>,
    path: Path<(String, String, String)>,
    headers: HeaderMap,
) -> Response {
    serve_gallery_asset(state, path, headers, Quality::Preview).await
}

pub async fn gallery_thumb(
    state: State<Arc<DaemonState>>,
    path: Path<(String, String, String)>,
    headers: HeaderMap,
) -> Response {
    serve_gallery_asset(state, path, headers, Quality::Thumbnail).await
}

/// `{file}` is `{image_id}.{ext}` per the manifest paths. The image must be
/// owned by the gallery's owner AND be a member of the published collection
/// — an id from someone's unpublished library 404s.
async fn serve_gallery_asset(
    State(state): State<Arc<DaemonState>>,
    Path((user, slug, file)): Path<(String, String, String)>,
    headers: HeaderMap,
    quality: Quality,
) -> Response {
    let Some(handle) = handle_from_path(&user).map(str::to_string) else {
        return not_found();
    };
    let image_id = file
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(&file)
        .to_string();

    let db = state.db.clone();
    let resolved = tokio::task::spawn_blocking(move || -> Result<Option<Image>, String> {
        let Some((record, collection)) = resolve(&db, &handle, &slug)? else {
            return Ok(None);
        };
        let mut conn = db.get().map_err(|e| e.to_string())?;
        let in_collection =
            repository::is_image_in_collection(&mut conn, &collection.id, &image_id)
                .map_err(|e| e.to_string())?;
        if !in_collection {
            return Ok(None);
        }
        let image = repository::get_image_by_id(&mut conn, &image_id)
            .map_err(|e| e.to_string())?;
        Ok(image.filter(|i| i.user_id == record.user_id))
    })
    .await;

    match resolved {
        Ok(Ok(Some(image))) => {
            let volume = tenancy::volume_name(&image.user_id);
            variant_response(
                state,
                image,
                volume,
                quality,
                &headers,
                "public, max-age=3600",
            )
            .await
        }
        Ok(Ok(None)) => not_found(),
        Ok(Err(e)) => {
            log::error!("gallery asset: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            log::error!("gallery asset task: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::collections::{create_collection_core, CreateCollectionInput};
    use crate::commands::images::{
        add_image_to_collection_core, create_image_core, CreateImageInput,
    };
    use crate::commands::publish::{publish_collection_core, PublishVisibility};
    use crate::db::schema::{images as images_table, users};
    use crate::db::test_support::{insert_user, test_pool};
    use axum::body::to_bytes;
    use std::sync::Mutex;
    use tower::ServiceExt;

    fn tiny_png() -> Vec<u8> {
        let img = image::RgbImage::from_pixel(40, 40, image::Rgb([250, 180, 40]));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }

    struct Fixture {
        state: Arc<DaemonState>,
        _tmp: tempfile::TempDir,
        public_collection: Collection,
        unlisted_collection: Collection,
        private_collection: Collection,
        image: Image,
        private_image: Image,
    }

    /// alice (@aliceh) with a public, an unlisted, and a private collection;
    /// one HoardFS-backed image in the public one, one image kept private.
    async fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let db = test_pool();
        insert_user(&db, "alice");
        diesel::update(users::table.find("alice"))
            .set(users::username.eq(Some("aliceh")))
            .execute(&mut db.get().unwrap())
            .unwrap();

        let mut hfs = hoardfs_volume::HoardFs::init(&tmp.path().join("hoardfs"))
            .await
            .unwrap();
        hfs.set_variant_pipeline(hoardfs_variant::VariantPipeline::new().with_image_generator());
        tenancy::ensure_user_volume(&hfs, "alice").unwrap();
        hfs.put_file("user-alice", "/g/m31.png", &tiny_png()).await.unwrap();
        let blob_id = hfs
            .get_file_info("user-alice", "/g/m31.png")
            .unwrap()
            .current_version
            .blob_id;

        let mk_collection = |name: &str| {
            create_collection_core(
                &db,
                "alice",
                CreateCollectionInput {
                    name: name.to_string(),
                    description: Some("desc".to_string()),
                    visibility: None,
                    template: None,
                    tags: None,
                },
            )
            .unwrap()
        };
        let public_collection = mk_collection("Andromeda Nights");
        let unlisted_collection = mk_collection("Drafts");
        let private_collection = mk_collection("Secret");

        let mk_image = |filename: &str, summary: &str, metadata: Option<String>| {
            create_image_core(
                &db,
                "alice",
                CreateImageInput {
                    collection_id: None,
                    filename: filename.to_string(),
                    url: None,
                    summary: Some(summary.to_string()),
                    description: None,
                    content_type: Some("image/png".to_string()),
                    tags: None,
                    visibility: None,
                    location: None,
                    annotations: Some(
                        r#"[{"name":"M 31","ra":10.68,"dec":41.27,"magnitude":3.4}]"#.to_string(),
                    ),
                    metadata,
                    thumbnail: None,
                },
            )
            .unwrap()
        };
        let image = mk_image(
            "m31.png",
            "Messier 31",
            Some(
                serde_json::json!({
                    "hoardfs": { "hfs_path": "/g/m31.png" },
                    "plate_solve": {
                        "center_ra": 10.68, "center_dec": 41.27, "pixel_scale": 1.2,
                        "rotation": 0.0, "width_deg": 3.0, "height_deg": 2.0
                    }
                })
                .to_string(),
            ),
        );
        diesel::update(images_table::table.find(&image.id))
            .set(images_table::blob_id.eq(Some(blob_id)))
            .execute(&mut db.get().unwrap())
            .unwrap();
        let private_image = mk_image("secret.png", "M 51", None);

        add_image_to_collection_core(&db, "alice", &image.id, &public_collection.id).unwrap();
        add_image_to_collection_core(&db, "alice", &private_image.id, &private_collection.id)
            .unwrap();

        publish_collection_core(
            &db,
            "alice",
            &public_collection.id,
            PublishVisibility::Public,
            None,
        )
        .unwrap();
        publish_collection_core(
            &db,
            "alice",
            &unlisted_collection.id,
            PublishVisibility::Unlisted,
            None,
        )
        .unwrap();

        let state = Arc::new(DaemonState {
            db,
            hoardfs: Arc::new(Mutex::new(hfs)),
            oidc: None,
            limits: Default::default(),
            session_key: [7u8; 32],
        });
        Fixture {
            state,
            _tmp: tmp,
            public_collection,
            unlisted_collection,
            private_collection,
            image,
            private_image,
        }
    }

    async fn get(router: &axum::Router, uri: &str) -> (StatusCode, HeaderMap, Vec<u8>) {
        let resp = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri(uri)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = resp.status();
        let headers = resp.headers().clone();
        let body = to_bytes(resp.into_body(), 16 << 20).await.unwrap().to_vec();
        (status, headers, body)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn access_matrix_no_enumeration_of_unpublished_content() {
        let f = fixture().await;
        let router = crate::daemon::router(f.state.clone());

        // Public gallery resolves; unlisted resolves at its exact slug.
        let (status, _, _) = get(&router, "/@aliceh/andromeda-nights").await;
        assert_eq!(status, StatusCode::OK);
        let (status, _, _) = get(&router, "/@aliceh/drafts").await;
        assert_eq!(status, StatusCode::OK);

        // Private collection: 404 by slugified name, by id, everywhere.
        let (status, _, _) = get(&router, "/@aliceh/secret").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let by_id = format!("/@aliceh/{}", f.private_collection.id);
        let (status, _, _) = get(&router, &by_id).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _, _) = get(
            &router,
            &format!("/@aliceh/{}/manifest.json", f.private_collection.id),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // A private image id probed through a *published* gallery 404s
        // (membership gate), and unknown users/slugs 404.
        let (status, _, _) = get(
            &router,
            &format!(
                "/@aliceh/andromeda-nights/images/{}.png",
                f.private_image.id
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _, _) = get(&router, "/@ghost/anything").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _, _) = get(&router, "/@aliceh/wrong-slug").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        // No leading @ → not a profile route.
        let (status, _, _) = get(&router, "/aliceh").await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // Profile lists ONLY the public gallery.
        let (status, _, body) = get(&router, "/@aliceh").await;
        assert_eq!(status, StatusCode::OK);
        let html = String::from_utf8(body).unwrap();
        assert!(html.contains("andromeda-nights"));
        assert!(!html.contains("drafts"), "unlisted must not be listed");
        assert!(!html.contains("secret"));
        let _ = &f.unlisted_collection;
    }

    /// Both public page kinds embed the follow widget targeting the owner —
    /// identical markup for every viewer (the pages are publicly cached; all
    /// per-viewer state hydrates client-side).
    #[tokio::test(flavor = "multi_thread")]
    async fn pages_embed_the_follow_widget() {
        let f = fixture().await;
        let router = crate::daemon::router(f.state.clone());

        // Profile page: inline widget with the owner's id + handle.
        let (status, _, body) = get(&router, "/@aliceh").await;
        assert_eq!(status, StatusCode::OK);
        let html = String::from_utf8(body).unwrap();
        assert!(html.contains(r#"class="follow-widget""#));
        assert!(html.contains(r#"data-target-id="alice""#));
        assert!(html.contains(r#"data-handle="aliceh""#));

        // Gallery page: floating variant injected into the viewer document.
        let (status, _, body) = get(&router, "/@aliceh/andromeda-nights/").await;
        assert_eq!(status, StatusCode::OK);
        let html = String::from_utf8(body).unwrap();
        assert!(html.contains(r#"class="follow-widget floating""#));
        assert!(html.contains(r#"data-target-id="alice""#));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn manifest_is_live_and_correct() {
        let f = fixture().await;
        let router = crate::daemon::router(f.state.clone());

        let (status, headers, body) =
            get(&router, "/@aliceh/andromeda-nights/manifest.json").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers.get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=10"
        );
        let manifest: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(manifest["collectionName"], "Andromeda Nights");
        assert_eq!(manifest["imageCount"], 1);
        let img = &manifest["images"][0];
        assert_eq!(img["imagePath"], format!("images/{}.png", f.image.id));
        assert_eq!(img["thumbPath"], format!("thumbs/{}.jpg", f.image.id));
        assert_eq!(img["catalogIds"][0], "M31");
        assert!((img["plateSolve"]["centerRa"].as_f64().unwrap() - 10.68).abs() < 1e-9);
        assert_eq!(img["objects"][0]["name"], "M 31");

        // Live: edit the summary, manifest reflects it immediately.
        diesel::update(images_table::table.find(&f.image.id))
            .set(images_table::summary.eq(Some("Andromeda Galaxy")))
            .execute(&mut f.state.db.get().unwrap())
            .unwrap();
        let (_, _, body) = get(&router, "/@aliceh/andromeda-nights/manifest.json").await;
        let manifest: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(manifest["images"][0]["summary"], "Andromeda Galaxy");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn viewer_page_and_public_assets_with_cache_headers() {
        let f = fixture().await;
        let router = crate::daemon::router(f.state.clone());

        // Viewer HTML with the injected base tag.
        let (status, headers, body) = get(&router, "/@aliceh/andromeda-nights").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers.get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=300"
        );
        let html = String::from_utf8(body).unwrap();
        assert!(html.contains(r#"<base href="/@aliceh/andromeda-nights/">"#));

        // Image + thumb bytes, public cache, blob ETag, conditional 304.
        let image_uri = format!("/@aliceh/andromeda-nights/images/{}.png", f.image.id);
        let (status, headers, body) = get(&router, &image_uri).await;
        assert_eq!(status, StatusCode::OK);
        assert!(!body.is_empty());
        assert_eq!(
            headers.get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=3600"
        );
        let etag = headers.get(header::ETAG).unwrap().to_str().unwrap().to_string();
        assert!(etag.contains("blake3:"));

        let resp = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri(&image_uri)
                    .header(header::IF_NONE_MATCH, &etag)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_MODIFIED);

        let (status, _, body) = get(
            &router,
            &format!("/@aliceh/andromeda-nights/thumbs/{}.jpg", f.image.id),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(!body.is_empty());

        // View counter ticked for the page hit above.
        let count: i32 = published_collections::table
            .filter(published_collections::collection_id.eq(&f.public_collection.id))
            .select(published_collections::view_count)
            .first(&mut f.state.db.get().unwrap())
            .unwrap();
        assert!(count >= 1);
    }
}
