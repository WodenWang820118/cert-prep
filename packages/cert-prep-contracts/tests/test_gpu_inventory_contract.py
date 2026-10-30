from dataclasses import asdict

from cert_prep_contracts.hardware import MachineAcceleratorSnapshot


def test_old_accelerator_construction_remains_valid():
    snapshot = MachineAcceleratorSnapshot("gpu", "fixture", "nvidia", 123, "driver", "GPU-id")
    assert snapshot.device_id == "GPU-id"
    assert snapshot.memory_bytes == 123
    additions = {
        "classification",
        "dedicated_memory_bytes",
        "shared_memory_bytes",
        "classification_source",
        "pci_vendor_id",
        "pci_device_id",
        "adapter_luid",
        "pnp_device_id",
    }
    assert all(asdict(snapshot)[key] is None for key in additions)
