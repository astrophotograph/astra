import { Hono } from "hono";
import type { Env, GalleryIndexEntry } from "../lib/types";
import { authNavItem, authNavScript } from "../lib/auth-nav";

const landingRoutes = new Hono<{ Bindings: Env }>();

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

landingRoutes.get("/", async (c) => {
  // Fetch recent galleries for the landing page
  const listResult = await c.env.GALLERY_KV.list({
    prefix: "gallery-index/",
    limit: 6,
  });

  const entries: GalleryIndexEntry[] = [];
  for (const key of listResult.keys) {
    const json = await c.env.GALLERY_KV.get(key.name);
    if (json) {
      entries.push(JSON.parse(json));
    }
  }

  // Sort newest first
  entries.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  let recentGalleriesSection = "";
  if (entries.length > 0) {
    const cards = entries
      .map((e) => {
        const pubDate = new Date(e.createdAt).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        const visual = e.thumbnailUrl
          ? `<div class="recent-card-image">
              <img src="${escapeHtml(e.thumbnailUrl)}" alt="${escapeHtml(e.collectionName)}" loading="lazy" />
            </div>`
          : `<div class="recent-card-placeholder">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/>
              <path d="M2 12h20"/>
              <circle cx="12" cy="5" r="0.5" fill="currentColor" stroke="none"/>
              <circle cx="18" cy="9" r="0.5" fill="currentColor" stroke="none"/>
              <circle cx="7" cy="16" r="0.5" fill="currentColor" stroke="none"/>
              <circle cx="15" cy="14" r="0.5" fill="currentColor" stroke="none"/>
            </svg>
          </div>`;
        return `
        <a href="/@${escapeHtml(e.username)}/${escapeHtml(e.collectionSlug)}" class="recent-card">
          ${visual}
          <div class="recent-card-content">
            <h3>${escapeHtml(e.collectionName)}</h3>
            <span class="recent-card-user">@${escapeHtml(e.username)}</span>
            <span class="recent-card-date">${pubDate}</span>
          </div>
        </a>`;
      })
      .join("");

    recentGalleriesSection = `
  <section class="recent-galleries">
    <div class="container reveal">
      <div class="section-header">
        <div class="section-label">Community</div>
        <h2>Recent Galleries</h2>
      </div>
      <div class="gallery-grid">
        ${cards}
      </div>
      <div style="text-align: center; margin-top: 2rem;">
        <a href="/explore" class="btn btn-ghost">Explore All &rarr;</a>
      </div>
    </div>
  </section>`;
  }

  return c.html(buildLandingHtml(recentGalleriesSection));
});

