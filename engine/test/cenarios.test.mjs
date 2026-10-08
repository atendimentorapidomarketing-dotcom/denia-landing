import { test } from "node:test";
import assert from "node:assert/strict";
import { criarAmbiente } from "./harness.mjs";

const CLI = "5521911112222";
const CLI2 = "5521933334444";
const CHAVEIRO = "5521964545279", ANDERSON_REFORMA = "5521987506366";
const CARLOS_ESTOF = "5521983838318", CARLOS_ASSIST = "5511992197178";

const decisao = (o) => ({ resposta: "", intencao: "CONVERSA", novo_pedido: false, quer_orcamento_ou_atendimento: false, pronto_para_profissional: false, fatos: {}, resposta_para_profissional: "", descricao_anexos: "", comprovante_pagamento: false, precisa_humano: false, motivo_humano: "", resumo_caso: "", ...o });
const prest = (o) => ({ tipo: "COMENTARIO", valor_centavos: 0, valor_e_final: "NAO_INFORMADO", disponibilidade: "", atende_regiao: "NAO_INFORMADO", pergunta_para_cliente: "", resposta_conhecida: "", mensagem_para_cliente: "", resumo: "", ...o });

async function iniciarConsultaChaveiro(a, tel = CLI) {
  a.llmCliente = () => decisao({ resposta: "Perfeito, vou consultar o profissional.", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { servico: "chaveiro", problema: "troca de fechadura", bairro: "Botafogo" } });
  await a.cliente(tel, "Preciso trocar a fechadura, é em Botafogo");
}

test("Cenário 1 — chaveiro: não repete pergunta, consulta o chaveiro certo uma única vez", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Claro! O que aconteceu com a fechadura ou a chave?", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, fatos: { servico: "chaveiro" } });
  await a.cliente(CLI, "Preciso de um chaveiro");
  assert.match(a.ultimoPara(CLI), /O que aconteceu/);
  assert.equal(a.para(CHAVEIRO).length, 0, "não consulta sem saber o que fazer");

  a.llmCliente = (entrada) => {
    assert.match(entrada, /Serviço: chaveiro/, "o prompt já traz o serviço informado");
    return decisao({ resposta: "Perfeito, vou consultar o profissional.", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { problema: "troca de fechadura", bairro: "Botafogo" } });
  };
  await a.cliente(CLI, "Trocar a fechadura. Botafogo");
  assert.equal(a.para(CHAVEIRO).length, 1, "consulta enviada ao Anderson CHAVEIRO");
  assert.equal(a.para(ANDERSON_REFORMA).length, 0, "nunca o Anderson da reforma");
  assert.match(a.para(CHAVEIRO)[0].texto, /Caso #\d+/);
  assert.doesNotMatch(a.para(CHAVEIRO)[0].texto, new RegExp(CLI), "telefone do cliente não vai ao prestador");
  assert.match(a.ultimoPara(CLI), /^Enviamos sua solicitação ao profissional/);

  a.llmCliente = () => decisao({ resposta: "Qual serviço você precisa? Em qual bairro?", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, intencao: "PERGUNTA_STATUS" });
  await a.cliente(CLI, "E aí, alguma novidade?");
  assert.equal(a.para(CHAVEIRO).length, 1, "não reenvia consulta");
  assert.doesNotMatch(a.ultimoPara(CLI), /servi[cç]o|bairro/i, "não repete perguntas já respondidas");
  assert.match(a.ultimoPara(CLI), /aguardamos o retorno/);
});

test("Cenário 2 — várias mensagens rápidas geram uma única resposta", async () => {
  const a = await criarAmbiente({ env: { JANELA_AGRUPAMENTO_MS: "40" } });
  a.llmCliente = (entrada) => { assert.match(entrada, /- Oi\n- preciso de marceneiro\n- é em Botafogo/); return decisao({ resposta: "Olá! O que você gostaria de fazer?", fatos: { servico: "marcenaria", bairro: "Botafogo" } }); };
  await Promise.all([a.cliente(CLI, "Oi"), a.cliente(CLI, "preciso de marceneiro"), a.cliente(CLI, "é em Botafogo")]);
  assert.equal(a.llm.filter(x => x.papel === "cliente").length, 1);
  assert.equal(a.para(CLI).length, 1);
});

test("Cenários 4 e 5 — atendente humano (inclusive áudio) pausa só aquela conversa por 10 min e entra na memória", async () => {
  const a = await criarAmbiente();
  a.transcricaoAtual = "O orçamento ficou R$ 2.790 e terça às 10 está disponível.";
  await a.eco(CLI, "", { type: "audio", raw: { audio: { id: "media-audio-1", mime_type: "audio/ogg" } } });
  a.llmCliente = () => decisao({ resposta: "Olá!" });
  await a.cliente(CLI, "Perfeito");
  assert.equal(a.para(CLI).length, 0, "IA calada durante a pausa");
  await a.cliente(CLI2, "Oi");
  assert.equal(a.para(CLI2).length, 1, "outra conversa segue normal");

  a.avancar(11 * 60 * 1000);
  a.llmCliente = (entrada) => {
    assert.match(entrada, /ATENDENTE HUMANO: \[Áudio do atendente transcrito\] O orçamento ficou R\$ 2\.790/);
    assert.match(entrada, /CLIENTE: Perfeito/, "mensagem recebida durante a pausa foi registrada");
    return decisao({ resposta: "Não precisa estar presente, basta alguém para abrir a porta." });
  };
  await a.cliente(CLI, "Preciso estar aí pessoalmente?");
  assert.match(a.ultimoPara(CLI), /Não precisa/);
});

