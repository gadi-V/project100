import { describe, expect, it } from "vitest";
import { createDeltaApplyState, pushSenderDelta, type DeltaApplyState } from "../../lib/whiteboard/delta-apply";
import { RECEIVER_HOPS, planBoardDelivery, type BoardRouteContext } from "../../lib/whiteboard/transport-policy";

type Hop = "daily" | "stream";

type Client = {
  senderKey: string;
  dailyJoined: boolean;
  state: DeltaApplyState;
  elements: string[];
  applied: string[];
};

type Packet = {
  from: string;
  hop: Hop;
  payload: Record<string, unknown>;
};

function client(senderKey: string, dailyJoined: boolean): Client {
  return { senderKey, dailyJoined, state: createDeltaApplyState(), elements: [], applied: [] };
}

function routeContext(clients: readonly Client[], sender: Client, requesterOnDaily = false): BoardRouteContext {
  return {
    dailyJoined: sender.dailyJoined,
    remoteParticipants: clients.filter((peer) => peer !== sender && peer.dailyJoined).length,
    requesterOnDaily,
  };
}

function broadcast(clients: readonly Client[], sender: Client, payload: Record<string, unknown>): Packet[] {
  const plan = planBoardDelivery(payload, routeContext(clients, sender));
  const packets: Packet[] = [];
  if (plan.stream) packets.push({ from: sender.senderKey, hop: "stream", payload });
  if (plan.daily) packets.push({ from: sender.senderKey, hop: "daily", payload });
  return packets;
}

/** Stream is delivered to every other client. Daily is delivered to joined clients. Both listeners stay on. */
function receive(clients: readonly Client[], packets: readonly Packet[]): void {
  expect(RECEIVER_HOPS).toEqual({ daily: true, stream: true });
  for (const packet of packets) {
    for (const peer of clients) {
      if (peer.senderKey === packet.from) continue;
      if (packet.hop === "daily" && !peer.dailyJoined) continue;
      const seq = packet.payload.seq;
      if (typeof seq !== "number") continue;
      const senderKey = typeof packet.payload.senderKey === "string" ? packet.payload.senderKey : packet.from;
      const marker =
        packet.payload.add && typeof packet.payload.add === "object" && "id" in packet.payload.add
          ? String((packet.payload.add as { id: unknown }).id)
          : `${packet.payload.action ?? packet.payload.type ?? "op"}:${seq}`;
      const accepted = pushSenderDelta(
        peer.state,
        { senderId: senderKey, seq, ops: [{ op: "add", id: marker }] },
        0,
      );
      if (accepted.length === 0) continue;
      peer.applied.push(`${senderKey}:${seq}`);
      if (packet.payload.add && typeof packet.payload.add === "object" && "id" in packet.payload.add) {
        peer.elements.push(marker);
      }
    }
  }
}

function draw(clients: Client[], sender: Client, id: string, seq: number): Packet[] {
  sender.elements.push(id);
  return broadcast(clients, sender, { add: { id }, seq, senderKey: sender.senderKey, senderId: sender.senderKey });
}

const PERSISTENT: Record<string, unknown>[] = [
  { add: { id: "stroke-1" } },
  { remove: ["stroke-1"] },
  { historyOp: { id: "hist-1" }, direction: "backward" },
  { action: "clear" },
  { layerOrder: { pageIndex: 0, ids: ["stroke-1"] } },
  { action: "paper_style_change", paperStyle: "grid" },
  { pageCount: 2 },
];

