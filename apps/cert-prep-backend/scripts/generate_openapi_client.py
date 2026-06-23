from __future__ import annotations

import argparse
from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from openapi_client.io import (  # noqa: E402
    generate_openapi_outputs,
)


def main() -> None:
    """Generate the Angular API client from the backend OpenAPI schema."""
    parser = argparse.ArgumentParser(
        description="Generate the Angular API client from FastAPI OpenAPI."
    )
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--openapi-output", type=Path)
    args = parser.parse_args()

    generate_openapi_outputs(
        output=args.output,
        openapi_output=args.openapi_output,
    )


if __name__ == "__main__":
    main()
