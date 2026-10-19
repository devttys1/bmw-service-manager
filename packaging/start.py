"""Starts the app from a standalone download: its own Python runs this with -I (ignoring any
Python, packages or settings already on the computer), so the paths are set here."""

import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [here, os.path.join(here, "vendor")]

from bmw_service_manager.__main__ import main  # noqa: E402

main()
