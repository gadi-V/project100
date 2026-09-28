"use client";

import { useEffect, useMemo, useState, type DragEvent } from "react";
import { toast } from "react-hot-toast";
import {
  buildGoogleCalendarUrl,
  buildIcsCalendar,
  buildWebcalUrl,
  downloadIcsFile,
  type IcsLessonEvent,
} from "../lib/ics";
import {
  badgeNeutral,
  emptyState,
  frostCard,
  primaryCta,
  secondaryCta,
} from "../lib/ui";
import BookingModal, { type BookingModalSlot } from "./BookingModal";
import TeacherFallbackSwitcher, {
  type FallbackTeacher,
} from "./TeacherFallbackSwitcher";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export const DAYS_OF_WEEK = [
  { label: "א'", key: 0 },
  { label: "ב'", key: 1 },
  { label: "ג'", key: 2 },
  { label: "ד'", key: 3 },
  { label: "ה'", key: 4 },
  { label: "ו'", key: 5 },
  { label: "שבת", key: 6 },
] as const;

export const HOURS_OF_DAY = [
  "08:00",
  "09:00",
  "10:00",
  "11:00",
  "12:00",
  "13:00",
  "14:00",
  "15:00",
  "16:00",
  "17:00",
  "18:00",
  "19:00",
  "20:00",
  "21:00",
  "22:00",
] as const;

export type ScheduleRole = "STUDENT" | "TEACHER" | "ADMIN" | "MANAGER";

export interface ScheduleSlot {
  id: string;
  startTime: string;
  endTime: string;
  isBooked: boolean;
  teacher?: {
    id: string;
    name: string;
    teacherProfile?: {
      subjects: string[];
      ageGroups?: string[];
      bio: string | null;
    } | null;
  };
}

export interface ScheduleLesson {
  id: string;
  title: string | null;
  scheduledAt: string;
  status: string;
  canceledById?: string;
  teacherId: string;
  appealStatus?: string;
  durationMinutes?: number | null;
  teacher: { id: string; name: string };
  student: { id: string; name: string };
}

type ViewType = "day" | "week" | "month";

type DragPayload =
  | { kind: "availability"; slotId: string }
  | { kind: "open-book"; slotId: string }
  | { kind: "paint-create"; sourceHour: string; sourceDayKey: number };

interface AvailabilityResponseSlot {
  id: string;
  startTime: string;
  endTime: string;
}

type CancelResponse = { error?: string; message?: string };
type RescheduleResponse = {
  error?: string;
  success?: boolean;
  message?: string;
};

export interface WeeklyScheduleBoardProps {
  mode: "teacher" | "student";
  slots: ScheduleSlot[];
  lessons: ScheduleLesson[];
  userRole: ScheduleRole;
  busy?: boolean;
  onCreateSlot?: (localIsoMinute: string) => void;
  onDeleteSlot?: (slotId: string) => void;
  onMoveSlot?: (slotId: string, localIsoMinute: string) => void;
  /** Called after BookingModal confirm (student mode). */
  onBookSlot?: (slotId: string) => void | Promise<void>;
  onRefresh: () => void;
  /** Ranked alternate tutors for student fallback switcher. */
  fallbackTeachers?: FallbackTeacher[];
  selectedTeacherId?: string | null;
  onSelectFallbackTeacher?: (teacher: FallbackTeacher) => void;
  /** Highlight preferred day column (0=Sun … 6=Sat) and hour cell. */
  highlightDayKey?: number | null;
  highlightHour?: string | null;
  /** Multi-select highlights: any matching day×hour cell. */
  highlightDays?: number[];
  highlightHours?: string[];
}

function startOfWeekSunday(from: Date): Date {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

function buildWeekDates(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return d;
  });
}

function localIsoMinute(date: Date, hourStr: string): string {
  const [h, m] = hourStr.split(":");
  const target = new Date(date);
  target.setHours(parseInt(h, 10), parseInt(m, 10), 0, 0);
  const offset = target.getTimezoneOffset() * 60000;
  return new Date(target.getTime() - offset).toISOString().slice(0, 16);
}

function sameDayHour(iso: string, date: Date, hourStr: string): boolean {
  const slotDate = new Date(iso);
  const [h] = hourStr.split(":");
  return (
    slotDate.getDate() === date.getDate() &&
    slotDate.getMonth() === date.getMonth() &&
    slotDate.getFullYear() === date.getFullYear() &&
    slotDate.getHours() === parseInt(h, 10)
  );
}