test("Cenário 7 — prestador: +50% só quando é a parte dele, cliente aceita, prestador confirma, Telegram", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Certo!", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { servico: "troca de tecido do sofá", bairro: "Copacabana" } });
  await a.cliente(CLI, "Quero trocar o tecido do sofá, moro em Copacabana", { nome: "Maria" });
  assert.equal(a.para(CARLOS_ESTOF).length, 1, "Carlos ESTOFADOR");
  assert.equal(a.para(CARLOS_ASSIST).length, 0, "nunca o Carlos da assistência técnica");

  a.llmPrestador = () => prest({ tipo: "ACEITA", valor_centavos: 40000, disponibilidade: "amanhã às 14h" });
  await a.cliente(CARLOS_ESTOF, "Faço sim, amanhã às 14h, 400");
  assert.match(a.ultimoPara(CARLOS_ESTOF), /valor final para o cliente ou é somente a sua parte/);
  assert.equal(a.para(CLI).length, 1, "cliente ainda não recebe valor ambíguo");

  a.llmPrestador = () => prest({ tipo: "COMENTARIO", valor_e_final: "NAO" });
  await a.cliente(CARLOS_ESTOF, "só minha parte");
  assert.equal(a.ultimoPara(CLI), "O profissional pode atender amanhã às 14h. O valor fica R$ 600,00. Podemos confirmar?");

  a.llmCliente = () => decisao({ resposta: "Que ótimo!", intencao: "ACEITA_PROPOSTA" });
  await a.cliente(CLI, "Sim, pode ser");
  assert.match(a.ultimoPara(CLI), /endereço completo/);
  a.llmCliente = () => decisao({ resposta: "Obrigado!", fatos: { endereco: "Rua Barata Ribeiro, 200, apto 301" } });
  await a.cliente(CLI, "Rua Barata Ribeiro, 200, apto 301");
  const pedidoConf = a.ultimoPara(CARLOS_ESTOF);
  assert.match(pedidoConf, /aprovou o valor de R\$ 400,00 para amanhã às 14h/, "prestador vê o valor DELE, não o do cliente");
  assert.match(pedidoConf, /Barata Ribeiro/);
  assert.match(a.ultimoPara(CLI), /Vamos confirmar com o profissional/);
  assert.equal(a.DB.q("SELECT etapa FROM d30_casos")[0].etapa, "AGUARDANDO_CONFIRMACAO_PRESTADOR", "aceite do cliente NÃO é agendamento");

  const chamadas = a.llm.length;
  await a.cliente(CLI, "ok");
  assert.equal(a.llm.length, chamadas, "'ok' sem pergunta pendente não gera resposta nem chamada à IA");

  a.llmPrestador = () => prest({ tipo: "CONFIRMA_AGENDAMENTO" });
  await a.cliente(CARLOS_ESTOF, "Confirmado");
  assert.equal(a.ultimoPara(CLI), "Atendimento confirmado pelo profissional: amanhã às 14h. Valor: R$ 600,00.");
  assert.equal(a.DB.q("SELECT etapa FROM d30_casos")[0].etapa, "AGENDADO");
  assert.ok(a.telegram.some(t => /SERVIÇO AGENDADO[\s\S]*Maria[\s\S]*Carlos \(estofador\)[\s\S]*R\$\s600,00/.test(t)));

  // Cenário 6 — caso maduro: pedido de ajuste vai ao prestador, sem recomeçar a coleta.
  a.llmCliente = (entrada) => {
    assert.match(entrada, /Etapa: AGENDADO/);
    return decisao({ resposta: "Qual serviço você precisa?", intencao: "PEDE_ALTERACAO", resposta_para_profissional: "O cliente pergunta se é possível chegar meia hora mais tarde (14h30)" });
  };
  await a.cliente(CLI, "Tem como chegar meia hora mais tarde?");
  assert.match(a.ultimoPara(CARLOS_ESTOF), /meia hora mais tarde/);
  assert.equal(a.ultimoPara(CLI), "Vamos verificar com o profissional e já retornamos.");
  a.llmPrestador = () => prest({ tipo: "RESPONDE", mensagem_para_cliente: "O profissional pode chegar às 14h30." });
  await a.cliente(CARLOS_ESTOF, "pode sim 14h30");
  assert.equal(a.ultimoPara(CLI), "O profissional pode chegar às 14h30.");
});

test("Cenário 6 — caso antigo AGENDADO: 'Bom dia' não recomeça o atendimento", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Oi!" });
  await a.cliente(CLI, "oi");
  const pessoa = a.DB.q("SELECT id FROM pessoas WHERE telefone=?", CLI)[0];
  a.DB.db.prepare("INSERT INTO casos(empresa_id,cliente_id,status,titulo,problema,bairro,criado_em,atualizado_em) VALUES(1,?,'AGENDADO','Marcenaria','Armário do banheiro','Botafogo',datetime('now'),datetime('now'))").run(pessoa.id);
  a.llmCliente = (entrada) => {
    assert.match(entrada, /Etapa: AGENDADO/);
    assert.match(entrada, /Solicitação: Armário do banheiro/);
    return decisao({ resposta: "Bom dia! Qual serviço você precisa?" });
  };
  await a.cliente(CLI, "Bom dia");
  assert.equal(a.ultimoPara(CLI), "Bom dia!");
});

test("Duplicidade de nomes — geladeira vai para Carlos da assistência técnica", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Ok", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { servico: "conserto de geladeira", problema: "geladeira não gela", categoria: "ESTOFADOR" } });
  await a.cliente(CLI, "Minha geladeira não gela");
  assert.equal(a.para(CARLOS_ASSIST).length, 1);
  assert.equal(a.para(CARLOS_ESTOF).length, 0, "a regra determinística vence a sugestão errada da IA");
});

