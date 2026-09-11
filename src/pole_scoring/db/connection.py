from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

from .schema import (
    ALTER_TABLE_STATEMENTS,
    CREATE_TABLES_SQL,
    INDEXES_AND_MIGRATION_SQL,
    VIEW_AND_TRIGGERS_SQL,
)


class Database:
    """Wrapper autour de sqlite3, verrouille pour un acces concurrent sur
    depuis plusieurs threads (les requetes juges arrivent en parallele
    depuis les tablettes), a l'image du mode synchrone de node:sqlite."""

    def __init__(self, db_file: Path) -> None:
        db_file.parent.mkdir(parents=True, exist_ok=True)
        (db_file.parent / "archives").mkdir(parents=True, exist_ok=True)

        self._lock = threading.RLock()
        self._connection = sqlite3.connect(str(db_file), check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._connection.isolation_level = None  # autocommit; transactions gerees explicitement

        self._init_schema()

    def _init_schema(self) -> None:
        with self._lock:
            self._connection.execute("PRAGMA journal_mode = WAL")
            self._connection.execute("PRAGMA foreign_keys = ON")
            self._connection.executescript(CREATE_TABLES_SQL)

            for statement in ALTER_TABLE_STATEMENTS:
                try:
                    self._connection.execute(statement)
                except sqlite3.OperationalError:
                    pass

            self._connection.executescript(INDEXES_AND_MIGRATION_SQL)
            self._connection.executescript(VIEW_AND_TRIGGERS_SQL)

    def execute(self, sql: str, params: dict | tuple = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._connection.execute(sql, params)

    def query_one(self, sql: str, params: dict | tuple = ()) -> dict | None:
        with self._lock:
            row = self._connection.execute(sql, params).fetchone()
            return dict(row) if row is not None else None

    def query_all(self, sql: str, params: dict | tuple = ()) -> list[dict]:
        with self._lock:
            rows = self._connection.execute(sql, params).fetchall()
            return [dict(row) for row in rows]

    def transaction(self):
        return _Transaction(self)

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    @property
    def raw_connection(self) -> sqlite3.Connection:
        return self._connection

    @property
    def lock(self) -> threading.RLock:
        return self._lock


class _Transaction:
    """Context manager BEGIN IMMEDIATE / COMMIT / ROLLBACK, verrouille pour
    garantir qu'une seule transaction ecrit a la fois."""

    def __init__(self, database: Database) -> None:
        self._database = database

    def __enter__(self) -> Database:
        self._database.lock.acquire()
        self._database.raw_connection.execute("BEGIN IMMEDIATE")
        return self._database

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        try:
            if exc_type is None:
                self._database.raw_connection.execute("COMMIT")
            else:
                self._database.raw_connection.execute("ROLLBACK")
        finally:
            self._database.lock.release()


_instance: Database | None = None
_instance_lock = threading.Lock()


def get_db() -> Database:
    global _instance

    if _instance is None:
        with _instance_lock:
            if _instance is None:
                from ..config import DB_FILE

                _instance = Database(DB_FILE)

    return _instance
