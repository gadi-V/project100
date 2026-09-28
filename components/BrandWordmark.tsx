type BrandWordmarkProps = {
  className?: string;
};

export default function BrandWordmark({ className = "" }: BrandWordmarkProps) {
  return (
    <span
      dir="ltr"
      className={`inline-block whitespace-nowrap font-black tracking-tight ${className}`}
    >
      <span className="text-[0.9em] text-blue-950">PROJECT</span>
      <span className="text-[#3987ec]">100</span>
    </span>
  );
}
