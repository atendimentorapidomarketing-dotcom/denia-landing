// DENIA — criar conta
(function () {
  "use strict";
  var form = document.getElementById("form-cadastro");
  var botao = document.getElementById("botao");
  var erro = document.getElementById("erro");
  function mostrarErro(texto) { erro.textContent = texto; erro.classList.remove("oculto"); }
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    erro.classList.add("oculto");
    var dados = { nome: form.nome.value.trim(), empresa: form.empresa.value.trim(), email: form.email.value.trim(), senha: form.senha.value };
    if (!dados.nome || !dados.empresa || !dados.email || !dados.senha) { mostrarErro("Preencha todos os campos."); return; }
    botao.disabled = true;
    botao.textContent = "Criando…";
    fetch("/api/cadastro", { method: "POST", headers: { "content-type": "application/json", "x-denia": "1" }, body: JSON.stringify(dados) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, dados: d }; }); })
      .then(function (res) {
        if (res.ok) { window.location.replace("/app"); return; }
        mostrarErro(res.dados && res.dados.erro ? res.dados.erro : "Não foi possível criar a conta.");
      })
      .catch(function () { mostrarErro("Sem conexão. Verifique a internet e tente novamente."); })
      .finally(function () { botao.disabled = false; botao.textContent = "Criar conta"; });
  });
})();
