import crypto from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  webhookEventFindUnique: vi.fn(),
  webhookEventCreate: vi.fn(),
  webhookEventUpdate: vi.fn(),
  lessonFindUnique: vi.fn(),
  lessonUpdate: vi.fn(),
}));

const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));

vi.mock("../lib/prisma", () => ({
  prisma: {
    webhookEvent: {
      findUnique: db.webhookEventFindUnique,
      create: db.webhookEventCreate,
      update: db.webhookEventUpdate,
    },
    lesson: { findUnique: db.lessonFindUnique, update: db.lessonUpdate },
  },
}));

vi.mock("../lib/session", () => session);

const WEBHOOK_SECRET = Buffer.from("daily-webhook-test-secret").toString("base64");
const LESSON_ID = "3f8a2c1e-lesson";
const RECORDING_ID = "a1b2c3d4-e5f6-7890-abcd-ef0123456789";
const TEACHER = { id: "teacher-1", name: "T", role: "TEACHER", lessonCredits: 0, isApproved: true };

function signedWebhook(body: object): Request {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac("sha256", Buffer.from(WEBHOOK_SECRET, "base64"))
    .update(`${timestamp}.${raw}`)
    .digest("base64");
  return new Request("https://project100.vercel.app/api/webhooks/daily", {
    method: "POST",
    headers: { "X-Webhook-Signature": signature, "X-Webhook-Timestamp": timestamp },
    body: raw,
  });
}

function recordingReadyEvent(payload: Record<string, unknown>) {
  return {
    version: "1.0.0",
    type: "recording.ready-to-download",
    id: `evt-${crypto.randomUUID()}`,
    payload: { type: "cloud", room_name: `lesson-${LESSON_ID}`, status: "finished", ...payload },
    event_ts: Date.now() / 1000,
  };
}

function signedUrlRequest(lessonId = LESSON_ID): Request {
  return new Request(
    `https://project100.vercel.app/api/daily/signed-url?lessonId=${encodeURIComponent(lessonId)}`
  );
}

