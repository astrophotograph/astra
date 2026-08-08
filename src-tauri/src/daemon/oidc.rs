//! OIDC (Zitadel) session authentication for the daemon.
//!
//! Browser sessions present Zitadel-issued JWTs as bearer tokens. PATs carry
//! the `astra_` prefix, so [`super::auth::require_auth`] routes on the
//! prefix — one `AuthedUser` context, two credential types.
//!
//! Configuration comes from `ASTRA_OIDC_ISSUER` + `ASTRA_OIDC_CLIENT_ID`
//! (see `init_backend`); with either unset, JWT bearer tokens are rejected
//! and only PATs authenticate. Signing keys are fetched via OIDC discovery
//! (`{issuer}/.well-known/openid-configuration` → `jwks_uri`), cached by
//! `kid`, and refreshed when an unknown `kid` appears (rate-limited).
//!
//! # Provisioning state machine (invite-gated)
//!
//! - known `external_subject`, active → authenticated
//! - known `external_subject`, invited → activate (finish onboarding)
//! - known `external_subject`, disabled → 403
//! - unknown subject, an *invited* row matches the token email with no
//!   subject linked → link subject, activate, ensure the user volume
//! - anything else → 403 "invite required". Notably an *active* row with a
//!   matching email but no linked subject does NOT auto-link — email-based
//!   linking is honored only for rows the owner explicitly invited, so a
//!   forged/unverified email claim can never take over an existing account.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use diesel::prelude::*;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;

use super::auth::{AuthError, AuthedUser};
use crate::db::schema::users;
use crate::db::tenancy::{self, UserRole, UserStatus};
use crate::db::DbPool;

#[derive(Debug, Clone)]
pub struct OidcConfig {
    /// Token issuer, e.g. `https://auth.bcc.sh`.
    pub issuer: String,
    /// The Zitadel application's client id — validated against `aud`.
    pub client_id: String,
}

