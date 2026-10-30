from dataclasses import asdict
import json
from pathlib import Path

from cert_prep_contracts.hardware import MachineAcceleratorSnapshot
from cert_prep_backend.ai_providers.api.schemas import MachineAcceleratorRead
from cert_prep_backend.api.app import create_app
from cert_prep_backend.platform.config import Settings


ADDITIONS = {
    "classification",
    "dedicated_memory_bytes",
    "shared_memory_bytes",
    "classification_source",
    "pci_vendor_id",
    "pci_device_id",
    "adapter_luid",
}


def test_accelerator_openapi_preserves_old_fields_and_adds_only_optional_properties(tmp_path):
    schema = create_app(
        Settings(
            data_dir=tmp_path,
            api_token="fixture",
            llm_provider="fake",
        )
    ).openapi()["components"]["schemas"]["MachineAcceleratorRead"]
    old = {"kind", "name", "vendor", "memory_bytes", "driver_version", "device_id"}
    assert set(schema["properties"]) == old | ADDITIONS
    assert schema["required"] == ["kind", "name"]
    for key in ADDITIONS:
        assert schema["properties"][key]["anyOf"][-1] == {"type": "null"}
        assert MachineAcceleratorRead.model_fields[key].default is None
    for key in old:
        item = schema["properties"][key]
        expected = "integer" if key == "memory_bytes" else "string"
        assert item.get("type", item.get("anyOf", [{}])[0].get("type")) == expected


def test_new_inline_enum_values_are_mapped_to_vocabulary_concepts():
    vocabulary = Path(__file__).resolve().parents[4] / (
        "packages/cert-prep-contracts/vocabulary/cert-prep-vocabulary-v1.json"
    )
    concepts = json.loads(vocabulary.read_text(encoding="utf-8"))["concepts"]
    schema = MachineAcceleratorRead.model_json_schema()
    for field in ("classification", "classification_source"):
        enum_id = f"MachineAcceleratorRead.{field}"
        mapped = [
            item["enum"]["value"]
            for item in concepts
            if item.get("enum", {}).get("enumId") == enum_id and not item["retired"]
        ]
        values = schema["properties"][field]["anyOf"][0]["enum"]
        assert sorted(mapped) == sorted(values)


def test_old_snapshot_and_payload_still_validate_without_new_fields():
    old = {"kind": "gpu", "name": "fixture", "memory_bytes": 123, "device_id": "GPU-id"}
    assert MachineAcceleratorRead.model_validate(old).classification is None
    dto = MachineAcceleratorRead.model_validate(MachineAcceleratorSnapshot(**old))
    assert dto.device_id == old["device_id"]
    assert dto.memory_bytes == 123
    assert all(getattr(dto, field) is None for field in ADDITIONS)


def test_snapshot_evidence_round_trips_but_internal_pnp_attribute_is_not_exposed():
    snapshot = MachineAcceleratorSnapshot(
        kind="gpu",
        name="fixture",
        device_id="GPU-id",
        pnp_device_id="PCI-id",
        classification="integrated",
        classification_source="native_dxgi",
        dedicated_memory_bytes=298_012_672,
        shared_memory_bytes=16_706_365_440,
        pci_vendor_id="1002",
        pci_device_id="150e",
        adapter_luid="0000000000012fd0",
    )
    dto = MachineAcceleratorRead.model_validate(snapshot)
    assert {field: getattr(dto, field) for field in ADDITIONS} == {
        field: asdict(snapshot)[field] for field in ADDITIONS
    }
    assert "pnp_device_id" not in dto.model_dump()
