from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("collect-python-licenses.py")
SPEC = importlib.util.spec_from_file_location("collect_python_licenses", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Could not load collect-python-licenses.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FakeMetadata(dict[str, str]):
    def __init__(
        self,
        values: dict[str, str],
        classifiers: list[str] | None = None,
        license_files: list[str] | None = None,
    ) -> None:
        super().__init__(values)
        self.classifiers = classifiers or []
        self.license_files = license_files or []

    def get_all(self, name: str, default=None):
        if name == "Classifier":
            return self.classifiers
        if name == "License-File":
            return self.license_files
        return default


class FakeDistribution:
    def __init__(
        self,
        values: dict[str, str],
        classifiers: list[str] | None = None,
        root: Path | None = None,
        files: list[str] | None = None,
        license_files: list[str] | None = None,
        version: str = "1.0.0",
        top_level: str | None = None,
    ) -> None:
        self.metadata = FakeMetadata(values, classifiers, license_files)
        self.root = root
        self.files = files or []
        self.version = version
        self.name = values.get("Name", "example")
        self.top_level = top_level

    def locate_file(self, entry: str) -> Path:
        if self.root is None:
            raise RuntimeError("Fake distribution root is missing")
        return self.root / entry

    def read_text(self, name: str) -> str | None:
        return self.top_level if name == "top_level.txt" else None


class DeclaredLicenseTests(unittest.TestCase):
    def test_explicit_distribution_requirement_must_pin_an_exact_version(self) -> None:
        requirement = MODULE.parse_included_distribution("PyInstaller==6.20.0")
        self.assertEqual(requirement.normalized_name, "pyinstaller")
        self.assertEqual(requirement.version, "6.20.0")
        with self.assertRaisesRegex(ValueError, "exact name==version"):
            MODULE.parse_included_distribution("PyInstaller>=6")

    def test_prefers_pep_639_license_expression(self) -> None:
        distribution = FakeDistribution(
            {
                "Name": "example",
                "License-Expression": "Apache-2.0 OR MIT",
                "License": "legacy text",
            }
        )
        self.assertEqual(
            MODULE.declared_license(distribution),
            "Apache-2.0 OR MIT",
        )

    def test_maps_classifier_when_legacy_license_is_missing(self) -> None:
        distribution = FakeDistribution(
            {"Name": "example"},
            ["License :: OSI Approved :: MIT License"],
        )
        self.assertEqual(MODULE.declared_license(distribution), "MIT")

    def test_maps_apache_v2_legacy_metadata(self) -> None:
        distribution = FakeDistribution(
            {"Name": "onnx", "License": "Apache License v2.0"}
        )
        self.assertEqual(MODULE.declared_license(distribution), "Apache-2.0")

    def test_maps_three_clause_bsd_legacy_metadata(self) -> None:
        distribution = FakeDistribution(
            {"Name": "protobuf", "License": "3-Clause BSD License"}
        )
        self.assertEqual(MODULE.declared_license(distribution), "BSD-3-Clause")

    def test_maps_shapely_bsd_legacy_metadata(self) -> None:
        distribution = FakeDistribution({"Name": "shapely", "License": "BSD 3-Clause"})
        self.assertEqual(MODULE.declared_license(distribution), "BSD-3-Clause")

    def test_workspace_packages_use_root_mit_license(self) -> None:
        distribution = FakeDistribution({"Name": "cert-prep-contracts"})
        self.assertEqual(MODULE.declared_license(distribution), "MIT")

    def test_maps_pypdfium2_bundled_license_set(self) -> None:
        distribution = FakeDistribution(
            {
                "Name": "pypdfium2",
                "License": "BSD-3-Clause, Apache-2.0, dependency licenses",
            }
        )
        self.assertEqual(
            MODULE.declared_license(distribution),
            "BSD-3-Clause AND Apache-2.0 AND CC-BY-4.0",
        )

    def test_maps_pyinstaller_bootloader_exception(self) -> None:
        distribution = FakeDistribution(
            {
                "Name": "pyinstaller",
                "License": (
                    "GPLv2-or-later with a special exception which allows to use "
                    "PyInstaller to build and distribute non-free programs "
                    "(including commercial ones)"
                ),
            }
        )
        self.assertEqual(
            MODULE.declared_license(distribution),
            "GPL-2.0-or-later WITH Bootloader-exception",
        )

    def test_missing_license_remains_fail_closed(self) -> None:
        distribution = FakeDistribution({"Name": "example"})
        self.assertIsNone(MODULE.declared_license(distribution))

    def test_versioned_python_bidi_override_is_evidence_backed(self) -> None:
        distribution = FakeDistribution(
            {"Name": "python-bidi"},
            version="0.6.10",
        )
        self.assertEqual(
            MODULE.declared_license(distribution),
            "LGPL-3.0-or-later",
        )
        self.assertIn(
            "v0.6.10",
            MODULE.versioned_license_override(distribution)["evidence"],
        )

    def test_versioned_python_dateutil_dual_license_is_evidence_backed(self) -> None:
        distribution = FakeDistribution(
            {"Name": "python-dateutil", "License": "Dual License"},
            version="2.9.0.post0",
        )
        self.assertEqual(
            MODULE.declared_license(distribution),
            "BSD-3-Clause OR Apache-2.0",
        )
        self.assertIn(
            "2.9.0.post0",
            MODULE.versioned_license_override(distribution)["evidence"],
        )

    def test_archive_filter_uses_top_level_module_and_rejects_absent_package(
        self,
    ) -> None:
        included = FakeDistribution(
            {"Name": "included-package"},
            top_level="included_package\n",
        )
        absent = FakeDistribution(
            {"Name": "absent-package"},
            top_level="absent_package\n",
        )
        modules = {"included_package", "included_package.child"}
        self.assertTrue(MODULE.distribution_is_in_archive(included, modules, set()))
        self.assertFalse(MODULE.distribution_is_in_archive(absent, modules, set()))

    def test_collects_primary_and_supplemental_license_texts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "LICENSE").write_text("license terms\n", encoding="utf-8")
            (root / "NOTICE.txt").write_text("notice text\n", encoding="utf-8")
            distribution = FakeDistribution(
                {"Name": "example", "License-Expression": "MIT"},
                root=root,
                files=["LICENSE", "NOTICE.txt"],
                license_files=["LICENSE"],
            )
            self.assertEqual(
                MODULE.bundled_license_texts(distribution),
                [
                    {
                        "name": "LICENSE",
                        "text": "license terms\n",
                        "primary": True,
                    },
                    {
                        "name": "NOTICE.txt",
                        "text": "notice text\n",
                        "primary": False,
                    },
                ],
            )

    def test_notice_without_primary_license_text_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "NOTICE").write_text("notice only\n", encoding="utf-8")
            distribution = FakeDistribution(
                {"Name": "example", "License-Expression": "MIT"},
                root=root,
                files=["NOTICE"],
            )
            self.assertEqual(MODULE.bundled_license_texts(distribution), [])

    def test_explicit_pyinstaller_inclusion_retains_complete_license_text(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            copying = root / "COPYING.txt"
            copying.write_text(
                "GNU GPL terms followed by the PyInstaller bootloader exception.\n",
                encoding="utf-8",
            )
            distribution = FakeDistribution(
                {
                    "Name": "PyInstaller",
                    "License": (
                        "GPLv2-or-later with a special exception which allows to use "
                        "PyInstaller to build and distribute non-free programs "
                        "(including commercial ones)"
                    ),
                },
                root=root,
                files=["COPYING.txt"],
                license_files=["COPYING.txt"],
                version="6.20.0",
                top_level="PyInstaller\n",
            )
            with (
                patch.object(
                    MODULE, "pyinstaller_archive_index", return_value=(set(), set())
                ),
                patch.object(
                    MODULE.metadata, "distributions", return_value=[distribution]
                ),
            ):
                components = MODULE.collect_components(
                    Path("runtime.exe"),
                    ("PyInstaller==6.20.0",),
                )

            self.assertEqual(len(components), 1)
            self.assertEqual(
                components[0]["license"],
                "GPL-2.0-or-later WITH Bootloader-exception",
            )
            self.assertEqual(
                components[0]["licenseEvidence"],
                "https://github.com/pyinstaller/pyinstaller/blob/v6.20.0/COPYING.txt",
            )
            self.assertEqual(
                components[0]["licenseTexts"],
                [
                    {
                        "name": "COPYING.txt",
                        "text": (
                            "GNU GPL terms followed by the PyInstaller bootloader "
                            "exception.\n"
                        ),
                        "primary": True,
                    }
                ],
            )

    def test_explicit_distribution_inclusion_rejects_version_drift(self) -> None:
        distribution = FakeDistribution(
            {"Name": "PyInstaller", "License": "MIT"},
            version="6.19.0",
        )
        with (
            patch.object(
                MODULE, "pyinstaller_archive_index", return_value=(set(), set())
            ),
            patch.object(MODULE.metadata, "distributions", return_value=[distribution]),
            self.assertRaisesRegex(RuntimeError, "installed versions: 6.19.0"),
        ):
            MODULE.collect_components(
                Path("runtime.exe"),
                ("PyInstaller==6.20.0",),
            )


if __name__ == "__main__":
    unittest.main()
