@echo off
chcp 65001 >nul
title GoLiveBypass - Instalador FACIL (zero dependencias)
color 5F
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"

if not exist "0-INSTALADOR-FACIL.ps1" (
    echo [ERRO] 0-INSTALADOR-FACIL.ps1 nao encontrado na mesma pasta do bat.
    pause
    exit /b 1
)

set "PS_ARGS=-NoProfile -ExecutionPolicy Bypass -File "%~dp00-INSTALADOR-FACIL.ps1""
powershell.exe %PS_ARGS%
set "PS_RC=%ERRORLEVEL%"
if "%PS_RC%" neq "0" (
    echo.
    echo [ERRO] PowerShell retornou %PS_RC%. Leia o log acima.
    pause
    exit /b 1
)

echo.
echo [OK] Instalador finalizado.
pause
exit /b 0
