#!/bin/bash
# Run Tauri dev with Python 3.12 (more stable than 3.14)

# Use Python 3.12 for PyO3
export PYO3_PYTHON="/home/linuxbrew/.linuxbrew/bin/python3.12"

# Set library path for Python 3.12
export LD_LIBRARY_PATH="/home/linuxbrew/.linuxbrew/Cellar/python@3.12/3.12.12/lib:$LD_LIBRARY_PATH"

exec pnpm tauri dev "$@"
