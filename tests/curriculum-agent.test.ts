import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APIConnectionTimeoutError } from "openai";

const ai = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  create: vi.fn(),
}));

vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  class FakeOpenAI {
    chat = { completions: { create: ai.create } };
    constructor(options: Record<string, unknown>) {
      ai.options.push(options);
    }
  }
  return { ...actual, default: FakeOpenAI };
});

const dotenv = vi.hoisted(() => ({ config: vi.fn() }));
vi.mock("dotenv", () => ({ config: dotenv.config, default: { config: dotenv.config } }));

import {
  DEFAULT_CURRICULUM_AGENT_TIMEOUT_MS,
  parseSyllabusWithHive,
} from "../lib/curriculum-agent";

/** Snapshot now: mock call history is cleared before each test runs. */
const dotenvCallsAtImport = dotenv.config.mock.calls.length;

function completion(content: string) {
  return { choices: [{ message: { content } }] };
}

beforeEach(() => {
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
  vi.stubEnv("CURRICULUM_AGENT_TIMEOUT_MS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  ai.options.length = 0;
  ai.create.mockReset();
});

describe("environment loading", () => {
  it("never loads a local env file (agents_hive/.env) on import or call", async () => {
    expect(dotenvCallsAtImport).toBe(0);

    ai.create.mockResolvedValue(completion("[]"));
    await parseSyllabusWithHive("מתמטיקה 5 יחידות — חדו״א");
    expect(dotenv.config).not.toHaveBeenCalled();
  });

  it("reads OPENROUTER_API_KEY per call, not at import time", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const missing = await parseSyllabusWithHive("syllabus text here");
    expect(missing).toEqual({
      success: false,
      error: "OPENROUTER_API_KEY is not configured server-side (see .env)",
    });
    expect(ai.options).toHaveLength(0);

    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-late");
    ai.create.mockResolvedValue(completion("[]"));
    const ok = await parseSyllabusWithHive("syllabus text here");
    expect(ok.success).toBe(true);
    expect(ai.options[0]).toMatchObject({ apiKey: "sk-or-late" });
  });
});

describe("timeout", () => {
  it("configures a bounded client timeout with no retries by default", async () => {
    ai.create.mockResolvedValue(completion("[]"));
    await parseSyllabusWithHive("syllabus text here");
    expect(ai.options[0]).toMatchObject({
      timeout: DEFAULT_CURRICULUM_AGENT_TIMEOUT_MS,
      maxRetries: 0,
    });
    expect(DEFAULT_CURRICULUM_AGENT_TIMEOUT_MS).toBeLessThan(60_000);
  });

  it("honors CURRICULUM_AGENT_TIMEOUT_MS and ignores invalid values", async () => {
    ai.create.mockResolvedValue(completion("[]"));

    vi.stubEnv("CURRICULUM_AGENT_TIMEOUT_MS", "20000");
    await parseSyllabusWithHive("syllabus text here");
    vi.stubEnv("CURRICULUM_AGENT_TIMEOUT_MS", "not-a-number");
    await parseSyllabusWithHive("syllabus text here");
    vi.stubEnv("CURRICULUM_AGENT_TIMEOUT_MS", "-5");
    await parseSyllabusWithHive("syllabus text here");

    expect(ai.options.map((o) => o.timeout)).toEqual([
      20_000,
      DEFAULT_CURRICULUM_AGENT_TIMEOUT_MS,
      DEFAULT_CURRICULUM_AGENT_TIMEOUT_MS,
    ]);
  });

  it("returns a clear timeout error instead of throwing", async () => {
    vi.stubEnv("CURRICULUM_AGENT_TIMEOUT_MS", "20000");
    ai.create.mockRejectedValue(new APIConnectionTimeoutError());

    const result = await parseSyllabusWithHive("syllabus text here");

    expect(result).toEqual({
      success: false,
      error: "Agent parse call timed out after 20s",
    });
  });

  it("reports other provider errors without throwing", async () => {
    ai.create.mockRejectedValue(new Error("502 Bad Gateway"));
    const result = await parseSyllabusWithHive("syllabus text here");
    expect(result).toEqual({
      success: false,
      error: "Agent parse call failed: 502 Bad Gateway",
    });
  });
});

describe("output parsing", () => {
  it("strips ```json fences and returns the topic array", async () => {
    const topics = [
      {
        subject: "מתמטיקה",
        topicName: "חשבון דיפרנציאלי",
        subTopics: ["בעיות קיצון"],
        gradeLevel: "HIGH_SCHOOL",
        weightInExam: 0.4,
      },
    ];
    ai.create.mockResolvedValue(completion("```json\n" + JSON.stringify(topics) + "\n```"));

    const result = await parseSyllabusWithHive("syllabus text here");

    expect(result).toEqual({ success: true, topics, provider: "openrouter-deepseek-r1" });
  });

  it("rejects a non-array payload", async () => {
    ai.create.mockResolvedValue(completion('{"topics": []}'));
    const result = await parseSyllabusWithHive("syllabus text here");
    expect(result.success).toBe(false);
  });
});
