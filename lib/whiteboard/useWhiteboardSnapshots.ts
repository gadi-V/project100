"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { persistNotebookBoard } from "./snapshot-client";
import {
  createSaveScheduler,
  type SaveReason,
  type SaveScheduler,
} from "./save-scheduler";
import { applyLoadedPages, type LoadedNotebookPage } from "./snapshot-lifecycle";

type BoardElement = { pageIndex: number };

type SnapshotBoard = {
  paperStyle: string;
  pageCount: number;
  elements: readonly BoardElement[];
};

export type WhiteboardSnapshotStatus = "idle" | "saving" | "saved" | "error";

type UseWhiteboardSnapshotsOptions<T extends BoardElement> = {
  role: string;
  notebookId: string | null;
  lessonId: string | null;
  startPage: number | null;
  endPage: number | null;
  readBoard: () => SnapshotBoard;
  applyServer: (input: { elements: T[]; paperStyle: string; pageCount: number }) => void;
  onStatus: (status: WhiteboardSnapshotStatus) => void;
  onReady: () => void;
};

function payloadBytes(
  board: SnapshotBoard,
  lessonId: string,
  startPage: number,
  versions: Map<number, number>,
): number {
  let max = 0;
  for (let local = 0; local < board.pageCount; local += 1) {
    const body = JSON.stringify({
      baseVersion: versions.get(startPage + local) ?? 0,
      lessonId,
      snapshot: {
        paperStyle: board.paperStyle,
        elements: board.elements.filter((element) => element.pageIndex === local),
      },
    });
    max = Math.max(max, body.length);
  }
  return max;
}

export function useWhiteboardSnapshots<T extends BoardElement>(
  options: UseWhiteboardSnapshotsOptions<T>,
): {
  phase: "skeleton" | "ready";
  noteMutation: () => void;
  flush: (reason: "hidden" | "pagehide" | "complete") => Promise<void>;
} {
  const canLoad = Boolean(options.notebookId && options.lessonId && options.startPage != null);
  const [phase, setPhase] = useState<"skeleton" | "ready">(canLoad ? "skeleton" : "ready");
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const versionsRef = useRef(new Map<number, number>());
  const schedulerRef = useRef<SaveScheduler | null>(null);

  if (schedulerRef.current == null) {
    schedulerRef.current = createSaveScheduler({
      getBaseVersion: () => 0,
      setBaseVersion: () => undefined,
      payloadBytes: () => {
        const current = optionsRef.current;
        if (!current.notebookId || !current.lessonId || current.startPage == null) return 0;
        return payloadBytes(current.readBoard(), current.lessonId, current.startPage, versionsRef.current);
      },
      save: (request) => {
        const current = optionsRef.current;
        if (!current.notebookId || !current.lessonId || current.startPage == null || current.role !== "TEACHER") {
          return Promise.resolve({ ok: true, version: request.baseVersion });
        }
        const board = current.readBoard();
        return persistNotebookBoard({
          notebookId: current.notebookId,
          lessonId: current.lessonId,
          startPage: current.startPage,
          paperStyle: board.paperStyle,
          pageCount: board.pageCount,
          elements: board.elements,
          versions: versionsRef.current,
          keepalive: request.keepalive,
        });
      },
      onStatus: (status) => optionsRef.current.onStatus(status),
    });
  }

  useEffect(() => () => schedulerRef.current?.dispose(), []);

  useEffect(() => {
    const current = optionsRef.current;
    if (!current.notebookId || !current.lessonId || current.startPage == null) {
      setPhase("ready");
      current.onReady();
      return;
    }

    let cancelled = false;
    setPhase("skeleton");
    const from = current.startPage;
    const to = current.endPage != null && current.endPage >= from ? current.endPage : from;
    void fetch(`/api/notebooks/${encodeURIComponent(current.notebookId)}/pages?from=${from}&to=${to}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`snapshot load ${response.status}`);
        const body = (await response.json()) as { data?: { pages?: LoadedNotebookPage[] } };
        return body.data?.pages ?? [];
      })
      .then((pages) => {
        if (cancelled) return;
        const loaded = applyLoadedPages(from, pages);
        versionsRef.current = loaded.versions;
        optionsRef.current.applyServer({
          elements: loaded.elements as T[],
          paperStyle: loaded.paperStyle,
          pageCount: loaded.pageCount,
        });
        setPhase("ready");
        optionsRef.current.onReady();
      })
      .catch((error: unknown) => {
        console.error("[whiteboard] server snapshot failed", error);
        optionsRef.current.onStatus("error");
        if (!cancelled) {
          setPhase("ready");
          optionsRef.current.onReady();
        }
      });

    return () => {
      cancelled = true;
    };
  }, [options.notebookId, options.lessonId, options.startPage, options.endPage]);

  useEffect(() => {
    if (options.role !== "TEACHER" || !canLoad) return;
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") void schedulerRef.current?.flush("hidden");
    };
    const onPageHide = (): void => {
      void schedulerRef.current?.flush("pagehide");
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [options.role, canLoad]);

  const noteMutation = useCallback(() => {
    if (optionsRef.current.role !== "TEACHER") return;
    if (!optionsRef.current.notebookId || optionsRef.current.startPage == null) return;
    schedulerRef.current?.noteMutation();
  }, []);

  const flush = useCallback(async (reason: Extract<SaveReason, "hidden" | "pagehide" | "complete">) => {
    if (optionsRef.current.role !== "TEACHER") return;
    if (!optionsRef.current.notebookId || optionsRef.current.startPage == null) return;
    await schedulerRef.current?.flush(reason);
  }, []);

  return { phase, noteMutation, flush };
}
