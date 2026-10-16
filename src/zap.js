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
  `CREATE TABLE IF NOT EXISTS plt_zap_campanhas (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, nome TEXT NOT NULL, modelo TEXT NOT NULL, idioma TEXT NOT NULL, variaveis TEXT, status TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0, enviados INTEGER NOT NULL DEFAULT 0, falhas INTEGER NOT NULL DEFAULT 0, agendada_ms INTEGER, criado_por TEXT, criado_ms INTEGER NOT NULL, fim_ms INTEGER)`,
  `CREATE TABLE IF NOT EXISTS plt_zap_envios (campanha_id INTEGER NOT NULL, org_id INTEGER NOT NULL, telefone TEXT NOT NULL, nome TEXT, status TEXT NOT NULL DEFAULT 'PENDENTE', wamid TEXT, erro TEXT, ms INTEGER, PRIMARY KEY (campanha_id, telefone))`,
  `CREATE INDEX IF NOT EXISTS plt_zap_envios_fila ON plt_zap_envios(status, campanha_id)`,
  // Imagens do fluxo usam a mesma tabela de mídias do Marketing (endereço público assinado /m/…).
  `CREATE TABLE IF NOT EXISTS plt_mk_midias (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, mime TEXT NOT NULL, dados TEXT NOT NULL, prompt TEXT, criado_ms INTEGER NOT NULL)`,
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
  // Listas "limpas" (como no Botpress): sem a dica "Toque em Ver opções" e sem a descrição automática.
  lista_simples: false,
  avisar_buscas: true,
  // Aviso de novo cliente no Telegram (quando ele chega numa loja/resposta do fluxo).
  // Boas-vindas em mensagem separada, antes da mensagem com os botões; e o que fazer com texto livre:
  // BUSCAR (procura pelas palavras-chave) ou INICIO (qualquer mensagem mostra o começo, como no Botpress).
  saudacao: "",
  texto_livre: "BUSCAR",
  // Depois de cada resposta: a pergunta e os três botões (Menu inicial, Voltar, Finalizar).
  rodape_pergunta: "Posso te ajudar com mais alguma coisa?",
  rotulo_menu: "🏠 Menu inicial", rotulo_voltar: "⬅️ Voltar", rotulo_fim: "✅ Finalizar",
  lead_titulo: "🔔 NOVO CLIENTE!",
  lead_tags: "",
  imagem_inicio: ""
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
  if (z.sim) { z.registro.push({ texto: textoLog, interativo: corpo.type === "interactive" ? corpo.interactive : null, ...(corpo.type === "image" ? { imagem: corpo.image.link } : {}) }); return true; }
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
function botoes(z, corpo, lista, origem, imagem) {
  return enviar(z, { type: "interactive", interactive: { type: "button", ...(imagem ? { header: { type: "image", image: { link: imagem } } } : {}), body: { text: cortar(corpo, 1024) }, action: { buttons: lista.slice(0, 3).map(b => ({ type: "reply", reply: { id: b.id, title: cortar(b.titulo, 20) } })) } } },
    `${corpo} ${lista.map(b => `[${b.titulo}]`).join(" ")}`, origem);
}
function lista(z, corpo, secao, linhas, origem) {
  return enviar(z, { type: "interactive", interactive: { type: "list", body: { text: cortar(corpo, 1024) }, action: { button: "Ver opções", sections: [{ title: cortar(secao, 24), rows: linhas.slice(0, 10).map(l => ({ id: l.id, title: cortar(l.titulo, 24), ...(l.descricao ? { description: cortar(l.descricao, 72) } : {}) })) }] } } },
    `${corpo} [lista: ${linhas.map(l => l.titulo).join(", ")}]`, origem);
}

// Uma linha com "---" no meio de um texto separa mensagens (cada parte vai num balão, na ordem).
export function partesMsg(t) { return String(t || "").split(/\n*^\s*-{3,}\s*$\n*/m).map(x => x.trim()).filter(Boolean); }
async function enviarPartes(z, texto, origem) { for (const p of partesMsg(texto)) await enviarTexto(z, p, origem); }

