import { describe, expect, it } from "vitest";
import {
  DAILY_EVENT_MAX_BYTES,
  countRemoteParticipants,
  createDailyTransport,
  decodeDailyMessage,
  encodeDailyMessage,
  packSnapshotResponse,
  routeDailyMessage,
  type DailyAppMessageEvent,
  type DailyAppSession,
  type DailyBoardMessage,
} from "../../lib/whiteboard/daily-transport";

function stroke(id: string, pts: number[]) {
  return {
    kind: "stroke" as const,
    id,
    tool: "pen" as const,
    color: "#0f172a",
    width: 2,
    opacity: 1,
    strokeStyle: "solid" as const,
    pts,
    pageIndex: 0,
  };
}

function mockSession() {
  const sent: unknown[] = [];
  const listeners = new Set<(event: DailyAppMessageEvent) => void>();
  const session: DailyAppSession = {
    sendAppMessage(data) {
      sent.push(data);
    },
    on(_event, handler) {
      listeners.add(handler);
    },
    off(_event, handler) {
      listeners.delete(handler);
    },
  };
  return {
    session,
    sent,
    emit(data: unknown, fromId = "peer-1") {
      for (const listener of listeners) listener({ data, fromId });
    },
  };
}

describe("daily transport", () => {
  it("counts remote Daily participants and ignores the local tile", () => {
    expect(
      countRemoteParticipants({
        local: { local: true },
        "local-session": { local: true },
        "peer-a": { local: false },
        "peer-b": { local: false },
      }),
    ).toBe(2);
  });

  it("serializes and deserializes each board event", () => {
    const messages: DailyBoardMessage[] = [
      {
        type: "board_delta",
        op: "add",
        senderId: "teacher-1",
        id: "stroke-1",
        element: stroke("stroke-1", [1, 2, 3, 4]),
      },
      { type: "board_delta", op: "remove", senderId: "teacher-1", id: "stroke-1" },
      { type: "request_snapshot", senderId: "student-1", timestamp: 1_700_000_000_000 },
      {
        type: "snapshot_response",
        senderId: "teacher-1",
        snapshotId: "snap-1",
        chunkIndex: 0,
        totalChunks: 1,
        paperStyle: "ruled",
        elements: [stroke("stroke-1", [1, 2, 3, 4])],
      },
      {
        type: "laser_update",
        x: 12.5,
        y: 40,
        color: "#ef4444",
        userId: "teacher-1",
        active: true,
      },
      {
        type: "board_sync",
        senderId: "teacher-1:sess01",
        senderKey: "teacher-1:sess01",
        v: 6,
        seq: 3,
        action: "clear",
      },
    ];

    for (const message of messages) {
      const encoded = encodeDailyMessage(message);
      expect(encoded).not.toBeNull();
      expect(decodeDailyMessage(encoded)).toEqual(message);
      expect(decodeDailyMessage(JSON.parse(encoded!))).toEqual(message);
    }
  });

  it("routes each event to its own handler", () => {
    const seen: string[] = [];
    const message = decodeDailyMessage({
      type: "laser_update",
      x: 8,
      y: 9,
      color: "#ef4444",
      userId: "teacher-1",
      active: false,
    });
    expect(message?.type).toBe("laser_update");
    if (!message) return;
    routeDailyMessage(message, {
      board_delta: () => seen.push("board_delta"),
      request_snapshot: () => seen.push("request_snapshot"),
      snapshot_response: () => seen.push("snapshot_response"),
      laser_update: () => seen.push("laser_update"),
    });
    expect(seen).toEqual(["laser_update"]);
  });

  it("delivers app-message events through the session adapter and ignores malformed payloads", () => {
    const channel = mockSession();
    const transport = createDailyTransport(channel.session);
    const received: DailyBoardMessage[] = [];
    transport.subscribe((message) => received.push(message));

    channel.emit({ type: "request_snapshot", senderId: "student-1", timestamp: 5 });
    channel.emit({ type: "nope" });
    channel.emit("not-json{");

    expect(received).toEqual([
      { type: "request_snapshot", senderId: "student-1", timestamp: 5 },
    ]);
    expect(transport.send({ type: "request_snapshot", senderId: "teacher-1", timestamp: 9 })).toBe(true);
    expect(channel.sent).toEqual([
      { type: "request_snapshot", senderId: "teacher-1", timestamp: 9 },
    ]);
    transport.close();
    channel.emit({ type: "request_snapshot", senderId: "student-1", timestamp: 6 });
    expect(received).toHaveLength(1);
  });

  it("refuses events at or over 2KB and keeps a delta free of data URLs and signed URLs", () => {
    expect(DAILY_EVENT_MAX_BYTES).toBe(2048);
    const huge = stroke("stroke-huge", Array.from({ length: 800 }, (_, index) => index));
    const channel = mockSession();
    const transport = createDailyTransport(channel.session);
    expect(transport.send({
      type: "board_delta",
      op: "add",
      senderId: "teacher-1",
      id: huge.id,
      element: huge,
    })).toBe(false);
    expect(channel.sent).toEqual([]);

    const encoded = encodeDailyMessage({
      type: "board_delta",
      op: "add",
      senderId: "teacher-1",
      id: "img-1",
      element: {
        kind: "image",
        id: "img-1",
        imageId: "img-1",
        url: `data:image/png;base64,${"A".repeat(40)}`,
        src: "https://storage.example/signed?token=secret",
        x: 10,
        y: 12,
        w: 80,
        h: 40,
        rotation: 0,
        crop: null,
        pageIndex: 0,
      },
    });
    expect(encoded).not.toBeNull();
    expect(encoded).not.toContain("data:image");
    expect(encoded).not.toContain("https://");
    expect(encoded).not.toContain("signed");
    expect(encoded).toContain("img-1");

    const packed = packSnapshotResponse({
      senderId: "teacher-1",
      snapshotId: "snap-pack",
      paperStyle: "grid",
      elements: Array.from({ length: 30 }, (_, index) => stroke(`stroke-${index}`, Array.from({ length: 40 }, (_, point) => point))),
    });
    expect(packed.length).toBeGreaterThan(1);
    for (const chunk of packed) {
      const bytes = new TextEncoder().encode(JSON.stringify(chunk)).length;
      expect(bytes).toBeLessThan(DAILY_EVENT_MAX_BYTES);
    }
    expect(packed.flatMap((chunk) => chunk.elements).map((element) => element.id)).toEqual(
      Array.from({ length: 30 }, (_, index) => `stroke-${index}`),
    );
  });
});
