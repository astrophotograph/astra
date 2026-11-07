//! Thin blocking client for the daemon routes the CLI needs.

use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;

use crate::config::Credentials;

pub struct Client {
    base: String,
    token: String,
    http: reqwest::blocking::Client,
    /// Files larger than this go up in parts of this size.
    chunk_bytes: u64,
}

/// Default part size for chunked uploads. Cloudflare's edge refuses
/// request bodies over 100 MB (413), so stay well under it.
pub const DEFAULT_CHUNK_MB: u64 = 64;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub user_id: String,
    pub username: Option<String>,
    pub display_name: Option<String>,
    pub role: String,
    pub status: String,
}

impl Me {
    pub fn handle(&self) -> String {
        match (&self.username, &self.display_name) {
            (Some(u), _) => format!("@{u}"),
            (None, Some(d)) => d.clone(),
            (None, None) => self.user_id.clone(),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub visibility: String,
}

/// `POST /api/upload/images` request.
#[derive(Debug, Default, serde::Serialize)]
pub struct Register<'a> {
    pub filename: &'a str,
    pub content_hash: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection_name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<&'a str>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registered {
    pub id: String,
    pub created: bool,
    /// "needed" | "present"
    pub asset_status: String,
    pub collection_id: Option<String>,
    pub collection_created: bool,
}

#[derive(Debug, Deserialize)]
pub struct AssetStored {
    /// "stored" | "skipped"
    pub status: String,
}

/// An image found by `GET /api/upload/images/by-hash/{hash}`.
#[derive(Debug, Deserialize)]
pub struct FoundImage {
    pub id: String,
}

#[derive(Debug, Deserialize)]
pub struct Dims {
    pub width: u32,
    pub height: u32,
}

/// `PUT /api/images/{id}/rendition` response.
#[derive(Debug, Deserialize)]
pub struct RenditionStored {
    /// "stored" | "skipped"
    pub status: String,
    pub preview: Option<Dims>,
}

impl Client {
    pub fn new(creds: &Credentials) -> Self {
        Self {
            base: creds.server.clone(),
            token: creds.token.clone(),
            http: reqwest::blocking::Client::builder()
                .timeout(None)
                .connect_timeout(std::time::Duration::from_secs(20))
                .build()
                .expect("reqwest client"),
            chunk_bytes: DEFAULT_CHUNK_MB << 20,
        }
    }

    /// Part size for chunked uploads, in MiB (0 → never chunk).
    pub fn with_chunk_mb(mut self, mb: u64) -> Self {
        self.chunk_bytes = mb << 20;
        self
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn parse<T: serde::de::DeserializeOwned>(
        resp: reqwest::blocking::Response,
        what: &str,
    ) -> Result<T> {
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().unwrap_or_default();
            let server_message = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| {
                    v.get("message")
                        .or_else(|| v.get("error"))
                        .and_then(|m| m.as_str())
                        .map(str::to_string)
                });
            if status == reqwest::StatusCode::UNAUTHORIZED {
                bail!("{what}: the server rejected the token (401) — run `astra-cli login` again");
            }
            // A 413 without the daemon's JSON body came from a proxy in
            // front of it (Cloudflare caps request bodies at 100 MB).
            if status == reqwest::StatusCode::PAYLOAD_TOO_LARGE && server_message.is_none() {
                bail!(
                    "{what}: a proxy in front of the server refused the request body (413) — try a smaller --chunk-mb"
                );
            }
            bail!(
                "{what} failed ({status}): {}",
                server_message.unwrap_or(body)
            );
        }
        resp.json()
            .with_context(|| format!("{what}: unexpected response"))
    }

    pub fn me(&self) -> Result<Me> {
        let resp = self
            .http
            .get(self.url("/api/me"))
            .bearer_auth(&self.token)
            .send()
            .map_err(|e| anyhow!("{} unreachable: {e}", self.base))?;
        Self::parse(resp, "identity check")
    }

    pub fn collections(&self) -> Result<Vec<Collection>> {
        let resp = self
            .http
            .get(self.url("/api/collections"))
            .bearer_auth(&self.token)
            .send()
            .map_err(|e| anyhow!("{} unreachable: {e}", self.base))?;
        Self::parse(resp, "listing collections")
    }

    pub fn register(&self, body: &Register<'_>) -> Result<Registered> {
        let resp = self
            .http
            .post(self.url("/api/upload/images"))
            .bearer_auth(&self.token)
            .json(body)
            .send()
            .map_err(|e| anyhow!("{} unreachable: {e}", self.base))?;
        Self::parse(resp, "registering image")
    }

    /// The caller's image whose stored bytes have this blake3, if any.
    pub fn find_by_hash(&self, blake3_hex: &str) -> Result<Option<FoundImage>> {
        let resp = self
            .http
            .get(self.url(&format!("/api/upload/images/by-hash/{blake3_hex}")))
            .bearer_auth(&self.token)
            .send()
            .map_err(|e| anyhow!("{} unreachable: {e}", self.base))?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        Self::parse(resp, "looking up image by content").map(Some)
    }

