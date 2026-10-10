# YaniNeko — LefferzinBypass

Plugin para Discord com Vencord que usa a Proton VPN para configurar uma rota alternativa para a conexão do Discord.

## Como funciona

Você entra na sua conta Proton pelo plugin, e ele prepara uma conexão VPN usando o WireSock. O tráfego do Discord passa pela rota selecionada, com filtro por aplicativo.

A opção **Otimizar rotas** compara servidores disponíveis e testa a conexão para escolher uma rota. O plugin também permite consultar o status, o servidor e o ping, além de trocar a rota pelas configurações. O resultado depende da sua internet e da disponibilidade dos servidores.

## Antes de começar

- Tenha o Discord instalado no Windows.
- Tenha uma conta Proton e acesso ao código de autenticação em duas etapas (2FA), caso esteja ativado.
- Use o arquivo **BypassDiscord.bat** para iniciar a instalação.

## Passo a passo

1. **Executar como administrador**
   - Clique com o botão direito em **BypassDiscord.bat** e selecione **Executar como administrador**.
   - Aguarde o instalador abrir e concluir a instalação.

2. **Acessar os plugins no Discord**
   - Abra o Discord e entre em **Configurações do usuário** (ícone de engrenagem).
   - Na seção do Vencord, clique em **Plugins**.

3. **Ativar o plugin**
   - Pesquise por **LefferzinBypass**.
   - Ative o plugin, caso ainda esteja desativado.

4. **Entrar na conta Proton**
   - Clique na engrenagem de configuração do plugin.
   - Insira seu **e-mail ou usuário** e sua **senha** da Proton.
   - Se usar autenticação em duas etapas, preencha também o **código 2FA**.
   - Clique em **Logar** e aguarde a confirmação de login e ativação do bypass.
   - O plugin tenta ativar a conexão automaticamente. Se informar que o bypass ainda não foi ativado, use **Start Bypass**.

5. **Otimizar rotas na primeira configuração**
   - Clique em **Otimizar rotas**.
   - Aceite as permissões solicitadas pelo Windows para concluir a configuração.
   - Aguarde a conclusão dos testes e a aplicação da rota.
   - **Não é necessário repetir esse passo a cada uso.** Você pode otimizar novamente se precisar trocar ou melhorar a rota.

6. **Finalizar**
   - Após a otimização, aguarde cerca de **30 segundos** para o Discord reiniciar automaticamente. O tempo pode variar.
   - Se ficar preso em **Checking for updates** por mais de **5 segundos**, feche completamente o Discord, inclusive pelo ícone ao lado do relógio, e abra novamente.
   - Confira nas configurações do plugin se a conexão está ativa. Pronto!

## Dúvidas rápidas

- **O plugin não aparece?** Confira se o instalador terminou sem erros e reabra o Discord.
- **O login falhou?** Confira o usuário, a senha e o código 2FA, se houver.
- **A conexão não está ativa?** Abra as configurações do plugin, confira a mensagem de status e clique em **Start Bypass**, se necessário.
- **Onde ficam os logs da instalação?** Em `%LOCALAPPDATA%\LefferzinBypass\logs`.

## Atualização automática (a partir da V1.1.0)

Instale uma vez usando o **novo BypassDiscord.bat** ou **YaniNeko-Installer.exe** da release. Quem já usava uma versão antiga também precisa executar este instalador uma vez. Depois, o plugin verifica novos commits na `main` cerca de 30 segundos após abrir o Discord e a cada 3 horas enquanto ele estiver aberto.

O download fica preso a um único commit, os arquivos são conferidos pelos hashes do GitHub e o Vencord é compilado em uma pasta separada, usando as dependências da instalação. Quando a atualização fica pronta, aparece um aviso e o Discord reinicia automaticamente após cerca de 10 segundos, inclusive durante chamadas e transmissões. O plugin encerra sua VPN antes de reiniciar. Se essa limpeza falhar, adia o reinício e tenta novamente após 1 minuto. Ctrl+R não é necessário.

Se a internet, o GitHub ou a compilação falhar, a versão atual continua funcionando. Uma falha síncrona ao iniciar o novo build restaura a versão anterior para a abertura seguinte. Isso não detecta todos os erros que possam aparecer durante o uso. O atualizador próprio do Vencord fica desativado para não sobrescrever este build personalizado; atualizações da base do Vencord continuam exigindo o instalador.

Para publicar uma alteração do plugin, basta fazer push na `main`. Não precisa criar uma release. Atualize `version` no `manifest.json` quando quiser mudar o número mostrado em **Bypass de Tela/Cam - V1.1.0**. O número exibido vem do build carregado; a detecção de atualizações usa o commit.

O executável é distribuído pela release do GitHub e o BAT valida seu SHA256 antes de executá-lo. Se alterar `instalar_yanineko.py`, recompile `YaniNeko-Installer.exe`, publique-o na release e atualize a URL e o SHA256 em `BypassDiscord.bat` antes do push. O EXE gerado não entra no Git. Alterações apenas no plugin não exigem recompilar o instalador.

Logs e estado: `%LOCALAPPDATA%\LefferzinBypass\Vencord\.yanineko-updates`. Conta Proton e configuração da VPN são preservadas. Se uma atualização do próprio Discord remover a injeção do Vencord, será necessário executar o instalador novamente.

Validação de desenvolvimento: `node test-auto-update.cjs`. O teste `node validate-update-build.cjs` também compila uma cópia isolada usando o Vencord instalado no caminho padrão; não modifica o Discord em uso.
