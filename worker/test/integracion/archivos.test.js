import { test } from "node:test";
import assert from "node:assert/strict";

// Lo que se prueba acá es el camino de documentos: el modo de la sesión, el
// respaldo en streaming por piezas y el reenvío entre pares. El 1.0 tiene su
// propio archivo (relay.test.js) y no se toca.

const API = process.env.TUNEL_API ?? "http://127.0.0.1:8787";
const WS = API.replace(/^http/, "ws");
const PIEZA = 1024 * 1024;
const TOPE = 50 * 1024 * 1024;

// Un socket que entiende los dos formatos: los avisos van en JSON y las piezas
// en frames binarios. Con `autoConfirmar` se porta como la PC: guarda cada pieza
// y confirma, que es lo que el objeto espera para seguir mandando.
const abrir = (ruta, { autoConfirmar = false } = {}) => new Promise((res, rej) => {
  const ws = new WebSocket(`${WS}${ruta}`);
  ws.binaryType = "arraybuffer";
  ws.cola = [];
  ws.esperando = [];
  ws.piezas = new Map();
  let enCurso = null;

  ws.addEventListener("message", (e) => {
    if (typeof e.data !== "string") {
      const bytes = new Uint8Array(e.data);
      if (enCurso) {
        ws.piezas.set(enCurso.indice, bytes);
        if (autoConfirmar) {
          ws.send(JSON.stringify({ type: "confirmo", id: enCurso.id, indice: enCurso.indice }));
        }
        enCurso = null;
      }
      return;
    }

    const dato = JSON.parse(e.data);
    if (autoConfirmar && dato.type === "pieza") {
      enCurso = dato;
      return;
    }
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
  return ws.cola.length === 0 && ws.esperando.length === 0 && ws.piezas.size === 0;
};

// Arma el archivo con las piezas que llegaron, en orden de índice.
const armar = (ws) => {
  const indices = [...ws.piezas.keys()].sort((a, b) => a - b);
  const total = indices.reduce((suma, i) => suma + ws.piezas.get(i).length, 0);
  const salida = new Uint8Array(total);
  let desde = 0;
  for (const i of indices) {
    salida.set(ws.piezas.get(i), desde);
    desde += ws.piezas.get(i).length;
  }
  return salida;
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
  const pc = await abrir(`/ws/${codigo}?rol=pc`, { autoConfirmar: modo === "documentos" });

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

const subir = (
  codigo,
  token,
  bytes,
  nombre = "reclamo.pdf",
  tipo = "application/pdf",
  { id = "item-" + Math.random().toString(16).slice(2, 10), desde = 0, total = bytes.length, cuerpo } = {},
) =>
  fetch(`${API}/subir/${codigo}`, {
    method: "POST",
    headers: {
      "Content-Type": tipo,
      "X-Nombre": encodeURIComponent(nombre),
      "X-Id": id,
      "X-Bytes": String(total),
      "X-Desde": String(desde),
      ...(token ? { "X-Token": token } : {}),
    },
    body: cuerpo ?? bytes,
    ...(cuerpo ? { duplex: "half" } : {}),
  });

// Un cuerpo sin Content-Length (chunked): es el caso en que el Worker de entrada
// no puede medir de antemano y la cuenta la hace el objeto.
const enArroyo = (bytes) => new ReadableStream({
  start(control) {
    control.enqueue(bytes);
    control.close();
  },
});

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

test("el respaldo exige el token del emisor y no guarda nada", async () => {
  const sesion = await sesionLista();
  const { codigo, pc, tokenEmisor } = sesion;

  assert.equal((await subir(codigo, null, PDF)).status, 409, "sin token no entra");
  assert.equal((await subir(codigo, "inventado", PDF)).status, 409, "con un token inventado tampoco");
  assert.equal(pc.piezas.size, 0, "no llegó ninguna pieza");

  const id = "con-token";
  const respuesta = await subir(codigo, tokenEmisor, PDF, "reclamo.pdf", "application/pdf", { id });
  assert.equal(respuesta.status, 200);
  assert.equal((await respuesta.json()).ok, true);

  // El fin cierra la transferencia: hasta que llega, los frames pueden estar en
  // camino (es lo que espera la PC antes de armar el archivo).
  assert.deepEqual(await proximo(pc), { type: "fin", id });
  assert.deepEqual(armar(pc), PDF, "los bytes llegan idénticos");

  await cerrar(sesion.cel);
  await cerrar(pc);
});

test("el respaldo llega por piezas, en orden, y avisa el final", async () => {
  const { codigo, pc, tokenEmisor, cel } = await sesionLista();
  const bytes = conTamano(3 * 1024 * 1024 + 77);
  const id = "abc123";

  cel.send(JSON.stringify({
    type: "item", id, nombre: "reclamo.pdf", tipo: "application/pdf",
    bytes: bytes.length, pieza: PIEZA, total: 4,
  }));
  const item = await proximo(pc);
  assert.equal(item.type, "item");
  assert.equal(item.id, id);
  assert.equal(item.bytes, bytes.length);

  assert.equal((await subir(codigo, tokenEmisor, bytes, "reclamo.pdf", "application/pdf", { id })).status, 200);

  assert.deepEqual(await proximo(pc), { type: "fin", id }, "el fin va después de la última pieza");
  assert.deepEqual([...pc.piezas.keys()].sort((a, b) => a - b), [0, 1, 2, 3]);
  assert.deepEqual(armar(pc), bytes);

  await cerrar(cel);
  await cerrar(pc);
});

test("el respaldo acepta el tope: 50 MiB en piezas de 1 MiB", async () => {
  const { codigo, pc, tokenEmisor, cel } = await sesionLista();
  const bytes = conTamano(TOPE);
  const id = "grande";

  cel.send(JSON.stringify({
    type: "item", id, nombre: "video.mp4", tipo: "application/pdf", bytes: bytes.length,
  }));
  await proximo(pc);

  const respuesta = await subir(codigo, tokenEmisor, bytes, "video.pdf", "application/pdf", { id });
  assert.equal(respuesta.status, 200, "50 MiB entra justo");
  await proximo(pc); // fin

  assert.equal(pc.piezas.size, 50, "50 piezas de 1 MiB");
  const armado = armar(pc);
  assert.equal(armado.length, bytes.length);
  assert.deepEqual(armado.subarray(0, 16), bytes.subarray(0, 16));
  assert.deepEqual(armado.subarray(-16), bytes.subarray(-16), "el final también llega");

  await cerrar(cel);
  await cerrar(pc);
});

test("un total anunciado mayor al tope se rechaza sin leer el cuerpo", async () => {
  const { codigo, pc, tokenEmisor, cel } = await sesionLista();

  const respuesta = await subir(codigo, tokenEmisor, PDF, "x.pdf", "application/pdf", { total: TOPE + 1 });
  assert.equal(respuesta.status, 413);
  assert.ok(await noLlega(pc), "la PC no se enteró de nada");

  await cerrar(cel);
  await cerrar(pc);
});

test("un cuerpo declarado más largo que el total se rechaza sin avisar", async () => {
  // Con Content-Length, el Worker de entrada lo corta antes de llegar al objeto:
  // la PC no se entera de nada.
  const { codigo, pc, tokenEmisor, cel } = await sesionLista();

  const respuesta = await subir(codigo, tokenEmisor, conTamano(40), "x.pdf", "application/pdf", { total: 30 });
  assert.equal(respuesta.status, 413);
  assert.ok(await noLlega(pc), "la PC no se enteró de nada");

  await cerrar(cel);
  await cerrar(pc);
});

test("un cuerpo en streaming que miente se corta a mitad y avisa", async () => {
  // Sin Content-Length, la cuenta la hace el objeto: corta el stream y le dice a
  // la PC que ese archivo no terminó.
  const { codigo, pc, tokenEmisor, cel } = await sesionLista();
  const id = "mentiroso";

  const respuesta = await subir(codigo, tokenEmisor, conTamano(40), "x.pdf", "application/pdf",
    { id, total: 30, cuerpo: enArroyo(conTamano(40)) });
  assert.equal(respuesta.status, 413, "el número manda, no el cuerpo");

  const aviso = await proximo(pc);
  assert.equal(aviso.type, "item-error");
  assert.equal(aviso.id, id);

  await cerrar(cel);
  await cerrar(pc);
});

test("un tramo que se va del total se rechaza", async () => {
  const { codigo, tokenEmisor, cel, pc } = await sesionLista();

  const respuesta = await subir(codigo, tokenEmisor, conTamano(40), "x.pdf", "application/pdf",
    { total: 30, desde: 10 });
  assert.equal(respuesta.status, 413);

  await cerrar(cel);
  await cerrar(pc);
});

test("una etiqueta que miente sobre el contenido se rechaza", async () => {
  const { codigo, pc, tokenEmisor, cel } = await sesionLista();
  const texto = new Uint8Array([0x68, 0x6f, 0x6c, 0x61, 0x2c, 0x20, 0x6d, 0x75]);

  assert.equal((await subir(codigo, tokenEmisor, texto, "carta.pdf", "application/pdf")).status, 415);
  assert.ok(await noLlega(pc));

  await cerrar(cel);
  await cerrar(pc);
});

test("el respaldo no acepta nada si no hay PC escuchando", async () => {
  const codigo = await nuevaSesion("documentos");
  const { ws: cel, token } = await abrirEmisor(codigo);

  const r = await subir(codigo, token, PDF);
  assert.equal(r.status, 409, "sin PC no hay a quién entregarlo");

  await cerrar(cel);
});

test("ya no hay ruta de descarga: el respaldo no deja nada guardado", async () => {
  const r = await fetch(`${API}/bajar/ABCDEFGH/cualquiera`);
  assert.equal(r.status, 404);
});

test("cada modo rechaza las rutas del otro", async () => {
  const fotos = await nuevaSesion();
  assert.equal((await subir(fotos, null, PDF)).status, 404, "fotos no tiene respaldo");

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
  // existe — ya nos costó dos veces, con X-Token y con X-Nombre.
  const r = await fetch(`${API}/subir/ABCDEFGH`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://choquevolqueta.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,x-token,x-nombre,x-id,x-bytes,x-desde",
    },
  });
  assert.equal(r.status, 204);
  const permitidos = (r.headers.get("access-control-allow-headers") ?? "").toLowerCase();
  for (const encabezado of ["x-token", "x-nombre", "x-id", "x-bytes", "x-desde"]) {
    assert.match(permitidos, new RegExp(encabezado), `el preflight permite: "${permitidos}"`);
  }
});
