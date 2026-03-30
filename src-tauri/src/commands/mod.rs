//! Tauri command handlers for Astra

pub mod astronomy;
pub mod auto_import;
pub mod backup;
pub mod collections;
pub mod image_process;
pub mod images;
pub mod library_scan;
pub mod plate_solve;
pub mod scan;
pub mod schedules;
pub mod skymap;
pub mod targets;
pub mod share;
pub mod todos;

// Re-export all commands
pub use astronomy::*;
pub use auto_import::*;
pub use backup::*;
pub use collections::*;
pub use image_process::*;
pub use images::*;
pub use library_scan::*;
pub use plate_solve::*;
pub use scan::*;
pub use schedules::*;
pub use share::*;
pub use skymap::*;
pub use targets::*;
pub use todos::*;
