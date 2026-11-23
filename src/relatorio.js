// DENIA Platform — relatório de clientes (chatbot e IA).
// Uma CONVERSA começa na primeira mensagem do cliente e vale por 24 horas (a mesma regra que a Meta usa
// para contar conversas de atendimento); mensagem depois disso abre outra conversa. Assim o painel e a
// planilha contam clientes e conversas, nunca só mensagens.
// Entrada bruta (de qualquer fonte): entradas [{ telefone, ms }], buscas [{ telefone, ms, o, categoria }],
// nomes { telefone: nome } e antigos [telefone] (quem já tinha falado antes do período).
import { gerarXlsx, barra } from "./planilha.js";

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

export function montarRelatorio({ entradas = [], buscas = [], nomes = {}, antigos = [], telegram = null }, ini, fim) {
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

  }
  // Avisos que chegaram ao Telegram (registro exato do que foi enviado ao grupo), ligados à conversa do cliente.
  const tg = Array.isArray(telegram) ? telegram.filter(t => t.ms >= ini && t.ms < fim) : null;
  for (const t of tg || []) {
    const lista = porTel.get(t.telefone) || [];
    const c = lista.find(x => t.ms >= x.inicio - 600000 && t.ms < x.inicio + CONVERSA_MS) || lista.filter(x => x.inicio <= t.ms).pop();
    if (c) c.avisos = (c.avisos || 0) + 1;
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
      escolheram: new Set(doDia.map(b => b.telefone)).size,
      ...(tg ? { avisos: tg.filter(t => diaBR(t.ms) === d).length, avisados: new Set(tg.filter(t => diaBR(t.ms) === d).map(t => t.telefone)).size } : {}) };
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
    tem_avisos: Boolean(tg),
    totais: { escolheram: new Set(buscas.filter(b => b.ms >= ini && b.ms < fim).map(b => b.telefone)).size, ...(tg ? { avisos: tg.length, avisados: new Set(tg.map(t => t.telefone)).size } : {}),
      clientes: clientes.length, conversas: linhas.length, novos: clientes.filter(t => !antes.has(t)).length, recorrentes: clientes.filter(t => antes.has(t)).length, voltaram: [...porTel.values()].filter(l => l.length > 1).length, buscas: buscas.length }
  };
}

