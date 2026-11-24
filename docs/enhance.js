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
    var n=(name||'').toLowerCase();
    var cols=dishColor(name);
    var isSoup=/суп|борщ|щи|рассольник|окрош|солян/.test(n);
    var isSalad=/салат|овощ/.test(n);
    var isFish=/рыб|лосос|кревет|тунец/.test(n);
    var isMeat=/куриц|говяд|свин|индей|мяс|котлет|стейк/.test(n);
    var isPorridge=/каш|гречк|овсян|рис/.test(n);
    var isPasta=/паст|макар|лапш/.test(n);
    var isDessert=/творог|йогурт|ягод|десерт|блин/.test(n);

    var plateMat=new THREE.MeshStandardMaterial({color:0xf7fafc,roughness:0.18,metalness:0.08});
    var rimMat=new THREE.MeshStandardMaterial({color:0xe8f1f8,roughness:0.22,metalness:0.12});
    var foodMat=new THREE.MeshStandardMaterial({color:cols[0],roughness:0.42,metalness:0.03});
    var foodMat2=new THREE.MeshStandardMaterial({color:cols[1],roughness:0.48,metalness:0.02});
    var accentMat=new THREE.MeshStandardMaterial({color:C.green,roughness:0.55,metalness:0.02});
    var sauceMat=new THREE.MeshStandardMaterial({color:0xffcf8a,roughness:0.25,metalness:0.05,transparent:true,opacity:0.92});

    function block(x,y,z,sx,sy,sz,mat,rx,ry,rz){
      var m=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),mat);
      m.scale.set(sx,sy,sz); m.position.set(x,y,z); m.rotation.set(rx||0,ry||0,rz||0);
      m.castShadow=true; m.receiveShadow=true; g.add(m); return m;
    }
    function ball(x,y,z,r,mat){
      var m=new THREE.Mesh(new THREE.SphereGeometry(r,24,18),mat);
      m.position.set(x,y,z); m.castShadow=true; m.receiveShadow=true; g.add(m); return m;
    }
    function cyl(x,y,z,rt,rb,h,mat,rx,ry,rz){
      var m=new THREE.Mesh(new THREE.CylinderGeometry(rt,rb,h,24),mat);
      m.position.set(x,y,z); m.rotation.set(rx||0,ry||0,rz||0); m.castShadow=true; m.receiveShadow=true; g.add(m); return m;
    }

    // soft contact shadow
    var shadow=new THREE.Mesh(new THREE.CircleGeometry(3.25,64),new THREE.MeshBasicMaterial({color:0x000000,transparent:true,opacity:0.28}));
    shadow.rotation.x=-Math.PI/2; shadow.position.y=-0.36; g.add(shadow);

    // ceramic plate with subtle gloss
    var plate=cyl(0,-0.2,0,2.78,2.42,0.22,plateMat,0,0,0);
    var rim=new THREE.Mesh(new THREE.TorusGeometry(2.62,0.13,18,72),rimMat);
    rim.rotation.x=Math.PI/2; rim.position.y=-0.09; rim.castShadow=true; g.add(rim);
    var well=cyl(0,-0.09,0,2.38,2.38,0.035,new THREE.MeshStandardMaterial({color:0xffffff,roughness:0.35}),0,0,0);

    // helper for garnish leaves
    function leaf(x,y,z,rx,ry,rz){
      var l=new THREE.Mesh(new THREE.SphereGeometry(0.16,12,10),accentMat);
      l.scale.set(1.35,0.35,0.9); l.position.set(x,y,z); l.rotation.set(rx,ry,rz); l.castShadow=true; g.add(l);
    }

    if(isSoup){
      var bowl=new THREE.Mesh(new THREE.SphereGeometry(2.05,40,20,0,Math.PI*2,0,Math.PI/2),new THREE.MeshStandardMaterial({color:0xfff4e8,roughness:0.25,metalness:0.05,side:THREE.DoubleSide}));
      bowl.scale.set(1,0.74,1); bowl.position.y=0.05; bowl.castShadow=true; g.add(bowl);
      var liquid=new THREE.Mesh(new THREE.CircleGeometry(1.78,64),new THREE.MeshStandardMaterial({color:cols[0],roughness:0.12,metalness:0.02}));
      liquid.rotation.x=-Math.PI/2; liquid.position.y=0.34; g.add(liquid);
      for(var i=0;i<10;i++){var a=i/10*Math.PI*2; ball(Math.cos(a)*0.95,0.4,Math.sin(a)*0.95,0.16,foodMat2);}
      ball(0,0.46,0,0.22,foodMat2);
      for(var s=0;s<4;s++) ball((s-1.5)*0.55,0.72+s*0.08,(s%2-0.5)*0.25,0.08,new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:0.35}));
    } else if(isSalad){
      for(var i=0;i<26;i++){
        var a=i/26*Math.PI*2+(i%3)*0.28; var r=0.45+(i%6)*0.34;
        ball(Math.cos(a)*r,0.16+(i%4)*0.11,Math.sin(a)*r,0.16+(i%3)*0.05, i%4===0?foodMat2:foodMat);
      }
      for(var j=0;j<8;j++){var a=j/8*Math.PI*2; ball(Math.cos(a)*1.12,0.34,Math.sin(a)*1.12,0.18,foodMat2);}
      for(var k=0;k<6;k++) block((k-2.5)*0.42,0.48,(k%2-0.5)*0.7,0.24,0.18,0.24,new THREE.MeshStandardMaterial({color:C.red,roughness:0.5}),0,k*0.5,0);
      for(var l=0;l<5;l++) leaf((l-2)*0.45,0.62,(l%2-0.5)*0.5,0.3,0,0.2);
    } else if(isFish){
      var fillet=new THREE.Mesh(new THREE.CylinderGeometry(0.35,0.55,2.9,24),new THREE.MeshStandardMaterial({color:cols[0],roughness:0.35}));
      fillet.rotation.z=Math.PI/2; fillet.position.y=0.28; fillet.castShadow=true; g.add(fillet);
      var glaze=new THREE.Mesh(new THREE.CylinderGeometry(0.22,0.34,2.5,24),new THREE.MeshStandardMaterial({color:cols[1],roughness:0.22,transparent:true,opacity:0.75}));
      glaze.rotation.z=Math.PI/2; glaze.position.y=0.42; g.add(glaze);
      for(var i=0;i<4;i++){
        var slice=new THREE.Mesh(new THREE.TorusGeometry(0.26,0.055,12,28),new THREE.MeshStandardMaterial({color:0xfff0a8,roughness:0.2}));
        slice.rotation.x=Math.PI/2; slice.position.set(-1.0+i*0.68,0.5, (i%2-0.5)*0.28); g.add(slice);
      }
      for(var j=0;j<6;j++) leaf((j-2.5)*0.45,0.58,(j%2-0.5)*0.45,0.2,0.1,0.4);
      ball(1.35,0.38,0,0.16,foodMat2);
    } else if(isMeat){
      for(var i=0;i<5;i++){
        var ang=i/5*Math.PI*2;
        block(Math.cos(ang)*0.85,0.3,Math.sin(ang)*0.85,0.55,0.32,0.42,foodMat,0.2,ang,0.1);
      }
      for(var j=0;j<6;j++){
        var ang2=j/6*Math.PI*2+0.5;
        ball(Math.cos(ang2)*1.5,0.24,Math.sin(ang2)*1.5,0.3, new THREE.MeshStandardMaterial({color:0xffd38a,roughness:0.55}));
      }
      for(var k=0;k<5;k++) ball((k-2)*0.45,0.56,(k%2-0.5)*0.55,0.11,new THREE.MeshStandardMaterial({color:C.red,roughness:0.5}));
      var drizzle=new THREE.Mesh(new THREE.TorusGeometry(1.0,0.05,10,48),new THREE.MeshStandardMaterial({color:0xffe7b8,roughness:0.2}));
      drizzle.rotation.x=Math.PI/2; drizzle.position.y=0.72; g.add(drizzle);
    } else if(isPasta){
      for(var i=0;i<14;i++){
        var torus=new THREE.Mesh(new THREE.TorusGeometry(0.5,0.11,12,32),new THREE.MeshStandardMaterial({color:cols[0],roughness:0.32}));
        torus.position.set((i%4-1.5)*0.68,0.18+Math.floor(i/4)*0.16,(i%3-1)*0.5);
        torus.rotation.set(i*0.35,i*0.6,i*0.2); torus.castShadow=true; g.add(torus);
      }
      var sauce=new THREE.Mesh(new THREE.SphereGeometry(1.05,24,16),sauceMat);
      sauce.scale.set(1.55,0.22,1.25); sauce.position.y=0.34; g.add(sauce);
      for(var j=0;j<7;j++) leaf((j-3)*0.38,0.48,(j%2-0.5)*0.4,0.2,0.3,0.1);
    } else if(isPorridge){
      var mound=new THREE.Mesh(new THREE.SphereGeometry(1.5,32,20),new THREE.MeshStandardMaterial({color:cols[0],roughness:0.35}));
      mound.scale.set(1.28,0.72,1.18); mound.position.y=0.22; mound.castShadow=true; g.add(mound);
      for(var i=0;i<12;i++){var a=i/12*Math.PI*2; ball(Math.cos(a)*0.92,0.62,Math.sin(a)*0.92,0.13,foodMat2);}
      for(var j=0;j<6;j++) ball((j-2.5)*0.38,0.72,(j%2-0.5)*0.45,0.08,new THREE.MeshStandardMaterial({color:C.purple,roughness:0.4}));
      var drizzle=new THREE.Mesh(new THREE.TorusGeometry(0.95,0.045,10,48),new THREE.MeshStandardMaterial({color:0xfff0c8,roughness:0.2}));
      drizzle.rotation.x=Math.PI/2; drizzle.position.y=0.7; g.add(drizzle);
    } else if(isDessert){
      var base=new THREE.Mesh(new THREE.CylinderGeometry(1.35,1.18,0.72,32),new THREE.MeshStandardMaterial({color:cols[0],roughness:0.35}));
      base.position.y=0.2; base.castShadow=true; g.add(base);
      var top=new THREE.Mesh(new THREE.SphereGeometry(1.22,32,18),new THREE.MeshStandardMaterial({color:cols[1],roughness:0.22}));
      top.scale.set(1,0.58,1); top.position.y=0.64; g.add(top);
      for(var i=0;i<9;i++){var a=i/9*Math.PI*2; ball(Math.cos(a)*1.02,0.78,Math.sin(a)*1.02,0.13,new THREE.MeshStandardMaterial({color:C.red,roughness:0.45}));}
      for(var j=0;j<4;j++) leaf((j-1.5)*0.5,0.9,(j%2-0.5)*0.35,0.1,0.4,0.2);
    } else {
      for(var i=0;i<18;i++){
        var a=i/18*Math.PI*2+(i%2)*0.24; var r=0.35+(i%6)*0.32;
        ball(Math.cos(a)*r,0.16+(i%5)*0.1,Math.sin(a)*r,0.15+(i%3)*0.06, i%3?foodMat:foodMat2);
      }
      for(var j=0;j<7;j++){
        var ang=j/7*Math.PI*2;
        leaf(Math.cos(ang)*1.2,0.42,Math.sin(ang)*1.2,0.2,0.2,0.3);
      }
    }

    // steam for hot dishes
    if(!(isSalad || isDessert)){
      for(var s=0;s<6;s++){
        var steam=new THREE.Mesh(new THREE.SphereGeometry(0.08+s*0.025,10,8),new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:0.24}));
        steam.position.set((s-2.5)*0.38,0.86+s*0.1,(s%2-0.5)*0.3);
        g.add(steam);
      }
    }

    return g;
  }

  function open3D(name,recipe){
    try{
      closeViewer();
      var wrap=document.getElementById('v2-modal');
      wrap.classList.remove('hidden');
      document.getElementById('v2-modal-title').textContent='🥘 '+name;
      document.getElementById('v2-modal-sub').textContent='3D-модель блюда — покрутите, чтобы рассмотреть со всех сторон';
      var body=document.getElementById('v2-modal-body');
      var ingredients=parseIngredients(recipe);
      var ingHtml=ingredients.length?'<div class="v2-ingredients-title">Состав блюда</div><div class="v2-ingredients">'+ingredients.map(ingredientChip).join('')+'</div>':'';
      body.innerHTML='<div class="v2-canvas-wrap"><canvas id="dish-canvas"></canvas><div class="v2-hint">🖐 Потяните, чтобы вращать · колёсико — приблизить</div></div>'+
        '<div class="v2-modal__info"><h3>'+esc(name)+'</h3><p>3D-визуализация порции. Ниже — все ингредиенты, чтобы было понятно, что входит в блюдо.</p>'+ingHtml+'</div>';
      var canvas=document.getElementById('dish-canvas');
      var H=Math.max(160,Math.round(wrap.getBoundingClientRect().height));
      var renderer=new THREE.WebGLRenderer({canvas:canvas,antialias:true,alpha:true});
      renderer.setClearColor('#070b14',1);
      renderer.setPixelRatio(Math.min(devicePixelRatio,2));
      renderer.setSize(H*1.7,H,false);
      renderer.shadowMap.enabled=true;
      renderer.shadowMap.type=THREE.PCFSoftShadowMap;
      renderer.toneMapping=THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure=1.08;
      var scene=new THREE.Scene();
      scene.background=new THREE.Color(0x08111a);
      scene.fog=new THREE.Fog(0x08111a,10,24);
      var cam=new THREE.PerspectiveCamera(34,1.7,0.1,100);
      cam.position.set(0,4.9,7.8); cam.lookAt(0,0.15,0);
      scene.add(new THREE.AmbientLight(0xffffff,.55));
      var hemi=new THREE.HemisphereLight(0x8fd3ff,0x101820,.75); scene.add(hemi);
      var key=new THREE.DirectionalLight(0xffffff,2.1); key.position.set(5,10,7); key.castShadow=true; key.shadow.mapSize.width=1024; key.shadow.mapSize.height=1024; scene.add(key);
      var fill=new THREE.DirectionalLight(0x5eead4,.95); fill.position.set(-6,4,-5); scene.add(fill);
      var rim=new THREE.DirectionalLight(0xff9ec7,.7); rim.position.set(0,6,-8); scene.add(rim);
      var group=buildDish(name); group.scale.set(1.12,1.12,1.12); scene.add(group);
      viewer={renderer:renderer,scene:scene,camera:cam,group:group,sceneLights:[key,fill,rim],raf:null,drag:false,px:0,zoom:0};
      var rot=0.35;
      function loop(){
        viewer.raf=requestAnimationFrame(loop);
        if(!viewer.drag)rot+=0.0022;
        group.rotation.y=rot;
        group.position.y=Math.sin(rot*1.7)*0.045;
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
  var player={timer:null,raf:null,step:0,steps:[],playing:false,dur:7000,start:0,t:0,ctx:null,cols:[C.green,C.lime],fps60:true,progressSmooth:true};

  function ingredientIcon(text){
    var t=(text||'').toLowerCase();
    if(/куриц|грудк|индей|мяс|котлет|стейк|говяд|свин/.test(t)) return '🍗';
    if(/рыб|лосос|кревет|тунец/.test(t)) return '🐟';
    if(/яйц/.test(t)) return '🥚';
    if(/молок/.test(t)) return '🥛';
    if(/творог|йогурт|сыр/.test(t)) return '🧀';
    if(/гречк|овсян|каш|рис/.test(t)) return '🌾';
    if(/макар|паст|лапш/.test(t)) return '🍝';
    if(/помидор|томат/.test(t)) return '🍅';
    if(/огур/.test(t)) return '🥒';
    if(/перец/.test(t)) return '🌶️';
    if(/морков/.test(t)) return '🥕';
    if(/лук/.test(t)) return '🧅';
    if(/капуст/.test(t)) return '🥬';
    if(/картоф/.test(t)) return '🥔';
    if(/гриб/.test(t)) return '🍄';
    if(/яблок/.test(t)) return '🍎';
    if(/банан/.test(t)) return '🍌';
    if(/ягод|черник|клубник|малин/.test(t)) return '🫐';
    if(/орех|миндал|грец/.test(t)) return '🥜';
    if(/мед/.test(t)) return '🍯';
    if(/масл/.test(t)) return '🧈';
    if(/хлеб|тост/.test(t)) return '🍞';
    if(/зелень|укроп|петруш|базилик/.test(t)) return '🌿';
    if(/соль|специ|перец/.test(t)) return '🧂';
    return '🥘';
  }
  function parseIngredients(recipe){
    var m=String(recipe||'').match(/ингредиенты\s*:\s*(.+)/i);
    if(!m) return [];
    return m[1].split(',').map(function(s){return s.trim();}).filter(Boolean);
  }
  function ingredientChip(text){ return '<span class="v2-ingredient"><span class="v2-ingredient__icon">'+ingredientIcon(text)+'</span>'+esc(text)+'</span>'; }
  function dishSearchTerm(name){
    var n=(name||'').toLowerCase();
    if(/борщ/.test(n)) return 'borscht';
    if(/греч/.test(n)) return 'buckwheat';
    if(/овсян/.test(n)) return 'oatmeal';
    if(/куриц|грудк|индей|мяс/.test(n)) return 'chicken';
    if(/рыб|лосос/.test(n)) return 'salmon';
    if(/салат/.test(n)) return 'salad';
    if(/суп/.test(n)) return 'soup';
    if(/паст|макар/.test(n)) return 'pasta';
    if(/рис/.test(n)) return 'rice';
    if(/творог|йогурт/.test(n)) return 'yogurt';
    if(/ягод|черник|клубник/.test(n)) return 'berries';
    if(/яблок/.test(n)) return 'apple';
    if(/банан/.test(n)) return 'banana';
    if(/картоф/.test(n)) return 'potato';
    if(/гриб/.test(n)) return 'mushroom';
    return 'food';
  }
  async function fetchMealDb(term){
    try{
      var res=await fetch('https://www.themealdb.com/api/json/v1/1/search.php?s='+encodeURIComponent(term));
      var data=await res.json();
      var meals=data && data.meals;
      if(meals && meals.length){
        var m=meals[0];
        var yt=m.strYoutube||'';
        var embed=yt?yt.replace('www.youtube.com/watch?v=','www.youtube-nocookie.com/embed/').replace('youtu.be/','www.youtube-nocookie.com/embed/'):'';
        if(embed) embed+='?rel=0&modestbranding=1&playsinline=1&origin=https://aifoodbot.duckdns.org';        return {title:m.strMeal, image:m.strMealThumb, video:embed};
      }
    }catch(e){}
    return {title:'',image:'',video:''};
  }
  function stepIcon(text){
    var t=(text||'').toLowerCase();
    if(/добав|полож|всып|влей|влив/.test(t)) return '➕';
    if(/жар|поджар/.test(t)) return '🍳';
    if(/вар|отвар/.test(t)) return '🍲';
    if(/смеш|перемеш/.test(t)) return '🥄';
    if(/нарез|порез|реж/.test(t)) return '🔪';
    if(/подав|украс/.test(t)) return '🍽️';
    if(/запек|выпек/.test(t)) return '🔥';
    return ingredientIcon(t);
  }
  function dishImageUrl(name, recipe){
    var ingredients=parseIngredients(recipe).join(', ');
    var prompt='cartoon-realistic 3D food illustration of '+name+', ingredients: '+ingredients+', clean studio background, soft lighting, appetizing, high detail, smooth rounded shapes, modern food render, no text';
    var seed=0; for(var i=0;i<name.length;i++) seed=(seed*31+name.charCodeAt(i))>>>0;
    return 'https://image.pollinations.ai/prompt/'+encodeURIComponent(prompt)+'?width=768&height=512&model=flux&nologo=true&private=true&safe=true&enhance=true&seed='+seed;
  }
  function stepImageUrl(name, stepText){
    var prompt='close-up cooking step: '+stepText+', '+name+', food in pan, realistic kitchen, hands adding ingredient, steam, warm lighting, high detail photo, no text';
    var seed=0; for(var i=0;i<(name+stepText).length;i++) seed=(seed*31+(name+stepText).charCodeAt(i))>>>0;
    return 'https://image.pollinations.ai/prompt/'+encodeURIComponent(prompt)+'?width=768&height=512&model=flux&nologo=true&private=true&safe=true&enhance=true&seed='+seed;
  }
  async function openPhoto(name, recipe){
    ensureModal();
    var wrap=document.getElementById('v2-modal');wrap.classList.remove('hidden');
    document.getElementById('v2-modal-title').textContent='🖼 '+name;
    document.getElementById('v2-modal-sub').textContent='Реалистичное фото блюда · можно покрутить';
    var ingredients=parseIngredients(recipe);
    var ingHtml=ingredients.length?'<div class="v2-ingredients-title">Состав блюда</div><div class="v2-ingredients">'+ingredients.map(ingredientChip).join('')+'</div>':'';
    var body=document.getElementById('v2-modal-body');
    body.innerHTML='<div class="v2-photo3d-wrap"><div class="v2-photo3d" id="v2-photo3d"><div class="v2-photo-loading" id="v2-photo-loading">Загружаем реалистичное фото…</div></div></div>'+
      '<div class="v2-modal__info"><h3>'+esc(name)+'</h3><p>Фото можно покрутить мышью или пальцем. Ниже — все ингредиенты.</p>'+ingHtml+'</div>';
    var meal=await fetchMealDb(dishSearchTerm(name));
    var url=meal.image || dishImageUrl(name,recipe);
    var box=document.getElementById('v2-photo3d');
    box.innerHTML='<img class="v2-photo3d__img" src="'+url+'" alt="'+esc(name)+'">';
    var img=box.querySelector('img');
    var loading=document.getElementById('v2-photo-loading');
    img.onload=function(){ if(loading) loading.style.display='none'; };
    img.onerror=function(){ box.innerHTML='<div class="v2-photo-loading">Не удалось загрузить фото</div>'; };
    var rx=0, ry=0, dragging=false, px=0, py=0;
    box.addEventListener('pointerdown',function(e){dragging=true;px=e.clientX;py=e.clientY;box.setPointerCapture(e.pointerId);});
    box.addEventListener('pointermove',function(e){if(!dragging)return;ry+=(e.clientX-px)*0.5;rx-=(e.clientY-py)*0.5;rx=Math.max(-25,Math.min(25,rx));ry=Math.max(-35,Math.min(35,ry));px=e.clientX;py=e.clientY;box.style.transform='rotateX('+rx+'deg) rotateY('+ry+'deg)';});
    box.addEventListener('pointerup',function(e){dragging=false;box.releasePointerCapture(e.pointerId);});
    box.addEventListener('pointercancel',function(){dragging=false;});
  }
  function parseSteps(recipe){
    var raw=String(recipe||'').split(/\n+/).map(function(s){return s.trim();}).filter(Boolean);
    var steps=[];
    raw.forEach(function(s){
      var clean=s.replace(/^[\d\.\)\s]+/,'').replace(/^[^\p{L}\p{N}]+/u,'').trim();
      if(/^(время|time|ingredients|ingredientes|tips|ингредиенты|приготовление|совет)/i.test(clean)) return;
      if(/^\d+\s*(мин|м|ч|час|сек)/i.test(clean)) return;
      if(clean) steps.push(clean.replace(/^\d+[\.\)]\s*/,'').trim());
    });
    if(!steps.length) steps=['Подготовьте ингредиенты','Приготовьте блюдо','Подавайте'];
    return steps;
  }

  function drawKitchen(ctx,W,H,t,step,total,cols,icon){
    var cx=W/2, cy=H*0.62;
    var phase=(t%player.dur)/player.dur;
    var cooking=step<total-1;
    var zoom=1+Math.sin(phase*Math.PI)*0.035;

    ctx.clearRect(0,0,W,H);

    // cinematic kitchen backdrop
    var bg=ctx.createLinearGradient(0,0,0,H);
    bg.addColorStop(0,'#0f1b2a'); bg.addColorStop(0.45,'#0a121d'); bg.addColorStop(1,'#05080d');
    ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);

    // soft depth lights
    var light=ctx.createRadialGradient(cx-40,cy-90,10,cx-40,cy-90,260);
    light.addColorStop(0,'rgba(45,212,191,0.16)'); light.addColorStop(1,'rgba(45,212,191,0)');
    ctx.fillStyle=light; ctx.fillRect(0,0,W,H);
    var light2=ctx.createRadialGradient(cx+120,cy-20,10,cx+120,cy-20,220);
    light2.addColorStop(0,'rgba(91,141,239,0.14)'); light2.addColorStop(1,'rgba(91,141,239,0)');
    ctx.fillStyle=light2; ctx.fillRect(0,0,W,H);

    // countertop
    var counter=ctx.createLinearGradient(0,cy+45,0,H);
    counter.addColorStop(0,'#263241'); counter.addColorStop(1,'#111823');
    ctx.fillStyle=counter;
    ctx.beginPath(); ctx.moveTo(0,cy+55); ctx.lineTo(W,cy+35); ctx.lineTo(W,H); ctx.lineTo(0,H); ctx.closePath(); ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,0.06)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(0,cy+55); ctx.lineTo(W,cy+35); ctx.stroke();

    ctx.save();
    ctx.translate(cx,cy);
    ctx.scale(zoom,zoom);
    ctx.translate(-cx,-cy);

    // pan shadow
    ctx.fillStyle='rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(cx,cy+42,150,34,0,0,Math.PI*2); ctx.fill();

    // pan body
    var panGrad=ctx.createLinearGradient(cx-150,cy-30,cx+150,cy+30);
    panGrad.addColorStop(0,'#3a4658'); panGrad.addColorStop(0.45,'#202938'); panGrad.addColorStop(1,'#111823');
    ctx.fillStyle=panGrad;
    ctx.beginPath(); ctx.ellipse(cx,cy,150,52,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#2a3444';
    ctx.fillRect(cx-150,cy-10,300,34);
    ctx.strokeStyle='rgba(255,255,255,0.12)'; ctx.lineWidth=2;
    ctx.beginPath(); ctx.ellipse(cx,cy-10,150,52,0,0,Math.PI*2); ctx.stroke();
    // handle
    ctx.strokeStyle='#4b5563'; ctx.lineWidth=12; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(cx+145,cy); ctx.lineTo(cx+215,cy-18); ctx.stroke();
    ctx.strokeStyle='#6b7280'; ctx.lineWidth=4;
    ctx.beginPath(); ctx.moveTo(cx+145,cy); ctx.lineTo(cx+215,cy-18); ctx.stroke();

    // food pieces
    var n=12;
    for(var j=0;j<n;j++){
      var ang=j/n*Math.PI*2 + t*0.0015;
      var rr=34+Math.sin(j*1.9+t*0.003)*24;
      var fx=cx+Math.cos(ang)*rr;
      var fy=cy-8+Math.sin(ang*1.4+t*0.004)*14;
      var col=j%3===0?cols[1]:cols[0];
      ctx.fillStyle='#'+col.toString(16).padStart(6,'0');
      ctx.shadowColor='rgba(0,0,0,0.35)'; ctx.shadowBlur=8; ctx.shadowOffsetY=4;
      ctx.beginPath(); ctx.ellipse(fx,fy,13,10,ang,0,Math.PI*2); ctx.fill();
      ctx.shadowColor='transparent'; ctx.shadowBlur=0; ctx.shadowOffsetY=0;
      // highlight
      ctx.fillStyle='rgba(255,255,255,0.18)';
      ctx.beginPath(); ctx.ellipse(fx-3,fy-4,4,2.5,ang,0,Math.PI*2); ctx.fill();
    }

    // sauce streak
    if(cooking){
      ctx.strokeStyle='rgba(255,205,120,0.55)'; ctx.lineWidth=6; ctx.lineCap='round';
      ctx.beginPath(); ctx.moveTo(cx-70,cy-2); ctx.quadraticCurveTo(cx,cy+18,cx+75,cy-5); ctx.stroke();
    }

    // flame
    if(cooking){
      for(var f=0;f<6;f++){
        var fh=24+Math.sin(t*0.012+f*1.7)*12;
        var grad=ctx.createLinearGradient(cx-55+f*22,cy+52,cx-55+f*22,cy+52-fh);
        grad.addColorStop(0,'rgba(255,95,40,0.85)'); grad.addColorStop(0.5,'rgba(255,170,60,0.65)'); grad.addColorStop(1,'rgba(255,220,120,0)');
        ctx.fillStyle=grad;
        ctx.beginPath(); ctx.ellipse(cx-55+f*22,cy+48,fh*0.38,fh,0,0,Math.PI*2); ctx.fill();
      }
      // glow
      var flameGlow=ctx.createRadialGradient(cx,cy+45,10,cx,cy+45,120);
      flameGlow.addColorStop(0,'rgba(255,140,60,0.18)'); flameGlow.addColorStop(1,'rgba(255,140,60,0)');
      ctx.fillStyle=flameGlow; ctx.fillRect(cx-130,cy-10,260,120);
    }

    // steam
    if(cooking){
      for(var i=0;i<8;i++){
        var st=(phase*1.45+i/8)%1;
        var sx=cx+Math.sin(i*2.1+phase*5)*34;
        var sy=cy-75-st*125;
        ctx.globalAlpha=(1-st)*0.42;
        ctx.fillStyle='#eafcff';
        ctx.filter='blur(3px)';
        ctx.beginPath(); ctx.arc(sx,sy,9+st*16,0,Math.PI*2); ctx.fill();
        ctx.filter='none';
      }
      ctx.globalAlpha=1;
    }

    // final plate
    if(step===total-1){
      var plateGrad=ctx.createRadialGradient(cx,cy+12,10,cx,cy+12,110);
      plateGrad.addColorStop(0,'#ffffff'); plateGrad.addColorStop(1,'#d7e4f2');
      ctx.fillStyle=plateGrad;
      ctx.beginPath(); ctx.ellipse(cx,cy+12,112,38,0,0,Math.PI*2); ctx.fill();
      ctx.fillStyle='#'+cols[0].toString(16).padStart(6,'0');
      ctx.beginPath(); ctx.ellipse(cx,cy+8,72,24,0,0,Math.PI*2); ctx.fill();
      ctx.fillStyle='rgba(255,255,255,0.35)';
      ctx.beginPath(); ctx.ellipse(cx-18,cy,28,10,0,0,Math.PI*2); ctx.fill();
      ctx.globalAlpha=0.95; ctx.fillStyle='#ffffff'; ctx.font='bold 18px Manrope, sans-serif'; ctx.textAlign='center';
      ctx.shadowColor='rgba(0,0,0,0.45)'; ctx.shadowBlur=8; ctx.fillText('✅ ГОТОВО',cx,cy-78);
      ctx.shadowColor='transparent'; ctx.shadowBlur=0; ctx.globalAlpha=1;
    }

    // current action icon
    if(icon){
      ctx.font='bold 46px "Segoe UI Emoji","Apple Color Emoji",sans-serif';
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.shadowColor='rgba(0,0,0,0.55)'; ctx.shadowBlur=12;
      ctx.fillStyle='rgba(255,255,255,0.95)';
      ctx.fillText(icon,cx,cy-118);
      ctx.shadowColor='transparent'; ctx.shadowBlur=0;
    }

    ctx.restore();

    // top HUD
    ctx.fillStyle='rgba(5,9,14,0.55)'; ctx.fillRect(0,0,W,38);
    ctx.fillStyle='#7dd3fc'; ctx.font='bold 13px Manrope, sans-serif'; ctx.textAlign='left';
    ctx.fillText('ШАГ '+(step+1)+' / '+total,16,24);
    ctx.fillStyle='rgba(255,255,255,0.72)'; ctx.font='600 12px Manrope, sans-serif';
    ctx.textAlign='right'; ctx.fillText(cooking?'ПРИГОТОВЛЕНИЕ':'ПОДАЧА',W-16,24);
    if(player.playing){
      ctx.fillStyle='#fb7185'; ctx.beginPath(); ctx.arc(W-16,14,4.5,0,Math.PI*2); ctx.fill();
      ctx.fillStyle='#fff'; ctx.font='bold 10px Manrope, sans-serif'; ctx.textAlign='right'; ctx.fillText('REC',W-26,17);
    }
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
    if(c&&player.ctx)drawKitchen(player.ctx,player.canvasW||520,player.canvasH||360,player.t,player.step,player.steps.length,player.cols,stepIcon(player.steps[player.step]||''));
    player.raf=requestAnimationFrame(filmLoop);
  }

  async function openVideo(name,recipe){
    var wrap=document.getElementById('v2-modal');wrap.classList.remove('hidden');
    document.getElementById('v2-modal-title').textContent='🎬 '+name;
    document.getElementById('v2-modal-sub').textContent='Пошаговый видеогайд';
    player.steps=parseSteps(recipe);player.step=0;player.playing=false;player.ingredients=parseIngredients(recipe);player._name=name;
    var meal=await fetchMealDb(dishSearchTerm(name));
    var body=document.getElementById('v2-modal-body');
    var ingHtml=player.ingredients.length?'<div class="v2-ingredients-title">Что понадобится</div><div class="v2-ingredients">'+player.ingredients.map(ingredientChip).join('')+'</div>':'';
    var videoId=meal.video?meal.video.split('/embed/')[1]||'':'';
    var thumb=videoId?'https://img.youtube.com/vi/'+videoId+'/hqdefault.jpg':(meal.image||dishImageUrl(name,recipe));
    var stepUrl=stepImageUrl(name, player.steps[0]||name);
    body.innerHTML=
      '<div class="v2-photo-wrap v2-photo-wrap--video"><img class="v2-photo v2-photo--kenburns" id="v2-step-image" src="'+stepUrl+'" alt="'+esc(name)+'"><div class="v2-photo-loading" id="v2-photo-loading">Генерируем шаг приготовления…</div><div class="v2-video-overlay"></div></div>'+
      ingHtml+
      '<div class="v2-step-card" id="v2-step-card"><span class="v2-step-card__icon" id="v2-step-icon">🍳</span><span class="v2-step-card__text" id="v2-step-text"></span></div>'+
      '<div class="v2-controls"><button class="v2-play" id="v2-play">▶</button>'+
      '<div class="v2-progress"><div class="v2-progress__bar" id="v2-bar"><div class="v2-progress__fill" id="v2-fill"></div></div>'+
      '<div class="v2-progress__meta"><span id="v2-step-now">Шаг 1</span><span id="v2-step-count">из '+player.steps.length+'</span></div></div></div>';
    var img=body.querySelector('#v2-step-image');
    var loading=body.querySelector('#v2-photo-loading');
    img.onload=function(){ if(loading) loading.style.display='none'; };
    img.onerror=function(){ if(loading) loading.textContent='Не удалось загрузить шаг'; };
    showStep(0);
    document.getElementById('v2-play').addEventListener('click',togglePlay);
    document.getElementById('v2-bar').addEventListener('click',function(e){
      var r=this.getBoundingClientRect();
      var i=Math.floor((e.clientX-r.left)/r.width*player.steps.length);
      showStep(Math.max(0,Math.min(player.steps.length-1,i)));
      if(player.playing) scheduleAdvance();
    });
  }

  function showStep(i){
    player.step=i;player.start=0;player.t=0;
    var t=document.getElementById('v2-step-text');if(t)t.textContent=player.steps[i]||'';
    var icon=document.getElementById('v2-step-icon');if(icon)icon.textContent=stepIcon(player.steps[i]||'');
    var img=document.getElementById('v2-step-image');if(img){img.src=stepImageUrl(player._name||'',player.steps[i]||'');}
    var n=document.getElementById('v2-step-now');if(n)n.textContent='Шаг '+(i+1);
    var f=document.getElementById('v2-fill');if(f)f.style.width=((i+1)/player.steps.length*100)+'%';
    var card=document.getElementById('v2-step-card');if(card){card.classList.remove('v2-step-card--pop');void card.offsetWidth;card.classList.add('v2-step-card--pop');}
  }
  function advanceStep(){
    if(!player.playing) return;
    if(player.step>=player.steps.length-1){togglePlay();return;}
    showStep(player.step+1);
    scheduleAdvance();
  }
  function scheduleAdvance(){
    if(!player.playing) return;
    if(player.advanceTimer) clearTimeout(player.advanceTimer);
    var img=document.getElementById('v2-step-image');
    var done=false;
    function go(){ if(done) return; done=true; player.advanceTimer=setTimeout(advanceStep, player.dur); }
    if(img && !img.complete){ img.onload=function(){ img.onload=null; go(); }; player.advanceTimer=setTimeout(go, player.dur+3000); }
    else { player.advanceTimer=setTimeout(go, player.dur); }
  }
  function togglePlay(){
    var replay=!player.playing&&player.step>=player.steps.length-1;
    player.playing=!player.playing;
    if(player.playing&&replay)showStep(0);
    var b=document.getElementById('v2-play');if(b)b.textContent=player.playing?'⏸':'▶';
    if(player.timer)clearInterval(player.timer);
    if(player.raf)cancelAnimationFrame(player.raf);
    if(player.advanceTimer)clearTimeout(player.advanceTimer);
    if(player.playing){ scheduleAdvance(); }
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
      acts.innerHTML='<button type="button" class="v2-chip" data-act="photo" aria-label="Реалистичное фото блюда">🖼 Фото блюда</button>'+
        '<button type="button" class="v2-chip v2-chip--vid" data-act="video" aria-label="Видео-инструкция приготовления">🎬 Видеогайд</button>';
      card.appendChild(acts);
      acts.querySelector('[data-act="photo"]').addEventListener('click',function(){
        ensureModal(); openPhoto(name,recipe);
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
