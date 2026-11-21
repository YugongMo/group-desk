import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,chmod,realpath,readFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {business,directories,managed,years,sourceTable,buildPlan,computed,equal,auditCols} from './plan.mjs';
import {verify} from './verify.mjs';

const argv=process.argv.slice(2);
const env=process.env;
const modes=['--check-target','--dry-run','--run'];
const mode=(modes.find(flag=>argv.includes(flag))||'--dry-run').slice(2);
const validArgs=new Set([...modes,'--target','--report-dir',...years.map(y=>'--source-'+y)]);
function arg(k){const i=argv.indexOf(k);if(i===-1)return null; if(!argv[i+1]||argv[i+1].startsWith('--'))throw Error('Missing value for '+k);return argv[i+1];}
const runId=randomUUID(), entries=[], failures=[];
const log=(kind,detail)=>entries.push({kind,detail});
const err=(kind,detail)=>failures.push({kind,detail});
const writable=new Set([...managed,'Staff','MG_NameMap','MG_Report']);
const origin='https://exclusive.getgrist.com';
const api=origin+'/api/docs/';
let targetId, key, targetName,sourceIds,outDir,backup,lock=false,apiWrites=0,plan;
const fileDir=path.dirname(fileURLToPath(import.meta.url));
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function privateJSON(filename,data){return writeFile(path.join(outDir,filename),JSON.stringify(data,null,2),{mode:0o600});}
function safeId(value){if(typeof value!=='string'|| !/^[a-zA-Z0-9_-]+$/.test(value)) throw Error('Missing or invalid source/target document ID');return value;}
async function request(id,route,{post,bytes=false}={}){
  if(post!==undefined && (id!==targetId || route!=='/apply?noparse=true' || !targetName?.includes('合并')))throw Error('Write guard refused request');
  const url=api+encodeURIComponent(id)+route;
  const opts={method:post===undefined?'GET':'POST',redirect:'error',headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(120000)};
  if(post!==undefined){opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(post);}
  for(let attempt=0;;attempt++){
    let res;
    try{res=await fetch(url,opts);}catch{throw Error('REST transport failed ('+opts.method+' '+route+'). Writes with an unknown result are never retried.');}
    if(post===undefined && [429,502,503,504].includes(res.status) && attempt<3){await res.arrayBuffer();await new Promise(s=>setTimeout(s,Math.min(10000,1000*2**attempt)));continue;}
    if(!res.ok) throw Error('REST '+opts.method+' '+route+' returned '+res.status);
    return bytes?Buffer.from(await res.arrayBuffer()):res.json();
  }
}
async function records(doc,t){
  const data=await request(doc,'/tables/'+encodeURIComponent(t)+'/records');
  if(!Array.isArray(data.records))throw Error('Missing records array '+t);
  return data.records.map(r=>{
    const fields={...r.fields};
    for(const [k,v] of Object.entries(r.errors||{}))fields[k]=['E',v];
    return {id:r.id,...fields};
  }).sort((a,b)=>a.id-b.id);
}
async function readDoc(id,y,full=false){
  const tables=await records(id,'_grist_Tables'), cols=await records(id,'_grist_Tables_column');
  const tableById=new Map(tables.map(t=>[t.id,t.tableId]));
  const schema=Object.fromEntries(tables.map(t=>[t.tableId,{}]));
  for(const c of cols){
    if(c.colId.startsWith('gristHelper_') || c.colId==='manualSort')continue;
    const t=tableById.get(c.parentId);if(t)schema[t][c.colId]=c;
  }
  const wanted=new Set([...managed.map(t=>sourceTable(y,t)),'Allotment',...(full?['MG_NameMap','MG_Report','Staff']:[])]);
  if(full)for(const [t,cs] of Object.entries(schema))for(const c of Object.values(cs)) if(/^Ref(List)?:/.test(c.type)){wanted.add(t);wanted.add(c.type.split(':')[1]);}
  const rows={};
  for(const t of wanted) if(schema[t])rows[t]=await records(id,t);
  return {schema,rows};
}
function checkAction(action){
  const [kind,t,x,p]=action;
  if(!writable.has(t))throw Error('Table write guard refused '+t);
  if(kind==='BulkRemoveRecord' && !business.includes(t))throw Error('Refused clearing '+t);
  if(['BulkRemoveRecord','BulkAddRecord','BulkUpdateRecord'].includes(kind)) {
    if(!Array.isArray(x)||x.length>500||!x.every(i=>Number.isSafeInteger(i)&&i>0))throw Error('Invalid bulk IDs');
    if(p && Object.values(p).some(v=>v.length!==x.length))throw Error('Array lengths differ');
    return x.length;
  }
  if(kind==='RemoveRecord' && !business.includes(t) && t!=='MG_Report')throw Error('Refused removal from '+t);
  if(!['AddTable','AddColumn','ModifyColumn','AddRecord','RemoveRecord','UpdateRecord'].includes(kind))throw Error('Unexpected action '+kind);
  return ['AddRecord','UpdateRecord','RemoveRecord'].includes(kind)?1:0;
}
async function apply(actions){
  if(mode!=='run')throw Error('Read-only mode');
  if(actions.reduce((n,a)=>n+checkAction(a),0)>500)throw Error('Batch exceeds 500 rows');
  if(actions.length){const result=await request(targetId,'/apply?noparse=true',{post:actions});apiWrites++;return result;}
}
function chunks(rows,size=500){const a=[];for(let i=0;i<rows.length;i+=size)a.push(rows.slice(i,i+size));return a;}
function bulk(kind,t,rows){
  const columns=Object.keys(rows[0]).filter(k=>k!=='id');
  return [kind,t,rows.map(r=>r.id),Object.fromEntries(columns.map(k=>[k,rows.map(r=>r[k])]))];
}
async function writeRows(kind,t,rows,wrap=async a=>apply([a])){
  const groups=new Map();
  for(const r of rows){const key=JSON.stringify(Object.keys(r).sort());const a=groups.get(key)||[];a.push(r);groups.set(key,a);}
  for(const group of groups.values())for(const rs of chunks(group))await wrap(bulk(kind,t,rs));
}
async function sync(t,desired,existing){
  const byId=new Map(existing.map(r=>[r.id,r]));
  const add=[],upd=[];
  for(const r of desired){const old=byId.get(r.id);if(!old)add.push(r);else if(Object.keys(r).some(k=>!equal(r[k],old[k])))upd.push(r);}
  await writeRows('BulkAddRecord',t,add);await writeRows('BulkUpdateRecord',t,upd);
}
function triggers(t){return Object.entries(plan.schema[t]).filter(([,c])=>!computed(c)&&Boolean(c.formula));}
function guardedInsert(t,action,disable){
  if(!disable)return apply([action]);
  const specs=triggers(t);
  return apply([...specs.map(([k])=>['ModifyColumn',t,k,{formula:'',isFormula:false}]),action,
    ...specs.map(([k,c])=>['ModifyColumn',t,k,{formula:c.formula,isFormula:false}])]);
}
async function probe(t,existing){
  const columns=triggers(t);if(!columns.length || !plan.output[t].length)return false;
  const prototype=plan.output[t][0];
  const fields=Object.fromEntries(columns.map(([k,c])=>[k,prototype[k]??(c.type.startsWith('Date')?946684800:c.type==='Text'?'migration probe':null)]));
  for(const [k,c] of columns)if(auditCols.includes(k))fields[k]=c.type.startsWith('Date')?946684800:'migration probe';
  const id=Math.max(0,...existing.map(r=>r.id),...plan.output[t].map(r=>r.id))+1;
  for(const disable of [false,true]){
    await guardedInsert(t,['AddRecord',t,id,fields],disable);
    let ok;
    try{
      const result=await request(targetId,'/tables/'+t+'/records?filter='+encodeURIComponent(JSON.stringify({id:[id]})));
      const row=result.records.find(r=>r.id===id);
      if(!row)throw Error('Probe not readable: '+t);
      ok=Object.entries(fields).every(([k,v])=>equal(row.fields[k],v));
    }finally{await apply([['RemoveRecord',t,id]]);}
    if(ok){log('trigger_probe',{table:t,mode:disable?'suspend and restore trigger formulas in each atomic insertion batch':'explicit values retained',fields:Object.keys(fields)});return disable;}
  }
  throw Error('Cannot preserve trigger data in '+t);
}
async function reportRows(){
  const data=[...entries,...failures.map(e=>({kind:'blocker',detail:e}))];
  const rs=await records(targetId,'MG_Report');
  let next=Math.max(1,...rs.map(r=>r.id))+1;
  await writeRows('BulkAddRecord','MG_Report',data.map(({kind,detail})=>({id:next++,Run_Id:runId,Section:kind,Detail:JSON.stringify(detail)})));
}
async function main(){
  if(!outDir)throw Error('Report directory unavailable');
  for(let i=0;i<argv.length;i++){const k=argv[i];if(!validArgs.has(k))throw Error('Unknown argument');if(!modes.includes(k))i++;}
  if(modes.filter(flag=>argv.includes(flag)).length!==1)throw Error('Specify exactly one of --check-target, --dry-run or --run');
  key=env.GRIST_API_KEY?.trim();
  for(const location of ['grist_key.txt','Documents/grist_key.txt']){
    if(key)break;
    try{key=(await readFile(path.join(homedir(),location),'utf8')).trim();}
    catch(error){if(error.code!=='ENOENT')throw Error('Cannot read ~/'+location);}
  }
  if(!key || /[\r\n]/.test(key))throw Error('Expected a non-empty single-line Grist credential');
  const targetArg=safeId(arg('--target')||env.GRIST_TARGET);
  const targetInfo=await request(targetArg,'');
  if(typeof targetInfo.name!=='string' || !targetInfo.name.includes('合并'))throw Error('Target document name does not contain 合并');
  if(mode==='check-target'){console.log('Target:',targetInfo.name);return;}
  sourceIds=Object.fromEntries(years.map(y=>[y,safeId(arg('--source-'+y)||env['GRIST_SOURCE_'+y])]));
  const infos={};
  for(const y of years)infos[y]=await request(sourceIds[y],'');
  const canonical=info=>safeId(info.id);
  if(new Set([...Object.values(infos).map(canonical),canonical(targetInfo)]).size!==5)throw Error('Document identity collision');
  targetId=canonical(targetInfo);targetName=targetInfo.name;
  const sources={};
  for(const y of years)sources[y]=await readDoc(canonical(infos[y]),y);
  const target=await readDoc(targetId,2026,true);
  plan=buildPlan(sources,target);
  entries.push(...plan.report);for(const a of plan.actions)log('schema_change',a);
  failures.push(...plan.errors);
  console.log('Preflight:',failures.length,'blocker entries.');
  if(failures.length || mode==='dry-run')return;
  // Back up the exact target outside the repository before the first mutation.
  backup=path.join(outDir,'before.grist');
  const blob=await request(targetId,'/download?nohistory=true',{bytes:true});
  if(blob.subarray(0,16).toString()!=='SQLite format 3\u0000')throw Error('Invalid backup');
  await writeFile(backup,blob,{mode:0o600});
  for(const y of years)if(digest(await readDoc(canonical(infos[y]),y))!==digest(sources[y]))throw Error('Source changed during preflight: '+y);
  if(digest(await readDoc(targetId,2026,true))!==digest(target))throw Error('Target changed during preflight');
  const reportSchema=plan.actions.filter(a=>a[1]==='MG_Report');
  if(reportSchema.length)await apply(reportSchema);
  // Grist rejects a duplicate explicit row ID. Concurrent migrators cannot both hold row 1.
  await apply([['AddRecord','MG_Report',1,{Run_Id:runId,Section:'lock',Detail:'migration in progress'}]]);lock=true;
  try{
    const guard=await request(targetId,'');if(guard.id!==targetId || !guard.name.includes('合并'))throw Error('Target identity changed');
    await apply(plan.actions.filter(a=>a[1]!=='MG_Report'));
    const wrap={};for(const t of business)wrap[t]=await probe(t,target.rows[t]);
    // Only transaction tables are cleared. Master records are upserted at stable IDs.
    for(const t of [...business].reverse())for(const ids of chunks(target.rows[t].map(r=>r.id)))await apply([['BulkRemoveRecord',t,ids]]);
    // Reserve the allocated directory IDs before inserting. A rerun after an
    // interrupted directory batch must reuse those IDs, not create duplicates.
    await writeRows('BulkUpdateRecord','MG_NameMap',plan.mapUpdates);
    for(const t of directories)await sync(t,plan.dirs[t],target.rows[t]);
    await sync('Staff',plan.staff,target.rows.Staff||[]);
    for(const t of business)await writeRows('BulkAddRecord',t,plan.output[t],a=>guardedInsert(t,a,wrap[t]));
    const checked=verify(plan,await readDoc(targetId,2026,true));
    entries.push(...checked.report);failures.push(...checked.errors);
    log('run_status',{status:failures.length?'verification_failed':'verified',writes:apiWrites});
    await reportRows();
  }finally{
    if(lock){await apply([['RemoveRecord','MG_Report',1]]);lock=false;}
  }
}
try{
  const requested=arg('--report-dir')||tmpdir();
  await mkdir(requested,{recursive:true,mode:0o700});
  const parent=await realpath(requested), repo=await realpath(path.dirname(fileDir));
  if(parent===repo || parent.startsWith(repo+path.sep))throw Error('Use a private report directory outside the repository');
  outDir=await mkdtemp(path.join(parent,'grist-merge-'));await chmod(outDir,0o700);
  await main();
}catch(e){err('execution_error',e.message);}
finally{
  if(outDir)await privateJSON('report.json',{runId,mode,apiWrites,backup,entries,failures});
  console.log(JSON.stringify({runId,mode,apiWrites,failures:failures.length,firstError:failures[0]?.kind==='execution_error'?failures[0].detail:undefined,report:outDir&&path.join(outDir,'report.json')}));
  if(failures.length)process.exitCode=2;
}
