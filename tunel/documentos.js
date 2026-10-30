/* =====================================================================
   Túnel — la pantalla de documentos.
   El mostrador (sin `?s=`) muestra el QR y la lista de lo que llega; el
   cliente (con `?s=` y `m=documentos`) elige archivos y los manda.
   El motor vive en `nucleo.js`; acá está solo esta pantalla.
   ===================================================================== */

// El mismo tope que aplica el Worker, repetido a propósito: son dos despliegues
// distintos y no hay build que comparta el número.
var MAX_ARCHIVO_BYTES = 50 * 1024 * 1024;

// Cuántos archivos por sesión. El Worker corta en 20 y el mostrador también: si
// acá se dejaran elegir 30, la mitad se caería sola y sin explicación.
var MAX_ELEGIDOS = 20;

var codigoActual = null;
var socketDoc = null;
var tokenDoc = null;
var clienteConectado = false;
var recibidos = new Map(); // id → { nombre, tipo, bytes, pieza, piezas, blob, url, estado, … }
// El frame binario que sigue a un aviso `pieza` es la pieza anunciada. Hay uno
// por transporte: el WebSocket y el canal de datos pueden cruzarse.
var piezaPorWs = null;
var piezaPorCanal = null;
// El archivo que se está mandando, para poder retomarlo si se corta.
var enCurso = null;
// Lo que se recibió en la sesión: vive en la memoria del navegador.
var bytesEnSesion = 0;
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
    el("bloque-libre-docs").hidden = dormida || hay || clienteConectado;
    el("bloque-espera-docs").hidden = dormida || hay || !clienteConectado;
    el("estado-texto").textContent = dormida ? "Sesión terminada" : (
        clienteConectado ? "Cliente conectado" : "Esperando conexión"
    );
    el("estado").classList.toggle("esta-conectado", !dormida && (clienteConectado || hay));
}

