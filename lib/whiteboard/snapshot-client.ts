import { KEEPALIVE_MAX_BYTES, type SnapshotSaveResult } from "./save-scheduler";

type BoardElement = { pageIndex: number };

export async function persistNotebookBoard(input: {
  notebookId: string;
  lessonId: string;
  startPage: number;
  paperStyle: string;
  pageCount: number;
  elements: readonly BoardElement[];
  versions: Map<number, number>;
  keepalive: boolean;
  fetchImpl?: typeof fetch;
}): Promise<SnapshotSaveResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let lastVersion = input.versions.get(input.startPage) ?? 0;

  for (let local = 0; local < input.pageCount; local += 1) {
    const pageIndex = input.startPage + local;
    const baseVersion = input.versions.get(pageIndex) ?? 0;
    const elements = input.elements
      .filter((element) => element.pageIndex === local)
      .map((element) => ({ ...element, pageIndex }));
    const body = JSON.stringify({
      baseVersion,
      lessonId: input.lessonId,
      snapshot: { paperStyle: input.paperStyle, elements },
    });
    const keepalive = input.keepalive && body.length < KEEPALIVE_MAX_BYTES;
    let response: Response;
    try {
      response = await fetchImpl(`/api/notebooks/${encodeURIComponent(input.notebookId)}/pages/${pageIndex}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive,
      });
    } catch (error) {
      console.error("[whiteboard] snapshot save failed", error);
      return { ok: false, status: 0 };
    }

    if (response.status === 409) {
      const payload = (await response.json().catch(() => null)) as { currentVersion?: unknown } | null;
      const currentVersion = typeof payload?.currentVersion === "number" ? payload.currentVersion : baseVersion;
      input.versions.set(pageIndex, currentVersion);
      return { ok: false, status: 409, currentVersion };
    }
    if (!response.ok) {
      console.error("[whiteboard] snapshot save failed", { status: response.status, pageIndex });
      return { ok: false, status: response.status };
    }

    const payload = (await response.json().catch(() => null)) as { data?: { version?: unknown } } | null;
    const version = typeof payload?.data?.version === "number" ? payload.data.version : baseVersion + 1;
    input.versions.set(pageIndex, version);
    lastVersion = version;
  }

  return { ok: true, version: lastVersion };
}
