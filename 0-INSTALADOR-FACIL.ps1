$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

# =============================================================================
# CONFIGURACAO GLOBAL (pre-configurado para o repositorio Mockerz/shaco)
# =============================================================================
# Client mod padrao para pessoas normais. Vencord vanilla (suporte nativo a userplugins).
$VENDOR_NAME_DEFAULT    = "Vencord"
$VENDOR_GITHUB_DEFAULT  = "Vendicated/Vencord"
$VENDOR_BRANCH_DEFAULT  = "main"

# Smart-pick para DESENVOLVEDORES apenas: se rodar esse instalador DENTRO de uma copia
# local que ja tem as fontes do Equicord baixadas, usa elas (teste local).
# Para pessoas comuns (clonaram o repo Mockerz/shaco), esse if cai no "else" => Vencord vanilla.
$RootDirForDetect = Split-Path -Parent $MyInvocation.MyCommand.Path
if (Test-Path (Join-Path (Join-Path $RootDirForDetect "Equicord") "package.json")) {
    $VENDOR_NAME          = "Equicord"
    $VENDOR_GITHUB        = "L3ffer/Equicord"
    $VENDOR_BRANCH        = "main"
    Write-Host "[i] Detectado Equicord local (modo dev) - usando ele como vendor." -ForegroundColor DarkGray
} else {
    $VENDOR_NAME          = $VENDOR_NAME_DEFAULT
    $VENDOR_GITHUB        = $VENDOR_GITHUB_DEFAULT
    $VENDOR_BRANCH        = $VENDOR_BRANCH_DEFAULT
    Write-Host "[i] Modo distribuicao - usando $VENDOR_NAME vanilla como vendor (padrao)." -ForegroundColor DarkGray
}

# Repositorio do plugin (fontes + instalador).
$PLUGIN_GITHUB        = "Mockerz/shaco"
$PLUGIN_BRANCH        = "main"

# Build pre-compilado OPCIONAL nos Releases. Deixe vazio = build no PC do usuario.
# Ex: "https://github.com/Mockerz/shaco/releases/latest/download/GoLiveBypass-Vencord-dist.zip"
$PREBUILT_ZIP_URL     = ""

# Pasta do plugin dentro da pasta userplugins do vendor.
$PLUGIN_FOLDER        = "goLiveBypass"

# Binarios que precisam ser copiados. O proton-confgen e baixado automaticamente do GitHub
# Releases do plugin se ele nao existir localmente (nome do asset nas Releases: proton-confgen-win32-x64.exe).
$PROTONCONFGEN_NAME   = "proton-confgen.exe"

