"use client";

import { useState } from "react";
import Image from "next/image";
import { Pointer } from "lucide-react";

type MethodCard = {
  id: string;
  step: string;
  title: string;
  desc: string;
  /** Portrait photo, bottom-anchored on the title so the top crops first on wider cards. */
  image?: { src: string };
};

const METHOD_CARDS: readonly MethodCard[] = [
  {
    id: "gaps",
    step: "A",
    title: "סגירת פערים",
    desc: "איתור חורים לימודיים ופערי עבר מהיסוד, ובניית הבסיס הפדגוגי הדרוש להתקדמות.",
    image: { src: "/images/method/closing-gaps-tall.jpg" },
  },
  {
    id: "exam-prep",
    step: "B",
    title: "הכנה למבחנים",
    desc: "מרתונים ממוקדים, פתרון מבחני עבר וטקטיקות עבודה ייעודיות להעלאת הציון בטווח קצר.",
    image: { src: "/images/method/exam-prep-tall.jpg" },
  },
  {
    id: "ongoing",
    step: "C",
    title: "ליווי שוטף",
    desc: "ליווי עקבי לאורך כל הסמסטר או שנת הלימודים לשמירה על יציבות, משמעת עצמית והבנה עמוקה.",
    image: { src: "/images/method/ongoing-support-tall.jpg" },
  },
  { id: "punch-card", step: "D", title: "מערכת כרטיסיות", desc: "שקיפות מלאה. טוענים חבילת מפגשים מוגדרת (1, 3 או 5 שיעורים). אין התחייבויות ארוכות טווח או קנסות." },
  { id: "free-choice", step: "E", title: "חופש בחירה", desc: "המערכת מאפשרת לכם להישאר עם המורה שלכם או להחליף למרצה אחר בנבחרת בכל רגע, בהתאם לזמינות הלוז." },
];

type MethodFlipCardsProps = {
  className?: string;
};

export default function MethodFlipCards({ className = "" }: MethodFlipCardsProps) {
  const [flippedIndex, setFlippedIndex] = useState<number | null>(null);

  const toggleCard = (index: number): void => {
    setFlippedIndex((current) => (current === index ? null : index));
  };

  // Tailwind v4 scopes `group-hover:` to `@media (hover: hover)`, so on touch screens only the tap state flips.
  return (
    <ul
      className={`-mx-6 flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-px-6 px-6 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:mx-0 lg:grid lg:grid-cols-5 lg:overflow-visible lg:p-0 ${className}`}
    >
      {METHOD_CARDS.map((item, idx) => {
        const isFlipped = flippedIndex === idx;
        return (
          <li key={item.id} className="w-[72%] shrink-0 snap-start sm:w-[42%] md:w-[31%] lg:w-auto">
            <button
              type="button"
              aria-pressed={isFlipped}
              onClick={() => toggleCard(idx)}
              className="group block h-72 w-full cursor-pointer touch-manipulation rounded-2xl text-start perspective-[1000px] [-webkit-tap-highlight-color:transparent] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#0071e3]"
            >
              <span
                className={`relative block h-full w-full rounded-2xl shadow-sm transition-[transform,box-shadow] duration-500 transform-3d motion-reduce:transition-none group-hover:rotate-y-180 group-hover:shadow-md group-focus-visible:rotate-y-180 ${isFlipped ? "[@media(hover:none)]:rotate-y-180" : ""}`}
              >
                <span
                  className={`liquid-glass absolute inset-0 flex h-full w-full flex-col justify-between overflow-hidden rounded-2xl backface-hidden ${
                    item.image ? "" : "p-6"
                  }`}
                >
                  {item.image ? (
                    <span className="relative block min-h-0 flex-1">
                      <Image
                        src={item.image.src}
                        alt=""
                        aria-hidden="true"
                        fill
                        sizes="(min-width: 1024px) 20vw, (min-width: 768px) 31vw, (min-width: 640px) 42vw, 72vw"
                        className="object-cover object-bottom"
                      />
                      <span
                        aria-hidden="true"
                        className="absolute inset-x-0 top-0 h-1/3 bg-gradient-to-b from-black/20 to-transparent"
                      />
                      <span className="absolute top-6 start-6 font-mono text-5xl font-black text-white drop-shadow-[0_1px_6px_rgba(0,0,0,0.25)]">
                        {item.step}
                      </span>
                    </span>
                  ) : (
                    <span className="block font-mono text-5xl font-black text-[#e5e5e7]">{item.step}</span>
                  )}
                  <span className={`block space-y-2 ${item.image ? "px-6 pb-6 pt-3" : ""}`}>
                    <span className="block text-sm font-extrabold leading-snug text-[#1d1d1f]">{item.title}</span>
                    <span
                      aria-hidden="true"
                      className="hidden items-center gap-1 text-[14px] font-bold text-[#6e6e73] [@media(hover:none)]:flex"
                    >
                      <Pointer className="h-3.5 w-3.5" strokeWidth={2} />
                      לחצו לפרטים
                    </span>
                  </span>
                </span>

                <span className="absolute inset-0 flex h-full w-full rotate-y-180 flex-col justify-center rounded-2xl bg-[#1d1d1f] p-6 backface-hidden">
                  <span className="block text-xs font-bold leading-relaxed text-[#f5f5f7]">{item.desc}</span>
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
