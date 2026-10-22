import { prisma } from "../prisma";
import { deleteBoardObject, readBoardObject, uploadBoardObject } from "../storage";
import {
  SnapshotTooLargeError,
  decodePageSnapshot,
  encodePageSnapshot,
  snapshotObjectPath,
  versionsEligibleForGc,
} from "../whiteboard/snapshot-codec";

const PAPER_STYLES = new Set(["grid", "ruled", "dotted", "blank"]);

export type NotebookPageSnapshot = {
  pageIndex: number;
  paperStyle: string;
  elements: unknown[];
  version: number;
};

export type SavePageResult =
  | { ok: true; version: number; snapshotPath: string }
  | { ok: false; status: 409; currentVersion: number }
  | { ok: false; status: 413 | 400 };

function isUniqueConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "P2002";
}

function paperStyleOf(value: unknown): string | null {
  return typeof value === "string" && PAPER_STYLES.has(value) ? value : null;
}

async function currentVersion(notebookId: string, pageIndex: number): Promise<number> {
  const row = await prisma.notebookPage.findUnique({
    where: { notebookId_pageIndex: { notebookId, pageIndex } },
    select: { snapshotVersion: true },
  });
  return row?.snapshotVersion ?? 0;
}

function collectStaleObjects(notebookId: string, pageIndex: number, version: number): void {
  const pending = versionsEligibleForGc(version).map((stale) =>
    deleteBoardObject(snapshotObjectPath(notebookId, pageIndex, stale)),
  );
  if (pending.length === 0) return;
  void Promise.all(pending).catch((error: unknown) => {
    console.error("[notebook] snapshot gc failed", error);
  });
}

export async function saveNotebookPage(input: {
  notebookId: string;
  pageIndex: number;
  lessonId: string;
  baseVersion: number;
  paperStyle: unknown;
  elements: unknown;
}): Promise<SavePageResult> {
  const paperStyle = paperStyleOf(input.paperStyle);
  if (!paperStyle || !Array.isArray(input.elements) || !Number.isInteger(input.baseVersion) || input.baseVersion < 0) {
    return { ok: false, status: 400 };
  }

  let encoded: Buffer;
  try {
    encoded = encodePageSnapshot({ paperStyle, elements: input.elements });
  } catch (error) {
    if (error instanceof SnapshotTooLargeError || (error instanceof Error && error.name === "SnapshotTooLargeError")) {
      return { ok: false, status: 413 };
    }
    throw error;
  }

  const existing = await prisma.notebookPage.findUnique({
    where: { notebookId_pageIndex: { notebookId: input.notebookId, pageIndex: input.pageIndex } },
    select: { snapshotVersion: true },
  });
  if (existing && existing.snapshotVersion !== input.baseVersion) {
    return { ok: false, status: 409, currentVersion: existing.snapshotVersion };
  }
  if (!existing && input.baseVersion !== 0) {
    return { ok: false, status: 409, currentVersion: 0 };
  }

  const version = input.baseVersion + 1;
  const snapshotPath = snapshotObjectPath(input.notebookId, input.pageIndex, version);
  await uploadBoardObject(snapshotPath, encoded, "application/gzip");

  if (!existing) {
    try {
      await prisma.notebookPage.create({
        data: {
          notebookId: input.notebookId,
          pageIndex: input.pageIndex,
          paperStyle,
          snapshotPath,
          snapshotVersion: version,
        },
      });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      return { ok: false, status: 409, currentVersion: await currentVersion(input.notebookId, input.pageIndex) };
    }
  } else {
    const updated = await prisma.notebookPage.updateMany({
      where: {
        notebookId: input.notebookId,
        pageIndex: input.pageIndex,
        snapshotVersion: input.baseVersion,
      },
      data: {
        snapshotVersion: version,
        snapshotPath,
        paperStyle,
      },
    });
    if (updated.count !== 1) {
      return { ok: false, status: 409, currentVersion: await currentVersion(input.notebookId, input.pageIndex) };
    }
  }

  await prisma.lesson.updateMany({
    where: {
      id: input.lessonId,
      notebookId: input.notebookId,
      OR: [{ endPage: null }, { endPage: { lt: input.pageIndex } }],
    },
    data: { endPage: input.pageIndex },
  });
  collectStaleObjects(input.notebookId, input.pageIndex, version);
  return { ok: true, version, snapshotPath };
}

export async function loadNotebookPages(
  notebookId: string,
  from: number,
  to: number,
): Promise<NotebookPageSnapshot[]> {
  const rows = await prisma.notebookPage.findMany({
    where: { notebookId, pageIndex: { gte: from, lte: to } },
    orderBy: { pageIndex: "asc" },
    select: { pageIndex: true, paperStyle: true, snapshotPath: true, snapshotVersion: true },
  });

  const pages: NotebookPageSnapshot[] = [];
  for (const row of rows) {
    let paperStyle = paperStyleOf(row.paperStyle) ?? "grid";
    let elements: unknown[] = [];
    if (row.snapshotPath) {
      const bytes = await readBoardObject(row.snapshotPath);
      if (bytes) {
        try {
          const decoded = decodePageSnapshot(bytes);
          paperStyle = decoded.paperStyle;
          elements = decoded.elements;
        } catch (error) {
          console.error("[notebook] snapshot decode failed", {
            pageIndex: row.pageIndex,
            reason: error instanceof Error ? error.name : "decode",
          });
        }
      }
    }
    pages.push({
      pageIndex: row.pageIndex,
      paperStyle,
      elements,
      version: row.snapshotVersion,
    });
  }
  return pages;
}
