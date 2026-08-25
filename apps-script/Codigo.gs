/**
 * TRST — Partos · backend Apps Script
 *
 * Recibe partos desde la tablet (PWA) y los escribe en la planilla.
 * El Google Sheet ES la base de datos; acá no hay estado propio.
 *
 * Hojas:
 *   NUEVO FORMATO PREPARTO — A-S formato de Nahuel, T-X columnas tecnicas
 *   Maestro                — listas de valores (editables sin redeploy)
 *   _log                   — auditoria append-only + control de duplicados
 */

/* Version del codigo. Se devuelve en ?action=ping, para poder confirmar de un
 * vistazo QUE version esta realmente publicada. En Apps Script guardar no
 * publica: cada implementacion queda clavada a una foto del codigo, y sin este
 * marcador la unica forma de notar que el deploy no tomo es que los datos
 * salgan mal. Subirla en cada cambio de Codigo.gs. */
var VERSION = 'r5-edicion-2026-08-25';

var SS_ID = '12da8wxy4tJVLHuJZp-MKlornbi2U11ISWEsgglencE8';
var HOJA_FORMATO = 'NUEVO FORMATO PREPARTO';
var HOJA_MAESTRO = 'Maestro';
var HOJA_LOG = '_log';

var VACIO = '---';
var SEXO_MUERTO = ['4', '7'];
var SEXO_MELLIZO = ['2', '8'];
// El codigo del parto ya dice el sexo, salvo el 8 (M+M o M+H), que es ambiguo:
// ahi el sexo de cada cria hay que cargarlo.
var SEXO_POR_CODIGO = { '1': 'Hembra', '2': 'Hembra', '4': 'Hembra', '6': 'Macho', '7': 'Macho' };

// Posiciones (base 0) en la fila armada. A-S es el formato; de T en adelante,
// los datos por cria y las columnas tecnicas.
var COL_OPERARIO = 0;    // A
var COL_PESO = 8;        // I
var COL_TAMBO = 16;      // Q
var COL_RODEO = 17;      // R
var COL_ESTADO_CRIA = 20; // U
var COL_ID_PARTO = 21;   // V
var COL_CRIA = 22;       // W
var COL_UUID = 23;       // X
var COL_CARGADO_EN = 24; // Y
var ANCHO_FILA = 26;     // A..Z
var LOCK_MS = 30000;

/* Que se puede corregir de un parto ya escrito, y donde vive cada cosa.
 * El sexo NO esta: el codigo del parto manda cuantas crias hay, y editarlo
 * obligaria a agregar o borrar filas — justo el bloque que leen Nahuel y
 * DairyComp. Un sexo mal cargado lo corrige Nahuel en la planilla.
 * ID de ternero, raza, hora, tipo de parto y notas tampoco: misma razon de
 * alcance, se piden aparte si hacen falta. */
var EDITABLE_CRIA = {          // por cria: cada fila lleva la suya
  peso: COL_PESO,
  calidad_sin_mejorar: 9,      // J
  mejorado: 10,                // K
  calidad_mejorado: 11,        // L
  consumido: 12,               // M
  lts_ternero: 14,             // O
  id_vaca_origen: 15           // P
};
var EDITABLE_PARTO = {         // del parto: se repite igual en todas sus filas
  lts_madre: 13,               // N
  tambo: COL_TAMBO
};

// Identidad: solo entran cuentas de Google del dominio, emitidas para ESTA app.
var CLIENT_ID = '55795987692-qi482a0cjf657a1884dn3tl88mc0t2e9.apps.googleusercontent.com';
var DOMINIO = 'admin.com.ar';
var TOKENINFO = 'https://oauth2.googleapis.com/tokeninfo?id_token=';

/** Clave logica -> encabezado en la hoja Maestro (los nombres no coinciden con el formato). */
var MAESTRO_MAP = {
  operario: 'Operario',
  tipo_parto: 'Tipo Parto',
  sexo: 'SEXO, VIVO, MELLIZOS',
  raza: 'Raza',
  peso: 'Peso Ternero (Kg)',
  hora_nacimiento: 'Hora Nacimiento',
  calidad_sin_mejorar: 'Calidad Calostro Sin Mejorar (de madre)',
  mejorado: 'Mejorado',
  calidad_mejorado: 'Calidad de Calostro Mejorado (de madre)',
  consumido: 'Calostro Consumido al Momento',
  lts_madre: 'Lts Calostro Madre',
  lts_ternero: 'Lts Calostro para Ternero',
  tambo: 'Tambo Vaca',
  rodeo: 'Rodeo Vaca (Nahuel)'
};

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

