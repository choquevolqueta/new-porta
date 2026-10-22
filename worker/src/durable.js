// Las dos piezas con estado del túnel.
//
// `Sesion` es una instancia única por código: sabe quién está del otro lado,
// empuja la foto y —en modo documentos— hace pasar los archivos de un lado al
// otro. `Limite` es una sola instancia para todo el mundo y lleva la cuenta de
// sesiones nuevas por IP.
//
// Ni la foto ni los archivos se guardan: el archivo se lee del pedido y se
// reenvía a la PC en piezas, sin tenerlo entero en memoria.

import {
  crearSesion, estaExpirada, tocarSesion, registrarEmisor, liberarEmisor,
  puedeRecibirFoto, TTL_SESION_MS,
} from "./sesion.js";
import {
  MODOS, MODO_POR_DEFECTO, MAX_ARCHIVO_BYTES, modoValido, puedeRecibirArchivo,
} from "./archivo.js";
import { permitir } from "./limite.js";

// Piezas de 64 KB y ventana de 4: el objeto nunca tiene más de cuatro piezas en
// vuelo, y el que manda no se adelanta más de eso sobre lo que la PC confirmó.
// 64 KB y no 1 MiB porque el canal de datos del navegador rechaza frames
// grandes; el mismo tamaño vale para los dos caminos.
const PIEZA_BYTES = 65536;
const VENTANA = 4;
const ESPERA_CONFIRMO_MS = 20000;
// Cada cuántas piezas se toca la sesión: escribir almacenamiento en cada una,
// en medio de un stream de 50 MiB, es ruido al pedo.
const PIEZAS_POR_TOQUE = 8;

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
  // Reanudar: el celular pregunta dónde quedó y la PC contesta.
  "pidofalta", "falta",
]);

