import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  userFindMany: vi.fn(),
  fallbackLeadFindMany: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findMany: db.userFindMany },
    fallbackLead: { findMany: db.fallbackLeadFindMany },
  },
}));

type FetchMock = ReturnType<typeof vi.fn<(input: string, init: RequestInit) => Promise<Response>>>;

const ORIGIN = "https://project100.vercel.app";
const NOW = new Date("2026-09-29T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);

function userLead(id: string, phone: string, createdAt = hoursAgo(10)) {
  return {
    id,
    name: `דנה ${id}`,
    phone,
    createdAt,
    classTrack: null,
    trackType: "BAGRUT",
    degreeField: null,
    academicYear: null,
    targetOrganization: null,
    diagnosticQuizzes: [
      { subject: "מתמטיקה", ageGroup: "תיכון", learningGoal: "בגרות 5 יח״ל", examTimeframe: null },
    ],
  };
}

function fallbackLead(id: string, phone: string, createdAt = hoursAgo(5)) {
  return { id, name: `יואב ${id}`, phone, createdAt, grade: "י׳", requestedHours: "ערב" };
}

function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function stubLLM(message = "היי, ראינו שנרשמת למתמטיקה. נשמח להציע מורה ושעה שנוחה לך."): FetchMock {
  const fetchMock: FetchMock = vi.fn(async () => completion(JSON.stringify({ message })));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A fetch that never answers until its AbortSignal fires. */
function stubHangingLLM(): FetchMock {
  const fetchMock: FetchMock = vi.fn(
    (_input: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("This operation was aborted", "AbortError"))
        );
      })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function dispatchRequest(query = "?agent=leads", headers: Record<string, string> = {}) {
  return new NextRequest(`${ORIGIN}/api/agents/dispatch${query}`, { headers });
}

async function loadLLM() {
  return import("../lib/agents/core/llm");
}

async function loadLeadAgent() {
  return import("../lib/agents/lead-agent");
}

async function loadDispatch() {
  return import("../app/api/agents/dispatch/route");
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
  vi.stubEnv("MODEL_AUTOMATION", "");
  vi.stubEnv("CRON_SECRET", "cron-test-secret");
  vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "qstash-test-key");
  db.userFindMany.mockResolvedValue([]);
  db.fallbackLeadFindMany.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("GET/POST /api/agents/dispatch — auth", () => {
  it.each([
    ["no credentials", {}],
    ["a wrong CRON_SECRET", { authorization: "Bearer wrong-secret" }],
    ["a session-style header only", { "x-user-id": "admin-user" }],
    ["a bare upstash-signature", { "upstash-signature": "not-a-jwt" }],
  ])("rejects %s with 401 and never runs the agent", async (_label, headers) => {
    const fetchMock = stubLLM();
    const { GET, POST } = await loadDispatch();

    const getRes = await GET(dispatchRequest("?agent=leads", headers));
    const postRes = await POST(dispatchRequest("?agent=leads", headers));

    expect(getRes.status).toBe(401);
    expect(postRes.status).toBe(401);
    expect(db.userFindMany).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when CRON_SECRET is unset", async () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await loadDispatch();

    const res = await GET(dispatchRequest("?agent=leads", { authorization: "Bearer " }));

    expect(res.status).toBe(401);
  });

  it("runs the leads agent with a valid CRON_SECRET and returns a summary", async () => {
    db.userFindMany.mockResolvedValue([userLead("u1", "054-123-4567")]);
    db.fallbackLeadFindMany.mockResolvedValue([fallbackLead("f1", "0521112233")]);
    stubLLM();
    const { GET, maxDuration } = await loadDispatch();

    const res = await GET(
      dispatchRequest("?agent=leads", { authorization: "Bearer cron-test-secret" })
    );

    expect(maxDuration).toBe(30);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      agent: "leads",
      processedCount: 2,
      skippedCount: 0,
    });
  });

  it("returns 400 for an unknown or missing agent after auth", async () => {
    const { GET } = await loadDispatch();
    const auth = { authorization: "Bearer cron-test-secret" };

    expect((await GET(dispatchRequest("?agent=nope", auth))).status).toBe(400);
    expect((await GET(dispatchRequest("", auth))).status).toBe(400);
    expect(db.userFindMany).not.toHaveBeenCalled();
  });

  it("is reachable through the middleware without a session (handler does the auth)", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    const { middleware } = await import("../middleware");

    const res = await middleware(
      dispatchRequest("?agent=leads", { authorization: "Bearer from-qstash" })
    );

    expect(res.status).not.toBe(401);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("runLeadAgent", () => {
  it("queries 48 h students with no active lesson and no purchase, plus unhandled web leads", async () => {
    stubLLM();
    const { runLeadAgent } = await loadLeadAgent();

    await runLeadAgent({ now: NOW });

    const [userQuery] = db.userFindMany.mock.calls[0] as [{ where: Record<string, unknown> }];
    expect(userQuery.where).toEqual({
      role: "STUDENT",
      createdAt: { gte: hoursAgo(48) },
      takenLessons: { none: { status: { notIn: ["CANCELLED", "CANCELLED_LATE"] } } },
      ledgerEntries: { none: { entryType: "CHARGE" } },
      payments: { none: { status: "COMPLETED" } },
    });
    const [leadQuery] = db.fallbackLeadFindMany.mock.calls[0] as [{ where: Record<string, unknown> }];
    expect(leadQuery.where).toEqual({ createdAt: { gte: hoursAgo(48) }, isHandled: false });
  });

  it("normalizes lead phones to WhatsApp JIDs and skips invalid or duplicate numbers", async () => {
    db.userFindMany.mockResolvedValue([
      userLead("u-local", "054-123-4567", hoursAgo(30)),
      userLead("u-intl", "+972 52 765 4321", hoursAgo(20)),
      userLead("u-bad", "12345", hoursAgo(15)),
    ]);
    db.fallbackLeadFindMany.mockResolvedValue([
      fallbackLead("f-dup", "0541234567", hoursAgo(10)),
      fallbackLead("f-00", "00972501112233", hoursAgo(5)),
    ]);
    stubLLM();
    const { runLeadAgent } = await loadLeadAgent();

    const { tasks, skipped } = await runLeadAgent({ now: NOW });

    expect(tasks.map(({ leadId, source, phoneJid }) => ({ leadId, source, phoneJid }))).toEqual([
      { leadId: "u-local", source: "user", phoneJid: "972541234567@c.us" },
      { leadId: "u-intl", source: "user", phoneJid: "972527654321@c.us" },
      { leadId: "f-00", source: "fallback_lead", phoneJid: "972501112233@c.us" },
    ]);
    for (const task of tasks) {
      expect(task.phoneJid).toMatch(/^972\d{8,9}@c\.us$/);
    }
    expect(skipped).toEqual([
      { leadId: "u-bad", reason: "INVALID_PHONE" },
      { leadId: "f-dup", reason: "DUPLICATE_PHONE" },
    ]);
  });

  it("builds the message from the LLM output, appends an opt-out, and never sends phones to the LLM", async () => {
    db.userFindMany.mockResolvedValue([userLead("u1", "054-123-4567")]);
    const fetchMock = stubLLM("היי דנה, נשמח לעזור למצוא מורה למתמטיקה.");
    const { runLeadAgent, OPT_OUT_LINE } = await loadLeadAgent();

    const { tasks } = await runLeadAgent({ now: NOW });

    expect(tasks[0].messageText).toBe(`היי דנה, נשמח לעזור למצוא מורה למתמטיקה.\n\n${OPT_OUT_LINE}`);
    const body = String(fetchMock.mock.calls[0][1].body);
    expect(body).not.toContain("1234567");
    expect(body).toContain("מתמטיקה");
  });

  it("skips leads whose LLM output is not the expected JSON", async () => {
    db.userFindMany.mockResolvedValue([userLead("u1", "054-123-4567")]);
    vi.stubGlobal("fetch", vi.fn(async () => completion("not json")));
    const { runLeadAgent } = await loadLeadAgent();

    const result = await runLeadAgent({ now: NOW });

    expect(result).toEqual({ tasks: [], skipped: [{ leadId: "u1", reason: "INVALID_MESSAGE" }] });
  });

  it("marks leads as LLM_TIMEOUT when OpenRouter hangs, without throwing", async () => {
    vi.useFakeTimers({ now: NOW });
    db.userFindMany.mockResolvedValue([
      userLead("u1", "054-123-4567"),
      userLead("u2", "052-765-4321"),
    ]);
    stubHangingLLM();
    const { runLeadAgent } = await loadLeadAgent();

    const run = runLeadAgent({ now: NOW });
    await vi.advanceTimersByTimeAsync(25_000);
    const result = await run;

    expect(result.tasks).toEqual([]);
    expect(result.skipped).toEqual([
      { leadId: "u1", reason: "LLM_TIMEOUT" },
      { leadId: "u2", reason: "LLM_TIMEOUT" },
    ]);
  });

  it("stops calling the LLM once the run budget is spent", async () => {
    db.userFindMany.mockResolvedValue([userLead("u1", "054-123-4567")]);
    const fetchMock = stubLLM();
    const { runLeadAgent } = await loadLeadAgent();

    const result = await runLeadAgent({ now: NOW, budgetMs: 1_000 });

    expect(result.skipped).toEqual([{ leadId: "u1", reason: "DEADLINE" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("callAgentLLM", () => {
  it("posts to OpenRouter with the key, default model and JSON response format", async () => {
    const fetchMock = stubLLM();
    const { callAgentLLM, OPENROUTER_CHAT_URL } = await loadLLM();

    await callAgentLLM({ systemPrompt: "sys", userPrompt: "user" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(OPENROUTER_CHAT_URL);
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-test");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "deepseek/deepseek-chat",
      temperature: 0.2,
      response_format: { type: "json_object" },
    });
  });

  it("reads MODEL_AUTOMATION per call and omits response_format for text", async () => {
    vi.stubEnv("MODEL_AUTOMATION", "openai/gpt-4o-mini");
    const fetchMock = stubLLM();
    const { callAgentLLM } = await loadLLM();

    await callAgentLLM({ systemPrompt: "s", userPrompt: "u", responseFormat: "text" });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.model).toBe("openai/gpt-4o-mini");
    expect(body).not.toHaveProperty("response_format");
  });

  it("throws a clear CONFIG error when OPENROUTER_API_KEY is missing", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const fetchMock = stubLLM();
    const { callAgentLLM } = await loadLLM();

    await expect(callAgentLLM({ systemPrompt: "s", userPrompt: "u" })).rejects.toMatchObject({
      name: "AgentLLMError",
      code: "CONFIG",
      message: expect.stringContaining("OPENROUTER_API_KEY"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts after 25 s with a TIMEOUT error and clears the timer", async () => {
    vi.useFakeTimers();
    stubHangingLLM();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const { callAgentLLM, AGENT_LLM_TIMEOUT_MS } = await loadLLM();
    expect(AGENT_LLM_TIMEOUT_MS).toBe(25_000);

    const call = callAgentLLM({ systemPrompt: "s", userPrompt: "u" });
    const assertion = expect(call).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(24_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;

    expect(clearSpy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never waits longer than 25 s even if a caller asks for more", async () => {
    vi.useFakeTimers();
    stubHangingLLM();
    const { callAgentLLM } = await loadLLM();

    const call = callAgentLLM({ systemPrompt: "s", userPrompt: "u", timeoutMs: 120_000 });
    const assertion = expect(call).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(25_000);
    await assertion;
  });

  it("clears the timer on success and surfaces HTTP errors with status", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429 }))
    );
    const { callAgentLLM } = await loadLLM();

    await expect(callAgentLLM({ systemPrompt: "s", userPrompt: "u" })).rejects.toMatchObject({
      code: "HTTP",
      status: 429,
    });
    expect(clearSpy).toHaveBeenCalled();
  });
});
