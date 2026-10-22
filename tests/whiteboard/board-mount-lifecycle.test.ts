import { describe, expect, it } from "vitest";
import {
  applyLoadedPages,
  createMountState,
  peerSnapshotAction,
  reduceMount,
  shouldAnswerSnapshotRequest,
  shouldRequestPeerSnapshot,
} from "../../lib/whiteboard/snapshot-lifecycle";

describe("board mount lifecycle", () => {
  it("loads the server snapshot after the skeleton, then lets a live peer replace it", () => {
    let state = createMountState();
    expect(state.phase).toBe("skeleton");
    expect(state.elements).toEqual([]);

    const loaded = applyLoadedPages(4, [
      {
        pageIndex: 4,
        paperStyle: "ruled",
        version: 2,
        elements: [{ id: "server-stroke", pageIndex: 99, kind: "stroke" }],
      },
    ]);
    state = reduceMount(state, {
      type: "server",
      elements: loaded.elements.map((element) => ({ id: String(element.id) })),
    });

    expect(state.phase).toBe("server");
    expect(loaded.paperStyle).toBe("ruled");
    expect(loaded.elements).toEqual([{ id: "server-stroke", pageIndex: 0, kind: "stroke" }]);
    expect(loaded.versions.get(4)).toBe(2);
    expect(state.elements).toEqual([{ id: "server-stroke" }]);

    state = reduceMount(state, { type: "request-peer" });
    expect(state.peerRequested).toBe(true);
    expect(shouldRequestPeerSnapshot({
      serverHydrated: true,
      waitingForServer: false,
      alreadyRequested: false,
      elementCount: state.elements.length,
    })).toBe(true);

    state = reduceMount(state, { type: "peer", elements: [{ id: "live-stroke" }] });
    expect(state.phase).toBe("live");
    expect(state.elements).toEqual([{ id: "live-stroke" }]);
    expect(peerSnapshotAction(1, 1)).toBe("replace");
  });

  it("ignores an empty peer snapshot when the server already loaded elements", () => {
    let state = reduceMount(createMountState(), {
      type: "server",
      elements: [{ id: "server-stroke" }],
    });
    state = reduceMount(state, { type: "request-peer" });
    state = reduceMount(state, { type: "peer", elements: [] });

    expect(state.phase).toBe("server");
    expect(state.elements).toEqual([{ id: "server-stroke" }]);
    expect(peerSnapshotAction(0, 1)).toBe("ignore");
    expect(shouldAnswerSnapshotRequest(0)).toBe(false);
    expect(shouldAnswerSnapshotRequest(2)).toBe(true);
  });

  it("does not ask peers for a snapshot before the server baseline arrives", () => {
    const state = reduceMount(createMountState(), { type: "request-peer" });
    expect(state.phase).toBe("skeleton");
    expect(state.peerRequested).toBe(false);
    expect(shouldRequestPeerSnapshot({
      serverHydrated: false,
      waitingForServer: true,
      alreadyRequested: false,
      elementCount: 0,
    })).toBe(false);
    expect(shouldRequestPeerSnapshot({
      serverHydrated: false,
      waitingForServer: false,
      alreadyRequested: false,
      elementCount: 3,
    })).toBe(false);
  });
});
