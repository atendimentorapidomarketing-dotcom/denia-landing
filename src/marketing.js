import { rotasMeta, aoAprovar } from "./meta.js";
import { rotasSocial } from "./social.js";
import { rotasVoz, falarComVoz, configVoz } from "./voz.js";
import { rotasUso, registrarUso, custoOpenAI, tokensDe, precosDaOrg, orgDoUso, recursoDo, comRecurso } from "./uso.js";
import { rotasGoogle, responderAvaliacaoGoogle, apagarRespostaGoogle, contaGoogleDe, desempenhoAoVivo, sincronizarConta, linkDoPerfil, buscarConcorrentes, placesConfigurado, desempenhoDosDias } from "./google.js";
import { resumoSocial } from "./social.js";
import { gerarXlsx } from "./planilha.js";
// ============================================================================
// DENIA Platform — Estúdio de Marketing e Assistente DENIA (texto e voz)
// ============================================================================
//
// Marcas (uma empresa pode cuidar de várias marcas), calendário semanal de posts,
// criação com IA (textos e imagens), aprovação humana ou automática, Google Meu
// Negócio (avaliações, palavras-chave, desempenho) e o assistente DENIA.
//
// Usa o secret OPENAI_API_KEY do Worker da plataforma. Sem ele, tudo funciona,
// menos as funções de IA (que explicam o que falta).
// ============================================================================

const MODELO_TEXTO = "gpt-5.6-luna";
const STATUS_POST = ["RASCUNHO", "AGUARDANDO", "APROVADO", "PUBLICADO", "REJEITADO"];
const CANAIS = ["instagram", "facebook", "google"];
const FORMATOS = ["post", "carrossel", "story", "reels", "google"];

