import { test } from "node:test";
import assert from "node:assert/strict";
import { montarRelatorio, contarConversas } from "../src/relatorio.js";

const ms = s => Date.parse(s); // horários em UTC; Brasília = UTC−3
const ini = ms("2026-10-12T03:00:00Z"), fim = ms("2026-10-19T03:00:00Z"); // segunda 12/10 a domingo 18/10 (Brasília)

test("Relatório: cliente = pessoa diferente; conversa = janela de 24 h; muitas mensagens não viram muitos clientes", () => {
  const entradas = [
    // Ana: 6 mensagens na segunda de manhã (1 conversa) e volta na quinta (2ª conversa)
    ...[0, 1, 2, 3, 4, 5].map(i => ({ telefone: "5521911110001", ms: ms("2026-10-12T13:00:00Z") + i * 60000 })),
    { telefone: "5521911110001", ms: ms("2026-10-15T15:00:00Z") },
    // Beto: já era cliente; escreve terça 23:50 e continua quarta 00:20 (Brasília) — mesma conversa, dois dias
    { telefone: "5521911110002", ms: ms("2026-10-14T02:50:00Z") },
    { telefone: "5521911110002", ms: ms("2026-10-14T03:20:00Z") },
    // Caio: novo, uma mensagem no domingo
    { telefone: "5521911110003", ms: ms("2026-10-18T20:00:00Z") },
    // Fora do período: não conta
    { telefone: "5521911110004", ms: ms("2026-10-19T04:00:00Z") }
  ];
  const r = montarRelatorio({ entradas, buscas: [], nomes: {}, antigos: ["5521911110002"] }, ini, fim);
  assert.equal(r.totais.clientes, 3, "3 pessoas diferentes");
  assert.equal(r.totais.conversas, 4, "Ana 2 + Beto 1 + Caio 1");
  assert.equal(r.totais.novos, 2); assert.equal(r.totais.recorrentes, 1);
  assert.equal(r.totais.voltaram, 1, "só a Ana voltou em outra conversa");
  const dia = Object.fromEntries(r.por_dia.map(d => [d.dia, d]));
  assert.deepEqual([dia["2026-10-12"].clientes, dia["2026-10-12"].conversas, dia["2026-10-12"].novos], [1, 1, 1], "6 mensagens da Ana = 1 cliente, 1 conversa");
  assert.deepEqual([dia["2026-10-13"].clientes, dia["2026-10-13"].conversas], [1, 1], "terça: Beto começou a conversa");
  assert.deepEqual([dia["2026-10-14"].clientes, dia["2026-10-14"].conversas, dia["2026-10-14"].recorrentes], [1, 0, 1], "quarta: Beto falou (conta como cliente do dia), sem conversa nova");
  assert.deepEqual([dia["2026-10-15"].clientes, dia["2026-10-15"].novos, dia["2026-10-15"].recorrentes], [1, 0, 1], "quinta: Ana já não é nova");
  assert.equal(dia["2026-10-18"].novos, 1);
  assert.equal(r.por_dia.reduce((t, d) => t + d.novos, 0), r.totais.novos, "a soma dos novos por dia bate com o total");
  assert.equal(r.por_dia.reduce((t, d) => t + d.conversas, 0), r.totais.conversas, "a soma das conversas por dia bate com o total");
  const ana = r.conversas.filter(c => c.telefone === "5521911110001");
  assert.deepEqual(ana.map(c => [c.mensagens, c.recorrente]), [[6, false], [1, true]]);
});

test("Conversa: 24 h a partir da primeira mensagem, depois disso é outra", () => {
  const c = contarConversas([{ telefone: "1", ms: 0 }, { telefone: "1", ms: 23 * 3600000 }, { telefone: "1", ms: 24 * 3600000 }, { telefone: "2", ms: 5 }]);
  assert.equal(c.length, 3);
});
