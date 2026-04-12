/**
 * Presigned URL endpoint for authenticated uploads.
 */

import { Hono } from "hono";
import type { Env, GalleryIndexEntry, PresignRequest, PresignResponse, ShareRecord } from "../lib/types";
import { requireApiToken } from "../middleware/clerk";
import { generatePresignedPutUrl } from "../lib/r2";
import { D1NotificationStore } from "../lib/kith";

const presignRoutes = new Hono<{ Bindings: Env }>();

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB per file
const MAX_FILES_PER_REQUEST = 200;

/**
 * POST /api/presign
 * Generate presigned PUT URLs for uploading gallery files to R2.
 * Requires API token.
 */
presignRoutes.post("/presign", requireApiToken, async (c) => {
  const apiToken = c.get("apiToken" as never) as {
    userId: string;
    username: string;
  };

  const body = await c.req.json<PresignRequest>();

  // Validate request
  if (!body.shareId || !body.collectionSlug || !body.collectionName) {
    return c.json({ error: "Missing required fields" }, 400);
  }

  if (!body.files || body.files.length === 0) {
    return c.json({ error: "No files specified" }, 400);
  }

  if (body.files.length > MAX_FILES_PER_REQUEST) {
    return c.json(
      { error: `Maximum ${MAX_FILES_PER_REQUEST} files per request` },
      400
    );
  }

  for (const file of body.files) {
    if (file.size > MAX_FILE_SIZE) {
      return c.json(
        { error: `File ${file.key} exceeds maximum size of 50MB` },
        400
      );
    }
  }

  // Validate slug format
  const slug = body.collectionSlug.toLowerCase().replace(/[^a-z0-9-]/g, "-");

  // Debug: check secret lengths
  console.log("R2_ENDPOINT length:", c.env.R2_ENDPOINT?.length);
  console.log("R2_ACCESS_KEY_ID length:", c.env.R2_ACCESS_KEY_ID?.length);
  console.log("R2_SECRET_ACCESS_KEY length:", c.env.R2_SECRET_ACCESS_KEY?.length);

  // Generate presigned URLs — files go under users/{userId}/{shareId}/
  const uploads: PresignResponse["uploads"] = [];
  const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

  for (const file of body.files) {
    const r2Key = `users/${apiToken.userId}/${body.shareId}/${file.key}`;

    const presignedUrl = await generatePresignedPutUrl(
      c.env.R2_ENDPOINT.trim(),
      "astra-gallery",
      r2Key,
      "auto",
      c.env.R2_ACCESS_KEY_ID.trim(),
      c.env.R2_SECRET_ACCESS_KEY.trim(),
      file.contentType
    );

    uploads.push({
      key: file.key,
      presignedUrl,
      expiresAt,
    });
  }

  // Record the share in KV
  const shareRecord: ShareRecord = {
    userId: apiToken.userId,
    username: apiToken.username,
    collectionSlug: slug,
    collectionName: body.collectionName,
    createdAt: new Date().toISOString(),
  };

  // Store in multiple KV keys for different access patterns
  await c.env.GALLERY_KV.put(
    `shares/${body.shareId}`,
    JSON.stringify(shareRecord)
  );
  await c.env.GALLERY_KV.put(
    `user-shares/${apiToken.userId}/${slug}`,
    JSON.stringify({ ...shareRecord, shareId: body.shareId })
  );

  // Build thumbnail URL — the desktop app uploads cover.jpg alongside other files
  const hasCover = body.files.some(f => f.key === "cover.jpg");
  const thumbnailUrl = hasCover
    ? `https://astra.gallery/shares/${body.shareId}/cover.jpg`
    : undefined;

  // Count actual image files (not thumbs, manifest, etc.)
  const imageCount = body.files.filter(f => f.key.startsWith("images/")).length;

  // Gallery index for explore feed (time-sorted)
  const galleryIndexKey = `gallery-index/${new Date().toISOString()}_${body.shareId}`;
  const indexEntry: GalleryIndexEntry = {
    userId: apiToken.userId,
    username: apiToken.username,
    collectionSlug: body.collectionSlug,
    collectionName: body.collectionName,
    shareId: body.shareId,
    createdAt: new Date().toISOString(),
    thumbnailUrl,
    imageCount: imageCount > 0 ? imageCount : undefined,
    description: body.collectionDescription,
  };
  await c.env.GALLERY_KV.put(galleryIndexKey, JSON.stringify(indexEntry));

  // Object index for browsing by target
  const objectNames = extractObjectNames(body.collectionName);
  for (const objName of objectNames) {
    const normalizedName = normalizeObjectName(objName);
    await c.env.GALLERY_KV.put(`object-index/${normalizedName}/${body.shareId}`, JSON.stringify({
      userId: apiToken.userId,
      username: apiToken.username,
      collectionSlug: body.collectionSlug,
      collectionName: body.collectionName,
      shareId: body.shareId,
    }));
  }

  const publicUrl = `https://astra.gallery/@${apiToken.username}/${slug}`;

  // Emit notifications to subscribers (fire-and-forget)
  c.executionCtx.waitUntil((async () => {
    try {
      const notifs = new D1NotificationStore(c.env.SOCIAL_DB);
      const payload = {
        shareId: body.shareId,
        galleryName: body.collectionName,
        galleryUrl: publicUrl,
        username: apiToken.username,
      };

      // Notify followers of this user
      await notifs.emit(
        apiToken.userId, "user", apiToken.userId,
        "new_gallery", payload
      );

      // Notify followers of each catalog object
      for (const objName of objectNames) {
        const normalized = normalizeObjectName(objName);
        await notifs.emit(
          apiToken.userId, "object", normalized,
          "new_gallery", payload
        );
      }
    } catch (e) {
      console.error("Failed to emit notifications:", e);
    }
  })());

  const response: PresignResponse = {
    shareId: body.shareId,
    uploads,
    publicUrl,
  };

  return c.json(response);
});

function extractObjectNames(collectionName: string): string[] {
  const names: string[] = [];
  // Match Messier: M1, M 42, Messier 42
  const messier = collectionName.match(/\b(M\s?\d{1,3}|Messier\s?\d{1,3})\b/gi);
  if (messier) names.push(...messier);
  // Match NGC: NGC1234, NGC 1234
  const ngc = collectionName.match(/\bNGC\s?\d{1,5}\b/gi);
  if (ngc) names.push(...ngc);
  // Match IC: IC1234, IC 1234
  const ic = collectionName.match(/\bIC\s?\d{1,5}\b/gi);
  if (ic) names.push(...ic);
  // Match Sharpless: Sh2-123, SH2 123
  const sh = collectionName.match(/\bSh2[\s-]?\d{1,3}\b/gi);
  if (sh) names.push(...sh);
  // If no catalog IDs found, use the full name as-is
  if (names.length === 0) names.push(collectionName);
  return names;
}

function normalizeObjectName(name: string): string {
  let n = name.trim().toLowerCase();
  // Normalize Messier: "m 42", "messier 42" -> "m42"
  n = n.replace(/^messier\s*/i, "m").replace(/^m\s+/i, "m");
  // Normalize NGC: "ngc 1234" -> "ngc1234"
  n = n.replace(/^ngc\s*/i, "ngc");
  // Normalize IC: "ic 1234" -> "ic1234"
  n = n.replace(/^ic\s*/i, "ic");
  // Normalize Sharpless
  n = n.replace(/^sh2[\s-]*/i, "sh2-");
  // Replace spaces with hyphens for URL friendliness
  n = n.replace(/\s+/g, "-");
  return n;
}

export { presignRoutes };