const fone = t => { const x = digitos(t); return x.length >= 12 ? `+${x.slice(0, 2)} (${x.slice(2, 4)}) ${x.slice(4, -4)}-${x.slice(-4)}` : x; };
const pctVar = (a, b) => b ? (a - b) / b : null;
const fmtVar = v => v === null ? "—" : `${v >= 0 ? "▲" : "▼"} ${Math.abs(v * 100).toFixed(1).replace(".", ",")}%`;
export const NOME_FREQ = { diario: "diário", semanal: "semanal", mensal: "mensal" };
// Planilha profissional: capa com indicadores (e comparação com o período anterior), por dia, horários,
// o que buscaram e a lista de clientes com filtro. Abre igual no Excel, Google Planilhas e LibreOffice.
export function planilhaRelatorio(d, empresa = "", { anterior = null, frequencia = "semanal", fontes = [], geradoMs = Date.now() } = {}) {
  const av = Boolean(d.tem_avisos);
  const T = d.totais, A = anterior ? anterior.totais : null;
  const nDias = Math.max(1, d.por_dia.length);
  const pico = [...d.por_dia].sort((a, b) => b.clientes - a.clientes)[0];
  const porHora = Array.from({ length: 24 }, (_, h) => d.conversas.filter(c => Number(horaBR(c.inicio).slice(0, 2)) === h).length);
  const horaPico = porHora.indexOf(Math.max(...porHora));
  const porSemana = DIAS_SEMANA.map((nome, i) => ({ nome, n: d.conversas.filter(c => new Date(c.dia + "T12:00:00Z").getUTCDay() === i).length }));
  const origem = fontes.includes("ia") && fontes.includes("chatbot") ? "IA do WhatsApp e chatbot" : fontes.includes("ia") ? "IA do WhatsApp" : fontes.includes("chatbot") ? "Chatbot do WhatsApp" : "WhatsApp";
  const geradoEm = new Date(geradoMs - FUSO_MS).toISOString().slice(0, 16).replace("T", " às ").split(" às ").map((x, i) => i ? x : dataBR(x)).join(" às ");
  const rodape = `DENIA · ${empresa || "Relatório"} · ${dataBR(d.de)} a ${dataBR(d.ate)}`;
  const kpi = (rotulo, valor, ant, dica, estilo = "kpiv") => [{ v: rotulo, s: "kpi" }, { v: valor, s: estilo }, A ? { v: ant ?? "—", s: estilo === "kpip" ? "kpiap" : "kpia" } : null, A ? (() => { const va = typeof valor === "number" && typeof ant === "number" ? pctVar(valor, ant) : null; return { v: fmtVar(va), s: va === null || va === 0 ? "kpia" : va > 0 ? "bom" : "ruim" }; })() : null, { v: dica || "", s: "nota" }].filter(x => x !== null);
  const taxaNovos = T.clientes ? T.novos / T.clientes : 0, taxaNovosA = A && A.clientes ? A.novos / A.clientes : null;
  const maxCat = Math.max(1, ...d.categorias.map(x => x.buscas)), totBuscas = d.categorias.reduce((t, x) => t + x.buscas, 0) || 1;
  const capa = [
    [{ v: "Relatório de atendimento", s: "titulo" }],
    [{ v: `${empresa}${empresa ? " · " : ""}Relatório ${NOME_FREQ[frequencia] || ""} · ${dataBR(d.de)} a ${dataBR(d.ate)}`, s: "sub" }],
    [{ v: `Fonte: ${origem} · gerado pela DENIA em ${geradoEm}`, s: "sub" }],
    [],
    [{ v: "Indicadores do período", s: "secao" }],
    [{ v: "Indicador", s: "cab" }, { v: "Neste período", s: "cab" }, ...(A ? [{ v: "Período anterior", s: "cab" }, { v: "Variação", s: "cab" }] : []), { v: "O que significa", s: "cab" }],
    kpi("Clientes que entraram em contato", T.clientes, A?.clientes, "Números de WhatsApp diferentes que mandaram mensagem."),
    kpi("Clientes novos", T.novos, A?.novos, "Primeira vez que falaram com a empresa."),
    kpi("Clientes recorrentes", T.recorrentes, A?.recorrentes, "Já tinham falado antes."),
    kpi("Taxa de clientes novos", taxaNovos, taxaNovosA, "Novos ÷ total de clientes.", "kpip"),
    kpi("Conversas", T.conversas, A?.conversas, "Cada conversa vale 24 h desde a primeira mensagem (regra da Meta)."),
    kpi("Clientes que voltaram no período", T.voltaram, A?.voltaram, "Tiveram mais de uma conversa no período."),
    kpi("Buscas e pedidos", T.buscas, A?.buscas, "O que os clientes procuraram ou pediram."),
    ...(av ? [kpi("Escolheram uma opção do menu", T.escolheram, A?.escolheram, "Clientes que tocaram numa opção do chatbot."), kpi("Encaminhados à equipe (Telegram)", T.avisos, A?.avisos, "Avisos que a DENIA mandou para a equipe atender.")] : []),
    kpi("Média de clientes por dia", Math.round((T.clientes / nDias) * 10) / 10, A ? Math.round((A.clientes / Math.max(1, anterior.por_dia.length)) * 10) / 10 : null, "Total de clientes ÷ dias do período."),
    [],
    [{ v: "Destaques", s: "secao" }],
    [{ v: "Dia de maior movimento", s: "kpi" }, { v: pico && pico.clientes ? `${semanaBR(pico.dia)}, ${dataBR(pico.dia)} (${pico.clientes} clientes)` : "—", s: "txt" }],
    [{ v: "Horário de pico", s: "kpi" }, { v: Math.max(...porHora) ? `${String(horaPico).padStart(2, "0")}h às ${String(horaPico + 1).padStart(2, "0")}h (${porHora[horaPico]} conversas)` : "—", s: "txt" }],
    [{ v: "Mais procurado", s: "kpi" }, { v: d.categorias[0] ? `${d.categorias[0].categoria} (${d.categorias[0].buscas})` : "—", s: "txt" }],
    [],
    [{ v: "Os 5 mais procurados", s: "secao" }],
    [{ v: "O que buscaram", s: "cab" }, { v: "Buscas", s: "cab" }, { v: "% do total", s: "cab" }],
    ...(d.categorias.length ? d.categorias.slice(0, 5).map((x, i) => [{ v: `${i + 1}. ${x.categoria}`, s: "txt" }, { v: x.buscas, s: "kpia" }, { v: x.buscas / totBuscas, s: "kpiap" }]) : [[{ v: "Sem buscas no período.", s: "nota" }]]),
    [],
    [{ v: "Como contamos: cliente = cada número de WhatsApp diferente; conversa = começa na primeira mensagem e vale 24 horas; novo = primeiro contato da vida com a empresa. As outras abas trazem o detalhe por dia, por horário, o que buscaram e cada cliente.", s: "nota" }]
  ];
  const dias = d.por_dia;
  const maxDia = Math.max(1, ...dias.map(x => x.clientes));
  const porDia = [
    ["Data", "Dia da semana", "Clientes", "Novos", "Recorrentes", "Conversas", "Buscas", ...(av ? ["Escolheram opção", "Encaminhados à equipe"] : []), "Gráfico (clientes)"],
    ...dias.map(x => [dataBR(x.dia), semanaBR(x.dia), x.clientes, x.novos, x.recorrentes, x.conversas, x.buscas, ...(av ? [x.escolheram, x.avisos] : []), { v: barra(x.clientes, maxDia), s: "barra" }]),
    [{ v: "Total", s: "total" }, { v: "", s: "total" }, { v: T.clientes, s: "totaln" }, { v: T.novos, s: "totaln" }, { v: T.recorrentes, s: "totaln" }, { v: T.conversas, s: "totaln" }, { v: T.buscas, s: "totaln" }, ...(av ? [{ v: T.escolheram, s: "totaln" }, { v: T.avisos, s: "totaln" }] : []), { v: "", s: "total" }],
    [{ v: "Média por dia", s: "total" }, { v: "", s: "total" }, ...[T.clientes, T.novos, T.recorrentes, T.conversas, T.buscas, ...(av ? [T.escolheram, T.avisos] : [])].map(v => ({ v: Math.round((v / nDias) * 10) / 10, s: "totaln" })), { v: "", s: "total" }]
  ];
  const maxH = Math.max(1, ...porHora), maxS = Math.max(1, ...porSemana.map(x => x.n)), totC = Math.max(1, d.conversas.length);
  const horarios = [
    ["Faixa de horário", "Conversas iniciadas", "% do total", "Gráfico", "", "Dia da semana", "Conversas", "% do total", "Gráfico"],
    ...Array.from({ length: 24 }, (_, h) => {
      const sem = porSemana[h];
      return [`${String(h).padStart(2, "0")}h às ${String((h + 1) % 24).padStart(2, "0")}h`, porHora[h], { v: porHora[h] / totC, s: "pct" }, { v: barra(porHora[h], maxH), s: "barra" }, null,
        ...(sem ? [sem.nome, sem.n, { v: sem.n / totC, s: "pct" }, { v: barra(sem.n, maxS), s: "barra" }] : [])];
    })
  ];
  const buscas = [
    ["Posição", "O que buscaram", "Buscas", "% das buscas", "Clientes diferentes", "Gráfico"],
    ...d.categorias.map((x, i) => [i + 1, x.categoria, x.buscas, { v: x.buscas / totBuscas, s: "pct" }, x.clientes, { v: barra(x.buscas, maxCat), s: "barra" }])
  ];
  const clientes = [
    ["Data", "Dia", "Hora", "Nome", "Telefone (WhatsApp)", "O que procurou", "Mensagens", "Conversas no período", "Tipo de cliente", ...(av ? ["Encaminhado à equipe"] : [])],
    ...d.conversas.map(c => [dataBR(c.dia), semanaBR(c.dia), horaBR(c.inicio), c.nome || "Sem nome", fone(c.telefone), c.buscas.join("; ") || (av ? "Não escolheu opção (só mandou mensagem)" : "Não informou"), c.mensagens,
      c.vezes, c.recorrente ? "Recorrente" : "Novo", ...(av ? [c.avisos ? `Sim (${c.avisos})` : "Não"] : [])])
  ];
  return gerarXlsx([
    { nome: "Resumo", linhas: capa, larguras: A ? [40, 16, 16, 14, 58] : [40, 16, 58], semGrade: true, congelar: false, retrato: true, rodape,
      mesclar: ["A1:E1", "A2:E2", "A3:E3", `A${capa.length}:E${capa.length}`, ...capa.map((l, i) => l[0] && l[0].s === "kpi" && l.length === 2 ? `B${i + 1}:${A ? "E" : "C"}${i + 1}` : null).filter(Boolean)] },
    { nome: "Por dia", linhas: porDia, cabecalho: 0, fimTabela: dias.length, larguras: [12, 15, 10, 9, 12, 11, 9, ...(av ? [14, 16] : []), 24], rodape },
    { nome: "Horários", linhas: horarios, cabecalho: 0, filtro: false, larguras: [18, 12, 11, 24, 3, 16, 11, 11, 24], rodape },
    { nome: "O que buscaram", linhas: buscas, cabecalho: 0, larguras: [9, 50, 10, 12, 16, 24], rodape },
    { nome: "Clientes", linhas: clientes, cabecalho: 0, congelarColunas: 1, larguras: [11, 14, 7, 26, 20, 50, 10, 12, 14, ...(av ? [16] : [])], rodape }
  ]);
}
export function textoRelatorio(d, empresa, { anterior = null, frequencia = "semanal" } = {}) {
  const top = d.categorias.slice(0, 5).map((x, i) => `${i + 1}. ${x.categoria}: ${x.buscas}`).join("\n") || "Sem buscas no período.";
  const cmp = (a, b) => anterior && b !== undefined ? ` (antes: ${b}; ${fmtVar(pctVar(a, b))})` : "";
  return [`Relatório ${NOME_FREQ[frequencia] || ""} de atendimento${empresa ? " - " + empresa : ""}`, `Período: ${dataBR(d.de)} a ${dataBR(d.ate)}`, "",
    `Clientes que entraram em contato: ${d.totais.clientes}${cmp(d.totais.clientes, anterior?.totais.clientes)}`, ...(d.tem_avisos ? [`Escolheram uma opção no menu: ${d.totais.escolheram} | Avisos enviados ao Telegram: ${d.totais.avisos} (de ${d.totais.avisados} clientes)`] : []), `Novos: ${d.totais.novos} | Recorrentes: ${d.totais.recorrentes}`, `Conversas: ${d.totais.conversas}`, `Clientes que voltaram no período: ${d.totais.voltaram}`, "",
    "Clientes por dia:", ...d.por_dia.map(x => `${semanaBR(x.dia)}, ${dataBR(x.dia)}: ${x.clientes}`), "",
    "Mais procurados:", top, "", "A planilha completa (nome, telefone, data, horário e o que cada cliente procurou) segue em anexo.",
    "Para mudar a frequência (diário, semanal ou mensal), o horário ou quem recebe: Relatórios, no painel da DENIA."].join("\n");
}
export function base64(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }

// Configuração do envio por empresa (dia da semana 0–6, hora 0–23, e-mails extras).
export const CONFIG_PADRAO = { ativo: true, frequencia: "semanal", dia: 1, hora: 8, emails: "" };
export function lerConfigRelatorio(valor) {
  let c = {}; try { c = JSON.parse(valor || "{}") || {}; } catch { c = {}; }
  const dia = Number.isInteger(Number(c.dia)) && Number(c.dia) >= 0 && Number(c.dia) <= 6 ? Number(c.dia) : 1;
  const hora = Number.isInteger(Number(c.hora)) && Number(c.hora) >= 0 && Number(c.hora) <= 23 ? Number(c.hora) : 8;
  const frequencia = NOME_FREQ[c.frequencia] ? c.frequencia : "semanal";
  return { ativo: c.ativo !== false, frequencia, dia, hora, emails: String(c.emails || "").slice(0, 600) };
}
// Está na hora de enviar? Diário: todo dia a partir da hora; semanal: no dia da semana; mensal: no dia 1 (Brasília).
export function horaDeEnviar(cfg, agoraMs) {
  const d = new Date(agoraMs - FUSO_MS);
  if (!cfg.ativo || d.getUTCHours() < cfg.hora) return false;
  if (cfg.frequencia === "diario") return true;
  if (cfg.frequencia === "mensal") return d.getUTCDate() === 1;
  return d.getUTCDay() === cfg.dia;
}
// Período do relatório: diário = ontem; semanal = últimos 7 dias; mensal = o mês anterior inteiro. E o período
// anterior de mesmo tamanho, para a comparação.
export function periodoDoRelatorio(frequencia, agoraMs) {
  const fim = inicioDoDia(agoraMs);
  let ini;
  if (frequencia === "diario") ini = fim - DIA_MS;
  else if (frequencia === "mensal") { const d = new Date(fim - FUSO_MS - DIA_MS); ini = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) + FUSO_MS; }
  else ini = fim - 7 * DIA_MS;
  let iniAnt;
  if (frequencia === "mensal") { const d = new Date(ini - FUSO_MS - DIA_MS); iniAnt = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) + FUSO_MS; }
  else iniAnt = ini - (fim - ini);
  return { ini, fim, iniAnt, fimAnt: ini };
}
export { diaBR, dataBR };