/// Claims the daemon consumes from a verified token.
#[derive(Debug, Clone)]
pub struct VerifiedClaims {
    pub sub: String,
    pub email: Option<String>,
    pub preferred_username: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawClaims {
    sub: String,
    email: Option<String>,
    preferred_username: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

#[derive(Debug, Deserialize)]
struct Jwk {
    kty: String,
    kid: Option<String>,
    n: Option<String>,
    e: Option<String>,
}

/// Verifies Zitadel JWTs against a kid-keyed JWKS cache.
pub struct OidcVerifier {
    config: OidcConfig,
    /// None → static key set (tests); no network refresh.
    http: Option<reqwest::Client>,
    keys: RwLock<HashMap<String, DecodingKey>>,
    /// Rate-limits JWKS refreshes triggered by unknown kids.
    last_refresh: tokio::sync::Mutex<Option<Instant>>,
}

const REFRESH_MIN_INTERVAL: Duration = Duration::from_secs(30);

impl OidcVerifier {
    /// The issuer + client id this verifier was built with — the SPA login
    /// flow reads them from `/api/session/config`.
    pub fn config(&self) -> &OidcConfig {
        &self.config
    }

    pub fn new(config: OidcConfig) -> Self {
        Self {
            config,
            http: Some(reqwest::Client::new()),
            keys: RwLock::new(HashMap::new()),
            last_refresh: tokio::sync::Mutex::new(None),
        }
    }

    /// Test constructor: fixed key set, no discovery, no refresh.
    pub fn with_static_keys(config: OidcConfig, keys: HashMap<String, DecodingKey>) -> Self {
        Self {
            config,
            http: None,
            keys: RwLock::new(keys),
            last_refresh: tokio::sync::Mutex::new(None),
        }
    }

    fn key_for(&self, kid: &str) -> Option<DecodingKey> {
        self.keys.read().ok()?.get(kid).cloned()
    }

    async fn refresh_keys(&self) -> Result<(), String> {
        let Some(http) = &self.http else {
            return Ok(()); // static key set — nothing to refresh
        };

        let mut gate = self.last_refresh.lock().await;
        if let Some(t) = *gate {
            if t.elapsed() < REFRESH_MIN_INTERVAL {
                return Ok(()); // recently refreshed; unknown kid stays unknown
            }
        }

        let discovery_url = format!(
            "{}/.well-known/openid-configuration",
            self.config.issuer.trim_end_matches('/')
        );
        let discovery: serde_json::Value = http
            .get(&discovery_url)
            .send()
            .await
            .map_err(|e| format!("OIDC discovery fetch: {e}"))?
            .json()
            .await
            .map_err(|e| format!("OIDC discovery parse: {e}"))?;
        let jwks_uri = discovery["jwks_uri"]
            .as_str()
            .ok_or("OIDC discovery document has no jwks_uri")?;

        let jwks: Jwks = http
            .get(jwks_uri)
            .send()
            .await
            .map_err(|e| format!("JWKS fetch: {e}"))?
            .json()
            .await
            .map_err(|e| format!("JWKS parse: {e}"))?;

        let mut map = HashMap::new();
        for jwk in jwks.keys {
            if jwk.kty != "RSA" {
                continue;
            }
            if let (Some(kid), Some(n), Some(e)) = (jwk.kid, jwk.n, jwk.e) {
                match DecodingKey::from_rsa_components(&n, &e) {
                    Ok(key) => {
                        map.insert(kid, key);
                    }
                    Err(err) => log::warn!("skipping malformed JWK {kid}: {err}"),
                }
            }
        }
        if map.is_empty() {
            return Err("JWKS contained no usable RSA keys".to_string());
        }

        *self.keys.write().map_err(|_| "key cache poisoned")? = map;
        *gate = Some(Instant::now());
        Ok(())
    }

    /// Verify signature, `iss`, `aud`, and `exp`; return the claims.
    pub async fn verify(&self, token: &str) -> Result<VerifiedClaims, String> {
        let header = decode_header(token).map_err(|e| format!("bad JWT header: {e}"))?;
        let kid = header.kid.ok_or("JWT has no kid")?;

        let key = match self.key_for(&kid) {
            Some(k) => k,
            None => {
                self.refresh_keys().await?;
                self.key_for(&kid)
                    .ok_or_else(|| format!("no signing key for kid {kid}"))?
            }
        };

        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[&self.config.issuer]);
        validation.set_audience(&[&self.config.client_id]);

        let data = decode::<RawClaims>(token, &key, &validation)
            .map_err(|e| format!("JWT rejected: {e}"))?;
        Ok(VerifiedClaims {
            sub: data.claims.sub,
            email: data.claims.email,
            preferred_username: data.claims.preferred_username,
        })
    }
}

/// Map verified claims to a user row, provisioning per the invite-gated
/// state machine in the module docs. Blocking (diesel + HoardFS).
pub fn resolve_user(
    db: &DbPool,
    hoardfs: &Arc<Mutex<hoardfs_volume::HoardFs>>,
    claims: &VerifiedClaims,
) -> Result<AuthedUser, AuthError> {
    let mut conn = db.get().map_err(|e| AuthError::Db(e.to_string()))?;

    // Known subject.
    let by_sub: Option<(String, String, String)> = users::table
        .filter(users::external_subject.eq(&claims.sub))
        .select((users::id, users::role, users::status))
        .first(&mut conn)
        .optional()
        .map_err(|e| AuthError::Db(e.to_string()))?;

    if let Some((user_id, role, status)) = by_sub {
        let role = UserRole::parse(&role).map_err(AuthError::Db)?;
        return match UserStatus::parse(&status).map_err(AuthError::Db)? {
            UserStatus::Active => Ok(AuthedUser { user_id, role }),
            UserStatus::Invited => {
                activate(&mut conn, hoardfs, &user_id, None)?;
                Ok(AuthedUser { user_id, role })
            }
            UserStatus::Disabled => Err(AuthError::Forbidden("account disabled")),
        };
    }

    // Unknown subject: only an owner-invited row may claim it, by email.
    if let Some(email) = &claims.email {
        let invited: Option<(String, String, Option<String>)> = users::table
            .filter(users::email.eq(email))
            .filter(users::status.eq(UserStatus::Invited.as_str()))
            .filter(users::external_subject.is_null())
            .select((users::id, users::role, users::username))
            .first(&mut conn)
            .optional()
            .map_err(|e| AuthError::Db(e.to_string()))?;

        if let Some((user_id, role, username)) = invited {
            let role = UserRole::parse(&role).map_err(AuthError::Db)?;
            diesel::update(users::table.find(&user_id))
                .set(users::external_subject.eq(Some(&claims.sub)))
                .execute(&mut conn)
                .map_err(|e| AuthError::Db(e.to_string()))?;
            let fill_username = username
                .is_none()
                .then(|| claims.preferred_username.as_deref())
                .flatten();
            activate(&mut conn, hoardfs, &user_id, fill_username)?;
            return Ok(AuthedUser { user_id, role });
        }
    }

    Err(AuthError::Forbidden("invite required"))
}

/// Flip a user to active, optionally claim a username (only if valid and
/// unused — otherwise left for the user to choose later), and make sure
/// their HoardFS volume exists.
fn activate(
    conn: &mut SqliteConnection,
    hoardfs: &Arc<Mutex<hoardfs_volume::HoardFs>>,
    user_id: &str,
    fill_username: Option<&str>,
) -> Result<(), AuthError> {
    diesel::update(users::table.find(user_id))
        .set(users::status.eq(UserStatus::Active.as_str()))
        .execute(conn)
        .map_err(|e| AuthError::Db(e.to_string()))?;

    if let Some(candidate) = fill_username {
        if tenancy::validate_username(candidate).is_ok() {
            let taken: i64 = users::table
                .filter(users::username.eq(candidate))
                .count()
                .get_result(conn)
                .map_err(|e| AuthError::Db(e.to_string()))?;
            if taken == 0 {
                diesel::update(users::table.find(user_id))
                    .set(users::username.eq(Some(candidate)))
                    .execute(conn)
                    .map_err(|e| AuthError::Db(e.to_string()))?;
            }
        }
    }

    let hfs = hoardfs
        .lock()
        .map_err(|_| AuthError::Db("HoardFS lock poisoned".to_string()))?;
    tenancy::ensure_user_volume(&hfs, user_id).map_err(AuthError::Db)?;
    Ok(())
}

/// Shared JWT test fixtures (also used by the session-cookie tests).
#[cfg(test)]
pub(crate) mod test_jwt {
    use super::*;
    use jsonwebtoken::{encode, EncodingKey, Header};
    use serde::Serialize;
    use std::collections::HashMap;

