# Mapeo campo → columna

Hoja `NUEVO FORMATO PREPARTO` de la planilla [`TRST — Partos`](https://docs.google.com/spreadsheets/d/12da8wxy4tJVLHuJZp-MKlornbi2U11ISWEsgglencE8/edit).

**A–S es el formato que lee Nahuel** y va a DairyComp — no se toca.
**T–X son técnicas**, agregadas por la app; se pueden ocultar sin afectar nada.

## Formato (A–S)

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
| I | Peso Ternero (Kg) | Peso | 25 a 60 | `Maestro!H` |
| J | Calidad Calostro Sin Mejorar | Calidad sin mejorar | 18 a 35, o mastitis / sangre / campo | `Maestro!J` |
| K | Mejorado | ¿Mejorado? | Si · No | `Maestro!K` |
| L | Calidad de Calostro Mejorado | Calidad mejorado | `---`, o 26 a 35 (solo con K = Si) | `Maestro!L` |
| M | Calostro Consumido al Momento | ¿Consumido al momento? | Si · No | `Maestro!M` |
| N | Lts Calostro Madre Produjo | Litros de la madre | 0 a 20 | `Maestro!N` |
| O | Lts Calostro para Ternero | Litros para el ternero | 2 a 6 | `Maestro!O` |
| P | ID Vaca Origen Calostro | Vaca origen del calostro | Número (texto) | `Maestro!P` — **vacía** |
| Q | Tambo Vaca | Tambo | 1 · 2 · 3 | `Maestro!Q` |
| R | Asignacion Rodeo Vaca | Rodeo asignado | — | `Maestro!R` — **vacía** |
| S | Notas Nahuel | Notas | Texto libre | único campo libre |

## Por cría (T–U)

Nacen de un hueco real del formato: con el código `8 Otros Gemelos (M+M o M+H)`
no había forma de saber qué fue cada cría, ni de anotar que una nació muerta.

| Col | Encabezado | Valores |
|---|---|---|
| T | Sexo Cria | `Macho` · `Hembra`. Se deduce del código del parto salvo en el 8, donde se pregunta |
| U | Estado Cria | `Vivo` · `Muerto` |

## Técnicas (V–Z)

| Col | Encabezado | Para qué |
|---|---|---|
| V | ID Parto | `yyyyMMdd-idvaca-xxxx`. Agrupa las filas de un parto doble. |
| W | Cria | `1/1`, o `1/2` y `2/2` en mellizos |
| X | UUID | Clave anti-duplicados generada en la tablet |
| Y | Cargado en | Momento real de la carga (puede ser anterior a la sincronización) |
| Z | Dispositivo | Qué tablet lo cargó |

## Reglas

- **Una fila por ternero.** Parto simple = 1 fila. Mellizos (sexo `2` u `8`) = 2 filas, mismo `ID Parto`.
- **Cada cría lleva lo suyo:** su sexo, su estado y **su propio calostro** (J, K, L, M, O, P).
  En un parto doble las dos filas pueden tener calidad, litros y vaca origen distintos.
- **`Lts Calostro Madre Produjo` (N) es del parto**, no de la cría: se carga una vez y se
  repite igual en las dos filas.
- **Cría muerta** (sexo `4` o `7`, o marcada muerta en un parto doble): G a P van en `---`,
  pero T y U siguen registrando **qué era y que nació muerta**.
- **`Mejorado = No`** ⇒ L en `---`. `Mejorado = Si` ⇒ L obligatoria.
- **Nunca un rango** en calostro (el `23-26` de la planilla vieja no es válido).
- **Columna vacía en `Maestro` = sin restricción**: el backend acepta cualquier valor.
  Es a propósito, para completar la planilla de a poco.

## Formatos de celda ya aplicados

B, D, G, P, V como **texto** (para que los IDs no se vuelvan `4525.0` como en la planilla vieja);
C como fecha `dd/MM/yyyy`; W como `dd/MM/yyyy HH:mm`.

## Pendientes de definir

| # | Qué | Estado hoy |
|---|---|---|
| 1 | Códigos de **sexo 3 y 5** | La lista salta 1, 2, 4, 6, 7, 8 |
| 2 | Dónde vive **`campo`** como tipo de parto | Anotado en el propio `Maestro`; hoy aparece en MELLIZOS |
| 3 | **Vaca origen calostro**: ¿existe pool/banco? | Si existe, necesita su propio valor |
| 4 | Validar que el **ID de vaca** exista | Requiere cruzar contra el padrón de DairyComp |

## Decisiones ya tomadas

**Rodeo (col. R): campo abierto, a propósito.** Los rodeos se van definiendo sobre la
marcha, así que `Maestro!R` queda vacía y el operario escribe el número. Lo único que se
exige es que **sea un número**, para que no vuelvan los `-` y `---` de la planilla vieja.

Si algún día se quiere cerrar la lista, se cargan los valores en `Maestro!R` y el campo
se convierte solo en un desplegable.

**Operarios: son cuatro** — Julio, Griselda, Martin, Trini. Adrián (382 partos) y Jorge (5)
aparecen en el histórico 2026 pero ya no están en el tambo.

## Cómo se agrega un operario o un rodeo

Se escribe en la hoja `Maestro`, en la columna que corresponda. **Nada más.** Las tablets
lo toman solas la próxima vez que abren con señal: no hace falta redeployar, ni tocar el
código, ni reinstalar nada.
