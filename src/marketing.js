import { rotasMeta, aoAprovar } from "./meta.js";
import { rotasGoogle, responderAvaliacaoGoogle, contaGoogleDe, desempenhoAoVivo, sincronizarConta } from "./google.js";
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
  for (const alter of ["ALTER TABLE plt_mk_marcas ADD COLUMN idioma TEXT", "ALTER TABLE plt_mk_marcas ADD COLUMN horarios TEXT", "ALTER TABLE plt_mk_marcas ADD COLUMN logo_midia_id INTEGER", "ALTER TABLE plt_mk_posts ADD COLUMN texto_arte TEXT", "ALTER TABLE plt_mk_marcas ADD COLUMN ofertas TEXT", "ALTER TABLE plt_mk_avaliacoes ADD COLUMN analise TEXT", "ALTER TABLE plt_mk_config ADD COLUMN avaliacoes_auto TEXT", "ALTER TABLE plt_mk_avaliacoes ADD COLUMN google_id TEXT"])
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
async function openai(env, caminho, corpo, extras = {}) {
  const r = await fetch("https://api.openai.com/v1/" + caminho, {
    method: "POST",
    headers: { authorization: `Bearer ${chave(env)}`, ...(corpo instanceof FormData ? {} : { "content-type": "application/json" }) },
    body: corpo instanceof FormData ? corpo : JSON.stringify(corpo),
    signal: AbortSignal.timeout(extras.timeout || 60000)
  });
  if (extras.binario) {
    if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}`);
    return r;
  }
  const d = await r.json().catch(() => ({}));
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
const MODOS_AVALIACAO = ["DESLIGADO", "BOAS", "TODAS"];
// Pode sair sem uma pessoa? Nunca as graves, as que pedem uma pessoa, as suspeitas de violar regras ou as urgentes.
function podeResponderSozinha(modo, a, analise) {
  if (!a.google_id || !analise || modo === "DESLIGADO" || !MODOS_AVALIACAO.includes(modo)) return false;
  if (analise.precisa_humano || analise.viola_politica || analise.sentimento === "GRAVE" || analise.urgencia === "ALTA") return false;
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
  const daMeta = await rotasMeta(request, env, k, orgId, papel, resto);
  if (daMeta) return daMeta;
  // "Buscar avaliações agora": traz do Google, lê e (no automático) responde na hora — sem esperar a rodada de 10 minutos.
  if (resto === "google/agora" && request.method === "POST") {
    if (!pode(papel, "AGENTE")) return json({ erro: "Seu perfil não tem permissão para esta ação." }, 403);
    const { corpo, erro } = await lerCorpo(request, 1000);
    if (erro) return erro;
    const conta = await contaGoogleDe(env, orgId, Number(corpo.marca_id));
    if (!conta) return json({ erro: "Esta marca ainda não está conectada ao Google (Marcas → Conectar Google)." }, 409);
    let sinc;
    try { sinc = await sincronizarConta(env, k, conta, { forcarDesempenho: false }); }
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
      let sql = "SELECT * FROM plt_mk_posts WHERE org_id=? AND (data IS NULL OR (data>=? AND data<=?))";
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
        return json({ ok: true, id: Number(c.id) });
      }
      const n = await env.DB.prepare(`INSERT INTO plt_mk_posts(org_id,marca_id,canais,formato,data,hora,titulo,legenda,hashtags,chamada,ideia_imagem,texto_arte,status,criado_por,criado_ms,atualizado_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'RASCUNHO',?,?,?) RETURNING id`).bind(orgId, marca.id, v.canais, v.formato, v.data, v.hora, v.titulo, v.legenda, v.hashtags, v.chamada, v.ideia_imagem, v.texto_arte || null, autor, agora(env), agora(env)).first();
      // Imagem criada antes, fora de um post (Criar imagem com IA): passa a ser a arte do novo post.
      if (c.midia_id) {
        const md = await env.DB.prepare("SELECT id FROM plt_mk_midias WHERE id=? AND org_id=?").bind(Number(c.midia_id), orgId).first();
        if (md) await env.DB.prepare("UPDATE plt_mk_posts SET midia_id=? WHERE id=?").bind(md.id, n.id).run();
      }
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
        await env.DB.batch([env.DB.prepare("DELETE FROM plt_mk_posts WHERE id=?").bind(p.id), env.DB.prepare("DELETE FROM plt_mk_midias WHERE id=? AND org_id=?").bind(p.midia_id || 0, orgId)]);
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
    if ((m = resto.match(/^midias\/(\d{1,12})$/)) && metodo === "GET") {
      const r = await env.DB.prepare("SELECT mime, dados FROM plt_mk_midias WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).first();
      if (!r) return new Response("Não encontrado.", { status: 404 });
      const bin = Uint8Array.from(atob(r.dados), ch => ch.charCodeAt(0));
      return new Response(bin, { headers: { "content-type": r.mime, "cache-control": "private, max-age=86400" } });
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
        const md = await env.DB.prepare("INSERT INTO plt_mk_midias(org_id,mime,dados,prompt,criado_ms) VALUES(?,?,?,?,?) RETURNING id").bind(orgId, "image/jpeg", b64, prompt.slice(0, 2000), agora(env)).first();
        if (p) {
          await env.DB.prepare("UPDATE plt_mk_posts SET midia_id=?, atualizado_ms=? WHERE id=?").bind(md.id, agora(env), p.id).run();
          if (p.midia_id) await env.DB.prepare("DELETE FROM plt_mk_midias WHERE id=? AND org_id=?").bind(p.midia_id, orgId).run();
        }
        return json({ ok: true, midia_id: md.id, conferencia: arte.conferencia });
      }
    }

    // ----- Google Meu Negócio: avaliações
    if (resto === "avaliacoes" && metodo === "GET") {
      const marca = Number(new URL(request.url).searchParams.get("marca") || 0);
      const r = await env.DB.prepare(`SELECT * FROM plt_mk_avaliacoes WHERE org_id=? ${marca ? "AND marca_id=?" : ""} ORDER BY status='RESPONDIDA', id DESC LIMIT 300`).bind(...(marca ? [orgId, marca] : [orgId])).all();
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
      return json({ palavras: palavras.map(p => ({ ...p, posicoes: pos.filter(x => x.palavra_id === p.id) })) });
    }
    if (resto === "palavras" && metodo === "POST") {
      exigir("AGENTE");
      const c = await corpoOu(2000);
      const marca = await marcaDa(c.marca_id);
      if (!marca) return json({ erro: "Escolha a marca." }, 400);
      const palavra = txt(c.palavra, 120);
      if (palavra.length < 2) return json({ erro: "Informe a palavra-chave." }, 400);
      const n = await env.DB.prepare("INSERT INTO plt_mk_palavras(org_id,marca_id,palavra,cidade,criado_ms) VALUES(?,?,?,?,?) RETURNING id").bind(orgId, marca.id, palavra, txt(c.cidade, 120) || marca.cidade || null, agora(env)).first();
      return json({ ok: true, id: n.id });
    }
    if ((m = resto.match(/^palavras\/(\d{1,12})\/(posicao|remover)$/)) && metodo === "POST") {
      exigir("AGENTE");
      const p = await env.DB.prepare("SELECT * FROM plt_mk_palavras WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).first();
      if (!p) return json({ erro: "Palavra-chave não encontrada." }, 404);
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
  if (!m && obrigatoria) throw new Error(marcasOrg.length ? `Não encontrei a marca "${nome || ""}". Diga qual: ${marcasOrg.map(x => x.nome).join(", ")}.` : "Cadastre uma marca primeiro, em Marketing → Marcas.");
  return m;
}
const TIPOS_ACAO = ["criar_semana", "criar_post", "aprovar_posts", "publicar_post", "treinar", "pausar_ia", "google_resumo", "atualizar_google", "responder_avaliacoes", "relatorio_google"];
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
  return p;
}

// Executa uma ação pedida por voz usando as rotas normais do painel (com as mesmas permissões e auditoria).
async function executarAcao(a, { marcasOrg, contexto, txt }) {
  const tipo = String(a?.tipo || "");
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
      if (!d.conectada) partes.push("O perfil do Google desta marca ainda não está conectado (Marcas → Conectar Google).");
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
      const r = await openai(env, "audio/speech", { model: String(env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"), voice: String(env.OPENAI_TTS_VOZ || "coral"), input: texto, response_format: "mp3",
        instructions: `Fale em ${IDIOMAS[idioma]}, com voz feminina calorosa, segura e profissional, ritmo natural.` }, { binario: true, timeout: 45000 });
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
Você também EXECUTA ações quando a pessoa pede claramente. Ações disponíveis (campo "acoes"):
- {"tipo":"criar_semana","marca":"nome da marca","canais":["instagram","facebook","google"],"quantidade":3,"semana":"esta"|"proxima","com_artes":true} — planeja e cria os posts da semana (legendas, hashtags e as imagens).
- {"tipo":"criar_post","marca":"nome","canais":["instagram"],"tema":"sobre o que é","formato":"post"|"carrossel"|"story"|"reels","data":"AAAA-MM-DD","hora":"HH:MM","com_arte":true} — cria um post com texto e imagem.
- {"tipo":"aprovar_posts","marca":"nome ou vazio para todas"} — aprova os posts que aguardam aprovação (perfil ADMIN ou OWNER).
- {"tipo":"publicar_post","post_id":123} — aprova e publica agora no Instagram e no Facebook, se a marca estiver conectada (Marcas → Conectar Instagram e Facebook). Se não estiver, explique que o post fica aprovado e que basta conectar a marca. No Google Meu Negócio é igual: com a marca conectada (Marcas → Conectar Google) os posts saem no perfil e as respostas às avaliações são publicadas direto no Google.
- {"tipo":"treinar","campo":"instrucoes"|"servicos"|"regras"|"precos"|"procedimentos"|"informacoes"|"exemplos","modo":"acrescentar"|"substituir","texto":"o texto do treinamento, bem escrito, na voz de instrução para a IA do WhatsApp"} — muda o treinamento da IA que atende os clientes no WhatsApp (perfil ADMIN ou OWNER). Prefira "acrescentar". Use "substituir" só se a pessoa pedir para trocar tudo daquele campo; nesse caso o texto deve ser o campo completo, já reescrito. Cada mudança vira uma nova versão (dá para voltar).
- {"tipo":"pausar_ia","pausar":true|false} — pausa ou retoma a IA do WhatsApp para todos os clientes (perfil ADMIN ou OWNER).
- {"tipo":"google_resumo","marca":"nome"} — lê o Google Meu Negócio da marca: nota, avaliações sem resposta, as que precisam de uma pessoa, desempenho dos últimos 30 dias, buscas e o último relatório. Use para responder perguntas sobre o Google com dados reais.
- {"tipo":"atualizar_google","marca":"nome"} — busca agora as avaliações e o desempenho no Google.
- {"tipo":"responder_avaliacoes","marca":"nome","publicar":false} — escreve uma resposta específica para cada avaliação sem resposta. publicar=true só quando a pessoa pedir claramente para publicar; as avaliações graves ou que podem violar as regras do Google nunca são publicadas sozinhas — avise quais precisam de uma pessoa e o motivo.
- {"tipo":"relatorio_google","marca":"nome"} — gera agora o relatório de especialista da marca (o que melhorou, o que precisa de atenção, buscas e plano da semana).
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
Para assuntos de fora (notícias, concorrentes, tendências, preços de mercado, qualquer dúvida do mundo), use a ferramenta pesquisar_web e conte o resultado de forma curta, citando de onde veio.
Quando a pessoa pedir claramente uma ação, use a ferramenta certa (criar_semana, criar_post, aprovar_posts, publicar_post, treinar, pausar_ia, google_resumo, atualizar_google, responder_avaliacoes, relatorio_google). Para perguntas sobre o Google de uma marca (avaliações, nota, ligações, buscas, posição), use google_resumo antes de responder. Antes, diga numa frase curta o que vai fazer ("Vou abrir o treinamento e acrescentar isso"); a pessoa vê você fazendo na tela e pode pausar ou parar. Quando a ferramenta devolver o resultado, conte em uma frase. Se faltar algo essencial (por exemplo qual marca, havendo mais de uma), pergunte antes.
Treinamento: prefira acrescentar; substituir só se pedirem para trocar tudo daquele campo (aí o texto é o campo inteiro já reescrito). Escreva o texto do treinamento como instrução clara para a IA que atende os clientes no WhatsApp.
Publicar: com a marca conectada (Marcas → Conectar Instagram e Facebook), os posts aprovados saem sozinhos no horário marcado e publicar_post publica na hora. Sem conexão, o post fica aprovado. No Google Meu Negócio é igual: com a marca conectada (Marcas → Conectar Google) os posts saem no perfil e as respostas às avaliações são publicadas direto no Google. Diga isso com honestidade.
Marcas existentes: ${marcasOrg.map(m => m.nome).join(", ") || "nenhuma cadastrada"}.
DADOS DO PAINEL (no início da conversa):
${contexto.dados}`;
      const marca = { type: "string", description: "Nome da marca" };
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
        { type: "function", name: "dados_do_painel", description: "Busca os dados mais recentes do painel (conversas, atendimentos, posts, treinamento).", parameters: { type: "object", properties: {} } }
      ];
      const voz = String(env.OPENAI_REALTIME_VOZ || "marin");
      const sessao = { type: "realtime", model: modelo, instructions, tools, tool_choice: "auto",
        audio: { input: { transcription: { model: String(env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe"), language: idioma.slice(0, 2) }, turn_detection: { type: "semantic_vad", eagerness: "high" }, noise_reduction: { type: "near_field" } }, output: { voice: voz } } };
      const d = await openai(env, "realtime/client_secrets", { expires_after: { anchor: "created_at", seconds: 120 }, session: sessao }, { timeout: 20000 });
      const chaveTemp = d?.value || d?.client_secret?.value;
      if (!chaveTemp) return json({ erro: "A voz ao vivo não respondeu. Tente de novo." }, 502);
      return json({ chave: chaveTemp, url: "https://api.openai.com/v1/realtime/calls", modelo });
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
