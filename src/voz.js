// DENIA Platform — Voz da DENIA.
// Duas formas: as vozes naturais da OpenAI (escolhidas e com o jeito de falar descrito pela empresa) ou a
// VOZ DA PRÓPRIA PESSOA, clonada na ElevenLabs a partir de uma gravação de 1 a 3 minutos feita no painel
// (com a confirmação de que a voz é dela ou de quem autorizou). A chave da ElevenLabs fica cifrada.

import { registrarUso, orgDoUso } from "./uso.js";

const ELEVEN = "https://api.elevenlabs.io/v1";
// Vozes da OpenAI que funcionam também na conversa ao vivo. marin e cedar são as mais naturais.
export const VOZES_OPENAI = [
  ["marin", "Marin — feminina, natural e calorosa (recomendada)"], ["cedar", "Cedar — masculina, natural e calma (recomendada)"],
  ["coral", "Coral — feminina, alegre"], ["sage", "Sage — feminina, serena"], ["shimmer", "Shimmer — feminina, suave"],
  ["ballad", "Ballad — masculina, expressiva"], ["ash", "Ash — masculina, firme"], ["verse", "Verse — masculina, versátil"],
  ["echo", "Echo — masculina, clara"], ["alloy", "Alloy — neutra"]
];
const ESTILO_PADRAO = "Fale como uma pessoa de verdade da equipe: calorosa, segura e simpática, com ritmo natural de conversa, pausas curtas e entonação viva. Nada de tom de locutor ou de robô.";
const PRECO_ELEVEN_POR_CARACTERE = 0.0003; // estimativa (plano Creator); ajuste fino na fatura da ElevenLabs

export async function configVoz(env, k, orgId) {
  const r = await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind("voz_org_" + orgId).first().catch(() => null);
  let c = {};
  try { c = JSON.parse(r?.valor || "{}") || {}; } catch { c = {}; }
  return {
    provedor: c.provedor === "elevenlabs" && c.eleven_voice_id && c.eleven_chave ? "elevenlabs" : "openai",
    voz_openai: VOZES_OPENAI.some(v => v[0] === c.voz_openai) ? c.voz_openai : String(env.OPENAI_REALTIME_VOZ || "marin"),
    estilo: String(c.estilo || "").slice(0, 600),
    ao_vivo_com_minha_voz: c.ao_vivo_com_minha_voz !== false,
    eleven_voice_id: c.eleven_voice_id || null, eleven_nome: c.eleven_nome || null,
    eleven_chave: c.eleven_chave || null, // cifrada
    estabilidade: Number.isFinite(Number(c.estabilidade)) ? Math.min(1, Math.max(0, Number(c.estabilidade))) : 0.45,
    semelhanca: Number.isFinite(Number(c.semelhanca)) ? Math.min(1, Math.max(0, Number(c.semelhanca))) : 0.85
  };
}
async function salvar(env, orgId, c) {
  await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind("voz_org_" + orgId, JSON.stringify(c)).run();
}
function publico(c) { const { eleven_chave, ...resto } = c; return { ...resto, eleven_configurada: Boolean(eleven_chave), vozes_openai: VOZES_OPENAI, estilo_padrao: ESTILO_PADRAO }; }

async function eleven(env, k, cfg, metodo, caminho, corpo, extra = {}) {
  const chave = cfg.eleven_chave ? await k.decifrar(env, cfg.eleven_chave) : extra.chave;
  if (!chave) throw new Error("Cole primeiro a chave da ElevenLabs.");
  const r = await fetch(ELEVEN + caminho, {
    method: metodo, signal: AbortSignal.timeout(extra.timeout || 60000),
    headers: { "xi-api-key": chave, ...(corpo && !(corpo instanceof FormData) ? { "content-type": "application/json" } : {}) },
    body: corpo ? (corpo instanceof FormData ? corpo : JSON.stringify(corpo)) : undefined
  });
  if (extra.binario && r.ok) return r;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = String(d?.detail?.message || d?.detail || d?.message || `HTTP ${r.status}`).slice(0, 300);
    throw new Error(r.status === 401 ? "A ElevenLabs recusou a chave. Crie uma em elevenlabs.io → Configurações → Chaves de API." : /voice_limit|quota|subscription|plan/i.test(msg) ? "A conta da ElevenLabs não permite isso no plano atual (a clonagem de voz precisa do plano Starter ou acima): " + msg : "ElevenLabs: " + msg);
  }
  return d;
}

