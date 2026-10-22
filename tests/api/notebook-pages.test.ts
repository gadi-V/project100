import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  access: vi.fn(),
  findLesson: vi.fn(),
  findPage: vi.fn(),
  findPages: vi.fn(),
  createPage: vi.fn(),
  updatePages: vi.fn(),
  updateLessons: vi.fn(),
}));
const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const limits = vi.hoisted(() => ({ checkUserRateLimit: vi.fn() }));
const storage = vi.hoisted(() => ({
  upload: vi.fn(),
  remove: vi.fn(),
  read: vi.fn(),
}));
const codec = vi.hoisted(() => {
  class SnapshotTooLargeError extends Error {
    constructor() {
      super("snapshot gzip exceeds 2MB");
      this.name = "SnapshotTooLargeError";
    }
  }
  return {
    encode: vi.fn(() => Buffer.from([0x1f, 0x8b, 1])),
    decode: vi.fn(() => ({ v: 1 as const, paperStyle: "ruled", elements: [{ id: "stroke-1", kind: "stroke" }] })),
    path: (notebookId: string, pageIndex: number, version: number) =>
      `notebooks/${notebookId}/pages/${pageIndex}/v${version}.json.gz`,
    stale: (version: number) => (version > 3 ? Array.from({ length: version - 3 }, (_, index) => index + 1) : []),
    SnapshotTooLargeError,
  };
});

vi.mock("../../lib/session", () => session);
vi.mock("../../lib/notebooks", () => ({ getNotebookAccess: db.access }));
vi.mock("../../lib/prisma", () => ({
  prisma: {
    lesson: { findUnique: db.findLesson, updateMany: db.updateLessons },
    notebookPage: {
      findUnique: db.findPage,
      findMany: db.findPages,
      create: db.createPage,
      updateMany: db.updatePages,
    },
  },
}));
vi.mock("../../lib/security/rate-limit", () => ({ checkUserRateLimit: limits.checkUserRateLimit }));
vi.mock("../../lib/storage", () => ({
  uploadBoardObject: storage.upload,
  deleteBoardObject: storage.remove,
  readBoardObject: storage.read,
}));
vi.mock("../../lib/whiteboard/snapshot-codec", () => ({
  encodePageSnapshot: codec.encode,
  decodePageSnapshot: codec.decode,
  snapshotObjectPath: codec.path,
  versionsEligibleForGc: codec.stale,
  SnapshotTooLargeError: codec.SnapshotTooLargeError,
}));

import { GET as readPages } from "../../app/api/notebooks/[id]/pages/route";
import { PUT as writePage } from "../../app/api/notebooks/[id]/pages/[pageIndex]/route";

const NOTEBOOK = "nb-1";
const LESSON = "lesson-1";
const TEACHER = { id: "teacher-1", name: "דנה", role: "TEACHER" as const, lessonCredits: 0, isApproved: true };
const STUDENT = { id: "student-1", name: "נועה", role: "STUDENT" as const, lessonCredits: 1, isApproved: true };
const STRANGER = { id: "stranger-1", name: "אור", role: "TEACHER" as const, lessonCredits: 0, isApproved: true };

function putRequest(body: unknown, pageIndex = "4") {
  return writePage(
    new NextRequest(`http://localhost/api/notebooks/${NOTEBOOK}/pages/${pageIndex}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: NOTEBOOK, pageIndex }) },
  );
}

function getRequest(query = "from=4&to=4", id = NOTEBOOK) {
  return readPages(new NextRequest(`http://localhost/api/notebooks/${id}/pages?${query}`), {
    params: Promise.resolve({ id }),
  });
}

const snapshotBody = {
  baseVersion: 0,
  lessonId: LESSON,
  snapshot: { paperStyle: "ruled", elements: [{ id: "stroke-1", kind: "stroke", pts: [1, 2] }] },
};

beforeEach(() => {
  vi.clearAllMocks();
  session.getCurrentUser.mockResolvedValue(TEACHER);
  db.access.mockResolvedValue({ id: NOTEBOOK, studentId: STUDENT.id });
  db.findLesson.mockResolvedValue({
    id: LESSON,
    teacherId: TEACHER.id,
    notebookId: NOTEBOOK,
    endPage: 2,
  });
  db.findPage.mockResolvedValue(null);
  db.findPages.mockResolvedValue([]);
  db.createPage.mockImplementation(async ({ data }: { data: { snapshotVersion: number } }) => data);
  db.updatePages.mockResolvedValue({ count: 1 });
  db.updateLessons.mockResolvedValue({ count: 1 });
  limits.checkUserRateLimit.mockResolvedValue({
    success: true,
    limit: 20,
    remaining: 19,
    reset: Date.now() + 60_000,
    bypassed: false,
    degraded: false,
  });
  storage.upload.mockResolvedValue(undefined);
  storage.remove.mockResolvedValue(undefined);
  storage.read.mockResolvedValue(Buffer.from([0x1f, 0x8b]));
  codec.encode.mockReturnValue(Buffer.from([0x1f, 0x8b, 1]));
});

