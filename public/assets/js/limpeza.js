// DENIA — tela de quem limpa (link sem login). Pensada para quem lê pouco: ícones grandes, um cômodo por vez,
// botões em vez de escrever, leitura em voz alta (🔊) e recado por áudio (🎤) ou foto (📷).
(function () {
  "use strict";
  const app = document.getElementById("app");
  const base = app.dataset.base;
  const CHAVE = "denia_limpeza_" + base;
  let d = null, passo = 0, telas = [];
  const st = lerEstado() || { quem: "", checklist: {}, inventario: {}, estoque: {}, faltou: [], obs: "", fotos: [], audio: "" };

  function lerEstado() { try { return JSON.parse(localStorage.getItem(CHAVE) || "null"); } catch { return null; } }
  function guardar() { try { const { fotos, audio, ...leve } = st; localStorage.setItem(CHAVE, JSON.stringify(leve)); } catch { /* sem espaço */ } }
  function el(tag, at = {}, ...filhos) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(at)) {
      if (v == null || v === false) continue;
      if (k === "text") e.textContent = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? "" : v);
    }
    for (const f of filhos.flat(Infinity)) if (f != null && f !== false) e.append(f.nodeType ? f : document.createTextNode(String(f)));
    return e;
  }
  function falar(texto) {
    try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(texto); u.lang = "pt-BR"; u.rate = 0.95; speechSynthesis.speak(u); } catch { /* sem voz no aparelho */ }
  }
  const botaoOuvir = texto => el("button", { type: "button", class: "ouvir", "aria-label": "Ouvir", onclick: () => falar(texto) }, "🔊");
  const dataBR = s => String(s || "").split("-").reverse().join("/");

  async function api(caminho, corpo) {
    const r = await fetch(base + caminho, corpo ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) } : {});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erro || "Não deu certo. Tente de novo.");
    return j;
  }

  function montarTelas() {
    telas = [telaQuem, telaBriefing];
    d.comodos.forEach((c, i) => telas.push(() => telaComodo(c, i)));
    if (d.gerais.length) telas.push(telaGerais);
    if (d.estoque.length) telas.push(telaEstoque);
    telas.push(telaFim);
  }
  function mostrar() {
    window.scrollTo(0, 0);
    app.replaceChildren(...[].concat(telas[passo]()).flat(Infinity).filter(x => x != null && x !== false));
  }
  function progresso() {
    const total = telas.length;
    return el("div", { class: "progresso", "aria-label": `Passo ${passo + 1} de ${total}` }, Array.from({ length: total }, (_, i) => el("i", { class: i < passo ? "feito" : i === passo ? "atual" : "" })));
  }
  function navegacao(proximoTexto = "PRÓXIMO", aoAvancar) {
    return el("div", { class: "nav" },
      passo > 0 ? el("button", { type: "button", class: "voltar", onclick: () => { passo--; mostrar(); } }, "⬅️") : null,
      el("button", { type: "button", class: "avancar", onclick: async () => { if (aoAvancar && (await aoAvancar()) === false) return; passo++; guardar(); mostrar(); } }, proximoTexto + " ➡️"));
  }

  function telaQuem() {
    const nomes = [...new Set([...(d.equipe || []), d.responsavel].filter(Boolean))];
    const outro = el("input", { class: "grande", placeholder: "Seu nome", maxlength: "60", value: nomes.includes(st.quem) ? "" : st.quem });
    return [progresso(),
      el("h1", {}, "🏠 ", d.imovel), el("p", { class: "sub" }, `Limpeza de ${dataBR(d.data)}`),
      el("h2", {}, "👋 Quem é você? ", botaoOuvir("Quem é você? Toque no seu nome.")),
      el("div", { class: "nomes" }, nomes.map(n => el("button", { type: "button", class: "nome" + (st.quem === n ? " ativo" : ""), onclick: () => { st.quem = n; passo++; guardar(); mostrar(); } }, "🙋 " + n))),
      el("label", { class: "campo" }, nomes.length ? "Outro nome:" : "Seu nome:", outro),
      navegacao("COMEÇAR", () => { const n = outro.value.trim() || st.quem; if (!n) { falar("Toque no seu nome ou escreva."); outro.focus(); return false; } st.quem = n; })];
  }
  function telaBriefing() {
    const b = d.briefing || {};
    const linhas = [];
    if (b.proximo && b.proximo.mesmo_dia) linhas.push(el("div", { class: "alerta grande-alerta" }, "⏰ ", el("strong", {}, "Hóspede novo chega HOJE!"), b.proximo.hospedes ? ` (${b.proximo.hospedes} pessoas)` : ""));
    else if (b.proximo) linhas.push(el("div", { class: "info" }, "📅 Próximo hóspede: ", el("strong", {}, dataBR(b.proximo.inicio))));
    if ((b.levar || []).length) linhas.push(el("div", { class: "bloco" }, el("h3", {}, "🛒 LEVAR HOJE"), el("ul", { class: "lista-icones" }, b.levar.map(x => el("li", {}, el("b", {}, `${x.levar}`), ` ${x.unidade} · ${x.item}`)))));
    if ((b.faltou_ultima || []).length) linhas.push(el("div", { class: "bloco" }, el("h3", {}, "⚠️ FALTOU DA ÚLTIMA VEZ"), el("ul", { class: "lista-icones" }, b.faltou_ultima.map(x => el("li", {}, x)))));
    if ((b.quebrados || []).length) linhas.push(el("div", { class: "bloco" }, el("h3", {}, "💔 QUEBRADO OU SUMIDO"), el("ul", { class: "lista-icones" }, b.quebrados.map(x => el("li", {}, `${x.icone || "📦"} ${x.item} — ${x.comodo}`)))));
    if ((b.pendencias || []).length) linhas.push(el("div", { class: "bloco" }, el("h3", {}, "🔧 ATENÇÃO"), el("ul", { class: "lista-icones" }, b.pendencias.map(x => el("li", {}, x.texto)))));
    const fala = [b.proximo && b.proximo.mesmo_dia ? "Atenção: hóspede novo chega hoje." : "",
      (b.levar || []).length ? "Levar hoje: " + b.levar.map(x => `${x.levar} ${x.unidade} de ${x.item}`).join(", ") : "",
      (b.faltou_ultima || []).length ? "Faltou da última vez: " + b.faltou_ultima.join(", ") : "",
      (b.quebrados || []).length ? "Quebrado ou sumido: " + b.quebrados.map(x => x.item).join(", ") : ""].filter(Boolean).join(". ") || "Tudo certo. Pode começar.";
    return [progresso(), el("h1", {}, "📋 Antes de começar ", botaoOuvir(fala)), linhas.length ? linhas : el("div", { class: "info" }, "✅ Tudo certo. Pode começar!"),
      navegacao("COMEÇAR A LIMPEZA", async () => { try { await api("/comecar", { quem: st.quem }); } catch { /* sem internet: segue e manda no fim */ } })];
  }
  function telaComodo(c) {
    const feitas = c.tarefas.filter(t => st.checklist[t.id]).length;
    const contador = el("h2", {}, `✅ Tarefas (${feitas}/${c.tarefas.length})`);
    const tarefas = el("div", { class: "tarefas" }, c.tarefas.map(t => {
      const b = el("button", { type: "button", class: "tarefa" + (st.checklist[t.id] ? " ok" : ""), "aria-pressed": st.checklist[t.id] ? "true" : "false",
        onclick: () => { st.checklist[t.id] = !st.checklist[t.id]; b.classList.toggle("ok", st.checklist[t.id]); b.setAttribute("aria-pressed", st.checklist[t.id] ? "true" : "false"); guardar(); contador.textContent = `✅ Tarefas (${c.tarefas.filter(x => st.checklist[x.id]).length}/${c.tarefas.length})`; if (st.checklist[t.id]) try { navigator.vibrate && navigator.vibrate(30); } catch { /* sem vibração */ } } },
        el("span", { class: "ic" }, t.icone), el("span", { class: "tx" }, t.tarefa), el("span", { class: "marca" }, "✔"));
      return b;
    }));
    const itens = el("div", { class: "itens" }, c.itens.map(i => {
      const atual = () => st.inventario[i.id] || (i.estado === "OK" ? "OK" : i.estado);
      const linha = el("div", { class: "item-inv" });
      const desenhar = () => linha.replaceChildren(el("span", { class: "ic" }, i.icone), el("span", { class: "tx" }, i.item, i.quantidade > 1 ? el("small", {}, ` × ${i.quantidade}`) : null),
        el("div", { class: "estados" }, [["OK", "👍", "Está aqui"], ["QUEBRADO", "💔", "Quebrado"], ["SUMIU", "❓", "Sumiu"]].map(([v, ic, n]) => el("button", { type: "button", class: "estado" + (atual() === v ? " ativo e-" + v : ""), "aria-label": n, title: n, onclick: () => { st.inventario[i.id] = v; guardar(); desenhar(); if (v !== "OK") falar(n); } }, ic))));
      desenhar();
      return linha;
    }));
    const fala = `${c.nome}. ${c.tarefas.length ? "Tarefas: " + c.tarefas.map(t => t.tarefa).join(". ") + "." : ""} ${c.itens.length ? "Confira os itens: " + c.itens.map(i => i.item).join(", ") + ". Joinha se está aqui, coração partido se quebrou, interrogação se sumiu." : ""}`;
    return [progresso(), el("h1", {}, `${c.icone} ${c.nome} `, botaoOuvir(fala)),
      c.tarefas.length ? [contador, el("p", { class: "dica" }, "Toque em cada uma quando terminar."), tarefas] : null,
      c.itens.length ? [el("h2", {}, "📦 Itens deste cômodo"), el("p", { class: "dica" }, "👍 está aqui · 💔 quebrou · ❓ sumiu"), itens] : null,
      navegacao()];
  }
  function telaGerais() {
    return [progresso(), el("h1", {}, "🏁 Antes de sair ", botaoOuvir("Antes de sair: " + d.gerais.map(t => t.tarefa).join(". "))),
      el("div", { class: "tarefas" }, d.gerais.map(t => { const b = el("button", { type: "button", class: "tarefa" + (st.checklist[t.id] ? " ok" : ""), onclick: () => { st.checklist[t.id] = !st.checklist[t.id]; b.classList.toggle("ok", st.checklist[t.id]); guardar(); } }, el("span", { class: "ic" }, t.icone), el("span", { class: "tx" }, t.tarefa), el("span", { class: "marca" }, "✔")); return b; })),
      navegacao()];
  }
  function telaEstoque() {
    const linhas = d.estoque.map(e => {
      if (st.estoque[e.id] === undefined) st.estoque[e.id] = e.quantidade;
      const n = el("strong", { class: "qtd" }, String(st.estoque[e.id]));
      const mudar = delta => { st.estoque[e.id] = Math.max(0, Number(st.estoque[e.id]) + delta); n.textContent = String(st.estoque[e.id]); linha.classList.toggle("baixo", e.minimo > 0 && st.estoque[e.id] <= e.minimo); guardar(); };
      const linha = el("div", { class: "estoque-linha" + (e.minimo > 0 && st.estoque[e.id] <= e.minimo ? " baixo" : "") },
        el("span", { class: "tx" }, e.item, el("small", {}, e.unidade || "")),
        el("div", { class: "passo" }, el("button", { type: "button", class: "menos", "aria-label": "Menos", onclick: () => mudar(-1) }, "−"), n, el("button", { type: "button", class: "mais", "aria-label": "Mais", onclick: () => mudar(1) }, "+")));
      return linha;
    });
    return [progresso(), el("h1", {}, "🧴 Quanto sobrou? ", botaoOuvir("Quanto sobrou de cada coisa? Use o menos e o mais até ficar igual ao que tem no armário.")),
      el("p", { class: "dica" }, "Use − e + até ficar igual ao que tem guardado. Vermelho = precisa comprar."), el("div", { class: "estoque" }, linhas), navegacao()];
  }
  function telaFim() {
    const fotos = el("div", { class: "fotos" }, st.fotos.map((f, i) => el("img", { src: f, alt: `Foto ${i + 1}` })));
    const entradaFoto = el("input", { type: "file", accept: "image/*", capture: "environment", class: "oculto-input", onchange: async e => {
      for (const arq of [...e.target.files].slice(0, 6 - st.fotos.length)) { try { st.fotos.push(await reduzir(arq)); } catch { /* foto ilegível */ } }
      fotos.replaceChildren(...st.fotos.map((f, i) => el("img", { src: f, alt: `Foto ${i + 1}` })));
    } });
    const statusAudio = el("p", { class: "dica" }, st.audio ? "🎧 Recado gravado." : "");
    let gravador = null, partes = [];
    const btAudio = el("button", { type: "button", class: "grande-acao", onclick: async () => {
      if (gravador && gravador.state === "recording") { gravador.stop(); return; }
      try {
        const fluxo = await navigator.mediaDevices.getUserMedia({ audio: true });
        partes = []; gravador = new MediaRecorder(fluxo);
        gravador.ondataavailable = ev => partes.push(ev.data);
        gravador.onstop = () => { fluxo.getTracks().forEach(t => t.stop()); const blob = new Blob(partes, { type: gravador.mimeType || "audio/webm" }); const fr = new FileReader(); fr.onload = () => { st.audio = fr.result; statusAudio.textContent = "🎧 Recado gravado. Pode gravar de novo se quiser."; }; fr.readAsDataURL(blob); btAudio.textContent = "🎤 Gravar recado"; btAudio.classList.remove("gravando"); };
        gravador.start(); btAudio.textContent = "⏹️ Parar"; btAudio.classList.add("gravando"); setTimeout(() => { if (gravador && gravador.state === "recording") gravador.stop(); }, 120000);
      } catch { statusAudio.textContent = "Não consegui usar o microfone. Escreva abaixo ou mande foto."; }
    } }, "🎤 Gravar recado");
    const obs = el("textarea", { class: "grande", placeholder: "Se quiser, escreva aqui (opcional)", maxlength: "1500" }, st.obs || "");
    const enviar = el("button", { type: "button", class: "avancar terminar", onclick: async () => {
      enviar.disabled = true; enviar.textContent = "Enviando…";
      st.obs = obs.value;
      try {
        const r = await api("/enviar", st);
        try { localStorage.removeItem(CHAVE); } catch { /* ok */ }
        app.replaceChildren(...[el("h1", {}, "🎉 Obrigado, ", st.quem.split(" ")[0], "!"), el("p", { class: "info" }, "A limpeza foi registrada."),
          (r.baixos || []).length ? el("div", { class: "bloco" }, el("h3", {}, "🛒 Precisa comprar"), el("ul", { class: "lista-icones" }, r.baixos.map(b => el("li", {}, `${b.item} (${b.quantidade} ${b.unidade || ""})`)))) : null,
          (r.problemas || []).length ? el("div", { class: "bloco" }, el("h3", {}, "💔 Avisamos o anfitrião"), el("ul", { class: "lista-icones" }, r.problemas.map(p => el("li", {}, p)))) : null].filter(Boolean));
        falar("Obrigado! A limpeza foi registrada.");
      } catch (e) { enviar.disabled = false; enviar.textContent = "✅ TERMINEI"; alert(e.message); }
    } }, "✅ TERMINEI");
    return [progresso(), el("h1", {}, "🏁 Quase lá! ", botaoOuvir("Quase lá. Se algo estiver errado, grave um recado ou tire uma foto. Depois toque em terminei.")),
      el("h2", {}, "Algo errado ou faltando?"),
      el("div", { class: "acoes-fim" }, btAudio, el("label", { class: "grande-acao" }, "📷 Tirar foto", entradaFoto)), statusAudio, fotos, obs, enviar,
      el("button", { type: "button", class: "voltar voltar-texto", onclick: () => { passo--; mostrar(); } }, "⬅️ Voltar")];
  }
  function reduzir(arq, max = 1280) {
    return new Promise((ok, erro) => { const img = new Image(), u = URL.createObjectURL(arq); img.onload = () => { const e = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement("canvas"); c.width = Math.round(img.width * e); c.height = Math.round(img.height * e); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(u); ok(c.toDataURL("image/jpeg", 0.8)); }; img.onerror = () => { URL.revokeObjectURL(u); erro(new Error("foto")); }; img.src = u; });
  }

  api("/dados").then(x => {
    d = x;
    if (d.concluida && !Object.keys(st.checklist).length) { app.replaceChildren(el("h1", {}, "✅ ", d.imovel), el("p", { class: "info" }, "Esta limpeza já foi registrada. Obrigado!"), el("button", { type: "button", class: "avancar", onclick: () => { montarTelas(); passo = 0; mostrar(); } }, "Registrar de novo")); return; }
    montarTelas();
    passo = st.quem ? 1 : 0;
    mostrar();
  }).catch(e => { app.replaceChildren(el("h1", {}, "😕"), el("p", {}, e.message)); });
})();
