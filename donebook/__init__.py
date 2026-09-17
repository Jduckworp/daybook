"""Donebook — a task board that keeps the record.

The Flask application lives in :mod:`donebook.app`. Importing it has side
effects (it reads the environment and opens the data directory), so it is not
imported here — ``from donebook.app import app`` when you want it.
"""

__version__ = "1.1.0"
__all__ = ["__version__"]
