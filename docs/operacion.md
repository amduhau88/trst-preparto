# Operación — el día a día

Guía para usar y mantener el sistema **sin tener que leer el código**.

## Qué es cada cosa

| Pieza | Dónde vive | Para qué |
|---|---|---|
| App de la tablet | https://amduhau88.github.io/trst-preparto/pwa/ | Donde el operario carga el parto |
| Planilla | [`TRST — Partos`](https://docs.google.com/spreadsheets/d/12da8wxy4tJVLHuJZp-MKlornbi2U11ISWEsgglencE8/edit) | **Es la base de datos.** Ahí caen los renglones |
| Backend | Apps Script adjunto a la planilla | Recibe de la tablet, valida y escribe |
| Código | https://github.com/amduhau88/trst-preparto | Todo el proyecto |

No hay servidor propio ni costo mensual.

## Lo que vas a necesitar hacer seguido

### Agregar un operario

Escribirlo en la hoja **`Maestro`, columna A**, debajo de Trini. Nada más.
Las tablets lo toman solas la próxima vez que abren con señal.

Lo mismo para cualquier otra lista: razas (columna G), tambos (Q), rodeos (R).
**Una columna vacía significa "sin restricción"** — por eso hoy el rodeo es
campo abierto: se escribe a mano, y lo único que se exige es que sea un número.

### Dar de alta una tablet

1. Abrir la URL en **Safari** (iPad) o Chrome (Android)
2. **Acceder con Google** — sólo entran cuentas `@admin.com.ar`
3. Compartir → **Agregar a inicio**
4. Abrirla desde el ícono: tiene que verse sin la barra del navegador

Detalle completo en [`puesta-en-tablet.md`](puesta-en-tablet.md).

### Sacar a alguien del sistema

Suspender o borrar su cuenta de Google Workspace. No hay nada que tocar en la app:
si la cuenta deja de existir, deja de poder sincronizar.

## Cómo saber si algo anda mal

### Desde la tablet

El badge de arriba a la derecha dice siempre cómo está:

| Dice | Significa |
|---|---|
| **Sincronizado** | Todo al día |
| **N en espera** | Hay partos cargados que todavía no subieron. Normal sin señal |
| **Sin señal** | No hay conexión. Se puede seguir cargando igual |
| **Sesión vencida** | Hay que volver a iniciar sesión. **Los partos NO se pierden** |
| **N para revisar** | Un parto tiene un dato que la planilla rechazó. El motivo aparece en la lista del día |

### Desde la computadora

```bash
cd ~/trst-tools/preparto && source config.local && curl -sSL "$URL?action=ping"
```

Si devuelve `{"ok":true,...}` el backend está vivo.

La hoja **`_log`** registra todo lo que llegó, incluidos los rechazos con su motivo
y **quién** lo cargó. Es el primer lugar donde mirar si un parto "no aparece".

## Un parto no llegó a la planilla

En orden:

1. **¿El badge de la tablet dice "en espera"?** Todavía no subió. Con señal sube solo.
2. **¿Dice "Sesión vencida"?** Tocar el badge e iniciar sesión de nuevo.
3. **¿Dice "para revisar"?** El dato fue rechazado. El motivo está en la lista del día
   y en `_log`. Hay que corregirlo en la tablet.
4. **¿La tablet dice "Sincronizado" pero no está la fila?** Buscar el uuid en `_log`.
   Si no aparece, nunca llegó: revisar que la URL configurada sea la del deploy activo.

**Un parto cargado no se pierde**: queda en la tablet hasta que la planilla lo confirma.

## Reglas que aplica el sistema

- **Una fila por ternero.** Parto simple = 1 fila. Mellizos = 2, con el mismo `ID Parto`.
- **Cada cría lleva lo suyo**: sexo, si nació viva, y su propio calostro.
  Los litros que produjo la madre son del parto y se repiten en las dos filas.
- **Cría muerta**: `---` de G a P, pero queda registrado qué era y que nació muerta.
- **El código del parto y el sexo tienen que coincidir**: el 2 es hembra+hembra,
  el 8 es M+M o M+H. La combinación imposible se rechaza explicando cuál es la correcta.
- **Calostro**: un número entero o una excepción (mastitis / sangre / campo). Nunca un rango.
- **Nada entra dos veces**: cada parto lleva un identificador único y la planilla lo verifica.

## Si hay que cambiar el código

| Cambió | Qué hacer |
|---|---|
| `pwa/*` (pantalla) | Nada: al pushear, GitHub Pages publica solo. **Subir `CACHE` en `pwa/sw.js`** o las tablets siguen con la versión vieja |
| `apps-script/Codigo.gs` | **Subir `VERSION`**, pegar en el editor y redeployar con el lápiz (ver README) |

Antes de tocar producción:

```bash
node apps-script/test_local.js     # lógica del backend, sin deployar
node pwa/test_pwa.js               # la app en Chrome, incluido el modo sin señal
source config.local && ./scripts/verificar.sh "$URL"   # contra la planilla real
```

## Decisiones que quedaron abiertas

Ninguna bloquea el uso. Si algún día aparecen en la práctica:

- Códigos de **sexo 3 y 5**: la lista salta del 2 al 4 y del 4 al 6
- Dónde vive **`campo`** como tipo de parto (hoy aparece en la columna MELLIZOS del histórico)
- Si existe un **pool de calostro**: hoy se asume que siempre viene de una vaca identificada
- Validar que el **ID de vaca exista**: requiere cruzar contra el padrón de DairyComp
