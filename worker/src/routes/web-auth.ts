/**
 * Web authentication pages: callback and sign-out.
 * These are full HTML pages (not API endpoints).
 */

import { Hono } from "hono";
import type { Env } from "../lib/types";
import { faviconLink } from "../lib/auth-nav";

const webAuthRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /auth/callback
 * Clerk redirects here after sign-in. Loads Clerk JS SDK, extracts JWT,
 * exchanges for API token, stores in localStorage, redirects to return URL.
 */
webAuthRoutes.get("/auth/callback", async (c) => {
  const clerkPubKey = c.env.CLERK_PUBLISHABLE_KEY;
  const returnUrl = c.req.query("return") || "/explore";

  // Derive FAPI URL from publishable key (pk_test_<base64-encoded-fapi>)
  // The key is pk_test_ or pk_live_ followed by base64(fapi_url + "$")
  let fapiUrl: string;
  try {
    const encoded = clerkPubKey.replace(/^pk_(test|live)_/, "");
    // Clerk uses base64 with $ padding instead of = padding
    const b64 = encoded.replace(/\$/g, "=");
    const decoded = atob(b64);
    fapiUrl = decoded.replace(/\$$/, ""); // strip trailing $
    if (!fapiUrl.includes(".")) throw new Error("invalid");
  } catch {
    fapiUrl = "wired-walrus-5.clerk.accounts.dev";
  }

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Signing in... — Astra Gallery</title>
${faviconLink()}
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --void: #0a0e1a;
  --accent: #6366f1;
  --text: #c8cdd8;
  --text-dim: #6b7280;
  --text-bright: #e8ecf4;
  --serif: 'Cormorant Garamond', Georgia, serif;
  --sans: 'DM Sans', -apple-system, sans-serif;
}
html { background: var(--void); color: var(--text); font-family: var(--sans); }
body { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
.auth-card {
  text-align: center; max-width: 400px; padding: 3rem 2rem;
}
.auth-card h1 {
  font-family: var(--serif); font-size: 1.8rem; font-weight: 300;
  color: var(--text-bright); margin-bottom: 1rem;
}
.auth-card p { color: var(--text-dim); font-size: 0.9rem; margin-bottom: 1.5rem; }
.spinner {
  width: 32px; height: 32px; border: 2px solid rgba(99,102,241,0.2);
  border-top-color: var(--accent); border-radius: 50%;
  animation: spin 0.8s linear infinite; margin: 0 auto 1.5rem;
}
@keyframes spin { to { transform: rotate(360deg); } }
.error { color: #ef4444; display: none; }
.btn {
  display: inline-block; padding: 0.6rem 1.5rem; background: var(--accent);
  color: #fff; text-decoration: none; font-size: 0.8rem; font-weight: 500;
  letter-spacing: 0.08em; text-transform: uppercase; border-radius: 2px;
  border: none; cursor: pointer;
}
.btn:hover { background: #8b5cf6; }
</style>
</head>
<body>

<div class="auth-card">
  <div id="loading">
    <div class="spinner"></div>
    <h1>Signing in</h1>
    <p>Connecting to your account...</p>
  </div>
  <div id="error" class="error">
    <h1>Sign-in failed</h1>
    <p id="error-msg">Something went wrong. Please try again.</p>
    <br>
    <a href="/auth/callback?return=${encodeURIComponent(returnUrl)}" class="btn">Try Again</a>
  </div>
  <div id="no-session" style="display:none;">
    <h1>Sign in to Astra Gallery</h1>
    <p>Create an account or sign in to upload and share your astrophotography.</p>
    <br>
    <a id="sign-in-link" href="#" class="btn">Sign In</a>
  </div>
</div>

<script
  async
  crossorigin="anonymous"
  data-clerk-publishable-key="${clerkPubKey}"
  src="https://${fapiUrl}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"
  onload="initClerk()"
  onerror="showError('Failed to load authentication. Please try again.')"
></script>
<script>
var RETURN_URL = decodeURIComponent('${encodeURIComponent(returnUrl)}');

function showError(msg) {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('error').style.display = '';
  document.getElementById('error-msg').textContent = msg;
}

async function initClerk() {
  try {
    // Clerk browser bundle exports a constructor when loaded async
    var ClerkConstructor = window.Clerk;
    if (!ClerkConstructor) { showError('Auth library not available'); return; }

    // If Clerk is a constructor (not already initialized), create instance
    var Clerk;
    if (typeof ClerkConstructor === 'function' && !ClerkConstructor.session) {
      Clerk = new ClerkConstructor('${clerkPubKey}');
    } else {
      Clerk = ClerkConstructor;
    }

    await Clerk.load();

    if (!Clerk.session) {
      // No session — user needs to sign in first. Redirect to Account Portal.
      document.getElementById('loading').style.display = 'none';
      document.getElementById('no-session').style.display = '';
      // Use buildSignInUrl if available, fall back to Account Portal URL
      try {
        var signInUrl = Clerk.buildSignInUrl({
          redirectUrl: window.location.href,
        });
        document.getElementById('sign-in-link').href = signInUrl;
      } catch(e) {
        document.getElementById('sign-in-link').href =
          'https://${fapiUrl.replace("clerk.", "")}' +
          '/sign-in?redirect_url=' + encodeURIComponent(window.location.href);
      }
      return;
    }

    // Session exists — get JWT and exchange for API token
    var jwt = await Clerk.session.getToken();
    if (!jwt) { showError('Could not get session token'); return; }

    var resp = await fetch('/api/auth/token', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + jwt },
    });

    if (!resp.ok) {
      var body = await resp.json().catch(function() { return {}; });
      showError(body.error || 'Token exchange failed (HTTP ' + resp.status + ')');
      return;
    }

    var data = await resp.json();
    localStorage.setItem('astra_api_token', data.token);
    localStorage.setItem('astra_token_expires', data.expiresAt);
    localStorage.setItem('astra_username', data.username);
    localStorage.setItem('astra_user_id', data.userId);

    // Success — redirect
    window.location.href = RETURN_URL;

  } catch (err) {
    showError(err.message || 'An unexpected error occurred');
  }
}
</script>

</body>
</html>`);
});

/**
 * GET /auth/sign-out
 * Clear server state (optional) and redirect home.
 * Actual localStorage clearing happens client-side via the nav script.
 */
webAuthRoutes.get("/auth/sign-out", async (c) => {
  return c.html(`<!DOCTYPE html>
<html><head>
<script>
localStorage.removeItem('astra_api_token');
localStorage.removeItem('astra_token_expires');
localStorage.removeItem('astra_username');
localStorage.removeItem('astra_user_id');
window.location.href = '/';
</script>
</head><body>Signing out...</body></html>`);
});

export { webAuthRoutes };
