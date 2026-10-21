import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  lessonFindFirst: vi.fn(),
  quizFindFirst: vi.fn(),
  getBrief: vi.fn(),
  upload: vi.fn(),
}));
const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    lesson: { findFirst: db.lessonFindFirst },
    diagnosticQuiz: { findFirst: db.quizFindFirst },
  },
}));
vi.mock("../../lib/session", () => session);
vi.mock("../../lib/package-chat", () => ({
  getPackagePedagogicalBrief: db.getBrief,
  uploadPreLessonAsset: db.upload,
}));

import { GET, POST } from "../../app/api/packages/[id]/assets/route";

const PKG = "pkg-1";

function user(role: string, id: string) {
  return { id, name: id, role, lessonCredits: 0, isApproved: true };
}

function getAssets() {
  return GET(new NextRequest(`http://localhost/api/packages/${PKG}/assets`), {
    params: Promise.resolve({ id: PKG }),
  });
}

function postAsset(body: Record<string, unknown>) {
  return POST(new NextRequest(`http://localhost/api/packages/${PKG}/assets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), {
    params: Promise.resolve({ id: PKG }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.quizFindFirst.mockResolvedValue(null);
  db.lessonFindFirst.mockImplementation(async ({ where }: {
    where: {
      packageId?: string;
      OR?: Array<{ studentId?: string; teacherId?: string; substituteTeacherId?: string; originalTeacherId?: string }>;
    };
  }) => {
    if (where.packageId !== PKG) return null;
    const matched = (where.OR ?? []).some((clause) =>
      clause.studentId === "student-1" ||
      clause.teacherId === "teacher-1" ||
      clause.substituteTeacherId === "sub-1" ||
      clause.originalTeacherId === "original-1"
    );
    return matched ? { id: "lesson-1" } : null;
  });
  db.getBrief.mockResolvedValue({
    preLessonAssets: [{ id: "asset-1" }],
    chat: { id: "chat-1" },
    lessons: [{ id: "lesson-1" }],
  });
  db.upload.mockResolvedValue({ id: "asset-new" });
});

describe("package asset auth", () => {
  it("returns 403 when a logged-in user is not a participant", async () => {
    session.getCurrentUser.mockResolvedValue(user("STUDENT", "other-student"));
    expect((await getAssets()).status).toBe(403);

    session.getCurrentUser.mockResolvedValue(user("TEACHER", "other-teacher"));
    expect((await getAssets()).status).toBe(403);

    session.getCurrentUser.mockResolvedValue(user("REPRESENTATIVE", "rep-1"));
    const posted = await postAsset({ assetType: "TEXT_NOTE", textContent: "שלום", uploadedById: "student-1" });
    expect(posted.status).toBe(403);
    expect(db.upload).not.toHaveBeenCalled();
    expect(db.getBrief).not.toHaveBeenCalled();
  });

  it("returns 401 when there is no session", async () => {
    session.getCurrentUser.mockResolvedValue(null);
    expect((await getAssets()).status).toBe(401);
    expect((await postAsset({ assetType: "TEXT_NOTE", textContent: "שלום" })).status).toBe(401);
  });

  it("lets the package student, its teacher, a manager, and an admin read assets", async () => {
    for (const actor of [user("STUDENT", "student-1"), user("TEACHER", "teacher-1"), user("MANAGER", "manager-1"), user("ADMIN", "admin-1")]) {
      session.getCurrentUser.mockResolvedValue(actor);
      const res = await getAssets();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.packageId).toBe(PKG);
      expect(body.assets).toEqual([{ id: "asset-1" }]);
    }
  });

  it("lets a substitute or the original teacher read the package", async () => {
    for (const actor of [user("TEACHER", "sub-1"), user("TEACHER", "original-1")]) {
      session.getCurrentUser.mockResolvedValue(actor);
      const res = await getAssets();
      expect(res.status).toBe(200);
      expect((await res.json()).packageId).toBe(PKG);
    }
    expect(db.quizFindFirst).not.toHaveBeenCalled();
  });

  it("lets the diagnostic student read a package that has no lessons", async () => {
    db.lessonFindFirst.mockResolvedValue(null);
    db.quizFindFirst.mockImplementation(async ({ where }: { where: { packageId?: string; studentId?: string } }) =>
      where.packageId === PKG && where.studentId === "student-1" ? { id: "quiz-1" } : null
    );
    session.getCurrentUser.mockResolvedValue(user("STUDENT", "student-1"));

    const res = await getAssets();
    expect(res.status).toBe(200);
    expect((await res.json()).assets).toEqual([{ id: "asset-1" }]);
    expect(db.lessonFindFirst).toHaveBeenCalled();
  });

  it("stores the upload under the session user, not the body id", async () => {
    session.getCurrentUser.mockResolvedValue(user("STUDENT", "student-1"));
    const res = await postAsset({
      assetType: "TEXT_NOTE",
      textContent: "דף עבודה",
      uploadedById: "someone-else",
    });
    expect(res.status).toBe(201);
    expect(db.upload).toHaveBeenCalledWith(expect.objectContaining({
      packageId: PKG,
      assetType: "TEXT_NOTE",
      uploadedById: "student-1",
    }));
  });
});
