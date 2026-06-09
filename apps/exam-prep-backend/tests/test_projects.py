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
    assert project["name"] == "Security+"
    assert project["description"] == "SY0 practice"

    project_id = project["id"]
    listed = client.get("/projects", headers=auth_headers)
    assert listed.status_code == 200
    assert listed.json()["items"][0]["id"] == project_id

    updated = client.patch(
        f"/projects/{project_id}",
        headers=auth_headers,
        json={"name": "Security+ 701"},
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "Security+ 701"

    fetched = client.get(f"/projects/{project_id}", headers=auth_headers)
    assert fetched.status_code == 200
    assert fetched.json()["name"] == "Security+ 701"

    database_path = tmp_path / "exam-prep.sqlite3"
    assert database_path.exists()
    with sqlite3.connect(database_path) as connection:
        versions = [
            row[0] for row in connection.execute("SELECT version FROM schema_migrations ORDER BY version")
        ]
    assert versions == [1, 2, 3, 4, 5]

    deleted = client.delete(f"/projects/{project_id}", headers=auth_headers)
    assert deleted.status_code == 204
    assert client.get(f"/projects/{project_id}", headers=auth_headers).status_code == 404
