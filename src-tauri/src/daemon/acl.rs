//! Access control for circle-visibility content on the public routes.
//!
//! `commands::publish` computes, from the database alone, an [`Access`]
//! value for a publish record, an image or a stored record: `Public`, or
//! the list of `(owner DID, circle)` grants that would admit a viewer.
//! This module turns that into a yes/no for one request by asking kith
//! whether the viewer is in any of those circles, through
//! [`kenning::private::allowed`] — the design's single decision function
//! (`kenning/docs/private-store.md` §2), evaluated live on every request
//! and never cached: leaving a circle takes effect on the next request.
//!
//! Membership ([`KithCircles`]) is a kith edge with actor = the owner's
//! kith id, target = `(user, viewer's kith id)`, kind `circle:<name>`.
//! Kith ids in Astra are `users.id`, not DIDs, so both DIDs are mapped
//! through `users.did` first; a DID with no local account is not a member
//! of anything.
//!
//! Denial is always a 404 (the caller's `not_found()`), never a 403, so an
//! unauthorized viewer cannot tell "private" from "nonexistent". Responses
//! that passed a circle check carry `Cache-Control: private, no-store` and
//! `Vary: Cookie, Authorization` ([`mark_private`]) so no shared cache ever
//! holds them.

use async_trait::async_trait;
use axum::http::header;
use axum::response::Response;
use diesel::prelude::*;
use kenning::private::{CircleMembership, PrivateStoreError, Visibility};
use kenning::Did;
use kith::storage::GraphStore;
use kith::types::{EdgeKind, EntityId, UserId};

use super::kith_store::AstraKithStore;
use super::DaemonState;
use crate::commands::publish::Access;
use crate::db::schema::users;
use crate::db::DbPool;

/// `Cache-Control` for anything served after a circle check.
pub const PRIVATE_CACHE_CONTROL: &str = "private, no-store";
/// `Vary` for the same: the answer depends on who asked.
pub const PRIVATE_VARY: &str = "Cookie, Authorization";

/// [`CircleMembership`] over the daemon's kith store.
pub struct KithCircles {
    db: DbPool,
    kith: AstraKithStore,
}

impl KithCircles {
    pub fn new(state: &DaemonState) -> Self {
        Self {
            db: state.db.clone(),
            kith: state.kith(),
        }
    }
}

/// Blocking: the local user id holding `did`, if any.
fn user_id_for_did(conn: &mut SqliteConnection, did: &Did) -> Result<Option<String>, String> {
    users::table
        .filter(users::did.eq(did.as_str()))
        .select(users::id)
        .first::<String>(conn)
        .optional()
        .map_err(|e| e.to_string())
}

#[async_trait]
impl CircleMembership for KithCircles {
    async fn is_member(
        &self,
        owner: &Did,
        circle: &str,
        viewer: &Did,
    ) -> Result<bool, PrivateStoreError> {
        let db = self.db.clone();
        let (owner, viewer) = (owner.clone(), viewer.clone());
        let ids = tokio::task::spawn_blocking(move || -> Result<_, String> {
            let mut conn = db.get().map_err(|e| e.to_string())?;
            Ok((
                user_id_for_did(&mut conn, &owner)?,
                user_id_for_did(&mut conn, &viewer)?,
            ))
        })
        .await
        .map_err(|e| PrivateStoreError::Storage(format!("did lookup task: {e}")))?
        .map_err(PrivateStoreError::Storage)?;
        let (Some(owner_id), Some(viewer_id)) = ids else {
            return Ok(false);
        };
        self.kith
            .edge_exists(
                &UserId(owner_id),
                &EntityId::user(&UserId(viewer_id)),
                &EdgeKind::Circle(circle.to_string()),
            )
            .await
            .map_err(|e| PrivateStoreError::Storage(e.to_string()))
    }
}