describe("dual transport routing", () => {
  it("converges strokes when both clients are on Daily and applies each op once", () => {
    const teacher = client("teacher:sessA", true);
    const student = client("student:sessB", true);
    const room = [teacher, student];

    const first = draw(room, teacher, "from-teacher", 1);
    expect(first.map((packet) => packet.hop).sort()).toEqual(["daily", "stream"]);
    receive(room, first);

    const second = draw(room, student, "from-student", 1);
    receive(room, second);

    expect(teacher.elements.sort()).toEqual(["from-student", "from-teacher"]);
    expect(student.elements.sort()).toEqual(["from-student", "from-teacher"]);
    expect(student.applied.filter((id) => id === "teacher:sessA:1")).toEqual(["teacher:sessA:1"]);
  });

  it("converges strokes in both directions when only one client is on Daily", () => {
    const teacher = client("teacher:sessA", true);
    const student = client("student:sessB", false);
    const room = [teacher, student];

    const fromTeacher = draw(room, teacher, "from-teacher", 1);
    expect(fromTeacher.map((packet) => packet.hop)).toEqual(["stream"]);
    receive(room, fromTeacher);

    const fromStudent = draw(room, student, "from-student", 1);
    expect(fromStudent.map((packet) => packet.hop)).toEqual(["stream"]);
    receive(room, fromStudent);

    expect(teacher.elements.sort()).toEqual(["from-student", "from-teacher"]);
    expect(student.elements.sort()).toEqual(["from-student", "from-teacher"]);
  });

  it("converges strokes when neither client is on Daily", () => {
    const teacher = client("teacher:sessA", false);
    const student = client("student:sessB", false);
    const room = [teacher, student];
    receive(room, draw(room, teacher, "from-teacher", 1));
    receive(room, draw(room, student, "from-student", 4));
    expect(teacher.elements.sort()).toEqual(["from-student", "from-teacher"]);
    expect(student.elements.sort()).toEqual(["from-student", "from-teacher"]);
    expect(draw(room, teacher, "later", 2).every((packet) => packet.hop === "stream")).toBe(true);
  });

  it("picks up a peer that joins Daily mid-session without applying the next stroke twice", () => {
    const teacher = client("teacher:sessA", true);
    const student = client("student:sessB", false);
    const room = [teacher, student];

    receive(room, draw(room, teacher, "before-join", 1));
    expect(student.elements).toEqual(["before-join"]);

    student.dailyJoined = true;
    const after = draw(room, teacher, "after-join", 2);
    expect(after.map((packet) => packet.hop).sort()).toEqual(["daily", "stream"]);
    receive(room, after);

    expect(student.elements).toEqual(["before-join", "after-join"]);
    expect(student.applied.filter((id) => id === "teacher:sessA:2")).toHaveLength(1);
  });

  it("applies every persistent op exactly once when it is copied onto both transports", () => {
    const teacher = client("teacher:sessA", true);
    const student = client("student:sessB", true);
    const room = [teacher, student];

    PERSISTENT.forEach((payload, index) => {
      const seq = index + 1;
      const packets = broadcast(room, teacher, {
        ...payload,
        seq,
        senderKey: teacher.senderKey,
        senderId: teacher.senderKey,
      });
      expect(packets.map((packet) => packet.hop).sort()).toEqual(["daily", "stream"]);
      receive(room, packets);
      expect(student.applied.filter((id) => id === `${teacher.senderKey}:${seq}`)).toEqual([
        `${teacher.senderKey}:${seq}`,
      ]);
    });
  });

  it("never places a laser update or a stroke preview on Stream", () => {
    const teacher = client("teacher:sessA", true);
    const student = client("student:sessB", true);
    const alone = [teacher, client("student:sessB", false)];

    const live = broadcast( [teacher, student], teacher, {
      type: "laser_update",
      seq: 1,
      senderKey: teacher.senderKey,
    });
    const preview = broadcast([teacher, student], teacher, {
      type: "stroke_preview",
      seq: 2,
      senderKey: teacher.senderKey,
    });
    const dropped = broadcast(alone, teacher, { type: "laser_update", seq: 3, senderKey: teacher.senderKey });

    expect(live.map((packet) => packet.hop)).toEqual(["daily"]);
    expect(preview.map((packet) => packet.hop)).toEqual(["daily"]);
    expect(dropped).toEqual([]);
    expect([...live, ...preview, ...dropped].some((packet) => packet.hop === "stream")).toBe(false);
  });

  it("prefers a Daily snapshot reply when the requester is on Daily", () => {
    const responder = client("teacher:sessA", true);
    const onDaily = planBoardDelivery(
      { action: "snapshot_chunk" },
      { ...routeContext([responder, client("student:sessB", true)], responder), requesterOnDaily: true },
    );
    const offDaily = planBoardDelivery(
      { action: "snapshot_chunk" },
      { ...routeContext([responder, client("student:sessB", false)], responder), requesterOnDaily: false },
    );
    const request = planBoardDelivery(
      { action: "request_snapshot" },
      routeContext([responder, client("student:sessB", true)], responder),
    );
    expect(onDaily).toEqual({ daily: true, stream: false });
    expect(offDaily).toEqual({ daily: false, stream: true });
    expect(request).toEqual({ daily: true, stream: true });
  });
});
