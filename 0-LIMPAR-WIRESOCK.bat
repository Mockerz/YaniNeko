@echo off
chcp 65001 >nul
title GoLiveBypass - Limpar WireSock antigo
color 0C

echo ======================================================
echo   GoLiveBypass - Parar e remover WireSock antigo
echo   (roda automaticamente como Administrador)
echo ======================================================
echo.

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Solicitando privilegios de Administrador...
    powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo Parando servicos WireSock se existirem...
sc stop wiresock-client-service >nul 2>&1
sc stop wiresock-pro-client-service >nul 2>&1
timeout /t 2 /nobreak >nul

echo Removendo servicos WireSock...
sc delete wiresock-client-service >nul 2>&1
sc delete wiresock-pro-client-service >nul 2>&1
timeout /t 2 /nobreak >nul

echo.
echo Verificando se ainda restaram servicos...
sc query wiresock-client-service 2>nul | findstr /i "exist" >nul
if %errorlevel% equ 0 (
    echo [AVISO] wiresock-client-service ainda existe. Reinicie o PC e rode este .bat novamente.
) else (
    echo [OK] wiresock-client-service removido.
)
sc query wiresock-pro-client-service 2>nul | findstr /i "exist" >nul
if %errorlevel% equ 0 (
    echo [AVISO] wiresock-pro-client-service ainda existe. Reinicie o PC e rode este .bat novamente.
) else (
    echo [OK] wiresock-pro-client-service removido.
)

echo.
echo ======================================================
echo   CONCLUIDO. Agora abra o Discord. O bypass deve
echo   ativar sozinho (se ja tiver logado no Proton).
echo ======================================================
echo.
pause