const DDL = [
  `CREATE TABLE IF NOT EXISTS plt_mk_marcas (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, nome TEXT NOT NULL, segmento TEXT, cidade TEXT, instagram TEXT, facebook TEXT, google TEXT, site TEXT, whatsapp TEXT, tom TEXT, publico TEXT, cores TEXT, diferenciais TEXT, ativa INTEGER NOT NULL DEFAULT 1, criado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS plt_mk_marcas_org ON plt_mk_marcas(org_id)`,
  `CREATE TABLE IF NOT EXISTS plt_mk_config (org_id INTEGER PRIMARY KEY, modo TEXT NOT NULL DEFAULT 'HUMANO', posts_semana INTEGER NOT NULL DEFAULT 3, nota_minima INTEGER NOT NULL DEFAULT 8, atualizado_ms INTEGER)`,
  `CREATE TABLE IF NOT EXISTS plt_mk_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, marca_id INTEGER NOT NULL, canais TEXT NOT NULL DEFAULT '["instagram"]', formato TEXT NOT NULL DEFAULT 'post', data TEXT, hora TEXT, titulo TEXT, legenda TEXT, hashtags TEXT, chamada TEXT, ideia_imagem TEXT, midia_id INTEGER, status TEXT NOT NULL DEFAULT 'RASCUNHO', revisao TEXT, comentario TEXT, criado_por TEXT, aprovado_por TEXT, criado_ms INTEGER NOT NULL, atualizado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS plt_mk_posts_org ON plt_mk_posts(org_id, data)`,
  `CREATE TABLE IF NOT EXISTS plt_mk_midias (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, mime TEXT NOT NULL, dados TEXT NOT NULL, prompt TEXT, criado_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS plt_mk_avaliacoes (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, marca_id INTEGER NOT NULL, autor TEXT, nota INTEGER, texto TEXT, data TEXT, resposta_sugerida TEXT, resposta TEXT, status TEXT NOT NULL DEFAULT 'PENDENTE', criado_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS plt_mk_palavras (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, marca_id INTEGER NOT NULL, palavra TEXT NOT NULL, cidade TEXT, criado_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS plt_mk_posicoes (palavra_id INTEGER NOT NULL, semana TEXT NOT NULL, posicao INTEGER, criado_ms INTEGER NOT NULL, PRIMARY KEY (palavra_id, semana))`,
  `CREATE TABLE IF NOT EXISTS plt_mk_relatorios (org_id INTEGER NOT NULL, marca_id INTEGER NOT NULL, semana TEXT NOT NULL, texto TEXT NOT NULL, criado_ms INTEGER NOT NULL, PRIMARY KEY (org_id, marca_id, semana))`,
  `CREATE TABLE IF NOT EXISTS plt_mk_metricas (org_id INTEGER NOT NULL, marca_id INTEGER NOT NULL, semana TEXT NOT NULL, dados TEXT NOT NULL, criado_ms INTEGER NOT NULL, PRIMARY KEY (org_id, marca_id, semana))`
];
const prontos = new WeakSet();
async function garantir(env) {
  if (prontos.has(env.DB)) return;
  await env.DB.batch(DDL.map(s => env.DB.prepare(s)));
  for (const alter of ["ALTER TABLE plt_mk_marcas ADD COLUMN idioma TEXT", "ALTER TABLE plt_mk_marcas ADD COLUMN horarios TEXT", "ALTER TABLE plt_mk_marcas ADD COLUMN logo_midia_id INTEGER", "ALTER TABLE plt_mk_posts ADD COLUMN texto_arte TEXT", "ALTER TABLE plt_mk_marcas ADD COLUMN ofertas TEXT", "ALTER TABLE plt_mk_avaliacoes ADD COLUMN analise TEXT", "ALTER TABLE plt_mk_config ADD COLUMN avaliacoes_auto TEXT", "ALTER TABLE plt_mk_avaliacoes ADD COLUMN triagem TEXT", "ALTER TABLE plt_mk_avaliacoes ADD COLUMN denuncia TEXT", "ALTER TABLE plt_mk_avaliacoes ADD COLUMN removida_ms INTEGER", "ALTER TABLE plt_mk_avaliacoes ADD COLUMN google_id TEXT", "ALTER TABLE plt_mk_avaliacoes ADD COLUMN avisado_ms INTEGER", "ALTER TABLE plt_mk_midias ADD COLUMN marca_id INTEGER", "ALTER TABLE plt_mk_midias ADD COLUMN nome_arquivo TEXT", "ALTER TABLE plt_mk_midias ADD COLUMN origem TEXT", "ALTER TABLE plt_mk_midias ADD COLUMN enviado_por TEXT", "ALTER TABLE plt_mk_midias ADD COLUMN descricao TEXT", "ALTER TABLE plt_mk_midias ADD COLUMN original_id INTEGER", "ALTER TABLE plt_mk_midias ADD COLUMN google_id TEXT", "ALTER TABLE plt_mk_midias ADD COLUMN arquivo TEXT", "ALTER TABLE plt_mk_midias ADD COLUMN tamanho INTEGER", "ALTER TABLE plt_mk_midias ADD COLUMN capa_id INTEGER", "ALTER TABLE plt_mk_midias ADD COLUMN duracao REAL", "ALTER TABLE plt_mk_posts ADD COLUMN botao TEXT", "ALTER TABLE plt_mk_posts ADD COLUMN botao_url TEXT"])
    await env.DB.prepare(alter).run().catch(() => { }); // coluna já existe
  prontos.add(env.DB);
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

function chave(env) { return String(env.OPENAI_API_KEY || "").trim(); }
function semChave() {
  return { status: 503, corpo: { erro: "A inteligência da DENIA ainda não foi ligada: falta a chave da OpenAI. Vá em Administração → Integrações → \"Inteligência da DENIA (OpenAI)\", cole a chave e salve.", codigo: "SEM_OPENAI" } };
}
function textoDaResposta(d) {
  if (typeof d?.output_text === "string" && d.output_text) return d.output_text;
  const partes = [];
  for (const o of d?.output || []) for (const c of o?.content || []) if (typeof c?.text === "string") partes.push(c.text);
  return partes.join("");
}
// Tipo de uso de cada caminho da OpenAI (para a página Consumo).
const OPERACAO_OPENAI = { responses: "texto", "images/edits": "imagem", "images/generations": "imagem", "audio/transcriptions": "transcricao", "audio/speech": "voz_falada", "realtime/client_secrets": "voz_sessao" };
export { openai as openaiBruto };
async function openai(env, caminho, corpo, extras = {}) {
  const inicio = Date.now();
  const modelo = String((corpo instanceof FormData ? corpo.get("model") : corpo?.model) || "");
  const org = orgDoUso(env), operacao = OPERACAO_OPENAI[caminho] || caminho, recurso = recursoDo(env);
  let r;
  try {
    r = await fetch("https://api.openai.com/v1/" + caminho, {
      method: "POST",
      headers: { authorization: `Bearer ${chave(env)}`, ...(corpo instanceof FormData ? {} : { "content-type": "application/json" }) },
      body: corpo instanceof FormData ? corpo : JSON.stringify(corpo),
      signal: AbortSignal.timeout(extras.timeout || 60000)
    });
  } catch (e) { registrarUso(org, "openai", operacao, modelo, { erro: true, ms: Date.now() - inicio }, recurso); throw e; }
  if (extras.binario) {
    // Voz falada: a API não devolve tokens; o custo é estimado pelos caracteres do texto.
    const caracteres = operacao === "voz_falada" ? String(corpo?.input || "").length : 0;
    registrarUso(org, "openai", operacao, modelo, { erro: !r.ok, limitada: r.status === 429, caracteres, custo_usd: r.ok && caracteres ? custoOpenAI(modelo, null, await precosDaOrg(env, org), { caracteres }) : 0, ms: Date.now() - inicio }, recurso);
    if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}`);
    return r;
  }
  const d = await r.json().catch(() => ({}));
  registrarUso(org, "openai", operacao, modelo, { erro: !r.ok, limitada: r.status === 429, ...tokensDe(d?.usage), imagens: operacao === "imagem" && r.ok ? (d?.data || []).length : 0,
    custo_usd: r.ok ? custoOpenAI(modelo, d?.usage, await precosDaOrg(env, org)) : 0, ms: Date.now() - inicio }, recurso);
  if (!r.ok) {
    const msg = d?.error?.message || `HTTP ${r.status}`;
    const e = new Error(r.status === 401 ? "A chave da OpenAI foi recusada. Cole uma chave válida em Integrações → Inteligência da DENIA (OpenAI)." : r.status === 429 ? "A OpenAI recusou por limite ou falta de crédito na conta. Confira em platform.openai.com → Billing." : "A IA não conseguiu responder agora: " + msg);
    e.status = r.status;
    throw e;
  }
  return d;
}
async function iaJSON(env, instrucoes, entrada, maxTokens = 2500) {
  const d = await openai(env, "responses", {
    model: String(env.OPENAI_MODEL || MODELO_TEXTO).trim(), instructions: instrucoes,
    input: [{ role: "user", content: [{ type: "input_text", text: entrada }] }],
    text: { format: { type: "json_object" } }, max_output_tokens: maxTokens, store: false
  });
  try { return JSON.parse(textoDaResposta(d)); } catch { throw new Error("A IA respondeu num formato inesperado. Tente de novo."); }
}
// Chamada curta e barata (chatbot): modelo escolhido pela empresa, raciocínio mínimo, resposta em JSON.
export async function openaiResposta(env, { modelo, instrucoes, entrada, maxTokens = 400, recurso = "", esforco = "minimal" }) {
  const corpo = { model: String(modelo || "gpt-5-nano"), instructions: instrucoes, input: [{ role: "user", content: [{ type: "input_text", text: entrada }] }], text: { format: { type: "json_object" } }, max_output_tokens: maxTokens, store: false };
  if (/^gpt-5(-mini|-nano)?$/.test(corpo.model)) corpo.reasoning = { effort: esforco };
  const d = await openai(recurso ? comRecurso(env, recurso) : env, "responses", corpo, { timeout: 20000 });
  try { return JSON.parse(textoDaResposta(d)); } catch { throw new Error("A IA respondeu num formato inesperado."); }
}
async function iaTexto(env, instrucoes, mensagens, maxTokens = 900) {
  const d = await openai(env, "responses", {
    model: String(env.OPENAI_MODEL || MODELO_TEXTO).trim(), instructions: instrucoes,
    input: mensagens.map(m => ({ role: m.papel === "denia" ? "assistant" : "user", content: [{ type: m.papel === "denia" ? "output_text" : "input_text", text: m.texto }] })),
    max_output_tokens: maxTokens, store: false
  });
  return textoDaResposta(d).trim();
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function dataISO(v) { const s = String(v || "").slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ""; }
function horaOk(v) { const s = String(v || "").slice(0, 5); return /^\d{2}:\d{2}$/.test(s) ? s : ""; }
function semanaDe(iso) {
  const d = new Date(iso + "T12:00:00Z"); const dia = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dia); return d.toISOString().slice(0, 10);
}
function maisDias(iso, n) { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function canaisOk(v) { const l = (Array.isArray(v) ? v : []).map(String).filter(c => CANAIS.includes(c)); return l.length ? [...new Set(l)] : ["instagram"]; }
function linhaPost(p) {
  let canais = []; let revisao = null;
  try { canais = JSON.parse(p.canais || "[]"); } catch { canais = []; }
  try { revisao = p.revisao ? JSON.parse(p.revisao) : null; } catch { revisao = null; }
  return { ...p, canais, revisao };
}
// Idiomas da plataforma (interface, conteúdo das marcas e conversa com a DENIA).
export const IDIOMAS = { "pt-BR": "português do Brasil", en: "inglês (English)", es: "espanhol (español)", de: "alemão (Deutsch)", it: "italiano", fr: "francês (français)", ja: "japonês (日本語)", hi: "hindi (हिन्दी)" };
export const idiomaDe = v => (IDIOMAS[String(v || "")] ? String(v) : "pt-BR");
// Botão do post no Google (o Google aceita um por post): AUTO alterna Ligar e Site; os de link usam o site da marca se não houver outro.
export const BOTOES_GOOGLE = ["AUTO", "CALL", "LEARN_MORE", "BOOK", "ORDER", "SHOP", "SIGN_UP", "NENHUM"];
async function gravarBotao(env, postId, c) {
  if (c.botao === undefined && c.botao_url === undefined) return;
  const b = BOTOES_GOOGLE.includes(c.botao) ? c.botao : "AUTO";
  const u = String(c.botao_url || "").trim().slice(0, 500);
  await env.DB.prepare("UPDATE plt_mk_posts SET botao=?, botao_url=? WHERE id=?").bind(b, /^https:\/\/[^\s]+$/i.test(u) ? u : null, postId).run();
}
// Legenda de post a partir de foto ou vídeo REAL: texto de venda com palavras-chave (SEO local), nunca uma descrição da imagem.
const pareceDescricao = (leg, desc) => {
  const l = String(leg || "").trim(), palavras = t => new Set(String(t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").match(/[a-z0-9]{4,}/g) || []);
  if (l.length < 160) return true;
  if (/^(a |o |na |no |uma |um )?(foto|imagem|v[ií]deo) (mostra|apresenta|exibe)|^(nesta|nessa|na) (foto|imagem)/i.test(l)) return true;
  const a = palavras(l), b = palavras(desc);
  if (!b.size) return false;
  let comuns = 0; for (const w of b) if (a.has(w)) comuns++;
  return comuns / b.size > 0.8 && l.length < 320;
};
export async function legendaDeMidia(env, marca, { imagens = [], pedido = "", canais = ["instagram"], formato = "post", tipo = "foto", modoTexto = "nao", palavras = [] }) {
  const sóGoogle = canais.length === 1 && canais[0] === "google";
  const nome = tipo === "video" ? "VÍDEO" : "FOTO";
  const instrucoes = `Você é a social media e especialista em SEO local de uma agência de marketing de alto nível. A empresa te mandou uma ${nome} REAL de um serviço que ela fez${pedido ? " e explicou, com as palavras dela, o que quer" : ""}. Sua tarefa é escrever a LEGENDA DE UM POST QUE VENDE — não uma descrição da imagem.
${REGRAS_CONTEUDO}
${COPY_QUE_VENDE}
A LEGENDA (campo "legenda"):
- NUNCA comece com "A foto mostra", "Nesta imagem", "Na foto" nem descreva a cena como um catálogo. A ${nome.toLowerCase()} serve de prova; a legenda fala com o CLIENTE: a dor ou o desejo dele, o resultado, por que escolher a empresa.
- 1ª linha: gancho forte (pergunta, dor, curiosidade ou resultado) que faz parar de rolar.
- Depois, 2 a 4 frases curtas: o serviço com o nome que o cliente busca no Google, o resultado/benefício, um detalhe concreto do que se vê (prova), diferenciais da empresa.
- Use de forma natural 2 a 4 PALAVRAS-CHAVE de busca local: SERVIÇO + BAIRRO/CIDADE (ex.: "lavagem de tapete na Zona Sul", "conserto de TV em Botafogo"). ${palavras.length ? `Prefira estas, que a empresa acompanha no Google: ${palavras.join(", ")}.` : ""}
- ${sóGoogle ? "É post do Google: NÃO coloque telefone nem WhatsApp (o Google recusa); termine com convite para pedir orçamento pelo botão do perfil." : "Termine com chamada clara para o WhatsApp, com o número exatamente como está nos dados da marca (se não houver número, chame para o direct)."}
- Quebras de linha entre as ideias, emojis com moderação, entre 400 e 1200 caracteres.
- Se o dono pediu algo (oferta, tom, assunto, o que destacar), isso tem prioridade. Não invente preço, prazo, desconto ou resultado que ele não disse e a ${nome.toLowerCase()} não mostra.
HASHTAGS ("hashtags"): ${sóGoogle ? "vazio." : "8 a 15, misturando serviço, serviço+bairro/cidade, cidade e nicho (ex.: #lavagemdetapete #tapetelimpo #zonasulsp #lavagemdetapetezonasul). Sem acentos."}
OUTROS CAMPOS: titulo (interno, até 8 palavras); chamada (botão/CTA curto); palavras_chave (lista das palavras-chave de busca que você usou); texto_arte (${modoTexto === "sim" ? "OBRIGATÓRIO: frase curta e forte de até 6 palavras para escrever na imagem" : modoTexto === "nao" ? "vazio" : "frase de até 6 palavras só se ajudar a vender; senão vazio"}); nome_arquivo (3 a 7 palavras sem acentos com hífen: SERVIÇO + BAIRRO/CIDADE, ex.: lavagem-tapete-persa-zona-sul-sp); descricao_foto (1 a 2 frases, SÓ para uso interno/acessibilidade, dizendo o que a imagem mostra com serviço e bairro)${tipo === "video" ? `; capa (número do quadro, de 1 a ${Math.max(1, imagens.length)}, que fica melhor como capa)` : ""}.
Responda em JSON: {"titulo":"","legenda":"","hashtags":"","chamada":"","palavras_chave":[],"texto_arte":"","nome_arquivo":"","descricao_foto":""${tipo === "video" ? ',"capa":1' : ""}}`;
  const entrada = `${resumoMarca(marca)}\n\nCanais: ${canais.join(", ")}. Formato: ${formato}.\nO que o dono explicou: ${pedido || "(nada — escreva a partir da imagem e dos dados da marca)"}\nResponda em JSON.`;
  const d = await openai(env, "responses", {
    model: String(env.OPENAI_MODEL || MODELO_TEXTO).trim(), instructions: instrucoes,
    input: [{ role: "user", content: [{ type: "input_text", text: entrada }, ...imagens.map(i => ({ type: "input_image", image_url: `data:${i.mime};base64,${i.b64}`, detail: tipo === "video" ? "low" : "high" }))] }],
    text: { format: { type: "json_object" } }, max_output_tokens: 3000, store: false
  });
  let r; try { r = JSON.parse(textoDaResposta(d)); } catch { return null; }
  // Conferência: se saiu com cara de descrição da imagem, reescreve como legenda de venda.
  if (pareceDescricao(r.legenda, r.descricao_foto)) {
    const n = await iaJSON(env, `${instrucoes}\n\nO texto abaixo saiu como DESCRIÇÃO da imagem, não como legenda. Reescreva como legenda de post que vende, seguindo todas as regras acima. Mantenha os fatos.`,
      `${entrada}\n\nO que a imagem mostra: ${String(r.descricao_foto || "").slice(0, 600)}\nTexto que saiu errado: ${String(r.legenda || "").slice(0, 1500)}\nResponda em JSON.`, 3000).catch(() => null);
    if (n?.legenda && !pareceDescricao(n.legenda, r.descricao_foto)) r = { ...r, ...n, descricao_foto: r.descricao_foto, nome_arquivo: r.nome_arquivo || n.nome_arquivo, capa: r.capa };
    r.reescrita = true;
  }
  r.palavras_chave = (Array.isArray(r.palavras_chave) ? r.palavras_chave : String(r.palavras_chave || "").split(/[,;\n]/)).map(x => String(x).trim()).filter(Boolean).slice(0, 8);
  return r;
}
// Vídeo guardado em disco (env.ARQUIVOS), com faixa de bytes para o player do navegador e para a Meta/Google baixarem.
export async function servirArquivo(env, request, r, baixar = false) {
  if (!env.ARQUIVOS) return new Response("Armazenamento indisponível.", { status: 503 });
  const faixa = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") || "");
  let ini, fim;
  if (faixa && (faixa[1] || faixa[2])) { if (faixa[1]) { ini = Number(faixa[1]); fim = faixa[2] ? Number(faixa[2]) : undefined; } else { ini = -Number(faixa[2]); } }
  let a = await env.ARQUIVOS.get(r.arquivo, ini != null && ini >= 0 ? { inicio: ini, fim } : {});
  if (!a) return new Response("Não encontrado.", { status: 404 });
  if (ini != null && ini < 0) a = await env.ARQUIVOS.get(r.arquivo, { inicio: Math.max(0, a.tamanho + ini) });
  const parcial = ini != null && (a.inicio > 0 || a.fim < a.tamanho - 1);
  const cab = { "content-type": r.mime, "accept-ranges": "bytes", "content-length": String(a.fim - a.inicio + 1), "cache-control": "private, max-age=86400" };
  if (parcial) cab["content-range"] = `bytes ${a.inicio}-${a.fim}/${a.tamanho}`;
  if (baixar) cab["content-disposition"] = `attachment; filename="${(r.nome_arquivo || "video").replace(/[^a-z0-9-]/gi, "")}.${extDoMime(r.mime)}"`;
  return new Response(request.method === "HEAD" ? null : a.body, { status: parcial ? 206 : 200, headers: cab });
}
export const extDoMime = m => m === "video/quicktime" ? "mov" : /^video\//.test(m || "") ? "mp4" : m === "image/png" ? "png" : m === "image/webp" ? "webp" : "jpg";
// Nome de arquivo pensado para busca: serviço + bairro/cidade + marca, sem acentos, com hífens (ex.: conserto-tv-botafogo).
export function slugSeo(t, max = 70) {
  return String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+[^-]*$/, m => m.length > 1 && String(t).length > max ? "" : m).replace(/-+$/, "") || "foto";
}
export async function nomeUnico(env, orgId, base) {
  const usados = new Set(((await env.DB.prepare("SELECT nome_arquivo FROM plt_mk_midias WHERE org_id=? AND (nome_arquivo=? OR nome_arquivo LIKE ?)").bind(orgId, base, base + "-%").all())?.results || []).map(r => r.nome_arquivo));
  if (!usados.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!usados.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}
// A IA olha a foto e devolve o nome do arquivo e a descrição pensados para o Google (usado também nas fotos enviadas direto ao perfil).
export async function nomearFotoComIA(env, marca, mime, dados, pedido = "") {
  const d = await openai(env, "responses", {
    model: String(env.OPENAI_MODEL || MODELO_TEXTO).trim(),
    instructions: `Você é especialista em SEO local e Perfil da Empresa no Google. Olhe a foto real da empresa e devolva JSON {"nome_arquivo":"","descricao":""}.
- nome_arquivo: 3 a 7 palavras em minúsculas, sem acentos, separadas por hífen, na ordem SERVIÇO-O-QUE-APARECE + BAIRRO ou CIDADE da marca (+ nome curto da marca se couber). Use as palavras que um cliente digitaria no Google. Ex.: conserto-tv-samsung-botafogo, lavagem-tapete-persa-zona-sul-sp. Nada de "img", "foto", datas ou números de câmera.
- descricao: 1 a 2 frases naturais (até 250 letras) dizendo o que a foto mostra, com o serviço e o bairro/cidade, sem exagero e sem inventar nada que não aparece.`,
    input: [{ role: "user", content: [{ type: "input_text", text: `${resumoMarca(marca)}\n${pedido ? "O dono disse: " + String(pedido).slice(0, 600) : ""}\nResponda em JSON.` }, { type: "input_image", image_url: `data:${mime};base64,${dados}`, detail: "low" }] }],
    text: { format: { type: "json_object" } }, max_output_tokens: 600, store: false
  });
  let r = {}; try { r = JSON.parse(textoDaResposta(d)); } catch { }
  return { nome: slugSeo(r.nome_arquivo || `${marca.segmento || "servico"} ${marca.cidade || ""} ${marca.nome}`), descricao: String(r.descricao || "").replace(/\s+/g, " ").trim().slice(0, 300) };
}
function resumoMarca(m) {
  return [`Marca: ${m.nome}`, `IDIOMA DO CONTEÚDO: ${IDIOMAS[idiomaDe(m.idioma)]} (escreva tudo neste idioma)`, m.segmento && `Segmento: ${m.segmento}`, m.cidade && `Cidade/região: ${m.cidade}`, m.publico && `Público: ${m.publico}`, m.tom && `Tom de voz: ${m.tom}`,
    m.diferenciais && `Diferenciais: ${m.diferenciais}`, m.ofertas && `Produtos, serviços e ofertas para divulgar: ${m.ofertas}`, m.cores && `Cores da marca: ${m.cores}`, m.horarios && `Dias e horários preferidos para publicar: ${m.horarios}`, m.whatsapp && `WhatsApp para contato: ${m.whatsapp}`, m.site && `Site: ${m.site}`].filter(Boolean).join("\n");
}
const REGRAS_CONTEUDO = `Regras: escrita impecável (ortografia, acentos e pontuação revisados palavra por palavra), sem erros, no IDIOMA DO CONTEÚDO da marca (inclusive hashtags e chamadas); nada de promessas que a empresa não pode cumprir; não invente preços, descontos, prêmios, números ou depoimentos; nada de conteúdo enganoso; respeite as políticas do Instagram, Facebook e Google; chamadas para ação claras (ex.: "Chame no WhatsApp"); hashtags relevantes e locais, no máximo 12.`;
// Legenda que vende: estrutura de copywriting de agência, específica da marca (nada genérico).
const COPY_QUE_VENDE = `Legenda que VENDE (siga sempre):
1) Primeira linha = gancho forte que faz a pessoa parar de rolar: uma dor, um desejo ou uma curiosidade do cliente (nunca comece com o nome da marca nem com "Você sabia").
2) Benefício concreto para o cliente — o que ele ganha ou evita — citando o produto/serviço específico da marca (use os "Produtos, serviços e ofertas" e os "Diferenciais"; nada que serviria para qualquer empresa).
3) Um motivo real para confiar (diferencial verdadeiro da marca, garantia, experiência, atendimento) — sem inventar números ou depoimentos.
4) Oferta ou próximo passo claro, com urgência honesta (ex.: "agenda desta semana", "enquanto durar o estoque" só se for verdade).
5) Chamada final direta com o contato real da marca: WhatsApp com o número, site ou bairro/cidade. Ex.: "Chame no WhatsApp (21) 99999-9999 e peça seu orçamento".
Estilo: fale com o cliente ("você"), frases curtas, parágrafos de 1 ou 2 linhas, emojis com moderação; cite a cidade/bairro para atrair clientes da região.`;

// ---------------------------------------------------------------------------
// Artes: qualidade alta, logo verdadeira e texto conferido
// ---------------------------------------------------------------------------

const LIMITE_VIDEO = 300 * 1024 * 1024; // o Instagram aceita Reels de até 300 MB pela API
const LIMITE_LOGO_B64 = 1_900_000; // ~1,4 MB (limite de linha do D1 é 2 MB); o navegador reduz a logo antes de enviar
function tipoDaImagem(b64) {
  if (!b64 || b64.length > LIMITE_LOGO_B64 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) return "";
  const ini = atob(b64.slice(0, 24).replace(/\s/g, ""));
  if (ini.startsWith("\x89PNG")) return "image/png";
  if (ini.startsWith("\xff\xd8\xff")) return "image/jpeg";
  if (ini.startsWith("RIFF") && ini.slice(8, 12) === "WEBP") return "image/webp";
  return "";
}
const bytesDe = b64 => Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));

function briefDaArte(marca, ideia, textoArte, temLogo, correcao) {
  const idioma = IDIOMAS[idiomaDe(marca.idioma)];
  return [
    `Arte para redes sociais da marca "${marca.nome}" (${marca.segmento || "serviços"}${marca.cidade ? ", " + marca.cidade : ""}), com acabamento de agência de publicidade premium.`,
    `Cena: ${ideia}.`,
    marca.cores ? `Paleta: use as cores da marca (${marca.cores}) com elegância, em detalhes e na tipografia.` : "",
    "Direção de arte: fotografia publicitária hiper-realista (ou ilustração 3D refinada, se a cena pedir), iluminação de estúdio suave, profundidade de campo, cores ricas e naturais, pessoas com aparência real e mãos corretas, composição limpa com espaço para respirar e hierarquia visual clara. Nada de aparência genérica de banco de imagens, nada de elementos distorcidos.",
    textoArte
      ? `Texto: o ÚNICO texto escrito na arte é, exatamente, "${textoArte}" (em ${idioma}). Copie letra por letra, com todos os acentos e cedilhas, em tipografia moderna, grande, nítida e muito legível. Não escreva nenhuma outra palavra, número, telefone, site ou hashtag.`
      : "Texto: não escreva nenhuma palavra, letra ou número na arte.",
    temLogo
      ? "Logo: a imagem anexada é a logo oficial da marca. Aplique-a EXATAMENTE como está — mesmas formas, letras e cores, sem redesenhar, sem distorcer —, pequena e nítida em um canto, sobre uma área limpa da arte. Não crie nenhuma outra logo."
      : "Logo: não invente logotipo nem marca d'água.",
    correcao ? `ATENÇÃO, correção obrigatória da tentativa anterior: ${correcao}` : ""
  ].filter(Boolean).join("\n");
}

async function gerarImagem(env, prompt, tamanho, logo) {
  const qualidade = String(env.OPENAI_IMAGE_QUALITY || "high").trim();
  // O modelo de imagem muda com o tempo (o gpt-image-1 está sendo aposentado): tenta o configurado e cai para o seguinte.
  const modelos = [...new Set([String(env.OPENAI_IMAGE_MODEL || "").trim(), "gpt-image-1.5", "gpt-image-1"].filter(Boolean))];
  let ultimoErro = null;
  for (const modelo of modelos) {
    try {
      let d;
      if (logo) {
        const envio = (fidelidade) => {
          const f = new FormData();
          for (const [k, v] of Object.entries({ model: modelo, prompt, size: tamanho, quality: qualidade, output_format: "jpeg", output_compression: "88", n: "1" })) f.append(k, v);
          if (fidelidade) f.append("input_fidelity", "high");
          f.append("image[]", new Blob([bytesDe(logo.dados)], { type: logo.mime }), "logo." + logo.mime.split("/")[1]);
          return f;
        };
        try { d = await openai(env, "images/edits", envio(true), { timeout: 180000 }); }
        catch (e) { if (!/input_fidelity/i.test(String(e?.message))) throw e; d = await openai(env, "images/edits", envio(false), { timeout: 180000 }); }
      } else {
        d = await openai(env, "images/generations", { model: modelo, prompt, size: tamanho, quality: qualidade, output_format: "jpeg", output_compression: 88, n: 1 }, { timeout: 180000 });
      }
      const b64 = d?.data?.[0]?.b64_json;
      if (!b64) throw Object.assign(new Error("A IA não devolveu a imagem. Tente de novo."), { status: 502 });
      return b64;
    } catch (e) { ultimoErro = e; if (!/model|modelo|not found|does not exist|deprecat|404/i.test(String(e?.message))) throw e; }
  }
  throw ultimoErro;
}

// A IA "olha" a arte pronta, como um revisor: o texto está escrito certo? a logo aparece?
async function conferirArte(env, b64, textoArte, temLogo) {
  const d = await openai(env, "responses", {
    model: String(env.OPENAI_MODEL || MODELO_TEXTO).trim(),
    instructions: `Você é revisora de artes de uma agência. Leia com atenção todo o texto visível na imagem e confira a ortografia letra por letra, inclusive acentos e cedilhas. Responda em JSON: {"texto_lido":"","correto":true,"problemas":""}. correto=false se houver qualquer erro de escrita, letra trocada, palavra inventada, texto diferente do esperado${temLogo ? ", ou se a logo não aparecer" : ""}. problemas: o que corrigir, em uma frase.`,
    input: [{ role: "user", content: [
      { type: "input_text", text: textoArte ? `Texto que deveria estar escrito: "${textoArte}" (e nenhum outro).` : "A arte não deveria ter texto escrito (a logo da marca pode aparecer)." },
      { type: "input_image", image_url: `data:image/jpeg;base64,${b64}` }] }],
    text: { format: { type: "json_object" } }, max_output_tokens: 400, store: false
  }, { timeout: 60000 });
  const r = JSON.parse(textoDaResposta(d) || "{}");
  return { correto: r.correto !== false, problemas: String(r.problemas || "").slice(0, 300), texto_lido: String(r.texto_lido || "").slice(0, 200) };
}

const TENTATIVAS_ARTE = 2;
async function criarArte(env, { marca, ideia, textoArte, logo, tamanho }) {
  let correcao = "", b64 = "", prompt = "", conferencia = null;
  for (let i = 0; i < TENTATIVAS_ARTE; i++) {
    prompt = briefDaArte(marca, ideia, textoArte, Boolean(logo), correcao);
    b64 = await gerarImagem(env, prompt, tamanho, logo);
    if (!textoArte && !logo) break;
    conferencia = await conferirArte(env, b64, textoArte, Boolean(logo)).catch(() => null);
    if (!conferencia || conferencia.correto) break;
    correcao = conferencia.problemas + (textoArte ? ` O texto deve ser exatamente "${textoArte}".` : " A arte não deve ter texto escrito.");
  }
  return { b64, prompt, conferencia: conferencia ? { correto: conferencia.correto, problemas: conferencia.problemas } : null };
}

// Conhecimento de especialista (só para a DENIA do painel, que fala com a equipe — nunca para o WhatsApp dos clientes).
const ESPECIALISTA_TEMPORADA = `ESPECIALIDADE EM LOCAÇÃO POR TEMPORADA: você também é uma gestora sênior de imóveis de temporada (nível superanfitrião no Airbnb e parceiro preferencial no Booking.com), com domínio de:
- Receita: diária base e de fim de semana, sazonalidade, eventos e feriados, mínimo de noites por período, descontos semanal/mensal, preço de última hora, ocupação × diária média × RevPAR, comissão de cada plataforma (ajuste por plataforma para receber o mesmo).
- Operação: check-in/check-out, limpeza entre estadias (checklist por cômodo, inventário, estoque de reposição, enxoval), manutenção preventiva, vistoria de danos, chaves e fechaduras.
- Hóspedes: comunicação rápida e calorosa, regras da casa, prevenção de festas e de risco (sempre pelo comportamento, nunca por características pessoais), pedidos de reembolso, danos (AirCover no Airbnb; caução/depósito no Booking e no Vrbo).
- Reputação: responder avaliações, quando e como pedir remoção (retaliação, coerção, irrelevante, discriminatória, de quem violou regras graves), como transformar críticas em melhorias.
- Anúncio: título, fotos, descrição, comodidades, posição nas buscas (taxa de resposta, avaliações, preço competitivo, calendário aberto, reserva instantânea).
- Regras no Brasil: locação por temporada até 90 dias (Lei 8.245/91, arts. 48 a 50), convenção do condomínio, contrato e recibos, LGPD com dados de hóspedes. Para dúvidas jurídicas ou fiscais específicas, oriente a confirmar com advogado ou contador.
Use os dados da plataforma (imóveis, reservas, estoque, limpezas, melhorias, avaliações) e as ferramentas tp_* para agir.`;
const ESPECIALISTA_DIGITAL = `ESPECIALIDADE: você é também uma estrategista sênior de marketing digital para negócios locais, com domínio de Google e Meta. Use este conhecimento ao orientar a equipe (com exemplos práticos e passos concretos):
- Google Perfil da Empresa (Google Meu Negócio): o ranqueamento local depende de relevância, distância e proeminência. Alavancas: categoria principal certa (e secundárias), nome real sem palavras-chave forçadas, endereço/área de atendimento e telefone iguais em todo lugar (NAP), horário sempre atualizado, serviços e produtos cadastrados com descrição, fotos reais frequentes (fachada, equipe, trabalhos), posts semanais com chamada para ação, perguntas e respostas, e avaliações: pedir a todo cliente satisfeito, ritmo constante, responder todas (as negativas com calma, sem expor dados, levando para o privado). Perfil verificado e sem violar as diretrizes (nada de avaliação comprada ou falsa: dá suspensão).
- SEO local e orgânico: Search Console para ver buscas, cliques, impressões e posição média; páginas por serviço e por bairro/cidade com conteúdo útil de verdade; título e descrição com serviço + cidade; dados estruturados LocalBusiness; site rápido no celular (Core Web Vitals); botão de WhatsApp e telefone visíveis; citações em diretórios confiáveis e links de parceiros locais. Resultado orgânico leva semanas a meses.
- Google Ads: campanha de Pesquisa para quem já procura o serviço (palavras de intenção: "conserto de geladeira em Niterói"), tipos de correspondência e palavras negativas, segmentação por raio/bairros, programação de horário, recursos (sitelinks, chamada, local), anúncios responsivos com o diferencial real. Meça conversões de verdade (ligação, clique no WhatsApp, formulário) com o Google Analytics 4/Tag Manager antes de escalar; comece com orçamento diário pequeno, otimize por custo por contato, Índice de qualidade e termos de pesquisa; Performance Max só com conversões bem medidas.
- Instagram e Facebook: constância, Reels curtos com gancho nos 2 primeiros segundos, bastidores e antes/depois reais, prova social real, chamada clara para o WhatsApp, responder comentários e directs rápido; anúncios da Meta com público local e objetivo de mensagens.
- Métricas que importam: contatos gerados (WhatsApp/ligações), custo por contato, taxa de fechamento, avaliações e nota média, posição nas buscas principais.
Honestidade: nunca prometa posição no Google nem resultado garantido; números de mercado são estimativas (diga que são); se não souber algo atual, use a pesquisa na web (no modo de voz) ou diga que vai confirmar.`;

// ---------------------------------------------------------------------------
// Avaliações do Google: a DENIA lê cada uma como uma gerente de reputação
// ---------------------------------------------------------------------------

const SENTIMENTOS = ["OTIMA", "POSITIVA", "NEUTRA", "NEGATIVA", "GRAVE"];
const MODOS_AVALIACAO = ["DESLIGADO", "CINCO", "BOAS", "TODAS"];
// Pode sair sem uma pessoa? Nunca as graves, as que pedem uma pessoa, as suspeitas de violar regras ou as urgentes.
function podeResponderSozinha(modo, a, analise) {
  if (!a.google_id || !analise || modo === "DESLIGADO" || !MODOS_AVALIACAO.includes(modo)) return false;
  if (analise.precisa_humano || analise.viola_politica || analise.sentimento === "GRAVE" || analise.urgencia === "ALTA") return false;
  if (modo === "CINCO") return Number(a.nota) >= 5 && ["OTIMA", "POSITIVA"].includes(analise.sentimento);
  return modo === "TODAS" || (Number(a.nota) >= 4 && ["OTIMA", "POSITIVA"].includes(analise.sentimento));
}
const INSTRUCOES_AVALIACAO = `Você é a gerente de reputação online da empresa, especialista em Google Perfil da Empresa. Leia UMA avaliação com atenção ao contexto (o que aconteceu, o tom, a nota, o que a pessoa quer) e decida como tratá-la.
Classifique:
- sentimento: OTIMA (elogio forte), POSITIVA, NEUTRA, NEGATIVA (reclamação comum: atraso, preço, atendimento) ou GRAVE (acusação séria, risco à segurança, ameaça de processo, ofensa, dado pessoal exposto, fraude).
- temas: até 4 palavras-chave do assunto (ex.: "atraso", "preço", "educação do técnico", "rapidez").
- urgencia: ALTA (GRAVE, ou negativa que pode afastar clientes e pede resposta hoje), MEDIA (negativa comum ou neutra com crítica) ou BAIXA (positiva).
- precisa_humano: true quando uma pessoa da equipe precisa agir antes de responder (GRAVE; o cliente pede contato ou reembolso; fatos que só a equipe pode confirmar; suspeita de avaliação falsa). motivo_humano: em 1 frase, o que a pessoa deve fazer.
- viola_politica: true só quando há sinais claros de que a avaliação viola as regras de conteúdo do Google: spam ou avaliação falsa (quem nunca foi cliente, várias avaliações iguais, concorrente), conflito de interesses (ex-funcionário, concorrente), conteúdo fora do tema (política, assunto que não é a experiência com a empresa), conteúdo ofensivo/assédio/discurso de ódio, informação pessoal de terceiros, conteúdo sexual, ilegal ou perigoso, falsificação de identidade. Nota baixa ou crítica justa NÃO é violação. politica: qual regra. como_remover: passos curtos — no Perfil da Empresa (Google Maps ou Pesquisa) abrir Avaliações, nos três pontos da avaliação clicar em "Denunciar avaliação" e escolher o motivo; acompanhar o pedido na ferramenta de gerenciamento de avaliações do Google; se for recusado, dá para pedir uma nova análise uma vez, com provas. Avise que a remoção não é garantida, que nunca se deve oferecer vantagem para o cliente apagar e que vale responder com educação enquanto isso.
- resposta: a resposta pública da empresa, ESPECÍFICA a esta avaliação (cite o que a pessoa disse; nada genérico nem repetido entre avaliações), como o dono responderia, 2 a 4 frases, escrita impecável, no idioma da avaliação. Elogio: agradeça de forma calorosa e pessoal, reforce o que ela elogiou e convide a voltar. Negativa: agradeça o retorno, peça desculpas pelo transtorno sem se defender nem culpar o cliente, diga o que será feito e convide para resolver no WhatsApp ou telefone. GRAVE: resposta curta, calma e neutra, sem admitir culpa nem discutir os fatos, convidando para o contato privado. Nunca exponha dados do cliente, nunca invente fatos, nunca prometa reembolso ou desconto.
Responda em JSON: {"sentimento":"","temas":[],"resumo":"","urgencia":"","precisa_humano":false,"motivo_humano":"","viola_politica":false,"politica":"","como_remover":"","resposta":""}`;

async function analisarUmaAvaliacao(env, marca, a) {
  // Aprende o jeito da empresa: as respostas que ela já deu (inclusive as antigas, trazidas do Google, e as corrigidas pela equipe).
  const anteriores = (await env.DB.prepare("SELECT nota, texto, resposta FROM plt_mk_avaliacoes WHERE marca_id=? AND id<>? AND resposta IS NOT NULL AND TRIM(resposta)<>'' ORDER BY id DESC LIMIT 8").bind(marca.id, a.id).all().catch(() => null))?.results || [];
  const exemplos = anteriores.length ? `\n\nRESPOSTAS QUE A EMPRESA JÁ DEU (aprenda o tom, o tamanho, a forma de tratar e a assinatura; nunca copie frases, cada resposta é única):\n${anteriores.map(x => `- ${x.nota}★ "${String(x.texto || "").slice(0, 160)}" → "${String(x.resposta).slice(0, 400)}"`).join("\n")}` : "";
  const r = await iaJSON(env, INSTRUCOES_AVALIACAO, `${resumoMarca(marca)}${exemplos}\n\nAvaliação de ${a.autor || "Cliente"} — ${a.nota} de 5 estrelas${a.data ? ", em " + a.data : ""}:\n"${a.texto || "(sem texto, só a nota)"}"\nResponda em JSON.`, 900);
  const sent = SENTIMENTOS.includes(String(r.sentimento).toUpperCase()) ? String(r.sentimento).toUpperCase() : (a.nota >= 5 ? "OTIMA" : a.nota >= 4 ? "POSITIVA" : a.nota === 3 ? "NEUTRA" : "NEGATIVA");
  const analise = {
    sentimento: sent, temas: (Array.isArray(r.temas) ? r.temas : []).map(t => String(t).slice(0, 40)).slice(0, 4), resumo: String(r.resumo || "").slice(0, 300),
    urgencia: ["ALTA", "MEDIA", "BAIXA"].includes(String(r.urgencia).toUpperCase()) ? String(r.urgencia).toUpperCase() : (sent === "GRAVE" ? "ALTA" : sent === "NEGATIVA" ? "MEDIA" : "BAIXA"),
    precisa_humano: r.precisa_humano === true || sent === "GRAVE", motivo_humano: String(r.motivo_humano || (sent === "GRAVE" ? "Avaliação grave: uma pessoa da equipe precisa ler e decidir antes de responder." : "")).slice(0, 300),
    viola_politica: r.viola_politica === true, politica: String(r.politica || "").slice(0, 200), como_remover: String(r.como_remover || "").slice(0, 900)
  };
  const resposta = String(r.resposta || "").slice(0, 2000);
  await env.DB.prepare("UPDATE plt_mk_avaliacoes SET analise=?, resposta_sugerida=COALESCE(NULLIF(?,''), resposta_sugerida) WHERE id=?").bind(JSON.stringify(analise), resposta, a.id).run();
  return { analise, resposta };
}

// ---------------------------------------------------------------------------
// Comentários do Instagram e do Facebook: a IA lê o comentário com a publicação e a marca e sugere a resposta.
// ---------------------------------------------------------------------------
const INSTRUCOES_COMENTARIO = `Você é a social media sênior da marca. Leia o comentário deixado numa publicação do Instagram ou do Facebook e escreva a resposta pública da marca.
Regras:
- Responda no mesmo idioma do comentário. Tom humano, caloroso e profissional, como uma pessoa da equipe — nunca robótico. Use o nome (ou @) da pessoa quando fizer sentido.
- Curta: 1 a 3 frases (o comentário é público e rápido). No máximo 1 emoji, e só se combinar com o tom da marca.
- Elogio: agradeça de forma específica (cite o que a pessoa elogiou). Dúvida: responda com o que a marca sabe; se não souber o preço, prazo ou detalhe, convide para o direct ou o WhatsApp, sem inventar.
- Reclamação: reconheça, peça desculpa sem culpar ninguém, e leve para o privado (direct/WhatsApp) para resolver. Nunca discuta em público, nunca exponha dados do cliente.
- Interesse de compra ("quanto custa", "como faço", "tem horário"): responda e conduza para a ação (direct, WhatsApp, link da bio) — é venda.
- Spam, golpe, ofensa, discurso de ódio ou link suspeito: não responda; recomende ocultar (ou apagar, se for golpe).
- Nunca prometa o que a marca não informou, nunca invente preços, nunca peça dados pessoais em público.
Responda em JSON: {"resposta":"texto ou vazio","tipo":"ELOGIO|DUVIDA|INTERESSE|RECLAMACAO|SPAM|OFENSIVO|OUTRO","acao":"RESPONDER|OCULTAR|APAGAR|LEVAR_PARA_PRIVADO","precisa_humano":true|false,"motivo":"uma frase explicando a sugestão"}`;
async function sugerirRespostaComentario(env, orgId, marcaId, canal, c) {
  if (!chave(env)) { const e = new Error("A IA está desligada: falta a chave da OpenAI em Integrações."); e.status = 409; throw e; }
  const marca = await env.DB.prepare("SELECT * FROM plt_mk_marcas WHERE id=? AND org_id=?").bind(Number(marcaId), orgId).first();
  if (!marca) { const e = new Error("Marca não encontrada."); e.status = 404; throw e; }
  const r = await iaJSON(env, INSTRUCOES_COMENTARIO, `${resumoMarca(marca)}\n\nCANAL: ${canal === "instagram" ? "Instagram" : "Facebook"}\nPUBLICAÇÃO: "${c.post || "(sem legenda)"}"\nCOMENTÁRIO de ${c.autor || "uma pessoa"}: "${c.comentario}"\nResponda em JSON.`, 600);
  const TIPOS = ["ELOGIO", "DUVIDA", "INTERESSE", "RECLAMACAO", "SPAM", "OFENSIVO", "OUTRO"], ACOES = ["RESPONDER", "OCULTAR", "APAGAR", "LEVAR_PARA_PRIVADO"];
  return { resposta: String(r.resposta || "").slice(0, 2000), tipo: TIPOS.includes(String(r.tipo).toUpperCase()) ? String(r.tipo).toUpperCase() : "OUTRO", acao: ACOES.includes(String(r.acao).toUpperCase()) ? String(r.acao).toUpperCase() : "RESPONDER", precisa_humano: r.precisa_humano === true, motivo: String(r.motivo || "").slice(0, 300) };
}

// ---------------------------------------------------------------------------
// Triagem das avaliações de 1 e 2 estrelas: separa as que parecem falsas (quem avaliou não está na base de
// clientes, avaliações em sequência, textos repetidos, sem relação com a empresa) e indica o tópico certo de
// denúncia do Google. A denúncia é feita por uma pessoa, uma a uma (o Google não permite denúncia automática).
// ---------------------------------------------------------------------------
export const CATEGORIAS_DENUNCIA = ["Sem relação com o tópico", "Spam", "Conflito de interesses", "Linguagem obscena", "Nociva", "Bullying ou assédio", "Discriminação ou discurso de ódio", "Informações pessoais", "Não foi útil"];
const INSTRUCOES_TRIAGEM = `Você é especialista em políticas de avaliações do Google Perfil da Empresa. Avalie se UMA avaliação negativa tem indícios de ser falsa ou de violar as regras do Google, usando os SINAIS fornecidos. Seja rigorosa e honesta: reclamação de cliente real, mesmo dura ou injusta, NÃO é violação — nesse caso o caminho é responder bem.
Sinais e como pesar:
- "não está na base de clientes": indício forte se o nome é completo; fraco se é só o primeiro nome ou apelido (o nome do Google pode ser diferente do nome usado no WhatsApp).
- várias avaliações negativas no mesmo período curto, textos parecidos ou repetidos, avaliação sem texto em sequência: indício de ataque coordenado.
- texto genérico que não descreve nenhum serviço, data ou situação real; fala de outra empresa ou de assunto fora da experiência; menciona concorrente; ofensas; dados pessoais.
Categorias de denúncia do Google (use exatamente um destes nomes, ou "" se não houver base): ${CATEGORIAS_DENUNCIA.join("; ")}.
- Spam: conta falsa, robô, quem nunca foi cliente, propaganda. Conflito de interesses: concorrente, ex-funcionário, alguém ligado à empresa. Sem relação com o tópico: não fala de uma experiência com a empresa. As demais conforme o nome.
Responda em JSON: {"veredito":"PROVAVEL_FALSA"|"DUVIDOSA"|"PARECE_REAL","categoria":"","evidencias":["frases curtas"],"motivo":"1 frase explicando a decisão","justificativa":"texto curto e factual para usar se o Google pedir mais detalhes ou num pedido de nova análise (sem ofender, sem dados pessoais)"}`;

async function triarAvaliacao(env, marca, a, sinais) {
  const r = await iaJSON(env, INSTRUCOES_TRIAGEM, `${resumoMarca(marca)}\n\nAVALIAÇÃO de "${a.autor || "Cliente"}" — ${a.nota} estrela(s)${a.data ? ", em " + a.data : ""}:\n"${a.texto || "(sem texto, só a nota)"}"${a.resposta ? `\nResposta já dada pela empresa: "${String(a.resposta).slice(0, 300)}"` : ""}\n\nSINAIS:\n${sinais.map(x => "- " + x).join("\n")}\nResponda em JSON.`, 700);
  const veredito = ["PROVAVEL_FALSA", "DUVIDOSA", "PARECE_REAL"].includes(r.veredito) ? r.veredito : "DUVIDOSA";
  return { veredito, categoria: CATEGORIAS_DENUNCIA.includes(r.categoria) ? r.categoria : "", evidencias: (Array.isArray(r.evidencias) ? r.evidencias : []).map(x => String(x).slice(0, 160)).slice(0, 5), motivo: String(r.motivo || "").slice(0, 300), justificativa: String(r.justificativa || "").slice(0, 900), sinais };
}

// Cron: analisa as avaliações ainda não lidas e devolve as que precisam de uma pessoa (para avisar a equipe).
export async function analisarAvaliacoesPendentes(env, orgId, limite = 10, k = null) {
  if (!chave(env)) return { analisadas: 0, alertas: [] };
  await garantir(env);
  const modo = (await env.DB.prepare("SELECT avaliacoes_auto FROM plt_mk_config WHERE org_id=?").bind(orgId).first().catch(() => null))?.avaliacoes_auto || "DESLIGADO";
  let publicadas = 0;
  const lista = (await env.DB.prepare("SELECT a.*, m.nome AS marca_nome FROM plt_mk_avaliacoes a JOIN plt_mk_marcas m ON m.id=a.marca_id WHERE a.org_id=? AND a.analise IS NULL AND a.status='PENDENTE' ORDER BY a.id DESC LIMIT ?").bind(orgId, limite).all())?.results || [];
  const alertas = [];
  for (const a of lista) {
    const marca = await env.DB.prepare("SELECT * FROM plt_mk_marcas WHERE id=?").bind(a.marca_id).first();
    try {
      const { analise, resposta } = await analisarUmaAvaliacao(env, marca, a);
      if (analise.precisa_humano || analise.viola_politica || analise.urgencia === "ALTA") alertas.push({ marca: a.marca_nome, autor: a.autor, nota: a.nota, texto: a.texto, analise });
      else if (k && resposta && podeResponderSozinha(modo, a, analise)) {
        try {
          await responderAvaliacaoGoogle(env, k, a, resposta);
          await env.DB.prepare("UPDATE plt_mk_avaliacoes SET resposta=?, status='RESPONDIDA' WHERE id=?").bind(resposta, a.id).run();
          await env.DB.prepare("INSERT INTO plt_auditoria(org_id,usuario_id,email,acao,detalhe,ip,criado_ms) VALUES(?,?,?,?,?,?,?)").bind(orgId, null, "DENIA (resposta automática)", "MARKETING", `Respondeu no Google a avaliação de ${a.autor} (${a.nota}★)`.slice(0, 400), null, k.agora(env)).run().catch(() => { });
          publicadas++;
        } catch (e) { console.error("resposta automática", a.id, e?.message); }
      }
    } catch (e) { console.error("análise de avaliação", a.id, e?.message); break; }
  }
  // No automático, também saem as que já estavam lidas e esperando (por exemplo, chegaram antes de ligar o automático).
  if (k && modo !== "DESLIGADO") {
    const esperando = (await env.DB.prepare("SELECT * FROM plt_mk_avaliacoes WHERE org_id=? AND status='PENDENTE' AND analise IS NOT NULL AND google_id IS NOT NULL AND resposta_sugerida IS NOT NULL AND TRIM(resposta_sugerida)<>'' ORDER BY id LIMIT 10").bind(orgId).all().catch(() => null))?.results || [];
    for (const a of esperando) {
      let analise = null; try { analise = JSON.parse(a.analise); } catch { analise = null; }
      if (!podeResponderSozinha(modo, a, analise)) continue;
      try {
        await responderAvaliacaoGoogle(env, k, a, a.resposta_sugerida);
        await env.DB.prepare("UPDATE plt_mk_avaliacoes SET resposta=?, status='RESPONDIDA' WHERE id=?").bind(a.resposta_sugerida, a.id).run();
        await env.DB.prepare("INSERT INTO plt_auditoria(org_id,usuario_id,email,acao,detalhe,ip,criado_ms) VALUES(?,?,?,?,?,?,?)").bind(orgId, null, "DENIA (resposta automática)", "MARKETING", `Respondeu no Google a avaliação de ${a.autor} (${a.nota}★)`.slice(0, 400), null, k.agora(env)).run().catch(() => { });
        publicadas++;
      } catch (e) { console.error("resposta automática", a.id, e?.message); }
    }
  }
  return { analisadas: lista.length, alertas, publicadas };
}

// Relatório semanal de especialista (Google Meu Negócio + Instagram/Facebook), por marca.
async function gerarRelatorio(env, k, orgId, marca) {
  const sem = (await env.DB.prepare("SELECT semana, dados FROM plt_mk_metricas WHERE org_id=? AND marca_id=? ORDER BY semana DESC LIMIT 6").bind(orgId, marca.id).all())?.results || [];
  const desde = new Date(k.agora(env) - 30 * 86400000).toISOString().slice(0, 10);
  const av = (await env.DB.prepare("SELECT autor, nota, texto, status, analise, data FROM plt_mk_avaliacoes WHERE org_id=? AND marca_id=? ORDER BY id DESC LIMIT 60").bind(orgId, marca.id).all())?.results || [];
  const media = av.length ? (av.reduce((t, a) => t + Number(a.nota || 0), 0) / av.length).toFixed(1) : "-";
  const recentes = av.filter(a => String(a.data || "") >= desde);
  const pendentes = av.filter(a => a.status === "PENDENTE");
  const alertas = av.map(a => ({ ...a, an: (() => { try { return JSON.parse(a.analise || "null"); } catch { return null; } })() })).filter(a => a.an && (a.an.precisa_humano || a.an.viola_politica) && a.status === "PENDENTE");
  const posts = (await env.DB.prepare("SELECT status, canais, data, titulo FROM plt_mk_posts WHERE org_id=? AND marca_id=? AND data >= ? ORDER BY data").bind(orgId, marca.id, desde).all())?.results || [];
  let vivo = null;
  const conta = await contaGoogleDe(env, orgId, marca.id);
  if (conta) vivo = await desempenhoAoVivo(env, k, conta).catch(() => null);
  const dados = [
    `SEMANAS (mais recente primeiro): ${sem.map(x => `${x.semana}: ${x.dados}`).join(" | ") || "sem dados"}`,
    vivo ? `ÚLTIMOS 30 DIAS NO GOOGLE (${vivo.de} a ${vivo.ate}): ${JSON.stringify(vivo.totais)}. BUSCAS QUE LEVARAM AO PERFIL NO MÊS PASSADO: ${vivo.palavras.map(p => `${p.palavra} (${p.buscas ?? "<" + p.menos_de})`).join("; ") || "nenhuma"}` : "Perfil do Google ainda não conectado.",
    `AVALIAÇÕES: nota média ${media} em ${av.length} avaliações; ${recentes.length} nos últimos 30 dias (${recentes.filter(a => a.nota <= 3).length} com 3 estrelas ou menos); ${pendentes.length} sem resposta; ${alertas.length} precisam de uma pessoa. Recentes: ${recentes.slice(0, 8).map(a => `${a.nota}★ "${String(a.texto || "").slice(0, 120)}"`).join(" / ") || "-"}`,
    `POSTS NOS ÚLTIMOS 30 DIAS E PROGRAMADOS: ${posts.map(p => `${p.data} [${p.status}] ${p.canais} "${p.titulo || ""}"`).join("; ") || "nenhum"}`
  ].join("\n");
  const texto = await iaTexto(env, `${ESPECIALISTA_DIGITAL}
