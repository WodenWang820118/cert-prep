from pathlib import Path

from fastapi.testclient import TestClient

from exam_prep_backend.app import create_app
from exam_prep_backend.config import Settings, default_data_dir


def test_health_is_public_but_other_endpoints_require_bearer_auth(tmp_path: Path) -> None:
    client = TestClient(create_app(settings=Settings(data_dir=tmp_path, api_token="secret")))

    assert client.get("/health").status_code == 200
    unauthorized = client.get("/projects")
    assert unauthorized.status_code == 401
    assert unauthorized.json() == {"code": "unauthorized", "message": "Bearer token required."}
    assert client.get("/projects", headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_missing_api_token_fails_closed(tmp_path: Path) -> None:
    client = TestClient(create_app(settings=Settings(data_dir=tmp_path)))

    response = client.get("/projects", headers={"Authorization": "Bearer anything"})

    assert response.status_code == 401
    assert response.json() == {
        "code": "unauthorized",
        "message": "API token is not configured.",
    }


def test_cors_allows_configured_dev_origin(tmp_path: Path) -> None:
    client = TestClient(create_app(settings=Settings(data_dir=tmp_path, api_token="secret")))

    response = client.options(
        "/projects",
        headers={
            "Origin": "http://localhost:4200",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "Authorization",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:4200"


def test_default_data_dir_is_absolute_and_app_specific(monkeypatch) -> None:
    monkeypatch.delenv("EXAM_PREP_DATA_DIR", raising=False)
    data_dir = default_data_dir()

    assert data_dir.is_absolute()
    assert "exam-prep-backend" in str(data_dir).lower()


def test_llm_health_uses_fake_provider_without_network(client: TestClient, auth_headers) -> None:
    response = client.get("/llm/health", headers=auth_headers)

    assert response.status_code == 200
    assert response.json() == {
        "provider": "fake",
        "model": "gemma4:12b",
        "available": True,
        "detail": "deterministic local fake provider",
    }
