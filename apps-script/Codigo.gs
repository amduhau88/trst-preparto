/**
 * TRST — Partos · backend Apps Script
 *
 * Recibe partos desde la tablet (PWA) y los escribe en la planilla.
 * El Google Sheet ES la base de datos; acá no hay estado propio.
 *
 * Hojas:
 *   Registros       — los partos. A-T lo que se lee y se carga, U-AC tecnicas
 *   Datos Carga DC  — vista en el orden en que Nahuel carga en DairyComp
 *   Maestro         — listas de valores (editables sin redeploy)
 *   _log            — auditoria append-only + control de duplicados
 */

/* Version del codigo. Se devuelve en ?action=ping, para poder confirmar de un
 * vistazo QUE version esta realmente publicada. En Apps Script guardar no
 * publica: cada implementacion queda clavada a una foto del codigo, y sin este
 * marcador la unica forma de notar que el deploy no tomo es que los datos
 * salgan mal. Subirla en cada cambio de Codigo.gs. */
var VERSION = 'r6-calostro-2026-08-26';

var SS_ID = '12da8wxy4tJVLHuJZp-MKlornbi2U11ISWEsgglencE8';
var HOJA_FORMATO = 'Registros';
/* El nombre viejo se sigue aceptando a proposito: asi el deploy y el rename de
 * la pestaña no tienen que ser simultaneos. Si se renombrara antes de publicar,
 * getSheetByName devolveria null y todo doPost tiraria excepcion. Se saca en r7. */
var HOJA_FORMATO_VIEJA = 'NUEVO FORMATO PREPARTO';
var HOJA_DC = 'Datos Carga DC';
var HOJA_MAESTRO = 'Maestro';
var HOJA_LOG = '_log';

var VACIO = '---';
var SEXO_MUERTO = ['4', '7'];
var SEXO_MELLIZO = ['2', '8'];
// El codigo del parto ya dice el sexo, salvo el 8 (M+M o M+H), que es ambiguo:
// ahi el sexo de cada cria hay que cargarlo.
var SEXO_POR_CODIGO = { '1': 'Hembra', '2': 'Hembra', '4': 'Hembra', '6': 'Macho', '7': 'Macho' };

/* Posiciones (base 0) de la fila. UN solo lugar: antes estaban repartidas entre
 * constantes sueltas, literales dentro de EDITABLE_*, indices crudos en
 * partosDelDia_ y slices en las pruebas, y reordenar obligaba a tocar los
 * cuatro a la vez sin que nada avisara si se olvidaba uno.
 *
 * Bloques: A-I el parto y la cria, J-M el calostro DE LA MADRE (es del parto y
 * se repite igual en las dos filas de un mellizo), N-Q el calostro QUE TOMO EL
 * TERNERO (es de cada cria), R-T destino y notas, U-V la cria, W-AC tecnicas. */
var COL = {
  operario: 0,          // A
  id_vaca: 1,           // B
  fecha: 2,             // C
  hora: 3,              // D
  tipo_parto: 4,        // E
  sexo: 5,              // F
  id_ternero: 6,        // G
  raza: 7,              // H
  peso: 8,              // I
  calidad_sin_mejorar: 9,  // J  \
  mejorado: 10,            // K   |  calostro de la madre: del PARTO
  calidad_mejorado: 11,    // L   |
  lts_madre: 12,           // M  /
  origen_calostro: 13,     // N  \
  id_vaca_origen: 14,      // O   |  calostro que tomo el ternero: de la CRIA
  calidad_ternero: 15,     // P   |
  lts_ternero: 16,         // Q  /
  tambo: 17,            // R
  rodeo: 18,            // S   la carga Nahuel en 'Datos Carga DC' y se replica
  notas: 19,            // T
  sexo_cria: 20,        // U
  estado_cria: 21,      // V
  id_parto: 22,         // W
  cria: 23,             // X
  uuid: 24,             // Y
  /* Cuando el operario apreto Guardar en la tablet, NO cuando el parto llego a
   * la planilla: un parto cargado sin señal a las 3 de la mañana puede
   * sincronizar a las 9, y lo que interesa es la hora del corral. Tampoco lo
   * mueven pesar, corregir ni cambiar el sexo — esos son pasos posteriores.
   * Es distinto de Fecha Parto (C), que es cuando nacio el ternero. */
  cargado_en: 25,       // Z
  dispositivo: 26,      // AA
  anulada: 27,          // AB
  cargado_dc: 28        // AC
};
var ANCHO_FILA = 29;     // A..AC

/* Encabezado esperado de la fila 1. El backend escribe POR POSICION: si alguien
 * inserta una columna en la planilla, sigue escribiendo donde estaba y corrompe
 * en silencio. Esto es lo que deja detectarlo (?action=esquema + verificar.sh). */
var ENCABEZADOS = [
  'Operario', 'ID Vaca', 'Fecha Parto', 'Hora Nacimiento', 'Tipo Parto',
  'Sexo, Vivo, Mellizos', 'ID Ternero', 'Raza', 'Peso Ternero (Kg)',
  'Calidad Calostro Sin Mejorar', 'Mejorado', 'Calidad de Calostro Mejorado',
  'Lts Calostro Madre Produjo',
  'Origen Calostro', 'ID Vaca Origen Calostro', 'Calidad Calostro Ternero',
  'Lts Calostro para Ternero',
  'Tambo Vaca', 'Asignacion Rodeo Vaca', 'Notas',
  'Sexo Cria', 'Estado Cria',
  'ID Parto', 'Cria', 'UUID', 'Fecha y Hora de Carga', 'Dispositivo', 'Anulada', 'Cargado a DC'
];

/* El encabezado de r5, tal como quedo en produccion. La migracion mapea POR
 * POSICION, asi que si la hoja real no es exactamente esta, mover las columnas
 * mezclaria los datos. Se compara antes de tocar nada. */
var ENCABEZADOS_R5 = [
  'Operario', 'ID Vaca', 'Fecha Parto', 'Hora Nacimiento', 'Tipo Parto',
  'Sexo, Vivo, Mellizos', 'ID Ternero', 'Raza', 'Peso Ternero (Kg)',
  'Calidad Calostro Sin Mejorar', 'Mejorado', 'Calidad de Calostro Mejorado',
  'Calostro Consumido al Momento', 'Lts Calostro Madre Produjo',
  'Lts Calostro para Ternero', 'ID Vaca Origen Calostro',
  'Tambo Vaca', 'Asignacion Rodeo Vaca', 'Notas Nahuel',
  'Sexo Cria', 'Estado Cria', 'ID Parto', 'Cria', 'UUID', 'Cargado en', 'Dispositivo'
];

// De G a Q va todo en '---' cuando la cria nacio muerta, igual que se hacia a mano.
var BLOQUE_CRIA_DESDE = COL.id_ternero;      // G
var BLOQUE_CRIA_HASTA = COL.lts_ternero;     // Q

/* '0' Brix quiere decir "no se midio / no hubo calostro". No es un numero mas:
 * si no hubo calostro, no hay nada que mejorar. */
var SIN_CALOSTRO = '0';

/* ---------- La vista 'Datos Carga DC' ---------- */

