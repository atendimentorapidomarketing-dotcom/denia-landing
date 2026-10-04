
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
async function api(url,opts={}){
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),12000);
  try{
    const r=await fetch(url,{...opts,signal:controller.signal,headers:{'content-type':'application/json',...(opts.headers||{})}});
    if(r.status===401){location.href='/login';throw new Error('Sessão expirada.')}
    const j=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(j.error||j.erro||j.detail||`Erro HTTP ${r.status}`);
    return j;
  }catch(e){
    if(e?.name==='AbortError')throw new Error('A conexão com a DENIA Engine demorou mais de 12 segundos. Verifique DENIA_ENGINE_URL e o token privado.');
    throw e;
  }finally{clearTimeout(timeout)}
}
$$('#nav button').forEach(b=>b.onclick=()=>{$$('#nav button').forEach(x=>x.classList.remove('active'));b.classList.add('active');$$('.page').forEach(p=>p.classList.remove('active'));$('#page-'+b.dataset.page).classList.add('active')});
$('#homeBtn')?.addEventListener('click',()=>{const p=location.pathname;location.href=p.startsWith('/en/')?'/en':p.startsWith('/es/')?'/es':'/'});
$('#logoutBtn')?.addEventListener('click',async()=>{await api('/api/auth/logout',{method:'POST'}).catch(()=>{});const p=location.pathname;location.href=p.startsWith('/en/')?'/en/login':p.startsWith('/es/')?'/es/login':'/login'});
$('#saveTraining')?.addEventListener('click',async()=>{const identity=$('#identity')?.value||'';const rules=$('#rules')?.value||'';await api('/api/config/training',{method:'POST',body:JSON.stringify({identity,rules})});alert('Treinamento salvo.')});
$('#saveConfig')?.addEventListener('click',async()=>{const organization=$('#orgInput')?.value||'DENIA Operação Principal';const phone=$('#phoneInput')?.value||'';await api('/api/config/settings',{method:'POST',body:JSON.stringify({organization,phone})});if($('#orgName'))$('#orgName').textContent=organization;alert('Configurações salvas.')});
(async()=>{
  try{
    const me=await api('/api/me');
    if($('#userName'))$('#userName').textContent=me.user.name+' · '+me.user.email;
    if($('#orgName'))$('#orgName').textContent=me.organization.name;
    if($('#orgInput'))$('#orgInput').value=me.organization.name;
    const c=await api('/api/config');
    if($('#identity'))$('#identity').value=c.training?.identity||'';
    if($('#rules'))$('#rules').value=c.training?.rules||'';
    if($('#phoneInput'))$('#phoneInput').value=c.settings?.phone||'+55 21 97546-9162';
  }catch(e){
    console.error('Falha ao inicializar perfil:',e);
  }
})();


// DENIA Platform V11 — integração operacional real
let selectedConversationId=null;

function esc(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}

async function loadEngineStatus(){
  try{
    const s=await api('/api/engine/status');
    const el=$('#engineStatus'), tx=$('#engineStatusText');
    if(el)el.textContent=s.engine_online?'Online':'Indisponível';
    if(tx)tx.textContent=`${s.mensagens||0} mensagens · ${s.pessoas||0} pessoas · WhatsApp ${s.whatsapp_configurado?'configurado':'não configurado'}`;
  }catch(e){
    if($('#engineStatus'))$('#engineStatus').textContent='Atenção';
    if($('#engineStatusText'))$('#engineStatusText').textContent=e.message;
    showSystemAlert('A Platform abriu normalmente, mas não conseguiu consultar a DENIA Engine: '+e.message,'error');
  }
}

async function loadConversations(){
  const list=$('#liveChatList'); if(!list)return;
  list.innerHTML='<div class="loading-state"><span class="ai-loader"></span><div><b>Consultando a DENIA Engine</b><small>Buscando conversas reais no banco operacional…</small></div></div>';
  try{
    const d=await api('/api/engine/conversations');
    const items=d.conversas||[];
    list.innerHTML=items.length?'':'<div class="chatitem"><b>Nenhuma conversa encontrada.</b></div>';
    items.forEach(c=>{
      const item=document.createElement('div');
      item.className='chatitem';
      item.innerHTML=`<b>${esc(c.nome||c.telefone||('Pessoa '+c.pessoa_id))}</b><div class="muted">${esc(c.ultima_mensagem||'')}</div><div class="muted">${esc(c.ultima_mensagem_em||'')} ${c.ia_pausada?'· IA pausada':''}</div>`;
      item.onclick=()=>openConversation(c.pessoa_id);
      list.appendChild(item);
    });
  }catch(e){
    list.innerHTML=`<div class="error-state"><b>Não foi possível carregar as conversas.</b><div class="muted">${esc(e.message)}</div><button class="btn" onclick="loadConversations()">Tentar novamente</button></div>`;
  }
}

