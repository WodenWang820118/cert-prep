"""Use cases of the Study Projects context, named after what the user does."""

from __future__ import annotations

from uuid import uuid4

from cert_prep_backend.platform.errors import NotFoundError
from cert_prep_backend.projects.application.ports import ProjectRepository
from cert_prep_backend.projects.domain.project import Project, ProjectName

__all__ = [
    "create_project",
    "delete_project",
    "edit_project",
    "get_project",
    "list_projects",
    "require_project",
]

PROJECT_NOT_FOUND = "Project not found."


def create_project(
    projects: ProjectRepository, *, name: str, description: str, now: str
) -> Project:
    project = Project.start(
        project_id=str(uuid4()),
        name=ProjectName(name),
        description=description,
        now=now,
    )
    projects.add(project)
    return project


def list_projects(projects: ProjectRepository) -> list[Project]:
    return projects.list_newest_first()


def get_project(projects: ProjectRepository, project_id: str) -> Project:
    return require_project(projects, project_id)


def edit_project(
    projects: ProjectRepository,
    project_id: str,
    *,
    name: str | None,
    description: str | None,
    now: str,
) -> Project:
    project = require_project(projects, project_id).edit(
        name=None if name is None else ProjectName(name),
        description=description,
        now=now,
    )
    if not projects.save(project):
        raise NotFoundError(PROJECT_NOT_FOUND)
    return project


def delete_project(projects: ProjectRepository, project_id: str) -> None:
    if not projects.remove(project_id):
        raise NotFoundError(PROJECT_NOT_FOUND)


def require_project(projects: ProjectRepository, project_id: str) -> Project:
    """The project, for any work that belongs to one; NotFoundError when it is gone."""

    project = projects.get(project_id)
    if project is None:
        raise NotFoundError(PROJECT_NOT_FOUND)
    return project
