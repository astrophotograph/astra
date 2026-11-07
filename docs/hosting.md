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

- The daemon binary is built from the same crate as the desktop app and
  links the desktop GTK/WebKit stack plus `libpython3.13` (the Python
  bridge is used for plate solving and processing). Build on a glibc host
  with the same Python minor version and install the runtime on the VM:
  `apt install --no-install-recommends libwebkit2gtk-4.1-0 libgtk-3-0
  libpython3.13` (done on the astra VM 2026-10-30). Splitting the daemon
  into its own crate so it links only libc is tracked in Forge.
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
- Outbound mail (`ASTRA_RESEND_API_KEY` or `ASTRA_MAIL_RESEND_KEY_SOURCE`,
  plus `ASTRA_MAIL_FROM`) enables magic-link sign-in emails; without it
  the daemon logs the message it would have sent (see "Magic-link
  sign-in" below).

## Public surface

| Route | Auth | Notes |
|---|---|---|
| `/healthz` | none | version + db/hoardfs status |
| `/@user`, `/@user/slug`, assets | none (optional session/PAT for `circle:` galleries) | published collections only; `circle:<name>` galleries 404 unless the viewer is the owner or in the circle |
| `/at/{did}/{collection}/{rkey}` | none | 302 to the gallery for a stored signed record |
| `/auth/magic/request`, `/auth/magic/{token}`, `/auth/logout` | none (the link is the credential) | magic-link sign-in for custodial viewers, see below |
| `/api/*` | bearer (PAT or OIDC JWT) or `astra_session` cookie | default-deny |

## Personal access tokens and the CLI

Non-browser clients (the desktop push, `astra-cli`) authenticate with a
personal access token: `astra_` + 64 hex characters, shown once at mint
time, stored only as a SHA-256 hash in `access_tokens`.

| Route | Notes |
|---|---|
| `GET /api/me/tokens` | `{"tokens": [{id, name, createdAt, lastUsedAt}]}` — the caller's active tokens, newest first. Never the plaintext or hash. |
| `POST /api/me/tokens {"name"}` | 201 `{id, name, token, createdAt}`; `token` is the plaintext, returned exactly once. Name 1–100 characters. |
| `DELETE /api/me/tokens/{id}` | 204; 404 for an id that is not one of the caller's active tokens (someone else's and already-revoked are indistinguishable). |

All three refuse a caller who authenticated **with** a PAT (403): a
leaked token cannot mint successors or revoke its siblings; only an
OIDC bearer or the browser session manages tokens. Users do this under
Settings → Account in the web app. The bootstrap path for a server
without OIDC remains `astra_daemon --mint-token <user> <name>`.

### Single-image upload (`astra-cli`)

The push protocol (`/api/push/collections`) is a whole-collection sync.
`astra-cli` instead adds one image at a time without touching the rest of
the collection:

| Route | Notes |
|---|---|
| `POST /api/upload/images` | Body: `filename`, `content_hash` (blake3 hex, optional `blake3:` prefix), and optionally `content_type`, `summary`, `description`, `tags` (comma-separated), `visibility`, `collection_id` **or** `collection_name` (case-insensitive match on the caller's live collections, created when absent), `metadata` (JSON object string), `source_path`. If the caller already owns an image with that content → 200 `{"id", "created": false, "assetStatus": "present", …}`; otherwise 201 with `"needed"`. The image is linked into the collection either way; `collectionCreated` says whether the name made a new one. 404 for a `collection_id` the caller does not own. |
| `PUT /api/push/images/{id}/asset` | Unchanged asset route (hash header, 422 on mismatch, idempotent). For FITS bytes landing on a row that carries no headers yet, the daemon now fills in what the desktop importer would have: the header map into `metadata`, the `OBJECT` header (or the target directory from `source_path`) as `summary`, and "10.0s exposure, 20 frames stacked, Filter: LP" as `description` — each only where the client left the field blank. Rows pushed from the desktop already carry `BITPIX` and are left alone. The store also generates the thumbnail/preview renditions (a stretched JPEG for FITS), so the web app has something to show; `/api/images/{id}/thumbnail` and `/preview` build them on first view for assets that predate this, and answer 404 rather than raw FITS bytes when none can be made. |
| `PUT /api/push/images/{id}/asset/parts` | The same upload in sequential pieces, for anything that caps one request body: Cloudflare's edge answers 413 above 100 MB, and a stacked APS-C FITS file is ~150 MB. Each part carries the whole-file `x-astra-content-hash` plus `Content-Range: bytes <start>-<end>/<total>` (`total` is checked against `ASTRA_MAX_ASSET_MB` up front). Parts spool under `{data_dir}/uploads/`; an intermediate part answers 202 `{"received", "total"}`, a part that does not start at the spooled length answers 409 with `received` (the resume point), and the last part verifies the hash over the whole (422 and spool dropped on mismatch) and answers exactly what the whole-body route would. Spool files untouched for a week are removed at daemon startup. A single part is capped at 100 MiB. |

`astra-cli` sends files over 64 MiB this way (`--chunk-mb`, env
`ASTRA_CHUNK_MB`); smaller files use the whole-body route.

The CLI itself lives in `cli/` (`just cli-install`); see `cli/README.md`
for selection rules, the local ledger and the `watch` mode.

## Plate solving (tetra3)

The daemon solves with the native tetra3 solver when a database exists at
`{data_dir}/tetra3/tetra3_unified_05_5deg.bin` (or `ASTRA_TETRA3_DB`); the
web app shows Plate Solve only when the server reports `solvable`. Build the
database once with `cargo run --release --bin generate_tetra3_db -- --preset
unified --catalog gaia_merged.bin --output tetra3_unified_05_5deg.bin` (the
17 MB Gaia catalog comes from the tetra3rs README; the unified database is
2.7 GB on disk, ~4 minutes to build) and push it to the VM. The daemon
deserializes it once — in the background at startup, or on the first solve
(`ASTRA_TETRA3_PRELOAD=0` skips the startup load) — and keeps it resident
(several GB), so solves take the solver's own time, not the load time.

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
| `ASTRA_LEXICONS_DIR` | Directory with the `gallery.astra.*.json` lexicons **and `sh.kenning.private.stub.json`** (the daemon refuses to start signing without it). Default `$ASTRA_DATA_DIR/lexicons`, falling back to the source checkout's `lexicons/` when running from a build tree. `just deploy-staging` ships the repo's `lexicons/` there, next to `web/`. |
| `ASTRA_PUBLIC_URL` | This daemon's public base URL, e.g. `https://astra.gallery`. Written as `host` into every private-record stub (below). Unset → public/unlisted publishing is unaffected, publishing a `circle:` collection fails with a message naming this variable, and the daemon warns once at startup. |

### Enabling signed publishing

A checklist for turning signing on for a running deployment. Paths match
`deploy/astra-daemon.service`; the `kenning` CLI is documented in the
kenning repo (`docs/cli.md`).

1. **Generate the daemon's app key** on the host, as the `astra` user so
   the file ends up `0600 astra:astra` (ProtectSystem keeps the rest of
   the filesystem read-only, so put it under `/var/lib/astra`, outside
   `data/`):

   ```bash
   sudo -u astra kenning keygen --out file:/var/lib/astra/signing.key
   ```

   It prints the public `did:key` only. Where `ho` is available, prefer
   `--out ho:astra-signing` and `ASTRA_SIGNING_KEY_SOURCE=ho:astra-signing`
   so the key lives in the homelab secret store. If `kenning` is not
   installed on the host (the staging VM carries no toolchain), run
   `keygen` on the build machine with `--out file:<tmp>` and push the
   file with `incus file push <tmp> astra/var/lib/astra/signing.key
   --mode 0600 --uid $(incus exec astra -- id -u astra) --gid $(incus exec astra -- id -g astra)`,
   then delete the local copy.

2. **Register the public key in the owner's DID document** under the
   method id the daemon will use (`astra`, the `ASTRA_SIGNING_METHOD_ID`
   default). Either add it to an existing DID:

   ```bash
   kenning add-method --did did:plc:… --id astra \
       --key file:/var/lib/astra/signing.key --rotation-key ho:kenning-ops
   ```

   (`--key` only sends the public half; `--rotation-key` is any key in the
   DID's `rotationKeys`), or mint a new one with the app key attached:

   ```bash
   kenning mint --handle alice.example.com --app astra=file:/var/lib/astra/signing.key \
       --ops-key ho:kenning-ops --recovery-out /run/user/1000/alice-recovery.key
   ```

   Every user who publishes signed galleries through this daemon needs the
   same key under `#astra` in their own DID.

3. **Set the key source in the unit.** Uncomment
   `Environment=ASTRA_SIGNING_KEY_SOURCE=file:/var/lib/astra/signing.key`
   in `astra-daemon.service` (or the private copy under
   `$ASTRA_DEPLOY_DIR`). `ASTRA_SIGNING_METHOD_ID` and
   `ASTRA_LEXICONS_DIR` only need setting when they differ from the
   defaults.

4. **Deploy.** `just deploy-staging` now pushes `lexicons/` to
   `/var/lib/astra/data/lexicons` along with the binary, web bundle and
   units, then restarts the daemon.

5. **Link the DID** for each publishing user: `PUT /api/me/did
   {"did": "did:plc:…"}` with their bearer token (see below).

6. **Republish each collection** (publish again, or push a sync). Existing
   galleries keep serving the legacy manifest until they are re-signed;
   the publish response carries `"signed": true` once they are.

Misconfiguration is deliberately loud: with `ASTRA_SIGNING_KEY_SOURCE`
set, a missing or unreadable key file, a wrong `KeySource` spec, or a
lexicons directory without `gallery.astra.collection` /
`gallery.astra.image` makes `astra_daemon` exit at startup instead of
running unsigned, and systemd's `Restart=on-failure` will keep retrying.
Confirm with `just daemon-logs` (or `journalctl -u astra-daemon`): a
correctly configured daemon logs one line at startup,

```
signed publishing enabled (method #astra, key did:key:zQ3s…, 4 lexicons from /var/lib/astra/data/lexicons)
```

whereas an unconfigured one logs `signed publishing disabled —
ASTRA_SIGNING_KEY_SOURCE not set; galleries serve the live manifest`.
The `did:key` in that line must match the `#astra` verification method
in the DID document (`kenning resolve did:plc:…`).

### Linking a DID

Records are published under `at://<did>/...`, so each publishing user
needs a DID whose document names the daemon's key under the method id:

1. Generate the daemon's key once (`kenning keygen` → store with
   `ho secret` or a 0600 file) and set `ASTRA_SIGNING_KEY_SOURCE`
   (steps 1–3 above).
2. Mint the user's `did:plc` with `kenning mint`, or `kenning add-method`
   on an existing DID, adding the daemon's public key as verification
   method `astra` (the `ASTRA_SIGNING_METHOD_ID`).
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

### Blob digests follow the bytes

A record references its preview and thumbnail by the sha256 CID of the
rendition bytes, cached per `(blob, quality)` in `blob_digests` together
with the HoardFS variant blob id the hash was taken from. Renditions can
be regenerated in place (server-side processing, a re-pushed asset, a
desktop import of already-known content), so the cache is kept honest in
three places rather than trusted:

- **Every variant write path invalidates.** `POST /api/images/{id}/process`
  and `PUT /api/push/images/{id}/asset` drop the digests of the rewritten
  renditions and immediately re-sign every published collection that
  contains the image (logged at info: `variant change (preview+thumbnail)
  on blob …: re-signed N published collection(s)`). The desktop import and
  library-migration commands have no daemon state, so they only drop the
  digests; the next daemon publish re-hashes.
- **Publishing re-checks.** `publish_signed` trusts a cached digest only
  while HoardFS still lists the same variant blob for that quality (a
  metadata lookup, no hashing); otherwise it re-hashes the bytes first.
- **Serving by CID re-checks.** `GET /blob/{cid}` runs the same variant
  identity check before serving a digest hit. If the rendition was
  rewritten behind the daemon's back (bytes no longer hash to the CID),
  the bytes are hashed once, the row is replaced, the containing
  collections are re-signed, and the stale CID answers 404 — the records
  already carry the new CID. Requests by HoardFS `blake3:` id skip the
  check: they name the source, not the rendition bytes.

The fast path never reads or hashes variant bytes; hashing happens once
per rendition change, and once for each digest row written before the
`variant_blob_id` column existed (those are backfilled on first use).

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
re-signs — on publish, on a sync push of a published collection, on an
asset upload, on server-side processing of a published image, and when
`/blob/{cid}` finds a rendition that no longer hashes to its CID — not
when a row is edited in place.

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

### Circle visibility (`circle:<name>`)

Next to `public` and `unlisted`, a collection can be published to a
[kith](../../../embettering/kith) circle of its owner, e.g. family:

```
POST /api/collections/{id}/publish  {"visibility": "circle:family"}
```

The vocabulary is `kenning::Visibility` (`public` | `unlisted` |
`circle:<name>`, name `1..=64` chars of `[a-z0-9_-]`); the string is stored
in `published_collections.visibility` as is. The owner must have a linked
DID (400 otherwise): the mechanism is kenning's private store, see
`kenning/docs/private-store.md`:

- The collection's signed records are stored in `published_records` with
  `private = 1` (same table, a flag; migration `circle_visibility`). An
  image that also sits in a public or unlisted published collection keeps
  a public record, since its bytes are public anyway.
- In their place a **public stub** is signed and stored: collection
  `sh.kenning.private.stub`, same rkey as the collection (the slug), body
  `{ subject, subjectCid, host: $ASTRA_PUBLIC_URL, visibility, updatedAt }`.
  It is a normal public record (`getRecord` serves it, it goes in the
  owner's repo) and says only that a private record with that URI exists
  at this host; re-publishing refreshes it, unpublishing removes it with
  the private records.
- Every route that can expose the collection checks the viewer **on each
  request** against the live kith store, in this order: gallery page,
  `manifest.json`, `bundle.json`, `records/{rkey}`, `images/` and
  `thumbs/`, `/xrpc/com.atproto.repo.getRecord` for a private record,
  `/at/...` for a private record, and `/blob/{cid}` (served if *any*
  public/unlisted published collection references the blob, else if the
  viewer passes for *any* circle collection that does, else 404). Denial
  is always **404**, never 403, so a stranger cannot tell private from
  nonexistent. Admitted responses carry `Cache-Control: private, no-store`
  and `Vary: Cookie, Authorization`.
- The viewer is identified from the existing credentials, optionally: a
  PAT or OIDC bearer, or the `astra_session` cookie, resolved to a local
  user and then to `users.did`. No credential, a bad or expired one, or a
  user without a DID all count as anonymous (never a 401 on a public
  route). Family members without an OIDC login sign in with a magic link
  (next section) — the same cookie, so nothing here changes for them.
- Membership = a kith edge actor → `(user, viewer)` of kind
  `circle:<name>`, where both ids are local `users.id` (kith ids in Astra
  are user ids, mapped from DIDs through `users.did`). The owner always
  passes. A DID with no local account is a member of nothing.
- The profile page lists a circle gallery only to viewers who pass, and
  never lists the stub. The stub's own `/at/` URI redirects (302) to the
  gallery URL like any record — the gallery then 404s for outsiders.
- Unlisted blobs stay fetchable by CID for anyone (the hash is the
  capability, exactly like the unlisted URL).

**Managing circle members.** Circles have no table of their own: a circle
exists exactly as long as it has members, each an edge actor → `(user,
member)` of kind `circle:<name>`. The owner manages them over the authed
API (PAT or OIDC bearer, or the session cookie); names follow
`kenning::Visibility` (`[a-z0-9_-]`, 1..=64 chars) and anything else is a
400:

```
GET    /api/circles                            → {"circles":[{"name":"family","members":2}]}
GET    /api/circles/family                     → {"name":"family","members":[{"user_id","did","signed","created_at"}]}  (404 if empty)
PUT    /api/circles/family/members/<users.id>  → {"signed":true|false}   (404 unknown user, 400 self)
DELETE /api/circles/family/members/<users.id>  → 204
```

Removal takes effect on the member's next request; nothing is cached. The
member needs a local account (`users.id`) with a DID (`PUT /api/me/did`, or
set `users.did` for a custodial account) and a way to log in (OIDC session
or a PAT) — a member without a DID is stored but can never pass the ACL,
which compares DIDs. Writing `kith_edges` rows by hand is no longer needed
and loses the signature described next.

### Signed social edges (`kith_edges.signed_json`)

Follows (`POST /api/social/follow`) and circle memberships are, when they
can be, **signed statements by the acting user's DID**: a kith
`sh.kith.graph.edge` record (`kith/lexicons/sh.kith.graph.edge.json`) in a
kenning envelope signed with the daemon's `ASTRA_SIGNING_KEY_SOURCE` key
under `ASTRA_SIGNING_METHOD_ID`, verified against the actor's DID document
before it is stored. Three things must hold, otherwise the edge is stored
plain and the write response says `"signed": false`: the daemon has a
signer, the actor has a linked DID, and a `user` target has a DID too
(object/collection targets keep their ids). A plain edge works exactly as
before — the graph, counts and the circle ACL do not care.

The id mapping is deliberate and differs from kith's own SQLite adapter:
`kith_edges` rows stay keyed by local `users.id` (`actor_id`, `target_id`),
so every existing query is unchanged, while the envelope in the nullable
`signed_json` column (migration `kith_signed_edges`) carries the DIDs —
`actor` is the actor's `users.did`, `target.id` the target user's
`users.did`. The record URI is `at://<actor DID>/sh.kith.graph.edge/<tid>`.
Repeating a follow or membership that is already signed keeps the original
statement (same URI); repeating one stored plain upgrades it when it can
now be signed. Deleting the row (unfollow, member removal) deletes the
statement.

An indexer, or the users themselves, read a statement from the public
route

```
GET /@{user}/graph/{kind}/{target_kind}/{target_id}
```

where `{user}` is `@username` or `@did:…`, `{kind}` is kith's text codec
(`follow`, or `circle:family` URL-encoded as `circle%3Afamily`), and a
`user` target id may be the local id or the DID. The body is the stored
envelope JSON. `follow` edges are public (`Cache-Control: public,
max-age=60`). `circle:*` edges reveal membership, so they are served only
to the circle's owner or the member named, identified like any circle
viewer (session cookie or bearer → `users.did`), with `Cache-Control:
private, no-store`. Any other kind, an unknown user, a missing or unsigned
edge, or a viewer who may not see it is a 404 — never a 403.

If the signing key is not the `ASTRA_SIGNING_METHOD_ID` key in the actor's
DID document, follows and circle writes by that user fail with a 500 and
nothing is written (the daemon log names the verification error); the user
must publish the host's public key in their DID document, exactly as for
signed publishing.

### Magic-link sign-in for custodial viewers

Family members whose DID the host minted (`users.did` set, no Zitadel
account) sign in by email. Design: kenning `docs/private-store.md` §3 and
its review decisions (sessions yes, 30 days sliding, revocable; device
memory deferred).

**What a family member experiences.** They open the gallery link they
were sent, see nothing (a `circle:` gallery is a 404 to an anonymous
viewer), enter their email address where the page asks for it, and get
an email "Your Astra sign-in link" with one URL. Tapping it signs them in
and lands them on the gallery (or their profile). The link works once
and for 15 minutes; after that, ask for a new one. They stay signed in
on that browser as long as they come back at least every 30 days — each
visit pushes the expiry out another 30 days. Closing the browser does
not sign them out; `POST /auth/logout` (the sign-out button) does.
**Remembering a device** past that (a "this is grandma's iPad" cookie
that skips the email forever) is deliberately not implemented yet — the
review deferred it until the family has lived with plain magic links.

**Routes.**

| Route | Behaviour |
|---|---|
| `POST /auth/magic/request` `{"email": "..."}` | Always `200 {}`. Rate limited to 5 per hour per client IP (first `X-Forwarded-For` hop) and per email; over the limit it is still `200 {}` and nothing is sent. When a user with that email (case-insensitive) **and** a `users.did` exists, a one-time token is minted — 32 random bytes, only its SHA-256 stored in `magic_tokens`, 15 minute expiry, replacing the user's outstanding token — and `{ASTRA_PUBLIC_URL}/auth/magic/{token}` is emailed as plain text. Unknown address or no DID: nothing happens, same response. |
| `GET /auth/magic/{token}[?next=/@owner/slug]` | Redeems the token once (marked `used_at`), creates a `viewer_sessions` row, sets the `astra_session` cookie (HttpOnly, Secure, SameSite=Lax, Path=/ — the same cookie the OIDC login sets, so every existing viewer check applies) and answers 303 to `next` when it is a same-origin absolute path (`/...`, not `//host` or `/\host`), else to `/@{username}`. Unknown, used or expired token: 404 with a plain HTML message. |
| `POST /auth/logout` | 204; deletes the viewer session the cookie names and clears the cookie. `DELETE /api/session` does the same. |
| `DELETE /api/admin/sessions/{user_id}` | Owner only (403 otherwise). Deletes every viewer session and unused magic token of that user → `{"userId", "revokedSessions"}`. Their next request is anonymous. |

**Sessions.** OIDC cookies stay stateless. A magic-link cookie's subject
is `sess:<row id>`, signed with the same session key, hard-capped at one
year; the `viewer_sessions` row is the real lifetime: `expires_at` is 30
days from the last touch and slides forward on the first authenticated
request of each day (`last_seen_at`). Expired rows are deleted when
seen; disabling the user still kills the session on the next request.

**Environment.**

| Variable | Meaning |
|---|---|
| `ASTRA_PUBLIC_URL` | Base of the emailed link (already required for `circle:` publishing). Unset → links point at the bind address, which is useless to anyone but the operator; the daemon warns. |
| `ASTRA_RESEND_API_KEY` | A Resend API key. Mail goes out through `POST https://api.resend.com/emails`. |
| `ASTRA_MAIL_RESEND_KEY_SOURCE` | Where to read the key instead, in the same `ho:<name>` / `file:<path>` / `env:<VAR>` form as `ASTRA_SIGNING_KEY_SOURCE`. The homelab key is `ho:resend/smtp-key`. Set but unreadable → the daemon refuses to start. |
| `ASTRA_MAIL_FROM` | Sender, default `Astra <noreply@byrnes.org>`. Keep it on `byrnes.org` or `flatland.org` — those domains publish Resend's SPF/DKIM; a `bcc.sh` sender softfails. |

With neither key variable set the daemon logs `mail not configured` at
startup and every magic-link email is written to the log (recipient and
subject only) instead of sent — the state every test runs in.

**Giving a family member access**, end to end: create their user row
with `email` and `did` (the custodial DID from `kenning mint`), add the
`circle:<name>` edge (above), and send them the gallery URL. They take
it from there. To cut someone off: delete the circle edge (immediate),
and revoke their sessions if you also want them signed out.

### Handle on the profile page

`GET /@{username}` shows the user's DID when one is linked and, when it
can be verified, their handle. The daemon resolves the DID document
(`kenning::HttpResolver`: plc.directory or `did:web`), takes the
`alsoKnownAs` handles, and shows the first one that resolves (DNS TXT or
`/.well-known/atproto-did`) back to the same DID — a claim in the
document alone proves nothing. The result is cached per DID for one hour
(one minute after a timeout or transport failure) and a request waits at
most 2 s for the resolver before rendering the DID alone.

