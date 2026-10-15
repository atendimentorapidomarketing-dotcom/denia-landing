// DENIA Platform — Chatbot do WhatsApp para QUALQUER empresa, sem código e sem um Worker por empresa.
// Um só endereço de webhook (/webhook/whatsapp) recebe as mensagens de todos os números; cada mensagem
// chega com o phone_number_id, que diz de qual empresa ela é. Cada empresa monta no painel o próprio
// menu (botões e listas oficiais do WhatsApp), o catálogo de contatos (lojas, profissionais, setores) e
// escolhe o modo: só botões (sem IA, custo zero) ou botões + IA (a IA só entra quando a pessoa escreve
// algo que a busca por palavra não resolve, com o modelo mais barato).

import { openaiResposta } from "./marketing.js";
import { acessoDa, lerPlanos } from "./planos.js";

const GRAPH = "https://graph.facebook.com/v21.0";
export const DDL_ZAP = [
  `CREATE TABLE IF NOT EXISTS plt_zap_contas (org_id INTEGER PRIMARY KEY, phone_number_id TEXT UNIQUE, waba_id TEXT, numero TEXT, nome_verificado TEXT, token_cifrado TEXT, segredo_cifrado TEXT, telegram_cifrado TEXT, ativo INTEGER NOT NULL DEFAULT 1, modo TEXT NOT NULL DEFAULT 'BOTOES', config TEXT, atualizado_ms INTEGER)`,
  `CREATE TABLE IF NOT EXISTS plt_zap_itens (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, pai_id INTEGER NOT NULL DEFAULT 0, tipo TEXT NOT NULL, titulo TEXT NOT NULL, descricao TEXT, texto TEXT, palavras TEXT, ordem INTEGER NOT NULL DEFAULT 0, ativo INTEGER NOT NULL DEFAULT 1)`,
  `CREATE INDEX IF NOT EXISTS idx_zap_itens_org ON plt_zap_itens(org_id, pai_id)`,
  `CREATE TABLE IF NOT EXISTS plt_zap_catalogo (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, nome TEXT NOT NULL, telefone TEXT, whatsapp TEXT, local TEXT, descricao TEXT, destaque INTEGER NOT NULL DEFAULT 0, ativo INTEGER NOT NULL DEFAULT 1)`,
  `CREATE INDEX IF NOT EXISTS idx_zap_catalogo_org ON plt_zap_catalogo(org_id)`,
  `CREATE TABLE IF NOT EXISTS plt_zap_cat_itens (catalogo_id INTEGER NOT NULL, item_id INTEGER NOT NULL, PRIMARY KEY (catalogo_id, item_id))`,
  `CREATE TABLE IF NOT EXISTS plt_zap_contatos (org_id INTEGER NOT NULL, telefone TEXT NOT NULL, nome TEXT, pausado_ate INTEGER NOT NULL DEFAULT 0, ultima_entrada_ms INTEGER, ultimo_ms INTEGER, PRIMARY KEY (org_id, telefone))`,
  `CREATE TABLE IF NOT EXISTS plt_zap_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, telefone TEXT NOT NULL, direcao TEXT NOT NULL, origem TEXT NOT NULL, texto TEXT, wamid TEXT UNIQUE, status TEXT, erro TEXT, criado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_zap_msgs_conversa ON plt_zap_msgs(org_id, telefone, id)`,
  `CREATE INDEX IF NOT EXISTS idx_zap_msgs_tempo ON plt_zap_msgs(org_id, criado_ms)`,
  `CREATE TABLE IF NOT EXISTS plt_zap_buscas (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, telefone TEXT, nome TEXT, item_id INTEGER, tipo TEXT, titulo TEXT, caminho TEXT, texto TEXT, via TEXT, resultados INTEGER, criado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_zap_buscas_tempo ON plt_zap_buscas(org_id, criado_ms)`,
  `CREATE TABLE IF NOT EXISTS plt_zap_tg (chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, org_id INTEGER NOT NULL, telefone TEXT NOT NULL, criado_ms INTEGER NOT NULL, PRIMARY KEY (chat_id, message_id))`
];

export const ZAP_PADRAO = {
  boas_vindas: "Olá! 👋 Seja bem-vindo(a)! Como posso te ajudar? Escolha uma opção:",
  nao_entendi: "Não entendi bem, mas te mostro as opções:",
  humano: "Certo! Vou chamar alguém da equipe para falar com você. Só um instante. 😊",
  encerramento: "Foi um prazer ajudar! Quando precisar, é só mandar um oi. 😊",
  rodape_lista: "É só chamar no WhatsApp e dizer que veio pelo nosso atendimento. 😉",
  rotulo_catalogo: "contatos",
  rede_nome: "", rede_url: "",
  sobre: "",
  modelo_ia: "gpt-5-nano",
  exibicao_inicio: "AUTO",
  // Treinamento da IA completa (modo IA): o jeito de atender e o que ela pode dizer desta empresa.
  nome_atendente: "", ia_tom: "", ia_servicos: "", ia_precos: "", ia_regras: "", ia_exemplos: "",
  modelo_conversa: "gpt-5-mini",
  limite_ia_dia: 300,
  avisar_buscas: true
};
const TIPOS = ["MENU", "RESPOSTA", "LISTA", "HUMANO"];
const PAUSA_HUMANO_MS = 12 * 3600000;
const JANELA_24H = 24 * 3600000;

const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const digitos = s => String(s || "").replace(/\D/g, "");
const cortar = (t, n) => { t = String(t || "").trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t; };
function linkZap(tel) { const d = digitos(tel); return d.length >= 10 ? `wa.me/${d.length <= 11 ? "55" + d : d}` : ""; }
async function hmacHex(segredo, texto) {
  const e = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", e.encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, e.encode(texto)))].map(b => b.toString(16).padStart(2, "0")).join("");
}
function iguais(a, b) { a = String(a); b = String(b); let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0; }
// Modo de atendimento que o plano permite: IA completa > botões + IA > só botões.
function modoPermitido(modo, rec) {
  if (modo === "IA") return rec.includes("ia_completa") ? "IA" : rec.includes("chatbot_ia") ? "MISTO" : "BOTOES";
  if (modo === "MISTO") return rec.includes("chatbot_ia") ? "MISTO" : "BOTOES";
  return "BOTOES";
}
function lerConfig(conta) { let c = {}; try { c = JSON.parse(conta?.config || "{}") || {}; } catch { c = {}; } return { ...ZAP_PADRAO, ...c }; }

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

async function tokenDa(z) {
  if (z.token === undefined) z.token = z.conta.token_cifrado ? await z.k.decifrar(z.env, z.conta.token_cifrado) : "";
  return z.token;
}
async function gravarMsg(z, direcao, origem, texto, wamid, status, erro) {
  await z.env.DB.prepare("INSERT OR IGNORE INTO plt_zap_msgs(org_id,telefone,direcao,origem,texto,wamid,status,erro,criado_ms) VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(z.org, z.tel, direcao, origem, cortar(texto, 4000), wamid || null, status || null, erro || null, z.agora).run();
}
async function enviar(z, corpo, textoLog, origem = "ROBO") {
  if (z.sim) { z.registro.push({ texto: textoLog, interativo: corpo.type === "interactive" ? corpo.interactive : null }); return true; }
  if (z.enviadas >= 6) return false; // nunca mais que 6 mensagens por mensagem recebida
  z.enviadas++;
  const token = await tokenDa(z);
  let id = null, erro = null;
  try {
    const r = await fetch(`${GRAPH}/${encodeURIComponent(z.conta.phone_number_id)}/messages`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: z.tel, ...corpo }), signal: AbortSignal.timeout(15000)
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) id = d?.messages?.[0]?.id || null;
    else erro = cortar(`${d?.error?.code || r.status}: ${d?.error?.error_data?.details || d?.error?.message || "erro"}`, 300);
  } catch (e) { erro = cortar(e?.message || "falha de rede", 300); }
  await gravarMsg(z, "S", origem, textoLog, id, id ? "ENVIADA" : "FALHOU", erro);
  return Boolean(id);
}
const enviarTexto = (z, texto, origem) => enviar(z, { type: "text", text: { body: cortar(texto, 4000), preview_url: false } }, texto, origem);
function botoes(z, corpo, lista, origem) {
  return enviar(z, { type: "interactive", interactive: { type: "button", body: { text: cortar(corpo, 1024) }, action: { buttons: lista.slice(0, 3).map(b => ({ type: "reply", reply: { id: b.id, title: cortar(b.titulo, 20) } })) } } },
    `${corpo} ${lista.map(b => `[${b.titulo}]`).join(" ")}`, origem);
}
function lista(z, corpo, secao, linhas, origem) {
  return enviar(z, { type: "interactive", interactive: { type: "list", body: { text: cortar(corpo, 1024) }, action: { button: "Ver opções", sections: [{ title: cortar(secao, 24), rows: linhas.slice(0, 10).map(l => ({ id: l.id, title: cortar(l.titulo, 24), ...(l.descricao ? { description: cortar(l.descricao, 72) } : {}) })) }] } } },
    `${corpo} [lista: ${linhas.map(l => l.titulo).join(", ")}]`, origem);
}

