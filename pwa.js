(function(){
 if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));
 let promptEvent=null;
 window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();promptEvent=e;document.querySelectorAll('[data-install-denia]').forEach(b=>b.hidden=false)});
 async function install(){
   const installed=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
   if(installed){alert('A DENIA já está instalada neste aparelho.');return}
   if(promptEvent){promptEvent.prompt();await promptEvent.userChoice.catch(()=>{});promptEvent=null;return}
   if(/iphone|ipad|ipod/i.test(navigator.userAgent)){document.getElementById('iosInstallHelp')?.classList.add('open');return}
   alert('Abra o menu do navegador e escolha “Instalar app” ou “Adicionar à tela inicial”.');
 }
 document.addEventListener('click',e=>{
   if(e.target.closest('[data-install-denia]'))install();
   if(e.target.closest('[data-close-ios-help]'))document.getElementById('iosInstallHelp')?.classList.remove('open');
 });
})();
