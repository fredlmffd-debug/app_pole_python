from __future__ import annotations

import uuid


def new_id() -> str:
    """Equivalent de `crypto.randomUUID()` cote Node."""
    return str(uuid.uuid4())
