/* =====================================================================
   Túnel — la pantalla de documentos.
   El mostrador (sin `?s=`) muestra el QR y la lista de lo que llega; el
   cliente (con `?s=` y `m=documentos`) elige archivos y los manda.
   El motor vive en `nucleo.js`; acá está solo esta pantalla.
   ===================================================================== */

// El mismo tope que aplica el Worker, repetido a propósito: son dos despliegues
// distintos y no hay build que comparta el número.
var MAX_ARCHIVO_BYTES = 6 * 1024 * 1024;

var codigoActual = null;
var socketDoc = null;
var tokenDoc = null;
var clienteConectado = false;
var recibidos = new Map(); // id → { nombre, tipo, bytes, blob, url, estado, progreso, reloj }
var elegidos = [];
var seleccionado = null;
var intentosDoc = 0;
var limpiezaMs = 10 * 60 * 1000;

// Si el teléfono no puede mantener la pantalla despierta, se avisa: con la
// pantalla bloqueada, una transferencia directa se corta a la mitad.
var avisoPantalla = typeof navigator !== "undefined" && navigator.wakeLock
    ? ""
    : " (no bloquees la pantalla hasta que termine)";

/* ------------------------------------------------------------ el mostrador */

function pintarEscenarioDocs() {
    const hay = recibidos.size > 0;
    el("bloque-lista").hidden = !hay;
    el("bloque-libre-docs").hidden = hay || clienteConectado;
    el("bloque-espera-docs").hidden = hay || !clienteConectado;
    el("estado-texto").textContent = clienteConectado ? "Cliente conectado" : "Esperando conexión";
    el("estado").classList.toggle("esta-conectado", clienteConectado || hay);
}

function alMensajeMostrador(mensaje) {
    if (mensaje.type === "bienvenida") {
        tokenDoc = mensaje.token;
        return;
    }
    if (mensaje.type === "estado") {
        clienteConectado = !!mensaje.emisor;
        // Si el que mandaba se fue, lo que estaba en la cola no va a llegar
        // nunca: se marca en vez de dejarlo como fantasma.
        if (!clienteConectado) {
            for (const fila of recibidos.values()) {
                if (fila.estado === "esperando") fila.estado = "error";
            }
            pintarLista();
        }
        pintarEscenarioDocs();
        return;
    }
    if (mensaje.type === "item") {
        agregarItem(mensaje);
        return;
    }
    if (mensaje.type === "item-listo") {
        bajarItem(mensaje.id);
        return;
    }
    if (mensaje.type === "oferta") {
        prepararCanal(mensaje.sdp);
        return;
    }
    if (mensaje.type === "candidato") {
        if (pcMostrador) pcMostrador.addIceCandidate(mensaje.candidato).catch(() => {});
        return;
    }
    if (mensaje.type === "item-ok") {
        marcarItem(mensaje.id, "listo");
        return;
    }
    if (mensaje.type === "item-error") {
        marcarItem(mensaje.id, "error");
        return;
    }
    if (mensaje.type === "progreso") {
        marcarProgreso(mensaje);
    }
}

// En modo documentos el que manda es esta pantalla: los bloques de fotos se
// quedan escondidos y aparecen los suyos.
function prepararPantallaDocs() {
    el("bloque-foto").hidden = true;
    el("bloque-libre").hidden = true;
    el("bloque-espera").hidden = true;
}

async function arrancarMostrador() {
    el("pantalla-pc").hidden = false;
    el("pantalla-cliente").hidden = true;
    prepararPantallaDocs();
    pintarEscenarioDocs();
    intentosDoc = 0;

    try {
        codigoActual = await crearSesion("documentos");
    } catch {
        el("estado-texto").textContent = "Sin conexión, reintentando";
        setTimeout(arrancarMostrador, 2000);
        return;
    }

    const urlCliente = PAGINA + "?s=" + codigoActual + "&m=documentos";
    el("codigo").textContent = codigoActual;
    el("qr-url").textContent = "¿No lee el código? Escribe esta dirección en el celular: " + urlCliente;
    dibujarQr(urlCliente);
    conectarMostrador();
}

