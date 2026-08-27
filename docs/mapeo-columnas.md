# Mapeo campo → columna

Hoja `Registros` de la planilla [`TRST — Partos`](https://docs.google.com/spreadsheets/d/12da8wxy4tJVLHuJZp-MKlornbi2U11ISWEsgglencE8/edit).
(Hasta r5 la pestaña se llamaba `NUEVO FORMATO PREPARTO`.)

**A–T es lo que se lee y se carga.** De U en adelante, los datos por cría y las
columnas técnicas; se pueden ocultar sin afectar nada.

La vista que usa Nahuel para cargar en DairyComp es **`Datos Carga DC`**, no ésta.

## Bloques

| Col | Encabezado | Campo en la tablet | Valores permitidos | Origen de la lista |
|---|---|---|---|---|
| A | Operario | Operario | Julio · Griselda · Martin · Trini | `Maestro!A` |
| B | ID Vaca | ID Vaca | Número (texto) | libre |
| C | Fecha Parto | Fecha de parto | Fecha real, `dd/MM/yyyy` | precargada con el día |
| D | Hora Nacimiento | Hora de nacimiento | `00:00`–`23:30`, cada 30 min | `Maestro!I` |
| E | Tipo Parto | Tipo de parto | 1 Normal · 2 Asistido · 4 Cesarea | `Maestro!D` |
| F | Sexo, Vivo, Mellizos | Sexo / vivo / mellizos | 1 · 2 · 4 · 6 · 7 · 8 | `Maestro!E` |
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

**`0` en J significa "no se midió / no hubo calostro"**, no un valor bajo. Con 0 no
se admite `Mejorado = Si`: no hay nada que mejorar.

### Calostro suministrado al ternero — **de la cría** (N–Q)

En un parto doble las dos filas pueden tener origen, calidad y litros distintos.

| Col | Encabezado | Valores | Origen |
|---|---|---|---|
| N | Origen Calostro | `Propia madre` · `Otra vaca` | fijo en el código |
| O | ID Vaca Origen Calostro | Con `Propia madre` lo escribe la app (es la vaca que parió); con `Otra vaca`, el operario | libre |
| P | Calidad Calostro Ternero | Los Brix de lo que **efectivamente tomó** | `Maestro!J` |
| Q | Lts Calostro para Ternero | 2 a 6 | `Maestro!O` |

Con `Otra vaca`, la app consulta la planilla y muestra los Brix que quedaron
registrados cuando esa vaca parió — el mejorado si se mejoró, si no el natural.
**El campo nunca se bloquea**: sin señal, o si esa vaca no está en la planilla, se
carga a mano y el parto entra igual. Un parto no puede depender de una consulta.

### Destino y notas (R–T)

| Col | Encabezado | Nota |
|---|---|---|
| R | Tambo Vaca | 1 · 2 · 3 · 4 — `Maestro!Q` |
| S | Asignacion Rodeo Vaca | **No se carga en la tablet.** Nahuel lo escribe en `Datos Carga DC` y se replica acá |
| T | Notas | Texto libre |

### Por cría (U–V)

Nacen de un hueco real del formato: con el código `8 Otros Gemelos (M+M o M+H)`
no había forma de saber qué fue cada cría, ni de anotar que una nació muerta.

| Col | Encabezado | Valores |
|---|---|---|
| U | Sexo Cria | `Macho` · `Hembra`. Se deduce del código del parto salvo en el 8, donde se pregunta |
| V | Estado Cria | `Vivo` · `Muerto` |

### Técnicas (W–AC)

| Col | Encabezado | Para qué |
|---|---|---|
| W | ID Parto | `yyyyMMdd-idvaca-xxxx`. Agrupa las filas de un parto doble. |
| X | Cria | `1/1`, o `1/2` y `2/2` en mellizos |
| Y | UUID | Clave anti-duplicados generada en la tablet |
| Z | Cargado en | Momento real de la carga (puede ser anterior a la sincronización) |
| AA | Dispositivo | Qué tablet lo cargó |
| AB | Anulada | `Si` cuando una cría se anuló al corregir el sexo del parto |
| AC | Cargado a DC | Lo tilda Nahuel desde `Datos Carga DC` |

## Reglas

- **Una fila por ternero.** Parto simple = 1 fila. Mellizos (sexo `2` u `8`) = 2 filas,
  mismo `ID Parto`.
- **Lo de la madre (J–M) es del parto**; lo del ternero (N–Q) es de cada cría.
- **Cría muerta** (sexo `4` o `7`, o marcada muerta en un parto doble): **G a Q** van
  en `---`, pero U y V siguen registrando **qué era y que nació muerta**.
- **`Mejorado = No`** ⇒ L en `---`. `Mejorado = Si` ⇒ L obligatoria.
- **Nunca un rango** en calostro (el `23-26` de la planilla vieja no es válido).
- **Columna vacía en `Maestro` = sin restricción**: el backend acepta cualquier valor.
  Es a propósito, para completar la planilla de a poco.
- **El backend escribe por posición.** Si alguien inserta o mueve una columna, seguiría
  escribiendo donde estaba. `?action=esquema` compara la fila 1 contra el encabezado
  esperado y `scripts/verificar.sh` corta si no coinciden.

## Formatos de celda ya aplicados

B, D, G, O, W, X, Y como **texto** (para que los IDs no se vuelvan `4525.0` como en la
planilla vieja); C como fecha `dd/MM/yyyy`; Z como `dd/MM/yyyy HH:mm`.
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
parto entra con la columna vacía y el peso se agrega desde *Partos del día*. Vacío es
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
