import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, signSession } from "../lib/auth";

const cookieJar = vi.hoisted(() => ({ session: undefined as string | undefined }));

const db = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  teacherProfileFindUnique: vi.fn(),
  teacherProfileFindFirst: vi.fn(),
}));

const vetting = vi.hoisted(() => ({
  getTeacherVettingProgress: vi.fn(),
  updateVettingStep: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "project8_session" && cookieJar.session
        ? { name, value: cookieJar.session }
        : undefined,
  }),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: db.userFindUnique },
    teacherProfile: {
      findUnique: db.teacherProfileFindUnique,
      findFirst: db.teacherProfileFindFirst,
    },
  },
}));

vi.mock("../lib/teacher-vetting", () => vetting);

vi.mock("../lib/storage", () => ({
  uploadBoardImage: vi.fn(),
  uploadLessonPdf: vi.fn(),
}));

const ORIGIN = "https://project100.vercel.app";
const VETTING_PATH = "/api/teachers/me/vetting";
const FORWARDED_USER_ID = "x-middleware-request-x-user-id";

const SESSION_USER = {
  id: "teacher-session-user",
  name: "Session Teacher",
  role: "TEACHER",
  lessonCredits: 0,
  isApproved: false,
};

function request(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {}
): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body,
  });
}

/**
 * Next only rewrites downstream request headers when the middleware sets an
 * override list; without one the client's original headers pass through.
 */
function forwardedHeaderNames(res: Response): string[] {
  const override = res.headers.get("x-middleware-override-headers");
  expect(override, "middleware must override the forwarded request headers").not.toBeNull();
  return (override ?? "").split(",");
}

async function loadMiddleware() {
  return (await import("../proxy")).proxy;
}

async function loadVettingRoute() {
  return import("../app/api/teachers/me/vetting/route");
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("AUTH_SECRET", "vitest-auth-secret-at-least-32-characters");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  cookieJar.session = undefined;
  db.userFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === SESSION_USER.id ? SESSION_USER : null
  );
  db.teacherProfileFindUnique.mockImplementation(
    async ({ where }: { where: { userId: string } }) => ({
      id: `profile-of-${where.userId}`,
      userId: where.userId,
    })
  );
  vetting.getTeacherVettingProgress.mockImplementation(async (profileId: string) => ({
    teacherProfileId: profileId,
  }));
  vetting.updateVettingStep.mockResolvedValue({ stepNumber: 4, status: "PENDING" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("GET/POST /api/teachers/me/vetting — session-only identity", () => {
  it("rejects a spoofed x-user-id without a session cookie with 401", async () => {
    const { GET } = await loadVettingRoute();

    const res = await GET();

    expect(res.status).toBe(401);
    expect(db.teacherProfileFindUnique).not.toHaveBeenCalled();
    expect(db.teacherProfileFindFirst).not.toHaveBeenCalled();
    expect(vetting.getTeacherVettingProgress).not.toHaveBeenCalled();
  });

  it("rejects a spoofed exam-581 submission without a session cookie with 401", async () => {
    const { POST } = await loadVettingRoute();

    const res = await POST(
      request(VETTING_PATH, {
        method: "POST",
        headers: { "x-user-id": "victim-teacher", "content-type": "application/json" },
        body: JSON.stringify({ solutionUrl: "https://evil.example/solution.pdf" }),
      })
    );

    expect(res.status).toBe(401);
    expect(vetting.updateVettingStep).not.toHaveBeenCalled();
  });

  it("rejects a forged or expired session token with 401", async () => {
    cookieJar.session = "not-a-valid-jwt";
    const { GET } = await loadVettingRoute();

    const res = await GET();

    expect(res.status).toBe(401);
  });

  it("resolves the teacher from the verified session, never from the header", async () => {
    cookieJar.session = await signSession(SESSION_USER.id);
    const { POST } = await loadVettingRoute();

    const res = await POST(
      request(VETTING_PATH, {
        method: "POST",
        headers: { "x-user-id": "victim-teacher", "content-type": "application/json" },
        body: JSON.stringify({ solutionUrl: "https://files.example/solution.pdf" }),
      })
    );

    expect(res.status).toBe(200);
    expect(db.teacherProfileFindUnique).toHaveBeenCalledWith({
      where: { userId: SESSION_USER.id },
    });
    expect(vetting.updateVettingStep).toHaveBeenCalledWith(
      expect.objectContaining({ teacherProfileId: `profile-of-${SESSION_USER.id}` })
    );
  });

  it("returns only the session user's own vetting progress", async () => {
    cookieJar.session = await signSession(SESSION_USER.id);
    const { GET } = await loadVettingRoute();

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ teacherProfileId: `profile-of-${SESSION_USER.id}` });
  });
});

describe("middleware — x-user-id header spoofing", () => {
  it("returns 401 for a protected API route with only a spoofed x-user-id", async () => {
    const middleware = await loadMiddleware();

    const res = await middleware(request(VETTING_PATH, { headers: { "x-user-id": "victim" } }));

    expect(res.status).toBe(401);
    expect(res.headers.get(FORWARDED_USER_ID)).toBeNull();
  });

  it.each(["/api/webhooks/daily", "/api/diagnostic/teaser", "/login"])(
    "strips a spoofed x-user-id before forwarding %s",
    async (path) => {
      const middleware = await loadMiddleware();

      const res = await middleware(request(path, { headers: { "x-user-id": "victim" } }));

      expect(res.headers.get("x-middleware-next")).toBe("1");
      expect(forwardedHeaderNames(res)).not.toContain("x-user-id");
      expect(res.headers.get(FORWARDED_USER_ID)).toBeNull();
    }
  );

  it("replaces a spoofed x-user-id with the verified session user id", async () => {
    const token = await signSession(SESSION_USER.id);
    const middleware = await loadMiddleware();

    const res = await middleware(
      request(VETTING_PATH, {
        headers: { "x-user-id": "victim", cookie: `${SESSION_COOKIE}=${token}` },
      })
    );

    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(forwardedHeaderNames(res)).toContain("x-user-id");
    expect(res.headers.get(FORWARDED_USER_ID)).toBe(SESSION_USER.id);
  });

  it("strips x-user-id when the session cookie is forged", async () => {
    const middleware = await loadMiddleware();

    const res = await middleware(
      request("/api/webhooks/daily", {
        headers: { "x-user-id": "victim", cookie: `${SESSION_COOKIE}=forged.jwt.token` },
      })
    );

    expect(forwardedHeaderNames(res)).not.toContain("x-user-id");
    expect(res.headers.get(FORWARDED_USER_ID)).toBeNull();
  });

  it("strips x-user-id on the Hive M2M bearer path", async () => {
    vi.stubEnv("HIVE_MONITOR_SECRET", "hive-secret");
    const middleware = await loadMiddleware();

    const res = await middleware(
      request("/api/admin/curriculum", {
        headers: { "x-user-id": "victim", authorization: "Bearer hive-secret" },
      })
    );

    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(forwardedHeaderNames(res)).not.toContain("x-user-id");
    expect(res.headers.get(FORWARDED_USER_ID)).toBeNull();
  });
});
