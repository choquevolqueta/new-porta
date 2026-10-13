// Tope de sesiones nuevas por IP, para que el relay abierto no sea un servicio
// gratuito e ilimitado. Puro: recibe el mapa y el reloj, no los busca solo.

export const LIMITE_SESIONES = 30;
export const VENTANA_LIMITE_MS = 60 * 60 * 1000;

export function permitir(mapa, ip, ahora) {
  const entrada = mapa.get(ip);
  if (!entrada || ahora - entrada.ventana >= VENTANA_LIMITE_MS) {
    mapa.set(ip, { ventana: ahora, cuenta: 1 });
    return true;
  }
  if (entrada.cuenta < LIMITE_SESIONES) {
    entrada.cuenta += 1;
    return true;
  }
  return false;
}
