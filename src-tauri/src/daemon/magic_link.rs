//! Magic-link sign-in for custodial viewers (family members whose DID the
//! host minted and who will never install anything or run an OIDC login).
//! Design: kenning `docs/private-store.md` §3 and its review decisions.
//!
//! # Flow
//!
//! 1. `POST /auth/magic/request {"email"}` (public, rate limited). Always
//!    `200 {}` — the response never says whether the address is known.
//!    When a user with that email and a `users.did` exists, a one-time
//!    token (32 random bytes) is minted, its SHA-256 stored in
//!    `magic_tokens` with a 15 minute expiry (replacing any outstanding
//!    token for that user), and `{ASTRA_PUBLIC_URL}/auth/magic/{token}` is
//!    emailed through [`crate::mail::Mailer`].
//! 2. `GET /auth/magic/{token}[?next=/@owner/slug]` redeems it once: the
//!    row is marked used, a `viewer_sessions` row is created, and the
//!    **same** `astra_session` cookie the OIDC flow sets is issued, so
//!    [`super::auth::AuthedUser`] / [`super::auth::MaybeViewer`] and the
//!    circle ACL work unchanged. 303 to `next` when it is a same-origin
//!    absolute path, else to the viewer's profile. Anything else → 404.
//!
//! # Sessions
//!
//! The OIDC cookie is stateless; a magic-link session is a row so it can
//! be **30 days sliding** and **revocable**. The cookie's subject is
//! `sess:<row id>` (the signed cookie format is unchanged) with a hard cap
//! of one year; the row's `expires_at` is the real lifetime and moves to
//! `now + 30 days` on the first authenticated request of each day
//! (`last_seen_at` records the touch). `POST /auth/logout` deletes the row
//! and clears the cookie; `DELETE /api/admin/sessions/{user_id}` (owner
//! only) deletes every session and outstanding token of a user.
//!
//! Remembering a device beyond the session (a long-lived "this is
//! grandma's iPad" cookie) is deliberately not implemented — deferred by
//! the review decision until plain magic links have been lived with.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::Json;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
use chrono::{NaiveDateTime, Utc};
use diesel::prelude::*;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::auth::{authenticate_session_user, AuthError, AuthedUser};
use super::session::{self, mint_cookie_value, verify_cookie_value};
use super::DaemonState;
use crate::db::schema::{magic_tokens, users, viewer_sessions};
use crate::db::tenancy::UserRole;
use crate::db::DbPool;

/// A sign-in link is good for this long.
pub const TOKEN_TTL_SECS: i64 = 15 * 60;
/// A viewer session lives this long after its last touch.
pub const SESSION_TTL_SECS: i64 = 30 * 24 * 3600;
/// Touch (and slide) at most once per this interval, to keep the write
/// off the hot path of every image request.
pub const SESSION_TOUCH_INTERVAL_SECS: i64 = 24 * 3600;
/// The signed cookie's own expiry: an upper bound the row can never
/// slide past. Browsers cap cookie lifetimes around 400 days anyway.
pub const COOKIE_HARD_CAP_SECS: i64 = 365 * 24 * 3600;
/// Cookie subjects with this prefix name a `viewer_sessions` row rather
/// than a user id (the OIDC cookie carries the bare user id).
pub const SESSION_SUBJECT_PREFIX: &str = "sess:";
/// Requests per [`RATE_WINDOW`] allowed per client IP and per email.
pub const RATE_LIMIT: usize = 5;
pub const RATE_WINDOW: Duration = Duration::from_secs(3600);

pub const PUBLIC_URL_ENV: &str = crate::share::records::PUBLIC_URL_ENV;

/// Per-daemon magic-link state: where links point and who asked lately.
#[derive(Debug)]
pub struct MagicLinkState {
    /// Base URL written into every link (`ASTRA_PUBLIC_URL`, no trailing
    /// slash). Defaults to the local bind address.
    pub public_url: String,
    limiter: Mutex<RateLimiter>,
}

impl Default for MagicLinkState {
    fn default() -> Self {
        Self::new(format!("http://{}", super::DEFAULT_BIND))
    }
}

impl MagicLinkState {
    pub fn new(public_url: impl Into<String>) -> Self {
        let public_url = public_url.into();
        Self {
            public_url: public_url.trim_end_matches('/').to_string(),
            limiter: Mutex::new(RateLimiter::default()),
        }
    }

    /// `ASTRA_PUBLIC_URL`, else the default. Warns when unset: a link to
    /// `127.0.0.1` is useless to anyone but the operator.
    pub fn from_env() -> Self {
        match std::env::var(PUBLIC_URL_ENV) {
            Ok(url) if !url.trim().is_empty() => Self::new(url),
            _ => {
                log::warn!("{PUBLIC_URL_ENV} not set — magic links will point at the bind address");
                Self::default()
            }
        }
    }

