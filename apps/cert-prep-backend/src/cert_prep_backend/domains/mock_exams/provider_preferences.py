from __future__ import annotations

import json
from typing import Literal

from cert_prep_backend.core.config import Settings
from cert_prep_backend.persistence.database import Database, utc_now
from cert_prep_contracts.llm import FASTFLOWLM_RUNTIME_TRUST_POLICY


FASTFLOWLM_TERMS_DECISION_KEY = "llm.fastflowlm_terms_decision"
FastFlowLMTermsDecision = Literal["accepted", "declined"]


def apply_persisted_fastflowlm_terms_decision(
    settings: Settings,
    db: Database,
) -> None:
    """Apply the local user's durable terms decision before provider selection."""

    with db.connect() as connection:
        row = connection.execute(
            "SELECT value FROM app_metadata WHERE key = ?",
            (FASTFLOWLM_TERMS_DECISION_KEY,),
        ).fetchone()
    if row is None:
        return
    try:
        payload = json.loads(str(row["value"]))
    except (json.JSONDecodeError, TypeError):
        return
    decision = payload.get("decision")
    version = payload.get("terms_version")
    if decision == "accepted" and version == FASTFLOWLM_RUNTIME_TRUST_POLICY.version:
        settings.fastflowlm_terms_accepted_version = version
        settings.fastflowlm_terms_declined = False
    elif decision == "declined":
        settings.fastflowlm_terms_accepted_version = None
        settings.fastflowlm_terms_declined = True


def persist_fastflowlm_terms_decision(
    settings: Settings,
    db: Database,
    *,
    decision: FastFlowLMTermsDecision,
    terms_version: str | None,
) -> None:
    policy_version = FASTFLOWLM_RUNTIME_TRUST_POLICY.version
    if decision == "accepted" and terms_version != policy_version:
        raise ValueError(f"FastFlowLM terms version must be {policy_version}.")
    if decision == "declined" and terms_version not in {None, policy_version}:
        raise ValueError("FastFlowLM declined terms version is not allowlisted.")

    accepted_version = policy_version if decision == "accepted" else None
    payload = json.dumps(
        {
            "decision": decision,
            "terms_version": accepted_version,
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    now = utc_now()
    with db.connect() as connection:
        connection.execute(
            """
            INSERT INTO app_metadata(key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
            """,
            (FASTFLOWLM_TERMS_DECISION_KEY, payload, now),
        )
    settings.fastflowlm_terms_accepted_version = accepted_version
    settings.fastflowlm_terms_declined = decision == "declined"


__all__ = [
    "FASTFLOWLM_TERMS_DECISION_KEY",
    "FastFlowLMTermsDecision",
    "apply_persisted_fastflowlm_terms_decision",
    "persist_fastflowlm_terms_decision",
]
