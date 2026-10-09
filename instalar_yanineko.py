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
PNPM_VERSION = "11.9.0"
# v1.4.1 interrompe builds locais antes do patch e pode retornar Success.
# Hash publicado em https://github.com/Vencord/Installer/releases/tag/v1.4.0
INSTALLER_URL = "https://github.com/Vencord/Installer/releases/download/v1.4.0/VencordInstallerCli.exe"
INSTALLER_SHA256 = "466d2a0be1f380ddffed052df3cc132125fa34dc1af29312e14f13f358c8d2a2"
REQUIRED = [
    "manifest.json", "index.tsx", "native.ts", "presence.ts", "stability.ts",
    "vpn-controller.ts", "vpn-proton.ts", "vpn-types.ts", "vpn-windows.ts", "auto-update.cjs",
]


def log(message: str = ""):
    print(message, flush=True)
    if LOGGER:
        LOGGER.write(message + "\n")
        LOGGER.flush()


def step(message: str):
    log("\n" + message)


def fail(message: str):
    raise RuntimeError(message)


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
    if result.stdout:
        for line in result.stdout.rstrip().splitlines():
            log(line)
    if check and result.returncode != 0:
        fail(f"Comando falhou com código {result.returncode}: {command[0]}")
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
    if command_exists("git"):
        log("Git já disponível: " + run(["git", "--version"]).stdout.strip())
        return
    step("[1/8] Instalando Git portátil")
    zip_path = tools / "mingit.zip"
    git_dir = tools / "git"
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
    except Exception as exc:
        log(f"API do Git indisponível ({exc}); usando fallback fixo.")
        url = "https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/MinGit-2.51.0-64-bit.zip"
    download(url, zip_path)
    shutil.rmtree(git_dir, ignore_errors=True)
    extract_zip(zip_path, git_dir)
    git_exe = git_dir / "cmd" / "git.exe"
    if not git_exe.exists():
        fail("Git portátil foi extraído, mas git.exe não foi encontrado.")
    prepend_path(git_exe.parent)
    log("OK: " + run(["git", "--version"]).stdout.strip())


def install_node(tools: Path):
    if command_exists("node"):
        version = run(["node", "--version"]).stdout.strip()
        match = re.match(r"v(\d+)", version)
        if match and int(match.group(1)) >= 22:
            log("Node.js já disponível: " + version)
            return
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
    download(f"https://nodejs.org/dist/{version}/node-{version}-win-{arch}.zip", archive)
    shutil.rmtree(node_dir, ignore_errors=True)
    extract_zip(archive, node_dir)
    folders = [p for p in node_dir.iterdir() if p.is_dir()]
    if not folders:
        fail("Node.js portátil não foi extraído corretamente.")
    prepend_path(folders[0])
    log(f"OK: {run(['node', '--version']).stdout.strip()} / npm {run(['npm', '--version']).stdout.strip()}")


def install_pnpm(tools: Path):
    step(f"[3/8] Preparando pnpm {PNPM_VERSION}")
    corepack = shutil.which("corepack")
    if not corepack:
        fail("Corepack não foi encontrado junto do Node.js.")
    os.environ["COREPACK_HOME"] = str(tools / "corepack")
    os.environ["COREPACK_ENABLE_DOWNLOAD_PROMPT"] = "0"
    # Node pode estar em Program Files; os shims devem pertencer ao usuário.
    shims = tools / "corepack-bin"
    shims.mkdir(parents=True, exist_ok=True)
    run([corepack, "enable", "--install-directory", str(shims), "pnpm"])
    prepend_path(shims)
    run([corepack, "prepare", f"pnpm@{PNPM_VERSION}", "--activate"])
    pnpm = shutil.which("pnpm")
    if not pnpm:
        fail("pnpm não foi ativado pelo Corepack.")
    log("OK: " + run([pnpm, "--version"]).stdout.strip())


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
        run(["git", "clone", "--depth", "1", VENCORD_REPO, str(vencord)], cwd=install_root)
    else:
        run(["git", "fetch", "--depth", "1", "origin", "main"], cwd=vencord)
        run(["git", "reset", "--hard", "origin/main"], cwd=vencord)
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
    pnpm = shutil.which("pnpm") or "pnpm"
    run([pnpm, "install", "--frozen-lockfile"], cwd=vencord)
    run([pnpm, "build", "--disable-updater"], cwd=vencord)
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
    discord = Path(os.environ["LOCALAPPDATA"]) / "Discord"
    if not any(discord.glob("app-*/Discord.exe")):
        fail(f"Discord Stable não encontrado em {discord}. Instale e abra o Discord uma vez. "
             "Execute este instalador na mesma conta do Windows que usa o Discord.")
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
    global LOGGER
    if os.name != "nt":
        print("ERRO: este script foi feito para Windows.")
        return 1
    if sys.maxsize <= 2**32:
        print("ERRO: o projeto exige Windows 64-bit.")
        return 1
    local_appdata = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    root = local_appdata / "LefferzinBypass"
    tools = root / "tools"
    logs = root / "logs"
    root.mkdir(parents=True, exist_ok=True)
    logs.mkdir(parents=True, exist_ok=True)
    log_path = logs / f"install-{time.strftime('%Y%m%d-%H%M%S')}.log"
    LOGGER = log_path.open("w", encoding="utf-8")
    work = Path(tempfile.mkdtemp(prefix="YaniNeko-"))
    script_dir = Path(__file__).resolve().parent
    log("=" * 54)
    log(" YaniNeko - Instalador Python automático")
    log("=" * 54)
    log(f"Log: {log_path}")
    try:
        find_discord()
        install_git(tools)
        install_node(tools)
        install_pnpm(tools)
        plugin_source = download_plugin(work, script_dir)
        vencord = prepare_vencord(root, plugin_source)
        build(vencord, plugin_source)
        inject(vencord)
        run([shutil.which("node"), str(plugin_source / "auto-update.cjs"), "--install", str(vencord), str(plugin_source)], cwd=vencord)
        step("[8/8] Finalização")
        log("INSTALAÇÃO CONCLUÍDA.")
        log("Abra o Discord e ative LefferzinBypass em Configurações > Plugins.")
        return 0
    except Exception as exc:
        log(f"\nINSTALAÇÃO FALHOU: {exc}")
        log(f"Log completo: {log_path}")
        return 1
    finally:
        shutil.rmtree(work, ignore_errors=True)
        if LOGGER:
            LOGGER.close()


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