function stubDailyAccessLink(downloadLink: string, expires: number) {
  const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(async () =>
    new Response(JSON.stringify({ download_link: downloadLink, expires }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function loadWebhook() {
  return (await import("../app/api/webhooks/daily/route")).POST;
}

async function loadSignedUrl() {
  return (await import("../app/api/daily/signed-url/route")).GET;
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("DAILY_WEBHOOK_SECRET", WEBHOOK_SECRET);
  vi.stubEnv("DAILY_API_KEY", "daily-test-key");
  db.webhookEventFindUnique.mockResolvedValue(null);
  db.webhookEventCreate.mockResolvedValue({ id: "row-1" });
  db.webhookEventUpdate.mockResolvedValue({});
  db.lessonUpdate.mockResolvedValue({});
  session.getCurrentUser.mockResolvedValue(TEACHER);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("POST /api/webhooks/daily — recording.ready-to-download", () => {
  beforeEach(() => {
    db.lessonFindUnique.mockResolvedValue({ id: LESSON_ID });
  });

  it("stores daily-rec:<recording_id> instead of the expiring download link", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const POST = await loadWebhook();

    const res = await POST(
      signedWebhook(
        recordingReadyEvent({
          recording_id: RECORDING_ID,
          download_link: "https://daily-recordings.s3.amazonaws.com/x?X-Amz-Expires=3600",
        })
      )
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.lessonUpdate).toHaveBeenCalledWith({
      where: { id: LESSON_ID },
      data: { videoRecordingUrl: `daily-rec:${RECORDING_ID}` },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to payload.id when recording_id is absent", async () => {
    const POST = await loadWebhook();

    await POST(signedWebhook(recordingReadyEvent({ id: RECORDING_ID })));

    expect(db.lessonUpdate).toHaveBeenCalledWith({
      where: { id: LESSON_ID },
      data: { videoRecordingUrl: `daily-rec:${RECORDING_ID}` },
    });
  });

  it.each([
    ["missing", {}],
    ["path-injection", { recording_id: "../../rooms/abc" }],
  ])("does not persist anything when recording_id is %s", async (_label, payload) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const POST = await loadWebhook();

    const res = await POST(signedWebhook(recordingReadyEvent(payload)));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(db.lessonUpdate).not.toHaveBeenCalled();
    expect(db.webhookEventUpdate).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: { error: expect.stringContaining("recording_id") },
    });
  });

  it("rejects an unsigned recording event", async () => {
    const POST = await loadWebhook();

    const res = await POST(
      new Request("https://project100.vercel.app/api/webhooks/daily", {
        method: "POST",
        body: JSON.stringify(recordingReadyEvent({ recording_id: RECORDING_ID })),
      })
    );

    expect(res.status).toBe(401);
    expect(db.lessonUpdate).not.toHaveBeenCalled();
  });
});

describe("GET /api/daily/signed-url", () => {
  function lessonWithRecording(videoRecordingUrl: string | null) {
    db.lessonFindUnique.mockResolvedValue({
      id: LESSON_ID,
      teacherId: TEACHER.id,
      studentId: "student-1",
      videoRecordingUrl,
    });
  }

  it("mints a fresh access link from Daily for a daily-rec:<id> reference", async () => {
    lessonWithRecording(`daily-rec:${RECORDING_ID}`);
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const fetchMock = stubDailyAccessLink("https://signed.example/fresh.mp4?sig=new", expires);
    const GET = await loadSignedUrl();

    const res = await GET(signedUrlRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      url: "https://signed.example/fresh.mp4?sig=new",
      expiresAt: new Date(expires * 1000).toISOString(),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    const url = new URL(calledUrl);
    expect(url.origin + url.pathname).toBe(
      `https://api.daily.co/v1/recordings/${RECORDING_ID}/access-link`
    );
    expect(Number(url.searchParams.get("valid_for_secs"))).toBeLessThanOrEqual(2 * 60 * 60);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer daily-test-key");
  });

  it("accepts a bare recording id", async () => {
    lessonWithRecording(RECORDING_ID);
    const fetchMock = stubDailyAccessLink("https://signed.example/a.mp4", 2_000_000_000);
    const GET = await loadSignedUrl();

    const res = await GET(signedUrlRequest());

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toContain(`/recordings/${RECORDING_ID}/`);
  });

  it("returns a new link on every request instead of a cached static one", async () => {
    lessonWithRecording(`daily-rec:${RECORDING_ID}`);
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        return new Response(
          JSON.stringify({ download_link: `https://signed.example/v${n}`, expires: 2_000_000_000 }),
          { status: 200 }
        );
      })
    );
    const GET = await loadSignedUrl();

    const first = await (await GET(signedUrlRequest())).json();
    const second = await (await GET(signedUrlRequest())).json();

    expect(first.url).toBe("https://signed.example/v1");
    expect(second.url).toBe("https://signed.example/v2");
  });

  it("never serves a legacy stored download URL", async () => {
    const legacy = "https://daily-meeting-recordings.s3.amazonaws.com/dom/lesson/1?X-Amz-Expires=3600";
    lessonWithRecording(legacy);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const GET = await loadSignedUrl();

    const res = await GET(signedUrlRequest());

    expect(res.status).toBe(410);
    expect(JSON.stringify(await res.json())).not.toContain(legacy);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 502 without leaking a URL when Daily fails", async () => {
    lessonWithRecording(`daily-rec:${RECORDING_ID}`);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "not-found" }), { status: 404 }))
    );
    const GET = await loadSignedUrl();

    const res = await GET(signedUrlRequest());

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Failed to generate signed URL" });
  });

  it("returns 401 without a session and 403 for non-participants", async () => {
    lessonWithRecording(`daily-rec:${RECORDING_ID}`);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const GET = await loadSignedUrl();

    session.getCurrentUser.mockResolvedValueOnce(null);
    expect((await GET(signedUrlRequest())).status).toBe(401);

    session.getCurrentUser.mockResolvedValueOnce({ ...TEACHER, id: "outsider", role: "STUDENT" });
    expect((await GET(signedUrlRequest())).status).toBe(403);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
