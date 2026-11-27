'use strict';
const fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const HOUR=3600000,MAX_AGE=48*HOUR,COHORT_CAP=500;
const commonNames=['Player','Adventurer','Hero','Shadow','Luna','Alex','Nova','Ghost','Phoenix','Loki','Zero','Ace','Wolf','Dragon','Ninja','Angel','Raven','Sam','Max','John','Jack','Mike','David','Chris','Sky','Star','Echo','Kai','Yuki','Sakura','Kira','Ryu','Neko','Mochi','Cookie','Potato','Blue','Red','Green','Orange','Purple','Pink','Happy','Lucky','Mercy','Moira','Ana','Genji','Hanzo','Reinhardt','Tracer','Dva','Sigma','Lucio','Kiriko','Juno','Brigitte','Widowmaker','Soldier','Reaper','Maya','Nyx','Rain','Snow','Frost','Blaze','Storm','Moon','Sun','Chill','Sleepy','Dream','Night','Demon','Doom','Angel','Falcon','Tiger','Bear','Panda','Kitty','Cat','Fox','Bee','Dog','Hunter','Silent','Unknown','Anonymous','Mystic','Cosmic','Galaxy','Eclipse','Light','Dark','Void','Silver','Gold','Platinum'];
const normalizeId=id=>{try{return decodeURIComponent(String(id)).trim();}catch{return '';}};
const isBlizzardId=id=>/^[a-f0-9]{16,64}\|[a-f0-9]{16,64}$/i.test(normalizeId(id));
const validTag=id=>/^.{1,40}-\d{3,12}$/u.test(id);
const identity=id=>isBlizzardId(id)?normalizeId(id).toLowerCase():String(id).toLowerCase();
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function unpack(p){
 if(!p)return [];
 if(p.version===1)return Array.isArray(p.rows)?p.rows:[];
 if(p.version!==2||!Array.isArray(p.fields)||!Array.isArray(p.profiles)||!Array.isArray(p.rows))return [];
 const rates=a=>Object.fromEntries(p.fields.flatMap((k,i)=>Number.isFinite(a?.[i])?[[k,a[i]]]:[]));
 return p.rows.flatMap(x=>{const t=p.profiles[x[0]];return t?[{tag:t[0],playerId:t[0],displayName:t[1],url:t[2],discoverySource:t[3],sourceUpdatedAt:t[4],platform:p.platform,hero:x[1],role:x[2],division:x[3],tier:x[4],season:x[5],n:x[6],time:x[7],at:x[8],qpShare:x[9],metrics:rates(x[10]),modeMetrics:{quickplay:rates(x[11]),competitive:rates(x[12])},modeTimes:{quickplay:x[13],competitive:x[14]}}]:[];});
}
function capRows(rows,now=Date.now()){
 const latest=new Map();for(const r of rows){if(!r||!Number.isFinite(r.at)||r.at>now||now-r.at>MAX_AGE||r.n<5||r.time<1800)continue;const k=identity(r.playerId||r.tag)+'|'+r.platform+'|'+r.hero;if(!latest.has(k)||latest.get(k).at<r.at)latest.set(k,r);}
 // A named legacy row and a discovered opaque ID can identify the same player.
 // Drop the legacy name whenever canonical rows of that name exist; never count both.
 const canonicalNames=new Set([...latest.values()].filter(r=>isBlizzardId(r.tag)).map(r=>(r.displayName||'').toLowerCase()).filter(Boolean));
 const groups=new Map();for(const r of latest.values()){if(validTag(r.tag)&&canonicalNames.has(r.tag.replace(/-\d+$/,'').toLowerCase()))continue;const k=[r.platform,r.hero,r.division||'unranked',r.season??'unknown'].join('|');if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}
 return [...groups.values()].flatMap(a=>a.sort((x,y)=>hash(identity(x.tag)).localeCompare(hash(identity(y.tag)))).slice(0,COHORT_CAP));
}
function pack(rows,platform,meta={}){
 const fields=[...new Set(rows.flatMap(r=>[...Object.keys(r.metrics||{}),...Object.values(r.modeMetrics||{}).flatMap(m=>Object.keys(m))]))].sort();const profiles=[],ids=new Map();const rates=m=>fields.map(k=>Number.isFinite(m?.[k])?m[k]:null);
 const packed=rows.map(r=>{const id=identity(r.playerId||r.tag);if(!ids.has(id)){ids.set(id,profiles.length);profiles.push([r.tag,r.displayName||r.tag.replace(/-\d+$/,''),r.url,r.discoverySource||'legacy',r.sourceUpdatedAt||null]);}return [ids.get(id),r.hero,r.role,r.division,r.tier,r.season,r.n,r.time,r.at,r.qpShare,rates(r.metrics),rates(r.modeMetrics?.quickplay),rates(r.modeMetrics?.competitive),r.modeTimes?.quickplay||0,r.modeTimes?.competitive||0];});
 return {version:2,platform,at:Date.now(),source:'OverFast public profiles',...meta,cohortCap:COHORT_CAP,fields,profiles,rows:packed};
}
function coverage(rows){const groups={};for(const r of rows){const k=[r.hero,r.division||'unranked',r.season??'unknown'].join('|');const g=groups[k]??={hero:r.hero,role:r.role,division:r.division,season:r.season,players:0,core:0};g.players++;const primary=r.role==='support'?'healing':'damage';if(Number.isFinite(r.metrics?.deaths)&&Number.isFinite(r.metrics?.[primary]))g.core++;}return Object.values(groups);}
function decode(s){return s.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n)).replace(/&#x([\da-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));}
function discoverAtlas(html){return [...html.matchAll(/<a\b[^>]*class="player-leaderboard__row"[^>]*>[\s\S]*?<\/a>/g)].flatMap(m=>{const row=m[0],name=decode(row.match(/class="player-leaderboard__name"[^>]*>([^<]+)/)?.[1]||''),tag=decode(row.match(/class="player-leaderboard__id"[^>]*>([^<]+)/)?.[1]||''),avatar=row.match(/<img[^>]*src="([^"]+)"[^>]*class="player-leaderboard__avatar"/)?.[1];return name?[{name,tag:validTag(tag)?tag:null,avatar}]:[];});}
function extraction(html){const code=html.slice(html.indexOf('function usefulUtility('),html.indexOf('function performanceWeights('))+html.slice(html.indexOf('const fields={damage:'),html.indexOf('const median=a=>'))+html.slice(html.indexOf('function flatten(raw)'),html.indexOf('function summarize(rows,'));const ctx=vm.createContext({});vm.runInContext(code+';this.extract=extract;',ctx);return ctx.extract;}
function readJSON(path,fallback){try{return JSON.parse(fs.readFileSync(path,'utf8'));}catch{return fallback;}}
async function main(){
 const html=fs.readFileSync('index.html','utf8'),extract=extraction(html),heroes=JSON.parse(html.match(/let catalog = (\[[^\n]+\]);/)[1]);
 const seeds=JSON.parse(html.match(/const seeds=(\[[^\n]+\]);/)[1]),friends=['Necoy-2548','Johnnei-2958','Maeryll-2831','Myaaw-2156','Rheonry-2804','Teilya-2311'];
 const state=readJSON('references/discovery.json',{version:1,run:0,players:{},names:{},cursor:0});state.run++;state.names??={};state.players??={};
 const now=Date.now(),deadline=now+32*60000,budget=Number(process.env.PROFILE_BUDGET||900),old={pc:unpack(readJSON('references/pc.json',null)),console:unpack(readJSON('references/console.json',null))};
 const rows={pc:[...old.pc],console:[...old.console]};let lastStart=0,gate=Promise.resolve(),stop=false,requests=0,errors=0,publicProfiles=0,added=0,checked=0;
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 async function request(url,attempt=0){gate=gate.then(async()=>{await sleep(Math.max(0,1100-(Date.now()-lastStart)));lastStart=Date.now();});await gate;if(stop)throw Error('Collection paused');requests++;
  const response=await fetch(url,{signal:AbortSignal.timeout(20000),headers:{'User-Agent':'HeroCoach-public-reference-collector/2.0 (github.com/Necoyo/hero-coach)'}});
  if(!response.ok){if((response.status===429||response.status===503)&&attempt===0){const retry=response.headers.get('retry-after'),seconds=Number(retry),delay=retry?(Number.isFinite(seconds)?seconds*1000:Date.parse(retry)-Date.now()):15000;if(Number.isFinite(delay)&&delay<=60000){gate=gate.then(()=>sleep(Math.max(15000,delay)));return request(url,1);}}if(response.status===429||response.status===403||response.status===503)stop=true;const e=Error('HTTP '+response.status);e.status=response.status;throw e;}return response;
 }
 function addName(name,avatar,origin){if(!name||name.length>40)return;const n=state.names[name]??={at:0,total:0,avatars:[],origin};if(avatar&&!n.avatars.includes(avatar))n.avatars.push(avatar);n.avatars=n.avatars.slice(-10);}
 for(const tag of [...friends,...seeds]){const k=identity(tag);state.players[k]??={id:tag,name:tag.replace(/-\d+$/,''),origin:'seed',discoveredAt:now};addName(tag.replace(/-\d+$/,''),null,'seed');}
 for(const name of commonNames)addName(name,null,'name-search');
 const selected=heroes.filter((h,i)=>i%3===(state.run-1)%3);
 const urls=[...Array.from({length:8},(_,i)=>'https://ow-atlas.com/top-500?platform=pc&page='+i),...selected.map(h=>'https://ow-atlas.com/top-500?platform=pc&hero='+encodeURIComponent(h.key)+'&page='+((state.run-1)%3))];
 for(const url of urls){if(stop||Date.now()>deadline)break;try{const r=await request(url);for(const p of discoverAtlas(await r.text())){addName(p.name,p.avatar,'hero-leaderboard');if(p.tag)state.players[identity(p.tag)]??={id:p.tag,name:p.name,origin:'hero-leaderboard',discoveredAt:now};}}catch(e){errors++;console.log('Discovery page unavailable: '+e.message);}}
 let names=Object.entries(state.names).filter(([,n])=>now-n.at>24*HOUR).sort(([a,x],[b,y])=>x.at-y.at||hash(a+state.run).localeCompare(hash(b+state.run)));
 // Rotate through both generic names and observed leaderboard names; no winner-only profile filter.
 const generic=names.filter(([,n])=>n.origin==='name-search'),observed=names.filter(([,n])=>n.origin!=='name-search');names=[];while(names.length<72&&(generic.length||observed.length)){if(generic.length&&names.length%4===0)names.push(generic.shift());else if(observed.length)names.push(observed.shift());else names.push(generic.shift());}
 for(const [name,n]of names){if(stop||Date.now()>deadline)break;try{const r=await request('https://overfast-api.tekrop.fr/players?name='+encodeURIComponent(name)+'&limit=200&order_by=last_updated_at%3Adesc'),j=await r.json();if(!Array.isArray(j.results))continue;n.at=Date.now();n.total=j.total;
  for(const p of j.results){const id=normalizeId(p.blizzard_id||p.player_id);if(!p.is_public||!isBlizzardId(id))continue;const k=identity(id),match=n.avatars.includes(p.avatar);if(!state.players[k]){state.players[k]={id,name:p.name,origin:match?'hero-leaderboard':n.origin,discoveredAt:now};added++;}const e=state.players[k];e.sourceUpdatedAt=p.last_updated_at?Number(p.last_updated_at)*1000:null;e.observed=Boolean(e.observed||match);}
 }catch(e){errors++;console.log('Name discovery unavailable: '+e.message);}}
 console.log('Discovery: '+Object.keys(state.players).length+' unique candidate IDs; '+added+' newly discovered.');
 const previousTimes=new Map();for(const r of [...old.pc,...old.console])previousTimes.set(identity(r.tag),Math.max(previousTimes.get(identity(r.tag))||0,r.at));
 for(const e of Object.values(state.players))if(previousTimes.has(identity(e.id)))e.usable=true;
 const eligible=Object.values(state.players).filter(e=>!e.retryAt||e.retryAt<=now).filter(e=>now-(e.checkedAt||previousTimes.get(identity(e.id))||0)>24*HOUR);
 // Fetch unseen profiles first; rotate old successful profiles before their rows expire.
 const priority=e=>{const at=e.checkedAt||previousTimes.get(identity(e.id))||0;if(at&&now-at>40*HOUR&&e.usable)return 5;if(!at&&e.observed)return 4;if(!at&&e.sourceUpdatedAt&&now-e.sourceUpdatedAt<90*24*HOUR)return 3;if(!at)return 2;return 1;};
 eligible.sort((a,b)=>priority(b)-priority(a)||(a.checkedAt||0)-(b.checkedAt||0)||hash(a.id+state.run).localeCompare(hash(b.id+state.run)));
 const queue=eligible.slice(0,budget);let next=0;
 async function worker(){while(next<queue.length&&!stop&&Date.now()<deadline){const entry=queue[next++],id=entry.id;try{
  const response=await request('https://overfast-api.tekrop.fr/players/'+encodeURIComponent(normalizeId(id))),payload=await response.json();const fetchedAt=Date.now(),age=Number(response.headers.get('age')||0),at=fetchedAt-Math.max(0,Number.isFinite(age)?age*1000:0);
  entry.checkedAt=fetchedAt;entry.usable=false;
  // A successful private/empty response removes that profile's earlier measurements.
  for(const platform of ['pc','console'])rows[platform]=rows[platform].filter(r=>identity(r.tag)!==identity(id));
  if(payload.summary&&payload.stats){publicProfiles++;entry.name=payload.summary.username||entry.name;entry.sourceUpdatedAt=Number(payload.summary.last_updated_at)*1000||entry.sourceUpdatedAt||null;
   for(const platform of ['pc','console'])for(const hero of heroes){const row=extract(payload,id,platform,hero.key,hero.role,at);if(!row.reject&&row.n>=5&&row.time>=1800){entry.usable=true;rows[platform].push({...row,playerId:identity(id),displayName:entry.name,discoverySource:entry.origin,sourceUpdatedAt:entry.sourceUpdatedAt});}}
  }
  if(!entry.usable)entry.retryAt=fetchedAt+7*24*HOUR;
 }catch(e){errors++;entry.checkedAt=Date.now();entry.retryAt=Date.now()+(e.status===404?7*24*HOUR:6*HOUR);console.log('Profile unavailable ('+e.message+'); previous fresh rows retained.');}
 checked++;if(checked%50===0)console.log('Fetched '+checked+'/'+queue.length+'; public='+publicProfiles+'; errors='+errors);
 }}
 await Promise.all([worker(),worker(),worker()]);
 fs.mkdirSync('references',{recursive:true});
 const report={version:1,at:Date.now(),run:state.run,candidates:Object.keys(state.players).length,newlyDiscovered:added,attempted:checked,publicFetched:publicProfiles,requests,errors,rateLimited:stop,cohortCap:COHORT_CAP,platforms:{}};
 for(const platform of ['pc','console']){const final=capRows(rows[platform]),groups=coverage(final),players=new Set(final.map(r=>identity(r.tag))).size;const output=pack(final,platform,{checked,discovered:report.candidates,errors,partial:stop||checked<eligible.length});fs.writeFileSync('references/'+platform+'.json',JSON.stringify(output));report.platforms[platform]={players,heroMeasurements:final.length,bytes:Buffer.byteLength(JSON.stringify(output)),groups};console.log(platform+': '+players+' unique public profiles, '+final.length+' hero measurements.');}
 fs.writeFileSync('references/discovery.json',JSON.stringify(state));fs.writeFileSync('references/coverage.json',JSON.stringify(report));
 console.log('Run complete: '+JSON.stringify({...report,platforms:Object.fromEntries(Object.entries(report.platforms).map(([k,v])=>[k,{...v,groups:undefined}]))}));
}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={unpack,pack,capRows,coverage,discoverAtlas,extraction,normalizeId,isBlizzardId,identity};
