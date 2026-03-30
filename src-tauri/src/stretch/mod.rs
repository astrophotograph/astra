//! Native image stretching pipeline for astrophotography.
//!
//! Replaces the Python/processinator pipeline with pure Rust for
//! significantly faster preview generation. Handles:
//! - FITS reading (via fitrs)
//! - Autocrop of dark stacking edges
//! - Per-channel normalization
//! - Background gradient removal (polynomial surface fit)
//! - MTF (Midtones Transfer Function) stretch
//! - JPEG output (via image crate)

mod autocrop;
mod gradient;
mod mtf;
mod pipeline;

pub use pipeline::{generate_preview, StretchParams};
