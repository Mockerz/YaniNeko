$ErrorActionPreference = "SilentlyContinue"
$script:CI = $env:CI = "true"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Step($label) {
    Write-Host ""
    Write-Host $label -ForegroundColor Cyan
}
function Write-Ok {
    Write-Host "OK" -ForegroundColor Green
}
function Write-Warn($msg) {
    Write-Host "  [AVISO] " -ForegroundColor Yellow -NoNewline
    Write-Host $msg
}
function Write-Err($msg) {
    Write-Host "  [ERRO] " -ForegroundColor Red -NoNewline
    Write-Host $msg
}
function Stop-DiscordProcesses {
    foreach ($name in @("Discord", "Update")) {
        try { Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch { }
    }
    Start-Sleep -Seconds 3
}

function Run-InDir($dir, $program, $arglist, [switch]$CaptureOnly) {
    Push-Location $dir
    try {
        $cmd = Get-Command $program -ErrorAction SilentlyContinue
        if (-not $cmd) {
            Write-Warn "Comando nao encontrado: $program"
            return [pscustomobject]@{ ExitCode = 127; Output = "" }
        }
        $all = @($arglist)
        if ($CaptureOnly) {
            $out = & $cmd.Source @all 2>&1 | Out-String
            return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $out }
        } else {
            & $cmd.Source @all
            return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = "" }
        }
    } finally {
        Pop-Location
    }
}

function Install-PortableGit($WorkDir) {
    Write-Host "    Instalando Git (portatil, winget)..."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        $r = Start-Process -FilePath winget -ArgumentList @("install", "--id", "Git.Git", "--silent", "--accept-package-agreements", "--accept-source-agreements") -Wait -NoNewWindow -PassThru
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
        if (Get-Command git -ErrorAction SilentlyContinue) { return $true }
    }
    Write-Warn "winget falhou. Tentando baixar MinGit portatil..."
    $gitZip = Join-Path $WorkDir "mingit.zip"
    $gitDir = Join-Path $WorkDir "git"
    $url = "https://github.com/git-for-windows/git/releases/latest/download/MinGit-2.46.0-64-bit.zip"
    try {
        Invoke-WebRequest -Uri $url -OutFile $gitZip -UseBasicParsing -ErrorAction Stop
        Expand-Archive -Path $gitZip -DestinationPath $gitDir -Force -ErrorAction Stop
        $gitCmd = Join-Path $gitDir "cmd\git.exe"
        if (Test-Path $gitCmd) {
            $env:Path = (Join-Path $gitDir "cmd") + ";" + $env:Path
            if (Get-Command git -ErrorAction SilentlyContinue) { return $true }
        }
    } catch {
        Write-Err "Nao foi possivel instalar Git automaticamente. Instale manualmente: https://git-scm.com"
        return $false
    }
    return $false
}

function Install-PortableNode($WorkDir) {
    Write-Host "    Instalando Node.js LTS (portatil zip)..."
    $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
    $nodeZip = Join-Path $WorkDir "node.zip"
    $nodeDir = Join-Path $WorkDir "node"
    $url = "https://nodejs.org/dist/v20.17.0/node-v20.17.0-win-$arch.zip"
    try {
        Invoke-WebRequest -Uri $url -OutFile $nodeZip -UseBasicParsing -ErrorAction Stop
        if (-not (Test-Path $nodeDir)) { New-Item -ItemType Directory -Path $nodeDir -Force | Out-Null }
        Expand-Archive -Path $nodeZip -DestinationPath $nodeDir -Force -ErrorAction Stop
        $inner = Get-ChildItem -Path $nodeDir -Directory | Select-Object -First 1
        if ($inner) {
            $nodeBin = $inner.FullName
            $env:Path = $nodeBin + ";" + $env:Path
            if (Get-Command node -ErrorAction SilentlyContinue) {
                return $true
            }
        }
    } catch {
        Write-Err "Nao foi possivel instalar Node automaticamente. Instale manualmente: https://nodejs.org"
        return $false
    }
    return $false
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  LefferzinBypass - Instalador Vencord" -ForegroundColor Cyan
Write-Host "  (Build + Inject automatico)" -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "Pasta de trabalho: $ScriptDir" -ForegroundColor Gray
Write-Host ""

# 0) Pre-requisitos com auto-instalação portátil
Write-Step "[Pre] Verificando pre-requisitos (Git / Node.js)..."
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    if (-not (Install-PortableGit $ScriptDir)) {
        pause; exit 1
    }
}
Write-Host "  Git ........ $(git --version 2>$null)" -ForegroundColor Green

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    if (-not (Install-PortableNode $ScriptDir)) {
        pause; exit 1
    }
}
Write-Host "  Node.js .... $(node --version 2>$null)" -ForegroundColor Green
Write-Host "  npm ........ $(npm --version 2>$null)" -ForegroundColor Green

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Warn "pnpm nao encontrado. Instalando via corepack..."
    try {
        & corepack enable 2>&1 | Out-Null
        & corepack prepare pnpm@latest --activate 2>&1 | Out-Null
    } catch { }
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
        Write-Err "Nao consegui instalar o pnpm. Instale manualmente: npm install -g pnpm"
        pause; exit 1
    }
}
Write-Host "  pnpm ....... $(pnpm --version 2>$null)" -ForegroundColor Green
Write-Ok

