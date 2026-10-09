// DENIA — idiomas do site e da plataforma (pt-BR, en, es, de, it, fr, ja).
// O texto original em português é a chave; os dicionários ficam em /assets/i18n/<idioma>.json.
// Traduz o que já está na página e tudo o que aparecer depois (telas, avisos, erros do servidor).
(function () {
  "use strict";
  var IDIOMAS = [["pt-BR", "Português"], ["en", "English"], ["es", "Español"], ["de", "Deutsch"], ["it", "Italiano"], ["fr", "Français"], ["ja", "日本語"]];
  var LOCALES = { "pt-BR": "pt-BR", en: "en-US", es: "es-ES", de: "de-DE", it: "it-IT", fr: "fr-FR", ja: "ja-JP" };
  var valido = function (c) { return IDIOMAS.some(function (x) { return x[0] === c; }); };
  function normalizar(c) {
    c = String(c || "").toLowerCase();
    if (c.indexOf("pt") === 0) return "pt-BR";
    var base = c.slice(0, 2);
    return valido(base) ? base : "";
  }
  function escolher() {
    var q = normalizar(new URLSearchParams(location.search).get("lang"));
    if (q) { gravar(q); return q; }
    try { var s = localStorage.getItem("denia_idioma"); if (valido(s)) return s; } catch (e) { /* sem armazenamento */ }
    var lista = navigator.languages || [navigator.language || ""];
    for (var i = 0; i < lista.length; i++) { var n = normalizar(lista[i]); if (n) return n; }
    return "en";
  }
  function gravar(c) { try { localStorage.setItem("denia_idioma", c); } catch (e) { /* sem armazenamento */ } }

  var idioma = escolher();
  window.DENIA_IDIOMA = idioma;
  window.DENIA_LOCALE = LOCALES[idioma];
  document.documentElement.lang = idioma;
  window.denia_t = function (s) { return s; };
  if (idioma === "pt-BR") { window.addEventListener("DOMContentLoaded", function () { colocarSeletor(); }); return; }

  var raiz = document.documentElement;
  raiz.classList.add("i18n-carregando");
  var soltar = function () { raiz.classList.remove("i18n-carregando"); };
  var timer = setTimeout(soltar, 1500);

  var T = {}, H = {}, P = [];
  var EXCLUIR = ".a-usuario, .a-denia, .mensagens, .aprovacao-legenda, [data-sem-traducao], script, style, textarea, code, pre";
  var ATRIBUTOS = ["placeholder", "title", "aria-label", "alt"];
  var feitos = new WeakMap();
  var limpo = function (s) { return String(s).replace(/\s+/g, " ").trim(); };

  function traduzir(texto, profundidade) {
    profundidade = profundidade || 0;
    var nucleo = limpo(texto);
    if (!nucleo) return null;
    var r = T[nucleo];
    if (r == null) {
      for (var i = 0; i < P.length; i++) {
        var m = nucleo.match(P[i][0]);
        if (m) { r = P[i][1].replace(/\{(\d+)\}/g, function (_x, n) { var v = m[Number(n) + 1] || ""; var tv = profundidade < 2 ? traduzir(v, profundidade + 1) : null; return tv != null ? tv : v; }); break; }
      }
    }
    if (r == null) {
      // "Texto (12)": traduz o texto e mantém o número.
      var c = nucleo.match(/^(.+?) \(([\d.,]+)\)$/);
      if (c && T[c[1]] != null) r = T[c[1]] + " (" + c[2] + ")";
    }
    if (r == null || r === nucleo) return null;
    var ini = texto.match(/^\s*/)[0], fim = texto.match(/\s*$/)[0];
    return ini + r + fim;
  }
  window.denia_t = function (s) { var r = traduzir(s); return r == null ? s : r; };

  function excluido(el) { return el && el.closest && el.closest(EXCLUIR); }
  // Caixas de texto: o conteúdo é da pessoa, mas o texto de exemplo (placeholder) é traduzido.
  function soAtributos(el) { return el.tagName === "TEXTAREA" && !(el.parentElement && excluido(el.parentElement)); }
  function noTexto(n) {
    if (!n.parentElement || excluido(n.parentElement)) return;
    if (feitos.get(n) === n.data) return;
    var r = traduzir(n.data);
    if (r != null) n.data = r;
    feitos.set(n, n.data);
  }
  function elemento(el) {
    if (excluido(el) && !soAtributos(el)) return;
    // Blocos com links e destaques (textos legais, perguntas): o bloco inteiro é traduzido.
    if (el.children.length && /^(P|LI|H1|H2|H3|SUMMARY|LABEL|TD|SPAN|SMALL|DIV)$/.test(el.tagName) && !el.dataset.i18nH) {
      var chave = limpo(el.textContent);
      if (H[chave]) { el.innerHTML = H[chave]; el.dataset.i18nH = "1"; }
    }
    for (var i = 0; i < ATRIBUTOS.length; i++) {
      var a = ATRIBUTOS[i], v = el.getAttribute(a);
      if (v && el.dataset["i18n" + a.replace("-", "")] !== v) { var r = traduzir(v); if (r != null) el.setAttribute(a, r); el.dataset["i18n" + a.replace("-", "")] = el.getAttribute(a); }
    }
    if ((el.tagName === "INPUT" && /^(submit|button)$/.test(el.type)) && el.value) { var rv = traduzir(el.value); if (rv != null) el.value = rv; }
  }
  function percorrer(no) {
    if (no.nodeType === 3) { noTexto(no); return; }
    if (no.nodeType !== 1) return;
    if (excluido(no)) { if (soAtributos(no)) elemento(no); else no.querySelectorAll && no.querySelectorAll("textarea").forEach(function (t) { if (soAtributos(t)) elemento(t); }); return; }
    elemento(no);
    var it = document.createTreeWalker(no, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = it.nextNode())) { if (n.nodeType === 3) noTexto(n); else if (n.tagName === "TEXTAREA") { if (soAtributos(n)) elemento(n); } else elemento(n); }
  }
  function tudo() {
    percorrer(document.body);
    var t = traduzir(document.title); if (t != null) document.title = t;
    var d = document.querySelector('meta[name="description"]'); if (d) { var td = traduzir(d.content); if (td != null) d.content = td; }
  }
  function observar() {
    new MutationObserver(function (lista) {
      for (var i = 0; i < lista.length; i++) {
        var m = lista[i];
        if (m.type === "characterData") noTexto(m.target);
        else if (m.type === "attributes") elemento(m.target);
        else for (var j = 0; j < m.addedNodes.length; j++) percorrer(m.addedNodes[j]);
      }
      var t = traduzir(document.title); if (t != null) document.title = t;
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATRIBUTOS });
  }

  var pronto = fetch("/assets/i18n/" + idioma + ".json", { cache: "force-cache" }).then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; });
  var comecar = function () {
    pronto.then(function (d) {
      T = d.t || {}; H = d.h || {};
      P = Object.keys(d.p || {}).sort(function (a, b) { return b.length - a.length; }).map(function (k) {
        var re = "^" + k.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{\d+\}/g, "(.+?)") + "$";
        return [new RegExp(re), d.p[k]];
      });
      tudo(); observar(); colocarSeletor();
      clearTimeout(timer); soltar();
    });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", comecar); else comecar();

  // Seletor de idioma: no topo do site, no rodapé, nas telas de entrada e no painel.
  function colocarSeletor() {
    var lugares = [".topo-acoes", ".barra-topo-direita", ".auth-links", ".rodape-base"];
    lugares.forEach(function (sel) {
      var alvo = document.querySelector(sel);
      if (!alvo || alvo.querySelector(".seletor-idioma")) return;
      var s = document.createElement("select");
      s.className = "seletor-idioma";
      s.setAttribute("aria-label", "Idioma / Language");
      s.setAttribute("data-sem-traducao", "");
      IDIOMAS.forEach(function (x) { var o = document.createElement("option"); o.value = x[0]; o.textContent = x[1]; if (x[0] === idioma) o.selected = true; s.appendChild(o); });
      s.addEventListener("change", function () { gravar(s.value); var u = new URL(location.href); u.searchParams.delete("lang"); location.replace(u.toString()); });
      if (sel === ".rodape-base") { var velho = Array.prototype.find.call(alvo.querySelectorAll("p"), function (p) { return /Português \(Brasil\)/.test(p.textContent); }); if (velho) { velho.replaceWith(s); return; } }
      if (sel === ".topo-acoes" || sel === ".barra-topo-direita") alvo.insertBefore(s, alvo.firstChild); else alvo.appendChild(s);
    });
  }
})();
