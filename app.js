
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
async function api(url,opts={}){
  const c=new AbortController(),t=setTimeout(()=>c.abort(),10000);
  try{
    const r=await fetch(url,{...opts,signal:c.signal,headers:{'content-type':'application/json',...(opts.headers||{})}});
    if(r.status===401){location.href='/login';throw new Error('Sessão expirada.')}
    const j=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(j.error||j.erro||`Erro ${r.status}`);
    return j;
  }finally{clearTimeout(t)}
}
function toast(msg){
  let e=$('#standaloneToast');if(!e){e=document.createElement('div');e.id='standaloneToast';e.className='system-alert';document.body.appendChild(e)}
  e.className='system-alert show';e.innerHTML=`<span class="alert-core"></span><div>${esc(msg)}</div><button>×</button>`;
  e.querySelector('button').onclick=()=>e.classList.remove('show');setTimeout(()=>e.classList.remove('show'),3500);
}
function showModal(title,html){$('#modalTitle').textContent=title;$('#modalBody').innerHTML=html;$('#modalBackdrop').classList.add('open')}
function closeModal(){$('#modalBackdrop').classList.remove('open')}
$('#modalClose').onclick=closeModal;$('#modalBackdrop').addEventListener('click',e=>{if(e.target===$('#modalBackdrop'))closeModal()});

$$('#nav button').forEach(b=>b.addEventListener('click',()=>{
  $$('#nav button').forEach(x=>x.classList.remove('active'));b.classList.add('active');
  $$('.page').forEach(p=>p.classList.remove('active'));$('#page-'+b.dataset.page).classList.add('active');
  history.replaceState(null,'','#'+b.dataset.page);
  if(b.dataset.page==='conversas')loadConversations();
  if(b.dataset.page==='prestadores')loadProfessionals();
  if(b.dataset.page==='treino')loadTrainingSection(currentTrainingSection);
}));
$('#homeBtn').onclick=()=>location.href='/';
$('#logoutBtn').onclick=async()=>{await api('/api/auth/logout',{method:'POST'}).catch(()=>{});location.href='/login'};

async function init(){
  try{
    const me=await api('/api/me');
    $('#userName').textContent=me.user.name+' · '+me.user.email;$('#orgName').textContent=me.organization.name;$('#orgInput').value=me.organization.name;
    const cfg=await api('/api/config');$('#phoneInput').value=cfg.settings?.phone||'+55 21 97546-9162';$('#assistantNameInput').value=cfg.settings?.assistantName||'DENIA';
    await loadSummary();
  }catch(e){toast('Falha ao carregar a conta: '+e.message)}
}
async function loadSummary(){const s=await api('/api/standalone/summary');$('#metricConversations').textContent=s.conversations;$('#metricProfessionals').textContent=s.professionals}

