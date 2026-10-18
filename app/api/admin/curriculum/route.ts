import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "../../../../lib/prisma";
import { requireAuth } from "../../../../lib/api-auth";
import { writeAuditLog } from "../../../../lib/audit";
import {
  AI_SERVICE_BUSY_MESSAGE,
  parseSyllabusWithHive,
  type SyllabusParseResult,
} from "../../../../lib/curriculum-agent";
import { sanitizeCurriculumTopics } from "../../../../lib/curriculum-rubric";

const CURRICULUM_GRADE_LEVELS = [
  "ELEMENTARY",
  "MIDDLE_SCHOOL",
  "HIGH_SCHOOL",
  "ACADEMIC",
] as const;

const SYLLABUS_CLIENT_ERRORS = new Set([
  AI_SERVICE_BUSY_MESSAGE,
  "הפלט מהסוכן אינו מערך CurriculumTopic",
  "OPENROUTER_API_KEY is not configured server-side (see .env)",
  "האג'נט נכשל בניתוח הסילבוס",
]);

function syllabusClientError(error: string | undefined): string {
  if (error && SYLLABUS_CLIENT_ERRORS.has(error)) return error;
  return AI_SERVICE_BUSY_MESSAGE;
}

/**
 * POST /api/admin/curriculum
 * Body: { text: string }
 * Invokes the FastMCP `parse_syllabus_to_curriculum` agent and returns a
 * non-commited CurriculumTopic[] preview for admin review.
 */
export async function POST(request: Request) {
  try {
    const auth = await requireAuth(["ADMIN", "MANAGER"]);
    if (auth.error) return auth.error;

    const body = await request.json().catch(() => ({}));
    const rawText =
      typeof body?.rawText === "string" ? body.rawText : typeof body?.text === "string" ? body.text : "";

    if (!rawText || rawText.trim().length < 10) {
      return NextResponse.json(
        { error: "יש להזין טקסט/מארקדאון של סילבוס (מינימום 10 תווים)" },
        { status: 400 }
      );
    }

    const result: SyllabusParseResult = await parseSyllabusWithHive(rawText);
    if (!result.success || !result.topics) {
      return NextResponse.json(
        { error: syllabusClientError(result.error) },
        { status: 502 }
      );
    }

    const preview = sanitizeCurriculumTopics(result.topics);
    if (preview.length === 0) {
      return NextResponse.json(
        { error: "האג'נט לא החזיר נושאים תקניים" },
        { status: 422 }
      );
    }

    await writeAuditLog({
      actorId: auth.user.id,
      action: "CURRICULUM_PARSE_PREVIEW",
      entityType: "CurriculumTopic",
      metadata: { count: preview.length, provider: result.provider ?? null },
    });

    return NextResponse.json({ success: true, topics: preview });
  } catch (error: unknown) {
    console.error("Admin curriculum parse error:", error);
    return NextResponse.json({ error: "שגיאה בניתוח הסילבוס" }, { status: 500 });
  }
}

/**
 * PUT /api/admin/curriculum  (commit)
 * Body: { topics: CurriculumTopic[] }
 * Batch-inserts reviewed topics. Additive-only: never touches existing rows.
 */
export async function PUT(request: Request) {
  try {
    const auth = await requireAuth(["ADMIN", "MANAGER"]);
    if (auth.error) return auth.error;

    const body = await request.json().catch(() => ({}));
    const topics = sanitizeCurriculumTopics(body?.topics);
    if (topics.length === 0) {
      return NextResponse.json(
        { error: "אין נושאים תקניים להזרקה" },
        { status: 400 }
      );
    }

    const created = await prisma.$transaction(async (tx) => {
      const rows: Array<{ id: string; topicName: string; subject: string }> = [];
      for (const t of topics) {
        const row = await tx.curriculumTopic.create({
          data: {
            subject: t.subject,
            topicName: t.topicName,
            subTopics: t.subTopics,
            gradeLevel: t.gradeLevel,
            weightInExam: t.weightInExam,
          },
        });
        rows.push(row);
      }
      return rows;
    });

    await writeAuditLog({
      actorId: auth.user.id,
      action: "CURRICULUM_COMMIT",
      entityType: "CurriculumTopic",
      entityId: created[0]?.id ?? null,
      metadata: { count: created.length, subjects: [...new Set(topics.map((t) => t.subject))] },
    });

    return NextResponse.json({ success: true, count: created.length, topics: created });
  } catch (error: unknown) {
    console.error("Admin curriculum commit error:", error);
    return NextResponse.json({ error: "שגיאה בהמחזת נושאים" }, { status: 500 });
  }
}

