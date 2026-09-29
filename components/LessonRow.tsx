"use client";

import { useState } from "react";
import { toast } from "react-hot-toast";
import {
  badgeDanger,
  badgeSuccess,
  badgeWarning,
  dangerCta,
  frostCard,
  primaryCta,
  secondaryCta,
} from "../lib/ui";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export type LessonRole = "STUDENT" | "TEACHER" | "ADMIN" | "MANAGER";

interface LessonRowLesson {
  id: string;
  title: string | null;
  scheduledAt: string;
  status: string;
  canceledById?: string;
  teacherId: string;
  appealStatus?: string;
  teacher: { id: string; name: string };
  student: { id: string; name: string };
}

interface AvailabilitySlot {
  id: string;
  startTime: string;
  endTime: string;
}

interface LessonRowProps {
  lesson: LessonRowLesson;
  userRole: LessonRole;
  onRefresh: () => void;
}

type CancelResponse = {
  error?: string;
  message?: string;
};

type AppealResponse = {
  error?: string;
  success?: boolean;
};

type RescheduleResponse = {
  error?: string;
  success?: boolean;
  message?: string;
  newScheduledAt?: string;
};

type AvailabilityResponse = AvailabilitySlot[];

function statusBadgeClass(status: string): string {
  if (status === "SCHEDULED" || status === "IN_PROGRESS" || status === "COMPLETED") {
    return badgeSuccess;
  }
  if (status === "CANCELLED" || status === "CANCELLED_LATE") {
    return badgeDanger;
  }
  return badgeWarning;
}

