// DENIA Platform — Locação por temporada (Airbnb, Booking.com e Vrbo).
// Duas formas de conexão, que se completam:
//  1) Calendário (iCal): funciona hoje com qualquer plataforma. A DENIA importa o calendário de cada
//     anúncio e gera um calendário único para colar nas outras — acaba com reserva dupla.
//  2) Conexão oficial pelo Channex (gerenciador de canais certificado pelo Airbnb, Booking.com e Vrbo):
//     preços, taxas, disponibilidade, reservas e mensagens em tempo real. Variável CHANNEX_API_KEY
//     (CHANNEX_STAGING=1 para testes). O anfitrião liga cada plataforma com o login dela, pela tela do Channex.
// A IA responde os hóspedes com o treinamento de cada imóvel e o jeito de escrever do anfitrião.

import { openaiResposta } from "./marketing.js";

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
  `CREATE INDEX IF NOT EXISTS idx_tp_limp_data ON plt_tp_limpezas(org_id, data)`
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
    return { ok: true, eventos: eventos.length };
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
// Cria no Channex o imóvel, a unidade e um plano de preço por plataforma (preço próprio em cada uma).
async function garantirChannex(env, k, im) {
  let prop = im.channex_property, room = im.channex_room, rates = json_(im.channex_rates, {});
  if (!prop) prop = (await cx(env, "POST", "/properties", { property: { title: im.nome, currency: im.moeda || "BRL", city: im.cidade || undefined, address: im.endereco || undefined, property_type: "apartment", settings: { allow_availability_autoupdate_on_confirmation: true } } }))?.data?.id;
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
  for (let d = de; d <= ate && values.length < 2500; d = somaDias(d, 1)) {
    const e = esp.get(d);
    for (const [canal, rate] of Object.entries(rates)) {
      if (!rate) continue;
      values.push({ property_id: im.channex_property, rate_plan_id: rate, date_from: d, date_to: d, rate: precoNoCanal(precoDoDia(im, d, e), im, canal).toFixed(2), min_stay_arrival: Number(e?.minimo || im.minimo_noites || 1), stop_sell: Boolean(e?.fechado) });
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
  const im = p.property_id ? await env.DB.prepare("SELECT * FROM plt_tp_imoveis WHERE org_id=? AND channex_property=?").bind(org, p.property_id).first() : null;
  if (!im) return new Response("ok");
  const agora = k.agora(env);
  if (/^booking/.test(ev) && p.booking_id) {
    const b = (await cx(env, "GET", `/bookings/${p.booking_id}`).catch(() => null))?.data?.attributes || p;
    const canal = /airbnb/i.test(b.ota_name || "") ? "airbnb" : /booking/i.test(b.ota_name || "") ? "booking" : /vrbo|homeaway|expedia/i.test(b.ota_name || "") ? "vrbo" : "outro";
    const cliente = b.customer || {};
    await env.DB.prepare(`INSERT INTO plt_tp_reservas(org_id,imovel_id,canal,externo_id,tipo,status,hospede,hospedes,inicio,fim,valor,moeda,contato,origem,criado_ms,atualizado_ms) VALUES(?,?,?,?,'RESERVA',?,?,?,?,?,?,?,?,'CHANNEX',?,?)
      ON CONFLICT(org_id,imovel_id,canal,externo_id) DO UPDATE SET status=excluded.status, hospede=excluded.hospede, hospedes=excluded.hospedes, inicio=excluded.inicio, fim=excluded.fim, valor=excluded.valor, moeda=excluded.moeda, contato=excluded.contato, origem='CHANNEX', atualizado_ms=excluded.atualizado_ms`)
      .bind(org, im.id, canal, "cx:" + p.booking_id, b.status === "cancelled" ? "CANCELADA" : "CONFIRMADA", cortar([cliente.name, cliente.surname].filter(Boolean).join(" "), 120) || "Hóspede", Number(b.occupancy?.adults || 0) + Number(b.occupancy?.children || 0) || null, b.arrival_date || iso(agora), b.departure_date || iso(agora + DIA), Number(b.amount || 0) || null, b.currency || im.moeda || "BRL", cortar(cliente.mail || cliente.phone || "", 120), agora, agora).run();
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
  return CAMPOS_TREINO_IMOVEL.map(([c, r]) => t[c] ? `${r.toUpperCase()}:\n${cortar(t[c], 2500)}` : "").filter(Boolean).join("\n\n") || "(o anfitrião ainda não preencheu o treinamento deste imóvel)";
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
  let ocupadas = 0, bloqueadas = 0, receita = 0, noitesPagas = 0;
  const porCanal = {}, porDia = new Map(), antecedencia = [], estadias = [];
  for (const r of res) {
    const ini = r.inicio < de ? de : r.inicio, fim = r.fim > somaDias(ate, 1) ? somaDias(ate, 1) : r.fim;
    const n = noites(ini, fim), total = noites(r.inicio, r.fim) || 1;
    if (r.tipo === "BLOQUEIO") { bloqueadas += n; continue; }
    ocupadas += n;
    const valor = r.valor ? (Number(r.valor) * n) / total : 0;
    receita += valor; if (r.valor) noitesPagas += n;
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
    antecedencia_mediana: med(antecedencia), estadia_mediana: med(estadias)
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
  const publico = im => ({ ...im, ajustes: json_(im.ajustes, {}), treinamento: json_(im.treinamento, {}), anuncio: json_(im.anuncio, {}), channex_rates: undefined, conectado_channex: Boolean(im.channex_property),
    ical_url: im.ical_token ? new URL(`/tp/ical/${im.ical_token}.ics`, request.url).toString() : null });
  let m;

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
    const l = (await env.DB.prepare("SELECT i.*, (SELECT COUNT(*) FROM plt_tp_calendarios c WHERE c.imovel_id=i.id) calendarios FROM plt_tp_imoveis i WHERE i.org_id=? ORDER BY i.ativo DESC, i.nome").bind(orgId).all())?.results || [];
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
    if (id) await env.DB.prepare("UPDATE plt_tp_imoveis SET nome=?, endereco=?, cidade=?, capacidade=?, quartos=?, banheiros=?, checkin=?, checkout=?, moeda=?, preco_base=?, preco_fds=?, minimo_noites=?, taxa_limpeza=?, ajustes=?, treinamento=?, anuncio=?, ia_modo=?, ativo=? WHERE id=? AND org_id=?").bind(...v, id, orgId).run();
    else novoId = (await env.DB.prepare("INSERT INTO plt_tp_imoveis(nome,endereco,cidade,capacidade,quartos,banheiros,checkin,checkout,moeda,preco_base,preco_fds,minimo_noites,taxa_limpeza,ajustes,treinamento,anuncio,ia_modo,ativo,org_id,ical_token,criado_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id").bind(...v, orgId, [...crypto.getRandomValues(new Uint8Array(18))].map(b => b.toString(16).padStart(2, "0")).join(""), agora).first())?.id;
    // Mudou preço, mínimo ou ajuste das plataformas: manda para as plataformas conectadas.
    let enviado = null;
    const im = await imovel(novoId);
    if (im.channex_property && (corpo.preco_base !== undefined || corpo.preco_fds !== undefined || corpo.ajustes || corpo.minimo_noites !== undefined))
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
    const de = dataOk(q.get("de")) ? q.get("de") : iso(agora), ate = dataOk(q.get("ate")) && noites(de, q.get("ate")) <= 120 ? q.get("ate") : somaDias(de, 41);
    const ims = (await env.DB.prepare("SELECT * FROM plt_tp_imoveis WHERE org_id=? AND ativo=1 ORDER BY nome").bind(orgId).all())?.results || [];
    const [res, esp] = await env.DB.batch([
      env.DB.prepare("SELECT id, imovel_id, canal, tipo, hospede, hospedes, inicio, fim, valor, risco, origem FROM plt_tp_reservas WHERE org_id=? AND status='CONFIRMADA' AND inicio <= ? AND fim > ?").bind(orgId, ate, de),
      env.DB.prepare("SELECT * FROM plt_tp_precos WHERE org_id=? AND data BETWEEN ? AND ?").bind(orgId, de, ate)
    ]);
    const e = new Map((esp?.results || []).map(x => [x.imovel_id + "|" + x.data, x]));
    const dias = []; for (let d = de; d <= ate; d = somaDias(d, 1)) dias.push(d);
    return json({ de, ate, dias, imoveis: ims.map(im => ({ id: im.id, nome: im.nome, moeda: im.moeda, ajustes: json_(im.ajustes, {}), precos: dias.map(d => { const x = e.get(im.id + "|" + d); return { data: d, preco: precoDoDia(im, d, x), minimo: x?.minimo || im.minimo_noites || 1, fechado: Boolean(x?.fechado), especial: Boolean(x?.preco) }; }) })), reservas: res?.results || [], canais: CANAIS });
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
    const id = (await env.DB.prepare("INSERT INTO plt_tp_reservas(org_id,imovel_id,canal,externo_id,tipo,status,hospede,hospedes,inicio,fim,valor,moeda,contato,notas,origem,criado_ms,atualizado_ms) VALUES(?,?,?,?,?,'CONFIRMADA',?,?,?,?,?,?,?,?,'MANUAL',?,?) RETURNING id")
      .bind(orgId, im.id, tipo === "BLOQUEIO" ? "direto" : canalOk(corpo.canal || "direto"), "man:" + crypto.randomUUID(), tipo, k.txt(corpo.hospede, 120) || (tipo === "BLOQUEIO" ? "Bloqueio" : "Hóspede"), Number(corpo.hospedes) || null, corpo.inicio, corpo.fim, Number(corpo.valor) || null, im.moeda, k.txt(corpo.contato, 120), k.txt(corpo.notas, 1000), agora, agora).first()).id;
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
