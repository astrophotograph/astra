//! Server-side publish model: a user's collection is public (or unlisted)
//! at `@username/slug`, recorded in `published_collections` daemon state —
//! replacing the Cloudflare worker's `shares/{id}` + `user-shares/` KV
//! records.
//!
//! Core fns only (no Tauri wrappers yet — the desktop publish flow moves to
//! daemon push in a later leaf). The daemon exposes these under
//! `/api/collections/{id}/publish`; `resolve_public_collection` is what the
//! public gallery page calls.

use diesel::prelude::*;
use serde::{Deserialize, Serialize};

use super::collections::fetch_owned_collection;
use crate::db::models::{Collection, PublishedCollection};
use crate::db::repository;
use crate::db::schema::{collections, published_collections, users};
use crate::db::DbPool;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PublishVisibility {
    /// Listed on the owner's public profile and resolvable by URL.
    Public,
    /// Resolvable by URL only; absent from public listings.
    Unlisted,
}

impl PublishVisibility {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Unlisted => "unlisted",
        }
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "public" => Ok(Self::Public),
            "unlisted" => Ok(Self::Unlisted),
            other => Err(format!("unknown publish visibility '{other}'")),
        }
    }
}

/// Slug rules identical to the legacy worker publish path (`share.rs`), so
/// pre-pivot gallery URLs keep their slugs: lowercase, non-alphanumeric →
/// `-`, runs collapsed, ends trimmed.
pub fn slugify(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// Publish a collection (idempotent upsert). First publish picks a
/// collision-safe slug from the collection name (or `slug_override`);
/// re-publishing keeps the existing slug stable and refreshes title,
/// visibility, and `updated_at`.
pub fn publish_collection_core(
    db: &DbPool,
    user_id: &str,
    collection_id: &str,
    visibility: PublishVisibility,
    slug_override: Option<&str>,
) -> Result<PublishedCollection, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    let collection = fetch_owned_collection(&mut conn, user_id, collection_id)?
        .ok_or_else(|| format!("Collection not found: {collection_id}"))?;

    let existing: Option<PublishedCollection> = published_collections::table
        .filter(published_collections::collection_id.eq(collection_id))
        .first(&mut conn)
        .optional()
        .map_err(|e| e.to_string())?;

    if let Some(existing) = existing {
        diesel::update(published_collections::table.find(&existing.id))
            .set((
                published_collections::title.eq(&collection.name),
                published_collections::visibility.eq(visibility.as_str()),
                published_collections::updated_at.eq(chrono::Utc::now().naive_utc()),
            ))
            .execute(&mut conn)
            .map_err(|e| e.to_string())?;
        return published_collections::table
            .find(&existing.id)
            .first(&mut conn)
            .map_err(|e| e.to_string());
    }

    let base = {
        let s = slugify(slug_override.unwrap_or(&collection.name));
        if s.is_empty() {
            "collection".to_string()
        } else {
            s
        }
    };
    let mut slug = base.clone();
    let mut n = 1;
    loop {
        let taken: i64 = published_collections::table
            .filter(published_collections::user_id.eq(user_id))
            .filter(published_collections::slug.eq(&slug))
            .count()
            .get_result(&mut conn)
            .map_err(|e| e.to_string())?;
        if taken == 0 {
            break;
        }
        n += 1;
        slug = format!("{base}-{n}");
    }

    let id = uuid::Uuid::new_v4().to_string();
    diesel::insert_into(published_collections::table)
        .values((
            published_collections::id.eq(&id),
            published_collections::collection_id.eq(collection_id),
            published_collections::user_id.eq(user_id),
            published_collections::slug.eq(&slug),
            published_collections::title.eq(&collection.name),
            published_collections::visibility.eq(visibility.as_str()),
        ))
        .execute(&mut conn)
        .map_err(|e| e.to_string())?;

    published_collections::table
        .find(&id)
        .first(&mut conn)
        .map_err(|e| e.to_string())
}

