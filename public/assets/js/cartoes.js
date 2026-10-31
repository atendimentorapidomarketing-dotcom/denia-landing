// Folha de cartões e display de avaliação com QR code. Os dados vêm depois do # (não vão para o servidor).
(function () {
  const p = new URLSearchParams(location.hash.slice(1));
  const nome = p.get("nome") || "", link = p.get("link") || "", tipo = p.get("tipo") === "display" ? "display" : "cartoes";
  const folha = document.getElementById("folha");
  if (!/^https:\/\//.test(link)) { folha.textContent = "Link de avaliação inválido."; return; }
  const q = qrcode(0, "M"); q.addData(link); q.make();
  const svg = () => { const d = document.createElement("div"); d.innerHTML = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); return d.firstElementChild; };
  const el = (tag, cls, texto) => { const e = document.createElement(tag); if (cls) e.className = cls; if (texto != null) e.textContent = texto; return e; };
  if (tipo === "display") {
    const d = el("div", "d");
    d.append(el("h1", "", "Sua opinião faz a diferença"));
    const pp = el("p"); pp.append("Avalie a ", el("b", "", nome), " no Google"); d.append(pp);
    const qd = el("div", "qd"); qd.append(svg()); d.append(qd);
    d.append(el("p", "s", "Aponte a câmera do celular para o código. Leva menos de 1 minuto."), el("p", "estrelas", "★★★★★"));
    folha.append(d);
  } else {
    const g = el("div", "grade");
    for (let i = 0; i < 10; i++) {
      const c = el("div", "c"), t = el("div", "t");
      t.append(el("b", "", "Gostou do atendimento?"), el("span", "", `Avalie a ${nome} no Google`), el("span", "estrelas", "★★★★★"), el("small", "", "Aponte a câmera do celular para o código"));
      const qq = el("div", "q"); qq.append(svg());
      c.append(t, qq); g.append(c);
    }
    folha.append(g);
  }
  document.title = `${tipo === "display" ? "Display" : "Cartões"} de avaliação — ${nome}`;
  setTimeout(() => window.print(), 400);
})();
