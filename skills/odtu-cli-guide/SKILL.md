---
name: odtu-cli-guide
description: >
  Use this skill whenever the user asks about METU (ODTÜ) courses, ODTUClass/Moodle assignments,
  submission status, grades, GPA, transcript, curriculum, weekly schedule, attendance, announcements,
  course materials, or METU student email (IMAP). Triggers on "check my grades", "what's due this week",
  "check my METU email", "read my inbox", "show my schedule", "transcript", "GPA", "attendance",
  "assignment details", "download course materials", "odtu", "odtuclass", "sais", or Turkish queries like
  "derslerim", "ödevlerim", "notlarım", "devamsızlık", "duyurular", "okul maili", "odtü mail", "transkript".
metadata:
  version: "2.2.0"
---

# ODTU CLI Agent Guide

`odtu` is a terminal tool for METU (Middle East Technical University) students providing unified access to:
1. **ODTUClass (Moodle)** — courses, grades, assignments (+ submission status & full instructions), deadlines, forums, announcements, pages, attendance, file downloads/archives, and arbitrary authenticated URLs.
2. **Student Portal (`student.metu.edu.tr` / SAIS)** — transcript, GPA, curriculum completion, weekly schedule, profile, and financial status.
3. **METU Email (`imap.metu.edu.tr:993`)** — read-only inbox listing, search, unread filtering, body/link extraction, and attachment saving.

If `odtu` is not found in a non-interactive shell `PATH`, invoke `~/.local/bin/odtu`.

## Always Use `--json`

Every `odtu` command accepts the global `--json` flag (`odtu --json <cmd>` or `odtu <cmd> --json`).
In agent workflows, **always pass `--json`**:
- Suppresses ANSI styling, ASCII tables, and spinners.
- Emits structured JSON to stdout (exit `0`).
- Emits structured error JSON to stderr (`{ "ok": false, "error": "...", "type": "..." }`, exit `1`).

## Authentication, Keychain & Auto-Relogin

- **Session state:** Stored in `~/.odtuclass/session.json` (Moodle) and `~/.odtuclass/student-session.json` (SAIS). **No plaintext passwords are written to disk.**
- **Password storage:** On macOS, `odtu login` saves the METU password in **macOS Keychain** (service `odtu-cli-metu`, account `<username>`). Headless/Linux environments can pass `ODTU_PASSWORD` via environment.
- **Auto-relogin:** When either Moodle or SAIS sessions expire, commands automatically re-authenticate using Keychain/`ODTU_PASSWORD` and retry transparently. Verify anytime with `odtu status --json` (returns `loggedIn`, `keychainStored`, `reauthenticated`).
- **Interactive vs non-interactive login:** Never run bare `odtu login` programmatically (interactive TTY wizard). If the user has not logged in yet, either ask them to run `odtu login` in their terminal or pipe via stdin (`printf '%s\n' ... | odtu login -u <user> --password-stdin -y <year> -s <f|s|u>`). Never pass plaintext passwords with `-p` on the shell command line.

## Command Reference

### Session Management

| Command | Purpose | Key Options |
|---|---|---|
| `odtu status --json` | Verify auth, user info, semester, Keychain state | — |
| `odtu login` | Log in to ODTUClass + SAIS + store Keychain password | `-u`, `--password-stdin`, `-y <year>`, `-s f\|s\|u` |
| `odtu logout` | Clear saved Moodle/SAIS sessions (removes Keychain unless kept) | `--keep-keychain` |
| `odtu switch` | Switch academic semester (interactive re-login) | — |

### ODTUClass Commands

