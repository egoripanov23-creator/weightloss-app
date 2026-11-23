/* ENHANCE v2 — ultra-smooth UI, 3D dish viewer, cooking "video" player */
(function(){
  'use strict';
  document.body.classList.add('v2');

  var C = {
    green:0x9be15d, lime:0x4ade80, red:0xff6b6b, yellow:0xffd166,
    brown:0xb07a4a, white:0xf5f5f0, purple:0xa78bfa, teal:0x7cf7d0
  };

  /* ---------- 3D dish viewer ---------- */
  var viewer = { renderer:null, scene:null, camera:null, group:null, sceneLights:[], raf:null, drag:false, px:0, zoom:0 };
  function closeViewer(){
    if(!viewer.raf)return;
    cancelAnimationFrame(viewer.raf); viewer.raf=null;
    if(viewer.group)viewer.scene?.clear?.();
    viewer.sceneLights.forEach(l=>{l.geometry?.dispose?.();l.material?.dispose?.();l.position&&null});
    viewer.sceneLights.length=0;
    if(viewer.renderer){viewer.renderer.clear(true,true,true);viewer.renderer.dispose();if(viewer.renderer.forceContextLoss)viewer.renderer.forceContextLoss();}
    viewer.renderer=null; viewer.scene=null; viewer.camera=null; viewer.group=null;
  }
  document.addEventListener('visibilitychange', function(){ if(document.hidden) closeViewer(); });

  function dishColor(name){
    var n=(name||'').toLowerCase();
    if(/борщ|помидор|томат|красн/.test(n)) return [C.red,C.yellow];
    if(/рыб|лосос|кревет/.test(n)) return [0xffa8a8,0xffc0cb];
    if(/куриц|грудк|индей|говяд|свин/.test(n)) return [C.brown,0xd9a066];
    if(/гречк|рис|каш|овсян|макар|паст/.test(n)) return [0xe6d3a6,0xd2b878];
    if(/овощ|салат|броккол|огурец/.test(n)) return [C.green,C.lime];
    if(/творог|йогурт|молок/.test(n)) return [0xffffff,0xe8f0ff];
    if(/ягод|черник|клубник|малин/.test(n)) return [C.purple,0xec4899];
    return [C.green,C.lime];
  }

  function buildDish(name){
    var g = new THREE.Group();
    var cols = dishColor(name);

    // ceramic plate
    var plate = new THREE.Mesh(
      new THREE.CylinderGeometry(2.5,2.25,0.16,64),
      new THREE.MeshStandardMaterial({color:0xf8fbff,roughness:.35,metalness:.05})
    );
    plate.position.y=-0.25; plate.receiveShadow=true; g.add(plate);
    var rim = new THREE.Mesh(
      new THREE.TorusGeometry(2.42,0.09,16,64),
      new THREE.MeshStandardMaterial({color:0xdfe8ff,roughness:.3})
    );
    rim.rotation.x=Math.PI/2; rim.position.y=-0.16; g.add(rim);

    // food mound — clustered spheres look like a real portion
    var foodMat = new THREE.MeshStandardMaterial({color:cols[0],roughness:.7,metalness:.02});
    var foodMat2 = new THREE.MeshStandardMaterial({color:cols[1],roughness:.75});
    for(var i=0;i<16;i++){
      var a=i/16*Math.PI*2, r=0.5+Math.random()*1.1;
      var s=new THREE.Mesh(new THREE.SphereGeometry(0.32+Math.random()*0.22,14,12), i%3?foodMat:foodMat2);
      s.position.set(Math.cos(a)*r, 0.08+Math.random()*0.42, Math.sin(a)*r);
      s.castShadow=true; s.receiveShadow=true; g.add(s);
    }
    // garnish
    for(var j=0;j<6;j++){
      var ang=j/6*Math.PI*2;
      var leaf=new THREE.Mesh(new THREE.SphereGeometry(0.13,10,8),new THREE.MeshStandardMaterial({color:C.green,roughness:.8}));
      leaf.scale.set(1,.4,1.6);
      leaf.position.set(Math.cos(ang)*1.5,0.5,Math.sin(ang)*1.5);
      g.add(leaf);
    }
    return g;
  }

  function open3D(name){
    try{
      closeViewer();
      var wrap=document.getElementById('v2-modal');
      wrap.classList.remove('hidden');
      document.getElementById('v2-modal-title').textContent='🥘 '+name;
      document.getElementById('v2-modal-sub').textContent='3D-модель блюда — покрутите, чтобы рассмотреть со всех сторон';
      var body=document.getElementById('v2-modal-body');
      body.innerHTML='<div class="v2-canvas-wrap"><canvas id="dish-canvas"></canvas><div class="v2-hint">🖐 Потяните, чтобы вращать · колёсико — приблизить</div></div>'+
        '<div class="v2-modal__info"><h3>'+esc(name)+'</h3><p>Реалистичная 3D-визуализация порции. Вращайте модель пальцем или мышью.</p></div>';
      var canvas=document.getElementById('dish-canvas');
      var H=Math.max(160,Math.round(wrap.getBoundingClientRect().height));
      var renderer=new THREE.WebGLRenderer({canvas:canvas,antialias:true,alpha:true});
      renderer.setClearColor('#070b14',1);
      renderer.setPixelRatio(Math.min(devicePixelRatio,2));
      renderer.setSize(H*1.7,H,false);
      renderer.shadowMap.enabled=true;
      var scene=new THREE.Scene();
      var cam=new THREE.PerspectiveCamera(36,1.7,0.1,100);
      cam.position.set(0,4.8,7.8); cam.lookAt(0,0,0);
      scene.add(new THREE.AmbientLight(0xffffff,.78));
      var key=new THREE.DirectionalLight(0xffffff,1.8); key.position.set(4,10,6); key.castShadow=true; scene.add(key);
      var fill=new THREE.DirectionalLight(0x7cf7d0,.8); fill.position.set(-5,3,-4); scene.add(fill);
      var group=buildDish(name); scene.add(group);
      viewer={renderer:renderer,scene:scene,camera:cam,group:group,sceneLights:[key,fill],raf:null,drag:false,px:0,zoom:0};
      var rot=0.35;
      function loop(){
        viewer.raf=requestAnimationFrame(loop);
        if(!viewer.drag)rot+=0.0026;
        group.rotation.y=rot;
        renderer.render(scene,cam);
      }
      loop();
      canvas.addEventListener('pointerdown',function(e){viewer.drag=true;viewer.px=e.clientX;canvas.setPointerCapture(e.pointerId);e.preventDefault();});
      canvas.addEventListener('pointermove',function(e){if(!viewer.drag)return;rot+=(e.clientX-viewer.px)*0.012;viewer.px=e.clientX;e.preventDefault();});
      canvas.addEventListener('pointerup',function(e){viewer.drag=false;canvas.releasePointerCapture(e.pointerId);});
      canvas.addEventListener('pointercancel',function(){viewer.drag=false;});
      canvas.addEventListener('wheel',function(e){e.preventDefault();viewer.zoom=Math.max(-1.2,Math.min(4,viewer.zoom+(e.deltaY>0?-.3:.3)));cam.position.set(0,3+viewer.zoom*.85,5.3+viewer.zoom*.75);cam.updateProjectionMatrix();},{passive:false});
      window.addEventListener('resize',function(){if(!viewer.renderer)return;var h=Math.max(160,Math.round(wrap.getBoundingClientRect().height));viewer.renderer.setSize(h*1.7,h,false);viewer.camera.aspect=1.7;viewer.camera.updateProjectionMatrix();});
    }catch(e){
      var body=document.getElementById('v2-modal-body');
      if(body)body.innerHTML='<div class="v2-modal__info"><h3>'+esc(name)+'</h3><p>3D просмотр недоступен</p></div>';
    }
  }

  /* ---------- Cooking "video" — procedural animated canvas film ---------- */
  var player={timer:null,raf:null,step:0,steps:[],playing:false,dur:4200,start:0,t:0,ctx:null,cols:[C.green,C.lime],fps60:true,progressSmooth:true};

  function parseSteps(recipe){
    var raw=String(recipe||'').split(/\n+/).map(function(s){return s.trim();}).filter(Boolean);
    var steps=[];
    raw.forEach(function(s){
      var clean=s.replace(/^[\d\.\)\s]+/,'').replace(/^[^\p{L}\p{N}]+/u,'').trim();
      if(/^(время|ингредиенты|совет)\b/i.test(clean)) return;
      if(clean) steps.push(clean.replace(/^\d+[\.\)]\s*/,'').trim());
    });
    if(!steps.length) steps=['Подготовьте ингредиенты','Приготовьте блюдо','Подавайте'];
    return steps;
  }

  function drawKitchen(ctx,W,H,t,step,total,cols){
    var cx=W/2, cy=H*0.62;
    ctx.clearRect(0,0,W,H);
    // backdrop gradient
    var bg=ctx.createLinearGradient(0,0,0,H);
    bg.addColorStop(0,'#111a30'); bg.addColorStop(1,'#0a0d1c');
    ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
    // soft spotlight
    var glow=ctx.createRadialGradient(cx,cy-40,10,cx,cy-40,180);
    glow.addColorStop(0,'rgba(124,247,208,.14)'); glow.addColorStop(1,'rgba(124,247,208,0)');
    ctx.fillStyle=glow; ctx.fillRect(0,0,W,H);

    var phase=(t%player.dur)/player.dur; // 0..1 within step
    var cooking=step<total-1;

    // steam particles
    if(cooking){
      for(var i=0;i<7;i++){
        var st=(phase*1.6+i/7)%1;
        var sx=cx+Math.sin(i*2.3+phase*6)*26;
        var sy=cy-60-st*110;
        ctx.globalAlpha=(1-st)*.35;
        ctx.fillStyle='#dff';
        ctx.beginPath(); ctx.arc(sx,sy,10+st*14,0,Math.PI*2); ctx.fill();
      }
      ctx.globalAlpha=1;
    }

    // pan / pot
    var panW=120,panH=44;
    ctx.fillStyle='#2b3350';
    ctx.beginPath(); ctx.ellipse(cx,cy,panW,panH*.5,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#3a4568';
    ctx.fillRect(cx-panW,cy-8,panW*2,26);
    ctx.strokeStyle='#59668f';ctx.lineWidth=3;
    ctx.beginPath();ctx.moveTo(cx+panW,cy);ctx.lineTo(cx+panW+50,cy-16);ctx.stroke();

    // food pieces bouncing with motion
    var n=10;
    for(var j=0;j<n;j++){
      var ang=j/n*Math.PI*2 + t*0.0016;
      var rr=26+Math.sin(j*1.7+t*0.004)*16;
      var fx=cx+Math.cos(ang)*rr;
      var fy=cy-6+Math.sin(ang*1.3+t*0.005)*12;
      ctx.fillStyle= j%3? '#'+cols[0].toString(16).padStart(6,'0') : '#'+cols[1].toString(16).padStart(6,'0');
      ctx.beginPath();ctx.ellipse(fx,fy,12,9,ang,0,Math.PI*2);ctx.fill();
    }
    // flame under pan
    if(cooking){
      for(var f=0;f<5;f++){
        var fh=18+Math.sin(t*0.01+f)*10;
        ctx.fillStyle='rgba(255,150,60,'+(0.5-f*0.07)+')';
        ctx.beginPath();ctx.ellipse(cx-40+f*20,cy+30,fh*.4,fh,0,0,Math.PI*2);ctx.fill();
      }
    }

    // final plate beat
    if(step===total-1){
      ctx.fillStyle='#f8fbff';
      ctx.beginPath();ctx.ellipse(cx,cy+10,96,34,0,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#'+cols[0].toString(16).padStart(6,'0');
      ctx.beginPath();ctx.ellipse(cx,cy+6,60,20,0,0,Math.PI*2);ctx.fill();
      ctx.globalAlpha=.9;ctx.fillStyle='#fff';ctx.font='bold 16px sans-serif';ctx.textAlign='center';
      ctx.fillText('✅ ГОТОВО',cx,cy-70);ctx.globalAlpha=1;
    }
    // step badge
    ctx.fillStyle='rgba(0,0,0,.45)';ctx.fillRect(0,0,W,34);
    ctx.fillStyle='#7cf7d0';ctx.font='bold 13px sans-serif';ctx.textAlign='left';
    ctx.fillText('ШАГ '+(step+1)+' / '+total,14,22);
    // REC dot
    if(player.playing){ctx.fillStyle='#ff5b6e';ctx.beginPath();ctx.arc(W-18,17,5,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff';ctx.font='11px sans-serif';ctx.fillText('REC',W-52,21);}
  }

  function filmLoop(ts){
    if(!player.playing)return;
    if(!player.start)player.start=ts;
    player.t=ts-player.start;
    if(player.t>=player.dur){
      player.start=ts;
      if(player.step>=player.steps.length-1){togglePlay();return;}
      showStep(player.step+1);
    }
    var fill=document.getElementById('v2-fill');
    if(fill)fill.style.width=((player.step+Math.min(player.t/player.dur,1))/player.steps.length*100)+'%';
    var c=document.getElementById('film-canvas');
    if(c&&player.ctx)drawKitchen(player.ctx,c.width,c.height,player.t,player.step,player.steps.length,player.cols);
    player.raf=requestAnimationFrame(filmLoop);
  }

  function openVideo(name,recipe){
    var wrap=document.getElementById('v2-modal');wrap.classList.remove('hidden');
    document.getElementById('v2-modal-title').textContent='🎬 '+name;
    document.getElementById('v2-modal-sub').textContent='Видео-инструкция · пошаговое приготовление';
    player.steps=parseSteps(recipe);player.step=0;player.playing=false;player.cols=dishColor(name);
    var body=document.getElementById('v2-modal-body');
    body.innerHTML=
      '<div class="v2-player" style="padding:0"><canvas id="film-canvas" width="520" height="330" style="width:100%;height:330px;display:block;border-radius:22px 22px 0 0"></canvas></div>'+
      '<div class="v2-step-text" id="v2-step-text"></div>'+
      '<div class="v2-controls"><button class="v2-play" id="v2-play">▶</button>'+
      '<div class="v2-progress"><div class="v2-progress__bar" id="v2-bar"><div class="v2-progress__fill" id="v2-fill"></div></div>'+
      '<div class="v2-progress__meta"><span id="v2-step-now">Шаг 1</span><span id="v2-step-count">из '+player.steps.length+'</span></div></div></div>';
    var c=document.getElementById('film-canvas');player.ctx=c.getContext('2d');
    var W=Math.min(520,Math.max(220,Math.round(c.clientWidth||520)));
    var H=Math.min(330,Math.max(150,Math.round(c.clientHeight||330)));
    c.width=Math.round(W*(window.devicePixelRatio||1));c.height=Math.round(H*(window.devicePixelRatio||1));
    player.ctx.scale(window.devicePixelRatio||1,window.devicePixelRatio||1);
    drawKitchen(player.ctx,W,H,0,0,player.steps.length,player.cols);
    showStep(0);
    document.getElementById('v2-play').addEventListener('click',togglePlay);
    document.getElementById('v2-bar').addEventListener('click',function(e){
      var r=this.getBoundingClientRect();
      var i=Math.floor((e.clientX-r.left)/r.width*player.steps.length);
      showStep(Math.max(0,Math.min(player.steps.length-1,i)));
    });
  }

  function showStep(i){
    player.step=i;player.start=0;player.t=0;
    var t=document.getElementById('v2-step-text');if(t)t.textContent=player.steps[i]||'';
    var n=document.getElementById('v2-step-now');if(n)n.textContent='Шаг '+(i+1);
    var f=document.getElementById('v2-fill');if(f)f.style.width=((i+1)/player.steps.length*100)+'%';
    var c=document.getElementById('film-canvas');
    if(c&&player.ctx)drawKitchen(player.ctx,c.width,c.height,0,i,player.steps.length,player.cols);
  }
  function togglePlay(){
    var replay=!player.playing&&player.step>=player.steps.length-1&&player.t>=player.dur;
    player.playing=!player.playing;
    if(player.playing&&replay)showStep(0);
    var b=document.getElementById('v2-play');if(b)b.textContent=player.playing?'⏸':'▶';
    if(player.timer)clearInterval(player.timer);
    if(player.raf)cancelAnimationFrame(player.raf);
    if(player.playing){player.start=0;player.raf=requestAnimationFrame(filmLoop);}
  }

  /* ---------- modal shell ---------- */
  function ensureModal(){
    if(document.getElementById('v2-modal'))return;
    var m=document.createElement('div'); m.id='v2-modal'; m.className='v2-modal hidden';
    m.innerHTML='<div class="v2-modal__card">'+
      '<button class="v2-modal__close" id="v2-modal-close">✕</button>'+
      '<div class="v2-modal__title" id="v2-modal-title"></div>'+
      '<div class="v2-modal__sub" id="v2-modal-sub" style="position:absolute;top:44px;left:20px;z-index:3;font-size:.68rem;color:var(--v2-muted)"></div>'+
      '<div id="v2-modal-body"></div></div>';
    document.body.appendChild(m);
    m.addEventListener('click',function(e){if(e.target===m)closeModal();});
    document.getElementById('v2-modal-close').addEventListener('click',closeModal);
  }
  function closeModal(){
    var m=document.getElementById('v2-modal'); if(m)m.classList.add('hidden');
    closeViewer();
    if(player.timer){clearInterval(player.timer);player.timer=null;}
    if(player.raf){cancelAnimationFrame(player.raf);player.raf=null;}
    player.playing=false;
    player.ctx=null;
    var closeBtn=document.getElementById('v2-modal-close'); if(closeBtn&&m&&m.getBoundingClientRect().width)closeBtn.focus();
  }
  document.addEventListener('keydown',function(e){if(e.key==='Escape')closeModal();});

  function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}

  /* ---------- inject enhanced widgets into meal cards ---------- */
  function enhanceCards(){
    document.querySelectorAll('.meal-card').forEach(function(card){
      if(card.dataset.v2)return; card.dataset.v2='1';
      var recipeEl=card.querySelector('.recipe-detail')||card.querySelector('.meal-card__recipe-text');
      var recipe=recipeEl?recipeEl.textContent:'';
      var nameEl=card.querySelector('.meal-card__item-name');
      var name=nameEl?nameEl.textContent:'Блюдо';

      // macro visualization bars
      var macros=card.querySelector('.meal-card__macros');
      if(macros){
        var html='<div class="v2-macros">';
        macros.querySelectorAll('span').forEach(function(sp){
          var txt=sp.textContent.trim();
          var num=parseInt(txt.replace(/[^\d]/g,''),10)||0;
          var pct=Math.min(100,Math.round(num/1.2));
          html+='<div class="v2-macro" style="--pct:'+pct+'%">'+esc(txt.replace(/\d+/g,''))+' <b>'+num+'г</b></div>';
        });
        html+='</div>';
        macros.insertAdjacentHTML('afterend',html);
        macros.style.display='none';
      }

      // action chips
      var acts=document.createElement('div'); acts.className='v2-actions';
      acts.innerHTML='<button type="button" class="v2-chip" data-act="3d" aria-label="3D модель блюда">🧊 3D модель</button>'+
        '<button type="button" class="v2-chip v2-chip--vid" data-act="video" aria-label="Видео-инструкция приготовления">🎬 Как готовить</button>';
      card.appendChild(acts);
      acts.querySelector('[data-act="3d"]').addEventListener('click',function(){
        ensureModal(); open3D(name);
      });
      acts.querySelector('[data-act="video"]').addEventListener('click',function(){
        ensureModal(); openVideo(name,recipe);
      });
    });
  }

  // Hook into app.js render (function declaration is global)
  var original=null;
  function hook(){
    if(typeof window.renderMealPlan!=='function'){return false;}
    original=window.renderMealPlan;
    window.renderMealPlan=function(){
      var r=original.apply(this,arguments);
      setTimeout(enhanceCards,30);
      return r;
    };
    return true;
  }
  if(!hook()){
    var iv=setInterval(function(){if(hook())clearInterval(iv);},100);
  }
  document.addEventListener('DOMContentLoaded',function(){ensureModal();setTimeout(enhanceCards,200);});
})();