function alMensajeMostrador(mensaje) {
    if (mensaje.type === "bienvenida") {
        tokenDoc = mensaje.token;
        return;
    }
    if (mensaje.type === "estado") {
        clienteConectado = !!mensaje.emisor;
        // Si el que mandaba se fue, la fila NO se da por perdida: las piezas que
        // llegaron sirven para retomar, y el vigilante de 45 s es el que decide.
        if (!clienteConectado) {
            for (const fila of recibidos.values()) {
                if (fila.estado === "esperando") fila.ultimoMovimiento = Date.now();
            }
        }
        pintarEscenarioDocs();
        return;
    }
    if (mensaje.type === "pidofalta") {
        const fila = recibidos.get(mensaje.id);
        if (!fila) return;
        const cantidad = piezasDe(fila.bytes, fila.pieza).cantidad;
        const falta = primeraFaltante(new Set(fila.piezas.keys()), cantidad);
        mandarSenal({
            type: "falta",
            id: mensaje.id,
            desde: Math.min(falta * fila.pieza, fila.bytes),
        });
        return;
    }
    if (mensaje.type === "item") {
        agregarItem(mensaje);
        return;
    }
    if (mensaje.type === "pieza") {
        // La cabecera dice qué pieza es; el frame binario que viene atrás trae
        // los bytes. Van en orden, así que alcanza con recordar la última.
        piezaPorWs = { id: mensaje.id, indice: mensaje.indice };
        return;
    }
    if (mensaje.type === "fin") {
        cerrarItem(mensaje.id);
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

    // El texto del mostrador no puede hablar de fotos cuando el que está delante
    // es un cliente.
    el("titulo-pc").textContent = "Recibí lo que te mande el cliente";
    document.title = "Túnel · documentos";
    el("rotulo").textContent = "Túnel · documentos";
}

async function arrancarMostrador() {
    el("pantalla-pc").hidden = false;
    el("pantalla-cliente").hidden = true;
    mostrarQrVivo();
    prepararPantallaDocs();
    pintarEscenarioDocs();
    intentosDoc = 0;

    const almacen = almacenDeSesion();
    const recordada = leerSesionGuardada(almacen, Date.now(), VIDA_SESION_MS, "documentos");

    // Recarga con la sesión todavía viva: se reusa el código en vez de crear
    // otro Durable Object (cada sesión cuesta duración aunque no mueva bytes).
    if (recordada) {
        codigoActual = recordada;
        mostrarCodigoDocs();
        conectarMostrador();
        return;
    }

    try {
        codigoActual = await crearSesion("documentos");
    } catch {
        el("estado-texto").textContent = "Sin conexión, reintentando";
        setTimeout(arrancarMostrador, 2000);
        return;
    }

    guardarSesion(almacen, codigoActual, Date.now(), "documentos");
    mostrarCodigoDocs();
    conectarMostrador();
}

function mostrarCodigoDocs() {
    const urlCliente = PAGINA + "?s=" + codigoActual + "&m=documentos";
    el("codigo").textContent = codigoActual;
    el("qr-url").textContent = "¿No lee el código? Escribe esta dirección en el celular: " + urlCliente;
    dibujarQr(urlCliente);
}

function conectarMostrador() {
    if (socketDoc) {
        socketDoc.onclose = null;
        socketDoc.close();
    }

    socketDoc = abrirSocket(codigoActual, "pc", (mensaje) => {
        // La sesión guardada envejece con la actividad, igual que el TTL del
        // servidor: así una recarga durante una transferencia no la pierde.
        tocarSesionGuardada(almacenDeSesion(), Date.now());
        alMensajeMostrador(mensaje);
    }, (bytes) => {
        // El binario pertenece a la última pieza anunciada por el WebSocket.
        if (!piezaPorWs) return;
        const { id, indice } = piezaPorWs;
        piezaPorWs = null;
        agregarPieza(id, indice, new Uint8Array(bytes));
    });
    socketDoc.onclose = (evento) => {
        // Lo que quedó a medias no se deja como fantasma: si el que mandaba se
        // fue, esas filas no van a terminar nunca.
        for (const fila of recibidos.values()) {
            if (fila.estado !== "listo") fila.estado = "error";
        }
        pintarLista();

        el("estado").classList.remove("esta-conectado");

        if (decidirCierre(evento.code, intentosDoc, 1) === "dormir") {
            dormirSesionDocs();
            return;
        }

        intentosDoc = 1;
        el("estado-texto").textContent = "Sin conexión, reintentando";
        setTimeout(conectarMostrador, 1500);
    };
}

function dormirSesionDocs() {
    intentosDoc = 0;
    clienteConectado = false;
    if (socketDoc) {
        socketDoc.onclose = null;
        socketDoc.close();
        socketDoc = null;
    }
    olvidarSesion(almacenDeSesion());
    mostrarDormida();
    pintarEscenarioDocs();
}

function agregarItem(mensaje) {
    if (recibidos.has(mensaje.id)) return;

    // La PC no cree los números del anuncio: con un `bytes` inventado, la lista
    // se puede colgar armando millones de piezas.
    const bytes = Number(mensaje.bytes);
    if (!Number.isFinite(bytes) || bytes <= 0 || bytes > MAX_ARCHIVO_BYTES) {
        avisoMostrador("Se rechazó un archivo fuera de lo permitido.");
        return;
    }
    if (recibidos.size >= 20) {
        avisoMostrador("Se rechazó un archivo fuera de lo permitido.");
        return;
    }

    const fila = {
        id: mensaje.id,
        nombre: mensaje.nombre,
        tipo: mensaje.tipo,
        bytes,
        pieza: PIEZA_BYTES,
        piezas: new Map(),
        bytesRecibidos: 0,
        blob: null,
        url: null,
        estado: "esperando",
        progreso: null,
        creadoEn: Date.now(),
        ultimoMovimiento: Date.now(),
        reloj: null,
    };
    fila.reloj = setTimeout(() => borrarItem(mensaje.id), limpiezaMs);
    recibidos.set(mensaje.id, fila);

    pintarLista();
    pintarEscenarioDocs();
}

// Guarda una pieza y mueve el progreso. Las piezas pueden llegar salteadas (una
// reanudación empieza donde quedó); el índice es lo que las ordena.
function agregarPieza(id, indice, bytes, confirmar) {
    const fila = recibidos.get(id);
    if (!fila || fila.estado === "listo") return;

    // Una pieza fuera de rango o de largo distinto al anunciado no se guarda: el
    // índice y el tamaño los fija el anuncio, no el que manda.
    const cantidad = piezasDe(fila.bytes, fila.pieza).cantidad;
    if (!Number.isInteger(indice) || indice < 0 || indice >= cantidad) return;
    const esperado = Math.min(fila.pieza, fila.bytes - indice * fila.pieza);
    if (bytes.length !== esperado) return;

    // Si la pieza ya estaba (un reintento la vuelve a mandar), no se cuenta dos
    // veces: el progreso y el total se miden por índice.
    if (!fila.piezas.has(indice)) fila.bytesRecibidos += bytes.length;
    fila.piezas.set(indice, bytes);
    fila.ultimoMovimiento = Date.now();
    fila.progreso = fila.bytes
        ? Math.min(99, Math.round((fila.bytesRecibidos / fila.bytes) * 100))
        : null;
    if (fila.estado === "error") fila.estado = "esperando";

    // La confirmación abre la ventana del que manda: sin esto, la transferencia
    // se queda esperando y corta a los 20 segundos. Por el respaldo vuelve por
    // el WebSocket; por el canal de datos, por el mismo canal.
    const avisar = confirmar || ((idPieza, indicePieza) => {
        mandarSenal({ type: "confirmo", id: idPieza, indice: indicePieza });
    });
    avisar(id, indice);

    pintarLista();
}

// El archivo está cuando están todas las piezas y el total coincide. Si no, la
// fila no puede decir "recibido".
function cerrarItem(id) {
    const fila = recibidos.get(id);
    if (!fila) return false;
    if (fila.estado === "listo") return true;

    const cantidad = piezasDe(fila.bytes, fila.pieza).cantidad;
    const faltan = primeraFaltante(new Set(fila.piezas.keys()), cantidad);
    let total = 0;
    for (const bytes of fila.piezas.values()) total += bytes.length;

    if (faltan !== cantidad || total !== fila.bytes) {
        fila.estado = "error";
        avisoMostrador("Un archivo llegó incompleto: «" + fila.nombre + "».");
        pintarLista();
        if (seleccionado === id) pintarVista();
        return false;
    }

    {
        const partes = [];
        for (let i = 0; i < cantidad; i++) partes.push(fila.piezas.get(i));
        fila.blob = new Blob(partes, { type: fila.tipo });
        fila.url = URL.createObjectURL(fila.blob);
        fila.estado = "listo";
        fila.progreso = 100;
        fila.piezas.clear();

        // Los 10 minutos para guardarlo corren desde que llegó, no desde el aviso.
        clearTimeout(fila.reloj);
        fila.reloj = setTimeout(() => borrarItem(id), limpiezaMs);

        bytesEnSesion += fila.bytes;
        if (!cerrarItem.avisado && bytesEnSesion > 200 * 1024 * 1024) {
            cerrarItem.avisado = true;
            avisoMostrador("Ya hay más de 200 MB en la lista: guardá lo que necesites y borrá el resto.");
        }
    }

    pintarLista();
    if (seleccionado === id) pintarVista();
    pintarEscenarioDocs();
    return true;
}

function marcarItem(id, estado) {
    const fila = recibidos.get(id);
    if (!fila) return;
    if (fila.estado === "listo" && estado !== "listo") return;
    fila.estado = estado;
    pintarLista();
    if (seleccionado === id) pintarVista();
}

function avisoMostrador(texto) {
    el("aviso-mostrador").textContent = texto ?? "";
    clearTimeout(avisoMostrador.reloj);
    avisoMostrador.reloj = setTimeout(() => {
        el("aviso-mostrador").textContent = "";
    }, 6000);
}

function marcarProgreso(mensaje) {
    const fila = recibidos.get(mensaje.id);
    if (!fila) return;
    fila.ultimoMovimiento = Date.now();
    fila.progreso = mensaje.total ? Math.round((mensaje.recibidos / mensaje.total) * 100) : null;
    pintarLista();
}

// Cada tanto se mira si algo quedó parado: un celular que se duerme o pierde
// señal no avisa, y la fila no puede quedarse en un porcentaje para siempre.
setInterval(() => {
    const ahora = Date.now();
    let cambio = false;
    for (const fila of recibidos.values()) {
        if (fila.estado === "listo" || fila.estado === "error") continue;
        if (ahora - fila.ultimoMovimiento > 45000) {
            fila.estado = "error";
            cambio = true;
        }
    }
    if (cambio) {
        pintarLista();
        avisoMostrador("Algo se quedó a medias: probá que el cliente lo mande otra vez.");
    }
}, 5000);

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

// El aviso de que no se puede mostrar algo en pantalla, pero sí guardar.
function notaSinVisor(caja) {
    const nota = document.createElement("p");
    nota.className = "tunel-nota";
    nota.textContent = "Este tipo no se puede mostrar acá, pero se puede guardar.";
    caja.appendChild(nota);
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
    } else if ((fila.tipo || "").startsWith("video/")) {
        // Un .mov HEVC de iPhone no lo decodifica Chrome ni Windows: si el
        // navegador dice que no puede, se avisa en vez de dejar un reproductor
        // negro. El archivo se guarda igual.
        const prueba = document.createElement("video");
        if (!prueba.canPlayType(fila.tipo)) {
            notaSinVisor(caja);
        } else {
            const video = document.createElement("video");
            video.controls = true;
            video.src = fila.url;
            video.addEventListener("error", () => {
                caja.textContent = "";
                notaSinVisor(caja);
            });
            caja.appendChild(video);
        }
    } else {
        notaSinVisor(caja);
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

// Cada vuelta del selector suma a lo que ya había: en el celular las cosas están
// repartidas —una foto en la cámara, un PDF en descargas— y elegir de nuevo no
// puede borrar la elección anterior.
function elegirArchivos(lista) {
    const nuevos = [...lista].map((archivo) => ({
        archivo,
        nombre: archivo.name,
        ultimo: archivo.lastModified,
        tipo: tipoDeArchivo(archivo),
        bytes: archivo.size,
    }));

    const suma = sumarElegidos(elegidos, nuevos, MAX_ELEGIDOS);
    elegidos = suma.lista;

    if (suma.sobrantes) {
        avisoCliente(
            "El túnel acepta hasta " + MAX_ELEGIDOS + " archivos por vez: " +
            suma.sobrantes + (suma.sobrantes === 1 ? " quedó afuera." : " quedaron afuera.")
        );
    } else if (suma.repetidos && !suma.agregados) {
        avisoCliente("Ese archivo ya estaba en la lista.");
    } else {
        avisoCliente(
            "En la lista hay " + elegidos.length +
            (elegidos.length === 1 ? " archivo" : " archivos") +
            ". Tocá Enviar cuando estén todos."
        );
    }

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
    // El botón dice lo que hace: mientras haya algo en la lista, suma.
    el("btn-elegir").textContent = elegidos.length ? "Agregar más archivos" : "Elegir archivos";
}

/* ------------------------------------------------------------------- P2P */

// El apretón de manos viaja por el WebSocket que ya existe, y los bytes van
// directo entre los dos navegadores. Si en cinco segundos no engancha, el
// archivo se manda por el respaldo del Worker: el usuario no hace nada distinto.

var pcCliente = null;
var pcMostrador = null;
var canalEntrante = null;
var relojVigilia = null;

const STUN = { urls: "stun:stun.cloudflare.com:3478" };

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
        let relojConfirmo = null;

        const terminar = (ok) => {
            if (cerrado) return;
            cerrado = true;
            clearTimeout(relojEspera);
            clearTimeout(relojConfirmo);
            resolver(ok);
        };

        const pc = new RTCPeerConnection({ iceServers: [STUN] });
        pcCliente = pc;

        const canal = pc.createDataChannel("archivo", { ordered: true });
        canal.binaryType = "arraybuffer";

        // La ventana: no se adelanta más de VENTANA_PIEZAS sobre lo que la PC
        // confirmó. Es lo que evita llenar la memoria del otro lado.
        let confirmadas = 0;
        let despertar = null;
        let recibido = null;
        let recibidoOk = false;

        const esperarVentana = (indice) => {
            if (indice - confirmadas < VENTANA_PIEZAS) return Promise.resolve();
            return new Promise((resolverVentana, rechazar) => {
                relojConfirmo = setTimeout(() => rechazar(new Error("sin-confirmacion")), 20000);
                despertar = () => {
                    clearTimeout(relojConfirmo);
                    resolverVentana();
                };
            }).then(() => esperarVentana(indice));
        };

        canal.onmessage = (evento) => {
            let dato;
            try {
                dato = JSON.parse(evento.data);
            } catch {
                return;
            }
            if (!dato) return;
            if (Number.isFinite(dato.indice)) {
                confirmadas = Math.max(confirmadas, dato.indice + 1);
                despertar?.();
                despertar = null;
                return;
            }
            if (dato.recibido === item.id) {
                // La PC dice si la fila quedó completa: si no, el envío no salió
                // bien y hay que caer al respaldo, no cantar "listo".
                recibidoOk = dato.ok !== false;
                recibido?.();
            }
        };

        canal.onopen = async () => {
            // El reloj de los 5 segundos era "no enganchó": una vez abierto el
            // canal, ya no tiene por qué cortar nada.
            clearTimeout(relojEspera);
            try {
                const bytes = await item.archivo.arrayBuffer();
                const cantidad = piezasDe(bytes.byteLength, PIEZA_BYTES).cantidad;
                let avisado = 0;

                for (let indice = 0; indice < cantidad; indice++) {
                    await esperarVentana(indice);
                    if (canal.readyState !== "open") throw new Error("cortado");

                    const { desde, hasta } = tramoDe(indice, PIEZA_BYTES, bytes.byteLength);
                    const trozo = bytes.slice(desde, hasta);
                    canal.send(JSON.stringify({ type: "pieza", id: item.id, indice, bytes: trozo.byteLength }));
                    canal.send(trozo);

                    const porcentaje = Math.floor((hasta / bytes.byteLength) * 100);
                    if (porcentaje >= avisado + 5) {
                        avisado = porcentaje;
                        mandarSenal({ type: "progreso", id: item.id, recibidos: hasta, total: bytes.byteLength });
                    }
                }

                canal.send(JSON.stringify({ fin: item.id }));
                // Se espera el "recibido" antes de cerrar: cerrar apenas se manda
                // el último pedazo lo deja sin salir del buffer.
                await new Promise((resolverEspera) => {
                    recibido = resolverEspera;
                    setTimeout(resolverEspera, 3000);
                });
                // Se marca antes de cerrar: cerrar dispara el evento de cierre, y
                // un cierre limpio no puede terminar contando como corte.
                terminar(recibidoOk);
                try {
                    pc.close();
                } catch {}
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

// Del lado del mostrador: llega la oferta, se arma el canal y las piezas se
// guardan por índice hasta que el emisor avise que terminó.
function prepararCanal(oferta) {
    pcMostrador = new RTCPeerConnection({ iceServers: [STUN] });

    pcMostrador.onicecandidate = (evento) => {
        if (evento.candidate) mandarSenal({ type: "candidato", candidato: evento.candidate });
    };

    pcMostrador.ondatachannel = (evento) => {
        canalEntrante = evento.channel;
        canalEntrante.binaryType = "arraybuffer";
        canalEntrante.onmessage = (mensaje) => {
            if (typeof mensaje.data !== "string") {
                if (!piezaPorCanal) return;
                const { id, indice } = piezaPorCanal;
                piezaPorCanal = null;
                // La confirmación vuelve por el mismo canal que los bytes.
                agregarPieza(id, indice, new Uint8Array(mensaje.data), (idPieza, indicePieza) => {
                    try {
                        canalEntrante.send(JSON.stringify({ type: "confirmo", id: idPieza, indice: indicePieza }));
                    } catch {}
                });
                return;
            }

            try {
                const dato = JSON.parse(mensaje.data);
                if (dato && dato.type === "pieza") {
                    piezaPorCanal = { id: dato.id, indice: dato.indice };
                    return;
                }
                if (dato && dato.fin) {
                    const salioBien = cerrarItem(dato.fin);
                    // Se le avisa al celular que llegó (y si llegó bien), para que
                    // pueda cerrar sin cortar el último pedazo.
                    try {
                        canalEntrante.send(JSON.stringify({ recibido: dato.fin, ok: salioBien }));
                    } catch {}
                }
            } catch {
                // Un mensaje raro no puede tirar abajo la recepción.
            }
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

// El respaldo, con progreso: un `fetch` no deja ver cuánto falta, así que va
// por XHR. `desde` es el byte donde se retoma.
function subirPorRespaldo(item, desde = 0) {
    return new Promise((resolver) => {
        const xhr = new XMLHttpRequest();
        let ultimoProgreso = Date.now();
        let terminado = false;

        const terminar = (resultado) => {
            if (terminado) return;
            terminado = true;
            clearInterval(vigilante);
            resolver(resultado);
        };

        // Si en 25 s no hubo un solo byte de progreso, el pedido se aborta: la
        // radio del celular puede caerse sin avisar y el XHR quedaría pendiente
        // hasta el timeout del sistema.
        const vigilante = setInterval(() => {
            if (Date.now() - ultimoProgreso > 25000) {
                try {
                    xhr.abort();
                } catch {}
            }
        }, 5000);

        xhr.open("POST", API_BASE + "/subir/" + codigoActual);
        xhr.setRequestHeader("Content-Type", item.tipo);
        xhr.setRequestHeader("X-Token", tokenDoc);
        xhr.setRequestHeader("X-Nombre", encodeURIComponent(item.nombre));
        xhr.setRequestHeader("X-Id", item.id);
        xhr.setRequestHeader("X-Desde", String(desde));
        xhr.setRequestHeader("X-Bytes", String(item.bytes));

        xhr.upload.onprogress = (evento) => {
            ultimoProgreso = Date.now();
            mandarSenal({
                type: "progreso",
                id: item.id,
                recibidos: desde + evento.loaded,
                total: item.bytes,
            });
        };

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) return terminar({ ok: true });
            if (xhr.status === 409) {
                return terminar({
                    ok: false,
                    error: "sin-pc",
                    mensaje: "La computadora se desconectó. Probá de nuevo cuando esté.",
                });
            }
            if (xhr.status === 413) {
                return terminar({ ok: false, error: "grande", mensaje: "«" + item.nombre + "» no entra por el túnel." });
            }
            if (xhr.status === 415) {
                return terminar({ ok: false, error: "tipo", mensaje: "«" + item.nombre + "» no es de un tipo que el túnel acepte." });
            }
            terminar({ ok: false, error: "otro", mensaje: "No se pudo mandar «" + item.nombre + "». Probá otra vez." });
        };
        xhr.onerror = () => terminar({ ok: false, error: "red", mensaje: "No se pudo mandar «" + item.nombre + "». Probá otra vez." });
        // Un corte de red aborta el pedido sin pasar por `error`: hay que
        // escucharlo, o el envío queda colgado para siempre.
        xhr.onabort = () => terminar({ ok: false, error: "red", mensaje: "Se cortó el envío de «" + item.nombre + "»." });
        xhr.ontimeout = () => terminar({ ok: false, error: "red", mensaje: "Se cortó el envío de «" + item.nombre + "»." });

        xhr.send(item.archivo.slice(desde));
    });
}

async function enviarElegidos() {
    const boton = el("btn-enviar");
    boton.disabled = true;
    await mantenerDespierta();

    let enviados = 0;
    let intentados = 0;

    for (const item of elegidos) {
        // Se mira antes de empezar: lo que no puede entrar no se manda.
        if (!item.bytes) {
            avisoCliente("«" + item.nombre + "» está vacío.");
            continue;
        }
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

        if (await mandarItem(item)) enviados++;
    }

    soltarVigilia();

    if (intentados > 0 && enviados === intentados) {
        avisoCliente(
            "Listo: " + enviados + (enviados === 1 ? " archivo ya está" : " archivos ya están") +
            " en la computadora."
        );
        elegidos = [];
        el("input-archivos").value = "";
    }
    // Con o sin éxito, el botón vuelve a su estado real: si quedaron archivos,
    // se pueden reintentar sin recargar la página.
    pintarElegidos();
}

// El id lo pone el celular y viaja en los dos caminos: así un archivo es una
// sola fila, vaya por donde vaya.
function anunciar(item) {
    // El id se conserva entre reintentos: si la fila sigue en la PC, tocar Enviar
    // otra vez sigue desde donde quedó en vez de empezar de cero.
    if (!item.id) item.id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())).slice(0, 16);
    mandarSenal({
        type: "item",
        id: item.id,
        nombre: item.nombre,
        tipo: item.tipo,
        bytes: item.bytes,
        pieza: PIEZA_BYTES,
        total: piezasDe(item.bytes, PIEZA_BYTES).cantidad,
    });
}

// Manda un archivo: primero el camino directo, después el respaldo.
async function mandarItem(item) {
    enCurso = item;
    anunciar(item);

    let salio = false;
    try {
        salio = await enviarPorP2P(item);
    } catch {
        salio = false;
    }

    if (!salio) {
        // Antes de mandar por el respaldo se pregunta dónde quedó: si el canal
        // directo entregó parte, no se sube de nuevo lo que ya llegó.
        const falta = await pedirFalta(item.id);
        salio = await seguirPorRespaldo(item, falta === null ? 0 : falta);
    }
    enCurso = null;
    return salio;
}

// El respaldo, con reintentos. Cada intento pregunta a la PC dónde quedó y sigue
// desde ahí: un corte no cuesta el archivo entero.
async function seguirPorRespaldo(item, desde) {
    let punto = desde;

    for (let intento = 1; intento <= 3; intento++) {
        if (punto >= item.bytes) return true;

        avisoCliente("Mandando «" + item.nombre + "» por el respaldo…" + (intento > 1 ? " (retomando)" : ""));
        const resultado = await subirPorRespaldo(item, punto);
        if (resultado.ok) return true;

        // Si no llegó, la fila del mostrador no puede quedar mintiendo.
        mandarSenal({ type: "item-error", id: item.id, motivo: resultado.error });

        if (resultado.error === "tipo" || resultado.error === "grande") {
            avisoCliente(resultado.mensaje);
            return false;
        }

        const falta = await pedirFalta(item.id);
        if (falta === null) {
            avisoCliente(resultado.mensaje);
            return false;
        }

        // Si la PC ya tiene todo, no hay nada más que mandar.
        if (falta >= item.bytes) return true;
        punto = falta;
    }

    avisoCliente("No se pudo mandar «" + item.nombre + "». Probá otra vez.");
    return false;
}

// Pregunta a la PC desde qué byte seguir. Si no contesta, es que no hay con quién.
let faltaPendiente = null;

function pedirFalta(id) {
    return new Promise((resolver) => {
        // Un pedido anterior esperando se resuelve con null: nunca queda una
        // promesa colgada para siempre.
        faltaPendiente?.(null);

        const terminar = (valor) => {
            if (faltaPendiente !== terminar) return;
            faltaPendiente = null;
            resolver(valor);
        };

        faltaPendiente = terminar;
        mandarSenal({ type: "pidofalta", id });
        setTimeout(() => terminar(null), 2000);
    });
}

// Al volver la conexión, si había un archivo a medias se retoma donde quedó.
function retomarPendientes() {
    if (!enCurso || enCurso.retomando) return;
    const item = enCurso;
    item.retomando = true;

    pedirFalta(item.id).then(async (falta) => {
        item.retomando = false;
        if (enCurso !== item) return;

        if (falta === null) {
            // No hay PC del otro lado: se dice, en vez de quedarse en
            // "Reintentando…" para siempre.
            enCurso = null;
            avisoCliente("La computadora no está conectada. Pedile al mostrador que abra el túnel de nuevo.");
            return;
        }

        if (falta >= item.bytes) {
            enCurso = null;
            avisoCliente("Listo: «" + item.nombre + "» ya está en la computadora.");
            return;
        }

        if (await seguirPorRespaldo(item, falta)) {
            enCurso = null;
            avisoCliente("Listo: «" + item.nombre + "» ya está en la computadora.");
        }
    });
}

function arrancarCliente(codigo) {
    el("pantalla-pc").hidden = true;
    el("pantalla-cliente").hidden = false;
    codigoActual = codigo;
    avisoCliente("Elegí los archivos y tocá Enviar. Podés elegir de nuevo para sumar más.");
    conectarCliente(codigo);
}

// El celular puede perder señal y volver: en vez de darlo por perdido, se
// reconecta (unos intentos) y retoma lo que estaba mandando.
var reintentosCliente = 0;

function conectarCliente(codigo) {
    socketDoc = abrirSocket(codigo, "emisor", (mensaje) => {
        if (mensaje.type === "bienvenida") {
            reintentosCliente = 0;
            tokenDoc = mensaje.token;
            pintarElegidos();
            retomarPendientes();
            return;
        }
        if (mensaje.type === "falta") {
            // El que esperaba la respuesta se encarga de resolverse una sola vez.
            faltaPendiente?.(mensaje.desde);
            return;
        }
        alSenalCliente(mensaje);
    });

    socketDoc.onclose = (evento) => {
        if (evento.code === 4001) {
            el("btn-elegir").disabled = true;
            el("btn-enviar").disabled = true;
            avisoCliente("Esta sesión ya tiene un cliente conectado. Pedile a la computadora un código nuevo.");
            return;
        }

        if (reintentosCliente >= 5) {
            el("btn-elegir").disabled = true;
            el("btn-enviar").disabled = true;
            avisoCliente("La computadora se desconectó. Volvé a escanear el código.");
            return;
        }

        reintentosCliente++;
        avisoCliente("Se cortó la conexión. Reintentando…");
        setTimeout(() => conectarCliente(codigo), 1500);
    };
}

/* -------------------------------------------------------------- arranque */

function arrancarDocumentos() {
    el("btn-elegir").addEventListener("click", () => el("input-archivos").click());
    el("input-archivos").addEventListener("change", (evento) => {
        elegirArchivos(evento.target.files);
        // Se limpia para poder volver a elegir el mismo archivo —o el mismo lote—
        // sin que el navegador crea que no cambió nada y no dispare el evento.
        evento.target.value = "";
    });
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
