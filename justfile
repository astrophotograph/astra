# Astra build & dev tasks

# Python for PyO3. An exported PYO3_PYTHON wins; otherwise the first
# interpreter that exists, preferring Linuxbrew 3.12 (the historical dev
# setup), then the system 3.12/3.13 (Debian python3-dev ships headers and
# libpython in the linker path), then whatever python3 is on PATH.
export PYO3_PYTHON := env_var_or_default("PYO3_PYTHON", `for p in /home/linuxbrew/.linuxbrew/bin/python3.12 /usr/bin/python3.12 /usr/bin/python3.13 /usr/bin/python3; do if [ -x "$p" ]; then echo "$p"; exit 0; fi; done; command -v python3.12 || command -v python3.13 || command -v python3`)
# Linuxbrew's libpython dir, for the Linuxbrew interpreter above. Harmless
# when the directory does not exist (the dynamic linker skips it).
export LD_LIBRARY_PATH := "/home/linuxbrew/.linuxbrew/opt/python@3.12/lib:" + env_var_or_default("LD_LIBRARY_PATH", "")

# System pkg-config (Linuxbrew otherwise hides /usr/lib pkgconfig)
export PKG_CONFIG_PATH := "/usr/lib/x86_64-linux-gnu/pkgconfig:" + env_var_or_default("PKG_CONFIG_PATH", "")

# Wayland/X11 display for xdg-open (browser launching from Tauri)
export WAYLAND_DISPLAY := env_var_or_default("WAYLAND_DISPLAY", "wayland-0")
export XDG_RUNTIME_DIR := env_var_or_default("XDG_RUNTIME_DIR", "/run/user/" + `id -u`)

# Deployment unit files: deploy/ holds sanitized templates; point this at a
# private directory (e.g. via the gitignored .env) for real units.
set dotenv-load := true

deploy_dir := env_var_or_default("ASTRA_DEPLOY_DIR", "deploy")

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

# Build the astra-cli uploader (release) → cli/target/release/astra-cli
cli-build:
    cd cli && cargo build --release

# Install astra-cli into ~/.cargo/bin
cli-install:
    cargo install --path cli --locked

# Run astra-cli from source. Args: e.g. upload -c Seestar ~/MyWorks
cli *ARGS:
    cd cli && cargo run --quiet -- {{ARGS}}

# Test the astra-cli crate
test-cli:
    cd cli && cargo test

# Rebuild the release daemon + web bundle and deploy them plus lexicons/ (as
# /var/lib/astra/data/lexicons, for signed publishing) into the `astra` Incus
# VM (hekaton). Build happens here (glibc-compatible Debian 13 on both ends);
# the VM never needs a toolchain.
deploy-staging:
    cd src-tauri && cargo build --release --bin astra_daemon
    pnpm build:web
    incus file push src-tauri/target/release/astra_daemon astra/opt/astra/bin/astra_daemon.new --mode 0755
    incus exec astra -- mv /opt/astra/bin/astra_daemon.new /opt/astra/bin/astra_daemon
    incus exec astra -- rm -rf /var/lib/astra/data/dist-web
    incus file push -r --quiet dist-web astra/var/lib/astra/data/
    incus exec astra -- sh -c 'rm -rf /var/lib/astra/data/web && mv /var/lib/astra/data/dist-web /var/lib/astra/data/web && chown -R astra:astra /var/lib/astra/data/web'
    incus exec astra -- sh -c 'rm -rf /var/lib/astra/data/lexicons.new && mkdir /var/lib/astra/data/lexicons.new'
    incus file push -r --quiet lexicons astra/var/lib/astra/data/lexicons.new/
    incus exec astra -- sh -c 'rm -rf /var/lib/astra/data/lexicons && mv /var/lib/astra/data/lexicons.new/lexicons /var/lib/astra/data/lexicons && rmdir /var/lib/astra/data/lexicons.new && chown -R astra:astra /var/lib/astra/data/lexicons'
    incus file push {{deploy_dir}}/astra-daemon.service {{deploy_dir}}/astra-tunnel.service astra/etc/systemd/system/ --mode 0644
    incus exec astra -- sh -c 'systemctl daemon-reload && systemctl enable astra-daemon astra-tunnel >/dev/null 2>&1; systemctl restart astra-daemon astra-tunnel'
    sleep 3 && curl -sf https://staging.astra.gallery/healthz && echo

# Status of the staging daemon + tunnel units
daemon-status:
    incus exec astra -- systemctl status astra-daemon astra-tunnel --no-pager || true

# Follow the staging daemon + tunnel journals
daemon-logs:
    incus exec astra -- journalctl -u astra-daemon -u astra-tunnel -f

# Run Rust tests
test-rust:
    cd src-tauri && cargo test

# Run Python tests
test-py:
    cd python && uv run pytest

# Run all tests
test: test-rust test-py test-cli

# Trigger a CalVer release. Args: --dry-run, --local, or explicit version (e.g. 2026.5.0)
release *ARGS:
    ./scripts/release.sh {{ARGS}}

# Clean Rust build artifacts
clean:
    cd src-tauri && cargo clean
