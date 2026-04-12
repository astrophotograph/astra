/**
 * Web-based upload routes: gallery management API + upload page.
 */

import { Hono } from "hono";
import type { Env, ShareRecord } from "../lib/types";
import { requireApiToken } from "../middleware/clerk";
import { authNavItem, authNavScript, faviconLink } from "../lib/auth-nav";

const uploadRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/galleries
 * List the authenticated user's galleries.
 */
uploadRoutes.get("/galleries", requireApiToken, async (c) => {
  const apiToken = c.get("apiToken" as never) as {
    userId: string;
    username: string;
  };

  const listed = await c.env.GALLERY_KV.list({
    prefix: `user-shares/${apiToken.userId}/`,
    limit: 100,
  });

  const galleries: Array<{
    shareId: string;
    slug: string;
    name: string;
    createdAt: string;
    publicUrl: string;
  }> = [];

  for (const key of listed.keys) {
    const json = await c.env.GALLERY_KV.get(key.name);
    if (json) {
      const share = JSON.parse(json) as ShareRecord & { shareId: string };
      galleries.push({
        shareId: share.shareId,
        slug: share.collectionSlug,
        name: share.collectionName,
        createdAt: share.createdAt,
        publicUrl: `https://astra.gallery/@${apiToken.username}/${share.collectionSlug}`,
      });
    }
  }

  // Sort newest first
  galleries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return c.json({ galleries });
});

/**
 * POST /api/galleries
 * Create a new (empty) gallery.
 */
uploadRoutes.post("/galleries", requireApiToken, async (c) => {
  const apiToken = c.get("apiToken" as never) as {
    userId: string;
    username: string;
  };

  const body = await c.req.json<{
    name: string;
    slug?: string;
    description?: string;
  }>();

  if (!body.name || body.name.trim().length === 0) {
    return c.json({ error: "Gallery name is required" }, 400);
  }

  const name = body.name.trim();
  const slug = (body.slug || name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

  if (!slug) {
    return c.json({ error: "Could not generate a valid slug from the name" }, 400);
  }

  // Check for slug collision
  const existing = await c.env.GALLERY_KV.get(`user-shares/${apiToken.userId}/${slug}`);
  if (existing) {
    return c.json({ error: `Gallery "${slug}" already exists` }, 409);
  }

  // Generate share ID
  const shareId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);

  const shareRecord: ShareRecord = {
    userId: apiToken.userId,
    username: apiToken.username,
    collectionSlug: slug,
    collectionName: name,
    createdAt: new Date().toISOString(),
  };

  await c.env.GALLERY_KV.put(`shares/${shareId}`, JSON.stringify(shareRecord));
  await c.env.GALLERY_KV.put(
    `user-shares/${apiToken.userId}/${slug}`,
    JSON.stringify({ ...shareRecord, shareId })
  );

  return c.json({
    shareId,
    slug,
    name,
    publicUrl: `https://astra.gallery/@${apiToken.username}/${slug}`,
  });
});

/**
 * GET /upload
 * Serve the upload page (static HTML with embedded Preact app).
 */
uploadRoutes.get("/upload", async (c) => {
  return c.html(buildUploadPage());
});

function buildUploadPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Upload — Astra Gallery</title>
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
  --success: #22c55e;
  --error: #ef4444;
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
}

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
}

nav .nav-links { display: flex; gap: 2rem; list-style: none; align-items: center; }
nav .nav-links a {
  color: var(--text-dim); text-decoration: none; font-size: 0.8rem;
  font-weight: 400; letter-spacing: 0.08em; text-transform: uppercase; transition: color 0.3s;
}
nav .nav-links a:hover { color: var(--glow); }
nav .nav-links a.active { color: var(--text-bright); }

.container { max-width: 720px; margin: 0 auto; padding: 0 2rem; width: 100%; }

.page-header { padding: 3rem 0 2rem; border-bottom: 1px solid rgba(99, 102, 241, 0.08); }
.page-header h1 {
  font-family: var(--serif); font-size: 2.2rem; font-weight: 300;
  color: var(--text-bright); margin-bottom: 0.4rem;
}
.page-header .subtitle { font-size: 0.95rem; color: var(--text-dim); }

.upload-section { padding: 2rem 0 4rem; flex: 1; }

