//! Public routes that serve stored kenning records byte-for-byte.
//!
//! - `GET /@{user}/{slug}/bundle.json` — `{ collection: <SignedRecord>,
//!   images: [<SignedRecord>, ...] }`: everything the viewer needs in one
//!   fetch, each member spliced in as the exact stored JSON.
//! - `GET /@{user}/{slug}/records/{rkey}` — one `gallery.astra.image`
//!   SignedRecord of the gallery's owner.
//! - `GET /xrpc/com.atproto.repo.getRecord?repo=&collection=&rkey=` — the
//!   AT Protocol read shape `{ uri, cid, value }`, with `repo` either the
//!   author's DID or, as a handle stand-in, their username.
//!
//! `GET /@{user}/{slug}/manifest.json` (in `gallery.rs`) returns the stored
//! collection SignedRecord when one exists, else the legacy live manifest.
//!
//! All public, below the auth layer, gated like the gallery pages by
//! publish-record resolution (bundle/records) or by the record simply
//! existing (getRecord — records exist only while their collection is
//! published). Responses carry `Cache-Control: public, max-age=60` and the
//! record CID as a strong ETag; a matching `If-None-Match` answers 304.
//!
//! Records of a `circle:` collection are stored with `private = 1` and
//! served only to viewers the kith ACL admits (`acl.rs`, viewer from
//! [`MaybeViewer`]); denial is a 404 indistinguishable from "no such
//! record", and admitted responses are `private, no-store`. The public
//! `sh.kenning.private.stub` that stands in for such a collection is an
//! ordinary public record here.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use super::acl;
use super::api::if_none_match_hits;
use super::auth::MaybeViewer;
use super::DaemonState;
use crate::commands::publish::{
    access_for_published, resolve_public_collection, user_id_for_username, Access,
};
use crate::db::models::PublishedRecord;
use crate::share::records::{self, IMAGE_NSID};

pub const RECORD_CACHE_CONTROL: &str = "public, max-age=60";

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}

fn handle_from_path(user: &str) -> Option<&str> {
    user.strip_prefix('@').filter(|h| !h.is_empty())
}

fn etag_for_cid(cid: &str) -> header::HeaderValue {
    format!("\"{cid}\"")
        .parse()
        .unwrap_or(header::HeaderValue::from_static("\"\""))
}

/// Serve pre-serialized JSON with the record cache policy and a CID ETag.
pub(crate) fn json_bytes_response(body: String, cid: &str, req_headers: &HeaderMap) -> Response {
    let etag = etag_for_cid(cid);
    if let Ok(tag) = etag.to_str() {
        if if_none_match_hits(req_headers, tag) {
            let mut response = StatusCode::NOT_MODIFIED.into_response();
            let headers = response.headers_mut();
            headers.insert(header::ETAG, etag.clone());
            headers.insert(
                header::CACHE_CONTROL,
                header::HeaderValue::from_static(RECORD_CACHE_CONTROL),
            );
            return response;
        }
    }
    let mut response = (StatusCode::OK, body).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/json"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static(RECORD_CACHE_CONTROL),
    );
    headers.insert(header::ETAG, etag);
    response
}