function conectarMostrador() {
    if (socketDoc) {
        socketDoc.onclose = null;
        socketDoc.close();
    }

    socketDoc = abrirSocket(codigoActual, "pc", alMensajeMostrador);
    socketDoc.onclose = () => {
        // Lo que quedó a medias no se deja como fantasma: si el que mandaba se
        // fue, esas filas no van a terminar nunca.
        for (const fila of recibidos.values()) {
            if (fila.estado !== "listo") fila.estado = "error";
        }
        pintarLista();

        el("estado").classList.remove("esta-conectado");
        el("estado-texto").textContent = "Sin conexión, reintentando";
        if (intentosDoc === 0) {
            // Un reintento con el mismo código antes de pedir uno nuevo.
            intentosDoc = 1;
            setTimeout(conectarMostrador, 1500);
            return;
        }
        arrancarMostrador();
    };
}

function agregarItem(mensaje) {
    if (recibidos.has(mensaje.id)) return;

    const fila = {
        id: mensaje.id,
        nombre: mensaje.nombre,
        tipo: mensaje.tipo,
        bytes: mensaje.bytes,
        blob: null,
        url: null,
        estado: "esperando",
        progreso: null,
        reloj: null,
    };
    fila.reloj = setTimeout(() => borrarItem(mensaje.id), limpiezaMs);
    recibidos.set(mensaje.id, fila);

    pintarLista();
    pintarEscenarioDocs();
}

async function bajarItem(id) {
    const fila = recibidos.get(id);
    if (!fila || fila.blob) return;

    fila.estado = "bajando";
    pintarLista();

    try {
        const respuesta = await fetch(API_BASE + "/bajar/" + codigoActual + "/" + id, {
            headers: { "X-Token": tokenDoc },
        });
        if (!respuesta.ok) throw new Error("sin-item");
        fila.blob = await respuesta.blob();
        fila.url = URL.createObjectURL(fila.blob);
        fila.estado = "listo";
    } catch {
        fila.estado = "error";
    }

    pintarLista();
    if (seleccionado === id) pintarVista();
}

function marcarItem(id, estado) {
    const fila = recibidos.get(id);
    if (!fila) return;
    fila.estado = estado;

    // Si los bytes vinieron por el canal, se arman acá: el aviso de "terminó"
    // llega después del último pedazo.
    const pedazos = pedazosPorItem.get(id);
    if (estado === "listo" && pedazos && pedazos.length && !fila.blob) {
        fila.blob = new Blob(pedazos, { type: fila.tipo });
        fila.url = URL.createObjectURL(fila.blob);
        pedazosPorItem.delete(id);
    }
    if (estado === "error") pedazosPorItem.delete(id);

    pintarLista();
    if (seleccionado === id) pintarVista();
}

function marcarProgreso(mensaje) {
    const fila = recibidos.get(mensaje.id);
    if (!fila) return;
    fila.progreso = mensaje.total ? Math.round((mensaje.recibidos / mensaje.total) * 100) : null;
    pintarLista();
}

function borrarItem(id) {
    const fila = recibidos.get(id);
    if (!fila) return;
    clearTimeout(fila.reloj);
    if (fila.url) URL.revokeObjectURL(fila.url);
    recibidos.delete(id);
    if (seleccionado === id) {
        seleccionado = null;
        pintarVista();
    }
    pintarLista();
    pintarEscenarioDocs();
}

function seleccionarItem(id) {
    seleccionado = id;
    pintarLista();
    pintarVista();
}

function estadoLegible(fila) {
    if (fila.estado === "listo") return "recibido";
    if (fila.estado === "error") return "se cortó";
    if (fila.estado === "bajando") return "bajando…";
    if (fila.progreso !== null) return fila.progreso + "%";
    return "esperando";
}

function pintarLista() {
    const contenedor = el("lista-recibidos");
    contenedor.textContent = ""; // se rehace entero: son pocos

    for (const fila of recibidos.values()) {
        const div = document.createElement("div");
        div.className = "tunel-fila" + (fila.id === seleccionado ? " tunel-fila-elegida" : "");

        const info = document.createElement("div");
        info.className = "tunel-fila-info";
        const nombre = document.createElement("p");
        nombre.className = "tunel-fila-nombre";
        nombre.textContent = fila.nombre; // texto, nunca HTML: el nombre lo pone el cliente
        const detalle = document.createElement("p");
        detalle.className = "tunel-fila-detalle";
        detalle.textContent = formatearBytes(fila.bytes) + " · " + estadoLegible(fila);
        info.appendChild(nombre);
        info.appendChild(detalle);

        const botones = document.createElement("div");
        botones.className = "tunel-fila-botones";

        const guardar = document.createElement("button");
        guardar.className = "tunel-btn tunel-btn-rojo";
        guardar.type = "button";
        guardar.textContent = "Guardar";
        guardar.disabled = !fila.blob;
        guardar.addEventListener("click", (evento) => {
            evento.stopPropagation();
            guardarItem(fila.id);
        });

        const borrar = document.createElement("button");
        borrar.className = "tunel-btn";
        borrar.type = "button";
        borrar.textContent = "Borrar";
        borrar.addEventListener("click", (evento) => {
            evento.stopPropagation();
            borrarItem(fila.id);
        });

        botones.appendChild(guardar);
        botones.appendChild(borrar);
        div.appendChild(info);
        div.appendChild(botones);
        div.addEventListener("click", () => seleccionarItem(fila.id));
        contenedor.appendChild(div);
    }
}

