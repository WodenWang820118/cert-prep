"""Capture review use cases call their ports in the order the router used to."""

from __future__ import annotations

from dataclasses import replace
import hashlib

import pytest

from capture_runtime_client import StreamingCaptureStatus

from cert_prep_backend.capture_integration.application import use_cases
from cert_prep_backend.capture_integration.application.errors import (
    CaptureAudioRejected,
    CaptureCommitNotQueued,
    CaptureExtractionCanceled,
    CaptureExtractionFailed,
    CaptureGatewayRejection,
    CaptureRequirementUnavailable,
    CaptureReviewConflict,
    CaptureReviewInputRejected,
    CaptureRuntimeCallFailed,
)
from cert_prep_backend.capture_integration.application.messages import PDF_OCR_UNAVAILABLE_MESSAGE
from cert_prep_backend.capture_integration.application.results import (
    RuntimeCancellation,
    StructuringFailureNotice,
)
from cert_prep_backend.capture_integration.domain.review_session import (
    CaptureReviewSession,
    CaptureReviewStatus,
)
from cert_prep_backend.capture_integration.infrastructure.client import CaptureRuntimeError
from cert_prep_backend.capture_integration.infrastructure.runtime_gateway import (
    CoordinatorCaptureRuntime,
)
from cert_prep_backend.platform.errors import (
    BackendError,
    DocumentOperationConflictError,
    NotFoundError,
    ValidationError,
)
from cert_prep_backend.source_library.domain.document import SourceDocument, SourceFile
from cert_prep_backend.source_library.domain.operation import DocumentOperation
from cert_prep_backend.source_library.domain.statuses import (
    DocumentOperationPhase,
    DocumentOperationStatus,
)

PROJECT = "project"
OPERATION = "operation"
CONTENT = b"page-bytes"
DIGEST = hashlib.sha256(CONTENT).hexdigest()
STORED = "stored/path"
CREATION_FAILED = "Capture review creation failed."
EXTRACTION_FAILED = "Capture Runtime extraction failed."
AUDIO_REJECTED = "Capture review supports PDF and image sources only."


class Prepared:
    def __init__(self, kind: str, canonical_suffix: str, page_count: int) -> None:
        self.kind = kind
        self.canonical_suffix = canonical_suffix
        self.page_count = page_count


def source_document(filename: str = "scan.png", *, chunks_count: int = 0) -> SourceDocument:
    return SourceDocument(
        id="document",
        project_id=PROJECT,
        filename=filename,
        sha256=DIGEST,
        language_hint="auto",
        page_count=2,
        has_text=False,
        status="uploaded",
        extraction_method="none",
        ocr_device=None,
        ocr_fallback_reason=None,
        ocr_duration_ms=0,
        processed_page_count=0,
        parse_wall_duration_ms=0,
        render_duration_ms=0,
        ocr_engine_duration_ms=0,
        ocr_worker_count=0,
        first_chunk_ms=0,
        exam_item_count=0,
        content_profile="unknown",
        classification_detail="",
        chunks_count=chunks_count,
        created_at="t",
        updated_at="t",
    )


def review_session() -> CaptureReviewSession:
    return CaptureReviewSession(
        id="session",
        project_id=PROJECT,
        document_id="document",
        operation_id=OPERATION,
        runtime_capture_id=None,
        status=CaptureReviewStatus.PENDING,
        review_revision=0,
        expires_at="later",
        created_at="t",
        updated_at="t",
        confirm_request_id=None,
        confirm_review_digest=None,
        last_event_sequence=0,
    )


def running_operation(status: DocumentOperationStatus) -> DocumentOperation:
    return DocumentOperation(
        OPERATION,
        PROJECT,
        "document",
        status,
        DocumentOperationPhase.PROCESSING,
        True,
        None,
        "t",
        "t",
    )


class FakeProjects:
    def __init__(self, trace: list[tuple], *, missing: bool = False) -> None:
        self.trace = trace
        self.missing = missing

    def get(self, project_id: str):
        self.trace.append(("project", project_id))
        if self.missing:
            return None
        return object()


class FakeDocuments:
    def __init__(self, trace: list[tuple], source: SourceFile) -> None:
        self.trace = trace
        self.source = source
        self.document_filename = "scan.png"
        self.document_error: BaseException | None = None
        self.source_error: BaseException | None = None

    def document(self, project_id: str, document_id: str) -> SourceDocument:
        self.trace.append(("document", project_id, document_id))
        if self.document_error is not None:
            raise self.document_error
        return source_document(self.document_filename)

    def source_file(self, project_id: str, document_id: str) -> SourceFile:
        self.trace.append(("source_file", project_id, document_id))
        if self.source_error is not None:
            raise self.source_error
        return self.source

    def attach_document(
        self,
        project_id: str,
        operation_id: str,
        *,
        filename: str,
        sha256: str,
        language_hint: str,
        storage_path: str,
        page_count: int,
    ) -> SourceDocument:
        self.trace.append(
            (
                "attach",
                project_id,
                operation_id,
                filename,
                sha256,
                language_hint,
                storage_path,
                page_count,
            )
        )
        return source_document(filename)


class FakeOperations:
    def __init__(self, trace: list[tuple], *, acquired: bool = True) -> None:
        self.trace = trace
        self.acquired = acquired
        self.status = DocumentOperationStatus.RUNNING
        self.claim_error: BaseException | None = None
        self.fail_error: BaseException | None = None
        self.cancel_error: BaseException | None = None
        self.acknowledge_error: BaseException | None = None
        self.operation_error: BaseException | None = None
        self.phase = DocumentOperationPhase.PROCESSING

    def claim_upload(self, project_id: str, operation_id: str) -> bool:
        self.trace.append(("claim_upload", project_id, operation_id))
        if self.claim_error is not None:
            raise self.claim_error
        return self.acquired

    def fail(self, project_id: str, operation_id: str, *, error: str) -> DocumentOperation:
        self.trace.append(("fail", project_id, operation_id, error))
        if self.fail_error is not None:
            raise self.fail_error
        return running_operation(DocumentOperationStatus.FAILED)

    def cancel(self, project_id: str, operation_id: str) -> DocumentOperation:
        self.trace.append(("cancel", project_id, operation_id))
        if self.cancel_error is not None:
            raise self.cancel_error
        return running_operation(DocumentOperationStatus.CANCELED)

    def acknowledge_cancellation(self, project_id: str, operation_id: str) -> DocumentOperation:
        self.trace.append(("acknowledge", project_id, operation_id))
        if self.acknowledge_error is not None:
            raise self.acknowledge_error
        return running_operation(DocumentOperationStatus.CANCELED)

    def operation(self, project_id: str, operation_id: str) -> DocumentOperation:
        self.trace.append(("operation", project_id, operation_id))
        if self.operation_error is not None:
            raise self.operation_error
        return DocumentOperation(
            OPERATION,
            PROJECT,
            "document",
            self.status,
            self.phase,
            True,
            None,
            "t",
            "t",
        )


class FakeFiles:
    def __init__(self, trace: list[tuple], prepared: Prepared) -> None:
        self.trace = trace
        self.prepared = prepared
        self.prepare_error: BaseException | None = None
        self.read_error: BaseException | None = None
        self.content = b"stored-bytes"

    def prepare(
        self,
        content: bytes,
        *,
        max_pdf_pages: int,
        max_image_pixels: int,
        filename: str | None,
    ) -> Prepared:
        self.trace.append(("prepare", content, max_pdf_pages, max_image_pixels, filename))
        if self.prepare_error is not None:
            raise self.prepare_error
        return self.prepared

    def store(
        self,
        *,
        project_id: str,
        sha256: str,
        content: bytes,
        canonical_suffix: str,
    ) -> str:
        self.trace.append(("store", project_id, sha256, content, canonical_suffix))
        return STORED

    def read_bytes(self, storage_path: str) -> bytes:
        self.trace.append(("read_bytes", storage_path))
        if self.read_error is not None:
            raise self.read_error
        return self.content


