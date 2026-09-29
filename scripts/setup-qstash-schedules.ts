import { config } from "dotenv";
config();

/**
 * Creates or updates the Upstash QStash schedules that drive frequent cron jobs
 * (Vercel Hobby only allows one cron run per day).
 *
 * Each schedule forwards `Authorization: Bearer <CRON_SECRET>`, the same header
 * Vercel Cron sends, so routes validate both callers via lib/auth/cron.ts.
 * Re-running is safe: `Upstash-Schedule-Id` overwrites the existing schedule.
 *
 * Required env: QSTASH_TOKEN, CRON_SECRET, APP_URL (public https origin).
 * Optional env: QSTASH_URL (regional endpoint, defaults to https://qstash.upstash.io).
 *
 * Run: npm run qstash:schedules
 */

type ScheduleSpec = {
  id: string;
  path: string;
  cron: string;
  retries: number;
};

const SCHEDULES: readonly ScheduleSpec[] = [
  { id: "lesson-reminders", path: "/api/cron/reminders", cron: "*/5 * * * *", retries: 2 },
];

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name}. Set it in .env or the shell before running this script.`);
    process.exit(1);
  }
  return value;
}

async function upsertSchedule(
  spec: ScheduleSpec,
  qstashUrl: string,
  qstashToken: string,
  appUrl: string,
  cronSecret: string
): Promise<boolean> {
  const destination = `${appUrl}${spec.path}`;
  const res = await fetch(`${qstashUrl}/v2/schedules/${destination}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${qstashToken}`,
      "Upstash-Cron": spec.cron,
      "Upstash-Schedule-Id": spec.id,
      "Upstash-Method": "GET",
      "Upstash-Retries": String(spec.retries),
      "Upstash-Forward-Authorization": `Bearer ${cronSecret}`,
    },
    signal: AbortSignal.timeout(15_000),
  });

  const body = await res.text();
  if (!res.ok) {
    console.error(`  FAIL ${spec.id}: HTTP ${res.status} ${body}`);
    return false;
  }
  console.log(`  OK   ${spec.id}: ${spec.cron} → ${destination} (${body})`);
  return true;
}

async function main(): Promise<void> {
  const qstashToken = requireEnv("QSTASH_TOKEN");
  const cronSecret = requireEnv("CRON_SECRET");
  const appUrl = requireEnv("APP_URL").replace(/\/$/, "");
  const qstashUrl = (process.env.QSTASH_URL?.trim() || "https://qstash.upstash.io").replace(/\/$/, "");

  if (!appUrl.startsWith("https://")) {
    console.error(`APP_URL must be the public https origin QStash can reach (got "${appUrl}").`);
    process.exit(1);
  }

  console.log(`Upserting ${SCHEDULES.length} QStash schedule(s) for ${appUrl}\n`);
  let failures = 0;
  for (const spec of SCHEDULES) {
    const ok = await upsertSchedule(spec, qstashUrl, qstashToken, appUrl, cronSecret);
    if (!ok) failures += 1;
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
