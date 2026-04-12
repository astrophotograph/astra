import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./lib/types";
import { landingRoutes } from "./routes/landing";
import { exploreRoutes } from "./routes/explore";
import { galleryRoutes } from "./routes/gallery";
import { authRoutes } from "./routes/auth";
import { presignRoutes } from "./routes/presign";
import { downloadRoutes } from "./routes/downloads";
import { uploadRoutes } from "./routes/upload";
import { webAuthRoutes } from "./routes/web-auth";
import { socialRoutes } from "./routes/social";
import { listRoutes, listPageRoutes } from "./routes/lists";
import { commentRoutes } from "./routes/comments";

const app = new Hono<{ Bindings: Env }>();

// CORS for desktop app + web UI
app.use(
  "/api/*",
  cors({
    origin: ["http://localhost:1420", "http://127.0.0.1:1420", "tauri://localhost", "https://astra.gallery"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// CORS for downloads (tetra3 databases, etc.)
app.use(
  "/downloads/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "OPTIONS"],
  })
);

// API routes
app.route("/api/auth", authRoutes);
app.route("/api", presignRoutes);
app.route("/api", uploadRoutes);
app.route("/api/social", socialRoutes);
app.route("/api/lists", listRoutes);
app.route("/api/comments", commentRoutes);

// Static downloads (tetra3 databases, etc.)
app.route("/", downloadRoutes);

// Web auth (callback, sign-out)
app.route("/", webAuthRoutes);

// Upload page
app.route("/", uploadRoutes);

// Public list pages
app.route("/", listPageRoutes);

// Discovery & browse
app.route("/", exploreRoutes);

// Gallery routes (serves shares and user profiles)
app.route("/", galleryRoutes);

// Landing page (must be last — catches /)
app.route("/", landingRoutes);

export default app;