// Conversas de teste
let currentConversation=null;
async function loadConversations(){
  const box=$('#localChatList');box.innerHTML='<div class="loading-state"><span class="ai-loader"></span><div><b>Carregando ambiente de teste</b></div></div>';
  try{
    const d=await api('/api/standalone/conversations');box.innerHTML='';
    if(!d.conversations.length)box.innerHTML='<div class="empty-state">Nenhuma conversa ainda.<br><small>Crie uma conversa de teste para experimentar o painel.</small></div>';
    d.conversations.forEach(c=>{const el=document.createElement('div');el.className='chatitem';el.innerHTML=`<b>${esc(c.name)}</b><div class="muted">${c.ai_paused?'IA pausada':'IA ativa'} · teste local</div>`;el.onclick=()=>openConversation(c.id);box.appendChild(el)});
  }catch(e){box.innerHTML=`<div class="error-state"><b>Falha</b><div class="muted">${esc(e.message)}</div></div>`}
}
async function openConversation(id){
  currentConversation=id;const d=await api('/api/standalone/conversations/'+id);$('#chatHeader').innerHTML=`<b>${esc(d.conversation.name)}</b> · ${d.conversation.ai_paused?'IA pausada':'IA ativa'} · ambiente de teste`;
  $('#localMessages').innerHTML='';
  d.messages.forEach(m=>{const el=document.createElement('div');el.className='bubble '+(m.direction==='in'?'in':'out');el.innerHTML=`${esc(m.content)}<div class="muted">${esc(m.created_at||'')}</div>`;$('#localMessages').appendChild(el)});
  $('#localComposer').style.display='block';$('#toggleAiState').textContent=d.conversation.ai_paused?'Reativar IA':'Pausar IA';$('#toggleAiState').dataset.paused=d.conversation.ai_paused?'1':'0';
}
$('#newConversation').onclick=()=>showModal('Nova conversa de teste',`<div class="field"><label>Nome do cliente</label><input id="modalClientName" value="Cliente de teste"></div><div class="field"><label>Telefone (opcional)</label><input id="modalClientPhone"></div><button class="btn primary" id="modalCreateConversation">Criar conversa</button>`);
document.addEventListener('click',async e=>{if(e.target?.id==='modalCreateConversation'){const name=$('#modalClientName').value,phone=$('#modalClientPhone').value;const r=await api('/api/standalone/conversations',{method:'POST',body:JSON.stringify({name,phone})});closeModal();await loadConversations();await openConversation(r.id);await loadSummary()}});
$('#localSend').onclick=async()=>{if(!currentConversation)return;const content=$('#localReply').value.trim();if(!content)return;await api(`/api/standalone/conversations/${currentConversation}/messages`,{method:'POST',body:JSON.stringify({content})});$('#localReply').value='';await openConversation(currentConversation);toast('Mensagem adicionada ao teste. Nenhum WhatsApp foi enviado.')};
$('#toggleAiState').onclick=async()=>{if(!currentConversation)return;const paused=$('#toggleAiState').dataset.paused!=='1';await api(`/api/standalone/conversations/${currentConversation}/pause`,{method:'POST',body:JSON.stringify({paused})});await openConversation(currentConversation);toast(paused?'IA pausada nesta conversa de teste.':'IA reativada nesta conversa de teste.')};
$('#clearTestConversations').onclick=async()=>{if(confirm('Limpar todas as conversas de teste?')){await api('/api/standalone/conversations/clear',{method:'POST',body:'{}'});currentConversation=null;$('#localMessages').innerHTML='';$('#localComposer').style.display='none';$('#chatHeader').textContent='Selecione ou crie uma conversa de teste';await loadConversations();await loadSummary()}};

// Treinamento
const trainingMeta={
identidade:['Identidade da IA','Como a DENIA deve se apresentar?'],
tom:['Tom de voz','Como a DENIA deve escrever e conversar?'],
servicos:['Serviços','Quais serviços a empresa oferece e como devem ser explicados?'],
precos:['Preços','Como a DENIA deve trabalhar preços, visitas e margens?'],
regras:['Regras operacionais','Quais regras são obrigatórias durante o atendimento?'],
politicas:['Políticas','Quais políticas, limites e exceções devem ser respeitados?'],
memoria:['Memória operacional','Quais fatos e contextos devem ser preservados entre conversas?']
};let currentTrainingSection='identidade',trainingCache={};
async function fetchTraining(){const d=await api('/api/standalone/training');trainingCache=d.training||{}}
async function loadTrainingSection(section){currentTrainingSection=section;if(!Object.keys(trainingCache).length)await fetchTraining();$$('.training-tab').forEach(b=>b.classList.toggle('active',b.dataset.training===section));$('#trainingTitle').textContent=trainingMeta[section][0];$('#trainingLabel').textContent=trainingMeta[section][1];$('#trainingContent').value=trainingCache[section]||''}
$$('.training-tab').forEach(b=>b.onclick=()=>loadTrainingSection(b.dataset.training));
$('#saveStandaloneTraining').onclick=async()=>{const content=$('#trainingContent').value;await api('/api/standalone/training',{method:'POST',body:JSON.stringify({section:currentTrainingSection,content})});trainingCache[currentTrainingSection]=content;$('#trainingSaveStatus').textContent='Salvo agora no D1 da plataforma.';toast('Treinamento salvo.')};

