/**
 * Prueba local de Codigo.gs — corre con `node test_local.js`.
 *
 * Simula SpreadsheetApp / LockService / PropertiesService / Utilities con objetos
 * en memoria, para verificar la logica (armado de filas, validacion, idempotencia)
 * SIN deployar nada. No reemplaza la prueba con curl contra el /exec real.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TOKEN = 'token-de-prueba';
const TZ = 'America/Argentina/Buenos_Aires';

/* ---------- fakes de las APIs de Google ---------- */

function crearHoja(nombre, filas) {
  return {
    nombre,
    filas,
    getName: () => nombre,
    getLastRow() { return this.filas.length; },
    getMaxRows() { return Math.max(this.filas.length, 1000); },
    appendRow(fila) { this.filas.push(fila.slice()); },
    getDataRange() { return this.rango(1, 1, this.filas.length, anchoMax(this.filas)); },
    getRange(f, c, nf, nc) { return this.rango(f, c, nf, nc); },
    rango(f, c, nf, nc) {
      const hoja = this;
      return {
        getValues() {
          const out = [];
          for (let i = 0; i < nf; i++) {
            const fila = hoja.filas[f - 1 + i] || [];
            const r = [];
            for (let j = 0; j < nc; j++) r.push(fila[c - 1 + j] === undefined ? '' : fila[c - 1 + j]);
            out.push(r);
          }
          return out;
        },
        setValues(vals) {
          vals.forEach((fila, i) => {
            const idx = f - 1 + i;
            while (hoja.filas.length <= idx) hoja.filas.push([]);
            fila.forEach((v, j) => { hoja.filas[idx][c - 1 + j] = v; });
          });
        },
        setNumberFormat() { return this; },
        createTextFinder(txt) {
          return {
            matchEntireCell() { return this; },
            findNext() {
              for (let i = 0; i < nf; i++) {
                const fila = hoja.filas[f - 1 + i] || [];
                for (let j = 0; j < nc; j++) if (String(fila[c - 1 + j]) === String(txt)) return {};
              }
              return null;
            }
          };
        }
      };
    }
  };
}

const anchoMax = (filas) => filas.reduce((m, f) => Math.max(m, f.length), 0);

// Maestro real, copiado de la planilla (con Rodeo VACIA, como esta hoy).
function maestroReal() {
  const enc = ['Operario', 'ID Vaca', 'Fecha Parto', 'Tipo Parto', 'SEXO, VIVO, MELLIZOS',
    'ID Ternero', 'Raza', 'Peso Ternero\n(Kg)', 'Hora Nacimiento',
    'Calidad Calostro Sin Mejorar\n(de madre)', 'Mejorado',
    'Calidad de Calostro Mejorado\n(de madre)', 'Calostro Consumido al Momento',
    'Lts Calostro Madre', 'Lts Calostro para Ternero', 'Vaca que Provee Calostro',
    'Tambo\nVaca', 'Rodeo Vaca (Nahuel)', 'Notas Nahuel'];

  const cols = {
    0: ['Julio', 'Griselda', 'Martin', 'Trini'],
    3: ['1 Normal', '2 Asistido', '4 Cesarea'],
    4: ['1 Hembra Viva', '2 Hembras Gemelas Vivas', '4 Hembra Muerta', '6 Macho Vivo',
        '7 Macho Muerto', '8 Otros Gemelos (M+M o M+H)'],
    6: ['Holando', 'Angus'],
    7: rango(25, 60),
    8: horas(),
    9: rango(18, 35).concat(['mastitis', 'sangre', 'campo']),
    10: ['Si/No'],
    11: ['---'].concat(rango(26, 35)),
    12: ['Si/No'],
    13: rango(0, 20),
    14: rango(2, 6),
    16: ['1', '2', '3'],
    17: []   // Rodeo: VACIA en la planilla real
  };

  const alto = Math.max(...Object.values(cols).map((c) => c.length)) + 1;
  const filas = [enc];
  for (let i = 0; i < alto; i++) {
    filas.push(enc.map((_, c) => (cols[c] && cols[c][i] !== undefined ? cols[c][i] : '')));
  }
  return filas;
}

function rango(a, b) { const o = []; for (let i = a; i <= b; i++) o.push(String(i)); return o; }
function horas() {
  const o = [];
  for (let i = 0; i < 48; i++) {
    o.push(String(Math.floor(i / 2)).padStart(2, '0') + ':' + (i % 2 ? '30' : '00'));
  }
  return o;
}

