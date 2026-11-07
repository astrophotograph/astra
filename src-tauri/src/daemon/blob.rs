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
//! # Digest freshness (CID requests only)
//!
//! A CID promises bytes with that hash, but `blob_digests` is a cache and
//! processing can regenerate a rendition under it. Before a CID hit is
//! served, [`verify_blob_digest`] checks that the row still names the
//! variant blob HoardFS currently lists for that quality (a metadata
//! query, no hashing). If not, the bytes are hashed once and the row
//! replaced; when the hash changed the old CID 404s, and the published
//! collections containing the image are re-signed so their records carry
//! the new CID ([`resign_for_blob`]). Requests by HoardFS blob id skip all
//! of this: they name the source, not the rendition bytes.
//!
//! # Access model
//!
//! No `AuthedUser`; the gate is the publish state of the blob's image.
//! `blob_id` must resolve to an image row that is a member of at least one
//! collection with a `published_collections` row owned by the image's
//! owner — see `publish::published_image_for_blob`. Public or unlisted →
//! served to anyone (the hash is the capability, like the unlisted URL).
//! Only circle collections → served to a viewer ([`MaybeViewer`]) the
//! kith ACL admits for any of them (`acl.rs`), as `private, no-store`.
//! Otherwise 404, always: unknown id, malformed id, unpublished image,
//! circle denial and unknown quality all look identical from the outside,
//! so the route cannot be used to probe which hashes exist in someone's
//! private library.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use hoardfs_core::Quality;

use super::acl;
use super::api::variant_response;
use super::auth::MaybeViewer;
use super::DaemonState;
use crate::commands::hoardfs::resolve_hfs_path;
use crate::commands::publish::{published_image_for_blob, Access};
use crate::db::models::Image;
use crate::db::tenancy;
use crate::share::records::{
    lookup_blob_cid_rows, resign_for_blob, verify_blob_digest, DigestCheck,
};

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
    viewer: MaybeViewer,
) -> Response {
    serve_blob(state, blob_id, None, headers, viewer).await
}

/// `GET /blob/{blob_id}/{quality}`.
pub async fn blob_quality(
    state: State<Arc<DaemonState>>,
    Path((blob_id, quality)): Path<(String, String)>,
    headers: HeaderMap,
    viewer: MaybeViewer,
) -> Response {
    let quality = match BlobQuality::parse(&quality) {
        Some(BlobQuality::Thumbnail) => Quality::Thumbnail,
        Some(BlobQuality::Preview) => Quality::Preview,
        // Originals are never public (matches the gallery routes).
        Some(BlobQuality::Original) | None => return not_found(),
    };
    serve_blob(state, blob_id, Some(quality), headers, viewer).await
}

/// Resolve the path id to a published image + the quality to serve + the
/// access rule the caller must still check. A HoardFS blob id serves
/// `requested` (default preview); a blob CID serves the rendition it
/// digests, provided `requested` (if any) agrees and the digest is still
/// that of the bytes HoardFS holds (see the module docs). A stale hit is
/// refreshed and skipped; the blob ids whose digests went stale come back
/// alongside so the caller can re-sign once `conn` is released (the pool
/// may be a single connection). Blocking (diesel + HoardFS); runs inside
/// the runtime so HoardFS calls can be driven with `block_on`.
type ResolvedBlob = (Option<(Image, Quality, Access)>, Vec<String>);

fn resolve_blob(
    state: &DaemonState,
    conn: &mut diesel::SqliteConnection,
    id: &str,
    requested: Option<Quality>,
) -> Result<ResolvedBlob, String> {
    if let Some((image, access)) = published_image_for_blob(conn, id)? {
        return Ok((
            Some((image, requested.unwrap_or(Quality::Preview), access)),
            Vec::new(),
        ));
    }
    if id.parse::<ipld_core::cid::Cid>().is_err() {
        return Ok((None, Vec::new()));
    }
    let rt = tokio::runtime::Handle::current();
    let mut found = None;
    let mut stale_blobs: Vec<String> = Vec::new();
    for (row, quality) in lookup_blob_cid_rows(conn, id)? {
        if !requested.as_ref().is_none_or(|r| *r == quality) {
            continue;
        }
        // Unpublished blobs are never touched (no I/O, no probing signal).
        let Some((image, access)) = published_image_for_blob(conn, &row.blob_id)? else {
            continue;
        };
        let Some(hfs_path) = resolve_hfs_path(&image) else {
            continue;
        };
        let volume = tenancy::volume_name(&image.user_id);
        match verify_blob_digest(
            conn,
            &state.hoardfs,
            &rt,
            &volume,
            &hfs_path,
            &row,
            &quality,
        )? {
            DigestCheck::Fresh => {
                found = Some((image, quality, access));
                break;
            }
            DigestCheck::Stale { new_cid } => {
                log::info!(
                    "blob {id} ({}, {}) is stale: bytes now digest to {new_cid}",
                    row.blob_id,
                    row.quality
                );
                if !stale_blobs.contains(&row.blob_id) {
                    stale_blobs.push(row.blob_id.clone());
                }
            }
        }
    }
    Ok((found, stale_blobs))
}