    // Test-only RSA keypair — a fixture, not a secret. Never used outside
    // these tests.
    pub(crate) const TEST_RSA_PEM: &str = "-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQChIiv+QD/95zl7
zQW/fAK7XszxoAJmFDLY9nzAJEjTh8fi5zlNL1LK9RUEp72WvogOATerHtLqtKtI
tIIMYUxQ95RKBqEh36su7Fs9/BKvZn1pBbrEsyYyCRhzoAs/2ohJZ4aatvjFiEuW
ixKZM+IP7gBRyjk/bdXgyiotsCZKZPvOuV8fDhzTb0Qh7dYNZsU/nDldSpygJWTN
Q1xwaiYqZDcYo5G5zR8ubYk8Bkt5JMVXbqz6rLGq25zPo8dXMN5ljIt/Eqvfc/1W
YiVmqx1HC/V7hqzXi8th/bSDpVuooNn6rlUrWLTGfe1dt1dl+DAXx+oDeaJQC3Le
7jC2Qo2/AgMBAAECggEABHzl1MhdVT5iGidKXbGf3IV2F9S+ZwbGU8dUZNWd4aZf
1DC0e93cOc2RrvYtEExw5ahLBffEesewGET5dPbQyqsv9M/dH7W8bYDPxG4yPF29
EyEXDpt0GONVTFh3d759GpjzkCOV0jVK8FUh83pqdXR04Hz4Ezgv7iQzVd/DcUGg
xl7fWJifeXwrtWxuwOo1ZsC8MBfhY7LJ165LiQ9k+rvcgMQ/2WxFrmLSYL/0q3N4
Lt+a7Z/bvhEsHr7eX8TpNdFVPQcJzP+X/9ctatRadaBN0gQJwh9q/DO2m7n46ugx
6+MirfZEv+7B2nEoC8xTnoGtXlWopTtETyr2f8UEQQKBgQDYXYUrJA79pL+Lq9Tx
hXVp+jdG2sF4jsVRZaj8c1hQNc1A4vq3lKvjvx7o8LzOJq4H/0xg4sohV3VktmC8
Cq5K06dUFSy+ozUHWZKO0VwcWIYU+glCKA3qQ9kvtHV5jX9dYfd9CXckAwXaPuwv
0YjAhaesam+kv8TKyfTSIl4QyQKBgQC+pow5qjfFsFNc+5gGv+g+Js0RD7WgG0Lg
Ags+mzufzTPF4Eh2PZwHQ3qmhmzR7acJT4/P8Pj/sYSUfLMV9jej1Hvhz8XtaszA
leP7R9SGu0Wgmem4XEy7BgP2BYWf+PDwJk9y0Ae0615ke67xZ1EJcldsKJpPEDHe
56K+H9W2RwKBgBHO0LEWTK2Pq7xBLkuaomlQkNAiHR5hEdh7N4dfrvsbEoOuqtgF
QoiCKHcfqUqGYHiECLNItz47Row9foS7lFDQTsta2s3t/OVX9/oNPTmQB6keUzjA
tzR61RtaDPkuLjdvYsFF0CqEnSyzVRkyc8D0vzIvqHS02+uc56uL7JYRAoGAdXA+
XJ8f7+Sn1VUd1rqMIwzfsSzOIqvoS/i2WIBjABL1W2TG/h8BZ/AHM2EG02HjTPb3
jY3QtCDznEwcPOEIcSDIltbYA2GQculiID2lCsF9KGrm76vbkDEqa3gHUf2U3Tmc
IwtGVAnQgXE22HleD8WhWHzCYQWG0to5A4i0qq0CgYBM9tMa7brq77ua4mZeEdSj
GYCJllo6UXusE+dGKxl5n9Vvr2fTw2MEctPkzDLMSls3SP0O9dNb5TTxaqRF3D7Z
m0tIumDYhGoHXh/eyEFNnhL5ECvMe0mxjMZsvyov7kpAdo1+1DZDtLMUAbUx3uhy
i4Dfn7SyS3H/p6KNDaJ+Xg==
-----END PRIVATE KEY-----";
    pub(crate) const TEST_N: &str = "oSIr_kA__ec5e80Fv3wCu17M8aACZhQy2PZ8wCRI04fH4uc5TS9SyvUVBKe9lr6IDgE3qx7S6rSrSLSCDGFMUPeUSgahId-rLuxbPfwSr2Z9aQW6xLMmMgkYc6ALP9qISWeGmrb4xYhLlosSmTPiD-4AUco5P23V4MoqLbAmSmT7zrlfHw4c029EIe3WDWbFP5w5XUqcoCVkzUNccGomKmQ3GKORuc0fLm2JPAZLeSTFV26s-qyxqtucz6PHVzDeZYyLfxKr33P9VmIlZqsdRwv1e4as14vLYf20g6VbqKDZ-q5VK1i0xn3tXbdXZfgwF8fqA3miUAty3u4wtkKNvw";
    pub(crate) const TEST_E: &str = "AQAB";
    pub(crate) const ISSUER: &str = "https://auth.test";
    pub(crate) const CLIENT_ID: &str = "astra-test";

