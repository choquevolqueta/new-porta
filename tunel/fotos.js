/* =====================================================================
   Túnel de fotos — la pantalla.
   Una sola página con dos roles, decididos por la URL y no por el
   user-agent: sin `?s=` es la PC que escucha, con `?s=` es el celular
   que saca la foto y la manda.
   El motor (sesión, QR, nombres, descarga) vive en `nucleo.js`.
   ===================================================================== */

// Se puede bajar desde la consola para no esperar 10 minutos en una prueba.
var borradoMs = 10 * 60 * 1000;

// El mismo tope que aplica el Worker. Está repetido a propósito: son dos
// despliegues distintos y no hay build que comparta el número.
var MAX_JPEG_BYTES = 600 * 1024;

var codigoActual = null;
var socketPc = null;
var intentosReconexion = 0;
var urlFoto = null;
var blobFoto = null;
var atFoto = null;
var temporizadorBorrado = null;
var emisorConectado = false;
var textoDeEstado = null;

/* ---------------------------------------------------- la pantalla de la PC */

// La PC muestra una sola cosa por vez, siempre al lado del QR: así el
// procedimiento entero entra en la pantalla y nadie tiene que scrollear.
// El chip de arriba dice el estado real, no el que estaba antes.
function pintarEscenario() {
    const hayFoto = urlFoto !== null;
    el("bloque-foto").hidden = !hayFoto;
    el("bloque-espera").hidden = hayFoto || !emisorConectado;
    el("bloque-libre").hidden = hayFoto || emisorConectado;

    el("estado-texto").textContent = textoDeEstado ?? (
        hayFoto ? "Foto recibida" : emisorConectado ? "Celular conectado" : "Esperando conexión"
    );
    el("estado").classList.toggle("esta-conectado", emisorConectado || hayFoto);
}

// El texto excepcional ("sin conexión, reintentando") dura hasta el próximo
// aviso del servidor.
function pintarEstado(conectado, texto) {
    emisorConectado = !!conectado;
    textoDeEstado = texto ?? null;
    pintarEscenario();
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
    blobFoto = blob;
    urlFoto = URL.createObjectURL(blob);
    atFoto = mensaje.at ?? null;

    el("foto").src = urlFoto;
    el("foto-hora").textContent = horaDe(atFoto);
    el("foto-detalle").textContent =
        "Recibida a las " + horaDe(atFoto) + ". Se borra sola en 10 minutos si no la guardás.";
    pintarEscenario();

    clearTimeout(temporizadorBorrado);
    temporizadorBorrado = setTimeout(borrarFoto, borradoMs);
}

function guardarFoto() {
    if (!blobFoto) return;
    guardarBlob(blobFoto, nombreArchivo(atFoto));
}

