import os

import uvicorn

from cert_prep_backend.platform.frozen_extraction_residue import start_stale_extraction_sweep


def main() -> None:
    host = os.environ.get("CERT_PREP_HOST", "127.0.0.1")
    port = int(os.environ.get("CERT_PREP_PORT", "8765"))
    start_stale_extraction_sweep()
    # Imported late, as when uvicorn loaded the factory from its import path.
    from cert_prep_backend.bootstrap.app import create_app

    uvicorn.run(create_app, factory=True, host=host, port=port)


if __name__ == "__main__":
    main()
