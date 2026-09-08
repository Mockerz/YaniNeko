@echo off
chcp 65001 >nul
set CI=true
title LefferzinBypass - Instalador Vencord
color 0B

echo ======================================================
echo   LefferzinBypass - Instalador Vencord
echo   (Build + Inject automatico)
echo ======================================================
echo.

cd /d "%~dp0"

where git >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERRO] Git nao encontrado. Instale o Git primeiro: https://git-scm.com
    pause
    exit /b 1
)

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERRO] Node.js nao encontrado. Instale o Node 18+: https://nodejs.org
    pause
    exit /b 1
)

where pnpm >nul 2>&1
if %errorlevel% neq 0 (
    echo [AVISO] pnpm nao encontrado. Instalando via corepack...
    call corepack enable >nul 2>&1
    call corepack prepare pnpm@latest --activate >nul 2>&1
    if %errorlevel% neq 0 (
        echo [ERRO] Nao consegui instalar o pnpm. Instale manualmente: npm install -g pnpm
        pause
        exit /b 1
    )
)

echo [1/7] Baixando/Atualizando Vencord...
if not exist "Vencord" (
    echo Clonando Vencord...
    git clone https://github.com/Vendicated/Vencord.git Vencord
    if %errorlevel% neq 0 (
        echo [ERRO] Falha ao clonar Vencord.
        pause
        exit /b 1
    )
) else (
    echo Vencord ja existe. Atualizando...
    cd Vencord
    git pull >nul 2>&1
    cd ..
)
echo OK
echo.

echo [2/7] Copiando plugin para userplugins do Vencord...
set "PLUGIN_DIR=Vencord\src\userplugins\LefferzinBypass"
if not exist "%PLUGIN_DIR%" mkdir "%PLUGIN_DIR%" >nul
if not exist "%PLUGIN_DIR%\bin\win32-x64" mkdir "%PLUGIN_DIR%\bin\win32-x64" >nul

copy /y index.tsx "%PLUGIN_DIR%\" >nul
if %errorlevel% neq 0 goto copyFail
copy /y manifest.json "%PLUGIN_DIR%\" >nul
if %errorlevel% neq 0 goto copyFail
copy /y native.ts "%PLUGIN_DIR%\" >nul
if %errorlevel% neq 0 goto copyFail
copy /y presence.ts "%PLUGIN_DIR%\" >nul
if %errorlevel% neq 0 goto copyFail
copy /y stability.ts "%PLUGIN_DIR%\" >nul
if %errorlevel% neq 0 goto copyFail
copy /y vpn-controller.ts "%PLUGIN_DIR%\" >nul
if %errorlevel% neq 0 goto copyFail
copy /y vpn-proton.ts "%PLUGIN_DIR%\" >nul
if %errorlevel% neq 0 goto copyFail
copy /y vpn-types.ts "%PLUGIN_DIR%\" >nul
if %errorlevel% neq 0 goto copyFail
copy /y vpn-windows.ts "%PLUGIN_DIR%\" >nul
if %errorlevel% neq 0 goto copyFail
copy /y "bin\win32-x64\proton-confgen.exe" "%PLUGIN_DIR%\bin\win32-x64\" >nul
if %errorlevel% neq 0 goto copyFail
echo OK
echo.
goto copyOk

:copyFail
echo [ERRO] Falha ao copiar arquivos do plugin.
pause
exit /b 1

:copyOk

cd Vencord

echo [3/7] Instalando dependencias do Vencord (pnpm install)...
echo Y | call pnpm install --no-frozen-lockfile >nul 2>&1
if %errorlevel% neq 0 (
    echo [AVISO] Falha na sincronia de dependencias, tentando continuar assim mesmo...
)
echo OK
echo.

echo [4/7] Compilando Vencord (pnpm build)...
call pnpm build
if %errorlevel% neq 0 (
    echo [ERRO] Falha no build do Vencord.
    pause
    exit /b 1
)
echo OK
echo.

echo [5/7] Verificando se o plugin foi incluido no build...
findstr /i /c:"LefferzinBypass" "dist\renderer.js" >nul 2>&1
if %errorlevel% neq 0 (
    echo [AVISO] Plugin nao encontrado no renderer.js. Tentando build userplugins...
    call pnpm build --scope userplugins >nul 2>&1
    findstr /i /c:"LefferzinBypass" "dist\renderer.js" >nul 2>&1
    if %errorlevel% neq 0 (
        echo [ERRO] Plugin nao foi compilado dentro do Vencord. Verifique os logs acima.
        pause
        exit /b 1
    )
)
echo [OK] Plugin confirmado no build.
echo.

echo [6/7] Copiando proton-confgen.exe para dist...
if not exist "dist\desktop\bin\win32-x64" mkdir "dist\desktop\bin\win32-x64" >nul 2>&1
copy /y "..\bin\win32-x64\proton-confgen.exe" "dist\desktop\bin\win32-x64\" >nul
if exist "dist\_userplugins\LefferzinBypass\bin\win32-x64" (
    copy /y "..\bin\win32-x64\proton-confgen.exe" "dist\_userplugins\LefferzinBypass\bin\win32-x64\" >nul
)
echo OK
echo.

echo [7/7] Matando Discord + Update.exe (para evitar bloqueio no app.asar)...
taskkill /F /IM Discord.exe /T >nul 2>&1
taskkill /F /IM Update.exe /T >nul 2>&1
timeout /t 3 /nobreak >nul
echo Processos encerrados.
echo.

echo Injetando Vencord no Discord Stable automaticamente...
call node scripts\runInstaller.mjs -- --install -branch stable
if %errorlevel% neq 0 (
    echo.
    echo [AVISO] Inject automatico falhou. Tentando com caminho customizado...
    if exist "%LOCALAPPDATA%\Discord" (
        call node scripts\runInstaller.mjs -- --install -branch stable -location "%LOCALAPPDATA%\Discord"
        if %errorlevel% neq 0 (
            echo.
            echo [AVISO] Inject com caminho fixo tambem falhou. Tentando abrir GUI...
            if exist "dist\Installer\VencordInstallerCli.exe" (
                start "" /WAIT "dist\Installer\VencordInstallerCli.exe" --install -branch stable
            ) else (
                echo [ERRO] Injector nao encontrado. Rode manualmente: pnpm inject
            )
        )
    ) else (
        echo [ERRO] Discord Stable nao encontrado em %%LOCALAPPDATA%%\Discord.
    )
)

cd ..

echo.
echo ======================================================
echo   INSTALACAO CONCLUIDA!
echo ======================================================
echo.
echo   Abra o Discord. O plugin LefferzinBypass vai aparecer
echo   em Configuracoes do Usuario  -  Plugins.
echo.
echo   1) No painel do plugin, logue sua conta ProtonVPN
echo   2) Clique em "Otimizar rotas" (ele reinicia o Discord)
echo   3) Pronto! O bypass ativa automaticamente.
echo.
echo   Se o Discord abrir sem o plugin, feche tudo e rode
echo   este .bat NOVAMENTE (as vezes o Update.exe resiste).
echo ======================================================
echo.
pause