// Profissionais
async function loadProfessionals(){
  const box=$('#professionalsRows');const d=await api('/api/standalone/professionals');box.innerHTML='';
  if(!d.professionals.length){box.innerHTML='<div class="empty-state">Nenhum profissional cadastrado.<br><small>Use “Adicionar profissional” para criar o primeiro.</small></div>';return}
  d.professionals.forEach(p=>{const r=document.createElement('div');r.className='row professional-row';r.innerHTML=`<span><b>${esc(p.name)}</b><div class="muted">${esc(p.phone||'Sem telefone')}</div></span><span><b>${esc(p.specialty||'Sem especialidade')}</b><button class="btn danger mini-delete" data-id="${esc(p.id)}">Excluir</button></span>`;box.appendChild(r)});
}
$('#addProfessional').onclick=()=>showModal('Adicionar profissional',`<div class="field"><label>Nome</label><input id="proName"></div><div class="field"><label>Telefone</label><input id="proPhone"></div><div class="field"><label>Especialidade</label><input id="proSpecialty"></div><div class="field"><label>Observações</label><textarea id="proNotes"></textarea></div><button class="btn primary" id="saveProfessional">Salvar profissional</button>`);
document.addEventListener('click',async e=>{
  if(e.target?.id==='saveProfessional'){await api('/api/standalone/professionals',{method:'POST',body:JSON.stringify({name:$('#proName').value,phone:$('#proPhone').value,specialty:$('#proSpecialty').value,notes:$('#proNotes').value})});closeModal();await loadProfessionals();await loadSummary();toast('Profissional cadastrado.')}
  if(e.target?.classList?.contains('mini-delete')){await api('/api/standalone/professionals/'+e.target.dataset.id,{method:'DELETE'});await loadProfessionals();await loadSummary();toast('Profissional removido.')}
});

// Configurações
$('#saveConfig').onclick=async()=>{const settings={organization:$('#orgInput').value,phone:$('#phoneInput').value,assistantName:$('#assistantNameInput').value};await api('/api/config/settings',{method:'POST',body:JSON.stringify(settings)});$('#orgName').textContent=settings.organization;toast('Configurações salvas.')};

// Relatório
$('#generateReport').onclick=async()=>{const s=await api('/api/standalone/summary');$('#reportPreview').style.display='block';$('#reportBody').innerHTML=`<h3>Relatório de prévia</h3><p><b>Conversas de teste:</b> ${s.conversations}</p><p><b>Profissionais cadastrados:</b> ${s.professionals}</p><p><b>Integrações reais:</b> ainda não conectadas</p><p class="muted">Esta é uma prévia da experiência. Quando a Engine for conectada, este módulo usará os dados reais da operação.</p>`;$('#reportHistory').textContent='Última prévia gerada agora.'};
$('#closeReport').onclick=()=>$('#reportPreview').style.display='none';

// Botões informativos
$$('.action-info').forEach(b=>b.onclick=()=>showModal('Integração preparada',`<p class="lead" style="margin:0">${esc(b.dataset.message)}</p><button class="btn primary" onclick="document.getElementById('modalClose').click()">Entendi</button>`));
$$('[data-period]').forEach(b=>b.onclick=()=>{$$('[data-period]').forEach(x=>x.classList.remove('active-filter'));b.classList.add('active-filter');toast('Período alterado. Os indicadores reais entrarão após a integração.')});