    #[derive(Serialize)]
    pub(crate) struct TestClaims {
        pub(crate) sub: String,
        pub(crate) iss: String,
        pub(crate) aud: String,
        pub(crate) exp: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub(crate) email: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub(crate) preferred_username: Option<String>,
    }

    pub(crate) fn verifier() -> OidcVerifier {
        let mut keys = HashMap::new();
        keys.insert(
            "test-key".to_string(),
            DecodingKey::from_rsa_components(TEST_N, TEST_E).unwrap(),
        );
        OidcVerifier::with_static_keys(
            OidcConfig {
                issuer: ISSUER.to_string(),
                client_id: CLIENT_ID.to_string(),
            },
            keys,
        )
    }

    pub(crate) fn sign(claims: &TestClaims, kid: &str) -> String {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some(kid.to_string());
        encode(
            &header,
            claims,
            &EncodingKey::from_rsa_pem(TEST_RSA_PEM.as_bytes()).unwrap(),
        )
        .unwrap()
    }

    pub(crate) fn valid_claims(
        sub: &str,
        email: Option<&str>,
        username: Option<&str>,
    ) -> TestClaims {
        TestClaims {
            sub: sub.to_string(),
            iss: ISSUER.to_string(),
            aud: CLIENT_ID.to_string(),
            exp: chrono::Utc::now().timestamp() + 3600,
            email: email.map(str::to_string),
            preferred_username: username.map(str::to_string),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_jwt::*;
    use super::*;
    use crate::daemon::DaemonState;
    use crate::db::test_support::test_pool;

    async fn test_state(with_oidc: bool) -> (Arc<DaemonState>, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let hfs = hoardfs_volume::HoardFs::init(&tmp.path().join("hoardfs"))
            .await
            .unwrap();
        let state = Arc::new(DaemonState {
            db: test_pool(),
            hoardfs: Arc::new(Mutex::new(hfs)),
            oidc: with_oidc.then(|| Arc::new(verifier())),
            limits: Default::default(),
            session_key: [7u8; 32],
            processing: Default::default(),
            tetra3_db: None,
        });
        (state, tmp)
    }

    fn insert_invited(db: &DbPool, id: &str, email: &str, username: Option<&str>) {
        diesel::insert_into(users::table)
            .values((
                users::id.eq(id),
                users::email.eq(Some(email)),
                users::username.eq(username),
                users::status.eq(UserStatus::Invited.as_str()),
            ))
            .execute(&mut db.get().unwrap())
            .unwrap();
    }

    #[tokio::test]
    async fn verify_accepts_valid_and_rejects_tampered() {
        let v = verifier();

        let token = sign(&valid_claims("z-1", Some("a@example.org"), None), "test-key");
        let claims = v.verify(&token).await.unwrap();
        assert_eq!(claims.sub, "z-1");
        assert_eq!(claims.email.as_deref(), Some("a@example.org"));

        // Expired (beyond the default leeway).
        let mut expired = valid_claims("z-1", None, None);
        expired.exp = chrono::Utc::now().timestamp() - 3600;
        assert!(v.verify(&sign(&expired, "test-key")).await.is_err());

        // Wrong issuer / audience.
        let mut bad_iss = valid_claims("z-1", None, None);
        bad_iss.iss = "https://evil.test".to_string();
        assert!(v.verify(&sign(&bad_iss, "test-key")).await.is_err());
        let mut bad_aud = valid_claims("z-1", None, None);
        bad_aud.aud = "other-app".to_string();
        assert!(v.verify(&sign(&bad_aud, "test-key")).await.is_err());

        // Unknown kid (static set — refresh is a no-op) and garbage.
        assert!(v
            .verify(&sign(&valid_claims("z-1", None, None), "other-key"))
            .await
            .is_err());
        assert!(v.verify("not.a.jwt").await.is_err());
    }

    #[tokio::test]
    async fn invited_email_activates_links_and_gets_volume() {
        let (state, _tmp) = test_state(false).await;
        insert_invited(&state.db, "u-inv", "friend@example.org", None);

        let claims = VerifiedClaims {
            sub: "zitadel|42".to_string(),
            email: Some("friend@example.org".to_string()),
            preferred_username: Some("friend".to_string()),
        };
        let authed = resolve_user(&state.db, &state.hoardfs, &claims).unwrap();
        assert_eq!(authed.user_id, "u-inv");
        assert_eq!(authed.role, UserRole::Member);

        let (status, sub, username): (String, Option<String>, Option<String>) = users::table
            .find("u-inv")
            .select((users::status, users::external_subject, users::username))
            .first(&mut state.db.get().unwrap())
            .unwrap();
        assert_eq!(status, "active");
        assert_eq!(sub.as_deref(), Some("zitadel|42"));
        assert_eq!(username.as_deref(), Some("friend"));

        let volumes = state.hoardfs.lock().unwrap().list_volumes().unwrap();
        assert!(volumes.iter().any(|v| v.name == "user-u-inv"));

        // Second login resolves by subject, no re-provisioning.
        let again = resolve_user(&state.db, &state.hoardfs, &claims).unwrap();
        assert_eq!(again.user_id, "u-inv");
    }

    #[tokio::test]
    async fn uninvited_disabled_and_active_unlinked_are_forbidden() {
        let (state, _tmp) = test_state(false).await;

        // Unknown subject and email → invite required.
        let stranger = VerifiedClaims {
            sub: "zitadel|999".to_string(),
            email: Some("stranger@example.org".to_string()),
            preferred_username: None,
        };
        assert!(matches!(
            resolve_user(&state.db, &state.hoardfs, &stranger),
            Err(AuthError::Forbidden("invite required"))
        ));

        // Disabled user with a linked subject → forbidden.
        diesel::insert_into(users::table)
            .values((
                users::id.eq("u-dis"),
                users::external_subject.eq(Some("zitadel|dis")),
                users::status.eq(UserStatus::Disabled.as_str()),
            ))
            .execute(&mut state.db.get().unwrap())
            .unwrap();
        let disabled = VerifiedClaims {
            sub: "zitadel|dis".to_string(),
            email: None,
            preferred_username: None,
        };
        assert!(matches!(
            resolve_user(&state.db, &state.hoardfs, &disabled),
            Err(AuthError::Forbidden("account disabled"))
        ));

        // Active row with matching email but no linked subject must NOT
        // auto-link (account takeover guard). local-user has user@local.
        let takeover = VerifiedClaims {
            sub: "zitadel|attacker".to_string(),
            email: Some("user@local".to_string()),
            preferred_username: None,
        };
        assert!(matches!(
            resolve_user(&state.db, &state.hoardfs, &takeover),
            Err(AuthError::Forbidden("invite required"))
        ));
    }

    #[tokio::test]
    async fn taken_username_is_not_claimed_on_activation() {
        let (state, _tmp) = test_state(false).await;
        // local-user already holds 'erewhon' (tenancy backfill).
        insert_invited(&state.db, "u-dup", "dup@example.org", None);

        let claims = VerifiedClaims {
            sub: "zitadel|dup".to_string(),
            email: Some("dup@example.org".to_string()),
            preferred_username: Some("erewhon".to_string()),
        };
        let authed = resolve_user(&state.db, &state.hoardfs, &claims).unwrap();
        assert_eq!(authed.user_id, "u-dup");

        let username: Option<String> = users::table
            .find("u-dup")
            .select(users::username)
            .first(&mut state.db.get().unwrap())
            .unwrap();
        assert_eq!(username, None, "colliding username must be left unset");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn router_accepts_jwt_sessions_and_rejects_uninvited() {
        use axum::body::to_bytes;
        use tower::ServiceExt;

        let (state, _tmp) = test_state(true).await;
        insert_invited(&state.db, "u-web", "web@example.org", Some("webuser"));
        let router = crate::daemon::router(state.clone());

        let get_me = |token: String| {
            let router = router.clone();
            async move {
                let resp = router
                    .oneshot(
                        axum::http::Request::builder()
                            .uri("/api/me")
                            .header("Authorization", format!("Bearer {token}"))
                            .body(axum::body::Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                let status = resp.status();
                let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
                (status, serde_json::from_slice::<serde_json::Value>(&bytes).unwrap())
            }
        };

        // Invited user's JWT session works end to end.
        let token = sign(
            &valid_claims("zitadel|web", Some("web@example.org"), None),
            "test-key",
        );
        let (status, body) = get_me(token).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(body["userId"], "u-web");
        assert_eq!(body["status"], "active");

        // Uninvited gets the friendly 403.
        let token = sign(
            &valid_claims("zitadel|nope", Some("nope@example.org"), None),
            "test-key",
        );
        let (status, body) = get_me(token).await;
        assert_eq!(status, axum::http::StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "forbidden");
        assert_eq!(body["message"], "invite required");

        // Expired JWT is a plain 401.
        let mut expired = valid_claims("zitadel|web", Some("web@example.org"), None);
        expired.exp = chrono::Utc::now().timestamp() - 3600;
        let (status, _) = get_me(sign(&expired, "test-key")).await;
        assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);
    }
}