class FakeSessions:
    def __init__(self, trace: list[tuple], session: CaptureReviewSession) -> None:
        self.trace = trace
        self.session = session
        self.finish_error: BaseException | None = None
        self.get_error: BaseException | None = None
        self.observe_error: BaseException | None = None
        self.observed: CaptureReviewSession | None = None

    def get(self, *, project_id: str, session_id: str) -> CaptureReviewSession:
        self.trace.append(("get", project_id, session_id))
        if self.get_error is not None:
            raise self.get_error
        return self.session

    def create(
        self, *, project_id: str, document_id: str, operation_id: str
    ) -> CaptureReviewSession:
        self.trace.append(("create", project_id, document_id, operation_id))
        return self.session

    def finish(
        self,
        *,
        project_id: str,
        session_id: str,
        status: CaptureReviewStatus,
        terminal_sequence: int | None = None,
    ) -> CaptureReviewSession:
        self.trace.append(("finish", project_id, session_id, status, terminal_sequence))
        if self.finish_error is not None:
            raise self.finish_error
        self.session = replace(self.session, status=status)
        return self.session

    def observe(
        self, *, project_id: str, session_id: str, sequence: int
    ) -> CaptureReviewSession:
        self.trace.append(("observe", project_id, session_id, sequence))
        if self.observe_error is not None:
            raise self.observe_error
        if self.observed is not None:
            self.session = self.observed
            return self.session
        self.session = replace(self.session, last_event_sequence=sequence)
        return self.session


class FakeWorkflow:
    def __init__(self, trace: list[tuple]) -> None:
        self.trace = trace
        self.error: BaseException | None = None
        self.should_cancel = None
        self.on_runtime_started = None
        self.sessions: FakeSessions | None = None
        self.digest_value = "digest"
        self.candidate_sha = DIGEST
        self.acquired = True
        self.claimed_session: CaptureReviewSession | None = None
        self.claim_error: BaseException | None = None
        self.commit_error: BaseException | None = None
        self.published = source_document()

    def begin_review(self, **kwargs) -> None:
        self.should_cancel = kwargs["should_cancel"]
        self.on_runtime_started = kwargs["on_runtime_started"]
        self.trace.append(
            (
                "begin",
                kwargs["project_id"],
                kwargs["document_id"],
                kwargs["operation_id"],
                kwargs["session_id"],
                kwargs["file_name"],
                kwargs["content"],
                kwargs["media_type"],
                kwargs["source_kind"],
            )
        )
        if self.error is not None:
            raise self.error

    def digest(self, candidate: object) -> str:
        self.trace.append(("digest", candidate))
        return self.digest_value

    def candidate_source_sha256(self, candidate: object) -> str:
        self.trace.append(("candidate_sha", candidate))
        return self.candidate_sha

    def claim_commit(
        self,
        *,
        project_id: str,
        document_id: str,
        operation_id: str,
        session_id: str,
        candidate: object,
        client_request_id: str,
    ) -> tuple[CaptureReviewSession, bool]:
        self.trace.append(
            (
                "claim_commit",
                project_id,
                document_id,
                operation_id,
                session_id,
                candidate,
                client_request_id,
            )
        )
        if self.claim_error is not None:
            raise self.claim_error
        claimed = self.claimed_session if self.claimed_session is not None else review_session()
        return claimed, self.acquired

    def commit_review(
        self,
        *,
        project_id: str,
        document_id: str,
        operation_id: str,
        session_id: str,
        candidate: object,
        should_cancel,
    ) -> SourceDocument:
        self.should_cancel = should_cancel
        self.trace.append(
            ("commit_review", project_id, document_id, operation_id, session_id, candidate)
        )
        if self.commit_error is not None:
            raise self.commit_error
        if self.sessions is not None:
            self.sessions.session = replace(
                self.sessions.session, status=CaptureReviewStatus.COMPLETED
            )
        return self.published


class FakeDrafts:
    def __init__(self, trace: list[tuple]) -> None:
        self.trace = trace
        self.error: BaseException | None = None

    def enqueue_document(self, project_id: str, document_id: str) -> None:
        self.trace.append(("enqueue", project_id, document_id))
        if self.error is not None:
            raise self.error


class _RuntimeOperation:
    def __init__(self, status: object, sequence: int) -> None:
        self.status = status
        self.last_event_sequence = sequence


class FakeRuntime:
    def __init__(self, trace: list[tuple]) -> None:
        self.trace = trace
        self.error: BaseException | None = None
        self.delete_error: BaseException | None = None
        self.read_error: BaseException | None = None
        self.partial_error: BaseException | None = None
        self.raw_error: BaseException | None = None
        self.validate_error: BaseException | None = None
        self.structure_error: BaseException | None = None
        self.terminal_sequence = 4
        self.cancellation_sequence: int | None = 5
        self.operation: object = "runtime-operation"
        self.view = _RuntimeOperation(StreamingCaptureStatus.EXTRACTING, 4)
        self.partial: object = "partial"
        self.raw: object = "raw"
        self.structured: object = "structured"
        self.should_cancel = None

    def report_structuring_failure(
        self,
        runtime_capture_id: str,
        *,
        operation_id: str,
        code: str,
        message: str,
    ) -> StructuringFailureNotice:
        self.trace.append(("report", runtime_capture_id, operation_id, code, message))
        if self.error is not None:
            raise self.error
        return StructuringFailureNotice(
            terminal_sequence=self.terminal_sequence,
            runtime_operation=self.operation,
        )

    def cancel(self, runtime_capture_id: str) -> RuntimeCancellation:
        self.trace.append(("runtime_cancel", runtime_capture_id))
        if self.error is not None:
            raise self.error
        return RuntimeCancellation(
            terminal_sequence=self.cancellation_sequence,
            runtime_operation=self.operation,
        )

    def delete(self, runtime_capture_id: str) -> None:
        self.trace.append(("delete", runtime_capture_id))
        if self.delete_error is not None:
            raise self.delete_error

    def read_operation(self, runtime_capture_id: str) -> object:
        self.trace.append(("read_operation", runtime_capture_id))
        if self.read_error is not None:
            raise self.read_error
        return self.view

    def read_partial(self, runtime_capture_id: str) -> object:
        self.trace.append(("read_partial", runtime_capture_id))
        if self.partial_error is not None:
            raise self.partial_error
        return self.partial

    def read_raw(self, runtime_capture_id: str) -> object:
        self.trace.append(("read_raw", runtime_capture_id))
        if self.raw_error is not None:
            raise self.raw_error
        return self.raw

    def validate_review(self, raw: object, review: object) -> None:
        self.trace.append(("validate_review", raw, review))
        if self.validate_error is not None:
            raise self.validate_error

    def structure(
        self,
        *,
        operation_id: str,
        capture_id: str,
        review: object,
        should_cancel,
    ) -> object:
        self.should_cancel = should_cancel
        self.trace.append(("structure", operation_id, capture_id, review))
        if self.structure_error is not None:
            raise self.structure_error
        return self.structured

    def status_is(self, operation: object, token: str) -> bool:
        self.trace.append(("status_is", token))
        return operation.status is StreamingCaptureStatus(token)

    def status_equals(self, operation: object, *tokens: str) -> bool:
        self.trace.append(("status_equals", tokens))
        return operation.status in {StreamingCaptureStatus(token) for token in tokens}


class FakeWork:
    def __init__(self, trace: list[tuple]) -> None:
        self.trace = trace
        self.closed = False
        self.submit_error: BaseException | None = None
        self.run = None
        self.cancel_queued = None

    def submit(self, *, operation_id: str, run, cancel_queued) -> None:
        self.trace.append(("submit", operation_id))
        self.run = run
        self.cancel_queued = cancel_queued
        if self.submit_error is not None:
            raise self.submit_error

    def is_closed(self) -> bool:
        self.trace.append(("is_closed", self.closed))
        return self.closed


class FakeEvents:
    def __init__(self, trace: list[tuple]) -> None:
        self.trace = trace

    def publish_runtime(self, project_id: str, session_id: str, runtime_id: str) -> None:
        self.trace.append(("publish_runtime", project_id, session_id, runtime_id))

    def publish_terminal(self, project_id: str, session_id: str, terminal: str) -> None:
        self.trace.append(("publish_terminal", project_id, session_id, terminal))

    def publish_review_ready(self, project_id: str, session_id: str) -> None:
        self.trace.append(("publish_review_ready", project_id, session_id))


class FakeMaintenance:
    def __init__(self, trace: list[tuple]) -> None:
        self.trace = trace

    def expire(self) -> tuple[str, ...]:
        self.trace.append(("expire",))
        return ("session",)

    def recover(self) -> tuple[str, ...]:
        self.trace.append(("recover",))
        return ("session",)


