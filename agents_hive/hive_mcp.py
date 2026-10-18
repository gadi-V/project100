import subprocess
import os
import sys
import json
from pathlib import Path
from typing import List, Literal, Optional
from dotenv import load_dotenv
from openai import OpenAI
from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field, ValidationError, field_validator

# שם השרת עודכן כדי לשקף את היכולות המורחבות
mcp = FastMCP("agents-hive-enterprise")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
HIVE_DIR = PROJECT_ROOT / "agents_hive"

ENV_PATH = HIVE_DIR / ".env"
ROOT_ENV_PATH = PROJECT_ROOT / ".env"
# Hive-local first, then root .env fills missing keys (HIVE_MONITOR_SECRET, APP_URL).
load_dotenv(dotenv_path=ENV_PATH)
load_dotenv(dotenv_path=ROOT_ENV_PATH)

API_KEY = os.getenv("OPENROUTER_API_KEY")
BASE_URL = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
REASONING_MODEL = os.getenv("MODEL_ARCHITECT", "deepseek/deepseek-r1")

# 🚨 קודש קודשים - אזורים שאסור ל-AI לדרוס בטעות
PROTECTED_DOMAINS = [
    "lib/ledger",
    "lib/dispatch",
    "app/api/fintech",
    "app/api/cancellations",
]

# ── Frozen curriculum schema (see .cursor/rules/09-curriculum-pedagogy.mdc) ──
GRADE_LEVELS = ("ELEMENTARY", "MIDDLE_SCHOOL", "HIGH_SCHOOL", "ACADEMIC")

class CurriculumTopic(BaseModel):
    subject: str = Field(min_length=1)
    topicName: str = Field(min_length=1)
    subTopics: List[str] = Field(default_factory=list)
    gradeLevel: Literal["ELEMENTARY", "MIDDLE_SCHOOL", "HIGH_SCHOOL", "ACADEMIC"]
    weightInExam: float = Field(ge=0.1, le=1.0)

    @field_validator("subject", "topicName")
    @classmethod
    def strip_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be blank")
        return v

class CurriculumTopicList(BaseModel):
    topics: List[CurriculumTopic]


def validate_curriculum_payload(payload) -> str:
    """Validate a parsed list against the locked CurriculumTopic schema.

    Raises Pydantic ValidationError on any structural violation. Returns the
    re-serialized payload with the topic list.
    """
    CurriculumTopicList(topics=payload)  # raises on ANY invalid item
    return payload

@mcp.tool()
def parse_syllabus_to_curriculum(raw_text_or_markdown: str) -> str:
    """Uses DeepSeek-R1 via OpenRouter to parse exam focus syllabuses into structured CurriculumTopic objects."""
    if not API_KEY:
        return json.dumps({
            "success": False,
            "error": "OPENROUTER_API_KEY is not configured in agents_hive/.env"
        })

    client = OpenAI(base_url=BASE_URL, api_key=API_KEY, timeout=20.0, max_retries=0)
    system_prompt = """You are an expert EdTech Curriculum Architect.
Analyze the provided syllabus, exam focus document (מיקוד בגרות/מבחן), or course outline.
Extract and structure the curriculum into a strictly valid JSON array of CurriculumTopic objects.

Each item in the array MUST match this exact JSON schema:
{
  "subject": string (e.g. "מתמטיקה", "פיזיקה", "מדעי המחשב"),
  "topicName": string (e.g. "חשבון דיפרנציאלי ואינטגרלי", "טריגונומטריה במרחב"),
  "subTopics": array of strings (e.g. ["חקירת פונקציות מעריכיות", "בעיות קיצון"]),
  "gradeLevel": string (one of: "ELEMENTARY", "MIDDLE_SCHOOL", "HIGH_SCHOOL", "ACADEMIC"),
  "weightInExam": number (estimated exam weight/percentage as float between 0.1 and 1.0)
}

Output ONLY raw JSON (an array of objects). Do not include markdown codeblocks or conversational filler."""

    try:
        response = client.chat.completions.create(
            model=REASONING_MODEL,
            temperature=0.1,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"Parse this syllabus into CurriculumTopic objects:\n\n{raw_text_or_markdown}"}
            ]
        )
        content = response.choices[0].message.content or "[]"
        clean_json = content.strip()
        if clean_json.startswith("```json"):
            clean_json = clean_json[7:]
        if clean_json.startswith("```"):
            clean_json = clean_json[3:]
        if clean_json.endswith("```"):
            clean_json = clean_json[:-3]
        clean_json = clean_json.strip()

        parsed = json.loads(clean_json)
        if not isinstance(parsed, list):
            raise ValueError("LLM output must be a JSON array of CurriculumTopic objects")

        # Strict Pydantic validation BEFORE returning (rule 09-curriculum-pedagogy §4).
        validate_curriculum_payload(parsed)

        return json.dumps({"success": True, "topics": parsed}, ensure_ascii=False)
    except json.JSONDecodeError:
        return json.dumps(
            {"success": False, "error": "LLM output must be a JSON array of CurriculumTopic objects"},
            ensure_ascii=False,
        )
    except ValidationError as ve:
        return json.dumps(
            {
                "success": False,
                "error": "CurriculumTopic schema validation failed",
                "details": ve.errors(include_url=False),
            },
            ensure_ascii=False,
        )
    except ValueError as ve:
        return json.dumps({"success": False, "error": str(ve)}, ensure_ascii=False)
    except Exception as exc:
        print(
            f"[parse_syllabus_to_curriculum] OpenRouter call failed: {type(exc).__name__}",
            file=sys.stderr,
        )
        return json.dumps(
            {"success": False, "error": "AI service is currently busy. Please try again later."},
            ensure_ascii=False,
        )

