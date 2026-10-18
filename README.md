# YaniNeko — LefferzinBypass

Plugin para Discord com Vencord que usa a Proton VPN para configurar uma rota alternativa para a conexão do Discord.

## Como funciona

Você entra na sua conta Proton pelo plugin, e ele prepara uma conexão VPN usando o WireSock. O tráfego do Discord passa pela rota selecionada, com filtro por aplicativo.

A opção **Otimizar rotas** compara servidores disponíveis e testa a conexão para escolher uma rota. O plugin também permite consultar o status, o servidor e o ping, além de trocar a rota pelas configurações. O resultado depende da sua internet e da disponibilidade dos servidores.

## Antes de começar

- Tenha o Discord instalado no Windows.
- Tenha uma conta Proton e acesso ao código de autenticação em duas etapas (2FA), caso esteja ativado.
- Use o arquivo **BypassDiscord.bat** para iniciar a instalação.

Não é necessário instalar Git, Node.js ou Python manualmente ao usar o EXE. O instalador prepara Git e Node.js portáteis quando necessário e instala o pnpm na pasta do usuário, sem depender do Corepack. As ferramentas ficam em `%LOCALAPPDATA%\LefferzinBypass\tools` e são reaproveitadas nas próximas instalações. É necessário acesso à internet para os downloads.

Se o Discord Stable não for encontrado, o instalador para antes de baixar as ferramentas e explica como corrigir. No EXE, falhas também abrem uma janela com a etapa, o motivo e o caminho do log. Discord Canary e PTB não são usados como substitutos do Stable.

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

O instalador usa sempre a release **4.0.0**. Quando recompilar, substitua o asset `YaniNeko-Installer.exe` nessa mesma release e atualize o SHA256 no BAT; não crie uma nova tag para o instalador. O EXE preparado inclui a correção de saída em consoles Windows com codificação antiga. SHA256 esperado: `FA33C5B4F5E113FF6DB1E605F1BF11401CCE4D361A02C5656B9C369EC953FF06`. A versão do plugin permanece **2.2.9**.

Logs e estado: `%LOCALAPPDATA%\LefferzinBypass\Vencord\.yanineko-updates`. Conta Proton e configuração da VPN são preservadas. Se uma atualização do próprio Discord remover a injeção do Vencord, será necessário executar o instalador novamente.

A partir da V2.2.8, marcadores de atualização inválidos e builds preparados corrompidos são movidos para a subpasta `quarantine`, com o motivo registrado em `updater.log`. O atualizador pode preparar outra cópia sem ficar preso à tentativa anterior. As versões ativa e de retorno não são substituídas por essa recuperação.

Validação de desenvolvimento: `node test-auto-update.cjs`. O teste `node validate-update-build.cjs` também compila uma cópia isolada usando o Vencord instalado no caminho padrão; não modifica o Discord em uso.

## Relatórios automáticos de erro — V2.2.9

O plugin envia erros ao canal de suporte configurado pelo projeto, com um anexo `erro.NOME_DO_DISCORD.log`. Inclui a versão, erros agrupados e o diagnóstico recente do plugin e do atualizador. O nome é o usuário do Discord, não o login da Proton nem a conta do Windows. O envio aguarda a identificação do usuário e ocorre no máximo uma vez a cada cinco minutos.

Os relatórios de erro ficam sempre ativos, sem opção de desativação nas configurações. Preferências antigas de desativação não são mais utilizadas. Senhas, tokens, chaves WireGuard, URLs, e-mails e endereços de rede reconhecidos são filtrados antes do envio. Arquivos de sessão e configurações WireGuard não são anexados. Uma falha no envio fica registrada localmente e não interrompe o Discord; não há garantia de entrega se o processo encerrar ou estiver sem rede.

O webhook é distribuído no plugin por decisão do mantenedor e pode ser extraído do build. Os relatórios devem ser acessíveis somente à equipe de suporte. Testes sem envio real: `node test-error-reporter.cjs`.

## Contador online — V2.2.10

A partir da V2.3.0, a linha da presença que exibia o endereço do GitHub mostra `12 usuários online`, junto da informação de rota. A linha de versão permanece separada. O plugin envia um identificador aleatório por instalação e o nome de usuário do Discord a cada minuto à API configurada em `native.ts`. Os nomes aparecem somente no painel privado `/admin`; as rotas públicas mostram apenas a quantidade. A contagem considera os últimos 3 minutos e representa instalações ativas, não pessoas únicas. A participação no contador fica sempre ativa enquanto o plugin estiver habilitado, sem opção separada nas configurações. Preferências antigas de desativação não são mais utilizadas. Se a API falhar, a presença mostra `Contador indisponível` e a VPN continua funcionando.

O servidor fica em `server/`, separado do plugin e excluído do auto update. Execute-o na VPS **203.159.90.60**, onde seu ngrok já encaminha HTTPS para `localhost:3008`. Consulte `server/README.md`. Não foi feita implantação automática na VPS. Testes: `node server/test-server.cjs` e `node test-online-counter.cjs`.

O painel privado mantém o histórico de instalações por 30 dias e mostra nome, online/offline, última atividade em minutos/horas/dias, rota e tempo da sessão atual. Preserve `server/.server-data` ao substituir os arquivos na VPS: ela guarda a chave de acesso e o histórico. Atualize primeiro o servidor, depois o plugin, para aceitar os campos de rota e sessão. O cronômetro público da presença foi mantido. Teste do painel: `node server/test-panel.cjs`.
