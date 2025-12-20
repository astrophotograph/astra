import os


def is_hidden(path):
    return os.path.basename(os.fspath(path)).startswith(b'.' if isinstance(os.fspath(path), bytes) else '.')
