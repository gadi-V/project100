import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KEEPALIVE_MAX_BYTES,
  SNAPSHOT_DEBOUNCE_MS,
  SNAPSHOT_MAX_INTERVAL_MS,
  createSaveScheduler,
  flushBeforeLeave,
  type SnapshotSaveRequest,
  type SnapshotSaveResult,
} from "../../lib/whiteboard/save-scheduler";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function scheduler(save: (request: SnapshotSaveRequest) => Promise<SnapshotSaveResult>, payloadBytes = () => 32) {
  let version = 0;
  const status: string[] = [];
  const instance = createSaveScheduler({
    getBaseVersion: () => version,
    setBaseVersion: (next) => {
      version = next;
    },
    payloadBytes,
    save,
    onStatus: (next) => status.push(next),
  });
  return { instance, status, version: () => version };
}

describe("snapshot save scheduler", () => {
  it("waits 5 seconds after the last mutation", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_request: SnapshotSaveRequest) => ({ ok: true as const, version: 1 }));
    const { instance } = scheduler(save);

    instance.noteMutation();
    await vi.advanceTimersByTimeAsync(4_000);
    instance.noteMutation();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS - 1);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].reason).toBe("debounce");
    expect(save.mock.calls[0][0].keepalive).toBe(false);
  });

  it("flushes at least every 20 seconds while drawing continues", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_request: SnapshotSaveRequest) => ({ ok: true as const, version: 1 }));
    const { instance } = scheduler(save);

    instance.noteMutation();
    for (let second = 1; second < SNAPSHOT_MAX_INTERVAL_MS / 1000; second += 1) {
      await vi.advanceTimersByTimeAsync(1000);
      instance.noteMutation();
    }
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    instance.noteMutation();
    await vi.advanceTimersByTimeAsync(0);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].reason).toBe("interval");
  });

  it("uses keepalive only when a hidden-page payload is under 60KB", async () => {
    const save = vi.fn(async (_request: SnapshotSaveRequest) => ({ ok: true as const, version: 1 }));
    let bytes = KEEPALIVE_MAX_BYTES - 1;
    const { instance } = scheduler(save, () => bytes);

    instance.noteMutation();
    await instance.flush("pagehide");
    bytes = KEEPALIVE_MAX_BYTES;
    instance.noteMutation();
    await instance.flush("hidden");

    expect(save.mock.calls[0][0]).toMatchObject({ reason: "pagehide", keepalive: true });
    expect(save.mock.calls[1][0]).toMatchObject({ reason: "hidden", keepalive: false });
  });

  it("adopts a 409 version and resends the local canvas once", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (request: SnapshotSaveRequest): Promise<SnapshotSaveResult> => {
      if (request.baseVersion === 0) return { ok: false, status: 409, currentVersion: 4 };
      return { ok: true, version: request.baseVersion + 1 };
    });
    const { instance, status, version } = scheduler(save);

    instance.noteMutation();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS);

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0][0].baseVersion).toBe(0);
    expect(save.mock.calls[1][0]).toMatchObject({ baseVersion: 4, reason: "conflict" });
    expect(version()).toBe(5);
    expect(status.at(-1)).toBe("saved");
  });
});

describe("flushBeforeLeave", () => {
  it("resolves on timeout or failure so leaving is never blocked", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const hanging = flushBeforeLeave(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(hanging).resolves.toBe("timeout");

    vi.useRealTimers();
    await expect(flushBeforeLeave(async () => {
      throw new Error("offline");
    })).resolves.toBe("error");
    expect(error).toHaveBeenCalled();
  });
});