test("Prestador com 'Eita, Niterói' não vira ação; vai só para a equipe", async () => {
  const a = await criarAmbiente();
  await iniciarConsultaChaveiro(a);
  const antes = a.para(CLI).length;
  a.llmPrestador = () => prest({ tipo: "COMENTARIO" });
  await a.cliente(CHAVEIRO, "Eita, Niterói");
  assert.equal(a.para(CLI).length, antes, "nada enviado ao cliente");
  assert.equal(a.para(CHAVEIRO).length, 1, "nada respondido ao prestador");
  assert.ok(a.telegram.some(t => /Eita, Niterói[\s\S]*Nenhuma ação automática/.test(t)));
});

test("Prestador pergunta 'que cliente?' e recebe o contexto do caso certo", async () => {
  const a = await criarAmbiente();
  await iniciarConsultaChaveiro(a);
  a.llmPrestador = () => prest({ tipo: "PEDE_CONTEXTO" });
  await a.cliente(CHAVEIRO, "Que cliente? Verificar o quê?");
  const r = a.ultimoPara(CHAVEIRO);
  assert.match(r, /Caso #\d+[\s\S]*troca de fechadura[\s\S]*Botafogo/);
  assert.doesNotMatch(r, new RegExp(CLI));
});

test("Pergunta do prestador vai ao cliente e a resposta volta ao prestador", async () => {
  const a = await criarAmbiente();
  await iniciarConsultaChaveiro(a);
  a.llmPrestador = () => prest({ tipo: "PERGUNTA", pergunta_para_cliente: "Para o orçamento, a fechadura é de porta de madeira ou de metal?" });
  await a.cliente(CHAVEIRO, "é porta de madeira ou metal?");
  assert.equal(a.ultimoPara(CLI), "Para o orçamento, a fechadura é de porta de madeira ou de metal?");
  a.llmCliente = (e) => { assert.match(e, /PERGUNTA DO PROFISSIONAL PENDENTE/); return decisao({ resposta: "Ok", resposta_para_profissional: "Porta de madeira." }); };
  await a.cliente(CLI, "madeira");
  assert.match(a.ultimoPara(CHAVEIRO), /resposta do cliente: Porta de madeira/);
  assert.equal(a.ultimoPara(CLI), "Obrigado! Vamos repassar ao profissional.");
});

test("Preço inventado pela IA é bloqueado", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Esse serviço fica R$ 350. Quer agendar para amanhã?", fatos: { servico: "pintura" } });
  await a.cliente(CLI, "Quanto custa pintar um quarto?");
  assert.doesNotMatch(a.ultimoPara(CLI), /350/);
});

test("Prestador com dois casos: pergunta qual é, e resposta citando a mensagem vai ao cliente certo", async () => {
  const a = await criarAmbiente();
  await iniciarConsultaChaveiro(a, CLI);
  await iniciarConsultaChaveiro(a, CLI2);
  const consultas = a.para(CHAVEIRO);
  assert.equal(consultas.length, 2);
  a.llmPrestador = () => prest({ tipo: "ACEITA", valor_centavos: 20000, valor_e_final: "SIM", disponibilidade: "hoje às 18h" });
  await a.cliente(CHAVEIRO, "Faço por 200, hoje às 18h");
  assert.match(a.ultimoPara(CHAVEIRO), /mais de um atendimento/);
  const segunda = consultas[1];
  await a.webhook({ contacts: [{ wa_id: CHAVEIRO }], messages: [{ id: "wamid.ctx.1", from: CHAVEIRO, timestamp: String(Math.floor(a.agora / 1000)), type: "text", text: { body: "Faço por 200, hoje às 18h" }, context: { id: segunda.id } }] });
  assert.match(a.ultimoPara(CLI2), /R\$ 200,00/, "valor final informado: sem acréscimo");
  assert.doesNotMatch(a.ultimoPara(CLI) || "", /R\$ 200/, "o outro cliente não recebe nada");
});

test("Falha da Meta: cliente não recebe 'enviamos' e equipe é avisada", async () => {
  const a = await criarAmbiente();
  a.metaFalha = (corpo) => corpo.to === CHAVEIRO ? { code: 131047, message: "Re-engagement message" } : null;
  await iniciarConsultaChaveiro(a);
  assert.equal(a.ultimoPara(CLI), "Um momento, por favor.");
  assert.ok(a.telegram.some(t => /fora da janela de 24h/.test(t)));
});

test("Fora da janela de 24h com template configurado: usa o template", async () => {
  const a = await criarAmbiente({ env: { WHATSAPP_TEMPLATE_CONSULTA_TECNICO: "consulta_prestador" } });
  a.metaFalha = (corpo) => corpo.to === CHAVEIRO && corpo.type === "text" ? { code: 131047, message: "Re-engagement message" } : null;
  await iniciarConsultaChaveiro(a);
  assert.equal(a.para(CHAVEIRO)[0].type, "template");
  assert.match(a.ultimoPara(CLI), /^Enviamos/);
});

test("À noite a consulta fica para as 8h (cron), sem mandar nada ao prestador", async () => {
  const a = await criarAmbiente({ inicio: "2026-10-07T22:30:00-03:00" });
  await iniciarConsultaChaveiro(a);
  assert.equal(a.para(CHAVEIRO).length, 0);
  assert.match(a.ultimoPara(CLI), /a partir das 8h/);
  await a.cron();
  assert.equal(a.para(CHAVEIRO).length, 0, "cron não envia fora do horário");
  a.avancar(10 * 3600 * 1000);
  await a.cron();
  assert.equal(a.para(CHAVEIRO).length, 1, "enviado às 8h30");
  await a.cron();
  assert.equal(a.para(CHAVEIRO).length, 1, "uma única vez");
});

