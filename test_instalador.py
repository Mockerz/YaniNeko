import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import instalar_yanineko as installer


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.vencord = self.root / 'Vencord'
        self.dist = self.vencord / 'dist'
        self.dist.mkdir(parents=True)
        for name in ('patcher.js', 'preload.js', 'renderer.js'):
            (self.dist / name).write_text('LefferzinBypass', encoding='utf-8')
        self.discord = self.root / 'Discord'
        self.resources = self.make_version('1.0.9')
        self.write_patch(self.resources)

    def make_version(self, version):
        app = self.discord / ('app-' + version)
        resources = app / 'resources'
        resources.mkdir(parents=True)
        (app / 'Discord.exe').write_bytes(b'MZ')
        (resources / 'app.asar').write_bytes(b'original Discord')
        return resources

    def write_patch(self, resources):
        (resources / '_app.asar').write_bytes(b'original Discord')
        target = json.dumps(str((self.dist / 'patcher.js').resolve()), ensure_ascii=False)
        (resources / 'app.asar').write_bytes(('require(' + target + ')').encode('utf-8'))

    def test_valid_patch(self):
        installer.verify_injection(self.vencord, self.discord)

    def test_new_discord_version_not_patched(self):
        self.make_version('1.0.10')
        with self.assertRaises(RuntimeError):
            installer.verify_injection(self.vencord, self.discord)

    def test_wrong_build(self):
        (self.resources / 'app.asar').write_bytes(b'require("other/patcher.js")')
        with self.assertRaises(RuntimeError):
            installer.verify_injection(self.vencord, self.discord)

    def test_plugin_missing(self):
        (self.dist / 'renderer.js').write_text('stock Vencord')
        with self.assertRaises(RuntimeError):
            installer.verify_injection(self.vencord, self.discord)

    def test_false_success_messages(self):
        for output in ('already patched', 'Successfully unpatched', 'Success!',
                       'ERROR failed\nSuccessfully patched'):
            with self.subTest(output=output):
                with patch.object(installer, 'find_discord', return_value=self.discord), \
                     patch.object(installer, 'download', side_effect=self.fake_download), \
                     patch.object(installer.subprocess, 'run'), \
                     patch.object(installer.time, 'sleep'), \
                     patch.object(installer, 'run', return_value=subprocess.CompletedProcess([], 0, output)), \
                     patch.object(installer, 'verify_injection') as verify:
                    with self.assertRaises(RuntimeError):
                        installer.inject(self.vencord)
                    verify.assert_not_called()

    def fake_download(self, url, target):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b'MZ')

    def test_direct_cli_uses_explicit_target_and_dev_build(self):
        with patch.object(installer, 'find_discord', return_value=self.discord), \
             patch.object(installer, 'download', side_effect=self.fake_download), \
             patch.object(installer.subprocess, 'run'), \
             patch.object(installer.time, 'sleep'), \
             patch.object(installer, 'run', return_value=subprocess.CompletedProcess([], 0, 'Successfully patched')) as run:
            installer.inject(self.vencord)
            self.assertEqual(run.call_args.args[0][1:], ['-install', '-location', str(self.discord)])
            self.assertEqual(run.call_args.kwargs['env']['VENCORD_DEV_INSTALL'], '1')
            self.assertEqual(run.call_args.kwargs['env']['VENCORD_USER_DATA_DIR'], str(self.vencord.resolve()))


if __name__ == '__main__':
    unittest.main()
