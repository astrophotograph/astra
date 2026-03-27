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
  const sorted = shares.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const galleryCount = sorted.length;
  const galleryWord = galleryCount === 1 ? "gallery" : "galleries";

  // Use earliest share createdAt as "member since" proxy
  const earliestDate =
    sorted.length > 0
      ? new Date(sorted[sorted.length - 1].createdAt)
      : null;
  const memberSince = earliestDate
    ? earliestDate.toLocaleDateString("en-US", { month: "long", year: "numeric" })
    : null;

  const shareCards = sorted
    .map((s) => {
      const pubDate = new Date(s.createdAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      return `
      <a href="/@${escapeHtml(username)}/${escapeHtml(s.slug)}" class="gallery-card">
        <div class="card-placeholder">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/>
            <path d="M2 12h20"/>
            <circle cx="12" cy="5" r="0.5" fill="currentColor" stroke="none"/>
            <circle cx="18" cy="9" r="0.5" fill="currentColor" stroke="none"/>
            <circle cx="7" cy="16" r="0.5" fill="currentColor" stroke="none"/>
            <circle cx="15" cy="14" r="0.5" fill="currentColor" stroke="none"/>
          </svg>
        </div>
        <div class="card-content">
          <h3>${escapeHtml(s.name)}</h3>
          <span class="card-date">${pubDate}</span>
        </div>
      </a>`;
    })
    .join("");

  const emptyState = `
    <div class="empty-state">
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="0.75" stroke-linecap="round" stroke-linejoin="round" class="empty-icon">
        <circle cx="12" cy="12" r="10"/>
        <circle cx="12" cy="12" r="3"/>
        <line x1="12" y1="2" x2="12" y2="5"/>
        <line x1="12" y1="19" x2="12" y2="22"/>
        <line x1="2" y1="12" x2="5" y2="12"/>
        <line x1="19" y1="12" x2="22" y2="12"/>
      </svg>
      <p class="empty-title">No galleries yet</p>
      <p class="empty-sub">When ${escapeHtml(displayName || username)} publishes a gallery from Astra, it will appear here.</p>
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(displayName || username)} — Astra Gallery</title>
<meta name="description" content="${escapeHtml(displayName || username)}'s astrophotography galleries on Astra Gallery.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,300;1,9..40,400&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

:root {
  --void: #0a0e1a;
  --deep: #0f1424;
  --surface: #151b2e;
  --accent: #6366f1;
  --light: #8b5cf6;
  --glow: #c4b5fd;
  --teal: #80CBC4;
  --text: #c8cdd8;
  --text-dim: #6b7280;
  --text-bright: #e8ecf4;
  --serif: 'Cormorant Garamond', Georgia, serif;
  --sans: 'DM Sans', -apple-system, sans-serif;
}

html {
  background: var(--void);
  color: var(--text);
  font-family: var(--sans);
  font-size: 16px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

body {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  overflow-x: hidden;
}

/* Nav */
nav {
  padding: 1.25rem 2rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid rgba(99, 102, 241, 0.08);
}

nav .wordmark {
  font-family: var(--serif);
  font-size: 1.5rem;
  font-weight: 300;
  letter-spacing: 0.15em;
  color: var(--text-bright);
  text-decoration: none;
  transition: color 0.3s;
}

nav .wordmark:hover {
  color: var(--glow);
}

/* Container */
.container {
  max-width: 960px;
  margin: 0 auto;
  padding: 0 2rem;
  width: 100%;
}

/* Profile hero */
.profile-hero {
  padding: 4rem 0 3rem;
  text-align: center;
  border-bottom: 1px solid rgba(99, 102, 241, 0.08);
}

.profile-display-name {
  font-family: var(--serif);
  font-size: clamp(2.2rem, 5vw, 3.2rem);
  font-weight: 300;
  letter-spacing: 0.03em;
  color: var(--text-bright);
  line-height: 1.15;
  margin-bottom: 0.4rem;
}

.profile-username {
  font-size: 1rem;
  color: var(--text-dim);
  margin-bottom: 1.5rem;
  letter-spacing: 0.02em;
}

.profile-meta {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1.5rem;
  flex-wrap: wrap;
}

.profile-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--teal);
  background: rgba(128, 203, 196, 0.08);
  border: 1px solid rgba(128, 203, 196, 0.15);
  padding: 0.35rem 0.9rem;
  border-radius: 2px;
}

.profile-member-since {
  font-size: 0.8rem;
  color: var(--text-dim);
  letter-spacing: 0.04em;
}

/* Gallery section */
.galleries-section {
  padding: 3rem 0 4rem;
  flex: 1;
}

.section-label {
  font-size: 0.65rem;
  font-weight: 500;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 1.5rem;
}

/* Gallery grid */
.gallery-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  background: rgba(99, 102, 241, 0.1);
  border: 1px solid rgba(99, 102, 241, 0.1);
}

.gallery-card {
  display: flex;
  flex-direction: column;
  background: var(--void);
  text-decoration: none;
  color: inherit;
  transition: background 0.3s, box-shadow 0.3s;
  position: relative;
}

.gallery-card:hover {
  background: var(--deep);
  box-shadow: inset 0 0 30px rgba(99, 102, 241, 0.06);
}

.gallery-card:hover .card-placeholder {
  border-bottom-color: rgba(99, 102, 241, 0.2);
}

.gallery-card:hover .card-placeholder svg {
  color: var(--accent);
  opacity: 0.6;
}

.card-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 120px;
  border-bottom: 1px solid rgba(99, 102, 241, 0.06);
  background:
    radial-gradient(ellipse at 30% 40%, rgba(99, 102, 241, 0.04) 0%, transparent 60%),
    radial-gradient(ellipse at 70% 70%, rgba(128, 203, 196, 0.03) 0%, transparent 50%);
  transition: border-color 0.3s;
}

.card-placeholder svg {
  color: var(--text-dim);
  opacity: 0.3;
  transition: color 0.3s, opacity 0.3s;
}

.card-content {
  padding: 1.25rem 1.5rem 1.5rem;
}

.gallery-card h3 {
  font-family: var(--serif);
  font-size: 1.2rem;
  font-weight: 400;
  color: var(--text-bright);
  margin-bottom: 0.35rem;
  line-height: 1.3;
}

.card-date {
  font-size: 0.78rem;
  color: var(--text-dim);
  letter-spacing: 0.03em;
}

/* Empty state */
.empty-state {
  text-align: center;
  padding: 5rem 2rem;
  border: 1px solid rgba(99, 102, 241, 0.1);
}

.empty-icon {
  color: var(--text-dim);
  opacity: 0.25;
  margin-bottom: 1.5rem;
}

.empty-title {
  font-family: var(--serif);
  font-size: 1.4rem;
  font-weight: 400;
  color: var(--text-bright);
  margin-bottom: 0.6rem;
}

.empty-sub {
  font-size: 0.9rem;
  color: var(--text-dim);
  max-width: 360px;
  margin: 0 auto;
  line-height: 1.6;
}

/* Footer */
footer {
  padding: 2.5rem 0;
  border-top: 1px solid rgba(99, 102, 241, 0.08);
  margin-top: auto;
}

.footer-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  max-width: 960px;
  margin: 0 auto;
  padding: 0 2rem;
  font-size: 0.8rem;
  color: var(--text-dim);
}

.footer-wordmark {
  font-family: var(--serif);
  font-weight: 300;
  letter-spacing: 0.1em;
  color: var(--text);
}

footer a {
  color: var(--text-dim);
  text-decoration: none;
  transition: color 0.3s;
}

footer a:hover { color: var(--glow); }

.footer-powered {
  font-size: 0.75rem;
  letter-spacing: 0.04em;
}

/* Responsive */
@media (max-width: 860px) {
  .gallery-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 540px) {
  nav { padding: 1rem 1.25rem; }
  .container { padding: 0 1.25rem; }
  .profile-hero { padding: 3rem 0 2rem; }
  .galleries-section { padding: 2rem 0 3rem; }

  .gallery-grid {
    grid-template-columns: 1fr;
  }

  .card-placeholder { height: 90px; }

  .profile-meta { gap: 1rem; }

  .footer-inner {
    flex-direction: column;
    gap: 1rem;
    text-align: center;
  }
}
</style>
</head>
<body>

<nav>
  <a href="/" class="wordmark">astra.gallery</a>
</nav>

<section class="profile-hero">
  <div class="container">
    <h1 class="profile-display-name">${escapeHtml(displayName || username)}</h1>
    <p class="profile-username">@${escapeHtml(username)}</p>
    <div class="profile-meta">
      <span class="profile-badge">${galleryCount} ${galleryWord}</span>
      ${memberSince ? `<span class="profile-member-since">Sharing since ${memberSince}</span>` : ""}
    </div>
  </div>
</section>

<section class="galleries-section">
  <div class="container">
    ${galleryCount > 0 ? `<div class="section-label">Galleries</div><div class="gallery-grid">${shareCards}</div>` : emptyState}
  </div>
</section>

<footer>
  <div class="footer-inner">
    <span class="footer-wordmark">astra.gallery</span>
    <span class="footer-powered">Powered by <a href="/">Astra</a></span>
  </div>
</footer>

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
