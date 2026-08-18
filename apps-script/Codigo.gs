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

var SS_ID = '12da8wxy4tJVLHuJZp-MKlornbi2U11ISWEsgglencE8';
var HOJA_FORMATO = 'NUEVO FORMATO PREPARTO';
var HOJA_MAESTRO = 'Maestro';
var HOJA_LOG = '_log';

var VACIO = '---';
var SEXO_MUERTO = ['4', '7'];
var SEXO_MELLIZO = ['2', '8'];
var LOCK_MS = 30000;

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
        id_parto: filas[0][19],
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
      return json_({ ok: true, hoja: ss.getName(), ts: new Date().toISOString() });
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
 */
function construirFilas_(ss, p) {
  var tz = ss.getSpreadsheetTimeZone();
  var fecha = parseFecha_(p.fecha_parto);
  var muerto = esMuerto_(p.sexo);
  var cal = p.calostro || {};
  var idParto = Utilities.formatDate(fecha, tz, 'yyyyMMdd') + '-' + p.id_vaca + '-' +
                String(p.uuid).replace(/-/g, '').substring(0, 4);
  var cargadoEn = p.cargado_en ? new Date(p.cargado_en) : new Date();

  var terneros = muerto ? [null] : (p.terneros && p.terneros.length ? p.terneros : [null]);

  return terneros.map(function (t, i) {
    // Cria muerta: el formato lleva '---' de G a P, igual que se hacia a mano.
    var bloque = muerto || !t
      ? [VACIO, VACIO, VACIO, VACIO, VACIO, VACIO, VACIO, VACIO, VACIO, VACIO]
      : [
          str_(t.id_ternero), str_(t.raza), num_(t.peso),
          str_(cal.calidad_sin_mejorar), str_(cal.mejorado),
          str_(cal.calidad_mejorado || VACIO), str_(cal.consumido),
          num_(cal.lts_madre), num_(cal.lts_ternero), str_(cal.id_vaca_origen)
        ];

    return [
      str_(p.operario), str_(p.id_vaca), fecha, str_(p.hora_nacimiento),
      str_(p.tipo_parto), str_(p.sexo)
    ].concat(bloque).concat([
      str_(p.tambo), str_(p.rodeo), str_(p.notas),
      idParto, (i + 1) + '/' + terneros.length, str_(p.uuid), cargadoEn, str_(p.dispositivo)
    ]);
  });
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
  enLista_(err, listas, 'rodeo', p.rodeo);

  if (esMuerto_(p.sexo)) return err;

  var terneros = p.terneros || [];
  if (!terneros.length) err.push('cria viva sin datos de ternero');
  // Un codigo de sexo simple no puede traer dos crias.
  if (!esMellizo_(p.sexo) && terneros.length > 1) {
    err.push('sexo "' + p.sexo + '" no es de parto doble pero vinieron ' +
             terneros.length + ' terneros');
  }
  terneros.forEach(function (t, i) {
    enLista_(err, listas, 'raza', t.raza, 'ternero ' + (i + 1) + ': ');
    enLista_(err, listas, 'peso', t.peso, 'ternero ' + (i + 1) + ': ');
  });

  var cal = p.calostro || {};
  enLista_(err, listas, 'calidad_sin_mejorar', cal.calidad_sin_mejorar);
  enLista_(err, listas, 'mejorado', cal.mejorado);
  enLista_(err, listas, 'consumido', cal.consumido);
  enLista_(err, listas, 'lts_madre', cal.lts_madre);
  enLista_(err, listas, 'lts_ternero', cal.lts_ternero);

  // La columna L solo se habilita con Mejorado = Si; si no, va '---'.
  if (cal.mejorado === 'Si') {
    enLista_(err, listas, 'calidad_mejorado', cal.calidad_mejorado);
    if (String(cal.calidad_mejorado) === VACIO) err.push('mejorado=Si pero calidad_mejorado vacia');
  } else if (cal.calidad_mejorado && String(cal.calidad_mejorado) !== VACIO) {
    err.push('calidad_mejorado cargada con mejorado=' + cal.mejorado);
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
  var datos = hoja.getRange(2, 1, hoja.getLastRow() - 1, 24).getValues();

  return datos.filter(function (f) {
    var d = f[2];
    return d instanceof Date && Utilities.formatDate(d, tz, 'yyyy-MM-dd') === buscada;
  }).map(function (f) {
    return {
      operario: f[0], id_vaca: f[1],
      fecha: Utilities.formatDate(f[2], tz, 'yyyy-MM-dd'), hora: f[3],
      tipo_parto: f[4], sexo: f[5],
      id_ternero: f[6], raza: f[7], peso: f[8],
      calidad_sin_mejorar: f[9], lts_ternero: f[14],
      tambo: f[16], rodeo: f[17], notas: f[18],
      id_parto: f[19], cria: f[20], uuid: f[21]
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
  hoja.getRange(2, 22, n, 1).setNumberFormat('@');           // V  UUID
  hoja.getRange(2, 23, n, 1).setNumberFormat('dd/MM/yyyy HH:mm'); // W Cargado en
}
