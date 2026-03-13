//! Share manifest types and builder.

use chrono::Utc;
use serde::{Deserialize, Serialize};

/// Manifest describing a shared collection gallery.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareManifest {
    pub version: u32,
    pub collection_name: String,
    pub collection_description: Option<String>,
    pub template: Option<String>,
    pub image_count: usize,
    pub updated_at: String,
    pub images: Vec<ManifestImage>,
}

/// An image entry in the manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestImage {
    pub id: String,
    pub filename: String,
    pub summary: Option<String>,
    pub content_type: String,
    pub image_path: String,
    pub thumb_path: String,
    pub created_at: String,
}

/// Build a manifest for a collection and its images.
pub fn build_manifest(
    collection_name: &str,
    collection_description: Option<&str>,
    template: Option<&str>,
    images: Vec<ManifestImage>,
) -> ShareManifest {
    ShareManifest {
        version: 1,
        collection_name: collection_name.to_string(),
        collection_description: collection_description.map(|s| s.to_string()),
        template: template.map(|s| s.to_string()),
        image_count: images.len(),
        updated_at: Utc::now().to_rfc3339(),
        images,
    }
}
