// DENIA Platform — Problemas.
// Junta numa tela só o que deu errado e precisa de atenção: mensagens do WhatsApp que não chegaram,
// clientes esperando a equipe, posts que não saíram, avaliações ruins sem resposta, calendários que
// não atualizaram e avisos que não foram enviados. Quase tudo é lido dos registros que já existem
// (nada novo a gravar a cada mensagem); só o que não fica guardado em outro lugar vai para plt_problemas.
// "Marcar como resolvido" esconde o item; se o mesmo problema acontecer de novo, ele volta.

export const DDL_PROBLEMAS = [
  `CREATE TABLE IF NOT EXISTS plt_problemas (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, chave TEXT NOT NULL, area TEXT NOT NULL, titulo TEXT NOT NULL, motivo TEXT, dica TEXT, link TEXT, gravidade TEXT NOT NULL DEFAULT 'MEDIA', vezes INTEGER NOT NULL DEFAULT 1, criado_ms INTEGER NOT NULL, ultimo_ms INTEGER NOT NULL, resolvido_ms INTEGER, UNIQUE(org_id, chave))`,
  `CREATE TABLE IF NOT EXISTS plt_problemas_vistos (org_id INTEGER NOT NULL, chave TEXT NOT NULL, ms INTEGER NOT NULL, PRIMARY KEY (org_id, chave))`
];

const HORA = 3600000, DIA = 24 * HORA;
const agoraDe = env => typeof env.__agora === "function" ? env.__agora() : Date.now();
const cortar = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

// Registra (ou soma mais uma vez) um problema que não fica guardado em outro lugar.
// Se ele tinha sido resolvido, volta a aparecer.
export async function registrarProblema(env, orgId, p) {
  if (!orgId || !p?.chave) return;
  const agora = agoraDe(env);
  await env.DB.prepare(`INSERT INTO plt_problemas(org_id,chave,area,titulo,motivo,dica,link,gravidade,vezes,criado_ms,ultimo_ms) VALUES(?,?,?,?,?,?,?,?,1,?,?)
    ON CONFLICT(org_id,chave) DO UPDATE SET titulo=excluded.titulo, motivo=excluded.motivo, dica=excluded.dica, link=excluded.link, gravidade=excluded.gravidade,
    vezes=CASE WHEN resolvido_ms IS NULL THEN vezes+1 ELSE 1 END, criado_ms=CASE WHEN resolvido_ms IS NULL THEN criado_ms ELSE excluded.criado_ms END, ultimo_ms=excluded.ultimo_ms, resolvido_ms=NULL`)
    .bind(orgId, cortar(p.chave, 120), p.area || "SISTEMA", cortar(p.titulo, 200), cortar(p.motivo, 600) || null, cortar(p.dica, 600) || null, p.link || null, p.gravidade || "MEDIA", agora, agora).run().catch(() => { });
}
// O problema parou de acontecer (ex.: o Telegram voltou a aceitar os avisos).
export async function resolverProblema(env, orgId, chave) {
  if (!orgId || !chave) return;
  await env.DB.prepare("UPDATE plt_problemas SET resolvido_ms=? WHERE org_id=? AND chave=? AND resolvido_ms IS NULL").bind(agoraDe(env), orgId, chave).run().catch(() => { });
}