async function openConversation(id){
  selectedConversationId=id;
  const h=$('#chatHeader'),m=$('#liveMessages'),c=$('#chatComposer');
  h.textContent='Carregando...';m.innerHTML='';c.style.display='none';
  try{
    const d=await api(`/api/engine/conversations/${id}`);
    h.innerHTML=`<b>${esc(d.pessoa?.nome||d.pessoa?.telefone||'Cliente')}</b> · ${esc(d.pessoa?.telefone||'')} · ${d.ia_pausada?'IA pausada':'DENIA ativa'}`;
    m.innerHTML='';
    (d.mensagens||[]).forEach(x=>{
      const b=document.createElement('div');
      b.className='bubble '+(x.direcao==='ENTRADA'?'in':'out');
      b.innerHTML=`<div>${esc(x.conteudo||'')}</div><div class="muted">${esc(x.origem||'')} · ${esc(x.criado_em||'')}</div>`;
      m.appendChild(b);
    });
    c.style.display='block';
    m.scrollTop=m.scrollHeight;
  }catch(e){h.textContent='Erro';m.innerHTML=`<div class="muted">${esc(e.message)}</div>`}
}

$('#sendReply')?.addEventListener('click',async()=>{
  if(!selectedConversationId)return;
  const input=$('#replyText'),txt=input.value.trim();if(!txt)return;
  $('#sendReply').disabled=true;
  try{
    await api(`/api/engine/conversations/${selectedConversationId}/send`,{method:'POST',body:JSON.stringify({mensagem:txt})});
    input.value='';await openConversation(selectedConversationId);await loadConversations();
  }catch(e){alert('Não foi possível enviar: '+e.message)}
  finally{$('#sendReply').disabled=false}
});
$('#takeoverBtn')?.addEventListener('click',async()=>{
  if(!selectedConversationId)return;
  try{await api(`/api/engine/conversations/${selectedConversationId}/takeover`,{method:'POST',body:'{}'});await openConversation(selectedConversationId)}
  catch(e){alert(e.message)}
});
$('#releaseBtn')?.addEventListener('click',async()=>{
  if(!selectedConversationId)return;
  try{await api(`/api/engine/conversations/${selectedConversationId}/release`,{method:'POST',body:'{}'});await openConversation(selectedConversationId)}
  catch(e){alert(e.message)}
});

async function loadLiveTraining(){
  const el=$('#liveTraining');if(!el)return;
  try{const d=await api('/api/engine/training');el.value=JSON.stringify(d.treinamento||{},null,2);$('#trainingStatus').textContent='Treinamento carregado da DENIA Engine.'}
  catch(e){$('#trainingStatus').textContent='Falha: '+e.message}
}
$('#saveLiveTraining')?.addEventListener('click',async()=>{
  try{
    const data=JSON.parse($('#liveTraining').value||'{}');
    await api('/api/engine/training',{method:'POST',body:JSON.stringify(data)});
    $('#trainingStatus').textContent='Treinamento salvo na DENIA Engine.';
  }catch(e){$('#trainingStatus').textContent='Erro: '+e.message}
});

async function loadProfessionals(){
  const box=$('#professionalsRows');if(!box)return;
  box.innerHTML='<div class="loading-state"><span class="ai-loader"></span><div><b>Sincronizando profissionais</b><small>Consultando a base operacional real…</small></div></div>';
  try{
    const d=await api('/api/engine/professionals');const items=d.profissionais||[];
    box.innerHTML=items.length?'':'<div class="row"><span>Nenhum profissional cadastrado.</span></div>';
    items.forEach(p=>{
      const r=document.createElement('div');r.className='row';
      r.innerHTML=`<span><b>${esc(p.nome||'Sem nome')}</b><div class="muted">${esc(p.telefone||'')}</div></span><span>${esc(p.especialidades||'')}</span>`;
      box.appendChild(r);
    });
  }catch(e){box.innerHTML=`<div class="row"><span>Falha: ${esc(e.message)}</span></div>`}
}