    fn allow(&self, key: String) -> bool {
        match self.limiter.lock() {
            Ok(mut limiter) => limiter.allow(key, Instant::now()),
            Err(_) => false,
        }
    }
}

/// Sliding-window counter: at most [`RATE_LIMIT`] hits per key per
/// [`RATE_WINDOW`]. In memory, so a restart forgets — acceptable for a
/// limit whose only job is to keep one address from being spammed.
#[derive(Debug, Default)]
struct RateLimiter {
    hits: HashMap<String, Vec<Instant>>,
}

impl RateLimiter {
    fn allow(&mut self, key: String, now: Instant) -> bool {
        if self.hits.len() > 10_000 {
            // Keep the map bounded: drop keys with nothing recent.
            self.hits.retain(|_, v| {
                v.retain(|t| now.duration_since(*t) < RATE_WINDOW);
                !v.is_empty()
            });
        }
        let hits = self.hits.entry(key).or_default();
        hits.retain(|t| now.duration_since(*t) < RATE_WINDOW);
        if hits.len() >= RATE_LIMIT {
            return false;
        }
        hits.push(now);
        true
    }
}

fn now_naive() -> NaiveDateTime {
    Utc::now().naive_utc()
}

pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}

/// The client as the rate limiter sees it: the first `X-Forwarded-For`
/// hop (the daemon sits behind the hub Caddy), else `X-Real-IP`, else a
/// single bucket for direct connections.
fn client_key(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            headers
                .get("x-real-ip")
                .and_then(|v| v.to_str().ok())
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .unwrap_or("direct")
        .to_string()
}

/// Blocking: mint a token for the user with this email **if** they exist
/// and hold a DID. Returns the plaintext token and the recipient address
/// as stored; `None` means "send nothing" (unknown address, or no DID).
/// Any outstanding token for the user is replaced.
pub fn issue_token(db: &DbPool, email: &str) -> Result<Option<(String, String)>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    let normalized = normalize_email(email);
    if normalized.is_empty() {
        return Ok(None);
    }
    let row: Option<(String, Option<String>, Option<String>)> = users::table
        .filter(
            diesel::dsl::sql::<diesel::sql_types::Bool>("lower(email) = ")
                .bind::<diesel::sql_types::Text, _>(normalized),
        )
        .select((users::id, users::email, users::did))
        .first(&mut conn)
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((user_id, Some(stored_email), Some(_did))) = row else {
        return Ok(None);
    };

    let mut secret = [0u8; 32];
    getrandom::fill(&mut secret).map_err(|e| format!("random source: {e}"))?;
    let token = B64URL.encode(secret);
    let now = now_naive();
    let expires_at = now + chrono::Duration::seconds(TOKEN_TTL_SECS);

    conn.transaction::<_, diesel::result::Error, _>(|conn| {
        diesel::delete(magic_tokens::table.filter(magic_tokens::user_id.eq(&user_id)))
            .execute(conn)?;
        diesel::insert_into(magic_tokens::table)
            .values((
                magic_tokens::token_hash.eq(hash_token(&token)),
                magic_tokens::user_id.eq(&user_id),
                magic_tokens::expires_at.eq(expires_at),
                magic_tokens::created_at.eq(now),
            ))
            .execute(conn)?;
        Ok(())
    })
    .map_err(|e| format!("store magic token: {e}"))?;

    Ok(Some((token, stored_email)))
}

/// Blocking: create a viewer session row; returns its id.
pub fn create_session(db: &DbPool, user_id: &str) -> Result<String, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_naive();
    diesel::insert_into(viewer_sessions::table)
        .values((
            viewer_sessions::id.eq(&id),
            viewer_sessions::user_id.eq(user_id),
            viewer_sessions::created_at.eq(now),
            viewer_sessions::last_seen_at.eq(now),
            viewer_sessions::expires_at.eq(now + chrono::Duration::seconds(SESSION_TTL_SECS)),
        ))
        .execute(&mut conn)
        .map_err(|e| format!("create viewer session: {e}"))?;
    Ok(id)
}

/// The `astra_session` cookie value naming a viewer session.
pub fn session_cookie_value(key: &[u8], session_id: &str) -> String {
    mint_cookie_value(
        key,
        &format!("{SESSION_SUBJECT_PREFIX}{session_id}"),
        Utc::now().timestamp() + COOKIE_HARD_CAP_SECS,
    )
}

/// The `Set-Cookie` header for a viewer session.
pub fn session_set_cookie(key: &[u8], session_id: &str) -> String {
    session::set_cookie(&session_cookie_value(key, session_id), COOKIE_HARD_CAP_SECS)
}

