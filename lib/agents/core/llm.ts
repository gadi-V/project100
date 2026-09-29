/**
 * Minimal OpenRouter chat client for Vercel Functions: plain fetch, no SDK,
 * config read per call from the platform env, and a hard abort deadline.
 */

export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export const AGENT_LLM_TIMEOUT_MS = 25_000;

export type AgentLLMErrorCode = "CONFIG" | "TIMEOUT" | "HTTP" | "EMPTY_RESPONSE" | "NETWORK";

export class AgentLLMError extends Error {
  readonly code: AgentLLMErrorCode;
  readonly status?: number;

  constructor(code: AgentLLMErrorCode, message: string, status?: number) {
    super(message);
    this.name = "AgentLLMError";
    this.code = code;
    this.status = status;
  }
}

type ChatCompletionResponse = {
  choices?: { message?: { content?: string | null } }[];
};

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

export async function callAgentLLM({
  systemPrompt,
  userPrompt,
  model = process.env.MODEL_AUTOMATION || "deepseek/deepseek-chat",
  temperature = 0.2,
  responseFormat = "json_object",
  timeoutMs = AGENT_LLM_TIMEOUT_MS,
}: {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  temperature?: number;
  responseFormat?: "json_object" | "text";
  /** Capped at AGENT_LLM_TIMEOUT_MS; callers pass less to fit a function deadline. */
  timeoutMs?: number;
}): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new AgentLLMError("CONFIG", "OPENROUTER_API_KEY is not configured");
  }

  const effectiveTimeoutMs = Math.max(1, Math.min(timeoutMs, AGENT_LLM_TIMEOUT_MS));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);

  try {
    const response = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "project8-agents",
      },
      body: JSON.stringify({
        model,
        temperature,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        ...(responseFormat === "json_object"
          ? { response_format: { type: "json_object" } }
          : {}),
      }),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new AgentLLMError(
        "HTTP",
        `OpenRouter request failed (${response.status}): ${detail || response.statusText}`,
        response.status
      );
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new AgentLLMError("EMPTY_RESPONSE", "OpenRouter returned an empty completion");
    }
    return content;
  } catch (error) {
    if (error instanceof AgentLLMError) throw error;
    if (isAbortError(error)) {
      throw new AgentLLMError(
        "TIMEOUT",
        `OpenRouter did not respond within ${effectiveTimeoutMs} ms`
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentLLMError("NETWORK", `OpenRouter request failed: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}
