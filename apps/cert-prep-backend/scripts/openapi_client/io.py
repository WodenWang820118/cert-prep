from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any

from cert_prep_backend.bootstrap.app import create_app
from cert_prep_backend.platform.config import Settings

from openapi_client.typescript import render_typescript


def load_openapi_schema() -> dict[str, Any]:
    """Build the FastAPI OpenAPI schema used as the generator source.

    Building the app opens and migrates the database in its data directory, so the
    generator gives it a temporary one: the default is the user's own database. The
    database name is fixed too, because an absolute ``CERT_PREP_DATABASE_NAME`` from
    the environment would otherwise point outside the temporary directory.
    """
    with tempfile.TemporaryDirectory(prefix="cert-prep-openapi-") as data_dir:
        app = create_app(
            Settings(
                api_token="contract-generation",
                data_dir=Path(data_dir),
                database_name="openapi-generation.sqlite3",
            )
        )
        return app.openapi()


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