Escreva o RELATÓRIO SEMANAL desta marca para o dono do negócio, em português do Brasil simples, sem jargão, como uma consultora sênior escreveria. Use somente os DADOS; não invente números. Sem markdown, sem asteriscos; títulos em linhas próprias, em maiúsculas.
Seções: RESUMO DA SEMANA (3 frases), O QUE MELHOROU, O QUE PRECISA DE ATENÇÃO (inclua avaliações que precisam de uma pessoa), O QUE AS PESSOAS PESQUISAM (o que isso diz sobre oportunidades), PLANO PARA ESTA SEMANA (5 ações concretas e numeradas; diga quais a DENIA pode fazer sozinha com aprovação — posts, respostas, legendas — e quais dependem da equipe — fotos reais, pedir avaliações, ajustar horários, Google Ads).`,
    [{ papel: "usuario", texto: `${resumoMarca(marca)}\n\nDADOS:\n${dados}` }], 1800);
  const semana = semanaDe(new Date(k.agora(env)).toISOString().slice(0, 10));
  await env.DB.prepare("INSERT OR REPLACE INTO plt_mk_relatorios(org_id,marca_id,semana,texto,criado_ms) VALUES(?,?,?,?,?)").bind(orgId, marca.id, semana, texto.slice(0, 12000), k.agora(env)).run();
  return { semana, texto };
}
// Ao conectar Instagram/Facebook ou Google, a DENIA preenche sozinha o que estiver vazio no perfil:
// logo, segmento, cidade, WhatsApp, site, links e (com a OpenAI) tom de voz, público e diferenciais.
// Nunca apaga nem troca o que a pessoa já escreveu.
async function baixarLogo(url) {
  if (!/^https:\/\//.test(String(url || ""))) return null;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!r || !r.ok) return null;
  const buf = new Uint8Array(await r.arrayBuffer());
  if (!buf.length || buf.length > 1_400_000) return null;
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const dados = btoa(bin), mime = tipoDaImagem(dados);
  return mime ? { dados, mime } : null;
}
export async function preencherMarca(env, orgId, marcaId, d = {}) {
  await garantir(env);
  const marca = await env.DB.prepare("SELECT * FROM plt_mk_marcas WHERE id=? AND org_id=?").bind(Number(marcaId), orgId).first();
  if (!marca) return { preenchidos: [] };
  const vazio = c => !String(marca[c] || "").trim();
  const novos = {};
  for (const c of ["segmento", "cidade", "whatsapp", "site", "instagram", "facebook", "google", "horarios"]) {
    const v = String(d[c] || "").trim().slice(0, 200);
    if (v && vazio(c)) novos[c] = v;
  }
  // Tom de voz, público e diferenciais: a IA escreve a partir da descrição e da bio do perfil.
  const faltaTexto = ["tom", "publico", "diferenciais"].filter(vazio);
  const sobre = String(d.sobre || "").trim().slice(0, 2500);
  if (faltaTexto.length && sobre.length >= 20 && chave(env)) {
    const r = await iaJSON(env, `Você monta o cadastro de uma empresa para uma agência de marketing, a partir do que a própria empresa escreveu nas redes e no Google. Não invente fatos (preços, prêmios, anos de mercado) que não estejam no texto. Português do Brasil, frases curtas. Responda em JSON: {"tom":"(tom de voz, até 12 palavras)","publico":"(quem são os clientes, até 40 palavras)","diferenciais":"(o que a empresa faz melhor, até 50 palavras, só com base no texto)"}`,
      `Empresa: ${marca.nome}${novos.segmento || marca.segmento ? " — " + (novos.segmento || marca.segmento) : ""}${novos.cidade || marca.cidade ? ", " + (novos.cidade || marca.cidade) : ""}\n\nO que a empresa escreve sobre si:\n${sobre}\nResponda em JSON.`, 500).catch(() => null);
    for (const c of faltaTexto) { const v = String(r?.[c] || "").trim().slice(0, c === "tom" ? 200 : 600); if (v) novos[c] = v; }
  }
  const campos = Object.keys(novos);
  if (campos.length) await env.DB.prepare(`UPDATE plt_mk_marcas SET ${campos.map(c => c + "=?").join(",")} WHERE id=? AND org_id=?`).bind(...campos.map(c => novos[c]), marca.id, orgId).run();
  if (!marca.logo_midia_id) {
    for (const url of (d.logos || []).filter(Boolean)) {
      const logo = await baixarLogo(url).catch(() => null);
      if (!logo) continue;
      const n = await env.DB.prepare("INSERT INTO plt_mk_midias(org_id,mime,dados,prompt,criado_ms) VALUES(?,?,?,?,?) RETURNING id").bind(orgId, logo.mime, logo.dados, "logo", typeof env.__agora === "function" ? env.__agora() : Date.now()).first();
      await env.DB.prepare("UPDATE plt_mk_marcas SET logo_midia_id=? WHERE id=? AND org_id=? AND logo_midia_id IS NULL").bind(n.id, marca.id, orgId).run();
      campos.push("logo");
      break;
    }
  }
  return { preenchidos: campos };
}

// Posição no Google Maps de cada palavra-chave, medida sozinha (Places API): ao adicionar, toda semana e no "Medir agora".
// 0 = não aparece entre os 20 primeiros. É a busca "palavra + cidade" sem a localização de quem procura.
async function medirPalavra(env, k, p) {
  const conta = await contaGoogleDe(env, p.org_id, p.marca_id);
  if (!conta) { const e = new Error("Conecte o Google deste perfil para medir a posição."); e.status = 409; throw e; }
  const r = await buscarConcorrentes(env, k, conta, [p.palavra, p.cidade].filter(Boolean).join(" "));
  const semana = semanaDe(new Date(k.agora(env) - 3 * 3600000).toISOString().slice(0, 10));
  await env.DB.prepare("INSERT OR REPLACE INTO plt_mk_posicoes(palavra_id,semana,posicao,criado_ms) VALUES(?,?,?,?)").bind(p.id, semana, r.posicao || 0, k.agora(env)).run();
  return { semana, posicao: r.posicao || 0, total: r.lugares.length };
}
export async function medirPosicoesDaSemana(env, k, orgId, limite = 5) {
  if (!placesConfigurado(env)) return 0;
  await garantir(env);
  const semana = semanaDe(new Date(k.agora(env) - 3 * 3600000).toISOString().slice(0, 10));
  const lista = (await env.DB.prepare(`SELECT p.* FROM plt_mk_palavras p JOIN plt_mk_google g ON g.org_id=p.org_id AND g.marca_id=p.marca_id
    WHERE p.org_id=? AND NOT EXISTS (SELECT 1 FROM plt_mk_posicoes x WHERE x.palavra_id=p.id AND x.semana=?) LIMIT ?`).bind(orgId, semana, limite).all().catch(() => null))?.results || [];
  let n = 0;
  for (const p of lista) { try { await medirPalavra(env, k, p); n++; } catch (e) { console.error("posição", p.id, e?.message); break; } }
  return n;
}
// Cron: toda segunda-feira (a partir das 8h de Brasília), um relatório por marca com perfil do Google conectado.
export async function relatoriosDaSemana(env, k, orgId) {
  if (!chave(env)) return [];
  await garantir(env);
  const local = new Date(k.agora(env) - 3 * 3600000);
  if (local.getUTCDay() !== 1 || local.getUTCHours() < 8) return [];
  const semana = semanaDe(local.toISOString().slice(0, 10));
  const marcas = (await env.DB.prepare(`SELECT m.* FROM plt_mk_marcas m JOIN plt_mk_google g ON g.org_id=m.org_id AND g.marca_id=m.id
    WHERE m.org_id=? AND m.ativa=1 AND NOT EXISTS (SELECT 1 FROM plt_mk_relatorios r WHERE r.org_id=m.org_id AND r.marca_id=m.id AND r.semana=?) LIMIT 2`).bind(orgId, semana).all().catch(() => null))?.results || [];
  const feitos = [];
  for (const m of marcas) { try { feitos.push({ marca: m.nome, ...(await gerarRelatorio(env, k, orgId, m)) }); } catch (e) { console.error("relatório", m.id, e?.message); } }
  return feitos;
}

// Revisão da IA (modo automático): dá nota de 0 a 10 e diz o que melhorar.
async function revisar(env, marca, post) {
  const r = await iaJSON(env, `Você é a diretora de criação de uma agência. Avalie um post antes da publicação: escrita, poder de venda (gancho, benefício específico, chamada com contato real) e respeito às regras. ${REGRAS_CONTEUDO}
${COPY_QUE_VENDE}
Responda em JSON: {"nota":0,"aprovado":false,"comentario":""} — nota de 0 a 10; aprovado=true só se estiver pronto para publicar sem nenhum ajuste; comentario em 1 ou 2 frases.`,
  `${resumoMarca(marca)}\n\nPOST (${post.formato}, canais ${post.canais.join(", ")}):\nTítulo: ${post.titulo || "-"}\nLegenda: ${post.legenda || "-"}\nHashtags: ${post.hashtags || "-"}\nChamada: ${post.chamada || "-"}\nTexto escrito na arte: ${post.texto_arte || "-"}\nIdeia da imagem: ${post.ideia_imagem || "-"}`, 400);
  return { nota: Math.max(0, Math.min(10, Math.round(Number(r?.nota) || 0))), aprovado: r?.aprovado === true, comentario: String(r?.comentario || "").slice(0, 400) };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export async function apiMarketing(request, env, k, orgId, papel, resto) {
  const { json, lerCorpo, txt, pode, agora, auditar, sessao } = k;
  await garantir(env);
  // Cada chamada externa desta rota conta no recurso (ex.: "avaliacoes/triagem") na página Consumo.
  env = comRecurso(env, resto.split("/").filter(x => x && !/^\d+$/.test(x)).slice(0, 2).join("/"));
  const doUso = await rotasUso(request, env, k, orgId, papel, resto, { central: Boolean(k.central) });
  if (doUso) return doUso;
  const doSocial = await rotasSocial(request, env, k, orgId, papel, resto, { sugerir: (marcaId, canal, c) => sugerirRespostaComentario(env, orgId, marcaId, canal, c) });
  if (doSocial) return doSocial;
  const daVoz = await rotasVoz(request, env, k, orgId, papel, resto);
  if (daVoz) return daVoz;
  const daMeta = await rotasMeta(request, env, k, orgId, papel, resto);
  if (daMeta) return daMeta;
  // "Buscar avaliações agora": traz do Google, lê e (no automático) responde na hora — sem esperar a rodada de 10 minutos.
  if (resto === "google/agora" && request.method === "POST") {
    if (!pode(papel, "AGENTE")) return json({ erro: "Seu perfil não tem permissão para esta ação." }, 403);
    const { corpo, erro } = await lerCorpo(request, 1000);
    if (erro) return erro;
    const conta = await contaGoogleDe(env, orgId, Number(corpo.marca_id));
    if (!conta) return json({ erro: "Esta marca ainda não está conectada ao Google (Contas conectadas → Conectar Google)." }, 409);
    let sinc;
    try { sinc = await sincronizarConta(env, k, conta, { forcarDesempenho: false, completa: false }); }
    catch (e) {
      await env.DB.prepare("UPDATE plt_mk_google SET erro=? WHERE id=?").bind(String(e?.message || e).slice(0, 400), conta.id).run();
      return json({ erro: "O Google recusou a busca: " + e.message }, 502);
    }
    if (!chave(env)) return json({ ok: true, ...sinc, analisadas: 0, publicadas: 0, aviso: "As avaliações chegaram, mas a DENIA não consegue lê-las: falta a chave da OpenAI (Integrações)." });
    const r = await analisarAvaliacoesPendentes(env, orgId, 10, k);
    return json({ ok: true, ...sinc, analisadas: r.analisadas, publicadas: r.publicadas || 0, precisam_de_voce: r.alertas.length });
  }
  const doGoogle = await rotasGoogle(request, env, k, orgId, papel, resto);
  if (doGoogle) return doGoogle;
  const metodo = request.method;
  const autor = sessao.usuario.nome || sessao.usuario.email;
  const corpoOu = async (limite) => { const l = await lerCorpo(request, limite); if (l.erro) throw Object.assign(new Error("corpo"), { resposta: l.erro }); return l.corpo; };
  const marcaDa = async (id) => env.DB.prepare("SELECT * FROM plt_mk_marcas WHERE id=? AND org_id=?").bind(Number(id), orgId).first();
  const exigir = (min) => { if (!pode(papel, min)) throw Object.assign(new Error("perm"), { resposta: json({ erro: "Seu perfil não tem permissão para esta ação." }, 403) }); };
  let m;
  try {
    // ----- Relatório geral de marketing: Google, Instagram e Facebook de todos os perfis num período (tela e planilha).
    // ----- Rotina do especialista: o que fazer hoje, nesta semana e neste mês em cada canal, com a situação real.
    if (resto === "rotina" && metodo === "GET") {
      const t = agora(env), d7 = t - 7 * 86400000, d30 = t - 30 * 86400000, hoje = new Date(t - 3 * 3600000).toISOString().slice(0, 10);
      const semana = semanaDe(hoje);
      const um = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).first().catch(() => null)) || {};
      const lista = (await env.DB.prepare("SELECT id, nome FROM plt_mk_marcas WHERE org_id=? AND ativa=1 ORDER BY nome").bind(orgId).all())?.results || [];
      const google = new Set(((await env.DB.prepare("SELECT marca_id FROM plt_mk_google WHERE org_id=?").bind(orgId).all().catch(() => null))?.results || []).map(x => x.marca_id));
      const meta = new Map(((await env.DB.prepare("SELECT marca_id, ig_id FROM plt_mk_contas WHERE org_id=?").bind(orgId).all().catch(() => null))?.results || []).map(x => [x.marca_id, x]));
      const cfg = await um("SELECT avaliacoes_auto FROM plt_mk_config WHERE org_id=?", orgId);
      const perfis = [];
      for (const m of lista) {
        const r = { marca_id: m.id, nome: m.nome, google: google.has(m.id), instagram: Boolean(meta.get(m.id)?.ig_id), facebook: meta.has(m.id) };
        if (r.google) {
          r.g = {
            sem_resposta: Number((await um("SELECT COUNT(*) n FROM plt_mk_avaliacoes WHERE org_id=? AND marca_id=? AND google_id IS NOT NULL AND status='PENDENTE' AND removida_ms IS NULL", orgId, m.id)).n || 0),
            ruins_sem_resposta: Number((await um("SELECT COUNT(*) n FROM plt_mk_avaliacoes WHERE org_id=? AND marca_id=? AND google_id IS NOT NULL AND status='PENDENTE' AND removida_ms IS NULL AND nota<=3", orgId, m.id)).n || 0),
            posts_7d: Number((await um("SELECT COUNT(*) n FROM plt_mk_posts WHERE org_id=? AND marca_id=? AND canais LIKE '%google%' AND status='PUBLICADO' AND atualizado_ms>=?", orgId, m.id, d7)).n || 0),
            programados: Number((await um("SELECT COUNT(*) n FROM plt_mk_posts WHERE org_id=? AND marca_id=? AND canais LIKE '%google%' AND status='APROVADO' AND data>=?", orgId, m.id, hoje)).n || 0),
            palavras: Number((await um("SELECT COUNT(*) n FROM plt_mk_palavras WHERE org_id=? AND marca_id=?", orgId, m.id)).n || 0),
            avaliacoes_30d: Number((await um("SELECT COUNT(*) n FROM plt_mk_avaliacoes WHERE org_id=? AND marca_id=? AND google_id IS NOT NULL AND criado_ms>=?", orgId, m.id, d30)).n || 0)
          };
        }
        for (const c of ["instagram", "facebook"]) if (r[c]) {
          const cache = await um("SELECT valor FROM plt_meta WHERE chave=?", `analise_${orgId}_${m.id}_${c}`);
          let em = null; try { em = JSON.parse(cache.valor || "null")?.em || null; } catch { em = null; }
          r[c[0]] = {
            posts_7d: Number((await um(`SELECT COUNT(*) n FROM plt_mk_posts WHERE org_id=? AND marca_id=? AND canais LIKE '%${c}%' AND status='PUBLICADO' AND atualizado_ms>=?`, orgId, m.id, d7)).n || 0),
            programados_7d: Number((await um(`SELECT COUNT(*) n FROM plt_mk_posts WHERE org_id=? AND marca_id=? AND canais LIKE '%${c}%' AND status='APROVADO' AND data>=? AND data<=?`, orgId, m.id, hoje, new Date(t + 7 * 86400000).toISOString().slice(0, 10))).n || 0),
            aguardando: Number((await um(`SELECT COUNT(*) n FROM plt_mk_posts WHERE org_id=? AND marca_id=? AND canais LIKE '%${c}%' AND status='AGUARDANDO'`, orgId, m.id)).n || 0),
            analise_em: em
          };
        }
        perfis.push(r);
      }
      return json({ semana, modo_avaliacoes: cfg.avaliacoes_auto || "DESLIGADO", perfis });
    }
    if (resto === "relatorio-marketing" && metodo === "GET") {
      const q = new URL(request.url).searchParams;
      const dias = [7, 30, 90].includes(Number(q.get("dias"))) ? Number(q.get("dias")) : 30;
      const chaveC = `relmk_${orgId}_${dias}`;
      let d = null;
      if (q.get("atualizar") !== "1") { try { const c = JSON.parse((await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind(chaveC).first())?.valor || "null"); if (c && agora(env) - c.em < 3 * 3600000) d = c; } catch { d = null; } }
      if (!d) {
        const lista = (await env.DB.prepare("SELECT * FROM plt_mk_marcas WHERE org_id=? AND ativa=1 ORDER BY nome").bind(orgId).all())?.results || [];
        const contasMeta = new Map(((await env.DB.prepare("SELECT marca_id, ig_id FROM plt_mk_contas WHERE org_id=?").bind(orgId).all().catch(() => null))?.results || []).map(x => [x.marca_id, x]));
        const desde = agora(env) - dias * 86400000;
        const perfis = [];
        for (const m of lista) {
          const g = await contaGoogleDe(env, orgId, m.id).catch(() => null), meta = contasMeta.get(m.id);
          const tentar = async f => { try { return await f(); } catch (e) { return { erro: String(e?.message || e).slice(0, 160) }; } };
          const [google, instagram, facebook] = await Promise.all([
            g ? tentar(() => desempenhoDosDias(env, k, g, dias)) : null,
            meta?.ig_id ? tentar(() => resumoSocial(env, k, orgId, m.id, "instagram", dias)) : null,
            meta ? tentar(() => resumoSocial(env, k, orgId, m.id, "facebook", dias)) : null]);
          const av = g ? await env.DB.prepare("SELECT COUNT(*) n, AVG(nota) media, SUM(CASE WHEN status='PENDENTE' THEN 1 ELSE 0 END) sem FROM plt_mk_avaliacoes WHERE org_id=? AND marca_id=? AND google_id IS NOT NULL AND removida_ms IS NULL AND criado_ms>=?").bind(orgId, m.id, desde).first().catch(() => null) : null;
          const pub = await env.DB.prepare("SELECT COUNT(*) n FROM plt_mk_posts WHERE org_id=? AND marca_id=? AND status='PUBLICADO' AND atualizado_ms>=?").bind(orgId, m.id, desde).first().catch(() => null);
          perfis.push({ marca_id: m.id, nome: m.nome, google: google && { ...google, nota: g.media_google ?? null, total_avaliacoes: g.total_google ?? null, avaliacoes_novas: Number(av?.n || 0), nota_novas: av?.media ? Math.round(av.media * 10) / 10 : null, sem_resposta: Number(av?.sem || 0) }, instagram, facebook, posts_denia: Number(pub?.n || 0) });
        }
        d = { em: agora(env), dias, perfis };
        await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind(chaveC, JSON.stringify(d)).run().catch(() => {});
      }
      if (q.get("formato") !== "xlsx") return json(d);
      const n = v => typeof v === "number" ? v : v == null ? "" : v;
      const dataBr = s2 => s2 ? s2.split("-").reverse().join("/") : "";
      const per = d.perfis.find(p => p.google && !p.google.erro)?.google || d.perfis.find(p => p.instagram && !p.instagram.erro)?.instagram;
      const abas = [
        { nome: "Resumo", larguras: [28, 16, 16, 16, 16, 16, 16], linhas: [["Perfil", "Google: visualizações", "Google: ligações + rotas + site", "Google: avaliações novas", "Instagram: alcance", "Facebook: alcance", "Posts pela DENIA"],
          ...d.perfis.map(p => [p.nome, n(p.google?.totais?.visualizacoes), p.google?.totais ? (p.google.totais.ligacoes || 0) + (p.google.totais.rotas || 0) + (p.google.totais.cliques_site || 0) : "", n(p.google?.avaliacoes_novas), n(p.instagram?.alcance), n(p.facebook?.alcance), p.posts_denia]),
          [], [`Período: últimos ${d.dias} dias${per ? ` (${dataBr(per.de)} a ${dataBr(per.ate)})` : ""}. O Google libera os números com 3 a 5 dias de atraso.`]] },
        { nome: "Google", larguras: [28, 14, 12, 12, 12, 12, 12, 12, 12, 12, 12], linhas: [["Perfil", "Visualizações", "Na Pesquisa", "No Maps", "Ligações", "Rotas", "Cliques no site", "Mensagens", "Avaliações novas", "Nota geral", "Sem resposta"],
          ...d.perfis.filter(p => p.google).map(p => p.google.erro ? [p.nome, "Erro: " + p.google.erro] : [p.nome, n(p.google.totais.visualizacoes), n(p.google.totais.buscas), n(p.google.totais.maps), n(p.google.totais.ligacoes), n(p.google.totais.rotas), n(p.google.totais.cliques_site), n(p.google.totais.mensagens), p.google.avaliacoes_novas, n(p.google.nota), p.google.sem_resposta])] },
        ...["instagram", "facebook"].map(c => ({ nome: c === "instagram" ? "Instagram" : "Facebook", larguras: [28, 12, 12, 14, 12, 14, 14, 12, 10], linhas: [["Perfil", "Seguidores", "Alcance", "Visualizações", "Interações", "Novos seguidores", "Deixaram de seguir", "Visitas ao perfil", "Posts"],
          ...d.perfis.filter(p => p[c]).map(p => p[c].erro ? [p.nome, "Erro: " + p[c].erro] : [p.nome, n(p[c].seguidores), n(p[c].alcance), n(p[c].visualizacoes), n(p[c].interacoes), n(p[c].novos_seguidores), n(p[c].deixaram_de_seguir), n(p[c].visitas_perfil), n(p[c].posts)])] }))
      ];
      const bytes = gerarXlsx(abas);
      let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return json({ nome: `relatorio-marketing-${d.dias}-dias.xlsx`, base64: btoa(bin) });
    }
    // ----- Google: descrição do perfil escrita pela IA (regras do Google: até 750 letras, sem link, sem telefone, sem exagero)
    if (resto === "google/descricao-ia" && metodo === "POST") {
      exigir("ADMIN");
      const c = await corpoOu(4000);
      const marca = await marcaDa(c.marca_id);
      if (!marca) return json({ erro: "Escolha o perfil." }, 400);
      if (!chave(env)) return json({ erro: "A IA está desligada: falta a chave da OpenAI em Integrações." }, 409);
      const palavras = ((await env.DB.prepare("SELECT palavra FROM plt_mk_palavras WHERE org_id=? AND marca_id=? LIMIT 10").bind(orgId, marca.id).all().catch(() => null))?.results || []).map(x => x.palavra);
      const r = await iaJSON(env, `Você é especialista em Perfil da Empresa no Google (Google Meu Negócio) e escreve a descrição do perfil.
