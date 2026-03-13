---
name: Astra sharing domain
description: astra.gallery domain registered on Cloudflare for photo sharing feature
type: project
---

Domain **astra.gallery** registered on Cloudflare (2026-03-13) for sharing photo collections as read-only, auto-refreshing web pages.

**Why:** Users want to share collections (e.g., Messier Marathon progress) publicly. Images will sync to Cloudflare R2 object storage, following the same pattern as Nous (~/Projects/erewhon/nous/) which uses R2 + custom S3 signer for sharing.

**How to apply:** Use astra.gallery as the public URL base for shared collections. Architecture should follow the Nous pattern: R2 for image storage, custom domain pointing to R2/Workers, S3-compatible upload from the Tauri backend with a custom S3 signer in Rust.

Planned features:
- Auto-import photos from Seestar/ASI Air (possibly via external shell script + file watcher)
- Shared collections rendered as read-only, auto-refreshing web pages
- Images synchronized to Cloudflare R2
