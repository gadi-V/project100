import { assertProductionEnv, warnDisabledSubsystems } from "./lib/env-validator";

/**
 * Runs once when the Node server starts. Edge middleware does not open Neon,
 * so the fatal P0 check stays on the Node runtime that serves pages and `/api`.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "edge") return;
  assertProductionEnv();
  warnDisabledSubsystems();
}
