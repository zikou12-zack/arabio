// Cinevo (Movies & TV + TorBox Cached): a Stremio/Nuvio addon that lists every TorBox-cached
// release from TorBox Search, Torrentio, Knaben, YTS (movies) and EZTV (TV), and
// adds a release to TorBox only when it is tapped. Built on the same TorBox engine
// as the AnimeTosho + TorBox addon (v3.0.14): sealed API-key tokens, cached-only
// results, and fast tap-to-play (createtorrent -> mylist?id -> requestdl).
import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';

const manifest = {
  id: 'community.movietv.torbox', version: '1.13.0', name: '🎬 Cinevo',
  description: 'Movies & TV · TorBox. Cached releases from Torrentio, Comet, StremThru, Zilean, Knaben, YTS and EZTV, 720p and up. Every TorBox-cached result is listed; a release is added to TorBox only when you play it.',
  // tmdb: ids (titles with no IMDb id yet, e.g. from Arabio) need TMDB_API_KEY.
  resources: [{name:'stream', types:['movie','series'], idPrefixes:process.env.TMDB_API_KEY?['tt','tmdb:']:['tt']}],
  types: ['movie','series'], idPrefixes:process.env.TMDB_API_KEY?['tt','tmdb:']:['tt'], catalogs: [],
  behaviorHints: {configurable:true,configurationRequired:true}
};

