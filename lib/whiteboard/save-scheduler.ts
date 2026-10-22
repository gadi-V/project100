export const SNAPSHOT_DEBOUNCE_MS = 5_000;
export const SNAPSHOT_MAX_INTERVAL_MS = 20_000;
export const KEEPALIVE_MAX_BYTES = 60 * 1024;
export const LESSON_COMPLETE_FLUSH_TIMEOUT_MS = 5_000;

export type SaveReason = "debounce" | "interval" | "hidden" | "pagehide" | "complete" | "conflict";

export type SnapshotSaveRequest = {
  baseVersion: number;
  keepalive: boolean;
  reason: SaveReason;
};

export type SnapshotSaveResult =
  | { ok: true; version: number }
  | { ok: false; status: 409; currentVersion: number }
  | { ok: false; status: number };

export type SnapshotSyncStatus = "saving" | "saved" | "error";

export type SaveScheduler = {
  noteMutation(now?: number): void;
  flush(reason: Exclude<SaveReason, "debounce" | "interval" | "conflict">): Promise<void>;
  dispose(): void;
};

function usesKeepalive(reason: SaveReason, bytes: number, limit: number): boolean {
  if (reason !== "hidden" && reason !== "pagehide") return false;
  return bytes < limit;
}

export function createSaveScheduler(options: {
  debounceMs?: number;
  maxIntervalMs?: number;
  keepaliveMaxBytes?: number;
  getBaseVersion: () => number;
  setBaseVersion: (version: number) => void;
  payloadBytes: () => number;
  save: (request: SnapshotSaveRequest) => Promise<SnapshotSaveResult>;
  onStatus?: (status: SnapshotSyncStatus) => void;
}): SaveScheduler {
  const debounceMs = options.debounceMs ?? SNAPSHOT_DEBOUNCE_MS;
  const maxIntervalMs = options.maxIntervalMs ?? SNAPSHOT_MAX_INTERVAL_MS;
  const keepaliveMaxBytes = options.keepaliveMaxBytes ?? KEEPALIVE_MAX_BYTES;

  let dirty = false;
  let burstStartedAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tail: Promise<void> = Promise.resolve();

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const runSave = async (reason: SaveReason): Promise<void> => {
    if (!dirty) return;
    dirty = false;
    burstStartedAt = null;
    clearTimer();
    options.onStatus?.("saving");
    const request = (next: SaveReason): SnapshotSaveRequest => ({
      baseVersion: options.getBaseVersion(),
      keepalive: usesKeepalive(next, options.payloadBytes(), keepaliveMaxBytes),
      reason: next,
    });
    try {
      const first = await options.save(request(reason));
      if (first.ok) {
        options.setBaseVersion(first.version);
        options.onStatus?.("saved");
        return;
      }
      if (first.status === 409 && "currentVersion" in first) {
        options.setBaseVersion(first.currentVersion);
        const second = await options.save(request("conflict"));
        if (second.ok) {
          options.setBaseVersion(second.version);
          options.onStatus?.("saved");
          return;
        }
        if (second.status === 409 && "currentVersion" in second) options.setBaseVersion(second.currentVersion);
      }
      options.onStatus?.("error");
    } catch (error) {
      console.error("[whiteboard] snapshot save failed", error);
      options.onStatus?.("error");
    }
  };

  const enqueue = (reason: SaveReason): Promise<void> => {
    const next = tail.then(() => runSave(reason), () => runSave(reason));
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return {
    noteMutation(now = Date.now()) {
      dirty = true;
      if (burstStartedAt == null) burstStartedAt = now;
      if (now - burstStartedAt >= maxIntervalMs) {
        clearTimer();
        void enqueue("interval");
        return;
      }
      clearTimer();
      timer = setTimeout(() => {
        void enqueue("debounce");
      }, debounceMs);
    },
    flush(reason) {
      return enqueue(reason);
    },
    dispose() {
      clearTimer();
      dirty = false;
      burstStartedAt = null;
    },
  };
}

/** Await a last save, but never keep the teacher in the room longer than `timeoutMs`. */
export async function flushBeforeLeave(
  flush: () => Promise<void>,
  timeoutMs = LESSON_COMPLETE_FLUSH_TIMEOUT_MS,
): Promise<"ok" | "timeout" | "error"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<"ok" | "timeout" | "error">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      flush().then(
        () => resolve("ok"),
        (error: unknown) => {
          console.error("[whiteboard] snapshot flush failed", error);
          resolve("error");
        },
      );
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
