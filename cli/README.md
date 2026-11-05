# astra-cli

Upload stacked images to an Astra server from the command line, or watch a
folder (a Seestar's `MyWorks`, an ASI Air share, a SharpCap output
directory) and upload stacked frames as they appear.

```
cargo install --path cli            # or: just cli-install
astra-cli login --server https://astra.gallery
astra-cli upload -c "Seestar" -t seestar,m42 ~/seestar/MyWorks/M\ 42/Stacked_120_M\ 42.fit
astra-cli upload -r -c "ASI Air" /mnt/asiair/Autorun
astra-cli watch --poll 30 -c "Seestar" /mnt/seestar/MyWorks
```

## Signing in

Mint a personal access token in the web app (Settings → Account →
Personal access tokens) and paste it at the `login` prompt. The token is
stored with mode 0600 in `$XDG_CONFIG_HOME/astra-cli/config.toml`.
`ASTRA_SERVER` / `ASTRA_TOKEN` (or `--server` / `--token`) override the
saved login for one invocation — handy for a systemd unit.

A token that leaks cannot mint or revoke tokens: the token routes refuse
PAT callers, so revoke it from the browser.

## What gets uploaded

Explicit file arguments are always uploaded. Directories are filtered to
**stacked images** using the desktop importer's rules: files in a
`Stacked/` directory, `Stack_*` / `Stacked_*` names, or "stacked" in the
name; `.fit/.fits/.fts/.xisf/.jpg/.png/.tif`. Calibration frames, raw
subframes (`Light_*`, `frame_*`, Seestar `*_sub/`) and Seestar `_thn.jpg`
thumbnails are skipped. `--all` widens this to every image that is not a
calibration frame or subframe.

Options on `upload` and `watch`:

| Flag | Effect |
|---|---|
| `-c, --collection NAME` | File images under this collection, created on first use (case-insensitive match on your existing collections). |
| `--collection-id ID` | Same, by id. |
| `-t, --tags a,b` | Comma-separated tags on every image. |
| `--summary`, `--description` | Set on every image. Left blank, a FITS upload gets its `OBJECT` header (or the target directory name) as summary and "10.0s exposure, 20 frames stacked, Filter: LP" as description. |
| `--visibility` | `private` (default), `unlisted`, `public`. |
| `--all` | Accept any image file in directories, not only stacked ones. |
| `-n, --dry-run` | List what would be sent. |
| `--force` | Ignore the local ledger (the server still dedups identical bytes). |

## Idempotence

Two layers keep repeats harmless:

- A local ledger (`$XDG_STATE_HOME/astra-cli/ledger.json`) records each
  uploaded path with its size and mtime, so a restarted watch does not
  re-hash or re-send.
- The server registers images by content hash: identical bytes map to the
  existing image, which is only (re)linked into the requested collection.

## Watching

`watch` sweeps the directory once on start (skip with `--no-initial`),
then uploads a file after it has gone `--settle` seconds (default 15)
without events and with an unchanged size. On SMB/NFS mounts, where
inotify never sees the other host's writes, use `--poll SECS`.

A systemd user unit:

```
[Service]
Environment=ASTRA_SERVER=https://astra.gallery
Environment=ASTRA_TOKEN=astra_…
ExecStart=%h/.cargo/bin/astra-cli watch --poll 30 -c Seestar /mnt/seestar/MyWorks
Restart=on-failure
```
