import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * Mapping-call queue for the staff portal. A lead or student is pending until it has at least
 * one IntakeAssessment. Students count only while they are new (registered in the last 30 days).
 */

export const NEW_STUDENT_WINDOW_DAYS = 30;
const QUEUE_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

export type IntakeCandidateKind = "LEAD" | "STUDENT";

export type IntakeCandidate = {
  kind: IntakeCandidateKind;
  id: string;
  name: string;
  phone: string;
  /** ISO timestamp of the lead / registration. */
  createdAt: string;
  /** Requested subject for a lead, class track for a student. */
  detail: string | null;
};

export type RecentIntake = {
  id: string;
  kind: IntakeCandidateKind;
  personName: string;
  grade: string;
  weakTopic: string;
  representativeName: string | null;
  createdAt: string;
};

export type PendingIntakeCounts = { leads: number; students: number; total: number };

const pendingLeadWhere: Prisma.FallbackLeadWhereInput = {
  isHandled: false,
  intakeAssessments: { none: {} },
};

function pendingStudentWhere(now: Date): Prisma.UserWhereInput {
  return {
    role: "STUDENT",
    createdAt: { gte: new Date(now.getTime() - NEW_STUDENT_WINDOW_DAYS * DAY_MS) },
    intakeAssessments: { none: {} },
  };
}

type LeadRow = { id: string; name: string; phone: string; grade: string; createdAt: Date };
type StudentRow = { id: string; name: string; phone: string; classTrack: string | null; createdAt: Date };

const leadSelect = { id: true, name: true, phone: true, grade: true, createdAt: true } as const;
const studentSelect = { id: true, name: true, phone: true, classTrack: true, createdAt: true } as const;

function fromLead(lead: LeadRow): IntakeCandidate {
  return {
    kind: "LEAD",
    id: lead.id,
    name: lead.name,
    phone: lead.phone,
    createdAt: lead.createdAt.toISOString(),
    detail: lead.grade && lead.grade !== "לא צוין" ? lead.grade : null,
  };
}

function fromStudent(student: StudentRow): IntakeCandidate {
  return {
    kind: "STUDENT",
    id: student.id,
    name: student.name,
    phone: student.phone,
    createdAt: student.createdAt.toISOString(),
    detail: student.classTrack,
  };
}

export async function countPendingIntakes(now = new Date()): Promise<PendingIntakeCounts> {
  const [leads, students] = await Promise.all([
    prisma.fallbackLead.count({ where: pendingLeadWhere }),
    prisma.user.count({ where: pendingStudentWhere(now) }),
  ]);
  return { leads, students, total: leads + students };
}

/** Pending leads and new students, newest first. */
export async function getPendingIntakeCandidates(now = new Date()): Promise<IntakeCandidate[]> {
  const [leads, students] = await Promise.all([
    prisma.fallbackLead.findMany({
      where: pendingLeadWhere,
      orderBy: { createdAt: "desc" },
      take: QUEUE_LIMIT,
      select: leadSelect,
    }),
    prisma.user.findMany({
      where: pendingStudentWhere(now),
      orderBy: { createdAt: "desc" },
      take: QUEUE_LIMIT,
      select: studentSelect,
    }),
  ]);

  return [...leads.map(fromLead), ...students.map(fromStudent)].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
}

/** A single lead or student, pending or not (used for `?leadId=` / `?studentId=` deep links). */
export async function getIntakeCandidate(
  kind: IntakeCandidateKind,
  id: string
): Promise<IntakeCandidate | null> {
  if (kind === "LEAD") {
    const lead = await prisma.fallbackLead.findUnique({ where: { id }, select: leadSelect });
    return lead ? fromLead(lead) : null;
  }
  const student = await prisma.user.findFirst({
    where: { id, role: "STUDENT" },
    select: studentSelect,
  });
  return student ? fromStudent(student) : null;
}

export async function getRecentIntakes(limit = 10): Promise<RecentIntake[]> {
  const rows = await prisma.intakeAssessment.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      grade: true,
      weakTopic: true,
      createdAt: true,
      student: { select: { name: true } },
      fallbackLead: { select: { name: true } },
      representative: { select: { name: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    kind: row.student ? "STUDENT" : "LEAD",
    personName: row.student?.name ?? row.fallbackLead?.name ?? "ללא שם",
    grade: row.grade,
    weakTopic: row.weakTopic,
    representativeName: row.representative?.name ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}
