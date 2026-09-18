from __future__ import annotations

import os
import socket
import threading
import time

import uvicorn
import webview

from .app import create_app
from .config import APP_HOST, APP_PORT, DATA_DIR
from .desktop_api import DesktopApi


def _run_server() -> None:
    uvicorn.run(create_app(), host=APP_HOST, port=APP_PORT, log_level="warning")


def _wait_for_server(host: str, port: int, timeout: float = 10.0) -> None:
    probe_host = "127.0.0.1" if host == "0.0.0.0" else host
    deadline = time.monotonic() + timeout

    while time.monotonic() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.2)
            if sock.connect_ex((probe_host, port)) == 0:
                return
        time.sleep(0.1)


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    server_thread = threading.Thread(target=_run_server, daemon=True)
    server_thread.start()
    _wait_for_server(APP_HOST, APP_PORT)

    # Debug distant WebView2 optionnel (developpement uniquement), pour piloter
    # la vraie fenetre native avec des outils type Playwright/CDP.
    remote_debug_port = os.environ.get("POLE_SCORING_REMOTE_DEBUG_PORT")
    if remote_debug_port:
        webview.settings["REMOTE_DEBUGGING_PORT"] = int(remote_debug_port)

    webview.create_window(
        "Pole Scoring",
        f"http://127.0.0.1:{APP_PORT}/",
        width=1280,
        height=800,
        min_size=(1024, 700),
        js_api=DesktopApi(),
    )
    webview.start()


if __name__ == "__main__":
    main()
