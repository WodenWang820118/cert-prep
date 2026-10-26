"""The Project aggregate: its name is never empty, and its identity and creation time never change."""

from __future__ import annotations

import pytest

from cert_prep_backend.platform.errors import ValidationError
from cert_prep_backend.projects.domain.project import Project, ProjectName

NOW = "2026-10-26T00:00:00+00:00"
LATER = "2026-10-27T00:00:00+00:00"


def _project() -> Project:
    return Project.start(
        project_id="project-1",
        name=ProjectName("JLPT N2"),
        description="Grammar",
        now=NOW,
    )


def test_a_project_name_is_never_empty() -> None:
    with pytest.raises(ValidationError):
        ProjectName("")


def test_a_project_name_is_kept_as_given() -> None:
    # The API accepts any non-empty name (min_length=1), including spaces.
    assert ProjectName(" ").value == " "


def test_a_new_project_is_created_and_updated_at_the_same_time() -> None:
    project = _project()

    assert project.created_at == NOW
    assert project.updated_at == NOW


def test_editing_changes_only_the_given_details() -> None:
    edited = _project().edit(name=None, description="Vocabulary", now=LATER)

    assert edited.name == ProjectName("JLPT N2")
    assert edited.description == "Vocabulary"
    assert edited.updated_at == LATER


def test_editing_keeps_the_identity_and_creation_time() -> None:
    edited = _project().edit(name=ProjectName("JLPT N1"), description=None, now=LATER)

    assert edited.id == "project-1"
    assert edited.created_at == NOW
    assert edited.name == ProjectName("JLPT N1")
    assert edited.description == "Grammar"
