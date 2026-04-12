import { Hono } from "hono";
import type { Env, ShareRecord, UserRecord } from "../lib/types";
import { requireApiToken } from "../middleware/clerk";
import { authNavItem, authNavScript, faviconLink } from "../lib/auth-nav";
import { followButton, socialWidgetStyles, socialWidgetScript } from "../lib/social-widgets";

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

function buildLikeWidget(shareId: string): string {
  return `
<style>
.like-widget {
  position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 1000;
  display: flex; align-items: center; gap: 0.5rem;
  background: rgba(10, 14, 26, 0.9); backdrop-filter: blur(8px);
  border: 1px solid rgba(99, 102, 241, 0.2); border-radius: 2rem;
  padding: 0.5rem 1rem; font-family: 'DM Sans', -apple-system, sans-serif;
}
.like-btn {
  background: none; border: none; cursor: pointer; font-size: 1.4rem;
  padding: 0; line-height: 1; transition: transform 0.2s;
}
.like-btn:hover { transform: scale(1.15); }
.like-btn.liked { animation: like-pop 0.3s ease; }
@keyframes like-pop { 0% { transform: scale(1); } 50% { transform: scale(1.3); } 100% { transform: scale(1); } }
.like-count { font-size: 0.85rem; color: #c8cdd8; }
</style>
<div class="like-widget">
  <button class="like-btn" id="like-btn" title="Like this gallery">&#9825;</button>
  <span class="like-count" id="like-count"></span>
</div>
<script>
(function() {
  var shareId = ${JSON.stringify(shareId)};
  var btn = document.getElementById('like-btn');
  var countEl = document.getElementById('like-count');
  var token = localStorage.getItem('astra_api_token');
  var expires = localStorage.getItem('astra_token_expires');
  var isAuthed = token && expires && new Date(expires) > new Date();
  var isLiked = false;

  // Load count
  fetch('/api/social/likes/' + shareId)
    .then(function(r) { return r.json(); })
    .then(function(d) { countEl.textContent = d.count > 0 ? d.count : ''; })
    .catch(function() {});

  // Check liked state
  if (isAuthed) {
    fetch('/api/social/liked/' + shareId, { headers: { 'Authorization': 'Bearer ' + token } })
      .then(function(r) { return r.json(); })
      .then(function(d) { if (d.liked) { isLiked = true; btn.innerHTML = '&#9829;'; btn.classList.add('liked'); } })
      .catch(function() {});
  }

  btn.addEventListener('click', function() {
    if (!isAuthed) { location.href = '/auth/callback?return=' + encodeURIComponent(location.pathname); return; }
    var method = isLiked ? 'DELETE' : 'POST';
    fetch('/api/social/' + (isLiked ? 'like/' : 'like/') + shareId, {
      method: method,
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: '{}'
    }).then(function(r) { return r.json(); }).then(function(d) {
      isLiked = d.liked;
      btn.innerHTML = isLiked ? '&#9829;' : '&#9825;';
      if (isLiked) btn.classList.add('liked'); else btn.classList.remove('liked');
      var cur = parseInt(countEl.textContent) || 0;
      var n = isLiked ? cur + 1 : Math.max(0, cur - 1);
      countEl.textContent = n > 0 ? n : '';
    }).catch(function() {});
  });
})();
</script>`;
}

async function incrementViewCount(kv: KVNamespace, shareId: string): Promise<void> {
  const key = `view-counts/${shareId}`;
  const current = parseInt(await kv.get(key) || "0", 10);
  await kv.put(key, String(current + 1));
}

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
    const user = JSON.parse(userJson) as UserRecord;
    const sharesList = await c.env.GALLERY_KV.list({ prefix: `user-shares/${userId}/` });
    const shares: { slug: string; name: string; createdAt: string }[] = [];
    for (const key of sharesList.keys) {
      const shareJson = await c.env.GALLERY_KV.get(key.name);
      if (shareJson) {
        const share = JSON.parse(shareJson) as { collectionSlug: string; collectionName: string; createdAt: string };
        shares.push({ slug: share.collectionSlug, name: share.collectionName, createdAt: share.createdAt });
      }
    }
    return c.html(renderProfilePage(username, userId, user, shares));
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

    // Increment view count (fire-and-forget, don't block response)
    const ua = c.req.header("user-agent") || "";
    if (!/bot|crawl|spider|preview|slurp|facebookexternalhit/i.test(ua)) {
      c.executionCtx.waitUntil(
        incrementViewCount(c.env.GALLERY_KV, share.shareId)
      );
    }

    // Inject like widget into gallery HTML
    const html = await object.text();
    const likeWidget = buildLikeWidget(share.shareId);
    const injected = html.replace("</body>", likeWidget + "</body>");
    return new Response(injected, { headers });
  }
  object.writeHttpMetadata(headers);

  return new Response(object.body, { headers });
}

