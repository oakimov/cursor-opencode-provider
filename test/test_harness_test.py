"""Portable harness tests; runnable with native Python on Windows, macOS and Linux."""
from __future__ import annotations

import importlib.util
import csv
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("test_harness", ROOT / "scripts/test-harness.py")
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)


def result(argv, stdout="", status=0):
    return subprocess.CompletedProcess(argv, status, stdout, "")


class Platforms(unittest.TestCase):
    def environment(self, system, missing=(), namespaces=True, docker=True, endpoint="npipe://docker_engine", engine="linux", uid=10001):
        def which(tool):
            if tool in missing or tool in ("cursor-agent", "agent"):
                return None
            return tool

        def probe(argv, **kwargs):
            if argv[0] == "unshare":
                return result(argv, status=0 if namespaces else 1)
            if argv[:3] == ["docker", "context", "inspect"]:
                return result(argv, endpoint)
            if argv[:2] == ["docker", "info"]:
                return result(argv, engine, 0 if docker else 1)
            return result(argv)

        return patch.multiple(harness, probe=probe), patch.object(harness.platform, "system", return_value=system), patch.object(harness.shutil, "which", side_effect=which), patch.object(harness.os, "geteuid", return_value=uid, create=True)

    def detect(self, system, requested="auto", **options):
        probes, platform, which, uid = self.environment(system, **options)
        with probes, platform, which, uid, patch.dict(os.environ, {}, clear=True):
            return harness.detect(requested)

    def test_native_linux_without_cursor_agent(self):
        report = self.detect("Linux")
        self.assertEqual((report["backend"], report["ready"], report["cursor_agent_command"]), ("native", True, False))

    def test_cursor_vm_does_not_change_the_backend(self):
        probes, platform, which, uid = self.environment("Linux")
        with probes, platform, which, uid, patch.dict(os.environ, {}, clear=True):
            with patch.object(harness.shutil, "which", return_value="present"):
                report = harness.detect()
        self.assertTrue(report["cursor_agent_command"])
        self.assertEqual(report["backend"], "native")

    def test_native_macos(self):
        self.assertEqual(self.detect("Darwin")["backend"], "native")

    def test_windows_and_other_os_use_linux_containers(self):
        for system in ("Windows", "FreeBSD"):
            report = self.detect(system)
            self.assertTrue(report["ready"])
            self.assertEqual(report["backend"], "docker")

    def test_windows_does_not_fall_back_to_host_shells(self):
        self.assertFalse(self.detect("Windows", requested="native")["ready"])
        self.assertFalse(self.detect("Windows", missing=("docker",))["ready"])
        self.assertFalse(self.detect("Windows", docker=False)["ready"])
        self.assertFalse(self.detect("Windows", engine="windows")["ready"])
        self.assertFalse(self.detect("Windows", missing=("git",))["ready"])

    def test_linux_without_namespaces_can_use_docker(self):
        self.assertEqual(self.detect("Linux", namespaces=False)["backend"], "docker")
        report = self.detect("Linux", namespaces=False, missing=("docker",))
        self.assertFalse(report["ready"])
        self.assertIn("namespaces", report["reason"])

    def test_missing_native_tools_and_sandbox_are_reported(self):
        self.assertFalse(self.detect("Linux", "native", missing=("zsh",))["ready"])
        report = self.detect("Darwin", "native", missing=("sandbox-exec",))
        self.assertFalse(report["ready"])
        self.assertIn("sandbox-exec", report["reason"])

    def test_root_uses_the_unprivileged_container_instead_of_skipping_permission_cases(self):
        report = self.detect("Linux", uid=0)
        self.assertTrue(report["ready"])
        self.assertEqual(report["backend"], "docker")
        self.assertFalse(self.detect("Linux", requested="native", uid=0)["ready"])

    def test_remote_docker_is_refused(self):
        self.assertFalse(self.detect("Windows", endpoint="ssh://remote")["ready"])