/* Las columnas en el orden en que Nahuel carga en DairyComp. Es una tabla real
 * mantenida por script, NO formulas: una celda editable dentro de un derrame
 * queda anclada a una POSICION de grilla, y cambiar el sexo de un parto inserta
 * filas en el medio de Registros. El rodeo y el tilde de todas las filas de
 * abajo pasarian a la cria equivocada, en silencio. Aca cada fila lleva su
 * clave y todo se replica por clave, nunca por posicion. */
var DC = {
  id_vaca: 0,
  fecha: 1,
  sexo_id: 2,           // inicial del sexo pegada al ID: H25045 / M25045
  tipo_parto: 3,
  calostro_madre: 4,    // el natural, tal como lo produjo la vaca
  calostro_final: 5,    // el mejorado si se mejoro
  sexo: 6,
  id_ternero: 7,
  lts_ternero: 8,
  calidad_ternero: 9,
  raza: 10,
  lts_madre: 11,
  metodo: 12,
  operario: 13,
  rodeo: 14,            // lo escribe Nahuel aca
  cargado: 15,          // checkbox, lo tilda Nahuel aca
  clave: 16             // oculta: uuid|cria
};
var DC_ANCHO = 17;
var DC_METODO = 'Sonda';
var DC_ENCABEZADOS = [
  'ID Vaca', 'Fecha', 'Sexo + ID Ternero', 'Tipo Parto',
  'Calidad Calostro Madre', 'Calidad Calostro Madre (final)',
  'Sexo, Vivo, Mellizos', 'ID Ternero', 'Lts Calostro para Ternero',
  'Calidad Calostro que tomo el ternero', 'Raza', 'Lts Calostro Madre Produjo',
  'Metodo', 'Operario', 'Asignacion Rodeo', 'Cargado a DC', 'clave'
];
var DC_INICIAL = { 'Hembra': 'H', 'Macho': 'M' };

var ORIGEN_PROPIA = 'Propia madre';
var ORIGEN_OTRA = 'Otra vaca';
var ORIGENES = [ORIGEN_PROPIA, ORIGEN_OTRA];

var LOCK_MS = 30000;

/* Que se puede corregir de un parto ya escrito, y donde vive cada cosa.
 * El codigo de sexo va por su propia accion ('cambiar_sexo'), no por aca:
 * dice cuantas crias hay, asi que cambiarlo puede agregar o anular renglones,
 * y editarParto_ mantiene la garantia de no mover ninguno.
 * ID de ternero, raza, hora, tipo de parto y notas no se corrigen desde la
 * tablet: identifican al animal y los toca Nahuel en la planilla. */
var EDITABLE_CRIA = {          // por cria: cada fila lleva la suya
  peso: COL.peso,
  origen_calostro: COL.origen_calostro,
  id_vaca_origen: COL.id_vaca_origen,
  calidad_ternero: COL.calidad_ternero,
  lts_ternero: COL.lts_ternero
};
/* Del parto: se repiten iguales en todas sus filas. Los cuatro primeros son el
 * calostro de la madre y viven DENTRO del bloque G-Q, asi que en una cria
 * muerta no se pueden escribir: dejarian un valor suelto entre los '---'. */
