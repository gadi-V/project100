type BrandLogoProps = {
  className?: string;
};

export default function BrandLogo({ className = "" }: BrandLogoProps) {
  return (
    <span
      dir="ltr"
      className={`inline-flex items-baseline whitespace-nowrap leading-none ${className}`}
    >
      <span className="font-extrabold tracking-tight text-[#0B1B3D]">PROJECT</span>
      <span className="font-black tracking-tight text-[#0070F3]">100</span>
    </span>
  );
}
