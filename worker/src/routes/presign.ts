/**
 * Presigned URL endpoint for authenticated uploads.
 */

import { Hono } from "hono";
import type { Env, PresignRequest, PresignResponse, ShareRecord } from "../lib/types";
import { requireApiToken } from "../middleware/clerk";
import { generatePresignedPutUrl } from "../lib/r2";

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

  const publicUrl = `https://astra.gallery/@${apiToken.username}/${slug}`;

  const response: PresignResponse = {
    shareId: body.shareId,
    uploads,
    publicUrl,
  };

  return c.json(response);
});

export { presignRoutes };
