const express    = require('express');
const https      = require('https');
const path       = require('path');
const { execFile } = require('child_process');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CORS — permite GitHub Pages e localhost ──────────────────────────────────
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  // Adicione sua URL do GitHub Pages aqui depois do deploy:
  'https://testeprojetos.github.io',
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Cache ────────────────────────────────────────────────────────────────────
const streamCache = new Map(); // episodeId -> { url, capturedAt }
const STREAM_TTL  = 5 * 60 * 60 * 1000; // 5 horas (googlevideo expira em ~6h)

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

// ─── Extrai ID/URL do episódio ────────────────────────────────────────────────

function extractEpisodeId(raw) {
  const m = raw.match(/goyabu\.io\/(\d+)/);
  if (m) return m[1];
  return /^\d+$/.test(raw.trim()) ? raw.trim() : raw.trim();
}

// ─── Opção 1: yt-dlp ──────────────────────────────────────────────────────────
// yt-dlp sabe extrair vídeos do Blogger. A URL gerada fica vinculada ao IP do
// servidor que fez a requisição, então proxy e extração são feitos do mesmo IP.

function ytdlpGetUrl(bloggerToken) {
  return new Promise((resolve, reject) => {
    const bloggerUrl = `https://www.blogger.com/video.g?token=${bloggerToken}`;
    console.log('[yt-dlp] Extraindo URL de:', bloggerUrl);

    // -f 22 = 720p MP4; --get-url retorna só a URL final
    execFile('yt-dlp', [
      '-f', '22/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--get-url',
      '--no-playlist',
      bloggerUrl,
    ], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[yt-dlp] Erro:', stderr || err.message);
        return reject(new Error('yt-dlp falhou: ' + (stderr || err.message).split('\n')[0]));
      }
      const url = stdout.trim().split('\n')[0];
      if (!url || !url.startsWith('http')) {
        return reject(new Error('yt-dlp não retornou URL válida'));
      }
      console.log('[yt-dlp] ✅ URL obtida:', url.substring(0, 80) + '...');
      resolve(url);
    });
  });
}

// ─── Opção 2: batchexecute direto ─────────────────────────────────────────────
// Acessa a API interna do Blogger para obter a URL sem browser.
// ATENÇÃO: a URL gerada fica vinculada ao IP do servidor → proxy do mesmo servidor
// pode funcionar, mas não é garantido (depende se o Google assina por IP ou sessão).

async function batchexecuteGetUrl(bloggerToken) {
  const bloggerUrl = `https://www.blogger.com/video.g?token=${bloggerToken}`;
  console.log('[batch] Passo 1: buscando f.sid e bl...');

  const res = await httpGet(bloggerUrl, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    'Referer': 'https://goyabu.io/',
  });

  const fidMatch = res.body.match(/"FdrFJe"\s*:\s*"([^"]+)"/);
  if (!fidMatch) throw new Error('f.sid não encontrado na página do Blogger');
  const fSid = fidMatch[1];

  const blMatch = res.body.match(/boq_bloggeruiserver_[0-9_a-zA-Z.]+/);
  const bl = blMatch ? blMatch[0] : 'boq_bloggeruiserver_20260630.06_p0';

  const cookieHeader = res.headers['set-cookie'];
  const cookies = cookieHeader
    ? (Array.isArray(cookieHeader) ? cookieHeader : [cookieHeader])
        .map(c => c.split(';')[0])
        .join('; ')
    : '';

  console.log(`[batch] f.sid=${fSid.substring(0, 16)}... bl=${bl}`);

  const batchUrl  = `https://www.blogger.com/_/BloggerVideoPlayerUi/data/batchexecute`
    + `?rpcids=WcwnYd&source-path=%2Fvideo.g&f.sid=${fSid}&bl=${bl}&hl=pt-BR&_reqid=44365&rt=c`;
  const batchBody = `f.req=%5B%5B%5B%22WcwnYd%22%2C%22%5B%5C%22${encodeURIComponent(bloggerToken)}%5C%22%5D%22%2Cnull%2C%221%22%5D%5D%5D&at=&`;

  console.log('[batch] Passo 2: batchexecute...');
  const batch = await httpPost(batchUrl, batchBody, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    'Referer': bloggerUrl,
    'Origin': 'https://www.blogger.com',
    'Cookie': cookies,
    'X-Same-Domain': '1',
  });

  if (batch.status !== 200) throw new Error(`batchexecute retornou HTTP ${batch.status}`);

  const inner = batch.body.match(/"WcwnYd","([\s\S]+?)",null,null,null/);
  if (!inner) throw new Error('Resposta inesperada do batchexecute (sem WcwnYd)');

  const decoded = inner[1]
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\([=&])/g, '$1');

  // Extrai todas as URLs do googlevideo e filtra por itag=22 (720p)
  const urlRe = /(https:\/\/[^"\\]+googlevideo[^"\\]+)/g;
  const urls = [];
  let m;
  while ((m = urlRe.exec(decoded)) !== null) {
    try {
      const u = new URL(m[1]);
      urls.push({ url: m[1], itag: u.searchParams.get('itag') });
    } catch (_) {}
  }

  console.log(`[batch] URLs encontradas: ${urls.map(u => 'itag=' + u.itag).join(', ')}`);

  const hd = urls.find(u => u.itag === '22');
  if (hd) return hd.url;

  const sd = urls.find(u => u.itag === '18');
  if (sd) {
    console.log('[batch] ⚠ 720p não encontrado, usando 360p (itag=18)');
    return sd.url;
  }

  if (urls.length > 0) {
    console.log('[batch] ⚠ itag 22/18 não encontrado, usando primeira URL disponível');
    return urls[0].url;
  }

  throw new Error('Nenhuma URL de vídeo encontrada na resposta do batchexecute');
}

