import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITE_SESIONES, VENTANA_LIMITE_MS, permitir } from "../../src/limite.js";

test("permite hasta el tope y después corta", () => {
  const mapa = new Map();
  for (let i = 0; i < LIMITE_SESIONES; i++) {
    assert.equal(permitir(mapa, "1.2.3.4", 0), true, `sesión ${i + 1} debería pasar`);
  }
  assert.equal(permitir(mapa, "1.2.3.4", 0), false);
});

test("cada IP tiene su propia cuenta", () => {
  const mapa = new Map();
  for (let i = 0; i < LIMITE_SESIONES; i++) permitir(mapa, "1.2.3.4", 0);
  assert.equal(permitir(mapa, "5.6.7.8", 0), true);
});

test("la ventana se renueva", () => {
  const mapa = new Map();
  for (let i = 0; i < LIMITE_SESIONES; i++) permitir(mapa, "1.2.3.4", 0);
  assert.equal(permitir(mapa, "1.2.3.4", 0), false);
  assert.equal(permitir(mapa, "1.2.3.4", VENTANA_LIMITE_MS), true);
});
