/**
 * Curated lists API routes.
 */

import { Hono } from "hono";
import type { Env } from "../lib/types";
import { requireApiToken } from "../middleware/clerk";
import { D1CurationStore, D1GraphStore } from "../lib/kith";

const listRoutes = new Hono<{ Bindings: Env }>();

function getToken(c: any): { userId: string; username: string } {
  return c.get("apiToken" as never) as { userId: string; username: string };
}

/**
 * POST /api/lists — Create a new list
 */
listRoutes.post("/", requireApiToken, async (c) => {
  const { userId } = getToken(c);
  const { name, description } = await c.req.json<{ name: string; description?: string }>();

  if (!name?.trim()) return c.json({ error: "Name required" }, 400);

  const curation = new D1CurationStore(c.env.SOCIAL_DB);
  const list = await curation.createList(userId, name.trim(), description);
  return c.json(list);
});

/**
 * GET /api/lists — Current user's lists
 */
listRoutes.get("/", requireApiToken, async (c) => {
  const { userId } = getToken(c);
  const curation = new D1CurationStore(c.env.SOCIAL_DB);
  const lists = await curation.listsForUser(userId);
  return c.json({ lists });
});

/**
 * GET /api/lists/:id — Get list details
 */
listRoutes.get("/:id", async (c) => {
  const listId = c.req.param("id");
  const curation = new D1CurationStore(c.env.SOCIAL_DB);
  const list = await curation.getList(listId);

  if (!list) return c.json({ error: "List not found" }, 404);
  if (!list.public) {
    // Check ownership for private lists
    try {
      const { userId } = getToken(c);
      if (list.ownerId !== userId) return c.json({ error: "Not found" }, 404);
    } catch {
      return c.json({ error: "Not found" }, 404);
    }
  }

  return c.json(list);
});

/**
 * PATCH /api/lists/:id — Update list
 */
listRoutes.patch("/:id", requireApiToken, async (c) => {
  const { userId } = getToken(c);
  const listId = c.req.param("id");
  const body = await c.req.json<{ name?: string; description?: string; public?: boolean }>();

  const curation = new D1CurationStore(c.env.SOCIAL_DB);
  const list = await curation.getList(listId);
  if (!list || list.ownerId !== userId) return c.json({ error: "Not found" }, 404);

  await curation.updateList(listId, body);
  return c.json({ updated: true });
});

/**
 * DELETE /api/lists/:id — Delete list
 */
listRoutes.delete("/:id", requireApiToken, async (c) => {
  const { userId } = getToken(c);
  const listId = c.req.param("id");

  const curation = new D1CurationStore(c.env.SOCIAL_DB);
  const list = await curation.getList(listId);
  if (!list || list.ownerId !== userId) return c.json({ error: "Not found" }, 404);

  await curation.deleteList(listId);
  return c.json({ deleted: true });
});

/**
 * GET /api/lists/:id/items — Get list items
 */
listRoutes.get("/:id/items", async (c) => {
  const listId = c.req.param("id");
  const cursor = c.req.query("cursor");
  const limit = parseInt(c.req.query("limit") || "50", 10);

  const curation = new D1CurationStore(c.env.SOCIAL_DB);
  const result = await curation.getItems(listId, { cursor, limit });
  return c.json(result);
});

/**
 * POST /api/lists/:id/items — Add item to list
 */
listRoutes.post("/:id/items", requireApiToken, async (c) => {
  const { userId } = getToken(c);
  const listId = c.req.param("id");
  const { entityKind, entityId, title, note } = await c.req.json<{
    entityKind: string;
    entityId: string;
    title?: string;
    note?: string;
  }>();

  const curation = new D1CurationStore(c.env.SOCIAL_DB);
  const list = await curation.getList(listId);
  if (!list || list.ownerId !== userId) return c.json({ error: "Not found" }, 404);

  const item = await curation.addItem(listId, entityKind, entityId, title, note);
  return c.json(item);
});

/**
 * DELETE /api/lists/:id/items/:itemId — Remove item from list
 */
listRoutes.delete("/:id/items/:itemId", requireApiToken, async (c) => {
  const { userId } = getToken(c);
  const listId = c.req.param("id");
  const itemId = c.req.param("itemId");

  const curation = new D1CurationStore(c.env.SOCIAL_DB);
  const list = await curation.getList(listId);
  if (!list || list.ownerId !== userId) return c.json({ error: "Not found" }, 404);

  await curation.removeItem(itemId);
  return c.json({ deleted: true });
});

/**
 * POST /api/lists/:id/follow — Follow a public list
 */
listRoutes.post("/:id/follow", requireApiToken, async (c) => {
  const { userId } = getToken(c);
  const listId = c.req.param("id");

  const graph = new D1GraphStore(c.env.SOCIAL_DB);
  await graph.addEdge({
    actorId: userId,
    targetKind: "collection",
    targetId: listId,
    edgeKind: "follow",
    weight: 1.0,
    metadata: null,
    createdAt: new Date().toISOString(),
  });

  return c.json({ following: true });
});

/**
 * DELETE /api/lists/:id/follow — Unfollow a list
 */
listRoutes.delete("/:id/follow", requireApiToken, async (c) => {
  const { userId } = getToken(c);
  const listId = c.req.param("id");

  const graph = new D1GraphStore(c.env.SOCIAL_DB);
  await graph.removeEdge(userId, "collection", listId, "follow");

  return c.json({ following: false });
});

export { listRoutes };
