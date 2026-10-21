import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  access: vi.fn(),
  create: vi.fn(),
  findImage: vi.fn(),
  upload: vi.fn(),
  read: vi.fn(),
}));
const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));

vi.mock("../../lib/session", () => session);
vi.mock("../../lib/notebooks", () => ({ getNotebookAccess: db.access }));
vi.mock("../../lib/prisma", () => ({
  prisma: {
    boardImage: { create: db.create, findUnique: db.findImage },
  },
}));
vi.mock("../../lib/storage", () => ({
  uploadBoardImage: db.upload,
  readBoardObject: db.read,
  boardImageObjectPath: (imageId: string, contentType: string) => {
    const ext = contentType.includes("png") ? "png" : "jpg";
    return `board-images/${imageId}.${ext}`;
  },
  STORAGE_UPLOAD_CLIENT_ERROR: "Upload failed, please try again",
}));

import { consumeBoardUpload, resetBoardUploadLimits } from "../../lib/board-upload-limit";
import { POST as upload } from "../../app/api/upload/route";
import { GET as readImage } from "../../app/api/board-images/[id]/route";

const NOTEBOOK = "nb-1";
const OWNER = {
  id: "student-1",
  name: "נועה",
  role: "STUDENT" as const,
  lessonCredits: 1,
  isApproved: true,
};

function fileRequest(notebookId = NOTEBOOK) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array([1, 2, 3, 4])], "board.png", { type: "image/png" }));
  form.append("notebookId", notebookId);
  return new NextRequest("http://localhost/api/upload", { method: "POST", body: form });
}

function readRequest(id = "abcdefghijkl") {
  return readImage(new NextRequest(`http://localhost/api/board-images/${id}`), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetBoardUploadLimits();
  session.getCurrentUser.mockResolvedValue(OWNER);
  db.access.mockResolvedValue({ id: NOTEBOOK, studentId: OWNER.id });
  db.upload.mockResolvedValue("https://signed.example/ignored");
  db.create.mockImplementation(async ({ data }: { data: { id: string } }) => data);
  db.findImage.mockResolvedValue(null);
  db.read.mockResolvedValue(Buffer.from("png-bytes"));
});

describe("POST /api/upload notebook access", () => {
  it("requires a session and notebook access, and returns only the image id", async () => {
    session.getCurrentUser.mockResolvedValueOnce(null);
    expect((await upload(fileRequest())).status).toBe(401);

    db.access.mockResolvedValueOnce(null);
    expect((await upload(fileRequest())).status).toBe(403);
    expect(db.upload).not.toHaveBeenCalled();
    expect(db.create).not.toHaveBeenCalled();

    const res = await upload(fileRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(["id"]);
    expect(body.id).toHaveLength(12);
    expect(body).not.toHaveProperty("url");
    expect(db.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: body.id,
        notebookId: NOTEBOOK,
        uploaderId: OWNER.id,
        path: `board-images/${body.id}.png`,
        contentType: "image/png",
        bytes: 4,
      }),
    });
  });

  it("allows 10 uploads per minute for one user and rejects the next", async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await upload(fileRequest())).status).toBe(200);
    }
    const blocked = await upload(fileRequest());
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    expect(db.upload).toHaveBeenCalledTimes(10);
    expect(consumeBoardUpload("someone-else").ok).toBe(true);
  });
});

describe("GET /api/board-images/[id]", () => {
  const row = {
    id: "abcdefghijkl",
    notebookId: NOTEBOOK,
    uploaderId: OWNER.id,
    path: "board-images/abcdefghijkl.png",
    contentType: "image/png",
    bytes: 9,
  };

  it("returns 401, 404, and 200 without distinguishing a forbidden image from a missing one", async () => {
    session.getCurrentUser.mockResolvedValueOnce(null);
    expect((await readRequest()).status).toBe(401);

    db.findImage.mockResolvedValueOnce(null);
    expect((await readRequest()).status).toBe(404);

    db.findImage.mockResolvedValue(row);
    db.access.mockResolvedValueOnce(null);
    expect((await readRequest()).status).toBe(404);
    expect(db.read).not.toHaveBeenCalled();

    db.access.mockResolvedValue({ id: NOTEBOOK, studentId: OWNER.id });
    const res = await readRequest();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=3600");
    expect(res.headers.get("ETag")).toMatch(/^"[a-f0-9]+"$/);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("png-bytes");
    expect(db.read).toHaveBeenCalledWith(row.path);
  });
});
