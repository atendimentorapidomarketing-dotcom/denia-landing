const glow = document.getElementById('cursorGlow');
window.addEventListener('mousemove', e => {
  if(!glow) return;
  glow.style.left = `${e.clientX}px`;
  glow.style.top = `${e.clientY}px`;
  glow.style.opacity = '1';
});

const observer = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if(entry.isIntersecting){
      entry.target.classList.add('show');
      observer.unobserve(entry.target);
    }
  });
},{threshold:.12});
document.querySelectorAll('.reveal').forEach(el=>observer.observe(el));

document.querySelectorAll('.interactive').forEach(card=>{
  card.addEventListener('mousemove',e=>{
    const r=card.getBoundingClientRect();
    const x=e.clientX-r.left, y=e.clientY-r.top;
    const rx=((y/r.height)-.5)*-5;
    const ry=((x/r.width)-.5)*5;
    card.style.transform=`perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(-3px)`;
    card.style.background=`radial-gradient(280px circle at ${x}px ${y}px, rgba(120,244,208,.07), rgba(255,255,255,.018))`;
  });
  card.addEventListener('mouseleave',()=>{
    card.style.transform='';
    card.style.background='';
  });
});

document.querySelectorAll('.magnetic').forEach(btn=>{
  btn.addEventListener('mousemove',e=>{
    const r=btn.getBoundingClientRect();
    const x=(e.clientX-(r.left+r.width/2))*.08;
    const y=(e.clientY-(r.top+r.height/2))*.08;
    btn.style.transform=`translate(${x}px,${y}px) translateY(-2px)`;
  });
  btn.addEventListener('mouseleave',()=>btn.style.transform='');
});