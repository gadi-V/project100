"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { toast } from "react-hot-toast";
import { Check } from "lucide-react";
import type { Channel as StreamChannelType } from "stream-chat";
import type { ClassroomWhiteboardHandle } from "../../../components/ClassroomWhiteboard";
import RatingModal from "../../../components/RatingModal";
import PreLessonAssetsSection from "../../../components/packages/PreLessonAssetsSection";
import DiagnosticSummaryCard from "../../../components/packages/DiagnosticSummaryCard";
import CompleteLessonModal from "../../../components/portal/student/CompleteLessonModal";
import {
  canCompleteFromRoom,
  portalAfterCompletionHref,
  type CompleteLessonResponse,
} from "../../../lib/lesson-completion";
import { flushBeforeLeave } from "../../../lib/whiteboard/save-scheduler";
import { frostCard, frostHeader, primaryCta } from "../../../lib/ui";

function LoadingSkeleton({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="relative flex h-full min-h-[140px] w-full items-center justify-center overflow-hidden bg-[#fafaf9]"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundColor: "#ffffff",
          backgroundImage:
            "linear-gradient(to right, #f1f5f9 1px, transparent 1px), linear-gradient(to bottom, #f1f5f9 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />
      <div className="relative flex items-center gap-2 rounded-full border border-neutral-200/80 bg-white/85 px-4 py-2 text-sm font-medium text-neutral-600 shadow-sm backdrop-blur-md">
        <span
          aria-hidden
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-900"
        />
        {label}
      </div>
    </div>
  );
}

const ClassroomWhiteboard = dynamic(
  () => import("../../../components/ClassroomWhiteboard"),
  {
    ssr: false,
    loading: () => <LoadingSkeleton label="טוענים את הלוח" />,
  }
);

const ClassroomChat = dynamic(
  () => import("../../../components/ClassroomChat"),
  {
    ssr: false,
    loading: () => <LoadingSkeleton label="טוענים את הצ'אט" />,
  }
);

const VideoRoom = dynamic(
  () => import("../../../components/VideoRoom"),
  {
    ssr: false,
    loading: () => <LoadingSkeleton label="טוענים את הווידאו" />,
  }
);

/**
 * The 1s room clock has lived on this screen since the initial classroom
 * commit, before the Daily board transport. It owns that tick so the
 * whiteboard does not repaint every second.
 */
function RoomElapsedClock() {
  const roomEntryMs = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - roomEntryMs.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const minutes = Math.floor(elapsed / 60).toString().padStart(2, "0");
  const seconds = (elapsed % 60).toString().padStart(2, "0");
  return (
    <div className="bg-white px-3 py-1 rounded-full text-emerald-700 font-mono text-sm font-bold border border-neutral-200/80">
      {`${minutes}:${seconds}`}
    </div>
  );
}

interface LessonRoomUIProps {
  lesson: {
    id: string;
    title: string | null;
    status: string;
    studentId: string;
    teacherId: string;
    roomUrl: string | null;
    dailyToken: string | null;
    streamToken: string | null;
    streamApiKey: string | null;
    scheduledAt: string;
    createdAt: string;
    durationMinutes: number | null;
    packageId: string | null;
    lessonType?: string | null;
    notebookId: string | null;
    startPage: number | null;
    endPage: number | null;
    chatChannel?: {
      streamChannelId: string;
    } | null;
  };
  user: {
    id: string;
    name: string;
    role: "STUDENT" | "TEACHER" | "ADMIN" | "MANAGER";
  };
  pedagogicalBrief?: {
    studentName: string;
    subject: string;
    challenge: string;
    topics: Array<{
      topicName: string;
      subTopics: string[];
      weightInExam: number;
    }>;
  } | null;
}

