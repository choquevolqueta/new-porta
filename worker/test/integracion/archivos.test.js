import { test } from "node:test";
import assert from "node:assert/strict";

// Lo que se prueba acá es el camino de documentos: el modo de la sesión, el
// respaldo de un solo uso y el reenvío entre pares. El 1.0 tiene su propio
// archivo (relay.test.js) y no se toca.

const API = process.env.TUNEL_API ?? "http://127.0.0.1:8787";
const WS = API.replace(/^http/, "ws");

const abrir = (ruta) => new Promise((res, rej) => {
  const ws = new WebSocket(`${WS}${ruta}`);
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
  ws.close(1000);
});

// Espera para comprobar que algo NO llega.
const noLlega = async (ws, ms = 700) => {
  await new Promise((r) => setTimeout(r, ms));
  return ws.cola.length === 0 && ws.esperando.length === 0;
};

async function nuevaSesion(modo) {
  const r = await fetch(`${API}/session`, {
    method: "POST",
    ...(modo ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modo }) } : {}),
  });
  assert.equal(r.status, 200);
  return (await r.json()).codigo;
}

async function abrirEmisor(codigo) {
  const ws = await abrir(`/ws/${codigo}?rol=emisor`);
  const bienvenida = await proximo(ws);
  assert.equal(bienvenida.type, "bienvenida");
  return { ws, token: bienvenida.token };
}

// Deja la sesión lista: la PC conectada (con su token, si el modo lo manda) y el
// emisor adentro. En fotos la PC recibe dos estados y ningún token; en documentos,
// el token primero y después los estados.
async function sesionLista(modo = "documentos") {
  const codigo = await nuevaSesion(modo);
  const pc = await abrir(`/ws/${codigo}?rol=pc`);

  let tokenPc = null;
  const primero = await proximo(pc);
  if (primero.type === "bienvenida") {
    tokenPc = primero.token;
    await proximo(pc); // el primer estado
  }

  const { ws: cel, token } = await abrirEmisor(codigo);
  await proximo(pc); // el estado con el emisor adentro

  return { codigo, pc, pcToken: tokenPc, cel, tokenEmisor: token };
}

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);

const conTamano = (bytes) => {
  const copia = new Uint8Array(bytes);
  copia.set(PDF);
  return copia;
};

const subir = (codigo, token, bytes, nombre = "reclamo.pdf", tipo = "application/pdf") =>
  fetch(`${API}/subir/${codigo}`, {
    method: "POST",
    headers: {
      "Content-Type": tipo,
      "X-Nombre": encodeURIComponent(nombre),
      ...(token ? { "X-Token": token } : {}),
    },
    body: bytes,
  });

const bajar = (codigo, id, token) =>
  fetch(`${API}/bajar/${codigo}/${id}`, { headers: token ? { "X-Token": token } : {} });

test("una sesión de documentos nace con su modo", async () => {
  assert.match(await nuevaSesion("documentos"), /^[2-9A-HJ-NP-Z]{8}$/);
});

test("en documentos la PC recibe su token antes del primer estado", async () => {
  const codigo = await nuevaSesion("documentos");
  const pc = await abrir(`/ws/${codigo}?rol=pc`);
  const bienvenida = await proximo(pc);
  assert.equal(bienvenida.type, "bienvenida");
  assert.ok(typeof bienvenida.token === "string" && bienvenida.token.length >= 16, "trae token");
  assert.deepEqual(await proximo(pc), { type: "estado", emisor: false });
  await cerrar(pc);
});

test("en fotos la PC no recibe token: lo primero sigue siendo el estado", async () => {
  const codigo = await nuevaSesion();
  const pc = await abrir(`/ws/${codigo}?rol=pc`);
  assert.deepEqual(await proximo(pc), { type: "estado", emisor: false });
  await cerrar(pc);
});