// Motivos que a Meta devolve quando uma mensagem não chega, em português e com o que fazer.
const MOTIVOS_META = {
  131047: ["Passaram mais de 24 horas desde a última mensagem do cliente.", "Fora dessa janela o WhatsApp só deixa enviar um modelo aprovado (Modelos de mensagem). Quando o cliente escrever de novo, a conversa abre outra vez."],
  470: ["Passaram mais de 24 horas desde a última mensagem do cliente.", "Use um modelo aprovado para falar com ele de novo."],
  131026: ["O número não recebeu: pode não ter WhatsApp, estar desatualizado ou ter bloqueado a empresa.", "Confira o número com o cliente por outro meio."],
  131049: ["A Meta segurou a mensagem para não cansar o cliente (ele já recebeu muitas mensagens de marketing de empresas).", "Tente mais tarde ou mande uma mensagem de utilidade em vez de marketing."],
  131050: ["O cliente pediu para não receber mensagens de marketing desta empresa.", "Não insista; ele ainda pode falar com a empresa quando quiser."],
  130472: ["A Meta não entregou porque o número está num teste interno dela (não recebe marketing).", "Nada a fazer pela DENIA; a Meta libera depois."],
  131056: ["Muitas mensagens seguidas para o mesmo número em pouco tempo.", "Espere alguns minutos antes de mandar de novo."],
  131042: ["Problema de pagamento na conta do WhatsApp na Meta.", "Abra business.facebook.com → Configurações → Pagamentos e confira o cartão."],
  131031: ["A Meta bloqueou ou restringiu a conta do WhatsApp.", "Veja o aviso em business.facebook.com → WhatsApp Manager → Visão geral."],
  131048: ["A Meta limitou os envios porque muitos clientes bloquearam ou denunciaram as mensagens.", "Diminua as campanhas e confira a Saúde do número."],
  131051: ["O WhatsApp não aceita esse tipo de mensagem.", "Mande como texto."],
  131052: ["Não foi possível baixar o arquivo que o cliente mandou.", "Peça para ele mandar de novo."],
  131053: ["A imagem ou o arquivo não pôde ser enviado (link fora do ar ou formato não aceito).", "Troque a imagem no Menu de botões."],
  132000: ["O número de variáveis do modelo não confere.", "Abra a campanha e preencha todas as variáveis do modelo."],
  132001: ["O modelo não existe nesse idioma ou ainda não foi aprovado.", "Confira em Modelos de mensagem."],
  132012: ["As variáveis do modelo estão no formato errado.", "Confira o texto das variáveis da campanha."],
  132015: ["O modelo foi pausado pela Meta por baixa qualidade.", "Crie outro modelo ou espere a Meta liberar."],
  132016: ["O modelo foi desativado pela Meta.", "Crie outro modelo em Modelos de mensagem."],
  133010: ["O número da empresa não está registrado no WhatsApp Cloud.", "Conecte o número de novo em Conectar número."],
  368: ["A Meta bloqueou temporariamente os envios por violação das regras.", "Veja o aviso em business.facebook.com e espere o fim do bloqueio."],
  190: ["O acesso da DENIA ao WhatsApp expirou ou foi desconectado.", "Conecte o número de novo em Conectar número."],
  10: ["A DENIA perdeu a permissão para enviar pelo número.", "Conecte o número de novo em Conectar número."],
  200: ["A DENIA perdeu a permissão para enviar pelo número.", "Conecte o número de novo em Conectar número."],
  100: ["A Meta recusou o formato da mensagem.", "Se continuar, avise o suporte da DENIA com o horário da falha."],
  131000: ["Erro temporário da Meta.", "Costuma passar sozinho; se repetir, mande de novo."],
  131016: ["O WhatsApp está fora do ar por alguns instantes.", "Mande de novo em alguns minutos."]
};
export function motivoWhatsapp(erro) {
  const s = String(erro || "").trim();
  const m = s.match(/^(\d{1,7})\s*:\s*(.*)$/);
  const cod = m ? Number(m[1]) : null;
  const conhecido = cod != null ? MOTIVOS_META[cod] : null;
  if (conhecido) return { motivo: conhecido[0], dica: conhecido[1], codigo: cod, original: m[2] || "" };
  if (!s) return { motivo: "A Meta não informou o motivo.", dica: "Abra a conversa e tente de novo.", codigo: null, original: "" };
  if (/timeout|timed out|abort/i.test(s)) return { motivo: "A Meta demorou demais para responder.", dica: "Tente de novo em alguns minutos.", codigo: null, original: s };
  if (/fetch|network|rede/i.test(s)) return { motivo: "Falha de conexão com a Meta.", dica: "Tente de novo em alguns minutos.", codigo: null, original: s };
  return { motivo: m ? m[2] || `Erro ${cod} da Meta.` : s, dica: "Abra a conversa e tente de novo.", codigo: cod, original: s };
}

const NOME_CANAL = { instagram: "Instagram", facebook: "Facebook", google: "Google" };
const CANAL_TP = { airbnb: "Airbnb", booking: "Booking.com", vrbo: "Vrbo" };
const linhas = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all().catch(() => null))?.results || [];
const nomeCliente = (nome, tel) => nome ? `${nome} (${tel})` : tel;