class World:
    def __init__(self) -> None:
        self.trace: list[tuple] = []
        self.prepared = Prepared("image", ".png", 4)
        self.source = SourceFile("scan.png", DIGEST, "uploads/scan.png")
        self.projects = FakeProjects(self.trace)
        self.documents = FakeDocuments(self.trace, self.source)
        self.operations = FakeOperations(self.trace)
        self.files = FakeFiles(self.trace, self.prepared)
        self.sessions = FakeSessions(self.trace, review_session())
        self.workflow = FakeWorkflow(self.trace)
        self.work = FakeWork(self.trace)
        self.events = FakeEvents(self.trace)
        self.maintenance = FakeMaintenance(self.trace)
        self.drafts = FakeDrafts(self.trace)
        self.runtime = FakeRuntime(self.trace)
        self.workflow.sessions = self.sessions


def claim(world: World):
    return use_cases.claim_capture_upload(
        world.projects,
        world.operations,
        project_id=PROJECT,
        operation_id=OPERATION,
    )


def start(world: World, *, filename: str | None = "scan.png", content: bytes = CONTENT):
    return use_cases.start_capture_review(
        world.sessions,
        world.documents,
        world.operations,
        world.files,
        world.workflow,
        world.work,
        world.events,
        project_id=PROJECT,
        operation_id=OPERATION,
        filename=filename,
        content=content,
        max_pdf_pages=12,
        max_image_pixels=40,
    )


def extract(world: World) -> None:
    use_cases.extract_capture_for_review(
        world.documents,
        world.operations,
        world.files,
        world.sessions,
        world.workflow,
        world.work,
        world.events,
        project_id=PROJECT,
        document_id="document",
        operation_id=OPERATION,
        session_id="session",
    )


def accepted_prefix(filename: str | None, attached_name: str) -> list[tuple]:
    return [
        ("prepare", CONTENT, 12, 40, filename),
        ("store", PROJECT, DIGEST, CONTENT, ".png"),
        ("attach", PROJECT, OPERATION, attached_name, DIGEST, "auto", STORED, 4),
        ("create", PROJECT, "document", OPERATION),
        ("submit", OPERATION),
    ]


def test_public_use_cases_are_the_review_lifecycle_names() -> None:
    assert use_cases.__all__ == [
        "abandon_capture_upload",
        "cancel_capture_review",
        "claim_capture_upload",
        "commit_capture_review",
        "discard_capture_runtime",
        "expire_capture_reviews",
        "extract_capture_for_review",
        "preview_capture_structure",
        "publish_reviewed_capture",
        "recover_capture_reviews",
        "report_structuring_failure",
        "start_capture_review",
        "view_capture",
        "view_partial_capture",
        "view_raw_capture",
    ]


def test_a_reused_operation_id_does_not_prepare_or_open_a_session() -> None:
    world = World()
    world.operations.acquired = False

    claimed = claim(world)

    assert claimed.acquired is False
    assert claimed.operation_id == OPERATION
    assert world.trace == [("project", PROJECT), ("claim_upload", PROJECT, OPERATION)]


def test_a_missing_project_is_not_found_before_the_claim() -> None:
    world = World()
    world.projects.missing = True

    with pytest.raises(NotFoundError, match="Project not found."):
        claim(world)

    assert world.trace == [("project", PROJECT)]


def test_a_cross_project_operation_conflict_propagates() -> None:
    world = World()
    world.operations.claim_error = DocumentOperationConflictError(
        "Document operation id is already in use."
    )

    with pytest.raises(DocumentOperationConflictError, match="already in use"):
        claim(world)

    assert world.trace == [("project", PROJECT), ("claim_upload", PROJECT, OPERATION)]


def test_audio_is_rejected_after_prepare_and_abandons_without_a_session() -> None:
    world = World()
    world.prepared.kind = "audio"

    with pytest.raises(CaptureAudioRejected) as caught:
        start(world)

    assert str(caught.value) == AUDIO_REJECTED
    assert world.trace == [
        ("prepare", CONTENT, 12, 40, "scan.png"),
        ("fail", PROJECT, OPERATION, CREATION_FAILED),
    ]


def test_a_prepare_failure_abandons_the_claim_without_a_session() -> None:
    world = World()
    world.files.prepare_error = RuntimeError("unreadable")

    with pytest.raises(RuntimeError, match="unreadable"):
        start(world)

    assert world.trace == [
        ("prepare", CONTENT, 12, 40, "scan.png"),
        ("fail", PROJECT, OPERATION, CREATION_FAILED),
    ]


def test_an_accepted_upload_stores_attaches_and_submits_in_order() -> None:
    world = World()

    started = start(world)

    assert world.trace == accepted_prefix("scan.png", "scan.png")
    assert ("is_closed", True) not in world.trace
    assert ("is_closed", False) not in world.trace
    assert started.content_length == len(CONTENT)
    assert started.canonical_suffix == ".png"
    assert started.document.filename == "scan.png"
    assert started.session.id == "session"


def test_a_missing_filename_falls_back_to_the_digest_and_suffix() -> None:
    world = World()

    started = start(world, filename=None)

    assert world.trace == accepted_prefix(None, f"{DIGEST}.png")
    assert started.document.filename == f"{DIGEST}.png"
    assert started.content_length == len(CONTENT)
    assert started.canonical_suffix == ".png"


def test_submit_failure_fails_the_operation_then_the_session_and_reraises() -> None:
    world = World()
    world.work.submit_error = RuntimeError("pool closed")

    with pytest.raises(RuntimeError, match="pool closed"):
        start(world)

    assert world.trace == [
        *accepted_prefix("scan.png", "scan.png"),
        ("fail", PROJECT, OPERATION, CREATION_FAILED),
        ("finish", PROJECT, "session", CaptureReviewStatus.FAILED, None),
        ("publish_terminal", PROJECT, "session", CaptureReviewStatus.FAILED),
    ]


def test_a_failure_to_mark_the_operation_is_swallowed_and_the_session_still_ends() -> None:
    world = World()
    world.work.submit_error = RuntimeError("pool closed")
    world.operations.fail_error = RuntimeError("disk")

    with pytest.raises(RuntimeError, match="pool closed"):
        start(world)

    assert ("fail", PROJECT, OPERATION, CREATION_FAILED) in world.trace
    assert ("finish", PROJECT, "session", CaptureReviewStatus.FAILED, None) in world.trace
    assert ("publish_terminal", PROJECT, "session", CaptureReviewStatus.FAILED) in world.trace


def test_a_failure_to_finish_the_session_is_swallowed() -> None:
    world = World()
    world.work.submit_error = RuntimeError("pool closed")
    world.sessions.finish_error = RuntimeError("no row")

    with pytest.raises(RuntimeError, match="pool closed"):
        start(world)

    assert ("finish", PROJECT, "session", CaptureReviewStatus.FAILED, None) in world.trace
    assert not any(item[0] == "publish_terminal" for item in world.trace)


def test_abandon_without_a_session_does_not_finish_one() -> None:
    world = World()

    use_cases.abandon_capture_upload(
        world.sessions,
        world.operations,
        world.events,
        project_id=PROJECT,
        operation_id=OPERATION,
        session_id=None,
    )

    assert world.trace == [("fail", PROJECT, OPERATION, CREATION_FAILED)]


def test_a_document_load_stays_outside_extraction_failure_handling() -> None:
    world = World()
    world.documents.document_error = CaptureExtractionFailed("requirement_unavailable", 9)

    with pytest.raises(CaptureExtractionFailed) as caught:
        extract(world)

    assert caught.value.code == "requirement_unavailable"
    assert caught.value.terminal_sequence == 9
    assert world.trace == [("document", PROJECT, "document")]


def test_pdf_requirement_failure_uses_the_pdf_message_and_no_sequence() -> None:
    world = World()
    world.source = SourceFile("notes.bin", DIGEST, "uploads/notes.PDF")
    world.documents.source = world.source
    world.workflow.error = CaptureRequirementUnavailable("windowsml down")

    extract(world)

    assert world.trace == [
        ("document", PROJECT, "document"),
        ("source_file", PROJECT, "document"),
        ("read_bytes", "uploads/notes.PDF"),
        (
            "begin",
            PROJECT,
            "document",
            OPERATION,
            "session",
            "scan.png",
            b"stored-bytes",
            "application/pdf",
            "pdf",
        ),
        ("finish", PROJECT, "session", CaptureReviewStatus.FAILED, None),
        ("fail", PROJECT, OPERATION, PDF_OCR_UNAVAILABLE_MESSAGE),
        ("publish_terminal", PROJECT, "session", CaptureReviewStatus.FAILED),
    ]


