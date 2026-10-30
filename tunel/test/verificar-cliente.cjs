// Verifica las funciones puras del cliente: el nombre del archivo cuando el
// celular manda una hora de captura válida, cuando manda basura y cuando no
// manda nada, más los tres mensajes de cámara.
//
//   node tunel/test/verificar-cliente.cjs
//
// El cliente son dos scripts de navegador (`nucleo.js` y `fotos.js`), así que se
// los ejecuta en el mismo contexto con un DOM mínimo que no hace nada. El resto
// del cliente (WebSocket, la foto, la cámara) se verifica a mano en el navegador.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const fuentes = ["nucleo.js", "fotos.js"].map((nombre) =>
  fs.readFileSync(path.join(__dirname, "..", nombre), "utf8")
);

const falso = () => ({
  addEventListener() {},
  classList: { toggle() {} },
  style: {},
  textContent: "",
  hidden: true,
  setAttribute() {},
  removeAttribute() {},
});

let ultimoSocket = null;
class WebSocketFalso {
  constructor(url) {
    this.url = url;
    ultimoSocket = this;
  }
  close() {}
  send() {}
}

const contexto = {
  document: {
    addEventListener() {},
    createElement: falso,
    getElementById: falso,
    body: { contains: () => true, appendChild() {} },
  },
  location: { hostname: "localhost", origin: "http://localhost:8080", pathname: "/tunel/", search: "" },
  URLSearchParams, URL, Blob, atob, btoa, console,
  Date, Math, Number, String, Object, JSON, setTimeout, clearTimeout,
  WebSocket: WebSocketFalso,
};

vm.createContext(contexto);
for (const fuente of fuentes) vm.runInContext(fuente, contexto);

const dos = (n) => String(n).padStart(2, "0");
const nombreEsperado = (fecha) =>
  "foto-" + fecha.getFullYear() + "-" + dos(fecha.getMonth() + 1) + "-" + dos(fecha.getDate()) +
  "-" + dos(fecha.getHours()) + dos(fecha.getMinutes()) + ".jpg";

// Con una hora de captura válida, el nombre sale de esa hora, en el reloj local.
const conHora = "2026-10-13T21:04:11-05:00";
assert.equal(contexto.nombreArchivo(conHora), nombreEsperado(new Date(conHora)));

// Con la hora ausente, basura o de otro tipo, cae a la hora de recepción.
const forma = /^foto-\d{4}-\d{2}-\d{2}-\d{4}\.jpg$/;
for (const malo of ["basura", "", null, undefined, 12345, {}, []]) {
  const nombre = contexto.nombreArchivo(malo);
  assert.match(nombre, forma, `con ${JSON.stringify(malo)} salió ${nombre}`);
  assert.equal(nombre, nombreEsperado(new Date()), `con ${JSON.stringify(malo)} no cayó a la recepción`);
}

// La hora de la etiqueta roja.
assert.equal(
  contexto.horaDe(conHora),
  dos(new Date(conHora).getHours()) + ":" + dos(new Date(conHora).getMinutes())
);
assert.match(contexto.horaDe(null), /^\d{2}:\d{2}$/);

// Los tres mensajes de cámara: permiso, sin cámara, y cualquier otra cosa.
assert.match(contexto.mensajeDeCamara({ name: "NotAllowedError" }), /permiso/i);
assert.match(contexto.mensajeDeCamara({ name: "SecurityError" }), /permiso/i);
assert.match(contexto.mensajeDeCamara({ name: "NotFoundError" }), /ninguna cámara/i);
assert.match(contexto.mensajeDeCamara(new Error("otro")), /No se pudo abrir la cámara/);

// El recorte del zoom digital: centrado, y con el factor bien aplicado.
assert.deepEqual(
  { ...contexto.recorteCentrado(1920, 1080, 1) },
  { x: 0, y: 0, ancho: 1920, alto: 1080 },
  "sin zoom se copia el cuadro entero"
);
assert.deepEqual(
  { ...contexto.recorteCentrado(1920, 1080, 2) },
  { x: 480, y: 270, ancho: 960, alto: 540 },
  "al doble, el centro"
);
assert.deepEqual(
  { ...contexto.recorteCentrado(1000, 1000, 4) },
  { x: 375, y: 375, ancho: 250, alto: 250 },
  "al cuádruple, un cuarto del centro"
);

