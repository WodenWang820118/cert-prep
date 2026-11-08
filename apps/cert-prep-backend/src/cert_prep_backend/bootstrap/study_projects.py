"""Study Projects' `project_exists`, for the contexts that only need to know a project is there.

Practice and Source Library each define a port with `exists(project_id)`; this adapter serves
both.
"""

from __future__ import annotations

from cert_prep_backend.projects.application import use_cases as projects
from cert_prep_backend.projects.application.ports import ProjectRepository


class ProjectExistence:
    """Study Projects' `project_exists`, for a context's `StudyProjects` port."""

    def __init__(self, projects_repository: ProjectRepository) -> None:
        self._projects = projects_repository

    def exists(self, project_id: str) -> bool:
        return projects.project_exists(self._projects, project_id)
