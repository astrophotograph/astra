// @generated automatically by Diesel CLI.

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
    simbad_cache (id) {
        id -> Text,
        object_name -> Text,
        data -> Text,
        cached_at -> Timestamp,
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

diesel::joinable!(collections -> users (user_id));
diesel::joinable!(images -> users (user_id));
diesel::joinable!(images -> collections (collection_id));
diesel::joinable!(astronomy_todos -> users (user_id));
diesel::joinable!(observation_schedules -> users (user_id));
diesel::joinable!(collection_images -> collections (collection_id));
diesel::joinable!(collection_images -> images (image_id));

diesel::allow_tables_to_appear_in_same_query!(
    users,
    collections,
    images,
    astronomy_todos,
    observation_schedules,
    astro_objects,
    simbad_cache,
    collection_images,
);
