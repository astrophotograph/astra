//! Thin blocking client for the daemon routes the CLI needs.

use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;

use crate::config::Credentials;

pub struct Client {
    base: String,
    token: String,
    http: reqwest::blocking::Client,
}

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
        }
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
            let message = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| {
                    v.get("message")
                        .or_else(|| v.get("error"))
                        .and_then(|m| m.as_str())
                        .map(str::to_string)
                })
                .unwrap_or(body);
            if status == reqwest::StatusCode::UNAUTHORIZED {
                bail!("{what}: the server rejected the token (401) — run `astra-cli login` again");
            }
            bail!("{what} failed ({status}): {message}");
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

    /// Stream the file as the asset body. The server verifies the hash
    /// and answers `skipped` when it already holds those bytes.
    pub fn put_asset(&self, image_id: &str, blake3_hex: &str, path: &Path) -> Result<AssetStored> {
        let file =
            std::fs::File::open(path).with_context(|| format!("opening {}", path.display()))?;
        let len = file.metadata()?.len();
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
}
