from __future__ import annotations

from sqlite3 import Row

from cert_prep_backend.api.errors import NotFoundError


def fetch_practice_session_row(connection, project_id: str, session_id: str) -> Row | None:
    return connection.execute(
        "SELECT * FROM practice_sessions WHERE project_id = ? AND id = ?",
        (project_id, session_id),
    ).fetchone()


def ensure_project_row_exists(connection, project_id: str) -> None:
    row = connection.execute("SELECT 1 FROM projects WHERE id = ?", (project_id,)).fetchone()
    if row is None:
        raise NotFoundError("Project not found.")
