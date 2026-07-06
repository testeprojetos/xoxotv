// Decoda as URLs encontradas na resposta do batchexecute
const raw = `[["wrb.fr","WcwnYd","[1,null,[[\\\"https://rr1---sn-jhqoxucg-jo4e.googlevideo.com/videoplayback?expire\\\\u003d1783208126\\\\u0026ei\\\\u003dPihJasKvGLu8y9YPxZ_d6QQ\\\\u0026ip\\\\u003d177.74.234.65\\\\u0026id\\\\u003de8012196e17a0829\\\\u0026itag\\\\u003d18\\\\u0026source\\\\u003dblogger\\\\u0026requiressl\\\\u003dyes\\\\u0026xpc\\\\u003dEgho7Zf3LnoBAQ\\\\u003d\\\\u003d\\\\u0026cps\\\\u003d335\\\\u0026met\\\\u003d1783179326,\\\\u0026mh\\\\u003dOi\\\\u0026mm\\\\u003d31\\\\u0026mn\\\\u003dsn-jhqoxucg-jo4e\\\\u0026ms\\\\u003dau\\\\u0026mv\\\\u003dm\\\\u0026mvi\\\\u003d1\\\\u0026pcm2cms\\\\u003dyes\\\\u0026pl\\\\u003d24\\\\u0026rms\\\\u003dau,au\\\\u0026susc\\\\u003dbl\\\\u0026svpuc\\\\u003d1\\\\u0026eaua\\\\u003d_HQ-_CIGMMI\\\\u0026mime\\\\u003dvideo/mp4\\\\u0026vprv\\\\u003d1\\\\u0026rqh\\\\u003d1\\\\u0026dur\\\\u003d1477.183\\\\u0026lmt\\\\u003d1603672531584948\\\\u0026mt\\\\u003d1783178940\\\\u0026txp\\\\u003d1319224\\\\u0026sparams\\\\u003dexpire,ei,ip,id,itag,source,requiressl,xpc,susc,svpuc,eaua,mime,vprv,rqh,dur,lmt\\\\u0026sig\\\\u003dAHEqNM4wRAIgL9DV4NYGXiW9j_iuTvbDvIdN1HJqTsCBxdwGebs1S0QCIFzDTzQnae78ciLZdhh-KtW4CNiLF-O2Gv13-vlBhKT2\\\\u0026lsparams\\\\u003dcps,met,mh,mm,mn,ms,mv,mvi,pcm2cms,pl,rms\\\\u0026lsig\\\\u003dAPaTxxMwRQIgTyvhenWpA2lfV1JZnamv31xs9ZplbSz-enaBI0COyScCIQDRu0FkYsvaan0ppXQ-wb8lpcuexTA8CfxbM3xn3qzTQg\\\\u003d\\\\u003d\\\",[18]],[\\\"https://rr1---sn-jhqoxucg-jo4e.googlevideo.com/videoplayback?expire\\\\u003d1783208126\\\\u0026ei\\\\u003dPihJasKvGLu8y9YPxZ_d6QQ\\\\u0026ip\\\\u003d177.74.234.65\\\\u0026id\\\\u003de8012196e17a0829\\\\u0026itag\\\\u003d22\\\\u0026source\\\\u003dblogger\\\\u0026requiressl\\\\u003dyes\\\\u0026xpc\\\\u003dEgho7Zf3LnoBAQ\\\\u003d\\\\u003d\\\\u0026cps\\\\u003d335\\\\u0026met\\\\u003d1783179326,\\\\u0026mh\\\\u003dOi\\\\u0026mm\\\\u003d31\\\\u0026mn\\\\u003dsn-jhqoxucg-jo4e\\\\u0026ms\\\\u003dau\\\\u0026mv\\\\u003dm\\\\u0026mvi\\\\u003d1\\\\u0026pcm2cms\\\\u003dyes\\\\u0026pl\\\\u003d24\\\\u0026rms\\\\u003dau,au\\\\u0026susc\\\\u003dbl\\\\u0026svpuc\\\\u003d1\\\\u0026eaua\\\\u003d_HQ-_CIGMMI\\\\u0026mime\\\\u003dvideo/mp4\\\\u0026vprv\\\\u003d1\\\\u0026rqh\\\\u003d1\\\\u0026dur\\\\u003d1477.183\\\\u0026lmt\\\\u003d1603672499959359\\\\u0026mt\\\\u003d1783178940\\\\u0026txp\\\\u003d1311224\\\\u0026sparams\\\\u003dexpire,ei,ip,id,itag,source,requiressl,xpc,susc,svpuc,eaua,mime,vprv,rqh,dur,lmt\\\\u0026sig\\\\u003dAHEqNM4wRgIhAMEfc7gIU5jFuErXIUDKlas27wiRdq6h0YNPHqKmCeCtAiEAgUwca9zl2DFAhsUIH7HfzwwepPHRfiXlhjAr66xXjtU\\\\u003d\\\\u0026lsparams\\\\u003dcps,met,mh,mm,mn,ms,mv,mvi,pcm2cms,pl,rms\\\\u0026lsig\\\\u003dAPaTxxMwRQIgF-adNq7Ikioq-Tzz8nvzxCr3u_RDT6-2YAqO5Kd04ZECIQDSgGvJo26n1Wb9uM87r03074fpb5HUfU5evlThCpwrOg\\\\u003d\\\\u003d\\\",[22]]]]`;

// A resposta real vem do batchexecute — extrai e decodifica o JSON interno
const innerMatch = raw.match(/"WcwnYd","(.*?)",null,null,null/s);

// Decodifica unicode escapes
function decodeUnicode(str) {
  return str
    .replace(/\\u003d/g, '=')
    .replace(/\\u0026/g, '&')
    .replace(/\\u003c/g, '<')
    .replace(/\\u003e/g, '>')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"');
}

// Extrai URLs diretamente com regex
const urlPattern = /https:\/\/rr[^\\"]+googlevideo\.com\/videoplayback[^\\"]+/g;
const rawText = decodeUnicode(raw);
const urls = [...rawText.matchAll(urlPattern)];

console.log('=== URLs do vídeo decodificadas ===\n');
urls.forEach((m, i) => {
  console.log(`URL ${i + 1} (itag=${new URL(m[0]).searchParams.get('itag')}):`);
  console.log(m[0]);
  console.log();
});

// Identifica a qualidade
const itagMap = { '18': '360p MP4', '22': '720p MP4', '37': '1080p MP4', '17': '144p 3GP' };
console.log('=== Qualidades disponíveis ===');
urls.forEach((m) => {
  try {
    const url = new URL(m[0]);
    const itag = url.searchParams.get('itag');
    const expire = url.searchParams.get('expire');
    const expireDate = expire ? new Date(parseInt(expire) * 1000).toISOString() : 'N/A';
    console.log(`itag ${itag} = ${itagMap[itag] || 'desconhecido'} | expira: ${expireDate}`);
  } catch (_) {}
});
