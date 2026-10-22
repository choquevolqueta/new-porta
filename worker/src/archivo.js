// Lógica pura de los archivos: el modo, qué tipo se acepta y el tope.
// Sin APIs de Cloudflare, para poder testearla con `node --test`.

import { MAX_JPEG_BYTES } from "./sesion.js";

export const MODOS = { FOTOS: "fotos", DOCUMENTOS: "documentos" };
export const MODO_POR_DEFECTO = MODOS.FOTOS;

// Lo que puede pesar un archivo de documentos: un video de un celular entra
// justo. 50 MiB y no 50 MB decimales, para que un archivo que el celular muestra
// como "50 MB" nunca quede afuera.
export const MAX_ARCHIVO_BYTES = 50 * 1024 * 1024;

// Las etiquetas que se aceptan en cada modo, y los primeros bytes que las
// confirman. La etiqueta la pone el cliente, así que sola no alcanza; pero un
// .docx es un ZIP y un ZIP no dice de qué es, así que ahí la comprobación es la
// más débil.
//
// `desde` existe por los videos: el `ftyp` no arranca el archivo, va después del
// tamaño de la caja.
export const FIRMAS = {
  [MODOS.FOTOS]: {
    "image/jpeg": { desde: 0, bytes: [0xff, 0xd8] },
  },
  [MODOS.DOCUMENTOS]: {
    "image/jpeg": { desde: 0, bytes: [0xff, 0xd8] },
    "image/png": { desde: 0, bytes: [0x89, 0x50, 0x4e, 0x47] },
    "application/pdf": { desde: 0, bytes: [0x25, 0x50, 0x44, 0x46] },
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
      desde: 0,
      bytes: [0x50, 0x4b, 0x03, 0x04],
    },
    "video/mp4": { desde: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
    "video/quicktime": { desde: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
    "video/webm": { desde: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  },
};

const TOPES = {
  [MODOS.FOTOS]: MAX_JPEG_BYTES,
  [MODOS.DOCUMENTOS]: MAX_ARCHIVO_BYTES,
};

// Cuántos bytes de la cabecera hacen falta para decidir el tipo.
export const BYTES_DE_FIRMA = Math.max(
  ...Object.values(FIRMAS).flatMap((tipos) =>
    Object.values(tipos).map((firma) => firma.desde + firma.bytes.length)
  )
);

export function modoValido(modo) {
  return Object.values(MODOS).includes(modo);
}

// `primeros` son los primeros bytes que llegaron y `total` el tamaño completo
// anunciado. Con el respaldo en streaming el cuerpo no se tiene entero cuando
// hay que decidir. `desdeByte` es el offset del tramo: si es una reanudación
// (mayor que cero) los bytes no empiezan en la cabecera del archivo, así que la
// firma no se puede comprobar y se confía en la etiqueta; el tamaño y el token
// se siguen validando.
export function puedeRecibirArchivo(modo, tipo, primeros, total = primeros?.length ?? 0, desdeByte = 0) {
  if (!modoValido(modo)) return { ok: false, error: "modo" };
  if (!total || total <= 0) return { ok: false, error: "vacio" };
  if (total > TOPES[modo]) return { ok: false, error: "grande" };

  const firma = FIRMAS[modo][String(tipo)];
  if (!firma) return { ok: false, error: "tipo" };

  if (desdeByte === 0) {
    if (!primeros || primeros.length < firma.desde + firma.bytes.length) {
      return { ok: false, error: "tipo" };
    }
    if (firma.bytes.some((byte, i) => primeros[firma.desde + i] !== byte)) {
      return { ok: false, error: "tipo" };
    }
  }

  return { ok: true };
}
