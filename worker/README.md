# tunel-fotos — relay del Túnel

Worker de Cloudflare que conecta el celular con la PC del [Túnel](https://choquevolqueta.com/tunel/). No sirve la página: solo API y WebSocket.

## Rutas

| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `/session` | Crea una sesión y devuelve un código de 8 caracteres |
| `GET` | `/ws/:codigo?rol=pc` | WebSocket de la PC |
| `GET` | `/ws/:codigo?rol=emisor` | WebSocket del celular (o del mostrador) |
| `POST` | `/upload/:codigo?at=<ISO>` | Foto JPEG, con el cuerpo entero |
| `POST` | `/subir/:codigo` | Archivo, reenviado como stream |
| `GET` | `/health` | `{ ok: true, ttl }` |

## Arquitectura

| Archivo | Responsabilidad |
|---|---|
| `src/index.js` | Router, CORS, validación de tamaños y rangos |
| `src/durable.js` | Exporta los Durable Objects `Sesion` y `Limite` |
| `src/sesion.js` | Código, TTL y validación de la foto |
| `src/archivo.js` | Modos, firmas, topes y aritmética de piezas |
| `src/limite.js` | Límite de sesiones por IP |

Dos Durable Objects con SQLite:

- **`Sesion`** — uno por código. Mantiene los dos WebSockets, el estado del
  archivo en curso y las piezas confirmadas.
- **`Limite`** — contador por IP para `/session`.

## Protocolo

- El emisor recibe un `token` en el mensaje de bienvenida y lo manda en
  `X-Token` en cada `/subir`. Sin token, la subida responde `409`.
- Los archivos viajan en **piezas de 64 KB**: primero por **WebRTC (P2P)**; si
  en 5 segundos no engancha, por el **respaldo del Worker**.
- La PC confirma cada pieza y el emisor no se adelanta más de **4 piezas**.
- Si se corta, la PC indica desde qué byte seguir (`X-Desde`) y el celular
  retoma sin volver a empezar.
- La sesión vive **5 minutos deslizantes**: se renueva con cada progreso.

## Límites

| Qué | Valor |
|---|---|
| Código de sesión | 8 caracteres |
| Foto | 600 KB |
| Archivo | 50 MiB |
| Archivos por sesión | 20 |
| Pieza | 64 KB |
| Sesiones por IP | 30 por hora |
| TTL de sesión | 5 minutos |

## Seguridad

- **No se guarda nada**: el Worker reenvía en streaming y el respaldo no
  persiste bytes.
- El token es por sesión y se genera en tiempo de ejecución; no hay
  credenciales en el repositorio.
- CORS limitado al dominio del sitio y a `localhost`.
- Topes validados en el borde (`X-Bytes`, `X-Desde`, `Content-Length`) antes
  de reenviar al Durable Object.

## Desplegar

```bash
cd worker
npx wrangler deploy
```

`wrangler.toml` fija `tunel.choquevolqueta.com` como custom domain, así que
wrangler crea el registro DNS y el certificado. El apex y `www` siguen en
GitHub Pages, en DNS-only.

## Tests

```bash
node --test "worker/test/unidad/*.test.js"
```

La integración necesita el runtime local en otra terminal:

```bash
cd worker && npx wrangler dev --port 8787
node --test worker/test/integracion/relay.test.js --test-force-exit
node --test worker/test/integracion/archivos.test.js --test-force-exit
```

## Licencia

PolyForm Noncommercial 1.0.0. Ver `LICENSE` en la raíz del repositorio.
