#!/usr/bin/env python3
"""Build a fresh demo board: a seeded database plus a config with a known password.

Run it against a data directory and it writes ``donebook.db`` and
``config.json`` from scratch, destroying whatever was there. That is the point
— a public demo has to be disposable, so this is what the reset timer calls.

    python3 tools/seed_demo.py --data-dir /srv/donebook-demo --password demo

The seeded month is generated relative to today, so the board always looks
current and the monthly record always has something in it. The record is the
thing worth demonstrating: a visitor who only sees an empty board has not seen
what Donebook is for.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import secrets
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path

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

# (strand, title, notes). Deliberately the texture of a real job — a mix of
# sizes, some with notes and some bare, so the board does not read as filler.
WORK = [
    ("Website", "Rewrite the pricing page headline", "Current one tests badly on mobile."),
    ("Website", "Fix the broken links audit flagged", ""),
    ("Website", "Ship the new case-study template", ""),
    ("Website", "Compress hero images sitewide", "Biggest single LCP win available."),
    ("Campaigns", "Q4 campaign brief to the agency", ""),
    ("Campaigns", "Pull last quarter's spend by channel", ""),
    ("Campaigns", "Rework the paid search ad copy", "Three variants, test for a fortnight."),
    ("Campaigns", "Kill the underperforming display line", ""),
    ("Reporting", "Monthly numbers for the leadership deck", ""),
    ("Reporting", "Rebuild the attribution dashboard", "The old one double-counts email."),
    ("Reporting", "Write up why organic dipped in July", ""),
    ("Team", "One-to-ones", ""),
    ("Team", "Draft the new hire's first-month plan", ""),
    ("Team", "Book the offsite venue", ""),
    ("Admin", "Expenses", ""),
    ("Admin", "Renew the analytics contract", "Ends on the 30th — do not let it roll over."),
]

UNSCHEDULED = [
    ("Website", "Look into a dark mode", "Keeps coming up in feedback."),
    ("Campaigns", "Test a referral incentive", ""),
    ("Reporting", "Automate the weekly export", ""),
]


def build(conn: sqlite3.Connection, today: date) -> None:
    rng = secrets.SystemRandom()
    conn.executescript(SCHEMA)

    def insert(strand, title, notes, day, done, completed_at, deleted_at=None, pos=0.0):
        stamp = datetime.now().isoformat(timespec="seconds")
        conn.execute(
            "INSERT INTO tasks (title, notes, strand, day, pos, done, completed_at,"
            " created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (title, notes, strand, day, pos, done, completed_at, stamp, stamp, deleted_at),
        )

    # Work backwards from today across roughly six weeks, so the current month
    # and the one before it both hold a record worth exporting.
    start = today - timedelta(days=42)
    day = start
    i = 0
    while day <= today + timedelta(days=6):
        if day.weekday() < 5:                       # weekdays only
            for slot in range(rng.choice([1, 2, 2, 3])):
                strand, title, notes = WORK[i % len(WORK)]
                i += 1
                past = day < today
                # Most past work is done; a little is left hanging, which is
                # honest and makes the board look lived-in rather than staged.
                done = past and rng.random() < 0.82
                completed = (
                    datetime.combine(day, datetime.min.time())
                    .replace(hour=rng.randint(9, 18), minute=rng.randint(0, 59))
                    .isoformat(timespec="seconds")
                    if done else None
                )
                insert(strand, title, notes, day.isoformat(), int(done), completed,
                       pos=float(slot))
        day += timedelta(days=1)

    for slot, (strand, title, notes) in enumerate(UNSCHEDULED):
        insert(strand, title, notes, None, 0, None, pos=float(slot))

    # One ticked-then-deleted task, because "a deleted task that was done still
    # counts toward the month" is a rule people do not believe until they see it.
    gone = today - timedelta(days=9)
    insert("Campaigns", "Chase the agency for the revised quote", "",
           gone.isoformat(), 1,
           datetime.combine(gone, datetime.min.time()).replace(hour=15).isoformat(timespec="seconds"),
           deleted_at=datetime.now().isoformat(timespec="seconds"))

    conn.commit()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data-dir", required=True, help="directory to write donebook.db into")
    ap.add_argument("--config", help="config.json path (default: <data-dir>/config.json)")
    ap.add_argument("--password", default="demo", help="the demo password (default: demo)")
    args = ap.parse_args()

    data = Path(args.data_dir).expanduser().resolve()
    data.mkdir(parents=True, exist_ok=True)
    db = data / "donebook.db"
    cfg_path = Path(args.config).expanduser().resolve() if args.config else data / "config.json"

    db.unlink(missing_ok=True)
    conn = sqlite3.connect(db)
    try:
        build(conn, date.today())
        count = conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
    finally:
        conn.close()

    salt = secrets.token_hex(16)
    cfg_path.write_text(json.dumps({
        "secret_key": secrets.token_hex(32),
        "salt": salt,
        "password_hash": hashlib.pbkdf2_hmac(
            "sha256", args.password.encode(), salt.encode(), 240_000).hex(),
    }, indent=2) + "\n")
    cfg_path.chmod(0o600)

    print(f"seeded {count} tasks into {db}; password is {args.password!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
