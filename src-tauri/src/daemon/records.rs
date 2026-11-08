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
//! - `GET /xrpc/com.atproto.repo.listRecords?repo=&collection=&limit=&cursor=`
//!   and `GET /xrpc/com.atproto.repo.describeRepo?repo=` — enumeration for
//!   mirrors: a page of one collection's records (each with its `envelope`,
//!   so the page verifies on its own) and the NSIDs a repo holds.
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
use diesel::prelude::*;
use diesel::SqliteConnection;
use serde::Deserialize;
use serde_json::value::RawValue;

use super::acl;
use super::api::if_none_match_hits;
use super::auth::MaybeViewer;
use super::DaemonState;
use crate::commands::publish::{
    access_for_published, resolve_public_collection, user_id_for_username, Access,
};
use crate::db::models::PublishedRecord;
use crate::db::schema::{published_records, users};
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

/// `GET /xrpc/com.atproto.repo.getRecord` → `{ uri, cid, value, envelope }`.
/// `repo` is the author's DID (exact URI lookup) or their username (the
/// handle stand-in until handles resolve). Unknown → 404 `RecordNotFound`,
/// and so is a private record for a viewer outside its circle. `value` is
/// the stored record bytes; `envelope` (`{ methodId, signedAt, algo, sig }`)
/// is additive to the AT Protocol shape and makes the answer verifiable.
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
            let mut out = String::with_capacity(row.signed_json.len() + 32);
            if let Err(e) = push_list_entry(&mut out, &row) {
                log::error!("getRecord: {e}");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            let mut response = json_bytes_response(out, &row.cid, &headers);
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

// ---------------------------------------------------------------------------
// Enumeration: listRecords / describeRepo (what a mirror walks)
// ---------------------------------------------------------------------------

/// The owner a `repo` parameter names: a DID (exact `users.did` match) or,
/// as the handle stand-in, a username.
struct RepoOwner {
    user_id: String,
    username: Option<String>,
    did: Option<String>,
}

fn resolve_repo(conn: &mut SqliteConnection, repo: &str) -> Result<Option<RepoOwner>, String> {
    let selection = (users::id, users::username, users::did);
    let row: Option<(String, Option<String>, Option<String>)> = if repo.starts_with("did:") {
        users::table
            .filter(users::did.eq(repo))
            .select(selection)
            .first(conn)
            .optional()
    } else {
        users::table
            .filter(users::username.eq(repo))
            .select(selection)
            .first(conn)
            .optional()
    }
    .map_err(|e| e.to_string())?;
    Ok(row.map(|(user_id, username, did)| RepoOwner {
        user_id,
        username,
        did,
    }))
}

fn repo_not_found() -> Response {
    xrpc_error(
        StatusCode::NOT_FOUND,
        "RepoNotFound",
        "no such repo".to_string(),
    )
}

/// The pieces of a stored `SignedRecord` the xrpc routes splice in
/// verbatim. Borrowing `RawValue`s keeps every byte as signed: `record`
/// becomes the AT Protocol `value`, and the signature fields travel as a
/// sibling `envelope` so a mirror can verify without a second fetch.
#[derive(Deserialize)]
struct EnvelopeParts<'a> {
    #[serde(borrow)]
    record: &'a RawValue,
    #[serde(rename = "methodId", borrow)]
    method_id: &'a RawValue,
    #[serde(rename = "signedAt", borrow)]
    signed_at: &'a RawValue,
    #[serde(borrow)]
    algo: &'a RawValue,
    #[serde(borrow)]
    sig: &'a RawValue,
}

impl EnvelopeParts<'_> {
    /// `{ methodId, signedAt, algo, sig }`, each value as stored.
    fn push_envelope(&self, out: &mut String) {
        out.push_str("{\"methodId\":");
        out.push_str(self.method_id.get());
        out.push_str(",\"signedAt\":");
        out.push_str(self.signed_at.get());
        out.push_str(",\"algo\":");
        out.push_str(self.algo.get());
        out.push_str(",\"sig\":");
        out.push_str(self.sig.get());
        out.push('}');
    }
}

