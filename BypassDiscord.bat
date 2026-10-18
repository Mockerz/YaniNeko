@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title YaniNeko - Baixar e instalar

:: Discord e instalado por usuario. Nao trocar a conta via elevacao automatica.

set "URL=https://github.com/Mockerz/YaniNeko/releases/download/4.0.0/YaniNeko-Installer.exe"
set "EXPECTED_RELEASE_SHA256=7E436C7A7DF2F6962BF0CAD66643C8D108BD4422C330D802EE356937DA6A6111"
set "EXPECTED_LOCAL_SHA256=FD3F65BE3A915F137CBD4451C8F37A62595278BDF8A214B00E0B02220B732F6B"
set "OUT=%TEMP%\YaniNeko-Installer-auto-%RANDOM%-%RANDOM%.exe"

:: Reaproveita o EXE local recém-compilado quando o hash corresponde.
if exist "%~dp0YaniNeko-Installer.exe" (
    set "LOCAL_INSTALLER=%~dp0YaniNeko-Installer.exe"
    call :validar_local
    if not errorlevel 1 goto :usar_local
    echo [INFO] Instalador local antigo ou diferente. Baixando a release 4.0.0.
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
powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; $actual=(Get-FileHash -LiteralPath $env:OUT -Algorithm SHA256).Hash; if ($actual -ne $env:EXPECTED_RELEASE_SHA256) { Write-Host ('Esperado: '+$env:EXPECTED_RELEASE_SHA256); Write-Host ('Recebido: '+$actual); exit 1 }"
if errorlevel 1 (
    echo [ERRO] O arquivo recebido da release 4.0.0 nao corresponde ao build esperado.
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
powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; $actual=(Get-FileHash -LiteralPath $env:LOCAL_INSTALLER -Algorithm SHA256).Hash; if ($actual -ne $env:EXPECTED_LOCAL_SHA256) { Write-Host ('Hash local esperado: '+$env:EXPECTED_LOCAL_SHA256); Write-Host ('Hash recebido: '+$actual); exit 1 }"
exit /b %errorlevel%

:usar_local
set "OUT=%LOCAL_INSTALLER%"
goto :instalar
