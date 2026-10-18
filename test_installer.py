import io
import json
import os
import subprocess
import tempfile
import unittest
import types
from pathlib import Path
from unittest.mock import patch

import instalar_yanineko as installer


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="installer-test-", dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {"LOCALAPPDATA": str(self.root)})
        self.env.start()
        self.addCleanup(self.env.stop)

    def touch(self, relative):
        file = self.root / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text("test")
        return file

    def test_uac_is_unchanged_without_selection(self):
        with patch.object(installer, "ask_disable_uac", return_value=False), patch.object(installer, "disable_uac") as change:
            installer.configure_optional_uac(self.root)
            change.assert_not_called()

    def test_silent_uac_skips_dialog_only_when_explicitly_requested(self):
        with patch.object(installer, "ask_disable_uac") as ask, patch.object(installer, "disable_uac") as change:
            installer.configure_optional_uac(self.root, silent=True)
            ask.assert_not_called()
            change.assert_called_once_with(self.root, silent=True)

    def test_silent_uac_failure_does_not_open_dialog(self):
        with patch.object(installer, "disable_uac", side_effect=RuntimeError("cancelado")), \
             patch("ctypes.windll.user32.MessageBoxW") as dialog:
            installer.configure_optional_uac(self.root, silent=True)
            dialog.assert_not_called()

    def test_uac_requires_explicit_selection(self):
        with patch.object(installer, "ask_disable_uac", return_value=True), patch.object(installer, "disable_uac") as change:
            installer.configure_optional_uac(self.root)
            change.assert_called_once_with(self.root)

    def test_uac_denial_does_not_fail_installation(self):
        with patch.object(installer, "ask_disable_uac", return_value=True), \
             patch.object(installer, "disable_uac", side_effect=RuntimeError("cancelado")), \
             patch("ctypes.windll.user32.MessageBoxW"):
            installer.configure_optional_uac(self.root)

    def test_uac_dialog_defaults_to_unchecked(self):
        values = []
        class Widget:
            def __init__(self, *args, **kwargs): pass
            def __getattr__(self, name): return lambda *args, **kwargs: None
        fake = types.SimpleNamespace(Tk=Widget, BooleanVar=lambda value: values.append(value))
        fake.ttk = types.SimpleNamespace(Frame=Widget, Label=Widget, Checkbutton=Widget, Button=Widget)
        with patch.dict("sys.modules", {"tkinter": fake, "tkinter.ttk": fake.ttk}):
            self.assertFalse(installer.ask_disable_uac())
        self.assertEqual(values, [False])

    def test_uac_change_is_scoped_verified_and_has_restore_file(self):
        from unittest.mock import MagicMock
        registry = MagicMock()
        registry.QueryValueEx.side_effect = [(1, 4), (0, 4)]
        registry.KEY_READ = 1; registry.KEY_WOW64_64KEY = 256
        with patch.dict("sys.modules", {"winreg": registry}), \
             patch.object(installer.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run, \
             patch("ctypes.windll.user32.MessageBoxW"):
            installer.disable_uac(self.root)
        command = run.call_args.args[0]
        self.assertIn("-Verb RunAs", command[-1])
        self.assertIn("'EnableLUA'", command[-1])
        self.assertNotIn("ConsentPromptBehaviorAdmin", command[-1])
        self.assertIn('"EnableLUA"=dword:00000001', (self.root / "Reativar-UAC.reg").read_text(encoding="utf-16"))
        self.assertEqual(registry.QueryValueEx.call_count, 2)

    def test_discord_missing_and_other_channel(self):
        (self.root / "DiscordCanary").mkdir()
        with self.assertRaisesRegex(RuntimeError, "Discord Stable.*DiscordCanary"):
            installer.find_discord()

    def test_discord_valid_and_invalid_version(self):
        self.touch("Discord/app-broken/Discord.exe")
        with self.assertRaises(RuntimeError):
            installer.find_discord()
        self.touch("Discord/app-1.0.1000/Discord.exe")
        self.assertEqual(installer.find_discord(), self.root / "Discord")

    def test_git_missing_downloads_portable(self):
        response = io.BytesIO(json.dumps({"assets": [{"name": "MinGit-2.51.0-64-bit.zip", "browser_download_url": "https://example.invalid/git.zip"}]}).encode())
        with patch.object(installer.shutil, "which", return_value=None), \
             patch.object(installer.urllib.request, "urlopen", return_value=response), \
             patch.object(installer, "download") as download, \
             patch.object(installer, "extract_zip", side_effect=lambda *a: self.touch("git/cmd/git.exe")), \
             patch.object(installer, "run", return_value=subprocess.CompletedProcess([], 0, "git version 2.51.0")):
            installer.install_git(self.root)
            download.assert_called_once()
            self.assertEqual(os.environ["PATH"].split(os.pathsep)[0], str(self.root / "git/cmd"))

    def test_node_missing_or_old_downloads_portable(self):
        for installed_version in (None, "v22.0.0"):
            with self.subTest(version=installed_version):
                node = self.touch("system/node.exe") if installed_version else None
                self.touch("system/node_modules/npm/bin/npm-cli.js")
                tools = self.root / ("missing" if node is None else "old")
                response = io.BytesIO(b'[{"version":"v22.14.0","files":["win-x64-zip"]}]')
                def extract(*args):
                    base = tools.relative_to(self.root) / "node/node-v22.14.0-win-x64"
                    self.touch(base / "node.exe")
                    self.touch(base / "node_modules/npm/bin/npm-cli.js")
                with patch.object(installer.shutil, "which", return_value=str(node) if node else None), \
                     patch.object(installer.urllib.request, "urlopen", return_value=response), \
                     patch.object(installer, "download") as download, \
                     patch.object(installer, "extract_zip", side_effect=extract), \
                     patch.object(installer, "run", return_value=subprocess.CompletedProcess([], 0, installed_version or "v22.14.0")):
                    installer.install_node(tools)
                    download.assert_called_once()

    def test_cached_git_and_node_need_no_download(self):
        self.touch("git/cmd/git.exe")
        self.touch("node/node-v22.14.0-win-x64/node.exe")
        self.touch("node/node-v22.14.0-win-x64/node_modules/npm/bin/npm-cli.js")
        with patch.object(installer.shutil, "which", return_value=None), \
             patch.object(installer, "download") as download, \
             patch.object(installer, "run", side_effect=lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, "git version 2.51.0" if "git.exe" in cmd[0] else "v22.14.0")):
            installer.install_git(self.root)
            installer.install_node(self.root)
            download.assert_not_called()

    def test_pnpm_uses_node_entrypoint_without_corepack(self):
        node = self.touch("runtime/node.exe")
        self.touch("runtime/node_modules/npm/bin/npm-cli.js")
        with patch.object(installer.shutil, "which", return_value=str(node)), \
             patch.object(installer, "run", return_value=subprocess.CompletedProcess([], 0, installer.PNPM_VERSION)) as run:
            installer.install_pnpm(self.root)
            commands = [call.args[0] for call in run.call_args_list]
            self.assertTrue(all(cmd[0] == str(node) for cmd in commands))
            self.assertIn("--prefix", commands[0])
            self.assertTrue(commands[-1][1].endswith("pnpm.mjs"))

    def test_error_contains_stage_and_log(self):
        with patch.object(installer, "CURRENT_STEP", "Verificando Discord"), patch("sys.stdout", new_callable=io.StringIO) as output:
            installer.report_error("Discord não encontrado", self.root / "install.log")
            self.assertIn("Verificando Discord", output.getvalue())
            self.assertIn("install.log", output.getvalue())

    def test_legacy_console_keeps_unicode_in_log(self):
        raw = io.BytesIO()
        console = io.TextIOWrapper(raw, encoding="cp1252")
        logfile = io.StringIO()
        with patch("sys.stdout", console), patch.object(installer, "LOGGER", logfile):
            installer.log("✓ Build concluído → OK")
            installer.report_error("✗ teste de erro")
        self.assertIn("Build concluído", raw.getvalue().decode("cp1252"))
        self.assertIn("✓ Build concluído → OK", logfile.getvalue())


if __name__ == "__main__":
    unittest.main()
