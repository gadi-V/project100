import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ uploadBoardImage: vi.fn() }));
const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const notebooks = vi.hoisted(() => ({ getNotebookAccess: vi.fn() }));
const db = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("../lib/session", () => session);
vi.mock("../lib/notebooks", () => notebooks);
vi.mock("../lib/prisma", () => ({
  prisma: { boardImage: { create: db.create } },
}));
vi.mock("../lib/storage", () => ({
  uploadBoardImage: storage.uploadBoardImage,
  boardImageObjectPath: (imageId: string) => `board-images/${imageId}.png`,
  STORAGE_UPLOAD_CLIENT_ERROR: "Upload failed, please try again",
}));

const USER = { id: "student-1", name: "תלמיד", role: "STUDENT", lessonCredits: 1, isApproved: true };

function imageRequest(): Request {
  const form = new FormData();
  form.append("file", new File([new Uint8Array([1, 2, 3])], "board.png", { type: "image/png" }));
  form.append("notebookId", "nb-1");
  return new Request("https://project100.example/api/upload", { method: "POST", body: form });
}

beforeEach(() => {
  vi.resetModules();
  session.getCurrentUser.mockResolvedValue(USER);
  notebooks.getNotebookAccess.mockResolvedValue({ id: "nb-1", studentId: USER.id });
  storage.uploadBoardImage.mockReset();
  db.create.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/upload", () => {
  it("returns a clean JSON error when storage fails and does not leak the service key", async () => {
    storage.uploadBoardImage.mockRejectedValue(
      new Error("Supabase image upload failed (404): Bucket not found key=service-role-secret")
    );
    const { POST } = await import("../app/api/upload/route");

    const response = await POST(imageRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Upload failed, please try again" });
    const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls);
    expect(logged).not.toContain("service-role-secret");
  });
});
