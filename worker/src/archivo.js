// Lógica pura de los archivos: el modo, qué tipo se acepta y el tope.
// Sin APIs de Cloudflare, para poder testearla con `node --test`.

import { MAX_JPEG_BYTES } from "./sesion.js";

export const MODOS = { FOTOS: "fotos", DOCUMENTOS: "documentos" };
export const MODO_POR_DEFECTO = MODOS.FOTOS;

// El archivo puede pesar bastante más que una foto: la foto viaja por un mensaje
// de WebSocket (1 MiB de tope), el archivo va por otro camino.
export const MAX_ARCHIVO_BYTES = 6 * 1024 * 1024;

// Lo que vive un archivo en la memoria del objeto si nadie lo baja.
export const TTL_RESPALDO_MS = 2 * 60 * 1000;

// Las etiquetas que se aceptan en cada modo, y los primeros bytes que las
// confirman. La etiqueta la pone el cliente, así que sola no alcanza; pero un
// .docx es un ZIP y un ZIP no dice de qué es, así que ahí la comprobación es la
// más débil de las cuatro.
export const TIPOS_ACEPTADOS = {
  [MODOS.FOTOS]: {
    "image/jpeg": [0xff, 0xd8],
  },
  [MODOS.DOCUMENTOS]: {
    "image/jpeg": [0xff, 0xd8],
    "image/png": [0x89, 0x50, 0x4e, 0x47],
    "application/pdf": [0x25, 0x50, 0x44, 0x46],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [0x50, 0x4b, 0x03, 0x04],
  },
};

const TOPES = {
  [MODOS.FOTOS]: MAX_JPEG_BYTES,
  [MODOS.DOCUMENTOS]: MAX_ARCHIVO_BYTES,
};

export function modoValido(modo) {
  return Object.values(MODOS).includes(modo);
}

export function puedeRecibirArchivo(modo, tipo, bytes) {
  if (!modoValido(modo)) return { ok: false, error: "modo" };
  if (!bytes || bytes.length === 0) return { ok: false, error: "vacio" };

  const firma = TIPOS_ACEPTADOS[modo][String(tipo)];
  if (!firma) return { ok: false, error: "tipo" };
  if (firma.some((byte, i) => bytes[i] !== byte)) return { ok: false, error: "tipo" };

  if (bytes.length > TOPES[modo]) return { ok: false, error: "grande" };
  return { ok: true };
}
