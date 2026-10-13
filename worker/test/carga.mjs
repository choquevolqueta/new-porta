// Prueba contra producción: N pares (celular + PC) a la vez.
// Cada par crea su sesión, abre sus dos WebSockets, comprueba que **sin el
// token del emisor** la subida se rechace con 409, sube una foto de ~300 KB con
// el token y verifica que a la PC le llegue byte por byte.
//
//   node worker/test/carga.mjs [cantidad]
//
// No corre en cada corrida de tests: pega contra el servicio desplegado.

const API = "https://tunel.choquevolqueta.com";
const WS = "wss://tunel.choquevolqueta.com";
const PARES = Number(process.argv[2] ?? 5);

// JPEG mínimo válido, rellenado hasta ~300 KB para medir el camino real.
const base = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCABAAEADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAYI/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAAABEQIRAD8AnQCOaRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf//Z",
  "base64"
);
const CUERPO = Buffer.concat([base, Buffer.alloc(300 * 1024 - base.length, 0x20)]);

const ahora = () => performance.now();

function abrirSocket(ruta) {
  return new Promise((resolver, rechazar) => {
    const ws = new WebSocket(`${WS}${ruta}`);
    ws.recibidos = [];
    ws.esperando = [];
    ws.addEventListener("message", (evento) => {
      const dato = JSON.parse(evento.data);
      const siguiente = ws.esperando.shift();
      if (siguiente) siguiente(dato);
      else ws.recibidos.push(dato);
    });
    ws.addEventListener("open", () => resolver(ws));
    ws.addEventListener("error", () => rechazar(new Error(`no abrió ${ruta}`)));
  });
}

function esperarTipo(ws, tipo, ms = 20000) {
  const buscar = (dato) => dato.type === tipo;
  const ya = ws.recibidos.findIndex(buscar);
  if (ya >= 0) return Promise.resolve(ws.recibidos.splice(ya, 1)[0]);

  return new Promise((resolver, rechazar) => {
    const reloj = setTimeout(() => rechazar(new Error(`no llegó ${tipo} en ${ms} ms`)), ms);
    const atender = (dato) => {
      if (!buscar(dato)) {
        const i = ws.esperando.indexOf(atender);
        if (i >= 0) ws.esperando.splice(i, 1);
        ws.esperando.push(atender);
        return;
      }
      clearTimeout(reloj);
      const i = ws.esperando.indexOf(atender);
      if (i >= 0) ws.esperando.splice(i, 1);
      resolver(dato);
    };
    ws.esperando.push(atender);
  });
}

async function unPar(n) {
  const marcas = {};
  let t = ahora();
  const respuesta = await fetch(`${API}/session`, { method: "POST" });
  const { codigo } = await respuesta.json();
  marcas.sesion = Math.round(ahora() - t);

  t = ahora();
  const pc = await abrirSocket(`/ws/${codigo}?rol=pc`);
  marcas.wsPc = Math.round(ahora() - t);

  t = ahora();
  const celular = await abrirSocket(`/ws/${codigo}?rol=emisor`);
  marcas.wsCelular = Math.round(ahora() - t);

  await esperarTipo(pc, "estado");
  const bienvenida = await esperarTipo(celular, "bienvenida");

  // Sin el token del emisor, la foto no puede entrar.
  const sinToken = await fetch(`${API}/upload/${codigo}`, {
    method: "POST", headers: { "Content-Type": "image/jpeg" }, body: CUERPO,
  });
  marcas.sinToken = sinToken.status;

  t = ahora();
  const subida = await fetch(`${API}/upload/${codigo}?at=${new Date().toISOString()}`, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg", "X-Token": bienvenida.token },
    body: CUERPO,
  });
  const cuerpo = await subida.json().catch(() => ({}));
  marcas.subida = Math.round(ahora() - t);

  t = ahora();
  const foto = await esperarTipo(pc, "foto");
  marcas.entrega = Math.round(ahora() - t);

  const bytes = Uint8Array.from(atob(foto.jpeg), (c) => c.charCodeAt(0));
  const igual = bytes.length === CUERPO.length && Buffer.from(bytes).equals(CUERPO);

  pc.close(1000);
  celular.close(1000);

  return { par: n, codigo, ok: subida.ok && igual && marcas.sinToken === 409, status: subida.status, bytes: bytes.length, igual, error: cuerpo.error, marcas };
}

const arranque = ahora();
const resultados = await Promise.all(
  Array.from({ length: PARES }, (_, i) => unPar(i + 1).catch((e) => ({ par: i + 1, ok: false, fallo: String(e.message) })))
);
const total = Math.round(ahora() - arranque);

const conTiempos = resultados.filter((r) => r.marcas);
const maximo = (clave) => (conTiempos.length ? Math.max(...conTiempos.map((r) => r.marcas[clave])) : null);

console.log(JSON.stringify({
  pares: PARES,
  ok: resultados.filter((r) => r.ok).length,
  fallos: resultados.filter((r) => !r.ok),
  segundosTotales: (total / 1000).toFixed(1),
  peorCasoMs: { sesion: maximo("sesion"), wsPc: maximo("wsPc"), wsCelular: maximo("wsCelular"), subida: maximo("subida"), entrega: maximo("entrega") },
  detalle: resultados.map((r) => ({ par: r.par, ok: r.ok, codigo: r.codigo, error: r.error, fallo: r.fallo, marcas: r.marcas })),
}, null, 1));