const HEAD_FORMATO = ['Operario', 'ID Vaca', 'Fecha Parto', 'Hora Nacimiento', 'Tipo Parto',
  'Sexo, Vivo, Mellizos', 'ID Ternero', 'Raza', 'Peso', 'Cal sin mej', 'Mejorado',
  'Cal mej', 'Consumido', 'Lts madre', 'Lts ternero', 'ID origen', 'Tambo', 'Rodeo',
  'Notas', 'Sexo Cria', 'Estado Cria', 'ID Parto', 'Cria', 'UUID', 'Cargado en', 'Dispositivo'];
// Posiciones de las columnas nuevas y las tecnicas, para no contar a mano.
const COL = { sexoCria: 19, estado: 20, idParto: 21, cria: 22, uuid: 23 };

function nuevoLibro() {
  const hojas = {
    'NUEVO FORMATO PREPARTO': crearHoja('NUEVO FORMATO PREPARTO', [HEAD_FORMATO.slice()]),
    'Maestro': crearHoja('Maestro', maestroReal()),
    '_log': crearHoja('_log', [['uuid', 'recibido_en', 'payload_json', 'filas_escritas', 'resultado']])
  };
  return {
    getName: () => 'TRST — Partos',
    getSpreadsheetTimeZone: () => TZ,
    getSheetByName: (n) => hojas[n],
    _hojas: hojas
  };
}

let libro = nuevoLibro();

const dosDigitos = (n) => String(n).padStart(2, '0');

/* Identidad simulada: un "Google" de mentira que devuelve lo que le pidamos,
   para poder probar cada forma de token invalido sin depender de la red. */
const CLIENT_ID = '55795987692-qi482a0cjf657a1884dn3tl88mc0t2e9.apps.googleusercontent.com';
const ADMINS = 'andresduhau@admin.com.ar';
const tokens = {};                 // id_token -> lo que contesta tokeninfo
let llamadasAGoogle = 0;

function registrarToken(nombre, campos) {
  tokens[nombre] = Object.assign({
    aud: CLIENT_ID, hd: 'admin.com.ar', email: 'tablet.maternidad@admin.com.ar',
    email_verified: 'true', exp: String(Math.floor(Date.now() / 1000) + 3600)
  }, campos);
  return nombre;
}

const cacheFalso = {};
const sandbox = {
  console,
  Date,   // compartir el Date del host para que `instanceof Date` funcione en las pruebas
  SpreadsheetApp: { openById: () => libro },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (k) => (k === 'TOKEN' ? TOKEN : k === 'ADMINS' ? ADMINS : null),
      setProperty() {}
    })
  },
  CacheService: {
    getScriptCache: () => ({
      get: (k) => (cacheFalso[k] === undefined ? null : cacheFalso[k]),
      put: (k, v) => { cacheFalso[k] = v; }
    })
  },
  UrlFetchApp: {
    fetch(url) {
      llamadasAGoogle++;
      const t = decodeURIComponent(url.split('id_token=')[1] || '');
      const d = tokens[t];
      return {
        getResponseCode: () => (d ? 200 : 400),
        getContentText: () => JSON.stringify(d || { error: 'invalid_token' })
      };
    }
  },
  ContentService: {
    MimeType: { JSON: 'json' },
    createTextOutput: (t) => ({ setMimeType: () => ({ _texto: t }) })
  },
  Logger: { log: () => {} },
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' },
    computeDigest: (_alg, txt) => Array.from(String(txt)).map((c) => c.charCodeAt(0)),
    base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString('base64url'),
    getUuid: () => 'aaaabbbb-cccc-dddd-eeee-ffff00001111',
    formatDate(d, tz, fmt) {
      const s = {
        'yyyyMMdd': `${d.getFullYear()}${dosDigitos(d.getMonth() + 1)}${dosDigitos(d.getDate())}`,
        'yyyy-MM-dd': `${d.getFullYear()}-${dosDigitos(d.getMonth() + 1)}-${dosDigitos(d.getDate())}`,
        'HH:mm': `${dosDigitos(d.getHours())}:${dosDigitos(d.getMinutes())}`
      };
      return s[fmt] !== undefined ? s[fmt] : d.toISOString();
    }
  }
};

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Codigo.gs'), 'utf8'), sandbox);

/* ---------- helpers de prueba ---------- */

const post = (payload) => JSON.parse(
  sandbox.doPost({ postData: { contents: JSON.stringify(payload) } })._texto);
const get = (parameter) => JSON.parse(sandbox.doGet({ parameter })._texto);
const formato = () => libro._hojas['NUEVO FORMATO PREPARTO'].filas.slice(1);
const log = () => libro._hojas['_log'].filas.slice(1);

