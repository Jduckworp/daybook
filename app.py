"""Daybook — a task board that keeps a record of what you actually did.

A single-user work tracker: schedule tasks onto days, drag them around, tick
them off. Unlike most todo apps, nothing ticked off is ever thrown away — the
whole point is that at month end there is a defensible record of what got
done.

State lives in one SQLite file, so the record can be read by a backup script,
a spreadsheet, or anything else that speaks SQL, without going through the app.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from datetime import datetime, date, timedelta
from functools import wraps
from pathlib import Path

from flask import (
    Flask,
    g,
    jsonify,
    render_template,
    request,
    session,
    send_file,
)

BASE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("DAYBOOK_DATA_DIR") or BASE / "data")
DATA.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA / "daybook.db"
CONFIG_PATH = Path(os.environ.get("DAYBOOK_CONFIG") or BASE / "config.json")

DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MONTH_RE = re.compile(r"^\d{4}-\d{2}$")
STAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$")

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT    NOT NULL,
    notes        TEXT    NOT NULL DEFAULT '',
    strand       TEXT    NOT NULL DEFAULT '',
    day          TEXT,
    pos          REAL    NOT NULL DEFAULT 0,
    done         INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    created_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL,
    deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS tasks_day ON tasks(day);
CREATE INDEX IF NOT EXISTS tasks_completed ON tasks(completed_at);
"""


# --------------------------------------------------------------------------
# config / secrets
# --------------------------------------------------------------------------

def hash_password(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode(), salt.encode(), 240_000
    ).hex()


def load_config() -> dict:
    """Read config.json, minting a fresh secret + password on first boot.

    Every worker runs this at import. On a first boot they race, and before
    this was made exclusive they each minted a *different* password: the file
    held one worker's, while the other kept its own in memory and rejected the
    password the user had just been told. O_EXCL makes exactly one of them the
    author; the rest wait for it to finish writing and read what it wrote.
    """
    for _ in range(100):
        if CONFIG_PATH.exists():
            try:
                return json.loads(CONFIG_PATH.read_text())
            except (json.JSONDecodeError, ValueError):
                time.sleep(0.05)  # the winner is mid-write; let it finish
                continue
        try:
            fd = os.open(CONFIG_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            continue  # lost the race; go round and read theirs
        salt = secrets.token_hex(16)
        password = secrets.token_urlsafe(9)
        cfg = {
            "secret_key": secrets.token_hex(32),
            "salt": salt,
            "password_hash": hash_password(password, salt),
            "initial_password": password,  # delete this line once you've saved it
        }
        with os.fdopen(fd, "w") as fh:
            fh.write(json.dumps(cfg, indent=2) + "\n")
        # Under systemd or Docker this goes to the log, which is the only place
        # a first boot leaves any trace; without it the only copy is inside
        # config.json and a new user has no reason to look there.
        print(
            "\n  Daybook — first boot.\n"
            f"  Your password is:  {password}\n"
            f"  It is also in {CONFIG_PATH}. Change it, then delete the\n"
            '  "initial_password" line from that file.\n',
            flush=True,
        )
        return cfg
    raise RuntimeError(f"Could not read or create {CONFIG_PATH}")


CONFIG = load_config()

app = Flask(__name__)
app.secret_key = CONFIG["secret_key"]
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    # On by default: anything reachable from outside your own machine should
    # be behind TLS, and a session cookie that travels in clear text is worth
    # stealing. Set DAYBOOK_INSECURE_COOKIE=1 when testing over plain HTTP,
    # otherwise the browser will refuse to send the cookie back and you will
    # appear to be signed out on every request.
    SESSION_COOKIE_SECURE=os.environ.get("DAYBOOK_INSECURE_COOKIE") != "1",
    PERMANENT_SESSION_LIFETIME=timedelta(days=180),
    JSON_SORT_KEYS=False,
)

if not app.config["SESSION_COOKIE_SECURE"]:
    # Easy to set once to get a first run working and then forget about, so
    # say it on every boot rather than only in the documentation.
    print(
        "  Daybook: DAYBOOK_INSECURE_COOKIE is set. The session cookie will\n"
        "  travel in clear text. Fine on localhost or a trusted LAN; remove it\n"
        "  once something is terminating TLS in front of this.",
        flush=True,
    )


# --------------------------------------------------------------------------
# database
# --------------------------------------------------------------------------

def db() -> sqlite3.Connection:
    if "db" not in g:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        g.db = conn
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def init_db() -> None:
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()


init_db()


def row_to_task(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "notes": row["notes"],
        "strand": row["strand"],
        "day": row["day"],
        "pos": row["pos"],
        "done": bool(row["done"]),
        "completedAt": row["completed_at"],
        "createdAt": row["created_at"],
    }


