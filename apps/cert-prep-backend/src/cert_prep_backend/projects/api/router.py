from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response, status

from cert_prep_backend.api.errors import not_found_error
from cert_prep_backend.platform.database import utc_now
from cert_prep_backend.platform.errors import NotFoundError
from cert_prep_backend.projects.api.schemas import (
    ProjectCreate,
    ProjectList,
    ProjectRead,
    ProjectUpdate,
)
from cert_prep_backend.projects.application import use_cases
from cert_prep_backend.projects.application.ports import ProjectRepository
from cert_prep_backend.projects.domain.project import Project


router = APIRouter(prefix="/projects", tags=["projects"])


def get_project_repository(request: Request) -> ProjectRepository:
    """The repository create_app wires for this application."""

    return request.app.state.project_repository


@router.post("", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
def create_project(
    payload: ProjectCreate,
    projects: ProjectRepository = Depends(get_project_repository),
) -> ProjectRead:
    project = use_cases.create_project(
        projects,
        name=payload.name,
        description=payload.description,
        now=utc_now(),
    )
    return _project_read(project)


@router.get("", response_model=ProjectList)
def list_projects(
    projects: ProjectRepository = Depends(get_project_repository),
) -> ProjectList:
    return ProjectList(items=[_project_read(project) for project in use_cases.list_projects(projects)])


@router.get("/{project_id}", response_model=ProjectRead)
def get_project(
    project_id: str,
    projects: ProjectRepository = Depends(get_project_repository),
) -> ProjectRead:
    try:
        return _project_read(use_cases.get_project(projects, project_id))
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@router.patch("/{project_id}", response_model=ProjectRead)
def update_project(
    project_id: str,
    payload: ProjectUpdate,
    projects: ProjectRepository = Depends(get_project_repository),
) -> ProjectRead:
    try:
        project = use_cases.edit_project(
            projects,
            project_id,
            name=payload.name,
            description=payload.description,
            now=utc_now(),
        )
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    return _project_read(project)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: str,
    projects: ProjectRepository = Depends(get_project_repository),
) -> Response:
    try:
        use_cases.delete_project(projects, project_id)
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _project_read(project: Project) -> ProjectRead:
    return ProjectRead(
        id=project.id,
        name=project.name.value,
        description=project.description,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )
