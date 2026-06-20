# Astra

Desktop astrophotography observation log and gallery sharing app. Catalog imaging sessions, manage equipment, and publish collections to astra.gallery.

## Build & Dev

Use `just` for all common tasks (`just --list` shows recipes). The justfile sets the env vars PyO3 needs at runtime (libpython, pkg-config, Wayland), so prefer it over invoking `pnpm tauri dev` directly.

```bash
just dev         # Full Tauri desktop app in dev mode
just dev-web     # Vite frontend dev server only
just build       # Build desktop binary (release)
just deploy      # Deploy Cloudflare Worker (astra.gallery)
just py-sync     # Sync Python deps via uv
just check       # Frontend build + cargo check
just test        # Rust + Python tests
just release     # CalVer release (wraps scripts/release.sh)
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
- To check task status and dependencies, use the **targeted query tools** (NOT `get_database`, which is too large):
  - `mcp__nous__task_summary` — cheapest: task counts by project/status/feature
  - `mcp__nous__query_tasks` — filtered queries with compact rows (by project, feature, status, phase, priority, blocked state)
  - `mcp__nous__get_feature_tasks` — tasks for a project/feature in dependency-resolved execution order
- Update task status via `mcp__nous__update_task_status` — pass the task name; it looks up the row, updates Status + Completed date, syncs page tags, fires the webhook, and optionally appends implementation notes via `notes=`. Same call accepts `external_ref`, `execution_mode`, `model_tier`, `estimate`, `complexity`, `task_type`, `max_files`, `requires_tests`. Avoid `mcp__nous__update_database_rows` for tasks — it's the slow path that requires a row-UUID lookup.
- Feature pages in Forge contain the full context: data model, API contracts, edge cases, test plans

Do NOT use `mcp__nous__get_database` on the Project Tasks database — it returns too much data. Use the targeted query tools above.

Do NOT create ad-hoc task tracking internally — all task state lives in Forge.
