"""`GET /llm/health` device is an optional, additive contract."""

from __future__ import annotations

import json
from enum import StrEnum
from pathlib import Path

from cert_prep_backend.ai_providers.api.schemas import LLMHealthRead
from cert_prep_backend.ai_providers.domain.device import (
    DeviceBackend,
    DeviceTarget,
    DeviceVerification,
    OllamaServerOwnership,
)
from cert_prep_backend.bootstrap.app import create_app
from cert_prep_backend.platform.config import Settings


_DEVICE_FIELDS = {
    "server",
    "requested",
    "verification",
    "observed",
    "corrective_restarts",
}
_ENUM_FIELDS = (
    (OllamaServerOwnership, "OllamaDeviceRead", "server"),
    (DeviceVerification, "OllamaDeviceRead", "verification"),
    (DeviceTarget, "RequestedDeviceRead", "target"),
    (DeviceBackend, "RequestedDeviceRead", "backend"),
    (DeviceBackend, "ObservedDeviceRead", "backend"),
)


def _schemas(tmp_path: Path) -> dict:
    return create_app(
        Settings(data_dir=tmp_path, api_token="fixture", llm_provider="fake")
    ).openapi()["components"]["schemas"]


def _ref_name(prop: dict) -> str:
    if "$ref" in prop:
        return prop["$ref"].rsplit("/", 1)[-1]
    for key in ("anyOf", "oneOf", "allOf"):
        refs = [item["$ref"] for item in prop.get(key, []) if "$ref" in item]
        if refs:
            assert len(refs) == 1
            return refs[0].rsplit("/", 1)[-1]
    raise AssertionError(f"expected a named schema, got {prop}")


def _nullable_ref(prop: dict) -> str:
    options = prop.get("anyOf") or prop.get("oneOf") or [prop]
    assert {"type": "null"} in options
    return _ref_name(prop)


def _enum_component(schemas: dict, schema_name: str, field_name: str) -> tuple[str, list]:
    name = _ref_name(schemas[schema_name]["properties"][field_name])
    assert "enum" in schemas[name]
    return name, schemas[name]["enum"]


def test_device_is_optional_and_nullable(tmp_path: Path) -> None:
    schemas = _schemas(tmp_path)
    health = schemas["LLMHealthRead"]
    assert "device" not in health.get("required", [])
    assert LLMHealthRead.model_fields["device"].default is None
    assert _nullable_ref(health["properties"]["device"]) == "OllamaDeviceRead"
    device = schemas["OllamaDeviceRead"]
    assert set(device["properties"]) == _DEVICE_FIELDS
    assert set(device["required"]) == {"server", "verification", "corrective_restarts"}
    assert _nullable_ref(device["properties"]["requested"]) == "RequestedDeviceRead"
    assert _nullable_ref(device["properties"]["observed"]) == "ObservedDeviceRead"
    assert "observed_at" not in device["properties"]
    assert "detail" not in device["properties"]


def test_old_health_payload_still_validates_and_drops_internal_device_fields() -> None:
    old = {
        "provider": "ollama",
        "model": "qwen3.5:4b",
        "available": True,
        "detail": "model available",
    }
    assert LLMHealthRead.model_validate(old).device is None
    assert LLMHealthRead.model_validate({**old, "device": None}).device is None
    read = LLMHealthRead.model_validate(
        {
            **old,
            "device": {
                "server": "owned",
                "verification": "pending",
                "corrective_restarts": 0,
                "observed_at": 1.5,
                "detail": "English sentence that stays internal",
            },
        }
    )
    dumped = read.model_dump()
    assert dumped["detail"] == "model available"
    assert set(dumped["device"]) == _DEVICE_FIELDS
    assert dumped["device"]["requested"] is None
    assert dumped["device"]["observed"] is None


def test_every_device_enum_value_maps_to_a_vocabulary_concept(tmp_path: Path) -> None:
    vocabulary = Path(__file__).resolve().parents[4] / (
        "packages/cert-prep-contracts/vocabulary/cert-prep-vocabulary-v1.json"
    )
    concepts = json.loads(vocabulary.read_text(encoding="utf-8"))["concepts"]
    schemas = _schemas(tmp_path)
    seen: dict[type[StrEnum], str] = {}
    for enum, schema_name, field_name in _ENUM_FIELDS:
        component, values = _enum_component(schemas, schema_name, field_name)
        assert component == enum.__name__
        assert sorted(values) == sorted(member.value for member in enum)
        seen.setdefault(enum, component)
        assert seen[enum] == component
    for enum, component in seen.items():
        mapped = [
            item["enum"]["value"]
            for item in concepts
            if item.get("enum", {}).get("enumId") == component and not item["retired"]
        ]
        assert sorted(mapped) == sorted(member.value for member in enum)
