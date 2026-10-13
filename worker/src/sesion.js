// Lógica pura del túnel de fotos: códigos, expiración, cupos y límites.
// Sin APIs de Cloudflare ni del navegador, para poder testearla con `node --test`.

// 32 símbolos, sin los que se confunden al dictar o tipear: 0, O, 1, I.
// 8 caracteres dan unos 40 bits: el código es la única credencial de la sesión.
export const ALFABETO = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const LARGO_CODIGO = 8;
export const TTL_SESION_MS = 30 * 60 * 1000;
export const MAX_JPEG_BYTES = 600 * 1024;

export function generarCodigo(aleatorio = Math.random, largo = LARGO_CODIGO) {
  let codigo = "";
  for (let i = 0; i < largo; i++) {
    codigo += ALFABETO[Math.floor(aleatorio() * ALFABETO.length)];
  }
  return codigo;
}

// Aguanta lo que tipea una persona: mayúsculas y minúsculas, espacios,
// guiones y cualquier cosa que no sea del alfabeto.
export function normalizarCodigo(texto) {
  return [...String(texto).toUpperCase()]
    .filter((c) => ALFABETO.includes(c))
    .join("");
}

export function crearSesion(ahora, codigo = "") {
  return {
    codigo,
    ultimaActividad: ahora,
    pc: false,
    emisor: false,
    foto: null,
  };
}

export function estaExpirada(sesion, ahora, ttl = TTL_SESION_MS) {
  return ahora - sesion.ultimaActividad >= ttl;
}

export function tocarSesion(sesion, ahora) {
  sesion.ultimaActividad = ahora;
}

// El cupo es por conexión: cuando el celular se va, se libera y el mismo QR
// sigue sirviendo para el compañero siguiente.
export function registrarEmisor(sesion) {
  if (sesion.emisor) return { ok: false, error: "ocupado" };
  sesion.emisor = true;
  return { ok: true };
}

export function liberarEmisor(sesion) {
  sesion.emisor = false;
}

export function puedeRecibirFoto(sesion, bytes, tipo) {
  if (!sesion.pc) return { ok: false, error: "sin-pc" };
  if (!bytes || bytes.length === 0) return { ok: false, error: "vacia" };
  if (!tipo || !String(tipo).startsWith("image/jpeg")) return { ok: false, error: "tipo" };
  if (bytes.length > MAX_JPEG_BYTES) return { ok: false, error: "grande" };
  return { ok: true };
}
