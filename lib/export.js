// Standalone, lazily loaded spreadsheet and image exporters.
(() => {
  const xml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  function zip(entries) {
    const enc = new TextEncoder(), files = [], central = [];
    const header = n => new Uint8Array(n);
    const u16 = (b,i,n) => new DataView(b.buffer).setUint16(i,n,true);
    const u32 = (b,i,n) => new DataView(b.buffer).setUint32(i,n,true);
    let offset=0, size=0;
    for (const [path,source] of Object.entries(entries)) {
      const name=enc.encode(path), data=enc.encode(source);
      let crc=0xffffffff;
      for(const byte of data){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}
      crc=(~crc)>>>0;
      const h=header(30);u32(h,0,0x04034b50);u16(h,4,20);u32(h,14,crc);u32(h,18,data.length);u32(h,22,data.length);u16(h,26,name.length);
      files.push(h,name,data);
      const c=header(46);u32(c,0,0x02014b50);u16(c,4,20);u16(c,6,20);u32(c,16,crc);u32(c,20,data.length);u32(c,24,data.length);u16(c,28,name.length);u32(c,42,offset);
      central.push(c,name);size+=c.length+name.length;offset+=h.length+name.length+data.length;
    }
    const end=header(22);u32(end,0,0x06054b50);u16(end,8,central.length/2);u16(end,10,central.length/2);u32(end,12,size);u32(end,16,offset);
    return new Blob([...files,...central,end],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  }
  function workbook(rows){
    const ns='http://schemas.openxmlformats.org/', sheetNS=ns+'spreadsheetml/2006/main', rel=ns+'officeDocument/2006/relationships',rels=ns+'package/2006/relationships';
    const letters=n=>{let out='';while(n){n--;out=String.fromCharCode(65+n%26)+out;n=Math.floor(n/26)}return out};
    return zip({
      '[Content_Types].xml':'<Types xmlns="'+ns+'package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      '_rels/.rels':'<Relationships xmlns="'+rels+'"><Relationship Id="rId1" Type="'+rel+'/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'xl/workbook.xml':'<workbook xmlns="'+sheetNS+'" xmlns:r="'+rel+'"><sheets><sheet name="Console" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':'<Relationships xmlns="'+rels+'"><Relationship Id="rId1" Type="'+rel+'/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml':'<worksheet xmlns="'+sheetNS+'"><sheetData>'+rows.map((r,i)=>'<row r="'+(i+1)+'">'+r.map((v,j)=>'<c r="'+letters(j+1)+(i+1)+'" t="inlineStr"><is><t xml:space="preserve">'+xml(v)+'</t></is></c>').join('')+'</row>').join('')+'</sheetData></worksheet>'
    });
  }
  async function png(rows){
    const c=document.createElement('canvas'),ctx=c.getContext('2d');
    ctx.font='13px sans-serif';const widths=rows[0].map((_,i)=>Math.min(460,rows.reduce((w,r)=>Math.max(w,ctx.measureText(String(r[i]??'')).width+16),55)));
    c.width=Math.ceil(widths.reduce((a,b)=>a+b,0));c.height=rows.length*25;
    if(c.width*c.height>64000000||Math.max(c.width,c.height)>32767)throw Error('PNG size limit');
    ctx.font='13px sans-serif';rows.forEach((r,i)=>{let x=0;r.forEach((v,j)=>{const w=widths[j];ctx.fillStyle=i?'white':'#edf2ef';ctx.fillRect(x,i*25,w,25);ctx.strokeStyle='#ddd';ctx.strokeRect(x,i*25,w,25);ctx.fillStyle='#222';ctx.fillText(String(v),x+6,i*25+17,w-10);x+=w})});
    return new Promise((ok,no)=>c.toBlob(b=>b?ok(b):no(Error('PNG')), 'image/png'));
  }
  async function pdf(rows,title,orientation) {
    const landscape=orientation==='landscape', width=landscape?842:595, height=landscape?595:842;
    const encoder=new TextEncoder(), objects=[], encode=s=>encoder.encode(s);
    const add=(...parts)=>{objects.push(parts.map(p=>typeof p==='string'?encode(p):p));return objects.length};
    const catalog=add(''), pages=add(''), kids=[];
    const canvas=document.createElement('canvas');canvas.width=width*2;canvas.height=height*2;
    const ctx=canvas.getContext('2d');ctx.scale(2,2);ctx.font='9px sans-serif';
    const widths=rows[0].map((_,j)=>Math.min(width-48,Math.max(45,rows.reduce((n,r)=>Math.max(n,ctx.measureText(String(r[j]??'')).width+12),0))));
    const bands=[];let current=[],used=0;
    widths.forEach((w,i)=>{if(current.length&&used+w>width-48){bands.push(current);current=[];used=0}current.push(i);used+=w});if(current.length)bands.push(current);
    const perPage=Math.floor((height-82)/16);
    for(const band of bands)for(let start=1;start<Math.max(2,rows.length);start+=perPage){
      ctx.fillStyle='white';ctx.fillRect(0,0,width,height);ctx.fillStyle='#222';ctx.font='bold 14px sans-serif';ctx.fillText(title,24,30,width-48);ctx.font='9px sans-serif';
      [rows[0],...rows.slice(start,start+perPage)].forEach((row,i)=>{let x=24;const y=44+i*16;for(const j of band){const w=widths[j];ctx.fillStyle=i?'white':'#edf2ef';ctx.fillRect(x,y,w,16);ctx.strokeStyle='#ccc';ctx.lineWidth=.4;ctx.strokeRect(x,y,w,16);ctx.fillStyle='#222';ctx.fillText(String(row[j]??''),x+4,y+11,w-8);x+=w}});
      const jpeg=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.9));if(!jpeg)throw Error('PDF image');
      const data=new Uint8Array(await jpeg.arrayBuffer()),im=add('<< /Type /XObject /Subtype /Image /Width '+canvas.width+' /Height '+canvas.height+' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length '+data.length+' >>\nstream\n',data,'\nendstream');
      const cmd='q '+width+' 0 0 '+height+' 0 0 cm /Table Do Q',content=add('<< /Length '+cmd.length+' >>\nstream\n'+cmd+'\nendstream');
      kids.push(add('<< /Type /Page /Parent '+pages+' 0 R /MediaBox [0 0 '+width+' '+height+'] /Resources << /XObject << /Table '+im+' 0 R >> >> /Contents '+content+' 0 R >>'));
    }
    objects[catalog-1]=[encode('<< /Type /Catalog /Pages '+pages+' 0 R >>')];objects[pages-1]=[encode('<< /Type /Pages /Count '+kids.length+' /Kids ['+kids.map(i=>i+' 0 R').join(' ')+'] >>')];
    const parts=[encode('%PDF-1.4\n')],offsets=[0];let offset=parts[0].length;
    objects.forEach((obj,i)=>{offsets.push(offset);for(const p of [encode((i+1)+' 0 obj\n'),...obj,encode('\nendobj\n')]){parts.push(p);offset+=p.length}});
    parts.push(encode('xref\n0 '+offsets.length+'\n0000000000 65535 f \n'+offsets.slice(1).map(x=>String(x).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size '+offsets.length+' /Root 1 0 R >>\nstartxref\n'+offset+'\n%%EOF'));
    return new Blob(parts,{type:'application/pdf'});
  }
  window.ConsoleExport={workbook,png,pdf};
})();
