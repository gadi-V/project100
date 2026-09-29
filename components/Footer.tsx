import BrandWordmark from "./BrandWordmark";

export default function Footer() {
  return (
    <footer className="border-t border-[#e5e5e7] bg-[#f5f5f7] text-[#6e6e73] py-12 text-xs font-semibold" dir="rtl">
      <div className="max-w-5xl mx-auto px-6 flex flex-col sm:flex-row justify-between items-center gap-4">
        <div>כל הזכויות שמורות לפלטפורמת <BrandWordmark /> © 2026</div>
        <div className="flex gap-6 text-[#6e6e73]">
          <a href="/#about" className="hover:text-[#0071e3] transition-colors">אודות</a>
          <a href="#" className="hover:text-[#0071e3] transition-colors">מדיניות פרטיות</a>
          <a href="#" className="hover:text-[#0071e3] transition-colors">הצהרת נגישות</a>
          <a href="/careers" className="hover:text-[#0071e3] transition-colors">הצטרפות לנבחרת ההוראה</a>
          <span className="font-mono text-slate-500">054-3424244</span>
        </div>
      </div>
    </footer>
  );
}
