from fastapi.testclient import TestClient

from cert_prep_backend.api.app import create_app


def test_health_endpoint_returns_app_status() -> None:
    client = TestClient(create_app())

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "app": "cert-prep-backend",
        "version": "0.1.0",
        "python_version": response.json()["python_version"],
        "runtime_mode": "source",
    }
