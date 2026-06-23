from __future__ import annotations

import sys

from cert_prep_ocr_windowsml import npu_prepass as _npu_prepass

sys.modules[__name__] = _npu_prepass
