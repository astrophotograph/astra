//! Handle verification for the public profile page.
//!
//! A user's DID document may claim handles in `alsoKnownAs`
//! (`at://alice.example.com`). A claim alone proves nothing — anyone can
//! write any handle into their own document — so the profile page shows a
//! handle only after the bidirectional check: the handle must resolve
//! (DNS TXT or `/.well-known/atproto-did`) back to the same DID. That is
//! what [`kenning::verify_handle`] does, minus the second document fetch:
//! we already hold the document the handle came from.
//!
//! Verification touches the network, so it is bounded by a short timeout
//! (the page falls back to showing the DID alone) and the outcome is
//! cached per DID: one hour for a definitive answer, a minute for a
//! transient failure (timeout, transport error) so a resolver hiccup does
//! not pin "DID only" for an hour.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kenning::{Did, Handle, HttpResolver, ResolveError, Resolver};

/// Default upper bound on the time a profile request waits for the resolver.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(2);
/// Cache lifetime of a definitive answer (verified handle, or none).
pub const POSITIVE_TTL: Duration = Duration::from_secs(60 * 60);
/// Cache lifetime after a timeout or transport failure.
pub const RETRY_TTL: Duration = Duration::from_secs(60);

/// Resolver + per-DID cache of the verified handle. Lives on `DaemonState`.
pub struct HandleCache {
    resolver: Arc<dyn Resolver>,
    timeout: Duration,
    cache: Mutex<HashMap<String, (Instant, Option<String>)>>,
}

impl Default for HandleCache {
    /// The network resolver (plc.directory, system DNS, well-known HTTP).
    fn default() -> Self {
        Self::new(Arc::new(HttpResolver::default()), DEFAULT_TIMEOUT)
    }
}

