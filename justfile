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

# Build the desktop binary (release)
build:
    pnpm tauri build

# Build only the React frontend
build-web:
    pnpm build

# Preview Cloudflare Worker locally (builds first)
preview:
    pnpm preview

# Deploy Cloudflare Worker to astra.gallery (builds first)
deploy:
    pnpm deploy

# Sync Python dependencies via uv
py-sync:
    cd python && uv sync

# Cargo check (frontend dist required by tauri::generate_context)
check:
    pnpm build
    cd src-tauri && cargo check

# Migrate the legacy image library into HoardFS (one-shot). Args: --data-dir <path>
migrate-library *ARGS:
    cd src-tauri && cargo run --release --bin migrate_library -- {{ARGS}}

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
