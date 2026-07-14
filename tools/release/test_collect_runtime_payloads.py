from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile


SCRIPT = Path(__file__).with_name("collect-runtime-payloads.py")
DECLARATION = Path(__file__).with_name("ocr-runtime-payload-declaration.json")
SPEC = importlib.util.spec_from_file_location("collect_runtime_payloads", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Could not load collect-runtime-payloads.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RuntimePayloadInventoryTests(unittest.TestCase):
    def test_collects_every_declared_non_entrypoint_payload(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, archive = self._write_runtime(root)

            inventory = MODULE.collect_runtime_payloads(
                runtime_manifest=manifest,
                runtime_root=root,
                declaration_path=DECLARATION,
            )

            self.assertEqual(inventory["schemaVersion"], 1)
            self.assertEqual(inventory["artifact"]["sha256"], _sha256(archive))
            self.assertEqual(
                inventory["artifact"]["manifestSha256"],
                _sha256(manifest),
            )
            self.assertEqual(
                [item["path"] for item in inventory["entries"]],
                _declaration()["payloadEntries"],
            )
            self.assertTrue(all(item["bytes"] > 0 for item in inventory["entries"]))
            self.assertTrue(
                all(len(item["sha256"]) == 64 for item in inventory["entries"])
            )
            component = inventory["components"][0]
            self.assertEqual(component["ecosystem"], "generic")
            self.assertEqual(component["license"], "Apache-2.0")
            self.assertEqual(component["files"], inventory["entries"])
            self.assertEqual(
                component["sourceRepositories"],
                [
                    "https://github.com/PaddlePaddle/PaddleOCR",
                    "https://github.com/PaddlePaddle/PaddleX",
                ],
            )
            self.assertEqual(
                component["licenseEvidence"],
                [
                    "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/v3.7.0/LICENSE",
                    "https://raw.githubusercontent.com/PaddlePaddle/PaddleX/v3.7.1/LICENSE",
                ],
            )

    def test_rejects_any_undeclared_extra_entry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, _archive = self._write_runtime(
                root,
                extra_entries={"unapproved/model.bin": b"extra"},
            )
            with self.assertRaisesRegex(
                MODULE.PayloadInventoryError,
                "undeclared entries: unapproved/model.bin",
            ):
                MODULE.collect_runtime_payloads(
                    runtime_manifest=manifest,
                    runtime_root=root,
                    declaration_path=DECLARATION,
                )

    def test_rejects_artifact_digest_drift_before_inspecting_payloads(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, archive = self._write_runtime(root)
            archive.write_bytes(archive.read_bytes() + b"tamper")
            with self.assertRaisesRegex(
                MODULE.PayloadInventoryError,
                "byte count is invalid",
            ):
                MODULE.collect_runtime_payloads(
                    runtime_manifest=manifest,
                    runtime_root=root,
                    declaration_path=DECLARATION,
                )

    def test_rejects_pipeline_source_drift(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            declaration = _declaration()
            sources = declaration["sourceArtifacts"]
            pipeline_sources = [
                {key: value for key, value in item.items() if key != "payloadEntries"}
                for item in sources
            ]
            pipeline_sources[0]["url"] = "https://example.invalid/model.tar"
            manifest, _archive = self._write_runtime(
                root,
                pipeline_sources=pipeline_sources,
            )
            with self.assertRaisesRegex(
                MODULE.PayloadInventoryError,
                "pipeline source or required-file contract is invalid",
            ):
                MODULE.collect_runtime_payloads(
                    runtime_manifest=manifest,
                    runtime_root=root,
                    declaration_path=DECLARATION,
                )

    def _write_runtime(
        self,
        root: Path,
        *,
        extra_entries: dict[str, bytes] | None = None,
        pipeline_sources: list[dict[str, object]] | None = None,
    ) -> tuple[Path, Path]:
        declaration = _declaration()
        archive = root / "runtime.zip"
        expected_sources = pipeline_sources or [
            {key: value for key, value in item.items() if key != "payloadEntries"}
            for item in declaration["sourceArtifacts"]
        ]
        pipeline = {
            "schema_version": 1,
            "model_family": "PP-OCRv6_medium",
            "source": "PaddleX official inference models",
            "source_artifacts": expected_sources,
            "runtime_contract": {
                "required_files": declaration["payloadEntries"],
            },
        }
        with ZipFile(archive, "w") as handle:
            handle.writestr(declaration["entrypoint"], b"fake executable")
            for entry in declaration["payloadEntries"]:
                payload = (
                    json.dumps(pipeline).encode("utf-8")
                    if entry == "pipeline.json"
                    else f"payload:{entry}".encode()
                )
                handle.writestr(entry, payload)
            for entry, payload in (extra_entries or {}).items():
                handle.writestr(entry, payload)
        manifest = root / "runtime-manifest.json"
        manifest.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "kind": declaration["artifactKind"],
                    "version": "0.1.0-alpha.1",
                    "target": "x86_64-pc-windows-msvc",
                    "entrypoint": declaration["entrypoint"],
                    "artifact": {
                        "file_name": archive.name,
                        "bytes": archive.stat().st_size,
                        "sha256": _sha256(archive),
                        "url": None,
                    },
                }
            ),
            encoding="utf-8",
        )
        return manifest, archive


def _declaration() -> dict[str, object]:
    return json.loads(DECLARATION.read_text(encoding="utf-8"))


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


if __name__ == "__main__":
    unittest.main()