# --------------------------------------------------------------------------
# auth
# --------------------------------------------------------------------------

def require_auth(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("in"):
            return jsonify(error="unauthorized"), 401
        return fn(*args, **kwargs)

    return wrapper


# One password guards the whole instance, so a guessing attack is the only
# way in. PBKDF2 at 240k rounds already makes each attempt expensive, but a
# patient script still gets unlimited tries; this caps them. The counter is
# global rather than per-IP on purpose — there is only ever one legitimate
# user, so locking everyone out is exactly the right response, and it cannot
# be sidestepped by rotating through addresses. The counter lives in the
# process, so N gunicorn workers allow N times the attempts before the
# first lockout — still a hard ceiling, just a slightly higher one.
LOCKOUT_AFTER = 5          # failures before the door closes
LOCKOUT_WINDOW = 15 * 60   # seconds a failure is remembered for
LOCKOUT_SECONDS = 60       # doubles with each further failure, up to an hour

_auth_lock = threading.Lock()
_auth_state = {"failures": [], "locked_until": 0.0}


def _lockout_remaining() -> int:
    """Seconds left on the lockout, 0 if the door is open."""
    with _auth_lock:
        return max(0, int(_auth_state["locked_until"] - time.monotonic()))


def _note_auth(success: bool) -> None:
    now = time.monotonic()
    with _auth_lock:
        if success:
            _auth_state["failures"].clear()
            _auth_state["locked_until"] = 0.0
            return
        recent = [t for t in _auth_state["failures"] if now - t < LOCKOUT_WINDOW]
        recent.append(now)
        _auth_state["failures"] = recent
        if len(recent) >= LOCKOUT_AFTER:
            over = len(recent) - LOCKOUT_AFTER
            wait = min(LOCKOUT_SECONDS * (2 ** over), 3600)
            _auth_state["locked_until"] = now + wait


@app.post("/api/login")
def login():
    wait = _lockout_remaining()
    if wait:
        minutes = max(1, round(wait / 60))
        return jsonify(error=f"Too many wrong passwords. Try again in "
                             f"{minutes} minute{'s' if minutes != 1 else ''}."), 429

    payload = request.get_json(silent=True) or {}
    given = str(payload.get("password", ""))
    expected = CONFIG["password_hash"]
    if secrets.compare_digest(hash_password(given, CONFIG["salt"]), expected):
        _note_auth(True)
        session.permanent = True
        session["in"] = True
        return jsonify(ok=True)
    _note_auth(False)
    return jsonify(error="That password doesn't match."), 401


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/session")
def session_state():
    return jsonify(signedIn=bool(session.get("in")))


# --------------------------------------------------------------------------
# validation helpers
# --------------------------------------------------------------------------

def clean_day(value):
    if value in (None, "", "backlog"):
        return None
    value = str(value)
    if not DAY_RE.match(value):
        raise ValueError("day must be YYYY-MM-DD")
    return value


def clean_stamp(value):
    """Accept a client-supplied local timestamp; fall back to server time."""
    if value and STAMP_RE.match(str(value)):
        stamp = str(value)
        return stamp if len(stamp) > 16 else stamp + ":00"
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def next_pos(day) -> float:
    row = db().execute(
        "SELECT COALESCE(MAX(pos), 0) AS m FROM tasks "
        "WHERE deleted_at IS NULL AND day IS ?",
        (day,),
    ).fetchone()
    return float(row["m"]) + 1.0


# --------------------------------------------------------------------------
# task API
# --------------------------------------------------------------------------

@app.get("/api/tasks")
@require_auth
def list_tasks():
    """Everything the board needs: the visible window, the backlog, and any
    unfinished task whose day has already passed (so nothing goes missing)."""
    start = request.args.get("start", "")
    end = request.args.get("end", "")
    if not (DAY_RE.match(start) and DAY_RE.match(end)):
        return jsonify(error="start and end must be YYYY-MM-DD"), 400

    rows = db().execute(
        """
        SELECT * FROM tasks
        WHERE deleted_at IS NULL
          AND (
                (day IS NOT NULL AND day BETWEEN ? AND ?)
             OR day IS NULL
             OR (day IS NOT NULL AND day < ? AND done = 0)
          )
        ORDER BY pos ASC, id ASC
        """,
        (start, end, start),
    ).fetchall()
    return jsonify(tasks=[row_to_task(r) for r in rows])


@app.post("/api/tasks")
@require_auth
def create_task():
    payload = request.get_json(silent=True) or {}
    title = str(payload.get("title", "")).strip()
    if not title:
        return jsonify(error="A task needs a title."), 400
    try:
        day = clean_day(payload.get("day"))
    except ValueError as exc:
        return jsonify(error=str(exc)), 400

    now = clean_stamp(payload.get("now"))
    conn = db()
    cur = conn.execute(
        """INSERT INTO tasks (title, notes, strand, day, pos, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            title[:400],
            str(payload.get("notes", ""))[:8000],
            str(payload.get("strand", "")).strip()[:60],
            day,
            next_pos(day),
            now,
            now,
        ),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(task=row_to_task(row)), 201


@app.patch("/api/tasks/<int:task_id>")
@require_auth
def update_task(task_id: int):
    payload = request.get_json(silent=True) or {}
    conn = db()
    row = conn.execute(
        "SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL", (task_id,)
    ).fetchone()
    if row is None:
        return jsonify(error="No such task."), 404

    fields, values = [], []
    now = clean_stamp(payload.get("now"))

    if "title" in payload:
        title = str(payload["title"]).strip()
        if not title:
            return jsonify(error="A task needs a title."), 400
        fields.append("title = ?")
        values.append(title[:400])

    if "notes" in payload:
        fields.append("notes = ?")
        values.append(str(payload["notes"])[:8000])

    if "strand" in payload:
        fields.append("strand = ?")
        values.append(str(payload["strand"]).strip()[:60])

    if "day" in payload:
        try:
            day = clean_day(payload["day"])
        except ValueError as exc:
            return jsonify(error=str(exc)), 400
        fields += ["day = ?", "pos = ?"]
        values += [day, next_pos(day)]

    if "done" in payload:
        done = 1 if payload["done"] else 0
        fields.append("done = ?")
        values.append(done)
        # Ticking stamps the record; un-ticking clears it. The row itself
        # survives either way.
        fields.append("completed_at = ?")
        values.append(now if done else None)
        if done and row["day"] is None:
            # Work done straight off the backlog still belongs to a day.
            fields += ["day = ?", "pos = ?"]
            values += [now[:10], next_pos(now[:10])]

    if not fields:
        return jsonify(task=row_to_task(row))

    fields.append("updated_at = ?")
    values.append(now)
    values.append(task_id)
    conn.execute(f"UPDATE tasks SET {', '.join(fields)} WHERE id = ?", values)
    conn.commit()
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    return jsonify(task=row_to_task(row))


@app.post("/api/move")
@require_auth
def move_task():
    """Drop a task on a day and restate that day's order in one go."""
    payload = request.get_json(silent=True) or {}
    try:
        task_id = int(payload.get("id"))
        day = clean_day(payload.get("day"))
    except (TypeError, ValueError) as exc:
        return jsonify(error=str(exc) or "Bad move."), 400

    order = payload.get("order") or []
    if not isinstance(order, list):
        return jsonify(error="order must be a list of task ids"), 400

    now = clean_stamp(payload.get("now"))
    conn = db()
    row = conn.execute(
        "SELECT id FROM tasks WHERE id = ? AND deleted_at IS NULL", (task_id,)
    ).fetchone()
    if row is None:
        return jsonify(error="No such task."), 404

    conn.execute(
        "UPDATE tasks SET day = ?, updated_at = ? WHERE id = ?", (day, now, task_id)
    )
    for index, ident in enumerate(order):
        try:
            ident = int(ident)
        except (TypeError, ValueError):
            continue
        conn.execute("UPDATE tasks SET pos = ? WHERE id = ?", (float(index), ident))
    conn.commit()
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    return jsonify(task=row_to_task(row))


@app.delete("/api/tasks/<int:task_id>")
@require_auth
def delete_task(task_id: int):
    """Soft delete. A deleted task leaves the board but stays in the record —
    if it was ticked off, it still counts toward the month."""
    conn = db()
    conn.execute(
        "UPDATE tasks SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
        (datetime.now().strftime("%Y-%m-%dT%H:%M:%S"), task_id),
    )
    conn.commit()
    return jsonify(ok=True)


# --------------------------------------------------------------------------
# the record
# --------------------------------------------------------------------------

def month_bounds(month: str) -> tuple[str, str]:
    year, mon = int(month[:4]), int(month[5:7])
    first = date(year, mon, 1)
    last = date(year + (mon == 12), (mon % 12) + 1, 1) - timedelta(days=1)
    return first.isoformat(), last.isoformat()


def gather_report(month: str) -> dict:
    first, last = month_bounds(month)
    conn = db()

    # Completed counts by when it was ticked off, deleted rows included: the
    # record of work done should not depend on tidying the board afterwards.
    done = conn.execute(
        """
        SELECT * FROM tasks
        WHERE done = 1 AND completed_at >= ? AND completed_at <= ?
        ORDER BY completed_at ASC, id ASC
        """,
        (first + "T00:00:00", last + "T23:59:59"),
    ).fetchall()

    open_rows = conn.execute(
        """
        SELECT * FROM tasks
        WHERE done = 0 AND deleted_at IS NULL AND day IS NOT NULL
          AND day BETWEEN ? AND ?
        ORDER BY day ASC, pos ASC
        """,
        (first, last),
    ).fetchall()

    by_day: dict[str, list] = {}
    by_strand: dict[str, list] = {}
    for row in done:
        task = row_to_task(row)
        by_day.setdefault(task["completedAt"][:10], []).append(task)
        by_strand.setdefault(task["strand"] or "Unassigned", []).append(task)

    return {
        "month": month,
        "label": date(int(month[:4]), int(month[5:7]), 1).strftime("%B %Y"),
        "completedCount": len(done),
        "openCount": len(open_rows),
        "activeDays": len(by_day),
        "byDay": [{"day": d, "tasks": t} for d, t in sorted(by_day.items())],
        "byStrand": [
            {"strand": s, "tasks": t}
            for s, t in sorted(by_strand.items(), key=lambda kv: -len(kv[1]))
        ],
        "open": [row_to_task(r) for r in open_rows],
    }


@app.get("/api/report")
@require_auth
def report():
    month = request.args.get("month", "")
    if not MONTH_RE.match(month):
        return jsonify(error="month must be YYYY-MM"), 400
    return jsonify(gather_report(month))


@app.get("/api/months")
@require_auth
def months():
    """Every month that has something in the record, newest first."""
    rows = db().execute(
        """
        SELECT DISTINCT substr(completed_at, 1, 7) AS m
        FROM tasks WHERE done = 1 AND completed_at IS NOT NULL
        ORDER BY m DESC
        """
    ).fetchall()
    return jsonify(months=[r["m"] for r in rows if r["m"]])


def report_markdown(data: dict) -> str:
    lines = [f"# Work completed — {data['label']}", ""]
    lines.append(
        f"{data['completedCount']} tasks completed across "
        f"{data['activeDays']} working days."
    )
    lines.append("")
    for group in data["byStrand"]:
        lines.append(f"## {group['strand']}")
        lines.append("")
        for task in group["tasks"]:
            lines.append(f"- **{task['title']}** — {task['completedAt'][:10]}")
            if task["notes"].strip():
                for para in task["notes"].strip().splitlines():
                    if para.strip():
                        lines.append(f"  {para.strip()}")
        lines.append("")
    if data["open"]:
        lines.append("## Still open at month end")
        lines.append("")
        for task in data["open"]:
            lines.append(f"- {task['title']} — scheduled {task['day']}")
        lines.append("")
    return "\n".join(lines)


def report_csv(data: dict) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Completed", "Strand", "Task", "Detail"])
    for group in data["byDay"]:
        for task in group["tasks"]:
            writer.writerow(
                [
                    task["completedAt"][:10],
                    task["strand"],
                    task["title"],
                    " ".join(task["notes"].split()),
                ]
            )
    return buf.getvalue()


@app.get("/api/report.<fmt>")
@require_auth
def report_download(fmt: str):
    month = request.args.get("month", "")
    if not MONTH_RE.match(month):
        return jsonify(error="month must be YYYY-MM"), 400
    if fmt not in ("md", "csv"):
        return jsonify(error="format must be md or csv"), 400

    data = gather_report(month)
    body = report_markdown(data) if fmt == "md" else report_csv(data)
    mimetype = "text/markdown" if fmt == "md" else "text/csv"
    return send_file(
        io.BytesIO(body.encode("utf-8")),
        mimetype=mimetype,
        as_attachment=True,
        download_name=f"tasks-{month}.{fmt}",
    )


# --------------------------------------------------------------------------
# pages
# --------------------------------------------------------------------------

@app.context_processor
def asset_helper():
    """Stamp static URLs with the file's mtime so a CSS or JS change reaches
    an already-open browser without asking anyone to hard-refresh."""

    def asset(filename: str) -> str:
        path = BASE / "static" / filename
        stamp = int(path.stat().st_mtime) if path.exists() else 0
        return f"/static/{filename}?v={stamp}"

    return {"asset": asset}


@app.get("/")
def index():
    return render_template("index.html", signed_in=bool(session.get("in")))


@app.get("/manifest.webmanifest")
def manifest():
    return send_file(BASE / "static" / "manifest.webmanifest", mimetype="application/manifest+json")


@app.get("/sw.js")
def service_worker():
    """Served from the root so the worker's scope covers the whole app; from
    /static/ it could only ever control /static/."""
    response = send_file(BASE / "static" / "sw.js", mimetype="text/javascript")
    response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/healthz")
def healthz():
    return jsonify(ok=True, tasks=db().execute(
        "SELECT COUNT(*) AS c FROM tasks WHERE deleted_at IS NULL"
    ).fetchone()["c"])


if __name__ == "__main__":
    app.config["SESSION_COOKIE_SECURE"] = False
    app.run(host="127.0.0.1", port=8765, debug=True)
