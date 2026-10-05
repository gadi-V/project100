import reviewsData from "../../lib/reviews.json";
import ReviewsCarousel, { type PublicReview } from "./ReviewsCarousel";

type StoredReview = PublicReview & { fullName: string };

/**
 * Server component: only the public fields reach the browser. `fullName` (the student's full surname)
 * stays on the server; the card shows `displayName` (first name + initial).
 */
export default function ReviewsSection() {
  const reviews: PublicReview[] = (reviewsData as StoredReview[]).map(
    ({ id, displayName, achievement, meta, text, imagePath }) => ({ id, displayName, achievement, meta, text, imagePath })
  );
  if (reviews.length === 0) return null;
  return <ReviewsCarousel reviews={reviews} />;
}
