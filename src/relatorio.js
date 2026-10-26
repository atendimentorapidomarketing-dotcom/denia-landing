// DENIA Platform — relatório de clientes (chatbot e IA).
// Uma CONVERSA começa na primeira mensagem do cliente e vale por 24 horas (a mesma regra que a Meta usa
// para contar conversas de atendimento); mensagem depois disso abre outra conversa. Assim o painel e a
// planilha contam clientes e conversas, nunca só mensagens.
// Entrada bruta (de qualquer fonte): entradas [{ telefone, ms }], buscas [{ telefone, ms, o, categoria }],
// nomes { telefone: nome } e antigos [telefone] (quem já tinha falado antes do período).
import { gerarXlsx } from "./planilha.js";

const FUSO_MS = 3 * 3600000; // Brasília (UTC−3, sem horário de verão)
const DIA_MS = 86400000;
const CONVERSA_MS = 24 * 3600000;
export const DIAS_SEMANA = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
const diaBR = ms => new Date(ms - FUSO_MS).toISOString().slice(0, 10);
const dataBR = d => d.split("-").reverse().join("/");
const horaBR = ms => new Date(ms - FUSO_MS).toISOString().slice(11, 16);
const semanaBR = d => DIAS_SEMANA[new Date(d + "T12:00:00Z").getUTCDay()];
const digitos = s => String(s || "").replace(/\D/g, "");

// Início do dia (00:00 de Brasília) de um instante.
export function inicioDoDia(ms) { return Date.parse(diaBR(ms) + "T00:00:00Z") + FUSO_MS; }
// Últimos 7 dias completos antes do dia do envio (ex.: enviado na segunda → segunda a domingo anteriores).
export function ultimos7Dias(agoraMs) { const fim = inicioDoDia(agoraMs); return { ini: fim - 7 * DIA_MS, fim }; }

// Conversas a partir das mensagens recebidas (ordenadas ou não): janela de 24 h por cliente.
export function contarConversas(entradas) {
  const porTel = new Map();
  for (const m of entradas) { if (!porTel.has(m.telefone)) porTel.set(m.telefone, []); porTel.get(m.telefone).push(Number(m.ms)); }
  const conversas = [];
  for (const [telefone, lista] of porTel) {
    lista.sort((a, b) => a - b);
    let atual = null;
    for (const t of lista) {
      if (!atual || t - atual.inicio >= CONVERSA_MS) { atual = { telefone, inicio: t, fim: t, mensagens: 0 }; conversas.push(atual); }
      atual.mensagens++; atual.fim = t;
    }
  }
  return conversas.sort((a, b) => a.inicio - b.inicio);
}