def test_image_requirement_failure_uses_the_runtime_message() -> None:
    world = World()
    world.workflow.error = CaptureRequirementUnavailable("decoder missing")

    extract(world)

    assert world.trace[-4] == (
        "begin",
        PROJECT,
        "document",
        OPERATION,
        "session",
        "scan.png",
        b"stored-bytes",
        "image/png",
        "image",
    )
    assert world.trace[-3:] == [
        ("finish", PROJECT, "session", CaptureReviewStatus.FAILED, None),
        ("fail", PROJECT, OPERATION, "decoder missing"),
        ("publish_terminal", PROJECT, "session", CaptureReviewStatus.FAILED),
    ]


def test_a_pdf_requirement_job_keeps_the_pdf_message_and_the_sequence() -> None:
    world = World()
    world.source = SourceFile("notes.pdf", DIGEST, "uploads/blob")
    world.documents.source = world.source
    world.documents.document_filename = "notes.pdf"
    world.workflow.error = CaptureExtractionFailed("requirement_unavailable", 8)

    extract(world)

    assert (
        "begin",
        PROJECT,
        "document",
        OPERATION,
        "session",
        "notes.pdf",
        b"stored-bytes",
        "application/pdf",
        "pdf",
    ) in world.trace
    assert world.trace[-3:] == [
        ("finish", PROJECT, "session", CaptureReviewStatus.FAILED, 8),
        ("fail", PROJECT, OPERATION, PDF_OCR_UNAVAILABLE_MESSAGE),
        ("publish_terminal", PROJECT, "session", CaptureReviewStatus.FAILED),
    ]


def test_any_other_job_code_uses_the_generic_message_and_the_sequence() -> None:
    world = World()
    world.source = SourceFile("notes.pdf", DIGEST, "uploads/notes.pdf")
    world.documents.source = world.source
    world.workflow.error = CaptureExtractionFailed("capture_failed", 3)

    extract(world)

    assert world.trace[-3:] == [
        ("finish", PROJECT, "session", CaptureReviewStatus.FAILED, 3),
        ("fail", PROJECT, OPERATION, EXTRACTION_FAILED),
        ("publish_terminal", PROJECT, "session", CaptureReviewStatus.FAILED),
    ]


def test_a_generic_extraction_failure_has_no_terminal_sequence() -> None:
    world = World()
    world.workflow.error = RuntimeError("socket down")

    extract(world)

    assert world.trace[-3:] == [
        ("finish", PROJECT, "session", CaptureReviewStatus.FAILED, None),
        ("fail", PROJECT, OPERATION, EXTRACTION_FAILED),
        ("publish_terminal", PROJECT, "session", CaptureReviewStatus.FAILED),
    ]


def test_a_stored_file_read_is_inside_the_failure_path() -> None:
    world = World()
    world.files.read_error = OSError("gone")

    extract(world)

    assert [item[0] for item in world.trace] == [
        "document",
        "source_file",
        "read_bytes",
        "finish",
        "fail",
        "publish_terminal",
    ]
    assert ("fail", PROJECT, OPERATION, EXTRACTION_FAILED) in world.trace
    assert ("finish", PROJECT, "session", CaptureReviewStatus.FAILED, None) in world.trace


def test_a_canceled_extraction_acknowledges_then_cancels_the_session() -> None:
    world = World()
    world.workflow.error = CaptureExtractionCanceled()

    extract(world)

    assert [item[0] for item in world.trace] == [
        "document",
        "source_file",
        "read_bytes",
        "begin",
        "acknowledge",
        "finish",
        "publish_terminal",
    ]
    assert ("finish", PROJECT, "session", CaptureReviewStatus.CANCELED, None) in world.trace
    assert ("publish_terminal", PROJECT, "session", CaptureReviewStatus.CANCELED) in world.trace
    assert not any(item[0] == "fail" for item in world.trace)


def test_a_successful_extraction_publishes_review_ready_only() -> None:
    world = World()

    extract(world)

    assert ("publish_review_ready", PROJECT, "session") in world.trace
    assert not any(item[0] in {"finish", "fail", "publish_terminal"} for item in world.trace)
    assert world.trace[-1] == ("publish_review_ready", PROJECT, "session")


def test_should_cancel_when_the_pool_is_closed_or_the_operation_is_not_running() -> None:
    world = World()
    extract(world)
    cancel = world.workflow.should_cancel
    assert cancel is not None

    world.work.closed = True
    assert cancel() is True
    assert not any(item[0] == "operation" for item in world.trace)

    world.work.closed = False
    assert cancel() is False
    assert ("operation", PROJECT, OPERATION) in world.trace

    world.operations.status = DocumentOperationStatus.QUEUED
    assert cancel() is True

    world.operations.operation_error = RuntimeError("missing")
    assert cancel() is True


def test_submitted_work_runs_extraction_and_queued_cancel() -> None:
    world = World()
    started = start(world)

    world.trace.clear()
    assert world.work.run is not None
    world.work.run()
    assert world.trace[0] == ("document", PROJECT, started.document.id)
    assert world.trace[-1] == ("publish_review_ready", PROJECT, started.session.id)

    world.trace.clear()
    assert world.work.cancel_queued is not None
    world.work.cancel_queued()
    assert [item[0] for item in world.trace] == [
        "cancel",
        "acknowledge",
        "finish",
        "publish_terminal",
    ]


def test_queued_cancel_finishes_the_session_after_cancel_and_acknowledge() -> None:
    world = World()

    use_cases._cancel_queued_capture(
        world.sessions,
        world.operations,
        world.events,
        project_id=PROJECT,
        operation_id=OPERATION,
        session_id="session",
    )

    assert world.trace == [
        ("cancel", PROJECT, OPERATION),
        ("acknowledge", PROJECT, OPERATION),
        ("finish", PROJECT, "session", CaptureReviewStatus.CANCELED, None),
        ("publish_terminal", PROJECT, "session", CaptureReviewStatus.CANCELED),
    ]


def test_a_queued_cancel_finish_error_is_swallowed() -> None:
    world = World()
    world.sessions.finish_error = RuntimeError("no row")

    use_cases._cancel_queued_capture(
        world.sessions,
        world.operations,
        world.events,
        project_id=PROJECT,
        operation_id=OPERATION,
        session_id="session",
    )

    assert ("cancel", PROJECT, OPERATION) in world.trace
    assert ("acknowledge", PROJECT, OPERATION) in world.trace
    assert ("finish", PROJECT, "session", CaptureReviewStatus.CANCELED, None) in world.trace
    assert not any(item[0] == "publish_terminal" for item in world.trace)


def test_a_queued_cancel_error_still_finishes_the_session() -> None:
    world = World()
    world.operations.cancel_error = RuntimeError("busy")

    with pytest.raises(RuntimeError, match="busy"):
        use_cases._cancel_queued_capture(
            world.sessions,
            world.operations,
            world.events,
            project_id=PROJECT,
            operation_id=OPERATION,
            session_id="session",
        )

    assert ("acknowledge", PROJECT, OPERATION) not in world.trace
    assert ("finish", PROJECT, "session", CaptureReviewStatus.CANCELED, None) in world.trace
    assert ("publish_terminal", PROJECT, "session", CaptureReviewStatus.CANCELED) in world.trace


def test_a_queued_cancel_error_survives_a_finish_error() -> None:
    world = World()
    world.operations.cancel_error = RuntimeError("busy")
    world.sessions.finish_error = RuntimeError("no row")

    with pytest.raises(RuntimeError, match="busy"):
        use_cases._cancel_queued_capture(
            world.sessions,
            world.operations,
            world.events,
            project_id=PROJECT,
            operation_id=OPERATION,
            session_id="session",
        )

    assert not any(item[0] == "publish_terminal" for item in world.trace)