export default function LessonRoomUI({
  lesson,
  user,
  pedagogicalBrief,
}: LessonRoomUIProps) {
  const router = useRouter();
  const whiteboardRef = useRef<ClassroomWhiteboardHandle>(null);

  const resolveBoardPdfUrl = useCallback(async (): Promise<string | null> => {
    try {
      const url = await whiteboardRef.current?.exportBoardToPdf(lesson.id);
      return typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://")) ? url : null;
    } catch (exportError: unknown) {
      console.error("[whiteboard] board export skipped:", exportError);
      return null;
    }
  }, [lesson.id]);
  const [showRating, setShowRating] = useState(false);
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [callEnded, setCallEnded] = useState(false);
  const [sidePanelOpen, setSidePanelOpen] = useState(true);
  const [boardChannel, setBoardChannel] = useState<StreamChannelType | null>(
    null
  );

  const handleChannelReady = useCallback(
    (channel: StreamChannelType | null) => {
      setBoardChannel(channel);
    },
    []
  );

  const canComplete = canCompleteFromRoom(user, lesson);

  const closeCompleteModal = useCallback(() => setShowCompleteModal(false), []);

  /** Save the notebook, then unmount VideoRoom and leave. A slow save never traps the teacher. */
  const handleLessonCompleted = (result: CompleteLessonResponse) => {
    void (async () => {
      const outcome = await flushBeforeLeave(
        () => whiteboardRef.current?.flushSnapshots() ?? Promise.resolve(),
      );
      if (outcome !== "ok") console.error("[whiteboard] leaving after snapshot", outcome);
      setShowCompleteModal(false);
      setCallEnded(true);
      if (result.status === "CANCELLED") toast("השיעור סומן כבוטל ביוזמת המורה");
      else if (result.attendanceStatus === "STUDENT_NO_SHOW") toast.success("השיעור נסגר והחיסור נרשם בתיק התלמיד");
      else if (result.promptSummary) toast.success("השיעור הסתיים. עוברים לטופס סיכום השיעור");
      else toast.success("השיעור הסתיים והסיכום נשמר");
      router.push(portalAfterCompletionHref(lesson.studentId, lesson.id, result));
    })();
  };

  const handleRatingSubmit = async (rating: number, comment: string) => {
    const res = await fetch(`/api/lessons/${lesson.id}/rate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating, reviewComment: comment }),
    });
    if (!res.ok) {
      const data = (await res.json()) as { error?: string };
      throw new Error(data.error ?? "שגיאה בשמירת הדירוג");
    }
    router.push("/dashboard");
  };

  const handleLeaveAndRate = () => {
    setShowRating(true);
  };

  const streamChannelId = lesson.chatChannel?.streamChannelId ?? null;
  const chatReady =
    Boolean(lesson.streamApiKey) &&
    Boolean(lesson.streamToken) &&
    Boolean(streamChannelId);

  return (
    <div
      className="h-[100dvh] min-h-0 bg-stone-50 flex flex-col overflow-hidden text-neutral-900"
      dir="rtl"
    >
      {showCompleteModal && (
        <CompleteLessonModal
          studentId={lesson.studentId}
          meeting={{
            id: lesson.id,
            title: lesson.title?.trim() || "שיעור פרטי",
            scheduledAt: lesson.scheduledAt,
            teacherName: user.role === "TEACHER" ? user.name : null,
            lessonType: lesson.lessonType === "MAPPING" ? "MAPPING" : "REGULAR",
          }}
          context="room"
          resolveBoardPdfUrl={resolveBoardPdfUrl}
          onClose={closeCompleteModal}
          onDone={handleLessonCompleted}
        />
      )}

      {showRating && (
        <RatingModal
          lessonId={lesson.id}
          onSubmit={handleRatingSubmit}
          onSkip={() => router.push("/dashboard")}
        />
      )}

      <header
        className={`h-14 ${frostHeader} flex items-center justify-between px-4 sm:px-6 shrink-0`}
      >
        <div className="flex items-center gap-4">
          <h1 className="text-neutral-900 font-bold text-lg">
            {lesson.title || "כיתה וירטואלית"}
          </h1>
          <RoomElapsedClock />
        </div>

        <div className="flex items-center gap-4">
          <span className="text-neutral-500 text-sm font-medium hidden sm:inline">
            מחובר כ: {user.name}
          </span>

          {user.role === "STUDENT" && (
            <button
              type="button"
              onClick={handleLeaveAndRate}
              className={primaryCta}
            >
              עזוב ודרג
            </button>
          )}

          {canComplete && (
            <button
              type="button"
              onClick={() => setShowCompleteModal(true)}
              disabled={callEnded}
              className="inline-flex items-center gap-1.5 rounded-full bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
            >
              <Check className="h-4 w-4" aria-hidden="true" />
              {callEnded ? "סוגרים את השיעור..." : "סיום שיעור ודיווח נוכחות"}
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <main className="flex-1 relative bg-neutral-100 p-2 min-h-0 min-w-0 w-full">
          <div className="w-full h-full rounded-2xl overflow-hidden border border-neutral-200 shadow-sm">
            <ClassroomWhiteboard
              ref={whiteboardRef}
              role={user.role}
              streamChannel={boardChannel}
              packageId={lesson.packageId}
              lessonId={lesson.id}
              notebookId={lesson.notebookId}
              startPage={lesson.startPage}
              endPage={lesson.endPage}
              userId={user.id}
            />
          </div>
        </main>

        <button
          type="button"
          onClick={() => setSidePanelOpen((open) => !open)}
          aria-expanded={sidePanelOpen}
          aria-controls="lesson-side-panel"
          title={sidePanelOpen ? "מזער סרגל" : "הצג סרגל"}
          className="shrink-0 self-stretch w-9 border-x border-neutral-200 bg-white text-[13px] font-semibold text-neutral-800 hover:bg-neutral-50"
        >
          <span className="inline-block [writing-mode:vertical-rl]">
            {sidePanelOpen ? "מזער סרגל" : "הצג סרגל"}
          </span>
        </button>

        <aside
          id="lesson-side-panel"
          className={
            sidePanelOpen
              ? "w-full max-w-sm sm:w-96 flex flex-col border-e border-neutral-200/80 bg-stone-50/80 shrink-0 p-2 gap-2 overflow-y-auto"
              : "hidden"
          }
        >
          {pedagogicalBrief && (
            <div className={`${frostCard} p-3 text-xs text-neutral-700`}>
              <div className="flex items-center justify-between font-bold text-neutral-900 mb-1.5">
                <span>תדריך פדגוגי מותאם</span>
                <span className="bg-amber-50 text-amber-900 px-2 py-0.5 rounded-full text-[13px] border border-amber-100">
                  {pedagogicalBrief.subject}
                </span>
              </div>
              <p className="text-neutral-600 mb-2 leading-snug">
                <span className="font-semibold text-neutral-500">מוקד קושי: </span>
                {pedagogicalBrief.challenge}
              </p>
              {pedagogicalBrief.topics.length > 0 && (
                <div className="space-y-1">
                  <div className="font-semibold text-neutral-500">נושאים לחיזוק בשיעור:</div>
                  <div className="flex flex-wrap gap-1">
                    {pedagogicalBrief.topics.map((t, idx) => (
                      <span
                        key={idx}
                        className="bg-amber-50 text-amber-900 font-medium px-2 py-0.5 rounded-full text-[14px] border border-amber-100"
                        title={t.subTopics.join(", ")}
                      >
                        {t.topicName}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {lesson.packageId && (
            <div className="space-y-4">
              <div className="rounded-2xl overflow-hidden">
                <DiagnosticSummaryCard
                  packageId={lesson.packageId}
                  currentUserId={user.id}
                  isTeacher={user.role === "TEACHER" || user.role === "MANAGER" || user.role === "ADMIN"}
                />
              </div>
              <div className="rounded-2xl overflow-hidden">
                <PreLessonAssetsSection
                  packageId={lesson.packageId}
                  currentUserId={user.id}
                  isTeacher={user.role === "TEACHER" || user.role === "MANAGER" || user.role === "ADMIN"}
                />
              </div>
            </div>
          )}

          <div className="h-64 rounded-2xl overflow-hidden shrink-0">
            {callEnded ? (
              <div className="flex h-full items-center justify-center bg-neutral-100 text-sm font-medium text-neutral-500">
                השיחה הסתיימה
              </div>
            ) : (
              <VideoRoom roomUrl={lesson.roomUrl} token={lesson.dailyToken} />
            )}
          </div>

          <div className="flex-1 rounded-2xl overflow-hidden min-h-[240px]">
            {chatReady ? (
              <ClassroomChat
                apiKey={lesson.streamApiKey!}
                userToken={lesson.streamToken!}
                userId={user.id}
                firstName={user.name.split(" ")[0]}
                channelId={streamChannelId!}
                packageId={lesson.packageId}
                onChannelReady={handleChannelReady}
              />
            ) : (
              <div className="flex h-full items-center justify-center px-4">
                <span className="text-neutral-500 font-medium text-sm text-center">
                  הצ&apos;אט עדיין לא מוכן. ודא ש־Stream מוגדר ושהשיעור נוצר
                  מחדש.
                </span>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}