// Las dos piezas con estado del túnel.
//
// `Sesion` es una instancia única por código: sabe quién está del otro lado y
// empuja la foto. `Limite` es una sola instancia para todo el mundo y lleva la
// cuenta de sesiones nuevas por IP.
//
// La foto nunca se guarda: vive en memoria el tiempo que tarda en cruzar.

import {
  crearSesion, estaExpirada, tocarSesion, registrarEmisor, liberarEmisor,
  puedeRecibirFoto, TTL_SESION_MS,
} from "./sesion.js";
import { permitir } from "./limite.js";

const json = (cuerpo, status) =>
  new Response(JSON.stringify(cuerpo), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// Base64 por trozos: un String.fromCharCode(...bytes) con 600 KB revienta el stack.
function aBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(s);
}

const UPGRADE = (request) =>
  (request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket";

export class Sesion {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sesion = null;
    this.pc = null;
    this.emisor = null;
  }

  get ttl() {
    return Number(this.env?.TTL_SESION_MS ?? TTL_SESION_MS);
  }

  async fetch(request) {
    const url = new URL(request.url);
    // El Worker pasa el pedido tal cual, así que las rutas conservan el código.
    if (url.pathname === "/crear") return this.crear(request);
    if (url.pathname.startsWith("/ws/")) return this.abrirSocket(request, url);
    if (url.pathname.startsWith("/upload/")) return this.recibirFoto(request, url);
    return json({ error: "no-existe" }, 404);
  }

  // ¿Hay una sesión viva? Si se pasó del tiempo sin actividad, la olvida.
  viva() {
    if (!this.sesion) return false;
    if (estaExpirada(this.sesion, Date.now(), this.ttl)) {
      this.sesion = null;
      return false;
    }
    return true;
  }

  async programarAlarma(ahora) {
    await this.ctx.storage.setAlarm(ahora + this.ttl);
  }

  async alarm() {
    if (this.sesion && !estaExpirada(this.sesion, Date.now(), this.ttl)) {
      // Hubo actividad y la alarma quedó vieja: se corre.
      await this.programarAlarma(Date.now());
      return;
    }
    this.sesion = null;
    for (const ws of [this.pc, this.emisor]) {
      try {
        ws?.close(4002, "expirada");
      } catch {}
    }
    this.pc = null;
    this.emisor = null;
  }

  async crear(request) {
    const { codigo } = await request.json();
    const ahora = Date.now();
    if (!this.sesion) {
      this.sesion = crearSesion(ahora, codigo);
    }
    await this.programarAlarma(ahora);
    return json({ codigo: this.sesion.codigo }, 200);
  }

  avisar(socket) {
    try {
      socket.send(JSON.stringify({ type: "estado", emisor: !!this.sesion?.emisor }));
    } catch {
      // El socket ya se fue: su propio evento de cierre lo limpia.
    }
  }

  async abrirSocket(request, url) {
    if (!UPGRADE(request)) return json({ error: "sin-upgrade" }, 426);
    if (!this.viva()) return json({ error: "sin-sesion" }, 404);

    const rol = url.searchParams.get("rol") === "emisor" ? "emisor" : "pc";
    const [cliente, servidor] = Object.values(new WebSocketPair());
    servidor.accept();

    if (rol === "pc") {
      if (this.pc) {
        servidor.close(4001, "ya hay una pc");
        return new Response(null, { status: 101, webSocket: cliente });
      }
      this.pc = servidor;
      this.sesion.pc = true;
    } else {
      const cupo = registrarEmisor(this.sesion);
      if (!cupo.ok) {
        servidor.close(4001, "ocupado");
        return new Response(null, { status: 101, webSocket: cliente });
      }
      this.emisor = servidor;
    }

    tocarSesion(this.sesion, Date.now());
    await this.programarAlarma(Date.now());

    this.avisar(servidor);
    if (this.pc && this.pc !== servidor) this.avisar(this.pc);

    servidor.addEventListener("close", () => this.soltar(rol, servidor));
    return new Response(null, { status: 101, webSocket: cliente });
  }

  soltar(rol, servidor) {
    if (rol === "pc") {
      if (this.pc !== servidor) return;
      this.pc = null;
      if (this.sesion) this.sesion.pc = false;
      // Sin PC no hay destino: el celular se entera por el cierre, no por un
      // mensaje que ya nadie podría entregar.
      const cel = this.emisor;
      this.emisor = null;
      if (this.sesion) liberarEmisor(this.sesion);
      try {
        cel?.close(4003, "la pc se desconecto");
      } catch {}
      return;
    }
    if (this.emisor !== servidor) return;
    this.emisor = null;
    if (this.sesion) liberarEmisor(this.sesion);
    if (this.pc) this.avisar(this.pc);
  }

  async recibirFoto(request, url) {
    // El cuerpo se lee siempre, incluso cuando la sesión ya no existe: si queda
    // sin consumir, el runtime avisa "Can't read from request stream after
    // response has been sent" y el pedido termina en un TypeError.
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!this.viva()) return json({ error: "sin-sesion" }, 404);

    const tipo = request.headers.get("Content-Type") ?? "";
    const puede = puedeRecibirFoto(this.sesion, bytes, tipo);
    if (!puede.ok) return json({ error: puede.error }, puede.error === "sin-pc" ? 409 : 413);
    if (!this.pc) return json({ error: "sin-pc" }, 409);

    this.pc.send(JSON.stringify({
      type: "foto",
      at: url.searchParams.get("at"),
      jpeg: aBase64(bytes),
    }));

    tocarSesion(this.sesion, Date.now());
    await this.programarAlarma(Date.now());
    return json({ ok: true }, 200);
  }
}

export class Limite {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.porIp = new Map();
  }

  async fetch(request) {
    const ip = request.headers.get("X-IP") ?? "desconocida";
    const pasa = permitir(this.porIp, ip, Date.now());
    return json({ ok: pasa }, pasa ? 200 : 429);
  }
}
