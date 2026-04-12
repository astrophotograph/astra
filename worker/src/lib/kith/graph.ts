/**
 * D1GraphStore — Kith social graph backed by Cloudflare D1.
 */

import type { Edge, PageRequest, PageResponse } from "./types";

export class D1GraphStore {
  constructor(private db: D1Database) {}

  async addEdge(edge: Edge): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO edges (actor_id, target_kind, target_id, edge_kind, weight, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        edge.actorId,
        edge.targetKind,
        edge.targetId,
        edge.edgeKind,
        edge.weight,
        edge.metadata,
        edge.createdAt
      )
      .run();
  }

  async removeEdge(
    actorId: string,
    targetKind: string,
    targetId: string,
    edgeKind: string
  ): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM edges WHERE actor_id = ? AND target_kind = ? AND target_id = ? AND edge_kind = ?`
      )
      .bind(actorId, targetKind, targetId, edgeKind)
      .run();
  }

  async edgeExists(
    actorId: string,
    targetKind: string,
    targetId: string,
    edgeKind: string
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 FROM edges WHERE actor_id = ? AND target_kind = ? AND target_id = ? AND edge_kind = ? LIMIT 1`
      )
      .bind(actorId, targetKind, targetId, edgeKind)
      .first();
    return row !== null;
  }

  async followers(
    targetKind: string,
    targetId: string,
    edgeKind: string,
    page?: PageRequest
  ): Promise<PageResponse<Edge>> {
    const limit = page?.limit ?? 20;
    const offset = page?.cursor ? parseInt(page.cursor, 10) : 0;

    const countRow = await this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM edges WHERE target_kind = ? AND target_id = ? AND edge_kind = ?`
      )
      .bind(targetKind, targetId, edgeKind)
      .first<{ cnt: number }>();

    const rows = await this.db
      .prepare(
        `SELECT * FROM edges WHERE target_kind = ? AND target_id = ? AND edge_kind = ?
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .bind(targetKind, targetId, edgeKind, limit, offset)
      .all();

    const items = (rows.results || []).map(rowToEdge);
    const total = countRow?.cnt ?? 0;
    const nextOffset = offset + limit;

    return {
      items,
      nextCursor: nextOffset < total ? String(nextOffset) : null,
      total,
    };
  }

  async following(
    actorId: string,
    edgeKind: string,
    page?: PageRequest
  ): Promise<PageResponse<Edge>> {
    const limit = page?.limit ?? 20;
    const offset = page?.cursor ? parseInt(page.cursor, 10) : 0;

    const countRow = await this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM edges WHERE actor_id = ? AND edge_kind = ?`
      )
      .bind(actorId, edgeKind)
      .first<{ cnt: number }>();

    const rows = await this.db
      .prepare(
        `SELECT * FROM edges WHERE actor_id = ? AND edge_kind = ?
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .bind(actorId, edgeKind, limit, offset)
      .all();

    const items = (rows.results || []).map(rowToEdge);
    const total = countRow?.cnt ?? 0;
    const nextOffset = offset + limit;

    return {
      items,
      nextCursor: nextOffset < total ? String(nextOffset) : null,
      total,
    };
  }

  async mutual(a: string, b: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 FROM edges e1
         JOIN edges e2 ON e1.actor_id = e2.target_id AND e1.target_id = e2.actor_id
         WHERE e1.actor_id = ? AND e1.target_kind = 'user' AND e1.target_id = ?
           AND e1.edge_kind = 'follow' AND e2.edge_kind = 'follow'
           AND e2.target_kind = 'user'
         LIMIT 1`
      )
      .bind(a, b)
      .first();
    return row !== null;
  }

  async countFollowers(targetKind: string, targetId: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM edges WHERE target_kind = ? AND target_id = ? AND edge_kind = 'follow'`
      )
      .bind(targetKind, targetId)
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }

  async countFollowing(actorId: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM edges WHERE actor_id = ? AND edge_kind = 'follow'`
      )
      .bind(actorId)
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }

  async isBlocked(actorId: string, targetId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 FROM edges
         WHERE ((actor_id = ? AND target_id = ?) OR (actor_id = ? AND target_id = ?))
           AND target_kind = 'user' AND edge_kind = 'block'
         LIMIT 1`
      )
      .bind(actorId, targetId, targetId, actorId)
      .first();
    return row !== null;
  }
}

function rowToEdge(row: Record<string, unknown>): Edge {
  return {
    actorId: row.actor_id as string,
    targetKind: row.target_kind as string,
    targetId: row.target_id as string,
    edgeKind: row.edge_kind as string,
    weight: row.weight as number,
    metadata: (row.metadata as string) || null,
    createdAt: row.created_at as string,
  };
}