/**
 * GET /api/admin/curriculum
 * Fetches registered topics grouped by subject → gradeLevel with:
 *   - topicCount per group
 *   - active teachers proficient in each topic
 *   (proficiency = teacherProfile.topicProficiencies keyed by topic id or name)
 */
export async function GET() {
  try {
    const auth = await requireAuth(["ADMIN", "MANAGER"]);
    if (auth.error) return auth.error;

    const topics = await prisma.curriculumTopic.findMany({
      orderBy: [{ subject: "asc" }, { gradeLevel: "asc" }, { topicName: "asc" }],
      include: {},
    });

    const teachers = await prisma.teacherProfile.findMany({
      where: { topicProficiencies: { not: Prisma.JsonNull } },
      select: {
        userId: true,
        subjects: true,
        topicProficiencies: true,
        user: { select: { id: true, name: true, isApproved: true } },
      },
    });

    // Build groups: subject -> gradeLevel -> topic + teacher counts
    const grouped: Array<{
      subject: string;
      gradeLevel: string;
      topics: Array<{
        id: string;
        topicName: string;
        subTopics: string[];
        weightInExam: number;
        teacherCount: number;
        teacherNames: string[];
      }>;
    }> = [];

    for (const t of topics) {
      let group = grouped.find(
        (g) => g.subject === t.subject && g.gradeLevel === t.gradeLevel
      );
      if (!group) {
        group = { subject: t.subject, gradeLevel: t.gradeLevel, topics: [] };
        grouped.push(group);
      }

      let teacherCount = 0;
      const teacherNames: string[] = [];
      for (const prof of teachers) {
        const map = prof.topicProficiencies as Record<string, number> | null;
        if (!map) continue;
        const direct = map[t.id] ?? map[t.topicName] ?? map[t.topicName.toLowerCase()];
        if (typeof direct === "number" && direct >= 60) {
          teacherCount += 1;
          if (prof.user.isApproved) teacherNames.push(prof.user.name);
        } else {
          // Also credit teachers with >= 60 on any weak subtopic
          const subKeys: string[] = t.subTopics as unknown as string[];
          const hasSubMastery = subKeys.some((s) => {
            const v = map[s] ?? map[s.toLowerCase()];
            return typeof v === "number" && v >= 60;
          });
          if (hasSubMastery) {
            teacherCount += 1;
            if (prof.user.isApproved) teacherNames.push(prof.user.name);
          }
        }
      }

      group.topics.push({
        id: t.id,
        topicName: t.topicName,
        subTopics: t.subTopics as string[],
        weightInExam: t.weightInExam,
        teacherCount,
        teacherNames,
      });
    }

    return NextResponse.json({ groups: grouped, totalTopics: topics.length });
  } catch (error: unknown) {
    console.error("Admin curriculum GET error:", error);
    return NextResponse.json({ error: "שגיאה בשליפת עץ התכנית" }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/curriculum?id=...
 * Admin-only removal of an empty CurriculumTopic (guarded by 09-database-safety:
 * this deletes a row the admin explicitly created — it never drops a column).
 */
export async function DELETE(request: Request) {
  try {
    const auth = await requireAuth(["ADMIN", "MANAGER"]);
    if (auth.error) return auth.error;

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "חסר id" }, { status: 400 });
    }

    const existing = await prisma.curriculumTopic.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "הנושא אינו קיים" }, { status: 404 });
    }

    const linked = await prisma.diagnosticQuiz.count({
      where: { topicIds: { has: id } },
    });
    if (linked > 0) {
      return NextResponse.json(
        { error: "לא ניתן למחוק נושא המקושר לאבחונים פעילים" },
        { status: 409 }
      );
    }

    await prisma.curriculumTopic.delete({ where: { id } });
    await writeAuditLog({
      actorId: auth.user.id,
      action: "CURRICULUM_DELETE",
      entityType: "CurriculumTopic",
      entityId: id,
      metadata: { topicName: existing.topicName, subject: existing.subject },
    });

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error("Admin curriculum DELETE error:", error);
    return NextResponse.json({ error: "שגיאה במחיקת הנושא" }, { status: 500 });
  }
}