"""API Python exposee a la fenetre principale via js_api (pywebview), pour
que le frontend puisse ouvrir de vraies fenetres natives independantes
plutot que window.open() : ce dernier est systematiquement intercepte par
le backend WebView2 de pywebview (evenement NewWindowRequested) et
redirige vers le navigateur systeme au lieu d'ouvrir une fenetre de
l'application (cf. README, section "Phase 6bis")."""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING

import webview

if TYPE_CHECKING:
    from webview import Window

_child_windows: dict[str, "Window"] = {}
_child_windows_lock = threading.Lock()


def _safe_dimension(value: object, default: int) -> int:
    try:
        parsed = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default

    return parsed if parsed > 0 else default


def _make_forget_callback(window_key: str, window: "Window"):
    def _forget_window() -> None:
        with _child_windows_lock:
            if _child_windows.get(window_key) is window:
                del _child_windows[window_key]

    return _forget_window


class DesktopApi:
    """Expose a la fenetre principale (js_api=...) uniquement — les fenetres
    secondaires n'ont pas besoin d'en ouvrir d'autres elles-memes."""

    def __init__(self) -> None:
        # Assignee par __main__.py juste apres webview.create_window(), car
        # l'objet Window n'existe qu'une fois la fenetre principale creee
        # (elle-meme creee avec cette instance en js_api). Necessaire pour
        # toggle_fullscreen() : webview.active_window() s'appuie sur
        # WinForms.Form.ActiveForm, peu fiable depuis le thread des callbacks
        # js_api (pas le thread UI) — mieux vaut une reference directe.
        #
        # Prefixe _ obligatoire : inject_pywebview() (webview/util.py) parcourt
        # recursivement tout attribut PUBLIC non appelable de js_api pour y
        # decouvrir des methodes a exposer en JS, en sautant explicitement
        # ceux prefixes par _. Sans ce prefixe, un objet Window (qui expose
        # .native, un graphe .NET partiellement circulaire via pythonnet) se
        # fait parcourir integralement au demarrage : RecursionError et acces
        # a des proprietes WebView2 hors du thread UI (erreurs "[pywebview]
        # Error while processing main_window.native...." observees en ligne
        # de commande).
        self._main_window: "Window | None" = None

    def open_window(self, url: str, name: str = "", width: object = None, height: object = None) -> bool:
        window_key = str(name or url).strip() or str(url)

        with _child_windows_lock:
            existing = _child_windows.get(window_key)

            if existing is not None:
                try:
                    existing.restore()
                    existing.show()
                    return True
                except Exception:
                    _child_windows.pop(window_key, None)

            new_window = webview.create_window(
                "Pole Scoring",
                url,
                width=_safe_dimension(width, 1000),
                height=_safe_dimension(height, 800),
                min_size=(480, 360),
            )

            if new_window is None:
                return False

            _child_windows[window_key] = new_window
            new_window.events.closed += _make_forget_callback(window_key, new_window)

        return True

    def close_window(self, name: str) -> bool:
        window_key = str(name or "").strip()

        with _child_windows_lock:
            existing = _child_windows.pop(window_key, None)

        if existing is None:
            return False

        try:
            existing.destroy()
        except Exception:
            return False

        return True

    def toggle_fullscreen(self) -> bool:
        if self._main_window is None:
            return False

        try:
            self._main_window.toggle_fullscreen()
        except Exception:
            return False

        return True
