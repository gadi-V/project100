import { NextRequest } from "next/server";
import type { Role } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  notebookFindUnique: vi.fn(),
  notebookUpsert: vi.fn(),
  lessonFindFirst: vi.fn(),
  lessonFindUnique: vi.fn(),
  lessonUpdate: vi.fn(),
  teacherReferralFindFirst: vi.fn(),
}));
const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));

vi.mock("../lib/prisma", () => ({
  prisma: {
    notebook: {
      findUnique: db.notebookFindUnique,
      upsert: db.notebookUpsert,
    },
    lesson: { findFirst: db.lessonFindFirst, findUnique: db.lessonFindUnique, update: db.lessonUpdate },
    teacherReferral: { findFirst: db.teacherReferralFindFirst },
  },
}));
vi.mock("../lib/session", () => session);

import { GET } from "../app/api/notebooks/[id]/route";
import { ensureNotebookForLesson, ensureNotebookForStudent, getNotebookAccess } from "../lib/notebooks";

const NOTEBOOK_ID = "nb-1";
const OWNER_ID = "student-1";

function viewer(role: Role, id: string) {
  return { id, role };
}

function notebook() {
  return {
    id: NOTEBOOK_ID,
    studentId: OWNER_ID,
    createdAt: new Date("2026-10-21T07:00:00.000Z"),
    student: { id: OWNER_ID, name: "נועה" },
    pages: [
      {
        id: "page-1",
        notebookId: NOTEBOOK_ID,
        pageIndex: 0,
        paperStyle: "grid",
        snapshotPath: null,
        snapshotVersion: 0,
      },
    ],
  };
}

function user(role: Role, id: string) {
  return { id, name: id, role, lessonCredits: 0, isApproved: true };
}

function getNotebook() {
  return GET(new NextRequest(`http://localhost/api/notebooks/${NOTEBOOK_ID}`), {
    params: Promise.resolve({ id: NOTEBOOK_ID }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.notebookFindUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
    where.id === NOTEBOOK_ID ? notebook() : null,
  );
  db.lessonFindFirst.mockResolvedValue(null);
  db.teacherReferralFindFirst.mockResolvedValue({ id: "referral-1", teacherId: "teacher-referred", studentId: OWNER_ID });
});

describe("getNotebookAccess", () => {
  it("lets the owner student open the notebook", async () => {
    const access = await getNotebookAccess(viewer("STUDENT", OWNER_ID), NOTEBOOK_ID);
    expect(access?.id).toBe(NOTEBOOK_ID);
    expect(db.lessonFindFirst).not.toHaveBeenCalled();
    expect(db.teacherReferralFindFirst).not.toHaveBeenCalled();
  });

  it("refuses a different student", async () => {
    expect(await getNotebookAccess(viewer("STUDENT", "student-2"), NOTEBOOK_ID)).toBeNull();
    expect(db.lessonFindFirst).not.toHaveBeenCalled();
    expect(db.teacherReferralFindFirst).not.toHaveBeenCalled();
  });

  it("lets a teacher who has a non-cancelled lesson with that student", async () => {
    db.lessonFindFirst.mockResolvedValue({ id: "lesson-1" });
    const access = await getNotebookAccess(viewer("TEACHER", "teacher-1"), NOTEBOOK_ID);
    expect(access?.studentId).toBe(OWNER_ID);
    expect(db.lessonFindFirst).toHaveBeenCalledWith({
      where: {
        teacherId: "teacher-1",
        studentId: OWNER_ID,
        status: { notIn: ["CANCELLED", "CANCELLED_LATE"] },
      },
      select: { id: true },
    });
    expect(db.teacherReferralFindFirst).not.toHaveBeenCalled();
  });

  it("refuses a teacher who only has a referral, even when that referral row exists", async () => {
    db.lessonFindFirst.mockResolvedValue(null);
    expect(await getNotebookAccess(viewer("TEACHER", "teacher-referred"), NOTEBOOK_ID)).toBeNull();
    expect(db.lessonFindFirst).toHaveBeenCalled();
    expect(db.teacherReferralFindFirst).not.toHaveBeenCalled();
  });

  it("lets an admin and a manager without a lesson", async () => {
    for (const role of ["ADMIN", "MANAGER"] as const) {
      const access = await getNotebookAccess(viewer(role, `${role.toLowerCase()}-1`), NOTEBOOK_ID);
      expect(access?.id).toBe(NOTEBOOK_ID);
    }
    expect(db.lessonFindFirst).not.toHaveBeenCalled();
    expect(db.teacherReferralFindFirst).not.toHaveBeenCalled();
  });

  it("refuses a representative and a missing notebook", async () => {
    expect(await getNotebookAccess(viewer("REPRESENTATIVE", "rep-1"), NOTEBOOK_ID)).toBeNull();
    expect(await getNotebookAccess(viewer("ADMIN", "admin-1"), "missing")).toBeNull();
    expect(db.teacherReferralFindFirst).not.toHaveBeenCalled();
  });
});

describe("GET /api/notebooks/[id]", () => {
  it("returns 401 without a session", async () => {
    session.getCurrentUser.mockResolvedValue(null);
    expect((await getNotebook()).status).toBe(401);
    expect(db.notebookFindUnique).not.toHaveBeenCalled();
  });

  it("returns the page list to the owner, a teaching teacher, and an admin", async () => {
    db.lessonFindFirst.mockImplementation(async ({ where }: { where: { teacherId?: string } }) =>
      where.teacherId === "teacher-1" ? { id: "lesson-1" } : null,
    );
    for (const actor of [user("STUDENT", OWNER_ID), user("TEACHER", "teacher-1"), user("ADMIN", "admin-1")]) {
      session.getCurrentUser.mockResolvedValue(actor);
      const res = await getNotebook();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toMatchObject({
        id: NOTEBOOK_ID,
        studentId: OWNER_ID,
        studentName: "נועה",
        pages: [{ id: "page-1", pageIndex: 0, paperStyle: "grid", snapshotVersion: 0 }],
      });
    }
  });

  it("returns 404 to another student and to a teacher with a referral only", async () => {
    for (const actor of [user("STUDENT", "student-2"), user("TEACHER", "teacher-referred")]) {
      session.getCurrentUser.mockResolvedValue(actor);
      const res = await getNotebook();
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ success: false });
    }
    expect(db.teacherReferralFindFirst).not.toHaveBeenCalled();
  });
});

