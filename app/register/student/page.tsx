"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "react-hot-toast";
import {
  fieldClass,
  frostCard,
  orangeCta,
  orangeOptionSelected,
  orangeOutlineCta,
  pageCanvas,
} from "../../../lib/ui";
import {
  INVALID_PHONE_ERROR,
  ONBOARDING_STORAGE_KEY,
  normalizeIsraeliMobile,
  parseOnboardingAnswers,
  type OnboardingAnswers,
} from "../../../lib/student-onboarding";
import { clearStoredUTM, readStoredUTM } from "../../../lib/hooks/useUTMTracking";

function BackArrow({ className = "ms-1.5 inline-block h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 12h14M13 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ForwardArrow({ className = "me-1.5 inline-block h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M19 12H5M11 6l-6 6 6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GoogleIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
      />
      <path
        fill="#FF3D00"
        d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
      />
    </svg>
  );
}

type StudentFormData = Omit<OnboardingAnswers, "path"> & {
  path: "" | OnboardingAnswers["path"];
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  password: string;
  acceptTerms: boolean;
  whatsappUpdates: boolean;
};

const orangeField = `${fieldClass} focus-visible:ring-orange-500/15 focus-visible:border-orange-500`;
const fieldLabel = "text-xs font-black text-[#6e6e73]";

const GOOGLE_RETURN_MESSAGES: Record<string, string> = {
  unavailable: "ההרשמה עם Google עדיין לא זמינה. אפשר להירשם עם הטופס.",
  failed: "ההתחברות עם Google לא הושלמה. נסו שוב או הירשמו עם הטופס.",
  staff: "כתובת ה-Google הזו שייכת לחשבון צוות. יש להתחבר עם סיסמה.",
};

function answersFrom(formData: StudentFormData) {
  return parseOnboardingAnswers({
    path: formData.path,
    schoolGrade: formData.schoolGrade,
    schoolUnits: formData.schoolUnits,
    schoolSubject: formData.schoolSubject,
    academicInstitution: formData.academicInstitution,
    academicDegree: formData.academicDegree,
    academicCourse: formData.academicCourse,
    bottleneck: formData.bottleneck,
    goalType: formData.goalType,
  });
}

function clearQuizLocalStorageRemnants() {
  if (typeof window === "undefined") return;
  Object.keys(localStorage).forEach((key) => {
    if (key.startsWith("quiz_done_")) {
      localStorage.removeItem(key);
    }
  });
}

