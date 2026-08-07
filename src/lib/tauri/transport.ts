/**
 * Platform transport: Tauri invoke on desktop, same-origin fetch on web.
 *
 * The desktop app and the browser build share one frontend. Every backend
 * call in `commands.ts` goes through `invoke()` below: under Tauri it is
 * the real IPC invoke; in a plain browser it dispatches to the daemon's
 * HTTP API (cookie auth, same origin) via the per-command route table.
 *
 * The daemon serializes db models exactly as Tauri invoke does (snake_case,
 * models.ts-shaped), so handlers mostly just relocate arguments into paths
 * and bodies. Two deliberate deviations, both from the API stripping the
 * legacy embedded base64 `thumbnail`:
 *   - image-shaped responses rewrite `thumbnail` to the bytes endpoint
 *     (`/api/images/{id}/thumbnail`) so existing <img src> rendering works;
 *   - `get_image_data` / `get_image_thumbnail` resolve to variant URLs
 *     instead of data: URLs — both are valid <img src> values.
 *
 * Commands with no web equivalent (local filesystem, Python astronomy,
 * scanners, backups) are simply absent from the table and throw
 * DesktopOnlyError — default-deny, same posture as the daemon router.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import {
  listen as tauriListen,
  type EventCallback,
  type UnlistenFn,
} from "@tauri-apps/api/event";
import type { Collection, Image, ObservationSchedule, TargetWithCount } from "./commands";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Thrown on web for commands that only exist in the desktop app. */
export class DesktopOnlyError extends Error {
  readonly command: string;

  constructor(command: string) {
    super(
      `"${command}" requires the Astra desktop app — it touches local files ` +
        `or Python and has no web equivalent.`,
    );
    this.name = "DesktopOnlyError";
    this.command = command;
  }
}

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/**
 * Event listener that works on both platforms. On web this is a no-op
 * unsubscriber: progress events (scans, imports, processing) are emitted by
 * desktop-only flows, so there is never anything to hear.
 */
export function listen<T>(
  event: string,
  handler: EventCallback<T>,
): Promise<UnlistenFn> {
  if (isTauri()) return tauriListen(event, handler);
  return Promise.resolve(() => {});
}

// =============================================================================
// Fetch helpers
// =============================================================================

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return fetch(path, init);
}

async function fail(resp: Response): Promise<never> {
  let detail = `${resp.status} ${resp.statusText}`;
  try {
    const body = (await resp.json()) as { error?: string };
    if (body.error) detail = `${detail}: ${body.error}`;
  } catch {
    // non-JSON error body; status line is enough
  }
  throw new HttpError(resp.status, detail);
}

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const resp = await send(method, path, body);
  if (!resp.ok) return fail(resp);
  return resp.json() as Promise<T>;
}

/** Like `json`, but a 404 resolves to `fallback` (the cores' not-owned == not-found). */
async function jsonOr<T, F>(method: string, path: string, fallback: F): Promise<T | F> {
  const resp = await send(method, path);
  if (resp.status === 404) return fallback;
  if (!resp.ok) return fail(resp);
  return resp.json() as Promise<T>;
}

/** DELETE mapped to the desktop bool contract: removed → true, 404 no-op → false. */
async function deleteBool(path: string): Promise<boolean> {
  const resp = await send("DELETE", path);
  if (resp.status === 404) return false;
  if (!resp.ok) return fail(resp);
  return true;
}

/** For 204-No-Content endpoints where callers only need success. */
async function okStatus(method: string, path: string): Promise<void> {
  const resp = await send(method, path);
  if (!resp.ok) return fail(resp);
}

/** Split an `Update*Input` into the path id and the request body. */
function splitId(input: unknown): { id: string; body: Record<string, unknown> } {
  const { id, ...body } = input as { id: string } & Record<string, unknown>;
  return { id, body };
}

/** The API strips the legacy base64 thumbnail; point at the bytes endpoint.
 *  The URL is versioned on the row's update stamp so server-side processing
 *  (which bumps `updated_at` when it replaces the variants) busts the
 *  browser cache. */
