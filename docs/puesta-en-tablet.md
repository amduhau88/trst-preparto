# Poner la app en una tablet

**URL de la app:** https://amduhau88.github.io/trst-preparto/pwa/

Se hace una vez por tablet, en unos 5 minutos. Hace falta tener a mano el **token**
(el que está guardado en Script Properties del Apps Script y en el gestor de contraseñas).

## 1. Abrir e instalar

1. Abrir la URL en **Chrome** (en Android; en iPad es Safari).
2. Menú ⋮ → **Instalar aplicación** / **Agregar a pantalla de inicio**.
3. Abrirla desde el ícono nuevo. Tiene que verse **sin la barra de direcciones** de Chrome:
   eso confirma que quedó instalada como app y no como una pestaña.

Si no aparece la opción de instalar, es que el service worker no se registró.
Casi siempre es porque se abrió por `http://` en vez de `https://`.

## 2. Configurar la conexión

En la pestaña **Ajustes**:

| Campo | Qué va |
|---|---|
| URL del servicio | La del `/exec` (está en `config.local` del repo) |
| Token | Los 40 caracteres |
| Nombre de esta tablet | `tablet-maternidad`, `tablet-2`, … — sirve para saber de dónde vino cada parto |

**Guardar y probar.** Tiene que decir *"Conectado. Listas actualizadas desde la planilla."*
Si dice que no pudo conectar, revisar URL y token (o si hay señal).

### Atajo: configurar por link

También se puede abrir una sola vez una URL con los datos incluidos:

```
https://amduhau88.github.io/trst-preparto/pwa/?url=<URL_EXEC>&token=<TOKEN>&dispositivo=tablet-maternidad
```

La app guarda los valores y **borra el token de la barra de direcciones** para que no
quede en el historial. Cómodo para configurar varias tablets iguales.

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
| "No se pudo conectar" en Ajustes | URL o token mal, o sin señal |
| Todos los partos quedan "Revisar" | Token mal, o falta un valor en `Maestro` (p. ej. el operario) |
| No sincroniza y hay señal | La URL cambió: se creó una implementación nueva en vez de versionar |
| La app no abre sin señal | No se instaló como app, o el service worker no se registró |

En **Ajustes → Diagnóstico** se ve el estado de conexión, cuántos registros hay
locales, si la app está instalada y cuántos valores tiene cada lista.
