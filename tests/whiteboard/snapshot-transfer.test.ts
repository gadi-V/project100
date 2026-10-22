import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DAILY_CLIENT_MAX_APP_MESSAGE_CHARS, DAILY_EVENT_MAX_BYTES } from "../../lib/whiteboard/daily-transport";
import {
  SNAPSHOT_CHUNK_TIMEOUT_MS,
  SNAPSHOT_MAX_ATTEMPTS,
  beginSnapshotWait,
  bufferSnapshotDelta,
  finishSnapshotWait,
  noteSnapshotRetry,
  snapshotTimeoutStep,
} from "../../lib/whiteboard/snapshot-transfer";

describe("snapshot transfer", () => {
  it("waits 6 seconds, re-requests once, then falls back", () => {
    expect(SNAPSHOT_CHUNK_TIMEOUT_MS).toBe(6_000);
    expect(SNAPSHOT_MAX_ATTEMPTS).toBe(2);
    const wait = beginSnapshotWait<string>();
    expect(snapshotTimeoutStep(wait.attempt)).toBe("retry");
    noteSnapshotRetry(wait);
    expect(wait.attempt).toBe(2);
    expect(snapshotTimeoutStep(wait.attempt)).toBe("fallback");
  });

  it("holds live deltas until the snapshot is mounted, then returns them in order", () => {
    const wait = beginSnapshotWait<string>();
    expect(bufferSnapshotDelta(wait, "delta-1")).toBe(true);
    expect(bufferSnapshotDelta(wait, "delta-2")).toBe(true);
    let board = ["skeleton"];
    board = ["peer-snapshot"];
    board = [...board, ...finishSnapshotWait(wait)];
    expect(board).toEqual(["peer-snapshot", "delta-1", "delta-2"]);
    expect(bufferSnapshotDelta(wait, "after")).toBe(false);
  });

  it("keeps the server baseline when chunks time out twice and still applies the held deltas", () => {
    const server = ["server-stroke"];
    const wait = beginSnapshotWait<string>();
    bufferSnapshotDelta(wait, "live-1");
    expect(snapshotTimeoutStep(wait.attempt)).toBe("retry");
    noteSnapshotRetry(wait);
    bufferSnapshotDelta(wait, "live-2");
    expect(snapshotTimeoutStep(wait.attempt)).toBe("fallback");
    let board = server;
    const partialSnapshotApplied = false;
    if (!partialSnapshotApplied) {
      board = [...board, ...finishSnapshotWait(wait)];
    }
    expect(board).toEqual(["server-stroke", "live-1", "live-2"]);
  });
});

describe("daily app-message limits", () => {
  it("matches the 4096-character ceiling in the installed daily-js bundle", () => {
    const source = readFileSync("node_modules/@daily-co/daily-js/dist/daily.js", "utf8");
    expect(source).toContain("ko=4096");
    expect(source).toContain("JSON.stringify(e).length>this._maxAppMessageSize");
    const types = readFileSync("node_modules/@daily-co/daily-js/index.d.ts", "utf8");
    const signature = types.split("\n").find((line) => line.includes("sendAppMessage("));
    expect(signature).toContain("sendAppMessage");
    expect(signature ?? "").not.toMatch(/rate|4096|byte/i);
    expect(DAILY_CLIENT_MAX_APP_MESSAGE_CHARS).toBe(4096);
    expect(DAILY_EVENT_MAX_BYTES).toBeLessThanOrEqual(DAILY_CLIENT_MAX_APP_MESSAGE_CHARS);
  });
});
