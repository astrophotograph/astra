//! Signed kith edges: a follow or circle membership made on this host as a
//! **verifiable statement by the acting user's DID** (`sh.kith.graph.edge`,
//! `kith::signed`), plus the public route an indexer fetches one from.
//!
//! [`write_edge`] is the one write path: it signs when it can (the daemon
//! has a [`Signer`](crate::share::records::Signer), the actor has a DID,
//! and a `user` target has a DID), verifies the envelope against the
//! actor's DID document through the daemon's resolver — the
//! `kith::graph::add_verified_signed_edge` contract, done here because
//! Astra keys rows by `users.id` rather than by the DIDs in the body (see
//! `kith_store.rs`) — and stores envelope and local-id edge together.
//! Otherwise it stores a plain edge, exactly as before signed edges
//! existed. Callers report which happened as `"signed": bool`. Writing an
//! edge that is already stored signed is a no-op (the original statement,
//! with its record URI, stands); writing one stored plain upgrades it.
//!
//! # Id mapping
//!
//! | where                    | actor           | `user` target        | other targets |
//! |--------------------------|-----------------|----------------------|---------------|
//! | `kith_edges` row         | `users.id`      | `users.id`           | the id        |
//! | signed `EdgeRecord` body | actor `users.did` | target `users.did` | the id        |
//!
//! # Public read route
//!
//! `GET /@{user}/graph/{kind}/{target_kind}/{target_id}` serves the stored
//! envelope JSON. `{user}` is `@username` or `@did:…`; `{kind}` is the kith
//! text codec (`follow`, `circle:family` URL-encoded); a `user` target id
//! may be the local `users.id` or the user's DID. `follow` edges are
//! public. `circle:*` edges reveal membership, so they are served only to
//! the circle's owner or the member named (viewer from [`MaybeViewer`]),
//! with the private cache policy. Any other kind, a missing edge, or an
//! unsigned one is 404 — never 403, so nothing distinguishes "private"
//! from "absent".

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use diesel::prelude::*;
use kenning::Did;
use kith::error::KithError;
use kith::signed::{sign_edge, verify_edge, SignedEdge};
use kith::storage::GraphStore;
use kith::types::{Edge, EdgeKind, EntityId, EntityKind, UserId};
use serde_json::json;

use super::acl;
use super::auth::MaybeViewer;
use super::DaemonState;
use crate::db::schema::users;
use crate::db::DbPool;

/// Why [`write_edge`] failed.
#[derive(Debug)]
pub enum WriteError {
    /// Database lookup of the actor's or target's DID.
    Db(String),
    /// `sign_edge` refused (actor DID malformed — should not happen for a
    /// `users.did` the daemon validated on link).
    Sign(KithError),
    /// The fresh envelope does not verify against the actor's DID
    /// document: the signing key is not the `method_id` key in that
    /// document, or the resolver failed. An operator problem, not the
    /// user's.
    Verify(KithError),
    /// The kith store.
    Store(KithError),
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Db(e) => write!(f, "did lookup: {e}"),
            Self::Sign(e) => write!(f, "sign edge: {e}"),
            Self::Verify(e) => write!(f, "verify signed edge: {e}"),
            Self::Store(e) => write!(f, "store edge: {e}"),
        }
    }
}

