import { Hono } from "hono";
import type { Env } from "../lib/types";

const galleryRoutes = new Hono<{ Bindings: Env }>();

// Serve existing Phase 1 shares: GET /shares/:shareId/*
galleryRoutes.get("/shares/:shareId/:path{.+}", async (c) => {
  const shareId = c.req.param("shareId");
  const path = c.req.param("path");
  const key = `shares/${shareId}/${path}`;

  const object = await c.env.GALLERY_BUCKET.get(key);
  if (!object) {
    return c.text("Not Found", 404);
  }

  const headers = new Headers();
  headers.set("Content-Type", contentTypeForPath(path));
  headers.set("Cache-Control", cacheControlForPath(path));
  object.writeHttpMetadata(headers);

  return new Response(object.body, { headers });
});

// Serve share index: GET /shares/:shareId or /shares/:shareId/
galleryRoutes.get("/shares/:shareId", async (c) => {
  const shareId = c.req.param("shareId");
  const key = `shares/${shareId}/index.html`;

  const object = await c.env.GALLERY_BUCKET.get(key);
  if (!object) {
    return c.text("Gallery not found", 404);
  }

  const headers = new Headers();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "public, max-age=10");
  object.writeHttpMetadata(headers);

  return new Response(object.body, { headers });
});

// User profile + gallery + assets — all handled by one function
// Helper to handle both gallery page and asset requests
async function handleUserGallery(c: any) {
  // Parse: /@username → profile, /@username/slug → gallery, /@username/slug/path → asset
  const parts = new URL(c.req.url).pathname.split("/").filter(Boolean);
  // parts[0] = "@username", parts[1] = slug, parts[2+] = asset
  const username = parts[0]?.slice(1); // remove @
  const slug = parts[1] ?? null;
  const fullPath = new URL(c.req.url).pathname;
  const assetPath = parts.length > 2 ? parts.slice(2).join("/") : null;

  // Ensure trailing slash for gallery pages so relative URLs (manifest.json) resolve correctly
  if (slug && !assetPath && !fullPath.endsWith("/")) {
    return c.redirect(fullPath + "/", 301);
  }

  if (!username) {
    return c.text("Not found", 404);
  }

  // If no slug, show profile page
  if (!slug || slug === "") {
    const userId = await c.env.GALLERY_KV.get(`usernames/${username}`);
    if (!userId) return c.text("User not found", 404);
    const userJson = await c.env.GALLERY_KV.get(`users/${userId}`);
    if (!userJson) return c.text("User not found", 404);
    const user = JSON.parse(userJson) as { displayName: string; username: string };
    const sharesList = await c.env.GALLERY_KV.list({ prefix: `user-shares/${userId}/` });
    const shares: { slug: string; name: string; createdAt: string }[] = [];
    for (const key of sharesList.keys) {
      const shareJson = await c.env.GALLERY_KV.get(key.name);
      if (shareJson) {
        const share = JSON.parse(shareJson) as { collectionSlug: string; collectionName: string; createdAt: string };
        shares.push({ slug: share.collectionSlug, name: share.collectionName, createdAt: share.createdAt });
      }
    }
    return c.html(renderProfilePage(username, user.displayName || username, shares));
  }

  if (!slug) {
    return c.text("Not found", 404);
  }

  // Resolve username → userId
  const userId = await c.env.GALLERY_KV.get(`usernames/${username}`);
  if (!userId) {
    return c.text("Not found", 404);
  }

  // Look up the share
  const shareJson = await c.env.GALLERY_KV.get(`user-shares/${userId}/${slug}`);
  if (!shareJson) {
    return c.text("Not found", 404);
  }

  const share = JSON.parse(shareJson) as { shareId: string };

  // Determine R2 key: asset or index.html
  const r2File = assetPath ?? "index.html";
  const key = `users/${userId}/${share.shareId}/${r2File}`;
  const object = await c.env.GALLERY_BUCKET.get(key);
  if (!object) {
    return c.text("Not found", 404);
  }

  const headers = new Headers();
  if (assetPath) {
    headers.set("Content-Type", contentTypeForPath(assetPath));
    headers.set("Cache-Control", cacheControlForPath(assetPath));
  } else {
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Cache-Control", "public, max-age=10");
  }
  object.writeHttpMetadata(headers);

  return new Response(object.body, { headers });
}

// Catch all /@username paths and parse manually
galleryRoutes.all("/@:username", handleUserGallery);
galleryRoutes.all("/@:username/*", handleUserGallery);

function contentTypeForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    html: "text/html; charset=utf-8",
    json: "application/json; charset=utf-8",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    css: "text/css",
    js: "application/javascript",
  };
  return types[ext] ?? "application/octet-stream";
}

function cacheControlForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  // Images are immutable, HTML/JSON are short-lived
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=10";
}

function renderProfilePage(
  username: string,
  displayName: string,
  shares: { slug: string; name: string; createdAt: string }[]
): string {
  const shareCards = shares
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(
      (s) => `
      <a href="/@${username}/${s.slug}" class="gallery-card">
        <h3>${escapeHtml(s.name)}</h3>
        <span class="date">${new Date(s.createdAt).toLocaleDateString()}</span>
      </a>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(displayName || username)} — Astra Gallery</title>
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: #0a0e1a;
    color: #c8cdd8;
    min-height: 100vh;
    padding: 3rem 2rem;
    max-width: 800px;
    margin: 0 auto;
  }
  h1 { color: #e8ecf4; font-size: 2rem; margin-bottom: 0.25rem; }
  .username { color: #6b7280; font-size: 0.9rem; margin-bottom: 2rem; }
  .gallery-card {
    display: block;
    padding: 1.5rem;
    border: 1px solid rgba(99, 102, 241, 0.15);
    border-radius: 6px;
    margin-bottom: 0.75rem;
    text-decoration: none;
    color: inherit;
    transition: border-color 0.2s, background 0.2s;
  }
  .gallery-card:hover {
    border-color: rgba(99, 102, 241, 0.4);
    background: rgba(99, 102, 241, 0.05);
  }
  .gallery-card h3 { color: #e8ecf4; font-size: 1.1rem; margin-bottom: 0.25rem; }
  .gallery-card .date { color: #6b7280; font-size: 0.85rem; }
  .empty { color: #6b7280; font-style: italic; }
  .back { color: #6366f1; text-decoration: none; font-size: 0.85rem; }
  .back:hover { text-decoration: underline; }
</style>
</head>
<body>
  <a href="/" class="back">&larr; astra.gallery</a>
  <h1>${escapeHtml(displayName || username)}</h1>
  <p class="username">@${escapeHtml(username)}</p>
  ${shares.length > 0 ? shareCards : '<p class="empty">No published galleries yet.</p>'}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export { galleryRoutes };