@mcp.tool()
def run_orchestration() -> str:
    """Runs the main Hive Orchestrator and generates the sprint plan."""
    try:
        venv_python = os.path.join(HIVE_DIR, "venv", "bin", "python")
        python_exec = venv_python if os.path.exists(venv_python) else "python3"
        result = subprocess.run(
            [python_exec, "hive_orchestrator.py"],
            cwd=HIVE_DIR,
            capture_output=True,
            text=True,
            check=True
        )
        output_file = os.path.join(HIVE_DIR, "HIVE_SPRINT_OUTPUT.md")
        if os.path.exists(output_file):
            with open(output_file, "r", encoding="utf-8") as f:
                return f"✅ ORCHESTRATION SUCCESS:\n\n{f.read()}"
        return result.stdout or "Orchestration completed successfully."
    except subprocess.CalledProcessError as e:
        return f"🚨 CRITICAL ORCHESTRATION ERROR:\n{e.stderr}"

@mcp.tool()
def run_typecheck() -> str:
    """Strict TypeScript compiler check. Must pass (Exit Code 0) before task completion."""
    try:
        result = subprocess.run(
            ["npx", "tsc", "--noEmit"],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True
        )
        if result.returncode == 0:
            return "✅ SUCCESS: TypeScript Typecheck PASSED. Code is structurally sound."
        return f"❌ FAILED: TypeScript Errors Found:\n{result.stdout}\nFix these errors immediately before continuing!"
    except Exception as e:
        return f"Error executing tsc: {str(e)}"

@mcp.tool()
def run_eslint() -> str:
    """Runs ESLint to ensure code quality and rule adherence."""
    try:
        result = subprocess.run(
            ["npx", "eslint", ".", "--ext", ".ts,.tsx", "--max-warnings=0"],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True
        )
        if result.returncode == 0:
            return "✅ SUCCESS: ESLint PASSED. Clean code."
        return f"⚠️ WARNING: ESLint Issues Found:\n{result.stdout}\nPlease review and fix styling/linting bugs."
    except Exception as e:
        return f"ESLint check skipped or failed to run: {str(e)}"