// ─── Extrai token do Blogger a partir da página do Goyabu ────────────────────

async function extractBloggerToken(episodeId) {
  const goyabuUrl = `https://goyabu.io/${episodeId}`;
  console.log(`[token] Buscando token em: ${goyabuUrl}`);

  const res = await httpGet(goyabuUrl, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9',
  });

  if (res.status === 301 || res.status === 302) {
    throw new Error(`Goyabu redirecionou (${res.status}) — ID inválido?`);
  }

  // Padrões de onde o token pode aparecer no HTML
  const patterns = [
    /blogger\.com\/video\.g\?token=([A-Za-z0-9_\-=+/]{20,})/,
    /\\"token\\":\s*\\"([A-Za-z0-9_\-=+/]{20,})\\"/,
    /token=([A-Za-z0-9_\-=+/]{20,})/,
  ];

  for (const pat of patterns) {
    const match = res.body.match(pat);
    if (match) {
      console.log(`[token] ✅ Token encontrado (${match[1].substring(0, 20)}...)`);
      return match[1];
    }
  }

  throw new Error('Token do Blogger não encontrado na página do Goyabu');
}

// ─── Pipeline principal ───────────────────────────────────────────────────────

async function getStreamUrl(episodeId) {
  // Verifica cache
  const cached = streamCache.get(episodeId);
  if (cached && Date.now() - cached.capturedAt < STREAM_TTL) {
    console.log(`[cache] ✅ Usando cache para episódio ${episodeId}`);
    return cached.url;
  }

  // Passo 1: extrai token do Blogger a partir da página do Goyabu
  const token = await extractBloggerToken(episodeId);

  // Passo 2: tenta batchexecute direto (estratégia principal)
  let videoUrl = null;

  try {
    videoUrl = await batchexecuteGetUrl(token);
    console.log('[pipeline] ✅ batchexecute funcionou');
  } catch (err) {
    console.warn('[pipeline] batchexecute falhou, tentando yt-dlp:', err.message);
  }

  // Passo 3: fallback para yt-dlp
  if (!videoUrl) {
    try {
      videoUrl = await ytdlpGetUrl(token);
      console.log('[pipeline] ✅ yt-dlp funcionou');
    } catch (err) {
      throw new Error('Todas as estratégias falharam: ' + err.message);
    }
  }

  streamCache.set(episodeId, { url: videoUrl, capturedAt: Date.now() });
  return videoUrl;
}

// ─── API: /api/stream ─────────────────────────────────────────────────────────

