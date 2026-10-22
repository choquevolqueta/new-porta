import { test } from "node:test";
import assert from "node:assert/strict";

// El vencimiento real no se puede probar con el TTL de producción: hay que
// levantar el Worker con uno corto.
//
//   cd worker && npx wrangler dev --port 8787 --var TTL_SESION_MS:2500
//   node --test worker/test/integracion/expiracion.test.js
//
// Si el server no está configurado así, el test se saltea con el motivo a la
// vista en lugar de fallar como si el código estuviera mal.
const API = process.env.TUNEL_API ?? "http://127.0.0.1:8787";
const JPEG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

test("una sesión que nadie usó se muere y deja de aceptar cosas", async (t) => {
  const salud = await (await fetch(`${API}/health`)).json();
  if (!(salud.ttl <= 60000)) {
    t.skip(`el server tiene TTL de ${salud.ttl} ms: levantalo con --var TTL_SESION_MS:2500`);
    return;
  }

  const codigo = (await (await fetch(`${API}/session`, { method: "POST" })).json()).codigo;
  const antes = await fetch(`${API}/upload/${codigo}`, { method: "POST", body: JPEG });
  assert.equal(antes.status, 409); // existe, pero no hay PC escuchando
  await esperar(3000);
  const despues = await fetch(`${API}/upload/${codigo}`, { method: "POST", body: JPEG });
  assert.equal(despues.status, 404); // ya no existe
});

test("el progreso del camino directo mantiene viva la sesión", async (t) => {
  const salud = await (await fetch(`${API}/health`)).json();
  if (!(salud.ttl <= 60000)) {
    t.skip(`el server tiene TTL de ${salud.ttl} ms: levantalo con --var TTL_SESION_MS:2500`);
    return;
  }

  const codigo = (await (await fetch(`${API}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modo: "documentos" }),
  })).json()).codigo;

  const ws = new WebSocket(`${API.replace(/^http/, "ws")}/ws/${codigo}?rol=emisor`);
  const cierres = [];
  ws.addEventListener("close", (evento) => cierres.push(evento.code));
  await new Promise((res) => ws.addEventListener("open", res, { once: true }));

  // Seis segundos con progreso cada 400 ms: más del doble del TTL. Es lo que
  // manda el celular durante un envío directo, sin pasar por el Worker.
  for (let i = 0; i < 15; i++) {
    ws.send(JSON.stringify({ type: "progreso", id: "x", recibidos: i, total: 15 }));
    await esperar(400);
  }

  assert.deepEqual(cierres, [], "la sesión no se cerró mientras había progreso");
  assert.equal(ws.readyState, WebSocket.OPEN);
  ws.close();
  await esperar(200);
});
