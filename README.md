# TRST — Partos

App de carga de partos en tablet. El operario carga en el corral (funciona sin señal) y el
renglón cae limpio en la planilla de Google, listo para DairyComp.

**El Google Sheet es la base de datos.** No hay servidor propio ni costo mensual: el backend
es un Apps Script adjunto a la planilla, y el frontend es una PWA estática.

```
Tablet (PWA, GitHub Pages)  →  Apps Script /exec  →  Google Sheet «TRST — Partos»
   guarda en IndexedDB          verifica identidad       NUEVO FORMATO PREPARTO
   cola offline + reintentos    LockService + UUID       Maestro · _log
   sesion Google cacheada       sin duplicados
```

## Quién puede entrar

Sólo cuentas de Google **@admin.com.ar**. La PWA obtiene un ID token de Google y el
backend lo verifica contra `oauth2.googleapis.com/tokeninfo`, exigiendo tres cosas:
firma válida, `aud` == nuestro Client ID, y `hd` == el dominio. Sin las tres, no escribe.

**Autenticar y usar son cosas distintas.** Se inicia sesión una vez con señal; después la
sesión queda cacheada 30 días y la app abre y guarda partos en el corral sin conexión.
El ID token fresco se pide recién **al sincronizar**, no al guardar — así un parto que
estuvo dos días en la cola nunca viaja con una credencial vencida, y si la sesión se cayó
los partos **quedan en la cola en vez de perderse**.

Dos caminos de entrada:

| Quién | Cómo se autentica |
|---|---|
| Tablet / navegador | ID token de Google, dominio `@admin.com.ar` |
| Scripts (`verificar.sh`, crons) | Token compartido en Script Properties |

La pestaña **Ajustes** se le muestra sólo a los mails de la propiedad `ADMINS`. Esconder
la pestaña es cosmético; lo que protege de verdad es que `ver()` bloquea la vista y que
**el servidor valida cada request por su cuenta**.

