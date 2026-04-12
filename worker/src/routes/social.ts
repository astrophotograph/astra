/**
 * Social API routes — follow, notifications, subscriptions.
 * Powered by the Kith D1 adapter.
 */

import { Hono } from "hono";
import type { Env } from "../lib/types";
import { requireApiToken } from "../middleware/clerk";
import { D1GraphStore, D1NotificationStore } from "../lib/kith";

const socialRoutes = new Hono<{ Bindings: Env }>();

// Helper to get API token from context
function getToken(c: any): { userId: string; username: string } {
  return c.get("apiToken" as never) as { userId: string; username: string };
}

// ============================================================================
// Follow / Unfollow
// ============================================================================

/**
 * POST /api/social/follow — Follow a user or object
 * Body: { targetKind: "user"|"object"|"collection", targetId: string }
 */
socialRoutes.post("/follow", requireApiToken, async (c) => {
  const { userId } = getToken(c);
  const { targetKind, targetId } = await c.req.json<{ targetKind: string; targetId: string }>();

  if (!targetKind || !targetId) {
    return c.json({ error: "targetKind and targetId required" }, 400);
  }
  if (targetKind === "user" && targetId === userId) {
    return c.json({ error: "Cannot follow yourself" }, 400);
  }

  const graph = new D1GraphStore(c.env.SOCIAL_DB);

  // Check for block
  if (targetKind === "user") {
    const blocked = await graph.isBlocked(userId, targetId);
    if (blocked) return c.json({ error: "Blocked" }, 403);
  }

  await graph.addEdge({
    actorId: userId,
    targetKind,
    targetId,
    edgeKind: "follow",
    weight: 1.0,
    metadata: null,
    createdAt: new Date().toISOString(),
  });

  // Auto-subscribe for notifications
  const notifs = new D1NotificationStore(c.env.SOCIAL_DB);
  await notifs.subscribe(userId, targetKind, targetId);

  return c.json({ following: true });
});

/**
 * DELETE /api/social/follow — Unfollow
 * Body: { targetKind, targetId }
 */
socialRoutes.delete("/follow", requireApiToken, async (c) => {
  const { userId } = getToken(c);
  const { targetKind, targetId } = await c.req.json<{ targetKind: string; targetId: string }>();

  const graph = new D1GraphStore(c.env.SOCIAL_DB);
  await graph.removeEdge(userId, targetKind, targetId, "follow");

  // Remove subscription
  const notifs = new D1NotificationStore(c.env.SOCIAL_DB);
  await notifs.unsubscribeByTopic(userId, targetKind, targetId);

  return c.json({ following: false });
});

/**
 * GET /api/social/is-following/:kind/:id — Check if current user follows
 */
socialRoutes.get("/is-following/:kind/:id", requireApiToken, async (c) => {
  const { userId } = getToken(c);
  const kind = c.req.param("kind");
  const id = c.req.param("id");

  const graph = new D1GraphStore(c.env.SOCIAL_DB);
  const following = await graph.edgeExists(userId, kind, id, "follow");

  return c.json({ following });
});

// ============================================================================
// Follower / Following queries (public)
// ============================================================================

/**
 * GET /api/social/followers/:kind/:id — List followers
 */
socialRoutes.get("/followers/:kind/:id", async (c) => {
  const kind = c.req.param("kind");
  const id = c.req.param("id");
  const cursor = c.req.query("cursor");
  const limit = parseInt(c.req.query("limit") || "20", 10);

  const graph = new D1GraphStore(c.env.SOCIAL_DB);
  const result = await graph.followers(kind, id, "follow", { cursor, limit });

  return c.json(result);
});

/**
 * GET /api/social/following — Current user's following list
 */
socialRoutes.get("/following", requireApiToken, async (c) => {
  const { userId } = getToken(c);
  const cursor = c.req.query("cursor");
  const limit = parseInt(c.req.query("limit") || "20", 10);

  const graph = new D1GraphStore(c.env.SOCIAL_DB);
  const result = await graph.following(userId, "follow", { cursor, limit });

  return c.json(result);
});

/**
 * GET /api/social/counts/:kind/:id — Follower/following counts
 */
socialRoutes.get("/counts/:kind/:id", async (c) => {
  const kind = c.req.param("kind");
  const id = c.req.param("id");

  const graph = new D1GraphStore(c.env.SOCIAL_DB);
  const followers = await graph.countFollowers(kind, id);

  // If it's a user, also count their following
  let following: number | undefined;
  if (kind === "user") {
    following = await graph.countFollowing(id);
  }

  return c.json({ followers, following });
});