test("Mensagem antiga (Meta reenviando depois de 20 min) não é respondida, só registrada", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Olá!" });
  await a.cliente(CLI, "Oi", { ts: a.agora - 20 * 60 * 1000 });
  assert.equal(a.para(CLI).length, 0);
  assert.equal(a.DB.q("SELECT COUNT(*) n FROM mensagens")[0].n, 1);
  assert.ok(a.telegram.some(t => /atraso/.test(t)));
});

test("Mesmo webhook duas vezes não gera resposta duplicada", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Olá! Como podemos ajudar?" });
  const m = a.msg(CLI, "Oi");
  await a.webhook(m); await a.webhook(m);
  assert.equal(a.para(CLI).length, 1);
});

test("Prestador com wa_id sem o nono dígito é reconhecido como prestador", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => { throw new Error("não deveria tratar como cliente"); };
  await a.cliente("552164545279", "Bom dia");
  assert.equal(a.llm.filter(x => x.papel === "cliente").length, 0);
  assert.equal(a.enviados.length, 0);
});

test("Assinatura da Meta: sem assinatura válida -> 401", async () => {
  const a = await criarAmbiente({ env: { META_APP_SECRET: "segredo-app" } });
  a.llmCliente = () => decisao({ resposta: "Olá!" });
  assert.equal((await a.webhook(a.msg(CLI, "Oi"))).status, 401);
  assert.equal((await a.webhook(a.msg(CLI, "Oi"), { assinar: "segredo-app" })).status, 200);
  assert.equal(a.para(CLI).length, 1);
});

test("D1 fora do ar: o cliente ainda recebe resposta (contingência) e nada operacional é feito", async () => {
  const a = await criarAmbiente();
  a.DB.falhar = true;
  a.llmCliente = () => decisao({ resposta: "Olá! Como podemos ajudar?" });
  await a.cliente(CLI, "Oi");
  assert.equal(a.ultimoPara(CLI), "Olá! Como podemos ajudar?");
  a.llmCliente = () => decisao({ resposta: "Vou consultar o profissional.", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { servico: "chaveiro" } });
  a.avancar(3 * 60 * 1000);
  await a.cliente(CLI, "Preciso de chaveiro para trocar fechadura");
  assert.equal(a.ultimoPara(CLI), "Recebemos sua mensagem. Um atendente vai dar continuidade em instantes.");
  assert.equal(a.para(CHAVEIRO).length, 0, "nenhuma ação operacional sem o banco");
  assert.equal(a.telegram.filter(t => /CONTINGÊNCIA/.test(t)).length, 1);
});

test("Painel e treinamento: exige senha, importa o antigo, versiona e nunca apaga sem confirmar", async () => {
  const a = await criarAmbiente();
  const semSenha = await a.worker.fetch(new Request("https://denia.test/api/treinamento"), a.env, { waitUntil() { } });
  assert.equal(semSenha.status, 401);
  await a.http("/api/saude");
  a.DB.db.prepare("INSERT INTO treinamento_ia(empresa_id,treinamento_json) VALUES('1',?)").run(JSON.stringify({ instrucoes: "Seja cordial", precos: "Visita: R$ 80" }));
  let t = await (await a.http("/api/treinamento")).json();
  assert.equal(t.dados.instrucoes, "Seja cordial");
  let r = await a.http("/api/treinamento", { method: "POST", body: JSON.stringify({ treinamento: { regras: "Não atendemos domingo" } }) });
  t = await r.json();
  assert.equal(t.dados.instrucoes, "Seja cordial", "edição parcial preserva o resto");
  assert.equal(t.dados.regras, "Não atendemos domingo");
  r = await a.http("/api/treinamento", { method: "POST", body: JSON.stringify({ treinamento: { instrucoes: "" } }) });
  assert.equal(r.status, 409, "esvaziar um campo exige confirmação");
  const v = await (await a.http("/api/treinamento/versoes")).json();
  assert.ok(v.versoes.length >= 2);
  r = await a.http("/api/treinamento/restaurar", { method: "POST", body: JSON.stringify({ versao: v.versoes.at(-1).versao }) });
  assert.equal((await r.json()).dados.regras, "");
});

test("Preço autorizado no treinamento pode ser informado", async () => {
  const a = await criarAmbiente();
  await a.http("/api/saude");
  await a.http("/api/treinamento", { method: "POST", body: JSON.stringify({ treinamento: { precos: "Visita técnica: R$ 80" } }) });
  a.llmCliente = () => decisao({ resposta: "A visita técnica custa R$ 80. Quer agendar?" });
  await a.cliente(CLI, "Quanto é a visita?");
  assert.match(a.ultimoPara(CLI), /R\$ 80/);
});

