/**
 * Give every student one notebook and point their lessons at it.
 * Dry-run unless `--apply` is passed.
 *
 * Usage: npx tsx scripts/backfill-notebooks.ts [--apply]
 */
import { prisma } from "../lib/prisma";
import { ensureNotebookForStudent } from "../lib/notebooks";

const apply = process.argv.includes("--apply");

async function main() {
  const [students, lessons, notebooks] = await Promise.all([
    prisma.user.findMany({ where: { role: "STUDENT" }, select: { id: true, name: true } }),
    prisma.lesson.findMany({ select: { id: true, studentId: true, notebookId: true } }),
    prisma.notebook.findMany({ select: { id: true, studentId: true } }),
  ]);

  const notebookByStudent = new Map(notebooks.map((row) => [row.studentId, row.id]));
  const studentIds = new Set<string>([
    ...students.map((student) => student.id),
    ...lessons.map((lesson) => lesson.studentId),
  ]);

  const missingNotebooks = [...studentIds].filter((id) => !notebookByStudent.has(id));
  const unlinkedLessons = lessons.filter((lesson) => lesson.notebookId !== notebookByStudent.get(lesson.studentId));

  console.log(
    `${apply ? "Applying" : "Dry run"}: ${missingNotebooks.length} notebook(s) to create, ${unlinkedLessons.length} lesson(s) to link.`,
  );
  for (const studentId of missingNotebooks) {
    const name = students.find((student) => student.id === studentId)?.name ?? studentId;
    console.log(`  notebook  ${name}`);
  }
  for (const lesson of unlinkedLessons) {
    console.log(`  lesson    ${lesson.id} -> student ${lesson.studentId}`);
  }

  if (!apply) {
    console.log("No rows written. Re-run with --apply to create notebooks and set lesson.notebookId.");
    return;
  }

  for (const studentId of studentIds) {
    const notebook = await ensureNotebookForStudent(studentId);
    notebookByStudent.set(studentId, notebook.id);
  }

  let linked = 0;
  for (const lesson of lessons) {
    const notebookId = notebookByStudent.get(lesson.studentId);
    if (!notebookId || lesson.notebookId === notebookId) continue;
    await prisma.lesson.update({ where: { id: lesson.id }, data: { notebookId } });
    linked += 1;
  }
  console.log(`Linked ${linked} lesson(s).`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "backfill failed");
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
