"""The ``donebook`` command — run the board with a production server.

``python -m donebook`` works too. Everything the app itself reads comes from
the environment, so the flags here set environment variables *before* the app
module is imported; importing it earlier would freeze the old values.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from . import __version__

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765


def _parse(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="donebook",
        description="A task board that keeps the record.",
        epilog="The database and config default to ./data and ./config.json "
               "in the current directory. On first run Donebook prints a "
               "generated password to the console.",
    )
    p.add_argument("--host", default=DEFAULT_HOST,
                   help=f"interface to bind (default {DEFAULT_HOST})")
    p.add_argument("--port", type=int, default=DEFAULT_PORT,
                   help=f"port to bind (default {DEFAULT_PORT})")
    p.add_argument("--workers", type=int, default=2,
                   help="gunicorn worker processes (default 2)")
    p.add_argument("--data-dir", metavar="PATH",
                   help="where donebook.db lives (default ./data)")
    p.add_argument("--config", metavar="PATH",
                   help="session key, salt and password hash (default ./config.json)")
    p.add_argument("--insecure-cookie", action="store_true",
                   help="allow the session cookie over plain HTTP. Needed on a "
                        "LAN address with no TLS; drop it once a reverse proxy "
                        "terminates TLS.")
    p.add_argument("--version", action="version", version=f"donebook {__version__}")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse(argv)

    if args.data_dir:
        os.environ["DONEBOOK_DATA_DIR"] = str(Path(args.data_dir).expanduser().resolve())
    if args.config:
        os.environ["DONEBOOK_CONFIG"] = str(Path(args.config).expanduser().resolve())
    if args.insecure_cookie:
        os.environ["DONEBOOK_INSECURE_COOKIE"] = "1"

    from .app import app  # imported late, so the environment above is already set

    bind = f"{args.host}:{args.port}"

    try:
        from gunicorn.app.base import BaseApplication
    except ImportError:  # gunicorn does not run on Windows
        print(f"gunicorn unavailable — falling back to the development server "
              f"on http://{bind}", file=sys.stderr)
        app.run(host=args.host, port=args.port)
        return 0

    class _Served(BaseApplication):
        def load_config(self) -> None:
            self.cfg.set("bind", bind)
            self.cfg.set("workers", args.workers)
            self.cfg.set("threads", 4)
            self.cfg.set("timeout", 60)
            self.cfg.set("accesslog", "-")
            self.cfg.set("errorlog", "-")

        def load(self):
            return app

    _Served().run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
