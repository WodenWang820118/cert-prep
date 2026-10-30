"""Read-only DXGI/D3D12 inventory, independent of model runtimes.

Ported from Capture Runtime's ocr_preflight native adapter probe. DXGI byte
counts describe memory pools; only D3D12 UMA establishes hardware integration.
"""

from __future__ import annotations

import ctypes
from dataclasses import dataclass
import sys
from typing import Any

from cert_prep_contracts.hardware import MachineAcceleratorSnapshot


class _Guid(ctypes.Structure):
    _fields_ = [
        ("data1", ctypes.c_uint32),
        ("data2", ctypes.c_uint16),
        ("data3", ctypes.c_uint16),
        ("data4", ctypes.c_ubyte * 8),
    ]


class _Luid(ctypes.Structure):
    _fields_ = [("low_part", ctypes.c_uint32), ("high_part", ctypes.c_int32)]


class _DxgiAdapterDesc1(ctypes.Structure):
    _fields_ = [
        ("description", ctypes.c_wchar * 128),
        ("vendor_id", ctypes.c_uint32),
        ("device_id", ctypes.c_uint32),
        ("subsystem_id", ctypes.c_uint32),
        ("revision", ctypes.c_uint32),
        ("dedicated_video_memory", ctypes.c_size_t),
        ("dedicated_system_memory", ctypes.c_size_t),
        ("shared_system_memory", ctypes.c_size_t),
        ("adapter_luid", _Luid),
        ("flags", ctypes.c_uint32),
    ]


class _Architecture(ctypes.Structure):
    _fields_ = [
        ("node_index", ctypes.c_uint32),
        ("tile_based_renderer", ctypes.c_int32),
        ("uma", ctypes.c_int32),
        ("cache_coherent_uma", ctypes.c_int32),
    ]


_IID_FACTORY = _Guid(0x770AAE78, 0xF26F, 0x4DBA, (0xA8, 0x29, 0x25, 0x3C, 0x83, 0xD1, 0xB3, 0x87))
_IID_DEVICE = _Guid(0x189819F1, 0x1DB6, 0x4B57, (0xBE, 0x54, 0x18, 0x21, 0x33, 0x9B, 0x85, 0xF7))


@dataclass(frozen=True, slots=True)
class _NativeAdapter:
    ordinal: int
    name: str
    pci_vendor_id: str
    pci_device_id: str
    adapter_luid: str
    dedicated_memory_bytes: int
    shared_memory_bytes: int
    is_software: bool
    uma: bool | None
    evidence_note: str | None = None

    def snapshot(self) -> MachineAcceleratorSnapshot:
        classification = (
            "software"
            if self.is_software
            else "integrated"
            if self.uma is True
            else "dedicated"
            if self.uma is False
            else "unknown"
        )
        return MachineAcceleratorSnapshot(
            kind="gpu",
            name=self.name,
            vendor={"1002": "amd", "10de": "nvidia", "8086": "intel"}.get(self.pci_vendor_id),
            # A new native-only observation reports video memory, never shared RAM.
            memory_bytes=self.dedicated_memory_bytes,
            classification=classification,
            dedicated_memory_bytes=self.dedicated_memory_bytes,
            shared_memory_bytes=self.shared_memory_bytes,
            classification_source="native_dxgi",
            pci_vendor_id=self.pci_vendor_id,
            pci_device_id=self.pci_device_id,
            adapter_luid=self.adapter_luid,
        )


