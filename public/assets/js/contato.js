// DENIA — formulário de contato
(function () {
  "use strict";
  var form = document.getElementById("form-contato");
  if (!form) return;
  var botao = document.getElementById("c-botao"), erro = document.getElementById("c-erro"), ok = document.getElementById("c-ok");
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    erro.classList.add("oculto"); ok.classList.add("oculto");
    var dados = { nome: form.nome.value.trim(), empresa: form.empresa.value.trim(), email: form.email.value.trim(), telefone: form.telefone.value.trim(), assunto: form.assunto.value, mensagem: form.mensagem.value.trim(), site: form.site.value };
    if (!dados.nome || !dados.email || !dados.mensagem) { erro.textContent = "Preencha nome, e-mail e mensagem."; erro.classList.remove("oculto"); return; }
    botao.disabled = true; botao.textContent = "Enviando…";
    fetch("/api/contato", { method: "POST", headers: { "content-type": "application/json", "x-denia": "1" }, body: JSON.stringify(dados) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok) { form.reset(); ok.textContent = "Mensagem enviada! Obrigado pelo contato — respondemos em até um dia útil."; ok.classList.remove("oculto"); return; }
        erro.textContent = res.d.erro || "Não foi possível enviar. Tente novamente."; erro.classList.remove("oculto");
      })
      .catch(function () { erro.textContent = "Sem conexão. Verifique a internet e tente novamente."; erro.classList.remove("oculto"); })
      .finally(function () { botao.disabled = false; botao.textContent = "Enviar mensagem"; });
  });
})();
