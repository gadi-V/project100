"use client";

import { useState } from "react";
import { STUDENT_TABS, type StudentPortalData, type StudentTabKey } from "../../../lib/student-portal-shared";
import ProfileTab from "./ProfileTab";
import CoursesTab from "./CoursesTab";
import MeetingsTab from "./MeetingsTab";
import CommunicationTab from "./CommunicationTab";
import StandingOrdersTab from "./StandingOrdersTab";

type StudentPortalTabsProps = {
  data: StudentPortalData;
  initialTab: StudentTabKey;
};

function tabClass(active: boolean): string {
  return active
    ? "bg-neutral-900 text-white rounded-full px-5 py-2 text-sm font-medium"
    : "text-neutral-600 hover:text-neutral-900 hover:bg-white/60 rounded-full px-5 py-2 text-sm font-medium transition-colors";
}

export default function StudentPortalTabs({ data, initialTab }: StudentPortalTabsProps) {
  const [activeTab, setActiveTab] = useState<StudentTabKey>(initialTab);

  const selectTab = (tab: StudentTabKey) => {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState(null, "", url.toString());
  };

  const courseTitles = Array.from(new Set(data.courses.filter((c) => c.kind === "COURSE").map((c) => c.title)));

  return (
    <div className="space-y-6">
      <nav
        role="tablist"
        aria-label="חוצצי תלמיד"
        className="liquid-glass rounded-full p-1.5 flex flex-wrap gap-1 w-fit"
      >
        {STUDENT_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            id={`tab-${tab.key}`}
            aria-selected={activeTab === tab.key}
            aria-controls={`panel-${tab.key}`}
            onClick={() => selectTab(tab.key)}
            className={tabClass(activeTab === tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {STUDENT_TABS.map((tab) => (
        <section
          key={tab.key}
          role="tabpanel"
          id={`panel-${tab.key}`}
          aria-labelledby={`tab-${tab.key}`}
          hidden={activeTab !== tab.key}
        >
          {tab.key === "profile" && (
            <ProfileTab studentId={data.header.id} profile={data.profile} viewer={data.viewer} />
          )}
          {tab.key === "courses" && <CoursesTab courses={data.courses} />}
          {tab.key === "meetings" && (
            <MeetingsTab
              studentId={data.header.id}
              meetings={data.meetings}
              canSchedule={data.viewer.canEditProfile}
            />
          )}
          {tab.key === "communication" && (
            <CommunicationTab
              studentId={data.header.id}
              entries={data.communication}
              viewerRole={data.viewer.role}
              courseTitles={courseTitles}
            />
          )}
          {tab.key === "standing-orders" && <StandingOrdersTab standingOrders={data.standingOrders} />}
        </section>
      ))}
    </div>
  );
}