test("Simulador do painel roda o fluxo sem enviar nada pela Meta", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Ok", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { servico: "chaveiro", problema: "cópia de chave" } });
  const r = await (await a.http("/api/teste", { method: "POST", body: JSON.stringify({ remetente: "cliente", texto: "Preciso de cópia de chave" }) })).json();
  assert.equal(a.enviados.length, 0);
  assert.ok(r.saidas.some(s => s.papel === "prestador" && /Caso #/.test(s.texto)));
  assert.ok(r.saidas.some(s => s.papel === "cliente" && /^Enviamos/.test(s.texto)));
  a.llmPrestador = () => prest({ tipo: "ACEITA", valor_centavos: 3000, valor_e_final: "SIM", disponibilidade: "hoje" });
  const r2 = await (await a.http("/api/teste", { method: "POST", body: JSON.stringify({ remetente: "CHAV-ANDERSON", texto: "faço por 30, hoje" }) })).json();
  assert.ok(r2.saidas.some(s => s.papel === "cliente" && /R\$\s30,00/.test(s.texto)));
  await a.http("/api/limpar-teste", { method: "POST" });
  assert.equal(a.DB.q("SELECT COUNT(*) n FROM d30_casos")[0].n, 0);
});

// ---------------------------------------------------------------------------
// V30.1 — problemas relatados em produção
// ---------------------------------------------------------------------------

test("V30.1 — D1 fora do ar: rajada de mensagens recebe no máximo 1 resposta e 1 aviso no Telegram", async () => {
  const a = await criarAmbiente({ env: { JANELA_AGRUPAMENTO_MS: "0", EQUIPE_TELEFONES: "5521955556666" } });
  a.DB.falhar = true;
  a.passo = 1000;
  a.llmCliente = () => decisao({ resposta: "Olá! Em qual bairro você está?" });
  for (let i = 0; i < 6; i++) await a.cliente(CLI, "mensagem " + i);
  assert.equal(a.para(CLI).length, 1, "uma resposta, não seis");
  await a.cliente("5521955556666", "sou da equipe");
  await a.cliente(CHAVEIRO, "posso amanhã");
  assert.equal(a.para("5521955556666").length, 0, "equipe nunca recebe resposta automática");
  assert.equal(a.para(CHAVEIRO).length, 0, "prestador nunca recebe resposta na contingência");
  assert.equal(a.telegram.length, 1, "um único aviso de contingência");
  a.avancar(3 * 60 * 1000);
  await a.cliente(CLI, "Botafogo");
  const r = a.ultimoPara(CLI);
  assert.ok(a.para(CLI).length <= 2);
  if (a.para(CLI).length === 2) assert.doesNotMatch(r, /bairro/i, "não pergunta o bairro de novo");
});

test("V30.1 — a IA insiste em perguntar o bairro: só a primeira pergunta sai", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Certo! Em qual bairro será o atendimento?", fatos: { servico: "pintura" } });
  await a.cliente(CLI, "Quero pintar um quarto");
  assert.match(a.ultimoPara(CLI), /bairro/);
  a.llmCliente = () => decisao({ resposta: "Entendi. Qual é o seu bairro?" });
  await a.cliente(CLI, "É um quarto de 12 m²");
  assert.equal(a.para(CLI).filter(m => /bairro/i.test(m.texto)).length, 1, "bairro perguntado uma vez só");
});

test("V30.1 — resposta curta logo após a pergunta é registrada como o dado perguntado", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Claro! Em qual bairro?", fatos: { servico: "pintura" } });
  await a.cliente(CLI, "Quero pintar um quarto");
  a.llmCliente = () => decisao({ resposta: "Obrigado!" });
  await a.cliente(CLI, "Botafogo");
  const f = JSON.parse(a.DB.q("SELECT fatos_json FROM d30_casos")[0].fatos_json);
  assert.equal(f.bairro, "Botafogo");
});

test("V30.1 — trava de segurança: nunca mais de 4 mensagens em 2 minutos para o mesmo contato", async () => {
  const a = await criarAmbiente();
  a.passo = 1000;
  let n = 0;
  a.llmCliente = () => decisao({ resposta: "Resposta diferente número " + (++n) + "." });
  for (let i = 0; i < 9; i++) await a.cliente(CLI, "msg " + i);
  assert.equal(a.para(CLI).length, 4);
  assert.ok(a.telegram.some(t => /TRAVA DE SEGURANÇA/.test(t)));
  assert.equal(a.telegram.filter(t => /TRAVA/.test(t)).length, 1, "aviso da trava uma vez só");
});

test("V30.1 — botão de emergência pausa todos os envios automáticos", async () => {
  const a = await criarAmbiente();
  await a.http("/api/pausa-geral", { method: "POST", body: JSON.stringify({ ativa: true }) });
  a.llmCliente = () => decisao({ resposta: "Olá!" });
  await a.cliente(CLI, "Oi");
  assert.equal(a.para(CLI).length, 0);
  await a.http("/api/pausa-geral", { method: "POST", body: JSON.stringify({ ativa: false }) });
  a.avancar(30000);
  await a.cliente(CLI, "Oi de novo");
  assert.equal(a.para(CLI).length, 1);
});

test("V30.1 — Telegram tem teto de alertas por hora", async () => {
  const a = await criarAmbiente();
  a.passo = 0;
  a.llmPrestador = () => prest({ tipo: "COMENTARIO" });
  await iniciarConsultaChaveiro(a);
  for (let i = 0; i < 25; i++) await a.cliente(CHAVEIRO, "comentário solto " + i);
  assert.ok(a.telegram.length <= 13, `foram ${a.telegram.length} alertas`);
});

// ---------------------------------------------------------------------------
// V30.2 — roteamento pelo treinamento, cliente antigo, certeza de valor, login, cadastro
// ---------------------------------------------------------------------------
const WILLIAM = "5521966142206";

test("V30.2 — aparelho ligado no 220 V NUNCA vai para o eletricista", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Poxa, que chato! Vamos ver isso.", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, categoria_confianca: "ALTA", fatos: { servico: "conserto de micro-ondas", problema: "liguei o micro-ondas na tomada 220v e queimou", categoria: "ELETRICA" } });
  await a.cliente(CLI, "Liguei meu micro-ondas na tomada 220v e queimou");
  assert.equal(a.para(WILLIAM).length, 0, "eletricista não recebe");
  assert.doesNotMatch(a.ultimoPara(CLI), /^Enviamos/);
  assert.ok(a.telegram.some(t => /não tenho certeza|Sem prestador/.test(t)), "equipe é avisada");
});