# PASSO 0) Baixar plugin do GitHub se nao existir
if (-not (Test-Path "manifest.json")) {
    Write-Step "[0/7] Arquivos do plugin nao encontrados. Baixando do GitHub (Mockerz/YaniNeko)..."
    $zip = Join-Path $ScriptDir "_plugin_github.zip"
    $suffix = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $url = "https://github.com/Mockerz/YaniNeko/archive/refs/heads/main.zip?v=$suffix"
    try {
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -ErrorAction Stop
    } catch {
        Write-Err "Falha ao baixar ZIP do GitHub. Erro: $_"
        pause; exit 1
    }
    tar -xf $zip
    $extract = Join-Path $ScriptDir "YaniNeko-main"
    if (Test-Path $extract) {
        Write-Host "        Extraido! Movendo arquivos para a pasta atual..."
        Get-ChildItem -Path $extract -Force | ForEach-Object {
            $dst = Join-Path $ScriptDir $_.Name
            if ($_.PSIsContainer) {
                Copy-Item -Path $_.FullName -Destination $dst -Recurse -Force -ErrorAction SilentlyContinue
            } else {
                Copy-Item -Path $_.FullName -Destination $dst -Force -ErrorAction SilentlyContinue
            }
        }
        Remove-Item -Path $extract -Recurse -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -Path $zip -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path "manifest.json")) {
        Write-Err "Ainda nao foi possivel encontrar os arquivos do plugin. Baixe manualmente do GitHub."
        pause; exit 1
    }
    # GitHub bloqueia arquivos .exe no archive ZIP algumas vezes. Se o binario faltar ou for 0KB, baixa direto do raw.githubusercontent
    $binDst = Join-Path $ScriptDir "bin\win32-x64\proton-confgen.exe"
    $binFaltando = -not (Test-Path $binDst)
    if (-not $binFaltando) {
        $fi = Get-Item $binDst
        if ($fi.Length -eq 0) { $binFaltando = $true }
    }
    if ($binFaltando) {
        Write-Warn "Binario proton-confgen.exe nao veio no zip. Baixando separadamente..."
        New-Item -ItemType Directory -Path (Split-Path -Parent $binDst) -Force -ErrorAction SilentlyContinue | Out-Null
        try {
            $binUrl = "https://raw.githubusercontent.com/Mockerz/YaniNeko/main/bin/win32-x64/proton-confgen.exe?t=$suffix"
            Invoke-WebRequest -Uri $binUrl -OutFile $binDst -UseBasicParsing -ErrorAction Stop
        } catch {
            Write-Err "Falha ao baixar binario proton-confgen.exe. Erro: $_"
            pause; exit 1
        }
    }
    Write-Ok
}

# PASSO 1) Vencord oficial
Write-Step "[1/7] Baixando/Atualizando Vencord..."
$vencordDir = Join-Path $ScriptDir "Vencord"
if (-not (Test-Path $vencordDir)) {
    Write-Host "    Clonando Vencord..."
    $r = Run-InDir $ScriptDir "git" @("clone", "https://github.com/Vendicated/Vencord.git", "Vencord")
    if ($r.ExitCode -ne 0) {
        Write-Err "Falha ao clonar Vencord."
        pause; exit 1
    }
} else {
    Write-Host "    Vencord ja existe. Atualizando..."
    Run-InDir $vencordDir "git" @("pull") | Out-Null
}
Write-Ok

