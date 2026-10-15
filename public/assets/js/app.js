// DENIA — painel (centro de comando multiempresa)
// Todo conteúdo vindo do servidor é inserido como texto (nunca como HTML).
(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Utilidades de interface
  // ---------------------------------------------------------------------------

  const $ = id => document.getElementById(id);
  function h(tag, props, ...filhos) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "style") el.style.cssText = v; // via CSSOM: permitido pela CSP
      else if (k === "value") el.value = v;
      else if (k === "checked" || k === "disabled" || k === "selected" || k === "readOnly") el[k] = Boolean(v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const f of filhos.flat(Infinity)) {
      if (f === undefined || f === null || f === false) continue;
      el.appendChild(f instanceof Node ? f : document.createTextNode(String(f)));
    }
    return el;
  }
  const SVG_NS = "http://www.w3.org/2000/svg";
  function icone(caminhos) {
    const s = document.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    for (const d of caminhos) { const p = document.createElementNS(SVG_NS, "path"); p.setAttribute("d", d); s.appendChild(p); }
    return s;
  }
  const ICONES = {
    conversa: ["M21 12a8.5 8.5 0 0 1-12.6 7.4L3 21l1.6-5.2A8.5 8.5 0 1 1 21 12z"],
    caixa: ["M3 7l9-4 9 4-9 4-9-4z", "M3 7v10l9 4 9-4V7"],
    nuvem: ["M7 18a5 5 0 1 1 .9-9.9A6 6 0 0 1 19 10a4 4 0 0 1 0 8H7z", "M12 12v6M9.5 14.5 12 12l2.5 2.5"],
    cerebro: ["M9.5 3a3.5 3.5 0 0 0-3.4 4.3A3.5 3.5 0 0 0 4 13.6 3.5 3.5 0 0 0 8 19a3 3 0 0 0 4 1.2V4.4A3.5 3.5 0 0 0 9.5 3z", "M14.5 3a3.5 3.5 0 0 1 3.4 4.3 3.5 3.5 0 0 1 2.1 6.3A3.5 3.5 0 0 1 16 19a3 3 0 0 1-4 1.2"],
    elo: ["M9 7H6a4 4 0 0 0 0 8h3M15 7h3a4 4 0 0 1 0 8h-3M8 11h8"],
    foguete: ["M5 15c-1.5 1.3-2 4-2 6 2 0 4.7-.5 6-2", "M9 15l-3-3c1-4 4.5-9 12-9 0 7.5-5 11-9 12z", "M14.5 9.5a1 1 0 1 0 0-.01"]
  };

  function aviso(texto, tipo) {
    if (tipo === "erro" && piloto.ativo) piloto.erros.push(texto);
    const el = h("div", { class: "aviso" + (tipo ? " aviso-" + tipo : ""), role: tipo === "erro" ? "alert" : "status", text: texto });
    $("avisos").appendChild(el);
    setTimeout(() => el.remove(), Math.max(tipo === "erro" ? 7000 : 4200, String(texto).length * 70));
  }

  let fecharModal = null;
  function modal({ titulo, conteudo, confirmar = "Confirmar", cancelar = "Cancelar", perigo = false, soInformar = false }) {
    return new Promise(resolve => {
      const m = $("modal"), ok = $("modal-confirmar"), cancel = $("modal-cancelar");
      $("modal-titulo").textContent = titulo;
      const corpo = $("modal-texto");
      corpo.replaceChildren(...[].concat(conteudo).map(c => typeof c === "string" ? h("p", { text: c }) : c));
      ok.textContent = soInformar ? "Entendi" : confirmar;
      ok.className = "btn " + (perigo ? "btn-perigo" : "btn-primario");
      cancel.textContent = cancelar;
      cancel.classList.toggle("oculto", soInformar);
      m.classList.remove("oculto");
      const anterior = document.activeElement;
      const fim = valor => {
        m.classList.add("oculto");
        ok.onclick = cancel.onclick = null;
        document.removeEventListener("keydown", tecla);
        fecharModal = null;
        if (anterior && anterior.focus) anterior.focus();
        resolve(valor);
      };
      const tecla = e => { if (e.key === "Escape") fim(false); };
      ok.onclick = () => fim(true);
      cancel.onclick = () => fim(false);
      document.addEventListener("keydown", tecla);
      fecharModal = () => fim(false);
      ok.focus();
    });
  }

  function dataDe(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") return new Date(v);
    const s = String(v);
    // SQLite grava CURRENT_TIMESTAMP em UTC, sem fuso.
    return new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? s.replace(" ", "T") + "Z" : s);
  }
  const IDIOMA = window.DENIA_IDIOMA || "pt-BR", LOCALE = window.DENIA_LOCALE || "pt-BR";
  const fmtDataHora = new Intl.DateTimeFormat(LOCALE, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const fmtHora = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit" });
  function quando(v) {
    const d = dataDe(v);
    if (!d || isNaN(d)) return "—";
    const hoje = new Date();
    return d.toDateString() === hoje.toDateString() ? `Hoje, ${fmtHora.format(d)}` : fmtDataHora.format(d);
  }
  // Para o meio de frases: "atualizado hoje, às 15:02" / "em 08/10/2026, às 15:02".
  function quandoFrase(v) {
    const d = dataDe(v);
    if (!d || isNaN(d)) return "—";
    const hora = fmtHora.format(d);
    if (d.toDateString() === new Date().toDateString()) return `hoje, às ${hora}`;
    const data = new Intl.DateTimeFormat(LOCALE, { day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
    return `em ${data}, às ${hora}`;
  }
  function telefone(t) {
    const d = String(t || "").replace(/\D/g, "");
    const m = d.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
    return m ? `(${m[1]}) ${m[2]}-${m[3]}` : d || "—";
  }
  function iniciais(nome) {
    const p = String(nome || "?").trim().split(/\s+/);
    return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
  }
  const numero = n => new Intl.NumberFormat(LOCALE).format(Number(n) || 0);
  const carregando = (texto = "Carregando…") => h("div", { class: "carregando", text: texto });
  function vazio(titulo, texto, ic = ICONES.caixa) { return h("div", { class: "vazio" }, icone(ic), h("strong", { text: titulo }), texto ? h("span", { text: texto }) : null); }
  function cabeca(titulo, texto, ...acoes) {
    return h("div", { class: "pagina-cabeca" }, h("div", {}, h("h2", { text: titulo }), texto ? h("p", { text: texto }) : null), acoes.length ? h("div", { class: "acoes" }, acoes) : null);
  }
  function botao(texto, aoClicar, classe = "btn-secundario", extra = {}) {
    const b = h("button", { class: "btn " + classe, type: "button", ...extra }, texto);
    if (aoClicar) b.addEventListener("click", async e => {
      if (b.disabled) return;
      b.disabled = true;
      try { await aoClicar(e, b); } finally { if (b.isConnected) b.disabled = false; }
    });
    return b;
  }
  function selo(texto, tipo) { return h("span", { class: "selo" + (tipo ? " selo-" + tipo : "") }, h("span", { class: "ponto" }), texto); }
  function campo(rotulo, entrada, dica) {
    if (!entrada.id) entrada.id = "c" + Math.random().toString(36).slice(2, 9);
    return h("div", { class: "campo" }, h("label", { for: entrada.id, text: rotulo }), entrada, dica ? h("p", { class: "dica", text: dica, style: "margin:0;font-size:13px;color:var(--texto-3)" }) : null);
  }
  async function copiar(texto) {
    try { await navigator.clipboard.writeText(texto); aviso("Copiado.", "ok"); }
    catch { aviso("Não foi possível copiar. Selecione e copie manualmente.", "erro"); }
  }
  const armazenamento = {
    ler(k) { try { return localStorage.getItem(k); } catch { return null; } },
    gravar(k, v) { try { localStorage.setItem(k, v); } catch { /* navegação privada */ } }
  };

  // ---------------------------------------------------------------------------
  // Comunicação com o servidor
  // ---------------------------------------------------------------------------

  class ErroApi extends Error { constructor(msg, status, dados) { super(msg); this.status = status; this.dados = dados || {}; } }
  async function api(caminho, { metodo = "GET", corpo } = {}) {
    let r;
    try {
      r = await fetch(caminho, {
        method: metodo, credentials: "same-origin",
        headers: { accept: "application/json", "x-denia": "1", "x-denia-idioma": IDIOMA, ...(corpo !== undefined ? { "content-type": "application/json" } : {}) },
        body: corpo !== undefined ? JSON.stringify(corpo) : undefined
      });
    } catch { throw new ErroApi("Sem conexão. Verifique a internet e tente novamente.", 0); }
    let dados = null;
    try { dados = await r.json(); } catch { dados = null; }
    if (r.status === 401) { window.location.replace("/entrar"); throw new ErroApi("Sua sessão expirou.", 401); }
    if (r.status === 403 && dados && dados.codigo === "TROCAR_SENHA") { estado.eu.usuario.trocar_senha = true; location.hash = "#/conta"; }
    if (!r.ok) throw new ErroApi((dados && dados.erro) || "Algo deu errado. Tente novamente.", r.status, dados);
    return dados || {};
  }
  // Respostas do Engine guardadas por alguns segundos: voltar a uma tela é instantâneo.
  const cacheEng = new Map();
  async function eng(caminho, op) {
    const url = `/api/orgs/${estado.org.id}/engine/${caminho}`;
    if (op && op.metodo && op.metodo !== "GET") { cacheEng.clear(); cacheConversa.clear(); return api(url, op); }
    const c = cacheEng.get(url);
    if (c && !(op && op.fresco) && Date.now() - c.em < 25000) return c.dados;
    const d = await api(url, op);
    cacheEng.set(url, { em: Date.now(), dados: d });
    if (cacheEng.size > 60) cacheEng.delete(cacheEng.keys().next().value);
    return d;
  }
  // Lista de conversas guardada na aba (some ao fechar o navegador) para abrir na hora.
  const sessao = {
    ler(k) { try { return JSON.parse(sessionStorage.getItem(k) || "null"); } catch { return null; } },
    gravar(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* sem espaço ou bloqueado */ } }
  };
  const org = (caminho, op) => api(`/api/orgs/${estado.org.id}/${caminho}`, op);
  function falha(el, e) {
    const conectar = e && e.dados && e.dados.codigo === "ENGINE_NAO_CONFIGURADO";
    el.replaceChildren(h("div", { class: "cartao vidro" },
      vazio(conectar ? "A IA desta empresa ainda não foi conectada" : "Não foi possível carregar", e ? e.message : "", conectar ? ICONES.elo : ICONES.caixa),
      conectar && pode("ADMIN") ? h("div", { class: "acoes", style: "justify-content:center" }, h("a", { class: "btn btn-primario", href: "#/integracoes" }, "Conectar agora")) : null));
  }

  // ---------------------------------------------------------------------------
  // Estado, permissões e navegação
  // ---------------------------------------------------------------------------

  const estado = { eu: null, org: null, papel: null, status: null, render: 0 };
  const NIVEL = { VISUALIZADOR: 1, AGENTE: 2, ADMIN: 3, OWNER: 4 };
  const pode = minimo => (NIVEL[estado.papel] || 0) >= NIVEL[minimo];
  // Revisor de aprendizados: só a tela de Aprendizados (e a própria conta).
  const ehRevisor = () => estado.papel === "REVISOR";
  const ROTAS_REVISOR = ["aprendizados", "conta"];

  const ETAPAS = [
    ["COLETANDO", "Coletando informações"],
    ["AGUARDANDO_PRESTADOR", "Aguardando profissional"],
    ["AGUARDANDO_CONFIRMACAO_PRESTADOR", "Confirmando com o profissional"],
    ["AGUARDANDO_CLIENTE", "Aguardando cliente"],
    ["AGUARDANDO_ENDERECO", "Aguardando endereço"],
    ["EQUIPE", "Com a equipe"],
    ["AGENDADO", "Agendado"],
    ["EM_ANDAMENTO", "Serviço em andamento"],
    ["CONCLUIDO", "Concluído"],
    ["CANCELADO", "Cancelado"]
  ];
  const NOME_ETAPA = Object.fromEntries(ETAPAS);
  const ETAPAS_MANUAIS = ["COLETANDO", "EQUIPE", "AGENDADO", "EM_ANDAMENTO", "CONCLUIDO", "CANCELADO"];
  const PAPEIS = [["OWNER", "Proprietário"], ["ADMIN", "Administrador"], ["AGENTE", "Atendente"], ["VISUALIZADOR", "Somente leitura"], ["REVISOR", "Revisor de aprendizados"]];
  const NOME_PAPEL = Object.fromEntries(PAPEIS);

  const ROTAS = {
    painel: { titulo: "Painel", render: paginaPainel },
    denia: { titulo: "DENIA por voz", render: paginaDenia },
    conversas: { titulo: "Conversas", render: paginaConversas },
    atendimentos: { titulo: "Atendimentos", render: paginaAtendimentos },
    profissionais: { titulo: "Profissionais", render: paginaProfissionais },
    treinamento: { titulo: "Treinar IA", render: paginaTreinamento },
    aprendizados: { titulo: "Aprendizados", render: paginaAprendizados },
    clientes: { titulo: "Base de clientes", render: paginaClientes },
    integracoes: { titulo: "Integrações", render: paginaIntegracoes },
    consumo: { titulo: "Consumo e custos", render: paginaConsumo, minimo: "ADMIN" },
    equipe: { titulo: "Equipe", render: paginaEquipe, minimo: "ADMIN" },
    auditoria: { titulo: "Auditoria", render: paginaAuditoria, minimo: "ADMIN" },
    empresas: { titulo: "Empresas", render: paginaEmpresas, superAdmin: true },
    conta: { titulo: "Conta e segurança", render: paginaConta },
    guia: { titulo: "Guia de lojas", render: paginaGuia },
    chatbot: { titulo: "Chatbot do WhatsApp", render: paginaChatbot },
    plano: { titulo: "Plano e pagamento", render: paginaPlano },
    whatsapp: { titulo: "WhatsApp", render: paginaWhatsapp },
    instagram: { titulo: "Instagram", render: (el, aba, vivo) => paginaCanalSocial(el, "instagram", vivo, aba) },
    facebook: { titulo: "Facebook", render: (el, aba, vivo) => paginaCanalSocial(el, "facebook", vivo, aba) },
    google: { titulo: "Google Meu Negócio", render: paginaGoogle },
    social: { titulo: "Instagram", render: (el, aba, vivo) => paginaCanalSocial(el, "instagram", vivo, aba) },
    estudio: { titulo: "Estúdio de Marketing", render: paginaEstudio },
    calendario: { titulo: "Calendário", render: paginaCalendario },
    aprovacoes: { titulo: "Aprovações", render: paginaAprovacoes },
    marcas: { titulo: "Marcas", render: paginaMarcas },
    contatos: { titulo: "Contatos do site", render: paginaContatos, superAdmin: true }
  };

  function rotaAtual() {
    const partes = (location.hash || "#/painel").replace(/^#\/?/, "").split("/");
    return { nome: ROTAS[partes[0]] ? partes[0] : "painel", param: partes[1] || "" };
  }

  async function navegar() {
    if (!estado.eu) return;
    let { nome, param } = rotaAtual();
    if (estado.eu.usuario.trocar_senha) nome = "conta";
    else if (ehRevisor() && !ROTAS_REVISOR.includes(nome)) nome = "aprendizados";
    const rota = ROTAS[nome];
    // Dentro de Conversas, abrir outra conversa não recarrega a página inteira.
    const viva = estado.paginaViva;
    if (viva && viva.nome === nome && viva.org === (estado.org && estado.org.id) && viva.el.isConnected && viva.trocar) {
      viva.trocar(param);
      return;
    }
    estado.paginaViva = null;
    const id = ++estado.render;
    document.querySelectorAll("#lateral-nav a").forEach(a => a.classList.toggle("ativo", a.dataset.rota === nome));
    $("titulo-pagina").replaceChildren(estado.org ? h("span", { class: "migalha", text: estado.org.nome + " / " }) : "", rota.titulo);
    document.title = rota.titulo + " — DENIA";
    fecharMenu();
    const el = $("conteudo");
    el.replaceChildren();
    if (fecharModal) fecharModal();
    if (fecharGaveta) fecharGaveta();
    if (!estado.org && nome !== "conta" && nome !== "empresas") { semEmpresa(el); return; }
    if ((rota.minimo && !pode(rota.minimo)) || (rota.superAdmin && !estado.eu.usuario.super_admin)) {
      el.appendChild(h("div", { class: "cartao vidro" }, vazio("Acesso restrito", "Seu perfil não tem acesso a esta área.")));
      return;
    }
    if (estado.org && !ROTAS_LIVRES.includes(nome) && !temRecurso(RECURSO_DA_ROTA[nome] || null) || estado.org && !estado.eu.usuario.super_admin && !acessoAtual().liberado && !ROTAS_LIVRES.includes(nome)) { telaTravada(el, RECURSO_DA_ROTA[nome]); return; }
    el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";
    // Aviso da chave: só no Painel, e some de vez depois de colar a chave uma vez (ou ao tocar em "Agora não").
    if (estado.iaLigada === false && nome === "painel" && !sessao.ler("denia_faixa_ia") && !(estado.org && estado.org.chatbot && !estado.org.conectada)) {
      const faixa = h("div", { class: "faixa-ia", role: "status" },
        h("span", {}, h("strong", { text: "Falta um passo para ligar a inteligência da DENIA. " }), "Cole a chave da OpenAI uma única vez em Integrações e pronto: vale para sempre e para todas as empresas."),
        pode("ADMIN") ? h("a", { class: "btn btn-primario btn-pequeno", href: "#/integracoes" }, "Colar a chave") : null,
        h("button", { class: "btn btn-secundario btn-pequeno", type: "button", onclick: () => { sessao.gravar("denia_faixa_ia", 1); faixa.remove(); } }, "Agora não"));
      el.appendChild(faixa);
    }
    try { await rota.render(el, param, () => id === estado.render); }
    catch (e) { if (id === estado.render) falha(el, e); }
  }

  function semEmpresa(el) {
    el.appendChild(h("div", { class: "cartao vidro" }, vazio("Você ainda não faz parte de nenhuma empresa", "Peça ao responsável pela sua empresa para adicionar o seu e-mail na equipe.")));
  }

  // ---------------------------------------------------------------------------
  // Inicialização
  // ---------------------------------------------------------------------------

  function fecharMenu() { $("lateral").classList.remove("aberta"); $("veu").classList.remove("ativo"); $("abrir-menu").setAttribute("aria-expanded", "false"); }
  $("abrir-menu").addEventListener("click", () => {
    const aberto = $("lateral").classList.toggle("aberta");
    $("veu").classList.toggle("ativo", aberto);
    $("abrir-menu").setAttribute("aria-expanded", aberto ? "true" : "false");
  });
  $("veu").addEventListener("click", fecharMenu);
  $("sair").addEventListener("click", async () => {
    try { await api("/api/sair", { metodo: "POST", corpo: {} }); } catch { /* sai mesmo assim */ }
    window.location.replace("/entrar");
  });

  function escolherEmpresa(id) {
    const lista = estado.eu.organizacoes;
    estado.org = lista.find(o => String(o.id) === String(id)) || lista[0] || null;
    estado.papel = estado.org ? estado.org.papel : null;
    if (estado.org) armazenamento.gravar("denia_empresa", String(estado.org.id));
    const sel = $("empresa-select");
    sel.replaceChildren(...lista.map(o => h("option", { value: o.id, selected: estado.org && o.id === estado.org.id }, o.nome + (o.status === "SUSPENSA" ? " (suspensa)" : ""))));
    if (!lista.length) sel.appendChild(h("option", { text: "Nenhuma empresa" }));
    sel.disabled = lista.length < 2;
    const av = $("empresa-avatar");
    av.textContent = estado.org ? iniciais(estado.org.nome) : "—";
    av.style.background = estado.org && estado.org.cor ? `linear-gradient(135deg, ${estado.org.cor}, #8b5cf6)` : "";
    document.querySelectorAll("#lateral-nav a[data-minimo]").forEach(a => a.classList.toggle("oculto", !pode(a.dataset.minimo)));
    document.querySelectorAll("#lateral-nav a[data-super]").forEach(a => a.classList.toggle("oculto", !estado.eu.usuario.super_admin));
    document.querySelectorAll("#lateral-nav a[data-rota]:not([data-minimo]):not([data-super])").forEach(a => a.classList.toggle("oculto", ehRevisor() && !ROTAS_REVISOR.includes(a.dataset.rota)));
    aplicarModo();
    aplicarPlano();
    // Título de grupo do menu some quando todos os links do grupo estão ocultos.
    document.querySelectorAll("#lateral-nav .lateral-grupo").forEach(g => {
      let el = g.nextElementSibling, algum = false;
      while (el && !el.classList.contains("lateral-grupo")) { if (el.tagName === "A" && !el.classList.contains("oculto")) algum = true; el = el.nextElementSibling; }
      g.classList.toggle("oculto", !algum);
    });
    if (ehRevisor()) $("status-engine").replaceChildren(h("span", { class: "ponto" }), "Revisor de aprendizados");
    else if (!estado.eu.usuario.trocar_senha) {
      atualizarStatus(); atualizarAprovacoes();
      // Confere de novo a cada 3 minutos (entregas do WhatsApp, aprovações e alertas).
      clearInterval(estado.relogioStatus);
      estado.relogioStatus = setInterval(() => { if (document.visibilityState === "visible" && estado.org && estado.org.conectada) { cacheEng.delete(`/api/orgs/${estado.org.id}/engine/status`); atualizarStatus(); } }, 180000);
    }
    else $("status-engine").replaceChildren(h("span", { class: "ponto" }), "Primeiro acesso");
  }

  // Faixa vermelha no topo de todas as páginas quando o WhatsApp não está entregando (motor 31.2+).
  function faixaEntrega(s) {
    const f = $("faixa-global");
    if (!f) return;
    const en = s && s.entregas_24h;
    // Só avisa quando há erro AGORA: falhas antigas, seguidas de entregas confirmadas, já foram resolvidas.
    const pendentes = en ? (en.falhas_pendentes != null ? en.falhas_pendentes : en.falhas) : 0;
    const muitas = en && pendentes >= Math.max(3, (en.total || 0) * 0.2);
    if (!s || (!s.entrega_bloqueada && !muitas)) { f.classList.add("oculto"); f.replaceChildren(); return; }
    const motivo = s.entrega_bloqueada ? s.entrega_bloqueada.erro : ((en.motivos || [])[0] || {}).motivo || "a Meta não confirmou a entrega.";
    f.replaceChildren(h("strong", { text: "⚠ O WhatsApp não está entregando as mensagens." }), h("span", { text: `${motivo}${en ? ` (${numero(pendentes)} mensagem(ns) sem entrega desde a última que chegou)` : ""}. Até resolver, responda pelo celular.` }),
      h("a", { class: "btn btn-secundario btn-pequeno", href: "#/whatsapp/diagnostico" }, "Ver diagnóstico"));
    f.classList.remove("oculto");
  }
  async function atualizarStatus() {
    const chip = $("status-engine");
    const marcar = (texto, tipo) => { chip.className = "selo" + (tipo ? " selo-" + tipo : ""); chip.replaceChildren(h("span", { class: "ponto" }), texto); };
    estado.status = null;
    $("contador-sugestoes").classList.add("oculto");
    if (!estado.org) { marcar("Sem empresa"); return; }
    if (!estado.org.conectada && estado.org.chatbot) { marcar("Chatbot do WhatsApp", "ok"); return; }
    if (!estado.org.conectada) { marcar("IA não conectada", "alerta"); return; }
    const alvo = estado.org.id;
    marcar("Verificando…");
    try {
      const s = await eng("status");
      if (!estado.org || estado.org.id !== alvo) return;
      estado.status = s;
      armazenamento.gravar("denia_modo_" + alvo, s.modo === "guia" ? "guia" : "central");
      aplicarModo();
      faixaEntrega(s);
      if (s.entrega_bloqueada) marcar("WhatsApp sem entregar", "erro");
      else if (s.pausa_geral) marcar("IA pausada", "alerta");
      else if (s.ok) marcar("IA ativa", "ok");
      else marcar("IA com alertas", "erro");
      const l = await eng("learning").catch(() => null);
      const pend = l && l.sugestoes ? Number(l.sugestoes.PENDENTE || 0) : 0;
      if (pend && estado.org && estado.org.id === alvo) { const c = $("contador-sugestoes"); c.textContent = pend > 99 ? "99+" : String(pend); c.classList.remove("oculto"); }
    } catch { if (estado.org && estado.org.id === alvo) marcar("IA indisponível", "erro"); }
  }

  async function verificarIa() {
    if (!estado.org) { estado.iaLigada = null; return; }
    try { estado.iaLigada = Boolean((await org("ia/chave")).configurada); } catch { estado.iaLigada = null; }
  }
  async function recarregarEu(manterId) {
    estado.eu = await api("/api/eu");
    escolherEmpresa(manterId || (estado.org && estado.org.id) || armazenamento.ler("denia_empresa"));
  }

  async function iniciar() {
    try { await recarregarEu(); }
    catch (e) { $("conteudo").replaceChildren(h("div", { class: "cartao vidro" }, vazio("Não foi possível abrir o painel", e.message))); return; }
    const u = estado.eu.usuario;
    $("usuario").textContent = u.nome || u.email;
    $("versao").textContent = "DENIA Platform " + estado.eu.versao;
    $("empresa-select").addEventListener("change", async e => { escolherEmpresa(e.target.value); await verificarIa(); navegar(); });
    window.addEventListener("hashchange", navegar);
    iniciarAssistente();
    await verificarIa();
    navegar();
    // Adianta a lista de conversas enquanto a pessoa olha o painel.
    setTimeout(() => {
      if (!estado.org || !estado.org.conectada || (estado.cacheConversas && estado.cacheConversas.org === estado.org.id)) return;
      const orgId = estado.org.id;
      eng("conversations?limit=80").then(r => { estado.cacheConversas = { org: orgId, lista: r.conversas || [], em: Date.now() }; sessao.gravar("denia_conversas_" + orgId, estado.cacheConversas); }).catch(() => {});
    }, 1200);
  }

  // ---------------------------------------------------------------------------
  // Painel
  // ---------------------------------------------------------------------------

  async function paginaPainel(el, _p, vivo) {
    const u = estado.eu.usuario;
    const hora = new Date().getHours();
    const saudacao = hora < 12 ? "Bom dia" : hora < 18 ? "Boa tarde" : "Boa noite";
    const primeiro = (u.nome || "").split(" ")[0];
    el.appendChild(h("section", { class: "boas-vindas" }, h("div", { class: "orbe" }),
      selo(estado.org.nome, "info"),
      h("h2", {}, `${saudacao}${primeiro ? ", " + primeiro : ""}.`),
      h("p", { text: !estado.org.conectada && estado.org.chatbot ? "Acompanhe o atendimento automático do WhatsApp: mensagens, buscas, horários e quem precisa da equipe." : estado.org.conectada ? "Este é o centro de comando da operação. Acompanhe a IA, as conversas e os atendimentos em tempo real." : "Vamos colocar a inteligência desta empresa para funcionar. O primeiro passo é conectar a IA." }),
      h("div", { class: "acoes" },
        !estado.org.conectada && estado.org.chatbot ? h("a", { class: "btn btn-primario", href: "#/chatbot/conversas" }, "Ver conversas") : estado.org.conectada ? h("a", { class: "btn btn-primario", href: "#/conversas" }, "Ver conversas") : h("a", { class: "btn btn-primario", href: "#/chatbot" }, "Montar o chatbot"),
        !estado.org.conectada && estado.org.chatbot ? h("a", { class: "btn btn-secundario", href: "#/chatbot/menu" }, "Editar o menu") : modoGuia() ? h("a", { class: "btn btn-secundario", href: "#/guia" }, "Guia de lojas") : h("a", { class: "btn btn-secundario", href: "#/treinamento" }, "Treinar a IA"))));

    if (!estado.org.conectada && estado.org.chatbot) {
      const area = h("div", { class: "grade" }, carregando());
      el.appendChild(area);
      try { await abaZapVisao(area, vivo); } catch (e) { if (vivo()) falha(area, e); }
      return;
    }
    if (!estado.org.conectada) {
      el.appendChild(h("section", { class: "grade grade-2" },
        passoInicial("A", "Chatbot do WhatsApp (pronto em minutos)", "Menu com botões e listas, contatos e lojas, e IA opcional para responder o que o cliente escrever. Sem programar.", "#/chatbot"),
        passoInicial("B", "IA completa de atendimento", "A DENIA atende como uma pessoa, consulta profissionais e agenda. Precisa conectar o motor da IA em Integrações.", "#/integracoes")));
      el.appendChild(h("section", { class: "grade grade-3" },
        passoInicial("01", "Conectar a IA", "Informe o endereço e o token do DENIA Engine desta empresa.", "#/integracoes"),
        passoInicial("02", "Ensinar a empresa", "Serviços, preços autorizados, regras e o jeito de falar da equipe.", "#/treinamento"),
        passoInicial("03", "Aprender com o histórico", "A IA lê os últimos 6 meses de conversas e sugere melhorias para você aprovar.", "#/aprendizados")));
      return;
    }

    const metricas = h("section", { class: "grade grade-4" }, [1, 2, 3, 4].map(() => h("div", { class: "esqueleto" })));
    const inferior = h("section", { class: "grade grade-2" });
    el.append(metricas, inferior);
    let s;
    try { s = estado.status || await eng("status"); }
    catch (e) { if (vivo()) falha(inferior, e); metricas.remove(); return; }
    const aprend = await eng("learning").catch(() => null);
    if (!vivo()) return;
    estado.status = s;
    const somar = (lista, filtro) => (lista || []).filter(filtro).reduce((t, x) => t + Number(x.n || 0), 0);
    if (s.modo === "guia") {
      const st = await eng(`guide/stats?de=${isoLocal(new Date(Date.now() - 29 * 86400000))}&ate=${isoLocal(new Date())}`).catch(() => null);
      if (!vivo()) return;
      const via = Object.fromEntries(((st && st.por_via) || []).map(x => [x.via, Number(x.n || 0)]));
      const top = ((st && st.por_categoria) || [])[0];
      metricas.replaceChildren(
        metrica("Mensagens recebidas", numero(somar(s.fila_24h, () => true)), "nas últimas 24 horas"),
        metrica("Buscas no guia", numero((st && st.total) || 0), "últimos 30 dias"),
        metrica("Sem gastar IA", st && st.total ? `${Math.round((((via.BOTAO || 0) + (via.PALAVRA || 0)) / st.total) * 100)}%` : "—", "pelos botões ou por palavra"),
        metrica("Mais procurado", top ? top.categoria : "—", top ? `${numero(top.n)} busca(s)` : "ainda sem buscas"));
    } else {
    const ativos = somar(s.casos_por_etapa, x => !["CONCLUIDO", "CANCELADO"].includes(x.etapa));
    const agendados = somar(s.casos_por_etapa, x => x.etapa === "AGENDADO");
    const equipe = somar(s.casos_por_etapa, x => x.etapa === "EQUIPE");
    metricas.replaceChildren(
      metrica("Mensagens recebidas", numero(somar(s.fila_24h, () => true)), "nas últimas 24 horas"),
      metrica("Casos em andamento", numero(ativos), "últimos 30 dias"),
      metrica("Agendados", numero(agendados), "confirmados pelo profissional"),
      metrica("Com a equipe", numero(equipe), "precisam de uma pessoa"));
    }

    const ok = v => v ? selo("Funcionando", "ok") : selo("Pendente", "alerta");
    const saude = h("div", { class: "cartao vidro" }, h("h3", { text: "Saúde da IA" }), h("p", { text: `DENIA Engine ${s.versao || ""} · modelo ${s.modelo || "—"}` }),
      h("ul", { class: "lista-saude" },
        h("li", {}, "WhatsApp", ok(s.whatsapp_configurado)),
        h("li", {}, "Inteligência artificial", ok(s.openai_configurado)),
        h("li", {}, "Banco de dados", ok(s.d1 && s.d1.operacional)),
        h("li", {}, "Memória de contingência", ok(s.kv && s.kv.operacional)),
        h("li", {}, "Alertas para a equipe (Telegram)", ok(s.telegram_configurado)),
        h("li", {}, "Assinatura da Meta verificada", ok(s.assinatura_meta_verificada))));
    const controle = h("div", { class: "cartao vidro" }, h("h3", { text: "Controle da IA" }),
      h("p", { text: s.pausa_geral ? "A IA está pausada: nenhuma mensagem automática está sendo enviada." : "A IA está atendendo. Use a pausa geral em caso de emergência — ela para todos os envios automáticos na hora." }),
      pode("ADMIN") ? botao(s.pausa_geral ? "Retomar o atendimento da IA" : "Pausar a IA agora", async () => {
        const pausar = !s.pausa_geral;
        if (!(await modal({ titulo: pausar ? "Pausar a IA?" : "Retomar a IA?", conteudo: pausar ? "Nenhuma mensagem automática será enviada até você retomar. Sua equipe continua atendendo normalmente pelo WhatsApp." : "A IA volta a responder os clientes automaticamente.", confirmar: pausar ? "Pausar agora" : "Retomar", perigo: pausar }))) return;
        try { await eng("pause", { metodo: "POST", corpo: { ativa: pausar } }); aviso(pausar ? "IA pausada." : "IA retomada.", "ok"); estado.status = null; atualizarStatus(); navegar(); }
        catch (e) { aviso(e.message, "erro"); }
      }, s.pausa_geral ? "btn-primario" : "btn-perigo") : h("p", { class: "nota", text: "Somente administradores podem pausar a IA." }),
      aprend ? h("div", { style: "margin-top:22px;display:grid;gap:10px" },
        h("h3", { text: "Aprendizado com o histórico" }),
        h("div", { class: "barra-progresso" }, h("i", { style: `width:${Math.max(0, Math.min(100, aprend.progresso || 0))}%` })),
        h("p", { style: "margin:0;color:var(--texto-2);font-size:14px", text: aprend.status === "NUNCA_EXECUTADO" ? "Ainda não iniciado." : `${aprend.progresso || 0}% lido · ${numero((aprend.sugestoes || {}).PENDENTE || 0)} sugestão(ões) aguardando aprovação.` }),
        h("a", { class: "btn btn-secundario btn-pequeno", href: "#/aprendizados", style: "width:fit-content" }, "Ver aprendizados")) : null);
    inferior.replaceChildren(saude, controle);
  }
  function metrica(rotulo, valor, sub) { return h("div", { class: "metrica vidro" }, h("span", { text: rotulo }), h("strong", { text: valor }), h("small", { text: sub })); }
  function passoInicial(num, titulo, texto, link) {
    return h("a", { class: "cartao vidro", href: link, style: "display:grid;gap:8px" }, h("span", { class: "gradiente-texto", style: "font-weight:800;font-size:22px", text: num }), h("h3", { text: titulo }), h("p", { style: "margin:0;color:var(--texto-2);font-size:14px", text: texto }));
  }

  // ---------------------------------------------------------------------------
  // Conversas
  // ---------------------------------------------------------------------------

  async function paginaConversas(el, param, vivo) {
    const grade = h("div", { class: "conversas" + (param ? " com-aberta" : "") });
    const busca = h("input", { class: "entrada", type: "search", placeholder: "Buscar por nome ou telefone", "aria-label": "Buscar conversa" });
    const itens = h("div", { class: "conversas-itens" }, carregando());
    const painel = h("section", { class: "conversa-painel vidro" }, vazio("Escolha uma conversa", "As mensagens aparecem aqui.", ICONES.conversa));
    const orgId = estado.org.id;
    let lista = [], aberta = param || "";
    const desenhar = () => {
      const q = busca.value.trim().toLowerCase().replace(/[()\s-]/g, "");
      const filtradas = lista.filter(c => !q || String(c.nome || "").toLowerCase().includes(q) || String(c.telefone || "").includes(q));
      itens.replaceChildren(...(filtradas.length ? filtradas.map(c => h("button", {
        class: "conversa-item" + (String(c.pessoa_id) === aberta ? " ativo" : ""), type: "button", "data-id": c.pessoa_id,
        onclick: () => { location.hash = "#/conversas/" + c.pessoa_id; }
      }, h("strong", {}, c.nome || telefone(c.telefone), c.ia_pausada ? selo("Humano", "alerta") : null, String(c.tipo || "").toUpperCase() === "TECNICO" ? selo("Profissional", "info") : null),
        h("span", { text: (String(c.ultima_direcao).toUpperCase() === "SAIDA" ? ({ HUMANO: "Equipe: ", LIGACAO: "📞 " }[String(c.ultima_origem).toUpperCase()] || "DENIA: ") : "") + (c.ultima_mensagem || "") }),
        h("span", { text: quando(c.ultima_mensagem_em) }))) : [vazio("Nenhuma conversa", q ? "Nada encontrado para essa busca." : "As conversas do WhatsApp aparecem aqui.", ICONES.conversa)]));
    };
    const carregarLista = async (forcar) => {
      const cache = estado.cacheConversas && estado.cacheConversas.org === orgId ? estado.cacheConversas : sessao.ler("denia_conversas_" + orgId);
      if (!forcar && cache && cache.lista) { lista = cache.lista; desenhar(); if (Date.now() - cache.em < 15000) return; }
      try {
        const nova = (await eng("conversations?limit=250", { fresco: true })).conversas || [];
        if (!grade.isConnected) return;
        lista = nova; estado.cacheConversas = { org: orgId, lista: nova, em: Date.now() };
        sessao.gravar("denia_conversas_" + orgId, estado.cacheConversas);
        desenhar();
      } catch (e) { if (grade.isConnected && !lista.length) falha(itens, e); }
    };
    const trocar = (id) => {
      aberta = id || "";
      grade.classList.toggle("com-aberta", Boolean(aberta));
      itens.querySelectorAll(".conversa-item").forEach(b => b.classList.toggle("ativo", b.getAttribute("data-id") === aberta));
      document.querySelectorAll("#lateral-nav a").forEach(a => a.classList.toggle("ativo", a.dataset.rota === "conversas"));
      if (aberta) abrirConversa(painel, aberta, () => grade.isConnected && aberta === id);
      else painel.replaceChildren(vazio("Escolha uma conversa", "As mensagens aparecem aqui.", ICONES.conversa));
    };
    // Canais: hoje as conversas são do WhatsApp; Instagram Direct e Messenger entram aqui quando a Meta liberar.
    const canal = estado.canalConversas || "whatsapp";
    const abaCanal = (k, n) => h("button", { type: "button", class: "aba" + (canal === k ? " ativo" : ""), onclick: () => { estado.canalConversas = k; navegar(); } }, n);
    const canais = h("div", { class: "abas abas-chips", style: "margin-bottom:8px" }, abaCanal("whatsapp", "WhatsApp"), abaCanal("instagram", "Instagram Direct"), abaCanal("messenger", "Messenger (Facebook)"));
    if (canal !== "whatsapp") {
      grade.append(h("section", { class: "conversas-lista vidro" }, canais,
        vazio(canal === "instagram" ? "Direct do Instagram" : "Messenger do Facebook", "Responder as mensagens privadas por aqui depende de a Meta liberar as permissões de mensagens (instagram_manage_messages e pages_messaging) para o app da DENIA, o que exige a verificação da empresa no Gerenciador de Negócios. Assim que a liberação sair, as conversas deste canal aparecem nesta aba e a DENIA responde como no WhatsApp.", ICONES.conversa)), painel);
      el.appendChild(grade);
      return;
    }
    grade.append(h("section", { class: "conversas-lista vidro" }, canais, h("div", { class: "conversas-busca" }, busca, botao("Atualizar", () => carregarLista(true), "btn-secundario btn-pequeno")), itens), painel);
    el.appendChild(grade);
    estado.paginaViva = { nome: "conversas", org: orgId, el: grade, trocar };
    busca.addEventListener("input", desenhar);
    if (aberta) trocar(aberta);
    await carregarLista(false);
    if (!vivo()) return;
  }

  const cacheConversa = new Map();
  async function abrirConversa(painel, id, vivo, jaTem) {
    // Mostra na hora o que já foi carregado e atualiza por trás.
    const guardada = !jaTem && cacheConversa.get(estado.org.id + ":" + id);
    if (guardada) { desenharConversa(painel, id, vivo, guardada); }
    else if (!jaTem) painel.replaceChildren(carregando());
    let d = jaTem;
    if (!d) {
      try { d = await eng("conversations/" + encodeURIComponent(id), { fresco: true }); }
      catch (e) { if (vivo() && !guardada) painel.replaceChildren(vazio("Não foi possível abrir", e.message)); return; }
      cacheConversa.set(estado.org.id + ":" + id, d);
      if (cacheConversa.size > 40) cacheConversa.delete(cacheConversa.keys().next().value);
      if (guardada && JSON.stringify(guardada) === JSON.stringify(d)) return;
    }
    if (!vivo()) return;
    desenharConversa(painel, id, vivo, d);
  }
  function desenharConversa(painel, id, vivo, d) {
    const rascunho = painel.dataset.conversa === String(id) ? (painel.querySelector(".compor textarea") || {}).value || "" : "";
    painel.dataset.conversa = String(id);
    const msgs = h("div", { class: "mensagens", "aria-live": "polite" }, (d.mensagens || []).map(m => {
      const saida = String(m.direcao).toUpperCase() === "SAIDA", humano = String(m.origem).toUpperCase() === "HUMANO";
      if (String(m.origem).toUpperCase() === "LIGACAO") return h("div", { class: "msg msg-ligacao" }, "📞 " + (m.conteudo || ""), h("small", { text: "Resumo de ligação · " + quando(m.criado_em) }));
      // Entrega confirmada pela Meta (motor 31.2+): ✓ aceita, ✓✓ entregue, ✓✓ azul lida, ⚠ não chegou.
      const ENTREGA = { ACEITA: ["✓", "Aceita pela Meta, ainda sem confirmação de entrega"], SENT: ["✓", "Enviada"], DELIVERED: ["✓✓", "Entregue"], READ: ["✓✓", "Lida"], REENVIADA: ["↻", "Reenviada depois de uma falha da Meta"], FILA: ["⏳", "Na fila de envio: sai em até 1 minuto"] };
      const falhou = saida && m.entrega === "FAILED";
      // Sem confirmação da Meta, a mensagem nunca aparece como "enviada": motor antigo (sem confirmações)
      // ou aceita há mais de 10 minutos sem nenhum aviso de entrega.
      const versaoMotor = String((estado.status && estado.status.versao) || "");
      const simulada = saida && /^sim\./.test(String(m.whatsapp_message_id || ""));
      const recente = Date.now() - Date.parse(String(m.criado_em || "").replace(" ", "T") + (String(m.criado_em || "").includes("Z") ? "" : "Z")) < 60000;
      const motorSemConfirmacao = saida && !simulada && !m.entrega && String(m.origem || "").toUpperCase() !== "LIGACAO" && !recente;
      const idadeMs = Date.now() - Date.parse(String(m.criado_em || "").replace(" ", "T") + (String(m.criado_em || "").includes("Z") ? "" : "Z"));
      const semConfirmar = saida && m.entrega === "ACEITA" && idadeMs > 10 * 60000;
      const tique = saida && m.entrega && ENTREGA[m.entrega] ? h("span", { class: "tique" + (m.entrega === "READ" ? " tique-lida" : ""), title: ENTREGA[m.entrega][1], "aria-label": ENTREGA[m.entrega][1], text: " " + ENTREGA[m.entrega][0] }) : null;
      return h("div", { class: "msg " + (saida ? "msg-saida" + (humano ? " msg-humano" : "") + (falhou ? " msg-falhou" : "") : "msg-entrada") }, m.conteudo || "[sem texto]",
        falhou ? h("span", { class: "msg-falha", text: "⚠ NÃO CHEGOU: " + (m.entrega_erro || "a Meta não entregou esta mensagem.") }) : null,
        semConfirmar ? h("span", { class: "msg-aviso", text: "⚠ A Meta aceitou, mas não confirmou a entrega. Provavelmente NÃO chegou — veja WhatsApp → Verificar agora." }) : null,
        simulada ? h("span", { class: "msg-falha", text: "⚠ SIMULAÇÃO: esta resposta foi gerada no modo de teste e NÃO foi enviada ao WhatsApp." }) : null,
        motorSemConfirmacao ? h("span", { class: "msg-aviso", text: /^(3[2-9]|31\.[2-9])/.test(versaoMotor) ? "⚠ A Meta não mandou nenhuma confirmação de entrega desta mensagem: provavelmente NÃO chegou. Veja WhatsApp → Verificar agora." : `⚠ Entrega não confirmada${versaoMotor ? ` (motor ${versaoMotor})` : ""}: não dá para saber se chegou. Cole o motor 31.3 no Worker denia.` }) : null,
        h("small", {}, (saida ? (humano ? "Equipe · " : "DENIA · ") : "") + quando(m.criado_em), tique));
    }));
    if (!(d.mensagens || []).length) msgs.appendChild(vazio("Sem mensagens", ""));
    const caso = d.caso_ativo;
    const estadoIa = d.ia_pausada ? selo("Atendimento humano", "alerta") : selo("IA atendendo", "ok");
    // Quem é este contato: a equipe corrige quando a DENIA confunde profissional com cliente.
    const ehProf = String(d.pessoa.tipo || "").toUpperCase() === "TECNICO" || d.pessoa.profissional;
    const marcarTipo = async (tipo) => {
      let prestador_id = "";
      if (tipo === "TECNICO") {
        let lista = [];
        try { lista = (await eng("professionals")).profissionais || []; } catch { /* segue sem a lista */ }
        const sel = h("select", { class: "entrada" }, h("option", { value: "", text: "Não está na lista (outro profissional)" }), lista.map(p => h("option", { value: p.id, text: `${p.nome} — ${p.area_rotulo ? p.area_rotulo.split(" (")[0] : p.area}` })));
        if (!(await modal({ titulo: "Este contato é um profissional?", conteudo: ["A DENIA passa a tratar as mensagens deste número como de profissional: nunca abre pedido nem repassa a outro profissional. Pedidos abertos por engano por este número são encerrados.", campo("Profissional da lista", sel)], confirmar: "É profissional" }))) return;
        prestador_id = sel.value;
      }
      try {
        const r = await eng(`conversations/${id}/type`, { metodo: "POST", corpo: { tipo, prestador_id } });
        aviso(tipo === "TECNICO" ? "Contato marcado como profissional." : "Contato marcado como cliente.", "ok");
        if (r.casos_encerrados) aviso(`${r.casos_encerrados} pedido(s) aberto(s) por engano foram encerrados.`, "ok");
        estado.cacheConversas = null;
        abrirConversa(painel, id, vivo);
      } catch (e) { aviso(e.message, "erro"); }
    };
    const quem = d.pessoa.oficial ? selo(`Profissional: ${d.pessoa.profissional}`, "info")
      : pode("AGENTE") ? (ehProf ? h("span", { class: "acoes" }, selo(d.pessoa.profissional ? `Profissional: ${d.pessoa.profissional}` : "Profissional", "info"), botao("É cliente", () => marcarTipo("CLIENTE"), "btn-secundario btn-pequeno"))
        : botao("É profissional", () => marcarTipo("TECNICO"), "btn-secundario btn-pequeno")) : null;
    // Resumo de ligação: o que foi falado por telefone entra no contexto da DENIA.
    const registrarLigacao = async () => {
      const resumo = h("textarea", { class: "entrada", maxlength: "3000", style: "min-height:140px", placeholder: "Ex.: Liguei para o cliente. Ele prefere atendimento depois das 14h, o portão é azul e já tem a peça em casa." });
      if (!(await modal({ titulo: "Resumo da ligação", conteudo: ["Escreva (ou dite pelo microfone do teclado) o que foi conversado por telefone. A DENIA passa a considerar isso como informação confirmada nesta conversa.", resumo], confirmar: "Salvar resumo" }))) return;
      if (resumo.value.trim().length < 3) { aviso("Escreva o resumo da ligação.", "erro"); return; }
      try { await eng(`conversations/${id}/note`, { metodo: "POST", corpo: { texto: resumo.value.trim() } }); aviso("Resumo salvo. A DENIA já considera o que foi combinado.", "ok"); abrirConversa(painel, id, vivo); }
      catch (e) { aviso(e.message, "erro"); }
    };
    const acoes = h("div", { class: "acoes" },
      quem,
      pode("AGENTE") ? botao("📞 Registrar ligação", registrarLigacao, "btn-secundario btn-pequeno") : null,
      h("a", { class: "btn btn-secundario btn-pequeno", href: "#/conversas" }, "Voltar"),
      pode("AGENTE") ? (d.ia_pausada
        ? botao("Devolver para a IA", async () => { try { await eng(`conversations/${id}/release`, { metodo: "POST", corpo: {} }); aviso("A IA voltou a atender esta conversa.", "ok"); abrirConversa(painel, id, vivo); } catch (e) { aviso(e.message, "erro"); } }, "btn-secundario btn-pequeno")
        : botao("Assumir conversa", async () => { try { await eng(`conversations/${id}/takeover`, { metodo: "POST", corpo: {} }); aviso("Você assumiu a conversa. A IA fica em pausa nela.", "ok"); abrirConversa(painel, id, vivo); } catch (e) { aviso(e.message, "erro"); } }, "btn-secundario btn-pequeno")) : null);
    const filhos = [h("div", { class: "conversa-cabeca" },
      h("div", {}, h("h3", { text: d.pessoa.nome || telefone(d.pessoa.telefone) }), h("span", { style: "font-size:13px;color:var(--texto-3)", text: telefone(d.pessoa.telefone) + (caso ? ` · Caso #${caso.casoId} · ${NOME_ETAPA[caso.etapa] || caso.etapa}` : "") })),
      estadoIa, acoes), msgs];
    if (pode("AGENTE")) {
      const texto = h("textarea", { class: "entrada", placeholder: "Escreva como equipe… (Ctrl + Enter envia)", "aria-label": "Mensagem", maxlength: "4000" });
      const enviar = botao("Enviar", async () => {
        const t = texto.value.trim();
        if (!t) return;
        try {
          await eng(`conversations/${id}/send`, { metodo: "POST", corpo: { mensagem: t } });
          texto.value = "";
          aviso("Mensagem enviada. A IA fica em pausa nesta conversa.", "ok");
          estado.cacheConversas = null;
          abrirConversa(painel, id, vivo);
        } catch (e) { aviso(e.message, "erro"); }
      }, "btn-primario");
      if (rascunho) texto.value = rascunho;
      texto.addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); enviar.click(); } });
      filhos.push(h("div", { class: "compor" }, texto, enviar));
    }
    painel.replaceChildren(...filhos);
    msgs.scrollTop = msgs.scrollHeight;
  }

  // ---------------------------------------------------------------------------
  // Atendimentos (quadro por etapa)
  // ---------------------------------------------------------------------------

  // Atendimentos: lista com filtros por etapa (no lugar das colunas), busca, e a IA revisando em que pé cada caso está.
  async function paginaAtendimentos(el, _p, vivo) {
    el.appendChild(cabeca("Atendimentos", "Todos os pedidos dos clientes. A IA move os casos sozinha quando tem certeza (agendado, em andamento, concluído) lendo as conversas com o cliente, com o profissional, as mensagens da equipe e os resumos de ligação. A equipe ajusta quando precisar.", botao("Atualizar", () => navegar())));
    const area = h("div", { class: "grade" }, carregando());
    el.appendChild(area);
    let casos;
    try { casos = (await eng("cases", { fresco: true })).casos || []; }
    catch (e) { if (vivo()) falha(area, e); return; }
    if (!vivo()) return;
    if (!casos.length) { area.replaceChildren(h("div", { class: "cartao vidro" }, vazio("Nenhum atendimento ainda", "Os casos abertos pela IA aparecem aqui."))); return; }
    const f = estado.filtroCasos || (estado.filtroCasos = { etapa: "ABERTOS", busca: "" });
    const abertos = c => !["CONCLUIDO", "CANCELADO"].includes(c.etapa);
    const parado = c => abertos(c) && Date.now() - (c.atualizadoMs || 0) > 86400000;
    const filtrar = c => (f.etapa === "TODOS" || (f.etapa === "ABERTOS" ? abertos(c) : f.etapa === "PARADOS" ? parado(c) : c.etapa === f.etapa))
      && (!f.busca || JSON.stringify([c.casoId, c.fatos, c.telefone, c.resumo]).toLowerCase().includes(f.busca.toLowerCase()));
    const conta = fn => casos.filter(fn).length;
    const chips = h("div", { class: "abas abas-chips" }, [["ABERTOS", "Em aberto", abertos], ["PARADOS", "Parados há mais de 1 dia", parado], ...ETAPAS.map(([k, n]) => [k, n, c => c.etapa === k]), ["TODOS", "Todos", () => true]]
      .filter(([k, , fn]) => ["ABERTOS", "TODOS", "PARADOS"].includes(k) || conta(fn))
      .map(([k, n, fn]) => h("button", { type: "button", class: "aba" + (f.etapa === k ? " ativo" : ""), onclick: () => { f.etapa = k; navegar(); } }, `${n} (${numero(conta(fn))})`)));
    const busca = h("input", { class: "entrada", type: "search", value: f.busca, placeholder: "Procurar por serviço, bairro, telefone ou nº do caso (Enter)" });
    busca.addEventListener("keydown", e => { if (e.key === "Enter") { f.busca = busca.value.trim(); navegar(); } });
    const lista = casos.filter(filtrar).sort((a, b) => (b.atualizadoMs || 0) - (a.atualizadoMs || 0));
    const progresso = h("p", { class: "nota oculto" });
    const revisarVarios = async (_e, b) => {
      const alvo = casos.filter(parado).slice(0, 30);
      if (!alvo.length) { aviso("Nenhum caso parado para revisar.", "ok"); return; }
      let movidos = 0;
      b.disabled = true;
      try {
        for (const [i, c] of alvo.entries()) {
          progresso.classList.remove("oculto"); progresso.textContent = `A IA está lendo o caso #${c.casoId} (${i + 1} de ${alvo.length})…`;
          try { const r = await eng(`cases/${c.casoId}/review`, { metodo: "POST", corpo: { aplicar: true } }); if (r.aplicada) movidos++; } catch (e) { aviso(`Caso #${c.casoId}: ${e.message}`, "erro"); }
        }
        aviso(`Revisão concluída: ${movidos} caso(s) mudaram de etapa. Os outros ficaram com a sugestão da IA para você conferir.`, "ok"); navegar();
      } finally { b.disabled = false; }
    };
    const PAGINA = 40;
    let mostrados = 0;
    const listaEl = h("div", { class: "lista-casos" });
    const mais = h("div", { class: "acoes", style: "justify-content:center" });
    const mostrarMais = () => { lista.slice(mostrados, mostrados + PAGINA).forEach(c => listaEl.appendChild(linhaCaso(c))); mostrados = Math.min(lista.length, mostrados + PAGINA); mais.replaceChildren(...(mostrados < lista.length ? [botao(`Mostrar mais (${numero(mostrados)} de ${numero(lista.length)})`, mostrarMais, "btn-secundario")] : [])); };
    mostrarMais();
    area.replaceChildren(
      h("section", { class: "cartao vidro" }, chips,
        h("div", { class: "acoes", style: "margin-top:10px" }, h("div", { style: "flex:1;min-width:240px" }, busca),
          pode("AGENTE") && conta(parado) ? botao(`✦ Revisar com IA os ${numero(Math.min(30, conta(parado)))} casos parados`, revisarVarios, "btn-primario") : null),
        progresso),
      lista.length ? listaEl : h("div", { class: "cartao vidro" }, vazio("Nenhum caso com esse filtro", "", ICONES.caixa)), mais);
  }
  const TOM_ETAPA = { CONCLUIDO: "ok", AGENDADO: "ok", EM_ANDAMENTO: "info", CANCELADO: "", EQUIPE: "alerta", AGUARDANDO_PRESTADOR: "alerta", AGUARDANDO_CLIENTE: "alerta", AGUARDANDO_CONFIRMACAO_PRESTADOR: "alerta", AGUARDANDO_ENDERECO: "alerta", COLETANDO: "info" };
  function linhaCaso(c) {
    const f = c.fatos || {}, rev = c.revisao_ia;
    const sel = pode("AGENTE") ? h("select", { class: "entrada", "aria-label": `Mudar a etapa do caso ${c.casoId}` },
      h("option", { value: "", text: "Mudar etapa…" }), ETAPAS_MANUAIS.filter(k => k !== c.etapa).map(k => h("option", { value: k, text: NOME_ETAPA[k] }))) : null;
    if (sel) sel.addEventListener("change", async () => {
      const etapa = sel.value;
      if (!etapa) return;
      const ok = await modal({ titulo: `Mover o caso #${c.casoId}?`, conteudo: `O caso vai para "${NOME_ETAPA[etapa]}".${["CONCLUIDO", "CANCELADO"].includes(etapa) ? " Casos encerrados não são reabertos pela IA." : ""}`, confirmar: "Mover", perigo: etapa === "CANCELADO" });
      if (!ok) { sel.value = ""; return; }
      try { await eng(`cases/${c.casoId}/status`, { metodo: "POST", corpo: { etapa } }); aviso("Etapa atualizada.", "ok"); navegar(); }
      catch (e) { aviso(e.message, "erro"); sel.value = ""; }
    });
    const sugestao = rev && rev.etapa_sugerida && rev.etapa_sugerida !== c.etapa && !rev.aplicada ? rev : null;
    return h("article", { class: "caso-linha vidro" },
      h("div", { class: "caso-linha-topo" },
        h("strong", { text: `#${c.casoId} · ${f.servico || f.categoria || "Serviço a definir"}` }), selo(NOME_ETAPA[c.etapa] || c.etapa, TOM_ETAPA[c.etapa] || ""),
        Date.now() - (c.atualizadoMs || 0) > 86400000 && !["CONCLUIDO", "CANCELADO"].includes(c.etapa) ? selo("Parado há " + Math.floor((Date.now() - c.atualizadoMs) / 86400000) + " dia(s)", "alerta") : null,
        h("span", { class: "sub", text: [f.bairro, telefone(c.telefone), "atualizado " + quando(c.atualizadoMs)].filter(Boolean).join(" · ") })),
      f.problema ? h("p", { style: "margin:4px 0", text: f.problema }) : null,
      f.preferencia_horario ? h("p", { class: "sub", text: "Horário: " + f.preferencia_horario }) : null,
      rev ? h("p", { class: "nota" + (sugestao ? " nota-alerta" : ""), text: `IA (${new Date(rev.em).toLocaleString(LOCALE)}): ${sugestao ? `acha que está em "${NOME_ETAPA[rev.etapa_sugerida] || rev.etapa_sugerida}" (confiança ${rev.confianca.toLowerCase()})` : rev.aplicada ? `moveu para "${NOME_ETAPA[rev.etapa_sugerida] || rev.etapa_sugerida}"` : "confirmou a etapa"}. ${rev.motivo || ""}${rev.proximo_passo ? " Próximo passo: " + rev.proximo_passo : ""}` }) : null,
      h("div", { class: "acoes" },
        h("a", { class: "btn btn-secundario btn-pequeno", href: "#/conversas/" + c.clienteId }, "Abrir conversa"),
        pode("AGENTE") && sugestao ? botao(`Aceitar: ${NOME_ETAPA[sugestao.etapa_sugerida] || sugestao.etapa_sugerida}`, async () => { try { await eng(`cases/${c.casoId}/status`, { metodo: "POST", corpo: { etapa: sugestao.etapa_sugerida } }); aviso("Etapa atualizada.", "ok"); navegar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-primario btn-pequeno") : null,
        pode("AGENTE") ? botao("✦ Atualizar com IA", async (_e, b) => {
          b.textContent = "Lendo o caso…";
          try { const r = await eng(`cases/${c.casoId}/review`, { metodo: "POST", corpo: { aplicar: true } }); aviso(r.aplicada ? `Movido para "${NOME_ETAPA[r.etapa_sugerida] || r.etapa_sugerida}": ${r.motivo}` : `A IA sugere "${NOME_ETAPA[r.etapa_sugerida] || r.etapa_sugerida}" (confiança ${r.confianca.toLowerCase()}): ${r.motivo}`, "ok"); navegar(); }
          catch (e) { aviso(e.message, "erro"); } finally { b.textContent = "✦ Atualizar com IA"; }
        }, "btn-secundario btn-pequeno") : null, sel));
  }

  // ---------------------------------------------------------------------------
  // Profissionais
  // ---------------------------------------------------------------------------

  async function paginaProfissionais(el, _p, vivo) {
    el.appendChild(cabeca("Profissionais", "A rede de profissionais que a IA consulta. A ordem define quem é consultado primeiro em cada área."));
    const area = h("div", {}, carregando());
    el.appendChild(area);
    let lista;
    try { lista = (await eng("professionals")).profissionais || []; }
    catch (e) { if (vivo()) falha(area, e); return; }
    if (!vivo()) return;
    area.replaceChildren(lista.length ? h("div", { class: "tabela-caixa" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", { text: "Profissional" }), h("th", { text: "Área" }), h("th", { text: "WhatsApp" }))),
      h("tbody", {}, lista.map(p => h("tr", {}, h("td", { text: p.nome }), h("td", { text: p.area_rotulo || p.area }), h("td", { text: telefone(p.telefone) })))))) : h("div", { class: "cartao vidro" }, vazio("Nenhum profissional cadastrado", "")),
    h("p", { class: "nota", style: "margin-top:16px", text: "Para incluir ou trocar um profissional, peça ao responsável técnico: a lista fica no código do DENIA Engine, para que nenhuma mensagem vá para a pessoa errada por engano." }));
  }

  // ---------------------------------------------------------------------------
  // Treinamento
  // ---------------------------------------------------------------------------

  const CAMPOS = [
    ["instrucoes", "Instruções", "Como a IA deve atender: tom de voz, tamanho das respostas, o que sempre fazer e o que nunca fazer."],
    ["servicos", "Serviços", "O que a empresa faz e quem atende cada serviço. Ex.: \"Eletricista só faz elétrica da casa; não conserta eletrodomésticos.\""],
    ["precos", "Preços autorizados", "Somente valores que a IA pode informar sem consultar ninguém. Fora daqui, ela nunca informa valor."],
    ["regras", "Regras", "Políticas da empresa: regiões atendidas, pagamento, garantia, cancelamento."],
    ["procedimentos", "Procedimentos", "Passo a passo de situações específicas: urgência, reclamação, retorno de serviço."],
    ["informacoes", "Informações", "Endereço, horários, formas de pagamento e contatos."],
    ["exemplos", "Exemplos de conversa", "Trechos reais de como as atendentes falam. A IA imita esse jeito de escrever."],
    ["aprendizados", "Aprendizados aprovados", "Conhecimentos extraídos do histórico e aprovados por você em Aprendizados. Você também pode editar aqui."]
  ];

  async function paginaTreinamento(el, _p, vivo) {
    el.appendChild(cabeca("Treinar a IA", "Tudo o que a IA sabe sobre a empresa. Cada salvamento cria uma nova versão; a IA passa a usar em até 1 minuto."));
    const area = h("div", { class: "grade" }, carregando());
    el.appendChild(area);
    let t;
    try { t = await eng("training"); }
    catch (e) { if (vivo()) falha(area, e); return; }
    if (!vivo()) return;
    const original = Object.assign({}, t.dados || {});
    const valores = Object.assign({}, original);
    const extras = Object.keys(original).filter(k => !CAMPOS.some(c => c[0] === k) && typeof original[k] === "string");
    const lista = CAMPOS.concat(extras.map(k => [k, k.charAt(0).toUpperCase() + k.slice(1), "Campo trazido da versão anterior."]));
    const editar = pode("ADMIN");
    let atual = lista[0][0];
    const abas = h("div", { class: "abas", role: "tablist" });
    const corpo = h("div", { class: "cartao vidro" });
    const info = h("span", { style: "font-size:13.5px;color:var(--texto-2)" });
    const mudou = () => lista.some(([k]) => String(valores[k] || "") !== String(original[k] || ""));
    const atualizarInfo = () => { info.textContent = mudou() ? "Há alterações não salvas." : `Versão ${t.versao || 0}${t.autor ? " · " + ({ inicial: "criada automaticamente", importado: "importada da versão anterior" }[t.autor] || "por " + t.autor) : ""}${t.criadoMs ? ", " + quandoFrase(t.criadoMs) : ""}`; };
    const rotuloAba = (k, nome) => nome + (String(valores[k] || "") !== String(original[k] || "") ? " •" : "");
    const desenhar = () => {
      abas.replaceChildren(...lista.map(([k, nome]) => h("button", { class: "aba" + (k === atual ? " ativo" : ""), type: "button", role: "tab", "data-campo": k, "aria-selected": k === atual ? "true" : "false", onclick: () => { atual = k; desenhar(); } }, rotuloAba(k, nome))));
      const [k, nome, dica] = lista.find(c => c[0] === atual);
      const ta = h("textarea", { class: "entrada", id: "treino-" + k, value: valores[k] || "", readOnly: !editar, maxlength: "30000", style: "min-height:340px" });
      const contagem = h("p", { class: "dica" });
      const contar = () => { contagem.textContent = `${numero((valores[k] || "").length)} de 30.000 caracteres`; };
      ta.addEventListener("input", () => {
        valores[k] = ta.value;
        atualizarInfo(); contar();
        const aba = abas.querySelector(`[data-campo="${CSS.escape(k)}"]`);
        if (aba) aba.textContent = rotuloAba(k, nome);
      });
      contar();
      corpo.replaceChildren(h("div", { class: "campo-treino" }, h("label", { for: ta.id, style: "font-weight:700" }, nome), h("p", { class: "dica", text: dica }), ta, contagem));
      atualizarInfo();
    };
    const salvar = async (confirmarVazio) => {
      const alterados = {};
      for (const [k] of lista) if (String(valores[k] || "") !== String(original[k] || "")) alterados[k] = String(valores[k] || "");
      if (!Object.keys(alterados).length) { aviso("Nada para salvar."); return; }
      try {
        const r = await eng("training", { metodo: "POST", corpo: { treinamento: alterados, confirmar_vazio: confirmarVazio === true } });
        aviso(`Treinamento salvo (versão ${r.versao}).`, "ok");
        navegar();
      } catch (e) {
        if (e.status === 409 && e.dados.codigo === "CONFIRMAR_VAZIO") {
          const nomes = (e.dados.campos || []).map(k => (lista.find(c => c[0] === k) || [k, k])[1]).join(", ");
          if (await modal({ titulo: "Apagar conteúdo do treinamento?", conteudo: [`Estes campos vão ficar vazios: ${nomes}.`, "A IA deixa de saber o que estava escrito neles. As versões anteriores continuam guardadas."], confirmar: "Sim, salvar assim", perigo: true })) await salvar(true);
        } else aviso(e.message, "erro");
      }
    };
    const barra = h("div", { class: "barra-salvar vidro" }, info, editar ? h("div", { class: "acoes" },
      botao("Descartar alterações", () => { Object.assign(valores, original); for (const k of Object.keys(valores)) if (!(k in original)) delete valores[k]; desenhar(); }),
      botao("Salvar treinamento", () => salvar(false), "btn-primario")) : h("span", { class: "selo", text: "Somente leitura" }));
    window.onbeforeunload = () => (mudou() ? true : undefined);
    window.addEventListener("hashchange", () => { window.onbeforeunload = null; }, { once: true });
    area.replaceChildren(abas, corpo, barra);
    desenhar();
  }

  // ---------------------------------------------------------------------------
  // Aprendizados (histórico de 6 meses → sugestões com aprovação)
  // ---------------------------------------------------------------------------

  const TIPOS = { RESPOSTA_PADRAO: ["Resposta padrão", "info"], PRECO_PRATICADO: ["Preço praticado", "alerta"], QUEM_ATENDE: ["Quem atende", "info"], REGRA: ["Regra", ""], ESTILO: ["Jeito de falar", "ok"], INFORMACAO: ["Informação", ""] };
  let timerAprendizado = null;

  // Estudo diário: toda noite a DENIA relê o dia, encontra os próprios erros e escreve lições que valem no dia seguinte.
  async function blocoEstudo(caixa) {
    let st;
    try { st = await eng("study", { fresco: true }); }
    catch (e) { if (e.status === 404) trocar(caixa, h("section", { class: "cartao vidro" }, h("p", { class: "nota", text: "Cole o motor 31.6 no Worker denia para a DENIA estudar sozinha todos os dias." }))); return; }
    const rel = (st.relatorios || []).filter(r => r.tipo === "ESTUDO_DIARIO");
    const ultimo = rel[0];
    const licoes = String(st.licoes || "").split("\n").map(l => l.replace(/^[-•]\s*/, "").trim()).filter(Boolean);
    const notas = rel.slice().reverse().filter(r => r.nota != null).map(r => ({ data: String(r.dia || new Date(r.em).toISOString().slice(0, 10)), v: r.nota }));
    trocar(caixa, h("section", { class: "cartao vidro" },
      h("div", { class: "cabeca-grafico" }, h("h3", { style: "margin:0", text: "Estudo diário da DENIA" }),
        pode("ADMIN") ? h("div", { class: "acoes" },
          botao("Estudar o dia agora", async (_e, b) => { b.textContent = "Estudando…"; try { await eng("study/run", { metodo: "POST", corpo: {} }); aviso("Estudo concluído.", "ok"); await blocoEstudo(caixa); } catch (e) { aviso(e.message, "erro"); b.textContent = "Estudar o dia agora"; } }, "btn-primario btn-pequeno"),
          botao("Pesquisar boas práticas", async (_e, b) => { b.textContent = "Pesquisando na internet…"; try { await eng("study/run", { metodo: "POST", corpo: { tipo: "pesquisa" } }); aviso("Pesquisa concluída.", "ok"); await blocoEstudo(caixa); } catch (e) { aviso(e.message, "erro"); b.textContent = "Pesquisar boas práticas"; } }, "btn-secundario btn-pequeno")) : null),
      h("p", { class: "sub", text: "Toda noite ela relê as conversas do dia, aponta os próprios erros e escreve lições que já valem no atendimento seguinte. Uma vez por semana pesquisa na internet boas práticas de atendimento com empatia." }),
      ultimo ? h("section", { class: "grade grade-3" }, metrica("Nota do último dia", ultimo.nota != null ? `${String(ultimo.nota).replace(".", ",")}/10` : "—", ultimo.dia ? dataCompleta(ultimo.dia) : ""), metrica("Conversas estudadas", numero(ultimo.conversas || 0), ""), metrica("Lições que ela segue", numero(licoes.length), `${numero(ultimo.licoes_novas || 0)} nova(s) no último estudo`)) : h("p", { class: "nota", text: "Ainda não houve estudo. Ele acontece sozinho depois das 21h, ou clique em \"Estudar o dia agora\"." }),
      notas.length > 1 ? h("div", { style: "margin-top:10px" }, h("h4", { style: "margin:0 0 4px", text: "Nota por dia" }), graficoLinha(notas.map(n => ({ chave: n.data, rotulo: dataCompleta(n.data), curto: dataCurta(n.data), valor: n.v })), null, "Nota do dia", "")) : null,
      ultimo && ultimo.resumo ? h("p", { style: "margin:10px 0 0", text: ultimo.resumo }) : null,
      ultimo && (ultimo.erros || []).length ? h("details", {}, h("summary", { text: `Erros que ela encontrou no último dia (${ultimo.erros.length})` }),
        h("ul", { class: "lista-saude" }, ultimo.erros.map(e => h("li", {}, h("span", {}, h("strong", { text: e.erro }), h("span", { class: "sub", text: "Como deveria ser: " + e.correcao })))))) : null,
      licoes.length ? h("details", { open: true }, h("summary", { text: `Lições que ela segue (${licoes.length})` }), h("ol", { class: "passos" }, licoes.map(l => h("li", { text: l })))) : null));
  }
  async function paginaAprendizados(el, param, vivo) {
    clearTimeout(timerAprendizado);
    const filtro = ["PENDENTE", "APROVADA", "REJEITADA"].includes(String(param).toUpperCase()) ? String(param).toUpperCase() : "PENDENTE";
    el.appendChild(cabeca("Aprendizados", "A IA lê as conversas dos últimos 6 meses — principalmente as respostas das atendentes — e sugere o que aprender. Conhecimento novo (preços, serviços, regras) só entra com a sua aprovação."));
    const estudo = h("div", {});
    el.appendChild(estudo);
    blocoEstudo(estudo).catch(() => {});
    const topo = h("div", { class: "cartao vidro" }, carregando());
    const lista = h("div", { class: "grade" });
    el.append(topo, lista);
    let st;
    try { st = await eng("learning"); }
    catch (e) { if (vivo()) falha(topo, e); return; }
    if (!vivo()) return;
    const cont = st.sugestoes || {};
    const nomeStatus = { NUNCA_EXECUTADO: "Ainda não iniciado", RODANDO: "Lendo o histórico…", CONCLUIDO: "Leitura concluída" }[st.status] || st.status;
    topo.replaceChildren(
      h("div", { class: "pagina-cabeca" }, h("div", {}, h("h3", { text: nomeStatus }), h("p", { text: st.status === "NUNCA_EXECUTADO" ? "Clique em começar. A leitura acontece aos poucos (cerca de 220 mensagens por minuto) e você pode aprovar enquanto ela avança." : `${st.progresso || 0}% lido · ${numero(st.lotes)} lote(s)${st.erros ? ` · ${st.erros} tentativa(s) com erro` : ""}${st.atualizado_ms ? " · atualizado " + quandoFrase(st.atualizado_ms) : ""}` })),
        pode("ADMIN") ? botao(st.status === "NUNCA_EXECUTADO" ? "Começar a aprender" : st.status === "RODANDO" ? "Recomeçar a leitura" : "Ler o histórico de novo", async () => {
          if (st.status !== "NUNCA_EXECUTADO" && !(await modal({ titulo: "Ler o histórico novamente?", conteudo: "A leitura recomeça pelos últimos 6 meses. Sugestões já aprovadas ou rejeitadas são mantidas; sugestões repetidas só aumentam a contagem de ocorrências.", confirmar: "Recomeçar" }))) return;
          try { await eng("learning/start", { metodo: "POST", corpo: {} }); aviso("Leitura iniciada. As sugestões começam a aparecer em instantes.", "ok"); navegar(); }
          catch (e) { aviso(e.message, "erro"); }
        }, "btn-primario", {}) : null),
      h("div", { class: "barra-progresso", style: "margin-top:16px" }, h("i", { style: `width:${Math.max(0, Math.min(100, st.progresso || 0))}%` })));
    if (st.status === "RODANDO") timerAprendizado = setTimeout(() => { if (vivo() && document.visibilityState === "visible") navegar(); }, 45000);

    lista.appendChild(h("div", { class: "abas", role: "tablist" }, [["PENDENTE", "Aguardando aprovação"], ["APROVADA", "Aprovadas"], ["REJEITADA", "Rejeitadas"]].map(([k, nome]) =>
      h("a", { class: "aba" + (k === filtro ? " ativo" : ""), href: "#/aprendizados/" + k.toLowerCase(), role: "tab", "aria-selected": k === filtro ? "true" : "false" }, `${nome} (${numero(cont[k] || 0)})`))));
    const itens = h("div", { class: "grade" }, carregando());
    lista.appendChild(itens);
    let sugestoes;
    try { sugestoes = (await eng("learning/suggestions?status=" + filtro)).sugestoes || []; }
    catch (e) { if (vivo()) falha(itens, e); return; }
    if (!vivo()) return;
    if (!sugestoes.length) { itens.replaceChildren(h("div", { class: "cartao vidro" }, vazio(filtro === "PENDENTE" ? "Nenhuma sugestão aguardando" : "Nada por aqui", filtro === "PENDENTE" && st.status !== "CONCLUIDO" ? "Assim que a IA encontrar algo útil no histórico, aparece aqui." : "", ICONES.cerebro))); return; }
    itens.replaceChildren(...sugestoes.map(s => cartaoSugestao(s, filtro)));
  }
  function cartaoSugestao(s, filtro) {
    const [nomeTipo, cor] = TIPOS[s.tipo] || [s.tipo, ""];
    const editavel = filtro === "PENDENTE" && (pode("ADMIN") || ehRevisor());
    const ta = h("textarea", { class: "entrada", value: s.conteudo, readOnly: !editavel, maxlength: "800", "aria-label": "Conteúdo da sugestão" });
    const cartao = h("article", { class: "sugestao vidro" },
      h("div", { class: "sugestao-topo" }, h("strong", { text: s.titulo }), selo(nomeTipo, cor), Number(s.ocorrencias) > 1 ? h("span", { class: "selo", text: `${s.ocorrencias}× no histórico` }) : null),
      ta, s.evidencia ? h("p", { class: "evidencia", text: "Onde apareceu: " + s.evidencia }) : null,
      filtro !== "PENDENTE" && s.decidido_ms ? h("p", { class: "evidencia", text: `${filtro === "APROVADA" ? "Aprovada" : "Rejeitada"} por ${s.decidido_por || "—"} · ${quando(s.decidido_ms)}` }) : null);
    if (editavel) {
      const decidir = acao => async () => {
        try {
          await eng("learning/suggestions/" + s.id, { metodo: "POST", corpo: { acao, conteudo: ta.value.trim() } });
          aviso(acao === "aprovar" ? (s.tipo === "ESTILO" ? "Aprovado: entrou nos exemplos de conversa." : "Aprovado: entrou no treinamento.") : "Sugestão rejeitada.", "ok");
          cartao.remove();
          atualizarStatus();
        } catch (e) { aviso(e.message, "erro"); }
      };
      cartao.appendChild(h("div", { class: "acoes" }, botao("Aprovar", decidir("aprovar"), "btn-primario btn-pequeno"), botao("Rejeitar", decidir("rejeitar"), "btn-secundario btn-pequeno"), h("span", { style: "font-size:12.5px;color:var(--texto-3)", text: "Você pode editar o texto antes de aprovar." })));
    }
    return cartao;
  }

  // ---------------------------------------------------------------------------
  // Base de clientes (importação do sistema das atendentes)
  // ---------------------------------------------------------------------------

  function lerCsv(texto) {
    texto = texto.replace(/^﻿/, "");
    const primeira = texto.split(/\r?\n/, 1)[0] || "";
    const contar = c => primeira.split(c).length - 1;
    const sep = [";", ",", "\t"].sort((a, b) => contar(b) - contar(a))[0];
    const linhas = [];
    let linha = [], valor = "", aspas = false;
    for (let i = 0; i < texto.length; i++) {
      const ch = texto[i];
      if (aspas) {
        if (ch === "\"") { if (texto[i + 1] === "\"") { valor += "\""; i++; } else aspas = false; }
        else valor += ch;
      } else if (ch === "\"") aspas = true;
      else if (ch === sep) { linha.push(valor); valor = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && texto[i + 1] === "\n") i++;
        linha.push(valor); valor = "";
        if (linha.some(v => v.trim())) linhas.push(linha);
        linha = [];
      } else valor += ch;
    }
    linha.push(valor);
    if (linha.some(v => v.trim())) linhas.push(linha);
    return linhas;
  }

  async function paginaClientes(el, _p, vivo) {
    el.appendChild(cabeca("Base de clientes", "Traga o cadastro do sistema que as atendentes usam. Com isso, a IA reconhece clientes antigos, lembra o que já foi feito e não pede dados que já existem."));
    const resumo = h("section", { class: "grade grade-3" }, [1, 2, 3].map(() => h("div", { class: "esqueleto" })));
    el.appendChild(resumo);
    let r;
    try { r = await eng("import/clients"); }
    catch (e) { if (vivo()) falha(resumo, e); return; }
    if (!vivo()) return;
    resumo.replaceChildren(metrica("Clientes na base", numero(r.clientes), "telefones diferentes"), metrica("Registros importados", numero(r.registros), "linhas recebidas"), metrica("Última importação", r.ultima_importacao_ms ? quando(r.ultima_importacao_ms) : "—", "planilha ou integração"));
    if (!pode("ADMIN")) { el.appendChild(h("p", { class: "nota", text: "Somente administradores podem importar clientes." })); return; }

    const area = h("div", { class: "grade" });
    const entrada = h("input", { type: "file", accept: ".csv,text/csv,text/plain" });
    const zona = h("label", { class: "soltar" }, icone(ICONES.nuvem), h("strong", { text: "Escolha ou arraste a planilha (CSV)" }),
      h("span", { style: "font-size:13.5px;color:var(--texto-3)", text: "No sistema das atendentes, exporte os clientes em Excel e salve como CSV. Precisa ter uma coluna com o telefone." }), entrada);
    ["dragover", "dragenter"].forEach(ev => zona.addEventListener(ev, e => { e.preventDefault(); zona.classList.add("sobre"); }));
    ["dragleave", "drop"].forEach(ev => zona.addEventListener(ev, () => zona.classList.remove("sobre")));
    zona.addEventListener("drop", e => { e.preventDefault(); if (e.dataTransfer.files[0]) processar(e.dataTransfer.files[0]); });
    entrada.addEventListener("change", () => { if (entrada.files[0]) processar(entrada.files[0]); });
    el.append(h("div", { class: "cartao vidro" }, h("h3", { text: "Importar planilha" }), h("p", { text: "Os dados ficam guardados no banco da IA desta empresa e são usados somente no atendimento." }), zona), area);

    async function processar(arquivo) {
      if (arquivo.size > 8 * 1024 * 1024) { aviso("Arquivo grande demais (máximo 8 MB). Divida a planilha em partes.", "erro"); return; }
      let texto = await arquivo.text();
      if (texto.includes("�")) {
        // Planilhas antigas do Excel costumam vir em Windows-1252.
        try { texto = new TextDecoder("windows-1252").decode(await arquivo.arrayBuffer()); } catch { /* mantém */ }
      }
      const linhas = lerCsv(texto);
      if (linhas.length < 2) { aviso("Não encontrei linhas na planilha. Confira se é um CSV com cabeçalho.", "erro"); return; }
      const cab = linhas[0].map((c, i) => c.trim() || `Coluna ${i + 1}`);
      const dados = linhas.slice(1);
      const sensivel = /cpf|rg\b|documento|senha|cart[aã]o|cnh/i;
      const palpite = Math.max(0, cab.findIndex(c => /tel|fone|celular|whats|contato/i.test(c)));
      const colTel = h("select", { class: "entrada" }, cab.map((c, i) => h("option", { value: i, selected: i === palpite, text: c })));
      const marcas = cab.map(c => h("input", { type: "checkbox", checked: !sensivel.test(c) }));
      const tabela = h("div", { class: "tabela-caixa" }, h("table", {}, h("thead", {}, h("tr", {}, cab.map(c => h("th", { text: c })))),
        h("tbody", {}, dados.slice(0, 5).map(l => h("tr", {}, cab.map((_, i) => h("td", { text: (l[i] || "").slice(0, 80) })))))));
      const progresso = h("div", { class: "barra-progresso oculto" }, h("i", {}));
      const enviar = botao(`Importar ${numero(dados.length)} linha(s)`, async () => {
        const iTel = Number(colTel.value);
        const usar = cab.map((_, i) => i !== iTel && marcas[i].checked);
        const registros = dados.map(l => {
          const o = { telefone: l[iTel] || "" };
          cab.forEach((c, i) => { if (usar[i] && String(l[i] || "").trim()) o[c.slice(0, 40)] = String(l[i]).trim().slice(0, 300); });
          return o;
        });
        progresso.classList.remove("oculto");
        let importadas = 0, ignoradas = 0;
        try {
          for (let i = 0; i < registros.length; i += 500) {
            const r = await eng("import/clients", { metodo: "POST", corpo: { origem: arquivo.name.slice(0, 80), linhas: registros.slice(i, i + 500) } });
            importadas += r.importadas || 0; ignoradas += r.ignoradas || 0;
            progresso.firstChild.style.width = Math.round(((i + 500) / registros.length) * 100) + "%";
          }
          await modal({ titulo: "Importação concluída", conteudo: [`${numero(importadas)} cliente(s) importado(s).`, ignoradas ? `${numero(ignoradas)} linha(s) ignorada(s) por não terem telefone válido ou dados.` : "Nenhuma linha ignorada."], soInformar: true });
          navegar();
        } catch (e) { aviso(`Parou com ${numero(importadas)} importado(s): ${e.message}`, "erro"); }
      }, "btn-primario");
      area.replaceChildren(h("div", { class: "cartao vidro formulario" },
        h("h3", { text: `${arquivo.name} · ${numero(dados.length)} linha(s)` }),
        campo("Qual coluna tem o telefone?", colTel),
        h("div", {}, h("p", { style: "margin:0 0 8px;font-weight:600;color:var(--texto-2);font-size:14px", text: "Colunas que a IA pode usar" }),
          h("div", { style: "display:flex;flex-wrap:wrap;gap:8px 18px" }, cab.map((c, i) => h("label", { style: "display:flex;gap:6px;align-items:center;font-size:14px" }, marcas[i], c)))),
        cab.some(c => sensivel.test(c)) ? h("p", { class: "nota nota-alerta", text: "Desmarcamos colunas com documentos (como CPF). A IA não precisa deles para atender." }) : null,
        h("p", { style: "margin:0;font-size:13px;color:var(--texto-3)", text: "Prévia das primeiras linhas:" }), tabela, progresso, h("div", { class: "acoes" }, enviar)));
    }
  }

  // ---------------------------------------------------------------------------
  // Integrações
  // ---------------------------------------------------------------------------

  async function paginaIntegracoes(el, _p, vivo) {
    el.appendChild(cabeca("Integrações", "Conecte a IA desta empresa e os sistemas que a equipe já usa."));
    const area = h("div", { class: "grade grade-2" }, h("div", { class: "esqueleto" }), h("div", { class: "esqueleto" }));
    el.appendChild(area);
    let i;
    try { i = await org("integracao"); }
    catch (e) { if (vivo()) falha(area, e); return; }
    if (!vivo()) return;
    const editar = pode("ADMIN");
    const direta = i.origem === "direta";
    const url = h("input", { class: "entrada", type: "url", value: direta ? "" : i.engine_url, placeholder: "https://denia.seu-usuario.workers.dev", readOnly: !editar, autocomplete: "off", spellcheck: "false" });
    const token = h("input", { class: "entrada", type: "password", placeholder: i.token_configurado ? "Token guardado · cole aqui para trocar" : "Cole aqui o DENIA_PLATFORM_SERVICE_TOKEN do Worker \"denia\"", readOnly: !editar, autocomplete: "new-password", spellcheck: "false" });
    const resultado = h("div", {});
    const testar = async () => {
      resultado.replaceChildren(carregando("Testando…"));
      try {
        const r = await org("integracao/testar", { metodo: "POST", corpo: {} });
        resultado.replaceChildren(r.ok ? h("p", { class: "nota", text: `Conexão funcionando · DENIA Engine ${r.versao}${r.saude && r.saude.ok ? " · tudo operacional" : " · há itens pendentes no Painel"}.` }) : h("p", { class: "nota nota-alerta", text: r.erro }));
        if (r.ok) { estado.status = null; atualizarStatus(); }
      } catch (e) { resultado.replaceChildren(h("p", { class: "nota nota-alerta", text: e.message })); }
    };
    const origemToken = { plataforma: "salvo aqui na plataforma", cloudflare: "secret DENIA_PLATFORM_SERVICE_TOKEN do Worker denia-landing" }[i.token_origem] || "";
    const engine = h("section", { class: "cartao vidro formulario" },
      h("div", { class: "sugestao-topo" }, h("h3", { style: "margin:0;margin-right:auto", text: "DENIA Engine (a IA do WhatsApp)" }), direta || (i.token_configurado && i.engine_url) ? selo(direta ? "Ligação direta" : "Conectado", "ok") : selo("Não conectado", "alerta")),
      h("p", { style: "margin:0;color:var(--texto-2);font-size:14px", text: direta ? "A Central está ligada direto ao Worker \"denia\" da Cloudflare, por dentro da Cloudflare. Só falta o token: ele precisa ser exatamente o mesmo DENIA_PLATFORM_SERVICE_TOKEN que está no Worker \"denia\"." : "É o Worker da Cloudflare que atende o WhatsApp desta empresa. A plataforma conversa com ele de servidor para servidor; o token fica cifrado e nunca aparece no navegador." }),
      direta ? null : campo("Endereço do Engine", url),
      campo("Token de serviço", token, direta ? "Copie o valor do secret DENIA_PLATFORM_SERVICE_TOKEN do Worker \"denia\" (Settings → Variables and Secrets) e cole aqui." : ""),
      direta && i.token_configurado ? h("p", { class: "nota", text: `Token em uso: termina em …${i.token_final} (${i.token_tamanho} caracteres) · ${origemToken}.` }) : null,
      direta && !i.token_configurado ? h("p", { class: "nota nota-alerta", text: "Nenhum token configurado ainda." }) : null,
      i.atualizado_ms ? h("p", { style: "margin:0;font-size:13px;color:var(--texto-3)", text: `Atualizado ${quandoFrase(i.atualizado_ms)}${i.atualizado_por ? " por " + i.atualizado_por : ""}` }) : null,
      editar ? h("div", { class: "acoes" },
        botao("Salvar", async () => {
          try {
            await org("integracao", { metodo: "POST", corpo: { engine_url: direta ? "" : url.value.trim(), token: token.value.trim() } });
            token.value = "";
            aviso("Integração salva.", "ok");
            await recarregarEu(estado.org.id);
            await navegar();
            if (direta) aviso("Agora clique em Testar conexão.");
          } catch (e) { aviso(e.message, "erro"); }
        }, "btn-primario"),
        botao("Testar conexão", testar)) : h("p", { class: "nota", text: "Somente administradores podem alterar a integração." }),
      resultado,
      direta ? null : h("details", {}, h("summary", { style: "cursor:pointer;font-weight:600;font-size:14px", text: "Como conectar (passo a passo)" }),
        h("ol", { class: "passos", style: "margin-top:12px" },
          h("li", {}, "Na Cloudflare, abra o Worker da DENIA → Settings → Variables and Secrets."),
          h("li", {}, "Crie o secret ", h("span", { class: "codigo", text: "DENIA_PLATFORM_SERVICE_TOKEN" }), " com uma senha longa (40 caracteres ou mais) e salve."),
          h("li", {}, "Copie o endereço do Worker (termina em ", h("span", { class: "codigo", text: ".workers.dev" }), ")."),
          h("li", {}, "Cole o endereço e o mesmo token aqui, salve e clique em Testar conexão."))));

    const s = estado.status;
    // Chave da OpenAI (liga a criação de posts, imagens e a voz da DENIA).
    let k = { configurada: false };
    try { k = await org("ia/chave"); } catch { /* segue sem */ }
    if (!vivo()) return;
    const chaveIn = h("input", { class: "entrada", type: "password", placeholder: k.configurada ? "Chave guardada · cole aqui para trocar" : "Cole aqui a chave (começa com sk-)", readOnly: !editar, autocomplete: "new-password", spellcheck: "false" });
    const resIa = h("div", {});
    const testarIa = async () => {
      resIa.replaceChildren(carregando("Testando a chave…"));
      try { const r = await org("ia/chave/testar", { metodo: "POST", corpo: {} }); resIa.replaceChildren(h("p", { class: r.ok ? "nota" : "nota nota-alerta", text: r.ok ? "Chave funcionando. Posts, imagens e a voz da DENIA estão ligados." : r.erro })); }
      catch (e) { resIa.replaceChildren(h("p", { class: "nota nota-alerta", text: e.message })); }
    };
    const ia = h("section", { class: "cartao vidro formulario", id: "cartao-openai" },
      h("div", { class: "sugestao-topo" }, h("h3", { style: "margin:0;margin-right:auto", text: "Inteligência da DENIA (OpenAI)" }), k.configurada ? selo("Ligada", "ok") : selo("Desligada", "erro")),
      h("p", { style: "margin:0;color:var(--texto-2);font-size:14px", text: "Cole uma única vez: liga a criação de posts e imagens, a conversa por voz ao vivo e os comandos da DENIA. Fica guardada para sempre (cifrada) e vale também para as outras empresas da plataforma." }),
      campo("Chave da OpenAI", chaveIn, "Em platform.openai.com → API keys → Create new secret key. Copie e cole aqui."),
      k.configurada ? h("p", { class: "nota", text: `Chave em uso${k.final ? ": termina em …" + k.final : ""} · ${({ plataforma: "salva aqui na plataforma, vale para sempre", central: "a mesma da Central de Atendimento", cloudflare: "secret OPENAI_API_KEY da Cloudflare" })[k.origem] || ""}.` }) : null,
      editar ? h("div", { class: "acoes" },
        botao("Salvar chave", async () => {
          try { await org("ia/chave", { metodo: "POST", corpo: { chave: chaveIn.value } }); chaveIn.value = ""; aviso("Chave salva.", "ok"); estado.iaLigada = true; await navegar(); setTimeout(() => { const b = document.querySelector("#cartao-openai .btn-testar-ia"); if (b) b.click(); }, 50); }
          catch (e) { aviso(e.message, "erro"); }
        }, "btn-primario"),
        botao("Testar chave", testarIa, "btn-secundario btn-testar-ia")) : h("p", { class: "nota", text: "Somente administradores podem colar a chave." }),
      resIa);
    const sistema = h("section", { class: "cartao vidro formulario" },
      h("h3", { style: "margin:0", text: "Sistema das atendentes (cadastro de clientes)" }),
      h("p", { style: "margin:0;color:var(--texto-2);font-size:14px", text: "Existem duas formas de ligar o sistema que a equipe já usa à IA. Elas podem funcionar juntas." }),
      h("div", { class: "lista-saude", style: "display:grid;gap:10px" },
        h("div", { class: "cartao", style: "padding:14px;border:1px solid var(--borda);border-radius:14px" }, h("strong", { text: "1. Planilha (funciona com qualquer sistema)" }),
          h("p", { style: "margin:6px 0 10px;color:var(--texto-2);font-size:14px", text: "Exporte os clientes do sistema e importe aqui. Repita quando quiser atualizar." }), h("a", { class: "btn btn-secundario btn-pequeno", href: "#/clientes" }, "Importar planilha")),
        h("div", { class: "cartao", style: "padding:14px;border:1px solid var(--borda);border-radius:14px" }, h("strong", { text: "2. Conexão automática (se o sistema tiver API)" }),
          h("p", { style: "margin:6px 0 10px;color:var(--texto-2);font-size:14px", text: "A IA consulta a ficha do cliente em tempo real e envia os atendimentos para o sistema. Peça ao fornecedor do sistema um endereço de consulta por telefone e um token." }),
          s ? h("div", { style: "display:flex;flex-wrap:wrap;gap:8px" }, s.plataforma_cadastro_consulta ? selo("Consulta de ficha ativa", "ok") : selo("Consulta de ficha não configurada"), s.plataforma_cadastro_envio ? selo("Envio de atendimentos ativo", "ok") : selo("Envio de atendimentos não configurado")) : null)),
      h("p", { class: "nota", text: "Informe o nome do sistema que as atendentes usam ao responsável técnico: se ele tiver API, a conexão automática é configurada no Engine (CRM_CONSULTA_URL e PLATAFORMA_API_URL)." }));
    area.replaceChildren(ia, engine, sistema);
  }

  // ---------------------------------------------------------------------------
  // Equipe
  // ---------------------------------------------------------------------------

  async function mostrarSenha(email, senha) {
    const caixa = h("div", { class: "senha-mostrada" }, h("span", { style: "flex:1", text: senha }), botao("Copiar", () => copiar(senha), "btn-secundario btn-pequeno"));
    await modal({ titulo: "Senha temporária", conteudo: [`Envie para ${email} por um canal seguro (por exemplo, pessoalmente ou por WhatsApp).`, caixa, "Ela só aparece agora. No primeiro acesso, a pessoa cria uma senha nova."], soInformar: true });
  }

  async function paginaEquipe(el, _p, vivo) {
    el.appendChild(cabeca("Equipe", `Quem acessa o painel da ${estado.org.nome} e o que cada pessoa pode fazer.`));
    const nome = h("input", { class: "entrada", maxlength: "120", autocomplete: "off" });
    const email = h("input", { class: "entrada", type: "email", maxlength: "254", autocomplete: "off" });
    const papel = h("select", { class: "entrada" }, PAPEIS.filter(([k]) => k !== "OWNER" || estado.papel === "OWNER").map(([k, n]) => h("option", { value: k, selected: k === "AGENTE", text: n })));
    el.appendChild(h("section", { class: "cartao vidro formulario" }, h("h3", { style: "margin:0", text: "Adicionar pessoa" }),
      h("div", { class: "linha-form" }, campo("Nome", nome), campo("E-mail", email), campo("Perfil", papel)),
      h("div", { class: "acoes" }, botao("Adicionar", async () => {
        try {
          const r = await org("membros", { metodo: "POST", corpo: { nome: nome.value, email: email.value, papel: papel.value } });
          aviso("Pessoa adicionada.", "ok");
          if (r.senha_temporaria) await mostrarSenha(email.value.trim(), r.senha_temporaria);
          navegar();
        } catch (e) { aviso(e.message, "erro"); }
      }, "btn-primario"), h("span", { style: "font-size:13px;color:var(--texto-3)", text: "Proprietário e administrador gerenciam tudo; atendente opera conversas e atendimentos; somente leitura apenas acompanha." }))));
    const area = h("div", {}, carregando());
    el.appendChild(area);
    let membros;
    try { membros = (await org("membros")).membros || []; }
    catch (e) { if (vivo()) falha(area, e); return; }
    if (!vivo()) return;
    if (!membros.length) { area.replaceChildren(h("div", { class: "cartao vidro" }, vazio("Ninguém na equipe ainda", "Adicione as atendentes e os responsáveis acima."))); return; }
    const eu = estado.eu.usuario.id;
    area.replaceChildren(h("div", { class: "tabela-caixa" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", { text: "Pessoa" }), h("th", { text: "Perfil" }), h("th", { text: "Último acesso" }), h("th", { text: "" }))),
      h("tbody", {}, membros.map(m => {
        const proprio = m.id === eu;
        const podeMexer = !proprio && (m.papel !== "OWNER" || estado.papel === "OWNER");
        const sel = h("select", { class: "entrada", style: "min-height:36px;padding:4px 34px 4px 10px", disabled: !podeMexer, "aria-label": "Perfil de " + m.email }, PAPEIS.filter(([k]) => k !== "OWNER" || estado.papel === "OWNER" || m.papel === "OWNER").map(([k, n]) => h("option", { value: k, selected: k === m.papel, text: n })));
        sel.addEventListener("change", async () => {
          try { await org("membros/" + m.id, { metodo: "POST", corpo: { acao: "papel", papel: sel.value } }); aviso("Perfil atualizado.", "ok"); }
          catch (e) { aviso(e.message, "erro"); sel.value = m.papel; }
        });
        return h("tr", {},
          h("td", {}, h("strong", { text: m.nome || m.email }), h("span", { class: "sub", text: m.email }), m.trocar_senha ? h("span", { class: "sub", text: "Ainda não criou a própria senha" }) : null),
          h("td", {}, sel), h("td", { text: m.ultimo_acesso_ms ? quando(m.ultimo_acesso_ms) : "Nunca acessou" }),
          h("td", {}, podeMexer ? h("div", { class: "acoes", style: "justify-content:flex-end" },
            botao("Nova senha", async () => {
              if (!(await modal({ titulo: "Gerar nova senha?", conteudo: `A senha atual de ${m.email} deixa de funcionar e as sessões abertas são encerradas.`, confirmar: "Gerar" }))) return;
              try { const r = await org("membros/" + m.id, { metodo: "POST", corpo: { acao: "nova_senha" } }); await mostrarSenha(m.email, r.senha_temporaria); navegar(); }
              catch (e) { aviso(e.message, "erro"); }
            }, "btn-secundario btn-pequeno"),
            botao("Remover", async () => {
              if (!(await modal({ titulo: "Remover da equipe?", conteudo: `${m.email} perde o acesso a esta empresa imediatamente.`, confirmar: "Remover", perigo: true }))) return;
              try { await org("membros/" + m.id, { metodo: "POST", corpo: { acao: "remover" } }); aviso("Removido da equipe.", "ok"); navegar(); }
              catch (e) { aviso(e.message, "erro"); }
            }, "btn-perigo btn-pequeno")) : h("span", { class: "sub", text: proprio ? "Você" : "" })));
      })))));
  }

  // ---------------------------------------------------------------------------
  // Auditoria
  // ---------------------------------------------------------------------------

  const NOME_ACAO = { CONVERSA: "Conversa", ATENDIMENTO: "Atendimento", TREINAMENTO: "Treinamento", APRENDIZADO: "Aprendizado", IMPORTACAO: "Importação", PAUSA_GERAL: "Pausa geral", GUIA: "Guia de lojas", WHATSAPP: "WhatsApp", CHATBOT: "Chatbot", EQUIPE: "Equipe", INTEGRACAO: "Integração", EMPRESA: "Empresa" };
  async function paginaAuditoria(el, _p, vivo) {
    el.appendChild(cabeca("Auditoria", "Tudo o que foi feito pelo painel nesta empresa: quem fez, o quê e quando."));
    const area = h("div", {}, carregando());
    el.appendChild(area);
    let ev;
    try { ev = (await org("auditoria")).eventos || []; }
    catch (e) { if (vivo()) falha(area, e); return; }
    if (!vivo()) return;
    area.replaceChildren(ev.length ? h("div", { class: "tabela-caixa" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", { text: "Quando" }), h("th", { text: "Pessoa" }), h("th", { text: "Área" }), h("th", { text: "O que foi feito" }))),
      h("tbody", {}, ev.map(x => h("tr", {}, h("td", { text: quando(x.criado_ms) }), h("td", { text: x.email || "—" }), h("td", { text: NOME_ACAO[x.acao] || x.acao }), h("td", { text: x.detalhe || "—" })))))) : h("div", { class: "cartao vidro" }, vazio("Nada registrado ainda", "")));
  }

  // ---------------------------------------------------------------------------
  // Empresas (administrador geral)
  // ---------------------------------------------------------------------------

  async function paginaEmpresas(el) {
    el.appendChild(cabeca("Empresas", "Cada empresa tem o seu próprio painel, equipe, IA e dados. Somente você, como administrador geral, vê esta lista."));
    const nome = h("input", { class: "entrada", maxlength: "120" });
    const segmento = h("input", { class: "entrada", maxlength: "160", placeholder: "Ex.: Assistência técnica" });
    const cor = h("input", { class: "entrada", type: "color", value: "#4f8cff", style: "padding:4px;height:46px" });
    let cfgPlanos = null;
    try { cfgPlanos = await api("/api/admin/planos"); } catch { cfgPlanos = null; }
    const nomesPlanos = cfgPlanos ? Object.values(cfgPlanos.planos).map(p => [p.id, p.nome]) : [["start", "Start"]];
    const planoNovo = h("select", { class: "entrada" }, nomesPlanos.map(([v, n]) => h("option", { value: v, selected: v === "start", text: n })));
    const situacaoNova = h("select", { class: "entrada" }, [["TESTE", "Teste grátis de 7 dias"], ["CORTESIA", "Cortesia — acesso total sem custo"]].map(([v, n]) => h("option", { value: v, text: n })));
    el.appendChild(h("section", { class: "cartao vidro formulario" }, h("h3", { style: "margin:0", text: "Nova empresa" }),
      h("div", { class: "linha-form" }, campo("Nome", nome), campo("Segmento", segmento), campo("Cor", cor)),
      h("div", { class: "linha-form" }, campo("Plano", planoNovo), campo("Situação", situacaoNova)),
      h("div", { class: "acoes" }, botao("Criar empresa", async () => {
        try {
          const r = await api("/api/admin/organizacoes", { metodo: "POST", corpo: { nome: nome.value, segmento: segmento.value, cor: cor.value, plano: planoNovo.value, plano_status: situacaoNova.value } });
          aviso("Empresa criada.", "ok");
          await recarregarEu(r.id);
          location.hash = "#/integracoes";
        } catch (e) { aviso(e.message, "erro"); }
      }, "btn-primario"))));
    const lista = estado.eu.organizacoes;
    el.appendChild(h("div", { class: "tabela-caixa" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", { text: "Empresa" }), h("th", { text: "IA" }), h("th", { text: "Plano" }), h("th", { text: "Situação" }), h("th", { text: "" }))),
      h("tbody", {}, lista.map(o => h("tr", {},
        h("td", {}, h("strong", { text: o.nome }), h("span", { class: "sub", text: o.segmento || "—" })),
        h("td", {}, o.conectada ? selo("Conectada", "ok") : o.chatbot ? selo("Chatbot", "ok") : selo("Não conectada", "alerta")),
        h("td", {}, h("strong", { text: (o.acesso || {}).nome || o.plano }), h("span", { class: "sub", text: (NOME_STATUS_PLANO[(o.acesso || {}).status] || "") + ((o.acesso || {}).dias != null && !(o.acesso || {}).cortesia ? ` · ${(o.acesso || {}).dias} dia(s)` : "") }),
          botao("Mudar", () => mudarPlanoEmpresa(o, nomesPlanos), "btn-secundario btn-pequeno")),
        h("td", {}, o.status === "ATIVA" ? selo("Ativa", "ok") : selo("Suspensa", "erro")),
        h("td", {}, h("div", { class: "acoes", style: "justify-content:flex-end" },
          botao("Abrir painel", () => { escolherEmpresa(o.id); location.hash = "#/painel"; }, "btn-secundario btn-pequeno"),
          botao(o.status === "ATIVA" ? "Suspender" : "Reativar", async () => {
            const suspender = o.status === "ATIVA";
            if (suspender && !(await modal({ titulo: `Suspender ${o.nome}?`, conteudo: "A equipe da empresa perde o acesso ao painel. A IA do WhatsApp não é afetada.", confirmar: "Suspender", perigo: true }))) return;
            try { await api("/api/admin/organizacoes/" + o.id, { metodo: "POST", corpo: { status: suspender ? "SUSPENSA" : "ATIVA" } }); await recarregarEu(); navegar(); }
            catch (e) { aviso(e.message, "erro"); }
          }, o.status === "ATIVA" ? "btn-perigo btn-pequeno" : "btn-secundario btn-pequeno")))))))));
    if (cfgPlanos) el.appendChild(cartaoValoresPlanos(cfgPlanos));
    el.appendChild(h("section", { class: "cartao vidro formulario" }, h("h3", { style: "margin:0", text: "Bot do Telegram da plataforma" }),
      h("p", { class: "sub", style: "margin:0", text: "Um bot só para todas as empresas: cada uma conecta o grupo com um toque. Crie o bot no @BotFather, salve o token no secret TELEGRAM_BOT_TOKEN_PLATAFORMA do Worker da plataforma e clique abaixo." }),
      h("div", { class: "acoes" }, botao("Ligar o bot", async () => { try { const r = await api("/api/admin/telegram", { metodo: "POST", corpo: {} }); aviso(`Bot @${r.bot} ligado.`, "ok"); } catch (e) { aviso(e.message, "erro"); } }, "btn-primario btn-pequeno"))));
  }
  function mudarPlanoEmpresa(o, nomesPlanos) {
    const plano = h("select", { class: "entrada" }, nomesPlanos.map(([v, n]) => h("option", { value: v, selected: v === o.plano, text: n })));
    const sit = h("select", { class: "entrada" }, [["TESTE", "Teste grátis"], ["ATIVO", "Ativo (pago)"], ["CORTESIA", "Cortesia — acesso total sem custo"], ["CANCELADO", "Cancelado"], ["BLOQUEADO", "Bloqueado"]].map(([v, n]) => h("option", { value: v, selected: v === o.plano_status, text: n })));
    const dias = h("input", { class: "entrada", type: "number", min: "0", max: "365", value: "0" });
    const ate = h("input", { class: "entrada", type: "date" });
    const fechar = gaveta(`Plano de ${o.nome}`, [
      campo("Plano", plano), campo("Situação", sit, "Cortesia libera todos os recursos sem cobrança — só para as empresas que você aprovar."),
      campo("Mais dias de teste", dias), campo("Liberado (pago) até", ate, "Use para pagamentos recebidos fora da plataforma."),
      h("div", { class: "acoes" }, botao("Salvar", async () => {
        try { await api("/api/admin/organizacoes/" + o.id, { metodo: "POST", corpo: { plano: plano.value, plano_status: sit.value, mais_dias_teste: Number(dias.value) || 0, pago_ate: ate.value || undefined } }); aviso("Plano atualizado.", "ok"); fechar(); await recarregarEu(); navegar(); }
        catch (e) { aviso(e.message, "erro"); }
      }, "btn-primario"))]);
  }
  function cartaoValoresPlanos(cfg) {
    const ent = {};
    const desconto = h("input", { class: "entrada", type: "number", min: "0", max: "50", value: String(Math.round(cfg.desconto_anual * 100)) });
    return h("section", { class: "cartao vidro formulario" }, h("h3", { style: "margin:0", text: "Valores dos planos" }),
      h("p", { class: "sub", style: "margin:0", text: cfg.cobranca ? "Cobrança on-line ligada (Asaas)." : "Cobrança on-line desligada: crie no Worker da plataforma ASAAS_API_KEY e ASAAS_WEBHOOK_TOKEN para receber por Pix, boleto e cartão." }),
      h("div", { class: "tabela-caixa" }, h("table", {}, h("thead", {}, h("tr", {}, ["Plano", "Mensal (R$)", "Anual (R$, vazio = automático)", "Pessoas", "IA do chatbot/mês", "Aparece"].map(t => h("th", { text: t })))),
        h("tbody", {}, Object.values(cfg.planos).map(p => { ent[p.id] = { mensal: h("input", { class: "entrada entrada-preco", type: "number", min: "0", value: String(p.mensal) }), anual: h("input", { class: "entrada entrada-preco", type: "number", min: "0", placeholder: String(p.anual) }), usuarios: h("input", { class: "entrada entrada-preco", type: "number", min: "1", value: String(p.limites.usuarios) }), ia: h("input", { class: "entrada entrada-preco", type: "number", min: "0", value: String(p.limites.ia_mes) }), visivel: h("input", { type: "checkbox", checked: p.visivel }) };
          return h("tr", {}, h("td", {}, h("strong", { text: p.nome })), h("td", {}, ent[p.id].mensal), h("td", {}, ent[p.id].anual), h("td", {}, ent[p.id].usuarios), h("td", {}, ent[p.id].ia), h("td", {}, ent[p.id].visivel)); })))),
      campo("Desconto do plano anual (%)", desconto),
      h("div", { class: "acoes" }, botao("Salvar valores", async () => {
        try { await api("/api/admin/planos", { metodo: "POST", corpo: { desconto_anual: (Number(desconto.value) || 0) / 100, planos: Object.fromEntries(Object.entries(ent).map(([id, e]) => [id, { mensal: Number(e.mensal.value), anual: Number(e.anual.value) || 0, visivel: e.visivel.checked, limites: { usuarios: Number(e.usuarios.value), ia_mes: Number(e.ia.value) } }])) } }); aviso("Valores salvos.", "ok"); }
        catch (e) { aviso(e.message, "erro"); }
      }, "btn-primario")));
  }

  // ---------------------------------------------------------------------------
  // Conta
  // ---------------------------------------------------------------------------

  async function paginaConta(el) {
    const u = estado.eu.usuario;
    if (u.trocar_senha) el.appendChild(h("p", { class: "nota nota-alerta", text: "Bem-vinda(o)! Para continuar, crie a sua senha pessoal no lugar da senha temporária." }));
    el.appendChild(cabeca("Conta e segurança", u.email + (u.super_admin ? " · administrador geral" : estado.org ? ` · ${NOME_PAPEL[estado.papel] || ""} na ${estado.org.nome}` : "")));
    const nome = h("input", { class: "entrada", value: u.nome || "", maxlength: "120" });
    const seletorIdioma = window.denia_seletor_idioma ? window.denia_seletor_idioma() : null;
    const perfil = h("section", { class: "cartao vidro formulario" }, h("h3", { style: "margin:0", text: "Perfil" }), campo("Seu nome", nome),
      seletorIdioma ? h("div", { class: "campo" }, h("label", { text: "Idioma / Language" }), seletorIdioma) : null,
      h("div", { class: "acoes" }, botao("Salvar nome", async () => {
        try { await api("/api/conta", { metodo: "POST", corpo: { acao: "perfil", nome: nome.value } }); u.nome = nome.value.trim(); $("usuario").textContent = u.nome || u.email; aviso("Nome atualizado.", "ok"); }
        catch (e) { aviso(e.message, "erro"); }
      }, "btn-primario")));
    let senha;
    if (u.super_admin && !u.tem_senha) {
      senha = h("section", { class: "cartao vidro formulario" }, h("h3", { style: "margin:0", text: "Senha" }), h("p", { class: "nota", text: "A senha do administrador geral é o secret PLATFORM_ADMIN_PASSWORD, na Cloudflare (Workers → denia-platform → Settings → Variables and Secrets)." }));
    } else {
      const atual = h("input", { class: "entrada", type: "password", autocomplete: "current-password" });
      const nova = h("input", { class: "entrada", type: "password", autocomplete: "new-password", minlength: "10" });
      const conf = h("input", { class: "entrada", type: "password", autocomplete: "new-password" });
      senha = h("section", { class: "cartao vidro formulario" }, h("h3", { style: "margin:0", text: u.trocar_senha ? "Crie a sua senha" : "Trocar senha" }),
        campo(u.trocar_senha ? "Senha temporária" : "Senha atual", atual), campo("Nova senha", nova, "Mínimo de 10 caracteres, com letras e números."), campo("Repita a nova senha", conf),
        h("div", { class: "acoes" }, botao("Salvar senha", async () => {
          if (nova.value !== conf.value) { aviso("As senhas novas não são iguais.", "erro"); return; }
          try {
            await api("/api/conta", { metodo: "POST", corpo: { acao: "senha", atual: atual.value, nova: nova.value } });
            aviso("Senha atualizada.", "ok");
            const vinhaTemporaria = u.trocar_senha;
            u.trocar_senha = false;
            atual.value = nova.value = conf.value = "";
            if (vinhaTemporaria) { await recarregarEu(); location.hash = "#/painel"; navegar(); }
          } catch (e) { aviso(e.message, "erro"); }
        }, "btn-primario")));
    }
    const sessoes = h("section", { class: "cartao vidro formulario" }, h("h3", { style: "margin:0", text: "Sessões" }),
      h("p", { style: "margin:0;color:var(--texto-2);font-size:14px", text: `Esta sessão expira ${quandoFrase(estado.eu.sessao_expira_ms)}. Por segurança, o acesso dura no máximo 8 horas.` }),
      h("div", { class: "acoes" }, botao("Sair de todos os dispositivos", async () => {
        if (!(await modal({ titulo: "Sair de todos os dispositivos?", conteudo: "Todas as sessões abertas, inclusive esta, são encerradas.", confirmar: "Sair de todos", perigo: true }))) return;
        try { await api("/api/conta", { metodo: "POST", corpo: { acao: "sair_de_todos" } }); } catch { /* segue */ }
        window.location.replace("/entrar");
      }, "btn-perigo")));
    el.appendChild(h("div", { class: "grade grade-2" }, u.trocar_senha ? [senha] : [perfil, senha, sessoes]));
  }

  // ---------------------------------------------------------------------------
  // Canais
  // ---------------------------------------------------------------------------

  // Diagnóstico do WhatsApp: lê o estado do motor e explica, em português, por que a IA não está respondendo.
  function diagnosticar(st) {
    const itens = [], quando = ms => new Date(ms).toLocaleString(LOCALE);
    if (!st) return [["erro", "A plataforma não consegue falar com a IA do WhatsApp (Worker denia). Se você colou um motor novo, confira se colou o arquivo inteiro, sem faltar nada no fim, e clicou em Deploy."]];
    if (st.pausa_geral) itens.push(["erro", "A IA está PAUSADA para todos os clientes. Vá no Painel e clique em \"Retomar IA\" (ou peça à DENIA: \"retome a IA do WhatsApp\")."]);
    if (st.d1 && !st.d1.operacional) itens.push(["erro", "O banco de dados do motor não está respondendo" + (st.d1.erro ? `: ${st.d1.erro}` : ".") + " A IA entra no modo de contingência."]);
    if (!st.openai_configurado) itens.push(["erro", "Falta a chave da OpenAI no Worker denia (secret OPENAI_API_KEY)."]);
    else if (st.teste_openai && !st.teste_openai.ok) itens.push(["erro", st.teste_openai.codigo === 401 ? "A OpenAI RECUSOU a chave do Worker denia (OPENAI_API_KEY): ela foi apagada ou trocada. Crie uma chave nova em platform.openai.com → API keys e cole no secret OPENAI_API_KEY do Worker denia." : st.teste_openai.codigo === 429 ? "A conta da OpenAI está SEM CRÉDITO ou no limite. Adicione crédito em platform.openai.com → Billing." : "A OpenAI respondeu com erro: " + st.teste_openai.erro]);
    if (!st.whatsapp_configurado) itens.push(["erro", "Falta o token do WhatsApp no Worker denia (secret WHATSAPP_TOKEN)."]);
    else if (st.teste_whatsapp && !st.teste_whatsapp.ok) itens.push(["erro", st.teste_whatsapp.codigo === 190 ? "O TOKEN DO WHATSAPP EXPIROU ou foi revogado. Gere um token permanente (Meta Business → Usuários do sistema → Gerar token, com whatsapp_business_messaging) e cole no secret WHATSAPP_TOKEN do Worker denia." : "A Meta recusou o token do WhatsApp: " + st.teste_whatsapp.erro]);
    if (st.assinatura_invalida_ms && (!st.ultima_recebida_ms || st.assinatura_invalida_ms > st.ultima_recebida_ms)) itens.push(["erro", `A Meta está mandando as mensagens, mas o motor está RECUSANDO (assinatura não confere, última vez em ${quando(st.assinatura_invalida_ms)}). O secret META_APP_SECRET do Worker denia não é a chave secreta atual do app da Meta — provavelmente ela foi redefinida. Copie a chave secreta atual (Configurações do app → Básico → Mostrar) e cole no META_APP_SECRET do Worker denia.`]);
    if (st.ultima_recebida_ms && Date.now() - st.ultima_recebida_ms > 6 * 3600000 && !itens.length) itens.push(["alerta", `Nenhuma mensagem chega ao motor desde ${quando(st.ultima_recebida_ms)}. Confira no app da Meta → WhatsApp → Configuração se o webhook está verificado e com o campo "messages" assinado.`]);
    // Fila das últimas 24 h (vale também para motores antigos): mensagens com erro ou presas sem processar.
    const fila = Object.fromEntries((st.fila_24h || []).map(x => [x.status, Number(x.n || 0)]));
    if (fila.ERRO) itens.push(["erro", `${numero(fila.ERRO)} mensagem(ns) de clientes deram ERRO nas últimas 24 h e não foram respondidas. Clique em "Verificar agora" (com o motor 30.9 ou mais novo aparece o motivo exato).`]);
    if ((fila.PENDENTE || 0) + (fila.PROCESSANDO || 0) > 5) itens.push(["alerta", `${numero((fila.PENDENTE || 0) + (fila.PROCESSANDO || 0))} mensagem(ns) estão na fila esperando a IA. Se esse número só cresce, a IA travou: confira a chave da OpenAI e o token do WhatsApp.`]);
    (st.erros_24h || []).slice(0, 2).forEach(x => itens.push(["alerta", `Erro ao processar mensagens (${quando(x.em)}): ${x.erro}`]));
    const ultimaOk = st.entregas_24h && st.entregas_24h.ultima_entrega_ms;
    if (st.falhas_envio_24h && st.falhas_envio_24h.n && !(ultimaOk && st.falhas_envio_24h.em && st.falhas_envio_24h.em < ultimaOk)) itens.push(["alerta", `${st.falhas_envio_24h.n} resposta(s) não foram entregues nas últimas 24 h. Último motivo: ${st.falhas_envio_24h.ultima || "—"}`]);
    // Confirmação de entrega (motor 31.2+): a Meta aceitar não quer dizer que chegou.
    if (st.entrega_bloqueada) itens.push(["erro", `O WHATSAPP NÃO ESTÁ ENTREGANDO as mensagens (desde ${quando(st.entrega_bloqueada.em)}): ${st.entrega_bloqueada.erro} (código ${st.entrega_bloqueada.codigo}). Clientes e profissionais não recebem nada até resolver.`]);
    const en = st.entregas_24h;
    if (en && en.total) {
      const pend = en.falhas_pendentes != null ? en.falhas_pendentes : en.falhas;
      if (pend) itens.push([pend >= Math.max(3, en.total * 0.2) ? "erro" : "alerta", `${numero(pend)} mensagem(ns) NÃO chegaram desde a última entrega confirmada.` + (en.motivos || []).map(m => ` ${m.motivo} (${numero(m.n)}×, código ${m.codigo || "?"})`).join("")]);
      else if (en.falhas) itens.push(["ok", `Entregas normalizadas: ${numero(en.falhas)} mensagem(ns) falharam antes, mas desde ${en.ultima_entrega_ms ? quando(en.ultima_entrega_ms) : "então"} tudo está chegando.`]);
      else itens.push(["ok", `Entregas confirmadas pela Meta nas últimas 24 h: ${numero(en.entregues + en.lidas)} de ${numero(en.total)} (${en.taxa_entrega != null ? String(en.taxa_entrega).replace(".", ",") + "%" : "—"}), ${numero(en.lidas)} lidas.`]);
      if (en.aceitas >= 5 && !st.ultima_confirmacao_ms) itens.push(["alerta", `${numero(en.aceitas)} mensagem(ns) foram aceitas pela Meta, mas nenhuma confirmação de entrega chegou. No app da Meta → WhatsApp → Configuração → Webhooks, o campo "messages" precisa estar assinado.`]);
    }
    for (const a of (st.teste_whatsapp && st.teste_whatsapp.alertas) || []) itens.push(["erro", a]);
    if (st.teste_conta && st.teste_conta.ok) {
      if (!st.teste_conta.pagamento) itens.push(["alerta", "A conta do WhatsApp Business não tem forma de pagamento cadastrada. Mensagens de modelo (para profissionais e fora das 24 h) não são entregues sem ela: business.facebook.com → Configurações → Pagamentos do WhatsApp."]);
      if (st.teste_conta.saude && String(st.teste_conta.saude).toUpperCase() !== "AVAILABLE") itens.push(["erro", `A Meta diz que a conta ${String(st.teste_conta.saude).toUpperCase() === "LIMITED" ? "está LIMITADA" : "NÃO PODE enviar mensagens"}: ${(st.teste_conta.problemas || []).join(" · ") || "veja o Gerenciador do WhatsApp."}`]);
    }
    // Limite de chamadas da Cloudflare (plano gratuito: 50 por execução).
    const limiteCF = (/subrequest/i.test(String((st.falhas_envio_24h && st.falhas_envio_24h.ultima) || "")) && !(ultimaOk && st.falhas_envio_24h.em < ultimaOk)) || (st.fila_envio && st.fila_envio.adiadas_24h > 0 && !(st.fila_envio.pendentes === 0 && ultimaOk));
    if (st.fila_envio && st.fila_envio.pendentes && st.fila_envio.mais_antiga_ms && Date.now() - st.fila_envio.mais_antiga_ms > 5 * 60000) itens.push(["erro", `${numero(st.fila_envio.pendentes)} resposta(s) estão presas na fila de envio desde ${quando(st.fila_envio.mais_antiga_ms)}. A plataforma tenta enviar a fila a cada 5 minutos; confira se o motor 31.4 está colado e se a plataforma consegue falar com ele (Integrações → Testar).`]);
    if (limiteCF) itens.push(["alerta", `O plano gratuito da Cloudflare deixa o motor fazer só 50 chamadas por execução, e cada resposta usa quase isso. ${st.fila_envio && st.fila_envio.adiadas_24h ? `${numero(st.fila_envio.adiadas_24h)} resposta(s) nas últimas 24 h passaram pela fila de envio e saíram até 1 minuto depois.` : "O motor 31.3 coloca a resposta numa fila e envia na execução seguinte, sem perder nada."} Para responder sempre na hora: assine o Workers Paid (US$ 5/mês em dash.cloudflare.com → Workers → Planos) e crie no Worker denia a variável LIMITE_CHAMADAS = 900.`]);
    if (st.versao && /^31\.[0-2]\./.test(st.versao)) itens.push(["erro", `O motor ${st.versao} tem um erro: as tabelas novas não são criadas no banco, e no plano gratuito da Cloudflare as respostas podem não sair ("Too many subrequests"). Cole o motor 31.3 no Worker denia.`]);
    if (st.versao && !st.entregas_24h && !/^3[2-9]\./.test(st.versao)) itens.push(["alerta", `O motor ${st.versao} não sabe se as mensagens CHEGARAM (só se a Meta aceitou). Cole o motor 31.3 no Worker denia: ele confere cada entrega, avisa a equipe e mostra ✓✓ ou ⚠ em cada mensagem.`]);
    if (st.versao && /^30\.[0-8]\./.test(st.versao)) itens.push(["info", `O motor está na versão ${st.versao}. Cole o motor mais novo no Worker denia para ter as correções e este diagnóstico completo.`]);
    if (!itens.some(i => i[0] === "erro")) itens.push(["ok", `Motor funcionando${st.enviadas_24h != null ? `: ${numero(st.enviadas_24h)} resposta(s) da IA nas últimas 24 h` : ""}${st.ultima_recebida_ms ? `, última mensagem recebida em ${quando(st.ultima_recebida_ms)}` : ""}.${st.teste_whatsapp && st.teste_whatsapp.ok ? ` Token do WhatsApp válido (${st.teste_whatsapp.numero || "número ok"}).` : ""}${st.teste_openai && st.teste_openai.ok ? " Chave da OpenAI válida." : ""}`]);
    return itens;
  }
  function cartaoDiagnostico(inicial) {
    const lista = h("div", { class: "grade" });
    const desenhar = st => lista.replaceChildren(...diagnosticar(st).map(([nivel, texto]) => h("p", { class: "nota" + (nivel === "erro" ? " nota-alerta diag-erro" : nivel === "alerta" ? " nota-alerta" : ""), text: (nivel === "erro" ? "⛔ " : nivel === "alerta" ? "⚠️ " : nivel === "ok" ? "✅ " : "ℹ️ ") + texto })));
    desenhar(inicial);
    return h("section", { class: "cartao vidro" }, h("div", { class: "sugestao-topo" }, h("h3", { style: "margin:0", text: "Diagnóstico do WhatsApp" }),
      botao("Verificar agora", async (_e, b) => { b.textContent = "Testando as chaves…"; try { desenhar(await eng("status?completo=1", { fresco: true })); } catch (e) { desenhar(null); aviso(e.message, "erro"); } finally { b.textContent = "Verificar agora"; } }, "btn-primario btn-pequeno")),
      h("p", { class: "nota", text: "\"Verificar agora\" testa de verdade o token do WhatsApp e a chave da OpenAI do motor, além de pausas, erros e entregas das últimas 24 horas." }), lista);
  }
  // Números do WhatsApp (motor 31.2+): mensagens, contatos, atendimentos e entregas por dia, com gráfico.
  async function blocoNumerosWhatsapp(caixa, opcoes = {}) {
    const f = estado.numerosZap = estado.numerosZap || { dias: 30, metrica: "recebidas" };
    const fim = new Date(), ini = new Date(Date.now() - (f.dias - 1) * 86400000);
    const de = isoLocal(ini), ate = isoLocal(fim);
    trocar(caixa, carregando());
    let u;
    try { u = await eng(`usage?de=${de}&ate=${ate}`, { fresco: true }); }
    catch (e) { trocar(caixa, h("section", { class: "cartao vidro" }, h("p", { class: "nota" + (e.status === 404 ? "" : " nota-alerta"), text: e.status === 404 ? "Cole o motor 31.3 no Worker denia para ver os números do WhatsApp em gráficos." : e.message }))); return; }
    const dias = [];
    for (let t = Date.parse(u.de + "T00:00:00Z"); t <= Date.parse(u.ate + "T00:00:00Z"); t += 86400000) dias.push(new Date(t).toISOString().slice(0, 10));
    const mapa = lista => new Map((lista || []).map(x => [x.dia, Number(x.n || 0)]));
    const m = u.mensagens || {}, cs = u.casos || {};
    const fontes = { recebidas: mapa(m.recebidas), pela_ia: mapa(m.pela_ia), pela_equipe: mapa(m.pela_equipe), novos: mapa(cs.novos), concluidos: mapa(cs.concluidos) };
    const entregues = new Map(), falhas = new Map();
    for (const x of m.entregas || []) { if (["DELIVERED", "READ"].includes(x.status)) entregues.set(x.dia, (entregues.get(x.dia) || 0) + x.n); if (x.status === "FAILED") falhas.set(x.dia, (falhas.get(x.dia) || 0) + x.n); }
    const diario = dias.map(d => ({ data: d, recebidas: fontes.recebidas.get(d) || 0, pela_ia: fontes.pela_ia.get(d) || 0, pela_equipe: fontes.pela_equipe.get(d) || 0, novos: fontes.novos.get(d) || 0, concluidos: fontes.concluidos.get(d) || 0, entregues: entregues.get(d) || 0, falhas: falhas.get(d) || 0 }));
    const soma = k => diario.reduce((t, d) => t + d[k], 0);
    const en = u.entregas || {};
    const METRICAS = [["recebidas", "Mensagens recebidas", ""], ["pela_ia", "Respondidas pela DENIA", ""], ["pela_equipe", "Enviadas pela equipe", ""], ["novos", "Atendimentos abertos", ""], ["concluidos", "Atendimentos concluídos", ""], ["entregues", "Entregues", ""], ["falhas", "Não entregues", ""]];
    const recarregar = () => blocoNumerosWhatsapp(caixa, opcoes);
    const pontos = agruparSerie(diario, dias.length <= 92 ? "dia" : dias.length <= 370 ? "semana" : "mes", f.metrica);
    const nomeM = (METRICAS.find(x => x[0] === f.metrica) || ["", ""])[1];
    const csv = () => baixarCsv(`whatsapp-${u.de}-a-${u.ate}.csv`, [["Dia", ...METRICAS.map(x => x[1])], ...diario.map(d => [dataCompleta(d.data), ...METRICAS.map(x => d[x[0]])])]);
    trocar(caixa, h("section", { class: "cartao vidro" },
      h("div", { class: "cabeca-grafico" }, h("h3", { style: "margin:0", text: "Números do WhatsApp" }), botao("Baixar planilha", csv, "btn-secundario btn-pequeno")),
      opcoes.semPeriodo ? null : h("div", { class: "abas abas-chips", style: "margin:10px 0" }, [[7, "7 dias"], [30, "30 dias"], [60, "60 dias"], [90, "90 dias"], [180, "6 meses"], [365, "12 meses"]].map(([v, n]) => h("button", { type: "button", class: "aba" + (f.dias === v ? " ativo" : ""), onclick: () => { f.dias = v; recarregar(); } }, n))),
      h("section", { class: "grade grade-4" }, METRICAS.map(([k, n]) => h("button", { type: "button", class: "metrica vidro metrica-botao" + (f.metrica === k ? " ativo" : ""), "aria-pressed": f.metrica === k ? "true" : "false", onclick: () => { f.metrica = k; recarregar(); } }, h("span", { text: n }), h("strong", { text: numero(soma(k)) }), h("small", { text: `${numero(Math.round((soma(k) / (dias.length || 1)) * 10) / 10)} por dia` }))),
        h("div", { class: "metrica vidro" }, h("span", { text: "Taxa de entrega" }), h("strong", { text: en.taxa_entrega != null ? String(en.taxa_entrega).replace(".", ",") + "%" : "—" }), h("small", { text: `${numero(u.contatos || 0)} contatos diferentes no período` }))),
      h("h4", { style: "margin:16px 0 4px", text: nomeM }),
      pontos.some(p => p.valor) ? graficoLinha(pontos, null, nomeM, "") : vazio("Nada neste período", "")));
  }
  // ----- WhatsApp: visão geral, atendimento, atendimentos, profissionais, entregas, diagnóstico e conexão
  const fmtTempo = s => s == null ? "—" : s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  const NOME_ETAPA_CURTO = { COLETANDO: "Entendendo o pedido", AGUARDANDO_PRESTADOR: "Esperando profissional", AGUARDANDO_CONFIRMACAO_PRESTADOR: "Confirmando com profissional", AGUARDANDO_CLIENTE: "Esperando cliente", AGUARDANDO_ENDERECO: "Esperando endereço", EQUIPE: "Com a equipe", AGENDADO: "Agendado", EM_ANDAMENTO: "Em andamento", CONCLUIDO: "Concluído", CANCELADO: "Cancelado" };
  // Barras horizontais simples (uma cor, valor escrito ao lado — a cor não é a única informação).
  function barras(lista, formato = numero) {
    const max = Math.max(1, ...lista.map(x => x.valor));
    return h("div", { class: "barras" }, lista.map(x => h("div", { class: "barra-linha" }, h("span", { class: "barra-rotulo", text: x.rotulo }),
      h("div", { class: "barra-trilho" }, h("i", { style: `width:${Math.max(2, Math.round((x.valor / max) * 100))}%` })), h("strong", { text: formato(x.valor) }))));
  }
  // Mapa de calor dia da semana × hora (um tom só: mais forte = mais mensagens).
  function mapaHorarios(matriz) {
    const dias = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
    const max = Math.max(1, ...matriz.flat());
    const total = matriz.flat().reduce((s, x) => s + x, 0);
    let pico = [0, 0, 0];
    matriz.forEach((l, d) => l.forEach((v, hr) => { if (v > pico[2]) pico = [d, hr, v]; }));
    return h("div", {}, h("div", { class: "mapa-calor", role: "table", "aria-label": "Mensagens recebidas por dia da semana e hora" },
      h("div", { class: "mapa-linha mapa-cabeca", role: "row" }, h("span", { role: "columnheader" }), Array.from({ length: 24 }, (_, hr) => h("span", { role: "columnheader", text: hr % 3 === 0 ? String(hr) : "" }))),
      matriz.map((l, d) => h("div", { class: "mapa-linha", role: "row" }, h("span", { class: "mapa-dia", role: "rowheader", text: dias[d] }),
        l.map((v, hr) => h("span", { class: "mapa-celula", role: "cell", title: `${dias[d]} ${hr}h: ${numero(v)} mensagem(ns)`, "aria-label": `${dias[d]} ${hr}h: ${v}`, style: `background:rgba(79,140,255,${v ? (0.12 + 0.88 * v / max).toFixed(2) : 0.04})` }))))),
      h("p", { class: "sub", style: "margin:8px 0 0", text: total ? `Pico: ${dias[pico[0]]} às ${pico[1]}h (${numero(pico[2])} mensagens). Horário de Brasília. Quanto mais forte o azul, mais mensagens.` : "Sem mensagens no período." }));
  }

  // ----- Guia de lojas (motor com MODO=guia, ex.: shopping): buscas, lojas, categorias, mensagens e teste.
  // Botões e listas do WhatsApp não usam IA; só a pergunta escrita que a busca por palavra não resolve.
  const modoGuia = () => Boolean(estado.org && (estado.status ? estado.status.modo === "guia" : armazenamento.ler("denia_modo_" + estado.org.id) === "guia"));
  function aplicarModo() {
    const guia = modoGuia();
    document.querySelectorAll('#lateral-nav a[data-modo="guia"]').forEach(a => a.classList.toggle("oculto", !guia || ehRevisor()));
    document.querySelectorAll("#lateral-nav a[data-so-central]").forEach(a => a.classList.toggle("oculto", guia || ehRevisor()));
    // Empresa só com o chatbot da plataforma (sem a IA completa conectada): esconde o que depende da IA completa.
    const soChatbot = Boolean(estado.org && estado.org.chatbot && !estado.org.conectada);
    document.querySelectorAll("#lateral-nav a[data-motor]").forEach(a => a.classList.toggle("oculto", soChatbot || ehRevisor()));
    if (soChatbot) document.querySelectorAll("#lateral-nav a[data-so-central]").forEach(a => a.classList.add("oculto"));
  }
  const NOME_VIA = { BOTAO: "Pelos botões", PALAVRA: "Escreveu (achado sem IA)", IA: "Escreveu (achado pela IA)" };
  async function paginaGuia(el, aba, vivo) {
    el.appendChild(cabeca("Guia de lojas", "O cliente toca nos botões do WhatsApp (Produtos ou Serviços → categoria) e recebe as lojas com o contato de cada uma. Os botões não usam IA; só uma pergunta escrita que a busca por palavra não resolve usa o modelo econômico."));
    if (!estado.org.conectada) { falha(el, new ErroApi("A IA desta empresa ainda não foi conectada.", 503, { codigo: "ENGINE_NAO_CONFIGURADO" })); return; }
    const abas = [["visao", "Buscas"], ["lojas", "Lojas"], ["categorias", "Categorias"], ["mensagens", "Mensagens"], ["testar", "Testar"]];
    const atual = abas.some(a => a[0] === aba) ? aba : "visao";
    el.appendChild(h("div", { class: "abas", role: "tablist" }, abas.map(([k, n]) => h("a", { class: "aba" + (k === atual ? " ativo" : ""), href: "#/guia/" + k, role: "tab" }, n))));
    const area = h("div", { class: "grade" }, carregando());
    el.appendChild(area);
    const recarregar = () => { cacheEng.clear(); navegar(); };
    try {
      if (atual === "visao") return await abaGuiaBuscas(area, vivo);
      if (atual === "testar") return abaGuiaTestar(area);
      const g = await eng("guide", { fresco: true });
      if (!vivo()) return;
      if (atual === "lojas") return abaGuiaLojas(area, g, recarregar);
      if (atual === "categorias") return abaGuiaCategorias(area, g, recarregar);
      if (atual === "mensagens") return abaGuiaMensagens(area, g.config || {});
    } catch (e) {
      if (!vivo()) return;
      if (e.status === 404) trocar(area, h("section", { class: "cartao vidro" }, h("p", { class: "nota", text: "Cole o motor 31.8 (ou mais novo) no Worker desta empresa e crie nele a variável MODO = guia para usar o guia de lojas." })));
      else falha(area, e);
    }
  }
  async function abaGuiaBuscas(area, vivo) {
    const f = estado.guiaF = estado.guiaF || { dias: 30 };
    const de = isoLocal(new Date(Date.now() - (f.dias - 1) * 86400000)), ate = isoLocal(new Date());
    const st = await eng(`guide/stats?de=${de}&ate=${ate}`, { fresco: true });
    if (!vivo()) return;
    const dias = [];
    for (let t = Date.parse(de + "T12:00:00Z"); t <= Date.parse(ate + "T12:00:00Z"); t += 86400000) dias.push(new Date(t).toISOString().slice(0, 10));
    const porDia = new Map((st.por_dia || []).map(x => [x.dia, Number(x.n || 0)]));
    const diario = dias.map(d => ({ data: d, buscas: porDia.get(d) || 0 }));
    const via = Object.fromEntries((st.por_via || []).map(x => [x.via, Number(x.n || 0)]));
    const total = st.total || 0, semLoja = (st.por_categoria || []).reduce((s, x) => s + Number(x.sem_loja || 0), 0);
    const pct = n => total ? `${Math.round((n / total) * 100)}%` : "—";
    const pontos = agruparSerie(diario, dias.length <= 92 ? "dia" : "semana", "buscas");
    const csv = () => baixarCsv(`guia-buscas-${de}-a-${ate}.csv`, [["Categoria", "Tipo", "Buscas", "Sem loja cadastrada"], ...(st.por_categoria || []).map(x => [x.categoria, x.tipo === "PRODUTO" ? "Produto" : "Serviço", x.n, x.sem_loja || 0])]);
    trocar(area,
      h("section", { class: "cartao vidro filtros-desempenho" }, h("div", { class: "abas abas-chips", role: "group", "aria-label": "Período" },
        [[1, "Hoje"], [7, "7 dias"], [30, "30 dias"], [90, "90 dias"], [180, "6 meses"], [365, "12 meses"]].map(([v, n]) => h("button", { type: "button", class: "aba" + (f.dias === v ? " ativo" : ""), "aria-pressed": f.dias === v ? "true" : "false", onclick: () => { f.dias = v; navegar(); } }, n)))),
      h("section", { class: "grade grade-4" },
        metrica("Buscas", numero(total), `${numero(Math.round((total / (dias.length || 1)) * 10) / 10)} por dia`),
        metrica("Clientes diferentes", numero(st.contatos || 0), "pessoas que usaram o guia"),
        metrica("Sem gastar IA", pct((via.BOTAO || 0) + (via.PALAVRA || 0)), `${numero((via.BOTAO || 0) + (via.PALAVRA || 0))} pelos botões ou por palavra`),
        metrica("Sem loja cadastrada", numero(semLoja), semLoja ? "procuraram algo que ainda não tem loja" : "toda busca encontrou loja")),
      h("section", { class: "cartao vidro" }, h("div", { class: "cabeca-grafico" }, h("h3", { style: "margin:0", text: "Buscas por dia" }), botao("Baixar planilha", csv, "btn-secundario btn-pequeno")),
        pontos.some(p => p.valor) ? graficoLinha(pontos, null, "Buscas", "") : vazio("Nenhuma busca neste período", "Quando os clientes usarem o guia no WhatsApp, os números aparecem aqui.")),
      h("section", { class: "grade grade-2" },
        h("div", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "O que mais procuram" }),
          (st.por_categoria || []).length ? barras(st.por_categoria.slice(0, 12).map(x => ({ rotulo: `${x.categoria}${x.tipo === "SERVICO" ? " (serviço)" : ""}`, valor: Number(x.n || 0) }))) : vazio("Sem buscas", "")),
        h("div", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "Como chegaram à loja" }),
          barras(["BOTAO", "PALAVRA", "IA"].map(k => ({ rotulo: NOME_VIA[k], valor: via[k] || 0 }))),
          h("p", { class: "sub", style: "margin:10px 0 0", text: "Só a última linha usa a IA (e o modelo mais barato). Para gastar ainda menos, coloque palavras-chave nas categorias (ex.: \"celular, smartphone, iphone\")." }))),
      h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "Horários com mais buscas" }), mapaHorarios(st.horarios || Array.from({ length: 7 }, () => Array(24).fill(0)))));
  }
  function abaGuiaLojas(area, g, recarregar) {
    const cats = (g.categorias || []).filter(c => !c.inativa);
    const nomeCat = new Map((g.categorias || []).map(c => [c.id, c.nome]));
    const lojas = g.lojas || [];
    const busca = h("input", { class: "entrada", type: "search", placeholder: "Buscar loja, local ou categoria", "aria-label": "Buscar loja" });
    const corpo = h("tbody", {});
    const desenhar = () => {
      const q = busca.value.trim().toLowerCase();
      const lista = lojas.filter(l => !q || [l.nome, l.local, ...(l.categorias || []).map(id => nomeCat.get(id))].join(" ").toLowerCase().includes(q));
      corpo.replaceChildren(...lista.map(l => h("tr", {},
        h("td", {}, h("strong", { text: l.nome }), l.destaque ? h("span", { text: " ★", title: "Destaque: aparece primeiro" }) : null, !l.ativo ? h("small", { style: "display:block;color:var(--texto-3)", text: "fora do guia" }) : null),
        h("td", { text: l.local || "—" }),
        h("td", { text: (d => d ? telefone(d.length <= 11 ? "55" + d : d) : "—")(String(l.whatsapp || l.telefone || "").replace(/\D/g, "")) }),
        h("td", { text: (l.categorias || []).map(id => nomeCat.get(id)).filter(Boolean).join(", ") || "—" }),
        h("td", {}, pode("AGENTE") ? h("div", { class: "acoes" }, botao("Editar", () => editarLoja(l, cats, recarregar), "btn-secundario btn-pequeno"),
          botao("Excluir", async () => { if (!(await modal({ titulo: "Excluir a loja?", conteudo: `"${l.nome}" sai do guia e da lista de lojas.`, confirmar: "Excluir", perigo: true }))) return; try { await eng(`guide/stores/${l.id}/delete`, { metodo: "POST", corpo: {} }); aviso("Loja excluída.", "ok"); recarregar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-secundario btn-pequeno")) : null))));
      if (!lista.length) corpo.appendChild(h("tr", {}, h("td", { colspan: "5", text: lojas.length ? "Nenhuma loja encontrada." : "Nenhuma loja ainda. Importe a planilha ou cadastre a primeira." })));
    };
    busca.addEventListener("input", desenhar);
    desenhar();
    trocar(area,
      h("section", { class: "grade grade-4" },
        metrica("Lojas no guia", numero(lojas.filter(l => l.ativo).length), `${numero(lojas.length)} cadastradas`),
        metrica("Categorias de produtos", numero(cats.filter(c => c.tipo === "PRODUTO").length), ""),
        metrica("Categorias de serviços", numero(cats.filter(c => c.tipo === "SERVICO").length), ""),
        metrica("Lojas sem categoria", numero(lojas.filter(l => !(l.categorias || []).length).length), "não aparecem no menu")),
      h("section", { class: "cartao vidro" },
        h("div", { class: "cabeca-grafico" }, h("h3", { style: "margin:0", text: "Lojas" }),
          pode("AGENTE") ? h("div", { class: "acoes" }, botao("Nova loja", () => editarLoja(null, cats, recarregar), "btn-primario btn-pequeno"), botao("Importar planilha", () => importarGuia(recarregar), "btn-secundario btn-pequeno"),
            botao("Baixar planilha", () => baixarCsv("guia-lojas.csv", [["loja", "telefone", "whatsapp", "local", "produtos", "servicos", "descricao"], ...lojas.map(l => [l.nome, l.telefone, l.whatsapp, l.local, ...["PRODUTO", "SERVICO"].map(t => (l.categorias || []).filter(id => (g.categorias.find(c => c.id === id) || {}).tipo === t).map(id => nomeCat.get(id)).join(", ")), l.descricao])]), "btn-secundario btn-pequeno")) : null),
        h("div", { style: "margin:12px 0" }, busca),
        h("div", { class: "tabela-caixa" }, h("table", {}, h("thead", {}, h("tr", {}, ["Loja", "Local", "WhatsApp", "Categorias", ""].map(t => h("th", { text: t })))), corpo))));
  }
  function editarLoja(l, cats, recarregar) {
    l = l || { nome: "", telefone: "", whatsapp: "", local: "", descricao: "", destaque: 0, ativo: 1, categorias: [] };
    const nome = h("input", { class: "entrada", value: l.nome, maxlength: "80" });
    const local = h("input", { class: "entrada", value: l.local || "", maxlength: "80", placeholder: "Ex.: Loja 12, 1º piso" });
    const zap = h("input", { class: "entrada", value: l.whatsapp || "", maxlength: "30", inputmode: "tel", placeholder: "(21) 98888-7777" });
    const tel = h("input", { class: "entrada", value: l.telefone || "", maxlength: "30", inputmode: "tel" });
    const desc = h("textarea", { class: "entrada", maxlength: "300", style: "min-height:80px", placeholder: "O que a loja oferece (aparece para o cliente)" }); desc.value = l.descricao || "";
    const destaque = h("input", { type: "checkbox", checked: Boolean(l.destaque) });
    const ativo = h("input", { type: "checkbox", checked: l.ativo !== 0 });
    const marcadas = new Set(l.categorias || []);
    const grupo = tipo => h("fieldset", { class: "guia-cats" }, h("legend", { text: tipo === "PRODUTO" ? "Produtos" : "Serviços" }),
      cats.filter(c => c.tipo === tipo).map(c => h("label", { class: "guia-cat" }, h("input", { type: "checkbox", checked: marcadas.has(c.id), onchange: e => { e.target.checked ? marcadas.add(c.id) : marcadas.delete(c.id); } }), c.nome)),
      cats.some(c => c.tipo === tipo) ? null : h("p", { class: "sub", text: "Nenhuma categoria. Crie em Categorias." }));
    const fechar = gaveta(l.id ? "Editar loja" : "Nova loja", [
      campo("Nome da loja", nome), campo("WhatsApp da loja", zap, "O cliente recebe o link para chamar a loja direto."), campo("Telefone fixo (opcional)", tel), campo("Local", local), campo("Descrição", desc),
      h("label", { class: "guia-cat" }, destaque, "Destaque (aparece primeiro na lista)"), h("label", { class: "guia-cat" }, ativo, "Aparece no guia"),
      grupo("PRODUTO"), grupo("SERVICO"),
      h("div", { class: "acoes" }, botao("Salvar", async () => {
        try { await eng("guide/stores", { metodo: "POST", corpo: { id: l.id, nome: nome.value, local: local.value, whatsapp: zap.value, telefone: tel.value, descricao: desc.value, destaque: destaque.checked, ativo: ativo.checked, categorias: [...marcadas] } }); aviso("Loja salva.", "ok"); fechar(); recarregar(); }
        catch (e) { aviso(e.message, "erro"); }
      }, "btn-primario"))]);
  }
  function importarGuia(recarregar) {
    const entrada = h("input", { type: "file", accept: ".csv,text/csv,text/plain" });
    const previa = h("div", {});
    const fechar = gaveta("Importar planilha de lojas", [
      h("p", { text: "Uma linha por loja. Colunas: loja, telefone, whatsapp, local, produtos, servicos, descricao. Em produtos e servicos, separe as categorias por vírgula (ex.: \"Celulares, Capinhas\"). No Excel ou no Google Planilhas: Arquivo → Baixar → CSV." }),
      h("p", { class: "sub", text: "Lojas com o mesmo nome são atualizadas (nada é apagado). Categorias novas são criadas sozinhas." }),
      botao("Baixar modelo", () => baixarCsv("modelo-guia-lojas.csv", [["loja", "telefone", "whatsapp", "local", "produtos", "servicos", "descricao"], ["Cell Center", "(21) 3333-1111", "(21) 98888-7777", "Loja 12, 1º piso", "Celulares, Capinhas", "Conserto de celular", "Celulares novos e seminovos"]]), "btn-secundario btn-pequeno"),
      h("label", { class: "soltar", style: "margin-top:12px" }, icone(ICONES.nuvem), h("strong", { text: "Escolha a planilha (CSV)" }), entrada), previa]);
    entrada.addEventListener("change", async () => {
      const arquivo = entrada.files[0];
      if (!arquivo) return;
      let texto = await arquivo.text();
      if (texto.includes("�")) { try { texto = new TextDecoder("windows-1252").decode(await arquivo.arrayBuffer()); } catch { /* mantém */ } }
      const linhas = lerCsv(texto);
      const sem = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
      const cab = (linhas[0] || []).map(sem);
      const col = (...nomes) => cab.findIndex(c => nomes.some(n => c === n || c.startsWith(n)));
      const ix = { loja: col("loja", "nome", "empresa"), telefone: col("telefone", "fone", "fixo"), whatsapp: col("whatsapp", "whats", "celular", "zap"), local: col("local", "piso", "endereco", "localizacao"), produtos: col("produto"), servicos: col("servico"), descricao: col("descricao", "observ", "sobre") };
      if (ix.loja < 0) { trocar(previa, h("p", { class: "nota nota-alerta", text: "Não encontrei a coluna \"loja\" (ou \"nome\") na primeira linha." })); return; }
      const dados = linhas.slice(1).map(l => Object.fromEntries(Object.entries(ix).map(([k, i]) => [k, i >= 0 ? String(l[i] || "").trim() : ""]))).filter(l => l.loja);
      trocar(previa, h("p", { text: `${numero(dados.length)} loja(s) encontradas. Primeiras: ${dados.slice(0, 4).map(d => d.loja).join(", ")}${dados.length > 4 ? "…" : ""}` }),
        botao(`Importar ${numero(dados.length)} loja(s)`, async () => {
          let lojas = 0, novas = 0;
          try {
            for (let i = 0; i < dados.length; i += 300) { const r = await eng("guide/import", { metodo: "POST", corpo: { linhas: dados.slice(i, i + 300) } }); lojas += r.lojas || 0; novas += r.categorias_novas || 0; }
            aviso(`${numero(lojas)} loja(s) importada(s), ${numero(novas)} categoria(s) nova(s).`, "ok"); fechar(); recarregar();
          } catch (e) { aviso(`Parou com ${numero(lojas)} loja(s): ${e.message}`, "erro"); }
        }, "btn-primario"));
    });
  }
  function abaGuiaCategorias(area, g, recarregar) {
    const cats = g.categorias || [];
    const editar = c => {
      c = c || { tipo: "PRODUTO", nome: "", palavras: "", ordem: 0 };
      const tipo = h("select", { class: "entrada" }, h("option", { value: "PRODUTO", selected: c.tipo === "PRODUTO", text: "Produto" }), h("option", { value: "SERVICO", selected: c.tipo === "SERVICO", text: "Serviço" }));
      const nome = h("input", { class: "entrada", value: c.nome, maxlength: "24" });
      const palavras = h("textarea", { class: "entrada", maxlength: "400", style: "min-height:80px", placeholder: "celular, smartphone, iphone, samsung, xiaomi" }); palavras.value = c.palavras || "";
      const ordem = h("input", { class: "entrada", type: "number", value: String(c.ordem || 0), min: "0", max: "999" });
      const ativa = h("input", { type: "checkbox", checked: !c.inativa });
      const fechar = gaveta(c.id ? "Editar categoria" : "Nova categoria", [
        campo("Tipo", tipo), campo("Nome (aparece no botão — até 24 letras)", nome), campo("Palavras-chave", palavras, "Quando o cliente escreve em vez de tocar no botão, a DENIA procura por estas palavras primeiro — sem gastar IA."), campo("Ordem no menu (menor aparece primeiro)", ordem),
        c.id ? h("label", { class: "guia-cat" }, ativa, "Aparece no menu") : null,
        h("div", { class: "acoes" }, botao("Salvar", async () => {
          try { await eng("guide/categories", { metodo: "POST", corpo: { id: c.id, tipo: tipo.value, nome: nome.value, palavras: palavras.value, ordem: Number(ordem.value) || 0, ativo: ativa.checked } }); aviso("Categoria salva.", "ok"); fechar(); recarregar(); }
          catch (e) { aviso(e.message, "erro"); }
        }, "btn-primario"))]);
    };
    const tabela = tipo => {
      const lista = cats.filter(c => c.tipo === tipo);
      return h("div", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: tipo === "PRODUTO" ? "🛍️ Produtos" : "🔧 Serviços" }),
        lista.length ? h("div", { class: "tabela-caixa" }, h("table", {}, h("thead", {}, h("tr", {}, ["Categoria", "Lojas", ""].map(t => h("th", { text: t })))),
          h("tbody", {}, lista.map(c => h("tr", {}, h("td", {}, h("strong", { text: c.nome }), c.inativa ? h("small", { style: "display:block;color:var(--texto-3)", text: "fora do menu" }) : null, c.palavras ? h("small", { style: "display:block;color:var(--texto-3)", text: c.palavras.slice(0, 80) }) : null),
            h("td", { text: c.inativa ? "—" : numero(c.lojas || 0) }),
            h("td", {}, pode("AGENTE") ? h("div", { class: "acoes" }, botao("Editar", () => editar(c), "btn-secundario btn-pequeno"),
              botao("Excluir", async () => { if (!(await modal({ titulo: "Excluir a categoria?", conteudo: `"${c.nome}" sai do menu. As lojas continuam cadastradas.`, confirmar: "Excluir", perigo: true }))) return; try { await eng(`guide/categories/${c.id}/delete`, { metodo: "POST", corpo: {} }); recarregar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-secundario btn-pequeno")) : null)))))) : vazio("Nenhuma categoria", ""));
    };
    trocar(area,
      h("p", { class: "nota", text: "O menu mostra 9 categorias por vez e um \"Mais opções\" para as seguintes. Categorias sem nenhuma loja não aparecem para o cliente." }),
      pode("AGENTE") ? h("div", { class: "acoes" }, botao("Nova categoria", () => editar(null), "btn-primario btn-pequeno")) : null,
      h("section", { class: "grade grade-2" }, tabela("PRODUTO"), tabela("SERVICO")));
  }
  function abaGuiaMensagens(area, cfg) {
    const campos = [["nome", "Nome do shopping", "Aparece nos avisos do Telegram.", 1], ["boas_vindas", "Boas-vindas (com os botões Produtos, Serviços e Falar com alguém)", "", 3], ["rodape_lojas", "Depois da lista de lojas", "", 2], ["humano", "Quando pedem para falar com alguém", "A DENIA fica em pausa nessa conversa e a equipe é avisada no Telegram.", 2], ["encerramento", "Ao finalizar", "", 2], ["rede_nome", "Rede social (nome)", "Ex.: Instagram", 1], ["rede_url", "Rede social (link)", "Aparece na mensagem de encerramento.", 1]];
    const ent = {};
    const modelo = h("select", { class: "entrada" }, [["", "Padrão do motor"], ["gpt-5-nano", "gpt-5-nano — o mais barato (recomendado)"], ["gpt-5-mini", "gpt-5-mini — econômico"], ["gpt-4o-mini", "gpt-4o-mini — econômico"]].map(([v, n]) => h("option", { value: v, selected: (cfg.modelo_ia || "") === v, text: n })));
    trocar(area, h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "Mensagens do guia" }),
      campos.map(([k, rot, dica, linhas]) => { ent[k] = linhas > 1 ? h("textarea", { class: "entrada", maxlength: "900", style: `min-height:${linhas * 34}px` }) : h("input", { class: "entrada", maxlength: "300" }); ent[k].value = cfg[k] || ""; return campo(rot, ent[k], dica); }),
      campo("IA para perguntas escritas", modelo, "Os botões nunca usam IA. Este modelo só entra quando a pessoa escreve algo que a busca por palavra não achou."),
      pode("AGENTE") ? h("div", { class: "acoes" }, botao("Salvar mensagens", async () => {
        try { await eng("guide/config", { metodo: "POST", corpo: { ...Object.fromEntries(Object.entries(ent).map(([k, e]) => [k, e.value])), modelo_ia: modelo.value } }); aviso("Mensagens salvas.", "ok"); }
        catch (e) { aviso(e.message, "erro"); }
      }, "btn-primario"), h("a", { class: "btn btn-secundario", href: "#/guia/testar" }, "Testar como cliente")) : null));
  }
  function abaGuiaTestar(area) {
    const tela = h("div", { class: "mensagens guia-tela", "aria-live": "polite" });
    const entrada = h("input", { class: "entrada", placeholder: "Escreva como um cliente (ex.: onde conserto meu celular?)", maxlength: "500" });
    const balao = (texto, minha) => h("div", { class: "msg " + (minha ? "msg-entrada" : "msg-saida") }, texto);
    const enviar = async (texto, acao, rotulo) => {
      tela.appendChild(balao(rotulo || texto, true));
      try {
        const r = await eng("guide/test", { metodo: "POST", corpo: { texto, acao } });
        for (const x of r.respostas || []) {
          const it = x.interativo;
          if (!it) { tela.appendChild(balao(x.texto, false)); continue; }
          const caixa = balao((it.body || {}).text || "", false);
          const opcoes = it.type === "button" ? it.action.buttons.map(b => ({ id: b.reply.id, title: b.reply.title })) : ((it.action.sections || [])[0] || {}).rows || [];
          caixa.appendChild(h("div", { class: "guia-botoes" }, opcoes.map(o => h("button", { type: "button", class: "btn btn-secundario btn-pequeno", title: o.description || "", onclick: () => enviar(o.title, o.id, o.title) }, o.title))));
          tela.appendChild(caixa);
        }
        if (!(r.respostas || []).length) tela.appendChild(h("p", { class: "sub", text: "(sem resposta: a conversa de teste pode estar em pausa)" }));
      } catch (e) { aviso(e.message, "erro"); }
      tela.scrollTop = tela.scrollHeight;
    };
    const mandar = () => { const t = entrada.value.trim(); if (!t) return; entrada.value = ""; enviar(t, ""); };
    entrada.addEventListener("keydown", e => { if (e.key === "Enter") mandar(); });
    trocar(area, h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "Testar como cliente" }),
      h("p", { class: "sub", text: "Simula a conversa: nada é enviado pelo WhatsApp e nada entra nas buscas. Toque nos botões como o cliente faria." }),
      h("div", { class: "acoes", style: "margin:8px 0" }, botao("Começar (oi)", () => enviar("oi", "", "oi"), "btn-primario btn-pequeno"), botao("Limpar", () => tela.replaceChildren(), "btn-secundario btn-pequeno")),
      tela, h("div", { class: "compor" }, entrada, botao("Enviar", mandar, "btn-primario"))));
  }

  // ----- Chatbot do WhatsApp da plataforma (qualquer empresa, sem código): menu por botões e listas,
  // contatos/lojas, mensagens, conversas com a equipe, métricas, conexão e teste.
  const zap = (caminho, op) => org("zap/" + caminho, op);
  const TIPOS_ITEM = { MENU: "Submenu (abre outras opções)", RESPOSTA: "Resposta pronta (texto, link, endereço)", LISTA: "Lista de contatos/lojas", HUMANO: "Falar com a equipe" };
  const ICONE_TIPO = { MENU: "📂", RESPOSTA: "💬", LISTA: "📋", HUMANO: "🙋" };
  const NOME_VIA_ZAP = { BOTAO: "Tocou nos botões", PALAVRA: "Escreveu (achado sem IA)", IA: "Escreveu (resolvido pela IA)" };
  async function paginaChatbot(el, aba, vivo) {
    el.appendChild(cabeca("Chatbot do WhatsApp", "Monte o atendimento automático da empresa sem programar: botões e listas oficiais do WhatsApp (sem custo de IA) e, se quiser, a IA para responder o que o cliente escrever."));
    const abas = [["visao", "Visão geral"], ["conversas", "Conversas"], ["menu", "Menu"], ["contatos", "Contatos e lojas"], ["mensagens", "Mensagens e IA"], ["conexao", "Conexão"], ["testar", "Testar"]];
    const atual = abas.some(a => a[0] === aba) ? aba : "visao";
    el.appendChild(h("div", { class: "abas", role: "tablist" }, abas.map(([k, n]) => h("a", { class: "aba" + (k === atual ? " ativo" : ""), href: "#/chatbot/" + k, role: "tab" }, n))));
    const area = h("div", { class: "grade" }, carregando());
    el.appendChild(area);
    try {
      if (atual === "visao") return await abaZapVisao(area, vivo);
      if (atual === "conversas") return await abaZapConversas(area, vivo);
      if (atual === "menu") return await abaZapMenu(area, vivo);
      if (atual === "contatos") return await abaZapContatos(area, vivo);
      if (atual === "mensagens") return await abaZapMensagens(area, vivo);
      if (atual === "conexao") return await abaZapConexao(area, vivo);
      if (atual === "testar") return abaZapTestar(area);
    } catch (e) { if (vivo()) falha(area, e); }
  }
  async function abaZapVisao(area, vivo) {
    const f = estado.zapF = estado.zapF || { dias: 30, metrica: "buscas" };
    const de = isoLocal(new Date(Date.now() - (f.dias - 1) * 86400000)), ate = isoLocal(new Date());
    const [st, conta, itens] = await Promise.all([zap(`stats?de=${de}&ate=${ate}`), zap("conta"), zap("itens")]);
    if (!vivo()) return;
    const passos = [];
    if (!conta.conectada) passos.push(["Conectar o número do WhatsApp", "Cole o ID do número e o token da Meta. Leva 5 minutos.", "#/chatbot/conexao"]);
    if (!(itens.itens || []).length) passos.push(["Montar o menu", "Use um modelo pronto (shopping, serviços, restaurante) e ajuste.", "#/chatbot/menu"]);
    if (conta.conectada && !conta.ultima_recebida_ms) passos.push(["Apontar o webhook na Meta", "Cole o endereço e o token de verificação no app da Meta.", "#/chatbot/conexao"]);
    const dias = [];
    for (let t = Date.parse(de + "T12:00:00Z"); t <= Date.parse(ate + "T12:00:00Z"); t += 86400000) dias.push(new Date(t).toISOString().slice(0, 10));
    const mapa = l => new Map((l || []).map(x => [x.dia, Number(x.n || 0)]));
    const mb = mapa(st.buscas_por_dia), mm = mapa(st.mensagens_por_dia);
    const diario = dias.map(d => ({ data: d, buscas: mb.get(d) || 0, mensagens: mm.get(d) || 0 }));
    const via = Object.fromEntries((st.por_via || []).map(x => [x.via, Number(x.n || 0)]));
    const tot = st.total_buscas || 0, ms = st.mensagens || {}, en = st.entregas || {};
    const semLoja = (st.por_opcao || []).reduce((s, x) => s + Number(x.sem || 0), 0);
    const pontos = agruparSerie(diario, dias.length <= 92 ? "dia" : "semana", f.metrica);
    const nomeM = f.metrica === "buscas" ? "Buscas no menu" : "Mensagens recebidas";
    const csv = () => baixarCsv(`chatbot-${de}-a-${ate}.csv`, [["Dia", "Buscas", "Mensagens recebidas"], ...diario.map(d => [dataCompleta(d.data), d.buscas, d.mensagens]), [], ["Opção", "Buscas", "Sem contato cadastrado"], ...(st.por_opcao || []).map(x => [x.caminho, x.n, x.sem || 0])]);
    trocar(area,
      passos.length ? h("section", { class: "grade grade-3" }, passos.map(([t, d, l], i) => passoInicial(String(i + 1).padStart(2, "0"), t, d, l))) : null,
      h("section", { class: "cartao vidro filtros-desempenho" }, h("div", { class: "abas abas-chips", role: "group", "aria-label": "Período" },
        [[1, "Hoje"], [7, "7 dias"], [30, "30 dias"], [90, "90 dias"], [180, "6 meses"], [365, "12 meses"]].map(([v, n]) => h("button", { type: "button", class: "aba" + (f.dias === v ? " ativo" : ""), "aria-pressed": f.dias === v ? "true" : "false", onclick: () => { f.dias = v; navegar(); } }, n)))),
      h("section", { class: "grade grade-4" },
        h("button", { type: "button", class: "metrica vidro metrica-botao" + (f.metrica === "mensagens" ? " ativo" : ""), onclick: () => { f.metrica = "mensagens"; navegar(); } }, h("span", { text: "Mensagens recebidas" }), h("strong", { text: numero(ms.recebidas || 0) }), h("small", { text: `${numero(st.contatos || 0)} clientes diferentes` })),
        h("button", { type: "button", class: "metrica vidro metrica-botao" + (f.metrica === "buscas" ? " ativo" : ""), onclick: () => { f.metrica = "buscas"; navegar(); } }, h("span", { text: "Buscas no menu" }), h("strong", { text: numero(tot) }), h("small", { text: `${numero(Math.round((tot / (dias.length || 1)) * 10) / 10)} por dia` })),
        metrica("Sem gastar IA", tot ? `${Math.round((((via.BOTAO || 0) + (via.PALAVRA || 0)) / tot) * 100)}%` : "—", `${numero(ms.robo || 0)} respostas do robô · ${numero(ms.ia || 0)} da IA`),
        metrica("Taxa de entrega", en.taxa != null ? String(en.taxa).replace(".", ",") + "%" : "—", `${numero(en.lidas || 0)} lidas · ${numero(en.falhas || 0)} não chegaram`)),
      h("section", { class: "cartao vidro" }, h("div", { class: "cabeca-grafico" }, h("h3", { style: "margin:0", text: nomeM + " por dia" }), botao("Baixar planilha", csv, "btn-secundario btn-pequeno")),
        pontos.some(p => p.valor) ? graficoLinha(pontos, null, nomeM, "") : vazio("Nada neste período", "Quando os clientes usarem o WhatsApp, os números aparecem aqui.")),
      h("section", { class: "grade grade-2" },
        h("div", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "O que mais procuram" }), (st.por_opcao || []).length ? barras(st.por_opcao.slice(0, 12).map(x => ({ rotulo: x.caminho, valor: Number(x.n || 0) }))) : vazio("Sem buscas", ""),
          semLoja ? h("p", { class: "nota nota-alerta", text: `${numero(semLoja)} busca(s) caíram em opções sem contato cadastrado. Cadastre em Contatos e lojas.` }) : null),
        h("div", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "Como o cliente chegou à resposta" }), barras(["BOTAO", "PALAVRA", "IA"].map(k => ({ rotulo: NOME_VIA_ZAP[k], valor: via[k] || 0 }))),
          h("p", { class: "sub", style: "margin:10px 0 0", text: "Só a última linha gasta IA. Palavras-chave nas opções do menu fazem o robô achar sem IA." }),
          h("h3", { text: "Quem respondeu" }), barras([{ rotulo: "Robô (botões)", valor: ms.robo || 0 }, { rotulo: "IA", valor: ms.ia || 0 }, { rotulo: "Equipe", valor: ms.equipe || 0 }]))),
      h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "Horários com mais mensagens" }), mapaHorarios(st.horarios || Array.from({ length: 7 }, () => Array(24).fill(0)))));
  }
  async function abaZapConversas(area, vivo) {
    const r = await zap("conversas");
    if (!vivo()) return;
    const lista = r.conversas || [];
    const grade = h("div", { class: "conversas" + (estado.zapAberta ? " com-aberta" : ""), style: "height:calc(100vh - 230px)" });
    const itens = h("div", { class: "conversas-itens" });
    const painel = h("section", { class: "conversa-painel vidro" }, vazio("Escolha uma conversa", "As mensagens do WhatsApp aparecem aqui.", ICONES.conversa));
    const busca = h("input", { class: "entrada", type: "search", placeholder: "Buscar por nome ou telefone", "aria-label": "Buscar conversa" });
    const desenhar = () => {
      const q = busca.value.trim().toLowerCase().replace(/[()\s-]/g, "");
      const f = lista.filter(c => !q || String(c.nome || "").toLowerCase().includes(q) || String(c.telefone).includes(q));
      itens.replaceChildren(...(f.length ? f.map(c => h("button", { type: "button", class: "conversa-item" + (c.telefone === estado.zapAberta ? " ativo" : ""), onclick: () => abrir(c.telefone) },
        h("strong", {}, c.nome || telefone(c.telefone), c.pausado ? selo("Com a equipe", "alerta") : null), h("span", { text: c.ultima || "" }), h("span", { text: quando(c.ultimo_ms) }))) : [vazio("Nenhuma conversa", q ? "Nada encontrado." : "Quando um cliente escrever, a conversa aparece aqui.", ICONES.conversa)]));
    };
    busca.addEventListener("input", desenhar);
    async function abrir(tel) {
      estado.zapAberta = tel; grade.classList.add("com-aberta"); desenhar();
      trocar(painel, carregando());
      let d;
      try { d = await zap("conversas/" + tel); } catch (e) { falha(painel, e); return; }
      const c = d.contato;
      const msgs = h("div", { class: "mensagens" }, (d.mensagens || []).map(m => h("div", { class: "msg " + (m.direcao === "E" ? "msg-entrada" : "msg-saida") + (m.origem === "EQUIPE" ? " msg-humano" : "") + (m.status === "FALHOU" || m.status === "FAILED" ? " msg-falhou" : "") },
        m.texto, h("small", { text: `${m.direcao === "E" ? "" : ({ ROBO: "Robô", IA: "IA", EQUIPE: "Equipe" }[m.origem] || "") + " · "}${quando(m.criado_ms)}${m.direcao === "S" ? " " + ({ READ: "✓✓ lida", DELIVERED: "✓✓", ENVIADA: "✓", SENT: "✓", FALHOU: "⚠", FAILED: "⚠" }[m.status] || "") : ""}` }),
        m.erro ? h("span", { class: "msg-falha", text: m.erro }) : null)));
      const texto = h("textarea", { class: "entrada", placeholder: c.janela_aberta ? "Escreva a resposta… (o robô fica em pausa nesta conversa por 12 h)" : "Passaram 24 h desde a última mensagem do cliente: a Meta só deixa responder quando ele escrever de novo.", disabled: !c.janela_aberta || !pode("AGENTE"), "aria-label": "Mensagem" });
      trocar(painel,
        h("div", { class: "conversa-cabeca" }, h("button", { type: "button", class: "btn btn-secundario btn-pequeno so-celular", onclick: () => { estado.zapAberta = ""; grade.classList.remove("com-aberta"); } }, "‹ Voltar"),
          h("h3", { text: c.nome || telefone(c.telefone) }), h("span", { class: "sub", text: telefone(c.telefone) }),
          h("div", { class: "acoes" }, pode("AGENTE") ? botao(c.pausado ? "Devolver ao robô" : "Assumir (pausar o robô)", async () => { try { await zap(`conversas/${tel}/robo`, { metodo: "POST", corpo: { ligar: c.pausado } }); aviso(c.pausado ? "O robô voltou a atender esta conversa." : "Robô em pausa nesta conversa.", "ok"); abrir(tel); } catch (e) { aviso(e.message, "erro"); } }, c.pausado ? "btn-primario btn-pequeno" : "btn-secundario btn-pequeno") : null)),
        msgs,
        h("div", { class: "compor" }, texto, botao("Enviar", async () => {
          const t = texto.value.trim(); if (!t) return;
          try { await zap(`conversas/${tel}/enviar`, { metodo: "POST", corpo: { texto: t } }); texto.value = ""; abrir(tel); } catch (e) { aviso(e.message, "erro"); }
        }, "btn-primario", { disabled: !c.janela_aberta || !pode("AGENTE") })));
      msgs.scrollTop = msgs.scrollHeight;
    }
    desenhar();
    trocar(area, h("div", { class: "acoes" }, botao("Atualizar", () => navegar(), "btn-secundario btn-pequeno")), grade);
    grade.append(h("section", { class: "conversas-lista vidro" }, h("div", { class: "conversas-busca" }, busca), itens), painel);
    if (estado.zapAberta && lista.some(c => c.telefone === estado.zapAberta)) abrir(estado.zapAberta);
  }
  function editarItem(item, itens, recarregar) {
    item = item || { tipo: "RESPOSTA", titulo: "", texto: "", descricao: "", palavras: "", ordem: 0, pai_id: 0, ativo: 1 };
    const tipo = h("select", { class: "entrada" }, Object.entries(TIPOS_ITEM).map(([v, n]) => h("option", { value: v, selected: item.tipo === v, text: n })));
    const titulo = h("input", { class: "entrada", value: item.titulo, maxlength: "24", placeholder: "Ex.: 🛍️ Produtos" });
    const menus = itens.filter(i => i.tipo === "MENU" && i.id !== item.id);
    const pai = h("select", { class: "entrada" }, h("option", { value: "0", text: "Menu inicial" }), menus.map(m => h("option", { value: m.id, selected: Number(item.pai_id) === m.id, text: "Dentro de: " + m.titulo })));
    const texto = h("textarea", { class: "entrada", maxlength: "3000", style: "min-height:120px" }); texto.value = item.texto || "";
    const descricao = h("input", { class: "entrada", value: item.descricao || "", maxlength: "72", placeholder: "Aparece embaixo do nome, na lista (opcional)" });
    const palavras = h("textarea", { class: "entrada", maxlength: "500", style: "min-height:70px", placeholder: "celular, smartphone, iphone" }); palavras.value = item.palavras || "";
    const ordem = h("input", { class: "entrada", type: "number", min: "0", max: "999", value: String(item.ordem || 0) });
    const ativo = h("input", { type: "checkbox", checked: item.ativo !== 0 });
    const exibicao = h("select", { class: "entrada" }, [["AUTO", "Automático: até 3 = botões; até 10 = lista; mais = lista com \"Mais opções\""], ["NUMERADO", "Texto numerado: todas as opções numa mensagem só, sem limite (o cliente responde o número)"]].map(([v, n]) => h("option", { value: v, selected: (item.exibicao || "AUTO") === v, text: n })));
    const campoExibicao = campo("Como mostrar as opções deste submenu", exibicao, "O WhatsApp permite no máximo 3 botões ou 10 itens por lista. Com mais opções, use a lista automática (com \"Mais opções\") ou o texto numerado, que não tem limite.");
    const rotTexto = h("label", {}), dicaTexto = h("p", { class: "dica", style: "margin:0;font-size:13px;color:var(--texto-3)" });
    const ajustar = () => {
      const t = tipo.value;
      campoExibicao.classList.toggle("oculto", t !== "MENU");
      rotTexto.textContent = { MENU: "Mensagem ao abrir o submenu", RESPOSTA: "Resposta que o cliente recebe", LISTA: "Texto antes da lista (opcional)", HUMANO: "Mensagem ao chamar a equipe (opcional)" }[t];
      dicaTexto.textContent = { MENU: "Ex.: Qual produto você procura?", RESPOSTA: "Endereço, horário, link do cardápio, preços autorizados… O robô envia exatamente este texto.", LISTA: "Os contatos ligados a esta opção (em Contatos e lojas) aparecem com o link do WhatsApp de cada um.", HUMANO: "O robô fica em pausa nessa conversa por 12 h e a equipe é avisada (Telegram ou e-mail)." }[t];
    };
    tipo.addEventListener("change", ajustar); ajustar();
    texto.id = "zap-txt"; rotTexto.setAttribute("for", "zap-txt");
    const fechar = gaveta(item.id ? "Editar opção" : "Nova opção do menu", [
      campo("Tipo", tipo), campo("Nome no botão (até 24 letras)", titulo, "Pode usar emoji. Em botões, o WhatsApp mostra até 20 letras."), campo("Onde fica", pai),
      h("div", { class: "campo" }, rotTexto, texto, dicaTexto),
      campoExibicao, campo("Descrição na lista", descricao), campo("Palavras-chave", palavras, "Se o cliente escrever em vez de tocar, o robô procura por estas palavras primeiro — sem gastar IA."),
      campo("Ordem (menor aparece primeiro)", ordem), h("label", { class: "guia-cat" }, ativo, "Aparece no menu"),
      h("div", { class: "acoes" }, botao("Salvar", async () => {
        try { await zap("itens", { metodo: "POST", corpo: { id: item.id, tipo: tipo.value, titulo: titulo.value, pai_id: Number(pai.value), texto: texto.value, descricao: descricao.value, palavras: palavras.value, ordem: Number(ordem.value) || 0, ativo: ativo.checked, exibicao: exibicao.value } }); aviso("Opção salva.", "ok"); fechar(); recarregar(); }
        catch (e) { aviso(e.message, "erro"); }
      }, "btn-primario"))]);
  }
  async function abaZapMenu(area, vivo) {
    const d = await zap("itens");
    if (!vivo()) return;
    const itens = d.itens || [], cat = d.catalogo || [];
    const porItem = new Map(); for (const c of cat) for (const i of c.itens || []) porItem.set(i, (porItem.get(i) || 0) + 1);
    const recarregar = () => navegar();
    if (!itens.length) {
      const modelo = (tipo, nome, desc) => h("div", { class: "cartao vidro", style: "display:grid;gap:10px" }, h("h3", { style: "margin:0", text: nome }), h("p", { class: "sub", style: "margin:0", text: desc }),
        pode("AGENTE") ? botao("Usar este modelo", async () => { try { await zap("modelo", { metodo: "POST", corpo: { tipo } }); aviso("Menu criado. Agora ajuste do seu jeito.", "ok"); recarregar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-primario btn-pequeno") : null);
      trocar(area, h("p", { class: "nota", text: "Comece por um modelo pronto (você muda tudo depois) ou crie as opções do zero." }),
        h("section", { class: "grade grade-3" }, modelo("shopping", "🛍️ Shopping / guia de lojas", "Produtos e Serviços → categorias → lojas com o WhatsApp de cada uma. Ideal para importar a planilha de lojas."),
          modelo("servicos", "🔧 Empresa de serviços", "Nossos serviços, endereço e horário, falar com atendente."), modelo("restaurante", "🍽️ Restaurante / delivery", "Cardápio, delivery, endereço e horário, falar com atendente.")),
        pode("AGENTE") ? h("div", { class: "acoes" }, botao("Criar do zero", () => editarItem(null, itens, recarregar), "btn-secundario")) : null);
      return;
    }
    const linha = (i, nivel) => h("div", { class: "zap-no", style: `margin-left:${nivel * 22}px` },
      h("span", { class: "zap-no-titulo" }, /^\p{Extended_Pictographic}/u.test(i.titulo) ? null : h("span", { text: ICONE_TIPO[i.tipo] + " " }), h("strong", { text: i.titulo }), !i.ativo ? h("small", { text: " (desligada)" }) : null,
        i.tipo === "MENU" && i.exibicao === "NUMERADO" ? h("small", { class: "sub", text: " · texto numerado" }) : null,
        h("small", { class: "sub", text: " · " + (i.tipo === "LISTA" ? `${numero(porItem.get(i.id) || 0)} contato(s)${porItem.get(i.id) ? "" : " — não aparece até ter contato"}` : i.tipo === "MENU" ? `${numero(itens.filter(x => x.pai_id === i.id).length)} opção(ões)` : TIPOS_ITEM[i.tipo].split(" (")[0]) })),
      pode("AGENTE") ? h("span", { class: "acoes" },
        i.tipo === "MENU" ? botao("+ Opção aqui", () => editarItem({ tipo: "LISTA", titulo: "", pai_id: i.id, ativo: 1 }, itens, recarregar), "btn-secundario btn-pequeno") : null,
        botao("Editar", () => editarItem(i, itens, recarregar), "btn-secundario btn-pequeno"),
        botao("Excluir", async () => { if (!(await modal({ titulo: "Excluir a opção?", conteudo: `"${i.titulo}" sai do menu.`, confirmar: "Excluir", perigo: true }))) return; try { await zap(`itens/${i.id}/excluir`, { metodo: "POST", corpo: {} }); recarregar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-secundario btn-pequeno")) : null);
    const arvore = [];
    const descer = (pai, nivel) => itens.filter(i => Number(i.pai_id) === pai).forEach(i => { arvore.push(linha(i, nivel)); if (i.tipo === "MENU" && nivel < 6) descer(i.id, nivel + 1); });
    descer(0, 0);
    const raiz = itens.filter(i => !i.pai_id && i.ativo).length;
    trocar(area,
      h("section", { class: "cartao vidro" }, h("div", { class: "cabeca-grafico" }, h("h3", { style: "margin:0", text: "Menu do WhatsApp" }),
        pode("AGENTE") ? h("div", { class: "acoes" }, botao("+ Nova opção", () => editarItem(null, itens, recarregar), "btn-primario btn-pequeno"), h("a", { class: "btn btn-secundario btn-pequeno", href: "#/chatbot/testar" }, "Testar")) : null),
        h("p", { class: "sub", text: `Com até 3 opções o cliente vê botões; com mais, uma lista (9 por vez + "Mais opções"). O menu inicial tem ${raiz} opção(ões): ${raiz <= 3 ? "aparece em botões" : "aparece em lista"}. Depois de cada resposta o robô oferece Menu inicial, Voltar e Finalizar.` }),
        h("div", { class: "zap-arvore" }, arvore)));
  }
  async function abaZapContatos(area, vivo) {
    const d = await zap("itens");
    if (!vivo()) return;
    const itens = d.itens || [], cat = d.catalogo || [];
    const listas = itens.filter(i => i.tipo === "LISTA");
    const nomeItem = new Map(itens.map(i => [i.id, i.titulo]));
    const caminho = i => { const p = []; let x = i, n = 0; while (x && n++ < 6) { p.unshift(x.titulo); x = itens.find(y => y.id === x.pai_id); } return p.join(" › "); };
    const recarregar = () => navegar();
    const editar = c => {
      c = c || { nome: "", telefone: "", whatsapp: "", local: "", descricao: "", destaque: 0, ativo: 1, itens: [] };
      const nome = h("input", { class: "entrada", value: c.nome, maxlength: "80" }), zapI = h("input", { class: "entrada", value: c.whatsapp || "", maxlength: "30", inputmode: "tel", placeholder: "(21) 98888-7777" });
      const tel = h("input", { class: "entrada", value: c.telefone || "", maxlength: "30", inputmode: "tel" }), local = h("input", { class: "entrada", value: c.local || "", maxlength: "80", placeholder: "Ex.: Loja 12, 1º piso" });
      const desc = h("textarea", { class: "entrada", maxlength: "300", style: "min-height:70px" }); desc.value = c.descricao || "";
      const destaque = h("input", { type: "checkbox", checked: Boolean(c.destaque) }), ativo = h("input", { type: "checkbox", checked: c.ativo !== 0 });
      const marcadas = new Set(c.itens || []);
      const grupos = new Map(); for (const l of listas) { const k = nomeItem.get(l.pai_id) || "Menu inicial"; if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(l); }
      const fechar = gaveta(c.id ? "Editar contato" : "Novo contato", [
        campo("Nome", nome), campo("WhatsApp", zapI, "O cliente recebe o link para chamar direto."), campo("Telefone fixo (opcional)", tel), campo("Local / endereço", local), campo("Descrição", desc),
        h("label", { class: "guia-cat" }, destaque, "Destaque (aparece primeiro)"), h("label", { class: "guia-cat" }, ativo, "Aparece para os clientes"),
        listas.length ? [...grupos].map(([g, ls]) => h("fieldset", { class: "guia-cats" }, h("legend", { text: g }), ls.map(l => h("label", { class: "guia-cat" }, h("input", { type: "checkbox", checked: marcadas.has(l.id), onchange: e => { e.target.checked ? marcadas.add(l.id) : marcadas.delete(l.id); } }), l.titulo))))
          : h("p", { class: "nota", text: "Crie no Menu uma opção do tipo \"Lista de contatos/lojas\" para ligar este contato a ela." }),
        h("div", { class: "acoes" }, botao("Salvar", async () => {
          try { await zap("catalogo", { metodo: "POST", corpo: { id: c.id, nome: nome.value, whatsapp: zapI.value, telefone: tel.value, local: local.value, descricao: desc.value, destaque: destaque.checked, ativo: ativo.checked, itens: [...marcadas] } }); aviso("Contato salvo.", "ok"); fechar(); recarregar(); }
          catch (e) { aviso(e.message, "erro"); }
        }, "btn-primario"))]);
    };
    const busca = h("input", { class: "entrada", type: "search", placeholder: "Buscar por nome, local ou opção", "aria-label": "Buscar contato" });
    const corpo = h("tbody", {});
    const desenhar = () => {
      const q = busca.value.trim().toLowerCase();
      const f = cat.filter(c => !q || [c.nome, c.local, ...(c.itens || []).map(i => nomeItem.get(i))].join(" ").toLowerCase().includes(q));
      corpo.replaceChildren(...f.map(c => h("tr", {},
        h("td", {}, h("strong", { text: c.nome }), c.destaque ? h("span", { text: " ★" }) : null, !c.ativo ? h("small", { style: "display:block;color:var(--texto-3)", text: "oculto" }) : null),
        h("td", { text: c.local || "—" }),
        h("td", { text: (d0 => d0 ? telefone(d0.length <= 11 ? "55" + d0 : d0) : "—")(String(c.whatsapp || c.telefone || "").replace(/\D/g, "")) }),
        h("td", { text: (c.itens || []).map(i => nomeItem.get(i)).filter(Boolean).join(", ") || "—" }),
        h("td", {}, pode("AGENTE") ? h("div", { class: "acoes" }, botao("Editar", () => editar(c), "btn-secundario btn-pequeno"),
          botao("Excluir", async () => { if (!(await modal({ titulo: "Excluir o contato?", conteudo: `"${c.nome}" deixa de aparecer para os clientes.`, confirmar: "Excluir", perigo: true }))) return; try { await zap(`catalogo/${c.id}/excluir`, { metodo: "POST", corpo: {} }); recarregar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-secundario btn-pequeno")) : null))));
      if (!f.length) corpo.appendChild(h("tr", {}, h("td", { colspan: "5", text: cat.length ? "Nada encontrado." : "Nenhum contato ainda. Importe a planilha ou cadastre o primeiro." })));
    };
    busca.addEventListener("input", desenhar); desenhar();
    trocar(area,
      h("section", { class: "grade grade-4" },
        metrica("Contatos e lojas", numero(cat.filter(c => c.ativo).length), `${numero(cat.length)} cadastrados`),
        metrica("Opções de lista", numero(listas.length), "no menu"),
        metrica("Sem opção no menu", numero(cat.filter(c => !(c.itens || []).length).length), "não aparecem para o cliente"),
        metrica("Opções sem contato", numero(listas.filter(l => !cat.some(c => (c.itens || []).includes(l.id))).length), "ficam escondidas")),
      h("section", { class: "cartao vidro" },
        h("div", { class: "cabeca-grafico" }, h("h3", { style: "margin:0", text: "Contatos e lojas" }),
          pode("AGENTE") ? h("div", { class: "acoes" }, botao("Novo contato", () => editar(null), "btn-primario btn-pequeno"), botao("Importar planilha", () => importarZap(recarregar), "btn-secundario btn-pequeno"),
            botao("Baixar planilha", () => baixarCsv("contatos-chatbot.csv", [["nome", "telefone", "whatsapp", "local", "descricao", "opcoes"], ...cat.map(c => [c.nome, c.telefone, c.whatsapp, c.local, c.descricao, (c.itens || []).map(i => caminho(itens.find(x => x.id === i))).join(", ")])]), "btn-secundario btn-pequeno")) : null),
        h("div", { style: "margin:12px 0" }, busca),
        h("div", { class: "tabela-caixa" }, h("table", {}, h("thead", {}, h("tr", {}, ["Nome", "Local", "WhatsApp", "Aparece em", ""].map(t => h("th", { text: t })))), corpo))));
  }
  function importarZap(recarregar) {
    const entrada = h("input", { type: "file", accept: ".csv,text/csv,text/plain" });
    const previa = h("div", {});
    const fechar = gaveta("Importar planilha", [
      h("p", { text: "Uma linha por contato/loja. Colunas: nome (ou loja), telefone, whatsapp, local, descricao, e onde aparece: produtos e servicos (para shopping) ou opcoes. Separe várias por vírgula (ex.: \"Celulares, Capinhas\"). As opções que não existirem são criadas no menu." }),
      h("p", { class: "sub", text: "No Excel ou Google Planilhas: Arquivo → Baixar → CSV. Quem já existe (mesmo nome) é atualizado; nada é apagado." }),
      botao("Baixar modelo", () => baixarCsv("modelo-contatos.csv", [["nome", "telefone", "whatsapp", "local", "produtos", "servicos", "descricao"], ["Cell Center", "(21) 3333-1111", "(21) 98888-7777", "Loja 12, 1º piso", "Celulares, Capinhas", "Conserto de celular", "Celulares novos e seminovos"]]), "btn-secundario btn-pequeno"),
      h("label", { class: "soltar", style: "margin-top:12px" }, icone(ICONES.nuvem), h("strong", { text: "Escolha a planilha (CSV)" }), entrada), previa]);
    entrada.addEventListener("change", async () => {
      const arquivo = entrada.files[0]; if (!arquivo) return;
      let texto = await arquivo.text();
      if (texto.includes("�")) { try { texto = new TextDecoder("windows-1252").decode(await arquivo.arrayBuffer()); } catch { /* mantém */ } }
      const linhas = lerCsv(texto);
      const sem = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
      const cab = (linhas[0] || []).map(sem);
      const col = (...n) => cab.findIndex(c => n.some(x => c === x || c.startsWith(x)));
      const ix = { nome: col("nome", "loja", "empresa", "contato"), telefone: col("telefone", "fone", "fixo"), whatsapp: col("whatsapp", "whats", "celular", "zap"), local: col("local", "piso", "endereco", "localizacao"), produtos: col("produto"), servicos: col("servico"), opcoes: col("opco", "opca", "categoria", "segmento"), descricao: col("descricao", "observ", "sobre") };
      if (ix.nome < 0) { trocar(previa, h("p", { class: "nota nota-alerta", text: "Não encontrei a coluna \"nome\" (ou \"loja\") na primeira linha." })); return; }
      const dados = linhas.slice(1).map(l => Object.fromEntries(Object.entries(ix).map(([k, i]) => [k, i >= 0 ? String(l[i] || "").trim() : ""]))).filter(l => l.nome);
      trocar(previa, h("p", { text: `${numero(dados.length)} contato(s). Primeiros: ${dados.slice(0, 4).map(x => x.nome).join(", ")}${dados.length > 4 ? "…" : ""}` }),
        botao(`Importar ${numero(dados.length)}`, async () => {
          let n = 0, novas = 0;
          try {
            for (let i = 0; i < dados.length; i += 300) { const r = await zap("importar", { metodo: "POST", corpo: { linhas: dados.slice(i, i + 300) } }); n += r.contatos || 0; novas += r.opcoes_novas || 0; }
            aviso(`${numero(n)} contato(s) importado(s), ${numero(novas)} opção(ões) nova(s) no menu.`, "ok"); fechar(); recarregar();
          } catch (e) { aviso(`Parou com ${numero(n)}: ${e.message}`, "erro"); }
        }, "btn-primario"));
    });
  }
  async function abaZapMensagens(area, vivo) {
    const d = await zap("config");
    if (!vivo()) return;
    const cfg = d.config || {};
    const modo = h("select", { class: "entrada" }, [["BOTOES", "Só botões — sem IA, custo zero (recomendado para começar)"], ["MISTO", "Botões + IA — a IA responde o que o cliente escrever"]].map(([v, n]) => h("option", { value: v, selected: d.modo === v, text: n })));
    const ativo = h("input", { type: "checkbox", checked: d.ativo !== false });
    const campos = [["boas_vindas", "Boas-vindas (aparece com o menu inicial)", "", 3], ["nao_entendi", "Quando o robô não entende", "", 1], ["humano", "Ao chamar a equipe", "", 2], ["rodape_lista", "Depois de uma lista de contatos", "", 2], ["encerramento", "Ao finalizar", "", 2], ["rotulo_catalogo", "Como chamar os contatos", "Ex.: lojas, profissionais, unidades. Aparece como \"3 lojas\" na lista.", 1], ["rede_nome", "Rede social (nome)", "Ex.: Instagram", 1], ["rede_url", "Rede social (link)", "Vai na mensagem de encerramento.", 1]];
    const ent = {};
    const sobre = h("textarea", { class: "entrada", maxlength: "6000", style: "min-height:160px", placeholder: "Horário, endereço, estacionamento, formas de pagamento, perguntas frequentes…" }); sobre.value = cfg.sobre || "";
    const modelo = h("select", { class: "entrada" }, [["gpt-5-nano", "gpt-5-nano — o mais barato (recomendado)"], ["gpt-5-mini", "gpt-5-mini — econômico, mais esperto"], ["gpt-4o-mini", "gpt-4o-mini — econômico"]].map(([v, n]) => h("option", { value: v, selected: cfg.modelo_ia === v, text: n })));
    const limite = h("input", { class: "entrada", type: "number", min: "0", max: "5000", value: String(cfg.limite_ia_dia ?? 300) });
    const avisar = h("input", { type: "checkbox", checked: cfg.avisar_buscas !== false });
    const exibIni = h("select", { class: "entrada" }, [["AUTO", "Automático (botões ou lista)"], ["NUMERADO", "Texto numerado, sem limite de opções"]].map(([v, n]) => h("option", { value: v, selected: (cfg.exibicao_inicio || "AUTO") === v, text: n })));
    trocar(area,
      h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "Modo de atendimento" }),
        campo("Como o robô atende", modo, "Nos dois modos os botões nunca gastam IA. No modo com IA, ela só entra quando a pessoa escreve algo que a busca por palavra não achou."),
        h("label", { class: "guia-cat" }, ativo, "Robô ligado (desligado: as mensagens só ficam registradas para a equipe)"),
        h("label", { class: "guia-cat" }, avisar, "Avisar no Telegram cada busca (nome, número e o que procurou)"),
        campo("Como mostrar o menu inicial", exibIni)),
      h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "Mensagens" }),
        campos.map(([k, rot, dica, l]) => { ent[k] = l > 1 ? h("textarea", { class: "entrada", maxlength: "1000", style: `min-height:${l * 34}px` }) : h("input", { class: "entrada", maxlength: "300" }); ent[k].value = cfg[k] || ""; return campo(rot, ent[k], dica); })),
      h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "IA (só no modo Botões + IA)" }),
        campo("O que a IA pode responder sobre a empresa", sobre, "A IA só responde com o que estiver aqui ou no menu. Nunca inventa preço, telefone ou horário."),
        h("div", { class: "grade grade-2" }, campo("Modelo", modelo), campo("Limite de respostas da IA por dia", limite, "Proteção de custo: passou disso, o robô volta a mostrar o menu."))),
      pode("AGENTE") ? h("div", { class: "acoes" }, botao("Salvar", async () => {
        try { await zap("config", { metodo: "POST", corpo: { ...Object.fromEntries(Object.entries(ent).map(([k, e]) => [k, e.value])), sobre: sobre.value, modelo_ia: modelo.value, limite_ia_dia: Number(limite.value), avisar_buscas: avisar.checked, exibicao_inicio: exibIni.value, modo: modo.value, ativo: ativo.checked } }); aviso("Salvo.", "ok"); }
        catch (e) { aviso(e.message, "erro"); }
      }, "btn-primario"), h("a", { class: "btn btn-secundario", href: "#/chatbot/testar" }, "Testar como cliente")) : null);
  }
  async function abaZapConexao(area, vivo) {
    const [c, tg] = await Promise.all([zap("conta"), zap("telegram").catch(() => ({}))]);
    if (!vivo()) return;
    const pnid = h("input", { class: "entrada", value: c.phone_number_id || "", inputmode: "numeric", placeholder: "Ex.: 473474732510163" });
    const waba = h("input", { class: "entrada", value: c.waba_id || "", inputmode: "numeric", placeholder: "opcional" });
    const token = h("input", { class: "entrada", type: "password", autocomplete: "off", placeholder: c.tem_token ? "Já salvo — cole outro só para trocar" : "EAA…" });
    const segredo = h("input", { class: "entrada", type: "password", autocomplete: "off", placeholder: c.tem_segredo ? "Já salva — cole outra só para trocar" : "32 letras e números" });
    const tgToken = h("input", { class: "entrada", type: "password", autocomplete: "off", placeholder: c.telegram ? "Já configurado — cole outro só para trocar" : "123456:ABC… (do @BotFather)" });
    const tgChat = h("input", { class: "entrada", placeholder: "-100123456789" });
    const copia = (rot, valor) => h("div", { class: "campo" }, h("label", { text: rot }), h("div", { style: "display:flex;gap:8px" }, h("input", { class: "entrada", value: valor, readOnly: true }), botao("Copiar", () => copiar(valor), "btn-secundario btn-pequeno")));
    trocar(area,
      h("section", { class: "grade grade-2" },
        h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "1. Número do WhatsApp (API oficial da Meta)" }),
          c.conectada ? h("p", {}, selo("Conectado", "ok"), " ", h("strong", { text: c.numero || c.phone_number_id }), c.nome_verificado ? " · " + c.nome_verificado : "", c.ultima_recebida_ms ? h("span", { class: "sub", text: ` · última mensagem ${quandoFrase(c.ultima_recebida_ms)}` }) : h("span", { class: "sub", text: " · ainda não chegou mensagem (confira o passo 2)" })) : h("p", { class: "nota", text: "Em developers.facebook.com → seu app → WhatsApp → Configuração da API: copie o ID do número de telefone. O token permanente se cria em business.facebook.com → Configurações → Usuários do sistema → Gerar token (permissões whatsapp_business_messaging e whatsapp_business_management)." }),
          campo("ID do número de telefone (Phone number ID)", pnid), campo("ID da conta do WhatsApp Business (opcional)", waba), campo("Token de acesso permanente", token), campo("Chave secreta do app (recomendado)", segredo, "Configurações do app → Básico → Chave secreta. Com ela, só mensagens assinadas pela Meta são aceitas."),
          pode("ADMIN") ? h("div", { class: "acoes" }, botao(c.conectada ? "Salvar e testar" : "Conectar", async () => {
            try { const r = await zap("conta", { metodo: "POST", corpo: { phone_number_id: pnid.value, waba_id: waba.value, ...(token.value.trim() ? { token: token.value.trim() } : {}), ...(segredo.value.trim() ? { app_secret: segredo.value.trim() } : {}) } }); aviso(`WhatsApp conectado: ${r.numero || "ok"}.`, "ok"); estado.org.chatbot = true; aplicarModo(); navegar(); }
            catch (e) { aviso(e.message, "erro"); }
          }, "btn-primario"), c.conectada ? botao("Desconectar", async () => { if (!(await modal({ titulo: "Desconectar o WhatsApp?", conteudo: "O robô para de responder neste número.", confirmar: "Desconectar", perigo: true }))) return; await zap("conta", { metodo: "POST", corpo: { desconectar: true } }); navegar(); }, "btn-secundario") : null) : h("p", { class: "nota", text: "Somente administradores mudam a conexão." })),
        h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "2. Webhook (cole no app da Meta)" }),
          h("p", { class: "sub", text: "No app da Meta → WhatsApp → Configuração → Webhook → Editar: cole o endereço e o token abaixo, clique em Verificar e salvar, e depois assine o campo \"messages\". É o mesmo endereço para todas as empresas." }),
          copia("URL de retorno", c.webhook_url), c.verify_token ? copia("Token de verificação", c.verify_token) : h("p", { class: "nota", text: "Peça a um administrador o token de verificação." }),
          h("p", { class: "nota", text: "Se esse número hoje usa outro robô (ex.: Botpress), é só trocar o endereço do webhook. Para voltar, cole o endereço antigo. O número não sai da conta de vocês." }))),
      h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "3. Telegram da equipe (opcional)" }),
        h("p", { class: "sub", text: "No grupo chegam os pedidos de \"falar com alguém\" e as buscas. A equipe responde o cliente respondendo o próprio aviso no Telegram, e o comando /resumo mostra os números do dia. Sem Telegram, os pedidos de atendimento chegam por e-mail." }),
        tg.conectado ? h("p", {}, selo("Conectado", "ok"), " ", h("strong", { text: tg.grupo || "" })) : null,
        tg.disponivel && pode("ADMIN") ? h("div", { class: "acoes" },
          botao(tg.conectado ? "Conectar outro grupo" : "Conectar o grupo do Telegram", async () => { try { const l = await zap("telegram/link", { metodo: "POST", corpo: {} }); window.open(l.grupo, "_blank", "noopener"); await modal({ titulo: "Escolha o grupo no Telegram", conteudo: ["O Telegram abriu: escolha o grupo da equipe e toque em Adicionar. O bot confirma no grupo e pronto.", "Prefere receber no seu chat pessoal? Use este link: " + l.privado, "O link vale por 1 hora."], soInformar: true }); navegar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-primario btn-pequeno"),
          tg.conectado ? botao("Desconectar", async () => { await zap("telegram/desligar", { metodo: "POST", corpo: {} }); navegar(); }, "btn-secundario btn-pequeno") : null) : null,
        !tg.disponivel ? h("details", { class: "detalhes" }, h("summary", { text: "Usar um bot próprio (avançado)" }),
          h("div", { class: "grade grade-2" }, campo("Token do bot", tgToken), campo("ID do grupo", tgChat, "Adicione o bot ao grupo. O ID aparece em api.telegram.org/bot<token>/getUpdates.")),
          pode("ADMIN") ? h("div", { class: "acoes" }, botao("Salvar e mandar teste", async () => { try { const r = await zap("conta/telegram", { metodo: "POST", corpo: { telegram_token: tgToken.value.trim(), telegram_chat: tgChat.value.trim() } }); aviso(r.aviso || "Telegram ligado: confira a mensagem de teste no grupo.", r.aviso ? "erro" : "ok"); navegar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-primario btn-pequeno")) : null) : null));
  }
  function abaZapTestar(area) {
    const tela = h("div", { class: "mensagens guia-tela", "aria-live": "polite" });
    const entrada = h("input", { class: "entrada", placeholder: "Escreva como um cliente…", maxlength: "500" });
    const balao = (t, cli) => h("div", { class: "msg " + (cli ? "msg-entrada" : "msg-saida") }, t);
    const enviar = async (texto, acao, rotulo) => {
      tela.appendChild(balao(rotulo || texto, true));
      try {
        const r = await zap("testar", { metodo: "POST", corpo: { texto, acao } });
        for (const x of r.respostas || []) {
          const it = x.interativo;
          if (!it) { tela.appendChild(balao(x.texto, false)); continue; }
          const caixa = balao((it.body || {}).text || "", false);
          const ops = it.type === "button" ? it.action.buttons.map(b => ({ id: b.reply.id, title: b.reply.title })) : ((it.action.sections || [])[0] || {}).rows || [];
          caixa.appendChild(h("div", { class: "guia-botoes" }, ops.map(o => h("button", { type: "button", class: "btn btn-secundario btn-pequeno", title: o.description || "", onclick: () => enviar(o.title, o.id, o.title) }, o.title + (o.description ? ` · ${o.description}` : "")))));
          tela.appendChild(caixa);
        }
      } catch (e) { aviso(e.message, "erro"); }
      tela.scrollTop = tela.scrollHeight;
    };
    const mandar = () => { const t = entrada.value.trim(); if (!t) return; entrada.value = ""; enviar(t, ""); };
    entrada.addEventListener("keydown", e => { if (e.key === "Enter") mandar(); });
    trocar(area, h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "Testar como cliente" }),
      h("p", { class: "sub", text: "Simula a conversa: nada é enviado pelo WhatsApp e nada entra nas métricas. No modo Botões + IA, o que você escrever pode usar a IA (centavos)." }),
      h("div", { class: "acoes", style: "margin:8px 0" }, botao("Começar (oi)", () => enviar("oi", "", "oi"), "btn-primario btn-pequeno"), botao("Limpar", () => tela.replaceChildren(), "btn-secundario btn-pequeno")),
      tela, h("div", { class: "compor" }, entrada, botao("Enviar", mandar, "btn-primario"))));
  }

  // ----- Plano e pagamento: teste grátis, planos (mensal/anual), assinatura (Pix, boleto, cartão) e histórico.
  const RECURSO_DA_ROTA = {
    conversas: "ia_completa", atendimentos: "ia_completa", profissionais: "ia_completa", treinamento: "ia_completa", aprendizados: "ia_completa", clientes: "ia_completa", whatsapp: "ia_completa", guia: "ia_completa",
    chatbot: "chatbot", estudio: "marketing", calendario: "marketing", aprovacoes: "marketing", marcas: "marketing", instagram: "marketing", facebook: "marketing", google: "marketing", social: "marketing", denia: "voz"
  };
  window.DENIA_RECURSOS = window.DENIA_RECURSOS || { chatbot: "Chatbot do WhatsApp com botões e listas", chatbot_ia: "IA no chatbot", ia_completa: "IA completa de atendimento (atende como uma pessoa, com memória)", marketing: "Instagram, Facebook e Google: posts, artes, comentários e avaliações", voz: "DENIA por voz, ao vivo", multiempresa: "Várias empresas, marcas e unidades", temporada: "Locação por temporada" };
  const ROTAS_LIVRES = ["plano", "conta", "equipe", "auditoria", "empresas", "contatos", "painel", "integracoes", "consumo"];
  const acessoAtual = () => (estado.org && estado.org.acesso) || { liberado: true, recursos: [], status: "?" };
  const temRecurso = r => !r || estado.eu.usuario.super_admin || (acessoAtual().liberado && (acessoAtual().recursos || []).includes(r));
  const NOME_STATUS_PLANO = { TESTE: "Teste grátis", ATIVO: "Ativo", ATRASADO: "Pagamento pendente", CANCELADO: "Cancelado (usa até o fim do período)", CORTESIA: "Cortesia — acesso total", BLOQUEADO: "Bloqueado", TESTE_ACABOU: "Teste encerrado" };
  function aplicarPlano() {
    document.querySelectorAll("#lateral-nav a[data-rota]").forEach(a => {
      const r = RECURSO_DA_ROTA[a.dataset.rota];
      const travado = r && !temRecurso(r);
      a.classList.toggle("travado", Boolean(travado));
      a.title = travado ? "Disponível em um plano superior" : "";
    });
    const f = $("faixa-plano");
    if (!f) return;
    const a = acessoAtual();
    const mostrar = estado.org && !estado.eu.usuario.super_admin && (a.status === "TESTE" || a.status === "TESTE_ACABOU" || a.status === "ATRASADO" || a.status === "BLOQUEADO");
    if (!mostrar) { f.classList.add("oculto"); f.replaceChildren(); return; }
    const txtF = a.status === "TESTE" ? `Teste grátis: ${a.dias <= 1 ? "último dia" : `faltam ${a.dias} dias`} do plano ${a.nome}.` : a.status === "TESTE_ACABOU" ? "Seu teste grátis terminou. O atendimento automático está pausado; seus dados continuam guardados." : a.status === "ATRASADO" ? "O pagamento do plano está pendente. O acesso continua por até 3 dias depois do vencimento." : "O plano desta empresa está bloqueado.";
    f.className = "faixa-plano" + (a.status === "TESTE" ? "" : " faixa-plano-alerta");
    f.replaceChildren(h("span", { text: txtF }), pode("ADMIN") ? h("a", { class: "btn btn-primario btn-pequeno", href: "#/plano" }, a.status === "TESTE" ? "Escolher plano" : "Regularizar") : null);
  }
  function telaTravada(el, recurso) {
    const a = acessoAtual();
    const bloqueado = !a.liberado;
    el.appendChild(h("section", { class: "cartao vidro trava" }, h("div", { class: "trava-icone", text: "🔒" }),
      h("h2", { text: bloqueado ? (a.status === "TESTE_ACABOU" ? "Seu teste grátis terminou" : "Plano pendente") : "Disponível em um plano superior" }),
      h("p", { text: bloqueado ? "Escolha um plano para voltar a usar. Nada foi apagado: menu, treinamento, conversas e configurações continuam aqui." : `Seu plano ${a.nome} não inclui: ${(window.DENIA_RECURSOS || {})[recurso] || recurso}. Atualize o plano para liberar na hora.` }),
      h("div", { class: "acoes", style: "justify-content:center" }, h("a", { class: "btn btn-primario", href: "#/plano" }, "Ver planos"))));
  }
  async function paginaPlano(el, _p, vivo) {
    el.appendChild(cabeca("Plano e pagamento", "Sem fidelidade: mude de plano ou cancele quando quiser. No plano anual você economiza."));
    const area = h("div", { class: "grade" }, carregando());
    el.appendChild(area);
    let d;
    try { d = await org("plano"); } catch (e) { if (vivo()) falha(area, e); return; }
    if (!vivo()) return;
    window.DENIA_RECURSOS = d.recursos;
    const a = d.acesso;
    estado.org.acesso = a; aplicarPlano();
    const f = estado.planoF = estado.planoF || { ciclo: "MENSAL" };
    const real = v => dinheiro(v, "BRL");
    const resumo = h("section", { class: "grade grade-4" },
      metrica("Plano", a.nome, NOME_STATUS_PLANO[a.status] || a.status),
      metrica(a.status === "TESTE" ? "Teste termina" : "Válido até", a.cortesia ? "Sem prazo" : a.ate ? new Date(a.ate).toLocaleDateString(LOCALE) : "—", a.dias != null && !a.cortesia ? `${a.dias} dia(s)` : a.cortesia ? "liberado pela equipe DENIA" : ""),
      metrica("Pagamento", a.ciclo === "ANUAL" ? "Anual" : a.ciclo === "MENSAL" ? "Mensal" : "—", a.assinatura ? "assinatura ativa" : "sem assinatura"),
      metrica("Equipe", `${numero(d.uso.usuarios)} / ${a.cortesia ? "∞" : numero(a.limites.usuarios)}`, "pessoas com acesso"));
    const ciclo = h("div", { class: "abas abas-chips", role: "group", "aria-label": "Ciclo" }, [["MENSAL", "Mensal"], ["ANUAL", `Anual (−${Math.round(d.desconto_anual * 100)}%)`]].map(([v, n]) => h("button", { type: "button", class: "aba" + (f.ciclo === v ? " ativo" : ""), "aria-pressed": f.ciclo === v ? "true" : "false", onclick: () => { f.ciclo = v; navegar(); } }, n)));
    const cartoes = h("section", { class: "grade-planos-app" }, d.planos.map(p => {
      const atual = p.id === a.plano && ["ATIVO", "CORTESIA"].includes(a.status);
      const preco = f.ciclo === "ANUAL" ? p.anual : p.mensal;
      return h("article", { class: "cartao vidro plano-app" + (p.id === "growth" ? " plano-app-destaque" : "") },
        h("h3", { style: "margin:0", text: p.nome }), h("p", { class: "sub", style: "margin:0", text: p.desc }),
        h("p", { class: "plano-app-preco" }, h("strong", { text: real(preco) }), h("small", { text: f.ciclo === "ANUAL" ? "/ano" : "/mês" })),
        f.ciclo === "ANUAL" ? h("p", { class: "sub", style: "margin:0", text: `equivale a ${real(p.anual / 12)}/mês` }) : null,
        h("ul", { class: "lista-simples" }, p.recursos.map(r => h("li", { text: "✓ " + d.recursos[r] })), h("li", { text: `✓ Até ${numero(p.limites.usuarios)} pessoas na equipe` }), h("li", { text: `✓ ${numero(p.limites.ia_mes)} respostas de IA do chatbot por mês` })),
        atual ? selo("Seu plano", "ok") : d.pode_assinar && !a.cortesia ? botao(a.status === "TESTE" && p.id === a.plano ? "Assinar este plano" : "Escolher", () => assinar(p, d), "btn-primario") : null);
    }));
    const pags = d.pagamentos || [];
    const NOME_PAG = { PENDING: "Aguardando", RECEIVED: "Pago", CONFIRMED: "Pago", OVERDUE: "Vencido", REFUNDED: "Estornado", RECEIVED_IN_CASH: "Pago" };
    trocar(area, resumo,
      a.cortesia ? h("p", { class: "nota", text: "Esta empresa tem cortesia da equipe DENIA: acesso total, sem custo." }) : null,
      h("section", { class: "cartao vidro filtros-desempenho" }, ciclo),
      cartoes,
      h("p", { class: "nota", text: "Pagamento por Pix, boleto ou cartão de crédito, com nota fiscal. A cobrança é feita pelo Asaas, instituição de pagamento autorizada pelo Banco Central. Mensagens do WhatsApp cobradas pela Meta não estão incluídas." }),
      pags.length ? h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "Pagamentos" }), h("div", { class: "tabela-caixa" }, h("table", {}, h("thead", {}, h("tr", {}, ["Vencimento", "Valor", "Forma", "Situação", ""].map(t => h("th", { text: t })))),
        h("tbody", {}, pags.map(x => h("tr", {}, h("td", { text: dataCompleta(x.vencimento) }), h("td", { text: real(x.valor) }), h("td", { text: ({ PIX: "Pix", BOLETO: "Boleto", CREDIT_CARD: "Cartão", UNDEFINED: "A escolher" })[x.forma] || x.forma || "—" }), h("td", {}, selo(NOME_PAG[x.status] || x.status, ["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"].includes(x.status) ? "ok" : x.status === "OVERDUE" ? "erro" : "alerta")),
          h("td", {}, x.link ? h("a", { class: "btn btn-secundario btn-pequeno", href: x.link, target: "_blank", rel: "noopener" }, ["RECEIVED", "CONFIRMED"].includes(x.status) ? "Comprovante" : "Pagar") : null))))))) : null,
      a.assinatura && d.pode_assinar && !a.cortesia ? h("div", { class: "acoes" }, botao("Cancelar assinatura", async () => {
        if (!(await modal({ titulo: "Cancelar a assinatura?", conteudo: "Sem multa. Você continua usando até o fim do período já pago; depois o atendimento automático pausa (os dados ficam guardados).", confirmar: "Cancelar assinatura", perigo: true }))) return;
        try { await org("plano/cancelar", { metodo: "POST", corpo: {} }); aviso("Assinatura cancelada.", "ok"); await recarregarEu(); navegar(); } catch (e) { aviso(e.message, "erro"); }
      }, "btn-secundario")) : null);
  }
  function assinar(p, d) {
    const f = estado.planoF;
    const nome = h("input", { class: "entrada", maxlength: "120", placeholder: "Nome completo ou razão social" });
    const doc = h("input", { class: "entrada", inputmode: "numeric", maxlength: "18", placeholder: "CPF ou CNPJ" });
    const email = h("input", { class: "entrada", type: "email", value: estado.eu.usuario.email, maxlength: "200" });
    const tel = h("input", { class: "entrada", inputmode: "tel", maxlength: "20", placeholder: "(21) 99999-9999 (opcional)" });
    const preco = f.ciclo === "ANUAL" ? p.anual : p.mensal;
    const fechar = gaveta(`Assinar o plano ${p.nome}`, [
      h("p", {}, h("strong", { text: `${dinheiro(preco, "BRL")} ${f.ciclo === "ANUAL" ? "por ano" : "por mês"}` }), acessoAtual().status === "TESTE" ? " — a primeira cobrança vence no fim do teste grátis; você não perde nenhum dia." : ""),
      campo("Nome ou razão social (vai na nota fiscal)", nome), campo("CPF ou CNPJ", doc), campo("E-mail para a cobrança e a nota", email), campo("Celular", tel),
      h("p", { class: "sub", text: "Na próxima tela você escolhe Pix, boleto ou cartão de crédito. Sem fidelidade." }),
      h("div", { class: "acoes" }, botao("Continuar para o pagamento", async () => {
        try {
          const r = await org("plano/assinar", { metodo: "POST", corpo: { plano: p.id, ciclo: f.ciclo, nome: nome.value, documento: doc.value, email: email.value, telefone: tel.value } });
          fechar(); await recarregarEu();
          if (r.link) { window.open(r.link, "_blank", "noopener"); aviso("Abrimos a página de pagamento. Quando o pagamento for confirmado, o plano é liberado sozinho.", "ok"); }
          navegar();
        } catch (e) { aviso(e.message, "erro"); }
      }, "btn-primario"))]);
  }

  async function paginaWhatsapp(el, aba, vivo) {
    el.appendChild(cabeca("WhatsApp", "Atendimento aos clientes e conversa com os profissionais pela API oficial: números, qualidade, entregas e diagnóstico."));
    if (!estado.org.conectada) { falha(el, new ErroApi("A IA desta empresa ainda não foi conectada.", 503, { codigo: "ENGINE_NAO_CONFIGURADO" })); return; }
    const abas = [["visao", "Visão geral"], ["atendimento", "Atendimento"], ["atendimentos", "Atendimentos"], ["profissionais", "Profissionais"], ["entregas", "Entregas"], ["diagnostico", "Diagnóstico"], ["conexao", "Conexão"]].filter(a => !(modoGuia() && ["atendimentos", "profissionais"].includes(a[0])));
    const atual = abas.some(a => a[0] === aba) ? aba : "visao";
    el.appendChild(h("div", { class: "abas", role: "tablist" }, abas.map(([k, n]) => h("a", { class: "aba" + (k === atual ? " ativo" : ""), href: "#/whatsapp/" + k, role: "tab" }, n))));
    const f = estado.numerosZap = estado.numerosZap || { dias: 30, metrica: "recebidas" };
    const comPeriodo = ["visao", "atendimento", "atendimentos", "profissionais", "entregas"].includes(atual);
    if (comPeriodo) el.appendChild(h("section", { class: "cartao vidro filtros-desempenho" }, h("div", { class: "abas abas-chips", role: "group", "aria-label": "Período" },
      [[1, "Hoje"], [7, "7 dias"], [30, "30 dias"], [60, "60 dias"], [90, "90 dias"], [180, "6 meses"], [365, "12 meses"]].map(([v, n]) => h("button", { type: "button", class: "aba" + (f.dias === v ? " ativo" : ""), "aria-pressed": f.dias === v ? "true" : "false", onclick: () => { f.dias = v; navegar(); } }, n)))));
    const area = h("div", { class: "grade" }, carregando());
    el.appendChild(area);
    const de = isoLocal(new Date(Date.now() - (f.dias - 1) * 86400000)), ate = isoLocal(new Date());
    try {
      if (atual === "diagnostico") { const st = await eng("status", { fresco: true }).catch(() => null); if (vivo()) trocar(area, cartaoDiagnostico(st)); return; }
      if (atual === "conexao") return await abaConexaoZap(area, vivo);
      let m;
      try { m = await eng(`metrics?de=${de}&ate=${ate}`, { fresco: true }); }
      catch (e) { if (e.status === 404) { trocar(area, h("section", { class: "cartao vidro" }, h("p", { class: "nota", text: "Cole o motor 31.7 no Worker denia para ver as métricas completas do atendimento." }))); return; } throw e; }
      if (!vivo()) return;
      const cv = m.conversas || {}, rp = m.respostas || {}, en = m.entregas || {}, at = m.atendimentos || {}, fu = at.funil || {};
      if (atual === "visao") {
        const numeros = h("div", {});
        trocar(area, h("section", { class: "grade grade-4" },
          metrica("Contatos", numero(cv.contatos || 0), `${numero(cv.novos || 0)} novos · ${numero(cv.recorrentes || 0)} já eram clientes`),
          metrica("Respondidas pela DENIA", rp.parte_ia != null ? `${String(rp.parte_ia).replace(".", ",")}%` : "—", `${numero(rp.ia || 0)} da DENIA · ${numero(rp.equipe || 0)} da equipe`),
          metrica("Tempo de resposta", fmtTempo(rp.tempo_ia_s), `DENIA (mediana) · equipe: ${fmtTempo(rp.tempo_equipe_s)}`),
          metrica("Taxa de entrega", en.taxa_entrega != null ? `${String(en.taxa_entrega).replace(".", ",")}%` : "—", `${numero((en.entregues || 0) + (en.lidas || 0))} entregues · ${numero(en.lidas || 0)} lidas`),
          metrica("Atendimentos abertos", numero(fu.abertos || 0), `${numero(fu.agendados || 0)} agendados · ${numero(fu.concluidos || 0)} concluídos`),
          metrica("Conversão", fu.abertos ? `${Math.round(((fu.agendados || 0) / fu.abertos) * 100)}%` : "—", "Atendimentos que viraram serviço agendado"),
          metrica("Sem resposta", numero(cv.sem_resposta || 0), "Conversas esperando há mais de 30 min"),
          metrica("Mensagens recebidas", numero(cv.mensagens_recebidas || 0), `${numero(cv.clientes || 0)} clientes · ${numero(cv.profissionais || 0)} profissionais`)),
          numeros);
        if (pode("ADMIN")) blocoNumerosWhatsapp(numeros, { semPeriodo: true }); else numeros.remove();
        return;
      }
      if (atual === "atendimento") {
        trocar(area,
          h("section", { class: "grade grade-4" },
            metrica("DENIA responde em", fmtTempo(rp.tempo_ia_s), `9 em cada 10 em até ${fmtTempo(rp.tempo_ia_p90_s)}`),
            metrica("Equipe responde em", fmtTempo(rp.tempo_equipe_s), `9 em cada 10 em até ${fmtTempo(rp.tempo_equipe_p90_s)}`),
            metrica("Parte da DENIA", rp.parte_ia != null ? `${String(rp.parte_ia).replace(".", ",")}%` : "—", "das mensagens enviadas"),
            metrica("Conversas sem resposta", numero(cv.sem_resposta || 0), "esperando há mais de 30 min")),
          h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "Quem respondeu" }), barras([{ rotulo: "DENIA", valor: rp.ia || 0 }, { rotulo: "Equipe", valor: rp.equipe || 0 }])),
          h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "Horários com mais mensagens" }), mapaHorarios(m.horarios || Array.from({ length: 7 }, () => Array(24).fill(0)))),
          h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "Contatos" }), barras([{ rotulo: "Novos", valor: cv.novos || 0 }, { rotulo: "Já eram clientes", valor: cv.recorrentes || 0 }, { rotulo: "Profissionais", valor: cv.profissionais || 0 }])));
        return;
      }
      if (atual === "atendimentos") {
        const etapas = Object.entries(at.por_etapa || {}).map(([k, v]) => ({ rotulo: NOME_ETAPA_CURTO[k] || k, valor: v })).sort((a, b) => b.valor - a.valor);
        trocar(area,
          h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "Funil do período" }),
            barras([{ rotulo: "Abertos", valor: fu.abertos || 0 }, { rotulo: "Profissional consultado", valor: fu.com_profissional || 0 }, { rotulo: "Agendados", valor: fu.agendados || 0 }, { rotulo: "Concluídos", valor: fu.concluidos || 0 }, { rotulo: "Cancelados", valor: fu.cancelados || 0 }]),
            h("p", { class: "sub", style: "margin:8px 0 0", text: fu.abertos ? `${Math.round(((fu.agendados || 0) / fu.abertos) * 100)}% dos atendimentos abertos viraram serviço agendado.` : "Nenhum atendimento aberto no período." })),
          h("section", { class: "grade grade-2" },
            h("div", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "Por etapa" }), etapas.length ? barras(etapas) : vazio("Nenhum atendimento", "")),
            h("div", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "Por serviço" }), (at.por_servico || []).length ? barras(at.por_servico.map(x => ({ rotulo: x.servico, valor: x.n }))) : vazio("Nenhum atendimento", ""))),
          h("div", { class: "acoes" }, h("a", { class: "btn btn-secundario btn-pequeno", href: "#/atendimentos" }, "Abrir a lista de atendimentos")));
        return;
      }
      if (atual === "profissionais") {
        const lista = m.profissionais || [];
        trocar(area, h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "Profissionais no período" }),
          lista.length ? h("div", { class: "tabela-caixa" }, h("table", {}, h("thead", {}, h("tr", {}, ["Profissional", "Consultas", "Responderam", "Confirmados", "Recusados", "Tempo de resposta", "Valor confirmado"].map(t => h("th", { text: t })))),
            h("tbody", {}, lista.map(p => h("tr", {}, h("td", {}, h("strong", { text: p.nome })), h("td", { text: numero(p.consultas) }), h("td", { text: `${numero(p.responderam)} (${p.consultas ? Math.round((p.responderam / p.consultas) * 100) : 0}%)` }),
              h("td", { text: numero(p.confirmadas) }), h("td", { text: numero(p.recusadas) }), h("td", { text: p.tempo_resposta_min != null ? fmtTempo(p.tempo_resposta_min * 60) : "—" }), h("td", { text: p.valor_confirmado ? dinheiro(p.valor_confirmado / 100, "BRL") : "—" }))))))
            : vazio("Nenhuma consulta a profissionais no período", "")),
          h("div", { class: "acoes" }, h("a", { class: "btn btn-secundario btn-pequeno", href: "#/profissionais" }, "Cadastro de profissionais")));
        return;
      }
      if (atual === "entregas") {
        const numeros = h("div", {});
        trocar(area, h("section", { class: "grade grade-4" },
          metrica("Enviadas", numero(en.total || 0), "aceitas pela Meta"),
          metrica("Entregues", numero((en.entregues || 0) + (en.lidas || 0)), en.taxa_entrega != null ? `${String(en.taxa_entrega).replace(".", ",")}% do total` : ""),
          metrica("Lidas", numero(en.lidas || 0), en.total ? `${Math.round(((en.lidas || 0) / en.total) * 100)}% do total` : ""),
          metrica("Não chegaram", numero(en.falhas || 0), en.resolvido ? "já normalizado" : en.falhas_pendentes ? `${numero(en.falhas_pendentes)} desde a última entrega` : "")),
          (en.motivos || []).length ? h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "Por que não chegaram" }), barras(en.motivos.map(x => ({ rotulo: x.motivo, valor: x.n })))) : null,
          numeros);
        if (pode("ADMIN")) { estado.numerosZap.metrica = ["entregues", "falhas"].includes(estado.numerosZap.metrica) ? estado.numerosZap.metrica : "entregues"; blocoNumerosWhatsapp(numeros, { semPeriodo: true }); }
        return;
      }
    } catch (e) { falha(area, e); }
  }
  async function abaConexaoZap(area, vivo) {
    let s;
    try { s = await eng("status", { fresco: true }); } catch (e) { if (vivo()) falha(area, e); return; }
    if (!vivo()) return;
    const ok = v => v ? selo("Ativo", "ok") : selo("Pendente", "alerta");
    const lim = s.limites_envio || {}, tw = s.teste_whatsapp || {};
    trocar(area, h("section", { class: "grade grade-2" },
      h("section", { class: "cartao vidro" }, h("h3", { text: "Conexão" }), h("p", { text: "Situação do número da empresa na API oficial." }),
        h("ul", { class: "lista-saude" },
          h("li", {}, "Número conectado (token da Meta)", ok(s.whatsapp_configurado)),
          tw.numero ? h("li", {}, "Número", h("strong", { text: tw.numero })) : null,
          tw.qualidade ? h("li", {}, "Qualidade do número na Meta", selo(({ GREEN: "Verde (boa)", YELLOW: "Amarela (atenção)", RED: "Vermelha (risco)" })[String(tw.qualidade).toUpperCase()] || tw.qualidade, String(tw.qualidade).toUpperCase() === "GREEN" ? "ok" : "alerta")) : null,
          tw.limite ? h("li", {}, "Limite de conversas iniciadas por dia", h("strong", { text: String(tw.limite).replace("TIER_", "").replace("K", " mil").replace("UNLIMITED", "ilimitado") })) : null,
          h("li", {}, "Assinatura das mensagens verificada", ok(s.assinatura_meta_verificada)),
          h("li", {}, "Modelo aprovado para falar com profissionais", ok(s.template_prestador_configurado)),
          h("li", {}, "Atendimento automático", s.pausa_geral ? selo("Pausado", "alerta") : selo("Ligado", "ok")),
          h("li", {}, "Versão do motor", h("strong", { text: s.versao || "—" }))),
        h("p", { class: "sub", text: "Qualidade e limite aparecem depois de \"Verificar agora\" no Diagnóstico." })),
      h("section", { class: "cartao vidro" }, h("h3", { text: "Proteções" }), h("p", { text: "Travas que impedem envios em excesso e custos inesperados com a Meta." }),
        h("ul", { class: "lista-saude" },
          h("li", {}, "Mensagens seguidas do cliente", h("strong", { text: "uma resposta só" })),
          lim.porTelefone2min ? h("li", {}, "Limite por contato", h("strong", { text: `${lim.porTelefone2min} a cada 2 min · ${lim.porTelefoneHora} por hora` })) : null,
          h("li", {}, "Mensagens atrasadas", h("strong", { text: "só responde até 30 min; nunca em massa" })),
          h("li", {}, "Fora da janela de 24 horas", h("strong", { text: "só com modelo aprovado" }))),
        h("div", { class: "acoes", style: "margin-top:16px" }, h("a", { class: "btn btn-primario btn-pequeno", href: "#/conversas" }, "Abrir conversas"), h("a", { class: "btn btn-secundario btn-pequeno", href: "#/painel" }, "Controle da IA")))));
  }

  async function paginaContatos(el, _p, vivo) {
    el.appendChild(cabeca("Contatos do site", "Mensagens enviadas pela página Fale conosco."));
    const zap = h("input", { class: "entrada", placeholder: "Ex.: (21) 97546-9162", inputmode: "tel" });
    const cartaoZap = h("section", { class: "cartao vidro formulario" }, h("h3", { style: "margin:0", text: "Botão flutuante de WhatsApp no site" }),
      h("p", { style: "margin:0;color:var(--texto-2);font-size:14px", text: "O número da Central que aparece no botão verde da página inicial. Os visitantes caem direto na conversa para saber mais da DENIA." }),
      campo("WhatsApp da Central (com DDD)", zap),
      h("div", { class: "acoes" }, botao("Salvar número", async () => {
        try { const r = await api("/api/admin/site", { metodo: "POST", corpo: { whatsapp: zap.value } }); zap.value = r.whatsapp; aviso(r.whatsapp ? "Número salvo. O botão já aparece no site." : "Número removido.", "ok"); }
        catch (e) { aviso(e.message, "erro"); }
      }, "btn-primario"), h("a", { class: "btn btn-secundario", href: "/", target: "_blank", rel: "noopener" }, "Ver o site")));
    el.appendChild(cartaoZap);
    api("/api/admin/site").then(r => { zap.value = r.whatsapp || ""; }).catch(() => {});
    const area = h("div", {}, carregando());
    el.appendChild(area);
    let lista;
    try { lista = (await api("/api/admin/contatos")).contatos || []; }
    catch (e) { if (vivo()) falha(area, e); return; }
    if (!vivo()) return;
    area.replaceChildren(lista.length ? h("div", { class: "grade" }, lista.map(c => h("article", { class: "sugestao vidro" },
      h("div", { class: "sugestao-topo" }, h("strong", { text: c.nome }), c.lido ? null : selo("Novo", "info"), h("span", { class: "selo", text: c.assunto || "Contato" })),
      h("p", { style: "margin:0;color:var(--texto-2);white-space:pre-wrap", text: c.mensagem }),
      h("p", { class: "evidencia", text: [c.email, c.telefone, c.empresa, quando(c.criado_ms)].filter(Boolean).join(" · ") }),
      h("div", { class: "acoes" }, h("a", { class: "btn btn-secundario btn-pequeno", href: "mailto:" + encodeURIComponent(c.email) }, "Responder por e-mail"),
        c.telefone && String(c.telefone).replace(/\D/g, "").length >= 10 ? h("a", { class: "btn btn-secundario btn-pequeno", href: "https://wa.me/" + (String(c.telefone).replace(/\D/g, "").length <= 11 ? "55" : "") + String(c.telefone).replace(/\D/g, ""), target: "_blank", rel: "noopener noreferrer" }, "Chamar no WhatsApp") : null))))
      : h("div", { class: "cartao vidro" }, vazio("Nenhum contato ainda", "As mensagens da página Fale conosco aparecem aqui.")));
  }

  // ---------------------------------------------------------------------------
  // Estúdio de Marketing
  // ---------------------------------------------------------------------------

  const mk = (caminho, op) => api(`/api/orgs/${estado.org.id}/mk/${caminho}`, op);
  const NOME_STATUS = { RASCUNHO: ["Rascunho", ""], AGUARDANDO: ["Aguardando aprovação", "alerta"], APROVADO: ["Aprovado", "ok"], PUBLICADO: ["Publicado", "info"], REJEITADO: ["Rejeitado", "erro"] };
  const NOME_FORMATO = { post: "Post", carrossel: "Carrossel", story: "Story", reels: "Reels", google: "Google" };
  const NOME_CANAL = { instagram: "Instagram", facebook: "Facebook", google: "Google" };
  const DIAS = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"];
  const isoLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const segundaDe = (d) => { const x = new Date(d); x.setHours(12, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
  const somarDias = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const dataCurta = iso => { const [a, m, d] = String(iso || "").split("-"); return d ? `${d}/${m}` : "—"; };
  const dataCompleta = iso => { const [a, m, d] = String(iso || "").slice(0, 10).split("-"); return d ? `${d}/${m}/${a}` : ""; };
  // "O que eu faria" com uma avaliação ruim: denunciar (tópico do Google e como), responder, ou os dois.
  function planoAvaliacao(a, t, x) {
    const passos = [];
    if (t && t.categoria) {
      passos.push(`Denunciar no Google no tópico "${t.categoria}" — ${t.motivo || "há indícios de que viola as regras do Google."}`);
      passos.push("Como: abra o perfil no Google Maps (Triagem 1★ → Denunciar no Google), procure pelo nome de quem avaliou, toque nos três pontinhos → Denunciar avaliação → escolha esse tópico. Depois marque \"Já denunciei\" na DENIA.");
      passos.push("Enquanto o Google analisa, publique uma resposta educada (a sugerida abaixo): quem lê vê que a empresa se importa. Se o Google recusar, peça nova análise uma vez, com a justificativa da triagem.");
    } else if (t) {
      passos.push(`Não há base para denúncia: ${t.motivo || "parece de cliente real."}`);
      passos.push("Responda com educação e sem discutir (a resposta sugerida abaixo), e chame o cliente no WhatsApp para resolver. Cliente bem atendido costuma mudar a nota.");
    }
    if (x && x.precisa_humano) passos.push("Antes de responder: " + (x.motivo_humano || "uma pessoa da equipe precisa ler e decidir."));
    if (!passos.length) return null;
    return h("div", { class: "plano-avaliacao" }, h("strong", { text: "O que eu faria" }), h("ol", { class: "lista-simples" }, passos.map(p => h("li", { text: p }))));
  }
  const seloStatus = st => { const [n, c] = NOME_STATUS[st] || [st, ""]; return selo(n, c); };
  let cacheMarcas = null;
  async function marcas(forcar) {
    if (!forcar && cacheMarcas && cacheMarcas.org === estado.org.id) return cacheMarcas.lista;
    const l = (await mk("marcas")).marcas || [];
    cacheMarcas = { org: estado.org.id, lista: l };
    return l;
  }
  function seletorMarca(lista, valor, comTodas) {
    return h("select", { class: "entrada", "aria-label": "Marca" }, comTodas ? h("option", { value: "", text: "Todas as marcas" }) : null, lista.map(m => h("option", { value: m.id, selected: String(m.id) === String(valor), text: m.nome })));
  }
  function avisoIa(cfg) {
    return cfg && !cfg.ia_ligada ? h("div", { class: "nota nota-alerta" }, "A criação com IA está desligada: falta colar a chave da OpenAI. ", h("a", { href: "#/integracoes", text: "Colar a chave agora →" })) : null;
  }
  function semMarcas(el) {
    el.appendChild(h("div", { class: "cartao vidro" }, vazio("Cadastre a primeira marca", "Cada marca tem o seu Instagram, Facebook e Google. A Central pode cuidar de várias marcas.", ICONES.foguete),
      h("div", { class: "acoes", style: "justify-content:center" }, h("a", { class: "btn btn-primario", href: "#/marcas" }, "Cadastrar marca"))));
  }

  // Painel "Criar com IA": posts da semana (com as artes) e imagens avulsas.
  // Aparece no Estúdio, no Instagram, no Facebook e no Google.
  function criadorIA(lista, cfg, canalFixo, recarregar) {
    if (!pode("AGENTE") || !lista.length) return null;
    const canaisPadrao = canalFixo ? [canalFixo] : ["instagram", "facebook"];
    const marcaSemana = seletorMarca(lista, estado.marcaCriador || (lista[0] && lista[0].id));
    const marcaImg = seletorMarca(lista, estado.marcaCriador || (lista[0] && lista[0].id));
    [marcaSemana, marcaImg].forEach(sel => sel.addEventListener("change", () => { estado.marcaCriador = sel.value; }));
    const semana = h("select", { class: "entrada" }, h("option", { value: "0", text: "Esta semana" }), h("option", { value: "7", text: "Próxima semana", selected: true }), h("option", { value: "14", text: "Daqui a 2 semanas" }));
    const qtd = h("input", { class: "entrada", type: "number", min: "1", max: "14", value: (cfg && cfg.posts_semana) || 3 });
    const canais = h("div", { class: "checks-linha" }, ["instagram", "facebook", "google"].map(c => h("label", {}, h("input", { type: "checkbox", value: c, checked: canaisPadrao.includes(c) }), NOME_CANAL[c])));
    const comArtes = h("input", { type: "checkbox", checked: true });
    const progresso = h("p", { class: "nota oculto" });
    const criarSemana = botao("✦ Criar posts da semana com IA", async (_e, b) => {
      const escolhidos = [...canais.querySelectorAll("input:checked")].map(i => i.value);
      if (!escolhidos.length) { aviso("Marque pelo menos um canal.", "erro"); return; }
      const inicio = isoLocal(somarDias(segundaDe(new Date()), Number(semana.value)));
      b.textContent = "Criando os posts… (até 1 minuto)";
      progresso.classList.remove("oculto"); progresso.textContent = "A DENIA está planejando a semana e escrevendo as legendas.";
      try {
        const r = await mk("ia/semana", { metodo: "POST", corpo: { marca_id: marcaSemana.value, inicio, quantidade: qtd.value, canais: escolhidos } });
        let artes = 0, parado = false;
        if (comArtes.checked) {
          for (const [i, c] of r.criados.entries()) {
            if (await pontoDoPiloto()) { parado = true; break; }
            b.textContent = `Criando as artes… ${i + 1} de ${r.criados.length}`;
            progresso.textContent = `Criando a arte do post ${i + 1} de ${r.criados.length}. Cada arte leva de 1 a 2 minutos: a DENIA cria em alta qualidade e confere o texto.`;
            try { await mk("ia/imagem", { metodo: "POST", corpo: { post_id: c.id } }); artes++; } catch (e) { aviso(e.message, "erro"); break; }
          }
        }
        estado.resultadoCriador = { criados: r.criados.length, artes, parado };
        aviso(`${r.criados.length} post(s) criados${artes ? ` com ${artes} arte(s)` : ""}${r.modo === "AUTOMATICO" ? ", revisados pela IA" : " — aguardando aprovação"}.`, "ok");
        estado.semanaCalendario = inicio; atualizarAprovacoes();
        if (!piloto.ativo) recarregar ? recarregar() : (location.hash = "#/calendario");
      } catch (e) { estado.resultadoCriador = { erro: e.message }; aviso(e.message, "erro"); }
      finally { b.textContent = "✦ Criar posts da semana com IA"; progresso.classList.add("oculto"); }
    }, "btn-primario");
    const ideia = h("textarea", { class: "entrada", maxlength: "1000", placeholder: "Ex.: técnico sorrindo consertando uma geladeira numa cozinha clara, com o texto \"Orçamento grátis hoje\"", style: "min-height:90px" });
    const formatoImg = h("select", { class: "entrada" }, h("option", { value: "post", text: "Quadrada (feed e Google)" }), h("option", { value: "story", text: "Vertical (story e reels)" }));
    const resultado = h("div", { class: "criador-resultado" });
    const criarImagem = botao("✦ Criar imagem com IA", async (_e, b) => {
      if (!ideia.value.trim()) { aviso("Descreva a imagem que a DENIA deve criar.", "erro"); ideia.focus(); return; }
      b.textContent = "Criando e conferindo a imagem… (até 2 minutos)";
      try {
        const r = await mk("ia/imagem", { metodo: "POST", corpo: { marca_id: marcaImg.value, ideia: ideia.value, formato: formatoImg.value } });
        avisoConferencia(r.conferencia);
        const url = `/api/orgs/${estado.org.id}/mk/midias/${r.midia_id}`;
        resultado.replaceChildren(h("img", { class: "post-arte-img", src: url, alt: "Imagem criada pela DENIA" }),
          h("div", { class: "acoes" }, h("a", { class: "btn btn-secundario btn-pequeno", href: url, download: `denia-imagem-${r.midia_id}.jpg` }, "Baixar imagem"),
            botao("Usar num novo post", async () => {
              const corpo = { marca_id: marcaImg.value, canais: canaisPadrao, formato: formatoImg.value, data: isoLocal(new Date()), hora: "18:00", ideia_imagem: ideia.value, midia_id: r.midia_id };
              try { const n = await mk("posts", { metodo: "POST", corpo }); editorPost({ ...corpo, id: n.id, status: "RASCUNHO" }, lista, recarregar || (() => navegar())); } catch (e) { aviso(e.message, "erro"); }
            }, "btn-primario btn-pequeno")));
        aviso("Imagem criada.", "ok");
      } catch (e) { aviso(e.message, "erro"); } finally { b.textContent = "✦ Criar imagem com IA"; }
    }, "btn-primario");
    const novo = botao("+ Novo post", () => editorPost({ data: isoLocal(new Date()), marca_id: marcaSemana.value, canais: canaisPadrao, formato: canalFixo === "google" ? "google" : "post", hora: "18:00" }, lista, recarregar || (() => navegar())), "btn-secundario");
    const nomeCanal = canalFixo ? NOME_CANAL[canalFixo] : "as redes sociais";
    return h("section", { class: "grade grade-2 criador" },
      h("div", { class: "cartao vidro formulario criador-cartao" }, h("h3", { style: "margin:0", text: `Posts da semana para ${nomeCanal}` }),
        h("p", { style: "margin:0;color:var(--texto-2);font-size:14px", text: "A DENIA planeja a semana, escreve legendas e hashtags e cria a arte de cada post. Tudo vai para Aprovações (ou é aprovado sozinho, no modo automático)." }),
        avisoIa(cfg),
        h("div", { class: "linha-form" }, campo("Marca", marcaSemana), campo("Semana", semana), campo("Quantidade", qtd)),
        h("div", { class: "campo" }, h("label", { text: "Canais" }), canais),
        h("label", { class: "check-linha" }, comArtes, "Criar também as imagens (artes) de cada post"),
        progresso, h("div", { class: "acoes" }, criarSemana, novo)),
      h("div", { class: "cartao vidro formulario criador-cartao" }, h("h3", { style: "margin:0", text: "Criar imagem com IA" }),
        h("p", { style: "margin:0;color:var(--texto-2);font-size:14px", text: "Descreva a arte e a DENIA cria a imagem com as cores da marca, pronta para baixar ou virar um post." }),
        h("div", { class: "linha-form" }, campo("Marca", marcaImg), campo("Formato", formatoImg)),
        campo("O que a imagem deve mostrar", ideia),
        h("div", { class: "acoes" }, criarImagem), resultado));
  }

  // Gaveta lateral (editor de post, formulários longos).
  let fecharGaveta = null;
  function gaveta(titulo, conteudo) {
    const g = $("gaveta");
    $("gaveta-titulo").textContent = titulo;
    $("gaveta-corpo").replaceChildren(...[].concat(conteudo));
    g.classList.remove("oculto");
    const fim = () => { g.classList.add("oculto"); document.removeEventListener("keydown", tecla); fecharGaveta = null; };
    const tecla = e => { if (e.key === "Escape") fim(); };
    $("gaveta-fechar").onclick = fim;
    g.onclick = e => { if (e.target === g) fim(); };
    document.addEventListener("keydown", tecla);
    fecharGaveta = fim;
    return fim;
  }

  async function paginaEstudio(el, _p, vivo) {
    el.appendChild(h("section", { class: "boas-vindas" }, h("div", { class: "orbe" }), selo("Estúdio de Marketing", "info"),
      h("h2", { text: "Conteúdo de todas as marcas, criado e aprovado num só lugar." }),
      h("p", { text: "A DENIA planeja a semana, escreve as legendas, cria as artes e revisa tudo. Você decide se uma pessoa aprova cada arte ou se a IA aprova sozinha." }),
      h("div", { class: "acoes" }, h("a", { class: "btn btn-primario", href: "#/calendario" }, "Abrir calendário"), h("a", { class: "btn btn-secundario", href: "#/aprovacoes" }, "Ver aprovações"))));
    const metricas = h("section", { class: "grade grade-4" }, [1, 2, 3, 4].map(() => h("div", { class: "esqueleto" })));
    const baixo = h("section", { class: "grade grade-2" });
    el.append(metricas, baixo);
    let r, cfg, lista;
    try { [r, cfg, lista] = await Promise.all([mk("resumo"), mk("config"), marcas(true)]); }
    catch (e) { if (vivo()) falha(metricas, e); return; }
    if (!vivo()) return;
    metricas.replaceChildren(metrica("Marcas", numero(r.marcas), "com Instagram, Facebook e Google"), metrica("Aguardando aprovação", numero(r.aguardando), "artes e legendas"),
      metrica("Prontos para publicar", numero(r.aprovados), "aprovados"), metrica("Posts nesta semana", numero(r.semana), "no calendário"));
    const modo = h("div", { class: "opcoes-modo" },
      [["HUMANO", "Uma pessoa aprova", "Cada arte criada pela IA espera a aprovação de alguém da equipe antes de publicar."], ["AUTOMATICO", "A IA aprova sozinha", "A DENIA revisa cada arte e aprova sozinha as que passam da nota mínima. As outras esperam uma pessoa."]]
        .map(([v, t, d]) => h("label", { class: "opcao-modo" + (cfg.modo === v ? " ativo" : "") }, h("input", { type: "radio", name: "modo", value: v, checked: cfg.modo === v, disabled: !pode("ADMIN") }), h("strong", { text: t }), h("span", { text: d }))));
    modo.addEventListener("change", () => modo.querySelectorAll(".opcao-modo").forEach(l => l.classList.toggle("ativo", l.querySelector("input").checked)));
    const qtd = h("input", { class: "entrada", type: "number", min: "1", max: "14", value: cfg.posts_semana, readOnly: !pode("ADMIN") });
    const nota = h("input", { class: "entrada", type: "number", min: "5", max: "10", value: cfg.nota_minima, readOnly: !pode("ADMIN") });
    baixo.replaceChildren(
      h("section", { class: "cartao vidro formulario" }, h("h3", { style: "margin:0", text: "Aprovação das artes" }), modo,
        h("div", { class: "linha-form" }, campo("Posts por semana, por marca", qtd), campo("Nota mínima para aprovar sozinha (0 a 10)", nota)),
        pode("ADMIN") ? h("div", { class: "acoes" }, botao("Salvar", async () => {
          try { await mk("config", { metodo: "POST", corpo: { modo: modo.querySelector("input:checked").value, posts_semana: qtd.value, nota_minima: nota.value } }); aviso("Configuração salva.", "ok"); }
          catch (e) { aviso(e.message, "erro"); }
        }, "btn-primario")) : null),
      h("section", { class: "cartao vidro formulario" }, h("h3", { style: "margin:0", text: "Falar com a DENIA" }),
        h("p", { style: "margin:0;color:var(--texto-2);font-size:14px", text: "Peça por voz: \"DENIA, quantos posts estão esperando aprovação?\" ou \"Me dá ideias de posts para esta semana\"." }),
        h("div", { class: "acoes" }, h("a", { class: "btn btn-primario", href: "#/denia" }, "🎙 Conversar por voz"))));
    el.appendChild(criadorIA(lista, cfg, null, null) || h("span"));
    el.appendChild(h("section", { class: "grade grade-3" },
      passoInicial("01", "Marcas", "Cadastre cada marca com o tom de voz, o público e as contas de Instagram, Facebook e Google.", "#/marcas"),
      passoInicial("02", "Calendário", "Veja a semana de cada marca, crie posts e gere as artes com IA.", "#/calendario"),
      passoInicial("03", "Google Meu Negócio", "Avaliações respondidas, palavras-chave e desempenho semanal de cada perfil.", "#/google")));
  }

  async function paginaCalendario(el, _p, vivo) {
    const lista = await marcas(true);
    if (!vivo()) return;
    if (!lista.length) { el.appendChild(cabeca("Calendário de conteúdo", "")); semMarcas(el); return; }
    let inicio = segundaDe(estado.semanaCalendario ? new Date(estado.semanaCalendario + "T12:00:00") : new Date());
    const filtro = seletorMarca(lista, estado.marcaCalendario || "", true);
    const titulo = h("strong", { class: "semana-titulo" });
    const grade = h("div", { class: "semana" });
    const desenhar = async () => {
      estado.semanaCalendario = isoLocal(inicio);
      const fim = somarDias(inicio, 6);
      titulo.textContent = `${dataCurta(isoLocal(inicio))} a ${dataCurta(isoLocal(fim))}`;
      grade.replaceChildren(carregando());
      let posts;
      try { posts = (await mk(`posts?de=${isoLocal(inicio)}&ate=${isoLocal(fim)}${filtro.value ? "&marca=" + filtro.value : ""}`)).posts || []; }
      catch (e) { falha(grade, e); return; }
      const hoje = isoLocal(new Date());
      grade.replaceChildren(...DIAS.map((nome, i) => {
        const dia = isoLocal(somarDias(inicio, i));
        const doDia = posts.filter(p => p.data === dia);
        return h("section", { class: "dia vidro" + (dia === hoje ? " hoje" : "") },
          h("div", { class: "dia-cabeca" }, h("span", { text: nome }), h("b", { text: dataCurta(dia) })),
          doDia.map(p => cartaoPost(p, lista, desenhar)),
          pode("AGENTE") ? h("button", { class: "dia-novo", type: "button", onclick: () => editorPost({ data: dia, marca_id: filtro.value || lista[0].id, canais: ["instagram", "facebook"], formato: "post", hora: "18:00" }, lista, desenhar) }, "+ Novo post") : null);
      }));
    };
    filtro.addEventListener("change", () => { estado.marcaCalendario = filtro.value; desenhar(); });
    el.appendChild(cabeca("Calendário de conteúdo", "A semana de cada marca. Clique num post para editar, criar a arte com IA ou aprovar.",
      botao("‹", () => { inicio = somarDias(inicio, -7); desenhar(); }, "btn-secundario btn-pequeno", { "aria-label": "Semana anterior" }), titulo,
      botao("›", () => { inicio = somarDias(inicio, 7); desenhar(); }, "btn-secundario btn-pequeno", { "aria-label": "Próxima semana" }),
      botao("Esta semana", () => { inicio = segundaDe(new Date()); desenhar(); }, "btn-secundario btn-pequeno"), filtro,
      pode("AGENTE") ? botao("Criar semana com IA", async (_e, b) => {
        const alvo = filtro.value || lista[0].id;
        if (!filtro.value && lista.length > 1 && !(await modal({ titulo: "Criar a semana para qual marca?", conteudo: `Será criada para "${lista[0].nome}". Para outra marca, escolha no filtro antes.`, confirmar: "Criar" }))) return;
        b.textContent = "Criando…";
        try { const r = await mk("ia/semana", { metodo: "POST", corpo: { marca_id: alvo, inicio: isoLocal(inicio) } }); aviso(`${r.criados.length} post(s) criados.`, "ok"); desenhar(); }
        catch (e) { aviso(e.message, "erro"); } finally { b.textContent = "Criar semana com IA"; }
      }, "btn-primario btn-pequeno") : null));
    el.appendChild(grade);
    await desenhar();
  }

  function avisoConferencia(c) {
    if (c && !c.correto) aviso(`A revisão da arte encontrou um problema: ${c.problemas} Clique de novo em Criar arte para refazer.`, "erro");
    else aviso(c ? "Arte criada e conferida." : "Arte criada.", "ok");
  }
  function miniatura(p, classe) {
    return p.midia_id ? h("img", { class: classe || "post-img", src: `/api/orgs/${estado.org.id}/mk/midias/${p.midia_id}`, alt: "", loading: "lazy" }) : null;
  }
  function cartaoPost(p, lista, recarregar) {
    const marca = lista.find(m => m.id === p.marca_id);
    return h("button", { class: "post-cartao", type: "button", onclick: () => editorPost(p, lista, recarregar) },
      miniatura(p),
      h("span", { class: "post-meta", text: `${p.hora || "--:--"} · ${NOME_FORMATO[p.formato] || p.formato}${marca && lista.length > 1 ? " · " + marca.nome : ""}` }),
      h("strong", { text: p.titulo || "(sem título)" }),
      h("span", { class: "post-canais" }, p.canais.map(c => h("i", { class: "canal-" + c, text: NOME_CANAL[c] }))),
      seloStatus(p.status));
  }

  function editorPost(p, lista, recarregar) {
    const ent = (v, extra = {}) => h("input", { class: "entrada", value: v || "", ...extra });
    const marca = seletorMarca(lista, p.marca_id);
    const canais = h("div", { class: "checks-linha" }, ["instagram", "facebook", "google"].map(c => h("label", {}, h("input", { type: "checkbox", value: c, checked: (p.canais || []).includes(c) }), NOME_CANAL[c])));
    const formato = h("select", { class: "entrada" }, Object.entries(NOME_FORMATO).map(([k, n]) => h("option", { value: k, selected: k === p.formato, text: n })));
    const data = ent(p.data, { type: "date" }), hora = ent(p.hora, { type: "time" });
    const tituloP = ent(p.titulo, { maxlength: "200" });
    const legenda = h("textarea", { class: "entrada", value: p.legenda || "", maxlength: "2200", style: "min-height:160px" });
    const hashtags = ent(p.hashtags, { maxlength: "600" }), chamada = ent(p.chamada, { maxlength: "200" });
    const ideia = h("textarea", { class: "entrada", value: p.ideia_imagem || "", maxlength: "1000", style: "min-height:90px" });
    const textoArte = ent(p.texto_arte, { maxlength: "80", placeholder: "Ex.: Orçamento grátis hoje (deixe vazio para arte sem texto)" });
    const imagem = h("div", { class: "post-arte" }, miniatura(p, "post-arte-img") || h("span", { text: "Sem arte ainda" }));
    let pub = {};
    try { pub = typeof p.publicacao === "string" ? JSON.parse(p.publicacao || "{}") : (p.publicacao || {}); } catch { pub = {}; }
    const publicacao = h("div", { class: "publicacao" }, pub.aviso ? h("p", { class: "nota nota-alerta", text: pub.aviso }) : null,
      ["instagram", "facebook"].filter(c => pub[c]).map(c => pub[c].id
        ? h("p", { class: "nota" }, `${NOME_CANAL[c]}: publicado `, pub[c].link ? h("a", { href: pub[c].link, target: "_blank", rel: "noopener noreferrer", text: "ver post" }) : null)
        : h("p", { class: "nota nota-alerta", text: `${NOME_CANAL[c]}: ${pub[c].erro}` })));
    const revisao = h("div", {}, p.revisao ? h("p", { class: "nota" + (p.revisao.nota >= 8 ? "" : " nota-alerta"), text: `Revisão da IA: nota ${p.revisao.nota}/10 — ${p.revisao.comentario}` }) : null, p.comentario ? h("p", { class: "nota nota-alerta", text: "Comentário: " + p.comentario }) : null);
    const dados = () => ({ id: p.id, marca_id: marca.value, canais: [...canais.querySelectorAll("input:checked")].map(i => i.value), formato: formato.value, data: data.value, hora: hora.value, titulo: tituloP.value, legenda: legenda.value, hashtags: hashtags.value, chamada: chamada.value, texto_arte: textoArte.value, ideia_imagem: ideia.value });
    const salvar = async (silencioso) => { const r = await mk("posts", { metodo: "POST", corpo: dados() }); p.id = r.id; if (!silencioso) aviso("Post salvo.", "ok"); return r.id; };
    const acao = async (a, extra = {}) => { await salvar(true); const r = await mk(`posts/${p.id}/acao`, { metodo: "POST", corpo: { acao: a, ...extra } }); fechar(); recarregar && recarregar(); atualizarAprovacoes(); return r; };
    const editar = pode("AGENTE") && p.status !== "PUBLICADO";
    const botoes = h("div", { class: "acoes" },
      editar ? botao("Salvar", async () => { try { await salvar(); recarregar && recarregar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-primario") : null,
      editar && ["RASCUNHO", "REJEITADO"].includes(p.status || "RASCUNHO") ? botao("Enviar para aprovação", async () => { try { await acao("enviar"); aviso("Enviado para aprovação.", "ok"); } catch (e) { aviso(e.message, "erro"); } }) : null,
      pode("ADMIN") && p.id && ["AGUARDANDO", "RASCUNHO", "REJEITADO"].includes(p.status) ? botao("Aprovar", async (_e, b) => { b.textContent = "Aprovando…"; try { const r = await acao("aprovar"); aviso(r.resumo || "Post aprovado.", r.resumo && /falhou/.test(r.resumo) ? "erro" : "ok"); } catch (e) { aviso(e.message, "erro"); } finally { b.textContent = "Aprovar"; } }, "btn-primario") : null,
      pode("ADMIN") && p.id && p.status === "AGUARDANDO" ? botao("Pedir ajuste", async () => {
        const motivo = h("textarea", { class: "entrada", placeholder: "O que precisa mudar?", maxlength: "400" });
        if (!(await modal({ titulo: "Pedir ajuste", conteudo: [motivo], confirmar: "Enviar" }))) return;
        try { await acao("rejeitar", { comentario: motivo.value }); aviso("Ajuste pedido.", "ok"); } catch (e) { aviso(e.message, "erro"); }
      }) : null,
      pode("AGENTE") && p.status === "APROVADO" && p.id ? botao("Publicar agora", async (_e, b) => {
        b.textContent = "Publicando…";
        try {
          await salvar(true);
          const r = await mk(`posts/${p.id}/publicar`, { metodo: "POST", corpo: {} });
          aviso(r.resumo, "ok"); fechar(); recarregar && recarregar();
        } catch (e) { aviso(e.message, "erro"); } finally { b.textContent = "Publicar agora"; }
      }, "btn-primario") : null,
      pode("AGENTE") && p.status === "APROVADO" ? botao("Marcar como publicado", async () => { try { await acao("publicado"); aviso("Marcado como publicado.", "ok"); } catch (e) { aviso(e.message, "erro"); } }) : null,
      botao("Copiar legenda", () => copiar([legenda.value, hashtags.value].filter(Boolean).join("\n\n")), "btn-secundario"),
      p.midia_id ? h("a", { class: "btn btn-secundario", href: `/api/orgs/${estado.org.id}/mk/midias/${p.midia_id}`, download: `denia-post-${p.id}.jpg` }, "Baixar arte") : null,
      pode("ADMIN") && p.id ? botao("Excluir", async () => { if (!(await modal({ titulo: "Excluir este post?", conteudo: "A arte também é apagada.", confirmar: "Excluir", perigo: true }))) return; try { await mk(`posts/${p.id}/acao`, { metodo: "POST", corpo: { acao: "excluir" } }); fechar(); recarregar && recarregar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-perigo") : null);
    const ia = editar ? h("div", { class: "acoes ia-acoes" },
      botao("✦ Escrever com IA", async (_e, b) => {
        const tema = h("input", { class: "entrada", value: tituloP.value, placeholder: "Ex.: dica de manutenção do ar-condicionado no verão" });
        if (!(await modal({ titulo: "Sobre o que é o post?", conteudo: [tema], confirmar: "Escrever" }))) return;
        b.textContent = "Escrevendo…";
        try {
          const r = (await mk("ia/legenda", { metodo: "POST", corpo: { marca_id: marca.value, tema: tema.value, formato: formato.value, canal: (dados().canais[0] || "instagram") } })).sugestao;
          tituloP.value = r.titulo; legenda.value = r.legenda; hashtags.value = r.hashtags; chamada.value = r.chamada; textoArte.value = r.texto_arte || ""; ideia.value = r.ideia_imagem;
          aviso("Texto criado. Revise e salve.", "ok");
        } catch (e) { aviso(e.message, "erro"); } finally { b.textContent = "✦ Escrever com IA"; }
      }),
      botao("✦ Criar arte com IA", async (_e, b) => {
        b.textContent = "Criando e conferindo a arte… (até 2 minutos)";
        try {
          await salvar(true);
          const r = await mk("ia/imagem", { metodo: "POST", corpo: { post_id: p.id, ideia: ideia.value, texto_arte: textoArte.value } });
          p.midia_id = r.midia_id;
          imagem.replaceChildren(miniatura(p, "post-arte-img"));
          avisoConferencia(r.conferencia); recarregar && recarregar();
        } catch (e) { aviso(e.message, "erro"); } finally { b.textContent = "✦ Criar arte com IA"; }
      }),
      botao("✦ Revisar com IA", async (_e, b) => {
        b.textContent = "Revisando…";
        try { await salvar(true); const r = await mk(`posts/${p.id}/acao`, { metodo: "POST", corpo: { acao: "revisar" } }); revisao.replaceChildren(h("p", { class: "nota" + (r.revisao.nota >= 8 ? "" : " nota-alerta"), text: `Revisão da IA: nota ${r.revisao.nota}/10 — ${r.revisao.comentario}` })); }
        catch (e) { aviso(e.message, "erro"); } finally { b.textContent = "✦ Revisar com IA"; }
      })) : null;
    const fechar = gaveta(p.id ? `Post #${p.id}` : "Novo post", [
      h("div", { class: "sugestao-topo" }, p.status ? seloStatus(p.status) : selo("Novo"), p.aprovado_por ? h("span", { class: "selo", text: "Aprovado por " + p.aprovado_por }) : null, p.criado_por ? h("span", { class: "selo", text: "Criado por " + p.criado_por }) : null),
      publicacao, revisao, ia,
      h("div", { class: "editor-grade" },
        h("div", { class: "formulario" },
          h("div", { class: "linha-form" }, campo("Marca", marca), campo("Formato", formato)),
          h("div", { class: "campo" }, h("label", { text: "Canais" }), canais),
          h("div", { class: "linha-form" }, campo("Data", data), campo("Horário", hora)),
          campo("Título (interno)", tituloP), campo("Legenda", legenda), campo("Hashtags", hashtags), campo("Chamada para ação", chamada), campo("Texto escrito na arte", textoArte, "A DENIA escreve exatamente isto na arte e confere a ortografia."), campo("Ideia da arte (a cena)", ideia)),
        h("div", { class: "formulario" }, h("label", { style: "font-weight:600;color:var(--texto-2);font-size:14px", text: "Arte" }), imagem,
          h("p", { class: "nota", text: "Com a marca conectada (Marcas → Conectar Instagram e Facebook), os posts aprovados saem sozinhos no dia e horário marcados. Sem conexão, baixe a arte e copie a legenda para publicar." }))),
      botoes]);
  }

  async function paginaAprovacoes(el, _p, vivo) {
    el.appendChild(cabeca("Aprovações", "Artes e legendas esperando uma decisão. Aprove, peça ajuste ou edite antes de aprovar."));
    const area = h("div", { class: "grade" }, carregando());
    el.appendChild(area);
    let posts, lista;
    try { [posts, lista] = await Promise.all([mk("posts?status=AGUARDANDO").then(r => r.posts || []), marcas(true)]); }
    catch (e) { if (vivo()) falha(area, e); return; }
    if (!vivo()) return;
    if (!posts.length) { area.replaceChildren(h("div", { class: "cartao vidro" }, vazio("Nada para aprovar agora", "Quando a IA ou a equipe criar posts, eles aparecem aqui.", ICONES.caixa))); return; }
    area.replaceChildren(h("div", { class: "aprovacoes" }, posts.map(p => {
      const marca = lista.find(m => m.id === p.marca_id);
      return h("article", { class: "aprovacao vidro" }, miniatura(p, "aprovacao-img") || h("div", { class: "aprovacao-img aprovacao-sem", text: "Sem arte" }),
        h("div", { class: "aprovacao-corpo" },
          h("div", { class: "sugestao-topo" }, h("strong", { text: p.titulo || "(sem título)" }), h("span", { class: "selo", text: (marca ? marca.nome + " · " : "") + `${dataCurta(p.data)} ${p.hora || ""}` })),
          h("p", { class: "aprovacao-legenda", text: p.legenda || "" }),
          p.revisao ? h("p", { class: "evidencia", text: `Revisão da IA: ${p.revisao.nota}/10 — ${p.revisao.comentario}` }) : null,
          h("div", { class: "acoes" },
            pode("ADMIN") ? botao("Aprovar", async (_e, b) => { b.textContent = "Aprovando…"; try { const r = await mk(`posts/${p.id}/acao`, { metodo: "POST", corpo: { acao: "aprovar" } }); aviso(r.resumo || "Aprovado.", r.resumo && /falhou/.test(r.resumo) ? "erro" : "ok"); navegar(); atualizarAprovacoes(); } catch (e) { aviso(e.message, "erro"); b.textContent = "Aprovar"; } }, "btn-primario btn-pequeno") : null,
            botao("Abrir e editar", () => editorPost(p, lista, () => navegar()), "btn-secundario btn-pequeno"))));
    })));
  }

  // Conexão com o Instagram e o Facebook (API oficial da Meta), por marca.
  let cacheMeta = null;
  async function estadoMeta(forcar) {
    if (!forcar && cacheMeta && cacheMeta.org === estado.org.id && Date.now() - cacheMeta.em < 30000) return cacheMeta.d;
    const d = await mk("meta/estado").catch(e => ({ configurada: false, contas: [], erro: e.message }));
    cacheMeta = { org: estado.org.id, em: Date.now(), d };
    return d;
  }
  const contaDa = (meta, marcaId) => (meta.contas || []).find(c => String(c.marca_id) === String(marcaId)) || null;
  async function conectarMeta(marca) {
    const meta = await estadoMeta(true);
    if (meta.erro) { aviso(meta.erro, "erro"); return; }
    if (meta.configurada === false && meta.faltando && meta.faltando.length) {
      await modal({ titulo: "Falta configurar a Meta", soInformar: true, conteudo: [
        `Na Cloudflare, no Worker denia-landing, falta: ${meta.faltando.join(" e ")}.`,
        "Vá em Workers e Pages → denia-landing → Settings → Variables and Secrets → Add, escolha o tipo Secret, crie com o nome exato e clique em Deploy. Depois volte aqui e clique em Conectar de novo."] });
      return;
    }
    if (!meta.configurada) {
      await modal({ titulo: "Falta configurar a Meta", soInformar: true, conteudo: [
        "Para a DENIA publicar sozinha, a plataforma precisa do aplicativo da Meta (é feito uma vez só):",
        "1. Em developers.facebook.com, crie um app do tipo Empresa ligado ao portfólio empresarial da Central.",
        "2. Adicione os produtos Login do Facebook para Empresas e API do Instagram, e informe as páginas de privacidade, termos e exclusão de dados do site.",
        "3. Na Cloudflare, no Worker denia-landing, crie os secrets META_APP_ID e META_APP_SECRET (e META_CONFIG_ID, se usar o Login do Facebook para Empresas).",
        "4. Volte aqui e clique em Conectar Instagram e Facebook."] });
      return;
    }
    location.href = `/api/orgs/${estado.org.id}/mk/meta/conectar?marca=${marca.id}`;
  }
  // Busca dentro de uma lista longa de opções (páginas da Meta, perfis do Google): esconde o que não combina.
  function filtroDaLista(lista, dica) {
    const busca = h("input", { class: "entrada", type: "search", placeholder: dica, "aria-label": dica });
    const sem = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    busca.addEventListener("input", () => {
      const q = sem(busca.value.trim());
      lista.querySelectorAll(".opcao-pagina").forEach(op => { op.classList.toggle("oculto", Boolean(q) && !sem(op.textContent).includes(q)); });
    });
    setTimeout(() => busca.focus(), 50);
    return busca;
  }
  async function escolherPaginaMeta(nonce) {
    let d;
    try { d = await mk(`meta/paginas?n=${encodeURIComponent(nonce)}`); }
    catch (e) { aviso(e.message, "erro"); location.hash = "#/marcas"; return; }
    const opcoes = h("div", { class: "lista-saude lista-rolavel" }, d.paginas.map((p, i) => h("label", { class: "opcao-pagina" },
      h("input", { type: "radio", name: "pagina-meta", value: p.id, checked: i === 0 }),
      h("span", {}, h("strong", { text: p.nome }), h("span", { class: "sub", text: p.ig_usuario ? `Instagram @${p.ig_usuario}` : "Sem Instagram profissional ligado a esta página" })))));
    if (!(await modal({ titulo: "Qual página é desta marca?", conteudo: [...(d.paginas.length > 6 ? [filtroDaLista(opcoes, `Procurar entre as ${d.paginas.length} páginas`)] : []), opcoes], confirmar: "Conectar" }))) { location.hash = "#/marcas"; return; }
    const escolhida = opcoes.querySelector("input:checked");
    try {
      const r = await mk("meta/escolher", { metodo: "POST", corpo: { n: nonce, pagina_id: escolhida && escolhida.value } });
      aviso(r.instagram ? `Conectado: ${r.pagina} · @${r.instagram}` : `Conectado: ${r.pagina}`, "ok");
      cacheMeta = null; cacheMarcas = null;
    } catch (e) { aviso(e.message, "erro"); }
    location.hash = "#/marcas";
  }

  // Conexão com o Google Perfil da Empresa (Google Meu Negócio), por marca.
  let cacheGoogle = null;
  async function estadoGoogle(forcar) {
    if (!forcar && cacheGoogle && cacheGoogle.org === estado.org.id && Date.now() - cacheGoogle.em < 30000) return cacheGoogle.d;
    const d = await mk("google/estado").catch(e => ({ configurada: false, contas: [], erro: e.message }));
    cacheGoogle = { org: estado.org.id, em: Date.now(), d };
    return d;
  }
  const contaGoogleDa = (g, marcaId) => (g.contas || []).find(c => String(c.marca_id) === String(marcaId)) || null;
  async function conectarGoogle(marca) {
    const g = await estadoGoogle(true);
    if (g.erro) { aviso(g.erro, "erro"); return; }
    if (!g.configurada) {
      await modal({ titulo: "Falta configurar o Google", soInformar: true, conteudo: [
        `Na Cloudflare, no Worker denia-landing, falta: ${(g.faltando || ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]).join(" e ")}.`,
        "No Google Cloud, crie o cliente OAuth (Aplicativo da Web) com o URI de redirecionamento do site terminado em /api/google/retorno. Depois, na Cloudflare, vá em Workers e Pages → denia-landing → Settings → Variables and Secrets → Add, escolha o tipo Secret, crie com o nome exato e clique em Deploy."] });
      return;
    }
    location.href = `/api/orgs/${estado.org.id}/mk/google/conectar?marca=${marca.id}`;
  }
  async function escolherLocalGoogle(nonce) {
    let d;
    try { d = await mk(`google/locais?n=${encodeURIComponent(nonce)}`); }
    catch (e) { aviso(e.message, "erro"); location.hash = "#/marcas"; return; }
    const opcoes = h("div", { class: "lista-saude lista-rolavel" }, d.locais.map((l, i) => h("label", { class: "opcao-pagina" },
      h("input", { type: "radio", name: "local-google", value: l.id, checked: i === 0 }),
      h("span", {}, h("strong", { text: l.titulo }), h("span", { class: "sub", text: l.endereco || "Perfil sem endereço (atende na região)" })))));
    if (!(await modal({ titulo: "Qual perfil do Google é desta marca?", conteudo: [...(d.locais.length > 6 ? [filtroDaLista(opcoes, `Procurar entre os ${d.locais.length} perfis (nome ou endereço)`)] : []), opcoes], confirmar: "Conectar" }))) { location.hash = "#/marcas"; return; }
    const escolhido = opcoes.querySelector("input:checked");
    try {
      const r = await mk("google/escolher", { metodo: "POST", corpo: { n: nonce, local_id: escolhido && escolhido.value } });
      const s = r.sincronizacao || {};
      aviso(`Google conectado: ${r.perfil}.${s.avaliacoes_total != null ? ` ${s.avaliacoes_total} avaliação(ões) trazidas do perfil.` : ""}`, "ok");
      cacheGoogle = null; cacheMarcas = null;
    } catch (e) { aviso(e.message, "erro"); }
    location.hash = "#/marcas";
  }

  async function paginaMarcas(el, param, vivo) {
    if (String(param || "").startsWith("meta-")) { escolherPaginaMeta(String(param).slice(5)); }
    if (String(param || "").startsWith("google-")) { escolherLocalGoogle(String(param).slice(7)); }
    el.appendChild(cabeca("Marcas", "Cada marca tem o seu tom de voz, o seu público e as suas contas. A Central pode cuidar de quantas marcas precisar.", pode("ADMIN") ? botao("Nova marca", () => formMarca({}), "btn-primario") : null));
    const area = h("div", { class: "grade grade-3" }, carregando());
    el.appendChild(area);
    let lista, meta, goo;
    try { [lista, meta, goo] = await Promise.all([marcas(true), estadoMeta(true), estadoGoogle(true)]); } catch (e) { if (vivo()) falha(area, e); return; }
    if (!vivo()) return;
    if (!lista.length) { area.replaceChildren(); semMarcas(el); return; }
    area.replaceChildren(...lista.map(m => {
      const conta = contaDa(meta, m.id), contaG = contaGoogleDa(goo, m.id);
      return h("article", { class: "cartao vidro marca-cartao" },
        h("div", { class: "marca-topo" }, m.logo_midia_id ? h("img", { class: "empresa-avatar marca-logo", src: `/api/orgs/${estado.org.id}/mk/midias/${m.logo_midia_id}`, alt: "" }) : h("span", { class: "empresa-avatar", text: iniciais(m.nome) }), h("div", {}, h("h3", { style: "margin:0", text: m.nome }), h("span", { class: "sub", text: [m.segmento, m.cidade].filter(Boolean).join(" · ") || "—" }))),
        h("ul", { class: "lista-saude" },
          h("li", {}, "Instagram", conta && conta.ig_usuario ? selo(`Conectado · @${conta.ig_usuario}`, "ok") : m.instagram ? h("span", { class: "selo", text: "@" + m.instagram }) : selo("Não informado", "alerta")),
          h("li", {}, "Facebook", conta ? selo(`Conectado · ${String(conta.pagina_nome || "").slice(0, 24)}`, "ok") : m.facebook ? h("span", { class: "selo", text: m.facebook.slice(0, 28) }) : selo("Não informado", "alerta")),
          h("li", {}, "Google Meu Negócio", contaG ? selo(`Conectado · ${String(contaG.local_titulo || "").slice(0, 24)}`, "ok") : m.google ? h("span", { class: "selo", text: m.google.slice(0, 28) }) : selo("Não informado", "alerta"))),
        conta ? h("p", { class: "nota", text: "Publicação automática ligada: os posts aprovados saem sozinhos no dia e horário do calendário." })
          : h("p", { class: "nota nota-alerta", text: "Ainda não conectada: a DENIA cria e aprova os posts, mas não publica sozinha." }),
        pode("ADMIN") ? h("div", { class: "acoes", style: "margin-top:14px" },
          conta ? botao("Desconectar", async () => { if (!(await modal({ titulo: `Desconectar ${m.nome}?`, conteudo: "A DENIA para de publicar sozinha nesta marca.", confirmar: "Desconectar", perigo: true }))) return; try { await mk("meta/desconectar", { metodo: "POST", corpo: { marca_id: m.id } }); cacheMeta = null; navegar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-secundario btn-pequeno")
            : botao("Conectar Instagram e Facebook", () => conectarMeta(m), "btn-primario btn-pequeno"),
          contaG ? botao("Desconectar Google", async () => { if (!(await modal({ titulo: `Desconectar o Google de ${m.nome}?`, conteudo: "A DENIA para de publicar e de buscar avaliações no perfil do Google desta marca.", confirmar: "Desconectar", perigo: true }))) return; try { await mk("google/desconectar", { metodo: "POST", corpo: { marca_id: m.id } }); cacheGoogle = null; navegar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-secundario btn-pequeno")
            : botao("Conectar Google", () => conectarGoogle(m), "btn-primario btn-pequeno"),
          botao("Editar", () => formMarca(m), "btn-secundario btn-pequeno"),
          botao("Remover", async () => { if (!(await modal({ titulo: `Remover ${m.nome}?`, conteudo: "Os posts já criados continuam guardados.", confirmar: "Remover", perigo: true }))) return; await mk(`marcas/${m.id}/remover`, { metodo: "POST", corpo: {} }); navegar(); }, "btn-perigo btn-pequeno")) : null);
    }));
  }
  const IDIOMAS_CONTEUDO = [["pt-BR", "Português (Brasil)"], ["en", "English"], ["es", "Español"], ["de", "Deutsch"], ["it", "Italiano"], ["fr", "Français"], ["ja", "日本語"], ["hi", "हिन्दी"]];
  function formMarca(m) {
    const c = {};
    const linha = (k, rot, ph, area) => { c[k] = area ? h("textarea", { class: "entrada", value: m[k] || "", placeholder: ph || "", style: "min-height:80px" }) : h("input", { class: "entrada", value: m[k] || "", placeholder: ph || "" }); return campo(rot, c[k]); };
    const fechar = gaveta(m.id ? "Editar marca" : "Nova marca", [h("div", { class: "formulario" },
      h("div", { class: "linha-form" }, linha("nome", "Nome da marca"), linha("segmento", "Segmento", "Ex.: assistência técnica")),
      h("div", { class: "linha-form" }, linha("cidade", "Cidade / região", "Ex.: Rio de Janeiro — Zona Sul"), linha("whatsapp", "WhatsApp", "Ex.: (21) 99999-9999")),
      h("div", { class: "linha-form" }, linha("instagram", "Instagram", "@perfil"), linha("facebook", "Página do Facebook", "Endereço da página"), linha("google", "Perfil no Google", "Nome ou link do perfil")),
      h("div", { class: "linha-form" }, linha("site", "Site", "https://"), linha("cores", "Cores da marca", "Ex.: azul-marinho e dourado"),
        campo("Idioma do conteúdo", c.idioma = h("select", { class: "entrada" }, IDIOMAS_CONTEUDO.map(([v, n]) => h("option", { value: v, text: n, selected: (m.idioma || (m.id ? "pt-BR" : IDIOMA)) === v }))))),
      linha("tom", "Tom de voz", "Ex.: próximo, acolhedor, sem gírias"), linha("publico", "Público", "Quem são os clientes", true), linha("diferenciais", "Diferenciais", "O que a marca faz melhor que os concorrentes", true),
      campo("Produtos, serviços e ofertas para divulgar", c.ofertas = h("textarea", { class: "entrada", value: m.ofertas || "", maxlength: "1500", style: "min-height:100px", placeholder: "Ex.: Conserto de geladeira com garantia de 90 dias; visita técnica grátis no bairro; peças originais. Promoção: 10% no Pix até sexta." }), "Quanto mais detalhes reais (produtos, preços, promoções, garantias), mais as legendas vendem. A IA nunca inventa preço ou promoção."),
      campo("Dias e horários preferidos para publicar", c.horarios = h("input", { class: "entrada", value: m.horarios || "", maxlength: "200", placeholder: "Ex.: segunda, quarta e sexta às 18h, sábado às 10h" }), "A IA monta a semana só nesses dias e horários. Você ainda pode mudar a data e a hora de cada post."),
      m.id ? campoLogo(m) : h("p", { class: "nota", text: "A logo da marca é enviada logo depois de salvar (o campo aparece na sequência)." }),
      h("div", { class: "acoes" }, botao("Salvar marca", async () => {
        try { const corpo = { id: m.id }; Object.keys(c).forEach(k => { corpo[k] = c[k].value; }); const r = await mk("marcas", { metodo: "POST", corpo }); fechar(); cacheMarcas = null; navegar();
          // Marca nova: reabre já com o campo da logo, para enviar na hora.
          if (!m.id && r.id) { aviso("Marca salva. Agora envie a logo da marca.", "ok"); formMarca({ ...corpo, id: r.id }); } else aviso("Marca salva.", "ok"); }
        catch (e) { aviso(e.message, "erro"); }
      }, "btn-primario")))]);
  }

  // Logo oficial: vai junto para a IA em toda arte. O navegador reduz a imagem antes de enviar.
  async function logoReduzida(arquivo) {
    const img = await createImageBitmap(arquivo);
    for (const lado of [1024, 768, 512]) {
      const k = Math.min(1, lado / Math.max(img.width, img.height));
      const tela = document.createElement("canvas");
      tela.width = Math.round(img.width * k); tela.height = Math.round(img.height * k);
      tela.getContext("2d").drawImage(img, 0, 0, tela.width, tela.height);
      const url = tela.toDataURL("image/png");
      if (url.length < 1800000) return url;
    }
    throw new Error("A logo é grande demais. Envie um arquivo menor (até 1 MB).");
  }
  function campoLogo(m) {
    const previa = h("div", { class: "logo-previa" }, m.logo_midia_id ? h("img", { src: `/api/orgs/${estado.org.id}/mk/midias/${m.logo_midia_id}`, alt: "Logo da marca" }) : h("span", { text: "Sem logo" }));
    const arquivo = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", class: "oculto" });
    arquivo.addEventListener("change", async () => {
      const f = arquivo.files && arquivo.files[0];
      if (!f) return;
      try {
        const dados = await logoReduzida(f);
        await mk(`marcas/${m.id}/logo`, { metodo: "POST", corpo: { dados } });
        previa.replaceChildren(h("img", { src: dados, alt: "Logo da marca" }));
        cacheMarcas = null;
        aviso("Logo salva. As próximas artes já saem com ela.", "ok");
      } catch (e) { aviso(e.message, "erro"); }
      arquivo.value = "";
    });
    return h("div", { class: "campo" }, h("label", { text: "Logo da marca" }),
      h("div", { class: "logo-linha" }, previa,
        h("div", { class: "acoes" }, botao(m.logo_midia_id ? "Trocar logo" : "Enviar logo", () => arquivo.click(), "btn-secundario btn-pequeno"),
          m.logo_midia_id ? botao("Remover", async () => { try { await mk(`marcas/${m.id}/logo`, { metodo: "POST", corpo: { remover: true } }); previa.replaceChildren(h("span", { text: "Sem logo" })); cacheMarcas = null; } catch (e) { aviso(e.message, "erro"); } }, "btn-secundario btn-pequeno") : null)),
      arquivo,
      h("p", { class: "dica", style: "margin:0;font-size:13px;color:var(--texto-3)", text: "De preferência PNG com fundo transparente. A IA aplica esta logo em todas as artes, sem redesenhar." }));
  }

  // ----- Canais Instagram e Facebook
  // ----- Instagram e Facebook: visão geral com números, publicações, comentários, agenda, concorrentes e conexão
  const METRICAS_IG = [["alcance", "Alcance", "Contas diferentes que viram o conteúdo"], ["visualizacoes", "Visualizações", "Vezes que o conteúdo foi visto"], ["contas_engajadas", "Contas engajadas", "Pessoas que interagiram"], ["interacoes", "Interações", "Curtidas, comentários, salvamentos, compartilhamentos e respostas"],
    ["curtidas", "Curtidas", ""], ["comentarios", "Comentários", ""], ["compartilhamentos", "Compartilhamentos", ""], ["salvamentos", "Salvamentos", "Quem guardou para ver depois"], ["cliques_link", "Cliques no perfil", "Toques no link, telefone, e-mail ou endereço"], ["novos_seguidores", "Novos seguidores", "Nos últimos 30 dias do período (limite da Meta)"]];
  const METRICAS_FB = [["visualizacoes", "Visualizações", "Vezes que o conteúdo da página foi visto"], ["alcance", "Alcance", "Pessoas diferentes alcançadas"], ["interacoes", "Interações nas publicações", ""], ["acoes_na_pagina", "Ações na página", "Cliques em ligar, rotas, site e botões"], ["visitas_pagina", "Visitas à página", ""], ["novos_seguidores", "Novos seguidores", ""], ["deixaram_de_seguir", "Deixaram de seguir", ""], ["seguidores", "Seguidores (total)", ""]];
  const NOME_METRICA_MIDIA = { reach: "Alcance", views: "Visualizações", likes: "Curtidas", comments: "Comentários", shares: "Compartilhamentos", saved: "Salvamentos", total_interactions: "Interações", profile_visits: "Visitas ao perfil", follows: "Seguidores ganhos", replies: "Respostas", navigation: "Navegação", ig_reels_avg_watch_time: "Tempo médio assistido (ms)", ig_reels_video_view_total_time: "Tempo total assistido (ms)", post_impressions_unique: "Alcance", post_media_view: "Visualizações", post_clicks: "Cliques" };
  const NOME_TIPO_COMENTARIO = { ELOGIO: ["Elogio", "ok"], DUVIDA: ["Dúvida", "info"], INTERESSE: ["Quer comprar", "ok"], RECLAMACAO: ["Reclamação", "alerta"], SPAM: ["Spam", "alerta"], OFENSIVO: ["Ofensivo", "alerta"], OUTRO: ["Outro", "info"] };
  const NOME_ACAO_COMENTARIO = { RESPONDER: "Responder", OCULTAR: "Ocultar", APAGAR: "Apagar", LEVAR_PARA_PRIVADO: "Responder e levar para o privado" };
  const ls = { ler(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } }, gravar(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem espaço */ } } };
  const dataHoraCurta = v => { const d = new Date(v); return isNaN(d) ? "" : fmtDataHora.format(d); };

  async function paginaCanalSocial(el, canal, vivo, aba) {
    const nome = NOME_CANAL[canal];
    const lista = await marcas(true);
    if (!vivo()) return;
    el.appendChild(cabeca(nome, canal === "instagram" ? "Perfil, números, publicações, comentários, agenda e concorrentes de cada marca — tudo pela API oficial da Meta." : "Página, números, publicações, comentários e agenda de cada marca — tudo pela API oficial da Meta."));
    if (!lista.length) { semMarcas(el); return; }
    const meta = await estadoMeta(true);
    if (!vivo()) return;
    const abas = [["visao", "Visão geral"], ["publicacoes", "Publicações"], ["comentarios", "Comentários"], ["agenda", "Agenda e criação"], ...(canal === "instagram" ? [["concorrentes", "Concorrentes"]] : []), ["conexao", "Conexão"]];
    const chaveMarca = canal === "instagram" ? "marcaInstagram" : "marcaFacebook";
    const sel = seletorMarca(lista, estado[chaveMarca] || lista[0].id);
    sel.addEventListener("change", () => { estado[chaveMarca] = sel.value; navegar(); });
    const marcaId = sel.value, marca = lista.find(m => String(m.id) === String(marcaId));
    const conta = contaDa(meta, marcaId);
    const pronta = conta && (canal === "facebook" || conta.ig_id);
    const atual = abas.some(a => a[0] === aba) ? aba : (pronta ? "visao" : "conexao");
    el.appendChild(h("div", { class: "pagina-cabeca" }, h("div", { class: "abas", role: "tablist" }, abas.map(([k, n]) => h("a", { class: "aba" + (k === atual ? " ativo" : ""), href: `#/${canal}/${k}`, role: "tab" }, n))), h("div", { style: "min-width:220px" }, sel)));
    const area = h("div", { class: "grade" }, carregando());
    el.appendChild(area);
    const precisaConexao = () => trocar(area, h("div", { class: "cartao vidro" }, vazio(conta ? "Esta página não tem um Instagram profissional ligado" : `${marca.nome} ainda não está conectada`, conta ? "Ligue o Instagram profissional à página do Facebook (Meta Business Suite → Configurações → Contas do Instagram) e conecte de novo." : "Conecte em Conexão para ver os números, as publicações e os comentários."),
      h("div", { class: "acoes", style: "justify-content:center" }, h("a", { class: "btn btn-primario", href: `#/${canal}/conexao` }, "Ir para Conexão"))));
    try {
      if (atual === "conexao") return abaConexaoSocial(area, canal, lista, meta);
      if (atual === "agenda") return await abaAgendaSocial(area, canal, lista);
      if (!pronta) return precisaConexao();
      if (atual === "visao") await abaVisaoSocial(area, canal, marcaId);
      else if (atual === "publicacoes") await abaPublicacoesSocial(area, canal, marcaId);
      else if (atual === "comentarios") await abaComentariosSocial(area, canal, marcaId);
      else if (atual === "concorrentes") await abaConcorrentes(area, marcaId);
    } catch (e) { falha(area, e); }
  }

  async function abaVisaoSocial(area, canal, marcaId) {
    const f = estado.socialVisao = estado.socialVisao || { dias: "30", metrica: "alcance" };
    const [perf, ins] = await Promise.all([mk(`social/perfil?marca=${marcaId}&canal=${canal}`), mk(`social/insights?marca=${marcaId}&canal=${canal}&dias=${f.dias}`).catch(e => ({ erro: e.message }))]);
    const p = perf.perfil || {};
    const recarregar = () => abaVisaoSocial(area, canal, marcaId).catch(e => falha(area, e));
    const cabecaPerfil = h("section", { class: "cartao vidro perfil-social" },
      p.foto ? h("img", { src: p.foto, alt: "", class: "perfil-foto", width: "72", height: "72", loading: "lazy" }) : null,
      h("div", { class: "perfil-texto" }, h("h3", { style: "margin:0", text: p.nome || p.usuario || "" }), p.usuario ? h("span", { class: "sub", text: "@" + p.usuario }) : p.categoria ? h("span", { class: "sub", text: p.categoria }) : null,
        p.bio ? h("p", { style: "margin:6px 0 0;white-space:pre-line", text: p.bio }) : null, p.link ? h("a", { href: p.link, target: "_blank", rel: "noopener", text: canal === "instagram" ? "Abrir no Instagram ↗" : "Abrir no Facebook ↗" }) : null),
      h("div", { class: "perfil-numeros" }, [[p.seguidores, "seguidores"], canal === "instagram" ? [p.publicacoes, "publicações"] : [p.curtidas, "curtidas"], canal === "instagram" ? [p.seguindo, "seguindo"] : [p.nota, `nota (${numero(p.avaliacoes || 0)})`]].filter(([v]) => v != null).map(([v, n]) => h("div", {}, h("strong", { text: typeof v === "number" && !Number.isInteger(v) ? String(v).replace(".", ",") : numero(v) }), h("span", { text: n })))));
    const periodo = h("section", { class: "cartao vidro filtros-desempenho" }, h("div", { class: "abas abas-chips", role: "group", "aria-label": "Período" },
      [["7", "7 dias"], ["30", "30 dias"], ["60", "60 dias"], ["90", "90 dias"], ["180", "6 meses"], ["365", "12 meses"]].map(([v, n]) => h("button", { type: "button", class: "aba" + (f.dias === v ? " ativo" : ""), "aria-pressed": f.dias === v ? "true" : "false", onclick: () => { f.dias = v; trocar(area, carregando()); recarregar(); } }, n))));
    if (ins.erro) { trocar(area, cabecaPerfil, periodo, h("section", { class: "cartao vidro" }, h("p", { class: "nota nota-alerta", text: ins.erro }))); return; }
    const t = ins.totais || {}, ta = ins.anterior ? ins.anterior.totais : null;
    const lista = (canal === "instagram" ? METRICAS_IG : METRICAS_FB).filter(([k]) => t[k] != null);
    const cartoes = h("section", { class: "grade grade-4" }, lista.map(([k, n, ajuda]) => {
      const v = ta && ta[k] != null && k !== "seguidores" ? variacaoPct(t[k] || 0, ta[k] || 0) : null;
      return h("div", { class: "metrica vidro", title: ajuda }, h("span", { text: n }), h("strong", { text: numero(t[k] || 0) }), h("small", {}, v ? h("span", { class: v.zero ? "" : v.sobe ? "sobe" : "desce", text: v.texto + " " }) : null, ta && k !== "seguidores" ? `vs ${numero(ta[k] || 0)} antes` : ajuda));
    }));
    const series = [["alcance", "Alcance por dia"], ["novos_seguidores", "Novos seguidores por dia"], ...(canal === "facebook" ? [["visualizacoes", "Visualizações por dia"]] : [])].filter(([k]) => (ins.diario || []).some(d => d[k]));
    if (!series.some(s => s[0] === f.metrica) && series.length) f.metrica = series[0][0];
    const pontos = agruparSerie(ins.diario || [], (ins.diario || []).length <= 92 ? "dia" : "semana", f.metrica);
    const grafico = h("section", { class: "cartao vidro" },
      h("div", { class: "cabeca-grafico" }, h("h3", { style: "margin:0", text: (series.find(s => s[0] === f.metrica) || ["", "Dia a dia"])[1] }),
        series.length > 1 ? h("div", { class: "abas abas-chips" }, series.map(([k, n]) => h("button", { type: "button", class: "aba" + (f.metrica === k ? " ativo" : ""), onclick: () => { f.metrica = k; recarregar(); } }, n))) : null),
      pontos.some(x => x.valor) ? graficoLinha(pontos, null, (series.find(s => s[0] === f.metrica) || ["", ""])[1], "") : vazio("Sem números dia a dia neste período", "A Meta pode levar até 48 h para liberar os números."));
    const NOMES_PUB = { city: "Cidades", country: "Países", age: "Idade", gender: "Gênero" };
    const pub = ins.publico || {};
    const blocoPublico = Object.values(pub).some(x => x && x.length) ? h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "Quem segue a marca" }),
      h("div", { class: "grade grade-2" }, Object.entries(NOMES_PUB).filter(([k]) => (pub[k] || []).length).map(([k, n]) => {
        const tot = pub[k].reduce((s, x) => s + x.valor, 0) || 1;
        return h("div", {}, h("h4", { style: "margin:0 0 8px", text: n }), pub[k].slice(0, 8).map(x => h("div", { class: "limite-linha" }, h("span", { text: k === "gender" ? ({ F: "Mulheres", M: "Homens", U: "Não informado" }[x.nome] || x.nome) : x.nome }), h("div", { class: "barra-parte barra-limite" }, h("i", { style: `width:${Math.round((x.valor / tot) * 100)}%` })), h("strong", { text: `${Math.round((x.valor / tot) * 100)}%` }))));
      }))) : canal === "instagram" ? h("section", { class: "cartao vidro" }, h("p", { class: "sub", text: "O público (cidade, idade, gênero) aparece quando o perfil tem pelo menos 100 seguidores." })) : null;
    trocar(area, cabecaPerfil, periodo,
      h("p", { class: "sub", text: `${dataCompleta(ins.de)} a ${dataCompleta(ins.ate)}${ins.anterior ? ` · comparando com ${dataCompleta(ins.anterior.de)} a ${dataCompleta(ins.anterior.ate)}` : ""}` }),
      cartoes, grafico, blocoPublico,
      (ins.indisponiveis || []).length ? h("p", { class: "sub", text: "Alguns números não foram liberados pela Meta para esta conta. Se faltar quase tudo, conecte a marca de novo para aceitar as permissões de números (insights)." }) : null);
  }

  async function abaPublicacoesSocial(area, canal, marcaId) {
    const f = estado.socialPubs = estado.socialPubs || { tipo: "TODOS", ordem: "recentes" };
    let itens = [], proximo = null;
    const grade = h("div", { class: "grade-midias" });
    const mais = h("div", { class: "acoes", style: "justify-content:center" });
    const desenhar = () => {
      let vis = itens.filter(i => f.tipo === "TODOS" || i.tipo === f.tipo);
      if (f.ordem === "melhores") vis = vis.slice().sort((a, b) => ((b.curtidas || 0) + (b.comentarios || 0) * 3) - ((a.curtidas || 0) + (a.comentarios || 0) * 3));
      trocar(grade, ...(vis.length ? vis.map(cartaoMidia) : [vazio("Nenhuma publicação deste tipo", "")]));
      trocar(mais, proximo ? botao("Carregar mais publicações", carregar, "btn-secundario") : null);
    };
    const cartaoMidia = i => {
      const numeros = h("div", { class: "midia-numeros" });
      return h("article", { class: "cartao vidro midia-cartao" },
        i.imagem ? h("img", { src: i.imagem, alt: "", loading: "lazy", class: "midia-img" }) : h("div", { class: "midia-img midia-sem", text: i.tipo }),
        h("div", { class: "midia-corpo" }, h("div", { class: "midia-topo" }, selo(i.tipo, "info"), h("span", { class: "sub", text: dataHoraCurta(i.quando) })),
          h("p", { class: "midia-texto", text: i.texto ? i.texto.slice(0, 180) + (i.texto.length > 180 ? "…" : "") : "(sem legenda)" }),
          h("div", { class: "midia-stats" }, h("span", { text: `♥ ${i.curtidas == null ? "—" : numero(i.curtidas)}` }), h("span", { text: `💬 ${i.comentarios == null ? "—" : numero(i.comentarios)}` }), i.compartilhamentos != null ? h("span", { text: `↗ ${numero(i.compartilhamentos)}` }) : null),
          numeros,
          h("div", { class: "acoes" }, botao("Ver números", async (_e, b) => { b.textContent = "Lendo…"; try { const r = await mk(`social/midias/${encodeURIComponent(i.id)}?marca=${marcaId}&canal=${canal}&tipo=${encodeURIComponent(i.tipo)}`); const m = r.metricas || {};
            trocar(numeros, ...(Object.keys(m).length ? Object.entries(m).filter(([, v]) => typeof v === "number").map(([k, v]) => h("div", {}, h("strong", { text: numero(v) }), h("span", { text: NOME_METRICA_MIDIA[k] || k }))) : [h("span", { class: "sub", text: "A Meta não liberou números para esta publicação." })])); b.remove(); } catch (e) { aviso(e.message, "erro"); b.textContent = "Ver números"; } }, "btn-secundario btn-pequeno"),
            i.link ? h("a", { class: "btn btn-secundario btn-pequeno", href: i.link, target: "_blank", rel: "noopener" }, "Abrir ↗") : null)));
    };
    async function carregar() {
      const r = await mk(`social/midias?marca=${marcaId}&canal=${canal}${proximo ? "&depois=" + encodeURIComponent(proximo) : ""}`);
      itens = itens.concat(r.itens || []); proximo = r.proximo; desenhar();
    }
    const tipos = canal === "instagram" ? [["TODOS", "Todas"], ["FOTO", "Fotos"], ["CARROSSEL", "Carrosséis"], ["REELS", "Reels"], ["VÍDEO", "Vídeos"]] : [["TODOS", "Todas"], ["FOTO", "Com foto"], ["VÍDEO", "Vídeos"], ["TEXTO", "Só texto"]];
    const filtros = h("section", { class: "cartao vidro filtros-desempenho" }, h("div", { class: "linha-filtros" },
      h("div", { class: "abas abas-chips" }, tipos.map(([k, n]) => h("button", { type: "button", class: "aba" + (f.tipo === k ? " ativo" : ""), onclick: e => { f.tipo = k; e.target.parentNode.querySelectorAll(".aba").forEach(x => x.classList.toggle("ativo", x === e.target)); desenhar(); } }, n))),
      h("select", { class: "entrada entrada-pequena", "aria-label": "Ordem", onchange: e => { f.ordem = e.target.value; desenhar(); } }, [["recentes", "Mais recentes"], ["melhores", "Melhor desempenho primeiro"]].map(([v, n]) => h("option", { value: v, selected: f.ordem === v, text: n })))));
    await carregar();
    trocar(area, filtros, grade, mais);
  }

  async function abaComentariosSocial(area, canal, marcaId) {
    const f = estado.socialCom = estado.socialCom || { filtro: "SEM_RESPOSTA" };
    const r = await mk(`social/comentarios?marca=${marcaId}&canal=${canal}`);
    const todos = r.comentarios || [];
    const lista = h("div", { class: "grade" });
    const contagem = { SEM_RESPOSTA: todos.filter(c => !c.respondido && !c.oculto).length, TODOS: todos.length, RESPONDIDOS: todos.filter(c => c.respondido).length, OCULTOS: todos.filter(c => c.oculto).length };
    const filtroDe = c => f.filtro === "TODOS" ? true : f.filtro === "SEM_RESPOSTA" ? !c.respondido && !c.oculto : f.filtro === "RESPONDIDOS" ? c.respondido : c.oculto;
    const cartoes = new Map();
    const cartao = c => {
      const caixa = h("textarea", { class: "entrada", rows: "2", placeholder: "Escreva a resposta pública…" });
      const dica = h("div", {});
      const sugerir = async (b) => {
        if (b) b.textContent = "Pensando…";
        try {
          const s = await mk(`social/comentarios/${encodeURIComponent(c.id)}/sugerir`, { metodo: "POST", corpo: { marca_id: marcaId, canal, comentario: c.texto, autor: c.autor, post: c.post.texto } });
          caixa.value = s.resposta || "";
          const [tn, tt] = NOME_TIPO_COMENTARIO[s.tipo] || ["", "info"];
          trocar(dica, h("p", { class: "sub", style: "margin:4px 0 0" }, selo(tn, tt), " ", `Sugestão: ${NOME_ACAO_COMENTARIO[s.acao] || s.acao}. ${s.motivo || ""}${s.precisa_humano ? " Uma pessoa deve olhar antes." : ""}`));
        } catch (e) { aviso(e.message, "erro"); }
        finally { if (b) b.textContent = "✦ Sugerir com IA"; }
      };
      const el = h("article", { class: "cartao vidro comentario-cartao" + (c.oculto ? " cor-cinza" : !c.respondido ? " cor-amarelo" : " cor-verde") },
        h("div", { class: "midia-topo" }, h("strong", { text: (canal === "instagram" ? "@" : "") + c.autor }), h("span", { class: "sub", text: dataHoraCurta(c.quando) }), c.oculto ? selo("Oculto", "alerta") : c.respondido ? selo("Respondido", "ok") : selo("Sem resposta", "info")),
        h("p", { style: "margin:6px 0", text: c.texto }),
        h("p", { class: "sub", style: "margin:0" }, "Na publicação: ", c.post.link ? h("a", { href: c.post.link, target: "_blank", rel: "noopener", text: (c.post.texto || "ver publicação").slice(0, 90) + " ↗" }) : (c.post.texto || "").slice(0, 90)),
        c.respostas.length ? h("div", { class: "respostas-comentario" }, c.respostas.map(x => h("p", { class: x.da_marca ? "resposta-publicada" : "sub", text: `${x.da_marca ? "Marca" : (canal === "instagram" ? "@" : "") + x.autor}: ${x.texto}` }))) : null,
        pode("AGENTE") ? h("div", { class: "formulario", style: "margin-top:8px" }, caixa, dica,
          h("div", { class: "acoes" },
            botao("✦ Sugerir com IA", (_e, b) => sugerir(b), "btn-secundario btn-pequeno"),
            botao("Publicar resposta", async () => { if (!caixa.value.trim()) return aviso("Escreva a resposta.", "erro"); try { await mk(`social/comentarios/${encodeURIComponent(c.id)}/responder`, { metodo: "POST", corpo: { marca_id: marcaId, canal, texto: caixa.value } }); aviso("Resposta publicada.", "ok"); c.respondido = true; c.respostas.push({ texto: caixa.value, da_marca: true }); el.replaceWith(cartao(c)); } catch (e) { aviso(e.message, "erro"); } }, "btn-primario btn-pequeno"),
            botao(c.oculto ? "Mostrar de novo" : "Ocultar", async () => { try { const x = await mk(`social/comentarios/${encodeURIComponent(c.id)}/ocultar`, { metodo: "POST", corpo: { marca_id: marcaId, canal, ocultar: !c.oculto } }); c.oculto = x.oculto; aviso(c.oculto ? "Comentário ocultado: só a pessoa e os amigos dela veem." : "Comentário visível de novo.", "ok"); el.replaceWith(cartao(c)); } catch (e) { aviso(e.message, "erro"); } }, "btn-secundario btn-pequeno"),
            botao("Apagar", async () => { if (!window.confirm("Apagar este comentário? Não dá para desfazer.")) return; try { await mk(`social/comentarios/${encodeURIComponent(c.id)}/apagar`, { metodo: "POST", corpo: { marca_id: marcaId, canal } }); aviso("Comentário apagado.", "ok"); el.remove(); } catch (e) { aviso(e.message, "erro"); } }, "btn-secundario btn-pequeno"))) : null);
      el.sugerir = () => sugerir(null);
      cartoes.set(c.id, el);
      return el;
    };
    const desenhar = () => { cartoes.clear(); const vis = todos.filter(filtroDe); trocar(lista, ...(vis.length ? vis.map(cartao) : [h("div", { class: "cartao vidro" }, vazio(f.filtro === "SEM_RESPOSTA" ? "Nenhum comentário esperando resposta" : "Nenhum comentário aqui", "A DENIA lê os comentários das 15 publicações mais recentes."))])); };
    const chips = h("div", { class: "abas abas-chips" }, [["SEM_RESPOSTA", "Sem resposta"], ["TODOS", "Todos"], ["RESPONDIDOS", "Respondidos"], ["OCULTOS", "Ocultos"]].map(([k, n]) => h("button", { type: "button", class: "aba" + (f.filtro === k ? " ativo" : ""), onclick: e => { f.filtro = k; chips.querySelectorAll(".aba").forEach(x => x.classList.toggle("ativo", x === e.currentTarget)); desenhar(); } }, `${n} (${numero(contagem[k])})`)));
    const barra = h("section", { class: "cartao vidro filtros-desempenho" }, h("div", { class: "linha-filtros" }, chips,
      pode("AGENTE") && contagem.SEM_RESPOSTA ? botao(`✦ Sugerir respostas para os ${numero(contagem.SEM_RESPOSTA)} sem resposta`, async (_e, b) => {
        const alvo = todos.filter(c => !c.respondido && !c.oculto);
        let n = 0;
        for (const c of alvo) { b.textContent = `Pensando… ${++n} de ${alvo.length}`; const elc = cartoes.get(c.id); if (elc) await elc.sugerir(); }
        b.textContent = "Sugestões prontas: confira e publique";
      }, "btn-primario btn-pequeno") : null,
      botao("Atualizar", () => abaComentariosSocial(area, canal, marcaId).catch(e => falha(area, e)), "btn-secundario btn-pequeno")),
      h("p", { class: "sub", style: "margin:0", text: "Nada é publicado sem um clique seu. Ocultar esconde o comentário de todos, menos de quem escreveu (e dos amigos dele) — ideal para spam e ofensas sem criar briga." }));
    desenhar();
    trocar(area, barra, lista);
  }

  async function abaConcorrentes(area, marcaId) {
    const chave = "denia-concorrentes-" + marcaId;
    const salvos = ls.ler(chave) || [];
    const entrada = h("input", { class: "entrada", placeholder: "@concorrente", "aria-label": "Instagram do concorrente" });
    const resultado = h("div", { class: "grade" });
    const meu = await mk(`social/perfil?marca=${marcaId}&canal=instagram`).then(r => r.perfil).catch(() => null);
    const comparar = async (usuario) => {
      trocar(resultado, carregando("Lendo o perfil público…"));
      try {
        const r = await mk(`social/concorrente?marca=${marcaId}&canal=instagram&usuario=${encodeURIComponent(usuario)}`);
        if (!salvos.includes(r.usuario)) { salvos.unshift(r.usuario); ls.gravar(chave, salvos.slice(0, 12)); }
        const linha = (rotulo, a, b) => h("tr", {}, h("td", { text: rotulo }), h("td", { text: a == null ? "—" : typeof a === "number" ? numero(a) : a }), h("td", { text: b == null ? "—" : typeof b === "number" ? numero(b) : b }));
        trocar(resultado, h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: `${meu ? "@" + meu.usuario : "Sua marca"} × @${r.usuario}` }),
          r.bio ? h("p", { class: "sub", style: "white-space:pre-line", text: r.bio }) : null,
          h("div", { class: "tabela-caixa" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "" }), h("th", { text: meu ? "@" + meu.usuario : "Você" }), h("th", { text: "@" + r.usuario }))),
            h("tbody", {}, linha("Seguidores", meu?.seguidores, r.seguidores), linha("Publicações", meu?.publicacoes, r.publicacoes), linha("Interações médias por post (últimos 12)", null, r.engajamento_medio), linha("Taxa de engajamento", null, r.taxa_engajamento != null ? String(r.taxa_engajamento).replace(".", ",") + "%" : null)))),
          r.posts.length ? [h("h4", { text: "Últimas publicações dele (o que mais funcionou primeiro)" }), h("div", { class: "tabela-caixa" }, h("table", {}, h("thead", {}, h("tr", {}, ["Quando", "Tipo", "Curtidas", "Comentários", "Legenda"].map(t => h("th", { text: t })))),
            h("tbody", {}, r.posts.slice().sort((a, b) => (b.curtidas + b.comentarios) - (a.curtidas + a.comentarios)).map(x => h("tr", {}, h("td", { text: dataCompleta(x.quando) }), h("td", { text: x.tipo }), h("td", { text: numero(x.curtidas) }), h("td", { text: numero(x.comentarios) }), h("td", {}, x.link ? h("a", { href: x.link, target: "_blank", rel: "noopener", text: (x.texto || "abrir").slice(0, 80) + " ↗" }) : x.texto))))))] : null));
      } catch (e) { trocar(resultado, h("section", { class: "cartao vidro" }, h("p", { class: "nota nota-alerta", text: /business|discovery|não encontrad|inesperado|100/i.test(e.message) ? "A Meta só mostra perfis profissionais (empresa ou criador) públicos. Confira o @." : e.message }))); }
    };
    trocar(area, h("section", { class: "cartao vidro formulario" }, h("h3", { style: "margin:0", text: "Comparar com um concorrente" }),
      h("p", { class: "sub", style: "margin:0", text: "Seguidores, frequência e o que mais engaja nos perfis profissionais públicos — pela API oficial (Business Discovery)." }),
      h("div", { class: "linha-form" }, campo("Instagram do concorrente", entrada)),
      h("div", { class: "acoes" }, botao("Comparar", () => entrada.value.trim() ? comparar(entrada.value.trim()) : aviso("Digite o @.", "erro"), "btn-primario"),
        salvos.map(u => botao("@" + u, () => comparar(u), "btn-secundario btn-pequeno")))), resultado);
  }

  async function abaAgendaSocial(area, canal, lista) {
    const cfg = await mk("config").catch(() => null);
    const hoje = isoLocal(new Date());
    const posts = (await mk(`posts?canal=${canal}&de=${hoje}&ate=${isoLocal(somarDias(new Date(), 30))}`).catch(() => ({ posts: [] }))).posts || [];
    trocar(area, criadorIA(lista, cfg, canal, () => navegar()),
      h("section", { class: "cartao vidro" }, h("h3", { text: "Próximas publicações (30 dias)" }),
        posts.length ? h("div", { class: "lista-posts" }, posts.map(p => cartaoPost(p, lista, () => navegar()))) : vazio("Nenhuma publicação programada", "Use \"Criar posts da semana com IA\" acima.", ICONES.caixa)));
  }

  function abaConexaoSocial(area, canal, lista, meta) {
    const campoConta = canal === "instagram" ? "instagram" : "facebook";
    const estadoCanal = (m) => {
      const c = contaDa(meta, m.id);
      if (!c) return pode("ADMIN") ? botao("Conectar", () => conectarMeta(m), "btn-primario btn-pequeno") : selo("Não conectada", "alerta");
      if (canal === "instagram" && !c.ig_id) return selo("Página sem Instagram profissional", "alerta");
      return h("span", { class: "acoes" }, selo("Conectada", "ok"), pode("ADMIN") ? botao("Reconectar", () => conectarMeta(m), "btn-secundario btn-pequeno") : null);
    };
    trocar(area, h("section", { class: "grade grade-2" },
      h("div", { class: "cartao vidro" }, h("h3", { text: "Contas por marca" }),
        h("ul", { class: "lista-saude" }, lista.map(m => { const c = contaDa(meta, m.id); return h("li", {}, h("span", {}, h("strong", { text: m.nome }), h("span", { class: "sub", text: c ? (canal === "instagram" ? (c.ig_usuario ? "@" + c.ig_usuario : "—") : c.pagina_nome) : m[campoConta] ? (canal === "instagram" ? "@" + m.instagram : m.facebook) : "Conta não informada" })), estadoCanal(m)); })),
        h("a", { class: "btn btn-secundario btn-pequeno", href: "#/marcas", style: "margin-top:14px;width:fit-content" }, "Editar contas nas marcas")),
      h("div", { class: "cartao vidro" }, h("h3", { text: "O que a DENIA faz neste canal" }),
        h("ul", { class: "lista-saude" },
          h("li", {}, "Planejar e criar posts, carrosséis, stories e reels", selo("Disponível", "ok")),
          h("li", {}, "Publicar sozinha no horário marcado", selo("Disponível", "ok")),
          h("li", {}, "Números: alcance, visualizações, interações, seguidores e público", selo("Disponível", "ok")),
          h("li", {}, "Comentários: responder com IA, ocultar e apagar", selo("Disponível", "ok")),
          canal === "instagram" ? h("li", {}, "Comparar com concorrentes", selo("Disponível", "ok")) : null,
          h("li", {}, canal === "instagram" ? "Responder o direct" : "Responder o Messenger", selo("Precisa de aprovação da Meta", "info"))))),
      h("section", { class: "cartao vidro" }, h("h3", { text: "Permissões novas" }),
        h("p", { text: "Os números, os comentários e as respostas usam permissões novas. Se a marca foi conectada antes desta versão, clique em Reconectar e aceite tudo na tela da Meta — nada do que já foi publicado muda." }),
        h("p", { class: "sub", text: "Enquanto o app da Meta estiver em modo de desenvolvimento, tudo funciona para quem é administrador do app e das páginas. Para outras empresas usarem, a Meta precisa revisar o app (Análise do app no developers.facebook.com)." })));
  }

  // ----- Google Meu Negócio
  async function paginaGoogle(el, aba, vivo) {
    const lista = await marcas(true);
    if (!vivo()) return;
    el.appendChild(cabeca("Google Meu Negócio", "Reputação, posição nas buscas e desempenho de cada perfil, acompanhados semana a semana."));
    if (!lista.length) { semMarcas(el); return; }
    const abas = [["publicacoes", "Posts e imagens"], ["avaliacoes", "Avaliações"], ["triagem", "Triagem 1★"], ["relatorio", "Relatório"], ["palavras", "Palavras-chave"], ["desempenho", "Desempenho"], ["conexao", "Conexão"]];
    const atual = abas.some(a => a[0] === aba) ? aba : "publicacoes";
    const sel = seletorMarca(lista, estado.marcaGoogle || lista[0].id);
    sel.addEventListener("change", () => { estado.marcaGoogle = sel.value; navegar(); });
    el.appendChild(h("div", { class: "pagina-cabeca" }, h("div", { class: "abas", role: "tablist" }, abas.map(([k, n]) => h("a", { class: "aba" + (k === atual ? " ativo" : ""), href: "#/google/" + k, role: "tab" }, n))), h("div", { style: "min-width:220px" }, sel)));
    const area = h("div", { class: "grade" }, carregando());
    el.appendChild(area);
    const marcaId = sel.value;
    try {
      if (atual === "avaliacoes") await abaAvaliacoes(area, marcaId);
      else if (atual === "relatorio") await abaRelatorio(area, marcaId);
      else if (atual === "triagem") await abaTriagem(area, marcaId);
      else if (atual === "palavras") await abaPalavras(area, marcaId, lista.find(m => String(m.id) === String(marcaId)));
      else if (atual === "desempenho") await abaDesempenho(area, marcaId);
      else if (atual === "publicacoes") {
        const [posts, cfg] = await Promise.all([mk(`posts?canal=google&marca=${marcaId}`).then(r => r.posts || []), mk("config").catch(() => null)]);
        estado.marcaCriador = marcaId;
        area.replaceChildren(criadorIA(lista, cfg, "google", () => navegar()) || "", h("div", { class: "cartao vidro" }, h("h3", { text: "Publicações no perfil do Google" }), h("p", { text: "Novidades, ofertas e eventos aparecem no perfil e nas buscas. A DENIA cria o texto e a imagem; depois da conexão, publica sozinha." }),
          posts.length ? h("div", { class: "lista-posts" }, posts.map(p => cartaoPost(p, lista, () => navegar()))) : vazio("Nenhuma publicação para o Google", "", ICONES.caixa)));
      } else {
        const g = await estadoGoogle(true);
        const marca = lista.find(m => String(m.id) === String(marcaId));
        const c = contaGoogleDa(g, marcaId);
        area.replaceChildren(h("div", { class: "cartao vidro" }, h("h3", { text: c ? `Conectado: ${c.local_titulo}` : "Conectar o perfil" }),
          c ? h("p", { text: `A DENIA publica os posts aprovados neste perfil, traz as avaliações novas de hora em hora e publica as respostas direto no Google.${c.sincronizado_ms ? " Última atualização: " + new Date(c.sincronizado_ms).toLocaleString(LOCALE) + "." : ""}` })
            : h("ol", { class: "passos" }, h("li", {}, "Entre com a conta do Google que é proprietária ou administradora do perfil da empresa."),
              h("li", {}, "Autorize a DENIA e escolha o perfil desta marca."),
              h("li", {}, "Pronto: os posts aprovados saem no perfil, as avaliações chegam sozinhas e as respostas são publicadas no Google.")),
          pode("ADMIN") ? h("div", { class: "acoes" }, c ? botao("Atualizar agora", async (_e, b) => { b.textContent = "Atualizando…"; try { const r = await mk("google/sincronizar", { metodo: "POST", corpo: { marca_id: marcaId } }); aviso(`Atualizado: ${r.avaliacoes_novas} avaliação(ões) nova(s).`, "ok"); navegar(); } catch (e) { aviso(e.message, "erro"); } finally { b.textContent = "Atualizar agora"; } }, "btn-secundario")
            : botao("Conectar Google", () => conectarGoogle(marca), "btn-primario")) : null,
          h("p", { class: "nota nota-alerta", text: "Importante: a DENIA nunca escreve avaliações para o próprio perfil — isso é proibido pelo Google e pode suspender o perfil. Ela pede avaliações aos clientes reais depois de cada atendimento." })));
      }
    } catch (e) { falha(area, e); }
  }
  // Lê o perfil inteiro no Google, em partes de 1.000, mostrando o andamento.
  async function buscarTodasNoGoogle(marcaId, mostrar) {
    let lidas = 0, continuar = false, r;
    for (let volta = 0; volta < 60; volta++) {
      r = await mk("google/sincronizar", { metodo: "POST", corpo: { marca_id: marcaId, continuar } });
      lidas += r.avaliacoes_lidas || 0;
      mostrar(`Lendo o perfil no Google: ${numero(lidas)} de ${numero(r.avaliacoes_total || lidas)} avaliações…`);
      if (r.completo) break;
      continuar = true;
    }
    cacheGoogle = null;
    return { lidas, removidas: (r && r.avaliacoes_removidas) || 0 };
  }
  // Aviso quando a DENIA ainda não tem todas as avaliações que o Google informa.
  const avisoFaltam = c => c && c.total_google != null && Number(c.na_denia) < Number(c.total_google)
    ? h("p", { class: "nota nota-alerta", text: `No Google há ${numero(c.total_google)} avaliações; na DENIA estão ${numero(c.na_denia)}. Faltam ${numero(c.total_google - c.na_denia)}: clique em "Buscar todas no Google" (ou espere: a DENIA completa sozinha, aos poucos). Os números abaixo contam só as que já estão na DENIA.` }) : null;
  // replaceChildren escreve "null" na tela para itens vazios: estas abas montam a lista sem eles.
  const trocar = (el, ...itens) => el.replaceChildren(...itens.flat().filter(x => x != null && x !== false && x !== ""));
  async function abaAvaliacoes(area, marcaId) {
    // Lista paginada e com filtros (perfis com milhares de avaliações); os números do topo contam o perfil inteiro.
    const filtro = estado.filtroAv && estado.filtroAv.marca === String(marcaId) ? estado.filtroAv : (estado.filtroAv = { marca: String(marcaId), filtro: "TODAS", nota: "", busca: "", cor: "" });
    const consulta = pagina => `avaliacoes?marca=${marcaId}&pagina=${pagina}&por_pagina=50&filtro=${filtro.filtro}&nota=${filtro.nota}&cor=${filtro.cor || ""}&busca=${encodeURIComponent(filtro.busca)}`;
    const [primeira, g, cfg] = await Promise.all([mk(consulta(0)), estadoGoogle(true), mk("config").catch(() => ({}))]);
    const progressoAv = h("p", { class: "nota oculto" });
    const lista = primeira.avaliacoes || [], res = primeira.resumo || {};
    const conectada = Boolean(contaGoogleDa(g, marcaId));
    // Como responder: uma pessoa aprova, ou a DENIA responde sozinha (as boas, ou todas menos as graves).
    const modoAuto = h("select", { class: "entrada", disabled: !pode("ADMIN") },
      [["DESLIGADO", "Uma pessoa aprova cada resposta"], ["BOAS", "Responder sozinha as de 4 e 5 estrelas"], ["TODAS", "Responder sozinha todas, menos as graves"]].map(([v, n]) => h("option", { value: v, text: n, selected: (cfg.avaliacoes_auto || "DESLIGADO") === v })));
    modoAuto.addEventListener("change", async () => {
      try { await mk("config/avaliacoes", { metodo: "POST", corpo: { modo: modoAuto.value } }); aviso(modoAuto.value === "DESLIGADO" ? "Pronto: cada resposta espera uma pessoa aprovar." : "Pronto: a DENIA responde sozinha no Google em até 15 minutos. As graves e as suspeitas continuam esperando você.", "ok"); }
      catch (e) { aviso(e.message, "erro"); }
    });
    const autor = h("input", { class: "entrada", placeholder: "Nome de quem avaliou" });
    const nota = h("select", { class: "entrada" }, [5, 4, 3, 2, 1].map(n => h("option", { value: n, text: "★".repeat(n) + " (" + n + ")" })));
    const texto = h("textarea", { class: "entrada", placeholder: "Cole aqui o texto da avaliação", style: "min-height:80px" });
    const media = res.total ? Number(res.media).toFixed(1).replace(".", ",") : "—";
    const lida = a => { try { return JSON.parse(a.analise || "null"); } catch { return null; } };
    const precisaDeVoce = a => { const x = lida(a); return a.status === "PENDENTE" && x && (x.precisa_humano || x.viola_politica); };

    const NOME_SENT = { OTIMA: ["Ótima", "ok"], POSITIVA: ["Positiva", "ok"], NEUTRA: ["Neutra", "info"], NEGATIVA: ["Negativa", "alerta"], GRAVE: ["Grave", "erro"] };
    const blocoAnalise = (x) => x ? h("div", { class: "analise-avaliacao" },
      h("div", { class: "acoes" }, selo(...(NOME_SENT[x.sentimento] || ["—", ""])), (x.temas || []).map(t => h("span", { class: "selo", text: t })), x.urgencia === "ALTA" ? selo("Urgente", "erro") : null),
      x.resumo ? h("p", { class: "nota", text: x.resumo }) : null,
      x.precisa_humano ? h("p", { class: "nota nota-alerta", text: "Precisa de você: " + (x.motivo_humano || "uma pessoa da equipe deve ler e decidir antes de responder.") }) : null,
      x.viola_politica ? h("div", { class: "nota nota-alerta" }, h("strong", { text: "Pode violar as regras do Google" + (x.politica ? ` (${x.politica})` : "") + "." }), h("p", { style: "margin:6px 0 0", text: x.como_remover || "" })) : null) : null;
    const selFiltro = h("select", { class: "entrada" }, [["TODAS", "Todas"], ["PENDENTE", `Sem resposta (${numero(res.pendentes || 0)})`], ["RESPONDIDA", "Respondidas"], ["PRECISAM", `Precisam de você (${numero(res.precisam || 0)})`]].map(([v, n]) => h("option", { value: v, text: n, selected: filtro.filtro === v })));
    const selNota = h("select", { class: "entrada" }, h("option", { value: "", text: "Todas as notas" }), [5, 4, 3, 2, 1].map(n => h("option", { value: n, text: `${"★".repeat(n)} (${numero(res["n" + n] || 0)})`, selected: String(filtro.nota) === String(n) })));
    const campoBusca = h("input", { class: "entrada", type: "search", value: filtro.busca, placeholder: "Procurar por nome ou texto" });
    const selCor = h("select", { class: "entrada" }, [["", "Todas as cores"], ["VERMELHO", `🔴 Vermelhas — precisam de atenção (${numero(res.vermelhas || 0)})`], ["AMARELO", `🟡 Amarelas — neutras ou críticas (${numero(res.amarelas || 0)})`], ["VERDE", `🟢 Verdes — elogios (${numero(res.verdes || 0)})`], ["SEM", `⚪ Ainda não lidas (${numero(res.nao_lidas || 0)})`]].map(([v, n]) => h("option", { value: v, text: n, selected: (filtro.cor || "") === v })));
    const aplicar = () => { Object.assign(filtro, { filtro: selFiltro.value, nota: selNota.value, cor: selCor.value, busca: campoBusca.value.trim() }); navegar(); };
    selFiltro.addEventListener("change", aplicar); selNota.addEventListener("change", aplicar); selCor.addEventListener("change", aplicar);
    campoBusca.addEventListener("keydown", e => { if (e.key === "Enter") aplicar(); });
    const barraFiltros = h("section", { class: "cartao vidro" }, h("div", { class: "linha-form" }, campo("Mostrar", selFiltro), campo("Cor", selCor), campo("Nota", selNota), campo("Buscar", campoBusca)),
      h("p", { class: "nota", style: "margin:8px 0 0", text: `${numero(primeira.encontradas || 0)} avaliação(ões) com esses filtros.` }));
    const listaEl = h("div", { class: "grade" });
    let pagina = 0, carregadas = lista.length;
    const mais = h("div", { class: "acoes", style: "justify-content:center" });
    const atualizarMais = () => mais.replaceChildren(...(carregadas < (primeira.encontradas || 0) ? [botao(`Mostrar mais (${numero(carregadas)} de ${numero(primeira.encontradas)})`, async (_e, b) => {
      b.textContent = "Carregando…";
      try { const r = await mk(consulta(++pagina)); (r.avaliacoes || []).forEach(a => listaEl.appendChild(cartaoAvaliacao(a))); carregadas += (r.avaliacoes || []).length; atualizarMais(); }
      catch (e) { aviso(e.message, "erro"); b.textContent = "Mostrar mais"; }
    }, "btn-secundario")] : []));
    lista.forEach(a => listaEl.appendChild(cartaoAvaliacao(a)));
    atualizarMais();
    trocar(area, 
      h("section", { class: "cartao vidro semaforo" },
        h("div", { class: "semaforo-itens" },
          h("button", { type: "button", class: "semaforo-item sem-vermelho", onclick: () => { filtro.cor = "VERMELHO"; navegar(); } }, h("b", { text: numero(res.vermelhas || 0) }), h("span", { text: "🔴 Vermelhas: graves, pedem uma pessoa ou podem violar regras" })),
          h("button", { type: "button", class: "semaforo-item sem-amarelo", onclick: () => { filtro.cor = "AMARELO"; navegar(); } }, h("b", { text: numero(res.amarelas || 0) }), h("span", { text: "🟡 Amarelas: neutras ou com crítica" })),
          h("button", { type: "button", class: "semaforo-item sem-verde", onclick: () => { filtro.cor = "VERDE"; navegar(); } }, h("b", { text: numero(res.verdes || 0) }), h("span", { text: "🟢 Verdes: elogios" })),
          h("button", { type: "button", class: "semaforo-item sem-cinza", onclick: () => { filtro.cor = "SEM"; navegar(); } }, h("b", { text: numero(res.nao_lidas || 0) }), h("span", { text: "⚪ Ainda não lidas pela IA" }))),
        res.nao_lidas && pode("AGENTE") ? h("div", { class: "acoes", style: "margin-top:10px" }, botao(`✦ Ler as ${numero(res.nao_lidas)} com IA (dar cor e sugerir resposta)`, async (_e, b) => {
          b.disabled = true;
          try {
            for (let volta = 0; volta < 600; volta++) {
              const r = await mk("avaliacoes/analisar-lote", { metodo: "POST", corpo: { marca_id: marcaId } });
              progressoAv.classList.remove("oculto"); progressoAv.textContent = `A IA está lendo as avaliações… faltam ${numero(r.restantes)}. Nada é publicado: ela só classifica e deixa a resposta sugerida.`;
              if (!r.restantes || !r.feitas) break;
            }
            aviso("Leitura concluída.", "ok"); navegar();
          } catch (e) { aviso(e.message, "erro"); } finally { b.disabled = false; }
        }, "btn-primario btn-pequeno"), h("span", { class: "sub", text: "Usa a chave da OpenAI (custo baixo por avaliação)." })) : null),
      h("section", { class: "grade grade-4" }, metrica("Nota média", media, `${numero(res.total || 0)} avaliação(ões) na DENIA${contaGoogleDa(g, marcaId) && contaGoogleDa(g, marcaId).total_google != null ? ` · ${numero(contaGoogleDa(g, marcaId).total_google)} no Google` : ""}`), metrica("Sem resposta", numero(res.pendentes || 0), "responda em até 24 h"), metrica("Precisam de você", numero(res.precisam || 0), "graves ou que podem violar as regras do Google"), metrica("Negativas", numero(res.negativas || 0), "3 estrelas ou menos")),
      conectada ? h("section", { class: "cartao vidro" }, h("p", { style: "margin:0", text: "Perfil conectado: as avaliações do Google chegam sozinhas, a cada 10 minutos. A resposta salva aqui é publicada direto no Google." }),
        h("div", { style: "margin-top:12px;max-width:440px" }, campo("Como responder as avaliações", modoAuto, "No modo automático, a DENIA lê cada avaliação, escreve a resposta no jeito da empresa e publica. Graves, suspeitas de violar as regras do Google e as que pedem contato nunca saem sozinhas: ficam aqui e você recebe o aviso.")),
        contaGoogleDa(g, marcaId) && contaGoogleDa(g, marcaId).erro ? h("p", { class: "nota nota-alerta", text: "Última tentativa com o Google falhou: " + contaGoogleDa(g, marcaId).erro }) : null,
        avisoFaltam(contaGoogleDa(g, marcaId)), progressoAv,
        pode("AGENTE") ? h("div", { class: "acoes", style: "margin-top:10px" }, botao("Buscar todas no Google", async (_e, b) => {
          b.textContent = "Buscando no Google…";
          try { const r = await buscarTodasNoGoogle(marcaId, t => { progressoAv.classList.remove("oculto"); progressoAv.textContent = t; }); aviso(`Pronto: ${numero(r.lidas)} avaliações lidas do Google.`, "ok"); navegar(); }
          catch (e) { aviso("O Google recusou a busca: " + e.message, "erro"); } finally { b.textContent = "Buscar todas no Google"; }
        }, "btn-secundario btn-pequeno"), botao("Buscar e responder agora", async (_e, b) => {
          b.textContent = "Buscando no Google…";
          try {
            const r = await mk("google/agora", { metodo: "POST", corpo: { marca_id: marcaId } });
            aviso(r.aviso || `Google: ${r.avaliacoes_total} avaliação(ões) no perfil, ${r.avaliacoes_novas} nova(s). Lidas agora: ${r.analisadas}. Respondidas sozinha: ${r.publicadas}.${r.precisam_de_voce ? ` Precisam de você: ${r.precisam_de_voce}.` : ""}`, r.aviso ? "erro" : "ok");
            cacheGoogle = null; navegar();
          } catch (e) { aviso(e.message, "erro"); cacheGoogle = null; } finally { b.textContent = "Buscar e responder agora"; }
        }, "btn-primario btn-pequeno")) : null) : null,
      pode("AGENTE") && !conectada ? h("section", { class: "cartao vidro formulario" }, h("h3", { style: "margin:0", text: "Registrar avaliação" }),
        h("div", { class: "linha-form" }, campo("Autor", autor), campo("Nota", nota)), campo("Texto", texto),
        h("div", { class: "acoes" }, botao("Registrar", async () => { try { await mk("avaliacoes", { metodo: "POST", corpo: { marca_id: marcaId, autor: autor.value, nota: nota.value, texto: texto.value } }); navegar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-primario"))) : null,
      barraFiltros, lista.length ? listaEl : h("div", { class: "cartao vidro" }, vazio("Nenhuma avaliação com esses filtros", "", ICONES.caixa)), mais);
    function cartaoAvaliacao(a) {
        const resp = h("textarea", { class: "entrada", value: a.resposta || a.resposta_sugerida || "", placeholder: "Resposta da empresa", style: "min-height:80px" });
        const analise = h("div", {}, blocoAnalise(lida(a)));
        const x = lida(a), corCartao = !x ? "cor-cinza" : (x.sentimento === "GRAVE" || x.precisa_humano || x.viola_politica) ? "cor-vermelho" : ["OTIMA", "POSITIVA"].includes(x.sentimento) ? "cor-verde" : "cor-amarelo";
        let tri = null; try { tri = JSON.parse(a.triagem || "null"); } catch { tri = null; }
        const plano = h("div", {}, Number(a.nota) <= 3 ? planoAvaliacao(a, tri, x) : null);
        const botaoPlano = pode("AGENTE") && Number(a.nota) <= 3 && !tri ? botao("✦ O que fazer com esta avaliação?", async (_e, b) => {
          b.textContent = "Analisando…";
          try {
            const r = await mk("avaliacoes/triagem", { metodo: "POST", corpo: { marca_id: marcaId, ids: [a.id], lote: String(Date.now()) } });
            const t = r.resultados && r.resultados[a.id];
            plano.replaceChildren(planoAvaliacao(a, t, x) || h("p", { class: "nota", text: "Sem recomendação agora." })); b.remove();
          } catch (e) { aviso(e.message, "erro"); b.textContent = "✦ O que fazer com esta avaliação?"; }
        }, "btn-primario btn-pequeno") : null;
        return h("article", { class: "sugestao vidro " + corCartao + (precisaDeVoce(a) ? " sugestao-alerta" : "") },
          h("div", { class: "sugestao-topo" }, h("strong", { text: a.autor || "Cliente" }), h("span", { class: "estrelas", text: "★".repeat(a.nota) + "☆".repeat(5 - a.nota) }), a.data ? h("span", { class: "sub", text: dataCompleta(a.data) }) : null, a.status === "RESPONDIDA" ? selo("Respondida", "ok") : selo("Sem resposta", Number(a.nota) <= 3 ? "erro" : "alerta")),
          h("p", { style: "margin:0;color:var(--texto-2)", text: a.texto || "(sem texto)" }), analise, plano, resp,
          pode("AGENTE") ? h("div", { class: "acoes" }, botaoPlano,
            botao("✦ Analisar e sugerir resposta", async (_e, b) => { b.textContent = "Lendo a avaliação…"; try { const r = await mk(`avaliacoes/${a.id}/sugerir`, { metodo: "POST", corpo: {} }); resp.value = r.resposta; analise.replaceChildren(blocoAnalise(r.analise) || ""); } catch (e) { aviso(e.message, "erro"); } finally { b.textContent = "✦ Analisar e sugerir resposta"; } }, "btn-secundario btn-pequeno"),
            botao(a.google_id ? "Publicar resposta no Google" : "Salvar resposta", async () => { try { const r = await mk(`avaliacoes/${a.id}/responder`, { metodo: "POST", corpo: { resposta: resp.value } }); aviso(r.publicada_google ? "Resposta publicada no Google." : "Resposta salva. Publique no Google (ou automaticamente, após a conexão).", "ok"); navegar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-primario btn-pequeno"),
            botao("Copiar", () => copiar(resp.value), "btn-secundario btn-pequeno")) : null);
    }
  }
  // Triagem das avaliações de 1 e 2 estrelas: central de reputação para quem cuida do Google da empresa.
  // Lista completa (paginada), filtros, seleção em lote, respostas (ver, escrever, apagar) e a denúncia guiada.
  async function abaTriagem(area, marcaId) {
    const g = await estadoGoogle(true);
    const conta = contaGoogleDa(g, marcaId), conectada = Boolean(conta);
    const f = estado.filtroTri && estado.filtroTri.marca === String(marcaId) ? estado.filtroTri : (estado.filtroTri = { marca: String(marcaId), nota: "", veredito: "", resposta: "", denuncia: "", busca: "" });
    const consulta = pagina => `avaliacoes?marca=${marcaId}&nota_max=2&pagina=${pagina}&por_pagina=50&nota=${f.nota}&veredito=${f.veredito}&resposta=${f.resposta}&denuncia=${f.denuncia}&busca=${encodeURIComponent(f.busca)}`;
    const primeira = await mk(consulta(0));
    const res = primeira.resumo || {};
    const json_ = v => { try { return JSON.parse(v || "null"); } catch { return null; } };
    const NOME_V = { PROVAVEL_FALSA: ["Provavelmente falsa", "erro"], DUVIDOSA: ["Duvidosa", "alerta"], PARECE_REAL: ["Parece de cliente real", "info"] };
    const selecionadas = new Set();
    const progresso = h("p", { class: "nota oculto" });
    const mostrar = t => { progresso.classList.remove("oculto"); progresso.textContent = t; };

    // Ações gerais
    const buscarTodas = async (_e, b) => {
      b.textContent = "Buscando no Google…";
      try { const r = await buscarTodasNoGoogle(marcaId, mostrar); aviso(`Pronto: ${numero(r.lidas)} avaliações lidas do Google.${r.removidas ? ` ${r.removidas} saíram do perfil (removidas).` : ""}`, "ok"); navegar(); }
      catch (e) { aviso("O Google recusou a busca: " + e.message, "erro"); } finally { b.textContent = "Buscar todas no Google"; }
    };
    const analisar = async (b, ids) => {
      const original = b.textContent; b.disabled = true;
      const lote = String(Date.now());
      try {
        for (let volta = 0; volta < 500; volta++) {
          const r = await mk("avaliacoes/triagem", { metodo: "POST", corpo: { marca_id: marcaId, ids: ids || undefined, refazer: Boolean(ids), lote } });
          mostrar(`Analisando… faltam ${numero(r.restantes)}.${r.base_clientes ? ` Base de clientes: ${numero(r.base_clientes.whatsapp)} contatos do WhatsApp e ${numero(r.base_clientes.cadastro)} do cadastro.` : " Base de clientes indisponível agora: a análise segue com os outros sinais."}`);
          if (!r.restantes || !r.feitas) break;
        }
        aviso("Análise concluída.", "ok"); navegar();
      } catch (e) { aviso(e.message, "erro"); } finally { b.disabled = false; b.textContent = original; }
    };
    const abrirPerfil = async () => { try { const r = await mk(`google/link?marca=${marcaId}`); if (r.url) window.open(r.url, "_blank", "noopener"); else aviso("O Google não informou o link do perfil.", "erro"); } catch (e) { aviso(e.message, "erro"); } };
    const marcarLote = async (ids, status) => {
      if (!ids.length) { aviso("Selecione pelo menos uma avaliação.", "erro"); return; }
      try { const r = await mk("avaliacoes/denuncia-lote", { metodo: "POST", corpo: { ids, status } }); aviso(`${r.marcadas} avaliação(ões) atualizada(s).`, "ok"); navegar(); } catch (e) { aviso(e.message, "erro"); }
    };
    // Denúncia guiada: copia nome + trecho + tópico, abre o perfil no Google e confirma na volta.
    const denunciar = async (a, t) => {
      const trecho = String(a.texto || "").slice(0, 80);
      try { await navigator.clipboard.writeText(a.autor || trecho); } catch { /* sem área de transferência */ }
      abrirPerfil();
      const ok = await modal({ titulo: "Denunciar no Google", confirmar: "Já denunciei", conteudo: [
        `O perfil foi aberto em outra aba e o nome "${a.autor || "Cliente"}" foi copiado.`,
        h("ol", { class: "passos" }, h("li", {}, "No Google Maps, abra Avaliações e use \"Pesquisar avaliações\": cole o nome (Ctrl+V)."),
          h("li", {}, "Toque nos três pontinhos da avaliação → Denunciar avaliação."),
          h("li", {}, "Escolha: ", h("strong", { text: (t && t.categoria) || "o tópico que melhor descreve o problema" }), "."),
          h("li", {}, "Volte aqui e clique em \"Já denunciei\".")),
        trecho ? h("p", { class: "nota", text: `Trecho da avaliação: "${trecho}${String(a.texto || "").length > 80 ? "…" : ""}"` }) : ""] });
      if (ok) marcarLote([a.id], "DENUNCIADA");
    };

    // Cartão de cada avaliação
    function cartao(a) {
      const t = json_(a.triagem), d = json_(a.denuncia), v = t ? NOME_V[t.veredito] : null;
      const temResposta = Boolean(String(a.resposta || "").trim());
      const marca = h("input", { type: "checkbox", "aria-label": "Selecionar" });
      marca.addEventListener("change", () => { marca.checked ? selecionadas.add(a.id) : selecionadas.delete(a.id); contador.textContent = `${selecionadas.size} selecionada(s)`; });
      const editor = h("div", { class: "oculto" });
      const caixa = h("textarea", { class: "entrada", value: a.resposta || a.resposta_sugerida || "", style: "min-height:90px", placeholder: "Resposta pública da empresa" });
      editor.append(caixa, h("div", { class: "acoes" },
        botao("✦ Sugerir com IA", async (_e, b) => { b.textContent = "Escrevendo…"; try { caixa.value = (await mk(`avaliacoes/${a.id}/sugerir`, { metodo: "POST", corpo: {} })).resposta; } catch (e) { aviso(e.message, "erro"); } finally { b.textContent = "✦ Sugerir com IA"; } }, "btn-secundario btn-pequeno"),
        botao(a.google_id ? "Publicar no Google" : "Salvar resposta", async () => { try { const r = await mk(`avaliacoes/${a.id}/responder`, { metodo: "POST", corpo: { resposta: caixa.value } }); aviso(r.publicada_google ? "Resposta publicada no Google." : "Resposta salva.", "ok"); navegar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-primario btn-pequeno")));
      return h("article", { class: "sugestao vidro" + (t && t.veredito === "PROVAVEL_FALSA" ? " sugestao-alerta" : "") },
        h("div", { class: "sugestao-topo" }, pode("AGENTE") ? marca : null, h("strong", { text: a.autor || "Cliente" }), h("span", { class: "estrelas", text: "★".repeat(a.nota) + "☆".repeat(5 - a.nota) }),
          a.data ? h("span", { class: "sub", text: dataCompleta(a.data) }) : null,
          v ? selo(v[0], v[1]) : selo("Não analisada", ""), temResposta ? selo("Respondida", "ok") : selo("Sem resposta", "alerta"),
          d && d.status === "DENUNCIADA" ? selo("Denunciada em " + new Date(d.em).toLocaleDateString(LOCALE), "info") : d && d.status === "RECUSADA" ? selo("Google recusou", "alerta") : null),
        h("p", { style: "margin:0;color:var(--texto-2)", text: a.texto || "(sem texto, só a nota)" }),
        temResposta ? h("div", { class: "resposta-publicada" }, h("span", { class: "sub", text: "Resposta da empresa:" }), h("p", { style: "margin:4px 0 0", text: a.resposta })) : null,
        t ? h("div", { class: "analise-avaliacao" },
          t.motivo ? h("p", { class: "nota", text: t.motivo }) : null,
          (t.sinais || []).length ? h("ul", { class: "lista-simples" }, t.sinais.map(x => h("li", { text: x }))) : null,
          t.categoria ? h("p", { class: "nota nota-alerta" }, "Tópico de denúncia: ", h("strong", { text: t.categoria })) : h("p", { class: "nota", text: "Sem base para denúncia: o melhor caminho é uma boa resposta." }),
          t.justificativa && t.categoria ? h("p", { class: "nota", text: "Justificativa: " + t.justificativa }) : null) : null,
        t ? planoAvaliacao(a, t, json_(a.analise)) : null,
        editor,
        pode("AGENTE") ? h("div", { class: "acoes" },
          t && t.categoria && !d ? botao("Denunciar no Google", () => denunciar(a, t), "btn-primario btn-pequeno") : null,
          !d && !(t && t.categoria) ? botao("Já denunciei", () => marcarLote([a.id], "DENUNCIADA"), "btn-secundario btn-pequeno") : null,
          d && d.status === "DENUNCIADA" ? botao("O Google recusou", () => marcarLote([a.id], "RECUSADA"), "btn-secundario btn-pequeno") : null,
          d ? botao("Desfazer marcação", () => marcarLote([a.id], ""), "btn-secundario btn-pequeno") : null,
          botao(temResposta ? "Editar resposta" : "✦ Escrever resposta", () => editor.classList.toggle("oculto"), "btn-secundario btn-pequeno"),
          temResposta && pode("ADMIN") ? botao("Apagar resposta", async () => { if (!(await modal({ titulo: "Apagar esta resposta?", conteudo: a.google_id ? "A resposta é apagada também no Google." : "A resposta é apagada.", confirmar: "Apagar", perigo: true }))) return; try { await mk(`avaliacoes/${a.id}/apagar-resposta`, { metodo: "POST", corpo: {} }); aviso("Resposta apagada.", "ok"); navegar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-perigo btn-pequeno") : null,
          botao(t ? "Analisar de novo" : "✦ Analisar esta", (_e, b) => analisar(b, [a.id]), "btn-secundario btn-pequeno"),
          t && t.justificativa ? botao("Copiar justificativa", () => copiar(t.justificativa), "btn-secundario btn-pequeno") : null) : null);
    }

    // Filtros
    const sel = (valor, opcoes) => { const e = h("select", { class: "entrada" }, opcoes.map(([v, n]) => h("option", { value: v, text: n, selected: String(valor) === String(v) }))); e.addEventListener("change", aplicar); return e; };
    const fNota = sel(f.nota, [["", `1 e 2 estrelas (${numero(res.total || 0)})`], ["1", `Só 1 estrela (${numero(res.n1 || 0)})`], ["2", `Só 2 estrelas (${numero(res.n2 || 0)})`]]);
    const fVer = sel(f.veredito, [["", "Todas"], ["PROVAVEL_FALSA", `Provavelmente falsas (${numero(res.falsas || 0)})`], ["DUVIDOSA", `Duvidosas (${numero(res.duvidosas || 0)})`], ["PARECE_REAL", `Parecem reais (${numero(res.reais || 0)})`], ["SEM", `Não analisadas (${numero(res.sem_triagem || 0)})`]]);
    const fResp = sel(f.resposta, [["", "Com e sem resposta"], ["COM", `Com resposta (${numero(res.com_resposta || 0)})`], ["SEM", `Sem resposta (${numero((res.total || 0) - (res.com_resposta || 0))})`]]);
    const fDen = sel(f.denuncia, [["", "Todas"], ["NAO", "Não denunciadas"], ["DENUNCIADA", `Denunciadas (${numero(res.denunciadas || 0)})`], ["RECUSADA", `Recusadas (${numero(res.recusadas || 0)})`]]);
    const fBusca = h("input", { class: "entrada", type: "search", value: f.busca, placeholder: "Nome ou trecho do texto (Enter)" });
    fBusca.addEventListener("keydown", e => { if (e.key === "Enter") aplicar(); });
    function aplicar() { Object.assign(f, { nota: fNota.value, veredito: fVer.value, resposta: fResp.value, denuncia: fDen.value, busca: fBusca.value.trim() }); navegar(); }

    // Lista e seleção
    const contador = h("span", { class: "sub", text: "0 selecionada(s)" });
    const listaEl = h("div", { class: "grade" });
    let pagina = 0, carregadas = 0;
    const adicionar = itens => { itens.forEach(a => listaEl.appendChild(cartao(a))); carregadas += itens.length; };
    adicionar(primeira.avaliacoes || []);
    const mais = h("div", { class: "acoes", style: "justify-content:center" });
    const atualizarMais = () => mais.replaceChildren(...(carregadas < (primeira.encontradas || 0) ? [botao(`Mostrar mais (${numero(carregadas)} de ${numero(primeira.encontradas)})`, async (_e, b) => {
      b.textContent = "Carregando…";
      try { adicionar((await mk(consulta(++pagina))).avaliacoes || []); atualizarMais(); } catch (e) { aviso(e.message, "erro"); }
    }, "btn-secundario")] : []));
    atualizarMais();
    const marcarTodas = h("input", { type: "checkbox", "aria-label": "Selecionar todas as carregadas" });
    marcarTodas.addEventListener("change", () => { listaEl.querySelectorAll('input[type="checkbox"]').forEach(c => { if (c.checked !== marcarTodas.checked) { c.checked = marcarTodas.checked; c.dispatchEvent(new Event("change")); } }); });
    const lote = pode("AGENTE") ? h("section", { class: "cartao vidro barra-lote" }, h("label", { class: "acoes", style: "gap:8px" }, marcarTodas, h("span", { text: "Selecionar todas as carregadas" })), contador,
      h("div", { class: "acoes" },
        botao("✦ Analisar selecionadas", (_e, b) => selecionadas.size ? analisar(b, [...selecionadas]) : aviso("Selecione pelo menos uma avaliação.", "erro"), "btn-secundario btn-pequeno"),
        botao("Marcar como denunciadas", () => marcarLote([...selecionadas], "DENUNCIADA"), "btn-secundario btn-pequeno"),
        botao("Marcar como recusadas", () => marcarLote([...selecionadas], "RECUSADA"), "btn-secundario btn-pequeno"),
        botao("Limpar marcação", () => marcarLote([...selecionadas], ""), "btn-secundario btn-pequeno"))) : null;

    trocar(area,
      h("section", { class: "cartao vidro" },
        h("h3", { style: "margin-top:0", text: "Central de reputação — avaliações de 1 e 2 estrelas" }),
        conectada ? h("p", { class: "nota", text: `Perfil: ${conta.local_titulo}.${conta.total_google != null ? ` No Google: ${numero(conta.total_google)} avaliações${conta.media_google ? `, nota ${String(Number(conta.media_google).toFixed(1)).replace(".", ",")}` : ""}.` : ""} Na DENIA: ${numero(res.n1 || 0)} de 1 estrela e ${numero(res.n2 || 0)} de 2 estrelas.${conta.lendo ? " A última leitura completa do Google não terminou: clique em \"Buscar todas no Google\"." : ""}${conta.sincronizado_ms ? " Última busca: " + new Date(conta.sincronizado_ms).toLocaleString(LOCALE) + "." : ""}` })
          : h("p", { class: "nota nota-alerta", text: "Conecte o Google desta marca (Marcas → Conectar Google) para trazer as avaliações." }),
        conectada && conta.erro ? h("p", { class: "nota nota-alerta", text: "Última tentativa com o Google falhou: " + conta.erro }) : null,
        avisoFaltam(conta),
        h("p", { style: "margin:6px 0 0;color:var(--texto-2);font-size:14px", text: "A DENIA confere se quem avaliou está na sua base de clientes, procura avaliações em sequência, textos repetidos e conteúdo fora do tema, e indica o tópico de denúncia do Google. A denúncia em si é um toque no Google (ele não permite denúncia automática); o botão \"Denunciar no Google\" já abre o perfil e copia o nome para você achar a avaliação." }),
        h("div", { class: "acoes", style: "margin-top:12px" },
          conectada && pode("AGENTE") ? botao("Buscar todas no Google", buscarTodas, "btn-secundario") : null,
          pode("AGENTE") && res.sem_triagem ? botao(`✦ Analisar as ${numero(res.sem_triagem)} que faltam`, (_e, b) => analisar(b, null), "btn-primario") : null,
          conectada ? botao("Abrir o perfil no Google Maps", abrirPerfil, "btn-secundario") : null),
        progresso),
      h("section", { class: "grade grade-4" },
        metrica("1 estrela", numero(res.n1 || 0), "na DENIA"), metrica("2 estrelas", numero(res.n2 || 0), "na DENIA"),
        metrica("Sem resposta", numero((res.total || 0) - (res.com_resposta || 0)), `${numero(res.com_resposta || 0)} já respondidas`),
        metrica("Provavelmente falsas", numero(res.falsas || 0), `${numero(res.duvidosas || 0)} duvidosas · ${numero(res.reais || 0)} parecem reais`),
        metrica("Denunciadas", numero(res.denunciadas || 0), `${numero(res.recusadas || 0)} recusadas pelo Google`), metrica("Removidas pelo Google", numero(res.removidas || 0), "saíram do perfil"),
        metrica("Não analisadas", numero(res.sem_triagem || 0), "clique em Analisar")),
      h("section", { class: "cartao vidro" }, h("div", { class: "linha-form" }, campo("Nota", fNota), campo("Triagem", fVer), campo("Resposta", fResp), campo("Denúncia", fDen), campo("Buscar", fBusca)),
        h("p", { class: "nota", style: "margin:8px 0 0", text: `${numero(primeira.encontradas || 0)} avaliação(ões) com esses filtros.` })),
      lote,
      (primeira.avaliacoes || []).length ? listaEl : h("div", { class: "cartao vidro" }, vazio("Nenhuma avaliação com esses filtros", "", ICONES.caixa)),
      mais);
  }
  async function abaRelatorio(area, marcaId) {
    const lista = (await mk(`relatorios?marca=${marcaId}`)).relatorios || [];
    const atual = lista[0];
    trocar(area, h("section", { class: "cartao vidro" },
      h("div", { class: "sugestao-topo" }, h("h3", { style: "margin:0", text: atual ? `Relatório da semana de ${dataCurta(atual.semana)}` : "Relatório semanal" }),
        pode("AGENTE") ? botao("✦ Gerar relatório agora", async (_e, b) => { b.textContent = "Analisando os dados…"; try { await mk("relatorios/gerar", { metodo: "POST", corpo: { marca_id: marcaId } }); navegar(); } catch (e) { aviso(e.message, "erro"); } finally { b.textContent = "✦ Gerar relatório agora"; } }, "btn-primario btn-pequeno") : null),
      atual ? h("div", { class: "relatorio-texto", text: atual.texto }) : vazio("Nenhum relatório ainda", "Toda segunda-feira a DENIA analisa o Google e as redes de cada marca conectada e escreve o relatório com o plano da semana. Você também pode gerar agora.", ICONES.caixa)),
      lista.length > 1 ? h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "Semanas anteriores" }),
        lista.slice(1).map(r => h("details", {}, h("summary", { text: `Semana de ${dataCurta(r.semana)}` }), h("div", { class: "relatorio-texto", text: r.texto })))) : null);
  }
  async function abaPalavras(area, marcaId, marca) {
    const lista = (await mk(`palavras?marca=${marcaId}`)).palavras || [];
    const semanas = Array.from({ length: 6 }, (_, i) => isoLocal(somarDias(segundaDe(new Date()), -7 * (5 - i))));
    const palavra = h("input", { class: "entrada", placeholder: "Ex.: assistência técnica de geladeira" });
    const cidade = h("input", { class: "entrada", value: (marca && marca.cidade) || "", placeholder: "Cidade ou bairro" });
    trocar(area, 
      pode("AGENTE") ? h("section", { class: "cartao vidro formulario" }, h("h3", { style: "margin:0", text: "Acompanhar palavra-chave" }),
        h("p", { style: "margin:0;color:var(--texto-2);font-size:14px", text: "As buscas que trazem clientes. A posição é o lugar do perfil no Google Maps para aquela busca, na cidade indicada." }),
        h("div", { class: "linha-form" }, campo("Palavra-chave", palavra), campo("Cidade", cidade)),
        h("div", { class: "acoes" }, botao("Adicionar", async () => { try { await mk("palavras", { metodo: "POST", corpo: { marca_id: marcaId, palavra: palavra.value, cidade: cidade.value } }); navegar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-primario"))) : null,
      lista.length ? h("div", { class: "tabela-caixa" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", { text: "Palavra-chave" }), semanas.map(s => h("th", { text: dataCurta(s) })), h("th", { text: "Esta semana" }), h("th", { text: "" }))),
        h("tbody", {}, lista.map(p => {
          const pos = s => (p.posicoes.find(x => x.semana === s) || {}).posicao;
          const atual = pos(semanas[5]), antes = pos(semanas[4]);
          const tendencia = atual && antes ? (atual < antes ? h("span", { class: "sobe", text: " ▲" + (antes - atual) }) : atual > antes ? h("span", { class: "desce", text: " ▼" + (atual - antes) }) : null) : null;
          const inp = h("input", { class: "entrada pos-entrada", type: "number", min: "1", max: "100", value: atual || "", placeholder: "nº" });
          inp.addEventListener("change", async () => { try { await mk(`palavras/${p.id}/posicao`, { metodo: "POST", corpo: { semana: semanas[5], posicao: inp.value } }); aviso("Posição salva.", "ok"); } catch (e) { aviso(e.message, "erro"); } });
          return h("tr", {}, h("td", {}, h("strong", { text: p.palavra }), h("span", { class: "sub", text: p.cidade || "" })),
            semanas.map(s => h("td", { text: pos(s) ? pos(s) + "º" : "—" })), h("td", {}, inp, tendencia),
            h("td", {}, pode("AGENTE") ? botao("Remover", async () => { await mk(`palavras/${p.id}/remover`, { metodo: "POST", corpo: {} }); navegar(); }, "btn-secundario btn-pequeno") : null));
        })))) : h("div", { class: "cartao vidro" }, vazio("Nenhuma palavra-chave ainda", "Adicione as buscas mais importantes para esta marca.", ICONES.caixa)));
  }
  // Desempenho no Google: qualquer período de 7 dias a 18 meses (ou datas escolhidas), comparação, detalhe, gráfico dia a dia e planilha.
  const PERIODOS_G = [["7", "7 dias"], ["30", "30 dias"], ["60", "60 dias"], ["90", "90 dias"], ["180", "6 meses"], ["365", "12 meses"], ["540", "18 meses"], ["mes", "Este mês"], ["mes_passado", "Mês passado"], ["datas", "Escolher datas"]];
  const METRICAS_G = [
    ["visualizacoes", "Visualizações do perfil", "Vezes que o perfil apareceu no Google (Pesquisa + Maps)"],
    ["interacoes", "Interações", "Ligações, rotas, cliques no site, mensagens e reservas somados"],
    ["ligacoes", "Ligações", "Toques no botão Ligar"],
    ["rotas", "Pedidos de rota", "Pessoas que pediram o caminho até a loja"],
    ["cliques_site", "Cliques no site", "Toques no botão Site"],
    ["mensagens", "Mensagens", "Conversas iniciadas pelo perfil"],
    ["buscas", "Aparições na Pesquisa", "Vezes que apareceu na Pesquisa Google"],
    ["maps", "Aparições no Maps", "Vezes que apareceu no Google Maps"],
    ["reservas", "Reservas", "Agendamentos feitos pelo perfil"],
    ["pedidos_comida", "Pedidos de comida", "Pedidos feitos pelo perfil"],
    ["cliques_cardapio", "Cliques no cardápio", "Toques no cardápio"]
  ];
  const ORIGENS_G = [["maps_celular", "Google Maps — celular"], ["maps_computador", "Google Maps — computador"], ["pesquisa_celular", "Pesquisa Google — celular"], ["pesquisa_computador", "Pesquisa Google — computador"]];
  const nomeMetricaG = k => (METRICAS_G.find(m => m[0] === k) || [k, k])[1];
  function variacaoPct(atual, antes) {
    if (antes == null) return null;
    if (!antes) return atual ? { texto: "novo", sobe: true } : null;
    const v = Math.round(((atual - antes) / antes) * 1000) / 10;
    return v === 0 ? { texto: "= igual", zero: true } : { texto: `${v > 0 ? "▲" : "▼"} ${String(Math.abs(v)).replace(".", ",")}%`, sobe: v > 0 };
  }
  // Agrupa a série por dia, semana (segunda a domingo) ou mês.
  function agruparSerie(diario, modo, campo) {
    if (modo === "dia") return diario.map(d => ({ chave: d.data, rotulo: dataCompleta(d.data), curto: dataCurta(d.data), valor: d[campo] || 0 }));
    const grupos = new Map();
    for (const d of diario) {
      let chave = d.data.slice(0, 7);
      if (modo === "semana") { const t = new Date(d.data + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); chave = t.toISOString().slice(0, 10); }
      const g = grupos.get(chave) || { chave, valor: 0, dias: 0, ini: d.data, fim: d.data };
      g.valor += d[campo] || 0; g.dias++; g.fim = d.data;
      grupos.set(chave, g);
    }
    const fmtMes = new Intl.DateTimeFormat(LOCALE, { month: "short", year: "numeric", timeZone: "UTC" });
    return [...grupos.values()].map(g => modo === "mes"
      ? { ...g, rotulo: fmtMes.format(new Date(g.chave + "-15T12:00:00Z")) + (g.dias < new Date(Date.UTC(+g.chave.slice(0, 4), +g.chave.slice(5, 7), 0)).getUTCDate() ? ` (${g.dias} dias)` : ""), curto: fmtMes.format(new Date(g.chave + "-15T12:00:00Z")) }
      : { ...g, rotulo: `${dataCompleta(g.ini)} a ${dataCompleta(g.fim)}`, curto: dataCurta(g.ini) });
  }
  // Gráfico de linha (uma métrica por vez, um só eixo), com a comparação tracejada e o valor de cada ponto ao passar o dedo/mouse.
  function graficoLinha(pontos, comparacao, nomeAtual, nomeComp) {
    // O desenho tem o tamanho real da área (sem "zoom"): letras e linhas ficam com o mesmo tamanho em qualquer tela.
    const disponivel = Math.round(Math.max(300, Math.min(1500, ((document.getElementById("conteudo") || {}).clientWidth || window.innerWidth) - 96)));
    const estreito = disponivel < 600, L = disponivel, A = estreito ? 220 : 240, m = { e: estreito ? 40 : 56, d: estreito ? 10 : 16, t: 14, b: 30 };
    const larg = L - m.e - m.d, alt = A - m.t - m.b;
    const max = Math.max(1, ...pontos.map(p => p.valor), ...(comparacao || []).map(p => p.valor));
    const passo = (() => { const bruto = max / 4, ordem = Math.pow(10, Math.floor(Math.log10(bruto))); const n = [1, 2, 2.5, 5, 10].find(x => x * ordem >= bruto); return n * ordem; })();
    const topo = passo * Math.ceil(max / passo);
    const x = i => m.e + (pontos.length < 2 ? larg / 2 : (i / (pontos.length - 1)) * larg);
    const y = v => m.t + alt - (v / topo) * alt;
    const svg = document.createElementNS(SVG_NS, "svg");
    const el = (tag, at) => { const n = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(at)) n.setAttribute(k, v); return n; };
    svg.setAttribute("viewBox", `0 0 ${L} ${A}`); svg.setAttribute("class", "grafico-svg"); svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `${nomeAtual}: ${pontos.length} pontos, máximo ${numero(Math.max(...pontos.map(p => p.valor)))}`);
    for (let v = 0; v <= topo + 1e-9; v += passo) {
      svg.appendChild(el("line", { x1: m.e, x2: L - m.d, y1: y(v), y2: y(v), class: "grafico-grade" }));
      const t = el("text", { x: m.e - 8, y: y(v) + 4, class: "grafico-eixo", "text-anchor": "end" }); t.textContent = numero(v); svg.appendChild(t);
    }
    const marcas = Math.min(Math.max(3, Math.floor(L / 120)), pontos.length);
    for (let j = 0; j < marcas; j++) {
      const i = marcas < 2 ? 0 : Math.round((j / (marcas - 1)) * (pontos.length - 1));
      const t = el("text", { x: x(i), y: A - 8, class: "grafico-eixo", "text-anchor": j === 0 && marcas > 1 ? "start" : j === marcas - 1 && marcas > 1 ? "end" : "middle" }); t.textContent = pontos[i].curto; svg.appendChild(t);
    }
    const caminho = serie => serie.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.valor).toFixed(1)}`).join("");
    if (comparacao && comparacao.length) svg.appendChild(el("path", { d: caminho(comparacao.slice(0, pontos.length)), class: "grafico-linha-comp" }));
    svg.appendChild(el("path", { d: caminho(pontos), class: "grafico-linha" }));
    if (pontos.length === 1) svg.appendChild(el("circle", { cx: x(0), cy: y(pontos[0].valor), r: 4, class: "grafico-ponto" }));
    const guia = el("line", { y1: m.t, y2: m.t + alt, class: "grafico-guia", visibility: "hidden" });
    const ponto = el("circle", { r: 5, class: "grafico-ponto", visibility: "hidden" });
    svg.appendChild(guia); svg.appendChild(ponto);
    const area = el("rect", { x: m.e, y: m.t, width: larg, height: alt, class: "grafico-area" });
    svg.appendChild(area);
    const dica = h("div", { class: "grafico-dica oculto", role: "status" });
    const caixa = h("div", { class: "grafico" }, svg, dica);
    const mostrar = ev => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * L;
      const i = Math.max(0, Math.min(pontos.length - 1, Math.round(pontos.length < 2 ? 0 : ((px - m.e) / larg) * (pontos.length - 1))));
      const p = pontos[i], c = comparacao && comparacao[i];
      guia.setAttribute("x1", x(i)); guia.setAttribute("x2", x(i)); guia.setAttribute("visibility", "visible");
      ponto.setAttribute("cx", x(i)); ponto.setAttribute("cy", y(p.valor)); ponto.setAttribute("visibility", "visible");
      trocar(dica, h("strong", { text: p.rotulo }), h("span", { text: `${nomeAtual}: ${numero(p.valor)}` }), c ? h("span", { class: "grafico-dica-comp", text: `${nomeComp} (${c.rotulo}): ${numero(c.valor)}` }) : null);
      dica.classList.remove("oculto");
      const esquerda = (x(i) / L) * r.width;
      dica.style.left = Math.min(Math.max(esquerda, 90), r.width - 90) + "px";
    };
    area.addEventListener("pointermove", mostrar);
    area.addEventListener("pointerdown", mostrar);
    area.addEventListener("pointerleave", () => { guia.setAttribute("visibility", "hidden"); ponto.setAttribute("visibility", "hidden"); dica.classList.add("oculto"); });
    return caixa;
  }
  function baixarCsv(nome, linhas) {
    const esc = v => { const s = v == null ? "" : String(v); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const texto = "﻿" + linhas.map(l => l.map(esc).join(";")).join("\r\n");
    const url = URL.createObjectURL(new Blob([texto], { type: "text/csv;charset=utf-8" }));
    const a = h("a", { href: url, download: nome });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function abaDesempenho(area, marcaId) {
    const f = estado.desempenhoG = estado.desempenhoG || { periodo: "30", de: "", ate: "", comparar: "anterior", metrica: "visualizacoes", agrupar: "auto", tabela: false };
    const q = new URLSearchParams({ marca: marcaId, comparar: f.comparar });
    if (f.periodo === "datas" && f.de && f.ate) { q.set("de", f.de); q.set("ate", f.ate); }
    else if (f.periodo === "mes" || f.periodo === "mes_passado") q.set("atalho", f.periodo);
    else q.set("dias", f.periodo === "datas" ? "30" : f.periodo);
    const [lista, vivoG] = await Promise.all([mk(`metricas?marca=${marcaId}`).then(r => r.metricas || []), mk(`google/desempenho?${q}`).catch(e => ({ conectada: true, erro: e.message }))]);
    const CAMPOS_M = [["visualizacoes", "Visualizações do perfil"], ["buscas", "Aparições em buscas"], ["ligacoes", "Ligações"], ["rotas", "Pedidos de rota"], ["cliques_site", "Cliques no site"], ["mensagens", "Mensagens"], ["nota_media", "Nota média"], ["total_avaliacoes", "Total de avaliações"]];
    const ents = Object.fromEntries(CAMPOS_M.map(([k]) => [k, h("input", { class: "entrada", type: "number", min: "0", step: k === "nota_media" ? "0.1" : "1" })]));
    const ultima = lista[0] || {}, anterior = lista[1] || {};
    const variacao = k => ultima[k] != null && anterior[k] ? Math.round(((ultima[k] - anterior[k]) / anterior[k]) * 100) : null;

    // Barra de período (uma linha acima de tudo) — vale para todos os números da aba.
    const recarregar = () => abaDesempenho(area, marcaId).catch(e => aviso(e.message, "erro"));
    const deE = h("input", { class: "entrada", type: "date", value: f.de || vivoG.de || "", min: vivoG.primeiro_dia || "", max: vivoG.ultimo_dia || "", "aria-label": "Data de início" });
    const ateE = h("input", { class: "entrada", type: "date", value: f.ate || vivoG.ate || "", min: vivoG.primeiro_dia || "", max: vivoG.ultimo_dia || "", "aria-label": "Data de fim" });
    const compE = h("select", { class: "entrada", "aria-label": "Comparar com", onchange: e => { f.comparar = e.target.value; recarregar(); } },
      [["anterior", "Comparar: período anterior"], ["ano", "Comparar: mesmo período do ano passado"], ["nada", "Sem comparação"]].map(([v, n]) => h("option", { value: v, selected: f.comparar === v, text: n })));
    const barra = h("section", { class: "cartao vidro filtros-desempenho" },
      h("div", { class: "abas abas-chips", role: "group", "aria-label": "Período" }, PERIODOS_G.map(([v, n]) => h("button", { type: "button", class: "aba" + (f.periodo === v ? " ativo" : ""), "aria-pressed": f.periodo === v ? "true" : "false", onclick: () => { f.periodo = v; if (v !== "datas") recarregar(); else navegarDatas(); } }, n))),
      h("div", { class: "linha-filtros" },
        f.periodo === "datas" ? h("div", { class: "linha-datas" }, h("label", {}, "De ", deE), h("label", {}, "até ", ateE),
          botao("Ver período", () => { if (!deE.value || !ateE.value) return aviso("Escolha as duas datas.", "erro"); f.de = deE.value; f.ate = ateE.value; recarregar(); }, "btn-primario btn-pequeno")) : null,
        compE));
    function navegarDatas() { f.de = f.de || vivoG.de || ""; f.ate = f.ate || vivoG.ate || ""; recarregar(); }

    let blocoGoogle = null;
    if (vivoG.conectada && vivoG.erro) blocoGoogle = h("section", { class: "cartao vidro" }, h("p", { class: "nota nota-alerta", text: vivoG.erro }));
    else if (vivoG.conectada) {
      const t = vivoG.totais || {}, comp = vivoG.comparacao && !vivoG.comparacao.indisponivel ? vivoG.comparacao : null, ct = comp ? comp.totais : null;
      const nomeComp = comp ? (comp.modo === "ano" ? "Ano passado" : "Período anterior") : "";
      const visiveis = METRICAS_G.filter(([k]) => !["reservas", "pedidos_comida", "cliques_cardapio"].includes(k) || t[k] || (ct && ct[k]));
      if (!visiveis.some(m => m[0] === f.metrica)) f.metrica = "visualizacoes";
      const cartoes = h("section", { class: "grade grade-4" }, visiveis.map(([k, n, ajuda]) => {
        const v = ct ? variacaoPct(t[k] || 0, ct[k] || 0) : null;
        return h("button", { type: "button", class: "metrica vidro metrica-botao" + (f.metrica === k ? " ativo" : ""), title: ajuda, "aria-pressed": f.metrica === k ? "true" : "false", onclick: () => { f.metrica = k; recarregar(); } },
          h("span", { text: n }), h("strong", { text: numero(t[k] || 0) }),
          h("small", {}, v ? h("span", { class: v.zero ? "" : v.sobe ? "sobe" : "desce", text: v.texto }) : null, ct ? ` ${v ? "vs" : ""} ${numero(ct[k] || 0)} no ${nomeComp.toLowerCase()}` : ajuda));
      }));
      const agrupar = f.agrupar !== "auto" ? f.agrupar : vivoG.dias <= 92 ? "dia" : vivoG.dias <= 370 ? "semana" : "mes";
      const pontos = agruparSerie(vivoG.diario || [], agrupar, f.metrica);
      const pontosComp = comp ? agruparSerie(comp.diario || [], agrupar, f.metrica) : null;
      const agruparE = h("select", { class: "entrada entrada-pequena", "aria-label": "Agrupar por", onchange: e => { f.agrupar = e.target.value; recarregar(); } },
        [["auto", "Agrupar: automático"], ["dia", "Por dia"], ["semana", "Por semana"], ["mes", "Por mês"]].map(([v, n]) => h("option", { value: v, selected: f.agrupar === v, text: n })));
      const tabelaSerie = h("div", { class: "tabela-caixa lista-rolavel" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: agrupar === "dia" ? "Dia" : agrupar === "semana" ? "Semana" : "Mês" }), h("th", { text: nomeMetricaG(f.metrica) }), comp ? h("th", { text: nomeComp }) : null)),
        h("tbody", {}, pontos.map((p, i) => h("tr", {}, h("td", { text: p.rotulo }), h("td", { text: numero(p.valor) }), comp ? h("td", { text: pontosComp[i] ? `${numero(pontosComp[i].valor)} (${pontosComp[i].rotulo})` : "—" }) : null)))));
      const legenda = comp ? h("div", { class: "grafico-legenda" }, h("span", { class: "leg-atual", text: `${dataCompleta(vivoG.de)} a ${dataCompleta(vivoG.ate)}` }), h("span", { class: "leg-comp", text: `${nomeComp}: ${dataCompleta(comp.de)} a ${dataCompleta(comp.ate)}` })) : null;
      const blocoGrafico = h("section", { class: "cartao vidro" },
        h("div", { class: "cabeca-grafico" }, h("h3", { style: "margin:0", text: `${nomeMetricaG(f.metrica)} ${agrupar === "dia" ? "dia a dia" : agrupar === "semana" ? "por semana" : "por mês"}` }),
          h("div", { class: "acoes" }, agruparE, botao(f.tabela ? "Ver gráfico" : "Ver tabela", () => { f.tabela = !f.tabela; recarregar(); }, "btn-secundario btn-pequeno"))),
        h("p", { class: "sub", style: "margin:4px 0 10px", text: "Toque nos cartões acima para trocar o número do gráfico. Passe o dedo ou o mouse na linha para ver cada valor." }),
        legenda, pontos.length ? (f.tabela ? tabelaSerie : graficoLinha(pontos, pontosComp, nomeMetricaG(f.metrica), nomeComp)) : vazio("Sem números neste período", "O Google ainda não tem dados para essas datas."));
      // De onde vieram as visualizações (Maps x Pesquisa, celular x computador).
      const totalOrig = ORIGENS_G.reduce((s, [k]) => s + ((vivoG.detalhe || {})[k] || 0), 0);
      const blocoOrigem = h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "De onde vieram as visualizações" }),
        h("div", { class: "tabela-caixa" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "Onde" }), h("th", { text: "Vezes" }), h("th", { text: "Parte do total" }), comp ? h("th", { text: nomeComp }) : null, comp ? h("th", { text: "Variação" }) : null)),
          h("tbody", {}, ORIGENS_G.map(([k, n]) => {
            const val = (vivoG.detalhe || {})[k] || 0, ant = comp ? (comp.detalhe || {})[k] || 0 : null, pct = totalOrig ? Math.round((val / totalOrig) * 100) : 0, v = comp ? variacaoPct(val, ant) : null;
            return h("tr", {}, h("td", { text: n }), h("td", { text: numero(val) }), h("td", {}, h("div", { class: "barra-parte" }, h("i", { style: `width:${pct}%` })), ` ${pct}%`),
              comp ? h("td", { text: numero(ant) }) : null, comp ? h("td", {}, v ? h("span", { class: v.zero ? "" : v.sobe ? "sobe" : "desce", text: v.texto }) : "—") : null);
          })))));
      // Taxa de conversão: de cada 100 pessoas que viram o perfil, quantas agiram.
      const taxa = t.visualizacoes ? Math.round((t.interacoes / t.visualizacoes) * 1000) / 10 : 0;
      const taxaAnt = ct && ct.visualizacoes ? Math.round((ct.interacoes / ct.visualizacoes) * 1000) / 10 : null;
      const mediaDia = vivoG.dias ? Math.round((t.interacoes / vivoG.dias) * 10) / 10 : 0;
      const blocoResumo = h("section", { class: "grade grade-3" },
        metrica("Taxa de ação", `${String(taxa).replace(".", ",")}%`, taxaAnt != null ? `De cada 100 que viram, ${String(taxa).replace(".", ",")} agiram (antes: ${String(taxaAnt).replace(".", ",")})` : "De cada 100 pessoas que viram o perfil"),
        metrica("Interações por dia", String(mediaDia).replace(".", ","), "Média no período"),
        metrica("Dia mais forte", (() => { const d = (vivoG.diario || []).reduce((a, b) => (b.interacoes > (a?.interacoes ?? -1) ? b : a), null); return d && d.interacoes ? dataCompleta(d.data) : "—"; })(), "Dia com mais interações"));
      const plv = vivoG.palavras || [];
      const fmtMes = s => { const [a, mm] = String(s || "").split("-"); return mm ? `${mm}/${a}` : ""; };
      const blocoPalavras = h("section", { class: "cartao vidro" },
        h("div", { class: "cabeca-grafico" }, h("h3", { style: "margin:0", text: "O que as pessoas pesquisaram para achar o perfil" }),
          plv.length ? botao("Baixar buscas (planilha)", () => baixarCsv(`buscas-google-${vivoG.palavras_de}-${vivoG.palavras_ate}.csv`, [["Busca", "Pessoas"], ...plv.map(p => [p.palavra, p.buscas != null ? p.buscas : `menos de ${p.menos_de}`])]), "btn-secundario btn-pequeno") : null),
        h("p", { class: "sub", style: "margin:4px 0 10px", text: vivoG.palavras_de ? `Meses ${fmtMes(vivoG.palavras_de)}${vivoG.palavras_ate !== vivoG.palavras_de ? " a " + fmtMes(vivoG.palavras_ate) : ""} — o Google só divulga as buscas por mês fechado.` : "" }),
        plv.length ? h("div", { class: "tabela-caixa lista-rolavel" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "#" }), h("th", { text: "Busca" }), h("th", { text: "Pessoas" }))),
          h("tbody", {}, plv.map((p, i) => h("tr", {}, h("td", { text: String(i + 1) }), h("td", { text: p.palavra }), h("td", { text: p.buscas != null ? numero(p.buscas) : `menos de ${p.menos_de}` })))))) : vazio("Sem buscas para esses meses", "O Google ainda não divulgou as buscas desse período."));
      const planilha = () => baixarCsv(`desempenho-google-${vivoG.de}-a-${vivoG.ate}.csv`, [
        ["Dia", ...METRICAS_G.map(m => m[1]), ...ORIGENS_G.map(o => o[1])],
        ...(vivoG.diario || []).map(d => [dataCompleta(d.data), ...METRICAS_G.map(m => d[m[0]] || 0), ...ORIGENS_G.map(o => d[o[0]] || 0)]),
        ["Total", ...METRICAS_G.map(m => t[m[0]] || 0), ...ORIGENS_G.map(o => (vivoG.detalhe || {})[o[0]] || 0)],
        ...(ct ? [[`${nomeComp} (${dataCompleta(comp.de)} a ${dataCompleta(comp.ate)})`, ...METRICAS_G.map(m => ct[m[0]] || 0), ...ORIGENS_G.map(o => (comp.detalhe || {})[o[0]] || 0)]] : [])]);
      blocoGoogle = [
        h("div", { class: "cabeca-grafico" }, h("div", {}, h("h3", { style: "margin:0", text: `${vivoG.perfil || "Google"} — ${dataCompleta(vivoG.de)} a ${dataCompleta(vivoG.ate)} (${numero(vivoG.dias)} dias)` }),
          h("p", { class: "sub", style: "margin:2px 0 0", text: vivoG.comparacao && vivoG.comparacao.indisponivel ? vivoG.comparacao.indisponivel : comp ? `Comparando com ${dataCompleta(comp.de)} a ${dataCompleta(comp.ate)}. O Google libera os números com 2 dias de atraso e guarda 18 meses.` : "O Google libera os números com 2 dias de atraso e guarda 18 meses." })),
          botao("Baixar planilha do período", planilha, "btn-secundario btn-pequeno")),
        cartoes, blocoGrafico, blocoResumo, blocoOrigem, blocoPalavras];
    }
    trocar(area,
      vivoG.conectada ? barra : null,
      blocoGoogle,
      !vivoG.conectada ? h("section", { class: "grade grade-4" }, ["visualizacoes", "ligacoes", "rotas", "cliques_site"].map(k => {
        const v = variacao(k);
        return metrica((CAMPOS_M.find(c => c[0] === k) || [k, k])[1], ultima[k] != null ? numero(ultima[k]) : "—", v == null ? (ultima.semana ? "semana de " + dataCurta(ultima.semana) : "sem dados ainda") : `${v >= 0 ? "▲" : "▼"} ${Math.abs(v)}% em relação à semana anterior`);
      })) : null,
      lista.length ? h("details", { class: "cartao vidro", open: !vivoG.conectada }, h("summary", { text: `Semanas registradas (${lista.length})` }),
        h("div", { class: "tabela-caixa" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "Semana" }), CAMPOS_M.map(([, n]) => h("th", { text: n })))),
          h("tbody", {}, lista.map(m => h("tr", {}, h("td", { text: dataCompleta(m.semana) }), CAMPOS_M.map(([k]) => h("td", { text: m[k] == null ? "—" : String(m[k]).replace(".", ",") })))))))) : null,
      pode("AGENTE") && !vivoG.conectada ? h("section", { class: "cartao vidro formulario" }, h("h3", { style: "margin:0", text: "Registrar a semana" }),
        h("p", { style: "margin:0;color:var(--texto-2);font-size:14px", text: "Os números ficam em Google Meu Negócio → Desempenho. Depois da conexão com o Google, eles são importados sozinhos toda semana." }),
        h("div", { class: "linha-form" }, CAMPOS_M.map(([k, n]) => campo(n, ents[k]))),
        h("div", { class: "acoes" }, botao("Salvar semana", async () => { try { const corpo = { marca_id: marcaId, semana: isoLocal(new Date()) }; CAMPOS_M.forEach(([k]) => { corpo[k] = ents[k].value; }); await mk("metricas", { metodo: "POST", corpo }); aviso("Semana registrada.", "ok"); navegar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-primario"))) : null);
  }

  // ---------------------------------------------------------------------------
  // Consumo e custos: OpenAI (painel e WhatsApp), Meta (Instagram, Facebook, WhatsApp) e Google
  // ---------------------------------------------------------------------------
  const NOME_SERVICO = { openai: "OpenAI", elevenlabs: "ElevenLabs (voz)", meta: "Meta (Instagram e Facebook)", google: "Google" };
  const NOME_OPERACAO_IA = { texto: "Texto", imagem: "Imagens", transcricao: "Transcrição de áudio", voz_falada: "Voz falada", voz_sessao: "Abrir conversa por voz", voz_ao_vivo: "Conversa por voz ao vivo", atendimento: "Respostas no WhatsApp", transcricao_audio: "Áudios do WhatsApp" };
  const NOME_RECURSO = {
    "": "Outros", assistente: "Assistente DENIA", "assistente/voz": "DENIA por voz", "assistente/conversa": "Assistente DENIA", "assistente/ao-vivo": "DENIA por voz",
    "automático/avaliações": "Automático: avaliações do Google", "automático/relatórios": "Automático: relatórios semanais", "whatsapp/motor": "WhatsApp (motor)",
    "avaliacoes/triagem": "Triagem de avaliações", "avaliacoes/analisar-lote": "Leitura de avaliações", avaliacoes: "Avaliações", "posts/gerar": "Criar posts com IA", posts: "Posts", "midias/gerar": "Criar imagens", midias: "Imagens",
    "relatorios/gerar": "Relatório do Google", "google/agora": "Buscar e responder avaliações", "google/sincronizar": "Sincronizar Google", "google/desempenho": "Desempenho do Google", "meta/publicar": "Publicar na Meta"
  };
  const nomeRecurso = r => NOME_RECURSO[r] || NOME_RECURSO[String(r).split("/")[0]] || r;
  const MOEDAS = ["BRL", "USD", "EUR", "GBP", "INR", "JPY", "MXN", "ARS", "CLP", "COP", "PEN", "CAD", "AUD", "CHF"];
  function dinheiro(valor, moeda) {
    const v = Number(valor) || 0;
    try { return new Intl.NumberFormat(LOCALE, { style: "currency", currency: moeda, minimumFractionDigits: v && Math.abs(v) < 1 ? 3 : 2, maximumFractionDigits: v && Math.abs(v) < 1 ? 4 : 2 }).format(v); }
    catch { return `${moeda} ${v.toFixed(2)}`; }
  }
  // Mesmo cálculo do servidor (src/uso.js) para o consumo do motor, que só devolve tokens.
  function precoModelo(tabela, modelo) {
    const m = String(modelo || "").toLowerCase();
    const k = Object.keys(tabela).filter(x => x !== "*" && m.startsWith(x.toLowerCase())).sort((a, b) => b.length - a.length)[0];
    return tabela[k] || tabela["*"] || { entrada: 1.25, cache: 0.125, saida: 10 };
  }
  function custoTokens(tabela, modelo, ent, cache, sai) {
    const p = precoModelo(tabela, modelo);
    return (Math.max(0, ent - cache) * p.entrada + cache * (p.cache ?? p.entrada) + sai * p.saida) / 1e6;
  }

  async function paginaConsumo(el, _p, vivo) {
    const f = estado.consumo = estado.consumo || { periodo: "30", metrica: "custo" };
    const q = new URLSearchParams();
    if (f.periodo === "mes" || f.periodo === "mes_passado") q.set("atalho", f.periodo); else q.set("dias", f.periodo);
    const uso = await mk("uso?" + q);
    if (!vivo()) return;
    // O motor do WhatsApp recebe o mesmo período que o painel (versões antigas não têm esta rota).
    const mot = estado.org.conectada ? await eng(`usage?de=${uso.de}&ate=${uso.ate}`).catch(e => ({ erro: e.status === 404 ? "ANTIGO" : e.message })) : null;
    if (!vivo()) return;
    const oficial = uso.tem_chave_admin && pode("ADMIN") ? await mk(`uso/openai-oficial?de=${uso.de}&ate=${uso.ate}`).catch(e => ({ erro: e.message })) : null;
    if (!vivo()) return;
    const moeda = uso.moeda || "BRL", cot = moeda === "USD" ? 1 : Number(uso.cotacao) || 1;
    const emMoeda = usd => dinheiro(usd * cot, moeda);
    const precos = uso.precos || {};

    // Linhas do painel + linhas do motor (WhatsApp) no mesmo formato.
    const linhas = (uso.linhas || []).slice();
    const iaMotor = mot && !mot.erro ? (mot.ia || []) : [];
    for (const r of iaMotor) linhas.push({ dia: r.dia, servico: "openai", operacao: r.operacao, recurso: "whatsapp/motor", modelo: r.modelo, chamadas: r.chamadas, erros: r.erros, limitadas: 0, tokens_entrada: r.tokens_entrada, tokens_saida: r.tokens_saida, tokens_cache: r.tokens_cache, imagens: 0, caracteres: 0, custo_usd: custoTokens(precos, r.modelo, r.tokens_entrada, r.tokens_cache, r.tokens_saida), ms_total: 0 });
    const soma = (filtro, campo) => linhas.filter(filtro).reduce((s, l) => s + (Number(l[campo]) || 0), 0);
    const ehIA = l => l.servico === "openai" || l.servico === "elevenlabs", ehMeta = l => l.servico === "meta", ehGoogle = l => l.servico === "google";
    const custoIA = soma(ehIA, "custo_usd");
    const metaPontos = mot && !mot.erro && mot.meta && mot.meta.pontos ? mot.meta.pontos : [];
    const custoWhats = metaPontos.reduce((s, p) => s + p.custo, 0);
    const recebidas = mot && !mot.erro ? (mot.mensagens?.recebidas || []).reduce((s, x) => s + x.n, 0) : 0;
    const enviadas = mot && !mot.erro ? (mot.mensagens?.enviadas || []).reduce((s, x) => s + x.n, 0) : 0;
    const ant = Object.fromEntries((uso.anterior?.servicos || []).map(s => [s.servico, s]));

    // Período (uma linha acima de tudo).
    const recarregar = () => navegar();
    const PER = [["7", "7 dias"], ["30", "30 dias"], ["60", "60 dias"], ["90", "90 dias"], ["180", "6 meses"], ["365", "12 meses"], ["mes", "Este mês"], ["mes_passado", "Mês passado"]];
    el.appendChild(cabeca("Consumo e custos", `Quanto cada serviço usou e custou de ${dataCompleta(uso.de)} a ${dataCompleta(uso.ate)}: inteligência artificial (OpenAI), Meta (Instagram, Facebook e WhatsApp) e Google.`,
      botao("Baixar planilha", () => baixarCsv(`consumo-${uso.de}-a-${uso.ate}.csv`, [["Dia", "Serviço", "Recurso", "Tipo", "Modelo / detalhe", "Chamadas", "Erros", "Limitadas", "Tokens de entrada", "Tokens em cache", "Tokens de saída", "Imagens", "Custo estimado (USD)", `Custo estimado (${moeda})`],
        ...linhas.map(l => [dataCompleta(l.dia), NOME_SERVICO[l.servico] || l.servico, nomeRecurso(l.recurso), NOME_OPERACAO_IA[l.operacao] || l.operacao, l.modelo, l.chamadas, l.erros, l.limitadas, l.tokens_entrada, l.tokens_cache, l.tokens_saida, l.imagens, (Number(l.custo_usd) || 0).toFixed(6), ((Number(l.custo_usd) || 0) * cot).toFixed(4)])]), "btn-secundario btn-pequeno")));
    el.appendChild(h("section", { class: "cartao vidro filtros-desempenho" }, h("div", { class: "abas abas-chips", role: "group", "aria-label": "Período" },
      PER.map(([v, n]) => h("button", { type: "button", class: "aba" + (f.periodo === v ? " ativo" : ""), "aria-pressed": f.periodo === v ? "true" : "false", onclick: () => { f.periodo = v; recarregar(); } }, n)))));

    // Cartões (tocar troca o gráfico).
    const cartao = (k, rotulo, valor, sub) => h("button", { type: "button", class: "metrica vidro metrica-botao" + (f.metrica === k ? " ativo" : ""), "aria-pressed": f.metrica === k ? "true" : "false", onclick: () => { f.metrica = k; recarregar(); } }, h("span", { text: rotulo }), h("strong", { text: valor }), h("small", {}, sub));
    const comparar = (atual, antes) => { const v = variacaoPct(atual, antes); return v ? h("span", { class: v.zero ? "" : v.sobe ? "desce" : "sobe", text: v.texto + " " }) : null; }; // gastar mais é vermelho
    const custoAntes = ant.openai ? Number(ant.openai.custo_usd) || 0 : null;
    el.appendChild(h("section", { class: "grade grade-4" },
      cartao("custo", "IA — custo estimado", emMoeda(custoIA), [comparar(soma(l => ehIA(l) && l.recurso !== "whatsapp/motor", "custo_usd"), custoAntes), moeda !== "USD" ? `US$ ${custoIA.toFixed(2)} · ` : "", `${numero(soma(ehIA, "chamadas"))} chamadas`]),
      cartao("whatsapp", "WhatsApp — Meta", metaPontos.length ? (mot.meta.moeda ? dinheiro(custoWhats, mot.meta.moeda) : numero(custoWhats)) : numero(enviadas), metaPontos.length ? `${numero(metaPontos.reduce((s, p) => s + p.volume, 0))} mensagens cobradas` : `${numero(enviadas)} enviadas · ${numero(recebidas)} recebidas`),
      cartao("meta", "Meta — chamadas", numero(soma(ehMeta, "chamadas")), [comparar(soma(ehMeta, "chamadas"), ant.meta ? ant.meta.chamadas : null), `${numero(soma(ehMeta, "erros"))} com erro`]),
      cartao("google", "Google — chamadas", numero(soma(ehGoogle, "chamadas")), [comparar(soma(ehGoogle, "chamadas"), ant.google ? ant.google.chamadas : null), `${numero(soma(ehGoogle, "limitadas"))} barradas pela cota`])));

    // Gráfico dia a dia da métrica escolhida.
    const dias = [];
    for (let t = Date.parse(uso.de + "T00:00:00Z"); t <= Date.parse(uso.ate + "T00:00:00Z"); t += 86400000) dias.push(new Date(t).toISOString().slice(0, 10));
    const porDia = (filtro, campo, fator = 1) => dias.map(d => ({ data: d, valor: Math.round(linhas.filter(l => l.dia === d && filtro(l)).reduce((s, l) => s + (Number(l[campo]) || 0), 0) * fator * 100) / 100 }));
    const seriesDia = {
      custo: { nome: `Custo da IA (${moeda})`, pontos: porDia(ehIA, "custo_usd", cot) },
      whatsapp: { nome: metaPontos.length ? "Custo do WhatsApp" : "Mensagens enviadas no WhatsApp", pontos: metaPontos.length ? dias.map(d => ({ data: d, valor: Math.round(metaPontos.filter(p => p.dia === d).reduce((s, p) => s + p.custo, 0) * 100) / 100 })) : dias.map(d => ({ data: d, valor: (mot && !mot.erro ? (mot.mensagens?.enviadas || []).find(x => x.dia === d)?.n : 0) || 0 })) },
      meta: { nome: "Chamadas à Meta", pontos: porDia(ehMeta, "chamadas") },
      google: { nome: "Chamadas ao Google", pontos: porDia(ehGoogle, "chamadas") }
    };
    const s = seriesDia[f.metrica] || seriesDia.custo;
    const pontos = agruparSerie(s.pontos.map(p => ({ data: p.data, v: p.valor })), dias.length <= 92 ? "dia" : dias.length <= 370 ? "semana" : "mes", "v");
    el.appendChild(h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: s.nome }),
      pontos.some(p => p.valor) ? graficoLinha(pontos, null, s.nome, "") : vazio("Nada registrado neste período", "O consumo começa a ser contado a partir desta versão da plataforma.")));

    // OpenAI por recurso.
    const grupos = new Map();
    for (const l of linhas.filter(ehIA)) {
      const k = [l.recurso, l.operacao, l.modelo].join("|");
      const g = grupos.get(k) || { recurso: l.recurso, operacao: l.operacao, modelo: l.modelo, chamadas: 0, erros: 0, ent: 0, cache: 0, sai: 0, imagens: 0, custo: 0 };
      g.chamadas += l.chamadas; g.erros += l.erros; g.ent += l.tokens_entrada; g.cache += l.tokens_cache; g.sai += l.tokens_saida; g.imagens += l.imagens; g.custo += Number(l.custo_usd) || 0;
      grupos.set(k, g);
    }
    const listaIA = [...grupos.values()].sort((a, b) => b.custo - a.custo);
    el.appendChild(h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "Inteligência artificial (OpenAI) — onde foi usada" }),
      h("p", { class: "sub", text: "Estimativa pelos tokens que a OpenAI devolve em cada resposta e pela tabela de preços abaixo. O valor cobrado de verdade aparece em \"Fatura da OpenAI\"." }),
      listaIA.length ? h("div", { class: "tabela-caixa lista-rolavel" }, h("table", {}, h("thead", {}, h("tr", {}, ["Recurso", "Tipo", "Modelo", "Chamadas", "Tokens de entrada", "Tokens de saída", "Custo estimado"].map(t => h("th", { text: t })))),
        h("tbody", {}, listaIA.map(g => h("tr", {}, h("td", {}, h("strong", { text: nomeRecurso(g.recurso) })), h("td", { text: NOME_OPERACAO_IA[g.operacao] || g.operacao }), h("td", { text: g.modelo || "—" }),
          h("td", {}, numero(g.chamadas), g.erros ? h("span", { class: "sub", text: `${numero(g.erros)} com erro` }) : null), h("td", {}, numero(g.ent), g.cache ? h("span", { class: "sub", text: `${numero(g.cache)} em cache` }) : null),
          h("td", { text: g.imagens ? `${numero(g.sai)} · ${numero(g.imagens)} imagem(ns)` : numero(g.sai) }), h("td", { text: emMoeda(g.custo) })))))) : vazio("Nenhum uso da IA registrado no período")));

    // Fatura oficial da OpenAI (chave de administrador, só leitura).
    if (pode("ADMIN")) {
      const entrada = h("input", { class: "entrada", type: "password", placeholder: "sk-admin-…", autocomplete: "off" });
      el.appendChild(h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "Fatura da OpenAI (valor oficial)" }),
        oficial && oficial.configurada && !oficial.erro ? [
          h("section", { class: "grade grade-3" }, metrica("Cobrado no período", dinheiro(oficial.total_usd, "USD"), moeda !== "USD" ? `≈ ${emMoeda(oficial.total_usd)}` : ""), metrica("Estimativa da DENIA", emMoeda(custoIA), "Painel + WhatsApp"), metrica("Média por dia", dinheiro(oficial.total_usd / (uso.dias || 1), "USD"), "")),
          oficial.por_item.length ? h("div", { class: "tabela-caixa", style: "margin-top:12px" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "Item da fatura" }), h("th", { text: "Valor (USD)" }))),
            h("tbody", {}, oficial.por_item.map(x => h("tr", {}, h("td", { text: x.item }), h("td", { text: dinheiro(x.usd, "USD") })))))) : null,
          h("div", { class: "acoes", style: "margin-top:10px" }, botao("Remover chave de administrador", async () => { await mk("uso/chave-admin", { metodo: "POST", corpo: { remover: true } }); navegar(); }, "btn-secundario btn-pequeno"))]
          : [oficial && oficial.erro ? h("p", { class: "nota nota-alerta", text: oficial.erro }) : null,
            h("p", { class: "sub", text: "Para ver o valor exato cobrado (inclui o WhatsApp e tudo o que usa a sua conta), cole uma chave de administrador da OpenAI: platform.openai.com → Settings → Organization → Admin keys. Ela só lê custos e fica guardada cifrada." }),
            h("div", { class: "linha-form" }, campo("Chave de administrador", entrada)),
            h("div", { class: "acoes" }, botao("Salvar e ler a fatura", async () => { try { await mk("uso/chave-admin", { metodo: "POST", corpo: { chave: entrada.value } }); aviso("Chave salva.", "ok"); navegar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-primario"))]));
    }

    // WhatsApp (motor).
    const blocoWhats = h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "WhatsApp" }));
    if (!estado.org.conectada) blocoWhats.appendChild(h("p", { class: "sub", text: "A IA do WhatsApp ainda não está conectada (Integrações)." }));
    else if (mot.erro === "ANTIGO") blocoWhats.appendChild(h("p", { class: "nota nota-alerta", text: "O motor do WhatsApp ainda está numa versão antiga. Cole a versão 31.1 no Worker \"denia\" para ver aqui o consumo da IA e as mensagens do WhatsApp." }));
    else if (mot.erro) blocoWhats.appendChild(h("p", { class: "nota nota-alerta", text: mot.erro }));
    else {
      blocoWhats.appendChild(h("section", { class: "grade grade-3" }, metrica("Mensagens recebidas", numero(recebidas), "Clientes e profissionais"), metrica("Mensagens enviadas", numero(enviadas), "Pela DENIA e pela equipe"),
        metrica("IA no WhatsApp", emMoeda(linhas.filter(l => l.recurso === "whatsapp/motor").reduce((t, l) => t + l.custo_usd, 0)), `${numero(iaMotor.reduce((t, r) => t + r.chamadas, 0))} respostas e áudios lidos`)));
      if (metaPontos.length) {
        const porCat = new Map();
        for (const p of metaPontos) { const c = porCat.get(p.categoria) || { volume: 0, custo: 0 }; c.volume += p.volume; c.custo += p.custo; porCat.set(p.categoria, c); }
        const NOME_CAT = { MARKETING: "Marketing", UTILITY: "Utilidade", AUTHENTICATION: "Autenticação", SERVICE: "Atendimento (serviço)", MARKETING_LITE: "Marketing leve", AUTHENTICATION_INTERNATIONAL: "Autenticação internacional" };
        blocoWhats.appendChild(h("div", { class: "tabela-caixa", style: "margin-top:12px" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "Categoria cobrada pela Meta" }), h("th", { text: "Mensagens" }), h("th", { text: "Custo" }))),
          h("tbody", {}, [...porCat.entries()].map(([c, v]) => h("tr", {}, h("td", { text: NOME_CAT[c] || c }), h("td", { text: numero(v.volume) }), h("td", { text: mot.meta.moeda ? dinheiro(v.custo, mot.meta.moeda) : numero(v.custo) })))))));
      } else if (mot.meta) blocoWhats.appendChild(h("p", { class: mot.meta.erro ? "nota nota-alerta" : "sub", style: "margin-top:10px", text: mot.meta.erro ? "A Meta não devolveu o custo do WhatsApp: " + mot.meta.erro : mot.meta.ajuda || "A Meta não cobrou mensagens neste período (respostas dentro de 24 h são grátis)." }));
    }
    el.appendChild(blocoWhats);

    // Meta: limites (porcentagem usada na última hora) e chamadas.
    const lims = (uso.limites || []).filter(l => l.servico === "meta");
    const barra = (rotulo, pct) => h("div", { class: "limite-linha" }, h("span", { text: rotulo }), h("div", { class: "barra-parte barra-limite" + (pct >= 80 ? " perigo" : pct >= 50 ? " atencao" : "") }, h("i", { style: `width:${Math.min(100, Math.max(0, pct))}%` })), h("strong", { text: `${Math.round(pct)}%` }));
    const blocoMeta = h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "Meta — limites e chamadas" }),
      h("p", { class: "sub", text: "A Meta deixa cada app fazer um número de chamadas por hora. Acima de 100% ela bloqueia por alguns minutos; a DENIA tenta de novo sozinha." }));
    if (!lims.length) blocoMeta.appendChild(h("p", { class: "sub", text: "Ainda sem leitura de limite: aparece depois da primeira publicação ou conexão com a Meta." }));
    for (const l of lims) {
      const quando = fmtDataHora.format(new Date(l.atualizado_ms));
      if (l.chave === "app" && l.dados) blocoMeta.appendChild(h("div", { class: "limite-bloco" }, h("strong", { text: `App DENIA (lido em ${quando})` }), barra("Chamadas", l.dados.call_count || 0), barra("Processamento", l.dados.total_cputime || 0), barra("Tempo", l.dados.total_time || 0)));
      else if (l.chave.startsWith("buc:") && Array.isArray(l.dados)) for (const d of l.dados) blocoMeta.appendChild(h("div", { class: "limite-bloco" }, h("strong", { text: `${d.type || "Conta"} ${l.chave.slice(4)} (lido em ${quando})` }), barra("Chamadas", d.call_count || 0), barra("Processamento", d.total_cputime || 0), barra("Tempo", d.total_time || 0),
        d.estimated_time_to_regain_access ? h("p", { class: "nota nota-alerta", text: `Bloqueado pela Meta: libera em cerca de ${d.estimated_time_to_regain_access} minuto(s).` }) : null));
    }
    const porOp = (filtro) => { const m = new Map(); for (const l of linhas.filter(filtro)) { const k = l.operacao + "|" + l.modelo; const g = m.get(k) || { operacao: l.operacao, modelo: l.modelo, chamadas: 0, erros: 0, limitadas: 0, ms: 0 }; g.chamadas += l.chamadas; g.erros += l.erros; g.limitadas += l.limitadas; g.ms += l.ms_total; m.set(k, g); } return [...m.values()].sort((a, b) => b.chamadas - a.chamadas); };
    const listaMeta = porOp(ehMeta);
    if (listaMeta.length) blocoMeta.appendChild(h("div", { class: "tabela-caixa", style: "margin-top:12px" }, h("table", {}, h("thead", {}, h("tr", {}, ["Chamada", "Vezes", "Erros", "Barradas por limite", "Tempo médio"].map(t => h("th", { text: t })))),
      h("tbody", {}, listaMeta.map(g => h("tr", {}, h("td", { text: g.operacao }), h("td", { text: numero(g.chamadas) }), h("td", { text: numero(g.erros) }), h("td", { text: numero(g.limitadas) }), h("td", { text: g.chamadas ? `${numero(Math.round(g.ms / g.chamadas))} ms` : "—" })))))));
    el.appendChild(blocoMeta);

    // Google: chamadas por API e cota.
    const cotas = uso.cotas_google || {};
    const porApi = new Map();
    for (const l of linhas.filter(ehGoogle)) { const g = porApi.get(l.operacao) || { chamadas: 0, erros: 0, limitadas: 0, pico: 0 }; g.chamadas += l.chamadas; g.erros += l.erros; g.limitadas += l.limitadas; porApi.set(l.operacao, g); }
    el.appendChild(h("section", { class: "cartao vidro" }, h("h3", { style: "margin-top:0", text: "Google — chamadas e cotas" }),
      h("p", { class: "sub", text: "As APIs do Google Perfil da Empresa não cobram por chamada; o limite é a cota por minuto do projeto (veja e peça aumento em console.cloud.google.com → APIs e serviços → Cotas)." }),
      porApi.size ? h("div", { class: "tabela-caixa" }, h("table", {}, h("thead", {}, h("tr", {}, ["API", "Chamadas", "Média por dia", "Erros", "Barradas pela cota", "Cota por minuto"].map(t => h("th", { text: t })))),
        h("tbody", {}, [...porApi.entries()].map(([api, g]) => h("tr", {}, h("td", { text: (cotas[api] || {}).nome || api }), h("td", { text: numero(g.chamadas) }), h("td", { text: numero(Math.round(g.chamadas / (uso.dias || 1))) }), h("td", { text: numero(g.erros) }),
          h("td", {}, g.limitadas ? h("span", { class: "desce", text: numero(g.limitadas) }) : "0"), h("td", { text: (cotas[api] || {}).por_minuto ? numero(cotas[api].por_minuto) : "—" }))))))
        : vazio("Nenhuma chamada ao Google no período")));

    // Preços usados na estimativa (administradores).
    if (pode("ADMIN")) {
      const moedaE = h("select", { class: "entrada" }, MOEDAS.map(m => h("option", { value: m, selected: m === moeda, text: m })));
      const cotE = h("input", { class: "entrada", type: "number", min: "0", step: "0.0001", value: String(uso.cotacao || 5.4) });
      const linhasP = Object.entries(precos).map(([m, p]) => ({ m, p }));
      const corpoT = h("tbody", {});
      const linhaPreco = ({ m, p }) => {
        const n = h("input", { class: "entrada", value: m, "aria-label": "Modelo" });
        const c = k => h("input", { class: "entrada entrada-preco", type: "number", min: "0", step: "0.001", value: p[k] != null ? String(p[k]) : "", "aria-label": k });
        const ent = c("entrada"), cac = c("cache"), sai = c("saida");
        const tr = h("tr", {}, h("td", {}, n), h("td", {}, ent), h("td", {}, cac), h("td", {}, sai), h("td", {}, botao("×", () => tr.remove(), "btn-secundario btn-pequeno", { "aria-label": "Remover" })));
        tr.ler = () => ({ nome: n.value.trim(), v: { ...p, entrada: ent.value, cache: cac.value, saida: sai.value } });
        return tr;
      };
      linhasP.forEach(x => corpoT.appendChild(linhaPreco(x)));
      el.appendChild(h("details", { class: "cartao vidro" }, h("summary", { text: "Preços e moeda usados na estimativa" }),
        h("p", { class: "sub", text: "Dólares por 1 milhão de tokens. O modelo vale para todos os que começam com o mesmo nome (\"*\" = qualquer outro). Ajuste quando a OpenAI mudar a tabela em openai.com/api/pricing." }),
        h("div", { class: "linha-form" }, campo("Moeda do painel", moedaE), campo("Cotação (1 dólar =)", cotE)),
        h("div", { class: "tabela-caixa" }, h("table", {}, h("thead", {}, h("tr", {}, ["Modelo", "Entrada", "Entrada em cache", "Saída", ""].map(t => h("th", { text: t })))), corpoT)),
        h("div", { class: "acoes", style: "margin-top:10px" },
          botao("Adicionar modelo", () => corpoT.appendChild(linhaPreco({ m: "", p: {} })), "btn-secundario btn-pequeno"),
          botao("Salvar preços", async () => { try { const precosN = {}; for (const tr of corpoT.children) { const { nome, v } = tr.ler(); if (nome) precosN[nome] = v; } await mk("uso/precos", { metodo: "POST", corpo: { precos: precosN, moeda: moedaE.value, cotacao: cotE.value } }); aviso("Preços salvos. Valem para as próximas chamadas.", "ok"); navegar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-primario btn-pequeno"),
          botao("Voltar ao padrão", async () => { await mk("uso/precos", { metodo: "POST", corpo: { restaurar: true, moeda: moedaE.value, cotacao: cotE.value } }); navegar(); }, "btn-secundario btn-pequeno"))));
    }
  }

  async function atualizarAprovacoes() {
    const c = $("contador-aprovacoes");
    if (!c || !estado.org) return;
    try {
      const r = await mk("resumo");
      c.textContent = r.aguardando > 99 ? "99+" : String(r.aguardando);
      c.classList.toggle("oculto", !r.aguardando);
    } catch { c.classList.add("oculto"); }
    // Avaliações do Google que precisam de uma pessoa: contador vermelho no menu.
    const g = $("contador-google");
    if (!g) return;
    try { const a = await mk("alertas"); g.textContent = a.avaliacoes > 99 ? "99+" : String(a.avaliacoes); g.classList.toggle("oculto", !a.avaliacoes); }
    catch { g.classList.add("oculto"); }
  }

  // ---------------------------------------------------------------------------
  // Assistente DENIA (texto e voz)
  // ---------------------------------------------------------------------------

  const assistente = { msgs: [], gravador: null, partes: [], audio: null, continua: false };
  const ICONE_MIC = '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
  function svgDe(marcacao) { const t = document.createElement("template"); t.innerHTML = marcacao; return t.content.firstChild; }

  function iniciarAssistente() {
    const painel = $("assistente"), orbe = $("denia-orbe");
    if (!painel || !orbe) return;
    const abrir = (sim) => { painel.classList.toggle("oculto", !sim); orbe.setAttribute("aria-expanded", sim ? "true" : "false"); orbe.classList.toggle("ativo", sim); if (sim) { $("assistente-texto").focus(); if (!assistente.msgs.length) mostrarMsg("denia", "Oi! Sou a DENIA. Escreva, grave um áudio para eu transcrever, ou converse comigo por voz. Posso criar posts e imagens, aprovar e mudar o meu treinamento — e você vê tudo acontecendo na tela."); } };
    assistente.abrirPainel = abrir;
    orbe.addEventListener("click", () => abrir(painel.classList.contains("oculto")));
    $("assistente-fechar").addEventListener("click", () => abrir(false));
    $("assistente-form").addEventListener("submit", e => { e.preventDefault(); const t = $("assistente-texto").value.trim(); if (t) { $("assistente-texto").value = ""; perguntar(t); } });
    $("assistente-mic").addEventListener("click", () => alternarGravacao("ditar", $("assistente-texto")));
    $("assistente-conversar").addEventListener("click", () => alternarAoVivo());
    const topo = $("falar-denia");
    // Um toque: abre a página da DENIA e já começa a conversa ao vivo.
    if (topo) topo.addEventListener("click", () => { const ligado = aoVivo.ativo || aoVivo.conectando || assistente.continua; if (!ligado && rotaAtual().nome !== "denia") location.hash = "#/denia"; alternarAoVivo(); });
    iniciarPiloto();
  }
  function mostrarMsg(papel, texto, extra) {
    ["assistente-msgs", "voz-msgs"].forEach(id => {
      const caixa = $(id);
      if (!caixa) return;
      caixa.appendChild(h("div", { class: "a-msg a-" + papel }, texto, extra ? extra.cloneNode(true) : null));
      caixa.scrollTop = caixa.scrollHeight;
    });
  }
  function mostrarErro(e) {
    const semChave = e && e.dados && e.dados.codigo === "SEM_OPENAI";
    mostrarMsg("erro", semChave ? "A inteligência da DENIA ainda está desligada: falta colar a chave da OpenAI. " : (e && e.message) || String(e),
      semChave ? h("a", { class: "a-link", href: "#/integracoes", text: "Colar a chave agora →" }) : null);
  }
  function estadoAssistente(t) {
    $("assistente-estado").textContent = t || "Escreva, grave ou converse por voz";
    const v = $("voz-estado");
    if (v) v.textContent = t || (aoVivo.ativo ? "Ao vivo — pode falar" : assistente.continua ? "Mãos livres ligado — fale quando quiser" : "Toque no microfone e fale");
    const orbe = $("voz-orbe");
    if (orbe) orbe.dataset.estado = !t ? "" : /Ouvindo|Gravando/.test(t) ? "ouvindo" : /Falando/.test(t) ? "falando" : "pensando";
  }
  const querVoz = () => ($("voz-pagina") && $("voz-falar") ? $("voz-falar").checked : $("assistente-falar").checked);

  async function perguntar(texto, origemVoz) {
    if (!estado.org) return;
    if (aoVivo.ativo) { falarAoVivo(texto); return; }
    assistente.msgs.push({ papel: "usuario", texto });
    mostrarMsg("usuario", texto);
    estadoAssistente("Pensando…");
    const naPaginaVoz = Boolean($("voz-pagina"));
    let plano = [];
    try {
      const r = await api(`/api/orgs/${estado.org.id}/assistente/conversa`, { metodo: "POST", corpo: { mensagens: assistente.msgs.filter(m => m.papel === "usuario" || m.papel === "denia").slice(-20), assistido: true } });
      assistente.msgs.push({ papel: "denia", texto: r.resposta });
      mostrarMsg("denia", r.resposta);
      plano = r.plano || [];
      const fala = querVoz() || origemVoz ? falar(r.resposta) : Promise.resolve();
      if (plano.length) {
        const resultados = await executarPlano(plano);
        await fala;
        const feitos = resultados.filter(x => x.ok).map(x => x.resumo), falhas = resultados.filter(x => !x.ok).map(x => x.resumo);
        const final = [feitos.length ? "Pronto. " + feitos.join(" ") : "", falhas.length ? "Não consegui: " + falhas.join(" ") : ""].filter(Boolean).join(" ");
        if (final) { assistente.msgs.push({ papel: "denia", texto: final }); if (querVoz() || origemVoz) await falar(final); }
        if (naPaginaVoz && !$("voz-pagina")) location.hash = "#/denia";
      } else await fala;
    } catch (e) { mostrarErro(e); assistente.continua = false; marcarContinua(); }
    finally { estadoAssistente(); }
    // Conversa contínua: depois de responder, a DENIA volta a ouvir sozinha.
    if (assistente.continua) { await esperarSimples(400); if (assistente.continua) alternarGravacao("voz"); }
  }
  const esperarSimples = ms => new Promise(r => setTimeout(r, ms));

  // Fala e só termina quando o áudio acaba.
  async function falar(texto, aoVivoRapido) {
    estadoAssistente("Falando…");
    try {
      const r = await fetch(`/api/orgs/${estado.org.id}/assistente/falar`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-denia": "1", "x-denia-idioma": IDIOMA }, body: JSON.stringify({ texto: texto.slice(0, 1500), ao_vivo: Boolean(aoVivoRapido) }) });
      if (!r.ok) throw new Error("voz indisponível");
      const url = URL.createObjectURL(await r.blob());
      if (assistente.audio) assistente.audio.pause();
      const audio = new Audio(url);
      assistente.audio = audio;
      await new Promise(fim => { audio.onended = audio.onerror = audio.onpause = fim; audio.play().catch(fim); });
      URL.revokeObjectURL(url);
    } catch {
      // Sem a voz da OpenAI, usa a voz do próprio aparelho.
      if (window.speechSynthesis) await new Promise(fim => { const u = new SpeechSynthesisUtterance(texto); u.lang = LOCALE; u.onend = u.onerror = fim; window.speechSynthesis.speak(u); setTimeout(fim, 60000); });
    }
    estadoAssistente();
  }
  function pararFala() {
    if (assistente.audio) assistente.audio.pause();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }
  function marcarContinua() {
    document.querySelectorAll(".mic-denia").forEach(b => b.classList.toggle("gravando", assistente.continua || aoVivo.ativo || aoVivo.conectando));
  }
  // Grava o microfone. modo "voz": envia e a DENIA responde falando. modo "ditar": só transcreve para a caixa de texto.
  async function alternarGravacao(modo = "voz", caixa) {
    const botoes = () => document.querySelectorAll(modo === "ditar" ? ".mic-ditar" : ".mic-denia");
    if (assistente.gravador && assistente.gravador.state === "recording") { assistente.gravador.stop(); return; }
    pararFala();
    if (!navigator.mediaDevices || !window.MediaRecorder) { aviso("Este navegador não permite gravar áudio. Digite a mensagem.", "erro"); return; }
    let fluxo;
    try { fluxo = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { aviso("Permita o uso do microfone para falar com a DENIA (no cadeado ao lado do endereço do site).", "erro"); assistente.continua = false; marcarContinua(); return; }
    assistente.partes = [];
    const g = new MediaRecorder(fluxo);
    assistente.gravador = g;
    let ctx = null;
    g.ondataavailable = e => { if (e.data.size) assistente.partes.push(e.data); };
    g.onstop = async () => {
      fluxo.getTracks().forEach(t => t.stop());
      if (ctx) ctx.close().catch(() => {});
      botoes().forEach(m => m.classList.remove("gravando"));
      const blob = new Blob(assistente.partes, { type: g.mimeType || "audio/webm" });
      if (blob.size < 1200) { estadoAssistente(); return; }
      estadoAssistente("Transcrevendo…");
      try {
        const r = await fetch(`/api/orgs/${estado.org.id}/assistente/transcrever`, { method: "POST", credentials: "same-origin", headers: { "content-type": blob.type, "x-denia": "1", "x-denia-idioma": IDIOMA }, body: blob });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw Object.assign(new Error(d.erro || "Não consegui entender o áudio."), { dados: d });
        if (!d.texto) { estadoAssistente(); if (modo === "voz" && assistente.continua) alternarGravacao("voz"); return; }
        if (modo === "ditar") {
          const alvo = caixa && caixa.isConnected ? caixa : $("assistente-texto");
          alvo.value = (alvo.value.trim() ? alvo.value.trimEnd() + " " : "") + d.texto;
          alvo.focus(); estadoAssistente();
        } else await perguntar(d.texto, true);
      } catch (e) { mostrarErro(e); estadoAssistente(); assistente.continua = false; marcarContinua(); }
    };
    g.start();
    botoes().forEach(m => m.classList.add("gravando"));
    estadoAssistente(modo === "ditar" ? "Gravando… toque de novo para transcrever" : assistente.continua ? "Ouvindo… pode falar" : "Ouvindo… toque no microfone para enviar");
    // Mãos livres: envia sozinho depois de 1,6 s de silêncio após a fala.
    if (modo === "voz" && assistente.continua && (window.AudioContext || window.webkitAudioContext)) {
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        const an = ctx.createAnalyser(); an.fftSize = 1024;
        ctx.createMediaStreamSource(fluxo).connect(an);
        const buf = new Uint8Array(an.fftSize);
        let falou = false, silencio = 0, ultimo = performance.now();
        const medir = () => {
          if (g.state !== "recording") return;
          an.getByteTimeDomainData(buf);
          let soma = 0; for (const v of buf) soma += (v - 128) * (v - 128);
          const nivel = Math.sqrt(soma / buf.length);
          const agora = performance.now(), dt = agora - ultimo; ultimo = agora;
          if (nivel > 6) { falou = true; silencio = 0; } else if (falou) silencio += dt;
          if (falou && silencio > 1600) { g.stop(); return; }
          requestAnimationFrame(medir);
        };
        requestAnimationFrame(medir);
      } catch { /* sem detecção de silêncio: toque no microfone para enviar */ }
    }
    setTimeout(() => { if (g.state === "recording") g.stop(); }, 120000);
  }

  // ---------------------------------------------------------------------------
  // Conversa ao vivo (voz em tempo real): toca uma vez e conversa, como no ChatGPT.
  // A DENIA ouve, responde falando, pode ser interrompida, pesquisa e age na tela.
  // ---------------------------------------------------------------------------

  const aoVivo = { ativo: false, conectando: false, pc: null, dc: null, fluxo: null, audio: null, ultimoUsuario: "" };
  function marcarAoVivo() {
    const ligado = aoVivo.ativo || aoVivo.conectando;
    document.body.classList.toggle("ao-vivo", aoVivo.ativo);
    document.querySelectorAll(".mic-denia").forEach(b => { b.classList.toggle("gravando", ligado); b.setAttribute("aria-label", ligado ? "Encerrar a conversa ao vivo" : "Conversar ao vivo"); });
    const rot = $("voz-rotulo");
    if (rot) rot.textContent = aoVivo.conectando ? "Conectando…" : aoVivo.ativo ? "Toque para encerrar" : "Toque para conversar ao vivo";
    const topo = $("falar-denia");
    if (topo) { topo.classList.toggle("ativo", ligado); const sp = topo.querySelector("span"); if (sp) sp.textContent = ligado ? "Encerrar conversa" : "Falar com a DENIA"; }
  }
  async function alternarAoVivo() {
    if (aoVivo.ativo || aoVivo.conectando || assistente.continua) { pararAoVivo(); return; }
    if (!estado.org) return;
    if (!window.RTCPeerConnection || !navigator.mediaDevices) { iniciarMaosLivres(); return; }
    pararFala();
    aoVivo.conectando = true; marcarAoVivo(); estadoAssistente("Conectando a voz ao vivo…");
    try {
      const fluxo = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
        .catch(() => { throw new Error("Permita o uso do microfone para conversar com a DENIA (no cadeado ao lado do endereço do site)."); });
      aoVivo.fluxo = fluxo;
      const s = await api(`/api/orgs/${estado.org.id}/assistente/ao-vivo`, { metodo: "POST", corpo: {} });
      aoVivo.modelo = s.modelo || "";
      aoVivo.minhaVoz = Boolean(s.minha_voz); // a conversa ao vivo devolve texto e o painel fala com a voz da pessoa
      if (!aoVivo.conectando) { fluxo.getTracks().forEach(t => t.stop()); return; }
      const pc = new RTCPeerConnection();
      aoVivo.pc = pc;
      const audio = new Audio(); audio.autoplay = true; aoVivo.audio = audio;
      pc.ontrack = e => { audio.srcObject = e.streams[0]; };
      pc.addTrack(fluxo.getTracks()[0], fluxo);
      const dc = pc.createDataChannel("oai-events");
      aoVivo.dc = dc;
      dc.onmessage = e => { try { eventoAoVivo(JSON.parse(e.data)); } catch { /* evento desconhecido */ } };
      dc.onopen = () => {
        // A DENIA começa cumprimentando, como numa ligação.
        enviarAoVivo({ type: "response.create", response: { instructions: "Cumprimente em uma frase curta e pergunte como pode ajudar." } });
      };
      pc.onconnectionstatechange = () => { if (["failed", "closed", "disconnected"].includes(pc.connectionState) && aoVivo.ativo) { mostrarMsg("erro", "A conversa ao vivo caiu. Toque no microfone para voltar."); pararAoVivo(); } };
      const oferta = await pc.createOffer();
      await pc.setLocalDescription(oferta);
      const r = await fetch(s.url, { method: "POST", body: oferta.sdp, headers: { authorization: "Bearer " + s.chave, "content-type": "application/sdp" } });
      if (!r.ok) throw new Error("A voz ao vivo da OpenAI não aceitou a conexão (" + r.status + ").");
      await pc.setRemoteDescription({ type: "answer", sdp: await r.text() });
      aoVivo.conectando = false; aoVivo.ativo = true; marcarAoVivo();
      estadoAssistente("Ao vivo — pode falar");
    } catch (e) {
      const semChave = e && e.dados && e.dados.codigo === "SEM_OPENAI";
      pararAoVivo();
      if (semChave) { mostrarErro(e); return; }
      // Sem a voz em tempo real, conversa mãos livres: ouve, envia sozinho no silêncio e responde falando.
      mostrarMsg("erro", (e && e.message ? e.message + " " : "") + "Vou conversar no modo mãos livres: fale normalmente, eu envio sozinha quando você parar de falar.");
      iniciarMaosLivres();
    }
  }
  function pararAoVivo() {
    aoVivo.ativo = false; aoVivo.conectando = false;
    try { if (aoVivo.dc) aoVivo.dc.close(); } catch { /* já fechado */ }
    try { if (aoVivo.pc) aoVivo.pc.close(); } catch { /* já fechado */ }
    if (aoVivo.fluxo) aoVivo.fluxo.getTracks().forEach(t => t.stop());
    if (aoVivo.audio) { aoVivo.audio.srcObject = null; }
    aoVivo.pc = aoVivo.dc = aoVivo.fluxo = aoVivo.audio = null;
    if (assistente.continua) { assistente.continua = false; if (assistente.gravador && assistente.gravador.state === "recording") assistente.gravador.stop(); }
    marcarAoVivo(); estadoAssistente();
  }
  function iniciarMaosLivres() {
    assistente.continua = true; marcarAoVivo();
    document.querySelectorAll(".mic-denia").forEach(b => b.classList.add("gravando"));
    alternarGravacao("voz");
  }
  function enviarAoVivo(ev) { if (aoVivo.dc && aoVivo.dc.readyState === "open") aoVivo.dc.send(JSON.stringify(ev)); }
  // Texto digitado durante a conversa ao vivo entra na mesma conversa.
  function falarAoVivo(texto) {
    assistente.msgs.push({ papel: "usuario", texto }); mostrarMsg("usuario", texto);
    enviarAoVivo({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: texto }] } });
    enviarAoVivo({ type: "response.create" });
  }
  function eventoAoVivo(ev) {
    const t = ev.type || "";
    if (t === "input_audio_buffer.speech_started") { if (aoVivo.minhaVoz) pararFala(); estadoAssistente("Ouvindo…"); return; }
    if (aoVivo.minhaVoz && (t === "response.output_text.done" || t === "response.text.done") && ev.text) {
      assistente.msgs.push({ papel: "denia", texto: ev.text }); mostrarMsg("denia", ev.text); falar(ev.text, true); return;
    }
    if (t === "input_audio_buffer.speech_stopped") { estadoAssistente("Pensando…"); return; }
    if (t === "output_audio_buffer.started") { estadoAssistente("Falando… (pode interromper)"); return; }
    if (t === "response.done" && ev.response && ev.response.usage) mk("uso/realtime", { metodo: "POST", corpo: { usage: ev.response.usage, modelo: aoVivo.modelo || "" } }).catch(() => {});
    if (t === "output_audio_buffer.stopped" || t === "response.done") { if (!piloto.ativo) estadoAssistente(aoVivo.ativo ? "Ao vivo — pode falar" : ""); if (t === "output_audio_buffer.stopped") return; }
    if (t === "conversation.item.input_audio_transcription.completed" && ev.transcript && ev.transcript.trim()) {
      const texto = ev.transcript.trim();
      assistente.msgs.push({ papel: "usuario", texto }); mostrarMsg("usuario", texto); return;
    }
    if ((t === "response.output_audio_transcript.done" || t === "response.audio_transcript.done") && ev.transcript) {
      assistente.msgs.push({ papel: "denia", texto: ev.transcript }); mostrarMsg("denia", ev.transcript); return;
    }
    if (t === "response.function_call_arguments.done") { ferramentaAoVivo(ev); return; }
    if (t === "error" && ev.error) { console.warn("ao vivo", ev.error); if (!/cancel/i.test(ev.error.code || "")) mostrarMsg("erro", ev.error.message || "Erro na conversa ao vivo."); }
  }
  async function ferramentaAoVivo(ev) {
    let saida;
    try {
      const args = JSON.parse(ev.arguments || "{}");
      if (ev.name === "pesquisar_web") {
        estadoAssistente("Pesquisando na internet…");
        mostrarMsg("acao", "🔎 Pesquisando: " + (args.pergunta || ""));
        saida = await api(`/api/orgs/${estado.org.id}/assistente/pesquisar`, { metodo: "POST", corpo: { pergunta: args.pergunta } });
      } else if (ev.name === "dados_do_painel") {
        estadoAssistente("Olhando o painel…");
        saida = await api(`/api/orgs/${estado.org.id}/assistente/contexto`, { metodo: "POST", corpo: {} });
      } else {
        const prep = await api(`/api/orgs/${estado.org.id}/assistente/preparar`, { metodo: "POST", corpo: { acao: { tipo: ev.name, ...args } } });
        const naPaginaVoz = Boolean($("voz-pagina"));
        const [r] = await executarPlano([prep]);
        saida = r || { ok: false, resumo: "Não consegui." };
        if (naPaginaVoz && !$("voz-pagina")) setTimeout(() => { location.hash = "#/denia"; }, 1800);
      }
    } catch (e) { saida = { ok: false, erro: e.message }; }
    enviarAoVivo({ type: "conversation.item.create", item: { type: "function_call_output", call_id: ev.call_id, output: JSON.stringify(saida).slice(0, 12000) } });
    enviarAoVivo({ type: "response.create" });
  }

  // ---------------------------------------------------------------------------
  // Piloto: a DENIA executa as ações na tela, à vista, e pode ser pausada ou parada.
  // ---------------------------------------------------------------------------

  const piloto = { ativo: false, pausado: false, parar: false, erros: [], soltar: null };
  class PilotoParado extends Error {}
  function iniciarPiloto() {
    const barra = h("div", { class: "piloto oculto", id: "piloto", role: "status", "aria-live": "polite" },
      h("span", { class: "piloto-orbe" }),
      h("div", { class: "piloto-texto" }, h("strong", { text: "DENIA está trabalhando" }), h("span", { id: "piloto-passo", text: "" })),
      h("div", { class: "piloto-acoes" },
        h("button", { class: "btn btn-secundario btn-pequeno", type: "button", id: "piloto-pausar", onclick: () => pausarPiloto(!piloto.pausado) }, "Pausar"),
        h("button", { class: "btn btn-perigo btn-pequeno", type: "button", id: "piloto-parar", onclick: pararPiloto }, "Parar")));
    const cursor = h("div", { class: "cursor-denia oculto", id: "cursor-denia", "aria-hidden": "true" }, h("span", { class: "cursor-rotulo", text: "DENIA" }));
    cursor.prepend(svgDe('<svg viewBox="0 0 24 24"><path d="M4 2l15 9-6.5 1.6L9 19z"/></svg>'));
    document.body.append(barra, cursor);
  }
  function pausarPiloto(sim) {
    piloto.pausado = sim;
    $("piloto-pausar").textContent = sim ? "Retomar" : "Pausar";
    $("piloto").classList.toggle("pausado", sim);
    if (sim) $("piloto-passo").dataset.antes = $("piloto-passo").textContent, $("piloto-passo").textContent = "Pausada — toque em Retomar para continuar";
    else { $("piloto-passo").textContent = $("piloto-passo").dataset.antes || ""; if (piloto.soltar) { piloto.soltar(); piloto.soltar = null; } }
  }
  function pararPiloto() { piloto.parar = true; if (piloto.pausado) pausarPiloto(false); }
  // Todo passo passa por aqui: respeita a pausa e a parada.
  async function checar() {
    if (piloto.parar) throw new PilotoParado("Parado por você.");
    while (piloto.pausado) await new Promise(r => { piloto.soltar = r; });
    if (piloto.parar) throw new PilotoParado("Parado por você.");
  }
  async function espera(ms) { const fim = Date.now() + ms; while (Date.now() < fim) { await checar(); await esperarSimples(Math.min(80, fim - Date.now())); } await checar(); }
  async function passo(texto) { await checar(); if (!piloto.pausado) $("piloto-passo").textContent = texto; estadoAssistente(texto); }
  function visivel(el) { if (!el || !el.isConnected) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth; }
  async function esperarEl(achar, ms = 20000) {
    const fim = Date.now() + ms;
    while (Date.now() < fim) { await checar(); const el = achar(); if (el && el.isConnected) return el; await esperarSimples(120); }
    throw new Error("A tela demorou para responder.");
  }
  const porTexto = (raiz, seletor, texto) => [...(raiz || document).querySelectorAll(seletor)].find(b => (b.textContent || "").includes(texto) && visivel(b));
  async function moverPara(el) {
    await checar();
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    await espera(380);
    const r = el.getBoundingClientRect(), c = $("cursor-denia");
    c.classList.remove("oculto");
    c.style.transform = `translate(${Math.round(r.left + Math.min(r.width / 2, 60))}px, ${Math.round(r.top + r.height / 2)}px)`;
    await espera(650);
  }
  async function clicar(el) {
    await moverPara(el);
    const c = $("cursor-denia");
    c.classList.add("clicando"); el.classList.add("piloto-alvo");
    await espera(240);
    c.classList.remove("clicando");
    el.click();
    setTimeout(() => el.classList.remove("piloto-alvo"), 700);
    await espera(250);
  }
  async function escolher(sel, valor) {
    if (String(sel.value) === String(valor)) return;
    await moverPara(sel); sel.classList.add("piloto-alvo");
    await espera(300);
    sel.value = String(valor); sel.dispatchEvent(new Event("change", { bubbles: true }));
    await espera(300); sel.classList.remove("piloto-alvo");
  }
  async function digitar(el, texto) {
    await moverPara(el); el.focus(); el.classList.add("piloto-alvo");
    const passoChars = Math.max(1, Math.ceil(texto.length / 160)); // no máximo uns 5 segundos
    for (let i = 0; i < texto.length; i += passoChars) {
      await checar();
      el.value += texto.slice(i, i + passoChars);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      if (el.tagName === "TEXTAREA") el.scrollTop = el.scrollHeight;
      await esperarSimples(28);
    }
    el.classList.remove("piloto-alvo");
  }
  async function esperarPagina(rota, ms = 25000) {
    await espera(250);
    await esperarEl(() => rotaAtual().nome === rota && !$("conteudo").querySelector(".carregando, .esqueleto") && $("conteudo").firstChild ? $("conteudo") : null, ms);
    await espera(350);
  }
  async function abrirMenu(rota) {
    const link = document.querySelector(`#lateral-nav a[data-rota="${rota}"]`);
    if (!link) { location.hash = "#/" + rota; return esperarPagina(rota); }
    if (!visivel(link)) { const b = $("abrir-menu"); if (visivel(b)) { await clicar(b); await espera(350); } }
    if (rotaAtual().nome === rota) { await moverPara(link); navegar(); }
    else await clicar(link);
    await esperarPagina(rota);
  }
  async function esperarBotaoLivre(b, ms = 240000) {
    const fim = Date.now() + ms;
    await esperarSimples(300);
    while (Date.now() < fim && b.isConnected && b.disabled) { await esperarSimples(400); if (!piloto.pausado && !piloto.parar) $("piloto-passo").textContent = b.textContent; }
  }
  // Ponto de pausa dentro de processos longos (ex.: as artes de cada post).
  async function pontoDoPiloto() {
    if (!piloto.ativo) return false;
    try { await checar(); return false; } catch { return true; }
  }

  async function executarPlano(plano) {
    const resultados = [];
    piloto.ativo = true; piloto.parar = false; piloto.pausado = false; piloto.erros = [];
    $("piloto").classList.remove("oculto", "pausado"); $("piloto-pausar").textContent = "Pausar";
    document.body.classList.add("pilotando");
    const painelAberto = !$("assistente").classList.contains("oculto");
    if (painelAberto && innerWidth < 1200) assistente.abrirPainel(false);
    try {
      for (const a of plano) {
        if (a.erro) { resultados.push({ ok: false, resumo: a.erro }); mostrarMsg("erro", "✕ " + a.erro); continue; }
        piloto.erros = [];
        let r;
        try { r = await (ROTEIROS[a.tipo] || roteiroServidor)(a); }
        catch (e) {
          if (e instanceof PilotoParado) { r = { ok: false, resumo: "Parei onde estava, como você pediu." }; resultados.push(r); mostrarMsg("erro", "■ " + r.resumo); break; }
          r = { ok: false, resumo: e.message || "Não consegui terminar." };
        }
        if (r.ok && piloto.erros.length) r = { ok: false, resumo: piloto.erros[0] };
        resultados.push(r);
        mostrarMsg(r.ok ? "acao" : "erro", (r.ok ? "✓ " : "✕ ") + r.resumo);
        assistente.msgs.push({ papel: r.ok ? "acao" : "erro", texto: (r.ok ? "✓ " : "✕ ") + r.resumo });
      }
    } finally {
      piloto.ativo = false; piloto.parar = false;
      document.body.classList.remove("pilotando");
      $("piloto").classList.add("oculto"); $("cursor-denia").classList.add("oculto");
      document.querySelectorAll(".piloto-alvo").forEach(x => x.classList.remove("piloto-alvo"));
      if (painelAberto && $("assistente").classList.contains("oculto")) assistente.abrirPainel(true);
      atualizarAprovacoes();
    }
    return resultados;
  }
  async function roteiroServidor(a) {
    return api(`/api/orgs/${estado.org.id}/assistente/executar`, { metodo: "POST", corpo: { acao: a } });
  }
  const paginaDoCanal = canais => canais.length === 1 ? (canais[0] === "google" ? "google" : canais[0]) : "estudio";
  async function prepararCriador(a, comArtes) {
    const pagina = paginaDoCanal(a.canais);
    await passo(`Abrindo ${({ estudio: "o Estúdio de Marketing", instagram: "o Instagram", facebook: "o Facebook", google: "o Google Meu Negócio" })[pagina]}`);
    await abrirMenu(pagina);
    const cartao = await esperarEl(() => document.querySelector(".criador .criador-cartao"));
    const [selMarca, selSemana] = cartao.querySelectorAll("select");
    await passo(`Escolhendo a marca ${a.marca}`);
    await escolher(selMarca, a.marca_id);
    return { cartao, selSemana, comArtes };
  }
  const ROTEIROS = {
    async treinar(a) {
      if (!pode("ADMIN")) return { ok: false, resumo: "Seu perfil não pode mudar o treinamento. Peça a um administrador." };
      await passo("Abrindo Treinar IA");
      await abrirMenu("treinamento");
      const aba = await esperarEl(() => document.querySelector(`.aba[data-campo="${a.campo}"]`));
      await passo(`Abrindo a aba ${a.rotulo}`);
      await clicar(aba);
      const ta = await esperarEl(() => $("treino-" + a.campo));
      if (a.modo === "substituir") {
        await passo(`Reescrevendo ${a.rotulo}`);
        await moverPara(ta); ta.select(); await espera(500);
        ta.value = ""; ta.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        await passo(`Escrevendo em ${a.rotulo}`);
        if (ta.value.trim()) { ta.value = ta.value.trimEnd() + "\n\n"; ta.dispatchEvent(new Event("input", { bubbles: true })); }
      }
      await digitar(ta, a.texto);
      await passo("Salvando o treinamento");
      const salvar = await esperarEl(() => porTexto(document, "button", "Salvar treinamento"));
      await clicar(salvar);
      await esperarEl(() => !salvar.isConnected ? document.body : null, 30000).catch(() => null);
      await esperarPagina("treinamento");
      const t = await eng("training", { fresco: true }).catch(() => null);
      const ok = t && String((t.dados || {})[a.campo] || "").includes(a.texto.slice(0, 60));
      return ok ? { ok: true, resumo: `Treinamento atualizado em ${a.rotulo} (versão ${t.versao}).` } : { ok: false, resumo: "O treinamento não foi salvo." };
    },
    async criar_semana(a) {
      const { cartao, selSemana } = await prepararCriador(a);
      await passo("Escolhendo a semana");
      await escolher(selSemana, a.semana === "esta" ? "0" : "7");
      const qtd = cartao.querySelector('input[type="number"]');
      await passo(`Quantidade: ${a.quantidade} posts`);
      await moverPara(qtd); qtd.value = ""; await digitar(qtd, String(a.quantidade));
      await passo("Marcando os canais");
      for (const ch of cartao.querySelectorAll(".checks-linha input")) if (ch.checked !== a.canais.includes(ch.value)) await clicar(ch);
      const artes = cartao.querySelector(".check-linha input");
      if (artes.checked !== a.com_artes) await clicar(artes);
      const b = porTexto(cartao, "button", "Criar posts da semana");
      estado.resultadoCriador = null;
      await passo("Criando os posts da semana");
      await clicar(b);
      await esperarBotaoLivre(b);
      const r = estado.resultadoCriador;
      if (!r || r.erro) return { ok: false, resumo: (r && r.erro) || "Os posts não foram criados." };
      await passo("Abrindo o calendário");
      await abrirMenu("calendario");
      await espera(900);
      return { ok: true, resumo: `${r.criados} post(s) da semana criados para ${a.marca}${r.artes ? `, com ${r.artes} imagem(ns)` : ""}${r.parado ? " (parei as imagens no meio)" : ""}.` };
    },
    async criar_post(a) {
      const { cartao } = await prepararCriador(a);
      await passo("Abrindo um novo post");
      await clicar(porTexto(cartao, "button", "Novo post"));
      const gav = await esperarEl(() => !$("gaveta").classList.contains("oculto") ? $("gaveta") : null);
      await espera(400);
      await passo("Pedindo o texto à IA");
      const escrever = await esperarEl(() => porTexto(gav, "button", "Escrever com IA"));
      await clicar(escrever);
      const tema = await esperarEl(() => !$("modal").classList.contains("oculto") ? $("modal-texto").querySelector("input") : null);
      tema.value = "";
      await digitar(tema, a.tema || "post da marca");
      await clicar($("modal-confirmar"));
      await esperarBotaoLivre(escrever, 90000);
      if (piloto.erros.length) return { ok: false, resumo: piloto.erros[0] };
      const formato = gav.querySelectorAll("select")[1];
      if (formato && a.formato) { await passo("Escolhendo o formato"); await escolher(formato, a.formato); }
      if (a.data) { const d = gav.querySelector('input[type="date"]'); await passo("Marcando a data"); await moverPara(d); d.value = a.data; d.dispatchEvent(new Event("input", { bubbles: true })); await espera(300); }
      if (a.hora) { const t = gav.querySelector('input[type="time"]'); await moverPara(t); t.value = a.hora; t.dispatchEvent(new Event("input", { bubbles: true })); await espera(300); }
      if (a.com_arte) {
        await passo("Criando a imagem com IA (até 1 minuto)");
        const arte = porTexto(gav, "button", "Criar arte com IA");
        await clicar(arte);
        await esperarBotaoLivre(arte, 150000);
        if (piloto.erros.length) return { ok: false, resumo: piloto.erros[0] };
        await espera(800);
      }
      await passo("Enviando para aprovação");
      const enviar = await esperarEl(() => porTexto(gav, "button", "Enviar para aprovação"));
      await clicar(enviar);
      await esperarEl(() => $("gaveta").classList.contains("oculto") ? $("gaveta") : null, 30000);
      return { ok: true, resumo: `Post sobre "${a.tema}" criado para ${a.marca} e enviado para aprovação.` };
    },
    async aprovar_posts(a) {
      if (!pode("ADMIN")) return { ok: false, resumo: "Seu perfil não pode aprovar posts." };
      await passo("Abrindo Aprovações");
      await abrirMenu("aprovacoes");
      let n = 0;
      for (let i = 0; i < 40; i++) {
        const cartao = [...document.querySelectorAll(".aprovacao")].find(c => !a.marca || (c.textContent || "").includes(a.marca + " · "));
        const b = cartao && porTexto(cartao, "button", "Aprovar");
        if (!b) break;
        await passo(`Aprovando: ${(cartao.querySelector("strong") || {}).textContent || "post"}`);
        await clicar(b);
        await esperarEl(() => !cartao.isConnected ? document.body : null, 30000);
        await esperarPagina("aprovacoes");
        if (piloto.erros.length) break;
        n++;
      }
      return { ok: true, resumo: n ? `${n} post(s) aprovados${a.marca ? " de " + a.marca : ""}.` : "Não havia posts esperando aprovação." };
    },
    async publicar_post(a) {
      await passo("Abrindo o calendário");
      await abrirMenu("calendario");
      await passo(`Deixando o post #${a.post_id} pronto`);
      const r = await roteiroServidor(a);
      navegar();
      return r;
    },
    async pausar_ia(a) {
      await passo("Abrindo o painel");
      await abrirMenu("painel");
      await moverPara($("status-engine"));
      await passo(a.pausar ? "Pausando a IA do WhatsApp" : "Retomando a IA do WhatsApp");
      const r = await roteiroServidor(a);
      cacheEng.clear(); estado.status = null; atualizarStatus(); navegar();
      return r;
    }
  };

  // ----- Voz da DENIA: vozes naturais ou a voz da própria pessoa (clonada com autorização)
  const TEXTO_GRAVACAO = "Olá! Eu sou a voz da nossa empresa. Aqui a gente atende cada cliente com carinho e atenção, do primeiro contato até o serviço concluído. Se você precisa de um orçamento, de um horário ou só de uma informação, pode contar comigo. Vou te explicar tudo com calma, sem pressa, e te avisar de cada passo. Ah, e se preferir falar com alguém da equipe, é só pedir que eu chamo na hora. Obrigada pela confiança, e até já!";
  async function cartaoVoz() {
    const caixa = h("section", { class: "cartao vidro formulario" }, carregando());
    let cfg;
    try { cfg = await mk("voz/config"); } catch (e) { trocar(caixa, h("p", { class: "nota nota-alerta", text: e.message })); return caixa; }
    const desenhar = () => {
      const admin = pode("ADMIN");
      const atual = cfg.provedor === "elevenlabs" ? `Sua voz clonada${cfg.eleven_nome ? ": " + cfg.eleven_nome : ""}` : (cfg.vozes_openai.find(v => v[0] === cfg.voz_openai) || [cfg.voz_openai, cfg.voz_openai])[1];
      const ouvir = botao("▶ Ouvir a DENIA", async (_e, b) => { b.textContent = "Falando…"; try { await falar("Oi! Eu sou a DENIA. É assim que eu vou falar com você e com a sua equipe. Gostou da minha voz?"); } finally { b.textContent = "▶ Ouvir a DENIA"; } }, "btn-secundario btn-pequeno");
      if (!admin) { trocar(caixa, h("h3", { style: "margin:0", text: "Voz da DENIA" }), h("p", { text: "Voz atual: " + atual }), h("div", { class: "acoes" }, ouvir)); return; }
      const selVoz = h("select", { class: "entrada" }, cfg.vozes_openai.map(([v, n]) => h("option", { value: v, selected: v === cfg.voz_openai, text: n })));
      const estilo = h("textarea", { class: "entrada", rows: "3", placeholder: cfg.estilo_padrao, value: cfg.estilo || "" });
      const salvarNatural = botao("Usar esta voz", async () => { try { cfg = await mk("voz/config", { metodo: "POST", corpo: { provedor: "openai", voz_openai: selVoz.value, estilo: estilo.value } }); aviso("Voz salva.", "ok"); desenhar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-primario btn-pequeno");
      // Minha voz (ElevenLabs)
      const chave = h("input", { class: "entrada", type: "password", autocomplete: "off", placeholder: "sk_…" });
      const passoChave = cfg.eleven_configurada
        ? h("p", { class: "sub", text: "✅ Conta da ElevenLabs conectada." }, " ", botao("Desconectar", async () => { await mk("voz/eleven-chave", { metodo: "POST", corpo: { remover: true } }); cfg = await mk("voz/config"); desenhar(); }, "btn-secundario btn-pequeno"))
        : h("div", { class: "formulario" }, h("p", { class: "sub", style: "margin:0", text: "1) Crie uma conta em elevenlabs.io (a clonagem de voz precisa do plano Starter, cerca de US$ 5/mês) e copie a chave em Configurações → Chaves de API." }),
          h("div", { class: "linha-form" }, campo("Chave da ElevenLabs", chave)),
          h("div", { class: "acoes" }, botao("Conectar", async () => { try { await mk("voz/eleven-chave", { metodo: "POST", corpo: { chave: chave.value } }); cfg = await mk("voz/config"); aviso("ElevenLabs conectada.", "ok"); desenhar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-primario btn-pequeno")));
      const gravacao = { partes: [], gravador: null, inicio: 0, relogio: null, blob: null };
      const tempo = h("strong", { text: "0:00" });
      const ouvirGravacao = h("audio", { controls: true, class: "oculto", style: "width:100%" });
      const consentimento = h("input", { type: "checkbox" });
      const nomeVoz = h("input", { class: "entrada", value: (estado.eu && estado.eu.usuario && estado.eu.usuario.nome ? "Voz de " + estado.eu.usuario.nome : "Minha voz"), maxlength: "60" });
      const btnGravar = botao("● Gravar minha voz", async (_e, b) => {
        if (gravacao.gravador && gravacao.gravador.state === "recording") { gravacao.gravador.stop(); return; }
        if (!navigator.mediaDevices || !window.MediaRecorder) return aviso("Este navegador não grava áudio. Use o Chrome ou envie um arquivo.", "erro");
        let fluxo;
        try { fluxo = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } }); } catch { return aviso("Permita o microfone para gravar.", "erro"); }
        gravacao.partes = [];
        const g = new MediaRecorder(fluxo);
        gravacao.gravador = g;
        g.ondataavailable = ev => { if (ev.data.size) gravacao.partes.push(ev.data); };
        g.onstop = () => { fluxo.getTracks().forEach(t => t.stop()); clearInterval(gravacao.relogio); gravacao.blob = new Blob(gravacao.partes, { type: g.mimeType || "audio/webm" }); ouvirGravacao.src = URL.createObjectURL(gravacao.blob); ouvirGravacao.classList.remove("oculto"); b.textContent = "● Gravar de novo"; };
        g.start(1000);
        gravacao.inicio = Date.now();
        gravacao.relogio = setInterval(() => { const s = Math.floor((Date.now() - gravacao.inicio) / 1000); tempo.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; if (s >= 180) g.stop(); }, 500);
        b.textContent = "■ Parar gravação";
      }, "btn-primario btn-pequeno");
      const arquivo = h("input", { type: "file", accept: "audio/*", class: "entrada" });
      const criar = botao("Criar a minha voz", async (_e, b) => {
        const audio = gravacao.blob || (arquivo.files && arquivo.files[0]);
        if (!audio) return aviso("Grave ou escolha um arquivo de áudio primeiro.", "erro");
        if (!consentimento.checked) return aviso("Confirme que a voz é sua ou que a pessoa autorizou.", "erro");
        const f = new FormData();
        f.append("audio", audio, audio.name || "minha-voz.webm"); f.append("nome", nomeVoz.value); f.append("consentimento", "sim");
        b.textContent = "Criando a voz…";
        try {
          const r = await fetch(`/api/orgs/${estado.org.id}/mk/voz/clonar`, { method: "POST", credentials: "same-origin", headers: { "x-denia": "1" }, body: f });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.erro || "Não foi possível criar a voz.");
          cfg = await mk("voz/config");
          aviso(d.verificar ? "Voz criada. A ElevenLabs pede uma verificação rápida no site dela antes de liberar." : "Pronto! A DENIA agora fala com a sua voz.", "ok");
          desenhar();
        } catch (e) { aviso(e.message, "erro"); b.textContent = "Criar a minha voz"; }
      }, "btn-primario");
      const vozesConta = h("div", {});
      const aoVivoChk = h("input", { type: "checkbox", checked: cfg.ao_vivo_com_minha_voz });
      aoVivoChk.addEventListener("change", async () => { try { cfg = await mk("voz/config", { metodo: "POST", corpo: { ao_vivo_com_minha_voz: aoVivoChk.checked } }); } catch (e) { aviso(e.message, "erro"); } });
      const passoGravar = cfg.eleven_configurada ? h("div", { class: "formulario" },
        h("p", { class: "sub", style: "margin:0", text: "2) Grave de 1 a 3 minutos num lugar silencioso, falando como você fala com os clientes. Pode ler o texto abaixo:" }),
        h("blockquote", { class: "texto-gravacao", text: TEXTO_GRAVACAO }),
        h("div", { class: "acoes" }, btnGravar, tempo), ouvirGravacao,
        h("p", { class: "sub", style: "margin:0", text: "Ou envie um áudio que você já tem (sem música, só a sua voz):" }), arquivo,
        h("div", { class: "linha-form" }, campo("Nome da voz", nomeVoz)),
        h("label", { class: "lembrar" }, consentimento, " Esta é a minha voz, ou tenho autorização por escrito da pessoa para usar a voz dela."),
        h("div", { class: "acoes" }, criar, botao("Usar uma voz que já está na minha conta", async () => {
          try { const r = await mk("voz/eleven-vozes"); trocar(vozesConta, h("div", { class: "acoes" }, (r.vozes || []).map(v => botao(v.nome, async () => { cfg = await mk("voz/config", { metodo: "POST", corpo: { voz_eleven: { id: v.id, nome: v.nome } } }); aviso("Voz escolhida: " + v.nome, "ok"); desenhar(); }, "btn-secundario btn-pequeno")))); } catch (e) { aviso(e.message, "erro"); }
        }, "btn-secundario btn-pequeno")), vozesConta) : null;
      trocar(caixa,
        h("div", { class: "cabeca-grafico" }, h("h3", { style: "margin:0", text: "Voz da DENIA" }), ouvir),
        h("p", { style: "margin:0" }, "Voz atual: ", h("strong", { text: atual })),
        h("details", { open: cfg.provedor !== "elevenlabs" }, h("summary", { text: "Vozes naturais (prontas)" }),
          h("div", { class: "formulario", style: "margin-top:10px" }, campo("Voz", selVoz), campo("Jeito de falar (opcional)", estilo, "Ex.: carioca, animada, fala devagar e sorrindo."), h("div", { class: "acoes" }, salvarNatural))),
        h("details", { open: cfg.provedor === "elevenlabs" || cfg.eleven_configurada }, h("summary", { text: "Usar a minha voz" }),
          h("div", { class: "formulario", style: "margin-top:10px" }, passoChave, passoGravar,
            cfg.provedor === "elevenlabs" ? h("label", { class: "lembrar" }, aoVivoChk, " Usar a minha voz também na conversa ao vivo (a resposta demora cerca de 1 segundo a mais)") : null,
            cfg.provedor === "elevenlabs" ? h("div", { class: "acoes" }, botao("Voltar para a voz natural", async () => { cfg = await mk("voz/config", { metodo: "POST", corpo: { provedor: "openai" } }); desenhar(); }, "btn-secundario btn-pequeno")) : null,
            h("p", { class: "sub", style: "margin:0", text: "A voz é usada pela DENIA aqui no painel. Quando alguém perguntar com sinceridade, ela continua dizendo que é a assistente virtual." }))));
    };
    desenhar();
    return caixa;
  }
  async function paginaDenia(el, _p, vivo) {
    const msgs = h("div", { class: "assistente-msgs voz-msgs", id: "voz-msgs", "aria-live": "polite" });
    const texto = h("textarea", { class: "entrada voz-texto", placeholder: "Escreva aqui, ou toque no microfone ao lado para gravar e transcrever…", maxlength: "2000", rows: "2" });
    const falarChk = h("input", { type: "checkbox", id: "voz-falar", checked: true });
    const micGrande = h("button", { class: "voz-mic mic-denia", type: "button", "aria-label": "Conversar ao vivo", onclick: () => alternarAoVivo() });
    micGrande.appendChild(svgDe(ICONE_MIC));
    const ditar = h("button", { class: "assistente-mic mic-ditar", type: "button", title: "Gravar e transcrever (sem enviar)", "aria-label": "Gravar e transcrever", onclick: () => alternarGravacao("ditar", texto) });
    ditar.appendChild(svgDe(ICONE_MIC));
    el.appendChild(h("section", { class: "voz-pagina vidro", id: "voz-pagina" },
      h("div", { class: "voz-orbe", id: "voz-orbe" }, h("span"), h("i"), h("i")),
      h("h2", { text: "Converse com a DENIA" }),
      h("p", { class: "voz-estado", id: "voz-estado", text: "Toque no microfone e fale" }),
      h("div", { class: "voz-acoes" }, micGrande, h("span", { class: "voz-rotulo", id: "voz-rotulo", text: "Toque para conversar ao vivo" })),
      h("label", { class: "assistente-voz" }, falarChk, " Responder em voz também quando eu escrever"),
      h("p", { class: "nota", text: "Peça qualquer coisa: \"Crie os posts da próxima semana da Clínica Sol para o Instagram\" · \"Aprove os posts que estão esperando\" · \"A partir de hoje, sempre peça o bairro do cliente antes do orçamento\" · \"Pesquise as tendências de marketing para clínicas este mês\". Você vê a DENIA fazendo na tela e pode pausar ou parar." })));
    const enviar = () => { const t = texto.value.trim(); if (t) { texto.value = ""; perguntar(t); } };
    texto.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); } });
    el.appendChild(h("section", { class: "cartao vidro voz-historico" }, msgs,
      h("form", { class: "assistente-form", onsubmit: e => { e.preventDefault(); enviar(); } }, ditar, texto, h("button", { class: "btn btn-primario", type: "submit" }, "Enviar"))));
    assistente.msgs.forEach(m => msgs.appendChild(h("div", { class: "a-msg a-" + m.papel, text: m.texto })));
    if (!assistente.msgs.length) msgs.appendChild(h("div", { class: "a-msg a-denia", text: "Oi! Sou a DENIA. Toque no microfone grande uma vez e converse comigo ao vivo, como numa ligação — pode me interromper quando quiser. Também dá para escrever abaixo; o microfone pequeno grava e transcreve para você revisar antes de enviar." }));
    marcarAoVivo();
    estadoAssistente(aoVivo.ativo ? "Ao vivo — pode falar" : "");
    cartaoVoz().then(c => { if (vivo()) el.appendChild(c); });
    // A conversa ao vivo continua em qualquer tela: o painel flutuante mostra o que é dito.
  }

  function emBreve(el, titulo, texto) {
    el.appendChild(h("section", { class: "boas-vindas" }, h("div", { class: "orbe" }), selo("Em breve", "info"), h("h2", { text: titulo }), h("p", { text: texto }),
      h("div", { class: "acoes" }, h("a", { class: "btn btn-secundario", href: "#/painel" }, "Voltar ao painel"))));
  }

  iniciar();
})();
