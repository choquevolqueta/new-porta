// Punto de entrada del Worker: solo API, no sirve la página.
//   POST /session                          → { codigo }
//   GET  /ws/:codigo?rol=pc|emisor          → WebSocket
//   POST /upload/:codigo?at=<ISO>           → { ok: true }        (foto)
//   POST /subir/:codigo                     → { ok: true, id }    (archivo, en streaming)
//   GET  /health                            → { ok: true }

import { MAX_ARCHIVO_BYTES } from "./archivo.js";
import { generarCodigo, normalizarCodigo, MAX_JPEG_BYTES, TTL_SESION_MS } from "./sesion.js";

export { Sesion, Limite } from "./durable.js";

const ORIGENES = [
  "https://choquevolqueta.com",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "null", // file:// mientras se desarrolla
];

export function cors(origin) {
  return {
    "Access-Control-Allow-Origin": ORIGENES.includes(origin) ? origin : ORIGENES[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // Los encabezados propios tienen que estar acá: el navegador pregunta antes
    // de mandarlos, y si no están en la lista bloquea el pedido entero.
    "Access-Control-Allow-Headers": "Content-Type, X-Token, X-Nombre, X-Id, X-Bytes, X-Desde",
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

// Un cuerpo rechazado sin leer deja al runtime avisando; se cancela el stream en
// vez de bufferizarlo (que es justo lo que se quiere evitar).
async function descartar(request) {
  try {
    await request.body?.cancel();
  } catch {}
}

const conCors = (respuesta, origin) =>
  new Response(respuesta.body, {
    status: respuesta.status,
    headers: { ...Object.fromEntries(respuesta.headers), ...cors(origin) },
  });

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
      return json({ ok: true, ttl: ttlDe(env) }, 200, origin);
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
          body: JSON.stringify({ codigo, ttl: ttlDe(env), modo: pedido.modo }),
        },
      );
      const datos = await creada.json();
      return json({ codigo: datos.codigo }, 200, origin);
    }

    const ruta = url.pathname.match(/^\/(ws|upload|subir)\/([^/]+)$/);
    if (ruta) {
      const codigo = normalizarCodigo(decodeURIComponent(ruta[2]));
      if (codigo.length !== 8) {
        await descartar(request);
        return json({ error: "sin-sesion" }, 404, origin);
      }

      const stub = env.SESIONES.get(env.SESIONES.idFromName(codigo));

      // El pedido pasa tal cual, para que el upgrade del WebSocket sobreviva.
      if (ruta[1] === "ws") return stub.fetch(request);

      // Se reenvía con todas las cabeceras (el token, el nombre y los bytes
      // viajan en ellas), menos las que dependen del cuerpo original.
      const cabeceras = new Headers(request.headers);
      cabeceras.delete("content-length");
      cabeceras.delete("host");

      // La foto sigue viajando entera: son 600 KB y ese camino no cambia.
      if (ruta[1] === "upload") {
        const declarado = Number(request.headers.get("Content-Length") ?? 0);
        if (declarado > MAX_JPEG_BYTES) {
          await descartar(request);
          return json({ error: "grande" }, 413, origin);
        }
        const cuerpo = await request.arrayBuffer();
        const respuesta = await stub.fetch(new Request(request.url, {
          method: "POST",
          headers: cabeceras,
          body: cuerpo,
        }));
        return conCors(respuesta, origin);
      }

      // El archivo se reenvía como stream: si se bufferiza acá, un video de
      // 50 MB pesa 50 MB en este isolate antes de llegar al objeto.
      const total = Number(request.headers.get("X-Bytes") ?? request.headers.get("Content-Length") ?? 0);
      const desde = Number(request.headers.get("X-Desde") ?? 0);
      const largo = Number(request.headers.get("Content-Length") ?? 0);

      if (!Number.isFinite(total) || total <= 0 || total > MAX_ARCHIVO_BYTES) {
        await descartar(request);
        return json({ error: "grande" }, 413, origin);
      }
      if (!Number.isFinite(desde) || desde < 0 || desde > total || (largo && desde + largo > total)) {
        await descartar(request);
        return json({ error: "rango" }, 413, origin);
      }

      const respuesta = await stub.fetch(new Request(request.url, {
        method: "POST",
        headers: cabeceras,
        body: request.body,
        duplex: "half",
      }));
      return conCors(respuesta, origin);
    }

    return json({ error: "no-existe" }, 404, origin);
  },
};
