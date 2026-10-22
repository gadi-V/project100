const PAPER_STYLES = new Set(["grid", "ruled", "dotted", "blank"]);

export type MountElement = { id: string };

export type MountState = {
  phase: "skeleton" | "server" | "live";
  elements: MountElement[];
  peerRequested: boolean;
};

export type MountEvent =
  | { type: "server"; elements: MountElement[] }
  | { type: "request-peer" }
  | { type: "peer"; elements: MountElement[] };

export type LoadedNotebookPage = {
  pageIndex: number;
  paperStyle: string;
  version: number;
  elements: Array<Record<string, unknown> & { id?: unknown; pageIndex?: number }>;
};

export function createMountState(): MountState {
  return { phase: "skeleton", elements: [], peerRequested: false };
}

/** An empty board has nothing to offer a joiner. */
export function shouldAnswerSnapshotRequest(elementCount: number): boolean {
  return elementCount > 0;
}

/**
 * After the server baseline is on screen, ask once even if that baseline has strokes.
 * Without a server baseline, only an empty board asks — the previous late-join rule.
 */
export function shouldRequestPeerSnapshot(input: {
  serverHydrated: boolean;
  waitingForServer: boolean;
  alreadyRequested: boolean;
  elementCount: number;
}): boolean {
  if (input.alreadyRequested || input.waitingForServer) return false;
  if (input.serverHydrated) return true;
  return input.elementCount === 0;
}

/** A live peer replaces the server baseline. An empty peer must not wipe loaded strokes. */
export function peerSnapshotAction(
  peerElementCount: number,
  loadedElementCount: number,
): "replace" | "ignore" {
  if (peerElementCount === 0 && loadedElementCount > 0) return "ignore";
  return "replace";
}

export function applyLoadedPages(startPage: number, pages: readonly LoadedNotebookPage[]): {
  elements: Array<Record<string, unknown>>;
  paperStyle: string;
  versions: Map<number, number>;
  pageCount: number;
} {
  const versions = new Map<number, number>();
  const elements: Array<Record<string, unknown>> = [];
  let paperStyle = "grid";
  let maxLocal = 0;
  const ordered = [...pages].sort((a, b) => a.pageIndex - b.pageIndex);
  for (const page of ordered) {
    versions.set(page.pageIndex, page.version);
    const local = page.pageIndex - startPage;
    if (local < 0) continue;
    maxLocal = Math.max(maxLocal, local);
    if (local === 0 && PAPER_STYLES.has(page.paperStyle)) paperStyle = page.paperStyle;
    for (const element of page.elements) {
      elements.push({ ...element, pageIndex: local });
    }
  }
  return {
    elements,
    paperStyle,
    versions,
    pageCount: Math.max(1, ordered.length === 0 ? 1 : maxLocal + 1),
  };
}

export function reduceMount(state: MountState, event: MountEvent): MountState {
  if (event.type === "server") {
    return { phase: "server", elements: event.elements, peerRequested: false };
  }
  if (event.type === "request-peer") {
    if (state.phase === "skeleton") return state;
    return { ...state, peerRequested: true };
  }
  if (!state.peerRequested) return state;
  if (peerSnapshotAction(event.elements.length, state.elements.length) === "ignore") return state;
  return { phase: "live", elements: event.elements, peerRequested: true };
}
