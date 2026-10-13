import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALFABETO, LARGO_CODIGO, TTL_SESION_MS, MAX_JPEG_BYTES,
  generarCodigo, normalizarCodigo, crearSesion, estaExpirada, tocarSesion,
  registrarEmisor, liberarEmisor, puedeRecibirFoto,
} from "../../src/sesion.js";

test("el alfabeto tiene 32 símbolos y ningún ambiguo", () => {
  assert.equal(ALFABETO.length, 32);
  for (const c of "0O1I") assert.ok(!ALFABETO.includes(c), `el alfabeto no debería tener ${c}`);
});

test("generarCodigo da 8 caracteres del alfabeto y no se repite", () => {
  const vistos = new Set();
  for (let i = 0; i < 2000; i++) {
    const c = generarCodigo();
    assert.equal(c.length, LARGO_CODIGO);
    for (const ch of c) assert.ok(ALFABETO.includes(ch), `${c} contiene ${ch}`);
    vistos.add(c);
  }
  assert.equal(vistos.size, 2000);
});

test("generarCodigo usa el aleatorio inyectado", () => {
  assert.equal(generarCodigo(() => 0), ALFABETO[0].repeat(8));
  assert.equal(generarCodigo(() => 0.999999), ALFABETO[31].repeat(8));
});

test("normalizarCodigo aguanta lo que tipea una persona", () => {
  assert.equal(normalizarCodigo("9xk2-m7qp"), "9XK2M7QP");
  assert.equal(normalizarCodigo(" 9XK2M7QP "), "9XK2M7QP");
  assert.equal(normalizarCodigo("9XK2M7Q"), "9XK2M7Q");
});

test("la sesión expira a los 10 minutos sin actividad", () => {
  const t0 = 1_000_000;
  const s = crearSesion(t0);
  assert.equal(estaExpirada(s, t0 + TTL_SESION_MS - 1), false);
  assert.equal(estaExpirada(s, t0 + TTL_SESION_MS), true);
  assert.equal(estaExpirada(s, t0 + TTL_SESION_MS * 10), true);
});

test("tocarSesion corre el reloj y revive una sesión por expirar", () => {
  const t0 = 1_000_000;
  const s = crearSesion(t0);
  tocarSesion(s, t0 + TTL_SESION_MS - 1);
  assert.equal(s.ultimaActividad, t0 + TTL_SESION_MS - 1);
  assert.equal(estaExpirada(s, t0 + TTL_SESION_MS + 1000), false);
});

test("un segundo celular no entra mientras hay uno conectado", () => {
  const s = crearSesion(0);
  assert.deepEqual(registrarEmisor(s), { ok: true });
  assert.deepEqual(registrarEmisor(s), { ok: false, error: "ocupado" });
  liberarEmisor(s);
  assert.deepEqual(registrarEmisor(s), { ok: true });
});

test("no se acepta una foto si no hay ninguna PC escuchando", () => {
  const s = crearSesion(0);
  assert.deepEqual(puedeRecibirFoto(s, new Uint8Array([1, 2, 3]), "image/jpeg"),
    { ok: false, error: "sin-pc" });
});

test("no se acepta un cuerpo vacío ni algo que no sea JPEG", () => {
  const s = crearSesion(0); s.pc = true;
  assert.deepEqual(puedeRecibirFoto(s, new Uint8Array(0), "image/jpeg"), { ok: false, error: "vacia" });
  assert.deepEqual(puedeRecibirFoto(s, new Uint8Array([1, 2, 3]), "text/plain"), { ok: false, error: "tipo" });
});

test("no se acepta una foto por encima del tope", () => {
  const s = crearSesion(0); s.pc = true;
  assert.deepEqual(puedeRecibirFoto(s, new Uint8Array(MAX_JPEG_BYTES), "image/jpeg"), { ok: true });
  assert.deepEqual(puedeRecibirFoto(s, new Uint8Array(MAX_JPEG_BYTES + 1), "image/jpeg"),
    { ok: false, error: "grande" });
});
