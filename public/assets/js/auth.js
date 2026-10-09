// DENIA — entrar, criar conta, recuperar e redefinir a senha
(function () {
  "use strict";
  var form = document.getElementById("form");
  if (!form) return;
  var acao = form.getAttribute("data-acao");
  var botao = document.getElementById("botao");
  var erro = document.getElementById("erro");
  var ok = document.getElementById("ok");
  var textoBotao = botao.textContent;

  function mostrar(el, texto) { el.textContent = texto; el.classList.remove("oculto"); }
  function limpar() { erro.classList.add("oculto"); ok.classList.add("oculto"); }

  // Mostrar/ocultar senha e aviso de Caps Lock.
  document.querySelectorAll("[data-ver]").forEach(function (b) {
    b.addEventListener("click", function () {
      var campo = document.getElementById(b.getAttribute("data-ver"));
      var ver = campo.type === "password";
      campo.type = ver ? "text" : "password";
      b.textContent = ver ? "Ocultar" : "Mostrar";
      b.setAttribute("aria-pressed", ver ? "true" : "false");
      b.setAttribute("aria-label", ver ? "Ocultar senha" : "Mostrar senha");
      campo.focus();
    });
  });
  document.querySelectorAll("input[type=password]").forEach(function (c) {
    var aviso = document.querySelector('[data-caps="' + c.id + '"]');
    var checar = function (e) { if (aviso && e.getModifierState) aviso.classList.toggle("oculto", !e.getModifierState("CapsLock")); };
    c.addEventListener("keydown", checar);
    c.addEventListener("keyup", checar);
    c.addEventListener("blur", function () { if (aviso) aviso.classList.add("oculto"); });
  });

  // Força da senha (cadastro e redefinição).
  var forca = document.getElementById("forca"), forcaTexto = document.getElementById("forca-texto");
  if (forca && form.senha) {
    form.senha.addEventListener("input", function () {
      var s = form.senha.value, pontos = 0;
      if (s.length >= 10) pontos++;
      if (s.length >= 14) pontos++;
      if (/[a-z]/.test(s) && /[A-Z]/.test(s)) pontos++;
      if (/\d/.test(s)) pontos++;
      if (/[^A-Za-z0-9]/.test(s)) pontos++;
      var nivel = s.length < 10 || !/[A-Za-z]/.test(s) || !/\d/.test(s) ? 0 : Math.min(3, pontos - 1);
      var nomes = ["Fraca: use 10 caracteres ou mais, com letras e números.", "Boa", "Forte", "Excelente"];
      forca.style.width = (s ? [22, 55, 80, 100][nivel] : 0) + "%";
      forca.className = "nivel-" + nivel;
      forcaTexto.textContent = s ? "Senha " + nomes[nivel].charAt(0).toLowerCase() + nomes[nivel].slice(1) : "Mínimo de 10 caracteres, com letras e números.";
      if (nivel === 0 && s) forcaTexto.textContent = nomes[0];
    });
  }

  var token = new URLSearchParams(location.search).get("t") || "";
  if (acao === "redefinir" && !token) {
    mostrar(erro, "Link inválido. Peça um novo em “Esqueceu a senha?”.");
    botao.disabled = true;
  }
  // Já conectado? Mostra a opção de continuar, sem pular o login.
  if (acao === "entrar") {
    fetch("/api/eu", { headers: { accept: "application/json" }, credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.usuario) return;
        var aviso = document.createElement("div");
        aviso.className = "ja-conectado";
        var texto = document.createElement("p");
        texto.textContent = "Você já está conectado como " + (d.usuario.nome || d.usuario.email) + ".";
        var continuar = document.createElement("a");
        continuar.className = "btn btn-secundario btn-pequeno"; continuar.href = "/app"; continuar.textContent = "Continuar";
        var outra = document.createElement("button");
        outra.type = "button"; outra.className = "btn btn-secundario btn-pequeno"; outra.textContent = "Sair e entrar com outra conta";
        outra.addEventListener("click", function () {
          fetch("/api/sair", { method: "POST", headers: { "x-denia": "1", "content-type": "application/json" }, body: "{}" }).finally(function () { aviso.remove(); });
        });
        var acoes = document.createElement("div"); acoes.className = "ja-conectado-acoes"; acoes.appendChild(continuar); acoes.appendChild(outra);
        aviso.appendChild(texto); aviso.appendChild(acoes);
        form.parentNode.insertBefore(aviso, form);
      })
      .catch(function () { /* sem sessão */ });
  }
  // Plano escolhido na página inicial (teste grátis).
  var NOMES_PLANO = { start: "Start", pro: "Pro", growth: "Growth", elite: "Elite" };
  var plano = (new URLSearchParams(location.search).get("plano") || "").toLowerCase();
  if (acao === "cadastro" && NOMES_PLANO[plano]) {
    var faixa = document.createElement("p");
    faixa.className = "plano-escolhido";
    faixa.textContent = "Plano " + NOMES_PLANO[plano] + " · teste grátis. Você pode mudar de plano quando quiser.";
    form.parentNode.insertBefore(faixa, form);
  }
  var lembrado = null;
  try { lembrado = localStorage.getItem("denia_email"); } catch (e) { lembrado = null; }
  if (acao === "entrar" && lembrado && form.email && !form.email.value) { form.email.value = lembrado; if (form.lembrar) form.lembrar.checked = true; }

  function enviar(url, dados, sucesso) {
    botao.disabled = true;
    botao.textContent = "Aguarde…";
    fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-denia": "1" }, body: JSON.stringify(dados) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, dados: d }; }); })
      .then(function (res) {
        if (res.ok) { sucesso(res.dados); return; }
        mostrar(erro, res.dados && res.dados.erro ? res.dados.erro : "Não foi possível concluir. Tente novamente.");
      })
      .catch(function () { mostrar(erro, "Sem conexão. Verifique a internet e tente novamente."); })
      .finally(function () { botao.disabled = acao === "redefinir" && !token; botao.textContent = textoBotao; });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    limpar();
    var email = form.email ? form.email.value.trim() : "";
    if (acao === "entrar") {
      if (!email || !form.senha.value) { mostrar(erro, "Informe o e-mail e a senha."); return; }
      try { if (form.lembrar.checked) localStorage.setItem("denia_email", email); else localStorage.removeItem("denia_email"); } catch (x) { /* navegação privada */ }
      enviar("/api/entrar", { email: email, senha: form.senha.value, lembrar: form.lembrar.checked }, function () { location.replace("/app"); });
    } else if (acao === "cadastro") {
      if (!form.nome.value.trim() || !form.empresa.value.trim() || !email || !form.senha.value) { mostrar(erro, "Preencha todos os campos."); return; }
      if (!form.aceite.checked) { mostrar(erro, "Para criar a conta, aceite os Termos de uso e a Política de privacidade."); return; }
      enviar("/api/cadastro", { nome: form.nome.value.trim(), empresa: form.empresa.value.trim(), email: email, senha: form.senha.value, plano: NOMES_PLANO[plano] ? plano : "", aceite: form.aceite.checked, idioma: (document.documentElement.lang || "pt-BR") }, function () { location.replace("/app"); });
    } else if (acao === "recuperar") {
      if (!email) { mostrar(erro, "Informe o seu e-mail."); return; }
      enviar("/api/senha/esqueci", { email: email }, function (d) {
        mostrar(ok, d.por_email
          ? "Pronto! Se este e-mail estiver cadastrado, você vai receber um link para criar uma senha nova. Ele vale por 30 minutos — confira também a caixa de spam."
          : "Pedido registrado. O envio automático por e-mail ainda não está ativado: peça ao responsável pela sua empresa para gerar uma nova senha em Equipe → Nova senha.");
        form.reset();
      });
    } else if (acao === "redefinir") {
      if (form.senha.value !== form.confirmar.value) { mostrar(erro, "As senhas não são iguais."); return; }
      enviar("/api/senha/redefinir", { token: token, nova: form.senha.value }, function () {
        mostrar(ok, "Senha atualizada! Você já pode entrar com a senha nova.");
        form.reset();
        setTimeout(function () { location.replace("/entrar"); }, 2200);
      });
    }
  });
})();
