-- Restore the pre-codec serde-JSON encoding of kith kind columns.
-- json_quote() re-applies JSON string escaping for circle/custom names.

UPDATE kith_edges SET edge_kind = CASE
    WHEN edge_kind = 'follow' THEN '"Follow"'
    WHEN edge_kind = 'block' THEN '"Block"'
    WHEN edge_kind = 'mute' THEN '"Mute"'
    WHEN edge_kind = 'vouch:identity' THEN '{"Vouch":{"axis":"Identity"}}'
    WHEN edge_kind = 'vouch:judgment' THEN '{"Vouch":{"axis":"Judgment"}}'
    WHEN edge_kind LIKE 'circle:%' THEN '{"Circle":' || json_quote(substr(edge_kind, 8)) || '}'
    ELSE edge_kind
END;

UPDATE kith_edges SET target_kind = CASE
    WHEN target_kind = 'user' THEN '"User"'
    WHEN target_kind = 'topic' THEN '"Topic"'
    WHEN target_kind = 'object' THEN '"Object"'
    WHEN target_kind = 'space' THEN '"Space"'
    WHEN target_kind = 'feed' THEN '"Feed"'
    WHEN target_kind = 'collection' THEN '"Collection"'
    WHEN target_kind LIKE 'custom:%' THEN '{"Custom":' || json_quote(substr(target_kind, 8)) || '}'
    ELSE target_kind
END;

UPDATE kith_subscriptions SET topic_kind = CASE
    WHEN topic_kind = 'user' THEN '"User"'
    WHEN topic_kind = 'topic' THEN '"Topic"'
    WHEN topic_kind = 'object' THEN '"Object"'
    WHEN topic_kind = 'space' THEN '"Space"'
    WHEN topic_kind = 'feed' THEN '"Feed"'
    WHEN topic_kind = 'collection' THEN '"Collection"'
    WHEN topic_kind LIKE 'custom:%' THEN '{"Custom":' || json_quote(substr(topic_kind, 8)) || '}'
    ELSE topic_kind
END;

UPDATE kith_notifications SET entity_kind = CASE
    WHEN entity_kind = 'user' THEN '"User"'
    WHEN entity_kind = 'topic' THEN '"Topic"'
    WHEN entity_kind = 'object' THEN '"Object"'
    WHEN entity_kind = 'space' THEN '"Space"'
    WHEN entity_kind = 'feed' THEN '"Feed"'
    WHEN entity_kind = 'collection' THEN '"Collection"'
    WHEN entity_kind LIKE 'custom:%' THEN '{"Custom":' || json_quote(substr(entity_kind, 8)) || '}'
    ELSE entity_kind
END;
