from pathlib import Path

from fastapi.testclient import TestClient

from cert_prep_backend.bootstrap.app import create_app
from cert_prep_backend.platform.config import Settings


def test_health_endpoint_returns_app_status(tmp_path: Path) -> None:
    client = TestClient(create_app(Settings(data_dir=tmp_path)))

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "app": "cert-prep-backend",
        "version": "0.1.0-alpha.1",
        "python_version": response.json()["python_version"],
        "runtime_mode": "source",
    }
