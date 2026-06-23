from __future__ import annotations

from cert_prep_ocr_windowsml.tools.windowsml import ocr_windowsml_prepare as _prepare
from cert_prep_ocr_windowsml.tools.windowsml.ocr_windowsml_prepare import *  # noqa: F401,F403
from cert_prep_ocr_windowsml.tools.windowsml.ocr_windowsml_prepare import (
    __all__ as _PUBLIC_NAMES,
)

metadata_artifacts = _prepare.metadata_artifacts

__all__ = [*_PUBLIC_NAMES, "metadata_artifacts"]
