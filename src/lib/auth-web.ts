/**
 * Browser login for the daemon-served web app: OIDC authorization-code +
 * PKCE against Zitadel, ending in the daemon's HttpOnly session cookie.
 *
 * The SPA never keeps tokens: the ID token exists only for the one POST to
 * /api/session, then everything is the cookie. Issuer and client id come
 * from the daemon (/api/session/config), so nothing is hardcoded and the
 * localhost dev server works against the same flow.
 *
 * The registered redirect URI is `{origin}/auth/callback` — outside the
 * router's /app basename on purpose; main.tsx handles that path before the
 * router mounts.
 */

const PKCE_KEY = "astra:pkce";

export interface SessionUser {
  userId: string;
  username: string | null;
  displayName: string | null;
  role: string;
  status: string;
}

interface PkceState {
  verifier: string;
  state: string;
  tokenEndpoint: string;
  clientId: string;
}

/** null → no valid session cookie (show the sign-in screen). */
export async function fetchMe(): Promise<SessionUser | null> {
  const resp = await fetch("/api/me", { credentials: "same-origin" });
  if (resp.status === 401) return null;
  if (!resp.ok) throw new Error(`session check failed (${resp.status})`);
  return resp.json() as Promise<SessionUser>;
}

interface OidcEndpoints {
  clientId: string;
  authorization: string;
  token: string;
  endSession: string | undefined;
}

async function oidcEndpoints(): Promise<OidcEndpoints> {
  const configResp = await fetch("/api/session/config");
  if (!configResp.ok) {
    throw new Error("Sign-in is unavailable: this server has no identity provider configured.");
  }
  const { issuer, clientId } = (await configResp.json()) as {
    issuer: string;
    clientId: string;
  };
  const discovery = (await (
    await fetch(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`)
  ).json()) as {
    authorization_endpoint: string;
    token_endpoint: string;
    end_session_endpoint?: string;
  };
  return {
    clientId,
    authorization: discovery.authorization_endpoint,
    token: discovery.token_endpoint,
    endSession: discovery.end_session_endpoint,
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function redirectUri(): string {
  return `${window.location.origin}/auth/callback`;
}

/** Stash the PKCE verifier and hand the browser to Zitadel. */
export async function beginLogin(): Promise<void> {
  const endpoints = await oidcEndpoints();
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));

  const stash: PkceState = {
    verifier,
    state,
    tokenEndpoint: endpoints.token,
    clientId: endpoints.clientId,
  };
  sessionStorage.setItem(PKCE_KEY, JSON.stringify(stash));

  const url = new URL(endpoints.authorization);
  url.searchParams.set("client_id", endpoints.clientId);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  window.location.assign(url.toString());
}

/**
 * Back from Zitadel on /auth/callback: exchange the code (SPA-side, PKCE),
 * trade the ID token for the session cookie, drop the tokens.
 */
export async function completeLogin(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const raw = sessionStorage.getItem(PKCE_KEY);
  sessionStorage.removeItem(PKCE_KEY);

  const error = params.get("error");
  if (error) {
    throw new Error(params.get("error_description") ?? `Sign-in failed (${error})`);
  }
  const code = params.get("code");
  if (!code || !raw) {
    throw new Error("Sign-in state was lost — please start over.");
  }
  const stash = JSON.parse(raw) as PkceState;
  if (params.get("state") !== stash.state) {
    throw new Error("Sign-in state mismatch — please start over.");
  }

  const tokenResp = await fetch(stash.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      client_id: stash.clientId,
      code_verifier: stash.verifier,
    }),
  });
  if (!tokenResp.ok) {
    throw new Error(`Token exchange failed (${tokenResp.status})`);
  }
  const tokens = (await tokenResp.json()) as { id_token?: string };
  if (!tokens.id_token) {
    throw new Error("Identity provider returned no ID token.");
  }

  const sessionResp = await fetch("/api/session", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: tokens.id_token }),
  });
  if (sessionResp.status === 403) {
    const body = (await sessionResp.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new Error(
      body?.message ?? body?.error ?? "This account isn't invited to this Astra server.",
    );
  }
  if (!sessionResp.ok) {
    throw new Error(`Session creation failed (${sessionResp.status})`);
  }
  // Cookie set; the ID token goes out of scope here and is never stored.
}

/**
 * Clear the daemon session, then end the Zitadel session too. The
 * post-logout URI is the origin root (registered in Zitadel), which the
 * daemon redirects straight back to /app — now showing the sign-in screen.
 */
export async function signOut(): Promise<void> {
  await fetch("/api/session", { method: "DELETE", credentials: "same-origin" });
  try {
    const endpoints = await oidcEndpoints();
    if (endpoints.endSession) {
      const url = new URL(endpoints.endSession);
      url.searchParams.set("client_id", endpoints.clientId);
      url.searchParams.set("post_logout_redirect_uri", `${window.location.origin}/`);
      window.location.assign(url.toString());
      return;
    }
  } catch {
    // fall through to the local redirect
  }
  window.location.assign("/app");
}
