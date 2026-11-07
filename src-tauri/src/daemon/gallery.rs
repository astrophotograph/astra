//! Public gallery pages, served live from the daemon.
//!
//! - `GET /@{username}/{slug}` — the embedded Preact viewer with an injected
//!   `<base>` tag (the viewer fetches `manifest.json` and image paths
//!   relatively).
//! - `GET /@{username}/{slug}/manifest.json` — the stored, signed
//!   `gallery.astra.collection` record (byte-for-byte, see
//!   `share::records`) when the collection was published with signing;
//!   otherwise built live from the publish record + image rows, so a
//!   legacy gallery updates the moment the library does (the viewer polls
//!   every 30s either way; a signed gallery changes only when the daemon
//!   re-signs on publish/sync).
//! - `GET /@{username}/{slug}/images/{file}` + `/thumbs/{file}` — HoardFS
//!   variant bytes with `Cache-Control: public` (the hot artifacts
//!   Cloudflare caches at the edge) and blob-id ETags.
//! - `GET /@{username}` — minimal profile page listing public galleries,
//!   with the user's DID and verified handle (`handles.rs`) when linked,
//!   and each signed gallery's `at://` URI.
//! - `GET /at/{did}/{collection}/{rkey}` — resolver for the `at://` URIs a
//!   signed gallery advertises (`<link rel="canonical">`): 302 to the
//!   pretty URL of the gallery (for an image record, the gallery that
//!   contains it; for a `sh.kenning.private.stub`, the gallery it stands
//!   in for). `{did}` may also be a local username.
//!
//! # Access model
//!
//! These routes bypass `AuthedUser`, gated instead by publish-record
//! resolution: no `published_collections` row → 404, always. Unlisted
//! galleries resolve only at their exact slug and never appear on the
//! profile page. Nothing here ever reads a collection or image that the
//! resolved record doesn't own — probing ids of unpublished content 404s.
//!
//! `circle:<name>` galleries add one step: after resolution, the viewer
//! (optionally identified by [`MaybeViewer`]) is checked against the
//! owner's kith circle (`acl.rs`); denial is the same 404. Such responses
//! are marked `private, no-store`. The profile page lists a circle gallery
//! only to viewers who pass, and never lists the public stub as a gallery.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use diesel::prelude::*;
use hoardfs_core::Quality;

use super::acl;
use super::api::variant_response;
use super::auth::MaybeViewer;
use super::DaemonState;
use crate::commands::publish::{
    access_for_published, list_listable_for_user_core, resolve_public_collection,
    user_id_for_username, Access,
};
use crate::db::models::{Collection, Image, PublishedCollection};
use crate::db::schema::{published_collections, users};
use crate::db::{repository, tenancy, DbPool};
use crate::share::records::{COLLECTION_NSID, IMAGE_NSID};
use crate::share::{manifest, records, viewer};
use kenning::private::STUB_NSID;

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

/// Resolve a gallery (public, unlisted or circle) with its access rule,
/// or None. Blocking (diesel). The caller must run [`acl::allowed`] on the
/// `Access` before serving.
fn resolve(
    db: &DbPool,
    handle: &str,
    slug: &str,
) -> Result<Option<(PublishedCollection, Collection, Access)>, String> {
    let Some((record, collection)) = resolve_public_collection(db, handle, slug)? else {
        return Ok(None);
    };
    let mut conn = db.get().map_err(|e| e.to_string())?;
    let access = access_for_published(&mut conn, &record)?;
    Ok(Some((record, collection, access)))
}

/// Blocking resolve + the async ACL: the gallery, or the `None` that both
/// "no such gallery" and "not yours to see" share (the caller 404s).
async fn resolve_allowed(
    state: &DaemonState,
    handle: String,
    slug: String,
    viewer: &MaybeViewer,
) -> Result<Option<(PublishedCollection, Collection, Access)>, String> {
    let db = state.db.clone();
    let hit = tokio::task::spawn_blocking(move || resolve(&db, &handle, &slug))
        .await
        .map_err(|e| format!("resolve task: {e}"))??;
    let Some((record, collection, access)) = hit else {
        return Ok(None);
    };
    if !acl::allowed(state, &access, viewer.0.as_ref()).await? {
        return Ok(None);
    }
    Ok(Some((record, collection, access)))
}

