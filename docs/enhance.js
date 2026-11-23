/* ENHANCE v2 — ultra-smooth UI, 3D dish viewer, cooking "video" player */
(function(){
  'use strict';
  document.body.classList.add('v2');

  var C = {
    green:0x9be15d, lime:0x4ade80, red:0xff6b6b, yellow:0xffd166,
    brown:0xb07a4a, white:0xf5f5f0, purple:0xa78bfa, teal:0x7cf7d0
  };

  /* ---------- 3D dish viewer ---------- */
  var viewer = { renderer:null, scene:null, camera:null, group:null, raf:null, drag:false, px:0 };

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
    var wrap=document.getElementById('v2-modal');
    wrap.classList.remove('hidden');
    document.getElementById('v2-modal-title').textContent='🥘 '+name;
    document.getElementById('v2-modal-sub').textContent='3D-модель блюда — покрутите, чтобы рассмотреть со всех сторон';
    var body=document.getElementById('v2-modal-body');
    body.innerHTML='<div class="v2-canvas-wrap"><canvas id="dish-canvas"></canvas><div class="v2-hint">🖐 Потяните, чтобы вращать · автоматическое вращение</div></div>'+
      '<div class="v2-modal__info"><h3>'+esc(name)+'</h3><p>Реалистичная 3D-визуализация порции. Вращайте модель пальцем или мышью.</p></div>';

    var canvas=document.getElementById('dish-canvas');
    var W=canvas.clientWidth||400, H=330;
    var renderer=new THREE.WebGLRenderer({canvas:canvas,antialias:true,alpha:true});
    renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    renderer.setSize(W,H,false);
    renderer.shadowMap.enabled=true;
    var scene=new THREE.Scene();
    var cam=new THREE.PerspectiveCamera(38,W/H,.1,100);
    cam.position.set(0,4.2,7.5); cam.lookAt(0,0,0);
    scene.add(new THREE.AmbientLight(0xffffff,.75));
    var key=new THREE.DirectionalLight(0xffffff,1.5); key.position.set(4,8,5); key.castShadow=true; scene.add(key);
    var fill=new THREE.DirectionalLight(0x7cf7d0,.9); fill.position.set(-5,3,-4); scene.add(fill);
    var group=buildDish(name); scene.add(group);
    viewer={renderer:renderer,scene:scene,camera:cam,group:group,raf:null,drag:false,px:0,angle:0};

    var rot=0;
    function loop(){
      viewer.raf=requestAnimationFrame(loop);
      if(!viewer.drag) rot+=0.004;
      group.rotation.y=rot;
      renderer.render(scene,cam);
    }
    loop();

    canvas.addEventListener('pointerdown',function(e){viewer.drag=true;viewer.px=e.clientX;canvas.setPointerCapture(e.pointerId);});
    canvas.addEventListener('pointermove',function(e){
      if(!viewer.drag)return;
      rot+=(e.clientX-viewer.px)*0.012; viewer.px=e.clientX;
    });
    canvas.addEventListener('pointerup',function(){viewer.drag=false;});
    canvas.addEventListener('pointercancel',function(){viewer.drag=false;});
  }

  /* ---------- Cooking "video" player ---------- */
  var player={timer:null,step:0,steps:[],playing:false,dur:3200};

  function parseSteps(recipe){
    var raw=String(recipe||'').split(/\n+/).map(function(s){return s.trim();}).filter(Boolean);
    var steps=[];
    raw.forEach(function(s){
      // skip meta lines (time / ingredients) — keep only cooking steps
      if(/^[⏱🧺💡]/.test(s) || /^(время|ингредиенты|совет)\s*[:—]/i.test(s)) return;
      var clean=s.replace(/^\d+[\.\)]\s*/,'').replace(/^[👨‍🍳]\s*/,'').trim();
      if(clean) steps.push(clean);
    });
    if(!steps.length) steps=['Подготовьте ингредиенты','Приготовьте блюдо','Подавайте'];
    return steps;
  }

  function openVideo(name,recipe){
    var wrap=document.getElementById('v2-modal');
    wrap.classList.remove('hidden');
    document.getElementById('v2-modal-title').textContent='🎬 '+name;
    document.getElementById('v2-modal-sub').textContent='Видео-инструкция по приготовлению';
    player.steps=parseSteps(recipe); player.step=0; player.playing=false;
    var body=document.getElementById('v2-modal-body');
    var cols=dishColor(name);
    body.innerHTML=
      '<div class="v2-player" id="v2-player">'+
        '<div class="v2-steam"><i></i><i></i><i></i></div>'+
        '<div class="v2-stage"><div class="v2-stage__plate"></div><div class="v2-stage__food" style="--food1:#'+cols[0].toString(16).padStart(6,'0')+';--food2:#'+cols[1].toString(16).padStart(6,'0')+'"></div></div>'+
      '</div>'+
      '<div class="v2-step-text" id="v2-step-text"></div>'+
      '<div class="v2-controls">'+
        '<button class="v2-play" id="v2-play">▶</button>'+
        '<div class="v2-progress"><div class="v2-progress__bar" id="v2-bar"><div class="v2-progress__fill" id="v2-fill"></div></div>'+
        '<div class="v2-progress__meta"><span id="v2-step-now">Шаг 1</span><span id="v2-step-count">из '+player.steps.length+'</span></div></div>'+
      '</div>';
    showStep(0);
    document.getElementById('v2-play').addEventListener('click',togglePlay);
    document.getElementById('v2-bar').addEventListener('click',function(e){
      var r=this.getBoundingClientRect();
      var i=Math.floor((e.clientX-r.left)/r.width*player.steps.length);
      showStep(Math.max(0,Math.min(player.steps.length-1,i)));
    });
  }

  function showStep(i){
    player.step=i;
    var t=document.getElementById('v2-step-text'); if(t)t.textContent=player.steps[i]||'';
    var n=document.getElementById('v2-step-now'); if(n)n.textContent='Шаг '+(i+1);
    var f=document.getElementById('v2-fill'); if(f)f.style.width=((i+1)/player.steps.length*100)+'%';
  }
  function togglePlay(){
    player.playing=!player.playing;
    var b=document.getElementById('v2-play'); if(b)b.textContent=player.playing?'⏸':'▶';
    var p=document.getElementById('v2-player'); if(p)p.classList.toggle('playing',player.playing);
    if(player.timer)clearInterval(player.timer);
    if(player.playing){
      player.timer=setInterval(function(){
        if(player.step>=player.steps.length-1){togglePlay();return;}
        showStep(player.step+1);
      },player.dur);
    }
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
    if(viewer.raf){cancelAnimationFrame(viewer.raf);viewer.raf=null;}
    if(player.timer){clearInterval(player.timer);player.timer=null;player.playing=false;}
  }

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
      acts.innerHTML='<button class="v2-chip" data-act="3d">🧊 3D модель</button>'+
        '<button class="v2-chip v2-chip--vid" data-act="video">🎬 Как готовить</button>';
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
