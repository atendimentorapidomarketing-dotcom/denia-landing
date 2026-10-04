# DENIA Platform V13 — Standalone

Objetivo: permitir que a equipe use e explore toda a plataforma AGORA,
sem depender da DENIA Engine, WhatsApp, Meta ou OpenAI.

Funciona:
- login real
- D1 real
- todos os menus abrem
- nenhum carregamento infinito
- conversas de teste locais
- criar/enviar mensagens no ambiente de teste
- pausar/reativar IA na conversa de teste
- treinamento por abas, persistido no D1
- cadastro/exclusão de profissionais
- configurações
- relatório de prévia
- filtros de desempenho
- botões Meta/OpenAI/WhatsApp respondem com informações claras
- experiência imersiva com mouse/toque e partículas

Não usa dados reais de clientes.
Não envia WhatsApp.
Não depende da Engine.

Para publicar:
- substitua os arquivos da V12 pelos arquivos desta V13 no repositório denia-landing
- Build: npm run build
- Deploy: npx wrangler deploy
- Root: /

O D1 existente `denia-saas` continua sendo usado.
As tabelas novas são criadas automaticamente no primeiro acesso.

Depois, quando quisermos dados reais, conectamos a Engine às mesmas telas sem reconstruir o painel.
