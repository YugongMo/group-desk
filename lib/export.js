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
  window.ConsoleExport={workbook,png};
})();
