//! Bare content-addressed blob route: public image bytes by hash.
//!
//! - `GET /blob/{blob_id}` — the preview variant (what the gallery's
//!   `images/` route serves).
//! - `GET /blob/{blob_id}/{quality}` — `thumbnail` or `preview`, mapped to
//!   HoardFS [`Quality`] exactly as `gallery_thumb` / `gallery_image` do.
//!   `original` is recognised but 404s: the gallery routes never serve
//!   originals publicly, and neither does this one.
//! - `GET /blob/{cid}` — the same, addressed by the CIDv1 (`raw`,
//!   sha2-256) of a rendition's bytes as a signed record's blob reference
//!   carries it (`share::records`). The CID names one rendition, so the
//!   quality is implied; `/blob/{cid}/{quality}` must agree or 404s.
//!
//! The gallery-scoped paths tie a blob's address to a publish record
//! (`/@{user}/{slug}/images/{file}`). This route gives the same bytes a
//! "dumb" address that any mirror or second host can serve at the same
//! relative path, and that signed records can reference purely by hash.
//! Responses carry the same blob-id ETag and `Cache-Control: public` as the
//! gallery assets (via [`variant_response`]).
//!
//! # Access model
//!
//! No `AuthedUser`; the gate is the publish state of the blob's image.
//! `blob_id` must resolve to an image row that is a member of at least one
//! collection with a `published_collections` row (public or unlisted) owned
//! by the image's owner — see `publish::published_image_for_blob`.
//! Otherwise 404, always: unknown id, malformed id, unpublished image, and
//! unknown quality all look identical from the outside, so the route cannot
//! be used to probe which hashes exist in someone's private library.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use hoardfs_core::Quality;

use super::api::variant_response;
use super::DaemonState;
use crate::commands::publish::published_image_for_blob;
use crate::db::models::Image;
use crate::db::tenancy;
use crate::share::records::lookup_blob_cid;

/// Quality segment of `/blob/{blob_id}/{quality}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BlobQuality {
    Thumbnail,
    Preview,
    /// Accepted by the grammar so the intent is explicit, but never served:
    /// the public gallery exposes only derived variants.
    Original,
}

impl BlobQuality {
    fn parse(segment: &str) -> Option<Self> {
        match segment {
            "thumbnail" => Some(Self::Thumbnail),
            "preview" => Some(Self::Preview),
            "original" => Some(Self::Original),
            _ => None,
        }
    }
}

/// Longest id we bother looking up: `blake3:` + 64 hex is 71 chars; this
/// leaves room for other hash prefixes without letting arbitrary junk hit
/// the database.
const MAX_BLOB_ID_LEN: usize = 128;

/// Cheap syntactic filter before the DB lookup. HoardFS ids are
/// `blake3:<hex>`; anything outside `[A-Za-z0-9:_-]` can never match a row.
fn plausible_blob_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_BLOB_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-'))
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}