const calostroOk = {
  calidad_sin_mejorar: '26', mejorado: 'No', calidad_mejorado: '---',
  consumido: 'Si', lts_ternero: '4', id_vaca_origen: '119'
};

const partoBase = (extra) => Object.assign({
  token: TOKEN, uuid: 'u-simple-0001', dispositivo: 'tablet-maternidad',
  operario: 'Julio', id_vaca: '4115', fecha_parto: '2026-08-12',
  hora_nacimiento: '07:00', tipo_parto: '1 Normal', sexo: '6 Macho Vivo',
  lts_madre: '5',
  terneros: [{ id_ternero: '24543', raza: 'Holando', peso: 42, vive: true, calostro: calostroOk }],
  tambo: '2', rodeo: '26', notas: ''
}, extra || {});

let fallos = 0;
function check(nombre, cond, detalle) {
  if (cond) { console.log('  ok   ' + nombre); }
  else { fallos++; console.log('  FALLA ' + nombre + (detalle ? '  -> ' + detalle : '')); }
}

/* ---------- casos ---------- */

console.log('\n1. Parto simple');
let r = post(partoBase());
check('responde ok', r.ok === true, JSON.stringify(r));
check('escribe 1 fila', formato().length === 1, 'filas=' + formato().length);
// El ID Parto sale del uuid del cliente, no de Utilities.getUuid().
check('id_parto legible', r.id_parto === '20260812-4115-usim', r.id_parto);
let f = formato()[0];
check('columnas A-F', f.slice(0, 2).join('|') === 'Julio|4115' && f[4] === '1 Normal');
check('fecha es Date real', f[2] instanceof Date && f[2].getMonth() === 7);
check('cria 1/1', f[COL.cria] === '1/1', f[COL.cria]);
check('uuid en la fila', f[COL.uuid] === 'u-simple-0001');
check('log en ok', log()[0][4] === 'ok' && log()[0][3] === 1, JSON.stringify(log()[0].slice(3)));

console.log('\n2. Mismo uuid otra vez (la prueba que mas importa)');
r = post(partoBase());
check('marca duplicado', r.ok === true && r.duplicado === true, JSON.stringify(r));
check('NO agrega fila', formato().length === 1, 'filas=' + formato().length);

console.log('\n3. Parto doble -> 2 filas');
r = post(partoBase({
  uuid: 'u-doble-0002', id_vaca: '5514', sexo: '2 Hembras Gemelas Vivas',
  terneros: [{ id_ternero: '9101', raza: 'Holando', peso: 32, vive: true, calostro: calostroOk },
             { id_ternero: '9102', raza: 'Holando', peso: 30, vive: true,
               calostro: Object.assign({}, calostroOk, { lts_ternero: '3', id_vaca_origen: '226' }) }]
}));
check('responde ok', r.ok === true, JSON.stringify(r));
check('escribe 2 filas', r.filas_escritas === 2 && formato().length === 3);
const [d1, d2] = formato().slice(1);
check('mismo ID Parto', d1[COL.idParto] === d2[COL.idParto], d1[COL.idParto] + ' vs ' + d2[COL.idParto]);
check('cria 1/2 y 2/2', d1[COL.cria] === '1/2' && d2[COL.cria] === '2/2', d1[COL.cria] + ' ' + d2[COL.cria]);
check('terneros distintos', d1[6] === '9101' && d2[6] === '9102');

console.log('\n4. Cria muerta -> --- de G a P');
r = post(partoBase({ uuid: 'u-muerto-0003', id_vaca: '6865', sexo: '7 Macho Muerto', terneros: [] }));
check('responde ok', r.ok === true, JSON.stringify(r));
const m = formato()[3];
check('G a P en ---', m.slice(6, 16).every((v) => v === '---'), JSON.stringify(m.slice(6, 16)));
check('conserva vaca y tambo', m[1] === '6865' && m[16] === '2');

console.log('\n5. Rechazos');
check('token invalido', post(partoBase({ uuid: 'x1', token: 'mal' })).error === 'token invalido');
check('sin uuid', post(partoBase({ uuid: '' })).error === 'falta uuid');
r = post(partoBase({ uuid: 'u-oper-0004', operario: 'Adrian' }));
check('operario fuera de lista', r.ok === false && /operario fuera de lista/.test(r.detalles.join()),
      JSON.stringify(r));
r = post(partoBase({ uuid: 'u-viva-0005', sexo: '1 Hembra Viva', terneros: [] }));
check('cria viva sin ternero', r.ok === false && /sin datos de ternero/.test(r.detalles.join()));
r = post(partoBase({ uuid: 'u-mej-0006', terneros: [{ id_ternero: '1', raza: 'Holando', peso: 40, vive: true,
  calostro: Object.assign({}, calostroOk, { mejorado: 'Si', calidad_mejorado: '---' }) }] }));
