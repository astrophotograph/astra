/**
 * Authentication middleware for Clerk JWT verification and API token validation.
 *
 * Two auth modes:
 * 1. Clerk JWT — short-lived (60s), used for initial auth + token exchange
 * 2. API token — HMAC-signed, 24h TTL, used for ongoing desktop app requests
 */

import { createMiddleware } from "hono/factory";
import { verifyToken } from "@clerk/backend";
import type { Env, ApiToken } from "../lib/types";

/**
 * Middleware that verifies a Clerk JWT from the Authorization header.
 * Sets `c.set("clerkUserId", ...)` on success.
 */
export const requireClerkJwt = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Missing Authorization header" }, 401);
    }

    const token = authHeader.slice(7);

    try {
      const payload = await verifyToken(token, {
        jwtKey: c.env.CLERK_JWT_KEY,
      });

      if (!payload || typeof payload === "object" && "errors" in payload) {
        throw new Error("Verification returned errors");
      }

      const sub = (payload as { sub: string }).sub;
      c.set("clerkUserId" as never, sub as never);
      await next();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Clerk JWT verification failed:", msg);
      return c.json({ error: "Invalid or expired Clerk JWT", detail: msg }, 401);
    }
  }
);

/**
 * Middleware that verifies a Worker-issued API token.
 * Sets `c.set("apiToken", ...)` on success.
 */
export const requireApiToken = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Missing Authorization header" }, 401);
    }

    const token = authHeader.slice(7);

    try {
      const apiToken = await verifyApiToken(token, c.env.API_TOKEN_SECRET);
      c.set("apiToken" as never, apiToken as never);
      await next();
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "Invalid token" },
        401
      );
    }
  }
);

/**
 * Issue a signed API token (HMAC-SHA256, 24h TTL).
 */
export async function issueApiToken(
  secret: string,
  userId: string,
  username: string,
  displayName?: string
): Promise<{ token: string; expiresAt: string }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 86400; // 24 hours

  const payload: ApiToken = {
    userId,
    username,
    displayName,
    iat: now,
    exp,
  };

  const payloadB64 = btoa(JSON.stringify(payload));
  const signature = await hmacSign(secret, payloadB64);
  const token = `${payloadB64}.${signature}`;

  return {
    token,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/**
 * Verify a Worker-issued API token.
 */
async function verifyApiToken(
  token: string,
  secret: string
): Promise<ApiToken> {
  const parts = token.split(".");
  if (parts.length !== 2) {
    throw new Error("Malformed API token");
  }

  const [payloadB64, signature] = parts;
  const expectedSig = await hmacSign(secret, payloadB64);

  if (!timingSafeEqual(signature, expectedSig)) {
    throw new Error("Invalid API token signature");
  }

  const payload: ApiToken = JSON.parse(atob(payloadB64));
  const now = Math.floor(Date.now() / 1000);

  if (payload.exp < now) {
    throw new Error("API token expired");
  }

  return payload;
}

async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );
  return arrayBufferToHex(sig);
}

function arrayBufferToHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
