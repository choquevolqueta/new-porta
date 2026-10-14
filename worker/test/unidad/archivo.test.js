import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODOS, MODO_POR_DEFECTO, MAX_ARCHIVO_BYTES, modoValido, puedeRecibirArchivo,
} from "../../src/archivo.js";

test("el modo por defecto es fotos, y cualquier otra cosa no es un modo", () => {
  assert.equal(MODO_POR_DEFECTO, MODOS.FOTOS);
  assert.equal(modoValido(MODOS.FOTOS), true);
  assert.equal(modoValido(MODOS.DOCUMENTOS), true);
  assert.equal(modoValido("documentos "), false);
  assert.equal(modoValido(""), false);
  assert.equal(modoValido(undefined), false);
});

test("en modo fotos solo entra un jpeg, con sus primeros bytes", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  assert.deepEqual(puedeRecibirArchivo(MODOS.FOTOS, "image/jpeg", jpeg), { ok: true });
  assert.deepEqual(puedeRecibirArchivo(MODOS.FOTOS, "application/pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    { ok: false, error: "tipo" });
});

test("en modo documentos entran los cuatro tipos, si los bytes acompañan", () => {
  const casos = [
    ["application/pdf", [0x25, 0x50, 0x44, 0x46]],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", [0x50, 0x4b, 0x03, 0x04]],
    ["image/jpeg", [0xff, 0xd8]],
    ["image/png", [0x89, 0x50, 0x4e, 0x47]],
  ];
  for (const [tipo, bytes] of casos) {
    assert.deepEqual(puedeRecibirArchivo(MODOS.DOCUMENTOS, tipo, new Uint8Array(bytes)), { ok: true }, tipo);
  }
});

test("una etiqueta que miente sobre el contenido se rechaza", () => {
  const texto = new Uint8Array([0x68, 0x6f, 0x6c, 0x61]);
  assert.deepEqual(puedeRecibirArchivo(MODOS.DOCUMENTOS, "application/pdf", texto), { ok: false, error: "tipo" });
  assert.deepEqual(puedeRecibirArchivo(MODOS.DOCUMENTOS, "image/png", texto), { ok: false, error: "tipo" });
});

test("un zip con etiqueta de docx pasa: es lo que se puede comprobar", () => {
  // Queda escrito a propósito: un .docx es un ZIP y un ZIP no dice de qué es.
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
  const etiqueta = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  assert.deepEqual(puedeRecibirArchivo(MODOS.DOCUMENTOS, etiqueta, zip), { ok: true });
});

test("el tope es el del archivo, no el de la foto", () => {
  const pdf = new Uint8Array(MAX_ARCHIVO_BYTES); pdf.set([0x25, 0x50, 0x44, 0x46]);
  const pasado = new Uint8Array(MAX_ARCHIVO_BYTES + 1); pasado.set([0x25, 0x50, 0x44, 0x46]);
  assert.deepEqual(puedeRecibirArchivo(MODOS.DOCUMENTOS, "application/pdf", pdf), { ok: true });
  assert.deepEqual(puedeRecibirArchivo(MODOS.DOCUMENTOS, "application/pdf", pasado), { ok: false, error: "grande" });
});

test("un cuerpo vacío se rechaza antes que nada", () => {
  assert.deepEqual(puedeRecibirArchivo(MODOS.DOCUMENTOS, "application/pdf", new Uint8Array(0)),
    { ok: false, error: "vacio" });
});

test("en modo fotos el tope sigue siendo el viejo", () => {
  const jpeg = new Uint8Array(700 * 1024); jpeg.set([0xff, 0xd8]);
  assert.deepEqual(puedeRecibirArchivo(MODOS.FOTOS, "image/jpeg", jpeg), { ok: false, error: "grande" });
});
