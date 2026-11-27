"""Focused regression checks for Hermes distribution and runtime selection."""

import importlib.util
import json
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
from adapters.tests.hermes_onboarding import installed_evidence, source_payload

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


class OnboardingEvidenceTests(unittest.TestCase):
    def test_native_source_payload_validates_only_the_exact_presentation_url(self):
        origin = "http://127.0.0.1:12345"
        source = {"sourceId": "fixture", "revision": 2, "body": "original", "href": "/sources/fixture?revision=2"}
        self.assertEqual(source_payload(source, origin), source)
        linked = {**source, "portalUrl": origin + source["href"]}
        self.assertEqual(source_payload(linked, origin), source)
        self.assertIn("portalUrl", linked)
        for url in (None, "/sources/fixture?revision=2", "http://other.invalid" + source["href"],
                    origin + "/sources/other?revision=2", origin + "/sources/fixture?revision=1"):
            with self.subTest(url=url), self.assertRaises(AssertionError):
                source_payload({**source, "portalUrl": url}, origin)
        for field, value in (("sourceId", "changed"), ("revision", 3), ("body", "changed"), ("extra", True)):
            with self.subTest(field=field):
                self.assertNotEqual(source_payload({**linked, field: value}, origin), source)

    def fixture(self, root, *, result_links=False):
        received, installed = root / "received", root / "installed"
        files = {"plugin.yaml": "name: fixture", "__init__.py": "", "README.md": "fixture",
                 "runtime/frontend/dist/index.html": "fixture index",
                 "runtime/package.json": json.dumps({"dependencies": {"fixture": "1.0.0"}}),
                 "runtime/package-lock.json": json.dumps({"packages": {
                     "": {"dependencies": {"fixture": "1.0.0"}}, "node_modules/fixture": {"version": "1.0.0"}}}),
                 "runtime/node_modules/fixture/package.json": json.dumps({"version": "1.0.0"}),
                 "runtime/node_modules/fixture/index.js": "export default 1;"}
        if result_links:
            files["result_links.py"] = "def result_link(): pass"
        for name, content in files.items():
            path = received / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        self.write_manifest(received)
        shutil.copytree(received, installed)
        return {"directory": str(received)}, installed

    def write_manifest(self, root):
        files = [item for item in exporter.audit_payload(root) if item["path"] != "distribution.json"]
        (root / "distribution.json").write_text(json.dumps({"format": 1, "files": files}), encoding="utf-8")

    def test_each_release_uses_its_own_manifest_not_current_plugin_files(self):
        self.assertIn("result_links.py", exporter.FILES)
        for result_links in (False, True):
            with self.subTest(result_links=result_links), tempfile.TemporaryDirectory() as temporary:
                distribution, installed = self.fixture(Path(temporary), result_links=result_links)
                evidence = installed_evidence(distribution, installed, exporter)
                self.assertEqual("result_links.py" in evidence["pluginFilesVerified"], result_links)
                self.assertEqual(evidence["manifestFilesVerified"], 8 + result_links)
                self.assertEqual(evidence["productionDependenciesVerified"], 1)

    def test_missing_declared_files_fail_on_either_side(self):
        for side in ("received", "installed"):
            for name in ("result_links.py", "runtime/node_modules/fixture/index.js"):
                with self.subTest(side=side, name=name), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    distribution, installed = self.fixture(root, result_links=True)
                    (root / side / name).unlink()
                    with self.assertRaisesRegex(AssertionError, "payload files differ"):
                        installed_evidence(distribution, installed, exporter)

    def test_same_tampering_on_both_sides_still_fails_manifest_hash(self):
        for name in ("result_links.py", "README.md", "runtime/node_modules/fixture/index.js"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                distribution, installed = self.fixture(root, result_links=True)
                for side in ("received", "installed"):
                    path = root / side / name
                    # Same byte count ensures the hash, not just size, is checked.
                    path.write_bytes(b"x" * path.stat().st_size)
                with self.assertRaisesRegex(AssertionError, "payload hash/size differs"):
                    installed_evidence(distribution, installed, exporter)

    def test_undeclared_files_and_stale_upgrade_files_fail(self):
        for side in ("received", "installed"):
            for name in ("obsolete.py", "runtime/node_modules/fixture/extra.js", "__pycache__/hidden.py",
                         "__pycache__/obsolete.cpython-314.pyc", "runtime/__pycache__/hidden.pyc"):
                with self.subTest(side=side, name=name), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    distribution, installed = self.fixture(root)
                    path = root / side / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(b"unexpected")
                    with self.assertRaisesRegex(AssertionError, "payload files differ"):
                        installed_evidence(distribution, installed, exporter)

    def test_only_git_metadata_and_installed_source_bytecode_are_exempt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            distribution, installed = self.fixture(root)
            for side in ("received", "installed"):
                (root / side / ".git").mkdir()
                (root / side / ".git" / "HEAD").write_text("fixture", encoding="utf-8")
            cache = installed / "__pycache__" / "__init__.cpython-314.pyc"
            cache.parent.mkdir()
            cache.write_bytes(b"generated bytecode")
            installed_evidence(distribution, installed, exporter)
            shutil.copytree(cache.parent, root / "received" / "__pycache__")
            with self.assertRaisesRegex(AssertionError, "payload files differ"):
                installed_evidence(distribution, installed, exporter)

    def test_private_payload_files_still_fail(self):
        for name in (".env", "owner.binding", "runtime/state.db"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                distribution, installed = self.fixture(Path(temporary))
                (installed / name).write_bytes(b"private")
                with self.assertRaisesRegex(AssertionError, "Private payload state"):
                    installed_evidence(distribution, installed, exporter)

    def test_manifest_bytes_must_match_and_paths_must_be_unique_and_relative(self):
        for name in (None, "README.md", "../escape.py", "runtime/../escape.py", "C:/escape.py", "runtime\\escape.py"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                distribution, installed = self.fixture(root)
                manifest = json.loads((installed / "distribution.json").read_bytes())
                manifest["files"].append({**manifest["files"][0], "path": name or "extra.py"})
                (installed / "distribution.json").write_text(json.dumps(manifest), encoding="utf-8")
                if name is not None:
                    shutil.copyfile(installed / "distribution.json", root / "received" / "distribution.json")
                with self.assertRaises(AssertionError):
                    installed_evidence(distribution, installed, exporter)

    def test_production_lock_and_installed_versions_are_checked_even_with_matching_hashes(self):
        for fault in ("dev", "version", "missing", "root-dependencies", "devDependencies"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                distribution, installed = self.fixture(root)
                for side in ("received", "installed"):
                    payload = root / side
                    path = payload / "runtime/package-lock.json"
                    lock = json.loads(path.read_bytes())
                    entry = lock["packages"]["node_modules/fixture"]
                    if fault == "dev":
                        entry["dev"] = True
                    elif fault == "version":
                        entry["version"] = "2.0.0"
                    elif fault == "missing":
                        (payload / "runtime/node_modules/fixture/package.json").unlink()
                    elif fault == "root-dependencies":
                        lock["packages"][""]["dependencies"] = {}
                    else:
                        lock["packages"][""]["devDependencies"] = {"vite": "1.0.0"}
                    path.write_text(json.dumps(lock), encoding="utf-8")
                    self.write_manifest(payload)
                with self.assertRaises(AssertionError):
                    installed_evidence(distribution, installed, exporter)


if __name__ == "__main__":
    unittest.main()