/// Blocking: resolve a `sess:<id>` cookie subject to its active user.
/// Expired rows are deleted on sight; a live row is touched (and its
/// expiry slid forward) when last seen more than
/// [`SESSION_TOUCH_INTERVAL_SECS`] ago. The user's status is re-checked
/// like every other credential.
pub fn authenticate_session(db: &DbPool, session_id: &str) -> Result<AuthedUser, AuthError> {
    let mut conn = db.get().map_err(|e| AuthError::Db(e.to_string()))?;
    let row: Option<(String, NaiveDateTime, NaiveDateTime)> = viewer_sessions::table
        .find(session_id)
        .select((
            viewer_sessions::user_id,
            viewer_sessions::last_seen_at,
            viewer_sessions::expires_at,
        ))
        .first(&mut conn)
        .optional()
        .map_err(|e| AuthError::Db(e.to_string()))?;
    let (user_id, last_seen_at, expires_at) = row.ok_or(AuthError::InvalidToken)?;
    let now = now_naive();
    if expires_at <= now {
        let _ = diesel::delete(viewer_sessions::table.find(session_id)).execute(&mut conn);
        return Err(AuthError::InvalidToken);
    }
    if now - last_seen_at >= chrono::Duration::seconds(SESSION_TOUCH_INTERVAL_SECS) {
        // Best-effort: a failed touch must not fail the request.
        let _ = diesel::update(viewer_sessions::table.find(session_id))
            .set((
                viewer_sessions::last_seen_at.eq(now),
                viewer_sessions::expires_at.eq(now + chrono::Duration::seconds(SESSION_TTL_SECS)),
            ))
            .execute(&mut conn);
    }
    drop(conn);
    authenticate_session_user(db, &user_id)
}

/// Blocking: delete the viewer session a request's cookie names, if any.
/// Returns whether a row was deleted. OIDC cookies (bare user id) have
/// no row and are simply cleared client-side by the caller.
pub fn revoke_cookie_session(state: &DaemonState, headers: &HeaderMap) -> bool {
    let Some(cookie) = session::cookie_from_headers(headers) else {
        return false;
    };
    let Some(subject) = verify_cookie_value(&state.session_key, &cookie, Utc::now().timestamp())
    else {
        return false;
    };
    let Some(session_id) = subject.strip_prefix(SESSION_SUBJECT_PREFIX) else {
        return false;
    };
    let Ok(mut conn) = state.db.get() else {
        return false;
    };
    diesel::delete(viewer_sessions::table.find(session_id))
        .execute(&mut conn)
        .map(|n| n > 0)
        .unwrap_or(false)
}

/// Blocking: delete every viewer session and unused magic token of a
/// user. Returns the number of sessions removed.
pub fn revoke_user_sessions(db: &DbPool, user_id: &str) -> Result<usize, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    let sessions =
        diesel::delete(viewer_sessions::table.filter(viewer_sessions::user_id.eq(user_id)))
            .execute(&mut conn)
            .map_err(|e| e.to_string())?;
    diesel::delete(
        magic_tokens::table
            .filter(magic_tokens::user_id.eq(user_id))
            .filter(magic_tokens::used_at.is_null()),
    )
    .execute(&mut conn)
    .map_err(|e| e.to_string())?;
    Ok(sessions)
}

#[derive(Debug, Deserialize)]
pub struct RequestBody {
    pub email: String,
}

fn empty_ok() -> Response {
    (StatusCode::OK, Json(serde_json::json!({}))).into_response()
}

/// The emailed message. Plain text; the link is the whole point.
fn link_email(url: &str) -> (String, String) {
    let subject = "Your Astra sign-in link".to_string();
    let text = format!(
        "Hello,\n\nUse this link to sign in to Astra:\n\n{url}\n\n\
         It works once and expires in {} minutes. If you did not ask for it, \
         you can ignore this email.\n",
        TOKEN_TTL_SECS / 60
    );
    (subject, text)
}

/// `POST /auth/magic/request {"email": "..."}` → `200 {}` always.
pub async fn request(
    State(state): State<Arc<DaemonState>>,
    headers: HeaderMap,
    Json(body): Json<RequestBody>,
) -> Response {
    let email = normalize_email(&body.email);
    if email.is_empty() || email.len() > 320 {
        return empty_ok();
    }
    let client = client_key(&headers);
    if !state.magic.allow(format!("ip:{client}")) || !state.magic.allow(format!("email:{email}")) {
        log::info!("magic link request rate limited (client {client})");
        return empty_ok();
    }

    let db = state.db.clone();
    let issued = tokio::task::spawn_blocking(move || issue_token(&db, &email)).await;
    let (token, to) = match issued {
        Ok(Ok(Some(issued))) => issued,
        Ok(Ok(None)) => return empty_ok(),
        Ok(Err(e)) => {
            log::error!("magic link issue failed: {e}");
            return empty_ok();
        }
        Err(e) => {
            log::error!("magic link task panicked: {e}");
            return empty_ok();
        }
    };

    let url = format!("{}/auth/magic/{token}", state.magic.public_url);
    let (subject, text) = link_email(&url);
    if let Err(e) = state.mailer.send(&to, &subject, &text).await {
        // The token is still live; the user can simply request again.
        log::error!("magic link email failed: {e}");
    }
    empty_ok()
}

