# Astra

Astronomy observation log. Track imaging sessions, organize collections, and share galleries to [astra.gallery](https://astra.gallery).

**Astra is currently in beta.** Expect rough edges.

## Download

Pre-built binaries are available on the [releases page](https://github.com/astrophotograph/astra/releases/latest):

| Platform | Format |
|----------|--------|
| macOS (Apple Silicon) | `.dmg` |
| Linux (x64) | `.deb`, `.rpm`, `.AppImage` |

## Features

- **Observation log** — catalog images with metadata, tags, locations, and equipment
- **Collections** — organize images into groups (Messier catalog, sessions, targets)
- **Equipment management** — track telescopes, mounts, cameras, and filters with presets for Seestar smart scopes
- **Location profiles** — save observer locations with horizon profiles
- **Gallery sharing** — publish collections to [astra.gallery](https://astra.gallery) with one click
- **Auto-refreshing galleries** — shared galleries update every 30 seconds while you image
- **FITS support** — preview generation with configurable stretch parameters
- **Automatic backups** — database is backed up on every launch (keeps last 5)

## Gallery

Shared galleries are hosted at [astra.gallery](https://astra.gallery). Sign in from the desktop app, pick a collection, and publish. Galleries are auto-refreshing — share the link at the start of a session and viewers watch it grow.

## License

GNU Affero General Public License v3. See [LICENSE](LICENSE).

---

## Development

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/)
- [uv](https://docs.astral.sh/uv/) (Python package manager)
- Tauri v2 system dependencies ([see docs](https://v2.tauri.app/start/prerequisites/))

### Setup

```sh
pnpm install
cd python && uv sync && cd ..
```

### Run (development)

```sh
pnpm tauri dev
```

### Build

```sh
pnpm tauri build
```

### Gallery viewer

The gallery viewer is a Preact app compiled to a single self-contained HTML file:

```sh
cd viewer
pnpm install
pnpm build    # builds and copies to src-tauri/src/share/viewer.html
```

### Worker (astra.gallery)

The gallery service runs on Cloudflare Workers:

```sh
cd worker
pnpm install
npx wrangler dev      # local development
npx wrangler deploy   # deploy to production
```

### Project structure

```
src/              React frontend (Tauri webview)
src-tauri/        Rust backend (Tauri commands, database, sharing)
python/           Python modules via PyO3 (image processing, plate solving)
viewer/           Gallery viewer (Preact → single HTML file)
worker/           astra.gallery Cloudflare Worker
```
