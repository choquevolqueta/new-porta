// Verifica que el codificador vendido esté intacto y que dé una matriz
// determinista para la URL que va en el QR.
//
//   node tunel/test/verificar-qrcode.cjs
//
// La parte visual (que el canvas dibuje exactamente esa matriz, con el margen
// de 4 módulos en blanco) se verifica en el navegador, no acá.
const assert = require("node:assert/strict");
const qrcode = require("../vendor/qrcode.js");

const texto = "http://localhost:8080/tunel/?s=9XK2M7QP";
const qr = qrcode(0, "M");
qr.addData(texto);
qr.make();

const n = qr.getModuleCount();
assert.equal(n, 29, "versión 3 para esta URL con corrección M");

let oscuros = 0;
for (let f = 0; f < n; f++) {
  for (let c = 0; c < n; c++) if (qr.isDark(f, c)) oscuros++;
}
assert.equal(oscuros, 420, "si cambia, el archivo vendido ya no es el mismo");

// Los tres cuadros de posición van en tres esquinas, y la cuarta queda libre.
assert.equal(qr.isDark(0, 0), true);
assert.equal(qr.isDark(0, n - 1), true);
assert.equal(qr.isDark(n - 1, 0), true);
assert.equal(qr.isDark(n - 1, n - 1), false, "la cuarta esquina no lleva cuadro");

console.log(JSON.stringify({ texto, modulos: n, oscuros }));
