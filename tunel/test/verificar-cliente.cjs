// Verifica las funciones puras del cliente: el nombre del archivo cuando el
// celular manda una hora de captura válida, cuando manda basura y cuando no
// manda nada, más los tres mensajes de cámara.
//
//   node tunel/test/verificar-cliente.cjs
//
// El cliente es un script de navegador, así que se lo ejecuta en un contexto
// con un DOM mínimo que no hace nada. El resto de `tunel.js` (WebSocket, la
// foto, la cámara) se verifica a mano en el navegador.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const fuente = fs.readFileSync(path.join(__dirname, "..", "tunel.js"), "utf8");

const falso = () => ({
  addEventListener() {},
  classList: { toggle() {} },
  style: {},
  textContent: "",
  hidden: true,
  setAttribute() {},
  removeAttribute() {},
});

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
};

vm.createContext(contexto);
vm.runInContext(fuente, contexto);

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

console.log(JSON.stringify({
  conHora: contexto.nombreArchivo(conHora),
  conBasura: contexto.nombreArchivo("basura"),
  horaMostrada: contexto.horaDe(conHora),
  recorte2x: contexto.recorteCentrado(1920, 1080, 2),
}));