test("V30.2 — geladeira queimada no 220 V vai para a assistência técnica, não para o eletricista", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Poxa!", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, categoria_confianca: "ALTA", fatos: { servico: "conserto de geladeira", problema: "geladeira queimou ao ligar na tomada 220v", categoria: "ASSISTENCIA_TECNICA" } });
  await a.cliente(CLI, "Minha geladeira queimou, liguei na tomada 220");
  assert.equal(a.para(WILLIAM).length, 0);
  assert.equal(a.para(CARLOS_ASSIST).length, 1);
});

test("V30.2 — categoria incerta: não consulta ninguém, equipe decide", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Entendi.", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, categoria_confianca: "MEDIA", fatos: { servico: "instalação de suporte de TV", categoria: "REFORMA" } });
  await a.cliente(CLI, "Quero instalar um suporte de TV");
  assert.equal(a.enviados.filter(e => e.to !== CLI).length, 0, "nenhum prestador consultado");
  assert.ok(a.telegram.some(t => /não tenho certeza/.test(t)));
});

test("V30.2 — cliente antigo: perfil, histórico e jeito das atendentes entram no contexto", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Oi!" });
  await a.cliente(CLI, "oi");
  const p = a.DB.q("SELECT id FROM pessoas WHERE telefone=?", CLI)[0];
  a.DB.db.prepare("UPDATE pessoas SET criado_em='2026-03-02 10:00:00', nome='Joana' WHERE id=?").run(p.id);
  a.DB.db.prepare("INSERT INTO casos(empresa_id,cliente_id,status,titulo,problema,bairro,criado_em) VALUES(1,?,'FINALIZADO','Marcenaria','Armário da cozinha','Botafogo','2026-04-10 10:00:00')").run(p.id);
  a.DB.db.prepare("INSERT INTO mensagens(empresa_id,pessoa_id,direcao,origem,conteudo) VALUES(1,?,'SAIDA','HUMANO','Oii Joana, tudo bem? Já já te passo o retorno, tá? 😊')").run(p.id);
  a.llmCliente = (e) => {
    assert.match(e, /Cliente desde 02\/03\/2026/);
    assert.match(e, /Armário da cozinha/);
    assert.match(e, /COMO A EQUIPE FALA[\s\S]*Já já te passo o retorno/);
    return decisao({ resposta: "Oi, Joana! Tudo bem? Como posso ajudar hoje?" });
  };
  a.avancar(5 * 60000);
  await a.cliente(CLI, "Oi, sou eu de novo");
  assert.ok(a.para(CLI).length >= 2);
});

test("V30.2 — ficha da plataforma de cadastro (CRM) entra no contexto", async () => {
  const a = await criarAmbiente({ env: { CRM_CONSULTA_URL: "https://crm.test/clientes", CRM_TOKEN: "crm-token" } });
  a.crmResposta = { cliente: "Joana", servicos: [{ data: "2026-05-01", servico: "Armário planejado", valor: 2790 }] };
  a.llmCliente = (e) => { assert.match(e, /FICHA NO SISTEMA[\s\S]*Armário planejado/); return decisao({ resposta: "Oi, Joana!" }); };
  await a.cliente(CLI, "Oi");
  assert.equal(a.crmConsultas.length, 1);
  assert.match(a.crmConsultas[0], /telefone=5521911112222/);
});

test("V30.2 — prestador manda dois valores: DENIA confirma antes; se continuar ambíguo, nada vai ao cliente", async () => {
  const a = await criarAmbiente();
  await iniciarConsultaChaveiro(a);
  const antes = a.para(CLI).length;
  a.llmPrestador = () => prest({ tipo: "ACEITA", valor_centavos: 40000, valor_e_final: "NAO", disponibilidade: "amanhã" });
  await a.cliente(CHAVEIRO, "Fica 400 ou 500, amanhã");
  assert.match(a.ultimoPara(CHAVEIRO), /valor TOTAL/);
  assert.equal(a.para(CLI).length, antes, "cliente não recebe valor incerto");
  a.llmPrestador = () => prest({ tipo: "ACEITA", valor_centavos: 50000, valor_e_final: "NAO" });
  await a.cliente(CHAVEIRO, "uns 450 ou 500");
  assert.equal(a.para(CLI).length, antes, "segue sem passar valor");
  assert.ok(a.telegram.some(t => /não consegui confirmar com certeza/.test(t)));
});

test("V30.2 — valor claro em uma mensagem passa direto", async () => {
  const a = await criarAmbiente();
  await iniciarConsultaChaveiro(a);
  a.llmPrestador = () => prest({ tipo: "ACEITA", valor_centavos: 15000, valor_e_final: "SIM", disponibilidade: "dia 15 às 10h" });
  await a.cliente(CHAVEIRO, "Faço dia 15 às 10h, 150 já é o valor final");
  assert.equal(a.ultimoPara(CLI), "O profissional pode atender dia 15 às 10h. O valor fica R$ 150,00. Podemos confirmar?");
});

test("V30.2 — login: página com senha e cookie de sessão", async () => {
  const a = await criarAmbiente();
  const sem = await a.worker.fetch(new Request("https://denia.test/chat"), a.env, { waitUntil() { } });
  assert.equal(sem.status, 302);
  assert.equal(sem.headers.get("location"), "/login");
  const pag = await a.worker.fetch(new Request("https://denia.test/login"), a.env, { waitUntil() { } });
  assert.match(await pag.text(), /type="password"/);
  const errado = await a.worker.fetch(new Request("https://denia.test/login", { method: "POST", body: new URLSearchParams({ senha: "x" }) }), a.env, { waitUntil() { } });
  assert.equal(errado.status, 401);
  const ok = await a.worker.fetch(new Request("https://denia.test/login", { method: "POST", body: new URLSearchParams({ senha: "senha-de-teste-123" }) }), a.env, { waitUntil() { } });
  assert.equal(ok.status, 302);
  const cookie = ok.headers.get("set-cookie").split(";")[0];
  const dentro = await a.worker.fetch(new Request("https://denia.test/chat", { headers: { cookie } }), a.env, { waitUntil() { } });
  assert.equal(dentro.status, 200);
  const aberto = await a.worker.fetch(new Request("https://denia.test/chat"), { ...a.env, PAINEL_SENHA: "" }, { waitUntil() { } });
  assert.equal(aberto.status, 200, "sem PAINEL_SENHA o painel abre direto");
});

