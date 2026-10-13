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

// El emisor recibe su token al conectarse y lo tiene que presentar para subir.
async function abrirEmisor(codigo) {
  const ws = await abrir(`/ws/${codigo}?rol=emisor`);
  const bienvenida = await proximo(ws);
  assert.equal(bienvenida.type, "bienvenida", "el emisor recibe su token primero");
  return { ws, token: bienvenida.token };
}

const subir = (codigo, token, at) => fetch(
  `${API}/upload/${codigo}${at ? "?at=" + encodeURIComponent(at) : ""}`,
  {
    method: "POST",
    headers: { "Content-Type": "image/jpeg", ...(token ? { "X-Token": token } : {}) },
    body: JPEG,
  }
);

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

  const { ws: cel, token } = await abrirEmisor(code);
  assert.deepEqual(await proximo(pc), { type: "estado", emisor: true });

  const subida = await subir(code, token, "2026-10-13T21:04:11-05:00");
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
  const uno = await abrirEmisor(code);
  await proximo(pc);
  await cerrar(uno.ws);
  await proximo(pc);
  const dos = await abrirEmisor(code);
  assert.deepEqual(await proximo(pc), { type: "estado", emisor: true });
  assert.equal((await subir(code, dos.token)).status, 200, "el token del segundo sirve");
  assert.equal((await subir(code, uno.token)).status, 409, "el token del primero ya no");
  await cerrar(dos.ws);
  await cerrar(pc);
});

test("un segundo celular concurrente se cae con 4001 y no puede subir nada", async () => {
  const code = await nuevaSesion();
  const pc = await abrir(`/ws/${code}?rol=pc`);
  await proximo(pc);
  const uno = await abrirEmisor(code);
  await proximo(pc);

  const dos = await abrir(`/ws/${code}?rol=emisor`);
  assert.equal(await cerrar(dos), 4001, "al rechazado se le cierra el socket");

  assert.equal((await subir(code, null)).status, 409, "sin token no entra");
  assert.equal((await subir(code, "TOKEN-INVENTADO")).status, 409, "un token inventado tampoco");
  assert.equal((await subir(code, uno.token)).status, 200, "el dueño del cupo sí puede");

  await cerrar(uno.ws);
  await cerrar(pc);
});

test("un código que no existe no abre ni acepta nada", async () => {
  assert.equal((await subir("ZZZZZZZZ", null)).status, 404);
  await assert.rejects(() => abrir("/ws/ZZZZZZZZ?rol=pc"));
});

test("un código con forma rara tampoco acepta la foto", async () => {
  // Un código que ni siquiera pasa la validación del Worker: el cuerpo se drena
  // igual, para que el runtime no se queje de un stream sin consumir.
  assert.equal((await subir("abc", null)).status, 404);
});

test("no se acepta una foto sin PC escuchando", async () => {
  const code = await nuevaSesion();
  assert.equal((await subir(code, null)).status, 409);
});

test("no se acepta un cuerpo vacío ni una foto enorme", async () => {
  const code = await nuevaSesion();
  const pc = await abrir(`/ws/${code}?rol=pc`);
  await proximo(pc);
  const { token } = await abrirEmisor(code);
  await proximo(pc);

  const vacio = await fetch(`${API}/upload/${code}`, {
    method: "POST", headers: { "Content-Type": "image/jpeg", "X-Token": token }, body: new Uint8Array(0),
  });
  assert.equal(vacio.status, 413);

  const grande = new Uint8Array(700 * 1024);
  grande.set([0xFF, 0xD8]);
  const enorme = await fetch(`${API}/upload/${code}`, {
    method: "POST", headers: { "Content-Type": "image/jpeg", "X-Token": token }, body: grande,
  });
  assert.equal(enorme.status, 413, "es un JPEG de 700 KB: pasa el tipo y choca con el tope");
  await cerrar(pc);
});

test("el preflight permite el encabezado del token", async () => {
  // El navegador hace un OPTIONS antes de subir, porque la subida lleva el
  // encabezado X-Token. Si no está en Access-Control-Allow-Headers, bloquea el
  // pedido y el celular muestra "no se pudo subir la foto". Los tests de Node
  // no hacen preflight: por eso este test existe.
  const r = await fetch(`${API}/upload/ABCDEFGH`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://choquevolqueta.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,x-token",
    },
  });
  assert.equal(r.status, 204);
  const permitidos = (r.headers.get("access-control-allow-headers") ?? "").toLowerCase();
  assert.match(permitidos, /x-token/, `el preflight permite: "${permitidos}"`);
  assert.match(permitidos, /content-type/);
  assert.equal(r.headers.get("access-control-allow-origin"), "https://choquevolqueta.com");
});

test("un cuerpo enorme se rechaza antes de tragárselo", async () => {
  // 20 MB con el tamaño declarado en la cabecera: el Worker tiene que mirar el
  // Content-Length y cortar, no bufferizar 20 MB para después decir que no.
  const enorme = new Uint8Array(20 * 1024 * 1024);
  const r = await fetch(`${API}/upload/ZZZZZZZZ`, { method: "POST", body: enorme });
  assert.equal(r.status, 413, "por tamaño, no por sesión inexistente");
});
