const express    = require('express');
const https      = require('https');
const path       = require('path');
const crypto     = require('crypto');
const { execFile } = require('child_process');

const app  = express();
const PORT = process.env.PORT || 3000;
const FIREBASE_API_KEY = 'AIzaSyBaHem45yqhV-V4CyBoqd4bF3-e5RjaCzU';
const FIREBASE_PROJECT_ID = 'anime-326c0';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

if (!process.env.SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET ausente; as sessões serão invalidadas ao reiniciar.');
}

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (origin) res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '8kb' }));
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

function httpPostJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payload);
    req.end();
  });
}

// ─── Sessão e autorização ────────────────────────────────────────────────────

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => {
    const index = part.indexOf('=');
    if (index < 0) return ['', ''];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function signSession(user) {
  const payload = Buffer.from(JSON.stringify({
    uid: user.localId,
    email: user.email.toLowerCase(),
    exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readSession(req) {
  const token = parseCookies(req.headers.cookie).xoxotv_session;
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!session.uid || !session.email || session.exp <= Date.now()) return null;
    return session;
  } catch (_) {
    return null;
  }
}

async function verifyFirebaseToken(idToken) {
  const response = await httpPostJson(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
    { idToken }
  );
  if (response.status !== 200) throw new Error('Token do Firebase inválido');
  const data = JSON.parse(response.body);
  const user = data.users?.[0];
  if (!user?.localId || !user?.email || user.emailVerified === false) {
    throw new Error('Conta do Google não verificada');
  }
  return user;
}

async function isAuthorizedInFirestore(idToken, email) {
  const documentUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}`
    + `/databases/(default)/documents/authorizedEmails/${encodeURIComponent(email)}`;
  const response = await httpGet(documentUrl, { Authorization: `Bearer ${idToken}` });
  return response.status === 200;
}

app.post('/api/session', async (req, res) => {
  try {
    if (!req.body?.idToken) return res.status(400).json({ error: 'Token obrigatório' });
    const user = await verifyFirebaseToken(req.body.idToken);
    const email = user.email.toLowerCase();
    if (!await isAuthorizedInFirestore(req.body.idToken, email)) {
      console.warn(`[auth] Acesso negado para ${email}`);
      return res.status(403).json({ error: 'Esta conta não está autorizada.' });
    }
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const cookie = [
      `xoxotv_session=${encodeURIComponent(signSession(user))}`,
      'HttpOnly',
      'SameSite=Strict',
      'Path=/',
      `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
      secure ? 'Secure' : '',
    ].filter(Boolean).join('; ');
    res.setHeader('Set-Cookie', cookie);
    res.json({ uid: user.localId, email: user.email, displayName: user.displayName || '' });
  } catch (error) {
    console.error('[auth] Falha ao criar sessão:', error.message);
    res.status(401).json({ error: 'Não foi possível validar sua conta.' });
  }
});

app.delete('/api/session', (req, res) => {
  res.setHeader('Set-Cookie', 'xoxotv_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.sendStatus(204);
});

app.use('/api', (req, res, next) => {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Faça login para acessar.' });
  req.user = session;
  next();
});

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

    // Prioriza MP4 combinado (vídeo + áudio) para o proxy receber uma única URL.
    execFile('yt-dlp', [
      '-f', '22/best[ext=mp4]/best',
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
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy();
    });

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