function buildLandingHtml(recentGalleriesSection: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Astra Gallery — Share your astrophotography</title>
<meta name="description" content="Publish and share your astrophotography collections. Auto-refreshing galleries, direct from your desktop.">
<script defer data-domain="astra.gallery" src="https://pulse.steve.net/js/script.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,300;1,9..40,400&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

:root {
  --void: #0a0e1a;
  --deep: #0f1424;
  --surface: #151b2e;
  --purple: #2D1B69;
  --mid: #4A2D8A;
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
  scroll-behavior: smooth;
  background: var(--void);
  color: var(--text);
  font-family: var(--sans);
  font-size: 16px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

body { overflow-x: hidden; }

#starfield {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
}

.container {
  position: relative;
  z-index: 1;
  max-width: 1100px;
  margin: 0 auto;
  padding: 0 2rem;
}

nav {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 100;
  padding: 1.25rem 2rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: linear-gradient(to bottom, var(--void) 60%, transparent);
}

nav .wordmark {
  font-family: var(--serif);
  font-size: 1.5rem;
  font-weight: 300;
  letter-spacing: 0.15em;
  color: var(--text-bright);
  text-decoration: none;
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

.hero {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 6rem 2rem 4rem;
  position: relative;
}

.hero-label {
  font-family: var(--serif);
  font-size: 1rem;
  font-weight: 300;
  letter-spacing: 0.4em;
  text-transform: uppercase;
  color: var(--text-dim);
  margin-bottom: 2rem;
  opacity: 0;
  animation: fadeUp 1s 0.2s forwards;
}

.hero h1 {
  font-family: var(--serif);
  font-size: clamp(3.5rem, 9vw, 7rem);
  font-weight: 300;
  letter-spacing: 0.04em;
  color: var(--text-bright);
  line-height: 1;
  margin-bottom: 1.5rem;
  opacity: 0;
  animation: fadeUp 1s 0.4s forwards;
}

.hero-tagline {
  font-family: var(--serif);
  font-size: clamp(1.1rem, 2.5vw, 1.4rem);
  font-weight: 300;
  font-style: italic;
  color: var(--text);
  max-width: 520px;
  margin-bottom: 3rem;
  opacity: 0;
  animation: fadeUp 1s 0.6s forwards;
}

.hero-cta {
  display: flex;
  gap: 1rem;
  opacity: 0;
  animation: fadeUp 1s 0.8s forwards;
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

.btn-primary {
  background: var(--accent);
  color: #fff;
}

.btn-primary:hover {
  background: var(--light);
  color: #fff;
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

.hero-scroll {
  position: absolute;
  bottom: 2rem;
  left: 50%;
  transform: translateX(-50%);
  opacity: 0;
  animation: fadeUp 1s 1.2s forwards;
}

.hero-scroll span {
  display: block;
  width: 1px;
  height: 40px;
  background: linear-gradient(to bottom, var(--accent), transparent);
  margin: 0 auto;
  animation: pulse 2s infinite;
}

section { padding: 8rem 0; }
section + section { border-top: 1px solid rgba(99, 102, 241, 0.1); }

.features-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  background: rgba(99, 102, 241, 0.1);
  border: 1px solid rgba(99, 102, 241, 0.1);
}

.feature {
  background: var(--void);
  padding: 2.5rem;
  transition: background 0.4s;
}

.feature:hover { background: var(--deep); }

.feature-label {
  font-size: 0.65rem;
  font-weight: 500;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 1rem;
}

.feature h3 {
  font-family: var(--serif);
  font-size: 1.35rem;
  font-weight: 400;
  color: var(--text-bright);
  margin-bottom: 0.75rem;
  line-height: 1.3;
}

.feature p {
  font-size: 0.9rem;
  color: var(--text-dim);
  line-height: 1.6;
}

.open-source {
  text-align: center;
  padding: 6rem 0;
}

.open-source-inner {
  border: 1px solid rgba(99, 102, 241, 0.2);
  padding: 4rem;
  max-width: 600px;
  margin: 0 auto;
  position: relative;
}

.open-source-inner::before {
  content: '';
  position: absolute;
  inset: -1px;
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.1), transparent, rgba(128, 203, 196, 0.05));
  z-index: -1;
}

.open-source h2 {
  font-family: var(--serif);
  font-size: 1.6rem;
  font-weight: 300;
  color: var(--text-bright);
  margin-bottom: 1rem;
}

.open-source p {
  color: var(--text-dim);
  font-size: 0.9rem;
  margin-bottom: 2rem;
  line-height: 1.7;
}

.open-source .license {
  font-size: 0.7rem;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--teal);
}

footer {
  padding: 3rem 0;
  border-top: 1px solid rgba(99, 102, 241, 0.1);
}

footer .footer-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  max-width: 1100px;
  margin: 0 auto;
  padding: 0 2rem;
  font-size: 0.8rem;
  color: var(--text-dim);
}

footer a {
  color: var(--text-dim);
  text-decoration: none;
  transition: color 0.3s;
}

footer a:hover { color: var(--glow); }

footer .footer-links {
  display: flex;
  gap: 2rem;
  list-style: none;
}

.footer-wordmark {
  font-family: var(--serif);
  font-weight: 300;
  letter-spacing: 0.1em;
  color: var(--text);
}

@keyframes fadeUp {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 0.8; }
}

.reveal {
  opacity: 0;
  transform: translateY(30px);
  transition: opacity 0.8s, transform 0.8s;
}

.reveal.visible {
  opacity: 1;
  transform: translateY(0);
}

