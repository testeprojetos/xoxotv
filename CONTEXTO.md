# Contexto do Projeto — XoxôTV

## Objetivo
Criar um site pessoal com player de vídeo que reproduz episódios do **Goyabu** (site de anime),
sem depender da interface do Goyabu (que tem vários bugs).

---

## O que já descobrimos

### Estrutura do Goyabu
- Site WordPress com tema "Cronos Design"
- URL de episódio: `https://goyabu.io/{ID}` (ex: `https://goyabu.io/40431` = One Piece Dub EP1)
- O player da página é **JWPlayer 8.26.1**
- Os vídeos **não estão hospedados no Goyabu** — estão no **Blogger (Google)**
- O site tem proteção anti-bot (`21wiz.com/logger`) que detecta headless Chrome e redireciona cliques no player para `google.com`

### Onde o vídeo está
- O vídeo está hospedado no **Blogger Video** do Google
- O token de acesso fica no HTML/JS da página, ex:
  ```
  blogger.com/video.g?token=AD6v5dwe6gpuhGnvR75wvnsEXTMw8Ys-JbkUbMmY...
  ```
- Este token **é fixo por episódio** (não muda, pode ser cacheado indefinidamente)

### Como obter as URLs do vídeo (batchexecute)
O Blogger usa uma API interna do Google chamada `batchexecute` com `rpcids=WcwnYd`:

**Passo 1:** Acessar `https://www.blogger.com/video.g?token={TOKEN}`
- Extrair `f.sid` do campo `"FdrFJe":"..."` no HTML de resposta
- Extrair `bl` da URL de algum script (ex: `boq_bloggeruiserver_20260630.06_p0`)
- Capturar cookies `Set-Cookie` da resposta (especialmente `NID=...`)

**Passo 2:** POST para:
```
https://www.blogger.com/_/BloggerVideoPlayerUi/data/batchexecute?rpcids=WcwnYd&source-path=%2Fvideo.g&f.sid={F_SID}&bl={BL}&hl=pt-BR&_reqid=44365&rt=c
```
Body:
```
f.req=%5B%5B%5B%22WcwnYd%22%2C%22%5B%5C%22{TOKEN_URL_ENCODED}%5C%22%5D%22%2Cnull%2C%221%22%5D%5D%5D&at=&
```
Headers necessários:
```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...Chrome/127...
Referer: https://www.blogger.com/video.g?token=...
Origin: https://www.blogger.com
Cookie: {cookies capturados acima}
X-Same-Domain: 1
```

**Resposta** (formato Google RPC, precisa decodificar unicode escapes):
```json
[["wrb.fr","WcwnYd","[1,null,[[\"https://rr1---sn-...googlevideo.com/videoplayback?expire=...&itag=22...\", [22]], ...]]",...]]
```

Dois itags disponíveis:
- `itag=18` → 360p MP4
- `itag=22` → 720p MP4 ← **queremos este**

### Decodificação da resposta
```javascript
let inner = body.match(/"WcwnYd","([\s\S]+?)",null,null,null/)[1];
inner = inner.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
inner = inner.replace(/\\([=&])/g, '$1');
// Depois extrai URLs com regex: /(https:\/\/[^"]+googlevideo[^"]+)/g
// Filtra itag=22
```

### O problema central: 403 no proxy
A URL do `googlevideo.com` tem estas restrições:
1. **IP assinado**: o parâmetro `ip=177.74.234.65` está incluso nos `sparams` e na assinatura `sig=AHEqNM4...` — qualquer requisição de IP diferente recebe 403
2. **Parâmetro `xpc=Egho7Zf3LnoBAQ==`**: token cross-process gerado pelo JavaScript do player do Blogger dentro de um iframe. Só é válido no contexto da sessão do browser que o gerou
3. **IPv6 vs IPv4**: o googlevideo compara o IP da requisição com o IP assinado — se o servidor conecta via IPv6 mas a URL foi gerada com IPv4, recebe 403
4. **`susc=bl`** (source=blogger): indica que a URL só é válida no contexto do player do Blogger

**Resumo**: a URL gerada pelo `batchexecute` só funciona quando acessada pelo **mesmo browser** que a gerou, dentro do contexto correto do iframe do Blogger. Proxy de bytes no servidor sempre retorna 403.