function borrarFoto() {
    clearTimeout(temporizadorBorrado);
    temporizadorBorrado = null;
    if (urlFoto) {
        URL.revokeObjectURL(urlFoto);
        urlFoto = null;
    }
    atFoto = null;
    blobFoto = null;
    el("foto").removeAttribute("src");
    el("foto-detalle").textContent = "";
    pintarEscenario();
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
var tokenEmisor = null;

// Zoom: se usa el del dispositivo si sabe hacerlo, y si no, se recorta el
// centro del cuadro (que funciona en cualquier teléfono, perdiendo resolución).
// El control es un slider: con el rango real del teléfono, que llega a 10×, unos
// pocos pasos fijos saltan de 1× a 3× de un toque.
var ZOOM_DIGITAL_MIN = 1;
var ZOOM_DIGITAL_MAX = 3;
var pistaCamara = null;
var zoomInfo = { min: 1, max: 3, paso: 0.1 };
var zoomActual = 1;
var modoZoom = "digital";
var zoomDigital = 1;
var linternaPrendida = false;
var relojZoom = null;

function avisoCelular(texto) {
    el("aviso-celular").textContent = texto ?? "";
}

function conectarComoEmisor(codigo) {
    const ws = new WebSocket(API_BASE.replace(/^http/, "ws") + "/ws/" + codigo + "?rol=emisor");
    socketEmisor = ws;

    // El token que la PC espera con cada foto: sin él, cualquiera con el código
    // podría meterle una imagen, y un celular rechazado también.
    ws.onmessage = (evento) => {
        let mensaje;
        try {
            mensaje = JSON.parse(evento.data);
        } catch {
            return;
        }
        if (mensaje.type === "bienvenida") tokenEmisor = mensaje.token;
    };

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
    el("video").addEventListener("loadedmetadata", () => {
        const video = el("video");
        // El recuadro toma la forma real de la cámara: así lo que ves es lo que
        // sale, sin recortes escondidos.
        if (video.videoWidth && video.videoHeight) {
            el("preview").style.aspectRatio = video.videoWidth + " / " + video.videoHeight;
        }
    }, { once: true });

    el("btn-activar-camara").hidden = true;
    el("btn-disparar").hidden = false;
    prepararControles();
    pintarLinterna();
    avisoCelular("Tocá el botón rojo para tomar la foto.");
}

// Zoom por recorte: el centro del cuadro, dividido por el factor. Es lo que
// hace que el zoom funcione en cualquier teléfono, aunque el dispositivo no
// sepa hacer zoom por su cuenta.
function recorteCentrado(anchoVideo, altoVideo, factor) {
    const ancho = anchoVideo / factor;
    const alto = altoVideo / factor;
    return { x: (anchoVideo - ancho) / 2, y: (altoVideo - alto) / 2, ancho, alto };
}

function formatearZoom(valor) {
    return (Number.isInteger(valor) ? valor : valor.toFixed(1)) + "×";
}

function prepararControles() {
    const pista = streamCamara ? streamCamara.getVideoTracks()[0] : null;
    const capacidades = (pista && pista.getCapabilities && pista.getCapabilities()) || {};
    const zoom = capacidades.zoom;
    pistaCamara = pista;

    if (zoom && zoom.max > zoom.min) {
        // El teléfono sabe hacer zoom: mejor, porque no se pierde nada.
        modoZoom = "nativo";
        zoomInfo = { min: zoom.min, max: zoom.max, paso: zoom.step || 0.1 };
    } else {
        modoZoom = "digital";
        zoomInfo = { min: ZOOM_DIGITAL_MIN, max: ZOOM_DIGITAL_MAX, paso: 0.1 };
    }

    const barra = el("zoom-barra");
    barra.min = zoomInfo.min;
    barra.max = zoomInfo.max;
    barra.step = zoomInfo.paso;
    barra.value = zoomInfo.min;

    zoomActual = zoomInfo.min;
    zoomDigital = 1;

    el("zoom-controles").hidden = false;
    // La linterna es otra capacidad del mismo track: si el teléfono no la
    // expone, el botón no existe (en iPhone, por ejemplo, no existe).
    el("btn-linterna").hidden = !(pista && capacidades.torch);
    aplicarZoom(true);
}

function setZoom(valor) {
    const acotado = Math.min(zoomInfo.max, Math.max(zoomInfo.min, valor));
    zoomActual = acotado;
    el("zoom-barra").value = acotado;
    aplicarZoom();
}

function moverZoom(paso) {
    const salto = Math.max(zoomInfo.paso, (zoomInfo.max - zoomInfo.min) / 20);
    setZoom(zoomActual + paso * salto);
}

function aplicarZoom(primeraVez) {
    if (modoZoom === "nativo") {
        // El slider dispara decenas de cambios por segundo: se manda el último.
        clearTimeout(relojZoom);
        relojZoom = setTimeout(() => {
            pistaCamara.applyConstraints({ advanced: [{ zoom: zoomActual }] }).catch(() => {
                // Dijo que sabía y no aceptó: se cae al recorte, que siempre anda.
                modoZoom = "digital";
                zoomInfo = { min: ZOOM_DIGITAL_MIN, max: ZOOM_DIGITAL_MAX, paso: 0.1 };
                zoomActual = ZOOM_DIGITAL_MIN;
                const barra = el("zoom-barra");
                barra.min = zoomInfo.min;
                barra.max = zoomInfo.max;
                barra.step = zoomInfo.paso;
                barra.value = zoomActual;
                aplicarZoom(true);
            });
        }, primeraVez ? 0 : 60);
    } else {
        zoomDigital = zoomActual;
        // La previa se agranda igual que el recorte: lo que ves es lo que sale.
        el("video").style.transform = zoomDigital > 1 ? "scale(" + zoomDigital + ")" : "";
    }

    el("zoom-valor").textContent = formatearZoom(zoomActual);
    el("btn-zoom-menos").disabled = zoomActual <= zoomInfo.min + zoomInfo.paso / 2;
    el("btn-zoom-mas").disabled = zoomActual >= zoomInfo.max - zoomInfo.paso / 2;
}

async function alternarLinterna() {
    if (!pistaCamara) return;
    linternaPrendida = !linternaPrendida;
    try {
        await pistaCamara.applyConstraints({ advanced: [{ torch: linternaPrendida }] });
    } catch {
        linternaPrendida = false;
        avisoCelular("Este teléfono no deja encender la linterna desde la página.");
    }
    pintarLinterna();
}

function pintarLinterna() {
    el("btn-linterna").textContent = linternaPrendida ? "Linterna encendida" : "Linterna";
    el("btn-linterna").classList.toggle("tunel-linterna-prendida", linternaPrendida);
}

// El cuadro se copia con el lado mayor en 1600 px, que para una foto de trabajo
// sobra, y se exporta en JPEG bajando la calidad solo si hace falta.
async function comprimir(calidad) {
    const video = el("video");
    if (!video.videoWidth || !video.videoHeight) return null;

    const factor = modoZoom === "digital" ? zoomDigital : 1;
    const corte = recorteCentrado(video.videoWidth, video.videoHeight, factor);
    const escala = Math.min(1, 1600 / Math.max(corte.ancho, corte.alto));

    const lona = document.createElement("canvas");
    lona.width = Math.round(corte.ancho * escala);
    lona.height = Math.round(corte.alto * escala);
    lona.getContext("2d").drawImage(
        video,
        corte.x, corte.y, corte.ancho, corte.alto,
        0, 0, lona.width, lona.height
    );

    return await new Promise((resolver) => lona.toBlob(resolver, "image/jpeg", calidad));
}

async function disparar() {
    const boton = el("btn-disparar");
    boton.disabled = true;
    avisoCelular("Subiendo la foto…");

    try {
        if (!tokenEmisor) {
            avisoCelular("Todavía se está emparejando con la PC. Esperá un segundo e intentá otra vez.");
            return;
        }

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
            {
                method: "POST",
                headers: { "Content-Type": "image/jpeg", "X-Token": tokenEmisor },
                body: foto,
            }
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
    // En modo documentos manda la otra pantalla: esta queda quieta.
    if (MODO === "documentos") return;
    const codigo = new URLSearchParams(location.search).get("s");
    if (codigo) arrancarComoEmisor(codigo);
    else arrancarComoPc();
}

document.addEventListener("DOMContentLoaded", () => {
    el("btn-guardar").addEventListener("click", guardarFoto);
    el("btn-borrar").addEventListener("click", borrarFoto);
    el("btn-activar-camara").addEventListener("click", activarCamara);
    el("btn-disparar").addEventListener("click", disparar);
    el("btn-zoom-menos").addEventListener("click", () => moverZoom(-1));
    el("btn-zoom-mas").addEventListener("click", () => moverZoom(1));
    el("zoom-barra").addEventListener("input", () => setZoom(Number(el("zoom-barra").value)));
    el("btn-linterna").addEventListener("click", alternarLinterna);

    // Última red: si lo que llegó no se puede mostrar, no se deja un cuadro
    // roto con botón de guardar. (El Worker ya filtra por los dos primeros
    // bytes, así que esto es para lo imprevisible.)
    el("foto").addEventListener("error", () => {
        if (!urlFoto) return;
        borrarFoto();
        textoDeEstado = "Llegó algo que no se pudo mostrar";
        pintarEscenario();
    });

    arrancar();
});
