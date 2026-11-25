"""Test configuration."""

import os
import tempfile

# matplotlib needs a writable cache dir; the workspace should stay clean, so use
# a per-machine temp directory (matplotlib creates it if missing).
os.environ.setdefault(
    "MPLCONFIGDIR", os.path.join(tempfile.gettempdir(), "astra-mplcache")
)
