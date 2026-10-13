/* =====================================================================
   Túnel de fotos — el cliente.
   Una sola página con dos roles, decididos por la URL y no por el
   user-agent: sin `?s=` es la PC que escucha, con `?s=` es el celular
   que saca la foto y la manda.
   ===================================================================== */

const ES_LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";

// Todo lo de abajo es `var` a propósito: queda a la vista desde la consola,
// que es como se prueba el módulo a mano.
var API_BASE = ES_LOCAL ? "http://127.0.0.1:8787" : "https://tunel.choquevolqueta.com";
var PAGINA = location.origin + location.pathname;

// Se puede bajar desde la consola para no esperar 10 minutos en una prueba.
var borradoMs = 10 * 60 * 1000;

var codigoActual = null;
var socketPc = null;
var intentosReconexion = 0;
var urlFoto = null;
var atFoto = null;
var temporizadorBorrado = null;

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

async function crearSesion() {
    const respuesta = await fetch(API_BASE + "/session", { method: "POST" });
    if (!respuesta.ok) throw new Error("sin-sesion");
    return (await respuesta.json()).codigo;
}

function pintarEstado(conectado, texto) {
    el("estado-texto").textContent =
        texto ?? (conectado ? "Celular conectado, esperando la foto" : "Esperando conexión");
    el("estado").classList.toggle("esta-conectado", !!conectado);
}

function conectarComoPc(codigo) {
    if (socketPc) {
        socketPc.onclose = null;
        socketPc.close();
    }

    const ws = new WebSocket(API_BASE.replace(/^http/, "ws") + "/ws/" + codigo + "?rol=pc");
    socketPc = ws;

    ws.onmessage = (evento) => {
        let mensaje;
        try {
            mensaje = JSON.parse(evento.data);
        } catch {
            return;
        }
        if (mensaje.type === "estado") pintarEstado(!!mensaje.emisor);
        else if (mensaje.type === "foto") mostrarFoto(mensaje);
    };

    ws.onclose = () => {
        if (socketPc === ws) reconectar(codigo);
    };
}

function reconectar(codigo) {
    socketPc = null;
    if (intentosReconexion < 3) {
        const espera = 1000 * Math.pow(2, intentosReconexion);
        intentosReconexion++;
        pintarEstado(false, "Sin conexión, reintentando");
        setTimeout(() => {
            if (!socketPc) conectarComoPc(codigo);
        }, espera);
        return;
    }
    // Tres intentos fallidos: el código quedó viejo. Se pide uno nuevo.
    intentosReconexion = 0;
    arrancarComoPc();
}

/* -------------------------------------------------- la foto recibida */

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

// El base64 se pasa a bytes por su cuenta: un spread de 600 KB revienta.
function base64ABytes(base64) {
    const binario = atob(base64);
    const bytes = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
    return bytes;
}

function mostrarFoto(mensaje) {
    borrarFoto(); // la nueva reemplaza a la vieja

    const blob = new Blob([base64ABytes(mensaje.jpeg)], { type: "image/jpeg" });
    urlFoto = URL.createObjectURL(blob);
    atFoto = mensaje.at ?? null;

    el("foto").src = urlFoto;
    el("foto-hora").textContent = horaDe(atFoto);
    el("bloque-foto").hidden = false;

    clearTimeout(temporizadorBorrado);
    temporizadorBorrado = setTimeout(borrarFoto, borradoMs);
}

function guardarFoto() {
    if (!urlFoto) return;
    const enlace = document.createElement("a");
    enlace.href = urlFoto;
    enlace.download = nombreArchivo(atFoto);
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
}

function borrarFoto() {
    clearTimeout(temporizadorBorrado);
    temporizadorBorrado = null;
    if (urlFoto) {
        URL.revokeObjectURL(urlFoto);
        urlFoto = null;
    }
    atFoto = null;
    el("foto").removeAttribute("src");
    el("bloque-foto").hidden = true;
}

/* ---------------------------------------------------------- arranque */

async function arrancarComoPc() {
    intentosReconexion = 0;
    pintarEstado(false);

    try {
        codigoActual = await crearSesion();
    } catch {
        pintarEstado(false, "Sin conexión, reintentando");
        setTimeout(arrancarComoPc, 2000);
        return;
    }

    const urlEmisor = PAGINA + "?s=" + codigoActual;
    el("codigo").textContent = codigoActual;
    el("qr-url").textContent = "¿No lee el código? Escribe esta dirección en el celular: " + urlEmisor;
    dibujarQr(urlEmisor);
    conectarComoPc(codigoActual);
}

// El rol emisor se completa en el paso siguiente de la implementación.
function arrancarComoEmisor(codigo) {
    el("pantalla-pc").hidden = true;
    el("pantalla-celular").hidden = false;
    el("aviso-celular").textContent = "Sesión " + codigo;
}

function arrancar() {
    const codigo = new URLSearchParams(location.search).get("s");
    if (codigo) arrancarComoEmisor(codigo);
    else arrancarComoPc();
}

document.addEventListener("DOMContentLoaded", () => {
    el("btn-guardar").addEventListener("click", guardarFoto);
    el("btn-borrar").addEventListener("click", borrarFoto);
    arrancar();
});
