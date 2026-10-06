"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ChevronLeft, ChevronRight } from "lucide-react";

export type PublicReview = {
  id: number;
  displayName: string;
  meta: string;
  text: string;
  imagePath: string;
};

const AUTOPLAY_MS = 5000;
const FADE_MS = 200;
const VISIBLE_DOTS = 5;
const AVATAR_SIZE = 110;
const LONG_REVIEW_CHARS = 220;
/** Same tone as the avatar ring, shown until the photo has loaded. */
const AVATAR_PLACEHOLDER =
  "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='110' height='110'%3E%3Crect width='110' height='110' fill='%23e2e8f0'/%3E%3C/svg%3E";

function dotWindow(activeIndex: number, total: number): number[] {
  const count = Math.min(VISIBLE_DOTS, total);
  const start = Math.min(Math.max(activeIndex - Math.floor(count / 2), 0), total - count);
  return Array.from({ length: count }, (_, i) => start + i);
}

function ReviewContent({ review, loadImage }: { review: PublicReview; loadImage: boolean }) {
  return (
    <>
      <div className="relative mb-7">
        <svg
          width="29"
          height="25"
          viewBox="0 0 54 44"
          fill="currentColor"
          aria-hidden="true"
          className="absolute top-7 -start-12 text-[#8C5A3C]"
        >
          <path d="M14 0L0 44h18L28 0H14zm26 0L26 44h18L54 0H40z" />
        </svg>
        <div
          className="pointer-events-none size-[110px] select-none overflow-hidden rounded-full bg-[#e2e8f0]"
          onContextMenu={(e) => e.preventDefault()}
        >
          {loadImage && (
            <Image
              key={review.id}
              src={review.imagePath}
              alt={review.displayName}
              width={AVATAR_SIZE}
              height={AVATAR_SIZE}
              sizes={`${AVATAR_SIZE}px`}
              loading="lazy"
              placeholder={AVATAR_PLACEHOLDER}
              draggable={false}
              className="block size-full object-cover"
            />
          )}
        </div>
      </div>

      <p
        className={`mb-6 font-medium leading-relaxed text-slate-800 ${
          review.text.length > LONG_REVIEW_CHARS ? "text-lg" : "text-xl"
        }`}
      >
        {review.text}
      </p>

      <p className="text-sm text-slate-600 md:text-base">
        <span className="inline-flex items-center gap-1 align-middle font-semibold text-slate-700">
          {review.displayName}
          <svg viewBox="0 0 24 24" className="size-[15px] fill-[#1890ff]" role="img" aria-label="משתמש מאומת">
            <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-1.9 14.7l-4.2-4.2 1.4-1.4 2.8 2.8 6.8-6.8 1.4 1.4-8.2 8.2z" />
          </svg>
        </span>
        <span className="align-middle">{` — ${review.meta}`}</span>
      </p>
    </>
  );
}

export default function ReviewsCarousel({ reviews }: { reviews: PublicReview[] }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [isFading, setIsFading] = useState(false);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingIndex = useRef<number | null>(null);
  const total = reviews.length;

  const goTo = useCallback(
    (index: number) => {
      const target = (index + total) % total;
      if (pendingIndex.current === null && target === activeIndex) return;
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
      pendingIndex.current = target;
      setIsFading(true);
      fadeTimer.current = setTimeout(() => {
        fadeTimer.current = null;
        pendingIndex.current = null;
        setActiveIndex(target);
        setIsFading(false);
      }, FADE_MS);
    },
    [activeIndex, total]
  );

  useEffect(() => {
    if (total < 2 || isPaused || isFading) return;
    const timer = setTimeout(() => goTo(activeIndex + 1), AUTOPLAY_MS);
    return () => clearTimeout(timer);
  }, [activeIndex, isPaused, isFading, total, goTo]);

  useEffect(
    () => () => {
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
    },
    []
  );

  if (total === 0) return null;

  const step = (delta: number) => goTo((pendingIndex.current ?? activeIndex) + delta);
  const nextIndex = (activeIndex + 1) % total;
  const arrowClass =
    "absolute top-1/2 z-10 flex size-10 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-[#94a3b8] opacity-0 transition-opacity duration-200 hover:text-[#1890ff] focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100";

  return (
    <section id="reviews" className="px-6 py-20" dir="rtl" aria-labelledby="reviews-heading">
      <h2 id="reviews-heading" className="mb-10 text-center text-3xl font-black tracking-tight text-[#1d1d1f] md:text-4xl">
        מה מספרים התלמידים שלנו
      </h2>
      <div
        className="group relative mx-auto max-w-[720px] px-4 sm:px-8"
        onMouseEnter={() => setIsPaused(true)}
        onMouseLeave={() => setIsPaused(false)}
      >
        <button type="button" onClick={() => step(-1)} aria-label="הביקורת הקודמת" className={`${arrowClass} start-0`}>
          <ChevronRight className="size-6" strokeWidth={1.75} />
        </button>
        <button type="button" onClick={() => step(1)} aria-label="הביקורת הבאה" className={`${arrowClass} end-0`}>
          <ChevronLeft className="size-6" strokeWidth={1.75} />
        </button>

        <div className="mx-auto grid max-w-[580px] px-8">
          {/* Never painted: sizes the cell to the tallest review so the page does not jump, and preloads the next photo. */}
          {reviews.map((review, index) => (
            <div
              key={review.id}
              aria-hidden="true"
              className="pointer-events-none invisible col-start-1 row-start-1 flex flex-col items-center text-center"
            >
              <ReviewContent review={review} loadImage={total > 1 && index === nextIndex} />
            </div>
          ))}
          <article
            aria-live="polite"
            className={`col-start-1 row-start-1 flex flex-col items-center text-center transition-opacity duration-200 ease-in-out motion-reduce:transition-none ${
              isFading ? "opacity-0" : "opacity-100"
            }`}
          >
            <ReviewContent review={reviews[activeIndex]} loadImage />
          </article>
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
