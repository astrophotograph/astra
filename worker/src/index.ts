import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./lib/types";
import { downloadRoutes } from "./routes/downloads";

// Retired to a downloads CDN (2026-08): the hosted service lives on the
// daemon behind the tunnel; this worker keeps only `/downloads/*` (tetra3
// databases + installers on R2 free egress). The zone route in
// wrangler.jsonc scopes it — everything else on the domain reaches the
// daemon. Old gallery/social/auth routes live in git history.
const app = new Hono<{ Bindings: Env }>();

// CORS for downloads (tetra3 databases, etc.)
app.use(
  "/downloads/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "OPTIONS"],
  })
);

// Static downloads (tetra3 databases, etc.)
app.route("/", downloadRoutes);

export default app;
