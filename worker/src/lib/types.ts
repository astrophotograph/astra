export interface Env {
  GALLERY_BUCKET: R2Bucket;
  GALLERY_KV: KVNamespace;
  CLERK_SECRET_KEY: string;
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_JWT_KEY: string;
  API_TOKEN_SECRET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_ENDPOINT: string;
}

export interface UserRecord {
  username: string;
  displayName: string;
  createdAt: string;
}

export interface ShareRecord {
  userId: string;
  username: string;
  collectionSlug: string;
  collectionName: string;
  createdAt: string;
}

export interface ApiToken {
  userId: string;
  username: string;
  displayName?: string;
  iat: number;
  exp: number;
}

export interface PresignRequest {
  shareId: string;
  collectionSlug: string;
  collectionName: string;
  files: PresignFile[];
}

export interface PresignFile {
  key: string;
  contentType: string;
  size: number;
}

export interface PresignResponse {
  shareId: string;
  uploads: { key: string; presignedUrl: string; expiresAt: string }[];
  publicUrl: string;
}
