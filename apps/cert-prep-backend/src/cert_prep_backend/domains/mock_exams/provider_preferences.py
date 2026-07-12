from __future__ import annotations

from dataclasses import dataclass
import json

from cert_prep_backend.core.config import Settings
from cert_prep_backend.persistence.database import Database, utc_now
from cert_prep_contracts.llm import (
    FASTFLOWLM_RUNTIME_TRUST_POLICY,
    FastFlowLMTermsDecision,
)


FASTFLOWLM_TERMS_DECISION_KEY = "llm.fastflowlm_terms_decision"


@dataclass(frozen=True, slots=True)
class PersistedFastFlowLMTermsDecision:
    decision: FastFlowLMTermsDecision
    terms_version: str


def apply_persisted_fastflowlm_terms_decision(
    settings: Settings,
    db: Database,
) -> PersistedFastFlowLMTermsDecision | None:
    """Ignore ambient acceptance and apply only the durable local decision."""

    settings.fastflowlm_terms_accepted_version = None
    settings.fastflowlm_terms_declined = False
    decision = read_fastflowlm_terms_decision(db)
    if decision is None:
        return None
    if decision.decision == FastFlowLMTermsDecision.ACCEPTED:
        settings.fastflowlm_terms_accepted_version = decision.terms_version
    else:
        settings.fastflowlm_terms_declined = True
    return decision


def read_fastflowlm_terms_decision(db: Database) -> PersistedFastFlowLMTermsDecision | None:
    """Read only the exact current-version terms decision from app metadata."""

    with db.connect() as connection:
        row = connection.execute(
            "SELECT value FROM app_metadata WHERE key = ?",
            (FASTFLOWLM_TERMS_DECISION_KEY,),
        ).fetchone()
    if row is None:
        return None
    try:
        payload = json.loads(str(row["value"]))
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    decision = payload.get("decision")
    terms_version = payload.get("terms_version")
    if terms_version != FASTFLOWLM_RUNTIME_TRUST_POLICY.version:
        return None
    try:
        parsed_decision = FastFlowLMTermsDecision(decision)
    except (TypeError, ValueError):
        return None
    return PersistedFastFlowLMTermsDecision(
        decision=parsed_decision,
        terms_version=terms_version,
    )


def fastflowlm_terms_are_accepted(db: Database) -> bool:
    decision = read_fastflowlm_terms_decision(db)
    return (
        decision is not None
        and decision.decision == FastFlowLMTermsDecision.ACCEPTED
    )


def persist_fastflowlm_terms_decision(
    settings: Settings,
    db: Database,
    *,
    decision: FastFlowLMTermsDecision,
    terms_version: str,
) -> PersistedFastFlowLMTermsDecision:
    """Persist one explicit decision for the exact terms the user was shown."""

    policy_version = FASTFLOWLM_RUNTIME_TRUST_POLICY.version
    if terms_version != policy_version:
        raise ValueError(f"FastFlowLM terms version must be {policy_version}.")
    durable_decision = PersistedFastFlowLMTermsDecision(
        decision=decision,
        terms_version=terms_version,
    )
    payload = json.dumps(
        {
            "decision": durable_decision.decision,
            "terms_version": durable_decision.terms_version,
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    with db.connect() as connection:
        connection.execute(
            """
            INSERT INTO app_metadata(key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
            """,
            (FASTFLOWLM_TERMS_DECISION_KEY, payload, utc_now()),
        )
    apply_persisted_fastflowlm_terms_decision(settings, db)
    return durable_decision


__all__ = [
    "FASTFLOWLM_TERMS_DECISION_KEY",
    "PersistedFastFlowLMTermsDecision",
    "apply_persisted_fastflowlm_terms_decision",
    "fastflowlm_terms_are_accepted",
    "persist_fastflowlm_terms_decision",
    "read_fastflowlm_terms_decision",
]