Planilla: [`TRST — Partos`](https://docs.google.com/spreadsheets/d/12da8wxy4tJVLHuJZp-MKlornbi2U11ISWEsgglencE8/edit)
· ID `12da8wxy4tJVLHuJZp-MKlornbi2U11ISWEsgglencE8`

## Estructura

| Ruta | Qué es |
|---|---|
| `apps-script/Codigo.gs` | Backend: `doPost` (recibe partos), `doGet` (maestro, partos del día) |
| `apps-script/appsscript.json` | Manifiesto del proyecto Apps Script |
| `apps-script/test_local.js` | Pruebas de la lógica con Node, sin deployar nada |
| `pwa/` | Pantalla del operario (Fase 2) |
| `docs/mapeo-columnas.md` | Campo → columna A–S → valores permitidos |

## Probar la lógica sin deployar

```bash
cd apps-script && node test_local.js
```

Simula las APIs de Google en memoria y verifica armado de filas, validación contra `Maestro`,
idempotencia, mellizos, cría muerta y fechas. **No** reemplaza la prueba con `curl` contra el
`/exec` real, pero atrapa casi todo antes de tocar la nube.

## Deploy del backend (una sola vez)

1. Abrir la planilla → **Extensiones → Apps Script**.
2. Pegar `apps-script/Codigo.gs` en `Código.gs` (reemplazar todo).
3. ⚙️ **Configuración del proyecto** → tildar *"Mostrar el archivo de manifiesto
   `appsscript.json`"* → pegar `apps-script/appsscript.json`.
4. Elegir la función **`generarToken`** → **Ejecutar**. Aceptar los permisos.
   En **Registro de ejecución** aparece `TOKEN = ...`. **Copiarlo**: es el único momento
   en que se ve. Queda guardado en Script Properties; no se escribe en este repo ni en el vault.
5. **Implementar → Nueva implementación → Aplicación web**:
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier usuario** (la tablet no tiene sesión de Google)
6. Copiar la URL `/exec`.

### Actualizar el backend, en 4 pasos

1. Pegar `apps-script/Codigo.gs` en el editor y guardar (`Cmd+S`).
2. **Implementar → Gestionar implementaciones**.
3. **✏️ lápiz** sobre la implementación activa. **Nunca "Nueva implementación".**
4. Desplegable **Versión → "Nueva versión"** → **Implementar**.

Debe haber **una sola implementación** sin archivar. Con una sola, el lápiz es el
único camino y la URL no cambia nunca. Si aparece otra, archivar las viejas
(⋮ → Archivar): no borra código ni datos, sólo apaga esa URL.

Verificar siempre después de deployar:

```bash
source config.local && curl -sSL "$URL?action=ping"
```

Tiene que devolver el mismo `version` que `VERSION` en `Codigo.gs`. Si no coincide,
el deploy no tomó. **Subir `VERSION` en cada cambio de `Codigo.gs`.**

### Trampas del deploy (las tres nos pasaron)

1. **Guardar no publica.** Cada implementación queda clavada a una *versión*, que es una foto
   del código. Si se guarda `Codigo.gs` y no se versiona, el `/exec` sigue sirviendo el código
   viejo — o responde `No se encontró la función de la secuencia de comandos: doGet` si la
   versión es anterior al primer pegado.
   Para actualizar: **Implementar → Gestionar implementaciones → ✏️ → Versión: Nueva versión**.

2. **"Nueva implementación" cambia la URL.** Nos pasó cuatro veces. Editar la existente con el
   lápiz la conserva. Como la URL está incrustada en `pwa/config.js`, una URL nueva obliga a
   actualizar la PWA y republicarla; mientras tanto la tablet le habla a un deploy viejo.
   Por eso conviene dejar **una sola implementación activa**.

3. **El acceso tiene que ser "Cualquier usuario"**, no *"Cualquier usuario con una Cuenta de
   Google"*. Con la segunda, el `/exec` redirige al login y la tablet nunca llega al script.
   Se verifica con `curl` (que no tiene sesión): si `?action=ping` devuelve HTML de
   `accounts.google.com`, está mal configurado.

## Verificar el deploy

Guardar el token una vez en el Llavero (lo pide sin mostrarlo):

```bash
security add-generic-password -a "$USER" -s trst-preparto-token -w
```

Después alcanza con:

```bash
source config.local && ./scripts/verificar.sh "$URL"
```

Lo primero que hace es comparar la versión publicada contra `VERSION_ESPERADA`, y
**corta si no coinciden**: seguir probando contra un deploy viejo sólo genera confusión.

Corre los mismos casos que `test_local.js` pero contra la planilla real, incluida la prueba
de duplicados. Escribe partos de prueba: borrar esas filas de
`NUEVO FORMATO PREPARTO` y `_log` cuando termine.

## Contrato de datos

`POST` al `/exec` con el JSON en el body, con `Content-Type: text/plain`. Es una
"simple request" y por lo tanto no dispara el preflight `OPTIONS`, que Apps Script no
sabe responder. Cualquier otro tipo (`application/json`) rompe el CORS desde el navegador.

Desde `curl`, además, **nunca usar `-X POST` junto con `-L`**: Apps Script responde el POST
con un 302 a `googleusercontent.com`, y `-X POST` obliga a repetir el POST contra ese
destino, que sólo acepta GET. Se ve como un "No se encontró la página" engañoso.

```jsonc
{
  "token": "…",
  "uuid": "…",                    // generado en la tablet; es la clave anti-duplicados
  "dispositivo": "tablet-maternidad",
  "cargado_en": "2026-08-12T07:42:10-03:00",

  "operario": "Julio",
  "id_vaca": "4115",
  "fecha_parto": "2026-08-12",     // o "12/08/2026"
  "hora_nacimiento": "07:00",
  "tipo_parto": "1 Normal",
  "sexo": "6 Macho Vivo",

  "lts_madre": "5",               // del PARTO, no de la cría: se repite en las dos filas

  "terneros": [                    // 2 elementos si el sexo es de parto doble (2 u 8)
    {
      "id_ternero": "24543", "raza": "Holando", "peso": 42,
      "sexo": "Macho",             // obligatorio sólo con el código 8, que es ambiguo
      "vive": true,                // false = nació muerta: su fila va en "---"
      "calostro": {                // cada cría lleva el suyo
        "calidad_sin_mejorar": "26",   // número, o "mastitis" / "sangre" / "campo"
        "mejorado": "No",
        "calidad_mejorado": "---",     // solo si mejorado = "Si"
        "consumido": "Si",
        "lts_ternero": "4",
        "id_vaca_origen": "119"
      }
    }
  ],

  "tambo": "2",
  "rodeo": "26",
  "notas": ""
}
```

Respuestas:

| Caso | Respuesta |
|---|---|
| Guardado | `{"ok":true,"id_parto":"20260812-4115-a3f2","filas_escritas":1}` |
| UUID repetido | `{"ok":true,"duplicado":true}` — la tablet lo saca de la cola igual |
| Datos inválidos | `{"ok":false,"error":"validacion","detalles":[…]}` |
| Token mal | `{"ok":false,"error":"token invalido"}` |
| Sin credencial | `{"ok":false,"error":"falta sesion","sesion":false}` |

`GET ?action=ping` · `?action=maestro&token=…` · `?action=partos&token=…&fecha=YYYY-MM-DD`

## Reglas de negocio

- **Una fila por ternero.** Parto simple = 1 fila (igual que siempre). Mellizos = 2 filas con el
  mismo `ID Parto` y `Cria` = `1/2` y `2/2`.
- **Cría muerta** (sexo `4` o `7`): columnas G a P van en `---`, igual que se hacía a mano.
- **`Mejorado = No`** obliga a `calidad_mejorado = "---"`.
- **Calostro**: número entero o una excepción. Nunca un rango tipo `23-26`.
- **Idempotencia**: el `uuid` se busca en `_log` antes de escribir. Sin esto, una tablet con
  señal intermitente duplicaría partos.

## Cambiar las listas (sin tocar código)

Se editan en la hoja `Maestro` de la planilla y la app las toma sola —
no hace falta redeployar. Agregar un operario es escribirlo en la columna A.

**Una columna vacía en `Maestro` significa "sin restricción"**: el backend acepta cualquier
valor para ese campo. Es a propósito, para poder completar la planilla de a poco.

Hoy están vacías: **Rodeo** (col. R) y **Vaca que Provee Calostro** (col. P).
Y falta **Adrián** en Operarios (382 partos cargados en 2026).

## La PWA de la tablet

Pantalla del operario en `pwa/`: HTML/CSS/JS estático, sin build step ni dependencias.

- **URL:** https://amduhau88.github.io/trst-preparto/pwa/ (GitHub Pages, rama `main`)
- **Puesta en tablet:** ver [`docs/puesta-en-tablet.md`](docs/puesta-en-tablet.md)

Guardar un parto escribe **primero en IndexedDB** y confirma al operario al instante;
la red viene después. Un parto cargado en el corral no se pierde aunque no haya señal,
aunque se cierre la app o se apague la tablet.

### Probar la PWA

```bash
node pwa/test_pwa.js
```

Levanta un backend simulado (con la misma idempotencia por uuid que Apps Script) y maneja
Chrome de verdad para reproducir el escenario del corral: cargar sin señal, cerrar la app,
reabrirla sin señal, recuperar la señal y verificar que cada parto llegue **una sola vez**.
También cubre servidor caído, reintentos y datos incompletos.

Requiere `npm install` una vez (usa `puppeteer-core` contra el Chrome ya instalado).

### Al publicar cambios en la PWA

Subir la versión del cache en `pwa/sw.js` (`preparto-v1` → `v2`). Si no, las tablets
siguen sirviendo la versión vieja desde el cache y el cambio no llega nunca.
