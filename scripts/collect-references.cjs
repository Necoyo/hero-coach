// Collect public reference measurements for the static dashboard. No player credentials.
const fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('index.html','utf8');
const refCode=html.slice(html.indexOf('// All reference requests go directly'),html.indexOf('async function loadReference(){')).replace('return {collect};','return {collect,extract,seeds,friends};');
const utility=html.slice(html.indexOf('function usefulUtility('),html.indexOf('function performanceWeights('));
const context=vm.createContext({AbortSignal,setTimeout,localStorage:{getItem:()=>null,setItem(){}}});
vm.runInContext(utility+refCode+';this.refs=browserReferences;',context);
const {extract,seeds,friends}=context.refs;
const fallback=JSON.parse(html.match(/let catalog = (\[[^\n]+\]);/)[1]);
const tags=[...new Map([...friends,...seeds].map(t=>[t.toLowerCase(),t])).values()];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function json(url){const r=await fetch(url,{signal:AbortSignal.timeout(20000)});if(!r.ok){const e=Error('HTTP '+r.status);e.status=r.status;throw e;}return r.json();}
async function main(){
 let heroes=fallback;try{const h=await json('https://overfast-api.tekrop.fr/heroes');if(Array.isArray(h)&&h.length&&h.every(x=>typeof x.key==='string'&&['support','damage','tank'].includes(x.role)))heroes=h;}catch{}
 const started=Date.now(),rows={pc:[],console:[]};let checked=0,errors=0,publicProfiles=0,next=0,stopped=false,lastStart=0,throttle=Promise.resolve();
 const previous={};for(const platform of ['pc','console'])try{previous[platform]=JSON.parse(fs.readFileSync('references/'+platform+'.json','utf8')).rows;}catch{previous[platform]=[];}
 async function worker(){while(next<tags.length&&!stopped&&Date.now()-started<12*60000){
  const tag=tags[next++];throttle=throttle.then(async()=>{await sleep(Math.max(0,1100-(Date.now()-lastStart)));lastStart=Date.now();});await throttle;
  try{const payload=await json('https://overfast-api.tekrop.fr/players/'+encodeURIComponent(tag));
   if(payload.summary&&payload.stats){publicProfiles++;for(const platform of ['pc','console'])for(const hero of heroes){const r=extract(payload,tag,platform,hero.key,hero.role,Date.now());if(!r.reject&&r.n>=5&&r.time>=1800)rows[platform].push(r);}}
  }catch(e){errors++;for(const platform of ['pc','console'])rows[platform].push(...previous[platform].filter(r=>r.tag===tag&&Date.now()-r.at<48*3600000));if(e.status===429||e.status===403)stopped=true;}
  checked++;if(checked%20===0)console.log('Checked '+checked+'/'+tags.length+' profiles; '+publicProfiles+' public; '+errors+' unavailable.');
 }}
 await Promise.all([worker(),worker()]);
 // Preserve usable earlier measurements for an interrupted run without renewing their timestamps.
 const attempted=new Set(tags.slice(0,next));for(const platform of ['pc','console'])rows[platform].push(...previous[platform].filter(r=>!attempted.has(r.tag)&&Date.now()-r.at<48*3600000));
 if(publicProfiles<5)throw Error('Too few fresh public profiles; keeping the previous shared files.');
 fs.mkdirSync('references',{recursive:true});
 for(const platform of ['pc','console']){
  const value={version:1,source:'OverFast public profiles',platform,at:Date.now(),checked,discovered:tags.length,errors,partial:checked<tags.length,tags:tags.slice(0,next).map(t=>t.toLowerCase()),rows:rows[platform]};
  fs.writeFileSync('references/'+platform+'.json',JSON.stringify(value));
  console.log(platform+': '+value.rows.length+' hero measurements from '+new Set(value.rows.map(r=>r.tag)).size+' public profiles.');
 }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