impl HandleCache {
    pub fn new(resolver: Arc<dyn Resolver>, timeout: Duration) -> Self {
        Self {
            resolver,
            timeout,
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// The DID resolver itself, for callers that verify signatures against
    /// a DID document (`signed_edges.rs`). Shares the network client and,
    /// in tests, the fake.
    pub fn resolver(&self) -> Arc<dyn Resolver> {
        self.resolver.clone()
    }

    /// The first handle the DID's document claims that resolves back to
    /// the DID, or `None` when there is none, the DID does not resolve, or
    /// the resolver did not answer within the timeout. Cached per DID.
    pub async fn verified_handle(&self, did: &str) -> Option<String> {
        if let Some(hit) = self.cached(did) {
            return hit;
        }
        let (result, ttl) = match tokio::time::timeout(self.timeout, self.verify(did)).await {
            Ok(Ok(handle)) => (handle, POSITIVE_TTL),
            Ok(Err(e)) if is_transient(&e) => {
                log::debug!("handle verification for {did} failed transiently: {e}");
                (None, RETRY_TTL)
            }
            Ok(Err(e)) => {
                log::debug!("handle verification for {did}: {e}");
                (None, POSITIVE_TTL)
            }
            Err(_) => {
                log::debug!(
                    "handle verification for {did} timed out after {:?}",
                    self.timeout
                );
                (None, RETRY_TTL)
            }
        };
        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(did.to_string(), (Instant::now() + ttl, result.clone()));
        }
        result
    }

    fn cached(&self, did: &str) -> Option<Option<String>> {
        let cache = self.cache.lock().ok()?;
        let (expires, handle) = cache.get(did)?;
        (Instant::now() < *expires).then(|| handle.clone())
    }

    /// `Ok(None)`: the document is fine but no claimed handle verifies.
    async fn verify(&self, did: &str) -> Result<Option<String>, ResolveError> {
        let did = Did::parse(did)?;
        let doc = self.resolver.resolve_did(&did).await?;
        for claimed in doc.handles() {
            let Ok(handle) = Handle::parse(claimed) else {
                continue;
            };
            match self.resolver.resolve_handle(&handle).await {
                Ok(resolved) if resolved == did => return Ok(Some(handle.as_str().to_string())),
                Ok(_) | Err(ResolveError::NotFound) | Err(ResolveError::HandleMismatch) => {}
                // A transport-level failure on one handle: keep trying the
                // others, but if none verifies the answer is transient.
                Err(e) if is_transient(&e) => return Err(e),
                Err(_) => {}
            }
        }
        Ok(None)
    }
}

fn is_transient(e: &ResolveError) -> bool {
    matches!(
        e,
        ResolveError::Transport(_) | ResolveError::Dns(_) | ResolveError::Http(500..=599, _)
    )
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use async_trait::async_trait;
    use kenning::DidDocument;
    use std::sync::atomic::{AtomicUsize, Ordering};

    pub(crate) const DID: &str = "did:plc:z72i7hdynmk6r22z27h6tvur";
    pub(crate) const OTHER_DID: &str = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";

    /// What the fake does when a handle is resolved.
    #[derive(Clone)]
    pub(crate) enum HandleAnswer {
        /// Resolve every handle to this DID.
        Did(&'static str),
        /// Fail with a definitive error.
        NotFound,
        /// Fail with a transport error.
        Transport,
        /// Never answer (sleep well past any test timeout).
        Hang,
    }

    /// A resolver whose DID document claims `handles` and whose handle
    /// resolution behaves per `answer`. Counts DID lookups so tests can
    /// prove the cache is hit.
    pub(crate) struct FakeResolver {
        pub(crate) handles: Vec<&'static str>,
        pub(crate) answer: HandleAnswer,
        pub(crate) did_lookups: AtomicUsize,
    }

    impl FakeResolver {
        pub(crate) fn new(handles: Vec<&'static str>, answer: HandleAnswer) -> Arc<Self> {
            Arc::new(Self {
                handles,
                answer,
                did_lookups: AtomicUsize::new(0),
            })
        }
    }

    #[async_trait]
    impl Resolver for FakeResolver {
        async fn resolve_did(&self, did: &Did) -> Result<DidDocument, ResolveError> {
            self.did_lookups.fetch_add(1, Ordering::SeqCst);
            if did.as_str() != DID {
                return Err(ResolveError::NotFound);
            }
            Ok(DidDocument {
                context: None,
                id: did.clone(),
                also_known_as: self.handles.iter().map(|h| format!("at://{h}")).collect(),
                verification_method: Vec::new(),
                service: Vec::new(),
            })
        }

        async fn resolve_handle(&self, _handle: &Handle) -> Result<Did, ResolveError> {
            match &self.answer {
                HandleAnswer::Did(d) => Ok(Did::parse(d).unwrap()),
                HandleAnswer::NotFound => Err(ResolveError::NotFound),
                HandleAnswer::Transport => Err(ResolveError::Transport("refused".into())),
                HandleAnswer::Hang => {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    Err(ResolveError::NotFound)
                }
            }
        }
    }

    fn cache(resolver: Arc<FakeResolver>) -> HandleCache {
        HandleCache::new(resolver, Duration::from_millis(100))
    }

    #[tokio::test]
    async fn first_verified_handle_wins_and_is_cached() {
        let resolver = FakeResolver::new(
            vec!["not a handle", "alice.example.com", "alt.example.com"],
            HandleAnswer::Did(DID),
        );
        let cache = cache(resolver.clone());
        assert_eq!(
            cache.verified_handle(DID).await.as_deref(),
            Some("alice.example.com")
        );
        assert_eq!(
            cache.verified_handle(DID).await.as_deref(),
            Some("alice.example.com")
        );
        assert_eq!(resolver.did_lookups.load(Ordering::SeqCst), 1, "cached");
    }

    #[tokio::test]
    async fn mismatch_not_found_and_unknown_did_give_none() {
        let mismatch = cache(FakeResolver::new(
            vec!["alice.example.com"],
            HandleAnswer::Did(OTHER_DID),
        ));
        assert_eq!(mismatch.verified_handle(DID).await, None);

        let unresolvable = cache(FakeResolver::new(
            vec!["alice.example.com"],
            HandleAnswer::NotFound,
        ));
        assert_eq!(unresolvable.verified_handle(DID).await, None);

        let no_claims = cache(FakeResolver::new(vec![], HandleAnswer::Did(DID)));
        assert_eq!(no_claims.verified_handle(DID).await, None);

        let unknown = cache(FakeResolver::new(
            vec!["alice.example.com"],
            HandleAnswer::Did(DID),
        ));
        assert_eq!(unknown.verified_handle(OTHER_DID).await, None);
        assert_eq!(unknown.verified_handle("not-a-did").await, None);
    }

    #[tokio::test]
    async fn timeout_and_transport_errors_fall_back_and_retry_sooner() {
        let hanging = FakeResolver::new(vec!["alice.example.com"], HandleAnswer::Hang);
        let cache_h = cache(hanging.clone());
        let started = Instant::now();
        assert_eq!(cache_h.verified_handle(DID).await, None);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "bounded by the timeout"
        );
        // The failure is cached (no second lookup within the retry window)…
        assert_eq!(cache_h.verified_handle(DID).await, None);
        assert_eq!(hanging.did_lookups.load(Ordering::SeqCst), 1);
        // …but with the short TTL, not the hour-long one.
        let expires = cache_h.cache.lock().unwrap().get(DID).unwrap().0;
        assert!(expires <= Instant::now() + RETRY_TTL);

        let flaky = FakeResolver::new(vec!["alice.example.com"], HandleAnswer::Transport);
        let cache_f = cache(flaky);
        assert_eq!(cache_f.verified_handle(DID).await, None);
        let expires = cache_f.cache.lock().unwrap().get(DID).unwrap().0;
        assert!(expires <= Instant::now() + RETRY_TTL);
    }
}
