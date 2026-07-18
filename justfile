# Astra build & dev tasks

# Python 3.12 for PyO3 (Linuxbrew opt/ symlink — survives patch bumps)
export PYO3_PYTHON := "/home/linuxbrew/.linuxbrew/bin/python3.12"
export LD_LIBRARY_PATH := "/home/linuxbrew/.linuxbrew/opt/python@3.12/lib:" + env_var_or_default("LD_LIBRARY_PATH", "")

# System pkg-config (Linuxbrew otherwise hides /usr/lib pkgconfig)
export PKG_CONFIG_PATH := "/usr/lib/x86_64-linux-gnu/pkgconfig:" + env_var_or_default("PKG_CONFIG_PATH", "")

# Wayland/X11 display for xdg-open (browser launching from Tauri)
export WAYLAND_DISPLAY := env_var_or_default("WAYLAND_DISPLAY", "wayland-0")
export XDG_RUNTIME_DIR := env_var_or_default("XDG_RUNTIME_DIR", "/run/user/" + `id -u`)

# List recipes
default:
    @just --list

# Run the full Tauri desktop app in dev mode
dev *ARGS:
    pnpm tauri dev {{ARGS}}

# Run only the Vite frontend dev server
dev-web:
    pnpm dev

# Browser-app dev server on :5173 (proxies /api to the local daemon)
dev-app:
    pnpm dev:web

# Build the desktop binary (release)
build:
    pnpm tauri build

# Build only the React frontend
build-web:
    pnpm build

# Build the browser bundle the daemon serves under /app (dist-web/)
build-app:
    pnpm build:web

# Preview Cloudflare Worker locally (builds first)
preview:
    pnpm preview

# Deploy Cloudflare Worker to astra.gallery (builds first)
deploy:
    pnpm deploy

# Sync Python dependencies via uv (dev extra keeps pytest/ruff for test-py)
py-sync:
    cd python && uv sync --extra dev

# Cargo check (frontend dist required by tauri::generate_context)
check:
    pnpm build
    cd src-tauri && cargo check

# Migrate the legacy image library into HoardFS (one-shot). Args: --data-dir <path>
migrate-library *ARGS:
    cd src-tauri && cargo run --release --bin migrate_library -- {{ARGS}}

# Verify migrated images have HoardFS variants (read-only). Args: --data-dir <path>
verify-variants *ARGS:
    cd src-tauri && cargo run --release --bin verify_variants -- {{ARGS}}

# Run the Astra daemon (HTTP service for hosted astra.gallery). Args: --data-dir <path> --bind <addr:port>
daemon *ARGS:
    cd src-tauri && cargo run --release --bin astra_daemon -- {{ARGS}}

# Rebuild the release daemon + web bundle and (re)install + restart the staging units
deploy-staging:
    cd src-tauri && cargo build --release --bin astra_daemon
    pnpm build:web
    rm -rf ~/.local/share/com.erewhon.astra/web
    cp -r dist-web ~/.local/share/com.erewhon.astra/web
    mkdir -p ~/.config/systemd/user
    cp deploy/astra-daemon.service deploy/astra-tunnel.service ~/.config/systemd/user/
    systemctl --user daemon-reload
    systemctl --user enable --now astra-daemon astra-tunnel
    systemctl --user restart astra-daemon astra-tunnel

# Status of the staging daemon + tunnel units
daemon-status:
    systemctl --user status astra-daemon astra-tunnel --no-pager || true

# Follow the staging daemon + tunnel journals
daemon-logs:
    journalctl --user -u astra-daemon -u astra-tunnel -f

# Run Rust tests
test-rust:
    cd src-tauri && cargo test

# Run Python tests
test-py:
    cd python && uv run pytest

# Run all tests
test: test-rust test-py

# Trigger a CalVer release. Args: --dry-run, --local, or explicit version (e.g. 2026.5.0)
release *ARGS:
    ./scripts/release.sh {{ARGS}}

# Clean Rust build artifacts
clean:
    cd src-tauri && cargo clean
