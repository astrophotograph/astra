/**
 * Client-side objects-in-FOV computation from a plate-solve solution.
 *
 * The desktop resolves overlay objects through astroquery (Python) at solve
 * time; the daemon links no Python, so on web we compute annotations in the
 * browser from the bundled catalogs (Messier, Caldwell, full NGC and IC — RA/Dec in
 * degrees). Works from the raw solve center/size only — no axis flipping, no
 * pixel positions: the ImageViewer overlay falls back to its TAN projection
 * from RA/Dec, which is exactly what these entries feed.
 */

import {
  CALDWELL_CATALOG,
  MESSIER_CATALOG,
  getAllICEntries,
  getAllNGCEntries,
  type CatalogEntry,
} from "./catalogs";
import type { CatalogObject } from "./tauri/commands";

/** Linear TAN WCS as the daemon's tetra3 solve reports it (`PlateSolveResult.wcs`):
 *  `crpix` = frame centre in top-left-origin pixels, `crval` in degrees, `cd` in
 *  degrees per pixel mapping pixel offsets to (ξ east, η north). */
export interface SolveWcs {
  crpix: [number, number];
  crval: [number, number];
  cd: [[number, number], [number, number]];
}

export function isSolveWcs(value: unknown): value is SolveWcs {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const pair = (p: unknown) =>
    Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && Number.isFinite(n));
  return (
    pair(v.crpix) &&
    pair(v.crval) &&
    Array.isArray(v.cd) &&
    v.cd.length === 2 &&
    v.cd.every(pair)
  );
}

/** Where (RA, Dec) lands in the solved frame, in top-left-origin pixels, or
 *  null when the point is behind the tangent plane or the CD is singular. */
export function worldToPixel(wcs: SolveWcs, raDeg: number, decDeg: number): { x: number; y: number } | null {
  const ra = toRad(raDeg);
  const dec = toRad(decDeg);
  const ra0 = toRad(wcs.crval[0]);
  const dec0 = toRad(wcs.crval[1]);
  const cosDec = Math.cos(dec);
  const dRa = ra - ra0;
  const denom = Math.sin(dec) * Math.sin(dec0) + cosDec * Math.cos(dec0) * Math.cos(dRa);
  if (denom <= 1e-12) return null;
  // Standard coordinates in degrees: ξ toward east, η toward north
  const xi = ((cosDec * Math.sin(dRa)) / denom / Math.PI) * 180;
  const eta = ((Math.sin(dec) * Math.cos(dec0) - cosDec * Math.sin(dec0) * Math.cos(dRa)) / denom / Math.PI) * 180;
  const [[a, b], [c, d]] = wcs.cd;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-30) return null;
  const dx = (d * xi - b * eta) / det;
  const dy = (-c * xi + a * eta) / det;
  return { x: wcs.crpix[0] + dx, y: wcs.crpix[1] + dy };
}

/** Arcsec per pixel implied by the CD matrix. */
export function wcsPixelScaleArcsec(wcs: SolveWcs): number {
  const [[a], [c]] = wcs.cd;
  return Math.sqrt(a * a + c * c) * 3600;
}

const MAX_OBJECTS = 50;
/** Two entries within this separation are the same object seen from two
 *  catalogs (e.g. M42 vs NGC 1976). */
const DUPLICATE_ARCMIN = 2;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle separation in degrees (haversine — stable at small angles). */
export function angularSeparationDeg(
  ra1: number,
  dec1: number,
  ra2: number,
  dec2: number,
): number {
  const dRa = toRad(ra2 - ra1);
  const dDec = toRad(dec2 - dec1);
  const a =
    Math.sin(dDec / 2) ** 2 +
    Math.cos(toRad(dec1)) * Math.cos(toRad(dec2)) * Math.sin(dRa / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(a))) * 180) / Math.PI;
}

/** Catalog sizes are strings like "6×4" or "18" (arcmin) — take the major
 *  axis. */