    /// Send a processed image as the rendition of an existing image. One
    /// request, no chunking: renditions are JPEG/PNG/TIFF exports, and the
    /// server caps them like assets.
    pub fn attach_rendition(
        &self,
        image_id: &str,
        blake3_hex: &str,
        path: &Path,
        content_type: &str,
        tool: Option<&str>,
    ) -> Result<RenditionStored> {
        let file =
            std::fs::File::open(path).with_context(|| format!("opening {}", path.display()))?;
        let len = file.metadata()?.len();
        let filename = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let mut query = format!("filename={}", percent_encode(&filename));
        if let Some(tool) = tool {
            query.push_str(&format!("&tool={}", percent_encode(tool)));
        }
        let resp = self
            .http
            .put(self.url(&format!("/api/images/{image_id}/rendition?{query}")))
            .bearer_auth(&self.token)
            .header("x-astra-content-hash", blake3_hex)
            .header(reqwest::header::CONTENT_TYPE, content_type)
            .header(reqwest::header::CONTENT_LENGTH, len)
            .body(reqwest::blocking::Body::sized(file, len))
            .send()
            .map_err(|e| anyhow!("{} unreachable: {e}", self.base))?;
        Self::parse(resp, "attaching rendition")
    }

    /// Send the file as the image's asset. Small files go in one request;
    /// anything over the chunk size goes through the parts route in
    /// sequential pieces, resuming where the server says it left off.
    /// Either way the server verifies the whole-file hash and answers
    /// `skipped` when it already holds those bytes.
    pub fn put_asset(&self, image_id: &str, blake3_hex: &str, path: &Path) -> Result<AssetStored> {
        let file =
            std::fs::File::open(path).with_context(|| format!("opening {}", path.display()))?;
        let len = file.metadata()?.len();
        if self.chunk_bytes > 0 && len > self.chunk_bytes {
            return self.put_asset_parts(image_id, blake3_hex, path, file, len);
        }
        let resp = self
            .http
            .put(self.url(&format!("/api/push/images/{image_id}/asset")))
            .bearer_auth(&self.token)
            .header("x-astra-content-hash", blake3_hex)
            .header(reqwest::header::CONTENT_LENGTH, len)
            .body(reqwest::blocking::Body::sized(file, len))
            .send()
            .map_err(|e| anyhow!("{} unreachable: {e}", self.base))?;
        Self::parse(resp, "uploading asset")
    }

    fn put_asset_parts(
        &self,
        image_id: &str,
        blake3_hex: &str,
        path: &Path,
        mut file: std::fs::File,
        len: u64,
    ) -> Result<AssetStored> {
        use std::io::{IsTerminal, Read, Seek, SeekFrom};

        #[derive(Deserialize)]
        struct Progress {
            received: Option<u64>,
        }

        let url = self.url(&format!("/api/push/images/{image_id}/asset/parts"));
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let tty = std::io::stderr().is_terminal();
        let mut offset = 0u64;
        let mut buf = Vec::with_capacity(self.chunk_bytes as usize);
        let mut last_conflict: Option<u64> = None;
        loop {
            let end = (offset + self.chunk_bytes).min(len); // exclusive
            buf.clear();
            buf.resize((end - offset) as usize, 0);
            file.seek(SeekFrom::Start(offset))?;
            file.read_exact(&mut buf)
                .with_context(|| format!("reading {} at byte {offset}", path.display()))?;
            if tty {
                eprint!(
                    "\r  {name}: sending {}/{} MiB",
                    offset >> 20,
                    len.div_ceil(1 << 20)
                );
            }
            let resp = self
                .http
                .put(&url)
                .bearer_auth(&self.token)
                .header("x-astra-content-hash", blake3_hex)
                .header(
                    reqwest::header::CONTENT_RANGE,
                    format!("bytes {offset}-{}/{len}", end - 1),
                )
                .body(buf.clone())
                .send()
                .map_err(|e| anyhow!("{} unreachable: {e}", self.base))?;

            if resp.status() == reqwest::StatusCode::CONFLICT {
                // The server already holds a different prefix of this
                // file (an earlier run was cut off): continue from there.
                let received = resp
                    .json::<Progress>()
                    .ok()
                    .and_then(|p| p.received)
                    .ok_or_else(|| anyhow!("uploading asset: server refused the part at byte {offset} without saying where to resume"))?;
                if received > len || last_conflict == Some(received) {
                    bail!("uploading asset: the server's partial copy of {name} is unusable (received={received}); retry with --force");
                }
                last_conflict = Some(received);
                offset = received;
                continue;
            }
            if end < len {
                let _: Progress = Self::parse(resp, "uploading asset part")?;
                offset = end;
                continue;
            }
            if tty {
                eprint!("\r\x1b[K");
            }
            return Self::parse(resp, "uploading asset");
        }
    }
}

/// Minimal query-string encoding (RFC 3986 unreserved bytes pass through).
fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn percent_encoding_covers_spaces_and_path_separators() {
        assert_eq!(super::percent_encode("M42 final.png"), "M42%20final.png");
        assert_eq!(super::percent_encode("C:\\out\\x"), "C%3A%5Cout%5Cx");
        assert_eq!(super::percent_encode("PixInsight"), "PixInsight");
    }
}
