type AboutEntry = {
  id: string;
  title: string;
  body: string;
};

const ABOUT_ENTRIES: readonly AboutEntry[] = [
  {
    id: "platform",
    title: "על הפלטפורמה",
    body: "הפלטפורמה המובילה בישראל להוראה אקדמית מותאמת אישית ולשיעורים פרטיים 1-על-1 במקצועות הריאליים והמדויקים. המערכת פותחה כדי לסייע לסטודנטים בהתמודדות היומיומית עם הדרישות האקדמיות הגבוהות, קצב ההרצאות המהיר והעומס חסר התקדים בסמסטר. באמצעות שילוב ייחודי בין אבחון פדגוגי מהיר לשיבוץ מורים מומחים, אנו מאפשרים לכל סטודנט לגשר על פערי הבנה, לפתח ביטחון בפתרון תרגילים ולהגיע מוכן לחלוטין למבחני סוף הסמסטר.",
  },
  {
    id: "teachers",
    title: "נבחרת המורים והמתרגלים",
    body: "נבחרת ההוראה שלנו מורכבת מבוגרי תארים מתקדמים (תואר שני ומעלה), מתרגלים מצטיינים ומרצים מנוסים מהפקולטות המובילות בארץ. המורים נבחרו בפינצטה לא רק בזכות הידע האקדמי המעמיק שלהם, אלא בעיקר בזכות יכולת ההסבר המוכחת בגובה העיניים וסבלנות בלתי מתפשרת. לכל מורה היכרות מעמיקה עם תוכניות הלימודים, הדגשים הפדגוגיים וסגנון המבחנים הספציפי בכל אחד ממוסדות הלימוד בישראל.",
  },
  {
    id: "audience",
    title: "למי המערכת מתאימה?",
    body: "השירות מתאים למגוון רחב של סטודנטים במסלולי הנדסה, מדעי המחשב, כלכלה, מדעים מדויקים וניהול: לסטודנטים שפספסו רצף הרצאות עקב מילואים או אילוצים אישיים, למי שמתקשה להבין את החומר כפי שהוא מועבר בכיתה ומחפש הסבר פשוט ומעמיק, לסטודנטים הנאבקים בקורסי סינון כמו חדו״א, לינארית ופיזיקה, וכן לסטודנטים חזקים המעוניינים לתרגל ברמת מבחן גבוהה ולהבטיח ציון 90 ומעלה.",
  },
  {
    id: "institutions",
    title: "התאמה מלאה למוסדות הלימוד",
    body: "אנו עובדים בהתאמה ישירה לסילבוסים ולמבנה הבחינות של מוסדות הלימוד המובילים בישראל, וביניהם: הטכניון, אוניברסיטת תל אביב, אוניברסיטת בן גוריון, האוניברסיטה העברית, אוניברסיטת בר אילן, אוניברסיטת חיפה, אוניברסיטת אריאל, אוניברסיטת רייכמן, המכללה למנהל, מכון טכנולוגי חולון (HIT), המכללה האקדמית אפקה, עזריאלי - מכללה להנדסה, המכללה האקדמית ת״א-יפו, המרכז האקדמי רופין, מכללת סמי שמעון, מכללת ספיר, מכללת בראודה ומוסדות נוספים.",
  },
];

const METHOD_ENTRIES: readonly AboutEntry[] = [
  {
    id: "live-lesson",
    title: "שיעור פרטי חי 1-על-1 (ולא סרטון מוקלט)",
    body: "בניגוד לצפייה פסיבית בסרטוני וידאו שבהם הסטודנט נשאר לבד עם שאלותיו ברגעי תקיעות, אצלנו הלמידה מתבצעת בזמן אמת מול מורה פרטי ייעודי. השיעור כולו מוקדש לקצב האישי שלך, למענה מדויק על שאלות, לחידוד מושגים ולבניית דרך חשיבה עצמאית שתוביל אותך לפתרון נכון של שאלות מורכבות במבחן.",
  },
  {
    id: "shared-board",
    title: "לוח דיגיטלי משותף וסביבת למידה",
    body: "כל שיעור מתקיים על גבי לוח עבודה אינטראקטיבי מתקדם המאפשר כתיבה, שרטוט גרפים ופיתוח נוסחאות מתמטיות במשותף. בסיום כל שיעור, לוח העבודה וסיכומי התרגול נשמרים כקובץ PDF אישי ישירות באזור האישי שלך, כך שתוכל לחזור אל המהלכים וההסברים המדויקים בכל רגע נתון לקראת תקופת המבחנים.",
  },
  {
    id: "syllabus",
    title: "התאמה מלאה לסילבוס ולשחזורי מבחנים",
    body: "המורים שלנו אינם מלמדים תיאוריה כללית. כל שיעור נתפר בהתאם לסילבוס העדכני של הקורס, למרצה הספציפי ולמבנה המבחן במוסד הלימודים שלך. הלמידה מתמקדת בפתרון תרגילי בית מורכבים, ניתוח שחזורי בחינות משנים קודמות והקניית טכניקות עבודה מדויקות שמבטיחות מקסימום ניקוד אצל הבודק.",
  },
];

type BlockHeadingProps = {
  id: string;
  children: string;
};

function BlockHeading({ id, children }: BlockHeadingProps) {
  return (
    <h2
      id={id}
      className="flex items-center text-3xl font-black tracking-tight text-slate-900 md:text-4xl"
    >
      <span aria-hidden="true" className="me-3 inline-block h-3 w-3 shrink-0 rounded-full bg-blue-600" />
      {children}
    </h2>
  );
}

type EntryProps = {
  entry: AboutEntry;
};

function Entry({ entry }: EntryProps) {
  return (
    <div>
      <h3 className="mb-2 text-start text-base font-bold text-slate-900 md:text-lg">{entry.title}</h3>
      <p className="text-start text-sm leading-relaxed text-slate-600 md:text-base">{entry.body}</p>
    </div>
  );
}

export default function AboutSection() {
  return (
    <section id="about" aria-labelledby="about-heading" dir="rtl" className="scroll-mt-20">
      <div className="bg-white py-16">
        <div className="mx-auto max-w-5xl px-6">
          <BlockHeading id="about-heading">מי אנחנו?</BlockHeading>
          <div className="mt-10 grid grid-cols-1 gap-x-16 gap-y-12 md:grid-cols-2">
            {ABOUT_ENTRIES.map((entry) => (
              <Entry key={entry.id} entry={entry} />
            ))}
          </div>
        </div>
      </div>

      <div className="border-t border-slate-200/60 bg-[#f8f9fa] py-16">
        <div className="mx-auto max-w-5xl px-6">
          <BlockHeading id="method-heading">השיעורים והשיטה שלנו</BlockHeading>
          <div className="mt-10 grid grid-cols-1 gap-x-16 gap-y-10 md:grid-cols-2 lg:grid-cols-3">
            {METHOD_ENTRIES.map((entry) => (
              <Entry key={entry.id} entry={entry} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
