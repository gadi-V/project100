"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "react-hot-toast";
import {
  pageCanvas,
  frostCard,
  primaryCta,
  secondaryCta,
  dangerCta,
  fieldClass,
  badgeSuccess,
  badgeNeutral,
  badgeWarning,
  emptyState,
} from "../../../lib/ui";

type GradeLevel = "ELEMENTARY" | "MIDDLE_SCHOOL" | "HIGH_SCHOOL" | "ACADEMIC";

type ParsedTopic = {
  subject: string;
  topicName: string;
  subTopics: string[];
  gradeLevel: GradeLevel;
  weightInExam: number;
};

type ExplorerTopic = ParsedTopic & {
  id: string;
  teacherNames: string[];
  teacherCount: number;
};

type ExplorerGroup = {
  subject: string;
  gradeLevel: string;
  topics: ExplorerTopic[];
};

const GRADE_LABELS: Record<GradeLevel, string> = {
  ELEMENTARY: "יסודי",
  MIDDLE_SCHOOL: "חטיבת ביניים",
  HIGH_SCHOOL: "תיכון / בגרות",
  ACADEMIC: "אקדמיה",
};

const SAMPLE_SYLLABUS = `מתמטיקה 5 יח״ל שאלון 582:
- וקטורים (אלגבריים וגיאומטריים)
- גאומטריה אנליטית (אליפסה והיפרבולה)
- מספרים מרוכבים
- חדו״א של פונקציות מעריכיות ולוגריתמיות`;