describe("PUT /api/notebooks/[id]/pages/[pageIndex]", () => {
  it("rejects a student with 403 and does not write", async () => {
    session.getCurrentUser.mockResolvedValue(STUDENT);

    const res = await putRequest(snapshotBody);

    expect(res.status).toBe(403);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(db.createPage).not.toHaveBeenCalled();
    expect(db.updatePages).not.toHaveBeenCalled();
  });

  it("returns 409 with the current version when the base version is stale", async () => {
    db.findPage.mockResolvedValue({
      notebookId: NOTEBOOK,
      pageIndex: 4,
      paperStyle: "grid",
      snapshotPath: "notebooks/nb-1/pages/4/v3.json.gz",
      snapshotVersion: 3,
    });

    const res = await putRequest({ ...snapshotBody, baseVersion: 2 });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.currentVersion).toBe(3);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(db.updatePages).not.toHaveBeenCalled();
  });

  it("returns 413 when the gzip snapshot exceeds 2MB", async () => {
    codec.encode.mockImplementation(() => {
      throw new codec.SnapshotTooLargeError();
    });

    const res = await putRequest(snapshotBody);

    expect(res.status).toBe(413);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(db.createPage).not.toHaveBeenCalled();
  });

  it("creates the page on the first write", async () => {
    const res = await putRequest(snapshotBody);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.version).toBe(1);
    expect(db.createPage).toHaveBeenCalledWith({
      data: {
        notebookId: NOTEBOOK,
        pageIndex: 4,
        paperStyle: "ruled",
        snapshotVersion: 1,
        snapshotPath: "notebooks/nb-1/pages/4/v1.json.gz",
      },
    });
    expect(db.updatePages).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("writes the next immutable version for the lesson teacher", async () => {
    db.findPage.mockResolvedValue({
      notebookId: NOTEBOOK,
      pageIndex: 4,
      paperStyle: "grid",
      snapshotPath: "notebooks/nb-1/pages/4/v3.json.gz",
      snapshotVersion: 3,
    });

    const res = await putRequest({ ...snapshotBody, baseVersion: 3 });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.version).toBe(4);
    expect(body.data.snapshotPath).toBe("notebooks/nb-1/pages/4/v4.json.gz");
    expect(limits.checkUserRateLimit).toHaveBeenCalledWith(TEACHER.id, "boardSnapshot");
    expect(storage.upload).toHaveBeenCalledWith(
      "notebooks/nb-1/pages/4/v4.json.gz",
      expect.any(Buffer),
      "application/gzip",
    );
    expect(db.updatePages).toHaveBeenCalledWith({
      where: { notebookId: NOTEBOOK, pageIndex: 4, snapshotVersion: 3 },
      data: {
        snapshotVersion: 4,
        snapshotPath: "notebooks/nb-1/pages/4/v4.json.gz",
        paperStyle: "ruled",
      },
    });
    expect(db.updateLessons).toHaveBeenCalledWith({
      where: {
        id: LESSON,
        notebookId: NOTEBOOK,
        OR: [{ endPage: null }, { endPage: { lt: 4 } }],
      },
      data: { endPage: 4 },
    });
    expect(storage.remove).toHaveBeenCalledWith("notebooks/nb-1/pages/4/v1.json.gz");
  });
});

describe("GET /api/notebooks/[id]/pages", () => {
  it("rejects a caller who cannot open the notebook", async () => {
    db.access.mockResolvedValue(null);

    const res = await getRequest();

    expect([403, 404]).toContain(res.status);
    expect(storage.read).not.toHaveBeenCalled();
  });

  it("returns paper, elements, and version for an authorized participant", async () => {
    session.getCurrentUser.mockResolvedValue(STUDENT);
    db.findPages.mockResolvedValue([
      {
        pageIndex: 4,
        paperStyle: "ruled",
        snapshotPath: "notebooks/nb-1/pages/4/v2.json.gz",
        snapshotVersion: 2,
      },
    ]);

    const res = await getRequest();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.pages).toEqual([
      {
        pageIndex: 4,
        paperStyle: "ruled",
        elements: [{ id: "stroke-1", kind: "stroke" }],
        version: 2,
      },
    ]);
    expect(storage.read).toHaveBeenCalledWith("notebooks/nb-1/pages/4/v2.json.gz");
  });

  it("does not let a teacher who is not this lesson's teacher save", async () => {
    session.getCurrentUser.mockResolvedValue(STRANGER);

    const res = await putRequest(snapshotBody);

    expect(res.status).toBe(403);
    expect(storage.upload).not.toHaveBeenCalled();
  });
});
