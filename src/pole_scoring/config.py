from __future__ import annotations

import os
from pathlib import Path

from platformdirs import user_data_dir

APP_HOST = os.environ.get("APP_HOST", "0.0.0.0")
APP_PORT = int(os.environ.get("APP_PORT", "4380"))

_data_dir_override = os.environ.get("POLE_SCORING_DATA_DIR")

DATA_DIR = (
    Path(_data_dir_override)
    if _data_dir_override
    else Path(user_data_dir("PoleScoringLocal", appauthor=False, roaming=False)) / "data"
)

DB_FILE = DATA_DIR / "pole-scoring.sqlite"