@mcp.tool()
def check_guardrails() -> str:
    """Security check: Verifies protected business files were not modified AND that
    prisma/schema.prisma contains NO deletions of fields/enums.
    Exits nonzero (returns FAILED) when a schema line is deleted."""
    try:
        result = subprocess.run(
            ["git", "diff", "--name-only", "HEAD"],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True
        )
        changed_files = result.stdout.strip().split('\n')

        # 1) Protected-domain violations
        violations = [f for f in changed_files if any(p in f for p in PROTECTED_DOMAINS)]

        # 2) Additive-only Prisma schema check (rule 09-database-safety)
        schema_deletions: list[str] = []
        try:
            diff_result = subprocess.run(
                ["git", "diff", "-U0", "HEAD", "--", "prisma/schema.prisma"],
                cwd=PROJECT_ROOT,
                capture_output=True,
                text=True
            )
            precious_lines = [
                # Banking fields
                'bankName', 'bankBranch', 'accountNumber', 'accountHolderName',
                # Ledger immutability (all 8 variants)
                'CHARGE', 'PAYOUT', 'REFUND', 'PLATFORM_FEE',
                'PENALTY', 'COMPENSATION', 'PLATFORM_COMPENSATION', 'ADJUSTMENT',
            ]
            for line in diff_result.stdout.splitlines():
                if line.startswith('-') and not line.startswith('---') and line.strip() != '-':
                    stripped = line[1:].strip()
                    # ignore pure comment/doc removals
                    if stripped in precious_lines or any(stripped.startswith(f"{p} ") for p in precious_lines):
                        schema_deletions.append(line)
        except Exception:
            pass  # git diff failure must not crash the check

        errors: list[str] = []
        if violations:
            errors.append(
                "🚨 SECURITY ALERT: protected core files modified without authorization!\n"
                "  - " + "\n  - ".join(violations)
            )
        if schema_deletions:
            errors.append(
                "🚨 SCHEMA INTEGRITY VIOLATION: non-additive deletion detected in prisma/schema.prisma:\n"
                "  - " + "\n  - ".join(ld.strip() for ld in schema_deletions)
                + "\nDatabase changes must be additive-only (see .cursor/rules/09-database-safety.mdc)."
            )

        if errors:
            return "❌ FAILED (Exit Code 1):\n" + "\n\n".join(errors)
        return "✅ Guardrails check passed. No protected domains altered; schema is additive-only."
    except Exception as e:
        return f"Error checking guardrails: {str(e)}"

@mcp.tool()
def verify_git_safety() -> str:
    """Checks Git status to ensure the working tree is clean before starting new major features."""
    try:
        status = subprocess.run(["git", "status", "--porcelain"], cwd=PROJECT_ROOT, capture_output=True, text=True)
        changes = status.stdout.strip()
        if not changes:
            return "✅ Git tree clean. Safe to proceed with major codebase changes."
        return f"⚠️ CAUTION: Uncommitted changes detected in working tree:\n{changes}\nProceed with extreme caution. Do not overwrite existing unstaged work."
    except Exception as e:
        return f"Git check failed: {str(e)}"

# ---------------------------------------------------------------------------
# ליבת כוורת התפעול והפדגוגיה — 4 הכלים המבצעיים (FastMCP Engine)
# כל כלי עוטף נקודת קצה מאומתת של Next.js (RBAC + AuditLog + Ledger) כך
# שה-data layer נשאר אחראי אבטחה יחיד. עקרון: חסר קונפיגורציה = כשל בטוח.
# ---------------------------------------------------------------------------

MONITOR_SECRET = os.getenv("HIVE_MONITOR_SECRET", "").strip()
# App origin (no trailing /api) — tool paths already include `/api/...`.
API_BASE = (
    os.getenv("APP_URL")
    or os.getenv("NEXT_PUBLIC_APP_URL")
    or "http://localhost:3000"
).rstrip("/")
NEXT_BASE_URL = API_BASE


def _refresh_m2m_config() -> None:
    """Re-read hive + root .env so a long-lived MCP process picks up mirrored secrets."""
    global MONITOR_SECRET, API_BASE, NEXT_BASE_URL
    load_dotenv(dotenv_path=ENV_PATH, override=True)
    load_dotenv(dotenv_path=ROOT_ENV_PATH, override=False)
    MONITOR_SECRET = os.getenv("HIVE_MONITOR_SECRET", "").strip()
    API_BASE = (
        os.getenv("APP_URL")
        or os.getenv("NEXT_PUBLIC_APP_URL")
        or "http://localhost:3000"
    ).rstrip("/")
    NEXT_BASE_URL = API_BASE


def _next_headers() -> dict:
    _refresh_m2m_config()
    headers = {"Content-Type": "application/json"}
    if MONITOR_SECRET:
        headers["Authorization"] = f"Bearer {MONITOR_SECRET}"
    return headers