/// May `viewer` see content with this [`Access`]? `Public` → yes. Circles
/// → yes if [`kenning::private::allowed`] says so for any grant (owner, or
/// member of that circle); an empty grant list, or an anonymous viewer, →
/// no. Errors are the kith store's and surface as 500 at the caller.
pub async fn allowed(
    state: &DaemonState,
    access: &Access,
    viewer: Option<&Did>,
) -> Result<bool, String> {
    let grants = match access {
        Access::Public => return Ok(true),
        Access::Circles(grants) => grants,
    };
    if grants.is_empty() || viewer.is_none() {
        return Ok(false);
    }
    let membership = KithCircles::new(state);
    for grant in grants {
        let owner = Did::parse(&grant.owner_did).map_err(|e| format!("owner did: {e}"))?;
        let visibility =
            Visibility::circle(grant.circle.as_str()).map_err(|e| format!("circle: {e}"))?;
        if kenning::private::allowed(&visibility, &owner, viewer, &membership)
            .await
            .map_err(|e| e.to_string())?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Stamp a response as viewer-specific: no shared cache may store it and
/// the answer varies with the credential.
pub fn mark_private(response: &mut Response) {
    let headers = response.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static(PRIVATE_CACHE_CONTROL),
    );
    headers.insert(header::VARY, header::HeaderValue::from_static(PRIVATE_VARY));
}

/// [`mark_private`] when the content was gated (anything but `Public`).
pub fn mark_if_gated(response: &mut Response, access: &Access) {
    if !access.is_public() {
        mark_private(response);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::images::add_image_to_collection_core;
    use crate::commands::publish::{
        publish_collection_core, unpublish_collection_core, PublishVisibility,
    };
    use crate::daemon::auth::mint_token;
    use crate::daemon::gallery::tests::{fixture, get, Fixture};
    use crate::daemon::records::tests::{
        image_rkey, json, link_did, request, resolver, sign_publish, stored, DID,
    };
    use crate::daemon::session::{mint_cookie_value, COOKIE_NAME};
    use crate::db::schema::{images as images_table, published_records, users};
    use crate::db::test_support::insert_user;
    use crate::share::records::{CollectionBody, ImageBody, SignedPublish, COLLECTION_NSID};
    use crate::share::records::{IMAGE_NSID, PUBLIC_URL_ENV};
    use axum::body::{to_bytes, Body};
    use axum::http::{header, HeaderMap, Request, StatusCode};
    use kenning::envelope::SignedRecord;
    use kenning::private::{StubRecord, STUB_NSID};
    use kith::types::Edge;
    use tower::ServiceExt;

    const BOB_DID: &str = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
    const CAROL_DID: &str = "did:plc:cccccccccccccccccccccccc";

    /// alice (owner, `DID`), bob (in alice's `family` circle), carol (a
    /// stranger with an account and a DID), each with a bearer token.
    struct Circle {
        f: Fixture,
        router: axum::Router,
        alice: String,
        bob: String,
        carol: String,
        /// The circle publish of "Andromeda Nights" (slug andromeda-nights).
        signed: SignedPublish,
        rkey: String,
        preview_cid: String,
    }

    fn user_with_did(f: &Fixture, id: &str, handle: &str, did: &str) -> String {
        insert_user(&f.state.db, id);
        diesel::update(users::table.find(id))
            .set((users::username.eq(Some(handle)), users::did.eq(Some(did))))
            .execute(&mut f.state.db.get().unwrap())
            .unwrap();
        mint_token(&f.state.db, id, "t").unwrap().token
    }

    async fn circle_fixture() -> Circle {
        let f = fixture().await;
        link_did(&f);
        let alice = mint_token(&f.state.db, "alice", "t").unwrap().token;
        let bob = user_with_did(&f, "bob", "bobh", BOB_DID);
        let carol = user_with_did(&f, "carol", "carolh", CAROL_DID);

        // The membership edge, exactly as the kith adapter will write it:
        // actor = owner's kith id (users.id), target = (user, viewer id).
        f.state
            .kith()
            .add_edge(&Edge::new(
                UserId("alice".into()),
                EntityId::user(&UserId("bob".into())),
                EdgeKind::Circle("family".into()),
            ))
            .await
            .unwrap();

        // "Andromeda Nights" (the HoardFS-backed image) goes family-only.
        publish_collection_core(
            &f.state.db,
            "alice",
            &f.public_collection.id,
            PublishVisibility::circle("family").unwrap(),
            None,
        )
        .unwrap();
        let signed = sign_publish(&f, &f.public_collection.id).await.unwrap();
        let rkey = image_rkey(&f);
        let image: SignedRecord<ImageBody> =
            serde_json::from_str(&stored(&f, &format!("at://{DID}/{IMAGE_NSID}/{rkey}"))).unwrap();
        let preview_cid = image.record.body.preview.r#ref.0.to_string();
        let router = crate::daemon::router(f.state.clone());
        Circle {
            f,
            router,
            alice,
            bob,
            carol,
            signed,
            rkey,
            preview_cid,
        }
    }

    async fn get_cookie(
        router: &axum::Router,
        uri: &str,
        cookie: &str,
    ) -> (StatusCode, HeaderMap, Vec<u8>) {
        let resp = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .header(header::COOKIE, format!("{COOKIE_NAME}={cookie}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = resp.status();
        let headers = resp.headers().clone();
        let body = to_bytes(resp.into_body(), 16 << 20).await.unwrap().to_vec();
        (status, headers, body)
    }

    fn assert_private_headers(headers: &HeaderMap, uri: &str) {
        assert_eq!(
            headers.get(header::CACHE_CONTROL).unwrap(),
            PRIVATE_CACHE_CONTROL,
            "{uri}"
        );
        assert_eq!(headers.get(header::VARY).unwrap(), PRIVATE_VARY, "{uri}");
    }

    /// Every route that can expose the circle gallery, for its slug.
    fn gated_uris(c: &Circle) -> Vec<String> {
        vec![
            "/@aliceh/andromeda-nights".to_string(),
            "/@aliceh/andromeda-nights/manifest.json".to_string(),
            "/@aliceh/andromeda-nights/bundle.json".to_string(),
            format!("/@aliceh/andromeda-nights/records/{}", c.rkey),
            format!("/@aliceh/andromeda-nights/images/{}.png", c.f.image.id),
            format!("/@aliceh/andromeda-nights/thumbs/{}.jpg", c.f.image.id),
            format!("/blob/{}", c.preview_cid),
            format!("/blob/{}", c.f.blob_id),
            format!(
                "/xrpc/com.atproto.repo.getRecord?repo={DID}&collection={COLLECTION_NSID}&rkey=andromeda-nights"
            ),
            format!(
                "/xrpc/com.atproto.repo.getRecord?repo=aliceh&collection={IMAGE_NSID}&rkey={}",
                c.rkey
            ),
        ]
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn circle_gallery_access_matrix() {
        let c = circle_fixture().await;
        assert_eq!(
            c.signed.uri,
            format!("at://{DID}/{COLLECTION_NSID}/andromeda-nights")
        );

        // Owner and circle member: 200 everywhere, marked private.
        for token in [&c.alice, &c.bob] {
            for uri in gated_uris(&c) {
                let (status, headers, _) = request(&c.router, "GET", &uri, Some(token), None).await;
                assert_eq!(status, StatusCode::OK, "{uri}");
                assert_private_headers(&headers, &uri);
            }
            // The /at/ resolver redirects for them.
            let (status, headers, _) = request(
                &c.router,
                "GET",
                &format!("/at/{DID}/{COLLECTION_NSID}/andromeda-nights"),
                Some(token),
                None,
            )
            .await;
            assert_eq!(status, StatusCode::FOUND);
            assert_eq!(
                headers.get(header::LOCATION).unwrap(),
                "/@aliceh/andromeda-nights"
            );
        }

        // Stranger with an account + DID, and anonymous: 404 everywhere,
        // including the resolver (a redirect would confirm existence).
        let mut denied = gated_uris(&c);
        denied.push(format!("/at/{DID}/{COLLECTION_NSID}/andromeda-nights"));
        denied.push(format!("/at/{DID}/{IMAGE_NSID}/{}", c.rkey));
        for uri in &denied {
            let (status, _, _) = request(&c.router, "GET", uri, Some(&c.carol), None).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "carol {uri}");
            let (status, _, _) = get(&c.router, uri).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "anonymous {uri}");
        }

        // The session cookie identifies a viewer too (plain <img> tags);
        // a forged or expired one is simply anonymous, never a 401.
        let now = chrono::Utc::now().timestamp();
        let good = mint_cookie_value(&c.f.state.session_key, "bob", now + 600);
        let (status, headers, _) =
            get_cookie(&c.router, "/@aliceh/andromeda-nights/bundle.json", &good).await;
        assert_eq!(status, StatusCode::OK);
        assert_private_headers(&headers, "bundle via cookie");
        let expired = mint_cookie_value(&c.f.state.session_key, "bob", now - 1);
        let (status, _, _) =
            get_cookie(&c.router, "/@aliceh/andromeda-nights/bundle.json", &expired).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let forged = mint_cookie_value(&[9u8; 32], "bob", now + 600);
        let (status, _, _) =
            get_cookie(&c.router, "/@aliceh/andromeda-nights/bundle.json", &forged).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        // A bogus bearer on a public route is anonymous as well.
        let (status, _, _) = request(
            &c.router,
            "GET",
            "/@aliceh/andromeda-nights",
            Some("astra_notatoken"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // Membership is live: drop the edge and bob is a stranger on the
        // very next request.
        kith::storage::GraphStore::remove_edge(
            &c.f.state.kith(),
            &UserId("alice".into()),
            &EntityId::user(&UserId("bob".into())),
            &EdgeKind::Circle("family".into()),
        )
        .await
        .unwrap();
        let (status, _, _) = request(
            &c.router,
            "GET",
            "/@aliceh/andromeda-nights",
            Some(&c.bob),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stub_is_public_signed_and_points_at_the_private_collection() {
        let c = circle_fixture().await;
        let stub_uri = format!("at://{DID}/{STUB_NSID}/andromeda-nights");

        // Stored public, beside the private records.
        let rows: Vec<(String, bool)> = published_records::table
            .filter(published_records::collection_id.eq(&c.f.public_collection.id))
            .select((published_records::uri, published_records::private))
            .load(&mut c.f.state.db.get().unwrap())
            .unwrap();
        assert_eq!(rows.len(), 3, "{rows:?}");
        for (uri, private) in &rows {
            assert_eq!(*private, uri != &stub_uri, "{uri}");
        }

        // Served to anyone via getRecord, with the public cache policy.
        let (status, headers, body) = get(
            &c.router,
            &format!(
                "/xrpc/com.atproto.repo.getRecord?repo={DID}&collection={STUB_NSID}&rkey=andromeda-nights"
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers.get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=60"
        );
        assert!(headers.get(header::VARY).is_none());
        let v = json(&body);
        assert_eq!(v["uri"], stub_uri);
        assert_eq!(v["value"]["$type"], STUB_NSID);
        assert_eq!(v["value"]["subject"], c.signed.uri);
        assert_eq!(v["value"]["subjectCid"], c.signed.cid);
        assert_eq!(v["value"]["host"], "https://astra.test");
        assert_eq!(v["value"]["visibility"], "circle:family");

        // The stored bytes parse, validate against the stub lexicon and
        // verify against alice's DID document.
        let signed: SignedRecord<StubRecord> =
            serde_json::from_str(&stored(&c.f, &stub_uri)).unwrap();
        assert_eq!(signed.record.body.subject.to_string(), c.signed.uri);
        assert_eq!(signed.record.body.subject_cid, c.signed.cid);
        let signer = c.f.state.signer.as_ref().unwrap();
        signer.lexicons.validate_record(&signed.record).unwrap();
        let verified = kenning::envelope::verify(&signed, &resolver(&c.f))
            .await
            .expect("stub signature verifies");
        assert_eq!(verified.did.as_str(), DID);

        // The private collection record itself verifies for a member and
        // says what it is.
        let (_, _, body) = request(
            &c.router,
            "GET",
            "/@aliceh/andromeda-nights/manifest.json",
            Some(&c.bob),
            None,
        )
        .await;
        let collection: SignedRecord<CollectionBody> = serde_json::from_slice(&body).unwrap();
        assert_eq!(collection.record.body.visibility, "circle:family");
        kenning::envelope::verify(&collection, &resolver(&c.f))
            .await
            .expect("collection signature verifies");

        // /at/ for the stub URI: public 302 to the gallery (which then
        // 404s for non-members); the private subject URI stays 404.
        let (status, headers, _) = get(
            &c.router,
            &format!("/at/{DID}/{STUB_NSID}/andromeda-nights"),
        )
        .await;
        assert_eq!(status, StatusCode::FOUND);
        assert_eq!(
            headers.get(header::LOCATION).unwrap(),
            "/@aliceh/andromeda-nights"
        );
        let (status, _, _) = get(
            &c.router,
            &format!("/at/aliceh/{STUB_NSID}/andromeda-nights"),
        )
        .await;
        assert_eq!(status, StatusCode::FOUND);
        let (status, _, _) = get(
            &c.router,
            &format!("/at/{DID}/{COLLECTION_NSID}/andromeda-nights"),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn profile_lists_circle_gallery_to_members_only_and_never_the_stub() {
        let c = circle_fixture().await;
        let at_uri = format!("at://{DID}/{COLLECTION_NSID}/andromeda-nights");

        let (status, headers, body) = get(&c.router, "/@aliceh").await;
        assert_eq!(status, StatusCode::OK);
        let anon = String::from_utf8(body).unwrap();
        assert!(
            !anon.contains("andromeda-nights"),
            "anonymous must not see it"
        );
        assert!(anon.contains("No public galleries yet."));
        assert_eq!(
            headers.get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=60"
        );

        let (status, _, body) = request(&c.router, "GET", "/@aliceh", Some(&c.carol), None).await;
        assert_eq!(status, StatusCode::OK);
        let stranger = String::from_utf8(body).unwrap();
        assert!(!stranger.contains("andromeda-nights"));

        for token in [&c.bob, &c.alice] {
            let (status, headers, body) =
                request(&c.router, "GET", "/@aliceh", Some(token), None).await;
            assert_eq!(status, StatusCode::OK);
            assert_private_headers(&headers, "profile for a member");
            let page = String::from_utf8(body).unwrap();
            assert!(page.contains(r#"<a href="/@aliceh/andromeda-nights">Andromeda Nights</a>"#));
            assert!(
                page.contains(&at_uri),
                "the gallery's own at:// URI is listed"
            );
            assert!(!page.contains(STUB_NSID), "the stub is not a gallery");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn unpublish_removes_private_records_and_stub_republish_refreshes_stub() {
        let c = circle_fixture().await;
        let first_stub: SignedRecord<StubRecord> = serde_json::from_str(&stored(
            &c.f,
            &format!("at://{DID}/{STUB_NSID}/andromeda-nights"),
        ))
        .unwrap();

        // An image edit + re-sign: new collection CID, stub follows it.
        diesel::update(images_table::table.find(&c.f.image.id))
            .set(images_table::summary.eq(Some("Andromeda Galaxy")))
            .execute(&mut c.f.state.db.get().unwrap())
            .unwrap();
        let second = sign_publish(&c.f, &c.f.public_collection.id).await.unwrap();
        assert_eq!(second.uri, c.signed.uri);
        assert_ne!(second.cid, c.signed.cid);
        let second_stub: SignedRecord<StubRecord> = serde_json::from_str(&stored(
            &c.f,
            &format!("at://{DID}/{STUB_NSID}/andromeda-nights"),
        ))
        .unwrap();
        assert_eq!(second_stub.record.body.subject_cid, second.cid);
        assert_ne!(second_stub.cid, first_stub.cid);
        assert!(second_stub.record.body.updated_at >= first_stub.record.body.updated_at);
        // Still exactly collection + image + stub.
        let n: i64 = published_records::table
            .filter(published_records::collection_id.eq(&c.f.public_collection.id))
            .count()
            .get_result(&mut c.f.state.db.get().unwrap())
            .unwrap();
        assert_eq!(n, 3);

        // Back to public: the stub goes away and the records turn public.
        publish_collection_core(
            &c.f.state.db,
            "alice",
            &c.f.public_collection.id,
            PublishVisibility::Public,
            None,
        )
        .unwrap();
        sign_publish(&c.f, &c.f.public_collection.id).await.unwrap();
        let rows: Vec<(String, bool)> = published_records::table
            .filter(published_records::collection_id.eq(&c.f.public_collection.id))
            .select((published_records::uri, published_records::private))
            .load(&mut c.f.state.db.get().unwrap())
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows
            .iter()
            .all(|(uri, private)| !private && !uri.contains(STUB_NSID)));
        let (status, _, _) = get(
            &c.router,
            &format!(
                "/xrpc/com.atproto.repo.getRecord?repo={DID}&collection={STUB_NSID}&rkey=andromeda-nights"
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, headers, _) = get(&c.router, "/@aliceh/andromeda-nights/bundle.json").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers.get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=60"
        );

        // Circle again, then unpublish: private records AND stub are gone.
        publish_collection_core(
            &c.f.state.db,
            "alice",
            &c.f.public_collection.id,
            PublishVisibility::circle("family").unwrap(),
            None,
        )
        .unwrap();
        sign_publish(&c.f, &c.f.public_collection.id).await.unwrap();
        assert!(
            unpublish_collection_core(&c.f.state.db, "alice", &c.f.public_collection.id).unwrap()
        );
        let n: i64 = published_records::table
            .filter(published_records::user_id.eq("alice"))
            .count()
            .get_result(&mut c.f.state.db.get().unwrap())
            .unwrap();
        assert_eq!(n, 0);
        for uri in gated_uris(&c) {
            let (status, _, _) = request(&c.router, "GET", &uri, Some(&c.alice), None).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "owner after unpublish {uri}");
        }
    }

    /// Decision 2: an unlisted collection's blobs serve to anyone by CID,
    /// and an image that is in a public/unlisted collection keeps a public
    /// record even when a circle collection also carries it.
    #[tokio::test(flavor = "multi_thread")]
    async fn unlisted_blobs_serve_anonymously_and_public_membership_wins() {
        let c = circle_fixture().await;

        // Circle-only so far: the blob is gated.
        let (status, _, _) = get(&c.router, &format!("/blob/{}", c.preview_cid)).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // Put the same image into the unlisted "Drafts" (no signed records
        // needed for the blob rule) → public bytes by CID and blob id.
        add_image_to_collection_core(
            &c.f.state.db,
            "alice",
            &c.f.image.id,
            &c.f.unlisted_collection.id,
        )
        .unwrap();
        for uri in [
            format!("/blob/{}", c.preview_cid),
            format!("/blob/{}/preview", c.preview_cid),
            format!("/blob/{}", c.f.blob_id),
            format!("/blob/{}/thumbnail", c.f.blob_id),
        ] {
            let (status, headers, body) = get(&c.router, &uri).await;
            assert_eq!(status, StatusCode::OK, "{uri}");
            assert!(!body.is_empty());
            assert_eq!(
                headers.get(header::CACHE_CONTROL).unwrap(),
                "public, max-age=3600",
                "{uri}"
            );
        }
        // The circle gallery itself is still gated.
        let (status, _, _) = get(&c.router, "/@aliceh/andromeda-nights/bundle.json").await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // Re-signing the circle collection now stores the image record
        // public (the collection record stays private).
        sign_publish(&c.f, &c.f.public_collection.id).await.unwrap();
        let rows: Vec<(String, bool)> = published_records::table
            .filter(published_records::collection_id.eq(&c.f.public_collection.id))
            .select((published_records::uri, published_records::private))
            .load(&mut c.f.state.db.get().unwrap())
            .unwrap();
        let image_uri = format!("at://{DID}/{IMAGE_NSID}/{}", c.rkey);
        for (uri, private) in &rows {
            assert_eq!(*private, uri == &c.signed.uri, "{uri}");
        }
        assert!(rows.iter().any(|(uri, _)| uri == &image_uri));
        let (status, headers, _) = get(
            &c.router,
            &format!(
                "/xrpc/com.atproto.repo.getRecord?repo={DID}&collection={IMAGE_NSID}&rkey={}",
                c.rkey
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers.get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=60"
        );
        // ...and reachable through the unlisted gallery's records route.
        let (status, _, _) = get(&c.router, &format!("/@aliceh/drafts/records/{}", c.rkey)).await;
        assert_eq!(status, StatusCode::OK);
        let (status, _, _) = get(&c.router, "/@aliceh/drafts").await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn publish_api_accepts_circle_visibility_and_requires_a_did() {
        let f = fixture().await;
        let router = crate::daemon::router(f.state.clone());
        let token = mint_token(&f.state.db, "alice", "t").unwrap().token;
        let uri = format!("/api/collections/{}/publish", f.private_collection.id);
        let body = r#"{"visibility":"circle:family"}"#;

        // No DID yet: 400, nothing published.
        let (status, _, resp) = request(&router, "POST", &uri, Some(&token), Some(body)).await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{}",
            String::from_utf8_lossy(&resp)
        );
        assert_eq!(
            json(&resp)["error"],
            "circle visibility requires a linked DID"
        );
        let (status, _, _) = request(&router, "GET", &uri, Some(&token), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // Malformed circle name: rejected by the deserializer.
        let (status, _, _) = request(
            &router,
            "POST",
            &uri,
            Some(&token),
            Some(r#"{"visibility":"circle:Not Valid"}"#),
        )
        .await;
        assert!(status.is_client_error(), "{status}");

        // With a DID: stored as the kenning string, signed, stub present;
        // the response says `circle:family`.
        link_did(&f);
        let (status, _, resp) = request(&router, "POST", &uri, Some(&token), Some(body)).await;
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&resp));
        let v = json(&resp);
        assert_eq!(v["visibility"], "circle:family");
        assert_eq!(v["signed"], true);
        assert_eq!(v["slug"], "secret");
        let (stub_rkey, stub_private): (String, bool) = published_records::table
            .filter(published_records::collection_id.eq(&f.private_collection.id))
            .filter(published_records::collection.eq(STUB_NSID))
            .select((published_records::rkey, published_records::private))
            .first(&mut f.state.db.get().unwrap())
            .expect("stub stored");
        assert_eq!(stub_rkey, "secret");
        assert!(!stub_private);
        // Status for the owner reports the circle; anonymous gets nothing.
        let (status, _, resp) = request(&router, "GET", &uri, Some(&token), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json(&resp)["visibility"], "circle:family");
        let (status, _, _) = get(&router, "/@aliceh/secret").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _, _) = request(&router, "GET", "/@aliceh/secret", Some(&token), None).await;
        assert_eq!(status, StatusCode::OK);
    }

    /// Without `ASTRA_PUBLIC_URL` a circle publish fails loudly instead of
    /// writing a stub with no host.
    #[tokio::test(flavor = "multi_thread")]
    async fn circle_publish_needs_a_public_url() {
        let f = fixture().await;
        link_did(&f);
        publish_collection_core(
            &f.state.db,
            "alice",
            &f.public_collection.id,
            PublishVisibility::circle("family").unwrap(),
            None,
        )
        .unwrap();
        let key = kenning::keys::SigningKey::generate(kenning::keys::KeyAlgo::Secp256k1);
        let lexicons = kenning::lexicon::LexiconRegistry::from_dir(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../lexicons"
        ))
        .unwrap();
        let signer = crate::share::records::Signer::new(key, "astra", lexicons);
        let err = tokio::task::spawn_blocking({
            let state = f.state.clone();
            let id = f.public_collection.id.clone();
            move || {
                crate::share::records::publish_signed(
                    &state.db,
                    &state.hoardfs,
                    &signer,
                    "alice",
                    &id,
                )
            }
        })
        .await
        .unwrap()
        .unwrap_err();
        assert!(err.to_string().contains(PUBLIC_URL_ENV), "{err}");
        let n: i64 = published_records::table
            .count()
            .get_result(&mut f.state.db.get().unwrap())
            .unwrap();
        assert_eq!(n, 0);
    }
}
