// Las dos piezas con estado del túnel.
//
// `Sesion` es una instancia única por código: sabe quién está del otro lado,
// empuja la foto y —en modo documentos— guarda los archivos hasta que la PC los
// baja. `Limite` es una sola instancia para todo el mundo y lleva la cuenta de
// sesiones nuevas por IP.
//
// Ni la foto ni los archivos se guardan: viven en memoria el tiempo que tardan
// en cruzar.

import {
  crearSesion, estaExpirada, tocarSesion, registrarEmisor, liberarEmisor,
  puedeRecibirFoto, TTL_SESION_MS,
} from "./sesion.js";
import {
  MODOS, MODO_POR_DEFECTO, TTL_RESPALDO_MS, modoValido, puedeRecibirArchivo,
} from "./archivo.js";
import { permitir } from "./limite.js";

const json = (cuerpo, status) =>
  new Response(JSON.stringify(cuerpo), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// Lo único que el objeto reenvía entre los dos lados. Nada que no esté acá pasa,
// y el objeto nunca mira el contenido de un archivo.
const TIPOS_REENVIADOS = new Set([
  "item", "progreso", "item-ok", "item-error",
  "oferta", "respuesta", "candidato",
]);

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
    // Los tokens: el del emisor para subir la foto y el archivo; el de la PC
    // para bajar del respaldo. Sin ellos, cualquiera con el código entra.
    this.tokenEmisor = null;
    this.tokenPc = null;
    // Los archivos del respaldo, en memoria: id → { nombre, tipo, bytes, guardadoEn }.
    this.items = new Map();
    this.ttlRespaldo = Number(env?.TTL_RESPALDO_MS ?? TTL_RESPALDO_MS);
  }

  get ttl() {
    return this.sesion?.ttl ?? Number(this.env?.TTL_SESION_MS ?? TTL_SESION_MS);
  }

  get enDocumentos() {
    return this.sesion?.modo === MODOS.DOCUMENTOS;
  }

  async fetch(request) {
    const url = new URL(request.url);
    // El Worker pasa el pedido tal cual, así que las rutas conservan el código.
    if (url.pathname === "/crear") return this.crear(request);
    if (url.pathname.startsWith("/ws/")) return this.abrirSocket(request, url);
    if (url.pathname.startsWith("/upload/")) return this.recibirFoto(request, url);
    if (url.pathname.startsWith("/subir/")) return this.recibirArchivo(request);
    if (url.pathname.startsWith("/bajar/")) return this.entregarArchivo(request, url);
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

  // La alarma es una sola para dos vencimientos: la sesión y los archivos del
  // respaldo que nadie bajó. Se programa para el más próximo.
  async programarAlarma(ahora) {
    let proxima = (this.sesion?.ultimaActividad ?? ahora) + this.ttl;
    if (this.items.size) {
      const primero = Math.min(...[...this.items.values()].map((item) => item.guardadoEn));
      proxima = Math.min(proxima, primero + this.ttlRespaldo);
    }
    await this.ctx.storage.setAlarm(proxima);
  }

  async alarm() {
    const ahora = Date.now();

    for (const [id, item] of this.items) {
      if (ahora - item.guardadoEn >= this.ttlRespaldo) this.items.delete(id);
    }

    if (this.sesion && !estaExpirada(this.sesion, ahora, this.ttl)) {
      // Hubo actividad y la alarma quedó vieja: se corre.
      await this.programarAlarma(ahora);
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
    this.tokenEmisor = null;
    this.tokenPc = null;
    this.items.clear();
  }

  async crear(request) {
    const { codigo, ttl, modo, respaldo } = await request.json();
    const ahora = Date.now();
    if (!this.sesion) {
      this.sesion = crearSesion(ahora, codigo, ttl);
      // Sin modo, la sesión es de fotos: el 1.0 no manda nada y sigue igual.
      this.sesion.modo = modoValido(modo) ? modo : MODO_POR_DEFECTO;
      if (Number(respaldo) > 0) this.ttlRespaldo = Number(respaldo);
    }
    await this.programarAlarma(ahora);
    return json({ codigo: this.sesion.codigo }, 200);
  }

  generarToken() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Un socket puede estar muerto sin que haya llegado su evento de cierre: si
  // el envío falla se dice, en vez de tirar la excepción hacia el fetch.
  enviar(socket, mensaje) {
    try {
      socket.send(JSON.stringify(mensaje));
      return true;
    } catch {
      return false;
    }
  }

  avisar(socket) {
    this.enviar(socket, { type: "estado", emisor: !!this.sesion?.emisor });
  }

  async abrirSocket(request, url) {
    if (!UPGRADE(request)) return json({ error: "sin-upgrade" }, 426);
    if (!this.viva()) return json({ error: "sin-sesion" }, 404);

    const rol = url.searchParams.get("rol") === "emisor" ? "emisor" : "pc";
    const [cliente, servidor] = Object.values(new WebSocketPair());
    servidor.accept();

    let bienvenida = null;

    if (rol === "pc") {
      if (this.pc) {
        servidor.close(4001, "ya hay una pc");
        return new Response(null, { status: 101, webSocket: cliente });
      }
      this.pc = servidor;
      this.sesion.pc = true;
      // Solo en documentos: en fotos el primer mensaje de la PC sigue siendo el
      // estado, y el camino que ya funciona no cambia.
      if (this.enDocumentos) {
        this.tokenPc = this.generarToken();
        bienvenida = { type: "bienvenida", token: this.tokenPc };
      }
    } else {
      const cupo = registrarEmisor(this.sesion);
      if (!cupo.ok) {
        servidor.close(4001, "ocupado");
        return new Response(null, { status: 101, webSocket: cliente });
      }
      this.emisor = servidor;
      this.tokenEmisor = this.generarToken();
      bienvenida = { type: "bienvenida", token: this.tokenEmisor };
      servidor.addEventListener("message", (evento) => this.reenviar(evento));
    }

    tocarSesion(this.sesion, Date.now());
    await this.programarAlarma(Date.now());

    if (bienvenida) this.enviar(servidor, bienvenida);
    this.avisar(servidor);
    if (this.pc && this.pc !== servidor) this.avisar(this.pc);

    servidor.addEventListener("close", () => this.soltar(rol, servidor));
    return new Response(null, { status: 101, webSocket: cliente });
  }

  // El apretón de manos de WebRTC y los avisos de archivo van y vienen por acá.
  reenviar(evento) {
    if (!this.sesion || !this.enDocumentos || !this.pc) return;
    let mensaje;
    try {
      mensaje = JSON.parse(typeof evento.data === "string" ? evento.data : "");
    } catch {
      return;
    }
    if (!TIPOS_REENVIADOS.has(mensaje?.type)) return;
    this.enviar(this.pc, mensaje);
  }

  soltar(rol, servidor) {
    if (rol === "pc") {
      if (this.pc !== servidor) return;
      this.pc = null;
      this.tokenPc = null;
      if (this.sesion) this.sesion.pc = false;
      // Sin PC no hay destino: el celular se entera por el cierre, no por un
      // mensaje que ya nadie podría entregar.
      const cel = this.emisor;
      this.emisor = null;
      this.tokenEmisor = null;
      if (this.sesion) liberarEmisor(this.sesion);
      try {
        cel?.close(4003, "la pc se desconecto");
      } catch {}
      return;
    }
    if (this.emisor !== servidor) return;
    this.emisor = null;
    this.tokenEmisor = null;
    if (this.sesion) liberarEmisor(this.sesion);
    if (this.pc) this.avisar(this.pc);
  }

  async recibirFoto(request, url) {
    // El cuerpo se lee siempre, incluso cuando la sesión ya no existe: si queda
    // sin consumir, el runtime avisa "Can't read from request stream after
    // response has been sent" y el pedido termina en un TypeError.
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!this.viva()) return json({ error: "sin-sesion" }, 404);
    if (this.enDocumentos) return json({ error: "sin-sesion" }, 404);

    const tipo = request.headers.get("Content-Type") ?? "";
    const puede = puedeRecibirFoto(this.sesion, bytes, tipo);
    if (!puede.ok) return json({ error: puede.error }, puede.error === "sin-pc" ? 409 : 413);

    // Sin el token del emisor aceptado, nada entra: ni un cliente ajeno, ni un
    // celular al que se le cerró el socket por ocupado.
    if (!this.emisor || !this.tokenEmisor || request.headers.get("X-Token") !== this.tokenEmisor) {
      return json({ error: "sin-token" }, 409);
    }
    if (!this.pc) return json({ error: "sin-pc" }, 409);

    const entregada = this.enviar(this.pc, {
      type: "foto",
      at: url.searchParams.get("at"),
      jpeg: aBase64(bytes),
    });
    if (!entregada) return json({ error: "sin-pc" }, 409);

    tocarSesion(this.sesion, Date.now());
    await this.programarAlarma(Date.now());
    return json({ ok: true }, 200);
  }

  // El respaldo: el archivo queda guardado en memoria hasta que la PC lo baja.
  async recibirArchivo(request) {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!this.viva()) return json({ error: "sin-sesion" }, 404);
    if (!this.enDocumentos) return json({ error: "sin-sesion" }, 404);

    if (!this.emisor || !this.tokenEmisor || request.headers.get("X-Token") !== this.tokenEmisor) {
      return json({ error: "sin-token" }, 409);
    }

    const tipo = request.headers.get("Content-Type") ?? "";
    const puede = puedeRecibirArchivo(this.sesion.modo, tipo, bytes);
    if (!puede.ok) {
      // 413 si es grande, 400 si vino vacío, 415 si dice ser algo que no es.
      const estado = puede.error === "grande" ? 413 : puede.error === "vacio" ? 400 : 415;
      return json({ error: puede.error }, estado);
    }

    let nombre = "archivo";
    try {
      nombre = decodeURIComponent(request.headers.get("X-Nombre") ?? "") || nombre;
    } catch {
      // Un nombre mal codificado no puede tirar abajo la subida.
    }

    const id = this.generarToken().slice(0, 16);
    this.items.set(id, { nombre, tipo, bytes, guardadoEn: Date.now() });

    tocarSesion(this.sesion, Date.now());
    await this.programarAlarma(Date.now());

    if (this.pc) {
      this.enviar(this.pc, { type: "item", id, nombre, tipo, bytes: bytes.length });
      this.enviar(this.pc, { type: "item-listo", id });
    }

    return json({ ok: true, id }, 200);
  }

  async entregarArchivo(request, url) {
    if (!this.viva()) return json({ error: "sin-sesion" }, 404);
    if (!this.enDocumentos) return json({ error: "sin-sesion" }, 404);

    if (!this.tokenPc || request.headers.get("X-Token") !== this.tokenPc) {
      return json({ error: "sin-token" }, 409);
    }

    const id = url.pathname.split("/").pop();
    const item = this.items.get(id);
    if (!item) return json({ error: "sin-item" }, 404);

    // De un solo uso: se entrega y se olvida.
    this.items.delete(id);

    return new Response(item.bytes, {
      status: 200,
      headers: { "Content-Type": item.tipo },
    });
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
