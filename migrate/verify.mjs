import {randomInt} from 'node:crypto';
import {business,directories,years,computed,money,equal,badAmountFields} from './plan.mjs';

// merge.mjs reads back the target using the same credential as the import.
// Verification only receives the plan and the resulting document snapshot.
export function verify(plan,doc) {
  const report=[], errors=[];
  const item=(kind,detail)=>report.push({kind,detail});
  const fail=(kind,detail)=>errors.push({kind,detail});
  const index=Object.fromEntries(Object.entries(doc.rows).map(([t,rs])=>[t,new Map(rs.map(r=>[r.id,r]))]));
  for(const t of business) {
    const rows=doc.rows[t], expected=plan.output[t];
    if(rows.length!==expected.length) fail('target_total',{table:t,expected:expected.length,actual:rows.length});
    for(const e of expected) {
      const r=index[t].get(e.id);
      if(!r) {fail('missing_row',{table:t,id:e.id});continue;}
      const bad=Object.keys(e).filter(k=>!equal(e[k],r[k]));
      if(bad.length) fail('stored_data_difference',{table:t,id:e.id,columns:bad});
    }
    for(const y of years){
      const original=plan.report.find(x=>x.kind==='row_counts' && x.detail.year===y && x.detail.table===t).detail;
      const imported=rows.filter(r=>r.Source_Year===y).length;
      item('verified_rows',{...original,imported});
      if(imported+original.skipped!==original.source) fail('row_balance',{year:y,table:t,imported,...original});
    }
  }
  for(const [t,rs] of Object.entries({...plan.dirs,Staff:plan.staff,MG_NameMap:plan.mapUpdates})) for(const e of rs) {
    const r=index[t]?.get(e.id);
    const bad=Object.keys(e).filter(k=>!r || !equal(e[k],r[k]));
    if(bad.length) fail('directory_or_mapping_difference',{table:t,id:e.id,columns:bad});
  }
  for(const [t,cols] of Object.entries(doc.schema)){
    for(const [k,c] of Object.entries(cols)){
      if(!/^Ref(List)?:/.test(c.type))continue;
      const dest=c.type.split(':')[1],bad=[];
      if(!index[t] || !index[dest]) {fail('unread_reference_endpoint',{t,k,dest});continue;}
      for(const r of doc.rows[t]){
        const v=r[k];
        if(v===null || v===0 || v==='' || v===undefined)continue;
        const ids=c.type.startsWith('RefList:') && Array.isArray(v) && v[0]==='L'?v.slice(1):[v];
        if(ids.some(id=>!Number.isSafeInteger(id)||!index[dest].has(id)))bad.push(r.id);
      }
      item('reference_check',{table:t,column:k,target:dest,invalid:bad.length,examples:bad.slice(0,20)});
      if(bad.length) fail('invalid_target_reference',{t,k,count:bad.length});
    }
  }
  for(const m of plan.financial){
    const totals=[0,0],rows=doc.rows[m.table].filter(r=>r.Source_Year===m.year);
    const excluded=new Set(m.excludedIds);
    const expected=[...m.expected];
    for(const r of rows) try {
      if(excluded.has(r.Legacy_Id))continue;
      const invalid=badAmountFields(m.table,r);
      if(invalid.length){
        for(const k of invalid)item('target_amount_exception',{year:m.year,table:m.table,id:r.Legacy_Id,column:k,original:r[k]});
        const original=plan.trace[m.table].get(r.id).r;
        money(m.table,m.year,original).forEach((v,i)=>{if(expected[i]!==null)expected[i]-=v;});
        continue;
      }
      money(m.table,2026,r).forEach((v,i)=>{if(v!==null)totals[i]+=v;});
    }catch(e){fail('target_amount_error',{table:m.table,id:r.id,error:e.message});}
    const actual=totals.map((v,i)=>Math.round(v*100)/100);
    const diff=actual.map((v,i)=>m.expected[i]===null?null:Math.round((v-expected[i])*100)/100);
    const targetSupported=money(m.table,2026,{}).map(v=>v!==null);
    item('verified_money',{...m,expected,actual:actual.map((v,i)=>targetSupported[i]?v:null),difference:diff});
    if(diff.some(v=>v!==null && v!==0)) fail('amount_difference',{year:m.year,table:m.table,difference:diff});
  }
  const groupYears=new Map(),candidates=[];
  for(const r of doc.rows.Group_List){
    const dated=r.Arrival_Date!=null && r.Arrival_Date!=='';
    const date=dated?new Date(typeof r.Arrival_Date==='number'?r.Arrival_Date*1000:r.Arrival_Date):null;
    const expected=dated?date.getUTCFullYear():r.Base_Year;
    if(r.Year!==expected)fail('group_year',{id:r.id,actual:r.Year,expected});
    const counts=groupYears.get(r.Year)||{dated:0,undated:0};counts[dated?'dated':'undated']++;groupYears.set(r.Year,counts);
    if(r.Source_Year!==2026)candidates.push(r);
  }
  for(const [year,n] of groupYears)item('year_group_count',{year,...n});
  const expectedByTable=Object.fromEntries(business.map(t=>[t,new Map(plan.output[t].map(r=>[r.id,r]))]));
  for(let j=0;j<5 && candidates.length;j++){
    const [g]=candidates.splice(randomInt(candidates.length),1);
    for(const t of business) for(const [id,{y,r,g:oldGroup}] of plan.trace[t]){
      if(y!==g.Source_Year || oldGroup!==g.Legacy_Id)continue;
      const target=index[t].get(id)||{}, expected=expectedByTable[t].get(id);
      const fields=[];
      for(const [k,v] of Object.entries(expected)){
        let sourceKey=k;
        if(k==='Legacy_Id')sourceKey='id';
        if(k==='Legacy_GroupID')sourceKey='GroupID';
        if(k==='Source_Year'||k==='Base_Year')sourceKey=null;
        if(t==='Schedule' && k==='Trsf_Cost' && y===2024)sourceKey='Driver_Cost';
        if(t==='Meal' && y===2024)sourceKey=({Net_Pax:'Pax',Net_Rate:'Rate'}[k]||sourceKey);
        fields.push({field:k,sourceField:sourceKey??'document year',source:sourceKey?r[sourceKey]??null:y,expected:v,actual:target[k]??null,ok:equal(v,target[k])});
      }
      for(const [k,c] of Object.entries(doc.schema[t]))if(computed(c)){
        fields.push({field:k,source:r[k]??null,actual:target[k]??null,recalculated:true});
      }
      item('sample',{group:g.Reference,year:y,table:t,oldId:r.id,id,fields});
    }
  }
  return {report,errors};
}
