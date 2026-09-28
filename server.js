const express    = require('express');
const https      = require('https');
const path       = require('path');
const crypto     = require('crypto');
const { spawn } = require('child_process');

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
app.get('/vendor/hls.min.js', (_req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'hls.js', 'dist', 'hls.min.js'));
});
app.use(express.static(path.join(__dirname, 'public')));

// ─── Cache ────────────────────────────────────────────────────────────────────
const streamCache = new Map(); // episodeNumber -> { url, capturedAt }
const STREAM_TTL = 24 * 60 * 60 * 1000;
const HLS_CDN_BASE = 'https://cdn-s01.mywallpaper-4k-image.net/stream/sv/o/one-piece-dublado-v2';

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
  if (!user?.localId || !user?.email) {
    throw new Error('Conta do Firebase inválida');
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

// ─── Download ──────────────────────────────────────────────────────────────────────────

function safeDownloadFilename(raw, episodeId) {
  const fallback = `XoxoTV - Episodio ${episodeId}`;
  const base = String(raw || fallback)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\r\n]/g, ' ')
    .replace(/[^a-zA-Z0-9 ._()-]/g, '')
    .replace(/\.mp4$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140) || fallback;
  return `${base}.mp4`;
}

// ─── Fonte de vídeo ────────────────────────────────────────────────────────────────
// O histórico continua usando os IDs antigos no navegador, mas a reprodução
// resolve o número exibido diretamente no CDN, sem depender do site de origem.
const HLS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Accept': 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9',
};

function parseEpisodeNumber(raw) {
  const normalized = String(raw || '').trim();
  const value = /^\d+$/.test(normalized) ? Number.parseInt(normalized, 10) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > 5000) {
    throw new Error('Número de episódio inválido');
  }
  return value;
}

function getHlsCandidates(episodeNumber) {
  const plain = String(episodeNumber);
  const padded = plain.padStart(2, '0');
  const names = [plain, padded, `${plain}v2`, `${padded}v2`, `${plain}v3`, `${padded}v3`];
  return [...new Set(names)].map(name => `${HLS_CDN_BASE}/${name}.mp4/index.m3u8`);
}

async function getAnimesDigitalStream(episodeNumber) {
  const cacheKey = String(episodeNumber);
  const cached = streamCache.get(cacheKey);
  if (cached && Date.now() - cached.capturedAt < STREAM_TTL) {
    console.log(`[cache] ✅ Usando HLS em cache para episódio ${episodeNumber}`);
    return cached;
  }

  for (const url of getHlsCandidates(episodeNumber)) {
    try {
      const manifest = await httpGet(url, HLS_HEADERS);
      if (manifest.status !== 200 || !manifest.body.trimStart().startsWith('#EXTM3U')) continue;
      const stream = { url, capturedAt: Date.now() };
      streamCache.set(cacheKey, stream);
      console.log(`[source] ✅ HLS direto encontrado para episódio ${episodeNumber}`);
      return stream;
    } catch (error) {
      console.warn(`[source] Falha ao testar candidato do episódio ${episodeNumber}: ${error.message}`);
    }
  }

  throw new Error(`Vídeo do episódio ${episodeNumber} não encontrado no CDN`);
}

// ─── API: /api/stream ─────────────────────────────────────────────────────────