// Catch all /@username paths and parse manually
galleryRoutes.all("/@:username", handleUserGallery);
galleryRoutes.all("/@:username/*", handleUserGallery);

// GET /api/galleries/:shareId/views — public view count
galleryRoutes.get("/api/galleries/:shareId/views", async (c) => {
  const shareId = c.req.param("shareId");
  const count = parseInt(await c.env.GALLERY_KV.get(`view-counts/${shareId}`) || "0", 10);
  return c.json({ shareId, views: count });
});

/**
 * DELETE /api/galleries/:shareId
 * Fully delete a gallery: R2 objects, all KV entries.
 * Requires API token. Only the gallery owner can delete.
 */
galleryRoutes.delete("/api/galleries/:shareId", requireApiToken, async (c) => {
  const shareId = c.req.param("shareId");
  const apiToken = c.get("apiToken" as never) as {
    userId: string;
    username: string;
  };

  // Verify ownership
  const shareJson = await c.env.GALLERY_KV.get(`shares/${shareId}`);
  if (!shareJson) {
    return c.json({ error: "Gallery not found" }, 404);
  }
  const share: ShareRecord = JSON.parse(shareJson);
  if (share.userId !== apiToken.userId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  let filesRemoved = 0;

  // Delete R2 objects under users/{userId}/{shareId}/
  const r2Prefix = `users/${apiToken.userId}/${shareId}/`;
  let r2Cursor: string | undefined;
  do {
    const listed = await c.env.GALLERY_BUCKET.list({ prefix: r2Prefix, cursor: r2Cursor });
    if (listed.objects.length > 0) {
      await c.env.GALLERY_BUCKET.delete(listed.objects.map(o => o.key));
      filesRemoved += listed.objects.length;
    }
    r2Cursor = listed.truncated ? listed.cursor : undefined;
  } while (r2Cursor);

  // Delete KV: shares/{shareId}
  await c.env.GALLERY_KV.delete(`shares/${shareId}`);

  // Delete KV: user-shares/{userId}/{slug}
  const slug = share.collectionSlug;
  await c.env.GALLERY_KV.delete(`user-shares/${apiToken.userId}/${slug}`);

  // Delete KV: view-counts/{shareId}
  await c.env.GALLERY_KV.delete(`view-counts/${shareId}`);

  // Delete KV: gallery-index entries matching this shareId
  // Scan gallery-index/ for entries containing this shareId
  let indexCursor: string | undefined;
  do {
    const listed = await c.env.GALLERY_KV.list({ prefix: "gallery-index/", cursor: indexCursor, limit: 500 });
    for (const key of listed.keys) {
      if (key.name.includes(shareId)) {
        await c.env.GALLERY_KV.delete(key.name);
      }
    }
    indexCursor = listed.list_complete ? undefined : listed.cursor;
  } while (indexCursor);

  // Delete KV: object-index entries matching this shareId
  // Object index keys end with /{shareId}
  let objCursor: string | undefined;
  do {
    const listed = await c.env.GALLERY_KV.list({ prefix: "object-index/", cursor: objCursor, limit: 500 });
    for (const key of listed.keys) {
      if (key.name.endsWith(`/${shareId}`)) {
        await c.env.GALLERY_KV.delete(key.name);
      }
    }
    objCursor = listed.list_complete ? undefined : listed.cursor;
  } while (objCursor);

  return c.json({ deleted: true, filesRemoved });
});

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
  userId: string,
  user: UserRecord,
  shares: { slug: string; name: string; createdAt: string }[]
): string {
  const displayName = user.displayName || username;
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

  // Avatar
  const avatarHtml = user.avatarUrl
    ? `<img src="${escapeHtml(user.avatarUrl)}" alt="${escapeHtml(displayName)}" class="profile-avatar" />`
    : `<div class="profile-avatar profile-avatar-placeholder">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="8" r="4"/>
          <path d="M4 21v-1a6 6 0 0 1 12 0v1"/>
        </svg>
      </div>`;

  // Bio
  const bioHtml = user.bio
    ? `<p class="profile-bio">${escapeHtml(user.bio)}</p>`
    : "";

  // Location
  const locationHtml = user.location
    ? `<span class="profile-location">${escapeHtml(user.location)}</span>`
    : "";

  // Equipment
  const equipmentHtml = user.equipment && user.equipment.length > 0
    ? `<div class="profile-equipment">
        <span class="equipment-label">Equipment</span>
        <ul>${user.equipment.map(e => `<li>${escapeHtml(e)}</li>`).join("")}</ul>
      </div>`
    : "";

  // Links
  const linkEntries: string[] = [];
  if (user.links?.website) {
    const display = user.links.website.replace(/^https?:\/\//, "").replace(/\/$/, "");
    linkEntries.push(`<a href="${escapeHtml(user.links.website)}" target="_blank" rel="noopener">${escapeHtml(display)}</a>`);
  }
  if (user.links?.instagram) {
    linkEntries.push(`<a href="https://instagram.com/${escapeHtml(user.links.instagram)}" target="_blank" rel="noopener">Instagram</a>`);
  }
  if (user.links?.astrobin) {
    linkEntries.push(`<a href="https://www.astrobin.com/users/${escapeHtml(user.links.astrobin)}/" target="_blank" rel="noopener">AstroBin</a>`);
  }
  if (user.links?.cloudynights) {
    linkEntries.push(`<a href="https://www.cloudynights.com/profile/${escapeHtml(user.links.cloudynights)}/" target="_blank" rel="noopener">Cloudy Nights</a>`);
  }
  const linksHtml = linkEntries.length > 0
    ? `<div class="profile-links">${linkEntries.join(" · ")}</div>`
    : "";

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
${faviconLink()}
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

nav .nav-links {
  display: flex;
  gap: 2rem;
  list-style: none;
  align-items: center;
}

nav .nav-links a {
  color: var(--text-dim);
  text-decoration: none;
  font-size: 0.8rem;
  font-weight: 400;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  transition: color 0.3s;
}

nav .nav-links a:hover { color: var(--glow); }

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

.profile-avatar {
  width: 96px;
  height: 96px;
  border-radius: 50%;
  object-fit: cover;
  margin: 0 auto 1.5rem;
  display: block;
  border: 2px solid rgba(99, 102, 241, 0.2);
}

.profile-avatar-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--deep);
  color: var(--text-dim);
}

