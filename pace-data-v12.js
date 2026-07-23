(function(root){
'use strict';

const DB_NAME='pace_local_v12';
const DB_VERSION=1;
const STORE_NAMES=['core','reports','masters','audit','recommendations','meta'];
const ACTOR='端末利用者';
const SCHEMA_VERSION=12;
const DAY_MS=86400000;
let db=null;
let pendingPreview=null;
let pendingRestore=null;

function uid(prefix){
  const id=(root.crypto&&root.crypto.randomUUID)?root.crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2);
  return (prefix||'id')+'_'+id;
}
function now(){return new Date().toISOString();}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function nval(v){
  const n=Number(String(v==null?'':v).replace(/,/g,'').trim());
  return Number.isFinite(n)?n:0;
}
function norm(v){
  return String(v==null?'':v).normalize('NFKC').replace(/[ 　\t\r\n]/g,'').toLowerCase();
}
function localDate(isoDate){
  const p=String(isoDate||'').split('-').map(Number);
  return p.length===3?new Date(p[0],p[1]-1,p[2]):new Date(NaN);
}
function isoDate(d){
  return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
}
function dateFromMD(reportDate,m,d){
  const y=Number(String(reportDate).slice(0,4));
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function scoreFromIssues(issues,base){
  let s=base==null?100:base;
  for(const x of issues)s-=x.level==='error'?20:x.level==='warn'?7:2;
  return Math.max(0,Math.min(100,Math.round(s)));
}
function issue(level,code,message){return{level,code,message};}
function stable(value){
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==='object'){
    const o={};Object.keys(value).sort().forEach(k=>{if(!['createdAt','updatedAt','resolved'].includes(k))o[k]=stable(value[k]);});return o;
  }
  return value;
}
function sameData(a,b){return JSON.stringify(stable(a))===JSON.stringify(stable(b));}
function nameObj(kind,raw){return{kind,raw:String(raw||'').trim(),id:null,canonical:null,status:'unresolved',candidates:[]};}

function splitHeadings(text){
  const out=[];const re=/【([^】]+)】/g;let m;const hits=[];
  while((m=re.exec(text)))hits.push({name:m[1].trim(),start:m.index,bodyStart:re.lastIndex});
  hits.forEach((h,i)=>out.push({name:h.name,raw:text.slice(h.start,i+1<hits.length?hits[i+1].start:text.length),body:text.slice(h.bodyStart,i+1<hits.length?hits[i+1].start:text.length)}));
  return out;
}
function parseAllocationText(raw){
  const arr=[];if(!raw)return arr;
  const parts=String(raw).split(/[、,，]/);
  for(const part of parts){
    const m=part.trim().match(/^(.+?)\s*([\d,.]+)\s*件?\s*$/);
    if(!m)continue;
    const nm=m[1].replace(/[→:：]/g,'').trim();
    if(nm)arr.push({venue:nameObj('venue',nm),count:nval(m[2])});
  }
  return arr;
}
function parseCategory(body,label,issues){
  const re=new RegExp('◇'+label+'\\s*→\\s*([\\d,.]+)件([\\s\\S]*?)(?=◇(?:MNP|新規|合計)|来店予約|当月累計|$)');
  const m=body.match(re);
  if(!m){issues.push(issue('error','missing_'+label,label+'欄を認識できません'));return{label,total:0,channels:{store:0,instant:0,later:0},allocations:{instant:[],later:[]}};}
  const seg=m[2],channels={store:0,instant:0,later:0},allocations={instant:[],later:[]};
  const pats=[['store','店舗'],['instant','即日'],['later','後日']];
  for(const [key,jp] of pats){
    const x=seg.match(new RegExp(jp+'\\s*→\\s*([\\d,.]+)\\s*件(?:\\s*[\\(（]([^\\)）]*)[\\)）])?'));
    if(x){channels[key]=nval(x[1]);if(key!=='store')allocations[key]=parseAllocationText(x[2]);}
    else issues.push(issue('warn','missing_channel',label+'の'+jp+'内訳を認識できません'));
  }
  const total=nval(m[1]);
  const channelSum=channels.store+channels.instant+channels.later;
  if(total!==channelSum)issues.push(issue('error','category_sum',`${label}${total}件と内訳${channelSum}件が一致しません`));
  for(const key of ['instant','later']){
    const a=allocations[key].reduce((s,x)=>s+x.count,0);
    if(a&&a!==channels[key])issues.push(issue('error','allocation_sum',`${label}の${key==='instant'?'即日':'後日'}${channels[key]}件と会場内訳${a}件が一致しません`));
    if(channels[key]>0&&!a)issues.push(issue('warn','allocation_missing',`${label}の${key==='instant'?'即日':'後日'}元会場が未記載です`));
  }
  return{label,total,channels,allocations};
}
function parseReservations(body,reportDate,issues){
  const rows=[];const re=/来店予約\s*[（(]\s*(\d{1,2})\/(\d{1,2})(?:\s*[〜～~\-]\s*(\d{1,2})\/(\d{1,2}))?\s*[）)]([\s\S]*?)(?=来店予約|当月累計|$)/g;let m;
  while((m=re.exec(body))){
    const seg=m[5];
    const get=k=>{const x=seg.match(new RegExp(k+'\\s*→\\s*([\\d,.]+)件'));return x?nval(x[1]):0;};
    const endMonth=m[3]||m[1],endDay=m[4]||m[2];
    const row={start:dateFromMD(reportDate,m[1],m[2]),end:dateFromMD(reportDate,endMonth,endDay),mnp:get('MNP'),new:get('新規'),total:get('合計')};
    const period=m[3]?`${m[1]}/${m[2]}〜${m[3]}/${m[4]}`:`${m[1]}/${m[2]}`;
    if(row.total!==row.mnp+row.new)issues.push(issue('error','reservation_sum',`${period}の予約合計が一致しません`));
    rows.push(row);
  }
  if(!rows.length)issues.push(issue('warn','reservation_missing','来店予約欄を認識できません'));
  return rows;
}
function parseStoreRaw(text,reportDate){
  const blocks=splitHeadings(text);const entities=[];const globalIssues=[];
  if(!blocks.length)globalIssues.push(issue('error','no_store_blocks','【店舗名】のブロックを認識できません'));
  for(const b of blocks){
    const issues=[];
    const dm=b.body.match(/(?:^|\n)\s*(\d{1,2})\/(\d{1,2})\s*(?=\n|$)/);
    const embeddedDate=dm?dateFromMD(reportDate,dm[1],dm[2]):null;
    if(!embeddedDate)issues.push(issue('warn','embedded_date_missing','本文の日付を認識できません'));
    else if(embeddedDate!==reportDate)issues.push(issue('error','date_mismatch',`指定日${reportDate}と本文の日付${embeddedDate}が一致しません`));
    const mnp=parseCategory(b.body,'MNP',issues);
    const fresh=parseCategory(b.body,'新規',issues);
    const tm=b.body.match(/◇合計\s*→\s*([\d,.]+)件/);
    const total=tm?nval(tm[1]):mnp.total+fresh.total;
    if(!tm)issues.push(issue('error','total_missing','当日合計を認識できません'));
    if(total!==mnp.total+fresh.total)issues.push(issue('error','daily_sum',`当日合計${total}件とMNP＋新規${mnp.total+fresh.total}件が一致しません`));
    const cumulative={
      newIdPoints:(()=>{const x=b.body.match(/新規ID\s*Pt合計\s*→\s*([\d,.]+)\s*pt/i);return x?nval(x[1]):null;})(),
      pixel:(()=>{const x=b.body.match(/当月累計\s*Pixel実績[\s\S]*?→\s*([\d,.]+)件/i);return x?nval(x[1]):null;})(),
      deviceChange:(()=>{const x=b.body.match(/当月累計機変実績[\s\S]*?→\s*([\d,.]+)件/);return x?nval(x[1]):null;})(),
      cellUp:(()=>{const x=b.body.match(/当月累計セルアップ実績[\s\S]*?→\s*([\d,.]+)件/);return x?nval(x[1]):null;})()
    };
    Object.entries(cumulative).forEach(([k,v])=>{if(v==null)issues.push(issue('warn','cumulative_missing','累計項目「'+k+'」を認識できません'));});
    entities.push({
      kind:'store',store:nameObj('store',b.name),embeddedDate,mnp,new: fresh,total,
      reservations:parseReservations(b.body,reportDate,issues),cumulative,raw:b.raw,issues,
      confidence:scoreFromIssues(issues)
    });
  }
  return{type:'store',reportDate,entities,issues:globalIssues,confidence:scoreFromIssues(globalIssues,entities.length?100:20)};
}

function eventBlocks(text){
  const re=/(?:^|\n)\s*([^\n【】]+?)\s*\n\s*最終(?:の)?報告致します。/g;let m;const hits=[];
  while((m=re.exec(text)))hits.push({name:m[1].trim(),start:m.index+(m[0][0]==='\n'?1:0),bodyStart:re.lastIndex});
  return hits.map((h,i)=>({name:h.name,raw:text.slice(h.start,i+1<hits.length?hits[i+1].start:text.length),body:text.slice(h.bodyStart,i+1<hits.length?hits[i+1].start:text.length)}));
}
function classifyProduct(label){
  const n=norm(label);
  if(n.includes('機変')||n.includes('機種変更'))return'deviceChange';
  if(n.includes('セルアップ'))return'cellUp';
  if(n.includes('pixel'))return'pixel';
  if(n.includes('新規'))return'new';
  return'mnp';
}
function parseEventRaw(text,reportDate){
  const blocks=eventBlocks(text);const entities=[];const globalIssues=[];
  if(!blocks.length)globalIssues.push(issue('error','no_event_blocks','「会場名＋最終報告」のブロックを認識できません'));
  for(const b of blocks){
    const issues=[];const lines=b.body.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
    let carrier='';const products=[];let skipDevice=false;
    let appealDevice=null;
    for(let i=0;i<lines.length;i++){
      const line=lines[i];
      if(/イベントにおける訴求(?:端末|機種)/.test(line)){appealDevice=lines[i+1]||null;skipDevice=true;continue;}
      if(skipDevice){skipDevice=false;continue;}
      if(line==='au'||line==='UQ'){carrier=line;continue;}
      if(/^総販/.test(line)||/報告致します/.test(line))continue;
      const m=line.match(/^(.+?)\s*([\d,.]+)\s*[（(]\s*見込\s*([\d,.]+)\s*[）)]$/);
      if(!m)continue;
      let label=m[1].trim();
      if(!/(?:au|uq)/i.test(label)&&carrier)label=carrier+' '+label;
      const opened=nval(m[2]),prospect=nval(m[3]),category=classifyProduct(label);
      products.push({label,category,opened,prospect,gross:opened+prospect,eligible:category==='mnp'||category==='new'});
    }
    const tm=b.body.match(/総販\s*([\d,.]+)件/);const total=tm?nval(tm[1]):products.reduce((s,x)=>s+x.gross,0);
    if(!tm)issues.push(issue('error','event_total_missing','総販を認識できません'));
    const calc=products.reduce((s,x)=>s+x.gross,0);
    if(total!==calc)issues.push(issue('error','event_total_mismatch',`総販${total}件と開通済＋見込み${calc}件が一致しません`));
    if(!products.length&&total!==0)issues.push(issue('error','event_products_missing','商材内訳を認識できません'));
    entities.push({
      kind:'event',venue:nameObj('venue',b.name),appealDevice,products,total,
      opened:products.reduce((s,x)=>s+x.opened,0),prospect:products.reduce((s,x)=>s+x.prospect,0),
      eligibleGross:products.filter(x=>x.eligible).reduce((s,x)=>s+x.gross,0),
      raw:b.raw,issues,confidence:scoreFromIssues(issues)
    });
  }
  return{type:'event',reportDate,entities,issues:globalIssues,confidence:scoreFromIssues(globalIssues,entities.length?100:20)};
}

function cumulativeBlocks(text,reportDate){
  const re=/(\d{1,2})\/(\d{1,2})\s*[〜～~\-]\s*(\d{1,2})\/(\d{1,2})\s*[（(]\s*(\d{1,2})\/(\d{1,2})現在\s*[）)]\s*\n\s*([^\n]+)/g;let m;const hits=[];
  while((m=re.exec(text)))hits.push({start:m.index,bodyStart:re.lastIndex,startDate:dateFromMD(reportDate,m[1],m[2]),endDate:dateFromMD(reportDate,m[3],m[4]),asOf:dateFromMD(reportDate,m[5],m[6]),name:m[7].trim()});
  return hits.map((h,i)=>({...h,raw:text.slice(h.start,i+1<hits.length?hits[i+1].start:text.length),body:text.slice(h.bodyStart,i+1<hits.length?hits[i+1].start:text.length)}));
}
function parseStaffProducts(seg){
  const out=[];
  seg.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).forEach(line=>{
    const m=line.match(/^(.+?)\s*([\d,.]+)件$/);
    if(m&&!/^総販/.test(line))out.push({label:m[1].trim(),category:classifyProduct(m[1]),count:nval(m[2])});
  });
  return out;
}
function parseCumulativeRaw(text,reportDate){
  const blocks=cumulativeBlocks(text,reportDate);const entities=[];const globalIssues=[];
  if(!blocks.length)globalIssues.push(issue('error','no_cumulative_blocks','イベント期間・現在日・会場名を認識できません'));
  for(const b of blocks){
    const issues=[];
    if(b.asOf!==reportDate)issues.push(issue('error','date_mismatch',`指定日${reportDate}と「${b.asOf}現在」が一致しません`));
    const beforeTotal=(b.body.split(/《合計》/)[0]||'');const staff=[];const re=/□([^□\n]+)□/g;let m;const hits=[];
    while((m=re.exec(beforeTotal)))hits.push({name:m[1].trim(),start:m.index,bodyStart:re.lastIndex});
    hits.forEach((h,i)=>{
      const seg=beforeTotal.slice(h.bodyStart,i+1<hits.length?hits[i+1].start:beforeTotal.length);
      staff.push({staff:nameObj('staff',h.name),products:parseStaffProducts(seg)});
    });
    const aggPart=(b.body.split(/《合計》/)[1]||'');const aggregates=[];
    aggPart.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).forEach(line=>{
      const x=line.match(/^(.+?)\s*([\d,.]+)件\s*[（(]\s*開通済\s*([\d,.]+)件\s*[）)]$/);
      if(x){
        const prospect=nval(x[2]),opened=nval(x[3]),category=classifyProduct(x[1]);
        aggregates.push({label:x[1].trim(),category,prospect,opened,gross:prospect+opened,eligible:category==='mnp'||category==='new'});
      }
    });
    const tm=aggPart.match(/総販\s*([\d,.]+)件/);const total=tm?nval(tm[1]):aggregates.reduce((s,x)=>s+x.gross,0);
    const staffTotal=staff.reduce((s,x)=>s+x.products.reduce((a,p)=>a+p.count,0),0);
    const aggTotal=aggregates.reduce((s,x)=>s+x.gross,0);
    if(!staff.length)issues.push(issue('warn','staff_missing','スタッフ別内訳を認識できません'));
    if(!aggregates.length)issues.push(issue('error','aggregate_missing','商材別の見込み・開通済を認識できません'));
    if(total!==aggTotal)issues.push(issue('error','cumulative_total_mismatch',`総販${total}件と見込み＋開通済${aggTotal}件が一致しません`));
    if(staffTotal!==total)issues.push(issue('error','staff_total_mismatch',`スタッフ別累計${staffTotal}件と総販${total}件が一致しません`));
    entities.push({
      kind:'cumulative',venue:nameObj('venue',b.name),period:{start:b.startDate,end:b.endDate},asOf:b.asOf,
      staff,aggregates,total,raw:b.raw,issues,confidence:scoreFromIssues(issues)
    });
  }
  return{type:'cumulative',reportDate,entities,issues:globalIssues,confidence:scoreFromIssues(globalIssues,entities.length?100:20)};
}

