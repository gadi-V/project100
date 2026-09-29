import OpenAI, { APIConnectionTimeoutError } from "openai";

/** Kept below the 60 s serverless function limit so the route can still answer. */
export const DEFAULT_CURRICULUM_AGENT_TIMEOUT_MS = 45_000;

/**
 * Read per call from the platform environment (root `.env` locally, Vercel env
 * in production). Never loads files from disk — serverless bundles have no
 * `agents_hive/.env`.
 */
function getAgentConfig() {
  const timeoutFromEnv = Number(process.env.CURRICULUM_AGENT_TIMEOUT_MS);
  return {
    apiKey: process.env.OPENROUTER_API_KEY?.trim() || null,
    baseURL: process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1",
    model: process.env.MODEL_ARCHITECT?.trim() || "deepseek/deepseek-r1",
    timeoutMs:
      Number.isFinite(timeoutFromEnv) && timeoutFromEnv > 0
        ? timeoutFromEnv
        : DEFAULT_CURRICULUM_AGENT_TIMEOUT_MS,
  };
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
  const client = new OpenAI({
    baseURL,
    apiKey,
    timeout: timeoutMs,
    maxRetries: 0,
  });

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
    const response = await client.chat.completions.create({
      model,
      temperature: 0.1,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Parse this syllabus into CurriculumTopic objects:\n\n${rawTextOrMarkdown}`,
        },
      ],
    });
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
    if (error instanceof APIConnectionTimeoutError) {
      return {
        success: false,
        error: `Agent parse call timed out after ${Math.round(timeoutMs / 1000)}s`,
      };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Agent parse call failed: ${msg}` };
  }
}