test("V30.2 — casos e clientes sincronizam com a plataforma de cadastro, com confirmação", async () => {
  const a = await criarAmbiente({ env: { PLATAFORMA_API_URL: "https://plataforma.test/api", PLATAFORMA_API_TOKEN: "plat" } });
  await iniciarConsultaChaveiro(a);
  await a.cron();
  const eventos = a.plataforma.map(x => x.corpo.evento);
  assert.ok(eventos.includes("CLIENTE_ATUALIZADO"));
  assert.ok(eventos.includes("ATUALIZACAO"));
  const os = a.plataforma.find(x => x.corpo.atendimento);
  assert.equal(os.corpo.atendimento.problema, "troca de fechadura");
  assert.equal(os.headers.Authorization, "Bearer plat");
  const n = a.plataforma.length;
  await a.cron();
  assert.equal(a.plataforma.length, n, "não reenvia o que já foi confirmado");
});

const SERVICO = "token-de-servico-da-plataforma-123";
const api = (a, caminho, op = {}) => a.http(caminho, { ...op, headers: { authorization: "Bearer " + SERVICO, ...(op.headers || {}) } });

test("V30.3 — aprendizado: lê o histórico, sugere, só entra no treinamento depois de aprovado", async () => {
  const a = await criarAmbiente({ env: { DENIA_PLATFORM_SERVICE_TOKEN: SERVICO } });
  a.llmCliente = () => decisao({ resposta: "Oi! Como posso ajudar?" });
  await a.cliente(CLI, "Oi, vocês consertam máquina de lavar?");
  await a.eco(CLI, "Consertamos sim! O técnico de eletrodomésticos faz a visita.");
  await a.cliente(CLI2, "Meu telefone é 21 99999-8888, quanto custa a visita?");

  const sem = await a.http("/platform/learning");
  assert.equal(sem.status, 401, "API da plataforma exige o token de serviço");

  const ini = await (await api(a, "/platform/learning/start", { method: "POST", body: "{}" })).json();
  assert.equal(ini.status, "RODANDO");

  let transcricao = "";
  a.llmAprendizado = (e) => {
    transcricao = e;
    return { itens: [
      { tipo: "QUEM_ATENDE", titulo: "Máquina de lavar", conteudo: "Máquina de lavar é com o técnico de eletrodomésticos, nunca com o eletricista.", evidencia: "atendente" },
      { tipo: "ESTILO", titulo: "Confirmação simpática", conteudo: "Consertamos sim! 😊", evidencia: "atendente" },
      { tipo: "REGRA", titulo: "Dado pessoal", conteudo: "Pedir o CPF do cliente", evidencia: "x" },
      { tipo: "INVENTADO", titulo: "x", conteudo: "y" }
    ] };
  };
  await a.cron();
  assert.match(transcricao, /ATENDENTE: Consertamos sim/);
  assert.match(transcricao, /CLIENTE: Oi, vocês consertam/);
  assert.doesNotMatch(transcricao, /99999-8888|999998888/, "telefones mascarados antes de ir para a IA");

  await a.cron();
  const st = await (await api(a, "/platform/learning")).json();
  assert.equal(st.status, "CONCLUIDO");
  assert.equal(st.progresso, 100);
  assert.equal(st.sugestoes.PENDENTE, 2, "CPF e tipo inválido são descartados");

  const { sugestoes } = await (await api(a, "/platform/learning/suggestions")).json();
  const quem = sugestoes.find(s => s.tipo === "QUEM_ATENDE");
  const estilo = sugestoes.find(s => s.tipo === "ESTILO");

  let treino = (await (await api(a, "/platform/training")).json()).dados;
  assert.doesNotMatch(JSON.stringify(treino || {}), /Máquina de lavar/, "nada entra sem aprovação");

  const ok = await (await api(a, "/platform/learning/suggestions/" + quem.id, { method: "POST", body: JSON.stringify({ acao: "aprovar", autor: "Dono" }) })).json();
  assert.equal(ok.sucesso, true);
  await api(a, "/platform/learning/suggestions/" + estilo.id, { method: "POST", body: JSON.stringify({ acao: "rejeitar" }) });
  const de_novo = await api(a, "/platform/learning/suggestions/" + quem.id, { method: "POST", body: JSON.stringify({ acao: "aprovar" }) });
  assert.equal(de_novo.status, 409, "não decide duas vezes");

  treino = (await (await api(a, "/platform/training")).json()).dados;
  assert.match(treino.aprendizados, /\[quem atende\] Máquina de lavar: Máquina de lavar é com o técnico/);
  assert.doesNotMatch(treino.exemplos || "", /Consertamos sim! 😊/, "rejeitada não entra");

  a.llmCliente = (e) => { assert.match(e, /APRENDIZADOS APROVADOS[\s\S]*técnico de eletrodomésticos/); return decisao({ resposta: "Claro!" }); };
  await a.cliente(CLI, "Oi de novo");
});

