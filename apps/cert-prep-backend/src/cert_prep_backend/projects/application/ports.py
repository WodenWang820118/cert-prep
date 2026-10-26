"""What the Study Projects use cases need from storage."""

from __future__ import annotations

from typing import Protocol

from cert_prep_backend.projects.domain.project import Project


class ProjectRepository(Protocol):
    def add(self, project: Project) -> None: ...

    def get(self, project_id: str) -> Project | None: ...

    def list_newest_first(self) -> list[Project]: ...

    def save(self, project: Project) -> bool:
        """Store a changed project; False when it no longer exists."""
        ...

    def remove(self, project_id: str) -> bool:
        """Delete a project; False when it did not exist."""
        ...
