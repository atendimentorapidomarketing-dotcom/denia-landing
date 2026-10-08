// DENIA — acesso ao painel
(function () {
  "use strict";
  var form = document.getElementById("form-entrar");
  var botao = document.getElementById("botao");
  var erro = document.getElementById("erro");

  function mostrarErro(texto) {
    erro.textContent = texto;
    erro.classList.remove("oculto");
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    erro.classList.add("oculto");
    var email = form.email.value.trim();
    var senha = form.senha.value;
    if (!email || !senha) { mostrarErro("Informe o e-mail e a senha."); return; }
    botao.disabled = true;
    botao.textContent = "Entrando…";
    fetch("/api/entrar", {
      method: "POST",
      headers: { "content-type": "application/json", "x-denia": "1" },
      body: JSON.stringify({ email: email, senha: senha })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, dados: d }; }); })
      .then(function (res) {
        if (res.ok) { window.location.replace("/app"); return; }
        mostrarErro(res.dados && res.dados.erro ? res.dados.erro : "Não foi possível entrar.");
      })
      .catch(function () { mostrarErro("Sem conexão. Verifique a internet e tente novamente."); })
      .finally(function () { botao.disabled = false; botao.textContent = "Entrar"; });
  });
})();
