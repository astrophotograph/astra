import { Hono } from "hono";
import type { Env } from "../lib/types";

const exploreRoutes = new Hono<{ Bindings: Env }>();

// Common Messier object names
const MESSIER_COMMON_NAMES: Record<string, string> = {
  m1: "Crab Nebula",
  m8: "Lagoon Nebula",
  m13: "Hercules Cluster",
  m16: "Eagle Nebula",
  m17: "Omega Nebula",
  m20: "Trifid Nebula",
  m27: "Dumbbell Nebula",
  m31: "Andromeda Galaxy",
  m33: "Triangulum Galaxy",
  m42: "Orion Nebula",
  m43: "De Mairan's Nebula",
  m44: "Beehive Cluster",
  m45: "Pleiades",
  m51: "Whirlpool Galaxy",
  m57: "Ring Nebula",
  m63: "Sunflower Galaxy",
  m64: "Black Eye Galaxy",
  m76: "Little Dumbbell Nebula",
  m78: "Reflection Nebula",
  m81: "Bode's Galaxy",
  m82: "Cigar Galaxy",
  m83: "Southern Pinwheel Galaxy",
  m97: "Owl Nebula",
  m101: "Pinwheel Galaxy",
  m104: "Sombrero Galaxy",
  m110: "Satellite of Andromeda",
};

