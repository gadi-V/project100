import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/api-auth";
import { STAFF_PORTAL_ROLES } from "../../../../lib/auth/staff-roles";
import { listStudentDirectory } from "../../../../lib/student-directory";
import { parseStudentDirectoryQuery } from "../../../../lib/student-directory-shared";

export const dynamic = "force-dynamic";

/**
 * Staff student directory: free-text search, status and grade filters, 25 per page.
 * Identity comes from the session only; teachers get their own students only.
 */
export async function GET(request: Request) {
  const auth = await requireAuth([...STAFF_PORTAL_ROLES]);
  if (auth.error) return auth.error;

  const parsed = parseStudentDirectoryQuery(new URL(request.url).searchParams);
  if (!parsed.ok) {
    return NextResponse.json({ success: false, error: parsed.errors.join(" · ") }, { status: 400 });
  }

  try {
    const data = await listStudentDirectory(auth.user, parsed.data);
    return NextResponse.json({ success: true, data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error: unknown) {
    console.error("Student directory error:", error);
    return NextResponse.json({ success: false, error: "טעינת רשימת התלמידים נכשלה" }, { status: 500 });
  }
}
