// @generated automatically by Diesel CLI.

diesel::table! {
    access_tokens (id) {
        id -> Text,
        user_id -> Text,
        name -> Text,
        token_hash -> Text,
        created_at -> Timestamp,
        last_used_at -> Nullable<Timestamp>,
        revoked_at -> Nullable<Timestamp>,
    }
}

diesel::table! {
    astro_objects (id) {
        id -> Text,
        name -> Text,
        display_name -> Text,
        object_type -> Nullable<Text>,
        seq -> Nullable<Integer>,
        aliases -> Nullable<Text>,
        notes -> Nullable<Text>,
        metadata -> Nullable<Text>,
        created_at -> Timestamp,
        updated_at -> Timestamp,
    }
}

diesel::table! {
    astronomy_todos (id) {
        id -> Text,
        user_id -> Text,
        name -> Text,
        ra -> Text,
        dec -> Text,
        magnitude -> Text,
        size -> Text,
        object_type -> Nullable<Text>,
        added_at -> Text,
        completed -> Bool,
        completed_at -> Nullable<Text>,
        goal_time -> Nullable<Text>,
        notes -> Nullable<Text>,
        flagged -> Bool,
        last_updated -> Nullable<Text>,
        created_at -> Timestamp,
        updated_at -> Timestamp,
        tags -> Nullable<Text>,
    }
}

diesel::table! {
    collection_images (id) {
        id -> Text,
        collection_id -> Text,
        image_id -> Text,
        created_at -> Timestamp,
    }
}

diesel::table! {
    collections (id) {
        id -> Text,
        user_id -> Text,
        name -> Text,
        description -> Nullable<Text>,
        visibility -> Text,
        template -> Nullable<Text>,
        favorite -> Bool,
        tags -> Nullable<Text>,
        metadata -> Nullable<Text>,
        created_at -> Timestamp,
        updated_at -> Timestamp,
        archived -> Bool,
    }
}

diesel::table! {
    images (id) {
        id -> Text,
        user_id -> Text,
        collection_id -> Nullable<Text>,
        filename -> Text,
        url -> Nullable<Text>,
        summary -> Nullable<Text>,
        description -> Nullable<Text>,
        content_type -> Nullable<Text>,
        favorite -> Bool,
        tags -> Nullable<Text>,
        visibility -> Nullable<Text>,
        location -> Nullable<Text>,
        annotations -> Nullable<Text>,
        metadata -> Nullable<Text>,
        created_at -> Timestamp,
        updated_at -> Timestamp,
        thumbnail -> Nullable<Text>,
        fits_url -> Nullable<Text>,
        blob_id -> Nullable<Text>,
    }
}

diesel::table! {
    kith_edges (actor_id, target_kind, target_id, edge_kind) {
        actor_id -> Text,
        target_kind -> Text,
        target_id -> Text,
        edge_kind -> Text,
        weight -> Double,
        metadata -> Nullable<Text>,
        created_at -> Text,
    }
}

diesel::table! {
    kith_notifications (id) {
        id -> Text,
        recipient_id -> Text,
        source_id -> Text,
        entity_kind -> Text,
        entity_id -> Text,
        event_kind -> Text,
        payload_json -> Nullable<Text>,
        created_at -> Text,
        read -> Integer,
    }
}

diesel::table! {
    kith_subscriptions (id) {
        id -> Text,
        actor_id -> Text,
        topic_kind -> Text,
        topic_id -> Text,
        filter_json -> Nullable<Text>,
        created_at -> Text,
    }
}

diesel::table! {
    observation_schedules (id) {
        id -> Text,
        user_id -> Text,
        name -> Text,
        description -> Nullable<Text>,
        scheduled_date -> Nullable<Text>,
        location -> Nullable<Text>,
        items -> Text,
        is_active -> Bool,
        created_at -> Timestamp,
        updated_at -> Timestamp,
        equipment_id -> Nullable<Text>,
    }
}

diesel::table! {
    published_collections (id) {
        id -> Text,
        collection_id -> Text,
        user_id -> Text,
        slug -> Text,
        title -> Text,
        visibility -> Text,
        published_at -> Timestamp,
        updated_at -> Timestamp,
        view_count -> Integer,
    }
}

diesel::table! {
    scanned_directories (id) {
        id -> Text,
        user_id -> Text,
        path -> Text,
        fs_modified_at -> BigInt,
        last_scanned_at -> Text,
        image_count -> Integer,
    }
}

diesel::table! {
    simbad_cache (id) {
        id -> Text,
        object_name -> Text,
        data -> Text,
        cached_at -> Timestamp,
    }
}

diesel::table! {
    users (id) {
        id -> Text,
        email -> Nullable<Text>,
        name -> Nullable<Text>,
        image -> Nullable<Text>,
        username -> Nullable<Text>,
        first_name -> Nullable<Text>,
        last_name -> Nullable<Text>,
        summary -> Nullable<Text>,
        bio -> Nullable<Text>,
        description -> Nullable<Text>,
        metadata -> Nullable<Text>,
        created_at -> Timestamp,
        updated_at -> Timestamp,
        external_subject -> Nullable<Text>,
        role -> Text,
        status -> Text,
    }
}

diesel::joinable!(access_tokens -> users (user_id));
diesel::joinable!(astronomy_todos -> users (user_id));
diesel::joinable!(collection_images -> collections (collection_id));
diesel::joinable!(collection_images -> images (image_id));
diesel::joinable!(collections -> users (user_id));
diesel::joinable!(images -> collections (collection_id));
diesel::joinable!(images -> users (user_id));
diesel::joinable!(observation_schedules -> users (user_id));
diesel::joinable!(published_collections -> collections (collection_id));
diesel::joinable!(published_collections -> users (user_id));

diesel::allow_tables_to_appear_in_same_query!(
    access_tokens,
    astro_objects,
    astronomy_todos,
    collection_images,
    collections,
    images,
    kith_edges,
    kith_notifications,
    kith_subscriptions,
    observation_schedules,
    published_collections,
    scanned_directories,
    simbad_cache,
    users,
);