/// Map a [`WriteError`] to the API response: kith `InvalidInput` → 400,
/// everything else → 500 (logged with `context`).
pub fn error_response(context: &str, e: WriteError) -> Response {
    match e {
        WriteError::Store(KithError::InvalidInput(msg)) => {
            (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
        }
        other => super::api::internal(context, other.to_string()),
    }
}

/// Blocking: `users.did` of a user, if linked.
fn user_did(conn: &mut SqliteConnection, user_id: &str) -> Result<Option<String>, String> {
    users::table
        .find(user_id)
        .select(users::did)
        .first::<Option<String>>(conn)
        .optional()
        .map(Option::flatten)
        .map_err(|e| e.to_string())
}

/// Blocking: the local user id holding `did`, if any.
fn user_id_for_did(conn: &mut SqliteConnection, did: &str) -> Result<Option<String>, String> {
    users::table
        .filter(users::did.eq(did))
        .select(users::id)
        .first::<String>(conn)
        .optional()
        .map_err(|e| e.to_string())
}

/// Blocking: the local user id for a username, if any.
fn user_id_for_username(
    conn: &mut SqliteConnection,
    username: &str,
) -> Result<Option<String>, String> {
    users::table
        .filter(users::username.eq(username))
        .select(users::id)
        .first::<String>(conn)
        .optional()
        .map_err(|e| e.to_string())
}

/// The DIDs a signed statement about `edge` needs: the actor's, and the
/// target's when the target is a user. `None` when the edge cannot be
/// signed (actor without a DID, or a user target without one).
async fn signing_ids(db: &DbPool, edge: &Edge) -> Result<Option<(String, String)>, String> {
    let db = db.clone();
    let actor = edge.actor.0.clone();
    let target = (edge.target.kind == EntityKind::User).then(|| edge.target.id.clone());
    let target_id = edge.target.id.clone();
    tokio::task::spawn_blocking(move || -> Result<Option<(String, String)>, String> {
        let mut conn = db.get().map_err(|e| e.to_string())?;
        let Some(actor_did) = user_did(&mut conn, &actor)? else {
            return Ok(None);
        };
        let target_id = match target {
            Some(user) => match user_did(&mut conn, &user)? {
                Some(did) => did,
                None => return Ok(None),
            },
            None => target_id,
        };
        Ok(Some((actor_did, target_id)))
    })
    .await
    .map_err(|e| format!("did lookup task: {e}"))?
}

/// Store `edge` (local `users.id` ids) for its actor — signed when the
/// daemon and the users involved allow it (module docs), plain otherwise.
/// Returns whether the stored edge carries a signature. Nothing is written
/// when signing or verification fails.
pub async fn write_edge(state: &DaemonState, edge: &Edge) -> Result<bool, WriteError> {
    let store = state.kith();
    let Some(signer) = state.signer.as_ref() else {
        store.add_edge(edge).await.map_err(WriteError::Store)?;
        return Ok(false);
    };
    // Idempotent: an edge already stored signed keeps its statement (same
    // record URI/TID and createdAt) rather than being re-signed.
    if store
        .signed_edge(&edge.actor, &edge.target, &edge.kind)
        .await
        .map_err(WriteError::Store)?
        .is_some()
    {
        return Ok(true);
    }
    let Some((actor_did, target_id)) =
        signing_ids(&state.db, edge).await.map_err(WriteError::Db)?
    else {
        store.add_edge(edge).await.map_err(WriteError::Store)?;
        return Ok(false);
    };

    // The statement as the world sees it: DIDs in place of local ids.
    let did_edge = Edge {
        actor: UserId(actor_did),
        target: EntityId::new(edge.target.kind.clone(), target_id),
        kind: edge.kind.clone(),
        weight: edge.weight,
        created_at: edge.created_at,
        metadata: edge.metadata.clone(),
    };
    let signed =
        sign_edge(&did_edge, None, &signer.method_id, &signer.key).map_err(WriteError::Sign)?;

    // Verify before storing (the add_verified_signed_edge contract): the
    // key must be the `method_id` key in the actor's DID document.
    let resolver = state.handles.resolver();
    verify_edge(&signed, resolver.as_ref())
        .await
        .map_err(WriteError::Verify)?;

    // The row keeps the local ids; `created_at` was truncated to millis
    // when signed, so store the same instant the envelope carries.
    let local = Edge {
        created_at: signed_created_at(&signed).unwrap_or(edge.created_at),
        ..edge.clone()
    };
    store
        .add_signed_edge(&signed, &local)
        .await
        .map_err(WriteError::Store)?;
    Ok(true)
}

fn signed_created_at(signed: &SignedEdge) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(&signed.record.body.created_at)
        .ok()
        .map(|t| t.with_timezone(&chrono::Utc))
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}

/// Resolved path of the public graph route: the owner and target as local
/// ids, plus the DIDs the gate compares against.
struct Lookup {
    owner_id: String,
    owner_did: Option<String>,
    target_id: String,
    target_did: Option<String>,
}