function sizeArcminOf(entry: CatalogEntry): number | undefined {
  const match = entry.size?.match(/[\d.]+/);
  return match ? parseFloat(match[0]) : undefined;
}

/** Is the entry inside the (slightly padded) solved footprint? Rectangular
 *  test in the tangent-plane approximation: RA offset scaled by cos(dec). */
function inFov(
  entry: CatalogEntry,
  centerRa: number,
  centerDec: number,
  widthDeg: number,
  heightDeg: number,
): boolean {
  // Pad by the object's own radius so objects straddling the edge count
  const padDeg = (sizeArcminOf(entry) ?? 0) / 60 / 2;
  let dRa = Math.abs(entry.ra - centerRa);
  if (dRa > 180) dRa = 360 - dRa;
  const dRaProj = dRa * Math.cos(toRad(centerDec));
  const dDec = Math.abs(entry.dec - centerDec);
  return dRaProj <= widthDeg / 2 + padDeg && dDec <= heightDeg / 2 + padDeg;
}

function toCatalogObject(entry: CatalogEntry, catalog: string): CatalogObject {
  return {
    name: entry.id,
    catalog,
    objectType: entry.type,
    ra: entry.ra,
    dec: entry.dec,
    magnitude: entry.magnitude,
    size: entry.size,
    sizeArcmin: sizeArcminOf(entry),
    commonName: entry.commonName,
  };
}

/**
 * Deep-sky objects inside a solved field, brightest first, capped.
 * Messier and Caldwell identities win over their NGC/IC duplicates.
 *
 * With a `wcs` (the daemon's tetra3 solve) every object also gets its pixel
 * position and radius in the frame, and membership is decided in pixels —
 * exact for rotated or mirrored frames, where the rectangular RA/Dec test
 * is only approximate.
 */
export function queryObjectsInFovClient(
  centerRa: number,
  centerDec: number,
  widthDeg: number,
  heightDeg: number,
  wcs?: SolveWcs | null,
): CatalogObject[] {
  const picked: CatalogObject[] = [];
  const frameW = wcs ? wcs.crpix[0] * 2 : 0;
  const frameH = wcs ? wcs.crpix[1] * 2 : 0;
  const arcsecPerPx = wcs ? wcsPixelScaleArcsec(wcs) : 0;

  const place = (entry: CatalogEntry): Partial<CatalogObject> | null => {
    if (!wcs) return inFov(entry, centerRa, centerDec, widthDeg, heightDeg) ? {} : null;
    const px = worldToPixel(wcs, entry.ra, entry.dec);
    if (!px) return null;
    const sizeArcmin = sizeArcminOf(entry);
    const radiusPx = sizeArcmin && arcsecPerPx > 0 ? (sizeArcmin * 60) / 2 / arcsecPerPx : undefined;
    const pad = radiusPx ?? 0;
    if (px.x < -pad || px.x > frameW + pad || px.y < -pad || px.y > frameH + pad) return null;
    return { pixelX: px.x, pixelY: px.y, radiusPx };
  };

  const consider = (entries: CatalogEntry[], catalog: string) => {
    for (const entry of entries) {
      const placed = place(entry);
      if (!placed) continue;
      const duplicate = picked.some(
        (p) =>
          p.name === entry.id ||
          angularSeparationDeg(p.ra, p.dec, entry.ra, entry.dec) * 60 <
            DUPLICATE_ARCMIN,
      );
      if (!duplicate) picked.push({ ...toCatalogObject(entry, catalog), ...placed });
    }
  };

  consider(MESSIER_CATALOG, "Messier");
  consider(CALDWELL_CATALOG, "Caldwell");
  consider(getAllNGCEntries(), "NGC");
  consider(getAllICEntries(), "IC");

  picked.sort(
    (a, b) => (a.magnitude ?? Infinity) - (b.magnitude ?? Infinity),
  );
  return picked.slice(0, MAX_OBJECTS);
}