/// A profile's galleries after the circle ACL: `(publish row, at:// URI
/// if signed)`, in listing order.
type ProfileGalleries = Vec<(PublishedCollection, Option<String>)>;

/// The profile page's data once the ACL has run: handle, owner id, DID,
/// galleries — or None for an unknown user.
type ProfilePage = Option<(String, String, Option<String>, ProfileGalleries)>;

/// Blocking half of the profile page: handle, owner id, DID and every
/// listable gallery with its access rule.
type ProfileCandidates = (
    String,
    String,
    Option<String>,
    Vec<(PublishedCollection, Option<String>, Access)>,
);

pub async fn profile_page(
    State(state): State<Arc<DaemonState>>,
    Path(user): Path<String>,
    viewer: MaybeViewer,
) -> Response {
    let Some(handle) = handle_from_path(&user).map(str::to_string) else {
        return not_found();
    };

    let db = state.db.clone();
    let result =
        tokio::task::spawn_blocking(move || -> Result<Option<ProfileCandidates>, String> {
            let mut conn = db.get().map_err(|e| e.to_string())?;
            let Some(owner_id) = user_id_for_username(&mut conn, &handle)? else {
                return Ok(None);
            };
            let did = records::user_did(&mut conn, &owner_id)?;
            drop(conn);
            // Public + circle galleries; the circle ones are filtered by the
            // ACL below. Stubs are records, not publishes, so they never
            // appear here.
            let galleries = list_listable_for_user_core(&db, &handle)?;
            // Signed galleries carry their identity-rooted URI as well.
            let mut conn = db.get().map_err(|e| e.to_string())?;
            let mut listed = Vec::with_capacity(galleries.len());
            for (g, access) in galleries {
                let uri = records::stored_collection_record(&mut conn, &g.collection_id)
                    .map_err(|e| e.to_string())?
                    .map(|r| r.uri);
                listed.push((g, uri, access));
            }
            Ok(Some((handle, owner_id, did, listed)))
        })
        .await;

    // The circle ACL, per candidate, against the live kith store.
    let result: Result<Result<ProfilePage, String>, _> = match result {
        Ok(Ok(Some((handle, owner_id, did, candidates)))) => {
            let mut galleries = Vec::with_capacity(candidates.len());
            let mut failure = None;
            for (g, uri, access) in candidates {
                match acl::allowed(&state, &access, viewer.0.as_ref()).await {
                    Ok(true) => galleries.push((g, uri)),
                    Ok(false) => {}
                    Err(e) => {
                        failure = Some(e);
                        break;
                    }
                }
            }
            match failure {
                Some(e) => Ok(Err(e)),
                None => Ok(Ok(Some((handle, owner_id, did, galleries)))),
            }
        }
        Ok(Ok(None)) => Ok(Ok(None)),
        Ok(Err(e)) => Ok(Err(e)),
        Err(e) => Err(e),
    };

    match result {
        Ok(Ok(Some((handle, owner_id, did, galleries)))) => {
            // Bounded by the cache's timeout; a slow resolver costs at most
            // that once per DID per retry window, then the page shows the
            // DID alone.
            let verified = match &did {
                Some(did) => state.handles.verified_handle(did).await,
                None => None,
            };
            let identity = match &did {
                Some(did) => format!(
                    r#"<p class="identity">{handle}<code class="did">{did}</code></p>"#,
                    handle = verified
                        .as_deref()
                        .map(|h| format!(r#"<span class="handle">@{}</span> · "#, html_escape(h)))
                        .unwrap_or_default(),
                    did = html_escape(did),
                ),
                None => String::new(),
            };
            let items: String = galleries
                .iter()
                .map(|(g, uri)| {
                    format!(
                        r#"<li><a href="/@{handle}/{slug}">{title}</a>{at}</li>"#,
                        handle = html_escape(&handle),
                        slug = html_escape(&g.slug),
                        title = html_escape(&g.title),
                        at = uri.as_deref().map(at_uri_link).unwrap_or_default(),
                    )
                })
                .collect();
            let body = format!(
                "<!doctype html><html><head><meta charset=\"utf-8\">\
                 <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
                 <title>@{h} — Astra Gallery</title>\
                 <style>body{{font-family:system-ui;background:#0b1020;color:#e6e8f0;\
                 max-width:640px;margin:4rem auto;padding:0 1rem}}a{{color:#8ab4ff}}\
                 li{{margin:.5rem 0}}code{{font-size:.85em;color:#9aa3b8;word-break:break-all}}\
                 .identity{{color:#9aa3b8}}.handle{{color:#e6e8f0}}\
                 .at-uri{{display:block;margin-top:.15rem}}</style></head>\
                 <body><h1>@{h}</h1>{identity}{widget}{list}</body></html>",
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
            // An identified viewer may have been shown circle galleries:
            // the page is theirs alone.
            if viewer.0.is_some() {
                acl::mark_private(&mut response);
            }
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
    viewer: MaybeViewer,
) -> Response {
    let Some(handle) = handle_from_path(&user).map(str::to_string) else {
        return not_found();
    };

    // Resolve + ACL first; a denied viewer must not even tick the counter.
    let (record, collection, access) = match resolve_allowed(&state, handle, slug, &viewer).await {
        Ok(Some(hit)) => hit,
        Ok(None) => return not_found(),
        Err(e) => {
            log::error!("gallery page: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let db = state.db.clone();
    let (record_id, collection_id) = (record.id.clone(), collection.id.clone());
    let resolved = tokio::task::spawn_blocking(move || {
        let mut signed = None;
        if let Ok(mut conn) = db.get() {
            // Best-effort view counter; never fails the page.
            let _ = diesel::update(published_collections::table.find(&record_id))
                .set(published_collections::view_count.eq(published_collections::view_count + 1))
                .execute(&mut conn);
            // The stored collection record, when signed: its URI and
            // CID go into the page head.
            signed = records::stored_collection_record(&mut conn, &collection_id)
                .map_err(|e| e.to_string())?
                .map(|r| (r.uri, r.cid));
        }
        Ok::<_, String>(signed)
    })
    .await;

    match resolved {
        Ok(Ok(signed)) => {
            let viewer_html = match collection.template.as_deref() {
                Some("messier") | Some("caldwell") => viewer::CATALOG_VIEWER_HTML,
                _ => viewer::VIEWER_HTML,
            };
            // The viewer fetches manifest.json and image paths relatively;
            // anchor them regardless of a trailing slash in the request URL.
            let mut head = format!(
                "<head><base href=\"/@{}/{}/\">",
                html_escape(&user[1..]),
                html_escape(&record.slug)
            );
            // Signed: the identity-rooted URI is the canonical one — the
            // pretty URL is a resolver for it and may move hosts.
            if let Some((uri, cid)) = &signed {
                head.push_str(&canonical_head_tags(uri, cid));
            }
            let body = viewer_html.replacen("<head>", &head, 1);
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
            acl::mark_if_gated(&mut response, &access);
            response
        }
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

/// `<link rel="canonical">` plus the `kenning:*` meta tags for a signed
/// collection record. Empty when the URI is not well formed (never the
/// case for a stored record; kept total so a bad row cannot break a page).
fn canonical_head_tags(uri: &str, cid: &str) -> String {
    let Ok(parsed) = uri.parse::<kenning::record::AtUri>() else {
        return String::new();
    };
    format!(
        r#"<link rel="canonical" href="{uri}"><meta name="kenning:did" content="{did}"><meta name="kenning:cid" content="{cid}"><meta name="kenning:uri" content="{uri}">"#,
        uri = html_escape(uri),
        did = html_escape(parsed.did()),
        cid = html_escape(cid),
    )
}

/// The `/at/...` resolver path for an `at://` URI.
fn at_resolver_path(uri: &str) -> Option<String> {
    uri.strip_prefix("at://").map(|rest| format!("/at/{rest}"))
}

/// `<code><a href="/at/...">at://...</a></code>`, the secondary link on
/// the profile page's gallery list.
fn at_uri_link(uri: &str) -> String {
    match at_resolver_path(uri) {
        Some(path) => format!(
            r#"<code class="at-uri"><a href="{path}">{uri}</a></code>"#,
            path = html_escape(&path),
            uri = html_escape(uri),
        ),
        None => format!(
            r#"<code class="at-uri">{uri}</code>"#,
            uri = html_escape(uri)
        ),
    }
}

/// `GET /at/{did}/{collection}/{rkey}` → 302 to `/@{username}/{slug}`.
///
/// `{did}` is the DID the record was published under (exact URI lookup)
/// or, as a convenience, a local username (owner + NSID + rkey lookup).
/// A `gallery.astra.collection` record redirects to its gallery; a
/// `gallery.astra.image` record to the gallery that contains the image; a
/// `sh.kenning.private.stub` to the gallery it stands in for (the stub is
/// public, so this resolves for everyone — the gallery itself then 404s
/// for viewers outside the circle). A *private* record 404s for a viewer
/// the ACL denies, rather than redirecting: the redirect would confirm
/// the record exists. Anything that does not resolve to a stored record
/// of a published collection — unknown DID, rkey, or NSID, a malformed
/// segment — 404s.
pub async fn at_resolve(
    State(state): State<Arc<DaemonState>>,
    Path((did, collection, rkey)): Path<(String, String, String)>,
    viewer: MaybeViewer,
) -> Response {
    if kenning::record::Nsid::new(collection.as_str()).is_err()
        || kenning::record::Rkey::new(rkey.as_str()).is_err()
        || !(collection == COLLECTION_NSID || collection == IMAGE_NSID || collection == STUB_NSID)
    {
        return not_found();
    }

    let db = state.db.clone();
    let result =
        tokio::task::spawn_blocking(move || -> Result<Option<(String, Access)>, String> {
            let mut conn = db.get().map_err(|e| e.to_string())?;
            let record = if did.starts_with("did:") {
                let uri = format!("at://{did}/{collection}/{rkey}");
                records::stored_record_by_uri(&mut conn, &uri).map_err(|e| e.to_string())?
            } else {
                let Some(user_id) = user_id_for_username(&mut conn, &did)? else {
                    return Ok(None);
                };
                records::stored_record(&mut conn, &user_id, &collection, &rkey)
                    .map_err(|e| e.to_string())?
            };
            let Some(record) = record else {
                return Ok(None);
            };
            let access = records::access_for_record(&mut conn, &record)?;
            // Records exist only while their collection is published, and the
            // row names the publish; still, resolve through the publish table so
            // the redirect target is exactly what `/@user/slug` will accept.
            let slug: Option<String> = published_collections::table
                .filter(published_collections::collection_id.eq(&record.collection_id))
                .filter(published_collections::user_id.eq(&record.user_id))
                .select(published_collections::slug)
                .first(&mut conn)
                .optional()
                .map_err(|e| e.to_string())?;
            let username: Option<String> = users::table
                .find(&record.user_id)
                .select(users::username)
                .first::<Option<String>>(&mut conn)
                .optional()
                .map_err(|e| e.to_string())?
                .flatten();
            Ok(match (username, slug) {
                (Some(username), Some(slug)) => Some((format!("/@{username}/{slug}"), access)),
                _ => None,
            })
        })
        .await;

    match result {
        // 302, not axum's `Redirect::to` (303) or `::temporary` (307): the
        // record may be re-signed or move host, so nothing here is permanent.
        Ok(Ok(Some((location, access)))) => {
            match acl::allowed(&state, &access, viewer.0.as_ref()).await {
                Ok(true) => {}
                Ok(false) => return not_found(),
                Err(e) => {
                    log::error!("at resolver acl: {e}");
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            }
            let mut response = (StatusCode::FOUND, [(header::LOCATION, location)]).into_response();
            acl::mark_if_gated(&mut response, &access);
            response
        }
        Ok(Ok(None)) => not_found(),
        Ok(Err(e)) => {
            log::error!("at resolver: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            log::error!("at resolver task: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

enum ManifestBody {
    Signed(crate::db::models::PublishedRecord),
    Legacy(manifest::ShareManifest),
}

pub async fn gallery_manifest(
    State(state): State<Arc<DaemonState>>,
    Path((user, slug)): Path<(String, String)>,
    headers: HeaderMap,
    viewer: MaybeViewer,
) -> Response {
    let Some(handle) = handle_from_path(&user).map(str::to_string) else {
        return not_found();
    };

    let (_, collection, access) = match resolve_allowed(&state, handle, slug, &viewer).await {
        Ok(Some(hit)) => hit,
        Ok(None) => return not_found(),
        Err(e) => {
            log::error!("gallery manifest: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let db = state.db.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let mut conn = db.get().map_err(|e| e.to_string())?;
        // Signed publish: the stored record is the manifest, unchanged.
        if let Some(record) = records::stored_collection_record(&mut conn, &collection.id)
            .map_err(|e| e.to_string())?
        {
            return Ok(ManifestBody::Signed(record));
        }
        let images = repository::get_images_in_collection(&mut conn, &collection.id)
            .map_err(|e| e.to_string())?;
        Ok(ManifestBody::Legacy(
            manifest::build_manifest_for_collection(&collection, &images),
        ))
    })
    .await;

    match result {
        Ok(Ok(ManifestBody::Signed(record))) => {
            let mut response =
                super::records::json_bytes_response(record.signed_json, &record.cid, &headers);
            acl::mark_if_gated(&mut response, &access);
            response
        }
        Ok(Ok(ManifestBody::Legacy(manifest))) => {
            let mut response = axum::Json(manifest).into_response();
            // Short: the viewer polls for live updates every 30s.
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                header::HeaderValue::from_static("public, max-age=10"),
            );
            acl::mark_if_gated(&mut response, &access);
            response
        }
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
    viewer: MaybeViewer,
) -> Response {
    serve_gallery_asset(state, path, headers, viewer, Quality::Preview).await
}

pub async fn gallery_thumb(
    state: State<Arc<DaemonState>>,
    path: Path<(String, String, String)>,
    headers: HeaderMap,
    viewer: MaybeViewer,
) -> Response {
    serve_gallery_asset(state, path, headers, viewer, Quality::Thumbnail).await
}

/// `{file}` is `{image_id}.{ext}` per the manifest paths. The image must be
/// owned by the gallery's owner AND be a member of the published collection
/// — an id from someone's unpublished library 404s. A circle gallery's
/// assets go through the same ACL as its page.
async fn serve_gallery_asset(
    State(state): State<Arc<DaemonState>>,
    Path((user, slug, file)): Path<(String, String, String)>,
    headers: HeaderMap,
    viewer: MaybeViewer,
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

    let (record, collection, access) = match resolve_allowed(&state, handle, slug, &viewer).await {
        Ok(Some(hit)) => hit,
        Ok(None) => return not_found(),
        Err(e) => {
            log::error!("gallery asset: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let db = state.db.clone();
    let resolved = tokio::task::spawn_blocking(move || -> Result<Option<Image>, String> {
        let mut conn = db.get().map_err(|e| e.to_string())?;
        let in_collection =
            repository::is_image_in_collection(&mut conn, &collection.id, &image_id)
                .map_err(|e| e.to_string())?;
        if !in_collection {
            return Ok(None);
        }
        let image = repository::get_image_by_id(&mut conn, &image_id).map_err(|e| e.to_string())?;
        Ok(image.filter(|i| i.user_id == record.user_id))
    })
    .await;

    match resolved {
        Ok(Ok(Some(image))) => {
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
pub(crate) mod tests {
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

    pub(crate) fn tiny_png() -> Vec<u8> {
        let img = image::RgbImage::from_pixel(40, 40, image::Rgb([250, 180, 40]));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }

    pub(crate) struct Fixture {
        pub(crate) state: Arc<DaemonState>,
        _tmp: tempfile::TempDir,
        pub(crate) public_collection: Collection,
        pub(crate) unlisted_collection: Collection,
        pub(crate) private_collection: Collection,
        pub(crate) image: Image,
        pub(crate) private_image: Image,
        /// Public half of the fixture's signing key (method `astra`).
        pub(crate) verifying_key: kenning::keys::VerifyingKey,
        /// HoardFS blob id of `image`.
        pub(crate) blob_id: String,
    }

    /// A signer over a fresh secp256k1 key and the checkout's `lexicons/`,
    /// naming `https://astra.test` as this host (for private-record stubs).
    pub(crate) fn test_signer() -> records::Signer {
        let key = kenning::keys::SigningKey::generate(kenning::keys::KeyAlgo::Secp256k1);
        let lexicons = kenning::lexicon::LexiconRegistry::from_dir(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../lexicons"
        ))
        .expect("lexicons load");
        records::Signer::new(key, records::DEFAULT_METHOD_ID, lexicons)
            .with_public_url("https://astra.test/")
    }

    /// alice (@aliceh) with a public, an unlisted, and a private collection;
    /// one HoardFS-backed image in the public one, one image kept private.
    /// The state carries a signer, but alice has no DID, so every publish
    /// here is a legacy one — signed tests link a DID and re-publish.
    pub(crate) async fn fixture() -> Fixture {
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
        hfs.put_file("user-alice", "/g/m31.png", &tiny_png())
            .await
            .unwrap();
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
            .set(images_table::blob_id.eq(Some(blob_id.clone())))
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

        let signer = test_signer();
        let verifying_key = signer.key.verifying_key();
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
            signer: Some(Arc::new(signer)),
            mailer: Arc::new(crate::mail::LogMailer::default()),
            magic: Default::default(),
        });
        Fixture {
            state,
            _tmp: tmp,
            public_collection,
            unlisted_collection,
            private_collection,
            image,
            private_image,
            verifying_key,
            blob_id,
        }
    }

    pub(crate) async fn get(router: &axum::Router, uri: &str) -> (StatusCode, HeaderMap, Vec<u8>) {
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

        let (status, headers, body) = get(&router, "/@aliceh/andromeda-nights/manifest.json").await;
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
        let etag = headers
            .get(header::ETAG)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
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

    use crate::daemon::handles::tests::{FakeResolver, HandleAnswer};
    use crate::daemon::handles::HandleCache;
    use crate::daemon::records::tests::{image_rkey, link_did, sign_publish, DID};
    use std::time::Duration;

    /// The fixture's state with a different handle cache (fake resolver).
    fn state_with_handles(f: &Fixture, handles: HandleCache) -> Arc<DaemonState> {
        Arc::new(DaemonState {
            db: f.state.db.clone(),
            hoardfs: f.state.hoardfs.clone(),
            oidc: None,
            limits: Default::default(),
            session_key: [7u8; 32],
            processing: Default::default(),
            tetra3_db: None,
            tetra3_cache: Default::default(),
            uploads_dir: std::env::temp_dir().join("astra-test-uploads"),
            signer: f.state.signer.clone(),
            handles,
            mailer: Arc::new(crate::mail::LogMailer::default()),
            magic: Default::default(),
        })
    }

    fn fake_handles(handles: Vec<&'static str>, answer: HandleAnswer) -> HandleCache {
        HandleCache::new(
            FakeResolver::new(handles, answer),
            Duration::from_millis(100),
        )
    }

    async fn html(router: &axum::Router, uri: &str) -> String {
        let (status, _, body) = get(router, uri).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
        String::from_utf8(body).unwrap()
    }

    /// A signed gallery page advertises its identity-rooted URI in the
    /// head (canonical link + `kenning:*` meta); a legacy one does not.
    #[tokio::test(flavor = "multi_thread")]
    async fn gallery_page_canonical_at_uri_only_when_signed() {
        let f = fixture().await;
        let router = crate::daemon::router(f.state.clone());

        let page = html(&router, "/@aliceh/andromeda-nights").await;
        assert!(page.contains(r#"<base href="/@aliceh/andromeda-nights/">"#));
        assert!(!page.contains(r#"rel="canonical""#));
        assert!(!page.contains("kenning:"));

        link_did(&f);
        let result = sign_publish(&f, &f.public_collection.id).await.unwrap();
        let uri = format!("at://{DID}/{COLLECTION_NSID}/andromeda-nights");
        assert_eq!(result.uri, uri);

        let page = html(&router, "/@aliceh/andromeda-nights").await;
        assert!(page.contains(r#"<base href="/@aliceh/andromeda-nights/">"#));
        assert!(page.contains(&format!(r#"<link rel="canonical" href="{uri}">"#)));
        assert!(page.contains(&format!(r#"<meta name="kenning:did" content="{DID}">"#)));
        assert!(page.contains(&format!(
            r#"<meta name="kenning:cid" content="{}">"#,
            result.cid
        )));
        assert!(page.contains(&format!(r#"<meta name="kenning:uri" content="{uri}">"#)));
        // All of it inside <head>, once.
        let head_end = page.find("</head>").unwrap();
        assert!(page.find(r#"rel="canonical""#).unwrap() < head_end);
        assert_eq!(page.matches(r#"rel="canonical""#).count(), 1);

        // The unsigned (unlisted, no record) gallery of the same user is
        // untouched.
        let page = html(&router, "/@aliceh/drafts").await;
        assert!(!page.contains(r#"rel="canonical""#));
    }

    /// Profile: handle + DID when a claimed handle resolves back to the
    /// DID; DID only on mismatch, resolver failure, or timeout; no DID →
    /// the page is unchanged. Signed public galleries list their `at://`
    /// URI, unsigned ones do not.
    #[tokio::test(flavor = "multi_thread")]
    async fn profile_shows_did_and_verified_handle() {
        let f = fixture().await;

        // No DID linked: no identity block, regardless of resolver.
        let state = state_with_handles(
            &f,
            fake_handles(vec!["alice.example.com"], HandleAnswer::Did(DID)),
        );
        let page = html(&crate::daemon::router(state), "/@aliceh").await;
        assert!(!page.contains("did:plc:"));
        assert!(!page.contains("alice.example.com"));
        assert!(!page.contains(r#"class="identity""#));
        assert!(!page.contains("at://"));

        link_did(&f);
        sign_publish(&f, &f.public_collection.id).await.unwrap();
        sign_publish(&f, &f.unlisted_collection.id).await.unwrap();

        // Verified handle: shown alongside the DID; the first verifying
        // claim wins and junk claims are skipped.
        let state = state_with_handles(
            &f,
            fake_handles(
                vec!["not a handle", "alice.example.com", "alt.example.com"],
                HandleAnswer::Did(DID),
            ),
        );
        let page = html(&crate::daemon::router(state), "/@aliceh").await;
        assert!(page.contains(r#"<span class="handle">@alice.example.com</span>"#));
        assert!(!page.contains("alt.example.com"));
        assert!(page.contains(&format!(r#"<code class="did">{DID}</code>"#)));
        // The public signed gallery lists its at:// URI, linked through
        // the resolver route; the unlisted one stays unlisted.
        let uri = format!("at://{DID}/{COLLECTION_NSID}/andromeda-nights");
        assert!(page.contains(&format!(
            r#"<code class="at-uri"><a href="/at/{DID}/{COLLECTION_NSID}/andromeda-nights">{uri}</a></code>"#
        )));
        assert!(!page.contains("drafts"));

        // Handle resolves to someone else's DID: DID only.
        let state = state_with_handles(
            &f,
            fake_handles(
                vec!["alice.example.com"],
                HandleAnswer::Did("did:plc:ewvi7nxzyoun6zhxrhs64oiz"),
            ),
        );
        let page = html(&crate::daemon::router(state), "/@aliceh").await;
        assert!(page.contains(&format!(r#"<code class="did">{DID}</code>"#)));
        assert!(!page.contains("alice.example.com"));

        // Resolver errors: DID only.
        let state = state_with_handles(
            &f,
            fake_handles(vec!["alice.example.com"], HandleAnswer::Transport),
        );
        let page = html(&crate::daemon::router(state), "/@aliceh").await;
        assert!(page.contains(DID));
        assert!(!page.contains("alice.example.com"));

        // Resolver hangs: the page still renders (within the timeout),
        // DID only.
        let state = state_with_handles(
            &f,
            fake_handles(vec!["alice.example.com"], HandleAnswer::Hang),
        );
        let started = std::time::Instant::now();
        let page = html(&crate::daemon::router(state), "/@aliceh").await;
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(page.contains(DID));
        assert!(!page.contains("alice.example.com"));
    }

    /// `/at/{did}/{collection}/{rkey}` redirects known records to the
    /// pretty gallery URL and 404s everything else.
    #[tokio::test(flavor = "multi_thread")]
    async fn at_resolver_redirects_known_records() {
        let f = fixture().await;
        let router = crate::daemon::router(f.state.clone());
        let collection_path = format!("/at/{DID}/{COLLECTION_NSID}/andromeda-nights");

        // Nothing signed yet: 404.
        let (status, _, _) = get(&router, &collection_path).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        link_did(&f);
        sign_publish(&f, &f.public_collection.id).await.unwrap();
        let rkey = image_rkey(&f);

        // Collection record → its gallery.
        let (status, headers, _) = get(&router, &collection_path).await;
        assert_eq!(status, StatusCode::FOUND);
        assert_eq!(
            headers.get(header::LOCATION).unwrap(),
            "/@aliceh/andromeda-nights"
        );

        // Image record → the gallery that contains it.
        let (status, headers, _) = get(&router, &format!("/at/{DID}/{IMAGE_NSID}/{rkey}")).await;
        assert_eq!(status, StatusCode::FOUND);
        assert_eq!(
            headers.get(header::LOCATION).unwrap(),
            "/@aliceh/andromeda-nights"
        );

        // Local username in place of the DID.
        let (status, headers, _) = get(
            &router,
            &format!("/at/aliceh/{COLLECTION_NSID}/andromeda-nights"),
        )
        .await;
        assert_eq!(status, StatusCode::FOUND);
        assert_eq!(
            headers.get(header::LOCATION).unwrap(),
            "/@aliceh/andromeda-nights"
        );
        let (status, _, _) = get(&router, &format!("/at/aliceh/{IMAGE_NSID}/{rkey}")).await;
        assert_eq!(status, StatusCode::FOUND);

        // Unknown DID, unknown username, unknown rkey, foreign NSID, bad rkey.
        for path in [
            format!("/at/did:plc:ewvi7nxzyoun6zhxrhs64oiz/{COLLECTION_NSID}/andromeda-nights"),
            format!("/at/ghost/{COLLECTION_NSID}/andromeda-nights"),
            format!("/at/{DID}/{COLLECTION_NSID}/nope"),
            format!("/at/{DID}/{IMAGE_NSID}/andromeda-nights"),
            format!("/at/{DID}/app.bsky.feed.post/andromeda-nights"),
            format!("/at/{DID}/{COLLECTION_NSID}/.."),
        ] {
            let (status, _, _) = get(&router, &path).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
        }
    }
}
