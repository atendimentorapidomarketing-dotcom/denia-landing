import { test } from "node:test";
import assert from "node:assert/strict";
import { avaliarPerfil } from "../src/google.js";

const agoraMs = Date.parse("2026-10-26T15:00:00Z");
const item = (r, chave) => r.itens.find(i => i.chave === chave);

test("Checagem do Google: post de 8 horas atrás conta como post recente", () => {
  const r = avaliarPerfil({ agoraMs, posts: [{ createTime: "2026-10-26T07:00:00Z" }] });
  assert.equal(item(r, "posts").ok, "ok");
});

test("Checagem do Google: se o Google não deixou ler os posts, não aponta falta (fica fora da nota)", () => {
  const r = avaliarPerfil({ agoraMs, posts: [], postsErro: "HTTP 503" });
  const p = item(r, "posts");
  assert.equal(p.ok, "conferir"); assert.equal(p.max, 0);
  assert.ok(!r.itens.filter(i => i.ok === "falta").some(i => i.chave === "posts"));
});

test("Checagem do Google: posts publicados pela DENIA contam, mesmo que a lista do Google venha vazia", () => {
  const r = avaliarPerfil({ agoraMs, posts: [], postsDenia: { ultimos7: 1, ultimos30: 4, agendados: 9 } });
  assert.equal(item(r, "posts").ok, "ok");
  assert.match(item(r, "posts").detalhe, /9 programado/);
});

test("Checagem do Google: feriados só faltam quando um feriado nacional está chegando sem horário marcado", () => {
  // 26/10: Finados (02/11) está a 7 dias.
  const sem = avaliarPerfil({ agoraMs, info: {} });
  assert.equal(item(sem, "feriados").ok, "falta");
  assert.match(item(sem, "feriados").detalhe, /Finados \(02\/11\)/);
  const com = avaliarPerfil({ agoraMs, info: { specialHours: { specialHourPeriods: [{ startDate: { year: 2026, month: 11, day: 2 }, closed: true }] } } });
  assert.equal(item(com, "feriados").ok, "ok");
  assert.match(item(com, "feriados").detalhe, /02\/11/);
  // Em março, sem feriado perto: não cobra.
  const marco = avaliarPerfil({ agoraMs: Date.parse("2027-03-10T15:00:00Z"), info: {} });
  assert.equal(item(marco, "feriados").ok, "ok");
});