/// One `records[]` entry, appended to `out`.
fn push_list_entry(out: &mut String, row: &PublishedRecord) -> Result<(), String> {
    let parts: EnvelopeParts = serde_json::from_str(&row.signed_json)
        .map_err(|e| format!("stored json for {}: {e}", row.uri))?;
    out.push_str("{\"uri\":");
    out.push_str(&serde_json::to_string(&row.uri).map_err(|e| e.to_string())?);
    out.push_str(",\"cid\":");
    out.push_str(&serde_json::to_string(&row.cid).map_err(|e| e.to_string())?);
    out.push_str(",\"value\":");
    out.push_str(parts.record.get());
    out.push_str(",\"envelope\":");
    parts.push_envelope(out);
    out.push('}');
    Ok(())
}

/// Composite JSON (no single record to name): the record cache policy,
/// no ETag.
fn composite_json_response(body: String) -> Response {
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
    response
}

pub const LIST_RECORDS_DEFAULT_LIMIT: u32 = 50;
pub const LIST_RECORDS_MAX_LIMIT: u32 = 100;

#[derive(Debug, Deserialize)]
pub struct ListRecordsParams {
    repo: Option<String>,
    collection: Option<String>,
    limit: Option<u32>,
    cursor: Option<String>,
    reverse: Option<bool>,
}