check('mejorado=Si sin calidad', r.ok === false, JSON.stringify(r));
r = post(partoBase({ uuid: 'u-simple2-0007', terneros: [
  { id_ternero: '1', raza: 'Holando', peso: 40, vive: true, calostro: calostroOk },
  { id_ternero: '2', raza: 'Holando', peso: 40, vive: true, calostro: calostroOk }] }));
check('sexo simple con 2 crias', r.ok === false && /no es de parto doble/.test(r.detalles.join()));
check('rechazos no escriben filas', formato().length === 4, 'filas=' + formato().length);
check('rechazos quedan en _log', log().filter((l) => /rechazado/.test(l[4])).length === 4,
      JSON.stringify(log().map((l) => l[4])));

console.log('\n6. Rodeo: ya no se carga desde la tablet');
r = post(partoBase({ uuid: 'u-rodeo-0008', rodeo: '207' }));
check('el alta entra igual', r.ok === true, JSON.stringify(r));
// Aunque una tablet vieja siga mandando rodeo, la columna R queda vacia:
// la asigna Nahuel en la planilla y la app no tiene que pisarsela.
check('columna R vacia', formato().slice(-1)[0][17] === '', JSON.stringify(formato().slice(-1)[0][17]));

console.log('\n7. doGet');
r = get({ action: 'ping' });
check('ping', r.ok === true);
r = get({ action: 'maestro', token: TOKEN });
check('maestro con token', r.ok === true && r.listas.operario.length === 4);
check('Si/No se expande', JSON.stringify(r.listas.mejorado) === '["Si","No"]',
      JSON.stringify(r.listas.mejorado));
check('rodeo vacio', r.listas.rodeo.length === 0);
check('maestro sin token rechaza', get({ action: 'maestro' }).ok === false);
r = get({ action: 'partos', token: TOKEN, fecha: '2026-08-12' });
check('partos del dia', r.ok === true && r.partos.length === 5, 'n=' + (r.partos || []).length);
check('partos de otro dia', get({ action: 'partos', token: TOKEN, fecha: '2026-01-01' }).partos.length === 0);

console.log('\n8. Fechas');
libro = nuevoLibro();
r = post(partoBase({ uuid: 'u-fecha-0009', fecha_parto: '12/08/2026' }));
check('acepta DD/MM/YYYY', r.ok === true && formato()[0][2].getDate() === 12, JSON.stringify(r));
r = post(partoBase({ uuid: 'u-fecha-0010', fecha_parto: '2026-13-45' }));
check('rechaza fecha invalida', r.ok === false, JSON.stringify(r));

console.log('\n8b. Mellizos: sexo, estado y calostro por cria');
libro = nuevoLibro();
const gemelos = (extra, t1, t2) => post(partoBase(Object.assign({
  uuid: 'u-gem-' + Math.floor(Math.random() * 1e9), id_vaca: '5514',
  sexo: '8 Otros Gemelos (M+M o M+H)',
  terneros: [
    Object.assign({ id_ternero: '9101', raza: 'Holando', peso: 32, vive: true,
                    sexo: 'Macho', calostro: calostroOk }, t1 || {}),
    Object.assign({ id_ternero: '9102', raza: 'Holando', peso: 30, vive: true,
                    sexo: 'Hembra',
                    calostro: Object.assign({}, calostroOk,
                      { calidad_sin_mejorar: '30', lts_ternero: '3', id_vaca_origen: '226' }) }, t2 || {})
  ]
}, extra || {})));

let g = gemelos();
check('acepta el parto doble', g.ok === true && g.filas_escritas === 2, JSON.stringify(g));
let [m1, m2] = formato().slice(-2);
check('sexo por cria', m1[COL.sexoCria] === 'Macho' && m2[COL.sexoCria] === 'Hembra',
      m1[COL.sexoCria] + ' / ' + m2[COL.sexoCria]);
check('las dos vivas', m1[COL.estado] === 'Vivo' && m2[COL.estado] === 'Vivo');
check('calostro distinto por cria', m1[9] === '26' && m2[9] === '30', m1[9] + ' / ' + m2[9]);
check('litros para el ternero distintos', m1[14] === 4 && m2[14] === 3, m1[14] + ' / ' + m2[14]);
check('vaca origen distinta', m1[15] === '119' && m2[15] === '226');
check('litros de la MADRE iguales en las dos filas', m1[13] === m2[13] && m1[13] === 5,
      m1[13] + ' / ' + m2[13]);