#[derive(Debug, Deserialize)]
pub struct RedeemQuery {
    pub next: Option<String>,
}

/// Where to send the browser after sign-in: `next` only when it is an
/// absolute same-origin path (`/...` but not `//host` or `/\host`),
/// otherwise the viewer's own profile.
fn redirect_target(next: Option<&str>, username: Option<&str>) -> String {
    if let Some(next) = next {
        let safe = next.starts_with('/')
            && !next.starts_with("//")
            && !next.starts_with("/\\")
            && !next.chars().any(|c| c.is_control() || c.is_whitespace());
        if safe {
            return next.to_string();
        }
    }
    match username {
        Some(name) if !name.is_empty() => format!("/@{name}"),
        _ => "/".to_string(),
    }
}

/// Blocking: redeem a token. `Ok(None)` for unknown, used or expired.
/// Returns the new session id and the user's username.
pub fn redeem_token(db: &DbPool, token: &str) -> Result<Option<(String, Option<String>)>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    let hash = hash_token(token);
    let now = now_naive();
    let user_id: Option<String> = conn
        .transaction::<_, diesel::result::Error, _>(|conn| {
            let row: Option<(String, NaiveDateTime, Option<NaiveDateTime>)> = magic_tokens::table
                .find(&hash)
                .select((
                    magic_tokens::user_id,
                    magic_tokens::expires_at,
                    magic_tokens::used_at,
                ))
                .first(conn)
                .optional()?;
            let Some((user_id, expires_at, used_at)) = row else {
                return Ok(None);
            };
            if used_at.is_some() || expires_at <= now {
                return Ok(None);
            }
            let marked = diesel::update(
                magic_tokens::table
                    .find(&hash)
                    .filter(magic_tokens::used_at.is_null()),
            )
            .set(magic_tokens::used_at.eq(Some(now)))
            .execute(conn)?;
            Ok((marked == 1).then_some(user_id))
        })
        .map_err(|e| format!("redeem magic token: {e}"))?;
    let Some(user_id) = user_id else {
        return Ok(None);
    };
    drop(conn);
    let session_id = create_session(db, &user_id)?;
    let username: Option<String> = users::table
        .find(&user_id)
        .select(users::username)
        .first::<Option<String>>(&mut db.get().map_err(|e| e.to_string())?)
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    Ok(Some((session_id, username)))
}

fn link_not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Html(
            "<!doctype html><title>Sign-in link not valid</title>\
             <p>This sign-in link is not valid: it was already used, has expired, \
             or never existed. Ask for a new one.</p>",
        ),
    )
        .into_response()
}

