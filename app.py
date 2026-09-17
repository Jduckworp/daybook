"""Backwards-compatible entry point for ``gunicorn app:app``.

The application moved into the ``donebook`` package so it could be published
to PyPI. Existing deployments — the systemd unit in deploy/, and anything
else pointed at ``app:app`` from the repository root — keep working through
this shim. New deployments should use ``donebook.app:app`` or the ``donebook``
command.
"""

from donebook.app import app

__all__ = ["app"]

if __name__ == "__main__":
    from donebook.__main__ import main

    raise SystemExit(main(["--insecure-cookie"]))
