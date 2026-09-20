@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title YaniNeko - Diagnostico
set "YANINEKO_DIAG_SELF=%~f0"
echo Gerando diagnostico. Nenhuma instalacao sera alterada.
echo Execute na mesma conta do Windows que usa o Discord.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$f=[IO.File]::ReadAllText($env:YANINEKO_DIAG_SELF); $marker='# POWERSHELL_DIAGNOSTICO'; $pos=$f.LastIndexOf($marker); & ([scriptblock]::Create($f.Substring($pos+$marker.Length)))"
set "DIAG_EXIT=%ERRORLEVEL%"
if not "%DIAG_EXIT%"=="0" echo [ERRO] Nao foi possivel concluir o relatorio.
echo.
pause
exit /b %DIAG_EXIT%
# POWERSHELL_DIAGNOSTICO
$ErrorActionPreference = 'Stop'
$report = New-Object 'System.Collections.Generic.List[string]'
function Add-Line([string]$text = '') { $report.Add($text) }
function Section([string]$name, [scriptblock]$action) {
    Add-Line "`r`n===== $name ====="
    try { & $action } catch { Add-Line ('ERRO: ' + $_.Exception.Message) }
}
function Read-Tail([string]$path, [int]$count = 120) {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        Get-Content -LiteralPath $path -Tail $count -Encoding UTF8 | ForEach-Object { Add-Line $_ }
    } else { Add-Line "Ausente: $path" }
}
$root = Join-Path $env:LOCALAPPDATA 'LefferzinBypass'
$vencord = Join-Path $root 'Vencord'
$dist = Join-Path $vencord 'dist'
Add-Line 'YaniNeko - Diagnostico somente leitura v1'
Add-Line ('Data: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'))
Section 'Windows e conta' {
    Add-Line ('Windows: ' + [Environment]::OSVersion.VersionString)
    Add-Line ('Windows 64 bits: ' + [Environment]::Is64BitOperatingSystem)
    Add-Line ('Processo 64 bits: ' + [Environment]::Is64BitProcess)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    Add-Line ('Conta: ' + $identity.Name)
    Add-Line ('Administrador: ' + $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
    Add-Line ('LOCALAPPDATA: ' + $env:LOCALAPPDATA)
    Add-Line ('APPDATA: ' + $env:APPDATA)
    Add-Line ('Raiz do instalador: ' + $root)
}
Section 'Ferramentas e caminhos' {
    foreach ($name in @('git', 'node', 'corepack', 'pnpm')) {
        $commands = @(Get-Command $name -CommandType Application -All -ErrorAction SilentlyContinue)
        if ($commands.Count -eq 0) { Add-Line "$name : nao encontrado no PATH" }
        foreach ($command in $commands) { Add-Line ($name + ' : ' + $command.Source) }
        # pnpm/corepack podem baixar pacotes ate para --version; apenas localizamos esses arquivos.
        if ($commands.Count -gt 0 -and $name -in @('git', 'node')) {
            & $commands[0].Source --version 2>&1 | ForEach-Object { Add-Line "  $_" }
        }
    }
    foreach ($name in @('COREPACK_HOME', 'VENCORD_USER_DATA_DIR', 'VENCORD_DEV_INSTALL', 'DISCORD_USER_DATA_DIR')) {
        Add-Line ($name + ' = ' + [Environment]::GetEnvironmentVariable($name))
    }
    foreach ($relative in @('tools\corepack-bin', 'tools\corepack', 'tools\node')) {
        $path = Join-Path $root $relative
        Add-Line ("$path : " + (Test-Path -LiteralPath $path))
        if (Test-Path -LiteralPath $path) {
            Get-ChildItem -LiteralPath $path | Select-Object -First 15 | ForEach-Object { Add-Line ('  ' + $_.Name) }
        }
    }
}
Section 'Processos do Discord' {
    $processes = @(Get-Process -Name Discord,DiscordPTB,DiscordCanary -ErrorAction SilentlyContinue)
    if ($processes.Count -eq 0) { Add-Line 'Nenhum Discord aberto.' }
    foreach ($process in $processes) {
        Add-Line ($process.ProcessName + ' PID=' + $process.Id + ' Caminho=' + $process.Path)
    }
}
Section 'Build do Vencord e plugin' {
    foreach ($name in @('patcher.js', 'preload.js', 'renderer.js', 'Installer\VencordInstallerCli.exe', 'desktop\bin\win32-x64\proton-confgen.exe')) {
        $path = Join-Path $dist $name
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            $file = Get-Item -LiteralPath $path
            Add-Line ($name + ' : ' + $file.Length + ' bytes; ' + $file.LastWriteTime.ToString('s'))
        } else { Add-Line ('AUSENTE: ' + $path) }
    }
    $renderer = Join-Path $dist 'renderer.js'
    if (Test-Path -LiteralPath $renderer) {
        Add-Line ('LefferzinBypass no renderer: ' + ([IO.File]::ReadAllText($renderer).Contains('LefferzinBypass')))
    }
    $package = Join-Path $vencord 'package.json'
    if (Test-Path -LiteralPath $package) {
        $data = Get-Content -LiteralPath $package -Raw | ConvertFrom-Json
        Add-Line ('packageManager exigido: ' + $data.packageManager)
        Add-Line ('Node exigido: ' + $data.engines.node)
    }
}
Section 'Instalacoes e patch do Discord' {
    foreach ($channel in @('Discord', 'DiscordPTB', 'DiscordCanary')) {
        $base = Join-Path $env:LOCALAPPDATA $channel
        Add-Line ("$channel : $base")
        if (-not (Test-Path -LiteralPath $base)) { Add-Line '  Nao encontrado.'; continue }
        $apps = @(Get-ChildItem -LiteralPath $base -Directory -Filter 'app-*' | Sort-Object Name)
        if ($apps.Count -eq 0) { Add-Line '  Nenhuma pasta app-* encontrada.' }
        foreach ($app in $apps) {
            Add-Line ('  Versao: ' + $app.Name)
            Add-Line ('  Discord.exe presente: ' + (Test-Path -LiteralPath (Join-Path $app.FullName 'Discord.exe')))
            foreach ($name in @('app.asar', '_app.asar')) {
                $archive = Join-Path $app.FullName ('resources\' + $name)
                if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { Add-Line ('  Ausente: ' + $archive); continue }
                $file = Get-Item -LiteralPath $archive
                Add-Line ('  ' + $name + ': ' + $file.Length + ' bytes; ' + $file.LastWriteTime.ToString('s'))
                if ($name -eq 'app.asar') {
                    $stream = [IO.File]::OpenRead($archive)
                    try {
                        $buffer = New-Object byte[] 65536
                        $count = $stream.Read($buffer, 0, $buffer.Length)
                        $text = [Text.Encoding]::UTF8.GetString($buffer, 0, $count)
                    } finally { $stream.Dispose() }
                    $match = [regex]::Match($text, 'require\(("(?:\\.|[^"\\])*")\)')
                    if ($match.Success) {
                        $target = ConvertFrom-Json -InputObject $match.Groups[1].Value
                        Add-Line ('  Loader require: ' + $target)
                        if ([IO.Path]::IsPathRooted($target)) {
                            Add-Line ('  Destino existe: ' + (Test-Path -LiteralPath $target -PathType Leaf))
                            Add-Line ('  Aponta para este build: ' + ($target -ieq (Join-Path $dist 'patcher.js')))
                        }
                    } else { Add-Line '  Loader do Vencord nao identificado nos primeiros 64 KB.' }
                }
            }
        }
    }
}
Section 'Ultimos 3 logs do instalador (120 linhas cada)' {
    $logs = Join-Path $root 'logs'
    if (Test-Path -LiteralPath $logs) {
        Get-ChildItem -LiteralPath $logs -Filter 'install*.log' -File |
            Sort-Object LastWriteTime -Descending | Select-Object -First 3 | ForEach-Object {
                Add-Line ('--- ' + $_.FullName + ' ---')
                Read-Tail $_.FullName
            }
    } else { Add-Line 'Pasta de logs ausente.' }
}
Section 'EXE ao lado do BAT' {
    $exe = Join-Path (Split-Path -Parent $env:YANINEKO_DIAG_SELF) 'YaniNeko-Installer.exe'
    if (Test-Path -LiteralPath $exe -PathType Leaf) {
        $file = Get-Item -LiteralPath $exe
        Add-Line ('Arquivo: ' + $exe)
        Add-Line ('Tamanho: ' + $file.Length + '; Data: ' + $file.LastWriteTime.ToString('s'))
        Add-Line ('SHA256: ' + (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash)
    } else { Add-Line 'Nao ha YaniNeko-Installer.exe ao lado deste BAT.' }
}
$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop) { $desktop = $env:TEMP }
$filename = 'Diagnostico-YaniNeko-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt'
$output = Join-Path $desktop $filename
try { [IO.File]::WriteAllLines($output, $report, [Text.UTF8Encoding]::new($true)) }
catch {
    $output = Join-Path $env:TEMP $filename
    [IO.File]::WriteAllLines($output, $report, [Text.UTF8Encoding]::new($true))
}
Write-Host "`nRelatorio salvo em: $output" -ForegroundColor Green
Write-Host 'Envie esse TXT para analisar o erro. Ele contem nome de usuario, caminhos e logs locais.'