// Todos os problemas atuais da empresa, do mais recente para o mais antigo.
export async function listarProblemas(env, orgId, agora = agoraDe(env)) {
  const itens = [];
  const add = p => itens.push({ gravidade: "MEDIA", vezes: 1, ...p });

  // 1. Registrados (avisos do Telegram, entrega da IA do WhatsApp…), nos últimos 30 dias.
  for (const p of await linhas(env, "SELECT * FROM plt_problemas WHERE org_id=? AND resolvido_ms IS NULL AND ultimo_ms>? ORDER BY ultimo_ms DESC LIMIT 50", orgId, agora - 30 * DIA))
    add({ chave: "reg:" + p.chave + ":" + p.criado_ms, area: p.area, titulo: p.titulo, motivo: p.motivo, dica: p.dica, link: p.link, gravidade: p.gravidade, vezes: p.vezes, ms: p.ultimo_ms, registrado: p.chave });

  // 2. Mensagens do WhatsApp (chatbot) que não chegaram, nos últimos 7 dias, juntas por cliente e motivo.
  const falhas = await linhas(env, `SELECT m.telefone, c.nome, substr(COALESCE(m.erro,''),1,instr(COALESCE(m.erro,'')||':',':')-1) codigo, MAX(m.erro) erro, COUNT(*) n, MAX(m.id) ultimo_id, MAX(m.criado_ms) ms, MAX(m.texto) texto
    FROM plt_zap_msgs m LEFT JOIN plt_zap_contatos c ON c.org_id=m.org_id AND c.telefone=m.telefone
    WHERE m.org_id=? AND m.direcao='S' AND m.status IN ('FAILED','FALHOU') AND m.origem<>'CAMPANHA' AND m.criado_ms>?
    GROUP BY m.telefone, codigo ORDER BY ms DESC LIMIT 40`, orgId, agora - 7 * DIA);
  for (const f of falhas) {
    const mt = motivoWhatsapp(f.erro);
    add({ chave: `zap:${f.telefone}:${f.codigo}:${f.ultimo_id}`, area: "WHATSAPP", titulo: `Mensagem não entregue para ${nomeCliente(f.nome, f.telefone)}`, motivo: mt.motivo, dica: mt.dica, detalhe: [f.texto ? "Mensagem: " + cortar(f.texto, 160) : "", mt.original && mt.original !== mt.motivo ? "Resposta da Meta: " + cortar(mt.original, 200) : ""].filter(Boolean).join("\n"), link: "#/chatbot/conversas", gravidade: [190, 10, 200, 131031, 131042, 368, 133010].includes(mt.codigo) ? "ALTA" : "MEDIA", vezes: f.n, ms: f.ms });
  }

  // 3. Campanhas com mensagens que não chegaram (uma linha por campanha, com o motivo mais comum).
  for (const c of await linhas(env, `SELECT c.id, c.nome, c.total, COALESCE(c.fim_ms, c.criado_ms) ms,
      (SELECT COUNT(*) FROM plt_zap_envios e WHERE e.campanha_id=c.id AND e.status IN ('FALHOU','FAILED')) falhas,
      (SELECT e.erro FROM plt_zap_envios e WHERE e.campanha_id=c.id AND e.status IN ('FALHOU','FAILED') AND e.erro IS NOT NULL GROUP BY e.erro ORDER BY COUNT(*) DESC LIMIT 1) erro
      FROM plt_zap_campanhas c WHERE c.org_id=? AND c.criado_ms>? ORDER BY c.id DESC LIMIT 20`, orgId, agora - 14 * DIA)) {
    if (!c.falhas) continue;
    const mt = motivoWhatsapp(c.erro);
    add({ chave: `camp:${c.id}:${c.falhas}`, area: "WHATSAPP", titulo: `Campanha "${c.nome}": ${c.falhas} de ${c.total} mensagens não chegaram`, motivo: "Motivo mais comum: " + mt.motivo, dica: mt.dica, link: "#/chatbot/campanhas", gravidade: c.falhas >= Math.max(5, c.total * 0.3) ? "ALTA" : "MEDIA", vezes: c.falhas, ms: c.ms });
  }

  // 4. Clientes esperando a equipe: pediram um atendente (o robô pausou) e ninguém respondeu há mais de 30 min.
  for (const c of await linhas(env, `SELECT c.telefone, c.nome, c.ultima_entrada_ms ms FROM plt_zap_contatos c
      WHERE c.org_id=? AND c.pausado_ate>? AND c.ultima_entrada_ms BETWEEN ? AND ?
      AND NOT EXISTS (SELECT 1 FROM plt_zap_msgs m WHERE m.org_id=c.org_id AND m.telefone=c.telefone AND m.direcao='S' AND m.criado_ms>=c.ultima_entrada_ms AND m.origem<>'ROBO')
      ORDER BY c.ultima_entrada_ms DESC LIMIT 30`, orgId, agora, agora - DIA, agora - 30 * 60000)) {
    const min = Math.round((agora - c.ms) / 60000);
    add({ chave: `espera:${c.telefone}:${c.ms}`, area: "CLIENTES", titulo: `${nomeCliente(c.nome, c.telefone)} está esperando resposta da equipe`, motivo: `Pediu para falar com uma pessoa e está sem resposta há ${min < 120 ? min + " min" : Math.round(min / 60) + " h"}. O robô fica em pausa nessa conversa.`, dica: "Responda em Conversas do chatbot (ou pelo Telegram). Depois de 24 h sem resposta, só dá para falar com ele por um modelo aprovado.", link: "#/chatbot/conversas", gravidade: agora - c.ms > 4 * HORA ? "ALTA" : "MEDIA", ms: c.ms });
  }

  // 5. Posts aprovados que não saíram (erro do canal, data passada ou canal sem conexão).
  const hoje = new Date(agora - 3 * HORA).toISOString().slice(0, 10);
  for (const p of await linhas(env, "SELECT p.*, m.nome marca FROM plt_mk_posts p LEFT JOIN plt_mk_marcas m ON m.id=p.marca_id WHERE p.org_id=? AND p.status='APROVADO' AND p.data IS NOT NULL AND p.data<=? AND p.data>=? ORDER BY p.data DESC, p.hora DESC LIMIT 40", orgId, hoje, new Date(agora - 30 * DIA).toISOString().slice(0, 10))) {
    const quando = Date.parse(`${p.data}T${p.hora || "00:00"}:00-03:00`);
    let feito = {};
    try { feito = JSON.parse(p.publicacao || "{}") || {}; } catch { feito = {}; }
    const nome = cortar(p.titulo || p.legenda || "sem título", 60);
    const dia = p.data.split("-").reverse().slice(0, 2).join("/") + (p.hora ? " às " + p.hora : "");
    const erros = Object.entries(feito).filter(([c, v]) => NOME_CANAL[c] && v && v.erro);
    if (erros.length) {
      for (const [c, v] of erros) add({ chave: `post:${p.id}:${c}:${v.em || ""}`, area: "PUBLICACOES", titulo: `Post "${nome}" não foi publicado no ${NOME_CANAL[c]}`, motivo: motivoPost(v.erro), detalhe: "Resposta do " + NOME_CANAL[c] + ": " + cortar(v.erro, 240), dica: "Abra o post no Calendário de posts, corrija e use Publicar agora.", link: "#/calendario", gravidade: "ALTA", ms: Number(v.em) || p.atualizado_ms });
    } else if (feito.aviso) {
      add({ chave: `post:${p.id}:aviso`, area: "PUBLICACOES", titulo: `Post "${nome}" (${dia}) não saiu`, motivo: feito.aviso, dica: "Ajuste a data do post ou use Publicar agora.", link: "#/calendario", gravidade: "MEDIA", ms: p.atualizado_ms });
    } else if (Number.isFinite(quando) && agora - quando > 30 * 60000) {
      add({ chave: `post:${p.id}:atraso:${p.data}${p.hora || ""}`, area: "PUBLICACOES", titulo: `Post "${nome}" estava marcado para ${dia} e não saiu`, motivo: p.marca ? `A marca ${p.marca} não está conectada a todos os canais deste post, ou a publicação ainda não foi tentada.` : "A marca do post não está conectada ao canal.", dica: "Confira em Marcas → Conectar e depois use Publicar agora no post.", link: "#/calendario", gravidade: "MEDIA", ms: quando });
    }
  }

  // 6. Avaliações do Google que precisam de uma pessoa (a DENIA não deve responder sozinha).
  for (const a of await linhas(env, "SELECT a.id, a.autor, a.nota, a.texto, a.analise, a.criado_ms, m.nome marca FROM plt_mk_avaliacoes a LEFT JOIN plt_mk_marcas m ON m.id=a.marca_id WHERE a.org_id=? AND a.status='PENDENTE' AND a.removida_ms IS NULL AND (a.nota<=2 OR a.analise IS NOT NULL) ORDER BY a.id DESC LIMIT 60", orgId)) {
    let an = null;
    try { an = JSON.parse(a.analise || "null"); } catch { an = null; }
    const precisa = (an && (an.precisa_humano || an.viola_politica || an.urgencia === "ALTA")) || Number(a.nota) <= 2;
    if (!precisa) continue;
    add({ chave: `aval:${a.id}`, area: "CLIENTES", titulo: `Avaliação ${a.nota || "?"}★ de ${a.autor || "um cliente"} no Google sem resposta${a.marca ? " (" + a.marca + ")" : ""}`, motivo: an?.viola_politica ? "Pode violar as regras do Google: dá para pedir a remoção." : an?.motivo || an?.resumo || (Number(a.nota) <= 2 ? "Avaliação negativa: precisa de uma resposta pensada por uma pessoa." : "A DENIA achou melhor uma pessoa responder."), detalhe: a.texto ? '"' + cortar(a.texto, 240) + '"' : "", dica: "Abra Google → Avaliações para ver a resposta sugerida e publicar.", link: "#/google/avaliacoes", gravidade: Number(a.nota) <= 2 ? "ALTA" : "MEDIA", ms: a.criado_ms });
  }

  // 7. Locação por temporada: calendários que não atualizaram e avaliações ruins de hóspedes.
  for (const c of await linhas(env, "SELECT c.id, c.canal, c.erro, c.ultimo_ms, i.nome FROM plt_tp_calendarios c LEFT JOIN plt_tp_imoveis i ON i.id=c.imovel_id WHERE c.org_id=? AND c.erro IS NOT NULL AND TRIM(c.erro)<>'' LIMIT 30", orgId))
    add({ chave: `ical:${c.id}:${cortar(c.erro, 40)}`, area: "TEMPORADA", titulo: `Calendário do ${CANAL_TP[c.canal] || c.canal} de ${c.nome || "um imóvel"} não atualizou`, motivo: cortar(c.erro, 300), dica: "Confira o link do calendário (iCal) em Locação por temporada → Imóveis. Sem ele, as reservas novas não bloqueiam as datas.", link: "#/temporada/imoveis", gravidade: "ALTA", ms: c.ultimo_ms || agora });
  for (const a of await linhas(env, "SELECT a.id, a.autor, a.nota, a.nota_max, a.texto, a.canal, a.criado_ms, i.nome FROM plt_tp_avaliacoes a LEFT JOIN plt_tp_imoveis i ON i.id=a.imovel_id WHERE a.org_id=? AND a.status='PENDENTE' AND a.nota IS NOT NULL AND a.nota*1.0/COALESCE(NULLIF(a.nota_max,0),5) <= 0.6 ORDER BY a.id DESC LIMIT 20", orgId))
    add({ chave: `tpaval:${a.id}`, area: "CLIENTES", titulo: `Avaliação ruim de ${a.autor || "um hóspede"} no ${CANAL_TP[a.canal] || a.canal || "canal"}${a.nome ? " (" + a.nome + ")" : ""}`, motivo: `Nota ${a.nota}${a.nota_max ? " de " + a.nota_max : ""}, ainda sem resposta.`, detalhe: a.texto ? '"' + cortar(a.texto, 240) + '"' : "", dica: "Abra Locação por temporada → Avaliações dos hóspedes para responder.", link: "#/temporada/avaliacoes", gravidade: "MEDIA", ms: a.criado_ms });

  // 8. Mensagens do WhatsApp recusadas por assinatura (chave secreta do app diferente).
  const assin = await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind("zap_assinatura_falhou_" + orgId).first().catch(() => null);
  const assinMs = Number(assin?.valor || 0);
  if (assinMs && agora - assinMs < 2 * DIA)
    add({ chave: `assinatura:${Math.floor(assinMs / DIA)}`, area: "WHATSAPP", titulo: "Mensagens dos clientes estão sendo recusadas", motivo: "A assinatura das mensagens que a Meta envia não confere com a Chave secreta do app salva na DENIA. Por segurança, o robô não responde essas mensagens.", dica: "Em Conectar número, cole a Chave secreta do app (Meta for Developers → Configurações do app → Básico).", link: "#/chatbot/conexao", gravidade: "ALTA", ms: assinMs });

  return itens.sort((a, b) => (b.ms || 0) - (a.ms || 0));
}

