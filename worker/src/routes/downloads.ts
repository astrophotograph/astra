import { Hono } from "hono";
import type { Env } from "../lib/types";

const downloadRoutes = new Hono<{ Bindings: Env }>();

/**
 * Serve static downloads from R2 (tetra3 databases, etc.)
 *
 * Files are stored at: downloads/<path> in the R2 bucket
 * Served at: https://astra.gallery/downloads/<path>
 */
downloadRoutes.get("/downloads/:path{.+}", async (c) => {
  const path = c.req.param("path");
  const key = `downloads/${path}`;

  const object = await c.env.GALLERY_BUCKET.get(key);
  if (!object) {
    return c.text("Not Found", 404);
  }

  const headers = new Headers();
  const ext = path.split(".").pop()?.toLowerCase() ?? "";

  // Content type
  const types: Record<string, string> = {
    rkyv: "application/octet-stream",
    bin: "application/octet-stream",
    json: "application/json",
    txt: "text/plain",
  };
  headers.set("Content-Type", types[ext] ?? "application/octet-stream");

  // Cache immutable files aggressively (databases don't change once generated)
  headers.set("Cache-Control", "public, max-age=31536000, immutable");

  // Content-Disposition for binary downloads
  const filename = path.split("/").pop() ?? path;
  headers.set("Content-Disposition", `attachment; filename="${filename}"`);

  // Content-Length if available
  if (object.size) {
    headers.set("Content-Length", object.size.toString());
  }

  object.writeHttpMetadata(headers);

  return new Response(object.body, { headers });
});

/**
 * List available downloads in a category.
 * GET /downloads/tetra3/ → JSON list of available databases
 */
downloadRoutes.get("/downloads/:category/", async (c) => {
  const category = c.req.param("category");
  const prefix = `downloads/${category}/`;

  const listed = await c.env.GALLERY_BUCKET.list({ prefix });

  const files = listed.objects.map((obj) => ({
    name: obj.key.replace(prefix, ""),
    size: obj.size,
    uploaded: obj.uploaded.toISOString(),
  }));

  return c.json({ category, files });
});

export { downloadRoutes };
