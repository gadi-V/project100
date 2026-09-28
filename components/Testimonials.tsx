"use client";

import type { ReactNode } from "react";
import { frostCard } from "../lib/ui";
import BrandWordmark from "./BrandWordmark";

type Testimonial = {
  name: string;
  role: string;
  text: ReactNode;
  rating: number;
  avatar: string;
};

const TESTIMONIALS: Testimonial[] = [
  {
    name: "עדי לוי",
    role: "סטודנטית להנדסה, אוניברסיטת תל אביב",
    text: (
      <>
        הגעתי ל-<BrandWordmark /> שבוע לפני מבחן במועד ב&apos; בחדו&apos;&apos;א כשאני מיואשת לחלוטין. המורה עבר איתי על חומרי הלימוד בצורה שלא ראיתי באף הרצאה באוניברסיטה. פירקנו הכל לחלקים קטנים וסיימתי עם 92! שווה כל שקל.
      </>
    ),
    rating: 5,
    avatar: "ע"
  },
  {
    name: "רוני ואילן כהן",
    role: "הורים של תומר (תלמיד כיתה י' - 5 יחידות)",
    text: "תומר היה מתוסכל, הכיתה הייתה עמוסה והוא פשוט איבד את הביטחון. הליווי האישי כאן שינה לו את הגישה לחלוטין. הוא כבר לא מפחד מהמבחנים והציון האחרון שלו היה 95. המענה בוואטסאפ בין השיעורים הוא פשוט הצלת חיים.",
    rating: 5,
    avatar: "ר"
  },
  {
    name: "ניר גלעד",
    role: "סטודנט במכינה קדם-אקדמית",
    text: "היקף החומרים במכינה הלחיץ אותי בטירוף. כאן בנו לי תוכנית דינמית שהתעדכנה יחד עם קצב ההתקדמות שלי. בזכות מבחני הסימולציה והטיפים המנטליים הגעתי למבחן רגוע, בלי בלאקאאוטים. מומלץ בחום!",
    rating: 5,
    avatar: "נ"
  }
];

export default function Testimonials() {
  return (
    <section className="mb-28 border-t border-neutral-200/80 pt-16" id="testimonials" dir="rtl">
      <div className="text-center mb-12 space-y-3">
        <h2 className="text-3xl font-semibold tracking-tight text-neutral-900">
          כשהמספרים מסתדרים – הסטודנטים וההורים מדברים
        </h2>
        <p className="text-neutral-500 text-sm max-w-xl mx-auto">
          הצלחה היא לא מקרה, היא תוצאה של מעטפת נכונה. הנה כמה מהסיפורים של מי שלמדו איתנו הסמסטר:
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
        {TESTIMONIALS.map((item, index) => (
          <div
            key={index}
            className={`${frostCard} p-6 flex flex-col justify-between`}
          >
            <div>
              <div className="flex gap-1 mb-4 text-amber-500 text-sm justify-start">
                {Array.from({ length: item.rating }).map((_, i) => (
                  <span key={i}>★</span>
                ))}
              </div>
              <p className="text-neutral-600 text-sm leading-relaxed mb-6 text-start">
                &ldquo;{item.text}&rdquo;
              </p>
            </div>

            <div className="flex items-center gap-3 border-t border-neutral-200/80 pt-4">
              <div className="w-10 h-10 rounded-full bg-neutral-100 text-neutral-700 flex items-center justify-center text-sm font-semibold">
                {item.avatar}
              </div>
              <div className="text-start">
                <h4 className="font-semibold text-neutral-900 text-sm">{item.name}</h4>
                <p className="text-neutral-500 text-xs mt-0.5">{item.role}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