app.get('/api/stream', async (req, res) => {
  try {
    const episodeNumber = parseEpisodeNumber(req.query.episode);
    console.log(`\n[API] /api/stream episode=${episodeNumber}`);
    await getAnimesDigitalStream(episodeNumber);
    res.json({
      url: `/api/proxy?episode=${episodeNumber}`,
      downloadUrl: `/api/download?episode=${episodeNumber}`,
      type: 'hls',
      quality: 'HD',
    });
  } catch (err) {
    console.error('[API] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: /api/proxy — entrega o manifesto HLS ao player ──────────────────

app.get('/api/proxy', async (req, res) => {
  try {
    const episodeNumber = parseEpisodeNumber(req.query.episode);
    const stream = await getAnimesDigitalStream(episodeNumber);
    const videoUrl = stream.url;
    console.log(`\n[PROXY] episode=${episodeNumber}`);
    console.log(`[PROXY] Piping: ${videoUrl.substring(0, 80)}...`);

    const rangeHeader = req.headers['range'];

    const upstreamHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'pt-BR,pt;q=0.9',
      'Referer': stream.url,
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
        streamCache.delete(String(episodeNumber));
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

let activeDownloads = 0;
let ffmpegHlsOptionsPromise = null;

function getFfmpegHlsOptions() {
  if (ffmpegHlsOptionsPromise) return ffmpegHlsOptionsPromise;
  ffmpegHlsOptionsPromise = new Promise((resolve, reject) => {
    const probe = spawn('ffmpeg', ['-hide_banner', '-h', 'demuxer=hls'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    probe.stdout.on('data', chunk => { output += chunk.toString(); });
    probe.stderr.on('data', chunk => { output += chunk.toString(); });
    probe.on('error', reject);
    probe.on('close', code => {
      if (code !== 0) return reject(new Error('FFmpeg indisponível'));
      resolve(output.includes('extension_picky')
        ? ['-extension_picky', '0']
        : ['-allowed_extensions', 'ALL']);
    });
  });
  return ffmpegHlsOptionsPromise;
}

app.get('/api/download', async (req, res) => {
  if (activeDownloads >= 2) {
    return res.status(429).json({ error: 'Já existem dois downloads sendo preparados. Tente novamente em instantes.' });
  }

  let converter = null;
  let counted = false;
  let finished = false;
  let clientClosed = false;
  try {
    const episodeNumber = parseEpisodeNumber(req.query.episode);
    const stream = await getAnimesDigitalStream(episodeNumber);
    const ffmpegHlsOptions = await getFfmpegHlsOptions();
    const safeName = safeDownloadFilename(req.query.filename, episodeNumber);
    activeDownloads += 1;
    counted = true;

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    converter = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      ...ffmpegHlsOptions,
      '-i', stream.url,
      '-map', '0:v?',
      '-map', '0:a?',
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let converterError = '';
    converter.stderr.on('data', chunk => {
      converterError = (converterError + chunk.toString()).slice(-4000);
    });
    converter.stdout.pipe(res);

    converter.on('error', error => {
      console.error('[download] Não foi possível iniciar o FFmpeg:', error.message);
      if (!res.headersSent) res.status(500).json({ error: 'Conversor de download indisponível' });
      else res.destroy(error);
    });
    converter.on('close', code => {
      finished = true;
      if (counted) activeDownloads = Math.max(0, activeDownloads - 1);
      counted = false;
      if (code !== 0 && !clientClosed) {
        console.error(`[download] FFmpeg encerrou com código ${code}: ${converterError.trim()}`);
        if (!res.headersSent) res.status(502).json({ error: 'Não foi possível preparar o episódio' });
        else if (!res.writableEnded) res.destroy();
      }
    });

    res.on('close', () => {
      if (!finished && converter && !converter.killed) {
        clientClosed = true;
        converter.kill('SIGKILL');
      }
    });
  } catch (err) {
    if (converter && !converter.killed) converter.kill('SIGKILL');
    if (counted) activeDownloads = Math.max(0, activeDownloads - 1);
    console.error('[download] Erro:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── API: /api/meta — metadados locais, sem depender do site de origem ────────

app.get('/api/meta', async (req, res) => {
  try {
    const episodeNumber = parseEpisodeNumber(req.query.episode || req.query.id);
    res.json({
      image: '/onepiece.jpeg',
      title: `One Piece — Episódio ${episodeNumber}`,
      cachedAt: Date.now(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: /api/debug — retorna a URL bruta (para diagnóstico) ─────────────────

app.get('/api/debug', async (req, res) => {
  try {
    const episodeNumber = parseEpisodeNumber(req.query.episode || req.query.id);
    const stream = await getAnimesDigitalStream(episodeNumber);
    const parsed = new URL(stream.url);
    res.json({
      episode: episodeNumber,
      host: parsed.hostname,
      type: 'hls',
      cached: streamCache.has(String(episodeNumber)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🎬 XoxôTV rodando em http://localhost:${PORT}`);
  console.log('   Fonte: CDN HLS direto\n');
});