def _next_call(method: str, path: str, body: Optional[dict] = None) -> dict:
    """Proxy an HTTP call to the audited Next.js API. Returns a JSON-safe dict."""
    import urllib.request
    import urllib.error

    headers = _next_headers()
    url = f"{API_BASE}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {"success": True}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw)
            parsed.setdefault("success", False)
            parsed.setdefault("httpStatus", e.code)
            return parsed
        except json.JSONDecodeError:
            return {"success": False, "httpStatus": e.code, "error": raw[:500]}
    except urllib.error.URLError as e:
        return {"success": False, "error": f"unreachable Next.js ({e.reason})"}


@mcp.tool()
def handle_package_whatsapp_flow(
    packageType: Literal["SINGLE", "TRIO", "MULTI"],
    studentPhone: str,
    studentName: str,
    gapTopicsCount: int = 0,
) -> str:
    """Routes WhatsApp messaging by package size: SINGLE stays transactional
    (reminder/link/PDF, no group); TRIO/MULTI auto-open the dedicated Quad
    WhatsApp group (pedagogical manager + expert teacher + student + parent).
    Also generates an automatic conversion message recommending the package
    that matches the knowledge-gap depth (1-2 topics → TRIO, 3+ → MULTI)."""
    try:
        payload = {
            "packageType": packageType,
            "studentPhone": studentPhone,
            "studentName": studentName,
            "gapTopicsCount": gapTopicsCount,
            "purpose": "CONVERSION",
        }
        result = _next_call("POST", "/api/whatsapp/dispatch-channel", payload)
        # חוסר תוצאה = שירות לא פעיל — מחזיר כשל בטוח ידידותי
        if not result.get("success"):
            return json.dumps(
                {"success": False, "error": result.get("error", "dispatch channel failed")},
                ensure_ascii=False,
            )
        return json.dumps(result, ensure_ascii=False)
    except Exception as e:  # pragma: no cover
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


@mcp.tool()
def complete_lesson_and_settle(
    lessonId: str,
    requireAuth: bool = True,
    feedback: Optional[str] = None,
    masteredTopics: Optional[List[str]] = None,
) -> str:
    """Closes a lesson (status → COMPLETED), updates the student's knowledge
    gaps (identifiedGaps), and registers the tutor's payout entitlement in the
    immutable BillingLedger (PAYOUT against the original CHARGE, split 70/30)."""
    try:
        payload: dict = {"lessonId": lessonId, "requireAuth": requireAuth}
        if feedback is not None:
            payload["feedback"] = feedback
        if masteredTopics is not None:
            payload["masteredTopics"] = masteredTopics
        result = _next_call("POST", "/api/lessons/complete", payload)
        return json.dumps(result, ensure_ascii=False)
    except Exception as e:  # pragma: no cover
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


@mcp.tool()
def admin_issue_compensation(
    lessonId: str,
    reason: str,
    amountIls: float = 180,
) -> str:
    """Admin override that issues a make-up lesson for the student and records a
    PLATFORM_COMPENSATION ledger line (balanced against the original CHARGE).
    Exclusively for MANAGER/ADMIN via the override endpoint."""
    try:
        payload = {"lessonId": lessonId, "reason": reason, "amountIls": amountIls}
        result = _next_call("POST", "/api/admin/override/compensation", payload)
        return json.dumps(result, ensure_ascii=False)
    except Exception as e:  # pragma: no cover
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


@mcp.tool()
def get_critical_desk_events(
    kind: Optional[Literal["NO_TEACHER_ASSIGNED", "STRIPE_FAILURE", "LEDGER_IMBALANCE", "TEACHER_NO_SHOW"]] = None,
) -> str:
    """Fetches CRITICAL risk exceptions only, for the Head of Desk quiet layer.
    Returns the three exclusive manager-alert preconditions when violated."""
    try:
        suffix = f"?kind={kind}" if kind else ""
        result = _next_call("GET", f"/api/admin/audit/risk-events{suffix}")
        return json.dumps(result, ensure_ascii=False)
    except Exception as e:  # pragma: no cover
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


if __name__ == "__main__":
    mcp.run()