/// `GET /blob/{blob_id}` — preview quality, same as the gallery `images/`
/// route.
pub async fn blob_default(
    state: State<Arc<DaemonState>>,
    Path(blob_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    serve_blob(state, blob_id, None, headers).await
}

/// `GET /blob/{blob_id}/{quality}`.
pub async fn blob_quality(
    state: State<Arc<DaemonState>>,
    Path((blob_id, quality)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let quality = match BlobQuality::parse(&quality) {
        Some(BlobQuality::Thumbnail) => Quality::Thumbnail,
        Some(BlobQuality::Preview) => Quality::Preview,
        // Originals are never public (matches the gallery routes).
        Some(BlobQuality::Original) | None => return not_found(),
    };
    serve_blob(state, blob_id, Some(quality), headers).await
}

/// Resolve the path id to a published image + the quality to serve.
/// A HoardFS blob id serves `requested` (default preview); a blob CID
/// serves the rendition it digests, provided `requested` (if any) agrees.
/// Blocking (diesel).
fn resolve_blob(
    conn: &mut diesel::SqliteConnection,
    id: &str,
    requested: Option<Quality>,
) -> Result<Option<(Image, Quality)>, String> {
    if let Some(image) = published_image_for_blob(conn, id)? {
        return Ok(Some((image, requested.unwrap_or(Quality::Preview))));
    }
    if id.parse::<ipld_core::cid::Cid>().is_ok() {
        for (blob_id, quality) in lookup_blob_cid(conn, id)? {
            if !requested.as_ref().is_none_or(|r| *r == quality) {
                continue;
            }
            if let Some(image) = published_image_for_blob(conn, &blob_id)? {
                return Ok(Some((image, quality)));
            }
        }
    }
    Ok(None)
}

async fn serve_blob(
    State(state): State<Arc<DaemonState>>,
    blob_id: String,
    requested: Option<Quality>,
    headers: HeaderMap,
) -> Response {
    if !plausible_blob_id(&blob_id) {
        return not_found();
    }

    let db = state.db.clone();
    let resolved = tokio::task::spawn_blocking(move || {
        let mut conn = db.get().map_err(|e| e.to_string())?;
        resolve_blob(&mut conn, &blob_id, requested)
    })
    .await;

    match resolved {
        Ok(Ok(Some((image, quality)))) => {
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
            log::error!("blob lookup: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            log::error!("blob lookup task: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::images::add_image_to_collection_core;
    use crate::commands::publish::{
        publish_collection_core, unpublish_collection_core, PublishVisibility,
    };
    use crate::daemon::gallery::tests::{fixture, get, tiny_png};
    use crate::db::schema::images as images_table;
    use axum::http::header;
    use diesel::prelude::*;
    use tower::ServiceExt;

    fn blob_id(f: &crate::daemon::gallery::tests::Fixture) -> String {
        images_table::table
            .find(&f.image.id)
            .select(images_table::blob_id)
            .first::<Option<String>>(&mut f.state.db.get().unwrap())
            .unwrap()
            .expect("fixture image has a blob id")
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn public_blob_matches_gallery_route_bytes_and_etag() {
        let f = fixture().await;
        let router = crate::daemon::router(f.state.clone());
        let id = blob_id(&f);

        let (status, gal_headers, gal_body) = get(
            &router,
            &format!("/@aliceh/andromeda-nights/images/{}.png", f.image.id),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let gal_etag = gal_headers.get(header::ETAG).unwrap().clone();

        // Default quality == the gallery `images/` (preview) route.
        let (status, headers, body) = get(&router, &format!("/blob/{id}")).await;
        assert_eq!(status, StatusCode::OK);
        assert!(!body.is_empty());
        assert_eq!(body, gal_body);
        assert_eq!(headers.get(header::ETAG).unwrap(), &gal_etag);
        assert_eq!(
            headers.get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=3600"
        );
        assert_eq!(
            headers.get(header::CONTENT_TYPE).unwrap(),
            gal_headers.get(header::CONTENT_TYPE).unwrap()
        );

        // Explicit `preview` is the same thing.
        let (status, headers, body) = get(&router, &format!("/blob/{id}/preview")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, gal_body);
        assert_eq!(headers.get(header::ETAG).unwrap(), &gal_etag);

        // `thumbnail` == the gallery `thumbs/` route.
        let (status, _, thumb_gal) = get(
            &router,
            &format!("/@aliceh/andromeda-nights/thumbs/{}.jpg", f.image.id),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, _, thumb_blob) = get(&router, &format!("/blob/{id}/thumbnail")).await;
        assert_eq!(status, StatusCode::OK);
        assert!(!thumb_blob.is_empty());
        // (For a 40x40 source HoardFS serves the same bytes at both
        // qualities — parity with the gallery route is the contract here.)
        assert_eq!(thumb_blob, thumb_gal);

        // Conditional request honours the ETag like the gallery route does.
        let resp = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri(format!("/blob/{id}"))
                    .header(header::IF_NONE_MATCH, &gal_etag)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_MODIFIED);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn blob_of_unlisted_collection_is_served() {
        let f = fixture().await;
        let router = crate::daemon::router(f.state.clone());
        let id = blob_id(&f);

        // Move the image out of the public gallery into the unlisted one:
        // drop the public publish record and add the image to "Drafts".
        assert!(unpublish_collection_core(&f.state.db, "alice", &f.public_collection.id).unwrap());
        add_image_to_collection_core(&f.state.db, "alice", &f.image.id, &f.unlisted_collection.id)
            .unwrap();

        let (status, headers, body) = get(&router, &format!("/blob/{id}")).await;
        assert_eq!(status, StatusCode::OK);
        assert!(!body.is_empty());
        assert_eq!(
            headers.get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=3600"
        );
        let (status, _, _) = get(&router, &format!("/blob/{id}/thumbnail")).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn blob_404s_after_unpublish() {
        let f = fixture().await;
        let router = crate::daemon::router(f.state.clone());
        let id = blob_id(&f);

        let (status, _, _) = get(&router, &format!("/blob/{id}")).await;
        assert_eq!(status, StatusCode::OK);

        assert!(unpublish_collection_core(&f.state.db, "alice", &f.public_collection.id).unwrap());

        let (status, _, _) = get(&router, &format!("/blob/{id}")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _, _) = get(&router, &format!("/blob/{id}/preview")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _, _) = get(&router, &format!("/blob/{id}/thumbnail")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // Republish → served again (the gate is live, not cached).
        publish_collection_core(
            &f.state.db,
            "alice",
            &f.public_collection.id,
            PublishVisibility::Public,
            None,
        )
        .unwrap();
        let (status, _, _) = get(&router, &format!("/blob/{id}")).await;
        assert_eq!(status, StatusCode::OK);
    }

    /// A real HoardFS blob whose image sits only in a private collection
    /// 404s; publishing that collection is the positive control proving the
    /// 404 came from the gate and not from a missing variant.
    #[tokio::test(flavor = "multi_thread")]
    async fn blob_in_no_published_collection_404s() {
        let f = fixture().await;
        let router = crate::daemon::router(f.state.clone());

        // Distinct bytes → distinct blob id from the fixture's public image.
        let mut png = tiny_png();
        png.extend_from_slice(b"private");
        // Same discipline as the daemon: never hold the HoardFS lock across
        // an await point.
        let private_blob = tokio::task::block_in_place(|| {
            let hfs = f.state.hoardfs.lock().unwrap();
            tokio::runtime::Handle::current()
                .block_on(hfs.put_file("user-alice", "/g/secret.png", &png))
                .unwrap();
            hfs.get_file_info("user-alice", "/g/secret.png")
                .unwrap()
                .current_version
                .blob_id
        });
        diesel::update(images_table::table.find(&f.private_image.id))
            .set((
                images_table::blob_id.eq(Some(private_blob.clone())),
                images_table::metadata.eq(Some(
                    serde_json::json!({ "hoardfs": { "hfs_path": "/g/secret.png" } }).to_string(),
                )),
            ))
            .execute(&mut f.state.db.get().unwrap())
            .unwrap();

        let (status, _, _) = get(&router, &format!("/blob/{private_blob}")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _, _) = get(&router, &format!("/blob/{private_blob}/thumbnail")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // Positive control: publish "Secret" and the same URL serves.
        publish_collection_core(
            &f.state.db,
            "alice",
            &f.private_collection.id,
            PublishVisibility::Unlisted,
            None,
        )
        .unwrap();
        let (status, _, body) = get(&router, &format!("/blob/{private_blob}")).await;
        assert_eq!(status, StatusCode::OK);
        assert!(!body.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn unknown_or_malformed_blob_id_404s() {
        let f = fixture().await;
        let router = crate::daemon::router(f.state.clone());

        // Well-formed but unknown.
        let unknown = format!("blake3:{}", "0".repeat(64));
        let (status, _, _) = get(&router, &format!("/blob/{unknown}")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _, _) = get(&router, &format!("/blob/{unknown}/preview")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // Malformed: wrong charset, oversized, image id instead of hash.
        for bad in [
            "not%20a%20blob".to_string(),
            "blake3:zz!!".to_string(),
            "a".repeat(MAX_BLOB_ID_LEN + 1),
            f.image.id.clone(),
        ] {
            let (status, _, _) = get(&router, &format!("/blob/{bad}")).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{bad}");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bad_quality_segment_404s_including_original() {
        let f = fixture().await;
        let router = crate::daemon::router(f.state.clone());
        let id = blob_id(&f);

        // Sanity: the blob itself is public.
        let (status, _, _) = get(&router, &format!("/blob/{id}")).await;
        assert_eq!(status, StatusCode::OK);

        // Originals are never served publicly (mirrors the gallery routes).
        let (status, _, _) = get(&router, &format!("/blob/{id}/original")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        for bad in ["huge", "Preview", "thumb", "raw", "full", ""] {
            let (status, _, _) = get(&router, &format!("/blob/{id}/{bad}")).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "quality {bad:?}");
        }
        // Extra trailing segments don't match any route.
        let (status, _, _) = get(&router, &format!("/blob/{id}/preview/extra")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    /// `/blob/...` must win over the `/{user}` / `/{user}/{slug}` captures.
    /// The gallery handlers 404 anything without a leading `@`, so a 200
    /// here can only have come from the blob handlers.
    #[tokio::test(flavor = "multi_thread")]
    async fn blob_route_is_not_captured_by_user_catch_all() {
        let f = fixture().await;
        let router = crate::daemon::router(f.state.clone());
        let id = blob_id(&f);

        // Two segments: `/blob/{id}` vs `/{user}/{slug}`.
        let (status, headers, _) = get(&router, &format!("/blob/{id}")).await;
        assert_eq!(status, StatusCode::OK);
        assert!(headers.get(header::ETAG).is_some());
        // Three segments: `/blob/{id}/{quality}` vs nothing the gallery
        // offers with a variable last segment.
        let (status, _, _) = get(&router, &format!("/blob/{id}/thumbnail")).await;
        assert_eq!(status, StatusCode::OK);

        // And the gallery routes keep working next to it.
        let (status, _, _) = get(&router, "/@aliceh/andromeda-nights").await;
        assert_eq!(status, StatusCode::OK);
        let (status, _, _) = get(&router, "/@aliceh").await;
        assert_eq!(status, StatusCode::OK);
        // A profile literally named "blob" is unreachable without the `@`,
        // which the gallery requires anyway.
        let (status, _, _) = get(&router, "/blob").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}