// recarrega dados reais quando a respectiva aba é aberta
$$('#nav button').forEach(b=>b.addEventListener('click',()=>{
  if(b.dataset.page==='conversas')loadConversations();
  if(b.dataset.page==='treino')loadLiveTraining();
  if(b.dataset.page==='prestadores')loadProfessionals();
}));
loadEngineStatus();


// ============================================================================
// DENIA V12 — EXPERIÊNCIA INTERNA IMERSIVA + DIAGNÓSTICO
// ============================================================================
function showSystemAlert(message,type='info'){
  let box=document.getElementById('systemAlert');
  if(!box){
    box=document.createElement('div');
    box.id='systemAlert';
    box.className='system-alert';
    document.body.appendChild(box);
  }
  box.className='system-alert show '+type;
  box.innerHTML=`<span class="alert-core"></span><div>${esc(message)}</div><button aria-label="Fechar">×</button>`;
  box.querySelector('button').onclick=()=>box.classList.remove('show');
}

function installImmersiveUI(){
  // fundo de partículas
  const canvas=document.createElement('canvas');
  canvas.id='appFxCanvas';
  document.body.prepend(canvas);
  const ctx=canvas.getContext('2d');
  let w=0,h=0,dpr=Math.min(devicePixelRatio||1,2),pts=[];
  function resize(){
    w=innerWidth;h=innerHeight;
    canvas.width=w*dpr;canvas.height=h*dpr;
    canvas.style.width=w+'px';canvas.style.height=h+'px';
    ctx.setTransform(dpr,0,0,dpr,0,0);
    const count=Math.max(24,Math.min(70,Math.floor(w/22)));
    pts=Array.from({length:count},()=>({x:Math.random()*w,y:Math.random()*h,vx:(Math.random()-.5)*.15,vy:(Math.random()-.5)*.15,r:Math.random()*1.1+.25,a:Math.random()*.36+.08}));
  }
  resize();addEventListener('resize',resize);
  (function draw(){
    ctx.clearRect(0,0,w,h);
    for(const p of pts){
      p.x+=p.vx;p.y+=p.vy;
      if(p.x<0)p.x=w;if(p.x>w)p.x=0;if(p.y<0)p.y=h;if(p.y>h)p.y=0;
      ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.fillStyle=`rgba(84,220,255,${p.a})`;ctx.fill();
    }
    requestAnimationFrame(draw);
  })();

  // mouse / dedo luminoso
  const glow=document.createElement('div');
  glow.className='app-pointer-glow';
  document.body.appendChild(glow);
  const coarse=matchMedia('(pointer:coarse)').matches;
  if(coarse){
    const move=e=>{
      const t=e.touches?.[0]; if(!t)return;
      glow.style.left=t.clientX+'px';glow.style.top=t.clientY+'px';glow.style.opacity='.9';
    };
    addEventListener('touchstart',move,{passive:true});
    addEventListener('touchmove',move,{passive:true});
    addEventListener('touchend',()=>glow.style.opacity='.18',{passive:true});
  }else{
    addEventListener('mousemove',e=>{
      glow.style.left=e.clientX+'px';glow.style.top=e.clientY+'px';glow.style.opacity='.72';
    });
  }

  // cards 3D
  document.querySelectorAll('.card,.panel,.chatwindow,.chatlist').forEach(el=>{
    if(coarse)return;
    el.addEventListener('mousemove',e=>{
      const r=el.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;
      const rx=((y/r.height)-.5)*-2.3,ry=((x/r.width)-.5)*2.3;
      el.style.transform=`perspective(1100px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(-2px)`;
      el.style.setProperty('--mx',x+'px');el.style.setProperty('--my',y+'px');
    });
    el.addEventListener('mouseleave',()=>el.style.transform='');
  });

  // ripple nos botões
  document.querySelectorAll('button,.btn').forEach(btn=>{
    btn.addEventListener('click',e=>{
      const r=btn.getBoundingClientRect();
      const dot=document.createElement('span');
      dot.className='btn-ripple';
      dot.style.left=(e.clientX-r.left)+'px';dot.style.top=(e.clientY-r.top)+'px';
      btn.appendChild(dot);setTimeout(()=>dot.remove(),650);
    });
  });
}
installImmersiveUI();

// se a aba já estiver aberta por hash / navegação, busca dados
setTimeout(()=>{
  const active=document.querySelector('#nav button.active')?.dataset.page;
  if(active==='conversas')loadConversations();
  if(active==='treino')loadLiveTraining();
  if(active==='prestadores')loadProfessionals();
},250);
