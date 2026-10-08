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

  // ---------- Cérebro vivo no fundo + brilho suave que acompanha o mouse/dedo ----------
  var toque = window.matchMedia && window.matchMedia("(hover: none)").matches;
  var luz = document.getElementById("luz-cursor");
  var ponteiro = { x: window.innerWidth * 0.5, y: window.innerHeight * 0.35, ultimo: 0 };
  var alvoLuz = { x: ponteiro.x, y: ponteiro.y }, posLuz = { x: ponteiro.x, y: ponteiro.y };
  function moverPonteiro(x, y) { ponteiro.x = x; ponteiro.y = y; ponteiro.ultimo = Date.now(); alvoLuz.x = x; alvoLuz.y = y; if (luz) luz.classList.add("ativa"); }
  window.addEventListener("pointermove", function (e) { moverPonteiro(e.clientX, e.clientY); }, { passive: true });
  window.addEventListener("touchstart", function (e) { var t = e.touches[0]; if (t) moverPonteiro(t.clientX, t.clientY); }, { passive: true });
  window.addEventListener("touchmove", function (e) { var t = e.touches[0]; if (t) moverPonteiro(t.clientX, t.clientY); }, { passive: true });

  // Cérebro vivo: silhueta de cérebro (vista lateral) com giros e sulcos, neurônios dentro
  // dele ligados por sinapses e pulsos de energia. A luz "aranha" passeia por toda a tela,
  // esticando pernas de luz até os neurônios mais próximos.
  var tela = document.getElementById("rede");
  if (tela && tela.getContext && !semMovimento) {
    var ctx = tela.getContext("2d");
    var largura = 0, altura = 0, dpr = 1, quadro = 0, visivel = true;
    var neuronios = [], ligacoes = [], pulsos = [], rastro = [], proximoDisparo = 0;
    var camada = document.createElement("canvas"), centro = { x: 0, y: 0, e: 1 };
    var aleatorio = function (a, b) { return a + Math.random() * (b - a); };
    var sprite = document.createElement("canvas"); sprite.width = sprite.height = 64;
    (function () {
      var c = sprite.getContext("2d"), g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, "rgba(235,250,255,1)"); g.addColorStop(0.14, "rgba(170,225,255,0.9)"); g.addColorStop(0.38, "rgba(100,160,255,0.32)"); g.addColorStop(1, "rgba(80,110,255,0)");
      c.fillStyle = g; c.fillRect(0, 0, 64, 64);
    })();
    // Ilustração do cérebro (vista lateral, frente à esquerda) em coordenadas de 0 a 200.
    var CEREBRO = {
      contorno: "M60,20 C80,5 120,4 145,15 C170,25 190,45 188,72 C187,90 175,100 160,104 C150,112 132,114 118,110 C105,118 85,118 72,110 C55,114 35,108 26,95 C12,85 10,62 20,48 C26,32 42,22 60,20 Z",
      cerebelo: "M138,104 C152,102 168,108 170,118 C171,128 158,134 146,131 C136,128 131,116 138,104 Z",
      tronco: ["M116,111 C119,123 122,135 127,147", "M132,113 C133,125 135,137 140,147"],
      dobras: [
        "M48,86 C70,80 92,78 122,70", "M112,13 C106,30 113,42 105,58 C101,66 105,72 100,79",
        "M38,40 C48,33 57,41 66,34 C74,28 84,32 92,25", "M28,60 C38,53 46,62 56,56 C64,51 71,58 79,51",
        "M60,70 C69,62 79,67 86,58 C92,50 98,55 103,46", "M44,48 C52,44 58,50 66,46",
        "M121,29 C131,23 141,32 151,27 C161,23 169,31 177,40", "M124,47 C134,41 143,50 153,46 C163,42 171,50 180,58",
        "M120,61 C130,57 139,66 149,62 C159,58 167,66 178,76", "M127,83 C137,79 146,88 156,86 C164,84 171,90 176,94",
        "M42,98 C55,92 66,100 78,96 C90,92 101,98 113,94", "M60,108 C72,104 83,110 97,106",
        "M22,76 C29,70 36,77 44,72", "M86,40 C94,46 100,38 108,42", "M70,22 C76,28 84,22 90,28", "M150,90 C156,95 162,90 168,96"
      ],
      folhas: ["M141,112 C151,109 161,113 166,120", "M139,120 C149,117 158,121 165,128", "M142,127 C150,125 156,128 160,132"]
    };
    var caminhos = null, escala = 1, origem = { x: 0, y: 0 };
    var paraTela = function (c2) { c2.setTransform(dpr * escala, 0, 0, dpr * escala, dpr * origem.x, dpr * origem.y); };
    var desenharCamada = function () {
      camada.width = largura * dpr; camada.height = altura * dpr;
      var c2 = camada.getContext("2d");
      escala = (centro.e * 2) / 180;
      origem.x = centro.x - 104 * escala; origem.y = centro.y - 76 * escala;
      caminhos = { contorno: new Path2D(CEREBRO.contorno), cerebelo: new Path2D(CEREBRO.cerebelo) };
      paraTela(c2);
      // Brilho interno.
      var g = c2.createRadialGradient(95, 60, 6, 104, 76, 110);
      g.addColorStop(0, "rgba(79,140,255,0.22)"); g.addColorStop(0.6, "rgba(139,92,246,0.1)"); g.addColorStop(1, "rgba(79,140,255,0.02)");
      c2.fillStyle = g; c2.fill(caminhos.contorno); c2.fill(caminhos.cerebelo);
      c2.lineCap = "round"; c2.lineJoin = "round";
      c2.shadowColor = "rgba(90,150,255,0.8)"; c2.shadowBlur = 8;
      var traco = function (d, alfa, largura2) { c2.strokeStyle = "rgba(150,200,255," + alfa + ")"; c2.lineWidth = largura2 / escala; c2.stroke(typeof d === "string" ? new Path2D(d) : d); };
      CEREBRO.dobras.forEach(function (d) { traco(d, 0.34, 1.4); });
      CEREBRO.folhas.forEach(function (d) { traco(d, 0.3, 1.2); });
      CEREBRO.tronco.forEach(function (d) { traco(d, 0.36, 1.5); });
      traco(caminhos.cerebelo, 0.45, 1.6);
      traco(caminhos.contorno, 0.55, 1.9);
      c2.setTransform(1, 0, 0, 1, 0, 0);
    };
    var montar = function () {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      largura = window.innerWidth; altura = window.innerHeight;
      tela.width = largura * dpr; tela.height = altura * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var celular = largura < 760;
      centro.e = celular ? largura * 0.46 : Math.min(largura * 0.3, altura * 0.46);
      centro.x = celular ? largura * 0.5 : largura * 0.66;
      centro.y = celular ? altura * 0.4 : altura * 0.5;
      desenharCamada();
      // Neurônios: a maioria dentro do cérebro, alguns soltos pela tela.
      var testeCanvas = document.createElement("canvas"); testeCanvas.width = Math.ceil(largura); testeCanvas.height = Math.ceil(altura);
      var teste = testeCanvas.getContext("2d");
      teste.setTransform(escala, 0, 0, escala, origem.x, origem.y);
      var dentroDoCerebro = function (x, y) { return teste.isPointInPath(caminhos.contorno, x, y); };
      neuronios = []; ligacoes = []; pulsos = []; rastro = [];
      var dentro = celular ? 34 : 48, fora = Math.round(Math.max(14, Math.min(40, (largura * altura) / 42000))), t = 0;
      while (neuronios.length < dentro && t++ < 4000) {
        var x = centro.x + aleatorio(-1, 1) * centro.e, y = centro.y + aleatorio(-0.85, 0.5) * centro.e;
        if (!dentroDoCerebro(x, y) || neuronios.some(function (o) { return Math.hypot(o.bx - x, o.by - y) < centro.e * 0.15; })) continue;
        neuronios.push({ bx: x, by: y, x: x, y: y, fase: aleatorio(0, 6.28), r: aleatorio(1.6, 3), carga: 0, vizinhos: [], dentro: true });
      }
      t = 0;
      while (neuronios.length < dentro + fora && t++ < 4000) {
        var x2 = aleatorio(0, largura), y2 = aleatorio(0, altura);
        if (dentroDoCerebro(x2, y2) || neuronios.some(function (o) { return Math.hypot(o.bx - x2, o.by - y2) < 90; })) continue;
        neuronios.push({ bx: x2, by: y2, x: x2, y: y2, fase: aleatorio(0, 6.28), r: aleatorio(1.2, 2.2), carga: 0, vizinhos: [], dentro: false });
      }
      neuronios.forEach(function (a, i) {
        neuronios.map(function (b, j) { return { j: j, d: Math.hypot(a.bx - b.bx, a.by - b.by) }; })
          .filter(function (o) { return o.j !== i && neuronios[o.j].dentro === a.dentro; }).sort(function (p, q) { return p.d - q.d; }).slice(0, a.dentro ? 3 : 2)
          .forEach(function (o) {
            if (ligacoes.some(function (l) { return (l.a === i && l.b === o.j) || (l.a === o.j && l.b === i); })) return;
            var l = { a: i, b: o.j, curva: aleatorio(-0.25, 0.25), brilho: 0 };
            ligacoes.push(l); a.vizinhos.push({ l: l, outro: o.j }); neuronios[o.j].vizinhos.push({ l: l, outro: i });
          });
      });
    };
    var ponto = function (l, t, deA) {
      var A = neuronios[deA ? l.a : l.b], B = neuronios[deA ? l.b : l.a];
      var mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2, dx = B.x - A.x, dy = B.y - A.y, c = deA ? l.curva : -l.curva;
      var cx = mx - dy * c, cy = my + dx * c, u = 1 - t;
      return { x: u * u * A.x + 2 * u * t * cx + t * t * B.x, y: u * u * A.y + 2 * u * t * cy + t * t * B.y };
    };
    var disparar = function (origem, profundidade) {
      if (pulsos.length > 40) return;
      neuronios[origem].vizinhos.forEach(function (v) {
        if (Math.random() < (profundidade === 0 ? 0.9 : 0.4)) pulsos.push({ de: origem, para: v.outro, l: v.l, t: 0, v: aleatorio(0.014, 0.026), profundidade: profundidade });
      });
    };
    var desenhar = function (agora) {
      ctx.clearRect(0, 0, largura, altura);
      var s = agora / 1000;
      // O cérebro "respira".
      ctx.globalAlpha = 0.82 + Math.sin(s * 0.9) * 0.12;
      ctx.drawImage(camada, 0, 0, largura, altura);
      ctx.globalAlpha = 1;
      neuronios.forEach(function (n) { n.x = n.bx + Math.sin(s * 0.4 + n.fase) * 3.5; n.y = n.by + Math.cos(s * 0.33 + n.fase) * 3.5; n.carga *= 0.95; });
      if (agora > proximoDisparo) { proximoDisparo = agora + aleatorio(350, 900); disparar((Math.random() * neuronios.length) | 0, 0); }
      // A luz "aranha" passeia por toda a tela, passando muitas vezes pelo cérebro.
      var ex = largura * (0.5 + 0.3 * Math.sin(s * 0.23) + 0.17 * Math.sin(s * 0.61 + 1));
      var ey = altura * (0.5 + 0.28 * Math.sin(s * 0.17 + 2) + 0.18 * Math.cos(s * 0.47));
      rastro.push({ x: ex, y: ey }); if (rastro.length > 70) rastro.shift();
      if (Date.now() - ponteiro.ultimo > 2500) { alvoLuz.x = ex; alvoLuz.y = ey; if (luz) luz.classList.add("ativa"); }
      // Sinapses.
      ligacoes.forEach(function (l) {
        l.brilho *= 0.93;
        var A = neuronios[l.a], B = neuronios[l.b], c = ponto(l, 0.5, true);
        ctx.strokeStyle = "rgba(110,165,255," + Math.min(0.6, (A.dentro ? 0.16 : 0.1) + l.brilho * 0.45).toFixed(3) + ")";
        ctx.lineWidth = 0.9 + l.brilho * 1.2;
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.quadraticCurveTo(2 * c.x - (A.x + B.x) / 2, 2 * c.y - (A.y + B.y) / 2, B.x, B.y); ctx.stroke();
      });
      // Pernas de luz da aranha até os neurônios próximos, e o brilho do mouse.
      var raio2 = 170 * 170;
      neuronios.forEach(function (n) {
        var sx = n.x - ex, sy = n.y - ey, ds = sx * sx + sy * sy, perna = ds < 52000 ? 1 - ds / 52000 : 0;
        if (perna) {
          ctx.strokeStyle = "rgba(150,230,255," + (0.6 * perna).toFixed(3) + ")"; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(n.x, n.y); ctx.stroke();
          if (perna > 0.6) n.carga = Math.max(n.carga, perna);
        }
        var mx = n.x - posLuz.x, my = n.y - posLuz.y, dm = mx * mx + my * my, luzPerto = dm < raio2 ? 1 - dm / raio2 : 0;
        var acesa = Math.min(1, n.carga + luzPerto * 0.6);
        var raio = (n.r + acesa * 2.4) * 5;
        ctx.globalAlpha = 0.55 + acesa * 0.45;
        ctx.drawImage(sprite, n.x - raio, n.y - raio, raio * 2, raio * 2);
        ctx.globalAlpha = 1;
      });
      // Pulsos de energia pelas sinapses.
      pulsos = pulsos.filter(function (p) {
        p.t += p.v; p.l.brilho = Math.max(p.l.brilho, 0.8);
        if (p.t >= 1) {
          neuronios[p.para].carga = Math.max(neuronios[p.para].carga, 0.85);
          if (p.profundidade < 2 && Math.random() < 0.4) disparar(p.para, p.profundidade + 1);
          return false;
        }
        var deA = p.l.a === p.de, q = ponto(p.l, p.t, deA), q2 = ponto(p.l, Math.max(0, p.t - 0.09), deA);
        var cauda = ctx.createLinearGradient(q.x, q.y, q2.x, q2.y);
        cauda.addColorStop(0, "rgba(210,242,255,0.95)"); cauda.addColorStop(1, "rgba(120,170,255,0)");
        ctx.strokeStyle = cauda; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(q2.x, q2.y); ctx.lineTo(q.x, q.y); ctx.stroke();
        return true;
      });
      // Rastro e núcleo da luz aranha.
      ctx.lineCap = "round";
      for (var k = 1; k < rastro.length; k++) {
        var v = k / rastro.length;
        ctx.strokeStyle = "rgba(160,225,255," + (0.5 * v * v).toFixed(3) + ")"; ctx.lineWidth = 0.6 + v * 2.6;
        ctx.beginPath(); ctx.moveTo(rastro[k - 1].x, rastro[k - 1].y); ctx.lineTo(rastro[k].x, rastro[k].y); ctx.stroke();
      }
      ctx.drawImage(sprite, ex - 30, ey - 30, 60, 60);
      ctx.drawImage(sprite, ex - 12, ey - 12, 24, 24);
      posLuz.x += (alvoLuz.x - posLuz.x) * 0.12; posLuz.y += (alvoLuz.y - posLuz.y) * 0.12;
      if (luz) luz.style.transform = "translate(" + posLuz.x.toFixed(1) + "px," + posLuz.y.toFixed(1) + "px)";
      quadro = visivel ? window.requestAnimationFrame(desenhar) : 0;
    };
    montar();
    quadro = window.requestAnimationFrame(desenhar);
    var espera;
    window.addEventListener("resize", function () {
      // No celular a barra do navegador muda a altura ao rolar: só remonta se a tela mudou de verdade.
      if (Math.abs(window.innerWidth - largura) < 2 && Math.abs(window.innerHeight - altura) < 160) return;
      clearTimeout(espera); espera = setTimeout(montar, 200);
    });
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
