from cert_prep_contracts.hardware import (
    MachineAcceleratorSnapshot,
    MachineCpuSnapshot,
    MachineInventorySnapshot,
    MachineRamSnapshot,
    MachineStorageSnapshot,
)
from cert_prep_backend.ai_providers.infrastructure import machine_inventory


def test_machine_inventory_endpoint_preserves_native_gpu_evidence(
    client, auth_headers, monkeypatch
):
    snapshot = MachineInventorySnapshot(
        platform="Windows",
        platform_version="fixture",
        architecture="AMD64",
        cpu=MachineCpuSnapshot(architecture="AMD64"),
        ram=MachineRamSnapshot(),
        storage=MachineStorageSnapshot("fixture"),
        accelerators=(
            MachineAcceleratorSnapshot(
                kind="gpu",
                name="AMD Radeon(TM) 880M Graphics",
                memory_bytes=298_012_672,
                classification="integrated",
                classification_source="native_dxgi",
                dedicated_memory_bytes=298_012_672,
                shared_memory_bytes=16_706_365_440,
                pci_vendor_id="1002",
                pci_device_id="150e",
                adapter_luid="0000000000012fd0",
            ),
        ),
    )
    monkeypatch.setattr(machine_inventory, "collect_machine_inventory", lambda **kwargs: snapshot)
    response = client.get("/runtime/machine-inventory?refresh=true", headers=auth_headers)
    assert response.status_code == 200
    accelerator = response.json()["accelerators"][0]
    assert accelerator["classification"] == "integrated"
    assert accelerator["classification_source"] == "native_dxgi"
    assert accelerator["memory_bytes"] == accelerator["dedicated_memory_bytes"] == 298_012_672
    assert accelerator["shared_memory_bytes"] == 16_706_365_440
    assert accelerator["pci_vendor_id"] == "1002"
    assert accelerator["pci_device_id"] == "150e"
    assert accelerator["adapter_luid"] == "0000000000012fd0"