// Telegram: o bot da própria DENIA (conectado com um toque, pelo link) ou um bot próprio da empresa.
export function tokenTelegramPlataforma(env) { return String(env.TELEGRAM_BOT_TOKEN_PLATAFORMA || env.TELEGRAM_BOT_TOKEN || "").trim(); }
async function destinoTelegram(env, k, conta) {
  if (conta?.telegram_chat && tokenTelegramPlataforma(env)) return { token: tokenTelegramPlataforma(env), chat: conta.telegram_chat };
  if (!conta?.telegram_cifrado) return null;
  try { const t = JSON.parse(await k.decifrar(env, conta.telegram_cifrado) || "{}"); return t.token && t.chat ? t : null; } catch { return null; }
}
async function tgApi(token, metodo, corpo) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${metodo}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(10000) });
    return await r.json().catch(() => ({ ok: r.ok }));
  } catch { return { ok: false }; }
}
async function telegram(z, texto, telCliente) {
  if (z.sim) return false;
  const d = await destinoTelegram(z.env, z.k, z.conta);
  if (!d) return false;
  const r = await tgApi(d.token, "sendMessage", { chat_id: d.chat, text: cortar(texto, 3500) + (telCliente ? "\n\n↩️ Responda esta mensagem aqui no Telegram e a resposta vai para o cliente no WhatsApp." : ""), disable_web_page_preview: true });
  const id = r?.result?.message_id;
  // Guarda de qual cliente é o aviso, para a equipe responder pelo próprio Telegram.
  if (id && telCliente) await z.env.DB.prepare("INSERT OR REPLACE INTO plt_zap_tg(chat_id,message_id,org_id,telefone,criado_ms) VALUES(?,?,?,?,?)").bind(String(d.chat), id, z.org, telCliente, z.agora).run().catch(() => {});
  return Boolean(r?.ok);
}
async function alertarEquipe(z, texto) {
  if (z.sim) return;
  if (await telegram(z, texto, z.tel)) return;
  if (z.k.alertarEmail) await z.k.alertarEmail(z.org, "DENIA — cliente quer falar com a equipe no WhatsApp", texto).catch(() => {});
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

async function carregarMenu(z) {
  if (z.menu) return z.menu;
  const [itens, contagem] = await z.env.DB.batch([
    z.env.DB.prepare("SELECT * FROM plt_zap_itens WHERE org_id=? AND ativo=1 ORDER BY ordem, id").bind(z.org),
    z.env.DB.prepare("SELECT ci.item_id, COUNT(*) n FROM plt_zap_cat_itens ci JOIN plt_zap_catalogo c ON c.id=ci.catalogo_id AND c.ativo=1 WHERE c.org_id=? GROUP BY ci.item_id").bind(z.org)
  ]);
  const n = new Map((contagem?.results || []).map(x => [x.item_id, x.n]));
  const todos = (itens?.results || []).map(i => ({ ...i, total: n.get(i.id) || 0 }));
  const porId = new Map(todos.map(i => [i.id, i]));
  const filhos = id => todos.filter(i => i.pai_id === id);
  // Visível: lista com pelo menos um contato, menu com algum filho visível, resposta e atendente sempre.
  const visivel = new Map();
  const ver = (i, prof = 0) => {
    if (visivel.has(i.id)) return visivel.get(i.id);
    let v = i.tipo === "LISTA" ? i.total > 0 : i.tipo === "MENU" ? prof < 8 && filhos(i.id).some(f => ver(f, prof + 1)) : true;
    visivel.set(i.id, v);
    return v;
  };
  todos.forEach(i => ver(i));
  z.menu = { todos, porId, filhos: id => filhos(id).filter(i => visivel.get(i.id)), visivel: i => visivel.get(i.id) };
  return z.menu;
}
function caminhoDe(m, item) { const p = []; let i = item, n = 0; while (i && n++ < 8) { p.unshift(i.titulo); i = m.porId.get(i.pai_id); } return p.join(" › "); }
function descricaoDe(i, cfg, m) {
  if (i.descricao) return i.descricao;
  if (i.tipo === "LISTA") return `${i.total} ${i.total === 1 ? cfg.rotulo_catalogo.replace(/s$/, "") : cfg.rotulo_catalogo}`;
  if (i.tipo === "MENU") { const n = m.filhos(i.id).length; return `${n} opç${n === 1 ? "ão" : "ões"}`; }
  return "";
}

async function lembrarMenu(z, menuId) {
  if (!z.sim) await z.env.DB.prepare("UPDATE plt_zap_contatos SET ultimo_menu=? WHERE org_id=? AND telefone=?").bind(menuId, z.org, z.tel).run().catch(() => {});
}
async function mostrarMenu(z, menuId = 0, pagina = 0, prefixo = "") {
  const m = await carregarMenu(z);
  const pai = menuId ? m.porId.get(menuId) : null;
  const itens = m.filhos(menuId);
  const corpo = (prefixo ? prefixo + "\n\n" : "") + (pai ? (pai.texto || `${pai.titulo}: escolha uma opção.`) : z.cfg.boas_vindas);
  await lembrarMenu(z, menuId);
  // Texto numerado: sem limite de opções (o WhatsApp só deixa 3 botões ou 10 itens por lista).
  const exibicao = pai ? pai.exibicao : z.cfg.exibicao_inicio;
  if (itens.length && exibicao === "NUMERADO") {
    const linhas = itens.map((i, n) => `*${n + 1}* · ${i.titulo}${i.descricao ? ` — ${i.descricao}` : ""}`);
    return enviarTexto(z, `${corpo}\n\n${linhas.join("\n")}\n\nResponda com o *número* ou escreva o que procura.${menuId ? "\n*0* · Voltar ao menu inicial" : ""}`);
  }
  if (!itens.length) {
    if (!menuId) return enviarTexto(z, corpo + (z.cfg.sobre ? "" : "\n\n(Em breve teremos mais opções por aqui.)"));
    return mostrarMenu(z, 0, 0, "Essa opção ainda não tem nada cadastrado.");
  }
  if (itens.length <= 3 && pagina === 0) return botoes(z, corpo, itens.map(i => ({ id: "z:i:" + i.id, titulo: i.titulo })));
  const porPagina = 9, ini = pagina * porPagina, parte = itens.slice(ini, ini + porPagina);
  const linhas = parte.map(i => ({ id: "z:i:" + i.id, titulo: i.titulo, descricao: descricaoDe(i, z.cfg, m) }));
  if (ini + porPagina < itens.length) linhas.push({ id: `z:pg:${menuId}:${pagina + 1}`, titulo: "➡️ Mais opções", descricao: "Ver as próximas" });
  else if (menuId || pagina) linhas.push({ id: "z:inicio", titulo: "🏠 Menu inicial", descricao: "Voltar ao começo" });
  return lista(z, corpo + (itens.length > porPagina ? `\n\nSão ${itens.length} opções: toque em "Ver opções" (as próximas ficam em "Mais opções") ou escreva o que procura.` : "\n\nToque em \"Ver opções\" e escolha."), pai ? pai.titulo : "Opções", linhas);
}
async function rodape(z, item) {
  const lista = [{ id: "z:inicio", titulo: "🏠 Menu inicial" }];
  if (item && item.pai_id) lista.push({ id: "z:i:" + item.pai_id, titulo: "⬅️ Voltar" });
  lista.push({ id: "z:fim", titulo: "✅ Finalizar" });
  return botoes(z, "Posso te ajudar com mais alguma coisa?", lista);
}
async function registrarBusca(z, item, via, resultados, caminho) {
  const umaHora = z.agora - 3600000;
  const [repetida] = z.sim ? [null] : await z.env.DB.batch([
    z.env.DB.prepare("SELECT 1 x FROM plt_zap_buscas WHERE org_id=? AND telefone=? AND item_id=? AND criado_ms>? LIMIT 1").bind(z.org, z.tel, item.id, umaHora),
    z.env.DB.prepare("INSERT INTO plt_zap_buscas(org_id,telefone,nome,item_id,tipo,titulo,caminho,texto,via,resultados,criado_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(z.org, z.tel, z.nome || "", item.id, item.tipo, item.titulo, caminho, cortar(z.texto, 300), via, resultados, z.agora)
  ]);
  if (z.cfg.avisar_buscas && !(repetida?.results || []).length)
    await telegram(z, `🔎 ${z.nomeEmpresa} — nova busca no WhatsApp\nCliente: ${z.nome || "sem nome"} (${z.tel})\nBuscou: ${caminho}${via !== "BOTAO" && z.texto ? ` (escreveu: "${cortar(z.texto, 120)}")` : ""}${z.resultados ? `\nIndicados: ${z.resultados}` : ""}`, z.tel);
}
async function abrirItem(z, item, via) {
  const m = await carregarMenu(z);
  const caminho = caminhoDe(m, item);
  const origem = via === "IA" ? "IA" : "ROBO";
  if (item.tipo === "MENU") return mostrarMenu(z, item.id);
  if (item.tipo === "HUMANO") { await transferir(z, item.texto); return registrarBusca(z, item, via, 0, caminho); }
  if (item.tipo === "RESPOSTA") {
    await enviarTexto(z, item.texto || item.titulo, origem);
    await rodape(z, item);
    return registrarBusca(z, item, via, 0, caminho);
  }
  // LISTA: os contatos do catálogo ligados a esta opção.
  const r = (await z.env.DB.prepare("SELECT c.* FROM plt_zap_catalogo c JOIN plt_zap_cat_itens ci ON ci.catalogo_id=c.id WHERE ci.item_id=? AND c.org_id=? AND c.ativo=1 ORDER BY c.destaque DESC, c.nome LIMIT 25").bind(item.id, z.org).all())?.results || [];
  const linhas = r.map(cartaoContato);
  const texto = r.length ? `*${item.titulo}*${item.texto ? "\n" + item.texto : ""}\n\n${linhas.join("\n\n")}${z.cfg.rodape_lista ? "\n\n" + z.cfg.rodape_lista : ""}` : `No momento não tenho ${z.cfg.rotulo_catalogo} cadastrados para *${item.titulo}*.`;
  await enviarTexto(z, texto, origem);
  await rodape(z, item);
  z.resultados = r.map(c => c.nome).join(", ");
  return registrarBusca(z, item, via, r.length, caminho);
}
function cartaoContato(c) {
  const zap = linkZap(c.whatsapp || c.telefone);
  return `• *${c.nome}*${c.local ? ` — ${c.local}` : ""}${c.descricao ? `\n  ${cortar(c.descricao, 140)}` : ""}${zap ? `\n  📲 ${zap}` : c.telefone ? `\n  📞 ${c.telefone}` : ""}${c.telefone && zap && digitos(c.telefone) !== digitos(c.whatsapp) && c.whatsapp ? `\n  📞 ${c.telefone}` : ""}`;
}
async function transferir(z, texto) {
  await enviarTexto(z, texto || z.cfg.humano);
  if (!z.sim) await z.env.DB.prepare("UPDATE plt_zap_contatos SET pausado_ate=? WHERE org_id=? AND telefone=?").bind(z.agora + PAUSA_HUMANO_MS, z.org, z.tel).run();
  await alertarEquipe(z, `💬 ${z.nome || "Um cliente"} (${z.tel}) quer falar com alguém da equipe no WhatsApp de ${z.nomeEmpresa}.${z.texto ? `\nEscreveu: "${cortar(z.texto, 200)}"` : ""}\nO robô ficou em pausa nessa conversa por 12 h. Responda pela DENIA (Chatbot → Conversas).${z.k.base ? "\n" + z.k.base + "/app#/chatbot/conversas" : ""}`);
}

// Busca por palavra (grátis): título e palavras-chave das opções; nome dos contatos do catálogo.
function pontos(item, alvo) {
  let p = 0;
  for (const w of new Set(norm([item.titulo, item.palavras].join(" ")).split(/[^a-z0-9]+/).filter(x => x.length >= 3))) {
    const raiz = w.length > 5 ? w.slice(0, -1) : w;
    if (new RegExp(`\\b${raiz}`).test(alvo)) p += w.length >= 5 ? 2 : 1;
  }
  return p;
}
const SAUDACAO = /^(oi+|ola|ol[aá]|opa|e ai|eai|bom dia|boa tarde|boa noite|menu|inicio|comecar|voltar|hello|hi|ola tudo bem|tudo bem)\b/;
const QUER_HUMANO = /\b(atendente|humano|falar com (uma )?(pessoa|alguem|atendente)|reclama[rcç]|gerente)/;

async function responder(z, texto, acao) {
  z.texto = texto;
  const m = await carregarMenu(z);
  if (acao === "z:inicio") return mostrarMenu(z);
  if (acao === "z:fim") return enviarTexto(z, z.cfg.encerramento + (z.cfg.rede_url ? `\n\nSiga a gente${z.cfg.rede_nome ? " no " + z.cfg.rede_nome : ""}: ${z.cfg.rede_url}` : ""));
  let a;
  if ((a = acao.match(/^z:pg:(\d+):(\d+)$/))) return mostrarMenu(z, Number(a[1]), Number(a[2]));
  if ((a = acao.match(/^z:i:(\d+)$/))) { const it = m.porId.get(Number(a[1])); return it ? abrirItem(z, it, "BOTAO") : mostrarMenu(z); }
  const alvo = norm(texto).trim();
  if (!alvo) return mostrarMenu(z, 0, 0, z.cfg.nao_entendi);
  if (QUER_HUMANO.test(alvo)) { const h = m.todos.find(i => i.tipo === "HUMANO"); await transferir(z, h?.texto); return h ? registrarBusca(z, h, "PALAVRA", 0, caminhoDe(m, h)) : null; }
  // IA completa: a conversa é com a IA (os botões continuam funcionando); sem IA disponível, cai no menu.
  if (z.modo === "IA" && !/^\d{1,3}$/.test(alvo)) { if (await atenderComIA(z, texto, m)) return; }
  if (SAUDACAO.test(alvo) && alvo.length < 30) return mostrarMenu(z);
  // Número ("1", "12"...): a opção do último menu que a pessoa recebeu; "0" volta ao início.
  if (/^\d{1,3}$/.test(alvo)) {
    if (alvo === "0") return mostrarMenu(z);
    const ultimo = Number(z.ultimoMenu || 0);
    const it = m.filhos(m.porId.has(ultimo) ? ultimo : 0)[Number(alvo) - 1];
    if (it) return abrirItem(z, it, "BOTAO");
  }
  const candidatos = m.todos.filter(i => m.visivel(i) && i.tipo !== "HUMANO").map(i => ({ i, p: pontos(i, alvo) + (i.tipo === "MENU" ? -0.5 : 0) })).filter(x => x.p > 0).sort((x, y) => y.p - x.p);
  if (candidatos.length && (candidatos.length === 1 || candidatos[0].p >= candidatos[1].p + 1.5)) return abrirItem(z, candidatos[0].i, "PALAVRA");
  // Nome de uma loja/contato do catálogo escrito na mensagem.
  const cat = (await z.env.DB.prepare("SELECT * FROM plt_zap_catalogo WHERE org_id=? AND ativo=1 LIMIT 600").bind(z.org).all())?.results || [];
  const achado = cat.filter(c => norm(c.nome).trim().length >= 4 && alvo.includes(norm(c.nome).trim())).sort((x, y) => y.nome.length - x.nome.length)[0];
  if (achado) { await enviarTexto(z, cartaoContato(achado) + (z.cfg.rodape_lista ? "\n\n" + z.cfg.rodape_lista : "")); return rodape(z, null); }
  if (z.modo === "MISTO") { const feito = await comIA(z, texto, m, cat, candidatos); if (feito) return; }
  return mostrarMenu(z, 0, 0, z.cfg.nao_entendi);
}

// ---------------------------------------------------------------------------
// IA completa (modo IA): conversa como uma pessoa, com o treinamento desta empresa, a memória deste
// cliente e a conversa recente. Tudo filtrado pela empresa (org_id): nunca mistura empresas.
// ---------------------------------------------------------------------------

const INSTRUCOES_CONVERSA = `Você atende os clientes de UMA empresa pelo WhatsApp, como uma pessoa experiente da equipe: calorosa, segura, objetiva.
REGRAS
- Responda no MESMO idioma em que o cliente escreveu.
- Mensagens curtas, como no WhatsApp (1 a 3 frases; no máximo uma pergunta por vez). Nada de textão, listas longas ou tom de robô.
- Leia a CONVERSA e a MEMÓRIA antes de responder: não pergunte o que o cliente já disse, não repita saudação no meio da conversa, chame pelo nome quando souber.
- Use SOMENTE as informações da EMPRESA abaixo. Nunca invente preço, prazo, endereço, telefone, horário, estoque ou promessa. Se não souber, diga que vai confirmar com a equipe e ponha "humano": true.
- Preços: só os que estão em PREÇOS AUTORIZADOS.
- Se uma OPÇÃO do menu responde exatamente o que a pessoa quer (ex.: lista de lojas, cardápio), ponha o id em "abrir".
- Ponha "menu": true só se a pessoa pedir as opções ou estiver perdida.
- Reclamação séria, pedido de falar com alguém, negociação fora das regras ou assunto sensível: "humano": true e uma resposta curta e acolhedora.
- Se perguntarem com sinceridade se você é uma IA, diga que é a assistente virtual da empresa e que a equipe pode assumir quando quiser.
- Em "lembrar", anote só FATOS NOVOS e úteis sobre o cliente para as próximas conversas (nome, preferências, endereço que ele informou, o que comprou/pediu), em frases curtas. Senão, vazio.
Responda SEMPRE em JSON: {"resposta":"","abrir":0,"menu":false,"humano":false,"lembrar":""}`;

function blocosTreino(cfg) {
  const b = [["JEITO DE ATENDER", cfg.ia_tom], ["SOBRE A EMPRESA (horário, endereço, pagamento, perguntas frequentes)", cfg.sobre], ["PRODUTOS E SERVIÇOS", cfg.ia_servicos], ["PREÇOS AUTORIZADOS", cfg.ia_precos], ["REGRAS DA EMPRESA", cfg.ia_regras], ["EXEMPLOS DE COMO A EQUIPE RESPONDE", cfg.ia_exemplos]];
  return b.filter(x => String(x[1] || "").trim()).map(([t, v]) => `${t}:\n${cortar(v, 4000)}`).join("\n\n") || "(a empresa ainda não preencheu o treinamento)";
}
async function reservarIA(z) {
  const hoje = new Date(z.agora - 3 * 3600000).toISOString().slice(0, 10);
  const chaveDia = `zap_ia_${z.org}_${hoje}`, chaveMes = `zap_ia_mes_${z.org}_${hoje.slice(0, 7)}`;
  const [d1, m1] = await z.env.DB.batch([z.env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind(chaveDia), z.env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind(chaveMes)]);
  const usadas = Number(d1?.results?.[0]?.valor || 0), doMes = Number(m1?.results?.[0]?.valor || 0);
  if (usadas >= Number(z.cfg.limite_ia_dia || 300) || (z.limiteMes && doMes >= z.limiteMes)) return false;
  await z.env.DB.batch([z.env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind(chaveDia, String(usadas + 1)), z.env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind(chaveMes, String(doMes + 1))]);
  return true;
}
async function atenderComIA(z, texto, m) {
  if (z.sim && z.k.semIA) return false;
  const envIA = await z.k.comIA(z.env, z.org);
  if (!envIA.OPENAI_API_KEY || !(await reservarIA(z))) return false;
  const [hist, ctt, cat] = z.sim ? [{ results: (z.historico || []) }, { results: [{ memoria: "" }] }, await z.env.DB.prepare("SELECT nome, local FROM plt_zap_catalogo WHERE org_id=? AND ativo=1 LIMIT 200").bind(z.org).all()] : await z.env.DB.batch([
    z.env.DB.prepare("SELECT direcao, origem, texto, criado_ms FROM plt_zap_msgs WHERE org_id=? AND telefone=? ORDER BY id DESC LIMIT 24").bind(z.org, z.tel),
    z.env.DB.prepare("SELECT memoria FROM plt_zap_contatos WHERE org_id=? AND telefone=?").bind(z.org, z.tel),
    z.env.DB.prepare("SELECT nome, local FROM plt_zap_catalogo WHERE org_id=? AND ativo=1 LIMIT 200").bind(z.org)
  ]);
  const conversa = (hist?.results || []).slice().reverse().map(x => `${x.direcao === "E" ? "CLIENTE" : x.origem === "EQUIPE" ? "EQUIPE" : "VOCÊ"}: ${cortar(x.texto, 400)}`).join("\n");
  const memoria = String(ctt?.results?.[0]?.memoria || "");
  const opcoes = m.todos.filter(i => m.visivel(i)).map(i => `${i.id}|${caminhoDe(m, i)}`).join("\n");
  const contatos = (cat?.results || []).length ? `\n\n${z.cfg.rotulo_catalogo.toUpperCase()} CADASTRADOS: ${cortar(cat.results.map(c => c.nome + (c.local ? ` (${c.local})` : "")).join(", "), 2500)}` : "";
  const quando = new Date(z.agora - 3 * 3600000);
  const entrada = `EMPRESA: ${z.nomeEmpresa}${z.cfg.nome_atendente ? `\nSEU NOME NO ATENDIMENTO: ${z.cfg.nome_atendente}` : ""}\nAGORA: ${quando.toISOString().slice(0, 16).replace("T", " ")} (horário de Brasília)\n\n${blocosTreino(z.cfg)}\n\nOPÇÕES DO MENU (id|caminho):\n${opcoes || "(sem menu)"}${contatos}\n\nCLIENTE: ${z.nome || "sem nome"}\nMEMÓRIA DO CLIENTE:\n${memoria || "(primeiro contato ou nada anotado)"}\n\nCONVERSA RECENTE:\n${conversa || "(nenhuma)"}\n\nMENSAGEM NOVA DO CLIENTE: "${cortar(texto, 1500)}"`;
  let o;
  try { o = await openaiResposta(envIA, { modelo: z.cfg.modelo_conversa || "gpt-5-mini", instrucoes: INSTRUCOES_CONVERSA, entrada, maxTokens: 700, esforco: "low", recurso: "chatbot/ia-completa" }); }
  catch (e) { console.warn("IA completa", e?.message); return false; }
  // O cliente mandou outra mensagem enquanto a IA pensava: quem responde é a mais nova (com tudo junto).
  if (!z.sim && z.msgId) {
    const nova = await z.env.DB.prepare("SELECT MAX(id) id FROM plt_zap_msgs WHERE org_id=? AND telefone=? AND direcao='E'").bind(z.org, z.tel).first();
    if (Number(nova?.id || 0) > z.msgId) return true;
  }
  const lembrar = cortar(o?.lembrar, 300);
  if (lembrar && !z.sim) {
    const nova = cortar([memoria, "- " + lembrar.replace(/^-\s*/, "")].filter(Boolean).join("\n"), 2000);
    await z.env.DB.prepare("UPDATE plt_zap_contatos SET memoria=? WHERE org_id=? AND telefone=?").bind(nova.length > 1800 ? nova.slice(-1800) : nova, z.org, z.tel).run().catch(() => {});
  }
  const resp = cortar(o?.resposta, 1500);
  if (o?.humano === true) { await transferir(z, resp || undefined); return true; }
  if (resp) await enviarTexto(z, resp, "IA");
  const item = m.porId.get(Number(o?.abrir) || -1);
  if (item && m.visivel(item)) { await abrirItem(z, item, "IA"); return true; }
  if (o?.menu === true) { await mostrarMenu(z); return true; }
  return Boolean(resp);
}

const INSTRUCOES_IA = `Você é a atendente virtual de uma empresa no WhatsApp. Responda SEMPRE em JSON {"item":0,"resposta":"","humano":false}.
- Se uma das OPÇÕES do menu responde ao que a pessoa quer, ponha o id dela em "item" (use só ids da lista) e deixe "resposta" vazia ou com uma frase curta.
- Se a pergunta é respondida pelas INFORMAÇÕES DA EMPRESA, escreva a resposta em "resposta" (no máximo 3 frases, simpática, como uma pessoa) e item 0.
- Se a pessoa quer falar com alguém, reclama, ou você não tem a informação, ponha "humano": true se existir atendimento humano; senão diga em "resposta" que não tem essa informação.
- Nunca invente preço, telefone, endereço, horário ou loja que não esteja abaixo. Não diga que é humana se perguntarem.`;
async function comIA(z, texto, m, cat, candidatos) {
  if (z.sim && z.k.semIA) return false;
  const hoje = new Date(z.agora - 3 * 3600000).toISOString().slice(0, 10);
  const chaveDia = `zap_ia_${z.org}_${hoje}`;
  const usadas = Number((await z.env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind(chaveDia).first().catch(() => null))?.valor || 0);
  if (usadas >= Number(z.cfg.limite_ia_dia || 300)) return false;
  const chaveMes = `zap_ia_mes_${z.org}_${hoje.slice(0, 7)}`;
  const doMes = Number((await z.env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind(chaveMes).first().catch(() => null))?.valor || 0);
  if (z.limiteMes && doMes >= z.limiteMes) return false; // limite de IA do plano no mês
  const envIA = await z.k.comIA(z.env, z.org);
  if (!envIA.OPENAI_API_KEY) return false;
  await z.env.DB.batch([z.env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind(chaveDia, String(usadas + 1)), z.env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind(chaveMes, String(doMes + 1))]);
  const opcoes = m.todos.filter(i => m.visivel(i)).map(i => `${i.id}|${caminhoDe(m, i)}${i.palavras ? " (" + cortar(i.palavras, 80) + ")" : ""}${i.tipo === "RESPOSTA" && i.texto ? " => " + cortar(i.texto, 160) : ""}`).join("\n");
  const contatos = cat.length && cat.length <= 200 ? `\n\nCONTATOS DO CATÁLOGO: ${cortar(cat.map(c => c.nome).join(", "), 2500)}` : "";
  let o;
  try {
    o = await openaiResposta(envIA, { modelo: z.cfg.modelo_ia || "gpt-5-nano", instrucoes: INSTRUCOES_IA, entrada: `EMPRESA: ${z.nomeEmpresa}\nINFORMAÇÕES DA EMPRESA:\n${cortar(z.cfg.sobre, 3000) || "(nenhuma)"}\n\nOPÇÕES (id|caminho):\n${opcoes}${contatos}\n\nA PESSOA ESCREVEU: "${cortar(texto, 500)}"`, maxTokens: 300, recurso: "chatbot/whatsapp" });
  } catch (e) { console.warn("chatbot IA", e?.message); return false; }
  const item = m.porId.get(Number(o?.item) || -1);
  const resp = cortar(o?.resposta, 600);
  if (item && m.visivel(item)) { if (resp && item.tipo !== "RESPOSTA") await enviarTexto(z, resp, "IA"); await abrirItem(z, item, "IA"); return true; }
  if (o?.humano === true && m.todos.some(i => i.tipo === "HUMANO")) { await transferir(z, resp || undefined); return true; }
  if (resp) { await enviarTexto(z, resp, "IA"); await botoes(z, "Quer ver as opções?", [{ id: "z:inicio", titulo: "🏠 Menu inicial" }, { id: "z:fim", titulo: "✅ Finalizar" }]); return true; }
  return false;
}

// ---------------------------------------------------------------------------
// Webhook (público): GET verificação da Meta, POST mensagens e status de entrega
// ---------------------------------------------------------------------------

export async function tokenVerificacao(env) {
  const r = await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave='zap_verify'").first().catch(() => null);
  if (r?.valor) return r.valor;
  const novo = "denia-" + [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare("INSERT OR IGNORE INTO plt_meta(chave,valor) VALUES('zap_verify',?)").bind(novo).run();
  return (await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave='zap_verify'").first())?.valor || novo;
}
export async function webhookZap(request, env, k, ctx) {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" && iguais(url.searchParams.get("hub.verify_token") || "", await tokenVerificacao(env));
    return ok ? new Response(url.searchParams.get("hub.challenge") || "", { status: 200, headers: { "content-type": "text/plain" } }) : new Response("Token de verificação incorreto.", { status: 403 });
  }
  if (request.method !== "POST") return new Response("Método não permitido.", { status: 405 });
  const bruto = await request.text();
  if (bruto.length > 512000) return new Response("Grande demais.", { status: 413 });
  let d;
  try { d = JSON.parse(bruto); } catch { return new Response("JSON inválido.", { status: 400 }); }
  const assinatura = String(request.headers.get("x-hub-signature-256") || "").replace(/^sha256=/, "");
  const tarefa = processarWebhook(env, k, d, bruto, assinatura).catch(e => console.error("webhook whatsapp", e?.stack || e?.message));
  if (ctx && ctx.waitUntil) ctx.waitUntil(tarefa); else await tarefa;
  return new Response("ok", { status: 200 });
}
async function processarWebhook(env, k, d, bruto, assinatura) {
  const contas = new Map();
  for (const e of d?.entry || []) for (const ch of e?.changes || []) {
    const v = ch?.value || {};
    const pnid = String(v?.metadata?.phone_number_id || "");
    if (!pnid) continue;
    if (!contas.has(pnid)) {
      const conta = await env.DB.prepare("SELECT c.*, o.nome org_nome, o.status org_status, o.plano, o.plano_status, o.teste_ate, o.pago_ate FROM plt_zap_contas c JOIN plt_organizacoes o ON o.id=c.org_id WHERE c.phone_number_id=?").bind(pnid).first();
      let valida = Boolean(conta);
      if (conta) {
        const segredos = [conta.segredo_cifrado ? await k.decifrar(env, conta.segredo_cifrado) : "", String(env.META_APP_SECRET || "")].filter(Boolean);
        // Com o segredo do app salvo, só aceita mensagem assinada pela Meta (ninguém consegue se passar por cliente).
        if (segredos.length && conta.segredo_cifrado) valida = assinatura && (await Promise.all(segredos.map(s => hmacHex(s, bruto)))).some(h => iguais(h, assinatura));
      }
      contas.set(pnid, valida ? conta : null);
    }
    const conta = contas.get(pnid);
    if (!conta) continue;
    if (Array.isArray(v.statuses) && v.statuses.length) {
      await env.DB.batch(v.statuses.slice(0, 50).map(s => env.DB.prepare("UPDATE plt_zap_msgs SET status=?, erro=COALESCE(?, erro) WHERE wamid=? AND org_id=?")
        .bind(String(s.status || "").toUpperCase().slice(0, 20), s.errors?.[0] ? cortar(`${s.errors[0].code}: ${s.errors[0].error_data?.details || s.errors[0].title || ""}`, 300) : null, String(s.id || ""), conta.org_id)));
    }
    if (!conta.ativo || conta.org_status !== "ATIVA") continue;
    // Plano: sem teste ou pagamento em dia, as mensagens só ficam registradas (o robô não responde).
    if (!conta.acesso) conta.acesso = acessoDa(conta, k.agora(env), (await lerPlanos(env)).planos);
    const nomes = new Map((v.contacts || []).map(c => [digitos(c.wa_id), String(c?.profile?.name || "").slice(0, 80)]));
    for (const msg of (v.messages || []).slice(0, 10)) await receberMensagem(env, k, conta, msg, nomes.get(digitos(msg.from)) || "");
  }
}
function lerEntrada(msg) {
  const t = msg?.type;
  const acao = String(msg?.interactive?.button_reply?.id || msg?.interactive?.list_reply?.id || msg?.button?.payload || "");
  const texto = t === "text" ? String(msg.text?.body || "") : t === "interactive" ? String(msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "") : t === "button" ? String(msg.button?.text || "") : "";
  return { acao, texto: texto.slice(0, 2000), rotulo: texto || `[${t || "mensagem"}]` };
}
async function receberMensagem(env, k, conta, msg, nome) {
  const tel = digitos(msg.from);
  const wamid = String(msg.id || "");
  if (!tel || !wamid) return;
  const agora = k.agora(env);
  const rec = conta.acesso?.recursos || [];
  const z = { env, k, org: conta.org_id, conta, cfg: lerConfig(conta), modo: modoPermitido(conta.modo, rec), tel, nome, agora, nomeEmpresa: conta.org_nome, enviadas: 0, limiteMes: Number(conta.acesso?.limites?.ia_mes || 0) };
  const e = lerEntrada(msg);
  const [ins, , ctt, recentes, idMsg] = await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO plt_zap_msgs(org_id,telefone,direcao,origem,texto,wamid,status,criado_ms) VALUES(?,?,?,?,?,?,'RECEBIDA',?)").bind(z.org, tel, "E", "CLIENTE", cortar(e.rotulo, 4000), wamid, agora),
    env.DB.prepare("INSERT INTO plt_zap_contatos(org_id,telefone,nome,ultima_entrada_ms,ultimo_ms) VALUES(?,?,?,?,?) ON CONFLICT(org_id,telefone) DO UPDATE SET nome=COALESCE(NULLIF(excluded.nome,''),nome), ultima_entrada_ms=excluded.ultima_entrada_ms, ultimo_ms=excluded.ultimo_ms").bind(z.org, tel, nome, agora, agora),
    env.DB.prepare("SELECT pausado_ate, nome, ultimo_menu FROM plt_zap_contatos WHERE org_id=? AND telefone=?").bind(z.org, tel),
    env.DB.prepare("SELECT COUNT(*) n FROM plt_zap_msgs WHERE org_id=? AND telefone=? AND direcao='S' AND criado_ms>?").bind(z.org, tel, agora - 600000),
    env.DB.prepare("SELECT id FROM plt_zap_msgs WHERE wamid=?").bind(wamid)
  ]);
  z.msgId = Number(idMsg?.results?.[0]?.id || 0);
  if (!Number(ins?.meta?.changes)) return; // a Meta reenviou a mesma mensagem
  const enviadaMs = Number(msg.timestamp || 0) * 1000;
  if (enviadaMs && agora - enviadaMs > 30 * 60000) return; // mensagem velha (reenvio depois de queda): não responde fora de hora
  const c = ctt?.results?.[0] || {};
  if (Number(c.pausado_ate || 0) > agora) return; // a equipe está atendendo
  if (Number(recentes?.results?.[0]?.n || 0) >= 25) return; // trava contra robô conversando com robô
  if (!rec.includes("chatbot")) return;
  z.nome = nome || c.nome || "";
  z.ultimoMenu = c.ultimo_menu;
  await responder(z, e.texto, e.acao);
}

// ---------------------------------------------------------------------------
// Rotas do painel: /api/orgs/:id/zap/...
// ---------------------------------------------------------------------------

async function contaDa(env, org) { return env.DB.prepare("SELECT * FROM plt_zap_contas WHERE org_id=?").bind(org).first(); }
async function conferirNumero(pnid, token) {
  const r = await fetch(`${GRAPH}/${encodeURIComponent(pnid)}?fields=display_phone_number,verified_name,quality_rating`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.code === 190 ? "A Meta recusou o token (vencido ou sem permissão). Gere um token permanente de usuário do sistema com whatsapp_business_messaging." : `A Meta não encontrou esse número: ${cortar(d?.error?.message || r.status, 200)}`);
  return { numero: d.display_phone_number || "", nome: d.verified_name || "", qualidade: d.quality_rating || "" };
}
function publicaConta(c, extra) {
  return {
    conectada: Boolean(c?.phone_number_id && c?.token_cifrado), phone_number_id: c?.phone_number_id || "", waba_id: c?.waba_id || "", numero: c?.numero || "", nome_verificado: c?.nome_verificado || "",
    tem_token: Boolean(c?.token_cifrado), tem_segredo: Boolean(c?.segredo_cifrado), telegram: Boolean(c?.telegram_cifrado || c?.telegram_chat), telegram_nome: c?.telegram_nome || "", ativo: c ? Boolean(c.ativo) : true, modo: c?.modo || "BOTOES", ...extra
  };
}
async function linhasDe(env, sql, ...args) { return (await env.DB.prepare(sql).bind(...args).all())?.results || []; }

export async function rotasZap(request, env, k, orgId, papel, resto) {
  if (!resto.startsWith("zap/") && resto !== "zap") return null;
  const r = resto.replace(/^zap\/?/, "");
  const { json, lerCorpo, pode, auditar, sessao } = k;
  const metodo = request.method;
  const agora = k.agora(env);
  const ler = async (lim = 20000) => { const { corpo, erro } = await lerCorpo(request, lim); return erro ? { erro } : { corpo }; };
  const precisa = nivel => pode(papel, nivel) ? null : json({ erro: nivel === "ADMIN" ? "Somente administradores mudam a conexão do WhatsApp." : "Seu perfil não pode mudar o chatbot." }, 403);
  let m;

  if (r === "conta" && metodo === "GET") {
    const c = await contaDa(env, orgId);
    const ult = await env.DB.prepare("SELECT MAX(criado_ms) ms FROM plt_zap_msgs WHERE org_id=? AND direcao='E'").bind(orgId).first().catch(() => null);
    return json(publicaConta(c, { webhook_url: new URL("/webhook/whatsapp", request.url).toString(), verify_token: pode(papel, "ADMIN") ? await tokenVerificacao(env) : "", ultima_recebida_ms: ult?.ms || null }));
  }
  if (r === "conta" && metodo === "POST") {
    const negado = precisa("ADMIN"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const atual = await contaDa(env, orgId);
    if (corpo.desconectar) {
      await env.DB.prepare("UPDATE plt_zap_contas SET phone_number_id=NULL, token_cifrado=NULL, segredo_cifrado=NULL, numero=NULL, atualizado_ms=? WHERE org_id=?").bind(agora, orgId).run();
      await auditar(env, request, sessao, orgId, "WHATSAPP", "Desconectou o WhatsApp do chatbot");
      return json({ ok: true });
    }
    const pnid = corpo.phone_number_id !== undefined ? digitos(corpo.phone_number_id) : atual?.phone_number_id || "";
    const token = String(corpo.token || "").trim();
    if (!/^\d{8,20}$/.test(pnid)) return json({ erro: "Cole o ID do número de telefone (Phone number ID): só números, em developers.facebook.com → seu app → WhatsApp → Configuração da API." }, 400);
    if (token && !/^[A-Za-z0-9_\-|.]{40,600}$/.test(token)) return json({ erro: "Esse não parece um token da Meta (começa com EAA…)." }, 400);
    const outra = await env.DB.prepare("SELECT org_id FROM plt_zap_contas WHERE phone_number_id=? AND org_id<>?").bind(pnid, orgId).first();
    if (outra) return json({ erro: "Esse número já está conectado em outra empresa da plataforma." }, 409);
    const tokenFinal = token || (atual?.token_cifrado ? await k.decifrar(env, atual.token_cifrado) : "");
    if (!tokenFinal) return json({ erro: "Cole o token de acesso permanente do WhatsApp." }, 400);
    let info;
    try { info = await conferirNumero(pnid, tokenFinal); } catch (e) { return json({ erro: e.message }, 400); }
    const segredo = String(corpo.app_secret || "").trim();
    if (segredo && !/^[a-f0-9]{32}$/i.test(segredo)) return json({ erro: "A Chave secreta do app tem 32 letras e números (Configurações do app → Básico)." }, 400);
    let tg = atual?.telegram_cifrado || null;
    if (corpo.telegram_token !== undefined || corpo.telegram_chat !== undefined) {
      const tt = String(corpo.telegram_token || "").trim(), tc = String(corpo.telegram_chat || "").trim();
      tg = tt && tc ? await k.cifrar(env, JSON.stringify({ token: tt, chat: tc })) : null;
    }
    await env.DB.prepare(`INSERT INTO plt_zap_contas(org_id,phone_number_id,waba_id,numero,nome_verificado,token_cifrado,segredo_cifrado,telegram_cifrado,ativo,modo,config,atualizado_ms) VALUES(?,?,?,?,?,?,?,?,1,'BOTOES','{}',?)
      ON CONFLICT(org_id) DO UPDATE SET phone_number_id=excluded.phone_number_id, waba_id=COALESCE(excluded.waba_id,waba_id), numero=excluded.numero, nome_verificado=excluded.nome_verificado, token_cifrado=excluded.token_cifrado, segredo_cifrado=COALESCE(excluded.segredo_cifrado,segredo_cifrado), telegram_cifrado=excluded.telegram_cifrado, atualizado_ms=excluded.atualizado_ms`)
      .bind(orgId, pnid, digitos(corpo.waba_id) || null, info.numero, info.nome, await k.cifrar(env, tokenFinal), segredo ? await k.cifrar(env, segredo) : null, tg, agora).run();
    await auditar(env, request, sessao, orgId, "WHATSAPP", `Conectou o WhatsApp do chatbot (${info.numero || pnid})`);
    return json({ ok: true, ...publicaConta(await contaDa(env, orgId), { qualidade: info.qualidade }) });
  }
  if (r === "conta/telegram" && metodo === "POST") {
    const negado = precisa("ADMIN"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const tt = String(corpo.telegram_token || "").trim(), tc = String(corpo.telegram_chat || "").trim();
    if (!corpo.remover && (!/^\d{5,15}:[A-Za-z0-9_-]{20,60}$/.test(tt) || !/^-?\d{3,20}$|^@[A-Za-z0-9_]{4,40}$/.test(tc))) return json({ erro: "Cole o token do bot (do @BotFather) e o ID do grupo ou da conversa." }, 400);
    await env.DB.prepare("INSERT INTO plt_zap_contas(org_id,telegram_cifrado,config,atualizado_ms) VALUES(?,?,'{}',?) ON CONFLICT(org_id) DO UPDATE SET telegram_cifrado=excluded.telegram_cifrado, atualizado_ms=excluded.atualizado_ms").bind(orgId, corpo.remover ? null : await k.cifrar(env, JSON.stringify({ token: tt, chat: tc })), agora).run();
    if (!corpo.remover) {
      const z = { env, k, sim: false, conta: await contaDa(env, orgId) };
      const ok = await telegram(z, "✅ Avisos do chatbot da DENIA ligados neste grupo.");
      if (!ok) return json({ ok: true, aviso: "Salvei, mas o Telegram não aceitou a mensagem de teste. Confira se o bot está no grupo e o ID do grupo." });
    }
    return json({ ok: true });
  }
  if (r === "telegram" && metodo === "GET") {
    const c = await contaDa(env, orgId);
    const bot = (await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave='tg_bot_usuario'").first().catch(() => null))?.valor || "";
    return json({ disponivel: Boolean(tokenTelegramPlataforma(env) && bot), bot, conectado: Boolean(c?.telegram_chat || c?.telegram_cifrado), grupo: c?.telegram_nome || (c?.telegram_cifrado ? "bot próprio" : ""), proprio: Boolean(c?.telegram_cifrado) });
  }
  if (r === "telegram/link" && metodo === "POST") {
    const negado = precisa("ADMIN"); if (negado) return negado;
    const bot = (await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave='tg_bot_usuario'").first().catch(() => null))?.valor || "";
    if (!bot || !tokenTelegramPlataforma(env)) return json({ erro: "O bot do Telegram da plataforma ainda não foi ligado pelo administrador geral." }, 503);
    const codigo = [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(36).padStart(2, "0")).join("").slice(0, 20);
    await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind("tg_codigo:" + codigo, JSON.stringify({ org: orgId, ate: agora + 3600000 })).run();
    return json({ grupo: `https://t.me/${bot}?startgroup=${codigo}`, privado: `https://t.me/${bot}?start=${codigo}`, codigo });
  }
  if (r === "telegram/desligar" && metodo === "POST") {
    const negado = precisa("ADMIN"); if (negado) return negado;
    await env.DB.prepare("UPDATE plt_zap_contas SET telegram_chat=NULL, telegram_nome=NULL, telegram_cifrado=NULL WHERE org_id=?").bind(orgId).run();
    return json({ ok: true });
  }
  if (r === "config" && metodo === "GET") {
    const c = await contaDa(env, orgId);
    return json({ config: lerConfig(c), modo: c?.modo || "BOTOES", ativo: c ? Boolean(c.ativo) : true, padrao: ZAP_PADRAO });
  }
  if (r === "config" && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const c = await contaDa(env, orgId), cfg = lerConfig(c);
    for (const [ch, v] of Object.entries(ZAP_PADRAO)) {
      if (typeof v === "string" && typeof corpo[ch] === "string") cfg[ch] = corpo[ch].slice(0, ch === "sobre" || ch.startsWith("ia_") ? 6000 : 1000);
      if (typeof v === "boolean" && typeof corpo[ch] === "boolean") cfg[ch] = corpo[ch];
      if (typeof v === "number" && corpo[ch] != null) cfg[ch] = Math.max(0, Math.min(5000, Number(corpo[ch]) || 0));
    }
    if (!["gpt-5-nano", "gpt-5-mini", "gpt-4o-mini", "gpt-4.1-mini"].includes(cfg.modelo_ia)) cfg.modelo_ia = "gpt-5-nano";
    if (cfg.exibicao_inicio !== "NUMERADO") cfg.exibicao_inicio = "AUTO";
    const modo = ["BOTOES", "MISTO", "IA"].includes(corpo.modo) ? corpo.modo : c?.modo || "BOTOES";
    if (modo !== "BOTOES" && k.acesso && modoPermitido(modo, k.acesso.recursos) !== modo) return json({ erro: modo === "IA" ? "A IA completa faz parte do plano Start ou superior. Atualize em Plano e pagamento." : "A IA no chatbot faz parte de um plano superior. Atualize em Plano e pagamento.", codigo: "PLANO_RECURSO" }, 402);
    if (!["gpt-5-mini", "gpt-5-nano", "gpt-4o-mini", "gpt-4.1-mini", "gpt-4.1"].includes(cfg.modelo_conversa)) cfg.modelo_conversa = "gpt-5-mini";
    const ativo = typeof corpo.ativo === "boolean" ? (corpo.ativo ? 1 : 0) : c ? c.ativo : 1;
    await env.DB.prepare("INSERT INTO plt_zap_contas(org_id,config,modo,ativo,atualizado_ms) VALUES(?,?,?,?,?) ON CONFLICT(org_id) DO UPDATE SET config=excluded.config, modo=excluded.modo, ativo=excluded.ativo, atualizado_ms=excluded.atualizado_ms").bind(orgId, JSON.stringify(cfg), modo, ativo, agora).run();
    await auditar(env, request, sessao, orgId, "CHATBOT", `Mensagens e modo do chatbot (${modo === "MISTO" ? "botões + IA" : "só botões"}${ativo ? "" : ", desligado"})`);
    return json({ ok: true, config: cfg, modo, ativo: Boolean(ativo) });
  }
  if (r === "itens" && metodo === "GET") {
    const [itens, catalogo, lig] = await env.DB.batch([
      env.DB.prepare("SELECT * FROM plt_zap_itens WHERE org_id=? ORDER BY pai_id, ordem, id").bind(orgId),
      env.DB.prepare("SELECT * FROM plt_zap_catalogo WHERE org_id=? ORDER BY nome").bind(orgId),
      env.DB.prepare("SELECT ci.catalogo_id, ci.item_id FROM plt_zap_cat_itens ci JOIN plt_zap_catalogo c ON c.id=ci.catalogo_id WHERE c.org_id=?").bind(orgId)
    ]);
    const porCat = new Map();
    for (const x of lig?.results || []) { if (!porCat.has(x.catalogo_id)) porCat.set(x.catalogo_id, []); porCat.get(x.catalogo_id).push(x.item_id); }
    return json({ itens: itens?.results || [], catalogo: (catalogo?.results || []).map(c => ({ ...c, itens: porCat.get(c.id) || [] })) });
  }
  if (r === "itens" && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const tipo = TIPOS.includes(corpo.tipo) ? corpo.tipo : "RESPOSTA";
    const titulo = cortar(k.txt(corpo.titulo, 60), 24);
    if (!titulo) return json({ erro: "Dê um nome à opção (até 24 letras: é o texto do botão)." }, 400);
    const pai = Number(corpo.pai_id) || 0;
    if (pai) { const p = await env.DB.prepare("SELECT tipo FROM plt_zap_itens WHERE id=? AND org_id=?").bind(pai, orgId).first(); if (!p || p.tipo !== "MENU") return json({ erro: "A opção só pode ficar dentro de um submenu." }, 400); }
    if (Number(corpo.id) && pai === Number(corpo.id)) return json({ erro: "Uma opção não pode ficar dentro dela mesma." }, 400);
    const campos = [pai, tipo, titulo, k.txt(corpo.descricao, 72), k.txt(corpo.texto, 3000), k.txt(corpo.palavras, 500), Number(corpo.ordem) || 0, corpo.ativo === false ? 0 : 1, corpo.exibicao === "NUMERADO" ? "NUMERADO" : "AUTO"];
    let id = Number(corpo.id) || 0;
    if (id) { const x = await env.DB.prepare("UPDATE plt_zap_itens SET pai_id=?, tipo=?, titulo=?, descricao=?, texto=?, palavras=?, ordem=?, ativo=?, exibicao=? WHERE id=? AND org_id=?").bind(...campos, id, orgId).run(); if (!x.meta.changes) return json({ erro: "Opção não encontrada." }, 404); }
    else id = (await env.DB.prepare("INSERT INTO plt_zap_itens(pai_id,tipo,titulo,descricao,texto,palavras,ordem,ativo,exibicao,org_id) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id").bind(...campos, orgId).first())?.id;
    return json({ ok: true, id });
  }
  if ((m = r.match(/^itens\/(\d{1,12})\/excluir$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const id = Number(m[1]);
    const filhos = await env.DB.prepare("SELECT COUNT(*) n FROM plt_zap_itens WHERE pai_id=? AND org_id=?").bind(id, orgId).first();
    if (Number(filhos?.n)) return json({ erro: "Esse submenu tem opções dentro. Exclua ou mova as opções primeiro." }, 409);
    await env.DB.batch([env.DB.prepare("DELETE FROM plt_zap_cat_itens WHERE item_id=? AND item_id IN (SELECT id FROM plt_zap_itens WHERE org_id=?)").bind(id, orgId), env.DB.prepare("DELETE FROM plt_zap_itens WHERE id=? AND org_id=?").bind(id, orgId)]);
    return json({ ok: true });
  }
  if (r === "catalogo" && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const nome = k.txt(corpo.nome, 80);
    if (!nome) return json({ erro: "Dê o nome." }, 400);
    const campos = [nome, k.txt(corpo.telefone, 30), k.txt(corpo.whatsapp, 30), k.txt(corpo.local, 80), k.txt(corpo.descricao, 300), corpo.destaque ? 1 : 0, corpo.ativo === false ? 0 : 1];
    let id = Number(corpo.id) || 0;
    if (id) { const x = await env.DB.prepare("UPDATE plt_zap_catalogo SET nome=?, telefone=?, whatsapp=?, local=?, descricao=?, destaque=?, ativo=? WHERE id=? AND org_id=?").bind(...campos, id, orgId).run(); if (!x.meta.changes) return json({ erro: "Não encontrado." }, 404); }
    else id = (await env.DB.prepare("INSERT INTO plt_zap_catalogo(nome,telefone,whatsapp,local,descricao,destaque,ativo,org_id) VALUES(?,?,?,?,?,?,?,?) RETURNING id").bind(...campos, orgId).first())?.id;
    const validos = new Set((await linhasDe(env, "SELECT id FROM plt_zap_itens WHERE org_id=? AND tipo='LISTA'", orgId)).map(x => x.id));
    const itens = [...new Set((Array.isArray(corpo.itens) ? corpo.itens : []).map(Number))].filter(x => validos.has(x)).slice(0, 80);
    await env.DB.batch([env.DB.prepare("DELETE FROM plt_zap_cat_itens WHERE catalogo_id=?").bind(id), ...itens.map(i => env.DB.prepare("INSERT OR IGNORE INTO plt_zap_cat_itens(catalogo_id,item_id) VALUES(?,?)").bind(id, i))]);
    return json({ ok: true, id });
  }
  if ((m = r.match(/^catalogo\/(\d{1,12})\/excluir$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const x = await env.DB.prepare("DELETE FROM plt_zap_catalogo WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).run();
    if (x.meta.changes) await env.DB.prepare("DELETE FROM plt_zap_cat_itens WHERE catalogo_id=?").bind(Number(m[1])).run();
    return json({ ok: true });
  }
  // Modelos prontos: monta o menu inicial com um toque (não apaga nada que já exista).
  if (r === "modelo" && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const ja = await env.DB.prepare("SELECT COUNT(*) n FROM plt_zap_itens WHERE org_id=?").bind(orgId).first();
    if (Number(ja?.n)) return json({ erro: "O menu já tem opções. O modelo só pode ser usado num menu vazio." }, 409);
    const MODELOS = {
      shopping: [["MENU", "🛍️ Produtos", "O que você procura?", "comprar, produto, loja, vende"], ["MENU", "🔧 Serviços", "Qual serviço você precisa?", "conserto, servico, assistencia, reparo"], ["HUMANO", "💬 Falar com alguém", "", ""]],
      servicos: [["MENU", "📋 Nossos serviços", "Qual serviço você precisa?", "servico, orcamento, preco"], ["RESPOSTA", "📍 Endereço e horário", "Escreva aqui o endereço e o horário de atendimento.", "endereco, onde fica, horario, abre, fecha, localizacao"], ["HUMANO", "💬 Falar com atendente", "", ""]],
      restaurante: [["RESPOSTA", "📖 Cardápio", "Veja o cardápio: (cole o link aqui)", "cardapio, menu, pratos, preco"], ["RESPOSTA", "🛵 Delivery", "Fazemos entrega! Peça por: (link ou explicação)", "entrega, delivery, pedido, pedir"], ["RESPOSTA", "📍 Endereço e horário", "Escreva aqui o endereço e o horário.", "endereco, horario, abre, fecha, onde"], ["HUMANO", "💬 Falar com atendente", "", ""]]
    };
    const lista = MODELOS[corpo.tipo] || MODELOS.servicos;
    await env.DB.batch(lista.map(([tipo, titulo, texto, palavras], i) => env.DB.prepare("INSERT INTO plt_zap_itens(org_id,pai_id,tipo,titulo,texto,palavras,ordem,ativo) VALUES(?,0,?,?,?,?,?,1)").bind(orgId, tipo, titulo, texto, palavras, i + 1)));
    if (corpo.tipo === "shopping") {
      const c = await contaDa(env, orgId), cfg = lerConfig(c);
      cfg.rotulo_catalogo = "lojas"; cfg.rodape_lista = "É só chamar a loja no WhatsApp e dizer que veio pelo nosso guia. 😉";
      await env.DB.prepare("INSERT INTO plt_zap_contas(org_id,config,atualizado_ms) VALUES(?,?,?) ON CONFLICT(org_id) DO UPDATE SET config=excluded.config").bind(orgId, JSON.stringify(cfg), agora).run();
    }
    await auditar(env, request, sessao, orgId, "CHATBOT", `Menu criado pelo modelo "${corpo.tipo || "servicos"}"`);
    return json({ ok: true });
  }
  // Planilha: nome; telefone; whatsapp; local; descricao; e as opções em que aparece. As colunas
  // "produtos" e "servicos" (separadas por vírgula) viram opções dentro dos submenus Produtos e Serviços;
  // a coluna "opcoes" (ou "categorias") vira opções no menu "Categorias".
  if (r === "importar" && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(900000); if (erro) return erro;
    const linhas = (Array.isArray(corpo.linhas) ? corpo.linhas : []).slice(0, 2000);
    const itens = await linhasDe(env, "SELECT id, pai_id, tipo, titulo FROM plt_zap_itens WHERE org_id=?", orgId);
    const sem = s => norm(s).replace(/[^a-z0-9]+/g, " ").trim();
    const menus = { produtos: null, servicos: null, opcoes: null };
    const achaMenu = async (chave, rotulo, palavras) => {
      if (menus[chave]) return menus[chave];
      let x = itens.find(i => i.tipo === "MENU" && i.pai_id === 0 && sem(i.titulo).includes(chave === "opcoes" ? "categ" : chave.slice(0, 7)));
      if (!x) { const id = (await env.DB.prepare("INSERT INTO plt_zap_itens(org_id,pai_id,tipo,titulo,texto,palavras,ordem,ativo) VALUES(?,0,'MENU',?,?,?,?,1) RETURNING id").bind(orgId, rotulo, "Escolha uma opção:", palavras, itens.length + 1).first()).id; x = { id, pai_id: 0, tipo: "MENU", titulo: rotulo }; itens.push(x); }
      return (menus[chave] = x.id);
    };
    const cache = new Map(itens.filter(i => i.tipo === "LISTA").map(i => [i.pai_id + "|" + sem(i.titulo), i.id]));
    const catalogo = new Map((await linhasDe(env, "SELECT id, nome FROM plt_zap_catalogo WHERE org_id=?", orgId)).map(c => [sem(c.nome), c.id]));
    let total = 0, novas = 0;
    const st = [];
    for (const l of linhas) {
      const nome = k.txt(l.nome || l.loja, 80);
      if (!nome) continue;
      const ids = [];
      for (const [chave, rotulo, palavras] of [["produtos", "🛍️ Produtos", "comprar, produto, loja"], ["servicos", "🔧 Serviços", "conserto, servico, assistencia"], ["opcoes", "📂 Categorias", ""]]) {
        const valores = String(l[chave] || (chave === "opcoes" ? l.categorias : "") || "").split(/[,;|]/).map(x => cortar(k.txt(x, 60), 24)).filter(Boolean);
        if (!valores.length) continue;
        const pai = await achaMenu(chave, rotulo, palavras);
        for (const v of valores) {
          const kk = pai + "|" + sem(v);
          if (!cache.has(kk)) { cache.set(kk, (await env.DB.prepare("INSERT INTO plt_zap_itens(org_id,pai_id,tipo,titulo,palavras,ordem,ativo) VALUES(?,?,'LISTA',?,'',0,1) RETURNING id").bind(orgId, pai, v).first()).id); novas++; }
          ids.push(cache.get(kk));
        }
      }
      let id = catalogo.get(sem(nome));
      const dados = [k.txt(l.telefone, 30), k.txt(l.whatsapp, 30), k.txt(l.local, 80), k.txt(l.descricao, 300)];
      if (id) st.push(env.DB.prepare("UPDATE plt_zap_catalogo SET telefone=COALESCE(NULLIF(?,''),telefone), whatsapp=COALESCE(NULLIF(?,''),whatsapp), local=COALESCE(NULLIF(?,''),local), descricao=COALESCE(NULLIF(?,''),descricao) WHERE id=?").bind(...dados, id));
      else { id = (await env.DB.prepare("INSERT INTO plt_zap_catalogo(org_id,nome,telefone,whatsapp,local,descricao,destaque,ativo) VALUES(?,?,?,?,?,?,0,1) RETURNING id").bind(orgId, nome, ...dados).first()).id; catalogo.set(sem(nome), id); }
      for (const i of ids) st.push(env.DB.prepare("INSERT OR IGNORE INTO plt_zap_cat_itens(catalogo_id,item_id) VALUES(?,?)").bind(id, i));
      total++;
      if (st.length >= 80) await env.DB.batch(st.splice(0));
    }
    if (st.length) await env.DB.batch(st);
    await auditar(env, request, sessao, orgId, "CHATBOT", `Planilha importada: ${total} contato(s), ${novas} opção(ões) nova(s)`);
    return json({ ok: true, contatos: total, opcoes_novas: novas });
  }
  if (r === "stats" && metodo === "GET") {
    const q = new URL(request.url).searchParams;
    const de = q.get("de"), ate = q.get("ate");
    const ini = /^\d{4}-\d{2}-\d{2}$/.test(de || "") ? Date.parse(de + "T03:00:00Z") : agora - 30 * 86400000;
    const fim = /^\d{4}-\d{2}-\d{2}$/.test(ate || "") ? Date.parse(ate + "T03:00:00Z") + 86400000 : agora + 1;
    const dia = "strftime('%Y-%m-%d', (criado_ms - 10800000)/1000, 'unixepoch')";
    const [porDia, porItem, porVia, contatos, horas, msgs, entregas, msgsDia] = await env.DB.batch([
      env.DB.prepare(`SELECT ${dia} dia, COUNT(*) n FROM plt_zap_buscas WHERE org_id=? AND criado_ms>=? AND criado_ms<? GROUP BY dia ORDER BY dia`).bind(orgId, ini, fim),
      env.DB.prepare("SELECT item_id, caminho, COUNT(*) n, MAX(tipo) tipo, SUM(CASE WHEN resultados=0 AND tipo='LISTA' THEN 1 ELSE 0 END) sem FROM plt_zap_buscas WHERE org_id=? AND criado_ms>=? AND criado_ms<? GROUP BY item_id ORDER BY n DESC LIMIT 20").bind(orgId, ini, fim),
      env.DB.prepare("SELECT via, COUNT(*) n FROM plt_zap_buscas WHERE org_id=? AND criado_ms>=? AND criado_ms<? GROUP BY via").bind(orgId, ini, fim),
      env.DB.prepare("SELECT COUNT(DISTINCT telefone) n FROM plt_zap_msgs WHERE org_id=? AND direcao='E' AND criado_ms>=? AND criado_ms<?").bind(orgId, ini, fim),
      env.DB.prepare("SELECT CAST(strftime('%w', (criado_ms - 10800000)/1000, 'unixepoch') AS INTEGER) d, CAST(strftime('%H', (criado_ms - 10800000)/1000, 'unixepoch') AS INTEGER) h, COUNT(*) n FROM plt_zap_msgs WHERE org_id=? AND direcao='E' AND criado_ms>=? AND criado_ms<? GROUP BY d, h").bind(orgId, ini, fim),
      env.DB.prepare("SELECT direcao, origem, COUNT(*) n FROM plt_zap_msgs WHERE org_id=? AND criado_ms>=? AND criado_ms<? GROUP BY direcao, origem").bind(orgId, ini, fim),
      env.DB.prepare("SELECT status, COUNT(*) n FROM plt_zap_msgs WHERE org_id=? AND direcao='S' AND criado_ms>=? AND criado_ms<? GROUP BY status").bind(orgId, ini, fim),
      env.DB.prepare(`SELECT ${dia} dia, COUNT(*) n FROM plt_zap_msgs WHERE org_id=? AND direcao='E' AND criado_ms>=? AND criado_ms<? GROUP BY dia ORDER BY dia`).bind(orgId, ini, fim)
    ]);
    const horarios = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const x of horas?.results || []) if (horarios[x.d]) horarios[x.d][x.h] = x.n;
    const M = {}; for (const x of msgs?.results || []) M[x.direcao + ":" + x.origem] = x.n;
    const E = {}; for (const x of entregas?.results || []) E[x.status || "?"] = x.n;
    const enviadas = Object.values(E).reduce((s, n) => s + n, 0);
    return json({
      buscas_por_dia: porDia?.results || [], mensagens_por_dia: msgsDia?.results || [], por_opcao: porItem?.results || [], por_via: porVia?.results || [], contatos: Number(contatos?.results?.[0]?.n || 0), horarios,
      mensagens: { recebidas: M["E:CLIENTE"] || 0, robo: M["S:ROBO"] || 0, ia: M["S:IA"] || 0, equipe: M["S:EQUIPE"] || 0 },
      entregas: { enviadas, entregues: (E.DELIVERED || 0) + (E.READ || 0), lidas: E.READ || 0, falhas: (E.FAILED || 0) + (E.FALHOU || 0), taxa: enviadas ? Math.round((((E.DELIVERED || 0) + (E.READ || 0)) / enviadas) * 1000) / 10 : null },
      total_buscas: (porDia?.results || []).reduce((s, x) => s + x.n, 0)
    });
  }
  if (r === "conversas" && metodo === "GET") {
    const busca = String(new URL(request.url).searchParams.get("q") || "").trim().slice(0, 60);
    const lista = await linhasDe(env, `SELECT c.telefone, c.nome, c.pausado_ate, c.ultimo_ms, c.ultima_entrada_ms, (SELECT texto FROM plt_zap_msgs m WHERE m.org_id=c.org_id AND m.telefone=c.telefone ORDER BY id DESC LIMIT 1) ultima
      FROM plt_zap_contatos c WHERE c.org_id=? ${busca ? "AND (c.nome LIKE ? OR c.telefone LIKE ?)" : ""} ORDER BY c.ultimo_ms DESC LIMIT 150`, orgId, ...(busca ? [`%${busca}%`, `%${digitos(busca) || busca}%`] : []));
    return json({ conversas: lista.map(c => ({ ...c, pausado: Number(c.pausado_ate) > agora, janela_aberta: agora - Number(c.ultima_entrada_ms || 0) < JANELA_24H })) });
  }
  if ((m = r.match(/^conversas\/(\d{8,15})$/)) && metodo === "GET") {
    const c = await env.DB.prepare("SELECT * FROM plt_zap_contatos WHERE org_id=? AND telefone=?").bind(orgId, m[1]).first();
    if (!c) return json({ erro: "Conversa não encontrada." }, 404);
    const msgs = (await linhasDe(env, "SELECT direcao, origem, texto, status, erro, criado_ms FROM plt_zap_msgs WHERE org_id=? AND telefone=? ORDER BY id DESC LIMIT 200", orgId, m[1])).reverse();
    return json({ contato: { ...c, pausado: Number(c.pausado_ate) > agora, janela_aberta: agora - Number(c.ultima_entrada_ms || 0) < JANELA_24H }, mensagens: msgs });
  }
  if ((m = r.match(/^conversas\/(\d{8,15})\/(enviar|robo)$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const c = await env.DB.prepare("SELECT * FROM plt_zap_contatos WHERE org_id=? AND telefone=?").bind(orgId, m[1]).first();
    if (!c) return json({ erro: "Conversa não encontrada." }, 404);
    if (m[2] === "robo") {
      await env.DB.prepare("UPDATE plt_zap_contatos SET pausado_ate=? WHERE org_id=? AND telefone=?").bind(corpo.ligar ? 0 : agora + PAUSA_HUMANO_MS, orgId, m[1]).run();
      return json({ ok: true });
    }
    const autor = sessao?.usuario?.nome || sessao?.usuario?.email || "Equipe";
    const r2 = await enviarDaEquipe(env, k, orgId, m[1], k.txt(corpo.texto, 4000));
    if (r2.erro) return json({ erro: r2.erro }, r2.status || 400);
    await auditar(env, request, sessao, orgId, "CONVERSA", `Respondeu ${m[1]} pelo chatbot (${autor})`);
    return json({ ok: true });
  }
  // Testar como cliente: nada vai para o WhatsApp e nada entra nas métricas.
  if (r === "testar" && metodo === "POST") {
    const { corpo, erro } = await ler(); if (erro) return erro;
    const conta = (await contaDa(env, orgId)) || { org_id: orgId, modo: "BOTOES", config: "{}" };
    const org = await env.DB.prepare("SELECT nome FROM plt_organizacoes WHERE id=?").bind(orgId).first();
    const modo = ["BOTOES", "MISTO", "IA"].includes(corpo.modo) ? corpo.modo : conta.modo;
    const historico = (Array.isArray(corpo.historico) ? corpo.historico : []).slice(-20).map(x => ({ direcao: x.cliente ? "E" : "S", origem: x.cliente ? "CLIENTE" : "IA", texto: k.txt(x.texto, 600) })).reverse();
    const z = { historico, env, k, org: orgId, conta, cfg: lerConfig(conta), modo: k.acesso ? modoPermitido(modo, k.acesso.recursos) : modo, tel: "0", nome: "Teste", agora, nomeEmpresa: org?.nome || "", sim: true, registro: [], enviadas: 0, limiteMes: Number(k.acesso?.limites?.ia_mes || 0) };
    await responder(z, k.txt(corpo.texto, 500), String(corpo.acao || "").slice(0, 40));
    return json({ respostas: z.registro });
  }
  return json({ erro: "Rota do chatbot não encontrada." }, 404);
}

// A equipe responde o cliente (pelo painel ou pelo Telegram): o robô fica em pausa nessa conversa.
export async function enviarDaEquipe(env, k, orgId, tel, texto) {
  const agora = k.agora(env);
  if (!texto) return { erro: "Escreva a mensagem.", status: 400 };
  const c = await env.DB.prepare("SELECT * FROM plt_zap_contatos WHERE org_id=? AND telefone=?").bind(orgId, tel).first();
  if (!c) return { erro: "Conversa não encontrada.", status: 404 };
  if (agora - Number(c.ultima_entrada_ms || 0) >= JANELA_24H) return { erro: "Passaram 24 horas desde a última mensagem do cliente. Pela regra da Meta, só dá para responder depois que ele escrever de novo (ou com um modelo aprovado).", status: 409 };
  const conta = await contaDa(env, orgId);
  if (!conta?.token_cifrado) return { erro: "Conecte o WhatsApp primeiro (Chatbot → Conexão).", status: 409 };
  const z = { env, k, org: orgId, conta, tel, agora, enviadas: 0 };
  const ok = await enviarTexto(z, texto, "EQUIPE");
  await env.DB.prepare("UPDATE plt_zap_contatos SET pausado_ate=?, ultimo_ms=? WHERE org_id=? AND telefone=?").bind(agora + PAUSA_HUMANO_MS, agora, orgId, tel).run();
  return ok ? { ok: true, nome: c.nome } : { erro: "A Meta não aceitou a mensagem. Veja o motivo na conversa.", status: 502 };
}

// ---------------------------------------------------------------------------
// Bot do Telegram da plataforma: conecta o grupo com um toque e deixa a equipe responder por lá.
// ---------------------------------------------------------------------------

export async function segredoTelegram(env, k) { return (await k.hmac(await k.segredo(env), "telegram-webhook-v1")).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48); }
export async function webhookTelegram(request, env, k) {
  if (!iguais(String(request.headers.get("x-telegram-bot-api-secret-token") || ""), await segredoTelegram(env, k))) return new Response("Não autorizado.", { status: 401 });
  const token = tokenTelegramPlataforma(env);
  let u;
  try { u = await request.json(); } catch { return new Response("ok"); }
  const msg = u?.message || u?.channel_post;
  const texto = String(msg?.text || "").trim();
  const chat = msg?.chat;
  if (!msg || !chat || !token) return new Response("ok");
  const responder = t => tgApi(token, "sendMessage", { chat_id: chat.id, text: t, reply_to_message_id: msg.message_id, disable_web_page_preview: true });
  const agora = k.agora(env);
  // /start CODIGO (ou /start@bot CODIGO): liga este grupo/conversa à empresa.
  const cod = texto.match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{8,40})$/);
  if (cod) {
    const reg = await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind("tg_codigo:" + cod[1]).first();
    let dado = null; try { dado = JSON.parse(reg?.valor || "null"); } catch { dado = null; }
    if (!dado || dado.ate < agora) { await responder("Esse link de conexão venceu. Gere outro no painel da DENIA (Chatbot do WhatsApp → Conexão → Telegram)."); return new Response("ok"); }
    const nomeChat = cortar(chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || String(chat.id), 80);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO plt_zap_contas(org_id,telegram_chat,telegram_nome,config,atualizado_ms) VALUES(?,?,?,'{}',?) ON CONFLICT(org_id) DO UPDATE SET telegram_chat=excluded.telegram_chat, telegram_nome=excluded.telegram_nome, atualizado_ms=excluded.atualizado_ms").bind(dado.org, String(chat.id), nomeChat, agora),
      env.DB.prepare("DELETE FROM plt_meta WHERE chave=?").bind("tg_codigo:" + cod[1])
    ]);
    const org = await env.DB.prepare("SELECT nome FROM plt_organizacoes WHERE id=?").bind(dado.org).first();
    await responder(`✅ Pronto! Este ${chat.type === "private" ? "chat" : "grupo"} está conectado à DENIA (${org?.nome || "empresa"}).\n\nAqui chegam: pedidos de atendimento humano e as buscas do WhatsApp.\nPara responder um cliente, responda a mensagem do aviso.\n\nComandos: /resumo (números de hoje), /ajuda.`);
    return new Response("ok");
  }
  const conta = await env.DB.prepare("SELECT * FROM plt_zap_contas WHERE telegram_chat=?").bind(String(chat.id)).first();
  if (!conta) { if (/^\/(start|ajuda|help)/.test(texto)) await responder("Olá! Eu sou o bot de avisos da DENIA. Para conectar este grupo, use o link do painel: Chatbot do WhatsApp → Conexão → Telegram."); return new Response("ok"); }
  if (/^\/(ajuda|help)/.test(texto)) { await responder("• Responda um aviso para falar com o cliente no WhatsApp (o robô pausa nessa conversa).\n• Responda um aviso com /robo para devolver a conversa ao robô.\n• /resumo — números de hoje."); return new Response("ok"); }
  if (/^\/resumo/.test(texto)) {
    const ini = Date.parse(new Date(agora - 3 * 3600000).toISOString().slice(0, 10) + "T03:00:00Z");
    const [m1, b1, p1] = await env.DB.batch([
      env.DB.prepare("SELECT COUNT(*) n, COUNT(DISTINCT telefone) c FROM plt_zap_msgs WHERE org_id=? AND direcao='E' AND criado_ms>=?").bind(conta.org_id, ini),
      env.DB.prepare("SELECT titulo, COUNT(*) n FROM plt_zap_buscas WHERE org_id=? AND criado_ms>=? GROUP BY titulo ORDER BY n DESC LIMIT 5").bind(conta.org_id, ini),
      env.DB.prepare("SELECT COUNT(*) n FROM plt_zap_contatos WHERE org_id=? AND pausado_ate>?").bind(conta.org_id, agora)
    ]);
    const mm = m1?.results?.[0] || {};
    await responder(`📊 Hoje no WhatsApp\nMensagens recebidas: ${mm.n || 0} (${mm.c || 0} clientes)\nCom a equipe agora: ${p1?.results?.[0]?.n || 0}\nMais procurados: ${(b1?.results || []).map(x => `${x.titulo} (${x.n})`).join(", ") || "—"}`);
    return new Response("ok");
  }
  const resp = msg.reply_to_message?.message_id;
  if (!resp || !texto) return new Response("ok");
  const alvo = await env.DB.prepare("SELECT * FROM plt_zap_tg WHERE chat_id=? AND message_id=? AND org_id=?").bind(String(chat.id), resp, conta.org_id).first();
  if (!alvo) return new Response("ok");
  if (/^\/robo/.test(texto)) {
    await env.DB.prepare("UPDATE plt_zap_contatos SET pausado_ate=0 WHERE org_id=? AND telefone=?").bind(conta.org_id, alvo.telefone).run();
    await responder("🤖 O robô voltou a atender esse cliente."); return new Response("ok");
  }
  const autor = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ");
  const r = await enviarDaEquipe(env, k, conta.org_id, alvo.telefone, cortar(texto, 4000));
  if (r.ok) await k.auditar(env, request, null, conta.org_id, "CONVERSA", `Respondeu ${alvo.telefone} pelo Telegram (${autor || "equipe"})`);
  await responder(r.ok ? `✅ Enviado para ${r.nome || alvo.telefone} no WhatsApp. O robô ficou em pausa nessa conversa por 12 h (responda o aviso com /robo para devolver).` : `⚠️ Não foi: ${r.erro}`);
  return new Response("ok");
}

// Para o painel: empresas que usam o chatbot da plataforma.
export async function orgsComChatbot(env) {
  return new Set(((await env.DB.prepare("SELECT org_id FROM plt_zap_contas WHERE phone_number_id IS NOT NULL").all().catch(() => null))?.results || []).map(x => x.org_id));
}
