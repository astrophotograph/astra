//! HTTP client for the Astra daemon's push + publish API.
//!
//! Replaces the worker-era Clerk + presigned-R2 upload path: the desktop
//! authenticates with a personal access token (minted via
//! `astra_daemon --mint-token`) and speaks the daemon's `/api/push/*` and
//! `/api/collections/{id}/publish` endpoints directly.

use serde::Deserialize;

pub struct DaemonClient {
    base_url: String,
    token: String,
    http: reqwest::Client,
}

/// `GET /api/me` — daemon-native shape (camelCase).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeInfo {
    pub user_id: String,
    pub username: Option<String>,
    pub display_name: Option<String>,
    pub role: String,
    pub status: String,
}

/// `POST /api/push/collections` response.
#[derive(Debug, Deserialize)]
pub struct PushResponse {
    pub collection_id: String,
    pub images: Vec<PushImageStatus>,
}

#[derive(Debug, Deserialize)]
pub struct PushImageStatus {
    pub id: String,
    /// "needed" | "present"
    pub asset_status: String,
    pub blob_id: Option<String>,
}

/// `PUT /api/push/images/{id}/asset` response.
#[derive(Debug, Deserialize)]
pub struct AssetResponse {
    /// "stored" | "skipped"
    pub status: String,
    pub blob_id: String,
}

/// `POST /api/collections/{id}/publish` response (the publish record).
#[derive(Debug, Deserialize)]
pub struct PublishedRecord {
    pub id: String,
    pub slug: String,
    pub visibility: String,
}

impl DaemonClient {
    pub fn new(base_url: &str, token: &str) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            token: token.to_string(),
            http: reqwest::Client::new(),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base_url)
    }

    async fn parse<T: serde::de::DeserializeOwned>(
        resp: reqwest::Response,
        context: &str,
    ) -> Result<T, String> {
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("{context} failed ({status}): {body}"));
        }
        resp.json()
            .await
            .map_err(|e| format!("{context}: invalid response: {e}"))
    }

    /// Verify connectivity + token; returns the authenticated identity.
    pub async fn me(&self) -> Result<MeInfo, String> {
        let resp = self
            .http
            .get(self.url("/api/me"))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| format!("daemon unreachable: {e}"))?;
        Self::parse(resp, "identity check").await
    }

    pub async fn push_collection(
        &self,
        body: &serde_json::Value,
    ) -> Result<PushResponse, String> {
        let resp = self
            .http
            .post(self.url("/api/push/collections"))
            .bearer_auth(&self.token)
            .json(body)
            .send()
            .await
            .map_err(|e| format!("push request failed: {e}"))?;
        Self::parse(resp, "collection push").await
    }

    pub async fn put_asset(
        &self,
        image_id: &str,
        blake3_hex: &str,
        bytes: Vec<u8>,
    ) -> Result<AssetResponse, String> {
        let resp = self
            .http
            .put(self.url(&format!("/api/push/images/{image_id}/asset")))
            .bearer_auth(&self.token)
            .header("x-astra-content-hash", blake3_hex)
            .body(bytes)
            .send()
            .await
            .map_err(|e| format!("asset upload failed: {e}"))?;
        Self::parse(resp, "asset upload").await
    }

    pub async fn publish(&self, collection_id: &str) -> Result<PublishedRecord, String> {
        let resp = self
            .http
            .post(self.url(&format!("/api/collections/{collection_id}/publish")))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| format!("publish request failed: {e}"))?;
        Self::parse(resp, "publish").await
    }

    /// Remove the publish record. Treats "was not published" (404) as done.
    pub async fn unpublish(&self, collection_id: &str) -> Result<(), String> {
        let resp = self
            .http
            .delete(self.url(&format!("/api/collections/{collection_id}/publish")))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| format!("unpublish request failed: {e}"))?;
        let status = resp.status();
        if status.is_success() || status == reqwest::StatusCode::NOT_FOUND {
            Ok(())
        } else {
            let body = resp.text().await.unwrap_or_default();
            Err(format!("unpublish failed ({status}): {body}"))
        }
    }
}