// El número que se muestra en el control.
assert.equal(contexto.formatearZoom(1), "1×");
assert.equal(contexto.formatearZoom(1.5), "1.5×");
assert.equal(contexto.formatearZoom(2), "2×");

// El tamaño, como se lee en pantalla.
assert.equal(contexto.formatearBytes(900), "900 B");
assert.equal(contexto.formatearBytes(2048), "2 KB");
assert.equal(contexto.formatearBytes(1258291), "1,2 MB");

// El troceado del envío por el canal de datos.
const trozos = contexto.trocear(40000, 16384);
assert.equal(trozos.cantidad, 3, "40000 bytes en trozos de 16384 son 3");
assert.equal(trozos.ultimo, 7232);
const uno = contexto.trocear(100, 16384);
assert.equal(uno.cantidad, 1);
assert.equal(uno.ultimo, 100);

// Sumar lo que se acaba de elegir a lo que ya estaba elegido. En el celular se
// elige de a tandas —una foto desde la cámara, un PDF desde descargas—, así que
// la segunda vuelta no puede borrar la primera.
const fichas = (nombres) => nombres.map((nombre, i) => ({ nombre, bytes: (i + 1) * 100, ultimo: 1000 + i }));

const suma = contexto.sumarElegidos(fichas(["foto.jpg"]), fichas(["reclamo.pdf"]), 20);
assert.deepEqual(
  [...suma.lista].map((f) => f.nombre),
  ["foto.jpg", "reclamo.pdf"],
  "la segunda elección se suma, no reemplaza"
);
assert.equal(suma.agregados, 1);
assert.equal(suma.repetidos, 0);
assert.equal(suma.sobrantes, 0);

// Lo que ya estaba no se toca: la función devuelve una lista nueva.
const previos = fichas(["a.pdf"]);
contexto.sumarElegidos(previos, fichas(["b.pdf"]), 20);
assert.equal(previos.length, 1, "la lista original no se modifica");

// Elegir otra vez el mismo archivo no lo duplica.
const repetida = contexto.sumarElegidos(fichas(["a.pdf"]), fichas(["a.pdf"]), 20);
assert.equal(repetida.lista.length, 1, "el mismo archivo no se cuenta dos veces");
assert.equal(repetida.repetidos, 1, "y se avisa que ya estaba");

// Dos archivos distintos con el mismo nombre entran los dos: son dos documentos
// diferentes que casualmente se llaman igual.
const homonimos = contexto.sumarElegidos(
  [{ nombre: "reclamo.pdf", bytes: 1000, ultimo: 111 }],
  [{ nombre: "reclamo.pdf", bytes: 2000, ultimo: 222 }],
  20
);
assert.equal(homonimos.lista.length, 2, "mismo nombre y otro contenido son dos archivos");

// El tope: lo que no entra se avisa, no se pierde en silencio.
const llena = contexto.sumarElegidos(fichas(["a.pdf", "b.pdf"]), fichas(["c.pdf", "d.pdf"]), 3);
assert.deepEqual([...llena.lista].map((f) => f.nombre), ["a.pdf", "b.pdf", "c.pdf"]);
assert.equal(llena.sobrantes, 1, "el que no entró por el tope se informa");

// Las piezas del archivo: cuántas, qué tramo ocupa cada una, cuál falta y si
// están todas. Es lo que permite reanudar sin volver a mandar lo que llegó.
assert.equal(contexto.piezasDe(2_500_000, 1_048_576).cantidad, 3);
assert.equal(contexto.piezasDe(0, 1_048_576).cantidad, 0);
assert.deepEqual({ ...contexto.tramoDe(1, 1_048_576, 2_500_000) }, { desde: 1_048_576, hasta: 2_097_152 });
assert.deepEqual({ ...contexto.tramoDe(2, 1_048_576, 2_500_000) }, { desde: 2_097_152, hasta: 2_500_000 },
  "la última pieza termina en el total, no en el tamaño de pieza");
