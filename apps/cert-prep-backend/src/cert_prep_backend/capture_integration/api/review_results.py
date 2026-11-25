"""The completed capture result: the runtime result when it is still there, else the stored one."""

from __future__ import annotations

from typing import Literal

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
    status,
)
from pydantic import BaseModel

from capture_runtime_client import (
    CaptureBlock,
    CaptureDocument,
    CaptureEngine,
    RawCaptureSegment,
    RawCapture,
    CaptureStatus,
)
from cert_prep_backend.platform.dependencies import get_database
from cert_prep_backend.api.errors import api_error, not_found_error
from cert_prep_backend.platform.errors import NotFoundError
from cert_prep_backend.capture_integration.api.dependencies import (
    get_capture_file_store,
    get_capture_review_maintenance,
    get_capture_review_store,
    get_capture_runtime,
    get_capture_sources,
    require_capture_coordinator,
)
from cert_prep_backend.capture_integration.api.review_lifecycle import (
    _host_operation,
    _operation_from_source,
)
from cert_prep_backend.capture_integration.api.schemas import (
    CaptureReviewOperationRead,
    _ApiModel,
)
from cert_prep_backend.capture_integration.application import use_cases as capture_reviews
from cert_prep_backend.capture_integration.application.errors import (
    CaptureResultProtocolError,
    CaptureResultUnavailable,
    CaptureReviewConflict,
)
from cert_prep_backend.source_library.domain.source import Source, SourceChunk
from cert_prep_backend.platform.database import Database


class CaptureExtractionProvenanceRead(_ApiModel):
    status: Literal["recorded", "reconstructed"]
    engine: str
    model: str | None
    device: str | None
    runtime_version: str | None


class _RecordedExtraction(BaseModel):
    engine: CaptureEngine
    runtime_version: str


class CaptureResultRead(_ApiModel):
    operation: CaptureReviewOperationRead
    raw: RawCapture
    result: CaptureDocument
    extraction_provenance: CaptureExtractionProvenanceRead


def register_result(router: APIRouter) -> None:
    router.get("/{capture_id}/result", response_model=CaptureResultRead)(get_result)


def get_result(
    request: Request,
    project_id: str,
    capture_id: str,
    db: Database = Depends(get_database),
) -> CaptureResultRead:
    require_capture_coordinator(request)
    capture_reviews.expire_capture_reviews(get_capture_review_maintenance(request))
    sources = get_capture_sources(request)
    files = get_capture_file_store(request)
    sessions = get_capture_review_store(request)
    try:
        stored = capture_reviews.load_completed_capture(
            sessions,
            sources,
            files,
            project_id=project_id,
            session_id=capture_id,
        )
    except NotFoundError as error:
        raise not_found_error(str(error)) from error
    except CaptureReviewConflict as error:
        raise HTTPException(status_code=409, detail=str(error))
    persisted, provenance = _source_projection(
        stored.source,
        stored.chunks,
        content_length=stored.content_length,
        media_type=stored.media_type,
    )
    runtime_id = stored.session.runtime_capture_id
    if runtime_id:
        runtime = get_capture_runtime(request)
        try:
            viewed = capture_reviews.read_runtime_result(
                sessions,
                runtime,
                project_id=project_id,
                session_id=capture_id,
                runtime_capture_id=runtime_id,
            )
            if viewed is not None:
                response = CaptureResultRead(
                    operation=_host_operation(
                        viewed.operation,
                        capture_id=capture_id,
                        source_id=stored.session.source_id,
                    ),
                    raw=viewed.raw,
                    result=persisted,
                    extraction_provenance=provenance,
                )
                capture_reviews.release_capture_result(
                    runtime, runtime_capture_id=runtime_id
                )
                return response
        except CaptureResultProtocolError as error:
            raise api_error(
                status.HTTP_502_BAD_GATEWAY,
                "capture_runtime_protocol_error",
                "Capture Runtime result violated the v2 contract.",
            ) from error
        except CaptureResultUnavailable as error:
            raise api_error(
                status.HTTP_502_BAD_GATEWAY,
                "capture_runtime_result_unavailable",
                "Capture Runtime result unavailable.",
            ) from error
        except Exception as error:
            raise api_error(
                status.HTTP_502_BAD_GATEWAY,
                "capture_runtime_result_unavailable",
                "Capture Runtime result unavailable.",
            ) from error
    content_length, media_type = capture_reviews.capture_source_display(
        sources,
        files,
        project_id=project_id,
        source_id=stored.source.id,
    )
    return CaptureResultRead(
        operation=_operation_from_source(
            capture_id,
            stored.source,
            status_value=CaptureStatus.COMPLETED,
            progress=1,
            bytes_count=content_length,
            media_type=media_type,
            last_event_sequence=int(stored.session.last_event_sequence),
            ingestion_id=stored.session.runtime_ingestion_id,
        ),
        raw=_raw_projection(persisted),
        result=persisted,
        extraction_provenance=provenance,
    )


