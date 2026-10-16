import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({ mkdir: vi.fn(), writeFile: vi.fn() }));
vi.mock("fs/promises", () => ({ ...fsMock, default: fsMock }));

import {
  StorageUploadError,
  canUseLocalDiskStorage,
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
        headers: expect.objectContaining({ Authorization: "Bearer service-key" }),
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
});