def test_an_acknowledge_error_still_finishes_a_canceled_capture() -> None:
    world = World()
    world.operations.acknowledge_error = RuntimeError("ack")

    with pytest.raises(RuntimeError, match="ack"):
        use_cases._finish_canceled_capture(
            world.sessions,
            world.operations,
            world.events,
            project_id=PROJECT,
            operation_id=OPERATION,
            session_id="session",
        )

    assert world.trace == [
        ("acknowledge", PROJECT, OPERATION),
        ("finish", PROJECT, "session", CaptureReviewStatus.CANCELED, None),
        ("publish_terminal", PROJECT, "session", CaptureReviewStatus.CANCELED),
    ]


def test_a_finish_error_after_a_failed_acknowledge_replaces_it() -> None:
    world = World()
    world.operations.acknowledge_error = RuntimeError("ack")
    world.sessions.finish_error = RuntimeError("no row")

    with pytest.raises(RuntimeError, match="no row"):
        use_cases._finish_canceled_capture(
            world.sessions,
            world.operations,
            world.events,
            project_id=PROJECT,
            operation_id=OPERATION,
            session_id="session",
        )

    assert ("finish", PROJECT, "session", CaptureReviewStatus.CANCELED, None) in world.trace
    assert not any(item[0] == "publish_terminal" for item in world.trace)


def test_expire_and_recover_each_call_only_their_maintenance_method() -> None:
    expiring = World()
    assert use_cases.expire_capture_reviews(expiring.maintenance) == ("session",)
    assert expiring.trace == [("expire",)]

    recovering = World()
    assert use_cases.recover_capture_reviews(recovering.maintenance) == ("session",)
    assert recovering.trace == [("recover",)]


CANDIDATE = "candidate"
REQUEST = "request-1"
COMMIT_NOT_QUEUED = "Capture commit could not be queued."
COMMIT_MISMATCH = "Capture commit does not match the completed request."
REVIEW_NOT_PENDING = "Capture review is no longer pending."
CANDIDATE_MISMATCH = "Capture candidate source does not match."
STRUCTURING_FAILED = "Capture host structuring failed."
RUNTIME_UNAVAILABLE = "Capture Runtime operation is not available."
STRUCTURING_GATEWAY = "Capture structuring failure could not be confirmed."
CANCEL_GATEWAY = "Capture cancellation could not be confirmed."
DELETE_GATEWAY = "Capture Runtime deletion could not be confirmed."


def completed_session(
    request_id: str | None, digest: str | None = "digest"
) -> CaptureReviewSession:
    return replace(
        review_session(),
        status=CaptureReviewStatus.COMPLETED,
        confirm_request_id=request_id,
        confirm_review_digest=digest,
    )


def commit(world: World, *, candidate: object = CANDIDATE, client_request_id: str = REQUEST):
    return use_cases.commit_capture_review(
        world.sessions,
        world.documents,
        world.operations,
        world.workflow,
        world.work,
        world.events,
        world.drafts,
        project_id=PROJECT,
        session_id="session",
        candidate=candidate,
        client_request_id=client_request_id,
    )


def publish(world: World, *, candidate: object = CANDIDATE) -> None:
    use_cases.publish_reviewed_capture(
        world.sessions,
        world.operations,
        world.workflow,
        world.work,
        world.events,
        world.drafts,
        project_id=PROJECT,
        document_id="document",
        operation_id=OPERATION,
        session_id="session",
        candidate=candidate,
    )


def report(
    world: World,
    *,
    client_request_id: str | None = "client",
    code: str = "host_failed",
    message: str = "no text",
):
    return use_cases.report_structuring_failure(
        world.sessions,
        world.operations,
        world.runtime,
        project_id=PROJECT,
        session_id="session",
        client_request_id=client_request_id,
        code=code,
        message=message,
    )


def cancel(world: World) -> None:
    use_cases.cancel_capture_review(
        world.sessions,
        world.operations,
        world.runtime,
        world.events,
        project_id=PROJECT,
        session_id="session",
    )


def test_a_matching_completed_commit_replays_without_a_claim() -> None:
    world = World()
    world.sessions.session = completed_session(REQUEST)

    queued = commit(world)

    assert queued.replay_completed is True
    assert ("digest", CANDIDATE) in world.trace
    assert "claim_commit" not in [item[0] for item in world.trace]
    assert "document" not in [item[0] for item in world.trace]


def test_a_falsy_stored_request_id_replays_without_a_digest_or_a_claim() -> None:
    for request_id in (None, ""):
        world = World()
        world.sessions.session = completed_session(request_id, digest=None)

        queued = commit(world)

        assert queued.replay_completed is True
        assert world.trace == [("get", PROJECT, "session")]


def test_a_completed_commit_mismatch_is_a_conflict() -> None:
    mismatched_id = World()
    mismatched_id.sessions.session = completed_session(REQUEST)
    with pytest.raises(CaptureReviewConflict) as caught:
        commit(mismatched_id, client_request_id="other")
    assert str(caught.value) == COMMIT_MISMATCH
    assert "digest" not in [item[0] for item in mismatched_id.trace]

    mismatched_digest = World()
    mismatched_digest.sessions.session = completed_session(REQUEST)
    mismatched_digest.workflow.digest_value = "other"
    with pytest.raises(CaptureReviewConflict) as caught:
        commit(mismatched_digest)
    assert str(caught.value) == COMMIT_MISMATCH
    assert ("digest", CANDIDATE) in mismatched_digest.trace
    assert "claim_commit" not in [item[0] for item in mismatched_digest.trace]


def test_an_inactive_review_cannot_be_committed() -> None:
    world = World()
    world.sessions.session = replace(review_session(), status=CaptureReviewStatus.FAILED)

    with pytest.raises(CaptureReviewConflict) as caught:
        commit(world)

    assert str(caught.value) == REVIEW_NOT_PENDING
    assert world.trace == [("get", PROJECT, "session")]


def test_a_missing_session_or_document_is_not_found_before_the_claim() -> None:
    missing_session = World()
    missing_session.sessions.get_error = NotFoundError("Capture review session not found.")
    with pytest.raises(NotFoundError, match="Capture review session not found."):
        commit(missing_session)
    assert missing_session.trace == [("get", PROJECT, "session")]

    missing_document = World()
    missing_document.documents.document_error = NotFoundError("Document not found.")
    with pytest.raises(NotFoundError, match="Document not found."):
        commit(missing_document)
    assert "claim_commit" not in [item[0] for item in missing_document.trace]


def test_a_candidate_hash_mismatch_is_a_validation_error_and_does_not_claim() -> None:
    world = World()
    world.workflow.candidate_sha = "f" * 64

    with pytest.raises(ValidationError) as caught:
        commit(world)

    assert str(caught.value) == CANDIDATE_MISMATCH
    assert "claim_commit" not in [item[0] for item in world.trace]


@pytest.mark.parametrize(
    "error",
    [
        BackendError("stored claim failed"),
        RuntimeError("review changed"),
        NotFoundError("Capture review session not found."),
    ],
)
def test_a_claim_error_becomes_a_review_conflict(error: Exception) -> None:
    world = World()
    world.workflow.claim_error = error

    with pytest.raises(CaptureReviewConflict) as caught:
        commit(world)

    assert str(caught.value) == str(error)
    assert "submit" not in [item[0] for item in world.trace]


def test_a_repeated_claim_does_not_submit_and_returns_the_claim_sequence() -> None:
    world = World()
    world.workflow.acquired = False
    world.workflow.claimed_session = replace(review_session(), last_event_sequence=9)

    queued = commit(world)

    assert queued.replay_completed is False
    assert queued.last_event_sequence == 9
    assert queued.document is not None
    assert "submit" not in [item[0] for item in world.trace]


def test_an_acquired_commit_submits_publication_and_queued_cancel() -> None:
    world = World()
    world.workflow.claimed_session = replace(review_session(), last_event_sequence=11)

    queued = commit(world)

    assert queued.replay_completed is False
    assert queued.last_event_sequence == 11
    assert [item[0] for item in world.trace] == [
        "get",
        "document",
        "candidate_sha",
        "claim_commit",
        "submit",
    ]
    assert world.work.cancel_queued is not None
    world.trace.clear()
    world.work.cancel_queued()
    assert [item[0] for item in world.trace] == [
        "cancel",
        "acknowledge",
        "finish",
        "publish_terminal",
    ]