describe("ensureNotebookForLesson", () => {
  it("creates the student notebook once and points the lesson at it", async () => {
    const rows = new Map<string, { id: string; studentId: string }>();
    db.notebookUpsert.mockImplementation(
      async ({ where, create }: { where: { studentId: string }; create: { studentId: string } }) => {
        const existing = rows.get(where.studentId);
        if (existing) return existing;
        const created = { id: "nb-1", studentId: create.studentId };
        rows.set(where.studentId, created);
        return created;
      },
    );
    db.lessonFindUnique.mockResolvedValue({ id: "lesson-1", studentId: OWNER_ID, notebookId: null });
    db.lessonUpdate.mockResolvedValue({ id: "lesson-1", notebookId: "nb-1" });

    const first = await ensureNotebookForLesson("lesson-1");
    db.lessonFindUnique.mockResolvedValue({ id: "lesson-1", studentId: OWNER_ID, notebookId: "nb-1" });
    const second = await ensureNotebookForLesson("lesson-1");

    expect(first?.id).toBe("nb-1");
    expect(second?.id).toBe(first?.id);
    expect(rows.size).toBe(1);
    expect(db.lessonUpdate).toHaveBeenCalledTimes(1);
    expect(db.notebookUpsert).toHaveBeenNthCalledWith(2, {
      where: { studentId: OWNER_ID },
      create: { studentId: OWNER_ID },
      update: {},
    });
  });
});

describe("ensureNotebookForStudent", () => {
  it("returns the same notebook on a second call for the same student", async () => {
    const rows = new Map<string, { id: string; studentId: string; createdAt: Date }>();
    db.notebookUpsert.mockImplementation(
      async ({ where, create }: { where: { studentId: string }; create: { studentId: string }; update: Record<string, never> }) => {
        const existing = rows.get(where.studentId);
        if (existing) return existing;
        const created = {
          id: `nb-${rows.size + 1}`,
          studentId: create.studentId,
          createdAt: new Date("2026-10-21T07:00:00.000Z"),
        };
        rows.set(where.studentId, created);
        return created;
      },
    );

    const first = await ensureNotebookForStudent(OWNER_ID);
    const second = await ensureNotebookForStudent(OWNER_ID);
    const other = await ensureNotebookForStudent("student-2");

    expect(second.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
    expect(rows.size).toBe(2);
    expect(db.notebookUpsert).toHaveBeenCalledTimes(3);
    expect(db.notebookUpsert).toHaveBeenNthCalledWith(2, {
      where: { studentId: OWNER_ID },
      create: { studentId: OWNER_ID },
      update: {},
    });
  });
});