var EDITABLE_PARTO_EN_BLOQUE = {
  calidad_sin_mejorar: COL.calidad_sin_mejorar,
  mejorado: COL.mejorado,
  calidad_mejorado: COL.calidad_mejorado,
  lts_madre: COL.lts_madre
};
var EDITABLE_PARTO = { tambo: COL.tambo };   // fuera del bloque: se corrige siempre

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
  // La calidad de lo que efectivamente tomo el ternero se valida contra la
  // misma lista que la de la madre: es el mismo dominio de valores de Brix.
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
    if (payload.accion === 'calostro') {
      return json_(consultaCalostro_(SpreadsheetApp.openById(SS_ID), payload.vaca));
    }

    // Corregir un parto ya escrito. Va por su propio camino y NO por el alta:
    // ahi el uuid es la llave de idempotencia, y una correccion que entrara por
    // esa puerta seria indistinguible de un reintento de la cola de la tablet.
    if (payload.accion === 'editar') {
      return editarParto_(payload, auth);
    }

    // Cambiar el codigo de sexo es lo unico que puede cambiar CUANTAS filas
    // tiene un parto. Va por su propia puerta para que editarParto_ conserve
    // intacta su garantia de no mover nunca un renglon.
    if (payload.accion === 'cambiar_sexo') {
      return cambiarSexo_(payload, auth);
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

      if (!esquemaOk_(ss)) return json_({ ok: false, error: SIN_MIGRAR });

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
      var hoja = hojaRegistros_(ss);
      hoja.getRange(hoja.getLastRow() + 1, 1, filas.length, filas[0].length).setValues(filas);

      log.getRange(filaLog, 4, 1, 2).setValues([[filas.length, 'ok']]);
      // Esta vaca acaba de parir: lo que diga el cache sobre su calostro quedo viejo.
      try { CacheService.getScriptCache().remove('cal_' + str_(payload.id_vaca)); } catch (e) {}
      actualizarDC_(ss);

      return json_({
        ok: true,
        uuid: payload.uuid,
        id_parto: filas[0][COL.id_parto],
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

    /* El backend escribe por posicion. Si alguien inserta o mueve una columna,
       sigue escribiendo donde estaba y corrompe en silencio hasta que alguien
       lo nota a ojo. Esto lo hace detectable desde verificar.sh. */
    if (p.action === 'esquema') {
      var a0 = autorizar_(p);
      if (!a0.ok) return json_({ ok: false, error: a0.error });
      return json_(esquema_(ss));
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

    if (p.action === 'calostro') {
      var a3 = autorizar_(p);
      if (!a3.ok) return json_({ ok: false, error: a3.error });
      return json_(consultaCalostro_(ss, p.vaca));
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
 * El calostro de la MADRE es del parto: lo produjo la vaca, no la cria. Se
 * acepta arriba (formato r6) y, si no viene, en la primera cria (formato r5),
 * para que una tablet que todavia no actualizo el service worker siga entrando.
 */
function calostroMadre_(p) {
  var arriba = p.calostro || {};
  if (arriba.calidad_sin_mejorar !== undefined || arriba.mejorado !== undefined) return arriba;
  var t = (p.terneros || []).filter(function (x) { return x && x.vive !== false; })[0];
  return (t && t.calostro) || {};
}

/**
 * Un parto -> una fila POR TERNERO. Parto simple = 1 fila. Mellizos = 2 filas
 * con el mismo ID Parto y Cria 1/2 y 2/2.
 *
 * Cada cria lleva SU sexo, SU estado y SU calostro suministrado (N-Q): con el
 * codigo 8 (M+M o M+H) no habia forma de saber que fue cada una, ni de anotar
 * que a cada ternero se le dio un calostro distinto. Lo que produjo la madre
 * (J-M) es del parto y se repite igual en las dos filas.
 */
function construirFilas_(ss, p) {
  var tz = ss.getSpreadsheetTimeZone();
  var fecha = parseFecha_(p.fecha_parto);
  var partoMuerto = esMuerto_(p.sexo);
  var idParto = Utilities.formatDate(fecha, tz, 'yyyyMMdd') + '-' + p.id_vaca + '-' +
                String(p.uuid).replace(/-/g, '').substring(0, 4);
  // La marca de carga viene de la tablet, del momento en que se apreto Guardar.
  // Solo se pone la del servidor si el payload no la trae (formato muy viejo).
  var cargadoEn = p.cargado_en ? new Date(p.cargado_en) : new Date();
  var madre = calostroMadre_(p);
  var ltsMadre = ltsMadre_(p);

  var terneros = partoMuerto ? [null] : (p.terneros && p.terneros.length ? p.terneros : [null]);

  return terneros.map(function (t, i) {
    var muerto = partoMuerto || !t || t.vive === false;
    var cal = (t && t.calostro) || {};

    // Cria muerta: el formato lleva '---' de G a Q, igual que se hacia a mano.
    var bloque = muerto
      ? repetir_(VACIO, BLOQUE_CRIA_HASTA - BLOQUE_CRIA_DESDE + 1)
      : [
          str_(t.id_ternero), str_(t.raza), num_(t.peso),
          str_(madre.calidad_sin_mejorar), str_(madre.mejorado),
          str_(madre.calidad_mejorado || VACIO), num_(ltsMadre),
          str_(origenCalostro_(p, cal)), str_(idOrigen_(p, cal)),
          str_(calidadTernero_(madre, cal)), num_(cal.lts_ternero)
        ];

    return [
      str_(p.operario), str_(p.id_vaca), fecha, str_(p.hora_nacimiento),
      str_(p.tipo_parto), str_(p.sexo)
    ].concat(bloque).concat([
      // El rodeo no se carga en la tablet: la columna S queda vacia y la escribe
      // Nahuel desde 'Datos Carga DC'. Vacio se lee como "falta asignar", que es
      // el estado real; '---' no sirve porque en G-Q ya significa "cria muerta"
      // y sumarle un segundo sentido lo vuelve ambiguo.
      str_(p.tambo), '', str_(p.notas),
      sexoCria_(p, t), muerto ? 'Muerto' : 'Vivo',
      idParto, (i + 1) + '/' + terneros.length, str_(p.uuid), cargadoEn,
      str_(p.dispositivo), '', false
    ]);
  });
}

function repetir_(v, n) {
  var out = [];
  for (var i = 0; i < n; i++) out.push(v);
  return out;
}

/** De donde salio el calostro de esta cria. Sin dato, se asume la propia madre. */
function origenCalostro_(p, cal) {
  if (cal.origen) return cal.origen;
  // Formato r5: solo venia el ID de la vaca origen. Si es la misma que pario,
  // era su propia madre; si es otra, era de otra vaca.
  if (cal.id_vaca_origen && String(cal.id_vaca_origen) !== String(p.id_vaca)) return ORIGEN_OTRA;
  return ORIGEN_PROPIA;
}

/** Con 'Propia madre' el ID sale solo del parto: no se le pide al operario. */
function idOrigen_(p, cal) {
  if (origenCalostro_(p, cal) === ORIGEN_PROPIA) return p.id_vaca;
  return cal.id_vaca_origen;
}

/** Los Brix de lo que efectivamente tomo el ternero. */
function calidadTernero_(madre, cal) {
  if (cal.calidad_ternero !== undefined && cal.calidad_ternero !== '') return cal.calidad_ternero;
  // Sin dato (formato r5, o calostro de la propia madre): es lo que produjo la
  // madre, mejorado si se mejoro.
  if (String(madre.mejorado) === 'Si' && madre.calidad_mejorado &&
      String(madre.calidad_mejorado) !== VACIO) return madre.calidad_mejorado;
  return madre.calidad_sin_mejorar;
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
  origen_calostro: str_, id_vaca_origen: str_, calidad_ternero: str_, tambo: str_
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
    if (!esquemaOk_(ss)) return json_({ ok: false, error: SIN_MIGRAR });
    var hoja = hojaRegistros_(ss);
    var tz = ss.getSpreadsheetTimeZone();

    var filas = filasActivas_(filasDeUuid_(hoja, p.uuid));
    if (!filas.length) return json_({ ok: false, error: 'no existe el parto ' + p.uuid });

    // La ventana es lo cargado HOY, no la fecha del parto: un parto de ayer
    // cargado esta manana todavia se corrige, y uno cargado ayer ya no.
    if (!cargadoHoy_(filas[0].datos[COL.cargado_en], tz)) {
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
      // Una cria muerta lleva '---' de G a Q, igual que se hacia a mano.
      var muerta = String(f.datos[COL.estado_cria]) === 'Muerto';
      var madre = calostroMadre_(p);

      // El tambo (R) es del parto y esta fuera de ese bloque: se corrige siempre.
      anotarCambio_(cambios, err, listas, f, EDITABLE_PARTO.tambo, 'tambo', p.tambo, '');

      // El calostro de la madre tambien es del parto, pero vive DENTRO del
      // bloque G-Q. Escribirlo en una fila de cria muerta dejaria valores
      // sueltos en el medio de los '---'.
      var deMadre = { lts_madre: p.lts_madre };
      Object.keys(EDITABLE_PARTO_EN_BLOQUE).forEach(function (clave) {
        if (clave !== 'lts_madre') deMadre[clave] = madre[clave];
      });
      if (muerta) {
        if (Object.keys(deMadre).some(function (k) { return deMadre[k] !== undefined; })) {
          err.push(pre + 'cria muerta: de G a Q va todo en ' + VACIO);
        }
      } else {
        Object.keys(EDITABLE_PARTO_EN_BLOQUE).forEach(function (clave) {
          anotarCambio_(cambios, err, listas, f, EDITABLE_PARTO_EN_BLOQUE[clave],
                        clave, deMadre[clave], '');
        });

        // La columna L solo se habilita con Mejorado = Si. Se mira el resultado
        // final, no lo que vino: se puede estar cambiando uno solo de los dos.
        // Va aca, y no mas abajo, porque es del parto: abajo hay un return que
        // corta cuando esta cria no trae datos propios.
        var mejorado = resultanteParto_(f, madre, 'mejorado', COL.mejorado);
        var calidad = resultanteParto_(f, madre, 'calidad_mejorado', COL.calidad_mejorado);
        var sinMejorar = resultanteParto_(f, madre, 'calidad_sin_mejorar',
                                          COL.calidad_sin_mejorar);
        if (String(sinMejorar) === SIN_CALOSTRO && String(mejorado) === 'Si') {
          err.push(pre + 'calidad ' + SIN_CALOSTRO + ' es "sin calostro": no hay nada que mejorar');
        }
        if (String(mejorado) === 'Si' && (!calidad || String(calidad) === VACIO)) {
          err.push(pre + 'mejorado=Si pero calidad_mejorado vacia');
        }
        if (String(mejorado) !== 'Si' && calidad && String(calidad) !== VACIO) {
          err.push(pre + 'calidad_mejorado cargada con mejorado=' + mejorado);
        }
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
      if (t.peso !== undefined && String(f.datos[COL.peso]) !== String(num_(t.peso)) &&
          String(p.operario) !== String(f.datos[COL.operario])) {
        err.push(pre + 'el peso lo carga ' + f.datos[COL.operario] + ', que fue quien cargo el parto');
      }

      var cal = t.calostro || {};
      Object.keys(EDITABLE_CRIA).forEach(function (clave) {
        var valor = clave === 'peso' ? t.peso
                  : clave === 'origen_calostro' ? cal.origen
                  : clave === 'id_vaca_origen' ? idOrigenEditado_(p, f, cal)
                  : cal[clave];
        anotarCambio_(cambios, err, listas, f, EDITABLE_CRIA[clave], clave, valor, pre);
      });
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
    actualizarDC_(ss);

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
function resultanteParto_(f, madre, clave, col) {
  var v = madre[clave];
  return v === undefined || v === null ? f.datos[col] : v;
}

/* Con 'Propia madre' el ID de origen no lo elige el operario: es la vaca que
 * pario. Si no, quedaria libre poner cualquier numero y marcarlo como propio. */
function idOrigenEditado_(p, f, cal) {
  var origen = cal.origen === undefined ? f.datos[COL.origen_calostro] : cal.origen;
  if (String(origen) === ORIGEN_PROPIA) return p.id_vaca || f.datos[COL.id_vaca];
  return cal.id_vaca_origen;
}

function tocaAlgo_(t) {
  if (t.peso !== undefined) return true;
  var cal = t.calostro || {};
  return Object.keys(cal).some(function (k) { return cal[k] !== undefined; });
}

/**
 * Cambiar el codigo de sexo de un parto ya escrito.
 *
 * Es la unica operacion que cambia CUANTAS filas tiene un parto, y por eso no
 * entra por 'editar': ahi la garantia es que nunca se agrega ni se mueve un
 * renglon, y vale la pena conservarla entera.
 *
 * El payload describe el ESTADO FINAL completo del parto, no un diff: aplicarlo
 * dos veces converge al mismo resultado. Y trae su propio op_uuid, porque la
 * cola de la tablet reintenta a ciegas ante un error de red y un reintento que
 * agregue otra cria seria un desastre silencioso.
 *
 * Una cria que sobra NO se borra: se anula. Borrar es irreversible y esto se
 * hace con el animal delante. La fila queda con G-Q en '---' y Anulada = Si,
 * fuera de la vista de DairyComp, y su contenido anterior entero en _log.
 * Si el parto vuelve a ser doble, esa misma fila se reutiliza.
 */
function cambiarSexo_(p, auth) {
  if (!p.uuid) return json_({ ok: false, error: 'falta uuid' });
  if (!p.op_uuid) return json_({ ok: false, error: 'falta op_uuid' });

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) return json_({ ok: false, error: 'ocupado, reintentar' });

  try {
    var ss = SpreadsheetApp.openById(SS_ID);
    if (!esquemaOk_(ss)) return json_({ ok: false, error: SIN_MIGRAR });
    var hoja = hojaRegistros_(ss);
    var log = ss.getSheetByName(HOJA_LOG);
    var tz = ss.getSpreadsheetTimeZone();

    if (buscarUuid_(log, p.op_uuid)) {
      return json_({ ok: true, duplicado: true, uuid: p.uuid });
    }

    var filas = filasDeUuid_(hoja, p.uuid).sort(function (a, b) { return a.fila - b.fila; });
    if (!filas.length) return json_({ ok: false, error: 'no existe el parto ' + p.uuid });

    if (!cargadoHoy_(filas[0].datos[COL.cargado_en], tz)) {
      return json_({ ok: false, error: 'solo se corrigen partos cargados hoy' });
    }

    /* El parto entero, como va a quedar. Lo que este cambio no decide sale de
       la fila que ya existe, y asi se valida con las MISMAS reglas del alta en
       vez de con una copia que se desincroniza. */
    var base = filas[0].datos;
    var completo = {
      uuid: p.uuid,
      operario: str_(p.operario) || str_(base[COL.operario]),
      id_vaca: str_(base[COL.id_vaca]),
      fecha_parto: Utilities.formatDate(base[COL.fecha], tz, 'yyyy-MM-dd'),
      hora_nacimiento: str_(base[COL.hora]),
      tipo_parto: str_(base[COL.tipo_parto]),
      sexo: str_(p.sexo),
      lts_madre: p.lts_madre !== undefined ? p.lts_madre : base[COL.lts_madre],
      calostro: p.calostro || {
        calidad_sin_mejorar: str_(base[COL.calidad_sin_mejorar]),
        mejorado: str_(base[COL.mejorado]),
        calidad_mejorado: str_(base[COL.calidad_mejorado])
      },
      terneros: p.terneros || [],
      tambo: p.tambo !== undefined ? str_(p.tambo) : str_(base[COL.tambo]),
      notas: str_(base[COL.notas]),
      cargado_en: base[COL.cargado_en],
      dispositivo: str_(base[COL.dispositivo])
    };

    var listas = leerMaestro_(ss);
    var err = validar_(completo, listas);
    if (err.length) {
      log.appendRow([p.op_uuid, new Date(), JSON.stringify(p), 0,
                     'cambio de sexo rechazado: ' + err.join(' | '), auth.email]);
      return json_({ ok: false, error: 'validacion', detalles: err });
    }

    var nuevas = construirFilas_(ss, completo);

    // Se reclama el op_uuid ANTES de tocar la hoja: si algo falla en el medio,
    // el reintento lo ve reclamado y no vuelve a agregar filas.
    log.appendRow([p.op_uuid, new Date(), JSON.stringify(p), 0, 'recibido', auth.email]);
    var filaLog = log.getLastRow();

    var activas = filas.filter(function (f) { return !esAnulada_(f); });
    var dormidas = filas.filter(esAnulada_);
    var destino = activas.slice();
    var revividas = 0, agregadas = 0;

    // Primero se reutiliza lo que ya existe anulado: mejor que insertar de nuevo.
    while (destino.length < nuevas.length && dormidas.length) {
      destino.push(dormidas.shift());
      revividas++;
    }
    var ultima = filas[filas.length - 1].fila;
    while (destino.length < nuevas.length) {
      // Insertar corre hacia abajo lo que sigue, con su rodeo incluido: Sheets
      // mueve los valores junto con la fila, no se corrompe nada.
      hoja.insertRowAfter(ultima);
      ultima++;
      destino.push({ fila: ultima, datos: repetir_('', ANCHO_FILA), nueva: true });
      agregadas++;
    }
    var sobran = destino.splice(nuevas.length);

    destino.forEach(function (d, i) {
      var fila = nuevas[i].slice();
      if (!d.nueva) {
        // El rodeo lo carga Nahuel y el tilde de DC tambien: no los decide esto.
        fila[COL.rodeo] = d.datos[COL.rodeo];
        fila[COL.cargado_dc] = d.datos[COL.cargado_dc];
      }
      fila[COL.anulada] = '';
      hoja.getRange(d.fila, 1, 1, ANCHO_FILA).setValues([fila]);
    });

    sobran.forEach(function (d) {
      log.appendRow([p.uuid, new Date(), JSON.stringify(d.datos), -1,
                     'cria anulada por cambio de sexo', auth.email]);
      var fila = d.datos.slice();
      for (var c = BLOQUE_CRIA_DESDE; c <= BLOQUE_CRIA_HASTA; c++) fila[c] = VACIO;
      fila[COL.cria] = 'anulada';
      fila[COL.anulada] = 'Si';
      hoja.getRange(d.fila, 1, 1, ANCHO_FILA).setValues([fila]);
    });

    log.getRange(filaLog, 4, 1, 2).setValues([[destino.length,
      'sexo cambiado a "' + str_(p.sexo) + '" por ' + str_(p.operario)]]);
    try { CacheService.getScriptCache().remove('cal_' + str_(completo.id_vaca)); } catch (e) {}
    actualizarDC_(ss);

    return json_({ ok: true, uuid: p.uuid, sexo: str_(p.sexo), filas: destino.length,
                   agregadas: agregadas, revividas: revividas, anuladas: sobran.length });
  } finally {
    lock.releaseLock();
  }
}

var esAnulada_ = function (f) { return String(f.datos[COL.anulada]) === 'Si'; };
var filasActivas_ = function (filas) { return filas.filter(function (f) { return !esAnulada_(f); }); };

/** Todas las filas de un parto, por uuid (columna X). Mellizos devuelven dos. */
function filasDeUuid_(hoja, uuid) {
  if (hoja.getLastRow() < 2) return [];
  var datos = hoja.getRange(2, 1, hoja.getLastRow() - 1, ANCHO_FILA).getValues();
  var out = [];
  for (var i = 0; i < datos.length; i++) {
    if (String(datos[i][COL.uuid]) === String(uuid)) out.push({ fila: i + 2, datos: datos[i] });
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
  /* El calostro DE LA MADRE es del parto: lo produjo la vaca, no la cria.
     Antes se validaba una vez por cria y en un mellizo se podian cargar dos
     calidades distintas para la misma vaca. */
  var madre = calostroMadre_(p);
  enLista_(err, listas, 'lts_madre', ltsMadre_(p));
  enLista_(err, listas, 'calidad_sin_mejorar', madre.calidad_sin_mejorar);
  enLista_(err, listas, 'mejorado', madre.mejorado);
  if (String(madre.calidad_sin_mejorar) === SIN_CALOSTRO && String(madre.mejorado) === 'Si') {
    err.push('calidad ' + SIN_CALOSTRO + ' es "sin calostro": no hay nada que mejorar');
  }
  if (String(madre.mejorado) === 'Si') {
    enLista_(err, listas, 'calidad_mejorado', madre.calidad_mejorado);
    if (!madre.calidad_mejorado || String(madre.calidad_mejorado) === VACIO) {
      err.push('mejorado=Si pero calidad_mejorado vacia');
    }
  } else if (madre.calidad_mejorado && String(madre.calidad_mejorado) !== VACIO) {
    err.push('calidad_mejorado cargada con mejorado=' + madre.mejorado);
  }

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

    /* Lo que tomo ESTE ternero: puede ser de su propia madre o de otra vaca,
       y en ese caso con una calidad distinta a la que produjo la madre. */
    var cal = t.calostro || {};
    enLista_(err, listas, 'lts_ternero', cal.lts_ternero, pre);
    enLista_(err, listas, 'calidad_sin_mejorar', cal.calidad_ternero, pre);

    if (cal.origen !== undefined && ORIGENES.indexOf(String(cal.origen)) === -1) {
      err.push(pre + 'origen de calostro invalido: "' + cal.origen + '"');
    }
    // Con 'Otra vaca' hace falta decir cual: si no, no hay como rastrear de
    // donde salio ese calostro.
    if (String(cal.origen) === ORIGEN_OTRA && !String(cal.id_vaca_origen || '').trim()) {
      err.push(pre + 'falta el ID de la vaca que dio el calostro');
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
  var hoja = hojaRegistros_(ss);
  // Sin migrar, leer por posicion devolveria datos de otras columnas.
  if (!hoja || hoja.getLastRow() < 2 || !esquemaOk_(ss)) return [];

  var tz = ss.getSpreadsheetTimeZone();
  var buscada = fechaISO || Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var datos = hoja.getRange(2, 1, hoja.getLastRow() - 1, ANCHO_FILA).getValues();

  return datos.map(function (f, i) {
    return { f: f, fila: i + 2 };                 // +2: la 1 es el encabezado
  }).filter(function (r) {
    var d = r.f[COL.fecha];
    return d instanceof Date && Utilities.formatDate(d, tz, 'yyyy-MM-dd') === buscada;
  }).map(function (r) {
    var f = r.f;
    return {
      fila: r.fila,
      operario: f[COL.operario], id_vaca: f[COL.id_vaca],
      fecha: Utilities.formatDate(f[COL.fecha], tz, 'yyyy-MM-dd'), hora: f[COL.hora],
      tipo_parto: f[COL.tipo_parto], sexo: f[COL.sexo],
      id_ternero: f[COL.id_ternero], raza: f[COL.raza], peso: f[COL.peso],
      calidad_sin_mejorar: f[COL.calidad_sin_mejorar], mejorado: f[COL.mejorado],
      calidad_mejorado: f[COL.calidad_mejorado], lts_madre: f[COL.lts_madre],
      origen_calostro: f[COL.origen_calostro], id_vaca_origen: f[COL.id_vaca_origen],
      calidad_ternero: f[COL.calidad_ternero], lts_ternero: f[COL.lts_ternero],
      tambo: f[COL.tambo], rodeo: f[COL.rodeo], notas: f[COL.notas],
      sexo_cria: f[COL.sexo_cria], estado_cria: f[COL.estado_cria],
      id_parto: f[COL.id_parto], cria: f[COL.cria], uuid: f[COL.uuid],
      // La lista de la tablet muestra cuando se cargo, no solo la hora de
      // nacimiento: son dos cosas distintas y se confundian.
      cargado_en: f[COL.cargado_en] instanceof Date
        ? Utilities.formatDate(f[COL.cargado_en], tz, 'yyyy-MM-dd HH:mm') : '',
      dispositivo: f[COL.dispositivo],
      anulada: String(f[COL.anulada]) === 'Si',
      cargado_dc: f[COL.cargado_dc] === true
    };
  }).filter(function (x) { return !x.anulada; });
}

/**
 * La hoja de registros, con el nombre nuevo o el viejo. Tener los dos es lo que
 * permite deployar y renombrar la pestaña en momentos distintos: si se
 * renombrara antes de publicar, getSheetByName daria null y todo doPost
 * explotaria. Se saca en r7, cuando el rename ya este hecho.
 */
function hojaRegistros_(ss) {
  return ss.getSheetByName(HOJA_FORMATO) || ss.getSheetByName(HOJA_FORMATO_VIEJA);
}

/* Mensaje unico, para reconocerlo de un vistazo en _log y en la tablet. */
var SIN_MIGRAR = 'la planilla todavia no esta migrada a r6: correr migrarR6()';

/**
 * ¿La hoja tiene el layout que este codigo espera?
 *
 * Es lo que permite deployar SIN frenar a los operarios. Entre el deploy y la
 * migracion, escribir seria escribir en la columna equivocada; devolver un
 * error de servidor —no de validacion— hace que la tablet deje el parto en la
 * cola y lo reintente sola. Apenas la planilla queda migrada, la cola se drena
 * sin que nadie toque nada.
 */
function esquemaOk_(ss) {
  try { return esquema_(ss).ok === true; } catch (err) { return false; }
}

/** Compara la fila 1 de la hoja contra el encabezado que espera el codigo. */
function esquema_(ss) {
  var hoja = hojaRegistros_(ss);
  if (!hoja) return { ok: false, error: 'no existe la hoja de registros' };
  var real = hoja.getRange(1, 1, 1, ENCABEZADOS.length).getValues()[0].map(str_);
  var mal = [];
  ENCABEZADOS.forEach(function (esperado, i) {
    if (normalizar_(real[i]) !== normalizar_(esperado)) {
      mal.push((i + 1) + ': esperaba "' + esperado + '" y hay "' + real[i] + '"');
    }
  });
  return { ok: !mal.length, version: VERSION, hoja: hoja.getName(),
           columnas: ENCABEZADOS.length, encabezados: real, diferencias: mal };
}

/**
 * Reconstruye 'Datos Carga DC' desde 'Registros'.
 *
 * Lo que Nahuel escribe en la vista —el rodeo y el tilde— se conserva POR
 * CLAVE, no por posicion, y de paso se replica a Registros: asi, si el trigger
 * de onEdit se perdio una edicion, la reconstruccion la recupera en vez de
 * pisarla.
 *
 * Las crias anuladas no entran. Las muertas SI: la vaca vuelve igual a un
 * rodeo, y si no aparecieran no habria donde asignarselo.
 */
function reconstruirDC_(ss) {
  var hoja = hojaRegistros_(ss);
  var dc = ss.getSheetByName(HOJA_DC);
  if (!hoja || !dc) return 0;
  // Antes de migrar, la vista se armaria con las columnas corridas. Mejor
  // vacia: asi se puede crear la pestaña con la app en marcha, sin apuro.
  if (!esquemaOk_(ss)) return -1;

  // Lo que ya escribio Nahuel, indexado por clave.
  var previo = {};
  if (dc.getLastRow() > 1) {
    dc.getRange(2, 1, dc.getLastRow() - 1, DC_ANCHO).getValues().forEach(function (f) {
      var k = str_(f[DC.clave]);
      if (k) previo[k] = { rodeo: f[DC.rodeo], cargado: f[DC.cargado] === true };
    });
  }

  var datos = hoja.getLastRow() > 1
    ? hoja.getRange(2, 1, hoja.getLastRow() - 1, ANCHO_FILA).getValues() : [];

  var salida = [];
  var replicar = [];
  var tz = ss.getSpreadsheetTimeZone();

  datos.forEach(function (f, i) {
    if (String(f[COL.anulada]) === 'Si') return;

    var clave = str_(f[COL.uuid]) + '|' + str_(f[COL.cria]);
    var vista = previo[clave];

    /* Un valor NUNCA se pisa con un vacio. Si Nahuel escribio el rodeo en la
       vista, ese manda; si lo escribio directo en Registros, la vista lo toma.
       Borrar un rodeo desde la vista lo baja igual, porque de eso ya se
       encargo el trigger de onEdit antes de llegar aca. */
    var rodeo = (vista && str_(vista.rodeo) !== '') ? vista.rodeo : f[COL.rodeo];
    // El tilde solo vive en la vista, asi que ahi manda siempre: destildar es
    // una accion tan valida como tildar.
    var cargado = vista ? vista.cargado : f[COL.cargado_dc] === true;

    if (str_(rodeo) !== str_(f[COL.rodeo]) || cargado !== (f[COL.cargado_dc] === true)) {
      replicar.push({ fila: i + 2, rodeo: rodeo, cargado: cargado });
    }

    var muerta = String(f[COL.estado_cria]) === 'Muerto' || str_(f[COL.id_ternero]) === VACIO;
    var id = str_(f[COL.id_ternero]);
    var inicial = DC_INICIAL[str_(f[COL.sexo_cria])] || '';
    var limpio = function (v) { return muerta || str_(v) === VACIO ? '' : v; };

    salida.push([
      f[COL.id_vaca],
      f[COL.fecha] instanceof Date ? Utilities.formatDate(f[COL.fecha], tz, 'dd/MM/yyyy') : '',
      inicial + (id === VACIO ? '' : id),
      f[COL.tipo_parto],
      limpio(f[COL.calidad_sin_mejorar]),
      limpio(calostroFinal_(f)),
      f[COL.sexo],
      limpio(id),
      limpio(f[COL.lts_ternero]),
      limpio(f[COL.calidad_ternero]),
      limpio(f[COL.raza]),
      limpio(f[COL.lts_madre]),
      DC_METODO,
      f[COL.operario],
      rodeo,
      cargado,
      clave
    ]);
  });

  // Se limpia solo el cuerpo: la fila 1 lleva los encabezados y el checkbox.
  if (dc.getLastRow() > 1) {
    dc.getRange(2, 1, dc.getLastRow() - 1, DC_ANCHO).clearContent();
  }
  if (salida.length) dc.getRange(2, 1, salida.length, DC_ANCHO).setValues(salida);

  replicar.forEach(function (r) {
    hoja.getRange(r.fila, COL.rodeo + 1).setValue(r.rodeo);
    hoja.getRange(r.fila, COL.cargado_dc + 1).setValue(r.cargado);
  });

  return salida.length;
}

/** Los Brix con los que quedo el calostro de la madre: el mejorado si se mejoro. */
function calostroFinal_(f) {
  var mejor = str_(f[COL.calidad_mejorado]);
  return (String(f[COL.mejorado]) === 'Si' && mejor && mejor !== VACIO)
    ? mejor : f[COL.calidad_sin_mejorar];
}

/** Se llama despues de escribir; que falle no puede tumbar la carga del parto. */
function actualizarDC_(ss) {
  try { reconstruirDC_(ss); } catch (err) { /* la vista se recupera con el reloj */ }
}

/** El trigger de tiempo. Existe por si alguna reconstruccion fallo. */
function reconstruirDCporReloj() {
  reconstruirDC_(SpreadsheetApp.openById(SS_ID));
}

/**
 * Nahuel escribe el rodeo o tilda "Cargado a DC" en la vista, y eso baja a
 * Registros. Se ubica por la clave uuid|cria, NUNCA por numero de fila:
 * cambiar el sexo de un parto inserta renglones en el medio.
 *
 * Es un onEdit simple, asi que no se dispara con las escrituras del propio
 * script: no hay bucle con la reconstruccion.
 */
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    var vista = e.range.getSheet();
    if (vista.getName() !== HOJA_DC) return;

    var desde = e.range.getColumn();
    var hasta = desde + e.range.getNumColumns() - 1;
    if (hasta < DC.rodeo + 1 || desde > DC.cargado + 1) return;

    var ss = vista.getParent();
    var hoja = hojaRegistros_(ss);
    if (!hoja) return;
    /* Los triggers simples corren con el codigo GUARDADO, no con el publicado:
       apenas se pega r6 en el editor, este ya esta vivo aunque el deploy siga
       siendo el viejo. Sobre la planilla sin migrar escribiria el rodeo en la
       columna de las notas. */
    if (!esquemaOk_(ss)) return;

    for (var i = 0; i < e.range.getNumRows(); i++) {
      var fila = e.range.getRow() + i;
      if (fila < 2) continue;
      var clave = str_(vista.getRange(fila, DC.clave + 1).getValue());
      var destino = clave ? filaPorClave_(hoja, clave) : 0;
      if (!destino) continue;
      hoja.getRange(destino, COL.rodeo + 1)
          .setValue(vista.getRange(fila, DC.rodeo + 1).getValue());
      hoja.getRange(destino, COL.cargado_dc + 1)
          .setValue(vista.getRange(fila, DC.cargado + 1).getValue() === true);
    }
  } catch (err) {
    // Un trigger simple no puede romperle la edicion al usuario.
  }
}

/** La fila de Registros que corresponde a una clave uuid|cria. */
function filaPorClave_(hoja, clave) {
  var partes = String(clave).split('|');
  var filas = filasDeUuid_(hoja, partes[0]);
  for (var i = 0; i < filas.length; i++) {
    if (str_(filas[i].datos[COL.cria]) === partes[1]) return filas[i].fila;
  }
  return 0;
}

/**
 * Con que calostro cuenta una vaca. Lo usa la tablet cuando el ternero toma
 * calostro de OTRA madre: se carga el numero de esa vaca y la app muestra los
 * Brix que quedaron registrados cuando ella pario, en vez de pedirselos de
 * memoria al operario.
 *
 * Devuelve el ultimo parto de esa vaca con calostro medido. Las filas de cria
 * muerta van todas en '---' y no dicen nada del calostro, asi que se saltean.
 *
 * Sin datos NO es un error: puede ser una vaca que pario antes de que existiera
 * la app, o calostro del freezer. La tablet habilita el campo para cargarlo a
 * mano y el parto se guarda igual.
 */
function consultaCalostro_(ss, vaca) {
  var id = str_(vaca).trim();
  if (!id) return { ok: false, error: 'falta el numero de vaca' };

  var cache = CacheService.getScriptCache();
  var clave = 'cal_' + id;
  var guardado = cache.get(clave);
  if (guardado) return JSON.parse(guardado);

  var r = { ok: true, vaca: id, encontrada: false };
  var hoja = hojaRegistros_(ss);

  if (hoja && hoja.getLastRow() > 1 && esquemaOk_(ss)) {
    // TextFinder sobre una sola columna: evita traer la hoja entera por consulta.
    var hits = hoja.getRange(2, COL.id_vaca + 1, hoja.getLastRow() - 1, 1)
                   .createTextFinder(id).matchEntireCell(true).findAll();
    for (var i = hits.length - 1; i >= 0; i--) {     // de la mas reciente hacia atras
      var f = hoja.getRange(hits[i].getRow(), 1, 1, ANCHO_FILA).getValues()[0];
      var natural = str_(f[COL.calidad_sin_mejorar]);
      if (!natural || natural === VACIO) continue;   // cria muerta: no dice nada

      var mejorado = str_(f[COL.mejorado]);
      var mejor = str_(f[COL.calidad_mejorado]);
      r.encontrada = true;
      r.brix_natural = natural;
      r.mejorado = mejorado;
      r.brix_mejorado = mejor === VACIO ? '' : mejor;
      // Lo que hay para dar es el mejorado si se mejoro; si no, el natural.
      r.brix_final = (mejorado === 'Si' && mejor && mejor !== VACIO) ? mejor : natural;
      r.fecha = f[COL.fecha] instanceof Date
        ? Utilities.formatDate(f[COL.fecha], ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd') : '';
      r.lts_madre = f[COL.lts_madre];
      break;
    }
  }

  cache.put(clave, JSON.stringify(r), 300);
  return r;
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
 * Crea y configura la pestaña 'Datos Carga DC'. Se corre A MANO desde el editor,
 * una sola vez, igual que generarToken().
 *
 * Deja editables SOLO las dos columnas que carga Nahuel (rodeo y el tilde);
 * el resto sale de Registros y no tiene sentido tocarlo aca.
 */
function configurarDC() {
  var ss = SpreadsheetApp.openById(SS_ID);
  var dc = ss.getSheetByName(HOJA_DC) || ss.insertSheet(HOJA_DC);

  dc.getRange(1, 1, 1, DC_ANCHO).setValues([DC_ENCABEZADOS]).setFontWeight('bold');
  dc.setFrozenRows(1);

  var n = Math.max(dc.getMaxRows() - 1, 1);
  dc.getRange(2, DC.cargado + 1, n, 1)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  dc.hideColumns(DC.clave + 1);
  dc.getRange(2, DC.id_vaca + 1, n, 1).setNumberFormat('@');
  dc.getRange(2, DC.id_ternero + 1, n, 1).setNumberFormat('@');

  // Se protege todo salvo las dos columnas que se editan aca.
  try {
    dc.getProtections(SpreadsheetApp.ProtectionType.SHEET)
      .forEach(function (p) { p.remove(); });
    var prot = dc.protect().setDescription('Vista derivada de Registros');
    prot.setUnprotectedRanges([dc.getRange(2, DC.rodeo + 1, n, 2)]);
    prot.setWarningOnly(true);
  } catch (err) {
    Logger.log('No se pudo proteger la hoja: ' + err);
  }

  // Un reloj cada 10 minutos, por si alguna reconstruccion fallo.
  var yaEsta = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'reconstruirDCporReloj';
  });
  if (!yaEsta) {
    ScriptApp.newTrigger('reconstruirDCporReloj').timeBased().everyMinutes(10).create();
    Logger.log('Trigger de reconstruccion creado (cada 10 min).');
  }

  var n = reconstruirDC_(ss);
  if (n < 0) {
    Logger.log('Pestaña y trigger listos. La vista se va a llenar sola en cuanto');
    Logger.log('corras migrarR6(): antes de eso, las columnas todavia estan corridas.');
  } else {
    Logger.log('Filas escritas en la vista: ' + n);
  }
}

/**
 * Migracion r5 -> r6 del layout de 'Registros'. Se corre A MANO desde el editor,
 * una sola vez, con la app en pausa.
 *
 * Que cambia: desaparece 'Calostro Consumido al Momento'; el calostro de la
 * madre y el que tomo el ternero quedan en bloques separados; y se suman
 * Origen Calostro, Calidad Calostro Ternero, Anulada y Cargado a DC.
 *
 * Es idempotente: si el encabezado ya es el nuevo, no hace nada. Y antes de
 * tocar la hoja deja una copia intacta, porque esto reescribe filas de
 * produccion que incluyen el rodeo que Nahuel cargo a mano.
 */
/**
 * Ensayo de la migracion: NO escribe nada. Dice exactamente que va a pasar.
 * Correrla ANTES de migrarR6(), mirar el Registro de ejecucion, y recien
 * entonces migrar.
 */
function revisarMigracionR6() {
  var ss = SpreadsheetApp.openById(SS_ID);
  var plan = planMigracionR6_(ss);
  plan.log.forEach(function (l) { Logger.log(l); });
  Logger.log(plan.ok ? '>> LISTO para correr migrarR6().'
                     : '>> NO migrar todavia: ver arriba.');
  return plan.ok;
}

/** Lo que la migracion encontraria. Solo lee. */
function planMigracionR6_(ss) {
  var out = { ok: false, log: [] };
  var di = function (t) { out.log.push(t); };

  var hoja = hojaRegistros_(ss);
  if (!hoja) { di('No encuentro la hoja de registros.'); return out; }
  di('Hoja: "' + hoja.getName() + '"');

  if (esquema_(ss).ok) {
    di('Ya esta migrada: el encabezado coincide con r6. No hay nada que hacer.');
    return out;
  }

  // Mapear por posicion sobre un encabezado distinto mezclaria los datos.
  var real = hoja.getRange(1, 1, 1, ENCABEZADOS_R5.length).getValues()[0].map(str_);
  var mal = [];
  ENCABEZADOS_R5.forEach(function (esp, i) {
    if (normalizar_(real[i]) !== normalizar_(esp)) {
      mal.push('  col ' + (i + 1) + ': esperaba "' + esp + '" y hay "' + real[i] + '"');
    }
  });
  if (mal.length) {
    di('El encabezado NO es el de r5. La migracion mapea por posicion, asi que');
    di('con estas diferencias mezclaria los datos:');
    mal.forEach(di);
    return out;
  }
  di('Encabezado r5 confirmado, columna por columna.');

  var ultima = hoja.getLastRow();
  if (ultima < 2) { di('La hoja no tiene datos. Migrar es solo cambiar el encabezado.');
                    out.ok = true; return out; }

  var filas = hoja.getRange(2, 1, ultima - 1, 26).getValues();
  var conRodeo = 0, muertas = 0, mejorados = 0, deOtraVaca = 0, sinFecha = 0;
  filas.forEach(function (v) {
    if (str_(v[17]).trim() && str_(v[17]) !== VACIO) conRodeo++;
    if (str_(v[6]) === VACIO) muertas++;
    if (String(v[10]) === 'Si') mejorados++;
    var org = str_(v[15]);
    if (org && org !== VACIO && org !== str_(v[1])) deOtraVaca++;
    if (!(v[2] instanceof Date)) sinFecha++;
  });

  di('Filas de datos: ' + filas.length);
  di('  con rodeo cargado a mano: ' + conRodeo + '  <- esto es lo que NO se puede perder');
  di('  de cria muerta: ' + muertas);
  di('  con calostro mejorado: ' + mejorados);
  di('  que tomaron calostro de otra vaca: ' + deOtraVaca);
  if (sinFecha) di('  OJO: ' + sinFecha + ' fila(s) sin fecha valida en la columna C');

  var respaldo = ss.getSheetByName('Registros_backup_r5');
  if (respaldo) {
    di('Ya existe "Registros_backup_r5": borralo o renombralo antes de migrar.');
    return out;
  }
  di('Se va a guardar una copia intacta en "Registros_backup_r5" antes de tocar nada.');
  out.ok = true;
  return out;
}

function migrarR6() {
  var ss = SpreadsheetApp.openById(SS_ID);
  var plan = planMigracionR6_(ss);
  plan.log.forEach(function (l) { Logger.log(l); });
  if (!plan.ok) { Logger.log('>> No se migro nada.'); return; }

  var hoja = hojaRegistros_(ss);
  var respaldo = 'Registros_backup_r5';
  hoja.copyTo(ss).setName(respaldo);
  Logger.log('Respaldo guardado en ' + respaldo);

  var ultima = hoja.getLastRow();
  var viejo = ultima > 1 ? hoja.getRange(2, 1, ultima - 1, 26).getValues() : [];

  /* Mapa de la fila vieja (A..Z) a la nueva. Los indices de la izquierda son
     los del layout r5: 12 era 'consumido' y se descarta. */
  var filas = viejo.map(function (v) {
    var muerta = String(v[6]) === VACIO;                 // G en '---': cria muerta
    var idOrigenViejo = str_(v[15]);                     // P vieja
    var origen = muerta ? VACIO
      : (idOrigenViejo && idOrigenViejo !== VACIO && idOrigenViejo !== str_(v[1]))
        ? ORIGEN_OTRA : ORIGEN_PROPIA;
    // Lo que tomo el ternero no existia como dato: se reconstruye con lo que
    // produjo la madre, mejorado si se mejoro. Es lo unico que se sabe.
    var calTernero = muerta ? VACIO
      : (String(v[10]) === 'Si' && v[11] && String(v[11]) !== VACIO ? v[11] : v[9]);
    var idOrigen = muerta ? VACIO
      : (origen === ORIGEN_PROPIA ? str_(v[1]) : idOrigenViejo);

    return [
      v[0], v[1], v[2], v[3], v[4], v[5],               // A-F igual
      v[6], v[7], v[8],                                 // G-I igual
      v[9], v[10], v[11],                               // J-L calostro madre, igual
      v[13],                                            // N vieja -> M: lts madre
      origen, idOrigen, calTernero, v[14],              // N-Q: lo del ternero
      v[16], v[17], v[18],                              // Q,R,S viejas -> R,S,T
      v[19], v[20],                                     // T,U viejas -> U,V
      v[21], v[22], v[23], v[24], v[25],                // V-Z viejas -> W-AA
      '', false                                         // AB Anulada, AC Cargado a DC
    ];
  });

  hoja.clear();
  hoja.getRange(1, 1, 1, ENCABEZADOS.length).setValues([ENCABEZADOS]);
  if (filas.length) {
    hoja.getRange(2, 1, filas.length, ANCHO_FILA).setValues(filas);
  }
  if (hoja.getName() !== HOJA_FORMATO) hoja.setName(HOJA_FORMATO);
  configurarFormatos();

  Logger.log('Migradas ' + filas.length + ' filas a r6. Hoja: ' + hoja.getName());
  Logger.log('Revisa que la columna S (Rodeo) conserve lo que cargo Nahuel.');
  Logger.log('Despues: correr configurarDC() si todavia no existe la vista.');
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
  var hoja = hojaRegistros_(SpreadsheetApp.openById(SS_ID));
  var n = hoja.getMaxRows() - 1;
  var texto = ['id_vaca', 'hora', 'id_ternero', 'id_vaca_origen', 'id_parto', 'cria', 'uuid'];
  texto.forEach(function (k) { hoja.getRange(2, COL[k] + 1, n, 1).setNumberFormat('@'); });
  hoja.getRange(2, COL.fecha + 1, n, 1).setNumberFormat('dd/MM/yyyy');
  hoja.getRange(2, COL.cargado_en + 1, n, 1).setNumberFormat('dd/MM/yyyy HH:mm');
  hoja.getRange(1, 1, 1, ENCABEZADOS.length).setValues([ENCABEZADOS]).setFontWeight('bold');
  hoja.setFrozenRows(1);
}