// UI imersiva
function immersive(){
  const canvas=document.createElement('canvas');canvas.id='appFxCanvas';document.body.prepend(canvas);const ctx=canvas.getContext('2d');let w,h,dpr=Math.min(devicePixelRatio||1,2),p=[];
  function resize(){w=innerWidth;h=innerHeight;canvas.width=w*dpr;canvas.height=h*dpr;canvas.style.width=w+'px';canvas.style.height=h+'px';ctx.setTransform(dpr,0,0,dpr,0,0);p=Array.from({length:Math.max(25,Math.min(70,Math.floor(w/20)))},()=>({x:Math.random()*w,y:Math.random()*h,vx:(Math.random()-.5)*.14,vy:(Math.random()-.5)*.14,r:Math.random()+.3,a:Math.random()*.32+.08}))}
  resize();addEventListener('resize',resize);(function draw(){ctx.clearRect(0,0,w,h);p.forEach(q=>{q.x+=q.vx;q.y+=q.vy;if(q.x<0)q.x=w;if(q.x>w)q.x=0;if(q.y<0)q.y=h;if(q.y>h)q.y=0;ctx.beginPath();ctx.arc(q.x,q.y,q.r,0,Math.PI*2);ctx.fillStyle=`rgba(84,220,255,${q.a})`;ctx.fill()});requestAnimationFrame(draw)})();
  const glow=document.createElement('div');glow.className='app-pointer-glow';document.body.appendChild(glow);const coarse=matchMedia('(pointer:coarse)').matches;
  if(coarse){const mv=e=>{const t=e.touches?.[0];if(!t)return;glow.style.left=t.clientX+'px';glow.style.top=t.clientY+'px';glow.style.opacity='1'};addEventListener('touchstart',mv,{passive:true});addEventListener('touchmove',mv,{passive:true});addEventListener('touchend',()=>glow.style.opacity='.42',{passive:true})}
  else addEventListener('mousemove',e=>{glow.style.left=e.clientX+'px';glow.style.top=e.clientY+'px';glow.style.opacity='.9'});
  document.querySelectorAll('.interactive-card,.panel,.chatwindow,.chatlist').forEach(el=>{if(coarse)return;el.addEventListener('mousemove',e=>{const r=el.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;el.style.transform=`perspective(1100px) rotateX(${((y/r.height)-.5)*-2.4}deg) rotateY(${((x/r.width)-.5)*2.4}deg) translateY(-2px)`;el.style.setProperty('--mx',x+'px');el.style.setProperty('--my',y+'px')});el.addEventListener('mouseleave',()=>el.style.transform='')});
}
immersive();

const hash=location.hash.replace('#','');if(hash&&$('#page-'+hash))document.querySelector(`[data-page="${hash}"]`)?.click();
init();loadTrainingSection('identidade');

// V14 RESPONSIVE
(function(){
  const sidebar=document.getElementById('sidebar');
  const overlay=document.getElementById('mobileNavOverlay');
  const openBtn=document.getElementById('mobileMenuBtn');
  const closeBtn=document.getElementById('mobileCloseBtn');
  if(!sidebar||!overlay||!openBtn||!closeBtn)return;
  function openMenu(){
    sidebar.classList.add('mobile-open');
    overlay.classList.add('open');
    document.body.classList.add('nav-open');
    openBtn.setAttribute('aria-expanded','true');
  }
  function closeMenu(){
    sidebar.classList.remove('mobile-open');
    overlay.classList.remove('open');
    document.body.classList.remove('nav-open');
    openBtn.setAttribute('aria-expanded','false');
  }
  openBtn.addEventListener('click',openMenu);
  closeBtn.addEventListener('click',closeMenu);
  overlay.addEventListener('click',closeMenu);
  document.querySelectorAll('#nav button').forEach(b=>b.addEventListener('click',()=>{
    if(matchMedia('(max-width:900px)').matches) closeMenu();
  }));
  addEventListener('keydown',e=>{if(e.key==='Escape')closeMenu()});
  const mq=matchMedia('(min-width:901px)');
  const reset=e=>{if(e.matches)closeMenu()};
  if(mq.addEventListener)mq.addEventListener('change',reset);else mq.addListener(reset);
  if(window.visualViewport){
    const apply=()=>document.documentElement.style.setProperty('--vvh',window.visualViewport.height+'px');
    apply();
    window.visualViewport.addEventListener('resize',apply);
  }
})();

// DENIA V15 — proteção contra deslocamento horizontal do documento
(function(){
  const clampHorizontal=()=>{
    if(window.scrollX!==0) window.scrollTo(0, window.scrollY);
  };
  window.addEventListener('scroll',clampHorizontal,{passive:true});
  window.addEventListener('resize',clampHorizontal,{passive:true});
  window.addEventListener('orientationchange',()=>setTimeout(clampHorizontal,60),{passive:true});
})();
