---
name: preparto-diagnostico
version: "0.0.1"
description: Diagnóstico de solo lectura de la app TRST Preparto (tablet de partos → Apps Script → Sheet «TRST — Partos») cuando «no sincroniza», un parto no sube o la tablet muestra un error. Cruza backend, PWA publicada, planilla, _log y la cola exportada desde la tablet, y entrega causa + recuperación paso a paso. Usar cuando Andrés diga «la tablet no sincroniza», «el parto 1576 no sube», «error en preparto», «diagnosticá preparto». Arg opcional - id de vaca o uuid.
user-invocable: true
argument-hint: "[id de vaca | uuid]"
---

# Preparto — Diagnóstico

Herramienta: `~/trst-tools/preparto/scripts/diagnostico.py` (solo lectura).
Contexto del proyecto: brief [[TRST - Digitalizacion Preparto]], memoria `project_trst_preparto_app.md` y `reference_trst_preparto_operacion.md`.

## Pasos

### 1. Pedir los datos de la tablet (en paralelo con el paso 2)

Lo que vive en la tablet no se ve desde la Mac. Con AskUserQuestion pedir:

- **Volcado de la cola:** en la tablet, chip de cuenta (arriba a la derecha) → **Copiar partos sin sincronizar** → mandarlo por WhatsApp o mail y pegarlo acá, o guardarlo en `~/Downloads/`. Si dice «No hay partos sin sincronizar», anotarlo: es un dato.
- **Captura de la fila con el error**, en *Partos cargados*: el texto rojo debajo del parto y la etiqueta de la fila (*Revisar*, *solo admin*, etc.).
- **Qué dice Diagnóstico** en la tablet: versión de la app (`preparto-vNN`) y estado de la sesión.

**Por qué la captura:** el volcado solo trae registros con `estado ≠ ok` o con una corrección pendiente. Un parto que la tablet ya dio por subido y quedó en *Revisar* (el caso de la 1576 del 7/10) **no aparece** en el volcado.

No frenar el diagnóstico esperando: correr el paso 2 y sumar la cola cuando llegue.

### 2. Correr el script

```
cd ~/trst-tools/preparto && python3 scripts/diagnostico.py [--vaca N | --uuid U] [--cola ARCHIVO.json]
```

`$ARGUMENTS`: si es numérico va como `--vaca`, si tiene guiones como `--uuid`. Si el usuario pegó el JSON en el chat, guardarlo en el scratchpad y pasarlo con `--cola`.

El script informa:
1. Backend: ping del `/exec` vs `VERSION` de `apps-script/Codigo.gs`.
2. PWA: `app.js`, `sw.js` e `index.html` publicados vs repo.
3. Planilla: última fila de `_log`.
4. Anomalías:
   - uuids con solo rechazos y sin filas, con la marca RESUELTO/PENDIENTE según la vaca tenga un parto activo ese día;
   - `recibido` sin filas;
   - misma vaca y fecha con dos partos activos.
5. El parto pedido: filas en `Registros` (con `anulada`) e historia en `_log` con el payload, sin token.
6. La cola: tipo, estado, intentos, si está en `Registros` / `_log`, y aviso de cola trabada.

### 3. Interpretar

Mapear lo encontrado al mensaje de la tablet (`sincronizar()` en `pwa/app.js`):

| Mensaje en la tablet | Qué significa | Cómo se confirma |
|---|---|---|
| «ese parto ya no está en la planilla: la corrección no se puede aplicar» | El uuid no tiene filas activas: el alta nunca entró (rechazo) o la fila se borró a mano | Sección 4/5: uuid con solo `rechazado` o sin nada en `Registros` |
| «corrección rechazada: solo se corrigen partos cargados hoy» | El operario corrigió un parto cargado otro día | Lo rehace un admin desde *Corregir* |
| «corrección rechazada: …» / «cambio de sexo rechazado: …» | Validación del backend sobre una edición | El motivo viene en el texto |
| Error en rojo en un alta + *Revisar* | Validación del alta (falta un dato, valor fuera de lista) | `_log` con `rechazado: <motivo>` |
| «Sesión vencida» | Credencial caída; el backend no loguea esos intentos | `_log` quieto + Diagnóstico de la tablet |
| Muchos intentos en uno y 0 en los de atrás | Cola trabada delante | Sección 6 |
| Nada llega y `_log` quieto, sin rechazos | Red, sesión o tablet con versión vieja | Versión en Diagnóstico vs `CACHE` del repo |

Si backend o PWA **no coinciden** con el repo, ese es el primer hallazgo: hay un deploy a medias.

### 4. Veredicto

Responder en español, corto:
- **Causa**, con evidencia: fila de `_log`, uuid, motivo.
- **Recuperación paso a paso:**
  - fantasma → admin *Rechazar* en la tablet;
  - parto no subido → recargarlo con el dato que faltaba;
  - cola trabada → login admin o *Rechazar* el registro de adelante.
- **Si es un bug de la app** (la PWA dejó guardar algo que el backend rechaza, o una regla de la cola), decirlo y proponer el fix. Arreglarlo es otra tarea: no editar código desde esta skill sin confirmación.
- Anomalías laterales nuevas, como duplicados que no estén ya en el brief, en una línea.

## Rules

- **Solo lectura.** No escribir en la planilla, no correr `scripts/verificar.sh` (escribe filas), no llamar acciones POST del backend.
- Nunca mostrar ni guardar `id_token`, `sesion_token` ni el token de scripts. El script ya los saca del payload.
- Nunca borrar filas de `Registros` para «arreglar»: un parto se saca con *Rechazar* (`Anulada = Si`).
- Leer la planilla solo con el script o con gws vía `subprocess` de Python: los rangos llevan `!`.
- No concluir «el parto nunca salió de la tablet» sin haber pedido el volcado y la captura.
- Si se edita esta SKILL.md, copiarla a `~/trst-tools/preparto/claude-skill/SKILL.md` y commitear: esa copia es el respaldo versionado.
- Si hay dudas sobre qué hace el backend, la fuente es `apps-script/Codigo.gs` del repo, siempre que el ping confirme que la versión publicada es la misma.

## Dependencies

### Required
- **cli gws** — lectura de `Registros` y `_log`. Install: `~/bin/gws`, autenticado como `andresduhau@admin.com.ar`.
- **helper-script diagnostico.py** — `~/trst-tools/preparto/scripts/diagnostico.py`; lee `config.local` (URL del `/exec`) y el repo.
- **external-service** Apps Script `/exec` + GitHub Pages `amduhau88.github.io/trst-preparto/pwa/` — ping y diff (GET públicos).

### Optional
- **Volcado de la cola de la tablet** — sin él, el diagnóstico solo ve lo que llegó al backend. Fallback: se informa lo del lado servidor y se marca como «falta el lado tablet».

### Vault Conventions
- Hallazgos que cambian el estado del proyecto van al Log de [[TRST - Digitalizacion Preparto]] (vía `/session-close`, no desde esta skill).

### Does NOT Require
- No MCPs, no desktop apps, no escritura en Google Sheets, no token de scripts.

## Related Skills
- [[session-close]] — después de un diagnóstico con fix, para registrar en el brief.