check('mismo ID Parto', m1[COL.idParto] === m2[COL.idParto]);

console.log('\n8c. Mellizos con una cria muerta');
g = gemelos({}, {}, { vive: false });
check('acepta', g.ok === true && g.filas_escritas === 2, JSON.stringify(g));
[m1, m2] = formato().slice(-2);
check('la viva conserva sus datos', m1[6] === '9101' && m1[COL.estado] === 'Vivo');
check('la muerta va en --- de G a P', m2.slice(6, 16).every((v) => v === '---'),
      JSON.stringify(m2.slice(6, 16)));
check('pero queda registrado su sexo', m2[COL.sexoCria] === 'Hembra', m2[COL.sexoCria]);
check('y que nacio muerta', m2[COL.estado] === 'Muerto', m2[COL.estado]);

console.log('\n8d. Reglas del codigo 8');
g = gemelos({}, { sexo: '' });
check('exige el sexo cuando el codigo es ambiguo',
      g.ok === false && /falta el sexo/.test((g.detalles || []).join()), JSON.stringify(g));
g = gemelos({}, { sexo: 'Macho o Hembra' });
check('rechaza un sexo invalido',
      g.ok === false && /sexo invalido/.test((g.detalles || []).join()), JSON.stringify(g));
g = gemelos({}, { vive: false }, { vive: false });
check('rechaza las dos muertas con codigo de vivas',
      g.ok === false && /todas las crias/.test((g.detalles || []).join()), JSON.stringify(g));

console.log('\n8d-bis. El codigo del parto y el sexo tienen que coincidir');
g = gemelos({}, { sexo: 'Hembra' }, { sexo: 'Hembra' });
check('rechaza dos hembras con el codigo 8',
      g.ok === false && /codigo "2 Hembras Gemelas Vivas"/.test((g.detalles || []).join()),
      JSON.stringify(g));
g = gemelos({ sexo: '2 Hembras Gemelas Vivas' }, { sexo: 'Macho' }, { sexo: 'Hembra' });
check('rechaza un macho con el codigo 2',
      g.ok === false && /no admite machos/.test((g.detalles || []).join()), JSON.stringify(g));
g = gemelos({ sexo: '2 Hembras Gemelas Vivas' }, { sexo: 'Hembra' }, { sexo: 'Hembra' });
check('acepta dos hembras con el codigo 2', g.ok === true, JSON.stringify(g));
g = gemelos({}, { sexo: 'Macho' }, { sexo: 'Hembra' });
check('acepta M+H con el codigo 8', g.ok === true, JSON.stringify(g));
g = gemelos({}, { sexo: 'Macho' }, { sexo: 'Macho' });
check('acepta M+M con el codigo 8', g.ok === true, JSON.stringify(g));

console.log('\n8e. Parto simple: el sexo sale del codigo, sin preguntarlo');
libro = nuevoLibro();
post(partoBase({ uuid: 'u-simple-sexo' }));                  // codigo 6 Macho Vivo
check('deduce Macho del codigo 6', formato()[0][COL.sexoCria] === 'Macho', formato()[0][COL.sexoCria]);
post(partoBase({ uuid: 'u-hembra', sexo: '1 Hembra Viva' }));
check('deduce Hembra del codigo 1', formato()[1][COL.sexoCria] === 'Hembra', formato()[1][COL.sexoCria]);
post(partoBase({ uuid: 'u-muerta-sexo', sexo: '4 Hembra Muerta', terneros: [] }));
check('cria muerta: Hembra y Muerto', formato()[2][COL.sexoCria] === 'Hembra' &&
      formato()[2][COL.estado] === 'Muerto', JSON.stringify(formato()[2].slice(19, 21)));

console.log('\n8f. Formato viejo (calostro a nivel parto) sigue entrando');
libro = nuevoLibro();
const viejo = post({
  token: TOKEN, uuid: 'u-viejo-1', operario: 'Julio', id_vaca: '4115',
  fecha_parto: '2026-08-12', hora_nacimiento: '07:00', tipo_parto: '1 Normal',
  sexo: '6 Macho Vivo', terneros: [{ id_ternero: '24543', raza: 'Holando', peso: 42 }],
  calostro: { calidad_sin_mejorar: '26', mejorado: 'No', calidad_mejorado: '---',
              consumido: 'Si', lts_madre: '5', lts_ternero: '4', id_vaca_origen: '119' },
  tambo: '2', rodeo: '26', notas: ''
});
check('acepta el payload sin calostro por cria', viejo.ok === true, JSON.stringify(viejo));
check('toma los litros de la madre de adentro de calostro', formato()[0][13] === 5, formato()[0][13]);

