import os

import uvicorn

from exam_prep_backend.app import create_app


app = create_app()


def main() -> None:
    host = os.environ.get("EXAM_PREP_HOST", "127.0.0.1")
    port = int(os.environ.get("EXAM_PREP_PORT", "8765"))
    uvicorn.run("exam_prep_backend.app:create_app", factory=True, host=host, port=port)


if __name__ == "__main__":
    main()