def _com_method(pointer: ctypes.c_void_p, index: int, result: Any, *arguments: Any) -> Any:
    vtable = ctypes.cast(pointer, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    # COM uses stdcall on 32-bit Windows; WINFUNCTYPE also works on Windows x64.
    return ctypes.WINFUNCTYPE(result, ctypes.c_void_p, *arguments)(vtable[index])


def _release_com(pointer: ctypes.c_void_p) -> None:
    if pointer.value:
        _com_method(pointer, 2, ctypes.c_ulong)(pointer)


def _native_adapter_uma(adapter: ctypes.c_void_p) -> tuple[bool | None, str | None]:
    device = ctypes.c_void_p()
    try:
        library = ctypes.WinDLL("d3d12.dll")
        create_device = library.D3D12CreateDevice
        create_device.argtypes = [
            ctypes.c_void_p,
            ctypes.c_uint32,
            ctypes.POINTER(_Guid),
            ctypes.POINTER(ctypes.c_void_p),
        ]
        create_device.restype = ctypes.c_int32
        result = create_device(adapter, 0xB000, ctypes.byref(_IID_DEVICE), ctypes.byref(device))
        if result != 0 or not device.value:
            return None, f"D3D12CreateDevice unavailable (HRESULT 0x{result & 0xFFFFFFFF:08x})"
        architecture = _Architecture(node_index=0)
        check_feature = _com_method(
            device, 13, ctypes.c_int32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32
        )
        result = check_feature(device, 1, ctypes.byref(architecture), ctypes.sizeof(architecture))
        if result != 0:
            return None, f"D3D12 architecture unavailable (HRESULT 0x{result & 0xFFFFFFFF:08x})"
        if architecture.cache_coherent_uma and not architecture.uma:
            return None, "Contradictory D3D12 evidence: CacheCoherentUMA=true but UMA=false"
        return bool(architecture.uma), None
    except (AttributeError, OSError, TypeError, ValueError) as error:
        return None, f"D3D12 architecture unavailable: {error}"
    finally:
        _release_com(device)


def _native_adapter_luid(description: _DxgiAdapterDesc1) -> str:
    return (
        f"{description.adapter_luid.high_part & 0xFFFFFFFF:08x}"
        f"{description.adapter_luid.low_part:08x}"
    )


def _native_enumerate_adapters() -> tuple[_NativeAdapter, ...]:
    """Enumerate ordinary DXGI ordinals, retaining software for diagnostics."""
    if sys.platform != "win32":
        raise OSError("DXGI/D3D12 is unavailable on this platform")
    factory = ctypes.c_void_p()
    adapters: list[_NativeAdapter] = []
    try:
        library = ctypes.WinDLL("dxgi.dll")
        create_factory = library.CreateDXGIFactory1
        create_factory.argtypes = [ctypes.POINTER(_Guid), ctypes.POINTER(ctypes.c_void_p)]
        create_factory.restype = ctypes.c_int32
        result = create_factory(ctypes.byref(_IID_FACTORY), ctypes.byref(factory))
        if result != 0 or not factory.value:
            raise OSError(f"CreateDXGIFactory1 failed (HRESULT 0x{result & 0xFFFFFFFF:08x})")
        enumerate_adapter = _com_method(
            factory, 12, ctypes.c_int32, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)
        )
        for ordinal in range(256):
            adapter = ctypes.c_void_p()
            try:
                result = enumerate_adapter(factory, ordinal, ctypes.byref(adapter))
                if result & 0xFFFFFFFF == 0x887A0002:  # DXGI_ERROR_NOT_FOUND
                    return tuple(adapters)
                if result != 0 or not adapter.value:
                    raise OSError("DXGI adapter enumeration was incomplete")
                description = _DxgiAdapterDesc1()
                get_description = _com_method(
                    adapter, 10, ctypes.c_int32, ctypes.POINTER(_DxgiAdapterDesc1)
                )
                if get_description(adapter, ctypes.byref(description)) != 0:
                    raise OSError("DXGI adapter description unavailable")
                software = bool(description.flags & 2)
                uma, note = (None, None) if software else _native_adapter_uma(adapter)
                adapters.append(
                    _NativeAdapter(
                        ordinal=ordinal,
                        name=description.description,
                        pci_vendor_id=f"{description.vendor_id:04x}",
                        pci_device_id=f"{description.device_id:04x}",
                        adapter_luid=_native_adapter_luid(description),
                        dedicated_memory_bytes=int(description.dedicated_video_memory),
                        shared_memory_bytes=int(description.shared_system_memory),
                        is_software=software,
                        uma=uma,
                        evidence_note=note,
                    )
                )
            finally:
                _release_com(adapter)
        raise OSError("DXGI adapter enumeration exceeded its bound")
    finally:
        _release_com(factory)


def _native_gpu_accelerators(warnings: list[str]) -> list[MachineAcceleratorSnapshot]:
    try:
        adapters = _native_enumerate_adapters()
    except Exception as error:
        warnings.append(
            f"Native GPU classification unavailable; classification is unknown: {error}"
        )
        return []
    for adapter in adapters:
        if not adapter.is_software and adapter.uma is None:
            warnings.append(
                f"GPU classification unknown for {adapter.name}: "
                f"{adapter.evidence_note or 'D3D12 UMA evidence missing'}."
            )
    return [adapter.snapshot() for adapter in adapters]
