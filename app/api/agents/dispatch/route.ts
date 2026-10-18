import { NextResponse } from "next/server";
import { verifyCronRequest } from "../../../../lib/auth/cron";
import { AI_SERVICE_BUSY_MESSAGE } from "../../../../lib/agents/core/llm";
import { runLeadAgent } from "../../../../lib/agents/lead-agent";

export const maxDuration = 30;

const AGENTS = ["leads"] as const;
type AgentName = (typeof AGENTS)[number];

function isAgentName(value: string | null): value is AgentName {
  return AGENTS.some((agent) => agent === value);
}

/**
 * Agent swarm dispatcher: `?agent=leads`.
 * Protected by Authorization: Bearer <CRON_SECRET> or a verified QStash
 * signature (lib/auth/cron.ts). The middleware lets this path through
 * without a session, so this check is the only gate.
 */
export async function GET(request: Request) {
  if (!(await verifyCronRequest(request))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const agent = new URL(request.url).searchParams.get("agent");
  if (!isAgentName(agent)) {
    return NextResponse.json(
      { success: false, error: `Unknown agent. Supported: ${AGENTS.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    const result = await runLeadAgent();
    const openRouterDown = result.skipped.some(
      (item) => item.reason === "LLM_TIMEOUT" || item.reason === "LLM_ERROR"
    );
    if (openRouterDown) {
      console.error(
        `[agents/dispatch] ${agent} OpenRouter unavailable; exiting so QStash can retry`,
        {
          sentCount: result.sentCount,
          failedCount: result.failedCount,
          skippedCount: result.skippedCount,
        }
      );
      return NextResponse.json(
        { success: false, agent, error: AI_SERVICE_BUSY_MESSAGE },
        { status: 503 }
      );
    }
    return NextResponse.json({
      success: true,
      agent,
      processedCount: result.processedCount,
      sentCount: result.sentCount,
      failedCount: result.failedCount,
      skippedCount: result.skippedCount,
    });
  } catch (error) {
    console.error(
      `[agents/dispatch] ${agent} agent failed:`,
      error instanceof Error ? error.name : "unknown"
    );
    return NextResponse.json(
      { success: false, agent, error: "Agent run failed" },
      { status: 500 }
    );
  }
}

export const POST = GET;
