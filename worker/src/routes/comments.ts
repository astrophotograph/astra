/**
 * Gallery comments API routes.
 */

import { Hono } from "hono";
import type { Env } from "../lib/types";
import { requireApiToken } from "../middleware/clerk";

const commentRoutes = new Hono<{ Bindings: Env }>();

function getToken(c: any): { userId: string; username: string } {
  return c.get("apiToken" as never) as { userId: string; username: string };
}

interface CommentRow {
  id: string;
  gallery_id: string;
  author_id: string;
  author_username: string;
  body: string;
  created_at: string;
  edited_at: string | null;
  deleted: number;
}

/**
 * GET /api/comments/:galleryId — List comments for a gallery
 */
commentRoutes.get("/:galleryId", async (c) => {
  const galleryId = c.req.param("galleryId");
  const cursor = c.req.query("cursor");
  const limit = parseInt(c.req.query("limit") || "50", 10);
  const offset = cursor ? parseInt(cursor, 10) : 0;

  const countRow = await c.env.SOCIAL_DB
    .prepare(`SELECT COUNT(*) as cnt FROM comments WHERE gallery_id = ? AND deleted = 0`)
    .bind(galleryId)
    .first<{ cnt: number }>();

  const rows = await c.env.SOCIAL_DB
    .prepare(
      `SELECT * FROM comments WHERE gallery_id = ? AND deleted = 0
       ORDER BY created_at ASC LIMIT ? OFFSET ?`
    )
    .bind(galleryId, limit, offset)
    .all<CommentRow>();

  const total = countRow?.cnt ?? 0;
  const comments = (rows.results || []).map(r => ({
    id: r.id,
    galleryId: r.gallery_id,
    authorId: r.author_id,
    authorUsername: r.author_username,
    body: r.body,
    createdAt: r.created_at,
    editedAt: r.edited_at,
  }));

  return c.json({
    items: comments,
    nextCursor: offset + limit < total ? String(offset + limit) : null,
    total,
  });
});

/**
 * POST /api/comments/:galleryId — Add a comment
 */
commentRoutes.post("/:galleryId", requireApiToken, async (c) => {
  const { userId, username } = getToken(c);
  const galleryId = c.req.param("galleryId");
  const { body } = await c.req.json<{ body: string }>();

  if (!body?.trim()) return c.json({ error: "Comment body required" }, 400);
  const cleaned = body.trim().slice(0, 2000);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await c.env.SOCIAL_DB
    .prepare(
      `INSERT INTO comments (id, gallery_id, author_id, author_username, body, created_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, 0)`
    )
    .bind(id, galleryId, userId, username, cleaned, now)
    .run();

  return c.json({
    id,
    galleryId,
    authorId: userId,
    authorUsername: username,
    body: cleaned,
    createdAt: now,
    editedAt: null,
  });
});

/**
 * PATCH /api/comments/:id — Edit own comment
 */
commentRoutes.patch("/:id", requireApiToken, async (c) => {
  const { userId } = getToken(c);
  const commentId = c.req.param("id");
  const { body } = await c.req.json<{ body: string }>();

  if (!body?.trim()) return c.json({ error: "Comment body required" }, 400);

  const existing = await c.env.SOCIAL_DB
    .prepare(`SELECT author_id FROM comments WHERE id = ? AND deleted = 0`)
    .bind(commentId)
    .first<{ author_id: string }>();

  if (!existing) return c.json({ error: "Comment not found" }, 404);
  if (existing.author_id !== userId) return c.json({ error: "Can only edit own comments" }, 403);

  const now = new Date().toISOString();
  await c.env.SOCIAL_DB
    .prepare(`UPDATE comments SET body = ?, edited_at = ? WHERE id = ?`)
    .bind(body.trim().slice(0, 2000), now, commentId)
    .run();

  return c.json({ updated: true });
});

/**
 * DELETE /api/comments/:id — Delete comment (soft delete)
 * Authors can delete own comments. Gallery owners can delete any comment.
 */
commentRoutes.delete("/:id", requireApiToken, async (c) => {
  const { userId } = getToken(c);
  const commentId = c.req.param("id");

  const existing = await c.env.SOCIAL_DB
    .prepare(`SELECT author_id, gallery_id FROM comments WHERE id = ? AND deleted = 0`)
    .bind(commentId)
    .first<{ author_id: string; gallery_id: string }>();

  if (!existing) return c.json({ error: "Comment not found" }, 404);

  // Allow author or gallery owner to delete
  let authorized = existing.author_id === userId;
  if (!authorized) {
    // Check if user owns the gallery
    const shareJson = await c.env.GALLERY_KV.get(`shares/${existing.gallery_id}`);
    if (shareJson) {
      const share = JSON.parse(shareJson);
      authorized = share.userId === userId;
    }
  }

  if (!authorized) return c.json({ error: "Forbidden" }, 403);

  await c.env.SOCIAL_DB
    .prepare(`UPDATE comments SET deleted = 1 WHERE id = ?`)
    .bind(commentId)
    .run();

  return c.json({ deleted: true });
});

export { commentRoutes };