function nameObjects(parsed){
  const out=[];
  for(const e of parsed.entities){
    if(e.store)out.push(e.store);
    if(e.venue)out.push(e.venue);
    for(const cat of [e.mnp,e.new].filter(Boolean)){
      for(const k of ['instant','later'])for(const a of(cat.allocations[k]||[]))out.push(a.venue);
    }
    for(const s of(e.staff||[]))out.push(s.staff);
  }
  return out;
}

function openDb(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=()=>{
      const d=req.result;
      if(!d.objectStoreNames.contains('core'))d.createObjectStore('core',{keyPath:'key'});
      if(!d.objectStoreNames.contains('reports')){
        const s=d.createObjectStore('reports',{keyPath:'id'});
        s.createIndex('uniqueKey','uniqueKey',{unique:false});s.createIndex('type','type',{unique:false});s.createIndex('reportDate','reportDate',{unique:false});
      }
      if(!d.objectStoreNames.contains('masters')){
        const s=d.createObjectStore('masters',{keyPath:'id'});
        s.createIndex('kind','kind',{unique:false});s.createIndex('canonicalKey','canonicalKey',{unique:false});
      }
      if(!d.objectStoreNames.contains('audit')){
        const s=d.createObjectStore('audit',{keyPath:'id'});
        s.createIndex('timestamp','timestamp',{unique:false});
      }
      if(!d.objectStoreNames.contains('recommendations'))d.createObjectStore('recommendations',{keyPath:'id'});
      if(!d.objectStoreNames.contains('meta'))d.createObjectStore('meta',{keyPath:'key'});
    };
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  });
}
function dbGet(store,key){
  return new Promise((resolve,reject)=>{const r=db.transaction(store,'readonly').objectStore(store).get(key);r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error);});
}
function dbAll(store){
  return new Promise((resolve,reject)=>{const r=db.transaction(store,'readonly').objectStore(store).getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error);});
}
function dbPut(store,value){
  return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(value);tx.oncomplete=()=>resolve(value);tx.onerror=()=>reject(tx.error);});
}
function dbDelete(store,key){
  return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).delete(key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
}
async function audit(action,target,reason,details){
  if(!db)return;
  await dbPut('audit',{id:uid('audit'),action,target,reason:reason||'',details:details||null,actor:ACTOR,timestamp:now()});
}

