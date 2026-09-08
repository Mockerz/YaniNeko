@echo off
chcp 65001 >nul
title LefferzinBypass - Instalador Vencord
color 0B
cd /d "%~dp0"

if not exist "%~dpn0.ps1" (
    echo.
    echo [1-arquivo] Script PowerShell nao encontrado. Baixando do GitHub...
    curl -L -o "%~dpn0.ps1" "https://raw.githubusercontent.com/Mockerz/YaniNeko/main/0-INSTALAR-VENCORD.ps1"
    if %errorlevel% neq 0 (
        echo.
        echo [ERRO] Falha ao baixar 0-INSTALAR-VENCORD.ps1 do GitHub.
        echo Verifique sua internet ou baixe manualmente em:
        echo https://github.com/Mockerz/YaniNeko
        pause
        exit /b 1
    )
    echo OK
)

powershell -NoProfile -ExecutionPolicy Bypass -STA -File "%~dpn0.ps1"
pause