// DENIA Platform — Locação por temporada (Airbnb, Booking.com e Vrbo).
// Duas formas de conexão, que se completam:
//  1) Calendário (iCal): funciona hoje com qualquer plataforma. A DENIA importa o calendário de cada
//     anúncio e gera um calendário único para colar nas outras — acaba com reserva dupla.
//  2) Conexão oficial pelo Channex (gerenciador de canais certificado pelo Airbnb, Booking.com e Vrbo):
//     preços, taxas, disponibilidade, reservas e mensagens em tempo real. Variável CHANNEX_API_KEY
//     (CHANNEX_STAGING=1 para testes). O anfitrião liga cada plataforma com o login dela, pela tela do Channex.
// A IA responde os hóspedes com o treinamento de cada imóvel e o jeito de escrever do anfitrião.

import { openaiResposta, openaiBruto } from "./marketing.js";

export const DDL_TEMPORADA = [
  `CREATE TABLE IF NOT EXISTS plt_tp_imoveis (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, nome TEXT NOT NULL, endereco TEXT, cidade TEXT, capacidade INTEGER, quartos INTEGER, banheiros INTEGER, checkin TEXT, checkout TEXT, moeda TEXT NOT NULL DEFAULT 'BRL', preco_base REAL, preco_fds REAL, minimo_noites INTEGER, taxa_limpeza REAL, ajustes TEXT, treinamento TEXT, anuncio TEXT, ia_modo TEXT NOT NULL DEFAULT 'SUGERIR', ical_token TEXT, channex_property TEXT, channex_room TEXT, channex_rates TEXT, ativo INTEGER NOT NULL DEFAULT 1, criado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_tp_imoveis_org ON plt_tp_imoveis(org_id)`,
  `CREATE TABLE IF NOT EXISTS plt_tp_calendarios (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, imovel_id INTEGER NOT NULL, canal TEXT NOT NULL, url TEXT NOT NULL, ultimo_ms INTEGER, erro TEXT, eventos INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_tp_cal_ultimo ON plt_tp_calendarios(ultimo_ms)`,
  `CREATE TABLE IF NOT EXISTS plt_tp_reservas (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, imovel_id INTEGER NOT NULL, canal TEXT NOT NULL, externo_id TEXT NOT NULL, tipo TEXT NOT NULL DEFAULT 'RESERVA', status TEXT NOT NULL DEFAULT 'CONFIRMADA', hospede TEXT, hospedes INTEGER, inicio TEXT NOT NULL, fim TEXT NOT NULL, valor REAL, moeda TEXT, contato TEXT, notas TEXT, origem TEXT, calendario_id INTEGER, risco TEXT, criado_ms INTEGER NOT NULL, atualizado_ms INTEGER NOT NULL, UNIQUE(org_id, imovel_id, canal, externo_id))`,
  `CREATE INDEX IF NOT EXISTS idx_tp_res_periodo ON plt_tp_reservas(org_id, inicio)`,
  `CREATE INDEX IF NOT EXISTS idx_tp_res_imovel ON plt_tp_reservas(imovel_id, inicio)`,
  `CREATE TABLE IF NOT EXISTS plt_tp_precos (imovel_id INTEGER NOT NULL, data TEXT NOT NULL, org_id INTEGER NOT NULL, preco REAL, minimo INTEGER, fechado INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (imovel_id, data))`,
  `CREATE TABLE IF NOT EXISTS plt_tp_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, imovel_id INTEGER, reserva_id INTEGER, canal TEXT, direcao TEXT NOT NULL, origem TEXT NOT NULL, texto TEXT, traducao TEXT, externo_id TEXT UNIQUE, status TEXT, criado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_tp_msgs_reserva ON plt_tp_msgs(org_id, reserva_id, id)`,
  `CREATE TABLE IF NOT EXISTS plt_tp_limpezas (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, imovel_id INTEGER NOT NULL, reserva_id INTEGER UNIQUE, data TEXT NOT NULL, responsavel TEXT, status TEXT NOT NULL DEFAULT 'PENDENTE', criado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_tp_limp_data ON plt_tp_limpezas(org_id, data)`,
  `CREATE TABLE IF NOT EXISTS plt_tp_notas (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, imovel_id INTEGER NOT NULL, texto TEXT NOT NULL, categoria TEXT, prioridade TEXT NOT NULL DEFAULT 'MEDIA', status TEXT NOT NULL DEFAULT 'ABERTA', custo REAL, autor TEXT, criado_ms INTEGER NOT NULL, feito_ms INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_tp_notas ON plt_tp_notas(org_id, imovel_id, status)`,
  `CREATE TABLE IF NOT EXISTS plt_tp_estoque (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, imovel_id INTEGER NOT NULL, item TEXT NOT NULL, categoria TEXT, quantidade REAL NOT NULL DEFAULT 0, minimo REAL NOT NULL DEFAULT 0, unidade TEXT, atualizado_ms INTEGER, atualizado_por TEXT, UNIQUE(imovel_id, item))`,
  `CREATE TABLE IF NOT EXISTS plt_tp_estoque_mov (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, imovel_id INTEGER NOT NULL, item_id INTEGER NOT NULL, antes REAL, depois REAL, origem TEXT, limpeza_id INTEGER, autor TEXT, ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_tp_est_mov ON plt_tp_estoque_mov(org_id, imovel_id, ms)`,
  `CREATE TABLE IF NOT EXISTS plt_tp_fotos (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, imovel_id INTEGER NOT NULL, mime TEXT NOT NULL, dados TEXT NOT NULL, legenda TEXT, ordem INTEGER NOT NULL DEFAULT 0, criado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_tp_fotos ON plt_tp_fotos(org_id, imovel_id, ordem)`,
  `CREATE TABLE IF NOT EXISTS plt_tp_comodos (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, imovel_id INTEGER NOT NULL, nome TEXT NOT NULL, tipo TEXT, ordem INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_tp_comodos ON plt_tp_comodos(org_id, imovel_id, ordem)`,
  `CREATE TABLE IF NOT EXISTS plt_tp_inventario (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, imovel_id INTEGER NOT NULL, comodo_id INTEGER NOT NULL, item TEXT NOT NULL, icone TEXT, quantidade INTEGER NOT NULL DEFAULT 1, estado TEXT NOT NULL DEFAULT 'OK', valor REAL, obs TEXT, atualizado_ms INTEGER, atualizado_por TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_tp_inv ON plt_tp_inventario(org_id, imovel_id, comodo_id)`,
  `CREATE TABLE IF NOT EXISTS plt_tp_checklist (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, imovel_id INTEGER NOT NULL, comodo_id INTEGER, tarefa TEXT NOT NULL, icone TEXT, ordem INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_tp_check ON plt_tp_checklist(org_id, imovel_id, comodo_id)`,
  `CREATE TABLE IF NOT EXISTS plt_tp_avaliacoes (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, imovel_id INTEGER, reserva_id INTEGER, canal TEXT, externo_id TEXT UNIQUE, autor TEXT, nota REAL, nota_max REAL, texto TEXT, data TEXT, resposta TEXT, resposta_sugerida TEXT, status TEXT NOT NULL DEFAULT 'PENDENTE', analise TEXT, criado_ms INTEGER NOT NULL, respondida_ms INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_tp_aval ON plt_tp_avaliacoes(org_id, status)`
];
// Colunas novas (bancos criados antes desta versão).
export const ALTERS_TEMPORADA = [
  ...["desconto_semanal REAL", "desconto_mensal REAL", "hospedes_incluidos INTEGER", "taxa_hospede_extra REAL", "taxa_pet REAL", "maximo_noites INTEGER", "antecedencia_dias INTEGER", "comodidades TEXT", "precos_modo TEXT", "janela_meses INTEGER", "taxas_plataforma TEXT"].map(c => "ALTER TABLE plt_tp_imoveis ADD COLUMN " + c),
  ...["taxa_limpeza REAL", "taxas REAL", "codigo TEXT"].map(c => "ALTER TABLE plt_tp_reservas ADD COLUMN " + c),
  ...["estoque_ok_ms INTEGER", "aviso_ms INTEGER", "obs TEXT", "inicio_ms INTEGER", "fim_ms INTEGER", "resumo TEXT", "data_saida TEXT"].map(c => "ALTER TABLE plt_tp_limpezas ADD COLUMN " + c),
  "ALTER TABLE plt_tp_fotos ADD COLUMN limpeza_id INTEGER", "ALTER TABLE plt_tp_fotos ADD COLUMN transcricao TEXT"
];
// Comodidades (as mesmas categorias que Airbnb e Booking usam), para marcar no imóvel e a IA usar nas respostas.
export const COMODIDADES = {
  "Essenciais": ["Wi-Fi", "Ar-condicionado", "Ventilador", "Aquecimento", "Roupa de cama", "Toalhas", "Sabonete e xampu", "Papel higiênico", "Cabides", "Ferro de passar", "Secador de cabelo"],
  "Cozinha": ["Cozinha completa", "Geladeira", "Micro-ondas", "Fogão", "Forno", "Cafeteira", "Liquidificador", "Utensílios de cozinha", "Louças e talheres", "Lava-louças", "Churrasqueira"],
  "Lazer": ["TV", "Smart TV / streaming", "Piscina", "Hidromassagem", "Varanda", "Vista para o mar", "Jardim", "Área de jogos", "Academia", "Sauna"],
  "Lavanderia": ["Máquina de lavar", "Secadora", "Varal"],
  "Estacionamento e acesso": ["Estacionamento grátis", "Garagem coberta", "Elevador", "Entrada independente", "Fechadura eletrônica", "Portaria 24h", "Acessível para cadeira de rodas"],
  "Família e pets": ["Berço", "Cadeira de bebê", "Aceita pets", "Adequado para crianças"],
  "Trabalho": ["Espaço de trabalho", "Mesa e cadeira", "Wi-Fi rápido (fibra)"],
  "Segurança": ["Detector de fumaça", "Extintor", "Kit de primeiros socorros", "Câmeras na área externa", "Cofre"],
  "Localização": ["Pé na areia", "Perto da praia", "Perto do centro", "Perto de mercado", "Perto de transporte público"]
};
// Lista inicial de estoque (produtos de limpeza e reposição) — o anfitrião ajusta.
export const ESTOQUE_PADRAO = [
  ["Papel higiênico", "Banheiro", 12, 6, "rolos"], ["Sabonete", "Banheiro", 6, 3, "un"], ["Xampu", "Banheiro", 4, 2, "un"], ["Condicionador", "Banheiro", 4, 2, "un"],
  ["Detergente", "Limpeza", 3, 1, "un"], ["Esponja", "Limpeza", 6, 2, "un"], ["Desinfetante", "Limpeza", 2, 1, "un"], ["Água sanitária", "Limpeza", 2, 1, "un"],
  ["Multiuso", "Limpeza", 2, 1, "un"], ["Saco de lixo", "Limpeza", 30, 10, "un"], ["Pano de chão", "Limpeza", 3, 1, "un"],
  ["Café", "Cozinha", 2, 1, "pct"], ["Açúcar", "Cozinha", 2, 1, "pct"], ["Filtro de café", "Cozinha", 2, 1, "cx"], ["Papel toalha", "Cozinha", 4, 2, "rolos"],
  ["Jogo de cama (troca)", "Enxoval", 3, 2, "jogos"], ["Toalha de banho", "Enxoval", 6, 4, "un"], ["Toalha de rosto", "Enxoval", 6, 4, "un"]
];
export const CANAIS = { airbnb: "Airbnb", booking: "Booking.com", vrbo: "Vrbo", direto: "Reserva direta", outro: "Outro" };
export const CAMPOS_TREINO_IMOVEL = [
  ["boas_vindas", "Boas-vindas e apresentação"], ["checkin", "Check-in (horário, chaves, senha da fechadura, como chegar)"], ["checkout", "Check-out (horário e o que fazer)"],
  ["wifi", "Wi-Fi"], ["regras", "Regras da casa (festas, pets, silêncio, fumo, visitas)"], ["estrutura", "Estrutura e comodidades"], ["estacionamento", "Estacionamento"],
  ["arredores", "Arredores e dicas (mercado, restaurantes, praia, transporte)"], ["emergencia", "Emergências e contatos"], ["perguntas", "Perguntas frequentes"], ["estilo", "Jeito de escrever do anfitrião"]
];

