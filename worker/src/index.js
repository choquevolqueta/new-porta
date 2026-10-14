// Punto de entrada del Worker: solo API, no sirve la página.
//   POST /session                          → { codigo }
//   GET  /ws/:codigo?rol=pc|emisor          → WebSocket
//   POST /upload/:codigo?at=<ISO>           → { ok: true }
//   GET  /health                            → { ok: true }

import { MAX_ARCHIVO_BYTES, TTL_RESPALDO_MS } from "./archivo.js";
import { generarCodigo, normalizarCodigo, MAX_JPEG_BYTES, TTL_SESION_MS } from "./sesion.js";

export { Sesion, Limite } from "./durable.js";

const ORIGENES = [
  "https://choquevolqueta.com",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "null", // file:// mientras se desarrolla
];

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": ORIGENES.includes(origin) ? origin : ORIGENES[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // X-Token tiene que estar acá: el navegador pregunta antes de mandar un
    // encabezado propio, y si no está en la lista bloquea la subida entera.
    "Access-Control-Allow-Headers": "Content-Type, X-Token",
    // Para que el celular no pregunte de nuevo antes de cada foto.
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

const json = (cuerpo, status, origin) =>
  new Response(JSON.stringify(cuerpo), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });

const ttlDe = (env) => Number(env?.TTL_SESION_MS ?? TTL_SESION_MS);
const respaldoDe = (env) => Number(env?.TTL_RESPALDO_MS ?? TTL_RESPALDO_MS);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") ?? "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    if (url.pathname === "/health") {
      // El TTL activo se publica para que los tests sepan si el server está
      // configurado con uno corto, en lugar de fallar sin explicar.
      return json({ ok: true, ttl: ttlDe(env), ttl_respaldo: respaldoDe(env) }, 200, origin);
    }

    if (url.pathname === "/session" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") ?? "local";
      const limite = await env.LIMITES.get(env.LIMITES.idFromName("global")).fetch(
        "https://limite/",
        { headers: { "X-IP": ip } },
      );
      if (limite.status === 429) return json({ error: "limite" }, 429, origin);

      // El modo es opcional: el 1.0 no lo manda y su pedido no lleva cuerpo.
      const pedido = await request.json().catch(() => ({}));

      // El código lo genera acá: el Durable Object no existe hasta que hay un
      // código que lo nombre.
      const codigo = generarCodigo();
      const creada = await env.SESIONES.get(env.SESIONES.idFromName(codigo)).fetch(
        "https://sesion/crear",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codigo, ttl: ttlDe(env), modo: pedido.modo, respaldo: respaldoDe(env) }),
        },
      );
      const datos = await creada.json();
      return json({ codigo: datos.codigo }, 200, origin);
    }

    const ruta = url.pathname.match(/^\/(ws|upload|subir)\/([^/]+)$/);
    if (ruta) {
      const codigo = normalizarCodigo(decodeURIComponent(ruta[2]));
      const stub = env.SESIONES.get(env.SESIONES.idFromName(codigo));

      if (ruta[1] === "ws") {
        if (codigo.length !== 8) return json({ error: "sin-sesion" }, 404, origin);
        // El pedido pasa tal cual, para que el upgrade del WebSocket sobreviva.
        return stub.fetch(request);
      }

      // El tamaño se mira antes de leer nada: si el cuerpo se bufferiza entero
      // primero, el tope acota el resultado pero no el costo. Cada ruta tiene su
      // tope: la foto viaja por un mensaje de WebSocket, el archivo no.
      const tope = ruta[1] === "upload" ? MAX_JPEG_BYTES : MAX_ARCHIVO_BYTES;
      const declarado = Number(request.headers.get("Content-Length") ?? 0);
      if (declarado > tope) return json({ error: "grande" }, 413, origin);

      // El cuerpo se drena siempre, incluso cuando se rechaza: un pedido con el
      // stream sin consumir hace que el runtime avise "Can't read from request
      // stream after response has been sent".
      const cuerpo = await request.arrayBuffer();
      if (codigo.length !== 8) return json({ error: "sin-sesion" }, 404, origin);

      // Se reenvía con todas las cabeceras (el token y el nombre del archivo
      // viajan en ellas), menos las que dependen del cuerpo original.
      const cabeceras = new Headers(request.headers);
      cabeceras.delete("content-length");
      cabeceras.delete("host");

      const respuesta = await stub.fetch(new Request(request.url, {
        method: "POST",
        headers: cabeceras,
        body: cuerpo,
      }));

      return new Response(respuesta.body, {
        status: respuesta.status,
        headers: { ...Object.fromEntries(respuesta.headers), ...cors(origin) },
      });
    }

    const descarga = url.pathname.match(/^\/bajar\/([^/]+)\/([^/]+)$/);
    if (descarga) {
      const codigo = normalizarCodigo(decodeURIComponent(descarga[1]));
      if (codigo.length !== 8) return json({ error: "sin-sesion" }, 404, origin);

      const respuesta = await env.SESIONES.get(env.SESIONES.idFromName(codigo)).fetch(request);
      return new Response(respuesta.body, {
        status: respuesta.status,
        headers: { ...Object.fromEntries(respuesta.headers), ...cors(origin) },
      });
    }

    return json({ error: "no-existe" }, 404, origin);
  },
};
