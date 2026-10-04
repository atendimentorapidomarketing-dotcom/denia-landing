# DENIA Platform V15 — Mobile Locked

Esta versão corrige especificamente o deslocamento lateral no celular.

## Correções
- página presa à largura exata da tela;
- não existe rolagem horizontal do documento;
- remove "margens brancas" ao arrastar para os lados;
- fundo do `html` e `body` igual ao fundo da DENIA;
- bloqueio de overscroll lateral;
- `viewport-fit=cover` em todas as páginas;
- landing, login, cadastro e painel corrigidos;
- menu mobile continua em gaveta;
- cards não criam largura fantasma;
- efeitos 3D são desligados no touch;
- canvas e efeitos visuais não aumentam a largura do documento;
- modais respeitam 100% da largura móvel;
- telas de conversas, treinamento e profissionais ficam dentro do viewport.

## Deploy
Substitua os arquivos atuais do repositório `denia-landing` pelos arquivos desta versão.

Build:
npm run build

Deploy:
npx wrangler deploy

Root:
/

Não altere D1, bindings, secrets ou variáveis.
