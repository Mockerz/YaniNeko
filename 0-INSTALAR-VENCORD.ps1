$ErrorActionPreference = "Stop"
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
        try {
            Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        } catch { }
    }
    Start-Sleep -Seconds 3
}
function Invoke-Cmd($file, $arglist, $workdir = $null) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $file
    if ($arglist) { $psi.Arguments = ($arglist -join " ") }
    if ($workdir) { $psi.WorkingDirectory = $workdir }
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $psi
    [void]$p.Start()
    $out = $p.StandardOutput.ReadToEnd()
    $err = $p.StandardError.ReadToEnd()
    $p.WaitForExit()
    return [pscustomobject]@{ ExitCode = $p.ExitCode; StdOut = $out; StdErr = $err }
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  LefferzinBypass - Instalador Vencord" -ForegroundColor Cyan
Write-Host "  (Build + Inject automatico)" -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan

# 0) Pré-checagem
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Err "Git nao encontrado. Instale o Git primeiro: https://git-scm.com"
    pause; exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Err "Node.js nao encontrado. Instale o Node 18+: https://nodejs.org"
    pause; exit 1
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Warn "pnpm nao encontrado. Instalando via corepack..."
    $r1 = Invoke-Cmd "corepack" @("enable")
    $r2 = Invoke-Cmd "corepack" @("prepare", "pnpm@latest", "--activate")
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
        Write-Err "Nao consegui instalar o pnpm. Instale manualmente: npm install -g pnpm"
        pause; exit 1
    }
}

# PASSO 0) Se os arquivos do plugin nao existem, baixa direto do GitHub
if (-not (Test-Path "manifest.json")) {
    Write-Step "[0/7] Arquivos do plugin nao encontrados. Baixando do GitHub (Mockerz/YaniNeko)..."
    if (-not (Get-Command curl -ErrorAction SilentlyContinue)) {
        Write-Err "curl nao encontrado. Baixe manualmente em https://github.com/Mockerz/YaniNeko"
        pause; exit 1
    }
    $zip = Join-Path $ScriptDir "_plugin_github.zip"
    $url = "https://github.com/Mockerz/YaniNeko/archive/refs/heads/main.zip"
    try {
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    } catch {
        Write-Err "Falha ao baixar ZIP do GitHub. Erro: $_"
        pause; exit 1
    }
    if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
        Write-Err "tar (extracao) nao encontrado. Extraia manualmente $_plugin_github.zip"
        pause; exit 1
    }
    tar -xf $zip
    $extract = Join-Path $ScriptDir "YaniNeko-main"
    if (Test-Path $extract) {
        Write-Host "        Extraido! Movendo arquivos para a pasta atual..."
        Get-ChildItem -Path $extract -Force | ForEach-Object {
            $dst = Join-Path $ScriptDir $_.Name
            if ($_.PSIsContainer) {
                if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }
                Copy-Item -Path (Join-Path $extract $_.Name) -Destination $ScriptDir -Recurse -Force
            } else {
                Copy-Item -Path $_.FullName -Destination $ScriptDir -Force
            }
        }
        Remove-Item -Path $extract -Recurse -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -Path $zip -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path "manifest.json")) {
        Write-Err "Ainda nao foi possivel encontrar os arquivos do plugin. Baixe manualmente do GitHub."
        pause; exit 1
    }
    Write-Ok
}

# PASSO 1) Clonar/pull do Vencord oficial
Write-Step "[1/7] Baixando/Atualizando Vencord..."
$vencordDir = Join-Path $ScriptDir "Vencord"
if (-not (Test-Path $vencordDir)) {
    Write-Host "    Clonando Vencord..."
    $r = Invoke-Cmd "git" @("clone", "https://github.com/Vendicated/Vencord.git", "Vencord")
    if ($r.ExitCode -ne 0) {
        Write-Err "Falha ao clonar Vencord."
        Write-Host $r.StdErr
        pause; exit 1
    }
} else {
    Write-Host "    Vencord ja existe. Atualizando..."
    $r = Invoke-Cmd "git" @("pull") $vencordDir
}
Write-Ok

