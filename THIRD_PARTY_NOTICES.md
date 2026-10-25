# Third-Party Notices

Cert Prep is licensed under the MIT License. Before a public Alpha is released,
redistributed runtime archives and installers must include machine-generated
SBOMs and the license texts required by their bundled dependencies. A release
remains blocked while a redistributed component has unknown or unapproved
terms.

## Qwen 3.5

Qwen 3.5 models are downloaded by the selected local runtime and are not
bundled in Cert Prep installers. The Qwen3.5-4B model is provided under the
Apache License 2.0:
https://huggingface.co/Qwen/Qwen3.5-4B/blob/main/LICENSE

## Speech recognition models

Speech recognition models are downloaded by Capture Runtime only after explicit
user consent and are not bundled in Cert Prep installers. TEA-ASR-1.1 (CUDA) and
its CPU fallback TEA-ASR-1.1-mini are provided under the MIT License and the
Apache License 2.0. They build on Qwen3-ASR, and word timing uses
Qwen3-ForcedAligner; both are provided under the Apache License 2.0:

- https://huggingface.co/JacobLinCool/TEA-ASR-1.1
- https://huggingface.co/JacobLinCool/TEA-ASR-1.1-mini
- https://huggingface.co/Qwen/Qwen3-ASR-1.7B-hf
- https://huggingface.co/Qwen/Qwen3-ASR-0.6B-hf
- https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B-hf

## WindowsML OCR payload

The downloadable OCR runtime contains PP-OCRv6 medium detection and recognition
model payloads derived from the official PaddleOCR/PaddleX release sources.
The release inventory records each ONNX model, config, dictionary, and pipeline
file with its own SHA-256. PaddleOCR v3.7.0 and PaddleX v3.7.1 are provided
under the Apache License 2.0:

- https://github.com/PaddlePaddle/PaddleOCR/blob/v3.7.0/LICENSE
- https://github.com/PaddlePaddle/PaddleX/blob/v3.7.1/LICENSE

## PyInstaller bootloader

The backend and OCR executables include the PyInstaller v6.20.0 bootloader.
Its GPL-2.0-or-later license includes the PyInstaller bootloader exception that
permits distribution of the produced executable; the complete pinned COPYING
text is included in release license inventory:
https://github.com/pyinstaller/pyinstaller/blob/v6.20.0/COPYING.txt

## Generated inventories

Release-specific component names, versions, licenses, checksums, and source
locations must be published beside each alpha as SPDX/CycloneDX SBOM artifacts.
