import { NextResponse } from 'next/server';

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>902 Zarelda — Project Schedule</title>
<style>
  :root{
    --ground:#f3f1ec; --surface:#ffffff; --surface-2:#faf8f4;
    --ink:#1e222b; --muted:#6d6a62; --faint:#94908760; --hair:#e6e2d9;
    --accent:#b5502f;
    --pre:#3f6f9c; --drywall:#c98a20; --main:#2f8a6e; --ext:#c0603a; --base:#7a5aa6;
    --today:#b5502f;
    --good:#2f8a6e;
    --shadow:0 1px 2px rgba(30,34,43,.05),0 8px 24px rgba(30,34,43,.06);
    --namew:210px; --rowh:23px;
    --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  }
  @media (prefers-color-scheme:dark){
    :root{
      --ground:#111318; --surface:#1a1d24; --surface-2:#20242c;
      --ink:#ecebe6; --muted:#9a958c; --faint:#6b675e55; --hair:#2b2f38;
      --accent:#e0784f;
      --pre:#6f9ecb; --drywall:#e0aa45; --main:#48a988; --ext:#d6795a; --base:#a184c8;
      --today:#e0784f; --good:#48a988;
      --shadow:0 1px 2px rgba(0,0,0,.3),0 10px 30px rgba(0,0,0,.35);
    }
  }
  :root[data-theme="light"]{
    --ground:#f3f1ec; --surface:#ffffff; --surface-2:#faf8f4;
    --ink:#1e222b; --muted:#6d6a62; --faint:#94908760; --hair:#e6e2d9;
    --accent:#b5502f;
    --pre:#3f6f9c; --drywall:#c98a20; --main:#2f8a6e; --ext:#c0603a; --base:#7a5aa6;
    --today:#b5502f; --good:#2f8a6e;
    --shadow:0 1px 2px rgba(30,34,43,.05),0 8px 24px rgba(30,34,43,.06);
  }
  :root[data-theme="dark"]{
    --ground:#111318; --surface:#1a1d24; --surface-2:#20242c;
    --ink:#ecebe6; --muted:#9a958c; --faint:#6b675e55; --hair:#2b2f38;
    --accent:#e0784f;
    --pre:#6f9ecb; --drywall:#e0aa45; --main:#48a988; --ext:#d6795a; --base:#a184c8;
    --today:#e0784f; --good:#48a988;
    --shadow:0 1px 2px rgba(0,0,0,.3),0 10px 30px rgba(0,0,0,.35);
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--font);
    -webkit-font-smoothing:antialiased;line-height:1.5;padding:clamp(16px,4vw,44px)}
  .wrap{max-width:1120px;margin:0 auto}
  .eyebrow{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);font-weight:700}
  h1{font-size:clamp(26px,4.4vw,40px);margin:.15em 0 .1em;letter-spacing:-.02em;font-weight:800;text-wrap:balance}
  .sub{color:var(--muted);font-size:15px;margin:0 0 4px}
  .done-row{display:flex;flex-wrap:wrap;gap:6px;margin:16px 0 4px}
  .chip{font-size:11.5px;color:var(--muted);background:var(--surface);border:1px solid var(--hair);
    border-radius:999px;padding:3px 9px;display:inline-flex;align-items:center;gap:5px}
  .chip .ck{color:var(--good);font-weight:800}
  .tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:22px 0}
  @media(max-width:640px){.tiles{grid-template-columns:repeat(2,1fr)}}
  .tile{background:var(--surface);border:1px solid var(--hair);border-radius:14px;padding:14px 15px;box-shadow:var(--shadow)}
  .tile .k{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:700}
  .tile .v{font-size:20px;font-weight:800;margin-top:5px;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
  .tile .n{font-size:12px;color:var(--muted);margin-top:2px}
  .tile .v .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
  .card{background:var(--surface);border:1px solid var(--hair);border-radius:16px;box-shadow:var(--shadow);
    padding:18px clamp(12px,2.4vw,22px);margin-top:8px}
  .card h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:2px 0 14px;font-weight:700}
  .legend{display:flex;flex-wrap:wrap;gap:14px 18px;margin:2px 0 16px;font-size:12.5px;color:var(--muted)}
  .legend span{display:inline-flex;align-items:center;gap:7px}
  .sw{width:16px;height:11px;border-radius:3px;display:inline-block}
  .sw.hatch{background-image:repeating-linear-gradient(45deg,currentColor 0 2px,transparent 2px 5px);border:1px solid currentColor}
  .scroller{overflow-x:auto;overflow-y:hidden;padding-bottom:6px}
  .gantt{min-width:820px;position:relative}
  .months{display:grid;grid-template-columns:var(--namew) 1fr;margin-bottom:2px}
  .months .mspacer{}
  .mbar{position:relative;height:24px;border-bottom:1px solid var(--hair)}
  .mcell{position:absolute;top:0;height:24px;display:flex;align-items:center;padding-left:8px;
    font-size:12px;font-weight:700;color:var(--muted);letter-spacing:.03em;border-left:1px solid var(--hair)}
  .grid-layer{position:absolute;left:var(--namew);right:0;top:0;bottom:0;pointer-events:none;z-index:0}
  .gline{position:absolute;top:0;bottom:0;width:1px;background:var(--hair)}
  .today{position:absolute;top:0;bottom:0;width:2px;background:var(--today);z-index:5}
  .today::after{content:"TODAY";position:absolute;top:-2px;left:4px;font-size:9.5px;font-weight:800;
    letter-spacing:.08em;color:var(--today);white-space:nowrap}
  .grp{margin-top:4px}
  .grp__h{display:flex;align-items:center;gap:8px;font-size:11.5px;font-weight:800;letter-spacing:.04em;
    text-transform:uppercase;color:var(--ink);padding:9px 0 5px}
  .grp__h .pin{width:9px;height:9px;border-radius:3px}
  .grp__h .meta{font-weight:600;color:var(--muted);letter-spacing:0;text-transform:none;font-size:11.5px}
  .row{display:grid;grid-template-columns:var(--namew) 1fr;align-items:center;height:var(--rowh)}
  .row__name{font-size:12.5px;color:var(--ink);padding-right:10px;white-space:nowrap;overflow:hidden;
    text-overflow:ellipsis}
  .row__name.pro{color:var(--muted)}
  .track{position:relative;height:var(--rowh)}
  .bar{position:absolute;top:3px;height:calc(var(--rowh) - 7px);border-radius:4px;min-width:5px;
    display:flex;align-items:center;z-index:2;box-shadow:0 0 0 1px rgba(0,0,0,.04)}
  .bar.pro{opacity:.92;background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.32) 0 2px,transparent 2px 6px)}
  :root[data-theme="dark"] .bar.pro{background-image:repeating-linear-gradient(45deg,rgba(0,0,0,.28) 0 2px,transparent 2px 6px)}
  @media(prefers-color-scheme:dark){.bar.pro{background-image:repeating-linear-gradient(45deg,rgba(0,0,0,.28) 0 2px,transparent 2px 6px)}}
  .bar.gate{background:transparent!important;border:1px dashed var(--muted);
    background-image:repeating-linear-gradient(45deg,var(--faint) 0 3px,transparent 3px 7px)!important;box-shadow:none}
  .bar .lbl{font-size:10.5px;font-weight:700;color:#fff;padding:0 6px;white-space:nowrap;
    text-shadow:0 1px 1px rgba(0,0,0,.25);overflow:hidden}
  .bar.out .lbl{position:absolute;left:calc(100% + 6px);color:var(--ink);text-shadow:none}
  .bar.warn::after{content:"\\26A0";position:absolute;right:-16px;font-size:11px;color:var(--ext)}
  .ms{position:absolute;top:1px;width:12px;height:12px;background:var(--drywall);transform:translateX(-50%) rotate(45deg);
    z-index:6;border:1.5px solid var(--surface);border-radius:2px}
  .ms-row{position:relative;height:26px;margin-top:2px}
  .ms-lbl{position:absolute;top:15px;font-size:10px;font-weight:700;color:var(--ink);transform:translateX(-50%);
    white-space:nowrap;background:var(--surface);padding:0 3px}
  .notes{margin-top:18px;display:grid;grid-template-columns:1fr 1fr;gap:8px 26px;font-size:12.5px;color:var(--muted)}
  @media(max-width:640px){.notes{grid-template-columns:1fr}}
  .notes b{color:var(--ink);font-weight:700}
  .notes li{margin:4px 0;list-style:none;padding-left:16px;position:relative}
  .notes li::before{content:"";position:absolute;left:0;top:7px;width:6px;height:6px;border-radius:2px;background:var(--accent)}
  details{margin-top:14px;border-top:1px solid var(--hair);padding-top:10px}
  summary{cursor:pointer;font-size:12.5px;font-weight:700;color:var(--accent)}
  table{width:100%;border-collapse:collapse;margin-top:12px;font-size:12.5px}
  th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--hair);white-space:nowrap}
  th{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
  td.d{font-variant-numeric:tabular-nums;color:var(--muted)}
  .foot{color:var(--muted);font-size:11.5px;margin-top:20px;text-align:center}
</style>
</head>
<body>
<div class="wrap">
  <div class="eyebrow">902 Zarelda St · Butte, MT · Meadowlark Renewal</div>
  <h1>Project Schedule</h1>
  <p class="sub">Fix &amp; flip — critical-path timeline, anchored to Drywall complete (Jul 22, 2026).</p>

  <div class="done-row" id="done"></div>

  <div class="tiles">
    <div class="tile"><div class="k">Current phase</div><div class="v"><span class="dot" style="background:var(--drywall)"></span>Drywall</div><div class="n">Hang + finish, in progress</div></div>
    <div class="tile"><div class="k">Drywall complete</div><div class="v">Jul 22</div><div class="n">Schedule anchor</div></div>
    <div class="tile"><div class="k">Main floor done</div><div class="v">~Sep 3</div><div class="n">Move-in-ready upstairs</div></div>
    <div class="tile"><div class="k">Project complete</div><div class="v">~Oct 29</div><div class="n">Incl. basement build-out</div></div>
  </div>

  <div class="card">
    <h2>Timeline</h2>
    <div class="legend">
      <span style="color:var(--pre)"><i class="sw" style="background:var(--pre)"></i>Pre-drywall</span>
      <span style="color:var(--drywall)"><i class="sw" style="background:var(--drywall)"></i>Drywall</span>
      <span style="color:var(--main)"><i class="sw" style="background:var(--main)"></i>Main floor</span>
      <span style="color:var(--ext)"><i class="sw" style="background:var(--ext)"></i>Exterior</span>
      <span style="color:var(--base)"><i class="sw" style="background:var(--base)"></i>Basement</span>
      <span style="color:var(--muted)"><i class="sw hatch"></i>Pro / parallel trade</span>
      <span style="color:var(--muted)"><i class="sw" style="background:var(--drywall);transform:rotate(45deg);width:11px;height:11px;border-radius:2px"></i>Milestone</span>
    </div>
    <div class="scroller">
      <div class="gantt" id="gantt"></div>
    </div>
    <div class="notes">
      <ul style="margin:0;padding:0">
        <li><b>In-house crew = one resource.</b> In-house tasks run serial (solid bars); pro trades (hatched) run in parallel on their own chains.</li>
        <li><b>Basement runs after the main floor</b> with the same crew — the single biggest driver of the ~Oct finish. A 2nd crew would compress this.</li>
      </ul>
      <ul style="margin:0;padding:0">
        <li><b>Cure &amp; permit gates are real calendar time</b> (dashed): paint&rarr;floor poly cure (3d), and a permit inspection gate before basement drywall.</li>
        <li><b>Durations are high-end (conservative).</b> Exterior seeding in July has low germination — weather-flagged (&#x26A0;).</li>
      </ul>
    </div>
    <details>
      <summary>View as list (all tasks &amp; dates)</summary>
      <table id="tbl"><thead><tr><th>Phase</th><th>Task</th><th>Crew</th><th>Start</th><th>End</th></tr></thead><tbody></tbody></table>
    </details>
  </div>

  <p class="foot">Source: 902 Zarelda Gantt Reference tab · workday-formula schedule · generated for Jennifer.</p>
</div>

<script>
(function(){
  var TL_START=Date.UTC(2026,6,1), TL_END=Date.UTC(2026,10,1), SPAN=TL_END-TL_START, DAY=86400000;
  var TODAY="2026-07-03";
  function p(iso){return (Date.parse(iso+"T00:00:00Z")-TL_START)/SPAN*100;}
  function fmt(iso){var d=new Date(iso+"T00:00:00Z");return d.toLocaleDateString("en-US",{month:"short",day:"numeric",timeZone:"UTC"});}
  var PH={pre:"var(--pre)",drywall:"var(--drywall)",main:"var(--main)",ext:"var(--ext)",base:"var(--base)"};
  var PHN={pre:"Pre-drywall",drywall:"Drywall",main:"Main floor",ext:"Exterior",base:"Basement"};

  var done=["Demolition","Foundation","Framing","Insulation","Rough plumbing","Rough electrical","Subfloor"];
  var dh=document.getElementById("done");
  dh.innerHTML='<span class="chip" style="border-color:var(--good);color:var(--good);font-weight:700">Completed</span>'+
    done.map(function(x){return '<span class="chip"><span class="ck">&#x2713;</span>'+x+'</span>';}).join("");

  var groups=[
    {h:"Pre-drywall — happening now",phase:"pre",tasks:[
      {n:"HVAC rough-in",s:"2026-07-06",e:"2026-07-06",pro:1,ph:"pre"},
      {n:"Roofing",s:"2026-07-09",e:"2026-07-09",pro:1,ph:"pre"},
      {n:"Drywall — hang + finish",s:"2026-07-08",e:"2026-07-22",ph:"drywall"}
    ]},
    {h:"Main floor — in-house crew",phase:"main",meta:"serial",tasks:[
      {n:"Interior paint",s:"2026-07-23",e:"2026-08-03",ph:"main"},
      {n:"Poly cure",s:"2026-08-03",e:"2026-08-06",ph:"main",gate:1},
      {n:"Refinish wood floors",s:"2026-08-06",e:"2026-08-12",ph:"main"},
      {n:"Doors + trim",s:"2026-08-13",e:"2026-08-20",ph:"main"},
      {n:"Cabinet set",s:"2026-08-21",e:"2026-08-25",ph:"main"},
      {n:"Countertops (butcher block)",s:"2026-08-26",e:"2026-08-27",ph:"main"},
      {n:"Handrails + guardrails",s:"2026-08-28",e:"2026-08-31",ph:"main"},
      {n:"Final clean — main floor",s:"2026-09-01",e:"2026-09-03",ph:"main"}
    ]},
    {h:"Main floor — pro trades",phase:"main",meta:"parallel",tasks:[
      {n:"HVAC rough-out + trim",s:"2026-07-23",e:"2026-07-24",pro:1,ph:"main"},
      {n:"Tile / shower surround",s:"2026-07-23",e:"2026-07-28",pro:1,ph:"main"},
      {n:"Tile — kitchen / hall / bath",s:"2026-08-06",e:"2026-08-12",pro:1,ph:"main"},
      {n:"Plumbing fixtures",s:"2026-08-28",e:"2026-09-01",pro:1,ph:"main"},
      {n:"Appliances",s:"2026-08-28",e:"2026-08-28",pro:1,ph:"main"}
    ]},
    {h:"Exterior — parallel",phase:"ext",tasks:[
      {n:"Exterior doors + windows",s:"2026-07-23",e:"2026-07-27",pro:1,ph:"ext"},
      {n:"Decks / ramp / landscape",s:"2026-07-23",e:"2026-07-29",ph:"ext",warn:1}
    ]},
    {h:"Basement — in-house crew",phase:"base",meta:"serial, starts after main floor",tasks:[
      {n:"Egress window (concrete)",s:"2026-09-04",e:"2026-09-09",ph:"base"},
      {n:"Utility closet framing",s:"2026-09-10",e:"2026-09-10",ph:"base"},
      {n:"Soundproof insulation",s:"2026-09-11",e:"2026-09-14",ph:"base"},
      {n:"Permit inspection gate",s:"2026-09-14",e:"2026-09-17",ph:"base",gate:1},
      {n:"Drywall — basement",s:"2026-09-18",e:"2026-09-25",ph:"base"},
      {n:"Floor leveling",s:"2026-09-28",e:"2026-09-29",ph:"base"},
      {n:"Paint — basement",s:"2026-09-30",e:"2026-10-05",ph:"base"},
      {n:"Poly cure",s:"2026-10-05",e:"2026-10-08",ph:"base",gate:1},
      {n:"Flooring — vinyl sheet",s:"2026-10-08",e:"2026-10-12",ph:"base"},
      {n:"Doors (ext + int + closet)",s:"2026-10-13",e:"2026-10-15",ph:"base"},
      {n:"Bedroom closets",s:"2026-10-16",e:"2026-10-19",ph:"base"},
      {n:"Cabinet set — basement",s:"2026-10-20",e:"2026-10-22",ph:"base"},
      {n:"Countertops — basement",s:"2026-10-23",e:"2026-10-23",ph:"base"},
      {n:"Trim (caulk + cove)",s:"2026-10-26",e:"2026-10-27",ph:"base"},
      {n:"Final clean — basement",s:"2026-10-28",e:"2026-10-29",ph:"base"}
    ]},
    {h:"Basement — pro trades",phase:"base",meta:"parallel",tasks:[
      {n:"Kitchen plumbing rough",s:"2026-09-04",e:"2026-09-08",pro:1,ph:"base"},
      {n:"Bath plumbing rough",s:"2026-09-04",e:"2026-09-08",pro:1,ph:"base"},
      {n:"Branch electrical rough",s:"2026-09-04",e:"2026-09-08",pro:1,ph:"base"},
      {n:"Heat ductwork rough",s:"2026-09-04",e:"2026-09-07",pro:1,ph:"base"},
      {n:"W/D rough (plumb + 240V)",s:"2026-09-04",e:"2026-09-07",pro:1,ph:"base"},
      {n:"Bath fixture set",s:"2026-10-08",e:"2026-10-09",pro:1,ph:"base"},
      {n:"Elec / heat / W/D trim",s:"2026-10-08",e:"2026-10-09",pro:1,ph:"base"},
      {n:"Appliances — basement",s:"2026-10-12",e:"2026-10-12",pro:1,ph:"base"}
    ]}
  ];
  var milestones=[
    {n:"Drywall complete",d:"2026-07-22"},
    {n:"Main floor complete",d:"2026-09-03"},
    {n:"Project complete",d:"2026-10-29"}
  ];

  var g=document.getElementById("gantt");
  var months=[["Jul","2026-07-01"],["Aug","2026-08-01"],["Sep","2026-09-01"],["Oct","2026-10-01"]];
  var mh='<div class="months"><div class="mspacer"></div><div class="mbar">';
  months.forEach(function(m){
    mh+='<div class="mcell" style="left:'+p(m[1])+'%">'+m[0]+' 2026</div>';
  });
  mh+='</div></div>';

  var grid='<div class="grid-layer">';
  months.forEach(function(m){grid+='<div class="gline" style="left:'+p(m[1])+'%"></div>';});
  grid+='<div class="today" style="left:'+p(TODAY)+'%"></div></div>';

  var body="";
  groups.forEach(function(gr){
    body+='<div class="grp"><div class="grp__h"><span class="pin" style="background:'+PH[gr.phase]+'"></span>'+gr.h+
      (gr.meta?'<span class="meta">· '+gr.meta+'</span>':'')+'</div>';
    gr.tasks.forEach(function(t){
      var left=p(t.s), w=Math.max((Date.parse(t.e+"T00:00:00Z")-Date.parse(t.s+"T00:00:00Z"))/SPAN*100 + DAY/SPAN*100, 0.9);
      var cls="bar"+(t.pro?" pro":"")+(t.gate?" gate":"")+(t.warn?" warn":"");
      var col=t.gate?"transparent":PH[t.ph];
      var outside=w<9;
      var barcls=cls+(outside&&!t.gate?" out":"");
      var labelHtml=t.gate?'':'<span class="lbl">'+t.n+'</span>';
      body+='<div class="row"><div class="row__name'+(t.pro?' pro':'')+'">'+t.n+'</div>'+
        '<div class="track"><div class="'+barcls+'" style="left:'+left+'%;width:'+w+'%;background:'+col+'" title="'+t.n+' · '+fmt(t.s)+'–'+fmt(t.e)+'">'+(t.gate||outside?'':labelHtml)+'</div></div></div>';
    });
    body+='</div>';
  });

  var msrow='<div class="grp"><div class="grp__h"><span class="pin" style="background:var(--drywall);transform:rotate(45deg);border-radius:2px"></span>Milestones</div>'+
    '<div class="row" style="height:30px"><div class="row__name"></div><div class="track" style="height:30px">';
  milestones.forEach(function(m){
    msrow+='<div class="ms" style="left:'+p(m.d)+'%"></div><div class="ms-lbl" style="left:'+p(m.d)+'%">'+m.n+'<br>'+fmt(m.d)+'</div>';
  });
  msrow+='</div></div></div>';

  g.innerHTML=mh+'<div style="position:relative">'+grid+body+msrow+'</div>';

  var tb=document.querySelector("#tbl tbody"), rows="";
  groups.forEach(function(gr){gr.tasks.forEach(function(t){
    rows+='<tr><td style="color:'+PH[t.ph]+';font-weight:700">'+PHN[t.ph]+'</td><td>'+t.n+'</td><td class="d">'+(t.gate?'gate':(t.pro?'Pro':'In-house'))+'</td><td class="d">'+fmt(t.s)+'</td><td class="d">'+fmt(t.e)+'</td></tr>';
  });});
  tb.innerHTML=rows;
})();
</script>
</body>
</html>`;

export function GET() {
  return new NextResponse(HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
