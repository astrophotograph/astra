//! Sharing module: publishing collections to the hosted Astra daemon.
//!
//! The worker-era Clerk loopback auth, S3 signer, and presigned-upload
//! modules were removed with the daemon pivot (see jj history to resurrect).
//! `manifest` and `viewer` stay: the daemon's public gallery pages reuse the
//! manifest shape and the single-file viewer.

pub mod config;
pub mod daemon_client;
pub mod manifest;
pub mod viewer;