export default function StudentRegisterPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const [formData, setFormData] = useState<StudentFormData>({
    path: "",
    schoolGrade: "",
    schoolUnits: "",
    schoolSubject: "",
    academicInstitution: "",
    academicDegree: "",
    academicCourse: "",
    bottleneck: "",
    goalType: "",
    firstName: "",
    lastName: "",
    phone: "",
    email: "",
    password: "",
    acceptTerms: false,
    whatsappUpdates: false,
  });

  // Back from an unfinished Google sign-in: restore steps 1-3 and reopen step 4.
  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get("google");
    if (!reason) return;
    window.history.replaceState(null, "", window.location.pathname);

    let saved: unknown = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(ONBOARDING_STORAGE_KEY) ?? "null");
    } catch {
      saved = null;
    }
    const restored = parseOnboardingAnswers(saved);
    if (restored.ok) {
      setFormData((prev) => ({ ...prev, ...restored.value }));
      setStep(4);
    }
    toast.error(GOOGLE_RETURN_MESSAGES[reason] ?? GOOGLE_RETURN_MESSAGES.failed);
  }, []);

  const handleNextStep = () => {
    if (step === 1 && !formData.path) {
      toast.error("אנא בחרו את מסלול הלימודים שלכם כדי להמשיך");
      return;
    }
    if (step === 2) {
      if (formData.path === "school" && !formData.schoolGrade.trim()) {
        toast.error("אנא מלאו את כיתת הלימוד");
        return;
      }
      if (formData.path === "academia" && !formData.academicCourse.trim()) {
        toast.error("אנא מלאו את שם הקורס");
        return;
      }
    }
    if (step === 3 && (!formData.bottleneck || !formData.goalType)) {
      toast.error("אנא השלימו את שדות האתגר ויעד הלימודים");
      return;
    }
    setSubmitError("");
    setStep((prev) => prev + 1);
  };

  const handlePrevStep = () => {
    setSubmitError("");
    setStep((prev) => prev - 1);
  };

  const handleGoogle = () => {
    const answers = answersFrom(formData);
    if (!answers.ok) {
      toast.error(answers.error);
      return;
    }
    sessionStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(answers.value));
    window.location.href = "/api/auth/google";
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitError("");

    const answers = answersFrom(formData);
    if (!answers.ok) {
      toast.error(answers.error);
      return;
    }
    if (!formData.firstName.trim() || !formData.lastName.trim()) {
      toast.error("יש למלא שם פרטי ושם משפחה");
      return;
    }
    if (!normalizeIsraeliMobile(formData.phone)) {
      toast.error(INVALID_PHONE_ERROR);
      return;
    }
    if (!formData.email.trim()) {
      toast.error("יש למלא כתובת אימייל");
      return;
    }
    if (formData.password.length < 6) {
      toast.error("הסיסמה צריכה להכיל לפחות 6 תווים");
      return;
    }
    if (!formData.acceptTerms) {
      toast.error("יש לאשר את תנאי השימוש ומדיניות הפרטיות");
      return;
    }

    setLoading(true);
    const progressToast = toast.loading("פותחים את החשבון...");

    try {
      const response = await fetch("/api/register/student", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: formData.firstName.trim(),
          lastName: formData.lastName.trim(),
          phone: formData.phone.trim(),
          email: formData.email.trim(),
          password: formData.password,
          acceptTerms: formData.acceptTerms,
          whatsappUpdates: formData.whatsappUpdates,
          answers: answers.value,
          utm: readStoredUTM(),
        }),
      });
      const result = (await response.json()) as {
        success: boolean;
        error?: string;
        data?: { name: string; redirectTo: string };
      };
      if (!response.ok || !result.success || !result.data) {
        throw new Error(result.error || "לא הצלחנו לפתוח את החשבון");
      }

      clearQuizLocalStorageRemnants();
      sessionStorage.removeItem(ONBOARDING_STORAGE_KEY);
      clearStoredUTM();
      toast.success(`ברוך הבא, ${result.data.name}!`, { id: progressToast });
      router.push(result.data.redirectTo);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "שגיאה בלתי צפויה במהלך הרישום";
      setSubmitError(message);
      toast.error(message, { id: progressToast });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`${pageCanvas} font-sans antialiased py-16 px-6`} dir="rtl">
      <div className="max-w-xl mx-auto space-y-12">
        <div className="text-center space-y-2">
          <Link
            href="/register"
            className="inline-flex items-center text-xs font-medium tracking-wide text-neutral-500 hover:text-neutral-900 transition-colors"
          >
            חזרה לבחירת סוג הרשמה
            <BackArrow />
          </Link>
          <h1 className="text-4xl font-semibold text-neutral-900 tracking-tight pt-4">
            הרשמת תלמיד / הורה
          </h1>
          <p className="text-sm text-neutral-500">
            אבחון לימודי קצר ואז פתיחת חשבון
          </p>
        </div>

        <div className="w-full bg-neutral-100 h-1.5 rounded-full overflow-hidden">
          <div
            className="bg-neutral-900 h-full transition-all duration-300 rounded-full"
            style={{ width: `${(step / 4) * 100}%` }}
          />
        </div>

        <div className={`${frostCard} p-8 space-y-8`}>
          {step === 1 && (
            <div className="space-y-6 animate-fadeIn">
              <h3 className="text-xl font-black text-[#1d1d1f] text-start">
                בחר את מסלול הלימודים הנוכחי שלך:
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, path: "school" })}
                  className={`p-6 rounded-2xl border text-start transition-all ${
                    formData.path === "school"
                      ? orangeOptionSelected
                      : "border-orange-200 hover:border-orange-400"
                  }`}
                >
                  <div className="text-md font-black text-[#1d1d1f]">חטיבה ותיכון</div>
                  <div className="text-xs font-bold text-[#6e6e73] mt-1">
                    הכנה לבגרויות, סגירת פערים וליווי שוטף בכל מקצועות הלימוד.
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, path: "academia" })}
                  className={`p-6 rounded-2xl border text-start transition-all ${
                    formData.path === "academia"
                      ? orangeOptionSelected
                      : "border-orange-200 hover:border-orange-400"
                  }`}
                >
                  <div className="text-md font-black text-[#1d1d1f]">השכלה גבוהה / אקדמיה</div>
                  <div className="text-xs font-bold text-[#6e6e73] mt-1">
                    קורסים מורכבים ותארים אקדמיים, בדגש על הנדסה ומדעים מדויקים.
                  </div>
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4 animate-fadeIn text-start">
              <h3 className="text-xl font-black text-[#1d1d1f]">פרטי הרקע הלימודי שלך:</h3>

              {formData.path === "school" ? (
                <div className="space-y-4">
                  <div className="space-y-1">
                    <label className="text-xs font-black text-[#6e6e73]">מהי כיתת הלימוד שלך?</label>
                    <input
                      type="text"
                      value={formData.schoolGrade}
                      onChange={(e) =>
                        setFormData({ ...formData, schoolGrade: e.target.value })
                      }
                      placeholder="למשל: כיתה י' או כיתה יב'"
                      className={fieldClass}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-black text-[#6e6e73]">
                      רמת יחידות לימוד (אם רלוונטי)
                    </label>
                    <select
                      value={formData.schoolUnits}
                      onChange={(e) =>
                        setFormData({ ...formData, schoolUnits: e.target.value })
                      }
                      className={fieldClass}
                    >
                      <option value="">בחרו מספר יחידות</option>
                      <option value="3">3 יחידות לימוד</option>
                      <option value="4">4 יחידות לימוד</option>
                      <option value="5">5 יחידות לימוד</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-black text-[#6e6e73]">
                      מהו המקצוע המבוקש?
                    </label>
                    <input
                      type="text"
                      value={formData.schoolSubject}
                      onChange={(e) =>
                        setFormData({ ...formData, schoolSubject: e.target.value })
                      }
                      placeholder="למשל: מתמטיקה, פיזיקה, אנגלית"
                      className={fieldClass}
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-1">
                    <label className="text-xs font-black text-[#6e6e73]">מוסד הלימודים האקדמי</label>
                    <input
                      type="text"
                      value={formData.academicInstitution}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          academicInstitution: e.target.value,
                        })
                      }
                      placeholder="למשל: אוניברסיטת תל אביב, הטכניון"
                      className={fieldClass}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-black text-[#6e6e73]">מהו מסלול התואר שלך?</label>
                    <input
                      type="text"
                      value={formData.academicDegree}
                      onChange={(e) =>
                        setFormData({ ...formData, academicDegree: e.target.value })
                      }
                      placeholder="למשל: הנדסת מכונות, מדעי המחשב"
                      className={fieldClass}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-black text-[#6e6e73]">
                      שם הקורס הספציפי שבו נדרש חיזוק
                    </label>
                    <input
                      type="text"
                      value={formData.academicCourse}
                      onChange={(e) =>
                        setFormData({ ...formData, academicCourse: e.target.value })
                      }
                      placeholder="למשל: אינפי 1, אלגברה ליניארית"
                      className={fieldClass}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-6 animate-fadeIn text-start">
              <h3 className="text-xl font-black text-[#1d1d1f]">
                מהו האתגר המרכזי ויעד הלימודים שלך?
              </h3>

              <div className="space-y-2">
                <label className="text-xs font-black text-[#6e6e73]">
                  מהו החסם המרכזי שמונע ממך להצליח כרגע?
                </label>
                <select
                  value={formData.bottleneck}
                  onChange={(e) =>
                    setFormData({ ...formData, bottleneck: e.target.value })
                  }
                  className={fieldClass}
                >
                  <option value="">בחרו את החסם המרכזי</option>
                  <option value="gaps">פערי עבר קשים בבסיס של חומר הלימוד</option>
                  <option value="anxiety">
                    חרדת בחינות, לחץ מנטלי בלייב או &quot;בלקאאוט&quot; במבחן
                  </option>
                  <option value="discipline">
                    קושי בניהול זמן, חוסר משמעת עצמית או קושי בתרגול עצמאי
                  </option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-black text-[#6e6e73]">
                  מהי מסגרת הליווי המבוקשת?
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, goalType: "marathon" })}
                    className={`p-4 rounded-xl border text-start transition-all ${
                      formData.goalType === "marathon"
                        ? `${orangeOptionSelected} font-semibold`
                        : "border-orange-200 hover:border-orange-400"
                    }`}
                  >
                    <div className="text-xs font-black text-[#1d1d1f]">
                      מרתון ממוקד בטווח הקצר
                    </div>
                    <div className="text-[14px] text-[#6e6e73] mt-0.5">
                      הכנה אינטנסיבית לקראת מבחן קרוב.
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, goalType: "semester" })}
                    className={`p-4 rounded-xl border text-start transition-all ${
                      formData.goalType === "semester"
                        ? `${orangeOptionSelected} font-semibold`
                        : "border-orange-200 hover:border-orange-400"
                    }`}
                  >
                    <div className="text-xs font-black text-[#1d1d1f]">
                      ליווי סמסטריאלי / שנתי שוטף
                    </div>
                    <div className="text-[14px] text-[#6e6e73] mt-0.5">
                      סגירת פערים עקבית ובניית ביטחון ארוך טווח.
                    </div>
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-6 animate-fadeIn">
              <div className="space-y-1 text-center">
                <h3 className="text-xl font-black text-[#1d1d1f]">יצירת חשבון וסיום רישום</h3>
                <p className="text-sm text-[#6e6e73]">
                  הפרטים נשמרים ישירות לתיק התלמיד האישי שלך
                </p>
              </div>

              <button
                type="button"
                onClick={handleGoogle}
                disabled={loading}
                className={`w-full inline-flex items-center justify-center gap-3 rounded-xl py-3.5 px-6 text-sm ${orangeOutlineCta}`}
              >
                <GoogleIcon />
                המשך עם Google
              </button>

              <div className="flex items-center gap-3" role="separator">
                <span className="h-px flex-1 bg-neutral-200" />
                <span className="text-xs font-medium text-neutral-400">או</span>
                <span className="h-px flex-1 bg-neutral-200" />
              </div>

              <form onSubmit={handleSubmit} noValidate className="space-y-4 text-start">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label htmlFor="firstName" className={fieldLabel}>שם פרטי</label>
                    <input
                      id="firstName"
                      type="text"
                      autoComplete="given-name"
                      value={formData.firstName}
                      onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
                      className={orangeField}
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="lastName" className={fieldLabel}>שם משפחה</label>
                    <input
                      id="lastName"
                      type="text"
                      autoComplete="family-name"
                      value={formData.lastName}
                      onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
                      className={orangeField}
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label htmlFor="phone" className={fieldLabel}>מספר טלפון</label>
                  <input
                    id="phone"
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    dir="ltr"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    placeholder="050-1234567"
                    className={`${orangeField} text-right!`}
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="email" className={fieldLabel}>אימייל</label>
                  <input
                    id="email"
                    type="email"
                    autoComplete="email"
                    dir="ltr"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    className={`${orangeField} text-right!`}
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="password" className={fieldLabel}>סיסמה לכניסה</label>
                  <input
                    id="password"
                    type="password"
                    autoComplete="new-password"
                    value={formData.password}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    placeholder="לפחות 6 תווים"
                    className={orangeField}
                  />
                </div>

                <div className="space-y-3 pt-1">
                  <label className="flex items-start gap-3 text-sm text-neutral-700">
                    <input
                      type="checkbox"
                      checked={formData.acceptTerms}
                      onChange={(e) => setFormData({ ...formData, acceptTerms: e.target.checked })}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-orange-500"
                    />
                    אני מסכים/ה לתנאי השימוש ולמדיניות הפרטיות
                  </label>
                  <label className="flex items-start gap-3 text-sm text-neutral-700">
                    <input
                      type="checkbox"
                      checked={formData.whatsappUpdates}
                      onChange={(e) => setFormData({ ...formData, whatsappUpdates: e.target.checked })}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-orange-500"
                    />
                    אני מסכים/ה לקבל עדכונים בוואטסאפ
                  </label>
                </div>

                {submitError && (
                  <div className="bg-red-50 border border-red-200 text-red-700 text-xs font-bold p-3 rounded-xl">
                    {submitError}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className={`w-full ${orangeCta} py-3.5 px-6 rounded-xl text-center`}
                >
                  {loading ? "פותחים את החשבון..." : "סיום הרשמה וכניסה לחשבון ←"}
                </button>
              </form>
            </div>
          )}

          <div className="flex items-center justify-between pt-4 border-t border-neutral-200/80">
            {step > 1 ? (
              <button
                type="button"
                onClick={handlePrevStep}
                disabled={loading}
                className={`inline-flex items-center rounded-full ${orangeOutlineCta} text-xs py-2.5 px-4`}
              >
                חזור אחורה
                <BackArrow />
              </button>
            ) : (
              <div />
            )}

            {step < 4 && (
              <button
                type="button"
                onClick={handleNextStep}
                className={`inline-flex items-center rounded-full py-3 px-6 ${orangeCta} text-xs`}
              >
                <ForwardArrow />
                המשך לשלב הבא
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
