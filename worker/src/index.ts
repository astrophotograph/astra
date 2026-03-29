import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./lib/types";
import { landingRoutes } from "./routes/landing";
import { galleryRoutes } from "./routes/gallery";
import { authRoutes } from "./routes/auth";
import { presignRoutes } from "./routes/presign";
import { downloadRoutes } from "./routes/downloads";

const app = new Hono<{ Bindings: Env }>();

// CORS for desktop app
app.use(
  "/api/*",
  cors({
    origin: ["http://localhost:1420", "http://127.0.0.1:1420", "tauri://localhost"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// API routes
app.route("/api/auth", authRoutes);
app.route("/api", presignRoutes);

// Static downloads (tetra3 databases, etc.)
app.route("/", downloadRoutes);

// Gallery routes (serves shares and user profiles)
app.route("/", galleryRoutes);

// Landing page (must be last — catches /)
app.route("/", landingRoutes);

export default app;