/// `GET /@{user}/{slug}/bundle.json`. 404 when the gallery does not resolve
/// or has no signed records (legacy publish) — the viewer then falls back
/// to `manifest.json`.
pub async fn gallery_bundle(
    State(state): State<Arc<DaemonState>>,
    Path((user, slug)): Path<(String, String)>,
    headers: HeaderMap,
    viewer: MaybeViewer,
) -> Response {
    let Some(handle) = handle_from_path(&user).map(str::to_string) else {
        return not_found();
    };
    let db = state.db.clone();
    let result = tokio::task::spawn_blocking(
        move || -> Result<Option<(String, String, Access)>, String> {
            let Some((published, collection)) = resolve_public_collection(&db, &handle, &slug)?
            else {
                return Ok(None);
            };
            let mut conn = db.get().map_err(|e| e.to_string())?;
            let access = access_for_published(&mut conn, &published)?;
            let Some(record) = records::stored_collection_record(&mut conn, &collection.id)
                .map_err(|e| e.to_string())?
            else {
                return Ok(None);
            };
            let bundle = records::bundle_json(&mut conn, &record)?;
            Ok(Some((bundle, record.cid, access)))
        },
    )
    .await;

    match result {
        Ok(Ok(Some((body, cid, access)))) => {
            match acl::allowed(&state, &access, viewer.0.as_ref()).await {
                Ok(true) => {}
                Ok(false) => return not_found(),
                Err(e) => {
                    log::error!("gallery bundle acl: {e}");
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            }
            let mut response = json_bytes_response(body, &cid, &headers);
            acl::mark_if_gated(&mut response, &access);
            response
        }
        Ok(Ok(None)) => not_found(),
        Ok(Err(e)) => {
            log::error!("gallery bundle: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            log::error!("gallery bundle task: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// `GET /@{user}/{slug}/records/{rkey}` — an image record of the gallery's
/// owner. Records exist only while a collection containing the image is
/// published, so owner + rkey is the gate; an rkey from another user's
/// repo 404s. Both the gallery in the URL and (for a private record) the
/// record itself must pass the viewer's ACL.
pub async fn gallery_record(
    State(state): State<Arc<DaemonState>>,
    Path((user, slug, rkey)): Path<(String, String, String)>,
    headers: HeaderMap,
    viewer: MaybeViewer,
) -> Response {
    let Some(handle) = handle_from_path(&user).map(str::to_string) else {
        return not_found();
    };
    let db = state.db.clone();
    let result = tokio::task::spawn_blocking(
        move || -> Result<Option<(PublishedRecord, Access, Access)>, String> {
            let Some((published, _)) = resolve_public_collection(&db, &handle, &slug)? else {
                return Ok(None);
            };
            let mut conn = db.get().map_err(|e| e.to_string())?;
            let gallery_access = access_for_published(&mut conn, &published)?;
            let Some(row) =
                records::stored_record(&mut conn, &published.user_id, IMAGE_NSID, &rkey)
                    .map_err(|e| e.to_string())?
            else {
                return Ok(None);
            };
            let record_access = records::access_for_record(&mut conn, &row)?;
            Ok(Some((row, gallery_access, record_access)))
        },
    )
    .await;

    match result {
        Ok(Ok(Some((row, gallery_access, record_access)))) => {
            for access in [&gallery_access, &record_access] {
                match acl::allowed(&state, access, viewer.0.as_ref()).await {
                    Ok(true) => {}
                    Ok(false) => return not_found(),
                    Err(e) => {
                        log::error!("gallery record acl: {e}");
                        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                    }
                }
            }
            let mut response = json_bytes_response(row.signed_json, &row.cid, &headers);
            acl::mark_if_gated(&mut response, &gallery_access);
            acl::mark_if_gated(&mut response, &record_access);
            response
        }
        Ok(Ok(None)) => not_found(),
        Ok(Err(e)) => {
            log::error!("gallery record: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            log::error!("gallery record task: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct GetRecordParams {
    repo: Option<String>,
    collection: Option<String>,
    rkey: Option<String>,
}

fn xrpc_error(status: StatusCode, error: &str, message: String) -> Response {
    (
        status,
        Json(serde_json::json!({ "error": error, "message": message })),
    )
        .into_response()
}

/// `GET /xrpc/com.atproto.repo.getRecord` → `{ uri, cid, value }`.
/// `repo` is the author's DID (exact URI lookup) or their username (the
/// handle stand-in until handles resolve). Unknown → 404 `RecordNotFound`,
/// and so is a private record for a viewer outside its circle.
pub async fn xrpc_get_record(
    State(state): State<Arc<DaemonState>>,
    Query(params): Query<GetRecordParams>,
    headers: HeaderMap,
    viewer: MaybeViewer,
) -> Response {
    let (Some(repo), Some(collection), Some(rkey)) = (
        params.repo.filter(|s| !s.is_empty()),
        params.collection.filter(|s| !s.is_empty()),
        params.rkey.filter(|s| !s.is_empty()),
    ) else {
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "repo, collection and rkey are required".to_string(),
        );
    };
    if kenning::record::Nsid::new(collection.as_str()).is_err()
        || kenning::record::Rkey::new(rkey.as_str()).is_err()
    {
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "collection must be an NSID and rkey a record key".to_string(),
        );
    }

    let db = state.db.clone();
    let result = tokio::task::spawn_blocking(
        move || -> Result<Option<(PublishedRecord, Access)>, String> {
            let mut conn = db.get().map_err(|e| e.to_string())?;
            let row = if repo.starts_with("did:") {
                let uri = format!("at://{repo}/{collection}/{rkey}");
                records::stored_record_by_uri(&mut conn, &uri).map_err(|e| e.to_string())?
            } else {
                let Some(user_id) = user_id_for_username(&mut conn, &repo)? else {
                    return Ok(None);
                };
                records::stored_record(&mut conn, &user_id, &collection, &rkey)
                    .map_err(|e| e.to_string())?
            };
            let Some(row) = row else {
                return Ok(None);
            };
            let access = records::access_for_record(&mut conn, &row)?;
            Ok(Some((row, access)))
        },
    )
    .await;

    match result {
        Ok(Ok(Some((row, access)))) => {
            match acl::allowed(&state, &access, viewer.0.as_ref()).await {
                Ok(true) => {}
                Ok(false) => {
                    return xrpc_error(
                        StatusCode::NOT_FOUND,
                        "RecordNotFound",
                        "no such record".to_string(),
                    )
                }
                Err(e) => {
                    log::error!("getRecord acl: {e}");
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            }
            let value: serde_json::Value = match serde_json::from_str(&row.signed_json) {
                Ok(v) => v,
                Err(e) => {
                    log::error!("getRecord: stored json for {} unparsable: {e}", row.uri);
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            };
            let out = serde_json::json!({
                "uri": row.uri,
                "cid": row.cid,
                "value": value.get("record").cloned().unwrap_or(serde_json::Value::Null),
            });
            let mut response = json_bytes_response(out.to_string(), &row.cid, &headers);
            acl::mark_if_gated(&mut response, &access);
            response
        }
        Ok(Ok(None)) => xrpc_error(
            StatusCode::NOT_FOUND,
            "RecordNotFound",
            "no such record".to_string(),
        ),
        Ok(Err(e)) => {
            log::error!("getRecord: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            log::error!("getRecord task: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::commands::images::add_image_to_collection_core;
    use crate::commands::publish::{
        publish_collection_core, unpublish_collection_core, PublishVisibility,
    };
    use crate::daemon::auth::mint_token;
    use crate::daemon::gallery::tests::{fixture, get, Fixture};
    use crate::db::schema::{collections, images as images_table, published_records, users};
    use crate::share::records::{CollectionBody, ImageBody, SignedPublish, COLLECTION_NSID};
    use async_trait::async_trait;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use diesel::prelude::*;
    use kenning::did::{Did, DidDocument, ResolveError, Resolver, VerificationMethod};
    use kenning::envelope::SignedRecord;
    use kenning::handle::Handle;
    use kenning::keys::VerifyingKey;
    use sha2::Digest;
    use tower::ServiceExt;

    pub(crate) const DID: &str = "did:plc:z72i7hdynmk6r22z27h6tvur";

    /// Resolves exactly one DID to a document naming `astra` → `key`.
    pub(crate) struct FakeResolver {
        did: Did,
        key: VerifyingKey,
    }

    #[async_trait]
    impl Resolver for FakeResolver {
        async fn resolve_did(&self, did: &Did) -> Result<DidDocument, ResolveError> {
            if *did != self.did {
                return Err(ResolveError::NotFound);
            }
            Ok(DidDocument {
                context: None,
                id: self.did.clone(),
                also_known_as: vec!["at://aliceh".into()],
                verification_method: vec![VerificationMethod {
                    id: format!("{}#astra", self.did),
                    r#type: "Multikey".into(),
                    controller: self.did.to_string(),
                    public_key_multibase: self.key.to_multikey(),
                }],
                service: Vec::new(),
            })
        }
        async fn resolve_handle(&self, _handle: &Handle) -> Result<Did, ResolveError> {
            Err(ResolveError::NotFound)
        }
    }

    pub(crate) fn resolver(f: &Fixture) -> FakeResolver {
        FakeResolver {
            did: Did::parse(DID).unwrap(),
            key: f.verifying_key.clone(),
        }
    }

    pub(crate) fn link_did(f: &Fixture) {
        diesel::update(users::table.find("alice"))
            .set(users::did.eq(Some(DID)))
            .execute(&mut f.state.db.get().unwrap())
            .unwrap();
    }

    /// Run `publish_signed` the way the handlers do (blocking, inside the
    /// runtime).
    pub(crate) async fn sign_publish(f: &Fixture, collection_id: &str) -> Option<SignedPublish> {
        let state = f.state.clone();
        let id = collection_id.to_string();
        tokio::task::spawn_blocking(move || {
            records::publish_signed(
                &state.db,
                &state.hoardfs,
                state.signer.as_ref().unwrap(),
                "alice",
                &id,
            )
        })
        .await
        .unwrap()
        .unwrap()
    }

    pub(crate) fn stored(f: &Fixture, uri: &str) -> String {
        published_records::table
            .find(uri)
            .select(published_records::signed_json)
            .first::<String>(&mut f.state.db.get().unwrap())
            .unwrap()
    }

    pub(crate) fn image_rkey(f: &Fixture) -> String {
        images_table::table
            .find(&f.image.id)
            .select(images_table::rkey)
            .first::<Option<String>>(&mut f.state.db.get().unwrap())
            .unwrap()
            .expect("rkey minted at publish")
    }

    pub(crate) async fn request(
        router: &axum::Router,
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Option<&str>,
    ) -> (StatusCode, HeaderMap, Vec<u8>) {
        let mut req = Request::builder().method(method).uri(uri);
        if let Some(t) = token {
            req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
        }
        let req = match body {
            Some(b) => req
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .unwrap();
        let resp = router.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let headers = resp.headers().clone();
        let bytes = to_bytes(resp.into_body(), 16 << 20).await.unwrap().to_vec();
        (status, headers, bytes)
    }

    pub(crate) fn json(bytes: &[u8]) -> serde_json::Value {
        serde_json::from_slice(bytes).unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn signed_publish_validates_verifies_and_round_trips() {
        let f = fixture().await;
        link_did(&f);
        // An image without an asset is left out (its blobs cannot exist).
        add_image_to_collection_core(
            &f.state.db,
            "alice",
            &f.private_image.id,
            &f.public_collection.id,
        )
        .unwrap();
        let result = sign_publish(&f, &f.public_collection.id).await.unwrap();
        assert_eq!(result.image_count, 1);
        assert_eq!(result.skipped_images, 1);
        assert_eq!(
            result.uri,
            format!("at://{DID}/{COLLECTION_NSID}/andromeda-nights")
        );

        let router = crate::daemon::router(f.state.clone());
        let signer = f.state.signer.as_ref().unwrap();

        // manifest.json is the stored collection SignedRecord, byte for byte.
        let (status, headers, body) = get(&router, "/@aliceh/andromeda-nights/manifest.json").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers.get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=60"
        );
        assert_eq!(
            headers.get(header::ETAG).unwrap().to_str().unwrap(),
            format!("\"{}\"", result.cid)
        );
        assert_eq!(
            headers.get(header::CONTENT_TYPE).unwrap(),
            "application/json"
        );
        let served = String::from_utf8(body).unwrap();
        assert_eq!(served, stored(&f, &result.uri));

        // It parses as a SignedRecord, validates against the lexicons, and
        // verifies against a DID document naming the fixture key as `astra`.
        let signed: SignedRecord<CollectionBody> = serde_json::from_str(&served).unwrap();
        assert_eq!(signed.method_id, "astra");
        assert_eq!(signed.record.body.title, "Andromeda Nights");
        assert_eq!(signed.record.body.visibility, "public");
        assert_eq!(signed.record.body.images.len(), 1);
        assert_eq!(
            signed.record.body.cover_image.as_ref().unwrap(),
            &signed.record.body.images[0]
        );
        signer.lexicons.validate_record(&signed.record).unwrap();
        let verified = kenning::envelope::verify(&signed, &resolver(&f))
            .await
            .expect("collection signature verifies");
        assert_eq!(verified.did.as_str(), DID);
        assert_eq!(verified.cid.to_string(), result.cid);
        // Deserialize → serialize is byte-identical to what was stored.
        assert_eq!(serde_json::to_string(&signed).unwrap(), served);

        // The image record, via records/{rkey} and inside the bundle.
        let rkey = image_rkey(&f);
        let image_uri = format!("at://{DID}/{IMAGE_NSID}/{rkey}");
        assert_eq!(signed.record.body.images[0].uri, image_uri);
        let (status, headers, body) = get(
            &router,
            &format!("/@aliceh/andromeda-nights/records/{rkey}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let image_json = String::from_utf8(body).unwrap();
        assert_eq!(image_json, stored(&f, &image_uri));
        let image_signed: SignedRecord<ImageBody> = serde_json::from_str(&image_json).unwrap();
        assert_eq!(
            headers.get(header::ETAG).unwrap().to_str().unwrap(),
            format!("\"{}\"", image_signed.cid)
        );
        assert_eq!(
            image_signed.cid.to_string(),
            signed.record.body.images[0].cid
        );
        signer
            .lexicons
            .validate_record(&image_signed.record)
            .unwrap();
        kenning::envelope::verify(&image_signed, &resolver(&f))
            .await
            .expect("image signature verifies");
        let img = &image_signed.record.body;
        assert_eq!(img.filename, "m31.png");
        assert_eq!(img.catalog_ids, vec!["M31"]);
        assert_eq!(img.created_at, records::naive_datetime(f.image.created_at));
        let ps = img.plate_solve.as_ref().unwrap();
        assert_eq!(ps.center_ra_micro_deg, 10_680_000);
        assert_eq!(ps.center_dec_micro_deg, 41_270_000);
        assert_eq!(ps.pixel_scale_milli_arcsec, 1200);
        assert_eq!(img.objects[0].name, "M 31");
        assert_eq!(img.objects[0].magnitude_milli, Some(3400));
        assert!(img.preview.mime_type.starts_with("image/"));
        assert!(img.preview.size > 0);
        assert_eq!(serde_json::to_string(&image_signed).unwrap(), image_json);

        let (status, headers, body) = get(&router, "/@aliceh/andromeda-nights/bundle.json").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers.get(header::ETAG).unwrap().to_str().unwrap(),
            format!("\"{}\"", result.cid)
        );
        let bundle = String::from_utf8(body).unwrap();
        assert_eq!(
            bundle,
            format!("{{\"collection\":{served},\"images\":[{image_json}]}}")
        );

        // Blob references resolve by CID to bytes with that very sha256.
        // (The 40x40 fixture yields byte-identical preview and thumbnail
        // renditions, so both CIDs may coincide; the lookup handles that.)
        let preview_cid = img.preview.r#ref.0.to_string();
        let thumb_cid = img.thumbnail.r#ref.0.to_string();
        let (status, headers, bytes) = get(&router, &format!("/blob/{preview_cid}")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bytes.len() as u64, img.preview.size);
        assert_eq!(
            headers.get(header::CONTENT_TYPE).unwrap().to_str().unwrap(),
            img.preview.mime_type
        );
        let digest: [u8; 32] = sha2::Sha256::digest(&bytes).into();
        assert_eq!(img.preview.r#ref.0.hash().digest(), &digest[..]);
        let (status, _, bytes) = get(&router, &format!("/blob/{thumb_cid}/thumbnail")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bytes.len() as u64, img.thumbnail.size);
        let (status, _, _) = get(&router, &format!("/blob/{preview_cid}/preview")).await;
        assert_eq!(status, StatusCode::OK);
        // A CID names one rendition: plant a digest row that only the
        // thumbnail carries and ask for it as a preview.
        let fake_cid = records::raw_cid(b"not the preview").0.to_string();
        diesel::replace_into(crate::db::schema::blob_digests::table)
            .values(crate::db::models::BlobDigest {
                blob_id: f.blob_id.clone(),
                quality: "thumbnail".into(),
                cid: fake_cid.clone(),
                sha256: "00".into(),
                size: 1,
                mime: "image/jpeg".into(),
            })
            .execute(&mut f.state.db.get().unwrap())
            .unwrap();
        let (status, _, _) = get(&router, &format!("/blob/{fake_cid}")).await;
        assert_eq!(status, StatusCode::OK, "bare CID serves its rendition");
        let (status, _, _) = get(&router, &format!("/blob/{fake_cid}/thumbnail")).await;
        assert_eq!(status, StatusCode::OK);
        let (status, _, _) = get(&router, &format!("/blob/{fake_cid}/preview")).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "CID pins the rendition");
        let unknown_cid = records::raw_cid(b"never published").0.to_string();
        let (status, _, _) = get(&router, &format!("/blob/{unknown_cid}")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        // The HoardFS id form keeps working next to it.
        let (status, _, _) = get(&router, &format!("/blob/{}", f.blob_id)).await;
        assert_eq!(status, StatusCode::OK);

        // Conditional request on the record ETag → 304.
        let resp = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/@aliceh/andromeda-nights/manifest.json")
                    .header(header::IF_NONE_MATCH, format!("\"{}\"", result.cid))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_MODIFIED);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn served_bytes_are_stored_until_republished() {
        let f = fixture().await;
        link_did(&f);
        let first = sign_publish(&f, &f.public_collection.id).await.unwrap();
        let router = crate::daemon::router(f.state.clone());
        let (_, _, manifest_before) = get(&router, "/@aliceh/andromeda-nights/manifest.json").await;
        let (_, _, bundle_before) = get(&router, "/@aliceh/andromeda-nights/bundle.json").await;
        assert!(!String::from_utf8_lossy(&bundle_before).contains("Andromeda Galaxy"));

        // Edit the row: nothing served changes (no live rebuild).
        diesel::update(images_table::table.find(&f.image.id))
            .set(images_table::summary.eq(Some("Andromeda Galaxy")))
            .execute(&mut f.state.db.get().unwrap())
            .unwrap();
        let (_, _, manifest_after) = get(&router, "/@aliceh/andromeda-nights/manifest.json").await;
        let (_, _, bundle_after) = get(&router, "/@aliceh/andromeda-nights/bundle.json").await;
        assert_eq!(manifest_before, manifest_after);
        assert_eq!(bundle_before, bundle_after);

        // Re-publish: new CIDs, same URIs (rkey reused), edit visible.
        let rkey_before = image_rkey(&f);
        let second = sign_publish(&f, &f.public_collection.id).await.unwrap();
        assert_eq!(second.uri, first.uri);
        assert_ne!(second.cid, first.cid);
        assert_eq!(image_rkey(&f), rkey_before);
        let (_, headers, bundle) = get(&router, "/@aliceh/andromeda-nights/bundle.json").await;
        assert!(String::from_utf8_lossy(&bundle).contains("Andromeda Galaxy"));
        assert_eq!(
            headers.get(header::ETAG).unwrap().to_str().unwrap(),
            format!("\"{}\"", second.cid)
        );
        // Exactly one collection record + one image record remain.
        let n: i64 = published_records::table
            .filter(published_records::collection_id.eq(&f.public_collection.id))
            .count()
            .get_result(&mut f.state.db.get().unwrap())
            .unwrap();
        assert_eq!(n, 2);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn no_did_or_no_signer_means_legacy_manifest_and_signed_false() {
        let f = fixture().await;
        let token = mint_token(&f.state.db, "alice", "t").unwrap().token;
        let router = crate::daemon::router(f.state.clone());
        let publish_uri = format!("/api/collections/{}/publish", f.public_collection.id);

        // Signer present, no DID: publish works, legacy manifest, no bundle.
        let (status, _, body) = request(&router, "POST", &publish_uri, Some(&token), None).await;
        assert_eq!(status, StatusCode::OK);
        let v = json(&body);
        assert_eq!(v["signed"], false);
        assert!(v.get("record").is_none());
        assert_eq!(v["slug"], "andromeda-nights");
        let (status, headers, body) = get(&router, "/@aliceh/andromeda-nights/manifest.json").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers.get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=10"
        );
        assert_eq!(json(&body)["collectionName"], "Andromeda Nights");
        let (status, _, _) = get(&router, "/@aliceh/andromeda-nights/bundle.json").await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // No signer at all: same legacy behaviour.
        let unsigned = Arc::new(DaemonState {
            db: f.state.db.clone(),
            hoardfs: f.state.hoardfs.clone(),
            oidc: None,
            limits: Default::default(),
            session_key: [7u8; 32],
            processing: Default::default(),
            tetra3_db: None,
            handles: Default::default(),
            signer: None,
            mailer: Arc::new(crate::mail::LogMailer::default()),
            magic: Default::default(),
        });
        link_did(&f);
        let unsigned_router = crate::daemon::router(unsigned);
        let (status, _, body) =
            request(&unsigned_router, "POST", &publish_uri, Some(&token), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json(&body)["signed"], false);
        let (_, headers, _) =
            get(&unsigned_router, "/@aliceh/andromeda-nights/manifest.json").await;
        assert_eq!(
            headers.get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=10"
        );

        // Signer + DID through the real route: signed, record uri/cid back.
        let (status, _, body) = request(&router, "POST", &publish_uri, Some(&token), None).await;
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        let v = json(&body);
        assert_eq!(v["signed"], true);
        assert_eq!(
            v["record"]["uri"],
            format!("at://{DID}/{COLLECTION_NSID}/andromeda-nights")
        );
        assert_eq!(v["record"]["imageCount"], 1);
        let (_, headers, body) = get(&router, "/@aliceh/andromeda-nights/manifest.json").await;
        assert_eq!(
            headers.get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=60"
        );
        assert_eq!(json(&body)["record"]["$type"], COLLECTION_NSID);

        // A body the lexicon rejects aborts the signed publish with 400
        // naming the path; the publish record itself stays.
        diesel::update(collections::table.find(&f.public_collection.id))
            .set(collections::name.eq("x".repeat(301)))
            .execute(&mut f.state.db.get().unwrap())
            .unwrap();
        let (status, _, body) = request(&router, "POST", &publish_uri, Some(&token), None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let v = json(&body);
        assert_eq!(v["error"], "record validation failed");
        assert!(v["paths"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p.as_str().unwrap().contains("title")));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn get_record_by_did_and_handle_and_unpublish_removes_all() {
        let f = fixture().await;
        link_did(&f);
        let result = sign_publish(&f, &f.public_collection.id).await.unwrap();
        let router = crate::daemon::router(f.state.clone());
        let rkey = image_rkey(&f);

        // By DID.
        let (status, headers, body) = get(
            &router,
            &format!(
                "/xrpc/com.atproto.repo.getRecord?repo={DID}&collection={COLLECTION_NSID}&rkey=andromeda-nights"
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers.get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=60"
        );
        let v = json(&body);
        assert_eq!(v["uri"], result.uri);
        assert_eq!(v["cid"], result.cid);
        assert_eq!(v["value"]["$type"], COLLECTION_NSID);
        assert_eq!(v["value"]["title"], "Andromeda Nights");

        // By username as handle stand-in, for the image record.
        let (status, _, body) = get(
            &router,
            &format!(
                "/xrpc/com.atproto.repo.getRecord?repo=aliceh&collection={IMAGE_NSID}&rkey={rkey}"
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let v = json(&body);
        assert_eq!(v["uri"], format!("at://{DID}/{IMAGE_NSID}/{rkey}"));
        assert_eq!(v["value"]["$type"], IMAGE_NSID);
        assert_eq!(v["value"]["filename"], "m31.png");

        // Unknown rkey / repo / collection → 404; missing params → 400.
        for uri in [
            format!("/xrpc/com.atproto.repo.getRecord?repo={DID}&collection={IMAGE_NSID}&rkey=3zzzzzzzzzzzz"),
            format!("/xrpc/com.atproto.repo.getRecord?repo=ghost&collection={COLLECTION_NSID}&rkey=andromeda-nights"),
            format!("/xrpc/com.atproto.repo.getRecord?repo=did:plc:aaaaaaaaaaaaaaaaaaaaaaaa&collection={COLLECTION_NSID}&rkey=andromeda-nights"),
            format!("/xrpc/com.atproto.repo.getRecord?repo={DID}&collection=gallery.astra.profile&rkey=self"),
        ] {
            let (status, _, body) = get(&router, &uri).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
            assert_eq!(json(&body)["error"], "RecordNotFound");
        }
        let (status, _, _) = get(
            &router,
            "/xrpc/com.atproto.repo.getRecord?repo=aliceh&collection=gallery.astra.image",
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _, _) = get(
            &router,
            "/xrpc/com.atproto.repo.getRecord?repo=aliceh&collection=not-an-nsid&rkey=x",
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        // records/{rkey}: bogus rkey 404s; another gallery of the same
        // owner can address the record too (owner-scoped), a stranger's
        // gallery cannot.
        let (status, _, _) = get(&router, "/@aliceh/andromeda-nights/records/3zzzzzzzzzzzz").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _, _) = get(&router, &format!("/@aliceh/drafts/records/{rkey}")).await;
        assert_eq!(status, StatusCode::OK);
        let (status, _, _) = get(&router, &format!("/@ghost/drafts/records/{rkey}")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // Unpublish: records gone, every route 404s, blob CID no longer public.
        let image_signed: SignedRecord<ImageBody> =
            serde_json::from_str(&stored(&f, &format!("at://{DID}/{IMAGE_NSID}/{rkey}"))).unwrap();
        let preview_cid = image_signed.record.body.preview.r#ref.0.to_string();
        let (status, _, _) = get(&router, &format!("/blob/{preview_cid}")).await;
        assert_eq!(status, StatusCode::OK);

        assert!(unpublish_collection_core(&f.state.db, "alice", &f.public_collection.id).unwrap());
        let n: i64 = published_records::table
            .filter(published_records::collection_id.eq(&f.public_collection.id))
            .count()
            .get_result(&mut f.state.db.get().unwrap())
            .unwrap();
        assert_eq!(n, 0);
        for uri in [
            "/@aliceh/andromeda-nights/manifest.json".to_string(),
            "/@aliceh/andromeda-nights/bundle.json".to_string(),
            format!("/@aliceh/andromeda-nights/records/{rkey}"),
            format!("/xrpc/com.atproto.repo.getRecord?repo={DID}&collection={COLLECTION_NSID}&rkey=andromeda-nights"),
            format!("/xrpc/com.atproto.repo.getRecord?repo=aliceh&collection={IMAGE_NSID}&rkey={rkey}"),
            format!("/blob/{preview_cid}"),
        ] {
            let (status, _, _) = get(&router, &uri).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
        }

        // Re-publishing mints nothing new: the same rkey comes back.
        publish_collection_core(
            &f.state.db,
            "alice",
            &f.public_collection.id,
            PublishVisibility::Public,
            None,
        )
        .unwrap();
        let again = sign_publish(&f, &f.public_collection.id).await.unwrap();
        assert_eq!(again.uri, result.uri);
        assert_eq!(image_rkey(&f), rkey);
    }
}
