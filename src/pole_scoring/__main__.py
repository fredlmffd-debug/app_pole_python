from __future__ import annotations

import os
import socket
import threading
import time

import uvicorn
import webview

from .app import create_app
from .config import APP_HOST, APP_PORT, DATA_DIR
from .db.connection import get_db
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


def _checkpoint_and_close_database() -> None:
    # webview.start() bloque tant qu'une fenetre est ouverte ; une fois qu'il
    # revient, l'utilisateur a ferme l'appli. Sans ce checkpoint, le fichier
    # .sqlite reste fige a l'etat du dernier checkpoint automatique SQLite
    # (seuil ~1000 pages de WAL) et les ecritures recentes ne restent
    # visibles que via -wal/-shm, ce qui rend le .sqlite trompeur pour qui
    # l'ouvre seul dans un outil externe (ex. SQLiteStudio).
    try:
        db = get_db()
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        db.close()
    except Exception:
        pass


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
    _checkpoint_and_close_database()


if __name__ == "__main__":
    main()
