import { test } from "node:test";
import assert from "node:assert/strict";

const API = process.env.TUNEL_API ?? "http://127.0.0.1:8787";
const JPEG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

test("una sesión que nadie usó se muere y deja de aceptar cosas", async () => {
  const codigo = (await (await fetch(`${API}/session`, { method: "POST" })).json()).codigo;
  const antes = await fetch(`${API}/upload/${codigo}`, { method: "POST", body: JPEG });
  assert.equal(antes.status, 409); // existe, pero no hay PC escuchando
  await esperar(3000);
  const despues = await fetch(`${API}/upload/${codigo}`, { method: "POST", body: JPEG });
  assert.equal(despues.status, 404); // ya no existe
});