/// Records referencing a stale CID follow the bytes right away, so the
/// next bundle fetch carries the CID that now serves. Best-effort.
fn resign_stale(state: &DaemonState, stale_blobs: Vec<String>) {
    for blob_id in stale_blobs {
        if let Err(e) = resign_for_blob(
            &state.db,
            &state.hoardfs,
            state.signer.as_deref(),
            &blob_id,
            "stale digest served by CID",
        ) {
            log::warn!("re-sign after stale blob digest on {blob_id} failed: {e}");
        }
    }
}

async fn serve_blob(
    State(state): State<Arc<DaemonState>>,
    blob_id: String,
    requested: Option<Quality>,
    headers: HeaderMap,
    viewer: MaybeViewer,
) -> Response {
    if !plausible_blob_id(&blob_id) {
        return not_found();
    }

    let state_for_lookup = state.clone();
    let resolved = tokio::task::spawn_blocking(move || {
        let mut conn = state_for_lookup.db.get().map_err(|e| e.to_string())?;
        let (found, stale) = resolve_blob(&state_for_lookup, &mut conn, &blob_id, requested)?;
        drop(conn);
        resign_stale(&state_for_lookup, stale);
        Ok::<_, String>(found)
    })
    .await;

    match resolved {
        Ok(Ok(Some((image, quality, access)))) => {
            match acl::allowed(&state, &access, viewer.0.as_ref()).await {
                Ok(true) => {}
                Ok(false) => return not_found(),
                Err(e) => {
                    log::error!("blob acl: {e}");
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            }
            let volume = tenancy::volume_name(&image.user_id);
            let cache = if access.is_public() {
                "public, max-age=3600"
            } else {
                acl::PRIVATE_CACHE_CONTROL
            };
            let mut response =
                variant_response(state, image, volume, quality, &headers, cache, false).await;
            acl::mark_if_gated(&mut response, &access);
            response
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

    // --- digest freshness (share::records) ---

    fn sha256_of(bytes: &[u8]) -> [u8; 32] {
        use sha2::Digest;
        sha2::Sha256::digest(bytes).into()
    }

    /// `(preview CID, thumbnail CID)` the stored image record carries.
    fn published_cids(f: &crate::daemon::gallery::tests::Fixture) -> (String, String) {
        use crate::daemon::records::tests::image_rkey;
        let rkey = image_rkey(f);
        let row = crate::share::records::stored_record(
            &mut f.state.db.get().unwrap(),
            "alice",
            crate::share::records::IMAGE_NSID,
            &rkey,
        )
        .unwrap()
        .expect("image record stored");
        let v: serde_json::Value = serde_json::from_str(&row.signed_json).unwrap();
        let link = |q: &str| {
            v.pointer(&format!("/record/{q}/ref/$link"))
                .and_then(|l| l.as_str())
                .unwrap()
                .to_string()
        };
        (link("preview"), link("thumbnail"))
    }

    fn digest_rows(
        f: &crate::daemon::gallery::tests::Fixture,
    ) -> Vec<crate::db::models::BlobDigest> {
        use crate::db::schema::blob_digests;
        blob_digests::table
            .filter(blob_digests::blob_id.eq(&f.blob_id))
            .order(blob_digests::quality.asc())
            .load(&mut f.state.db.get().unwrap())
            .unwrap()
    }

    fn variant_blob(f: &crate::daemon::gallery::tests::Fixture, quality: Quality) -> String {
        f.state
            .hoardfs
            .lock()
            .unwrap()
            .list_variants("user-alice", "/g/m31.png")
            .unwrap()
            .into_iter()
            .find(|v| v.quality == quality)
            .map(|v| v.variant_blob_id)
            .expect("variant exists")
    }

    /// Rewrite both renditions directly in HoardFS, bypassing every hook.
    fn tamper(f: &crate::daemon::gallery::tests::Fixture, preview: &[u8], thumb: &[u8]) {
        tokio::task::block_in_place(|| {
            let hfs = f.state.hoardfs.lock().unwrap();
            let rt = tokio::runtime::Handle::current();
            rt.block_on(hfs.add_variant(
                "user-alice",
                "/g/m31.png",
                Quality::Preview,
                preview,
                "image/jpeg",
            ))
            .unwrap();
            rt.block_on(hfs.add_variant(
                "user-alice",
                "/g/m31.png",
                Quality::Thumbnail,
                thumb,
                "image/jpeg",
            ))
            .unwrap();
        });
    }

    /// Variant bytes changed behind the daemon's back: the next CID request
    /// 404s, the digest rows are refreshed to the new bytes, and the signed
    /// records now reference (and serve) the new CIDs.
    #[tokio::test(flavor = "multi_thread")]
    async fn stale_cid_404s_refreshes_digest_and_resigns() {
        use crate::daemon::records::tests::{link_did, sign_publish};
        let f = fixture().await;
        link_did(&f);
        sign_publish(&f, &f.public_collection.id).await.unwrap();
        let router = crate::daemon::router(f.state.clone());
        let (old_preview, old_thumb) = published_cids(&f);

        // Fresh digest: served, and the bytes hash to the CID.
        let (status, _, body) = get(&router, &format!("/blob/{old_preview}/preview")).await;
        assert_eq!(status, StatusCode::OK);
        let cid: ipld_core::cid::Cid = old_preview.parse().unwrap();
        assert_eq!(cid.hash().digest(), &sha256_of(&body)[..]);
        // The 40x40 fixture source gets no renditions: HoardFS serves the
        // original at both qualities, so that is the identity recorded.
        let rows = digest_rows(&f);
        assert_eq!(rows.len(), 2);
        assert!(rows
            .iter()
            .all(|r| r.variant_blob_id.as_deref() == Some(f.blob_id.as_str())));

        let new_preview = b"tampered preview bytes".to_vec();
        let new_thumb = b"tampered thumbnail bytes".to_vec();
        tamper(&f, &new_preview, &new_thumb);

        // Old CIDs name nothing any more, however they are addressed.
        let (status, _, _) = get(&router, &format!("/blob/{old_preview}")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _, _) = get(&router, &format!("/blob/{old_preview}/preview")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _, _) = get(&router, &format!("/blob/{old_thumb}/thumbnail")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // Digest rows: still exactly one per quality, now of the new bytes
        // and naming the variant blobs HoardFS holds.
        let rows = digest_rows(&f);
        assert_eq!(rows.len(), 2);
        let preview_row = rows.iter().find(|r| r.quality == "preview").unwrap();
        let thumb_row = rows.iter().find(|r| r.quality == "thumbnail").unwrap();
        let (exp_preview_cid, exp_preview_sha) = crate::share::records::raw_cid(&new_preview);
        assert_eq!(preview_row.cid, exp_preview_cid.to_string());
        assert_eq!(preview_row.sha256, hex::encode(exp_preview_sha));
        assert_eq!(preview_row.size, new_preview.len() as i64);
        assert_eq!(
            preview_row.variant_blob_id.as_deref(),
            Some(variant_blob(&f, Quality::Preview).as_str())
        );
        assert_eq!(
            thumb_row.cid,
            crate::share::records::raw_cid(&new_thumb).0.to_string()
        );
        assert_eq!(
            thumb_row.variant_blob_id.as_deref(),
            Some(variant_blob(&f, Quality::Thumbnail).as_str())
        );

        // The re-sign hook fired: the stored record carries the new CIDs,
        // and they serve the new bytes.
        let (np, nt) = published_cids(&f);
        assert_ne!(np, old_preview);
        assert_eq!(np, preview_row.cid);
        assert_eq!(nt, thumb_row.cid);
        let (status, _, body) = get(&router, &format!("/blob/{np}")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, new_preview);
        let (status, _, body) = get(&router, &format!("/blob/{nt}/thumbnail")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, new_thumb);
        // The collection record was re-signed too (its image ref changed).
        let n: i64 = {
            use crate::db::schema::published_records;
            published_records::table
                .filter(published_records::collection_id.eq(&f.public_collection.id))
                .count()
                .get_result(&mut f.state.db.get().unwrap())
                .unwrap()
        };
        assert_eq!(n, 2);
    }

    /// A digest row from before `variant_blob_id` existed (NULL) is hashed
    /// once on first use: still served when the bytes match, and backfilled
    /// (here with the original's blob id — no renditions for a tiny source)
    /// so the next request takes the metadata-only path.
    #[tokio::test(flavor = "multi_thread")]
    async fn legacy_digest_row_is_verified_once_and_backfilled() {
        use crate::daemon::records::tests::{link_did, sign_publish};
        use crate::db::schema::blob_digests;
        let f = fixture().await;
        link_did(&f);
        sign_publish(&f, &f.public_collection.id).await.unwrap();
        let router = crate::daemon::router(f.state.clone());
        let (preview, _) = published_cids(&f);

        diesel::update(blob_digests::table.filter(blob_digests::blob_id.eq(&f.blob_id)))
            .set(blob_digests::variant_blob_id.eq(None::<String>))
            .execute(&mut f.state.db.get().unwrap())
            .unwrap();

        let (status, _, body) = get(&router, &format!("/blob/{preview}/preview")).await;
        assert_eq!(status, StatusCode::OK);
        let cid: ipld_core::cid::Cid = preview.parse().unwrap();
        assert_eq!(cid.hash().digest(), &sha256_of(&body)[..]);
        let row = digest_rows(&f)
            .into_iter()
            .find(|r| r.quality == "preview")
            .unwrap();
        assert_eq!(row.cid, preview, "matching bytes keep the CID");
        assert_eq!(row.variant_blob_id.as_deref(), Some(f.blob_id.as_str()));
        // The record was not re-signed for a row that merely lacked identity.
        assert_eq!(published_cids(&f).0, preview);
    }

    /// The desktop-only treatment: drop the rows, no re-sign.
    #[tokio::test(flavor = "multi_thread")]
    async fn drop_variant_digests_forgets_only_named_renditions() {
        use crate::daemon::records::tests::{link_did, sign_publish};
        use crate::share::records::{drop_variant_digests, on_variant_written, PUBLIC_RENDITIONS};
        let f = fixture().await;
        link_did(&f);
        sign_publish(&f, &f.public_collection.id).await.unwrap();
        assert_eq!(digest_rows(&f).len(), 2);
        let before = published_cids(&f);

        let dropped = drop_variant_digests(
            &mut f.state.db.get().unwrap(),
            &f.blob_id,
            &[Quality::Preview],
        )
        .unwrap();
        assert_eq!(dropped, 1);
        assert_eq!(
            digest_rows(&f)
                .iter()
                .map(|r| r.quality.as_str())
                .collect::<Vec<_>>(),
            vec!["thumbnail"]
        );
        // Non-public renditions are not digest rows: nothing to drop.
        assert_eq!(
            drop_variant_digests(&mut f.state.db.get().unwrap(), &f.blob_id, &[Quality::Full])
                .unwrap(),
            0
        );

        // The choke point without a signer drops and stops.
        let state = f.state.clone();
        let blob = f.blob_id.clone();
        let resigned = tokio::task::spawn_blocking(move || {
            on_variant_written(&state.db, &state.hoardfs, None, &blob, &PUBLIC_RENDITIONS)
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!(resigned, 0);
        assert!(digest_rows(&f).is_empty());
        assert_eq!(published_cids(&f), before);

        // With the signer it re-signs: rows are back, one per quality.
        let state = f.state.clone();
        let blob = f.blob_id.clone();
        let resigned = tokio::task::spawn_blocking(move || {
            on_variant_written(
                &state.db,
                &state.hoardfs,
                state.signer.as_deref(),
                &blob,
                &PUBLIC_RENDITIONS,
            )
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!(resigned, 1);
        assert_eq!(digest_rows(&f).len(), 2);
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
