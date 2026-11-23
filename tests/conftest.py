"""Shared test setup: the pages' update check (/api/update) never asks GitHub during tests."""

import os

os.environ.setdefault("BOOSTBOOK_NO_UPDATE_CHECK", "1")
