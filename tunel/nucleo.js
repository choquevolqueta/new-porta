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