// Fala o texto com a voz configurada. Devolve uma Response de áudio (mp3).
export async function falarComVoz(env, k, orgId, texto, { idiomaNome = "português do Brasil", aoVivo = false, openai } = {}) {
  const cfg = await configVoz(env, k, orgId);
  if (cfg.provedor === "elevenlabs") {
    try {
      const r = await eleven(env, k, cfg, "POST", `/text-to-speech/${encodeURIComponent(cfg.eleven_voice_id)}?output_format=mp3_44100_128`, {
        text: texto, model_id: aoVivo ? "eleven_flash_v2_5" : "eleven_multilingual_v2",
        voice_settings: { stability: cfg.estabilidade, similarity_boost: cfg.semelhanca, style: 0.25, use_speaker_boost: true }
      }, { binario: true, timeout: 45000 });
      registrarUso(orgDoUso(env) || orgId, "elevenlabs", "voz_falada", aoVivo ? "eleven_flash_v2_5" : "eleven_multilingual_v2", { caracteres: texto.length, custo_usd: texto.length * PRECO_ELEVEN_POR_CARACTERE }, "assistente/voz");
      return r;
    } catch (e) { console.error("ElevenLabs", e?.message); /* cai para a voz natural da OpenAI */ }
  }
  return openai(env, "audio/speech", { model: String(env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"), voice: cfg.voz_openai, input: texto, response_format: "mp3",
    instructions: `Fale em ${idiomaNome}. ${cfg.estilo || ESTILO_PADRAO}` }, { binario: true, timeout: 45000 });
}

export async function rotasVoz(request, env, k, orgId, papel, resto) {
  if (!resto.startsWith("voz/")) return null;
  const { json, pode, lerCorpo, auditar, sessao } = k;
  const metodo = request.method;
  const cfg = await configVoz(env, k, orgId);
  if (resto === "voz/config" && metodo === "GET") return json(publico(cfg));
  if (!pode(papel, "ADMIN")) return json({ erro: "Somente administradores mudam a voz da DENIA." }, 403);
  if (resto === "voz/config" && metodo === "POST") {
    const { corpo, erro } = await lerCorpo(request, 4000);
    if (erro) return erro;
    const novo = { ...cfg };
    if (VOZES_OPENAI.some(v => v[0] === corpo.voz_openai)) novo.voz_openai = corpo.voz_openai;
    if (typeof corpo.estilo === "string") novo.estilo = corpo.estilo.slice(0, 600);
    if (["openai", "elevenlabs"].includes(corpo.provedor)) novo.provedor = corpo.provedor === "elevenlabs" && !(cfg.eleven_voice_id && cfg.eleven_chave) ? "openai" : corpo.provedor;
    if (typeof corpo.ao_vivo_com_minha_voz === "boolean") novo.ao_vivo_com_minha_voz = corpo.ao_vivo_com_minha_voz;
    if (corpo.estabilidade != null) novo.estabilidade = Math.min(1, Math.max(0, Number(corpo.estabilidade) || 0.45));
    if (corpo.semelhanca != null) novo.semelhanca = Math.min(1, Math.max(0, Number(corpo.semelhanca) || 0.85));
    if (corpo.voz_eleven && /^[A-Za-z0-9]{10,40}$/.test(String(corpo.voz_eleven.id || ""))) { novo.eleven_voice_id = corpo.voz_eleven.id; novo.eleven_nome = String(corpo.voz_eleven.nome || "").slice(0, 80); novo.provedor = "elevenlabs"; }
    await salvar(env, orgId, novo);
    return json({ ok: true, ...publico(await configVoz(env, k, orgId)) });
  }
  if (resto === "voz/eleven-chave" && metodo === "POST") {
    const { corpo, erro } = await lerCorpo(request, 1000);
    if (erro) return erro;
    if (corpo.remover) { await salvar(env, orgId, { ...cfg, eleven_chave: null, eleven_voice_id: null, eleven_nome: null, provedor: "openai" }); return json({ ok: true }); }
    const chave = String(corpo.chave || "").trim();
    if (!/^(sk_)?[A-Za-z0-9]{20,80}$/.test(chave)) return json({ erro: "Essa não parece uma chave da ElevenLabs (elevenlabs.io → Configurações → Chaves de API)." }, 400);
    try { await eleven(env, k, { eleven_chave: null }, "GET", "/user", null, { chave, timeout: 15000 }); }
    catch (e) { return json({ erro: e.message }, 400); }
    await salvar(env, orgId, { ...cfg, eleven_chave: await k.cifrar(env, chave) });
    await auditar(env, request, sessao, orgId, "INTEGRACAO", "Chave da ElevenLabs salva (voz da DENIA)");
    return json({ ok: true });
  }
  if (resto === "voz/eleven-vozes" && metodo === "GET") {
    try { const d = await eleven(env, k, cfg, "GET", "/voices", null, { timeout: 20000 }); return json({ vozes: (d.voices || []).map(v => ({ id: v.voice_id, nome: v.name, categoria: v.category, previa: v.preview_url || null })) }); }
    catch (e) { return json({ erro: e.message }, 400); }
  }
  // Gravação feita no painel (ou arquivo de áudio): cria a voz clonada e já passa a usar.
  if (resto === "voz/clonar" && metodo === "POST") {
    let form;
    try { form = await request.formData(); } catch { return json({ erro: "Envie a gravação da voz." }, 400); }
    if (form.get("consentimento") !== "sim") return json({ erro: "Confirme que a voz é sua ou que a pessoa autorizou por escrito." }, 400);
    const arquivos = form.getAll("audio").filter(f => f && typeof f === "object" && f.size);
    const total = arquivos.reduce((s, f) => s + f.size, 0);
    if (!arquivos.length || total < 60000) return json({ erro: "A gravação está curta demais. Grave pelo menos 1 minuto, falando naturalmente." }, 400);
    if (total > 25 * 1024 * 1024) return json({ erro: "A gravação passou de 25 MB. Grave até 3 minutos." }, 400);
    const nome = String(form.get("nome") || "Voz da DENIA").slice(0, 60);
    const envio = new FormData();
    envio.append("name", nome);
    envio.append("description", "Voz da DENIA (clonada com autorização da pessoa, pela plataforma DENIA)");
    envio.append("remove_background_noise", "true");
    arquivos.slice(0, 5).forEach((f, i) => envio.append("files", f, f.name || `gravacao-${i + 1}.webm`));
    try {
      const d = await eleven(env, k, cfg, "POST", "/voices/add", envio, { timeout: 90000 });
      if (!d.voice_id) throw new Error("A ElevenLabs não devolveu a voz criada.");
      await salvar(env, orgId, { ...cfg, eleven_voice_id: d.voice_id, eleven_nome: nome, provedor: "elevenlabs" });
      await auditar(env, request, sessao, orgId, "INTEGRACAO", `Voz clonada para a DENIA: ${nome} (com confirmação de autorização)`);
      return json({ ok: true, voz: { id: d.voice_id, nome }, verificar: Boolean(d.requires_verification) });
    } catch (e) { return json({ erro: e.message }, 400); }
  }
  return null;
}
