//! Python integration module using PyO3
//!
//! This module provides a bridge to Python astronomy libraries for features
//! that are best implemented in Python (SIMBAD queries, altitude calculations, etc.)

pub mod simbad;
pub mod altitude;
pub mod plate_solve;
pub mod skymap;

use pyo3::prelude::*;
use std::path::PathBuf;
use std::sync::OnceLock;

static PYTHON_INITIALIZED: OnceLock<bool> = OnceLock::new();

/// Initialize the Python interpreter and add the astra_astro module to the path
pub fn init_python(python_path: Option<PathBuf>) -> PyResult<()> {
    PYTHON_INITIALIZED.get_or_init(|| {
        Python::with_gil(|py| {
            // Add our Python module to the path
            let sys = py.import("sys")?;
            let path: Bound<'_, pyo3::types::PyList> = sys.getattr("path")?.downcast_into()?;

            if let Some(ref p) = python_path {
                // Add the module path
                path.insert(0, p.to_string_lossy().to_string())?;

                // Also add the venv's site-packages if it exists
                // This ensures dependencies like starplot are available
                // Try Python 3.12 first (matches PyO3's linked Python)
                let venv_site_packages_312 = p.join(".venv/lib/python3.12/site-packages");
                if venv_site_packages_312.exists() {
                    path.insert(0, venv_site_packages_312.to_string_lossy().to_string())?;
                    log::info!("Added venv site-packages to Python path: {:?}", venv_site_packages_312);
                }

                // Try Python 3.14 as fallback
                let venv_site_packages = p.join(".venv/lib/python3.14/site-packages");
                if venv_site_packages.exists() {
                    path.insert(0, venv_site_packages.to_string_lossy().to_string())?;
                    log::info!("Added venv site-packages to Python path: {:?}", venv_site_packages);
                }
            }

            // Try to import our module to verify it's accessible
            match py.import("astra_astro") {
                Ok(_) => {
                    log::info!("Python astra_astro module loaded successfully");
                }
                Err(e) => {
                    log::warn!("Could not load astra_astro module: {}", e);
                    // Don't fail - the module might not be installed yet
                }
            }

            Ok::<(), PyErr>(())
        }).map_err(|e| {
            log::error!("Failed to initialize Python: {}", e);
            e
        }).ok();

        true
    });

    Ok(())
}
