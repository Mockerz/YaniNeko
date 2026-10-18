@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title YaniNeko - Baixar e instalar

:: Discord e instalado por usuario. Nao trocar a conta via elevacao automatica.

set "URL=https://github.com/Mockerz/YaniNeko/releases/download/4.0.0/YaniNeko-Installer.exe"
set "EXPECTED_SHA256=D87587548DF398453FBE980357A903D9D7179E9C4D07A95B476974A1B508E582"
set "OUT=%TEMP%\YaniNeko-Installer-auto-%RANDOM%-%RANDOM%.exe"

:: Reaproveita o EXE local recem-compilado quando o hash corresponde.
if exist "%~dp0YaniNeko-Installer.exe" (
    set "LOCAL_INSTALLER=%~dp0YaniNeko-Installer.exe"
    call :validar_local
    if not errorlevel 1 goto :usar_local
    echo [INFO] Instalador local antigo ou diferente. Baixando a release 4.0.0.
)

echo.
echo Baixando YaniNeko Installer com atualizacao automatica...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; [void](Invoke-WebRequest -Uri $env:URL -OutFile $env:OUT -UseBasicParsing -TimeoutSec 600); if (-not (Test-Path -LiteralPath $env:OUT)) { throw 'O arquivo de download nao foi criado.' } } catch { Write-Error $_; exit 1 }"
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
powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; $actual=(Get-FileHash -LiteralPath $env:OUT -Algorithm SHA256).Hash; if ($actual -ne $env:EXPECTED_SHA256) { Write-Host ('Esperado: '+$env:EXPECTED_SHA256); Write-Host ('Recebido: '+$actual); exit 1 }"
if errorlevel 1 (
    echo [ERRO] O instalador nao corresponde ao hash deste build.
    echo Baixe o BAT atualizado. Nao e necessario mudar a versao 4.0.0.
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

:validar_local
powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; $actual=(Get-FileHash -LiteralPath $env:LOCAL_INSTALLER -Algorithm SHA256).Hash; if ($actual -ne $env:EXPECTED_SHA256) { Write-Host ('Esperado: '+$env:EXPECTED_SHA256); Write-Host ('Recebido: '+$actual); exit 1 }"
exit /b %errorlevel%

:usar_local
set "OUT=%LOCAL_INSTALLER%"
goto :instalar