export default function LessonRow({ lesson, userRole, onRefresh }: LessonRowProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isCancelModalOpen, setIsCancelModalOpen] = useState(false);
  const [isRescheduleModalOpen, setIsRescheduleModalOpen] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isAppealing, setIsAppealing] = useState(false);
  const [isRescheduling, setIsRescheduling] = useState(false);
  const [isSlotsLoading, setIsSlotsLoading] = useState(false);
  const [availableSlots, setAvailableSlots] = useState<AvailabilitySlot[]>([]);
  const [selectedNewSlotId, setSelectedNewSlotId] = useState<string | null>(null);

  const isTeacher = userRole === "TEACHER";
  const canAppeal =
    isTeacher &&
    lesson.canceledById === lesson.teacherId &&
    (lesson.status === "CANCELLED" || lesson.status === "CANCELLED_LATE") &&
    lesson.appealStatus === "NONE";

  const handleAppeal = async () => {
    setIsAppealing(true);
    try {
      const res = await fetch(`/api/lessons/${lesson.id}/appeal`, { method: "POST" });
      const data = (await res.json()) as AppealResponse;
      if (!res.ok) throw new Error(data.error || "הגשת הערעור נכשלה");
      toast.success("הערעור על הקנס הוגש בהצלחה");
      setIsMenuOpen(false);
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה בהגשת הערעור");
    } finally {
      setIsAppealing(false);
    }
  };

  const scheduledAtMs = new Date(lesson.scheduledAt).getTime();
  const isWithin24h = scheduledAtMs - Date.now() < TWENTY_FOUR_HOURS_MS;

  const warningMessage = isTeacher
    ? isWithin24h
      ? "אזהרה: יגרור קנס 15%. ננסה למצוא מחליף. להמשיך?"
      : "השיעור יבוטל והקרדיט יוחזר לתלמיד."
    : isWithin24h
      ? "אזהרה: הביטול הוא פחות מ-24 שעות. הקרדיט לא יוחזר."
      : "השיעור יבוטל והקרדיט יוחזר במלואו.";

  const peerLabel = isTeacher ? "תלמיד" : "מורה";
  const peerName = isTeacher ? lesson.student.name : lesson.teacher.name;
  const liveButtonText = isTeacher ? "התחל שיעור בלייב" : "כניסה לשיעור בלייב";

  const openCancelModal = () => {
    setIsMenuOpen(false);
    setIsCancelModalOpen(true);
  };

  const closeCancelModal = () => {
    if (isCancelling) return;
    setIsCancelModalOpen(false);
  };

  const handleConfirmCancel = async () => {
    setIsCancelling(true);
    try {
      const res = await fetch(`/api/lessons/${lesson.id}/cancel`, { method: "POST" });
      const data = (await res.json()) as CancelResponse;
      if (!res.ok) throw new Error(data.error || "ביטול השיעור נכשל");
      toast.success(data.message || "השיעור בוטל בהצלחה");
      setIsCancelModalOpen(false);
      setIsMenuOpen(false);
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה בביטול שיעור");
    } finally {
      setIsCancelling(false);
    }
  };

  const openRescheduleModal = async () => {
    setIsMenuOpen(false);
    setSelectedNewSlotId(null);
    setIsRescheduleModalOpen(true);
    setIsSlotsLoading(true);
    try {
      // Fetch available slots for this lesson's teacher.
      const url =
        userRole === "STUDENT"
          ? `/api/availability?teacherId=${encodeURIComponent(lesson.teacherId)}`
          : "/api/availability";
      const res = await fetch(url);
      const data = (await res.json()) as AvailabilityResponse;
      if (!res.ok) throw new Error("שגיאה בטעינת השעות הפנויות");
      // Filter out the current lesson's slot and already-booked ones.
      const currentStart = new Date(lesson.scheduledAt).getTime();
      const free = data.filter((s) => {
        const sStart = new Date(s.startTime).getTime();
        return sStart !== currentStart;
      });
      setAvailableSlots(free);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה בטעינת השעות");
      setIsRescheduleModalOpen(false);
    } finally {
      setIsSlotsLoading(false);
    }
  };

  const closeRescheduleModal = () => {
    if (isRescheduling) return;
    setIsRescheduleModalOpen(false);
    setSelectedNewSlotId(null);
  };

  const handleConfirmReschedule = async () => {
    if (!selectedNewSlotId) {
      toast.error("יש לבחור מועד חלופי");
      return;
    }
    setIsRescheduling(true);
    try {
      const res = await fetch(`/api/lessons/${lesson.id}/reschedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newSlotId: selectedNewSlotId }),
      });
      const data = (await res.json()) as RescheduleResponse;
      if (!res.ok) throw new Error(data.error || "הזזת השיעור נכשלה");
      toast.success(data.message || "השיעור הוזז בהצלחה");
      setIsRescheduleModalOpen(false);
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה בהזזת השיעור");
    } finally {
      setIsRescheduling(false);
    }
  };

  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between bg-white/80 backdrop-blur-md border border-neutral-200/80 rounded-xl px-4 py-4 text-xs gap-3 shadow-sm">
      <div className="text-start">
        <div className="font-semibold text-neutral-900">{lesson.title || "שיעור פרטי"}</div>
        <div className="text-neutral-600 mt-1">
          {peerLabel}: {peerName}
        </div>
        <div className="text-neutral-500 mt-0.5">
          {new Date(lesson.scheduledAt).toLocaleString("he-IL")}
        </div>
      </div>

      <div className="flex flex-col sm:items-end gap-2 relative">
        {(lesson.status === "SCHEDULED" || canAppeal) && (
          <div className="relative w-full flex justify-end">
            <button
              type="button"
              onClick={() => setIsMenuOpen((v) => !v)}
              className="text-neutral-500 hover:text-neutral-900 bg-neutral-50 hover:bg-neutral-100 border border-neutral-200 rounded-lg w-8 h-8 flex items-center justify-center transition-all text-sm"
              aria-label="תפריט פעולות"
            >
              ⚙️
            </button>

            {isMenuOpen && (
              <div className="absolute end-0 top-full mt-1 z-30 min-w-[160px] bg-white border border-neutral-200 rounded-xl overflow-hidden shadow-lg">
                {canAppeal ? (
                  <button
                    type="button"
                    onClick={handleAppeal}
                    disabled={isAppealing}
                    className="w-full text-start px-3 py-2.5 text-[14px] font-medium text-red-700 hover:bg-red-50 transition-all disabled:opacity-50"
                  >
                    {isAppealing ? "מגיש ערעור..." : "הגש ערעור על הקנס"}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={openRescheduleModal}
                      className="w-full text-start px-3 py-2.5 text-[14px] font-medium text-neutral-700 hover:bg-neutral-50 transition-all border-b border-neutral-100"
                    >
                      הזזת מועד שיעור
                    </button>
                    <button
                      type="button"
                      onClick={openCancelModal}
                      className="w-full text-start px-3 py-2.5 text-[14px] font-medium text-red-700 hover:bg-red-50 transition-all"
                    >
                      ביטול שיעור
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        <span className={statusBadgeClass(lesson.status)}>{lesson.status}</span>

        {(lesson.status === "SCHEDULED" || lesson.status === "IN_PROGRESS") && (
          <a href={`/lessons/${lesson.id}`} className={primaryCta}>
            {liveButtonText}
          </a>
        )}
      </div>

      {/* Cancel modal */}
      {isCancelModalOpen && (
        <div className="fixed inset-0 bg-neutral-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className={`${frostCard} p-6 max-w-md w-full space-y-4 text-start shadow-lg`}>
            <h3 className="text-base font-semibold text-neutral-900">ביטול שיעור</h3>
            <p className="text-xs text-neutral-600 leading-relaxed">{warningMessage}</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={isCancelling}
                onClick={closeCancelModal}
                className={secondaryCta}
              >
                ביטול
              </button>
              <button
                type="button"
                disabled={isCancelling}
                onClick={handleConfirmCancel}
                className={
                  isWithin24h && isTeacher
                    ? "bg-amber-600 text-white hover:bg-amber-500 rounded-full px-5 py-2.5 text-sm font-medium transition-colors disabled:opacity-40"
                    : dangerCta
                }
              >
                {isCancelling ? "מבטל..." : "אישור ביטול"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reschedule modal */}
      {isRescheduleModalOpen && (
        <div className="fixed inset-0 bg-neutral-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className={`${frostCard} p-6 max-w-md w-full space-y-4 text-start shadow-lg`}>
            <div>
              <h3 className="text-base font-semibold text-neutral-900">הזזת מועד שיעור</h3>
              <p className="text-xs text-neutral-500 mt-1">
                בחרו מועד חלופי מהשעות הפנויות של המורה. השיעור יישמר ללא קנס ביטול.
              </p>
            </div>

            {isSlotsLoading ? (
              <p className="text-xs text-neutral-500">טוען שעות פנויות...</p>
            ) : availableSlots.length === 0 ? (
              <div className="bg-neutral-50 border border-neutral-200 rounded-2xl p-6 text-center space-y-2">
                <p className="text-sm font-medium text-neutral-900">אין שעות פנויות</p>
                <p className="text-xs text-neutral-500">
                  ניתן לבטל את השיעור או לנסות שוב מאוחר יותר.
                </p>
              </div>
            ) : (
              <div className="space-y-1.5 max-h-64 overflow-y-auto">
                {availableSlots.map((slot) => (
                  <button
                    key={slot.id}
                    type="button"
                    onClick={() => setSelectedNewSlotId(slot.id)}
                    className={`w-full text-start px-3 py-2.5 rounded-xl border transition-all text-xs font-medium ${
                      selectedNewSlotId === slot.id
                        ? "bg-neutral-900 border-neutral-900 text-white"
                        : "bg-neutral-50 border-neutral-200 text-neutral-700 hover:border-neutral-400"
                    }`}
                  >
                    {new Date(slot.startTime).toLocaleString("he-IL", {
                      weekday: "long",
                      day: "numeric",
                      month: "long",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {selectedNewSlotId === slot.id && (
                      <span className="ms-2 text-emerald-300">✓</span>
                    )}
                  </button>
                ))}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={isRescheduling}
                onClick={closeRescheduleModal}
                className={secondaryCta}
              >
                ביטול
              </button>
              <button
                type="button"
                disabled={isRescheduling || !selectedNewSlotId}
                onClick={handleConfirmReschedule}
                className={primaryCta}
              >
                {isRescheduling ? "מזיז..." : "אישור הזזה"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
