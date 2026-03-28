export interface ManifestImage {
  id: string;
  filename: string;
  summary: string | null;
  contentType: string;
  imagePath: string;
  thumbPath: string;
  createdAt: string;
  favorite: boolean;
  catalogIds: string[];
  plateSolve: PlateSolve | null;
  objects: CatalogObject[];
}

export interface PlateSolve {
  centerRa: number;
  centerDec: number;
  pixelScale: number;
  rotation: number;
  widthDeg: number;
  heightDeg: number;
  imageWidth: number | null;
  imageHeight: number | null;
}

export interface CatalogObject {
  name: string;
  ra: number;
  dec: number;
  magnitude: number | null;
  sizeArcmin: number | null;
  pixelX: number | null;
  pixelY: number | null;
  radiusPx: number | null;
}

export interface ShareManifest {
  version: number;
  collectionName: string;
  collectionDescription: string | null;
  template: string | null;
  imageCount: number;
  updatedAt: string;
  images: ManifestImage[];
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
}

export type SortMode = "date-desc" | "date-asc" | "name-asc" | "name-desc";
