export const years = [2024, 2025, 2026, 2027];
export const business = ['Group_List','Schedule','Hotel_Demand','Hotel_Offers','Meal','Entrances','Transport_Ticket','Others'];
export const directories = ['Client','Guide','Driver_Bus_Company','Restaurant','Attraction','Hotel_Directory'];
export const managed = [...directories,...business];
export const sourceTable = (year,table) => year <= 2025 && table === 'Entrances' ? 'Entrance' : table;
export const computed = c => Boolean(c?.isFormula && c.formula);
export const equal = (a,b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export const auditCols = ['Created_at','Created_by','Last_updated_at','Last_updated_by'];
const yearFormula = '$Arrival_Date.year if $Arrival_Date else $Base_Year';
const group = 'Group_List';
const makeCol = (type,formula='') => ({type,isFormula:Boolean(formula),formula});
const opts = c => JSON.parse(c.widgetOptions || '{}');
const list = x => x == null || x === '' ? [] : Array.isArray(x) && x[0]==='L' ? x.slice(1) : [x];
const yearTable = (scope,y,t) => scope[y][sourceTable(y,t)];
const digits = n => typeof n === 'number' && Number.isSafeInteger(n) && n>0;
const emptyRef = v => v == null || v===0 || v==='';
const fieldName = (y,t,k) => y===2024 ? ({'Schedule.Driver_Cost':'Trsf_Cost','Meal.Pax':'Net_Pax','Meal.Rate':'Net_Rate'}[t+'.'+k] || k) : k;
const canonical = (t,k,v) => {
  const dict = {'Meal.Meal':{BKF:'BF'},'Meal.Region':{CHA:'CHQ'},'Hotel_Directory.Category':{'MILOS 3*':'MILO 3*'}};
  const map=dict[t+'.'+k];
  if (!map) return v;
  const one=x=>typeof x==='string' && Object.hasOwn(map,x) ? map[x] : x;
  return Array.isArray(v) && v[0]==='L' ? ['L',...new Set(v.slice(1).map(one))] : one(v);
};
// Include rates, amounts and the operands used directly by money().
const amountFields={
  Schedule:['Guide_Cost','Driver_Cost','Trsf_Cost'],
  Hotel_Offers:['Total_Cost','SGL','TWN','DBL','TRP','SGL_RATE','TWN_DBL_RATE','TRP_RATE','Selling_SGL_RATE','Selling_TWN_DBL_Rate','Selling_TRP_RATE','SUP_','Deposit_Paid','Balance','Next_Deposit'],
  Meal:['Rate','Net_Rate','Sell_Rate','Net_Total','Total_Cost','Total_Cost2','Balance','Deposit'],
  Entrances:['Rate','Sell','Total_Cost','Grand_Total'],
  Transport_Ticket:['Rate','Total_Cost'],
  Others:['Qty','Net_Rate','Selling_Price','Total_Cost','Total_Sold']
};
export function badAmountFields(t,r){
  return amountFields[t].filter(k=>{
    const v=r[k];
    return v!=null && v!=='' && (typeof v!=='number'||!Number.isFinite(v));
  });
}
export function money(t,y,r) {
  // Totals use the workbook's own formula cells where available. No invented sell prices.
  const n=k=>{const x=r[k]; if(x==null || x==='') return 0; if(typeof x!=='number' || !Number.isFinite(x)) throw Error('non-numeric '+k); return x;};
  switch(t) {
    case 'Schedule':return [n('Guide_Cost')+n(y===2024?'Driver_Cost':'Trsf_Cost'),null];
    case 'Hotel_Offers':return [n('Total_Cost'),n('SGL')*n('Selling_SGL_RATE')+(n('TWN')+n('DBL'))*n('Selling_TWN_DBL_Rate')+n('TRP')*n('Selling_TRP_RATE')];
    case 'Meal':return [n(y===2024?'Total_Cost':'Net_Total'),y===2024?null:n('Total_Cost2')];
    case 'Entrances':return [n('Total_Cost'),y===2024?null:n('Grand_Total')];
    case 'Others':return [n('Total_Cost'),y===2024?n('Qty')*n('Selling_Price'):n('Total_Sold')];
    case 'Transport_Ticket':return [n('Total_Cost'),null];
    default:return null;
  }
}
// The REST entry point supplies snapshots. Plans and reports never need credentials.
export function buildPlan(sources,target) {
  const errors=[], report=[], actions=[], issues=(kind,detail)=>errors.push({kind,detail});
  const note=(kind,detail)=>report.push({kind,detail});
  const schema=structuredClone(target.schema);
  function table(t,cols) {
    if(!schema[t]) { schema[t]=Object.fromEntries(Object.entries(cols).map(([k,typ])=>[k,makeCol(typ)]));
      actions.push(['AddTable',t,Object.entries(schema[t]).map(([id,c])=>({id,...c}))]); }
    else for(const [k,typ] of Object.entries(cols)) column(t,k,makeCol(typ));
  }
  function column(t,k,c) {
    const old=schema[t]?.[k];
    if(!schema[t]) {issues('missing_target_table',t);return;}
    if(!old) {schema[t][k]=c;actions.push(['AddColumn',t,k,c]);}
    else if(old.type!==c.type || computed(old)!==computed(c) || (c.formula && old.formula!==c.formula)) issues('incompatible_schema',{t,k,expected:c,actual:old.type,formula:old.formula});
  }
  for(const t of managed) if(!schema[t]) throw Error('Missing target table '+t);
  if(!schema.MG_NameMap) throw Error('Missing MG_NameMap');
  for(const k of ['Dir_Table','Year','Old_Id','Old_Name','Decision','Target_2026_Id']) if(!schema.MG_NameMap[k]) throw Error('Missing MG_NameMap.'+k);
  for(const t of business) for(const k of ['Source_Year','Legacy_Id']) column(t,k,makeCol('Int'));
  for(const t of business) column(t,'Legacy_Note',makeCol('Text'));
  const clientFormula=schema.Transport_Ticket.Client;
  if(!computed(clientFormula)) issues('expected_ticket_client_formula','Transport_Ticket.Client');
  else if(clientFormula.type!=='Text'){
    clientFormula.type='Text';
    actions.push(['ModifyColumn','Transport_Ticket','Client',{type:'Text'}]);
  }
  for(const [k,c] of Object.entries({Base_Year:makeCol('Int'),Year:makeCol('Int',yearFormula),Legacy_GroupID:makeCol('Text')})) column(group,k,c);
  for(const k of ['Start_Time','End_Time']) {
    const a=sources[2024].schema.Schedule[k], b=sources[2025].schema.Schedule[k];
    if(!a || a.type!==b?.type || computed(a) || computed(b)) issues('schedule_time_schema',k);
    else column('Schedule',k,makeCol(a.type));
  }
  for(const t of directories) column(t,'Active',makeCol('Bool'));
  table('Staff',{Name:'Text',Active:'Bool'});
  column('MG_NameMap','New_Id',makeCol('Int'));
  table('MG_Report',{Run_Id:'Text',Section:'Text',Detail:'Text'});
  const sourceRows=Object.fromEntries(years.map(y=>[y,sources[y].rows]));
  const colMaps={};
  for(const t of managed) {
    const choices={};
    for(const [k,c] of Object.entries(schema[t])) if(['Choice','ChoiceList'].includes(c.type)) choices[k]=new Set(opts(c).choices || []);
    for(const y of years) {
      const st=sourceTable(y,t), src=sources[y].schema[st];
      if(!src) throw Error('Missing source table '+y+' '+st);
      const map=colMaps[y+'/'+t]={};
      for(const [k,c] of Object.entries(src)) {
        const dest=fieldName(y,t,k), d=schema[t][dest];
        if(!d) {if(!computed(c)) note('source_only_data_column',{year:y,table:t,column:k});continue;}
        if(computed(c)!==computed(d)) note('formula_data_difference',{year:y,table:t,column:k,sourceFormula:computed(c),targetFormula:computed(d)});
        if(choices[dest] && ['Choice','ChoiceList'].includes(c.type)) {
          const set=choices[dest];
          for(const v of opts(c).choices || []) set.add(canonical(t,dest,v));
          for(const r of sourceRows[y][st]) for(const v of list(r[k])) if(typeof v==='string' && v) set.add(canonical(t,dest,v));
        }
        if(!computed(c) && !computed(d)) map[k]=dest;
      }
    }
    for(const [k,set] of Object.entries(choices)) {
      const c=schema[t][k],w=opts(c),values=[...set];
      if(!equal(values,w.choices||[])) {c.widgetOptions=JSON.stringify({...w,choices:values});actions.push(['ModifyColumn',t,k,{widgetOptions:c.widgetOptions}]);}
    }
  }
  function copy(y,t,r) {
    const out={};
    for(const [k,d] of Object.entries(colMaps[y+'/'+t])) if(Object.hasOwn(r,k)){
      let v=canonical(t,d,r[k]);
      if(t==='Schedule' && d==='PAX' && typeof v==='number') v=String(v);
      out[d]=v;
    }
    return out;
  }
  const dirs={}, directoryIds={}, mapUpdates=[],staff=[], output={}, idMap={}, trace={};
  const maps=new Map();
  for(const r of target.rows.MG_NameMap) {
    const key=[r.Year,r.Dir_Table,r.Old_Id].join('/');
    if(maps.has(key)) issues('duplicate_mapping_key',key); else maps.set(key,r);
  }
  for(const t of directories) {
    const base=sourceRows[2026][t], old=target.rows[t], baseline=new Set(base.map(r=>r.id));
    const planned=new Map(old.map(r=>[r.id,{id:r.id,Active:true}]));
    const reserved=new Map();
    for(const r of maps.values()) if(r.Dir_Table===t && digits(r.New_Id)){
      if(reserved.has(r.New_Id) || baseline.has(r.New_Id)) issues('new_id_collision',{t,id:r.New_Id});
      reserved.set(r.New_Id,r.id);
    }
    let next=Math.max(0,...baseline,...old.map(r=>r.id),...reserved.keys())+1;
    for(const r of base) planned.set(r.id,{...copy(2026,t,r),id:r.id,Active:true,...(t==='Client' && r.id===6 ? {Name:'Leo'} : {})});
    if(t==='Client' && !baseline.has(6)) issues('missing_baseline_client',6);
    for(const y of years) {
      const key=y+'/'+t, ids=directoryIds[key]=new Map();
      if(y===2026) {for(const id of baseline) ids.set(id,id);continue;}
      const used=new Set();
      for(const b of business) {
        const st=sourceTable(y,b);
        for(const [col,c] of Object.entries(sources[y].schema[st])) {
          if(!['Ref:'+t,'RefList:'+t].includes(c.type)) continue;
          for(const row of sourceRows[y][st]) for(const id of list(row[col])) if(!emptyRef(id)){
            if(digits(id)) used.add(id);
          }
        }
      }
      const lookup=new Map(sourceRows[y][t].map(r=>[r.id,r]));
      for(const id of [...used].sort((a,b)=>a-b)){
        const r=lookup.get(id), m=maps.get([y,t,id].join('/'));
        if(!r) continue;
        if(!m) {issues('missing_directory_or_mapping',{y,t,id});continue;}
        if(r.Name!==m.Old_Name) {issues('mapping_source_name_changed',{y,t,id,old:m.Old_Name,current:r.Name});continue;}
        if(['采用','改选'].includes(m.Decision)){
          if(!baseline.has(m.Target_2026_Id)) issues('invalid_mapping_target',{y,t,id,target:m.Target_2026_Id});
          else ids.set(id,m.Target_2026_Id);
        }else if(m.Decision==='新增'){
          const dest=digits(m.New_Id)?m.New_Id:next++;
          planned.set(dest,{...copy(y,t,r),id:dest,Name:r.Name,Active:true});
          ids.set(id,dest);if(m.New_Id!==dest) mapUpdates.push({id:m.id,New_Id:dest});
        }else issues('undecided_mapping',{y,t,id,name:r.Name,decision:m.Decision||''});
      }
    }
    dirs[t]=[...planned.values()];
  }
  const existingStaff=target.rows.Staff||[], staffNames=new Map();
  let newStaff=Math.max(0,...existingStaff.map(s=>s.id))+1;
  for(const s of existingStaff){if(staffNames.has(s.Name)) issues('duplicate_staff',s.Name); staffNames.set(s.Name,s.id);}
  const ops=new Set(years.flatMap(y=>sourceRows[y][group].map(r=>r.OP)).filter(v=>typeof v==='string' && v.trim()));
  for(const name of [...ops].sort()) staff.push({id:staffNames.get(name)??newStaff++,Name:name,Active:true});
  const byRef=new Map(), lost=new Set(), duplicates=[];
  for(const y of years) for(const r of sourceRows[y][group]) if(typeof r.Reference==='string' && r.Reference.trim()){
    const matches=byRef.get(r.Reference)||[];matches.push({y,r});byRef.set(r.Reference,matches);
  }
  function stamp(v){if(typeof v==='number' && Number.isFinite(v)) return v; if(v==null||v==='') return -Infinity; const d=Date.parse(v);return Number.isFinite(d)?d/1000:NaN;}
  for(const [reference,arr] of byRef) if(arr.length>1){
    const ordered=arr.slice().sort((a,b)=>stamp(b.r.Last_updated_at)-stamp(a.r.Last_updated_at) || a.y-b.y);
    if(arr.some(x=>Number.isNaN(stamp(x.r.Last_updated_at))) || (ordered[0].y===ordered[1].y && stamp(ordered[0].r.Last_updated_at)===stamp(ordered[1].r.Last_updated_at))){
      issues('duplicate_timestamp_tie',{reference,versions:arr.map(x=>[x.y,x.r.id,x.r.Last_updated_at])});continue;
    }
    const winner=ordered[0];
    for(const {y,r} of ordered.slice(1)){const key=y+'/'+r.id;lost.add(key);duplicates.push({reference,winner:[winner.y,winner.r.id,winner.r.Last_updated_at],discard:[y,r.id,r.Last_updated_at],children:{}});}
  }
  const discarded=new Map(duplicates.map(d=>[d.discard.slice(0,2).join('/'),d]));
  const demands=Object.fromEntries(years.map(y=>[y,new Map(sourceRows[y].Hotel_Demand.map(r=>[r.id,r]))]));
  const parent=(y,t,r)=>t===group?r.id:t==='Hotel_Offers'?demands[y].get(r.DemandID)?.Ref:r.Ref;
  for(const t of business){
    output[t]=[]; trace[t]=new Map();
    let next=Math.max(0,...yearTable(sourceRows,2026,t).map(r=>r.id))+1;
    for(const y of [2026,2024,2025,2027]){
      const ids=idMap[y+'/'+t]=new Map();
      const rows=yearTable(sourceRows,y,t);
      let skipped=0;
      for(const r of rows.slice().sort((a,b)=>a.id-b.id)){
        const g=parent(y,t,r), key=y+'/'+g;
        if(lost.has(key)){skipped++;if(t!==group){const d=discarded.get(key);d.children[t]=(d.children[t]||0)+1;}continue;}
        const id=y===2026?r.id:next++;ids.set(r.id,id);trace[t].set(id,{y,r,g});
      }
      note('row_counts',{year:y,table:t,source:rows.length,planned:ids.size,skipped});
    }
  }
  // Compare child records as multisets of business values. Ignore audit fields
  // and row IDs, and resolve links so IDs from different years are comparable.
  function signature(y,t,r){
    const values=copy(y,t,r);
    for(const k of [...auditCols,'Ref']) delete values[k];
    for(const [k,v] of Object.entries(values)){
      const to=schema[t][k]?.type?.split(':')[1];
      if(directories.includes(to)) values[k]=directoryIds[y+'/'+to]?.get(v)??v;
      if(k==='DemandID' && t==='Hotel_Offers' && demands[y].has(v))
        values[k]=signature(y,'Hotel_Demand',demands[y].get(v));
    }
    return JSON.stringify(Object.entries(values).filter(([,v])=>v!=null && v!=='').sort(([a],[b])=>a.localeCompare(b)));
  }
  for(const d of duplicates){
    const [keepYear,keepId]=d.winner, [skipYear,skipId]=d.discard;
    d.onlyInDiscarded={};
    for(const t of Object.keys(d.children)){
      const remaining=new Map();
      for(const r of yearTable(sourceRows,keepYear,t))if(parent(keepYear,t,r)===keepId){
        const key=signature(keepYear,t,r);remaining.set(key,(remaining.get(key)||0)+1);
      }
      for(const r of yearTable(sourceRows,skipYear,t))if(parent(skipYear,t,r)===skipId){
        const key=signature(skipYear,t,r), count=remaining.get(key)||0;
        if(count)remaining.set(key,count-1);
        else (d.onlyInDiscarded[t]??=[]).push(r.id);
      }
    }
    note('duplicate',d);
  }
  for(const t of business) for(const [id,{y,r}] of trace[t]){
    const dest={...copy(y,t,r),Source_Year:y,Legacy_Id:r.id,id};
    if(t===group) Object.assign(dest,{Base_Year:y,Legacy_GroupID:r.GroupID});
    for(const [k,v] of Object.entries(dest)){
      const typ=schema[t][k]?.type||'';
      if(!/^Ref(List)?:/.test(typ) || emptyRef(v)) continue;
      const targetTable=typ.split(':')[1];
      const map=directoryIds[y+'/'+targetTable]||idMap[y+'/'+targetTable];
      const values=typ.startsWith('RefList:')?list(v):[v];
      if(values.some(x=>!map?.has(x))){
        const raw=typeof v==='string'?v:JSON.stringify(v);
        dest.Legacy_Note=[dest.Legacy_Note,k+': '+raw].filter(Boolean).join('\n');
        dest[k]=typ.startsWith('RefList:')?null:0;
        note('cleared_reference',{year:y,table:t,id:r.id,column:k,original:v});
      }else dest[k]=typ.startsWith('RefList:')?['L',...values.map(x=>map.get(x))]:map.get(v);
    }
    output[t].push(dest);
  }
  const financial=[];
  for(const y of years) for(const t of business.filter(t=>!['Group_List','Hotel_Demand'].includes(t))){
    const all=yearTable(sourceRows,y,t), keep=idMap[y+'/'+t], orig=[0,0], skipped=[0,0];
    const supported=money(t,y,{}).map(v=>v!==null);
    const excludedIds=[];
    for(const r of all){
      const columns=badAmountFields(t,r);
      if(columns.length){
        excludedIds.push(r.id);
        for(const k of columns)note('amount_exception',{year:y,table:t,id:r.id,column:k,original:r[k]});
        continue;
      }
      money(t,y,r).forEach((v,i)=>{if(v!==null){orig[i]+=v;if(!keep.has(r.id)) skipped[i]+=v;}});
    }
    const normalize=arr=>arr.map((x,i)=>supported[i]?Math.round(x*100)/100:null);
    const formulaChanges=[];
    for(const [k,sc] of Object.entries(sources[y].schema[sourceTable(y,t)])){
      const tc=schema[t][k];
      if(amountFields[t].includes(k) && computed(sc) && computed(tc) && sc.formula!==tc.formula)
        formulaChanges.push({column:k,source:sc.formula,target:tc.formula});
    }
    financial.push({year:y,table:t,formulaChanges,excludedIds,source:normalize(orig),excluded:normalize(skipped),expected:normalize(orig.map((v,i)=>v-skipped[i]))});
  }
  for(const row of financial) note('money',row);
  return {schema,actions,dirs,mapUpdates,staff,output,report,errors,trace,financial};
}
