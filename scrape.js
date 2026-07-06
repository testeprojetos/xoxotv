/**
 * Estratégia: extrair o token do Blogger do JS inline da página
 * e fazer a chamada batchexecute diretamente, simulando o que o player faz.
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const https = require('https');
const http = require('http');

puppeteer.use(StealthPlugin());

const TARGET_URL = 'https://goyabu.io/40431';

// Faz uma requisição HTTP manualmente
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const lib = url.startsWith('https') ? https : http;
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

(async () => {
  console.log('=== FASE 1: Extraindo token do Blogger via Puppeteer ===\n');

  const browser = await puppeteer.launch({
    headless: true, // headless — não precisa abrir janela, só queremos o HTML
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' });

  // Bloqueia recursos desnecessários para ser mais rápido
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  // Coleta os cookies que serão necessários para o batchexecute
  let cookies = '';
  page.on('response', async (res) => {
    const hdrs = res.headers();
    if (hdrs['set-cookie']) {
      // Coleta cookies do goyabu
      if (res.url().includes('goyabu.io')) {
        console.log('[COOKIE]', hdrs['set-cookie'].substring(0, 100));
      }
    }
  });

  console.log('Carregando página (sem renderizar player)...');
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 1500));

  // Extrai o HTML e procura pelo token
  const html = await page.content();

  // Padrões para encontrar o token do Blogger
  const tokenPatterns = [
    /blogger\.com\/video\.g\?token=([A-Za-z0-9_\-=+/]{20,})/,
    /["']token["']\s*:\s*["']([A-Za-z0-9_\-=+/]{20,})["']/,
    /token=([A-Za-z0-9_\-=+/]{20,})/,
    /["'](AD6v5[A-Za-z0-9_\-=+/]{10,})["']/,  // tokens do blogger começam com AD6v5
    /["'](VVFh[A-Za-z0-9_\-=+/]{10,})["']/,   // outro padrão encontrado
  ];

  let bloggerToken = null;
  for (const pattern of tokenPatterns) {
    const match = html.match(pattern);
    if (match) {
      bloggerToken = match[1];
      console.log('Token encontrado:', bloggerToken.substring(0, 40) + '...');
      break;
    }
  }

  // Procura também nos scripts inline
  if (!bloggerToken) {
    const scripts = await page.$$eval('script:not([src])', (els) =>
      els.map((el) => el.textContent || '').join('\n')
    );
    for (const pattern of tokenPatterns) {
      const match = scripts.match(pattern);
      if (match) {
        bloggerToken = match[1];
        console.log('Token encontrado em script:', bloggerToken.substring(0, 40) + '...');
        break;
      }
    }
  }

  // Pega os cookies do browser para usar nas próximas requisições
  const pageCookies = await page.cookies();
  cookies = pageCookies.map((c) => `${c.name}=${c.value}`).join('; ');

  await browser.close();

  if (!bloggerToken) {
    console.log('Token não encontrado no HTML. Verificando o fonte direto...');

    // Tenta via requisição direta com headers de browser
    const res = await httpGet(TARGET_URL, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9',
    });

    console.log('Status HTTP direto:', res.status);
    for (const pattern of tokenPatterns) {
      const match = res.body.match(pattern);
      if (match) {
        bloggerToken = match[1];
        console.log('Token via HTTP direto:', bloggerToken.substring(0, 40) + '...');
        break;
      }
    }

    if (!bloggerToken) {
      console.log('\nNenhum token encontrado. Printando trecho do HTML para debug:');
      // Procura qualquer menção ao blogger no HTML
      const idx = res.body.indexOf('blogger');
      if (idx >= 0) {
        console.log('Contexto ao redor de "blogger":');
        console.log(res.body.substring(Math.max(0, idx - 100), idx + 300));
      }
      process.exit(1);
    }
  }

  console.log('\n=== FASE 2: Acessando Blogger Video com o token ===\n');

  const bloggerUrl = `https://www.blogger.com/video.g?token=${bloggerToken}`;
  console.log('URL:', bloggerUrl);

  const bloggerHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9',
    'Referer': TARGET_URL,
    'Cookie': cookies,
  };

  const bloggerRes = await httpGet(bloggerUrl, bloggerHeaders);
  console.log('Status Blogger:', bloggerRes.status);

  // Extrai o f.sid e bl para o batchexecute
  const fidMatch = bloggerRes.body.match(/"FdrFJe"\s*:\s*"([^"]+)"/);
  const blMatch = bloggerRes.body.match(/bl=([^&"'\s]+)/);
  const fSid = fidMatch ? fidMatch[1] : null;
  const bl = blMatch ? blMatch[1] : 'boq_bloggeruiserver_20260630.06_p0';

  console.log('f.sid:', fSid);
  console.log('bl:', bl);

  // Extrai cookies do Blogger
  const bloggerCookieHeader = bloggerRes.headers['set-cookie'];
  let bloggerCookies = '';
  if (bloggerCookieHeader) {
    const cookieArr = Array.isArray(bloggerCookieHeader) ? bloggerCookieHeader : [bloggerCookieHeader];
    bloggerCookies = cookieArr.map((c) => c.split(';')[0]).join('; ');
    console.log('Blogger cookies:', bloggerCookies.substring(0, 100));
  }

  if (!fSid) {
    console.log('\nNão foi possível extrair f.sid. HTML do Blogger (500 chars):');
    console.log(bloggerRes.body.substring(0, 500));
    process.exit(1);
  }

  console.log('\n=== FASE 3: Chamando batchexecute para obter URLs do vídeo ===\n');

  // Monta a requisição batchexecute exatamente como o Blogger faz
  const batchUrl = `https://www.blogger.com/_/BloggerVideoPlayerUi/data/batchexecute?rpcids=WcwnYd&source-path=%2Fvideo.g&f.sid=${fSid}&bl=${bl}&hl=pt-BR&_reqid=44365&rt=c`;

  // O body do batchexecute — formato específico do Google RPC
  // WcwnYd é o método que retorna as URLs do vídeo
  const batchBody = `f.req=%5B%5B%5B%22WcwnYd%22%2C%22%5B%5C%22${encodeURIComponent(bloggerToken)}%5C%22%5D%22%2Cnull%2C%221%22%5D%5D%5D&at=&`;

  console.log('POST URL:', batchUrl);
  console.log('Body:', decodeURIComponent(batchBody));

  const batchHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    'Accept': '*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9',
    'Referer': bloggerUrl,
    'Origin': 'https://www.blogger.com',
    'Cookie': bloggerCookies || cookies,
    'X-Same-Domain': '1',
  };

  const batchRes = await httpPost(batchUrl, batchBody, batchHeaders);
  console.log('\nStatus batchexecute:', batchRes.status);
  console.log('Resposta COMPLETA:');
  console.log(batchRes.body);

  // Tenta extrair URLs da resposta
  console.log('\n=== URLS ENCONTRADAS ===');
  const found = [];

  // Passo 1: extrai o payload interno (o segundo argumento do WcwnYd)
  // O formato é: ["wrb.fr","WcwnYd","<JSON_STRING_AQUI>", ...]
  const innerPayloadMatch = batchRes.body.match(/"WcwnYd","([\s\S]+?)",null,null,null/);
  
  if (innerPayloadMatch) {
    // O conteúdo é uma string JSON escapada — precisamos desescapar
    let innerJson = innerPayloadMatch[1];
    
    // Decodifica unicode escapes
    innerJson = innerJson.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
    // Remove barras extras restantes (artefato do JSON duplo-escapado)
    innerJson = innerJson.replace(/\\([=&])/g, '$1');
    
    // Extrai as URLs
    const urlRegex = /(https:\/\/[^"]+googlevideo[^"]+)/g;
    let m;
    while ((m = urlRegex.exec(innerJson)) !== null) {
      const url = m[1];
      if (!found.includes(url)) {
        found.push(url);
        console.log(`\n[URL ${found.length}]`);
        console.log(url);
        
        try {
          const u = new URL(url);
          const itag = u.searchParams.get('itag');
          const expire = u.searchParams.get('expire');
          const itagMap = { '18': '360p MP4', '22': '720p MP4', '37': '1080p MP4' };
          console.log(`  Qualidade: ${itagMap[itag] || 'itag ' + itag}`);
          if (expire) {
            const expDate = new Date(parseInt(expire) * 1000);
            console.log(`  Expira em: ${expDate.toLocaleString('pt-BR')}`);
          }
        } catch (_) {}
      }
    }
  } else {
    console.log('Não foi possível extrair o payload interno.');
  }

  if (found.length === 0) {
    console.log('Nenhuma URL de vídeo encontrada na resposta.');
    console.log('\nTentando outros padrões...');

    // Tenta extrair qualquer array JSON da resposta
    const jsonMatch = batchRes.body.match(/\[\[.*\]\]/s);
    if (jsonMatch) {
      console.log('JSON encontrado:', jsonMatch[0].substring(0, 500));
    }
  }
})();