const DIA = 86400000;
const iso = d => new Date(d).toISOString().slice(0, 10);
const somaDias = (s, n) => iso(Date.parse(s + "T12:00:00Z") + n * DIA);
const noites = (a, b) => Math.max(0, Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / DIA));
const dataOk = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !isNaN(Date.parse(s + "T12:00:00Z"));
const cortar = (t, n) => { t = String(t || "").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const json_ = (s, padrao) => { try { const v = JSON.parse(s || ""); return v ?? padrao; } catch { return padrao; } };
const canalOk = c => (CANAIS[c] ? c : "outro");

// ---------------------------------------------------------------------------
// iCal
// ---------------------------------------------------------------------------

export function lerIcal(texto) {
  const linhas = String(texto || "").replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const eventos = [];
  let ev = null;
  for (const l of linhas) {
    if (l === "BEGIN:VEVENT") { ev = {}; continue; }
    if (l === "END:VEVENT") { if (ev && ev.inicio && ev.fim) eventos.push(ev); ev = null; continue; }
    if (!ev) continue;
    const i = l.indexOf(":"); if (i < 0) continue;
    const chave = l.slice(0, i).split(";")[0].toUpperCase(), valor = l.slice(i + 1).replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";");
    const data = v => { const m = String(v).match(/^(\d{4})(\d{2})(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
    if (chave === "DTSTART") ev.inicio = data(valor);
    else if (chave === "DTEND") ev.fim = data(valor);
    else if (chave === "UID") ev.uid = valor.slice(0, 200);
    else if (chave === "SUMMARY") ev.titulo = valor.slice(0, 200);
    else if (chave === "DESCRIPTION") ev.descricao = valor.slice(0, 1000);
  }
  for (const e of eventos) {
    if (e.fim <= e.inicio) e.fim = somaDias(e.inicio, 1);
    // Airbnb: "Reserved" = reserva; "Airbnb (Not available)" = bloqueio. Booking e Vrbo marcam tudo como indisponível.
    e.tipo = /reserv|booked|confirmed|hóspede|guest/i.test(e.titulo || "") && !/not available|blocked|closed/i.test(e.titulo || "") ? "RESERVA" : "BLOQUEIO";
    e.uid = e.uid || `${e.inicio}_${e.fim}_${e.titulo || ""}`;
  }
  return eventos;
}
function gerarIcal(nome, eventos) {
  const esc = t => String(t || "").replace(/[\\,;]/g, m => "\\" + m).replace(/\n/g, "\\n");
  const d = s => s.replace(/-/g, "");
  const agora = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//DENIA//Temporada//PT", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${esc(nome)}`,
    ...eventos.flatMap(e => ["BEGIN:VEVENT", `UID:${esc(e.uid)}@denia`, `DTSTAMP:${agora}`, `DTSTART;VALUE=DATE:${d(e.inicio)}`, `DTEND;VALUE=DATE:${d(e.fim)}`, `SUMMARY:${esc(e.titulo || "Indisponível")}`, "END:VEVENT"]),
    "END:VCALENDAR", ""].join("\r\n");
}
async function sincronizarCalendario(env, k, cal) {
  const agora = k.agora(env);
  try {
    const r = await fetch(cal.url, { headers: { "user-agent": "DENIA Calendar Sync" }, signal: AbortSignal.timeout(15000), redirect: "follow" });
    const texto = await r.text();
    if (!r.ok || !/BEGIN:VCALENDAR/.test(texto)) throw new Error(r.ok ? "O link não devolveu um calendário (iCal)." : `A plataforma respondeu ${r.status}.`);
    const hoje = iso(agora - 2 * DIA);
    const eventos = lerIcal(texto).filter(e => e.fim >= hoje).slice(0, 800);
    const st = eventos.map(e => env.DB.prepare(`INSERT INTO plt_tp_reservas(org_id,imovel_id,canal,externo_id,tipo,status,hospede,inicio,fim,notas,origem,calendario_id,criado_ms,atualizado_ms) VALUES(?,?,?,?,?,'CONFIRMADA',?,?,?,?,'ICAL',?,?,?)
      ON CONFLICT(org_id,imovel_id,canal,externo_id) DO UPDATE SET inicio=excluded.inicio, fim=excluded.fim, tipo=CASE WHEN plt_tp_reservas.origem='CHANNEX' THEN plt_tp_reservas.tipo ELSE excluded.tipo END, status=CASE WHEN plt_tp_reservas.origem='CHANNEX' THEN plt_tp_reservas.status ELSE 'CONFIRMADA' END, atualizado_ms=excluded.atualizado_ms`)
      .bind(cal.org_id, cal.imovel_id, cal.canal, "ical:" + e.uid, e.tipo, e.tipo === "RESERVA" ? (e.titulo || "Hóspede") : null, e.inicio, e.fim, cortar(e.descricao, 500) || null, cal.id, agora, agora));
    // Sumiu do calendário da plataforma (cancelada ou desbloqueada): marca como cancelada.
    st.push(env.DB.prepare("UPDATE plt_tp_reservas SET status='CANCELADA', atualizado_ms=? WHERE calendario_id=? AND origem='ICAL' AND status='CONFIRMADA' AND fim >= ? AND atualizado_ms < ?").bind(agora, cal.id, hoje, agora));
    st.push(env.DB.prepare("UPDATE plt_tp_calendarios SET ultimo_ms=?, erro=NULL, eventos=? WHERE id=?").bind(agora, eventos.length, cal.id));
    for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
    await agendarLimpezas(env, cal.org_id, cal.imovel_id, agora);
    const nome = (texto.match(/^X-WR-CALNAME:(.+)$/m) || [])[1]?.trim() || "";
    return { ok: true, eventos: eventos.length, nome: /^(airbnb|booking(\.com)?|vrbo|homeaway|calendar|calendário)$/i.test(nome) ? "" : cortar(nome, 120) };
  } catch (e) {
    await env.DB.prepare("UPDATE plt_tp_calendarios SET ultimo_ms=?, erro=? WHERE id=?").bind(agora, cortar(e?.message || "erro", 300), cal.id).run();
    return { ok: false, erro: e?.message };
  }
}
async function agendarLimpezas(env, orgId, imovelId, agora) {
  await env.DB.prepare(`INSERT OR IGNORE INTO plt_tp_limpezas(org_id,imovel_id,reserva_id,data,status,criado_ms)
    SELECT org_id, imovel_id, id, fim, 'PENDENTE', ? FROM plt_tp_reservas WHERE org_id=? AND imovel_id=? AND tipo='RESERVA' AND status='CONFIRMADA' AND fim >= ?`).bind(agora, orgId, imovelId, iso(agora)).run();
  await env.DB.prepare("UPDATE plt_tp_limpezas SET status='CANCELADA' WHERE org_id=? AND imovel_id=? AND status='PENDENTE' AND reserva_id IN (SELECT id FROM plt_tp_reservas WHERE status='CANCELADA')").bind(orgId, imovelId).run();
}
// Cron: sincroniza os calendários mais antigos primeiro (poucos por vez, para não pesar).
export async function sincronizarTemporada(env, k, maximo = 6) {
  const cals = (await env.DB.prepare("SELECT * FROM plt_tp_calendarios WHERE COALESCE(ultimo_ms,0) < ? ORDER BY COALESCE(ultimo_ms,0) LIMIT ?").bind(k.agora(env) - 25 * 60000, maximo).all().catch(() => null))?.results || [];
  let n = 0;
  for (const c of cals) { const r = await sincronizarCalendario(env, k, c); if (r.ok) n++; }
  return n;
}

// ---------------------------------------------------------------------------
// Preços: base, fim de semana, dia a dia e ajuste por plataforma (para cobrir a taxa de cada uma)
// ---------------------------------------------------------------------------

function precoDoDia(im, data, especial) {
  if (especial?.preco > 0) return especial.preco;
  const dow = new Date(data + "T12:00:00Z").getUTCDay(); // noite de sexta e sábado = fim de semana
  return (dow === 5 || dow === 6) && im.preco_fds > 0 ? im.preco_fds : Number(im.preco_base || 0);
}
// Janela de reservas (como no Airbnb): o calendário fica aberto só até N meses à frente. 0 ou vazio = sem limite.
function fimDaJanela(im, agoraMs) {
  const n = Number(im.janela_meses || 0);
  if (!n) return null;
  const h0 = new Date(agoraMs); return iso(Date.UTC(h0.getUTCFullYear(), h0.getUTCMonth() + n, h0.getUTCDate()));
}
function precoNoCanal(preco, im, canal) { const aj = json_(im.ajustes, {}); return Math.round(preco * (1 + (Number(aj[canal]) || 0) / 100) * 100) / 100; }

// ---------------------------------------------------------------------------
// Channex (conexão oficial com Airbnb, Booking.com e Vrbo)
// ---------------------------------------------------------------------------

export function channexBase(env) { return String(env.CHANNEX_STAGING || "") === "1" ? "https://staging.channex.io" : "https://app.channex.io"; }
export function channexLigado(env) { return Boolean(String(env.CHANNEX_API_KEY || "").trim()); }
async function cx(env, metodo, caminho, corpo) {
  const r = await fetch(channexBase(env) + "/api/v1" + caminho, { method: metodo, headers: { "user-api-key": String(env.CHANNEX_API_KEY).trim(), "content-type": "application/json" }, body: corpo ? JSON.stringify(corpo) : undefined, signal: AbortSignal.timeout(20000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Channex: " + cortar(JSON.stringify(d?.errors || d?.error || r.status), 300));
  return d;
}
// Cada empresa tem o seu grupo no Channex: os imóveis de uma nunca aparecem para outra.
async function grupoChannex(env, orgId, criar = true) {
  const chave = "channex_grupo_" + orgId;
  const atual = (await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind(chave).first().catch(() => null))?.valor;
  if (atual || !criar) return atual || null;
  const nome = (await env.DB.prepare("SELECT nome FROM plt_organizacoes WHERE id=?").bind(orgId).first().catch(() => null))?.nome || "Empresa";
  const id = (await cx(env, "POST", "/groups", { group: { title: cortar(`DENIA #${orgId} — ${nome}`, 90) } }))?.data?.id;
  if (id) await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind(chave, id).run();
  return id || null;
}
const webhookUrlChannex = async (env, k, orgId, base) => new URL(`/webhook/channex?org=${orgId}&t=${(await k.hmac(await k.segredo(env), "channex:" + orgId)).slice(0, 32)}`, base).toString();
// Reserva do Channex → reserva da DENIA (a mesma regra para o aviso em tempo real e para a importação).
async function gravarReservaChannex(env, org, im, bookingId, b, agora) {
  const canal = /airbnb/i.test(b.ota_name || "") ? "airbnb" : /booking/i.test(b.ota_name || "") ? "booking" : /vrbo|homeaway|expedia/i.test(b.ota_name || "") ? "vrbo" : "outro";
  const cliente = b.customer || {};
  // Taxa de limpeza: a que veio da plataforma (serviço "cleaning" da reserva) ou, se não vier, a do imóvel.
  const servicos = (b.rooms || []).flatMap(x => x.services || []).concat(b.services || []);
  const limpeza = servicos.filter(x => /clean|limpeza/i.test(String(x.name || x.type || ""))).reduce((t, x) => t + Number(x.total_price || x.price || 0), 0) || Number(im.taxa_limpeza || 0) || null;
  await env.DB.prepare(`INSERT INTO plt_tp_reservas(org_id,imovel_id,canal,externo_id,tipo,status,hospede,hospedes,inicio,fim,valor,moeda,contato,origem,taxa_limpeza,codigo,criado_ms,atualizado_ms) VALUES(?,?,?,?,'RESERVA',?,?,?,?,?,?,?,?,'CHANNEX',?,?,?,?)
    ON CONFLICT(org_id,imovel_id,canal,externo_id) DO UPDATE SET status=excluded.status, hospede=excluded.hospede, hospedes=excluded.hospedes, inicio=excluded.inicio, fim=excluded.fim, valor=excluded.valor, moeda=excluded.moeda, contato=excluded.contato, origem='CHANNEX', taxa_limpeza=COALESCE(excluded.taxa_limpeza,taxa_limpeza), codigo=COALESCE(excluded.codigo,codigo), atualizado_ms=excluded.atualizado_ms`)
    .bind(org, im.id, canal, "cx:" + bookingId, b.status === "cancelled" ? "CANCELADA" : "CONFIRMADA", cortar([cliente.name, cliente.surname].filter(Boolean).join(" "), 120) || "Hóspede", Number(b.occupancy?.adults || 0) + Number(b.occupancy?.children || 0) || null, b.arrival_date || iso(agora), b.departure_date || iso(agora + DIA), Number(b.amount || 0) || null, b.currency || im.moeda || "BRL", cortar(cliente.mail || cliente.phone || "", 120), limpeza, cortar(b.ota_reservation_code || b.unique_id || "", 60) || null, agora, agora).run();
}
// Traz para a DENIA todos os imóveis da empresa que estão no Channex (ligados às plataformas) e as reservas futuras.
export async function importarDoChannex(env, k, orgId, base) {
  const grupo = await grupoChannex(env, orgId, false);
  if (!grupo) return { imoveis_novos: 0, reservas: 0, total: 0, sem_grupo: true };
  const agora = k.agora(env);
  const props = [];
  for (let pg = 1; pg <= 5; pg++) {
    const d = await cx(env, "GET", `/properties?filter[group_id]=${encodeURIComponent(grupo)}&pagination[page]=${pg}&pagination[limit]=100`);
    props.push(...(d?.data || []));
    if ((d?.data || []).length < 100) break;
  }
  let novos = 0, reservas = 0;
  const hook = await webhookUrlChannex(env, k, orgId, base);
  for (const p of props) {
    const a = p.attributes || {};
    let im = await env.DB.prepare("SELECT * FROM plt_tp_imoveis WHERE org_id=? AND channex_property=?").bind(orgId, p.id).first();
    if (!im) {
      const room = (await cx(env, "GET", `/room_types?filter[property_id]=${encodeURIComponent(p.id)}`).catch(() => null))?.data?.[0];
      const token = [...crypto.getRandomValues(new Uint8Array(18))].map(b => b.toString(16).padStart(2, "0")).join("");
      const id = (await env.DB.prepare("INSERT INTO plt_tp_imoveis(org_id,nome,endereco,cidade,capacidade,moeda,ajustes,treinamento,anuncio,ia_modo,ativo,ical_token,checkin,checkout,channex_property,channex_room,channex_rates,criado_ms) VALUES(?,?,?,?,?,?,'{}','{}','{}','SUGERIR',1,?,'15:00','11:00',?,?,'{}',?) RETURNING id")
        .bind(orgId, cortar(a.title || "Imóvel", 120), cortar(a.address || "", 200) || null, cortar(a.city || "", 80) || null, Number(room?.attributes?.occ_adults || 0) || null, a.currency || "BRL", token, p.id, room?.id || null, agora).first())?.id;
      im = await env.DB.prepare("SELECT * FROM plt_tp_imoveis WHERE id=?").bind(id).first();
      novos++;
      await cx(env, "POST", "/webhooks", { webhook: { property_id: p.id, callback_url: hook, event_mask: "booking,message", is_active: true, send_data: true } }).catch(() => {});
    }
    const bs = (await cx(env, "GET", `/bookings?filter[property_id]=${encodeURIComponent(p.id)}&filter[departure_date][gte]=${iso(agora)}&pagination[limit]=100`).catch(() => null))?.data || [];
    for (const b of bs) { await gravarReservaChannex(env, orgId, im, b.id, b.attributes || {}, agora); reservas++; }
    if (bs.length) await agendarLimpezas(env, orgId, im.id, agora);
  }
  return { imoveis_novos: novos, reservas, total: props.length };
}

// Cria no Channex o imóvel, a unidade e um plano de preço por plataforma (preço próprio em cada uma).
async function garantirChannex(env, k, im) {
  let prop = im.channex_property, room = im.channex_room, rates = json_(im.channex_rates, {});
  if (!prop) { const grupo = await grupoChannex(env, im.org_id).catch(() => null); prop = (await cx(env, "POST", "/properties", { property: { title: im.nome, currency: im.moeda || "BRL", city: im.cidade || undefined, address: im.endereco || undefined, property_type: "apartment", ...(grupo ? { group_id: grupo } : {}), settings: { allow_availability_autoupdate_on_confirmation: true } } }))?.data?.id; }
  if (!room) room = (await cx(env, "POST", "/room_types", { room_type: { property_id: prop, title: im.nome, count_of_rooms: 1, occ_adults: Number(im.capacidade) || 2, occ_children: 0, occ_infants: 0, default_occupancy: Number(im.capacidade) || 2 } }))?.data?.id;
  for (const canal of ["airbnb", "booking", "vrbo"]) {
    if (rates[canal]) continue;
    rates[canal] = (await cx(env, "POST", "/rate_plans", { rate_plan: { property_id: prop, room_type_id: room, title: `${CANAIS[canal]} — ${im.nome}`.slice(0, 80), currency: im.moeda || "BRL", sell_mode: "per_room", rate_mode: "manual", options: [{ occupancy: Number(im.capacidade) || 2, is_primary: true, rate: Math.round(precoNoCanal(Number(im.preco_base || 0), im, canal) * 100) }] } }))?.data?.id;
  }
  await env.DB.prepare("UPDATE plt_tp_imoveis SET channex_property=?, channex_room=?, channex_rates=? WHERE id=?").bind(prop, room, JSON.stringify(rates), im.id).run();
  return { ...im, channex_property: prop, channex_room: room, channex_rates: JSON.stringify(rates) };
}
// Envia preços, mínimo de noites e fechamentos do período para todas as plataformas conectadas.
async function enviarPrecosChannex(env, k, im, de, ate) {
  if (!channexLigado(env) || !im.channex_property) return { enviado: false };
  const rates = json_(im.channex_rates, {});
  const esp = new Map(((await env.DB.prepare("SELECT * FROM plt_tp_precos WHERE imovel_id=? AND data BETWEEN ? AND ?").bind(im.id, de, ate).all())?.results || []).map(x => [x.data, x]));
  const values = [];
  const limiteJanela = fimDaJanela(im, k.agora(env));
  for (let d = de; d <= ate && values.length < 2500; d = somaDias(d, 1)) {
    const e0 = esp.get(d), e = limiteJanela && d > limiteJanela ? { ...(e0 || {}), fechado: 1 } : e0;
    for (const [canal, rate] of Object.entries(rates)) {
      if (!rate) continue;
      // Preços na plataforma: a DENIA só cuida da disponibilidade e do mínimo de noites (o preço fica como o anfitrião deixou lá).
      const v = { property_id: im.channex_property, rate_plan_id: rate, date_from: d, date_to: d, min_stay_arrival: Number(e?.minimo || im.minimo_noites || 1), stop_sell: Boolean(e?.fechado) };
      if (im.precos_modo !== "PLATAFORMA") v.rate = precoNoCanal(precoDoDia(im, d, e), im, canal).toFixed(2);
      if (Number(im.maximo_noites) > 0) v.max_stay = Number(im.maximo_noites);
      values.push(v);
    }
  }
  for (let i = 0; i < values.length; i += 500) await cx(env, "POST", "/restrictions", { values: values.slice(i, i + 500) });
  return { enviado: true, valores: values.length };
}
export async function webhookChannex(request, env, k) {
  const url = new URL(request.url);
  const org = Number(url.searchParams.get("org") || 0);
  const esperado = (await k.hmac(await k.segredo(env), "channex:" + org)).slice(0, 32);
  if (!org || url.searchParams.get("t") !== esperado) return new Response("Não autorizado.", { status: 401 });
  let d; try { d = await request.json(); } catch { return new Response("ok"); }
  const ev = String(d?.event || ""), p = d?.payload || {};
  let im = p.property_id ? await env.DB.prepare("SELECT * FROM plt_tp_imoveis WHERE org_id=? AND channex_property=?").bind(org, p.property_id).first() : null;
  if (!im && p.property_id && await grupoChannex(env, org, false)) { await importarDoChannex(env, k, org, request.url).catch(e => console.warn("channex importar", e?.message)); im = await env.DB.prepare("SELECT * FROM plt_tp_imoveis WHERE org_id=? AND channex_property=?").bind(org, p.property_id).first(); }
  if (!im) return new Response("ok");
  const agora = k.agora(env);
  if (/^booking/.test(ev) && p.booking_id) {
    const b = (await cx(env, "GET", `/bookings/${p.booking_id}`).catch(() => null))?.data?.attributes || p;
    await gravarReservaChannex(env, org, im, p.booking_id, b, agora);
    await agendarLimpezas(env, org, im.id, agora);
    if (p.revision_id) await cx(env, "POST", `/booking_revisions/${p.revision_id}/ack`).catch(() => {});
  }
  if (ev === "message" && p.message) {
    const reserva = p.booking_id ? await env.DB.prepare("SELECT * FROM plt_tp_reservas WHERE org_id=? AND externo_id=?").bind(org, "cx:" + p.booking_id).first() : null;
    const externoId = "cx:" + (p.id || p.message_id || crypto.randomUUID());
    const ins = await env.DB.prepare("INSERT OR IGNORE INTO plt_tp_msgs(org_id,imovel_id,reserva_id,canal,direcao,origem,texto,externo_id,criado_ms) VALUES(?,?,?,?,?,?,?,?,?)").bind(org, im.id, reserva?.id || null, reserva?.canal || "outro", p.sender === "property" ? "S" : "E", p.sender === "property" ? "ANFITRIAO" : "HOSPEDE", cortar(p.message, 4000), externoId, agora).run();
    if (Number(ins?.meta?.changes) && p.sender !== "property" && reserva) await responderHospede(env, k, org, im, reserva, cortar(p.message, 4000), { channexBooking: p.booking_id, externoId });
  }
  return new Response("ok");
}

// ---------------------------------------------------------------------------
// IA dos hóspedes
// ---------------------------------------------------------------------------

const INSTRUCOES_HOSPEDE = `Você é o anfitrião (ou a equipe do anfitrião) de um imóvel de temporada e responde hóspedes no Airbnb, Booking.com ou Vrbo.
- IDIOMA DA RESPOSTA: siga a regra "RESPONDER EM" indicada abaixo. Em "traducao", escreva a sua resposta no idioma do anfitrião. Em "traducao_hospede", traduza a MENSAGEM NOVA DO HÓSPEDE para o idioma do anfitrião (se já estiver nesse idioma, repita). O anfitrião precisa entender tudo sem saber a língua do hóspede.
- Seja caloroso, objetivo e humano, como um superanfitrião: mensagens curtas, sem textão, sem parecer robô. Use o JEITO DE ESCREVER do anfitrião.
- Use SOMENTE as informações do IMÓVEL e da RESERVA. Nunca invente regra, preço, desconto, senha, endereço ou disponibilidade.
- Não mande senha da fechadura nem endereço exato antes do dia do check-in, a menos que o treinamento mande.
- Nunca combine pagamento ou contato fora da plataforma (é proibido pelas regras do Airbnb e do Booking).
- Se pedirem desconto, exceção às regras, reembolso, reclamarem de algo sério, ou você não souber: "precisa_anfitriao": true e uma resposta curta dizendo que vai verificar.
- "risco": avalie sinais de problema SÓ pelo comportamento (festa ou evento, mais pessoas que a capacidade, pedido para pagar fora, pressa estranha, recusa de regras). Nunca por nome, origem, gênero, idade, religião ou qualquer característica pessoal. Valores: "baixo", "medio", "alto".
Responda em JSON: {"resposta":"","traducao":"","traducao_hospede":"","precisa_anfitriao":false,"motivo":"","risco":"baixo","sinais":[]}`;
function textoTreino(im) {
  const t = json_(im.treinamento, {});
  const com = json_(im.comodidades, []);
  const partes = CAMPOS_TREINO_IMOVEL.map(([c, r]) => t[c] ? `${r.toUpperCase()}:\n${cortar(t[c], 2500)}` : "").filter(Boolean);
  if (com.length) partes.push(`COMODIDADES (o imóvel TEM; o que não está aqui, não diga que tem):\n${com.join(", ")}`);
  const taxas = [im.taxa_limpeza ? `limpeza ${im.taxa_limpeza}` : "", im.taxa_hospede_extra ? `hóspede extra ${im.taxa_hospede_extra} por noite acima de ${im.hospedes_incluidos || im.capacidade || "?"} pessoas` : "", im.taxa_pet ? `pet ${im.taxa_pet}` : ""].filter(Boolean);
  if (taxas.length) partes.push(`TAXAS (${im.moeda || "BRL"}): ${taxas.join("; ")}`);
  return partes.join("\n\n") || "(o anfitrião ainda não preencheu o treinamento deste imóvel)";
}
export async function sugerirResposta(env, k, orgId, im, reserva, texto, historico = []) {
  const envIA = await k.comIA(env, orgId);
  if (!envIA.OPENAI_API_KEY) throw new Error("A IA da plataforma ainda não está ligada.");
  const cfg = json_((await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind("tp_config_" + orgId).first().catch(() => null))?.valor, {});
  const conversa = historico.slice(-20).map(m => `${m.direcao === "E" ? "HÓSPEDE" : "ANFITRIÃO"}: ${cortar(m.texto, 500)}`).join("\n");
  const idiomaAnfitriao = cfg.idioma || "português do Brasil";
  const regra = cfg.idioma_resposta === "ANFITRIAO" ? `sempre em ${idiomaAnfitriao} (o idioma do anfitrião)` : `no idioma em que o hóspede escreveu (para ele entender)`;
  const entrada = `IDIOMA DO ANFITRIÃO: ${idiomaAnfitriao}\nRESPONDER EM: ${regra}\n\nIMÓVEL: ${im.nome}${im.cidade ? " — " + im.cidade : ""}\nCapacidade: ${im.capacidade || "?"} pessoas · Check-in ${im.checkin || "15:00"} · Check-out ${im.checkout || "11:00"}\n\n${textoTreino(im)}\n\n${reserva ? `RESERVA: ${CANAIS[reserva.canal] || reserva.canal} · ${reserva.hospede || "hóspede"} · ${reserva.inicio} a ${reserva.fim} (${noites(reserva.inicio, reserva.fim)} noites)${reserva.hospedes ? ` · ${reserva.hospedes} pessoas` : ""}\nHOJE: ${iso(k.agora(env))}` : "SEM RESERVA (pergunta antes de reservar)"}\n\nCONVERSA:\n${conversa || "(início)"}\n\nMENSAGEM NOVA DO HÓSPEDE: "${cortar(texto, 2000)}"`;
  return openaiResposta(envIA, { modelo: cfg.modelo || "gpt-5-mini", esforco: "low", maxTokens: 1200, instrucoes: INSTRUCOES_HOSPEDE, entrada, recurso: "temporada/hospedes" });
}
async function responderHospede(env, k, orgId, im, reserva, texto, { channexBooking, externoId } = {}) {
  const hist = ((await env.DB.prepare("SELECT direcao, texto FROM plt_tp_msgs WHERE org_id=? AND reserva_id=? ORDER BY id DESC LIMIT 20").bind(orgId, reserva.id).all())?.results || []).reverse();
  let o;
  try { o = await sugerirResposta(env, k, orgId, im, reserva, texto, hist.slice(0, -1)); } catch (e) { console.warn("temporada IA", e?.message); return; }
  const agora = k.agora(env);
  // O anfitrião lê a mensagem do hóspede no idioma dele.
  if (externoId && o?.traducao_hospede) await env.DB.prepare("UPDATE plt_tp_msgs SET traducao=? WHERE externo_id=? AND org_id=?").bind(cortar(o.traducao_hospede, 4000), externoId, orgId).run().catch(() => {});
  if (o?.risco && o.risco !== "baixo") await env.DB.prepare("UPDATE plt_tp_reservas SET risco=? WHERE id=?").bind(JSON.stringify({ nivel: o.risco, sinais: (o.sinais || []).slice(0, 5), em: agora }), reserva.id).run();
  const automatico = im.ia_modo === "AUTO" && !o?.precisa_anfitriao && o?.resposta && channexBooking && channexLigado(env);
  if (automatico) {
    await cx(env, "POST", `/bookings/${channexBooking}/messages`, { message: { message: cortar(o.resposta, 4000) } });
    await env.DB.prepare("INSERT INTO plt_tp_msgs(org_id,imovel_id,reserva_id,canal,direcao,origem,texto,traducao,status,criado_ms) VALUES(?,?,?,?,'S','IA',?,?,'ENVIADA',?)").bind(orgId, im.id, reserva.id, reserva.canal, cortar(o.resposta, 4000), cortar(o.traducao, 4000), agora).run();
  } else if (o?.resposta) {
    await env.DB.prepare("INSERT INTO plt_tp_msgs(org_id,imovel_id,reserva_id,canal,direcao,origem,texto,traducao,status,criado_ms) VALUES(?,?,?,?,'S','IA',?,?,'RASCUNHO',?)").bind(orgId, im.id, reserva.id, reserva.canal, cortar(o.resposta, 4000), cortar([o.traducao, o.precisa_anfitriao ? "⚠ " + (o.motivo || "precisa do anfitrião") : ""].filter(Boolean).join("\n"), 4000), agora).run();
    if (k.avisar && o.precisa_anfitriao) await k.avisar(orgId, `🏠 ${im.nome} — ${reserva.hospede || "hóspede"} (${CANAIS[reserva.canal] || ""}) escreveu: "${cortar(texto, 200)}"\n${"Precisa de você: " + (o.motivo || "") + " — a resposta sugerida está na DENIA (Temporada → Mensagens)."}`).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Métricas
// ---------------------------------------------------------------------------

async function resumo(env, orgId, de, ate, imovelId) {
  const imoveis = (await env.DB.prepare(`SELECT * FROM plt_tp_imoveis WHERE org_id=? AND ativo=1 ${imovelId ? "AND id=?" : ""}`).bind(orgId, ...(imovelId ? [imovelId] : [])).all())?.results || [];
  const res = (await env.DB.prepare(`SELECT * FROM plt_tp_reservas WHERE org_id=? AND status='CONFIRMADA' AND inicio <= ? AND fim > ? ${imovelId ? "AND imovel_id=?" : ""}`).bind(orgId, ate, de, ...(imovelId ? [imovelId] : [])).all())?.results || [];
  const dias = noites(de, somaDias(ate, 1));
  const disponiveis = imoveis.length * dias;
  let ocupadas = 0, bloqueadas = 0, receita = 0, noitesPagas = 0, limpezas = 0;
  const porCanal = {}, porDia = new Map(), antecedencia = [], estadias = [];
  for (const r of res) {
    const ini = r.inicio < de ? de : r.inicio, fim = r.fim > somaDias(ate, 1) ? somaDias(ate, 1) : r.fim;
    const n = noites(ini, fim), total = noites(r.inicio, r.fim) || 1;
    if (r.tipo === "BLOQUEIO") { bloqueadas += n; continue; }
    ocupadas += n;
    const valor = r.valor ? (Number(r.valor) * n) / total : 0;
    receita += valor; if (r.valor) noitesPagas += n;
    if (r.taxa_limpeza && r.fim > de && r.fim <= somaDias(ate, 1)) limpezas += Number(r.taxa_limpeza);
    const c = porCanal[r.canal] = porCanal[r.canal] || { canal: r.canal, nome: CANAIS[r.canal] || r.canal, reservas: 0, noites: 0, receita: 0 };
    c.reservas++; c.noites += n; c.receita += valor;
    for (let d = ini; d < fim; d = somaDias(d, 1)) porDia.set(d, (porDia.get(d) || 0) + 1);
    if (r.criado_ms) antecedencia.push(Math.max(0, Math.round((Date.parse(r.inicio + "T12:00:00Z") - r.criado_ms) / DIA)));
    estadias.push(total);
  }
  const med = l => l.length ? l.slice().sort((a, b) => a - b)[Math.floor(l.length / 2)] : null;
  const serie = []; for (let d = de; d <= ate; d = somaDias(d, 1)) serie.push({ dia: d, ocupados: porDia.get(d) || 0, total: imoveis.length });
  return {
    imoveis: imoveis.length, dias, noites_disponiveis: disponiveis, noites_ocupadas: ocupadas, noites_bloqueadas: bloqueadas,
    ocupacao: disponiveis - bloqueadas > 0 ? Math.round((ocupadas / (disponiveis - bloqueadas)) * 1000) / 10 : null,
    receita: Math.round(receita * 100) / 100, diaria_media: noitesPagas ? Math.round((receita / noitesPagas) * 100) / 100 : null,
    revpar: disponiveis ? Math.round((receita / disponiveis) * 100) / 100 : null, reservas: res.filter(r => r.tipo === "RESERVA").length,
    por_canal: Object.values(porCanal).map(c => ({ ...c, receita: Math.round(c.receita * 100) / 100 })), serie,
    antecedencia_mediana: med(antecedencia), estadia_mediana: med(estadias), taxas_limpeza: Math.round(limpezas * 100) / 100
  };
}

// ---------------------------------------------------------------------------
// Rotas do painel: /api/orgs/:id/tp/...
// ---------------------------------------------------------------------------

export async function rotasTemporada(request, env, k, orgId, papel, resto) {
  if (!resto.startsWith("tp/") && resto !== "tp") return null;
  const r = resto.replace(/^tp\/?/, "");
  const { json, lerCorpo, pode, auditar, sessao } = k;
  const metodo = request.method, agora = k.agora(env), q = new URL(request.url).searchParams;
  const ler = async (lim = 60000) => { const { corpo, erro } = await lerCorpo(request, lim); return erro ? { erro } : { corpo }; };
  const precisa = n => pode(papel, n) ? null : json({ erro: "Seu perfil não pode fazer isso." }, 403);
  const imovel = async id => env.DB.prepare("SELECT * FROM plt_tp_imoveis WHERE id=? AND org_id=?").bind(Number(id), orgId).first();
  // Em quais plataformas o imóvel está: pelo calendário (iCal) de cada uma e/ou pela conexão oficial.
  const plataformasDe = im => { const m2 = {}; for (const x of String(im.canais_cal || "").split(",").filter(Boolean)) { const [c, st] = x.split(":"); m2[c] = { canal: c, via: "calendario", ok: m2[c]?.ok || st === "ok" }; } if (im.channex_property) for (const c of ["airbnb", "booking", "vrbo"]) m2[c] = { ...(m2[c] || { canal: c, ok: true }), oficial: true }; return Object.values(m2); };
  const publico = im => ({ ...im, taxas_plataforma: { ...TAXAS_PADRAO, ...json_(im.taxas_plataforma, {}) }, plataformas: plataformasDe(im), ajustes: json_(im.ajustes, {}), treinamento: json_(im.treinamento, {}), anuncio: json_(im.anuncio, {}), comodidades: json_(im.comodidades, []), channex_rates: undefined, conectado_channex: Boolean(im.channex_property),
    ical_url: im.ical_token ? new URL(`/tp/ical/${im.ical_token}.ics`, request.url).toString() : null });
  let m;
  const org = await rotasOrganizacao(request, env, k, orgId, r, { json, ler, precisa, imovel, agora, q });
  if (org) return org;
  const extra = await rotasTemporadaExtra(request, env, k, orgId, r, { json, ler, precisa, imovel, agora, q });
  if (extra) return extra;

  if (r === "visao" && metodo === "GET") {
    const de = dataOk(q.get("de")) ? q.get("de") : iso(agora - 29 * DIA), ate = dataOk(q.get("ate")) ? q.get("ate") : iso(agora);
    const [s, proximas, msgs, limp, cals] = await Promise.all([
      resumo(env, orgId, de, ate, Number(q.get("imovel")) || 0),
      env.DB.prepare("SELECT r.*, i.nome imovel FROM plt_tp_reservas r JOIN plt_tp_imoveis i ON i.id=r.imovel_id WHERE r.org_id=? AND r.status='CONFIRMADA' AND r.tipo='RESERVA' AND r.fim >= ? ORDER BY r.inicio LIMIT 12").bind(orgId, iso(agora)).all(),
      env.DB.prepare("SELECT COUNT(*) n FROM plt_tp_msgs WHERE org_id=? AND status='RASCUNHO'").bind(orgId).first(),
      env.DB.prepare("SELECT l.*, i.nome imovel FROM plt_tp_limpezas l JOIN plt_tp_imoveis i ON i.id=l.imovel_id WHERE l.org_id=? AND l.status='PENDENTE' AND l.data BETWEEN ? AND ? ORDER BY l.data LIMIT 10").bind(orgId, iso(agora), iso(agora + 7 * DIA)).all(),
      env.DB.prepare("SELECT c.canal, c.erro, c.ultimo_ms, i.nome imovel FROM plt_tp_calendarios c JOIN plt_tp_imoveis i ON i.id=c.imovel_id WHERE c.org_id=?").bind(orgId).all()
    ]);
    return json({ ...s, de, ate, proximas: proximas?.results || [], rascunhos: Number(msgs?.n || 0), limpezas: limp?.results || [], calendarios: cals?.results || [], channex: channexLigado(env) });
  }
  if (r === "imoveis" && metodo === "GET") {
    const l = (await env.DB.prepare(`SELECT i.*, (SELECT COUNT(*) FROM plt_tp_calendarios c WHERE c.imovel_id=i.id) calendarios, (SELECT GROUP_CONCAT(c.canal || ':' || CASE WHEN c.erro IS NULL THEN 'ok' ELSE 'erro' END, ',') FROM plt_tp_calendarios c WHERE c.imovel_id=i.id) canais_cal,
      (SELECT id FROM plt_tp_fotos f WHERE f.imovel_id=i.id AND f.limpeza_id IS NULL AND f.mime LIKE 'image/%' ORDER BY f.ordem, f.id LIMIT 1) foto_id,
      (SELECT COUNT(*) FROM plt_tp_reservas r WHERE r.imovel_id=i.id AND r.status='CONFIRMADA' AND r.inicio <= ? AND r.fim > ?) ocupado_hoje,
      (SELECT MIN(r.inicio) FROM plt_tp_reservas r WHERE r.imovel_id=i.id AND r.status='CONFIRMADA' AND r.tipo='RESERVA' AND r.inicio >= ?) proxima_entrada
      FROM plt_tp_imoveis i WHERE i.org_id=? ORDER BY i.ativo DESC, i.nome`).bind(iso(agora), iso(agora), iso(agora), orgId).all())?.results || [];
    return json({ imoveis: l.map(publico), canais: CANAIS, campos_treino: CAMPOS_TREINO_IMOVEL, channex: channexLigado(env) });
  }
  if ((r === "imoveis" || (m = r.match(/^imoveis\/(\d{1,12})$/))) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const id = m ? Number(m[1]) : 0;
    const atual = id ? await imovel(id) : null;
    if (id && !atual) return json({ erro: "Imóvel não encontrado." }, 404);
    if (!id && k.acesso?.limites?.imoveis) {
      const n = Number((await env.DB.prepare("SELECT COUNT(*) n FROM plt_tp_imoveis WHERE org_id=? AND ativo=1").bind(orgId).first())?.n || 0);
      if (n >= k.acesso.limites.imoveis) return json({ erro: `O plano ${k.acesso.nome} permite até ${k.acesso.limites.imoveis} imóveis. Atualize o plano para cadastrar mais.`, codigo: "PLANO_LIMITE" }, 402);
    }
    const num = (v, a) => v === undefined ? (a ?? null) : (Number.isFinite(Number(v)) && v !== "" && v !== null ? Number(v) : null);
    const nome = k.txt(corpo.nome ?? atual?.nome, 120);
    if (!nome) return json({ erro: "Dê um nome ao imóvel (ex.: Apartamento Copacabana 302)." }, 400);
    const ajustes = corpo.ajustes ? Object.fromEntries(Object.keys(CANAIS).map(c => [c, Math.max(-50, Math.min(100, Number(corpo.ajustes[c]) || 0))])) : json_(atual?.ajustes, { airbnb: 0, booking: 18, vrbo: 10 });
    const treinamento = corpo.treinamento ? Object.fromEntries(CAMPOS_TREINO_IMOVEL.map(([c]) => [c, k.txt(corpo.treinamento[c], 4000)])) : json_(atual?.treinamento, {});
    const anuncio = corpo.anuncio ? { titulo: k.txt(corpo.anuncio.titulo, 120), descricao: k.txt(corpo.anuncio.descricao, 6000), fotos: (Array.isArray(corpo.anuncio.fotos) ? corpo.anuncio.fotos : []).map(f => String(f || "").trim()).filter(f => /^https:\/\/\S{8,500}$/.test(f)).slice(0, 40) } : json_(atual?.anuncio, {});
    const v = [nome, k.txt(corpo.endereco ?? atual?.endereco, 200), k.txt(corpo.cidade ?? atual?.cidade, 80), num(corpo.capacidade, atual?.capacidade), num(corpo.quartos, atual?.quartos), num(corpo.banheiros, atual?.banheiros),
      /^\d{2}:\d{2}$/.test(corpo.checkin || "") ? corpo.checkin : atual?.checkin || "15:00", /^\d{2}:\d{2}$/.test(corpo.checkout || "") ? corpo.checkout : atual?.checkout || "11:00",
      /^[A-Z]{3}$/.test(corpo.moeda || "") ? corpo.moeda : atual?.moeda || "BRL", num(corpo.preco_base, atual?.preco_base), num(corpo.preco_fds, atual?.preco_fds), num(corpo.minimo_noites, atual?.minimo_noites), num(corpo.taxa_limpeza, atual?.taxa_limpeza),
      JSON.stringify(ajustes), JSON.stringify(treinamento), JSON.stringify(anuncio), ["AUTO", "SUGERIR"].includes(corpo.ia_modo) ? corpo.ia_modo : atual?.ia_modo || "SUGERIR", corpo.ativo === false ? 0 : 1];
    let novoId = id;
    const extras = { desconto_semanal: num(corpo.desconto_semanal, atual?.desconto_semanal), desconto_mensal: num(corpo.desconto_mensal, atual?.desconto_mensal), hospedes_incluidos: num(corpo.hospedes_incluidos, atual?.hospedes_incluidos), taxa_hospede_extra: num(corpo.taxa_hospede_extra, atual?.taxa_hospede_extra),
      taxa_pet: num(corpo.taxa_pet, atual?.taxa_pet), maximo_noites: num(corpo.maximo_noites, atual?.maximo_noites), antecedencia_dias: num(corpo.antecedencia_dias, atual?.antecedencia_dias),
      comodidades: Array.isArray(corpo.comodidades) ? JSON.stringify([...new Set(corpo.comodidades.map(x => k.txt(x, 60)).filter(Boolean))].slice(0, 150)) : atual?.comodidades ?? null,
      precos_modo: ["DENIA", "PLATAFORMA"].includes(corpo.precos_modo) ? corpo.precos_modo : atual?.precos_modo || "DENIA",
      taxas_plataforma: corpo.taxas_plataforma && typeof corpo.taxas_plataforma === "object" ? JSON.stringify(Object.fromEntries(["airbnb", "booking", "vrbo"].map(c => [c, Math.max(0, Math.min(40, Number(corpo.taxas_plataforma[c]) || 0))]))) : atual?.taxas_plataforma ?? null,
      janela_meses: corpo.janela_meses !== undefined ? ([0, 3, 6, 9, 12, 24].includes(Number(corpo.janela_meses)) ? Number(corpo.janela_meses) : 0) : atual?.janela_meses ?? null };
    for (const c of ["desconto_semanal", "desconto_mensal"]) if (extras[c] != null) extras[c] = Math.max(0, Math.min(90, extras[c]));
    if (id) await env.DB.prepare("UPDATE plt_tp_imoveis SET nome=?, endereco=?, cidade=?, capacidade=?, quartos=?, banheiros=?, checkin=?, checkout=?, moeda=?, preco_base=?, preco_fds=?, minimo_noites=?, taxa_limpeza=?, ajustes=?, treinamento=?, anuncio=?, ia_modo=?, ativo=? WHERE id=? AND org_id=?").bind(...v, id, orgId).run();
    else novoId = (await env.DB.prepare("INSERT INTO plt_tp_imoveis(nome,endereco,cidade,capacidade,quartos,banheiros,checkin,checkout,moeda,preco_base,preco_fds,minimo_noites,taxa_limpeza,ajustes,treinamento,anuncio,ia_modo,ativo,org_id,ical_token,criado_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id").bind(...v, orgId, [...crypto.getRandomValues(new Uint8Array(18))].map(b => b.toString(16).padStart(2, "0")).join(""), agora).first())?.id;
    await env.DB.prepare(`UPDATE plt_tp_imoveis SET ${Object.keys(extras).map(c => c + "=?").join(", ")} WHERE id=? AND org_id=?`).bind(...Object.values(extras), novoId, orgId).run();
    // Mudou preço, mínimo ou ajuste das plataformas: manda para as plataformas conectadas.
    let enviado = null;
    const im = await imovel(novoId);
    if (im.channex_property && (corpo.preco_base !== undefined || corpo.preco_fds !== undefined || corpo.ajustes || corpo.minimo_noites !== undefined || corpo.maximo_noites !== undefined || corpo.precos_modo !== undefined || corpo.janela_meses !== undefined))
      enviado = await enviarPrecosChannex(env, k, im, iso(agora), iso(agora + 365 * DIA)).catch(e => ({ erro: e.message }));
    await auditar(env, request, sessao, orgId, "TEMPORADA", `${id ? "Atualizou" : "Cadastrou"} o imóvel ${nome}`);
    return json({ ok: true, id: novoId, plataformas: enviado });
  }
  if ((m = r.match(/^imoveis\/(\d{1,12})$/)) && metodo === "GET") {
    const im = await imovel(m[1]); if (!im) return json({ erro: "Imóvel não encontrado." }, 404);
    const cals = (await env.DB.prepare("SELECT * FROM plt_tp_calendarios WHERE imovel_id=? AND org_id=?").bind(im.id, orgId).all())?.results || [];
    return json({ imovel: publico(im), calendarios: cals, canais: CANAIS, campos_treino: CAMPOS_TREINO_IMOVEL, channex: channexLigado(env) });
  }
  if ((m = r.match(/^imoveis\/(\d{1,12})\/excluir$/)) && metodo === "POST") {
    const negado = precisa("ADMIN"); if (negado) return negado;
    await env.DB.prepare("UPDATE plt_tp_imoveis SET ativo=0 WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).run();
    await env.DB.prepare("DELETE FROM plt_tp_calendarios WHERE imovel_id=? AND org_id=?").bind(Number(m[1]), orgId).run();
    return json({ ok: true });
  }
  // Cadastro rápido: cole os links dos calendários (um imóvel por linha) e a DENIA cria tudo sozinha.
  if (r === "imoveis/rapido" && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const itens = (Array.isArray(corpo.imoveis) ? corpo.imoveis : []).slice(0, 60).map(x => ({ nome: k.txt(x.nome, 120), links: (Array.isArray(x.links) ? x.links : []).map(u => String(u || "").trim().replace(/^webcal:\/\//i, "https://")).filter(Boolean).slice(0, 6) })).filter(x => x.nome || x.links.length);
    if (!itens.length) return json({ erro: "Cole pelo menos um link de calendário (ou o nome do imóvel)." }, 400);
    const ruins = itens.flatMap(x => x.links).filter(u => !/^https:\/\/\S{10,1000}$/.test(u) || /airbnb\.[a-z.]+\/rooms\/|booking\.com\/hotel\/[a-z]{2}\/|vrbo\.com\/\d+$/i.test(u) && !/ical|\.ics/i.test(u));
    if (ruins.length) return json({ erro: `Este link é do anúncio, não do calendário: ${cortar(ruins[0], 80)}. Use o link de EXPORTAR o calendário (veja "Onde acho o link").`, codigo: "LINK_ANUNCIO" }, 400);
    if (k.acesso?.limites?.imoveis) {
      const n = Number((await env.DB.prepare("SELECT COUNT(*) n FROM plt_tp_imoveis WHERE org_id=? AND ativo=1").bind(orgId).first())?.n || 0);
      if (n + itens.length > k.acesso.limites.imoveis) return json({ erro: `O plano ${k.acesso.nome} permite até ${k.acesso.limites.imoveis} imóveis (você já tem ${n}). Atualize o plano para cadastrar mais.`, codigo: "PLANO_LIMITE" }, 402);
    }
    const canalDe = u => /airbnb/i.test(u) ? "airbnb" : /booking\.com/i.test(u) ? "booking" : /vrbo|homeaway/i.test(u) ? "vrbo" : "outro";
    const criados = [];
    let sincronizados = 0;
    for (const it of itens) {
      const primeiro = it.links[0] || "";
      const idAnuncio = (primeiro.match(/ical\/(\d{5,})/) || primeiro.match(/(\d{6,})/) || [])[1];
      const nome = it.nome || (primeiro ? `${CANAIS[canalDe(primeiro)]}${idAnuncio ? " — anúncio " + idAnuncio : ""}` : "Imóvel");
      const imId = (await env.DB.prepare("INSERT INTO plt_tp_imoveis(org_id,nome,moeda,ajustes,treinamento,anuncio,ia_modo,ativo,ical_token,checkin,checkout,criado_ms) VALUES(?,?,'BRL',?,'{}','{}','SUGERIR',1,?,'15:00','11:00',?) RETURNING id")
        .bind(orgId, nome, JSON.stringify({ airbnb: 0, booking: 18, vrbo: 10 }), [...crypto.getRandomValues(new Uint8Array(18))].map(b => b.toString(16).padStart(2, "0")).join(""), agora).first()).id;
      const res = { id: imId, nome, calendarios: 0, reservas: 0, erros: [] };
      for (const u of it.links) {
        const canal = canalDe(u);
        const calId = (await env.DB.prepare("INSERT INTO plt_tp_calendarios(org_id,imovel_id,canal,url) VALUES(?,?,?,?) RETURNING id").bind(orgId, imId, canal, u).first()).id;
        res.calendarios++;
        // Lê na hora os primeiros (o resto o cron lê em poucos minutos), sem pesar a requisição.
        if (sincronizados < 12) {
          sincronizados++;
          const sinc = await sincronizarCalendario(env, k, { id: calId, org_id: orgId, imovel_id: imId, canal, url: u });
          if (sinc.ok) { res.reservas += sinc.eventos; if (!it.nome && sinc.nome) { await env.DB.prepare("UPDATE plt_tp_imoveis SET nome=? WHERE id=?").bind(sinc.nome, imId).run(); res.nome = sinc.nome; } }
          else res.erros.push(`${CANAIS[canal]}: ${sinc.erro}`);
        }
      }
      criados.push(res);
    }
    await auditar(env, request, sessao, orgId, "TEMPORADA", `Cadastro rápido: ${criados.length} imóvel(is), ${criados.reduce((t, x) => t + x.calendarios, 0)} calendário(s)`);
    return json({ ok: true, imoveis: criados });
  }
  if ((m = r.match(/^imoveis\/(\d{1,12})\/calendarios$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const im = await imovel(m[1]); if (!im) return json({ erro: "Imóvel não encontrado." }, 404);
    const url = String(corpo.url || "").trim().replace(/^webcal:\/\//i, "https://");
    if (!/^https:\/\/[^\s]{10,1000}$/.test(url)) return json({ erro: "Cole o link do calendário (iCal/ICS) que a plataforma fornece para exportar." }, 400);
    const canal = canalOk(corpo.canal || (/airbnb/i.test(url) ? "airbnb" : /booking\.com/i.test(url) ? "booking" : /vrbo|homeaway/i.test(url) ? "vrbo" : "outro"));
    const id = (await env.DB.prepare("INSERT INTO plt_tp_calendarios(org_id,imovel_id,canal,url) VALUES(?,?,?,?) RETURNING id").bind(orgId, im.id, canal, url).first()).id;
    const s = await sincronizarCalendario(env, k, { id, org_id: orgId, imovel_id: im.id, canal, url });
    return json({ ok: s.ok, id, ...s });
  }
  if ((m = r.match(/^calendarios\/(\d{1,12})\/(excluir|sincronizar)$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const cal = await env.DB.prepare("SELECT * FROM plt_tp_calendarios WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).first();
    if (!cal) return json({ erro: "Calendário não encontrado." }, 404);
    if (m[2] === "sincronizar") return json(await sincronizarCalendario(env, k, cal));
    await env.DB.batch([env.DB.prepare("DELETE FROM plt_tp_reservas WHERE calendario_id=? AND origem='ICAL'").bind(cal.id), env.DB.prepare("DELETE FROM plt_tp_calendarios WHERE id=?").bind(cal.id)]);
    return json({ ok: true });
  }
  if (r === "calendario" && metodo === "GET") {
    const de = dataOk(q.get("de")) ? q.get("de") : iso(agora), ate = dataOk(q.get("ate")) && noites(de, q.get("ate")) <= 400 ? q.get("ate") : somaDias(de, 41);
    const ims = (await env.DB.prepare("SELECT * FROM plt_tp_imoveis WHERE org_id=? AND ativo=1 ORDER BY nome").bind(orgId).all())?.results || [];
    const [res, esp] = await env.DB.batch([
      env.DB.prepare("SELECT id, imovel_id, canal, tipo, hospede, hospedes, inicio, fim, valor, risco, origem FROM plt_tp_reservas WHERE org_id=? AND status='CONFIRMADA' AND inicio <= ? AND fim > ?").bind(orgId, ate, de),
      env.DB.prepare("SELECT * FROM plt_tp_precos WHERE org_id=? AND data BETWEEN ? AND ?").bind(orgId, de, ate)
    ]);
    const e = new Map((esp?.results || []).map(x => [x.imovel_id + "|" + x.data, x]));
    const dias = []; for (let d = de; d <= ate; d = somaDias(d, 1)) dias.push(d);
    return json({ de, ate, dias, imoveis: ims.map(im => ({ id: im.id, nome: im.nome, moeda: im.moeda, ajustes: json_(im.ajustes, {}), conectado: Boolean(im.channex_property) && channexLigado(env), janela_ate: fimDaJanela(im, agora), precos: dias.map(d => { const x = e.get(im.id + "|" + d), fora = fimDaJanela(im, agora) && d > fimDaJanela(im, agora); return { data: d, preco: precoDoDia(im, d, x), minimo: x?.minimo || im.minimo_noites || 1, fechado: Boolean(x?.fechado) || Boolean(fora), fora_janela: Boolean(fora), especial: Boolean(x?.preco) }; }) })), reservas: res?.results || [], canais: CANAIS });
  }
  if (r === "precos" && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const im = await imovel(corpo.imovel_id); if (!im) return json({ erro: "Escolha o imóvel." }, 400);
    if (!dataOk(corpo.de) || !dataOk(corpo.ate) || corpo.ate < corpo.de || noites(corpo.de, corpo.ate) > 400) return json({ erro: "Escolha o período (até 400 dias)." }, 400);
    const preco = corpo.limpar ? null : Number(corpo.preco) > 0 ? Number(corpo.preco) : null, minimo = Number(corpo.minimo) > 0 ? Math.min(60, Number(corpo.minimo)) : null, fechado = corpo.fechado === true ? 1 : 0;
    const st = [];
    for (let d = corpo.de; d <= corpo.ate; d = somaDias(d, 1))
      st.push(corpo.limpar ? env.DB.prepare("DELETE FROM plt_tp_precos WHERE imovel_id=? AND data=?").bind(im.id, d) : env.DB.prepare("INSERT INTO plt_tp_precos(imovel_id,data,org_id,preco,minimo,fechado) VALUES(?,?,?,?,?,?) ON CONFLICT(imovel_id,data) DO UPDATE SET preco=COALESCE(excluded.preco,preco), minimo=COALESCE(excluded.minimo,minimo), fechado=excluded.fechado").bind(im.id, d, orgId, preco, minimo, fechado));
    for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
    const enviado = await enviarPrecosChannex(env, k, im, corpo.de, corpo.ate).catch(e => ({ erro: e.message }));
    await auditar(env, request, sessao, orgId, "TEMPORADA", `Preços de ${im.nome}: ${corpo.de} a ${corpo.ate}${preco ? ` R$ ${preco}` : ""}${fechado ? " (fechado)" : ""}${corpo.limpar ? " (voltou ao preço base)" : ""}`);
    return json({ ok: true, dias: st.length, plataformas: enviado });
  }
  if (r === "reservas" && metodo === "GET") {
    const de = dataOk(q.get("de")) ? q.get("de") : iso(agora - 30 * DIA), ate = dataOk(q.get("ate")) ? q.get("ate") : iso(agora + 365 * DIA);
    const l = (await env.DB.prepare("SELECT r.*, i.nome imovel, (SELECT COUNT(*) FROM plt_tp_msgs m WHERE m.reserva_id=r.id AND m.status='RASCUNHO') rascunhos FROM plt_tp_reservas r JOIN plt_tp_imoveis i ON i.id=r.imovel_id WHERE r.org_id=? AND r.tipo='RESERVA' AND r.inicio <= ? AND r.fim >= ? ORDER BY r.inicio LIMIT 400").bind(orgId, ate, de).all())?.results || [];
    return json({ reservas: l.map(x => ({ ...x, risco: json_(x.risco, null), noites: noites(x.inicio, x.fim) })), canais: CANAIS });
  }
  if (r === "reservas" && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const im = await imovel(corpo.imovel_id); if (!im) return json({ erro: "Escolha o imóvel." }, 400);
    if (!dataOk(corpo.inicio) || !dataOk(corpo.fim) || corpo.fim <= corpo.inicio) return json({ erro: "Informe a entrada e a saída." }, 400);
    const conflito = await env.DB.prepare("SELECT id, canal, inicio, fim FROM plt_tp_reservas WHERE imovel_id=? AND status='CONFIRMADA' AND inicio < ? AND fim > ? LIMIT 1").bind(im.id, corpo.fim, corpo.inicio).first();
    if (conflito && !corpo.forcar) return json({ erro: `Essas datas já estão ocupadas (${CANAIS[conflito.canal] || conflito.canal}: ${conflito.inicio} a ${conflito.fim}).`, codigo: "CONFLITO" }, 409);
    const tipo = corpo.tipo === "BLOQUEIO" ? "BLOQUEIO" : "RESERVA";
    const id = (await env.DB.prepare("INSERT INTO plt_tp_reservas(org_id,imovel_id,canal,externo_id,tipo,status,hospede,hospedes,inicio,fim,valor,moeda,contato,notas,origem,taxa_limpeza,criado_ms,atualizado_ms) VALUES(?,?,?,?,?,'CONFIRMADA',?,?,?,?,?,?,?,?,'MANUAL',?,?,?) RETURNING id")
      .bind(orgId, im.id, tipo === "BLOQUEIO" ? "direto" : canalOk(corpo.canal || "direto"), "man:" + crypto.randomUUID(), tipo, k.txt(corpo.hospede, 120) || (tipo === "BLOQUEIO" ? "Bloqueio" : "Hóspede"), Number(corpo.hospedes) || null, corpo.inicio, corpo.fim, Number(corpo.valor) || null, im.moeda, k.txt(corpo.contato, 120), k.txt(corpo.notas, 1000),
        tipo === "RESERVA" ? (corpo.taxa_limpeza !== undefined && corpo.taxa_limpeza !== "" ? Number(corpo.taxa_limpeza) || 0 : Number(im.taxa_limpeza || 0) || null) : null, agora, agora).first()).id;
    await agendarLimpezas(env, orgId, im.id, agora);
    if (channexLigado(env) && im.channex_property) await cx(env, "POST", "/availability", { values: [{ property_id: im.channex_property, room_type_id: im.channex_room, date_from: corpo.inicio, date_to: somaDias(corpo.fim, -1), availability: 0 }] }).catch(() => {});
    return json({ ok: true, id });
  }
  if ((m = r.match(/^reservas\/(\d{1,12})\/(cancelar|notas|risco)$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const res = await env.DB.prepare("SELECT * FROM plt_tp_reservas WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).first();
    if (!res) return json({ erro: "Reserva não encontrada." }, 404);
    if (m[2] === "cancelar") {
      if (res.origem !== "MANUAL") return json({ erro: "Reservas das plataformas são canceladas na própria plataforma; a DENIA atualiza sozinha." }, 409);
      await env.DB.prepare("UPDATE plt_tp_reservas SET status='CANCELADA', atualizado_ms=? WHERE id=?").bind(agora, res.id).run();
      await agendarLimpezas(env, orgId, res.imovel_id, agora);
      return json({ ok: true });
    }
    if (m[2] === "notas") { await env.DB.prepare("UPDATE plt_tp_reservas SET notas=?, contato=COALESCE(?,contato), hospedes=COALESCE(?,hospedes), valor=COALESCE(?,valor) WHERE id=?").bind(k.txt(corpo.notas, 2000), k.txt(corpo.contato, 120) || null, Number(corpo.hospedes) || null, Number(corpo.valor) || null, res.id).run(); return json({ ok: true }); }
    const im = await imovel(res.imovel_id);
    const hist = ((await env.DB.prepare("SELECT direcao, texto FROM plt_tp_msgs WHERE reserva_id=? ORDER BY id DESC LIMIT 20").bind(res.id).all())?.results || []).reverse();
    const txt = k.txt(corpo.texto, 3000) || hist.filter(x => x.direcao === "E").map(x => x.texto).join("\n");
    if (!txt) return json({ erro: "Cole a conversa com o hóspede para a IA avaliar." }, 400);
    try {
      const o = await sugerirResposta(env, k, orgId, im, res, txt, hist);
      const risco = { nivel: o.risco || "baixo", sinais: (o.sinais || []).slice(0, 6), em: agora };
      await env.DB.prepare("UPDATE plt_tp_reservas SET risco=? WHERE id=?").bind(JSON.stringify(risco), res.id).run();
      return json({ ok: true, risco });
    } catch (e) { return json({ erro: e.message }, 502); }
  }
  if (r === "mensagens" && metodo === "GET") {
    const l = (await env.DB.prepare(`SELECT r.id, r.hospede, r.canal, r.inicio, r.fim, i.nome imovel, MAX(m.id) ultima_id, MAX(m.criado_ms) ultima_ms, SUM(CASE WHEN m.status='RASCUNHO' THEN 1 ELSE 0 END) rascunhos
      FROM plt_tp_msgs m JOIN plt_tp_reservas r ON r.id=m.reserva_id JOIN plt_tp_imoveis i ON i.id=r.imovel_id WHERE m.org_id=? GROUP BY r.id ORDER BY ultima_ms DESC LIMIT 100`).bind(orgId).all())?.results || [];
    return json({ conversas: l, canais: CANAIS, channex: channexLigado(env) });
  }
  if ((m = r.match(/^mensagens\/(\d{1,12})$/)) && metodo === "GET") {
    const res = await env.DB.prepare("SELECT r.*, i.nome imovel FROM plt_tp_reservas r JOIN plt_tp_imoveis i ON i.id=r.imovel_id WHERE r.id=? AND r.org_id=?").bind(Number(m[1]), orgId).first();
    if (!res) return json({ erro: "Reserva não encontrada." }, 404);
    const msgs = (await env.DB.prepare("SELECT * FROM plt_tp_msgs WHERE reserva_id=? AND org_id=? ORDER BY id LIMIT 300").bind(res.id, orgId).all())?.results || [];
    return json({ reserva: { ...res, risco: json_(res.risco, null) }, mensagens: msgs });
  }
  if ((m = r.match(/^mensagens\/(\d{1,12})\/(enviar|descartar)$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const res = await env.DB.prepare("SELECT * FROM plt_tp_reservas WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).first();
    if (!res) return json({ erro: "Reserva não encontrada." }, 404);
    if (m[2] === "descartar") { await env.DB.prepare("UPDATE plt_tp_msgs SET status='DESCARTADA' WHERE reserva_id=? AND status='RASCUNHO'").bind(res.id).run(); return json({ ok: true }); }
    const texto = k.txt(corpo.texto, 4000);
    if (!texto) return json({ erro: "Escreva a mensagem." }, 400);
    if (!(channexLigado(env) && /^cx:/.test(res.externo_id))) return json({ erro: "Esta reserva veio pelo calendário: responda o hóspede na própria plataforma (copie o texto). Com a conexão oficial (Channex), a DENIA envia direto.", codigo: "SEM_CONEXAO" }, 409);
    try { await cx(env, "POST", `/bookings/${res.externo_id.slice(3)}/messages`, { message: { message: texto } }); }
    catch (e) { return json({ erro: e.message }, 502); }
    await env.DB.batch([
      env.DB.prepare("UPDATE plt_tp_msgs SET status='SUBSTITUIDA' WHERE reserva_id=? AND status='RASCUNHO'").bind(res.id),
      env.DB.prepare("INSERT INTO plt_tp_msgs(org_id,imovel_id,reserva_id,canal,direcao,origem,texto,status,criado_ms) VALUES(?,?,?,?,'S','ANFITRIAO',?,'ENVIADA',?)").bind(orgId, res.imovel_id, res.id, res.canal, texto, agora)
    ]);
    return json({ ok: true });
  }
  // Assistente de respostas: funciona mesmo sem conexão (cole a mensagem do hóspede).
  if (r === "mensagens/sugerir" && metodo === "POST") {
    const { corpo, erro } = await ler(); if (erro) return erro;
    const im = await imovel(corpo.imovel_id); if (!im) return json({ erro: "Escolha o imóvel." }, 400);
    const res = corpo.reserva_id ? await env.DB.prepare("SELECT * FROM plt_tp_reservas WHERE id=? AND org_id=?").bind(Number(corpo.reserva_id), orgId).first() : null;
    const hist = (Array.isArray(corpo.historico) ? corpo.historico : []).slice(-20).map(x => ({ direcao: x.hospede ? "E" : "S", texto: k.txt(x.texto, 600) }));
    try { return json(await sugerirResposta(env, k, orgId, im, res, k.txt(corpo.texto, 3000), hist)); }
    catch (e) { return json({ erro: e.message }, 502); }
  }
  // Aprender com o histórico: o anfitrião cola conversas antigas e a IA tira o jeito de escrever e as respostas frequentes.
  if ((m = r.match(/^imoveis\/(\d{1,12})\/aprender$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(200000); if (erro) return erro;
    const im = await imovel(m[1]); if (!im) return json({ erro: "Imóvel não encontrado." }, 404);
    const texto = k.txt(corpo.conversas, 60000);
    if (texto.length < 200) return json({ erro: "Cole algumas conversas antigas com hóspedes (quanto mais, melhor)." }, 400);
    const envIA = await k.comIA(env, orgId);
    try {
      const o = await openaiResposta(envIA, { modelo: "gpt-5-mini", esforco: "low", maxTokens: 3000, recurso: "temporada/aprender",
        instrucoes: `Você analisa conversas reais de um anfitrião de temporada com hóspedes. Extraia: o JEITO DE ESCREVER do anfitrião (tom, saudações, emojis, tamanho das mensagens, despedidas, com 3 exemplos curtos reais) e as PERGUNTAS FREQUENTES com a resposta que ele costuma dar, e informações do imóvel que aparecem (check-in, regras, wi-fi, estacionamento, arredores). Não inclua nomes, telefones nem e-mails de hóspedes. Responda em JSON {"estilo":"","perguntas":"","checkin":"","regras":"","wifi":"","estacionamento":"","arredores":"","estrutura":""} (campos vazios quando não houver).`,
        entrada: `IMÓVEL: ${im.nome}\n\nCONVERSAS:\n${texto}` });
      const t = json_(im.treinamento, {});
      const sugestao = {};
      for (const [c] of CAMPOS_TREINO_IMOVEL) if (o?.[c]) sugestao[c] = k.txt(o[c], 4000);
      return json({ ok: true, sugestao, atual: t });
    } catch (e) { return json({ erro: e.message }, 502); }
  }
  // Anúncio: a IA avalia título, descrição e fotos e sugere melhorias.
  // Importar o anúncio colando o texto da página (título, descrição, regras, comodidades…): a IA organiza tudo.
  if ((m = r.match(/^imoveis\/(\d{1,12})\/anuncio\/colar$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(120000); if (erro) return erro;
    const im = await imovel(m[1]); if (!im) return json({ erro: "Imóvel não encontrado." }, 404);
    const texto = String(corpo.texto || "").trim().slice(0, 60000);
    if (texto.length < 80) return json({ erro: "Cole o texto do anúncio (abra o anúncio, selecione tudo e copie)." }, 400);
    const envIA = await k.comIA(env, orgId);
    if (!envIA.OPENAI_API_KEY) return json({ erro: "A IA da plataforma ainda não está ligada." }, 503);
    const lista = Object.values(COMODIDADES).flat();
    let x;
    try {
      x = await openaiResposta(envIA, { modelo: "gpt-5-mini", esforco: "low", maxTokens: 4000, recurso: "temporada/anuncio",
        instrucoes: `Você recebe o texto copiado da página de um anúncio de temporada (Airbnb, Booking ou Vrbo), com menus e lixo da página misturados. Extraia SÓ o que é do anúncio, sem inventar. Responda em JSON:
{"titulo":"","descricao":"descrição completa do espaço","cidade":"","capacidade":0,"quartos":0,"banheiros":0,"camas":"ex.: 1 cama de casal e 2 de solteiro","checkin":"HH:MM","checkout":"HH:MM","regras":"regras da casa (festas, pets, fumo, silêncio, visitas)","estrutura":"o espaço, camas e o que tem","estacionamento":"","arredores":"localização e o que tem perto","wifi":"só se o texto disser","perguntas":"perguntas frequentes que o texto responde","comodidades":["use EXATAMENTE nomes desta lista quando houver equivalente: ${lista.join(", ")}"]}
Campos que não aparecem no texto: deixe vazio ("" ou 0). Nunca coloque preço, nome ou contato de hóspedes.`,
        entrada: texto });
    } catch (e) { return json({ erro: e.message }, 502); }
    const tr = json_(im.treinamento, {}), an = json_(im.anuncio, {});
    const junta = (a, b) => { a = String(a || "").trim(); b = String(b || "").trim(); return !b ? a : !a ? b : a.includes(b.slice(0, 60)) ? a : a + "\n\n" + b; };
    for (const c of ["regras", "estrutura", "estacionamento", "arredores", "wifi", "perguntas"]) if (x[c]) tr[c] = cortar(junta(tr[c], x[c]), 4000);
    if (x.checkin || x.checkout) tr.checkin = cortar(junta(tr.checkin, [x.checkin ? "Check-in a partir das " + x.checkin : "", x.checkout ? "Check-out até " + x.checkout : ""].filter(Boolean).join(". ")), 4000);
    if (x.camas) tr.estrutura = cortar(junta(tr.estrutura, "Camas: " + x.camas), 4000);
    const novoAn = { ...an, titulo: cortar(x.titulo || an.titulo, 120), descricao: cortar(x.descricao || an.descricao, 6000) };
    const com = [...new Set([...json_(im.comodidades, []), ...(Array.isArray(x.comodidades) ? x.comodidades : []).filter(c => lista.includes(c))])];
    const n = v => (Number(v) > 0 ? Math.round(Number(v)) : null);
    const hora = v => (/^\d{2}:\d{2}$/.test(String(v || "")) ? v : null);
    await env.DB.prepare("UPDATE plt_tp_imoveis SET anuncio=?, treinamento=?, comodidades=?, cidade=COALESCE(NULLIF(cidade,''),?), capacidade=COALESCE(capacidade,?), quartos=COALESCE(quartos,?), banheiros=COALESCE(banheiros,?), checkin=COALESCE(?,checkin), checkout=COALESCE(?,checkout) WHERE id=? AND org_id=?")
      .bind(JSON.stringify(novoAn), JSON.stringify(tr), JSON.stringify(com), cortar(x.cidade, 80) || null, n(x.capacidade), n(x.quartos), n(x.banheiros), hora(x.checkin), hora(x.checkout), im.id, orgId).run();
    await auditar(env, request, sessao, orgId, "TEMPORADA", `Importou o anúncio de ${im.nome} (texto colado)`);
    return json({ ok: true, titulo: novoAn.titulo, comodidades: com.length, campos: ["regras", "estrutura", "estacionamento", "arredores", "wifi", "perguntas"].filter(c => x[c]), capacidade: n(x.capacidade), quartos: n(x.quartos), banheiros: n(x.banheiros) });
  }
  if ((m = r.match(/^imoveis\/(\d{1,12})\/anuncio\/analisar$/)) && metodo === "POST") {
    const im = await imovel(m[1]); if (!im) return json({ erro: "Imóvel não encontrado." }, 404);
    const an = json_(im.anuncio, {});
    if (!an.titulo && !an.descricao) return json({ erro: "Preencha o título e a descrição do anúncio (e os links das fotos) para a IA analisar." }, 400);
    const envIA = await k.comIA(env, orgId);
    const s = await resumo(env, orgId, iso(agora - 89 * DIA), iso(agora), im.id).catch(() => null);
    try {
      const fotos = (an.fotos || []).slice(0, 6);
      const corpoIA = { model: "gpt-5-mini", reasoning: { effort: "low" }, max_output_tokens: 3000, store: false, text: { format: { type: "json_object" } },
        instructions: `Você é consultor de anúncios de temporada (Airbnb, Booking.com, Vrbo) e conhece o que faz um anúncio aparecer e converter. Avalie o anúncio e as fotos. Seja específico e prático. Responda no idioma do anúncio, em JSON {"nota":0,"resumo":"","titulo_sugerido":"","descricao_sugerida":"","melhorias":[""],"fotos":[{"foto":1,"comentario":""}],"ordem_fotos":[1],"faltando":[""],"preco":""}. "nota" de 0 a 10.`,
        input: [{ role: "user", content: [{ type: "input_text", text: `IMÓVEL: ${im.nome} — ${im.cidade || ""} · ${im.capacidade || "?"} pessoas · ${im.quartos || "?"} quartos · ${im.banheiros || "?"} banheiros\nPREÇO BASE: ${im.preco_base || "?"} ${im.moeda} · fim de semana ${im.preco_fds || "-"}\nOCUPAÇÃO 90 DIAS: ${s?.ocupacao ?? "?"}% · diária média ${s?.diaria_media ?? "?"}\n\nTÍTULO: ${an.titulo || ""}\n\nDESCRIÇÃO:\n${an.descricao || ""}` }, ...fotos.map(u => ({ type: "input_image", image_url: u, detail: "low" }))] }] };
      const d = await k.openai(envIA, "responses", corpoIA);
      let saida = ""; for (const o of d?.output || []) for (const c of o?.content || []) if (typeof c?.text === "string") saida += c.text;
      return json({ ok: true, analise: json_(saida, {}) });
    } catch (e) { return json({ erro: e.message }, 502); }
  }
  if (r === "limpezas" && metodo === "GET") {
    const l = (await env.DB.prepare("SELECT l.*, i.nome imovel, r.hospede, r.canal FROM plt_tp_limpezas l JOIN plt_tp_imoveis i ON i.id=l.imovel_id LEFT JOIN plt_tp_reservas r ON r.id=l.reserva_id WHERE l.org_id=? AND l.data BETWEEN ? AND ? AND l.status<>'CANCELADA' ORDER BY l.data LIMIT 200").bind(orgId, iso(agora - 7 * DIA), iso(agora + 60 * DIA)).all())?.results || [];
    return json({ limpezas: l });
  }
  if ((m = r.match(/^limpezas\/(\d{1,12})$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    await env.DB.prepare("UPDATE plt_tp_limpezas SET status=COALESCE(?,status), responsavel=COALESCE(?,responsavel) WHERE id=? AND org_id=?").bind(["PENDENTE", "FEITA"].includes(corpo.status) ? corpo.status : null, corpo.responsavel !== undefined ? k.txt(corpo.responsavel, 80) : null, Number(m[1]), orgId).run();
    return json({ ok: true });
  }
  if (r === "relatorio" && metodo === "GET") {
    const mes = /^\d{4}-\d{2}$/.test(q.get("mes") || "") ? q.get("mes") : iso(agora).slice(0, 7);
    const de = mes + "-01", ate = somaDias(iso(Date.UTC(+mes.slice(0, 4), +mes.slice(5, 7), 1)), -1);
    const ims = (await env.DB.prepare("SELECT id, nome FROM plt_tp_imoveis WHERE org_id=? AND ativo=1 ORDER BY nome").bind(orgId).all())?.results || [];
    const geral = await resumo(env, orgId, de, ate);
    const porImovel = [];
    for (const im of ims.slice(0, 40)) { const s = await resumo(env, orgId, de, ate, im.id); porImovel.push({ id: im.id, nome: im.nome, ocupacao: s.ocupacao, receita: s.receita, diaria_media: s.diaria_media, reservas: s.reservas, noites: s.noites_ocupadas }); }
    const anterior = await resumo(env, orgId, somaDias(de, -noites(de, somaDias(ate, 1))), somaDias(de, -1));
    return json({ mes, de, ate, geral: { ...geral, serie: undefined }, anterior: { ocupacao: anterior.ocupacao, receita: anterior.receita, diaria_media: anterior.diaria_media }, imoveis: porImovel });
  }
  if (r === "config" && metodo === "GET") {
    const cfg = json_((await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind("tp_config_" + orgId).first())?.valor, {});
    return json({ config: { idioma: "português do Brasil", idioma_resposta: "HOSPEDE", modelo: "gpt-5-mini", ...cfg }, channex: channexLigado(env), webhook: channexLigado(env) ? new URL(`/webhook/channex?org=${orgId}&t=${(await k.hmac(await k.segredo(env), "channex:" + orgId)).slice(0, 32)}`, request.url).toString() : null });
  }
  if (r === "config" && metodo === "POST") {
    const negado = precisa("ADMIN"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const cfg = { idioma: k.txt(corpo.idioma, 60) || "português do Brasil", idioma_resposta: corpo.idioma_resposta === "ANFITRIAO" ? "ANFITRIAO" : "HOSPEDE", modelo: ["gpt-5-mini", "gpt-4.1", "gpt-5-nano"].includes(corpo.modelo) ? corpo.modelo : "gpt-5-mini" };
    await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind("tp_config_" + orgId, JSON.stringify(cfg)).run();
    return json({ ok: true, config: cfg });
  }
  // Conta inteira: abre a tela segura do Channex para a empresa entrar no Airbnb/Booking/Vrbo uma vez;
  // depois, "Importar" traz todos os anúncios ligados (e o aviso do Channex importa sozinho os que chegarem).
  if ((r === "channex/conta" || r === "channex/importar") && metodo === "POST") {
    const negado = precisa("ADMIN"); if (negado) return negado;
    if (!channexLigado(env)) return json({ erro: "A conexão oficial com as plataformas ainda não foi ativada na DENIA. Enquanto isso, use os calendários (iCal).", codigo: "SEM_CHANNEX" }, 503);
    if (!k.superAdmin && k.acesso && !k.acesso.cortesia && k.acesso.status !== "ATIVO") return json({ erro: "A conexão oficial é liberada depois do primeiro pagamento. No teste grátis, use os calendários (iCal).", codigo: "PLANO_PAGO" }, 402);
    try {
      if (r === "channex/importar") return json({ ok: true, ...(await importarDoChannex(env, k, orgId, request.url)) });
      const grupo = await grupoChannex(env, orgId);
      const tok = await cx(env, "POST", "/auth/one_time_token", { one_time_token: { group_id: grupo, username: sessao?.usuario?.email || "denia" } });
      const chave = tok?.data?.token || tok?.data?.attributes?.token;
      return json({ ok: true, url: `${channexBase(env)}/auth/exchange?oauth_session_key=${encodeURIComponent(chave)}&app_mode=headless&redirect_to=/channels&group_id=${grupo}` });
    } catch (e) { return json({ erro: e.message }, 502); }
  }
  // Conexão oficial: cria o imóvel no Channex e abre a tela segura para entrar no Airbnb/Booking/Vrbo.
  if ((m = r.match(/^imoveis\/(\d{1,12})\/conectar$/)) && metodo === "POST") {
    const negado = precisa("ADMIN"); if (negado) return negado;
    if (!channexLigado(env)) return json({ erro: "A conexão oficial com as plataformas ainda não foi ativada na DENIA. Enquanto isso, use os calendários (iCal).", codigo: "SEM_CHANNEX" }, 503);
    // A conexão oficial tem custo por imóvel: só para quem já pagou (ou tem cortesia). No teste grátis, use o calendário.
    if (!k.superAdmin && k.acesso && !k.acesso.cortesia && k.acesso.status !== "ATIVO") return json({ erro: "A conexão oficial (mensagens, preços e reservas em tempo real) é liberada depois do primeiro pagamento. No teste grátis, use os calendários (iCal) — já evitam reserva dupla.", codigo: "PLANO_PAGO" }, 402);
    let im = await imovel(m[1]); if (!im) return json({ erro: "Imóvel não encontrado." }, 404);
    try {
      im = await garantirChannex(env, k, im);
      await cx(env, "POST", "/webhooks", { webhook: { property_id: im.channex_property, callback_url: new URL(`/webhook/channex?org=${orgId}&t=${(await k.hmac(await k.segredo(env), "channex:" + orgId)).slice(0, 32)}`, request.url).toString(), event_mask: "booking,message", is_active: true, send_data: true } }).catch(() => {});
      await enviarPrecosChannex(env, k, im, iso(agora), iso(agora + 365 * DIA)).catch(() => {});
      const tok = await cx(env, "POST", "/auth/one_time_token", { one_time_token: { property_id: im.channex_property, username: sessao?.usuario?.email || "denia" } });
      const chave = tok?.data?.token || tok?.data?.attributes?.token;
      return json({ ok: true, url: `${channexBase(env)}/auth/exchange?oauth_session_key=${encodeURIComponent(chave)}&app_mode=headless&redirect_to=/channels&property_id=${im.channex_property}` });
    } catch (e) { return json({ erro: e.message }, 502); }
  }
  return json({ erro: "Rota não encontrada." }, 404);
}

// Calendário único do imóvel (para colar no Airbnb, Booking e Vrbo). /tp/ical/<token>.ics ou /tp/ical/<token>/<canal>.ics
export async function icalPublico(env, caminho) {
  const m = caminho.match(/^\/tp\/ical\/([a-f0-9]{36})(?:\/(airbnb|booking|vrbo|outro))?\.ics$/);
  if (!m) return null;
  const im = await env.DB.prepare("SELECT * FROM plt_tp_imoveis WHERE ical_token=? AND ativo=1").bind(m[1]).first();
  if (!im) return new Response("Calendário não encontrado.", { status: 404 });
  const hoje = iso(Date.now() - 2 * DIA);
  // Para a plataforma X, manda as ocupações das OUTRAS (a própria plataforma já sabe as suas).
  const res = (await env.DB.prepare(`SELECT id, canal, inicio, fim, tipo FROM plt_tp_reservas WHERE imovel_id=? AND status='CONFIRMADA' AND fim >= ? ${m[2] ? "AND canal<>?" : ""} LIMIT 2000`).bind(im.id, hoje, ...(m[2] ? [m[2]] : [])).all())?.results || [];
  const fech = (await env.DB.prepare("SELECT data FROM plt_tp_precos WHERE imovel_id=? AND fechado=1 AND data >= ? ORDER BY data LIMIT 800").bind(im.id, hoje).all())?.results || [];
  const eventos = res.map(r => ({ uid: "r" + r.id, inicio: r.inicio, fim: r.fim, titulo: r.tipo === "BLOQUEIO" ? "Indisponível" : "Reservado" }));
  for (const f of fech) eventos.push({ uid: "f" + im.id + f.data, inicio: f.data, fim: somaDias(f.data, 1), titulo: "Fechado" });
  const janela = fimDaJanela(im, Date.now());
  if (janela) eventos.push({ uid: "janela" + im.id, inicio: somaDias(janela, 1), fim: somaDias(janela, 3 * 365), titulo: "Fora da janela de reservas" });
  return new Response(gerarIcal(im.nome, eventos), { headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-store" } });
}

// Cron (1x por dia): quem parou de pagar tem a conexão oficial desligada, para não gerar custo por imóvel.
// O calendário (iCal), os dados e o treinamento continuam guardados; ao voltar a pagar, é só conectar de novo.
export async function desligarInadimplentes(env, k, acessoDe) {
  if (!channexLigado(env)) return 0;
  const orgs = (await env.DB.prepare("SELECT DISTINCT org_id FROM plt_tp_imoveis WHERE channex_property IS NOT NULL LIMIT 200").all())?.results || [];
  let n = 0;
  for (const { org_id } of orgs) {
    const a = await acessoDe(org_id);
    if (!a || a.liberado) continue;
    const ims = (await env.DB.prepare("SELECT id, nome, channex_property FROM plt_tp_imoveis WHERE org_id=? AND channex_property IS NOT NULL").bind(org_id).all())?.results || [];
    for (const im of ims) {
      await cx(env, "DELETE", "/properties/" + im.channex_property).catch(e => console.warn("channex desligar", e?.message));
      await env.DB.prepare("UPDATE plt_tp_imoveis SET channex_property=NULL, channex_room=NULL, channex_rates=NULL WHERE id=?").bind(im.id).run();
      n++;
    }
    if (ims.length && k.avisar) await k.avisar(org_id, `A conexão oficial com Airbnb, Booking e Vrbo foi pausada (${ims.length} imóvel(is)) porque o plano está pendente. Seus calendários, reservas e o treinamento da IA continuam guardados. Para voltar, regularize em Plano e pagamento e conecte de novo.`).catch(() => {});
  }
  return n;
}

// ---------------------------------------------------------------------------
// Ferramentas do anfitrião: cotação, valores das reservas (e planilha das plataformas), anotações de melhoria,
// estoque com conferência a cada check-out, fotos, comodidades e pesquisa de mercado.
// ---------------------------------------------------------------------------

// Comissão que cada plataforma desconta do anfitrião (padrão; o anfitrião ajusta conforme o contrato dele).
export const TAXAS_PADRAO = { airbnb: 3, booking: 15, vrbo: 8 };
// Quanto fica uma estadia: diárias (base, fim de semana e datas especiais), desconto semanal/mensal, limpeza e hóspede extra.
export async function cotar(env, im, inicio, fim, hospedes = 0, canal = "direto") {
  const n = noites(inicio, fim);
  const esp = new Map((((await env.DB.prepare("SELECT * FROM plt_tp_precos WHERE imovel_id=? AND data>=? AND data<?").bind(im.id, inicio, fim).all())?.results) || []).map(x => [x.data, x]));
  let diarias = 0, fechado = false, minimo = Number(im.minimo_noites || 1);
  for (let d = inicio; d < fim; d = somaDias(d, 1)) { const e = esp.get(d); diarias += precoNoCanal(precoDoDia(im, d, e), im, canal); if (e?.fechado) fechado = true; if (d === inicio && e?.minimo) minimo = e.minimo; }
  const pct = n >= 28 && Number(im.desconto_mensal) > 0 ? Number(im.desconto_mensal) : n >= 7 && Number(im.desconto_semanal) > 0 ? Number(im.desconto_semanal) : 0;
  const desconto = Math.round(diarias * pct) / 100;
  const extras = Math.max(0, Number(hospedes || 0) - Number(im.hospedes_incluidos || im.capacidade || 99)) * Number(im.taxa_hospede_extra || 0) * n;
  const limpeza = Number(im.taxa_limpeza || 0);
  const r2 = x => Math.round(x * 100) / 100;
  const taxa = { ...TAXAS_PADRAO, ...json_(im.taxas_plataforma, {}) }[canal] || 0;
  const total = diarias - desconto + extras + limpeza;
  return { taxa_plataforma_pct: taxa, taxa_plataforma: r2(total * taxa / 100), voce_recebe: r2(total * (1 - taxa / 100)), noites: n, diarias: r2(diarias), desconto_pct: pct, desconto: r2(desconto), hospede_extra: r2(extras), limpeza: r2(limpeza), total: r2(diarias - desconto + extras + limpeza), media_noite: n ? r2((diarias - desconto) / n) : 0,
    minimo_noites: minimo, abaixo_do_minimo: n < minimo, acima_do_maximo: Number(im.maximo_noites) > 0 && n > Number(im.maximo_noites), fechado, moeda: im.moeda || "BRL" };
}

const tokenLimpeza = async (env, k, id) => (await k.hmac(await k.segredo(env), "tp-limpeza:" + id)).replace(/[^A-Za-z0-9]/g, "").slice(0, 32);
async function linksLimpeza(env, k, base, id) { return `${String(base || "").replace(/\/+$/, "")}/tp/limpeza/${id}-${await tokenLimpeza(env, k, id)}`; }

// Grava a contagem do estoque (do painel, da voz ou do link da limpeza) com o histórico.
async function gravarEstoque(env, orgId, imovelId, itens, { origem, autor, limpezaId, agora }) {
  const atuais = new Map((((await env.DB.prepare("SELECT * FROM plt_tp_estoque WHERE org_id=? AND imovel_id=?").bind(orgId, imovelId).all())?.results) || []).map(x => [x.id, x]));
  const st = [], usados = [];
  for (const it of itens) {
    const a = atuais.get(Number(it.id));
    if (!a) continue;
    const q2 = Math.max(0, Math.min(100000, Number(it.quantidade)));
    if (!Number.isFinite(q2)) continue;
    st.push(env.DB.prepare("UPDATE plt_tp_estoque SET quantidade=?, atualizado_ms=?, atualizado_por=? WHERE id=?").bind(q2, agora, autor || origem, a.id));
    if (q2 !== Number(a.quantidade)) usados.push({ item: a.item, antes: Number(a.quantidade), depois: q2, unidade: a.unidade || "" });
    if (q2 !== Number(a.quantidade)) st.push(env.DB.prepare("INSERT INTO plt_tp_estoque_mov(org_id,imovel_id,item_id,antes,depois,origem,limpeza_id,autor,ms) VALUES(?,?,?,?,?,?,?,?,?)").bind(orgId, imovelId, a.id, a.quantidade, q2, origem, limpezaId || null, autor || null, agora));
  }
  if (limpezaId) st.push(env.DB.prepare("UPDATE plt_tp_limpezas SET estoque_ok_ms=? WHERE id=? AND org_id=?").bind(agora, limpezaId, orgId));
  for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
  const baixos = (((await env.DB.prepare("SELECT item, quantidade, minimo, unidade FROM plt_tp_estoque WHERE org_id=? AND imovel_id=? AND quantidade <= minimo AND minimo > 0 ORDER BY item").bind(orgId, imovelId).all())?.results) || []);
  return { atualizados: itens.length, baixos, usados };
}

// Cron (de hora em hora): depois de cada check-out, pede a conferência do estoque (link sem login para quem limpa)
// e avisa o que está acabando.
// Cron (1x por dia): com janela de reservas, abre nas plataformas o dia novo que entrou na janela.
async function moverJanelas(env, k) {
  if (!channexLigado(env)) return;
  const hoje = iso(k.agora(env));
  const feito = (await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave='tp_janela_dia'").first().catch(() => null))?.valor;
  if (feito === hoje) return;
  await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES('tp_janela_dia',?)").bind(hoje).run();
  const ims = (((await env.DB.prepare("SELECT * FROM plt_tp_imoveis WHERE ativo=1 AND channex_property IS NOT NULL AND janela_meses > 0 LIMIT 300").all().catch(() => null))?.results) || []);
  for (const im of ims) { const fim = fimDaJanela(im, k.agora(env)); await enviarPrecosChannex(env, k, im, somaDias(fim, -3), somaDias(fim, 1)).catch(e => console.warn("janela", e?.message)); }
}
export async function lembrarEstoque(env, k) {
  await moverJanelas(env, k).catch(() => { });
  const agora = k.agora(env), hoje = iso(agora - 3 * 3600000);
  const ult = Number((await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave='tp_estoque_ms'").first().catch(() => null))?.valor || 0);
  if (agora - ult < 55 * 60000) return 0;
  await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES('tp_estoque_ms',?)").bind(String(agora)).run();
  const pend = (((await env.DB.prepare(`SELECT l.id, l.org_id, l.imovel_id, l.data, l.responsavel, i.nome FROM plt_tp_limpezas l JOIN plt_tp_imoveis i ON i.id=l.imovel_id
    WHERE l.data <= ? AND l.data >= ? AND l.status<>'CANCELADA' AND l.estoque_ok_ms IS NULL AND l.fim_ms IS NULL AND l.aviso_ms IS NULL AND (EXISTS (SELECT 1 FROM plt_tp_estoque e WHERE e.imovel_id=l.imovel_id) OR EXISTS (SELECT 1 FROM plt_tp_comodos c WHERE c.imovel_id=l.imovel_id)) LIMIT 40`).bind(hoje, somaDias(hoje, -3)).all().catch(() => null))?.results) || []);
  let n = 0;
  for (const l of pend) {
    const baixos = (((await env.DB.prepare("SELECT item, quantidade, unidade FROM plt_tp_estoque WHERE imovel_id=? AND quantidade <= minimo AND minimo > 0").bind(l.imovel_id).all())?.results) || []);
    const link = await linksLimpeza(env, k, k.base, l.id);
    const brief = textoBriefing(await briefingLimpeza(env, { ...l, data: l.data }, agora));
    if (k.alertarEmail) await k.alertarEmail(l.org_id, `DENIA — limpeza de hoje em ${l.nome}: confira o estoque`, `Limpeza de ${l.nome} marcada para ${l.data.split("-").reverse().join("/")}.\n\n${brief || (baixos.length ? "Já está acabando: " + baixos.map(b => `${b.item} (${b.quantidade} ${b.unidade || ""})`).join(", ") + "." : "")}\n\nMande este link para quem vai limpar (abre no celular, sem login, com o checklist de cada cômodo, o inventário e o estoque):\n${link}\n\nNo painel: Locação por temporada → Limpezas.`).catch(() => { });
    await env.DB.prepare("UPDATE plt_tp_limpezas SET aviso_ms=? WHERE id=?").bind(agora, l.id).run();
    n++;
  }
  return n;
}

// Planilha de reservas exportada do Airbnb/Booking/Vrbo: preenche valor, limpeza, hóspede e código das reservas que vieram pelo calendário.
async function importarPlanilhaReservas(env, orgId, corpo, agora, k) {
  const ims = (((await env.DB.prepare("SELECT * FROM plt_tp_imoveis WHERE org_id=? AND ativo=1").bind(orgId).all())?.results) || []);
  const norm = t => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const fixo = ims.find(i => i.id === Number(corpo.imovel_id));
  const canal = canalOk(corpo.canal || "airbnb");
  let atualizadas = 0, criadas = 0, sem_imovel = 0, invalidas = 0;
  for (const l of (Array.isArray(corpo.linhas) ? corpo.linhas : []).slice(0, 2000)) {
    if (!dataOk(l.inicio) || !dataOk(l.fim) || l.fim <= l.inicio) { invalidas++; continue; }
    const an = norm(l.anuncio);
    const im = fixo || ims.find(i => an && (norm(i.nome) === an || an.includes(norm(i.nome)) || norm(i.nome).includes(an)));
    if (!im) { sem_imovel++; continue; }
    const valor = Number(l.valor) || null, limpeza = l.limpeza !== undefined && l.limpeza !== "" ? Number(l.limpeza) || 0 : null, taxas = Number(l.taxas) || null;
    const ja = await env.DB.prepare("SELECT id FROM plt_tp_reservas WHERE org_id=? AND imovel_id=? AND inicio=? AND fim=? AND status='CONFIRMADA' ORDER BY (tipo='RESERVA') DESC LIMIT 1").bind(orgId, im.id, l.inicio, l.fim).first();
    if (ja) {
      await env.DB.prepare("UPDATE plt_tp_reservas SET tipo='RESERVA', valor=COALESCE(?,valor), taxa_limpeza=COALESCE(?,taxa_limpeza), taxas=COALESCE(?,taxas), hospede=COALESCE(NULLIF(?,''),hospede), hospedes=COALESCE(?,hospedes), codigo=COALESCE(NULLIF(?,''),codigo), atualizado_ms=? WHERE id=?")
        .bind(valor, limpeza, taxas, k.txt(l.hospede, 120), Number(l.hospedes) || null, k.txt(l.codigo, 60), agora, ja.id).run();
      atualizadas++;
    } else if (corpo.criar !== false) {
      await env.DB.prepare("INSERT OR IGNORE INTO plt_tp_reservas(org_id,imovel_id,canal,externo_id,tipo,status,hospede,hospedes,inicio,fim,valor,moeda,origem,taxa_limpeza,taxas,codigo,criado_ms,atualizado_ms) VALUES(?,?,?,?,'RESERVA',?,?,?,?,?,?,?,'PLANILHA',?,?,?,?,?)")
        .bind(orgId, im.id, canal, "csv:" + (k.txt(l.codigo, 60) || `${l.inicio}_${l.fim}`), /cancel/i.test(l.status || "") ? "CANCELADA" : "CONFIRMADA", k.txt(l.hospede, 120) || "Hóspede", Number(l.hospedes) || null, l.inicio, l.fim, valor, im.moeda, limpeza, taxas, k.txt(l.codigo, 60) || null, agora, agora).run();
      criadas++;
    }
  }
  return { atualizadas, criadas, sem_imovel, invalidas };
}

async function rotasTemporadaExtra(request, env, k, orgId, r, { json, ler, precisa, imovel, agora, q }) {
  const metodo = request.method;
  const autor = k.sessao?.usuario?.nome || k.sessao?.usuario?.email || "Equipe";
  let m;
  if (r === "comodidades" && metodo === "GET") return json({ comodidades: COMODIDADES });
  // Desligar a conexão oficial de um imóvel (o calendário iCal e os dados continuam).
  if ((m = r.match(/^imoveis\/(\d{1,12})\/desconectar$/)) && metodo === "POST") {
    const negado = precisa("ADMIN"); if (negado) return negado;
    const im = await imovel(m[1]); if (!im) return json({ erro: "Imóvel não encontrado." }, 404);
    if (im.channex_property && channexLigado(env)) await cx(env, "DELETE", "/properties/" + im.channex_property).catch(e => console.warn("channex desconectar", e?.message));
    await env.DB.prepare("UPDATE plt_tp_imoveis SET channex_property=NULL, channex_room=NULL, channex_rates=NULL WHERE id=? AND org_id=?").bind(im.id, orgId).run();
    await k.auditar(env, request, k.sessao, orgId, "TEMPORADA", `Desconectou ${im.nome} da conexão oficial`);
    return json({ ok: true });
  }
  if (r === "cotacao" && metodo === "GET") {
    const im = await imovel(q.get("imovel")); if (!im) return json({ erro: "Escolha o imóvel." }, 400);
    if (!dataOk(q.get("inicio")) || !dataOk(q.get("fim")) || q.get("fim") <= q.get("inicio") || noites(q.get("inicio"), q.get("fim")) > 365) return json({ erro: "Escolha a entrada e a saída." }, 400);
    const ocupado = await env.DB.prepare("SELECT canal, inicio, fim FROM plt_tp_reservas WHERE imovel_id=? AND status='CONFIRMADA' AND inicio < ? AND fim > ? LIMIT 1").bind(im.id, q.get("fim"), q.get("inicio")).first();
    return json({ ...(await cotar(env, im, q.get("inicio"), q.get("fim"), Number(q.get("hospedes")) || 0, canalOk(q.get("canal") || "direto"))), ocupado: ocupado || null });
  }
  // Valores de uma reserva (o calendário não traz): total, limpeza, taxas da plataforma, hóspede.
  if ((m = r.match(/^reservas\/(\d{1,12})\/valores$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const n2 = v => v === undefined ? null : v === "" || v === null ? null : Number(v);
    await env.DB.prepare("UPDATE plt_tp_reservas SET valor=COALESCE(?,valor), taxa_limpeza=COALESCE(?,taxa_limpeza), taxas=COALESCE(?,taxas), hospede=COALESCE(NULLIF(?,''),hospede), hospedes=COALESCE(?,hospedes), tipo=CASE WHEN ?='1' THEN 'RESERVA' ELSE tipo END, atualizado_ms=? WHERE id=? AND org_id=?")
      .bind(n2(corpo.valor), n2(corpo.taxa_limpeza), n2(corpo.taxas), k.txt(corpo.hospede, 120), n2(corpo.hospedes), corpo.e_reserva ? "1" : "0", agora, Number(m[1]), orgId).run();
    return json({ ok: true });
  }
  if (r === "reservas/importar" && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(900000); if (erro) return erro;
    const res = await importarPlanilhaReservas(env, orgId, corpo, agora, k);
    await k.auditar(env, request, k.sessao, orgId, "TEMPORADA", `Planilha de reservas importada: ${res.atualizadas} atualizada(s), ${res.criadas} nova(s)`);
    return json({ ok: true, ...res });
  }

  // Anotações de melhoria (manutenção, compras, ideias) por imóvel.
  if (r === "notas" && metodo === "GET") {
    const im = Number(q.get("imovel")) || 0;
    const l = (((await env.DB.prepare(`SELECT n.*, i.nome imovel FROM plt_tp_notas n JOIN plt_tp_imoveis i ON i.id=n.imovel_id WHERE n.org_id=? ${im ? "AND n.imovel_id=?" : ""} ORDER BY n.status='FEITA', CASE n.prioridade WHEN 'ALTA' THEN 0 WHEN 'MEDIA' THEN 1 ELSE 2 END, n.id DESC LIMIT 500`).bind(orgId, ...(im ? [im] : [])).all())?.results) || []);
    return json({ notas: l });
  }
  if ((r === "notas" || (m = r.match(/^notas\/(\d{1,12})$/))) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const pri = ["ALTA", "MEDIA", "BAIXA"].includes(corpo.prioridade) ? corpo.prioridade : null, st = ["ABERTA", "ANDAMENTO", "FEITA"].includes(corpo.status) ? corpo.status : null;
    if (m) {
      await env.DB.prepare("UPDATE plt_tp_notas SET texto=COALESCE(NULLIF(?,''),texto), categoria=COALESCE(?,categoria), prioridade=COALESCE(?,prioridade), status=COALESCE(?,status), custo=COALESCE(?,custo), feito_ms=CASE WHEN ?='FEITA' THEN ? ELSE feito_ms END WHERE id=? AND org_id=?")
        .bind(k.txt(corpo.texto, 1500), corpo.categoria !== undefined ? k.txt(corpo.categoria, 40) : null, pri, st, corpo.custo !== undefined && corpo.custo !== "" ? Number(corpo.custo) || 0 : null, st || "", agora, Number(m[1]), orgId).run();
      return json({ ok: true });
    }
    const im = await imovel(corpo.imovel_id); if (!im) return json({ erro: "Escolha o imóvel." }, 400);
    const texto = k.txt(corpo.texto, 1500); if (!texto) return json({ erro: "Escreva a anotação." }, 400);
    const id = (await env.DB.prepare("INSERT INTO plt_tp_notas(org_id,imovel_id,texto,categoria,prioridade,status,custo,autor,criado_ms) VALUES(?,?,?,?,?,'ABERTA',?,?,?) RETURNING id").bind(orgId, im.id, texto, k.txt(corpo.categoria, 40) || null, pri || "MEDIA", Number(corpo.custo) || null, autor, agora).first()).id;
    return json({ ok: true, id });
  }
  if ((m = r.match(/^notas\/(\d{1,12})\/excluir$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    await env.DB.prepare("DELETE FROM plt_tp_notas WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).run();
    return json({ ok: true });
  }

  // Estoque por imóvel.
  if (r === "estoque" && metodo === "GET") {
    const im = Number(q.get("imovel")) || 0;
    const [itens, pend, mov] = await Promise.all([
      env.DB.prepare(`SELECT e.*, i.nome imovel FROM plt_tp_estoque e JOIN plt_tp_imoveis i ON i.id=e.imovel_id WHERE e.org_id=? ${im ? "AND e.imovel_id=?" : ""} ORDER BY i.nome, e.categoria, e.item LIMIT 2000`).bind(orgId, ...(im ? [im] : [])).all(),
      env.DB.prepare(`SELECT l.id, l.data, l.imovel_id, i.nome imovel, l.responsavel FROM plt_tp_limpezas l JOIN plt_tp_imoveis i ON i.id=l.imovel_id WHERE l.org_id=? AND l.data <= ? AND l.data >= ? AND l.status<>'CANCELADA' AND l.estoque_ok_ms IS NULL ${im ? "AND l.imovel_id=?" : ""} ORDER BY l.data DESC LIMIT 30`).bind(orgId, iso(agora), iso(agora - 14 * DIA), ...(im ? [im] : [])).all(),
      env.DB.prepare(`SELECT m.*, e.item, e.unidade, i.nome imovel FROM plt_tp_estoque_mov m JOIN plt_tp_estoque e ON e.id=m.item_id JOIN plt_tp_imoveis i ON i.id=m.imovel_id WHERE m.org_id=? ${im ? "AND m.imovel_id=?" : ""} ORDER BY m.ms DESC LIMIT 60`).bind(orgId, ...(im ? [im] : [])).all()
    ]);
    const pendentes = [];
    for (const p of pend?.results || []) pendentes.push({ ...p, link: await linksLimpeza(env, k, new URL(request.url).origin, p.id) });
    return json({ itens: itens?.results || [], pendentes, movimentos: mov?.results || [], padrao: ESTOQUE_PADRAO.map(([item, categoria, quantidade, minimo, unidade]) => ({ item, categoria, quantidade, minimo, unidade })) });
  }
  if (r === "estoque" && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const im = await imovel(corpo.imovel_id); if (!im) return json({ erro: "Escolha o imóvel." }, 400);
    const lista = corpo.padrao ? ESTOQUE_PADRAO.map(([item, categoria, quantidade, minimo, unidade]) => ({ item, categoria, quantidade, minimo, unidade })) : (Array.isArray(corpo.itens) ? corpo.itens : [corpo]);
    let n = 0;
    for (const it of lista.slice(0, 200)) {
      const nome = k.txt(it.item, 80); if (!nome) continue;
      const qt = Math.max(0, Number(it.quantidade) || 0), mn = Math.max(0, Number(it.minimo) || 0);
      const antes = await env.DB.prepare("SELECT id, quantidade FROM plt_tp_estoque WHERE imovel_id=? AND item=?").bind(im.id, nome).first();
      await env.DB.prepare("INSERT INTO plt_tp_estoque(org_id,imovel_id,item,categoria,quantidade,minimo,unidade,atualizado_ms,atualizado_por) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(imovel_id,item) DO UPDATE SET categoria=COALESCE(excluded.categoria,categoria), quantidade=excluded.quantidade, minimo=excluded.minimo, unidade=COALESCE(excluded.unidade,unidade), atualizado_ms=excluded.atualizado_ms, atualizado_por=excluded.atualizado_por")
        .bind(orgId, im.id, nome, k.txt(it.categoria, 40) || null, qt, mn, k.txt(it.unidade, 20) || null, agora, autor).run();
      if (antes && Number(antes.quantidade) !== qt) await env.DB.prepare("INSERT INTO plt_tp_estoque_mov(org_id,imovel_id,item_id,antes,depois,origem,autor,ms) VALUES(?,?,?,?,?,'MANUAL',?,?)").bind(orgId, im.id, antes.id, antes.quantidade, qt, autor, agora).run();
      n++;
    }
    return json({ ok: true, itens: n });
  }
  if (r === "estoque/conferir" && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const im = await imovel(corpo.imovel_id); if (!im) return json({ erro: "Escolha o imóvel." }, 400);
    const lim = corpo.limpeza_id ? await env.DB.prepare("SELECT id FROM plt_tp_limpezas WHERE id=? AND org_id=? AND imovel_id=?").bind(Number(corpo.limpeza_id), orgId, im.id).first() : null;
    return json({ ok: true, ...(await gravarEstoque(env, orgId, im.id, Array.isArray(corpo.itens) ? corpo.itens : [], { origem: corpo.origem === "VOZ" ? "VOZ" : "MANUAL", autor, limpezaId: lim?.id, agora })) });
  }
  if ((m = r.match(/^estoque\/(\d{1,12})\/excluir$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    await env.DB.batch([env.DB.prepare("DELETE FROM plt_tp_estoque WHERE id=? AND org_id=?").bind(Number(m[1]), orgId), env.DB.prepare("DELETE FROM plt_tp_estoque_mov WHERE item_id=? AND org_id=?").bind(Number(m[1]), orgId)]);
    return json({ ok: true });
  }
  if ((m = r.match(/^limpezas\/(\d{1,12})\/link$/)) && metodo === "GET") {
    const l = await env.DB.prepare("SELECT id FROM plt_tp_limpezas WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).first();
    if (!l) return json({ erro: "Limpeza não encontrada." }, 404);
    return json({ link: await linksLimpeza(env, k, new URL(request.url).origin, l.id) });
  }

  // Fotos do imóvel (guardadas reduzidas na DENIA; a IA e a análise do anúncio usam).
  if ((m = r.match(/^imoveis\/(\d{1,12})\/fotos$/)) && metodo === "GET") {
    const l = (((await env.DB.prepare("SELECT id, legenda, ordem, criado_ms FROM plt_tp_fotos WHERE org_id=? AND imovel_id=? AND limpeza_id IS NULL AND mime LIKE 'image/%' ORDER BY ordem, id").bind(orgId, Number(m[1])).all())?.results) || []);
    return json({ fotos: l });
  }
  if ((m = r.match(/^imoveis\/(\d{1,12})\/fotos$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(1600000); if (erro) return erro;
    const im = await imovel(m[1]); if (!im) return json({ erro: "Imóvel não encontrado." }, 404);
    const d = String(corpo.dados || "").match(/^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!d || d[3].length > 1400000) return json({ erro: "Envie uma foto JPG, PNG ou WebP (a DENIA reduz antes de enviar)." }, 400);
    const n = Number((await env.DB.prepare("SELECT COUNT(*) n FROM plt_tp_fotos WHERE imovel_id=?").bind(im.id).first())?.n || 0);
    if (n >= 60) return json({ erro: "Até 60 fotos por imóvel." }, 400);
    const id = (await env.DB.prepare("INSERT INTO plt_tp_fotos(org_id,imovel_id,mime,dados,legenda,ordem,criado_ms) VALUES(?,?,?,?,?,?,?) RETURNING id").bind(orgId, im.id, d[1], d[3], k.txt(corpo.legenda, 140) || null, n, agora).first()).id;
    return json({ ok: true, id });
  }
  if ((m = r.match(/^fotos\/(\d{1,12})$/)) && metodo === "GET") {
    const f = await env.DB.prepare("SELECT mime, dados FROM plt_tp_fotos WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).first();
    if (!f) return new Response("Não encontrada.", { status: 404 });
    const bin = Uint8Array.from(atob(f.dados), c => c.charCodeAt(0));
    return new Response(bin, { headers: { "content-type": f.mime, "cache-control": "private, max-age=86400" } });
  }
  if ((m = r.match(/^fotos\/(\d{1,12})\/(excluir|editar)$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    if (m[2] === "excluir") await env.DB.prepare("DELETE FROM plt_tp_fotos WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).run();
    else await env.DB.prepare("UPDATE plt_tp_fotos SET legenda=COALESCE(?,legenda), ordem=COALESCE(?,ordem) WHERE id=? AND org_id=?").bind(corpo.legenda !== undefined ? k.txt(corpo.legenda, 140) : null, Number.isFinite(Number(corpo.ordem)) ? Number(corpo.ordem) : null, Number(m[1]), orgId).run();
    return json({ ok: true });
  }

  // Pesquisa de mercado (internet ao vivo): diárias de imóveis parecidos na região e se o anúncio aparece no Google.
  if ((m = r.match(/^imoveis\/(\d{1,12})\/mercado$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const im = await imovel(m[1]); if (!im) return json({ erro: "Imóvel não encontrado." }, 404);
    const envIA = await k.comIA(env, orgId);
    if (!envIA.OPENAI_API_KEY || !k.openai) return json({ erro: "A IA da plataforma ainda não está ligada." }, 503);
    const anuncio = json_(im.anuncio, {});
    const pergunta = `Imóvel de temporada: "${anuncio.titulo || im.nome}" em ${im.cidade || "(cidade não informada)"}${im.endereco ? " — " + im.endereco : ""}. ${im.quartos ? im.quartos + " quarto(s), " : ""}${im.capacidade ? "até " + im.capacidade + " hóspedes" : ""}. Diária atual: ${im.moeda || "BRL"} ${im.preco_base || "?"} (fim de semana ${im.preco_fds || "igual"}).
${corpo.pergunta ? "Pergunta do anfitrião: " + cortar(corpo.pergunta, 500) + "\n" : ""}Pesquise na internet: (1) faixa de diárias de imóveis parecidos na mesma região (Airbnb, Booking e outros), para ${corpo.periodo ? cortar(corpo.periodo, 80) : "as próximas semanas"}; (2) se este anúncio aparece numa busca no Google pelo título ou pelo nome; (3) eventos e alta temporada próximos na cidade; (4) diga se o preço está abaixo, dentro ou acima do mercado e o que ajustar. Seja objetivo, com números, e cite as fontes pelo nome do site. Não invente: se não achar, diga.`;
    try {
      const d = await k.openai(envIA, "responses", { model: String(env.OPENAI_MODEL || "gpt-5-mini"), tools: [{ type: "web_search" }], instructions: "Você é um especialista em revenue management de locação por temporada no Brasil. Responda em português do Brasil, em até 12 frases.", input: [{ role: "user", content: [{ type: "input_text", text: pergunta }] }], max_output_tokens: 1400, store: false }, { timeout: 90000 });
      const texto = (d.output || []).flatMap(o => o.content || []).filter(c => c.type === "output_text").map(c => c.text).join("\n").trim() || d.output_text || "";
      return json({ resultado: texto || "Não encontrei dados confiáveis agora." });
    } catch (e) { return json({ erro: e.message }, 502); }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Organização do imóvel: cômodos, inventário (o que tem em cada cômodo) e checklist de limpeza.
// Página de quem limpa: simples, com ícones, botões grandes, áudio e foto (sem precisar escrever).
// ---------------------------------------------------------------------------
export const MODELOS_COMODO = {
  sala: { nome: "Sala", icone: "🛋️", itens: [["Sofá", "🛋️", 1], ["Almofadas", "🟫", 4], ["TV", "📺", 1], ["Controle remoto", "🎮", 2], ["Mesa de centro", "🪑", 1], ["Tapete", "🟥", 1], ["Cortina", "🪟", 1], ["Luminária", "💡", 1]],
    tarefas: [["Aspirar o sofá e as almofadas", "🛋️"], ["Olhar debaixo do sofá e das almofadas", "🔦"], ["Conferir os controles e as pilhas", "🎮"], ["Tirar o pó dos móveis e da TV", "🧹"], ["Limpar vidros e janelas", "🪟"], ["Varrer e passar pano no chão", "🧽"]] },
  cozinha: { nome: "Cozinha", icone: "🍳", itens: [["Geladeira", "🧊", 1], ["Fogão", "🔥", 1], ["Micro-ondas", "📦", 1], ["Cafeteira", "☕", 1], ["Liquidificador", "🥤", 1], ["Panelas", "🍲", 4], ["Frigideira", "🍳", 1], ["Pratos", "🍽️", 8], ["Copos", "🥛", 8], ["Talheres (jogos)", "🍴", 8], ["Xícaras", "☕", 6], ["Tábua de corte", "🔪", 1], ["Abridor de garrafa", "🍾", 1]],
    tarefas: [["Esvaziar e limpar a geladeira", "🧊"], ["Jogar fora comida esquecida", "🗑️"], ["Lavar e guardar a louça", "🍽️"], ["Limpar fogão e micro-ondas por dentro", "🔥"], ["Limpar dentro dos armários", "🚪"], ["Conferir pratos, copos e talheres", "🍴"], ["Tirar o lixo e colocar saco novo", "🗑️"], ["Limpar pia e bancada", "🚰"]] },
  quarto: { nome: "Quarto", icone: "🛏️", itens: [["Cama", "🛏️", 1], ["Travesseiros", "🛌", 2], ["Edredom/cobertor", "🟦", 1], ["Abajur", "💡", 1], ["Cabides", "🧥", 10], ["Controle do ar-condicionado", "❄️", 1], ["Cortina/blackout", "🪟", 1]],
    tarefas: [["Trocar roupa de cama e fronhas", "🛏️"], ["Olhar debaixo da cama", "🔦"], ["Olhar dentro do guarda-roupa e gavetas", "🚪"], ["Conferir os cabides", "🧥"], ["Testar o ar-condicionado e o controle", "❄️"], ["Tirar o pó e varrer", "🧹"]] },
  banheiro: { nome: "Banheiro", icone: "🚿", itens: [["Toalhas de banho", "🛁", 2], ["Toalhas de rosto", "🧻", 2], ["Tapete de banheiro", "🟩", 1], ["Secador de cabelo", "💨", 1], ["Lixeira", "🗑️", 1], ["Espelho", "🪞", 1]],
    tarefas: [["Dar descarga e conferir se não vaza", "🚽"], ["Lavar vaso, pia e box", "🧽"], ["Conferir o chuveiro (água quente)", "🚿"], ["Limpar o espelho", "🪞"], ["Repor papel higiênico e sabonete", "🧻"], ["Trocar toalhas e tapete", "🛁"], ["Tirar o lixo", "🗑️"], ["Tirar cabelos do ralo", "🌀"]] },
  varanda: { nome: "Varanda", icone: "🌅", itens: [["Cadeiras", "🪑", 2], ["Mesa", "🟫", 1], ["Rede", "🏖️", 1], ["Churrasqueira", "🍖", 1]],
    tarefas: [["Varrer e passar pano", "🧹"], ["Limpar a mesa e as cadeiras", "🪑"], ["Conferir a churrasqueira", "🍖"], ["Recolher lixo e bitucas", "🗑️"]] },
  servico: { nome: "Área de serviço", icone: "🧺", itens: [["Máquina de lavar", "🫧", 1], ["Ferro de passar", "♨️", 1], ["Tábua de passar", "🟫", 1], ["Vassoura", "🧹", 1], ["Rodo", "🧽", 1], ["Balde", "🪣", 1], ["Varal", "🧺", 1]],
    tarefas: [["Lavar a roupa de cama e as toalhas", "🫧"], ["Limpar o filtro da máquina", "🧽"], ["Guardar os produtos de limpeza", "🧴"]] },
  entrada: { nome: "Entrada", icone: "🚪", itens: [["Chaves", "🔑", 2], ["Controle do portão", "📟", 1], ["Tapete de entrada", "🟫", 1]],
    tarefas: [["Conferir as chaves e o controle do portão", "🔑"], ["Testar a fechadura (e a senha, se tiver)", "🔐"], ["Fechar janelas e desligar luzes e ar ao sair", "💡"]] }
};
const ESTADOS_INV = ["OK", "QUEBRADO", "SUMIU"];

async function organizacaoDe(env, orgId, imovelId) {
  const [c, i, t] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM plt_tp_comodos WHERE org_id=? AND imovel_id=? ORDER BY ordem, id").bind(orgId, imovelId),
    env.DB.prepare("SELECT * FROM plt_tp_inventario WHERE org_id=? AND imovel_id=? ORDER BY comodo_id, id").bind(orgId, imovelId),
    env.DB.prepare("SELECT * FROM plt_tp_checklist WHERE org_id=? AND imovel_id=? ORDER BY comodo_id, ordem, id").bind(orgId, imovelId)
  ]);
  const comodos = (c?.results || []).map(x => ({ ...x, icone: (MODELOS_COMODO[x.tipo] || {}).icone || "🏠", itens: (i?.results || []).filter(y => y.comodo_id === x.id), tarefas: (t?.results || []).filter(y => y.comodo_id === x.id) }));
  return { comodos, gerais: (t?.results || []).filter(y => !y.comodo_id) };
}
async function criarComodo(env, orgId, imovelId, tipo, nome, comModelo = true, ordem = 0) {
  const mod = MODELOS_COMODO[tipo] || { nome: "Cômodo", itens: [], tarefas: [] };
  const id = (await env.DB.prepare("INSERT INTO plt_tp_comodos(org_id,imovel_id,nome,tipo,ordem) VALUES(?,?,?,?,?) RETURNING id").bind(orgId, imovelId, cortar(nome || mod.nome, 60), MODELOS_COMODO[tipo] ? tipo : "outro", ordem).first()).id;
  if (comModelo) await env.DB.batch([
    ...mod.itens.map(([item, icone, q]) => env.DB.prepare("INSERT INTO plt_tp_inventario(org_id,imovel_id,comodo_id,item,icone,quantidade,estado) VALUES(?,?,?,?,?,?,'OK')").bind(orgId, imovelId, id, item, icone, q)),
    ...mod.tarefas.map(([tarefa, icone], n) => env.DB.prepare("INSERT INTO plt_tp_checklist(org_id,imovel_id,comodo_id,tarefa,icone,ordem) VALUES(?,?,?,?,?,?)").bind(orgId, imovelId, id, tarefa, icone, n))
  ].filter(Boolean));
  return id;
}

// O que levar e o que conferir na limpeza: estoque no mínimo, o que faltou ou quebrou da última vez,
// pendências abertas do imóvel e quando chega o próximo hóspede.
export async function briefingLimpeza(env, l, agoraMs) {
  const [baixos, quebrados, ultima, pend, prox] = await env.DB.batch([
    env.DB.prepare("SELECT item, quantidade, minimo, unidade FROM plt_tp_estoque WHERE imovel_id=? AND minimo > 0 AND quantidade <= minimo ORDER BY item").bind(l.imovel_id),
    env.DB.prepare("SELECT i.item, i.icone, i.estado, c.nome comodo FROM plt_tp_inventario i JOIN plt_tp_comodos c ON c.id=i.comodo_id WHERE i.imovel_id=? AND i.estado<>'OK' ORDER BY c.ordem").bind(l.imovel_id),
    env.DB.prepare("SELECT id, data, responsavel, resumo FROM plt_tp_limpezas WHERE imovel_id=? AND id<>? AND fim_ms IS NOT NULL ORDER BY fim_ms DESC LIMIT 1").bind(l.imovel_id, l.id),
    env.DB.prepare("SELECT texto, prioridade FROM plt_tp_notas WHERE imovel_id=? AND status<>'FEITA' ORDER BY CASE prioridade WHEN 'ALTA' THEN 0 WHEN 'MEDIA' THEN 1 ELSE 2 END, id DESC LIMIT 6").bind(l.imovel_id),
    env.DB.prepare("SELECT inicio, hospede, hospedes FROM plt_tp_reservas WHERE imovel_id=? AND status='CONFIRMADA' AND tipo='RESERVA' AND inicio >= ? ORDER BY inicio LIMIT 1").bind(l.imovel_id, l.data)
  ]);
  const levar = (baixos?.results || []).map(b => ({ item: b.item, tem: b.quantidade, levar: Math.max(1, Math.ceil(Number(b.minimo) * 2 - Number(b.quantidade))), unidade: b.unidade || "" }));
  const ult = ultima?.results?.[0];
  const faltouUltima = ult ? (json_(ult.resumo, {}).faltou || []) : [];
  const p = prox?.results?.[0] || null;
  return { levar, quebrados: quebrados?.results || [], faltou_ultima: faltouUltima, ultima: ult ? { data: ult.data, responsavel: ult.responsavel } : null, pendencias: pend?.results || [],
    proximo: p ? { ...p, mesmo_dia: p.inicio === l.data, dias: noites(l.data, p.inicio) } : null, hoje: iso(agoraMs - 3 * 3600000) };
}
const textoBriefing = b => [
  b.proximo ? (b.proximo.mesmo_dia ? `⚠️ Hóspede novo chega HOJE (${b.proximo.hospede || "hóspede"}${b.proximo.hospedes ? ", " + b.proximo.hospedes + " pessoas" : ""}).` : `Próximo hóspede: ${b.proximo.inicio.split("-").reverse().join("/")}.`) : "",
  b.levar.length ? "Levar: " + b.levar.map(x => `${x.item} (${x.levar} ${x.unidade})`).join(", ") + "." : "",
  b.faltou_ultima.length ? "Faltou da última vez: " + b.faltou_ultima.join(", ") + "." : "",
  b.quebrados.length ? "Quebrado ou sumido: " + b.quebrados.map(x => `${x.item} (${x.comodo})`).join(", ") + "." : "",
  b.pendencias.length ? "Pendências: " + b.pendencias.map(x => x.texto).join("; ") + "." : ""
].filter(Boolean).join("\n");

// Página de quem limpa: /tp/limpeza/<id>-<token> (a tela), /dados (o que conferir) e /comecar, /enviar.
export async function limpezaPublica(request, env, k) {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/tp\/limpeza\/(\d{1,12})-([A-Za-z0-9]{32})(\/dados|\/comecar|\/enviar)?$/);
  if (!m) return null;
  const id = Number(m[1]);
  if (m[2] !== await tokenLimpeza(env, k, id)) return new Response("Link inválido.", { status: 404 });
  const l = await env.DB.prepare("SELECT l.*, i.nome, i.org_id, i.checkin, i.checkout FROM plt_tp_limpezas l JOIN plt_tp_imoveis i ON i.id=l.imovel_id WHERE l.id=?").bind(id).first();
  if (!l) return new Response("Link inválido.", { status: 404 });
  const agora = k.agora(env);
  const js = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  if (!m[3] && request.method === "GET") {
    const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    return new Response(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex"><meta name="theme-color" content="#070b16"><title>Limpeza — ${esc(l.nome)}</title><link rel="stylesheet" href="/assets/css/limpeza.css"></head><body class="limpeza-pub"><main id="app" data-base="${esc(url.pathname)}"><p class="carregando">Carregando…</p></main><script src="/assets/js/limpeza.js" defer></script></body></html>`, { headers: { "content-type": "text/html; charset=UTF-8", "cache-control": "no-store" } });
  }
  if (m[3] === "/dados" && request.method === "GET") {
    const [org, est, cfg] = await Promise.all([organizacaoDe(env, l.org_id, l.imovel_id), env.DB.prepare("SELECT id, item, categoria, quantidade, minimo, unidade FROM plt_tp_estoque WHERE imovel_id=? ORDER BY categoria, item").bind(l.imovel_id).all(),
      env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind("tp_config_" + l.org_id).first()]);
    const equipe = (json_(cfg?.valor, {}).equipe || []).map(x => x.nome).filter(Boolean);
    return js({ imovel: l.nome, data: l.data, responsavel: l.responsavel || "", status: l.status, iniciada: Boolean(l.inicio_ms), concluida: Boolean(l.fim_ms), equipe, briefing: await briefingLimpeza(env, l, agora),
      comodos: org.comodos.map(c => ({ id: c.id, nome: c.nome, icone: c.icone, tarefas: c.tarefas.map(t => ({ id: t.id, tarefa: t.tarefa, icone: t.icone || "✔️" })), itens: c.itens.map(i => ({ id: i.id, item: i.item, icone: i.icone || "📦", quantidade: i.quantidade, estado: i.estado })) })),
      gerais: org.gerais.map(t => ({ id: t.id, tarefa: t.tarefa, icone: t.icone || "✔️" })), estoque: (est?.results || []) });
  }
  if (request.method !== "POST") return new Response("Método não permitido.", { status: 405 });
  const bruto = await request.text();
  if (bruto.length > 6_000_000) return js({ erro: "Envio grande demais. Mande menos fotos." }, 413);
  let c; try { c = JSON.parse(bruto || "{}"); } catch { return js({ erro: "Pedido inválido." }, 400); }
  const quem = cortar(c.quem, 60) || l.responsavel || "Limpeza";
  if (m[3] === "/comecar") {
    await env.DB.prepare("UPDATE plt_tp_limpezas SET inicio_ms=COALESCE(inicio_ms,?), responsavel=? WHERE id=?").bind(agora, quem, id).run();
    return js({ ok: true });
  }
  // /enviar: tudo de uma vez no fim (checklist, inventário, estoque, áudio e fotos).
  const org = await organizacaoDe(env, l.org_id, l.imovel_id);
  const tarefas = [...org.comodos.flatMap(x => x.tarefas), ...org.gerais];
  const feitas = tarefas.filter(t => c.checklist && c.checklist[t.id]).map(t => t.id);
  const itensInv = org.comodos.flatMap(x => x.itens.map(i => ({ ...i, comodo: x.nome })));
  const problemas = [];
  const st = [];
  for (const it of itensInv) {
    const novo = ESTADOS_INV.includes(c.inventario?.[it.id]) ? c.inventario[it.id] : null;
    if (!novo || novo === it.estado) continue;
    st.push(env.DB.prepare("UPDATE plt_tp_inventario SET estado=?, atualizado_ms=?, atualizado_por=? WHERE id=?").bind(novo, agora, quem, it.id));
    if (novo !== "OK") problemas.push(`${it.item} (${it.comodo}): ${novo === "SUMIU" ? "sumiu" : "quebrado"}`);
  }
  for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
  const estoqueItens = Object.entries(c.estoque || {}).map(([sid, q]) => ({ id: Number(sid), quantidade: Number(q) })).filter(x => Number.isFinite(x.quantidade));
  const r = await gravarEstoque(env, l.org_id, l.imovel_id, estoqueItens, { origem: "CHECKOUT", autor: quem, limpezaId: id, agora });
  const faltou = [...(Array.isArray(c.faltou) ? c.faltou.map(x => cortar(x, 60)).filter(Boolean) : []), ...r.baixos.filter(b => Number(b.quantidade) <= 0).map(b => b.item)];
  // Mídias: fotos (problemas) e áudio (o que a pessoa quis dizer), guardados na limpeza.
  let transcricao = "";
  const fotos = (Array.isArray(c.fotos) ? c.fotos : []).slice(0, 6);
  for (const f of fotos) { const d = String(f || "").match(/^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/); if (d && d[3].length < 1_400_000) await env.DB.prepare("INSERT INTO plt_tp_fotos(org_id,imovel_id,mime,dados,legenda,ordem,criado_ms,limpeza_id) VALUES(?,?,?,?,?,0,?,?)").bind(l.org_id, l.imovel_id, d[1], d[3], `Limpeza ${l.data} — ${quem}`, agora, id).run(); }
  const au = String(c.audio || "").match(/^data:(audio\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=]+)$/i);
  if (au && au[2].length < 2_800_000) {
    try {
      const envIA = k.comIA ? await k.comIA(env, l.org_id) : env;
      if (envIA.OPENAI_API_KEY) {
        const bin = Uint8Array.from(atob(au[2]), ch => ch.charCodeAt(0));
        const f = new FormData();
        f.append("file", new Blob([bin], { type: au[1] }), "recado." + (/mp4|m4a|aac/.test(au[1]) ? "mp4" : /ogg/.test(au[1]) ? "ogg" : "webm"));
        f.append("model", String(env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe")); f.append("language", "pt");
        transcricao = cortar((await openaiBruto(envIA, "audio/transcriptions", f, { timeout: 45000 }))?.text, 2000);
      }
    } catch (e) { console.warn("transcrição limpeza", e?.message); }
    await env.DB.prepare("INSERT INTO plt_tp_fotos(org_id,imovel_id,mime,dados,legenda,ordem,criado_ms,limpeza_id,transcricao) VALUES(?,?,?,?,?,0,?,?,?)").bind(l.org_id, l.imovel_id, au[1].toLowerCase(), au[2], `Recado de ${quem}`, agora, id, transcricao || null).run();
  }
  const obs = [cortar(c.obs, 1500), transcricao ? `Recado (áudio): ${transcricao}` : "", ...problemas].filter(Boolean).join("\n");
  const resumo = { checklist_feitas: feitas.length, checklist_total: tarefas.length, nao_feitas: tarefas.filter(t => !feitas.includes(t.id)).map(t => t.tarefa), problemas, faltou, usados: r.usados || [], fotos: fotos.length, audio: Boolean(au), transcricao };
  await env.DB.prepare("UPDATE plt_tp_limpezas SET status='FEITA', responsavel=?, inicio_ms=COALESCE(inicio_ms,?), fim_ms=?, estoque_ok_ms=?, resumo=?, obs=COALESCE(NULLIF(?,''),obs) WHERE id=?").bind(quem, agora, agora, agora, JSON.stringify(resumo), obs, id).run();
  if (problemas.length || cortar(c.obs, 1500) || transcricao) await env.DB.prepare("INSERT INTO plt_tp_notas(org_id,imovel_id,texto,categoria,prioridade,status,autor,criado_ms) VALUES(?,?,?,'Limpeza',?,'ABERTA',?,?)").bind(l.org_id, l.imovel_id, obs, problemas.length ? "ALTA" : "MEDIA", quem, agora).run();
  if ((r.baixos.length || problemas.length || obs) && k.alertarEmail) await k.alertarEmail(l.org_id, `DENIA — limpeza de ${l.nome} concluída${problemas.length ? " (com problemas)" : ""}`,
    `${quem} terminou a limpeza de ${l.nome}. Checklist: ${feitas.length} de ${tarefas.length}.${r.baixos.length ? "\n\nComprar: " + r.baixos.map(b => `${b.item} (${b.quantidade} ${b.unidade || ""})`).join(", ") + "." : ""}${problemas.length ? "\n\nProblemas: " + problemas.join("; ") + "." : ""}${obs && !problemas.length ? "\n\n" + obs : ""}`).catch(() => { });
  return js({ ok: true, baixos: r.baixos, problemas, faltou });
}

// ----- Avaliações dos hóspedes (Airbnb, Booking, Vrbo): 5 estrelas a DENIA responde sozinha; abaixo disso ela
// estuda o caso (reserva, mensagens, limpeza, regras) e diz se há argumento para pedir a remoção, com o texto pronto.
const INSTRUCOES_AVALIACAO_TP = `Você é especialista sênior em locação por temporada (superanfitrião no Airbnb, parceiro preferencial no Booking.com e Vrbo) e em gestão de reputação. Analise UMA avaliação de hóspede com todo o contexto (reserva, mensagens, limpeza, regras da casa e treinamento do imóvel).
Responda em JSON:
{"sentimento":"OTIMA|POSITIVA|NEUTRA|NEGATIVA|GRAVE","resumo":"o que o hóspede disse, em 1-2 frases, no idioma do anfitrião",
"traducao":"a avaliação traduzida para o idioma do anfitrião",
"resposta":"resposta pública, no idioma em que o hóspede escreveu: agradecida, profissional, curta, sem discutir, sem expor dados do hóspede, mostrando o que foi corrigido quando houver crítica",
"resposta_traducao":"a mesma resposta no idioma do anfitrião",
"remocao":{"chance":"ALTA|MEDIA|BAIXA|NENHUMA","argumentos":["fatos concretos do contexto que sustentam o pedido"],"regra":"qual regra da plataforma a avaliação pode violar","texto_pedido":"mensagem pronta, educada e objetiva, para o anfitrião enviar ao suporte pedindo a remoção, citando a regra e os fatos","passos":["onde clicar/como pedir na plataforma"]},
"pontos_de_melhoria":["o que o anfitrião pode melhorar no imóvel/processo, se a crítica for justa"],"precisa_anfitriao":true}
REGRAS DE REMOÇÃO (resuma com honestidade; as plataformas decidem):
- Airbnb (Política de Avaliações): pode remover avaliação que seja retaliação ou coerção (ameaça de avaliação ruim para conseguir algo), irrelevante (não fala da estadia), com conteúdo discriminatório, ofensivo, com dados pessoais, de quem não se hospedou, ou de hóspede que violou regras graves (festa não autorizada, fumo, mais pessoas que o permitido, removido da reserva). Crítica honesta, mesmo dura, normalmente NÃO é removida.
- Booking.com: remove comentários que violam as diretrizes (linguagem ofensiva, dados pessoais, conteúdo irrelevante, discriminação, ameaças, fraude); o anfitrião pode contestar pelo Extranet → Avaliações → Reportar.
- Vrbo: pode remover avaliações com conteúdo impróprio, de quem não se hospedou ou que violam as políticas; o anfitrião pede pelo suporte.
- Nunca invente fatos. Se não houver argumento, diga "NENHUMA" e foque em uma boa resposta pública e no que melhorar.`;
const notaEm5 = (nota, max) => { const n = Number(nota), mx = Number(max) || 5; return Number.isFinite(n) ? Math.round((n / mx) * 50) / 10 : null; };
async function analisarAvaliacaoTp(env, k, orgId, av) {
  const envIA = await k.comIA(env, orgId);
  if (!envIA.OPENAI_API_KEY) throw new Error("A IA da plataforma ainda não está ligada.");
  const im = av.imovel_id ? await env.DB.prepare("SELECT * FROM plt_tp_imoveis WHERE id=?").bind(av.imovel_id).first() : null;
  const res = av.reserva_id ? await env.DB.prepare("SELECT * FROM plt_tp_reservas WHERE id=?").bind(av.reserva_id).first() : null;
  const msgs = res ? (((await env.DB.prepare("SELECT direcao, texto FROM plt_tp_msgs WHERE reserva_id=? ORDER BY id DESC LIMIT 30").bind(res.id).all())?.results) || []).reverse() : [];
  const limp = res ? await env.DB.prepare("SELECT data, responsavel, resumo, obs FROM plt_tp_limpezas WHERE reserva_id=? OR (imovel_id=? AND data<=? AND fim_ms IS NOT NULL) ORDER BY data DESC LIMIT 1").bind(res.id, res.imovel_id, res.inicio).first() : null;
  const cfg = json_((await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind("tp_config_" + orgId).first().catch(() => null))?.valor, {});
  const entrada = `IDIOMA DO ANFITRIÃO: ${cfg.idioma || "português do Brasil"}
PLATAFORMA: ${CANAIS[av.canal] || av.canal || "?"} · NOTA: ${av.nota}/${av.nota_max || 5} (${notaEm5(av.nota, av.nota_max)} de 5)
IMÓVEL: ${im ? `${im.nome}${im.cidade ? " — " + im.cidade : ""}\n${textoTreino(im)}` : "(não identificado)"}
${res ? `RESERVA: ${res.hospede || "hóspede"} · ${res.inicio} a ${res.fim} · ${res.hospedes || "?"} pessoas` : "RESERVA: não identificada"}
${msgs.length ? "MENSAGENS DA ESTADIA:\n" + msgs.map(x => `${x.direcao === "E" ? "HÓSPEDE" : "ANFITRIÃO"}: ${cortar(x.texto, 400)}`).join("\n") : ""}
${limp ? `LIMPEZA ANTES DA ESTADIA: ${limp.data} por ${limp.responsavel || "?"}; ${(() => { const r = json_(limp.resumo, {}); return r.checklist_total ? `checklist ${r.checklist_feitas}/${r.checklist_total}` : ""; })()} ${cortar(limp.obs, 300)}` : ""}
AVALIAÇÃO DE ${av.autor || "hóspede"}:\n"${cortar(av.texto, 4000)}"`;
  return openaiResposta(envIA, { modelo: cfg.modelo || "gpt-5-mini", esforco: "low", maxTokens: 1800, instrucoes: INSTRUCOES_AVALIACAO_TP, entrada, recurso: "temporada/avaliacoes" });
}
async function publicarRespostaAvaliacao(env, av, texto) {
  if (!(channexLigado(env) && /^cx:/.test(av.externo_id || ""))) return false;
  await cx(env, "POST", `/reviews/${av.externo_id.slice(3)}/reply`, { reply: { reply: cortar(texto, 2000) } });
  return true;
}
// Analisa as pendentes; as de 5 estrelas (no automático) já saem respondidas.
export async function cuidarAvaliacoesTp(env, k, orgId, limite = 5) {
  const cfg = json_((await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind("tp_config_" + orgId).first().catch(() => null))?.valor, {});
  const auto = cfg.avaliacoes_auto !== "DESLIGADO";
  const l = (((await env.DB.prepare("SELECT * FROM plt_tp_avaliacoes WHERE org_id=? AND status='PENDENTE' ORDER BY id LIMIT ?").bind(orgId, limite).all())?.results) || []);
  let respondidas = 0, chamar = 0;
  for (const av of l) {
    let a;
    try { a = await analisarAvaliacaoTp(env, k, orgId, av); } catch (e) { console.warn("avaliação tp", e?.message); break; }
    const cinco = notaEm5(av.nota, av.nota_max) >= 5 && ["OTIMA", "POSITIVA"].includes(a.sentimento);
    let status = cinco ? "RASCUNHO" : "PRECISA_VOCE", resp = null;
    if (cinco && auto && a.resposta) {
      try { if (await publicarRespostaAvaliacao(env, av, a.resposta)) { status = "RESPONDIDA"; resp = a.resposta; respondidas++; } } catch (e) { console.warn("resposta avaliação", e?.message); }
    }
    await env.DB.prepare("UPDATE plt_tp_avaliacoes SET analise=?, resposta_sugerida=?, resposta=COALESCE(?,resposta), status=?, respondida_ms=CASE WHEN ?='RESPONDIDA' THEN ? ELSE respondida_ms END WHERE id=?").bind(JSON.stringify(a), cortar(a.resposta, 2000), resp, status, status, k.agora(env), av.id).run();
    if (status === "PRECISA_VOCE") {
      chamar++;
      if (k.alertarEmail) await k.alertarEmail(orgId, `DENIA — avaliação ${notaEm5(av.nota, av.nota_max)}★ de ${av.autor || "hóspede"} precisa de você`, `${CANAIS[av.canal] || av.canal}: "${cortar(av.texto, 600)}"\n\nChance de remoção: ${a.remocao?.chance || "—"}.${(a.remocao?.argumentos || []).length ? "\nArgumentos: " + a.remocao.argumentos.join("; ") : ""}\n\nA resposta sugerida e o texto para pedir a remoção estão em Locação por temporada → Avaliações.`).catch(() => { });
    }
  }
  return { analisadas: l.length, respondidas, chamar };
}
async function sincronizarAvaliacoesTp(env, k) {
  if (!channexLigado(env)) return 0;
  const ims = (((await env.DB.prepare("SELECT id, org_id, channex_property FROM plt_tp_imoveis WHERE ativo=1 AND channex_property IS NOT NULL LIMIT 100").all().catch(() => null))?.results) || []);
  let n = 0;
  for (const im of ims) {
    const d = await cx(env, "GET", `/reviews?filter[property_id]=${encodeURIComponent(im.channex_property)}&pagination[limit]=50`).catch(() => null);
    for (const rv of d?.data || []) {
      const a = rv.attributes || {};
      const res = a.booking_id ? await env.DB.prepare("SELECT id FROM plt_tp_reservas WHERE org_id=? AND externo_id=?").bind(im.org_id, "cx:" + a.booking_id).first() : null;
      const ota = String(a.ota || a.ota_name || "");
      const canal = /airbnb/i.test(ota) ? "airbnb" : /booking/i.test(ota) ? "booking" : /vrbo|expedia|homeaway/i.test(ota) ? "vrbo" : "outro";
      const max = canal === "booking" ? 10 : 5;
      const ins = await env.DB.prepare("INSERT OR IGNORE INTO plt_tp_avaliacoes(org_id,imovel_id,reserva_id,canal,externo_id,autor,nota,nota_max,texto,data,status,criado_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(im.org_id, im.id, res?.id || null, canal, "cx:" + rv.id, cortar(a.guest_name || a.reviewer_name || "Hóspede", 80), Number(a.overall_score ?? a.score ?? 0) || null, max, cortar([a.content, a.public_review, a.positive, a.negative].filter(Boolean).join("\n"), 6000), String(a.received_at || a.inserted_at || "").slice(0, 10) || null, a.reply ? "RESPONDIDA" : "PENDENTE", k.agora(env)).run();
      if (Number(ins?.meta?.changes)) n++;
    }
  }
  return n;
}
export async function avaliacoesDoCron(env, k) {
  const ult = Number((await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave='tp_aval_ms'").first().catch(() => null))?.valor || 0);
  if (k.agora(env) - ult < 55 * 60000) return;
  await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES('tp_aval_ms',?)").bind(String(k.agora(env))).run();
  await sincronizarAvaliacoesTp(env, k).catch(e => console.warn("sync avaliações", e?.message));
  const orgs = (((await env.DB.prepare("SELECT DISTINCT org_id FROM plt_tp_avaliacoes WHERE status='PENDENTE' LIMIT 20").all().catch(() => null))?.results) || []);
  for (const o of orgs) await cuidarAvaliacoesTp(env, k, o.org_id).catch(e => console.warn("avaliações", e?.message));
}

export async function rotasOrganizacao(request, env, k, orgId, r, { json, ler, precisa, imovel, agora, q }) {
  const metodo = request.method;
  const autor = k.sessao?.usuario?.nome || k.sessao?.usuario?.email || "Equipe";
  let m;
  if (r === "modelos-comodo" && metodo === "GET") return json({ modelos: Object.entries(MODELOS_COMODO).map(([tipo, x]) => ({ tipo, nome: x.nome, icone: x.icone, itens: x.itens.length, tarefas: x.tarefas.length })) });
  if ((m = r.match(/^imoveis\/(\d{1,12})\/organizacao$/)) && metodo === "GET") {
    const im = await imovel(m[1]); if (!im) return json({ erro: "Imóvel não encontrado." }, 404);
    return json({ ...(await organizacaoDe(env, orgId, im.id)), modelos: Object.entries(MODELOS_COMODO).map(([tipo, x]) => ({ tipo, nome: x.nome, icone: x.icone })) });
  }
  // Montar em segundos: "1 sala, 2 quartos, 2 banheiros, cozinha…" → cômodos com os itens e o checklist de cada um.
  if ((m = r.match(/^imoveis\/(\d{1,12})\/organizacao\/modelo$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const im = await imovel(m[1]); if (!im) return json({ erro: "Imóvel não encontrado." }, 404);
    const qtd = corpo.quantidades || {};
    let ordem = Number((await env.DB.prepare("SELECT COALESCE(MAX(ordem),0) n FROM plt_tp_comodos WHERE imovel_id=?").bind(im.id).first())?.n || 0), n = 0;
    for (const tipo of Object.keys(MODELOS_COMODO)) {
      const k2 = Math.max(0, Math.min(10, Number(qtd[tipo]) || 0));
      for (let i = 1; i <= k2; i++) { await criarComodo(env, orgId, im.id, tipo, k2 > 1 ? `${MODELOS_COMODO[tipo].nome} ${i}` : MODELOS_COMODO[tipo].nome, true, ++ordem); n++; }
    }
    return json({ ok: true, comodos: n });
  }
  if ((m = r.match(/^imoveis\/(\d{1,12})\/comodos$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const im = await imovel(m[1]); if (!im) return json({ erro: "Imóvel não encontrado." }, 404);
    const ordem = Number((await env.DB.prepare("SELECT COALESCE(MAX(ordem),0) n FROM plt_tp_comodos WHERE imovel_id=?").bind(im.id).first())?.n || 0) + 1;
    return json({ ok: true, id: await criarComodo(env, orgId, im.id, String(corpo.tipo || "outro"), k.txt(corpo.nome, 60), corpo.modelo !== false, ordem) });
  }
  if ((m = r.match(/^comodos\/(\d{1,12})(\/excluir)?$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const id = Number(m[1]);
    if (m[2]) { await env.DB.batch([env.DB.prepare("DELETE FROM plt_tp_inventario WHERE comodo_id=? AND org_id=?").bind(id, orgId), env.DB.prepare("DELETE FROM plt_tp_checklist WHERE comodo_id=? AND org_id=?").bind(id, orgId), env.DB.prepare("DELETE FROM plt_tp_comodos WHERE id=? AND org_id=?").bind(id, orgId)]); return json({ ok: true }); }
    await env.DB.prepare("UPDATE plt_tp_comodos SET nome=COALESCE(NULLIF(?,''),nome), ordem=COALESCE(?,ordem) WHERE id=? AND org_id=?").bind(k.txt(corpo.nome, 60), Number.isFinite(Number(corpo.ordem)) ? Number(corpo.ordem) : null, id, orgId).run();
    return json({ ok: true });
  }
  if ((r === "inventario" || (m = r.match(/^inventario\/(\d{1,12})$/))) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const estado = ESTADOS_INV.includes(corpo.estado) ? corpo.estado : null;
    if (m) {
      await env.DB.prepare("UPDATE plt_tp_inventario SET item=COALESCE(NULLIF(?,''),item), quantidade=COALESCE(?,quantidade), estado=COALESCE(?,estado), valor=COALESCE(?,valor), obs=COALESCE(?,obs), icone=COALESCE(NULLIF(?,''),icone), atualizado_ms=?, atualizado_por=? WHERE id=? AND org_id=?")
        .bind(k.txt(corpo.item, 80), corpo.quantidade !== undefined && corpo.quantidade !== "" ? Math.max(0, Math.round(Number(corpo.quantidade) || 0)) : null, estado, corpo.valor !== undefined && corpo.valor !== "" ? Number(corpo.valor) || 0 : null, corpo.obs !== undefined ? k.txt(corpo.obs, 300) : null, k.txt(corpo.icone, 8), agora, autor, Number(m[1]), orgId).run();
      return json({ ok: true });
    }
    const c = await env.DB.prepare("SELECT imovel_id FROM plt_tp_comodos WHERE id=? AND org_id=?").bind(Number(corpo.comodo_id), orgId).first();
    if (!c) return json({ erro: "Escolha o cômodo." }, 400);
    const item = k.txt(corpo.item, 80); if (!item) return json({ erro: "Escreva o item." }, 400);
    const id = (await env.DB.prepare("INSERT INTO plt_tp_inventario(org_id,imovel_id,comodo_id,item,icone,quantidade,estado,valor,obs,atualizado_ms,atualizado_por) VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING id")
      .bind(orgId, c.imovel_id, Number(corpo.comodo_id), item, k.txt(corpo.icone, 8) || "📦", Math.max(0, Math.round(Number(corpo.quantidade) || 1)), estado || "OK", Number(corpo.valor) || null, k.txt(corpo.obs, 300) || null, agora, autor).first()).id;
    return json({ ok: true, id });
  }
  if ((m = r.match(/^inventario\/(\d{1,12})\/excluir$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    await env.DB.prepare("DELETE FROM plt_tp_inventario WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).run();
    return json({ ok: true });
  }
  if ((r === "checklist" || (m = r.match(/^checklist\/(\d{1,12})$/))) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    if (m) { await env.DB.prepare("UPDATE plt_tp_checklist SET tarefa=COALESCE(NULLIF(?,''),tarefa), icone=COALESCE(NULLIF(?,''),icone) WHERE id=? AND org_id=?").bind(k.txt(corpo.tarefa, 120), k.txt(corpo.icone, 8), Number(m[1]), orgId).run(); return json({ ok: true }); }
    const im = await imovel(corpo.imovel_id); if (!im) return json({ erro: "Escolha o imóvel." }, 400);
    const tarefa = k.txt(corpo.tarefa, 120); if (!tarefa) return json({ erro: "Escreva a tarefa." }, 400);
    const com = corpo.comodo_id ? await env.DB.prepare("SELECT id FROM plt_tp_comodos WHERE id=? AND imovel_id=?").bind(Number(corpo.comodo_id), im.id).first() : null;
    const id = (await env.DB.prepare("INSERT INTO plt_tp_checklist(org_id,imovel_id,comodo_id,tarefa,icone,ordem) VALUES(?,?,?,?,?,99) RETURNING id").bind(orgId, im.id, com?.id || null, tarefa, k.txt(corpo.icone, 8) || "✔️").first()).id;
    return json({ ok: true, id });
  }
  if ((m = r.match(/^checklist\/(\d{1,12})\/excluir$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    await env.DB.prepare("DELETE FROM plt_tp_checklist WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).run();
    return json({ ok: true });
  }
  // Equipe de limpeza (os nomes aparecem como botões na tela de quem limpa).
  if (r === "equipe" && metodo === "GET") return json({ equipe: json_((await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind("tp_config_" + orgId).first())?.valor, {}).equipe || [] });
  if (r === "equipe" && metodo === "POST") {
    const negado = precisa("ADMIN"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const cfg = json_((await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind("tp_config_" + orgId).first())?.valor, {});
    cfg.equipe = (Array.isArray(corpo.equipe) ? corpo.equipe : []).slice(0, 30).map(x => ({ nome: k.txt(x.nome, 60), telefone: k.txt(x.telefone, 30) })).filter(x => x.nome);
    await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind("tp_config_" + orgId, JSON.stringify(cfg)).run();
    return json({ ok: true, equipe: cfg.equipe });
  }
  // Uma limpeza: registro completo (quem, quando, quanto tempo, checklist, o que usou, o que faltou, fotos e áudio) e o briefing.
  if ((m = r.match(/^limpezas\/(\d{1,12})\/detalhe$/)) && metodo === "GET") {
    const l = await env.DB.prepare("SELECT l.*, i.nome imovel FROM plt_tp_limpezas l JOIN plt_tp_imoveis i ON i.id=l.imovel_id WHERE l.id=? AND l.org_id=?").bind(Number(m[1]), orgId).first();
    if (!l) return json({ erro: "Limpeza não encontrada." }, 404);
    const [mov, midias] = await env.DB.batch([
      env.DB.prepare("SELECT m.antes, m.depois, e.item, e.unidade FROM plt_tp_estoque_mov m JOIN plt_tp_estoque e ON e.id=m.item_id WHERE m.limpeza_id=?").bind(l.id),
      env.DB.prepare("SELECT id, mime, legenda, transcricao FROM plt_tp_fotos WHERE limpeza_id=? AND org_id=?").bind(l.id, orgId)
    ]);
    return json({ limpeza: { ...l, resumo: json_(l.resumo, null) }, usados: (mov?.results || []).map(x => ({ item: x.item, unidade: x.unidade, antes: x.antes, depois: x.depois, usou: Math.max(0, Number(x.antes) - Number(x.depois)), repos: Math.max(0, Number(x.depois) - Number(x.antes)) })),
      midias: midias?.results || [], briefing: await briefingLimpeza(env, l, agora), link: await linksLimpeza(env, k, new URL(request.url).origin, l.id) });
  }
  if (r === "limpezas/agenda" && metodo === "GET") {
    const l = (((await env.DB.prepare("SELECT l.*, i.nome imovel FROM plt_tp_limpezas l JOIN plt_tp_imoveis i ON i.id=l.imovel_id WHERE l.org_id=? AND l.status<>'CANCELADA' AND l.fim_ms IS NULL AND l.data BETWEEN ? AND ? ORDER BY l.data LIMIT 20").bind(orgId, iso(agora - 3 * DIA), iso(agora + 2 * DIA)).all())?.results) || []);
    const out = [];
    for (const x of l) out.push({ id: x.id, imovel: x.imovel, data: x.data, responsavel: x.responsavel, briefing: await briefingLimpeza(env, x, agora) });
    return json({ limpezas: out });
  }
  if ((m = r.match(/^limpezas\/(\d{1,12})\/agendar$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    if (!dataOk(corpo.data)) return json({ erro: "Escolha a data da limpeza." }, 400);
    await env.DB.prepare("UPDATE plt_tp_limpezas SET data_saida=COALESCE(data_saida,data), data=?, aviso_ms=NULL, responsavel=COALESCE(NULLIF(?,''),responsavel) WHERE id=? AND org_id=?").bind(corpo.data, k.txt(corpo.responsavel, 60), Number(m[1]), orgId).run();
    return json({ ok: true });
  }

  // Avaliações dos hóspedes.
  if (r === "avaliacoes" && metodo === "GET") {
    const l = (((await env.DB.prepare("SELECT a.*, i.nome imovel FROM plt_tp_avaliacoes a LEFT JOIN plt_tp_imoveis i ON i.id=a.imovel_id WHERE a.org_id=? ORDER BY CASE a.status WHEN 'PRECISA_VOCE' THEN 0 WHEN 'PENDENTE' THEN 1 WHEN 'RASCUNHO' THEN 2 ELSE 3 END, a.id DESC LIMIT 300").bind(orgId).all())?.results) || []);
    const cfg = json_((await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind("tp_config_" + orgId).first())?.valor, {});
    return json({ avaliacoes: l.map(a => ({ ...a, analise: json_(a.analise, null), estrelas: notaEm5(a.nota, a.nota_max) })), auto: cfg.avaliacoes_auto !== "DESLIGADO", channex: channexLigado(env) });
  }
  if (r === "avaliacoes" && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const texto = k.txt(corpo.texto, 6000); if (!texto) return json({ erro: "Cole o texto da avaliação." }, 400);
    const im = corpo.imovel_id ? await imovel(corpo.imovel_id) : null;
    const canal = canalOk(corpo.canal || "airbnb"), max = Number(corpo.nota_max) || (canal === "booking" ? 10 : 5);
    const res = im && dataOk(corpo.inicio) ? await env.DB.prepare("SELECT id FROM plt_tp_reservas WHERE imovel_id=? AND inicio=? LIMIT 1").bind(im.id, corpo.inicio).first() : null;
    const id = (await env.DB.prepare("INSERT INTO plt_tp_avaliacoes(org_id,imovel_id,reserva_id,canal,externo_id,autor,nota,nota_max,texto,data,status,criado_ms) VALUES(?,?,?,?,?,?,?,?,?,?,'PENDENTE',?) RETURNING id")
      .bind(orgId, im?.id || null, res?.id || null, canal, "man:" + crypto.randomUUID(), k.txt(corpo.autor, 80) || "Hóspede", Number(corpo.nota) || null, max, texto, iso(agora), agora).first()).id;
    await cuidarAvaliacoesTp(env, k, orgId, 1).catch(e => console.warn("analisar", e?.message));
    const a = await env.DB.prepare("SELECT * FROM plt_tp_avaliacoes WHERE id=?").bind(id).first();
    return json({ ok: true, id, avaliacao: { ...a, analise: json_(a.analise, null), estrelas: notaEm5(a.nota, a.nota_max) } });
  }
  if ((m = r.match(/^avaliacoes\/(\d{1,12})\/(responder|analisar|resolver)$/)) && metodo === "POST") {
    const negado = precisa("AGENTE"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const av = await env.DB.prepare("SELECT * FROM plt_tp_avaliacoes WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).first();
    if (!av) return json({ erro: "Avaliação não encontrada." }, 404);
    if (m[2] === "analisar") { await env.DB.prepare("UPDATE plt_tp_avaliacoes SET status='PENDENTE' WHERE id=?").bind(av.id).run(); await cuidarAvaliacoesTp(env, k, orgId, 50); return json({ ok: true }); }
    if (m[2] === "resolver") { await env.DB.prepare("UPDATE plt_tp_avaliacoes SET status='RESPONDIDA', respondida_ms=? WHERE id=?").bind(agora, av.id).run(); return json({ ok: true }); }
    const texto = k.txt(corpo.texto || av.resposta_sugerida, 2000); if (!texto) return json({ erro: "Escreva a resposta." }, 400);
    let publicada = false;
    try { publicada = await publicarRespostaAvaliacao(env, av, texto); } catch (e) { return json({ erro: e.message }, 502); }
    await env.DB.prepare("UPDATE plt_tp_avaliacoes SET resposta=?, status='RESPONDIDA', respondida_ms=? WHERE id=?").bind(texto, agora, av.id).run();
    return json({ ok: true, publicada });
  }
  if (r === "avaliacoes/config" && metodo === "POST") {
    const negado = precisa("ADMIN"); if (negado) return negado;
    const { corpo, erro } = await ler(); if (erro) return erro;
    const cfg = json_((await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind("tp_config_" + orgId).first())?.valor, {});
    cfg.avaliacoes_auto = corpo.auto === false ? "DESLIGADO" : "CINCO";
    await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind("tp_config_" + orgId, JSON.stringify(cfg)).run();
    return json({ ok: true });
  }
  return null;
}
