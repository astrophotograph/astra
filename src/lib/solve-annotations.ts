/**
 * Client-side objects-in-FOV computation from a plate-solve solution.
 *
 * The desktop resolves overlay objects through astroquery (Python) at solve
 * time; the daemon links no Python, so on web we compute annotations in the
 * browser from the bundled catalogs (Messier, Caldwell, full NGC — RA/Dec in
 * degrees). Works from the raw solve center/size only — no axis flipping, no
 * pixel positions: the ImageViewer overlay falls back to its TAN projection
 * from RA/Dec, which is exactly what these entries feed.
 */

import {
  CALDWELL_CATALOG,
  MESSIER_CATALOG,
  getAllNGCEntries,
  type CatalogEntry,
} from "./catalogs";
import type { CatalogObject } from "./tauri/commands";

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
 * Messier and Caldwell identities win over their NGC duplicates.
 */
export function queryObjectsInFovClient(
  centerRa: number,
  centerDec: number,
  widthDeg: number,
  heightDeg: number,
): CatalogObject[] {
  const picked: CatalogObject[] = [];

  const consider = (entries: CatalogEntry[], catalog: string) => {
    for (const entry of entries) {
      if (!inFov(entry, centerRa, centerDec, widthDeg, heightDeg)) continue;
      const duplicate = picked.some(
        (p) =>
          angularSeparationDeg(p.ra, p.dec, entry.ra, entry.dec) * 60 <
          DUPLICATE_ARCMIN,
      );
      if (!duplicate) picked.push(toCatalogObject(entry, catalog));
    }
  };

  consider(MESSIER_CATALOG, "Messier");
  consider(CALDWELL_CATALOG, "Caldwell");
  consider(getAllNGCEntries(), "NGC");

  picked.sort(
    (a, b) => (a.magnitude ?? Infinity) - (b.magnitude ?? Infinity),
  );
  return picked.slice(0, MAX_OBJECTS);
}
