/* =====================================================================
   Túnel — el motor compartido.
   Lo que necesitan las dos pantallas: la sesión, el código, el QR, los
   nombres de archivo y la descarga. Nada de acá sabe si lo que se manda
   es una foto o un archivo.
   ===================================================================== */

const ES_LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";

// Todo lo de abajo es `var` a propósito: queda a la vista desde la consola,
// que es como se prueba el módulo a mano.
var API_BASE = ES_LOCAL ? "http://127.0.0.1:8787" : "https://tunel.choquevolqueta.com";
var PAGINA = location.origin + location.pathname;

// El modo lo decide la URL: `?m=documentos` es la pantalla de documentos; sin
// nada, la de fotos (que es la que ya funcionaba).
var MODO = new URLSearchParams(location.search).get("m") === "documentos" ? "documentos" : "fotos";

const el = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- QR */

function dibujarQr(texto) {
    const qr = qrcode(0, "M");
    qr.addData(texto);
    qr.make();

    const n = qr.getModuleCount();
    const margen = 4; // el margen que pide el estándar
    const lona = el("qr");
    const dpr = Math.min(window.devicePixelRatio || 1, 3);

    // Se redondea para arriba: mejor un canvas un poco más grande que uno
    // estirado y borroso. El tamaño visible lo pone el CSS.
    const escala = Math.max(2, Math.ceil((320 * dpr) / (n + margen * 2)));
    const lado = (n + margen * 2) * escala;

    lona.width = lado;
    lona.height = lado;

    const ctx = lona.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, lado, lado);
    ctx.fillStyle = "#000000";
    for (let fila = 0; fila < n; fila++) {
        for (let col = 0; col < n; col++) {
            if (qr.isDark(fila, col)) {
                ctx.fillRect((col + margen) * escala, (fila + margen) * escala, escala, escala);
            }
        }
    }
}

/* ------------------------------------------------------------ sesión */

// El modo es opcional. Sin él el pedido sale sin cuerpo y sin cabecera, igual
// que siempre: el servidor asume fotos, y el camino que ya funciona no cambia
// ni el pedido que manda.
async function crearSesion(modo) {
    const pedido = { method: "POST" };
    if (modo) {
        pedido.headers = { "Content-Type": "application/json" };
        pedido.body = JSON.stringify({ modo });
    }

    const respuesta = await fetch(API_BASE + "/session", pedido);
    if (!respuesta.ok) throw new Error("sin-sesion");
    return (await respuesta.json()).codigo;
}

/* -------------------------------------------------- sesión recordada */

// La sesión vive 7 minutos en el servidor (TTL deslizante). Un F5 no tiene por
// qué pedir un código nuevo: cada sesión cuesta duración de Durable Object
// aunque no mueva un byte. Se guarda el código por pestaña y se reusa mientras
// siga fresco; el guardado envejece con cada mensaje, igual que el servidor.
var CLAVE_SESION_GUARDADA = "tunel.sesion";
var VIDA_SESION_MS = 7 * 60 * 1000;

// sessionStorage puede no existir o tirar (modo privado, file://). Si falla, el
// túnel sigue funcionando: solo pierde el reuso.
function almacenDeSesion() {
    try {
        return sessionStorage;
    } catch {
        return null;
    }
}

function leerSesionGuardada(almacen, ahora, ttlMs, modo) {
    if (!almacen) return null;
    try {
        const crudo = almacen.getItem(CLAVE_SESION_GUARDADA);
        if (!crudo) return null;
        const dato = JSON.parse(crudo);
        if (!dato || typeof dato.codigo !== "string" || !dato.codigo) return null;
        if (dato.modo !== modo) return null;
        if (typeof dato.ts !== "number" || !Number.isFinite(dato.ts)) return null;
        if (ahora - dato.ts >= ttlMs) return null;
        return dato.codigo;
    } catch {
        return null;
    }
}

function guardarSesion(almacen, codigo, ahora, modo) {
    if (!almacen) return;
    try {
        almacen.setItem(CLAVE_SESION_GUARDADA, JSON.stringify({ codigo, ts: ahora, modo }));
    } catch {}
}

