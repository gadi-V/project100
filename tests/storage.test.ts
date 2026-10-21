import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({ mkdir: vi.fn(), writeFile: vi.fn(), readFile: vi.fn() }));
vi.mock("fs/promises", () => ({ ...fsMock, default: fsMock }));

import {
  BOARD_SIGNED_URL_TTL_SECONDS,
  LESSON_BOARDS_BUCKET,
  StorageUploadError,
  canUseLocalDiskStorage,
  probeLessonBoardsStorage,
  readBoardObject,
  uploadBoardImage,
  uploadLessonPdf,
} from "../lib/storage";

beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
  vi.stubEnv("SUPABASE_SERVICE_KEY", "");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", "");
  vi.stubEnv("NETLIFY", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fsMock.mkdir.mockReset();
  fsMock.writeFile.mockReset();
  fsMock.readFile.mockReset();
});

describe("board image storage without Supabase", () => {
  it.each([
    ["Vercel", "VERCEL", "1"],
    ["AWS Lambda", "AWS_LAMBDA_FUNCTION_NAME", "fn"],
    ["Netlify", "NETLIFY", "true"],
    ["production", "NODE_ENV", "production"],
  ])("never writes to local disk on %s", async (_label, key, value) => {
    vi.stubEnv(key, value);

    expect(canUseLocalDiskStorage()).toBe(false);
    await expect(uploadBoardImage("img1", Buffer.from("x"), "image/png")).rejects.toThrow(
      /SUPABASE_URL/
    );
    expect(fsMock.mkdir).not.toHaveBeenCalled();
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("keeps the local public/uploads fallback in development", async () => {
    vi.stubEnv("NODE_ENV", "development");

    const url = await uploadBoardImage("img1", Buffer.from("x"), "image/webp");

    expect(url).toBe("/uploads/board/img1.webp");
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
  });
});

describe("board image storage with Supabase", () => {
  it("uploads to Supabase even on serverless, without touching disk", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubEnv("SUPABASE_STORAGE_PUBLIC", "true");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const url = await uploadBoardImage("img1", Buffer.from("x"), "image/png");

    expect(url).toBe(
      "https://proj.supabase.co/storage/v1/object/public/lesson-boards/board-images/img1.png"
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://proj.supabase.co/storage/v1/object/lesson-boards/board-images/img1.png",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer service-key",
          apikey: "service-key",
        }),
      })
    );
    expect(fsMock.writeFile).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("returns a safe error when the bucket is missing and does not leak the service key", async () => {
    vi.stubEnv("SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-secret");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":"Bucket not found","key":"service-role-secret"}', { status: 404 }))
    );

    const failure = uploadBoardImage("img1", Buffer.from("x"), "image/png");

    await expect(failure).rejects.toBeInstanceOf(StorageUploadError);
    await expect(failure).rejects.toThrow("Upload failed, please try again");
    expect(console.error).toHaveBeenCalled();
    const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls);
    expect(logged).not.toContain("service-role-secret");
    vi.unstubAllGlobals();
  });

  it("returns a safe error on a network timeout", async () => {
    vi.stubEnv("SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_KEY", "service-key");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted", "TimeoutError");
      })
    );

    await expect(uploadLessonPdf("lesson-1", Buffer.from("pdf"))).rejects.toThrow(
      "Upload failed, please try again"
    );
    vi.unstubAllGlobals();
  });

  it("uploads a PNG and a PDF to lesson-boards and returns a time-limited signed URL", async () => {
    vi.stubEnv("SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubEnv("SUPABASE_STORAGE_PUBLIC", "false");
    vi.stubEnv("SUPABASE_SIGNED_URL_TTL", "120");
    vi.stubEnv("SUPABASE_STORAGE_BUCKET", "");
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/object/sign/")) {
        return new Response(
          JSON.stringify({ signedURL: "/storage/v1/object/sign/lesson-boards/file?token=t" }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const png = await uploadBoardImage("img1", Buffer.from("png"), "image/png");
    const pdf = await uploadLessonPdf("lesson-1", Buffer.from("pdf"));

    expect(LESSON_BOARDS_BUCKET).toBe("lesson-boards");
    expect(png).toBe(
      "https://proj.supabase.co/storage/v1/object/sign/lesson-boards/file?token=t"
    );
    expect(pdf).toBe(png);
    const uploads = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(uploads).toContain(
      "https://proj.supabase.co/storage/v1/object/lesson-boards/board-images/img1.png"
    );
    expect(uploads).toContain(
      "https://proj.supabase.co/storage/v1/object/lesson-boards/lessons/lesson-1/board-summary.pdf"
    );
    const signBodies = fetchMock.mock.calls
      .filter((call) => String(call[0]).includes("/object/sign/"))
      .map((call) => JSON.parse(String(call[1]?.body ?? "{}")) as { expiresIn: number });
    expect(signBodies).toEqual([{ expiresIn: 120 }, { expiresIn: 120 }]);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("defaults to a private bucket and a 60-minute signed URL, with no local disk write", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SUPABASE_URL", "https://proj.supabase.co/");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubEnv("SUPABASE_STORAGE_PUBLIC", "");
    vi.stubEnv("SUPABASE_SIGNED_URL_TTL", "");
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/object/sign/")) {
        return new Response(
          JSON.stringify({ signedURL: "/storage/v1/object/sign/lesson-boards/board-images/img1.png?token=t" }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const url = await uploadBoardImage("img1", Buffer.from("png"), "image/png");

    expect(BOARD_SIGNED_URL_TTL_SECONDS).toBe(3600);
    expect(url).toBe(
      "https://proj.supabase.co/storage/v1/object/sign/lesson-boards/board-images/img1.png?token=t"
    );
    const sign = fetchMock.mock.calls.find((call) => String(call[0]).includes("/object/sign/"));
    expect(JSON.parse(String(sign?.[1]?.body))).toEqual({ expiresIn: 3600 });
    expect(fsMock.mkdir).not.toHaveBeenCalled();
    expect(fsMock.writeFile).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("saves under public/uploads/board in development when Supabase rejects the upload", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 500 })));

    const url = await uploadBoardImage("img-local", Buffer.from("png"), "image/png");

    expect(url).toBe("/uploads/board/img-local.png");
    expect(fsMock.mkdir).toHaveBeenCalled();
    expect(fsMock.writeFile).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("serves the local file when Supabase has no object in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    fsMock.readFile.mockResolvedValue(Buffer.from("local-bytes"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));

    const bytes = await readBoardObject("board-images/img-local.jpg");

    expect(bytes?.toString()).toBe("local-bytes");
    expect(fsMock.readFile).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("does not read local disk when Supabase is missing the object in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));

    await expect(readBoardObject("board-images/img-local.jpg")).resolves.toBeNull();
    expect(fsMock.readFile).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("lesson-boards storage probe", () => {
  it("is down without a network call when Supabase keys are missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(probeLessonBoardsStorage()).resolves.toEqual({ status: "down", latencyMs: null });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("reports the lesson-boards bucket as up and measures latency", async () => {
    vi.stubEnv("SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubEnv("SUPABASE_STORAGE_BUCKET", "lesson-boards");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "lesson-boards" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const probe = await probeLessonBoardsStorage();

    expect(probe.status).toBe("up");
    expect(probe.latencyMs).toEqual(expect.any(Number));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://proj.supabase.co/storage/v1/bucket/lesson-boards",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer service-key",
          apikey: "service-key",
        }),
      })
    );
    vi.unstubAllGlobals();
  });

  it("stays down when the bucket check fails and does not throw", async () => {
    vi.stubEnv("SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("The operation was aborted", "TimeoutError");
    }));

    await expect(probeLessonBoardsStorage()).resolves.toMatchObject({ status: "down" });
    vi.unstubAllGlobals();
  });
});