test("el respaldo exige el token del emisor, y avisa a la PC", async () => {
  const sesion = await sesionLista();
  const { codigo, pc, tokenEmisor } = sesion;

  assert.equal((await subir(codigo, null, PDF)).status, 409, "sin token no entra");
  assert.equal((await subir(codigo, "inventado", PDF)).status, 409, "con un token inventado tampoco");

  const respuesta = await subir(codigo, tokenEmisor, PDF, "reclamo.pdf");
  assert.equal(respuesta.status, 200);
  const cuerpo = await respuesta.json();
  assert.equal(cuerpo.ok, true);
  assert.ok(cuerpo.id, "devuelve el id");

  const item = await proximo(pc);
  assert.equal(item.type, "item");
  assert.equal(item.nombre, "reclamo.pdf");
  assert.equal(item.tipo, "application/pdf");
  assert.equal(item.bytes, PDF.length);
  assert.deepEqual(await proximo(pc), { type: "item-listo", id: item.id });

  await cerrar(sesion.cel);
  await cerrar(pc);
});

test("la PC baja el archivo y lo puede volver a pedir", async () => {
  const { codigo, pc, pcToken, tokenEmisor, cel } = await sesionLista();
  await subir(codigo, tokenEmisor, PDF, "reclamo.pdf");
  const item = await proximo(pc);
  await proximo(pc);

  const primera = await bajar(codigo, item.id, pcToken);
  assert.equal(primera.status, 200);
  assert.deepEqual(new Uint8Array(await primera.arrayBuffer()), PDF);
  assert.match(primera.headers.get("content-type") ?? "", /application\/pdf/);

  // Un corte de red no puede perder el documento: se queda hasta que vence.
  const segunda = await bajar(codigo, item.id, pcToken);
  assert.equal(segunda.status, 200, "todavía se puede pedir de nuevo");

  await cerrar(cel);
  await cerrar(pc);
});

test("bajar también exige token, y el del emisor no sirve", async () => {
  const { codigo, pc, pcToken, tokenEmisor, cel } = await sesionLista();
  await subir(codigo, tokenEmisor, PDF);
  const item = await proximo(pc);
  await proximo(pc);

  assert.equal((await bajar(codigo, item.id, null)).status, 409);
  assert.equal((await bajar(codigo, item.id, tokenEmisor)).status, 409);
  assert.equal((await bajar(codigo, item.id, pcToken)).status, 200);

  await cerrar(cel);
  await cerrar(pc);
});

test("un archivo más grande que el tope se rechaza y no llega nada", async () => {
  const { codigo, pc, tokenEmisor, cel } = await sesionLista();
  const grande = conTamano(6 * 1024 * 1024 + 1);

  assert.equal((await subir(codigo, tokenEmisor, grande)).status, 413);
  assert.ok(await noLlega(pc), "la PC no se enteró de nada");

  await cerrar(cel);
  await cerrar(pc);
});

test("una etiqueta que miente sobre el contenido se rechaza", async () => {
  const { codigo, pc, tokenEmisor, cel } = await sesionLista();
  const texto = new Uint8Array([0x68, 0x6f, 0x6c, 0x61]);

  // El tipo que no se puede comprobar da 415: no es que sea grande, es que no es
  // lo que dice ser.
  assert.equal((await subir(codigo, tokenEmisor, texto, "carta.pdf", "application/pdf")).status, 415);
  assert.ok(await noLlega(pc));

  await cerrar(cel);
  await cerrar(pc);
});

test("cada modo rechaza las rutas del otro", async () => {
  const fotos = await nuevaSesion();
  assert.equal((await subir(fotos, null, PDF)).status, 404, "fotos no tiene respaldo");
  assert.equal((await bajar(fotos, "cualquiera", null)).status, 404, "ni descarga");

  const docs = await sesionLista();
  const subida = await fetch(`${API}/upload/${docs.codigo}?at=${new Date().toISOString()}`, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg", "X-Token": docs.tokenEmisor },
    body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  });
  assert.equal(subida.status, 404, "documentos no acepta fotos");

  await cerrar(docs.cel);
  await cerrar(docs.pc);
});

