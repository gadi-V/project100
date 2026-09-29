"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "react-hot-toast";
import type { Channel as StreamChannelType } from "stream-chat";
import ClassroomWhiteboard, {
  ClassroomWhiteboardRef,
} from "../../../components/ClassroomWhiteboard";
import ClassroomChat from "../../../components/ClassroomChat";
import VideoRoom from "../../../components/VideoRoom";
import RatingModal from "../../../components/RatingModal";
import PreLessonAssetsSection from "../../../components/packages/PreLessonAssetsSection";
import DiagnosticSummaryCard from "../../../components/packages/DiagnosticSummaryCard";
import PostLessonSummaryModal from "../../../components/lessons/PostLessonSummaryModal";
import { frostCard, frostHeader, primaryCta, dangerCta } from "../../../lib/ui";

interface LessonRoomUIProps {
  lesson: {
    id: string;
    title: string | null;
    status: string;
    roomUrl: string | null;
    dailyToken: string | null;
    streamToken: string | null;
    streamApiKey: string | null;
    scheduledAt: string;
    createdAt: string;
    durationMinutes: number | null;
    packageId: string | null;
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
  const whiteboardRef = useRef<ClassroomWhiteboardRef>(null);
  const [isEnding, setIsEnding] = useState(false);
  const [showRating, setShowRating] = useState(false);
  const [showSummaryModal, setShowSummaryModal] = useState(false);
  const [existingGaps, setExistingGaps] = useState<string[]>([]);
  const [boardChannel, setBoardChannel] = useState<StreamChannelType | null>(
    null
  );

  const handleChannelReady = useCallback(
    (channel: StreamChannelType | null) => {
      setBoardChannel(channel);
    },
    []
  );

  // Lock in the instant the teacher/student entered the room.
  // A ref prevents re-renders; the state tracks only the derived elapsed seconds.
  const roomEntryMs = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - roomEntryMs.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const formatTime = (secs: number): string => {
    const m = Math.floor(secs / 60).toString().padStart(2, "0");
    const s = (secs % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  const handleEndLesson = async () => {
    const isTeacherRole =
      user.role === "TEACHER" || user.role === "MANAGER" || user.role === "ADMIN";

    if (isTeacherRole) {
      if (lesson.packageId) {
        try {
          const res = await fetch(`/api/packages/${lesson.packageId}/quiz`);
          if (res.ok) {
            const data = await res.json();
            setExistingGaps(data.identifiedGaps || []);
          }
        } catch (error) {
          console.error("Failed to load gaps for summary modal:", error);
        }
      }
      setShowSummaryModal(true);
      return;
    }

    if (!whiteboardRef.current) return;

    setIsEnding(true);
    const endToast = toast.loading("מסיים את השיעור ומפיק סיכום PDF...");

    try {
      // Export all A4 pages → upload to storage → receive URL (or Blob fallback).
      const exportResult = await whiteboardRef.current.exportBoardToPdf(lesson.id);

      const formData = new FormData();
      formData.append("lessonId", lesson.id);

      if (typeof exportResult === "string") {
        // Storage URL returned by the export API — pass it so complete can skip re-upload.
        formData.append("pdfUrl", exportResult);
      } else if (exportResult instanceof Blob) {
        // Blob fallback (no lessonId or storage not configured).
        formData.append("pdfFile", exportResult, `lesson_${lesson.id}.pdf`);
      }

      const response = await fetch("/api/lessons/complete", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? "שגיאה בסיום השיעור");
      }

      toast.success("השיעור הסתיים בהצלחה! סיכום יישלח בוואטסאפ.", {
        id: endToast,
      });
      router.push("/dashboard");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "שגיאה בתהליך הסיום";
      toast.error(message, { id: endToast });
    } finally {
      setIsEnding(false);
    }
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
      {showSummaryModal && (
        <PostLessonSummaryModal
          isOpen={showSummaryModal}
          onClose={() => setShowSummaryModal(false)}
          lessonId={lesson.id}
          teacherId={user.id}
          existingGaps={existingGaps}
          onSummarySaved={() => {
            setShowSummaryModal(false);
            window.location.reload();
          }}
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
          <div className="bg-white px-3 py-1 rounded-full text-emerald-700 font-mono text-sm font-bold border border-neutral-200/80">
            {formatTime(elapsed)}
          </div>
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

          {(user.role === "TEACHER" ||
            user.role === "MANAGER" ||
            user.role === "ADMIN") && (
            <button
              type="button"
              onClick={handleEndLesson}
              disabled={isEnding}
              className={dangerCta}
            >
              {isEnding ? "מסיים..." : "סיום שיעור"}
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <main className="flex-1 relative bg-neutral-100 p-2 min-h-0">
          <div className="w-full h-full rounded-2xl overflow-hidden border border-neutral-200 shadow-sm">
            <ClassroomWhiteboard
              ref={whiteboardRef}
              role={user.role}
              streamChannel={boardChannel}
              packageId={lesson.packageId}
              lessonId={lesson.id}
            />
          </div>
        </main>

        <aside className="w-full max-w-sm sm:w-96 flex flex-col border-e border-neutral-200/80 bg-stone-50/80 shrink-0 p-2 gap-2 overflow-y-auto">
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
            <VideoRoom roomUrl={lesson.roomUrl} token={lesson.dailyToken} />
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