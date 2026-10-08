// DENIA — site público (experiência)
(function () {
  "use strict";
  var raiz = document.documentElement;
  var semMovimento = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- Revelar ao rolar ----------
  var revelar = Array.prototype.slice.call(document.querySelectorAll(".revelar"));
  if ("IntersectionObserver" in window && !semMovimento) {
    raiz.classList.add("js");
    var obs = new IntersectionObserver(function (entradas) {
      entradas.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("visivel"); obs.unobserve(e.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    revelar.forEach(function (el, i) {
      var r = el.getBoundingClientRect();
      if (r.top < window.innerHeight) el.classList.add("visivel");
      else { el.style.transitionDelay = (i % 3) * 70 + "ms"; obs.observe(el); }
    });
  }

  // ---------- Menu ----------
  var botao = document.getElementById("menu-botao");
  var menu = document.getElementById("menu");
  if (botao && menu) {
    botao.addEventListener("click", function () {
      var aberto = menu.classList.toggle("aberto");
      botao.setAttribute("aria-expanded", aberto ? "true" : "false");
      botao.setAttribute("aria-label", aberto ? "Fechar menu" : "Abrir menu");
    });
    menu.addEventListener("click", function (e) {
      if (e.target.tagName === "A") { menu.classList.remove("aberto"); botao.setAttribute("aria-expanded", "false"); }
    });
  }
  var ano = document.getElementById("ano");
  if (ano) ano.textContent = String(new Date().getFullYear());
  document.querySelectorAll(".js-ano").forEach(function (n) { n.textContent = String(new Date().getFullYear()); });

  // ---------- Constelação viva no fundo + brilho suave que acompanha o mouse/dedo ----------
  var toque = window.matchMedia && window.matchMedia("(hover: none)").matches;
  var luz = document.getElementById("luz-cursor");
  var ponteiro = { x: window.innerWidth * 0.5, y: window.innerHeight * 0.35, ultimo: 0 };
  var alvoLuz = { x: ponteiro.x, y: ponteiro.y }, posLuz = { x: ponteiro.x, y: ponteiro.y };
  function moverPonteiro(x, y) { ponteiro.x = x; ponteiro.y = y; ponteiro.ultimo = Date.now(); alvoLuz.x = x; alvoLuz.y = y; if (luz) luz.classList.add("ativa"); }
  window.addEventListener("pointermove", function (e) { moverPonteiro(e.clientX, e.clientY); }, { passive: true });
  window.addEventListener("touchstart", function (e) { var t = e.touches[0]; if (t) moverPonteiro(t.clientX, t.clientY); }, { passive: true });
  window.addEventListener("touchmove", function (e) { var t = e.touches[0]; if (t) moverPonteiro(t.clientX, t.clientY); }, { passive: true });

  var tela = document.getElementById("rede");
  if (tela && tela.getContext && !semMovimento) {
    var ctx = tela.getContext("2d");
    var pontos = [], largura = 0, altura = 0, dpr = 1, quadro = 0, visivel = true, estrela = [], cadentes = [], proximaCadente = 0;
    var dimensionar = function () {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      largura = window.innerWidth; altura = window.innerHeight;
      tela.width = largura * dpr; tela.height = altura * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var n = Math.round(Math.max(28, Math.min(90, (largura * altura) / (toque ? 11000 : 15000))));
      pontos = [];
      for (var i = 0; i < n; i++) pontos.push({ x: Math.random() * largura, y: Math.random() * altura, vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3, r: Math.random() * 1.5 + 0.6 });
    };
    var desenhar = function (agora) {
      ctx.clearRect(0, 0, largura, altura);
      // A estrela viaja sozinha por toda a tela, inclusive pelos cantos.
      var s = agora / 1000;
      var ex = largura * (0.5 + 0.30 * Math.sin(s * 0.23) + 0.17 * Math.sin(s * 0.61 + 1));
      var ey = altura * (0.5 + 0.28 * Math.sin(s * 0.17 + 2) + 0.18 * Math.cos(s * 0.47));
      estrela.push({ x: ex, y: ey });
      if (estrela.length > 70) estrela.shift();
      // Sem mouse por alguns segundos (ou no celular parado), o brilho acompanha a estrela.
      if (Date.now() - ponteiro.ultimo > 2500) { alvoLuz.x = ex; alvoLuz.y = ey; if (luz) luz.classList.add("ativa"); }
      // A luz desliza até o alvo (movimento macio, sem "pular").
      posLuz.x += (alvoLuz.x - posLuz.x) * 0.12; posLuz.y += (alvoLuz.y - posLuz.y) * 0.12;
      if (luz) luz.style.transform = "translate(" + posLuz.x.toFixed(1) + "px," + posLuz.y.toFixed(1) + "px)";
      var raio2 = 170 * 170;
      for (var i = 0; i < pontos.length; i++) {
        var p = pontos[i];
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > largura) p.vx *= -1;
        if (p.y < 0 || p.y > altura) p.vy *= -1;
        var mx = p.x - posLuz.x, my = p.y - posLuz.y, dm = mx * mx + my * my;
        var perto = dm < raio2 ? 1 - dm / raio2 : 0;
        for (var j = i + 1; j < pontos.length; j++) {
          var q = pontos[j], dx = p.x - q.x, dy = p.y - q.y, d = dx * dx + dy * dy;
          if (d < 17000) {
            ctx.strokeStyle = "rgba(110,160,255," + ((0.13 + perto * 0.3) * (1 - d / 17000)).toFixed(3) + ")";
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
          }
        }
        // Pontos perto da estrela se acendem e se ligam a ela.
        var sx = p.x - ex, sy = p.y - ey, ds = sx * sx + sy * sy, brilho = ds < 48000 ? 1 - ds / 48000 : 0;
        if (brilho) {
          ctx.strokeStyle = "rgba(140,225,255," + (0.55 * brilho).toFixed(3) + ")";
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(ex, ey); ctx.stroke();
        }
        ctx.fillStyle = "rgba(200,238,255," + Math.min(1, 0.6 + perto * 0.4 + brilho * 0.4).toFixed(3) + ")";
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r + perto + brilho * 1.6, 0, Math.PI * 2); ctx.fill();
      }
      // Rastro da estrela.
      ctx.lineCap = "round";
      for (var k = 1; k < estrela.length; k++) {
        var v = k / estrela.length;
        ctx.strokeStyle = "rgba(150,215,255," + (0.5 * v * v).toFixed(3) + ")";
        ctx.lineWidth = 0.6 + v * 2.6;
        ctx.beginPath(); ctx.moveTo(estrela[k - 1].x, estrela[k - 1].y); ctx.lineTo(estrela[k].x, estrela[k].y); ctx.stroke();
      }
      // Núcleo brilhante da estrela.
      var g = ctx.createRadialGradient(ex, ey, 0, ex, ey, 26);
      g.addColorStop(0, "rgba(255,255,255,0.95)"); g.addColorStop(0.18, "rgba(170,230,255,0.75)"); g.addColorStop(0.5, "rgba(90,140,255,0.22)"); g.addColorStop(1, "rgba(90,140,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(ex, ey, 26, 0, Math.PI * 2); ctx.fill();
      // Estrelas cadentes de vez em quando.
      if (agora > proximaCadente) {
        proximaCadente = agora + 3500 + Math.random() * 5000;
        var ang = (20 + Math.random() * 20) * Math.PI / 180;
        cadentes.push({ x: Math.random() * largura * 0.8, y: Math.random() * altura * 0.35, vx: Math.cos(ang) * (9 + Math.random() * 5), vy: Math.sin(ang) * (9 + Math.random() * 5), t: agora });
      }
      cadentes = cadentes.filter(function (c) { return agora - c.t < 1100; });
      cadentes.forEach(function (c) {
        c.x += c.vx; c.y += c.vy;
        var vida = 1 - (agora - c.t) / 1100;
        var cauda = ctx.createLinearGradient(c.x, c.y, c.x - c.vx * 12, c.y - c.vy * 12);
        cauda.addColorStop(0, "rgba(235,248,255," + (0.9 * vida).toFixed(3) + ")"); cauda.addColorStop(1, "rgba(120,170,255,0)");
        ctx.strokeStyle = cauda; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x - c.vx * 12, c.y - c.vy * 12); ctx.stroke();
      });
      quadro = visivel ? window.requestAnimationFrame(desenhar) : 0;
    };
    dimensionar();
    quadro = window.requestAnimationFrame(desenhar);
    var espera;
    window.addEventListener("resize", function () { clearTimeout(espera); espera = setTimeout(dimensionar, 150); });
    document.addEventListener("visibilitychange", function () {
      visivel = document.visibilityState === "visible";
      if (visivel && !quadro) quadro = window.requestAnimationFrame(desenhar);
    });
  }

  // ---------- Brilho discreto nos cartões ----------
  if (!semMovimento) {
    document.querySelectorAll(".recurso, .plano, .contador-caixa, .etapa, .lista-seguranca li").forEach(function (c) {
      c.classList.add("interativo");
      c.addEventListener("pointermove", function (e) {
        var r = c.getBoundingClientRect();
        c.style.setProperty("--mx", (e.clientX - r.left) + "px");
        c.style.setProperty("--my", (e.clientY - r.top) + "px");
      });
    });
  }

  // ---------- Barra de progresso da leitura ----------
  var paginaAcesso = document.body.classList.contains("auth");
  var barra = document.createElement("div");
  if (paginaAcesso) barra.className = "oculto";
  if (!paginaAcesso) barra.className = "progresso-leitura";
  barra.setAttribute("aria-hidden", "true");
  document.body.appendChild(barra);
  var marcarProgresso = function () {
    var total = document.documentElement.scrollHeight - window.innerHeight;
    barra.style.transform = "scaleX(" + (total > 0 ? Math.min(1, window.scrollY / total) : 0).toFixed(4) + ")";
  };
  window.addEventListener("scroll", marcarProgresso, { passive: true });
  marcarProgresso();

  // ---------- Abertura: a inteligência "liga" (uma vez por visita) ----------
  var jaViu = false;
  try { jaViu = sessionStorage.getItem("denia_abertura") === "1"; sessionStorage.setItem("denia_abertura", "1"); } catch (e) { jaViu = false; }
  if (!semMovimento && !jaViu && !paginaAcesso) {
    var abertura = document.createElement("div");
    abertura.className = "abertura"; abertura.setAttribute("aria-hidden", "true");
    var nucleo = document.createElement("div"); nucleo.className = "abertura-nucleo";
    var texto = document.createElement("p"); texto.className = "abertura-texto";
    var linha = document.createElement("div"); linha.className = "abertura-linha";
    linha.appendChild(document.createElement("i"));
    abertura.appendChild(nucleo); abertura.appendChild(texto); abertura.appendChild(linha);
    document.body.appendChild(abertura);
    var frases = ["Conectando a inteligência…", "Carregando a memória…", "DENIA pronta."];
    frases.forEach(function (f, i) { setTimeout(function () { texto.textContent = f; }, i * 520); });
    var sair = function () { abertura.classList.add("saindo"); setTimeout(function () { abertura.remove(); }, 700); };
    setTimeout(sair, 1650);
    abertura.addEventListener("click", sair);
  }

  // ---------- Palavra viva no título ----------
  var palavra = document.getElementById("palavra-viva");
  if (palavra && !semMovimento) {
    var palavras = ["atende", "entende", "aprende", "agenda", "resolve"], k = 0;
    setInterval(function () {
      palavra.classList.add("trocando");
      setTimeout(function () { k = (k + 1) % palavras.length; palavra.textContent = palavras[k]; palavra.classList.remove("trocando"); }, 350);
    }, 2600);
  }

  // ---------- Utilitários das conversas animadas ----------
  function el(tag, classe, texto) { var e = document.createElement(tag); if (classe) e.className = classe; if (texto) e.textContent = texto; return e; }
  function digitando(lado) { var b = el("div", "bolha " + lado + " digitando"); b.appendChild(el("i")); b.appendChild(el("i")); b.appendChild(el("i")); return b; }

  // Conversa do topo: reproduz em loop quando visível.
  var mock = document.getElementById("mock-corpo");
  if (mock && !semMovimento) {
    var roteiro = Array.prototype.map.call(mock.children, function (n) { return { classe: n.className, texto: n.textContent }; });
    var rodando = false;
    var tocar = function () {
      if (rodando) return;
      rodando = true;
      mock.textContent = "";
      var i = 0;
      var proximo = function () {
        if (i >= roteiro.length) { setTimeout(function () { rodando = false; tocar(); }, 5200); return; }
        var item = roteiro[i++];
        var ehBolha = item.classe.indexOf("bolha") >= 0;
        var lado = item.classe.indexOf("bolha-denia") >= 0 ? "bolha-denia" : "bolha-cliente";
        var esperar = ehBolha ? digitando(lado) : null;
        if (esperar) mock.appendChild(esperar);
        setTimeout(function () {
          if (esperar) esperar.remove();
          var n = el("div", item.classe);
          if (item.classe.indexOf("mock-evento") >= 0) { n.appendChild(el("span", "ponto")); n.appendChild(document.createTextNode(" " + item.texto.trim())); }
          else n.textContent = item.texto;
          mock.appendChild(n);
          setTimeout(proximo, 650);
        }, ehBolha ? 900 + Math.min(item.texto.length * 14, 900) : 500);
      };
      proximo();
    };
    setTimeout(tocar, 600);
  }

  // ---------- Demonstração interativa ----------
  var CENARIOS = {
    geladeira: {
      chat: [
        ["c", "Oi, minha geladeira parou de gelar 😕"],
        ["d", "Poxa, imagino o transtorno! Ela parou totalmente ou ainda gela um pouco? E qual é a marca?"],
        ["c", "Parou de vez. É Brastemp, frost free"],
        ["d", "Entendi. Já estou verificando com o técnico especializado e te retorno em seguida."],
        ["e", "Consulta enviada ao técnico de assistência · Caso #1284"]
      ],
      passos: [
        ["Entendeu o pedido", "Geladeira com defeito → assistência técnica. Nunca o eletricista."],
        ["Perguntou só o que faltava", "Sem repetir o que o cliente já contou."],
        ["Escolheu o profissional certo", "Pela área definida no treinamento da empresa."],
        ["Prometeu só o que fez", "\"Estou verificando\" só depois de a consulta ser enviada de verdade.", "trava"]
      ]
    },
    preco: {
      chat: [
        ["c", "Quanto custa para trocar uma fechadura?"],
        ["d", "Depende do modelo da fechadura e da porta. Vou confirmar o valor com o chaveiro e já te passo, combinado?"],
        ["e", "Chaveiro consultado · aguardando valor"],
        ["d", "O chaveiro pode ir amanhã às 10h. O valor fica R$ 150,00, já com a visita. Podemos confirmar?"]
      ],
      passos: [
        ["Procurou um preço autorizado", "Não havia valor fixo cadastrado para esse serviço."],
        ["Não inventou valor", "Preço só sai quando o profissional confirma.", "trava"],
        ["Conferiu se o valor é o total", "Se o profissional mandar \"400 ou 500\", ela pergunta antes."],
        ["Agendamento só com confirmação", "O horário vale depois do \"ok\" do profissional."]
      ]
    },
    antigo: {
      chat: [
        ["c", "Oi, é a Joana de novo!"],
        ["d", "Oi, Joana! Que bom falar com você de novo 😊 Como ficou o armário que montamos em maio?"],
        ["c", "Ficou ótimo! Agora preciso de um suporte de TV"],
        ["d", "Que bom! Para o suporte, a TV é de quantas polegadas? Continua no mesmo endereço?"]
      ],
      passos: [
        ["Reconheceu a cliente", "Pelo telefone, no histórico e no cadastro importado."],
        ["Lembrou do último serviço", "Armário planejado, maio, com o mesmo profissional."],
        ["Não pediu dados de novo", "Só confirma o endereço que já conhece."],
        ["Falou como a equipe", "Tom aprendido com as mensagens das atendentes."]
      ]
    },
    humano: {
      chat: [
        ["c", "Quero falar com uma pessoa, por favor"],
        ["d", "Claro! Já chamei alguém da equipe para continuar com você."],
        ["e", "Equipe avisada · conversa assumida pela atendente"],
        ["h", "Oi! Aqui é a Carla. Pode me contar o que houve?"]
      ],
      passos: [
        ["Chamou uma pessoa", "Alerta imediato para a equipe, com o resumo do caso."],
        ["Pausou nesta conversa", "Enquanto a atendente fala, a IA não interrompe.", "trava"],
        ["Continuou observando", "Registra o que foi combinado para não repetir perguntas."],
        ["Retoma quando liberada", "Do ponto exato em que a atendente parou."]
      ]
    }
  };
  var demoMsgs = document.getElementById("demo-mensagens");
  var demoPassos = document.getElementById("demo-passos");
  var opcoes = Array.prototype.slice.call(document.querySelectorAll(".demo-opcao"));
  var geracao = 0;
  function rodarCenario(nome) {
    var c = CENARIOS[nome];
    if (!c || !demoMsgs) return;
    var minha = ++geracao;
    opcoes.forEach(function (o) { var ativo = o.getAttribute("data-cenario") === nome; o.classList.toggle("ativo", ativo); o.setAttribute("aria-selected", ativo ? "true" : "false"); });
    demoMsgs.textContent = ""; demoPassos.textContent = "";
    var i = 0, p = 0;
    var passo = function () {
      if (minha !== geracao || p >= c.passos.length) return;
      var dado = c.passos[p++];
      var li = el("li", dado[2] || "");
      li.appendChild(el("strong", "", dado[0]));
      li.appendChild(document.createTextNode(dado[1]));
      demoPassos.appendChild(li);
    };
    var proxima = function () {
      if (minha !== geracao) return;
      if (i >= c.chat.length) { while (p < c.passos.length) passo(); return; }
      var m = c.chat[i++];
      var classe = m[0] === "c" ? "bolha bolha-cliente" : m[0] === "e" ? "mock-evento" : m[0] === "h" ? "bolha bolha-denia bolha-humano" : "bolha bolha-denia";
      var espera = semMovimento || m[0] === "e" ? null : digitando(m[0] === "c" ? "bolha-cliente" : "bolha-denia");
      if (espera) demoMsgs.appendChild(espera);
      setTimeout(function () {
        if (minha !== geracao) return;
        if (espera) espera.remove();
        var n = el("div", classe);
        if (m[0] === "e") { n.appendChild(el("span", "ponto")); n.appendChild(document.createTextNode(" " + m[1])); } else n.textContent = m[1];
        demoMsgs.appendChild(n);
        if (m[0] !== "c") passo();
        setTimeout(proxima, semMovimento ? 0 : 500);
      }, semMovimento ? 0 : espera ? 800 + Math.min(m[1].length * 12, 900) : 400);
    };
    proxima();
  }
  opcoes.forEach(function (o) { o.addEventListener("click", function () { rodarCenario(o.getAttribute("data-cenario")); }); });
  if (demoMsgs) {
    if ("IntersectionObserver" in window) {
      var obsDemo = new IntersectionObserver(function (e) { if (e[0].isIntersecting) { obsDemo.disconnect(); rodarCenario("geladeira"); } }, { threshold: 0.3 });
      obsDemo.observe(demoMsgs);
    } else rodarCenario("geladeira");
  }

  // ---------- Contadores ----------
  var contadores = Array.prototype.slice.call(document.querySelectorAll("[data-contar]"));
  var animarContador = function (n) {
    var alvo = Number(n.getAttribute("data-contar")) || 0, sufixo = n.getAttribute("data-sufixo") || "";
    if (semMovimento || alvo === 0) { n.textContent = alvo + sufixo; return; }
    var inicio = performance.now();
    var tick = function (t) {
      var x = Math.min(1, (t - inicio) / 1400), v = Math.round(alvo * (1 - Math.pow(1 - x, 3)));
      n.textContent = v + sufixo;
      if (x < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  if ("IntersectionObserver" in window) {
    var obsC = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { obsC.unobserve(e.target); animarContador(e.target); } }); }, { threshold: 0.5 });
    contadores.forEach(function (n) { obsC.observe(n); });
  } else contadores.forEach(animarContador);

  // ---------- Contato (só aparece quando configurado) ----------
  fetch("/api/publico", { headers: { accept: "application/json" } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (cfg) {
      if (!cfg) return;
      var destino = "";
      if (cfg.whatsapp) destino = "https://wa.me/" + cfg.whatsapp + "?text=" + encodeURIComponent("Olá! Quero conhecer a DENIA.");
      else if (cfg.email) destino = "mailto:" + cfg.email + "?subject=" + encodeURIComponent("Quero conhecer a DENIA");
      if (!destino) return;
      document.querySelectorAll(".js-contato").forEach(function (a) {
        a.setAttribute("href", destino);
        if (cfg.whatsapp) { a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener noreferrer"); }
        a.classList.remove("oculto");
      });
    })
    .catch(function () { /* sem contato configurado */ });
})();
