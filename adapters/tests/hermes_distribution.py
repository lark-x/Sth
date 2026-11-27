"""Focused regression checks for Hermes distribution and runtime selection."""

import importlib.util
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from adapters.hermes_plugin import native, workspace_cli

spec = importlib.util.spec_from_file_location("sth_package_plugin", ROOT / "adapters/hermes_plugin/package_plugin.py")
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class DistributionTests(unittest.TestCase):
    def test_packaged_plugin_imports_with_its_result_link_dependency(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plugin = root / "sth_plugin"
            plugin.mkdir()
            for name in exporter.FILES:
                shutil.copyfile(ROOT / "adapters/hermes_plugin" / name, plugin / name)
            result = subprocess.run([sys.executable, "-B", "-c", "import sth_plugin; assert callable(sth_plugin.operations.result_link)"],
                                    cwd=root, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_copy_allows_public_code_and_excludes_private_state_and_build_outputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, target = root / "source", root / "payload"
            for name in ("main.ts", "diary/Page.vue", "tasks/legacy.js", ".env.production", ".data/secret.ts",
                         "node_modules/secret.ts", "tests/secret.ts", "dist/stale.ts", "credentials.json"):
                path = source / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("fixture", encoding="utf-8")
            exporter._copy_tree(source, target, suffixes=exporter.FRONTEND_SOURCE_SUFFIXES, exclude={"node_modules", "tests", "dist"})
            self.assertEqual({p.relative_to(target).as_posix() for p in target.rglob("*") if p.is_file()},
                             {"main.ts", "diary/Page.vue", "tasks/legacy.js"})

    def test_audit_rejects_private_files_before_git_publication(self):
        for name in (".env", ".env.local", ".data/cache.ts", "auth.json", "state.db", "owner.binding"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("fixture", encoding="utf-8")
                with self.assertRaises(ValueError):
                    exporter.audit_payload(root)

    def test_audit_records_relative_content_hashes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "public.ts").write_bytes(b"abc")
            self.assertEqual(exporter.audit_payload(root), [{"path": "public.ts", "bytes": 3,
                "sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}])

    def test_default_runtime_is_inside_plugin_and_needs_no_node_on_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            plugin = Path(temporary) / "plugin"
            runtime = plugin / "runtime"
            (runtime / "scripts").mkdir(parents=True)
            (runtime / "scripts/workspace.mjs").touch()
            (runtime / "bin").mkdir()
            name = "node.exe" if sys.platform == "win32" else "node"
            (runtime / "bin" / name).touch()
            with patch.object(workspace_cli, "__file__", str(plugin / "workspace_cli.py")), \
                    patch.object(native, "_context", None), patch.object(workspace_cli.shutil, "which", return_value=None):
                self.assertEqual(workspace_cli._repository(None), runtime.resolve())
                self.assertEqual(Path(workspace_cli._node(runtime)), runtime / "bin" / name)

    def test_explicit_external_runtime_override_and_invalid_override(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "scripts").mkdir()
            (root / "scripts/workspace.mjs").touch()
            with patch.object(native, "_context", None):
                self.assertEqual(workspace_cli._repository(root), root.resolve())
                with self.assertRaises(ValueError):
                    workspace_cli._repository(root / "missing")

    def test_export_refuses_existing_destinations(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(ValueError):
                exporter.package(Path(temporary))


if __name__ == "__main__":
    unittest.main()
