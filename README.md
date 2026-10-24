<p align="center">
  <img src="assets/icon-256.png" width="128" alt="Twitch Mod Hub">
</p>

<h1 align="center">Twitch Mod Hub</h1>

<p align="center">
  <b>Modere todos os chats da Twitch em que você é mod (ou VIP) numa janela só, sem abrir uma aba por live.</b><br>
  Leve, sem instalar nada além do Node.js, feito para quem modera várias lives ao mesmo tempo.
</p>

---

## Por que existe

Quem modera várias lives acaba com o navegador cheio de abas da Twitch, e cada uma com o player de vídeo
rodando come centenas de MB de RAM. O **Twitch Mod Hub** junta todos os chats numa janela própria (só texto,
levíssimo) e deixa o vídeo **opcional**: você abre só a live que quiser num player externo leve (VLC/mpv), na
qualidade que escolher, até **só áudio**.

## Recursos

- 📋 **Lista automática** dos canais onde você é moderador (mais o seu), com quem está **ao vivo**, viewers, categoria e tempo de live.
- 💜 **Canais VIP descobertos sozinhos**: o app olha os canais que você segue e estão ao vivo e reconhece onde você tem o selo de VIP.
- ➕ **Adicionar qualquer canal** na mão.
- 💬 **Entra sozinho no chat** de quem fica ao vivo; contador de não lidas e destaque em vermelho quando te marcam.
- 🧵 Visão **"Todos os chats"** com tudo junto, ou um canal por vez.
- 🛡️ **Moderação rápida**: passe o mouse na mensagem → 🗑 apagar · ⏱ timeout 10 min · ⛔ banir (duplo clique).
  Clique no nome → timeouts de 1min/10min/1h/24h, banir com motivo, desbanir e o histórico recente da pessoa.
- ⌨️ **Comandos**: `/ban usuario motivo`, `/timeout usuario 10m motivo`, `/unban usuario`, `/me texto`.
- 🚫 Mensagens apagadas e usuários punidos ficam **riscados** (você vê o que foi removido); primeira mensagem de alguém no chat aparece em verde.
- ▶️ **Assistir sem navegador** via Streamlink + VLC/mpv: só áudio, 160p, 360p, 480p, 720p ou melhor.
- 🔒 Seu login fica **só no seu computador** (pasta `data/`). Nada passa por servidor de terceiros: o app fala direto com a Twitch.

## Requisitos

- **Windows 10/11**
- **[Node.js](https://nodejs.org)** 18 ou mais novo
- **[Streamlink](https://streamlink.github.io)** + **VLC** ou **mpv**, só se quiser assistir às lives pelo app (o chat funciona sem eles)

```bash
winget install OpenJS.NodeJS.LTS
winget install Streamlink.Streamlink
winget install VideoLAN.VLC
```

## Instalação

1. Baixe o projeto: botão verde **Code → Download ZIP** e extraia numa pasta.
2. Dê dois cliques em **`Abrir Mod Hub.bat`**.
3. Na primeira vez o app pede um **Client ID** da Twitch (grátis, 2 minutos):
   1. Abra o [Console de desenvolvedor da Twitch](https://dev.twitch.tv/console/apps/create) (ative a verificação em 2 etapas se pedir).
   2. **Nome**: qualquer um (ex.: `ModHub-seunick`).
   3. **URL de redirecionamento OAuth**: `http://localhost` (deixe só essa linha, sem linhas em branco).
   4. **Categoria**: `Chat Bot` · **Tipo de cliente**: **Público**.
   5. Clique em **Criar** → **Gerenciar** e copie o **ID do cliente** para o app.
4. Clique em **Entrar com a Twitch** e confirme o código que aparece no navegador.

Pronto: seus canais aparecem na barra lateral. Ao fechar a janela, o app e os players abertos por ele se encerram sozinhos.

## Limitações (importante)

| Situação | Conta? |
|---|---|
| **Sequência de lives (watch streak)**, **pontos do canal** e **drops** | ❌ **Não contam.** Eles dependem de assistir pelo player oficial da Twitch logado na sua conta. Estar no chat não é "assistir", e o player externo (Streamlink) assiste de forma anônima. Para manter a sequência num canal, use o botão **↗** (abre a live no navegador) nesse canal. |
| Aparecer na lista de pessoas no chat | ✅ Sim, enquanto o app estiver conectado no chat. |
| Moderar | ✅ Só onde você é mod de verdade. Em canais onde você é só VIP o chat funciona, mas os botões de moderação ficam escondidos (a Twitch não deixa VIP moderar). |

Outros limites:

- **Descoberta de VIP**: só funciona com canais que você **segue** e que estão **ao vivo** naquele momento. O canal descoberto fica salvo; para os outros, use **Adicionar canal**.
- **Muitos canais**: a Twitch limita a entrada em chats (20 a cada 10 s), então o app entra em um a cada 0,6 s. Com dezenas de canais, leva alguns segundos até estar em todos.
- **Envio de mensagens**: limite da Twitch de 20 mensagens a cada 30 s (100 nos canais em que você é mod).
- **Anúncios**: no player externo, a imagem pode pausar durante o intervalo de anúncios da live.
- **Só Windows** por enquanto (usa o Edge para a janela e caminhos do Windows para o player).

## Como funciona

- `server.js`: servidor local (só na sua máquina, porta `17563`), sem dependências. Faz o login (Device Code Flow), conecta no chat por IRC, chama a API Helix para moderar e abre o player.
- `index.html`: a interface, aberta numa janela do Edge em modo app (perfil separado, sem abas nem extensões).
- Permissões pedidas à Twitch: ler canais moderados e seguidos, ler/enviar no chat, gerenciar bans e apagar mensagens.

---

Feito por [eunetxinhu](https://github.com/eunetxinhu) 💛
