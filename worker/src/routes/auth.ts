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

/**
 * PATCH /api/auth/profile
 * Update profile fields. Requires API token.
 */
authRoutes.patch("/profile", requireApiToken, async (c) => {
  const apiToken = c.get("apiToken" as never) as {
    userId: string;
    username: string;
  };

  const body = await c.req.json<{
    displayName?: string;
    bio?: string;
    equipment?: string[];
    location?: string;
    links?: {
      website?: string;
      instagram?: string;
      astrobin?: string;
      cloudynights?: string;
    };
  }>();

  // Validate
  if (body.displayName !== undefined) {
    const dn = body.displayName.trim();
    if (dn.length === 0 || dn.length > 100) {
      return c.json({ error: "Display name must be 1-100 characters" }, 400);
    }
  }
  if (body.bio !== undefined && body.bio.length > 500) {
    return c.json({ error: "Bio must be 500 characters or fewer" }, 400);
  }
  if (body.equipment !== undefined) {
    if (body.equipment.length > 20) {
      return c.json({ error: "Maximum 20 equipment items" }, 400);
    }
    for (const item of body.equipment) {
      if (item.length > 100) {
        return c.json({ error: "Equipment items must be 100 characters or fewer" }, 400);
      }
    }
  }
  if (body.location !== undefined && body.location.length > 100) {
    return c.json({ error: "Location must be 100 characters or fewer" }, 400);
  }
  if (body.links?.website && !/^https?:\/\/.+/.test(body.links.website)) {
    return c.json({ error: "Website must be a valid URL starting with http:// or https://" }, 400);
  }

  const userJson = await c.env.GALLERY_KV.get(`users/${apiToken.userId}`);
  if (!userJson) {
    return c.json({ error: "User not found" }, 404);
  }

  const user: UserRecord = JSON.parse(userJson);

  // Apply updates
  if (body.displayName !== undefined) user.displayName = body.displayName.trim();
  if (body.bio !== undefined) user.bio = body.bio.trim() || undefined;
  if (body.equipment !== undefined) user.equipment = body.equipment.length > 0 ? body.equipment : undefined;
  if (body.location !== undefined) user.location = body.location.trim() || undefined;
  if (body.links !== undefined) {
    const cleaned: UserRecord["links"] = {};
    if (body.links.website) cleaned.website = body.links.website.trim();
    if (body.links.instagram) cleaned.instagram = body.links.instagram.trim();
    if (body.links.astrobin) cleaned.astrobin = body.links.astrobin.trim();
    if (body.links.cloudynights) cleaned.cloudynights = body.links.cloudynights.trim();
    user.links = Object.keys(cleaned).length > 0 ? cleaned : undefined;
  }

  await c.env.GALLERY_KV.put(`users/${apiToken.userId}`, JSON.stringify(user));

  return c.json({
    userId: apiToken.userId,
    ...user,
  });
});

/**
 * POST /api/auth/avatar
 * Upload avatar image. Requires API token.
 * Accepts raw image body with Content-Type header.
 */
authRoutes.post("/avatar", requireApiToken, async (c) => {
  const apiToken = c.get("apiToken" as never) as {
    userId: string;
    username: string;
  };

  const contentType = c.req.header("content-type") || "";
  if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
    return c.json({ error: "Avatar must be JPEG, PNG, or WebP" }, 400);
  }

  const body = await c.req.arrayBuffer();
  if (body.byteLength > 2 * 1024 * 1024) {
    return c.json({ error: "Avatar must be 2MB or smaller" }, 400);
  }

  const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
  const r2Key = `users/${apiToken.userId}/avatar.${ext}`;

  await c.env.GALLERY_BUCKET.put(r2Key, body, {
    httpMetadata: { contentType },
  });

  const avatarUrl = `https://astra.gallery/shares/../users/${apiToken.userId}/avatar.${ext}`;

  // Update user record
  const userJson = await c.env.GALLERY_KV.get(`users/${apiToken.userId}`);
  if (userJson) {
    const user: UserRecord = JSON.parse(userJson);
    user.avatarUrl = avatarUrl;
    await c.env.GALLERY_KV.put(`users/${apiToken.userId}`, JSON.stringify(user));
  }

  return c.json({ avatarUrl });
});

/**
 * DELETE /api/auth/avatar
 * Remove avatar. Requires API token.
 */
authRoutes.delete("/avatar", requireApiToken, async (c) => {
  const apiToken = c.get("apiToken" as never) as {
    userId: string;
    username: string;
  };

  // Try to delete all possible avatar extensions
  for (const ext of ["jpg", "png", "webp"]) {
    await c.env.GALLERY_BUCKET.delete(`users/${apiToken.userId}/avatar.${ext}`);
  }

  const userJson = await c.env.GALLERY_KV.get(`users/${apiToken.userId}`);
  if (userJson) {
    const user: UserRecord = JSON.parse(userJson);
    delete user.avatarUrl;
    await c.env.GALLERY_KV.put(`users/${apiToken.userId}`, JSON.stringify(user));
  }

  return c.json({ deleted: true });
});

export { authRoutes };