@media (max-width: 768px) {
  nav .nav-links { display: none; }
  .features-grid { grid-template-columns: 1fr; }
  .container { padding: 0 1.25rem; }
  section { padding: 5rem 0; }
  .open-source-inner { padding: 2.5rem; }
  footer .footer-inner {
    flex-direction: column;
    gap: 1.5rem;
    text-align: center;
  }
}

/* Recent galleries section */
.recent-galleries { padding: 8rem 0; }

.section-header {
  margin-bottom: 2.5rem;
}

.recent-galleries .section-label {
  margin-bottom: 0.75rem;
}

.recent-galleries h2 {
  font-family: var(--serif);
  font-size: clamp(1.6rem, 3vw, 2.2rem);
  font-weight: 300;
  color: var(--text-bright);
  letter-spacing: 0.02em;
}

.gallery-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  background: rgba(99, 102, 241, 0.1);
  border: 1px solid rgba(99, 102, 241, 0.1);
}

.recent-card {
  display: flex;
  flex-direction: column;
  background: var(--void);
  text-decoration: none;
  color: inherit;
  transition: background 0.3s, box-shadow 0.3s;
}

.recent-card:hover {
  background: var(--deep);
  box-shadow: inset 0 0 30px rgba(99, 102, 241, 0.06);
}

.recent-card:hover .recent-card-placeholder {
  border-bottom-color: rgba(99, 102, 241, 0.2);
}

.recent-card:hover .recent-card-placeholder svg {
  color: var(--accent);
  opacity: 0.6;
}

.recent-card-image {
  height: 140px;
  overflow: hidden;
  border-bottom: 1px solid rgba(99, 102, 241, 0.06);
}

.recent-card-image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.3s;
}

.recent-card:hover .recent-card-image img {
  transform: scale(1.03);
}

.recent-card-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100px;
  border-bottom: 1px solid rgba(99, 102, 241, 0.06);
  background:
    radial-gradient(ellipse at 30% 40%, rgba(99, 102, 241, 0.04) 0%, transparent 60%),
    radial-gradient(ellipse at 70% 70%, rgba(128, 203, 196, 0.03) 0%, transparent 50%);
  transition: border-color 0.3s;
}

.recent-card-placeholder svg {
  color: var(--text-dim);
  opacity: 0.3;
  transition: color 0.3s, opacity 0.3s;
}

.recent-card-content {
  padding: 1rem 1.25rem 1.25rem;
}

.recent-card h3 {
  font-family: var(--serif);
  font-size: 1.15rem;
  font-weight: 400;
  color: var(--text-bright);
  margin-bottom: 0.3rem;
  line-height: 1.3;
}

.recent-card-user {
  font-size: 0.8rem;
  color: var(--text-dim);
  display: block;
  margin-bottom: 0.15rem;
}

.recent-card-date {
  font-size: 0.75rem;
  color: var(--text-dim);
  letter-spacing: 0.03em;
}

@media (max-width: 768px) {
  .gallery-grid { grid-template-columns: repeat(2, 1fr); }
}

