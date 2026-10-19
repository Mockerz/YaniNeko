@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title YaniNeko - Instalar arquivos locais
cd /d "%~dp0"

:: Usa o Python do ambiente de desenvolvimento quando disponivel.
set "LOCAL_PYTHON=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%LOCAL_PYTHON%" goto :python_local
py -3 --version >nul 2>&1
if not errorlevel 1 goto :python_launcher
echo [ERRO] Python 3 nao foi encontrado. Instale o Python para usar o instalador local.
pause
exit /b 1

:python_local
"%LOCAL_PYTHON%" "%~dp0instalar_local.py" --no-pause %*
goto :resultado

:python_launcher
py -3 "%~dp0instalar_local.py" --no-pause %*

:resultado
set "INSTALL_EXIT=%ERRORLEVEL%"
if not "%INSTALL_EXIT%"=="0" echo [ERRO] A instalacao local falhou. Confira o erro acima.
if "%INSTALL_EXIT%"=="0" echo Operacao local concluida.
pause
exit /b %INSTALL_EXIT%
