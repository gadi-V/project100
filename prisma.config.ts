// project8/prisma.config.ts
import 'dotenv/config'; // טוען את קובץ ה-.env באופן מפורש
import { defineConfig } from 'prisma/config';

// Fallback so `prisma generate` / Vercel install succeeds when DATABASE_URL is
// unset. Production runtime must still set a real Neon DATABASE_URL.
const databaseUrl =
  process.env.DATABASE_URL?.trim() ||
  'postgresql://dummy:dummy@localhost:5432/dummy';

export default defineConfig({
  schema: './prisma/schema.prisma',
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: databaseUrl,
  },
});
