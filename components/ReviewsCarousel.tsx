"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { ChevronLeft, ChevronRight } from "lucide-react";
import reviewsData from "@/lib/reviews.json";

type Review = {
  id: number;
  fullName: string;
  displayName: string;
  achievement: string;
  meta: string;
  text: string;
  imagePath: string;
};

const REVIEWS: Review[] = reviewsData;
const AUTOPLAY_MS = 5000;
const VISIBLE_DOTS = 5;

function dotWindow(activeIndex: number, total: number): number[] {
  const count = Math.min(VISIBLE_DOTS, total);
  const start = Math.min(Math.max(activeIndex - Math.floor(count / 2), 0), total - count);
  return Array.from({ length: count }, (_, i) => start + i);
}

export default function ReviewsCarousel() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const total = REVIEWS.length;

  useEffect(() => {
    if (total < 2 || isPaused) return;
    const timer = setTimeout(() => {
      setActiveIndex((current) => (current + 1) % total);
    }, AUTOPLAY_MS);
    return () => clearTimeout(timer);
  }, [activeIndex, isPaused, total]);

  if (total === 0) return null;

  const goTo = (index: number) => setActiveIndex((index + total) % total);
  const arrowClass =
    "absolute top-1/2 z-10 flex size-10 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-[#94a3b8] opacity-0 transition-opacity duration-200 hover:text-[#1890ff] focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100";

  return (
    <section id="reviews" className="px-6 py-20" dir="rtl" aria-label="ביקורות סטודנטים מאומתות">
      <div
        className="group relative mx-auto max-w-[680px]"
        onMouseEnter={() => setIsPaused(true)}
        onMouseLeave={() => setIsPaused(false)}
      >
        <button type="button" onClick={() => goTo(activeIndex - 1)} aria-label="הביקורת הקודמת" className={`${arrowClass} start-0`}>
          <ChevronRight className="size-6" strokeWidth={1.75} />
        </button>
        <button type="button" onClick={() => goTo(activeIndex + 1)} aria-label="הביקורת הבאה" className={`${arrowClass} end-0`}>
          <ChevronLeft className="size-6" strokeWidth={1.75} />
        </button>

        <div className="mx-auto grid max-w-[580px] px-8" aria-live="polite">
          {REVIEWS.map((review, index) => {
            const isActive = index === activeIndex;
            const shouldLoadImage = isActive || index === (activeIndex + 1) % total;
            return (
              <article
                key={review.id}
                aria-hidden={!isActive}
                className={`col-start-1 row-start-1 flex flex-col items-center text-center transition-opacity duration-500 ease-in-out ${
                  isActive ? "opacity-100" : "pointer-events-none invisible opacity-0"
                }`}
              >
                <div className="relative mb-7">
                  <svg
                    width="48"
                    height="42"
                    viewBox="0 0 54 44"
                    fill="#1890ff"
                    aria-hidden="true"
                    className="absolute top-0 -start-16"
                  >
                    <path d="M14 0L0 44h18L28 0H14zm26 0L26 44h18L54 0H40z" />
                  </svg>
                  <div
                    className="pointer-events-none size-[110px] select-none overflow-hidden rounded-full bg-[#e2e8f0]"
                    onContextMenu={(e) => e.preventDefault()}
                  >
                    {shouldLoadImage && (
                      <Image
                        src={review.imagePath}
                        alt={review.displayName}
                        width={110}
                        height={110}
                        draggable={false}
                        className="block size-full object-cover"
                      />
                    )}
                  </div>
                </div>

                <p className="mb-6 text-[1.2rem] font-medium leading-[1.6] text-[#1e293b]">{review.text}</p>

                <p className="text-[0.95rem] text-[#334155]">
                  <span className="inline-flex items-center gap-1 align-middle font-bold">
                    {review.displayName}
                    <svg viewBox="0 0 24 24" className="size-[15px] fill-[#1890ff]" role="img" aria-label="משתמש מאומת">
                      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-1.9 14.7l-4.2-4.2 1.4-1.4 2.8 2.8 6.8-6.8 1.4 1.4-8.2 8.2z" />
                    </svg>
                  </span>
                  <span className="align-middle">
                    {" – "}
                    {review.achievement ? `${review.achievement}, ${review.meta}` : review.meta}
                  </span>
                </p>
              </article>
            );
          })}
        </div>

        {total > 1 && (
          <div className="mt-8 flex items-center justify-center gap-2">
            {dotWindow(activeIndex, total).map((index) => {
              const isActive = index === activeIndex;
              return (
                <button
                  key={index}
                  type="button"
                  onClick={() => goTo(index)}
                  aria-label={`ביקורת ${index + 1} מתוך ${total}`}
                  aria-current={isActive ? "true" : undefined}
                  className={`h-2 cursor-pointer rounded-full transition-all duration-300 ${
                    isActive ? "w-6 bg-[#1890ff]" : "w-2 bg-[#cbd5e1] hover:bg-[#94a3b8]"
                  }`}
                />
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
