@echo off
chcp 65001 >nul
title LefferzinBypass - Instalador Vencord
color 0B

set "WORKDIR=%TEMP%\LefferzinInstaller"
if exist "%WORKDIR%" (
    rmdir /s /q "%WORKDIR%" >nul 2>&1
)
mkdir "%WORKDIR%" >nul 2>&1
mkdir "%WORKDIR%\bin" >nul 2>&1
cd /d "%WORKDIR%"

echo.
echo [atualizador] Baixando PowerShell do instalador...
for /f %%a in ('powershell -NoProfile -Command "Get-Date -UFormat %%s"') do set TSTAMP=%%a
curl -L -o "%WORKDIR%\0-INSTALAR-VENCORD.ps1" "https://raw.githubusercontent.com/Mockerz/YaniNeko/main/0-INSTALAR-VENCORD.ps1?t=%TSTAMP%"
if %errorlevel% neq 0 (
    echo.
    echo [ERRO] Falha ao baixar instalador do GitHub.
    echo Verifique sua internet ou baixe manualmente em:
    echo https://github.com/Mockerz/YaniNeko
    pause
    exit /b 1
)
echo OK

echo.
echo Tudo vai rodar dentro de: %WORKDIR%
echo No final, essa pasta sera apagada automaticamente.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -STA -File "%WORKDIR%\0-INSTALAR-VENCORD.ps1"
set "EXIT_RC=%errorlevel%"

echo.
echo [limpeza] Apagando arquivos temporarios do instalador...
cd /d "%TEMP%"
rmdir /s /q "%WORKDIR%" >nul 2>&1

exit /b %EXIT_RC%
