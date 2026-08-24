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
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}canvas{display:block;width:100%;height:100%}</style>
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
    var W=run.opts.width||run.opts.size||900, H=run.opts.height||run.opts.size||900; cv.width=W; cv.height=H;
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
      return {kind:a.kind,text:a.text,img:a.img,audio:a.audio,dur:a.dur,dist:cum[bi]};});
    var minA=1e9,maxA=-1e9,gain=0;
    for(i=0;i<p.length;i++){var al=p[i].alt||0; if(al<minA)minA=al; if(al>maxA)maxA=al;
      if(i>0){var dd=(p[i].alt||0)-(p[i-1].alt||0); if(dd>0)gain+=dd;}}
    return {p:p,cum:cum,total:total,proj:proj,annD:annD,minA:minA,maxA:maxA,gain:gain,W:W,H:H,U:Math.min(W,H),dur:run.points[p.length-1].t-run.points[0].t};
  }
  function at(m,d){var p=m.p,cum=m.cum; d=Math.max(0,Math.min(m.total,d));
    var i=0; while(i<cum.length-1 && cum[i+1]<d) i++;
    var a=p[i], b=p[Math.min(i+1,p.length-1)];
    var seg=cum[Math.min(i+1,cum.length-1)]-cum[i], f=seg>0?(d-cum[i])/seg:0;
    function L(x,y){return x+(y-x)*f;}
    return {lat:L(a.lat,b.lat),lon:L(a.lon,b.lon),alt:L(a.alt,b.alt),t:L(a.t,b.t)};}

  // Smooth speed curve → time-vs-distance table. The playhead cruises between annotations
  // and DECELERATES into / crawls through / ACCELERATES out of each (never stops), giving
  // enough time to read/listen without the abrupt hard-stop. Each annotation is allotted a
  // "read budget" (seconds) spread as extra time over a raised-cosine window around it
  // (voice gets its full length). travelS = base cruise time for the whole route.
  function buildSchedule(m,opts){
    var K=1200, total=m.total, step=total/K, k, j;
    var travelS=opts.travelS||12, readS=opts.readS||3;
    var infos=m.annD.map(function(a){
      var R=(a.kind==="voice"&&a.dur)?Math.max(readS,a.dur+0.8):readS;
      var HW=Math.min(total*0.20,Math.max(40,total*0.10));
      return {d:a.dist,R:R,HW:HW,W:0};
    });
    for(j=0;j<infos.length;j++){ var inf=infos[j],sum=0;
      for(k=0;k<K;k++){ var dd=Math.abs((k+0.5)*step-inf.d); if(dd<inf.HW) sum+=0.5*(1+Math.cos(Math.PI*dd/inf.HW)); }
      inf.W=sum||1; }
    var T=new Array(K+1); T[0]=0;
    for(k=0;k<K;k++){ var dmid=(k+0.5)*step, extra=0;
      for(j=0;j<infos.length;j++){ var f=infos[j],e=Math.abs(dmid-f.d);
        if(e<f.HW) extra+=f.R*(0.5*(1+Math.cos(Math.PI*e/f.HW))/f.W); }
      T[k+1]=T[k]+travelS/K+extra; }
    return {T:T,K:K,step:step,dist:total,time:T[K]};
  }
  function distAtTime(s,t){
    if(t<=0)return 0; if(t>=s.time)return s.dist;
    var lo=0,hi=s.K; while(lo<hi){ var mid=(lo+hi)>>1; if(s.T[mid]<=t)lo=mid+1; else hi=mid; }
    var k=lo-1, tau=s.T[k+1]-s.T[k], f=tau>0?(t-s.T[k])/tau:0;
    return Math.min(s.dist,(k+f)*s.step);
  }

  function rr(c,x,y,w,h,r){c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);
    c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath();}
  function panel(c,x,y,w,h,a){c.globalAlpha=a;c.fillStyle="rgba(16,20,25,0.86)";rr(c,x,y,w,h,16);c.fill();
    c.strokeStyle="rgba(60,72,84,0.9)";c.lineWidth=1.5;rr(c,x,y,w,h,16);c.stroke();c.globalAlpha=1;}

  function drawScene(m,d,imgs){
    var c=ctx,W=m.W,H=m.H,U=m.U,i;
    c.fillStyle=C.bg; c.fillRect(0,0,W,H);
    var seg=[]; for(i=0;i<m.p.length;i++) seg.push(m.proj(m.p[i]));
    c.lineJoin="round"; c.lineCap="round";
    c.strokeStyle="rgba(224,147,47,0.14)"; c.lineWidth=U*0.006;
    c.beginPath(); for(i=0;i<seg.length;i++){var pt=seg[i]; if(i)c.lineTo(pt[0],pt[1]);else c.moveTo(pt[0],pt[1]);} c.stroke();
    var hp=m.proj(at(m,d));
    c.save(); c.shadowColor=C.prim; c.shadowBlur=U*0.02;
    c.strokeStyle=C.prim; c.lineWidth=U*0.0075; c.beginPath();
    var started=false;
    for(i=0;i<m.p.length;i++){ if(m.cum[i]>d) break; var q=seg[i];
      if(started)c.lineTo(q[0],q[1]); else {c.moveTo(q[0],q[1]);started=true;} }
    if(started) c.lineTo(hp[0],hp[1]); else { c.moveTo(seg[0][0],seg[0][1]); }
    c.stroke(); c.restore();
    c.fillStyle=C.ok; c.beginPath(); c.arc(seg[0][0],seg[0][1],U*0.009,0,7); c.fill();
    c.save(); c.shadowColor=C.prim2; c.shadowBlur=U*0.035;
    c.fillStyle="rgba(224,147,47,0.28)"; c.beginPath(); c.arc(hp[0],hp[1],U*0.022,0,7); c.fill();
    c.fillStyle=C.prim2; c.beginPath(); c.arc(hp[0],hp[1],U*0.011,0,7); c.fill(); c.restore();
    // stat bar (top) — width anchored to W, sizes to U
    var head=at(m,d), el=(head.t-m.p[0].t)/1000, barY=U*0.04, barH=U*0.13;
    panel(c,W*0.04,barY,W*0.92,barH,1);
    var sb=barY+barH*0.72;
    stat(c,W*0.075,sb,"DISTANCE",fmtDist(d),"l",U);
    stat(c,W/2,sb,"TIME",fmtDur(el),"c",U);
    stat(c,W*0.925,sb,"ELEV",Math.round(head.alt)+" m","r",U);
    // elevation strip (bottom)
    elev(c,m,d,W*0.04,H-U*0.20,W*0.92,U*0.14);
    // featured annotation card (right)
    var feat=null,bg=1e18; for(i=0;i<m.annD.length;i++){var g=Math.abs(m.annD[i].dist-d); if(g<bg){bg=g;feat=m.annD[i];}}
    if(feat){ var near=bg<=Math.max(60,m.total*0.03);
      var fade=Math.max(0,Math.min(1,1-(bg)/Math.max(80,m.total*0.05)));
      card(c,m,feat,near,0.35+0.65*fade,imgs); }
    // watermark (just above the elevation strip) + vignette
    c.fillStyle=C.t3; c.textAlign="left"; c.font="700 "+(U*0.024)+"px "+C.sans;
    c.fillText("PERUN", W*0.045, H-U*0.225);
    c.textAlign="right"; c.fillStyle=C.t2; c.font="600 "+(U*0.02)+"px "+C.sans;
    c.fillText(m.name, W*0.955, H-U*0.225); c.textAlign="left";
    vignette(c,W,H);
  }
  function stat(c,cx,by,k,v,al,U){c.textAlign=al==="l"?"left":al==="r"?"right":"center";
    c.fillStyle=C.t3;c.font="600 "+(U*0.02)+"px "+C.sans;c.fillText(k,cx,by-U*0.035);
    c.fillStyle=C.text;c.font="800 "+(U*0.046)+"px "+C.sans;c.fillText(v,cx,by+U*0.008);c.textAlign="left";}
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
  function card(c,m,a,near,alpha,imgs){
    var W=m.W,U=m.U;
    var im=a.kind==="photo"&&imgs[a.text]&&imgs[a.text].complete?imgs[a.text]:null;
    var w=Math.min(W*0.5,U*0.62), x=W-w-U*0.045, y=U*0.20, h=im?U*0.46:U*0.16;
    panel(c,x,y,w,h,near?1:alpha);
    c.fillStyle=a.kind==="photo"?C.photo:a.kind==="voice"?C.voice:C.prim;
    c.font="700 "+(U*0.03)+"px "+C.sans; c.fillText(KIND[a.kind]||"\\u2022",x+U*0.022,y+U*0.05);
    c.fillStyle=C.t2; c.font="600 "+(U*0.02)+"px "+C.sans;
    c.fillText(near?"\\u25CF at this point":fmtDist(a.dist),x+U*0.07,y+U*0.047);
    if(im){var iw=w-U*0.044,ih=U*0.26,ix=x+U*0.022,iy=y+U*0.066;
      rr(c,ix,iy,iw,ih,10);c.save();c.clip();
      var ar=im.width/im.height,tr=iw/ih,dw,dh; if(ar>tr){dh=ih;dw=ih*ar;}else{dw=iw;dh=iw/ar;}
      c.drawImage(im,ix+(iw-dw)/2,iy+(ih-dh)/2,dw,dh);c.restore();}
    if(a.text){c.fillStyle=C.text;c.font="500 "+(U*0.026)+"px "+C.sans;
      wrap(c,a.text,x+U*0.022,y+(im?U*0.37:U*0.10),w-U*0.044,U*0.034);}
  }
  function wrap(c,text,x,y,maxw,lh){var words=String(text).split(" "),line="",yy=y,i;
    for(i=0;i<words.length;i++){var t=line?line+" "+words[i]:words[i];
      if(c.measureText(t).width>maxw&&line){c.fillText(line,x,yy);line=words[i];yy+=lh;}else line=t;}
    if(line)c.fillText(line,x,yy);}
  function vignette(c,W,H){var R=Math.max(W,H); var g=c.createRadialGradient(W/2,H/2,R*0.32,W/2,H/2,R*0.62);
    g.addColorStop(0,"rgba(0,0,0,0)");g.addColorStop(1,"rgba(0,0,0,0.45)");
    c.fillStyle=g;c.fillRect(0,0,W,H);}

  function titleCard(m,alpha){var c=ctx,W=m.W,H=m.H,U=m.U; c.fillStyle=C.bg;c.fillRect(0,0,W,H);
    c.globalAlpha=alpha; c.textAlign="center";
    c.fillStyle=C.prim;c.font="800 "+(U*0.032)+"px "+C.sans;c.fillText("PERUN",W/2,H*0.42);
    c.fillStyle=C.text;c.font="800 "+(U*0.062)+"px "+C.sans;c.fillText(m.name,W/2,H*0.5);
    c.fillStyle=C.t2;c.font="500 "+(U*0.03)+"px "+C.sans;
    c.fillText(fmtDist(m.total)+"  \\u00B7  "+fmtDur(m.dur/1000),W/2,H*0.565);
    c.textAlign="left"; c.globalAlpha=1; vignette(c,W,H);}
  function outroCard(m,alpha){var c=ctx,W=m.W,H=m.H,U=m.U; drawScene(m,m.total,{}); // route full behind
    c.fillStyle="rgba(7,9,11,"+(0.72*alpha)+")";c.fillRect(0,0,W,H);
    c.globalAlpha=alpha;c.textAlign="center";
    c.fillStyle=C.text;c.font="800 "+(U*0.052)+"px "+C.sans;c.fillText(m.name,W/2,H*0.4);
    var stats=[["Distance",fmtDist(m.total)],["Time",fmtDur(m.dur/1000)],["Elevation","+"+Math.round(m.gain)+" m"]];
    for(var i=0;i<stats.length;i++){var cx=W*(0.28+i*0.22);
      c.fillStyle=C.t3;c.font="600 "+(U*0.02)+"px "+C.sans;c.fillText(stats[i][0],cx,H*0.52);
      c.fillStyle=C.prim;c.font="800 "+(U*0.038)+"px "+C.sans;c.fillText(stats[i][1],cx,H*0.57);}
    c.fillStyle=C.t3;c.font="700 "+(U*0.024)+"px "+C.sans;c.fillText("PERUN",W/2,H*0.66);
    c.textAlign="left";c.globalAlpha=1;}

  // PREP: build the model, preload images, decode voice audio, build the schedule, draw a
  // still first frame, then post "prepared" (with the estimated length). Does NOT record —
  // the user picks ratio/pace first and taps Start (window.__start).
  function prep(RUN){
    var m; try{ m=build(RUN); m.name=RUN.name||"Run"; }catch(e){ post({type:"error",msg:"build: "+e}); return; }
    var imgs=window.__imgs||{}, pend=[], k;
    for(k in imgs){ (function(im){ pend.push(new Promise(function(res){
      if(im.complete) return res(); im.onload=res; im.onerror=res; })); })(imgs[k]); }
    var audio=null;
    try{
      var AC=window.AudioContext||window.webkitAudioContext;
      var voices=m.annD.filter(function(a){return a.kind==="voice"&&a.audio;});
      if(AC && voices.length){
        var actx=new AC(); var dest=actx.createMediaStreamDestination(); var buffers={};
        audio={ctx:actx,dest:dest,buffers:buffers};
        voices.forEach(function(a){ pend.push(
          fetch(a.audio).then(function(r){return r.arrayBuffer();}).then(function(ab){
            return new Promise(function(res){ actx.decodeAudioData(ab,function(buf){buffers[a.dist]=buf;res();},function(){res();}); });
          }).catch(function(){}) ); });
      }
    }catch(e){ audio=null; }
    var sched=buildSchedule(m,RUN.opts);
    window.__ctx={m:m,opts:RUN.opts,audio:audio,imgs:imgs,sched:sched};
    var est=0.9+sched.time+2.4;
    Promise.all(pend).then(finish,finish);
    function finish(){ try{ drawScene(m,0,imgs); }catch(e){} post({type:"prepared",durationS:est}); }
  }

  window.__start=function(){ if(!window.__ctx){ post({type:"error",msg:"not prepared"}); return; } window.__cancelled=false; record(window.__ctx); };
  window.__cancel=function(){ window.__cancelled=true; };

  function record(ctx){
    var m=ctx.m,opts=ctx.opts,audio=ctx.audio,imgs=ctx.imgs,sched=ctx.sched,i;
    var tracks=cv.captureStream(30).getVideoTracks();
    var withAudio=!!(audio&&audio.dest);
    if(withAudio){ try{ if(audio.ctx.resume)audio.ctx.resume(); tracks=tracks.concat(audio.dest.stream.getAudioTracks()); }catch(e){ withAudio=false; } }
    var stream=new MediaStream(tracks);
    var mimes=withAudio?["video/webm;codecs=vp8,opus","video/webm;codecs=vp9,opus","video/webm"]
                       :["video/webm;codecs=vp8","video/webm;codecs=vp9","video/webm"];
    var mime=null; for(i=0;i<mimes.length;i++){ if(window.MediaRecorder&&MediaRecorder.isTypeSupported(mimes[i])){mime=mimes[i];break;} }
    if(!mime){ post({type:"error",msg:"MediaRecorder/WebM not supported"}); return; }
    var rec; try{ rec=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:opts.bitrate||4000000}); }
    catch(e){ post({type:"error",msg:"recorder: "+e}); return; }
    var chunks=[], aborted=false; rec.ondataavailable=function(e){ if(e.data&&e.data.size) chunks.push(e.data); };
    rec.onstop=function(){ if(aborted){ post({type:"cancelled"}); return; }
      var blob=new Blob(chunks,{type:mime}); var fr=new FileReader();
      fr.onloadend=function(){ post({type:"done",dataUrl:fr.result}); };
      fr.onerror=function(){ post({type:"error",msg:"read blob failed"}); }; fr.readAsDataURL(blob); };

    var INTRO=0.9, DRAW=sched.time, OUTRO=2.4, TOTAL=INTRO+DRAW+OUTRO;
    var t0=null, lastP=-1, played={};
    function post0(p){ p=Math.max(0,Math.min(1,p)); if(p-lastP>=0.02){lastP=p; post({type:"progress",p:p});} }
    rec.start();
    function frame(now){
      if(window.__cancelled){ aborted=true; try{rec.stop();}catch(e){} return; }
      if(t0===null)t0=now; var el=(now-t0)/1000; post0(el/TOTAL);
      if(el<INTRO){ titleCard(m, Math.max(0,Math.min(1,el/0.3,(INTRO-el)/0.3))); }
      else if(el<INTRO+DRAW){ var d=distAtTime(sched,el-INTRO); drawScene(m,d,imgs);
        if(withAudio){ var j; for(j=0;j<m.annD.length;j++){ var a=m.annD[j];
          // Fire as we ENTER the slow zone so a voice note plays through the crawl.
          if(a.kind==="voice"&&a.audio&&audio.buffers[a.dist]&&!played[a.dist]&&d>=a.dist-Math.min(m.total*0.06,120)){
            try{ var src=audio.ctx.createBufferSource(); src.buffer=audio.buffers[a.dist];
              src.connect(audio.dest); src.connect(audio.ctx.destination); src.start(); }catch(e){}
            played[a.dist]=true; } } } }
      else if(el<TOTAL){ var v=(el-INTRO-DRAW)/OUTRO; outroCard(m, Math.min(1,v/0.5)); }
      else { drawScene(m,m.total,imgs); try{rec.stop();}catch(e){} return; }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // Entry point; RN injects window.__setRun(<json>) after "ready", then window.__start().
  window.__setRun=function(json){ try{ var RUN=(typeof json==="string")?JSON.parse(json):json;
    var imgs={}; (RUN.annotations||[]).forEach(function(a){ if(a.img){var im=new Image();im.src=a.img;imgs[a.text]=im;} });
    window.__imgs=imgs; prep(RUN); }catch(e){ post({type:"error",msg:"setRun: "+e}); } };
  post({type:"ready"});
})();
</script>
</body></html>`;
}
