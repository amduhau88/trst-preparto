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

En la tablet, **Partos cargados** muestra los que faltan pesar con un botón **Pesar**
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

**Partos cargados** muestra lo cargado en esta tablet **y lo que cargaron las demás**,
leyendo de la planilla. Los de otra tablet se ven pero no se corrigen desde acá: la
corrección viaja con el registro local, que en esta tablet no existe.

Sin señal se muestra sólo lo de esta tablet, y la pantalla lo dice.

### Saber cuándo se cargó un parto

Columna **`Fecha y Hora de Carga`** de `Registros`. Es **cuándo el operario apretó
Guardar en la tablet**, no cuándo el parto llegó a la planilla: uno cargado sin señal a
las 3 de la mañana puede sincronizar a las 9, y ahí van a figurar las 3.

No la mueve nada de lo que pase después — ni pesar, ni corregir el calostro, ni cambiar
el código de sexo. Es la hora del corral y se queda quieta.

Ojo con una consecuencia: la ventana para corregir un parto desde la tablet mira **esta**
columna, no `Fecha Parto`. Por eso un parto de ayer cargado esta mañana todavía se
corrige, y uno cargado ayer ya no.

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

## Antes de borrar datos, desinstalar o reinstalar la app

Los partos sin sincronizar viven **sólo en el almacenamiento local de esa tablet**. Borrar los
datos del sitio, desinstalar la app o borrar el ícono (en iPad la app instalada tiene su propio
almacenamiento) los pierde. Antes de cualquiera de esas cosas: tocar el **chip de cuenta** (arriba
a la derecha) → **Copiar partos sin sincronizar**, y mandar ese texto por WhatsApp o guardarlo.
Lo ve cualquier usuario, no hace falta ser admin (el admin también lo tiene en Ajustes). Trae cada
parto en cola con su uuid, estado, el último error y el payload completo, sin credenciales. Con eso
se pueden recargar a mano los que falten.

La cola sube en orden de carga. Si el backend rechaza **un** registro, se anota el error y se sigue
con el siguiente (desde `preparto-v13`; antes ese registro trababa a todos los de atrás). Solo tres
errores seguidos cortan la tanda, porque entonces es el servidor y no el registro. El texto del
error queda en rojo debajo del parto. Para verlos todos juntos, de cualquier fecha: **Partos
cargados → chip «Sin sincronizar»** (el número del chip es la cola). Desde ahí se corrigen con
*Corregir* sin que el formulario les cambie la fecha. Ese texto en rojo es lo primero que hay que leer.

Si el backend dice `no existe el parto` (la fila se borró a mano de `Registros`), la corrección pasa
a **Revisar** y deja de reintentar. Un **admin** ve el botón **Descartar** en **cualquier registro sin
sincronizar** (desde `preparto-v14`): un alta pendiente o rechazada se borra de la tablet (nunca entró
a la planilla; si hace falta se carga de nuevo); una corrección pendiente o en Revisar se limpia sin
tocar la planilla. Los operarios no lo tienen. Como la cola es de la tablet y no de la cuenta, el
admin entra en la tablet con su cuenta (chip → Cambiar de usuario), descarta y devuelve la sesión.
La fila muestra el último error en rojo y cuántos intentos lleva, para saber por qué no sube antes
de descartar.

En **Partos cargados**, el chip **Otro día** abre un calendario para ver cualquier fecha, con lo que
cargó esta tablet y lo que trajo la planilla.

## Cómo se mantiene la sesión en la tablet (desde r7)

Al entrar con Google, el backend entrega una **credencial propia de 30 días** (firmada con un secreto
que vive en Script Properties, `SESION_SECRETO`). La tablet sincroniza con esa credencial y **no
vuelve a depender del token de Google**, que dura una hora y cuya renovación silenciosa fallaba en el
corral: era el motivo del cartel `Sesión vencida` cada hora y de la cola que se acumulaba. Si a la
credencial le quedan menos de 7 días, el backend la renueva sola en cualquier respuesta: una tablet
que se usa no vuelve a pedir login. Ajustes → Diagnóstico muestra hasta cuándo vale.

- **Una tablet se perdió o hay que sacarle el acceso a todas:** en el editor de Apps Script correr
  `rotarSecretoSesion()`. Todas las tablets vuelven a pedir login una vez; la cola no se pierde.
- **Suspender la cuenta de Google de una tablet** ya no la corta en el acto: su credencial sigue
  valiendo hasta 30 días. Para cortarla ya, rotar el secreto.
- Una tablet con sesión anterior a r7 consigue la credencial sola la primera vez que sincroniza con
  el token de Google vigente; si ese token ya venció, con volver a entrar una vez alcanza.
- El camino de scripts (`token` compartido) no cambia.

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

### Publicar r6 sin frenar a los operarios

El backend se **niega a escribir** si la planilla todavía tiene el layout viejo, y lo
hace con un error de servidor, no de validación: la tablet deja el parto en la cola y
lo reintenta sola. Así el deploy y la migración no tienen que ser simultáneos, y nadie
deja de cargar partos en el corral.

Orden:

1. **`revisarMigracionR6()`** desde el editor — no escribe nada. Dice si el encabezado
   real es el de r5 columna por columna, cuántas filas hay y **cuántos rodeos están en
   juego**. Si algo no cierra, se planta y no migra.
2. Redeployar el backend con el lápiz. Desde acá y hasta el paso 3, los partos que se
   carguen quedan en la cola de las tablets. No se pierde ninguno.
3. **`migrarR6()`** — deja el respaldo en `Registros_backup_r5` y reescribe. Minutos.
   Al terminar, las colas se drenan solas.
4. **`configurarDC()`** — crea la vista. Se puede correr antes del paso 3: queda vacía
   hasta que la planilla esté migrada.
   El reloj de reconstrucción cada 10 min necesita el permiso `script.scriptapp`, que
   este proyecto no tiene. Si falla, el log dice cómo crearlo a mano desde el ícono del
   reloj — y no es grave: la vista se rehace con cada parto y con cada corrección, el
   reloj sólo cubre el caso de que alguna de esas pasadas falle. Agregar el permiso
   obliga a reautorizar el script, y con el web app publicado eso puede cortarle la
   sincronización a las tablets: no vale la pena por una red de seguridad.
5. `./scripts/verificar.sh "$URL"` y, recién ahí, pushear la PWA a `main`.

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
