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

test("la sesión se acuerda de su TTL, para poder bajarlo en las pruebas", () => {
  const s = crearSesion(0, "ABCDEFGH", 2500);
  assert.equal(s.ttl, 2500);
  assert.equal(estaExpirada(s, 2499, s.ttl), false);
  assert.equal(estaExpirada(s, 2500, s.ttl), true);
  assert.equal(crearSesion(0).ttl, TTL_SESION_MS, "sin TTL explícito, el de siempre");
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

test("no se acepta algo que dice ser JPEG pero no empieza como JPEG", () => {
  const s = crearSesion(0); s.pc = true;
  assert.deepEqual(puedeRecibirFoto(s, new Uint8Array([0x41, 0x42, 0x43]), "image/jpeg"),
    { ok: false, error: "tipo" }, "texto declarado como image/jpeg");
  assert.deepEqual(puedeRecibirFoto(s, new Uint8Array([0xFF, 0xD8]), "image/jpeg"), { ok: true });
});

test("no se acepta una foto por encima del tope", () => {
  const s = crearSesion(0); s.pc = true;
  // Entradas con encabezado de JPEG de verdad: si no, las rechazaría el chequeo
  // del magic number y el test no estaría midiendo el tope.
  const alTope = new Uint8Array(MAX_JPEG_BYTES); alTope.set([0xFF, 0xD8]);
  const pasado = new Uint8Array(MAX_JPEG_BYTES + 1); pasado.set([0xFF, 0xD8]);
  assert.deepEqual(puedeRecibirFoto(s, alTope, "image/jpeg"), { ok: true });
  assert.deepEqual(puedeRecibirFoto(s, pasado, "image/jpeg"), { ok: false, error: "grande" });
});
