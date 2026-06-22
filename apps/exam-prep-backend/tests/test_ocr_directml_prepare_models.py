from __future__ import annotations

from pathlib import Path
import sys
import tarfile


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from ocr_directml_prepare_models import (  # noqa: E402
    BACKEND_ROOT,
    ConversionResult,
    SourceArtifact,
    build_report,
    default_output_path,
    docker_work_path,
    safe_extract_tar,
    sha256_file,
)


def test_prepare_models_reports_converter_blocker(tmp_path: Path) -> None:
    sources_dir = tmp_path / "sources"
    model_dir = tmp_path / "models"
    artifacts = _fixture_artifacts(sources_dir)

    report = build_report(
        sources_dir=sources_dir,
        model_dir=model_dir,
        allow_download=False,
        artifacts=artifacts,
        converter_runner=_converter_unavailable,
    )

    assert report["status"]["state"] == "blocked"
    assert "conversion_tool_unavailable" in report["status"]["blockers"]
    assert "model_artifacts_missing" in report["status"]["blockers"]
    assert report["metadata"]["state"] == "ready"
    assert report["metadata"]["character_count"] == 3
    assert (model_dir / "rec_char_dict.txt").read_text(encoding="utf-8").splitlines() == [
        "A",
        "B",
        "1",
    ]
    assert (model_dir / "pipeline.json").is_file()
    assert not (model_dir / "det_model.onnx").exists()
    assert not (model_dir / "rec_model.onnx").exists()


def test_prepare_models_copies_converted_onnx_models(tmp_path: Path) -> None:
    sources_dir = tmp_path / "sources"
    model_dir = tmp_path / "models"
    artifacts = _fixture_artifacts(sources_dir)

    report = build_report(
        sources_dir=sources_dir,
        model_dir=model_dir,
        allow_download=False,
        artifacts=artifacts,
        converter_runner=_successful_converter,
    )

    assert report["status"]["state"] == "ready"
    assert report["status"]["blockers"] == []
    assert (model_dir / "det_model.onnx").read_bytes() == b"fake-det-onnx"
    assert (model_dir / "rec_model.onnx").read_bytes() == b"fake-rec-onnx"


def test_prepare_models_force_conversion_replaces_existing_models(tmp_path: Path) -> None:
    sources_dir = tmp_path / "sources"
    model_dir = tmp_path / "models"
    artifacts = _fixture_artifacts(sources_dir)
    model_dir.mkdir()
    (model_dir / "det_model.onnx").write_bytes(b"old-det")
    (model_dir / "rec_model.onnx").write_bytes(b"old-rec")

    report = build_report(
        sources_dir=sources_dir,
        model_dir=model_dir,
        allow_download=False,
        converter="docker",
        force_conversion=True,
        artifacts=artifacts,
        converter_runner=_successful_converter,
    )

    assert report["mode"]["converter"] == "docker"
    assert report["status"]["state"] == "ready"
    assert (model_dir / "det_model.onnx").read_bytes() == b"fake-det-onnx"
    assert (model_dir / "rec_model.onnx").read_bytes() == b"fake-rec-onnx"


def test_docker_work_path_uses_backend_mount() -> None:
    source_dir = BACKEND_ROOT / ".benchmarks" / "ocr-directml-sources" / "extracted"

    assert docker_work_path(source_dir) == "/work/.benchmarks/ocr-directml-sources/extracted"


def test_safe_extract_tar_rejects_path_traversal(tmp_path: Path) -> None:
    archive = tmp_path / "unsafe.tar"
    payload = tmp_path / "payload.txt"
    payload.write_text("nope", encoding="utf-8")
    with tarfile.open(archive, "w") as handle:
        handle.add(payload, arcname="../escape.txt")

    try:
        safe_extract_tar(
            archive_path=archive,
            destination=tmp_path / "out",
            expected_root="model",
        )
    except ValueError as exc:
        assert "unsafe archive member path" in str(exc)
    else:
        raise AssertionError("path traversal archive should be rejected")


def test_prepare_models_default_output_is_benchmark_artifact() -> None:
    output = default_output_path()

    assert output.parent.name == ".benchmarks"
    assert output.name.startswith("ocr-directml-prepare-models-")
    assert output.suffix == ".json"


def _fixture_artifacts(sources_dir: Path) -> tuple[SourceArtifact, SourceArtifact]:
    sources_dir.mkdir(parents=True)
    det = _write_model_archive(
        sources_dir=sources_dir,
        kind="det",
        root="fixture_det",
        filename="fixture_det.tar",
        model_name="fixture_det_model",
        yml=_det_yml(),
    )
    rec = _write_model_archive(
        sources_dir=sources_dir,
        kind="rec",
        root="fixture_rec",
        filename="fixture_rec.tar",
        model_name="fixture_rec_model",
        yml=_rec_yml(),
    )
    return det, rec


def _write_model_archive(
    *,
    sources_dir: Path,
    kind: str,
    root: str,
    filename: str,
    model_name: str,
    yml: str,
) -> SourceArtifact:
    staging = sources_dir / "staging" / root
    staging.mkdir(parents=True)
    (staging / "inference.yml").write_text(yml, encoding="utf-8")
    (staging / "inference.json").write_text("{}", encoding="utf-8")
    (staging / "inference.pdiparams").write_bytes(b"params")
    archive_path = sources_dir / filename
    with tarfile.open(archive_path, "w") as handle:
        handle.add(staging, arcname=root)
    return SourceArtifact(
        kind=kind,
        model_name=model_name,
        url=f"https://example.test/{filename}",
        filename=filename,
        sha256=sha256_file(archive_path),
        byte_size=archive_path.stat().st_size,
        archive_root=root,
        target_onnx_name=f"{kind}_model.onnx",
    )


def _det_yml() -> str:
    return """
Global:
  model_name: fixture_det_model
PreProcess:
  transform_ops:
    - DetResizeForTest:
        resize_long: 960
PostProcess:
  name: DBPostProcess
  thresh: 0.3
""".strip()


def _rec_yml() -> str:
    return """
Global:
  model_name: fixture_rec_model
PreProcess:
  transform_ops:
    - RecResizeImg:
        image_shape: [3, 48, 320]
PostProcess:
  name: CTCLabelDecode
  character_dict:
    - A
    - B
    - '1'
""".strip()


def _converter_unavailable(
    artifact: SourceArtifact,
    _source_dir: Path,
    _output_dir: Path,
) -> ConversionResult:
    return ConversionResult(
        state="failed",
        command=["fixture-converter", artifact.kind],
        stdout="Please install the Paddle2ONNX plugin first.",
        stderr="",
        blocker="conversion_tool_unavailable",
    )


def _successful_converter(
    artifact: SourceArtifact,
    _source_dir: Path,
    output_dir: Path,
) -> ConversionResult:
    output_dir.mkdir(parents=True, exist_ok=True)
    output_model = output_dir / "inference.onnx"
    output_model.write_bytes(f"fake-{artifact.kind}-onnx".encode("utf-8"))
    return ConversionResult(
        state="ready",
        command=["fixture-converter", artifact.kind],
        stdout="ok",
        stderr="",
        output_model=output_model,
    )
