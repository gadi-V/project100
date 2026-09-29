import "./globals.css";
import type { Metadata } from "next";
import { Toaster } from "react-hot-toast";
import AmbientCanvas from "../components/AmbientCanvas";
import AppShell from "../components/AppShell";

export const metadata: Metadata = {
  title: "PROJECT100 - פלטפורמת למידה",
  description:
    "פלטפורמת השיעורים הפרטיים האקדמית של ישראל. הוראה מותאמת אישית 1-על-1, אבחון פערי הבנה ותרגול ממוקד להצלחה במבחנים.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="he" dir="rtl" data-scroll-behavior="smooth">
      <body className="min-h-screen text-neutral-900 antialiased font-sans flex flex-col">
        {/* Scroll-aware ambient mesh — colors shift with landing sections */}
        <AmbientCanvas />

        <div className="relative z-10 flex flex-col flex-grow min-h-screen">
          <Toaster
            position="top-center"
            toastOptions={{
              style: {
                background: "#ffffff",
                color: "#1d1d1f",
                border: "1px solid #e5e5e7",
                fontSize: "17px",
                borderRadius: "12px",
                padding: "12px 24px",
                boxShadow: "0 4px 12px rgba(0,0,0,0.05)",
              },
            }}
          />

          <AppShell>{children}</AppShell>
        </div>
      </body>
    </html>
  );
}
