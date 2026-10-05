import HomeLanding from "../components/landing/HomeLanding";
import ReviewsSection from "../components/landing/ReviewsSection";

export default function HomePage() {
  return <HomeLanding reviews={<ReviewsSection />} />;
}
