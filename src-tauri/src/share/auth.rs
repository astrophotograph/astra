//! Clerk OAuth flow and API token management for astra.gallery.
//!
//! Flow:
//! 1. Start temp HTTP server on 127.0.0.1:{random_port}
//! 2. Open browser to Clerk hosted sign-in with redirect_url pointing to our callback
//! 3. Callback page loads Clerk JS SDK, extracts a real session JWT
//! 4. Callback page POSTs the JWT to our local server at /token
//! 5. We exchange it for a Worker API token via POST /api/auth/token
//! 6. Store API token in credential file

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const GALLERY_API_BASE: &str = "https://astra.gallery";
const AUTH_FILE: &str = "astra-gallery-auth.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub user_id: String,
    pub username: String,
    pub display_name: Option<String>,
    pub api_token: String,
    pub expires_at: String,
}

/// Start the OAuth flow: spawn a local HTTP server, open browser to Clerk sign-in.
/// Returns the AuthSession after successful authentication.
pub async fn sign_in(clerk_publishable_key: &str) -> Result<AuthSession, String> {
    // Find a free port
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind local server: {}", e))?;
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let redirect_url = format!("http://127.0.0.1:{}/callback", port);

    // Clerk hosted sign-in URL
    let clerk_domain = std::env::var("CLERK_DOMAIN")
        .unwrap_or_else(|_| "wired-walrus-5.accounts.dev".to_string());
    let sign_in_url = format!(
        "https://{}/sign-in?redirect_url={}",
        clerk_domain,
        urlencoded(&redirect_url),
    );

    // Start local server to receive callback
    let server = tiny_http::Server::http(format!("127.0.0.1:{}", port))
        .map_err(|e| format!("Failed to start callback server: {}", e))?;

    // Open browser (fall back to logging the URL if no display)
    if let Err(e) = open::that(&sign_in_url) {
        log::warn!("Could not open browser ({}), please open this URL manually:", e);
        log::info!("Sign in URL: {}", sign_in_url);
    }

    // Step 1: Serve the callback page (Clerk redirects here after sign-in)
    // The callback page loads Clerk JS, gets a session token, and POSTs it to /token
    let session_token = receive_callback(&server, clerk_publishable_key, &clerk_domain)?;

    // Step 2: Exchange Clerk session token for our Worker API token
    let auth_session = exchange_token(&session_token).await?;

    Ok(auth_session)
}