export default function AdminCurriculumPage() {
  const router = useRouter();
  const [rawText, setRawText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [preview, setPreview] = useState<ParsedTopic[] | null>(null);
  const [committing, setCommitting] = useState(false);
  const [groups, setGroups] = useState<ExplorerGroup[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loadingTree, setLoadingTree] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingTopic, setEditingTopic] = useState<ParsedTopic | null>(null);

  const loadTree = useCallback(async () => {
    setLoadingTree(true);
    try {
      const res = await fetch("/api/admin/curriculum");
      if (res.status === 401 || res.status === 403) {
        router.replace("/login?from=/admin/curriculum");
        return;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "שגיאה בשליפת התכנית");
      }
      const data = (await res.json()) as { groups: ExplorerGroup[] };
      setGroups(data.groups);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה בטעינת עץ התכנית");
    } finally {
      setLoadingTree(false);
    }
  }, [router]);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  const handleParse = async () => {
    if (rawText.trim().length < 10) {
      toast.error("הדביקו תחילה טקסט סילבוס (מינימום 10 תווים)");
      return;
    }
    setParsing(true);
    setPreview(null);
    try {
      const res = await fetch("/api/admin/curriculum", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawText }),
      });
      if (res.status === 401 || res.status === 403) {
        router.replace("/login?from=/admin/curriculum");
        return;
      }
      const data = (await res.json()) as { topics?: ParsedTopic[]; error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "ההנמכה נכשלה");
      }
      setPreview(data.topics ?? []);
      if (data.topics && data.topics.length > 0) {
        toast.success(
          `האג'נט ניתח ${data.topics.length} נושאים — בדקו את התצוגה לפני שמירה`
        );
      } else {
        toast.error("האג'נט לא זיהה נושאים");
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה בניתוח הסילבוס");
    } finally {
      setParsing(false);
    }
  };

  const handleCommit = async () => {
    if (!preview || preview.length === 0) return;
    setCommitting(true);
    try {
      const res = await fetch("/api/admin/curriculum", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topics: preview }),
      });
      const data = (await res.json()) as { count?: number; error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "שגיאה בהמחזת נושאים");
      }
      toast.success(`נשמרו ${data.count ?? preview.length} נושאים ל-Database`);
      setPreview(null);
      setRawText("");
      await loadTree();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה בשמירת הנושאים");
    } finally {
      setCommitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/admin/curriculum?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "שגיאה במחיקת הנושא");
      }
      toast.success("הנושא נמחק");
      await loadTree();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה במחיקה");
    } finally {
      setDeletingId(null);
    }
  };

  const handleEdit = (topic: ExplorerTopic) => {
    setEditingTopic({
      subject: topic.subject,
      topicName: topic.topicName,
      subTopics: topic.subTopics,
      gradeLevel: topic.gradeLevel,
      weightInExam: topic.weightInExam,
    });
  };

  const toggleGroup = (key: string) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  function topicKey(group: ExplorerGroup) {
    return `${group.subject}::${group.gradeLevel}`;
  }

  return (
    <main className={pageCanvas} dir="rtl">
      <div className="max-w-6xl mx-auto p-4 sm:p-8 space-y-8">
        <div className={`${frostCard} p-6 flex flex-wrap items-center justify-between gap-4`}>
          <div>
            <Link
              href="/admin"
              className="text-xs font-medium text-neutral-500 hover:text-neutral-900 transition-colors"
            >
              חזרה ללוח הניהול
            </Link>
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-neutral-900 mt-2">
              עץ תכנית לימודים ונושאים
            </h1>
            <p className="text-sm text-neutral-500 mt-1">
              מערכת הזרקת תכניות לימודים לסילונים, מיקודי בגרות ותוכניות מתקדמות
            </p>
          </div>
          <span className={badgeNeutral}>ADMIN / MANAGER</span>
        </div>

        <div className="grid lg:grid-cols-5 gap-6">
          <section className={`lg:col-span-2 ${frostCard} p-5 space-y-4`}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-neutral-900">הזרקת תכנית מארק־דאון</h2>
              <button
                type="button"
                onClick={() => setRawText(SAMPLE_SYLLABUS)}
                className="text-xs font-medium text-neutral-600 hover:text-neutral-900"
              >
                הדבק דוגמה
              </button>
            </div>

            <textarea
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              placeholder={
                "הדביקו כאן טקסט של סילבוס / מיקור / פירוט בחינה…\n\nלדוגמה:\nמתמטיקה 5 יַח״ל שאר 582:\n- וקטורים (אלגבריים וגיאומטריים)\n- גאומטריה אניטית…"
              }
              className={`${fieldClass} min-h-[200px] font-mono leading-relaxed`}
            />

            <button
              type="button"
              disabled={parsing || rawText.trim().length < 10}
              onClick={handleParse}
              className={`w-full ${primaryCta} justify-center flex items-center gap-2`}
            >
              {parsing ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                    />
                  </svg>
                  טוען את ה‑Agent Hive…
                </span>
              ) : (
                "Parse with AI Hive"
              )}
            </button>

            {preview && preview.length > 0 && (
              <div className="border-t border-neutral-100 pt-4 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-neutral-800">
                    תצוגת עץ (לפני שמירה)
                  </h3>
                  <span className="text-xs font-medium text-neutral-500">
                    {preview.length} נושאים
                  </span>
                </div>

                <ul className="space-y-3">
                  {preview.map((t, idx) => (
                    <li
                      key={idx}
                      className="bg-neutral-50 border border-neutral-200 rounded-xl p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 text-start">
                          <span className="text-sm font-semibold text-neutral-900 block truncate">
                            {t.topicName}
                          </span>
                          <span className="text-[14px] font-medium text-neutral-500">
                            {t.subject} · {GRADE_LABELS[t.gradeLevel]}
                          </span>
                        </div>
                        <span className={badgeWarning}>
                          {Math.round(t.weightInExam * 100)}% במבחן
                        </span>
                      </div>

                      {t.subTopics.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {t.subTopics.map((s, i) => (
                            <span key={i} className={badgeNeutral}>
                              {s}
                            </span>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>

                <button
                  type="button"
                  disabled={committing}
                  onClick={handleCommit}
                  className="w-full rounded-full bg-emerald-700 hover:bg-emerald-800 text-white font-medium py-2.5 text-sm transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
                >
                  {committing ? "משמר ל‑Database…" : "אישור והזרקת הנושאים"}
                </button>
              </div>
            )}
          </section>

          <section className={`lg:col-span-3 ${frostCard} p-5 space-y-4`}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-neutral-900">סייר הנושאים</h2>
              <button
                type="button"
                onClick={loadTree}
                className="text-xs font-medium text-neutral-500 hover:text-neutral-900 transition-colors"
              >
                רענון
              </button>
            </div>

            {loadingTree ? (
              <div className="animate-pulse space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-12 bg-neutral-100 rounded-xl" />
                ))}
              </div>
            ) : groups.length === 0 ? (
              <div className={emptyState}>
                <p className="text-sm text-neutral-600">
                  עדיין אין נושאים — התחילו בהדבקת סילובס משמאל.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {groups.map((group) => {
                  const key = topicKey(group);
                  const isOpen = expanded[key] ?? false;
                  return (
                    <div
                      key={key}
                      className="bg-neutral-50/80 border border-neutral-200 rounded-xl overflow-hidden"
                    >
                      <button
                        type="button"
                        onClick={() => toggleGroup(key)}
                        className="w-full flex items-center justify-between px-5 py-4 text-start hover:bg-neutral-50/80 transition-colors"
                      >
                        <div>
                          <span className="text-sm font-semibold text-neutral-900">
                            {group.subject}
                          </span>
                          <span className="ms-2 text-[14px] font-medium text-neutral-500">
                            {GRADE_LABELS[group.gradeLevel as GradeLevel] ?? group.gradeLevel}
                          </span>
                        </div>
                        <span className="flex items-center gap-2">
                          <span className={badgeNeutral}>{group.topics.length} נושאים</span>
                          <svg
                            className={`w-4 h-4 text-neutral-400 transition-transform ${isOpen ? "rotate-180" : ""}`}
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M19 9l-7 7-7-7"
                            />
                          </svg>
                        </span>
                      </button>

                      {isOpen && (
                        <div className="border-t border-neutral-100">
                          {group.topics.map((topic) => (
                            <div
                              key={topic.id}
                              className="px-5 py-4 space-y-2 border-b border-neutral-100 last:border-b-0 hover:bg-neutral-50/80 transition-colors"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 text-start">
                                  <p className="text-sm font-semibold text-neutral-900">
                                    {topic.topicName}
                                  </p>
                                  {topic.subTopics.length > 0 && (
                                    <div className="flex flex-wrap gap-1 mt-1.5">
                                      {topic.subTopics.map((s, i) => (
                                        <span key={i} className={badgeNeutral}>
                                          {s}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <span className={badgeSuccess}>
                                    {topic.teacherCount} מורים
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => handleEdit(topic)}
                                    className={secondaryCta}
                                    title="עריכת משקל / תתי-נושאים"
                                  >
                                    עריכה
                                  </button>
                                  <button
                                    type="button"
                                    disabled={deletingId === topic.id}
                                    onClick={() => handleDelete(topic.id)}
                                    className={dangerCta}
                                  >
                                    {deletingId === topic.id ? "…" : "מחק"}
                                  </button>
                                </div>
                              </div>

                              {topic.teacherNames.length > 0 && (
                                <div className="flex flex-wrap gap-1.5">
                                  {topic.teacherNames.slice(0, 6).map((n, i) => (
                                    <span key={i} className={badgeNeutral}>
                                      {n}
                                    </span>
                                  ))}
                                  {topic.teacherNames.length > 6 && (
                                    <span className="text-[13px] font-medium text-neutral-500">
                                      +{topic.teacherNames.length - 6} נוספים
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        {editingTopic && (
          <EditTopicModal
            topic={editingTopic}
            onClose={() => setEditingTopic(null)}
            onSaved={() => {
              setEditingTopic(null);
              loadTree();
              toast.success("הנושא עודכן");
            }}
          />
        )}
      </div>
    </main>
  );
}

/**
 * Lightweight inline edit modal — re-commits through PUT (additive upsert by
 * subject + topicName + gradeLevel) so the 09-database-safety rule is respected.
 */
function EditTopicModal({
  topic,
  onClose,
  onSaved,
}: {
  topic: ParsedTopic;
  onClose: () => void;
  onSaved: (t: ParsedTopic) => void;
}) {
  const [form, setForm] = useState<ParsedTopic>({ ...topic });
  const [saving, setSaving] = useState(false);

  const update = (patch: Partial<ParsedTopic>) =>
    setForm((prev) => ({ ...prev, ...patch }));

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/curriculum", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topics: [form] }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "שגיאה בעדכון הנושא");
      onSaved(form);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה בעדכון");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-neutral-900/40 backdrop-blur-sm flex items-center justify-center p-4"
      dir="rtl"
    >
      <div className={`${frostCard} p-5 w-full max-w-md space-y-4`}>
        <h3 className="text-lg font-semibold text-neutral-900">עריכת נושא</h3>

        <label className="block text-xs font-medium text-neutral-500" htmlFor="ed-topic">
          שם הנושא
        </label>
        <input
          id="ed-topic"
          value={form.topicName}
          onChange={(e) => update({ topicName: e.target.value })}
          className={fieldClass}
        />

        <label className="block text-xs font-medium text-neutral-500">
          תת־נושאים (מופרדים בפסיק)
        </label>
        <input
          value={form.subTopics.join(", ")}
          onChange={(e) =>
            update({
              subTopics: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
          className={fieldClass}
        />

        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs font-medium text-neutral-500">
            רמת לימוד
            <select
              value={form.gradeLevel}
              onChange={(e) => update({ gradeLevel: e.target.value as GradeLevel })}
              className={`${fieldClass} mt-1`}
            >
              <option value="ELEMENTARY">יסודי</option>
              <option value="MIDDLE_SCHOOL">חטיבת ביניים</option>
              <option value="HIGH_SCHOOL">תיכון / בגרות</option>
              <option value="ACADEMIC">אקדמיה</option>
            </select>
          </label>
          <label className="block text-xs font-medium text-neutral-500">
            משקל במבחן
            <input
              type="number"
              min={0.1}
              max={1}
              step={0.05}
              value={form.weightInExam}
              onChange={(e) => update({ weightInExam: Number(e.target.value) })}
              className={`${fieldClass} mt-1`}
            />
          </label>
        </div>

        <div className="flex items-center gap-2 pt-2">
          <button
            type="button"
            disabled={saving}
            onClick={handleSave}
            className={`flex-1 ${primaryCta}`}
          >
            {saving ? "מששר..." : "שמירה"}
          </button>
          <button type="button" onClick={onClose} className={`flex-1 ${secondaryCta}`}>
            ביטול
          </button>
        </div>
      </div>
    </div>
  );
}