Regras do Google (obrigatórias): até 750 caracteres; sem links; sem telefone; sem preços ou promoções; sem CAIXA ALTA nem exagero ("o melhor do Brasil"); só fatos que estão nos dados.
Para aparecer nas buscas: comece pelo que a empresa faz e onde (cidade/bairros) nas primeiras 250 letras; use de forma natural os serviços e as palavras-chave; diga para quem é e o diferencial; termine com um convite simples. Português do Brasil, 2 a 4 frases.
Responda em JSON: {"descricao":"","por_que":"(uma frase dizendo o que melhorou)"}`,
        `${resumoMarca(marca)}\nCategoria no Google: ${txt(c.categoria, 80) || "-"}\nPalavras-chave acompanhadas: ${palavras.join(", ") || "-"}\nDescrição atual: ${txt(c.atual, 800) || "(vazia)"}\nResponda em JSON.`, 900);
      const d = String(r?.descricao || "").replace(/https?:\/\/\S+|www\.\S+/gi, "").replace(/\s+/g, " ").trim().slice(0, 750);
      if (!d) return json({ erro: "A IA não conseguiu escrever agora. Tente de novo." }, 502);
      return json({ descricao: d, por_que: txt(r?.por_que, 200) });
    }
    // ----- Marcas
    if (resto === "marcas" && metodo === "GET") {
      const r = await env.DB.prepare("SELECT * FROM plt_mk_marcas WHERE org_id=? AND ativa=1 ORDER BY nome").bind(orgId).all();
      return json({ marcas: r?.results || [] });
    }
    if (resto === "marcas" && metodo === "POST") {
      exigir("ADMIN");
      const c = await corpoOu(8000);
      const campos = ["nome", "segmento", "cidade", "instagram", "facebook", "google", "site", "whatsapp", "tom", "publico", "cores", "diferenciais", "idioma", "horarios", "ofertas"];
      const v = Object.fromEntries(campos.map(x => [x, txt(c[x], x === "ofertas" ? 1500 : x === "diferenciais" || x === "publico" ? 600 : 200)]));
      v.idioma = idiomaDe(c.idioma);
      v.instagram = v.instagram.replace(/^@+/, "").replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/\/.*$/, "");
      if (v.nome.length < 2) return json({ erro: "Informe o nome da marca." }, 400);
      if (c.id) {
        if (!(await marcaDa(c.id))) return json({ erro: "Marca não encontrada." }, 404);
        await env.DB.prepare(`UPDATE plt_mk_marcas SET ${campos.map(x => x + "=?").join(",")} WHERE id=? AND org_id=?`).bind(...campos.map(x => v[x] || null), Number(c.id), orgId).run();
        await auditar(env, request, sessao, orgId, "MARKETING", `Atualizou a marca ${v.nome}`);
        return json({ ok: true, id: Number(c.id) });
      }
      const n = await env.DB.prepare(`INSERT INTO plt_mk_marcas(org_id,${campos.join(",")},ativa,criado_ms) VALUES(?,${campos.map(() => "?").join(",")},1,?) RETURNING id`).bind(orgId, ...campos.map(x => v[x] || null), agora(env)).first();
      await auditar(env, request, sessao, orgId, "MARKETING", `Criou a marca ${v.nome}`);
      return json({ ok: true, id: n.id });
    }
    // Logo oficial da marca: vai junto para a IA em toda arte, para sair a logo verdadeira (nunca uma inventada).
    if ((m = resto.match(/^marcas\/(\d{1,12})\/logo$/)) && metodo === "POST") {
      exigir("ADMIN");
      const marca = await marcaDa(m[1]);
      if (!marca) return json({ erro: "Marca não encontrada." }, 404);
      const c = await corpoOu(LIMITE_LOGO_B64 + 2000);
      const antiga = marca.logo_midia_id;
      if (c.remover) {
        await env.DB.prepare("UPDATE plt_mk_marcas SET logo_midia_id=NULL WHERE id=?").bind(marca.id).run();
      } else {
        const dados = String(c.dados || "").replace(/^data:[^,]*,/, "");
        const mime = tipoDaImagem(dados);
        if (!mime) return json({ erro: "Envie a logo em PNG, JPG ou WEBP." }, 400);
        const n = await env.DB.prepare("INSERT INTO plt_mk_midias(org_id,mime,dados,prompt,criado_ms) VALUES(?,?,?,?,?) RETURNING id").bind(orgId, mime, dados, "logo", agora(env)).first();
        await env.DB.prepare("UPDATE plt_mk_marcas SET logo_midia_id=? WHERE id=?").bind(n.id, marca.id).run();
      }
      if (antiga) await env.DB.prepare("DELETE FROM plt_mk_midias WHERE id=? AND org_id=?").bind(antiga, orgId).run();
      await auditar(env, request, sessao, orgId, "MARKETING", `${c.remover ? "Removeu" : "Enviou"} a logo da marca ${marca.nome}`);
      return json({ ok: true });
    }
    if ((m = resto.match(/^marcas\/(\d{1,12})\/remover$/)) && metodo === "POST") {
      exigir("ADMIN");
      await env.DB.prepare("UPDATE plt_mk_marcas SET ativa=0 WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).run();
      return json({ ok: true });
    }

    // ----- Configuração (modo de aprovação)
    if (resto === "config" && metodo === "GET") {
      const c = await env.DB.prepare("SELECT * FROM plt_mk_config WHERE org_id=?").bind(orgId).first();
      return json({ modo: c?.modo || "HUMANO", posts_semana: c?.posts_semana || 3, nota_minima: c?.nota_minima || 8, avaliacoes_auto: MODOS_AVALIACAO.includes(c?.avaliacoes_auto) ? c.avaliacoes_auto : "DESLIGADO", ia_ligada: Boolean(chave(env)) });
    }
    if (resto === "config" && metodo === "POST") {
      exigir("ADMIN");
      const c = await corpoOu(2000);
      const modo = c.modo === "AUTOMATICO" ? "AUTOMATICO" : "HUMANO";
      const ps = Math.max(1, Math.min(14, Math.round(Number(c.posts_semana) || 3)));
      const nota = Math.max(5, Math.min(10, Math.round(Number(c.nota_minima) || 8)));
      await env.DB.prepare("INSERT OR REPLACE INTO plt_mk_config(org_id,modo,posts_semana,nota_minima,atualizado_ms) VALUES(?,?,?,?,?)").bind(orgId, modo, ps, nota, agora(env)).run();
      await auditar(env, request, sessao, orgId, "MARKETING", `Aprovação de artes: ${modo === "AUTOMATICO" ? `automática (nota mínima ${nota})` : "por uma pessoa"} · ${ps} posts por semana`);
      return json({ ok: true });
    }

    // Avaliações do Google: uma pessoa aprova, ou a DENIA responde sozinha (as boas, ou todas menos as graves).
    if (resto === "config/avaliacoes" && metodo === "POST") {
      exigir("ADMIN");
      const c = await corpoOu(500);
      const modo = MODOS_AVALIACAO.includes(c.modo) ? c.modo : "DESLIGADO";
      await env.DB.prepare("INSERT INTO plt_mk_config(org_id,avaliacoes_auto,atualizado_ms) VALUES(?,?,?) ON CONFLICT(org_id) DO UPDATE SET avaliacoes_auto=excluded.avaliacoes_auto, atualizado_ms=excluded.atualizado_ms").bind(orgId, modo, agora(env)).run();
      await auditar(env, request, sessao, orgId, "MARKETING", `Respostas das avaliações do Google: ${({ DESLIGADO: "uma pessoa aprova", BOAS: "automáticas para 4 e 5 estrelas", TODAS: "automáticas, menos as graves" })[modo]}`);
      return json({ ok: true, avaliacoes_auto: modo });
    }

    // ----- Posts
    if (resto === "posts" && metodo === "GET") {
      const q = new URL(request.url).searchParams;
      const de = dataISO(q.get("de")) || "0000-01-01", ate = dataISO(q.get("ate")) || "9999-12-31";
      const marca = Number(q.get("marca") || 0), st = String(q.get("status") || "").toUpperCase(), canal = String(q.get("canal") || "");
      let sql = "SELECT p.*, (SELECT CASE WHEN m.arquivo IS NOT NULL THEN 1 ELSE 0 END FROM plt_mk_midias m WHERE m.id=p.midia_id) midia_video FROM plt_mk_posts p WHERE org_id=? AND (data IS NULL OR (data>=? AND data<=?))";
      const args = [orgId, de, ate];
      if (marca) { sql += " AND marca_id=?"; args.push(marca); }
      if (STATUS_POST.includes(st)) { sql += " AND status=?"; args.push(st); }
      if (CANAIS.includes(canal)) { sql += " AND canais LIKE ?"; args.push(`%"${canal}"%`); }
      const r = await env.DB.prepare(sql + " ORDER BY data, hora, id LIMIT 400").bind(...args).all();
      return json({ posts: (r?.results || []).map(linhaPost) });
    }
    if (resto === "posts" && metodo === "POST") {
      exigir("AGENTE");
      const c = await corpoOu(20000);
      const marca = await marcaDa(c.marca_id);
      if (!marca) return json({ erro: "Escolha a marca do post." }, 400);
      const v = { canais: JSON.stringify(canaisOk(c.canais)), formato: FORMATOS.includes(c.formato) ? c.formato : "post", data: dataISO(c.data) || null, hora: horaOk(c.hora) || null,
        titulo: txt(c.titulo, 200), legenda: txt(c.legenda, 2200), hashtags: txt(c.hashtags, 600), chamada: txt(c.chamada, 200), ideia_imagem: txt(c.ideia_imagem, 1000), texto_arte: txt(c.texto_arte, 80) };
      if (c.id) {
        const p = await env.DB.prepare("SELECT * FROM plt_mk_posts WHERE id=? AND org_id=?").bind(Number(c.id), orgId).first();
        if (!p) return json({ erro: "Post não encontrado." }, 404);
        if (p.status === "PUBLICADO") return json({ erro: "Este post já foi publicado." }, 409);
        // Editar um post aprovado devolve ele para aprovação.
        const status = p.status === "APROVADO" && !pode(papel, "ADMIN") ? "AGUARDANDO" : p.status;
        await env.DB.prepare("UPDATE plt_mk_posts SET marca_id=?, canais=?, formato=?, data=?, hora=?, titulo=?, legenda=?, hashtags=?, chamada=?, ideia_imagem=?, texto_arte=?, status=?, atualizado_ms=? WHERE id=? AND org_id=?")
          .bind(marca.id, v.canais, v.formato, v.data, v.hora, v.titulo, v.legenda, v.hashtags, v.chamada, v.ideia_imagem, v.texto_arte || null, status, agora(env), Number(c.id), orgId).run();
        await gravarBotao(env, Number(c.id), c);
        return json({ ok: true, id: Number(c.id) });
      }
      const n = await env.DB.prepare(`INSERT INTO plt_mk_posts(org_id,marca_id,canais,formato,data,hora,titulo,legenda,hashtags,chamada,ideia_imagem,texto_arte,status,criado_por,criado_ms,atualizado_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'RASCUNHO',?,?,?) RETURNING id`).bind(orgId, marca.id, v.canais, v.formato, v.data, v.hora, v.titulo, v.legenda, v.hashtags, v.chamada, v.ideia_imagem, v.texto_arte || null, autor, agora(env), agora(env)).first();
      // Imagem criada antes, fora de um post (Criar imagem com IA): passa a ser a arte do novo post.
      if (c.midia_id) {
        const md = await env.DB.prepare("SELECT id FROM plt_mk_midias WHERE id=? AND org_id=?").bind(Number(c.midia_id), orgId).first();
        if (md) await env.DB.prepare("UPDATE plt_mk_posts SET midia_id=? WHERE id=?").bind(md.id, n.id).run();
      }
      await gravarBotao(env, n.id, c);
      return json({ ok: true, id: n.id });
    }
    if ((m = resto.match(/^posts\/(\d{1,12})\/acao$/)) && metodo === "POST") {
      const c = await corpoOu(4000);
      const p = await env.DB.prepare("SELECT * FROM plt_mk_posts WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).first();
      if (!p) return json({ erro: "Post não encontrado." }, 404);
      const acao = String(c.acao || "");
      const mudar = async (status, extra = {}) => {
        await env.DB.prepare("UPDATE plt_mk_posts SET status=?, comentario=COALESCE(?,comentario), aprovado_por=COALESCE(?,aprovado_por), atualizado_ms=? WHERE id=?").bind(status, extra.comentario ?? null, extra.aprovado_por ?? null, agora(env), p.id).run();
        await auditar(env, request, sessao, orgId, "MARKETING", `Post #${p.id}: ${status.toLowerCase()}${extra.comentario ? " — " + extra.comentario : ""}`);
        return json({ ok: true, status });
      };
      if (acao === "enviar") { exigir("AGENTE"); return mudar("AGUARDANDO"); }
      if (acao === "aprovar") {
        exigir("ADMIN");
        await mudar("APROVADO", { aprovado_por: autor });
        const r = await aoAprovar(request, env, k, p);
        await auditar(env, request, sessao, orgId, "MARKETING", `Post #${p.id}: ${r.resumo}`.slice(0, 400));
        return json({ ok: true, status: r.publicado ? "PUBLICADO" : "APROVADO", publicado: r.publicado, resumo: r.resumo });
      }
      if (acao === "rejeitar") { exigir("ADMIN"); return mudar("REJEITADO", { comentario: txt(c.comentario, 400) || "Rejeitado" }); }
      if (acao === "publicado") { exigir("AGENTE"); if (p.status !== "APROVADO") return json({ erro: "Só posts aprovados podem ser marcados como publicados." }, 409); return mudar("PUBLICADO"); }
      if (acao === "rascunho") { exigir("AGENTE"); return mudar("RASCUNHO"); }
      if (acao === "excluir") {
        exigir("ADMIN");
        const vid = p.midia_id ? await env.DB.prepare("SELECT arquivo, capa_id FROM plt_mk_midias WHERE id=? AND org_id=?").bind(p.midia_id, orgId).first() : null;
        await env.DB.batch([env.DB.prepare("DELETE FROM plt_mk_posts WHERE id=?").bind(p.id), env.DB.prepare("DELETE FROM plt_mk_midias WHERE id=? AND org_id=?").bind(p.midia_id || 0, orgId), env.DB.prepare("DELETE FROM plt_mk_midias WHERE id=? AND org_id=?").bind(vid?.capa_id || 0, orgId)]);
        if (vid?.arquivo && env.ARQUIVOS) await env.ARQUIVOS.delete(vid.arquivo).catch(() => {});
        return json({ ok: true });
      }
      if (acao === "revisar") {
        exigir("AGENTE");
        if (!chave(env)) { const s = semChave(); return json(s.corpo, s.status); }
        const marca = await marcaDa(p.marca_id);
        const rv = await revisar(env, marca, linhaPost(p));
        await env.DB.prepare("UPDATE plt_mk_posts SET revisao=?, atualizado_ms=? WHERE id=?").bind(JSON.stringify(rv), agora(env), p.id).run();
        return json({ ok: true, revisao: rv });
      }
      return json({ erro: "Ação inválida." }, 400);
    }

    // ----- Imagens
    // Envio de vídeo: o arquivo vem cru no corpo (sem base64) e vai direto para o disco, sem passar pelo banco.
    if (resto === "videos/enviar" && metodo === "POST") {
      exigir("AGENTE");
      if (!env.ARQUIVOS) return json({ erro: "O envio de vídeos funciona no servidor da DENIA (Hostinger). Este ambiente não guarda arquivos grandes." }, 503);
      const q = new URL(request.url).searchParams;
      const marca = await marcaDa(q.get("marca"));
      if (!marca) return json({ erro: "Escolha a empresa." }, 400);
      const mime = String(request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!["video/mp4", "video/quicktime", "video/x-m4v"].includes(mime)) return json({ erro: "Envie o vídeo em MP4 ou MOV (o formato do celular)." }, 400);
      const tam = Number(request.headers.get("content-length") || 0);
      if (tam > LIMITE_VIDEO) return json({ erro: "O vídeo passa de 300 MB. Corte ou envie numa qualidade menor." }, 413);
      if (!request.body) return json({ erro: "Vídeo vazio." }, 400);
      const chaveArq = `videos/${orgId}/${crypto.randomUUID()}.${extDoMime(mime)}`;
      let gravado;
      try { gravado = await env.ARQUIVOS.put(chaveArq, request.body, { limite: LIMITE_VIDEO }); }
      catch (e) { return json({ erro: e.grande ? "O vídeo passa de 300 MB. Corte ou envie numa qualidade menor." : "Não consegui guardar o vídeo. Tente de novo." }, e.grande ? 413 : 500); }
      if (!gravado.tamanho) { await env.ARQUIVOS.delete(chaveArq).catch(() => {}); return json({ erro: "Vídeo vazio." }, 400); }
      const nomeIni = await nomeUnico(env, orgId, slugSeo(String(q.get("nome") || "video").replace(/\.[a-z0-9]{2,4}$/i, "")));
      const n = await env.DB.prepare("INSERT INTO plt_mk_midias(org_id,mime,dados,prompt,criado_ms,marca_id,nome_arquivo,origem,enviado_por,arquivo,tamanho,duracao) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id")
        .bind(orgId, mime === "video/x-m4v" ? "video/mp4" : mime, "", "video enviado", agora(env), marca.id, nomeIni, "video", autor, chaveArq, gravado.tamanho, Number(q.get("duracao")) || null).first();
      return json({ ok: true, id: n.id, tamanho: gravado.tamanho });
    }
    if ((m = resto.match(/^midias\/(\d{1,12})$/)) && metodo === "GET") {
      const qm = new URL(request.url).searchParams;
      let r = await env.DB.prepare("SELECT mime, dados, nome_arquivo, arquivo, capa_id FROM plt_mk_midias WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).first();
      if (!r) return new Response("Não encontrado.", { status: 404 });
      if (r.arquivo && qm.get("capa")) {
        r = r.capa_id ? await env.DB.prepare("SELECT mime, dados, nome_arquivo, arquivo FROM plt_mk_midias WHERE id=? AND org_id=?").bind(r.capa_id, orgId).first() : null;
        if (!r) return new Response("Sem capa.", { status: 404 });
      }
      if (r.arquivo) return servirArquivo(env, request, r, Boolean(qm.get("baixar")));
      const bin = Uint8Array.from(atob(r.dados), ch => ch.charCodeAt(0));
      const ext = r.mime === "image/png" ? "png" : r.mime === "image/webp" ? "webp" : "jpg";
      const cab = { "content-type": r.mime, "cache-control": "private, max-age=86400" };
      if (new URL(request.url).searchParams.get("baixar")) cab["content-disposition"] = `attachment; filename="${(r.nome_arquivo || "denia-" + m[1]).replace(/[^a-z0-9-]/gi, "")}.${ext}"`;
      return new Response(bin, { headers: cab });
    }
    // Biblioteca: todas as fotos e artes de cada empresa — quem subiu, quando, nome, descrição e onde foram usadas.
    if (resto === "midias" && metodo === "GET") {
      const q = new URL(request.url).searchParams, marca = Number(q.get("marca")) || 0, origem = String(q.get("origem") || "");
      const onde = ["m.org_id=?", "COALESCE(m.origem,'') NOT IN ('foto-original','capa')"], args = [orgId];
      if (marca) { onde.push("COALESCE(m.marca_id, (SELECT p.marca_id FROM plt_mk_posts p WHERE p.midia_id=m.id LIMIT 1))=?"); args.push(marca); }
      if (origem) { onde.push("COALESCE(m.origem, CASE WHEN m.prompt='logo' THEN 'logo' WHEN m.prompt='foto google' THEN 'foto-google' ELSE 'ia' END)=?"); args.push(origem); }
      const r = await env.DB.prepare(`SELECT m.id, m.mime, m.criado_ms, m.nome_arquivo, m.descricao, m.enviado_por, m.google_id, m.original_id, COALESCE(m.tamanho, LENGTH(m.dados) * 3 / 4) tam, m.arquivo IS NOT NULL video, m.capa_id, m.duracao,
          COALESCE(m.origem, CASE WHEN m.prompt='logo' THEN 'logo' WHEN m.prompt='foto google' THEN 'foto-google' ELSE 'ia' END) origem,
          COALESCE(m.marca_id, (SELECT p.marca_id FROM plt_mk_posts p WHERE p.midia_id=m.id LIMIT 1), (SELECT x.id FROM plt_mk_marcas x WHERE x.logo_midia_id=m.id LIMIT 1)) marca_id
        FROM plt_mk_midias m WHERE ${onde.join(" AND ")} ORDER BY m.id DESC LIMIT 300`).bind(...args).all();
      const lista = r?.results || [];
      const ids = lista.map(x => x.id);
      const posts = ids.length ? ((await env.DB.prepare(`SELECT id, midia_id, status, canais, data, titulo FROM plt_mk_posts WHERE org_id=? AND midia_id IN (${ids.map(() => "?").join(",")})`).bind(orgId, ...ids).all())?.results || []) : [];
      const nomes = new Map(((await env.DB.prepare("SELECT id, nome FROM plt_mk_marcas WHERE org_id=?").bind(orgId).all())?.results || []).map(x => [x.id, x.nome]));
      return json({ midias: lista.map(x => ({ id: x.id, criado_ms: x.criado_ms, nome_arquivo: x.nome_arquivo || null, descricao: x.descricao || "", enviado_por: x.enviado_por || (x.origem === "ia" ? "DENIA (IA)" : ""), origem: x.origem, google: Boolean(x.google_id) || x.origem === "foto-google", com_texto: Boolean(x.original_id),
        tamanho_kb: Math.round((x.tam || 0) / 1024), video: Boolean(x.video), capa: Boolean(x.capa_id), duracao: x.duracao || null, marca_id: x.marca_id || null, marca: nomes.get(x.marca_id) || "",
        posts: posts.filter(p => p.midia_id === x.id).map(p => ({ id: p.id, status: p.status, canais: (() => { try { return JSON.parse(p.canais); } catch { return []; } })(), data: p.data, titulo: p.titulo })) })) });
    }
    // Renomear / redescrever uma foto.
    if ((m = resto.match(/^midias\/(\d{1,12})$/)) && metodo === "POST") {
      exigir("AGENTE");
      const c = await corpoOu(4000);
      const md = await env.DB.prepare("SELECT id FROM plt_mk_midias WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).first();
      if (!md) return json({ erro: "Foto não encontrada." }, 404);
      const nome = c.nome_arquivo !== undefined ? await nomeUnico(env, orgId, slugSeo(c.nome_arquivo)) : null;
      await env.DB.prepare("UPDATE plt_mk_midias SET nome_arquivo=COALESCE(?,nome_arquivo), descricao=COALESCE(?,descricao) WHERE id=?").bind(nome, c.descricao !== undefined ? txt(c.descricao, 400) : null, md.id).run();
      return json({ ok: true, nome_arquivo: nome });
    }
    // Foto do post com texto escrito (montada no navegador) ou de volta à foto original, sem texto.
    if ((m = resto.match(/^posts\/(\d{1,12})\/foto$/)) && metodo === "POST") {
      exigir("AGENTE");
      const c = await corpoOu(LIMITE_LOGO_B64 + 2000);
      const p = await env.DB.prepare("SELECT id, midia_id, marca_id, status FROM plt_mk_posts WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).first();
      if (!p || !p.midia_id) return json({ erro: "Post sem foto." }, 404);
      if (p.status === "PUBLICADO") return json({ erro: "Este post já foi publicado." }, 409);
      const atual = await env.DB.prepare("SELECT * FROM plt_mk_midias WHERE id=? AND org_id=?").bind(p.midia_id, orgId).first();
      if (c.original) {
        if (!atual?.original_id) return json({ ok: true, midia_id: p.midia_id });
        await env.DB.batch([env.DB.prepare("UPDATE plt_mk_posts SET midia_id=?, texto_arte=NULL, atualizado_ms=? WHERE id=?").bind(atual.original_id, agora(env), p.id),
          env.DB.prepare("UPDATE plt_mk_midias SET origem='foto' WHERE id=? AND org_id=?").bind(atual.original_id, orgId), env.DB.prepare("DELETE FROM plt_mk_midias WHERE id=?").bind(atual.id)]);
        return json({ ok: true, midia_id: atual.original_id });
      }
      const dados = String(c.dados || "").replace(/^data:[^,]*,/, "");
      const mime = tipoDaImagem(dados);
      if (!mime) return json({ erro: "Imagem inválida." }, 400);
      const original = atual?.original_id || p.midia_id;
      const n = await env.DB.prepare("INSERT INTO plt_mk_midias(org_id,mime,dados,prompt,criado_ms,marca_id,nome_arquivo,origem,enviado_por,descricao,original_id) VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING id")
        .bind(orgId, mime, dados, "foto com texto", agora(env), p.marca_id, atual?.nome_arquivo || null, atual?.origem === "foto-com-texto" ? atual.origem : (atual?.origem || "foto"), atual?.enviado_por || autor, atual?.descricao || null, original).first();
      const lote = [env.DB.prepare("UPDATE plt_mk_posts SET midia_id=?, texto_arte=COALESCE(?,texto_arte), atualizado_ms=? WHERE id=?").bind(n.id, c.texto_arte ? txt(c.texto_arte, 80) : null, agora(env), p.id),
        env.DB.prepare("UPDATE plt_mk_midias SET origem='foto-original' WHERE id=? AND org_id=?").bind(original, orgId)];
      if (atual?.original_id) lote.push(env.DB.prepare("DELETE FROM plt_mk_midias WHERE id=?").bind(atual.id));
      await env.DB.batch(lote);
      return json({ ok: true, midia_id: n.id });
    }

    // ----- IA: semana de conteúdo, legenda, imagem
    if (resto.startsWith("ia/")) {
      if (!chave(env)) { const s = semChave(); return json(s.corpo, s.status); }
      if (resto === "ia/semana" && metodo === "POST") {
        exigir("AGENTE");
        const c = await corpoOu(4000);
        const marca = await marcaDa(c.marca_id);
        if (!marca) return json({ erro: "Escolha a marca." }, 400);
        const cfg = (await env.DB.prepare("SELECT * FROM plt_mk_config WHERE org_id=?").bind(orgId).first()) || { modo: "HUMANO", posts_semana: 3, nota_minima: 8 };
        const inicio = semanaDe(dataISO(c.inicio) || new Date(agora(env)).toISOString().slice(0, 10));
        const qtd = Math.max(1, Math.min(14, Number(c.quantidade) || cfg.posts_semana || 3));
        const canais = canaisOk(c.canais && c.canais.length ? c.canais : ["instagram", "facebook"]);
        const anteriores = ((await env.DB.prepare("SELECT titulo FROM plt_mk_posts WHERE marca_id=? ORDER BY id DESC LIMIT 20").bind(marca.id).all())?.results || []).map(x => x.titulo).filter(Boolean);
        const r = await iaJSON(env, `Você é a estrategista de conteúdo de uma agência de marketing digital de alto nível. Crie o calendário de posts de UMA semana para a marca, com foco em VENDER e gerar contatos pelo WhatsApp: pelo menos metade dos posts deve oferecer diretamente um produto, serviço ou oferta específica da marca; os demais variam entre dica útil ligada ao que a marca vende, bastidores, autoridade e datas sazonais. ${REGRAS_CONTEUDO}
${COPY_QUE_VENDE}
Responda em JSON: {"posts":[{"dia":0,"hora":"18:00","formato":"post","titulo":"","legenda":"","hashtags":"","chamada":"","texto_arte":"","ideia_imagem":""}]}
- dia: 0=segunda … 6=domingo; hora no formato HH:MM. Se a marca tiver "Dias e horários preferidos", use SOMENTE esses dias e horários; senão, distribua bem na semana nos horários de maior alcance.
- formato: post, carrossel, story ou reels.
- legenda: pronta para publicar, seguindo a "Legenda que VENDE", com quebras de linha.
- texto_arte: a frase curta (até 6 palavras) que aparece escrita na arte, com ortografia e acentos perfeitos; vazio se a arte não deve ter texto.
- ideia_imagem: descrição visual detalhada da cena (assunto, ambiente, composição, luz, cores da marca), SEM texto escrito — o texto vai em texto_arte.`,
        `${resumoMarca(marca)}\n\nSemana que começa em ${inicio}. Quantidade de posts: ${qtd}. Canais: ${canais.join(", ")}.\nTemas já usados recentemente (evite repetir): ${anteriores.join("; ") || "nenhum"}.\nResponda em JSON.`, 4000);
        const lista = (Array.isArray(r?.posts) ? r.posts : []).slice(0, qtd);
        const criados = [];
        for (const it of lista) {
          const post = { canais, formato: FORMATOS.includes(it.formato) ? it.formato : "post", data: maisDias(inicio, Math.max(0, Math.min(6, Number(it.dia) || 0))), hora: horaOk(it.hora) || "18:00",
            titulo: txt(it.titulo, 200), legenda: txt(it.legenda, 2200), hashtags: txt(it.hashtags, 600), chamada: txt(it.chamada, 200), ideia_imagem: txt(it.ideia_imagem, 1000), texto_arte: txt(it.texto_arte, 80) };
          let status = "AGUARDANDO", revisao = null;
          if (cfg.modo === "AUTOMATICO") {
            revisao = await revisar(env, marca, post).catch(() => null);
            status = revisao && revisao.aprovado && revisao.nota >= cfg.nota_minima ? "APROVADO" : "AGUARDANDO";
          }
          const n = await env.DB.prepare(`INSERT INTO plt_mk_posts(org_id,marca_id,canais,formato,data,hora,titulo,legenda,hashtags,chamada,ideia_imagem,texto_arte,status,revisao,criado_por,aprovado_por,criado_ms,atualizado_ms)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).bind(orgId, marca.id, JSON.stringify(post.canais), post.formato, post.data, post.hora, post.titulo, post.legenda, post.hashtags, post.chamada, post.ideia_imagem, post.texto_arte || null, status, revisao ? JSON.stringify(revisao) : null, "DENIA (IA)", status === "APROVADO" ? "DENIA (aprovação automática)" : null, agora(env), agora(env)).first();
          criados.push({ id: n.id, status });
        }
        await auditar(env, request, sessao, orgId, "MARKETING", `IA criou ${criados.length} post(s) para ${marca.nome} (semana de ${inicio})`);
        return json({ ok: true, criados, modo: cfg.modo });
      }
      if (resto === "ia/legenda" && metodo === "POST") {
        exigir("AGENTE");
        const c = await corpoOu(4000);
        const marca = await marcaDa(c.marca_id);
        if (!marca) return json({ erro: "Escolha a marca." }, 400);
        const r = await iaJSON(env, `Você é redatora publicitária sênior, especialista em vender pelas redes sociais. Escreva um post a partir do tema pedido. ${REGRAS_CONTEUDO}
${COPY_QUE_VENDE}
Responda em JSON: {"titulo":"","legenda":"","hashtags":"","chamada":"","texto_arte":"","ideia_imagem":""} — texto_arte: frase curta (até 6 palavras) escrita na arte, com acentos perfeitos; ideia_imagem: a cena, sem texto escrito.`, `${resumoMarca(marca)}\n\nTema: ${txt(c.tema, 600)}\nFormato: ${FORMATOS.includes(c.formato) ? c.formato : "post"}\nCanal: ${CANAIS.includes(c.canal) ? c.canal : "instagram"}\nResponda em JSON.`, 1500);
        return json({ ok: true, sugestao: { titulo: txt(r.titulo, 200), legenda: txt(r.legenda, 2200), hashtags: txt(r.hashtags, 600), chamada: txt(r.chamada, 200), texto_arte: txt(r.texto_arte, 80), ideia_imagem: txt(r.ideia_imagem, 1000) } });
      }
      // Foto real tirada pela empresa (ex.: lavagem de tapete): a IA olha a foto e escreve o post inteiro.
      if (resto === "ia/post-foto" && metodo === "POST") {
        exigir("AGENTE");
        const c = await corpoOu(LIMITE_LOGO_B64 + 6000);
        const marca = await marcaDa(c.marca_id);
        if (!marca) return json({ erro: "Escolha a empresa." }, 400);
        const dados = String(c.foto || "").replace(/^data:[^,]*,/, "");
        const mime = tipoDaImagem(dados);
        if (!mime) return json({ erro: "Envie a foto em JPG, PNG ou WEBP." }, 400);
        const canais = canaisOk(c.canais && c.canais.length ? c.canais : ["instagram", "facebook"]);
        const formato = FORMATOS.includes(c.formato) && c.formato !== "carrossel" ? c.formato : (canais.length === 1 && canais[0] === "google" ? "google" : "post");
        const pedido = txt(c.pedido, 1500);
        const sóGoogle = canais.length === 1 && canais[0] === "google";
        const modoTexto = ["sim", "nao"].includes(c.texto_na_foto) ? c.texto_na_foto : "auto";
        const palavrasMarca = ((await env.DB.prepare("SELECT palavra FROM plt_mk_palavras WHERE org_id=? AND marca_id=? LIMIT 8").bind(orgId, marca.id).all().catch(() => null))?.results || []).map(x => x.palavra);
        const r = await legendaDeMidia(env, marca, { imagens: [{ mime, b64: dados }], pedido, canais, formato, tipo: "foto", modoTexto, palavras: palavrasMarca });
        if (!r) return json({ erro: "A IA respondeu num formato inesperado. Tente de novo." }, 502);
        const nomeArq = await nomeUnico(env, orgId, slugSeo(r.nome_arquivo || `${r.titulo || ""} ${marca.cidade || ""}`));
        const md = await env.DB.prepare("INSERT INTO plt_mk_midias(org_id,mime,dados,prompt,criado_ms,marca_id,nome_arquivo,origem,enviado_por,descricao) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id")
          .bind(orgId, mime, dados, "foto enviada", agora(env), marca.id, nomeArq, "foto", autor, txt(r.descricao_foto, 400)).first();
        const textoArte = modoTexto === "nao" ? "" : txt(r.texto_arte, 80);
        const cfg = (await env.DB.prepare("SELECT * FROM plt_mk_config WHERE org_id=?").bind(orgId).first()) || { modo: "HUMANO", nota_minima: 8 };
        const post = { canais, formato, data: dataISO(c.data) || new Date(agora(env)).toISOString().slice(0, 10), hora: horaOk(c.hora) || "18:00",
          titulo: txt(r.titulo, 200), legenda: txt(r.legenda, 2200), hashtags: sóGoogle ? "" : txt(r.hashtags, 600), chamada: txt(r.chamada, 200), ideia_imagem: "Foto real enviada pela empresa: " + txt(r.descricao_foto, 600), texto_arte: textoArte };
        let status = "AGUARDANDO", revisao = null;
        if (cfg.modo === "AUTOMATICO") {
          revisao = await revisar(env, marca, post).catch(() => null);
          status = revisao && revisao.aprovado && revisao.nota >= cfg.nota_minima ? "APROVADO" : "AGUARDANDO";
        }
        const n = await env.DB.prepare(`INSERT INTO plt_mk_posts(org_id,marca_id,canais,formato,data,hora,titulo,legenda,hashtags,chamada,ideia_imagem,texto_arte,midia_id,status,revisao,criado_por,aprovado_por,criado_ms,atualizado_ms)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).bind(orgId, marca.id, JSON.stringify(post.canais), post.formato, post.data, post.hora, post.titulo, post.legenda, post.hashtags, post.chamada, post.ideia_imagem, textoArte || null, md.id, status, revisao ? JSON.stringify(revisao) : null, autor, status === "APROVADO" ? "DENIA (aprovação automática)" : null, agora(env), agora(env)).first();
        await gravarBotao(env, n.id, c);
        await auditar(env, request, sessao, orgId, "MARKETING", `IA escreveu o post #${n.id} a partir de uma foto enviada (${marca.nome})`);
        return json({ ok: true, id: n.id, status, nome_arquivo: nomeArq, descricao_foto: txt(r.descricao_foto, 400), palavras_chave: r.palavras_chave, texto_arte: textoArte, post: { ...post, id: n.id, midia_id: md.id, marca_id: marca.id, status } });
      }
      // Vídeo já enviado: a IA olha alguns quadros (tirados no navegador) e o pedido, e escreve o post (Reels/vídeo).
      if (resto === "ia/post-video" && metodo === "POST") {
        exigir("AGENTE");
        const c = await corpoOu(2_600_000);
        const marca = await marcaDa(c.marca_id);
        if (!marca) return json({ erro: "Escolha a empresa." }, 400);
        const vid = await env.DB.prepare("SELECT * FROM plt_mk_midias WHERE id=? AND org_id=? AND arquivo IS NOT NULL").bind(Number(c.midia_id), orgId).first();
        if (!vid) return json({ erro: "Envie o vídeo primeiro." }, 400);
        const quadros = (Array.isArray(c.quadros) ? c.quadros : []).slice(0, 4).map(q => String(q || "").replace(/^data:[^,]*,/, "")).filter(q => tipoDaImagem(q) && q.length < 700_000);
        const canais = canaisOk(c.canais && c.canais.length ? c.canais : ["instagram", "facebook"]);
        const formato = c.formato === "story" ? "story" : "reels";
        const pedido = txt(c.pedido, 1500);
        const palavrasMarca = ((await env.DB.prepare("SELECT palavra FROM plt_mk_palavras WHERE org_id=? AND marca_id=? LIMIT 8").bind(orgId, marca.id).all().catch(() => null))?.results || []).map(x => x.palavra);
        const r = await legendaDeMidia(env, marca, { imagens: quadros.map(q => ({ mime: "image/jpeg", b64: q })), pedido, canais, formato, tipo: "video", modoTexto: "nao", palavras: palavrasMarca });
        if (r) r.descricao = r.descricao_foto;
        if (!r) return json({ erro: "A IA respondeu num formato inesperado. Tente de novo." }, 502);
        const nomeArq = await nomeUnico(env, orgId, slugSeo(r.nome_arquivo || `${r.titulo || ""} ${marca.cidade || ""}`));
        let capaId = null;
        const q = quadros[Math.min(quadros.length, Math.max(1, Number(r.capa) || 1)) - 1];
        if (q) capaId = (await env.DB.prepare("INSERT INTO plt_mk_midias(org_id,mime,dados,prompt,criado_ms,marca_id,nome_arquivo,origem,enviado_por) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id").bind(orgId, tipoDaImagem(q), q, "capa do vídeo", agora(env), marca.id, nomeArq + "-capa", "capa", autor).first()).id;
        await env.DB.prepare("UPDATE plt_mk_midias SET nome_arquivo=?, descricao=?, capa_id=COALESCE(?,capa_id), marca_id=? WHERE id=?").bind(nomeArq, txt(r.descricao, 400), capaId, marca.id, vid.id).run();
        const cfg = (await env.DB.prepare("SELECT * FROM plt_mk_config WHERE org_id=?").bind(orgId).first()) || { modo: "HUMANO", nota_minima: 8 };
        const post = { canais, formato, data: dataISO(c.data) || new Date(agora(env)).toISOString().slice(0, 10), hora: horaOk(c.hora) || "18:00",
          titulo: txt(r.titulo, 200), legenda: txt(r.legenda, 2200), hashtags: txt(r.hashtags, 600), chamada: txt(r.chamada, 200), ideia_imagem: "Vídeo real enviado pela empresa: " + txt(r.descricao, 600), texto_arte: "" };
        let status = "AGUARDANDO", revisao = null;
        if (cfg.modo === "AUTOMATICO") {
          revisao = await revisar(env, marca, post).catch(() => null);
          status = revisao && revisao.aprovado && revisao.nota >= cfg.nota_minima ? "APROVADO" : "AGUARDANDO";
        }
        const n = await env.DB.prepare(`INSERT INTO plt_mk_posts(org_id,marca_id,canais,formato,data,hora,titulo,legenda,hashtags,chamada,ideia_imagem,texto_arte,midia_id,status,revisao,criado_por,aprovado_por,criado_ms,atualizado_ms)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).bind(orgId, marca.id, JSON.stringify(post.canais), post.formato, post.data, post.hora, post.titulo, post.legenda, post.hashtags, post.chamada, post.ideia_imagem, null, vid.id, status, revisao ? JSON.stringify(revisao) : null, autor, status === "APROVADO" ? "DENIA (aprovação automática)" : null, agora(env), agora(env)).first();
        await gravarBotao(env, n.id, c);
        await auditar(env, request, sessao, orgId, "MARKETING", `IA escreveu o post #${n.id} a partir de um vídeo enviado (${marca.nome})`);
        return json({ ok: true, id: n.id, status, nome_arquivo: nomeArq, palavras_chave: r.palavras_chave, post: { ...post, id: n.id, midia_id: vid.id, midia_video: 1, marca_id: marca.id, status } });
      }
      // Conversa com a IA sobre um post: a pessoa explica do jeito dela o que mudar e a IA reescreve (não salva sozinha).
      if (resto === "ia/ajustar" && metodo === "POST") {
        exigir("AGENTE");
        const c = await corpoOu(12000);
        const marca = await marcaDa(c.marca_id);
        if (!marca) return json({ erro: "Escolha a empresa." }, 400);
        const pedido = txt(c.pedido, 1500);
        if (pedido.length < 2) return json({ erro: "Diga para a IA o que você quer mudar." }, 400);
        const a = c.atual || {};
        const historico = (Array.isArray(c.historico) ? c.historico : []).slice(-6).map(x => "- " + txt(x, 300)).join("\n");
        const r = await iaJSON(env, `Você é a social media sênior da empresa e está ajustando um post junto com o dono. Ele fala do jeito dele (às vezes solto, falado, sem pontuação). Entenda o que ele quer e reescreva o post aplicando o pedido; mantenha o que ele não pediu para mudar. ${REGRAS_CONTEUDO}
${COPY_QUE_VENDE}
Se o pedido for uma pergunta, responda em "resposta" e devolva o post sem mudanças. Em "resposta", diga em 1 frase curta o que você mudou.
Responda em JSON: {"titulo":"","legenda":"","hashtags":"","chamada":"","texto_arte":"","resposta":""}`,
          `${resumoMarca(marca)}\n\nCanais: ${canaisOk(c.canais).join(", ")}.\nPost atual:\nTítulo: ${txt(a.titulo, 200)}\nLegenda: ${txt(a.legenda, 2200)}\nHashtags: ${txt(a.hashtags, 600)}\nChamada: ${txt(a.chamada, 200)}\nTexto na arte: ${txt(a.texto_arte, 80)}\n${historico ? "Pedidos anteriores nesta conversa:\n" + historico + "\n" : ""}\nPedido agora: ${pedido}\nResponda em JSON.`);
        return json({ ok: true, sugestao: { titulo: txt(r.titulo, 200) || txt(a.titulo, 200), legenda: txt(r.legenda, 2200) || txt(a.legenda, 2200), hashtags: txt(r.hashtags, 600), chamada: txt(r.chamada, 200), texto_arte: txt(r.texto_arte, 80) }, resposta: txt(r.resposta, 400) });
      }
      if (resto === "ia/imagem" && metodo === "POST") {
        exigir("AGENTE");
        const c = await corpoOu(4000);
        const p = c.post_id ? await env.DB.prepare("SELECT * FROM plt_mk_posts WHERE id=? AND org_id=?").bind(Number(c.post_id), orgId).first() : null;
        const marca = await marcaDa(p ? p.marca_id : c.marca_id);
        if (!marca) return json({ erro: "Escolha a marca." }, 400);
        const ideia = txt(c.ideia || p?.ideia_imagem || p?.titulo, 1000);
        if (!ideia) return json({ erro: "Descreva a imagem que a IA deve criar." }, 400);
        // Texto da arte: o do post, ou o que a pessoa escreveu entre aspas na descrição.
        const textoArte = txt(c.texto_arte ?? p?.texto_arte ?? (ideia.match(/["“]([^"”]{2,80})["”]/) || [])[1], 80);
        const logo = marca.logo_midia_id ? await env.DB.prepare("SELECT mime, dados FROM plt_mk_midias WHERE id=? AND org_id=?").bind(marca.logo_midia_id, orgId).first() : null;
        const vertical = p ? p.formato === "story" || p.formato === "reels" : c.formato === "story" || c.formato === "reels" || c.formato === "vertical";
        const arte = await criarArte(env, { marca, ideia, textoArte, logo, tamanho: vertical ? "1024x1536" : "1024x1024" });
        const b64 = arte.b64;
        const prompt = arte.prompt;
        const nomeIa = await nomeUnico(env, orgId, slugSeo(`${p?.titulo || ideia.split(/[,.]/)[0]} ${marca.cidade || ""}`, 60));
        const md = await env.DB.prepare("INSERT INTO plt_mk_midias(org_id,mime,dados,prompt,criado_ms,marca_id,nome_arquivo,origem,enviado_por,descricao) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id").bind(orgId, "image/jpeg", b64, prompt.slice(0, 2000), agora(env), marca.id, nomeIa, "ia", "DENIA (IA), pedido por " + autor, txt(ideia, 400)).first();
        if (p) {
          await env.DB.prepare("UPDATE plt_mk_posts SET midia_id=?, atualizado_ms=? WHERE id=?").bind(md.id, agora(env), p.id).run();
          if (p.midia_id) await env.DB.prepare("DELETE FROM plt_mk_midias WHERE id=? AND org_id=?").bind(p.midia_id, orgId).run();
        }
        return json({ ok: true, midia_id: md.id, conferencia: arte.conferencia });
      }
    }

    // ----- Google Meu Negócio: avaliações
    if (resto === "avaliacoes" && metodo === "GET") {
      const q = new URL(request.url).searchParams;
      // Com "pagina": lista paginada e filtrada (perfis com milhares de avaliações) + resumo do perfil inteiro.
      if (q.has("pagina")) {
        const marca = Number(q.get("marca") || 0);
        const pagina = Math.max(0, Number(q.get("pagina")) || 0), tam = Math.min(100, Math.max(10, Number(q.get("por_pagina")) || 50));
        const filtro = String(q.get("filtro") || "TODAS"), nota = Number(q.get("nota") || 0), busca = txt(q.get("busca"), 80);
        const precisa = "(json_extract(analise,'$.precisa_humano')=1 OR json_extract(analise,'$.viola_politica')=1)";
        const conds = ["org_id=?", "removida_ms IS NULL"], args = [orgId];
        if (marca) { conds.push("marca_id=?"); args.push(marca); }
        const base = [...conds], baseArgs = [...args];
        if (filtro === "PENDENTE" || filtro === "RESPONDIDA") { conds.push("status=?"); args.push(filtro); }
        if (filtro === "PRECISAM") conds.push(`status='PENDENTE' AND ${precisa}`);
        if (nota >= 1 && nota <= 5) { conds.push("nota=?"); args.push(nota); }
        // Filtros da triagem (avaliações negativas)
        const notaMax = Number(q.get("nota_max") || 0);
        if (notaMax >= 1 && notaMax <= 5) { conds.push("nota<=?"); args.push(notaMax); base.push("nota<=?"); baseArgs.push(notaMax); }
        const veredito = String(q.get("veredito") || "");
        if (["PROVAVEL_FALSA", "DUVIDOSA", "PARECE_REAL"].includes(veredito)) { conds.push("json_extract(triagem,'$.veredito')=?"); args.push(veredito); }
        if (veredito === "SEM") conds.push("triagem IS NULL");
        const resp = String(q.get("resposta") || "");
        if (resp === "COM") conds.push("resposta IS NOT NULL AND TRIM(resposta)<>''");
        if (resp === "SEM") conds.push("(resposta IS NULL OR TRIM(resposta)='')");
        // Cores (semáforo da análise): verde = ótima/positiva; amarelo = neutra/negativa; vermelho = grave, pede uma pessoa ou pode violar regras.
        const cor = String(q.get("cor") || "");
        const vermelho = `(json_extract(analise,'$.sentimento')='GRAVE' OR ${precisa})`;
        if (cor === "VERDE") conds.push(`json_extract(analise,'$.sentimento') IN ('OTIMA','POSITIVA') AND NOT ${vermelho}`);
        if (cor === "AMARELO") conds.push(`json_extract(analise,'$.sentimento') IN ('NEUTRA','NEGATIVA') AND NOT ${vermelho}`);
        if (cor === "VERMELHO") conds.push(vermelho);
        if (cor === "SEM") conds.push("analise IS NULL");
        const den = String(q.get("denuncia") || "");
        if (den === "NAO") conds.push("denuncia IS NULL");
        if (den === "DENUNCIADA" || den === "RECUSADA") { conds.push("json_extract(denuncia,'$.status')=?"); args.push(den); }
        if (busca) { conds.push("(autor LIKE ? OR texto LIKE ?)"); args.push(`%${busca}%`, `%${busca}%`); }
        const [lista, achadas, resumo] = await Promise.all([
          env.DB.prepare(`SELECT * FROM plt_mk_avaliacoes WHERE ${conds.join(" AND ")} ORDER BY (status='PENDENTE' AND ${precisa}) DESC, status='RESPONDIDA', id DESC LIMIT ? OFFSET ?`).bind(...args, tam, pagina * tam).all(),
          env.DB.prepare(`SELECT COUNT(*) n FROM plt_mk_avaliacoes WHERE ${conds.join(" AND ")}`).bind(...args).first(),
          env.DB.prepare(`SELECT COUNT(*) total, AVG(nota) media, SUM(status='PENDENTE') pendentes, SUM(nota<=3) negativas, SUM(status='PENDENTE' AND ${precisa}) precisam,
            SUM(nota=5) n5, SUM(nota=4) n4, SUM(nota=3) n3, SUM(nota=2) n2, SUM(nota=1) n1,
            SUM(resposta IS NOT NULL AND TRIM(resposta)<>'') com_resposta, SUM(triagem IS NULL) sem_triagem,
            SUM(json_extract(triagem,'$.veredito')='PROVAVEL_FALSA') falsas, SUM(json_extract(triagem,'$.veredito')='DUVIDOSA') duvidosas, SUM(json_extract(triagem,'$.veredito')='PARECE_REAL') reais,
            SUM(json_extract(denuncia,'$.status')='DENUNCIADA') denunciadas, SUM(json_extract(denuncia,'$.status')='RECUSADA') recusadas,
            SUM(analise IS NULL) nao_lidas,
            SUM(json_extract(analise,'$.sentimento') IN ('OTIMA','POSITIVA') AND NOT (json_extract(analise,'$.sentimento')='GRAVE' OR ${precisa})) verdes,
            SUM(json_extract(analise,'$.sentimento') IN ('NEUTRA','NEGATIVA') AND NOT (json_extract(analise,'$.sentimento')='GRAVE' OR ${precisa})) amarelas,
            SUM(json_extract(analise,'$.sentimento')='GRAVE' OR ${precisa}) vermelhas
            FROM plt_mk_avaliacoes WHERE ${base.join(" AND ")}`).bind(...baseArgs).first()
        ]);
        const remov = await env.DB.prepare(`SELECT COUNT(*) n FROM plt_mk_avaliacoes WHERE org_id=? ${marca ? "AND marca_id=?" : ""} ${notaMax ? "AND nota<=?" : ""} AND removida_ms IS NOT NULL`).bind(orgId, ...(marca ? [marca] : []), ...(notaMax ? [notaMax] : [])).first();
        return json({ avaliacoes: lista?.results || [], encontradas: achadas?.n || 0, pagina, por_pagina: tam, resumo: { ...(resumo || {}), removidas: remov?.n || 0 } });
      }
      const marca = Number(q.get("marca") || 0), notaMax = Number(q.get("nota_max") || 0);
      const args = [orgId, ...(marca ? [marca] : []), ...(notaMax ? [notaMax] : [])];
      const r = await env.DB.prepare(`SELECT * FROM plt_mk_avaliacoes WHERE org_id=? ${marca ? "AND marca_id=?" : ""} ${notaMax ? "AND nota<=?" : ""} ORDER BY status='RESPONDIDA', id DESC LIMIT ${notaMax ? 1000 : 300}`).bind(...args).all();
      return json({ avaliacoes: r?.results || [] });
    }
    if (resto === "avaliacoes" && metodo === "POST") {
      exigir("AGENTE");
      const c = await corpoOu(6000);
      const marca = await marcaDa(c.marca_id);
      if (!marca) return json({ erro: "Escolha a marca." }, 400);
      const nota = Math.max(1, Math.min(5, Math.round(Number(c.nota) || 5)));
      const n = await env.DB.prepare("INSERT INTO plt_mk_avaliacoes(org_id,marca_id,autor,nota,texto,data,status,criado_ms) VALUES(?,?,?,?,?,?,'PENDENTE',?) RETURNING id").bind(orgId, marca.id, txt(c.autor, 120) || "Cliente", nota, txt(c.texto, 3000), dataISO(c.data) || new Date(agora(env)).toISOString().slice(0, 10), agora(env)).first();
      return json({ ok: true, id: n.id });
    }
    if ((m = resto.match(/^avaliacoes\/(\d{1,12})\/(sugerir|responder|remover)$/)) && metodo === "POST") {
      exigir("AGENTE");
      const a = await env.DB.prepare("SELECT * FROM plt_mk_avaliacoes WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).first();
      if (!a) return json({ erro: "Avaliação não encontrada." }, 404);
      if (m[2] === "remover") { await env.DB.prepare("DELETE FROM plt_mk_avaliacoes WHERE id=?").bind(a.id).run(); return json({ ok: true }); }
      if (m[2] === "responder") {
        const c = await corpoOu(4000);
        const resposta = txt(c.resposta, 2000);
        if (!resposta) return json({ erro: "Escreva a resposta." }, 400);
        // Avaliação que veio do Google: a resposta é publicada direto no perfil.
        let google = { publicada: false };
        if (a.google_id) {
          try { google = await responderAvaliacaoGoogle(env, k, a, resposta); }
          catch (e) { return json({ erro: "A resposta não foi publicada no Google: " + e.message }, 502); }
        }
        await env.DB.prepare("UPDATE plt_mk_avaliacoes SET resposta=?, status='RESPONDIDA' WHERE id=?").bind(resposta, a.id).run();
        await auditar(env, request, sessao, orgId, "MARKETING", `Respondeu a avaliação de ${a.autor} (${a.nota}★)${google.publicada ? " — publicada no Google" : ""}`);
        return json({ ok: true, publicada_google: Boolean(google.publicada) });
      }
      if (!chave(env)) { const s = semChave(); return json(s.corpo, s.status); }
      const marca = await marcaDa(a.marca_id);
      // A DENIA lê a avaliação no contexto (boa, ruim, grave, possível violação) e escreve uma resposta própria para ela.
      if (m[2] === "sugerir") { const r = await analisarUmaAvaliacao(env, marca, a); return json({ ok: true, resposta: r.resposta, analise: r.analise }); }
      const r = await iaJSON(env, `Você responde avaliações do Google em nome da empresa, como o dono responderia: cordial, humano, específico ao que o cliente escreveu, curto (2 a 4 frases). Agradeça sempre. Em avaliação negativa: peça desculpas sem se defender, mostre que vai resolver e convide para falar no WhatsApp; nunca exponha dados do cliente nem discuta. Não invente fatos. Responda no mesmo idioma em que a avaliação foi escrita, com escrita impecável.
Responda em JSON: {"resposta":""}`, `${resumoMarca(marca)}\n\nAvaliação de ${a.autor} (${a.nota} de 5 estrelas):\n"${a.texto || "(sem texto)"}"\nResponda em JSON.`, 600);
      const resp = txt(r.resposta, 2000);
      await env.DB.prepare("UPDATE plt_mk_avaliacoes SET resposta_sugerida=? WHERE id=?").bind(resp, a.id).run();
      return json({ ok: true, resposta: resp });
    }

    // ----- Triagem das avaliações negativas (lotes de até 12 por chamada; a tela repete até acabar)
    if (resto === "avaliacoes/triagem" && metodo === "POST") {
      exigir("AGENTE");
      if (!chave(env)) { const s = semChave(); return json(s.corpo, s.status); }
      const c = await corpoOu(1000);
      const marca = await marcaDa(c.marca_id);
      if (!marca) return json({ erro: "Escolha a marca." }, 400);
      // Uma avaliação escolhida pode ser de até 3 estrelas ("O que fazer com esta avaliação?"); a triagem geral é das de 1 e 2.
      const todas = (await env.DB.prepare("SELECT * FROM plt_mk_avaliacoes WHERE org_id=? AND marca_id=? AND nota<=? AND removida_ms IS NULL ORDER BY id DESC LIMIT 5000").bind(orgId, marca.id, Array.isArray(c.ids) ? 3 : 2).all())?.results || [];
      const escolhidas = Array.isArray(c.ids) ? new Set(c.ids.map(Number)) : null;
      const pendentes = escolhidas ? todas.filter(a => escolhidas.has(a.id) && !String(a.triagem || "").includes(`"lote":"${c.lote || ""}"`))
        : todas.filter(a => c.refazer ? !String(a.triagem || "").includes(`"lote":"${c.lote || ""}"`) : !a.triagem);
      const lote = pendentes.slice(0, 12);
      // Sinais que valem para todas: quem está na base de clientes, avaliações em sequência e textos repetidos.
      let base = null;
      if (lote.length && k.engine) {
        const r = await k.engine("POST", "clients/match", { nomes: [...new Set(lote.map(a => a.autor || ""))] }).catch(() => null);
        if (r && r.status < 400 && r.dados?.resultado) base = r.dados;
      }
      const porDia = {};
      for (const a of todas) { const d = String(a.data || "").slice(0, 10); if (d) porDia[d] = (porDia[d] || 0) + 1; }
      const normal = t => String(t || "").toLowerCase().replace(/[^a-zà-ú0-9 ]/gi, "").replace(/\s+/g, " ").trim();
      const repetidos = {};
      for (const a of todas) { const t = normal(a.texto); if (t.length > 8) repetidos[t] = (repetidos[t] || 0) + 1; }
      let feitas = 0;
      const resultados = {};
      for (const a of lote) {
        const sinais = [];
        const m = base?.resultado?.[a.autor || ""];
        if (!base) sinais.push("Base de clientes indisponível agora (sem esse sinal).");
        else if (m?.encontrado === "SIM") sinais.push(`Quem avaliou ESTÁ na base de clientes (${(m.onde || []).join(" e ")}${m.ultimo_contato ? ", último contato em " + String(m.ultimo_contato).slice(0, 10) : ""}).`);
        else if (m?.encontrado === "TALVEZ") sinais.push(`Só o primeiro nome aparece no Google; há ${m.quantos} cliente(s) com esse primeiro nome na base — inconclusivo.`);
        else if (m?.encontrado === "NAO") sinais.push(`Quem avaliou NÃO está na base de clientes (procurado em ${base.base?.whatsapp || 0} contatos do WhatsApp e ${base.base?.cadastro || 0} do cadastro).`);
        else sinais.push("O Google não mostra um nome que dê para procurar na base.");
        const dia = String(a.data || "").slice(0, 10);
        if (dia) {
          const perto = Object.entries(porDia).filter(([d]) => Math.abs(Date.parse(d) - Date.parse(dia)) <= 3 * 86400000).reduce((t, [, n]) => t + n, 0);
          if (perto >= 3) sinais.push(`${perto} avaliações de 1 ou 2 estrelas num intervalo de 7 dias em torno desta.`);
        }
        if (!String(a.texto || "").trim()) sinais.push("Avaliação sem texto (só a nota).");
        else if ((repetidos[normal(a.texto)] || 0) > 1) sinais.push(`O mesmo texto aparece em ${repetidos[normal(a.texto)]} avaliações.`);
        try {
          const t = await triarAvaliacao(env, marca, a, sinais);
          const tri = { ...t, lote: c.lote || "", em: agora(env) };
          await env.DB.prepare("UPDATE plt_mk_avaliacoes SET triagem=? WHERE id=?").bind(JSON.stringify(tri), a.id).run();
          resultados[a.id] = tri;
          feitas++;
        } catch (e) { return json({ erro: e.message, feitas, restantes: pendentes.length - feitas }, 502); }
      }
      return json({ ok: true, feitas, restantes: Math.max(0, pendentes.length - feitas), total: todas.length, base_clientes: base ? base.base : null, resultados });
    }
    if ((m = resto.match(/^avaliacoes\/(\d{1,12})\/denuncia$/)) && metodo === "POST") {
      exigir("AGENTE");
      const a = await env.DB.prepare("SELECT id, autor FROM plt_mk_avaliacoes WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).first();
      if (!a) return json({ erro: "Avaliação não encontrada." }, 404);
      const c = await corpoOu(1000);
      const status = ["DENUNCIADA", "RECUSADA"].includes(c.status) ? c.status : null;
      const reg = status ? { status, categoria: CATEGORIAS_DENUNCIA.includes(c.categoria) ? c.categoria : "", em: agora(env), por: autor } : null;
      await env.DB.prepare("UPDATE plt_mk_avaliacoes SET denuncia=? WHERE id=?").bind(reg ? JSON.stringify(reg) : null, a.id).run();
      if (reg) await auditar(env, request, sessao, orgId, "MARKETING", `Avaliação de ${a.autor}: ${status === "DENUNCIADA" ? "denunciada ao Google" : "denúncia recusada pelo Google"}${reg.categoria ? " (" + reg.categoria + ")" : ""}`);
      return json({ ok: true, denuncia: reg });
    }
    // "Ler todas com IA": analisa (sem publicar nada) as avaliações que ainda não foram lidas, em lotes.
    if (resto === "avaliacoes/analisar-lote" && metodo === "POST") {
      exigir("AGENTE");
      if (!chave(env)) { const s = semChave(); return json(s.corpo, s.status); }
      const c = await corpoOu(1000);
      const marca = await marcaDa(c.marca_id);
      if (!marca) return json({ erro: "Escolha a marca." }, 400);
      const lote = (await env.DB.prepare("SELECT * FROM plt_mk_avaliacoes WHERE org_id=? AND marca_id=? AND analise IS NULL AND removida_ms IS NULL ORDER BY status='RESPONDIDA', nota, id DESC LIMIT 8").bind(orgId, marca.id).all())?.results || [];
      let feitas = 0;
      for (const a of lote) {
        try { await analisarUmaAvaliacao(env, marca, a); feitas++; }
        catch (e) { return json({ erro: e.message, feitas }, 502); }
      }
      const resta = await env.DB.prepare("SELECT COUNT(*) n FROM plt_mk_avaliacoes WHERE org_id=? AND marca_id=? AND analise IS NULL AND removida_ms IS NULL").bind(orgId, marca.id).first();
      return json({ ok: true, feitas, restantes: Number(resta?.n || 0) });
    }
    if (resto === "avaliacoes/denuncia-lote" && metodo === "POST") {
      exigir("AGENTE");
      const c = await corpoOu(40000);
      const ids = (Array.isArray(c.ids) ? c.ids : []).map(Number).filter(Boolean).slice(0, 500);
      const status = ["DENUNCIADA", "RECUSADA"].includes(c.status) ? c.status : null;
      if (!ids.length) return json({ erro: "Selecione as avaliações." }, 400);
      // Cada uma guarda o próprio tópico indicado pela triagem.
      await env.DB.prepare(`UPDATE plt_mk_avaliacoes SET denuncia=CASE WHEN ? IS NULL THEN NULL ELSE json_object('status', ?, 'categoria', COALESCE(json_extract(triagem,'$.categoria'),''), 'em', ?, 'por', ?) END
        WHERE org_id=? AND id IN (SELECT value FROM json_each(?))`).bind(status, status, agora(env), autor, orgId, JSON.stringify(ids)).run();
      await auditar(env, request, sessao, orgId, "MARKETING", `${ids.length} avaliação(ões) ${status === "DENUNCIADA" ? "marcadas como denunciadas ao Google" : status === "RECUSADA" ? "marcadas como recusadas pelo Google" : "sem marcação de denúncia"}`);
      return json({ ok: true, marcadas: ids.length });
    }
    if ((m = resto.match(/^avaliacoes\/(\d{1,12})\/apagar-resposta$/)) && metodo === "POST") {
      exigir("ADMIN");
      const a = await env.DB.prepare("SELECT * FROM plt_mk_avaliacoes WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).first();
      if (!a) return json({ erro: "Avaliação não encontrada." }, 404);
      if (a.google_id) {
        try { await apagarRespostaGoogle(env, k, a); }
        catch (e) { return json({ erro: "O Google não apagou a resposta: " + e.message }, 502); }
      }
      await env.DB.prepare("UPDATE plt_mk_avaliacoes SET resposta=NULL, status='PENDENTE' WHERE id=?").bind(a.id).run();
      await auditar(env, request, sessao, orgId, "MARKETING", `Apagou a resposta da avaliação de ${a.autor} (${a.nota}★)${a.google_id ? " no Google" : ""}`);
      return json({ ok: true });
    }
    if (resto === "google/link" && metodo === "GET") {
      const conta = await contaGoogleDe(env, orgId, Number(new URL(request.url).searchParams.get("marca")));
      if (!conta) return json({ erro: "Esta marca ainda não está conectada ao Google." }, 409);
      try { return json({ url: await linkDoPerfil(env, k, conta) }); } catch (e) { return json({ erro: e.message }, 502); }
    }
    // ----- Alertas para o menu: avaliações que precisam de uma pessoa
    if (resto === "alertas" && metodo === "GET") {
      const r = await env.DB.prepare("SELECT analise FROM plt_mk_avaliacoes WHERE org_id=? AND status='PENDENTE' AND analise IS NOT NULL").bind(orgId).all();
      const n = (r?.results || []).filter(x => { try { const a = JSON.parse(x.analise); return a.precisa_humano || a.viola_politica || a.urgencia === "ALTA"; } catch { return false; } }).length;
      return json({ avaliacoes: n });
    }
    // ----- Relatório semanal de especialista
    if (resto === "relatorios" && metodo === "GET") {
      const marca = Number(new URL(request.url).searchParams.get("marca") || 0);
      const r = await env.DB.prepare("SELECT semana, texto, criado_ms FROM plt_mk_relatorios WHERE org_id=? AND marca_id=? ORDER BY semana DESC LIMIT 8").bind(orgId, marca).all();
      return json({ relatorios: r?.results || [] });
    }
    if (resto === "relatorios/gerar" && metodo === "POST") {
      exigir("AGENTE");
      if (!chave(env)) { const s = semChave(); return json(s.corpo, s.status); }
      const c = await corpoOu(1000);
      const marca = await marcaDa(c.marca_id);
      if (!marca) return json({ erro: "Escolha a marca." }, 400);
      return json({ ok: true, ...(await gerarRelatorio(env, k, orgId, marca)) });
    }
    // Resumo do Google de uma marca (para a DENIA falar e para o painel).
    if (resto === "google/resumo" && metodo === "GET") {
      const marca = await marcaDa(new URL(request.url).searchParams.get("marca"));
      if (!marca) return json({ erro: "Escolha a marca." }, 400);
      const av = (await env.DB.prepare("SELECT id, autor, nota, texto, status, analise FROM plt_mk_avaliacoes WHERE org_id=? AND marca_id=? ORDER BY id DESC LIMIT 200").bind(orgId, marca.id).all())?.results || [];
      const lidas = av.map(a => ({ ...a, analise: (() => { try { return JSON.parse(a.analise || "null"); } catch { return null; } })() }));
      const conta = await contaGoogleDe(env, orgId, marca.id);
      const vivo = conta ? await desempenhoAoVivo(env, k, conta).catch(e => ({ erro: e.message })) : null;
      const rel = await env.DB.prepare("SELECT semana, texto FROM plt_mk_relatorios WHERE org_id=? AND marca_id=? ORDER BY semana DESC LIMIT 1").bind(orgId, marca.id).first();
      return json({ marca: marca.nome, conectada: Boolean(conta), nota_media: av.length ? Math.round(av.reduce((t, a) => t + Number(a.nota || 0), 0) / av.length * 10) / 10 : null, total: av.length,
        sem_resposta: lidas.filter(a => a.status === "PENDENTE").length, negativas: av.filter(a => Number(a.nota) <= 3).length,
        precisam_de_voce: lidas.filter(a => a.status === "PENDENTE" && a.analise && (a.analise.precisa_humano || a.analise.viola_politica)).map(a => ({ id: a.id, autor: a.autor, nota: a.nota, texto: String(a.texto || "").slice(0, 200), motivo: a.analise.motivo_humano || (a.analise.viola_politica ? "Pode violar as regras do Google: " + a.analise.politica : "") })),
        desempenho_30_dias: vivo, ultimo_relatorio: rel || null });
    }
    // ----- Google Meu Negócio: palavras-chave e posição semanal
    if (resto === "palavras" && metodo === "GET") {
      const marca = Number(new URL(request.url).searchParams.get("marca") || 0);
      const r = await env.DB.prepare(`SELECT * FROM plt_mk_palavras WHERE org_id=? ${marca ? "AND marca_id=?" : ""} ORDER BY id`).bind(...(marca ? [orgId, marca] : [orgId])).all();
      const palavras = r?.results || [];
      const pos = palavras.length ? ((await env.DB.prepare(`SELECT * FROM plt_mk_posicoes WHERE palavra_id IN (${palavras.map(() => "?").join(",")}) ORDER BY semana`).bind(...palavras.map(p => p.id)).all())?.results || []) : [];
      return json({ medicao_automatica: placesConfigurado(env), palavras: palavras.map(p => ({ ...p, posicoes: pos.filter(x => x.palavra_id === p.id) })) });
    }
    if (resto === "palavras" && metodo === "POST") {
      exigir("AGENTE");
      const c = await corpoOu(2000);
      const marca = await marcaDa(c.marca_id);
      if (!marca) return json({ erro: "Escolha a marca." }, 400);
      const palavra = txt(c.palavra, 120);
      if (palavra.length < 2) return json({ erro: "Informe a palavra-chave." }, 400);
      const n = await env.DB.prepare("INSERT INTO plt_mk_palavras(org_id,marca_id,palavra,cidade,criado_ms) VALUES(?,?,?,?,?) RETURNING id").bind(orgId, marca.id, palavra, txt(c.cidade, 120) || marca.cidade || null, agora(env)).first();
      // Já mede a posição na hora (se der).
      let medicao = null;
      if (placesConfigurado(env)) medicao = await medirPalavra(env, k, { id: n.id, org_id: orgId, marca_id: marca.id, palavra, cidade: txt(c.cidade, 120) || marca.cidade || "" }).catch(e => ({ erro: e.message }));
      return json({ ok: true, id: n.id, medicao });
    }
    if ((m = resto.match(/^palavras\/(\d{1,12})\/(posicao|remover|medir)$/)) && metodo === "POST") {
      exigir("AGENTE");
      const p = await env.DB.prepare("SELECT * FROM plt_mk_palavras WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).first();
      if (!p) return json({ erro: "Palavra-chave não encontrada." }, 404);
      if (m[2] === "medir") {
        if (!placesConfigurado(env)) return json({ erro: "Para medir sozinha, falta a variável GOOGLE_PLACES_API_KEY (Places API do Google) na Hostinger.", codigo: "PLACES_NAO_CONFIGURADO" }, 503);
        try { return json({ ok: true, ...(await medirPalavra(env, k, p)) }); } catch (e) { return json({ erro: e.message }, e.status && e.status < 500 ? e.status : 502); }
      }
      if (m[2] === "remover") { await env.DB.batch([env.DB.prepare("DELETE FROM plt_mk_palavras WHERE id=?").bind(p.id), env.DB.prepare("DELETE FROM plt_mk_posicoes WHERE palavra_id=?").bind(p.id)]); return json({ ok: true }); }
      const c = await corpoOu(1000);
      const semana = semanaDe(dataISO(c.semana) || new Date(agora(env)).toISOString().slice(0, 10));
      const posicao = c.posicao === null || c.posicao === "" ? null : Math.max(1, Math.min(100, Math.round(Number(c.posicao))));
      await env.DB.prepare("INSERT OR REPLACE INTO plt_mk_posicoes(palavra_id,semana,posicao,criado_ms) VALUES(?,?,?,?)").bind(p.id, semana, Number.isFinite(posicao) ? posicao : null, agora(env)).run();
      return json({ ok: true });
    }

    // ----- Google Meu Negócio: desempenho semanal
    if (resto === "metricas" && metodo === "GET") {
      const marca = Number(new URL(request.url).searchParams.get("marca") || 0);
      const r = await env.DB.prepare("SELECT * FROM plt_mk_metricas WHERE org_id=? AND marca_id=? ORDER BY semana DESC LIMIT 26").bind(orgId, marca).all();
      return json({ metricas: (r?.results || []).map(x => ({ semana: x.semana, ...JSON.parse(x.dados || "{}") })) });
    }
    if (resto === "metricas" && metodo === "POST") {
      exigir("AGENTE");
      const c = await corpoOu(2000);
      const marca = await marcaDa(c.marca_id);
      if (!marca) return json({ erro: "Escolha a marca." }, 400);
      const nomes = ["visualizacoes", "buscas", "ligacoes", "rotas", "cliques_site", "mensagens", "nota_media", "total_avaliacoes"];
      const dados = Object.fromEntries(nomes.map(n => [n, c[n] === "" || c[n] == null ? null : Math.max(0, Number(c[n]) || 0)]));
      const semana = semanaDe(dataISO(c.semana) || new Date(agora(env)).toISOString().slice(0, 10));
      await env.DB.prepare("INSERT OR REPLACE INTO plt_mk_metricas(org_id,marca_id,semana,dados,criado_ms) VALUES(?,?,?,?,?)").bind(orgId, marca.id, semana, JSON.stringify(dados), agora(env)).run();
      return json({ ok: true });
    }

    // ----- Resumo do Estúdio
    if (resto === "resumo" && metodo === "GET") {
      const hoje = new Date(agora(env)).toISOString().slice(0, 10), ini = semanaDe(hoje), fim = maisDias(ini, 6);
      const q = async (sql, ...a) => Number((await env.DB.prepare(sql).bind(...a).first())?.n || 0);
      return json({
        marcas: await q("SELECT COUNT(*) n FROM plt_mk_marcas WHERE org_id=? AND ativa=1", orgId),
        aguardando: await q("SELECT COUNT(*) n FROM plt_mk_posts WHERE org_id=? AND status='AGUARDANDO'", orgId),
        aprovados: await q("SELECT COUNT(*) n FROM plt_mk_posts WHERE org_id=? AND status='APROVADO'", orgId),
        semana: await q("SELECT COUNT(*) n FROM plt_mk_posts WHERE org_id=? AND data>=? AND data<=?", orgId, ini, fim),
        publicados: await q("SELECT COUNT(*) n FROM plt_mk_posts WHERE org_id=? AND status='PUBLICADO'", orgId),
        avaliacoes_pendentes: await q("SELECT COUNT(*) n FROM plt_mk_avaliacoes WHERE org_id=? AND status='PENDENTE'", orgId),
        semana_inicio: ini, ia_ligada: Boolean(chave(env))
      });
    }
    return json({ erro: "Rota não encontrada." }, 404);
  } catch (e) {
    if (e?.resposta) return e.resposta;
    console.error("marketing", e?.message);
    return json({ erro: e?.message || "Não foi possível concluir agora." }, e?.status && e.status < 500 ? 502 : 500);
  }
}

// ---------------------------------------------------------------------------
// Assistente DENIA (texto e voz)
// ---------------------------------------------------------------------------

// Conversa com saída em JSON (resposta + ações).
async function iaJSONConversa(env, instrucoes, mensagens, maxTokens = 1600) {
  const d = await openai(env, "responses", {
    model: String(env.OPENAI_MODEL || MODELO_TEXTO).trim(), instructions: instrucoes,
    input: mensagens.map(m => ({ role: m.papel === "denia" ? "assistant" : "user", content: [{ type: m.papel === "denia" ? "output_text" : "input_text", text: m.texto }] })),
    text: { format: { type: "json_object" } }, max_output_tokens: maxTokens, store: false
  });
  const t = textoDaResposta(d).trim();
  try { return JSON.parse(t); } catch { return { resposta: t, acoes: [] }; }
}

const CAMPOS_TREINO = ["instrucoes", "servicos", "regras", "precos", "procedimentos", "informacoes", "exemplos"];
const ROTULO_TREINO = { instrucoes: "Instruções", servicos: "Serviços", regras: "Regras", precos: "Preços", procedimentos: "Procedimentos", informacoes: "Informações", exemplos: "Exemplos" };

const semAcento = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
function marcaPorNome(marcasOrg, nome, obrigatoria = true) {
  if (!nome && marcasOrg.length === 1) return marcasOrg[0];
  const n = semAcento(nome);
  const m = n ? marcasOrg.find(x => semAcento(x.nome) === n) || marcasOrg.find(x => semAcento(x.nome).includes(n) || n.includes(semAcento(x.nome))) : null;
  if (!m && obrigatoria) throw new Error(marcasOrg.length ? `Não encontrei a marca "${nome || ""}". Diga qual: ${marcasOrg.map(x => x.nome).join(", ")}.` : "Cadastre uma marca primeiro, em Contas conectadas.");
  return m;
}
const ACOES_TP = ["tp_resumo", "tp_precos", "tp_config", "tp_disponibilidade", "tp_estoque", "tp_nota", "tp_cotacao", "tp_mercado"];
const TIPOS_ACAO = ["criar_semana", "criar_post", "aprovar_posts", "publicar_post", "treinar", "pausar_ia", "google_resumo", "atualizar_google", "responder_avaliacoes", "relatorio_google", ...ACOES_TP];
const ACOES_GOOGLE = ["google_resumo", "atualizar_google", "responder_avaliacoes", "relatorio_google"];
// Deixa a ação pronta para a tela executar: marca resolvida, campos conferidos.
function prepararAcao(a, marcasOrg, txt) {
  const tipo = String(a?.tipo || "");
  if (!TIPOS_ACAO.includes(tipo)) throw new Error("Ação desconhecida.");
  const p = { tipo };
  const canais = (Array.isArray(a.canais) ? a.canais : []).map(String).filter(c => ["instagram", "facebook", "google"].includes(c));
  if (tipo === "criar_semana" || tipo === "criar_post") {
    const m = marcaPorNome(marcasOrg, a.marca);
    Object.assign(p, { marca: m.nome, marca_id: m.id, canais: canais.length ? canais : tipo === "criar_post" ? ["instagram"] : ["instagram", "facebook"] });
  }
  if (tipo === "criar_semana") Object.assign(p, { quantidade: Math.max(1, Math.min(14, Number(a.quantidade) || 3)), semana: a.semana === "esta" ? "esta" : "proxima", com_artes: a.com_artes !== false });
  if (tipo === "criar_post") Object.assign(p, { tema: txt(a.tema, 600), formato: ["post", "carrossel", "story", "reels"].includes(a.formato) ? a.formato : "post", data: /^\d{4}-\d{2}-\d{2}$/.test(String(a.data || "")) ? a.data : "", hora: /^\d{2}:\d{2}$/.test(String(a.hora || "")) ? a.hora : "", com_arte: a.com_arte !== false });
  if (tipo === "aprovar_posts" && a.marca) { const m = marcaPorNome(marcasOrg, a.marca); Object.assign(p, { marca: m.nome, marca_id: m.id }); }
  if (tipo === "publicar_post") p.post_id = Number(a.post_id) || 0;
  if (tipo === "treinar") {
    p.campo = CAMPOS_TREINO.includes(a.campo) ? a.campo : "instrucoes";
    p.rotulo = ROTULO_TREINO[p.campo];
    p.modo = a.modo === "substituir" ? "substituir" : "acrescentar";
    p.texto = txt(a.texto, 8000);
    if (!p.texto) throw new Error("Faltou dizer o que a IA deve aprender.");
  }
  if (tipo === "pausar_ia") p.pausar = a.pausar !== false;
  if (ACOES_GOOGLE.includes(tipo)) { const m = marcaPorNome(marcasOrg, a.marca); Object.assign(p, { marca: m.nome, marca_id: m.id }); }
  if (tipo === "responder_avaliacoes") p.publicar = a.publicar === true;
  if (ACOES_TP.includes(tipo)) Object.assign(p, Object.fromEntries(Object.entries(a || {}).filter(([k2]) => k2 !== "tipo").map(([k2, v]) => [k2, typeof v === "string" ? txt(v, 1500) : v])));
  return p;
}
// Locação por temporada pela voz: preços, disponibilidade, estoque, melhorias, cotação e pesquisa de mercado.
async function executarTemporada(a, contexto, txt) {
  const tipo = a.tipo;
  const falhou = r => r.status >= 400 ? (r.dados?.erro || "Não foi possível fazer agora.") : "";
  const lista = await contexto.tp("GET", "imoveis");
  if (falhou(lista)) return { tipo, ok: false, resumo: falhou(lista) };
  const ims = (lista.dados.imoveis || []).filter(i => i.ativo);
  const norm = t => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const acharIm = (nome, obrig = true) => {
    if (!nome && ims.length === 1) return ims[0];
    const n = norm(nome);
    const im = ims.find(i => norm(i.nome) === n) || ims.find(i => n && norm(i.nome).includes(n)) || ims.find(i => n && n.includes(norm(i.nome)));
    if (!im && obrig) throw new Error(ims.length ? `Não achei o imóvel "${nome || ""}". Imóveis: ${ims.map(i => i.nome).join(", ")}.` : "Ainda não há imóveis cadastrados em Locação por temporada.");
    return im;
  };
  const dia = s2 => /^\d{4}-\d{2}-\d{2}$/.test(String(s2 || "")) ? s2 : null;
  const R = (ok, resumo, abrir = "#/temporada/calendario") => ({ tipo, ok, resumo, abrir });
  if (tipo === "tp_resumo") {
    const im = a.imovel ? acharIm(a.imovel) : null;
    const v = await contexto.tp("GET", `visao${im ? "?imovel=" + im.id : ""}`);
    if (falhou(v)) return R(false, falhou(v));
    const est = await contexto.tp("GET", `estoque${im ? "?imovel=" + im.id : ""}`);
    const baixos = (est.dados?.itens || []).filter(x => x.minimo > 0 && x.quantidade <= x.minimo);
    const d = v.dados;
    return R(true, `${im ? im.nome : `${d.imoveis} imóvel(is)`}: ocupação de ${d.ocupacao ?? "—"}% nos últimos 30 dias, receita ${d.receita}, diária média ${d.diaria_media ?? "—"}. Próximas entradas: ${(d.proximas || []).slice(0, 5).map(r => `${r.imovel} ${r.inicio} (${r.hospede || "hóspede"})`).join("; ") || "nenhuma"}. ${baixos.length ? "Estoque acabando: " + baixos.slice(0, 8).map(b => `${b.imovel} — ${b.item}`).join(", ") + "." : "Estoque em dia."} ${d.rascunhos ? d.rascunhos + " resposta(s) para hóspedes esperando aprovação." : ""}`, "#/temporada/visao");
  }
  if (tipo === "tp_precos" || tipo === "tp_disponibilidade") {
    const im = acharIm(a.imovel), de = dia(a.de), ate = dia(a.ate) || dia(a.de);
    if (!de) return R(false, "Diga o período (de e até).");
    const corpo = { imovel_id: im.id, de, ate };
    if (tipo === "tp_disponibilidade") corpo.fechado = a.bloquear !== false;
    else { if (a.voltar_ao_base) corpo.limpar = true; else { if (Number(a.preco) > 0) corpo.preco = Number(a.preco); if (Number(a.minimo) > 0) corpo.minimo = Number(a.minimo); } }
    const r = await contexto.tp("POST", "precos", corpo);
    if (falhou(r)) return R(false, falhou(r));
    const env2 = r.dados.plataformas?.enviado ? " Já enviado para as plataformas conectadas." : corpo.preco || corpo.minimo ? " Atenção: este imóvel não tem a conexão oficial, então o preço mudou só na DENIA — aplique o mesmo valor no Airbnb, Booking e Vrbo." : " As datas vão para as plataformas pelo calendário.";
    return R(true, tipo === "tp_disponibilidade" ? `${im.nome}: ${corpo.fechado ? "fechado" : "aberto"} de ${de} a ${ate}.${env2}` : corpo.limpar ? `${im.nome}: de ${de} a ${ate} voltou ao preço normal.${env2}` : `${im.nome}: ${corpo.preco ? "diária de " + corpo.preco : ""}${corpo.minimo ? " mínimo de " + corpo.minimo + " noites" : ""} de ${de} a ${ate}.${env2}`);
  }
  if (tipo === "tp_config") {
    const im = acharIm(a.imovel);
    const campos = ["preco_base", "preco_fds", "minimo_noites", "maximo_noites", "taxa_limpeza", "desconto_semanal", "desconto_mensal", "taxa_hospede_extra", "hospedes_incluidos", "taxa_pet"];
    const corpo = Object.fromEntries(campos.filter(c => a[c] !== undefined && a[c] !== null && a[c] !== "").map(c => [c, Number(a[c])]));
    if (!Object.keys(corpo).length) return R(false, "Diga o que mudar (diária, fim de semana, limpeza, desconto semanal ou mensal, mínimo de noites).");
    const r = await contexto.tp("POST", `imoveis/${im.id}`, corpo);
    if (falhou(r)) return R(false, falhou(r));
    const NOME = { preco_base: "diária", preco_fds: "fim de semana", minimo_noites: "mínimo de noites", maximo_noites: "máximo de noites", taxa_limpeza: "taxa de limpeza", desconto_semanal: "desconto semanal (%)", desconto_mensal: "desconto mensal (%)", taxa_hospede_extra: "hóspede extra", hospedes_incluidos: "hóspedes incluídos", taxa_pet: "taxa de pet" };
    return R(true, `${im.nome}: ${Object.entries(corpo).map(([c, v]) => `${NOME[c]} ${v}`).join(", ")}.${r.dados.plataformas?.enviado ? " Enviado para as plataformas." : ""}`, "#/temporada/imoveis");
  }
  if (tipo === "tp_estoque") {
    const im = acharIm(a.imovel);
    const est = await contexto.tp("GET", `estoque?imovel=${im.id}`);
    if (falhou(est)) return R(false, falhou(est));
    const itens = est.dados.itens || [];
    if (!a.item) return R(true, itens.length ? `Estoque de ${im.nome}: ${itens.map(x => `${x.item} ${x.quantidade}${x.unidade ? " " + x.unidade : ""}${x.minimo > 0 && x.quantidade <= x.minimo ? " (acabando)" : ""}`).join(", ")}.` : `${im.nome} ainda não tem lista de estoque.`, "#/temporada/estoque");
    const it = itens.find(x => norm(x.item) === norm(a.item)) || itens.find(x => norm(x.item).includes(norm(a.item)) || norm(a.item).includes(norm(x.item)));
    if (!it) {
      if (a.quantidade === undefined) return R(false, `Não há "${a.item}" no estoque de ${im.nome}.`);
      const r = await contexto.tp("POST", "estoque", { imovel_id: im.id, item: a.item, quantidade: Number(a.quantidade) || 0, minimo: Number(a.minimo) || 0, unidade: a.unidade || "un" });
      return falhou(r) ? R(false, falhou(r)) : R(true, `Adicionei ${a.item} (${Number(a.quantidade) || 0}) ao estoque de ${im.nome}.`, "#/temporada/estoque");
    }
    if (a.minimo !== undefined) await contexto.tp("POST", "estoque", { imovel_id: im.id, item: it.item, quantidade: it.quantidade, minimo: Number(a.minimo) || 0, unidade: it.unidade, categoria: it.categoria });
    if (a.quantidade === undefined && a.somar === undefined) return R(true, `${it.item} em ${im.nome}: ${it.quantidade}${it.unidade ? " " + it.unidade : ""} (mínimo ${it.minimo}).`, "#/temporada/estoque");
    const nova = a.somar !== undefined ? Math.max(0, Number(it.quantidade) + Number(a.somar)) : Number(a.quantidade);
    const r = await contexto.tp("POST", "estoque/conferir", { imovel_id: im.id, itens: [{ id: it.id, quantidade: nova }], origem: "VOZ" });
    return falhou(r) ? R(false, falhou(r)) : R(true, `${it.item} em ${im.nome}: agora ${nova}${it.unidade ? " " + it.unidade : ""}.${(r.dados.baixos || []).length ? " Acabando: " + r.dados.baixos.map(b => b.item).join(", ") + "." : ""}`, "#/temporada/estoque");
  }
  if (tipo === "tp_nota") {
    const im = acharIm(a.imovel);
    const r = await contexto.tp("POST", "notas", { imovel_id: im.id, texto: a.texto, prioridade: ["ALTA", "MEDIA", "BAIXA"].includes(a.prioridade) ? a.prioridade : "MEDIA", categoria: a.categoria });
    return falhou(r) ? R(false, falhou(r)) : R(true, `Anotado em ${im.nome}: ${txt(a.texto, 160)}.`, "#/temporada/melhorias");
  }
  if (tipo === "tp_cotacao") {
    const im = acharIm(a.imovel);
    if (!dia(a.inicio) || !dia(a.fim)) return R(false, "Diga a entrada e a saída.");
    const r = await contexto.tp("GET", `cotacao?imovel=${im.id}&inicio=${a.inicio}&fim=${a.fim}&hospedes=${Number(a.hospedes) || 0}&canal=${a.canal || "direto"}`);
    if (falhou(r)) return R(false, falhou(r));
    const c = r.dados;
    return R(true, `${im.nome}, ${c.noites} noite(s): diárias ${c.diarias}${c.desconto ? `, desconto de ${c.desconto_pct}% (−${c.desconto})` : ""}${c.hospede_extra ? `, hóspede extra ${c.hospede_extra}` : ""}, limpeza ${c.limpeza}. Total ${c.moeda} ${c.total}.${c.ocupado ? " Atenção: essas datas já estão ocupadas." : ""}${c.abaixo_do_minimo ? ` Abaixo do mínimo de ${c.minimo_noites} noites.` : ""}`, "#/temporada/calendario");
  }
  if (tipo === "tp_mercado") {
    const im = acharIm(a.imovel);
    const r = await contexto.tp("POST", `imoveis/${im.id}/mercado`, { pergunta: a.pergunta, periodo: a.periodo });
    return falhou(r) ? R(false, falhou(r)) : R(true, r.dados.resultado, "#/temporada/imoveis");
  }
  return R(false, "Ação desconhecida.");
}

// Executa uma ação pedida por voz usando as rotas normais do painel (com as mesmas permissões e auditoria).
async function executarAcao(a, { marcasOrg, contexto, txt }) {
  const tipo = String(a?.tipo || "");
  if (ACOES_TP.includes(tipo)) return contexto.tp ? executarTemporada({ ...a, tipo }, contexto, txt) : { tipo, ok: false, resumo: "Locação por temporada indisponível aqui." };
  const acharMarca = (nome, obrigatoria = true) => marcaPorNome(marcasOrg, nome, obrigatoria);
  const falhou = r => r.status >= 400 ? (r.dados?.erro || "Não foi possível fazer agora.") : "";
  const canais = Array.isArray(a.canais) && a.canais.length ? a.canais : undefined;
  if (tipo === "criar_semana") {
    const marca = acharMarca(a.marca);
    const hoje = new Date(); const seg = new Date(hoje); seg.setUTCDate(hoje.getUTCDate() - ((hoje.getUTCDay() + 6) % 7) + (a.semana === "esta" ? 0 : 7));
    const r = await contexto.mk("POST", "ia/semana", { marca_id: marca.id, inicio: seg.toISOString().slice(0, 10), quantidade: a.quantidade, canais });
    if (falhou(r)) return { tipo, ok: false, resumo: falhou(r) };
    return { tipo, ok: true, resumo: `${r.dados.criados.length} post(s) criados para ${marca.nome}.`, posts: r.dados.criados.map(c => c.id), artes: a.com_artes !== false, abrir: "#/calendario" };
  }
  if (tipo === "criar_post") {
    const marca = acharMarca(a.marca);
    const leg = await contexto.mk("POST", "ia/legenda", { marca_id: marca.id, tema: txt(a.tema, 600), formato: a.formato, canal: (canais || ["instagram"])[0] });
    if (falhou(leg)) return { tipo, ok: false, resumo: falhou(leg) };
    const s = leg.dados.sugestao;
    const novo = await contexto.mk("POST", "posts", { marca_id: marca.id, canais: canais || ["instagram"], formato: a.formato, data: a.data || new Date().toISOString().slice(0, 10), hora: a.hora || "18:00", ...s });
    if (falhou(novo)) return { tipo, ok: false, resumo: falhou(novo) };
    await contexto.mk("POST", `posts/${novo.dados.id}/acao`, { acao: "enviar" });
    return { tipo, ok: true, resumo: `Post "${s.titulo}" criado para ${marca.nome} e enviado para aprovação.`, posts: [novo.dados.id], artes: a.com_arte !== false, abrir: "#/aprovacoes" };
  }
  if (tipo === "aprovar_posts") {
    const marca = a.marca ? acharMarca(a.marca) : null;
    const l = await contexto.mk("GET", `posts?status=AGUARDANDO${marca ? "&marca=" + marca.id : ""}`);
    let n = 0, erro = "";
    for (const p of (l.dados.posts || []).slice(0, 40)) { const r = await contexto.mk("POST", `posts/${p.id}/acao`, { acao: "aprovar" }); if (falhou(r)) { erro = falhou(r); break; } n++; }
    return { tipo, ok: !erro, resumo: erro || `${n} post(s) aprovados${marca ? " de " + marca.nome : ""}.`, abrir: "#/calendario" };
  }
  if (tipo === "publicar_post") {
    const id = Number(a.post_id);
    const ap = await contexto.mk("POST", `posts/${id}/acao`, { acao: "aprovar" });
    if (falhou(ap)) return { tipo, ok: false, resumo: falhou(ap) };
    if (ap.dados?.publicado) return { tipo, ok: true, resumo: ap.dados.resumo, abrir: "#/calendario" };
    const pub = await contexto.mk("POST", `posts/${id}/publicar`, {});
    if (pub.status < 400) return { tipo, ok: true, resumo: pub.dados.resumo || `Post #${id} publicado.`, abrir: "#/calendario" };
    return { tipo, ok: true, resumo: `Post #${id} aprovado. ${pub.dados?.resumo || pub.dados?.erro || "Ele será publicado no horário marcado."}`, abrir: "#/calendario" };
  }
  if (tipo === "treinar") {
    const campo = CAMPOS_TREINO.includes(a.campo) ? a.campo : "instrucoes";
    const texto = txt(a.texto, 8000);
    if (!texto) return { tipo, ok: false, resumo: "Faltou dizer o que a IA deve aprender." };
    const atual = await contexto.engine("GET", "training");
    if (falhou(atual)) return { tipo, ok: false, resumo: falhou(atual) };
    const antes = String(atual.dados?.dados?.[campo] || "");
    const novoTexto = a.modo === "substituir" ? texto : (antes.trim() ? antes.trimEnd() + "\n\n" + texto : texto);
    const r = await contexto.engine("POST", "training", { treinamento: { [campo]: novoTexto } });
    if (falhou(r)) return { tipo, ok: false, resumo: falhou(r) };
    return { tipo, ok: true, resumo: `Treinamento atualizado (${ROTULO_TREINO[campo]}, versão ${r.dados?.versao ?? "nova"}): ${texto.slice(0, 160)}${texto.length > 160 ? "…" : ""}`, abrir: "#/treinamento" };
  }
  if (tipo === "pausar_ia") {
    const r = await contexto.engine("POST", "pause", { ativa: a.pausar !== false });
    if (falhou(r)) return { tipo, ok: false, resumo: falhou(r) };
    return { tipo, ok: true, resumo: a.pausar !== false ? "IA do WhatsApp pausada para todos os clientes." : "IA do WhatsApp retomada." };
  }
  if (ACOES_GOOGLE.includes(tipo)) {
    const marca = acharMarca(a.marca);
    if (tipo === "atualizar_google") {
      const r = await contexto.mk("POST", "google/sincronizar", { marca_id: marca.id });
      if (falhou(r)) return { tipo, ok: false, resumo: falhou(r) };
      return { tipo, ok: true, resumo: `Google de ${marca.nome} atualizado: ${r.dados.avaliacoes_novas} avaliação(ões) nova(s), ${r.dados.avaliacoes_total} no total.`, abrir: "#/google/avaliacoes" };
    }
    if (tipo === "relatorio_google") {
      const r = await contexto.mk("POST", "relatorios/gerar", { marca_id: marca.id });
      if (falhou(r)) return { tipo, ok: false, resumo: falhou(r) };
      return { tipo, ok: true, resumo: `Relatório de ${marca.nome} pronto:\n${String(r.dados.texto || "").slice(0, 2500)}`, abrir: "#/google/relatorio" };
    }
    if (tipo === "google_resumo") {
      const r = await contexto.mk("GET", `google/resumo?marca=${marca.id}`);
      if (falhou(r)) return { tipo, ok: false, resumo: falhou(r) };
      const d = r.dados, v = d.desempenho_30_dias;
      const partes = [`${marca.nome}: ${d.total ? `nota média ${String(d.nota_media).replace(".", ",")} em ${d.total} avaliações, ${d.sem_resposta} sem resposta e ${d.negativas} com 3 estrelas ou menos.` : "nenhuma avaliação registrada ainda."}`];
      if (d.precisam_de_voce.length) partes.push(`Precisam de uma pessoa: ${d.precisam_de_voce.map(x => `${x.autor} (${x.nota}★) — ${x.motivo}`).join("; ")}.`);
      if (!d.conectada) partes.push("O perfil do Google desta marca ainda não está conectado (Contas conectadas → Conectar Google).");
      else if (v && !v.erro) partes.push(`Últimos 30 dias: o perfil apareceu ${v.totais.visualizacoes} vezes, ${v.totais.ligacoes} ligações, ${v.totais.rotas} pedidos de rota, ${v.totais.cliques_site} cliques no site e ${v.totais.mensagens} mensagens.${v.palavras.length ? " Buscas que mais trouxeram pessoas: " + v.palavras.slice(0, 5).map(p => p.palavra).join(", ") + "." : ""}`);
      else if (v && v.erro) partes.push(`Não consegui ler o desempenho agora: ${v.erro}`);
      if (d.ultimo_relatorio) partes.push(`Último relatório (semana de ${d.ultimo_relatorio.semana}): ${String(d.ultimo_relatorio.texto).slice(0, 700)}`);
      return { tipo, ok: true, resumo: partes.join("\n"), abrir: "#/google/avaliacoes" };
    }
    // responder_avaliacoes: escreve a resposta de cada avaliação sem resposta; publica só se a pessoa pediu
    // (e nunca publica sozinha as que precisam de uma pessoa).
    const l = await contexto.mk("GET", `avaliacoes?marca=${marca.id}`);
    if (falhou(l)) return { tipo, ok: false, resumo: falhou(l) };
    const pend = (l.dados.avaliacoes || []).filter(x => x.status === "PENDENTE").slice(0, 15);
    if (!pend.length) return { tipo, ok: true, resumo: `Nenhuma avaliação sem resposta em ${marca.nome}.`, abrir: "#/google/avaliacoes" };
    let prontas = 0, publicadas = 0; const paraVoce = [], erros = [];
    for (const x of pend) {
      let analise = null; try { analise = JSON.parse(x.analise || "null"); } catch { analise = null; }
      let resposta = x.resposta_sugerida;
      if (!resposta || !analise) {
        const s = await contexto.mk("POST", `avaliacoes/${x.id}/sugerir`, {});
        if (falhou(s)) { erros.push(falhou(s)); break; }
        resposta = s.dados.resposta; analise = s.dados.analise;
      }
      prontas++;
      if (analise && (analise.precisa_humano || analise.viola_politica)) { paraVoce.push(`${x.autor} (${x.nota}★): ${analise.motivo_humano || "pode violar as regras do Google — " + analise.politica}`); continue; }
      if (a.publicar === true && resposta) {
        const r = await contexto.mk("POST", `avaliacoes/${x.id}/responder`, { resposta });
        if (falhou(r)) erros.push(falhou(r)); else publicadas++;
      }
    }
    const resumo = [a.publicar === true ? `${publicadas} resposta(s) publicada(s) em ${marca.nome}.` : `${prontas} resposta(s) prontas para revisão em ${marca.nome} (Google Meu Negócio → Avaliações).`,
      paraVoce.length ? `Estas precisam de uma pessoa antes: ${paraVoce.join("; ")}.` : "", erros.length ? `Problema: ${erros[0]}` : ""].filter(Boolean).join(" ");
    return { tipo, ok: !erros.length, resumo, abrir: "#/google/avaliacoes" };
  }
  return { tipo: tipo || "acao", ok: false, resumo: "Ação desconhecida." };
}

export async function apiAssistente(request, env, k, orgId, papel, resto, contexto) {
  const { json, lerCorpo, txt } = k;
  const idioma = idiomaDe(request.headers.get("x-denia-idioma"));
  const falaEm = `IDIOMA: fale e escreva sempre em ${IDIOMAS[idioma]}; se a pessoa falar em outro idioma, acompanhe o idioma dela.`;
  // Preparar, executar e ler o painel não usam a OpenAI.
  if (!chave(env) && !["assistente/preparar", "assistente/executar", "assistente/contexto"].includes(resto)) { const s = semChave(); return json(s.corpo, s.status); }
  try {
    if (resto === "assistente/transcrever" && request.method === "POST") {
      const tipo = request.headers.get("content-type") || "audio/webm";
      const audio = await request.arrayBuffer();
      if (audio.byteLength > 8 * 1024 * 1024) return json({ erro: "Áudio longo demais (máximo de cerca de 2 minutos)." }, 413);
      const f = new FormData();
      f.append("file", new Blob([audio], { type: tipo.split(";")[0] }), "fala." + (tipo.includes("mp4") ? "mp4" : tipo.includes("ogg") ? "ogg" : "webm"));
      f.append("model", String(env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe"));
      f.append("language", idioma.slice(0, 2));
      const d = await openai(env, "audio/transcriptions", f, { timeout: 45000 });
      return json({ texto: String(d?.text || "").trim() });
    }
    if (resto === "assistente/falar" && request.method === "POST") {
      const l = await lerCorpo(request, 6000);
      if (l.erro) return l.erro;
      const texto = txt(l.corpo.texto, 1500);
      if (!texto) return json({ erro: "Nada para falar." }, 400);
      // Voz escolhida pela empresa: a voz clonada da pessoa (ElevenLabs) ou uma voz natural da OpenAI.
      const r = await falarComVoz(env, k, orgId, texto, { idiomaNome: IDIOMAS[idioma], aoVivo: l.corpo.ao_vivo === true, openai });
      return new Response(r.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
    }
    if (resto === "assistente/conversa" && request.method === "POST") {
      const l = await lerCorpo(request, 40000);
      if (l.erro) return l.erro;
      const msgs = (Array.isArray(l.corpo.mensagens) ? l.corpo.mensagens : []).slice(-16)
        .map(x => ({ papel: x.papel === "denia" ? "denia" : "usuario", texto: txt(x.texto, 3000) })).filter(x => x.texto);
      if (!msgs.length) return json({ erro: "Escreva ou fale alguma coisa." }, 400);
      await garantir(env);
      const marcasOrg = (await env.DB.prepare("SELECT id, nome FROM plt_mk_marcas WHERE org_id=? AND ativa=1 ORDER BY nome").bind(orgId).all())?.results || [];
      const r = await iaJSONConversa(env, `Você é a DENIA, a superinteligência da plataforma DENIA, conversando com a equipe da empresa "${contexto.empresa}" dentro do painel (não com clientes). O perfil de quem fala é ${papel}.
Seja uma colega brilhante: direta, calorosa, prática, com linguagem impecável. ${falaEm} A resposta normalmente é falada em voz: frases curtas e naturais (até 5), sem listas longas, sem símbolos, sem markdown.
Você responde sobre tudo do painel usando os DADOS DO PAINEL: WhatsApp (conversas, atendimentos, profissionais), treinamento da IA, aprendizados, marcas e perfis de Instagram, Facebook e Google, posts e aprovações. Nunca invente números, conversas, clientes ou resultados que não estão nos dados.
${ESPECIALISTA_DIGITAL}
${ESPECIALISTA_TEMPORADA}
Você também EXECUTA ações quando a pessoa pede claramente. Ações disponíveis (campo "acoes"):
- {"tipo":"criar_semana","marca":"nome da marca","canais":["instagram","facebook","google"],"quantidade":3,"semana":"esta"|"proxima","com_artes":true} — planeja e cria os posts da semana (legendas, hashtags e as imagens).
- {"tipo":"criar_post","marca":"nome","canais":["instagram"],"tema":"sobre o que é","formato":"post"|"carrossel"|"story"|"reels","data":"AAAA-MM-DD","hora":"HH:MM","com_arte":true} — cria um post com texto e imagem.
- {"tipo":"aprovar_posts","marca":"nome ou vazio para todas"} — aprova os posts que aguardam aprovação (perfil ADMIN ou OWNER).
- {"tipo":"publicar_post","post_id":123} — aprova e publica agora no Instagram e no Facebook, se a marca estiver conectada (Contas conectadas → Conectar Instagram e Facebook). Se não estiver, explique que o post fica aprovado e que basta conectar a marca. No Google Meu Negócio é igual: com a marca conectada (Contas conectadas → Conectar Google) os posts saem no perfil e as respostas às avaliações são publicadas direto no Google.
- {"tipo":"treinar","campo":"instrucoes"|"servicos"|"regras"|"precos"|"procedimentos"|"informacoes"|"exemplos","modo":"acrescentar"|"substituir","texto":"o texto do treinamento, bem escrito, na voz de instrução para a IA do WhatsApp"} — muda o treinamento da IA que atende os clientes no WhatsApp (perfil ADMIN ou OWNER). Prefira "acrescentar". Use "substituir" só se a pessoa pedir para trocar tudo daquele campo; nesse caso o texto deve ser o campo completo, já reescrito. Cada mudança vira uma nova versão (dá para voltar).
- {"tipo":"pausar_ia","pausar":true|false} — pausa ou retoma a IA do WhatsApp para todos os clientes (perfil ADMIN ou OWNER).
- {"tipo":"google_resumo","marca":"nome"} — lê o Google Meu Negócio da marca: nota, avaliações sem resposta, as que precisam de uma pessoa, desempenho dos últimos 30 dias, buscas e o último relatório. Use para responder perguntas sobre o Google com dados reais.
- {"tipo":"atualizar_google","marca":"nome"} — busca agora as avaliações e o desempenho no Google.
- {"tipo":"responder_avaliacoes","marca":"nome","publicar":false} — escreve uma resposta específica para cada avaliação sem resposta. publicar=true só quando a pessoa pedir claramente para publicar; as avaliações graves ou que podem violar as regras do Google nunca são publicadas sozinhas — avise quais precisam de uma pessoa e o motivo.
- {"tipo":"relatorio_google","marca":"nome"} — gera agora o relatório de especialista da marca (o que melhorou, o que precisa de atenção, buscas e plano da semana).
LOCAÇÃO POR TEMPORADA (imóveis no Airbnb, Booking e Vrbo) — use o nome do imóvel; datas sempre AAAA-MM-DD:
- {"tipo":"tp_resumo","imovel":"nome ou vazio"} — ocupação, receita, próximas entradas, estoque acabando.
- {"tipo":"tp_precos","imovel":"nome","de":"AAAA-MM-DD","ate":"AAAA-MM-DD","preco":800,"minimo":3} — muda a diária e/ou o mínimo de noites de um período (vai para as plataformas conectadas). "voltar_ao_base":true volta ao preço normal.
- {"tipo":"tp_disponibilidade","imovel":"nome","de":"...","ate":"...","bloquear":true|false} — fecha ou abre datas.
- {"tipo":"tp_config","imovel":"nome","preco_base":700,"preco_fds":900,"taxa_limpeza":150,"desconto_semanal":10,"desconto_mensal":25,"minimo_noites":2,"maximo_noites":30,"taxa_hospede_extra":50,"hospedes_incluidos":4} — muda a configuração geral (só os campos pedidos).
- {"tipo":"tp_estoque","imovel":"nome","item":"papel higiênico","quantidade":10|"somar":-2,"minimo":6} — consulta (sem item ou sem quantidade) ou atualiza o estoque.
- {"tipo":"tp_nota","imovel":"nome","texto":"o que melhorar","prioridade":"ALTA"|"MEDIA"|"BAIXA"} — anota uma melhoria ou manutenção.
- {"tipo":"tp_cotacao","imovel":"nome","inicio":"...","fim":"...","hospedes":4} — calcula quanto fica a estadia.
- {"tipo":"tp_mercado","imovel":"nome","pergunta":"opcional","periodo":"opcional"} — pesquisa na internet as diárias da região, se o anúncio aparece no Google e se o preço está bom.
Regras: só inclua uma ação quando o pedido for claro; se faltar algo essencial (por exemplo a marca, havendo mais de uma), pergunte em vez de agir. Marcas existentes: ${marcasOrg.map(m => m.nome).join(", ") || "nenhuma cadastrada"}. Na "resposta", diga em poucas palavras o que você está fazendo (no futuro imediato: "Vou criar..."), porque o resultado aparece logo depois.
Responda SEMPRE em JSON: {"resposta":"texto para falar","acoes":[]}
DADOS DO PAINEL (agora):
${contexto.dados}`, msgs, 1600);
      const acoes = (Array.isArray(r?.acoes) ? r.acoes : []).slice(0, 4);
      // Modo assistido: a tela executa cada ação à vista (menus abrindo, campos sendo preenchidos), com pausa e parada.
      if (l.corpo.assistido) {
        const plano = [];
        for (const a of acoes) {
          try { plano.push(prepararAcao(a, marcasOrg, txt)); }
          catch (e) { plano.push({ tipo: String(a?.tipo || "acao"), erro: e?.message || "Não foi possível preparar." }); }
        }
        return json({ resposta: txt(r?.resposta, 3000) || (plano.length ? "Vou fazer agora." : "Desculpe, não consegui responder agora. Pode repetir?"), plano });
      }
      const feitas = [];
      for (const a of acoes) {
        try { feitas.push(await executarAcao(a, { env, orgId, papel, marcasOrg, contexto, txt })); }
        catch (e) { feitas.push({ tipo: String(a?.tipo || "acao"), ok: false, resumo: e?.message || "Não foi possível fazer agora." }); }
      }
      const resposta = txt(r?.resposta, 3000) || (feitas.length ? "Pronto." : "Desculpe, não consegui responder agora. Pode repetir?");
      return json({ resposta, acoes: feitas });
    }
    // Conversa de voz ao vivo (como o modo de voz do ChatGPT): o navegador fala direto com a voz em tempo real
    // da OpenAI usando uma chave temporária de 1 minuto; a chave de verdade nunca sai do servidor.
    if (resto === "assistente/ao-vivo" && request.method === "POST") {
      await garantir(env);
      const marcasOrg = (await env.DB.prepare("SELECT id, nome FROM plt_mk_marcas WHERE org_id=? AND ativa=1 ORDER BY nome").bind(orgId).all())?.results || [];
      const modelo = String(env.OPENAI_REALTIME_MODEL || "gpt-realtime").trim();
      const instructions = `Você é a DENIA, a superinteligência da plataforma DENIA, numa conversa de VOZ AO VIVO com a equipe da empresa "${contexto.empresa}" (não com clientes). O perfil de quem fala é ${papel}.
Fale como uma colega brilhante ao telefone: natural, calorosa e direta. ${falaEm} frases curtas; nada de listas, símbolos ou markdown. Se for interrompida, pare e escute.
Use os DADOS DO PAINEL para responder sobre conversas do WhatsApp, atendimentos, profissionais, treinamento, aprendizados, marcas e perfis de Instagram, Facebook e Google, posts e aprovações. Nunca invente números ou fatos que não estão nos dados; se precisar de dados mais novos, use a ferramenta dados_do_painel.
${ESPECIALISTA_DIGITAL}
${ESPECIALISTA_TEMPORADA}
Para assuntos de fora (notícias, concorrentes, tendências, preços de mercado, qualquer dúvida do mundo), use a ferramenta pesquisar_web e conte o resultado de forma curta, citando de onde veio.
Quando a pessoa pedir claramente uma ação, use a ferramenta certa (criar_semana, criar_post, aprovar_posts, publicar_post, treinar, pausar_ia, google_resumo, atualizar_google, responder_avaliacoes, relatorio_google). Para perguntas sobre o Google de uma marca (avaliações, nota, ligações, buscas, posição), use google_resumo antes de responder. Antes, diga numa frase curta o que vai fazer ("Vou abrir o treinamento e acrescentar isso"); a pessoa vê você fazendo na tela e pode pausar ou parar. Quando a ferramenta devolver o resultado, conte em uma frase. Se faltar algo essencial (por exemplo qual marca, havendo mais de uma), pergunte antes.
Locação por temporada: para preços, disponibilidade, estoque, melhorias, cotação e mercado use as ferramentas tp_*. Datas em AAAA-MM-DD (se a pessoa disser "próximo fim de semana", calcule a partir da data de hoje). Antes de mudar preço ou fechar datas, confirme o imóvel e o período em uma frase.
Treinamento: prefira acrescentar; substituir só se pedirem para trocar tudo daquele campo (aí o texto é o campo inteiro já reescrito). Escreva o texto do treinamento como instrução clara para a IA que atende os clientes no WhatsApp.
Publicar: com a marca conectada (Contas conectadas → Conectar Instagram e Facebook), os posts aprovados saem sozinhos no horário marcado e publicar_post publica na hora. Sem conexão, o post fica aprovado. No Google Meu Negócio é igual: com a marca conectada (Contas conectadas → Conectar Google) os posts saem no perfil e as respostas às avaliações são publicadas direto no Google. Diga isso com honestidade.
Marcas existentes: ${marcasOrg.map(m => m.nome).join(", ") || "nenhuma cadastrada"}.
DADOS DO PAINEL (no início da conversa):
${contexto.dados}`;
      const marca = { type: "string", description: "Nome da marca" };
      const imovelP = { type: "string", description: "Nome do imóvel de temporada" }, dataP = { type: "string", description: "AAAA-MM-DD" };
      const canais = { type: "array", items: { type: "string", enum: ["instagram", "facebook", "google"] } };
      const tools = [
        { type: "function", name: "criar_semana", description: "Planeja e cria os posts da semana de uma marca (legendas, hashtags e imagens).", parameters: { type: "object", properties: { marca, canais, quantidade: { type: "integer", minimum: 1, maximum: 14 }, semana: { type: "string", enum: ["esta", "proxima"] }, com_artes: { type: "boolean" } }, required: ["marca"] } },
        { type: "function", name: "criar_post", description: "Cria um post com texto e imagem e envia para aprovação.", parameters: { type: "object", properties: { marca, canais, tema: { type: "string" }, formato: { type: "string", enum: ["post", "carrossel", "story", "reels"] }, data: { type: "string", description: "AAAA-MM-DD" }, hora: { type: "string", description: "HH:MM" }, com_arte: { type: "boolean" } }, required: ["marca", "tema"] } },
        { type: "function", name: "aprovar_posts", description: "Aprova os posts que aguardam aprovação (de uma marca ou de todas).", parameters: { type: "object", properties: { marca } } },
        { type: "function", name: "publicar_post", description: "Deixa um post aprovado e pronto para publicar.", parameters: { type: "object", properties: { post_id: { type: "integer" } }, required: ["post_id"] } },
        { type: "function", name: "treinar", description: "Muda o treinamento da IA que atende os clientes no WhatsApp.", parameters: { type: "object", properties: { campo: { type: "string", enum: ["instrucoes", "servicos", "regras", "precos", "procedimentos", "informacoes", "exemplos"] }, modo: { type: "string", enum: ["acrescentar", "substituir"] }, texto: { type: "string" } }, required: ["campo", "texto"] } },
        { type: "function", name: "pausar_ia", description: "Pausa (pausar=true) ou retoma (pausar=false) a IA do WhatsApp para todos os clientes.", parameters: { type: "object", properties: { pausar: { type: "boolean" } }, required: ["pausar"] } },
        { type: "function", name: "google_resumo", description: "Lê o Google Meu Negócio de uma marca: nota, avaliações sem resposta, as que precisam de uma pessoa, desempenho dos últimos 30 dias, buscas e o último relatório.", parameters: { type: "object", properties: { marca }, required: ["marca"] } },
        { type: "function", name: "atualizar_google", description: "Busca agora as avaliações e o desempenho no Google de uma marca.", parameters: { type: "object", properties: { marca }, required: ["marca"] } },
        { type: "function", name: "responder_avaliacoes", description: "Escreve uma resposta específica para cada avaliação sem resposta. publicar=true só se a pessoa pedir claramente; as graves ou que podem violar as regras do Google nunca são publicadas sozinhas.", parameters: { type: "object", properties: { marca, publicar: { type: "boolean" } }, required: ["marca"] } },
        { type: "function", name: "relatorio_google", description: "Gera agora o relatório de especialista da marca (Google Meu Negócio e redes).", parameters: { type: "object", properties: { marca }, required: ["marca"] } },
        { type: "function", name: "pesquisar_web", description: "Pesquisa na internet, ao vivo, e devolve um resumo com as fontes.", parameters: { type: "object", properties: { pergunta: { type: "string" } }, required: ["pergunta"] } },
        { type: "function", name: "tp_resumo", description: "Locação por temporada: ocupação, receita, próximas entradas, estoque acabando (de um imóvel ou de todos).", parameters: { type: "object", properties: { imovel: imovelP } } },
        { type: "function", name: "tp_precos", description: "Muda a diária e/ou o mínimo de noites de um período de um imóvel (vai para Airbnb/Booking/Vrbo conectados). voltar_ao_base volta ao preço normal.", parameters: { type: "object", properties: { imovel: imovelP, de: dataP, ate: dataP, preco: { type: "number" }, minimo: { type: "integer" }, voltar_ao_base: { type: "boolean" } }, required: ["imovel", "de", "ate"] } },
        { type: "function", name: "tp_disponibilidade", description: "Fecha (bloquear=true) ou abre datas de um imóvel.", parameters: { type: "object", properties: { imovel: imovelP, de: dataP, ate: dataP, bloquear: { type: "boolean" } }, required: ["imovel", "de", "ate"] } },
        { type: "function", name: "tp_config", description: "Muda a configuração geral de preço de um imóvel: diária, fim de semana, taxa de limpeza, descontos semanal/mensal (%), mínimo/máximo de noites, hóspede extra.", parameters: { type: "object", properties: { imovel: imovelP, preco_base: { type: "number" }, preco_fds: { type: "number" }, taxa_limpeza: { type: "number" }, desconto_semanal: { type: "number" }, desconto_mensal: { type: "number" }, minimo_noites: { type: "integer" }, maximo_noites: { type: "integer" }, taxa_hospede_extra: { type: "number" }, hospedes_incluidos: { type: "integer" } }, required: ["imovel"] } },
        { type: "function", name: "tp_estoque", description: "Consulta ou atualiza o estoque de um imóvel. Sem item: lista tudo. quantidade = contagem nova; somar = soma/subtrai.", parameters: { type: "object", properties: { imovel: imovelP, item: { type: "string" }, quantidade: { type: "number" }, somar: { type: "number" }, minimo: { type: "number" } }, required: ["imovel"] } },
        { type: "function", name: "tp_nota", description: "Anota uma melhoria ou manutenção para um imóvel.", parameters: { type: "object", properties: { imovel: imovelP, texto: { type: "string" }, prioridade: { type: "string", enum: ["ALTA", "MEDIA", "BAIXA"] } }, required: ["imovel", "texto"] } },
        { type: "function", name: "tp_cotacao", description: "Calcula quanto fica uma estadia (diárias, descontos, limpeza, hóspede extra).", parameters: { type: "object", properties: { imovel: imovelP, inicio: dataP, fim: dataP, hospedes: { type: "integer" } }, required: ["imovel", "inicio", "fim"] } },
        { type: "function", name: "tp_mercado", description: "Pesquisa na internet diárias de imóveis parecidos na região, se o anúncio aparece no Google, eventos e se o preço está bom.", parameters: { type: "object", properties: { imovel: imovelP, pergunta: { type: "string" }, periodo: { type: "string" } }, required: ["imovel"] } },
        { type: "function", name: "dados_do_painel", description: "Busca os dados mais recentes do painel (conversas, atendimentos, posts, treinamento).", parameters: { type: "object", properties: {} } }
      ];
      // Com a voz da pessoa (ElevenLabs), a conversa ao vivo devolve texto e o painel fala com a voz clonada.
      const cfgVoz = await configVoz(env, k, orgId);
      const minhaVoz = cfgVoz.provedor === "elevenlabs" && cfgVoz.ao_vivo_com_minha_voz;
      const sessao = { type: "realtime", model: modelo, instructions: instructions + (minhaVoz ? "\nSuas respostas serão lidas em voz alta: escreva como quem fala, frases curtas, sem listas nem símbolos." : ""), tools, tool_choice: "auto",
        ...(minhaVoz ? { output_modalities: ["text"] } : {}),
        audio: { input: { transcription: { model: String(env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe"), language: idioma.slice(0, 2) }, turn_detection: { type: "semantic_vad", eagerness: "high" }, noise_reduction: { type: "near_field" } }, ...(minhaVoz ? {} : { output: { voice: cfgVoz.voz_openai } }) } };
      const d = await openai(env, "realtime/client_secrets", { expires_after: { anchor: "created_at", seconds: 120 }, session: sessao }, { timeout: 20000 });
      const chaveTemp = d?.value || d?.client_secret?.value;
      if (!chaveTemp) return json({ erro: "A voz ao vivo não respondeu. Tente de novo." }, 502);
      return json({ chave: chaveTemp, url: "https://api.openai.com/v1/realtime/calls", modelo, minha_voz: minhaVoz });
    }
    if (resto === "assistente/preparar" && request.method === "POST") {
      const l = await lerCorpo(request, 20000);
      if (l.erro) return l.erro;
      await garantir(env);
      const marcasOrg = (await env.DB.prepare("SELECT id, nome FROM plt_mk_marcas WHERE org_id=? AND ativa=1 ORDER BY nome").bind(orgId).all())?.results || [];
      try { return json(prepararAcao(l.corpo.acao || {}, marcasOrg, txt)); }
      catch (e) { return json({ tipo: String(l.corpo.acao?.tipo || "acao"), erro: e?.message || "Não foi possível preparar." }); }
    }
    if (resto === "assistente/pesquisar" && request.method === "POST") {
      const l = await lerCorpo(request, 4000);
      if (l.erro) return l.erro;
      const pergunta = txt(l.corpo.pergunta, 600);
      if (!pergunta) return json({ erro: "Faltou a pergunta." }, 400);
      const d = await openai(env, "responses", {
        model: String(env.OPENAI_MODEL || MODELO_TEXTO).trim(), tools: [{ type: "web_search" }],
        instructions: `Pesquise na internet e responda em ${IDIOMAS[idioma]}, em até 6 frases objetivas, com números e datas quando houver. No fim, cite as fontes pelo nome do site.`,
        input: [{ role: "user", content: [{ type: "input_text", text: pergunta }] }], max_output_tokens: 900, store: false
      }, { timeout: 60000 });
      return json({ resultado: textoDaResposta(d).trim() || "Não encontrei nada confiável sobre isso." });
    }
    if (resto === "assistente/contexto" && request.method === "POST") return json({ dados: contexto.dados });
    if (resto === "assistente/executar" && request.method === "POST") {
      const l = await lerCorpo(request, 20000);
      if (l.erro) return l.erro;
      await garantir(env);
      const marcasOrg = (await env.DB.prepare("SELECT id, nome FROM plt_mk_marcas WHERE org_id=? AND ativa=1 ORDER BY nome").bind(orgId).all())?.results || [];
      const a = l.corpo.acao || {};
      try { return json(await executarAcao(a, { env, orgId, papel, marcasOrg, contexto, txt })); }
      catch (e) { return json({ tipo: String(a?.tipo || "acao"), ok: false, resumo: e?.message || "Não foi possível fazer agora." }); }
    }
    return json({ erro: "Rota não encontrada." }, 404);
  } catch (e) {
    console.error("assistente", e?.message);
    return json({ erro: e?.message || "Não foi possível responder agora." }, 502);
  }
}