const DEFAULT_MASTERS=[];
async function seedMasters(){
  const all=await dbAll('masters');
  for(const [kind,canonical,aliases] of DEFAULT_MASTERS){
    const keys=[canonical,...aliases].map(norm);
    let rec=all.find(x=>x.kind===kind&&x.active&&x.canonicalKey===norm(canonical));
    if(!rec)rec=all.find(x=>x.kind===kind&&x.active&&keys.includes(x.canonicalKey));
    if(rec){
      const oldCanonical=rec.canonical;
      rec.canonical=canonical;rec.canonicalKey=norm(canonical);
      rec.aliases=[...(rec.aliases||[]),...(norm(oldCanonical)===norm(canonical)?[]:[oldCanonical]),...aliases]
        .filter((x,i,a)=>norm(x)!==norm(canonical)&&a.findIndex(y=>norm(y)===norm(x))===i);
      await dbPut('masters',rec);
    }else{
      rec={id:uid(kind),kind,canonical,canonicalKey:norm(canonical),aliases,active:true,createdAt:now(),lastUsedAt:null,redirectTo:null};
      await dbPut('masters',rec);all.push(rec);
    }
  }
}
function levenshtein(a,b){
  a=norm(a);b=norm(b);const m=Array.from({length:a.length+1},()=>Array(b.length+1).fill(0));
  for(let i=0;i<=a.length;i++)m[i][0]=i;for(let j=0;j<=b.length;j++)m[0][j]=j;
  for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)m[i][j]=Math.min(m[i-1][j]+1,m[i][j-1]+1,m[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
  return m[a.length][b.length];
}
async function resolveNameObject(obj,masters){
  if(!obj||obj.id)return obj;
  const list=masters.filter(x=>x.kind===obj.kind&&x.active);
  const key=norm(obj.raw);
  const exact=list.filter(x=>x.canonicalKey===key||(x.aliases||[]).some(a=>norm(a)===key));
  if(exact.length===1){
    obj.id=exact[0].id;obj.canonical=exact[0].canonical;obj.status=exact[0].canonicalKey===key?'exact':'alias';
    exact[0].lastUsedAt=now();await dbPut('masters',exact[0]);return obj;
  }
  const ranked=list.map(x=>({x,d:Math.min(levenshtein(obj.raw,x.canonical),...(x.aliases||[]).map(a=>levenshtein(obj.raw,a)))})).sort((a,b)=>a.d-b.d);
  const limit=Math.max(1,Math.floor(key.length*.25));obj.candidates=ranked.filter(r=>r.d<=limit).slice(0,5).map(r=>({id:r.x.id,canonical:r.x.canonical,distance:r.d}));
  obj.status=obj.candidates.length===1?'candidate':obj.candidates.length>1?'ambiguous':'unknown';
  return obj;
}
async function resolveParsedNames(parsed){
  const masters=await dbAll('masters');
  for(const o of nameObjects(parsed))await resolveNameObject(o,masters);
  return parsed;
}
function unresolvedRefs(parsed){
  const map=new Map();
  for(const o of nameObjects(parsed)){
    if(!o.id){
      const k=o.kind+'|'+norm(o.raw);
      if(!map.has(k))map.set(k,{key:k,kind:o.kind,raw:o.raw,candidates:o.candidates||[],objects:[]});
      map.get(k).objects.push(o);
    }
  }
  return[...map.values()];
}
function newNameRefs(parsed){
  const map=new Map();
  for(const o of nameObjects(parsed)){
    if(o.id&&String(o.id).startsWith('__new__:')){
      const k=o.kind+'|'+norm(o.raw);
      if(!map.has(k))map.set(k,{key:k,kind:o.kind,raw:o.raw,objects:[]});
      map.get(k).objects.push(o);
    }
  }
  return[...map.values()];
}
async function addMaster(kind,canonical,aliases){
  const all=await dbAll('masters');const key=norm(canonical);
  if(all.some(x=>x.kind===kind&&x.active&&(x.canonicalKey===key||(x.aliases||[]).some(a=>norm(a)===key))))throw new Error('同じ名称または別名が登録されています');
  const rec={id:uid(kind),kind,canonical:String(canonical).trim(),canonicalKey:key,aliases:(aliases||[]).map(x=>String(x).trim()).filter(Boolean),active:true,createdAt:now(),lastUsedAt:null,redirectTo:null};
  await dbPut('masters',rec);return rec;
}
function applyResolution(ref,id,canonical,status){
  for(const o of ref.objects){o.id=id;o.canonical=canonical;o.status=status||'selected';}
}

function subjectOf(e){return e.store||e.venue;}
function uniqueKey(type,date,e){
  const s=subjectOf(e);const sid=s&&s.id?s.id:norm(s&&s.raw);
  if(type==='cumulative')return`${type}|${e.asOf}|${sid}|${e.period.start}|${e.period.end}`;
  return`${type}|${date}|${sid}`;
}
function summaryEntity(type,e){
  if(type==='store')return{store:e.store.canonical||e.store.raw,total:e.total,mnp:e.mnp.total,new:e.new.total,reservations:e.reservations.reduce((s,x)=>s+x.total,0),cumulative:e.cumulative};
  if(type==='event')return{venue:e.venue.canonical||e.venue.raw,total:e.total,opened:e.opened,prospect:e.prospect,eligibleGross:e.eligibleGross,appealDevice:e.appealDevice,products:e.products};
  return{venue:e.venue.canonical||e.venue.raw,period:e.period,asOf:e.asOf,total:e.total,staff:e.staff.map(s=>({name:s.staff.canonical||s.staff.raw,total:s.products.reduce((a,p)=>a+p.count,0)})),aggregates:e.aggregates};
}
async function attachExisting(parsed){
  const reports=await dbAll('reports');
  parsed.existing={};
  for(const e of parsed.entities){
    e.issues=(e.issues||[]).filter(x=>!String(x.code||'').startsWith('history_'));
    if(!subjectOf(e).id)continue;
    const k=uniqueKey(parsed.type,parsed.reportDate,e);
    const old=reports.filter(x=>x.uniqueKey===k&&x.active).sort((a,b)=>b.version-a.version)[0]||null;
    parsed.existing[k]=old;
    const previous=reports.filter(x=>x.active&&x.type===parsed.type&&x.subjectId===subjectOf(e).id&&x.reportDate<parsed.reportDate).sort((a,b)=>b.reportDate.localeCompare(a.reportDate))[0]||null;
    if(previous&&parsed.type==='store'){
      const labels={newIdPoints:'新規ID Pt',pixel:'Pixel',deviceChange:'機種変更',cellUp:'セルアップ'};
      for(const key of Object.keys(labels)){
        const before=previous.parsed&&previous.parsed.cumulative?previous.parsed.cumulative[key]:null;
        const after=e.cumulative?e.cumulative[key]:null;
        if(before!=null&&after!=null&&after<before)e.issues.push(issue('error','history_cumulative_decrease',`${labels[key]}累計が前回${before}から${after}へ減少しています`));
      }
    }
    if(previous&&parsed.type==='cumulative'){
      const before=previous.parsed&&previous.parsed.total;
      if(before!=null&&e.total<before)e.issues.push(issue('error','history_cumulative_decrease',`イベント累計が前回${before}件から${e.total}件へ減少しています`));
    }
    e.confidence=scoreFromIssues(e.issues);
  }
}

function allIssues(parsed){
  return[...(parsed.issues||[]),...parsed.entities.flatMap(e=>e.issues||[])];
}
function renderIssueHtml(issues){
  if(!issues.length)return'<p class="note ok">数値・日付・内訳の整合性チェックを通過しました。</p>';
  return issues.map(x=>`<p class="note ${x.level==='error'?'bad':x.level==='warn'?'warn':''}">${x.level==='error'?'要確認':'確認'}：${esc(x.message)}</p>`).join('');
}
function confidenceOf(parsed){
  const scores=[parsed.confidence,...parsed.entities.map(e=>e.confidence)];return Math.round(scores.reduce((a,b)=>a+b,0)/Math.max(1,scores.length));
}
function confidenceClass(v){return v>=95?'ok':v>=80?'warn':'bad';}
function previewTable(type,entities){
  let h='<table><thead><tr>';
  if(type==='store')h+='<th>店舗</th><th class="r">MNP</th><th class="r">新規</th><th class="r">合計</th><th class="r">予約</th>';
  else if(type==='event')h+='<th>会場</th><th class="r">開通済</th><th class="r">見込み</th><th class="r">総販</th><th class="r">対象獲得</th>';
  else h+='<th>会場</th><th>期間</th><th class="r">見込み</th><th class="r">開通済</th><th class="r">総販</th>';
  h+='</tr></thead><tbody>';
  for(const e of entities){
    const s=subjectOf(e);const name=esc(s.canonical||s.raw);
    if(type==='store')h+=`<tr><td>${name}</td><td class="r">${e.mnp.total}</td><td class="r">${e.new.total}</td><td class="r"><b>${e.total}</b></td><td class="r">${e.reservations.reduce((a,x)=>a+x.total,0)}</td></tr>`;
    else if(type==='event')h+=`<tr><td>${name}</td><td class="r">${e.opened}</td><td class="r">${e.prospect}</td><td class="r"><b>${e.total}</b></td><td class="r">${e.eligibleGross}</td></tr>`;
    else{
      const p=e.aggregates.reduce((a,x)=>a+x.prospect,0),o=e.aggregates.reduce((a,x)=>a+x.opened,0);
      h+=`<tr><td>${name}</td><td>${e.period.start.slice(5)}〜${e.period.end.slice(5)}</td><td class="r">${p}</td><td class="r">${o}</td><td class="r"><b>${e.total}</b></td></tr>`;
    }
  }
  return h+'</tbody></table>';
}
function renderDiff(parsed){
  let html='';
  for(const e of parsed.entities){
    if(!subjectOf(e).id)continue;
    const k=uniqueKey(parsed.type,parsed.reportDate,e),old=parsed.existing&&parsed.existing[k],cur=summaryEntity(parsed.type,e);
    if(!old){html+=`<p class="note ok">${esc(subjectOf(e).canonical||subjectOf(e).raw)}：新規報告として保存します。</p>`;continue;}
    const oldS=old.summary||summaryEntity(parsed.type,old.parsed);
    if(sameData(oldS,cur))html+=`<p class="note warn">${esc(subjectOf(e).canonical||subjectOf(e).raw)}：保存済み報告と同一です。重複保存しません。</p>`;
    else html+=`<details style="margin-top:8px"><summary>${esc(subjectOf(e).canonical||subjectOf(e).raw)}：保存済み報告との差分があります</summary><pre class="out" style="margin-top:8px;font-size:11px">更新前\n${esc(JSON.stringify(oldS,null,2))}\n\n更新後\n${esc(JSON.stringify(cur,null,2))}</pre></details>`;
  }
  return html;
}
function renderResolution(parsed){
  const refs=unresolvedRefs(parsed);parsed.unresolved=refs;
  if(!refs.length)return'';
  const kindLabel={store:'店舗',venue:'会場',staff:'スタッフ'};
  let html='<p class="note warn">未登録または候補確認が必要な名称があります。選択するまで保存できません。</p>';
  refs.forEach((r,i)=>{
    const opts=r.candidates.map(c=>`<option value="${esc(c.id)}">${esc(c.canonical)}（候補）</option>`).join('');
    html+=`<div class="row" style="margin-bottom:8px"><div><label class="f">${kindLabel[r.kind]}：${esc(r.raw)}</label><select id="resolution_${i}" onchange="PACEV12.chooseResolution(${i},this.value)"><option value="">選択してください</option>${opts}<option value="__new__">「${esc(r.raw)}」を正式名称として新規登録</option></select></div><div class="note" style="display:flex;align-items:flex-end">候補が違う場合は新規登録してください。</div></div>`;
  });
  return html;
}
function renderPreview(){
  const p=pendingPreview;if(!p)return;
  const c=confidenceOf(p);const badge=document.getElementById('reportConfidence');
  badge.textContent=c+'%';badge.className='tag '+confidenceClass(c);
  document.getElementById('reportIssues').innerHTML=renderIssueHtml(allIssues(p));
  document.getElementById('reportResolutions').innerHTML=renderResolution(p);
  document.getElementById('reportPreview').innerHTML=previewTable(p.type,p.entities);
  document.getElementById('reportDiff').innerHTML=renderDiff(p);
  document.getElementById('reportPreviewCard').classList.remove('hidden');
}

async function parseReport(){
  const type=document.getElementById('reportType').value,date=document.getElementById('reportDate').value,raw=document.getElementById('reportRaw').value.trim(),msg=document.getElementById('reportParseMsg');
  if(!date){msg.textContent='報告基準日を先に指定してください。';return;}
  if(!raw){msg.textContent='報告文を貼り付けてください。';return;}
  let parsed=type==='store'?parseStoreRaw(raw,date):type==='event'?parseEventRaw(raw,date):parseCumulativeRaw(raw,date);
  parsed.sourceText=raw;await resolveParsedNames(parsed);await attachExisting(parsed);pendingPreview=parsed;renderPreview();
  msg.textContent=`${parsed.entities.length}件の報告ブロックを解析しました。保存前に内容を確認してください。`;
}
async function chooseResolution(index,value){
  if(!pendingPreview)return;const ref=pendingPreview.unresolved[index];if(!ref)return;
  if(!value){for(const o of ref.objects){o.id=null;o.canonical=null;}renderPreview();return;}
  if(value==='__new__')applyResolution(ref,'__new__:'+ref.key,ref.raw,'new');
  else{
    const m=await dbGet('masters',value);if(m)applyResolution(ref,m.id,m.canonical,'selected');
  }
  await attachExisting(pendingPreview);renderPreview();
}
async function materializeNewNames(parsed){
  const refs=newNameRefs(parsed);
  for(const ref of refs){
    const marker=ref.objects[0].id;
    if(marker&&marker.startsWith('__new__:')){
      const m=await addMaster(ref.kind,ref.raw,[]);
      applyResolution(ref,m.id,m.canonical,'new');
      await audit('master_create',m.id,'報告取込時に新規登録',{kind:m.kind,canonical:m.canonical});
    }
  }
}
async function savePreview(){
  if(!pendingPreview)return;
  if(unresolvedRefs(pendingPreview).some(r=>!r.objects[0].id)){toast('未登録名称の処理を選択してください');return;}
  await materializeNewNames(pendingPreview);await attachExisting(pendingPreview);
  const reason=document.getElementById('reportReason').value.trim();
  let changedExisting=false;
  for(const e of pendingPreview.entities){
    const k=uniqueKey(pendingPreview.type,pendingPreview.reportDate,e),old=pendingPreview.existing[k],cur=summaryEntity(pendingPreview.type,e);
    if(old&&!sameData(old.summary,cur))changedExisting=true;
  }
  if(changedExisting&&!reason){toast('更新理由を入力してください');return;}
  if(allIssues(pendingPreview).some(x=>x.level==='error')&&!confirm('要確認項目があります。内容を確認したうえで保存しますか？'))return;
  let saved=0,skipped=0;
  for(const e of pendingPreview.entities){
    const k=uniqueKey(pendingPreview.type,pendingPreview.reportDate,e),old=pendingPreview.existing[k],summary=summaryEntity(pendingPreview.type,e);
    if(old&&sameData(old.summary,summary)){skipped++;continue;}
    if(old){old.active=false;old.supersededAt=now();await dbPut('reports',old);}
    const rec={
      id:uid('report'),uniqueKey:k,type:pendingPreview.type,reportDate:pendingPreview.reportDate,
      subjectId:subjectOf(e).id,subjectNameSnapshot:subjectOf(e).canonical||subjectOf(e).raw,
      sourceText:e.raw||pendingPreview.sourceText,parsed:e,summary,confidence:e.confidence,
      issues:e.issues||[],version:old?(old.version||1)+1:1,active:true,actor:ACTOR,
      createdAt:now(),updatedAt:now(),reason:old?reason:'新規取込'
    };
    await dbPut('reports',rec);
    await audit(old?'report_update':'report_create',rec.id,rec.reason,{uniqueKey:k,previousId:old&&old.id,summary});
    saved++;
  }
  if(pendingPreview.type==='store'&&saved)await rebuildCoreFromStoreReports();
  document.getElementById('reportReason').value='';
  document.getElementById('reportRaw').value='';
  document.getElementById('reportPreviewCard').classList.add('hidden');
  pendingPreview=null;await renderHistory();await renderDataManager();
  toast(`${saved}件保存${skipped?`・重複${skipped}件除外`:''}`);
}

async function rebuildCoreFromStoreReports(){
  const active=(await dbAll('reports')).filter(x=>x.active&&x.type==='store');
  const byDate={};
  for(const r of active){
    const e=r.parsed;(byDate[r.reportDate]=byDate[r.reportDate]||{actual:0,forecast:0}).actual+=e.total;
    byDate[r.reportDate].forecast+=e.reservations.reduce((s,x)=>s+x.total,0);
  }
  D.actuals=D.actuals||[];D.forecasts=D.forecasts||[];
  for(const [date,v] of Object.entries(byDate)){
    const a=D.actuals.find(x=>x.date===date);
    if(a){a.total=v.actual;a.source='store_reports';}else D.actuals.push({date,total:v.actual,source:'store_reports'});
    const f=D.forecasts.find(x=>x.date===date);
    if(f){f.count=v.forecast;f.source='store_reservations';}else D.forecasts.push({date,count:v.forecast,source:'store_reservations'});
  }
  const latest=Object.keys(byDate).sort().pop();if(latest&&latest>D.basisDate)D.basisDate=latest;
  fillSettings();renderAll();
}

async function renderHistory(){
  if(!db)return;
  const all=(await dbAll('reports')).filter(x=>x.active).sort((a,b)=>b.reportDate.localeCompare(a.reportDate)||b.updatedAt.localeCompare(a.updatedAt));
  const el=document.getElementById('reportHistory');if(!el)return;
  if(!all.length){el.innerHTML='<p class="note">まだ報告を取り込んでいません。</p>';return;}
  const labels={store:'店舗',event:'イベント',cumulative:'イベント累計'};
  el.innerHTML=all.slice(0,100).map(r=>`<details class="sgroup"><summary>${r.reportDate}｜${labels[r.type]}｜${esc(r.subjectNameSnapshot)}｜信頼度${r.confidence}%｜Ver.${r.version}</summary><pre class="out" style="margin-top:8px;font-size:11px">${esc(r.sourceText)}</pre></details>`).join('');
}

async function addMasterFromForm(){
  const kind=document.getElementById('nameKind').value,canonical=document.getElementById('nameCanonical').value.trim(),aliases=document.getElementById('nameAliases').value.split(/[、,，]/).map(x=>x.trim()).filter(Boolean);
  if(!canonical){toast('正式名称を入力してください');return;}
  try{
    const m=await addMaster(kind,canonical,aliases);await audit('master_create',m.id,'名称管理画面から追加',{kind,canonical,aliases});
    document.getElementById('nameCanonical').value='';document.getElementById('nameAliases').value='';await renderMasters();toast('名称を追加しました');
  }catch(e){toast(e.message);}
}
async function editMaster(id){
  const m=await dbGet('masters',id);if(!m)return;const v=prompt('正式名称を変更',m.canonical);if(v==null||!v.trim())return;
  const before=m.canonical;m.canonical=v.trim();m.canonicalKey=norm(m.canonical);await dbPut('masters',m);await audit('master_rename',id,'正式名称を変更',{before,after:m.canonical});await renderMasters();
}
async function addAliasToMaster(id){
  const m=await dbGet('masters',id);if(!m)return;const v=prompt('追加する別名');if(v==null||!v.trim())return;
  m.aliases=m.aliases||[];if(!m.aliases.some(x=>norm(x)===norm(v)))m.aliases.push(v.trim());
  await dbPut('masters',m);await audit('master_alias_add',id,'別名を追加',{alias:v.trim()});await renderMasters();
}
async function toggleMaster(id){
  const m=await dbGet('masters',id);if(!m)return;m.active=!m.active;await dbPut('masters',m);await audit('master_toggle',id,m.active?'有効化':'無効化',{active:m.active});await renderMasters();
}
function replaceIds(value,from,to){
  if(Array.isArray(value))return value.map(x=>replaceIds(x,from,to));
  if(value&&typeof value==='object'){Object.keys(value).forEach(k=>{value[k]=replaceIds(value[k],from,to);});return value;}
  return value===from?to:value;
}
async function mergeMaster(id){
  const src=await dbGet('masters',id);if(!src)return;const targetName=prompt('統合先の正式名称を入力');if(!targetName)return;
  const all=await dbAll('masters');const dst=all.find(x=>x.kind===src.kind&&x.active&&x.id!==src.id&&norm(x.canonical)===norm(targetName));
  if(!dst){toast('同じ種別の統合先が見つかりません');return;}
  if(!confirm(`${src.canonical}を${dst.canonical}へ統合しますか？`))return;
  dst.aliases=[...(dst.aliases||[]),src.canonical,...(src.aliases||[])].filter((x,i,a)=>a.findIndex(y=>norm(y)===norm(x))===i);
  src.active=false;src.redirectTo=dst.id;await dbPut('masters',dst);await dbPut('masters',src);
  const reports=await dbAll('reports');for(const r of reports){replaceIds(r,src.id,dst.id);if(r.subjectId===dst.id)r.subjectNameSnapshot=dst.canonical;await dbPut('reports',r);}
  await audit('master_merge',id,'名称を統合',{from:src.canonical,to:dst.canonical});await renderMasters();await renderHistory();
}
async function removeMaster(id){
  const m=await dbGet('masters',id);if(!m)return;const used=(await dbAll('reports')).some(r=>JSON.stringify(r).includes(id));
  if(used){m.active=false;await dbPut('masters',m);await audit('master_disable',id,'使用履歴があるため削除せず無効化');toast('使用履歴があるため無効化しました');}
  else if(confirm(`${m.canonical}を削除しますか？`)){await dbDelete('masters',id);await audit('master_delete',id,'未使用名称を削除',{canonical:m.canonical});}
  await renderMasters();
}
async function renderMasters(){
  if(!db)return;const all=(await dbAll('masters')).sort((a,b)=>a.kind.localeCompare(b.kind,'ja')||a.canonical.localeCompare(b.canonical,'ja'));
  const el=document.getElementById('nameMasterList');if(!el)return;const labels={store:'店舗',venue:'会場',staff:'スタッフ'};
  el.innerHTML=all.map(m=>`<div class="sgroup"><div class="sgh"><span class="tag">${labels[m.kind]}</span>${esc(m.canonical)} ${m.active?'':'<span class="pill bad">無効</span>'}</div><p class="note">別名：${esc((m.aliases||[]).join('、')||'なし')}<br>登録：${esc((m.createdAt||'').slice(0,10))}／最終使用：${esc((m.lastUsedAt||'未使用').slice(0,10))}</p><div class="copybar"><button class="btn sm sec" onclick="PACEV12.editMaster('${m.id}')">名称変更</button><button class="btn sm sec" onclick="PACEV12.addAliasToMaster('${m.id}')">別名追加</button><button class="btn sm sec" onclick="PACEV12.mergeMaster('${m.id}')">統合</button><button class="btn sm sec" onclick="PACEV12.toggleMaster('${m.id}')">${m.active?'無効化':'有効化'}</button><button class="btn sm sec" onclick="PACEV12.removeMaster('${m.id}')">削除</button></div></div>`).join('');
}

async function masterMap(){
  const all=await dbAll('masters');const map={};all.forEach(x=>map[x.id]=x);return map;
}
function canonicalVenueNames(master){
  return[master.canonical,...(master.aliases||[])].map(norm);
}
function venueMasterForName(name,masters){
  const key=norm(name);
  return Object.values(masters).find(x=>x.kind==='venue'&&x.active&&canonicalVenueNames(x).includes(key))||null;
}
function storeOrganicActual(e){
  return nval(e&&e.mnp&&e.mnp.channels&&e.mnp.channels.store)+nval(e&&e.new&&e.new.channels&&e.new.channels.store);
}
function hasRateBlockingIssue(report,codes){
  const wanted=new Set(codes);
  return (report&&report.issues||[]).some(x=>x.level==='error'&&wanted.has(x.code));
}
function scheduleContext(master,date){
  const names=canonicalVenueNames(master);
  const row=(D.schedule||[]).find(x=>x.date===date&&names.includes(norm(x.venue)));
  return{day:typeof dayType==='function'?dayType(date):(['0','6'].includes(String(localDate(date).getDay()))?'土日':'平日'),cond:row?(row.cond||''):''};
}
async function rateRows(){
  const reports=(await dbAll('reports')).filter(x=>x.active),masters=await masterMap();
  const zeroMeta=await dbGet('meta','confirmed_store_zeros');
  const excludedMeta=await dbGet('meta','store_rate_excluded');
  const excludedStores=new Set((excludedMeta&&Array.isArray(excludedMeta.value)?excludedMeta.value:[]).map(norm));
  const dates=reports.map(x=>x.reportDate).sort();if(!dates.length)return[];
  const lastIso=dates[dates.length-1],last=localDate(lastIso),cut=new Date(last.getTime()-59*DAY_MS),cutIso=isoDate(cut);
  const events=reports.filter(x=>x.type==='event'&&x.reportDate>=cutIso);
  const stores=reports.filter(x=>x.type==='store'&&x.reportDate>=cutIso);
  const groups={},scheduleIndex={};
  for(const row of D.schedule||[]){
    if(row.venue==='店舗'||row.date<cutIso||row.date>lastIso)continue;
    const m=venueMasterForName(row.venue,masters);if(!m)continue;
    const day=typeof dayType==='function'?dayType(row.date):(['0','6'].includes(String(localDate(row.date).getDay()))?'土日':'平日');
    const cond=row.cond||'',k=[m.id,day,cond].join('|');
    if(!groups[k])groups[k]={rowType:'venue',venueId:m.id,venue:m.canonical,day,cond,dates:new Set(),scheduleNames:new Set(),gross:0,eventDates:new Set(),confirmed:0,confirmedOnEventDates:0,unassigned:0};
    groups[k].dates.add(row.date);groups[k].scheduleNames.add(row.venue);
    const ik=[row.date,m.id].join('|');(scheduleIndex[ik]=scheduleIndex[ik]||[]).push(k);
  }
  for(const r of events){
    if(hasRateBlockingIssue(r,['event_total_missing','event_total_mismatch','event_products_missing']))continue;
    const e=r.parsed,m=masters[e.venue.id];if(!m)continue;const ctx=scheduleContext(m,r.reportDate),k=[m.id,ctx.day,ctx.cond].join('|');
    if(!groups[k])groups[k]={rowType:'venue',venueId:m.id,venue:m.canonical,day:ctx.day,cond:ctx.cond,dates:new Set([r.reportDate]),scheduleNames:new Set([m.canonical]),gross:0,eventDates:new Set(),confirmed:0,confirmedOnEventDates:0,unassigned:0};
    groups[k].gross+=e.eligibleGross;groups[k].eventDates.add(r.reportDate);
  }
  for(const r of stores){
    if(hasRateBlockingIssue(r,['category_sum','daily_sum','allocation_sum']))continue;
    const e=r.parsed;
    for(const cat of [e.mnp,e.new]){
      for(const typ of ['instant','later'])for(const a of(cat.allocations[typ]||[])){
        if(!a.venue.id)continue;
        const keys=scheduleIndex[[r.reportDate,a.venue.id].join('|')]||[];
        if(keys.length===1){
          const g=groups[keys[0]];g.confirmed+=a.count;
          if(g.eventDates.has(r.reportDate))g.confirmedOnEventDates+=a.count;
        }else{
          for(const g of Object.values(groups))if(g.venueId===a.venue.id)g.unassigned+=a.count;
        }
      }
    }
  }
  const venueRows=Object.values(groups).map(g=>{
    const days=g.dates.size,eventDays=g.eventDates.size,acqRate=eventDays?g.gross/eventDays:null;
    const rawOpen=g.gross?g.confirmedOnEventDates/g.gross:null;
    const suggested=Math.round((days?g.confirmed/days:0)*10)/10;
    let current=null,venueName=null;
    const m=masters[g.venueId];if(m){
      const scheduleNames=[...g.scheduleNames].map(norm);
      for(const r of D.regions||[])for(const v of(r.venues||[]))if(scheduleNames.includes(norm(v.name))){venueName=v.name;const sl=(v.slots||[]).find(x=>x.day===g.day&&(x.cond||'')===g.cond);if(sl)current=sl.rate;}
    }
    return{...g,days,eventDays,acqRate,openingRate:rawOpen,suggested,current,venueName,qualified:days>=3,anomaly:rawOpen!=null&&rawOpen>1};
  });
  const storeGroups={};
  for(const r of stores){
    const e=r.parsed,m=masters[e.store&&e.store.id];if(!m||excludedStores.has(norm(m.canonical)))continue;
    if(!storeGroups[m.id])storeGroups[m.id]={rowType:'store',storeId:m.id,store:m.canonical,dates:new Set(),gross:0,excluded:0};
    if(hasRateBlockingIssue(r,['missing_MNP','missing_新規','category_sum','daily_sum'])){storeGroups[m.id].excluded++;continue;}
    storeGroups[m.id].dates.add(r.reportDate);storeGroups[m.id].gross+=storeOrganicActual(e);
  }
  for(const z of zeroMeta&&Array.isArray(zeroMeta.value)?zeroMeta.value:[]){
    if(!z||z.date<cutIso)continue;
    const m=Object.values(masters).find(x=>x.kind==='store'&&x.active&&norm(x.canonical)===norm(z.store));
    if(!m||excludedStores.has(norm(m.canonical)))continue;
    if(!storeGroups[m.id])storeGroups[m.id]={rowType:'store',storeId:m.id,store:m.canonical,dates:new Set(),gross:0,excluded:0};
    storeGroups[m.id].dates.add(z.date);
  }
  const storeRegion=(D.regions||[]).find(x=>x.isStore),storeRates=storeRegion&&storeRegion.storeRates||{};
  const storeRows=Object.values(storeGroups).map(g=>{
    const days=g.dates.size,suggested=Math.round((days?g.gross/days:0)*10)/10;
    return{...g,days,acqRate:suggested,suggested,current:storeRates[g.store],qualified:days>=7,anomaly:false};
  });
  return[...venueRows,...storeRows].sort((a,b)=>{
    if(a.rowType!==b.rowType)return a.rowType==='store'?-1:1;
    const an=a.rowType==='store'?a.store:a.venue,bn=b.rowType==='store'?b.store:b.venue;
    return an.localeCompare(bn,'ja')||String(a.day||'').localeCompare(String(b.day||''),'ja');
  });
}
async function applySuggested(venueId,day,cond,rate){
  const masters=await masterMap(),m=masters[venueId];if(!m)return;const names=canonicalVenueNames(m);let slot=null;
  for(const r of D.regions||[])for(const v of(r.venues||[]))if(names.includes(norm(v.name))){slot=(v.slots||[]).find(x=>x.day===day&&(x.cond||'')===cond);if(slot)break;}
  if(!slot){toast('対応する既存レート行が見つかりません');return;}
  const before=slot.rate;slot.rate=Number(rate);renderAll();await audit('rate_approve',venueId,'推奨レートを承認',{venue:m.canonical,day,cond,before,after:slot.rate});await renderDataManager();toast('推奨レートを反映しました');
}
async function applyStoreSuggested(storeName,rate){
  const r=(D.regions||[]).find(x=>x.isStore);if(!r)return;
  r.storeRates=r.storeRates||{};r.storeRates[storeName]=Number(rate)||0;
  r.storeCount=Object.keys(r.storeRates).length;
  r.storeRate=Math.round(Object.values(r.storeRates).reduce((a,x)=>a+(Number(x)||0),0)*10)/10;
  if(typeof save==='function')save();renderAll();
  await audit('store_rate_approve',storeName,'店舗別推奨レートを承認',{store:storeName,rate:r.storeRates[storeName],aggregate:r.storeRate});
  await renderDataManager();toast('店舗別レートを反映しました');
}
async function logUnknownAdjustment(action,rec){
  if(!rec)return;
  const creating=action==='create';
  await audit(
    creating?'unknown_adjustment_create':'unknown_adjustment_remove',
    rec.id,
    creating?rec.reason:'拠点不明調整を取消',
    {date:rec.date,amount:rec.amount,originalReason:rec.reason,createdAt:rec.createdAt,rateImpact:false}
  );
  await renderAudit();
}
async function renderRateAnalysis(){
  const el=document.getElementById('rateAnalysis');if(!el)return;const rows=await rateRows();
  if(!rows.length){el.innerHTML='<p class="note">レート分析に使える報告がまだありません。</p>';return;}
  el.innerHTML='<table><thead><tr><th>種別・対象</th><th class="r">実績/日</th><th class="r">イベント補足</th><th class="r">推奨</th><th></th></tr></thead><tbody>'+rows.map(r=>{
    const note=!r.qualified?'参考値':r.anomaly?'要確認':'推奨';
    if(r.rowType==='store'){
      const excluded=r.excluded?`・不一致${r.excluded}日除外`:'';
      return`<tr><td><span class="tag">店舗</span> ${esc(r.store)}<br><span class="muted">${r.days}報告日・店舗内実績${r.gross}件${excluded}（会場換算店舗を除外）</span></td><td class="r">${r.acqRate.toFixed(1)}</td><td class="r">—</td><td class="r"><b>${r.suggested}</b><br><span class="muted">${note}</span></td><td>${r.qualified?`<button class="btn sm" onclick="PACEV12.applyStoreSuggested('${esc(r.store)}',${r.suggested})">反映</button>`:''}</td></tr>`;
    }
    const openPct=r.openingRate==null?null:Math.round(r.openingRate*1000)/10;
    const eventInfo=r.acqRate==null?'報告なし':`${r.acqRate.toFixed(1)}件/日・${openPct}%`;
    const unassigned=r.unassigned?`・日付未帰属${r.unassigned}件`:'';
    return`<tr><td><span class="tag">会場</span> ${esc(r.venue)}<br><span class="muted">${esc(r.day+(r.cond?'・'+r.cond:''))}／予定${r.days}日・帰属${r.confirmed}件${unassigned}</span></td><td class="r">${r.suggested.toFixed(1)}</td><td class="r">${eventInfo}</td><td class="r"><b>${r.suggested}</b><br><span class="muted">${note}</span></td><td>${r.qualified&&!r.anomaly&&r.current!=null?`<button class="btn sm" onclick="PACEV12.applySuggested('${r.venueId}','${esc(r.day)}','${esc(r.cond)}',${r.suggested})">反映</button>`:''}</td></tr>`;
  }).join('')+'</tbody></table>';
}

async function counts(){
  const o={};for(const s of STORE_NAMES)o[s]=(await dbAll(s)).length;return o;
}
async function renderDataManager(){
  if(!db)return;const c=await counts(),el=document.getElementById('dbStatus');
  if(el)el.innerHTML='<div class="stats">'+
    `<div class="stat"><div class="k">保存方式</div><div class="v" style="font-size:16px">端末内DB</div></div>`+
    `<div class="stat"><div class="k">外部送信</div><div class="v" style="font-size:16px">なし</div></div>`+
    `<div class="stat"><div class="k">報告履歴</div><div class="v num">${c.reports}<small>件</small></div></div>`+
    `<div class="stat"><div class="k">名称マスタ</div><div class="v num">${c.masters}<small>件</small></div></div></div>`;
  await renderRateAnalysis();await renderAudit();
}
async function renderAudit(){
  const el=document.getElementById('auditList');if(!el)return;const all=(await dbAll('audit')).sort((a,b)=>b.timestamp.localeCompare(a.timestamp)).slice(0,50);
  if(!all.length){el.innerHTML='<p class="note">監査ログはまだありません。</p>';return;}
  el.innerHTML=all.map(x=>`<details class="sgroup"><summary>${esc(x.timestamp.replace('T',' ').slice(0,16))}｜${esc(x.action)}｜${esc(x.reason||'理由なし')}</summary><pre class="out" style="margin-top:8px;font-size:11px">${esc(JSON.stringify(x.details,null,2))}</pre></details>`).join('');
}

function bytesToB64(bytes){
  let s='';const a=new Uint8Array(bytes);for(let i=0;i<a.length;i+=32768)s+=String.fromCharCode(...a.subarray(i,i+32768));return btoa(s);
}
function b64ToBytes(s){
  const x=atob(s),a=new Uint8Array(x.length);for(let i=0;i<x.length;i++)a[i]=x.charCodeAt(i);return a;
}
async function deriveKey(password,salt,usage){
  const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:250000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,[usage]);
}
async function collectBackupData(){
  await dbPut('core',{key:'state',value:denormalize(D),updatedAt:now(),schemaVersion:SCHEMA_VERSION});
  const data={};for(const s of STORE_NAMES)data[s]=await dbAll(s);
  return{format:'PACE_BACKUP_DATA',schemaVersion:SCHEMA_VERSION,exportedAt:now(),data};
}
async function encryptBackup(payload,password){
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),key=await deriveKey(password,salt,'encrypt');
  const plain=new TextEncoder().encode(JSON.stringify(payload)),cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,plain);
  return{format:'PACE_ENCRYPTED_BACKUP',version:1,kdf:'PBKDF2-SHA256',iterations:250000,salt:bytesToB64(salt),iv:bytesToB64(iv),ciphertext:bytesToB64(cipher)};
}
async function decryptBackup(container,password){
  if(!container||container.format!=='PACE_ENCRYPTED_BACKUP')throw new Error('PACEの暗号化バックアップではありません');
  const salt=b64ToBytes(container.salt),iv=b64ToBytes(container.iv),key=await deriveKey(password,salt,'decrypt');
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,b64ToBytes(container.ciphertext));
  const payload=JSON.parse(new TextDecoder().decode(plain));
  if(payload.format!=='PACE_BACKUP_DATA'||!payload.data||!payload.data.core)throw new Error('バックアップ内容が不正です');
  return payload;
}
function downloadObject(obj,filename){
  const blob=new Blob([JSON.stringify(obj)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function createBackupFile(password,filename){
  const payload=await collectBackupData(),encrypted=await encryptBackup(payload,password);downloadObject(encrypted,filename);return payload;
}
async function downloadBackup(){
  const p=document.getElementById('backupPassword').value,p2=document.getElementById('backupPassword2').value;
  if(p.length<8){toast('パスワードは8文字以上にしてください');return;}
  if(p!==p2){toast('確認用パスワードが一致しません');return;}
  const stamp=now().replace(/[-:T]/g,'').slice(0,12);await createBackupFile(p,`PACE_backup_${stamp}.pacebackup`);
  await audit('backup_export','database','暗号化バックアップを作成');await renderAudit();toast('暗号化バックアップを作成しました');
}
async function previewRestore(){
  const file=document.getElementById('restoreFile').files[0],password=document.getElementById('restorePassword').value,el=document.getElementById('restorePreview');
  if(!file){toast('バックアップファイルを選択してください');return;}
  if(!password){toast('復元用パスワードを入力してください');return;}
  try{
    const payload=await decryptBackup(JSON.parse(await file.text()),password);pendingRestore={payload,password,fileName:file.name};
    const d=payload.data;el.innerHTML=`<p class="note ok">復元可能です。作成日時：${esc(payload.exportedAt)}／報告${(d.reports||[]).length}件／名称${(d.masters||[]).length}件／監査ログ${(d.audit||[]).length}件</p>`;
    document.getElementById('restoreExecute').classList.remove('hidden');
  }catch(e){pendingRestore=null;el.innerHTML=`<p class="note bad">復元できません：${esc(e.message||'パスワードまたはファイルを確認してください')}</p>`;document.getElementById('restoreExecute').classList.add('hidden');}
}
async function replaceDatabase(data){
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE_NAMES,'readwrite');
    for(const s of STORE_NAMES){const os=tx.objectStore(s);os.clear();for(const x of(data[s]||[]))os.put(x);}
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
  });
}
async function executeRestore(){
  if(!pendingRestore)return;if(!confirm('現在のデータを自動退避して、バックアップ内容へ置き換えます。実行しますか？'))return;
  try{
    const stamp=now().replace(/[-:T]/g,'').slice(0,12);
    await createBackupFile(pendingRestore.password,`PACE_pre_restore_${stamp}.pacebackup`);
    await replaceDatabase(pendingRestore.payload.data);
    const core=await dbGet('core','state');if(!core||!core.value)throw new Error('復元データにPACE本体設定がありません');
    D=normalize(core.value);fillSettings();renderAll();await audit('backup_restore','database','暗号化バックアップから復元',{fileName:pendingRestore.fileName,backupDate:pendingRestore.payload.exportedAt});
    pendingRestore=null;document.getElementById('restoreExecute').classList.add('hidden');document.getElementById('restorePreview').innerHTML='<p class="note ok">復元が完了しました。</p>';
    await renderHistory();await renderMasters();await renderDataManager();toast('バックアップから復元しました');
  }catch(e){toast('復元に失敗しました：'+e.message);}
}

