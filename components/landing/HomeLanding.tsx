"use client";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { toast } from "react-hot-toast";
import BenefitsBar from "./BenefitsBar";
import AboutSection from "./AboutSection";
import SubjectsMarquee from "./SubjectsMarquee";
import MethodFlipCards from "./MethodFlipCards";
import BrandWordmark from "../BrandWordmark";
import { orangeCta } from "../../lib/ui";

/** Interactive landing body; `reviews` is rendered on the server so review data stays out of this bundle. */
export default function HomeLanding({ reviews }: { reviews: ReactNode }) {
  const [activeFaq, setActiveFaq] = useState<number | null>(null);
  const [leadForm, setLeadForm] = useState({ name: "", phone: "", grade: "" });
  const [leadLoading, setLeadLoading] = useState(false);
  const [leadSent, setLeadSent] = useState(false);

  const toggleFaq = (index: number) => {
    setActiveFaq(activeFaq === index ? null : index);
  };

  const handleLeadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!leadForm.name.trim() || !leadForm.phone.trim()) {
      toast.error("שם וטלפון הם שדות חובה");
      return;
    }

    setLeadLoading(true);
    try {
      const response = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: leadForm.name.trim(),
          phone: leadForm.phone.trim(),
          grade: leadForm.grade.trim() || "לא צוין",
          notes: leadForm.grade.trim() || "פנייה מדף הנחיתה",
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "שליחת הפרטים נכשלה");
      setLeadSent(true);
      toast.success("הפרטים נקלטו! נחזור אליכם בהקדם");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה בשליחה");
    } finally {
      setLeadLoading(false);
    }
  };

  return (
    <div className="min-h-screen text-[#1d1d1f] font-sans antialiased" dir="rtl">
      
      {/* 1. חלק הגיבור (Hero Section) - כותרת עבה וממוקדת פלטפורמה */}
      <section id="hero" className="max-w-7xl mx-auto px-6 lg:px-10 pt-24 pb-16 grid grid-cols-1 md:grid-cols-12 gap-12 items-center">
        <div className="md:col-span-7 space-y-6 text-right">
          <span className="text-sm font-black tracking-widest text-[#0071e3] uppercase block">הסוף לחיפוש מורים</span>
          <h1 className="text-4xl sm:text-6xl">
            <BrandWordmark withMark />
          </h1>
          <h2 className="text-[18px] sm:text-[24px] font-bold text-[#6e6e73] tracking-tight leading-tight">
            פלטפורמת למידה מרחוק למקצועות וקורסים מתיכון ועד אקדמיה
          </h2>
          <div className="pt-4 flex flex-col sm:flex-row gap-4">
            <Link href="/register" className={`inline-block text-center ${orangeCta} text-xs py-3.5 px-8 rounded-full`}>
              הרשמה לפלטפורמה
            </Link>
            <Link href="/onboarding/diagnostic" className="inline-block text-center bg-white/50 backdrop-blur-md hover:bg-white/70 text-[#1d1d1f] font-black text-xs py-3.5 px-8 rounded-full transition-all border border-white/80">
              אבחון לתלמיד
            </Link>
          </div>
        </div>
        
        {/* מדיה ומכשיר אינטראקטיבי */}
        <div className="md:col-span-5 flex justify-center">
          <div className="w-[280px] aspect-[9/18] liquid-glass rounded-[48px] p-3 relative overflow-hidden">
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-36 h-4 bg-slate-200 rounded-b-2xl z-20" />
            <div className="w-full h-full rounded-[36px] overflow-hidden bg-slate-100">
              <video className="w-full h-full object-cover" src="https://haformula.co.il/wp-content/uploads/2026/02/תדמית-לדף-נחיתה-1-1-1.mp4" autoPlay loop muted playsInline />
            </div>
          </div>
        </div>
      </section>

      <BenefitsBar />

      {/* 2. גריד היתרונות הטכנולוגיים (Platform Capabilities Grid) */}
      {/* 2. גריד היתרונות הטכנולוגיים במבנה Bento של Apple */}
      <section id="challenge" className="py-24 border-t border-b border-[#e5e5e7]/70">
        <div className="max-w-7xl mx-auto px-6 lg:px-10 space-y-16">
          
          <div className="text-right space-y-3">
            <span className="text-xs font-black tracking-widest text-[#6e6e73] uppercase block">חוויית משתמש מבוקרת</span>
            <h2 className="text-4xl sm:text-5xl font-black text-[#1d1d1f] tracking-tight">הטכנולוגיה בשירות הפדגוגיה.</h2>
          </div>

          {/* ארכיטקטורת בנטו (Bento Layout) - שילוב טקסט ומדיה גבוהה */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-6 text-right">
            
            {/* קוביה 1: גדולה ומרכזית (רוחב 7 מתוך 12) - משלבת טקסט וצילום ממשק */}
            <div className="md:col-span-7 liquid-glass rounded-3xl overflow-hidden flex flex-col justify-between hover:shadow-md transition-all group">
              <div className="p-8 space-y-2">
                <span className="text-[14px] font-black text-[#0071e3] tracking-wider uppercase">קביעת שיעור בלייב</span>
                <h4 className="text-xl font-black text-[#1d1d1f]">גישה ישירה ללו&quot;ז המורה</h4>
                <p className="text-xs font-bold text-[#6e6e73] max-w-md leading-relaxed">
                  מערכת קביעת שיעורים עצמאית לחלוטין. רואים חלונות זמן פנויים, בוחרים קליק, ומשריינים מפגש בלייב
                </p>
              </div>
              <div className="px-8 bg-slate-50/60 border-t border-slate-100 aspect-[16/7] flex items-center justify-center overflow-hidden">
                <div className="w-full h-full bg-[#1d1d1f] rounded-t-xl mt-4 p-1.5 pb-0 shadow-2xl transition-transform group-hover:scale-[1.02] duration-300">
                  <video
                    className="w-full h-full rounded-t-lg object-cover object-top bg-white"
                    src="/videos/student-scheduling.webm?v=2"
                    poster="/videos/student-scheduling-poster.png?v=2"
                    aria-label="המחשה: בחירת שעה פנויה וקביעת שיעור בלוח השעות באזור האישי"
                    autoPlay
                    loop
                    muted
                    playsInline
                    preload="metadata"
                  />
                </div>
              </div>
            </div>

            {/* קוביה 2: צרה וגבוהה (רוחב 5 מתוך 12) - ממוקדת לו"ז */}
            <div className="md:col-span-5 liquid-glass rounded-3xl p-8 flex flex-col justify-between hover:shadow-md transition-all">
              <div className="space-y-2">
                <span className="text-[14px] font-black text-[#0071e3] tracking-wider uppercase">מגוון רחב של תחומים</span>
                <h4 className="text-xl font-black text-[#1d1d1f]">בגרות ואקדמיה תחת קורת גג אחת</h4>
                <p className="text-xs font-bold text-[#6e6e73] leading-relaxed">
                  מענה שלם לכל מקצועות הבגרות ולכל התארים האקדמיים. התמחות מיוחדת בעולמות ההנדסה והמדעים המדויקים, המותאמת לקצב ההבנה האישי שלך.
                </p>
              </div>
              <SubjectsMarquee className="mt-6 -mx-8" />

            </div>

            {/* קוביה 3: צרה (רוחב 5 מתוך 12) - קבוצות ווטסאפ */}
            <div className="md:col-span-5 liquid-glass rounded-3xl p-8 flex flex-col justify-between hover:shadow-md transition-all">
              <div className="space-y-2">
                <span className="text-[14px] font-black text-[#0071e3] tracking-wider uppercase">בקרת איכות עליונה</span>
                <h4 className="text-xl font-black text-[#1d1d1f]">קבוצות ווטסאפ משולשות</h4>
                <p className="text-xs font-bold text-[#6e6e73] leading-relaxed">
                  כל שיבוץ פותח אוטומטית ערוץ תקשורת מבוקר הכולל את המורה, ההורה או הסטודנט, ונציג מלווה קבוע מטעמנו כדי לוודא שאף אחד לא הולך לאיבוד.
                </p>
              </div>
              <div className="mt-4 flex gap-2 justify-end">
                <span className="bg-emerald-50 text-emerald-700 text-[13px] font-black py-1 px-3 rounded-full border border-emerald-200">צ'אט בקרה פעיל</span>
              </div>
            </div>

            {/* קוביה 4: רחבה (רוחב 7 מתוך 12) - ממוקדת בנבחרת המורים המנוסה */}
            <div className="md:col-span-7 liquid-glass rounded-3xl overflow-hidden flex flex-col justify-between hover:shadow-md transition-all group">
              <div className="p-8 space-y-2">
                <span className="text-[14px] font-black text-[#0071e3] tracking-wider uppercase">הון אנושי עילית</span>
                <h4 className="text-xl font-black text-[#1d1d1f]">כל המורים עברו תהליך הכשרה פדגוגי קשיח</h4>
                <p className="text-xs font-bold text-[#6e6e73] leading-relaxed">
                  אנחנו לא אינדקס פתוח לכל אחד. נבחרת המרצים שלנו מורכבת מאנשי מקצוע שעברו סינון קפדני בן 7 שלבים, מבחני מומחיות והסמכה מקיפה בארגון.
                </p>
              </div>
              {/* הדמיית צילום מקרו ברזולוציה גבוהה */}
              <div className="h-32 bg-slate-100/70 flex items-center justify-center text-slate-400 font-bold text-xs relative overflow-hidden">
                {/* כאן תבוא תמונת קלוז-אפ איכותית (למשל עט דיגיטלי כותב על מסך אייפד בתוכנת GoodNotes) */}
                <div className="absolute inset-0 bg-gradient-to-t from-slate-200/50 to-transparent" />
                <span className="z-10 text-[13px] text-slate-500 font-mono">// צילום מאקרו: כתיבה פדגוגית חכמה על טאבלט דיגיטלי</span>
              </div>
            </div>

          </div>

        </div>
      </section>

      {/* 3. שלושת מוקדי המומחיות + חשיפת הכרטיסיות האינטראקטיביות (Flip Cards) */}
      <section id="method" className="max-w-7xl mx-auto px-6 lg:px-10 py-24 space-y-16">
        <div className="text-right space-y-3">
          <span className="text-xs font-bold tracking-widest text-[#6e6e73] uppercase block">נבחרת המרצים</span>
          <h2 className="text-4xl font-black text-[#1d1d1f] tracking-tight">מורים בעלי תוצאות מוכחות בשטח</h2>
          <p className="text-xs font-bold text-[#6e6e73] max-w-xl">
            כל המורים בפלטפורמה עברו סינון קפדני והכשרה מעשית בהוראה 1-על-1. התאמה אישית לפי 5 נתיבי למידה ממוקדים: מסגירת פערים ועד להצטיינות.
          </p>
        </div>

        {/* חמשת הכרטיסים האינטראקטיביים המשקפים שקיפות ומבנה כרטיסיות */}
        <MethodFlipCards />

      </section>

      {/* 3b. מחירון / כרטיסיות — scroll target for nav + ambient violet/gold */}
      <section id="pricing" className="max-w-7xl mx-auto px-6 lg:px-10 py-24 min-h-[70vh] flex flex-col justify-center space-y-6">
        <div className="text-center space-y-3">
          <span className="text-xs font-black tracking-widest text-[#6e6e73] uppercase block">מחירון שקוף</span>
          <h2 className="text-3xl sm:text-4xl font-black text-[#1d1d1f] tracking-tight">כרטיסיית מפגשים. בלי אותיות קטנות.</h2>
          <p className="text-xs font-bold text-[#6e6e73] max-w-xl mx-auto leading-relaxed">
            רכישת החבילות מתבצעת ככרטיסיית מפגשים דיגיטלית שקופה. ניכוי שעות מבוצע אך ורק לאחר קיום המפגש בפועל.
            <span className="text-[#0071e3] block sm:inline sm:ms-1 font-black">קיימות אופציות ומסלולי ליווי מורחבים בהתאמה אישית.</span>
          </p>
          <div className="pt-2">
            <Link
              href="/pricing"
              className="inline-block text-center bg-[#1d1d1f] hover:bg-[#2d2d2f] text-white font-black text-xs py-3 px-8 rounded-full transition-all shadow-md"
            >
              למחירון המלא
            </Link>
          </div>
        </div>
      </section>

      {reviews}

      <AboutSection />

      {/* 4. שאלות נפוצות (FAQ) - מעודכן לשאלות שקיפות וכרטיסיות */}
      <section id="faq" className="py-24 border-t border-b border-[#e5e5e7]/70">
        <div className="max-w-3xl mx-auto px-6 space-y-12">
          <h2 className="text-3xl font-black text-[#1d1d1f] tracking-tight text-center">נעים להכיר, בגובה העיניים</h2>
          
          <div className="border-t border-slate-300 divide-y divide-slate-300">
            {[
              { q: "כיצד המערכת מתאימה לי את המורה?", a: "מנוע האבחון הדינמי שלנו משקלל את המקצוע או הקורס האקדמי הספציפי, רמת הלימוד, סוג הקושי (פערי עבר, חרדת בחינות) והשעות הפנויות שלך, ומציג לך את המורים המנוסים והרלוונטיים ביותר שעונים על הדרישה המדויקת הזו." },
              { q: "איך עובד מנגנון החיוב והכרטיסיות?", a: "הכול שקוף ומנוהל באזור האישי. אתם בוחרים כרטיסיית מפגשים מוגדרת מראש. השעות נשארות בחשבון שלכם ואינן פוקעות, וניכוי השיעור מתבצע מתוך הכרטיסייה אך ורק לאחר שהמפגש התקיים בפועל במערכת." },
              { q: "האם אני יכול להחליף מורה במהלך הדרך?", a: "בוודאי. הפלטפורמה מעניקה חופש בחירה מוחלט. אם אתם מרגישים צורך לרענן, לעבור למורה אחר או לשלב מורה נוסף לקורס אחר – אתם חופשיים לעשות זאת ישירות מתוך המערכת על בסיס זמינות הלו\"ז שלו, ללא בירוקרטיה." }
            ].map((item, idx) => (
              <div key={idx} className="py-5">
                <button onClick={() => toggleFaq(idx)} className="w-full flex justify-between items-center text-right text-sm font-black text-[#1d1d1f] hover:text-[#0071e3] transition-colors focus:outline-none">
                  <span>{item.q}</span>
                  <span className={`text-[#0071e3] font-bold text-xl transition-transform duration-200 ${activeFaq === idx ? "rotate-45" : ""}`}>+</span>
                </button>
                <div className={`overflow-hidden transition-all duration-300 text-xs font-bold text-[#6e6e73] leading-relaxed ${activeFaq === idx ? "max-h-32 mt-3" : "max-h-0"}`}>
                  {item.a}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 5. טופס פרימיום מהיר להשארת פרטים */}
      <section id="contact" className="max-w-md mx-auto px-6 py-24">
        <div className="liquid-glass p-8 rounded-3xl space-y-6">
          <div className="text-center space-y-2">
            <h3 className="text-2xl font-black text-[#1d1d1f] tracking-tight">מתחילים לשפר את הציונים</h3>
            <p className="text-xs font-bold text-[#6e6e73]">השאירו פרטים ונציג לימודי יחזור אליכם להתאמה מיידית.</p>
          </div>
          
          {leadSent ? (
            <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-center text-xs font-bold p-4 rounded-xl">
              הפרטים נקלטו בהצלחה. נציג לימודי יחזור אליכם בקרוב.
            </div>
          ) : (
            <form className="space-y-4" onSubmit={handleLeadSubmit}>
              <input
                type="text"
                required
                value={leadForm.name}
                onChange={(e) => setLeadForm({ ...leadForm, name: e.target.value })}
                placeholder="שם מלא"
                className="w-full bg-[#f5f5f7]/90 border border-slate-200 rounded-xl p-3.5 text-xs font-bold text-[#1d1d1f] focus:bg-white focus:border-blue-500 focus:outline-none transition-all"
              />
              <input
                type="tel"
                required
                value={leadForm.phone}
                onChange={(e) => setLeadForm({ ...leadForm, phone: e.target.value })}
                placeholder="מספר טלפון"
                className="w-full bg-[#f5f5f7]/90 border border-slate-200 rounded-xl p-3.5 text-xs font-bold text-[#1d1d1f] focus:bg-white focus:border-blue-500 focus:outline-none text-right"
              />
              <input
                type="text"
                value={leadForm.grade}
                onChange={(e) => setLeadForm({ ...leadForm, grade: e.target.value })}
                placeholder="מה המקצוע או הקורס שבו נדרש עזרה?"
                className="w-full bg-[#f5f5f7]/90 border border-slate-200 rounded-xl p-3.5 text-xs font-bold text-[#1d1d1f] focus:bg-white focus:border-blue-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={leadLoading}
                className={`w-full ${orangeCta} py-3.5 rounded-xl text-xs`}
              >
                {leadLoading ? "שולח..." : "שליחת פרטים להתאמה קבועה"}
              </button>
            </form>
          )}
        </div>
      </section>

    </div>
  );
}
