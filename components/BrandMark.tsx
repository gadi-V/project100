type BrandMarkProps = {
  className?: string;
};

export const BRAND_NAVY = "#13204F";
export const BRAND_BLUE = "#157EFB";

export default function BrandMark({ className = "" }: BrandMarkProps) {
  return (
    <svg
      viewBox="17 3 51 26"
      fill="none"
      strokeWidth="2.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M21 14C23 10 26 9 30 9c5 0 8 4 12 9s8 8 13 8c6 0 9.5-4.5 9-11" stroke={BRAND_BLUE} />
      <path d="M21 14c-2 6 1 12 8 12 6 0 9-4 13-8s7-8 13-8h6.5M57.5 6l4 4-4.5 3.5" stroke={BRAND_NAVY} />
    </svg>
  );
}