function pintarVista() {
    const caja = el("vista-item");
    caja.textContent = "";
    caja.hidden = true;

    const fila = seleccionado ? recibidos.get(seleccionado) : null;
    if (!fila || !fila.url) return;

    if ((fila.tipo || "").startsWith("image/")) {
        const imagen = document.createElement("img");
        imagen.src = fila.url;
        imagen.alt = fila.nombre;
        caja.appendChild(imagen);
    } else if (fila.tipo === "application/pdf") {
        const marco = document.createElement("iframe");
        marco.src = fila.url;
        marco.title = fila.nombre;
        caja.appendChild(marco);
    } else {
        const nota = document.createElement("p");
        nota.className = "tunel-nota";
        nota.textContent = "Este tipo no se puede mostrar acá, pero se puede guardar.";
        caja.appendChild(nota);
    }
    caja.hidden = false;
}

function guardarItem(id) {
    const fila = recibidos.get(id);
    if (!fila || !fila.blob) return;
    guardarBlob(fila.blob, fila.nombre);
}

/* -------------------------------------------------------------- el cliente */

function avisoCliente(texto) {
    el("aviso-cliente").textContent = texto ?? "";
}

// El navegador no siempre sabe el tipo de un archivo: si no lo dice, se deduce
// por la extensión, que es lo único que queda.
function tipoDeArchivo(archivo) {
    if (archivo.type) return archivo.type;
    const nombre = (archivo.name || "").toLowerCase();
    if (nombre.endsWith(".pdf")) return "application/pdf";
    if (nombre.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (nombre.endsWith(".png")) return "image/png";
    if (nombre.endsWith(".jpg") || nombre.endsWith(".jpeg")) return "image/jpeg";
    return "";
}

function elegirArchivos(lista) {
    elegidos = [...lista].map((archivo) => ({
        archivo,
        nombre: archivo.name,
        tipo: tipoDeArchivo(archivo),
        bytes: archivo.size,
    }));
    pintarElegidos();
}

function pintarElegidos() {
    const contenedor = el("lista-elegidos");
    contenedor.textContent = "";

    elegidos.forEach((item, indice) => {
        const li = document.createElement("li");
        li.className = "tunel-elegido";

        const nombre = document.createElement("span");
        nombre.textContent = item.nombre;

        const tamano = document.createElement("span");
        tamano.className = "tunel-elegido-tamano";
        tamano.textContent = formatearBytes(item.bytes);

        const quitar = document.createElement("button");
        quitar.type = "button";
        quitar.className = "tunel-elegido-quitar";
        quitar.textContent = "✕";
        quitar.setAttribute("aria-label", "Sacar " + item.nombre);
        quitar.addEventListener("click", () => {
            elegidos.splice(indice, 1);
            pintarElegidos();
        });

        li.appendChild(nombre);
        li.appendChild(tamano);
        li.appendChild(quitar);
        contenedor.appendChild(li);
    });

    el("btn-enviar").disabled = elegidos.length === 0 || !tokenDoc;
}

/* ------------------------------------------------------------------- P2P */

// El apretón de manos viaja por el WebSocket que ya existe, y los bytes van
// directo entre los dos navegadores. Si en cinco segundos no engancha, el
// archivo se manda por el respaldo del Worker: el usuario no hace nada distinto.

var pcCliente = null;
var pcMostrador = null;
var canalEntrante = null;
var canalItemId = null;
var pedazosPorItem = new Map();
var relojVigilia = null;

const STUN = { urls: "stun:stun.cloudflare.com:3478" };
const TECHO_BUFFER = 512 * 1024;

function mandarSenal(mensaje) {
    if (socketDoc && socketDoc.readyState === 1) socketDoc.send(JSON.stringify(mensaje));
}

async function mantenerDespierta() {
    try {
        if (navigator.wakeLock) relojVigilia = await navigator.wakeLock.request("screen");
    } catch {
        // En iPhone no existe: se avisa abajo.
    }
}

function soltarVigilia() {
    try {
        relojVigilia?.release();
    } catch {}
    relojVigilia = null;
}

// Devuelve true si el archivo salió entero por el canal.
async function enviarPorP2P(item) {
    return new Promise((resolver) => {
        let cerrado = false;
        const terminar = (ok) => {
            if (cerrado) return;
            cerrado = true;
            clearTimeout(relojEspera);
            resolver(ok);
        };

        const pc = new RTCPeerConnection({ iceServers: [STUN] });
        pcCliente = pc;

        const canal = pc.createDataChannel("archivo", { ordered: true });
        canal.binaryType = "arraybuffer";

        canal.onopen = async () => {
            try {
                const bytes = await item.archivo.arrayBuffer();
                canal.send(JSON.stringify({ id: item.id }));

                let enviados = 0;
                let avisado = 0;
                for (let i = 0; i < bytes.byteLength; i += TAMANO_TROZO) {
                    while (canal.bufferedAmount > TECHO_BUFFER) {
                        await new Promise((r) => setTimeout(r, 20));
                        if (canal.readyState !== "open") throw new Error("cortado");
                    }
                    const trozo = bytes.slice(i, Math.min(i + TAMANO_TROZO, bytes.byteLength));
                    canal.send(trozo);
                    enviados += trozo.byteLength;

                    const porcentaje = Math.floor((enviados / bytes.byteLength) * 100);
                    if (porcentaje >= avisado + 5) {
                        avisado = porcentaje;
                        mandarSenal({ type: "progreso", id: item.id, recibidos: enviados, total: bytes.byteLength });
                    }
                }

                mandarSenal({ type: "item-ok", id: item.id });
                try {
                    pc.close();
                } catch {}
                terminar(true);
            } catch {
                mandarSenal({ type: "item-error", id: item.id, motivo: "cortado" });
                try {
                    pc.close();
                } catch {}
                terminar(false);
            }
        };

        canal.onclose = () => {
            if (!cerrado) {
                mandarSenal({ type: "item-error", id: item.id, motivo: "cortado" });
                terminar(false);
            }
        };

        pc.onicecandidate = (evento) => {
            if (evento.candidate) mandarSenal({ type: "candidato", candidato: evento.candidate });
        };
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === "failed" || pc.connectionState === "closed") terminar(false);
        };

        const relojEspera = setTimeout(() => {
            // No enganchó: se cae al respaldo sin molestar a nadie.
            try {
                pc.close();
            } catch {}
            terminar(false);
        }, 5000);

        pc.createOffer()
            .then((oferta) => pc.setLocalDescription(oferta))
            .then(() => mandarSenal({ type: "oferta", sdp: pc.localDescription }))
            .catch(() => terminar(false));
    });
}