function doPost(e) {
  try {
    var payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    var auth = autorizar_(payload);
    if (!auth.ok) return json_({ ok: false, error: auth.error, sesion: false });

    // Consultas de solo lectura. Van por POST para que el ID token no viaje
    // en la URL, donde quedaria escrito en los logs de Google.
    if (payload.accion === 'sesion') {
      return json_({ ok: true, email: auth.email, admin: auth.admin });
    }
    if (payload.accion === 'maestro') {
      return json_({ ok: true, listas: leerMaestro_(SpreadsheetApp.openById(SS_ID)) });
    }
    if (payload.accion === 'partos') {
      return json_({ ok: true, partos: partosDelDia_(SpreadsheetApp.openById(SS_ID), payload.fecha) });
    }

    // Corregir un parto ya escrito. Va por su propio camino y NO por el alta:
    // ahi el uuid es la llave de idempotencia, y una correccion que entrara por
    // esa puerta seria indistinguible de un reintento de la cola de la tablet.
    if (payload.accion === 'editar') {
      return editarParto_(payload, auth);
    }

    if (!payload.uuid) return json_({ ok: false, error: 'falta uuid' });

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_MS)) return json_({ ok: false, error: 'ocupado, reintentar' });

    try {
      var ss = SpreadsheetApp.openById(SS_ID);
      var log = ss.getSheetByName(HOJA_LOG);

      // Idempotencia: si el uuid ya entro, no se escribe de nuevo.
      // Es lo que hace segura la cola de reintentos de la tablet.
      if (buscarUuid_(log, payload.uuid)) {
        return json_({ ok: true, duplicado: true, uuid: payload.uuid });
      }

      var listas = leerMaestro_(ss);
      var errores = validar_(payload, listas);
      if (errores.length) {
        log.appendRow([payload.uuid, new Date(), JSON.stringify(payload), 0,
                       'rechazado: ' + errores.join(' | '), auth.email]);
        return json_({ ok: false, error: 'validacion', detalles: errores });
      }

      // Se reclama el uuid en _log ANTES de escribir el formato: si algo falla
      // en el medio, el dato crudo quedo guardado y el renglon es diagnosticable.
      log.appendRow([payload.uuid, new Date(), JSON.stringify(payload), 0, 'recibido', auth.email]);
      var filaLog = log.getLastRow();

      var filas = construirFilas_(ss, payload);
      var hoja = ss.getSheetByName(HOJA_FORMATO);
      hoja.getRange(hoja.getLastRow() + 1, 1, filas.length, filas[0].length).setValues(filas);

      log.getRange(filaLog, 4, 1, 2).setValues([[filas.length, 'ok']]);

      return json_({
        ok: true,
        uuid: payload.uuid,
        id_parto: filas[0][COL_ID_PARTO],
        filas_escritas: filas.length
      });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    var ss = SpreadsheetApp.openById(SS_ID);

    if (p.action === 'ping') {
      return json_({ ok: true, version: VERSION, hoja: ss.getName(),
                     ts: new Date().toISOString() });
    }

    // Camino para scripts (verificar.sh, crons). El navegador usa POST, para no
    // dejar el ID token escrito en la URL.
    if (p.action === 'maestro') {
      var a1 = autorizar_(p);
      if (!a1.ok) return json_({ ok: false, error: a1.error });
      return json_({ ok: true, listas: leerMaestro_(ss) });
    }

    if (p.action === 'partos') {
      var a2 = autorizar_(p);
      if (!a2.ok) return json_({ ok: false, error: a2.error });
      return json_({ ok: true, partos: partosDelDia_(ss, p.fecha) });
    }

    return json_({ ok: false, error: 'action desconocida' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/* ------------------------------------------------------------------ */
/* Armado de filas                                                     */
/* ------------------------------------------------------------------ */

/**
 * Un parto -> una fila POR TERNERO. Parto simple = 1 fila (igual que hoy).
 * Mellizos = 2 filas con el mismo ID Parto y Cria 1/2 y 2/2.
 *
 * Cada cria lleva SU sexo, SU estado y SU calostro: con el codigo 8 (M+M o M+H)
 * no habia forma de saber que fue cada una, ni de anotar que a cada ternero se
 * le dio un calostro distinto. Los litros que produjo la madre son del parto,
 * no de la cria, asi que se repiten iguales en las dos filas.
 */
function construirFilas_(ss, p) {
  var tz = ss.getSpreadsheetTimeZone();
  var fecha = parseFecha_(p.fecha_parto);
  var partoMuerto = esMuerto_(p.sexo);
  var idParto = Utilities.formatDate(fecha, tz, 'yyyyMMdd') + '-' + p.id_vaca + '-' +
                String(p.uuid).replace(/-/g, '').substring(0, 4);
  var cargadoEn = p.cargado_en ? new Date(p.cargado_en) : new Date();
  var ltsMadre = ltsMadre_(p);

  var terneros = partoMuerto ? [null] : (p.terneros && p.terneros.length ? p.terneros : [null]);

  return terneros.map(function (t, i) {
    var muerto = partoMuerto || !t || t.vive === false;
    // Se acepta el calostro por cria y, si no viene, el del parto (formato viejo).
    var cal = (t && t.calostro) || p.calostro || {};

    // Cria muerta: el formato lleva '---' de G a P, igual que se hacia a mano.
    var bloque = muerto
      ? [VACIO, VACIO, VACIO, VACIO, VACIO, VACIO, VACIO, VACIO, VACIO, VACIO]
      : [
          str_(t.id_ternero), str_(t.raza), num_(t.peso),
          str_(cal.calidad_sin_mejorar), str_(cal.mejorado),
          str_(cal.calidad_mejorado || VACIO), str_(cal.consumido),
          num_(ltsMadre), num_(cal.lts_ternero), str_(cal.id_vaca_origen)
        ];

    return [
      str_(p.operario), str_(p.id_vaca), fecha, str_(p.hora_nacimiento),
      str_(p.tipo_parto), str_(p.sexo)
    ].concat(bloque).concat([
      // El rodeo ya no se carga en la tablet: la columna R queda vacia y la
      // completa Nahuel en la planilla. Vacio se lee como "falta asignar",
      // que es el estado real; '---' no sirve porque en G-P ya significa
      // "cria muerta" y sumarle un segundo sentido lo vuelve ambiguo.
      str_(p.tambo), '', str_(p.notas),
      sexoCria_(p, t), muerto ? 'Muerto' : 'Vivo',
      idParto, (i + 1) + '/' + terneros.length, str_(p.uuid), cargadoEn, str_(p.dispositivo)
    ]);
  });
}

/* ------------------------------------------------------------------ */
/* Edicion                                                             */
/* ------------------------------------------------------------------ */

/* Como se escribe cada campo editable. Espeja lo que hace construirFilas_:
 * si el alta guarda el peso como numero, la correccion tambien, o la misma
 * columna termina con numeros y textos mezclados. */
var FORMATO_CAMPO = {
  peso: num_, lts_ternero: num_, lts_madre: num_,
  calidad_sin_mejorar: str_, mejorado: str_, calidad_mejorado: str_,
  consumido: str_, id_vaca_origen: str_, tambo: str_
};

/**
 * Corrige un parto ya escrito, sin agregar ni borrar filas: se pisan celdas de
 * renglones que ya existen. Mellizos son dos filas con el mismo uuid y se tocan
 * las dos — el peso y el calostro son de cada cria, pero los litros que produjo
 * la madre y el tambo son del parto y van iguales en las dos.
 *
 * El renglon original de _log no se toca nunca: cada correccion suma su propio
 * renglon con el uuid, quien la hizo y que cambio. La hoja sigue siendo
 * append-only, que es lo que hace que se pueda reconstruir que paso.
 */
function editarParto_(p, auth) {
  if (!p.uuid) return json_({ ok: false, error: 'falta uuid' });

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) return json_({ ok: false, error: 'ocupado, reintentar' });

  try {
    var ss = SpreadsheetApp.openById(SS_ID);
    var hoja = ss.getSheetByName(HOJA_FORMATO);
    var tz = ss.getSpreadsheetTimeZone();

    var filas = filasDeUuid_(hoja, p.uuid);
    if (!filas.length) return json_({ ok: false, error: 'no existe el parto ' + p.uuid });

    // La ventana es lo cargado HOY, no la fecha del parto: un parto de ayer
    // cargado esta manana todavia se corrige, y uno cargado ayer ya no.
    if (!cargadoHoy_(filas[0].datos[COL_CARGADO_EN], tz)) {
      return json_({ ok: false, error: 'solo se corrigen partos cargados hoy' });
    }

    var terneros = p.terneros || [];
    if (terneros.length && terneros.length !== filas.length) {
      return json_({ ok: false, error: 'el parto tiene ' + filas.length +
                     ' cria(s) y vinieron ' + terneros.length });
    }

    var listas = leerMaestro_(ss);
    var err = [];
    var cambios = [];

    filas.forEach(function (f, i) {
      var pre = filas.length > 1 ? 'cria ' + (i + 1) + ': ' : '';
      // Una cria muerta lleva '---' de G a P, igual que se hacia a mano.
      var muerta = String(f.datos[COL_ESTADO_CRIA]) === 'Muerto';

      // El tambo (Q) es del parto y esta fuera de ese bloque: se corrige siempre.
      anotarCambio_(cambios, err, listas, f, EDITABLE_PARTO.tambo, 'tambo', p.tambo, '');

      // Los litros que produjo la madre tambien son del parto, pero viven en la
      // columna N, que SI esta adentro del bloque. Escribirlos en una fila de
      // cria muerta dejaria un numero suelto en el medio de los '---'.
      if (muerta) {
        if (p.lts_madre !== undefined) {
          err.push(pre + 'cria muerta: de G a P va todo en ' + VACIO);
        }
      } else {
        anotarCambio_(cambios, err, listas, f, EDITABLE_PARTO.lts_madre, 'lts_madre',
                      p.lts_madre, '');
      }

      var t = terneros[i];

      // Si el estado de la cria esta mal, el codigo del parto tambien, y el
      // codigo no es editable: eso lo corrige Nahuel en la planilla.
      if (muerta) {
        if (t && tocaAlgo_(t)) err.push(pre + 'esta marcada muerta: no lleva peso ni calostro');
        return;
      }
      if (!t) return;

      // El peso solo lo corrige quien cargo el parto. Es un recordatorio de
      // quien se hizo cargo del animal, no un control de acceso: el operario se
      // elige de una lista en la tablet y nadie prueba que sea quien dice ser.
      //
      // Se mira si el peso CAMBIA, no si vino en el payload: la tablet manda el
      // parto entero al corregir cualquier cosa, y reenviar el mismo peso no es
      // pesar. Si no, corregir el calostro quedaria bloqueado para todos menos
      // uno, sin motivo.
      if (t.peso !== undefined && String(f.datos[COL_PESO]) !== String(num_(t.peso)) &&
          String(p.operario) !== String(f.datos[COL_OPERARIO])) {
        err.push(pre + 'el peso lo carga ' + f.datos[COL_OPERARIO] + ', que fue quien cargo el parto');
      }

      Object.keys(EDITABLE_CRIA).forEach(function (clave) {
        var valor = clave === 'peso' ? t.peso : (t.calostro || {})[clave];
        anotarCambio_(cambios, err, listas, f, EDITABLE_CRIA[clave], clave, valor, pre);
      });

      // La columna L solo se habilita con Mejorado = Si. Se mira el resultado
      // final, no lo que vino: se puede estar cambiando uno solo de los dos.
      var mejorado = resultante_(f, t, 'mejorado', 10);
      var calidad = resultante_(f, t, 'calidad_mejorado', 11);
      if (String(mejorado) === 'Si' && (!calidad || String(calidad) === VACIO)) {
        err.push(pre + 'mejorado=Si pero calidad_mejorado vacia');
      }
      if (String(mejorado) !== 'Si' && calidad && String(calidad) !== VACIO) {
        err.push(pre + 'calidad_mejorado cargada con mejorado=' + mejorado);
      }
    });

    var log = ss.getSheetByName(HOJA_LOG);
    if (err.length) {
      log.appendRow([p.uuid, new Date(), JSON.stringify(p), 0,
                     'edicion rechazada: ' + err.join(' | '), auth.email]);
      return json_({ ok: false, error: 'validacion', detalles: err });
    }
    if (!cambios.length) return json_({ ok: true, uuid: p.uuid, cambios: 0 });

    // Se escribe celda por celda a proposito: reescribir la fila entera pisaria
    // tambien el rodeo que Nahuel carga a mano en la columna R.
    cambios.forEach(function (c) {
      hoja.getRange(c.fila, c.col + 1, 1, 1).setValues([[c.a]]);
    });

    log.appendRow([p.uuid, new Date(), JSON.stringify(cambios), cambios.length,
                   'editado por ' + str_(p.operario), auth.email]);

    return json_({ ok: true, uuid: p.uuid, cambios: cambios.length, detalle: cambios });
  } finally {
    lock.releaseLock();
  }
}

/** Valida un valor nuevo y, si de verdad cambia, lo anota para escribir. */
function anotarCambio_(cambios, err, listas, f, col, clave, valor, pre) {
  if (valor === undefined || valor === null) return;      // no vino: no se toca
  if (valor === '') {
    // Reenviar vacio algo que ya estaba vacio no es borrar nada: la tablet
    // manda el parto entero, y hay campos que son opcionales desde el alta
    // (la vaca que provee el calostro, por ejemplo).
    if (String(f.datos[col]) === '') return;
    err.push(pre + clave + ' no puede quedar vacio');     // borrar si es otra cosa
    return;
  }
  enLista_(err, listas, clave, valor, pre);

  var nuevo = (FORMATO_CAMPO[clave] || str_)(valor);
  if (String(f.datos[col]) === String(nuevo)) return;     // ya vale eso
  cambios.push({ fila: f.fila, col: col, campo: clave, de: f.datos[col], a: nuevo });
}

/** El valor que va a quedar: el que vino, o el que ya estaba si no vino. */
function resultante_(f, t, clave, col) {
  var v = (t.calostro || {})[clave];
  return v === undefined || v === null ? f.datos[col] : v;
}

function tocaAlgo_(t) {
  if (t.peso !== undefined) return true;
  var cal = t.calostro || {};
  return Object.keys(cal).some(function (k) { return cal[k] !== undefined; });
}

/** Todas las filas de un parto, por uuid (columna X). Mellizos devuelven dos. */
function filasDeUuid_(hoja, uuid) {
  if (hoja.getLastRow() < 2) return [];
  var datos = hoja.getRange(2, 1, hoja.getLastRow() - 1, ANCHO_FILA).getValues();
  var out = [];
  for (var i = 0; i < datos.length; i++) {
    if (String(datos[i][COL_UUID]) === String(uuid)) out.push({ fila: i + 2, datos: datos[i] });
  }
  return out;
}

function cargadoHoy_(v, tz) {
  if (!(v instanceof Date)) return false;
  return Utilities.formatDate(v, tz, 'yyyy-MM-dd') ===
         Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
}

/** Los litros de la madre son del parto. Se acepta arriba o dentro de calostro. */
function ltsMadre_(p) {
  if (p.lts_madre !== undefined && p.lts_madre !== '') return p.lts_madre;
  return (p.calostro || {}).lts_madre;
}

/** El sexo de la cria: el que se cargo, o el que ya implica el codigo del parto. */
function sexoCria_(p, t) {
  if (t && t.sexo) return String(t.sexo);
  return SEXO_POR_CODIGO[String(p.sexo).charAt(0)] || '';
}

/* ------------------------------------------------------------------ */
/* Validacion                                                          */
/* ------------------------------------------------------------------ */

/**
 * Valida contra Maestro. Una lista vacia en Maestro = sin restriccion,
 * asi la planilla se puede completar de a poco sin romper la app.
 */
function validar_(p, listas) {
  var err = [];

  ['operario', 'id_vaca', 'fecha_parto', 'tipo_parto', 'sexo'].forEach(function (campo) {
    if (!p[campo]) err.push('falta ' + campo);
  });
  if (err.length) return err;

  if (!parseFecha_(p.fecha_parto)) err.push('fecha_parto invalida: ' + p.fecha_parto);

  enLista_(err, listas, 'operario', p.operario);
  enLista_(err, listas, 'tipo_parto', p.tipo_parto);
  enLista_(err, listas, 'sexo', p.sexo);
  enLista_(err, listas, 'hora_nacimiento', p.hora_nacimiento);
  enLista_(err, listas, 'tambo', p.tambo);
  // El rodeo ya no viaja desde la tablet: no se valida ni se escribe.

  if (esMuerto_(p.sexo)) return err;

  var terneros = p.terneros || [];
  if (!terneros.length) err.push('cria viva sin datos de ternero');
  // Un codigo de sexo simple no puede traer dos crias.
  if (!esMellizo_(p.sexo) && terneros.length > 1) {
    err.push('sexo "' + p.sexo + '" no es de parto doble pero vinieron ' +
             terneros.length + ' terneros');
  }
  // Los litros de la madre son del parto, no de la cria.
  enLista_(err, listas, 'lts_madre', ltsMadre_(p));

  var ambiguo = String(p.sexo).charAt(0) === '8';   // 8 = M+M o M+H: hay que decir cual

  terneros.forEach(function (t, i) {
    var pre = 'ternero ' + (i + 1) + ': ';
    if (ambiguo && !t.sexo) err.push(pre + 'falta el sexo (el codigo 8 no lo dice)');
    if (t.sexo && ['Macho', 'Hembra'].indexOf(String(t.sexo)) === -1) {
      err.push(pre + 'sexo invalido: "' + t.sexo + '"');
    }
    if (t.vive === false) return;                   // cria muerta: va toda en '---'

    enLista_(err, listas, 'raza', t.raza, pre);
    // El peso se carga en un segundo paso, cuando el ternero se pesa de verdad.
    // Vacio es un estado legitimo del alta ("falta pesar"); enLista_ deja pasar
    // lo vacio, y lo que si se exige es que un peso presente sea de la lista.
    // La accion 'pesar' es la que lo vuelve obligatorio.
    enLista_(err, listas, 'peso', t.peso, pre);

    var cal = t.calostro || p.calostro || {};
    enLista_(err, listas, 'calidad_sin_mejorar', cal.calidad_sin_mejorar, pre);
    enLista_(err, listas, 'mejorado', cal.mejorado, pre);
    enLista_(err, listas, 'consumido', cal.consumido, pre);
    enLista_(err, listas, 'lts_ternero', cal.lts_ternero, pre);

    // La columna L solo se habilita con Mejorado = Si; si no, va '---'.
    if (cal.mejorado === 'Si') {
      enLista_(err, listas, 'calidad_mejorado', cal.calidad_mejorado, pre);
      if (String(cal.calidad_mejorado) === VACIO) {
        err.push(pre + 'mejorado=Si pero calidad_mejorado vacia');
      }
    } else if (cal.calidad_mejorado && String(cal.calidad_mejorado) !== VACIO) {
      err.push(pre + 'calidad_mejorado cargada con mejorado=' + cal.mejorado);
    }
  });

  // El codigo del parto y el sexo de las crias tienen que decir lo mismo.
  // El 2 es hembra+hembra; el 8 es M+M o M+H, o sea que NO puede ser dos hembras.
  if (terneros.length > 1) {
    var codigo = String(p.sexo).charAt(0);
    var sexos = terneros.map(function (t) { return sexoCria_(p, t); });
    if (codigo === '2' && sexos.some(function (x) { return x !== 'Hembra'; })) {
      err.push('el codigo "2 Hembras Gemelas Vivas" no admite machos: usar el 8');
    }
    if (codigo === '8' && sexos.every(function (x) { return x === 'Hembra'; })) {
      err.push('dos hembras corresponden al codigo "2 Hembras Gemelas Vivas", no al 8');
    }
  }

  // Mellizos donde las dos crias nacieron muertas: el codigo del parto no lo refleja.
  if (terneros.length && terneros.every(function (t) { return t.vive === false; })) {
    err.push('todas las crias marcadas muertas: usar el codigo de parto correspondiente');
  }

  return err;
}

function enLista_(err, listas, clave, valor, prefijo) {
  var lista = listas[clave];
  if (!lista || !lista.length) return;              // Maestro vacio: no se exige nada
  if (valor === undefined || valor === null || valor === '') return;
  if (lista.indexOf(String(valor)) === -1) {
    err.push((prefijo || '') + clave + ' fuera de lista: "' + valor + '"');
  }
}

/* ------------------------------------------------------------------ */
/* Lectura de la planilla                                              */
/* ------------------------------------------------------------------ */

/** Devuelve {clave: [valores]} leyendo Maestro por nombre de encabezado. */
function leerMaestro_(ss) {
  var hoja = ss.getSheetByName(HOJA_MAESTRO);
  var datos = hoja.getDataRange().getValues();
  var encabezados = datos[0].map(normalizar_);

  var listas = {};
  Object.keys(MAESTRO_MAP).forEach(function (clave) {
    var col = encabezados.indexOf(normalizar_(MAESTRO_MAP[clave]));
    if (col === -1) { listas[clave] = []; return; }

    var vals = [];
    for (var i = 1; i < datos.length; i++) {
      var v = datos[i][col];
      if (v === '' || v === null) continue;
      if (v instanceof Date) v = Utilities.formatDate(v, ss.getSpreadsheetTimeZone(), 'HH:mm');
      vals.push(String(v).trim());
    }
    // Maestro guarda "Si/No" en una sola celda; la app necesita las dos opciones.
    if (vals.length === 1 && vals[0] === 'Si/No') vals = ['Si', 'No'];
    listas[clave] = vals;
  });
  return listas;
}

function partosDelDia_(ss, fechaISO) {
  var hoja = ss.getSheetByName(HOJA_FORMATO);
  if (hoja.getLastRow() < 2) return [];

  var tz = ss.getSpreadsheetTimeZone();
  var buscada = fechaISO || Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var datos = hoja.getRange(2, 1, hoja.getLastRow() - 1, ANCHO_FILA).getValues();

  return datos.map(function (f, i) {
    return { f: f, fila: i + 2 };                 // +2: la 1 es el encabezado
  }).filter(function (r) {
    var d = r.f[2];
    return d instanceof Date && Utilities.formatDate(d, tz, 'yyyy-MM-dd') === buscada;
  }).map(function (r) {
    var f = r.f;
    return {
      fila: r.fila,
      operario: f[0], id_vaca: f[1],
      fecha: Utilities.formatDate(f[2], tz, 'yyyy-MM-dd'), hora: f[3],
      tipo_parto: f[4], sexo: f[5],
      id_ternero: f[6], raza: f[7], peso: f[8],
      calidad_sin_mejorar: f[9], lts_ternero: f[14],
      tambo: f[16], rodeo: f[17], notas: f[18],
      sexo_cria: f[19], estado_cria: f[20],
      id_parto: f[21], cria: f[22], uuid: f[23]
    };
  });
}

/** Busca el uuid en la columna A de _log. TextFinder evita traer toda la hoja. */
function buscarUuid_(log, uuid) {
  if (log.getLastRow() < 2) return false;
  var hit = log.getRange(2, 1, log.getLastRow() - 1, 1)
               .createTextFinder(uuid).matchEntireCell(true).findNext();
  return hit !== null;
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
                       .setMimeType(ContentService.MimeType.JSON);
}

function tokenValido_(token) {
  var esperado = PropertiesService.getScriptProperties().getProperty('TOKEN');
  return !!esperado && token === esperado;
}

/* ------------------------------------------------------------------ */
/* Identidad                                                           */
/* ------------------------------------------------------------------ */

/**
 * Dos caminos de entrada, ninguno opcional:
 *   - navegador (tablet): ID token de Google, dominio DOMINIO
 *   - scripts (verificar.sh, crons): token compartido de Script Properties
 * Sin uno de los dos, no se escribe nada.
 */
function autorizar_(datos) {
  datos = datos || {};

  if (datos.token && tokenValido_(datos.token)) {
    return { ok: true, email: 'script', admin: true, via: 'token' };
  }
  if (!datos.id_token) {
    return { ok: false, error: datos.token ? 'token invalido' : 'falta sesion' };
  }

  var info = verificarIdToken_(datos.id_token);
  if (!info.ok) return info;
  return { ok: true, email: info.email, admin: esAdmin_(info.email), via: 'google' };
}

/**
 * Valida el ID token contra Google: firma, para quien fue emitido (aud) y de
 * que dominio es la cuenta (hd). Las tres tienen que dar; con dos no alcanza.
 */
function verificarIdToken_(idToken) {
  var cache = CacheService.getScriptCache();
  var clave = 'idt_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));

  var guardado = cache.get(clave);
  if (guardado) return JSON.parse(guardado);

  var res;
  try {
    res = UrlFetchApp.fetch(TOKENINFO + encodeURIComponent(idToken), { muteHttpExceptions: true });
  } catch (err) {
    return { ok: false, error: 'no se pudo validar la sesion' };
  }
  if (res.getResponseCode() !== 200) return { ok: false, error: 'sesion invalida' };

  var d;
  try { d = JSON.parse(res.getContentText()); }
  catch (err) { return { ok: false, error: 'respuesta ilegible de Google' }; }

  if (d.aud !== CLIENT_ID) return { ok: false, error: 'token emitido para otra aplicacion' };
  if (d.hd !== DOMINIO) return { ok: false, error: 'la cuenta no es de ' + DOMINIO };
  if (String(d.email_verified) !== 'true') return { ok: false, error: 'mail sin verificar' };

  var restanMs = Number(d.exp) * 1000 - Date.now();
  if (!(restanMs > 0)) return { ok: false, error: 'sesion vencida' };

  var r = { ok: true, email: String(d.email).toLowerCase() };
  // Cachear evita una llamada a Google por cada parto al drenar una cola larga.
  cache.put(clave, JSON.stringify(r), Math.max(1, Math.min(300, Math.floor(restanMs / 1000))));
  return r;
}

/** Quienes ven la pestaña Ajustes. Se configura en Script Properties. */
function esAdmin_(email) {
  var lista = PropertiesService.getScriptProperties().getProperty('ADMINS') || '';
  return lista.split(',')
              .map(function (x) { return x.trim().toLowerCase(); })
              .filter(String)
              .indexOf(String(email).toLowerCase()) !== -1;
}

/** Acepta 'YYYY-MM-DD' o 'DD/MM/YYYY'. Devuelve Date local o null. */
function parseFecha_(v) {
  if (!v) return null;
  var s = String(v).trim();
  var anio, mes, dia;

  var g = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (g) {
    anio = +g[1]; mes = +g[2]; dia = +g[3];
  } else {
    g = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!g) return null;
    dia = +g[1]; mes = +g[2]; anio = +g[3];
  }

  var fecha = new Date(anio, mes - 1, dia);
  // Date normaliza en silencio: new Date(2026, 12, 45) devuelve 14/02/2027.
  // Sin este control, una fecha basura entraria a la planilla como fecha valida.
  if (fecha.getFullYear() !== anio || fecha.getMonth() !== mes - 1 || fecha.getDate() !== dia) {
    return null;
  }
  return fecha;
}

function esMuerto_(sexo) {
  return SEXO_MUERTO.indexOf(String(sexo).charAt(0)) !== -1;
}

function esMellizo_(sexo) {
  return SEXO_MELLIZO.indexOf(String(sexo).charAt(0)) !== -1;
}

function normalizar_(s) {
  return String(s).replace(/\s+/g, ' ').trim().toLowerCase();
}

function str_(v) {
  return (v === undefined || v === null) ? '' : String(v);
}

function num_(v) {
  return (v === undefined || v === null || v === '') ? '' : Number(v);
}

/* ------------------------------------------------------------------ */
/* Setup — se corren a mano una sola vez desde el editor               */
/* ------------------------------------------------------------------ */

/**
 * Diagnostico: verifica que el script pueda hablar con Google.
 * Correrla desde el editor y mirar el Registro de ejecucion.
 *
 * Si pide autorizacion al ejecutarla, es exactamente lo que faltaba:
 * el permiso script.external_request no estaba concedido y sin el
 * NINGUN inicio de sesion puede validarse.
 */
function diagnostico() {
  var props = PropertiesService.getScriptProperties();
  Logger.log('TOKEN configurado : ' + (props.getProperty('TOKEN') ? 'si' : 'NO'));
  Logger.log('ADMINS            : ' + (props.getProperty('ADMINS') || '(vacio)'));
  Logger.log('CLIENT_ID         : ' + CLIENT_ID);

  try {
    var res = UrlFetchApp.fetch(TOKENINFO + 'token-de-prueba', { muteHttpExceptions: true });
    Logger.log('Llamada a Google  : OK (codigo ' + res.getResponseCode() + ')');
    Logger.log('>> El permiso esta bien. Un 400 aca es lo esperado: Google');
    Logger.log('>> rechaza el token de mentira, que es justo lo que queriamos probar.');
  } catch (err) {
    Logger.log('Llamada a Google  : FALLO -> ' + err);
    Logger.log('>> Falta el permiso script.external_request en appsscript.json,');
    Logger.log('>> o no se autorizo. Sin eso no se puede validar ninguna sesion.');
  }

  try {
    Logger.log('Planilla          : ' + SpreadsheetApp.openById(SS_ID).getName());
  } catch (err) {
    Logger.log('Planilla          : FALLO -> ' + err);
  }
}

/**
 * Genera el token compartido y lo guarda en Script Properties.
 * Copiar el valor que imprime y cargarlo en la tablet. No se guarda en el repo.
 */
function generarToken() {
  var token = Utilities.getUuid().replace(/-/g, '') +
              Utilities.getUuid().replace(/-/g, '').substring(0, 8);
  PropertiesService.getScriptProperties().setProperty('TOKEN', token);
  Logger.log('TOKEN = ' + token);
  return token;
}

/** Formatos de columna: IDs y hora como texto, fechas como fecha. */
function configurarFormatos() {
  var hoja = SpreadsheetApp.openById(SS_ID).getSheetByName(HOJA_FORMATO);
  var n = hoja.getMaxRows() - 1;
  hoja.getRange(2, 2, n, 1).setNumberFormat('@');            // B  ID Vaca
  hoja.getRange(2, 3, n, 1).setNumberFormat('dd/MM/yyyy');   // C  Fecha Parto
  hoja.getRange(2, 4, n, 1).setNumberFormat('@');            // D  Hora Nacimiento
  hoja.getRange(2, 7, n, 1).setNumberFormat('@');            // G  ID Ternero
  hoja.getRange(2, 16, n, 1).setNumberFormat('@');           // P  ID Vaca Origen
  hoja.getRange(2, 24, n, 1).setNumberFormat('@');           // X  UUID
  hoja.getRange(2, 25, n, 1).setNumberFormat('dd/MM/yyyy HH:mm'); // Y Cargado en
}
