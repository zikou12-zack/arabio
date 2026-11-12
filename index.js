// 🌙 Arabio — Arabic metadata addon for Nuvio and Stremio.
// Arabic catalogs (Ramadan, Egyptian, Gulf, Levant, Maghreb, Turkish...),
// Arabic titles, plots, cast and episode names, and Arabic search, from TMDB.
// Titles use IMDb ids when TMDB has one, so stream addons such as Cinevo work.

const VERSION='1.2.0';
// Accepts the v3 API key or the v4 read token, with or without "Bearer ", quotes or spaces.
const TMDB_KEY=String(process.env.TMDB_API_KEY||process.env.TMDB_KEY||'').trim().replace(/^["']|["']$/g,'').replace(/^Bearer\s+/i,'').trim();
const TMDB='https://api.themoviedb.org/3';
const IMG='https://image.tmdb.org/t/p/';
// Give Arabic details for every IMDb title (also non-Arabic ones), not just Arabio's catalogs.
const META_FOR_ALL=String(process.env.ARABIC_META_FOR_ALL||'true')!=='false';
const PAGE=20;

// ---------- small cache (memory, plus optional Upstash Redis) ----------
const REDIS_URL=String(process.env.KV_REST_API_URL||process.env.UPSTASH_REDIS_REST_URL||'').replace(/\/+$/,'');
const REDIS_TOKEN=String(process.env.KV_REST_API_TOKEN||process.env.UPSTASH_REDIS_REST_TOKEN||'');
let redisDownUntil=0;
async function redis(cmd){
  if(!REDIS_URL||!REDIS_TOKEN||redisDownUntil>Date.now())return null;
  try{
    const ac=new AbortController();const t=setTimeout(()=>ac.abort(),800);
    const r=await fetch(REDIS_URL,{method:'POST',headers:{authorization:`Bearer ${REDIS_TOKEN}`,'content-type':'application/json'},body:JSON.stringify(cmd),signal:ac.signal}).finally(()=>clearTimeout(t));
    if(!r.ok)throw Error(`HTTP ${r.status}`);
    return (await r.json())?.result??null;
  }catch{redisDownUntil=Date.now()+60000;return null;}
}
const mem=new Map();
async function cached(key,ttlMs,make){
  const hit=mem.get(key);if(hit&&hit.until>Date.now())return hit.value;
  const raw=await redis(['GET',`arabio:${key}`]);
  if(raw){try{const value=JSON.parse(raw);mem.set(key,{value,until:Date.now()+Math.min(ttlMs,3600000)});return value;}catch{}}
  const value=await make();
  mem.set(key,{value,until:Date.now()+ttlMs});
  if(mem.size>2000)mem.delete(mem.keys().next().value);
  if(value!=null)redis(['SET',`arabio:${key}`,JSON.stringify(value),'PX',String(ttlMs)]);
  return value;
}

// ---------- TMDB ----------
async function tmdb(path,params={},ttlMs=6*3600000){
  if(!TMDB_KEY)throw Error('TMDB_API_KEY is not set');
  const q=new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined&&v!==null&&v!==''));
  const bearer=TMDB_KEY.startsWith('eyJ');
  if(!bearer)q.set('api_key',TMDB_KEY);
  const url=`${TMDB}/${path}?${q}`;
  return cached(`t:${path}?${q.toString().replace(/api_key=[^&]+&?/,'')}`,ttlMs,async()=>{
    for(let attempt=0;attempt<2;attempt++){
      const ac=new AbortController();const t=setTimeout(()=>ac.abort(),6000);
      try{
        const r=await fetch(url,{headers:{accept:'application/json',...(bearer?{authorization:`Bearer ${TMDB_KEY}`}:{})},signal:ac.signal});
        if(r.status===404)return null;
        if(r.status===429&&attempt===0){await new Promise(z=>setTimeout(z,700));continue;}
        if(!r.ok)throw Error(`TMDB HTTP ${r.status}`);
        return await r.json();
      }finally{clearTimeout(t);}
    }
    throw Error('TMDB busy');
  });
}
const img=(p,size='w500')=>p?`${IMG}${size}${p}`:undefined;
const year=d=>/^\d{4}/.test(d||'')?d.slice(0,4):undefined;
const tmdbType=t=>t==='movie'?'movie':'tv';

