#!/usr/bin/env python3
"""Instalador automático do YaniNeko/Vencord para Windows x64.
Uso: py instalar_yanineko.py
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
import zipfile
from pathlib import Path

REPO = "Mockerz/YaniNeko"
PLUGIN_BRANCH = "main"
VENCORD_REPO = "https://github.com/Vendicated/Vencord.git"
# Commit validado com o plugin. Atualize deliberadamente após testar: seguir o
# HEAD de main deixava qualquer mudança do Vencord quebrar build ou patches.
VENCORD_COMMIT = "b0e636df2ed5c9006b80ddc6644bc41110404bc3"
PNPM_VERSION = "11.9.0"
PNPM_COMMAND: list[str] = []
CURRENT_STEP = "Verificando requisitos"
# v1.4.1 interrompe builds locais antes do patch e pode retornar Success.
# Hash publicado em https://github.com/Vencord/Installer/releases/tag/v1.4.0
INSTALLER_URL = "https://github.com/Vencord/Installer/releases/download/v1.4.0/VencordInstallerCli.exe"
INSTALLER_SHA256 = "466d2a0be1f380ddffed052df3cc132125fa34dc1af29312e14f13f358c8d2a2"
REQUIRED = [
    "manifest.json", "index.tsx", "native.ts", "presence.ts", "stability.ts", "error-reporter.ts", "device-client.ts",
    "vpn-controller.ts", "vpn-proton.ts", "vpn-types.ts", "vpn-windows.ts", "auto-update.cjs",
]


def console_print(message: str):
    try:
        print(message, flush=True)
    except UnicodeEncodeError:
        encoding = getattr(sys.stdout, "encoding", None) or "utf-8"
        print(message.encode(encoding, errors="replace").decode(encoding), flush=True)


def log(message: str = ""):
    console_print(message)
    if LOGGER:
        LOGGER.write(message + "\n")
        LOGGER.flush()


def step(message: str):
    global CURRENT_STEP
    CURRENT_STEP = message
    log("\n" + message)


def fail(message: str):
    raise RuntimeError(message)


def report_error(message: str, log_path: Path | None = None):
    detail = f"A instalação não foi concluída.\n\nEtapa: {CURRENT_STEP}\n\n{message}"
    if log_path:
        detail += f"\n\nLog com detalhes:\n{log_path}"
    console_print(detail)
    if LOGGER:
        LOGGER.write(detail + "\n")
        LOGGER.flush()
    if os.name == "nt" and getattr(sys, "frozen", False):
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, detail, "YaniNeko — Erro na instalação", 0x10)
        except Exception:
            pass  # The console and log retain the error if the dialog is unavailable.


def run(command: list[str], cwd: Path | None = None, check: bool = True, env=None) -> subprocess.CompletedProcess[str]:
    log("$ " + " ".join(f'"{x}"' if " " in x else x for x in command))
    try:
        result = subprocess.run(
            command, cwd=str(cwd) if cwd else None, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            encoding="utf-8", errors="replace", shell=False, env=env,
        )
    except FileNotFoundError:
        fail(f"Comando não encontrado: {command[0]}")
    except PermissionError:
        fail(f"O Windows bloqueou a execução de {command[0]}. Verifique as permissões e o histórico de proteção do antivírus.")
    if result.stdout:
        for line in result.stdout.rstrip().splitlines():
            log(line)
    if check and result.returncode != 0:
        tail = (result.stdout or "Sem detalhes retornados pelo programa.")[-1800:]
        fail(f"Comando falhou com código {result.returncode}: {command[0]}\n{tail}")
    return result


def download(url: str, target: Path, attempts: int = 3):
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_suffix(target.suffix + ".part")
    headers = {"User-Agent": "YaniNeko-installer/1.0"}
    for attempt in range(1, attempts + 1):
        try:
            log(f"Download ({attempt}/{attempts}): {url}")
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=600) as response, part.open("wb") as output:
                shutil.copyfileobj(response, output, length=1024 * 1024)
            if part.stat().st_size < 1024:
                raise RuntimeError("arquivo baixado é pequeno demais")
            part.replace(target)
            return
        except Exception as exc:
            part.unlink(missing_ok=True)
            if attempt == attempts:
                fail(f"Falha ao baixar {url}: {exc}")
            time.sleep(attempt * 2)


def extract_zip(archive: Path, destination: Path):
    destination.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(archive) as zf:
            bad = zf.testzip()
            if bad:
                fail(f"ZIP corrompido; primeiro arquivo inválido: {bad}")
            zf.extractall(destination)
    except zipfile.BadZipFile as exc:
        fail(f"ZIP inválido: {exc}")


def prepend_path(path: Path):
    os.environ["PATH"] = str(path) + os.pathsep + os.environ.get("PATH", "")


def command_exists(name: str) -> bool:
    return shutil.which(name) is not None


def install_git(tools: Path):
    step("[1/8] Preparando Git")
    for candidate in (shutil.which("git"), tools / "git/cmd/git.exe"):
        if not candidate or not Path(candidate).is_file():
            continue
        try:
            version = run([str(candidate), "--version"]).stdout.strip()
            if not version.startswith("git version "):
                continue
            prepend_path(Path(candidate).parent)
            log("Git já disponível: " + version)
            return
        except RuntimeError:
            log("Git existente não funciona; preparando a cópia portátil.")
    step("[1/8] Instalando Git portátil")
    zip_path = tools / "mingit.zip"
    git_dir = tools / "git"
    digest = None
    try:
        request = urllib.request.Request(
            "https://api.github.com/repos/git-for-windows/git/releases/latest",
            headers={"User-Agent": "YaniNeko-installer/1.0"},
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            release = json.load(response)
        assets = [a for a in release.get("assets", []) if re.match(r"^MinGit-.*-64-bit\.zip$", a.get("name", ""))]
        if not assets:
            fail("A API do Git não retornou MinGit x64.")
        url = assets[0]["browser_download_url"]
        # A API do GitHub publica "sha256:<hex>" para cada asset de release.
        raw_digest = str(assets[0].get("digest") or "")
        digest = raw_digest.split(":", 1)[1].lower() if raw_digest.startswith("sha256:") else None
    except Exception as exc:
        log(f"API do Git indisponível ({exc}); usando fallback fixo.")
        url = "https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/MinGit-2.51.0-64-bit.zip"
    download(url, zip_path)
    if digest and hashlib.sha256(zip_path.read_bytes()).hexdigest() != digest:
        zip_path.unlink(missing_ok=True)
        fail("O SHA256 do MinGit não confere com o publicado pelo GitHub.")
    shutil.rmtree(git_dir, ignore_errors=True)
    extract_zip(zip_path, git_dir)
    git_exe = git_dir / "cmd" / "git.exe"
    if not git_exe.exists():
        fail("Git portátil foi extraído, mas git.exe não foi encontrado.")
    prepend_path(git_exe.parent)
    log("OK: " + run(["git", "--version"]).stdout.strip())


def install_node(tools: Path):
    step("[2/8] Preparando Node.js")
    candidates = [shutil.which("node"), *sorted((tools / "node").glob("node-*-win-x64/node.exe"), reverse=True)]
    for candidate in candidates:
        if not candidate or not Path(candidate).is_file():
            continue
        try:
            version = run([str(candidate), "--version"]).stdout.strip()
            match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", version)
            npm_cli = Path(candidate).parent / "node_modules/npm/bin/npm-cli.js"
            if match and tuple(map(int, match.groups())) >= (22, 13, 0) and npm_cli.is_file():
                prepend_path(Path(candidate).parent)
                log("Node.js já disponível: " + version)
                return
        except RuntimeError:
            log("Node.js existente não funciona; preparando a cópia portátil.")
    step("[2/8] Instalando Node.js 22 portátil")
    arch = "x64" if sys.maxsize > 2**32 else "x86"
    request = urllib.request.Request("https://nodejs.org/dist/index.json", headers={"User-Agent": "YaniNeko-installer/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        releases = json.load(response)
    release = next((r for r in releases if r.get("version", "").startswith("v22.") and f"win-{arch}-zip" in r.get("files", [])), None)
    if not release:
        fail(f"Não encontrei Node.js 22 para win-{arch}.")
    version = release["version"]
    archive = tools / "node.zip"
    node_dir = tools / "node"
    zip_name = f"node-{version}-win-{arch}.zip"
    download(f"https://nodejs.org/dist/{version}/{zip_name}", archive)
    request = urllib.request.Request(f"https://nodejs.org/dist/{version}/SHASUMS256.txt", headers={"User-Agent": "YaniNeko-installer/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        sums = response.read().decode("utf-8", errors="replace")
    expected = next((line.split()[0].lower() for line in sums.splitlines() if line.strip().endswith(" " + zip_name)), None)
    if not expected or hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
        archive.unlink(missing_ok=True)
        fail(f"O SHA256 do Node.js {version} não confere com o SHASUMS256.txt oficial.")
    shutil.rmtree(node_dir, ignore_errors=True)
    extract_zip(archive, node_dir)
    folders = [p for p in node_dir.iterdir() if p.is_dir() and (p / "node.exe").is_file()
               and (p / "node_modules/npm/bin/npm-cli.js").is_file()]
    if not folders:
        fail("Node.js portátil não foi extraído corretamente.")
    prepend_path(folders[0])
    node = str(folders[0] / "node.exe")
    npm_cli = str(folders[0] / "node_modules/npm/bin/npm-cli.js")
    log(f"OK: {run([node, '--version']).stdout.strip()} / npm {run([node, npm_cli, '--version']).stdout.strip()}")


def install_pnpm(tools: Path):
    global PNPM_COMMAND
    step(f"[3/8] Preparando pnpm {PNPM_VERSION}")
    node = shutil.which("node")
    if not node:
        fail("Node.js não ficou disponível após a preparação automática.")
    prefix = tools / "pnpm"
    cli = prefix / "node_modules/pnpm/bin/pnpm.mjs"
    npm_cli = Path(node).parent / "node_modules/npm/bin/npm-cli.js"
    if not npm_cli.is_file():
        fail("A instalação do Node.js está incompleta: npm-cli.js não encontrado.")
    # Run JS entry points directly: no global install, Corepack or .cmd launcher needed.
    if not cli.is_file() or run([node, str(cli), "--version"], check=False).stdout.strip() != PNPM_VERSION:
        run([node, str(npm_cli), "install", "--prefix", str(prefix), "--no-audit", "--no-fund",
             "--ignore-scripts", f"pnpm@{PNPM_VERSION}"])
    PNPM_COMMAND = [node, str(cli)]
    log("OK: " + run([*PNPM_COMMAND, "--version"]).stdout.strip())


def download_plugin(work: Path, script_dir: Path) -> Path:
    step("[4/8] Baixando o plugin YaniNeko")
    archive = work / "yanineko.zip"
    extracted = work / "yanineko"
    request = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/commits/{PLUGIN_BRANCH}",
        headers={"User-Agent": "YaniNeko-installer"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        sha = json.load(response).get("sha", "")
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        fail("Commit do plugin inválido.")
    download(f"https://github.com/{REPO}/archive/{sha}.zip", archive)
    extract_zip(archive, extracted)
    roots = [p for p in extracted.iterdir() if p.is_dir() and p.name.startswith("YaniNeko-")]
    if not roots:
        fail("ZIP do plugin não contém a pasta YaniNeko esperada.")
    source = roots[0]
    for name in REQUIRED:
        if not (source / name).is_file():
            fail(f"Arquivo obrigatório ausente no plugin: {name}")
    binary = source / "bin" / "win32-x64" / "proton-confgen.exe"
    if not binary.is_file() or binary.stat().st_size < 4096:
        fail("proton-confgen.exe ausente ou inválido.")

    (source / ".source-commit.json").write_text(json.dumps({"sha": sha}), encoding="utf-8")
    log("OK: arquivos do plugin e binário validados")
    return source


def prepare_vencord(install_root: Path, plugin_source: Path):
    step("[5/8] Baixando ou atualizando o Vencord")
    vencord = install_root / "Vencord"
    if not (vencord / ".git").is_dir():
        shutil.rmtree(vencord, ignore_errors=True)
        vencord.mkdir(parents=True)
        run(["git", "init", "--quiet"], cwd=vencord)
        run(["git", "remote", "add", "origin", VENCORD_REPO], cwd=vencord)
    run(["git", "fetch", "--depth", "1", "origin", VENCORD_COMMIT], cwd=vencord)
    run(["git", "reset", "--hard", "FETCH_HEAD"], cwd=vencord)
    run(["git", "clean", "-fdx", "--exclude=node_modules"], cwd=vencord)
    plugin = vencord / "src" / "userplugins" / "LefferzinBypass"
    shutil.rmtree(plugin, ignore_errors=True)
    (plugin / "bin" / "win32-x64").mkdir(parents=True, exist_ok=True)
    allowed = {".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".css", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".wasm"}
    for file in plugin_source.rglob("*"):
        relative = file.relative_to(plugin_source)
        if any(part.startswith(".") or part in {"node_modules", "build", "dist", "tests"} for part in relative.parts):
            continue
        if file.is_file() and (file.suffix in allowed or relative.as_posix() == "bin/win32-x64/proton-confgen.exe"):
            target = plugin / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, target)
    log("OK: Vencord e plugin preparados")
    return vencord


def build(vencord: Path, plugin_source: Path):
    step("[6/8] Instalando dependências e compilando")
    if not PNPM_COMMAND:
        fail("pnpm não foi preparado pelo instalador.")
    run([*PNPM_COMMAND, "install", "--frozen-lockfile"], cwd=vencord)
    run([*PNPM_COMMAND, "build", "--disable-updater"], cwd=vencord)
    renderer = vencord / "dist" / "renderer.js"
    if not renderer.is_file():
        fail("O build não gerou dist\\renderer.js.")
    if "LefferzinBypass" not in renderer.read_text(encoding="utf-8", errors="ignore"):
        fail("O plugin não apareceu no renderer.js.")
    dist_bin = vencord / "dist" / "desktop" / "bin" / "win32-x64"
    dist_bin.mkdir(parents=True, exist_ok=True)
    shutil.copy2(plugin_source / "bin" / "win32-x64" / "proton-confgen.exe", dist_bin)
    direct_bin = vencord / "dist/bin/win32-x64"
    direct_bin.mkdir(parents=True, exist_ok=True)
    shutil.copy2(plugin_source / "bin/win32-x64/proton-confgen.exe", direct_bin)
    log("OK: build validado e binário copiado")


def find_discord() -> Path:
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        fail("A pasta LOCALAPPDATA do usuário não foi encontrada. Execute o instalador na sua conta normal do Windows.")
    discord = Path(local) / "Discord"
    if not any(file.is_file() and re.fullmatch(r"app-\d+(?:\.\d+)*", file.parent.name)
               for file in discord.glob("app-*/Discord.exe")):
        alternatives = [name for name in ("DiscordPTB", "DiscordCanary") if (Path(local) / name).is_dir()]
        hint = f" Foi encontrado apenas outro canal: {', '.join(alternatives)}. Este instalador usa Discord Stable." if alternatives else ""
        fail(f"Discord Stable não encontrado em {discord}. Instale e abra o Discord uma vez. "
             "Execute este instalador na mesma conta do Windows que usa o Discord." + hint)
    return discord


def verify_injection(vencord: Path, discord: Path):
    # Confirma o destino real, não apenas uma mensagem de sucesso do injetor.
    versions = [p for p in discord.glob("app-*")
                if re.fullmatch(r"app-\d+(?:\.\d+)*", p.name) and (p / "Discord.exe").is_file()]
    if not versions:
        fail(f"Nenhuma versão do Discord encontrada em {discord}.")
    latest = max(versions, key=lambda p: tuple(map(int, p.name[4:].split("."))))
    patcher = (vencord / "dist/patcher.js").resolve()
    for name in ("patcher.js", "preload.js", "renderer.js"):
        file = vencord / "dist" / name
        if not file.is_file() or not file.stat().st_size:
            fail(f"Build incompleto: {file}")
    if "LefferzinBypass" not in (vencord / "dist/renderer.js").read_text(encoding="utf-8", errors="replace"):
        fail("O build instalado não contém LefferzinBypass.")
    resources = latest / "resources"
    archive = resources / "app.asar"
    backup = resources / "_app.asar"
    if not archive.is_file() or not backup.is_file() or not backup.stat().st_size:
        fail(f"O patch do Discord não foi confirmado em {resources}.")
    # O ASAR gerado pelo instalador contém require(<caminho JSON do patcher>).
    with archive.open("rb") as stream:
        loader = stream.read(1024 * 1024)
    reference = json.dumps(str(patcher), ensure_ascii=False).encode("utf-8")
    if b"require(" + reference + b")" not in loader:
        fail(f"O Discord em {latest} não aponta para o build instalado: {patcher}")
    log(f"OK: patch e plugin verificados em {latest}")


def inject(vencord: Path):
    step("[7/8] Fechando Discord e instalando no Discord Stable")
    discord = find_discord()
    installer = vencord / "dist/Installer/VencordInstallerCli.exe"
    log("Injetor oficial fixado: v1.4.0 (compatível com build local)")
    download(INSTALLER_URL, installer)
    if hashlib.sha256(installer.read_bytes()).hexdigest() != INSTALLER_SHA256:
        fail("O SHA256 do injetor não corresponde à versão oficial v1.4.0.")
    with installer.open("rb") as stream:
        if stream.read(2) != b"MZ":
            fail("O download do injetor oficial não é um executável Windows.")
    subprocess.run(["taskkill", "/F", "/IM", "Discord.exe"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(3)
    env = os.environ.copy()
    env.update(VENCORD_USER_DATA_DIR=str(vencord.resolve()), VENCORD_DEV_INSTALL="1")
    result = run([str(installer), "-install", "-location", str(discord)], cwd=vencord, env=env)
    combined = result.stdout or ""
    if re.search(r"\b(?:ERROR|FATAL|Failed)\b", combined, re.I) or not re.search(r"\bSuccessfully patched\b", combined, re.I):
        fail("A injeção não foi confirmada pelo instalador oficial.")
    verify_injection(vencord, discord)


LOGGER = None

def main() -> int:
    global LOGGER, CURRENT_STEP, PNPM_COMMAND
    CURRENT_STEP = "Verificando requisitos"
    PNPM_COMMAND = []
    if os.name != "nt":
        report_error("Este instalador foi feito para Windows.")
        return 1
    if sys.maxsize <= 2**32:
        report_error("O projeto exige Windows 64-bit.")
        return 1
    local_appdata = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    root = local_appdata / "LefferzinBypass"
    tools = root / "tools"
    logs = root / "logs"
    log_path = None
    work = None
    script_dir = Path(__file__).resolve().parent
    try:
        root.mkdir(parents=True, exist_ok=True)
        logs.mkdir(parents=True, exist_ok=True)
        candidate_log = logs / f"install-{time.strftime('%Y%m%d-%H%M%S')}.log"
        LOGGER = candidate_log.open("w", encoding="utf-8")
        log_path = candidate_log
        work = Path(tempfile.mkdtemp(prefix="YaniNeko-"))
        log("=" * 54)
        log(" YaniNeko - Instalador Python automático")
        log("=" * 54)
        log(f"Log: {log_path}")
        step("Verificando a instalação do Discord Stable")
        find_discord()
        install_git(tools)
        install_node(tools)
        install_pnpm(tools)
        plugin_source = download_plugin(work, script_dir)
        vencord = prepare_vencord(root, plugin_source)
        build(vencord, plugin_source)
        inject(vencord)
        step("Configurando atualizações automáticas")
        run([shutil.which("node"), str(plugin_source / "auto-update.cjs"), "--install", str(vencord), str(plugin_source)], cwd=vencord)
        configure_optional_uac(root)
        step("[8/8] Finalização")
        log("INSTALAÇÃO CONCLUÍDA.")
        log("Abra o Discord e ative LefferzinBypass em Configurações > Plugins.")
        return 0
    except Exception as exc:
        report_error(str(exc), log_path)
        return 1
    finally:
        if work:
            shutil.rmtree(work, ignore_errors=True)
        if LOGGER:
            LOGGER.close()
            LOGGER = None


def disable_uac(root: Path):
    # Only update the requested consent settings; do not elevate the full installer
    # or switch its user, so Discord remains associated with the current account.
    import winreg
    key_path = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System"
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key_path, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as key:
        current_admin_prompt, admin_kind = winreg.QueryValueEx(key, "ConsentPromptBehaviorAdmin")
        current_secure_desktop, desktop_kind = winreg.QueryValueEx(key, "PromptOnSecureDesktop")
    if admin_kind != winreg.REG_DWORD or desktop_kind != winreg.REG_DWORD:
        raise RuntimeError("As configurações atuais do UAC não são valores DWORD conhecidos.")
    if current_admin_prompt == 0 and current_secure_desktop == 0:
        log("As configurações solicitadas do UAC já estão aplicadas. Pode ser necessário reiniciar o Windows.")
        return

    restore = root / "Reativar-UAC.reg"
    configure = root / "Configurar-UAC.reg"
    restore.write_text('Windows Registry Editor Version 5.00\n\n'
                       '[HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System]\n'
                       f'"ConsentPromptBehaviorAdmin"=dword:{current_admin_prompt:08x}\n'
                       f'"PromptOnSecureDesktop"=dword:{current_secure_desktop:08x}\n', encoding="utf-16")
    configure.write_text('Windows Registry Editor Version 5.00\n\n'
                         '[HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System]\n'
                         '"ConsentPromptBehaviorAdmin"=dword:00000000\n'
                         '"PromptOnSecureDesktop"=dword:00000000\n', encoding="utf-16")
    # The standard Windows elevation prompt is retained for this narrowly scoped change.
    ps_path = "'" + str(configure).replace("'", "''") + "'"
    script = ("$regPath=" + ps_path + "; "
              "$p=Start-Process -FilePath ($env:SystemRoot+'\\System32\\reg.exe') "
              "-ArgumentList ('IMPORT \"'+$regPath+'\" /reg:64') "
              "-Verb RunAs -WindowStyle Hidden -Wait -PassThru; "
              "if($null -eq $p){ exit 1223 }; exit $p.ExitCode")
    powershell = str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe")
    try:
        result = subprocess.run([powershell, "-NoProfile", "-NonInteractive", "-Command", script],
                                capture_output=True, timeout=120, creationflags=subprocess.CREATE_NO_WINDOW)
    finally:
        configure.unlink(missing_ok=True)
    if result.returncode != 0:
        raise RuntimeError("A autorização foi cancelada ou o Windows recusou a alteração do UAC.")
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key_path, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as key:
        admin_prompt = winreg.QueryValueEx(key, "ConsentPromptBehaviorAdmin")[0]
        secure_desktop = winreg.QueryValueEx(key, "PromptOnSecureDesktop")[0]
    if admin_prompt != 0 or secure_desktop != 0:
        raise RuntimeError("O Windows não confirmou as alterações solicitadas do UAC.")
    log(f"Preferências do UAC configuradas. Reinicie o computador para aplicar. Para reverter, abra {restore} e reinicie.")


def configure_optional_uac(root: Path):
    try:
        disable_uac(root)
    except Exception as exc:
        # A cancelled elevation prompt must not invalidate the plugin installation.
        log(f"Instalação concluída, mas as preferências do UAC não foram aplicadas/confirmadas: {exc}")


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        assert "auto-update.cjs" in REQUIRED
        assert re.fullmatch(r"[a-f0-9]{64}", INSTALLER_SHA256)
        print("YaniNeko installer self-test OK: auto-update enabled")
        raise SystemExit(0)
    code = main()
    if sys.stdin is not None and sys.stdin.isatty():
        try:
            input("Pressione Enter para fechar...")
        except (EOFError, KeyboardInterrupt):
            pass
    raise SystemExit(code)
