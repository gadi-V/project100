import Link from "next/link";
import { redirect } from "next/navigation";
import { getNotebookAccess } from "../../../lib/notebooks";
import { getCurrentUser } from "../../../lib/session";

const PAPER_LABELS: Record<string, string> = {
  grid: "משבצות",
  ruled: "שורות",
  dotted: "נקודות",
  blank: "חלק",
};

function formatCreatedAt(value: Date): string {
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

export default async function NotebookPage(props: {
  params: Promise<{ id: string }> | { id: string };
}) {
  const params = await Promise.resolve(props.params);
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?from=/notebook/${params.id}`);
  }

  const notebook = await getNotebookAccess(user, params.id);
  if (!notebook) {
    redirect("/dashboard");
  }

  return (
    <div className="min-h-[100dvh] bg-stone-50 text-neutral-900" dir="rtl">
      <header className="flex h-14 items-center justify-between border-b border-neutral-200 bg-white px-4 sm:px-6">
        <h1 className="text-lg font-bold">המחברת של {notebook.student.name}</h1>
        <Link href="/dashboard" className="text-sm font-semibold text-neutral-600 hover:text-neutral-900">
          חזרה
        </Link>
      </header>
      <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
        <p className="text-sm text-neutral-500">נפתחה ב־{formatCreatedAt(notebook.createdAt)}</p>
        {notebook.pages.length === 0 ? (
          <section className="mt-6 rounded-2xl border border-neutral-200 bg-white p-6">
            <h2 className="text-base font-bold">עדיין אין דפים במחברת</h2>
            <p className="mt-1 text-sm text-neutral-600">הדפים מהשיעורים יופיעו כאן.</p>
          </section>
        ) : (
          <ol className="mt-6 space-y-3">
            {notebook.pages.map((page) => {
              const paper = PAPER_LABELS[page.paperStyle];
              return (
                <li
                  key={page.id}
                  className="rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm font-medium"
                >
                  עמוד {page.pageIndex + 1}
                  {paper ? <span className="text-neutral-500"> · {paper}</span> : null}
                </li>
              );
            })}
          </ol>
        )}
      </main>
    </div>
  );
}
