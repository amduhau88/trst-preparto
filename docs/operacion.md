# Operación — el día a día

Guía para usar y mantener el sistema **sin tener que leer el código**.

## Qué es cada cosa

| Pieza | Dónde vive | Para qué |
|---|---|---|
| App de la tablet | https://amduhau88.github.io/trst-preparto/pwa/ | Donde el operario carga el parto |
| Planilla | [`TRST — Partos`](https://docs.google.com/spreadsheets/d/12da8wxy4tJVLHuJZp-MKlornbi2U11ISWEsgglencE8/edit) | **Es la base de datos** |
| ├ `Registros` | pestaña | Ahí caen los renglones. Uno por ternero |
| └ `Datos Carga DC` | pestaña | **La vista para cargar en DairyComp.** Es donde trabajás vos |
| Backend | Apps Script adjunto a la planilla | Recibe de la tablet, valida y escribe |
| Código | https://github.com/amduhau88/trst-preparto | Todo el proyecto |

No hay servidor propio ni costo mensual.

## Lo que vas a necesitar hacer seguido

### Cargar en DairyComp

Abrir **`Datos Carga DC`**. Las columnas están en el orden en que se carga en
DairyComp, con el sexo pegado al ID del ternero (`H25045`, `M25045`) y el método
(`Sonda`) ya puesto.

Cuando terminás de cargar un renglón, **tildá `Cargado a DC`**. El tilde queda
guardado y no se pierde aunque después se corrija el parto.

La vista se rehace sola cada vez que entra o se corrige un parto, y además cada
10 minutos. **No la edites salvo en dos columnas**: `Asignacion Rodeo` y
`Cargado a DC`. El resto sale de `Registros` y se va a pisar.

### Asignar el rodeo

**En `Datos Carga DC`**, columna `Asignacion Rodeo`. Lo que escribís ahí baja
solo a `Registros`. No se carga en la tablet: el rodeo se decide acá.

### Agregar un operario

Escribirlo en la hoja **`Maestro`, columna A**, debajo de Trini. Nada más.
Las tablets lo toman solas la próxima vez que abren con señal.

Lo mismo para cualquier otra lista: razas (columna G), tambos (Q).
**Una columna vacía significa "sin restricción".**

### Dar de alta una tablet

1. Abrir la URL en **Safari** (iPad) o Chrome (Android)
2. **Acceder con Google** — sólo entran cuentas `@admin.com.ar`
3. Compartir → **Agregar a inicio**
4. Abrirla desde el ícono: tiene que verse sin la barra del navegador

Detalle completo en [`puesta-en-tablet.md`](puesta-en-tablet.md).

### Cambiar de usuario en una tablet

El **chip con el nombre**, arriba a la derecha: *Cambiar de usuario* o *Cerrar
sesión*. Los partos que estén esperando **no se pierden**: la cola es de la
tablet, no de la cuenta, y en la columna Operario sigue figurando quien los cargó.

### Sacar a alguien del sistema

Suspender o borrar su cuenta de Google Workspace. No hay nada que tocar en la app:
si la cuenta deja de existir, deja de poder sincronizar.

### Pesar un ternero

El peso **no se carga con el parto**: el ternero se pesa más tarde. El parto entra
a la planilla al instante con la columna I vacía, y el peso se agrega después.

En la tablet, **Partos del día** muestra los que faltan pesar con un botón **Pesar**
y una marca en la fila. El contador de arriba dice cuántos son. El peso lo carga
**quien cargó el parto** — si lo intenta otro, la app dice de quién es.

### Corregir un parto del día

Mismo lugar: el botón **Corregir** de cada renglón abre el parto en el formulario
con el que se cargó. Se pueden cambiar **el código de sexo, el peso, el calostro y
el tambo**. Lo demás queda a la vista pero bloqueado.

Se corrigen los partos **cargados hoy**, incluso si la fecha del parto es de ayer.
Un parto cargado ayer ya no se toca desde la tablet: eso lo arreglás en la planilla.

**Corregir el código de sexo puede agregar o sacar una cría**, porque el código dice
cuántas hay. Si agrega, se pide el ID y la raza de la cría nueva. Si saca, la tablet
**pide confirmación nombrando la cría** y ese renglón queda **anulado**, no borrado:
sigue en `Registros` con `Anulada = Si`, sale de la vista DC y su contenido anterior
queda entero en `_log`.

**Lo que la tablet no corrige:** ID de ternero, raza, hora y tipo de parto —salvo el
ID y la raza cuando el sexo cambió, porque una cría nueva necesita caravana. Todo eso
se corrige en la planilla.

Cada corrección deja su propio renglón en `_log`, con quién la hizo y qué cambió.
El renglón original nunca se pisa.

### Ver los partos de todas las tablets

**Partos del día** muestra lo cargado en esta tablet **y lo que cargaron las demás**,
leyendo de la planilla. Los de otra tablet se ven pero no se corrigen desde acá: la
corrección viaja con el registro local, que en esta tablet no existe.

Sin señal se muestra sólo lo de esta tablet, y la pantalla lo dice.

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

La columna **Estado** de cada fila dice una sola cosa: si ese parto está en la
planilla. Que falte pesar es otra cosa y se marca aparte.

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
5. **¿Está en `Registros` pero no en `Datos Carga DC`?** ¿La cría quedó anulada por un
   cambio de sexo? Si no, esperá 10 minutos: el reloj reconstruye la vista.

**Un parto cargado no se pierde**: queda en la tablet hasta que la planilla lo confirma.

## Reglas que aplica el sistema

- **Una fila por ternero.** Parto simple = 1 fila. Mellizos = 2, con el mismo `ID Parto`.
- **Lo que produjo la madre es del parto** (calidad, si se mejoró, litros): se carga una
  vez y se repite igual en las dos filas de un mellizo. **Lo que tomó cada ternero es de
  la cría**: de qué vaca salió, con cuántos Brix y cuántos litros.
- **Cría muerta**: `---` de G a Q, pero queda registrado qué era y que nació muerta.
- **El código del parto y el sexo tienen que coincidir**: el 2 es hembra+hembra,
  el 8 es M+M o M+H. La combinación imposible se rechaza explicando cuál es la correcta.
- **Calostro**: un número entero o una excepción (mastitis / sangre / campo). Nunca un rango.
  **`0` quiere decir "no se midió / no hubo calostro"**, y no admite `Mejorado = Si`.
- **Nada entra dos veces**: cada parto lleva un identificador único y la planilla lo verifica.
  Cambiar el sexo lleva además su propio identificador de operación, por el mismo motivo.
- **El peso llega después**: columna I vacía es "falta pesar", y es distinto de `---`,
  que significa cría muerta.
- **Corregir no mueve renglones.** La única excepción es cambiar el código de sexo, que va
  por su propia puerta y **anula** en vez de borrar.
- **La vista DC se replica por clave, nunca por posición**: el rodeo y el tilde siguen a su
  cría aunque un cambio de sexo inserte filas en el medio.

## Si hay que cambiar el código

| Cambió | Qué hacer |
|---|---|
| `pwa/*` (pantalla) | Nada: al pushear, GitHub Pages publica solo. **Subir `CACHE` en `pwa/sw.js`** o las tablets siguen con la versión vieja |
| `apps-script/Codigo.gs` | **Subir `VERSION`** (y `VERSION_ESPERADA` en `verificar.sh`), pegar en el editor y redeployar con el lápiz (ver README) |

Antes de tocar producción:

```bash
node apps-script/test_local.js     # lógica del backend, sin deployar
node pwa/test_pwa.js               # la app en Chrome, incluido el modo sin señal
source config.local && ./scripts/verificar.sh "$URL"   # contra la planilla real
```

`verificar.sh` corta si la versión publicada no es la del repo, y también si el
**encabezado de `Registros` no coincide con el que espera el código**: el backend
escribe por posición, así que una columna insertada a mano corrompería en silencio.

## Decisiones que quedaron abiertas

Ninguna bloquea el uso. Si algún día aparecen en la práctica:

- Códigos de **sexo 3 y 5**: la lista salta del 2 al 4 y del 4 al 6
- Dónde vive **`campo`** como tipo de parto (hoy aparece en la columna MELLIZOS del histórico)
- Validar que el **ID de vaca exista**: requiere cruzar contra el padrón de DairyComp
- Si **mastitis / sangre / campo** deberían bloquear `Mejorado = Si`, como ya lo hace el `0`