/// `GET /auth/magic/{token}[?next=/path]`.
pub async fn redeem(
    State(state): State<Arc<DaemonState>>,
    Path(token): Path<String>,
    Query(query): Query<RedeemQuery>,
) -> Response {
    if token.is_empty() || token.len() > 128 {
        return link_not_found();
    }
    let db = state.db.clone();
    let redeemed = tokio::task::spawn_blocking(move || redeem_token(&db, &token)).await;
    let (session_id, username) = match redeemed {
        Ok(Ok(Some(r))) => r,
        Ok(Ok(None)) => return link_not_found(),
        Ok(Err(e)) => {
            log::error!("magic link redeem failed: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        Err(e) => {
            log::error!("magic link redeem task panicked: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let target = redirect_target(query.next.as_deref(), username.as_deref());
    let mut response = Redirect::to(&target).into_response();
    if let Ok(value) = session_set_cookie(&state.session_key, &session_id).parse() {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response
}

/// `POST /auth/logout` → 204, clears the cookie and deletes the viewer
/// session it named (OIDC cookies are stateless and just cleared).
pub async fn logout(State(state): State<Arc<DaemonState>>, headers: HeaderMap) -> Response {
    let st = state.clone();
    let _ = tokio::task::spawn_blocking(move || revoke_cookie_session(&st, &headers)).await;
    let mut response = StatusCode::NO_CONTENT.into_response();
    if let Ok(value) = session::set_cookie("", 0).parse() {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

/// `DELETE /api/admin/sessions/{user_id}` (owner only) →
/// `200 {"userId", "revokedSessions"}`. Every viewer session and unused
/// magic token of that user is gone on the next request.
pub async fn admin_revoke_sessions(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(user_id): Path<String>,
) -> Response {
    if user.role != UserRole::Owner {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "forbidden", "message": "owner only" })),
        )
            .into_response();
    }
    let db = state.db.clone();
    let target = user_id.clone();
    match tokio::task::spawn_blocking(move || revoke_user_sessions(&db, &target)).await {
        Ok(Ok(n)) => {
            Json(serde_json::json!({ "userId": user_id, "revokedSessions": n })).into_response()
        }
        Ok(Err(e)) => {
            log::error!("revoke sessions failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            log::error!("revoke sessions task panicked: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::auth::mint_token;
    use crate::daemon::session::COOKIE_NAME;
    use crate::db::tenancy::UserRole;
    use crate::db::test_support::{insert_user, test_pool};
    use crate::mail::LogMailer;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use tower::ServiceExt;

    const BOB_DID: &str = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";

    struct Harness {
        state: Arc<DaemonState>,
        router: axum::Router,
        mail: Arc<LogMailer>,
        _tmp: tempfile::TempDir,
    }

    /// alice (owner, no email), bob (member, bob@example.org, DID),
    /// dan (member, dan@example.org, **no** DID). Links point at
    /// `https://astra.test`.
    async fn harness() -> Harness {
        let tmp = tempfile::tempdir().unwrap();
        let hfs = hoardfs_volume::HoardFs::init(&tmp.path().join("hoardfs"))
            .await
            .unwrap();
        let mail = LogMailer::shared();
        let db = test_pool();
        insert_user(&db, "alice");
        insert_user(&db, "bob");
        insert_user(&db, "dan");
        {
            let mut conn = db.get().unwrap();
            diesel::update(users::table.find("alice"))
                .set((
                    users::username.eq(Some("aliceh")),
                    users::role.eq(UserRole::Owner.as_str()),
                ))
                .execute(&mut conn)
                .unwrap();
            diesel::update(users::table.find("bob"))
                .set((
                    users::username.eq(Some("bobh")),
                    users::email.eq(Some("Bob@Example.org")),
                    users::did.eq(Some(BOB_DID)),
                ))
                .execute(&mut conn)
                .unwrap();
            diesel::update(users::table.find("dan"))
                .set(users::email.eq(Some("dan@example.org")))
                .execute(&mut conn)
                .unwrap();
        }
        let state = Arc::new(DaemonState {
            db,
            hoardfs: Arc::new(Mutex::new(hfs)),
            oidc: None,
            limits: Default::default(),
            session_key: [7u8; 32],
            processing: Default::default(),
            tetra3_db: None,
            handles: Default::default(),
            signer: None,
            mailer: mail.clone(),
            magic: MagicLinkState::new("https://astra.test/"),
        });
        let router = crate::daemon::router(state.clone());
        Harness {
            state,
            router,
            mail,
            _tmp: tmp,
        }
    }

    async fn request_link(h: &Harness, email: &str, forwarded_for: Option<&str>) -> StatusCode {
        let mut req = Request::builder()
            .method("POST")
            .uri("/auth/magic/request")
            .header("Content-Type", "application/json");
        if let Some(ip) = forwarded_for {
            req = req.header("X-Forwarded-For", ip);
        }
        let resp = h
            .router
            .clone()
            .oneshot(
                req.body(Body::from(
                    serde_json::json!({ "email": email }).to_string(),
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        let status = resp.status();
        let body = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({})
        );
        status
    }

    fn token_rows(db: &DbPool) -> Vec<(String, String, Option<NaiveDateTime>)> {
        magic_tokens::table
            .select((
                magic_tokens::token_hash,
                magic_tokens::user_id,
                magic_tokens::used_at,
            ))
            .load(&mut db.get().unwrap())
            .unwrap()
    }

    fn session_rows(db: &DbPool, user_id: &str) -> Vec<(String, NaiveDateTime, NaiveDateTime)> {
        viewer_sessions::table
            .filter(viewer_sessions::user_id.eq(user_id))
            .select((
                viewer_sessions::id,
                viewer_sessions::last_seen_at,
                viewer_sessions::expires_at,
            ))
            .load(&mut db.get().unwrap())
            .unwrap()
    }

    /// The token in the last captured email.
    fn last_token(h: &Harness) -> String {
        let mail = h.mail.sent().pop().expect("a mail was captured");
        let line = mail
            .text
            .lines()
            .find(|l| l.contains("/auth/magic/"))
            .expect("link line");
        assert!(line.starts_with("https://astra.test/auth/magic/"), "{line}");
        line.rsplit('/').next().unwrap().to_string()
    }

    async fn redeem_with(h: &Harness, uri: &str) -> (StatusCode, HeaderMap) {
        let resp = h
            .router
            .clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        (resp.status(), resp.headers().clone())
    }

    fn cookie_of(headers: &HeaderMap) -> String {
        let set = headers
            .get(header::SET_COOKIE)
            .expect("Set-Cookie")
            .to_str()
            .unwrap();
        assert!(set.contains("HttpOnly") && set.contains("Secure"), "{set}");
        assert!(
            set.contains("SameSite=Lax") && set.contains("Path=/"),
            "{set}"
        );
        set.split(';')
            .next()
            .unwrap()
            .strip_prefix(&format!("{COOKIE_NAME}="))
            .unwrap()
            .to_string()
    }

    async fn me_with_cookie(h: &Harness, cookie: &str) -> (StatusCode, serde_json::Value) {
        let resp = h
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/me")
                    .header(header::COOKIE, format!("{COOKIE_NAME}={cookie}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = resp.status();
        let body = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        (
            status,
            serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null),
        )
    }

    /// Request + redeem for bob; returns his session cookie value.
    async fn sign_in_bob(h: &Harness) -> String {
        assert_eq!(
            request_link(h, "bob@example.org", None).await,
            StatusCode::OK
        );
        let token = last_token(h);
        let (status, headers) = redeem_with(h, &format!("/auth/magic/{token}")).await;
        assert_eq!(status, StatusCode::SEE_OTHER);
        cookie_of(&headers)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn unknown_email_gets_200_and_nothing_else() {
        let h = harness().await;
        assert_eq!(
            request_link(&h, "nobody@example.org", None).await,
            StatusCode::OK
        );
        assert!(token_rows(&h.state.db).is_empty());
        assert!(h.mail.sent().is_empty());
        // Blank / malformed input is equally silent.
        assert_eq!(request_link(&h, "   ", None).await, StatusCode::OK);
        assert!(h.mail.sent().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn known_user_with_did_gets_a_hashed_token_and_one_email() {
        let h = harness().await;
        // Case-insensitive match against the stored "Bob@Example.org".
        assert_eq!(
            request_link(&h, "  BOB@example.ORG ", None).await,
            StatusCode::OK
        );
        let sent = h.mail.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].to, "Bob@Example.org");
        assert!(sent[0].subject.contains("sign-in"));
        let token = last_token(&h);
        assert_eq!(token.len(), 43, "32 bytes base64url, no padding");

        let rows = token_rows(&h.state.db);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].1, "bob");
        assert!(rows[0].2.is_none());
        assert_ne!(rows[0].0, token, "plaintext must not be stored");
        assert_eq!(rows[0].0, hash_token(&token));

        // A second request replaces the outstanding token.
        assert_eq!(
            request_link(&h, "bob@example.org", None).await,
            StatusCode::OK
        );
        let rows = token_rows(&h.state.db);
        assert_eq!(rows.len(), 1);
        assert_ne!(rows[0].0, hash_token(&token));
        assert_eq!(h.mail.sent().len(), 2);
        // The replaced token no longer redeems.
        let (status, _) = redeem_with(&h, &format!("/auth/magic/{token}")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn user_without_did_gets_nothing() {
        let h = harness().await;
        assert_eq!(
            request_link(&h, "dan@example.org", None).await,
            StatusCode::OK
        );
        assert!(token_rows(&h.state.db).is_empty());
        assert!(h.mail.sent().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn redeem_sets_cookie_creates_session_and_is_single_use() {
        let h = harness().await;
        assert_eq!(
            request_link(&h, "bob@example.org", None).await,
            StatusCode::OK
        );
        let token = last_token(&h);

        let (status, headers) = redeem_with(&h, &format!("/auth/magic/{token}")).await;
        assert_eq!(status, StatusCode::SEE_OTHER);
        assert_eq!(headers.get(header::LOCATION).unwrap(), "/@bobh");
        let cookie = cookie_of(&headers);
        let sessions = session_rows(&h.state.db, "bob");
        assert_eq!(sessions.len(), 1);
        assert!(
            verify_cookie_value(&h.state.session_key, &cookie, Utc::now().timestamp())
                .unwrap()
                .ends_with(&sessions[0].0)
        );
        // The token row is marked used, not deleted (audit).
        let rows = token_rows(&h.state.db);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].2.is_some());

        // The same cookie the OIDC flow sets: AuthedUser works unchanged.
        let (status, me) = me_with_cookie(&h, &cookie).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(me["userId"], "bob");

        // Second use → 404 with a plain message.
        let (status, _) = redeem_with(&h, &format!("/auth/magic/{token}")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        // Garbage → 404 too.
        let (status, _) = redeem_with(&h, "/auth/magic/not-a-token").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn expired_token_is_rejected() {
        let h = harness().await;
        assert_eq!(
            request_link(&h, "bob@example.org", None).await,
            StatusCode::OK
        );
        let token = last_token(&h);
        diesel::update(magic_tokens::table)
            .set(magic_tokens::expires_at.eq(now_naive() - chrono::Duration::seconds(1)))
            .execute(&mut h.state.db.get().unwrap())
            .unwrap();
        let (status, headers) = redeem_with(&h, &format!("/auth/magic/{token}")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(headers.get(header::SET_COOKIE).is_none());
        assert!(session_rows(&h.state.db, "bob").is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn next_is_honoured_only_for_same_origin_paths() {
        let h = harness().await;
        for (next, expected) in [
            ("/@aliceh/andromeda-nights", "/@aliceh/andromeda-nights"),
            ("//evil.example", "/@bobh"),
            ("https://evil.example/x", "/@bobh"),
            ("/\\evil.example", "/@bobh"),
            ("relative", "/@bobh"),
        ] {
            assert_eq!(
                request_link(&h, "bob@example.org", None).await,
                StatusCode::OK
            );
            let token = last_token(&h);
            let encoded: String = url_encode(next);
            let (status, headers) =
                redeem_with(&h, &format!("/auth/magic/{token}?next={encoded}")).await;
            assert_eq!(status, StatusCode::SEE_OTHER, "{next}");
            assert_eq!(headers.get(header::LOCATION).unwrap(), expected, "{next}");
        }
        // Pure function check, including a user with no username.
        assert_eq!(redirect_target(None, None), "/");
        assert_eq!(redirect_target(Some("/x\n"), Some("u")), "/@u");
    }

    fn url_encode(s: &str) -> String {
        let mut out = String::new();
        for b in s.bytes() {
            match b {
                b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    out.push(b as char)
                }
                _ => out.push_str(&format!("%{b:02X}")),
            }
        }
        out
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn session_expiry_slides_once_a_day_and_expired_rows_die() {
        let h = harness().await;
        let cookie = sign_in_bob(&h).await;
        let (sid, _, fresh_expiry) = session_rows(&h.state.db, "bob").remove(0);

        // Immediately after sign-in: no touch (within the interval).
        let (status, _) = me_with_cookie(&h, &cookie).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(session_rows(&h.state.db, "bob")[0].2, fresh_expiry);

        // Last seen two days ago with 20 days left → slides to ~30 days.
        let now = now_naive();
        diesel::update(viewer_sessions::table.find(&sid))
            .set((
                viewer_sessions::last_seen_at.eq(now - chrono::Duration::days(2)),
                viewer_sessions::expires_at.eq(now + chrono::Duration::days(20)),
            ))
            .execute(&mut h.state.db.get().unwrap())
            .unwrap();
        let (status, _) = me_with_cookie(&h, &cookie).await;
        assert_eq!(status, StatusCode::OK);
        let (_, last_seen, expires) = session_rows(&h.state.db, "bob").remove(0);
        assert!(expires > now + chrono::Duration::days(29), "{expires}");
        assert!(
            last_seen >= now - chrono::Duration::seconds(5),
            "{last_seen}"
        );

        // Past expiry → 401 and the row is gone.
        diesel::update(viewer_sessions::table.find(&sid))
            .set(viewer_sessions::expires_at.eq(now - chrono::Duration::seconds(1)))
            .execute(&mut h.state.db.get().unwrap())
            .unwrap();
        let (status, _) = me_with_cookie(&h, &cookie).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(session_rows(&h.state.db, "bob").is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn logout_clears_cookie_and_deletes_the_session() {
        let h = harness().await;
        let cookie = sign_in_bob(&h).await;
        let resp = h
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/auth/logout")
                    .header(header::COOKIE, format!("{COOKIE_NAME}={cookie}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        let set = resp
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(
            set.starts_with(&format!("{COOKIE_NAME}=;")) && set.contains("Max-Age=0"),
            "{set}"
        );
        assert!(session_rows(&h.state.db, "bob").is_empty());
        // A replayed cookie is dead server-side, whatever the browser kept.
        let (status, _) = me_with_cookie(&h, &cookie).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        // DELETE /api/session does the same for a magic-link cookie.
        let cookie = sign_in_bob(&h).await;
        let resp = h
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/session")
                    .header(header::COOKIE, format!("{COOKIE_NAME}={cookie}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        assert!(session_rows(&h.state.db, "bob").is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn admin_revoke_kills_sessions_and_pending_links() {
        let h = harness().await;
        let cookie_a = sign_in_bob(&h).await;
        let cookie_b = sign_in_bob(&h).await;
        assert_eq!(session_rows(&h.state.db, "bob").len(), 2);
        // A pending (unused) link too.
        assert_eq!(
            request_link(&h, "bob@example.org", None).await,
            StatusCode::OK
        );
        let pending = last_token(&h);

        let db = h.state.db.clone();
        let (alice, bob) = tokio::task::spawn_blocking(move || {
            (
                mint_token(&db, "alice", "t").unwrap().token,
                mint_token(&db, "bob", "t").unwrap().token,
            )
        })
        .await
        .unwrap();
        let revoke = |bearer: String| {
            let router = h.router.clone();
            async move {
                let resp = router
                    .oneshot(
                        Request::builder()
                            .method("DELETE")
                            .uri("/api/admin/sessions/bob")
                            .header("Authorization", format!("Bearer {bearer}"))
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                let status = resp.status();
                let body = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
                (
                    status,
                    serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
                )
            }
        };

        // A member (even the user himself) cannot use the admin route.
        let (status, _) = revoke(bob).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(session_rows(&h.state.db, "bob").len(), 2);

        let (status, body) = revoke(alice).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["revokedSessions"], 2);
        assert!(session_rows(&h.state.db, "bob").is_empty());
        for cookie in [cookie_a, cookie_b] {
            let (status, _) = me_with_cookie(&h, &cookie).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
        }
        let (status, _) = redeem_with(&h, &format!("/auth/magic/{pending}")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn sixth_request_in_the_window_is_dropped_silently() {
        let h = harness().await;
        for _ in 0..RATE_LIMIT {
            assert_eq!(
                request_link(&h, "bob@example.org", Some("203.0.113.9")).await,
                StatusCode::OK
            );
        }
        assert_eq!(h.mail.sent().len(), RATE_LIMIT);
        let before = token_rows(&h.state.db);
        assert_eq!(
            request_link(&h, "bob@example.org", Some("203.0.113.9")).await,
            StatusCode::OK
        );
        assert_eq!(h.mail.sent().len(), RATE_LIMIT, "no sixth email");
        assert_eq!(token_rows(&h.state.db), before, "no new token");
        // The per-email limit holds from a different address too.
        assert_eq!(
            request_link(&h, "bob@example.org", Some("198.51.100.1")).await,
            StatusCode::OK
        );
        assert_eq!(h.mail.sent().len(), RATE_LIMIT);
    }

    #[test]
    fn rate_limiter_is_per_key_and_recovers_after_the_window() {
        let mut limiter = RateLimiter::default();
        let t0 = Instant::now();
        for _ in 0..RATE_LIMIT {
            assert!(limiter.allow("ip:a".into(), t0));
        }
        assert!(!limiter.allow("ip:a".into(), t0));
        assert!(limiter.allow("ip:b".into(), t0), "other keys unaffected");
        assert!(limiter.allow("ip:a".into(), t0 + RATE_WINDOW + Duration::from_secs(1)));
    }

    /// The point of the whole leaf: a circle gallery denied to anonymous
    /// is visible with the magic-link session cookie of a circle member.
    #[tokio::test(flavor = "multi_thread")]
    async fn magic_link_session_passes_the_circle_acl() {
        use crate::commands::publish::{publish_collection_core, PublishVisibility};
        use crate::daemon::gallery::tests::{fixture, get};
        use crate::daemon::records::tests::{link_did, sign_publish};
        use kith::storage::GraphStore;
        use kith::types::{Edge, EdgeKind, EntityId, UserId};

        let f = fixture().await;
        link_did(&f);
        insert_user(&f.state.db, "bob");
        diesel::update(users::table.find("bob"))
            .set((
                users::username.eq(Some("bobh")),
                users::email.eq(Some("bob@example.org")),
                users::did.eq(Some(BOB_DID)),
            ))
            .execute(&mut f.state.db.get().unwrap())
            .unwrap();
        f.state
            .kith()
            .add_edge(&Edge::new(
                UserId("alice".into()),
                EntityId::user(&UserId("bob".into())),
                EdgeKind::Circle("family".into()),
            ))
            .await
            .unwrap();
        publish_collection_core(
            &f.state.db,
            "alice",
            &f.public_collection.id,
            PublishVisibility::circle("family").unwrap(),
            None,
        )
        .unwrap();
        sign_publish(&f, &f.public_collection.id).await.unwrap();
        let router = crate::daemon::router(f.state.clone());

        let gallery = "/@aliceh/andromeda-nights";
        let (status, _, _) = get(&router, gallery).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "anonymous is denied");

        // Full magic-link flow against the fixture's own pool (its mailer
        // is a LogMailer we cannot reach, so the token comes from the
        // issuing fn directly — the emailed URL is just this token).
        let (token, _) = issue_token(&f.state.db, "bob@example.org")
            .unwrap()
            .unwrap();
        let resp = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/auth/magic/{token}?next={}", url_encode(gallery)))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SEE_OTHER);
        assert_eq!(resp.headers().get(header::LOCATION).unwrap(), gallery);
        let cookie = cookie_of(resp.headers());

        let resp = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(gallery)
                    .header(header::COOKIE, format!("{COOKIE_NAME}={cookie}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "circle member via magic link"
        );
        assert_eq!(
            resp.headers().get(header::CACHE_CONTROL).unwrap(),
            crate::daemon::acl::PRIVATE_CACHE_CONTROL
        );

        // Revoking bob's sessions closes the door again.
        revoke_user_sessions(&f.state.db, "bob").unwrap();
        let resp = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(gallery)
                    .header(header::COOKIE, format!("{COOKIE_NAME}={cookie}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
}