/// `GET /xrpc/com.atproto.repo.listRecords?repo=&collection=&limit=&cursor=&reverse=`
/// → `{ records: [{ uri, cid, value, envelope }], cursor? }`.
///
/// Pages through the owner's stored records of one collection in rkey
/// order (TIDs sort chronologically; `reverse=true` walks newest first).
/// `cursor` is the last rkey of the previous page and is present only when
/// more rows exist. Rows the viewer may not read are left out silently, so
/// a page may carry fewer entries than `limit` (even none) and still a
/// cursor; walk until the cursor is gone. `envelope`
/// (`{ methodId, signedAt, algo, sig }`, beyond the AT Protocol
/// `{uri, cid, value}` shape) is what makes a listing verifiable on its
/// own. Unknown repo → 404 `RepoNotFound`.
pub async fn xrpc_list_records(
    State(state): State<Arc<DaemonState>>,
    Query(params): Query<ListRecordsParams>,
    viewer: MaybeViewer,
) -> Response {
    let (Some(repo), Some(collection)) = (
        params.repo.filter(|s| !s.is_empty()),
        params.collection.filter(|s| !s.is_empty()),
    ) else {
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "repo and collection are required".to_string(),
        );
    };
    if kenning::record::Nsid::new(collection.as_str()).is_err() {
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "collection must be an NSID".to_string(),
        );
    }
    let limit = params.limit.unwrap_or(LIST_RECORDS_DEFAULT_LIMIT);
    if !(1..=LIST_RECORDS_MAX_LIMIT).contains(&limit) {
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            format!("limit must be between 1 and {LIST_RECORDS_MAX_LIMIT}"),
        );
    }
    if let Some(c) = params.cursor.as_deref() {
        if kenning::record::Rkey::new(c).is_err() {
            return xrpc_error(
                StatusCode::BAD_REQUEST,
                "InvalidRequest",
                "cursor must be a record key".to_string(),
            );
        }
    }
    let reverse = params.reverse.unwrap_or(false);
    let cursor = params.cursor;

    /// A page of rows with their access, and the next cursor if any.
    type Page = (Vec<(PublishedRecord, Access)>, Option<String>);
    let db = state.db.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<Option<Page>, String> {
        let mut conn = db.get().map_err(|e| e.to_string())?;
        let Some(owner) = resolve_repo(&mut conn, &repo)? else {
            return Ok(None);
        };
        let mut query = published_records::table
            .filter(published_records::user_id.eq(&owner.user_id))
            .filter(published_records::collection.eq(&collection))
            .into_boxed();
        if let Some(c) = cursor.as_deref() {
            query = if reverse {
                query.filter(published_records::rkey.lt(c))
            } else {
                query.filter(published_records::rkey.gt(c))
            };
        }
        query = if reverse {
            query.order(published_records::rkey.desc())
        } else {
            query.order(published_records::rkey.asc())
        };
        let mut rows: Vec<PublishedRecord> = query
            .limit(i64::from(limit) + 1)
            .load(&mut conn)
            .map_err(|e| e.to_string())?;
        let next = if rows.len() > limit as usize {
            rows.truncate(limit as usize);
            rows.last().map(|r| r.rkey.clone())
        } else {
            None
        };
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let access = records::access_for_record(&mut conn, &row)?;
            out.push((row, access));
        }
        Ok(Some((out, next)))
    })
    .await;

    let (rows, next) = match result {
        Ok(Ok(Some(page))) => page,
        Ok(Ok(None)) => return repo_not_found(),
        Ok(Err(e)) => {
            log::error!("listRecords: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        Err(e) => {
            log::error!("listRecords task: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let mut body = String::from("{\"records\":[");
    let mut first = true;
    let mut gated = false;
    for (row, access) in &rows {
        match acl::allowed(&state, access, viewer.0.as_ref()).await {
            Ok(true) => {}
            Ok(false) => continue,
            Err(e) => {
                log::error!("listRecords acl: {e}");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        }
        gated |= !access.is_public();
        if !first {
            body.push(',');
        }
        first = false;
        if let Err(e) = push_list_entry(&mut body, row) {
            log::error!("listRecords: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    body.push(']');
    if let Some(c) = next {
        body.push_str(",\"cursor\":");
        match serde_json::to_string(&c) {
            Ok(s) => body.push_str(&s),
            Err(e) => {
                log::error!("listRecords cursor: {e}");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        }
    }
    body.push('}');

    let mut response = composite_json_response(body);
    if gated {
        acl::mark_private(&mut response);
    }
    response
}

#[derive(Debug, Deserialize)]
pub struct DescribeRepoParams {
    repo: Option<String>,
}

/// `GET /xrpc/com.atproto.repo.describeRepo?repo=` →
/// `{ handle, did, didDoc: null, collections, handleIsCorrect }`.
///
/// `collections` lists every NSID the viewer could read at least one
/// record of: all with a public row, plus those whose private rows the
/// kith ACL admits the viewer to. `handle` is the DID document's handle
/// when it verifies (`handles.rs`, bidirectional check); otherwise the
/// username stand-in with `handleIsCorrect: false`. `didDoc` is `null`:
/// resolve the DID yourself, that is the point of it. A user without a DID
/// has no signed repo → 404 `RepoNotFound`.
pub async fn xrpc_describe_repo(
    State(state): State<Arc<DaemonState>>,
    Query(params): Query<DescribeRepoParams>,
    viewer: MaybeViewer,
) -> Response {
    let Some(repo) = params.repo.filter(|s| !s.is_empty()) else {
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "repo is required".to_string(),
        );
    };

    type PrivateByNsid = Vec<(String, Vec<Access>)>;
    let db = state.db.clone();
    let result = tokio::task::spawn_blocking(
        move || -> Result<Option<(RepoOwner, Vec<String>, PrivateByNsid)>, String> {
            let mut conn = db.get().map_err(|e| e.to_string())?;
            let Some(owner) = resolve_repo(&mut conn, &repo)? else {
                return Ok(None);
            };
            if owner.did.is_none() {
                return Ok(None);
            }
            let public: Vec<String> = published_records::table
                .filter(published_records::user_id.eq(&owner.user_id))
                .filter(published_records::private.eq(false))
                .select(published_records::collection)
                .distinct()
                .load(&mut conn)
                .map_err(|e| e.to_string())?;
            let private_nsids: Vec<String> = published_records::table
                .filter(published_records::user_id.eq(&owner.user_id))
                .filter(published_records::private.eq(true))
                .select(published_records::collection)
                .distinct()
                .load(&mut conn)
                .map_err(|e| e.to_string())?;
            let mut private = Vec::with_capacity(private_nsids.len());
            for nsid in private_nsids {
                if public.contains(&nsid) {
                    continue;
                }
                let rows: Vec<PublishedRecord> = published_records::table
                    .filter(published_records::user_id.eq(&owner.user_id))
                    .filter(published_records::private.eq(true))
                    .filter(published_records::collection.eq(&nsid))
                    .load(&mut conn)
                    .map_err(|e| e.to_string())?;
                let mut grants = Vec::with_capacity(rows.len());
                for row in &rows {
                    grants.push(records::access_for_record(&mut conn, row)?);
                }
                private.push((nsid, grants));
            }
            Ok(Some((owner, public, private)))
        },
    )
    .await;

    let (owner, mut collections, private) = match result {
        Ok(Ok(Some(found))) => found,
        Ok(Ok(None)) => return repo_not_found(),
        Ok(Err(e)) => {
            log::error!("describeRepo: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        Err(e) => {
            log::error!("describeRepo task: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let did = owner.did.clone().expect("checked in the blocking task");

    let mut gated = false;
    for (nsid, grants) in private {
        for access in &grants {
            match acl::allowed(&state, access, viewer.0.as_ref()).await {
                Ok(true) => {
                    gated = true;
                    collections.push(nsid.clone());
                    break;
                }
                Ok(false) => {}
                Err(e) => {
                    log::error!("describeRepo acl: {e}");
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            }
        }
    }
    collections.sort();
    collections.dedup();

    let verified = state.handles.verified_handle(&did).await;
    let handle_is_correct = verified.is_some();
    let handle = verified.or(owner.username).unwrap_or_else(|| did.clone());

    let out = serde_json::json!({
        "handle": handle,
        "did": did,
        "didDoc": serde_json::Value::Null,
        "collections": collections,
        "handleIsCorrect": handle_is_correct,
    });
    let mut response = composite_json_response(out.to_string());
    if gated {
        acl::mark_private(&mut response);
    }
    response
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
    use crate::db::schema::{collections, images as images_table};
    use crate::share::records::{CollectionBody, ImageBody, SignedPublish, COLLECTION_NSID};
    use async_trait::async_trait;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
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

    /// Recompute the CID of a listed `value` the way a mirror would: JSON →
    /// IPLD → canonical DAG-CBOR → CIDv1 dag-cbor/sha256.
    fn cid_of_value(value: &serde_json::Value) -> String {
        let ipld = kenning::record::json_to_ipld(value).unwrap();
        let bytes = kenning::record::encode_ipld(&ipld).unwrap();
        kenning::cbor::cid_of_bytes(&bytes).to_string()
    }

    /// `envelope` holds what verifying needs: method, time, curve, signature.
    fn assert_envelope(entry: &serde_json::Value) {
        let env = &entry["envelope"];
        assert_eq!(env["methodId"], "astra");
        assert!(env["signedAt"].as_str().unwrap().ends_with('Z'));
        assert!(matches!(
            env["algo"].as_str().unwrap(),
            "secp256k1" | "p256"
        ));
        assert!(!env["sig"].as_str().unwrap().is_empty());
        assert_eq!(env.as_object().unwrap().len(), 4);
    }

    fn rkeys(v: &serde_json::Value) -> Vec<String> {
        v["records"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                r["uri"]
                    .as_str()
                    .unwrap()
                    .rsplit('/')
                    .next()
                    .unwrap()
                    .to_string()
            })
            .collect()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn list_records_pages_filters_private_rows_and_describe_repo_lists_nsids() {
        let f = fixture().await;
        link_did(&f);
        let token = mint_token(&f.state.db, "alice", "t").unwrap().token;

        // Give the private image an asset so its record gets signed, then
        // publish "Secret" family-only: its collection + image rows are
        // private, the stub is public.
        diesel::update(images_table::table.find(&f.private_image.id))
            .set((
                images_table::blob_id.eq(Some(f.blob_id.clone())),
                images_table::metadata.eq(Some(
                    serde_json::json!({ "hoardfs": { "hfs_path": "/g/m31.png" } }).to_string(),
                )),
            ))
            .execute(&mut f.state.db.get().unwrap())
            .unwrap();
        publish_collection_core(
            &f.state.db,
            "alice",
            &f.private_collection.id,
            PublishVisibility::circle("family").unwrap(),
            None,
        )
        .unwrap();
        let public = sign_publish(&f, &f.public_collection.id).await.unwrap();
        let secret = sign_publish(&f, &f.private_collection.id).await.unwrap();
        assert_eq!(public.image_count, 1);
        assert_eq!(secret.image_count, 1);
        let public_rkey = image_rkey(&f);
        let secret_rkey: String = images_table::table
            .find(&f.private_image.id)
            .select(images_table::rkey)
            .first::<Option<String>>(&mut f.state.db.get().unwrap())
            .unwrap()
            .unwrap();

        let router = crate::daemon::router(f.state.clone());
        let list = |q: &str| format!("/xrpc/com.atproto.repo.listRecords?{q}");

        // Anonymous: only the public image; every cid matches its value.
        let (status, headers, body) = get(
            &router,
            &list(&format!("repo=aliceh&collection={IMAGE_NSID}")),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        assert_eq!(
            headers.get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=60"
        );
        assert!(headers.get(header::ETAG).is_none());
        let v = json(&body);
        assert_eq!(rkeys(&v), vec![public_rkey.clone()]);
        assert!(v.get("cursor").is_none());
        let entry = &v["records"][0];
        assert_eq!(
            entry["uri"],
            format!("at://{DID}/{IMAGE_NSID}/{public_rkey}")
        );
        assert_eq!(
            entry["cid"].as_str().unwrap(),
            cid_of_value(&entry["value"])
        );
        assert_eq!(entry["value"]["$type"], IMAGE_NSID);
        assert_envelope(entry);
        // getRecord carries the same entry shape.
        let (status, _, one) = get(
            &router,
            &format!(
                "/xrpc/com.atproto.repo.getRecord?repo=aliceh&collection={IMAGE_NSID}&rkey={public_rkey}"
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json(&one), *entry);
        // `value` is the stored record bytes, not a re-serialization.
        let stored_json = stored(&f, entry["uri"].as_str().unwrap());
        let record_start = stored_json.find("\"record\":").unwrap() + "\"record\":".len();
        let record_bytes = &stored_json[record_start..stored_json.len() - 1];
        let body_str = String::from_utf8(body.clone()).unwrap();
        assert!(
            body_str.contains(record_bytes),
            "value spliced byte-for-byte"
        );
        // The DID works as `repo` too.
        let (status, _, body_by_did) = get(
            &router,
            &list(&format!("repo={DID}&collection={IMAGE_NSID}")),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body_by_did, body);

        // The owner sees both; the response is viewer-specific.
        let (status, headers, body) = request(
            &router,
            "GET",
            &list(&format!("repo=aliceh&collection={IMAGE_NSID}")),
            Some(&token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers.get(header::CACHE_CONTROL).unwrap(),
            "private, no-store"
        );
        let v = json(&body);
        let mut expected = vec![public_rkey.clone(), secret_rkey.clone()];
        expected.sort();
        assert_eq!(rkeys(&v), expected);
        for entry in v["records"].as_array().unwrap() {
            assert_eq!(
                entry["cid"].as_str().unwrap(),
                cid_of_value(&entry["value"])
            );
            assert_envelope(entry);
        }

        // limit=1 cursor walk, forwards and in reverse.
        let (_, _, body) = request(
            &router,
            "GET",
            &list(&format!("repo=aliceh&collection={IMAGE_NSID}&limit=1")),
            Some(&token),
            None,
        )
        .await;
        let page1 = json(&body);
        assert_eq!(rkeys(&page1), vec![expected[0].clone()]);
        let cursor = page1["cursor"].as_str().expect("more rows → cursor");
        assert_eq!(cursor, expected[0]);
        let (_, _, body) = request(
            &router,
            "GET",
            &list(&format!(
                "repo=aliceh&collection={IMAGE_NSID}&limit=1&cursor={cursor}"
            )),
            Some(&token),
            None,
        )
        .await;
        let page2 = json(&body);
        assert_eq!(rkeys(&page2), vec![expected[1].clone()]);
        assert!(page2.get("cursor").is_none(), "last page has no cursor");
        let (_, _, body) = request(
            &router,
            "GET",
            &list(&format!(
                "repo=aliceh&collection={IMAGE_NSID}&limit=1&reverse=true"
            )),
            Some(&token),
            None,
        )
        .await;
        assert_eq!(rkeys(&json(&body)), vec![expected[1].clone()]);

        // Anonymous page walk over a window holding only a private row:
        // the row is omitted, the cursor still advances.
        let (status, _, body) = get(
            &router,
            &list(&format!("repo=aliceh&collection={IMAGE_NSID}&limit=1")),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let page = json(&body);
        if expected[0] == secret_rkey {
            assert!(page["records"].as_array().unwrap().is_empty());
            assert_eq!(page["cursor"], secret_rkey);
        } else {
            assert_eq!(rkeys(&page), vec![public_rkey.clone()]);
            assert_eq!(page["cursor"], public_rkey);
        }

        // Collections: the public one anonymously, both for the owner; the
        // stub is public.
        let (_, _, body) = get(
            &router,
            &list(&format!("repo=aliceh&collection={COLLECTION_NSID}")),
        )
        .await;
        assert_eq!(rkeys(&json(&body)), vec!["andromeda-nights".to_string()]);
        let (_, _, body) = request(
            &router,
            "GET",
            &list(&format!("repo=aliceh&collection={COLLECTION_NSID}")),
            Some(&token),
            None,
        )
        .await;
        assert_eq!(
            rkeys(&json(&body)),
            vec!["andromeda-nights".to_string(), "secret".to_string()]
        );
        let (_, _, body) = get(
            &router,
            &list(&format!(
                "repo=aliceh&collection={}",
                kenning::private::STUB_NSID
            )),
        )
        .await;
        assert_eq!(rkeys(&json(&body)), vec!["secret".to_string()]);

        // Errors.
        let (status, _, body) =
            get(&router, &list("repo=nobody&collection=gallery.astra.image")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(json(&body)["error"], "RepoNotFound");
        let (status, _, _) = get(&router, &list("repo=aliceh")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _, _) = get(&router, &list("repo=aliceh&collection=not-an-nsid")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _, _) = get(
            &router,
            &list(&format!("repo=aliceh&collection={IMAGE_NSID}&limit=0")),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _, _) = get(
            &router,
            &list(&format!("repo=aliceh&collection={IMAGE_NSID}&limit=101")),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        // An unknown collection of a known repo is an empty page, not 404.
        let (status, _, body) = get(
            &router,
            &list("repo=aliceh&collection=gallery.astra.nothing"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(json(&body)["records"].as_array().unwrap().is_empty());

        // describeRepo, with a resolver that verifies alice's handle.
        use crate::daemon::gallery::tests::{fake_handles, state_with_handles};
        use crate::daemon::handles::tests::HandleAnswer;
        let verified = crate::daemon::router(state_with_handles(
            &f,
            fake_handles(vec!["alice.example"], HandleAnswer::Did(DID)),
        ));
        let (status, headers, body) =
            get(&verified, "/xrpc/com.atproto.repo.describeRepo?repo=aliceh").await;
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        assert_eq!(
            headers.get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=60"
        );
        let v = json(&body);
        assert_eq!(v["did"], DID);
        assert_eq!(v["handle"], "alice.example");
        assert_eq!(v["handleIsCorrect"], true);
        assert!(v["didDoc"].is_null());
        // Image and collection NSIDs have public rows; the private rows add
        // nothing new for an anonymous viewer.
        assert_eq!(
            v["collections"],
            serde_json::json!([COLLECTION_NSID, IMAGE_NSID, kenning::private::STUB_NSID])
        );
        let (status, _, body) = get(
            &verified,
            &format!("/xrpc/com.atproto.repo.describeRepo?repo={DID}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json(&body)["did"], DID);

        // Unverifiable handle: the username stand-in, flagged.
        let unverified = crate::daemon::router(state_with_handles(
            &f,
            fake_handles(vec!["alice.example"], HandleAnswer::NotFound),
        ));
        let (_, _, body) = get(
            &unverified,
            "/xrpc/com.atproto.repo.describeRepo?repo=aliceh",
        )
        .await;
        let v = json(&body);
        assert_eq!(v["handle"], "aliceh");
        assert_eq!(v["handleIsCorrect"], false);

        // Unknown user, and a user without a DID, are not repos.
        let (status, _, body) =
            get(&verified, "/xrpc/com.atproto.repo.describeRepo?repo=nobody").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(json(&body)["error"], "RepoNotFound");
        diesel::update(users::table.find("alice"))
            .set(users::did.eq(None::<String>))
            .execute(&mut f.state.db.get().unwrap())
            .unwrap();
        let (status, _, _) =
            get(&verified, "/xrpc/com.atproto.repo.describeRepo?repo=aliceh").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
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
        // The planted row names the blob HoardFS really serves for the
        // thumbnail (the original: a 40x40 source gets no renditions), so
        // the serving guard trusts it without hashing.
        let fake_cid = records::raw_cid(b"not the preview").0.to_string();
        diesel::replace_into(crate::db::schema::blob_digests::table)
            .values(crate::db::models::BlobDigest {
                blob_id: f.blob_id.clone(),
                quality: "thumbnail".into(),
                cid: fake_cid.clone(),
                sha256: "00".into(),
                size: 1,
                mime: "image/jpeg".into(),
                variant_blob_id: Some(f.blob_id.clone()),
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
            tetra3_cache: Default::default(),
            uploads_dir: std::env::temp_dir().join("astra-test-uploads"),
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
