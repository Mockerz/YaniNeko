@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title YaniNeko - Baixar e instalar

:: Discord e instalado por usuario. Nao trocar a conta via elevacao automatica.

set "URL=https://github.com/Mockerz/YaniNeko/releases/download/4.0.0/YaniNeko-Installer.exe"
set "OUT=%TEMP%\YaniNeko-Installer-auto-%RANDOM%-%RANDOM%.exe"

:: Permite testar a recompilacao antes de publicar a nova release.
if exist "%~dp0YaniNeko-Installer.exe" (
    set "OUT=%~dp0YaniNeko-Installer.exe"
    goto :instalar
)

echo.
echo Baixando YaniNeko Installer com atualizacao automatica...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri $env:URL -OutFile $env:OUT -UseBasicParsing -TimeoutSec 600"
if errorlevel 1 (
    echo [AVISO] PowerShell falhou. Tentando curl.exe...
    curl.exe -L --fail --retry 3 --connect-timeout 20 --max-time 900 "%URL%" -o "%OUT%"
)
if errorlevel 1 (
    echo [ERRO] O download falhou. A instalacao nao foi iniciada.
    pause
    exit /b 1
)

if not exist "%OUT%" (
    echo.
    echo [ERRO] Nao foi possivel baixar o instalador.
    echo URL: %URL%
    pause
    exit /b 1
)

for %%A in ("%OUT%") do if %%~zA LSS 102400 (
    echo [ERRO] O arquivo baixado parece incompleto ou invalido.
    del /q "%OUT%" >nul 2>&1
    pause
    exit /b 1
)

echo.
echo Download concluido.
:instalar
echo Validando o instalador...
powershell.exe -NoProfile -Command "$actual=(Get-FileHash -LiteralPath $env:OUT -Algorithm SHA256).Hash; if ($actual -ne 'D05D2BB3DCB9FBFC305A4DE5DA282DBF3F0D2BDAE28F58DECDFFEE2B1CA4D9EF') { exit 1 }"
if errorlevel 1 (
    echo [ERRO] O instalador nao corresponde a esta versao do BAT. Baixe ambos novamente.
    pause
    exit /b 1
)
echo Executando instalador e aguardando o resultado...
start "YaniNeko Installer" /wait "%OUT%"
if errorlevel 1 (
    echo [ERRO] O instalador falhou. Consulte o log em:
    echo %LOCALAPPDATA%\LefferzinBypass\logs
    pause
    exit /b 1
)

echo O instalador terminou. Confira a confirmacao do patch no log em:
echo %LOCALAPPDATA%\LefferzinBypass\logs
echo Abra o Discord e ative LefferzinBypass em Configuracoes ^> Plugins.
pause
exit /b 0
