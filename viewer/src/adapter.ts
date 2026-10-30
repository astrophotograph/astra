// Signed-record support: the daemon publishes collections as kenning
// `SignedRecord`s of `gallery.astra.collection` / `gallery.astra.image`
// (see `lexicons/README.md`). `bundle.json` carries the collection record
// plus every image record; this module turns that into the `ShareManifest`
// the rest of the viewer renders, so rendering code never learns about
// records. Legacy galleries (no signing) still serve `manifest.json` in the
// old shape, and `fetchGallery` falls back to it.

import type {
  CatalogObject,
  ManifestImage,
  PlateSolve,
  ShareManifest,
} from "./types";

export const COLLECTION_TYPE = "gallery.astra.collection";
export const IMAGE_TYPE = "gallery.astra.image";

/** `{ uri, cid }` — com.atproto.repo.strongRef. */
export interface StrongRef {
  uri: string;
  cid: string;
}

export interface BlobRef {
  $type: "blob";
  ref: { $link: string };
  mimeType: string;
  size: number;
}

export interface CollectionRecord {
  $type: typeof COLLECTION_TYPE;
  title: string;
  description?: string;
  template?: string;
  createdAt: string;
  updatedAt: string;
  dateRangeStart?: string;
  dateRangeEnd?: string;
  images: StrongRef[];
  visibility: string;
  coverImage?: StrongRef;
}

export interface PlateSolveRecord {
  centerRaMicroDeg: number;
  centerDecMicroDeg: number;
  pixelScaleMilliArcsec: number;
  rotationMilliDeg: number;
  widthMilliDeg: number;
  heightMilliDeg: number;
  imageWidth?: number;
  imageHeight?: number;
}

export interface CatalogObjectRecord {
  name: string;
  raMicroDeg: number;
  decMicroDeg: number;
  magnitudeMilli?: number;
  sizeArcsecTenths?: number;
  pixelX?: number;
  pixelY?: number;
  radiusPx?: number;
}

export interface ImageRecord {
  $type: typeof IMAGE_TYPE;
  filename: string;
  summary?: string;
  contentType: string;
  createdAt: string;
  capturedAt?: string;
  favorite: boolean;
  catalogIds: string[];
  preview: BlobRef;
  thumbnail: BlobRef;
  original?: BlobRef;
  plateSolve?: PlateSolveRecord;
  objects: CatalogObjectRecord[];
}

/** kenning envelope JSON (frozen shape). */
export interface SignedRecord<T> {
  uri: string;
  cid: string;
  methodId: string;
  signedAt: string;
  algo: string;
  sig: string;
  record: T;
}

