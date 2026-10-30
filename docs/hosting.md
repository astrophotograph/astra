# Self-hosting the Astra daemon

The hosted Astra service is the desktop backend running as a daemon
(`astra_daemon`, an axum HTTP server over the same SQLite + HoardFS stack),
typically exposed through a Cloudflare Tunnel so no inbound ports are
opened. This doc describes the generic shape; operator-specific
configuration (real unit files, hostnames, network layout) belongs in your
own private infrastructure repo, not here.

## Topology

```
browser ──► Cloudflare edge (your domain, proxied CNAME)
                │
                ▼
        cloudflared tunnel                       (astra-tunnel.service)
                │  /etc/cloudflared/config.yml
                ▼
        astra_daemon on 127.0.0.1:27872          (astra-daemon.service)
                │
                ▼
        $ASTRA_DATA_DIR  (astra.db + hoardfs/ + web/)
```

Run both as **system units under dedicated non-login users** (`astra`,
`cloudflared`) — never as your login user for an internet-facing service.
The templates in `deploy/` carry a full systemd hardening block
(ProtectSystem=strict, NoNewPrivileges, syscall filter, empty capability
set); start from those. For extra isolation, run the whole pair inside a
dedicated VM with egress filtering so a compromise can't move laterally.

## Daemon requirements

- The binary is nearly static (libc/libm/libgcc only — the Python bridge
  is desktop-only and links out), so building on a glibc-compatible host
  and copying the binary works.
- `ASTRA_DATA_DIR` must be writable by the `astra` user; the web bundle
  is served from `$ASTRA_DATA_DIR/web` and must exist **at startup** for
  the `/` and `/app` routes to mount.
- If your library references original files by absolute path (external
  refs), those paths must resolve wherever the daemon runs — mount them
  read-only.
- OIDC (`ASTRA_OIDC_ISSUER` + `ASTRA_OIDC_CLIENT_ID`, a public PKCE SPA
  client) enables browser sessions; without it only personal access
  tokens (`astra_daemon --mint-token`) authenticate. JWT validation needs
  a sane clock — enable systemd-timesyncd in minimal VM images.

## Public surface

| Route | Auth | Notes |
|---|---|---|
| `/healthz` | none | version + db/hoardfs status |
| `/@user`, `/@user/slug`, assets | none | published collections only |
| `/at/{did}/{collection}/{rkey}` | none | 302 to the gallery for a stored signed record |
| `/api/*` | bearer (PAT or OIDC JWT) | default-deny |

## Deploying

`just deploy-staging` builds the release daemon + web bundle and pushes
them into the maintainer's staging VM (Incus), swapping the binary via
push-to-temp + rename (overwriting a running binary in place fails with
"text file busy"). Unit files are pushed from `$ASTRA_DEPLOY_DIR`
(default `deploy/`), so real, environment-specific units can live outside
the repo — set it in a gitignored `.env`.

```bash
just deploy-staging   # build → push binary/web/units → restart → healthz
just daemon-status    # unit status inside the VM
just daemon-logs      # follow both journals
```

## Signed publishing (kenning records)

With a signing key configured, every publish and every re-push/sync writes
the collection as AT Protocol records — one `gallery.astra.collection`
plus one `gallery.astra.image` per image (`lexicons/`), validated against
the lexicons, signed with the daemon's app key, and stored verbatim. The
public gallery then serves the stored, signed JSON instead of synthesising
a manifest from the database on every request, so a viewer (or anyone)
can check that a gallery really is the author's. Without the key the
daemon behaves exactly as before (live `manifest.json`), and logs once at
startup that signed publishing is disabled.

| Env | Meaning |
|---|---|
| `ASTRA_SIGNING_KEY_SOURCE` | Where the app key lives, in kenning `KeySource` form: `ho:<name>` (homelab secret store), `file:<path>` (multikey string, mode 0600) or `env:<VAR>`. Unset → disabled. Set but unloadable → the daemon refuses to start. |
| `ASTRA_SIGNING_METHOD_ID` | Verification method id the key is registered under in the author's DID document. Default `astra`. |
| `ASTRA_LEXICONS_DIR` | Directory with the `gallery.astra.*.json` lexicons. Default `$ASTRA_DATA_DIR/lexicons`, falling back to the source checkout's `lexicons/` when running from a build tree. Deploy the repo's `lexicons/` next to `web/` (`just deploy-staging` does not yet copy it). |

