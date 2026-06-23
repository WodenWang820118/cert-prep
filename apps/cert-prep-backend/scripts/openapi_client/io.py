from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from cert_prep_backend.app import create_app
from cert_prep_backend.config import Settings

from openapi_client.typescript import render_typescript


def load_openapi_schema() -> dict[str, Any]:
    """Build the FastAPI OpenAPI schema used as the generator source."""
    return create_app(Settings(api_token="contract-generation")).openapi()


def generate_openapi_outputs(
    *,
    output: Path,
    openapi_output: Path | None,
) -> None:
    """Generate the TypeScript client and optional OpenAPI JSON snapshot."""
    openapi = load_openapi_schema()
    write_typescript_client(output, render_typescript(openapi))
    if openapi_output is not None:
        write_openapi_schema(openapi_output, openapi)


def write_typescript_client(output: Path, generated: str) -> None:
    """Write the generated TypeScript client with LF line endings."""
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(generated, encoding="utf-8", newline="\n")


def write_openapi_schema(output: Path, openapi: dict[str, Any]) -> None:
    """Write the sorted OpenAPI JSON snapshot with LF line endings."""
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(openapi, indent=2, sort_keys=True),
        encoding="utf-8",
        newline="\n",
    )