function motivoPost(erro) {
  const s = String(erro || "");
  if (/exige uma imagem/i.test(s)) return "O Instagram só publica com imagem: o post está sem arte.";
  if (/token|session|expired|OAuth|190|invalid_grant|unauthorized|401/i.test(s)) return "O acesso ao canal expirou ou foi desconectado.";
  if (/permission|permiss|\b(10|200)\b/i.test(s)) return "A DENIA perdeu a permissão para publicar nesse canal.";
  if (/aspect ratio|proporç|image.*(size|format)|9004|2207026/i.test(s)) return "A imagem não foi aceita (tamanho ou proporção fora do permitido).";
  if (/rate|limit|too many|4\b|17\b|32\b/i.test(s)) return "O canal limitou as publicações por excesso de chamadas.";
  return cortar(s, 300) || "O canal não informou o motivo.";
}

// Só o que não foi marcado como resolvido.
export async function problemasAbertos(env, orgId, agora = agoraDe(env)) {
  const [todos, vistos] = await Promise.all([listarProblemas(env, orgId, agora), linhas(env, "SELECT chave FROM plt_problemas_vistos WHERE org_id=?", orgId)]);
  const ocultos = new Set(vistos.map(v => v.chave));
  return todos.filter(p => !ocultos.has(p.chave));
}

