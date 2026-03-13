#!/bin/bash
# Run Tauri dev with Python 3.12 (more stable than 3.14)

# Use Python 3.12 for PyO3
export PYO3_PYTHON="/home/linuxbrew/.linuxbrew/bin/python3.12"

# Set library path for Python 3.12
export LD_LIBRARY_PATH="/home/linuxbrew/.linuxbrew/Cellar/python@3.12/3.12.12/lib:$LD_LIBRARY_PATH"

# Ensure system pkg-config path is included (Linuxbrew overrides it)
export PKG_CONFIG_PATH="/usr/lib/x86_64-linux-gnu/pkgconfig:${PKG_CONFIG_PATH}"

# Ensure Wayland/X11 display is set for xdg-open (browser launching)
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

exec pnpm tauri dev "$@"
