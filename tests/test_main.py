"""Starting the app: a taken port moves it to the next one; a second start finds the first."""

import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def start(*args):
    return subprocess.Popen([sys.executable, "-m", "bmw_service_manager", "--no-browser", *args], cwd=ROOT,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)


def wait_for(url, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            return urllib.request.urlopen(url, timeout=1).read()
        except OSError:
            time.sleep(0.2)
    raise AssertionError(f"nothing at {url}")


def test_taken_port_moves_to_the_next_and_a_second_start_finds_the_first():
    blocker = socket.socket()
    blocker.bind(("127.0.0.1", 0))
    blocker.listen()
    port = blocker.getsockname()[1]
    first = start("--port", str(port))
    try:
        assert b"BMW Service History" in wait_for(f"http://127.0.0.1:{port + 1}/")
        second = start("--port", str(port))
        out, _ = second.communicate(timeout=20)
        assert second.returncode == 0 and f"already running at http://127.0.0.1:{port + 1}/" in out
    finally:
        first.terminate()
        first.wait(timeout=10)
        blocker.close()
