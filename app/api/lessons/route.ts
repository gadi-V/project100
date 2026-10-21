import { NextResponse } from "next/server";
import { prisma } from "../../../lib/prisma";
import { requireAuth } from "../../../lib/api-auth";
import { lessonVisibleToStudent } from "../../../lib/lesson-completion";
import {
  createDailyRoom,
  dailyRoomNameForLesson,
  deleteDailyRoom,
  generateDailyToken,
  roomNameFromDailyUrl,
} from "../../../lib/daily";
import {
  createStreamChannel,
  generateStreamToken,
} from "../../../lib/stream";
import { lessonAntiCollisionWindow } from "../../../lib/scheduling";
import {
  ensureUnifiedPackageStreamChannel,
  resolveLessonStreamChannelId,
} from "../../../lib/package-chat";
import { ensureNotebookForStudent } from "../../../lib/notebooks";

async function attachLessonCredentials<
  T extends {
    id: string;
    dailyRoomUrl: string | null;
    teacherId: string;
    studentId: string;
    packageId: string | null;
    scheduledAt: Date;
    durationMinutes: number | null;
    chatChannel?: { streamChannelId: string } | null;
  },
>(lesson: T, userId: string, role: string) {
  const roomUrl = lesson.dailyRoomUrl;
  let dailyToken: string | null = null;
  let streamToken: string | null = null;
  let streamChannelId: string | null = null;

  if (roomUrl) {
    const roomName =
      roomNameFromDailyUrl(roomUrl) ?? dailyRoomNameForLesson(lesson.id);
    const isOwner = role === "TEACHER" || role === "MANAGER" || role === "ADMIN";

    try {
      dailyToken = await generateDailyToken(roomName, isOwner, userId, {
        scheduledAt: lesson.scheduledAt,
        durationMinutes: lesson.durationMinutes ?? 60,
      });
    } catch (error) {
      console.error(`Daily token generation failed for lesson ${lesson.id}:`, error);
    }
  }

  try {
    streamToken = generateStreamToken(userId);
  } catch (error) {
    console.error(`Stream token generation failed for user ${userId}:`, error);
  }

  try {
    streamChannelId = await resolveLessonStreamChannelId(lesson);
  } catch (error) {
    console.error(
      `Stream channel resolution failed for lesson ${lesson.id}:`,
      error
    );
    streamChannelId = lesson.chatChannel?.streamChannelId ?? null;
  }

  return {
    ...lesson,
    roomUrl,
    dailyToken,
    streamToken,
    streamChannelId,
  };
}

/**
 * Full booking compensation: restore credits/slot, delete lesson rows,
 * and tear down any Daily room that may have been provisioned.
 */
async function compensateBooking(
  lessonId: string,
  slotId: string,
  studentId: string,
  dailyRoomName?: string | null
) {
  try {
    if (dailyRoomName) {
      await deleteDailyRoom(dailyRoomName);
    }
  } catch (error) {
    console.error(`Failed to delete Daily room ${dailyRoomName} during compensate:`, error);
  }

  await prisma.$transaction(async (tx) => {
    await tx.chatChannel.deleteMany({ where: { lessonId } });
    await tx.lesson.deleteMany({ where: { id: lessonId } });
    await tx.teacherAvailability.update({
      where: { id: slotId },
      data: { isBooked: false },
    });
    await tx.user.update({
      where: { id: studentId },
      data: { lessonCredits: { increment: 1 } },
    });
  });
}