function Write-Step($msg) { Write-Host "=> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "   [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "   [!] $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "   [X] $msg" -ForegroundColor Red }
function Stop-Wait()      { Write-Host "" ; cmd /c pause }
function Test-Cmd($name)  { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Add-ToPath($d) {
    if (-not (Test-Path $d)) { return }
    $env:PATH = "$d;$env:PATH"
    [Environment]::SetEnvironmentVariable("PATH", $env:PATH, "Process")
}

function Get-File($Url, $Out) {
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Out -MaximumRedirection 10
        return Test-Path $Out
    } catch {
        Write-Warn "Invoke-WebRequest falhou para $($Url.Substring(0, [Math]::Min(60,$Url.Length))): $($_.Exception.Message)"
        try {
            $client = New-Object System.Net.WebClient
            $client.DownloadFile($Url, $Out)
            return Test-Path $Out
        } catch {
            return $false
        }
    }
}

function Get-ZipAndExtract($Url, $DestDir) {
    $tmp = Join-Path $env:TEMP "$([Guid]::NewGuid().ToString('N')).zip"
    try {
        if (-not (Get-File $Url $tmp)) { Write-Fail "Download zip falhou"; return $false }
        if (Test-Path $DestDir) { Remove-Item -Recurse -Force $DestDir }
        New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
        try {
            Expand-Archive -LiteralPath $tmp -DestinationPath $DestDir -Force -ErrorAction Stop
            return $true
        } catch {
            try {
                Add-Type -AssemblyName System.IO.Compression.FileSystem
                [System.IO.Compression.ZipFile]::ExtractToDirectory($tmp, $DestDir)
                return $true
            } catch {
                Write-Fail "Expand-Archive falhou: $($_.Exception.Message)"
                return $false
            }
        }
    } finally {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
}

function Find-RootFolder($ParentDir, $TestFileNames) {
    $result = Get-ChildItem -LiteralPath $ParentDir -Directory -ErrorAction SilentlyContinue | Select-Object -First 5
    if (-not $result) { return $ParentDir }
    foreach ($dir in $result) {
        foreach ($f in $TestFileNames) {
            if (Test-Path (Join-Path $dir.FullName $f)) { return $dir.FullName }
        }
    }
    foreach ($dir in $result) {
        $nested = Find-RootFolder $dir.FullName $TestFileNames
        if ($null -ne $nested -and (Test-Path (Join-Path $nested $TestFileNames[0]))) { return $nested }
    }
    return $ParentDir
}

# =============================================================================
# 1) NodeJS (portatil, sem admin)
# =============================================================================
function EnsureNodePortable() {
    # 1. Verifica se jah existe no PATH
    $cur = $null
    try { $cur = & node --version 2>$null } catch {}
    if ($cur -match "^v?(\d+)\." -and [int]$Matches[1] -ge 20) {
        Write-Ok "Node detectado via PATH: $cur"
        return $true
    }

    # 2. Tenta instalar via winget (rapido, se tiver App Installer)
    Write-Step "Tentando instalar Node LTS via winget (se disponivel)..."
    if (Test-Cmd "winget") {
        try { winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements -e 2>&1 | Out-Null } catch {}
        $cur = $null
        try { $cur = & node --version 2>$null } catch {}
        if ($cur -match "^v?(\d+)\." -and [int]$Matches[1] -ge 20) {
            Write-Ok "Node instalado via winget: $cur"
            Add-ToPath (Join-Path $env:ProgramFiles "nodejs")
            Add-ToPath (Join-Path ${env:ProgramFiles(x86)} "nodejs")
            return $true
        }
    }

    # 3. Node portatil zip (sem admin, descompacta no %LOCALAPPDATA%)
    $nodeDir = Join-Path $env:LOCALAPPDATA "NodePortable"
    $nodeExe = Join-Path $nodeDir "node.exe"
    if ((Test-Path $nodeExe)) {
        $v = & $nodeExe --version 2>$null
        if ($v -match "^v?(\d+)\." -and [int]$Matches[1] -ge 20) {
            Write-Ok "Node portatil reutilizado (v$v)"
            Add-ToPath $nodeDir
            return $true
        }
        Write-Warn "Node portatil velho. Vou baixar novo..."
        Remove-Item -Recurse -Force $nodeDir -ErrorAction SilentlyContinue
    }

    Write-Step "Baixando Node 22 LTS portatil (Windows x64 zip)... Sem admin, sem instalador."
    $zipUrl = "https://nodejs.org/dist/v22.11.0/node-v22.11.0-win-x64.zip"
    $staging = Join-Path $env:TEMP "NodePortableStaging"
    if (-not (Get-ZipAndExtract $zipUrl $staging)) {
        Write-Fail "Nao consegui baixar Node. Tente manual: https://nodejs.org/ baixar Node 22 LTS, instalar Next Next Next, e reabrir esse instalador."
        return $false
    }
    $actual = Find-RootFolder $staging @("node.exe","npm.cmd","node_modules")
    if (-not (Test-Path (Join-Path $actual "node.exe"))) {
        Write-Fail "Zip do Node veio formato inesperado."
        return $false
    }
    New-Item -ItemType Directory -Path (Split-Path $nodeDir -Parent) -Force | Out-Null
    Move-Item -LiteralPath $actual -Destination $nodeDir -Force
    if (-not (Test-Path $nodeExe)) {
        Write-Fail "Node portatil nao apareceu no destino."
        return $false
    }
    Add-ToPath $nodeDir
    $v = & $nodeExe --version 2>$null
    Write-Ok "Node portatil instalado: $v"
    return $true
}

# =============================================================================
# 2) Pnpm (standalone ou corepack via node portable)
# =============================================================================
function EnsurePnpmPortable() {
    if (Test-Cmd "pnpm") { Write-Ok "pnpm detectado via PATH"; return $true }

    Write-Step "Tentando corepack enable via Node..."
    try {
        & corepack enable 2>$null
        & corepack prepare pnpm@latest --activate 2>$null
    } catch {}
    if (Test-Cmd "pnpm") { Write-Ok "pnpm ativado via corepack"; return $true }

    $tools = Join-Path $env:LOCALAPPDATA "PnpmPortable"
    $exe = Join-Path $tools "pnpm.exe"
    if (-not (Test-Path $exe)) {
        Write-Step "Baixando pnpm standalone..."
        New-Item -ItemType Directory -Path $tools -Force | Out-Null
        $ok = Get-File "https://github.com/pnpm/pnpm/releases/latest/download/pnpm-win-x64.exe" $exe
        if (-not $ok) {
            $ok = Get-File "https://registry.npmmirror.com/-/binary/pnpm/latest/pnpm-win-x64.exe" $exe
        }
        if (-not $ok) {
            Write-Fail "Nao consegui baixar pnpm. Reinicie o instalador."
            return $false
        }
    }
    Add-ToPath $tools
    if (Test-Cmd "pnpm") { Write-Ok "pnpm standalone configurado"; return $true }
    return $false
}

# =============================================================================
# 3) Vencord / Equicord source (baixar zip, sem git)
# =============================================================================
function EnsureVendorSource($RootDir) {
    $dir = Join-Path $RootDir $VENDOR_NAME
    if (Test-Path (Join-Path $dir "package.json")) {
        Write-Ok "$VENDOR_NAME source jah existe. Seguindo."
        try {
            # Tenta atualizar por git se tiver disponivel; se nao, ignora.
            Push-Location $dir
            $hasGit = Test-Cmd "git"
            if ($hasGit -and (Test-Path ".git")) {
                git fetch --depth 1 origin 2>$null | Out-Null
                git reset --hard "origin/$VENDOR_BRANCH" 2>$null | Out-Null
            }
            Pop-Location
        } catch {}
        return $true
    }

    # Tenta git clone rapido se tiver git
    if (Test-Cmd "git") {
        Write-Step "Baixando $VENDOR_NAME via git clone..."
        try {
            git clone --depth 1 --branch $VENDOR_BRANCH "https://github.com/$VENDOR_GITHUB.git" $dir 2>&1 | Out-Null
            if (Test-Path (Join-Path $dir "package.json")) { Write-Ok "$VENDOR_NAME clonado via git"; return $true }
        } catch {
            Write-Warn "git clone falhou. Tentando download zip..."
            if (Test-Path $dir) { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }
        }
    }

    Write-Step "Baixando $VENDOR_NAME (zip direto via GitHub, sem GIT nenhum)..."
    $zipUrl = "https://github.com/$VENDOR_GITHUB/archive/refs/heads/$VENDOR_BRANCH.zip"
    $staging = Join-Path $env:TEMP "$VENDOR_NAME-staging"
    if (-not (Get-ZipAndExtract $zipUrl $staging)) {
        Write-Fail "Download zip do $VENDOR_NAME falhou."
        return $false
    }
    $actual = Find-RootFolder $staging @("package.json","tsconfig.json","scripts")
    if (-not (Test-Path (Join-Path $actual "package.json"))) {
        Write-Fail "Zip do $VENDOR_NAME sem package.json."
        return $false
    }
    New-Item -ItemType Directory -Path (Split-Path $dir -Parent) -Force | Out-Null
    Move-Item -LiteralPath $actual -Destination $dir -Force
    if (-not (Test-Path (Join-Path $dir "package.json"))) {
        Write-Fail "$VENDOR_NAME nao foi movido corretamente."
        return $false
    }
    Write-Ok "$VENDOR_NAME baixado via zip."
    return $true
}

# =============================================================================
# 4) Plugin sources (local OU GitHub)
# =============================================================================
function EnsurePluginSources($RootDir) {
    $local = (Test-Path (Join-Path $RootDir "index.tsx")) -and (Test-Path (Join-Path $RootDir "manifest.json"))
    if ([string]::IsNullOrWhiteSpace($PLUGIN_GITHUB) -and $local) {
        Write-Ok "MODO LOCAL: usando arquivos do plugin da pasta atual."
        return $true
    }
    if ([string]::IsNullOrWhiteSpace($PLUGIN_GITHUB) -and -not $local) {
        Write-Fail "PLUGIN_GITHUB esta vazio (MODO LOCAL) mas nao encontrei index.tsx nem manifest.json aqui. Mova esse instalador para a pasta do plugin, ou preencha PLUGIN_GITHUB no topo do arquivo."
        return $false
    }

    # GitHub mode
    if ($local) {
        Write-Ok "MODO LOCAL (GITHUB preenchido, mas a pasta jah tem arquivos; usando locais)."
        return $true
    }

    $cache = Join-Path $RootDir ".installer-cache"
    $hasGit = Test-Cmd "git"
    if ($hasGit -and (Test-Path (Join-Path $cache ".git"))) {
        Write-Step "Atualizando plugin via git pull..."
        try {
            Push-Location $cache
            git fetch --depth 1 origin 2>$null | Out-Null
            git reset --hard "origin/$PLUGIN_BRANCH" 2>$null | Out-Null
            Pop-Location
        } catch { Pop-Location }
    } else {
        if (Test-Path $cache) { Remove-Item -Recurse -Force $cache -ErrorAction SilentlyContinue }
        if (Test-Cmd "git") {
            Write-Step "Baixando plugin via git clone https://github.com/$PLUGIN_GITHUB ..."
            try {
                git clone --depth 1 --branch $PLUGIN_BRANCH "https://github.com/$PLUGIN_GITHUB.git" $cache 2>&1 | Out-Null
            } catch {}
        }
        if (-not (Test-Path (Join-Path $cache "index.tsx"))) {
            Write-Step "Baixando plugin via zip GitHub..."
            if (Test-Path $cache) { Remove-Item -Recurse -Force $cache -ErrorAction SilentlyContinue }
            $staging = Join-Path $env:TEMP "plugin-staging"
            $zip = "https://github.com/$PLUGIN_GITHUB/archive/refs/heads/$PLUGIN_BRANCH.zip"
            if (-not (Get-ZipAndExtract $zip $staging)) {
                Write-Fail "Nao consegui baixar plugin nem via git nem via zip. Confira PLUGIN_GITHUB = '$PLUGIN_GITHUB'"
                return $false
            }
            $actual = Find-RootFolder $staging @("index.tsx","manifest.json","native.ts","presence.ts")
            New-Item -ItemType Directory -Path (Split-Path $cache -Parent) -Force | Out-Null
            Move-Item -LiteralPath $actual -Destination $cache -Force
        }
    }
    $src = $cache
    foreach ($sub in @("src","src/lefferzinbypass","plugin","src/plugin","src/userplugins/$PLUGIN_FOLDER","LefferzinBypass")) {
        if (Test-Path (Join-Path (Join-Path $cache $sub) "index.tsx")) { $src = Join-Path $cache $sub; break }
    }
    if (-not (Test-Path (Join-Path $src "index.tsx"))) {
        Write-Fail "Plugin baixado mas pasta raiz sem index.tsx. Organize o repo."
        return $false
    }

    Write-Step "Copiando arquivos baixados do GitHub para a pasta do instalador..."
    foreach ($f in @("index.tsx","native.ts","presence.ts","stability.ts","manifest.json","vpn-controller.ts","vpn-proton.ts","vpn-types.ts","vpn-windows.ts")) {
        $s = Join-Path $src $f
        if (Test-Path $s) { Copy-Item $s (Join-Path $RootDir $f) -Force }
    }
    $bin = Join-Path $src "bin\win32-x64\$PROTONCONFGEN_NAME"
    if (Test-Path $bin) {
        $dst = Join-Path $RootDir "bin\win32-x64"
        New-Item -ItemType Directory -Path $dst -Force | Out-Null
        Copy-Item $bin (Join-Path $dst $PROTONCONFGEN_NAME) -Force
    }
    Write-Ok "Plugin baixado via GitHub."
    return $true
}

# =============================================================================
# 5) Copia plugin dentro do userplugins do vendor
# =============================================================================
function Copy-PluginIntoVendor($RootDir) {
    $target = Join-Path (Join-Path (Join-Path $RootDir $VENDOR_NAME) "src\userplugins") $PLUGIN_FOLDER
    $binDir = Join-Path $target "bin\win32-x64"
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    $files = @("index.tsx","native.ts","presence.ts","stability.ts","manifest.json","vpn-controller.ts","vpn-proton.ts","vpn-types.ts","vpn-windows.ts")
    foreach ($f in $files) {
        $s = Join-Path $RootDir $f
        if (-not (Test-Path $s)) { Write-Fail "Arquivo faltando na pasta do plugin: $f"; return $false }
        Copy-Item $s (Join-Path $target $f) -Force
    }
    $binSource = Join-Path $RootDir "bin\win32-x64\$PROTONCONFGEN_NAME"
    if (-not (Test-Path $binSource) -and -not [string]::IsNullOrWhiteSpace($PLUGIN_GITHUB)) {
        Write-Warn "bin/win32-x64/$PROTONCONFGEN_NAME nao existe na pasta local. Tentando baixar do GitHub Releases do plugin..."
        $u = "https://github.com/$PLUGIN_GITHUB/releases/latest/download/proton-confgen-win32-x64.exe"
        New-Item -ItemType Directory -Path (Split-Path $binSource -Parent) -Force | Out-Null
        Get-File $u $binSource | Out-Null
    }
    if (Test-Path $binSource) {
        Copy-Item $binSource (Join-Path $binDir $PROTONCONFGEN_NAME) -Force
    } else {
        Write-Warn "Ainda nao tenho o $PROTONCONFGEN_NAME. O build vai funcionar, mas logar na Proton vai falhar ate esse exe existir."
    }
    Write-Ok "Arquivos copiados para $VENDOR_NAME/src/userplugins/$PLUGIN_FOLDER"
    return $true
}

# =============================================================================
# 6) Builda vendor
# =============================================================================
function BuildVendor($RootDir) {
    $dir = Join-Path $RootDir $VENDOR_NAME
    Push-Location $dir
    $env:CI = "true"
    try {
        $pnpmInstallLog = Join-Path $env:TEMP "pnpm-install-facil.log"
        Write-Step "Instalando dependencias do $VENDOR_NAME (pnpm install)..."
        $installed = $false
        if (Test-Cmd "pnpm.cmd") {
            try {
                $r = Start-Process -FilePath "pnpm.cmd" -ArgumentList "install","--no-frozen-lockfile" -NoNewWindow -Wait -PassThru -RedirectStandardOutput $pnpmInstallLog -RedirectStandardError "$pnpmInstallLog.err"
                if ($r.ExitCode -eq 0 -or $r.ExitCode -eq $null) { $installed = $true }
            } catch {}
        }
        if (-not $installed) {
            try { & pnpm install --no-frozen-lockfile 2>&1 | Out-Null ; if ($LASTEXITCODE -eq 0) { $installed = $true } } catch {}
        }
        if (-not $installed) {
            Write-Fail "pnpm install falhou. Ultimas linhas do log:"
            if (Test-Path $pnpmInstallLog) {
                Get-Content $pnpmInstallLog -Tail 20 | ForEach-Object { Write-Host "   $_" }
            }
            if (Test-Path "$pnpmInstallLog.err") {
                Write-Host "   --- stderr ---"
                Get-Content "$pnpmInstallLog.err" -Tail 15 | ForEach-Object { Write-Host "   $_" }
            }
            Pop-Location
            return $false
        }
        Write-Ok "Dependencias OK."

        Write-Step "Buildando $VENDOR_NAME (pnpm build)..."
        & pnpm build
        if ($LASTEXITCODE -ne 0) {
            Write-Fail "pnpm build falhou (codigo $LASTEXITCODE). Leia o log acima."
            Pop-Location
            return $false
        }

        $vendorDir = Get-Location
        $rendererDesktop = Join-Path $vendorDir "dist\desktop\renderer.js"
        $asarDesktop = Join-Path $vendorDir "dist\desktop.asar"
        $pluginMarker = "LefferzinBypass"
        $pluginBundled = $false
        if (Test-Path $rendererDesktop) {
            try {
                $markerOk = Select-String -Path $rendererDesktop -Pattern $pluginMarker -List -Quiet -ErrorAction SilentlyContinue
                if ($markerOk) { $pluginBundled = $true }
            } catch {}
        }
        $asarOk = (Test-Path $asarDesktop) -and ((Get-Item $asarDesktop).Length -gt 2MB)
        if ($pluginBundled -and $asarOk) {
            Write-Ok "Build verificado: plugin '$pluginMarker' esta no renderer.js ($([math]::Round((Get-Item $rendererDesktop).Length / 1MB, 1))MB) + desktop.asar criado ($([math]::Round((Get-Item $asarDesktop).Length / 1MB, 1))MB)."
        } else {
            Write-Fail "Build VERIFICACAO FALHOU."
            if (-not $asarOk) {
                if (-not (Test-Path $asarDesktop)) { Write-Host "   - $asarDesktop NAO foi criado (esperava .asar > 2MB, ou ele vai injetar build velho!)" }
                else { Write-Host "   - $asarDesktop muito pequeno ($([math]::Round((Get-Item $asarDesktop).Length / 1KB, 0))KB)." }
            }
            if (-not $pluginBundled) {
                Write-Host "   - Plugin '$pluginMarker' NAO foi encontrado DENTRO de $rendererDesktop."
                Write-Host "   Isso significa que o build NAO pegou o userplugins (plugin foi compilado FORA do bundle. Causas comuns:"
                Write-Host "     1. Pasta src/userplugins/$PLUGIN_FOLDER do vendor nao tem o index.tsx com definePlugin(name = primeira propriedade)."
                Write-Host "     2. regex resolvePluginName rejeitou (nome com erro de sintaxe no comeco do index.tsx)."
                Write-Host "     3. A anotacao @type ou comentario multilinha antes do definePlugin() fez a regex PluginDefinitionNameMatcher falhar."
                if (Test-Path $rendererDesktop) {
                    Write-Host "   --- Buscando plugins de userplugins que FORAM incluidos..."
                    $achados = Select-String -Path $rendererDesktop -Pattern 'userPlugin":true' -AllMatches -ErrorAction SilentlyContinue
                    if ($achados -and $achados.Count -gt 0) { Write-Host "   Encontrados $($achados.Count) userplugins bundled." }
                    else { Write-Host "   NENHUM userplugin foi encontrado. Verifique se a pasta src/userplugins do vendor existe e tem arquivos." }
                }
            }
            Pop-Location
            return $false
        }

        Write-Step "Copiando $PROTONCONFGEN_NAME para pastas dist/..."
        $binSource = Join-Path $RootDir "bin\win32-x64\$PROTONCONFGEN_NAME"
        if (Test-Path $binSource) {
            foreach ($sub in @("dist\desktop\bin\win32-x64","dist\equibop\bin\win32-x64","dist\_userplugins\$PLUGIN_FOLDER\bin\win32-x64")) {
                $d = Join-Path $dir $sub
                New-Item -ItemType Directory -Path $d -Force | Out-Null
                Copy-Item $binSource (Join-Path $d $PROTONCONFGEN_NAME) -Force
            }
            Write-Ok "exe copiado para dist."
        }
    } finally {
        Pop-Location
    }
    return $true
}

# =============================================================================
# 7) Detecta Discord / instala se precisar
# =============================================================================
function DetectOrInstallDiscord() {
    $branches = @(
        @{ Name = "stable"; Exe = "Discord.exe";     Path = "%LOCALAPPDATA%\Discord\Update.exe" },
        @{ Name = "canary"; Exe = "DiscordCanary.exe";Path = "%LOCALAPPDATA%\DiscordCanary\Update.exe" },
        @{ Name = "ptb";    Exe = "DiscordPTB.exe";   Path = "%LOCALAPPDATA%\DiscordPTB\Update.exe" }
    )
    $found = @()
    $chosen = $null
    foreach ($b in $branches) {
        $full = [Environment]::ExpandEnvironmentVariables($b.Path)
        if (Test-Path $full) {
            $found += $b.Name
            if ($null -eq $chosen) { $chosen = $b.Name; $chosenExe = $b.Exe }
        }
    }
    if ($found.Count -gt 0) {
        Write-Ok "Discord(s) detectado(s): $($found -join ', '). Usando: $chosen"
        return $chosen
    }

    Write-Warn "Nenhum Discord detectado. Vou baixar e abrir o instalador Discord Stable."
    $inst = Join-Path $env:TEMP "DiscordSetup.exe"
    if (-not (Get-File "https://discord.com/api/downloads/distributions/app/installers/latest?channel=stable&platform=win&arch=x86" $inst)) {
        if (-not (Get-File "https://dl.discordapp.net/apps/win/1.0.9035/DiscordSetup.exe" $inst)) {
            Write-Fail "Nao consegui baixar Discord. Instale manual: https://discord.com/download e rode o instalador de novo."
            return $null
        }
    }
    Write-Step "Abrindo DiscordSetup.exe (instale Next Next Next)... Depois reabra esse instalador."
    Start-Process $inst
    Stop-Wait
    return $null
}

# =============================================================================
# 8) Inject usando o vendor installer
# =============================================================================
function DoInject($RootDir, $Branch) {
    $dir = Join-Path $RootDir $VENDOR_NAME
    Push-Location $dir
    try {
        Write-Step "Fechando Discord e Update.exe (incluindo arvore de processos)..."
        $killTargets = @("Discord","DiscordCanary","DiscordPTB","Update")
        foreach ($name in $killTargets) {
            try { & taskkill.exe /F /T /IM "$name.exe" 2>&1 | Out-Null } catch {}
        }
        Start-Sleep -Seconds 3
        foreach ($name in $killTargets) {
            try { & taskkill.exe /F /T /IM "$name.exe" 2>&1 | Out-Null } catch {}
        }
        Start-Sleep -Seconds 2
        $procsAlive = @()
        foreach ($name in $killTargets) {
            $p = Get-Process -Name $name -ErrorAction SilentlyContinue
            if ($p) { $procsAlive += $name }
        }
        if ($procsAlive.Count -gt 0) {
            Write-Warn "Processos ainda vivos apos 2 passos: $($procsAlive -join ', '). Vou tentar mais uma vez..."
            foreach ($name in $killTargets) {
                try { & taskkill.exe /F /T /IM "$name.exe" 2>&1 | Out-Null } catch {}
            }
            Start-Sleep -Seconds 3
        }

        $installer = Join-Path (Get-Location) "scripts\runInstaller.mjs"
        if (-not (Test-Path $installer)) {
            Write-Fail "Installer do vendor nao encontrado: $installer"
            Pop-Location
            return $false
        }
        Write-Step "Injetando $VENDOR_NAME em Discord $Branch (Nao vai abrir Discord automaticamente no final)..."
        & node $installer -- -install -branch $Branch -no-open 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Step "Installer rejeitou flag -no-open. Tentando novamente sem a flag (pode abrir Discord no final)..."
            & node $installer -- -install -branch $Branch 2>&1
        }
        if ($LASTEXITCODE -ne 0) {
            Write-Fail "Installer retornou $LASTEXITCODE. Feche o Discord completamente (botao direito na bandeja -> Sair) ou reinicie o PC e rode de novo."
            Pop-Location
            return $false
        }
        Write-Ok "Inject OK. Discord NAO sera aberto automaticamente (previne loop fechar/abrir)."
        foreach ($name in $killTargets) {
            try { & taskkill.exe /F /T /IM "$name.exe" 2>&1 | Out-Null } catch {}
        }
        return $true
    } finally {
        Pop-Location
    }
}

# =============================================================================
# MAIN
# =============================================================================
Clear-Host
Write-Host ""
Write-Host "======================== GoLiveBypass ($VENDOR_NAME) ========================" -ForegroundColor Magenta
Write-Host "  Instalador zero-dependencia: sem Node, sem Git, sem admin." -ForegroundColor Magenta
Write-Host "  Baixa tudo automatico: Node portatil, pnpm standalone, $VENDOR_NAME zip, plugin." -ForegroundColor Magenta
Write-Host "=========================================================================" -ForegroundColor Magenta
Write-Host ""

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RootDir
[Environment]::CurrentDirectory = $RootDir

if (-not (EnsureNodePortable)) { Stop-Wait ; exit 1 }
if (-not (EnsurePnpmPortable))  { Stop-Wait ; exit 1 }

Write-Step "Configurando plugin (fontes do Leffer Bypass)..."
if (-not (EnsurePluginSources $RootDir)) { Stop-Wait ; exit 1 }

Write-Step "Baixando/configurando $VENDOR_NAME..."
if (-not (EnsureVendorSource $RootDir)) { Stop-Wait ; exit 1 }

Write-Step "Copiando plugin para dentro do userplugins do $VENDOR_NAME..."
if (-not (Copy-PluginIntoVendor $RootDir)) { Stop-Wait ; exit 1 }

Write-Step "Buildando..."
if (-not (BuildVendor $RootDir)) { Stop-Wait ; exit 1 }

Write-Step "Verificando Discord..."
$branch = DetectOrInstallDiscord
if ([string]::IsNullOrWhiteSpace($branch)) { Stop-Wait ; exit 0 }

if (-not (DoInject $RootDir $branch)) { Stop-Wait ; exit 1 }

Write-Host ""
Write-Host "=============================== PRONTO! ===============================" -ForegroundColor Green
Write-Host "  GoLiveBypass + $VENDOR_NAME instalados no Discord $branch." -ForegroundColor Green
Write-Host ""
Write-Host "  Para ligar o bypass (ABRA O DISCORD MANUALMENTE AGORA):" -ForegroundColor Cyan
Write-Host "   1. Abra o Discord (NAO VAI ABRIR SOZINHO - assim evita loop)."
Write-Host "   2. Configuracoes => Plugins => GoLiveBypass (vem ativado padrao)."
Write-Host "   3. Usuario/senha Proton => Logar => Otimizar rotas => Ativar."
Write-Host ""
Write-Host "  Presence aparece automaticamente no perfil com a foto 'leffer-bypass'."
Write-Host "  Se aparecer 'desktop nao carregado' => reinicie o Discord 1 vez."
Write-Host "=======================================================================" -ForegroundColor Green
Write-Host ""
Stop-Wait
