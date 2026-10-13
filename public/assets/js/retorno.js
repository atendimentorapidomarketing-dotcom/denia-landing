// Volta do Login do Facebook: segue para a plataforma por uma navegação do próprio site
// (assim o cookie de sessão, que é SameSite=Strict, vai junto).
(function () {
  "use strict";
  var a = document.getElementById("seguir");
  if (a && a.getAttribute("href").indexOf("/app") === 0) setTimeout(function () { location.replace(a.getAttribute("href")); }, 600);
})();