export async function rotasProblemas(request, env, orgId, papel, resto, podeAgir) {
  const metodo = request.method;
  const agora = agoraDe(env);
  if (resto === "problemas" && metodo === "GET") {
    const abertos = await problemasAbertos(env, orgId, agora);
    const url = new URL(request.url);
    if (url.searchParams.get("contar") === "1") return Response.json({ total: abertos.length, altos: abertos.filter(p => p.gravidade === "ALTA").length });
    return Response.json({ problemas: abertos, total: abertos.length });
  }
  if (resto === "problemas/resolver" && metodo === "POST") {
    if (!podeAgir) return Response.json({ erro: "Seu perfil só pode ver os problemas." }, { status: 403 });
    const corpo = await request.json().catch(() => ({}));
    const chaves = (Array.isArray(corpo.chaves) ? corpo.chaves : [corpo.chave]).map(c => cortar(c, 200)).filter(Boolean).slice(0, 200);
    if (!chaves.length) return Response.json({ erro: "Diga qual problema foi resolvido." }, { status: 400 });
    // Os registrados só saem quando resolvidos (e voltam se acontecerem de novo); os outros ficam escondidos pela chave.
    const vistos = chaves.filter(c => !c.startsWith("reg:"));
    if (vistos.length) await env.DB.batch(vistos.map(c => env.DB.prepare("INSERT OR REPLACE INTO plt_problemas_vistos(org_id,chave,ms) VALUES(?,?,?)").bind(orgId, c, agora)));
    const reg = chaves.filter(c => c.startsWith("reg:")).map(c => c.slice(4).replace(/:\d+$/, ""));
    if (reg.length) await env.DB.batch(reg.map(c => env.DB.prepare("UPDATE plt_problemas SET resolvido_ms=? WHERE org_id=? AND chave=? AND resolvido_ms IS NULL").bind(agora, orgId, c)));
    return Response.json({ ok: true, resolvidos: chaves.length });
  }
  return null;
}

// Limpeza diária: marcas de "resolvido" com mais de 45 dias já não servem (os itens saíram da janela).
export async function limparProblemas(env, agora = agoraDe(env)) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM plt_problemas_vistos WHERE ms < ?").bind(agora - 45 * DIA),
    env.DB.prepare("DELETE FROM plt_problemas WHERE ultimo_ms < ?").bind(agora - 60 * DIA)
  ]).catch(() => { });
}