function isWithinWeek(iso: string, weekDates: Date[]): boolean {
  if (weekDates.length < 7) return false;
  const start = new Date(weekDates[0]);
  start.setHours(0, 0, 0, 0);
  const end = new Date(weekDates[6]);
  end.setHours(23, 59, 59, 999);
  const t = new Date(iso).getTime();
  return t >= start.getTime() && t <= end.getTime();
}

function findLessonAt(
  lessons: ScheduleLesson[],
  date: Date,
  hourStr: string
): ScheduleLesson | undefined {
  return lessons.find(
    (l) =>
      (l.status === "SCHEDULED" || l.status === "IN_PROGRESS") &&
      sameDayHour(l.scheduledAt, date, hourStr)
  );
}

function findSlotAt(
  slots: ScheduleSlot[],
  date: Date,
  hourStr: string
): ScheduleSlot | undefined {
  return slots.find((s) => sameDayHour(s.startTime, date, hourStr));
}

function lessonToIcs(lesson: ScheduleLesson): IcsLessonEvent {
  return {
    id: lesson.id,
    title: lesson.title,
    scheduledAt: lesson.scheduledAt,
    durationMinutes: lesson.durationMinutes ?? 50,
    description: `מורה: ${lesson.teacher.name} · תלמיד: ${lesson.student.name}`,
  };
}

