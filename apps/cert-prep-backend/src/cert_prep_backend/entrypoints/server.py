import os

import uvicorn


def main() -> None:
    host = os.environ.get("CERT_PREP_HOST", "127.0.0.1")
    port = int(os.environ.get("CERT_PREP_PORT", "8765"))
    uvicorn.run("cert_prep_backend.api.app:create_app", factory=True, host=host, port=port)


if __name__ == "__main__":
    main()
