from __future__ import annotations

from fastapi import APIRouter, Depends, Response, status

from exam_prep_backend import projects_store
from exam_prep_backend.database import Database
from exam_prep_backend.dependencies import get_database
from exam_prep_backend.errors import NotFoundError, not_found_error
from exam_prep_backend.schemas import ProjectCreate, ProjectList, ProjectRead, ProjectUpdate


router = APIRouter(prefix="/projects", tags=["projects"])


@router.post("", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
def create_project(payload: ProjectCreate, db: Database = Depends(get_database)) -> dict:
    return projects_store.create_project(db, payload)


@router.get("", response_model=ProjectList)
def list_projects(db: Database = Depends(get_database)) -> dict:
    return {"items": projects_store.list_projects(db)}


@router.get("/{project_id}", response_model=ProjectRead)
def get_project(project_id: str, db: Database = Depends(get_database)) -> dict:
    try:
        return projects_store.get_project(db, project_id)
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@router.patch("/{project_id}", response_model=ProjectRead)
def update_project(
    project_id: str,
    payload: ProjectUpdate,
    db: Database = Depends(get_database),
) -> dict:
    try:
        return projects_store.update_project(db, project_id, payload)
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(project_id: str, db: Database = Depends(get_database)) -> Response:
    try:
        projects_store.delete_project(db, project_id)
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)
