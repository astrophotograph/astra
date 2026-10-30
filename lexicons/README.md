# `gallery.astra.*` lexicons

AT Protocol [lexicon](https://atproto.com/specs/lexicon) definitions for the
records Astra publishes. The daemon validates records against these with
[kenning](../../../embettering/kenning)'s `LexiconRegistry` at publish time
(`src-tauri/tests/lexicons.rs` is the executable spec), and the same files can
be loaded into a PDS later. Any astro tool can publish into these shapes and
any viewer can render them; the astro-specific parts (plate solve, catalog
objects with pixel positions, equipment) are what make them more than a photo
gallery.

One file per NSID, all `"lexicon": 1`:

| NSID | Record key | Source |
|---|---|---|
| `gallery.astra.collection` | `any` (the publish slug) | `ShareManifest` + `published_collections` |
| `gallery.astra.image` | `tid` | `ManifestImage` (+ blobs for the renditions) |
| `gallery.astra.equipment` | `tid` | equipment sets (`src/lib/astronomy-utils.tsx`) |
| `gallery.astra.profile` | `literal:self` | `users` row |
| `sh.kenning.private.stub` | `any` (the subject's rkey) | kenning's public stand-in for a private record (not a `gallery.astra.*` type; see below) |

"Source" means the manifest shape in `viewer/src/types.ts`, as built by
`src-tauri/src/share/manifest.rs`, with the DB column it is populated from
in parentheses where that matters. The lexicons derive from the **manifest**,
not from the SQLite schema: the manifest is already the public view of a
collection.

## Why integers everywhere

AT Protocol records are canonicalised as DAG-CBOR, and the atproto data model
**forbids floating-point numbers** (the lexicon type system has `integer` but
no float). Every angle, scale, magnitude and pixel coordinate is therefore an
integer in a fixed sub-unit, and the unit is part of the property name so a
reader can never mistake it:

| Suffix | Meaning | Convert from float | Example |
|---|---|---|---|
| `MicroDeg` | millionths of a degree | `round(deg * 1e6)` | 83.822 deg -> `83822000` |
| `MilliDeg` | thousandths of a degree | `round(deg * 1e3)` | 1.2 deg -> `1200` |
| `MilliArcsec` | thousandths of an arcsecond | `round(arcsec * 1e3)` | 1.5"/px -> `1500` |
| `Milli` (magnitude) | thousandths of a magnitude | `round(mag * 1e3)` | 4.0 -> `4000`, -1.46 -> `-1460` |
| `ArcsecTenths` | tenths of an arcsecond | `round(arcmin * 600)` | 85.0' -> `51000` |
| `Px` / `pixelX` / `pixelY` | whole pixels | `round(px)` | 2048.4 -> `2048` |

Resolution: a micro-degree is 3.6 milliarcseconds, far below any amateur
plate-solve error; a milli-degree is 3.6 arcseconds, fine for field sizes and
rotation; pixel positions are only used to draw overlays. Always round
(`f64::round`), never truncate, so values are stable across republishes.
Viewers divide by the same factor to get floats back.

## Field map

### `gallery.astra.collection` (key `any`)

The record key is the collection's publish slug (`published_collections.slug`,
e.g. `orion-session`) so every existing `astra.gallery/<user>/<slug>` URL maps
onto exactly one `at://<did>/gallery.astra.collection/<slug>`. Slugs are
`[a-z0-9-]`, well inside the record-key alphabet. Hence `any`, not `tid`.

| Property | Type | From | Notes |
|---|---|---|---|
| `title` | string, <= 300 graphemes | `ShareManifest.collectionName` (`collections.name`) | required |
| `description` | string | `collectionDescription` (`collections.description`) | omit when null |
| `template` | string | `template` (`collections.template`) | viewer layout hint, e.g. `messier`; omit when null |
| `createdAt` | datetime | `collections.created_at` | required; not in the manifest today |
| `updatedAt` | datetime | `ShareManifest.updatedAt` | required |
| `dateRangeStart` | datetime | `dateRangeStart` (`collections.metadata.dateFilter.start`) | the manifest carries a bare `YYYY-MM-DD`; widen to `YYYY-MM-DDT00:00:00Z` |
| `dateRangeEnd` | datetime | `dateRangeEnd` (`...dateFilter.end`) | same widening |
| `images` | array of `#imageRef` | `ShareManifest.images` | required (may be empty); array order is display order. Each element is the published `gallery.astra.image` record's URI + CID, so images are published **before** the collection |
| `visibility` | string, knownValues `public`, `unlisted` | `published_collections.visibility` | required. Also `circle:<name>` for kith circles, so this is an open string, not an enum |
| `coverImage` | `#imageRef` | first image today | viewers fall back to `images[0]` |

Not carried: `version` (the lexicon is the version), `imageCount`
(`images.length`).

`#imageRef` = `{ uri: at-uri, cid: cid }`, the same shape as
`com.atproto.repo.strongRef`.

### `gallery.astra.image` (key `tid`)

A TID is assigned at first publish and remembered by the publisher (image id
-> TID), so republishing updates the same record. Astra's image ids are
UUIDs, which are valid record keys too, but TIDs sort by time and keep the
collection's `images` array independent of local ids.

| Property | Type | From | Notes |
|---|---|---|---|
| `filename` | string | `ManifestImage.filename` (`images.filename`) | base name only |
| `summary` | string | `summary` (`images.summary`) | omit when null |
| `contentType` | string | `contentType` (`images.content_type`, else inferred from the extension) | MIME type of the original |
| `createdAt` | datetime | `createdAt` (`images.created_at`) | **`NaiveDateTime::to_string()` gives `2026-01-15 20:00:00`, which is not a lexicon datetime.** Publish must emit RFC 3339 with a zone (`2026-01-15T20:00:00Z`) |
| `capturedAt` | datetime | FITS `DATE-OBS` in `images.metadata` | optional; not in the manifest today |
| `favorite` | boolean | `favorite` (`images.favorite`) | required |
| `catalogIds` | array of string | `catalogIds` | required (may be empty); normalised upper-case, no spaces |
| `preview` | blob, `image/*` | the rendition behind `imagePath` | replaces the path; a viewer-sized JPEG/WebP |
| `thumbnail` | blob, `image/*` | the rendition behind `thumbPath` | replaces the path |
| `original` | blob (any type) | the HoardFS original (`images.blob_id`) | optional; `image/fits` is fine here and would be rejected on `preview` |
| `plateSolve` | `#plateSolve` | `plateSolve` (`images.metadata.plate_solve`, `NAXIS1`/`NAXIS2`) | omit when null |
| `objects` | array of `#catalogObject` | `objects` (`images.annotations`) | required (may be empty) |
| `equipment` | array of `gallery.astra.equipment#equipmentRef` | equipment set used | optional; not in the manifest today |

Not carried: `id` (local UUID; becomes the rkey mapping), `imagePath`,
`thumbPath` (become blobs).

`#plateSolve` (all required except the pixel dimensions):

| Property | From (`PlateSolve`) | Encoding |
|---|---|---|
| `centerRaMicroDeg` | `centerRa` | degrees x 1e6, 0..360e6 |
| `centerDecMicroDeg` | `centerDec` | degrees x 1e6, -90e6..90e6 |
| `pixelScaleMilliArcsec` | `pixelScale` | arcsec/px x 1e3 |
| `rotationMilliDeg` | `rotation` | degrees x 1e3, -360e3..360e3 |
| `widthMilliDeg` | `widthDeg` | degrees x 1e3 |
| `heightMilliDeg` | `heightDeg` | degrees x 1e3 |
| `imageWidth` | `imageWidth` | px, as is (`NAXIS1`) |
| `imageHeight` | `imageHeight` | px, as is (`NAXIS2`) |

`#catalogObject` (`name`, `raMicroDeg`, `decMicroDeg` required):

| Property | From (`CatalogObject`) | Encoding |
|---|---|---|
| `name` | `name` | as displayed (`M 42`) |
| `raMicroDeg` | `ra` | degrees x 1e6 |
| `decMicroDeg` | `dec` | degrees x 1e6 |
| `magnitudeMilli` | `magnitude` | mag x 1e3, may be negative; omit when null |
| `sizeArcsecTenths` | `sizeArcmin` | arcmin x 600; omit when null |
| `pixelX`, `pixelY` | `pixelX`, `pixelY` | rounded px; may be negative or exceed the frame for off-frame centres; omit when null |
| `radiusPx` | `radiusPx` | rounded px, >= 0; omit when null |

### `gallery.astra.equipment` (key `tid`)

Equipment currently lives in the frontend's `localStorage` as `EquipmentSet`s
(`src/lib/astronomy-utils.tsx`: `Telescope`, `Mount`, `Camera`, `Filter`,
`GuideScope`, `GuideCamera`); there is no DB table. One record per item:

| Property | Type | From | Notes |
|---|---|---|---|
| `kind` | string, knownValues `telescope`, `mount`, `camera`, `filter`, `preset` | which `EquipmentSet` slot it came from; `preset` for Seestar-style integrated scopes | required, open string |
| `name` | string, <= 200 graphemes | `name` | required |
| `make`, `model` | string | split from `name` where known | optional |
| `specs` | unknown | `aperture` -> `apertureMm`, `focalLength` -> `focalLengthMm`, `type` -> `opticalType`/`type`, `sensorWidth`/`sensorHeight` -> `sensorWidthMm`/`sensorHeightMm`, `pixelSize` -> `pixelSizeMicrons` (x 1000 if fractional microns are needed: there are no floats inside `unknown` either), `resolution` as string | optional; free-form but DAG-CBOR encodable |
| `createdAt` | datetime | publish time | required |

`#equipmentRef` = `{ uri: at-uri, cid: cid }`.

### `gallery.astra.profile` (key `literal:self`)

Exactly one per repository (like `app.bsky.actor.profile`), so the record key
is the literal `self`; `validate_record` rejects any other key.

| Property | Type | From |
|---|---|---|
| `displayName` | string, <= 64 graphemes | `users.name` |
| `bio` | string, <= 1000 graphemes | `users.bio` |
| `avatar` | blob, `image/*`, <= 2 MB | the image behind `users.image` (a URL today) |
| `createdAt` | datetime | `users.created_at` |

All optional: an empty `{ "$type": "gallery.astra.profile" }` is valid.

### `sh.kenning.private.stub` (key `any`)

Not an Astra type: this is kenning's stub for a record held in a host's
private store (`kenning/docs/private-store.md`), kept here because the
daemon validates and signs it like the others and `LexiconRegistry` loads
one directory. When a collection is published with `visibility`
`circle:<name>`, its `gallery.astra.collection` and image records are
stored privately and this record is published in the owner's public repo
**at the same rkey as the collection**: `subject` (at-uri of the private
collection), `subjectCid` (its CID when the stub was signed), `host`
(the daemon's `ASTRA_PUBLIC_URL`), `visibility` (the `circle:` string) and
`updatedAt`. All required. A viewer who resolves the stub knows only that
the record exists, where it is served, and which circle gates it.

## Intentionally excluded

Nothing that is local state, operational, or private leaves the machine:

- local file paths (`scan_roots.path`, `scanned_directories.*`, `images.url`,
  `images.fits_url`, `images.thumbnail` paths, `imagePath`/`thumbPath`);
- scan roots, scanned directories, backups, auto-import config;
- the observation planner: `astronomy_todos`, `observation_schedules`,
  `schedule_items`;
- access tokens, PATs, OIDC subjects, user `email`, `role`, `status`;
- `users.username` and `users.id` (identity is the repo DID);
- the catalog caches (`astro_objects`, `simbad_cache`);
- kith social graph edges (those are kith's own records);
- `collections.favorite`, `collections.tags`, `collections.archived`,
  `images.tags`, `images.visibility`, `images.location`, `images.description`
  (private curation state; `summary` is the public caption);
- raw `images.metadata` / `images.annotations` JSON (only the typed
  `plateSolve` / `objects` projections are published);
- `view_count` (server-side statistics, not part of the record).

## Validation semantics worth knowing

- Objects are open-world: extra properties are allowed, so a viewer must not
  reject records with fields it does not know.
- `knownValues` is advisory (`visibility`, `kind`); `enum` would be closed.
- Optional properties are omitted, never `null` (nothing is `nullable`).
- `maxGraphemes` is approximated by scalar-value count in kenning; the
  `maxLength` byte limits are set to 10x the grapheme limit.
- Blob `accept` is enforced on `preview`, `thumbnail` and `avatar` (`image/*`),
  not on `original`.

## How the Astra daemon serves these

`src-tauri/src/share/records.rs` builds, validates and signs the records;
`published_records` stores the kenning `SignedRecord` JSON and the public
routes serve it byte-for-byte (`docs/hosting.md`, "Signed publishing").
Blob references use the CIDv1 (`raw`, sha2-256) of the rendition bytes,
and the daemon resolves `GET /blob/{cid}` back to the HoardFS variant via
its `blob_digests` table — so a record needs no host-specific field to
locate its images. `original` is not published yet.
