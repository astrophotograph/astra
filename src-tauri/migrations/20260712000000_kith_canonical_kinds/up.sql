-- Rewrite kith kind columns from the old serde-JSON encoding to kith's
-- canonical TEXT codec (EdgeKind/EntityKind Display: 'follow',
-- 'vouch:identity', 'circle:{name}', 'user', 'custom:{name}', ...).
-- Kith 0.1's trait-surface respec made the codec the portable on-disk form;
-- it is stable across kith versions and prefix-queryable
-- (edge_kind LIKE 'circle:%'). event_kind stays serde-JSON — EventKind is
-- not part of the codec.
-- Canonical values never start with '"' or '{', so this only touches
-- legacy rows and is idempotent.

UPDATE kith_edges SET edge_kind = CASE
    WHEN edge_kind = '"Follow"' THEN 'follow'
    WHEN edge_kind = '"Block"' THEN 'block'
    WHEN edge_kind = '"Mute"' THEN 'mute'
    WHEN edge_kind = '{"Vouch":{"axis":"Identity"}}' THEN 'vouch:identity'
    WHEN edge_kind = '{"Vouch":{"axis":"Judgment"}}' THEN 'vouch:judgment'
    WHEN edge_kind LIKE '{"Circle":%' THEN 'circle:' || json_extract(edge_kind, '$.Circle')
    ELSE edge_kind
END
WHERE edge_kind LIKE '"%' OR edge_kind LIKE '{%';

UPDATE kith_edges SET target_kind = CASE
    WHEN target_kind = '"User"' THEN 'user'
    WHEN target_kind = '"Topic"' THEN 'topic'
    WHEN target_kind = '"Object"' THEN 'object'
    WHEN target_kind = '"Space"' THEN 'space'
    WHEN target_kind = '"Feed"' THEN 'feed'
    WHEN target_kind = '"Collection"' THEN 'collection'
    WHEN target_kind LIKE '{"Custom":%' THEN 'custom:' || json_extract(target_kind, '$.Custom')
    ELSE target_kind
END
WHERE target_kind LIKE '"%' OR target_kind LIKE '{%';

UPDATE kith_subscriptions SET topic_kind = CASE
    WHEN topic_kind = '"User"' THEN 'user'
    WHEN topic_kind = '"Topic"' THEN 'topic'
    WHEN topic_kind = '"Object"' THEN 'object'
    WHEN topic_kind = '"Space"' THEN 'space'
    WHEN topic_kind = '"Feed"' THEN 'feed'
    WHEN topic_kind = '"Collection"' THEN 'collection'
    WHEN topic_kind LIKE '{"Custom":%' THEN 'custom:' || json_extract(topic_kind, '$.Custom')
    ELSE topic_kind
END
WHERE topic_kind LIKE '"%' OR topic_kind LIKE '{%';

UPDATE kith_notifications SET entity_kind = CASE
    WHEN entity_kind = '"User"' THEN 'user'
    WHEN entity_kind = '"Topic"' THEN 'topic'
    WHEN entity_kind = '"Object"' THEN 'object'
    WHEN entity_kind = '"Space"' THEN 'space'
    WHEN entity_kind = '"Feed"' THEN 'feed'
    WHEN entity_kind = '"Collection"' THEN 'collection'
    WHEN entity_kind LIKE '{"Custom":%' THEN 'custom:' || json_extract(entity_kind, '$.Custom')
    ELSE entity_kind
END
WHERE entity_kind LIKE '"%' OR entity_kind LIKE '{%';
