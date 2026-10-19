/**
 * Stream Chat liveness for `/api/health`.
 * A missing client or a failed settings read is a down probe, never a throw.
 */

import { getStreamServerClient, hasStreamCredentials } from "./stream";

const STREAM_PROBE_TIMEOUT_MS = 2_500;

export type StreamProbe = {
  status: "up" | "down";
  latencyMs: number | null;
};

export async function probeStreamAvailability(): Promise<StreamProbe> {
  if (!hasStreamCredentials()) return { status: "down", latencyMs: null };

  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const client = getStreamServerClient();
    await Promise.race([
      client.getAppSettings(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), STREAM_PROBE_TIMEOUT_MS);
      }),
    ]);
    return { status: "up", latencyMs: Date.now() - started };
  } catch {
    console.error("[health] stream probe failed");
    return { status: "down", latencyMs: Date.now() - started };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
