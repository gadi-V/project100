import { assertProductionAuthSecret } from "./lib/auth";
import { assertProductionEnv, warnDisabledSubsystems } from "./lib/env-validator";

/**
 * Runs once when a server instance starts.
 * Auth secret is checked on every runtime (including Edge, which verifies
 * session cookies). Database and Redis checks stay on Node — Edge does not
 * open Neon.
 */
export async function register(): Promise<void> {
  assertProductionAuthSecret();
  if (process.env.NEXT_RUNTIME === "edge") return;
  assertProductionEnv();
  warnDisabledSubsystems();
}