def test_a_submit_failure_fails_the_operation_then_the_session_and_is_not_queued() -> None:
    world = World()
    world.work.submit_error = RuntimeError("pool closed")

    with pytest.raises(CaptureCommitNotQueued) as caught:
        commit(world)

    assert str(caught.value) == COMMIT_NOT_QUEUED
    assert world.trace[-2:] == [
        ("fail", PROJECT, OPERATION, COMMIT_NOT_QUEUED),
        ("finish", PROJECT, "session", CaptureReviewStatus.FAILED, None),
    ]


def test_a_failure_to_mark_the_unqueued_commit_propagates() -> None:
    world = World()
    world.work.submit_error = RuntimeError("pool closed")
    world.operations.fail_error = RuntimeError("disk")

    with pytest.raises(RuntimeError, match="disk"):
        commit(world)

    assert ("finish", PROJECT, "session", CaptureReviewStatus.FAILED, None) not in world.trace


def test_a_failure_to_finish_the_unqueued_commit_propagates() -> None:
    world = World()
    world.work.submit_error = RuntimeError("pool closed")
    world.sessions.finish_error = RuntimeError("no row")

    with pytest.raises(RuntimeError, match="no row"):
        commit(world)

    assert ("fail", PROJECT, OPERATION, COMMIT_NOT_QUEUED) in world.trace


def test_commit_publication_enqueues_drafts_only_when_chunks_exist() -> None:
    empty = World()
    publish(empty)
    assert "enqueue" not in [item[0] for item in empty.trace]
    assert ("publish_terminal", PROJECT, "session", CaptureReviewStatus.COMPLETED) in empty.trace

    drafted = World()
    drafted.workflow.published = source_document(chunks_count=2)
    publish(drafted)
    assert ("enqueue", PROJECT, "document") in drafted.trace
    assert drafted.trace[-2:] == [
        ("get", PROJECT, "session"),
        ("publish_terminal", PROJECT, "session", CaptureReviewStatus.COMPLETED),
    ]


def test_a_canceled_commit_finishes_and_publishes_twice() -> None:
    world = World()
    world.workflow.commit_error = CaptureExtractionCanceled()

    publish(world)

    assert [item for item in world.trace if item[0] == "publish_terminal"] == [
        ("publish_terminal", PROJECT, "session", CaptureReviewStatus.CANCELED),
        ("publish_terminal", PROJECT, "session", CaptureReviewStatus.CANCELED),
    ]
    assert [item[0] for item in world.trace] == [
        "commit_review",
        "acknowledge",
        "finish",
        "publish_terminal",
        "get",
        "publish_terminal",
    ]


def test_commit_publication_publishes_in_finally_only_when_the_session_is_inactive() -> None:
    world = World()
    world.workflow.commit_error = RuntimeError("runtime down")

    with pytest.raises(RuntimeError, match="runtime down"):
        publish(world)

    assert ("get", PROJECT, "session") in world.trace
    assert "publish_terminal" not in [item[0] for item in world.trace]


def test_a_commit_reload_error_in_finally_is_swallowed() -> None:
    world = World()
    world.sessions.get_error = RuntimeError("missing")

    publish(world)

    assert ("get", PROJECT, "session") in world.trace
    assert "publish_terminal" not in [item[0] for item in world.trace]


def test_a_draft_enqueue_error_still_reaches_finally() -> None:
    world = World()
    world.workflow.published = source_document(chunks_count=1)
    world.drafts.error = RuntimeError("drafts down")

    with pytest.raises(RuntimeError, match="drafts down"):
        publish(world)

    assert ("enqueue", PROJECT, "document") in world.trace
    enqueue_at = world.trace.index(("enqueue", PROJECT, "document"))
    get_at = world.trace.index(("get", PROJECT, "session"))
    assert enqueue_at < get_at
    assert ("publish_terminal", PROJECT, "session", CaptureReviewStatus.COMPLETED) in world.trace


def test_commit_publication_cancels_when_the_pool_is_closed_or_the_operation_stopped() -> None:
    world = World()
    publish(world)
    cancel_check = world.workflow.should_cancel
    assert cancel_check is not None

    world.trace.clear()
    world.work.closed = True
    assert cancel_check() is True
    assert "operation" not in [item[0] for item in world.trace]

    world.work.closed = False
    world.operations.status = DocumentOperationStatus.QUEUED
    assert cancel_check() is True
    assert ("operation", PROJECT, OPERATION) in world.trace


def test_an_inactive_structuring_failure_replays_without_the_runtime() -> None:
    world = World()
    world.sessions.session = replace(review_session(), status=CaptureReviewStatus.FAILED)

    reported = report(world)

    assert reported.replay is True
    assert reported.runtime_operation is None
    assert world.trace == [("get", PROJECT, "session")]


def test_a_structuring_failure_without_a_runtime_id_is_a_conflict() -> None:
    world = World()

    with pytest.raises(CaptureReviewConflict) as caught:
        report(world)

    assert str(caught.value) == RUNTIME_UNAVAILABLE
    assert "report" not in [item[0] for item in world.trace]


def test_a_structuring_failure_stores_the_runtime_sequence() -> None:
    world = World()
    world.sessions.session = replace(review_session(), runtime_capture_id="runtime")

    reported = report(world, client_request_id="client")

    assert reported.replay is False
    assert reported.document_id == "document"
    assert reported.runtime_operation == "runtime-operation"
    assert world.trace == [
        ("get", PROJECT, "session"),
        ("report", "runtime", "client", "host_failed", "no text"),
        ("fail", PROJECT, OPERATION, STRUCTURING_FAILED),
        ("finish", PROJECT, "session", CaptureReviewStatus.FAILED, 4),
    ]


def test_a_structuring_failure_uses_the_operation_id_when_the_client_omits_one() -> None:
    world = World()
    world.sessions.session = replace(review_session(), runtime_capture_id="runtime")

    report(world, client_request_id=None)

    assert ("report", "runtime", OPERATION, "host_failed", "no text") in world.trace


def test_any_structuring_failure_error_becomes_the_gateway_rejection() -> None:
    world = World()
    world.sessions.session = replace(review_session(), runtime_capture_id="runtime")
    world.runtime.error = RuntimeError("down")

    with pytest.raises(CaptureGatewayRejection) as caught:
        report(world)

    assert str(caught.value) == STRUCTURING_GATEWAY


def test_an_inactive_cancel_writes_nothing() -> None:
    world = World()
    world.sessions.session = replace(review_session(), status=CaptureReviewStatus.CANCELED)

    cancel(world)

    assert world.trace == [("get", PROJECT, "session")]


def test_an_active_cancel_confirms_the_runtime_then_ends_the_session() -> None:
    world = World()
    world.sessions.session = replace(review_session(), runtime_capture_id="runtime")

    cancel(world)

    assert world.trace == [
        ("get", PROJECT, "session"),
        ("cancel", PROJECT, OPERATION),
        ("runtime_cancel", "runtime"),
        ("acknowledge", PROJECT, OPERATION),
        ("finish", PROJECT, "session", CaptureReviewStatus.CANCELED, 5),
        ("publish_terminal", PROJECT, "session", CaptureReviewStatus.CANCELED),
    ]


def test_a_cancel_without_a_runtime_id_skips_the_runtime_and_stores_no_sequence() -> None:
    world = World()

    cancel(world)

    assert "runtime_cancel" not in [item[0] for item in world.trace]
    assert ("finish", PROJECT, "session", CaptureReviewStatus.CANCELED, None) in world.trace
    assert ("publish_terminal", PROJECT, "session", CaptureReviewStatus.CANCELED) in world.trace


def test_any_cancel_error_becomes_the_gateway_rejection() -> None:
    world = World()
    world.sessions.session = replace(review_session(), runtime_capture_id="runtime")
    world.operations.cancel_error = RuntimeError("busy")

    with pytest.raises(CaptureGatewayRejection) as caught:
        cancel(world)

    assert str(caught.value) == CANCEL_GATEWAY
    assert "acknowledge" not in [item[0] for item in world.trace]


def test_discard_skips_a_missing_runtime_id() -> None:
    world = World()

    use_cases.discard_capture_runtime(world.runtime, runtime_capture_id=None)
    use_cases.discard_capture_runtime(world.runtime, runtime_capture_id="")

    assert world.trace == []


