from capture_runtime_client import CaptureSourceKind
from cert_prep_contracts.sources import SourceKind


def to_capture_source_kind(kind: SourceKind) -> CaptureSourceKind:
    return CaptureSourceKind(kind)