// Imagens do fluxo: guardadas na DENIA e servidas por um endereço público assinado (o WhatsApp busca por ele).
async function urlImagem(z, id) {
  id = Number(id);
  if (!id) return "";
  const sig = (await z.k.hmac(await z.k.segredo(z.env), "midia-publica:" + id)).slice(0, 32);
  const base = z.sim ? "" : String(z.env.SITE_URL || z.k.base || "").replace(/\/+$/, "");
  return `${base}/m/${id}-${sig}.jpg`;
}
const enviarImagem = (z, url, legenda, origem) => enviar(z, { type: "image", image: { link: url, ...(legenda ? { caption: cortar(legenda, 1024) } : {}) } }, `[imagem] ${legenda || ""}`.trim(), origem);
// Cartão: imagem (opcional) + texto + botão de link (abre site, Instagram, mapa, WhatsApp da loja…).
async function enviarCartao(z, c, origem) {
  const img = c.imagem_id ? await urlImagem(z, c.imagem_id) : "";
  const texto = [c.titulo ? `*${c.titulo}*` : "", c.texto || ""].filter(Boolean).join("\n") || (img ? "" : "…");
  if (c.link_url && c.link_texto) {
    return enviar(z, { type: "interactive", interactive: { type: "cta_url", ...(img ? { header: { type: "image", image: { link: img } } } : {}), body: { text: cortar(texto || c.link_texto, 1024) },
      action: { name: "cta_url", parameters: { display_text: cortar(c.link_texto, 20), url: c.link_url } } } }, `${texto} [${c.link_texto}: ${c.link_url}]`, origem);
  }
  if (img) return enviarImagem(z, img, texto, origem);
  return enviarTexto(z, texto, origem);
}
function extraDe(i) { if (i && typeof i.extra === "object" && i.extra) return i.extra; try { return JSON.parse(i?.extra || "{}") || {}; } catch { return {}; } }

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
async function telegram(z, texto, telCliente, semDica = false, markdown = false) {
  if (z.sim) return false;
  const d = await destinoTelegram(z.env, z.k, z.conta);
  if (!d) return false;
  const corpo = cortar(texto, 3500) + (telCliente && !semDica ? "\n\n↩️ Responda esta mensagem aqui no Telegram e a resposta vai para o cliente no WhatsApp." : "");
  let r = await tgApi(d.token, "sendMessage", { chat_id: d.chat, text: corpo, disable_web_page_preview: true, ...(markdown ? { parse_mode: "Markdown" } : {}) });
  // Se o Telegram recusar a formatação, manda o mesmo aviso sem negrito.
  if (markdown && !r?.ok) r = await tgApi(d.token, "sendMessage", { chat_id: d.chat, text: corpo.replace(/\\([_*`\[])/g, "$1").replace(/\*/g, ""), disable_web_page_preview: true });
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
  if (cfg.lista_simples) return "";
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
  const partes = partesMsg(pai ? (pai.texto || `${pai.titulo}: escolha uma opção.`) : z.cfg.boas_vindas);
  // As partes antes da última vão em balões separados (só na primeira página).
  if (pagina === 0) for (const p of partes.slice(0, -1)) await enviarTexto(z, p);
  const corpo = (prefixo ? prefixo + "\n\n" : "") + (partes.at(-1) || "Escolha uma opção:");
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
  const imgId = pagina === 0 ? (pai ? extraDe(pai).imagem_id : Number(z.cfg.imagem_inicio) || 0) : 0;
  const img = imgId ? await urlImagem(z, imgId) : "";
  if (itens.length <= 3 && pagina === 0 && itens.every(i => [...i.titulo].length <= 20)) return botoes(z, corpo, itens.map(i => ({ id: "z:i:" + i.id, titulo: i.titulo })), undefined, img);
  if (img) await enviarImagem(z, img, "");
  // Até 10 opções cabem numa lista só (limite do WhatsApp); com mais, 9 por vez + "Mais opções".
  const cabe = itens.length <= 10 && pagina === 0;
  const porPagina = cabe ? 10 : 9, ini = pagina * porPagina, parte = itens.slice(ini, ini + porPagina);
  const linhas = parte.map(i => ({ id: "z:i:" + i.id, titulo: i.titulo, descricao: descricaoDe(i, z.cfg, m) }));
  if (ini + porPagina < itens.length) linhas.push({ id: `z:pg:${menuId}:${pagina + 1}`, titulo: "➡️ Mais opções", descricao: "Ver as próximas" });
  else if (!cabe && (menuId || pagina)) linhas.push({ id: "z:inicio", titulo: z.cfg.rotulo_menu || "🏠 Menu inicial", descricao: "Voltar ao começo" });
  return lista(z, corpo + (itens.length > porPagina ? `\n\nSão ${itens.length} opções: toque em "Ver opções" (as próximas ficam em "Mais opções") ou escreva o que procura.` : z.cfg.lista_simples ? "" : "\n\nToque em \"Ver opções\" e escolha."), pai ? pai.titulo : "Opções", linhas);
}
// Começo da conversa: a boas-vindas (se houver) numa mensagem e o menu com os botões em outra.
async function mostrarInicio(z) {
  await enviarPartes(z, z.cfg.saudacao);
  return mostrarMenu(z);
}
async function rodape(z, item) {
  const lista = [{ id: "z:inicio", titulo: z.cfg.rotulo_menu || "🏠 Menu inicial" }];
  if (item && item.pai_id) lista.push({ id: "z:i:" + item.pai_id, titulo: z.cfg.rotulo_voltar || "⬅️ Voltar" });
  lista.push({ id: "z:fim", titulo: z.cfg.rotulo_fim || "✅ Finalizar" });
  return botoes(z, z.cfg.rodape_pergunta || "Posso te ajudar com mais alguma coisa?", lista);
}
async function registrarBusca(z, item, via, resultados, caminho) {
  const umaHora = z.agora - 3600000;
  const [repetida] = z.sim ? [null] : await z.env.DB.batch([
    z.env.DB.prepare("SELECT 1 x FROM plt_zap_buscas WHERE org_id=? AND telefone=? AND item_id=? AND criado_ms>? LIMIT 1").bind(z.org, z.tel, item.id, umaHora),
    z.env.DB.prepare("INSERT INTO plt_zap_buscas(org_id,telefone,nome,item_id,tipo,titulo,caminho,texto,via,resultados,criado_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(z.org, z.tel, z.nome || "", item.id, item.tipo, item.titulo, caminho, cortar(z.texto, 300), via, resultados, z.agora)
  ]);
  if (z.cfg.avisar_buscas && item.tipo !== "HUMANO" && extraDe(item).lead !== false && !(repetida?.results || []).length)
    await telegram(z, textoLead(z, caminho), z.tel, true, true);
}
const semAcento = t => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
export function tagsLead(cfg, nomeEmpresa) {
  const proprias = String(cfg.lead_tags || "").trim();
  if (proprias) return proprias.split(/[\s,]+/).filter(Boolean).map(t => "#" + semAcento(t.replace(/^#+/, "")).replace(/[^A-Za-z0-9_]/g, "")).filter(t => t.length > 1).join(" ");
  const nome = semAcento(nomeEmpresa).toLowerCase().replace(/\b(shopping|loja|lojas|centro|ltda|me|eireli|s\.?a\.?)\b/g, "").replace(/[^a-z0-9]/g, "");
  return [nome ? "#" + nome.slice(0, 30) : "", "#leads"].filter(Boolean).join(" ");
}
// Markdown do Telegram: o que vem do cliente não pode abrir negrito/itálico por engano.
const semMarkdown = t => String(t || "").replace(/([_*`\[])/g, "\\$1");
export function textoLead(z, caminho) {
  const quando = new Date(z.agora).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", hour12: false, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const pedido = String(caminho || "").split(" › ").join(" > ");
  return [z.cfg.lead_titulo || ZAP_PADRAO.lead_titulo, "",
    `👤 *Nome:* ${semMarkdown(z.nome || "Cliente")}`, `📱 *WhatsApp:* ${z.tel}`, `💬 *Pedido:* ${semMarkdown(pedido)}`,
    `🕒 *Horário:* ${quando}`, "", semMarkdown(tagsLead(z.cfg, z.nomeEmpresa))].join("\n").trim();
}
async function abrirItem(z, item, via) {
  const m = await carregarMenu(z);
  const caminho = caminhoDe(m, item);
  const origem = via === "IA" ? "IA" : "ROBO";
  if (item.tipo === "MENU") return mostrarMenu(z, item.id);
  if (item.tipo === "HUMANO") { await transferir(z, item.texto); return registrarBusca(z, item, via, 0, caminho); }
  const ex = extraDe(item);
  if (item.tipo === "RESPOSTA") {
    const temRico = ex.imagem_id || (ex.link_url && ex.link_texto);
    const partesR = partesMsg(item.texto || item.titulo);
    if (temRico) { for (const p of partesR.slice(0, -1)) await enviarTexto(z, p, origem); await enviarCartao(z, { imagem_id: ex.imagem_id, texto: partesR.at(-1) || item.titulo, link_texto: ex.link_texto, link_url: ex.link_url }, origem); }
    else for (const p of partesR) await enviarTexto(z, p, origem);
    // Carrossel: até 4 cartões (imagem + texto + botão), um embaixo do outro.
    for (const c of (Array.isArray(ex.cartoes) ? ex.cartoes : []).slice(0, 4)) await enviarCartao(z, c, origem);
    await rodape(z, item);
    return registrarBusca(z, item, via, 0, caminho);
  }
  // LISTA: os contatos do catálogo ligados a esta opção.
  const r = (await z.env.DB.prepare("SELECT c.* FROM plt_zap_catalogo c JOIN plt_zap_cat_itens ci ON ci.catalogo_id=c.id WHERE ci.item_id=? AND c.org_id=? AND c.ativo=1 ORDER BY COALESCE(ci.ordem, 999999), c.destaque DESC, c.nome LIMIT 25").bind(item.id, z.org).all())?.results || [];
  if (ex.estilo === "CARTOES" && r.length && r.length <= 4) {
    // Um cartão por loja, com o botão "Chamar no WhatsApp".
    await enviarTexto(z, `*${item.titulo}*${item.texto ? "\n" + item.texto : ""}`, origem);
    for (const c of r) {
      const link = linkLoja(c);
      await enviarCartao(z, { titulo: c.nome, texto: [c.local, c.descricao ? cortar(c.descricao, 200) : ""].filter(Boolean).join("\n") || " ", ...(link ? { link_texto: "💬 Chamar no WhatsApp", link_url: link } : {}) }, origem);
    }
  } else {
    const linhas = r.map(cartaoContato);
    // Todas as lojas numa mensagem só; a mensagem da opção (se houver) vem no topo, no lugar do título.
    const partesL = partesMsg(item.texto);
    if (r.length) for (const p of partesL.slice(0, -1)) await enviarTexto(z, p, origem);
    const texto = r.length ? `${partesL.length ? partesL.at(-1) : `*${item.titulo}*`}\n\n${linhas.join("\n\n")}${z.cfg.rodape_lista ? "\n\n" + z.cfg.rodape_lista : ""}` : `No momento não tenho ${z.cfg.rotulo_catalogo} cadastrados para *${item.titulo}*.`;
    await enviarTexto(z, texto, origem);
  }
  await rodape(z, item);
  z.resultados = r.map(c => c.nome).join(", ");
  return registrarBusca(z, item, via, r.length, caminho);
}
// Link da loja: o próprio (ex.: tinyurl com mensagem pronta) ou o wa.me do WhatsApp dela.
function linkLoja(c) { if (c.link) return c.link; const zap = linkZap(c.whatsapp || c.telefone); return zap ? "https://" + zap : ""; }
// Uma loja por bloco: "Loja 12 - Cell Center" e o link embaixo (clicável no WhatsApp).
function cartaoContato(c) {
  const link = linkLoja(c);
  return [[c.local, c.nome].filter(Boolean).join(" - "), c.descricao ? cortar(c.descricao, 140) : "", link || (c.telefone ? `📞 ${c.telefone}` : ""),
    c.telefone && link && !c.link && c.whatsapp && digitos(c.telefone) !== digitos(c.whatsapp) ? `📞 ${c.telefone}` : ""].filter(Boolean).join("\n");
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
  if (acao === "z:fim") return enviarPartes(z, z.cfg.encerramento + (z.cfg.rede_url ? `\n\nSiga a gente${z.cfg.rede_nome ? " no " + z.cfg.rede_nome : ""}: ${z.cfg.rede_url}` : ""));
  let a;
  if ((a = acao.match(/^z:pg:(\d+):(\d+)$/))) return mostrarMenu(z, Number(a[1]), Number(a[2]));
  if ((a = acao.match(/^z:i:(\d+)$/))) { const it = m.porId.get(Number(a[1])); return it ? abrirItem(z, it, "BOTAO") : mostrarMenu(z); }
  const alvo = norm(texto).trim();
  if (z.modo !== "IA" && z.cfg.texto_livre === "INICIO" && !/^\d{1,3}$/.test(alvo) && !QUER_HUMANO.test(alvo)) return mostrarInicio(z);
  if (!alvo) return mostrarMenu(z, 0, 0, z.cfg.nao_entendi);
  if (QUER_HUMANO.test(alvo)) { const h = m.todos.find(i => i.tipo === "HUMANO"); await transferir(z, h?.texto); return h ? registrarBusca(z, h, "PALAVRA", 0, caminhoDe(m, h)) : null; }
  // IA completa: a conversa é com a IA (os botões continuam funcionando); sem IA disponível, cai no menu.
  if (z.modo === "IA" && !/^\d{1,3}$/.test(alvo)) { if (await atenderComIA(z, texto, m)) return; }
  if (SAUDACAO.test(alvo) && alvo.length < 30) return mostrarInicio(z);
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
  // Endereço público desta plataforma (a Meta chamou aqui): usado nos links das imagens do fluxo.
  if (!k.base) k = { ...k, base: url.origin };
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
      const falhas = v.statuses.filter(s => s.status === "failed" || s.status === "read" || s.status === "delivered").slice(0, 50);
      if (falhas.length) await env.DB.batch(falhas.map(s => env.DB.prepare("UPDATE plt_zap_envios SET status=?, erro=COALESCE(?, erro) WHERE wamid=? AND org_id=?")
        .bind(s.status === "failed" ? "FALHOU" : s.status === "read" ? "LIDA" : "ENTREGUE", s.errors?.[0] ? cortar(`${s.errors[0].code}: ${s.errors[0].error_data?.details || s.errors[0].title || ""}`, 300) : null, String(s.id || ""), conta.org_id))).catch(() => { });
    }
    if (!conta.ativo || conta.org_status !== "ATIVA") continue;
    // Plano: sem teste ou pagamento em dia, as mensagens só ficam registradas (o robô não responde).
    if (!conta.acesso) conta.acesso = acessoDa(conta, k.agora(env), (await lerPlanos(env)).planos);
    // Coexistência: o que a equipe responde pelo aplicativo WhatsApp Business no celular chega como "eco".
    // Fica na conversa como resposta da equipe e o robô pausa naquela conversa (quem está atendendo é gente).
    for (const ec of (v.message_echoes || []).slice(0, 20)) {
      const tel = digitos(ec.to), wamid = String(ec.id || "");
      if (!tel || !wamid) continue;
      const texto = ec.type === "text" ? String(ec.text?.body || "") : `[${ec.type || "mensagem"} enviada pelo celular]`;
      const ag = k.agora(env);
      await env.DB.batch([
        env.DB.prepare("INSERT OR IGNORE INTO plt_zap_msgs(org_id,telefone,direcao,origem,texto,wamid,status,criado_ms) VALUES(?,?,'S','EQUIPE',?,?,'ENVIADA',?)").bind(conta.org_id, tel, cortar(texto, 4000), wamid, ag),
        env.DB.prepare("INSERT INTO plt_zap_contatos(org_id,telefone,pausado_ate,ultimo_ms) VALUES(?,?,?,?) ON CONFLICT(org_id,telefone) DO UPDATE SET pausado_ate=MAX(pausado_ate, excluded.pausado_ate), ultimo_ms=excluded.ultimo_ms").bind(conta.org_id, tel, ag + PAUSA_HUMANO_MS, ag)
      ]);
    }
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
const JANELA_AGRUPAR_MS = 8000; // dentro dos 30 s que a Cloudflare dá depois de responder ao webhook
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
    env.DB.prepare("SELECT pausado_ate, nome, ultimo_menu, optout FROM plt_zap_contatos WHERE org_id=? AND telefone=?").bind(z.org, tel),
    env.DB.prepare("SELECT COUNT(*) n FROM plt_zap_msgs WHERE org_id=? AND telefone=? AND direcao='S' AND criado_ms>?").bind(z.org, tel, agora - 600000),
    env.DB.prepare("SELECT id FROM plt_zap_msgs WHERE wamid=?").bind(wamid)
  ]);
  z.msgId = Number(idMsg?.results?.[0]?.id || 0);
  if (!Number(ins?.meta?.changes)) return; // a Meta reenviou a mesma mensagem
  const enviadaMs = Number(msg.timestamp || 0) * 1000;
  if (enviadaMs && agora - enviadaMs > 30 * 60000) return; // mensagem velha (reenvio depois de queda): não responde fora de hora
  const c = ctt?.results?.[0] || {};
  // Descadastro de campanhas: "SAIR"/"PARAR" tira o contato das próximas campanhas (exigência da Meta e da LGPD).
  if (/^\s*(sair|parar|pare|cancelar inscri[cç][aã]o|descadastrar|stop|unsubscribe)\s*[.!]?\s*$/i.test(e.texto)) {
    await env.DB.prepare("UPDATE plt_zap_contatos SET optout=1 WHERE org_id=? AND telefone=?").bind(z.org, tel).run().catch(() => { });
    await enviarTexto(z, "Pronto: você não vai mais receber nossas campanhas por aqui. Para voltar, é só mandar VOLTAR. O atendimento continua normal.", "ROBO");
    return;
  }
  if (/^\s*voltar\s*[.!]?\s*$/i.test(e.texto) && Number(c.optout || 0)) await env.DB.prepare("UPDATE plt_zap_contatos SET optout=0 WHERE org_id=? AND telefone=?").bind(z.org, tel).run().catch(() => { });
  if (Number(c.pausado_ate || 0) > agora) return; // a equipe está atendendo
  if (Number(recentes?.results?.[0]?.n || 0) >= 25) return; // trava contra robô conversando com robô
  if (!rec.includes("chatbot")) return;
  z.nome = nome || c.nome || "";
  z.ultimoMenu = c.ultimo_menu;
  // Cliente escrevendo em várias mensagens seguidas ("oi" / "tudo bem?" / "quanto custa?"): espera ele
  // parar e responde UMA vez, pela mensagem mais nova. Cliques em botões e listas respondem na hora.
  let texto = e.texto;
  if (!e.acao) {
    const espera = env.ZAP_JANELA_MS !== undefined && env.ZAP_JANELA_MS !== "" ? Number(env.ZAP_JANELA_MS) : env.__semEspera ? 0 : JANELA_AGRUPAR_MS;
    if (espera > 0) await new Promise(r => setTimeout(r, Math.min(20000, espera)));
    const nova = await env.DB.prepare("SELECT MAX(id) id FROM plt_zap_msgs WHERE org_id=? AND telefone=? AND direcao='E'").bind(z.org, tel).first();
    if (Number(nova?.id || 0) > z.msgId) return; // chegou outra depois desta: ela responde por todas
    if (z.modo === "IA") {
      // A IA lê tudo o que o cliente mandou desde a última resposta, como uma mensagem só.
      const juntas = (await env.DB.prepare(`SELECT texto FROM plt_zap_msgs WHERE org_id=? AND telefone=? AND direcao='E' AND criado_ms>?
        AND id > COALESCE((SELECT MAX(id) FROM plt_zap_msgs WHERE org_id=? AND telefone=? AND direcao='S'), 0) ORDER BY id DESC LIMIT 8`)
        .bind(z.org, tel, agora - 10 * 60000, z.org, tel).all())?.results || [];
      const lista = juntas.reverse().map(x => String(x.texto || "").trim()).filter(Boolean);
      if (lista.length > 1) texto = cortar(lista.join("\n"), 2000);
    }
    if (Number((await env.DB.prepare("SELECT pausado_ate FROM plt_zap_contatos WHERE org_id=? AND telefone=?").bind(z.org, tel).first())?.pausado_ate || 0) > k.agora(env)) return; // a equipe assumiu enquanto esperava
  }
  await responder(z, texto, e.acao);
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

// ---------------------------------------------------------------------------
// Roteiro em texto: o fluxo inteiro escrito como num documento (sem programar).
//   BOAS-VINDAS: primeira mensagem (sozinha)
//   MENU: mensagem com os botões do começo
//   > Botão do começo            >> botão dentro dele      >>> e assim por diante
//   linhas abaixo do botão = a mensagem dele
//   Nome da loja | https://link   (ou | telefone) = loja (o botão vira "Lojas")
//   [atendente] no fim do nome    = chama a equipe
// ---------------------------------------------------------------------------
const CHAVES_ROTEIRO = { "BOAS-VINDAS": "saudacao", "BOAS VINDAS": "saudacao", "MENU": "boas_vindas", "NÃO ENTENDI": "nao_entendi", "NAO ENTENDI": "nao_entendi", "ATENDENTE": "humano", "ENCERRAMENTO": "encerramento", "RODAPÉ DAS LOJAS": "rodape_lista", "RODAPE DAS LOJAS": "rodape_lista",
  "DEPOIS DE CADA RESPOSTA": "rodape_pergunta", "BOTÕES DO FIM": "_botoes_fim", "BOTOES DO FIM": "_botoes_fim",
  "TÍTULO DO AVISO": "lead_titulo", "TITULO DO AVISO": "lead_titulo", "ETIQUETAS DO AVISO": "lead_tags", "LISTAS SIMPLES": "_lista_simples", "QUALQUER MENSAGEM": "_texto_livre" };
export function lerRoteiro(texto) {
  const linhas = String(texto || "").replace(/\r\n?/g, "\n").split("\n");
  const cfg = {}, raiz = { filhos: [], nivel: 0 }, pilha = [raiz], erros = [];
  let alvo = null; // { tipo: "cfg", chave } | { tipo: "no", no }
  let paragrafo = false; // linha em branco entre duas linhas de texto = parágrafo novo
  const juntar = (atual, linha) => { const r = atual ? atual + (paragrafo ? "\n\n" : "\n") + linha : linha; paragrafo = false; return r; };
  linhas.forEach((bruta, n) => {
    const linha = bruta.trim();
    const num = n + 1;
    if (!linha) { paragrafo = true; return; }
    if (/^#\s/.test(linha)) return; // comentário ("# texto")
    const ch = linha.match(/^([^:>|]{3,30}):\s*(.*)$/u);
    if (ch && CHAVES_ROTEIRO[ch[1].trim().toUpperCase()]) { const chave = CHAVES_ROTEIRO[ch[1].trim().toUpperCase()]; cfg[chave] = ch[2].trim() === "-" ? "" : ch[2].trim(); alvo = { tipo: "cfg", chave }; paragrafo = false; return; }
    const b = linha.match(/^(>+)\s*(.+)$/);
    if (b) {
      const nivel = b[1].length;
      if (nivel > pilha.length) { erros.push(`Linha ${num}: "${b[1]}" pulou um nível (o botão de cima tem ${pilha.length - 1} ">").`); return; }
      if (nivel > 8) { erros.push(`Linha ${num}: no máximo 8 níveis.`); return; }
      let titulo = b[2].trim(), tipo = "";
      let semAviso = false;
      for (let marca; (marca = titulo.match(/\s*\[(atendente|humano|resposta|lojas|sem aviso)\]\s*$/i));) {
        const m2 = marca[1].toLowerCase();
        if (m2 === "sem aviso") semAviso = true; else tipo = { atendente: "HUMANO", humano: "HUMANO", resposta: "RESPOSTA", lojas: "LISTA" }[m2];
        titulo = titulo.slice(0, marca.index).trim();
      }
      if (titulo.length > 24) erros.push(`Linha ${num}: "${titulo}" tem ${titulo.length} letras; o WhatsApp aceita até 24 no botão (20 aparecem).`);
      const no = { titulo: titulo.slice(0, 24), tipo, texto: "", lojas: [], filhos: [], nivel, linha: num, semAviso };
      pilha.length = nivel; pilha[nivel - 1].filhos.push(no); pilha.push(no);
      alvo = { tipo: "no", no }; paragrafo = false;
      return;
    }
    const loja = linha.match(/^(.+?)\s*\|\s*(\S.*)$/);
    if (loja && alvo && alvo.tipo === "no") {
      const nomeL = loja[1].trim().replace(/^[-•*]\s*/, ""), destino = loja[2].trim();
      // O nome fica exatamente como foi escrito (ex.: "Loja 04- Conserta Celular").
      const l = { local: "", nome: nomeL };
      if (/^https:\/\//i.test(destino)) l.link = destino.split(/\s+/)[0];
      else if (digitos(destino).length >= 10) l.whatsapp = digitos(destino);
      else { erros.push(`Linha ${num}: depois da "|" vem o link (https://…) ou o WhatsApp da loja.`); return; }
      alvo.no.lojas.push(l);
      return;
    }
    if (!alvo) { erros.push(`Linha ${num}: comece com "BOAS-VINDAS:", "MENU:" ou um botão "> Nome".`); return; }
    if (alvo.tipo === "cfg") cfg[alvo.chave] = juntar(cfg[alvo.chave], linha);
    else alvo.no.texto = juntar(alvo.no.texto, linha);
  });
  const limpar = t => String(t || "").replace(/\n{3,}/g, "\n\n").trim();
  for (const k of Object.keys(cfg)) cfg[k] = limpar(cfg[k]);
  if (cfg._lista_simples !== undefined) { cfg.lista_simples = /^(sim|s|true|1)$/i.test(cfg._lista_simples); delete cfg._lista_simples; }
  if (cfg._texto_livre !== undefined) { cfg.texto_livre = /come[cç]o|in[ií]cio/i.test(cfg._texto_livre) ? "INICIO" : "BUSCAR"; delete cfg._texto_livre; }
  if (cfg._botoes_fim !== undefined) {
    const [a, b2, c] = cfg._botoes_fim.split("|").map(x => x.trim());
    delete cfg._botoes_fim;
    if (a) cfg.rotulo_menu = a.slice(0, 20); if (b2) cfg.rotulo_voltar = b2.slice(0, 20); if (c) cfg.rotulo_fim = c.slice(0, 20);
    for (const x of [a, b2, c]) if (x && x.length > 20) erros.push(`"${x}": os botões do fim aceitam até 20 letras.`);
  }
  const fechar = no => {
    no.texto = limpar(no.texto);
    if (!no.tipo) no.tipo = no.filhos.length ? "MENU" : no.lojas.length ? "LISTA" : "RESPOSTA";
    if (no.filhos.length && no.tipo !== "MENU") erros.push(`Linha ${no.linha}: "${no.titulo}" tem botões dentro, então não pode ser ${no.tipo === "LISTA" ? "lojas" : "resposta/atendente"}.`);
    if (no.lojas.length && no.filhos.length) erros.push(`Linha ${no.linha}: "${no.titulo}" tem lojas e botões dentro ao mesmo tempo. Separe em botões diferentes.`);
    if (no.tipo === "RESPOSTA" && !no.texto) erros.push(`Linha ${no.linha}: "${no.titulo}" não tem mensagem nem lojas embaixo.`);
    no.filhos.forEach(fechar);
  };
  raiz.filhos.forEach(fechar);
  if (!raiz.filhos.length) erros.push("O roteiro não tem nenhum botão (linhas começando com \">\").");
  return { cfg, botoes: raiz.filhos, erros };
}
export function escreverRoteiro(itens, catalogo, ligacoes, cfg, ordemLig = new Map()) {
  const out = [];
  if (cfg.saudacao) out.push("BOAS-VINDAS: " + cfg.saudacao, "");
  out.push("MENU: " + (cfg.boas_vindas || ""), "");
  out.push("DEPOIS DE CADA RESPOSTA: " + (cfg.rodape_pergunta || ZAP_PADRAO.rodape_pergunta));
  out.push(`BOTÕES DO FIM: ${cfg.rotulo_menu || ZAP_PADRAO.rotulo_menu} | ${cfg.rotulo_voltar || ZAP_PADRAO.rotulo_voltar} | ${cfg.rotulo_fim || ZAP_PADRAO.rotulo_fim}`);
  if (cfg.encerramento) out.push("ENCERRAMENTO: " + cfg.encerramento);
  out.push("RODAPÉ DAS LOJAS: " + (cfg.rodape_lista || "-"));
  out.push("QUALQUER MENSAGEM: " + (cfg.texto_livre === "INICIO" ? "mostra o começo" : "procura pelas palavras"));
  out.push("LISTAS SIMPLES: " + (cfg.lista_simples ? "sim" : "não"));
  out.push("TÍTULO DO AVISO: " + (cfg.lead_titulo || ZAP_PADRAO.lead_titulo));
  if (cfg.lead_tags) out.push("ETIQUETAS DO AVISO: " + cfg.lead_tags);
  out.push("");
  const lojasDo = id => catalogo.filter(c => (ligacoes.get(c.id) || []).includes(id)).sort((a, b) => (ordemLig.get(id + ":" + a.id) ?? 999999) - (ordemLig.get(id + ":" + b.id) ?? 999999));
  const descer = (pai, nivel) => itens.filter(i => Number(i.pai_id) === pai).sort((a, b) => (a.ordem || 0) - (b.ordem || 0) || a.id - b.id).forEach(i => {
    const marca = (i.tipo === "HUMANO" ? " [atendente]" : i.tipo === "LISTA" && !lojasDo(i.id).length ? " [lojas]" : "") + (i.tipo !== "HUMANO" && i.tipo !== "MENU" && extraDe(i).lead === false ? " [sem aviso]" : "");
    out.push(">".repeat(nivel) + " " + i.titulo + marca);
    if (i.texto) out.push(i.texto);
    for (const c of lojasDo(i.id)) out.push(`${[c.local, c.nome].filter(Boolean).join(" - ")} | ${c.link || c.whatsapp || c.telefone || ""}`);
    out.push("");
    if (i.tipo === "MENU") descer(i.id, nivel + 1);
  });
  descer(0, 1);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// ---------------------------------------------------------------------------
// Botpress → roteiro: lê o fluxo "Main" exportado (.bpz → bot.json) e escreve o roteiro igual,
// na mesma ordem, com os mesmos textos. O navegador já tira o código das ações (tokens) antes de enviar.
// ---------------------------------------------------------------------------
export function roteiroDoBotpress(bot) {
  const fluxos = Array.isArray(bot?.flows) ? bot.flows : [];
  const main = fluxos.find(f => f?.name === "Main") || fluxos.find(f => (f?.nodes || []).some(n => n?.type === "start"));
  if (!main) throw new Error("Não achei o fluxo principal (Main) no arquivo do Botpress.");
  const nos = new Map((main.nodes || []).map(n => [n.id, n]));
  const val = v => typeof v === "string" ? v : String(v?.dynamicValue || v?.staticValue || "");
  const ins = n => Array.isArray(n?.instructions) ? n.instructions : [];
  const textos = n => ins(n).filter(i => i.type === "content" && i.content?.type === "text").map(i => val(i.content.text).trim()).filter(Boolean);
  const captura = n => ins(n).find(i => i.type === "capture");
  const proximo = n => ins(n).find(i => i.type === "transition")?.destination?.node || n?.defaultTransition?.targetNodeId || null;
  const VOLTA = /^(menu\s+(principal|pincipal|inicial|anterior)|finalizar|voltar|in[ií]cio)$/i;
  const opcoes = cap => (cap?.transitions || []).filter(t => t?.destination?.node).map(t => ({ rotulo: String(t.label || t.condition?.payload?.match(/__CHOICE=(.+)$/)?.[1] || "").trim(), destino: t.destination.node }));
  let rodape = null, tagsAviso = "", tituloAviso = "";
  // Segue o caminho até um nó que pergunta (ou até o fim), juntando as mensagens e vendo se passou por um aviso.
  const resolver = id => {
    const r = { msgs: [], cap: null, aviso: false };
    for (let passo = 0; id && passo < 12; passo++) {
      const n = nos.get(id);
      if (!n || n.type === "end") break;
      for (const a of ins(n).filter(i => i.type === "action")) { r.aviso = true; if (a.hashtags && !tagsAviso) tagsAviso = a.hashtags; if (a.titulo && !tituloAviso) tituloAviso = a.titulo; }
      r.msgs.push(...textos(n));
      r.cap = captura(n);
      if (r.cap) break;
      id = proximo(n);
    }
    return r;
  };
  const ehRodape = cap => { const o = opcoes(cap); return o.length > 0 && o.every(x => VOLTA.test(x.rotulo)); };
  const nomeBotao = t => { t = String(t).replace(/\s+/g, " ").trim(); if ([...t].length > 24) t = t.replace(/\s*\|\s*/g, "|").replace(/\s*\/\s*/g, "/"); return [...t].slice(0, 24).join("").trim(); };
  const LOJA = /^([^\n]{1,100}?)\s*\n?\s*(https:\/\/\S+)\s*$/;
  const linhas = [];
  let encerramento = "";
  const escrever = (rot, r, nivel, caminho) => {
    const o = r.cap && !ehRodape(r.cap) ? opcoes(r.cap) : [];
    if (r.cap && ehRodape(r.cap) && !rodape) {
      rodape = { pergunta: val(r.cap.question).trim(), rotulos: opcoes(r.cap).map(x => x.rotulo) };
      const fim = opcoes(r.cap).find(x => /^finalizar/i.test(x.rotulo));
      if (fim) encerramento = resolver(fim.destino).msgs.join("\n---\n");
    }
    const lojas = [], outros = [];
    for (const m of r.msgs) { const l = m.match(LOJA); if (!o.length && l && !/\n/.test(l[1].trim())) lojas.push(`${l[1].trim().replace(/[:\s]+$/, "")} | ${l[2]}`); else outros.push(m); }
    const marca = !o.length && !r.aviso ? " [sem aviso]" : "";
    linhas.push(">".repeat(nivel) + " " + nomeBotao(rot) + (!o.length && !lojas.length && !outros.length ? " [resposta]" : "") + marca);
    const corpo = [...outros, ...(o.length ? [val(r.cap.question).trim()] : [])].filter(Boolean);
    if (corpo.length) linhas.push(corpo.join("\n---\n"));
    linhas.push(...lojas, "");
    if (nivel >= 8) return;
    for (const x of o) { if (caminho.has(x.destino)) continue; escrever(x.rotulo, resolver(x.destino), nivel + 1, new Set([...caminho, x.destino])); }
  };
  const inicio = nos.get(main.startNode) || [...nos.values()].find(n => n.type === "start");
  const raiz = resolver(proximo(inicio));
  if (!raiz.cap) throw new Error("O fluxo do Botpress não tem um menu com opções depois do início.");
  for (const x of opcoes(raiz.cap)) escrever(x.rotulo, resolver(x.destino), 1, new Set([x.destino]));
  const cab = ["# Convertido do Botpress pela DENIA. Uma linha com --- separa mensagens (cada parte vai num balão).",
    "BOAS-VINDAS: " + (raiz.msgs.join("\n---\n") || "-"),
    "MENU: " + val(raiz.cap.question).trim(),
    "QUALQUER MENSAGEM: mostra o começo",
    "LISTAS SIMPLES: sim",
    "RODAPÉ DAS LOJAS: -"];
  if (rodape) {
    cab.push("DEPOIS DE CADA RESPOSTA: " + rodape.pergunta);
    const r3 = rodape.rotulos.map(t => t.replace(/pincipal/i, "Principal"));
    cab.push(`BOTÕES DO FIM: ${r3.find(t => /principal|inicial|in[ií]cio/i.test(t)) || "Menu Principal"} | ${r3.find(t => /anterior|voltar/i.test(t)) || "Menu Anterior"} | ${r3.find(t => /finalizar/i.test(t)) || "Finalizar"}`);
  }
  if (encerramento) cab.push("ENCERRAMENTO: " + encerramento);
  if (tituloAviso) cab.push("TÍTULO DO AVISO: " + tituloAviso);
  if (tagsAviso) cab.push("ETIQUETAS DO AVISO: " + tagsAviso);
  return cab.join("\n") + "\n\n" + linhas.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

const URL_OK = u => /^https:\/\/[^\s<>"']{4,600}$/i.test(String(u || "").trim());
async function midiaDaEmpresa(env, orgId, id) {
  id = Number(id) || 0;
  if (!id) return 0;
  const x = await env.DB.prepare("SELECT id FROM plt_mk_midias WHERE id=? AND org_id=?").bind(id, orgId).first().catch(() => null);
  return x ? id : 0;
}
async function limparExtra(env, orgId, e) {
  e = e && typeof e === "object" ? e : {};
  const out = {};
  const img = await midiaDaEmpresa(env, orgId, e.imagem_id);
  if (img) out.imagem_id = img;
  const lt = cortar(e.link_texto, 20), lu = String(e.link_url || "").trim();
  if (lt || lu) {
    if (!lt || !URL_OK(lu)) return { erro: "O botão de link precisa de um nome (até 20 letras) e de um endereço que comece com https://" };
    out.link_texto = lt; out.link_url = lu;
  }
  const cartoes = [];
  for (const c of (Array.isArray(e.cartoes) ? e.cartoes : []).slice(0, 4)) {
    const x = { titulo: cortar(c?.titulo, 60), texto: cortar(c?.texto, 600) };
    const ci = await midiaDaEmpresa(env, orgId, c?.imagem_id);
    if (ci) x.imagem_id = ci;
    const clt = cortar(c?.link_texto, 20), clu = String(c?.link_url || "").trim();
    if (clt || clu) {
      if (!clt || !URL_OK(clu)) return { erro: `O botão do cartão "${x.titulo || cartoes.length + 1}" precisa de nome e de um endereço https://` };
      x.link_texto = clt; x.link_url = clu;
    }
    if (x.titulo || x.texto || x.imagem_id) cartoes.push(x);
  }
  if (cartoes.length) out.cartoes = cartoes;
  if (e.estilo === "CARTOES") out.estilo = "CARTOES";
  if (e.lead === false) out.lead = false;
  return { extra: out };
}

export async function rotasZap(request, env, k, orgId, papel, resto) {
  if (!resto.startsWith("zap/") && resto !== "zap") return null;
  const r = resto.replace(/^zap\/?/, "");
  const { json, lerCorpo, pode, auditar, sessao } = k;
  const metodo = request.method;
  const agora = k.agora(env);
  const ler = async (lim = 20000) => { const { corpo, erro } = await lerCorpo(request, lim); return erro ? { erro } : { corpo }; };
  const precisa = nivel => pode(papel, nivel) ? null : json({ erro: nivel === "ADMIN" ? "Somente administradores mudam a conexão do WhatsApp." : "Seu perfil não pode mudar o chatbot." }, 403);
  let m;
  const extra = await rotasZapExtra(request, env, k, orgId, papel, r, { json, ler, precisa, agora });
  if (extra) return extra;

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
  // Cadastro incorporado da Meta: a pessoa entra com o Facebook e escolhe o número. Com coexistência, o mesmo
  // número continua funcionando no aplicativo WhatsApp Business do celular.
  if (r === "embedded" && metodo === "GET") {
    const ok = Boolean(String(env.META_APP_ID || "").trim() && String(env.META_APP_SECRET || "").trim() && String(env.META_WA_CONFIG_ID || "").trim());
    return json({ disponivel: ok, app_id: ok ? String(env.META_APP_ID).trim() : null, config_id: ok ? String(env.META_WA_CONFIG_ID).trim() : null, versao: GRAPH.split("/").pop() });
  }
  if (r === "embedded" && metodo === "POST") {
    const negado = precisa("ADMIN"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const code = String(corpo.code || "").trim(), pnid = digitos(corpo.phone_number_id), waba = digitos(corpo.waba_id);
    if (!code || !/^\d{8,20}$/.test(pnid) || !/^\d{8,20}$/.test(waba)) return json({ erro: "A Meta não devolveu o número escolhido. Tente de novo e conclua todas as etapas da janela do Facebook." }, 400);
    const outra = await env.DB.prepare("SELECT org_id FROM plt_zap_contas WHERE phone_number_id=? AND org_id<>?").bind(pnid, orgId).first();
    if (outra) return json({ erro: "Esse número já está conectado em outra empresa da plataforma." }, 409);
    const chamar = async (m, caminho, params, corpoJ) => {
      const u = new URL(`${GRAPH}/${caminho}`); for (const [a, b] of Object.entries(params || {})) u.searchParams.set(a, b);
      const resp = await fetch(u.toString(), { method: m, headers: corpoJ ? { "content-type": "application/json", authorization: `Bearer ${params?.__token || ""}` } : {}, body: corpoJ ? JSON.stringify(corpoJ) : undefined, signal: AbortSignal.timeout(20000) });
      const d = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(cortar(d?.error?.error_user_msg || d?.error?.message || `HTTP ${resp.status}`, 300));
      return d;
    };
    let token;
    try { token = (await chamar("GET", "oauth/access_token", { client_id: String(env.META_APP_ID).trim(), client_secret: String(env.META_APP_SECRET).trim(), code })).access_token; }
    catch (e) { return json({ erro: "A Meta recusou a autorização: " + e.message }, 400); }
    const avisos = [];
    const post = async (caminho, corpoJ) => { const u = `${GRAPH}/${caminho}`; const resp = await fetch(u, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(corpoJ || {}), signal: AbortSignal.timeout(20000) }); const d = await resp.json().catch(() => ({})); if (!resp.ok) throw new Error(cortar(d?.error?.error_user_msg || d?.error?.message || `HTTP ${resp.status}`, 300)); return d; };
    try { await post(`${waba}/subscribed_apps`); } catch (e) { avisos.push("Assinatura do webhook: " + e.message); }
    if (corpo.coexistencia) {
      // Traz os contatos e o histórico das conversas do aplicativo (a Meta permite nas primeiras 24 h).
      for (const tipo of ["smb_app_state_sync", "history"]) { try { await post(`${pnid}/smb_app_data`, { messaging_product: "whatsapp", sync_type: tipo }); } catch (e) { avisos.push(`Sincronização (${tipo}): ${e.message}`); } }
    } else {
      try { await post(`${pnid}/register`, { messaging_product: "whatsapp", pin: String(100000 + Math.floor(Math.random() * 899999)) }); } catch (e) { avisos.push("Registro do número: " + e.message); }
    }
    let info = { numero: "", nome: "" };
    try { info = await conferirNumero(pnid, token); } catch (e) { avisos.push(e.message); }
    await env.DB.prepare(`INSERT INTO plt_zap_contas(org_id,phone_number_id,waba_id,numero,nome_verificado,token_cifrado,ativo,modo,config,atualizado_ms) VALUES(?,?,?,?,?,?,1,'BOTOES','{}',?)
      ON CONFLICT(org_id) DO UPDATE SET phone_number_id=excluded.phone_number_id, waba_id=excluded.waba_id, numero=excluded.numero, nome_verificado=excluded.nome_verificado, token_cifrado=excluded.token_cifrado, atualizado_ms=excluded.atualizado_ms`)
      .bind(orgId, pnid, waba, info.numero, info.nome, await k.cifrar(env, token), agora).run();
    await auditar(env, request, sessao, orgId, "WHATSAPP", `Conectou o WhatsApp pelo Facebook${corpo.coexistencia ? " (coexistência com o app)" : ""}: ${info.numero || pnid}`);
    return json({ ok: true, numero: info.numero, avisos });
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
    if (cfg.texto_livre !== "INICIO") cfg.texto_livre = "BUSCAR";
    for (const [ch, pad] of [["rotulo_menu", "🏠 Menu inicial"], ["rotulo_voltar", "⬅️ Voltar"], ["rotulo_fim", "✅ Finalizar"]]) cfg[ch] = cortar(cfg[ch], 20) || pad;
    cfg.rodape_pergunta = cortar(cfg.rodape_pergunta, 300) || ZAP_PADRAO.rodape_pergunta;
    if (corpo.imagem_inicio !== undefined) cfg.imagem_inicio = String(corpo.imagem_inicio ?? "");
    cfg.imagem_inicio = String(await midiaDaEmpresa(env, orgId, cfg.imagem_inicio) || "");
    cfg.lead_titulo = cortar(cfg.lead_titulo, 80) || ZAP_PADRAO.lead_titulo;
    cfg.lead_tags = cortar(cfg.lead_tags, 120);
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
    // Endereço das imagens (só para a prévia no painel).
    const kz = { env, k };
    const lista = await Promise.all((itens?.results || []).map(async i => {
      const ex = extraDe(i);
      const urls = {};
      for (const id of [ex.imagem_id, ...(Array.isArray(ex.cartoes) ? ex.cartoes.map(c => c.imagem_id) : [])].filter(Boolean)) urls[id] = await urlImagem({ ...kz, sim: true }, id);
      return { ...i, extra: ex, imagens: urls };
    }));
    const cfgItens = lerConfig(await contaDa(env, orgId));
    return json({ itens: lista, catalogo: (catalogo?.results || []).map(c => ({ ...c, itens: porCat.get(c.id) || [] })),
      inicio: { imagem_id: Number(cfgItens.imagem_inicio) || 0, imagem: Number(cfgItens.imagem_inicio) ? await urlImagem({ ...kz, sim: true }, cfgItens.imagem_inicio) : "" } });
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
    let extra = null;
    if (corpo.extra !== undefined) {
      const { extra: limpo, erro: errExtra } = await limparExtra(env, orgId, corpo.extra);
      if (errExtra) return json({ erro: errExtra }, 400);
      extra = JSON.stringify(limpo);
    }
    const campos = [pai, tipo, titulo, k.txt(corpo.descricao, 72), k.txt(corpo.texto, 3000), k.txt(corpo.palavras, 500), Number(corpo.ordem) || 0, corpo.ativo === false ? 0 : 1, corpo.exibicao === "NUMERADO" ? "NUMERADO" : "AUTO"];
    let id = Number(corpo.id) || 0;
    if (id) { const x = await env.DB.prepare("UPDATE plt_zap_itens SET pai_id=?, tipo=?, titulo=?, descricao=?, texto=?, palavras=?, ordem=?, ativo=?, exibicao=?, extra=COALESCE(?, extra) WHERE id=? AND org_id=?").bind(...campos, extra, id, orgId).run(); if (!x.meta.changes) return json({ erro: "Opção não encontrada." }, 404); }
    else id = (await env.DB.prepare("INSERT INTO plt_zap_itens(pai_id,tipo,titulo,descricao,texto,palavras,ordem,ativo,exibicao,extra,org_id) VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING id").bind(...campos, extra, orgId).first())?.id;
    return json({ ok: true, id });
  }
  // Roteiro em texto: copiar o fluxo atual ou colar um fluxo inteiro (substitui os botões).
  if (r === "roteiro" && metodo === "GET") {
    const c = await contaDa(env, orgId);
    const [itens, catalogo, lig] = await env.DB.batch([
      env.DB.prepare("SELECT * FROM plt_zap_itens WHERE org_id=? ORDER BY pai_id, ordem, id").bind(orgId),
      env.DB.prepare("SELECT * FROM plt_zap_catalogo WHERE org_id=? AND ativo=1 ORDER BY destaque DESC, nome").bind(orgId),
      env.DB.prepare("SELECT ci.catalogo_id, ci.item_id, ci.ordem FROM plt_zap_cat_itens ci JOIN plt_zap_catalogo c ON c.id=ci.catalogo_id WHERE c.org_id=?").bind(orgId)
    ]);
    const ordemLig = new Map((lig?.results || []).map(x => [x.item_id + ":" + x.catalogo_id, x.ordem ?? 999999]));
    const ligacoes = new Map();
    for (const x of lig?.results || []) { if (!ligacoes.has(x.catalogo_id)) ligacoes.set(x.catalogo_id, []); ligacoes.get(x.catalogo_id).push(x.item_id); }
    return json({ roteiro: escreverRoteiro(itens?.results || [], catalogo?.results || [], ligacoes, lerConfig(c), ordemLig) });
  }
  if (r === "roteiro" && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(400000); if (erro) return erro;
    const lido = lerRoteiro(corpo.roteiro);
    if (lido.erros.length) return json({ erro: "O roteiro tem pontos para corrigir.", erros: lido.erros.slice(0, 30) }, 400);
    const conta = lido.erros.length ? null : await contaDa(env, orgId);
    const ja = await env.DB.prepare("SELECT COUNT(*) n FROM plt_zap_itens WHERE org_id=?").bind(orgId).first();
    if (Number(ja?.n) && !corpo.substituir) return json({ erro: "Já existe um fluxo. Marque \"Substituir o fluxo atual\" para trocar.", codigo: "TEM_FLUXO" }, 409);
    if (corpo.previa) {
      const conta2 = n => n.reduce((t, x) => t + 1 + conta2(x.filhos), 0);
      const lojas = n => n.reduce((t, x) => t + x.lojas.length + lojas(x.filhos), 0);
      return json({ ok: true, botoes: conta2(lido.botoes), lojas: lojas(lido.botoes), cfg: lido.cfg });
    }
    // Troca os botões (as lojas ficam no cadastro e são reaproveitadas pelo link ou pelo nome).
    await env.DB.batch([
      env.DB.prepare("DELETE FROM plt_zap_cat_itens WHERE item_id IN (SELECT id FROM plt_zap_itens WHERE org_id=?)").bind(orgId),
      env.DB.prepare("DELETE FROM plt_zap_itens WHERE org_id=?").bind(orgId)
    ]);
    const existentes = await linhasDe(env, "SELECT id, nome, local, link, whatsapp FROM plt_zap_catalogo WHERE org_id=?", orgId);
    const chaveLoja = l => norm([l.local, l.nome].filter(Boolean).join(" ")).replace(/[^a-z0-9]+/g, " ").trim();
    const porLink = new Map(existentes.filter(c => c.link).map(c => [c.link, c.id]));
    const porNome = new Map(existentes.map(c => [chaveLoja(c), c.id]));
    let nBotoes = 0, nLojas = 0;
    const ligar = [];
    const criar = async (lista, pai) => {
      let ordem = 0;
      for (const no of lista) {
        const id = (await env.DB.prepare("INSERT INTO plt_zap_itens(org_id,pai_id,tipo,titulo,texto,palavras,ordem,ativo,exibicao,extra) VALUES(?,?,?,?,?,?,?,1,'AUTO',?) RETURNING id")
          .bind(orgId, pai, no.tipo, no.titulo, cortar(no.texto, 3000), "", ++ordem, JSON.stringify(no.semAviso ? { lead: false } : {})).first()).id;
        nBotoes++;
        let posLoja = 0;
        for (const l of no.lojas) {
          // Mesmo link = mesma loja. Com link diferente (outra mensagem pronta), fica um contato separado.
          let cid = l.link ? porLink.get(l.link) : porNome.get(chaveLoja(l));
          if (!cid) {
            cid = (await env.DB.prepare("INSERT INTO plt_zap_catalogo(org_id,nome,local,link,whatsapp,destaque,ativo) VALUES(?,?,?,?,?,0,1) RETURNING id").bind(orgId, cortar(l.nome, 100), cortar(l.local, 80), l.link || null, l.whatsapp || null).first()).id;
            if (l.link) porLink.set(l.link, cid);
            if (!porNome.has(chaveLoja(l))) porNome.set(chaveLoja(l), cid);
            nLojas++;
          } else await env.DB.prepare("UPDATE plt_zap_catalogo SET ativo=1 WHERE id=? AND org_id=?").bind(cid, orgId).run();
          ligar.push(env.DB.prepare("INSERT OR IGNORE INTO plt_zap_cat_itens(catalogo_id,item_id,ordem) VALUES(?,?,?)").bind(cid, id, ++posLoja));
          if (ligar.length >= 80) await env.DB.batch(ligar.splice(0));
        }
        await criar(no.filhos, id);
      }
    };
    await criar(lido.botoes, 0);
    if (ligar.length) await env.DB.batch(ligar);
    if (Object.keys(lido.cfg).length) {
      const cfg = lerConfig(conta);
      for (const [ch, v] of Object.entries(lido.cfg)) cfg[ch] = typeof v === "string" ? cortar(v, 1500) : v;
      // Com boas-vindas própria, qualquer mensagem do cliente mostra o começo (como no Botpress).
      if (lido.cfg.saudacao && lido.cfg.texto_livre === undefined) cfg.texto_livre = "INICIO";
      await env.DB.prepare("INSERT INTO plt_zap_contas(org_id,config,modo,ativo,atualizado_ms) VALUES(?,?,'BOTOES',1,?) ON CONFLICT(org_id) DO UPDATE SET config=excluded.config, atualizado_ms=excluded.atualizado_ms").bind(orgId, JSON.stringify(cfg), agora).run();
    }
    await auditar(env, request, sessao, orgId, "CHATBOT", `Roteiro aplicado: ${nBotoes} botão(ões), ${nLojas} loja(s) nova(s)`);
    return json({ ok: true, botoes: nBotoes, lojas_novas: nLojas });
  }
  // Arquivo do Botpress (sem o código das ações): devolve o roteiro para conferir e aplicar.
  if (r === "botpress" && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(3000000); if (erro) return erro;
    try { return json({ ok: true, roteiro: roteiroDoBotpress(corpo.bot) }); }
    catch (e) { return json({ erro: e.message || "Não consegui ler o arquivo do Botpress." }, 400); }
  }
  // Reordenar os botões de um bloco (a ordem em que o cliente vê).
  if (r === "itens/ordem" && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const ids = (Array.isArray(corpo.ids) ? corpo.ids : []).map(Number).filter(Boolean).slice(0, 200);
    if (ids.length) await env.DB.batch(ids.map((id, n) => env.DB.prepare("UPDATE plt_zap_itens SET ordem=? WHERE id=? AND org_id=?").bind(n + 1, id, orgId)));
    return json({ ok: true });
  }
  // Imagem do fluxo (foto do produto, banner, mapa…): já chega reduzida pelo navegador.
  if (r === "midia" && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(1600000); if (erro) return erro;
    const m2 = String(corpo.dados || "").match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m2) return json({ erro: "Envie uma foto (JPG, PNG ou WEBP)." }, 400);
    if (m2[2].length > 1500000) return json({ erro: "A foto é grande demais. Use uma de até 1 MB." }, 413);
    const n = await env.DB.prepare("INSERT INTO plt_mk_midias(org_id,mime,dados,prompt,criado_ms) VALUES(?,?,?,?,?) RETURNING id").bind(orgId, m2[1], m2[2], "chatbot", agora).first();
    return json({ ok: true, id: n.id, url: await urlImagem({ env, k, sim: true }, n.id) });
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
    const link = String(corpo.link || "").trim();
    if (link && !URL_OK(link)) return json({ erro: "O link da loja precisa começar com https:// (ex.: https://tinyurl.com/minha-loja)." }, 400);
    const campos = [nome, k.txt(corpo.telefone, 30), k.txt(corpo.whatsapp, 30), k.txt(corpo.local, 80), k.txt(corpo.descricao, 300), corpo.destaque ? 1 : 0, corpo.ativo === false ? 0 : 1, link.slice(0, 600) || null];
    let id = Number(corpo.id) || 0;
    if (id) { const x = await env.DB.prepare("UPDATE plt_zap_catalogo SET nome=?, telefone=?, whatsapp=?, local=?, descricao=?, destaque=?, ativo=?, link=? WHERE id=? AND org_id=?").bind(...campos, id, orgId).run(); if (!x.meta.changes) return json({ erro: "Não encontrado." }, 404); }
    else id = (await env.DB.prepare("INSERT INTO plt_zap_catalogo(nome,telefone,whatsapp,local,descricao,destaque,ativo,link,org_id) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id").bind(...campos, orgId).first())?.id;
    const validos = new Set((await linhasDe(env, "SELECT id FROM plt_zap_itens WHERE org_id=? AND tipo='LISTA'", orgId)).map(x => x.id));
    const itens = [...new Set((Array.isArray(corpo.itens) ? corpo.itens : []).map(Number))].filter(x => validos.has(x)).slice(0, 80);
    // Mantém a posição da loja em cada opção (a ordem em que o cliente vê); novas ligações vão para o fim.
    const antes = new Map((await linhasDe(env, "SELECT item_id, ordem FROM plt_zap_cat_itens WHERE catalogo_id=?", id)).map(x => [x.item_id, x.ordem]));
    await env.DB.batch([env.DB.prepare("DELETE FROM plt_zap_cat_itens WHERE catalogo_id=?").bind(id), ...itens.map(i => env.DB.prepare("INSERT OR IGNORE INTO plt_zap_cat_itens(catalogo_id,item_id,ordem) VALUES(?,?,?)").bind(id, i, antes.get(i) ?? null))]);
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
      const linkL = String(l.link || "").trim();
      const dados = [k.txt(l.telefone, 30), k.txt(l.whatsapp, 30), k.txt(l.local, 80), k.txt(l.descricao, 300), URL_OK(linkL) ? linkL.slice(0, 600) : ""];
      if (id) st.push(env.DB.prepare("UPDATE plt_zap_catalogo SET telefone=COALESCE(NULLIF(?,''),telefone), whatsapp=COALESCE(NULLIF(?,''),whatsapp), local=COALESCE(NULLIF(?,''),local), descricao=COALESCE(NULLIF(?,''),descricao), link=COALESCE(NULLIF(?,''),link) WHERE id=?").bind(...dados, id));
      else { id = (await env.DB.prepare("INSERT INTO plt_zap_catalogo(org_id,nome,telefone,whatsapp,local,descricao,link,destaque,ativo) VALUES(?,?,?,?,?,?,NULLIF(?,''),0,1) RETURNING id").bind(orgId, nome, ...dados).first()).id; catalogo.set(sem(nome), id); }
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
  // Assistente: a pessoa descreve o negócio e a IA monta menu, mensagens e treinamento (pergunta só o essencial).
  if (r === "assistente" && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(30000); if (erro) return erro;
    if (corpo.acao === "aplicar") return aplicarPlanoChatbot(env, k, orgId, corpo, json, request);
    const descricao = k.txt(corpo.descricao, 6000);
    if (descricao.length < 20) return json({ erro: "Conte um pouco mais sobre o negócio (o que vende ou faz, para quem, horário, como atende)." }, 400);
    const envIA = await k.comIA(env, orgId);
    if (!envIA.OPENAI_API_KEY) return json({ erro: "A IA da plataforma ainda não está ligada. Fale com a equipe DENIA." }, 503);
    const respostas = (Array.isArray(corpo.respostas) ? corpo.respostas : []).slice(0, 8).map(x => `P: ${k.txt(x.pergunta, 300)}\nR: ${k.txt(x.resposta, 1000)}`).join("\n");
    const org = await env.DB.prepare("SELECT nome, segmento FROM plt_organizacoes WHERE id=?").bind(orgId).first();
    try {
      const o = await openaiResposta(envIA, { modelo: "gpt-5-mini", esforco: "low", maxTokens: 6000, recurso: "chatbot/assistente", instrucoes: INSTRUCOES_ASSISTENTE,
        entrada: `EMPRESA: ${org?.nome || ""}${org?.segmento ? " (" + org.segmento + ")" : ""}\n\nCOMO A PESSOA DESCREVEU O NEGÓCIO E O QUE QUER:\n${descricao}${respostas ? `\n\nRESPOSTAS ÀS SUAS PERGUNTAS:\n${respostas}` : ""}\n\n${respostas || corpo.sem_perguntas ? "Agora monte o plano completo (sem perguntas)." : "Se faltar algo ESSENCIAL, faça até 4 perguntas; senão, monte o plano."}` });
      if (Array.isArray(o?.perguntas) && o.perguntas.length && !respostas && !corpo.sem_perguntas) return json({ perguntas: o.perguntas.slice(0, 4).map(x => k.txt(x, 300)).filter(Boolean) });
      return json({ plano: limparPlano(o?.plano || o, k) });
    } catch (e) { return json({ erro: "A IA não conseguiu montar agora: " + e.message }, 502); }
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

const INSTRUCOES_ASSISTENTE = `Você é especialista em atendimento pelo WhatsApp e monta chatbots para pequenas e grandes empresas brasileiras.
A partir da descrição, monte o atendimento automático ideal: menu enxuto e fácil (no máximo 3 opções no menu inicial quando possível, para virar botões), submenus para organizar, respostas prontas curtas e úteis, listas de contatos quando a empresa indica lojas/profissionais, e sempre uma opção para falar com a equipe.
Escreva como uma pessoa simpática, em português do Brasil, frases curtas, emoji com moderação no começo dos títulos.
Títulos das opções: no máximo 24 caracteres. Use as palavras-chave que os clientes realmente escreveriam (com e sem acento, sinônimos, erros comuns).
Nunca invente preço, endereço, telefone ou horário que não esteja na descrição: quando faltar, deixe um marcador como "[preencha o horário]".
Tipos: MENU (abre outras opções; tem "filhos"), RESPOSTA (texto pronto), LISTA (lista de contatos/lojas cadastrados depois), HUMANO (falar com a equipe).
Se faltar informação ESSENCIAL e ainda não houver respostas, devolva {"perguntas":["..."]} (no máximo 4, objetivas).
Senão devolva {"plano":{"modo":"BOTOES|MISTO|IA","boas_vindas":"","nao_entendi":"","humano":"","encerramento":"","rotulo_catalogo":"","sobre":"","ia_tom":"","ia_servicos":"","ia_precos":"","ia_regras":"","menu":[{"tipo":"MENU","titulo":"","texto":"","palavras":"","filhos":[{"tipo":"RESPOSTA","titulo":"","texto":"","palavras":""}]}]}}.
Escolha o modo: BOTOES quando é só direcionar (ex.: guia de lojas), MISTO quando há dúvidas variadas, IA quando o atendimento é consultivo (vendas, orçamentos, agendamentos).`;
function limparPlano(p, k) {
  const tipo = t => TIPOS.includes(t) ? t : "RESPOSTA";
  let total = 0;
  const no = (x, prof) => {
    if (!x || total >= 150) return null;
    total++;
    const t = prof >= 3 && x.tipo === "MENU" ? "RESPOSTA" : tipo(x.tipo);
    return { tipo: t, titulo: cortar(k.txt(x.titulo, 60), 24) || "Opção", texto: k.txt(x.texto, 3000), palavras: k.txt(x.palavras, 500), filhos: t === "MENU" ? (Array.isArray(x.filhos) ? x.filhos : []).slice(0, 40).map(f => no(f, prof + 1)).filter(Boolean) : [] };
  };
  const menu = (Array.isArray(p?.menu) ? p.menu : []).slice(0, 12).map(x => no(x, 1)).filter(Boolean);
  const campos = {};
  for (const c of ["boas_vindas", "nao_entendi", "humano", "encerramento", "rotulo_catalogo", "sobre", "ia_tom", "ia_servicos", "ia_precos", "ia_regras"]) if (typeof p?.[c] === "string") campos[c] = k.txt(p[c], c === "sobre" || c.startsWith("ia_") ? 6000 : 1000);
  return { modo: ["BOTOES", "MISTO", "IA"].includes(p?.modo) ? p.modo : "MISTO", ...campos, menu };
}
async function aplicarPlanoChatbot(env, k, orgId, corpo, json, request) {
  const plano = limparPlano(corpo.plano, k);
  if (!plano.menu.length) return json({ erro: "O plano não tem menu." }, 400);
  const existentes = Number((await env.DB.prepare("SELECT COUNT(*) n FROM plt_zap_itens WHERE org_id=?").bind(orgId).first())?.n || 0);
  if (existentes && !corpo.substituir) return json({ erro: "O menu já tem opções. Marque \"substituir o menu atual\" para trocar.", codigo: "MENU_EXISTE" }, 409);
  if (existentes) await env.DB.batch([env.DB.prepare("DELETE FROM plt_zap_cat_itens WHERE item_id IN (SELECT id FROM plt_zap_itens WHERE org_id=?)").bind(orgId), env.DB.prepare("DELETE FROM plt_zap_itens WHERE org_id=?").bind(orgId)]);
  let n = 0;
  const criar = async (lista, pai) => {
    for (const [i, x] of lista.entries()) {
      const id = (await env.DB.prepare("INSERT INTO plt_zap_itens(org_id,pai_id,tipo,titulo,texto,palavras,ordem,ativo,exibicao) VALUES(?,?,?,?,?,?,?,1,'AUTO') RETURNING id").bind(orgId, pai, x.tipo, x.titulo, x.texto, x.palavras, i + 1).first()).id;
      n++;
      if (x.filhos.length) await criar(x.filhos, id);
    }
  };
  await criar(plano.menu, 0);
  const c = await contaDa(env, orgId), cfg = lerConfig(c);
  for (const [ch, v] of Object.entries(plano)) if (ch !== "menu" && ch !== "modo" && typeof v === "string" && v) cfg[ch] = v;
  const acesso = k.acesso;
  const modo = acesso ? modoPermitido(plano.modo, acesso.recursos) : plano.modo;
  await env.DB.prepare("INSERT INTO plt_zap_contas(org_id,config,modo,atualizado_ms) VALUES(?,?,?,?) ON CONFLICT(org_id) DO UPDATE SET config=excluded.config, modo=excluded.modo, atualizado_ms=excluded.atualizado_ms").bind(orgId, JSON.stringify(cfg), modo, k.agora(env)).run();
  await k.auditar(env, request, k.sessao, orgId, "CHATBOT", `Chatbot montado pela IA (${n} opções, modo ${modo})`);
  return json({ ok: true, opcoes: n, modo });
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

// ---------------------------------------------------------------------------
// WhatsApp completo: perfil comercial, saúde do número, modelos (templates), campanhas, clientes,
// etiquetas e respostas rápidas. Tudo pela API oficial (Cloud API), com o token da própria empresa.
// ---------------------------------------------------------------------------
async function graphZap(token, metodo, caminho, corpo) {
  const r = await fetch(`${GRAPH}/${caminho}`, {
    method: metodo, signal: AbortSignal.timeout(20000),
    headers: { authorization: `Bearer ${token}`, ...(corpo ? { "content-type": "application/json" } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const er = d?.error || {};
    let msg = er.error_user_msg || er.error_data?.details || er.message || `HTTP ${r.status}`;
    if (er.code === 190) msg = "A Meta recusou o token do WhatsApp (vencido ou sem permissão). Conecte de novo em Conexão.";
    else if (er.code === 200 || er.code === 10) msg = "O token não tem permissão para isso. Ele precisa de whatsapp_business_management e whatsapp_business_messaging.";
    const e = new Error("Meta: " + cortar(msg, 300)); e.status = r.status; e.codigo = er.code; throw e;
  }
  return d;
}
const QUALIDADE = { GREEN: "Alta", YELLOW: "Média", RED: "Baixa", UNKNOWN: "Ainda sem nota" };
const LIMITE_TIER = { TIER_50: 50, TIER_250: 250, TIER_1K: 1000, TIER_10K: 10000, TIER_100K: 100000, TIER_UNLIMITED: "ilimitado" };
const varsDoTexto = t => [...new Set((String(t || "").match(/\{\{\s*(\d+)\s*\}\}/g) || []).map(x => Number(x.replace(/\D/g, ""))))].sort((a, b) => a - b);
const etiquetasDe = s => String(s || "").split(",").map(x => x.trim()).filter(Boolean);

async function rotasZapExtra(request, env, k, orgId, papel, r, { json, ler, precisa, agora }) {
  const metodo = request.method;
  const url = new URL(request.url);
  let m;
  const comConta = async () => {
    const conta = await contaDa(env, orgId);
    if (!conta?.token_cifrado || !conta.phone_number_id) throw Object.assign(new Error("Conecte o WhatsApp desta empresa primeiro (menu WhatsApp → Conexão)."), { status: 409, codigo: "SEM_CONEXAO" });
    return { conta, token: await k.decifrar(env, conta.token_cifrado) };
  };
  const falhou = e => json({ erro: e.message, codigo: e.codigo }, e.status && e.status < 500 ? (e.status === 401 ? 400 : e.status) : 502);

  // Perfil comercial (o que o cliente vê ao tocar no nome da empresa no WhatsApp).
  if (r === "perfil" && metodo === "GET") {
    try {
      const { conta, token } = await comConta();
      const d = await graphZap(token, "GET", `${encodeURIComponent(conta.phone_number_id)}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical`);
      return json({ perfil: d.data?.[0] || {}, numero: conta.numero, nome: conta.nome_verificado });
    } catch (e) { return falhou(e); }
  }
  if (r === "perfil" && metodo === "POST") {
    const negado = precisa("ADMIN"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const VERT = ["UNDEFINED", "OTHER", "AUTO", "BEAUTY", "APPAREL", "EDU", "ENTERTAIN", "EVENT_PLAN", "FINANCE", "GROCERY", "GOVT", "HOTEL", "HEALTH", "NONPROFIT", "PROF_SERVICES", "RETAIL", "TRAVEL", "RESTAURANT", "ALCOHOL", "ONLINE_GAMBLING", "PHYSICAL_GAMBLING", "OTC_DRUGS"];
    const sites = (Array.isArray(corpo.websites) ? corpo.websites : []).map(x => String(x).trim()).filter(x => /^https?:\/\/\S+$/.test(x)).slice(0, 2);
    const p = { messaging_product: "whatsapp", about: cortar(corpo.about, 139), address: cortar(corpo.address, 256), description: cortar(corpo.description, 512), email: cortar(corpo.email, 128), websites: sites };
    if (VERT.includes(corpo.vertical)) p.vertical = corpo.vertical;
    try { const { conta, token } = await comConta(); await graphZap(token, "POST", `${encodeURIComponent(conta.phone_number_id)}/whatsapp_business_profile`, p); await k.auditar(env, request, k.sessao, orgId, "WHATSAPP", "Atualizou o perfil comercial do WhatsApp"); return json({ ok: true }); }
    catch (e) { return falhou(e); }
  }

  // Saúde do número: qualidade, limite de conversas por dia, verificação, e as falhas recentes por motivo.
  if (r === "saude" && metodo === "GET") {
    try {
      const { conta, token } = await comConta();
      const [num, waba, falhas, envio] = await Promise.all([
        graphZap(token, "GET", `${encodeURIComponent(conta.phone_number_id)}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier,throughput,name_status,code_verification_status,platform_type,is_official_business_account,status`),
        conta.waba_id ? graphZap(token, "GET", `${encodeURIComponent(conta.waba_id)}?fields=name,account_review_status,business_verification_status,currency,timezone_id,message_template_namespace`).catch(e => ({ erro: e.message })) : null,
        linhasDe(env, "SELECT substr(erro,1,instr(erro||':',':')-1) codigo, MAX(erro) exemplo, COUNT(*) n FROM plt_zap_msgs WHERE org_id=? AND direcao='S' AND status IN ('FAILED','FALHOU') AND criado_ms>? GROUP BY codigo ORDER BY n DESC LIMIT 10", orgId, agora - 7 * 86400000),
        env.DB.prepare("SELECT COUNT(*) total, SUM(CASE WHEN status IN ('DELIVERED','READ') THEN 1 ELSE 0 END) entregues, SUM(CASE WHEN status='READ' THEN 1 ELSE 0 END) lidas, SUM(CASE WHEN status IN ('FAILED','FALHOU') THEN 1 ELSE 0 END) falhas FROM plt_zap_msgs WHERE org_id=? AND direcao='S' AND criado_ms>?").bind(orgId, agora - 7 * 86400000).first()
      ]);
      const DICA = { 131049: "A Meta segurou a mensagem para não cansar o cliente (muitas campanhas para a mesma pessoa). Espalhe os envios.", 131026: "Número sem WhatsApp ou com app antigo.", 131047: "Passaram 24h desde a última mensagem do cliente: só modelos aprovados podem ser enviados.", 131056: "Muitas mensagens seguidas para o mesmo número.", 131048: "Envio limitado por denúncias ou bloqueios. Revise as campanhas.", 470: "Fora da janela de 24h: use um modelo aprovado.", 131051: "Tipo de mensagem não suportado.", 130429: "Limite de velocidade da Meta. A DENIA tenta mais devagar." };
      return json({ numero: num.display_phone_number, nome: num.verified_name, qualidade: num.quality_rating || "UNKNOWN", qualidade_nome: QUALIDADE[num.quality_rating] || num.quality_rating, limite: LIMITE_TIER[num.messaging_limit_tier] ?? num.messaging_limit_tier ?? null,
        nome_status: num.name_status || null, verificacao: num.code_verification_status || null, plataforma: num.platform_type || null, oficial: Boolean(num.is_official_business_account), status: num.status || null, vazao: num.throughput?.level || null,
        waba, envio_7d: envio || {}, falhas: falhas.map(f => ({ ...f, dica: DICA[Number(f.codigo)] || null })) });
    } catch (e) { return falhou(e); }
  }

  // Modelos de mensagem (templates): os únicos que podem abrir conversa fora da janela de 24h.
  if (r === "modelos" && metodo === "GET") {
    try {
      const { conta, token } = await comConta();
      if (!conta.waba_id) return json({ erro: "Falta o ID da conta do WhatsApp Business (WABA) na conexão. Em Conexão, cole o WABA ID ou conecte pelo Facebook.", codigo: "SEM_WABA" }, 409);
      const d = await graphZap(token, "GET", `${encodeURIComponent(conta.waba_id)}/message_templates?fields=name,status,category,language,components,quality_score,rejected_reason&limit=200`);
      return json({ modelos: (d.data || []).map(t => ({ nome: t.name, status: t.status, categoria: t.category, idioma: t.language, qualidade: t.quality_score?.score || null, motivo: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null, componentes: t.components || [],
        variaveis: varsDoTexto((t.components || []).find(c => c.type === "BODY")?.text).length, cabecalho_midia: ["IMAGE", "VIDEO", "DOCUMENT"].includes((t.components || []).find(c => c.type === "HEADER")?.format) })) });
    } catch (e) { return falhou(e); }
  }
  if (r === "modelos" && metodo === "POST") {
    const negado = precisa("ADMIN"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const nome = String(corpo.nome || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 512);
    const categoria = ["MARKETING", "UTILITY", "AUTHENTICATION"].includes(corpo.categoria) ? corpo.categoria : "MARKETING";
    const idioma = /^[a-z]{2}(_[A-Z]{2})?$/.test(String(corpo.idioma || "")) ? corpo.idioma : "pt_BR";
    const texto = String(corpo.corpo || "").trim().slice(0, 1024);
    if (!nome || !texto) return json({ erro: "Dê um nome e escreva o texto da mensagem." }, 400);
    const vars = varsDoTexto(texto);
    if (vars.some((v, i) => v !== i + 1)) return json({ erro: "As variáveis precisam ser {{1}}, {{2}}, {{3}}… em ordem." }, 400);
    const exemplos = (Array.isArray(corpo.exemplos) ? corpo.exemplos : []).map(x => cortar(x, 60));
    if (vars.length && exemplos.filter(Boolean).length < vars.length) return json({ erro: "Dê um exemplo para cada variável (a Meta exige para aprovar)." }, 400);
    const comps = [];
    if (String(corpo.cabecalho || "").trim()) comps.push({ type: "HEADER", format: "TEXT", text: cortar(corpo.cabecalho, 60) });
    comps.push({ type: "BODY", text: texto, ...(vars.length ? { example: { body_text: [exemplos.slice(0, vars.length)] } } : {}) });
    if (String(corpo.rodape || "").trim()) comps.push({ type: "FOOTER", text: cortar(corpo.rodape, 60) });
    const bts = (Array.isArray(corpo.botoes) ? corpo.botoes : []).slice(0, 10).map(b => b.tipo === "URL" && /^https?:\/\/\S+$/.test(b.url || "") ? { type: "URL", text: cortar(b.texto, 25), url: b.url }
      : b.tipo === "PHONE_NUMBER" && digitos(b.telefone).length >= 10 ? { type: "PHONE_NUMBER", text: cortar(b.texto, 25), phone_number: "+" + digitos(b.telefone) }
        : String(b.texto || "").trim() ? { type: "QUICK_REPLY", text: cortar(b.texto, 25) } : null).filter(Boolean);
    if (categoria === "MARKETING" && !bts.some(b => b.type === "QUICK_REPLY") && corpo.botao_sair !== false) bts.push({ type: "QUICK_REPLY", text: "Parar promoções" });
    if (bts.length) comps.push({ type: "BUTTONS", buttons: bts });
    try {
      const { conta, token } = await comConta();
      if (!conta.waba_id) return json({ erro: "Falta o WABA ID na conexão.", codigo: "SEM_WABA" }, 409);
      const d = await graphZap(token, "POST", `${encodeURIComponent(conta.waba_id)}/message_templates`, { name: nome, category: categoria, language: idioma, components: comps });
      await k.auditar(env, request, k.sessao, orgId, "WHATSAPP", `Enviou o modelo ${nome} para aprovação da Meta`);
      return json({ ok: true, nome, status: d.status || "PENDING" });
    } catch (e) { return falhou(e); }
  }
  if (r === "modelos/excluir" && metodo === "POST") {
    const negado = precisa("ADMIN"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const nome = String(corpo.nome || "");
    if (!/^[a-z0-9_]{1,512}$/.test(nome)) return json({ erro: "Modelo inválido." }, 400);
    try { const { conta, token } = await comConta(); await graphZap(token, "DELETE", `${encodeURIComponent(conta.waba_id)}/message_templates?name=${encodeURIComponent(nome)}`); return json({ ok: true }); }
    catch (e) { return falhou(e); }
  }

  // Clientes do WhatsApp (todo mundo que já falou com a empresa), com etiquetas e descadastro.
  if (r === "clientes" && metodo === "GET") {
    const q = String(url.searchParams.get("q") || "").trim().slice(0, 60), et = String(url.searchParams.get("etiqueta") || "").trim().slice(0, 40);
    const conds = ["org_id=?"], args = [orgId];
    if (q) { conds.push("(nome LIKE ? OR telefone LIKE ?)"); args.push(`%${q}%`, `%${digitos(q) || q}%`); }
    if (et) { conds.push("(',' || REPLACE(COALESCE(etiquetas,''),', ',',') || ',') LIKE ?"); args.push(`%,${et},%`); }
    const [lista, tot, ets] = await Promise.all([
      linhasDe(env, `SELECT telefone, nome, etiquetas, optout, ultimo_ms, ultima_entrada_ms FROM plt_zap_contatos WHERE ${conds.join(" AND ")} ORDER BY ultimo_ms DESC LIMIT 500`, ...args),
      env.DB.prepare(`SELECT COUNT(*) n, SUM(optout) sairam FROM plt_zap_contatos WHERE ${conds.join(" AND ")}`).bind(...args).first(),
      linhasDe(env, "SELECT etiquetas FROM plt_zap_contatos WHERE org_id=? AND etiquetas IS NOT NULL AND etiquetas<>'' LIMIT 5000", orgId)
    ]);
    const contagem = {};
    for (const x of ets) for (const e of etiquetasDe(x.etiquetas)) contagem[e] = (contagem[e] || 0) + 1;
    return json({ clientes: lista.map(c => ({ ...c, etiquetas: etiquetasDe(c.etiquetas), optout: Boolean(c.optout), janela_aberta: agora - Number(c.ultima_entrada_ms || 0) < JANELA_24H })), total: Number(tot?.n || 0), descadastrados: Number(tot?.sairam || 0), etiquetas: Object.entries(contagem).sort((a, b) => b[1] - a[1]).map(([nome, n]) => ({ nome, n })) });
  }
  if ((m = r.match(/^clientes\/(\d{8,15})$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const ets = (Array.isArray(corpo.etiquetas) ? corpo.etiquetas : etiquetasDe(corpo.etiquetas)).map(x => cortar(String(x).replace(/,/g, " "), 30)).filter(Boolean).slice(0, 12);
    await env.DB.prepare("UPDATE plt_zap_contatos SET etiquetas=?, nome=COALESCE(NULLIF(?,''),nome), optout=COALESCE(?,optout) WHERE org_id=? AND telefone=?").bind(ets.join(", ") || null, k.txt(corpo.nome, 80) || "", corpo.optout === undefined ? null : corpo.optout ? 1 : 0, orgId, m[1]).run();
    return json({ ok: true });
  }
  if (r === "clientes/importar" && metodo === "POST") {
    const negado = precisa("ADMIN"); if (negado) return negado;
    const { corpo, erro } = await ler(400000); if (erro) return erro;
    if (corpo.consentimento !== true) return json({ erro: "Confirme que essas pessoas autorizaram receber mensagens da empresa no WhatsApp (exigência da Meta e da LGPD)." }, 400);
    const linhas = (Array.isArray(corpo.linhas) ? corpo.linhas : []).slice(0, 5000).map(l => {
      let t = digitos(l.telefone); if (t.length === 10 || t.length === 11) t = "55" + t;
      return t.length >= 12 && t.length <= 15 ? [t, cortar(l.nome, 80), etiquetasDe(l.etiquetas).map(x => cortar(x, 30)).slice(0, 12).join(", ")] : null;
    }).filter(Boolean);
    for (let i = 0; i < linhas.length; i += 80) await env.DB.batch(linhas.slice(i, i + 80).map(([t, n, e]) => env.DB.prepare("INSERT INTO plt_zap_contatos(org_id,telefone,nome,etiquetas,ultimo_ms) VALUES(?,?,?,?,?) ON CONFLICT(org_id,telefone) DO UPDATE SET nome=COALESCE(NULLIF(excluded.nome,''),nome), etiquetas=COALESCE(NULLIF(excluded.etiquetas,''),etiquetas)").bind(orgId, t, n || null, e || null, 0)));
    await k.auditar(env, request, k.sessao, orgId, "WHATSAPP", `Importou ${linhas.length} cliente(s) do WhatsApp`);
    return json({ ok: true, importados: linhas.length });
  }

  // Um modelo para um cliente só (reabre a conversa quando a janela de 24h já fechou).
  if ((m = r.match(/^clientes\/(\d{8,15})\/modelo$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    if (!/^[a-z0-9_]{1,512}$/.test(String(corpo.modelo || "")) || !/^[a-z]{2}(_[A-Z]{2})?$/.test(String(corpo.idioma || ""))) return json({ erro: "Escolha um modelo aprovado." }, 400);
    const c = await env.DB.prepare("SELECT nome FROM plt_zap_contatos WHERE org_id=? AND telefone=?").bind(orgId, m[1]).first();
    if (!c) return json({ erro: "Cliente não encontrado." }, 404);
    try {
      const { conta, token } = await comConta();
      const params = (Array.isArray(corpo.variaveis) ? corpo.variaveis : []).slice(0, 10).map(v => ({ type: "text", text: v === "{nome}" ? (String(c.nome || "").split(" ")[0] || "cliente") : cortar(v || "-", 200) }));
      const d = await graphZap(token, "POST", `${encodeURIComponent(conta.phone_number_id)}/messages`, { messaging_product: "whatsapp", to: m[1], type: "template", template: { name: corpo.modelo, language: { code: corpo.idioma }, ...(params.length ? { components: [{ type: "body", parameters: params }] } : {}) } });
      await env.DB.batch([
        env.DB.prepare("INSERT OR IGNORE INTO plt_zap_msgs(org_id,telefone,direcao,origem,texto,wamid,status,criado_ms) VALUES(?,?,'S','EQUIPE',?,?,'ENVIADA',?)").bind(orgId, m[1], `[Modelo ${corpo.modelo}]`, d?.messages?.[0]?.id || null, agora),
        env.DB.prepare("UPDATE plt_zap_contatos SET pausado_ate=MAX(pausado_ate,?), ultimo_ms=? WHERE org_id=? AND telefone=?").bind(agora + PAUSA_HUMANO_MS, agora, orgId, m[1])
      ]);
      return json({ ok: true });
    } catch (e) { return falhou(e); }
  }

  // Respostas rápidas da equipe (atalhos de texto nas conversas).
  if (r === "respostas" && metodo === "GET") {
    const conta = await contaDa(env, orgId);
    return json({ respostas: lerConfig(conta).respostas_rapidas || [] });
  }
  if (r === "respostas" && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const lista = (Array.isArray(corpo.respostas) ? corpo.respostas : []).slice(0, 60).map(x => ({ atalho: cortar(String(x.atalho || "").replace(/^\/+/, ""), 30), texto: cortar(x.texto, 1500) })).filter(x => x.atalho && x.texto);
    const conta = await contaDa(env, orgId);
    const cfg = (() => { try { return JSON.parse(conta?.config || "{}") || {}; } catch { return {}; } })();
    cfg.respostas_rapidas = lista;
    await env.DB.prepare(`INSERT INTO plt_zap_contas(org_id,ativo,modo,config,atualizado_ms) VALUES(?,1,'BOTOES',?,?) ON CONFLICT(org_id) DO UPDATE SET config=excluded.config, atualizado_ms=excluded.atualizado_ms`).bind(orgId, JSON.stringify(cfg), agora).run();
    return json({ ok: true, respostas: lista });
  }

  // Campanhas: envio de um modelo aprovado para uma lista de clientes, em fila (a DENIA respeita o limite da Meta).
  if (r === "campanhas" && metodo === "GET") {
    const lista = await linhasDe(env, `SELECT c.*, (SELECT COUNT(*) FROM plt_zap_envios e WHERE e.campanha_id=c.id AND e.status IN ('ENTREGUE','LIDA')) entregues, (SELECT COUNT(*) FROM plt_zap_envios e WHERE e.campanha_id=c.id AND e.status='LIDA') lidas,
      (SELECT COUNT(*) FROM plt_zap_msgs mm JOIN plt_zap_envios e ON e.telefone=mm.telefone AND e.campanha_id=c.id WHERE mm.org_id=c.org_id AND mm.direcao='E' AND mm.criado_ms>c.criado_ms AND mm.criado_ms<COALESCE(c.fim_ms, c.criado_ms)+3*86400000) respostas
      FROM plt_zap_campanhas c WHERE c.org_id=? ORDER BY c.id DESC LIMIT 50`, orgId);
    return json({ campanhas: lista.map(c => ({ ...c, variaveis: JSON.parse(c.variaveis || "[]") })) });
  }
  if (r === "campanhas" && metodo === "POST") {
    const negado = precisa("ADMIN"); if (negado) return negado;
    const { corpo, erro } = await ler(200000); if (erro) return erro;
    const nome = k.txt(corpo.nome, 80), modelo = String(corpo.modelo || ""), idioma = String(corpo.idioma || "pt_BR");
    if (!nome || !/^[a-z0-9_]{1,512}$/.test(modelo) || !/^[a-z]{2}(_[A-Z]{2})?$/.test(idioma)) return json({ erro: "Escolha o nome da campanha e um modelo aprovado." }, 400);
    const vars = (Array.isArray(corpo.variaveis) ? corpo.variaveis : []).slice(0, 10).map(v => (v === "{nome}" ? "{nome}" : cortar(v, 200)));
    // Quem recebe: todos, uma etiqueta, quem falou nos últimos N dias, ou uma lista escolhida. Nunca quem pediu para sair.
    const conds = ["org_id=?", "optout=0"], args = [orgId];
    if (corpo.publico === "etiqueta") { conds.push("(',' || REPLACE(COALESCE(etiquetas,''),', ',',') || ',') LIKE ?"); args.push(`%,${String(corpo.etiqueta || "").trim()},%`); }
    else if (corpo.publico === "recentes") { conds.push("ultima_entrada_ms>?"); args.push(agora - Math.min(365, Math.max(1, Number(corpo.dias) || 30)) * 86400000); }
    else if (corpo.publico === "lista") { const tels = (Array.isArray(corpo.telefones) ? corpo.telefones : []).map(digitos).filter(t => t.length >= 10).slice(0, 10000); if (!tels.length) return json({ erro: "Escolha ao menos um cliente." }, 400); conds.push(`telefone IN (${tels.map(() => "?").join(",")})`); args.push(...tels); }
    const alvo = await linhasDe(env, `SELECT telefone, nome FROM plt_zap_contatos WHERE ${conds.join(" AND ")} LIMIT 10000`, ...args);
    if (!alvo.length) return json({ erro: "Nenhum cliente para esse público (quem pediu para sair nunca recebe)." }, 400);
    if (corpo.simular) return json({ total: alvo.length });
    const agendada = Number(corpo.agendada_ms) > agora ? Number(corpo.agendada_ms) : agora;
    const ins = await env.DB.prepare("INSERT INTO plt_zap_campanhas(org_id,nome,modelo,idioma,variaveis,status,total,agendada_ms,criado_por,criado_ms) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .bind(orgId, nome, modelo, idioma, JSON.stringify(vars), "AGENDADA", alvo.length, agendada, k.sessao?.usuario?.email || "", agora).run();
    const cid = ins.meta.last_row_id;
    for (let i = 0; i < alvo.length; i += 90) await env.DB.batch(alvo.slice(i, i + 90).map(a => env.DB.prepare("INSERT OR IGNORE INTO plt_zap_envios(campanha_id,org_id,telefone,nome) VALUES(?,?,?,?)").bind(cid, orgId, a.telefone, a.nome || null)));
    await k.auditar(env, request, k.sessao, orgId, "WHATSAPP", `Criou a campanha "${nome}" (${alvo.length} clientes, modelo ${modelo})`);
    return json({ ok: true, id: cid, total: alvo.length });
  }
  if ((m = r.match(/^campanhas\/(\d{1,12})\/(cancelar|pausar|retomar)$/)) && metodo === "POST") {
    const negado = precisa("ADMIN"); if (negado) return negado;
    const novo = { cancelar: "CANCELADA", pausar: "PAUSADA", retomar: "AGENDADA" }[m[2]];
    await env.DB.prepare("UPDATE plt_zap_campanhas SET status=? WHERE id=? AND org_id=? AND status NOT IN ('CONCLUIDA','CANCELADA')").bind(novo, Number(m[1]), orgId).run();
    return json({ ok: true });
  }
  if ((m = r.match(/^campanhas\/(\d{1,12})$/)) && metodo === "GET") {
    const envios = await linhasDe(env, "SELECT telefone, nome, status, erro, ms FROM plt_zap_envios WHERE campanha_id=? AND org_id=? ORDER BY ms DESC LIMIT 1000", Number(m[1]), orgId);
    return json({ envios });
  }
  return null;
}

// Cron: envia as campanhas em fila, devagar (até 120 por empresa a cada 5 minutos), registrando cada envio.
export async function processarCampanhas(env, k) {
  const agora = k.agora(env);
  const camps = await linhasDe(env, "SELECT c.*, z.phone_number_id, z.token_cifrado FROM plt_zap_campanhas c JOIN plt_zap_contas z ON z.org_id=c.org_id WHERE c.status IN ('AGENDADA','ENVIANDO') AND c.agendada_ms<=? ORDER BY c.id LIMIT 5", agora);
  for (const c of camps) {
    if (!c.token_cifrado || !c.phone_number_id) { await env.DB.prepare("UPDATE plt_zap_campanhas SET status='PAUSADA' WHERE id=?").bind(c.id).run(); continue; }
    const token = await k.decifrar(env, c.token_cifrado);
    const vars = JSON.parse(c.variaveis || "[]");
    const fila = await linhasDe(env, "SELECT telefone, nome FROM plt_zap_envios WHERE campanha_id=? AND status='PENDENTE' LIMIT 120", c.id);
    if (!fila.length) { await env.DB.prepare("UPDATE plt_zap_campanhas SET status='CONCLUIDA', fim_ms=? WHERE id=?").bind(agora, c.id).run(); continue; }
    await env.DB.prepare("UPDATE plt_zap_campanhas SET status='ENVIANDO' WHERE id=?").bind(c.id).run();
    let ok = 0, falha = 0, seguidas = 0;
    for (const p of fila) {
      const params = vars.map(v => ({ type: "text", text: v === "{nome}" ? (String(p.nome || "").split(" ")[0] || "cliente") : String(v || "-") }));
      const corpo = { messaging_product: "whatsapp", to: p.telefone, type: "template", template: { name: c.modelo, language: { code: c.idioma }, ...(params.length ? { components: [{ type: "body", parameters: params }] } : {}) } };
      let wamid = null, erro = null;
      try {
        const r = await fetch(`${GRAPH}/${encodeURIComponent(c.phone_number_id)}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(15000) });
        const d = await r.json().catch(() => ({}));
        if (r.ok) wamid = d?.messages?.[0]?.id || null; else erro = cortar(`${d?.error?.code || r.status}: ${d?.error?.error_data?.details || d?.error?.message || "erro"}`, 300);
      } catch (e) { erro = cortar(e?.message || "falha de rede", 300); }
      const ms = k.agora(env);
      await env.DB.batch([
        env.DB.prepare("UPDATE plt_zap_envios SET status=?, wamid=?, erro=?, ms=? WHERE campanha_id=? AND telefone=?").bind(wamid ? "ENVIADA" : "FALHOU", wamid, erro, ms, c.id, p.telefone),
        env.DB.prepare("INSERT OR IGNORE INTO plt_zap_msgs(org_id,telefone,direcao,origem,texto,wamid,status,erro,criado_ms) VALUES(?,?,'S','CAMPANHA',?,?,?,?,?)").bind(c.org_id, p.telefone, `[Campanha "${c.nome}" — modelo ${c.modelo}]`, wamid, wamid ? "ENVIADA" : "FALHOU", erro, ms)
      ]);
      if (wamid) { ok++; seguidas = 0; } else { falha++; seguidas++; }
      // Token inválido, número bloqueado ou modelo pausado: para a campanha em vez de insistir.
      if (seguidas >= 15 || /^(190|132001|132015|132016|131031|368):/.test(erro || "")) { await env.DB.prepare("UPDATE plt_zap_campanhas SET status='PAUSADA' WHERE id=?").bind(c.id).run(); break; }
    }
    await env.DB.prepare("UPDATE plt_zap_campanhas SET enviados=enviados+?, falhas=falhas+? WHERE id=?").bind(ok, falha, c.id).run();
  }
}
