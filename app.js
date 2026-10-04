
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
async function api(url,opts={}){const r=await fetch(url,{...opts,headers:{'content-type':'application/json',...(opts.headers||{})}});if(r.status===401){location.href='/login';throw new Error('unauthorized')}const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Erro');return j}
$$('#nav button').forEach(b=>b.onclick=()=>{$$('#nav button').forEach(x=>x.classList.remove('active'));b.classList.add('active');$$('.page').forEach(p=>p.classList.remove('active'));$('#page-'+b.dataset.page).classList.add('active')});
$('#homeBtn').onclick=()=>{const p=location.pathname;location.href=p.startsWith('/en/')?'/en':p.startsWith('/es/')?'/es':'/'};
$('#logoutBtn').onclick=async()=>{await api('/api/auth/logout',{method:'POST'}).catch(()=>{});const p=location.pathname;location.href=p.startsWith('/en/')?'/en/login':p.startsWith('/es/')?'/es/login':'/login'};
$('#saveTraining').onclick=async()=>{await api('/api/config/training',{method:'POST',body:JSON.stringify({identity:$('#identity').value,rules:$('#rules').value})});alert('Treinamento salvo.')};
$('#saveConfig').onclick=async()=>{await api('/api/config/settings',{method:'POST',body:JSON.stringify({organization:$('#orgInput').value,phone:$('#phoneInput').value})});$('#orgName').textContent=$('#orgInput').value;alert('Configurações salvas.')};
(async()=>{try{const me=await api('/api/me');$('#userName').textContent=me.user.name+' · '+me.user.email;$('#orgName').textContent=me.organization.name;$('#orgInput').value=me.organization.name;const c=await api('/api/config');$('#identity').value=c.training?.identity||'';$('#rules').value=c.training?.rules||'';$('#phoneInput').value=c.settings?.phone||'+55 21 97546-9162';}catch(e){}})();


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
    if($('#engineStatus'))$('#engineStatus').textContent='Offline';
    if($('#engineStatusText'))$('#engineStatusText').textContent=e.message;
  }
}

async function loadConversations(){
  const list=$('#liveChatList'); if(!list)return;
  list.innerHTML='<div class="chatitem"><b>Carregando...</b></div>';
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
  }catch(e){list.innerHTML=`<div class="chatitem"><b>Falha ao carregar</b><div class="muted">${esc(e.message)}</div></div>`}
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