console.log('\n9. Identidad: solo cuentas del dominio');
libro = nuevoLibro();
const conSesion = (idt, extra) => post(Object.assign(partoBase({ uuid: 'u-' + idt }), extra || {},
  { token: undefined, id_token: idt }));

registrarToken('bueno', {});
registrarToken('otro-dominio', { hd: 'gmail.com', email: 'ajeno@gmail.com' });
registrarToken('sin-hd', { hd: undefined, email: 'suelto@gmail.com' });
registrarToken('otra-app', { aud: '999-otra.apps.googleusercontent.com' });
registrarToken('vencido', { exp: String(Math.floor(Date.now() / 1000) - 60) });
registrarToken('sin-verificar', { email_verified: 'false' });
registrarToken('admin', { email: 'andresduhau@admin.com.ar' });

check('acepta cuenta del dominio', conSesion('bueno').ok === true, JSON.stringify(conSesion('bueno')));
check('rechaza otro dominio', /no es de admin.com.ar/.test(conSesion('otro-dominio').error || ''),
      JSON.stringify(conSesion('otro-dominio')));
check('rechaza cuenta sin dominio (Gmail personal)',
      /no es de admin.com.ar/.test(conSesion('sin-hd').error || ''), JSON.stringify(conSesion('sin-hd')));
check('rechaza token de otra aplicacion',
      /otra aplicacion/.test(conSesion('otra-app').error || ''), JSON.stringify(conSesion('otra-app')));
check('rechaza sesion vencida', /vencida/.test(conSesion('vencido').error || ''),
      JSON.stringify(conSesion('vencido')));
check('rechaza mail sin verificar', /sin verificar/.test(conSesion('sin-verificar').error || ''),
      JSON.stringify(conSesion('sin-verificar')));
check('rechaza token que Google no conoce', conSesion('inventado').ok === false);
check('sin token ni sesion no entra',
      /falta sesion/.test(post({ uuid: 'x', operario: 'Julio' }).error || ''));
check('los rechazos no escribieron filas', formato().length === 1,
      'filas=' + formato().length + ' (solo la de "bueno")');

console.log('\n10. Admin y acciones por POST');
let s = post({ accion: 'sesion', id_token: 'admin' });
check('sesion de admin marca admin', s.ok === true && s.admin === true, JSON.stringify(s));
s = post({ accion: 'sesion', id_token: 'bueno' });
check('cuenta de dispositivo NO es admin', s.ok === true && s.admin === false, JSON.stringify(s));
check('el mail vuelve normalizado', s.email === 'tablet.maternidad@admin.com.ar', s.email);
s = post({ accion: 'maestro', id_token: 'bueno' });
check('maestro por POST con sesion', s.ok === true && s.listas.operario.length === 4, JSON.stringify(s).slice(0, 90));
check('maestro por POST sin sesion rechaza', post({ accion: 'maestro' }).ok === false);
s = post({ accion: 'partos', id_token: 'bueno', fecha: '2026-08-12' });
check('partos por POST con sesion', s.ok === true && Array.isArray(s.partos), JSON.stringify(s).slice(0, 80));

console.log('\n11. Convivencia con el camino de scripts');
check('el token compartido sigue entrando', post(partoBase({ uuid: 'u-script-99' })).ok === true);
check('maestro por GET con token compartido', get({ action: 'maestro', token: TOKEN }).ok === true);
check('maestro por GET con token malo', get({ action: 'maestro', token: 'no' }).ok === false);
check('_log guarda quien cargo cada parto',
      log().some((l) => l[5] === 'tablet.maternidad@admin.com.ar') && log().some((l) => l[5] === 'script'),
      JSON.stringify(log().map((l) => l[5])));

console.log('\n12. Cache de verificacion');
Object.keys(cacheFalso).forEach((k) => delete cacheFalso[k]);   // arrancar en frio
llamadasAGoogle = 0;
post(partoBase({ uuid: 'u-cache-1', token: undefined, id_token: 'bueno' }));
post(partoBase({ uuid: 'u-cache-2', token: undefined, id_token: 'bueno' }));
post(partoBase({ uuid: 'u-cache-3', token: undefined, id_token: 'bueno' }));
check('3 partos con el mismo token = 1 sola consulta a Google', llamadasAGoogle === 1,
      'llamadas=' + llamadasAGoogle);

