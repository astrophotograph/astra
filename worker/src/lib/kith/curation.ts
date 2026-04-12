/**
 * D1CurationStore — curated list management.
 */

import type { CurationList, ListItem, PageRequest, PageResponse } from "./types";

export class D1CurationStore {
  constructor(private db: D1Database) {}

  async createList(ownerId: string, name: string, description?: string): Promise<CurationList> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO lists (id, owner_id, name, description, public, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`
      )
      .bind(id, ownerId, name, description ?? null, now, now)
      .run();
    return { id, ownerId, name, description: description ?? null, public: false, createdAt: now, updatedAt: now };
  }

  async getList(listId: string): Promise<CurationList | null> {
    const row = await this.db
      .prepare(`SELECT * FROM lists WHERE id = ?`)
      .bind(listId)
      .first();
    return row ? rowToList(row) : null;
  }

  async updateList(listId: string, updates: { name?: string; description?: string; public?: boolean }): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (updates.name !== undefined) { sets.push("name = ?"); values.push(updates.name); }
    if (updates.description !== undefined) { sets.push("description = ?"); values.push(updates.description); }
    if (updates.public !== undefined) { sets.push("public = ?"); values.push(updates.public ? 1 : 0); }
    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(listId);

    await this.db
      .prepare(`UPDATE lists SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();
  }

  async deleteList(listId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM lists WHERE id = ?`).bind(listId).run();
  }

  async listsForUser(ownerId: string): Promise<CurationList[]> {
    const rows = await this.db
      .prepare(`SELECT * FROM lists WHERE owner_id = ? ORDER BY updated_at DESC`)
      .bind(ownerId)
      .all();
    return (rows.results || []).map(rowToList);
  }

  async publicLists(page?: PageRequest): Promise<PageResponse<CurationList>> {
    const limit = page?.limit ?? 20;
    const offset = page?.cursor ? parseInt(page.cursor, 10) : 0;

    const countRow = await this.db
      .prepare(`SELECT COUNT(*) as cnt FROM lists WHERE public = 1`)
      .first<{ cnt: number }>();

    const rows = await this.db
      .prepare(`SELECT * FROM lists WHERE public = 1 ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .bind(limit, offset)
      .all();

    const items = (rows.results || []).map(rowToList);
    const total = countRow?.cnt ?? 0;
    return { items, nextCursor: offset + limit < total ? String(offset + limit) : null, total };
  }

  // --- List Items ---

  async addItem(
    listId: string,
    entityKind: string,
    entityId: string,
    title?: string,
    note?: string
  ): Promise<ListItem> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // Get next position
    const posRow = await this.db
      .prepare(`SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM list_items WHERE list_id = ?`)
      .bind(listId)
      .first<{ next_pos: number }>();
    const position = posRow?.next_pos ?? 0;

    await this.db
      .prepare(
        `INSERT INTO list_items (id, list_id, entity_kind, entity_id, title, note, position, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, listId, entityKind, entityId, title ?? null, note ?? null, position, now)
      .run();

    // Update list timestamp
    await this.db
      .prepare(`UPDATE lists SET updated_at = ? WHERE id = ?`)
      .bind(now, listId)
      .run();

    return { id, listId, entityKind, entityId, title: title ?? null, note: note ?? null, position, addedAt: now };
  }

  async removeItem(itemId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM list_items WHERE id = ?`).bind(itemId).run();
  }

  async getItems(listId: string, page?: PageRequest): Promise<PageResponse<ListItem>> {
    const limit = page?.limit ?? 50;
    const offset = page?.cursor ? parseInt(page.cursor, 10) : 0;

    const countRow = await this.db
      .prepare(`SELECT COUNT(*) as cnt FROM list_items WHERE list_id = ?`)
      .bind(listId)
      .first<{ cnt: number }>();

    const rows = await this.db
      .prepare(`SELECT * FROM list_items WHERE list_id = ? ORDER BY position ASC LIMIT ? OFFSET ?`)
      .bind(listId, limit, offset)
      .all();

    const items = (rows.results || []).map(rowToListItem);
    const total = countRow?.cnt ?? 0;
    return { items, nextCursor: offset + limit < total ? String(offset + limit) : null, total };
  }
}

function rowToList(row: Record<string, unknown>): CurationList {
  return {
    id: row.id as string,
    ownerId: row.owner_id as string,
    name: row.name as string,
    description: (row.description as string) || null,
    public: Boolean(row.public),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToListItem(row: Record<string, unknown>): ListItem {
  return {
    id: row.id as string,
    listId: row.list_id as string,
    entityKind: row.entity_kind as string,
    entityId: row.entity_id as string,
    title: (row.title as string) || null,
    note: (row.note as string) || null,
    position: row.position as number,
    addedAt: row.added_at as string,
  };
}
