"""Study Projects use cases against an in-memory repository."""

from __future__ import annotations

import pytest

from cert_prep_backend.platform.errors import NotFoundError, ValidationError
from cert_prep_backend.projects.application import use_cases
from cert_prep_backend.projects.domain.project import Project, ProjectName


class InMemoryProjects:
    def __init__(self) -> None:
        self.projects: dict[str, Project] = {}

    def add(self, project: Project) -> None:
        self.projects[project.id] = project

    def get(self, project_id: str) -> Project | None:
        return self.projects.get(project_id)

    def list_newest_first(self) -> list[Project]:
        return sorted(self.projects.values(), key=lambda project: project.created_at, reverse=True)

    def save(self, project: Project) -> bool:
        if project.id not in self.projects:
            return False
        self.projects[project.id] = project
        return True

    def remove(self, project_id: str) -> bool:
        return self.projects.pop(project_id, None) is not None


def test_creating_a_project_stores_it() -> None:
    projects = InMemoryProjects()

    project = use_cases.create_project(projects, name="JLPT N2", description="", now="t1")

    assert projects.get(project.id) == project
    assert project.name == ProjectName("JLPT N2")


def test_projects_are_listed_newest_first() -> None:
    projects = InMemoryProjects()
    older = use_cases.create_project(projects, name="Older", description="", now="t1")
    newer = use_cases.create_project(projects, name="Newer", description="", now="t2")

    assert use_cases.list_projects(projects) == [newer, older]


def test_editing_a_project_keeps_what_is_not_given() -> None:
    projects = InMemoryProjects()
    project = use_cases.create_project(projects, name="JLPT N2", description="Grammar", now="t1")

    edited = use_cases.edit_project(
        projects, project.id, name=None, description="Vocabulary", now="t2"
    )

    assert edited.name == ProjectName("JLPT N2")
    assert edited.description == "Vocabulary"
    assert projects.get(project.id) == edited


def test_a_project_cannot_be_renamed_to_nothing() -> None:
    projects = InMemoryProjects()
    project = use_cases.create_project(projects, name="JLPT N2", description="", now="t1")

    with pytest.raises(ValidationError):
        use_cases.edit_project(projects, project.id, name="", description=None, now="t2")
    assert projects.get(project.id) == project


@pytest.mark.parametrize(
    "use_case",
    [
        lambda projects: use_cases.get_project(projects, "missing"),
        lambda projects: use_cases.require_project(projects, "missing"),
        lambda projects: use_cases.delete_project(projects, "missing"),
        lambda projects: use_cases.edit_project(
            projects, "missing", name="Name", description=None, now="t1"
        ),
    ],
)
def test_a_missing_project_is_not_found(use_case) -> None:
    with pytest.raises(NotFoundError, match="^Project not found.$"):
        use_case(InMemoryProjects())


def test_deleting_a_project_removes_it() -> None:
    projects = InMemoryProjects()
    project = use_cases.create_project(projects, name="JLPT N2", description="", now="t1")

    use_cases.delete_project(projects, project.id)

    assert projects.get(project.id) is None