/* Auth gate */
#auth-gate { text-align: center; padding: 4rem 0; }
#auth-gate p { color: var(--text-dim); margin-bottom: 1.5rem; }

.btn {
  display: inline-flex; align-items: center; gap: 0.5rem;
  padding: 0.75rem 2rem; border-radius: 2px;
  font-family: var(--sans); font-size: 0.8rem; font-weight: 500;
  letter-spacing: 0.1em; text-transform: uppercase;
  text-decoration: none; transition: all 0.3s; cursor: pointer; border: none;
}
.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:hover { background: var(--light); }
.btn-ghost { background: transparent; color: var(--text); border: 1px solid rgba(99, 102, 241, 0.3); }
.btn-ghost:hover { border-color: var(--light); color: var(--text-bright); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* Upload form */
#upload-app { display: none; }

.form-group { margin-bottom: 1.5rem; }
.form-group label {
  display: block; font-size: 0.75rem; font-weight: 500;
  letter-spacing: 0.15em; text-transform: uppercase; color: var(--accent); margin-bottom: 0.5rem;
}
.form-input {
  width: 100%; padding: 0.75rem 1rem; background: var(--deep);
  border: 1px solid rgba(99, 102, 241, 0.2); color: var(--text-bright);
  font-family: var(--sans); font-size: 0.95rem; border-radius: 2px;
  outline: none; transition: border-color 0.3s;
}
.form-input:focus { border-color: var(--accent); }
.form-input::placeholder { color: var(--text-dim); }

select.form-input {
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 1rem center;
  padding-right: 2.5rem;
}

/* Drop zone */
.drop-zone {
  border: 2px dashed rgba(99, 102, 241, 0.3); border-radius: 4px;
  padding: 3rem 2rem; text-align: center; transition: all 0.3s;
  cursor: pointer; position: relative;
}
.drop-zone:hover, .drop-zone.dragover {
  border-color: var(--accent); background: rgba(99, 102, 241, 0.05);
}
.drop-zone input { display: none; }
.drop-zone p { color: var(--text-dim); font-size: 0.9rem; }
.drop-zone .accepted { font-size: 0.75rem; color: var(--text-dim); margin-top: 0.5rem; }

/* File list */
.file-list { margin-top: 1rem; }
.file-item {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.5rem 0; border-bottom: 1px solid rgba(99, 102, 241, 0.06);
}
.file-thumb { width: 48px; height: 48px; object-fit: cover; border-radius: 2px; background: var(--deep); }
.file-name { flex: 1; font-size: 0.85rem; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-size { font-size: 0.75rem; color: var(--text-dim); }
.file-remove { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 1.2rem; padding: 0.25rem; }
.file-remove:hover { color: var(--error); }

/* Progress */
.progress-bar { width: 100%; height: 4px; background: var(--deep); border-radius: 2px; overflow: hidden; margin-top: 1rem; }
.progress-fill { height: 100%; background: var(--accent); transition: width 0.3s; width: 0%; }
.progress-status { font-size: 0.85rem; color: var(--text-dim); margin-top: 0.5rem; }

/* Success */
.upload-success { text-align: center; padding: 3rem 0; }
.upload-success h2 { font-family: var(--serif); font-size: 1.8rem; font-weight: 300; color: var(--text-bright); margin-bottom: 0.75rem; }
.upload-success a { color: var(--accent); }

footer {
  padding: 2.5rem 0; border-top: 1px solid rgba(99, 102, 241, 0.08); margin-top: auto;
}
.footer-inner {
  display: flex; align-items: center; justify-content: space-between;
  max-width: 720px; margin: 0 auto; padding: 0 2rem; font-size: 0.8rem; color: var(--text-dim);
}
.footer-wordmark { font-family: var(--serif); font-weight: 300; letter-spacing: 0.1em; color: var(--text); }
footer a { color: var(--text-dim); text-decoration: none; transition: color 0.3s; }
footer a:hover { color: var(--glow); }

@media (max-width: 540px) {
  nav { padding: 1rem 1.25rem; }
  .container { padding: 0 1.25rem; }
  .drop-zone { padding: 2rem 1rem; }
}
</style>
</head>
<body>

<nav>
  <a href="/" class="wordmark">astra.gallery</a>
  <ul class="nav-links">
    <li><a href="/explore">Explore</a></li>
    <li><a href="/upload" class="active">Upload</a></li>
    ${authNavItem()}
  </ul>
</nav>

<section class="page-header">
  <div class="container">
    <h1>Upload</h1>
    <p class="subtitle">Share your astrophotography with the world</p>
  </div>
</section>

<section class="upload-section">
  <div class="container">
    <div id="auth-gate">
      <p>Sign in to upload your astrophotography</p>
      <a href="/auth/callback?return=/upload" class="btn btn-primary">Sign In</a>
    </div>

    <div id="upload-app">
      <div id="upload-form">
        <div class="form-group">
          <label>Gallery</label>
          <div style="display: flex; gap: 0.5rem;">
            <select class="form-input" id="gallery-select" style="flex: 1;">
              <option value="_new">+ Create new gallery</option>
            </select>
          </div>
        </div>

        <div class="form-group" id="new-gallery-fields">
          <label>Gallery Name</label>
          <input type="text" class="form-input" id="gallery-name" placeholder="e.g., Orion Nebula Collection" />
        </div>

        <div class="form-group">
          <label>Images</label>
          <div class="drop-zone" id="drop-zone">
            <p>Drop images here or click to browse</p>
            <p class="accepted">JPEG, PNG, TIFF, FITS accepted (max 50MB each)</p>
            <input type="file" id="file-input" multiple accept=".jpg,.jpeg,.png,.tiff,.tif,.fit,.fits" />
          </div>
          <div class="file-list" id="file-list"></div>
        </div>

        <div style="display: flex; gap: 1rem; align-items: center;">
          <button class="btn btn-primary" id="upload-btn" disabled>Upload</button>
          <span id="file-count" style="font-size: 0.85rem; color: var(--text-dim);"></span>
        </div>

        <div class="progress-bar" id="progress-bar" style="display: none;">
          <div class="progress-fill" id="progress-fill"></div>
        </div>
        <p class="progress-status" id="progress-status"></p>
      </div>

      <div id="upload-success" class="upload-success" style="display: none;">
        <h2>Published!</h2>
        <p style="color: var(--text-dim); margin-bottom: 1rem;">Your gallery is live at:</p>
        <p><a id="gallery-link" href="#" target="_blank"></a></p>
        <p style="margin-top: 2rem;"><button class="btn btn-ghost" onclick="location.reload()">Upload More</button></p>
      </div>
    </div>
  </div>
</section>

<footer>
  <div class="footer-inner">
    <span class="footer-wordmark">astra.gallery</span>
    <span style="font-size: 0.75rem;">Powered by <a href="/">Astra</a></span>
  </div>
</footer>

<script>
(function() {
  const API_BASE = '';
  let apiToken = null;
  let selectedFiles = [];

  // DOM refs
  const authGate = document.getElementById('auth-gate');
  const uploadApp = document.getElementById('upload-app');
  const gallerySelect = document.getElementById('gallery-select');
  const newGalleryFields = document.getElementById('new-gallery-fields');
  const galleryNameInput = document.getElementById('gallery-name');
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const fileList = document.getElementById('file-list');
  const fileCount = document.getElementById('file-count');
  const uploadBtn = document.getElementById('upload-btn');
  const progressBar = document.getElementById('progress-bar');
  const progressFill = document.getElementById('progress-fill');
  const progressStatus = document.getElementById('progress-status');
  const uploadForm = document.getElementById('upload-form');
  const uploadSuccess = document.getElementById('upload-success');
  const galleryLink = document.getElementById('gallery-link');

  // Check for saved token (set by /auth/callback)
  const savedToken = localStorage.getItem('astra_api_token');
  const savedExpiry = localStorage.getItem('astra_token_expires');
  if (savedToken && savedExpiry && new Date(savedExpiry) > new Date()) {
    apiToken = savedToken;
    showUploadUI();
  }

  // Gallery selector
  gallerySelect.addEventListener('change', function() {
    newGalleryFields.style.display = gallerySelect.value === '_new' ? '' : 'none';
  });

  // Drop zone
  dropZone.addEventListener('click', function() { fileInput.click(); });
  dropZone.addEventListener('dragover', function(e) { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', function() { dropZone.classList.remove('dragover'); });
  dropZone.addEventListener('drop', function(e) {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    addFiles(Array.from(e.dataTransfer.files));
  });
  fileInput.addEventListener('change', function() {
    addFiles(Array.from(fileInput.files));
    fileInput.value = '';
  });

  function addFiles(files) {
    const validExts = ['jpg', 'jpeg', 'png', 'tiff', 'tif', 'fit', 'fits'];
    for (const file of files) {
      const ext = file.name.split('.').pop().toLowerCase();
      if (!validExts.includes(ext)) continue;
      if (file.size > 50 * 1024 * 1024) continue;
      if (selectedFiles.some(f => f.name === file.name && f.size === file.size)) continue;
      selectedFiles.push(file);
    }
    renderFileList();
  }

  function renderFileList() {
    fileList.innerHTML = '';
    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i];
      const item = document.createElement('div');
      item.className = 'file-item';
      const sizeMB = (file.size / 1024 / 1024).toFixed(1);
      item.innerHTML =
        '<span class="file-name">' + escapeHtml(file.name) + '</span>' +
        '<span class="file-size">' + sizeMB + ' MB</span>' +
        '<button class="file-remove" data-idx="' + i + '">&times;</button>';
      fileList.appendChild(item);
    }

    fileCount.textContent = selectedFiles.length > 0
      ? selectedFiles.length + ' file' + (selectedFiles.length === 1 ? '' : 's') + ' selected'
      : '';
    uploadBtn.disabled = selectedFiles.length === 0;
  }

  fileList.addEventListener('click', function(e) {
    if (e.target.classList.contains('file-remove')) {
      const idx = parseInt(e.target.dataset.idx);
      selectedFiles.splice(idx, 1);
      renderFileList();
    }
  });

  // Upload
  uploadBtn.addEventListener('click', async function() {
    if (selectedFiles.length === 0) return;

    uploadBtn.disabled = true;
    progressBar.style.display = '';
    progressFill.style.width = '0%';

    try {
      // Resolve gallery
      let shareId, slug, galleryUrl;

      if (gallerySelect.value === '_new') {
        const name = galleryNameInput.value.trim();
        if (!name) { alert('Enter a gallery name'); uploadBtn.disabled = false; return; }

        progressStatus.textContent = 'Creating gallery...';
        const resp = await fetch(API_BASE + '/api/galleries', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiToken },
          body: JSON.stringify({ name }),
        });
        if (!resp.ok) { throw new Error((await resp.json()).error || 'Failed to create gallery'); }
        const data = await resp.json();
        shareId = data.shareId;
        slug = data.slug;
        galleryUrl = data.publicUrl;
      } else {
        const opt = gallerySelect.options[gallerySelect.selectedIndex];
        shareId = gallerySelect.value;
        slug = opt.dataset.slug;
        galleryUrl = opt.dataset.url;
      }

      progressStatus.textContent = 'Generating thumbnails...';
      progressFill.style.width = '5%';

      // Build file list for presign
      const presignFiles = [];
      const fileData = []; // { key, contentType, blob }

      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];
        const ext = file.name.split('.').pop().toLowerCase();
        const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        const imageKey = 'images/' + id + '.' + ext;
        const thumbKey = 'thumbs/' + id + '.jpg';

        presignFiles.push({ key: imageKey, contentType: file.type || 'application/octet-stream', size: file.size });
        fileData.push({ key: imageKey, contentType: file.type || 'application/octet-stream', blob: file, id, filename: file.name });

        // Generate thumbnail for image types
        if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
          try {
            const thumbBlob = await generateThumbnail(file, 300);
            presignFiles.push({ key: thumbKey, contentType: 'image/jpeg', size: thumbBlob.size });
            fileData.push({ key: thumbKey, contentType: 'image/jpeg', blob: thumbBlob, id: id + '_thumb' });
          } catch(e) { /* skip thumbnail */ }
        }
      }

      // Add cover.jpg (first image's thumbnail)
      if (selectedFiles.length > 0 && ['jpg', 'jpeg', 'png', 'webp'].includes(selectedFiles[0].name.split('.').pop().toLowerCase())) {
        try {
          const coverBlob = await generateThumbnail(selectedFiles[0], 300);
          presignFiles.push({ key: 'cover.jpg', contentType: 'image/jpeg', size: coverBlob.size });
          fileData.push({ key: 'cover.jpg', contentType: 'image/jpeg', blob: coverBlob });
        } catch(e) { /* skip cover */ }
      }

      // Build and add manifest
      const manifestImages = fileData
        .filter(f => f.key.startsWith('images/'))
        .map(f => ({
          id: f.id,
          filename: f.filename || f.key,
          contentType: f.contentType,
          imagePath: f.key,
          thumbPath: 'thumbs/' + f.id + '.jpg',
          createdAt: new Date().toISOString(),
          favorite: false,
          catalogIds: [],
        }));
      const manifest = {
        version: 1,
        collectionName: galleryNameInput.value.trim() || 'Untitled Gallery',
        imageCount: manifestImages.length,
        updatedAt: new Date().toISOString(),
        images: manifestImages,
      };
      const manifestBlob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
      presignFiles.push({ key: 'manifest.json', contentType: 'application/json', size: manifestBlob.size });
      fileData.push({ key: 'manifest.json', contentType: 'application/json', blob: manifestBlob });

      // Add viewer HTML (fetch from a known gallery or embed)
      // For simplicity, we add a redirect to the viewer
      const viewerHtml = '<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=https://astra.gallery/@' + encodeURIComponent(localStorage.getItem('astra_username') || '') + '/' + encodeURIComponent(slug) + '"></head></html>';
      const viewerBlob = new Blob([viewerHtml], { type: 'text/html' });
      presignFiles.push({ key: 'index.html', contentType: 'text/html', size: viewerBlob.size });
      fileData.push({ key: 'index.html', contentType: 'text/html', blob: viewerBlob });

      progressStatus.textContent = 'Getting upload URLs...';
      progressFill.style.width = '10%';

      // Request presigned URLs
      const presignResp = await fetch(API_BASE + '/api/presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiToken },
        body: JSON.stringify({
          shareId,
          collectionSlug: slug,
          collectionName: manifest.collectionName,
          files: presignFiles,
        }),
      });
      if (!presignResp.ok) { throw new Error((await presignResp.json()).error || 'Presign failed'); }
      const presign = await presignResp.json();

      // Upload files
      const total = fileData.length;
      for (let i = 0; i < fileData.length; i++) {
        const fd = fileData[i];
        const uploadInfo = presign.uploads.find(function(u) { return u.key === fd.key; });
        if (!uploadInfo) continue;

        progressStatus.textContent = 'Uploading ' + (i + 1) + '/' + total + '...';
        progressFill.style.width = (10 + (i / total) * 85) + '%';

        await fetch(uploadInfo.presignedUrl, {
          method: 'PUT',
          headers: { 'Content-Type': fd.contentType },
          body: fd.blob,
        });
      }

      progressFill.style.width = '100%';
      progressStatus.textContent = 'Done!';

      // Show success
      uploadForm.style.display = 'none';
      uploadSuccess.style.display = '';
      galleryLink.href = galleryUrl;
      galleryLink.textContent = galleryUrl;

    } catch (err) {
      progressStatus.textContent = 'Error: ' + err.message;
      progressFill.style.width = '0%';
      uploadBtn.disabled = false;
    }
  });

  async function showUploadUI() {
    authGate.style.display = 'none';
    uploadApp.style.display = '';

    // Load user's galleries
    try {
      const resp = await fetch(API_BASE + '/api/galleries', {
        headers: { 'Authorization': 'Bearer ' + apiToken },
      });
      if (resp.ok) {
        const data = await resp.json();
        for (const g of data.galleries) {
          const opt = document.createElement('option');
          opt.value = g.shareId;
          opt.textContent = g.name;
          opt.dataset.slug = g.slug;
          opt.dataset.url = g.publicUrl;
          gallerySelect.appendChild(opt);
        }
      }
    } catch(e) { /* gallery list load failed, that's ok */ }
  }

  function generateThumbnail(file, maxDim) {
    return new Promise(function(resolve, reject) {
      const img = new Image();
      img.onload = function() {
        let w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
          else { w = Math.round(w * maxDim / h); h = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob(function(blob) {
          if (blob) resolve(blob); else reject(new Error('toBlob failed'));
        }, 'image/jpeg', 0.8);
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
})();
</script>

${authNavScript()}

</body>
</html>`;
}

export { uploadRoutes };
