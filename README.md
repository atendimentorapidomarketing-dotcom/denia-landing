# DENIA Platform V12 — Painel corrigido + experiência imersiva

Corrige o travamento da V11 em "Carregando...".

Causa real:
o app.js da V11 ainda tentava registrar eventos em elementos antigos (#saveTraining etc.)
que já não existiam. Isso interrompia todo o JavaScript do painel.

Correções:
- JavaScript não quebra mais quando um elemento não existe
- timeout de 12 s no navegador
- timeout de 10 s na comunicação Worker -> Engine
- erros claros em vez de carregamento infinito
- diagnóstico explícito para URL/token da Engine
- remove rota antiga que verificava DENIA_ENGINE_BASE_URL errada
- luz interativa no mouse e no toque
- partículas no fundo
- cards 3D
- botões com ripple
- carregadores futuristas
- painel visualmente alinhado à landing

Pré-requisitos que já devem existir:
- DENIA Engine V28 publicada
- DENIA_ENGINE_URL na Platform apontando para o Worker que responde WhatsApp
- DENIA_PLATFORM_SERVICE_TOKEN igual na Engine e Platform

Teste depois do deploy:
1. /app
2. Visão geral: DENIA Engine deve mostrar Online ou um erro explícito
3. Conversas
4. Treinar IA
5. Profissionais

Se a integração falhar, abra:
`/api/engine/diagnostic`
enquanto estiver logado.
A resposta informa URL configurada, token configurado e erro real.