# PASSO 2) Copiar plugin
Write-Step "[2/7] Copiando plugin para userplugins do Vencord..."
$pluginDir = Join-Path $vencordDir "src\userplugins\LefferzinBypass"
$pluginBinDir = Join-Path $pluginDir "bin\win32-x64"
if (Test-Path $pluginDir) { Remove-Item -Recurse -Force $pluginDir -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $pluginBinDir -Force -ErrorAction SilentlyContinue | Out-Null

$essential = @(
    "manifest.json","index.tsx","native.ts","presence.ts","stability.ts",
    "vpn-controller.ts","vpn-proton.ts","vpn-types.ts","vpn-windows.ts"
)
$copyOk = $true
Write-Host "    - Copiando arquivos essenciais..."
foreach ($f in $essential) {
    $src = Join-Path $ScriptDir $f
    if (-not (Test-Path $src)) {
        Write-Err "Arquivo essencial FALTANDO: $f"
        $copyOk = $false
        continue
    }
    try {
        Copy-Item -Path $src -Destination $pluginDir -Force -ErrorAction Stop
    } catch {
        Write-Err "Falha ao copiar $f : $_"
        $copyOk = $false
    }
}

Write-Host "    - Copiando binario proton-confgen.exe..."
$binSrc = Join-Path $ScriptDir "bin\win32-x64\proton-confgen.exe"
if (Test-Path $binSrc) {
    try {
        Copy-Item -Path $binSrc -Destination $pluginBinDir -Force -ErrorAction Stop
    } catch {
        Write-Err "Falha ao copiar proton-confgen.exe : $_"
        $copyOk = $false
    }
} else {
    Write-Err "Binario faltando: bin\win32-x64\proton-confgen.exe"
    $copyOk = $false
}

if (-not $copyOk) {
    Write-Host ""
    Write-Err "Falha ao copiar arquivos essenciais do plugin."
    Write-Host "Pasta atual: $ScriptDir"
    Write-Host "Conteudo:"
    Get-ChildItem -Name $ScriptDir | ForEach-Object { Write-Host "  - $_" }
    pause; exit 1
}
Write-Ok

# PASSO 3) pnpm install
Write-Step "[3/7] Instalando dependencias do Vencord (pnpm install)..."
$r = Run-InDir $vencordDir "pnpm" @("install", "--no-frozen-lockfile")
$nodeModulesOk = Test-Path (Join-Path $vencordDir "node_modules\.pnpm")
if ($r.ExitCode -ne 0 -and -not $nodeModulesOk) {
    Write-Warn "Dependencias podem ter falhado, tentando continuar..."
}
Write-Ok

# PASSO 4) pnpm build
Write-Step "[4/7] Compilando Vencord (pnpm build)..."
$r = Run-InDir $vencordDir "pnpm" @("build")
if ($r.ExitCode -ne 0) {
    Write-Err "Falha no build do Vencord."
    pause; exit 1
}
Write-Ok

# PASSO 5) Validar plugin no renderer.js
Write-Step "[5/7] Verificando se o plugin foi incluido no build..."
$renderer = Join-Path $vencordDir "dist\renderer.js"
if (-not (Test-Path $renderer) -or -not (Select-String -Path $renderer -Pattern "LefferzinBypass" -SimpleMatch -Quiet)) {
    Write-Warn "Plugin nao apareceu no renderer.js. Tentando build userplugins..."
    Run-InDir $vencordDir "pnpm" @("build", "--scope", "userplugins") | Out-Null
    if (-not (Test-Path $renderer) -or -not (Select-String -Path $renderer -Pattern "LefferzinBypass" -SimpleMatch -Quiet)) {
        Write-Err "Plugin nao foi compilado dentro do Vencord. Verifique os logs acima."
        pause; exit 1
    }
}
Write-Host "  [OK] Plugin confirmado no build." -ForegroundColor Green

# PASSO 6) Copiar proton-confgen.exe para dist
Write-Step "[6/7] Copiando proton-confgen.exe para dist..."
$distDesktopBin = Join-Path $vencordDir "dist\desktop\bin\win32-x64"
New-Item -ItemType Directory -Path $distDesktopBin -Force -ErrorAction SilentlyContinue | Out-Null
if (Test-Path $binSrc) {
    Copy-Item -Path $binSrc -Destination $distDesktopBin -Force -ErrorAction SilentlyContinue
    $distUserpluginsBin = Join-Path $vencordDir "dist\_userplugins\LefferzinBypass\bin\win32-x64"
    if (Test-Path $distUserpluginsBin) {
        Copy-Item -Path $binSrc -Destination $distUserpluginsBin -Force -ErrorAction SilentlyContinue
    }
}
Write-Ok

# PASSO 7) Matar Discord e inject
Write-Step "[7/7] Matando Discord + Update.exe (para evitar bloqueio no app.asar)..."
Stop-DiscordProcesses
Write-Host "    Processos encerrados."

Write-Host ""
Write-Host "Injetando Vencord no Discord Stable automaticamente..." -ForegroundColor Cyan
$runInstaller = Join-Path $vencordDir "scripts\runInstaller.mjs"
$discordStable = Join-Path $env:LOCALAPPDATA "Discord"
$injectSuccess = $false

function Test-InjectOk($output) {
    if (
        ($output -match "Successfully (patched|installed)") -or
        ($output -match '(?im)\bSuccess!?\b') -or
        ($output -match "(?im)successfully") -or
        ($output -match "already patched") -or
        ($output -match "Unpatching first.*Successfully patched") -or
        ($output -match "Vencord is installed") -or
        ($output -match "Successfully unpatched.*Successfully patched")
    ) {
        return $true
    }
    return $false
}

Write-Host "  - Tentativa 1: injector CLI (branch stable)"
$r = Run-InDir $vencordDir "node" @($runInstaller, "--", "--install", "-branch", "stable") -CaptureOnly
Write-Host ($r.Output.Trim()) -ForegroundColor DarkGray
if (Test-InjectOk $r.Output) { $injectSuccess = $true }

if (-not $injectSuccess) {
    Write-Host ""
    Write-Warn "Tentativa 1 falhou. Tentativa 2: injector CLI (caminho fixo Stable)"
    if (Test-Path $discordStable) {
        $r = Run-InDir $vencordDir "node" @($runInstaller, "--", "--install", "-location", $discordStable) -CaptureOnly
        Write-Host ($r.Output.Trim()) -ForegroundColor DarkGray
        if (Test-InjectOk $r.Output) { $injectSuccess = $true }
    }
}

if (-not $injectSuccess) {
    Write-Host ""
    Write-Warn "Tentativa 2 falhou. Tentativa 3: pnpm inject (oficial, abre menu/GUI)"
    $r = Run-InDir $vencordDir "pnpm" @("inject") -CaptureOnly
    Write-Host ($r.Output.Trim()) -ForegroundColor DarkGray
    if (Test-InjectOk $r.Output) { $injectSuccess = $true }
}

if (-not $injectSuccess) {
    $patched = $false
    if (Test-Path $discordStable) {
        $dirs = Get-ChildItem -Path $discordStable -Directory -Filter "app-*" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
        foreach ($d in $dirs) {
            $unpacked = Join-Path $d.FullName "_app.asar.unpacked"
            if (Test-Path $unpacked) { $patched = $true; break }
            $asar = Join-Path $d.FullName "app.asar"
            if (Test-Path $asar) {
                $f = Get-Item $asar
                if ($f.Length -gt 200MB) { $patched = $true; break }
            }
        }
    }
    if ($patched) {
        Write-Warn "Injector reportou erro, mas parece que o Discord ESTA patchado (app.asar grande/_app.asar.unpacked existe)."
    } else {
        Write-Warn "Inject automatico nao funcionou. Abra a pasta:  $vencordDir"
        Write-Warn "  No terminal (barra de endereco -> cmd) digite:  pnpm inject"
        Write-Warn "  E escolha Stable no menu."
        Write-Err "Instalacao interrompida: o Vencord nao foi confirmado no Discord Stable."
        pause
        exit 1
    }
}

Set-Location $ScriptDir

Write-Host ""
Write-Host "======================================================" -ForegroundColor Green
Write-Host "  INSTALACAO CONCLUIDA!" -ForegroundColor Green
Write-Host "======================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Abra o Discord. O plugin LefferzinBypass vai aparecer"
Write-Host "  em Configuracoes do Usuario  -  Plugins."
Write-Host ""
Write-Host "  1) No painel do plugin, logue sua conta ProtonVPN"
Write-Host "  2) Clique em Otimizar rotas (ele reinicia o Discord)"
Write-Host "  3) Pronto! O bypass ativa automaticamente."
Write-Host ""
Write-Host "  Se o Discord abrir sem o plugin, feche tudo e rode"
Write-Host "  este arquivo NOVAMENTE (as vezes o Update.exe resiste)."
Write-Host "======================================================" -ForegroundColor Green
pause
