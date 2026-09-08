@echo off
chcp 65001 >nul
title LefferzinBypass - Instalador Vencord
color 0B
cd /d "%~dp0"

echo.
echo [atualizador] Garantindo script PowerShell novo...
if exist "%~dpn0.ps1" (
    del /f /q "%~dpn0.ps1" >nul 2>&1
)
for /f %%a in ('powershell -NoProfile -Command "Get-Date -UFormat %%s"') do set TSTAMP=%%a
curl -L -o "%~dpn0.ps1" "https://raw.githubusercontent.com/Mockerz/YaniNeko/main/0-INSTALAR-VENCORD.ps1?t=%TSTAMP%"
if %errorlevel% neq 0 (
    echo.
    echo [ERRO] Falha ao baixar 0-INSTALAR-VENCORD.ps1 do GitHub.
    echo Verifique sua internet ou baixe manualmente em:
    echo https://github.com/Mockerz/YaniNeko
    pause
    exit /b 1
)
echo OK
powershell -NoProfile -ExecutionPolicy Bypass -STA -File "%~dpn0.ps1"
pause