export function montarRelatorio({ entradas = [], buscas = [], nomes = {}, antigos = [] }, ini, fim) {
  const antes = new Set(antigos);
  const conversas = contarConversas(entradas.filter(m => m.ms >= ini && m.ms < fim));
  const porTel = new Map();
  for (const c of conversas) { if (!porTel.has(c.telefone)) porTel.set(c.telefone, []); porTel.get(c.telefone).push(c); }
  // O que buscou: as buscas/pedidos do cliente dentro da conversa.
  for (const b of buscas) {
    const lista = porTel.get(b.telefone) || [];
    // (10 min de folga: o pedido pode ser gravado com o relógio do motor, e a mensagem com o do banco)
    const c = lista.find(x => b.ms >= x.inicio - 600000 && b.ms < x.inicio + CONVERSA_MS) || lista.filter(x => x.inicio <= b.ms).pop();
    if (!c) continue;
    c.buscas = c.buscas || [];
    if (b.o && !c.buscas.includes(b.o)) c.buscas.push(b.o);
    if (b.aviso) c.avisos = (c.avisos || 0) + 1;
  }
  // Linha da planilha = uma conversa. "Recorrente" = o cliente já tinha falado antes desta conversa
  // (antes do período ou numa conversa anterior do mesmo período).
  const linhas = conversas.map(c => {
    const doCliente = porTel.get(c.telefone);
    return { ...c, buscas: c.buscas || [], avisos: c.avisos || 0, dia: diaBR(c.inicio), nome: nomes[c.telefone] || "", vezes: doCliente.length, recorrente: antes.has(c.telefone) || doCliente[0] !== c };
  });
  // Por dia: cliente = quem mandou mensagem naquele dia (mesmo no meio de uma conversa que começou na véspera);
  // novo = primeiro contato da vida foi naquele dia; conversas = conversas que começaram naquele dia.
  const noPeriodo = entradas.filter(m => m.ms >= ini && m.ms < fim);
  const primeiroDia = new Map();
  for (const m of noPeriodo) { const d = diaBR(m.ms); if (!primeiroDia.has(m.telefone) || d < primeiroDia.get(m.telefone)) primeiroDia.set(m.telefone, d); }
  const dias = [];
  for (let t = ini; t < fim; t += DIA_MS) dias.push(diaBR(t + 12 * 3600000));
  const porDia = dias.map(d => {
    const tels = new Set(noPeriodo.filter(m => diaBR(m.ms) === d).map(m => m.telefone));
    const novos = [...tels].filter(t => !antes.has(t) && primeiroDia.get(t) === d).length;
    const doDia = buscas.filter(b => diaBR(b.ms) === d);
    return { dia: d, clientes: tels.size, conversas: linhas.filter(c => c.dia === d).length, novos, recorrentes: tels.size - novos, buscas: doDia.length,
      escolheram: new Set(doDia.map(b => b.telefone)).size, avisados: new Set(doDia.filter(b => b.aviso).map(b => b.telefone)).size, avisos: doDia.filter(b => b.aviso).length };
  });
  const cat = new Map();
  for (const b of buscas) {
    const nome = b.categoria || b.o || "Não identificado";
    const x = cat.get(nome) || { categoria: nome, buscas: 0, clientes: new Set() };
    x.buscas++; if (b.telefone) x.clientes.add(b.telefone); cat.set(nome, x);
  }
  const categorias = [...cat.values()].map(x => ({ categoria: x.categoria, buscas: x.buscas, clientes: x.clientes.size })).sort((a, b) => b.buscas - a.buscas || b.clientes - a.clientes);
  const clientes = [...porTel.keys()];
  return {
    de: diaBR(ini), ate: diaBR(fim - 1), conversas: linhas, por_dia: porDia, categorias,
    tem_avisos: buscas.some(b => b.aviso !== undefined),
    totais: { escolheram: new Set(buscas.filter(b => b.ms >= ini && b.ms < fim).map(b => b.telefone)).size, avisos: buscas.filter(b => b.aviso).length, avisados: new Set(buscas.filter(b => b.aviso).map(b => b.telefone)).size,
      clientes: clientes.length, conversas: linhas.length, novos: clientes.filter(t => !antes.has(t)).length, recorrentes: clientes.filter(t => antes.has(t)).length, voltaram: [...porTel.values()].filter(l => l.length > 1).length, buscas: buscas.length }
  };
}