function tocarSesionGuardada(almacen, ahora) {
    if (!almacen) return;
    try {
        const crudo = almacen.getItem(CLAVE_SESION_GUARDADA);
        if (!crudo) return;
        const dato = JSON.parse(crudo);
        if (!dato || typeof dato.codigo !== "string") return;
        dato.ts = ahora;
        almacen.setItem(CLAVE_SESION_GUARDADA, JSON.stringify(dato));
    } catch {}
}

function olvidarSesion(almacen) {
    if (!almacen) return;
    try {
        almacen.removeItem(CLAVE_SESION_GUARDADA);
    } catch {}
}

// Un cierre por expiración duerme ya. Cualquier otro cierre reintenta hasta
// agotar los intentos; si no hay más, también duerme.
function decidirCierre(codigo, intentos, maxIntentos) {
    if (codigo === 4002) return "dormir";
    return intentos < maxIntentos ? "reintentar" : "dormir";
}

var dormida = false;

function mostrarDormida() {
    dormida = true;
    const qrVivo = el("qr-vivo");
    const bloque = el("bloque-dormida");
    if (qrVivo) qrVivo.hidden = true;
    if (bloque) bloque.hidden = false;
    el("estado").classList.remove("esta-conectado");
}

function mostrarQrVivo() {
    dormida = false;
    const qrVivo = el("qr-vivo");
    const bloque = el("bloque-dormida");
    if (qrVivo) qrVivo.hidden = false;
    if (bloque) bloque.hidden = true;
}

// El mismo WebSocket para las dos pantallas: quien lo pide decide qué hacer con
// cada mensaje que llega.
function abrirSocket(codigo, rol, alMensaje, alBinario) {
    const ws = new WebSocket(API_BASE.replace(/^http/, "ws") + "/ws/" + codigo + "?rol=" + rol);
    // Las piezas de un archivo llegan como frames binarios; el resto es JSON.
    ws.binaryType = "arraybuffer";
    ws.onmessage = (evento) => {
        if (typeof evento.data !== "string") {
            alBinario?.(evento.data);
            return;
        }
        let mensaje;
        try {
            mensaje = JSON.parse(evento.data);
        } catch {
            return;
        }
        alMensaje(mensaje);
    };
    return ws;
}

/* -------------------------------------------- nombres y descargas */

function fechaDe(valor) {
    if (typeof valor !== "string" || valor === "") return null;
    const fecha = new Date(valor);
    return Number.isNaN(fecha.getTime()) ? null : fecha;
}

function nombreArchivo(at, ahora = new Date()) {
    const fecha = fechaDe(at) ?? ahora;
    const dos = (n) => String(n).padStart(2, "0");
    return (
        "foto-" + fecha.getFullYear() + "-" + dos(fecha.getMonth() + 1) + "-" + dos(fecha.getDate()) +
        "-" + dos(fecha.getHours()) + dos(fecha.getMinutes()) + ".jpg"
    );
}

function horaDe(at, ahora = new Date()) {
    const fecha = fechaDe(at) ?? ahora;
    const dos = (n) => String(n).padStart(2, "0");
    return dos(fecha.getHours()) + ":" + dos(fecha.getMinutes());
}

// El tamaño, como se lee en pantalla.
function formatearBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
    return (n / (1024 * 1024)).toFixed(1).replace(".", ",") + " MB";
}

// Cuántos pedazos y de qué tamaño: lo usa el envío por el canal de datos.
function trocear(total, tamano) {
    const cantidad = Math.max(1, Math.ceil(total / tamano));
    return { cantidad, ultimo: total - tamano * (cantidad - 1) };
}

/* ------------------------------------------------------ piezas del archivo */

// 64 KB por pieza: el canal de datos rechaza un frame de 1 MiB ("larger than
// max-message-size"), y 64 KB es lo que aguantan todos los navegadores. Con la
// ventana de 4 hay 256 KB en vuelo, más que suficiente para saturar la subida de
// un celular.
var PIEZA_BYTES = 65536;

// Cuántas piezas puede haber sin confirmar. Cuatro saturan el enlace sin que la
// memoria del otro lado crezca.
var VENTANA_PIEZAS = 4;

function piezasDe(total, tamano = PIEZA_BYTES) {
    if (!total || total <= 0) return { cantidad: 0 };
    return { cantidad: Math.ceil(total / tamano) };
}