interface GalleryIndexEntry {
  userId: string;
  username: string;
  collectionSlug: string;
  collectionName: string;
  shareId: string;
  createdAt?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderCard(entry: GalleryIndexEntry, createdAt?: string): string {
  const pubDate = createdAt
    ? new Date(createdAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "";
  return `
    <a href="/@${escapeHtml(entry.username)}/${escapeHtml(entry.collectionSlug)}" class="gallery-card">
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
        <h3>${escapeHtml(entry.collectionName)}</h3>
        <span class="card-username">@${escapeHtml(entry.username)}</span>
        ${pubDate ? `<span class="card-date">${pubDate}</span>` : ""}
      </div>
    </a>`;
}

function renderPage(
  title: string,
  description: string,
  activeNav: "explore" | "search",
  bodyContent: string
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} — Astra Gallery</title>
<meta name="description" content="${escapeHtml(description)}">
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
nav .nav-links a.active { color: var(--text-bright); }

/* Container */
.container {
  max-width: 960px;
  margin: 0 auto;
  padding: 0 2rem;
  width: 100%;
}

/* Page header */
.page-header {
  padding: 3rem 0 2.5rem;
  border-bottom: 1px solid rgba(99, 102, 241, 0.08);
}

.page-header h1 {
  font-family: var(--serif);
  font-size: clamp(2rem, 4vw, 2.8rem);
  font-weight: 300;
  letter-spacing: 0.03em;
  color: var(--text-bright);
  line-height: 1.15;
  margin-bottom: 0.4rem;
}

.page-header .subtitle {
  font-size: 0.95rem;
  color: var(--text-dim);
}

/* Section */
.section-label {
  font-size: 0.65rem;
  font-weight: 500;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 1.5rem;
}

/* Gallery grid */
.galleries-section {
  padding: 3rem 0 4rem;
  flex: 1;
}

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

.card-username {
  font-size: 0.82rem;
  color: var(--text-dim);
  display: block;
  margin-bottom: 0.2rem;
}

.card-date {
  font-size: 0.78rem;
  color: var(--text-dim);
  letter-spacing: 0.03em;
}

/* Search */
.search-form {
  margin-bottom: 2rem;
}

.search-input {
  width: 100%;
  padding: 0.85rem 1.25rem;
  background: var(--deep);
  border: 1px solid rgba(99, 102, 241, 0.2);
  color: var(--text-bright);
  font-family: var(--sans);
  font-size: 0.95rem;
  border-radius: 2px;
  outline: none;
  transition: border-color 0.3s;
}

.search-input::placeholder { color: var(--text-dim); }
.search-input:focus { border-color: var(--accent); }

.result-count {
  font-size: 0.85rem;
  color: var(--text-dim);
  margin-bottom: 1.5rem;
}

/* Pagination */
.pagination {
  text-align: center;
  margin-top: 2rem;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 2rem;
  border-radius: 2px;
  font-family: var(--sans);
  font-size: 0.8rem;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  text-decoration: none;
  transition: all 0.3s;
  cursor: pointer;
  border: none;
}

.btn-ghost {
  background: transparent;
  color: var(--text);
  border: 1px solid rgba(99, 102, 241, 0.3);
}

.btn-ghost:hover {
  border-color: var(--light);
  color: var(--text-bright);
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
  .page-header { padding: 2rem 0 1.5rem; }
  .galleries-section { padding: 2rem 0 3rem; }

  .gallery-grid {
    grid-template-columns: 1fr;
  }

  .card-placeholder { height: 90px; }

  nav .nav-links { gap: 1rem; }

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
    <li><a href="/explore"${activeNav === "explore" ? ' class="active"' : ""}>Explore</a></li>
    <li><a href="/search"${activeNav === "search" ? ' class="active"' : ""}>Search</a></li>
  </ul>
</nav>

${bodyContent}

<footer>
  <div class="footer-inner">
    <span class="footer-wordmark">astra.gallery</span>
    <span class="footer-powered">Powered by <a href="/">Astra</a></span>
  </div>
</footer>

</body>
</html>`;
}

function renderEmptyState(message: string): string {
  return `
    <div class="empty-state">
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="0.75" stroke-linecap="round" stroke-linejoin="round" class="empty-icon">
        <circle cx="12" cy="12" r="10"/>
        <circle cx="12" cy="12" r="3"/>
        <line x1="12" y1="2" x2="12" y2="5"/>
        <line x1="12" y1="19" x2="12" y2="22"/>
        <line x1="2" y1="12" x2="5" y2="12"/>
        <line x1="19" y1="12" x2="22" y2="12"/>
      </svg>
      <p class="empty-title">Nothing here yet</p>
      <p class="empty-sub">${escapeHtml(message)}</p>
    </div>`;
}

/**
 * GET /explore — Recent galleries page
 */
exploreRoutes.get("/explore", async (c) => {
  const afterCursor = c.req.query("after") || undefined;
  const listResult = await c.env.GALLERY_KV.list({
    prefix: "gallery-index/",
    limit: 30,
    cursor: afterCursor,
  });

  const entries: Array<GalleryIndexEntry & { createdAt: string }> = [];
  for (const key of listResult.keys) {
    const json = await c.env.GALLERY_KV.get(key.name);
    if (json) {
      entries.push(JSON.parse(json));
    }
  }

  // Sort newest first (keys are time-sorted but we sort by createdAt to be safe)
  entries.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  let cardsHtml: string;
  if (entries.length === 0) {
    cardsHtml = renderEmptyState("No galleries have been published yet. Be the first to share your astrophotography.");
  } else {
    const cards = entries.map((e) => renderCard(e, e.createdAt)).join("");
    cardsHtml = `
      <div class="section-label">Recent</div>
      <div class="gallery-grid">${cards}</div>`;

    if (!listResult.list_complete && listResult.cursor) {
      cardsHtml += `
        <div class="pagination">
          <a href="/explore?after=${encodeURIComponent(listResult.cursor)}" class="btn btn-ghost">Load More</a>
        </div>`;
    }
  }

  const body = `
    <section class="page-header">
      <div class="container">
        <h1>Explore</h1>
        <p class="subtitle">Recently published astrophotography galleries</p>
      </div>
    </section>
    <section class="galleries-section">
      <div class="container">
        ${cardsHtml}
      </div>
    </section>`;

  return c.html(renderPage("Explore", "Browse recent astrophotography galleries on Astra Gallery", "explore", body));
});

/**
 * GET /objects/:name — Galleries for a specific deep-sky object
 */
exploreRoutes.get("/objects/:name", async (c) => {
  const rawName = c.req.param("name");
  const normalizedName = rawName.trim().toLowerCase().replace(/\s+/g, "-");

  const listResult = await c.env.GALLERY_KV.list({
    prefix: `object-index/${normalizedName}/`,
  });

  const entries: GalleryIndexEntry[] = [];
  for (const key of listResult.keys) {
    const json = await c.env.GALLERY_KV.get(key.name);
    if (json) {
      entries.push(JSON.parse(json));
    }
  }

  // Build display name
  const commonName = MESSIER_COMMON_NAMES[normalizedName];
  const displayName = commonName
    ? `${rawName.toUpperCase()} — ${commonName}`
    : rawName;

  let cardsHtml: string;
  if (entries.length === 0) {
    cardsHtml = renderEmptyState(`No galleries have been published for ${rawName} yet.`);
  } else {
    const cards = entries.map((e) => renderCard(e)).join("");
    cardsHtml = `
      <div class="section-label">${entries.length} ${entries.length === 1 ? "gallery" : "galleries"}</div>
      <div class="gallery-grid">${cards}</div>`;
  }

  const body = `
    <section class="page-header">
      <div class="container">
        <h1>${escapeHtml(displayName)}</h1>
        <p class="subtitle">Galleries featuring this object</p>
      </div>
    </section>
    <section class="galleries-section">
      <div class="container">
        ${cardsHtml}
      </div>
    </section>`;

  return c.html(renderPage(displayName, `Astrophotography galleries of ${displayName} on Astra Gallery`, "explore", body));
});

/**
 * GET /search?q=... — Search galleries
 */
exploreRoutes.get("/search", async (c) => {
  const query = (c.req.query("q") || "").trim();

  let entries: Array<GalleryIndexEntry & { createdAt?: string }> = [];
  let resultCountHtml = "";

  if (query) {
    const lowerQuery = query.toLowerCase();

    // Fetch up to 1000 entries from the gallery index
    let cursor: string | undefined;
    const allEntries: Array<GalleryIndexEntry & { createdAt?: string }> = [];

    do {
      const listResult = await c.env.GALLERY_KV.list({
        prefix: "gallery-index/",
        limit: 1000,
        cursor,
      });

      for (const key of listResult.keys) {
        const json = await c.env.GALLERY_KV.get(key.name);
        if (json) {
          allEntries.push(JSON.parse(json));
        }
      }

      cursor = listResult.list_complete ? undefined : listResult.cursor;
    } while (cursor);

    entries = allEntries.filter(
      (e) =>
        e.collectionName.toLowerCase().includes(lowerQuery) ||
        e.username.toLowerCase().includes(lowerQuery)
    );

    resultCountHtml = `<p class="result-count">${entries.length} ${entries.length === 1 ? "result" : "results"} for "${escapeHtml(query)}"</p>`;
  }

  const searchFormHtml = `
    <form class="search-form" action="/search" method="get">
      <input type="text" name="q" class="search-input" placeholder="Search by object name, collection, or username..." value="${escapeHtml(query)}" autofocus>
    </form>`;

  let cardsHtml: string;
  if (!query) {
    cardsHtml = "";
  } else if (entries.length === 0) {
    cardsHtml = renderEmptyState(`No galleries matched "${query}". Try a different search term.`);
  } else {
    const cards = entries.map((e) => renderCard(e, e.createdAt)).join("");
    cardsHtml = `<div class="gallery-grid">${cards}</div>`;
  }

  const body = `
    <section class="page-header">
      <div class="container">
        <h1>Search</h1>
        <p class="subtitle">Find galleries by object name, collection, or astronomer</p>
      </div>
    </section>
    <section class="galleries-section">
      <div class="container">
        ${searchFormHtml}
        ${resultCountHtml}
        ${cardsHtml}
      </div>
    </section>`;

  return c.html(renderPage("Search", "Search astrophotography galleries on Astra Gallery", "search", body));
});

export { exploreRoutes };
