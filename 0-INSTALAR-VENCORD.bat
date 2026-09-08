@echo off
chcp 65001 >nul
title LefferzinBypass - Instalador Vencord
color 0B
cd /d "%~dp0"

echo.
echo [atualizador] Baixando PowerShell atualizado (com fallback local)...
set "PS1_TMP=%~dpn0.ps1.download"
set "PS1_RAW=%~dpn0.ps1.raw"
if exist "%PS1_TMP%" del /f /q "%PS1_TMP%" >nul 2>&1
if exist "%PS1_RAW%" del /f /q "%PS1_RAW%" >nul 2>&1
for /f %%a in ('powershell -NoProfile -Command "Get-Date -UFormat %%s"') do set TSTAMP=%%a
curl -L --fail --silent --show-error -o "%PS1_RAW%" "https://raw.githubusercontent.com/Mockerz/YaniNeko/main/0-INSTALAR-VENCORD.ps1?t=%TSTAMP%"
if %errorlevel% equ 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = Get-Content -Raw -LiteralPath '%PS1_RAW%'; [System.IO.File]::WriteAllText('%PS1_TMP%', $s, (New-Object System.Text.UTF8Encoding($true)))"
    if errorlevel 1 (
        echo [ERRO] Falha ao preparar o PowerShell em UTF-8.
        del /f /q "%PS1_RAW%" >nul 2>&1
        del /f /q "%PS1_TMP%" >nul 2>&1
        if not exist "%~dpn0.ps1" exit /b 1
    ) else (
        move /y "%PS1_TMP%" "%~dpn0.ps1" >nul
        del /f /q "%PS1_RAW%" >nul 2>&1
    )
    echo OK
) else if exist "%~dpn0.ps1" (
    echo [AVISO] Nao foi possivel atualizar; usando o instalador local.
) else (
    echo.
    echo [ERRO] Falha ao baixar instalador do GitHub.
    echo Verifique sua internet ou baixe manualmente em:
    echo https://github.com/Mockerz/YaniNeko
    pause
    exit /b 1
)

echo.
echo Tudo sera baixado/instalado na MESMA pasta do instalador:
echo    %cd%
echo.

powershell -NoProfile -ExecutionPolicy Bypass -STA -File "%~dpn0.ps1"