console.log('\n13. Alta sin peso: el ternero se pesa despues');
libro = nuevoLibro();
const sinPeso = { id_ternero: '777', raza: 'Holando', vive: true, calostro: calostroOk };
r = post(partoBase({ uuid: 'u-sinpeso-01', terneros: [sinPeso] }));
check('el alta entra sin peso', r.ok === true, JSON.stringify(r));
check('columna I vacia', formato()[0][8] === '', JSON.stringify(formato()[0][8]));
// Vacio y '---' son estados distintos: vacio es "falta pesar", '---' es cria muerta.
check('vacio no es ---', formato()[0][8] !== '---');
r = post(partoBase({ uuid: 'u-sinpeso-02', terneros: [Object.assign({}, sinPeso, { peso: 999 })] }));
check('un peso fuera de lista sigue rechazandose', r.ok === false, JSON.stringify(r));

console.log('\n14. Editar: el peso, por el que cargo el parto');
libro = nuevoLibro();
post(partoBase({ uuid: 'u-ed-01', operario: 'Julio', terneros: [sinPeso] }));
const editar = (extra) => post(Object.assign({ token: TOKEN, accion: 'editar', uuid: 'u-ed-01',
                                               operario: 'Julio' }, extra));

r = editar({ terneros: [{ peso: 44 }] });
check('Julio pesa su parto', r.ok === true && r.cambios === 1, JSON.stringify(r));
check('la columna I quedo en 44', formato()[0][8] === 44, JSON.stringify(formato()[0][8]));
r = editar({ operario: 'Griselda', terneros: [{ peso: 46 }] });
check('Griselda no pesa un parto de Julio', r.ok === false, JSON.stringify(r));
check('el peso quedo intacto', formato()[0][8] === 44, JSON.stringify(formato()[0][8]));
// El resto de los campos si los corrige cualquiera.
r = editar({ operario: 'Griselda', tambo: '3', terneros: [{ calostro: { lts_ternero: '5' } }] });
check('Griselda corrige calostro y tambo', r.ok === true, JSON.stringify(r));
check('tambo Q actualizado', formato()[0][16] === '3', JSON.stringify(formato()[0][16]));
check('lts ternero O actualizado', formato()[0][14] === 5, JSON.stringify(formato()[0][14]));

console.log('\n15. Editar: lo que no se puede');
r = editar({ terneros: [{ peso: 999 }] });
check('peso fuera de lista', r.ok === false, JSON.stringify(r));
r = editar({ terneros: [{ peso: '' }] });
check('vaciar un campo no es corregir', r.ok === false, JSON.stringify(r));
r = editar({ terneros: [{ calostro: { mejorado: 'Si' } }] });
check('mejorado=Si sin calidad_mejorado', r.ok === false, JSON.stringify(r));
r = editar({ terneros: [{ calostro: { mejorado: 'Si', calidad_mejorado: '30' } }] });
check('mejorado=Si con calidad si entra', r.ok === true, JSON.stringify(r));
r = post({ token: TOKEN, accion: 'editar', uuid: 'no-existe', operario: 'Julio',
           terneros: [{ peso: 40 }] });
check('uuid inexistente', r.ok === false && /no existe/.test(r.error), JSON.stringify(r));
r = editar({ terneros: [{ peso: 40 }, { peso: 41 }] });
check('mas crias que filas', r.ok === false && /cria/.test(r.error), JSON.stringify(r));
r = editar({ terneros: [{ peso: 44 }] });
check('reenviar el mismo valor no cambia nada', r.ok === true && r.cambios === 0, JSON.stringify(r));
// La tablet manda el parto entero al corregir cualquier cosa. Reenviar el mismo
// peso no es pesar, asi que no puede bloquear a los demas.
r = editar({ operario: 'Griselda', terneros: [{ peso: 44, calostro: { consumido: 'No' } }] });
check('reenviar el peso igual no bloquea a otro operario', r.ok === true, JSON.stringify(r));
check('y el calostro se corrigio', formato()[0][12] === 'No', JSON.stringify(formato()[0][12]));
// Vaciar un dato que existe se rechaza (arriba), pero un opcional que nunca se
// cargo vuelve vacio sin ser un borrado: la tablet manda el parto entero.
post(partoBase({ uuid: 'u-ed-vacio', terneros: [{ id_ternero: '5', raza: 'Holando', peso: 40,
  vive: true, calostro: Object.assign({}, calostroOk, { id_vaca_origen: '' }) }] }));
r = post({ token: TOKEN, accion: 'editar', uuid: 'u-ed-vacio', operario: 'Julio',
           terneros: [{ calostro: { id_vaca_origen: '', consumido: 'No' } }] });
check('reenviar vacio algo que ya estaba vacio', r.ok === true && r.cambios === 1, JSON.stringify(r));

