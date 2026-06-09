from fastapi import FastAPI
from pydantic import BaseModel

from exam_prep_backend import __version__


class HealthResponse(BaseModel):
    status: str
    app: str
    version: str


def create_app() -> FastAPI:
    app = FastAPI(
        title="Exam Prep Backend",
        version=__version__,
        summary="Local sidecar API for the exam prep desktop app.",
    )

    @app.get("/health", response_model=HealthResponse, tags=["system"])
    async def health() -> HealthResponse:
        return HealthResponse(status="ok", app="exam-prep-backend", version=__version__)

    return app