function alSenalCliente(mensaje) {
    if (mensaje.type === "respuesta" && pcCliente) {
        pcCliente.setRemoteDescription(mensaje.sdp).catch(() => {});
    } else if (mensaje.type === "candidato" && pcCliente) {
        pcCliente.addIceCandidate(mensaje.candidato).catch(() => {});
    }
}

// Del lado del mostrador: llega la oferta, se arma el canal y los pedazos se
// guardan hasta que el emisor avise que terminó.
function prepararCanal(oferta) {
    pcMostrador = new RTCPeerConnection({ iceServers: [STUN] });

    pcMostrador.onicecandidate = (evento) => {
        if (evento.candidate) mandarSenal({ type: "candidato", candidato: evento.candidate });
    };

    pcMostrador.ondatachannel = (evento) => {
        canalEntrante = evento.channel;
        canalEntrante.binaryType = "arraybuffer";
        canalEntrante.onmessage = (mensaje) => {
            if (typeof mensaje.data === "string") {
                try {
                    const dato = JSON.parse(mensaje.data);
                    if (dato.id) {
                        canalItemId = dato.id;
                        pedazosPorItem.set(dato.id, []);
                    }
                } catch {
                    // Un mensaje raro no puede tirar abajo la recepción.
                }
                return;
            }
            const pedazos = pedazosPorItem.get(canalItemId);
            if (pedazos) pedazos.push(mensaje.data);
        };
    };

    pcMostrador
        .setRemoteDescription(oferta)
        .then(() => pcMostrador.createAnswer())
        .then((respuesta) => pcMostrador.setLocalDescription(respuesta))
        .then(() => mandarSenal({ type: "respuesta", sdp: pcMostrador.localDescription }))
        .catch(() => {});
}

