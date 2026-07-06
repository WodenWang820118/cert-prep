from fastapi.testclient import TestClient

from cert_prep_backend.domains.mock_exams.ports import ProviderHealth
from conftest import minimal_pdf


_USE_CHUNK_EVIDENCE = object()


def _create_project(client: TestClient, auth_headers) -> str:
    response = client.post("/projects", headers=auth_headers, json={"name": "Azure"})
    assert response.status_code == 201
    return response.json()["id"]

def _upload_document(client: TestClient, auth_headers, project_id: str) -> str:
    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={
            "file": (
                "azure.pdf",
                minimal_pdf("Least privilege keeps cloud permissions scoped."),
                "application/pdf",
            )
        },
    )
    assert response.status_code == 201
    return response.json()["id"]

def _generate_playable_question(
    client: TestClient,
    auth_headers,
    project_id: str,
    document_id: str,
) -> dict:
    response = client.post(
        f"/projects/{project_id}/documents/{document_id}/drafts",
        headers=auth_headers,
        json={"limit": 1, "strategy": "hybrid_reasoning"},
    )
    assert response.status_code == 201
    draft = response.json()["items"][0]
    assert draft["status"] == "approved"
    return draft

def _create_manual_question(
    client: TestClient,
    auth_headers,
    project_id: str,
    document_id: str,
    *,
    question: str = "Which access model should be applied?",
    choices: list[str] | None = None,
    answer: str | None = "Use least privilege",
    rationale: str | None = "The document says permissions should remain scoped.",
    citation_page: int | None | object = _USE_CHUNK_EVIDENCE,
    source_excerpt: str | None | object = _USE_CHUNK_EVIDENCE,
    source_order: int | None = None,
) -> dict:
    chunks_response = client.get(
        f"/projects/{project_id}/documents/{document_id}/chunks",
        headers=auth_headers,
    )
    assert chunks_response.status_code == 200
    chunk = chunks_response.json()["items"][0]
    created = client.post(
        f"/projects/{project_id}/question-drafts",
        headers=auth_headers,
        json={
            "question": question,
            "choices": choices or ["Use least privilege", "Allow unrestricted access"],
            "answer": answer,
            "rationale": rationale,
            "document_id": document_id,
            "chunk_id": chunk["id"],
            "citation_page": (
                chunk["page_number"]
                if citation_page is _USE_CHUNK_EVIDENCE
                else citation_page
            ),
            "source_excerpt": (
                chunk["source_excerpt"]
                if source_excerpt is _USE_CHUNK_EVIDENCE
                else source_excerpt
            ),
            "source_order": source_order,
            "item_kind": "vocabulary_single",
        },
    )
    assert created.status_code == 201
    assert created.json()["status"] == "approved"
    return created.json()

class UnavailableExplanationProvider:
    provider = "unavailable-test"
    model = "missing-model"

    def health(self) -> ProviderHealth:
        return ProviderHealth(
            provider=self.provider,
            model=self.model,
            available=False,
            detail="provider unavailable",
            unavailable_reason="provider_unavailable",
        )

    def generate_drafts(self, chunks, limit):
        raise AssertionError("explanation fallback must not generate drafts")