/// Remove the publish record. Returns false when the collection isn't the
/// caller's or isn't published.
pub fn unpublish_collection_core(
    db: &DbPool,
    user_id: &str,
    collection_id: &str,
) -> Result<bool, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    if fetch_owned_collection(&mut conn, user_id, collection_id)?.is_none() {
        return Ok(false);
    }

    diesel::delete(
        published_collections::table
            .filter(published_collections::collection_id.eq(collection_id))
            .filter(published_collections::user_id.eq(user_id)),
    )
    .execute(&mut conn)
    .map(|n| n > 0)
    .map_err(|e| e.to_string())
}

pub fn get_publish_status_core(
    db: &DbPool,
    user_id: &str,
    collection_id: &str,
) -> Result<Option<PublishedCollection>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    if fetch_owned_collection(&mut conn, user_id, collection_id)?.is_none() {
        return Ok(None);
    }

    published_collections::table
        .filter(published_collections::collection_id.eq(collection_id))
        .first(&mut conn)
        .optional()
        .map_err(|e| e.to_string())
}

/// Public (not unlisted) galleries for a profile page, newest first.
pub fn list_public_for_user_core(
    db: &DbPool,
    username: &str,
) -> Result<Vec<PublishedCollection>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    let Some(user_id) = user_id_for_username(&mut conn, username)? else {
        return Ok(Vec::new());
    };

    published_collections::table
        .filter(published_collections::user_id.eq(&user_id))
        .filter(published_collections::visibility.eq(PublishVisibility::Public.as_str()))
        .order(published_collections::published_at.desc())
        .load(&mut conn)
        .map_err(|e| e.to_string())
}

/// A recent public gallery for the landing-page discovery strip.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentGallery {
    pub username: String,
    pub slug: String,
    pub title: String,
    /// RFC 3339 timestamp of first publish.
    pub published_at: String,
    pub image_count: i64,
    /// Public path to the cover thumbnail, or None for an empty collection.
    pub thumb_url: Option<String>,
}

/// The most recently published PUBLIC galleries across all users, newest
/// first. Unlisted galleries never appear (their URL is the only capability),
/// and a gallery whose owner has no username is skipped — its `@handle` link
/// would 404. `limit` caps the strip.
pub fn list_recent_public_core(db: &DbPool, limit: i64) -> Result<Vec<RecentGallery>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    let records: Vec<PublishedCollection> = published_collections::table
        .filter(published_collections::visibility.eq(PublishVisibility::Public.as_str()))
        .order(published_collections::published_at.desc())
        .limit(limit)
        .load(&mut conn)
        .map_err(|e| e.to_string())?;

    let mut out = Vec::with_capacity(records.len());
    for record in records {
        let username: Option<String> = users::table
            .find(&record.user_id)
            .select(users::username)
            .first::<Option<String>>(&mut conn)
            .optional()
            .map_err(|e| e.to_string())?
            .flatten();
        let Some(username) = username else { continue };

        let cover = repository::get_collection_cover_image_id(&mut conn, &record.collection_id)
            .map_err(|e| e.to_string())?;
        let image_count = repository::get_collection_image_count(&mut conn, &record.collection_id)
            .map_err(|e| e.to_string())?;

        let thumb_url = cover
            .as_ref()
            .map(|id| format!("/@{}/{}/thumbs/{}.jpg", username, record.slug, id));

        out.push(RecentGallery {
            username,
            slug: record.slug,
            title: record.title,
            published_at: record.published_at.and_utc().to_rfc3339(),
            image_count,
            thumb_url,
        });
    }

    Ok(out)
}

