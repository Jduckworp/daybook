# Daybook

A task board that keeps the record.

Schedule tasks onto days, drag them around, tick them off. The difference
from every other todo app is what happens next: **nothing you finish is ever
thrown away.** At the end of the month you can export exactly what got done,
grouped by workstream or as a chronology — the thing you actually need when
someone asks what you have been working on.

Single user, single password, one SQLite file, no accounts, no cloud, no
telemetry. About 1,600 lines of Python and vanilla JavaScript, plus a
stylesheet — no build step, no frontend framework, no npm.

## Why

Todoist and its relatives are built around the idea that a completed task is
finished business — it disappears, or it goes into an archive you will never
open. That is fine if a todo list is all you want. It is useless if you also
need to answer "what did I do in September?", which for a lot of people comes
round every month.

Daybook treats the completed task as the point. Ticking something is not
deletion, it is a dated entry in a record that you can read back, export and
hand to somebody.

## What it does

- **Month or week board.** The same board either way; week gives full-height
  day columns. Below 900px it collapses to a single scrolling column of days,
  which is the layout that works on a phone.
- **An Unscheduled rail** for things not yet committed to a date. Drag onto a
  day to schedule, drag back to take it off the calendar.
- **Workstreams** (`strand`) — free text, used to group the monthly record.
- **The record.** Pick a month, then copy it as Markdown, or download `.md`
  or `.csv`. Grouped by workstream by default, which is usually the shape a
  report to management wants; switch to by-day for a chronology.
- **Installs to a home screen** as a PWA, and the last board you loaded stays
  readable when you go offline. Signing out drops that cached copy, so the
  next person to pick the phone up cannot read it without the password.

Three rules keep the record honest:

- Ticking a task stamps `completed_at` with the **browser's local time**, so
  the record matches the day you actually worked, whatever timezone the
  server thinks it is in.
- Deleting is a soft delete. The task leaves the board, but if it had been
  ticked it still counts toward that month's record.
- Ticking something straight off the Unscheduled rail files it under today,
  so unplanned work still lands in the record.

## Install

Requires Python 3.10+.

```bash
git clone https://github.com/YOURNAME/daybook.git
cd daybook
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
DAYBOOK_INSECURE_COOKIE=1 .venv/bin/python app.py
```

Open <http://127.0.0.1:8765>. On first boot Daybook writes a `config.json`
containing a fresh session key, a salt, and a **randomly generated password
which it prints to the console**. Sign in with that, then change it (below).

`DAYBOOK_INSECURE_COOKIE=1` is needed only because you are on plain HTTP.
Drop it the moment there is TLS in front.

## Deploy

`deploy/` has a systemd unit and an nginx server block to copy and edit.
The short version: run it under gunicorn bound to `127.0.0.1`, put nginx in
front to terminate TLS, and let the session cookie stay `Secure`.

```bash
sudo cp deploy/daybook.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now daybook
```

Daybook has **one password and no user accounts**. Do not put it on a public
hostname without TLS, and think twice before putting it on a public hostname
at all — a private network or a VPN such as Tailscale is a better fit for
what this is.

Failed logins are rate limited: five wrong passwords close the door for a
minute, and the wait doubles with each further attempt up to an hour.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DAYBOOK_DATA_DIR` | `./data` | Where `daybook.db` lives |
| `DAYBOOK_CONFIG` | `./config.json` | Session key, salt, password hash |
| `DAYBOOK_INSECURE_COOKIE` | unset | Set to `1` to allow the session cookie over plain HTTP |

`config.json` is written mode 600 and must stay out of version control —
it is in `.gitignore` already.

### Changing the password

```bash
.venv/bin/python - <<'PY'
import json, pathlib
from app import hash_password
cfg = json.loads(pathlib.Path("config.json").read_text())
cfg["password_hash"] = hash_password("YOUR NEW PASSWORD", cfg["salt"])
cfg.pop("initial_password", None)
pathlib.Path("config.json").write_text(json.dumps(cfg, indent=2) + "\n")
PY
sudo systemctl restart daybook
```

Existing sessions survive, because they are signed with `secret_key`, not the
password. Rotate `secret_key` too if you want to sign everyone out.

## The data is yours

One SQLite table, no ORM, no migrations framework. Read the record without
the app whenever you like:

```bash
sqlite3 data/daybook.db \
  "SELECT completed_at, strand, title, notes FROM tasks
   WHERE done = 1 AND completed_at LIKE '2026-09%'
   ORDER BY completed_at;"
```

| column | meaning |
|---|---|
| `title` / `notes` | the task, and the detail that lands in the report |
| `strand` | workstream, free text, groups the monthly record |
| `day` | `YYYY-MM-DD`, or `NULL` for the Unscheduled rail |
| `pos` | order within a day; rewritten on every drop |
| `done` / `completed_at` | the record. `completed_at` is local time |
| `deleted_at` | soft delete; ignored by the report |

Back it up by copying the file. That is the whole backup story.

## Keyboard and gestures

- **`/`** focuses the quick-add box, **Esc** closes the detail panel.
- The period label doubles as a "jump to today" button.
- Mouse drags start on movement; touch needs a short press first, so a flick
  still scrolls the list rather than picking a card up.

## Theming

Every colour is a custom property on `:root` at the top of
`static/app.css`. Override that block and nothing else to reskin the app.

## Contributing

Issues and pull requests are welcome. It is a small, deliberately
unambitious app — the aim is a tool that still works unchanged in ten years,
so proposals that add a build step, a framework or a second service are
unlikely to land.

## Licence

MIT. See [LICENSE](LICENSE).
