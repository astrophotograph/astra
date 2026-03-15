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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_range_start: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_range_end: Option<String>,
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
    #[serde(default)]
    pub favorite: bool,
    /// Catalog object IDs matched from annotations (e.g., ["M31", "M32"])
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub catalog_ids: Vec<String>,
}

/// Build a manifest for a collection and its images.
pub fn build_manifest(
    collection_name: &str,
    collection_description: Option<&str>,
    template: Option<&str>,
    images: Vec<ManifestImage>,
    date_range: Option<(&str, &str)>,
) -> ShareManifest {
    ShareManifest {
        version: 1,
        collection_name: collection_name.to_string(),
        collection_description: collection_description.map(|s| s.to_string()),
        template: template.map(|s| s.to_string()),
        image_count: images.len(),
        updated_at: Utc::now().to_rfc3339(),
        images,
        date_range_start: date_range.map(|(s, _)| s.to_string()),
        date_range_end: date_range.map(|(_, e)| e.to_string()),
    }
}
