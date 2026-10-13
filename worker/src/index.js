// Punto de entrada del Worker: solo API, no sirve la página.
//   POST /session                          → { codigo }
//   GET  /ws/:codigo?rol=pc|emisor          → WebSocket
//   POST /upload/:codigo?at=<ISO>           → { ok: true }
//   GET  /health                            → { ok: true }

import { generarCodigo, normalizarCodigo } from "./sesion.js";

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
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

const json = (cuerpo, status, origin) =>
  new Response(JSON.stringify(cuerpo), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") ?? "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    if (url.pathname === "/health") return json({ ok: true }, 200, origin);

    if (url.pathname === "/session" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") ?? "local";
      const limite = await env.LIMITES.get(env.LIMITES.idFromName("global")).fetch(
        "https://limite/",
        { headers: { "X-IP": ip } },
      );
      if (limite.status === 429) return json({ error: "limite" }, 429, origin);

      // El código lo genera acá: el Durable Object no existe hasta que hay un
      // código que lo nombre.
      const codigo = generarCodigo();
      const creada = await env.SESIONES.get(env.SESIONES.idFromName(codigo)).fetch(
        "https://sesion/crear",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codigo }),
        },
      );
      const datos = await creada.json();
      return json({ codigo: datos.codigo }, 200, origin);
    }

    const ruta = url.pathname.match(/^\/(ws|upload)\/([^/]+)$/);
    if (ruta) {
      const codigo = normalizarCodigo(decodeURIComponent(ruta[2]));
      const stub = env.SESIONES.get(env.SESIONES.idFromName(codigo));

      if (ruta[1] === "ws") {
        if (codigo.length !== 8) return json({ error: "sin-sesion" }, 404, origin);
        // El pedido pasa tal cual, para que el upgrade del WebSocket sobreviva.
        return stub.fetch(request);
      }

      // El cuerpo se drena siempre, incluso cuando se rechaza: un pedido con el
      // stream sin consumir hace que el runtime avise "Can't read from request
      // stream after response has been sent".
      const cuerpo = await request.arrayBuffer();
      if (codigo.length !== 8) return json({ error: "sin-sesion" }, 404, origin);

      const respuesta = await stub.fetch(new Request(request.url, {
        method: "POST",
        headers: { "Content-Type": request.headers.get("Content-Type") ?? "" },
        body: cuerpo,
      }));

      return new Response(respuesta.body, {
        status: respuesta.status,
        headers: { ...Object.fromEntries(respuesta.headers), ...cors(origin) },
      });
    }

    return json({ error: "no-existe" }, 404, origin);
  },
};