app.get('/api/stream', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Parâmetro "url" obrigatório' });

  const id = extractEpisodeId(url);
  console.log(`\n[API] /api/stream id=${id}`);

  try {
    await getStreamUrl(id); // só para validar / cachear
    res.json({ url: `/api/proxy?id=${encodeURIComponent(id)}`, quality: '720p' });
  } catch (err) {
    console.error('[API] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: /api/proxy — pipe da URL do googlevideo ────────────────────────────
// A URL foi gerada pelo mesmo servidor (mesmo IP que vai fazer o pipe),
// então não há problema de IP assinado diferente.

app.get('/api/proxy', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).send('Parâmetro "id" obrigatório');
  console.log(`\n[PROXY] id=${id}`);

  try {
    let videoUrl = await getStreamUrl(id);
    console.log(`[PROXY] Piping: ${videoUrl.substring(0, 80)}...`);

    const rangeHeader = req.headers['range'];

    const upstreamHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'pt-BR,pt;q=0.9',
      'Referer': 'https://www.blogger.com/',
      'Origin': 'https://www.blogger.com',
      'sec-fetch-dest': 'video',
      'sec-fetch-mode': 'no-cors',
      'sec-fetch-site': 'cross-site',
    };

    if (rangeHeader) upstreamHeaders['Range'] = rangeHeader;

    const parsedUrl = new URL(videoUrl);
    const upstream  = https.request({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      family: 4, // força IPv4 — consistente com o IP que gerou a URL
      headers: upstreamHeaders,
    }, (upstreamRes) => {
      const status = upstreamRes.statusCode;
      console.log(`[PROXY] upstream status: ${status}`);

      if (status === 403 || status === 410) {
        // URL expirada ou inválida — limpa cache e pede retry
        streamCache.delete(id);
        if (!res.headersSent) {
          res.status(503).json({ error: 'Stream expirado, clique em Assistir novamente' });
        }
        upstreamRes.resume();
        return;
      }

      const clientHeaders = {
        'Content-Type': upstreamRes.headers['content-type'] || 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      };
      if (upstreamRes.headers['content-length'])
        clientHeaders['Content-Length'] = upstreamRes.headers['content-length'];
      if (upstreamRes.headers['content-range'])
        clientHeaders['Content-Range'] = upstreamRes.headers['content-range'];

      res.writeHead(status, clientHeaders);
      upstreamRes.pipe(res, { end: true });
      upstreamRes.on('error', e => console.error('[PROXY] upstream error:', e.message));
    });

    upstream.on('error', e => {
      console.error('[PROXY] request error:', e.message);
      if (!res.headersSent) res.status(500).json({ error: e.message });
    });
    upstream.setTimeout(30000, () => {
      upstream.destroy();
      if (!res.headersSent) res.status(504).json({ error: 'Timeout no upstream' });
    });
    upstream.end();
    req.on('close', () => upstream.destroy());

  } catch (err) {
    console.error('[PROXY] Erro:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── API: /api/meta — thumbnail e título do episódio via og:tags ─────────────

const metaCache = new Map(); // episodeId -> { image, title, cachedAt }
const META_TTL  = 24 * 60 * 60 * 1000; // 24h (og:image é estável)

app.get('/api/meta', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id obrigatório' });

  const cached = metaCache.get(id);
  if (cached && Date.now() - cached.cachedAt < META_TTL) {
    return res.json(cached);
  }

  try {
    const page = await httpGet(`https://goyabu.io/${id}`, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      'Accept': 'text/html',
      'Accept-Language': 'pt-BR,pt;q=0.9',
    });

    const imgMatch = page.body.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                  || page.body.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    const ttlMatch = page.body.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
                  || page.body.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);

    const result = {
      image: imgMatch ? imgMatch[1] : null,
      title: ttlMatch ? ttlMatch[1].replace(/ *[-–|] *Goyabu.*$/i, '').trim() : null,
      cachedAt: Date.now(),
    };

    metaCache.set(id, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: /api/debug — retorna a URL bruta (para diagnóstico) ─────────────────

app.get('/api/debug', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id obrigatório' });
  try {
    const url = await getStreamUrl(id);
    // Não expõe a URL completa em produção, mas útil para debug local
    const parsed = new URL(url);
    res.json({
      host: parsed.hostname,
      itag: parsed.searchParams.get('itag'),
      expire: parsed.searchParams.get('expire'),
      ip: parsed.searchParams.get('ip'),
      cached: streamCache.has(id),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🎬 XoxôTV rodando em http://localhost:${PORT}`);
  console.log('   Pipeline: batchexecute → yt-dlp (fallback)\n');
});