def test_a_runtime_delete_failure_becomes_the_gateway_rejection() -> None:
    world = World()
    world.runtime.delete_error = CaptureRuntimeCallFailed("down")

    with pytest.raises(CaptureGatewayRejection) as caught:
        use_cases.discard_capture_runtime(world.runtime, runtime_capture_id="runtime")

    assert str(caught.value) == DELETE_GATEWAY
    assert world.trace == [("delete", "runtime")]


def test_a_runtime_delete_that_returns_is_success() -> None:
    world = World()

    use_cases.discard_capture_runtime(world.runtime, runtime_capture_id="runtime")

    assert world.trace == [("delete", "runtime")]


def test_discard_does_not_swallow_errors_the_adapter_did_not_translate() -> None:
    world = World()
    world.runtime.delete_error = RuntimeError("socket")

    with pytest.raises(RuntimeError, match="socket"):
        use_cases.discard_capture_runtime(world.runtime, runtime_capture_id="runtime")


class _DeleteCoordinator:
    def __init__(self, error: BaseException | None = None) -> None:
        self.error = error
        self.calls: list[str] = []

    def delete(self, capture_id: str) -> None:
        self.calls.append(capture_id)
        if self.error is not None:
            raise self.error


def test_runtime_delete_swallows_not_found_and_unexpected_errors() -> None:
    missing = _DeleteCoordinator(
        CaptureRuntimeError(
            status_code=404,
            code="capture_not_found",
            message="Streaming capture was not found.",
        )
    )
    CoordinatorCaptureRuntime(missing).delete("capture")
    assert missing.calls == ["capture"]

    rejected = _DeleteCoordinator(
        CaptureRuntimeError(status_code=503, code="unavailable", message="down")
    )
    with pytest.raises(CaptureRuntimeCallFailed):
        CoordinatorCaptureRuntime(rejected).delete("capture")

    unexpected = _DeleteCoordinator(RuntimeError("socket"))
    CoordinatorCaptureRuntime(unexpected).delete("capture")
    assert unexpected.calls == ["capture"]


RUNTIME = "runtime"
STATUS_UNAVAILABLE = "Capture Runtime status unavailable."
OCR_CLOSED = "OCR review is no longer available."
EXTRACTION_NOT_READY = "OCR extraction has not reached review state."
REVIEW_NOT_PENDING = "Capture review is no longer pending."
REVIEW_CANCELLED = "Capture review was cancelled."
STRUCTURE_FAILED = "Capture structuring failed."
REVIEW = object()


def with_runtime(
    world: World,
    *,
    status: CaptureReviewStatus = CaptureReviewStatus.PENDING,
    runtime_id: str | None = RUNTIME,
) -> None:
    world.sessions.session = replace(
        review_session(),
        status=status,
        runtime_capture_id=runtime_id,
    )


def view(world: World):
    return use_cases.view_capture(
        world.sessions,
        world.documents,
        world.operations,
        world.runtime,
        project_id=PROJECT,
        session_id="session",
    )


def view_partial(world: World):
    return use_cases.view_partial_capture(
        world.sessions,
        world.runtime,
        project_id=PROJECT,
        session_id="session",
    )


def view_raw(world: World):
    return use_cases.view_raw_capture(
        world.sessions,
        world.runtime,
        project_id=PROJECT,
        session_id="session",
    )


def preview(world: World):
    return use_cases.preview_capture_structure(
        world.sessions,
        world.operations,
        world.runtime,
        project_id=PROJECT,
        session_id="session",
        review=REVIEW,
    )


def calls(world: World) -> list[object]:
    return [item[0] for item in world.trace]


def test_a_confirming_capture_does_not_call_the_runtime() -> None:
    world = World()
    with_runtime(world, status=CaptureReviewStatus.CONFIRMING)

    viewed = view(world)

    assert viewed.runtime_operation is None
    assert viewed.report_extracting is False
    assert viewed.session.status == CaptureReviewStatus.CONFIRMING
    assert calls(world) == ["get", "document"]


def test_a_capture_without_a_runtime_id_returns_the_session() -> None:
    world = World()

    viewed = view(world)

    assert viewed.runtime_operation is None
    assert viewed.report_extracting is False
    assert viewed.document.id == "document"
    assert calls(world) == ["get", "document"]

    empty = World()
    with_runtime(empty, runtime_id="")
    assert view(empty).runtime_operation is None
    assert calls(empty) == ["get", "document"]


def test_view_capture_propagates_a_missing_session_or_document() -> None:
    missing_session = World()
    missing_session.sessions.get_error = NotFoundError("Capture review session not found.")

    with pytest.raises(NotFoundError, match="Capture review session not found."):
        view(missing_session)

    assert missing_session.trace == [("get", PROJECT, "session")]

    missing_document = World()
    missing_document.documents.document_error = NotFoundError("Document not found.")

    with pytest.raises(NotFoundError, match="Document not found."):
        view(missing_document)

    assert calls(missing_document) == ["get", "document"]


@pytest.mark.parametrize(
    "status",
    [
        StreamingCaptureStatus.COMPLETED,
        StreamingCaptureStatus.FAILED,
        StreamingCaptureStatus.CANCELLED,
    ],
)
def test_an_active_terminal_runtime_status_is_observed_then_hidden(status: object) -> None:
    world = World()
    with_runtime(world)
    world.runtime.view = _RuntimeOperation(status, 6)

    viewed = view(world)

    assert viewed.runtime_operation is None
    assert viewed.report_extracting is False
    assert viewed.session.last_event_sequence == 6
    read_at = world.trace.index(("read_operation", RUNTIME))
    assert world.trace[read_at + 1] == ("observe", PROJECT, "session", 6)
    assert ("status_equals", ("completed", "failed", "cancelled")) in world.trace
    assert "status_is" not in calls(world)
    assert all(not ("read_operation" in item and "observe" in item) for item in world.trace)


def test_a_session_terminalized_by_observe_keeps_a_matching_operation() -> None:
    world = World()
    with_runtime(world)
    world.runtime.view = _RuntimeOperation(StreamingCaptureStatus.COMPLETED, 11)
    world.sessions.observed = replace(
        world.sessions.session,
        status=CaptureReviewStatus.COMPLETED,
        last_event_sequence=11,
    )

    viewed = view(world)

    assert viewed.session.status == CaptureReviewStatus.COMPLETED
    assert viewed.runtime_operation is world.runtime.view
    assert viewed.report_extracting is False


@pytest.mark.parametrize(
    "status",
    [
        StreamingCaptureStatus.CREATED,
        StreamingCaptureStatus.WAITING_INPUT,
        StreamingCaptureStatus.EXTRACTING,
        StreamingCaptureStatus.STRUCTURING,
    ],
)
def test_a_pending_capture_returns_other_statuses_without_reporting_extracting(
    status: object,
) -> None:
    world = World()
    with_runtime(world)
    world.runtime.view = _RuntimeOperation(status, 3)

    viewed = view(world)

    assert viewed.runtime_operation is world.runtime.view
    assert viewed.report_extracting is False
    assert "operation" not in calls(world)


@pytest.mark.parametrize(
    ("phase", "extracting"),
    [
        (DocumentOperationPhase.AWAITING_REVIEW, False),
        (DocumentOperationPhase.PROCESSING, True),
    ],
)
def test_pending_awaiting_structuring_reports_extracting_until_review(
    phase: DocumentOperationPhase,
    extracting: bool,
) -> None:
    world = World()
    with_runtime(world)
    world.runtime.view = _RuntimeOperation(StreamingCaptureStatus.AWAITING_STRUCTURING, 9)
    world.operations.phase = phase

    viewed = view(world)

    assert viewed.report_extracting is extracting
    assert viewed.runtime_operation is world.runtime.view
    assert ("operation", PROJECT, OPERATION) in world.trace
    assert ("observe", PROJECT, "session", 9) in world.trace


def test_a_failed_phase_read_is_not_ready_and_reports_extracting() -> None:
    world = World()
    with_runtime(world)
    world.runtime.view = _RuntimeOperation(StreamingCaptureStatus.AWAITING_STRUCTURING, 9)
    world.operations.operation_error = RuntimeError("missing")

    viewed = view(world)

    assert viewed.report_extracting is True
    assert viewed.runtime_operation is world.runtime.view