console.log('\n16. Editar: cria muerta y ventana del dia');
libro = nuevoLibro();
post(partoBase({ uuid: 'u-ed-muerto', sexo: '7 Macho Muerto', terneros: [] }));
r = post({ token: TOKEN, accion: 'editar', uuid: 'u-ed-muerto', operario: 'Julio',
           terneros: [{ peso: 40 }] });
check('cria muerta no lleva peso', r.ok === false && /muerta/.test(JSON.stringify(r)), JSON.stringify(r));
// N esta adentro del bloque G-P que va todo en '---': un numero suelto ahi
// romperia la fila. Q, en cambio, esta afuera y se corrige igual.
r = post({ token: TOKEN, accion: 'editar', uuid: 'u-ed-muerto', operario: 'Julio', lts_madre: '9' });
check('cria muerta no lleva lts madre', r.ok === false, JSON.stringify(r));
check('el bloque G-P sigue entero', formato()[0].slice(6, 16).every((v) => v === '---'),
      JSON.stringify(formato()[0].slice(6, 16)));
r = post({ token: TOKEN, accion: 'editar', uuid: 'u-ed-muerto', operario: 'Julio', tambo: '3' });
check('pero el tambo si se corrige', r.ok === true && formato()[0][16] === '3', JSON.stringify(r));

post(partoBase({ uuid: 'u-ed-ayer', terneros: [sinPeso],
                 cargado_en: '2026-08-01T10:00:00.000Z' }));
r = post({ token: TOKEN, accion: 'editar', uuid: 'u-ed-ayer', operario: 'Julio',
           terneros: [{ peso: 40 }] });
check('un parto cargado otro dia ya no se corrige', r.ok === false && /hoy/.test(r.error),
      JSON.stringify(r));
// La ventana mira "Cargado en" (Y), no "Fecha Parto" (C): un parto de ayer
// cargado esta manana todavia se corrige.
libro = nuevoLibro();
const ayer = new Date(); ayer.setDate(ayer.getDate() - 1);
post(partoBase({ uuid: 'u-ed-fecha-ayer', terneros: [sinPeso],
                 fecha_parto: `${ayer.getFullYear()}-${dosDigitos(ayer.getMonth() + 1)}-${dosDigitos(ayer.getDate())}` }));
r = post({ token: TOKEN, accion: 'editar', uuid: 'u-ed-fecha-ayer', operario: 'Julio',
           terneros: [{ peso: 40 }] });
check('parto con fecha de ayer, cargado hoy, si se corrige', r.ok === true, JSON.stringify(r));

console.log('\n17. Editar mellizos: por cria y del parto');
libro = nuevoLibro();
post(partoBase({
  uuid: 'u-ed-gem', sexo: '2 Hembras Gemelas Vivas', lts_madre: '5',
  terneros: [{ id_ternero: 'A', raza: 'Holando', vive: true, sexo: 'Hembra', calostro: calostroOk },
             { id_ternero: 'B', raza: 'Holando', vive: true, sexo: 'Hembra', calostro: calostroOk }]
}));
check('escribio 2 filas', formato().length === 2, 'filas=' + formato().length);
r = post({ token: TOKEN, accion: 'editar', uuid: 'u-ed-gem', operario: 'Julio',
           lts_madre: '7', terneros: [{ peso: 30 }, { peso: 35 }] });
check('edita las dos crias', r.ok === true, JSON.stringify(r));
check('cada cria con su peso', formato()[0][8] === 30 && formato()[1][8] === 35,
      JSON.stringify([formato()[0][8], formato()[1][8]]));
// Los litros que produjo la madre son del parto: van iguales en las dos filas.
check('lts madre iguales en las dos filas', formato()[0][13] === 7 && formato()[1][13] === 7,
      JSON.stringify([formato()[0][13], formato()[1][13]]));
check('sigue habiendo 2 filas', formato().length === 2, 'filas=' + formato().length);

console.log('\n18. Editar: la auditoria queda entera');
const logGem = log().filter((l) => l[0] === 'u-ed-gem');
check('el alta y la edicion son renglones distintos', logGem.length === 2,
      JSON.stringify(logGem.map((l) => l[4])));
check('el renglon del alta no se piso', /^(recibido|ok)$/.test(logGem[0][4]), logGem[0][4]);
check('la edicion dice quien la hizo', /editado por Julio/.test(logGem[1][4]), logGem[1][4]);
check('la edicion guarda el mail', logGem[1][5] === 'script', logGem[1][5]);

console.log('\n' + (fallos ? `${fallos} PRUEBAS FALLARON` : 'todas las pruebas pasaron'));
process.exit(fallos ? 1 : 0);
