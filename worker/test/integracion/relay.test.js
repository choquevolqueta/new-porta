import { test } from "node:test";
import assert from "node:assert/strict";

const API = process.env.TUNEL_API ?? "http://127.0.0.1:8787";
const WS = API.replace(/^http/, "ws");

const abrir = (ruta) => new Promise((res, rej) => {
  const ws = new WebSocket(`${WS}${ruta}`);
  // El Durable Object manda el primer mensaje apenas acepta el socket, así que
  // la cola se arma acá: enganchar el listener después de "open" lo pierde.
  ws.cola = [];
  ws.esperando = [];
  ws.addEventListener("message", (e) => {
    const dato = JSON.parse(e.data);
    const siguiente = ws.esperando.shift();
    if (siguiente) siguiente(dato);
    else ws.cola.push(dato);
  });
  ws.addEventListener("open", () => res(ws));
  ws.addEventListener("error", () => rej(new Error(`no abrió ${ruta}`)));
});

const proximo = (ws) => new Promise((res) => {
  const dato = ws.cola.shift();
  if (dato) res(dato);
  else ws.esperando.push(res);
});

const cerrar = (ws) => new Promise((res) => {
  ws.addEventListener("close", (e) => res(e.code), { once: true });
  // Con código explícito: close() sin argumentos manda un frame sin estado y el
  // cliente termina viendo 1005 ("no status received") en lugar de 1000.
  ws.close(1000);
});

async function nuevaSesion() {
  const r = await fetch(`${API}/session`, { method: "POST" });
  assert.equal(r.status, 200);
  return (await r.json()).codigo;
}

const JPEG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0xFF, 0xD9]);

test("health responde", async () => {
  const r = await fetch(`${API}/health`);
  assert.equal(r.status, 200);
});

test("crear sesión devuelve un código de 8", async () => {
  assert.match(await nuevaSesion(), /^[2-9A-HJ-NP-Z]{8}$/);
});

test("la PC recibe la foto que sube el celular", async () => {
  const code = await nuevaSesion();
  const pc = await abrir(`/ws/${code}?rol=pc`);
  assert.deepEqual(await proximo(pc), { type: "estado", emisor: false });

  const cel = await abrir(`/ws/${code}?rol=emisor`);
  assert.deepEqual(await proximo(pc), { type: "estado", emisor: true });

  const subida = await fetch(`${API}/upload/${code}?at=2026-10-13T21:04:11-05:00`, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: JPEG,
  });
  assert.equal(subida.status, 200);

  const foto = await proximo(pc);
  assert.equal(foto.type, "foto");
  assert.equal(foto.at, "2026-10-13T21:04:11-05:00");
  assert.deepEqual(new Uint8Array(Buffer.from(foto.jpeg, "base64")), JPEG);

  assert.equal(await cerrar(cel), 1000);
  assert.deepEqual(await proximo(pc), { type: "estado", emisor: false });
  await cerrar(pc);
});

test("el mismo QR sirve para el celular siguiente", async () => {
  const code = await nuevaSesion();
  const pc = await abrir(`/ws/${code}?rol=pc`);
  await proximo(pc);
  const uno = await abrir(`/ws/${code}?rol=emisor`);
  await proximo(pc);
  await cerrar(uno);
  await proximo(pc);
  const dos = await abrir(`/ws/${code}?rol=emisor`);
  assert.deepEqual(await proximo(pc), { type: "estado", emisor: true });
  await cerrar(dos);
  await cerrar(pc);
});

test("un segundo celular concurrente se cae con 4001", async () => {
  const code = await nuevaSesion();
  const pc = await abrir(`/ws/${code}?rol=pc`);
  await proximo(pc);
  const uno = await abrir(`/ws/${code}?rol=emisor`);
  await proximo(pc);
  const dos = await abrir(`/ws/${code}?rol=emisor`);
  assert.equal(await cerrar(dos), 4001);
  await cerrar(uno);
  await cerrar(pc);
});

test("un código que no existe no abre ni acepta nada", async () => {
  const r = await fetch(`${API}/upload/ZZZZZZZZ`, { method: "POST", body: JPEG });
  assert.equal(r.status, 404);
  await assert.rejects(() => abrir("/ws/ZZZZZZZZ?rol=pc"));
});

test("un código con forma rara tampoco acepta la foto", async () => {
  // Un código que ni siquiera pasa la validación del Worker: el cuerpo se drena
  // igual, para que el runtime no se queje de un stream sin consumir.
  const r = await fetch(`${API}/upload/abc`, { method: "POST", body: JPEG });
  assert.equal(r.status, 404);
});

test("no se acepta una foto sin PC escuchando", async () => {
  const code = await nuevaSesion();
  const r = await fetch(`${API}/upload/${code}`, { method: "POST", body: JPEG });
  assert.equal(r.status, 409);
});

test("no se acepta un cuerpo vacío ni una foto enorme", async () => {
  const code = await nuevaSesion();
  const pc = await abrir(`/ws/${code}?rol=pc`);
  await proximo(pc);
  const vacio = await fetch(`${API}/upload/${code}`, { method: "POST", body: new Uint8Array(0) });
  assert.equal(vacio.status, 413);
  const enorme = await fetch(`${API}/upload/${code}`, { method: "POST", body: new Uint8Array(700 * 1024) });
  assert.equal(enorme.status, 413);
  await cerrar(pc);
});
