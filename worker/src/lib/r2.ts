/**
 * S3 presigned URL generation for R2.
 *
 * Generates presigned PUT URLs so the desktop app can upload directly to R2
 * without routing through the Worker.
 */

export async function generatePresignedPutUrl(
  endpoint: string,
  bucket: string,
  key: string,
  region: string,
  accessKeyId: string,
  secretAccessKey: string,
  contentType: string,
  expiresInSeconds: number = 3600
): Promise<string> {
  // Trim all inputs to avoid newline issues from secrets
  endpoint = endpoint.trim();
  accessKeyId = accessKeyId.trim();
  secretAccessKey = secretAccessKey.trim();
  region = region.trim();

  const now = new Date();
  const dateStamp = formatDate(now);
  const amzDate = formatAmzDate(now);
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;

  const host = extractHost(endpoint);

  // Query string parameters for presigned URL
  const queryParams = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresInSeconds),
    "X-Amz-SignedHeaders": "content-type;host",
  });

  // Sort query string
  const sortedQuery = [...queryParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const uriPath = `/${bucket}/${key}`;

  // Canonical request
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
  const signedHeaders = "content-type;host";

  const canonicalRequest = [
    "PUT",
    uriPath,
    sortedQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  // String to sign
  const canonicalRequestHash = await sha256Hex(canonicalRequest);
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    canonicalRequestHash,
  ].join("\n");

  // Signing key
  const signingKey = await deriveSigningKey(secretAccessKey, dateStamp, region);
  const signature = await hmacSha256Hex(signingKey, stringToSign);

  const url = `${endpoint.replace(/\/$/, "")}${uriPath}?${sortedQuery}&X-Amz-Signature=${signature}`;
  return url;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function formatAmzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function extractHost(endpoint: string): string {
  return endpoint.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

async function sha256Hex(data: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(data)
  );
  return arrayBufferToHex(hash);
}

async function hmacSha256(
  key: ArrayBuffer | Uint8Array,
  data: string | Uint8Array
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const encoded =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  return crypto.subtle.sign("HMAC", cryptoKey, encoded);
}

async function hmacSha256Hex(
  key: ArrayBuffer | Uint8Array,
  data: string
): Promise<string> {
  const sig = await hmacSha256(key, data);
  return arrayBufferToHex(sig);
}

async function deriveSigningKey(
  secret: string,
  dateStamp: string,
  region: string
): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(
    new TextEncoder().encode("AWS4" + secret),
    dateStamp
  );
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, "s3");
  return hmacSha256(kService, "aws4_request");
}

function arrayBufferToHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
