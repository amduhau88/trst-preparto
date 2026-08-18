# Poner la app en una tablet

**URL de la app:** https://amduhau88.github.io/trst-preparto/pwa/

Se hace una vez por tablet, en unos 3 minutos. **No hay tokens que tipear**: alcanza con
iniciar sesión con una cuenta `@admin.com.ar`.

## 1. Abrir e instalar

1. Abrir la URL en **Chrome** (en Android; en iPad es Safari).
2. Menú ⋮ → **Instalar aplicación** / **Agregar a pantalla de inicio**.
3. Abrirla desde el ícono nuevo. Tiene que verse **sin la barra de direcciones** de Chrome:
   eso confirma que quedó instalada como app y no como una pestaña.

Si no aparece la opción de instalar, es que el service worker no se registró.
Casi siempre es porque se abrió por `http://` en vez de `https://`.

## 2. Iniciar sesión

La app abre en la pantalla de acceso. **Acceder con Google** → elegir la cuenta de la
tablet (por ejemplo `tablet.maternidad@admin.com.ar`).

Sólo entran cuentas del dominio **@admin.com.ar**. Una cuenta de Gmail personal es
rechazada, y ni siquiera llega al código de la app: la bloquea Google.

**Este paso necesita señal.** Es la única vez. Después la app abre y guarda partos en el
corral aunque no haya conexión, durante 30 días sin volver a ver a Google.

### Nombre de la tablet

Sirve para saber de qué dispositivo vino cada parto. Se puede fijar al instalar:

```
https://amduhau88.github.io/trst-preparto/pwa/?dispositivo=tablet-maternidad
```

o después desde **Ajustes**, si iniciaste sesión con una cuenta de administrador.

### Si la tablet quedó con la cuenta equivocada

La opción «Cerrar sesión» vive en Ajustes, que no se le muestra a las cuentas comunes.
Para eso está la salida de emergencia: **mantener apretado el logo TRST 2 segundos**
cierra la sesión y vuelve a la pantalla de acceso.

## 3. Probar en modo avión — la prueba que importa

Esto es lo que decide si sirve en el corral:

1. Poner la tablet en **modo avión**.
2. **Cerrar la app por completo** (sacarla de las apps recientes, no sólo minimizarla).
3. Volver a abrirla desde el ícono. **Tiene que abrir igual** y mostrar el formulario.
4. Cargar 2 o 3 partos. Arriba a la derecha tiene que decir *"Sin señal · 3 en espera"*.
5. Sacar el modo avión y esperar. El badge pasa a **"Sincronizado"** solo.
6. Abrir la planilla y confirmar que están las filas, **una sola vez cada una**.

Si el paso 3 falla (pantalla de error de Chrome), la app no quedó instalada:
volver al paso 1.

## Uso diario

- **Guardar parto** no espera a la red: guarda en la tablet y confirma al instante.
  El operario nunca tiene que esperar ni reintentar.
- El badge de arriba a la derecha dice siempre cómo está: *Sincronizado*,
  *N en espera*, *Sin señal* o *N para revisar*.
- **Partos del día** muestra lo cargado hoy, también sin señal.
- Un parto marcado **"Revisar"** tiene un dato que la planilla rechazó; el motivo
  aparece debajo. Reintentar no lo arregla: hay que corregir el dato.

## Cambiar las listas

Se editan en la hoja `Maestro` de la planilla. La tablet las actualiza sola al abrir
con señal, o con **Ajustes → Actualizar listas**. No hace falta redeployar ni tocar la tablet.

## Actualizar la app

Al publicar cambios hay que **subir la versión del cache** en `pwa/sw.js`
(`const CACHE = 'preparto-v1'` → `v2`). Si no, las tablets siguen usando la versión
vieja guardada y el cambio no llega nunca.

## Si algo no anda

| Síntoma | Causa probable |
|---|---|
| No aparece "Instalar aplicación" | Se abrió por `http://`, no `https://` |
| El badge dice **"Sesión vencida"** | Pasaron los 30 días, o se revocó la cuenta. Tocar el badge y volver a entrar. **Los partos en cola no se pierden.** |
| No deja entrar con una cuenta | No es `@admin.com.ar`. Es lo esperado. |
| Todos los partos quedan "Revisar" | Falta un valor en `Maestro` (p. ej. el operario que eligieron) |
| No sincroniza y hay señal | La URL del `/exec` cambió: se creó una implementación nueva en vez de versionar |
| La app no abre sin señal | No se instaló como app, o el service worker no se registró |
| Quedó con la cuenta equivocada | Mantener apretado el logo TRST 2 segundos |

En **Ajustes → Diagnóstico** se ve el estado de conexión, cuántos registros hay
locales, si la app está instalada y cuántos valores tiene cada lista.
