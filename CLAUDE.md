# Astra

Desktop astrophotography observation log and gallery sharing app. Catalog imaging sessions, manage equipment, and publish collections to astra.gallery.

## Build & Dev

```bash
pnpm dev              # Vite dev server (frontend only)
pnpm tauri dev        # Full desktop app in dev mode
pnpm tauri build      # Build desktop binary
pnpm build            # Build React frontend
pnpm deploy           # Deploy Cloudflare Worker (astra.gallery)
cd python && uv sync  # Install Python dependencies
```

## Architecture

- **Frontend:** React 19 + TypeScript + Vite + Tailwind CSS
- **Desktop shell:** Tauri 2 (Rust backend)
- **Python bridge:** PyO3 for astronomy operations (astropy, plate solving, image processing)
- **Gallery worker:** Cloudflare Workers at astra.gallery
- **Viewer:** Preact-based single-HTML gallery viewer for sharing
- **Database:** SQLite via Diesel ORM (in Tauri backend)

## Key Paths

- `src/` — React frontend
- `src/pages/` — Main views (Images, Collections)
- `src/contexts/` — LocationContext, EquipmentContext
- `src/utils/` — astronomy-utils, sky-map-utils, catalogs, recommendations
- `src-tauri/src/` — Rust backend
- `src-tauri/src/commands/` — Tauri commands (images, collections, plate_solve, scan, backup, etc.)
- `src-tauri/src/db/` — Diesel models and migrations
- `python/astra_astro/` — Python astronomy modules
- `worker/` — Cloudflare Worker for astra.gallery
- `viewer/` — Preact gallery viewer
- `legacy/` — Archived old codebase (do not modify)

## Conventions

- Use pnpm for frontend, cargo for Rust, uv for Python
- Frontend uses Tailwind CSS — no plain CSS, no component library
- Tauri commands are the bridge between frontend and Rust backend
- Database migrations via Diesel (`diesel migration run`)
- Equipment: telescopes, mounts, cameras, filters, and Seestar presets
- FITS file support for metadata extraction

## Version Control

- Uses **jj** (Jujutsu), not git. Use `jj` commands for all VCS operations.

## Task Management

Task specs and feature specs live in the **Forge** notebook in Nous. When working on a task:

- Use `mcp__nous__get_page` to read the task spec from Forge (e.g., "Task: Real-Time WebGL Stretch Adjustment")
- Use `mcp__nous__get_database` on the "Project Tasks" database in Forge to see status and dependencies
- Update task status via `mcp__nous__update_database_rows` in the Project Tasks database (not internal task tools)
- Feature pages in Forge contain the full context: data model, API contracts, edge cases, test plans

Do NOT create ad-hoc task tracking internally — all task state lives in Forge.
