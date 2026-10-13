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

// El mismo tope que aplica el Worker. Está repetido a propósito: son dos
// despliegues distintos y no hay build que comparta el número.
var MAX_JPEG_BYTES = 600 * 1024;

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

/* ------------------------------------------------- el celular emisor */

var streamCamara = null;
var socketEmisor = null;

function avisoCelular(texto) {
    el("aviso-celular").textContent = texto ?? "";
}

function conectarComoEmisor(codigo) {
    const ws = new WebSocket(API_BASE.replace(/^http/, "ws") + "/ws/" + codigo + "?rol=emisor");
    socketEmisor = ws;

    ws.onclose = (evento) => {
        el("btn-disparar").disabled = true;
        if (evento.code === 4001) {
            avisoCelular("Esta sesión ya tiene un celular conectado. Pedile a la PC un código nuevo.");
            return;
        }
        // Cualquier otro cierre significa que la PC no está del otro lado.
        avisoCelular("La PC se desconectó. Volvé a escanear el código.");
    };
}

function mensajeDeCamara(error) {
    if (error && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
        return "El navegador no tiene permiso para la cámara. En Chrome: tocá el candado de la barra de direcciones → Permisos → Cámara → Permitir, y recargá.";
    }
    if (error && error.name === "NotFoundError") {
        return "Este dispositivo no tiene ninguna cámara disponible.";
    }
    return "No se pudo abrir la cámara. Cerrá otras apps que la estén usando e intentá otra vez.";
}

async function activarCamara() {
    el("btn-activar-camara").disabled = true;
    try {
        streamCamara = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    } catch (error) {
        el("btn-activar-camara").disabled = false;
        avisoCelular(mensajeDeCamara(error));
        return;
    }
    el("video").srcObject = streamCamara;
    el("btn-activar-camara").hidden = true;
    el("btn-disparar").hidden = false;
    avisoCelular("Tocá el botón rojo para tomar la foto.");
}

// El cuadro se copia con el lado mayor en 1600 px, que para una foto de trabajo
// sobra, y se exporta en JPEG bajando la calidad solo si hace falta.
async function comprimir(calidad) {
    const video = el("video");
    if (!video.videoWidth || !video.videoHeight) return null;

    const escala = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
    const lona = document.createElement("canvas");
    lona.width = Math.round(video.videoWidth * escala);
    lona.height = Math.round(video.videoHeight * escala);
    lona.getContext("2d").drawImage(video, 0, 0, lona.width, lona.height);

    return await new Promise((resolver) => lona.toBlob(resolver, "image/jpeg", calidad));
}

async function disparar() {
    const boton = el("btn-disparar");
    boton.disabled = true;
    avisoCelular("Subiendo la foto…");

    try {
        let foto = await comprimir(0.8);
        for (const calidad of [0.6, 0.4]) {
            if (foto && foto.size <= MAX_JPEG_BYTES) break;
            foto = await comprimir(calidad);
        }

        if (!foto) {
            avisoCelular("La cámara todavía no está lista. Esperá un segundo e intentá otra vez.");
            return;
        }
        if (foto.size > MAX_JPEG_BYTES) {
            avisoCelular("La foto quedó demasiado grande para el túnel. Probá otra vez.");
            return;
        }

        const respuesta = await fetch(
            API_BASE + "/upload/" + codigoActual + "?at=" + new Date().toISOString(),
            { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: foto }
        );

        if (respuesta.ok) {
            avisoCelular("Listo, la foto ya está en la PC. Podés tomar otra.");
        } else if (respuesta.status === 413) {
            avisoCelular("La foto pesa más de lo que el túnel acepta. Probá otra vez.");
        } else if (respuesta.status === 409 || respuesta.status === 404) {
            avisoCelular("La sesión ya no está disponible. Volvé a escanear el código de la PC.");
        } else {
            avisoCelular("No se pudo subir la foto. Intentá otra vez.");
        }
    } catch {
        avisoCelular("No se pudo subir la foto. Intentá otra vez.");
    } finally {
        boton.disabled = false;
    }
}

function arrancarComoEmisor(codigo) {
    codigoActual = codigo;
    el("pantalla-pc").hidden = true;
    el("pantalla-celular").hidden = false;
    avisoCelular("Activá la cámara y tomá la foto: aparece en la pantalla de la PC.");
    conectarComoEmisor(codigo);
}

function arrancar() {
    const codigo = new URLSearchParams(location.search).get("s");
    if (codigo) arrancarComoEmisor(codigo);
    else arrancarComoPc();
}

document.addEventListener("DOMContentLoaded", () => {
    el("btn-guardar").addEventListener("click", guardarFoto);
    el("btn-borrar").addEventListener("click", borrarFoto);
    el("btn-activar-camara").addEventListener("click", activarCamara);
    el("btn-disparar").addEventListener("click", disparar);
    arrancar();
});