export default function WeeklyScheduleBoard({
  mode,
  slots,
  lessons,
  userRole,
  busy = false,
  onCreateSlot,
  onDeleteSlot,
  onMoveSlot,
  onBookSlot,
  onRefresh,
  fallbackTeachers = [],
  selectedTeacherId = null,
  onSelectFallbackTeacher,
  highlightDayKey = null,
  highlightHour = null,
  highlightDays = [],
  highlightHours = [],
}: WeeklyScheduleBoardProps) {
  const [viewType, setViewType] = useState<ViewType>("week");
  const [weekStart, setWeekStart] = useState(() => startOfWeekSunday(new Date()));
  const [menuLessonId, setMenuLessonId] = useState<string | null>(null);
  const [cancelLesson, setCancelLesson] = useState<ScheduleLesson | null>(null);
  const [rescheduleLesson, setRescheduleLesson] = useState<ScheduleLesson | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isRescheduling, setIsRescheduling] = useState(false);
  const [isSlotsLoading, setIsSlotsLoading] = useState(false);
  const [availableSlots, setAvailableSlots] = useState<AvailabilityResponseSlot[]>([]);
  const [selectedNewSlotId, setSelectedNewSlotId] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [bookingSlot, setBookingSlot] = useState<BookingModalSlot | null>(null);
  const [bookingConfirming, setBookingConfirming] = useState(false);

  const weekDates = useMemo(() => buildWeekDates(weekStart), [weekStart]);

  const openSlotsInDisplayedWeek = useMemo(
    () =>
      slots.filter((s) => !s.isBooked && isWithinWeek(s.startTime, weekDates)).length,
    [slots, weekDates]
  );

  const showForcedFallback =
    mode === "student" &&
    Boolean(onSelectFallbackTeacher) &&
    fallbackTeachers.length > 0 &&
    openSlotsInDisplayedWeek === 0;

  useEffect(() => {
    const close = () => setMenuLessonId(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  const scheduledLessons = useMemo(
    () =>
      lessons.filter(
        (l) => l.status === "SCHEDULED" || l.status === "IN_PROGRESS"
      ),
    [lessons]
  );

  const openBookingFromSlot = (slot: ScheduleSlot) => {
    if (busy || slot.isBooked || !onBookSlot) return;
    setBookingSlot({
      id: slot.id,
      startTime: slot.startTime,
      endTime: slot.endTime,
      teacherName: slot.teacher?.name ?? "מורה",
    });
  };

  const confirmBooking = async (slotId: string) => {
    if (!onBookSlot) return;
    setBookingConfirming(true);
    try {
      await onBookSlot(slotId);
      setBookingSlot(null);
    } finally {
      setBookingConfirming(false);
    }
  };

  const shiftWeek = (delta: number) => {
    setWeekStart((prev) => {
      const next = new Date(prev);
      next.setDate(prev.getDate() + delta * 7);
      return next;
    });
  };

  const handleSyncGoogle = () => {
    const upcoming = scheduledLessons
      .slice()
      .sort(
        (a, b) =>
          new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
      )
      .find((l) => new Date(l.scheduledAt).getTime() >= Date.now() - 60_000);

    if (upcoming) {
      window.open(buildGoogleCalendarUrl(lessonToIcs(upcoming)), "_blank", "noopener,noreferrer");
      toast.success("נפתח Google Calendar לשיעור הקרוב — ניתן גם לייבא את קובץ ה-.ics");
    } else {
      toast.error("אין שיעורים מתוזמנים לסנכרון");
    }

    // Also offer bulk ICS for full calendar import into Google.
    if (scheduledLessons.length > 0) {
      const ics = buildIcsCalendar(
        scheduledLessons.map(lessonToIcs),
        "PROJECT100 — שיעורים"
      );
      downloadIcsFile(ics, "project100-lessons.ics");
    }
  };

  const handleSyncApple = async () => {
    try {
      const res = await fetch("/api/calendar/export");
      if (!res.ok) throw new Error("ייצוא נכשל");
      const ics = await res.text();
      downloadIcsFile(ics, "project100-lessons.ics");

      const webcal = buildWebcalUrl(window.location.origin);
      // Prefer a new tab/window so the dashboard stays open; Safari may still prompt Calendar.
      window.open(webcal, "_blank", "noopener,noreferrer");
      toast.success("קובץ .ics הורד · קישור webcal נפתח ליומן Apple");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה בסנכרון Apple Calendar");
    }
  };

  const openCancel = (lesson: ScheduleLesson) => {
    setMenuLessonId(null);
    setCancelLesson(lesson);
  };

  const openReschedule = async (lesson: ScheduleLesson) => {
    setMenuLessonId(null);
    setSelectedNewSlotId(null);
    setRescheduleLesson(lesson);
    setIsSlotsLoading(true);
    try {
      const url =
        userRole === "STUDENT"
          ? `/api/availability?teacherId=${encodeURIComponent(lesson.teacherId)}`
          : "/api/availability";
      const res = await fetch(url);
      const data = (await res.json()) as AvailabilityResponseSlot[] | { error?: string };
      if (!res.ok || !Array.isArray(data)) {
        throw new Error(
          !Array.isArray(data) && data.error ? data.error : "שגיאה בטעינת השעות הפנויות"
        );
      }
      const currentStart = new Date(lesson.scheduledAt).getTime();
      setAvailableSlots(
        data.filter((s) => new Date(s.startTime).getTime() !== currentStart)
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה בטעינת השעות");
      setRescheduleLesson(null);
    } finally {
      setIsSlotsLoading(false);
    }
  };

  const confirmCancel = async () => {
    if (!cancelLesson) return;
    setIsCancelling(true);
    try {
      const res = await fetch(`/api/lessons/${cancelLesson.id}/cancel`, {
        method: "POST",
      });
      const data = (await res.json()) as CancelResponse;
      if (!res.ok) throw new Error(data.error || "ביטול השיעור נכשל");
      toast.success(data.message || "השיעור בוטל בהצלחה");
      setCancelLesson(null);
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה בביטול שיעור");
    } finally {
      setIsCancelling(false);
    }
  };

  const confirmReschedule = async () => {
    if (!rescheduleLesson || !selectedNewSlotId) {
      toast.error("יש לבחור מועד חלופי");
      return;
    }
    setIsRescheduling(true);
    try {
      const res = await fetch(`/api/lessons/${rescheduleLesson.id}/reschedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newSlotId: selectedNewSlotId }),
      });
      const data = (await res.json()) as RescheduleResponse;
      if (!res.ok) throw new Error(data.error || "הזזת השיעור נכשלה");
      toast.success(data.message || "השיעור הוזז בהצלחה");
      setRescheduleLesson(null);
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה בהזזת השיעור");
    } finally {
      setIsRescheduling(false);
    }
  };

  const handleTeacherCellClick = (
    date: Date,
    hourStr: string,
    slot: ScheduleSlot | undefined,
    lesson: ScheduleLesson | undefined
  ) => {
    if (busy) return;
    if (lesson) return; // gear menu handles lessons
    if (slot) {
      if (!slot.isBooked && onDeleteSlot) onDeleteSlot(slot.id);
      return;
    }
    if (onCreateSlot) onCreateSlot(localIsoMinute(date, hourStr));
  };

  const handleStudentCellClick = (slot: ScheduleSlot | undefined) => {
    if (busy || !slot || slot.isBooked || !onBookSlot) return;
    openBookingFromSlot(slot);
  };

  const parseDrag = (e: DragEvent): DragPayload | null => {
    const raw = e.dataTransfer.getData("application/x-schedule");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as DragPayload;
    } catch {
      return null;
    }
  };

  const setDragData = (e: DragEvent, payload: DragPayload) => {
    e.dataTransfer.setData("application/x-schedule", JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDropOnCell = (
    e: DragEvent,
    date: Date,
    hourStr: string,
    dayKey: number
  ) => {
    e.preventDefault();
    setDragOverKey(null);
    if (busy) return;

    const payload = parseDrag(e);
    if (!payload) return;

    const targetOccupied = findSlotAt(slots, date, hourStr) || findLessonAt(lessons, date, hourStr);
    const targetIso = localIsoMinute(date, hourStr);

    if (mode === "teacher") {
      if (payload.kind === "availability" && onMoveSlot) {
        if (targetOccupied) {
          toast.error("היעד תפוס — בחר משבצת ריקה");
          return;
        }
        onMoveSlot(payload.slotId, targetIso);
        return;
      }
      if (payload.kind === "paint-create" && onCreateSlot) {
        // Create at source (if empty) and at drop target (60-min units).
        const sourceDate = weekDates[payload.sourceDayKey];
        if (sourceDate) {
          const sourceSlot = findSlotAt(slots, sourceDate, payload.sourceHour);
          const sourceLesson = findLessonAt(lessons, sourceDate, payload.sourceHour);
          if (!sourceSlot && !sourceLesson) {
            onCreateSlot(localIsoMinute(sourceDate, payload.sourceHour));
          }
        }
        if (!targetOccupied) {
          onCreateSlot(targetIso);
        }
        return;
      }
    }

    if (mode === "student" && payload.kind === "open-book") {
      const dragged = slots.find((s) => s.id === payload.slotId);
      if (dragged && !dragged.isBooked) {
        openBookingFromSlot(dragged);
      }
    }
  };

  const cellKey = (dayKey: number, hourStr: string) => `${dayKey}-${hourStr}`;

  const cancelWarning = (lesson: ScheduleLesson): string => {
    const isTeacher = userRole === "TEACHER";
    const isWithin24h =
      new Date(lesson.scheduledAt).getTime() - Date.now() < TWENTY_FOUR_HOURS_MS;
    if (isTeacher) {
      return isWithin24h
        ? "אזהרה: יגרור קנס 15%. ננסה למצוא מחליף. להמשיך?"
        : "השיעור יבוטל והקרדיט יוחזר לתלמיד.";
    }
    return isWithin24h
      ? "אזהרה: הביטול הוא פחות מ-24 שעות. הקרדיט לא יוחזר."
      : "השיעור יבוטל והקרדיט יוחזר במלואו.";
  };

  const renderGear = (lesson: ScheduleLesson) => (
    <div className="absolute top-0.5 start-0.5 z-20" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label="תפריט פעולות שיעור"
        onClick={(e) => {
          e.stopPropagation();
          setMenuLessonId((id) => (id === lesson.id ? null : lesson.id));
        }}
        className="w-6 h-6 flex items-center justify-center rounded-md bg-white/90 border border-neutral-200 hover:bg-neutral-50 text-[11px] text-neutral-700 shadow-sm"
      >
        ⚙️
      </button>
      {menuLessonId === lesson.id && (
        <div className="absolute end-0 top-full mt-1 z-40 min-w-[150px] bg-white border border-neutral-200 rounded-xl overflow-hidden shadow-lg">
          <button
            type="button"
            onClick={() => openReschedule(lesson)}
            className="w-full text-start px-3 py-2 text-[11px] font-medium text-neutral-700 hover:bg-neutral-50 border-b border-neutral-100"
          >
            דחיית שיעור
          </button>
          <button
            type="button"
            onClick={() => openCancel(lesson)}
            className="w-full text-start px-3 py-2 text-[11px] font-medium text-red-700 hover:bg-red-50"
          >
            ביטול שיעור
          </button>
          <a
            href={buildGoogleCalendarUrl(lessonToIcs(lesson))}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full text-start px-3 py-2 text-[11px] font-medium text-neutral-600 hover:bg-neutral-50 border-t border-neutral-100"
            onClick={() => setMenuLessonId(null)}
          >
            הוסף ל-Google
          </a>
        </div>
      )}
    </div>
  );

  const renderCellContent = (
    date: Date,
    hourStr: string,
    dayKey: number
  ) => {
    const slot = findSlotAt(slots, date, hourStr);
    const lesson = findLessonAt(lessons, date, hourStr);
    const over = dragOverKey === cellKey(dayKey, hourStr);

    if (mode === "teacher") {
      if (lesson || (slot && slot.isBooked)) {
        const displayLesson = lesson;
        return (
          <div
            className={`absolute inset-1 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 px-2 py-1 flex flex-col justify-between text-start shadow-sm z-10 ${
              over ? "ring-2 ring-neutral-900/20" : ""
            }`}
          >
            {displayLesson && renderGear(displayLesson)}
            <div className="text-[9px] font-semibold bg-amber-100/80 text-amber-800 px-1 rounded w-fit uppercase mt-5">
              {displayLesson ? displayLesson.student.name : "סגור"}
            </div>
            <div className="text-xs font-semibold font-mono tracking-tight">{hourStr}</div>
          </div>
        );
      }
      if (slot && !slot.isBooked) {
        return (
          <div
            draggable
            onDragStart={(e) => {
              e.stopPropagation();
              setDragData(e, { kind: "availability", slotId: slot.id });
            }}
            className={`absolute inset-1 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 px-2 py-1 flex flex-col justify-between text-start shadow-sm z-10 cursor-grab active:cursor-grabbing ${
              over ? "ring-2 ring-neutral-900/20" : ""
            }`}
            title="גרור להזזת משבצת (60 דק')"
          >
            <div className="text-[9px] font-semibold tracking-wide uppercase bg-emerald-100/80 px-1 rounded w-fit">
              פנוי
            </div>
            <div className="text-xs font-semibold font-mono tracking-tight">{hourStr}</div>
          </div>
        );
      }
      return (
        <span className="opacity-0 group-hover:opacity-100 text-neutral-400 text-[11px] font-medium transition-opacity font-mono">
          + {hourStr}
        </span>
      );
    }

    // Student mode
    if (lesson) {
      return (
        <div
          className={`absolute inset-1 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 px-2 py-1 flex flex-col justify-between text-start shadow-sm z-10 ${
            over ? "ring-2 ring-neutral-900/20" : ""
          }`}
        >
          {renderGear(lesson)}
          <div className="text-[9px] font-semibold bg-amber-100/80 text-amber-800 px-1 rounded w-fit uppercase mt-5">
            {lesson.teacher.name}
          </div>
          <div className="text-xs font-semibold font-mono tracking-tight">{hourStr}</div>
        </div>
      );
    }

    if (slot && !slot.isBooked) {
      return (
        <div
          draggable
          onDragStart={(e) => {
            e.stopPropagation();
            setDragData(e, { kind: "open-book", slotId: slot.id });
          }}
          className={`absolute inset-1 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 px-2 py-1 flex flex-col justify-between text-start shadow-sm z-10 cursor-pointer hover:bg-emerald-100/80 hover:border-emerald-300 hover:scale-[1.02] active:scale-[0.98] transition-all ${
            over ? "ring-2 ring-neutral-900/20" : ""
          }`}
          title="לחץ לאישור שיבוץ · או גרור"
        >
          <div className="text-[9px] font-semibold tracking-wide uppercase bg-emerald-100/80 px-1 rounded w-fit truncate max-w-full">
            {slot.teacher?.name ?? "פנוי"}
          </div>
          <div className="text-xs font-semibold font-mono tracking-tight">{hourStr}</div>
        </div>
      );
    }

    return null;
  };

  const renderGridCell = (date: Date, hourStr: string, dayKey: number) => {
    const slot = findSlotAt(slots, date, hourStr);
    const lesson = findLessonAt(lessons, date, hourStr);
    const isEmpty = !slot && !lesson;
    const over = dragOverKey === cellKey(dayKey, hourStr);
    const isPreferenceMatch =
      highlightDays.length > 0 || highlightHours.length > 0
        ? (highlightDays.length === 0 || highlightDays.includes(dayKey)) &&
          (highlightHours.length === 0 || highlightHours.includes(hourStr)) &&
          (highlightDays.length > 0 || highlightHours.length > 0)
        : highlightDayKey !== null &&
          highlightDayKey !== undefined &&
          Boolean(highlightHour) &&
          dayKey === highlightDayKey &&
          hourStr === highlightHour;

    // Student board: boldly highlight only open (unbooked) cells that match the filter.
    const isOpenMatchingSlot =
      Boolean(slot) && slot !== undefined && !slot.isBooked && isPreferenceMatch;
    const isHighlighted =
      mode === "student" ? isOpenMatchingSlot : isPreferenceMatch;

    return (
      <div
        key={cellKey(dayKey, hourStr)}
        onClick={() => {
          if (mode === "teacher") handleTeacherCellClick(date, hourStr, slot, lesson);
          else handleStudentCellClick(slot);
        }}
        draggable={mode === "teacher" && isEmpty}
        onDragStart={(e) => {
          if (mode === "teacher" && isEmpty) {
            setDragData(e, {
              kind: "paint-create",
              sourceHour: hourStr,
              sourceDayKey: dayKey,
            });
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOverKey(cellKey(dayKey, hourStr));
        }}
        onDragLeave={() => setDragOverKey((k) => (k === cellKey(dayKey, hourStr) ? null : k))}
        onDrop={(e) => handleDropOnCell(e, date, hourStr, dayKey)}
        className={`border-s border-neutral-200/80 p-1 flex items-center justify-center relative group select-none last:border-0 min-h-[58px] bg-white ${
          isEmpty && mode === "teacher"
            ? "cursor-pointer hover:bg-neutral-50 transition-colors"
            : ""
        } ${
          slot && !slot.isBooked && mode === "student"
            ? "cursor-pointer hover:bg-emerald-50/50 active:bg-emerald-50 transition-colors"
            : ""
        } ${over ? "bg-blue-50" : ""} ${
          isHighlighted
            ? "bg-blue-50 ring-2 ring-inset ring-neutral-900/80"
            : ""
        }`}
      >
        {renderCellContent(date, hourStr, dayKey)}
      </div>
    );
  };

  const getDaysInMonth = (ref: Date) => {
    const year = ref.getFullYear();
    const month = ref.getMonth();
    const date = new Date(year, month, 1);
    const days: Date[] = [];
    while (date.getMonth() === month) {
      days.push(new Date(date));
      date.setDate(date.getDate() + 1);
    }
    return days;
  };

  const monthRef = weekDates[0] ?? new Date();

  return (
    <div className={`${frostCard} p-6 space-y-6`}>
      <div className="flex flex-col lg:flex-row justify-between lg:items-center gap-4 border-b border-neutral-200/80 pb-4">
        <div>
          <h2 className="text-lg font-semibold text-neutral-900">
            {mode === "teacher" ? "יומן השעות המנוהל שלך" : "לוח השעות"}
          </h2>
          <p className="text-xs text-neutral-500">
            {mode === "teacher"
              ? "סימון, גרירת משבצות של 60 דק', וניהול שיעורים עם ⚙️ — סנכרון Google / Apple"
              : "לחצו על שעה פנויה כדי לקבוע שיעור. לדחייה או ביטול, לחצו על ⚙️ ליד השיעור."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 justify-end">
          {mode === "student" && (
            <span className={badgeNeutral}>
              {openSlotsInDisplayedWeek} פנויות בשבוע זה
            </span>
          )}
          <div className="flex items-center gap-1 bg-white border border-neutral-200 rounded-full p-1">
            <button
              type="button"
              onClick={() => shiftWeek(-1)}
              className="px-2.5 py-1.5 text-xs font-medium text-neutral-500 hover:text-neutral-900 rounded-full"
              aria-label="שבוע קודם"
            >
              ›
            </button>
            <button
              type="button"
              onClick={() => setWeekStart(startOfWeekSunday(new Date()))}
              className="px-3 py-1.5 text-[11px] font-medium text-neutral-700 hover:text-neutral-900"
            >
              היום
            </button>
            <button
              type="button"
              onClick={() => shiftWeek(1)}
              className="px-2.5 py-1.5 text-xs font-medium text-neutral-500 hover:text-neutral-900 rounded-full"
              aria-label="שבוע הבא"
            >
              ‹
            </button>
          </div>

          <div className="bg-white border border-neutral-200 p-1 rounded-full flex gap-1 text-xs font-medium">
            {(["day", "week", "month"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setViewType(v)}
                className={`px-3 py-1.5 rounded-full transition-all ${
                  viewType === v
                    ? "bg-neutral-900 text-white"
                    : "text-neutral-500 hover:text-neutral-900"
                }`}
              >
                {v === "day" ? "יום" : v === "week" ? "שבוע" : "חודש"}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={handleSyncGoogle}
            className={`${primaryCta} text-[11px] py-2 px-3`}
          >
            Google Calendar
          </button>
          <button
            type="button"
            onClick={handleSyncApple}
            className={`${secondaryCta} text-[11px] py-2 px-3`}
          >
            Apple Calendar
          </button>
        </div>
      </div>

      {mode === "student" && onSelectFallbackTeacher && fallbackTeachers.length > 0 && (
        <TeacherFallbackSwitcher
          teachers={fallbackTeachers}
          selectedTeacherId={selectedTeacherId}
          forceOpen={showForcedFallback}
          busy={busy}
          onSelectTeacher={onSelectFallbackTeacher}
        />
      )}

      {viewType === "day" && (
        <div className="overflow-x-auto max-h-[600px] overflow-y-auto border border-neutral-200/80 rounded-2xl">
          <div className="min-w-[400px] bg-white">
            <div className="grid grid-cols-2 bg-white/80 backdrop-blur-md border-b border-neutral-200/80 text-center py-3 text-xs font-medium text-neutral-600 sticky top-0 z-20">
              <div className="border-s border-neutral-200/80">שעה</div>
              <div>
                <div>
                  יום{" "}
                  {new Date().toLocaleDateString("he-IL", { weekday: "long" })}
                </div>
                <div className="text-[10px] text-neutral-500 font-mono mt-0.5">
                  {new Date().toLocaleDateString("he-IL", {
                    day: "numeric",
                    month: "numeric",
                    year: "numeric",
                  })}
                </div>
              </div>
            </div>
            <div className="divide-y divide-neutral-100">
              {HOURS_OF_DAY.map((hourStr) => {
                const today = new Date();
                return (
                  <div key={hourStr} className="grid grid-cols-2 items-stretch min-h-[58px]">
                    <div className="bg-neutral-50/80 border-s border-neutral-200/80 flex items-center justify-center text-xs font-mono font-medium text-neutral-500">
                      {hourStr}
                    </div>
                    {renderGridCell(today, hourStr, today.getDay())}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {viewType === "week" && weekDates.length > 0 && (
        <div className="overflow-x-auto max-h-[600px] overflow-y-auto border border-neutral-200/80 rounded-2xl">
          <div className="min-w-[800px] bg-white">
            <div className="grid grid-cols-8 bg-white/80 backdrop-blur-md border-b border-neutral-200/80 text-center py-3 text-xs font-medium text-neutral-600 sticky top-0 z-20">
              <div className="border-s border-neutral-200/80">שעה</div>
              {DAYS_OF_WEEK.map((day) => {
                const dateObj = weekDates[day.key];
                return (
                  <div key={day.key} className="border-s border-neutral-200/80 last:border-0">
                    <div>יום {day.label}</div>
                    <div className="text-[10px] text-neutral-500 font-mono mt-0.5">
                      {dateObj?.getDate()}/{(dateObj?.getMonth() ?? 0) + 1}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="divide-y divide-neutral-100">
              {HOURS_OF_DAY.map((hourStr) => (
                <div key={hourStr} className="grid grid-cols-8 items-stretch min-h-[58px]">
                  <div className="bg-neutral-50/80 border-s border-neutral-200/80 flex items-center justify-center text-xs font-mono font-medium text-neutral-500 sticky end-0 z-10">
                    {hourStr}
                  </div>
                  {DAYS_OF_WEEK.map((day) => {
                    const dateObj = weekDates[day.key];
                    if (!dateObj) {
                      return <div key={day.key} className="border-s border-neutral-200/80" />;
                    }
                    return renderGridCell(dateObj, hourStr, day.key);
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {viewType === "month" && (
        <div className="bg-white border border-neutral-200/80 rounded-2xl p-4">
          <div className="grid grid-cols-7 gap-2 text-center text-xs font-medium text-neutral-600 border-b border-neutral-200 pb-2 mb-2">
            <div>ראשון</div>
            <div>שני</div>
            <div>שלישי</div>
            <div>רביעי</div>
            <div>חמישי</div>
            <div>שישי</div>
            <div>שבת</div>
          </div>
          <div className="grid grid-cols-7 gap-2">
            {Array.from({
              length: new Date(
                monthRef.getFullYear(),
                monthRef.getMonth(),
                1
              ).getDay(),
            }).map((_, i) => (
              <div
                key={`empty-${i}`}
                className="min-h-[85px] bg-transparent border border-transparent rounded-xl"
              />
            ))}
            {getDaysInMonth(monthRef).map((day) => {
              const daySlots = slots.filter((slot) => {
                const d = new Date(slot.startTime);
                return (
                  d.getDate() === day.getDate() &&
                  d.getMonth() === day.getMonth() &&
                  d.getFullYear() === day.getFullYear()
                );
              });
              const dayLessons = scheduledLessons.filter((l) => {
                const d = new Date(l.scheduledAt);
                return (
                  d.getDate() === day.getDate() &&
                  d.getMonth() === day.getMonth() &&
                  d.getFullYear() === day.getFullYear()
                );
              });
              const openCount = daySlots.filter((s) => !s.isBooked).length;
              const bookedCount =
                mode === "teacher"
                  ? daySlots.filter((s) => s.isBooked).length
                  : dayLessons.length;
              return (
                <div
                  key={day.toISOString()}
                  className="min-h-[85px] bg-neutral-50 border border-neutral-200/80 rounded-xl p-2 flex flex-col justify-between"
                >
                  <span className="text-xs font-mono font-medium text-neutral-500">
                    {day.getDate()}
                  </span>
                  <div className="space-y-1 mt-1">
                    {openCount > 0 && (
                      <div className="text-[10px] font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 px-1 py-0.5 rounded text-center">
                        {openCount} פנויים
                      </div>
                    )}
                    {bookedCount > 0 && (
                      <div className="text-[10px] font-medium text-amber-800 bg-amber-50 border border-amber-200 px-1 py-0.5 rounded text-center">
                        {bookedCount} שיעורים
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Cancel modal */}
      {cancelLesson && (
        <div className="fixed inset-0 bg-neutral-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className={`${frostCard} p-6 max-w-md w-full space-y-4 text-start shadow-lg`}>
            <h3 className="text-base font-semibold text-neutral-900">ביטול שיעור</h3>
            <p className="text-xs text-neutral-600 leading-relaxed">
              {cancelWarning(cancelLesson)}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={isCancelling}
                onClick={() => setCancelLesson(null)}
                className={secondaryCta}
              >
                חזרה
              </button>
              <button
                type="button"
                disabled={isCancelling}
                onClick={confirmCancel}
                className="bg-red-600 text-white hover:bg-red-500 rounded-full px-5 py-2.5 text-sm font-medium transition-colors disabled:opacity-40"
              >
                {isCancelling ? "מבטל..." : "אישור ביטול"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reschedule modal — slot picks from visual-friendly list (not native date pickers) */}
      {rescheduleLesson && (
        <div className="fixed inset-0 bg-neutral-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className={`${frostCard} p-6 max-w-md w-full space-y-4 text-start shadow-lg`}>
            <div>
              <h3 className="text-base font-semibold text-neutral-900">דחיית שיעור</h3>
              <p className="text-xs text-neutral-500 mt-1">
                בחרו מועד חלופי מהמשבצות הפנויות (יחידות של 60 דק').
              </p>
            </div>
            {isSlotsLoading ? (
              <p className="text-xs text-neutral-500">טוען שעות פנויות...</p>
            ) : availableSlots.length === 0 ? (
              <div className={emptyState}>
                <p className="text-sm font-medium text-neutral-900">אין שעות פנויות</p>
                <p className="text-xs text-neutral-500">נסו שוב מאוחר יותר או בחרו מורה אחר.</p>
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
                  </button>
                ))}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={isRescheduling}
                onClick={() => setRescheduleLesson(null)}
                className={secondaryCta}
              >
                חזרה
              </button>
              <button
                type="button"
                disabled={isRescheduling || !selectedNewSlotId}
                onClick={confirmReschedule}
                className={primaryCta}
              >
                {isRescheduling ? "מזיז..." : "אישור דחייה"}
              </button>
            </div>
          </div>
        </div>
      )}

      {bookingSlot && (
        <BookingModal
          slot={bookingSlot}
          busy={busy || bookingConfirming}
          onConfirm={confirmBooking}
          onClose={() => {
            if (!bookingConfirming) setBookingSlot(null);
          }}
        />
      )}
    </div>
  );
}