function webThumbnail(image: Image): Image {
  const v = encodeURIComponent(image.updated_at ?? "");
  return { ...image, thumbnail: `/api/images/${image.id}/thumbnail?v=${v}` };
}

interface CollectionDetail {
  collection: Collection;
  images: Image[];
}

interface PublishedRecord {
  slug: string;
  published_at: string;
  updated_at: string;
  visibility: string;
}

interface Me {
  userId: string;
  username: string | null;
}

async function publicUrlFor(slug: string): Promise<string> {
  const me = await json<Me>("GET", "/api/me");
  return `${window.location.origin}/@${me.username ?? me.userId}/${slug}`;
}

/**
 * Publish over HTTP. On web the library already lives on the daemon and
 * gallery manifests are built live per request, so desktop's push-then-
 * publish (and "sync") collapse to the one publish upsert; nothing uploads.
 */
async function publishResult(collectionId: string): Promise<unknown> {
  const record = await json<PublishedRecord>(
    "POST",
    `/api/collections/${collectionId}/publish`,
  );
  return {
    shareId: record.slug,
    publicUrl: await publicUrlFor(record.slug),
    imagesUploaded: 0,
    thumbsUploaded: 0,
  };
}

// =============================================================================
// Command → route table (web only)
// =============================================================================

type Args = Record<string, any>;
type WebHandler = (args: Args) => Promise<unknown>;

