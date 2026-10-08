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
    setTimeout(() => el.remove(), tipo === "erro" ? 7000 : 4200);
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
  const fmtDataHora = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const fmtHora = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
  function quando(v) {
    const d = dataDe(v);
    if (!d || isNaN(d)) return "—";
    const hoje = new Date();
    return d.toDateString() === hoje.toDateString() ? "Hoje, " + fmtHora.format(d) : fmtDataHora.format(d);
  }
  // Para o meio de frases: "atualizado hoje, às 15:02" / "em 08/10/2026, às 15:02".
  function quandoFrase(v) {
    const d = dataDe(v);
    if (!d || isNaN(d)) return "—";
    const dia = d.toDateString() === new Date().toDateString() ? "hoje" : "em " + new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
    return `${dia}, às ${fmtHora.format(d)}`;
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
  const numero = n => new Intl.NumberFormat("pt-BR").format(Number(n) || 0);
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
        headers: { accept: "application/json", "x-denia": "1", ...(corpo !== undefined ? { "content-type": "application/json" } : {}) },
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

  const ETAPAS = [
    ["COLETANDO", "Coletando informações"],
    ["AGUARDANDO_PRESTADOR", "Aguardando profissional"],
    ["AGUARDANDO_CONFIRMACAO_PRESTADOR", "Confirmando com o profissional"],
    ["AGUARDANDO_CLIENTE", "Aguardando cliente"],
    ["AGUARDANDO_ENDERECO", "Aguardando endereço"],
    ["EQUIPE", "Com a equipe"],
    ["AGENDADO", "Agendado"],
    ["CONCLUIDO", "Concluído"],
    ["CANCELADO", "Cancelado"]
  ];
  const NOME_ETAPA = Object.fromEntries(ETAPAS);
  const ETAPAS_MANUAIS = ["COLETANDO", "EQUIPE", "AGENDADO", "CONCLUIDO", "CANCELADO"];
  const PAPEIS = [["OWNER", "Proprietário"], ["ADMIN", "Administrador"], ["AGENTE", "Atendente"], ["VISUALIZADOR", "Somente leitura"]];
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
    equipe: { titulo: "Equipe", render: paginaEquipe, minimo: "ADMIN" },
    auditoria: { titulo: "Auditoria", render: paginaAuditoria, minimo: "ADMIN" },
    empresas: { titulo: "Empresas", render: paginaEmpresas, superAdmin: true },
    conta: { titulo: "Conta e segurança", render: paginaConta },
    whatsapp: { titulo: "WhatsApp", render: paginaWhatsapp },
    instagram: { titulo: "Instagram", render: (el, _p, vivo) => paginaCanalSocial(el, "instagram", vivo) },
    facebook: { titulo: "Facebook", render: (el, _p, vivo) => paginaCanalSocial(el, "facebook", vivo) },
    google: { titulo: "Google Meu Negócio", render: paginaGoogle },
    social: { titulo: "Instagram", render: (el, _p, vivo) => paginaCanalSocial(el, "instagram", vivo) },
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
    el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";
    if (estado.iaLigada === false && nome !== "integracoes") el.appendChild(h("div", { class: "faixa-ia", role: "alert" },
      h("span", {}, h("strong", { text: "A inteligência da DENIA está desligada. " }), "Sem ela não dá para criar posts e imagens nem conversar por voz. Falta só colar a chave da OpenAI."),
      pode("ADMIN") ? h("a", { class: "btn btn-primario btn-pequeno", href: "#/integracoes" }, "Colar a chave agora") : null));
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
    if (!estado.eu.usuario.trocar_senha) { atualizarStatus(); atualizarAprovacoes(); }
    else $("status-engine").replaceChildren(h("span", { class: "ponto" }), "Primeiro acesso");
  }

  async function atualizarStatus() {
    const chip = $("status-engine");
    const marcar = (texto, tipo) => { chip.className = "selo" + (tipo ? " selo-" + tipo : ""); chip.replaceChildren(h("span", { class: "ponto" }), texto); };
    estado.status = null;
    $("contador-sugestoes").classList.add("oculto");
    if (!estado.org) { marcar("Sem empresa"); return; }
    if (!estado.org.conectada) { marcar("IA não conectada", "alerta"); return; }
    const alvo = estado.org.id;
    marcar("Verificando…");
    try {
      const s = await eng("status");
      if (!estado.org || estado.org.id !== alvo) return;
      estado.status = s;
      if (s.pausa_geral) marcar("IA pausada", "alerta");
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
      h("p", { text: estado.org.conectada ? "Este é o centro de comando da operação. Acompanhe a IA, as conversas e os atendimentos em tempo real." : "Vamos colocar a inteligência desta empresa para funcionar. O primeiro passo é conectar a IA." }),
      h("div", { class: "acoes" },
        estado.org.conectada ? h("a", { class: "btn btn-primario", href: "#/conversas" }, "Ver conversas") : h("a", { class: "btn btn-primario", href: "#/integracoes" }, "Conectar a IA"),
        h("a", { class: "btn btn-secundario", href: "#/treinamento" }, "Treinar a IA"))));

    if (!estado.org.conectada) {
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
    const ativos = somar(s.casos_por_etapa, x => !["CONCLUIDO", "CANCELADO"].includes(x.etapa));
    const agendados = somar(s.casos_por_etapa, x => x.etapa === "AGENDADO");
    const equipe = somar(s.casos_por_etapa, x => x.etapa === "EQUIPE");
    metricas.replaceChildren(
      metrica("Mensagens recebidas", numero(somar(s.fila_24h, () => true)), "nas últimas 24 horas"),
      metrica("Casos em andamento", numero(ativos), "últimos 30 dias"),
      metrica("Agendados", numero(agendados), "confirmados pelo profissional"),
      metrica("Com a equipe", numero(equipe), "precisam de uma pessoa"));

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
        h("span", { text: (String(c.ultima_direcao).toUpperCase() === "SAIDA" ? (String(c.ultima_origem).toUpperCase() === "HUMANO" ? "Equipe: " : "DENIA: ") : "") + (c.ultima_mensagem || "") }),
        h("span", { text: quando(c.ultima_mensagem_em) }))) : [vazio("Nenhuma conversa", q ? "Nada encontrado para essa busca." : "As conversas do WhatsApp aparecem aqui.", ICONES.conversa)]));
    };
    const carregarLista = async (forcar) => {
      const cache = estado.cacheConversas && estado.cacheConversas.org === orgId ? estado.cacheConversas : sessao.ler("denia_conversas_" + orgId);
      if (!forcar && cache && cache.lista) { lista = cache.lista; desenhar(); if (Date.now() - cache.em < 15000) return; }
      try {
        const nova = (await eng("conversations?limit=80", { fresco: true })).conversas || [];
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
    grade.append(h("section", { class: "conversas-lista vidro" }, h("div", { class: "conversas-busca" }, busca, botao("Atualizar", () => carregarLista(true), "btn-secundario btn-pequeno")), itens), painel);
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
      return h("div", { class: "msg " + (saida ? "msg-saida" + (humano ? " msg-humano" : "") : "msg-entrada") }, m.conteudo || "[sem texto]", h("small", { text: (saida ? (humano ? "Equipe · " : "DENIA · ") : "") + quando(m.criado_em) }));
    }));
    if (!(d.mensagens || []).length) msgs.appendChild(vazio("Sem mensagens", ""));
    const caso = d.caso_ativo;
    const estadoIa = d.ia_pausada ? selo("Atendimento humano", "alerta") : selo("IA atendendo", "ok");
    const acoes = h("div", { class: "acoes" },
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

  async function paginaAtendimentos(el, _p, vivo) {
    el.appendChild(cabeca("Atendimentos", "Cada caso passa pelas etapas abaixo. A IA move os casos sozinha; quando precisar, a equipe ajusta aqui.", botao("Atualizar", () => navegar())));
    const area = h("div", {}, carregando());
    el.appendChild(area);
    let casos;
    try { casos = (await eng("cases")).casos || []; }
    catch (e) { if (vivo()) falha(area, e); return; }
    if (!vivo()) return;
    if (!casos.length) { area.replaceChildren(h("div", { class: "cartao vidro" }, vazio("Nenhum atendimento ainda", "Os casos abertos pela IA aparecem aqui."))); return; }
    const colunas = ETAPAS.filter(([k]) => casos.some(c => c.etapa === k) || !["AGUARDANDO_ENDERECO", "AGUARDANDO_CONFIRMACAO_PRESTADOR", "CANCELADO"].includes(k));
    area.replaceChildren(h("div", { class: "kanban" }, colunas.map(([k, nome]) => {
      const doGrupo = casos.filter(c => c.etapa === k);
      return h("section", { class: "coluna vidro", "aria-label": nome }, h("div", { class: "coluna-cabeca" }, h("span", { text: nome }), h("b", { text: String(doGrupo.length) })),
        doGrupo.length ? doGrupo.map(cartaoCaso) : h("p", { style: "margin:4px;color:var(--texto-3);font-size:13px", text: "Nenhum caso." }));
    })));
  }
  function cartaoCaso(c) {
    const f = c.fatos || {};
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
    return h("article", { class: "caso" },
      h("strong", { text: `#${c.casoId} · ${f.servico || f.categoria || "Serviço a definir"}` }),
      f.problema ? h("p", { text: f.problema }) : null,
      h("p", { style: "color:var(--texto-3);font-size:12.5px", text: [f.bairro, telefone(c.telefone), quando(c.atualizadoMs)].filter(Boolean).join(" · ") }),
      h("a", { href: "#/conversas/" + c.clienteId, style: "font-size:13px;color:var(--ciano)" }, "Abrir conversa"), sel);
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

  async function paginaAprendizados(el, param, vivo) {
    clearTimeout(timerAprendizado);
    const filtro = ["PENDENTE", "APROVADA", "REJEITADA"].includes(String(param).toUpperCase()) ? String(param).toUpperCase() : "PENDENTE";
    el.appendChild(cabeca("Aprendizados", "A IA lê as conversas dos últimos 6 meses — principalmente as respostas das atendentes — e sugere o que aprender. Nada entra no treinamento sem a sua aprovação."));
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
    const editavel = filtro === "PENDENTE" && pode("ADMIN");
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
      h("p", { style: "margin:0;color:var(--texto-2);font-size:14px", text: "Liga a criação de posts e imagens, a voz da DENIA e os comandos por voz. A chave fica cifrada e nunca aparece de novo no navegador." }),
      campo("Chave da OpenAI", chaveIn, "Em platform.openai.com → API keys → Create new secret key. Copie e cole aqui."),
      k.configurada ? h("p", { class: "nota", text: `Chave em uso${k.final ? ": termina em …" + k.final : ""} · ${k.origem === "plataforma" ? "salva aqui na plataforma" : "secret OPENAI_API_KEY da Cloudflare"}.` }) : null,
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

  const NOME_ACAO = { CONVERSA: "Conversa", ATENDIMENTO: "Atendimento", TREINAMENTO: "Treinamento", APRENDIZADO: "Aprendizado", IMPORTACAO: "Importação", PAUSA_GERAL: "Pausa geral", EQUIPE: "Equipe", INTEGRACAO: "Integração", EMPRESA: "Empresa" };
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
    el.appendChild(h("section", { class: "cartao vidro formulario" }, h("h3", { style: "margin:0", text: "Nova empresa" }),
      h("div", { class: "linha-form" }, campo("Nome", nome), campo("Segmento", segmento), campo("Cor", cor)),
      h("div", { class: "acoes" }, botao("Criar empresa", async () => {
        try {
          const r = await api("/api/admin/organizacoes", { metodo: "POST", corpo: { nome: nome.value, segmento: segmento.value, cor: cor.value } });
          aviso("Empresa criada.", "ok");
          await recarregarEu(r.id);
          location.hash = "#/integracoes";
        } catch (e) { aviso(e.message, "erro"); }
      }, "btn-primario"))));
    const lista = estado.eu.organizacoes;
    el.appendChild(h("div", { class: "tabela-caixa" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", { text: "Empresa" }), h("th", { text: "IA" }), h("th", { text: "Situação" }), h("th", { text: "" }))),
      h("tbody", {}, lista.map(o => h("tr", {},
        h("td", {}, h("strong", { text: o.nome }), h("span", { class: "sub", text: o.segmento || "—" })),
        h("td", {}, o.conectada ? selo("Conectada", "ok") : selo("Não conectada", "alerta")),
        h("td", {}, o.status === "ATIVA" ? selo("Ativa", "ok") : selo("Suspensa", "erro")),
        h("td", {}, h("div", { class: "acoes", style: "justify-content:flex-end" },
          botao("Abrir painel", () => { escolherEmpresa(o.id); location.hash = "#/painel"; }, "btn-secundario btn-pequeno"),
          botao(o.status === "ATIVA" ? "Suspender" : "Reativar", async () => {
            const suspender = o.status === "ATIVA";
            if (suspender && !(await modal({ titulo: `Suspender ${o.nome}?`, conteudo: "A equipe da empresa perde o acesso ao painel. A IA do WhatsApp não é afetada.", confirmar: "Suspender", perigo: true }))) return;
            try { await api("/api/admin/organizacoes/" + o.id, { metodo: "POST", corpo: { status: suspender ? "SUSPENSA" : "ATIVA" } }); await recarregarEu(); navegar(); }
            catch (e) { aviso(e.message, "erro"); }
          }, o.status === "ATIVA" ? "btn-perigo btn-pequeno" : "btn-secundario btn-pequeno")))))))));
  }

  // ---------------------------------------------------------------------------
  // Conta
  // ---------------------------------------------------------------------------

  async function paginaConta(el) {
    const u = estado.eu.usuario;
    if (u.trocar_senha) el.appendChild(h("p", { class: "nota nota-alerta", text: "Bem-vinda(o)! Para continuar, crie a sua senha pessoal no lugar da senha temporária." }));
    el.appendChild(cabeca("Conta e segurança", u.email + (u.super_admin ? " · administrador geral" : estado.org ? ` · ${NOME_PAPEL[estado.papel] || ""} na ${estado.org.nome}` : "")));
    const nome = h("input", { class: "entrada", value: u.nome || "", maxlength: "120" });
    const perfil = h("section", { class: "cartao vidro formulario" }, h("h3", { style: "margin:0", text: "Perfil" }), campo("Seu nome", nome),
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

  async function paginaWhatsapp(el, _p, vivo) {
    el.appendChild(cabeca("WhatsApp", "O canal principal da IA: atendimento aos clientes e conversa com os profissionais, pela API oficial do WhatsApp Business."));
    if (!estado.org.conectada) { falha(el, new ErroApi("A IA desta empresa ainda não foi conectada.", 503, { codigo: "ENGINE_NAO_CONFIGURADO" })); return; }
    const area = h("div", { class: "grade grade-2" }, h("div", { class: "esqueleto" }), h("div", { class: "esqueleto" }));
    el.appendChild(area);
    let s;
    try { s = estado.status || await eng("status"); }
    catch (e) { if (vivo()) falha(area, e); return; }
    if (!vivo()) return;
    const ok = v => v ? selo("Ativo", "ok") : selo("Pendente", "alerta");
    const recebidas = (s.fila_24h || []).reduce((t, x) => t + Number(x.n || 0), 0);
    const lim = s.limites_envio || {};
    area.replaceChildren(
      h("section", { class: "cartao vidro" }, h("h3", { text: "Conexão" }), h("p", { text: "Situação do número da empresa na API oficial." }),
        h("ul", { class: "lista-saude" },
          h("li", {}, "Número conectado (token da Meta)", ok(s.whatsapp_configurado)),
          h("li", {}, "Assinatura das mensagens verificada", ok(s.assinatura_meta_verificada)),
          h("li", {}, "Modelo aprovado para falar com profissionais", ok(s.template_prestador_configurado)),
          h("li", {}, "Atendimento automático", s.pausa_geral ? selo("Pausado", "alerta") : selo("Ligado", "ok")))),
      h("section", { class: "cartao vidro" }, h("h3", { text: "Movimento e proteções" }), h("p", { text: "Travas que impedem envios em excesso e custos inesperados com a Meta." }),
        h("ul", { class: "lista-saude" },
          h("li", {}, "Mensagens recebidas (24 horas)", h("strong", { text: numero(recebidas) })),
          h("li", {}, "Mensagens seguidas do cliente", h("strong", { text: "uma resposta só" })),
          lim.porTelefone2min ? h("li", {}, "Limite por contato", h("strong", { text: `${lim.porTelefone2min} a cada 2 min · ${lim.porTelefoneHora} por hora` })) : null,
          h("li", {}, "Fora da janela de 24 horas", h("strong", { text: "só com modelo aprovado" }))),
        h("div", { class: "acoes", style: "margin-top:16px" }, h("a", { class: "btn btn-primario btn-pequeno", href: "#/conversas" }, "Abrir conversas"), h("a", { class: "btn btn-secundario btn-pequeno", href: "#/painel" }, "Controle da IA"))));
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
            progresso.textContent = `Criando a arte do post ${i + 1} de ${r.criados.length}. Cada arte leva cerca de 30 segundos.`;
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
      b.textContent = "Criando a imagem… (até 1 minuto)";
      try {
        const r = await mk("ia/imagem", { metodo: "POST", corpo: { marca_id: marcaImg.value, ideia: ideia.value, formato: formatoImg.value } });
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
    const imagem = h("div", { class: "post-arte" }, miniatura(p, "post-arte-img") || h("span", { text: "Sem arte ainda" }));
    const revisao = h("div", {}, p.revisao ? h("p", { class: "nota" + (p.revisao.nota >= 8 ? "" : " nota-alerta"), text: `Revisão da IA: nota ${p.revisao.nota}/10 — ${p.revisao.comentario}` }) : null, p.comentario ? h("p", { class: "nota nota-alerta", text: "Comentário: " + p.comentario }) : null);
    const dados = () => ({ id: p.id, marca_id: marca.value, canais: [...canais.querySelectorAll("input:checked")].map(i => i.value), formato: formato.value, data: data.value, hora: hora.value, titulo: tituloP.value, legenda: legenda.value, hashtags: hashtags.value, chamada: chamada.value, ideia_imagem: ideia.value });
    const salvar = async (silencioso) => { const r = await mk("posts", { metodo: "POST", corpo: dados() }); p.id = r.id; if (!silencioso) aviso("Post salvo.", "ok"); return r.id; };
    const acao = async (a, extra = {}) => { await salvar(true); await mk(`posts/${p.id}/acao`, { metodo: "POST", corpo: { acao: a, ...extra } }); fechar(); recarregar && recarregar(); atualizarAprovacoes(); };
    const editar = pode("AGENTE") && p.status !== "PUBLICADO";
    const botoes = h("div", { class: "acoes" },
      editar ? botao("Salvar", async () => { try { await salvar(); recarregar && recarregar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-primario") : null,
      editar && ["RASCUNHO", "REJEITADO"].includes(p.status || "RASCUNHO") ? botao("Enviar para aprovação", async () => { try { await acao("enviar"); aviso("Enviado para aprovação.", "ok"); } catch (e) { aviso(e.message, "erro"); } }) : null,
      pode("ADMIN") && p.id && ["AGUARDANDO", "RASCUNHO", "REJEITADO"].includes(p.status) ? botao("Aprovar", async () => { try { await acao("aprovar"); aviso("Post aprovado.", "ok"); } catch (e) { aviso(e.message, "erro"); } }, "btn-primario") : null,
      pode("ADMIN") && p.id && p.status === "AGUARDANDO" ? botao("Pedir ajuste", async () => {
        const motivo = h("textarea", { class: "entrada", placeholder: "O que precisa mudar?", maxlength: "400" });
        if (!(await modal({ titulo: "Pedir ajuste", conteudo: [motivo], confirmar: "Enviar" }))) return;
        try { await acao("rejeitar", { comentario: motivo.value }); aviso("Ajuste pedido.", "ok"); } catch (e) { aviso(e.message, "erro"); }
      }) : null,
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
          tituloP.value = r.titulo; legenda.value = r.legenda; hashtags.value = r.hashtags; chamada.value = r.chamada; ideia.value = r.ideia_imagem;
          aviso("Texto criado. Revise e salve.", "ok");
        } catch (e) { aviso(e.message, "erro"); } finally { b.textContent = "✦ Escrever com IA"; }
      }),
      botao("✦ Criar arte com IA", async (_e, b) => {
        b.textContent = "Criando a arte… (até 1 minuto)";
        try {
          await salvar(true);
          const r = await mk("ia/imagem", { metodo: "POST", corpo: { post_id: p.id, ideia: ideia.value } });
          p.midia_id = r.midia_id;
          imagem.replaceChildren(miniatura(p, "post-arte-img"));
          aviso("Arte criada.", "ok"); recarregar && recarregar();
        } catch (e) { aviso(e.message, "erro"); } finally { b.textContent = "✦ Criar arte com IA"; }
      }),
      botao("✦ Revisar com IA", async (_e, b) => {
        b.textContent = "Revisando…";
        try { await salvar(true); const r = await mk(`posts/${p.id}/acao`, { metodo: "POST", corpo: { acao: "revisar" } }); revisao.replaceChildren(h("p", { class: "nota" + (r.revisao.nota >= 8 ? "" : " nota-alerta"), text: `Revisão da IA: nota ${r.revisao.nota}/10 — ${r.revisao.comentario}` })); }
        catch (e) { aviso(e.message, "erro"); } finally { b.textContent = "✦ Revisar com IA"; }
      })) : null;
    const fechar = gaveta(p.id ? `Post #${p.id}` : "Novo post", [
      h("div", { class: "sugestao-topo" }, p.status ? seloStatus(p.status) : selo("Novo"), p.aprovado_por ? h("span", { class: "selo", text: "Aprovado por " + p.aprovado_por }) : null, p.criado_por ? h("span", { class: "selo", text: "Criado por " + p.criado_por }) : null),
      revisao, ia,
      h("div", { class: "editor-grade" },
        h("div", { class: "formulario" },
          h("div", { class: "linha-form" }, campo("Marca", marca), campo("Formato", formato)),
          h("div", { class: "campo" }, h("label", { text: "Canais" }), canais),
          h("div", { class: "linha-form" }, campo("Data", data), campo("Horário", hora)),
          campo("Título (interno)", tituloP), campo("Legenda", legenda), campo("Hashtags", hashtags), campo("Chamada para ação", chamada), campo("Ideia da arte", ideia)),
        h("div", { class: "formulario" }, h("label", { style: "font-weight:600;color:var(--texto-2);font-size:14px", text: "Arte" }), imagem,
          h("p", { class: "nota", text: "Quando o Instagram, o Facebook e o Google estiverem conectados, os posts aprovados serão publicados sozinhos no horário. Até lá, baixe a arte e copie a legenda para publicar." }))),
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
            pode("ADMIN") ? botao("Aprovar", async () => { try { await mk(`posts/${p.id}/acao`, { metodo: "POST", corpo: { acao: "aprovar" } }); aviso("Aprovado.", "ok"); navegar(); atualizarAprovacoes(); } catch (e) { aviso(e.message, "erro"); } }, "btn-primario btn-pequeno") : null,
            botao("Abrir e editar", () => editorPost(p, lista, () => navegar()), "btn-secundario btn-pequeno"))));
    })));
  }

  async function paginaMarcas(el, _p, vivo) {
    el.appendChild(cabeca("Marcas", "Cada marca tem o seu tom de voz, o seu público e as suas contas. A Central pode cuidar de quantas marcas precisar.", pode("ADMIN") ? botao("Nova marca", () => formMarca({}), "btn-primario") : null));
    const area = h("div", { class: "grade grade-3" }, carregando());
    el.appendChild(area);
    let lista;
    try { lista = await marcas(true); } catch (e) { if (vivo()) falha(area, e); return; }
    if (!vivo()) return;
    if (!lista.length) { area.replaceChildren(); semMarcas(el); return; }
    area.replaceChildren(...lista.map(m => h("article", { class: "cartao vidro marca-cartao" },
      h("div", { class: "marca-topo" }, h("span", { class: "empresa-avatar", text: iniciais(m.nome) }), h("div", {}, h("h3", { style: "margin:0", text: m.nome }), h("span", { class: "sub", text: [m.segmento, m.cidade].filter(Boolean).join(" · ") || "—" }))),
      h("ul", { class: "lista-saude" },
        h("li", {}, "Instagram", m.instagram ? h("span", { class: "selo", text: "@" + m.instagram }) : selo("Não informado", "alerta")),
        h("li", {}, "Facebook", m.facebook ? h("span", { class: "selo", text: m.facebook.slice(0, 28) }) : selo("Não informado", "alerta")),
        h("li", {}, "Google Meu Negócio", m.google ? h("span", { class: "selo", text: m.google.slice(0, 28) }) : selo("Não informado", "alerta"))),
      pode("ADMIN") ? h("div", { class: "acoes", style: "margin-top:14px" }, botao("Editar", () => formMarca(m), "btn-secundario btn-pequeno"),
        botao("Remover", async () => { if (!(await modal({ titulo: `Remover ${m.nome}?`, conteudo: "Os posts já criados continuam guardados.", confirmar: "Remover", perigo: true }))) return; await mk(`marcas/${m.id}/remover`, { metodo: "POST", corpo: {} }); navegar(); }, "btn-perigo btn-pequeno")) : null)));
  }
  function formMarca(m) {
    const c = {};
    const linha = (k, rot, ph, area) => { c[k] = area ? h("textarea", { class: "entrada", value: m[k] || "", placeholder: ph || "", style: "min-height:80px" }) : h("input", { class: "entrada", value: m[k] || "", placeholder: ph || "" }); return campo(rot, c[k]); };
    const fechar = gaveta(m.id ? "Editar marca" : "Nova marca", [h("div", { class: "formulario" },
      h("div", { class: "linha-form" }, linha("nome", "Nome da marca"), linha("segmento", "Segmento", "Ex.: assistência técnica")),
      h("div", { class: "linha-form" }, linha("cidade", "Cidade / região", "Ex.: Rio de Janeiro — Zona Sul"), linha("whatsapp", "WhatsApp", "Ex.: (21) 99999-9999")),
      h("div", { class: "linha-form" }, linha("instagram", "Instagram", "@perfil"), linha("facebook", "Página do Facebook", "Endereço da página"), linha("google", "Perfil no Google", "Nome ou link do perfil")),
      h("div", { class: "linha-form" }, linha("site", "Site", "https://"), linha("cores", "Cores da marca", "Ex.: azul-marinho e dourado")),
      linha("tom", "Tom de voz", "Ex.: próximo, acolhedor, sem gírias"), linha("publico", "Público", "Quem são os clientes", true), linha("diferenciais", "Diferenciais", "O que a marca faz melhor que os concorrentes", true),
      h("div", { class: "acoes" }, botao("Salvar marca", async () => {
        try { const corpo = { id: m.id }; Object.keys(c).forEach(k => { corpo[k] = c[k].value; }); await mk("marcas", { metodo: "POST", corpo }); aviso("Marca salva.", "ok"); fechar(); cacheMarcas = null; navegar(); }
        catch (e) { aviso(e.message, "erro"); }
      }, "btn-primario")))]);
  }

  // ----- Canais Instagram e Facebook
  async function paginaCanalSocial(el, canal, vivo) {
    const nome = NOME_CANAL[canal];
    const lista = await marcas(true);
    if (!vivo()) return;
    el.appendChild(cabeca(nome, `Contas de ${nome} de cada marca, publicações programadas e o que a DENIA vai fazer quando a conta for conectada.`));
    if (!lista.length) { semMarcas(el); return; }
    const cfg = await mk("config").catch(() => null);
    if (!vivo()) return;
    const criador = criadorIA(lista, cfg, canal, () => navegar());
    if (criador) el.appendChild(criador);
    const hoje = isoLocal(new Date());
    let posts = [];
    try { posts = (await mk(`posts?canal=${canal}&de=${hoje}&ate=${isoLocal(somarDias(new Date(), 30))}`)).posts || []; } catch (e) { aviso(e.message, "erro"); }
    if (!vivo()) return;
    const campoConta = canal === "instagram" ? "instagram" : "facebook";
    el.appendChild(h("section", { class: "grade grade-2" },
      h("div", { class: "cartao vidro" }, h("h3", { text: "Contas por marca" }),
        h("ul", { class: "lista-saude" }, lista.map(m => h("li", {}, h("span", {}, h("strong", { text: m.nome }), h("span", { class: "sub", text: m[campoConta] ? (canal === "instagram" ? "@" + m.instagram : m.facebook) : "Conta não informada" })), selo("Aguardando conexão oficial", "alerta")))),
        h("a", { class: "btn btn-secundario btn-pequeno", href: "#/marcas", style: "margin-top:14px;width:fit-content" }, "Editar contas nas marcas")),
      h("div", { class: "cartao vidro" }, h("h3", { text: "O que a DENIA faz neste canal" }),
        h("ul", { class: "lista-saude" },
          h("li", {}, "Planejar e criar posts, carrosséis, stories e reels", selo("Disponível", "ok")),
          h("li", {}, "Aprovação humana ou automática das artes", selo("Disponível", "ok")),
          h("li", {}, "Publicar sozinha no horário marcado", selo("Após a conexão", "info")),
          h("li", {}, canal === "instagram" ? "Responder mensagens diretas e comentários" : "Responder o Messenger e comentários da página", selo("Após a conexão", "info")),
          h("li", {}, "Chamar o profissional no WhatsApp sobre o atendimento", selo("Após a conexão", "info")),
          h("li", {}, "Relatório de alcance, seguidores e engajamento", selo("Após a conexão", "info"))))));
    el.appendChild(h("section", { class: "cartao vidro" }, h("h3", { text: "Próximas publicações (30 dias)" }),
      posts.length ? h("div", { class: "lista-posts" }, posts.map(p => cartaoPost(p, lista, () => navegar()))) : vazio("Nenhuma publicação programada", "Use \"Criar posts da semana com IA\" acima.", ICONES.caixa)));
    el.appendChild(h("section", { class: "cartao vidro" }, h("h3", { text: "Como conectar" }),
      h("ol", { class: "passos" },
        canal === "instagram" ? h("li", {}, "Cada Instagram precisa ser uma conta profissional (Empresa ou Criador) ligada a uma página do Facebook.") : h("li", {}, "Cada marca precisa de uma página do Facebook com você como administrador."),
        h("li", {}, "A DENIA usa a API oficial da Meta. Para isso, cadastramos um aplicativo em developers.facebook.com e pedimos à Meta as permissões de publicar e responder mensagens."),
        h("li", {}, "A Meta revisa o aplicativo (alguns dias a algumas semanas). Aprovado, o botão de conexão aparece aqui e cada marca é ligada com um clique.")),
      h("p", { class: "nota", text: "Enquanto isso, todo o conteúdo é criado, aprovado e organizado aqui: é só baixar a arte e copiar a legenda." })));
  }

  // ----- Google Meu Negócio
  async function paginaGoogle(el, aba, vivo) {
    const lista = await marcas(true);
    if (!vivo()) return;
    el.appendChild(cabeca("Google Meu Negócio", "Reputação, posição nas buscas e desempenho de cada perfil, acompanhados semana a semana."));
    if (!lista.length) { semMarcas(el); return; }
    const abas = [["publicacoes", "Posts e imagens"], ["avaliacoes", "Avaliações"], ["palavras", "Palavras-chave"], ["desempenho", "Desempenho"], ["conexao", "Conexão"]];
    const atual = abas.some(a => a[0] === aba) ? aba : "publicacoes";
    const sel = seletorMarca(lista, estado.marcaGoogle || lista[0].id);
    sel.addEventListener("change", () => { estado.marcaGoogle = sel.value; navegar(); });
    el.appendChild(h("div", { class: "pagina-cabeca" }, h("div", { class: "abas", role: "tablist" }, abas.map(([k, n]) => h("a", { class: "aba" + (k === atual ? " ativo" : ""), href: "#/google/" + k, role: "tab" }, n))), h("div", { style: "min-width:220px" }, sel)));
    const area = h("div", { class: "grade" }, carregando());
    el.appendChild(area);
    const marcaId = sel.value;
    try {
      if (atual === "avaliacoes") await abaAvaliacoes(area, marcaId);
      else if (atual === "palavras") await abaPalavras(area, marcaId, lista.find(m => String(m.id) === String(marcaId)));
      else if (atual === "desempenho") await abaDesempenho(area, marcaId);
      else if (atual === "publicacoes") {
        const [posts, cfg] = await Promise.all([mk(`posts?canal=google&marca=${marcaId}`).then(r => r.posts || []), mk("config").catch(() => null)]);
        estado.marcaCriador = marcaId;
        area.replaceChildren(criadorIA(lista, cfg, "google", () => navegar()) || "", h("div", { class: "cartao vidro" }, h("h3", { text: "Publicações no perfil do Google" }), h("p", { text: "Novidades, ofertas e eventos aparecem no perfil e nas buscas. A DENIA cria o texto e a imagem; depois da conexão, publica sozinha." }),
          posts.length ? h("div", { class: "lista-posts" }, posts.map(p => cartaoPost(p, lista, () => navegar()))) : vazio("Nenhuma publicação para o Google", "", ICONES.caixa)));
      } else {
        area.replaceChildren(h("div", { class: "cartao vidro" }, h("h3", { text: "Conectar o perfil" }),
          h("ol", { class: "passos" }, h("li", {}, "O perfil precisa estar verificado no Google e você precisa ser proprietário ou administrador."),
            h("li", {}, "A DENIA usa a API oficial do Google Business Profile. O Google precisa liberar o acesso para o projeto (o pedido é feito uma vez e leva alguns dias)."),
            h("li", {}, "Liberado, as avaliações chegam sozinhas, as respostas são publicadas direto no perfil e o desempenho é importado toda semana.")),
          h("p", { class: "nota", text: "A posição nas palavras-chave exige um serviço de consulta de buscas (de baixo custo). Até a conexão, registre a posição semanal manualmente na aba Palavras-chave." }),
          h("p", { class: "nota nota-alerta", text: "Importante: a DENIA nunca escreve avaliações para o próprio perfil — isso é proibido pelo Google e pode suspender o perfil. Ela pede avaliações aos clientes reais depois de cada atendimento." })));
      }
    } catch (e) { falha(area, e); }
  }
  async function abaAvaliacoes(area, marcaId) {
    const lista = (await mk(`avaliacoes?marca=${marcaId}`)).avaliacoes || [];
    const autor = h("input", { class: "entrada", placeholder: "Nome de quem avaliou" });
    const nota = h("select", { class: "entrada" }, [5, 4, 3, 2, 1].map(n => h("option", { value: n, text: "★".repeat(n) + " (" + n + ")" })));
    const texto = h("textarea", { class: "entrada", placeholder: "Cole aqui o texto da avaliação", style: "min-height:80px" });
    const media = lista.length ? (lista.reduce((t, a) => t + Number(a.nota || 0), 0) / lista.length).toFixed(1).replace(".", ",") : "—";
    area.replaceChildren(
      h("section", { class: "grade grade-3" }, metrica("Nota média", media, `${lista.length} avaliação(ões) registradas`), metrica("Sem resposta", numero(lista.filter(a => a.status === "PENDENTE").length), "responda em até 24 h"), metrica("Negativas", numero(lista.filter(a => Number(a.nota) <= 3).length), "3 estrelas ou menos")),
      pode("AGENTE") ? h("section", { class: "cartao vidro formulario" }, h("h3", { style: "margin:0", text: "Registrar avaliação" }),
        h("div", { class: "linha-form" }, campo("Autor", autor), campo("Nota", nota)), campo("Texto", texto),
        h("div", { class: "acoes" }, botao("Registrar", async () => { try { await mk("avaliacoes", { metodo: "POST", corpo: { marca_id: marcaId, autor: autor.value, nota: nota.value, texto: texto.value } }); navegar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-primario"))) : null,
      ...lista.map(a => {
        const resp = h("textarea", { class: "entrada", value: a.resposta || a.resposta_sugerida || "", placeholder: "Resposta da empresa", style: "min-height:80px" });
        return h("article", { class: "sugestao vidro" },
          h("div", { class: "sugestao-topo" }, h("strong", { text: a.autor || "Cliente" }), h("span", { class: "estrelas", text: "★".repeat(a.nota) + "☆".repeat(5 - a.nota) }), a.status === "RESPONDIDA" ? selo("Respondida", "ok") : selo("Sem resposta", Number(a.nota) <= 3 ? "erro" : "alerta")),
          h("p", { style: "margin:0;color:var(--texto-2)", text: a.texto || "(sem texto)" }), resp,
          pode("AGENTE") ? h("div", { class: "acoes" },
            botao("✦ Sugerir resposta com IA", async (_e, b) => { b.textContent = "Escrevendo…"; try { resp.value = (await mk(`avaliacoes/${a.id}/sugerir`, { metodo: "POST", corpo: {} })).resposta; } catch (e) { aviso(e.message, "erro"); } finally { b.textContent = "✦ Sugerir resposta com IA"; } }, "btn-secundario btn-pequeno"),
            botao("Salvar resposta", async () => { try { await mk(`avaliacoes/${a.id}/responder`, { metodo: "POST", corpo: { resposta: resp.value } }); aviso("Resposta salva. Publique no Google (ou automaticamente, após a conexão).", "ok"); navegar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-primario btn-pequeno"),
            botao("Copiar", () => copiar(resp.value), "btn-secundario btn-pequeno")) : null);
      }));
  }
  async function abaPalavras(area, marcaId, marca) {
    const lista = (await mk(`palavras?marca=${marcaId}`)).palavras || [];
    const semanas = Array.from({ length: 6 }, (_, i) => isoLocal(somarDias(segundaDe(new Date()), -7 * (5 - i))));
    const palavra = h("input", { class: "entrada", placeholder: "Ex.: assistência técnica de geladeira" });
    const cidade = h("input", { class: "entrada", value: (marca && marca.cidade) || "", placeholder: "Cidade ou bairro" });
    area.replaceChildren(
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
  async function abaDesempenho(area, marcaId) {
    const lista = (await mk(`metricas?marca=${marcaId}`)).metricas || [];
    const CAMPOS_M = [["visualizacoes", "Visualizações do perfil"], ["buscas", "Aparições em buscas"], ["ligacoes", "Ligações"], ["rotas", "Pedidos de rota"], ["cliques_site", "Cliques no site"], ["mensagens", "Mensagens"], ["nota_media", "Nota média"], ["total_avaliacoes", "Total de avaliações"]];
    const ents = Object.fromEntries(CAMPOS_M.map(([k]) => [k, h("input", { class: "entrada", type: "number", min: "0", step: k === "nota_media" ? "0.1" : "1" })]));
    const ultima = lista[0] || {}, anterior = lista[1] || {};
    const variacao = k => ultima[k] != null && anterior[k] ? Math.round(((ultima[k] - anterior[k]) / anterior[k]) * 100) : null;
    area.replaceChildren(
      h("section", { class: "grade grade-4" }, ["visualizacoes", "ligacoes", "rotas", "cliques_site"].map(k => {
        const v = variacao(k);
        return metrica((CAMPOS_M.find(c => c[0] === k) || [k, k])[1], ultima[k] != null ? numero(ultima[k]) : "—", v == null ? (ultima.semana ? "semana de " + dataCurta(ultima.semana) : "sem dados ainda") : `${v >= 0 ? "▲" : "▼"} ${Math.abs(v)}% em relação à semana anterior`);
      })),
      lista.length ? h("div", { class: "tabela-caixa" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "Semana" }), CAMPOS_M.map(([, n]) => h("th", { text: n })))),
        h("tbody", {}, lista.map(m => h("tr", {}, h("td", { text: dataCurta(m.semana) }), CAMPOS_M.map(([k]) => h("td", { text: m[k] == null ? "—" : String(m[k]).replace(".", ",") }))))))) : null,
      pode("AGENTE") ? h("section", { class: "cartao vidro formulario" }, h("h3", { style: "margin:0", text: "Registrar a semana" }),
        h("p", { style: "margin:0;color:var(--texto-2);font-size:14px", text: "Os números ficam em Google Meu Negócio → Desempenho. Depois da conexão com o Google, eles são importados sozinhos toda semana." }),
        h("div", { class: "linha-form" }, CAMPOS_M.map(([k, n]) => campo(n, ents[k]))),
        h("div", { class: "acoes" }, botao("Salvar semana", async () => { try { const corpo = { marca_id: marcaId, semana: isoLocal(new Date()) }; CAMPOS_M.forEach(([k]) => { corpo[k] = ents[k].value; }); await mk("metricas", { metodo: "POST", corpo }); aviso("Semana registrada.", "ok"); navegar(); } catch (e) { aviso(e.message, "erro"); } }, "btn-primario"))) : null);
  }

  async function atualizarAprovacoes() {
    const c = $("contador-aprovacoes");
    if (!c || !estado.org) return;
    try {
      const r = await mk("resumo");
      c.textContent = r.aguardando > 99 ? "99+" : String(r.aguardando);
      c.classList.toggle("oculto", !r.aguardando);
    } catch { c.classList.add("oculto"); }
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
    $("assistente-conversar").addEventListener("click", () => alternarGravacao("voz"));
    const topo = $("falar-denia");
    if (topo) topo.addEventListener("click", () => { location.hash = "#/denia"; });
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
    if (v) v.textContent = t || (assistente.continua ? "Conversa contínua ligada — fale quando quiser" : "Toque no microfone e fale");
    const orbe = $("voz-orbe");
    if (orbe) orbe.dataset.estado = !t ? "" : /Ouvindo|Gravando/.test(t) ? "ouvindo" : /Falando/.test(t) ? "falando" : "pensando";
  }
  const querVoz = () => ($("voz-pagina") && $("voz-falar") ? $("voz-falar").checked : $("assistente-falar").checked);

  async function perguntar(texto, origemVoz) {
    if (!estado.org) return;
    assistente.msgs.push({ papel: "usuario", texto });
    mostrarMsg("usuario", texto);
    estadoAssistente("Pensando…");
    const naPaginaVoz = Boolean($("voz-pagina"));
    let plano = [];
    try {
      const r = await api(`/api/orgs/${estado.org.id}/assistente/conversa`, { metodo: "POST", corpo: { mensagens: assistente.msgs.slice(-20), assistido: true } });
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
    if (assistente.continua && naPaginaVoz) { await esperarSimples(400); if ($("voz-pagina")) alternarGravacao("voz"); }
  }
  const esperarSimples = ms => new Promise(r => setTimeout(r, ms));

  // Fala e só termina quando o áudio acaba.
  async function falar(texto) {
    estadoAssistente("Falando…");
    try {
      const r = await fetch(`/api/orgs/${estado.org.id}/assistente/falar`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-denia": "1" }, body: JSON.stringify({ texto: texto.slice(0, 1500) }) });
      if (!r.ok) throw new Error("voz indisponível");
      const url = URL.createObjectURL(await r.blob());
      if (assistente.audio) assistente.audio.pause();
      const audio = new Audio(url);
      assistente.audio = audio;
      await new Promise(fim => { audio.onended = audio.onerror = audio.onpause = fim; audio.play().catch(fim); });
      URL.revokeObjectURL(url);
    } catch {
      // Sem a voz da OpenAI, usa a voz do próprio aparelho.
      if (window.speechSynthesis) await new Promise(fim => { const u = new SpeechSynthesisUtterance(texto); u.lang = "pt-BR"; u.onend = u.onerror = fim; window.speechSynthesis.speak(u); setTimeout(fim, 60000); });
    }
    estadoAssistente();
  }
  function pararFala() {
    if (assistente.audio) assistente.audio.pause();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }
  function marcarContinua() {
    const b = $("voz-continua");
    if (b) { b.classList.toggle("ativo", assistente.continua); b.textContent = assistente.continua ? "Parar conversa contínua" : "Conversa contínua (mãos livres)"; }
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
        const r = await fetch(`/api/orgs/${estado.org.id}/assistente/transcrever`, { method: "POST", credentials: "same-origin", headers: { "content-type": blob.type, "x-denia": "1" }, body: blob });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw Object.assign(new Error(d.erro || "Não consegui entender o áudio."), { dados: d });
        if (!d.texto) { estadoAssistente(); if (modo === "voz" && assistente.continua && $("voz-pagina")) alternarGravacao("voz"); return; }
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

  async function paginaDenia(el, _p, vivo) {
    const msgs = h("div", { class: "assistente-msgs voz-msgs", id: "voz-msgs", "aria-live": "polite" });
    const texto = h("textarea", { class: "entrada voz-texto", placeholder: "Escreva aqui, ou toque no microfone ao lado para gravar e transcrever…", maxlength: "2000", rows: "2" });
    const falarChk = h("input", { type: "checkbox", id: "voz-falar", checked: true });
    const micGrande = h("button", { class: "voz-mic mic-denia", type: "button", "aria-label": "Conversar por voz", onclick: () => alternarGravacao("voz") });
    micGrande.appendChild(svgDe(ICONE_MIC));
    const ditar = h("button", { class: "assistente-mic mic-ditar", type: "button", title: "Gravar e transcrever (sem enviar)", "aria-label": "Gravar e transcrever", onclick: () => alternarGravacao("ditar", texto) });
    ditar.appendChild(svgDe(ICONE_MIC));
    el.appendChild(h("section", { class: "voz-pagina vidro", id: "voz-pagina" },
      h("div", { class: "voz-orbe", id: "voz-orbe" }, h("span"), h("i"), h("i")),
      h("h2", { text: "Converse com a DENIA" }),
      h("p", { class: "voz-estado", id: "voz-estado", text: "Toque no microfone e fale" }),
      h("div", { class: "acoes voz-acoes" }, micGrande,
        botao("Conversa contínua (mãos livres)", () => { assistente.continua = !assistente.continua; marcarContinua(); estadoAssistente(); if (assistente.continua && !(assistente.gravador && assistente.gravador.state === "recording")) alternarGravacao("voz"); }, "btn-secundario", { id: "voz-continua" }),
        botao("Parar de falar", () => pararFala(), "btn-secundario")),
      h("label", { class: "assistente-voz" }, falarChk, " Responder em voz"),
      h("p", { class: "nota", text: "Peça qualquer coisa: \"Crie os posts da próxima semana da Clínica Sol para o Instagram\" · \"Aprove os posts que estão esperando\" · \"A partir de hoje, sempre peça o bairro do cliente antes do orçamento\". Você vê a DENIA fazendo na tela e pode pausar ou parar." })));
    const enviar = () => { const t = texto.value.trim(); if (t) { texto.value = ""; perguntar(t); } };
    texto.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); } });
    el.appendChild(h("section", { class: "cartao vidro voz-historico" }, msgs,
      h("form", { class: "assistente-form", onsubmit: e => { e.preventDefault(); enviar(); } }, ditar, texto, h("button", { class: "btn btn-primario", type: "submit" }, "Enviar"))));
    assistente.msgs.forEach(m => msgs.appendChild(h("div", { class: "a-msg a-" + m.papel, text: m.texto })));
    if (!assistente.msgs.length) msgs.appendChild(h("div", { class: "a-msg a-denia", text: "Oi! Sou a DENIA. Toque no microfone grande e fale comigo, ligue a conversa contínua para conversar sem tocar em nada, ou escreva abaixo — o microfone pequeno grava e transcreve para você revisar antes de enviar." }));
    marcarContinua();
    estadoAssistente();
    // Saiu da página: desliga a conversa contínua e o microfone (menos quando é a própria DENIA navegando).
    const aoSair = () => setTimeout(() => {
      if (vivo() || piloto.ativo) return;
      window.removeEventListener("hashchange", aoSair);
      assistente.continua = false;
      if (assistente.gravador && assistente.gravador.state === "recording") assistente.gravador.stop();
    }, 0);
    window.addEventListener("hashchange", aoSair);
  }

  function emBreve(el, titulo, texto) {
    el.appendChild(h("section", { class: "boas-vindas" }, h("div", { class: "orbe" }), selo("Em breve", "info"), h("h2", { text: titulo }), h("p", { text: texto }),
      h("div", { class: "acoes" }, h("a", { class: "btn btn-secundario", href: "#/painel" }, "Voltar ao painel"))));
  }

  iniciar();
})();
