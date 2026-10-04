
const glow=document.getElementById('cursorGlow');
const isTouch=matchMedia('(pointer:coarse)').matches;
if(!isTouch){
  window.addEventListener('mousemove',e=>{
    glow.style.left=e.clientX+'px';glow.style.top=e.clientY+'px';glow.style.opacity='1';
  });
}else{
  glow.style.opacity='.32';glow.style.left='50%';glow.style.top='35%';
}

const observer=new IntersectionObserver(entries=>{
  entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('show');observer.unobserve(entry.target)}})
},{threshold:.12});
document.querySelectorAll('.reveal').forEach(el=>observer.observe(el));

document.querySelectorAll('.interactive').forEach(card=>{
  if(isTouch){
    card.addEventListener('touchstart',()=>card.style.transform='scale(.985)',{passive:true});
    card.addEventListener('touchend',()=>card.style.transform='');
  }else{
    card.addEventListener('mousemove',e=>{
      const r=card.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;
      const rx=((y/r.height)-.5)*-5,ry=((x/r.width)-.5)*5;
      card.style.transform=`perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(-4px)`;
      card.style.background=`radial-gradient(280px circle at ${x}px ${y}px, rgba(84,220,255,.08), rgba(255,255,255,.018))`;
    });
    card.addEventListener('mouseleave',()=>{card.style.transform='';card.style.background=''});
  }
});

document.querySelectorAll('.magnetic').forEach(btn=>{
  if(!isTouch){
    btn.addEventListener('mousemove',e=>{
      const r=btn.getBoundingClientRect();
      btn.style.transform=`translate(${(e.clientX-r.left-r.width/2)*.08}px,${(e.clientY-r.top-r.height/2)*.08}px) translateY(-2px)`;
    });
    btn.addEventListener('mouseleave',()=>btn.style.transform='');
  }
});

const langButton=document.getElementById('langButton'),langMenu=document.getElementById('langMenu');
if(langButton&&langMenu){
  langButton.onclick=()=>langMenu.classList.toggle('open');
  langMenu.querySelectorAll('[data-lang]').forEach(b=>b.onclick=()=>{
    localStorage.setItem('denia_lang',b.dataset.lang);
    langButton.textContent=b.dataset.lang.toUpperCase()+' ▾';
    langMenu.classList.remove('open');
    document.documentElement.lang=b.dataset.lang==='pt'?'pt-BR':b.dataset.lang;
  });
  const saved=localStorage.getItem('denia_lang')||'pt';
  langButton.textContent=saved.toUpperCase()+' ▾';
}

// canvas futuristic particles + lightning
const canvas=document.getElementById('fxCanvas'),ctx=canvas.getContext('2d');
let w=0,h=0,dpr=Math.min(devicePixelRatio||1,2),particles=[];
function resize(){
  w=innerWidth;h=innerHeight;canvas.width=w*dpr;canvas.height=h*dpr;canvas.style.width=w+'px';canvas.style.height=h+'px';ctx.setTransform(dpr,0,0,dpr,0,0);
  const count=Math.max(28,Math.min(85,Math.floor(w/18)));
  particles=Array.from({length:count},()=>({x:Math.random()*w,y:Math.random()*h,vx:(Math.random()-.5)*.18,vy:(Math.random()-.5)*.18,r:Math.random()*1.3+.3,a:Math.random()*.45+.12}));
}
resize();addEventListener('resize',resize);
let t=0;
function draw(){
  ctx.clearRect(0,0,w,h);t++;
  for(const p of particles){
    p.x+=p.vx;p.y+=p.vy;if(p.x<0)p.x=w;if(p.x>w)p.x=0;if(p.y<0)p.y=h;if(p.y>h)p.y=0;
    ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fillStyle=`rgba(120,220,255,${p.a})`;ctx.fill();
  }
  for(let i=0;i<particles.length;i++){
    for(let j=i+1;j<particles.length;j++){
      const a=particles[i],b=particles[j],dx=a.x-b.x,dy=a.y-b.y,d=Math.hypot(dx,dy);
      if(d<105){
        ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle=`rgba(100,210,255,${(1-d/105)*.055})`;ctx.stroke();
      }
    }
  }
  if(t%140===0 && Math.random()>.45){
    let x=Math.random()*w*.7+w*.15,y=0;
    ctx.beginPath();ctx.moveTo(x,y);
    for(let k=0;k<8;k++){x+=(Math.random()-.5)*48;y+=Math.random()*34+18;ctx.lineTo(x,y)}
    ctx.strokeStyle='rgba(180,245,255,.22)';ctx.lineWidth=1;ctx.stroke();
  }
  requestAnimationFrame(draw);
}
draw();


// DENIA V8 — menu mobile + touch lighting
const mobileMenu=document.getElementById('mobileMenu');
const mobileMenuBtn=document.getElementById('mobileMenuBtn');
const mobileMenuClose=document.getElementById('mobileMenuClose');
mobileMenuBtn?.addEventListener('click',()=>mobileMenu?.classList.add('open'));
mobileMenuClose?.addEventListener('click',()=>mobileMenu?.classList.remove('open'));
mobileMenu?.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>mobileMenu.classList.remove('open')));

document.querySelectorAll('[data-lang-mobile]').forEach(btn=>{
  btn.addEventListener('click',()=>{
    const lang=btn.dataset.langMobile;
    localStorage.setItem('denia_lang',lang);
    document.documentElement.lang=lang==='pt'?'pt-BR':lang;
    if(langButton)langButton.textContent=lang.toUpperCase()+' ▾';
    mobileMenu?.classList.remove('open');
  });
});

if(matchMedia('(pointer:coarse)').matches){
  const tg=document.createElement('div');
  tg.className='touch-glow';
  document.body.appendChild(tg);
  let timer;
  const move=e=>{
    const t=e.touches?.[0];
    if(!t)return;
    tg.style.left=t.clientX+'px';
    tg.style.top=t.clientY+'px';
    tg.style.opacity='1';
    clearTimeout(timer);
    timer=setTimeout(()=>tg.style.opacity='.18',260);
  };
  addEventListener('touchstart',move,{passive:true});
  addEventListener('touchmove',move,{passive:true});
  addEventListener('touchend',()=>{tg.style.opacity='.10'},{passive:true});
}