# PASSO 2) Copiar plugin
Write-Step "[2/7] Copiando plugin para userplugins do Vencord..."
$pluginDir = Join-Path $vencordDir "src\userplugins\LefferzinBypass"
$pluginBinDir = Join-Path $pluginDir "bin\win32-x64"
if (Test-Path $pluginDir) { Remove-Item -Recurse -Force $pluginDir -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $pluginBinDir -Force | Out-Null

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
        Copy-Item -Path $src -Destination $pluginDir -Force
    } catch {
        Write-Err "Falha ao copiar $f : $_"
        $copyOk = $false
    }
}

Write-Host "    - Copiando binario proton-confgen.exe..."
$binSrc = Join-Path $ScriptDir "bin\win32-x64\proton-confgen.exe"
if (Test-Path $binSrc) {
    try {
        Copy-Item -Path $binSrc -Destination $pluginBinDir -Force
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

Set-Location $vencordDir

# PASSO 3) pnpm install
Write-Step "[3/7] Instalando dependencias do Vencord (pnpm install)..."
$r = Invoke-Cmd "pnpm" @("install", "--no-frozen-lockfile")
if ($r.ExitCode -ne 0) { Write-Warn "Dependencias podem ter falhado, tentando continuar..." }
Write-Ok

# PASSO 4) pnpm build
Write-Step "[4/7] Compilando Vencord (pnpm build)..."
$r = Invoke-Cmd "pnpm" @("build")
if ($r.ExitCode -ne 0) {
    Write-Err "Falha no build do Vencord."
    Write-Host $r.StdErr
    pause; exit 1
}
Write-Ok

# PASSO 5) Verificar plugin no renderer.js
Write-Step "[5/7] Verificando se o plugin foi incluido no build..."
$renderer = Join-Path $vencordDir "dist\renderer.js"
if (-not (Test-Path $renderer) -or -not (Select-String -Path $renderer -Pattern "LefferzinBypass" -SimpleMatch -Quiet)) {
    Write-Warn "Plugin nao apareceu no renderer.js. Tentando build userplugins..."
    $r = Invoke-Cmd "pnpm" @("build", "--scope", "userplugins")
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

# PASSO 7) Matar Discord + Update.exe e inject
Write-Step "[7/7] Matando Discord + Update.exe (para evitar bloqueio no app.asar)..."
Stop-DiscordProcesses
Write-Host "    Processos encerrados."

Write-Host ""
Write-Host "Injetando Vencord no Discord Stable automaticamente..." -ForegroundColor Cyan
$injectFail = $false
$runInstaller = Join-Path $vencordDir "scripts\runInstaller.mjs"
$r = Invoke-Cmd "node" @($runInstaller, "--", "--install", "-branch", "stable") $vencordDir
if ($r.ExitCode -ne 0) {
    Write-Warn "Inject automatico falhou. Tentando com caminho customizado..."
    $discordStable = Join-Path $env:LOCALAPPDATA "Discord"
    if (Test-Path $discordStable) {
        $r = Invoke-Cmd "node" @($runInstaller, "--", "--install", "-branch", "stable", "-location", "`"$discordStable`"") $vencordDir
        if ($r.ExitCode -ne 0) {
            Write-Warn "Inject com caminho fixo tambem falhou. Tentando abrir CLI..."
            $installerCli = Join-Path $vencordDir "dist\Installer\VencordInstallerCli.exe"
            if (Test-Path $installerCli) {
                & $installerCli --install -branch stable
            } else {
                $injectFail = $true
            }
        }
    } else {
        $injectFail = $true
    }
}
if ($injectFail) { Write-Warn "Inject nao rodou automatico. Abra o Vencord e rode pnpm inject manualmente." }

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
