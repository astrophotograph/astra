/**
 * Authentication routes for Clerk JWT → API token exchange and user registration.
 */

import { Hono } from "hono";
import { createClerkClient } from "@clerk/backend";
import type { Env, UserRecord } from "../lib/types";
import { requireClerkJwt, requireApiToken, issueApiToken } from "../middleware/clerk";

const authRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/auth/token
 * Exchange a Clerk JWT for a longer-lived API token (24h).
 * Requires: Clerk JWT in Authorization header.
 */
authRoutes.post("/token", requireClerkJwt, async (c) => {
  const clerkUserId = c.get("clerkUserId" as never) as string;

  // Look up user record — auto-register if not found
  let userJson = await c.env.GALLERY_KV.get(`users/${clerkUserId}`);

  if (!userJson) {
    // Fetch username from Clerk user profile
    const clerk = createClerkClient({
      secretKey: c.env.CLERK_SECRET_KEY,
    });
    const clerkUser = await clerk.users.getUser(clerkUserId);
    const username = (clerkUser.username ?? `astro-${Date.now() % 100000}`).toLowerCase().trim();

    // Check username uniqueness
    const existing = await c.env.GALLERY_KV.get(`usernames/${username}`);
    if (existing && existing !== clerkUserId) {
      return c.json({ error: `Username "${username}" is already taken` }, 409);
    }

    const displayName = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") || username;
    const user: UserRecord = {
      username,
      displayName,
      createdAt: new Date().toISOString(),
    };

    await c.env.GALLERY_KV.put(`usernames/${username}`, clerkUserId);
    await c.env.GALLERY_KV.put(`users/${clerkUserId}`, JSON.stringify(user));
    userJson = JSON.stringify(user);
  }

  const user: UserRecord = JSON.parse(userJson);
  const { token, expiresAt } = await issueApiToken(
    c.env.API_TOKEN_SECRET,
    clerkUserId,
    user.username,
    user.displayName
  );

  return c.json({
    token,
    expiresAt,
    userId: clerkUserId,
    username: user.username,
    displayName: user.displayName,
  });
});

/**
 * POST /api/auth/register
 * Claim a username. Requires Clerk JWT.
 * Body: { username: string, displayName?: string }
 */
authRoutes.post("/register", requireClerkJwt, async (c) => {
  const clerkUserId = c.get("clerkUserId" as never) as string;
  const body = await c.req.json<{
    username: string;
    displayName?: string;
  }>();

  const username = body.username?.trim().toLowerCase();
  if (!username || !/^[a-z0-9][a-z0-9_-]{1,28}[a-z0-9]$/.test(username)) {
    return c.json(
      {
        error:
          "Username must be 3-30 characters, alphanumeric with hyphens/underscores, start and end with alphanumeric.",
      },
      400
    );
  }

  // Check if user already registered
  const existingUser = await c.env.GALLERY_KV.get(`users/${clerkUserId}`);
  if (existingUser) {
    return c.json({ error: "Already registered" }, 409);
  }

  // Check username uniqueness
  const existingUsername = await c.env.GALLERY_KV.get(
    `usernames/${username}`
  );
  if (existingUsername) {
    return c.json({ error: "Username already taken" }, 409);
  }

  const user: UserRecord = {
    username,
    displayName: body.displayName || username,
    createdAt: new Date().toISOString(),
  };

  // Write both records atomically (KV doesn't have transactions, but
  // the username→userId mapping acts as a lock)
  await c.env.GALLERY_KV.put(`usernames/${username}`, clerkUserId);
  await c.env.GALLERY_KV.put(`users/${clerkUserId}`, JSON.stringify(user));

  // Issue an API token immediately
  const { token, expiresAt } = await issueApiToken(
    c.env.API_TOKEN_SECRET,
    clerkUserId,
    username,
    user.displayName
  );

  return c.json({
    token,
    expiresAt,
    userId: clerkUserId,
    username,
    displayName: user.displayName,
  });
});

/**
 * GET /api/auth/me
 * Get current user profile. Requires API token.
 */
authRoutes.get("/me", requireApiToken, async (c) => {
  const apiToken = c.get("apiToken" as never) as {
    userId: string;
    username: string;
    displayName?: string;
  };

  const userJson = await c.env.GALLERY_KV.get(`users/${apiToken.userId}`);
  if (!userJson) {
    return c.json({ error: "User not found" }, 404);
  }

  const user: UserRecord = JSON.parse(userJson);
  return c.json({
    userId: apiToken.userId,
    username: user.username,
    displayName: user.displayName,
    createdAt: user.createdAt,
  });
});

export { authRoutes };