// Un pedido rechazado con el cuerpo sin leer deja al runtime avisando: se
// cancela el stream en vez de bufferizarlo (que es justo lo que se quiere
// evitar con un video de 50 MB).
async function descartar(request) {
  try {
    await request.body?.cancel();
  } catch {}
}

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
    // para bajar del respaldo. Viven con la sesión, no con la conexión: si el
    // celular se cae y vuelve, tiene que poder reanudar con el mismo token.
    this.tokenEmisor = null;
    this.tokenPc = null;
    // Las transferencias en curso: id → { total, desde, confirmado, despertar }.
    this.transferencias = new Map();
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
    await this.ctx.storage.setAlarm((this.sesion?.ultimaActividad ?? ahora) + this.ttl);
  }

  async alarm() {
    const ahora = Date.now();
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
    this.transferencias.clear();
  }

  async crear(request) {
    const { codigo, ttl, modo } = await request.json();
    const ahora = Date.now();
    if (!this.sesion) {
      this.sesion = crearSesion(ahora, codigo, ttl);
      // Sin modo, la sesión es de fotos: el 1.0 no manda nada y sigue igual.
      this.sesion.modo = modoValido(modo) ? modo : MODO_POR_DEFECTO;
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

  // Las piezas viajan como frame binario: en base64 pesarían un tercio más y
  // ocuparían el doble en memoria.
  enviarBinario(socket, bytes) {
    try {
      socket.send(bytes);
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
        // Los dos lados reenvían: el apretón de manos necesita ida y vuelta, y
        // la respuesta viaja del mostrador al celular.
        servidor.addEventListener("message", (evento) => this.reenviar(evento, "pc"));
      }
    } else {
      const cupo = registrarEmisor(this.sesion);
      if (!cupo.ok) {
        servidor.close(4001, "ocupado");
        return new Response(null, { status: 101, webSocket: cliente });
      }
      this.emisor = servidor;
      // En documentos el token vive con la sesión: si el celular se cae y
      // vuelve, la subida en curso no queda con un token viejo. En fotos sigue
      // rotando en cada conexión, que es lo que el 1.0 ya probaba.
      this.tokenEmisor = this.enDocumentos
        ? (this.tokenEmisor ?? this.generarToken())
        : this.generarToken();
      bienvenida = { type: "bienvenida", token: this.tokenEmisor };
      servidor.addEventListener("message", (evento) => this.reenviar(evento, "emisor"));
    }

    tocarSesion(this.sesion, Date.now());
    await this.programarAlarma(Date.now());

    if (bienvenida) this.enviar(servidor, bienvenida);
    this.avisar(servidor);
    if (this.pc && this.pc !== servidor) this.avisar(this.pc);

    servidor.addEventListener("close", () => this.soltar(rol, servidor));
    return new Response(null, { status: 101, webSocket: cliente });
  }

  // El apretón de manos de WebRTC y los avisos de archivo van y vienen por acá:
  // lo del emisor va a la PC y lo de la PC al emisor.
  reenviar(evento, rol) {
    if (!this.sesion || !this.enDocumentos) return;

    let mensaje;
    try {
      mensaje = JSON.parse(typeof evento.data === "string" ? evento.data : "");
    } catch {
      return;
    }
    if (!mensaje || typeof mensaje !== "object") return;

    // La confirmación de la PC es para el objeto, no para el celular: es lo que
    // abre la ventana de envío.
    if (mensaje.type === "confirmo") {
      this.registrarConfirmo(mensaje);
      return;
    }

    if (!TIPOS_REENVIADOS.has(mensaje.type)) return;
    const destino = rol === "emisor" ? this.pc : this.emisor;
    if (!destino) return;
    this.enviar(destino, mensaje);
  }

  registrarConfirmo(mensaje) {
    const transferencia = this.transferencias.get(mensaje.id);
    if (!transferencia) return;
    const indice = Number(mensaje.indice);
    if (!Number.isFinite(indice)) return;
    transferencia.confirmado = Math.max(transferencia.confirmado, indice);
    transferencia.despertar?.();
    transferencia.despertar = null;
  }

  // Espera a que la ventana se abra. Si la PC no confirma en 20 s, se corta: no
  // se queda colgado para siempre.
  async esperarTurno(transferencia, indice) {
    if (indice - transferencia.confirmado < VENTANA) return;
    await new Promise((resolver, rechazar) => {
      const reloj = setTimeout(() => {
        transferencia.despertar = null;
        rechazar(new Error("sin-confirmacion"));
      }, ESPERA_CONFIRMO_MS);
      transferencia.despertar = () => {
        clearTimeout(reloj);
        resolver();
      };
    });
    return this.esperarTurno(transferencia, indice);
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
      if (!this.enDocumentos) this.tokenEmisor = null;
      if (this.sesion) liberarEmisor(this.sesion);
      try {
        cel?.close(4003, "la pc se desconecto");
      } catch {}
      return;
    }
    if (this.emisor !== servidor) return;
    this.emisor = null;
    if (!this.enDocumentos) this.tokenEmisor = null;
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

  // El respaldo: el archivo no se guarda. Se lee del pedido y se reenvía a la PC
  // en piezas de 1 MiB, con ventana y confirmación, igual que el camino directo.
  async recibirArchivo(request) {
    if (!this.viva()) {
      await descartar(request);
      return json({ error: "sin-sesion" }, 404);
    }
    if (!this.enDocumentos) {
      await descartar(request);
      return json({ error: "sin-sesion" }, 404);
    }

    if (!this.emisor || !this.tokenEmisor || request.headers.get("X-Token") !== this.tokenEmisor) {
      await descartar(request);
      return json({ error: "sin-token" }, 409);
    }

    // Sin PC no hay a quién entregarlo: no hay nada que guardar.
    if (!this.pc) {
      await descartar(request);
      return json({ error: "sin-pc" }, 409);
    }

    const total = Number(request.headers.get("X-Bytes") ?? 0);
    const desde = Number(request.headers.get("X-Desde") ?? 0);
    const tipo = request.headers.get("Content-Type") ?? "";
    const id = request.headers.get("X-Id") || this.generarToken().slice(0, 16);

    if (!Number.isFinite(total) || total <= 0 || total > MAX_ARCHIVO_BYTES) {
      await descartar(request);
      return json({ error: "grande" }, 413);
    }
    if (!Number.isFinite(desde) || desde < 0 || desde >= total) {
      await descartar(request);
      return json({ error: "rango" }, 413);
    }

    const lector = request.body?.getReader();
    if (!lector) return json({ error: "vacio" }, 400);

    // Los primeros bytes deciden el tipo. Si el tramo viene reanudado, los bytes
    // no son la cabecera del archivo: ahí la firma no se puede comprobar.
    const primero = await lector.read();
    if (primero.done) {
      await lector.cancel();
      return json({ error: "vacio" }, 400);
    }

    const puede = puedeRecibirArchivo(this.sesion.modo, tipo, primero.value, total, desde);
    if (!puede.ok) {
      await lector.cancel();
      const estado = puede.error === "grande" ? 413 : puede.error === "vacio" ? 400 : 415;
      return json({ error: puede.error }, estado);
    }

    const transferencia = {
      id,
      total,
      desde,
      confirmado: Math.floor(desde / PIEZA_BYTES) - 1,
      despertar: null,
    };
    this.transferencias.set(id, transferencia);

    let indice = Math.floor(desde / PIEZA_BYTES);
    let reenviados = 0;

    const mandarPieza = async (bytes) => {
      // El cuerpo no puede pasarse del total anunciado, aunque el cliente lo
      // haya declarado de menos: se corta a mitad y la PC se entera.
      if (desde + reenviados + bytes.byteLength > total) throw new Error("grande");
      await this.esperarTurno(transferencia, indice);
      if (!this.pc) throw new Error("sin-pc");

      const avisada = this.enviar(this.pc, { type: "pieza", id, indice, bytes: bytes.byteLength });
      const entregada = avisada && this.enviarBinario(this.pc, bytes);
      if (!entregada) throw new Error("sin-pc");

      reenviados += bytes.byteLength;
      indice += 1;
      if (indice % PIEZAS_POR_TOQUE === 0) tocarSesion(this.sesion, Date.now());
    };

    // El tramo puede empezar en el medio de una pieza; la primera se cierra en
    // la frontera absoluta para que los índices coincidan con los del celular.
    let capacidad = PIEZA_BYTES - (desde % PIEZA_BYTES);
    let buffer = new Uint8Array(capacidad);
    let lleno = 0;

    const empujar = async (trozo) => {
      let i = 0;
      while (i < trozo.byteLength) {
        const copiar = Math.min(buffer.byteLength - lleno, trozo.byteLength - i);
        buffer.set(trozo.subarray(i, i + copiar), lleno);
        lleno += copiar;
        i += copiar;
        if (lleno === buffer.byteLength) {
          await mandarPieza(buffer);
          capacidad = PIEZA_BYTES;
          buffer = new Uint8Array(capacidad);
          lleno = 0;
        }
      }
    };

    try {
      await empujar(primero.value);
      while (true) {
        const { done, value } = await lector.read();
        if (done) break;
        await empujar(value);
      }
      if (lleno > 0) await mandarPieza(buffer.subarray(0, lleno));

      this.enviar(this.pc, { type: "fin", id });
      tocarSesion(this.sesion, Date.now());
      await this.programarAlarma(Date.now());
      return json({ ok: true, id }, 200);
    } catch (error) {
      const motivo = error?.message === "grande" ? "grande" : "cortado";
      this.enviar(this.pc, { type: "item-error", id, motivo });
      return json({ error: motivo }, motivo === "grande" ? 413 : 409);
    } finally {
      this.transferencias.delete(id);
      try {
        await lector.cancel();
      } catch {}
    }
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
