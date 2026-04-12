/**
 * D1NotificationStore — notification storage and subscription matching.
 */

import type { Notification, Subscription, PageRequest, PageResponse } from "./types";

export class D1NotificationStore {
  constructor(private db: D1Database) {}

  // --- Subscriptions ---

  async subscribe(
    actorId: string,
    topicKind: string,
    topicId: string,
    filterJson?: string
  ): Promise<Subscription> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO subscriptions (id, actor_id, topic_kind, topic_id, filter_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(id, actorId, topicKind, topicId, filterJson ?? null, now)
      .run();
    return { id, actorId, topicKind, topicId, filterJson: filterJson ?? null, createdAt: now };
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM subscriptions WHERE id = ?`)
      .bind(subscriptionId)
      .run();
  }

  async unsubscribeByTopic(
    actorId: string,
    topicKind: string,
    topicId: string
  ): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM subscriptions WHERE actor_id = ? AND topic_kind = ? AND topic_id = ?`
      )
      .bind(actorId, topicKind, topicId)
      .run();
  }

  async getSubscriptions(actorId: string): Promise<Subscription[]> {
    const rows = await this.db
      .prepare(`SELECT * FROM subscriptions WHERE actor_id = ? ORDER BY created_at DESC`)
      .bind(actorId)
      .all();
    return (rows.results || []).map(rowToSubscription);
  }

  async getSubscribersOf(
    topicKind: string,
    topicId: string
  ): Promise<Subscription[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM subscriptions WHERE topic_kind = ? AND topic_id = ?`
      )
      .bind(topicKind, topicId)
      .all();
    return (rows.results || []).map(rowToSubscription);
  }

  // --- Notifications ---

  async store(notification: Omit<Notification, "id" | "createdAt" | "read">): Promise<Notification> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO notifications (id, recipient_id, source_id, entity_kind, entity_id, event_kind, payload_json, created_at, read)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
      )
      .bind(
        id,
        notification.recipientId,
        notification.sourceId,
        notification.entityKind,
        notification.entityId,
        notification.eventKind,
        notification.payloadJson ?? null,
        now
      )
      .run();
    return { ...notification, id, createdAt: now, read: false };
  }

  async getNotifications(
    recipientId: string,
    page?: PageRequest
  ): Promise<PageResponse<Notification>> {
    const limit = page?.limit ?? 20;
    const offset = page?.cursor ? parseInt(page.cursor, 10) : 0;

    const countRow = await this.db
      .prepare(`SELECT COUNT(*) as cnt FROM notifications WHERE recipient_id = ?`)
      .bind(recipientId)
      .first<{ cnt: number }>();

    const rows = await this.db
      .prepare(
        `SELECT * FROM notifications WHERE recipient_id = ?
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .bind(recipientId, limit, offset)
      .all();

    const items = (rows.results || []).map(rowToNotification);
    const total = countRow?.cnt ?? 0;
    const nextOffset = offset + limit;

    return {
      items,
      nextCursor: nextOffset < total ? String(nextOffset) : null,
      total,
    };
  }

  async markRead(notificationId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE notifications SET read = 1 WHERE id = ?`)
      .bind(notificationId)
      .run();
  }

  async markAllRead(recipientId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE notifications SET read = 1 WHERE recipient_id = ? AND read = 0`)
      .bind(recipientId)
      .run();
  }

  async unreadCount(recipientId: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM notifications WHERE recipient_id = ? AND read = 0`
      )
      .bind(recipientId)
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }

  /**
   * Emit an event: find all subscribers and create notifications for each.
   * Optionally skips blocked users if a graph store is provided.
   */
  async emit(
    sourceId: string,
    entityKind: string,
    entityId: string,
    eventKind: string,
    payload?: Record<string, unknown>,
    blockedUserIds?: Set<string>
  ): Promise<number> {
    const subscribers = await this.getSubscribersOf(entityKind, entityId);
    let count = 0;
    const payloadJson = payload ? JSON.stringify(payload) : null;

    for (const sub of subscribers) {
      // Don't notify the source (you don't need to know about your own actions)
      if (sub.actorId === sourceId) continue;
      // Skip blocked users
      if (blockedUserIds?.has(sub.actorId)) continue;

      await this.store({
        recipientId: sub.actorId,
        sourceId,
        entityKind,
        entityId,
        eventKind,
        payloadJson,
      });
      count++;
    }
    return count;
  }
}

function rowToSubscription(row: Record<string, unknown>): Subscription {
  return {
    id: row.id as string,
    actorId: row.actor_id as string,
    topicKind: row.topic_kind as string,
    topicId: row.topic_id as string,
    filterJson: (row.filter_json as string) || null,
    createdAt: row.created_at as string,
  };
}

function rowToNotification(row: Record<string, unknown>): Notification {
  return {
    id: row.id as string,
    recipientId: row.recipient_id as string,
    sourceId: row.source_id as string,
    entityKind: row.entity_kind as string,
    entityId: row.entity_id as string,
    eventKind: row.event_kind as string,
    payloadJson: (row.payload_json as string) || null,
    createdAt: row.created_at as string,
    read: Boolean(row.read),
  };
}