/* -------------------------------------------------------------- el envío */

async function enviarElegidos() {
    const boton = el("btn-enviar");
    boton.disabled = true;
    await mantenerDespierta();

    let enviados = 0;
    let intentados = 0;

    for (const item of elegidos) {
        // Se mira antes de empezar: si no entra, no se manda.
        if (item.bytes > MAX_ARCHIVO_BYTES) {
            avisoCliente("«" + item.nombre + "» pesa más de lo que el túnel acepta.");
            continue;
        }
        if (!item.tipo) {
            avisoCliente("«" + item.nombre + "» no es de un tipo que el túnel acepte.");
            continue;
        }

        intentados++;
        avisoCliente("Mandando «" + item.nombre + "»…" + avisoPantalla);

        // Primero el camino directo. Si no engancha, el respaldo.
        item.id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())).slice(0, 16);
        mandarSenal({ type: "item", id: item.id, nombre: item.nombre, tipo: item.tipo, bytes: item.bytes });

        let salio = false;
        try {
            salio = await enviarPorP2P(item);
        } catch {
            salio = false;
        }

        if (salio) {
            enviados++;
            continue;
        }

        avisoCliente("Mandando «" + item.nombre + "» por el respaldo…");
        try {
            const respuesta = await fetch(API_BASE + "/subir/" + codigoActual, {
                method: "POST",
                headers: {
                    "Content-Type": item.tipo,
                    "X-Token": tokenDoc,
                    "X-Nombre": encodeURIComponent(item.nombre),
                    // El mismo id que se avisó por el WebSocket: así el mostrador
                    // no termina con dos filas para un solo archivo.
                    "X-Id": item.id,
                },
                body: item.archivo,
            });

            if (respuesta.ok) {
                enviados++;
            } else if (respuesta.status === 413) {
                avisoCliente("«" + item.nombre + "» pesa más de lo que el túnel acepta.");
            } else if (respuesta.status === 415) {
                avisoCliente("«" + item.nombre + "» no es de un tipo que el túnel acepte.");
            } else {
                avisoCliente("No se pudo mandar «" + item.nombre + "». Probá otra vez.");
            }
        } catch {
            avisoCliente("No se pudo mandar «" + item.nombre + "». Probá otra vez.");
        }
    }

    soltarVigilia();

    if (intentados > 0 && enviados === intentados) {
        avisoCliente(
            "Listo: " + enviados + (enviados === 1 ? " archivo ya está" : " archivos ya están") +
            " en la computadora."
        );
        elegidos = [];
        pintarElegidos();
        return;
    }
    if (intentados === 0) boton.disabled = false;
}

function arrancarCliente(codigo) {
    el("pantalla-pc").hidden = true;
    el("pantalla-cliente").hidden = false;
    codigoActual = codigo;
    avisoCliente("Elegí los archivos y tocá Enviar.");

    socketDoc = abrirSocket(codigo, "emisor", (mensaje) => {
        if (mensaje.type === "bienvenida") {
            tokenDoc = mensaje.token;
            pintarElegidos();
            return;
        }
        alSenalCliente(mensaje);
    });

    socketDoc.onclose = (evento) => {
        el("btn-elegir").disabled = true;
        el("btn-enviar").disabled = true;
        avisoCliente(
            evento.code === 4001
                ? "Esta sesión ya tiene un cliente conectado. Pedile a la computadora un código nuevo."
                : "La computadora se desconectó. Volvé a escanear el código."
        );
    };
}

/* -------------------------------------------------------------- arranque */

function arrancarDocumentos() {
    el("btn-elegir").addEventListener("click", () => el("input-archivos").click());
    el("input-archivos").addEventListener("change", (evento) => elegirArchivos(evento.target.files));
    el("btn-enviar").addEventListener("click", enviarElegidos);

    const codigo = new URLSearchParams(location.search).get("s");
    if (codigo) arrancarCliente(codigo);
    else arrancarMostrador();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", arrancarDocumentos);
} else {
    arrancarDocumentos();
}
