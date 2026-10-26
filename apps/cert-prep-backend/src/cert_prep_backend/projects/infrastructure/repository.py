"""SQLite storage of projects."""

from __future__ import annotations

from sqlite3 import Row

from cert_prep_backend.platform.database import Database
from cert_prep_backend.projects.application.use_cases import require_project
from cert_prep_backend.projects.domain.project import Project, ProjectName


class SqliteProjectRepository:
    def __init__(self, db: Database) -> None:
        self._db = db

    def add(self, project: Project) -> None:
        with self._db.connect() as connection:
            connection.execute(
                """
                INSERT INTO projects(id, name, description, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    project.id,
                    project.name.value,
                    project.description,
                    project.created_at,
                    project.updated_at,
                ),
            )

    def get(self, project_id: str) -> Project | None:
        with self._db.connect() as connection:
            row = connection.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        return None if row is None else _project_from_row(row)

    def list_newest_first(self) -> list[Project]:
        with self._db.connect() as connection:
            rows = connection.execute("SELECT * FROM projects ORDER BY created_at DESC").fetchall()
        return [_project_from_row(row) for row in rows]

    def save(self, project: Project) -> bool:
        with self._db.connect() as connection:
            result = connection.execute(
                """
                UPDATE projects
                SET name = ?, description = ?, updated_at = ?
                WHERE id = ?
                """,
                (project.name.value, project.description, project.updated_at, project.id),
            )
        return result.rowcount == 1

    def remove(self, project_id: str) -> bool:
        with self._db.connect() as connection:
            result = connection.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        return result.rowcount != 0


def ensure_project_exists(db: Database, project_id: str) -> None:
    """Fail with NotFoundError unless the project exists; other contexts call this."""

    require_project(SqliteProjectRepository(db), project_id)


def _project_from_row(row: Row) -> Project:
    return Project(
        id=row["id"],
        name=ProjectName(row["name"]),
        description=row["description"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
