from __future__ import annotations

from sqlite3 import Row
from uuid import uuid4

from exam_prep_backend.database import Database, utc_now
from exam_prep_backend.errors import NotFoundError
from exam_prep_backend.schemas import ProjectCreate, ProjectUpdate


def create_project(db: Database, payload: ProjectCreate) -> dict:
    project_id = str(uuid4())
    now = utc_now()
    with db.connect() as connection:
        connection.execute(
            """
            INSERT INTO projects(id, name, description, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (project_id, payload.name, payload.description, now, now),
        )
        row = connection.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    return _project_from_row(row)


def list_projects(db: Database) -> list[dict]:
    with db.connect() as connection:
        rows = connection.execute("SELECT * FROM projects ORDER BY created_at DESC").fetchall()
    return [_project_from_row(row) for row in rows]


def get_project(db: Database, project_id: str) -> dict:
    with db.connect() as connection:
        row = connection.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    if row is None:
        raise NotFoundError("Project not found.")
    return _project_from_row(row)


def update_project(db: Database, project_id: str, payload: ProjectUpdate) -> dict:
    existing = get_project(db, project_id)
    name = payload.name if payload.name is not None else existing["name"]
    description = payload.description if payload.description is not None else existing["description"]
    now = utc_now()
    with db.connect() as connection:
        connection.execute(
            """
            UPDATE projects
            SET name = ?, description = ?, updated_at = ?
            WHERE id = ?
            """,
            (name, description, now, project_id),
        )
        row = connection.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    return _project_from_row(row)


def delete_project(db: Database, project_id: str) -> None:
    with db.connect() as connection:
        result = connection.execute("DELETE FROM projects WHERE id = ?", (project_id,))
    if result.rowcount == 0:
        raise NotFoundError("Project not found.")


def ensure_project_exists(db: Database, project_id: str) -> None:
    get_project(db, project_id)


def _project_from_row(row: Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