| Command | Purpose | Key Options |
|---|---|---|
| `odtu courses --json` | List enrolled courses with IDs | `-f all\|inprogress\|future\|past` |
| `odtu grades [courseId] --json` | Course letter overview, or item/weight/average breakdown | — |
| `odtu assignments [courseId] --json` | List assignments/quizzes with `cmid`, `duedate`, `submissionStatus` | — |
| `odtu assignment <cmid> --json` | Full assignment instructions, attachments, due date, submission status & files | — |
| `odtu deadlines [courseId] --json` | Upcoming calendar events | `-d <days>` (default: `14`) |
| `odtu announcements [courseId] --json` | Recent announcements across all or one course | `-n <count>` (default: `5`), `-f all\|inprogress` |
| `odtu contents <courseId> --json` | Sections and activity modules (includes HTML fallback if Moodle WS is disabled) | — |
| `odtu forums <courseId> --json` | List forums, discussions (`-f`), or full posts (`-d`) | `-f <forumId>`, `-d <discussionId>` |
| `odtu page <cmid> --json` | Read a Moodle Page activity (text, links, files) | — |
| `odtu attendance [courseId] --json` | Attendance session rows and summary per course | — |
| `odtu download <courseId> [moduleId] --json` | Download files from a module or whole course | `-o <dir>` (default: `downloads`) |
| `odtu materials <courseId> --json` | Full course archive (files, external links, announcements) | `-o <dir>`, `--no-announcements`, `--convert-pptx`, `--merge weekly\|all` |
| `odtu fetch <urlOrPath> --json` | Fetch any authenticated ODTUClass URL/path (text/links or binary save) | `--raw`, `-o <file>` |
| `odtu dashboard --json` | Combined semester info, course list, and 7-day events | — |

### METU Email Commands (`imap.metu.edu.tr:993`, Read-Only)

Uses the logged-in user's Keychain password (`ODTU_PASSWORD` fallback) and `python3` stdlib `imaplib` (`readonly=True`, `BODY.PEEK[]`), so reading emails **never alters `\Seen` / unread flags**.

| Command | Purpose | Key Options |
|---|---|---|
| `odtu mail --json` | List latest inbox messages (UID, seen, subject, from, date) | `-n <count>` (default: `15`), `-f <folder>` (default: `INBOX`), `--unread`, `-s <query>`, `-u <user>` |
| `odtu mail <uid> --json` | Read full email body, extracted links, and attachment metadata | `--html`, `--save-attachments <dir>`, `-f <folder>`, `-u <user>` |
| `odtu mail --folders --json` | List available IMAP folders | `-u <user>` |

### Student Portal (SAIS — `student.metu.edu.tr`) Commands

| Command | Purpose |
|---|---|
| `odtu transcript --json` | Full transcript across all semesters (credits, grades, ECTS, GPA) |
| `odtu gpa --json` | Semester-by-semester GPA, cumulative GPA, standing |
| `odtu curriculum --json` | Curriculum checklist (passed / failed / remaining courses) |
| `odtu schedule --json` | Weekly course grid by time slot |
| `odtu profile --json` | Student info, registered courses, tuition/library financial status |

## Common Agent Workflows

### 1. Check What's Due & Verify Real Submission Status

```bash
odtu deadlines -d 14 --json
odtu assignments --json
# Inspect exact instructions, attachments, and whether the user actually submitted:
odtu assignment <cmid> --json
```

### 2. Read Course Content, Syllabi, or Rules Hidden Inside Moodle Modules

```bash
odtu courses --json                    # get courseId
odtu contents <courseId> --json        # find cmid and modname (assign/page/resource/forum)
odtu page <cmid> --json                # read Page module
odtu download <courseId> <cmid> -o ./files --json
odtu fetch "/mod/forum/discuss.php?d=1234" --json
```

### 3. Triage METU Email Without Marking Mail as Read

```bash
odtu mail --unread -n 25 --json
odtu mail -s "Midterm" -n 10 --json
odtu mail <uid> --save-attachments /tmp/mail-att --json
```

If an email only says "ektedir" / "see attached", pass `--save-attachments <dir>` and read the saved PDF/document directly.

### 4. Academic Record & Attendance Snapshot

```bash
odtu grades <courseId> --json
odtu attendance <courseId> --json
odtu gpa --json
odtu schedule --json
```

## Notes & Troubleshooting

- **HTML fallbacks:** METU periodically restricts some Moodle Web Service endpoints (such as `core_course_get_contents` or `mod_assign_get_assignments`). `odtu` falls back transparently to authenticated HTML scraping — you do not need a browser unless an external third-party SSO site (e.g., Gradescope) is involved.
- **SAIS / Off-campus network:** Most SAIS actions go through METU CAS SSO automatically; certain campus endpoints may require METU VPN (`duvar.metu.edu.tr`) depending on network policy.
- **"No password found in Keychain":** Run `odtu login` once (or set `ODTU_PASSWORD`) so both auto-relogin and `odtu mail` have credentials.
- For detailed `--json` response shapes of every command, see [references/command-outputs.md](references/command-outputs.md).
