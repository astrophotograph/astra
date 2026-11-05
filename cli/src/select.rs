//! Which files count as uploadable — the desktop auto-importer's stacked
//! frame heuristics (ASI Air, SharpCap, Seestar layouts), so a watched
//! folder uploads the same set the desktop would have imported.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

const IMAGE_EXTS: &[&str] = &[
    "fit", "fits", "fts", "xisf", "jpg", "jpeg", "png", "tif", "tiff",
];

fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default()
}

fn lower_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

fn lower_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase()
}

pub fn is_image(path: &Path) -> bool {
    IMAGE_EXTS.contains(&ext_of(path).as_str())
}

/// Dark/flat/bias frames and masters, by name or directory.
pub fn is_calibration(path: &Path) -> bool {
    let p = lower_path(path);
    let n = lower_name(path);
    p.contains("/dark/")
        || p.contains("/flat/")
        || p.contains("/bias/")
        || p.contains("/darks/")
        || p.contains("/flats/")
        || n.starts_with("dark_")
        || n.starts_with("flat_")
        || n.starts_with("bias_")
        || n.starts_with("master_")
}

/// Raw light subframes: ASI Air `Light_*.fit` under `/Light/`, SharpCap
/// `frame_*` under `/rawframes/`, Seestar `*_sub/` folders.
pub fn is_subframe(path: &Path) -> bool {
    let p = lower_path(path);
    let n = lower_name(path);
    (n.starts_with("light_")
        || n.starts_with("frame_")
        || p.contains("/rawframes/")
        || p.contains("_sub/"))
        && !is_stacked(path)
}

/// Stacked output: in a `Stacked/` directory, or `Stack_`/`Stacked_`
/// prefixed, or "stacked" anywhere in the name. Seestar thumbnails
/// (`*_thn.jpg`) are never stacked images.
pub fn is_stacked(path: &Path) -> bool {
    let p = lower_path(path);
    let n = lower_name(path);
    if !is_image(path) || n.ends_with("_thn.jpg") || is_calibration(path) {
        return false;
    }
    p.contains("/stacked/")
        || n.starts_with("stack_")
        || n.starts_with("stacked")
        || n.contains("stacked")
        || n.contains("_stack.")
}

/// What a directory walk keeps: stacked frames, or with `all` any image
/// that is not calibration or a raw subframe.
pub fn wanted(path: &Path, all: bool) -> bool {
    if !is_image(path) || is_calibration(path) || lower_name(path).ends_with("_thn.jpg") {
        return false;
    }
    if all {
        !is_subframe(path)
    } else {
        is_stacked(path)
    }
}

/// Explicit files are taken as given; directories are walked (one level,
/// or fully with `recursive`) and filtered through [`wanted`].
pub fn expand(paths: &[PathBuf], recursive: bool, all: bool) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for path in paths {
        if path.is_file() {
            out.push(path.clone());
        } else if path.is_dir() {
            out.extend(walk(path, recursive, all)?);
        } else {
            bail!("{} does not exist", path.display());
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
}

pub fn walk(dir: &Path, recursive: bool, all: bool) -> Result<Vec<PathBuf>> {
    let depth = if recursive { usize::MAX } else { 1 };
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(dir)
        .max_depth(depth)
        .follow_links(true)
    {
        let entry = entry.with_context(|| format!("walking {}", dir.display()))?;
        if entry.file_type().is_file() && wanted(entry.path(), all) {
            out.push(entry.into_path());
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn stacked_layouts() {
        assert!(is_stacked(&p(
            "/asiair/Autorun/Light/M42/Stacked/Stack_M42.fit"
        )));
        assert!(is_stacked(&p("/data/Stack_16bits_13frames_130s.fits")));
        assert!(is_stacked(&p(
            "/seestar/MyWorks/M 42/Stacked_120_M 42_10.0s_IRCUT_20240101.fit"
        )));
        assert!(is_stacked(&p("/seestar/MyWorks/M 42/Stacked_120_M 42.jpg")));
        assert!(is_stacked(&p("/data/M42_stacked.xisf")));
        assert!(!is_stacked(&p(
            "/seestar/MyWorks/M 42/Stacked_120_M 42_thn.jpg"
        )));
        assert!(!is_stacked(&p(
            "/asiair/Autorun/Light/M42/Light_M42_10s.fit"
        )));
        assert!(!is_stacked(&p("/data/Dark/Dark_10s.fit")));
        assert!(!is_stacked(&p("/data/notes.txt")));
    }

    #[test]
    fn all_mode_keeps_images_but_not_subs_or_calibration() {
        assert!(wanted(&p("/data/final_M31.tif"), true));
        assert!(!wanted(&p("/data/final_M31.tif"), false));
        assert!(!wanted(
            &p("/asiair/Autorun/Light/M42/Light_M42_10s.fit"),
            true
        ));
        assert!(!wanted(
            &p("/seestar/MyWorks/M 42_sub/Light_0001.fit"),
            true
        ));
        assert!(!wanted(&p("/data/Flat/Flat_001.fit"), true));
        assert!(!wanted(
            &p("/seestar/MyWorks/M 42/Stacked_120_M 42_thn.jpg"),
            true
        ));
    }

    #[test]
    fn expand_walks_and_filters() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("M42/Stacked")).unwrap();
        std::fs::create_dir_all(root.join("M42/Light")).unwrap();
        std::fs::write(root.join("M42/Stacked/Stack_1.fit"), b"x").unwrap();
        std::fs::write(root.join("M42/Light/Light_1.fit"), b"x").unwrap();
        std::fs::write(root.join("Stacked_top.jpg"), b"x").unwrap();
        std::fs::write(root.join("readme.md"), b"x").unwrap();

        let shallow = expand(&[root.to_path_buf()], false, false).unwrap();
        assert_eq!(shallow, vec![root.join("Stacked_top.jpg")]);

        let deep = expand(&[root.to_path_buf()], true, false).unwrap();
        assert_eq!(
            deep,
            vec![
                root.join("M42/Stacked/Stack_1.fit"),
                root.join("Stacked_top.jpg")
            ]
        );

        // An explicit file is always taken, filter or not.
        let explicit = expand(&[root.join("readme.md")], false, false).unwrap();
        assert_eq!(explicit, vec![root.join("readme.md")]);
        assert!(expand(&[root.join("missing")], false, false).is_err());
    }
}