def test_an_operation_read_that_raises_does_not_set_report_extracting() -> None:
    world = World()
    with_runtime(world)
    world.runtime.read_error = RuntimeError("down")

    with pytest.raises(CaptureGatewayRejection) as caught:
        view(world)

    assert str(caught.value) == STATUS_UNAVAILABLE
    assert caught.value.__cause__ is None
    assert "observe" not in calls(world)
    assert "status_is" not in calls(world)


def test_an_active_capture_whose_observe_fails_is_unavailable() -> None:
    world = World()
    with_runtime(world)
    world.sessions.observe_error = RuntimeError("db")

    with pytest.raises(CaptureGatewayRejection) as caught:
        view(world)

    assert str(caught.value) == STATUS_UNAVAILABLE
    assert world.sessions.session.last_event_sequence == 0


@pytest.mark.parametrize(
    "status",
    ["completed", StreamingCaptureStatus.FAILED],
)
def test_a_terminal_session_whose_status_is_fails_returns_no_operation(status: object) -> None:
    world = World()
    with_runtime(world, status=CaptureReviewStatus.COMPLETED)
    world.runtime.view = _RuntimeOperation(status, 8)

    viewed = view(world)

    assert viewed.runtime_operation is None
    assert viewed.report_extracting is False
    assert ("observe", PROJECT, "session", 8) in world.trace
    assert ("status_is", "completed") in world.trace


def test_an_inactive_capture_tolerates_a_runtime_read_failure() -> None:
    world = World()
    with_runtime(world, status=CaptureReviewStatus.FAILED)
    world.runtime.read_error = RuntimeError("gone")

    viewed = view(world)

    assert viewed.runtime_operation is None
    assert viewed.report_extracting is False
    assert viewed.session.status == CaptureReviewStatus.FAILED
    assert "observe" not in calls(world)


def test_an_inactive_capture_tolerates_an_observe_failure() -> None:
    world = World()
    original = replace(
        review_session(),
        status=CaptureReviewStatus.CANCELED,
        runtime_capture_id=RUNTIME,
        last_event_sequence=2,
    )
    world.sessions.session = original
    world.sessions.observe_error = RuntimeError("db")
    world.runtime.view = _RuntimeOperation(StreamingCaptureStatus.CANCELLED, 9)

    viewed = view(world)

    assert viewed.session is original
    assert viewed.runtime_operation is None
    assert viewed.report_extracting is False
    assert ("read_operation", RUNTIME) in world.trace
    assert ("observe", PROJECT, "session", 9) in world.trace


def test_partial_and_raw_reject_a_closed_review_before_a_missing_id() -> None:
    world = World()
    with_runtime(world, status=CaptureReviewStatus.COMPLETED, runtime_id=None)

    for read in (view_partial, view_raw):
        with pytest.raises(CaptureReviewConflict) as caught:
            read(world)
        assert str(caught.value) == OCR_CLOSED

    assert "read_partial" not in calls(world)
    assert "read_raw" not in calls(world)


def test_partial_and_raw_reject_a_pending_review_without_a_runtime_id() -> None:
    world = World()

    for read in (view_partial, view_raw):
        with pytest.raises(CaptureReviewConflict) as caught:
            read(world)
        assert str(caught.value) == EXTRACTION_NOT_READY

    assert "read_partial" not in calls(world)
    assert "read_raw" not in calls(world)


def test_partial_and_raw_return_the_runtime_value() -> None:
    world = World()
    with_runtime(world)
    world.runtime.partial = "partial-body"
    world.runtime.raw = "raw-body"

    assert view_partial(world) == "partial-body"
    assert view_raw(world) == "raw-body"
    assert calls(world) == ["get", "read_partial", "get", "read_raw"]


def test_partial_and_raw_runtime_errors_propagate_unwrapped() -> None:
    world = World()
    with_runtime(world)
    world.runtime.partial_error = RuntimeError("partial down")

    with pytest.raises(RuntimeError, match="partial down") as partial_caught:
        view_partial(world)

    assert type(partial_caught.value) is RuntimeError

    world.runtime.raw_error = ValueError("raw down")

    with pytest.raises(ValueError, match="raw down") as raw_caught:
        view_raw(world)

    assert type(raw_caught.value) is ValueError


def test_structure_rejects_a_review_that_is_not_pending_before_a_missing_id() -> None:
    world = World()
    with_runtime(world, status=CaptureReviewStatus.CONFIRMING, runtime_id=None)

    with pytest.raises(CaptureReviewConflict) as caught:
        preview(world)

    assert str(caught.value) == REVIEW_NOT_PENDING
    assert str(caught.value) != OCR_CLOSED
    assert "read_raw" not in calls(world)


def test_structure_rejects_a_pending_review_without_a_runtime_id() -> None:
    world = World()

    with pytest.raises(CaptureReviewConflict) as caught:
        preview(world)

    assert str(caught.value) == EXTRACTION_NOT_READY
    assert "read_raw" not in calls(world)


def test_structure_validates_then_structures_without_finishing_the_session() -> None:
    world = World()
    with_runtime(world)

    assert preview(world) == "structured"
    assert calls(world) == ["get", "read_raw", "validate_review", "structure"]
    assert "finish" not in calls(world)


@pytest.mark.parametrize("error", [RuntimeError("raw down"), ValueError("raw value")])
def test_a_raw_read_error_propagates_before_review_validation(error: Exception) -> None:
    world = World()
    with_runtime(world)
    world.runtime.raw_error = error

    with pytest.raises(type(error)) as caught:
        preview(world)

    assert caught.value is error
    assert not isinstance(caught.value, CaptureReviewInputRejected)
    assert "validate_review" not in calls(world)
    assert "structure" not in calls(world)


def test_a_rejected_review_edit_keeps_the_validation_text() -> None:
    world = World()
    with_runtime(world)
    message = "review edit references unknown segmentId 'x'"
    world.runtime.validate_error = ValueError(message)

    with pytest.raises(CaptureReviewInputRejected) as caught:
        preview(world)

    assert str(caught.value) == message
    assert caught.value.__cause__ is world.runtime.validate_error
    assert "structure" not in calls(world)


def test_a_canceled_structure_is_the_cancelled_conflict() -> None:
    world = World()
    with_runtime(world)
    cause = CaptureExtractionCanceled("stopped")
    world.runtime.structure_error = cause

    with pytest.raises(CaptureReviewConflict) as caught:
        preview(world)

    assert str(caught.value) == REVIEW_CANCELLED
    assert caught.value.__cause__ is cause
    assert "finish" not in calls(world)


@pytest.mark.parametrize("error", [RuntimeError("boom"), ValueError("second validation")])
def test_any_other_structure_error_is_the_structuring_gateway(error: Exception) -> None:
    world = World()
    with_runtime(world)
    world.runtime.structure_error = error

    with pytest.raises(CaptureGatewayRejection) as caught:
        preview(world)

    assert str(caught.value) == STRUCTURE_FAILED
    assert caught.value.__cause__ is error
    assert "finish" not in calls(world)


def test_structure_cancels_when_the_operation_is_not_running() -> None:
    world = World()
    with_runtime(world)

    preview(world)

    cancel = world.runtime.should_cancel
    assert cancel is not None
    assert cancel() is False
    world.operations.status = DocumentOperationStatus.QUEUED
    assert cancel() is True
    world.operations.operation_error = RuntimeError("missing")
    assert cancel() is True
    assert "is_closed" not in calls(world)
    assert "finish" not in calls(world)


def test_runtime_status_predicates_keep_identity_apart_from_membership() -> None:
    class _Operation:
        def __init__(self, status: object) -> None:
            self.status = status

    runtime = CoordinatorCaptureRuntime(object())
    member = _Operation(StreamingCaptureStatus.COMPLETED)
    assert runtime.status_is(member, "completed") is True
    assert runtime.status_equals(member, "completed", "failed", "cancelled") is True

    text = _Operation("completed")
    assert runtime.status_is(text, "completed") is False
    assert runtime.status_equals(text, "completed", "failed", "cancelled") is True

    extracting = _Operation(StreamingCaptureStatus.EXTRACTING)
    assert runtime.status_is(extracting, "awaiting_structuring") is False
    assert runtime.status_equals(extracting, "completed", "failed", "cancelled") is False

    awaiting = _Operation(StreamingCaptureStatus.AWAITING_STRUCTURING)
    assert runtime.status_is(awaiting, "awaiting_structuring") is True
