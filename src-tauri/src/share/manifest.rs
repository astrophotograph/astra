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
    /// Plate solve info for object overlay
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plate_solve: Option<ManifestPlateSolve>,
    /// Catalog objects found in FOV (for overlay)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub objects: Vec<ManifestObject>,
}

/// Plate solve data for an image.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestPlateSolve {
    pub center_ra: f64,
    pub center_dec: f64,
    pub pixel_scale: f64,
    pub rotation: f64,
    pub width_deg: f64,
    pub height_deg: f64,
    pub image_width: Option<u32>,
    pub image_height: Option<u32>,
}

/// A catalog object for overlay display.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestObject {
    pub name: String,
    pub ra: f64,
    pub dec: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub magnitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_arcmin: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pixel_x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pixel_y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub radius_px: Option<f64>,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_image(id: &str) -> ManifestImage {
        ManifestImage {
            id: id.to_string(),
            filename: format!("{}.jpg", id),
            summary: Some("M42".to_string()),
            content_type: "image/jpeg".to_string(),
            image_path: format!("images/{}.jpg", id),
            thumb_path: format!("thumbs/{}.jpg", id),
            created_at: "2026-01-15T20:00:00Z".to_string(),
            favorite: false,
            catalog_ids: vec![],
            plate_solve: None,
            objects: vec![],
        }
    }

    #[test]
    fn build_manifest_no_images() {
        let manifest = build_manifest("Empty Collection", None, None, vec![], None);

        assert_eq!(manifest.version, 1);
        assert_eq!(manifest.collection_name, "Empty Collection");
        assert_eq!(manifest.collection_description, None);
        assert_eq!(manifest.template, None);
        assert_eq!(manifest.image_count, 0);
        assert!(manifest.images.is_empty());
        assert_eq!(manifest.date_range_start, None);
        assert_eq!(manifest.date_range_end, None);
        // updated_at should be a valid RFC3339 timestamp
        assert!(manifest.updated_at.contains('T'));
    }

    #[test]
    fn build_manifest_with_images_plate_solve_and_objects() {
        let mut img = make_test_image("img-1");
        img.plate_solve = Some(ManifestPlateSolve {
            center_ra: 83.822,
            center_dec: -5.391,
            pixel_scale: 1.5,
            rotation: 0.5,
            width_deg: 1.2,
            height_deg: 0.8,
            image_width: Some(4096),
            image_height: Some(2160),
        });
        img.objects = vec![ManifestObject {
            name: "M42".to_string(),
            ra: 83.822,
            dec: -5.391,
            magnitude: Some(4.0),
            size_arcmin: Some(85.0),
            pixel_x: Some(2048.0),
            pixel_y: Some(1080.0),
            radius_px: Some(500.0),
        }];
        img.catalog_ids = vec!["M42".to_string(), "NGC 1976".to_string()];

        let manifest = build_manifest(
            "Orion Session",
            Some("Winter imaging"),
            None,
            vec![img],
            None,
        );

        assert_eq!(manifest.image_count, 1);
        assert_eq!(manifest.collection_description, Some("Winter imaging".to_string()));

        let image = &manifest.images[0];
        assert_eq!(image.catalog_ids, vec!["M42", "NGC 1976"]);
        assert!(image.plate_solve.is_some());
        let ps = image.plate_solve.as_ref().unwrap();
        assert!((ps.center_ra - 83.822).abs() < 0.001);
        assert_eq!(ps.image_width, Some(4096));
        assert_eq!(image.objects.len(), 1);
        assert_eq!(image.objects[0].name, "M42");
    }

    #[test]
    fn build_manifest_messier_template() {
        let manifest = build_manifest(
            "Messier Catalog",
            Some("All 110 Messier objects"),
            Some("messier"),
            vec![make_test_image("m1"), make_test_image("m2")],
            None,
        );

        assert_eq!(manifest.template, Some("messier".to_string()));
        assert_eq!(manifest.image_count, 2);
    }

    #[test]
    fn build_manifest_date_range_both() {
        let manifest = build_manifest(
            "Session",
            None,
            None,
            vec![],
            Some(("2026-01-01", "2026-01-31")),
        );

        assert_eq!(manifest.date_range_start, Some("2026-01-01".to_string()));
        assert_eq!(manifest.date_range_end, Some("2026-01-31".to_string()));
    }

    #[test]
    fn build_manifest_date_range_none() {
        let manifest = build_manifest("Session", None, None, vec![], None);

        assert_eq!(manifest.date_range_start, None);
        assert_eq!(manifest.date_range_end, None);
    }
}
