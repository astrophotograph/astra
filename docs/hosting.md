# Hosting: staging.astra.gallery

The hosted Astra service is the desktop backend running as a daemon
(`astra_daemon`, an axum HTTP server over the same SQLite + HoardFS stack),
exposed through a dedicated Cloudflare Tunnel.

## Topology

```
browser ──► Cloudflare edge (staging.astra.gallery, proxied CNAME)
                │
                ▼
        cloudflared "astra-staging" tunnel      (astra-tunnel.service)
                │  ~/.cloudflared/astra-staging.yml
                ▼
        astra_daemon on 127.0.0.1:27872          (astra-daemon.service)
                │
                ▼
        ~/.local/share/com.erewhon.astra/  (astra.db + hoardfs/)
```

- Both services are **user** systemd units (lingering is enabled, so they
  start at boot without a login).
- The tunnel is deliberately **separate** from the production
  `/etc/cloudflared/config.yml` ingress (bcc.sh services) running on the
  same host — astra staging can restart or break without touching that.
- The desktop app and the daemon share `astra.db` safely: every connection
  runs WAL with a busy timeout (see `src-tauri/src/daemon/mod.rs` docs for
  the one-writer convention).

## Public surface

| Route | Auth | Notes |
|---|---|---|
| `/healthz` | none | version + db/hoardfs status |
| `/@user`, `/@user/slug`, assets | none | published collections only |
| `/api/*` | bearer (PAT or OIDC JWT) | default-deny |

## Operations

```bash
just deploy-staging   # rebuild release daemon, install + restart both units
just daemon-status    # systemctl --user status for daemon + tunnel
just daemon-logs      # follow both journals

systemctl --user restart astra-daemon astra-tunnel
journalctl --user -u astra-daemon -n 100   # daemon log
journalctl --user -u astra-tunnel -n 100   # tunnel log
```

## Pieces and where they live

| Piece | Location |
|---|---|
| Unit files (source of truth) | `deploy/*.service` in this repo |
| Installed units | `~/.config/systemd/user/` |
| Tunnel config | `~/.cloudflared/astra-staging.yml` |
| Tunnel credentials | `~/.cloudflared/35f84ad7-….json`; backup: `ho secret get astra/tunnel-credentials` |
| Tunnel id | `35f84ad7-9821-4c5d-8f04-d56fb8246a70` (`cloudflared tunnel list`) |
| DNS | `staging.astra.gallery` proxied CNAME → `<tunnel-id>.cfargotunnel.com` (astra.gallery zone) |
| Daemon data | the desktop app's data dir (`~/.local/share/com.erewhon.astra`) |

## Gotchas

- The `cloudflared` cert (`~/.cloudflared/cert.pem`) is scoped to
  middlefork.org, so `cloudflared tunnel route dns` lands in the wrong
  zone — manage the astra.gallery DNS record via the Cloudflare API
  (`ho secret get cloudflare/provisioning-token`) instead.
- The daemon binary links libpython (PyO3); the unit sets
  `LD_LIBRARY_PATH` to the Linuxbrew `opt/python@3.12/lib` symlink. Use
  `opt/`, never a `Cellar/<version>` path.
- OIDC session auth is off until the Zitadel app exists — the commented
  `ASTRA_OIDC_*` lines in `deploy/astra-daemon.service` turn it on. PATs
  (`astra_daemon --mint-token`) work regardless.