assert.equal(contexto.primeraFaltante(new Set([0, 1, 2]), 5), 3, "si viene en orden, la siguiente");
assert.equal(contexto.primeraFaltante(new Set([0, 2]), 3), 1, "con un hueco, la primera que falta");
assert.equal(contexto.primeraFaltante(new Set([0, 1]), 2), 2, "si están todas, devuelve la cantidad");
assert.equal(contexto.estanTodas(new Set([0, 1, 2]), 3), true);
assert.equal(contexto.estanTodas(new Set([0, 2]), 3), false, "un hueco no es estar todas");

// La sesión recordada en sessionStorage: un F5 no debe crear un Durable Object
// nuevo. El TTL del servidor es deslizante, así que el guardado envejece con
// cada mensaje; acá se prueba el contrato con un almacén falso.
const almacen = () => {
  const datos = new Map();
  return {
    getItem: (k) => (datos.has(k) ? datos.get(k) : null),
    setItem: (k, v) => datos.set(k, String(v)),
    removeItem: (k) => datos.delete(k),
  };
};

assert.equal(contexto.VIDA_SESION_MS, 7 * 60 * 1000, "el cliente espera 7 minutos");

const guardado = almacen();
assert.equal(contexto.leerSesionGuardada(guardado, 1000, 5000, "fotos"), null, "sin nada guardado no hay sesión");
contexto.guardarSesion(guardado, "ABCDEFGH", 1000, "fotos");
assert.equal(contexto.leerSesionGuardada(guardado, 5999, 5000, "fotos"), "ABCDEFGH", "dentro del TTL se reusa");
assert.equal(contexto.leerSesionGuardada(guardado, 6000, 5000, "fotos"), null, "vencida no se reusa");
assert.equal(contexto.leerSesionGuardada(guardado, 2000, 5000, "documentos"), null, "otro modo no se reusa");
contexto.tocarSesionGuardada(guardado, 5000);
assert.equal(contexto.leerSesionGuardada(guardado, 9999, 5000, "fotos"), "ABCDEFGH", "tocar corre el reloj");
contexto.olvidarSesion(guardado);
assert.equal(contexto.leerSesionGuardada(guardado, 5001, 5000, "fotos"), null, "olvidar la borra");
assert.equal(contexto.leerSesionGuardada(null, 0, 5000, "fotos"), null, "sin almacén no rompe");

// Un guardado corrupto o incompleto no puede tumbar el arranque: se ignora.
const roto = almacen();
roto.setItem("tunel.sesion", "{no es json");
assert.equal(contexto.leerSesionGuardada(roto, 0, 5000, "fotos"), null, "basura no rompe");
roto.setItem("tunel.sesion", JSON.stringify({ ts: 0, modo: "fotos" }));
assert.equal(contexto.leerSesionGuardada(roto, 0, 5000, "fotos"), null, "sin código no hay sesión");

// La decisión de dormir o reintentar según el cierre del WebSocket.
assert.equal(contexto.decidirCierre(4002, 0, 3), "dormir", "la expiración duerme ya");
assert.equal(contexto.decidirCierre(1006, 0, 3), "reintentar", "un corte de red reintenta");
assert.equal(contexto.decidirCierre(1006, 2, 3), "reintentar", "todavía quedan intentos");
assert.equal(contexto.decidirCierre(1006, 3, 3), "dormir", "sin intentos, duerme");
assert.equal(contexto.decidirCierre(4001, 1, 1), "dormir", "documentos duerme tras su reintento");

// Una conexión exitosa reinicia el presupuesto de reintentos.
contexto.intentosReconexion = 2;
contexto.conectarComoPc("ABCDEFGH");
assert.ok(ultimoSocket, "conectarComoPc crea un WebSocket");
ultimoSocket.onopen();
assert.equal(contexto.intentosReconexion, 0, "una conexión exitosa reinicia los intentos");

console.log(JSON.stringify({
  elegidos: suma.lista.map((f) => f.nombre),
  conHora: contexto.nombreArchivo(conHora),
  piezas: contexto.piezasDe(2_500_000, 1_048_576),
  conBasura: contexto.nombreArchivo("basura"),
  horaMostrada: contexto.horaDe(conHora),
  recorte2x: contexto.recorteCentrado(1920, 1080, 2),
  tamano: contexto.formatearBytes(1258291),
  trozos: trozos,
}));