/// Handle the two-step callback:
/// 1. GET /callback — serve HTML page that uses Clerk JS to get a session token
/// 2. POST /token — receive the session token from the page
fn receive_callback(server: &tiny_http::Server, publishable_key: &str, clerk_domain: &str) -> Result<String, String> {
    // Wait for the callback GET request from Clerk redirect
    let request = server
        .recv_timeout(std::time::Duration::from_secs(120))
        .map_err(|e| format!("Callback server error: {}", e))?
        .ok_or("Authentication timed out")?;

    let url = request.url().to_string();
    log::info!("OAuth callback URL: {}", url);

    // Serve the callback HTML page that will extract the session token
    let callback_html = format!(
        r#"<!DOCTYPE html>
<html>
<head>
<title>Astra Gallery — Signing in...</title>
<style>
  body {{ background: #0a0e1a; color: #c8cdd8; font-family: system-ui; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }}
  .msg {{ text-align: center; }}
  h1 {{ color: #e8ecf4; font-size: 1.5rem; margin-bottom: 0.5rem; }}
  p {{ color: #6b7280; }}
  .error {{ color: #ef4444; }}
</style>
</head>
<body>
<div class="msg">
  <h1 id="title">Signing in...</h1>
  <p id="status">Completing authentication...</p>
</div>
<link rel="icon" href="data:,">
<script>
async function run() {{
  try {{
    document.getElementById("status").textContent = "Loading Clerk...";

    // Dynamically load Clerk JS
    await new Promise((resolve, reject) => {{
      const s = document.createElement("script");
      s.src = "https://{clerk_domain}/npm/@clerk/clerk-js@latest/dist/clerk.browser.js";
      s.crossOrigin = "anonymous";
      s.setAttribute("data-clerk-publishable-key", "{publishable_key}");
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    }});

    document.getElementById("status").textContent = "Initializing session...";

    const clerk = window.Clerk;
    await clerk.load();

    // Wait for session to be established
    let attempts = 0;
    while (!clerk.session && attempts < 30) {{
      await new Promise(r => setTimeout(r, 500));
      attempts++;
    }}

    if (!clerk.session) {{
      document.getElementById("title").textContent = "Sign-in failed";
      document.getElementById("status").textContent = "No session found after " + attempts + " attempts. Please try again.";
      document.getElementById("status").className = "error";
      return;
    }}

    document.getElementById("status").textContent = "Getting token...";

    // Get a fresh session token (this is a proper JWT)
    const token = await clerk.session.getToken();

    document.getElementById("status").textContent = "Sending to Astra...";

    // Send it to our local server
    const resp = await fetch("/token", {{
      method: "POST",
      headers: {{ "Content-Type": "application/json" }},
      body: JSON.stringify({{ token: token }})
    }});

    if (resp.ok) {{
      document.getElementById("title").textContent = "Signed in!";
      document.getElementById("status").textContent = "You can close this window and return to Astra.";
    }} else {{
      const err = await resp.text();
      document.getElementById("title").textContent = "Error";
      document.getElementById("status").textContent = err;
      document.getElementById("status").className = "error";
    }}
  }} catch (e) {{
    document.getElementById("title").textContent = "Error";
    document.getElementById("status").textContent = e.message || "Authentication failed";
    document.getElementById("status").className = "error";
  }}
}}
run();
</script>
</body>
</html>"#,
        publishable_key = publishable_key,
        clerk_domain = clerk_domain
    );

    let response = tiny_http::Response::from_string(&callback_html)
        .with_header(
            tiny_http::Header::from_bytes("Content-Type", "text/html; charset=utf-8").unwrap(),
        );
    let _ = request.respond(response);

    // Now wait for the POST /token request from the callback page
    // Skip any non-POST requests (favicon, etc.)
    let mut token_request;
    loop {
        token_request = server
            .recv_timeout(std::time::Duration::from_secs(30))
            .map_err(|e| format!("Token callback error: {}", e))?
            .ok_or("Token callback timed out")?;

        let token_url = token_request.url().to_string();
        log::info!("Received request: {} {}", token_request.method(), token_url);

        if token_request.method() == &tiny_http::Method::Post && token_url == "/token" {
            break;
        }

        // Respond to non-token requests with empty 200
        let empty = tiny_http::Response::from_string("");
        let _ = token_request.respond(empty);
    }

    // Read the POST body
    let mut body = String::new();
    token_request.as_reader()
        .read_to_string(&mut body)
        .map_err(|e| format!("Failed to read token body: {}", e))?;

    log::info!("Token callback body length: {}", body.len());

    // Parse the JSON body
    #[derive(Deserialize)]
    struct TokenBody {
        token: String,
    }

    let token_body: TokenBody = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse token body: {}", e))?;

    // Respond to the browser
    let ok_response = tiny_http::Response::from_string("ok")
        .with_header(
            tiny_http::Header::from_bytes("Content-Type", "text/plain").unwrap(),
        );
    let _ = token_request.respond(ok_response);

    Ok(token_body.token)
}

/// Exchange a Clerk session token for a Worker API token.
/// The Worker auto-registers new users using their Clerk username.
async fn exchange_token(clerk_session_token: &str) -> Result<AuthSession, String> {
    let client = reqwest::Client::new();

    let resp = client
        .post(format!("{}/api/auth/token", GALLERY_API_BASE))
        .header("Authorization", format!("Bearer {}", clerk_session_token))
        .send()
        .await
        .map_err(|e| format!("Token exchange failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Token exchange failed ({}): {}", status, body));
    }

    parse_token_response(resp).await
}

async fn parse_token_response(resp: reqwest::Response) -> Result<AuthSession, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TokenResponse {
        token: String,
        expires_at: String,
        user_id: String,
        username: String,
        display_name: Option<String>,
    }

    let token_resp: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))?;

    Ok(AuthSession {
        user_id: token_resp.user_id,
        username: token_resp.username,
        display_name: token_resp.display_name,
        api_token: token_resp.token,
        expires_at: token_resp.expires_at,
    })
}

/// Save the auth session to disk.
pub fn save_session(data_dir: &PathBuf, session: &AuthSession) -> Result<(), String> {
    let path = data_dir.join(AUTH_FILE);
    let json = serde_json::to_string_pretty(session)
        .map_err(|e| format!("Failed to serialize auth session: {}", e))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write auth file: {}", e))?;
    Ok(())
}

/// Load the auth session from disk, if it exists and hasn't expired.
pub fn load_session(data_dir: &PathBuf) -> Result<Option<AuthSession>, String> {
    let path = data_dir.join(AUTH_FILE);
    if !path.exists() {
        return Ok(None);
    }

    let json = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read auth file: {}", e))?;
    let session: AuthSession = serde_json::from_str(&json)
        .map_err(|e| format!("Failed to parse auth file: {}", e))?;

    // Check if expired
    if let Ok(expires) = chrono::DateTime::parse_from_rfc3339(&session.expires_at) {
        if expires < chrono::Utc::now() {
            // Token expired, remove file
            let _ = std::fs::remove_file(&path);
            return Ok(None);
        }
    }

    Ok(Some(session))
}

/// Delete the auth session file.
pub fn delete_session(data_dir: &PathBuf) -> Result<(), String> {
    let path = data_dir.join(AUTH_FILE);
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete auth file: {}", e))?;
    }
    Ok(())
}

fn urlencoded(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{:02X}", b),
        })
        .collect()
}