test("V30.3 — importação do cadastro de clientes: telefone normalizado e ficha no contexto", async () => {
  const a = await criarAmbiente({ env: { DENIA_PLATFORM_SERVICE_TOKEN: SERVICO } });
  const r = await (await api(a, "/platform/import/clients", { method: "POST", body: JSON.stringify({ origem: "planilha.csv", linhas: [
    { telefone: "(21) 91111-2222", nome: "Joana Prado", ultimo_servico: "Conserto de geladeira em 05/2026" },
    { telefone: "123", nome: "Inválido" },
    { telefone: "21933334444" }
  ] }) })).json();
  assert.deepEqual([r.importadas, r.ignoradas], [1, 2]);
  const resumo = await (await api(a, "/platform/import/clients")).json();
  assert.equal(resumo.clientes, 1);
  a.llmCliente = (e) => { assert.match(e, /FICHA NO SISTEMA[\s\S]*Joana Prado[\s\S]*geladeira/); return decisao({ resposta: "Oi, Joana!" }); };
  await a.cliente(CLI, "Oi");
  assert.equal(a.ultimoPara(CLI), "Oi, Joana!");
});

test("V30.3 — pausa geral pela plataforma", async () => {
  const a = await criarAmbiente({ env: { DENIA_PLATFORM_SERVICE_TOKEN: SERVICO } });
  const r = await (await api(a, "/platform/pause", { method: "POST", body: JSON.stringify({ ativa: true, autor: "Dono" }) })).json();
  assert.equal(r.pausa_geral, true);
  a.llmCliente = () => decisao({ resposta: "Oi!" });
  await a.cliente(CLI, "Oi");
  assert.equal(a.para(CLI).length, 0, "pausada não envia nada");
  await api(a, "/platform/pause", { method: "POST", body: JSON.stringify({ ativa: false }) });
  a.avancar(30000);
  await a.cliente(CLI, "Oi?");
  assert.ok(a.para(CLI).length >= 1);
});

test("V30.4 — ponte contínua: cada dúvida do cliente vai ao profissional e a resposta volta ao cliente", async () => {
  const a = await criarAmbiente();
  await iniciarConsultaChaveiro(a);
  a.llmPrestador = () => prest({ tipo: "ACEITA", valor_centavos: 15000, valor_e_final: "SIM", disponibilidade: "amanhã às 10h" });
  await a.cliente(CHAVEIRO, "Faço amanhã às 10h, 150 já é o valor final");
  assert.match(a.ultimoPara(CLI), /R\$ 150,00/);

  a.llmCliente = () => decisao({ resposta: "Vou confirmar com o profissional.", intencao: "PERGUNTA_PARA_PROFISSIONAL", resposta_para_profissional: "A fechadura nova está inclusa no valor?" });
  await a.cliente(CLI, "A fechadura nova está inclusa?");
  assert.match(a.ultimoPara(CHAVEIRO), /Caso #\d+ — o cliente perguntou: A fechadura nova está inclusa no valor\?/);
  assert.match(a.ultimoPara(CLI), /Vou confirmar com o profissional e já te respondo/);

  a.llmPrestador = (e) => { assert.match(e, /PERGUNTA DO CLIENTE: A fechadura nova/); return prest({ tipo: "RESPONDE", mensagem_para_cliente: "Sim, a fechadura nova já está inclusa." }); };
  await a.cliente(CHAVEIRO, "Sim, já inclui a fechadura");
  assert.equal(a.ultimoPara(CLI), "Sim, a fechadura nova já está inclusa.");

  a.llmCliente = () => decisao({ resposta: "Vou confirmar.", intencao: "PERGUNTA_PARA_PROFISSIONAL", resposta_para_profissional: "Tem garantia?" });
  await a.cliente(CLI, "E tem garantia?");
  assert.match(a.ultimoPara(CHAVEIRO), /o cliente perguntou: Tem garantia\?/, "a ponte continua enquanto houver dúvidas");
  a.llmPrestador = () => prest({ tipo: "RESPONDE", mensagem_para_cliente: "Sim, são 90 dias de garantia." });
  await a.cliente(CHAVEIRO, "90 dias");
  assert.equal(a.ultimoPara(CLI), "Sim, são 90 dias de garantia.");
});

test("V30.4 — cliente manda várias mensagens enquanto a IA pensa: uma resposta só, com tudo", async () => {
  const a = await criarAmbiente();
  let chamadas = 0, entradas = [];
  a.llmCliente = (e) => {
    chamadas++; entradas.push(e);
    if (chamadas === 1) {
      // Chega outra mensagem do cliente durante o processamento.
      for (const [i, t] of ["é na porta da cozinha", "e é urgente"].entries()) {
        const w = "wamid.durante." + i;
        a.DB.q("INSERT INTO d30_fila(wamid,telefone,payload,recebido_ms,status,atualizado_ms) VALUES(?,?,?,?,'PENDENTE',?) RETURNING wamid", w, CLI, JSON.stringify({ wamid: w, de: CLI, tipo: "text", texto: t, ts: Math.floor(a.agora / 1000), recebidoMs: a.agora }), a.agora, a.agora);
      }
    }
    return decisao({ resposta: "Entendi! Vou ver isso para você." });
  };
  await a.cliente(CLI, "Oi, minha fechadura quebrou");
  assert.equal(a.para(CLI).length, 1, "uma única resposta para as três mensagens");
  assert.equal(chamadas, 2);
  assert.match(entradas[1], /fechadura quebrou[\s\S]*porta da cozinha[\s\S]*urgente/, "a resposta considera todas as mensagens");
  const registradas = a.DB.q("SELECT COUNT(*) n FROM mensagens WHERE direcao='ENTRADA'")[0].n;
  assert.equal(registradas, 3, "cada mensagem registrada uma vez só");
});
