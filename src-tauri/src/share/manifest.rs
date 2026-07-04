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

/// Parse a FITS integer value from the fitrs debug format
fn parse_fits_int(val: Option<&serde_json::Value>) -> Option<u32> {
    let val = val?;
    let s = match val.as_str() {
        Some(s) => s.to_string(),
        None => val.to_string().trim_matches('"').to_string(),
    };
    // Try: Some(IntegerNumber(6248))
    if let Some(caps) = s.strip_prefix("Some(IntegerNumber(") {
        if let Some(num) = caps.strip_suffix("))") {
            return num.parse().ok();
        }
    }
    // Try: IntegerNumber(6248)
    if let Some(caps) = s.strip_prefix("IntegerNumber(") {
        if let Some(num) = caps.strip_suffix(")") {
            return num.parse().ok();
        }
    }
    // Try plain number
    s.parse().ok()
}

fn content_type_for_filename(filename: &str) -> &'static str {
    let ext = std::path::Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "fit" | "fits" => "image/fits",
        _ => "application/octet-stream",
    }
}

/// Build a [`ManifestImage`] straight from a database row — catalog ids from
/// annotations + summary, plate solve and overlay objects from metadata.
/// (Ported from the worker-era push flow; the daemon now builds manifests
/// live at request time.)
pub fn manifest_image_from_row(image: &crate::db::models::Image) -> ManifestImage {
    let ext = std::path::Path::new(&image.filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpg");

    // Catalog IDs from annotation names.
    let mut catalog_ids: Vec<String> = image
        .annotations
        .as_ref()
        .map(|ann| {
            serde_json::from_str::<Vec<serde_json::Value>>(ann)
                .unwrap_or_default()
                .iter()
                .filter_map(|obj| {
                    obj.get("name")
                        .and_then(|n| n.as_str())
                        .map(|name| name.replace(' ', "").to_uppercase())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    // Messier IDs from the summary: "M 101", "M101", "Messier 101".
    let upper = image.summary.clone().unwrap_or_default().to_uppercase();
    {
        let normalized = upper.replace(' ', "");
        let bytes = normalized.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'M' && i + 1 < bytes.len() && bytes[i + 1].is_ascii_digit() {
                let start = i;
                i += 1;
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
                let mid = normalized[start..i].to_string();
                if !catalog_ids.contains(&mid) {
                    catalog_ids.push(mid);
                }
            } else {
                i += 1;
            }
        }
    }
    if let Some(pos) = upper.find("MESSIER") {
        let after = &upper[pos + 7..].trim_start();
        let num: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !num.is_empty() {
            let mid = format!("M{}", num);
            if !catalog_ids.contains(&mid) {
                catalog_ids.push(mid);
            }
        }
    }

    // Plate solve + overlay objects from metadata.
    let (plate_solve, objects) = image
        .metadata
        .as_ref()
        .map(|meta| {
            let parsed: serde_json::Value = serde_json::from_str(meta).unwrap_or_default();
            let ps = parsed.get("plate_solve").and_then(|ps| {
                Some(ManifestPlateSolve {
                    center_ra: ps.get("center_ra")?.as_f64()?,
                    center_dec: ps.get("center_dec")?.as_f64()?,
                    pixel_scale: ps.get("pixel_scale")?.as_f64()?,
                    rotation: ps.get("rotation")?.as_f64()?,
                    width_deg: ps.get("width_deg")?.as_f64()?,
                    height_deg: ps.get("height_deg")?.as_f64()?,
                    image_width: parse_fits_int(parsed.get("NAXIS1")).or_else(|| {
                        ps.get("image_width").and_then(|v| v.as_u64()).map(|v| v as u32)
                    }),
                    image_height: parse_fits_int(parsed.get("NAXIS2")).or_else(|| {
                        ps.get("image_height").and_then(|v| v.as_u64()).map(|v| v as u32)
                    }),
                })
            });
            let objs: Vec<ManifestObject> = image
                .annotations
                .as_ref()
                .map(|ann| {
                    serde_json::from_str::<Vec<serde_json::Value>>(ann)
                        .unwrap_or_default()
                        .iter()
                        .filter_map(|obj| {
                            Some(ManifestObject {
                                name: obj.get("name")?.as_str()?.to_string(),
                                ra: obj.get("ra")?.as_f64()?,
                                dec: obj.get("dec")?.as_f64()?,
                                magnitude: obj.get("magnitude").and_then(|v| v.as_f64()),
                                size_arcmin: obj.get("sizeArcmin").and_then(|v| v.as_f64()),
                                pixel_x: obj.get("pixelX").and_then(|v| v.as_f64()),
                                pixel_y: obj.get("pixelY").and_then(|v| v.as_f64()),
                                radius_px: obj.get("radiusPx").and_then(|v| v.as_f64()),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            (ps, objs)
        })
        .unwrap_or((None, vec![]));

    ManifestImage {
        id: image.id.clone(),
        filename: image.filename.clone(),
        summary: image.summary.clone(),
        content_type: image
            .content_type
            .clone()
            .unwrap_or_else(|| content_type_for_filename(&image.filename).to_string()),
        image_path: format!("images/{}.{}", image.id, ext),
        thumb_path: format!("thumbs/{}.jpg", image.id),
        created_at: image.created_at.to_string(),
        favorite: image.favorite,
        catalog_ids,
        plate_solve,
        objects,
    }
}

/// Build the full live manifest for a collection from database rows,
/// including the dateFilter range from collection metadata.
pub fn build_manifest_for_collection(
    collection: &crate::db::models::Collection,
    images: &[crate::db::models::Image],
) -> ShareManifest {
    let date_range = collection.metadata.as_ref().and_then(|meta| {
        let parsed: serde_json::Value = serde_json::from_str(meta).ok()?;
        let df = parsed.get("dateFilter")?;
        let start = df.get("start")?.as_str()?.to_string();
        let end = df.get("end")?.as_str()?.to_string();
        Some((start, end))
    });

    build_manifest(
        &collection.name,
        collection.description.as_deref(),
        collection.template.as_deref(),
        images.iter().map(manifest_image_from_row).collect(),
        date_range.as_ref().map(|(s, e)| (s.as_str(), e.as_str())),
    )
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
