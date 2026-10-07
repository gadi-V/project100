import BrandMark, { BRAND_BLUE, BRAND_NAVY } from "./BrandMark";

type BrandWordmarkProps = {
  className?: string;
  /** Standalone logo: the triangle mark sits above "100". Leave off when the name appears inside a sentence. */
  withMark?: boolean;
};

export default function BrandWordmark({ className = "", withMark = false }: BrandWordmarkProps) {
  return (
    <span
      dir="ltr"
      className={`inline-flex items-end whitespace-nowrap font-black leading-none tracking-tight ${className}`}
    >
      <span style={{ color: BRAND_NAVY }}>PROJECT</span>
      <span className="inline-flex flex-col items-center" style={{ color: BRAND_BLUE }}>
        {withMark && <BrandMark className="-mb-[0.02em] w-[calc(1.15em-4px)]" />}
        100
      </span>
    </span>
  );
}