// El tramo de bytes que ocupa una pieza; `hasta` no se incluye.
function tramoDe(indice, tamano, total) {
    const desde = indice * tamano;
    return { desde, hasta: Math.min(desde + tamano, total) };
}

// La primera pieza que falta: es el punto donde se reanuda.
function primeraFaltante(recibidas, cantidad) {
    for (let i = 0; i < cantidad; i++) {
        if (!recibidas.has(i)) return i;
    }
    return cantidad;
}

function estanTodas(recibidas, cantidad) {
    return primeraFaltante(recibidas, cantidad) === cantidad;
}

/* ------------------------------------------------------ la lista elegida */

// Dos archivos son el mismo si coinciden nombre, tamaño y fecha: es lo que los
// distingue sin tener que leerlos enteros.
function claveDeElegido(item) {
    return item.nombre + "\u0000" + item.bytes + "\u0000" + (item.ultimo || 0);
}

// Suma lo que se acaba de elegir a lo que ya estaba elegido. En el celular se
// elige de a tandas —una foto desde la cámara, un PDF desde descargas—, así que
// la segunda vuelta tiene que conservar la primera. El mismo archivo elegido dos
// veces no se duplica, y lo que no entra por el tope se informa en vez de
// desaparecer en silencio.
function sumarElegidos(previos, nuevos, tope) {
    const lista = [...previos];
    const vistos = new Set(lista.map(claveDeElegido));
    let agregados = 0;
    let repetidos = 0;
    let sobrantes = 0;

    for (const item of nuevos) {
        const clave = claveDeElegido(item);
        if (vistos.has(clave)) {
            repetidos++;
            continue;
        }
        if (lista.length >= tope) {
            sobrantes++;
            continue;
        }
        lista.push(item);
        vistos.add(clave);
        agregados++;
    }

    return { lista, agregados, repetidos, sobrantes };
}

// El trozo del canal de datos es del cliente: el Worker no lo usa (no ve los
// bytes cuando el envío va directo).
var TAMANO_TROZO = 16384;

// La descarga, en un solo lugar: la usan la foto y los archivos.
// El `revoke` va con retraso: si se suelta la URL en el acto, algunos
// navegadores cortan la descarga que acaba de empezar.
function guardarBlob(blob, nombre) {
    const url = URL.createObjectURL(blob);
    const enlace = document.createElement("a");
    enlace.href = url;
    enlace.download = nombre;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// La pantalla de documentos se baja solo cuando hace falta: en modo fotos no se
// paga su peso ni su riesgo.
if (MODO === "documentos") {
    const script = document.createElement("script");
    script.src = "documentos.js";
    document.head.appendChild(script);
}

/* ------------------------------------------------------- el interruptor */

// Cambiar de modo es empezar de nuevo: sesión nueva y QR nuevo. Se avisa, porque
// el código que está en pantalla deja de servir.
function pedirCambioDeModo(modo) {
    if (modo === MODO) return;
    const aviso = "Se crea una sesión nueva y el código que está en pantalla deja de servir. ¿Seguimos?";
    if (!confirm(aviso)) return;

    const url = new URL(location.href);
    if (modo === "documentos") url.searchParams.set("m", "documentos");
    else url.searchParams.delete("m");
    url.searchParams.delete("s");
    location.href = url.toString();
}

document.addEventListener("DOMContentLoaded", () => {
    const btnReactivar = el("btn-reactivar");
    if (btnReactivar) {
        btnReactivar.addEventListener("click", () => {
            olvidarSesion(almacenDeSesion());
            if (MODO === "documentos") arrancarMostrador();
            else arrancarComoPc();
        });
    }

    const aFotos = el("btn-modo-fotos");
    const aDocs = el("btn-modo-documentos");
    if (!aFotos || !aDocs) return;

    aFotos.classList.toggle("tunel-modo-activo", MODO === "fotos");
    aDocs.classList.toggle("tunel-modo-activo", MODO === "documentos");
    aFotos.addEventListener("click", () => pedirCambioDeModo("fotos"));
    aDocs.addEventListener("click", () => pedirCambioDeModo("documentos"));
});
