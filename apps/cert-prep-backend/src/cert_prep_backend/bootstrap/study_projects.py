"""Study Projects' `project_exists`, for the contexts that only need to know a project is there.

Practice, Source Library, and Question Authoring each define a port with `exists(project_id)`;
this adapter serves them.
"""

from __future__ import annotations

from sqlite3 import Connection

from cert_prep_backend.authoring.application.ports import StudyProjects as AuthoringStudyProjects
from cert_prep_backend.platform.database import Database
from cert_prep_backend.projects.application import use_cases as projects
from cert_prep_backend.projects.application.ports import ProjectRepository
from cert_prep_backend.projects.infrastructure.repository import SqliteProjectRepository


class ProjectExistence:
    """Study Projects' `project_exists`, for a context's `StudyProjects` port."""

    def __init__(self, projects_repository: ProjectRepository) -> None:
        self._projects = projects_repository

    def exists(self, project_id: str) -> bool:
        return projects.project_exists(self._projects, project_id)


def authoring_projects(
    db: Database, connection: Connection | None = None
) -> AuthoringStudyProjects:
    return ProjectExistence(SqliteProjectRepository(db, connection))