// IMDb id for a TMDB title (cached for a month), so stream addons can find it.
async function imdbFor(type,id){
  return cached(`imdb:${type}:${id}`,30*86400000,async()=>{
    const ex=await tmdb(`${tmdbType(type)}/${id}/external_ids`,{},30*86400000).catch(()=>null);
    return /^tt\d+$/.test(ex?.imdb_id||'')?ex.imdb_id:'';
  });
}
async function mapLimit(items,limit,fn){
  const out=new Array(items.length);let i=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(i<items.length){const k=i++;out[k]=await fn(items[k],k);}}));
  return out;
}

// ---------- catalogs ----------
// Ramadan starts (approximate; series premiere around the first night).
const RAMADAN=['2024-03-11','2025-03-01','2026-02-18','2027-02-08','2028-01-28','2029-01-16','2030-01-06'];
function ramadanWindow(now=new Date()){
  const soon=new Date(now.getTime()+21*86400000).toISOString().slice(0,10);
  const start=[...RAMADAN].reverse().find(d=>d<=soon)||RAMADAN[0];
  const s=new Date(start+'T00:00:00Z');
  const iso=d=>d.toISOString().slice(0,10);
  return {'first_air_date.gte':iso(new Date(s.getTime()-10*86400000)),'first_air_date.lte':iso(new Date(s.getTime()+20*86400000)),year:start.slice(0,4)};
}
const GULF='SA|KW|AE|QA|BH|OM',LEVANT='SY|LB|JO|PS',MAGHREB='MA|DZ|TN|LY';
const today=()=>new Date().toISOString().slice(0,10);
const daysAgo=n=>new Date(Date.now()-n*86400000).toISOString().slice(0,10);
const thisYear=()=>new Date().getUTCFullYear();
// path: a TMDB list other than discover. limit: a fixed Top-N row (no paging, no genre filter).
const CATALOGS=[
  {id:'arabio.trending.movies',type:'movie',name:'🔥 الأكثر رواجاً اليوم: أفلام',path:'trending/movie/day',limit:10},
  {id:'arabio.trending.series',type:'series',name:'🔥 الأكثر رواجاً اليوم: مسلسلات',path:'trending/tv/day',limit:10},
  {id:'arabio.top10.series',type:'series',name:'🏆 أفضل 10 مسلسلات عربية الآن',limit:10,params:()=>({with_original_language:'ar','first_air_date.gte':daysAgo(3*365)})},
  {id:'arabio.top10.movies',type:'movie',name:'🏆 أفضل 10 أفلام عربية الآن',limit:10,params:()=>({with_original_language:'ar','primary_release_date.gte':daysAgo(3*365)})},
  {id:'arabio.airing',type:'series',name:'📺 تُعرض هذا الأسبوع',params:()=>({with_original_language:'ar','air_date.gte':daysAgo(7),'air_date.lte':today(),'vote_count.gte':0})},
  {id:'arabio.ramadan',type:'series',name:'🌙 مسلسلات رمضان',params:()=>{const w=ramadanWindow();delete w.year;return {with_original_language:'ar','vote_count.gte':0,...w};}},
  {id:'arabio.year.series',type:'series',name:`📅 مسلسلات عربية ${thisYear()}`,params:()=>({with_original_language:'ar',first_air_date_year:thisYear(),'vote_count.gte':0})},
  {id:'arabio.new.movies',type:'movie',name:'🆕 أحدث الأفلام العربية',params:()=>({with_original_language:'ar','vote_count.gte':0,sort_by:'primary_release_date.desc','primary_release_date.lte':today()})},
  {id:'arabio.series',type:'series',name:'مسلسلات عربية',params:()=>({with_original_language:'ar'})},
  {id:'arabio.movies',type:'movie',name:'أفلام عربية',params:()=>({with_original_language:'ar'})},
  {id:'arabio.toprated.series',type:'series',name:'⭐ الأعلى تقييماً: مسلسلات عربية',params:()=>({with_original_language:'ar',sort_by:'vote_average.desc','vote_count.gte':30})},
  {id:'arabio.toprated.movies',type:'movie',name:'⭐ الأعلى تقييماً: أفلام عربية',params:()=>({with_original_language:'ar',sort_by:'vote_average.desc','vote_count.gte':50})},
  {id:'arabio.eg.series',type:'series',name:'🇪🇬 مسلسلات مصرية',params:()=>({with_original_language:'ar',with_origin_country:'EG'})},
  {id:'arabio.eg.movies',type:'movie',name:'🇪🇬 أفلام مصرية',params:()=>({with_original_language:'ar',with_origin_country:'EG'})},
  {id:'arabio.eg.comedy',type:'movie',name:'😂 كوميديا مصرية',params:()=>({with_original_language:'ar',with_origin_country:'EG',with_genres:35})},
  {id:'arabio.eg.classics',type:'movie',name:'🎞️ كلاسيكيات السينما المصرية',params:()=>({with_original_language:'ar',with_origin_country:'EG','primary_release_date.lte':'1989-12-31',sort_by:'vote_count.desc','vote_count.gte':5})},
  {id:'arabio.gulf.series',type:'series',name:'مسلسلات خليجية',params:()=>({with_original_language:'ar',with_origin_country:GULF})},
  {id:'arabio.gulf.movies',type:'movie',name:'أفلام خليجية',params:()=>({with_original_language:'ar',with_origin_country:GULF})},
  {id:'arabio.levant.series',type:'series',name:'مسلسلات شامية',params:()=>({with_original_language:'ar',with_origin_country:LEVANT})},
  {id:'arabio.ma.series',type:'series',name:'🇲🇦 مسلسلات مغربية',params:()=>({with_origin_country:'MA','vote_count.gte':0})},
  {id:'arabio.ma.movies',type:'movie',name:'🇲🇦 أفلام مغربية',params:()=>({with_origin_country:'MA','vote_count.gte':0})},
  {id:'arabio.maghreb.series',type:'series',name:'مسلسلات مغاربية',params:()=>({with_origin_country:MAGHREB})},
  {id:'arabio.maghreb.movies',type:'movie',name:'أفلام مغاربية',params:()=>({with_origin_country:MAGHREB})},
  {id:'arabio.top10.turkish',type:'series',name:'🏆 أفضل 10 مسلسلات تركية الآن',limit:10,params:()=>({with_original_language:'tr','first_air_date.gte':daysAgo(3*365)})},
  {id:'arabio.turkish.series',type:'series',name:'مسلسلات تركية',params:()=>({with_original_language:'tr'})},
  {id:'arabio.search.movie',type:'movie',name:'بحث أفلام',search:true},
  {id:'arabio.search.series',type:'series',name:'بحث مسلسلات',search:true}
];
// TMDB genre ids with Arabic names.
const GENRES={
  movie:{'أكشن':28,'مغامرة':12,'كوميدي':35,'دراما':18,'رومانسي':10749,'إثارة':53,'جريمة':80,'رعب':27,'غموض':9648,'عائلي':10751,'تاريخي':36,'حربي':10752,'وثائقي':99,'رسوم متحركة':16,'موسيقي':10402},
  series:{'دراما':18,'كوميدي':35,'جريمة':80,'أكشن ومغامرة':10759,'غموض':9648,'عائلي':10751,'خيال علمي وفانتازيا':10765,'حربي وسياسي':10768,'وثائقي':99,'رسوم متحركة':16,'أطفال':10762,'واقع':10764}
};
function parseExtra(raw){
  const out={};if(!raw)return out;
  for(const part of raw.split('&')){const i=part.indexOf('=');if(i<1)continue;
    try{out[decodeURIComponent(part.slice(0,i))]=decodeURIComponent(part.slice(i+1).replace(/\+/g,' '));}catch{}}
  return out;
}
function preview(type,r){
  return {
    type,name:r.title||r.name||r.original_title||r.original_name,
    poster:img(r.poster_path),background:img(r.backdrop_path,'w1280'),
    description:r.overview||undefined,
    releaseInfo:year(r.release_date||r.first_air_date),
    imdbRating:r.vote_average?String(Math.round(r.vote_average*10)/10):undefined,
    posterShape:'poster'
  };
}
async function catalog(type,id,extra){
  const def=CATALOGS.find(c=>c.id===id&&c.type===type);
  if(!def)return null;
  const skip=Math.max(0,Number(extra.skip)||0);
  const page=Math.floor(skip/PAGE)+1;
  if(page>50||(def.limit&&skip>0))return [];
  let data;
  if(def.search){
    const q=String(extra.search||'').trim().slice(0,100);
    if(!q)return [];
    data=await tmdb(`search/${tmdbType(type)}`,{query:q,language:'ar',page,include_adult:'false'},3600000);
  }else if(def.path){
    data=await tmdb(def.path,{language:'ar'},3*3600000);
  }else{
    const params={language:'ar',sort_by:'popularity.desc',include_adult:'false','vote_count.gte':type==='movie'?3:1,page,...def.params()};
    const g=GENRES[type][extra.genre];
    if(g)params.with_genres=g;
    data=await tmdb(`discover/${tmdbType(type)}`,params);
  }
  const results=(data?.results||[]).filter(r=>r.poster_path).slice(0,def.limit||PAGE);
  return mapLimit(results,10,async r=>{
    const imdb=await imdbFor(type,r.id);
    return {id:imdb||`tmdb:${r.id}`,...preview(type,r)};
  });
}

