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

  // ---------- Rede neural viva no fundo + brilho suave que acompanha o mouse/dedo ----------
  var toque = window.matchMedia && window.matchMedia("(hover: none)").matches;
  var luz = document.getElementById("luz-cursor");
  var ponteiro = { x: window.innerWidth * 0.5, y: window.innerHeight * 0.35, ultimo: 0 };
  var alvoLuz = { x: ponteiro.x, y: ponteiro.y }, posLuz = { x: ponteiro.x, y: ponteiro.y };
  function moverPonteiro(x, y) { ponteiro.x = x; ponteiro.y = y; ponteiro.ultimo = Date.now(); alvoLuz.x = x; alvoLuz.y = y; if (luz) luz.classList.add("ativa"); }
  window.addEventListener("pointermove", function (e) { moverPonteiro(e.clientX, e.clientY); }, { passive: true });
  window.addEventListener("touchstart", function (e) { var t = e.touches[0]; if (t) moverPonteiro(t.clientX, t.clientY); }, { passive: true });
  window.addEventListener("touchmove", function (e) { var t = e.touches[0]; if (t) moverPonteiro(t.clientX, t.clientY); }, { passive: true });

  // Rede de neurônios: corpos que brilham, ramificações (dendritos), sinapses curvas e
  // pulsos de energia que correm entre eles. Um pulso principal viaja sem parar pela rede.
  var tela = document.getElementById("rede");
  if (tela && tela.getContext && !semMovimento) {
    var ctx = tela.getContext("2d");
    var neuronios = [], ligacoes = [], pulsos = [], largura = 0, altura = 0, dpr = 1, quadro = 0, visivel = true;
    var energia = null, rastro = [], proximoDisparo = 0;
    var aleatorio = function (a, b) { return a + Math.random() * (b - a); };
    // Brilho do neurônio desenhado uma vez só (muito mais leve do que recriar a cada quadro).
    var sprite = document.createElement("canvas"); sprite.width = sprite.height = 64;
    (function () {
      var c = sprite.getContext("2d"), g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, "rgba(235,250,255,1)"); g.addColorStop(0.14, "rgba(170,225,255,0.9)"); g.addColorStop(0.38, "rgba(100,160,255,0.32)"); g.addColorStop(1, "rgba(80,110,255,0)");
      c.fillStyle = g; c.fillRect(0, 0, 64, 64);
    })();
    var montar = function () {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      largura = window.innerWidth; altura = window.innerHeight;
      tela.width = largura * dpr; tela.height = altura * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var n = Math.round(Math.max(26, Math.min(70, (largura * altura) / (toque ? 13000 : 19000))));
      neuronios = []; ligacoes = []; pulsos = []; rastro = [];
      // Distribuição espalhada (evita neurônios amontoados).
      var tentativas = 0, minimo = Math.sqrt((largura * altura) / n) * 0.62;
      while (neuronios.length < n && tentativas++ < n * 40) {
        var x = aleatorio(-20, largura + 20), y = aleatorio(-20, altura + 20);
        if (neuronios.some(function (o) { return (o.bx - x) * (o.bx - x) + (o.by - y) * (o.by - y) < minimo * minimo; })) continue;
        var ramos = [];
        for (var r = 0, nr = 3 + ((Math.random() * 4) | 0); r < nr; r++) {
          var ang = aleatorio(0, Math.PI * 2), comp = aleatorio(14, 36);
          ramos.push({ ang: ang, comp: comp, curva: aleatorio(-0.6, 0.6), galho: Math.random() < 0.55 ? aleatorio(0.35, 0.8) : 0 });
        }
        neuronios.push({ bx: x, by: y, x: x, y: y, fase: aleatorio(0, 6.28), r: aleatorio(1.8, 3.4), carga: 0, ramos: ramos, vizinhos: [] });
      }
      // Sinapses: cada neurônio liga aos 2 ou 3 mais próximos, com curva suave.
      neuronios.forEach(function (a, i) {
        var perto = neuronios.map(function (b, j) { return { j: j, d: (a.bx - b.bx) * (a.bx - b.bx) + (a.by - b.by) * (a.by - b.by) }; })
          .filter(function (o) { return o.j !== i; }).sort(function (p, q) { return p.d - q.d; }).slice(0, 2 + ((Math.random() * 2) | 0));
        perto.forEach(function (o) {
          if (ligacoes.some(function (l) { return (l.a === i && l.b === o.j) || (l.a === o.j && l.b === i); })) return;
          var l = { a: i, b: o.j, curva: aleatorio(-0.28, 0.28), brilho: 0 };
          ligacoes.push(l);
          a.vizinhos.push({ l: l, outro: o.j });
          neuronios[o.j].vizinhos.push({ l: l, outro: i });
        });
      });
      energia = { de: 0, l: null, para: 0, t: 0 };
      escolherCaminho(energia, (Math.random() * neuronios.length) | 0, -1);
    };
    // Ponto ao longo da sinapse (curva de Bézier quadrática).
    var ponto = function (l, t, deA) {
      var A = neuronios[deA ? l.a : l.b], B = neuronios[deA ? l.b : l.a];
      var mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2, dx = B.x - A.x, dy = B.y - A.y;
      var c = deA ? l.curva : -l.curva;
      var cx = mx - dy * c, cy = my + dx * c, u = 1 - t;
      return { x: u * u * A.x + 2 * u * t * cx + t * t * B.x, y: u * u * A.y + 2 * u * t * cy + t * t * B.y };
    };
    function escolherCaminho(p, origem, evitar) {
      var opcoes = neuronios[origem].vizinhos.filter(function (v) { return v.outro !== evitar; });
      if (!opcoes.length) opcoes = neuronios[origem].vizinhos;
      if (!opcoes.length) return false;
      var v = opcoes[(Math.random() * opcoes.length) | 0];
      p.de = origem; p.para = v.outro; p.l = v.l; p.t = 0;
      return true;
    }
    var disparar = function (origem, profundidade) {
      if (pulsos.length > 42) return;
      neuronios[origem].vizinhos.forEach(function (v) {
        if (Math.random() < (profundidade === 0 ? 0.9 : 0.45)) {
          var p = { profundidade: profundidade, v: aleatorio(0.012, 0.022) };
          p.de = origem; p.para = v.outro; p.l = v.l; p.t = 0;
          pulsos.push(p);
        }
      });
    };
    var desenhar = function (agora) {
      ctx.clearRect(0, 0, largura, altura);
      var s = agora / 1000;
      // Neurônios "respiram" devagar.
      neuronios.forEach(function (n) {
        n.x = n.bx + Math.sin(s * 0.35 + n.fase) * 6; n.y = n.by + Math.cos(s * 0.29 + n.fase * 1.3) * 6;
        n.carga *= 0.955;
      });
      // Disparos espontâneos.
      if (agora > proximoDisparo) { proximoDisparo = agora + aleatorio(600, 1500); disparar((Math.random() * neuronios.length) | 0, 0); }
      // Pulso principal: a energia que nunca para de viajar.
      if (energia && energia.l) {
        energia.t += 0.011;
        if (energia.t >= 1) {
          neuronios[energia.para].carga = 1;
          if (Math.random() < 0.5) disparar(energia.para, 1);
          escolherCaminho(energia, energia.para, energia.de);
        }
      }
      var e = energia && energia.l ? ponto(energia.l, Math.min(1, energia.t), energia.l.a === energia.de) : { x: -999, y: -999 };
      rastro.push(e); if (rastro.length > 46) rastro.shift();
      if (Date.now() - ponteiro.ultimo > 2500) { alvoLuz.x = e.x; alvoLuz.y = e.y; if (luz) luz.classList.add("ativa"); }
      // Sinapses.
      var raio2 = 170 * 170;
      ligacoes.forEach(function (l) {
        l.brilho *= 0.93;
        var A = neuronios[l.a], B = neuronios[l.b];
        var mx = (A.x + B.x) / 2 - posLuz.x, my = (A.y + B.y) / 2 - posLuz.y, dm = mx * mx + my * my;
        var perto = dm < raio2 ? 1 - dm / raio2 : 0;
        var c = ponto(l, 0.5, true);
        var cx = 2 * c.x - (A.x + B.x) / 2, cy = 2 * c.y - (A.y + B.y) / 2;
        ctx.strokeStyle = "rgba(110,160,255," + Math.min(0.65, 0.17 + perto * 0.25 + l.brilho * 0.45).toFixed(3) + ")";
        ctx.lineWidth = 1 + l.brilho * 1.3;
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.quadraticCurveTo(cx, cy, B.x, B.y); ctx.stroke();
      });
      // Dendritos e corpos dos neurônios.
      neuronios.forEach(function (n) {
        var dx = n.x - posLuz.x, dy = n.y - posLuz.y, d = dx * dx + dy * dy;
        var luzPerto = d < raio2 ? 1 - d / raio2 : 0;
        var ex = n.x - e.x, ey = n.y - e.y, de = ex * ex + ey * ey;
        var energiaPerto = de < 22000 ? 1 - de / 22000 : 0;
        var acesa = Math.min(1, n.carga + luzPerto * 0.6 + energiaPerto * 0.7);
        ctx.strokeStyle = "rgba(140,195,255," + (0.26 + acesa * 0.5).toFixed(3) + ")";
        ctx.lineWidth = 0.9;
        n.ramos.forEach(function (r) {
          var a = r.ang + Math.sin(s * 0.5 + n.fase) * 0.05;
          var fx = n.x + Math.cos(a) * r.comp, fy = n.y + Math.sin(a) * r.comp;
          var qx = n.x + Math.cos(a + r.curva) * r.comp * 0.55, qy = n.y + Math.sin(a + r.curva) * r.comp * 0.55;
          ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.quadraticCurveTo(qx, qy, fx, fy); ctx.stroke();
          if (r.galho) {
            var gx = n.x + Math.cos(a) * r.comp * r.galho, gy = n.y + Math.sin(a) * r.comp * r.galho, b2 = a + (r.curva > 0 ? -0.7 : 0.7);
            ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx + Math.cos(b2) * r.comp * 0.45, gy + Math.sin(b2) * r.comp * 0.45); ctx.stroke();
          }
        });
        var raio = (n.r + acesa * 2.4) * 5;
        ctx.globalAlpha = 0.62 + acesa * 0.38;
        ctx.drawImage(sprite, n.x - raio, n.y - raio, raio * 2, raio * 2);
        ctx.globalAlpha = 1;
      });
      // Pulsos de energia correndo pelas sinapses.
      pulsos = pulsos.filter(function (p) {
        p.t += p.v;
        p.l.brilho = Math.max(p.l.brilho, 0.8);
        if (p.t >= 1) {
          neuronios[p.para].carga = Math.max(neuronios[p.para].carga, 0.8);
          if (p.profundidade < 2 && Math.random() < 0.35) disparar(p.para, p.profundidade + 1);
          return false;
        }
        var deA = p.l.a === p.de, q = ponto(p.l, p.t, deA), q2 = ponto(p.l, Math.max(0, p.t - 0.08), deA);
        var cauda = ctx.createLinearGradient(q.x, q.y, q2.x, q2.y);
        cauda.addColorStop(0, "rgba(200,240,255,0.95)"); cauda.addColorStop(1, "rgba(120,170,255,0)");
        ctx.strokeStyle = cauda; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(q2.x, q2.y); ctx.lineTo(q.x, q.y); ctx.stroke();
        ctx.fillStyle = "rgba(230,250,255,0.95)";
        ctx.beginPath(); ctx.arc(q.x, q.y, 1.6, 0, Math.PI * 2); ctx.fill();
        return true;
      });
      // A energia principal: rastro e núcleo brilhante.
      ctx.lineCap = "round";
      for (var k = 1; k < rastro.length; k++) {
        if (Math.abs(rastro[k].x - rastro[k - 1].x) + Math.abs(rastro[k].y - rastro[k - 1].y) > 60) continue;
        var v = k / rastro.length;
        ctx.strokeStyle = "rgba(160,225,255," + (0.55 * v * v).toFixed(3) + ")";
        ctx.lineWidth = 0.6 + v * 2.8;
        ctx.beginPath(); ctx.moveTo(rastro[k - 1].x, rastro[k - 1].y); ctx.lineTo(rastro[k].x, rastro[k].y); ctx.stroke();
      }
      ctx.drawImage(sprite, e.x - 30, e.y - 30, 60, 60);
      ctx.drawImage(sprite, e.x - 12, e.y - 12, 24, 24);
      // O brilho do mouse desliza macio até o alvo.
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