export interface Bundle {
  collection: SignedRecord<CollectionRecord>;
  images: SignedRecord<ImageRecord>[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Type guard for a `bundle.json` response. */
export function isBundle(v: unknown): v is Bundle {
  if (!isObject(v) || !isObject(v.collection) || !Array.isArray(v.images)) {
    return false;
  }
  const rec = (v.collection as Record<string, unknown>).record;
  return isObject(rec) && rec.$type === COLLECTION_TYPE;
}

/** Type guard for a signed collection record served as `manifest.json`. */
export function isSignedCollection(
  v: unknown
): v is SignedRecord<CollectionRecord> {
  return (
    isObject(v) &&
    typeof v.uri === "string" &&
    isObject(v.record) &&
    v.record.$type === COLLECTION_TYPE
  );
}

/** Type guard for the legacy live manifest. */
export function isLegacyManifest(v: unknown): v is ShareManifest {
  return (
    isObject(v) &&
    typeof v.collectionName === "string" &&
    Array.isArray(v.images)
  );
}

/** Last segment of an `at://did/collection/rkey` URI. */
export function rkeyOf(uri: string): string {
  const i = uri.lastIndexOf("/");
  return i >= 0 ? uri.slice(i + 1) : uri;
}

/** Public URL of a blob rendition: the daemon's bare `/blob/{cid}` route. */
export function blobUrl(blob: BlobRef): string {
  return "/blob/" + blob.ref.$link;
}

/** `2026-01-01T00:00:00.000Z` → `2026-01-01` (the legacy date-filter form). */
function toDate(dt: string | undefined): string | null {
  if (!dt) return null;
  return dt.length >= 10 ? dt.slice(0, 10) : dt;
}

function opt(v: number | undefined, scale: number): number | null {
  return v === undefined || v === null ? null : v / scale;
}

export function plateSolveFromRecord(ps: PlateSolveRecord): PlateSolve {
  return {
    centerRa: ps.centerRaMicroDeg / 1e6,
    centerDec: ps.centerDecMicroDeg / 1e6,
    pixelScale: ps.pixelScaleMilliArcsec / 1e3,
    rotation: ps.rotationMilliDeg / 1e3,
    widthDeg: ps.widthMilliDeg / 1e3,
    heightDeg: ps.heightMilliDeg / 1e3,
    imageWidth: ps.imageWidth ?? null,
    imageHeight: ps.imageHeight ?? null,
  };
}

export function catalogObjectFromRecord(o: CatalogObjectRecord): CatalogObject {
  return {
    name: o.name,
    ra: o.raMicroDeg / 1e6,
    dec: o.decMicroDeg / 1e6,
    magnitude: opt(o.magnitudeMilli, 1e3),
    // tenths of an arcsecond → arcminutes
    sizeArcmin: opt(o.sizeArcsecTenths, 600),
    pixelX: o.pixelX ?? null,
    pixelY: o.pixelY ?? null,
    radiusPx: o.radiusPx ?? null,
  };
}

export function imageFromRecord(signed: SignedRecord<ImageRecord>): ManifestImage {
  const r = signed.record;
  return {
    id: rkeyOf(signed.uri),
    filename: r.filename,
    summary: r.summary ?? null,
    contentType: r.contentType,
    imagePath: blobUrl(r.preview),
    thumbPath: blobUrl(r.thumbnail),
    createdAt: r.createdAt,
    favorite: r.favorite,
    catalogIds: r.catalogIds ?? [],
    plateSolve: r.plateSolve ? plateSolveFromRecord(r.plateSolve) : null,
    objects: (r.objects ?? []).map(catalogObjectFromRecord),
  };
}

/**
 * A `ShareManifest` from a bundle. Images follow the collection record's
 * `images[]` order; records the bundle lacks are skipped.
 */
export function manifestFromBundle(bundle: Bundle): ShareManifest {
  const c = bundle.collection.record;
  const byUri = new Map(bundle.images.map((s) => [s.uri, s]));
  const images: ManifestImage[] = [];
  for (const ref of c.images) {
    const s = byUri.get(ref.uri);
    if (s) images.push(imageFromRecord(s));
  }
  return {
    version: 1,
    collectionName: c.title,
    collectionDescription: c.description ?? null,
    template: c.template ?? null,
    imageCount: images.length,
    updatedAt: c.updatedAt,
    images,
    dateRangeStart: toDate(c.dateRangeStart),
    dateRangeEnd: toDate(c.dateRangeEnd),
    atUri: bundle.collection.uri,
  };
}

async function getJson(url: string): Promise<unknown | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Load the gallery: `bundle.json` (signed records) first, then the legacy
 * `manifest.json`. Both resolve against the page's `<base href>`.
 */
export async function fetchGallery(): Promise<ShareManifest | null> {
  const stamp = "?t=" + Date.now();
  const bundle = await getJson("bundle.json" + stamp);
  if (isBundle(bundle)) return manifestFromBundle(bundle);
  const manifest = await getJson("manifest.json" + stamp);
  if (isLegacyManifest(manifest)) return manifest;
  // A signed gallery whose bundle failed: render what the collection
  // record alone allows (title etc.) rather than "not found".
  if (isSignedCollection(manifest)) {
    return manifestFromBundle({ collection: manifest, images: [] });
  }
  return null;
}
