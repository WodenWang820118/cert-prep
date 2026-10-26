"""The Project aggregate: the scope of the sources, questions and practice of one exam."""

from __future__ import annotations

from dataclasses import dataclass, replace

from cert_prep_backend.platform.errors import ValidationError


@dataclass(frozen=True, slots=True)
class ProjectName:
    """A project's name; it is never empty."""

    value: str

    def __post_init__(self) -> None:
        if not isinstance(self.value, str) or not self.value:
            raise ValidationError("Project name must not be empty.")


@dataclass(frozen=True, slots=True)
class Project:
    """A study project. Its identity and creation time never change."""

    id: str
    name: ProjectName
    description: str
    created_at: str
    updated_at: str

    @classmethod
    def start(cls, *, project_id: str, name: ProjectName, description: str, now: str) -> Project:
        return cls(
            id=project_id,
            name=name,
            description=description,
            created_at=now,
            updated_at=now,
        )

    def edit(self, *, name: ProjectName | None, description: str | None, now: str) -> Project:
        """Change the given details; a detail left as None keeps its value."""

        return replace(
            self,
            name=self.name if name is None else name,
            description=self.description if description is None else description,
            updated_at=now,
        )