function boundedInt(value,fallback,min,max){const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,Math.round(n))):fallback;}
// Time all sources together get to search before the cache check closes the list.
const DISCOVERY_BUDGET_MS=boundedInt(process.env.DISCOVERY_BUDGET_MS,8000,3000,14000);
// Hard limit for a whole stream request (search + cache check).
const STREAM_DEADLINE_MS=boundedInt(process.env.STREAM_DEADLINE_MS,14000,6000,25000);
// A tap must answer before the player's own ~15 s timeout.
const PLAY_BUDGET_MS=boundedInt(process.env.PLAY_BUDGET_MS,12000,6000,25000);
const RESULT_TTL_MS=10*60000;
const EZTV_MAX_PAGES=boundedInt(process.env.EZTV_MAX_PAGES,10,1,30);
const TORRENTIO_URL=String(process.env.TORRENTIO_URL||'https://torrentio.strem.fun').replace(/\/+$/,'').replace(/\/manifest\.json$/,'');
const YTS_URLS=(process.env.YTS_URL?[process.env.YTS_URL]:['https://yts.mx','https://yts.lt']).map(u=>u.replace(/\/+$/,''));
// MediaFusion public instances, tried in order. A password is only needed for a
// private instance (MEDIAFUSION_PASSWORD).
// All three public instances are asked at once (comma-separated list to override).
const MEDIAFUSION_URLS=String(process.env.MEDIAFUSION_URL||'https://mediafusion.elfhosted.com,https://mediafusion.forthewizards.uk,https://mediafusionfortheweebs.midnightignite.me')
  .split(',').map(u=>u.trim().replace(/\/+$/,'').replace(/\/manifest\.json$/,'')).filter(u=>/^https?:\/\//.test(u));
const MEDIAFUSION_LIVE_SEARCH=String(process.env.MEDIAFUSION_LIVE_SEARCH||'true')!=='false';
// StremThru public servers, asked together (comma-separated list to override).
const STREMTHRU_URLS=String(process.env.STREMTHRU_URL||'https://stremthru.elfhosted.com,https://stremthrufortheweebs.midnightignite.me')
  .split(',').map(u=>u.trim().replace(/\/+$/,'')).filter(u=>/^https?:\/\//.test(u));
// Zilean (Debrid Media Manager hashlists), tried in order.
// Comet (debrid search addon). Its public servers only answer through a debrid
// account, so your TorBox key is sent to them; they return TorBox-cached results only.
const COMET_URLS=String(process.env.COMET_URL||'https://comet.elfhosted.com,https://comet.feels.legal')
  .split(',').map(u=>u.trim().replace(/\/+$/,'').replace(/\/manifest\.json$/,'')).filter(Boolean);
const ZILEAN_URLS=String(process.env.ZILEAN_URL||'https://zileanfortheweebs.midnightignite.me,https://zilean.elfhosted.com')
  .split(',').map(u=>u.trim().replace(/\/+$/,'')).filter(u=>/^https?:\/\//.test(u));
// Lowest resolution listed (CAM is never listed). 720p by default.
const MIN_RESOLUTION=['2160p','1080p','720p','576p','480p'].includes(String(process.env.MIN_RESOLUTION||'').toLowerCase())?String(process.env.MIN_RESOLUTION).toLowerCase():'720p';
// Prepare the next episode in the background after answering (PREFETCH_NEXT=false to stop).
const PREFETCH_NEXT=String(process.env.PREFETCH_NEXT||'true')!=='false';
const EZTV_URLS=(process.env.EZTV_URL?[process.env.EZTV_URL]:['https://eztvx.to','https://eztv.wf']).map(u=>u.replace(/\/+$/,''));
const BROWSER_UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
async function fetchWithCause(url,opts){try{return await fetch(url,opts);}catch(e){throw Error(netError(e));}}
const EDGE_TTL_S=Math.max(0,Number(process.env.EDGE_CACHE_SECONDS||600));
const SOURCES=['Library','Torrentio','Comet','StremThru','Zilean','Knaben','YTS','EZTV','TorBoxSearch','MediaFusion'];
const SOURCE_DISPLAY={Library:'Your TorBox',Comet:'Comet',TorBoxSearch:'TorBox Search',StremThru:'StremThru',Zilean:'Zilean (DMM)'};
// MediaFusion's public instances hide torrent hashes, so it is off unless
// MEDIAFUSION_URL (your own instance) or ENABLE_MEDIAFUSION=true is set.
const disabled=name=>String(process.env[`DISABLE_${name.toUpperCase()}`]||'')==='true'
  ||(name==='MediaFusion'&&!process.env.MEDIAFUSION_URL&&String(process.env.ENABLE_MEDIAFUSION||'')!=='true')
  // TorBox Search could not connect from Vercel in testing; off unless asked for.
  ||(name==='TorBoxSearch'&&String(process.env.ENABLE_TORBOXSEARCH||'')!=='true')
;

// ---------- request scope: deadlines that never leak between requests ----------
const scopeStore=new AsyncLocalStorage();
function deadlineSignal(ms){
  const s=scopeStore.getStore();
  const bounded=s?Math.max(200,Math.min(ms,s.deadline-Date.now())):ms;
  return s?AbortSignal.any([s.signal,AbortSignal.timeout(bounded)]):AbortSignal.timeout(bounded);
}
function timeLeft(){const s=scopeStore.getStore();return s?Math.max(0,s.deadline-Date.now()):Infinity;}
function sleep(ms){
  const s=scopeStore.getStore();
  return new Promise((resolve,reject)=>{
    if(s?.signal.aborted)return reject(Error('deadline'));
    const t=setTimeout(()=>{s?.signal.removeEventListener('abort',stop);resolve();},ms);
    function stop(){clearTimeout(t);reject(Error('deadline'));}
    s?.signal.addEventListener('abort',stop,{once:true});
  });
}
function netError(e){
  const c=e?.cause;
  const detail=c?(c.code||c.message||String(c)):null;
  return detail&&!String(e.message).includes(detail)?`${e.message} (${String(detail).slice(0,80)})`:String(e?.message||e);
}
function stageError(stage,message){const e=new Error(message);e.stage=stage;return e;}
function safeError(e,key){return String(e?.message||e||'Unknown error').replaceAll(String(key||'')||'\u0000','[redacted]').replace(/https?:\/\/[^\s]+/g,'[url]').slice(0,180);}
async function getJSON(url,{timeout=6000,headers={},method='GET',body}={}){
  const r=await fetchWithCause(url,{method,headers:{Accept:'application/json','User-Agent':BROWSER_UA,...headers},body,signal:deadlineSignal(timeout)});
  if(!r.ok)throw Error(`HTTP ${r.status}`);
  const text=await r.text().catch(e=>{throw Error(netError(e));});
  try{return JSON.parse(text);}catch{throw Error('Response was not JSON (site may be blocking servers)');}
}
// ---------- shared store ----------
// Optional Upstash Redis (free tier; Vercel Marketplace adds these variables).
// Without it, everything stays in memory, as before.
const REDIS_URL=String(process.env.KV_REST_API_URL||process.env.UPSTASH_REDIS_REST_URL||'').replace(/\/+$/,'');
const REDIS_TOKEN=String(process.env.KV_REST_API_TOKEN||process.env.UPSTASH_REDIS_REST_TOKEN||'');
const hasRedis=!!(REDIS_URL&&REDIS_TOKEN);
let redisDownUntil=0;
async function redis(cmd){
  if(!hasRedis||redisDownUntil>Date.now())return null;
  try{
    const ac=new AbortController();const t=setTimeout(()=>ac.abort(),800);
    const r=await fetch(REDIS_URL,{method:'POST',headers:{authorization:`Bearer ${REDIS_TOKEN}`,'content-type':'application/json'},body:JSON.stringify(cmd),signal:ac.signal}).finally(()=>clearTimeout(t));
    if(!r.ok)throw Error(`HTTP ${r.status}`);
    return (await r.json())?.result??null;
  }catch(e){redisDownUntil=Date.now()+60000;console.warn('redis_unavailable',String(e.message||e).slice(0,60));return null;}
}
const memCache=new Map();
async function cacheGet(id){
  const hit=memCache.get(id);if(hit&&hit.until>Date.now())return hit.value;
  const raw=await redis(['GET',`cinevo:${id}`]);
  if(!raw)return null;
  try{const value=JSON.parse(raw);memCache.set(id,{value,until:Date.now()+60000});return value;}catch{return null;}
}
async function cacheSet(id,value,ttlMs){
  memCache.set(id,{value,until:Date.now()+ttlMs});
  if(memCache.size>300)memCache.delete(memCache.keys().next().value);
  await redis(['SET',`cinevo:${id}`,JSON.stringify(value),'PX',String(ttlMs)]);
}

// Try each mirror in turn; the first one that answers wins.
// Mirrors that just failed are skipped for 5 minutes (unless every mirror is down).
const mirrorDownUntil=new Map();
function liveMirrors(bases){
  const up=bases.filter(b=>(mirrorDownUntil.get(b)||0)<Date.now());
  return up.length?up:bases;
}
function markMirror(base,ok){
  const was=mirrorDownUntil.has(base);
  if(ok)mirrorDownUntil.delete(base);else mirrorDownUntil.set(base,Date.now()+5*60000);
  if(hasRedis&&(was||!ok))redis(['SET','cinevo:mirrors',JSON.stringify([...mirrorDownUntil]),'PX','300000']);
}
let mirrorsLoadedAt=0;
async function loadMirrorHealth(){
  if(!hasRedis||Date.now()-mirrorsLoadedAt<30000)return;
  mirrorsLoadedAt=Date.now();
  try{for(const [b,until] of JSON.parse(await redis(['GET','cinevo:mirrors'])||'[]'))if(until>Date.now())mirrorDownUntil.set(b,Math.max(until,mirrorDownUntil.get(b)||0));}catch{}
}
async function firstWorking(bases,build,opts){
  let last;
  for(const base of liveMirrors(bases)){
    try{const out=await getJSON(build(base),opts);markMirror(base,true);return out;}
    catch(e){last=e;markMirror(base,false);}
  }
  throw last||Error('No mirror answered');
}

// ---------- private config tokens (same scheme as the anime addon) ----------
function encryptionKey(){
  const secret=process.env.CONFIG_SECRET;
  if(!secret||secret.length<32)throw Error('Vercel CONFIG_SECRET must contain at least 32 characters');
  return createHash('sha256').update(secret).digest();
}
function seal(key){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey(),iv);
  const encrypted=Buffer.concat([cipher.update(key,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');
}
function unseal(token){
  if(!/^[A-Za-z0-9_-]{32,1024}$/.test(token))throw Error('Invalid configuration token');
  const buf=Buffer.from(token,'base64url');
  const dec=createDecipheriv('aes-256-gcm',encryptionKey(),buf.subarray(0,12));
  dec.setAuthTag(buf.subarray(12,28));
  return Buffer.concat([dec.update(buf.subarray(28)),dec.final()]).toString('utf8');
}
const keyHash=key=>createHash('sha256').update(key).digest('hex');

// ---------- release names: seasons, episodes, quality ----------
// Keeps Latin letters, digits and Arabic letters (with Arabic spelling variants unified).
const arNorm=s=>s.replace(/[\u064B-\u065F\u0670\u0640]/g,'').replace(/[أإآٱ]/g,'ا').replace(/ة/g,'ه').replace(/ى/g,'ي');
const clean=s=>arNorm(String(s||'').toLowerCase().normalize('NFKD').normalize('NFC')).replace(/['’]/g,'').replace(/&/g,' and ').replace(/[^a-z0-9\u0621-\u064A]+/g,' ').trim();
const pad=n=>String(n).padStart(2,'0');
const SEASON_WORDS={first:1,second:2,third:3,fourth:4,fifth:5,sixth:6,seventh:7,eighth:8,ninth:9,tenth:10};
// Every season a name states: S01, S01E05, 1x05, Season 1, 2nd Season, ranges S01-S05 / Seasons 1-3.
function statedSeasons(name){
  const s=String(name||'').replace(/[._]/g,' ');
  const out=new Set();
  const add=n=>{n=Number(n);if(n>=0&&n<=100)out.add(n);};
  const range=(a,b)=>{a=Number(a);b=Number(b);if(b>=a&&b-a<=60)for(let i=a;i<=b;i++)add(i);};
  for(const m of s.matchAll(/\bS(\d{1,2})\s*(?:-|~|to|&|\+)\s*S?(\d{1,2})\b(?!\s*E\d)/gi))range(m[1],m[2]);
  for(const m of s.matchAll(/\bseasons?\s*(\d{1,2})\s*(?:-|~|to|&|\+|and)\s*(\d{1,2})\b/gi))range(m[1],m[2]);
  for(const m of s.matchAll(/\bS(\d{1,2})\s*E\d{1,4}/gi))add(m[1]);
  for(const m of s.matchAll(/(?:^|[^\dx])(\d{1,2})x\d{2,3}(?!\d)/gi))add(m[1]);
  for(const m of s.matchAll(/\bS(\d{1,2})\b(?!\s*E\d)/gi))add(m[1]);
  for(const m of s.matchAll(/\bseason\s*(\d{1,2})\b/gi))add(m[1]);
  for(const m of s.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/gi))add(m[1]);
  for(const m of s.matchAll(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+season\b/gi))add(SEASON_WORDS[m[1].toLowerCase()]);
  return out;
}
// Episode labels: S01E05, S01E05E06 / S01E05-E06 / S01E05-06 (multi-episode), 1x05.
function episodeLabels(name,{bare:allowBare=true}={}){
  const s=String(name||'');
  const out=[];
  for(const m of s.matchAll(/\bS(\d{1,2})[ ._-]?E(\d{1,4})(?:(?:[ ._-]?E|-E?)(\d{1,4}))?(?!\d)/gi))
    out.push({s:Number(m[1]),from:Number(m[2]),to:Number(m[3]||m[2])});
  for(const m of s.matchAll(/(?:^|[^\dx])(\d{1,2})x(\d{2,3})(?:-(\d{2,3}))?(?!\d)/gi))
    out.push({s:Number(m[1]),from:Number(m[2]),to:Number(m[3]||m[2])});
  if(out.length||!allowBare)return out;
  // Episode without a season, common for Arabic series: "E05", "Ep.05", "Episode 5",
  // "E01-E10", "الحلقة 5". The season is the one the name states, otherwise 1.
  const bare=[...s.matchAll(/(?:^|[\s._\-\[(])(?:e|ep|eps|episode)[\s._-]?(\d{1,4})(?:[\s._]*-[\s._]*(?:e|ep)?[\s._-]?(\d{1,4}))?(?=$|[\s._\-\])])/gi),...s.matchAll(/(?:الحلقة|الحلقه|حلقة|حلقه)[\s._-]*(\d{1,4})(?:[\s._]*-[\s._]*(\d{1,4}))?/g)];
  if(bare.length){
    const seasons=statedSeasons(s);
    const se=seasons.size===1?[...seasons][0]:1;
    for(const m of bare)out.push({s:se,from:Number(m[1]),to:Number(m[2]||m[1])});
  }
  return out;
}
function labelsMatch(labels,season,episode){return labels.some(l=>l.s===season&&episode>=l.from&&episode<=Math.max(l.from,l.to));}
const COMPLETE_PACK=/\b(complete|collection|all[ ._-]seasons|the[ ._-]complete[ ._-]series|full[ ._-]series)\b/i;
// Is this release the episode, or a pack that can contain it?
function seriesReleaseFits(name,season,episode){
  const labels=episodeLabels(name);
  if(labels.length)return labelsMatch(labels,season,episode);
  const seasons=statedSeasons(name);
  if(seasons.size)return seasons.has(season);
  return COMPLETE_PACK.test(name);
}
// Title search results (Knaben) must start with the show/movie title, then a
// year, season, episode, country or quality marker: "The Office US S01E01",
// not "The Office Ladies".
const AFTER_TITLE=/^(?:(?:19|20)\d{2}|s\d{1,2}(?:e\d{1,4})?|season|seasons|\d{1,2}x\d{2,3}|complete|collection|us|uk|au|nz|ca|extended|remastered|unrated|directors|imax|2160p|1080p|720p|480p|4k|uhd|hdr|web|webrip|bluray|bdrip|hdtv|dvdrip|repack|proper|multi)\b/;
const AFTER_TITLE_EXTRA=/^(?:(?:e|ep)\d{1,4}\b|ep\b|eps\b|episode\b|(?:ال)?حلقه|مسلسل|فيلم|الموسم|موسم)/;
function titleFits(name,titles){
  const n=clean(name);
  return titles.filter(Boolean).some(t=>{
    const c=clean(t);
    if(!c||!n.startsWith(c))return false;
    const rest=n.slice(c.length).trim();
    return !rest||AFTER_TITLE.test(rest)||AFTER_TITLE_EXTRA.test(rest);
  });
}
function movieReleaseFits(name,year){
  if(episodeLabels(name).length)return false;
  if(!year)return true;
  const years=[...String(name).matchAll(/(?:^|[^\d])((?:19|20)\d{2})(?!\d)/g)].map(m=>Number(m[1]));
  return !years.length||years.some(y=>Math.abs(y-year)<=1);
}
function quality(name){
  const t=String(name||'');
  if(/\b(2160p|4k|uhd)\b/i.test(t))return '2160p';
  for(const q of ['1080p','720p','576p','480p'])if(new RegExp(`\\b${q}\\b`,'i').test(t))return q;
  if(/\b(cam|hdcam|ts|telesync|hdts)\b/i.test(t))return 'CAM';
  return null;
}
const QUALITY_RANK={'2160p':6,'1080p':5,'720p':4,'576p':3,'480p':2,null:1,CAM:0};
function tags(name){
  const t=String(name||'');
  const pick=(re,label)=>re.test(t)?label:null;
  return {
    hdr:pick(/\b(DV|DoVi|Dolby[ ._-]?Vision)\b/i,'DV')||pick(/\bHDR10\+|HDR10Plus\b/i,'HDR10+')||pick(/\bHDR(10)?\b/i,'HDR'),
    codec:pick(/\bAV1\b/i,'AV1')||pick(/\b(x265|h[ ._]?265|HEVC)\b/i,'HEVC')||pick(/\b(x264|h[ ._]?264|AVC)\b/i,'H.264'),
    audio:pick(/\bAtmos\b/i,'Atmos')||pick(/\bTrueHD\b/i,'TrueHD')||pick(/\bDTS[ ._-]?(HD|X)\b/i,'DTS-HD')||pick(/\bDTS\b/i,'DTS')||pick(/\b(DDP|DD\+|EAC3)/i,'DD+')||pick(/\b(AC3|DD)(?:[ ._]?[257][ ._]?[01])?\b/i,'DD')||pick(/\bAAC\b/i,'AAC'),
    source:pick(/\bREMUX\b/i,'REMUX')||pick(/\b(BluRay|BDRip|BRRip)\b/i,'BluRay')||pick(/\bWEB[ ._-]?DL\b/i,'WEB-DL')||pick(/\bWEB[ ._-]?Rip\b/i,'WEBRip')||pick(/\bHDTV\b/i,'HDTV'),
    multi:pick(/\b(MULTi|Dual[ ._-]?Audio)\b/i,'Multi-audio')
  };
}
// ---------- v1.4 release-name parser for the rich format ----------
// Languages: scene tags and words, mapped to a flag and short code.
const LANGS=[
  ['EN','🇬🇧',/\b(ENG|ENGLISH)\b/i],['FR','🇫🇷',/\b(FRENCH|TRUEFRENCH|VFF|VFQ|VFI|VF2|VF|FRA|FRE|FR)\b/i],
  ['AR','🇸🇦',/\b(ARABIC|ARA|AR)\b|عربي|مدبلج|مترجم|[\u0621-\u064A]{3}/i],['ES','🇪🇸',/\b(SPANISH|ESP|SPA|CASTELLANO)\b/i],['LATAM','🇲🇽',/\b(LATINO|LATAM|LAT)\b/i],
  ['IT','🇮🇹',/\b(ITALIAN|ITA)\b/i],['DE','🇩🇪',/\b(GERMAN|GER|DEU)\b/i],['PT','🇧🇷',/\b(PORTUGUESE|POR|PT-?BR|DUBLADO)\b/i],
  ['RU','🇷🇺',/\b(RUSSIAN|RUS)\b|[А-Яа-яЁё]{3,}/],['UK','🇺🇦',/\b(UKRAINIAN|UKR)\b/i],['PL','🇵🇱',/\b(POLISH|POL)\b/i],
  ['TR','🇹🇷',/\b(TURKISH|TUR)\b/i],['HI','🇮🇳',/\b(HINDI|HIN)\b/i],['JA','🇯🇵',/\b(JAPANESE|JPN|JAP)\b/i],
  ['KO','🇰🇷',/\b(KOREAN|KOR)\b/i],['ZH','🇨🇳',/\b(CHINESE|CHI|MANDARIN|CANTONESE)\b/i],['NL','🇳🇱',/\b(DUTCH|NLD)\b/i],
  ['CS','🇨🇿',/\b(CZECH|CZE)\b/i],['HU','🇭🇺',/\b(HUNGARIAN|HUN)\b/i],['GR','🇬🇷',/\b(GREEK|GRE)\b/i],
];
// The group of a release title (checked before any file name is appended).
function releaseGroup(name){
  const t=String(name||'').trim().split(/\s+(?=\S+\.(?:mkv|mp4|avi|m4v)$)/)[0];
  const tail=t.match(/-([A-Za-z0-9]{2,20})(?:\.(?:mkv|mp4|avi|m4v))?\s*(?:\[[^\]]*\])?$/)?.[1];
  if(tail&&!/^(HD|DL|MA|X|Rip|WEB|AAC|DTS|HDR|SDR|HEVC|AVC|\d+p|\d+)$/i.test(tail))return tail;
  return t.match(/^\[([^\]]{2,24})\]/)?.[1]||null;
}
function parseRelease(name){
  const t=String(name||'');
  const sp=t.replace(/[._]/g,' ');
  const has=re=>re.test(sp);
  const res=quality(t);
  const source=has(/(?:\b|BD)REMUX\b/i)?'BluRay REMUX':has(/\b(BluRay|Blu-Ray|BDRip|BRRip|BD)\b/i)?'BluRay':has(/\bWEB[ -]?DL\b/i)?'WEB-DL':has(/\bWEB[ -]?Rip\b/i)?'WEBRip':has(/\bWEB\b/i)?'WEB':has(/\bHDTV\b/i)?'HDTV':has(/\b(DVDRip|DVD)\b/i)?'DVD':has(/\b(HDCAM|CAM|TS|TELESYNC|HDTS|TC)\b/)?'CAM':null;
  const hdr=[];
  if(has(/\b(DV|DoVi|Dolby ?Vision)\b/i))hdr.push('DV');
  if(has(/\bHDR10(\+|Plus)/i))hdr.push('HDR10+');else if(has(/\bHDR10\b/i))hdr.push('HDR10');else if(has(/\bHDR\b/i))hdr.push('HDR');
  if(has(/\bHLG\b/i))hdr.push('HLG');
  const codec=has(/\bAV1\b/i)?'AV1':has(/\b(x265|h ?265|HEVC)\b/i)?'HEVC':has(/\b(x264|h ?264|AVC)\b/i)?'H.264':has(/\b(XviD|DivX)\b/i)?'XviD':null;
  const bit10=has(/\b10 ?bit\b/i);
  const audio=[];
  if(has(/\bTrueHD\b/i))audio.push('TrueHD');
  if(has(/\bDTS[ :-]?X\b/i))audio.push('DTS:X');else if(has(/\bDTS[ -]?HD( ?MA)?\b/i))audio.push('DTS-HD MA');else if(has(/\bDTS\b/i))audio.push('DTS');
  if(has(/\b(DDP|DD\+|EAC3|E-AC-3)/i))audio.push('DD+');else if(has(/\b(AC3|DD)(?= ?[257] ?[01]|\b)/i))audio.push('DD');
  if(!audio.length&&has(/\bAAC\b/i))audio.push('AAC');
  if(!audio.length&&has(/\bOpus\b/i))audio.push('Opus');
  if(has(/\bAtmos\b/i))audio.push('Atmos');
  // Channels: "5.1", "7 1", also glued to the codec ("DDP5 1", "AAC2.0").
  const ch=sp.match(/(?:\b|DDP|DD|AAC|AC3|EAC3|DTS|MA|Atmos|TrueHD)([257])[ .]?([01])(?:ch)?\b/i)?.slice(1,3).join('.')||null;
  const langs=LANGS.filter(([, ,re])=>re.test(sp)).map(([code,flag])=>({code,flag}));
  const multi=has(/\b(MULTi|MULTI ?AUDIO|DUAL ?AUDIO|DUAL)\b/i);
  const subs=has(/\bVOSTFR\b/i)?'FR subs':has(/\b(MSubs|MULTi ?SUBS?|Multisub|Subs)\b/i)?'Multi-subs':null;
  // Release group: "...x265-GROUP(.mkv)" at the end, or "[GROUP] ..." at the start.
  // Technical words after a hyphen (DTS-HD, WEB-DL) are not groups.
  const tail=t.trim().match(/-([A-Za-z0-9]{2,20})(?:\.(?:mkv|mp4|avi|m4v))?\s*(?:\[[^\]]*\])?$/)?.[1];
  const group=(tail&&!/^(HD|DL|MA|X|Rip|WEB|AAC|DTS|HDR|SDR|HEVC|AVC|\d+p|\d+)$/i.test(tail)?tail:null)||t.match(/^\[([^\]]{2,24})\]/)?.[1]||null;
  return {res,source,hdr,codec,bit10,audio,ch,langs,multi,subs,group:releaseGroup(t)||group,sd:has(/\b(SD|SDTV|DVDSCR|PDTV)\b/),
    repack:has(/\b(REPACK|PROPER)\b/i),extended:has(/\b(EXTENDED|UNCUT|DIRECTORS? ?CUT|IMAX)\b/i),
    remastered:has(/\bREMASTERED\b/i)};
}
// Ranking inside one resolution: REMUX > BluRay > WEB-DL > WEBRip > HDTV > DVD,
// then DV/HDR, single episodes before packs, then size and seeders.
const SOURCE_SCORE={'BluRay REMUX':60,BluRay:50,'WEB-DL':40,WEB:35,WEBRip:30,HDTV:15,DVD:10,CAM:-500};
// Releases never listed: CAM/telesync, and anything below MIN_RESOLUTION.
// Without a resolution tag, an SD-only source (DVD, XviD/DivX, "SD") counts as
// below 720p; anything else without a tag is kept.
const RES_ORDER=['480p','576p','720p','1080p','2160p'];
function belowFloor(p){
  if(p.source==='CAM'||p.res==='CAM')return true;
  if(p.res)return RES_ORDER.indexOf(p.res)<RES_ORDER.indexOf(MIN_RESOLUTION);
  if(RES_ORDER.indexOf(MIN_RESOLUTION)>=RES_ORDER.indexOf('720p'))return p.source==='DVD'||p.codec==='XviD'||p.sd===true;
  return false;
}
function releaseScore(r,ctx){
  const p=r.parsed;
  let score=(QUALITY_RANK[p.res]??1)*1000+(SOURCE_SCORE[p.source]??20);
  if(p.hdr.includes('DV'))score+=8;else if(p.hdr.length)score+=5;
  if(p.audio.includes('Atmos')||p.audio.includes('TrueHD')||p.audio.includes('DTS-HD MA')||p.audio.includes('DTS:X'))score+=3;
  if(p.repack)score+=1;
  if(ctx.season>0&&r.isPack)score-=4;
  return score;
}
function formatSize(n){const x=Number(n);if(!Number.isFinite(x)||x<=0)return null;return x>=1024**3?`${(x/1024**3).toFixed(2)} GB`:`${Math.round(x/1024**2)} MB`;}
function hashFromMagnet(magnet){
  try{
    const u=new URL(String(magnet).replaceAll('&amp;','&'));
    if(u.protocol!=='magnet:')return null;
    const xt=u.searchParams.getAll('xt').find(t=>/^urn:btih:/i.test(t));
    const h=xt?.slice(9)||'';
    if(/^[a-f0-9]{40}$/i.test(h))return h.toLowerCase();
    if(/^[a-z2-7]{32}$/i.test(h)){
      let bits='';for(const c of h.toUpperCase())bits+='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5,'0');
      return Array.from({length:20},(_,i)=>parseInt(bits.slice(i*8,i*8+8),2).toString(16).padStart(2,'0')).join('');
    }
  }catch{}
  return null;
}
const validHash=h=>{const x=String(h||'').toLowerCase();return /^[a-f0-9]{40}$/.test(x)?x:null;};

// ---------- choosing the file inside a torrent ----------
const videoName=f=>String(f?.name||f?.short_name||'');
const isVideo=f=>/\.(mkv|mp4|avi|webm|m4v|ts|mov|wmv)$/i.test(videoName(f));
const isExtra=f=>/(^|[\/\\ ._-])(sample|trailer|featurette|extras?|behind[ ._-]the[ ._-]scenes|deleted[ ._-]scenes|interview|bonus)([\/\\ ._-]|$)/i.test(videoName(f));
const baseName=p=>String(p||'').split(/[\/\\]/).pop();
// Score a file for an episode: 3 = its name says SxxEyy; 2 = a folder says the
// season and the name says the episode; 0 = not this episode.
function episodeFileScore(f,season,episode){
  if(!isVideo(f)||isExtra(f))return 0;
  const path=videoName(f),name=baseName(path);
  const labels=episodeLabels(name,{bare:false});
  if(labels.length)return labelsMatch(labels,season,episode)?3:0;
  const own=statedSeasons(name);
  if(own.size&&!own.has(season))return 0;
  const folders=path.split(/[\/\\]/).slice(0,-1);
  const folderSeason=folders.map(statedSeasons).reverse().find(x=>x.size===1);
  // No season anywhere (common for Arabic series): it's season 1.
  const anySeason=own.size||folders.some(x=>statedSeasons(x).size);
  const s=own.size===1?[...own][0]:folderSeason?[...folderSeason][0]:(anySeason?null:1);
  if(s!==season)return 0;
  const n=String(episode);
  const bare=new RegExp(`(?:\\b(?:E|EP|Episode)[ ._-]*0*${n}(?!\\d)|(?:الحلقة|الحلقه|حلقة|حلقه)[ ._-]*0*${n}(?!\\d)|^0*${n}(?!\\d)|[ ._-]0*${n}[ ._-])`,'i');
  return bare.test(name.replace(/\.[^.]+$/,''))?2:0;
}
function chooseEpisodeFile(files,season,episode){
  let best=null,bestScore=0;
  for(const f of files){
    const score=episodeFileScore(f,season,episode);
    if(score>bestScore||(score&&score===bestScore&&Number(f.size||0)>Number(best?.size||0))){best=f;bestScore=score;}
  }
  return best;
}
// Movies: the main feature, never a sample or extra. In a collection, prefer the
// file that names this movie's title or year.
function chooseMovieFile(files,{title='',year=null}={}){
  const videos=files.filter(f=>isVideo(f)&&!isExtra(f));
  if(videos.length<=1)return videos[0]||null;
  const t=clean(title),y=year?String(year):'';
  // "Title Year" beats a year alone, which beats the title alone ("The Matrix"
  // is inside "The Matrix Reloaded"); size breaks ties.
  const score=f=>{const n=clean(baseName(videoName(f)));return (t&&y&&n.includes(`${t} ${y}`)?4:0)+(y&&n.includes(y)?2:0)+(t&&n.includes(t)?1:0);};
  return videos.map(f=>({f,s:score(f)})).sort((a,b)=>b.s-a.s||Number(b.f.size||0)-Number(a.f.size||0))[0].f;
}
function chooseFile(files,{season,episode,title,year}){
  return season>0?chooseEpisodeFile(files,season,episode):chooseMovieFile(files,{title,year});
}

// ---------- metadata ----------
const metaCache=new Map();
async function cinemeta(type,imdb){
  const k=`${type}:${imdb}`;const hit=metaCache.get(k);
  if(hit&&hit.until>Date.now())return hit.value;
  const body=await getJSON(`https://v3-cinemeta.strem.io/meta/${type}/${imdb}.json`,{timeout:3500});
  const m=body?.meta||{};
  const year=Number(String(m.year||m.releaseInfo||'').match(/(19|20)\d{2}/)?.[0])||null;
  const episodes={};
  for(const v of Array.isArray(m.videos)?m.videos:[]){const se=Number(v?.season),ep=Number(v?.episode??v?.number);if(se>0&&ep>0&&(v.name||v.title))episodes[`${se}:${ep}`]=String(v.name||v.title).slice(0,60);}
  const seasonLengths={};
  for(const v of Array.isArray(m.videos)?m.videos:[]){const se=Number(v?.season),ep=Number(v?.episode??v?.number);if(se>0&&ep>0)seasonLengths[se]=Math.max(seasonLengths[se]||0,ep);}
  const value={name:m.name||null,year,episodes,seasonLengths};
  metaCache.set(k,{value,until:Date.now()+6*3600000});
  if(metaCache.size>300)metaCache.delete(metaCache.keys().next().value);
  return value;
}

// ---------- other names (TMDB, optional) ----------
// Non-English titles are often released under other spellings ("Al Hayba",
// "El Hayba", "الهيبة"). With TMDB_API_KEY set, Knaben and Zilean search them too.
const TMDB_KEY=String(process.env.TMDB_API_KEY||'').trim().replace(/^["']|["']$/g,'').replace(/^Bearer\s+/i,'').trim();
async function tmdbGet(path,params={}){
  const bearer=TMDB_KEY.startsWith('eyJ');
  const q=new URLSearchParams(params);if(!bearer)q.set('api_key',TMDB_KEY);
  return getJSON(`https://api.themoviedb.org/3/${path}?${q}`,{timeout:3000,headers:bearer?{authorization:`Bearer ${TMDB_KEY}`}:{}});
}
async function otherNames(type,imdb){
  if(!TMDB_KEY)return null;
  const k=`names:${imdb}`;
  const hit=await cacheGet(k);if(hit)return hit;
  const found=await tmdbGet(`find/${imdb}`,{external_source:'imdb_id'});
  const item=(type==='movie'?found?.movie_results:found?.tv_results)?.[0];
  if(!item){await cacheSet(k,{names:[],lang:''},86400000);return {names:[],lang:''};}
  const kind=type==='movie'?'movie':'tv';
  const d=await tmdbGet(`${kind}/${item.id}`,{language:'en-US',append_to_response:'alternative_titles,translations'});
  const value=namesFromDetails(d);
  await cacheSet(k,value,7*86400000);
  return value;
}
function namesFromDetails(d){
  const names=[d?.title||d?.name,d?.original_title||d?.original_name];
  for(const t of d?.translations?.translations||[])if(['en','ar'].includes(t.iso_639_1))names.push(t.data?.title||t.data?.name);
  for(const t of d?.alternative_titles?.titles||d?.alternative_titles?.results||[])names.push(t.title);
  const seen=new Set(),out=[];
  for(const n of names){const c=clean(n);if(c.length>=3&&!seen.has(c)){seen.add(c);out.push(String(n).trim());}}
  return {names:out.slice(0,8),lang:d?.original_language||'',name:d?.title||d?.name||d?.original_title||d?.original_name||'',year:Number(String(d?.release_date||d?.first_air_date||'').slice(0,4))||null};
}
// A tmdb: id: its IMDb id if TMDB has one, plus its names for name searches.
async function tmdbIdentity(type,tid){
  if(!TMDB_KEY)return null;
  const k=`tmdbid:${type}:${tid}`;
  const hit=await cacheGet(k);if(hit)return hit;
  const d=await tmdbGet(`${type==='movie'?'movie':'tv'}/${tid}`,{language:'en-US',append_to_response:'alternative_titles,translations,external_ids'});
  const value={...namesFromDetails(d),imdb:/^tt\d+$/.test(d?.external_ids?.imdb_id||'')?d.external_ids.imdb_id:''};
  await cacheSet(k,value,value.imdb?7*86400000:86400000);
  return value;
}
// Names to search for: Cinemeta's name first, then (for non-English titles) up to 3 others.
function searchNames(ctx){
  const main=ctx.meta?.name;
  const extra=ctx.meta?.lang&&ctx.meta.lang!=='en'?(ctx.meta.altNames||[]).filter(n=>clean(n)!==clean(main)).slice(0,3):[];
  return [main,...extra].filter(Boolean);
}

// ---------- sources ----------
// Each returns [{source,title,hash,size,seeders,fileHint}] for this exact request.
const torboxSearchPause=new Map();
async function srcTorBoxSearch(ctx){
  const kh=keyHash(ctx.key).slice(0,24);
  if((torboxSearchPause.get(kh)||0)>Date.now())return {rows:[],status:'paused'};
  const u=new URL(`https://search-api.torbox.app/torrents/imdb_id:${ctx.imdb}`);
  u.searchParams.set('check_cache','true');u.searchParams.set('check_owned','false');u.searchParams.set('metadata','false');
  if(ctx.season>0){u.searchParams.set('season',String(ctx.season));u.searchParams.set('episode',String(ctx.episode));}
  // One quick retry: a connection that fails instantly is often a transient network error.
  let r;
  for(let attempt=0;;attempt++){
    try{r=await fetch(u.href,{headers:{Authorization:`Bearer ${ctx.key}`,Accept:'application/json','User-Agent':'MovieTVTorBox/1.2'},signal:deadlineSignal(7000)});break;}
    catch(e){if(attempt>=1||timeLeft()<3000)throw Error(netError(e));await sleep(300);}
  }
  const body=await r.json().catch(()=>null);
  if(!r.ok||body?.success===false){
    // Free plan, bad key or rate limit: pause for this user only.
    const code=String(body?.error||'');
    const pause=r.status===429?60000:(r.status===401||r.status===403||/TOKEN|PLAN|AUTH/i.test(code))?30*60000:0;
    if(pause)torboxSearchPause.set(kh,Date.now()+pause);
    throw Error(`HTTP ${r.status}${code?` ${code.slice(0,40)}`:''}`);
  }
  const list=Array.isArray(body?.data?.torrents)?body.data.torrents:[];
  return {rows:list.filter(x=>x&&x.cached!==false).map(x=>({source:'TorBoxSearch',title:String(x.raw_title||x.title||''),hash:validHash(x.hash)||hashFromMagnet(x.magnet||''),size:Number(x.size)||0,seeders:Number(x.last_known_seeders)||0})),status:'ok',found:list.length};
}
async function srcTorrentio(ctx){
  const id=ctx.season>0?`${ctx.imdb}:${ctx.season}:${ctx.episode}`:ctx.imdb;
  const body=await getJSON(`${TORRENTIO_URL}/stream/${ctx.type}/${id}.json`,{timeout:7000});
  const streams=Array.isArray(body?.streams)?body.streams:[];
  const rows=[];
  for(const s of streams){
    const hash=validHash(s?.infoHash);if(!hash)continue;
    const lines=String(s.title||s.description||'').split('\n');
    const statsAt=lines.findIndex(l=>/👤|💾/.test(l));
    const named=(statsAt>=0?lines.slice(0,statsAt):lines).filter(Boolean);
    const stats=statsAt>=0?lines[statsAt]:'';
    const sizeM=stats.match(/💾\s*([\d.]+)\s*([KMGT])B/i);
    const size=sizeM?Number(sizeM[1])*1024**('KMGT'.indexOf(sizeM[2].toUpperCase())+1):0;
    rows.push({source:'Torrentio',title:named[0]||'',fileHint:s.behaviorHints?.filename||named[named.length-1]||'',hash,size,seeders:Number(stats.match(/👤\s*(\d+)/)?.[1])||0});
  }
  return {rows,status:'ok',found:streams.length};
}
// MediaFusion: same request as Torrentio plus an encoded settings header
// (no debrid, no catalogs). Answers are cached for 30 minutes and shared by all
// users of this addon, to keep load on the public instances low (fair use).
const mediafusionCache=new Map();
function mediafusionHeader(){
  const settings={ap:String(process.env.MEDIAFUSION_PASSWORD||''),nf:['Disable'],cf:['Disable'],lss:MEDIAFUSION_LIVE_SEARCH};
  return Buffer.from(JSON.stringify(settings)).toString('base64url');
}
// One MediaFusion stream -> row. Handles both response styles:
// - /kodi/stream (MediaFusion's machine-readable route): {stream, metadata:{info_hash,name,size,seeders}}
// - /stream (the normal Stremio route): {infoHash, description, behaviorHints:{videoSize,filename}}
function mediafusionRow(item){
  const meta=item?.metadata&&typeof item.metadata==='object'?item.metadata:null;
  const st=item?.stream&&typeof item.stream==='object'?item.stream:item;
  const hash=validHash(meta?.info_hash)||validHash(st?.infoHash)||validHash(item?.infoHash)||hashFromMagnet(String(st?.url||''));
  if(!hash)return null;
  const lines=String(st?.description||st?.title||'').split('\n').map(l=>l.trim()).filter(Boolean);
  const title=String(meta?.name||'').trim()||(lines[0]||'').replace(/^📂\s*/,'').replace(/\s*┈➤.*$/,'').trim();
  const seeders=Number(meta?.seeders)||Number(lines.find(l=>l.includes('👤'))?.match(/👤\s*(\d+)/)?.[1])||0;
  const size=Number(meta?.size)||Number(st?.behaviorHints?.videoSize)||0;
  return {source:'MediaFusion',title,fileHint:st?.behaviorHints?.filename||'',hash,size,seeders};
}
async function mediafusionInstance(base,ctx,id){
  const headers={encoded_user_data:mediafusionHeader()};
  const out={base,rows:[],streams:0,error:null,route:null};
  for(const [route,url] of [['kodi',`${base}/kodi/stream/${ctx.type}/${id}.json?page_size=100`],['stremio',`${base}/stream/${ctx.type}/${id}.json`]]){
    try{
      const body=await getJSON(url,{timeout:6500,headers});
      const streams=Array.isArray(body?.streams)?body.streams:[];
      const rows=streams.map(mediafusionRow).filter(Boolean);
      out.streams=Math.max(out.streams,streams.length);out.route=route;
      if(rows.length){out.rows=rows;out.error=null;return out;}
      // Streams but no hashes: this instance hides them; the other route won't differ.
      if(streams.length){out.message=String(streams[0]?.description||streams[0]?.title||streams[0]?.stream?.description||streams[0]?.name||'').replace(/\s+/g,' ').slice(0,120);return out;}
      // An empty answer is a real answer; only a failed route falls through.
      return out;
    }catch(e){out.error=String(e.message||e).slice(0,60);}
  }
  return out;
}
async function srcMediaFusion(ctx){
  const id=ctx.season>0?`${ctx.imdb}:${ctx.season}:${ctx.episode}`:ctx.imdb;
  const cacheKey=`${ctx.type}:${id}`;
  const hit=mediafusionCache.get(cacheKey);
  if(hit&&hit.until>Date.now())return {...hit.value,status:'ok (cached)'};
  const results=await Promise.all(MEDIAFUSION_URLS.map(b=>mediafusionInstance(b,ctx,id)));
  const rows=results.flatMap(r=>r.rows);
  const instances=Object.fromEntries(results.map(r=>[new URL(r.base).hostname,
    r.rows.length?`${r.rows.length} releases (${r.route} route)`:r.streams?`${r.streams} streams but torrent hashes hidden${r.message?` ("${r.message}")`:''}`:r.error?`error: ${r.error}`:'no releases']));
  const hidden=!rows.length&&results.some(r=>r.streams);
  if(!rows.length&&results.every(r=>r.error))throw Error(`all instances failed (${results.map(r=>r.error).join('; ')})`);
  const value={rows,found:rows.length,instances};
  // Cache only useful answers, so a temporary outage is retried next time.
  if(rows.length){
    mediafusionCache.set(cacheKey,{value,until:Date.now()+30*60000});
    if(mediafusionCache.size>500)mediafusionCache.delete(mediafusionCache.keys().next().value);
  }
  return {...value,status:hidden?'hashes_hidden':'ok'};
}
// StremThru: public Torznab search by IMDb ID (no login). For TV, the exact
// episode and the season (for packs) are asked at the same time. Torznab XML,
// read the same way Comet reads it: title + infohash + size (+ seeders).
const xmlText=v=>String(v||'').replace(/^<!\[CDATA\[|\]\]>$/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&amp;/g,'&').trim();
function torznabItems(xml){
  const items=[];
  for(const m of String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)){
    const body=m[1];
    const title=xmlText(body.match(/<title>([\s\S]*?)<\/title>/i)?.[1]);
    const attrs={};
    for(const a of body.matchAll(/<torznab:attr\b([^>]*)\/?>/gi)){
      const name=a[1].match(/\bname="([^"]*)"/i)?.[1],value=a[1].match(/\bvalue="([^"]*)"/i)?.[1];
      if(name)attrs[name.toLowerCase()]=xmlText(value);
    }
    const size=Number(attrs.size||body.match(/<size>(\d+)<\/size>/i)?.[1])||0;
    items.push({title,hash:validHash(attrs.infohash)||hashFromMagnet(attrs.magneturl||''),size,seeders:Number(attrs.seeders)||0});
  }
  return items;
}
// StremThru, two routes per server, asked at the same time:
// - Torz addon in P2P mode (no debrid login; keeps torrent hashes):
//   /stremio/torz/{base64 settings}/stream/{type}/{id}.json
// - Torznab search: /v0/torznab/api (some public servers switch this off: HTTP 404)
// StremThru reads settings as standard base64 in the URL path: avoid "/" by
// adding spaces to the JSON (still valid) until the encoding has none.
function b64NoSlash(obj){
  const json=JSON.stringify(obj);
  for(let pad=0;pad<12;pad++){const b=Buffer.from(json.replace('{','{'+' '.repeat(pad))).toString('base64');if(!b.includes('/'))return encodeURIComponent(b);}
  return encodeURIComponent(Buffer.from(json).toString('base64'));
}
const TORZ_P2P=b64NoSlash({stores:[{c:'p2p',t:''}]});
function torzRow(st){
  // P2P mode gives infoHash; TorBox mode gives a playback URL .../tb/{hash}/{file}/.
  const hash=validHash(st?.infoHash)||validHash(String(st?.url||'').match(/\/_\/strem\/[^/]+\/[a-z]+\/([a-fA-F0-9]{40})\//)?.[1]);if(!hash)return null;
  const lines=String(st.description||st.title||'').split('\n').map(l=>l.trim());
  const folder=lines.find(l=>l.startsWith('📁'))?.replace(/^📁\s*/,'');
  const file=st.behaviorHints?.filename||lines.find(l=>l.startsWith('📄'))?.replace(/^📄\s*/,'')||'';
  const sizeM=lines.join(' ').match(/📦\s*([\d.]+)\s*([KMGT])B/i);
  return {title:folder||file,fileHint:file,hash,
    size:Number(st.behaviorHints?.videoSize)||(sizeM?Number(sizeM[1])*1024**('KMGT'.indexOf(sizeM[2].toUpperCase())+1):0),
    seeders:Number(lines.join(' ').match(/👤\s*(\d+)/)?.[1])||0};
}
async function stremthruTorz(base,ctx,cfg=TORZ_P2P){
  const id=ctx.season>0?`${ctx.imdb}:${ctx.season}:${ctx.episode}`:ctx.imdb;
  const body=await getJSON(`${base}/stremio/torz/${cfg}/stream/${ctx.type}/${id}.json`,{timeout:7000});
  if(!Array.isArray(body?.streams))throw Error('Torz answer had no stream list');
  return body.streams.map(torzRow).filter(Boolean);
}
async function stremthruTorznab(base,ctx){
  const searches=ctx.season>0
    ?[`t=tvsearch&imdbid=${ctx.imdb}&season=${ctx.season}&ep=${ctx.episode}`,`t=tvsearch&imdbid=${ctx.imdb}&season=${ctx.season}`]
    :[`t=movie&imdbid=${ctx.imdb}`];
  const results=await Promise.allSettled(searches.map(async q=>{
    const r=await fetchWithCause(`${base}/v0/torznab/api?${q}`,{headers:{Accept:'application/xml,text/xml','User-Agent':BROWSER_UA},signal:deadlineSignal(7000)});
    if(!r.ok)throw Error(`HTTP ${r.status}`);
    const xml=await r.text();
    // Torznab reports problems as <error code=".." description=".."/>.
    const err=xml.match(/<error\b[^>]*description="([^"]*)"/i)?.[1];
    if(err)throw Error(xmlText(err).slice(0,80));
    if(!/<rss\b|<channel\b/i.test(xml))throw Error('Response was not a Torznab feed (site may be blocking servers)');
    return torznabItems(xml);
  }));
  if(results.every(r=>r.status==='rejected'))throw results[0].reason;
  return results.flatMap(r=>r.status==='fulfilled'?r.value:[]);
}
async function srcStremThru(ctx){
  // TorBox mode sends your key to the StremThru server (like Comet) and returns
  // TorBox-cached releases; P2P and Torznab need no key but many servers switch them off.
  const tbCfg=b64NoSlash({stores:[{c:'tb',t:ctx.key}],cached:true});
  const jobs=liveMirrors(STREMTHRU_URLS).flatMap(base=>[...(/elfhosted\.com/.test(base)?[]:[['torbox',stremthruTorz(base,ctx,tbCfg)]]),['torz',stremthruTorz(base,ctx)],['torznab',stremthruTorznab(base,ctx)]].map(([route,p])=>p.then(rows=>({route,base,rows}),e=>({route,base,error:String(e.message||e).slice(0,60)}))));
  const results=await Promise.all(jobs);
  for(const base of new Set(results.map(r=>r.base)))markMirror(base,results.some(r=>r.base===base&&!r.error));
  const routes=Object.fromEntries(results.map(r=>[`${new URL(r.base).hostname} ${r.route}`,r.error?`error: ${r.error}`:`${r.rows.length} releases`]));
  if(results.every(r=>r.error))throw Error(`all routes failed (${results.map(r=>`${r.route}: ${r.error}`).join('; ')})`);
  const all=results.flatMap(r=>r.rows||[]);
  const rows=[];
  for(const it of all){
    if(!it.hash||/^invalid magnet$/i.test(it.title))continue;
    // ID-matched, but the season search can return other episodes: keep the
    // episode itself and packs that can contain it.
    const name=it.title||it.fileHint||'';
    if(ctx.season>0&&!seriesReleaseFits(name,ctx.season,ctx.episode)&&!(it.fileHint&&seriesReleaseFits(it.fileHint,ctx.season,ctx.episode)))continue;
    if(ctx.season===0&&episodeLabels(name).length)continue;
    rows.push({source:'StremThru',title:name,fileHint:it.fileHint||'',hash:it.hash,size:it.size,seeders:it.seeders});
  }
  return {rows,status:'ok',found:all.length,instances:routes};
}
// Comet reads its settings as standard base64 in the URL path, so a "/" in the
// encoding would break the route: add spaces (valid JSON) until there is none.
function cometConfig(key){
  const cfg={debridService:'torbox',debridApiKey:key,cachedOnly:true,removeTrash:true,maxResultsPerResolution:0,maxSize:0,resultFormat:['all'],enableTorrent:false};
  const json=JSON.stringify(cfg);
  for(let pad=0;pad<12;pad++){const b=Buffer.from(json.replace('{','{'+' '.repeat(pad))).toString('base64');if(!b.includes('/'))return encodeURIComponent(b);}
  return encodeURIComponent(Buffer.from(json).toString('base64'));
}
async function srcComet(ctx){
  const id=ctx.season>0?`${ctx.imdb}:${ctx.season}:${ctx.episode}`:ctx.imdb;
  const cfg=cometConfig(ctx.key);
  let body=null,last,used;
  for(const base of liveMirrors(COMET_URLS)){
    try{body=await getJSON(`${base}/${cfg}/stream/${ctx.type}/${id}.json`,{timeout:7000});if(!Array.isArray(body?.streams))throw Error('Comet answer had no stream list');markMirror(base,true);used=base;break;}
    catch(e){last=e;markMirror(base,false);}
  }
  if(!body)throw Error(String(last?.message||last||'Comet unavailable').replaceAll(ctx.key,'[redacted]'));
  const streams=body.streams;
  const rows=[];let notice='';
  for(const s of streams){
    const url=String(s?.url||'');
    const hash=validHash(s?.infoHash)||validHash(url.match(/\/playback\/([a-fA-F0-9]{40})\//)?.[1])||validHash(String(s?.behaviorHints?.bingeGroup||'').split('|').pop());
    if(!hash){if(/⚠|warn/i.test(String(s?.name||'')))notice=String(s.description||s.title||'').split('\n')[0].slice(0,100);continue;}
    let torrentName='';try{torrentName=new URL(url).searchParams.get('torrent_name')||'';}catch{}
    const fileHint=String(s.behaviorHints?.filename||'');
    const name=torrentName||fileHint;
    if(!name)continue;
    if(ctx.season>0&&!seriesReleaseFits(name,ctx.season,ctx.episode)&&!(fileHint&&seriesReleaseFits(fileHint,ctx.season,ctx.episode)))continue;
    if(ctx.season===0&&episodeLabels(name).length)continue;
    const text=`${s.name||''}\n${s.description||s.title||''}`;
    rows.push({source:'Comet',title:name,fileHint,hash,size:Number(s.behaviorHints?.videoSize)||0,seeders:Number(text.match(/👤\s*(\d+)/)?.[1])||0});
  }
  if(!rows.length&&notice)throw Error(`Comet says: ${notice}`);
  return {rows,status:'ok',found:streams.length,instances:{[new URL(used).hostname]:`${streams.length} streams`}};
}
// Zilean: releases that Debrid Media Manager users have downloaded and shared,
// so very often already cached. Asked by IMDb ID (exact) and by title (wider,
// checked against title/year/episode) at the same time.
async function srcZilean(ctx){
  const ep=ctx.season>0?`&season=${ctx.season}&episode=${ctx.episode}`:'';
  const names=searchNames(ctx);
  const run=async base=>{
    const queries=ctx.imdb?[[`ImdbId=${ctx.imdb}${ep.replace('season','Season').replace('episode','Episode')}`,true]]:[];
    for(const n of names)queries.push([`query=${encodeURIComponent(n)}${ep}`,false]);
    const results=await Promise.allSettled(queries.map(async([q,byId])=>{
      const body=await getJSON(`${base}/dmm/filtered?${q}`,{timeout:6000});
      if(!Array.isArray(body))throw Error('Zilean answer was not a list');
      return body.map(x=>({...x,byId}));
    }));
    if(results.every(r=>r.status==='rejected'))throw results[0].reason;
    return results.flatMap(r=>r.status==='fulfilled'?r.value:[]);
  };
  let all=null,last;
  for(const base of liveMirrors(ZILEAN_URLS)){try{all=await run(base);markMirror(base,true);break;}catch(e){last=e;markMirror(base,false);}}
  if(!all)throw last||Error('Zilean unavailable');
  const rows=[];
  for(const x of all){
    const name=String(x?.raw_title||'');
    const hash=validHash(x?.info_hash);
    if(!name||!hash)continue;
    if(!x.byId&&!titleFits(name,names))continue;
    if(ctx.season>0?!seriesReleaseFits(name,ctx.season,ctx.episode):!movieReleaseFits(name,ctx.meta?.year))continue;
    rows.push({source:'Zilean',title:name,hash,size:Number(x.size)||0,seeders:0});
  }
  return {rows,status:'ok',found:all.length};
}
async function srcKnaben(ctx){
  const names=searchNames(ctx);
  const title=names[0];
  if(!title)return {rows:[],status:'no_title'};
  const queries=ctx.season>0
    ?[`${title} S${pad(ctx.season)}E${pad(ctx.episode)}`,`${title} S${pad(ctx.season)}`,`${title} Season ${ctx.season}`,`${title} complete`]
    :[ctx.meta.year?`${title} ${ctx.meta.year}`:title];
  // Other names: the plain name (catches "E05", "الحلقة 5" and season packs).
  for(const n of names.slice(1))queries.push(ctx.season>0?n:(ctx.meta.year?`${n} ${ctx.meta.year}`:n));
  if(ctx.season>0&&names.length>1)queries.push(`${title} E${pad(ctx.episode)}`);
  const category=ctx.season>0?2000000:3000000;
  const results=await Promise.allSettled(queries.map(q=>getJSON('https://api.knaben.org/v1',{method:'POST',timeout:6000,
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({search_type:'100%',search_field:'title',query:q,order_by:'seeders',order_direction:'desc',from:0,size:150,hide_unsafe:true,hide_xxx:true,categories:[category]})})));
  const rows=[];let found=0,failed=0;
  for(const r of results){
    if(r.status==='rejected'){failed++;continue;}
    const hits=Array.isArray(r.value?.hits)?r.value.hits:[];found+=hits.length;
    for(const h of hits){
      const name=String(h?.title||'');
      // A title search can return other shows/movies: check the name.
      if(!titleFits(name,names))continue;
      if(ctx.season>0?!seriesReleaseFits(name,ctx.season,ctx.episode):!movieReleaseFits(name,ctx.meta.year))continue;
      const hash=validHash(h.hash)||hashFromMagnet(h.magnetUrl||'');
      if(hash)rows.push({source:'Knaben',title:name,hash,size:Number(h.bytes)||0,seeders:Number(h.seeders)||0});
    }
  }
  if(failed===results.length)throw results[0].reason;
  return {rows,status:'ok',found};
}
async function srcYTS(ctx){
  if(ctx.season>0)return {rows:[],status:'movies_only'};
  const body=await firstWorking(YTS_URLS,b=>`${b}/api/v2/list_movies.json?query_term=${ctx.imdb}&limit=5`,{timeout:5000});
  const movies=Array.isArray(body?.data?.movies)?body.data.movies.filter(m=>m?.imdb_code===ctx.imdb):[];
  const rows=[];
  for(const m of movies)for(const t of Array.isArray(m.torrents)?m.torrents:[]){
    const hash=validHash(t?.hash);if(!hash)continue;
    const kind={web:'WEB',bluray:'BluRay'}[String(t.type||'').toLowerCase()]||t.type||'';
    rows.push({source:'YTS',title:[m.title_long||m.title,t.quality,kind,t.video_codec,t.audio_channels?`${t.audio_channels}ch`:'','YTS'].filter(Boolean).join(' '),hash,size:Number(t.size_bytes)||0,seeders:Number(t.seeds)||0});
  }
  return {rows,status:'ok',found:rows.length};
}
async function srcEZTV(ctx){
  if(ctx.season<1)return {rows:[],status:'tv_only'};
  const digits=ctx.imdb.replace(/^tt/,'');
  let base=null;
  const page=async(n,b)=>getJSON(`${b}/api/get-torrents?imdb_id=${digits}&limit=100&page=${n}`,{timeout:6000});
  let first=null,last;
  for(const b of liveMirrors(EZTV_URLS)){try{first=await page(1,b);base=b;markMirror(b,true);break;}catch(e){last=e;markMirror(b,false);}}
  if(!first)throw last||Error('EZTV unavailable');
  const total=Number(first?.torrents_count)||0;
  const pages=Math.min(EZTV_MAX_PAGES,Math.ceil(total/100));
  const rest=await Promise.allSettled(Array.from({length:Math.max(0,pages-1)},(_,i)=>page(i+2,base)));
  const all=[...(first.torrents||[]),...rest.flatMap(r=>r.status==='fulfilled'&&Array.isArray(r.value?.torrents)?r.value.torrents:[])];
  const rows=[];
  for(const t of all){
    const name=String(t?.title||t?.filename||'');
    const s=Number(t?.season),e=Number(t?.episode);
    const fits=(s===ctx.season&&(e===ctx.episode||e===0))||seriesReleaseFits(name,ctx.season,ctx.episode);
    if(!fits||(s&&s!==ctx.season))continue;
    const hash=validHash(t.hash)||hashFromMagnet(t.magnet_url||'');
    if(hash)rows.push({source:'EZTV',title:name,hash,size:Number(t.size_bytes)||0,seeders:Number(t.seeds)||0});
  }
  return {rows,status:'ok',found:all.length,pagesRead:1+rest.filter(r=>r.status==='fulfilled').length};
}
// Plain-language explanations shown on the debug page.
const SOURCE_NOTES={needs_imdb:'This title has no IMDb id yet, so only name searches (Knaben, Zilean) can look for it.',
  paused:'TorBox Search refused this key. It needs a paid TorBox plan; the addon retries every 30 minutes.',
  hashes_hidden:'The MediaFusion instances answered but hide torrent hashes, so TorBox cannot check them. Use your own MediaFusion instance (MEDIAFUSION_URL) to get these results.',
  movies_only:'YTS only has movies.',tv_only:'EZTV only has TV shows.',timed_out:'Too slow: it did not answer within the time limit.'
};
const NAME_SOURCES=new Set(['Knaben','Zilean','Library']);
const SOURCE_FUNCS={Library:srcLibrary,Comet:srcComet,StremThru:srcStremThru,Zilean:srcZilean,TorBoxSearch:srcTorBoxSearch,Torrentio:srcTorrentio,MediaFusion:srcMediaFusion,Knaben:srcKnaben,YTS:srcYTS,EZTV:srcEZTV};

// ---------- TorBox ----------
const TORBOX='https://api.torbox.app/v1/api/torrents';
// Your own TorBox library: anything already downloaded there (added by you, by
// Cinevo, or by another addon using your key) that matches this title.
const libraryCache=new Map();
async function myLibrary(key){
  const id=createHash('sha256').update(key).digest('hex').slice(0,16);
  const hit=libraryCache.get(id);if(hit&&hit.until>Date.now())return hit.list;
  // Never hold up the search: give up after 2.5 s (the next search tries again).
  const list=await Promise.race([torbox(key,'mylist?bypass_cache=true&limit=1000'),new Promise((_,no)=>setTimeout(()=>no(Error('TorBox library is slow to answer; skipped this time')),2500))]);
  libraryCache.set(id,{list:Array.isArray(list)?list:[],until:Date.now()+60000});
  if(libraryCache.size>50)libraryCache.delete(libraryCache.keys().next().value);
  return Array.isArray(list)?list:[];
}
async function srcLibrary(ctx){
  const list=await myLibrary(ctx.key);
  const names=searchNames(ctx);
  if(!names.length)return {rows:[],status:'no_title',found:list.length};
  const rows=[];
  for(const t of list){
    const hash=validHash(t?.hash);if(!hash)continue;
    if(t.download_present===false&&t.download_finished===false)continue;
    const files=Array.isArray(t.files)?t.files:[];
    const cands=[String(t.name||''),...files.map(f=>String(f.short_name||f.name||'').split('/').pop())].filter(Boolean);
    const fit=cands.find(n=>titleFits(n,names)&&(ctx.season>0?seriesReleaseFits(n,ctx.season,ctx.episode):movieReleaseFits(n,ctx.meta?.year)));
    if(!fit)continue;
    rows.push({source:'Library',title:String(t.name||fit),fileHint:fit,hash,size:Number(t.size)||0,seeders:0});
  }
  return {rows,status:'ok',found:list.length};
}
async function torbox(key,endpoint,options={}){
  const r=await fetch(`${TORBOX}/${endpoint}`,{...options,headers:{Authorization:`Bearer ${key}`,...options.headers},signal:deadlineSignal(8000)});
  const data=await r.json().catch(()=>({}));
  if(!r.ok||data.success===false){
    // Never include query strings: requestdl carries the API token.
    const raw=data.error??data.detail??'request failed';
    throw Error(`TorBox ${String(endpoint).split('?')[0]}: HTTP ${r.status}; ${String(typeof raw==='string'?raw:JSON.stringify(raw)).replaceAll(key,'[redacted]').slice(0,200)}`);
  }
  return data.data;
}
function cacheEntry(data,hash){
  if(!data)return null;
  if(Array.isArray(data))return data.find(x=>String(x?.hash||x?.info_hash||'').toLowerCase()===hash)??null;
  if(typeof data==='object'){
    const keyed=Object.entries(data).find(([k])=>k.toLowerCase()===hash);
    if(keyed)return keyed[1];
    return Object.values(data).find(x=>x&&typeof x==='object'&&String(x.hash||x.info_hash||'').toLowerCase()===hash)??null;
  }
  return null;
}
function isCached(entry,hash){
  if(!entry||typeof entry!=='object'||Array.isArray(entry))return false;
  if(entry.cached===false||entry.is_cached===false)return false;
  const h=String(entry.hash||entry.info_hash||'').toLowerCase();
  if(h&&h!==hash)return false;
  return Boolean(h||(entry.cached===true&&(entry.name||entry.files)));
}
// All hashes, 50 per call, up to 4 calls at a time; one failed call never drops the rest.
async function cachedEntries(key,hashes){
  const chunks=[];for(let i=0;i<hashes.length;i+=50)chunks.push(hashes.slice(i,i+50));
  const out=new Map();let failures=0,next=0;
  await Promise.all(Array.from({length:Math.min(4,chunks.length)},async()=>{
    while(next<chunks.length){
      const chunk=chunks[next++];
      try{
        const params=new URLSearchParams({format:'object',list_files:'true'});
        for(const h of chunk)params.append('hash',h);
        const data=await torbox(key,`checkcached?${params}`);
        for(const h of chunk){const e=cacheEntry(data,h);if(isCached(e,h))out.set(h,e);}
      }catch{failures++;}
    }
  }));
  if(chunks.length&&failures===chunks.length)throw stageError('checkcached','TorBox cache check failed');
  return out;
}
const linkCache=new Map(),playInflight=new Map();
function pickTorrent(data,id,hash){
  const list=Array.isArray(data)?data:(Array.isArray(data?.torrents)?data.torrents:null);
  if(!list)return data&&typeof data==='object'?data:null;
  return list.find(x=>String(x?.id??x?.torrent_id)===String(id))||list.find(x=>String(x?.hash||'').toLowerCase()===hash)||null;
}
// Tap-to-play: three small calls, never the whole account list.
async function playWithTorbox(key,hash,want){
  const cacheKey=createHash('sha256').update(`${key}:${hash}:${want.season}:${want.episode}`).digest('hex');
  const hit=linkCache.get(cacheKey);
  if(hit&&hit.until>Date.now())return hit.value;
  if(playInflight.has(cacheKey))return playInflight.get(cacheKey);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),PLAY_BUDGET_MS);
  const job=scopeStore.run({signal:controller.signal,deadline:Date.now()+PLAY_BUDGET_MS},async()=>{
    const form=new FormData();
    form.set('magnet',`magnet:?xt=urn:btih:${hash}`);form.set('add_only_if_cached','true');form.set('allow_zip','false');
    let created;
    try{created=await torbox(key,'createtorrent',{method:'POST',body:form});}catch(e){throw stageError('createtorrent',e.message);}
    const id=created?.torrent_id??created?.id??created?.torrent?.id;
    if(id==null)throw stageError('createtorrent','TorBox did not return a torrent ID');
    let files=[],lastError=null;
    for(const delay of [0,350,700,1000,1400]){
      if(timeLeft()<2200)break;
      if(delay)await sleep(delay);
      try{
        const item=pickTorrent(await torbox(key,`mylist?bypass_cache=true&id=${encodeURIComponent(String(id))}`),id,hash);
        files=Array.isArray(item?.files)?item.files:[];
        if(files.length)break;
      }catch(e){lastError=e;}
    }
    if(!files.length)throw stageError('mylist_files',lastError?.message||'TorBox has not listed the files yet; try again in a moment');
    const file=chooseFile(files,want);
    if(!file)throw stageError('file_selection','No file in this torrent matches');
    let link;
    try{
      const params=new URLSearchParams({token:key,torrent_id:String(id),file_id:String(file.id??file.file_id),zip_link:'false'});
      const r=await torbox(key,`requestdl?${params}`);
      link=typeof r==='string'?r:(r?.url||r?.download_link);
    }catch(e){throw stageError('requestdl',e.message);}
    if(typeof link!=='string'||!/^https?:\/\//i.test(link))throw stageError('requestdl','TorBox returned no link');
    linkCache.set(cacheKey,{value:link,until:Date.now()+2*60000});
    if(linkCache.size>200)linkCache.delete(linkCache.keys().next().value);
    return link;
  });
  playInflight.set(cacheKey,job);
  try{return await job;}finally{clearTimeout(timer);playInflight.delete(cacheKey);}
}

// ---------- the stream request ----------
async function findStreams(key,type,id,origin){
  const m=/^(tt\d+|tmdb:\d+)(?::(\d+):(\d+))?$/.exec(id);
  if(!m)return {streams:[],report:{error:'unsupported_id'}};
  let imdb=m[1],tmdbMeta=null;
  if(imdb.startsWith('tmdb:')){
    const ident=await tmdbIdentity(type,imdb.slice(5)).catch(()=>null);
    if(!ident?.name)return {streams:[],report:{error:TMDB_KEY?'not_found_on_tmdb':'tmdb_key_missing'}};
    if(ident.imdb)imdb=ident.imdb;
    else{imdb=null;tmdbMeta={name:ident.name,year:ident.year,episodes:{},seasonLengths:{},altNames:ident.names,lang:ident.lang};}
  }
  const season=type==='series'?Number(m[2]||0):0,episode=type==='series'?Number(m[3]||0):0;
  // Series need a real season and episode (specials, season 0, are not searched).
  if(type==='series'&&(season<1||episode<1))return {streams:[],report:{error:'missing_episode'}};
  const started=Date.now();
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),STREAM_DEADLINE_MS);
  const report={sources:{},timings:{}};
  try{
    return await scopeStore.run({signal:controller.signal,deadline:started+STREAM_DEADLINE_MS},async()=>{
      const ctx={key,type,imdb,season,episode,meta:null};
      const metaJob=tmdbMeta?Promise.resolve(ctx.meta=tmdbMeta):Promise.all([cinemeta(type,imdb).catch(()=>null),otherNames(type,imdb).catch(()=>null)]).then(([cm,alt])=>{
        // Arabic titles missing from Cinemeta still get a name and year from TMDB.
        const base=cm?.name?cm:(alt?.name?{name:alt.name,year:alt.year,episodes:{},seasonLengths:{}}:cm);
        ctx.meta=base?{...base,altNames:alt?.names||[],lang:alt?.lang||''}:null;
        return ctx.meta;
      });
      const discoveryEnds=started+DISCOVERY_BUDGET_MS;
      const candidates=new Map();
      const add=rows=>{for(const r of rows){
        if(!r.hash)continue;
        const prev=candidates.get(r.hash);
        if(prev){prev.sources.add(r.source);prev.seeders=Math.max(prev.seeders,r.seeders||0);if(!prev.size&&r.size)prev.size=r.size;if(r.source==='Torrentio'&&!prev.fileHint)prev.fileHint=r.fileHint;if((!prev.title||prev.title.length<8)&&r.title)prev.title=r.title;}
        else candidates.set(r.hash,{...r,sources:new Set([r.source])});
      }};
      const runSource=async name=>{
        const t0=Date.now();
        if(disabled(name)){
          const notes={MediaFusion:'Off by default: the public MediaFusion instances hide torrent hashes. Set MEDIAFUSION_URL to your own instance to use it.',TorBoxSearch:'Off by default. Set ENABLE_TORBOXSEARCH=true to try it again.',StremThru:'Off by default: the public StremThru server switched off its torrent search (HTTP 404). Set STREMTHRU_URL to a server that has it.'};
          report.sources[name]={status:'disabled',...(notes[name]&&!process.env[`DISABLE_${name.toUpperCase()}`]?{note:notes[name]}:{})};return;
        }
        if(!ctx.imdb&&!NAME_SOURCES.has(name)){report.sources[name]={status:'needs_imdb',note:SOURCE_NOTES.needs_imdb};return;}
        try{
          if(NAME_SOURCES.has(name))await metaJob;
          const out=await Promise.race([SOURCE_FUNCS[name](ctx),sleep(Math.max(0,discoveryEnds-Date.now())).then(()=>({rows:[],status:'timed_out'}))]);
          add(out.rows||[]);
          report.sources[name]={status:out.status,found:out.found??out.rows?.length??0,matched:out.rows?.length||0,ms:Date.now()-t0,...(out.pagesRead?{pagesRead:out.pagesRead}:{}),...(out.instances?{instances:out.instances}:{})};
          if(SOURCE_NOTES[out.status])report.sources[name].note=SOURCE_NOTES[out.status];
        }catch(e){
          const error=safeError(e,key).slice(0,160);
          report.sources[name]={status:'error',error,ms:Date.now()-t0};
          const note=/HTTP (401|403)|PLAN|TOKEN|AUTH/i.test(error)?(name==='TorBoxSearch'?SOURCE_NOTES.paused:'This site is blocking the addon\'s server (common for cloud hosts like Vercel).'):/not JSON/i.test(error)?'The site answered with a web page instead of data (usually a Cloudflare block or a dead mirror).':/timeout|aborted|deadline/i.test(error)?'Too slow: it did not answer within the time limit.':null;
          if(note)report.sources[name].note=note;
        }
      };
      await Promise.all(SOURCES.map(runSource));
      await metaJob;
      report.timings.searchMs=Date.now()-started;
      // Drop CAM and anything under MIN_RESOLUTION before asking TorBox.
      let lowQuality=0;
      for(const [hash,c] of candidates)if(belowFloor(parseRelease(c.title))){candidates.delete(hash);lowQuality++;}
      report.droppedLowQuality=lowQuality;
      report.candidates=candidates.size;
      const cacheStart=Date.now();
      let cached=new Map();
      try{cached=await cachedEntries(key,[...candidates.keys()]);}catch(e){report.cacheError=safeError(e,key);}
      report.timings.cacheMs=Date.now()-cacheStart;
      const want={season:ctx.season,episode:ctx.episode,title:ctx.meta?.name||'',year:ctx.meta?.year||null};
      const listed=[];
      for(const [hash,c] of candidates){
        const entry=cached.get(hash);if(!entry)continue;
        const files=Array.isArray(entry.files)?entry.files:[];
        const file=files.length?chooseFile(files,want):null;
        // TorBox listed the files and none is this episode/movie: skip it.
        if(files.length&&!file)continue;
        listed.push({...c,title:c.title||entry.name||'',file,size:Number(file?.size)||c.size||Number(entry.size)||0});
      }
      for(const r of listed){
        r.parsed=parseRelease(`${r.title} ${r.file?baseName(videoName(r.file)):''}`);
        r.drop=belowFloor(r.parsed);
        r.isPack=ctx.season>0&&!episodeLabels(r.title).length;
        r.score=releaseScore(r,ctx);
      }
      const kept=listed.filter(r=>!r.drop);
      report.droppedLowQuality+=listed.length-kept.length;
      listed.length=0;listed.push(...kept);
      listed.sort((a,b)=>b.score-a.score||Number(b.size)-Number(a.size)||b.seeders-a.seeders);
      report.cached=listed.length;report.timings.totalMs=Date.now()-started;
      const perSource={};for(const r of listed)for(const s of r.sources)perSource[s]=(perSource[s]||0)+1;
      report.cachedBySource=perSource;
      report.namesSearched=searchNames(ctx);
      return {streams:listed.map(r=>formatStream(r,ctx,origin)),report};
    });
  }finally{clearTimeout(timer);}
}
// "simple" (default): the compact style from r/Nuvio ("Simple Formatting").
// "rich": the detailed v1.4 layout. Set FORMAT_STYLE in Vercel to switch.
const FORMAT_STYLE=String(process.env.FORMAT_STYLE||'simple').toLowerCase()==='rich'?'rich':'simple';
// The title as this release writes it ("DAN DA DAN (2024)", "Dandadan"), so
// releases are easy to tell apart; falls back to the show/movie name.
function releaseTitle(name,fallback){
  let t=String(name||'').replace(/^\[[^\]]*\]\s*/,'').replace(/\.(mkv|mp4|avi|m4v)$/i,'');
  if(!/\s/.test(t))t=t.replace(/[._]/g,' ');
  // Stop at the first episode/quality marker, an anime-style " - 03", or a
  // bracket that is not just a year: "Dan Da Dan - 03 [Dual Audio]" -> "Dan Da Dan".
  const cut=t.search(/\s(?:S\d{1,2}(?:E\d{1,4})?|E\d{1,4}|Ep\.?\s?\d{1,4}|Episode\s*\d|Season\s*\d|\d{1,2}x\d{2}|Complete|2160p|1080p|720p|480p|4K|UHD|BluRay|BDRemux|WEB|HDTV)\b|\s(?:19|20)\d{2}(?!\))\b|\s[-–]\s\d{1,4}\b|\s?\[|\s\((?!(?:19|20)\d{2}\))/i);
  t=(cut>0?t.slice(0,cut):t).replace(/\s*[-–:|]\s*$/,'').replace(/\s+/g,' ').trim();
  if(/[А-Яа-яЁё]/.test(t)&&/\//.test(t))t=t.split('/').pop().trim();
  t=t.replace(/[\s.,;:_-]+$/,'').trim();
  // Non-Latin or tracker-style titles ("Серии: 1-13 из 13") use the real name.
  if(/[А-Яа-яЁёא-ת؀-ۿ一-鿿]/.test(t)||/^(серии|сезон|episodes?|season)\b/i.test(t))return fallback||t;
  return t.length>=2&&t.length<=60?t:(fallback||t.slice(0,60));
}
function formatSimple(r,ctx,p,fileName){
  const title=(releaseTitle(r.title,ctx.meta?.name)||ctx.meta?.name||'').replace(/\s+(the\s+)?(complete\s+)?(tv\s+)?(series|show)$/i,'').trim()||ctx.meta?.name||'';
  const line1=ctx.season>0?`${title} 🦋 S${pad(ctx.season)}🍂 E${pad(ctx.episode)}`:`${title}${ctx.meta?.year&&!title.includes(String(ctx.meta.year))?` 🦋 ${ctx.meta.year}`:''}`;
  const flags=[...new Set(p.langs.map(l=>l.flag))];
  const line2=flags.length?`🗣️ ${flags.join(' . ')}`:p.multi?`🗣️ ${/\bDUAL\b/i.test(r.title)?'Dual Audio':'Multi Audio'}`:null;
  const visual=[...p.hdr,p.bit10?'10bit':null].filter(Boolean).join(' ');
  const sound=[...p.audio,p.ch].filter(Boolean).join(' ');
  const line3=[p.source&&`📸 ${p.source}`,visual&&`🔆 ${visual}`,sound&&`🎵 ${sound}`].filter(Boolean).join(' ');
  const line4=[formatSize(r.size)&&`📁 ${formatSize(r.size)}`,r.seeders?`🌱 ${r.seeders} seeders`:null,r.isPack?'📦 Pack':null].filter(Boolean).join('  ');
  const srcs=[...(r.sources||[r.source])].filter(Boolean).map(x=>SOURCE_DISPLAY[x]||x);
  const line5=srcs.length?`🔍 ${srcs.join(' · ')}`:null;
  return [line1,line2,line3,line4,line5].filter(Boolean).join('\n');
}
const RES_LABEL={'2160p':'4K','1080p':'1080p','720p':'720p','576p':'576p','480p':'480p',CAM:'CAM'};
const SOURCE_BADGE={'BluRay REMUX':'🔥 REMUX',BluRay:'💎 BluRay','WEB-DL':'🌐 WEB-DL',WEB:'🌐 WEB',WEBRip:'🌐 WEBRip',HDTV:'📺 HDTV',DVD:'📀 DVD',CAM:'📹 CAM'};
function formatStream(r,ctx,origin){
  const fileName=r.file?baseName(videoName(r.file)):'';
  const p=r.parsed||parseRelease(`${r.title} ${fileName}`);
  const q2=new URLSearchParams();
  if(ctx.season===0){if(ctx.meta?.name)q2.set('t',ctx.meta.name.slice(0,80));if(ctx.meta?.year)q2.set('y',String(ctx.meta.year));}
  const query=q2.toString();
  const url=`${origin.proto}://${origin.host}/c/${origin.token}/play/${r.hash}/${ctx.season}/${ctx.episode}${query?`?${query}`:''}`;
  const join=(parts,sep=' · ')=>parts.filter(Boolean).join(sep);
  // Line 1: what it is.
  const epTitle=ctx.season>0?ctx.meta?.episodes?.[`${ctx.season}:${ctx.episode}`]:null;
  const head=ctx.season>0
    ?join([ctx.meta?.name,`S${pad(ctx.season)}E${pad(ctx.episode)}`,epTitle])
    :join([ctx.meta?.name,ctx.meta?.year]);
  // Line 2: picture. Line 3: codec and sound. Line 4: languages.
  const picture=join([p.source&&`📼 ${p.source}`,p.hdr.length?`✨ ${p.hdr.join(' · ')}`:null,p.extended?'🎬 Extended':null,p.remastered?'🪄 Remastered':null]);
  const sound=join([p.codec&&`🎞️ ${p.codec}${p.bit10?' 10-bit':''}`,p.audio.length?`🔊 ${p.audio.join(' ')}${p.ch?` ${p.ch}`:''}`:null]);
  const langList=p.langs.slice(0,5).map(l=>`${l.flag} ${l.code}`);
  const spoken=langList.length?`🗣️ ${langList.join(' · ')}${p.multi?' · Multi':''}`:p.multi?'🗣️ Multi-audio':null;
  const language=join([spoken,p.subs&&`💬 ${p.subs}`],'   ');
  // Line 5: size, seeders, group. Line 6: pack + where it came from.
  const facts=join([formatSize(r.size)&&`💾 ${formatSize(r.size)}`,r.seeders?`👥 ${r.seeders}`:null,p.group&&`🏷️ ${p.group}`]);
  const sources=[...r.sources].map(x=>SOURCE_DISPLAY[x]||x).join(' + ');
  const origin6=join([r.isPack?'📦 Season pack':null,`📡 ${sources}`]);
  const release=String(r.title||fileName).replace(/[\r\n]+/g,' ').slice(0,160);
  const resLabel=RES_LABEL[p.res]||'SD';
  const text=FORMAT_STYLE==='simple'?formatSimple(r,ctx,p,fileName)
    :[head?`🎬 ${head}`:null,picture||null,sound||null,language||null,facts||null,origin6,`📄 ${release}`].filter(Boolean).join('\n');
  return {
    name:FORMAT_STYLE==='simple'?`${resLabel} 🎬 Cinevo⚡`:join([`⚡ TB ${resLabel}`,SOURCE_BADGE[p.source]||null],'\n'),
    title:text,
    description:text,
    url,
    behaviorHints:{bingeGroup:`cinevo-${resLabel}-${p.source||'x'}`,...(fileName?{filename:fileName}:{}),...(r.size>0?{videoSize:Number(r.size)}:{})}
  };
}

// ---------- next-episode prefetch ----------
// After an episode's list is sent, the next episode (or the next season's first
// episode) is searched in the background and cached, so binge-watching and
// Nuvio's auto-play find it instantly. Vercel's waitUntil keeps the function
// alive for it; without it, the work simply runs until the server stops.
const prefetching=new Set();
async function keepRunning(promise){
  try{
    const mod=await import('@vercel/functions').catch(()=>null);
    if(mod?.waitUntil){mod.waitUntil(promise.catch(()=>{}));return;}
  }catch{}
  promise.catch(()=>{});
}
async function prefetchNext(key,id,origin){
  const m=/^(tt\d+):(\d+):(\d+)$/.exec(id);if(!m)return;
  const meta=await cinemeta('series',m[1]).catch(()=>null);
  const s=Number(m[2]),e=Number(m[3]),len=meta?.seasonLengths?.[s];
  let next=null;
  if(!len||e<len)next=`${m[1]}:${s}:${e+1}`;
  else if(meta?.seasonLengths?.[s+1])next=`${m[1]}:${s+1}:1`;
  if(!next)return;
  const cacheId=createHash('sha256').update(`${key}\0series\0${next}`).digest('hex');
  if(prefetching.has(cacheId)||await cacheGet(cacheId))return;
  prefetching.add(cacheId);
  try{
    const out=await findStreams(key,'series',next,origin);
    if(out.streams.length)await cacheSet(cacheId,out.streams,RESULT_TTL_MS);
    console.log('prefetched',JSON.stringify({next,count:out.streams.length}));
  }catch(e){console.warn('prefetch_failed',safeError(e,key));}
  finally{prefetching.delete(cacheId);}
}

// ---------- HTTP ----------
function requestOrigin(req,token){
  const first=v=>String(v||'').split(',')[0].trim();
  const proto=/^https?$/.test(first(req.headers['x-forwarded-proto']))?first(req.headers['x-forwarded-proto']):'https';
  const host=first(req.headers['x-forwarded-host'])||first(req.headers.host);
  return /^[a-z0-9.-]+(?::\d+)?$/i.test(host)?{proto,host,token}:null;
}
async function requestBody(req){
  if(req.body&&typeof req.body==='object')return req.body;
  const chunks=[];for await(const c of req)chunks.push(c);
  const raw=Buffer.concat(chunks).toString('utf8');
  if(raw.length>5000)throw Error('Request too large');
  return JSON.parse(raw||'{}');
}
const page=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cinevo setup</title><style>body{font:16px system-ui;background:#10131a;color:#eff3ff;max-width:560px;margin:35px auto;padding:18px}section{background:#1c2230;padding:24px;border-radius:16px}input,button{box-sizing:border-box;width:100%;padding:14px;margin:8px 0;border-radius:9px;font:inherit}input{background:#0b101b;color:white;border:1px solid #59647c}button{background:#7c77ff;color:white;border:0;font-weight:700}p,small{color:#bac4d8;line-height:1.5}</style><section><h1>🎬 Cinevo</h1><p>Movies & TV · TorBox cached</p><p>Enter your TorBox API key to create your personal install link. The key is encrypted on the server; the link carries an encrypted token, not your key.</p><form id="f"><label>TorBox API key<input id="key" type="password" autocomplete="off" required minlength="8" placeholder="Paste API key"></label><button>Create install link</button></form><p id="result" role="status"></p><small>Keep the link private: it gives access to your TorBox account. Only TorBox-cached releases are listed, and a release is added to your TorBox account only when you play it.</small></section><script>document.querySelector('#f').onsubmit=async(e)=>{e.preventDefault();const out=document.querySelector('#result');out.textContent='Creating link…';try{const r=await fetch('/api/configure',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({apiKey:document.querySelector('#key').value})});const j=await r.json();if(!r.ok)throw Error(j.error||'Failed');const a=document.createElement('a');a.href=j.installUrl;a.textContent=j.installUrl;a.style='color:#b1adff;overflow-wrap:anywhere';out.replaceChildren(document.createTextNode('Add this URL in Nuvio or Stremio: '),a);document.querySelector('#key').value='';}catch(err){out.textContent=err.message;}};</script></html>`;

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Cache-Control','no-store');
  const url=new URL(req.url,'https://example.invalid');
  const path=url.pathname;
  const send=(status,data)=>res.status(status).json(data);
  if(path==='/'||path==='/configure')return res.status(200).setHeader('Content-Type','text/html; charset=utf-8').send(page);
  if(path==='/health')return send(200,{ok:true,name:manifest.name,version:manifest.version,region:process.env.VERCEL_REGION||'local',sharedCache:hasRedis?(redisDownUntil>Date.now()?'unavailable':'on'):'off',configured:!!process.env.CONFIG_SECRET&&process.env.CONFIG_SECRET.length>=32});
  if(path==='/api/configure'&&req.method==='POST'){
    try{
      const data=await requestBody(req);
      const key=String(data.apiKey||'').trim();
      if(!/^[A-Za-z0-9_\-]{8,300}$/.test(key))return send(400,{error:'Invalid TorBox API key format'});
      const origin=requestOrigin(req,seal(key));
      if(!origin)return send(400,{error:'Unknown host'});
      return send(200,{installUrl:`${origin.proto}://${origin.host}/c/${origin.token}/manifest.json`});
    }catch(e){return send(500,{error:String(e.message||e)});}
  }
  const cfg=/^\/c\/([^/]+)\/(manifest\.json|stream\/(movie|series)\/([^/]+)\.json|play\/([a-f0-9]{40})\/(\d+)\/(\d+)|debug\/(movie|series)\/([^/]+))$/.exec(path);
  if(!cfg)return send(404,{error:'Not found'});
  let key;
  try{key=unseal(cfg[1]);}catch{return send(403,{error:'Invalid or expired install link. Create a new one.'});}
  if(cfg[2]==='manifest.json'){res.setHeader('Vercel-CDN-Cache-Control','max-age=3600');return send(200,manifest);}
  await loadMirrorHealth();
  if(cfg[5]){
    // Tap to play.
    const season=Number(cfg[6]),episode=Number(cfg[7]);
    const want={season,episode,title:String(url.searchParams.get('t')||'').slice(0,80),year:Number(url.searchParams.get('y'))||null};
    try{
      const link=await playWithTorbox(key,cfg[5],want);
      return res.redirect(302,link);
    }catch(e){
      console.warn('play_failed',JSON.stringify({stage:e.stage||'playback',reason:safeError(e,key)}));
      return send(503,{stage:e.stage||'playback',error:safeError(e,key)});
    }
  }
  const origin=requestOrigin(req,cfg[1]);
  if(!origin)return send(400,{error:'Unknown host'});
  if(cfg[8]){
    // Private diagnostics: what each source found, no links.
    const out=await findStreams(key,cfg[8],decodeURIComponent(cfg[9]),origin);
    return send(200,{version:manifest.version,id:decodeURIComponent(cfg[9]),...out.report,sample:out.streams.slice(0,5).map(s=>({name:s.name,title:s.title}))});
  }
  const type=cfg[3],id=decodeURIComponent(cfg[4]);
  const cacheId=createHash('sha256').update(`${key}\0${type}\0${id}`).digest('hex');
  // Vercel's edge keeps a copy of each list (the URL holds your private token,
  // so copies are never shared between people). Players never cache it.
  const edge=(sec)=>res.setHeader('Vercel-CDN-Cache-Control',`max-age=${sec}, stale-while-revalidate=1800`);
  const hit=await cacheGet(cacheId);
  if(hit){edge(EDGE_TTL_S);return send(200,{streams:hit});}
  try{
    const out=await findStreams(key,type,id,origin);
    console.log('stream_result',JSON.stringify({id,count:out.streams.length,...out.report}));
    if(out.streams.length)await cacheSet(cacheId,out.streams,RESULT_TTL_MS);
    edge(out.streams.length?EDGE_TTL_S:60);
    send(200,{streams:out.streams});
    if(type==='series'&&PREFETCH_NEXT)await keepRunning(prefetchNext(key,id,origin));
    return;
  }catch(e){
    console.warn('stream_failed',safeError(e,key));
    return send(200,{streams:[]});
  }
}