@media (max-width: 480px) {
  .hero-cta {
    flex-direction: column;
    width: 100%;
    max-width: 280px;
  }
  .btn { justify-content: center; }
  .gallery-grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>

<canvas id="starfield"></canvas>

<nav>
  <a href="/" class="wordmark">astra.gallery</a>
  <ul class="nav-links">
    <li><a href="/explore">Explore</a></li>
    <li><a href="#features">Features</a></li>
    <li><a href="https://github.com/astrophotograph/astra" target="_blank" rel="noopener">Source</a></li>
    ${authNavItem()}
  </ul>
</nav>

<main>
  <section class="hero">
    <div class="hero-label">astrophotography, shared</div>
    <h1>Astra Gallery</h1>
    <p class="hero-tagline">Publish your astrophotography collections as beautiful, auto-refreshing galleries</p>
    <div class="hero-cta">
      <a href="https://github.com/astrophotograph/astra/releases" class="btn btn-primary" target="_blank" rel="noopener">Download Astra</a>
      <a href="/explore" class="btn btn-ghost">Explore Galleries</a>
    </div>
    <div class="hero-scroll"><span></span></div>
  </section>

  <section id="features">
    <div class="container reveal">
      <div class="features-grid">
        <div class="feature">
          <div class="feature-label">Publish</div>
          <h3>Collection Galleries</h3>
          <p>Turn any image collection into a shareable gallery. Thumbnails, lightbox viewer, and metadata — all generated automatically from your observation log.</p>
        </div>
        <div class="feature">
          <div class="feature-label">Live</div>
          <h3>Auto-Refreshing</h3>
          <p>Galleries update every 30 seconds. Share the link at the start of your session and let viewers watch your collection grow as you image through the night.</p>
        </div>
        <div class="feature">
          <div class="feature-label">Desktop</div>
          <h3>Direct from Astra</h3>
          <p>One click from the desktop app. Sign in, pick a collection, publish. No manual uploads, no file management. Images go straight to the cloud.</p>
        </div>
      </div>
    </div>
  </section>

  ${recentGalleriesSection}

  <section class="open-source">
    <div class="container reveal">
      <div class="open-source-inner">
        <h2>Open source</h2>
        <p>Astra is free software. The desktop app, this gallery service, and every line of code in between. Built in the open because your data should always be yours.</p>
        <a href="https://github.com/astrophotograph/astra" class="btn btn-ghost" target="_blank" rel="noopener">Browse the source</a>
        <p class="license" style="margin-top: 1.5rem; margin-bottom: 0;">Licensed under GNU AGPL v3</p>
      </div>
    </div>
  </section>
</main>

<footer>
  <div class="footer-inner">
    <span class="footer-wordmark">astra.gallery</span>
    <ul class="footer-links">
      <li><a href="https://github.com/astrophotograph/astra" target="_blank" rel="noopener">GitHub</a></li>
    </ul>
  </div>
</footer>

<script>
// Star field background
(function() {
  const canvas = document.getElementById('starfield');
  const ctx = canvas.getContext('2d');
  let stars = [];
  let w, h;

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight * 3;
  }

  function init() {
    resize();
    stars = [];
    const count = Math.floor((w * h) / 30000);
    for (let i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: Math.random() * 1.2 + 0.2,
        vx: (Math.random() - 0.5) * 0.04,
        vy: (Math.random() - 0.5) * 0.04,
        alpha: Math.random() * 0.5 + 0.1,
        twinkleSpeed: Math.random() * 0.02 + 0.005,
        twinkleOffset: Math.random() * Math.PI * 2,
      });
    }
  }

  let frame = 0;
  function draw() {
    ctx.clearRect(0, 0, w, h);
    frame++;

    // Draw faint connections between nearby stars
    for (let i = 0; i < stars.length; i++) {
      for (let j = i + 1; j < stars.length; j++) {
        const dx = stars[i].x - stars[j].x;
        const dy = stars[i].y - stars[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 100) {
          const alpha = (1 - dist / 100) * 0.03;
          ctx.strokeStyle = 'rgba(99, 102, 241, ' + alpha + ')';
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(stars[i].x, stars[i].y);
          ctx.lineTo(stars[j].x, stars[j].y);
          ctx.stroke();
        }
      }
    }

    // Draw stars with twinkling
    for (const star of stars) {
      const twinkle = Math.sin(frame * star.twinkleSpeed + star.twinkleOffset);
      const alpha = star.alpha + twinkle * 0.15;

      ctx.beginPath();
      ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(200, 210, 230, ' + Math.max(0.05, alpha) + ')';
      ctx.fill();

      star.x += star.vx;
      star.y += star.vy;
      if (star.x < 0 || star.x > w) star.vx *= -1;
      if (star.y < 0 || star.y > h) star.vy *= -1;
    }

    requestAnimationFrame(draw);
  }

  init();
  draw();
  window.addEventListener('resize', init);
})();

// Scroll reveal
(function() {
  const els = document.querySelectorAll('.reveal');
  const observer = new IntersectionObserver(function(entries) {
    entries.forEach(function(e) {
      if (e.isIntersecting) {
        e.target.classList.add('visible');
        observer.unobserve(e.target);
      }
    });
  }, { threshold: 0.15 });
  els.forEach(function(el) { observer.observe(el); });
})();
</script>

${authNavScript()}

</body>
</html>`;
}

export { landingRoutes };
