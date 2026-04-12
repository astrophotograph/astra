/**
 * Curated lists API routes.
 */

import { Hono } from "hono";
import type { Env } from "../lib/types";
import { requireApiToken } from "../middleware/clerk";
import { D1CurationStore, D1GraphStore } from "../lib/kith";
import { authNavItem, authNavScript, faviconLink } from "../lib/auth-nav";

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

// ============================================================================
// Public list view page (HTML, not API)
// ============================================================================

/**
 * GET /lists/:id — Public list view page (mounted at / in index.ts)
 */
const listPageRoutes = new Hono<{ Bindings: Env }>();

listPageRoutes.get("/lists/:id", async (c) => {
  const listId = c.req.param("id");
  const curation = new D1CurationStore(c.env.SOCIAL_DB);
  const list = await curation.getList(listId);

  if (!list || !list.public) return c.text("List not found", 404);

  const itemsResult = await curation.getItems(listId, { limit: 100 });

  // Resolve owner username from KV
  const userJson = await c.env.GALLERY_KV.get(`users/${list.ownerId}`);
  const ownerUsername = userJson ? JSON.parse(userJson).username : "unknown";

  const graph = new D1GraphStore(c.env.SOCIAL_DB);
  const followerCount = await graph.countFollowers("collection", listId);

  function esc(s: string) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

  const itemsHtml = itemsResult.items.length > 0
    ? itemsResult.items.map(item => `
        <div class="list-item">
          <div class="list-item-title">${esc(item.title || item.entityId)}</div>
          ${item.note ? `<div class="list-item-note">${esc(item.note)}</div>` : ""}
          <div class="list-item-meta">${esc(item.entityKind)}</div>
        </div>`).join("")
    : `<p style="color: var(--text-dim); text-align: center; padding: 2rem;">This list is empty.</p>`;

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(list.name)} — Astra Gallery</title>
${faviconLink()}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,300;1,9..40,400&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --void: #0a0e1a; --deep: #0f1424; --accent: #6366f1; --light: #8b5cf6;
  --glow: #c4b5fd; --teal: #80CBC4; --text: #c8cdd8; --text-dim: #6b7280;
  --text-bright: #e8ecf4; --serif: 'Cormorant Garamond', Georgia, serif;
  --sans: 'DM Sans', -apple-system, sans-serif;
}
html { background: var(--void); color: var(--text); font-family: var(--sans); font-size: 16px; line-height: 1.6; }
body { min-height: 100vh; display: flex; flex-direction: column; }
nav { padding: 1.25rem 2rem; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(99,102,241,0.08); }
nav .wordmark { font-family: var(--serif); font-size: 1.5rem; font-weight: 300; letter-spacing: 0.15em; color: var(--text-bright); text-decoration: none; }
nav .nav-links { display: flex; gap: 2rem; list-style: none; align-items: center; }
nav .nav-links a { color: var(--text-dim); text-decoration: none; font-size: 0.8rem; font-weight: 400; letter-spacing: 0.08em; text-transform: uppercase; transition: color 0.3s; }
nav .nav-links a:hover { color: var(--glow); }
.container { max-width: 720px; margin: 0 auto; padding: 0 2rem; width: 100%; }
.list-header { padding: 3rem 0 2rem; border-bottom: 1px solid rgba(99,102,241,0.08); text-align: center; }
.list-header h1 { font-family: var(--serif); font-size: 2rem; font-weight: 300; color: var(--text-bright); margin-bottom: 0.4rem; }
.list-header .subtitle { font-size: 0.9rem; color: var(--text-dim); }
.list-header .list-meta { margin-top: 0.75rem; font-size: 0.8rem; color: var(--text-dim); }
.list-header .list-meta a { color: var(--accent); text-decoration: none; }
.list-items { padding: 2rem 0 4rem; flex: 1; }
.list-item { padding: 1rem 0; border-bottom: 1px solid rgba(99,102,241,0.06); }
.list-item-title { font-family: var(--serif); font-size: 1.15rem; color: var(--text-bright); }
.list-item-note { font-size: 0.85rem; color: var(--text-dim); margin-top: 0.25rem; }
.list-item-meta { font-size: 0.75rem; color: var(--text-dim); margin-top: 0.2rem; letter-spacing: 0.04em; }
footer { padding: 2.5rem 0; border-top: 1px solid rgba(99,102,241,0.08); margin-top: auto; }
.footer-inner { display: flex; align-items: center; justify-content: space-between; max-width: 720px; margin: 0 auto; padding: 0 2rem; font-size: 0.8rem; color: var(--text-dim); }
.footer-wordmark { font-family: var(--serif); font-weight: 300; letter-spacing: 0.1em; color: var(--text); }
footer a { color: var(--text-dim); text-decoration: none; }
</style>
</head>
<body>

<nav>
  <a href="/" class="wordmark">astra.gallery</a>
  <ul class="nav-links">
    <li><a href="/explore">Explore</a></li>
    ${authNavItem()}
  </ul>
</nav>

<section class="list-header">
  <div class="container">
    <h1>${esc(list.name)}</h1>
    ${list.description ? `<p class="subtitle">${esc(list.description)}</p>` : ""}
    <p class="list-meta">
      Curated by <a href="/@${esc(ownerUsername)}">@${esc(ownerUsername)}</a>
      · ${followerCount} follower${followerCount === 1 ? "" : "s"}
      · ${itemsResult.total ?? itemsResult.items.length} item${(itemsResult.total ?? itemsResult.items.length) === 1 ? "" : "s"}
    </p>
  </div>
</section>

<section class="list-items">
  <div class="container">
    ${itemsHtml}
  </div>
</section>

<footer>
  <div class="footer-inner">
    <span class="footer-wordmark">astra.gallery</span>
    <span style="font-size: 0.75rem;">Powered by <a href="/">Astra</a></span>
  </div>
</footer>

${authNavScript()}

</body>
</html>`);
});

export { listRoutes, listPageRoutes };
