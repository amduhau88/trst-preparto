# Mapeo campo → columna

Hoja `Registros` de la planilla [`TRST — Partos`](https://docs.google.com/spreadsheets/d/12da8wxy4tJVLHuJZp-MKlornbi2U11ISWEsgglencE8/edit).
(Hasta r5 la pestaña se llamaba `NUEVO FORMATO PREPARTO`.)

**A–S es lo que se lee y se carga.** De T en adelante, la caravana, las notas, los datos
por cría y las columnas de control. Las técnicas (Y, Z, AA, AC) se pueden ocultar sin afectar nada;
**`Fecha y Hora de Carga` (AB) no**, que es la que dice cuándo se cargó cada parto.

La vista que usa Nahuel para cargar en DairyComp es **`Datos Carga DC`**, no ésta.

## Bloques

| Col | Encabezado | Campo en la tablet | Valores permitidos | Origen de la lista |
|---|---|---|---|---|
| A | Operario | Operario | Julio · Griselda · Martin · Trini | `Maestro!A` |
| B | ID Vaca | ID Vaca | Número (texto) | libre |
| C | Fecha Parto | Fecha de parto | Fecha real, `dd/MM/yyyy` | precargada con el día |
| D | Hora Nacimiento | Hora de nacimiento | `00:00`–`23:30`, cada 30 min | `Maestro!I` |
| E | Tipo Parto | Tipo de parto | 1 Normal · 2 Asistido · 4 Cesarea · Aborto en Preparto (texto) | `Maestro!D` |
| F | Sexo, Vivo, Mellizos | Sexo / vivo / mellizos | 1 · 2 · 4 · 6 · 7 · 8. **Con Aborto en Preparto esta columna va en `---`**: el aborto se carga en el bloque «Ternero(s) muertos» | `Maestro!E` |
| G | ID Ternero | ID Ternero | Número (texto); `---` si nació muerto | libre |
| H | Raza | Raza | Holando · Angus | `Maestro!G` |
| I | Peso Ternero (Kg) | Peso (2º paso) | 25 a 60; **vacía** hasta que se pesa | `Maestro!H` |

### Calostro de la vaca parida — **del parto** (J–M)

Lo produjo la vaca, no la cría: se carga **una sola vez** y se repite igual en las
dos filas de un mellizo.

| Col | Encabezado | Valores | Origen |
|---|---|---|---|
| J | Calidad Calostro Sin Mejorar | `0`, o 18 a 35, o mastitis / sangre / campo | `Maestro!J` |
| K | Mejorado | Si · No | `Maestro!K` |
| L | Calidad de Calostro Mejorado | `---`, o 26 a 35 (solo con K = Si) | `Maestro!L` |
| M | Lts Calostro Madre Produjo | 0 a 20 | `Maestro!N` |
| N | Calostro Mejorado | Copia de K (Si · No). `---` en cría muerta. **No se carga en la tablet**: lo calcula el backend (r10) | — |

**`0` en J significa "no se midió / no hubo calostro"**, no un valor bajo. Con 0 no
se admite `Mejorado = Si`: no hay nada que mejorar.

### Calostro suministrado al ternero — **de la cría** (O–R)

En un parto doble las dos filas pueden tener origen, calidad y litros distintos.

| Col | Encabezado | Valores | Origen |
|---|---|---|---|
| O | Origen Calostro | `Propia madre` · `Otra vaca` | fijo en el código |
| P | ID Vaca Origen Calostro | Con `Propia madre` lo escribe la app (es la vaca que parió); con `Otra vaca`, el operario | libre |
| Q | Calidad Calostro Ternero | Los Brix de lo que **efectivamente tomó** | `Maestro!J` |
| R | Lts Calostro para Ternero | 2 a 6 | `Maestro!O` |

Con `Otra vaca`, la app consulta la planilla y muestra los Brix que quedaron
registrados cuando esa vaca parió — el mejorado si se mejoró, si no el natural.
**El campo nunca se bloquea**: sin señal, o si esa vaca no está en la planilla, se
carga a mano y el parto entra igual. Un parto no puede depender de una consulta.

### Destino, caravana SENASA y notas (S–V)

| Col | Encabezado | Nota |
|---|---|---|
| S | Tambo Vaca | 1 · 2 · 3 · 4. **`19 - Rechazos` no va acá**: se guarda en T (Asignación Rodeo) y S queda vacía (solo con aborto) — `Maestro!Q` |
| T | Asignacion Rodeo Vaca | **No se carga en la tablet.** Nahuel lo escribe en `Datos Carga DC` y se replica acá |
| U | Caravana SENASA | **6 dígitos exactos**, por cría. Obligatoria para toda cría viva cargada desde la app v15 (`formato: 2`); `---` en cría muerta; **vacía en el histórico** anterior al 14/09/2026. Texto (conserva el 0 inicial) |
| V | Notas | Texto libre |

### Por cría (W–X)

Nacen de un hueco real del formato: con el código `8 Otros Gemelos (M+M o M+H)`
no había forma de saber qué fue cada cría, ni de anotar que una nació muerta.

| Col | Encabezado | Valores |
|---|---|---|
| W | Sexo Cria | `Macho` · `Hembra` · `Desconocido` (aborto con sexo no cargado). Se deduce del código del parto salvo en el 8, donde se pregunta |
| X | Estado Cria | `Vivo` · `Muerto` (también en un aborto) |

### Control y técnicas (Y–AE)

**`Fecha y Hora de Carga` (AB) es la hora del corral**, no la de la sincronización: un
parto cargado sin señal a las 3 de la mañana puede llegar a la planilla a las 9, y en AB
van las 3. Es distinta de `Fecha Parto` (C), que es cuándo nació el ternero.

Solo la escribe el **alta**. Pesar en el segundo paso, corregir el calostro o cambiar el
código de sexo son pasos posteriores y no la tocan; una cría agregada al corregir el
sexo hereda la marca del parto, no la del momento en que se agregó.


| Col | Encabezado | Para qué |
|---|---|---|
| Y | ID Parto | `yyyyMMdd-idvaca-xxxx`. Agrupa las filas de un parto doble. Un admin que cambie fecha o vaca lo recalcula. |
| Z | Cria | `1/1`, o `1/2` y `2/2` en mellizos |
| AA | UUID | Clave anti-duplicados generada en la tablet |
| AB | **Fecha y Hora de Carga** | Cuándo el operario apretó **Guardar** en la tablet |
| AC | Dispositivo | Qué tablet lo cargó |
| AD | Anulada | `Si` cuando una cría se anuló al corregir el sexo del parto |
| AE | Cargado a DC | Lo tilda Nahuel desde `Datos Carga DC` |

Layout **r7** (desde el 14/09/2026): la columna T se insertó con `migrarR7()`; el respaldo previo quedó
en `Registros_backup_r6`. En `Datos Carga DC` la caravana SENASA va en la columna **I**, a la derecha
de ID Ternero, y corren un lugar las que le siguen (Rodeo pasa a P, Cargado a DC a Q).

Layout **r10** (desde el 09/10/2026): la columna **N (Calostro Mejorado)** se insertó con
`migrarCalostroMejoradoR10(true)`; el respaldo previo quedó en `Registros_backup_r9`. Todo lo que está
desde N en adelante corre un lugar. En `Datos Carga DC` la columna **N (Método)** queda oculta
(`ocultarMetodoDC()`); el dato sigue estando.

## Reglas

- **Una fila por ternero.** Parto simple = 1 fila. Mellizos (sexo `2` u `8`) = 2 filas,
  mismo `ID Parto`.
- **Lo de la madre (J–N) es del parto**; lo del ternero (O–R) es de cada cría.
- **Aborto en Preparto**: bloque propio «Ternero(s) muertos». Cantidad de crías (1 o 2) y, por cría, **raza obligatoria** y sexo opcional (Macho / Hembra; sin elegir queda `Desconocido`). Una fila por cría, con `Estado Cria = Muerto`; G, I y J–R van en `---`, salvo la raza en H.
- **Otros gemelos (8) con las dos crias muertas** es válido: cada cría lleva su sexo (M+M o M+H), va en `Muerto`, y el calostro de la madre (J–N) **se conserva** en las dos filas. Si solo una cría muere, la muerta sigue con G–R en `---`.
- **Cría muerta** (sexo `4` o `7`, o marcada muerta en un parto doble): **G a R** van
  en `---`, pero V y W siguen registrando **qué era y que nació muerta**. 
- **Aborto en Preparto** (tipo de parto): una fila por cría muerta. El sexo es opcional y solo puede ser
  muerto (4 o 7); `1`, `2`, `6` y `8` no se aceptan. La raza es opcional y es lo único
  que se guarda de la cría (H); el resto de G a R va en `---`. No hay calostro. Tambo puede ser
  `19 - Rechazos`, que solo se acepta con aborto.
- **`Mejorado = No`** ⇒ L en `---`. `Mejorado = Si` ⇒ L obligatoria.
- **Nunca un rango** en calostro (el `23-26` de la planilla vieja no es válido).
- **Columna vacía en `Maestro` = sin restricción**: el backend acepta cualquier valor.
  Es a propósito, para completar la planilla de a poco.
- **El backend escribe por posición.** Si alguien inserta o mueve una columna, seguiría
  escribiendo donde estaba. `?action=esquema` compara la fila 1 contra el encabezado
  esperado y `scripts/verificar.sh` corta si no coinciden.

## Formatos de celda ya aplicados

B, D, G, P, Y, Z, AA, U como **texto** (para que los IDs no se vuelvan `4525.0` como en la
planilla vieja); C como fecha `dd/MM/yyyy`; AB como `dd/MM/yyyy HH:mm`.
Los aplica `configurarFormatos()`.

## Pendientes de definir

| # | Qué | Estado hoy |
|---|---|---|
| 1 | Códigos de **sexo 3 y 5** | La lista salta 1, 2, 4, 6, 7, 8 |
| 2 | Dónde vive **`campo`** como tipo de parto | Anotado en el propio `Maestro`; hoy aparece en MELLIZOS |
| 3 | Validar que el **ID de vaca** exista | Requiere cruzar contra el padrón de DairyComp |
| 4 | Si **mastitis / sangre / campo** deberían bloquear `Mejorado = Si`, como lo hace el `0` | Hoy no lo bloquean |

## Decisiones ya tomadas

**El calostro de la madre no es de la cría (r6).** J, K y L describen lo que produjo
la vaca. Estaban cargadas por cría, así que en un mellizo se podían escribir dos
calidades distintas para la misma madre. Lo que sí es de cada cría es **lo que tomó**,
y eso ahora tiene sus propias columnas.

**Desapareció `Calostro Consumido al Momento` (r6).** No se usaba para nada.

**Rodeo: sale de la tablet.** El operario no lo carga. Desde r6 lo escribe Nahuel en
`Datos Carga DC` y se replica a la columna S por clave `uuid|cria`, nunca por posición
—corregir el sexo de un parto puede insertar filas en el medio.

**Peso (col. I): se carga en un segundo paso.** El ternero se pesa más tarde, así que el
parto entra con la columna vacía y el peso se agrega desde *Partos cargados*. Vacío es
"falta pesar" — un tercer estado, distinto de `---` y de un número. Lo carga quien cargó
el parto.

**Corregir el sexo va por su propia acción.** `editar` sigue sin agregar ni borrar
renglones nunca; `cambiar_sexo` es la única que puede agregar una cría o anular una.
**No borra**: la cría que sobra queda con G–Q en `---` y `Anulada = Si`, fuera de la
vista DC y de los KPIs, con el estado previo guardado en `_log`.

**Operarios: son cuatro** — Julio, Griselda, Martin, Trini. Adrián (382 partos) y Jorge (5)
aparecen en el histórico 2026 pero ya no están en el tambo.

## Cómo se agrega un operario o una raza

Se escribe en la hoja `Maestro`, en la columna que corresponda. **Nada más.** Las tablets
lo toman solas la próxima vez que abren con señal: no hace falta redeployar, ni tocar el
código, ni reinstalar nada.
