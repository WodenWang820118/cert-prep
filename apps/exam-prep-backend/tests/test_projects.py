import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from exam_prep_backend.app import create_app
from exam_prep_backend.config import Settings


def test_project_crud_and_versioned_migrations(tmp_path: Path, auth_headers) -> None:
    settings = Settings(data_dir=tmp_path, api_token="test-token", llm_provider="fake")
    client = TestClient(create_app(settings=settings))

    created = client.post(
        "/projects",
        headers=auth_headers,
        json={"name": "Security+", "description": "SY0 practice"},
    )
    assert created.status_code == 201
    project = created.json()
    _assert_project_shape(project)
    assert project["name"] == "Security+"
    assert project["description"] == "SY0 practice"

    project_id = project["id"]
    listed = client.get("/projects", headers=auth_headers)
    assert listed.status_code == 200
    assert listed.json()["items"][0] == project

    updated = client.patch(
        f"/projects/{project_id}",
        headers=auth_headers,
        json={"name": "Security+ 701"},
    )
    assert updated.status_code == 200
    updated_project = updated.json()
    _assert_project_shape(updated_project)
    assert updated_project["name"] == "Security+ 701"
    assert updated_project["description"] == "SY0 practice"

    fetched = client.get(f"/projects/{project_id}", headers=auth_headers)
    assert fetched.status_code == 200
    assert fetched.json() == updated_project

    database_path = tmp_path / "exam-prep.sqlite3"
    assert database_path.exists()
    with sqlite3.connect(database_path) as connection:
        versions = [
            row[0] for row in connection.execute("SELECT version FROM schema_migrations ORDER BY version")
        ]
    assert versions == [1, 2, 3, 4, 5, 6, 7]

    deleted = client.delete(f"/projects/{project_id}", headers=auth_headers)
    assert deleted.status_code == 204
    missing = client.get(f"/projects/{project_id}", headers=auth_headers)
    assert missing.status_code == 404
    assert missing.json() == {"code": "not_found", "message": "Project not found."}


def test_project_not_found_errors_use_json_envelope(tmp_path: Path, auth_headers) -> None:
    settings = Settings(data_dir=tmp_path, api_token="test-token", llm_provider="fake")
    client = TestClient(create_app(settings=settings))

    missing_update = client.patch(
        "/projects/missing-project",
        headers=auth_headers,
        json={"description": "new description"},
    )
    assert missing_update.status_code == 404
    assert missing_update.json() == {"code": "not_found", "message": "Project not found."}

    missing_delete = client.delete("/projects/missing-project", headers=auth_headers)
    assert missing_delete.status_code == 404
    assert missing_delete.json() == {"code": "not_found", "message": "Project not found."}


def _assert_project_shape(project: dict) -> None:
    assert set(project) == {"id", "name", "description", "created_at", "updated_at"}
    assert isinstance(project["id"], str)
    assert isinstance(project["name"], str)
    assert isinstance(project["description"], str)
    assert isinstance(project["created_at"], str)
    assert isinstance(project["updated_at"], str)
