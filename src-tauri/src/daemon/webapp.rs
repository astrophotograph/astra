//! Browser app serving: `/app` static files + SPA fallback.
//!
//! The Vite web build (`pnpm build:web`, `base: "/app/"`) lands in a
//! directory on disk — `{data_dir}/web` by default, `ASTRA_WEB_DIST` to
//! override; `just deploy-staging` copies `dist-web/` there. Nothing is
//! embedded in the binary, so the bundle redeploys without a rebuild.
//!
//! Routes (merged into the daemon router ahead of nothing — axum static
//! segments already outrank the `/{user}` gallery captures, and `/api`,
//! `/healthz` are their own trees):
//!   - `/`               → redirect to `/app` when a bundle is present
//!   - `/app`, `/app/{*path}` → file if it exists, else `index.html` for
//!     extensionless paths (SPA client routes); dotted paths 404
//!   - `/auth/callback`  → `index.html` (the registered OIDC redirect URI
//!     lives outside the router basename; the SPA handles it pre-router)
//!
//! When no bundle is deployed every route here is a plain 404 and the
//! daemon behaves exactly as before this module existed.

use std::path::{Component, Path as FsPath, PathBuf};
use std::sync::Arc;

use axum::extract::Path;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::get;
use axum::Router;

pub fn routes<S>(web_dist: Option<PathBuf>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    let dist: Option<Arc<PathBuf>> = web_dist.map(Arc::new);
    let (root, index, callback, file) =
        (dist.clone(), dist.clone(), dist.clone(), dist);
    Router::new()
        .route(
            "/",
            get(move || {
                let dist = root.clone();
                async move {
                    match dist {
                        Some(_) => Redirect::temporary("/app").into_response(),
                        None => not_found(),
                    }
                }
            }),
        )
        .route(
            "/app",
            get(move || {
                let dist = index.clone();
                async move { serve_index(dist.as_deref()).await }
            }),
        )
        .route(
            "/app/{*path}",
            get(move |Path(path): Path<String>| {
                let dist = file.clone();
                async move { serve_file(dist.as_deref(), &path).await }
            }),
        )
        .route(
            "/auth/callback",
            get(move || {
                let dist = callback.clone();
                async move { serve_index(dist.as_deref()).await }
            }),
        )
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}

/// `index.html` must revalidate every load — it names the hashed bundles.
async fn serve_index(dist: Option<&PathBuf>) -> Response {
    let Some(dist) = dist else { return not_found() };
    match tokio::fs::read(dist.join("index.html")).await {
        Ok(bytes) => file_response(bytes, "text/html; charset=utf-8", "no-cache"),
        Err(_) => not_found(),
    }
}

async fn serve_file(dist: Option<&PathBuf>, raw: &str) -> Response {
    let Some(dist) = dist else { return not_found() };
    let Some(relative) = sanitize(raw) else { return not_found() };

    let full = dist.join(&relative);
    if let Ok(bytes) = tokio::fs::read(&full).await {
        let cache = if raw.starts_with("assets/") {
            // Vite content-hashes everything under assets/.
            "public, max-age=31536000, immutable"
        } else {
            "public, max-age=3600"
        };
        return file_response(bytes, mime_for(&relative), cache);
    }

    // SPA fallback: extensionless paths are client routes; anything that
    // looks like a file (has an extension) is genuinely missing.
    if relative.extension().is_none() {
        serve_index(Some(dist)).await
    } else {
        not_found()
    }
}

/// Reject traversal and anything that is not a plain relative path.
fn sanitize(raw: &str) -> Option<PathBuf> {
    if raw.contains('\0') || raw.contains('\\') {
        return None;
    }
    let path = FsPath::new(raw);
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            _ => return None, // ParentDir, RootDir, Prefix
        }
    }
    if clean.as_os_str().is_empty() {
        None
    } else {
        Some(clean)
    }
}

fn mime_for(path: &FsPath) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript",
        Some("css") => "text/css",
        Some("json") | Some("map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("wasm") => "application/wasm",
        Some("txt") => "text/plain; charset=utf-8",
        Some("webmanifest") => "application/manifest+json",
        _ => "application/octet-stream",
    }
}

fn file_response(bytes: Vec<u8>, mime: &'static str, cache: &'static str) -> Response {
    let mut response = (StatusCode::OK, bytes).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, header::HeaderValue::from_static(mime));
    headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static(cache),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use tower::ServiceExt;

    fn write_bundle(dir: &FsPath) {
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("index.html"), "<html>astra-web</html>").unwrap();
        std::fs::write(dir.join("assets/app-abc123.js"), "console.log(1)").unwrap();
        std::fs::write(dir.join("favicon.svg"), "<svg/>").unwrap();
    }

    async fn get(router: &Router, uri: &str) -> (StatusCode, Option<String>, String) {
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
        let cache = resp
            .headers()
            .get(header::CACHE_CONTROL)
            .map(|v| v.to_str().unwrap().to_string());
        let body = String::from_utf8_lossy(
            &to_bytes(resp.into_body(), 1 << 20).await.unwrap(),
        )
        .to_string();
        (status, cache, body)
    }

    fn app(dist: Option<PathBuf>) -> Router {
        routes::<()>(dist).with_state(())
    }

    #[tokio::test]
    async fn serves_index_files_and_spa_fallback() {
        let tmp = tempfile::tempdir().unwrap();
        write_bundle(tmp.path());
        let router = app(Some(tmp.path().to_path_buf()));

        let (status, cache, body) = get(&router, "/app").await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("astra-web"));
        assert_eq!(cache.as_deref(), Some("no-cache"));

        // Hashed asset: immutable cache.
        let (status, cache, body) = get(&router, "/app/assets/app-abc123.js").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "console.log(1)");
        assert_eq!(cache.as_deref(), Some("public, max-age=31536000, immutable"));

        // Non-hashed root file: short cache.
        let (status, cache, _) = get(&router, "/app/favicon.svg").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(cache.as_deref(), Some("public, max-age=3600"));

        // Client route → index; missing file with extension → 404.
        let (status, _, body) = get(&router, "/app/collections/some-id").await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("astra-web"));
        let (status, _, _) = get(&router, "/app/assets/missing.js").await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // OIDC callback serves the SPA; root redirects into it.
        let (status, _, body) = get(&router, "/auth/callback").await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("astra-web"));
        let resp = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::TEMPORARY_REDIRECT);
        assert_eq!(resp.headers().get(header::LOCATION).unwrap(), "/app");
    }

    #[tokio::test]
    async fn rejects_traversal_and_handles_missing_bundle() {
        let tmp = tempfile::tempdir().unwrap();
        write_bundle(tmp.path());
        std::fs::write(tmp.path().parent().unwrap().join("secret.txt"), "no").ok();
        let router = app(Some(tmp.path().to_path_buf()));

        for uri in [
            "/app/../secret.txt",
            "/app/assets/../../secret.txt",
            "/app/..%2Fsecret.txt",
            "/app/%2e%2e/secret.txt",
        ] {
            let (status, _, body) = get(&router, uri).await;
            assert!(
                !body.contains("no") || status == StatusCode::NOT_FOUND,
                "{uri} must not escape the dist dir"
            );
            assert_ne!(body, "no", "{uri} leaked a file outside dist");
        }

        // No bundle deployed: every route 404s, / included.
        let bare = app(None);
        for uri in ["/", "/app", "/app/anything", "/auth/callback"] {
            let (status, _, _) = get(&bare, uri).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{uri} without a bundle");
        }
    }
}
