// The offline Replay→video renderer, hosted in a WebView. It draws a run's Replay on a
// <canvas> (cinematic black-BG "route draws itself" look) and records it to WebM via
// canvas.captureStream() + MediaRecorder — all in-browser, no network, no map tiles.
//
// Handshake with React Native (so we can pass a big run payload after load):
//   page  -> RN : {type:"ready"}                     once loaded
//   RN    -> page: window.__setRun(<json>)            injected; starts the render
//   page  -> RN : {type:"progress", p}                0..1 while rendering
//   page  -> RN : {type:"done", dataUrl}              base64 data: URL of the WebM
//   page  -> RN : {type:"error", msg}
//
// RUN shape: { name, totalGain?, points:[{lat,lon,alt,t}], annotations:[{t,kind,text,img?}],
//              opts:{durationS,size,bitrate} }. `img` is a data: URI (embedded, offline).
//
// IMPORTANT: this string is a TS template literal — the embedded script MUST NOT use
// backticks or ${...} (it uses string concatenation throughout) so nothing needs escaping.
export function replayVideoHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>html,body{margin:0;background:#000;overflow:hidden}canvas{display:block;width:100vw;height:100vw}</style>
</head><body>
<canvas id="c" width="1000" height="1000"></canvas>
<script>
"use strict";
(function(){
  function post(o){ try{ if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} }
  window.onerror=function(m){ post({type:"error",msg:String(m)}); };

  var C={bg:"#07090b",prim:"#e0932f",prim2:"#ffb347",text:"#e8edf2",t2:"#a9b4bf",t3:"#6f7c88",
         ok:"#4caf6e",err:"#e0574a",photo:"#4aa3ff",voice:"#c07af0",
         sans:"-apple-system,Roboto,Helvetica,Arial,sans-serif"};
  var KIND={text:"\\uD83D\\uDCAC",photo:"\\uD83D\\uDCF7",voice:"\\uD83C\\uDF99\\uFE0F"};
  var R2=Math.PI/180;
  function hav(a,b){var R=6371000,dLat=(b.lat-a.lat)*R2,dLon=(b.lon-a.lon)*R2;
    var s=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(a.lat*R2)*Math.cos(b.lat*R2)*Math.sin(dLon/2)*Math.sin(dLon/2);
    return 2*R*Math.asin(Math.min(1,Math.sqrt(s)));}
  function mercX(lon){return (lon+180)/360;}
  function mercY(lat){var c=Math.min(85.05,Math.max(-85.05,lat)),r=c*R2;
    return (1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2;}
  function fmtDist(m){return (m/1000).toFixed(2)+" km";}
  function fmtDur(s){s=Math.max(0,Math.floor(s));var h=Math.floor(s/3600),m=Math.floor((s%3600)/60),x=s%60;
    function p(n){return (n<10?"0":"")+n;} return h>0?(h+":"+p(m)+":"+p(x)):(m+":"+p(x));}
  function ease(u){ return u<0.5 ? 4*u*u*u : 1-Math.pow(-2*u+2,3)/2; }

  var cv=document.getElementById("c"), ctx=cv.getContext("2d");

  function build(run){
    var W=run.opts.size, H=run.opts.size; cv.width=W; cv.height=H;
    var p=run.points, cum=[0], i;
    for(i=1;i<p.length;i++) cum[i]=cum[i-1]+hav(p[i-1],p[i]);
    var total=cum[cum.length-1];
    var minx=1e9,maxx=-1e9,miny=1e9,maxy=-1e9;
    for(i=0;i<p.length;i++){var x=mercX(p[i].lon),y=mercY(p[i].lat);
      if(x<minx)minx=x;if(x>maxx)maxx=x;if(y<miny)miny=y;if(y>maxy)maxy=y;}
    var sx=Math.max(1e-9,maxx-minx), sy=Math.max(1e-9,maxy-miny), pad=W*0.13;
    var s=Math.min((W-2*pad)/sx,(H-2*pad)/sy);
    var offx=(W-sx*s)/2-minx*s, offy=(H-sy*s)/2-miny*s;
    function proj(q){return [mercX(q.lon)*s+offx, mercY(q.lat)*s+offy];}
    var annD=run.annotations.map(function(a){var bi=0,bd=1e18,j;
      for(j=0;j<p.length;j++){var g=Math.abs(p[j].t-a.t); if(g<bd){bd=g;bi=j;}}
      return {kind:a.kind,text:a.text,img:a.img,dist:cum[bi]};});
    var minA=1e9,maxA=-1e9,gain=0;
    for(i=0;i<p.length;i++){var al=p[i].alt||0; if(al<minA)minA=al; if(al>maxA)maxA=al;
      if(i>0){var dd=(p[i].alt||0)-(p[i-1].alt||0); if(dd>0)gain+=dd;}}
    return {p:p,cum:cum,total:total,proj:proj,annD:annD,minA:minA,maxA:maxA,gain:gain,W:W,H:H,dur:run.points[p.length-1].t-run.points[0].t};
  }
  function at(m,d){var p=m.p,cum=m.cum; d=Math.max(0,Math.min(m.total,d));
    var i=0; while(i<cum.length-1 && cum[i+1]<d) i++;
    var a=p[i], b=p[Math.min(i+1,p.length-1)];
    var seg=cum[Math.min(i+1,cum.length-1)]-cum[i], f=seg>0?(d-cum[i])/seg:0;
    function L(x,y){return x+(y-x)*f;}
    return {lat:L(a.lat,b.lat),lon:L(a.lon,b.lon),alt:L(a.alt,b.alt),t:L(a.t,b.t)};}

  function rr(c,x,y,w,h,r){c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);
    c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath();}
  function panel(c,x,y,w,h,a){c.globalAlpha=a;c.fillStyle="rgba(16,20,25,0.86)";rr(c,x,y,w,h,16);c.fill();
    c.strokeStyle="rgba(60,72,84,0.9)";c.lineWidth=1.5;rr(c,x,y,w,h,16);c.stroke();c.globalAlpha=1;}

  function drawScene(m,d,imgs){
    var c=ctx,W=m.W,H=m.H,i;
    c.fillStyle=C.bg; c.fillRect(0,0,W,H);
    // faint whole route
    var seg=[]; for(i=0;i<m.p.length;i++) seg.push(m.proj(m.p[i]));
    c.lineJoin="round"; c.lineCap="round";
    c.strokeStyle="rgba(224,147,47,0.14)"; c.lineWidth=W*0.006;
    c.beginPath(); for(i=0;i<seg.length;i++){var pt=seg[i]; if(i)c.lineTo(pt[0],pt[1]);else c.moveTo(pt[0],pt[1]);} c.stroke();
    // travelled portion, glowing
    var hp=m.proj(at(m,d));
    c.save(); c.shadowColor=C.prim; c.shadowBlur=W*0.02;
    c.strokeStyle=C.prim; c.lineWidth=W*0.0075; c.beginPath();
    var started=false;
    for(i=0;i<m.p.length;i++){ if(m.cum[i]>d) break; var q=seg[i];
      if(started)c.lineTo(q[0],q[1]); else {c.moveTo(q[0],q[1]);started=true;} }
    if(started) c.lineTo(hp[0],hp[1]); else { c.moveTo(seg[0][0],seg[0][1]); }
    c.stroke(); c.restore();
    // start dot
    c.fillStyle=C.ok; c.beginPath(); c.arc(seg[0][0],seg[0][1],W*0.009,0,7); c.fill();
    // comet head
    c.save(); c.shadowColor=C.prim2; c.shadowBlur=W*0.035;
    c.fillStyle="rgba(224,147,47,0.28)"; c.beginPath(); c.arc(hp[0],hp[1],W*0.022,0,7); c.fill();
    c.fillStyle=C.prim2; c.beginPath(); c.arc(hp[0],hp[1],W*0.011,0,7); c.fill(); c.restore();
    // stat bar
    var head=at(m,d), el=(head.t-m.p[0].t)/1000;
    panel(c,W*0.04,W*0.04,W*0.92,W*0.12,1);
    stat(c,W*0.075,W*0.115,"DISTANCE",fmtDist(d),"l",W);
    stat(c,W/2,W*0.115,"TIME",fmtDur(el),"c",W);
    stat(c,W*0.925,W*0.115,"ELEV",Math.round(head.alt)+" m","r",W);
    // elevation strip
    elev(c,m,d,W*0.04,H-W*0.20,W*0.92,W*0.15);
    // featured annotation
    var feat=null,bg=1e18; for(i=0;i<m.annD.length;i++){var g=Math.abs(m.annD[i].dist-d); if(g<bg){bg=g;feat=m.annD[i];}}
    if(feat){ var near=bg<=Math.max(60,m.total*0.03);
      var fade=Math.max(0,Math.min(1,1-(bg)/Math.max(80,m.total*0.05)));
      card(c,m,feat,near,0.35+0.65*fade,imgs,W,H); }
    // watermark + vignette
    c.fillStyle=C.t3; c.textAlign="left"; c.font="700 "+(W*0.024)+"px "+C.sans;
    c.fillText("PERUN", W*0.045, H-W*0.205);
    c.textAlign="right"; c.fillStyle=C.t2; c.font="600 "+(W*0.02)+"px "+C.sans;
    c.fillText(m.name, W*0.955, H-W*0.205); c.textAlign="left";
    vignette(c,W,H);
  }
  function stat(c,cx,by,k,v,al,W){c.textAlign=al==="l"?"left":al==="r"?"right":"center";
    c.fillStyle=C.t3;c.font="600 "+(W*0.02)+"px "+C.sans;c.fillText(k,cx,by-W*0.035);
    c.fillStyle=C.text;c.font="800 "+(W*0.048)+"px "+C.sans;c.fillText(v,cx,by+W*0.01);c.textAlign="left";}
  function elev(c,m,d,x,y,w,h){panel(c,x,y,w,h,1);var pad=w*0.02,spanA=Math.max(1,m.maxA-m.minA),i;
    function X(dd){return x+pad+(dd/m.total)*(w-2*pad);} function Y(a){return y+h-pad-((a-m.minA)/spanA)*(h-2*pad);}
    c.beginPath();c.moveTo(X(0),y+h-pad);
    for(i=0;i<m.p.length;i++)c.lineTo(X(m.cum[i]),Y(m.p[i].alt||0)); c.lineTo(X(m.total),y+h-pad);c.closePath();
    c.fillStyle="rgba(224,147,47,0.15)";c.fill();
    c.beginPath(); for(i=0;i<m.p.length;i++){var xx=X(m.cum[i]),yy=Y(m.p[i].alt||0); if(i)c.lineTo(xx,yy);else c.moveTo(xx,yy);}
    c.strokeStyle=C.prim;c.lineWidth=w*0.004;c.stroke();
    var hx=X(Math.max(0,Math.min(m.total,d)));
    c.strokeStyle=C.text;c.globalAlpha=.85;c.lineWidth=w*0.0035;
    c.beginPath();c.moveTo(hx,y+pad);c.lineTo(hx,y+h-pad);c.stroke();c.globalAlpha=1;}
  function card(c,m,a,near,alpha,imgs,W,H){
    var w=W*0.52,x=W-w-W*0.045,y=W*0.2,im=a.kind==="photo"&&imgs[a.text]&&imgs[a.text].complete?imgs[a.text]:null;
    var h=im?W*0.42:W*0.15;
    panel(c,x,y,w,h,near?1:alpha);
    c.fillStyle=a.kind==="photo"?C.photo:a.kind==="voice"?C.voice:C.prim;
    c.font="700 "+(W*0.03)+"px "+C.sans; c.fillText(KIND[a.kind]||"\\u2022",x+W*0.02,y+W*0.045);
    c.fillStyle=C.t2; c.font="600 "+(W*0.02)+"px "+C.sans;
    c.fillText(near?"\\u25CF at this point":fmtDist(a.dist),x+W*0.06,y+W*0.043);
    if(im){var iw=w-W*0.04,ih=W*0.24,ix=x+W*0.02,iy=y+W*0.06;
      rr(c,ix,iy,iw,ih,10);c.save();c.clip();
      var ar=im.width/im.height,tr=iw/ih,dw,dh; if(ar>tr){dh=ih;dw=ih*ar;}else{dw=iw;dh=iw/ar;}
      c.drawImage(im,ix+(iw-dw)/2,iy+(ih-dh)/2,dw,dh);c.restore();}
    if(a.text){c.fillStyle=C.text;c.font="500 "+(W*0.026)+"px "+C.sans;
      wrap(c,a.text,x+W*0.02,y+(im?W*0.34:W*0.095),w-W*0.04,W*0.032);}
  }
  function wrap(c,text,x,y,maxw,lh){var words=String(text).split(" "),line="",yy=y,i;
    for(i=0;i<words.length;i++){var t=line?line+" "+words[i]:words[i];
      if(c.measureText(t).width>maxw&&line){c.fillText(line,x,yy);line=words[i];yy+=lh;}else line=t;}
    if(line)c.fillText(line,x,yy);}
  function vignette(c,W,H){var g=c.createRadialGradient(W/2,H/2,W*0.35,W/2,H/2,W*0.72);
    g.addColorStop(0,"rgba(0,0,0,0)");g.addColorStop(1,"rgba(0,0,0,0.45)");
    c.fillStyle=g;c.fillRect(0,0,W,H);}

  function titleCard(m,alpha){var c=ctx,W=m.W,H=m.H; c.fillStyle=C.bg;c.fillRect(0,0,W,H);
    c.globalAlpha=alpha; c.textAlign="center";
    c.fillStyle=C.prim;c.font="800 "+(W*0.03)+"px "+C.sans;c.fillText("PERUN",W/2,H*0.42);
    c.fillStyle=C.text;c.font="800 "+(W*0.06)+"px "+C.sans;c.fillText(m.name,W/2,H*0.5);
    c.fillStyle=C.t2;c.font="500 "+(W*0.028)+"px "+C.sans;
    c.fillText(fmtDist(m.total)+"  \\u00B7  "+fmtDur(m.dur/1000),W/2,H*0.56);
    c.textAlign="left"; c.globalAlpha=1; vignette(c,W,H);}
  function outroCard(m,alpha){var c=ctx,W=m.W,H=m.H; drawScene(m,m.total,{}); // route full behind
    c.fillStyle="rgba(7,9,11,"+(0.72*alpha)+")";c.fillRect(0,0,W,H);
    c.globalAlpha=alpha;c.textAlign="center";
    c.fillStyle=C.text;c.font="800 "+(W*0.05)+"px "+C.sans;c.fillText(m.name,W/2,H*0.4);
    var stats=[["Distance",fmtDist(m.total)],["Time",fmtDur(m.dur/1000)],["Elevation","+"+Math.round(m.gain)+" m"]];
    for(var i=0;i<stats.length;i++){var cx=W*(0.28+i*0.22);
      c.fillStyle=C.t3;c.font="600 "+(W*0.02)+"px "+C.sans;c.fillText(stats[i][0],cx,H*0.52);
      c.fillStyle=C.prim;c.font="800 "+(W*0.036)+"px "+C.sans;c.fillText(stats[i][1],cx,H*0.57);}
    c.fillStyle=C.t3;c.font="700 "+(W*0.024)+"px "+C.sans;c.fillText("PERUN",W/2,H*0.66);
    c.textAlign="left";c.globalAlpha=1;}

  function run(RUN){
    var m; try{ m=build(RUN); m.name=RUN.name||"Run"; }catch(e){ post({type:"error",msg:"build: "+e}); return; }
    // Await decode of the (already-created) annotation images, then record.
    var imgs=window.__imgs||{}, pend=[], k;
    for(k in imgs){ (function(im){ pend.push(new Promise(function(res){
      if(im.complete) return res(); im.onload=res; im.onerror=res; })); })(imgs[k]); }
    Promise.all(pend).then(function(){ record(m,RUN.opts); });
  }

  function record(m,opts){
    var imgs=window.__imgs||{};
    var stream=cv.captureStream(30);
    var mimes=["video/webm;codecs=vp8","video/webm;codecs=vp9","video/webm"];
    var mime=null,i; for(i=0;i<mimes.length;i++){ if(window.MediaRecorder&&MediaRecorder.isTypeSupported(mimes[i])){mime=mimes[i];break;} }
    if(!mime){ post({type:"error",msg:"MediaRecorder/WebM not supported"}); return; }
    var rec; try{ rec=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:opts.bitrate||5000000}); }
    catch(e){ post({type:"error",msg:"recorder: "+e}); return; }
    var chunks=[]; rec.ondataavailable=function(e){ if(e.data&&e.data.size) chunks.push(e.data); };
    rec.onstop=function(){ var blob=new Blob(chunks,{type:mime}); var fr=new FileReader();
      fr.onloadend=function(){ post({type:"done",dataUrl:fr.result}); };
      fr.onerror=function(){ post({type:"error",msg:"read blob failed"}); }; fr.readAsDataURL(blob); };

    var INTRO=0.9, DRAW=opts.durationS||12, OUTRO=2.2, TOTAL=INTRO+DRAW+OUTRO;
    var t0=null, lastP=-1;
    function post0(p){ p=Math.max(0,Math.min(1,p)); if(p-lastP>=0.02){lastP=p; post({type:"progress",p:p});} }
    rec.start();
    function frame(now){
      if(t0===null)t0=now; var el=(now-t0)/1000;
      post0(el/TOTAL);
      if(el<INTRO){ titleCard(m, Math.max(0,Math.min(1,el/0.3,(INTRO-el)/0.3))); }
      else if(el<INTRO+DRAW){ var u=(el-INTRO)/DRAW; drawScene(m, m.total*ease(u), imgs); }
      else if(el<TOTAL){ var v=(el-INTRO-DRAW)/OUTRO; outroCard(m, Math.min(1,v/0.5)); }
      else { drawScene(m,m.total,imgs); try{rec.stop();}catch(e){} return; }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // Entry point; RN injects window.__setRun(<json>) after receiving "ready".
  window.__setRun=function(json){ try{ var RUN=(typeof json==="string")?JSON.parse(json):json;
    var imgs={}; (RUN.annotations||[]).forEach(function(a){ if(a.img){var im=new Image();im.src=a.img;imgs[a.text]=im;} });
    window.__imgs=imgs; run(RUN); }catch(e){ post({type:"error",msg:"setRun: "+e}); } };
  post({type:"ready"});
})();
</script>
</body></html>`;
}