/**
 * GET /api/social/mutual/:userId — Check mutual follow
 */
socialRoutes.get("/mutual/:userId", requireApiToken, async (c) => {
  const { userId } = getToken(c);
  const targetId = c.req.param("userId");

  const graph = new D1GraphStore(c.env.SOCIAL_DB);
  const mutual = await graph.mutual(userId, targetId);

  return c.json({ mutual });
});

// ============================================================================
// Notifications
// ============================================================================

/**
 * GET /api/social/notifications — Current user's notifications
 */
socialRoutes.get("/notifications", requireApiToken, async (c) => {
  const { userId } = getToken(c);
  const cursor = c.req.query("cursor");
  const limit = parseInt(c.req.query("limit") || "20", 10);

  const notifs = new D1NotificationStore(c.env.SOCIAL_DB);
  const result = await notifs.getNotifications(userId, { cursor, limit });

  return c.json(result);
});

/**
 * PATCH /api/social/notifications/:id — Mark notification as read
 */
socialRoutes.patch("/notifications/:id", requireApiToken, async (c) => {
  const notifId = c.req.param("id");
  const notifs = new D1NotificationStore(c.env.SOCIAL_DB);
  await notifs.markRead(notifId);
  return c.json({ read: true });
});

/**
 * POST /api/social/notifications/read-all — Mark all as read
 */
socialRoutes.post("/notifications/read-all", requireApiToken, async (c) => {
  const { userId } = getToken(c);
  const notifs = new D1NotificationStore(c.env.SOCIAL_DB);
  await notifs.markAllRead(userId);
  return c.json({ ok: true });
});

/**
 * GET /api/social/notifications/unread-count
 */
socialRoutes.get("/notifications/unread-count", requireApiToken, async (c) => {
  const { userId } = getToken(c);
  const notifs = new D1NotificationStore(c.env.SOCIAL_DB);
  const count = await notifs.unreadCount(userId);
  return c.json({ count });
});

// ============================================================================
// Subscriptions
// ============================================================================

/**
 * GET /api/social/subscriptions — Current user's subscriptions
 */
socialRoutes.get("/subscriptions", requireApiToken, async (c) => {
  const { userId } = getToken(c);
  const notifs = new D1NotificationStore(c.env.SOCIAL_DB);
  const subs = await notifs.getSubscriptions(userId);
  return c.json({ subscriptions: subs });
});

// ============================================================================
// Gallery Likes (follow edge on collection entity)
// ============================================================================

/**
 * POST /api/social/like/:shareId — Like a gallery
 */
socialRoutes.post("/like/:shareId", requireApiToken, async (c) => {
  const { userId } = getToken(c);
  const shareId = c.req.param("shareId");

  const graph = new D1GraphStore(c.env.SOCIAL_DB);
  await graph.addEdge({
    actorId: userId,
    targetKind: "collection",
    targetId: shareId,
    edgeKind: "follow",
    weight: 1.0,
    metadata: null,
    createdAt: new Date().toISOString(),
  });

  return c.json({ liked: true });
});

/**
 * DELETE /api/social/like/:shareId — Unlike a gallery
 */
socialRoutes.delete("/like/:shareId", requireApiToken, async (c) => {
  const { userId } = getToken(c);
  const shareId = c.req.param("shareId");

  const graph = new D1GraphStore(c.env.SOCIAL_DB);
  await graph.removeEdge(userId, "collection", shareId, "follow");

  return c.json({ liked: false });
});

/**
 * GET /api/social/likes/:shareId — Get like count (public)
 */
socialRoutes.get("/likes/:shareId", async (c) => {
  const shareId = c.req.param("shareId");
  const graph = new D1GraphStore(c.env.SOCIAL_DB);
  const count = await graph.countFollowers("collection", shareId);
  return c.json({ count });
});

/**
 * GET /api/social/liked/:shareId — Check if current user liked (authenticated)
 */
socialRoutes.get("/liked/:shareId", requireApiToken, async (c) => {
  const { userId } = getToken(c);
  const shareId = c.req.param("shareId");
  const graph = new D1GraphStore(c.env.SOCIAL_DB);
  const liked = await graph.edgeExists(userId, "collection", shareId, "follow");
  return c.json({ liked });
});

export { socialRoutes };