const WEB_ROUTES = {
  // ---- app ------------------------------------------------------------
  get_app_info: async () => {
    const health = await json<{ version: string }>("GET", "/healthz");
    return { name: "Astra", version: health.version, description: "" };
  },

  // ---- todos ----------------------------------------------------------
  get_todos: () => json("GET", "/api/todos"),
  get_todo: (a: Args) => jsonOr("GET", `/api/todos/${a.id}`, null),
  create_todo: (a: Args) => json("POST", "/api/todos", a.input),
  update_todo: (a: Args) => {
    const { id, body } = splitId(a.input);
    return json("PATCH", `/api/todos/${id}`, body);
  },
  delete_todo: (a: Args) => deleteBool(`/api/todos/${a.id}`),
  sync_todos: (a: Args) => {
    // Replace-all: an absent list must never silently wipe the account.
    // (Desktop invoke also rejects the call without this argument.)
    if (!Array.isArray(a.todos)) {
      return Promise.reject(new Error("sync_todos requires a todos array"));
    }
    return json("POST", "/api/todos/sync", a.todos);
  },

  // ---- collections ------------------------------------------------------
  get_collections: () => json("GET", "/api/collections"),
  get_collection: async (a: Args) => {
    const detail = await jsonOr<CollectionDetail, null>(
      "GET",
      `/api/collections/${a.id}`,
      null,
    );
    return detail?.collection ?? null;
  },
  create_collection: (a: Args) => json("POST", "/api/collections", a.input),
  update_collection: (a: Args) => {
    const { id, body } = splitId(a.input);
    return json("PATCH", `/api/collections/${id}`, body);
  },
  delete_collection: (a: Args) => deleteBool(`/api/collections/${a.id}`),
  get_collection_image_count: async (a: Args) => {
    const detail = await jsonOr<CollectionDetail, null>(
      "GET",
      `/api/collections/${a.collectionId}`,
      null,
    );
    return detail?.images.length ?? 0;
  },

  // ---- images -----------------------------------------------------------
  get_images: async () => {
    // Desktop returns the whole library; walk the paged API to match.
    const all: Image[] = [];
    for (;;) {
      const page = await json<{ items: Image[]; total: number }>(
        "GET",
        `/api/images?limit=500&offset=${all.length}`,
      );
      all.push(...page.items);
      if (all.length >= page.total || page.items.length === 0) break;
    }
    return all.map(webThumbnail);
  },
  get_collection_images: async (a: Args) => {
    const detail = await jsonOr<CollectionDetail, null>(
      "GET",
      `/api/collections/${a.collectionId}`,
      null,
    );
    return (detail?.images ?? []).map(webThumbnail);
  },
  get_image: async (a: Args) => {
    const image = await jsonOr<Image, null>("GET", `/api/images/${a.id}`, null);
    return image ? webThumbnail(image) : null;
  },
  update_image: async (a: Args) => {
    const { id, body } = splitId(a.input);
    return webThumbnail(await json<Image>("PATCH", `/api/images/${id}`, body));
  },
  delete_image: (a: Args) => deleteBool(`/api/images/${a.id}`),
  add_image_to_collection: async (a: Args) => {
    await okStatus("PUT", `/api/collections/${a.collectionId}/images/${a.imageId}`);
    return true;
  },
  remove_image_from_collection: (a: Args) =>
    deleteBool(`/api/collections/${a.collectionId}/images/${a.imageId}`),
  get_image_data: async (a: Args) => {
    // Version the URL on the row's update stamp (see webThumbnail) — one
    // extra row fetch, and processing-refreshed bytes load immediately
    const image = await jsonOr<Image, null>("GET", `/api/images/${a.id}`, null);
    const v = encodeURIComponent(image?.updated_at ?? "");
    return `/api/images/${a.id}/preview?v=${v}`;
  },
  get_image_thumbnail: async (a: Args) => {
    const image = await jsonOr<Image, null>("GET", `/api/images/${a.id}`, null);
    const v = encodeURIComponent(image?.updated_at ?? "");
    return `/api/images/${a.id}/thumbnail?v=${v}`;
  },

  // ---- image processing (native pipeline on the daemon) -----------------
  process_fits_image: async (a: Args) => {
    const { id, ...params } = a.input as { id: string } & Record<string, unknown>;
    const result = await json<{
      success: boolean;
      targetType: string;
      processingTime: number;
      processingParams: Record<string, unknown>;
    }>("POST", `/api/images/${id}/process`, params);
    // Desktop shape: the daemon has no local output paths — the "output"
    // is this image's own preview endpoint, freshly re-variant-ed
    return {
      success: result.success,
      outputFitsPath: "",
      outputPreviewPath: `/api/images/${id}/preview`,
      targetType: result.targetType,
      processingParams: result.processingParams,
      processingTime: result.processingTime,
    };
  },
  classify_target_type: (a: Args) =>
    json("GET", `/api/processing/classify?name=${encodeURIComponent(String(a.objectName))}`),
  get_processing_defaults: (a: Args) =>
    json("GET", `/api/processing/defaults?targetType=${encodeURIComponent(String(a.targetType))}`),

  // ---- schedules ----------------------------------------------------------
  get_schedules: () => json("GET", "/api/schedules"),
  get_active_schedule: async () => {
    const active = await json<ObservationSchedule[]>("GET", "/api/schedules/active");
    return active[0] ?? null;
  },
  get_active_schedules: () => json("GET", "/api/schedules/active"),
  get_schedule: (a: Args) => jsonOr("GET", `/api/schedules/${a.id}`, null),
  create_schedule: (a: Args) => json("POST", "/api/schedules", a.input),
  update_schedule: (a: Args) => {
    const { id, body } = splitId(a.input);
    return json("PATCH", `/api/schedules/${id}`, body);
  },
  delete_schedule: (a: Args) => deleteBool(`/api/schedules/${a.id}`),
  add_schedule_item: (a: Args) =>
    json("POST", `/api/schedules/${a.scheduleId}/items`, a.item),
  remove_schedule_item: (a: Args) =>
    json("DELETE", `/api/schedules/${a.scheduleId}/items/${a.itemId}`),

  // ---- targets -----------------------------------------------------------
  get_targets: async () => {
    const targets = await json<TargetWithCount[]>("GET", "/api/targets");
    return targets.map((t) => ({
      ...t,
      latestThumbnail: t.latestImageId
        ? `/api/images/${t.latestImageId}/thumbnail`
        : null,
    }));
  },
  search_images_by_target: async (a: Args) => {
    const images = await json<Image[]>(
      "GET",
      `/api/targets/search?q=${encodeURIComponent(a.query)}`,
    );
    return images.map(webThumbnail);
  },
  get_images_by_target: async (a: Args) => {
    const images = await json<Image[]>(
      "GET",
      `/api/targets/images?name=${encodeURIComponent(a.targetName)}`,
    );
    return images.map(webThumbnail);
  },

  // ---- share ---------------------------------------------------------------
  // On web you ARE the gallery daemon; config is implicit and read-only
  // (configure/clear stay desktop-only).
  get_gallery_daemon_config: () =>
    Promise.resolve({ baseUrl: window.location.origin, hasToken: true }),
  test_gallery_daemon: async () => {
    const me = await json<Me>("GET", "/api/me");
    return `@${me.username ?? me.userId}`;
  },
  publish_collection: (a: Args) => publishResult(a.collectionId),
  sync_collection: (a: Args) => publishResult(a.collectionId),
  unpublish_collection: async (a: Args) => {
    const resp = await send("DELETE", `/api/collections/${a.collectionId}/publish`);
    // Already unpublished is success, matching the desktop void contract.
    if (!resp.ok && resp.status !== 404) return fail(resp);
  },
  get_publish_status: async (a: Args) => {
    const record = await jsonOr<PublishedRecord, null>(
      "GET",
      `/api/collections/${a.collectionId}/publish`,
      null,
    );
    if (!record) return null;
    return {
      shareId: record.slug,
      publishedAt: record.published_at,
      publicUrl: await publicUrlFor(record.slug),
      lastSyncedAt: record.updated_at,
      uploadedImageIds: [],
    };
  },
} satisfies Record<string, WebHandler>;