// ---------- meta ----------
async function findTmdb(type,id){
  if(id.startsWith('tmdb:')){const n=Number(id.split(':')[1]);return n>0?n:null;}
  const found=await tmdb(`find/${id}`,{external_source:'imdb_id'},7*86400000);
  const list=type==='movie'?found?.movie_results:found?.tv_results;
  return list?.[0]?.id||null;
}
function englishOf(d){
  const t=(d?.translations?.translations||[]).find(x=>x.iso_639_1==='en')?.data||{};
  return {title:t.title||t.name||'',overview:t.overview||''};
}
function pickLogo(d){
  const logos=d?.images?.logos||[];
  const best=logos.find(l=>l.iso_639_1==='ar')||logos.find(l=>l.iso_639_1==='en')||logos[0];
  return best?img(best.file_path,'w500'):undefined;
}
const details=(kind,tid)=>tmdb(`${kind}/${tid}`,{language:'ar',append_to_response:'external_ids,credits,videos,images,translations',include_image_language:'ar,en,null',include_video_language:'ar,en'},24*3600000);
async function meta(type,id){
  const tid=await findTmdb(type,id);
  if(!tid)return null;
  const kind=tmdbType(type);
  const d=await details(kind,tid);
  if(!d)return null;
  const en=englishOf(d);
  const imdb=/^tt\d+$/.test(d.external_ids?.imdb_id||'')?d.external_ids.imdb_id:'';
  const vidBase=id.startsWith('tt')?id:(imdb||id);
  const name=d.title||d.name||en.title||d.original_title||d.original_name;
  const enLine=en.title&&en.title!==name?`🔤 ${en.title}\n`:'';
  const overview=d.overview||en.overview||'';
  const runtime=d.runtime||(d.episode_run_time||[])[0];
  const first=d.release_date||d.first_air_date;
  const releaseInfo=type==='movie'?year(first):(year(first)?`${year(first)}-${d.in_production?'':year(d.last_air_date)||''}`:undefined);
  const trailers=(d.videos?.results||[]).filter(v=>v.site==='YouTube'&&/Trailer|Teaser/.test(v.type)).slice(0,3);
  const out={
    id,type,name,
    poster:img(d.poster_path),background:img(d.backdrop_path,'original'),logo:pickLogo(d),
    description:(enLine+overview).trim()||undefined,
    releaseInfo,year:year(first),released:first?new Date(first+'T00:00:00Z').toISOString():undefined,
    imdbRating:d.vote_average?String(Math.round(d.vote_average*10)/10):undefined,
    genres:(d.genres||[]).map(g=>g.name),
    cast:(d.credits?.cast||[]).slice(0,10).map(c=>c.name),
    director:(d.credits?.crew||[]).filter(c=>c.job==='Director').slice(0,3).map(c=>c.name),
    runtime:runtime?`${runtime} د`:undefined,
    country:(d.production_countries||d.origin_country||[]).map(c=>c.name||c).slice(0,3).join('، ')||undefined,
    language:d.original_language,
    trailers:trailers.map(v=>({source:v.key,type:'Trailer'})),
    links:imdb?[{name:'IMDb',category:'imdb',url:`https://www.imdb.com/title/${imdb}/`}]:[],
    behaviorHints:type==='movie'?{defaultVideoId:vidBase}:{}
  };
  if(type==='series'){
    const seasons=(d.seasons||[]).map(s=>s.season_number).filter(n=>Number.isInteger(n));
    const videos=[];
    for(let i=0;i<seasons.length;i+=20){
      const chunk=seasons.slice(i,i+20);
      const sd=await tmdb(`tv/${tid}`,{language:'ar',append_to_response:chunk.map(n=>`season/${n}`).join(',')},12*3600000);
      for(const n of chunk)for(const e of sd?.[`season/${n}`]?.episodes||[]){
        videos.push({
          id:`${vidBase}:${n}:${e.episode_number}`,season:n,episode:e.episode_number,
          title:e.name||`الحلقة ${e.episode_number}`,
          released:e.air_date?new Date(e.air_date+'T00:00:00Z').toISOString():undefined,
          overview:e.overview||undefined,thumbnail:img(e.still_path,'w300')
        });
      }
    }
    // Specials (season 0) go last.
    videos.sort((a,b)=>(a.season||1e9)-(b.season||1e9)||a.episode-b.episode);
    out.videos=videos;
  }
  return out;
}

