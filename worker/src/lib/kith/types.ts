/**
 * Kith types for the Cloudflare D1 adapter.
 * Mirrors the Rust Kith library's core types.
 */

export interface Edge {
  actorId: string;
  targetKind: string;
  targetId: string;
  edgeKind: string;
  weight: number;
  metadata: string | null;
  createdAt: string;
}

export interface Subscription {
  id: string;
  actorId: string;
  topicKind: string;
  topicId: string;
  filterJson: string | null;
  createdAt: string;
}

export interface Notification {
  id: string;
  recipientId: string;
  sourceId: string;
  entityKind: string;
  entityId: string;
  eventKind: string;
  payloadJson: string | null;
  createdAt: string;
  read: boolean;
}

export interface CurationList {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  public: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ListItem {
  id: string;
  listId: string;
  entityKind: string;
  entityId: string;
  title: string | null;
  note: string | null;
  position: number;
  addedAt: string;
}

export interface PageRequest {
  cursor?: string;
  limit: number;
}

export interface PageResponse<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}