### O que já foi tentado (e falhou)
- Proxy de bytes no Node.js com headers do Blogger → 403
- Redirecionar o browser para a URL direta → 403 (IP diferente quando em produção)
- Remover `xpc` da URL → 403 (assinatura `sig` inclui `xpc` nos `sparams`)
- Puppeteer headless clicando no player → redireciona para `google.com` (proteção anti-bot)
- CDP `Network.requestWillBeSent` para interceptar headers → batchexecute não é chamado porque o JWPlayer não inicializa sem clique humano
- Puppeteer `jwplayer().play()` via JS → não funciona (JWPlayer não carregou o iframe ainda)

---

## Estrutura do projeto

**Localização:** `C:\Users\RBR\Pictures\op\`

```
op/
├── server.js          ← Backend Express + Puppeteer (em desenvolvimento)
├── scrape.js          ← Script de análise (pode ignorar)
├── decode.js          ← Script de decode (pode ignorar)
├── package.json
├── node_modules/
└── public/
    └── index.html     ← Frontend do player (HTML/CSS/JS puro, está bonito)
```

**Dependências instaladas:**
```json
{
  "express": "^4.19.2",
  "puppeteer": "^22.12.1",
  "puppeteer-extra": "^3.3.6",
  "puppeteer-extra-plugin-stealth": "^2.11.2",
  "playwright": "1.45.0"
}
```

**Rodar o servidor:** `node server.js` → `http://localhost:3000`

---

## Onde o frontend está

`public/index.html` — design escuro, roxo, responsivo. Fluxo:
1. Usuário cola URL ou ID do episódio (ex: `40431`)
2. Clica "Assistir"
3. JS faz `GET /api/stream?url=40431` → recebe `{ url: "/api/proxy?id=40431", quality: "720p" }`
4. Coloca o `url` no `src` do `<video>`

---

## Caminhos possíveis para resolver o 403

### Opção A — Puppeteer headless com clique real (mais promissora)
O Goyabu detecta automação no clique do player e redireciona para `google.com`.
**Hipótese**: se conseguirmos fazer o Puppeteer passar na detecção de bot do Goyabu (há uma lib `disable-devtool` e `21wiz` verificando `botKind: headless_chrome`), o clique vai funcionar, o Blogger vai carregar, e o CDP vai interceptar a URL com todos os headers corretos (incluindo `xpc` válido).

**O que tentar:**
- Usar Puppeteer com `headless: 'new'` (modo headless mais furtivo)
- Ou `executablePath` apontando para o Chrome instalado (não o bundled Chromium)
- Tentar `playwright` com `channel: 'chrome'` que usa o Chrome real instalado

### Opção B — Playwright com Chrome real instalado
O Playwright tem suporte a `channel: 'chrome'` que usa o Google Chrome instalado na máquina.
O Chrome real passa em mais verificações anti-bot que o Chromium bundled.

```javascript
const { chromium } = require('playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: false });
```

### Opção C — Ignorar o Goyabu e ir direto ao Blogger
O token do Blogger (`AD6v5dwe...`) é estável. Podemos acessar diretamente
`https://www.blogger.com/video.g?token={TOKEN}` com um browser real (não headless),
deixar o player do Blogger carregar, e interceptar a requisição com CDP.
Isso elimina a camada de proteção do Goyabu.

### Opção D — yt-dlp
A ferramenta `yt-dlp` sabe extrair vídeos do Blogger. Pode ser usada como processo filho no Node.js:
```javascript
const { execFile } = require('child_process');
execFile('yt-dlp', ['-f', '22', '--get-url', bloggerUrl], (err, stdout) => {
  const videoUrl = stdout.trim();
});
```
Se o `yt-dlp` extrair a URL, pode funcionar porque ele gera a URL com o IP do servidor
e faz a requisição também do servidor (mesmo IP).

---

## IP do usuário
`177.74.234.65` (IPv4) — ISP: Bizz Internet Ltda, Mantena, Minas Gerais, Brasil

---

## Próximos passos recomendados

1. **Testar Opção D (yt-dlp)** — mais simples de implementar e pode resolver na hora
2. **Se yt-dlp não funcionar**, testar Opção B (Playwright com Chrome real)
3. O frontend já está pronto, só precisa o backend funcionando
