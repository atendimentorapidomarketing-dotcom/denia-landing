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
  const eng = (caminho, op) => api(`/api/orgs/${estado.org.id}/engine/${caminho}`, op);
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
    instagram: { titulo: "Instagram", render: el => canalEmBreve(el, CANAIS.instagram) },
    facebook: { titulo: "Facebook", render: el => canalEmBreve(el, CANAIS.facebook) },
    google: { titulo: "Google Business", render: el => canalEmBreve(el, CANAIS.google) },
    social: { titulo: "Instagram", render: el => canalEmBreve(el, CANAIS.instagram) },
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
    if (!estado.org && nome !== "conta" && nome !== "empresas") { semEmpresa(el); return; }
    if ((rota.minimo && !pode(rota.minimo)) || (rota.superAdmin && !estado.eu.usuario.super_admin)) {
      el.appendChild(h("div", { class: "cartao vidro" }, vazio("Acesso restrito", "Seu perfil não tem acesso a esta área.")));
      return;
    }
    el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";
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
    if (!estado.eu.usuario.trocar_senha) atualizarStatus();
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
    $("empresa-select").addEventListener("change", e => { escolherEmpresa(e.target.value); navegar(); });
    window.addEventListener("hashchange", navegar);
    navegar();
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
      const cache = estado.cacheConversas;
      if (!forcar && cache && cache.org === orgId && Date.now() - cache.em < 120000) { lista = cache.lista; desenhar(); if (Date.now() - cache.em < 20000) return; }
      try {
        const nova = (await eng("conversations?limit=80")).conversas || [];
        if (!grade.isConnected) return;
        lista = nova; estado.cacheConversas = { org: orgId, lista: nova, em: Date.now() };
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

  async function abrirConversa(painel, id, vivo) {
    painel.replaceChildren(carregando());
    let d;
    try { d = await eng("conversations/" + encodeURIComponent(id)); }
    catch (e) { if (vivo()) painel.replaceChildren(vazio("Não foi possível abrir", e.message)); return; }
    if (!vivo()) return;
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
    area.replaceChildren(engine, sistema);
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

  const CANAIS = {
    instagram: { nome: "Instagram", texto: "A mesma inteligência do WhatsApp respondendo mensagens diretas e comentários, com o tom da sua equipe.", itens: ["Respostas a mensagens diretas (Direct) com IA", "Respostas a comentários das publicações", "Encaminhamento para atendimento no WhatsApp", "Calendário de publicações com aprovação antes de postar"], requisito: "Conta profissional do Instagram ligada a uma página do Facebook." },
    facebook: { nome: "Facebook", texto: "Mensagens do Messenger e comentários da página atendidos pela IA, com a equipe no controle.", itens: ["Atendimento no Messenger com IA", "Respostas a comentários da página", "Histórico unificado com o WhatsApp", "Relatórios de atendimento por canal"], requisito: "Página do Facebook da empresa e acesso de administrador." },
    google: { nome: "Google Business", texto: "Reputação no Google cuidada todos os dias: avaliações respondidas e perfil sempre atualizado.", itens: ["Respostas às avaliações com o tom da empresa, com aprovação", "Alertas de avaliações negativas para a equipe", "Publicação de novidades e ofertas", "Acompanhamento de nota e volume de avaliações"], requisito: "Perfil da empresa no Google verificado." }
  };
  function canalEmBreve(el, c) {
    el.appendChild(h("section", { class: "boas-vindas" }, h("div", { class: "orbe" }), selo("Em desenvolvimento", "info"), h("h2", { text: c.nome }), h("p", { text: c.texto })));
    el.appendChild(h("section", { class: "grade grade-2" },
      h("div", { class: "cartao vidro" }, h("h3", { text: "O que a DENIA vai fazer" }), h("ul", { class: "lista-saude" }, c.itens.map(t => h("li", {}, t, selo("Em breve", "info"))))),
      h("div", { class: "cartao vidro" }, h("h3", { text: "Para conectar" }), h("p", { text: c.requisito }),
        h("p", { class: "nota", text: "Quando este canal for liberado, a conexão será feita aqui mesmo, com um clique, e tudo o que a IA já aprendeu no WhatsApp passa a valer também neste canal." }),
        h("div", { class: "acoes", style: "margin-top:14px" }, h("button", { class: "btn btn-secundario", type: "button", disabled: true }, "Conectar " + c.nome)))));
  }

  async function paginaContatos(el, _p, vivo) {
    el.appendChild(cabeca("Contatos do site", "Mensagens enviadas pela página Fale conosco."));
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

  function emBreve(el, titulo, texto) {
    el.appendChild(h("section", { class: "boas-vindas" }, h("div", { class: "orbe" }), selo("Em breve", "info"), h("h2", { text: titulo }), h("p", { text: texto }),
      h("div", { class: "acoes" }, h("a", { class: "btn btn-secundario", href: "#/painel" }, "Voltar ao painel"))));
  }

  iniciar();
})();
