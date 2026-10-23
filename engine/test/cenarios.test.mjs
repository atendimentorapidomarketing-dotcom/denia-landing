import { test } from "node:test";
import assert from "node:assert/strict";
import { criarAmbiente } from "./harness.mjs";

const CLI = "5521911112222";
const CLI2 = "5521933334444";
const CHAVEIRO = "5521964545279", ANDERSON_REFORMA = "5521987506366";
const CARLOS_ESTOF = "5521983838318", CARLOS_ASSIST = "5511992197178", MIRELLA = "5521978791765";

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
  assert.doesNotMatch(a.para(CHAVEIRO)[0].texto, /caso\s*#?\d+|#\d+/i, "número de caso é interno: não vai ao profissional");
  assert.doesNotMatch(a.para(CHAVEIRO)[0].texto, /Solicitação:|Marca\/modelo:/, "escrita como gente, não como formulário");
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
  assert.match(a.ultimoPara(CARLOS_ESTOF), /valor final pro cliente ou é só a sua parte/);
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
  a.llmCliente = () => decisao({ resposta: "Ok", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { servico: "conserto de geladeira", problema: "geladeira não gela", categoria: "ESTOFADOR", bairro: "Méier" } });
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
  assert.ok((await a.avisos()).some(t => /Eita, Niterói[\s\S]*Nenhuma ação automática/.test(t)), "fica registrado no painel");
  assert.ok(!a.telegram.some(t => /Eita, Niterói/.test(t)), "não é urgente: não vai ao Telegram");
});

