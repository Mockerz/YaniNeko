# Configuração da imagem do Discord Presence

O Client ID usado pelo plugin é `1545534815468658789`.

Para a imagem aparecer, entre no [Discord Developer Portal](https://discord.com/developers/applications), abra a aplicação com esse ID, vá em **Rich Presence → Art Assets** e envie `leffer-bypass.png`. Salve o asset com qualquer nome; o nome usado pelo plugin é **`leffer-bypass`** (o Discord converte as chaves para minúsculas).

Depois de instalar o plugin atualizado:

1. Feche completamente o Discord e abra-o novamente.
2. Ative o plugin `LefferzinBypass`.
3. Ative o bypass.
4. Confira a presença em outro perfil/conta ou em um servidor; a própria conta pode não mostrar todos os detalhes localmente.

A versão anterior passava diretamente uma URL de avatar do CDN no evento interno `LOCAL_ACTIVITY_UPDATE`. O Vencord resolve assets registrados por meio de `ApplicationAssetUtils.fetchAssetIds`; a versão 1.0.1 usa esse fluxo e grava no log quando o asset não foi cadastrado ou o Client ID não corresponde à aplicação.

O instalador também foi ajustado para manter o `.ps1` local se o download do GitHub falhar, reconhecer a mensagem `Success!` do injector CLI e não declarar a instalação concluída quando a injeção do Vencord não for confirmada. O teste usa somente ASCII para funcionar no Windows PowerShell 5.1, e o `.bat` salva o script baixado em UTF-8 com BOM. No log antigo, o Vencord já havia sido instalado, mas o instalador não reconhecia `Success!` e iniciava desnecessariamente o `pnpm inject` interativo; a tentativa seguinte ainda revelou que o símbolo `✔` corrompido quebrava o parser.
