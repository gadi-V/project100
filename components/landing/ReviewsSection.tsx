import reviewsData from "../../lib/reviews.json";
import ReviewsCarousel, { type PublicReview } from "./ReviewsCarousel";

type StoredReview = PublicReview & { fullName: string; achievement: string };

/** Stored as "field | institution"; the author line reads "field, institution". */
export function formatReviewMeta(meta: string): string {
  return meta
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");
}

/**
 * Server component: only the public fields reach the browser. `fullName` (the student's full surname)
 * stays on the server; the card shows `displayName` (first name + initial). `achievement` is not sent
 * because the grade already appears in the review text.
 */
export default function ReviewsSection() {
  const reviews: PublicReview[] = (reviewsData as StoredReview[]).map(({ id, displayName, meta, text, imagePath }) => ({
    id,
    displayName,
    meta: formatReviewMeta(meta),
    text,
    imagePath,
  }));
  if (reviews.length === 0) return null;
  return <ReviewsCarousel reviews={reviews} />;
}