.profile-bio {
  font-size: 0.95rem;
  color: var(--text);
  max-width: 500px;
  margin: 0.75rem auto 1rem;
  line-height: 1.6;
}

.profile-location {
  font-size: 0.8rem;
  color: var(--text-dim);
  letter-spacing: 0.04em;
}

.profile-links {
  margin-top: 1rem;
  font-size: 0.85rem;
}

.profile-links a {
  color: var(--accent);
  text-decoration: none;
  transition: color 0.3s;
}

.profile-links a:hover {
  color: var(--glow);
}

.profile-equipment {
  margin-top: 1.5rem;
  text-align: left;
  max-width: 400px;
  margin-left: auto;
  margin-right: auto;
}

.equipment-label {
  font-size: 0.65rem;
  font-weight: 500;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--accent);
  display: block;
  margin-bottom: 0.5rem;
}

.profile-equipment ul {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.profile-equipment li {
  font-size: 0.8rem;
  color: var(--text-dim);
  background: var(--deep);
  border: 1px solid rgba(99, 102, 241, 0.1);
  padding: 0.25rem 0.75rem;
  border-radius: 2px;
}

${socialWidgetStyles()}

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
  <ul class="nav-links">
    <li><a href="/explore">Explore</a></li>
    ${authNavItem()}
  </ul>
</nav>

<section class="profile-hero">
  <div class="container">
    ${avatarHtml}
    <h1 class="profile-display-name">${escapeHtml(displayName)}</h1>
    <p class="profile-username">@${escapeHtml(username)}</p>
    ${bioHtml}
    <div class="profile-meta">
      <span class="profile-badge">${galleryCount} ${galleryWord}</span>
      ${locationHtml}
      ${memberSince ? `<span class="profile-member-since">Sharing since ${memberSince}</span>` : ""}
    </div>
    ${followButton("user", userId)}
    ${linksHtml}
    ${equipmentHtml}
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

${socialWidgetScript()}
${authNavScript()}

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