/// Blocking: `@username` or `@did:…` → owner; a `user` target given as a
/// DID → its local id. `None` when the owner (or a DID-named target) is
/// unknown.
fn lookup(
    db: &DbPool,
    user: &str,
    target_kind: &EntityKind,
    target_id: &str,
) -> Result<Option<Lookup>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    let owner_id = if Did::parse(user).is_ok() {
        user_id_for_did(&mut conn, user)?
    } else {
        user_id_for_username(&mut conn, user)?
    };
    let Some(owner_id) = owner_id else {
        return Ok(None);
    };
    let owner_did = user_did(&mut conn, &owner_id)?;
    let (target_id, target_did) = if *target_kind == EntityKind::User {
        let id = if Did::parse(target_id).is_ok() {
            match user_id_for_did(&mut conn, target_id)? {
                Some(id) => id,
                None => return Ok(None),
            }
        } else {
            target_id.to_string()
        };
        let did = user_did(&mut conn, &id)?;
        (id, did)
    } else {
        (target_id.to_string(), None)
    };
    Ok(Some(Lookup {
        owner_id,
        owner_did,
        target_id,
        target_did,
    }))
}

/// `GET /@{user}/graph/{kind}/{target_kind}/{target_id}` — the signed edge
/// envelope, gated as the module docs describe.
pub async fn graph_edge(
    State(state): State<Arc<DaemonState>>,
    Path((user, kind, target_kind, target_id)): Path<(String, String, String, String)>,
    viewer: MaybeViewer,
) -> Response {
    let Some(user) = user.strip_prefix('@').filter(|u| !u.is_empty()) else {
        return not_found();
    };
    let Ok(kind) = kind.parse::<EdgeKind>() else {
        return not_found();
    };
    let Ok(target_kind) = target_kind.parse::<EntityKind>() else {
        return not_found();
    };
    // Only follows and circle edges are served at all.
    let public = match &kind {
        EdgeKind::Follow => true,
        EdgeKind::Circle(_) => false,
        _ => return not_found(),
    };

    let db = state.db.clone();
    let (user, tk, tid) = (user.to_string(), target_kind.clone(), target_id);
    let found = tokio::task::spawn_blocking(move || lookup(&db, &user, &tk, &tid)).await;
    let found = match found {
        Ok(Ok(found)) => found,
        Ok(Err(e)) => return super::api::internal("graph edge lookup", e),
        Err(e) => return super::api::internal("graph edge lookup", e.to_string()),
    };
    let Some(found) = found else {
        return not_found();
    };

    if !public {
        // Owner or the named member, by DID; anyone else sees nothing.
        let Some(viewer) = viewer.0.as_ref().map(Did::as_str) else {
            return not_found();
        };
        let is_owner = found.owner_did.as_deref() == Some(viewer);
        let is_member = found.target_did.as_deref() == Some(viewer);
        if !(is_owner || is_member) {
            return not_found();
        }
    }

    let target = EntityId::new(target_kind, found.target_id);
    let signed = match state
        .kith()
        .signed_edge(&UserId(found.owner_id), &target, &kind)
        .await
    {
        Ok(Some(signed)) => signed,
        Ok(None) => return not_found(),
        Err(e) => return super::api::internal("graph edge read", e.to_string()),
    };
    let body = match serde_json::to_string(&signed) {
        Ok(body) => body,
        Err(e) => return super::api::internal("graph edge encode", e.to_string()),
    };

    let mut response = (
        StatusCode::OK,
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        )],
        body,
    )
        .into_response();
    if public {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=60"),
        );
    } else {
        acl::mark_private(&mut response);
    }
    response
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::daemon::auth::mint_token;
    use crate::daemon::gallery::tests::test_signer;
    use crate::daemon::handles::HandleCache;
    use crate::daemon::router;
    use crate::db::schema::kith_edges;
    use crate::db::test_support::{insert_user, test_pool};
    use async_trait::async_trait;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use axum::Router;
    use kenning::did::{DidDocument, ResolveError, Resolver, VerificationMethod};
    use kenning::handle::Handle;
    use kenning::keys::VerifyingKey;
    use std::time::Duration;
    use tower::ServiceExt;

    pub(crate) const ALICE_DID: &str = "did:plc:z72i7hdynmk6r22z27h6tvur";
    pub(crate) const BOB_DID: &str = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
    pub(crate) const DAVE_DID: &str = "did:plc:dddddddddddddddddddddddd";

    /// Resolves each listed DID to a document naming `astra` → `key`.
    pub(crate) struct KeyResolver {
        dids: Vec<Did>,
        key: VerifyingKey,
    }

    #[async_trait]
    impl Resolver for KeyResolver {
        async fn resolve_did(&self, did: &Did) -> Result<DidDocument, ResolveError> {
            if !self.dids.contains(did) {
                return Err(ResolveError::NotFound);
            }
            Ok(DidDocument {
                context: None,
                id: did.clone(),
                also_known_as: Vec::new(),
                verification_method: vec![VerificationMethod {
                    id: format!("{did}#astra"),
                    r#type: "Multikey".into(),
                    controller: did.to_string(),
                    public_key_multibase: self.key.to_multikey(),
                }],
                service: Vec::new(),
            })
        }
        async fn resolve_handle(&self, _handle: &Handle) -> Result<Did, ResolveError> {
            Err(ResolveError::NotFound)
        }
    }

    /// A [`HandleCache`] over a [`KeyResolver`] for `key` and the test DIDs.
    pub(crate) fn fake_handles(key: VerifyingKey) -> HandleCache {
        HandleCache::new(
            Arc::new(KeyResolver {
                dids: [ALICE_DID, BOB_DID, DAVE_DID]
                    .iter()
                    .map(|d| Did::parse(d).unwrap())
                    .collect(),
                key,
            }),
            Duration::from_millis(200),
        )
    }

    /// Insert a user with a username and, optionally, a DID; returns a
    /// bearer token for them.
    pub(crate) fn user(db: &DbPool, id: &str, handle: &str, did: Option<&str>) -> String {
        insert_user(db, id);
        diesel::update(users::table.find(id))
            .set((users::username.eq(Some(handle)), users::did.eq(did)))
            .execute(&mut db.get().unwrap())
            .unwrap();
        mint_token(db, id, "t").unwrap().token
    }

    /// State with a signer and a resolver that trusts its key; alice
    /// (`ALICE_DID`), bob (`BOB_DID`), dave (`DAVE_DID`) and carol (no DID).
    pub(crate) struct Signed {
        pub(crate) state: Arc<DaemonState>,
        pub(crate) router: Router,
        pub(crate) alice: String,
        pub(crate) bob: String,
        pub(crate) carol: String,
        pub(crate) dave: String,
        pub(crate) key: VerifyingKey,
        _tmp: tempfile::TempDir,
    }

    pub(crate) async fn signed_setup() -> Signed {
        let tmp = tempfile::tempdir().unwrap();
        let hfs = hoardfs_volume::HoardFs::init(&tmp.path().join("hoardfs"))
            .await
            .unwrap();
        let signer = test_signer();
        let key = signer.key.verifying_key();
        let db = test_pool();
        let alice = user(&db, "alice", "aliceh", Some(ALICE_DID));
        let bob = user(&db, "bob", "bobh", Some(BOB_DID));
        let carol = user(&db, "carol", "carolh", None);
        let dave = user(&db, "dave", "daveh", Some(DAVE_DID));
        let state = Arc::new(DaemonState {
            db,
            hoardfs: Arc::new(std::sync::Mutex::new(hfs)),
            oidc: None,
            limits: Default::default(),
            session_key: [7u8; 32],
            processing: Default::default(),
            tetra3_db: None,
            uploads_dir: std::env::temp_dir().join("astra-test-uploads"),
            handles: fake_handles(key.clone()),
            mailer: Arc::new(crate::mail::LogMailer::default()),
            magic: Default::default(),
            signer: Some(Arc::new(signer)),
        });
        Signed {
            router: router(state.clone()),
            state,
            alice,
            bob,
            carol,
            dave,
            key,
            _tmp: tmp,
        }
    }

    pub(crate) async fn send(
        router: &Router,
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Option<serde_json::Value>,
    ) -> (StatusCode, serde_json::Value) {
        let mut req = Request::builder().method(method).uri(uri);
        if let Some(t) = token {
            req = req.header("Authorization", format!("Bearer {t}"));
        }
        let body = match body {
            Some(json) => {
                req = req.header("Content-Type", "application/json");
                Body::from(json.to_string())
            }
            None => Body::empty(),
        };
        let resp = router
            .clone()
            .oneshot(req.body(body).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let json = if bytes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
        };
        (status, json)
    }

    pub(crate) fn follow_body(kind: &str, id: &str) -> serde_json::Value {
        json!({ "target_kind": kind, "target_id": id })
    }

    pub(crate) fn signed_json(
        db: &DbPool,
        actor: &str,
        target: &str,
        kind: &str,
    ) -> Option<String> {
        kith_edges::table
            .filter(kith_edges::actor_id.eq(actor))
            .filter(kith_edges::target_kind.eq("user"))
            .filter(kith_edges::target_id.eq(target))
            .filter(kith_edges::edge_kind.eq(kind))
            .select(kith_edges::signed_json)
            .first::<Option<String>>(&mut db.get().unwrap())
            .optional()
            .unwrap()
            .flatten()
    }

    #[tokio::test]
    async fn follow_by_did_user_is_signed_verified_and_served() {
        let s = signed_setup().await;
        let (status, body) = send(
            &s.router,
            "POST",
            "/api/social/follow",
            Some(&s.alice),
            Some(follow_body("user", "bob")),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["signed"], true);

        // The row is keyed by users.id and carries the envelope.
        let raw = signed_json(&s.state.db, "alice", "bob", "follow").expect("signed_json set");
        let signed: SignedEdge = serde_json::from_str(&raw).unwrap();
        assert_eq!(signed.record.body.actor.as_str(), ALICE_DID);
        assert_eq!(signed.record.body.target.id, BOB_DID);
        assert_eq!(signed.record.body.target.kind, "user");
        assert_eq!(signed.record.body.edge_kind, "follow");
        assert_eq!(signed.method_id, "astra");
        assert_eq!(signed.record.uri.did(), ALICE_DID);

        // `signed_edge` parses it and it verifies against the resolver.
        let stored = s
            .state
            .kith()
            .signed_edge(
                &UserId("alice".into()),
                &EntityId::user(&UserId("bob".into())),
                &EdgeKind::Follow,
            )
            .await
            .unwrap()
            .expect("stored signed");
        assert_eq!(stored, signed);
        let verified = verify_edge(&stored, s.state.handles.resolver().as_ref())
            .await
            .unwrap();
        assert_eq!(verified.actor.0, ALICE_DID);
        kith::signed::verify_edge_with_key(&stored, &s.key).unwrap();

        // Plain queries see the local-id edge.
        assert!(s
            .state
            .social()
            .is_following(
                &UserId("alice".into()),
                &EntityId::user(&UserId("bob".into()))
            )
            .await
            .unwrap());
        let (_, body) = send(&s.router, "GET", "/api/social/counts/user/bob", None, None).await;
        assert_eq!(body["followers"], 1);
        let (_, body) = send(
            &s.router,
            "GET",
            "/api/social/counts/user/alice",
            None,
            None,
        )
        .await;
        assert_eq!(body["following"], 1);

        // Public graph route: by username or DID, target by id or DID.
        for uri in [
            "/@aliceh/graph/follow/user/bob",
            &format!("/@aliceh/graph/follow/user/{BOB_DID}"),
            &format!("/@{ALICE_DID}/graph/follow/user/bob"),
        ] {
            let resp = s
                .router
                .clone()
                .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::OK, "{uri}");
            assert_eq!(
                resp.headers().get(header::CACHE_CONTROL).unwrap(),
                "public, max-age=60",
                "{uri}"
            );
            assert_eq!(
                resp.headers().get(header::CONTENT_TYPE).unwrap(),
                "application/json"
            );
            let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
            let served: SignedEdge = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(served, signed, "{uri}");
        }

        // A second follow is idempotent: still signed, same statement.
        let (status, body) = send(
            &s.router,
            "POST",
            "/api/social/follow",
            Some(&s.alice),
            Some(follow_body("user", "bob")),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["signed"], true);
        assert_eq!(
            signed_json(&s.state.db, "alice", "bob", "follow").unwrap(),
            raw,
            "re-follow keeps the original envelope"
        );
        let (_, body) = send(&s.router, "GET", "/api/social/counts/user/bob", None, None).await;
        assert_eq!(body["followers"], 1);

        // Unfollow removes row and envelope; the graph route 404s.
        let (status, _) = send(
            &s.router,
            "DELETE",
            "/api/social/follow",
            Some(&s.alice),
            Some(follow_body("user", "bob")),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, _) = send(
            &s.router,
            "GET",
            "/@aliceh/graph/follow/user/bob",
            None,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn follow_without_a_did_is_unsigned() {
        let s = signed_setup().await;

        // Actor without a DID: plain edge.
        let (status, body) = send(
            &s.router,
            "POST",
            "/api/social/follow",
            Some(&s.carol),
            Some(follow_body("user", "bob")),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["signed"], false);
        assert!(signed_json(&s.state.db, "carol", "bob", "follow").is_none());
        assert!(s
            .state
            .social()
            .is_following(
                &UserId("carol".into()),
                &EntityId::user(&UserId("bob".into()))
            )
            .await
            .unwrap());
        let (status, _) = send(
            &s.router,
            "GET",
            "/@carolh/graph/follow/user/bob",
            None,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // User target without a DID: refuse to sign, store plain.
        let (status, body) = send(
            &s.router,
            "POST",
            "/api/social/follow",
            Some(&s.alice),
            Some(follow_body("user", "carol")),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["signed"], false);
        assert!(signed_json(&s.state.db, "alice", "carol", "follow").is_none());
        let (status, _) = send(
            &s.router,
            "GET",
            "/@aliceh/graph/follow/user/carol",
            None,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // Object target: signed, target id kept as is.
        let (status, body) = send(
            &s.router,
            "POST",
            "/api/social/follow",
            Some(&s.alice),
            Some(follow_body("object", "M42")),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["signed"], true);
        let (status, body) = send(
            &s.router,
            "GET",
            "/@aliceh/graph/follow/object/M42",
            None,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        // Envelope JSON: `record` is the body, the URI is top level.
        assert_eq!(body["record"]["target"]["id"], "M42");
        assert_eq!(body["record"]["target"]["kind"], "object");
        assert_eq!(body["record"]["$type"], "sh.kith.graph.edge");
        assert_eq!(body["methodId"], "astra");
        assert!(body["uri"]
            .as_str()
            .unwrap()
            .starts_with(&format!("at://{ALICE_DID}/sh.kith.graph.edge/")));
    }

    #[tokio::test]
    async fn follow_without_a_signer_is_unsigned() {
        let s = signed_setup().await;
        let state = Arc::new(DaemonState {
            db: s.state.db.clone(),
            hoardfs: s.state.hoardfs.clone(),
            oidc: None,
            limits: Default::default(),
            session_key: s.state.session_key,
            processing: Default::default(),
            tetra3_db: None,
            uploads_dir: std::env::temp_dir().join("astra-test-uploads"),
            handles: fake_handles(s.key.clone()),
            mailer: Arc::new(crate::mail::LogMailer::default()),
            magic: Default::default(),
            signer: None,
        });
        let router = router(state.clone());
        let (status, body) = send(
            &router,
            "POST",
            "/api/social/follow",
            Some(&s.alice),
            Some(follow_body("user", "bob")),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["signed"], false);
        assert!(signed_json(&state.db, "alice", "bob", "follow").is_none());
    }

    #[tokio::test]
    async fn follow_fails_closed_when_the_key_is_not_in_the_did_document() {
        let s = signed_setup().await;
        // A resolver that trusts a different key: verification must fail
        // and nothing may be written.
        let other = kenning::keys::SigningKey::generate(kenning::keys::KeyAlgo::Secp256k1);
        let state = Arc::new(DaemonState {
            db: s.state.db.clone(),
            hoardfs: s.state.hoardfs.clone(),
            oidc: None,
            limits: Default::default(),
            session_key: s.state.session_key,
            processing: Default::default(),
            tetra3_db: None,
            uploads_dir: std::env::temp_dir().join("astra-test-uploads"),
            handles: fake_handles(other.verifying_key()),
            mailer: Arc::new(crate::mail::LogMailer::default()),
            magic: Default::default(),
            signer: s.state.signer.clone(),
        });
        let router = router(state.clone());
        let (status, _) = send(
            &router,
            "POST",
            "/api/social/follow",
            Some(&s.alice),
            Some(follow_body("user", "bob")),
        )
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(!state
            .social()
            .is_following(
                &UserId("alice".into()),
                &EntityId::user(&UserId("bob".into()))
            )
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn graph_route_rejects_other_kinds_and_unknown_users() {
        let s = signed_setup().await;
        // A signed block edge exists but is never served.
        s.state
            .kith()
            .add_edge(&Edge::new(
                UserId("alice".into()),
                EntityId::user(&UserId("bob".into())),
                EdgeKind::Block,
            ))
            .await
            .unwrap();
        for uri in [
            "/@aliceh/graph/block/user/bob",
            "/@aliceh/graph/mute/user/bob",
            "/@aliceh/graph/gizmo/user/bob",
            "/@aliceh/graph/follow/planet/bob",
            "/@nobody/graph/follow/user/bob",
            "/aliceh/graph/follow/user/bob",
            "/@aliceh/graph/follow/user/did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
        ] {
            let (status, _) = send(&s.router, "GET", uri, Some(&s.alice), None).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
        }
    }
}