test("el reenvío entre pares solo existe en documentos", async () => {
  const docs = await sesionLista();
  docs.cel.send(JSON.stringify({ type: "item", id: "abc", nombre: "n.pdf", tipo: "application/pdf", bytes: 3 }));
  const reenviado = await proximo(docs.pc);
  assert.equal(reenviado.type, "item");
  assert.equal(reenviado.id, "abc");

  // Y al revés: lo que manda la PC tiene que llegarle al emisor, o el apretón de
  // manos de WebRTC se queda en la mitad (la respuesta no vuelve).
  await proximo(docs.cel); // el estado del emisor, que ya estaba en la cola
  docs.pc.send(JSON.stringify({ type: "respuesta", sdp: "falsa" }));
  const vuelta = await proximo(docs.cel);
  assert.equal(vuelta.type, "respuesta");

  await cerrar(docs.cel);
  await cerrar(docs.pc);

  const fotos = await sesionLista("fotos");
  fotos.cel.send(JSON.stringify({ type: "item", id: "abc", nombre: "n.pdf", tipo: "application/pdf", bytes: 3 }));
  assert.ok(await noLlega(fotos.pc), "en fotos el objeto no reenvía nada");
  await cerrar(fotos.cel);
  await cerrar(fotos.pc);
});

test("el preflight permite los encabezados que usa la subida", async () => {
  // Los tests de Node no hacen preflight: solo el navegador. Por eso este test
  // existe — ya nos costó un día con X-Token, y X-Nombre es lo mismo.
  const r = await fetch(`${API}/subir/ABCDEFGH`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://choquevolqueta.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,x-token,x-nombre,x-id",
    },
  });
  assert.equal(r.status, 204);
  const permitidos = (r.headers.get("access-control-allow-headers") ?? "").toLowerCase();
  assert.match(permitidos, /x-token/, `el preflight permite: "${permitidos}"`);
  assert.match(permitidos, /x-nombre/, `el preflight permite: "${permitidos}"`);
  assert.match(permitidos, /x-id/, `el preflight permite: "${permitidos}"`);
});

test("el respaldo no acepta nada si no hay PC escuchando", async () => {
  // Sin PC no hay a quién entregarlo: guardarlo sería prometer una entrega que
  // se descarta sola dos minutos después, con el cliente creyendo que llegó.
  const codigo = await nuevaSesion("documentos");
  const { ws: cel, token } = await abrirEmisor(codigo);

  const r = await subir(codigo, token, PDF);
  assert.equal(r.status, 409, "sin PC no se guarda nada");

  await cerrar(cel);
});

test("el respaldo tiene tope de cantidad, no solo de tamaño", async () => {
  const { codigo, pc, tokenEmisor, cel } = await sesionLista();
  let ultimo = 0;
  for (let i = 0; i < 21; i++) {
    ultimo = (await subir(codigo, tokenEmisor, PDF, "reclamo-" + i + ".pdf")).status;
  }
  assert.equal(ultimo, 413, "el archivo 21 ya no entra");

  await cerrar(cel);
  await cerrar(pc);
});

test("el archivo del respaldo sigue disponible para reintentar", async () => {
  // Se queda hasta que vence: una bajada cortada no puede perder el documento.
  const { codigo, pc, pcToken, tokenEmisor, cel } = await sesionLista();
  await subir(codigo, tokenEmisor, PDF);
  const item = await proximo(pc);
  await proximo(pc);

  assert.equal((await bajar(codigo, item.id, pcToken)).status, 200);
  assert.equal((await bajar(codigo, item.id, pcToken)).status, 200, "todavía se puede pedir de nuevo");

  await cerrar(cel);
  await cerrar(pc);
});

test("el respaldo que nadie baja se descarta", async (t) => {
  const salud = await (await fetch(`${API}/health`)).json();
  if (!(salud.ttl_respaldo <= 60000)) {
    t.skip(`el server tiene el respaldo en ${salud.ttl_respaldo} ms: levantalo con --var TTL_RESPALDO_MS:2500`);
    return;
  }

  const { codigo, pc, pcToken, tokenEmisor, cel } = await sesionLista();
  await subir(codigo, tokenEmisor, PDF);
  const item = await proximo(pc);
  await new Promise((r) => setTimeout(r, 3000));

  assert.equal((await bajar(codigo, item.id, pcToken)).status, 404, "se descartó solo");

  await cerrar(cel);
  await cerrar(pc);
});