test("Prestador pergunta 'que cliente?' e recebe o contexto do caso certo", async () => {
  const a = await criarAmbiente();
  await iniciarConsultaChaveiro(a);
  a.llmPrestador = () => prest({ tipo: "PEDE_CONTEXTO" });
  await a.cliente(CHAVEIRO, "Que cliente? Verificar o quê?");
  const r = a.ultimoPara(CHAVEIRO);
  assert.match(r, /Botafogo[\s\S]*troca de fechadura/);
  assert.doesNotMatch(r, /caso\s*#?\d+|#\d+/i);
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
  assert.match(a.ultimoPara(CHAVEIRO), /o cliente respondeu: Porta de madeira/);
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
  assert.match(a.ultimoPara(CHAVEIRO), /^É sobre qual cliente: /);
  assert.doesNotMatch(a.ultimoPara(CHAVEIRO), /caso\s*#?\d+|#\d+|número/i, "nunca pede número de caso");
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

test("V30.7 — mensagem atrasada (20 min) é respondida com desculpas; mais de 12 h só é registrada", async () => {
  const a = await criarAmbiente();
  a.llmCliente = (entrada) => decisao({ resposta: /pedido de desculpas/.test(entrada) ? "Oi! Desculpa a demora. Como posso te ajudar?" : "Olá!" });
  await a.cliente(CLI, "Oi, alguém aí?", { ts: a.agora - 20 * 60 * 1000 });
  assert.equal(a.para(CLI).length, 1, "nenhuma conversa fica sem resposta");
  assert.match(a.para(CLI)[0].texto, /Desculpa a demora/);
  const b = await criarAmbiente();
  b.llmCliente = () => decisao({ resposta: "Olá!" });
  await b.cliente(CLI, "Oi", { ts: b.agora - 13 * 3600 * 1000 });
  assert.equal(b.para(CLI).length, 0);
  assert.equal(b.DB.q("SELECT COUNT(*) n FROM mensagens")[0].n, 1);
  assert.ok(b.telegram.some(t => /sem resposta/.test(t)));
});

test("V30.7 — falha passageira: a DENIA tenta de novo e responde", async () => {
  const a = await criarAmbiente();
  let vez = 0;
  a.llmCliente = () => { vez++; if (vez === 1) throw new Error("rede caiu"); return decisao({ resposta: "Oi! Tudo bem? Me conta o que aconteceu." }); };
  const original = a.DB.prepare.bind(a.DB);
  let falhou = false;
  a.DB.prepare = (sql) => { if (!falhou && /FROM d30_casos/.test(sql)) { falhou = true; throw new Error("D1 instável"); } return original(sql); };
  await a.cliente(CLI, "Oi");
  a.DB.prepare = original;
  assert.equal(a.para(CLI).length, 1);
});

test("V30.7 — resumo de ligação entra no histórico e a DENIA usa o que foi combinado por telefone", async () => {
  const a = await criarAmbiente({ env: { DENIA_PLATFORM_SERVICE_TOKEN: SERVICO } });
  a.llmCliente = () => decisao({ resposta: "Oi! Me conta." });
  await a.cliente(CLI, "Oi");
  const r = await (await api(a, `/platform/conversations/${pessoaDe(a, CLI)}/note`, { method: "POST", body: JSON.stringify({ texto: "Cliente ligou: prefere atendimento depois das 14h e o portão é azul.", autor: "Ana <ana@central.test>" }) })).json();
  assert.equal(r.sucesso, true);
  let entrada = "";
  a.llmCliente = (e) => { entrada = e; return decisao({ resposta: "Combinado, depois das 14h então!" }); };
  await a.cliente(CLI, "Então, conseguem amanhã?");
  assert.match(entrada, /RESUMO DE LIGAÇÃO REGISTRADO PELA EQUIPE[^\n]*portão é azul\. — registrado por Ana/);
  assert.equal(a.para(CLI).length, 2);
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
  a.llmCliente = () => decisao({ resposta: "Ok", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { servico: "chaveiro", problema: "cópia de chave", bairro: "Centro" } });
  const r = await (await a.http("/api/teste", { method: "POST", body: JSON.stringify({ remetente: "cliente", texto: "Preciso de cópia de chave" }) })).json();
  assert.equal(a.enviados.length, 0);
  assert.ok(r.saidas.some(s => s.papel === "prestador" && /Consegue pegar/i.test(s.texto)));
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
  a.llmCliente = () => decisao({ resposta: "Poxa!", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, categoria_confianca: "ALTA", fatos: { servico: "conserto de geladeira", problema: "geladeira queimou ao ligar na tomada 220v", categoria: "ASSISTENCIA_TECNICA", bairro: "Méier" } });
  await a.cliente(CLI, "Minha geladeira queimou, liguei na tomada 220");
  assert.equal(a.para(WILLIAM).length, 0);
  assert.equal(a.para(CARLOS_ASSIST).length, 1);
});

test("V30.2 — categoria incerta: não consulta ninguém, equipe decide", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Entendi.", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, categoria_confianca: "MEDIA", fatos: { servico: "instalação de suporte de TV", categoria: "REFORMA" } });
  await a.cliente(CLI, "Quero instalar um suporte de TV");
  assert.match(a.ultimoPara(CLI), /em qual bairro/, "serviço no endereço do cliente: pede o bairro primeiro");
  a.llmCliente = () => decisao({ resposta: "Certo.", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { bairro: "Méier" } });
  await a.cliente(CLI, "Méier");
  assert.equal(a.enviados.filter(e => e.to !== CLI).length, 0, "nenhum prestador consultado");
  assert.ok(a.telegram.some(t => /Sem prestador disponível para Pequenos reparos/.test(t)), "agora ela sabe que é pequeno reparo; falta só cadastrar quem faz");
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
  assert.match(a.ultimoPara(CHAVEIRO), /o cliente de Botafogo perguntou: A fechadura nova está inclusa no valor\?/);
  assert.match(a.ultimoPara(CLI), /Vou confirmar com o profissional e já te respondo/);

  a.llmPrestador = (e) => { assert.match(e, /PERGUNTA DO CLIENTE: A fechadura nova/); return prest({ tipo: "RESPONDE", mensagem_para_cliente: "Sim, a fechadura nova já está inclusa." }); };
  await a.cliente(CHAVEIRO, "Sim, já inclui a fechadura");
  assert.equal(a.ultimoPara(CLI), "Sim, a fechadura nova já está inclusa.");

  a.llmCliente = () => decisao({ resposta: "Vou confirmar.", intencao: "PERGUNTA_PARA_PROFISSIONAL", resposta_para_profissional: "Tem garantia?" });
  await a.cliente(CLI, "E tem garantia?");
  assert.match(a.ultimoPara(CHAVEIRO), /o cliente de Botafogo perguntou: Tem garantia\?/, "a ponte continua enquanto houver dúvidas");
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

// ----- V30.6: profissional nunca é tratado como cliente -----
const OUTRO_NUM = "5521977776666";
const casoAtual = a => a.DB.q("SELECT caso_id FROM d30_casos ORDER BY caso_id DESC LIMIT 1")[0].caso_id;
const pessoaDe = (a, tel) => a.DB.q("SELECT id FROM pessoas WHERE telefone=?", tel)[0].id;

test("V30.6 — profissional escrevendo de OUTRO número sobre o caso não vira pedido nem é repassado a ninguém", async () => {
  const a = await criarAmbiente();
  await iniciarConsultaChaveiro(a);
  const caso = casoAtual(a);
  const enviadosAntes = a.enviados.length;
  a.llmCliente = () => { throw new Error("não deveria tratar o profissional como cliente"); };
  await a.cliente(OUTRO_NUM, `Sobre o caso ${caso}: consigo ir amanhã às 10h, fica 150`);
  assert.equal(a.llm.filter(x => x.papel === "cliente" && x.entrada.includes("consigo ir amanhã")).length, 0);
  assert.equal(a.enviados.length, enviadosAntes, "nada enviado ao cliente, ao número nem a outro profissional");
  assert.ok((await a.avisos()).some(t => /Pode ser o profissional escrevendo de outro número/.test(t)), "fica registrado no painel");
  assert.equal(a.DB.q("SELECT COUNT(*) n FROM d30_casos")[0].n, 1, "nenhum pedido novo foi aberto");
});

test("V30.6 — a equipe marca o outro número como profissional e a ponte cliente ↔ profissional continua", async () => {
  const a = await criarAmbiente({ env: { DENIA_PLATFORM_SERVICE_TOKEN: SERVICO } });
  await iniciarConsultaChaveiro(a);
  const caso = casoAtual(a);
  a.llmCliente = () => { throw new Error("não deveria tratar como cliente"); };
  await a.cliente(OUTRO_NUM, `Caso ${caso}: qual o bairro mesmo?`);
  const r = await (await api(a, `/platform/conversations/${pessoaDe(a, OUTRO_NUM)}/type`, { method: "POST", body: JSON.stringify({ tipo: "TECNICO", prestador_id: "CHAV-ANDERSON", autor: "Equipe" }) })).json();
  assert.equal(r.sucesso, true);
  a.llmPrestador = () => prest({ tipo: "ACEITA", valor_centavos: 15000, valor_e_final: "SIM", disponibilidade: "amanhã às 10h" });
  await a.cliente(OUTRO_NUM, "Faço amanhã às 10h, 150 já é o valor final");
  assert.match(a.ultimoPara(CLI), /R\$ 150,00/, "a resposta do profissional pelo outro número chega ao cliente");
  const det = await (await api(a, `/platform/conversations/${pessoaDe(a, OUTRO_NUM)}`)).json();
  assert.equal(det.pessoa.profissional, "Anderson (chaveiro)");
});

test("V30.6 — número que já recebeu consulta continua profissional mesmo fora da lista", async () => {
  const a = await criarAmbiente();
  await iniciarConsultaChaveiro(a);
  a.DB.q("UPDATE d30_consultas SET prestador_tel=?, prestador_id='EX-PROF'", OUTRO_NUM);
  a.llmCliente = () => { throw new Error("não deveria tratar como cliente"); };
  a.llmPrestador = () => prest({ tipo: "COMENTARIO" });
  await a.cliente(OUTRO_NUM, "Bom dia, vi a mensagem de vocês");
  assert.equal(a.llm.filter(x => x.papel === "cliente" && x.entrada.includes("vi a mensagem")).length, 0);
});

test("V30.6 — profissional que já tinha aberto pedido como cliente: marcar como profissional encerra o pedido aberto por engano", async () => {
  const a = await criarAmbiente({ env: { DENIA_PLATFORM_SERVICE_TOKEN: SERVICO } });
  a.llmCliente = () => decisao({ resposta: "Vou consultar.", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { servico: "higienização", problema: "limpeza de sofá", bairro: "Tijuca", categoria: "HIGIENIZACAO" } });
  await a.cliente(OUTRO_NUM, "Limpeza de sofá na Tijuca");
  const caso = casoAtual(a);
  const r = await (await api(a, `/platform/conversations/${pessoaDe(a, OUTRO_NUM)}/type`, { method: "POST", body: JSON.stringify({ tipo: "TECNICO" }) })).json();
  assert.equal(r.casos_encerrados, 1);
  assert.equal(a.DB.q("SELECT etapa FROM d30_casos WHERE caso_id=?", caso)[0].etapa, "CANCELADO");
  a.llmCliente = () => { throw new Error("agora é profissional"); };
  await a.cliente(OUTRO_NUM, "Oi, tudo bem?");
  assert.equal(a.llm.filter(x => x.papel === "cliente" && x.entrada.includes("tudo bem")).length, 0);
});

test("V30.6 — trava: caso aberto por número de profissional nunca é repassado a outro profissional", async () => {
  const a = await criarAmbiente({ env: { DENIA_PLATFORM_SERVICE_TOKEN: SERVICO } });
  a.llmCliente = () => decisao({ resposta: "Ok", intencao: "CONVERSA" });
  await a.cliente(OUTRO_NUM, "Oi");
  a.DB.q("UPDATE pessoas SET tipo='TECNICO' WHERE telefone=?", OUTRO_NUM);
  // simula uma rota antiga que ainda chamasse o fluxo de cliente
  a.DB.q("DELETE FROM d30_consultas");
  const antes = a.enviados.filter(e => e.to !== OUTRO_NUM).length;
  await a.cliente(OUTRO_NUM, "Limpeza de sofá");
  assert.equal(a.enviados.filter(e => e.to !== OUTRO_NUM).length, antes, "nenhum profissional recebe a mensagem de outro profissional");
});

test("V30.8 — triagem de avaliações: quem avaliou está na base de clientes? (sem expor dados)", async () => {
  const a = await criarAmbiente({ env: { DENIA_PLATFORM_SERVICE_TOKEN: SERVICO } });
  a.llmCliente = () => decisao({ resposta: "Oi!" });
  await a.cliente(CLI, "Oi", { nome: "Márcia Ferreira" });
  await (await api(a, "/platform/import/clients", { method: "POST", body: JSON.stringify({ origem: "x", linhas: [{ telefone: "21 97777-6666", "Nome do cliente": "Paulo Souza Lima" }] }) })).json();
  const r = await (await api(a, "/platform/clients/match", { method: "POST", body: JSON.stringify({ nomes: ["Marcia Ferreira", "Paulo Lima", "Paulo", "Zé Ninguém da Silva", "."] }) })).json();
  assert.equal(r.resultado["Marcia Ferreira"].encontrado, "SIM");
  assert.deepEqual(r.resultado["Paulo Lima"].onde, ["cadastro"]);
  assert.equal(r.resultado["Paulo"].encontrado, "TALVEZ");
  assert.equal(r.resultado["Zé Ninguém da Silva"].encontrado, "NAO");
  assert.equal(r.resultado["."].encontrado, "SEM_NOME");
  assert.ok(!JSON.stringify(r).includes("97777"), "nunca devolve telefone");
});

test("V31 — a IA lê o caso (cliente, profissional, equipe, ligação) e move para Agendado/Concluído com confiança alta", async () => {
  const a = await criarAmbiente({ env: { DENIA_PLATFORM_SERVICE_TOKEN: SERVICO } });
  await iniciarConsultaChaveiro(a);
  const caso = casoAtual(a);
  await (await api(a, `/platform/conversations/${pessoaDe(a, CLI)}/note`, { method: "POST", body: JSON.stringify({ texto: "Liguei: o chaveiro vai amanhã às 9h, cliente confirmou.", autor: "Ana" }) })).json();
  let entrada = "";
  a.llmRevisao = (e) => { entrada = e; return { etapa: "AGENDADO", confianca: "ALTA", data_servico: "amanhã 9h", motivo: "Ligação confirmou o horário.", proximo_passo: "Confirmar a visita." }; };
  const r = await (await api(a, `/platform/cases/${caso}/review`, { method: "POST", body: JSON.stringify({ aplicar: true, autor: "Ana" }) })).json();
  assert.equal(r.aplicada, true);
  assert.match(entrada, /RESUMO DE LIGAÇÃO \(equipe\): Liguei: o chaveiro vai amanhã às 9h/);
  assert.equal(a.DB.q("SELECT etapa FROM d30_casos WHERE caso_id=?", caso)[0].etapa, "AGENDADO");
  // Confiança média: só sugere, não mexe.
  a.llmRevisao = () => ({ etapa: "CONCLUIDO", confianca: "MEDIA", motivo: "Talvez." });
  const r2 = await (await api(a, `/platform/cases/${caso}/review`, { method: "POST", body: JSON.stringify({}) })).json();
  assert.deepEqual([r2.etapa_sugerida, r2.aplicada], ["CONCLUIDO", false]);
  assert.equal(a.DB.q("SELECT etapa FROM d30_casos WHERE caso_id=?", caso)[0].etapa, "AGENDADO");
  const lista = await (await api(a, "/platform/cases")).json();
  assert.equal(lista.casos.find(x => x.casoId === caso).revisao_ia.etapa_sugerida, "CONCLUIDO");
  // Em andamento é uma etapa que a equipe também pode escolher.
  assert.equal((await (await api(a, `/platform/cases/${caso}/status`, { method: "POST", body: JSON.stringify({ etapa: "EM_ANDAMENTO" }) })).json()).sucesso, true);
});

test("Entrega — a Meta aceita mas não entrega: a DENIA registra o motivo, avisa a equipe, mostra no painel e reenvia falhas passageiras", async () => {
  const TOKEN = "token-da-plataforma-123456";
  const a = await criarAmbiente({ env: { DENIA_PLATFORM_SERVICE_TOKEN: TOKEN } });
  const plat = (caminho) => a.http(caminho, { headers: { authorization: "Bearer " + TOKEN } }).then(r => r.json());
  a.llmCliente = () => decisao({ resposta: "Oi! Como posso ajudar?" });
  await a.cliente(CLI, "Oi");
  const enviada = a.para(CLI).at(-1);
  assert.ok(enviada, "a resposta foi aceita pela Meta");
  // 1) Entregue e lida: aparece no painel.
  await a.webhook({ statuses: [{ id: enviada.id, status: "delivered", recipient_id: CLI, timestamp: String(Math.floor(a.agora / 1000)) }] });
  await a.webhook({ statuses: [{ id: enviada.id, status: "read", recipient_id: CLI, timestamp: String(Math.floor(a.agora / 1000)) }] });
  const conversas = (await plat("/platform/conversations")).conversas;
  const pessoa = conversas.find(x => x.telefone.endsWith(CLI.slice(-8)));
  let detalhe = await plat(`/platform/conversations/${pessoa.pessoa_id}`);
  assert.equal(detalhe.mensagens.find(m => m.whatsapp_message_id === enviada.id).entrega, "READ");
  // "delivered" atrasado não volta a lida para entregue.
  await a.webhook({ statuses: [{ id: enviada.id, status: "delivered", recipient_id: CLI }] });
  detalhe = await plat(`/platform/conversations/${pessoa.pessoa_id}`);
  assert.equal(detalhe.mensagens.find(m => m.whatsapp_message_id === enviada.id).entrega, "READ");

  // 2) Falha passageira da Meta: reenvia uma vez sozinha.
  a.llmCliente = () => decisao({ resposta: "Pode me contar o que aconteceu?" });
  await a.cliente(CLI, "Preciso de ajuda");
  const segunda = a.para(CLI).at(-1);
  const antes = a.para(CLI).length;
  await a.webhook({ statuses: [{ id: segunda.id, status: "failed", recipient_id: CLI, errors: [{ code: 131000, title: "Something went wrong" }] }] });
  assert.equal(a.para(CLI).length, antes + 1, "reenviou");
  assert.equal(a.para(CLI).at(-1).texto, segunda.texto);

  // 3) Falha da conta (pagamento): alerta crítico, diagnóstico em vermelho, e some quando volta a entregar.
  a.llmCliente = () => decisao({ resposta: "Já te respondo." });
  await a.cliente(CLI, "Alô?");
  const terceira = a.para(CLI).at(-1);
  a.telegram.length = 0;
  await a.webhook({ statuses: [{ id: terceira.id, status: "failed", recipient_id: CLI, errors: [{ code: 131042, title: "Business eligibility payment issue", error_data: { details: "Payment method missing" } }] }] });
  assert.ok(a.telegram.some(t => /NÃO está entregando/.test(t) && /pagamento/i.test(t)), "a equipe é avisada com o motivo em português");
  let st = await plat("/platform/status");
  assert.equal(st.entrega_bloqueada.codigo, 131042);
  assert.equal(st.entregas_24h.falhas, 1);
  assert.match(st.entregas_24h.motivos[0].motivo, /pagamento/i);
  detalhe = await plat(`/platform/conversations/${pessoa.pessoa_id}`);
  assert.match(detalhe.mensagens.find(m => m.whatsapp_message_id === terceira.id).entrega_erro, /pagamento/i, "o painel mostra que não chegou e por quê");
  a.llmCliente = () => decisao({ resposta: "Voltamos!" });
  await a.cliente(CLI, "Oi de novo");
  await a.webhook({ statuses: [{ id: a.para(CLI).at(-1).id, status: "delivered", recipient_id: CLI }] });
  st = await plat("/platform/status");
  assert.equal(st.entrega_bloqueada, null, "uma entrega confirmada limpa o alerta");

  // 4) Falha de um número só (sem WhatsApp): aviso ao time, sem alerta crítico.
  a.llmCliente = () => decisao({ resposta: "Certo, anotei o endereço." });
  const n4 = a.para(CLI).length;
  await a.cliente(CLI, "Meu endereço é Rua A, 10");
  assert.equal(a.para(CLI).length, n4 + 1);
  a.telegram.length = 0;
  await a.webhook({ statuses: [{ id: a.para(CLI).at(-1).id, status: "failed", recipient_id: CLI, errors: [{ code: 131026, title: "Message undeliverable" }] }] });
  assert.ok((await a.avisos()).some(t => /NÃO entregue/.test(t)), "registrado no painel (não urgente)");
  assert.equal((await plat("/platform/status")).entrega_bloqueada, null);
});

test("Números do WhatsApp — mensagens por dia (IA e equipe), contatos, casos e entregas no período", async () => {
  const TOKEN = "token-da-plataforma-123456";
  const a = await criarAmbiente({ env: { DENIA_PLATFORM_SERVICE_TOKEN: TOKEN } });
  a.llmCliente = () => decisao({ resposta: "Oi! Em que posso ajudar?" });
  await a.cliente(CLI, "Oi");
  await a.webhook({ statuses: [{ id: a.para(CLI).at(-1).id, status: "delivered", recipient_id: CLI }] });
  // O histórico usa a data real do banco (CURRENT_TIMESTAMP), por isso o período largo.
  const u = await (await a.http(`/platform/usage?de=2020-01-01&ate=2035-12-31`, { headers: { authorization: "Bearer " + TOKEN } })).json();
  assert.equal(u.mensagens.recebidas.reduce((s, x) => s + x.n, 0), 1);
  assert.equal(u.mensagens.pela_ia.reduce((s, x) => s + x.n, 0), 1);
  assert.equal(u.contatos, 1);
  assert.equal(u.entregas.entregues, 1);
  assert.ok(Array.isArray(u.casos.novos));
});

test("Limite de chamadas da Cloudflare — perto do limite, a resposta vai para a fila e o cron envia (nunca se perde)", async () => {
  const a = await criarAmbiente({ env: { LIMITE_CHAMADAS: "34" } });
  a.llmCliente = () => decisao({ resposta: "Oi! Já vou te ajudar." });
  await a.cliente(CLI, "Oi");
  // Na execução do webhook não coube: nada saiu ainda, mas nada foi perdido.
  const antes = a.para(CLI).length;
  a.avancar(60000);
  await a.cron();
  await a.cron();
  assert.ok(a.para(CLI).length > antes, "o cron respondeu o cliente");
  assert.match(a.ultimoPara(CLI), /Já vou te ajudar/);
  const fila = a.DB.q("SELECT status FROM d30_saida_fila");
  assert.ok(fila.every(x => x.status === "ENVIADA"), "fila esvaziada: " + JSON.stringify(fila));
  const msg = a.DB.q("SELECT whatsapp_message_id w FROM mensagens WHERE direcao='SAIDA' ORDER BY id DESC LIMIT 1")[0];
  assert.match(msg.w, /^wamid\./, "a mensagem no painel ganhou o id real do WhatsApp");
});

test("Cron depois de horas parado — NUNCA manda mensagens em massa nem responde clientes antigos", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Desculpe a demora! Como posso ajudar?" });
  const fila = (tel, minutosAtras, i) => {
    const ts = a.agora - minutosAtras * 60000;
    a.DB.prepare("INSERT INTO d30_fila(wamid,telefone,payload,recebido_ms,status,atualizado_ms) VALUES(?,?,?,?,'PENDENTE',?)")
      .bind("wamid.antigo." + i, tel, JSON.stringify({ wamid: "wamid.antigo." + i, de: tel, nome: "", ts: String(Math.floor(ts / 1000)), tipo: "text", texto: "Oi, tudo bem?", recebidoMs: ts }), ts, ts).run();
  };
  await a.cron(); // cria o esquema
  // 8 clientes que escreveram há 2 a 9 horas (o cron estava desligado).
  const antigos = Array.from({ length: 8 }, (_, i) => "55219888800" + i);
  antigos.forEach((t, i) => fila(t, 120 + i * 60, i));
  a.telegram.length = 0;
  await a.cron(); await a.cron(); await a.cron();
  for (const t of antigos) assert.equal(a.para(t).length, 0, "não responde mensagem de horas atrás: " + t);
  assert.ok(a.telegram.some(t => /NÃO respondeu sozinha/.test(t)), "a equipe é avisada, sem mandar nada aos clientes");
  // Mensagem de 10 min atrás, sem ninguém ter respondido: responde (uma vez).
  fila("5521977770001", 10, 100);
  await a.cron();
  assert.equal(a.para("5521977770001").length, 1);
  // Mensagem de 10 min atrás que a equipe já respondeu pelo celular: a DENIA não se mete.
  await a.cliente("5521977770002", "Bom dia"); // cria a pessoa
  const n0 = a.para("5521977770002").length;
  await a.eco("5521977770002", "Oi! Já estou vendo para você.");
  fila("5521977770002", 10, 101);
  a.avancar(11 * 60000);
  await a.cron();
  assert.equal(a.para("5521977770002").length, n0, "a equipe já respondeu: nada sai");
});

test("Profissional responde à mensagem da equipe ('Serviço agendado: nome, endereço…') — a DENIA acha o caso certo sozinha, sem pedir número", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Vou consultar o profissional.", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { servico: "chaveiro", problema: "troca de fechadura", bairro: "Botafogo" } });
  await a.cliente(CLI, "Preciso trocar a fechadura, é em Botafogo", { nome: "Maria Souza" });
  a.llmCliente = () => decisao({ resposta: "Vou consultar o profissional.", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { servico: "chaveiro", problema: "cópia de chave tetra", bairro: "Tijuca" } });
  await a.cliente(CLI2, "Quero fazer cópia de chave tetra, sou da Tijuca", { nome: "João Lima" });
  assert.equal(a.para(CHAVEIRO).length, 2, "duas consultas abertas com o mesmo profissional");
  const casoJoao = a.DB.q("SELECT c.caso_id FROM d30_casos c JOIN pessoas p ON p.id=c.cliente_id WHERE p.nome LIKE 'João%'")[0].caso_id;
  // A equipe manda pelo celular da empresa o resumo do serviço agendado do João.
  await a.eco(CHAVEIRO, "Serviço agendado\nNome: João Lima\nEndereço: Rua Conde de Bonfim, 100\nBairro: Tijuca\nServiço: cópia de chave tetra\nData: amanhã 10h\nValor: R$ 80");
  const eco = a.DB.q("SELECT whatsapp_message_id w FROM mensagens WHERE origem='HUMANO' ORDER BY id DESC LIMIT 1")[0].w;
  a.avancar(11 * 60000); // passa a pausa de 10 min que a mensagem da equipe liga
  let vistoNoPrompt = "";
  a.llmPrestador = (e) => { vistoNoPrompt = e; return prest({ tipo: "COMENTARIO" }); };
  const antes = a.para(CHAVEIRO).length;
  await a.webhook({ contacts: [{ wa_id: CHAVEIRO }], messages: [{ id: "wamid.resp.eq", from: CHAVEIRO, timestamp: String(Math.floor(a.agora / 1000)), type: "text", text: { body: "Combinado, amanhã 10h estou lá na Tijuca" }, context: { id: eco } }] });
  const novas = a.para(CHAVEIRO).slice(antes);
  assert.ok(!novas.some(m => /não confundir|qual|número do caso/i.test(m.texto)), "não pergunta qual atendimento: " + JSON.stringify(novas.map(m => m.texto)));
  assert.match(vistoNoPrompt, new RegExp(`CASO #${casoJoao}\\b`), "ligou ao caso do João");
  for (const m of a.enviados) assert.doesNotMatch(String(m.texto || ""), /caso\s*#?\d+|#\d{2,}/i, "número de caso nunca sai: " + m.texto);
});

test("Memória completa — cliente antigo com meses de conversa: a DENIA lê o dossiê antes de responder", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Oi!" });
  await a.cliente(CLI, "Oi", { nome: "Carla" });
  const pessoa = a.DB.q("SELECT id FROM pessoas WHERE telefone=?", CLI)[0].id;
  // 120 mensagens antigas (há 6 meses), além das últimas 60 que o histórico mostra.
  for (let i = 0; i < 120; i++) a.DB.prepare("INSERT INTO mensagens(empresa_id,pessoa_id,direcao,origem,tipo_conteudo,conteudo,criado_em) VALUES(1,?,?,?,'TEXTO',?,datetime('now','-180 days'))")
    .bind(pessoa, i % 2 ? "SAIDA" : "ENTRADA", i % 2 ? "HUMANO" : "WHATSAPP", i === 0 ? "Oi, moro na Rua das Flores 12, Leblon, minha geladeira Brastemp parou" : "mensagem antiga " + i).run();
  let pedidoMemoria = "";
  a.llmMemoria = (e) => { pedidoMemoria = e; return { dossie: "Carla, cliente desde abril. Mora na Rua das Flores 12, Leblon. Geladeira Brastemp consertada em abril." }; };
  let entradaCliente = "";
  a.llmCliente = (e) => { entradaCliente = e; return decisao({ resposta: "Oi, Carla! A geladeira deu problema de novo?" }); };
  await a.cliente(CLI, "Oi, preciso de ajuda de novo");
  assert.match(pedidoMemoria, /Rua das Flores 12, Leblon/, "a memória leu desde a primeira mensagem");
  assert.match(entradaCliente, /MEMÓRIA COMPLETA DO CLIENTE[\s\S]*Rua das Flores 12, Leblon/, "a resposta já sai sabendo do histórico antigo");
  assert.match(entradaCliente, /Primeiro contato: /);
  // Próxima mensagem: usa o dossiê guardado (não gera de novo).
  pedidoMemoria = "";
  await a.cliente(CLI, "É a mesma geladeira");
  assert.equal(pedidoMemoria, "", "dossiê reaproveitado");
});

test("Equipe agendou pelo celular — a DENIA lê, atualiza o caso e responde o profissional sem pedir valor de novo nem chamar a equipe", async () => {
  const TOKEN = "token-da-plataforma-123456";
  const a = await criarAmbiente({ env: { DENIA_PLATFORM_SERVICE_TOKEN: TOKEN } });
  await iniciarConsultaChaveiro(a);
  const caso = a.DB.q("SELECT caso_id FROM d30_casos LIMIT 1")[0].caso_id;
  a.llmRevisao = () => ({ etapa: "AGENDADO", confianca: "ALTA", data_servico: "amanhã às 10h", motivo: "A equipe enviou 'Serviço agendado' com data e valor.", proximo_passo: "Aguardar o serviço." });
  await a.eco(CHAVEIRO, "Serviço agendado\nCliente em Botafogo\nServiço: troca de fechadura\nData: amanhã 10h\nValor: R$ 150");
  assert.equal(a.DB.q("SELECT etapa FROM d30_casos WHERE caso_id=?", caso)[0].etapa, "AGENDADO", "a mensagem da equipe atualizou o caso");
  assert.equal(a.DB.q("SELECT status FROM d30_consultas WHERE caso_id=?", caso)[0].status, "CONFIRMADA");
  a.avancar(11 * 60000);
  a.llmPrestador = () => prest({ tipo: "COMENTARIO" });
  a.llmProfAgendado = () => ({ resposta: "Li sim! Está tudo certo para amanhã às 10h em Botafogo. Obrigada!", precisa_equipe: false });
  a.telegram.length = 0;
  await a.cliente(CHAVEIRO, "Você conseguiu ler que o serviço já foi agendado?");
  assert.match(a.ultimoPara(CHAVEIRO), /Li sim/);
  assert.doesNotMatch(a.ultimoPara(CHAVEIRO), /consegue pegar|me passa o valor/i);
  assert.ok(!a.telegram.some(t => /escreveu sobre/.test(t)), "não pede ajuda à equipe à toa");
});

test("Estudo diário — a DENIA relê o dia, aprende com os erros (lições valem na hora) e manda conhecimento para aprovação", async () => {
  const TOKEN = "token-da-plataforma-123456";
  const a = await criarAmbiente({ env: { DENIA_PLATFORM_SERVICE_TOKEN: TOKEN } });
  a.llmCliente = () => decisao({ resposta: "Qual é o seu endereço?" });
  await a.cliente(CLI, "Oi, preciso de um eletricista");
  let viu = "";
  a.llmEstudo = (e) => { viu = e; return { nota: 7, resumo: "Bom dia, mas pedi endereço já informado.", erros: [{ erro: "Pediu o endereço de novo", correcao: "Confirmar o endereço que já estava no histórico" }], licoes: ["Antes de pedir o endereço, confira se o cliente já informou e apenas confirme."], conhecimento: [{ tipo: "PRECO_PRATICADO", titulo: "Visita de eletricista", conteudo: "A visita costuma ser R$ 80." }] }; };
  const r = await (await a.http("/platform/study/run", { method: "POST", headers: { authorization: "Bearer " + TOKEN }, body: "{}" })).json();
  assert.match(viu, /preciso de um eletricista/, "leu as conversas do dia");
  assert.equal(r.resultado.licoes_novas, 1);
  const st = await (await a.http("/platform/study", { headers: { authorization: "Bearer " + TOKEN } })).json();
  assert.match(st.licoes, /confira se o cliente já informou/);
  assert.equal(st.relatorios[0].nota, 7);
  assert.equal(a.DB.q("SELECT COUNT(*) n FROM d30_sugestoes WHERE status='PENDENTE'")[0].n, 1, "preço vai para aprovação, não direto");
  // A lição já entra no próximo atendimento.
  let entrada = "";
  a.llmCliente = (e) => { entrada = e; return decisao({ resposta: "Certo!" }); };
  await a.cliente(CLI, "Ok");
  await a.cliente(CLI, "Moro em Botafogo, quando podem vir?");
  assert.match(entrada, /LIÇÕES DO ESTUDO DIÁRIO[\s\S]*confira se o cliente já informou/);
});

test("Métricas do atendimento — tempo de resposta, IA x equipe, horários, contatos, atendimentos e profissionais", async () => {
  const TOKEN = "token-da-plataforma-123456";
  const a = await criarAmbiente({ env: { DENIA_PLATFORM_SERVICE_TOKEN: TOKEN } });
  await iniciarConsultaChaveiro(a);
  a.llmCliente = () => decisao({ resposta: "Oi!" });
  await a.cliente(CLI2, "Bom dia");
  const m = await (await a.http(`/platform/metrics?de=2020-01-01&ate=2035-12-31`, { headers: { authorization: "Bearer " + TOKEN } })).json();
  assert.equal(m.sucesso, true);
  assert.ok(m.conversas.contatos >= 2);
  assert.ok(m.respostas.ia >= 2);
  assert.equal(m.horarios.length, 7); assert.equal(m.horarios[0].length, 24);
  assert.ok(m.horarios.flat().reduce((s, x) => s + x, 0) >= 2);
  assert.ok(m.atendimentos.funil.abertos >= 1);
  assert.equal(m.atendimentos.funil.com_profissional, 1);
  assert.ok(m.profissionais.some(p => p.consultas === 1));
});

// ===== V31.8 — MODO GUIA (shopping): botões sem IA, IA só para pergunta escrita
const VIS = "5521955556666";
const clique = (a, de, id, titulo = "x", tipo = "list_reply") => a.webhook(a.msg(de, "", { type: "interactive", nome: "Marcos", raw: { text: undefined, interactive: { type: tipo, [tipo]: { id, title: titulo } } } }));
async function guiaPronto() {
  const a = await criarAmbiente({ env: { MODO: "guia", DENIA_PLATFORM_SERVICE_TOKEN: SERVICO } });
  const imp = await (await api(a, "/platform/guide/import", { method: "POST", body: JSON.stringify({ linhas: [
    { loja: "Cell Center", telefone: "(21) 3333-1111", whatsapp: "21988887777", local: "Loja 12, 1º piso", produtos: "Celulares, Capinhas", servicos: "Conserto de celular" },
    { loja: "Tech Fix", whatsapp: "21977776666", local: "Loja 30", servicos: "Conserto de celular, Conserto de notebook" },
    { loja: "Game Zone", whatsapp: "21966665555", produtos: "Videogames" }
  ] }) })).json();
  return { a, imp };
}
test("V31.8 — guia: importa planilha e o menu por botões funciona sem nenhuma chamada à IA", async () => {
  const { a, imp } = await guiaPronto();
  assert.equal(imp.lojas, 3); assert.equal(imp.categorias_novas, 5);
  await a.cliente(VIS, "Oi", { nome: "Marcos" });
  let e = a.para(VIS).at(-1);
  assert.equal(e.type, "interactive"); assert.equal(e.corpo.interactive.type, "button");
  assert.deepEqual(e.corpo.interactive.action.buttons.map(b => b.reply.id), ["g:prod", "g:serv", "g:humano"]);
  await clique(a, VIS, "g:serv", "Serviços", "button_reply");
  e = a.para(VIS).at(-1);
  assert.equal(e.corpo.interactive.type, "list");
  const rows = e.corpo.interactive.action.sections[0].rows;
  assert.deepEqual(rows.map(r => r.title), ["Conserto de celular", "Conserto de notebook"]);
  assert.equal(rows[0].description, "2 lojas");
  for (const r of rows) assert.ok(r.title.length <= 24 && r.description.length <= 72);
  await clique(a, VIS, rows[0].id, rows[0].title);
  const lista = a.para(VIS).at(-2);
  assert.match(lista.texto, /Cell Center/); assert.match(lista.texto, /Tech Fix/); assert.match(lista.texto, /wa\.me\/5521988887777/);
  assert.doesNotMatch(lista.texto, /Game Zone/);
  assert.deepEqual(a.para(VIS).at(-1).corpo.interactive.action.buttons.map(b => b.reply.id), ["g:inicio", "g:serv", "g:fim"]);
  assert.equal(a.llm.length, 0, "botões não usam GPT");
  assert.equal(a.telegram.length, 1);
  assert.match(a.telegram[0], /Marcos \(5521955556666\)/); assert.match(a.telegram[0], /Serviços › Conserto de celular/);
  await clique(a, VIS, "g:fim", "Finalizar", "button_reply");
  assert.match(a.ultimoPara(VIS), /prazer ajudar/);
  const st = await (await api(a, "/platform/guide/stats")).json();
  assert.equal(st.total, 1); assert.equal(st.contatos, 1); assert.equal(st.por_via[0].via, "BOTAO"); assert.equal(st.por_categoria[0].categoria, "Conserto de celular");
});
test("V31.8 — guia: pergunta escrita acha a loja por palavra (sem IA) e só usa a IA na dúvida, com o modelo econômico", async () => {
  const { a } = await guiaPronto();
  await api(a, "/platform/guide/config", { method: "POST", body: JSON.stringify({ nome: "Shopping Infomix", modelo_ia: "gpt-5-nano" }) });
  await a.cliente(VIS, "vocês têm videogames?", { nome: "Marcos" });
  assert.match(a.para(VIS).at(-2).texto, /Game Zone/);
  assert.equal(a.llm.length, 0);
  a.llmGuia = (entrada) => { const id = Number(entrada.match(/(\d+)\|serviço\|Conserto de notebook/)[1]); return { categorias: [id], resposta: "" }; };
  await a.cliente(VIS, "meu laptop não liga, quem arruma?");
  assert.equal(a.llm.length, 1); assert.equal(a.llm[0].modelo, "gpt-5-nano");
  assert.match(a.para(VIS).at(-2).texto, /Tech Fix/);
  assert.match(a.telegram.at(-1), /Shopping Infomix/); assert.match(a.telegram.at(-1), /laptop/);
});
test("V31.8 — guia: pedir atendente pausa a DENIA e avisa a equipe; página de opções e teste do painel", async () => {
  const { a } = await guiaPronto();
  for (let i = 0; i < 12; i++) await api(a, "/platform/guide/categories", { method: "POST", body: JSON.stringify({ tipo: "PRODUTO", nome: "Categoria " + String(i).padStart(2, "0") }) });
  const g = await (await api(a, "/platform/guide")).json();
  const lojaId = g.lojas.find(l => l.nome === "Game Zone").id;
  await api(a, "/platform/guide/stores", { method: "POST", body: JSON.stringify({ id: lojaId, nome: "Game Zone", whatsapp: "21966665555", categorias: g.categorias.filter(c => c.tipo === "PRODUTO").map(c => c.id) }) });
  await clique(a, VIS, "g:prod", "Produtos", "button_reply");
  let rows = a.para(VIS).at(-1).corpo.interactive.action.sections[0].rows;
  assert.equal(rows.length, 10); assert.equal(rows.at(-1).id, "g:pg:PRODUTO:1");
  await clique(a, VIS, "g:pg:PRODUTO:1");
  rows = a.para(VIS).at(-1).corpo.interactive.action.sections[0].rows;
  assert.equal(rows.at(-1).id, "g:inicio"); assert.equal(rows.length, 7);
  const t = await (await api(a, "/platform/guide/test", { method: "POST", body: JSON.stringify({ acao: "g:prod" }) })).json();
  assert.equal(t.respostas[0].interativo.type, "list");
  const enviados = a.enviados.length;
  await clique(a, VIS, "g:humano", "Falar com alguém", "button_reply");
  assert.match(a.ultimoPara(VIS), /chamar alguém da equipe/);
  assert.ok(a.telegram.some(m => /quer falar com alguém/.test(m)));
  await a.cliente(VIS, "oi?");
  assert.equal(a.enviados.length, enviados + 1, "em pausa: a equipe responde");
  assert.equal(a.llm.length, 0);
  const st = await (await a.http("/status")).json().catch(() => ({}));
  if (st.modo) assert.equal(st.modo, "guia");
});

test("Profissional com dois atendimentos: segue a conversa em andamento, encaminha links ao cliente certo e confirma", async () => {
  const a = await criarAmbiente();
  await iniciarConsultaChaveiro(a, CLI);
  a.llmCliente = () => decisao({ resposta: "Perfeito, vou consultar o profissional.", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { servico: "chaveiro", problema: "cópia de 3 chaves", bairro: "Tijuca", nome: "Bia" }, resumo_caso: "Bia quer 3 cópias da chave do portão." });
  await a.cliente(CLI2, "Oi, sou a Bia. Preciso de 3 cópias de chave, na Tijuca", { nome: "Bia" });
  assert.equal(a.para(CHAVEIRO).length, 2, "duas consultas abertas com o mesmo profissional");
  // Ele diz de quem está falando; a IA dele lê o que a cliente escreveu e o resumo.
  let entrada = "";
  a.llmPrestador = e => { entrada = e; return prest({ tipo: "PEDE_CONTEXTO" }); };
  await a.cliente(CHAVEIRO, "o da Bia na Tijuca, do que se trata?");
  assert.match(entrada, /O QUE O CLIENTE ESCREVEU[\s\S]*3 cópias de chave, na Tijuca/);
  assert.match(entrada, /RESUMO DO ATENDIMENTO: Bia quer 3 cópias/);
  assert.match(a.ultimoPara(CHAVEIRO), /Tijuca[\s\S]*cópia de 3 chaves/);
  // Mesma pergunta de novo, sem citar ninguém: segue a conversa (Bia) e não repete a mesma mensagem.
  const n = a.para(CHAVEIRO).length;
  await a.cliente(CHAVEIRO, "não entendi, do que se trata?");
  assert.equal(a.para(CHAVEIRO).length, n, "não manda a mesma mensagem duas vezes");
  assert.ok((await a.avisos()).some(t => /ia repetir/.test(t)));
  // Manda links e pede para encaminhar: vão inteiros para a Bia (e não para o outro cliente).
  const L1 = "https://www.airbnb.com.br/rooms/12345678901234?check_in=2027-02-12", L2 = "https://chaves.test/opcoes.pdf";
  a.llmPrestador = () => prest({ tipo: "ENCAMINHAR", mensagem_para_cliente: "Oi Bia! O profissional mandou as opções." });
  const antesCli = a.para(CLI).length;
  await a.cliente(CHAVEIRO, `Opções: ${L1} e ${L2} . Encaminha pra ela por favor`);
  const enviada = a.ultimoPara(CLI2);
  assert.ok(enviada.includes(L1) && enviada.includes(L2), "links inteiros: " + enviada);
  assert.equal(a.para(CLI).length, antesCli, "o outro cliente não recebe nada");
  assert.match(a.ultimoPara(CHAVEIRO), /Pronto, enviei para Bia ✅ \(2 links\)/);
});

test("Profissional sem pista de qual atendimento: pergunta uma vez só e depois chama a equipe", async () => {
  const a = await criarAmbiente();
  await iniciarConsultaChaveiro(a, CLI);
  a.llmCliente = () => decisao({ resposta: "Perfeito, vou consultar o profissional.", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { servico: "chaveiro", problema: "abrir porta", bairro: "Tijuca" } });
  await a.cliente(CLI2, "Preciso abrir a porta, Tijuca");
  a.avancar(19 * 3600000); // a conversa com ele esfriou (dia seguinte, em horário comercial)
  a.llmPrestador = () => prest({ tipo: "COMENTARIO" });
  await a.cliente(CHAVEIRO, "consigo amanhã");
  assert.equal(a.ultimoPara(CHAVEIRO), "É sobre qual cliente: o de abrir porta (Tijuca) ou o de troca de fechadura (Botafogo)?", "pergunta curta, só o essencial");
  const n = a.para(CHAVEIRO).length;
  await a.cliente(CHAVEIRO, "isso mesmo");
  assert.equal(a.para(CHAVEIRO).length, n, "não repete a pergunta");
  assert.ok((await a.avisos()).some(t => /não deu para saber de qual atendimento/.test(t)));
});

test("Reunião online: a DENIA marca, avisa o Telegram da Central, não duplica, remarca e lembra 1 h antes", async () => {
  const a = await criarAmbiente({ inicio: "2026-10-20T10:00:00-03:00" });
  a.llmCliente = () => decisao({ resposta: "Que dia e horário ficam bons pra reunião?" });
  await a.cliente(CLI, "Quero marcar uma reunião online", { nome: "Marcos" });
  let reuniaoEntrada = "";
  a.llmCliente = e => { reuniaoEntrada = e; return decisao({ resposta: "Prontinho, Marcos! Ficou confirmada para quinta às 15h. A equipe te envia o link.", reuniao: { acao: "marcar", quando: "2026-10-22 15:00", assunto: "conhecer os serviços da Central" } }); };
  await a.cliente(CLI, "quinta às 15h");
  assert.match(reuniaoEntrada, /DATA E HORA ATUAL: [\s\S]*terça-feira/);
  assert.match(a.ultimoPara(CLI), /confirmada para quinta às 15h/, "a frase não é cortada pela trava de 'agendado'");
  const avisos = a.telegram.filter(t => /REUNIÃO ONLINE MARCADA/.test(t));
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /Cliente: Marcos \(5521911112222\)[\s\S]*Quando: qui\.?, 22\/10,? 15:00[\s\S]*Assunto: conhecer os serviços/);
  // Repetiu o mesmo horário: não duplica e a IA vê o que já está marcado.
  await a.cliente(CLI, "confirmado então");
  assert.equal(a.telegram.filter(t => /REUNIÃO ONLINE MARCADA/.test(t)).length, 1);
  assert.match(reuniaoEntrada, /REUNIÕES MARCADAS COM ESTE CLIENTE: [^(]*conhecer os serviços/);
  // Remarcou.
  a.llmCliente = () => decisao({ resposta: "Sem problema, mudei para sexta às 10h.", reuniao: { acao: "remarcar", quando: "2026-10-23 10:00" } });
  await a.cliente(CLI, "pode ser sexta às 10h?");
  assert.ok(a.telegram.some(t => /REMARCADA \(antes: 22\/10\/2026,? 15:00\)[\s\S]*sex\.?, 23\/10,? 10:00/.test(t)), a.telegram.join("\n---\n"));
  // Lembrete ~1 h antes, uma vez só.
  a.agora = Date.parse("2026-10-23T09:05:00-03:00");
  await a.cron();
  assert.equal(a.telegram.filter(t => /LEMBRETE: reunião online daqui a 55 min/.test(t)).length, 1);
  a.avancar(5 * 60000); await a.cron();
  assert.equal(a.telegram.filter(t => /LEMBRETE/.test(t)).length, 1);
});

test("Reunião online e feriados: calendário certo na conversa, recusa feriado/domingo/fora do horário e sugere outro dia", async () => {
  const a = await criarAmbiente({ inicio: "2026-11-16T10:00:00-03:00" }); // segunda-feira
  let entrada = "";
  a.llmCliente = e => { entrada = e; return decisao({ resposta: "Que dia fica bom?" }); };
  await a.cliente(CLI, "Quero marcar uma reunião online", { nome: "Marcos" });
  assert.match(entrada, /seg 16\/11\/2026 \(hoje\)/);
  assert.match(entrada, /sex 20\/11\/2026 — DIA DA CONSCIÊNCIA NEGRA/);
  assert.match(entrada, /PRÓXIMOS FERIADOS DEPOIS DISSO: [^\n]*25\/12\/2026 \(sex\): Natal/);
  assert.match(entrada, /HORÁRIO DE REUNIÕES ONLINE: seg 08:00–18:00; ter 08:00–18:00/);
  // Feriado: não registra, explica e sugere o próximo dia possível no mesmo horário.
  a.llmCliente = () => decisao({ resposta: "Marcado para sexta, 20/11, às 15h!", reuniao: { acao: "marcar", quando: "2026-11-20 15:00", assunto: "apresentação" } });
  await a.cliente(CLI, "sexta dia 20 às 15h");
  assert.equal(a.ultimoPara(CLI), "Poxa, nesse horário não dá: 20/11 é Dia da Consciência Negra, feriado. Pode ser sábado, 21/11, às 08h?", "sábado só até 12h: sugere o início do expediente");
  assert.ok(!a.telegram.some(t => /REUNIÃO ONLINE MARCADA/.test(t)), "nada vai ao Telegram");
  // Domingo e fora do horário.
  a.llmCliente = () => decisao({ resposta: "Combinado!", reuniao: { acao: "marcar", quando: "2026-11-22 10:00" } });
  await a.cliente(CLI, "domingo 10h?");
  assert.match(a.ultimoPara(CLI), /não fazemos reunião aos domingos\. Pode ser segunda, 23\/11, às 10h\?/);
  a.llmCliente = () => decisao({ resposta: "Combinado!", reuniao: { acao: "marcar", quando: "2026-11-23 21:00" } });
  await a.cliente(CLI, "segunda 21h?");
  assert.match(a.ultimoPara(CLI), /as reuniões são das 08h às 18h\. Pode ser terça, 24\/11, às 08h\?/);
  // A IA errou o dia da semana: a confirmação sai com o dia certo da data registrada.
  a.llmCliente = () => decisao({ resposta: "Prontinho, ficou para quarta às 15h!", reuniao: { acao: "marcar", quando: "2026-11-24 15:00", assunto: "apresentação" } });
  await a.cliente(CLI, "terça 24 às 15h então");
  assert.equal(a.ultimoPara(CLI), "Prontinho! Sua reunião online ficou marcada para terça, 24/11, às 15h. A equipe vai te enviar o link. 😊");
  assert.equal(a.telegram.filter(t => /REUNIÃO ONLINE MARCADA/.test(t)).length, 1);
});

test("Feriados móveis calculados para qualquer ano (Carnaval, Sexta-feira Santa, Corpus Christi) e meio expediente", async () => {
  const a = await criarAmbiente({ inicio: "2027-02-01T10:00:00-03:00", env: { REUNIAO_HORARIO: "seg-sex 09:00-17:00" } });
  let entrada = "";
  a.llmCliente = e => { entrada = e; return decisao({ resposta: "Oi!" }); };
  await a.cliente(CLI, "oi");
  assert.match(entrada, /seg 08\/02\/2027 — CARNAVAL \(SEGUNDA-FEIRA\)/);
  assert.match(entrada, /ter 09\/02\/2027 — CARNAVAL \(TERÇA-FEIRA\)/);
  assert.match(entrada, /qua 10\/02\/2027 — QUARTA-FEIRA DE CINZAS/);
  assert.match(entrada, /26\/03\/2027 \(sex\): Sexta-feira Santa/);
  assert.match(entrada, /HORÁRIO DE REUNIÕES ONLINE: seg 09:00–17:00; ter 09:00–17:00; qua 09:00–17:00; qui 09:00–17:00; sex 09:00–17:00 \(/);
  a.llmCliente = () => decisao({ resposta: "Marcado!", reuniao: { acao: "marcar", quando: "2027-02-10 10:00" } });
  await a.cliente(CLI, "quarta de cinzas 10h");
  assert.match(a.ultimoPara(CLI), /Quarta-feira de Cinzas só tem atendimento a partir das 14h\. Pode ser quarta, 10\/02, às 14h\?/);
});

test("Fora da janela de 24 h: um aviso só, sem novas tentativas; a mensagem fica guardada e sai quando a pessoa responde", async () => {
  const a = await criarAmbiente();
  await iniciarConsultaChaveiro(a);
  const consulta = a.para(CHAVEIRO)[0];
  const falhar = id => a.webhook({ statuses: [{ id, status: "failed", recipient_id: CHAVEIRO, errors: [{ code: 131047, title: "Re-engagement message" }] }] });
  await falhar(consulta.id);
  const avisos = async () => [...a.telegram, ...(await a.avisos())].filter(t => /📵|NÃO entregue|Falha no envio|NÃO foi enviado/.test(t));
  assert.equal((await avisos()).length, 1);
  assert.ok(!a.telegram.some(t => /📵/.test(t)), "não é urgente: não vai ao Telegram");
  assert.match((await avisos())[0], /📵 [\s\S]*profissional[\s\S]*não escreve há mais de 24 h[\s\S]*ficou guardada e sai sozinha/);
  // Pergunta do cliente para o profissional: não tenta mandar (iria falhar de novo) e não gera aviso novo.
  const antes = a.para(CHAVEIRO).length;
  a.llmCliente = () => decisao({ resposta: "Vou confirmar com o profissional.", intencao: "PERGUNTA_PARA_PROFISSIONAL", resposta_para_profissional: "A fechadura nova está inclusa no valor?" });
  await a.cliente(CLI, "A fechadura nova está inclusa?");
  assert.equal(a.para(CHAVEIRO).length, antes, "nada enviado enquanto a janela está fechada");
  assert.doesNotMatch(a.ultimoPara(CLI), /Um momento/, "o cliente não fica sem resposta");
  await falhar(consulta.id); await falhar(consulta.id);
  assert.equal((await avisos()).length, 1, "nunca o mesmo aviso de novo");
  // O profissional escreve: recebe primeiro o que ficou guardado (a consulta e a pergunta do cliente).
  a.llmPrestador = () => prest({ tipo: "COMENTARIO" });
  await a.cliente(CHAVEIRO, "Bom dia, vi agora");
  const novas = a.para(CHAVEIRO).slice(antes).map(e => e.texto).join("\n");
  assert.match(novas, /Cliente em Botafogo precisando de/);
  assert.match(novas, /A fechadura nova está inclusa no valor\?/);
});

test("Fora da janela com modelo de retomada configurado: manda o modelo uma vez por dia", async () => {
  const a = await criarAmbiente({ env: { WHATSAPP_TEMPLATE_RETOMAR: "retomar_conversa" } });
  a.llmCliente = () => decisao({ resposta: "Oi, Marcos! Tudo certo?" });
  await a.cliente(CLI, "oi", { nome: "Marcos" });
  const id = a.para(CLI).at(-1).id;
  await a.webhook({ statuses: [{ id, status: "failed", recipient_id: CLI, errors: [{ code: 131047, title: "Re-engagement message" }] }] });
  const modelos = a.para(CLI).filter(e => e.type === "template");
  assert.equal(modelos.length, 1); assert.equal(modelos[0].texto, "retomar_conversa");
  assert.equal(modelos[0].corpo.template.components[0].parameters[0].text, "Marcos");
  assert.ok((await a.avisos()).some(t => /Mandei o modelo "retomar_conversa"/.test(t)));
  await a.webhook({ statuses: [{ id, status: "failed", recipient_id: CLI, errors: [{ code: 131047, title: "Re-engagement message" }] }] });
  assert.equal(a.para(CLI).filter(e => e.type === "template").length, 1, "uma vez por dia");
});

test("Número sem WhatsApp e falhas repetidas: um aviso por pessoa e motivo, sem insistir no número", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Oi! Como posso ajudar?" });
  await a.cliente(CLI, "oi");
  await a.webhook({ statuses: [{ id: a.para(CLI).at(-1).id, status: "failed", recipient_id: CLI, errors: [{ code: 131026, title: "Message undeliverable" }] }] });
  assert.equal((await a.avisos()).filter(t => /NÃO entregue/.test(t)).length, 1);
  assert.match((await a.avisos()).at(-1), /não vai tentar de novo nesse número por 7 dias/);
  assert.equal(a.telegram.filter(t => /NÃO entregue/.test(t)).length, 0, "nada disso vai ao Telegram");
  // Outra falha de outro tipo, duas vezes para a mesma pessoa: um aviso só.
  a.llmCliente = () => decisao({ resposta: "Segue a foto." });
  await a.cliente(CLI2, "manda a foto");
  for (let i = 0; i < 3; i++) await a.webhook({ statuses: [{ id: "wamid.x" + i, status: "failed", recipient_id: CLI2, errors: [{ code: 131053, title: "Media upload error" }] }] });
  assert.equal((await a.avisos()).filter(t => /NÃO entregue para 5521933334444/.test(t)).length, 1);
});

test("Equipe pelo Telegram: responde o aviso 'a equipe decide' e a DENIA consulta o profissional indicado", async () => {
  const a = await criarAmbiente();
  // Liga o Telegram da equipe (setWebhook com segredo).
  const lig = await (await a.http("/api/telegram/conectar", { method: "POST", body: "{}" })).json();
  assert.equal(lig.ok, true, JSON.stringify(lig));
  assert.equal(a.tgWebhook, "https://denia.test/telegram");
  // Sem o segredo ou de outro grupo: ignorado.
  assert.equal((await a.equipe("oi", { segredo: "errado" })).status, 401);
  a.llmEquipe = () => { throw new Error("não deveria chamar a IA"); };
  await a.equipe("manda pro Carlos", { chat: "-999" });
  // Cliente pede algo sem profissional certo: aviso "a equipe decide".
  a.llmCliente = () => decisao({ resposta: "Vou verificar com a equipe.", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { servico: "lavagem de fachada", problema: "lavar a fachada de vidro do prédio, 3 andares", bairro: "Tijuca", nome: "Ana" }, categoria_confianca: "BAIXA" });
  await a.cliente(CLI, "Preciso lavar a fachada de vidro do prédio, 3 andares, Tijuca", { nome: "Ana" });
  const aviso = a.telegramMsgs.find(t => /a equipe decide/.test(t.texto));
  assert.ok(aviso, a.telegram.join("\n---\n"));
  assert.match(aviso.texto, /Responda esta mensagem para me dizer o que fazer/);
  assert.equal(a.para(MIRELLA).length, 0);
  // A equipe responde o aviso: "manda pro Carlos estofador".
  let entrada = "";
  a.llmEquipe = e => { entrada = e; return { caso_id: 0, acoes: [{ tipo: "CONSULTAR", prestador_id: "HIG-MIRELLA", categoria: "HIGIENIZACAO" }], resposta: "", pergunta: "" }; };
  await a.equipe("isso é com a Mirella, manda pra ela", { responde: aviso.id });
  assert.match(entrada, /AVISO QUE ELA RESPONDEU:[\s\S]*a equipe decide/);
  assert.match(entrada, /CASO DO AVISO:\n#\d+ — cliente Ana[\s\S]*lavar a fachada de vidro/);
  assert.match(entrada, /HIG-MIRELLA \| Mirella/);
  assert.equal(a.para(MIRELLA).length, 1, "consulta enviada ao profissional indicado");
  assert.match(a.para(MIRELLA)[0].texto, /lavar a fachada de vidro/);
  const conf = a.telegramMsgs.at(-1);
  assert.match(conf.texto, /✅ Consultei Mirella sobre o atendimento de Ana/);
  assert.equal(conf.responde, 503, "responde a mensagem da equipe no grupo (a 3ª enviada no teste)");
  assert.match(a.ultimoPara(CLI), /^Enviamos sua solicitação ao profissional/);
  // Pergunta solta: só responde.
  a.llmEquipe = () => ({ caso_id: 0, acoes: [], resposta: "Higienização: Mirella e Paulo.", pergunta: "" });
  await a.equipe("@DeniaBot quem faz higienização?");
  assert.equal(a.telegramMsgs.at(-1).texto, "Higienização: Mirella e Paulo.");
  // Falar com o cliente e pausar a IA na conversa, numa mensagem só.
  a.llmEquipe = () => ({ caso_id: 0, acoes: [{ tipo: "MENSAGEM_CLIENTE", texto: "Oi Ana! A Mirella passa amanhã às 10h para ver a fachada." }, { tipo: "PAUSAR" }], resposta: "", pergunta: "" });
  await a.equipe("avisa a Ana que a Mirella passa amanhã 10h e deixa que eu assumo", { responde: aviso.id });
  assert.equal(a.ultimoPara(CLI), "Oi Ana! A Mirella passa amanhã às 10h para ver a fachada.");
  assert.match(a.telegramMsgs.at(-1).texto, /✅ Mandei para Ana[\s\S]*⏸️ Pausei a DENIA na conversa com Ana/);
  const n = a.para(CLI).length;
  a.llmCliente = () => decisao({ resposta: "Oi!" });
  await a.cliente(CLI, "Combinado, obrigada");
  assert.equal(a.para(CLI).length, n, "a DENIA fica calada enquanto a equipe assume");
  // Ação sem saber o caso: pergunta em vez de chutar.
  a.llmEquipe = () => ({ caso_id: 0, acoes: [{ tipo: "MENSAGEM_CLIENTE", texto: "Oi!" }], resposta: "", pergunta: "" });
  await a.equipe("manda um oi pro cliente");
  assert.match(a.telegramMsgs.at(-1).texto, /De qual atendimento você está falando/);
});

test("Telegram da equipe na mudança para a Hostinger: troca o endereço antigo da Central, nunca o de outro sistema", async () => {
  const a = await criarAmbiente();
  a.tgWebhook = "https://denia.velho.workers.dev/telegram"; // ligado antes, na Cloudflare
  const r1 = await (await a.http("/api/telegram/conectar", { method: "POST", body: "{}", headers: { "x-denia-prefixo": "/ia" } })).json();
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(a.tgWebhook, "https://denia.test/ia/telegram");
  a.tgWebhook = "https://plataforma.test/webhook/telegram"; // bot usado por outro sistema
  const r2 = await (await a.http("/api/telegram/conectar", { method: "POST", body: "{}" })).json();
  assert.equal(r2.ok, false);
  assert.equal(a.tgWebhook, "https://plataforma.test/webhook/telegram", "não mexe no endereço de outro sistema");
});

test("Pedido sem bairro: pergunta o bairro antes de chamar o profissional; o pedido vai com resumo e bairro", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Certo!", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { servico: "higienização de sofá", problema: "lavar sofá de 3 lugares" }, resumo_caso: "Cliente quer lavar um sofá de 3 lugares de tecido, com manchas de café, de preferência sábado de manhã." });
  await a.cliente(CLI, "Quero lavar meu sofá de 3 lugares, tem mancha de café. Mas não é pra usar produto forte");
  assert.equal(a.ultimoPara(CLI), "Perfeito! Pra eu já passar ao profissional certo: em qual bairro é o atendimento?");
  assert.equal(a.para(MIRELLA).length, 0, "ainda não chama o profissional");
  a.llmCliente = () => decisao({ resposta: "Obrigada!", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { bairro: "Tijuca" } });
  await a.cliente(CLI, "Tijuca");
  const pedido = a.para(MIRELLA)[0]?.texto || "";
  assert.match(pedido, /Cliente em Tijuca precisando de lavar sofá de 3 lugares\.\nConsegue pegar\? Se sim, me passa o valor e quando pode\.$/);
  assert.doesNotMatch(pedido, /Resumo|manchas de café/, "breve: só a necessidade e o bairro");
  assert.doesNotMatch(pedido, /não é pra usar produto forte|O cliente me contou/, "não copia frases soltas do cliente");
});

test("Profissional pergunta 'qual o bairro?' logo depois do pedido: responde sobre ESTE pedido, sem listar outros casos", async () => {
  const a = await criarAmbiente();
  await iniciarConsultaChaveiro(a, CLI); // um atendimento antigo com o mesmo profissional
  a.avancar(2 * 3600000);
  a.llmCliente = () => decisao({ resposta: "Perfeito, vou consultar o profissional.", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { servico: "chaveiro", problema: "abrir porta trancada", bairro: "Tijuca", nome: "Bia" } });
  await a.cliente(CLI2, "Fiquei trancada pra fora, Tijuca", { nome: "Bia" });
  assert.equal(a.para(CHAVEIRO).length, 2);
  let entrada = "";
  a.llmPrestador = e => { entrada = e; return prest({ tipo: "PERGUNTA", resposta_conhecida: "É na Tijuca." }); };
  await a.cliente(CHAVEIRO, "qual o bairro?");
  assert.doesNotMatch(a.ultimoPara(CHAVEIRO), /não confundir|qual cliente/, "não pergunta de qual caso é");
  assert.match(a.ultimoPara(CHAVEIRO), /É na Tijuca/);
  assert.match(entrada, /abrir porta trancada/, "a IA leu o pedido certo");
});

test("Caso do print: 4 atendimentos abertos com a Mirella, pedido novo e 'Qual o bairro?' 4 min depois", async () => {
  const a = await criarAmbiente({ inicio: "2026-10-20T14:00:00-03:00" });
  const pedir = async (tel, nome, problema, bairro) => {
    a.llmCliente = () => decisao({ resposta: "Vou consultar.", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { servico: "higienização", problema, ...(bairro ? { bairro } : {}), nome } });
    await a.cliente(tel, problema, { nome });
  };
  await pedir("5521900000001", "Thais", "lavagem e higienização de tapete", "Méier");
  a.avancar(40 * 60000);
  await pedir("5521900000002", "Alexandra", "limpeza e higienização do sofá", "Grajaú");
  a.avancar(60 * 60000);
  await pedir("5521900000003", "Maria", "higienização de sofá", "Botafogo");
  a.avancar(15 * 60000);
  await pedir("5521900000004", "Tiago", "limpeza de sofá retrátil de 2 m, suede", "Tijuca");
  assert.equal(a.para(MIRELLA).length, 4);
  a.avancar(4 * 60000);
  let entrada = "";
  a.llmPrestador = e => { entrada = e; return prest({ tipo: "PERGUNTA", resposta_conhecida: "É na Tijuca." }); };
  await a.cliente(MIRELLA, "Qual o bairro?");
  assert.doesNotMatch(a.ultimoPara(MIRELLA), /não confundir|qual cliente/);
  assert.match(a.ultimoPara(MIRELLA), /É na Tijuca/);
  assert.match(entrada, /sofá retrátil/);
});

test("Profissionais editáveis: cadastrar quem pendura quadro e a DENIA já consulta essa pessoa", async () => {
  const a = await criarAmbiente({ env: { DENIA_PLATFORM_SERVICE_TOKEN: SERVICO } });
  const lista = await (await api(a, "/platform/professionals")).json();
  assert.ok(lista.profissionais.some(p => p.id === "CHAV-ANDERSON"), "a lista inicial vai para o banco");
  assert.ok(lista.categorias.some(k => k.id === "PEQUENOS_REPAROS"));
  const JOAO = "5521911119999";
  const r = await (await api(a, "/platform/professionals", { method: "POST", body: JSON.stringify({ nome: "João Faz Tudo", telefone: "21 91111-9999", area: "PEQUENOS_REPAROS", servicos: "pendura quadros, instala prateleiras e cortinas, monta móveis" }) })).json();
  assert.equal(r.sucesso, true, JSON.stringify(r));
  assert.equal((await (await api(a, "/platform/professionals", { method: "POST", body: JSON.stringify({ nome: "Outro", telefone: "21 91111-9999", area: "REFORMA" }) })).json()).sucesso, false, "o mesmo número não fica com duas pessoas");
  let entrada = "";
  a.llmCliente = e => { entrada = e; return decisao({ resposta: "Certo!", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { servico: "pendurar quadros", problema: "pendurar 3 quadros na sala", bairro: "Tijuca" } }); };
  await a.cliente(CLI, "Preciso pendurar 3 quadros na sala, Tijuca");
  assert.match(entrada, /PEQUENOS_REPAROS: Pequenos reparos[^\n]*profissionais: João Faz Tudo \(faz: pendura quadros/, "a IA sabe quem faz o quê");
  assert.equal(a.para(JOAO).length, 1, "consulta o profissional cadastrado");
  assert.match(a.para(JOAO)[0].texto, /pendurar 3 quadros na sala/);
  // Desativar: deixa de ser consultado.
  await api(a, `/platform/professionals/${r.id}/delete`, { method: "POST", body: "{}" });
  assert.ok(!(await (await api(a, "/platform/professionals")).json()).profissionais.find(p => p.id === r.id).ativo);
});

test("Comprovante do profissional com vários atendimentos: a IA acha o cliente pelo conteúdo e não pergunta", async () => {
  const a = await criarAmbiente();
  await iniciarConsultaChaveiro(a, CLI);
  a.llmCliente = () => decisao({ resposta: "Perfeito, vou consultar o profissional.", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { servico: "chaveiro", problema: "cópia de 3 chaves", bairro: "Tijuca", nome: "Bia" } });
  await a.cliente(CLI2, "Preciso de 3 cópias de chave, Tijuca", { nome: "Bia" });
  let lido = "";
  a.llmIdentifica = e => { lido = e; return { caso_id: Number(e.match(/#(\d+) — cliente Bia/)[1]), confianca: "ALTA", motivo: "comprovante de R$ 45 das cópias de chave" }; };
  a.llmPrestador = () => prest({ tipo: "COMPROVANTE", resumo: "Pix de R$ 45,00 em 07/10 — cópias de chave" });
  await a.cliente(CHAVEIRO, "segue", { type: "image", raw: { image: { id: "media-pix-1", mime_type: "image/jpeg", caption: "segue" } } });
  assert.match(lido, /ATENDIMENTOS ABERTOS COM ELE:[\s\S]*cliente Bia, Tijuca: cópia de 3 chaves/);
  assert.match(lido, /há anexo/);
  assert.equal(a.ultimoPara(CHAVEIRO), "Recebido, obrigado! ✅", "curto, sem perguntar de qual cliente");
  assert.ok(a.telegram.some(t => /Comprovante de Anderson \(chaveiro\) sobre o atendimento de Bia[\s\S]*Pix de R\$ 45,00/.test(t)));
});

test("Pede ajuda o mínimo: no mesmo atendimento, um aviso a cada 2 h no Telegram; pedido de atendente sempre chega", async () => {
  const a = await criarAmbiente();
  await iniciarConsultaChaveiro(a);
  const base = a.telegram.length;
  a.llmCliente = () => decisao({ resposta: "Vou ver isso.", precisa_humano: true, motivo_humano: "cliente perguntou sobre garantia estendida" });
  await a.cliente(CLI, "tem garantia estendida?");
  a.llmCliente = () => decisao({ resposta: "Certo.", precisa_humano: true, motivo_humano: "quer nota fiscal" });
  await a.cliente(CLI, "e nota fiscal?");
  const novos = a.telegram.slice(base).filter(t => /Atenção na conversa/.test(t));
  assert.equal(novos.length, 1, "o segundo pedido de apoio do mesmo atendimento vai só para Problemas");
  assert.ok((await a.avisos()).some(t => /quer nota fiscal/.test(t)));
  a.llmCliente = () => decisao({ resposta: "Claro!", intencao: "FALAR_COM_HUMANO" });
  await a.cliente(CLI, "quero falar com uma pessoa");
  assert.ok(a.telegram.some(t => /pediu para falar com um atendente/.test(t)), "pedido de atendente sempre chega");
});

test("Profissional que não responde: a DENIA lembra uma vez e depois passa ao próximo da mesma área", async () => {
  const QEZIA = "5521998652205", JOAO = "5521993781381";
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Certo!", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { servico: "marcenaria", problema: "armário sob medida", bairro: "Tijuca" } });
  await a.cliente(CLI, "Quero um armário sob medida na Tijuca", { nome: "Paula" });
  assert.equal(a.para(QEZIA).length, 1);

  a.avancar(20 * 60000); await a.cron();
  assert.equal(a.para(QEZIA).length, 1, "antes do tempo não cobra");
  a.avancar(25 * 60000); await a.cron();
  assert.equal(a.para(QEZIA).length, 2, "lembra uma vez");
  assert.match(a.ultimoPara(QEZIA), /conseguiu ver o pedido de Paula \(Tijuca\)\?/);
  assert.doesNotMatch(a.ultimoPara(QEZIA), /caso|#\d/i);
  await a.cron();
  assert.equal(a.para(QEZIA).length, 2, "não repete o lembrete");
  assert.equal(a.para(JOAO).length, 0);

  a.avancar(61 * 60000); await a.cron();
  assert.equal(a.para(QEZIA).length, 2);
  assert.equal(a.para(JOAO).length, 1, "passou ao próximo marceneiro");
  assert.match(a.ultimoPara(JOAO), /armário sob medida/);
  assert.equal(a.para(CLI).length, 1, "o cliente não recebe mensagens extras");
});

test("Profissional que já respondeu (mesmo com pergunta) não é cobrado nem trocado", async () => {
  const QEZIA = "5521998652205", JOAO = "5521993781381";
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Certo!", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { servico: "marcenaria", problema: "armário sob medida", bairro: "Tijuca" } });
  await a.cliente(CLI, "Quero um armário sob medida na Tijuca", { nome: "Paula" });
  a.llmPrestador = () => prest({ tipo: "COMENTARIO" });
  await a.cliente(QEZIA, "Vou ver aqui minha agenda e te falo");
  const n = a.para(QEZIA).length;
  a.avancar(3 * 3600000); await a.cron(); await a.cron();
  assert.equal(a.para(QEZIA).length, n);
  assert.equal(a.para(JOAO).length, 0);
});

test("Profissional confirma o mesmo horário com outras palavras: agenda direto, sem voltar ao cliente", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Certo!", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { servico: "troca de tecido do sofá", bairro: "Copacabana", endereco: "Rua Barata Ribeiro, 200" } });
  await a.cliente(CLI, "Quero trocar o tecido do sofá, Rua Barata Ribeiro, 200, Copacabana", { nome: "Maria" });
  a.llmPrestador = () => prest({ tipo: "ACEITA", valor_centavos: 60000, valor_e_final: "SIM", disponibilidade: "amanhã às 14h" });
  await a.cliente(CARLOS_ESTOF, "Faço, 600 final, amanhã às 14h");
  a.llmCliente = () => decisao({ resposta: "Ótimo!", intencao: "ACEITA_PROPOSTA" });
  await a.cliente(CLI, "Pode ser");
  assert.match(a.ultimoPara(CARLOS_ESTOF), /Pode confirmar/);
  a.llmPrestador = () => prest({ tipo: "CONFIRMA_AGENDAMENTO", disponibilidade: "amanhã 14:00" });
  await a.cliente(CARLOS_ESTOF, "Confirmado amanhã 14:00");
  assert.equal(a.DB.q("SELECT etapa FROM d30_casos")[0].etapa, "AGENDADO");
  assert.match(a.ultimoPara(CLI), /Atendimento confirmado pelo profissional/);

  // E "ok" do profissional depois não vira aviso para a equipe.
  const antes = a.DB.q("SELECT COUNT(*) n FROM d30_eventos WHERE tipo IN ('AVISO_PAINEL','ALERTA_EQUIPE')")[0].n;
  await a.cliente(CARLOS_ESTOF, "ok");
  assert.equal(a.DB.q("SELECT COUNT(*) n FROM d30_eventos WHERE tipo IN ('AVISO_PAINEL','ALERTA_EQUIPE')")[0].n, antes);
});

test("Profissional propõe outro horário: vai ao cliente e o profissional sabe que estamos vendo", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Certo!", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { servico: "troca de tecido do sofá", bairro: "Copacabana", endereco: "Rua Barata Ribeiro, 200" } });
  await a.cliente(CLI, "Quero trocar o tecido do sofá, Rua Barata Ribeiro, 200, Copacabana", { nome: "Maria" });
  a.llmPrestador = () => prest({ tipo: "ACEITA", valor_centavos: 60000, valor_e_final: "SIM", disponibilidade: "amanhã às 14h" });
  await a.cliente(CARLOS_ESTOF, "Faço, 600 final, amanhã às 14h");
  a.llmCliente = () => decisao({ resposta: "Ótimo!", intencao: "ACEITA_PROPOSTA" });
  await a.cliente(CLI, "Pode ser");
  a.llmPrestador = () => prest({ tipo: "CONFIRMA_AGENDAMENTO", disponibilidade: "sexta às 9h" });
  await a.cliente(CARLOS_ESTOF, "Amanhã não vou conseguir, pode ser sexta às 9h?");
  assert.match(a.ultimoPara(CLI), /propôs sexta às 9h/);
  assert.match(a.ultimoPara(CARLOS_ESTOF), /vou ver com o cliente se sexta às 9h funciona/);
});

test("Nome do cliente: só na primeira vez, não em toda mensagem", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Oi, Maria! Tudo bem? Como posso ajudar?" });
  await a.cliente(CLI, "Oi", { nome: "Maria Souza" });
  assert.match(a.ultimoPara(CLI), /Maria/);
  a.llmCliente = () => decisao({ resposta: "Claro, Maria, consigo te ajudar com isso. Maria, qual é o modelo?" });
  await a.cliente(CLI, "Minha geladeira parou");
  assert.doesNotMatch(a.ultimoPara(CLI), /Maria/);
  assert.match(a.ultimoPara(CLI), /^Claro, consigo te ajudar com isso\. Qual é o modelo\?$/);
  a.llmCliente = () => decisao({ resposta: "Perfeito, Maria." });
  await a.cliente(CLI, "É uma Brastemp");
  assert.equal(a.ultimoPara(CLI), "Perfeito.");
});

test("Vídeo do cliente: a IA recebe a fala e o que aparece nas imagens", async () => {
  const a = await criarAmbiente({ env: { QUADROS_VIDEO: async () => [{ mime: "image/jpeg", base64: "AAAA" }] } });
  a.transcricaoAtual = "Olha, a máquina faz esse barulho quando centrifuga";
  let entradaCliente = "";
  a.llmCliente = (e) => { entradaCliente = e; return decisao({ resposta: "Entendi, vou ver isso." }); };
  await a.cliente(CLI, "", { type: "video", raw: { video: { id: "media-video-1", mime_type: "video/mp4" } } });
  assert.match(entradaCliente, /\[Vídeo analisado\] ok \| Fala: Olha, a máquina faz esse barulho/);

  const b = await criarAmbiente();
  b.transcricaoAtual = "A torneira não para de pingar";
  b.llmCliente = (e) => { entradaCliente = e; return decisao({ resposta: "Entendi." }); };
  await b.cliente(CLI, "", { type: "video", raw: { video: { id: "media-video-2", mime_type: "video/mp4" } } });
  assert.match(entradaCliente, /\[Vídeo — o que a pessoa fala no vídeo\] A torneira não para de pingar/, "sem quadros, usa a fala");
});

test("Cliente manda só 'Oi' e continua escrevendo: a DENIA espera e responde uma vez só", async () => {
  const a = await criarAmbiente({ env: { JANELA_AGRUPAMENTO_MS: "150" } });
  a.llmCliente = (entrada) => { assert.match(entrada, /- Oi\n- minha geladeira parou/); return decisao({ resposta: "Poxa! Qual é a marca?" }); };
  const p1 = a.cliente(CLI, "Oi");
  await new Promise(r => setTimeout(r, 220)); // passou a espera normal, mas "Oi" sozinho ainda não terminou
  const p2 = a.cliente(CLI, "minha geladeira parou");
  await Promise.all([p1, p2]);
  assert.equal(a.llm.filter(x => x.papel === "cliente").length, 1);
  assert.equal(a.para(CLI).length, 1);
});

test("Serviço agendado: depois do horário a DENIA pergunta ao profissional; feito → conclui e pergunta ao cliente", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Certo!", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { servico: "troca de tecido do sofá", bairro: "Copacabana", endereco: "Rua Barata Ribeiro, 200" } });
  await a.cliente(CLI, "Quero trocar o tecido do sofá, Rua Barata Ribeiro, 200, Copacabana", { nome: "Maria" });
  a.llmPrestador = () => prest({ tipo: "ACEITA", valor_centavos: 60000, valor_e_final: "SIM", disponibilidade: "amanhã às 14h" });
  await a.cliente(CARLOS_ESTOF, "Faço, 600 final, amanhã às 14h");
  a.llmCliente = () => decisao({ resposta: "Ótimo!", intencao: "ACEITA_PROPOSTA" });
  await a.cliente(CLI, "Pode ser");
  a.llmPrestador = () => prest({ tipo: "CONFIRMA_AGENDAMENTO" });
  await a.cliente(CARLOS_ESTOF, "Confirmado");
  assert.equal(a.DB.q("SELECT etapa FROM d30_casos")[0].etapa, "AGENDADO");
  await a.cron();
  const acomp = a.DB.q("SELECT * FROM d30_acompanhamentos")[0];
  assert.equal(acomp.status, "AGUARDANDO");
  assert.equal(new Date(acomp.quando_ms).toISOString(), "2026-10-08T17:00:00.000Z", "amanhã às 14h (Brasília)");

  const antes = a.para(CARLOS_ESTOF).length;
  a.agora = Date.parse("2026-10-08T15:30:00-03:00"); await a.cron();
  assert.equal(a.para(CARLOS_ESTOF).length, antes, "antes do horário + 2 h não pergunta");
  a.agora = Date.parse("2026-10-08T16:30:00-03:00"); await a.cron();
  assert.match(a.ultimoPara(CARLOS_ESTOF), /deu tudo certo no atendimento de Maria \(Copacabana\)\? Já ficou pronto\?/);
  await a.cron();
  assert.equal(a.para(CARLOS_ESTOF).length, antes + 1, "pergunta uma vez só");

  a.llmPrestador = () => prest({ tipo: "COMENTARIO" });
  a.llmProfAgendado = () => ({ resposta: "Perfeito, obrigada! 🙏", precisa_equipe: false, servico: "FEITO" });
  await a.cliente(CARLOS_ESTOF, "Terminei agora, ficou ótimo");
  assert.equal(a.DB.q("SELECT etapa FROM d30_casos")[0].etapa, "CONCLUIDO");
  assert.match(a.ultimoPara(CLI), /serviço foi concluído\. Ficou tudo certo/);
  assert.equal(a.DB.q("SELECT status FROM d30_acompanhamentos")[0].status, "FEITO");
});

test("Serviço agendado sem resposta do profissional: a equipe é avisada no Telegram", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Certo!", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: true, fatos: { servico: "troca de tecido do sofá", bairro: "Copacabana", endereco: "Rua Barata Ribeiro, 200" } });
  await a.cliente(CLI, "Quero trocar o tecido do sofá, Rua Barata Ribeiro, 200, Copacabana", { nome: "Maria" });
  a.llmPrestador = () => prest({ tipo: "ACEITA", valor_centavos: 60000, valor_e_final: "SIM", disponibilidade: "sexta às 9h" });
  await a.cliente(CARLOS_ESTOF, "Faço, 600 final, sexta às 9h");
  a.llmCliente = () => decisao({ resposta: "Ótimo!", intencao: "ACEITA_PROPOSTA" });
  await a.cliente(CLI, "Pode ser");
  a.llmPrestador = () => prest({ tipo: "CONFIRMA_AGENDAMENTO" });
  await a.cliente(CARLOS_ESTOF, "Confirmado");
  await a.cron();
  assert.equal(new Date(a.DB.q("SELECT quando_ms FROM d30_acompanhamentos")[0].quando_ms).toISOString(), "2026-10-09T12:00:00.000Z", "sexta às 9h");
  a.agora = Date.parse("2026-10-09T11:30:00-03:00"); await a.cron();
  assert.match(a.ultimoPara(CARLOS_ESTOF), /deu tudo certo/);
  a.agora = Date.parse("2026-10-09T16:00:00-03:00"); await a.cron();
  assert.ok(a.telegram.some(t => /Perguntei a Carlos \(estofador\) se o serviço de Maria \(Copacabana\)[\s\S]*não respondeu/.test(t)));
});

test("Equipe ensina a DENIA pelo Telegram: vira pedido para o administrador aprovar, e só depois vale", async () => {
  const TOKEN = "token-da-plataforma-123456";
  const a = await criarAmbiente({ env: { DENIA_PLATFORM_SERVICE_TOKEN: TOKEN } });
  await a.http("/api/telegram/conectar", { method: "POST", body: "{}" });
  a.llmEquipe = () => ({ caso_id: 0, acoes: [{ tipo: "INSTRUCAO", titulo: "Sem emoji com cliente novo", conteudo: "Não use emojis na primeira conversa com um cliente novo." }], resposta: "", pergunta: "" });
  await a.equipe("Denia, não usa emoji com cliente novo, fica estranho");
  assert.match(a.telegram.at(-1), /Anotei[\s\S]*administrador aprovar/);
  const s = a.DB.q("SELECT * FROM d30_sugestoes")[0];
  assert.equal(s.tipo, "INSTRUCAO_EQUIPE");
  assert.equal(s.status, "PENDENTE");
  assert.match(s.evidencia, /Ana no Telegram/);
  let entrada = "";
  a.llmCliente = (e) => { entrada = e; return decisao({ resposta: "Oi!" }); };
  await a.cliente(CLI, "Oi, preciso de ajuda com a geladeira");
  assert.doesNotMatch(entrada, /Não use emojis/, "antes de aprovar não vale");
  await a.http("/platform/learning/suggestions/" + s.id, { method: "POST", headers: { authorization: "Bearer " + TOKEN }, body: JSON.stringify({ acao: "aprovar", autor: "admin" }) });
  await a.cliente(CLI, "É uma Brastemp, parou de gelar");
  assert.match(entrada, /Não use emojis na primeira conversa/, "depois de aprovado entra no atendimento");
});

test("Estudo: a DENIA leva dúvidas às atendentes, escolhe o que estudar e o que aprende vai para aprovação", async () => {
  const TOKEN = "token-da-plataforma-123456";
  const a = await criarAmbiente({ env: { DENIA_PLATFORM_SERVICE_TOKEN: TOKEN } });
  await a.http("/api/telegram/conectar", { method: "POST", body: "{}" });
  a.llmCliente = () => decisao({ resposta: "Certo!" });
  await a.cliente(CLI, "Vocês dão desconto à vista?");
  a.llmEstudo = () => ({ nota: 8, resumo: "Ok.", erros: [], licoes: [], conhecimento: [],
    duvidas: [{ situacao: "Cliente pediu desconto à vista.", pergunta: "Posso oferecer desconto para pagamento à vista? Quanto?" }],
    estudar: [{ tema: "como responder pedido de desconto sem perder a venda", motivo: "não soube responder desconto" }] });
  await a.http("/platform/study/run", { method: "POST", headers: { authorization: "Bearer " + TOKEN }, body: "{}" });
  assert.ok(a.telegram.some(t => /DÚVIDA DA DENIA[\s\S]*desconto para pagamento à vista/.test(t)));

  a.llmWeb = (entrada) => { assert.match(entrada, /como responder pedido de desconto sem perder a venda/); return "- Mostre o que está incluso no serviço antes de falar de preço.\n- Ofereça parcelamento em vez de desconto quando a empresa permitir."; };
  await a.http("/platform/study/run", { method: "POST", headers: { authorization: "Bearer " + TOKEN }, body: JSON.stringify({ tipo: "pesquisa" }) });
  const web = a.llm.find(x => x.papel === "web");
  assert.equal(web.ferramentas[0].type, "web_search");
  const s = a.DB.q("SELECT * FROM d30_sugestoes WHERE tipo='ESTUDO'")[0];
  assert.equal(s.status, "PENDENTE");
  assert.match(s.conteudo, /Mostre o que está incluso/);
  const st = await (await a.http("/platform/study", { headers: { authorization: "Bearer " + TOKEN } })).json();
  assert.equal(st.caderno.estudados[0].tema, "como responder pedido de desconto sem perder a venda");
  assert.equal(st.caderno.temas.length, 0);
  // A atendente responde a dúvida no Telegram: vira pedido para aprovar.
  const duvida = a.telegramMsgs.find(m => /DÚVIDA DA DENIA/.test(m.texto));
  a.llmEquipe = (e) => { assert.match(e, /DÚVIDA DA DENIA/); return { caso_id: 0, acoes: [{ tipo: "INSTRUCAO", titulo: "Desconto à vista", conteudo: "Para pagamento à vista no Pix, ofereça 5% de desconto." }], resposta: "", pergunta: "" }; };
  await a.equipe("Pode dar 5% no pix", { responde: duvida.id });
  assert.equal(a.DB.q("SELECT COUNT(*) n FROM d30_sugestoes WHERE tipo='INSTRUCAO_EQUIPE' AND status='PENDENTE'")[0].n, 1);
  // Aprovar o estudo transforma as regras em lições.
  await a.http("/platform/learning/suggestions/" + s.id, { method: "POST", headers: { authorization: "Bearer " + TOKEN }, body: JSON.stringify({ acao: "aprovar", autor: "admin" }) });
  const st2 = await (await a.http("/platform/study", { headers: { authorization: "Bearer " + TOKEN } })).json();
  assert.match(st2.licoes, /Mostre o que está incluso/);
});

test("Diagnóstico do Telegram: mostra privacidade ligada, grupo errado e conecta pelo painel", async () => {
  const TOKEN = "token-da-plataforma-123456";
  const a = await criarAmbiente({ env: { DENIA_PLATFORM_SERVICE_TOKEN: TOKEN } });
  const auth = { authorization: "Bearer " + TOKEN };
  a.llmCliente = () => decisao({ resposta: "Oi!" });
  await a.cliente(CLI, "Oi"); // a Meta chama o webhook: a DENIA aprende o próprio endereço
  await a.cliente(CLI, "tudo bem?");
  a.tgPrivacidade = true;
  let st = await (await a.http("/platform/telegram", { headers: auth })).json();
  assert.equal(st.conectado, false);
  assert.ok(st.problemas.some(p => /não está ligado a nenhum endereço/.test(p)), JSON.stringify(st.problemas));
  assert.ok(st.problemas.some(p => /BotFather → \/setprivacy/.test(p)));
  const r = await (await a.http("/platform/telegram/connect", { method: "POST", headers: auth, body: "{}" })).json();
  assert.equal(r.ok, true);
  assert.equal(a.tgWebhook, "https://denia.test/telegram");
  assert.equal(r.situacao.conectado, true);
  // Mensagem de outro grupo: ignorada, mas o diagnóstico mostra o ID certo.
  await a.equipe("oi denia", { chat: "-100777" });
  st = await (await a.http("/platform/telegram", { headers: auth })).json();
  assert.ok(st.problemas.some(p => /ID -100777[\s\S]*troque TELEGRAM_CHAT_ID para -100777/.test(p)));
});

test("Ela é sempre a última a falar: depois que a pausa da equipe acaba, a DENIA responde o cliente que ficou esperando", async () => {
  const a = await criarAmbiente();
  await a.eco(CLI, "Oi Maria, já vejo pra você");
  let entrada = "";
  a.llmCliente = (e) => { entrada = e; return decisao({ resposta: "Desculpe a demora! A troca de fechadura fica em torno de R$ 150, quer que eu veja um horário?" }); };
  await a.cliente(CLI, "E aí, qual o valor da troca da fechadura?", { nome: "Maria" });
  assert.equal(a.para(CLI).filter(e => e.type === "text").length, 0, "pausada pela equipe: a DENIA não atravessa a atendente");
  a.avancar(3 * 60000); await a.cron();
  assert.equal(a.para(CLI).filter(e => e.type === "text").length, 0, "a equipe ainda pode responder");
  a.avancar(9 * 60000); await a.cron();
  assert.match(entrada, /pedido de desculpas breve/, "pede desculpas pela demora");
  assert.equal(a.para(CLI).filter(e => e.type === "text").length, 1, "a DENIA respondeu");
  assert.equal(a.DB.q("SELECT direcao FROM mensagens ORDER BY id DESC LIMIT 1")[0].direcao, "SAIDA", "a última mensagem é da DENIA");
  assert.ok(!a.telegram.some(t => /ainda não recebeu resposta/.test(t)), "respondeu: não precisa chamar a equipe");
  a.avancar(60000); await a.cron();
  assert.equal(a.para(CLI).filter(e => e.type === "text").length, 1, "não responde duas vezes");
});

test("Ela é sempre a última a falar: 'ok' e 'obrigado' recebem um fechamento curto, sem gastar IA", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "A visita fica R$ 80." });
  await a.cliente(CLI, "Quanto é a visita?");
  const n = a.llm.length;
  await a.cliente(CLI, "Obrigada");
  assert.equal(a.ultimoPara(CLI), "Por nada! Qualquer coisa, é só me chamar.");
  await a.cliente(CLI, "valeu");
  assert.equal(a.ultimoPara(CLI), "Imagina! Estou por aqui se precisar.", "não repete a mesma frase");
  assert.equal(a.llm.length, n, "sem chamada à IA");
});

test("Vigia: cliente respondido não gera aviso", async () => {
  const a = await criarAmbiente();
  a.llmCliente = () => decisao({ resposta: "Oi! Como posso ajudar?" });
  await a.cliente(CLI, "Oi, preciso de um orçamento");
  a.avancar(10 * 60000); await a.cron();
  assert.ok(!a.telegram.some(t => /ainda não recebeu resposta/.test(t)));
});
