"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { VettingStatus } from "@prisma/client";
import {
  pageCanvas,
  frostCard,
  frostPanel,
  primaryCta,
  secondaryCta,
  fieldClass,
  badgeSuccess,
  badgeWarning,
  badgeDanger,
  emptyState,
  eyebrow,
} from "../../../lib/ui";

interface TeacherItem {
  id: string;
  userId: string;
  name: string;
  email: string;
  phone: string;
  vettingStatus: VettingStatus;
  vettingStage: string | null;
  payoutType: string;
  isApproved: boolean;
  passedStepsCount: number;
  totalSteps: number;
  createdAt: string;
}

const TABS: { id: string; label: string; status?: VettingStatus }[] = [
  { id: "ALL", label: "All teachers and candidates" },
  { id: "PENDING", label: "Pending screening", status: VettingStatus.PENDING },
  { id: "IN_PROGRESS", label: "In screening", status: VettingStatus.IN_PROGRESS },
  { id: "APPROVED", label: "Approved and active", status: VettingStatus.APPROVED },
  { id: "REJECTED", label: "Rejected", status: VettingStatus.REJECTED },
];

export default function AdminTeachersListPage() {
  const [teachers, setTeachers] = useState<TeacherItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTab, setSelectedTab] = useState("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fetchTeachers = async () => {
    try {
      setLoading(true);
      setErrorMsg(null);
      const activeTab = TABS.find((t) => t.id === selectedTab);
      const params = new URLSearchParams();

      if (activeTab?.status) params.set("status", activeTab.status);
      if (searchQuery.trim()) params.set("q", searchQuery.trim());

      const res = await fetch(`/api/admin/teachers?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load teachers");
      const data = await res.json();
      setTeachers(data.teachers || []);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTeachers();
  }, [selectedTab]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetchTeachers();
  };

  const statusBadge = (status: VettingStatus) => {
    if (status === VettingStatus.APPROVED) return badgeSuccess;
    if (status === VettingStatus.REJECTED) return badgeDanger;
    return badgeWarning;
  };

  return (
    <div className={`${pageCanvas} p-8`} dir="rtl">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className={eyebrow}>Admin · Teachers</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-neutral-900">
              Teacher vetting queue
            </h1>
            <p className="mt-1 text-xs text-neutral-500">
              Manage candidates, track the 6 pedagogical screening steps, and approve teaching
              profiles.
            </p>
          </div>
          <form onSubmit={handleSearchSubmit} className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Search by name, email, or phone..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={`${fieldClass} w-64`}
            />
            <button type="submit" className={primaryCta}>
              Search
            </button>
          </form>
        </div>

        <div className={`${frostPanel} flex flex-wrap gap-2 p-2`}>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSelectedTab(tab.id)}
              className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
                selectedTab === tab.id
                  ? "bg-neutral-900 text-white"
                  : "bg-white text-neutral-600 border border-neutral-200 hover:bg-neutral-50"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className={`${frostCard} overflow-hidden`}>
          {loading ? (
            <div className="py-12 text-center text-sm text-neutral-500">Loading...</div>
          ) : errorMsg ? (
            <div className="py-12 text-center text-sm text-red-700">{errorMsg}</div>
          ) : teachers.length === 0 ? (
            <div className={`${emptyState} m-6`}>
              <p className="text-sm text-neutral-600">No teachers in this view</p>
              <Link href="/admin" className={`inline-flex ${secondaryCta}`}>
                Back to admin
              </Link>
            </div>
          ) : (
            <table className="w-full text-start text-xs">
              <thead className="border-b border-neutral-100 bg-neutral-50/80 text-neutral-500">
                <tr>
                  <th className="px-5 py-4 font-medium">Teacher</th>
                  <th className="px-5 py-4 font-medium">Contact</th>
                  <th className="px-5 py-4 font-medium">Screening progress</th>
                  <th className="px-5 py-4 font-medium">Funnel status</th>
                  <th className="px-5 py-4 font-medium">Payout</th>
                  <th className="px-5 py-4 font-medium">Submitted</th>
                  <th className="px-5 py-4 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {teachers.map((teacher) => (
                  <tr
                    key={teacher.id}
                    className="border-b border-neutral-100 last:border-b-0 hover:bg-neutral-50/80 transition-colors"
                  >
                    <td className="px-5 py-4 font-medium text-neutral-900">{teacher.name}</td>
                    <td className="px-5 py-4 text-neutral-600 space-y-0.5">
                      <div>{teacher.email}</div>
                      <div className="text-[14px] text-neutral-400" dir="ltr">
                        {teacher.phone}
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-20 overflow-hidden rounded-full bg-neutral-100 border border-neutral-200">
                          <div
                            className="h-full bg-neutral-900 transition-all duration-300"
                            style={{
                              width: `${(teacher.passedStepsCount / teacher.totalSteps) * 100}%`,
                            }}
                          />
                        </div>
                        <span className="text-[14px] font-medium text-neutral-700">
                          {teacher.passedStepsCount}/{teacher.totalSteps}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <span className={statusBadge(teacher.vettingStatus)}>
                        {teacher.vettingStatus}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-neutral-600">{teacher.payoutType}</td>
                    <td className="px-5 py-4 text-neutral-500 text-[14px]">
                      {new Date(teacher.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-5 py-4">
                      <Link
                        href={`/admin/teachers/${teacher.id}/vetting`}
                        className={secondaryCta}
                      >
                        Manage screening
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
