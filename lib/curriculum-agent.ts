import OpenAI from "openai";
import { AI_SERVICE_BUSY_MESSAGE } from "./agents/core/llm";
import { resolveOpenRouterApiKey, resolveOpenRouterBaseUrl } from "./platform-env";

export { AI_SERVICE_BUSY_MESSAGE };

/** Hard ceiling. Env may shorten this, never lengthen it past 20 s. */
export const MAX_CURRICULUM_AGENT_TIMEOUT_MS = 20_000;
export const DEFAULT_CURRICULUM_AGENT_TIMEOUT_MS = MAX_CURRICULUM_AGENT_TIMEOUT_MS;

/**
 * Read per call from the platform environment (root `.env` locally, Vercel env
 * in production). Never loads files from disk — serverless bundles have no
 * `agents_hive/.env`.
 */
function resolveTimeoutMs(): number {
  const timeoutFromEnv = Number(process.env.CURRICULUM_AGENT_TIMEOUT_MS);
  const requested =
    Number.isFinite(timeoutFromEnv) && timeoutFromEnv > 0
      ? timeoutFromEnv
      : DEFAULT_CURRICULUM_AGENT_TIMEOUT_MS;
  return Math.min(requested, MAX_CURRICULUM_AGENT_TIMEOUT_MS);
}

function getAgentConfig() {
  return {
    apiKey: resolveOpenRouterApiKey(),
    baseURL: resolveOpenRouterBaseUrl(),
    model: process.env.MODEL_ARCHITECT?.trim() || "deepseek/deepseek-r1",
    timeoutMs: resolveTimeoutMs(),
  };
}

function logOpenRouterFailure(error: unknown): void {
  const name = error instanceof Error ? error.name : "unknown";
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  console.error("[curriculum-agent] OpenRouter call failed", {
    name,
    status: typeof status === "number" ? status : null,
  });
}

export type SyllabusParseResult = {
  success: boolean;
  topics?: unknown[];
  error?: string;
  details?: unknown;
  provider?: string;
};

/**
 * Calls the OpenRouter-backed FastMCP `parse_syllabus_to_curriculum`
 * (DeepSeek-R1) to turn a syllabus / matriculation focus text into raw
 * CurriculumTopic JSON. All output is strictly re-validated on ingestion
 * (see lib/curriculum-rubric.ts).
 */
export async function parseSyllabusWithHive(
  rawTextOrMarkdown: string
): Promise<SyllabusParseResult> {
  const { apiKey, baseURL, model, timeoutMs } = getAgentConfig();
  if (!apiKey) {
    return {
      success: false,
      error: "OPENROUTER_API_KEY is not configured server-side (see .env)",
    };
  }

  // maxRetries: 0 keeps the total wall-clock time bounded by `timeoutMs`.
  // The abort signal is independent of the SDK timer, so a hung socket cannot
  // outlive the cap even if the client timeout is ignored.
  const client = new OpenAI({
    baseURL,
    apiKey,
    timeout: timeoutMs,
    maxRetries: 0,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const systemPrompt = `You are an expert EdTech Curriculum Architect.
Analyze the provided syllabus, exam focus document (מיקוד בגרות/מבחן), or course outline.
Extract and structure the curriculum into a strictly valid JSON array of CurriculumTopic objects.

Each item in the array MUST match this exact JSON schema:
{
  "subject": string (e.g. "מתמטיקה", "פיזיקה", "מדעי המחשב"),
  "topicName": string (e.g. "חשבון דיפרנציאלי ואינטגרלי", "טריגונומטריה במרחב"),
  "subTopics": array of strings (e.g. ["חקירת פונקציות מעריכיות", "בעיות קיצון"]),
  "gradeLevel": string (one of: "ELEMENTARY", "MIDDLE_SCHOOL", "HIGH_SCHOOL", "ACADEMIC"),
  "weightInExam": number (estimated exam weight/percentage as float between 0.1 and 1.0)
}

Output ONLY raw JSON (an array of objects). Do not include markdown codeblocks or conversational filler.`;

  try {
    const response = await client.chat.completions.create(
      {
        model,
        temperature: 0.1,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Parse this syllabus into CurriculumTopic objects:\n\n${rawTextOrMarkdown}`,
          },
        ],
      },
      { signal: controller.signal, timeout: timeoutMs, maxRetries: 0 }
    );
    const content = response.choices[0]?.message?.content ?? "[]";
    let clean = content.trim();
    if (clean.startsWith("```json")) clean = clean.slice(7);
    if (clean.startsWith("```")) clean = clean.slice(3);
    if (clean.endsWith("```")) clean = clean.slice(0, -3);
    clean = clean.trim();

    const parsed: unknown = JSON.parse(clean);
    if (!Array.isArray(parsed)) {
      return { success: false, error: "הפלט מהסוכן אינו מערך CurriculumTopic" };
    }

    return { success: true, topics: parsed, provider: "openrouter-deepseek-r1" };
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return { success: false, error: "הפלט מהסוכן אינו מערך CurriculumTopic" };
    }
    logOpenRouterFailure(error);
    return { success: false, error: AI_SERVICE_BUSY_MESSAGE };
  } finally {
    clearTimeout(timer);
  }
}