def _source_projection(
    source: Source,
    chunks: list[SourceChunk],
    *,
    content_length: int,
    media_type: str,
) -> tuple[CaptureDocument, CaptureExtractionProvenanceRead]:
    segments = [
        RawCaptureSegment(
            segment_id=chunk.id,
            order=index,
            locator={"kind": "page", "page": max(1, chunk.page_number)},
            text=(chunk.raw_text or chunk.text).strip(),
        )
        for index, chunk in enumerate(chunks)
    ]
    blocks = [
        CaptureBlock(
            block_id=f"cert-prep-block-{segment.segment_id}",
            order=index,
            type="paragraph",
            source_segment_id=segment.segment_id,
            locator=segment.locator,
            source_text=segment.text,
            target_text=chunks[index].text.strip(),
        )
        for index, segment in enumerate(segments)
    ]
    capture_source = {
        "sha256": source.sha256,
        "fileName": source.filename,
        "mediaType": media_type,
        "bytes": max(1, content_length),
    }
    digest = f"sha256:{source.sha256}"
    if source.extraction_provenance is not None:
        recorded = _RecordedExtraction.model_validate_json(source.extraction_provenance)
        extraction = recorded.engine
        provenance = CaptureExtractionProvenanceRead(
            status="recorded",
            engine=extraction.engine,
            model=extraction.model,
            device=extraction.device,
            runtime_version=recorded.runtime_version,
        )
    else:
        engine = (
            "text-recognition"
            if source.extraction_method == "text_recognition"
            else source.extraction_method
        )
        provenance = CaptureExtractionProvenanceRead(
            status="reconstructed",
            engine=engine,
            model=None,
            device=source.ocr_device,
            runtime_version=None,
        )
        extraction = CaptureEngine(
            engine=engine,
            model="unknown",
            digest=digest,
            device=source.ocr_device,
        )
    structuring = CaptureEngine(
        engine="cert-prep-host-structuring",
        model="cert-prep-backend",
        digest=digest,
        device=None,
    )
    return CaptureDocument(
        source=capture_source,
        raw_segments=segments,
        blocks=blocks,
        source_text="\n".join(segment.text for segment in segments),
        target_text="\n".join(block.target_text for block in blocks),
        extraction_engine=extraction,
        structuring_engine=structuring,
        warnings=(
            [source.extraction_warnings]
            if source.extraction_warnings
            else []
        ),
        created_at=source.created_at,
        completed_at=source.updated_at,
    ), provenance


def _raw_projection(document: CaptureDocument) -> RawCapture:
    return RawCapture(
        schema_version=document.schema_version,
        diagnostic_only=True,
        source=document.source,
        segments=document.raw_segments,
        source_text=document.source_text,
        extraction_engine=document.extraction_engine,
        warnings=document.warnings,
        created_at=document.created_at,
    )