/// Resolve `@username/slug` to the publish record and its collection.
/// Unlisted galleries resolve too — the URL is the capability.
pub fn resolve_public_collection(
    db: &DbPool,
    username: &str,
    slug: &str,
) -> Result<Option<(PublishedCollection, Collection)>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    let Some(user_id) = user_id_for_username(&mut conn, username)? else {
        return Ok(None);
    };

    let record: Option<PublishedCollection> = published_collections::table
        .filter(published_collections::user_id.eq(&user_id))
        .filter(published_collections::slug.eq(slug))
        .first(&mut conn)
        .optional()
        .map_err(|e| e.to_string())?;

    let Some(record) = record else {
        return Ok(None);
    };

    let collection: Option<Collection> = collections::table
        .find(&record.collection_id)
        .first(&mut conn)
        .optional()
        .map_err(|e| e.to_string())?;

    Ok(collection.map(|c| (record, c)))
}

pub(crate) fn user_id_for_username(
    conn: &mut SqliteConnection,
    username: &str,
) -> Result<Option<String>, String> {
    users::table
        .filter(users::username.eq(username))
        .select(users::id)
        .first(conn)
        .optional()
        .map_err(|e| e.to_string())
}

/// One-shot backfill of the desktop's legacy metadata-embedded publish state
/// (`collections.metadata.share`, written by the Cloudflare-worker flow)
/// into `published_collections` rows. Idempotent: collections that already
/// have a publish record are skipped. Returns how many rows were created.
pub fn migrate_legacy_publish_metadata(db: &DbPool) -> Result<usize, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    let candidates: Vec<Collection> = collections::table
        .filter(collections::metadata.like("%\"share\"%"))
        .load(&mut conn)
        .map_err(|e| e.to_string())?;

    let mut created = 0;
    for collection in candidates {
        let Some(share) = collection
            .metadata
            .as_ref()
            .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok())
            .and_then(|v| v.get("share").cloned())
        else {
            continue;
        };

        let already: i64 = published_collections::table
            .filter(published_collections::collection_id.eq(&collection.id))
            .count()
            .get_result(&mut conn)
            .map_err(|e| e.to_string())?;
        if already > 0 {
            continue;
        }

        // Slug: last path segment of the legacy public URL, else re-slugify.
        let slug = share
            .get("publicUrl")
            .and_then(|u| u.as_str())
            .and_then(|u| u.trim_end_matches('/').rsplit('/').next())
            .map(str::to_string)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| slugify(&collection.name));

        let published_at = share
            .get("publishedAt")
            .and_then(|t| t.as_str())
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .map(|t| t.naive_utc())
            .unwrap_or_else(|| chrono::Utc::now().naive_utc());

        diesel::insert_into(published_collections::table)
            .values((
                published_collections::id.eq(uuid::Uuid::new_v4().to_string()),
                published_collections::collection_id.eq(&collection.id),
                published_collections::user_id.eq(&collection.user_id),
                published_collections::slug.eq(&slug),
                published_collections::title.eq(&collection.name),
                published_collections::visibility
                    .eq(PublishVisibility::Public.as_str()),
                published_collections::published_at.eq(published_at),
            ))
            .execute(&mut conn)
            .map_err(|e| format!("backfill publish for '{}': {e}", collection.name))?;
        log::info!(
            "migrated legacy publish record: '{}' (user {}) → slug '{slug}'",
            collection.name,
            collection.user_id
        );
        created += 1;
    }

    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::collections::{create_collection_core, CreateCollectionInput};
    use crate::db::test_support::{insert_user, test_pool};

    fn user_with_handle(db: &DbPool, id: &str, handle: &str) {
        insert_user(db, id);
        diesel::update(users::table.find(id))
            .set(users::username.eq(Some(handle)))
            .execute(&mut db.get().unwrap())
            .unwrap();
    }

    fn make_collection(db: &DbPool, user: &str, name: &str) -> Collection {
        create_collection_core(
            db,
            user,
            CreateCollectionInput {
                name: name.to_string(),
                description: None,
                visibility: None,
                template: None,
                tags: None,
            },
        )
        .unwrap()
    }

    #[test]
    fn publish_resolve_unpublish_round_trip() {
        let db = test_pool();
        user_with_handle(&db, "alice", "aliceh");
        let c = make_collection(&db, "alice", "My Nebulae!");

        let record =
            publish_collection_core(&db, "alice", &c.id, PublishVisibility::Public, None)
                .unwrap();
        assert_eq!(record.slug, "my-nebulae");
        assert_eq!(record.title, "My Nebulae!");

        let (resolved, collection) = resolve_public_collection(&db, "aliceh", "my-nebulae")
            .unwrap()
            .unwrap();
        assert_eq!(resolved.id, record.id);
        assert_eq!(collection.id, c.id);

        // Status visible to the owner; republish keeps the slug stable.
        assert!(get_publish_status_core(&db, "alice", &c.id).unwrap().is_some());
        let again =
            publish_collection_core(&db, "alice", &c.id, PublishVisibility::Unlisted, None)
                .unwrap();
        assert_eq!(again.id, record.id);
        assert_eq!(again.slug, "my-nebulae");
        assert_eq!(again.visibility, "unlisted");

        assert!(unpublish_collection_core(&db, "alice", &c.id).unwrap());
        assert!(resolve_public_collection(&db, "aliceh", "my-nebulae")
            .unwrap()
            .is_none());
        assert!(!unpublish_collection_core(&db, "alice", &c.id).unwrap());

        // Cross-user: bob can't publish or unpublish alice's collection.
        insert_user(&db, "bob");
        assert!(publish_collection_core(&db, "bob", &c.id, PublishVisibility::Public, None)
            .is_err());
        assert!(!unpublish_collection_core(&db, "bob", &c.id).unwrap());
    }

    #[test]
    fn slugs_are_collision_safe_per_user() {
        let db = test_pool();
        user_with_handle(&db, "alice", "aliceh");
        user_with_handle(&db, "bob", "bobh");

        let c1 = make_collection(&db, "alice", "Orion");
        let c2 = make_collection(&db, "alice", "Orion");
        let c3 = make_collection(&db, "bob", "Orion");

        let s1 = publish_collection_core(&db, "alice", &c1.id, PublishVisibility::Public, None)
            .unwrap();
        let s2 = publish_collection_core(&db, "alice", &c2.id, PublishVisibility::Public, None)
            .unwrap();
        // Same slug is fine for a different user.
        let s3 = publish_collection_core(&db, "bob", &c3.id, PublishVisibility::Public, None)
            .unwrap();
        assert_eq!(s1.slug, "orion");
        assert_eq!(s2.slug, "orion-2");
        assert_eq!(s3.slug, "orion");
    }

    #[test]
    fn unlisted_resolves_but_is_not_listed() {
        let db = test_pool();
        user_with_handle(&db, "alice", "aliceh");
        let pub_c = make_collection(&db, "alice", "Showcase");
        let unl_c = make_collection(&db, "alice", "Drafts");

        publish_collection_core(&db, "alice", &pub_c.id, PublishVisibility::Public, None)
            .unwrap();
        publish_collection_core(&db, "alice", &unl_c.id, PublishVisibility::Unlisted, None)
            .unwrap();

        let listed = list_public_for_user_core(&db, "aliceh").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].slug, "showcase");

        // The unlisted URL still works — the link is the capability.
        assert!(resolve_public_collection(&db, "aliceh", "drafts")
            .unwrap()
            .is_some());
        // Unknown profile resolves to nothing.
        assert!(list_public_for_user_core(&db, "ghost").unwrap().is_empty());
    }

    #[test]
    fn recent_public_lists_across_users_newest_first() {
        use crate::commands::images::{
            add_image_to_collection_core, create_image_core, CreateImageInput,
        };

        let db = test_pool();
        user_with_handle(&db, "alice", "aliceh");
        user_with_handle(&db, "bob", "bobh");

        // A cover image only on alice's public gallery.
        let alice_pub = make_collection(&db, "alice", "Andromeda");
        let img = create_image_core(
            &db,
            "alice",
            CreateImageInput {
                collection_id: None,
                filename: "m31.png".to_string(),
                url: None,
                summary: None,
                description: None,
                content_type: Some("image/png".to_string()),
                tags: None,
                visibility: None,
                location: None,
                annotations: None,
                metadata: None,
                thumbnail: None,
            },
        )
        .unwrap();
        add_image_to_collection_core(&db, "alice", &img.id, &alice_pub.id).unwrap();

        let bob_pub = make_collection(&db, "bob", "Orion");
        let alice_unlisted = make_collection(&db, "alice", "Drafts");

        let a = publish_collection_core(&db, "alice", &alice_pub.id, PublishVisibility::Public, None)
            .unwrap();
        let b =
            publish_collection_core(&db, "bob", &bob_pub.id, PublishVisibility::Public, None).unwrap();
        publish_collection_core(
            &db,
            "alice",
            &alice_unlisted.id,
            PublishVisibility::Unlisted,
            None,
        )
        .unwrap();

        // Publishes share a `published_at` instant, so pin distinct times to
        // test the `desc` ordering deterministically: bob newer than alice.
        let older = chrono::NaiveDate::from_ymd_opt(2026, 1, 1)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        let newer = chrono::NaiveDate::from_ymd_opt(2026, 2, 1)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        let mut conn = db.get().unwrap();
        diesel::update(published_collections::table.find(&a.id))
            .set(published_collections::published_at.eq(older))
            .execute(&mut conn)
            .unwrap();
        diesel::update(published_collections::table.find(&b.id))
            .set(published_collections::published_at.eq(newer))
            .execute(&mut conn)
            .unwrap();
        drop(conn);

        let recent = list_recent_public_core(&db, 10).unwrap();
        // Both public galleries, unlisted excluded, newest (bob) first.
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].username, "bobh");
        assert_eq!(recent[0].slug, "orion");
        assert_eq!(recent[0].image_count, 0);
        assert!(recent[0].thumb_url.is_none());

        assert_eq!(recent[1].username, "aliceh");
        assert_eq!(recent[1].slug, "andromeda");
        assert_eq!(recent[1].image_count, 1);
        assert_eq!(
            recent[1].thumb_url.as_deref(),
            Some(format!("/@aliceh/andromeda/thumbs/{}.jpg", img.id).as_str())
        );

        // The limit caps the strip.
        assert_eq!(list_recent_public_core(&db, 1).unwrap().len(), 1);
    }

    #[test]
    fn legacy_metadata_migration_is_idempotent_and_keeps_slugs() {
        let db = test_pool();
        // local-user exists with username erewhon (tenancy backfill).
        let c = make_collection(&db, "local-user", "Messier Marathon Spring 2026");
        let metadata = serde_json::json!({
            "share": {
                "publicUrl": "https://astra.gallery/@erewhon/messier-marathon-spring-2026",
                "publishedAt": "2026-03-15T03:26:39.178978271+00:00",
                "shareId": "540205758e2c",
                "uploadedImageIds": []
            }
        });
        diesel::update(collections::table.find(&c.id))
            .set(collections::metadata.eq(Some(metadata.to_string())))
            .execute(&mut db.get().unwrap())
            .unwrap();

        assert_eq!(migrate_legacy_publish_metadata(&db).unwrap(), 1);
        let (record, _) =
            resolve_public_collection(&db, "erewhon", "messier-marathon-spring-2026")
                .unwrap()
                .unwrap();
        assert_eq!(record.visibility, "public");
        assert_eq!(
            record.published_at.format("%Y-%m-%d").to_string(),
            "2026-03-15"
        );

        // Second run creates nothing.
        assert_eq!(migrate_legacy_publish_metadata(&db).unwrap(), 0);
    }
}