// ---------- YouTube streams (official uploads of Arabic titles) ----------
// Needs YOUTUBE_API_KEY. A search costs 100 of the 10,000 free daily units, so
// answers are cached for a day and only Arabic-language titles are searched.
const YT_KEY=String(process.env.YOUTUBE_API_KEY||'').trim().replace(/^["']|["']$/g,'');
let ytPausedUntil=0;
const arNorm=s=>String(s||'').toLowerCase().normalize('NFKC').replace(/[\u064B-\u065F\u0670\u0640]/g,'').replace(/[أإآٱ]/g,'ا').replace(/ة/g,'ه').replace(/ى/g,'ي').replace(/[^a-z0-9\u0621-\u064A]+/g,' ').trim();
const ORDINAL={'الاول':1,'الثاني':2,'الثالث':3,'الرابع':4,'الخامس':5,'السادس':6,'السابع':7,'الثامن':8,'التاسع':9,'العاشر':10};
function statedSeason(t){
  const m=t.match(/(?:الموسم|الجزء|season|part)\s*(\d{1,2})(?!\d)/);if(m)return Number(m[1]);
  const o=t.match(/(?:الموسم|الجزء)\s*(\S+)/);return o&&ORDINAL[o[1]]?ORDINAL[o[1]]:null;
}
function episodeOk(t,e){
  const m=[...t.matchAll(/(?:^|\s)(?:الحلقه|حلقه|episode|ep|e)\s*(\d{1,4})(?!\d)/g)].map(x=>Number(x[1]));
  return m.includes(e);
}
const isoMinutes=d=>{const m=String(d||'').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);return m?Number(m[1]||0)*60+Number(m[2]||0)+Number(m[3]||0)/60:0;};
async function yt(path,params){
  if(ytPausedUntil>Date.now())throw Error('YouTube daily quota used up');
  const q=new URLSearchParams({...params,key:YT_KEY});
  const ac=new AbortController();const t=setTimeout(()=>ac.abort(),5000);
  try{
    const r=await fetch(`https://www.googleapis.com/youtube/v3/${path}?${q}`,{signal:ac.signal});
    if(r.status===403){const until=new Date();until.setUTCHours(24,5,0,0);ytPausedUntil=until.getTime();throw Error('YouTube quota or key problem (HTTP 403)');}
    if(!r.ok)throw Error(`YouTube HTTP ${r.status}`);
    return await r.json();
  }finally{clearTimeout(t);}
}
async function youtubeStreams(type,rawId){
  const m=/^(tt\d+|tmdb:\d+)(?::(\d+):(\d+))?$/.exec(rawId);if(!m)return [];
  const season=Number(m[2]||0),episode=Number(m[3]||0);
  if(type==='series'&&(!season||!episode))return [];
  const tid=await findTmdb(type,m[1]);if(!tid)return [];
  const d=await details(tmdbType(type),tid);
  if(!d||d.original_language!=='ar')return [];
  const arName=d.title||d.name||d.original_title||d.original_name;
  const names=[arName,d.original_title||d.original_name,englishOf(d).title].map(arNorm).filter(n=>n.length>=3);
  const q=type==='movie'?`فيلم ${arName} كامل`:`مسلسل ${arName} الحلقة ${episode}${season>1?` الموسم ${season}`:''}`;
  return cached(`yt:${q}`,24*3600000,async()=>{
    const found=await yt('search',{part:'snippet',type:'video',q,maxResults:'15',relevanceLanguage:'ar',videoDuration:'long',safeSearch:'none'});
    const ids=(found?.items||[]).map(i=>i.id?.videoId).filter(Boolean);
    if(!ids.length)return [];
    const info=await yt('videos',{part:'snippet,contentDetails,statistics,status',id:ids.join(',')});
    const out=[];
    for(const v of info?.items||[]){
      const t=arNorm(v.snippet?.title);
      if(!names.some(n=>t.includes(n)))continue;
      if(v.status?.embeddable===false)continue;
      const mins=isoMinutes(v.contentDetails?.duration);
      if(type==='movie'){if(mins<60)continue;if(/(?:الحلقه|حلقه|episode)\s*\d/.test(t))continue;}
      else{
        if(mins<15||!episodeOk(t,episode))continue;
        const st=statedSeason(t);
        if(st!==null&&st!==season)continue;
        if(st===null&&season>1)continue;
      }
      out.push({id:v.id,title:v.snippet.title,channel:v.snippet.channelTitle,mins,views:Number(v.statistics?.viewCount)||0});
    }
    return out.sort((a,b)=>b.views-a.views).slice(0,4);
  }).then(list=>list.map(v=>({
    ytId:v.id,name:'▶️ YouTube',
    title:`${v.title}\n📺 ${v.channel} · ⏱ ${Math.floor(v.mins/60)?`${Math.floor(v.mins/60)}h `:''}${Math.round(v.mins%60)}m · 👁 ${v.views>=1e6?(v.views/1e6).toFixed(1)+'M':v.views>=1e3?Math.round(v.views/1e3)+'K':v.views}`,
    behaviorHints:{bingeGroup:'arabio-youtube'}
  })));
}

// ---------- manifest ----------
const manifest={
  id:'community.arabio',version:VERSION,name:'🌙 Arabio',
  description:(YT_KEY?'Official YouTube uploads of Arabic movies and series, plus ':'')+'Arabic metadata: Ramadan, Egyptian, Gulf, Levant, Maghreb and Turkish series and Arabic movies, with Arabic titles, plots, cast, episode names and search.',
  logo:'https://raw.githubusercontent.com/twitter/twemoji/master/assets/72x72/1f319.png',
  resources:['catalog',{name:'meta',types:['movie','series'],idPrefixes:META_FOR_ALL?['tt','tmdb:']:['tmdb:']},...(YT_KEY?[{name:'stream',types:['movie','series'],idPrefixes:['tt','tmdb:']}]:[])],
  types:['movie','series'],
  idPrefixes:META_FOR_ALL?['tt','tmdb:']:['tmdb:'],
  catalogs:CATALOGS.map(c=>c.search
    ?{type:c.type,id:c.id,name:c.name,extra:[{name:'search',isRequired:true},{name:'skip'}]}
    :c.limit?{type:c.type,id:c.id,name:c.name,extra:[]}
    :{type:c.type,id:c.id,name:c.name,extra:[{name:'genre',options:Object.keys(GENRES[c.type])},{name:'skip'}],genres:Object.keys(GENRES[c.type])}),
  behaviorHints:{configurable:false}
};

// ---------- HTTP ----------
const page=host=>`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Arabio</title><style>body{font:17px system-ui;background:#11131a;color:#f1f3fa;max-width:560px;margin:35px auto;padding:18px}section{background:#1d2230;padding:24px;border-radius:16px}a.b{display:block;text-align:center;background:#c9a227;color:#1a1400;padding:14px;border-radius:10px;font-weight:700;text-decoration:none;margin:10px 0}code{direction:ltr;display:block;background:#0b0f18;padding:12px;border-radius:8px;overflow-wrap:anywhere;font-size:14px}p{color:#c3cbe0;line-height:1.7}</style><section><h1>🌙 Arabio</h1><p>بيانات عربية للأفلام والمسلسلات: مسلسلات رمضان، المصرية، الخليجية، الشامية، المغاربية والتركية، مع العناوين والقصص وأسماء الحلقات بالعربية.</p><a class="b" href="stremio://${host}/manifest.json">تثبيت في Stremio</a><p>رابط التثبيت لـ Nuvio:</p><code>https://${host}/manifest.json</code><p>ضع Arabio فوق Cinemeta في ترتيب الإضافات لتظهر البيانات بالعربية.</p></section></html>`;

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('X-Content-Type-Options','nosniff');
  const url=new URL(req.url,'https://example.invalid');
  const path=url.pathname.replace(/\/+$/,'')||'/';
  const send=(status,data,cacheSec=0)=>{
    if(cacheSec){res.setHeader('Cache-Control',`public, max-age=${Math.min(cacheSec,3600)}`);res.setHeader('Vercel-CDN-Cache-Control',`max-age=${cacheSec}, stale-while-revalidate=86400`);}
    else res.setHeader('Cache-Control','no-store');
    return res.status(status).json(data);
  };
  const host=String(req.headers['x-forwarded-host']||req.headers.host||'').split(',')[0].trim();
  if(path==='/'||path==='/configure'){
    res.setHeader('Content-Type','text/html; charset=utf-8');
    return res.status(200).send(page(/^[a-z0-9.-]+(?::\d+)?$/i.test(host)?host:'your-arabio.vercel.app'));
  }
  if(path==='/health'){
    // Live TMDB check, with a plain explanation when it fails.
    let tmdbStatus='missing: add TMDB_API_KEY in Vercel → Settings → Environment Variables, then redeploy';
    if(TMDB_KEY){
      try{
        const bearer=TMDB_KEY.startsWith('eyJ');
        const r=await fetch(`${TMDB}/configuration${bearer?'':`?api_key=${encodeURIComponent(TMDB_KEY)}`}`,{headers:bearer?{authorization:`Bearer ${TMDB_KEY}`}:{}});
        tmdbStatus=r.ok?'ok':r.status===401?'rejected: TMDB says this key is invalid (copy the API Key or the Read Access Token again)':`error: TMDB HTTP ${r.status}`;
      }catch(e){tmdbStatus='unreachable: '+String(e.message||e).slice(0,60);}
    }
    return send(200,{ok:tmdbStatus==='ok',name:manifest.name,version:VERSION,tmdb:tmdbStatus,youtube:YT_KEY?(ytPausedUntil>Date.now()?'paused: daily quota used up or key problem':'on'):'off: add YOUTUBE_API_KEY to show official YouTube uploads',keyType:TMDB_KEY?(TMDB_KEY.startsWith('eyJ')?'read access token':'api key'):'none',region:process.env.VERCEL_REGION||'local',sharedCache:REDIS_URL&&REDIS_TOKEN?'on':'off',arabicMetaForAll:META_FOR_ALL});
  }
  if(path==='/manifest.json')return send(200,manifest,3600);
  let m=/^\/catalog\/(movie|series)\/([^/]+?)(?:\/([^/]+))?\.json$/.exec(path);
  if(m){
    try{
      const metas=await catalog(m[1],decodeURIComponent(m[2]),parseExtra(m[3]));
      if(metas===null)return send(404,{error:'Unknown catalog'});
      return send(200,{metas},metas.length?(m[2].includes('search')?3600:6*3600):0);
    }catch(e){console.warn('catalog_failed',String(e.message||e));return send(200,{metas:[]});}
  }
  m=/^\/stream\/(movie|series)\/([^/]+)\.json$/.exec(path);
  if(m){
    if(!YT_KEY)return send(200,{streams:[]});
    try{
      const streams=await youtubeStreams(m[1],decodeURIComponent(m[2]));
      return send(200,{streams},streams.length?6*3600:3600);
    }catch(e){console.warn('youtube_failed',String(e.message||e));return send(200,{streams:[]});}
  }
  m=/^\/meta\/(movie|series)\/([^/]+)\.json$/.exec(path);
  if(m){
    const id=decodeURIComponent(m[2]);
    if(!/^(tt\d+|tmdb:\d+)$/.test(id))return send(404,{error:'Unsupported id'});
    try{
      const out=await meta(m[1],id);
      if(!out)return send(404,{error:'Not found on TMDB'});
      return send(200,{meta:out},86400);
    }catch(e){console.warn('meta_failed',String(e.message||e));return send(502,{error:'Metadata is unavailable right now'});}
  }
  return send(404,{error:'Not found'});
}
