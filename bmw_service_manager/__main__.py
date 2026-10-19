"""Run the local web UI: ``python -m bmw_service_manager``."""

import argparse
import json
import logging
import socket
import urllib.request
import webbrowser

from werkzeug.serving import make_server

from . import __version__, simulator
from .hsfz import DIAG_PORT
from .web import create_app


def already_running(url: str) -> bool:
    """True when this app (not some other program) answers at `url`."""
    try:
        with urllib.request.urlopen(url + "api/meta", timeout=1) as res:
            return "item_types" in json.load(res)
    except (OSError, ValueError):
        return False


def port_free(bind: str, port: int) -> bool:
    """True if nothing is listening on the port. (Werkzeug exits the program instead of raising.)"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((bind, port))
            return True
        except OSError:
            return False


def main() -> None:
    parser = argparse.ArgumentParser(description="BMW head-unit service history manager")
    parser.add_argument("--bind", default="127.0.0.1", help="address for the web UI (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8800, help="port for the web UI (default 8800, or the next free one)")
    parser.add_argument("--simulate", action="store_true", help="talk to a built-in fake car instead of a real one")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser window")
    args = parser.parse_args()

    host, port = "", DIAG_PORT
    if args.simulate:
        server, _ = simulator.start()
        host, port = server.server_address
        print(f"Simulated car on {host}:{port}")

    app = create_app(default_host=host, default_port=port, simulated=args.simulate)
    web = None
    for p in range(args.port, args.port + 10):
        url = f"http://{args.bind}:{p}/"
        if not args.simulate and already_running(url):
            # Started twice (a second double-click): show the one that's running.
            print(f"BMW Service Manager is already running at {url}")
            if not args.no_browser:
                webbrowser.open(url)
            return
        if port_free(args.bind, p):
            web = make_server(args.bind, p, app, threaded=True)
            break
        # taken by another program: try the next port
    if web is None:
        raise SystemExit(f"Ports {args.port} to {args.port + 9} are all in use. Close another program, or start with --port.")

    logging.getLogger("werkzeug").setLevel(logging.WARNING)  # no line per request
    url = f"http://{'127.0.0.1' if args.bind in ('0.0.0.0', '') else args.bind}:{web.server_port}/"
    print(f"BMW Service Manager {__version__} is running.")
    print(f"Your web browser should open by itself. If it doesn't, open {url}")
    print("Leave this window open while you use it. Close it (or press Ctrl+C) to stop.")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        web.serve_forever()
    except KeyboardInterrupt:
        print("Stopped.")


if __name__ == "__main__":
    main()