class Execution(unittest.TestCase):
    def test_native_process_reports_its_real_exit_status(self):
        with tempfile.TemporaryDirectory(prefix="harness-child-") as temporary:
            self.assertEqual(harness.run([sys.executable, "-c", "raise SystemExit(7)"], Path(temporary)), 7)

    def test_docker_argv_preserves_windows_paths_and_exposes_only_readonly_input(self):
        source = Path("C:/work/provider, with spaces")
        command = harness.docker_command(source, "test-image", "test-container")
        mount = command[command.index("--mount") + 1]
        self.assertEqual(next(csv.reader([mount])), ["type=bind", f"source={source}", "target=/input", "readonly"])
        self.assertEqual(command.count("--mount"), 1)
        self.assertNotIn("--privileged", command)
        self.assertNotIn("--cap-add", command)
        self.assertEqual(command[command.index("--cap-drop") + 1], "ALL")
        self.assertIn("systempaths=unconfined", command)
        self.assertNotIn("CURSOR_API_KEY", command)
        worker = command[-1]
        self.assertIn("cp -R /input/. /src/", worker)
        self.assertEqual(command[command.index("--user") + 1], "10001:10001")
        self.assertIn("bun test", worker)
        self.assertIn("test:node-http2", worker)
        self.assertLess(worker.index("unshare --user"), worker.index("bun install"))

    def test_build_sends_only_the_dockerfile(self):
        with patch.object(harness, "run", return_value=0) as run:
            self.assertEqual(harness.build_image("test-image"), 0)
        data = run.call_args.kwargs["data"]
        with tarfile.open(fileobj=io.BytesIO(data)) as contents:
            self.assertEqual(contents.getnames(), ["Dockerfile"])

    def test_failed_native_check_stops_and_cleans_the_snapshot(self):
        report = {"os": "Darwin", "backend": "native", "ready": True}
        roots = []
        def snapshot(root, target):
            roots.append(target)
        with patch.object(harness, "detect", return_value=report), patch.object(harness.shutil, "which", return_value="git"), patch.object(harness, "snapshot", side_effect=snapshot), patch.object(harness, "run", side_effect=[0, 7]) as run, redirect_stdout(io.StringIO()):
            self.assertEqual(harness.main([]), 7)
            self.assertEqual(run.call_count, 2)
        self.assertFalse(roots[0].exists())

    def test_failed_container_is_removed_before_snapshot_cleanup(self):
        report = {"os": "Windows", "backend": "docker", "ready": True}
        roots = []
        commands = []
        def probe(argv):
            commands.append(argv)
            if argv[:3] == ["docker", "rm", "--force"]:
                self.assertTrue(roots[0].exists())
            return result(argv, harness.image_stamp() if argv[:3] == ["docker", "image", "inspect"] else "")
        with patch.object(harness, "detect", return_value=report), patch.object(harness.shutil, "which", return_value="git"), patch.object(harness, "snapshot", side_effect=lambda root, target: roots.append(target)), patch.object(harness, "run", return_value=9), patch.object(harness, "probe", side_effect=probe), redirect_stdout(io.StringIO()):
            self.assertEqual(harness.main([]), 9)
        self.assertTrue(any(command[:3] == ["docker", "rm", "--force"] for command in commands))
        self.assertFalse(roots[0].exists())

    def test_cleanup_failure_cannot_report_a_pass(self):
        report = {"os": "Windows", "backend": "docker", "ready": True}
        def probe(argv):
            if argv[:3] == ["docker", "image", "inspect"]:
                return result(argv, harness.image_stamp())
            return result(argv, status=1)
        with patch.object(harness, "detect", return_value=report), patch.object(harness.shutil, "which", return_value="git"), patch.object(harness, "snapshot"), patch.object(harness, "run", return_value=0), patch.object(harness, "probe", side_effect=probe), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(harness.main([]), 2)

    def test_failed_image_refresh_cannot_make_the_next_default_run_serve_an_old_image(self):
        report = {"os": "Windows", "backend": "docker", "ready": True}
        with patch.object(harness, "detect", return_value=report), patch.object(harness.shutil, "which", return_value="git"), patch.object(harness, "build_image", return_value=9) as build, patch.object(harness, "probe", side_effect=lambda argv: result(argv, "old-image-stamp")) as probe, patch.object(harness, "snapshot") as snapshot, redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(harness.main(["--build-image"]), 9)
            self.assertEqual(build.call_count, 1)
            self.assertEqual(harness.main([]), 2)
            self.assertEqual(probe.call_count, 1)
            snapshot.assert_not_called()

    def test_sparse_file_is_hydrated_but_deleted_and_ignored_files_stay_absent(self):
        with tempfile.TemporaryDirectory(prefix="harness-source-") as temporary:
            root = Path(temporary) / "repo"
            root.mkdir()
            def git(*args):
                return subprocess.check_output(["git", *args], cwd=root, stderr=subprocess.PIPE)
            git("init", "--quiet")
            (root / "sparse.json").write_text('{"install":"test"}\n')
            (root / "changed.txt").write_text("original")
            (root / "deleted.txt").write_text("deleted")
            (root / "sparse.sh").write_text("#!/bin/sh\nexit 0\n")
            (root / ".gitignore").write_text("secret.key\n")
            git("add", ".")
            git("update-index", "--skip-worktree", "sparse.json")
            git("update-index", "--chmod=+x", "sparse.sh")
            git("update-index", "--skip-worktree", "sparse.sh")
            (root / "sparse.json").unlink()
            (root / "sparse.sh").unlink()
            (root / "deleted.txt").unlink()
            (root / "changed.txt").write_text("local edit")
            (root / "new.txt").write_text("new local source")
            (root / "secret.key").write_text("private")
            target = Path(temporary) / "snapshot"
            target.mkdir()
            harness.snapshot(root, target)
            self.assertEqual(json.loads((target / "sparse.json").read_text()), {"install": "test"})
            self.assertEqual((target / "changed.txt").read_text(), "local edit")
            self.assertEqual((target / "new.txt").read_text(), "new local source")
            self.assertFalse((target / "deleted.txt").exists())
            self.assertFalse((target / "secret.key").exists())
            self.assertFalse((target / ".git").exists())
            self.assertFalse((root / "sparse.json").exists())
            if os.name != "nt":
                self.assertTrue((target / "sparse.sh").stat().st_mode & 0o111)


if __name__ == "__main__":
    unittest.main()