const fone = t => { const x = digitos(t); return x.length >= 12 ? `+${x.slice(0, 2)} (${x.slice(2, 4)}) ${x.slice(4, -4)}-${x.slice(-4)}` : x; };
export function planilhaRelatorio(d, empresa = "") {
  const av = Boolean(d.tem_avisos); // chatbot: separa quem escolheu uma opção (e gerou aviso no Telegram) de quem só mandou mensagem
  return gerarXlsx([
    { nome: "Resumo", larguras: [46, 44],
      linhas: [["Relatório de atendimento", empresa], ["Período", `${dataBR(d.de)} a ${dataBR(d.ate)}`], ["Clientes que entraram em contato (mandaram mensagem)", d.totais.clientes],
        ...(av ? [["Clientes que escolheram uma opção no menu", d.totais.escolheram], ["Clientes avisados no Telegram", d.totais.avisados], ["Avisos de cliente no Telegram", d.totais.avisos],
          ["Só mandaram mensagem (não escolheram opção)", Math.max(0, d.totais.clientes - d.totais.escolheram)]] : []),
        ["Clientes novos", d.totais.novos], ["Clientes recorrentes (já tinham falado antes)", d.totais.recorrentes], ["Conversas (janela de 24 horas)", d.totais.conversas],
        ["Clientes que voltaram no período", d.totais.voltaram], ["Buscas e pedidos", d.totais.buscas],
        ["Mais procurado", d.categorias[0] ? `${d.categorias[0].categoria} (${d.categorias[0].buscas})` : "-"],
        [], ["Como contamos", "Cliente = cada número de WhatsApp diferente que mandou mensagem. Conversa = começa na primeira mensagem e vale 24 horas, como a Meta conta."],
        ...(av ? [["Aviso no Telegram", "Sai quando o cliente escolhe uma opção com lojas ou resposta (não sai para quem só mandou \"oi\", nem para opções marcadas como sem aviso, nem para a mesma opção repetida em 1 hora)."]] : [])] },
    { nome: "Por dia", larguras: [12, 15, 10, 11, 9, 12, 9, ...(av ? [12, 12] : [])],
      linhas: [["Data", "Dia", "Clientes", "Conversas", "Novos", "Recorrentes", "Buscas", ...(av ? ["Escolheram opção", "Avisados no Telegram"] : [])],
        ...d.por_dia.map(x => [dataBR(x.dia), semanaBR(x.dia), x.clientes, x.conversas, x.novos, x.recorrentes, x.buscas, ...(av ? [x.escolheram, x.avisados] : [])]),
        ["Total do período", "", d.totais.clientes, d.totais.conversas, d.totais.novos, d.totais.recorrentes, d.totais.buscas, ...(av ? [d.totais.escolheram, d.totais.avisados] : [])]] },
    { nome: "Clientes", larguras: [12, 15, 7, 28, 20, 48, 11, 20, 26, ...(av ? [16] : [])],
      linhas: [["Data", "Dia", "Hora", "Nome", "Telefone", "O que procurou", "Mensagens", "Contatos no período", "Tipo de cliente", ...(av ? ["Aviso no Telegram"] : [])],
        ...d.conversas.map(c => [dataBR(c.dia), semanaBR(c.dia), horaBR(c.inicio), c.nome || "Sem nome", fone(c.telefone), c.buscas.join("; ") || (av ? "Não escolheu opção (só mandou mensagem)" : "Não informou"), c.mensagens,
          c.vezes > 1 ? `${c.vezes} conversas` : "1 conversa", c.recorrente ? "Recorrente" : "Novo", ...(av ? [c.avisos ? `Sim (${c.avisos})` : "Não"] : [])])] },
    { nome: "Categorias", larguras: [9, 52, 10, 18],
      linhas: [["Posição", "Categoria", "Buscas", "Clientes diferentes"], ...d.categorias.map((x, i) => [i + 1, x.categoria, x.buscas, x.clientes])] }
  ]);
}
export function textoRelatorio(d, empresa) {
  const top = d.categorias.slice(0, 5).map((x, i) => `${i + 1}. ${x.categoria}: ${x.buscas}`).join("\n") || "Sem buscas no período.";
  return [`Relatório de atendimento${empresa ? " - " + empresa : ""}`, `Período: ${dataBR(d.de)} a ${dataBR(d.ate)}`, "",
    `Clientes que entraram em contato: ${d.totais.clientes}`, ...(d.tem_avisos ? [`Escolheram uma opção no menu: ${d.totais.escolheram} | Avisados no Telegram: ${d.totais.avisados}`] : []), `Novos: ${d.totais.novos} | Recorrentes: ${d.totais.recorrentes}`, `Conversas: ${d.totais.conversas}`, `Clientes que voltaram no período: ${d.totais.voltaram}`, "",
    "Clientes por dia:", ...d.por_dia.map(x => `${semanaBR(x.dia)}, ${dataBR(x.dia)}: ${x.clientes}`), "",
    "Mais procurados:", top, "", "A planilha completa (nome, telefone, data, horário e o que cada cliente procurou) segue em anexo.",
    "Para mudar o dia, o horário ou quem recebe: Relatórios, no painel da DENIA."].join("\n");
}
export function base64(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }

// Configuração do envio por empresa (dia da semana 0–6, hora 0–23, e-mails extras).
export const CONFIG_PADRAO = { ativo: true, dia: 1, hora: 8, emails: "" };
export function lerConfigRelatorio(valor) {
  let c = {}; try { c = JSON.parse(valor || "{}") || {}; } catch { c = {}; }
  const dia = Number.isInteger(Number(c.dia)) && Number(c.dia) >= 0 && Number(c.dia) <= 6 ? Number(c.dia) : 1;
  const hora = Number.isInteger(Number(c.hora)) && Number(c.hora) >= 0 && Number(c.hora) <= 23 ? Number(c.hora) : 8;
  return { ativo: c.ativo !== false, dia, hora, emails: String(c.emails || "").slice(0, 600) };
}
// Está na hora de enviar? (no dia e a partir da hora escolhidos, horário de Brasília)
export function horaDeEnviar(cfg, agoraMs) {
  const d = new Date(agoraMs - FUSO_MS);
  return cfg.ativo && d.getUTCDay() === cfg.dia && d.getUTCHours() >= cfg.hora;
}
export { diaBR, dataBR };
