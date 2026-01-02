//! Python integration module using PyO3
//!
//! This module provides a bridge to Python astronomy libraries for features
//! that are best implemented in Python (SIMBAD queries, altitude calculations, etc.)

pub mod simbad;
pub mod altitude;
pub mod plate_solve;

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
                path.insert(0, p.to_string_lossy().to_string())?;
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
