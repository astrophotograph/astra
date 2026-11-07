//! `astra-cli attach`: send a processed JPEG/PNG/TIFF as the rendition of
//! an image already on the server. The FITS stays the original; the server
//! stores the file as the image's full-size processed master and derives
//! the preview and thumbnail from it (`PUT /api/images/{id}/rendition`).

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

use crate::client::Client;
use crate::ledger::{self, Ledger};
use crate::upload::hash_file;

/// Extensions a sibling original may carry, in the order they are tried.
const ORIGINAL_EXTENSIONS: [&str; 4] = ["fit", "fits", "fts", "xisf"];

/// MIME type for the rendition, from its extension. The server sniffs the
/// bytes too, so an unknown extension is sent as octet-stream rather than
/// refused here.
pub fn content_type_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("tif" | "tiff") => "image/tiff",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
}

/// The original next to `processed` with the same stem (`M42.jpg` →
/// `M42.fit`), if one exists. Seestar and most stackers write pairs this
/// way, so `attach M42.jpg` needs no `--to`.
pub fn sibling_original(processed: &Path) -> Option<PathBuf> {
    let stem = processed.file_stem()?;
    let dir = processed.parent().unwrap_or_else(|| Path::new("."));
    ORIGINAL_EXTENSIONS
        .iter()
        .flat_map(|ext| [ext.to_string(), ext.to_ascii_uppercase()])
        .map(|ext| dir.join(format!("{}.{ext}", stem.to_string_lossy())))
        .find(|candidate| candidate.is_file())
}

/// What `--to` (or the sibling rule) resolved to.
#[derive(Debug, PartialEq, Eq)]
pub enum Target {
    /// A server image id, used as given.
    Id(String),
    /// A local original: looked up in the ledger, then on the server by
    /// content hash.
    Original(PathBuf),
}

pub fn resolve_target(to: Option<&str>, processed: &Path) -> Result<Target> {
    match to {
        Some(to) if Path::new(to).is_file() => Ok(Target::Original(PathBuf::from(to))),
        Some(to) if to.trim().is_empty() => bail!("--to must be an image id or a file path"),
        Some(to) => Ok(Target::Id(to.trim().to_string())),
        None => match sibling_original(processed) {
            Some(original) => Ok(Target::Original(original)),
            None => bail!(
                "no original found next to {} (tried the same name with .fit/.fits/.fts/.xisf); pass --to <image id or original file>",
                processed.display()
            ),
        },
    }
}

/// The server image id for a local original: the ledger first (free),
/// then the server's content-hash lookup.
pub fn image_id_for_original(client: &Client, ledger: &Ledger, original: &Path) -> Result<String> {
    let stamp = ledger::stamp(original)?;
    if let Some(entry) = ledger.lookup(original, stamp) {
        return Ok(entry.image_id.clone());
    }
    let hash = hash_file(original)?;
    match client.find_by_hash(&hash)? {
        Some(found) => Ok(found.id),
        None => bail!(
            "{} has not been uploaded to this server; run `astra-cli upload {}` first",
            original.display(),
            original.display()
        ),
    }
}

pub fn attach(
    client: &Client,
    ledger: &Ledger,
    processed: &Path,
    to: Option<&str>,
    tool: Option<&str>,
) -> Result<()> {
    if !processed.is_file() {
        bail!("{} is not a file", processed.display());
    }
    let image_id = match resolve_target(to, processed)? {
        Target::Id(id) => id,
        Target::Original(original) => {
            let id = image_id_for_original(client, ledger, &original)?;
            println!("  {} is image {id}", original.display());
            id
        }
    };
    let hash = hash_file(processed)?;
    let stored = client
        .attach_rendition(&image_id, &hash, processed, content_type_for(processed), tool)
        .with_context(|| format!("attaching {}", processed.display()))?;
    match stored.status.as_str() {
        "skipped" => println!(
            "= {}  (image {image_id} already has this rendition)",
            processed.display()
        ),
        _ => {
            let dims = stored
                .preview
                .map(|p| format!(", {}x{} preview", p.width, p.height))
                .unwrap_or_default();
            println!(
                "+ {}  (rendition of image {image_id}{dims})",
                processed.display()
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_types_from_extension() {
        assert_eq!(content_type_for(Path::new("a.JPG")), "image/jpeg");
        assert_eq!(content_type_for(Path::new("a.tif")), "image/tiff");
        assert_eq!(content_type_for(Path::new("a.png")), "image/png");
        assert_eq!(content_type_for(Path::new("a")), "application/octet-stream");
    }

    #[test]
    fn sibling_rule_pairs_same_stem_originals() {
        let dir = tempfile::tempdir().unwrap();
        let jpg = dir.path().join("Stacked_120_M42.jpg");
        std::fs::write(&jpg, b"x").unwrap();
        assert_eq!(sibling_original(&jpg), None);
        assert!(resolve_target(None, &jpg).is_err());

        let fit = dir.path().join("Stacked_120_M42.fit");
        std::fs::write(&fit, b"y").unwrap();
        assert_eq!(sibling_original(&jpg), Some(fit.clone()));
        assert_eq!(resolve_target(None, &jpg).unwrap(), Target::Original(fit.clone()));

        // An explicit --to wins: a file path or an id
        assert_eq!(
            resolve_target(Some(fit.to_str().unwrap()), &jpg).unwrap(),
            Target::Original(fit)
        );
        assert_eq!(
            resolve_target(Some("abc-123"), &jpg).unwrap(),
            Target::Id("abc-123".into())
        );
    }
}
