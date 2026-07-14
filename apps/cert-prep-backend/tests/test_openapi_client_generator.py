from __future__ import annotations

import sys
from pathlib import Path

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
TRACKED_CLIENT = (
    Path(__file__).resolve().parents[3]
    / "libs"
    / "cert-prep-api"
    / "src"
    / "lib"
    / "cert-prep-api.generated.ts"
)
sys.path.insert(0, str(SCRIPTS_DIR))

from openapi_client.typescript import render_typescript  # noqa: E402


def _schema(*, request_required: bool = True) -> dict:
    return {
        "components": {
            "schemas": {
                "Payload": {
                    "type": "object",
                    "properties": {"value": {"type": "string"}},
                    "required": ["value"],
                },
                "DocumentOperationStatus": {
                    "type": "string",
                    "enum": ["queued", "running", "canceled"],
                },
                "DraftGenerationJobStatus": {
                    "type": "string",
                    "enum": ["pending", "running", "canceled"],
                },
                "FastFlowLMTermsDecision": {
                    "type": "string",
                    "enum": ["accepted", "declined"],
                },
                "ManualDraftOperationStatus": {
                    "type": "string",
                    "enum": ["queued", "running", "canceled"],
                },
                "RuntimeInstallationStatus": {
                    "type": "string",
                    "enum": ["queued", "running", "canceled"],
                },
                "LegacyStatus": {
                    "type": "string",
                    "enum": ["first", "second"],
                },
            }
        },
        "paths": {
            "/examples/{example_id}": {
                "get": {
                    "operationId": "get_example",
                    "responses": {"204": {"description": "No content"}},
                },
                "post": {
                    "operationId": "run_example",
                    "requestBody": {
                        "required": request_required,
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/Payload"}
                            }
                        },
                    },
                    "responses": {"204": {"description": "No content"}},
                },
            }
        },
    }


def test_generated_client_exposes_request_options_as_the_last_argument() -> None:
    output = render_typescript(_schema())

    assert "export interface CertPrepRequestOptions {" in output
    assert "headers?: Readonly<Record<string, string>>;" in output
    assert "signal?: AbortSignal;" in output
    assert (
        "getExample(exampleId: string, options?: CertPrepRequestOptions): Promise<void>"
        in output
    )
    assert (
        "runExample(exampleId: string, body: Components['schemas']['Payload'], "
        "options?: CertPrepRequestOptions): Promise<void>"
        in output
    )


def test_generated_client_conditionally_forwards_headers_and_abort_signal() -> None:
    output = render_typescript(_schema())

    assert "headers?: Readonly<Record<string, string>>;" in output
    assert "signal?: AbortSignal;" in output
    assert "{ headers: options.headers }" in output
    assert "{ signal: options.signal }" in output
    assert "headers: undefined" not in output
    assert "signal: undefined" not in output


def test_generated_client_preserves_openapi_enum_literals() -> None:
    output = render_typescript(_schema())

    assert 'DocumentOperationStatus: "queued" | "running" | "canceled";' in output
    assert 'DraftGenerationJobStatus: "pending" | "running" | "canceled";' in output
    assert 'FastFlowLMTermsDecision: "accepted" | "declined";' in output
    assert 'ManualDraftOperationStatus: "queued" | "running" | "canceled";' in output
    assert 'RuntimeInstallationStatus: "queued" | "running" | "canceled";' in output
    assert "LegacyStatus: string;" in output


def test_generated_client_preserves_optional_request_body() -> None:
    output = render_typescript(_schema(request_required=False))

    assert "runExample(exampleId: string, body?: Components['schemas']['Payload']" in output


def test_generated_client_preserves_required_request_body() -> None:
    output = render_typescript(_schema(request_required=True))

    assert "runExample(exampleId: string, body: Components['schemas']['Payload']" in output


def test_tracked_client_is_byte_exact_for_live_openapi(tmp_path: Path) -> None:
    openapi = create_app(
        Settings(data_dir=tmp_path, api_token="client-drift-check")
    ).openapi()

    assert TRACKED_CLIENT.read_bytes() == render_typescript(openapi).encode("utf-8")