### Linking a DID

Records are published under `at://<did>/...`, so each publishing user
needs a DID whose document names the daemon's key under the method id:

1. Generate the daemon's key once (`kenning keygen` → store with
   `ho secret` or a 0600 file) and set `ASTRA_SIGNING_KEY_SOURCE`.
2. Mint the user's `did:plc` with `kenning mint`, adding the daemon's
   public key as verification method `astra` (the `ASTRA_SIGNING_METHOD_ID`).
3. Link it: `PUT /api/me/did {"did": "did:plc:..."}` with the user's
   bearer token. 400 for a malformed DID, 409 if another user already
   holds it.
4. Publish (or re-publish) the collection. The publish response carries
   `"signed": true` and `record.uri` / `record.cid`; without a DID it
   carries `"signed": false` and the gallery keeps the legacy manifest.

Images whose asset has not been uploaded yet are left out of the records
(their `preview`/`thumbnail` blobs cannot exist) and join on the next
re-sign; the asset upload path (`PUT /api/push/images/{id}/asset`)
re-signs every published collection that contains the image.

### Public routes added

| Route | Body |
|---|---|
| `GET /@user/slug/manifest.json` | the stored `gallery.astra.collection` SignedRecord when signed, else the legacy live manifest |
| `GET /@user/slug/bundle.json` | `{ "collection": <SignedRecord>, "images": [<SignedRecord>, ...] }` — what the viewer loads first |
| `GET /@user/slug/records/{rkey}` | one `gallery.astra.image` SignedRecord |
| `GET /xrpc/com.atproto.repo.getRecord?repo=&collection=&rkey=` | `{ uri, cid, value }`; `repo` is the DID or the username |
| `GET /blob/{cid}[/{quality}]` | rendition bytes by the blob CID a record carries (CIDv1 raw + sha256); the HoardFS `blake3:` id form still works |
| `GET /at/{did}/{collection}/{rkey}` | `302` to the pretty gallery URL for a stored record (see below); `{did}` may be a local username |

Record responses carry `Cache-Control: public, max-age=60` and the record
CID as ETag (`If-None-Match` → 304). The viewer still polls every 30 s;
for a signed gallery the body (and CID) only changes when the daemon
re-signs — on publish, on a sync push of a published collection, and on
an asset upload — not when a row is edited in place.

### Canonical `at://` URI and the resolver route

The pretty URL (`astra.gallery/@erewhon/orion-session`) is a resolver, not
the identity: it names this host, and a gallery moved to another daemon
(or a mirror) is a different URL. The record URI
`at://<did>/gallery.astra.collection/<slug>` is rooted in the author's
DID and survives a host move, so a **signed** gallery page advertises it
in `<head>` next to the existing `<base>`:

```html
<link rel="canonical" href="at://did:plc:…/gallery.astra.collection/orion-session">
<meta name="kenning:did" content="did:plc:…">
<meta name="kenning:cid" content="bafyrei…">
<meta name="kenning:uri" content="at://did:plc:…/gallery.astra.collection/orion-session">
```

`kenning:cid` is the CID of the collection record the page was rendered
for (the same value `manifest.json` returns as its ETag). An unsigned
gallery emits none of these. The viewer shows the same URI with a copy
button under the gallery title, and the profile page lists it beside each
signed public gallery.

`GET /at/{did}/{collection}/{rkey}` turns the URI back into a page: strip
`at://`, prefix `/at/`. A `gallery.astra.collection` record redirects
(302) to `/@{username}/{slug}`; a `gallery.astra.image` record redirects
to the gallery that contains the image. Unknown DID, rkey or NSID → 404.
`{did}` may also be a local username for convenience. **Mirrors should
implement this route**: it is the entry point a link rooted in a DID
needs on whichever host currently holds the author's records (resolve the
DID → find the record → send the visitor to the host's own page for it).

### Handle on the profile page

`GET /@{username}` shows the user's DID when one is linked and, when it
can be verified, their handle. The daemon resolves the DID document
(`kenning::HttpResolver`: plc.directory or `did:web`), takes the
`alsoKnownAs` handles, and shows the first one that resolves (DNS TXT or
`/.well-known/atproto-did`) back to the same DID — a claim in the
document alone proves nothing. The result is cached per DID for one hour
(one minute after a timeout or transport failure) and a request waits at
most 2 s for the resolver before rendering the DID alone.