async function boot(){
  try{
    db=await openDb();
    const stored=await dbGet('core','state');
    if(stored&&stored.value)D=normalize(stored.value);
    else await dbPut('core',{key:'state',value:denormalize(D),updatedAt:now(),schemaVersion:SCHEMA_VERSION,migratedFrom:'pace_state_v2'});
    const oldSave=save;
    save=function(){
      if(db)dbPut('core',{key:'state',value:denormalize(D),updatedAt:now(),schemaVersion:SCHEMA_VERSION}).catch(()=>{});
      else try{localStorage.setItem('pace_state_v2',JSON.stringify(denormalize(D)));}catch(_){}
    };
    try{localStorage.removeItem('pace_state_v2');}catch(_){}
    await seedMasters();
    fillSettings();renderAll();await renderHistory();
  }catch(e){
    console.error('PACE Ver1.2 data layer failed',e);
    const el=document.getElementById('dbStatus');if(el)el.innerHTML='<p class="note bad">端末内DBを開けませんでした。ブラウザのプライベートモードや保存設定を確認してください。</p>';
  }
}

const api={
  parseReport,savePreview,chooseResolution,renderHistory,
  addMasterFromForm,editMaster,addAliasToMaster,toggleMaster,mergeMaster,removeMaster,renderMasters,
  renderDataManager,applySuggested,applyStoreSuggested,logUnknownAdjustment,downloadBackup,previewRestore,executeRestore,
  _test:{
    parseStoreRaw,parseEventRaw,parseCumulativeRaw,parseAllocationText,classifyProduct,storeOrganicActual,hasRateBlockingIssue,stable,
    collectBackupData,encryptBackup,decryptBackup,replaceDatabase,counts,rateRows
  }
};
root.PACEV12=api;
if(typeof document!=='undefined'&&typeof indexedDB!=='undefined')boot();

})(typeof window!=='undefined'?window:globalThis);