// -----------------------------------------------------------------------------
// Typecheck-only mapping test: the repo has no JS test rig (no vitest), so
// route coverage is asserted at compile time instead — every command the
// in-scope Api groups can issue on web must be a key of WEB_ROUTES, or this
// file stops compiling. Desktop-only commands are intentionally NOT listed.
// -----------------------------------------------------------------------------
type InScopeCommand =
  | "get_app_info"
  | "get_todos"
  | "get_todo"
  | "create_todo"
  | "update_todo"
  | "delete_todo"
  | "sync_todos"
  | "get_collections"
  | "get_collection"
  | "create_collection"
  | "update_collection"
  | "delete_collection"
  | "get_collection_image_count"
  | "get_images"
  | "get_collection_images"
  | "get_image"
  | "update_image"
  | "delete_image"
  | "add_image_to_collection"
  | "remove_image_from_collection"
  | "get_image_data"
  | "get_image_thumbnail"
  | "process_fits_image"
  | "classify_target_type"
  | "get_processing_defaults"
  | "get_schedules"
  | "get_active_schedule"
  | "get_active_schedules"
  | "get_schedule"
  | "create_schedule"
  | "update_schedule"
  | "delete_schedule"
  | "add_schedule_item"
  | "remove_schedule_item"
  | "get_targets"
  | "search_images_by_target"
  | "get_images_by_target"
  | "publish_collection"
  | "sync_collection"
  | "unpublish_collection"
  | "get_publish_status"
  | "get_gallery_daemon_config"
  | "test_gallery_daemon";
type AssertAllMapped = [InScopeCommand] extends [keyof typeof WEB_ROUTES]
  ? true
  : never;
const _webRoutesCoverInScopeCommands: AssertAllMapped = true;
void _webRoutesCoverInScopeCommands;

// =============================================================================
// Dispatcher
// =============================================================================

/**
 * Drop-in replacement for `@tauri-apps/api/core`'s invoke: Tauri IPC on
 * desktop, the WEB_ROUTES fetch mapping in the browser.
 */
export async function invoke<T>(cmd: string, args: Args = {}): Promise<T> {
  if (isTauri()) {
    return tauriInvoke<T>(cmd, args);
  }
  const route = (WEB_ROUTES as Record<string, WebHandler>)[cmd];
  if (!route) throw new DesktopOnlyError(cmd);
  return route(args) as Promise<T>;
}
