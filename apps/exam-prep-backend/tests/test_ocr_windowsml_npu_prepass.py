from __future__ import annotations

from pathlib import Path
import json
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from exam_prep_backend.domains.source_documents.adapters.windowsml import (  # noqa: E402
    npu_prepass as windowsml_npu,
)


def test_npu_prepass_profile_summary_counts_vitisai_events(tmp_path: Path) -> None:
    profile_path = tmp_path / "profile.json"
    profile_path.write_text(
        json.dumps(
            [
                {"cat": "Kernel", "args": {"provider": "VitisAIExecutionProvider"}},
                {"cat": "Kernel", "args": {"provider": "CPUExecutionProvider"}},
                {"cat": "Kernel", "args": {"provider_name": "VitisAIExecutionProvider"}},
                {"cat": "Kernel", "args": {"provider": "DmlExecutionProvider"}},
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    counts = windowsml_npu.summarize_profile_provider_counts(profile_path)

    assert counts[windowsml_npu.VITISAI_PROVIDER] == 2
    assert counts[windowsml_npu.CPU_PROVIDER] == 1
    assert counts["DmlExecutionProvider"] == 1


def test_npu_prepass_evidence_requires_vitisai_events() -> None:
    evidence = windowsml_npu.NpuPrepassEvidence(
        attempted=True,
        available=False,
        model_name=windowsml_npu.NPU_PREPASS_MODEL_NAME,
        policy="PREFER_NPU",
        provider_counts={windowsml_npu.CPU_PROVIDER: 4},
        duration_ms=1,
        reason="vitisai_events_missing",
    )

    assert evidence.fallback_reason_fragment() == (
        "npu_prepass_unavailable=vitisai_events_missing;vitisai_events=0;cpu_events=4"
    )