export async function GET(request: Request) {
  try {
    const auth = await requireAuth(["STUDENT", "TEACHER", "MANAGER", "ADMIN"]);
    if (auth.error) return auth.error;

    const { searchParams } = new URL(request.url);
    const lessonId = searchParams.get("id");

    // Single-lesson join credentials (Daily + Stream)
    if (lessonId) {
      const lesson = await prisma.lesson.findUnique({
        where: { id: lessonId },
        include: {
          teacher: { select: { id: true, name: true } },
          student: { select: { id: true, name: true } },
          chatChannel: true,
        },
      });

      if (!lesson) {
        return NextResponse.json({ error: "השיעור לא נמצא" }, { status: 404 });
      }

      const allowed =
        auth.user.role === "MANAGER" ||
        auth.user.role === "ADMIN" ||
        (auth.user.role === "TEACHER" && lesson.teacherId === auth.user.id) ||
        (auth.user.role === "STUDENT" && lesson.studentId === auth.user.id);

      if (!allowed) {
        return NextResponse.json({ error: "אין לך הרשאה לשיעור זה" }, { status: 403 });
      }

      const withCreds = await attachLessonCredentials(
        lesson,
        auth.user.id,
        auth.user.role
      );
      const visible = auth.user.role === "STUDENT" ? lessonVisibleToStudent(withCreds) : withCreds;

      return NextResponse.json(visible, { status: 200 });
    }

    const where =
      auth.user.role === "TEACHER"
        ? { teacherId: auth.user.id }
        : auth.user.role === "STUDENT"
          ? { studentId: auth.user.id }
          : {};

    const lessons = await prisma.lesson.findMany({
      where,
      include: {
        teacher: { select: { id: true, name: true } },
        student: { select: { id: true, name: true } },
        chatChannel: { select: { streamChannelId: true } },
        package: { include: { chat: { select: { streamChannelId: true } } } },
      },
      orderBy: { scheduledAt: "asc" },
      take: 30,
    });

    // Relations are already on the row (teacher, student, chat, package chat).
    // Do not call resolveLessonStreamChannelId here — it queries managers and
    // may create a Stream channel per lesson (N+1, and it blocks the list).
    // Channel creation stays on POST booking and on the single-lesson join path.
    const payload = lessons.map((lesson) => {
      const row = {
        ...lesson,
        roomUrl: lesson.dailyRoomUrl,
        streamChannelId:
          lesson.package?.chat?.streamChannelId ??
          lesson.chatChannel?.streamChannelId ??
          null,
      };
      return auth.user.role === "STUDENT" ? lessonVisibleToStudent(row) : row;
    });

    return NextResponse.json(payload, { status: 200 });
  } catch (error: unknown) {
    console.error("Lessons GET Error:", error);
    return NextResponse.json({ error: "שגיאה בשליפת השיעורים" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAuth(["STUDENT"]);
    if (auth.error) return auth.error;

    const body = await request.json();
    const { slotId, packageId: bodyPackageId } = body as {
      slotId?: string;
      packageId?: string | null;
    };

    if (!slotId) {
      return NextResponse.json({ error: "מזהה חלון זמן הוא שדה חובה" }, { status: 400 });
    }

    // Prefer explicit packageId; else link to the student's latest diagnostic package.
    let resolvedPackageId: string | null =
      typeof bodyPackageId === "string" && bodyPackageId.trim()
        ? bodyPackageId.trim()
        : null;

    if (resolvedPackageId) {
      const pkg = await prisma.package.findUnique({
        where: { id: resolvedPackageId },
        select: { id: true },
      });
      if (!pkg) {
        return NextResponse.json({ error: "חבילה לא נמצאה" }, { status: 404 });
      }
    } else {
      const latestDiagnostic = await prisma.diagnosticQuiz.findFirst({
        where: {
          studentId: auth.user.id,
          packageId: { not: null },
        },
        orderBy: { createdAt: "desc" },
        select: { packageId: true },
      });
      resolvedPackageId = latestDiagnostic?.packageId ?? null;
    }

    // Atomic: credit check, overlap check, slot lock, lesson create
    let result: {
      lessonId: string;
      teacherId: string;
      studentId: string;
      packageId: string | null;
      newCredits: number;
      scheduledAt: Date;
      durationMinutes: number;
    };
    try {
      result = await prisma.$transaction(async (tx) => {
        const slot = await tx.teacherAvailability.findUnique({
          where: { id: slotId },
        });

        if (!slot) {
          throw Object.assign(new Error("SLOT_NOT_FOUND"), { status: 404 });
        }
        if (slot.isBooked) {
          throw Object.assign(new Error("SLOT_BOOKED"), { status: 400 });
        }

        const student = await tx.user.findUnique({
          where: { id: auth.user.id },
        });

        if (!student || student.role !== "STUDENT") {
          throw Object.assign(new Error("FORBIDDEN"), { status: 403 });
        }
        if (student.lessonCredits < 1) {
          throw Object.assign(new Error("NO_CREDITS"), { status: 400 });
        }

        // Each lesson is 50 min but occupies a 60-min block in the calendar
        // (50 min lesson + 10 min mandatory break).
        // Two 60-min blocks [T, T+60) and [E, E+60) conflict when E ∈ (T−60, T+60).
        const { windowStart: blockWindowStart, windowEnd: blockWindowEnd } =
          lessonAntiCollisionWindow(slot.startTime);

        const studentOverlap = await tx.lesson.findFirst({
          where: {
            studentId: auth.user.id,
            status: { in: ["SCHEDULED", "IN_PROGRESS"] },
            scheduledAt: { gt: blockWindowStart, lt: blockWindowEnd },
          },
        });

        if (studentOverlap) {
          throw Object.assign(new Error("OVERLAP"), { status: 400 });
        }

        // Teacher anti-collision: the 60-minute block (lesson + break) must be
        // free of any other active lesson before confirming the booking.
        const teacherOverlap = await tx.lesson.findFirst({
          where: {
            teacherId: slot.teacherId,
            status: { in: ["SCHEDULED", "IN_PROGRESS"] },
            scheduledAt: { gt: blockWindowStart, lt: blockWindowEnd },
          },
        });

        if (teacherOverlap) {
          throw Object.assign(new Error("TEACHER_OVERLAP"), { status: 400 });
        }

        const updatedStudent = await tx.user.update({
          where: { id: auth.user.id },
          data: { lessonCredits: { decrement: 1 } },
        });

        await tx.teacherAvailability.update({
          where: { id: slotId },
          data: { isBooked: true },
        });

        const notebook = await ensureNotebookForStudent(auth.user.id, tx);

        const newLesson = await tx.lesson.create({
          data: {
            teacherId: slot.teacherId,
            studentId: auth.user.id,
            scheduledAt: slot.startTime,
            status: "SCHEDULED",
            dailyRoomUrl: null,
            // Canonical lesson duration per platform rules: 50 min lesson + 10 min break = 60-min calendar block.
            durationMinutes: 50,
            packageId: resolvedPackageId,
            notebookId: notebook.id,
          },
        });

        return {
          lessonId: newLesson.id,
          teacherId: newLesson.teacherId,
          studentId: newLesson.studentId,
          packageId: newLesson.packageId,
          newCredits: updatedStudent.lessonCredits,
          scheduledAt: newLesson.scheduledAt,
          durationMinutes: newLesson.durationMinutes ?? 60,
        };
      });
    } catch (txError: unknown) {
      const code =
        txError instanceof Error ? txError.message : "UNKNOWN";
      const status =
        typeof txError === "object" &&
        txError &&
        "status" in txError &&
        typeof (txError as { status: unknown }).status === "number"
          ? (txError as { status: number }).status
          : 500;

      const messages: Record<string, string> = {
        SLOT_NOT_FOUND: "חלון הזמן המבוקש לא נמצא במערכת",
        SLOT_BOOKED: "חלון זמן זה כבר נתפס על ידי סטודנט אחר",
        FORBIDDEN: "משתמש זה אינו מורשה לבצע שיבוץ סטודנטים",
        NO_CREDITS:
          "אין לך מספיק קרדיטים בחבילה. אנא רכוש חבילת שיעורים בדאשבורד כדי להשתבץ.",
        OVERLAP:
          "הנך משובץ כבר לשיעור אחר בחלון 60 הדקות המבוקש (שיעור 50 דק׳ + 10 דק׳ הפסקה). בחר שעה אחרת.",
        TEACHER_OVERLAP:
          "המורה כבר משובץ לשיעור אחר בחלון 60 הדקות המבוקש. בחר חלון זמן אחר.",
      };

      return NextResponse.json(
        { error: messages[code] ?? "שגיאה פנימית במנוע השיבוצים בזמן הריצה" },
        { status }
      );
    }

    const roomName = dailyRoomNameForLesson(result.lessonId);

    // 1) Daily room — compensate fully on failure. `exp` = scheduledAt + duration + 10%.
    let roomUrl: string | null = null;
    try {
      const room = await createDailyRoom(result.lessonId, {
        scheduledAt: result.scheduledAt,
        durationMinutes: result.durationMinutes,
      });
      roomUrl = room.url;

      await prisma.lesson.update({
        where: { id: result.lessonId },
        data: { dailyRoomUrl: room.url },
      });
    } catch (dailyError) {
      console.error("Daily room creation failed after booking:", dailyError);
      await compensateBooking(result.lessonId, slotId, result.studentId, roomName);
      return NextResponse.json(
        { error: "שיבוץ השיעור נכשל ביצירת חדר הווידאו. נסה שוב." },
        { status: 502 }
      );
    }

    // 2) Stream Chat channel — package-scoped UnifiedPackageChat when linked,
    //    otherwise a standalone lesson_${id} channel. Compensate DB + Daily on failure.
    let streamChannelId: string | null = null;
    try {
      const managers = await prisma.user.findMany({
        where: { role: { in: ["MANAGER", "ADMIN"] } },
        select: { id: true },
      });

      const memberIds = [
        result.teacherId,
        result.studentId,
        ...managers.map((m) => m.id),
      ];

      if (result.packageId) {
        // Shared channel across all lessons in the package (no ChatChannel row —
        // ChatChannel.streamChannelId is unique and cannot point multiple lessons
        // at the same package Stream id).
        streamChannelId = await ensureUnifiedPackageStreamChannel(
          result.packageId,
          memberIds
        );
      } else {
        streamChannelId = await createStreamChannel(result.lessonId, memberIds);

        await prisma.chatChannel.create({
          data: {
            lessonId: result.lessonId,
            streamChannelId,
          },
        });
      }
    } catch (streamError) {
      console.error("Stream channel creation failed after booking:", streamError);
      await compensateBooking(result.lessonId, slotId, result.studentId, roomName);
      return NextResponse.json(
        { error: "שיבוץ השיעור נכשל ביצירת ערוץ הצ'אט. נסה שוב." },
        { status: 502 }
      );
    }

    const lessonWithInfra = {
      id: result.lessonId,
      teacherId: result.teacherId,
      studentId: result.studentId,
      packageId: result.packageId,
      dailyRoomUrl: roomUrl,
      roomUrl,
      streamChannelId,
      chatChannel: streamChannelId ? { streamChannelId } : null,
    };

    return NextResponse.json(
      {
        message: "השיעור שובץ בהצלחה וננעל בלוח הזמנים!",
        lesson: lessonWithInfra,
        newCredits: result.newCredits,
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    console.error("CRITICAL BOOKING ENGINE ERROR:", error);
    return NextResponse.json({ error: "שגיאה פנימית במנוע השיבוצים בזמן הריצה" }, { status: 500 });
  }
}
