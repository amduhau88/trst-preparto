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
    getName() { return this.nombre; },
    setName(n) { this.nombre = n; return this; },
    setFrozenRows() { return this; },
    clear() { this.filas.length = 0; return this; },
    insertRowAfter(n) {
      // Igual que Sheets: lo que estaba abajo baja un lugar, con sus valores.
      this.filas.splice(n, 0, []);
      return this;
    },
    copyTo(libro) {
      const copia = crearHoja(this.nombre + ' (copia)', this.filas.map((f) => f.slice()));
      libro._hojas[copia.nombre] = copia;
      const setName = copia.setName.bind(copia);
      copia.setName = (n) => {
        delete libro._hojas[copia.nombre];
        setName(n);
        libro._hojas[n] = copia;
        return copia;
      };
      return copia;
    },
    getLastRow() { return this.filas.length; },
    getMaxRows() { return Math.max(this.filas.length, 1000); },
    appendRow(fila) { this.filas.push(fila.slice()); },
    getDataRange() { return this.rango(1, 1, this.filas.length, anchoMax(this.filas)); },
    // getRange(fila, col) sin tamaño es UNA celda, igual que en Sheets.
    getRange(f, c, nf, nc) {
      return this.rango(f, c, nf === undefined ? 1 : nf, nc === undefined ? 1 : nc);
    },
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
          return this;
        },
        setNumberFormat() { return this; },
        setFontWeight() { return this; },
        setValue(v) { this.setValues([[v]]); return this; },
        getValue() { return this.getValues()[0][0]; },
        getRow: () => f,
        getColumn: () => c,
        getNumRows: () => nf,
        getNumColumns: () => nc,
        getSheet: () => hoja,
        clearContent() {
          for (let i = 0; i < nf; i++) {
            const fila = hoja.filas[f - 1 + i];
            if (!fila) continue;
            for (let j = 0; j < nc; j++) fila[c - 1 + j] = '';
          }
          return this;
        },
        createTextFinder(txt) {
          return {
            matchEntireCell() { return this; },
            findNext() { return this.findAll()[0] || null; },
            findAll() {
              const out = [];
              for (let i = 0; i < nf; i++) {
                const fila = hoja.filas[f - 1 + i] || [];
                for (let j = 0; j < nc; j++) {
                  if (String(fila[c - 1 + j]) === String(txt)) {
                    const fn = f + i;
                    out.push({ getRow: () => fn });
                    break;
                  }
                }
              }
              return out;
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
    // 0 = no se midio / no hubo calostro. La lista salta de 0 a 18 a proposito.
    9: ['0'].concat(rango(18, 35)).concat(['mastitis', 'sangre', 'campo']),
    10: ['Si/No'],
    11: ['---'].concat(rango(26, 35)),
    12: ['Si/No'],
    13: rango(0, 20),
    14: rango(2, 6),
    16: ['1', '2', '3', '4'],
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

/* El encabezado y las posiciones salen del propio Codigo.gs, no de una copia
   escrita a mano: una copia se desincroniza en silencio, y era justo lo que
   hacia que reordenar columnas fuera peligroso. Se completan despues de cargar
   el backend en el sandbox (mas abajo). */
let HEAD_FORMATO = null;
let COL = null;

function nuevoLibro(nombreHoja) {
  const hojas = {
    'Maestro': crearHoja('Maestro', maestroReal()),
    '_log': crearHoja('_log', [['uuid', 'recibido_en', 'payload_json', 'filas_escritas', 'resultado']])
  };
  const nom = nombreHoja || 'Registros';
  hojas[nom] = crearHoja(nom, [HEAD_FORMATO.slice()]);
  hojas[sandbox.HOJA_DC || 'Datos Carga DC'] =
    crearHoja('Datos Carga DC', [(sandbox.DC_ENCABEZADOS || []).slice()]);
  const libro = {
    getName: () => 'TRST — Partos',
    getSpreadsheetTimeZone: () => TZ,
    getSheetByName: (n) => hojas[n],
    _hojas: hojas,
    _hoja: nom
  };
  // Renombrar una pestaña la mueve de lugar en el libro, como en Sheets.
  Object.keys(hojas).forEach((k) => {
    const h = hojas[k];
    h.getParent = () => libro;
    const original = h.setName.bind(h);
    h.setName = (n) => {
      delete hojas[h.getName()];
      original(n);
      hojas[n] = h;
      if (libro._hoja === k) libro._hoja = n;
      return h;
    };
  });
  return libro;
}

let libro = null;

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
      put: (k, v) => { cacheFalso[k] = v; },
      remove: (k) => { delete cacheFalso[k]; }
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

HEAD_FORMATO = sandbox.ENCABEZADOS.slice();
COL = sandbox.COL;
libro = nuevoLibro();

/* ---------- helpers de prueba ---------- */

const post = (payload) => JSON.parse(
  sandbox.doPost({ postData: { contents: JSON.stringify(payload) } })._texto);
const get = (parameter) => JSON.parse(sandbox.doGet({ parameter })._texto);
const formato = () => libro._hojas[libro._hoja].filas.slice(1);
const log = () => libro._hojas['_log'].filas.slice(1);

/* Lo que produjo la MADRE es del parto: se carga una vez y se repite igual en
   las dos filas de un mellizo. Lo que tomo cada ternero es de la CRIA, y puede
   venir de su propia madre o de otra vaca. */
const calostroMadre = { calidad_sin_mejorar: '26', mejorado: 'No', calidad_mejorado: '---' };
const calostroOk = { origen: 'Propia madre', lts_ternero: '4' };

const partoBase = (extra) => Object.assign({
  token: TOKEN, uuid: 'u-simple-0001', dispositivo: 'tablet-maternidad',
  operario: 'Julio', id_vaca: '4115', fecha_parto: '2026-08-12',
  hora_nacimiento: '07:00', tipo_parto: '1 Normal', sexo: '6 Macho Vivo',
  lts_madre: '5', calostro: calostroMadre,
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
check('columnas A-F', f.slice(0, 2).join('|') === 'Julio|4115' && f[COL.tipo_parto] === '1 Normal');
check('fecha es Date real', f[COL.fecha] instanceof Date && f[COL.fecha].getMonth() === 7);
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
               calostro: { origen: 'Otra vaca', id_vaca_origen: '226',
                           calidad_ternero: '30', lts_ternero: '3' } }]
}));
check('responde ok', r.ok === true, JSON.stringify(r));
check('escribe 2 filas', r.filas_escritas === 2 && formato().length === 3);
const [d1, d2] = formato().slice(1);
check('mismo ID Parto', d1[COL.id_parto] === d2[COL.id_parto], d1[COL.id_parto] + ' vs ' + d2[COL.id_parto]);
check('cria 1/2 y 2/2', d1[COL.cria] === '1/2' && d2[COL.cria] === '2/2', d1[COL.cria] + ' ' + d2[COL.cria]);
check('terneros distintos', d1[COL.id_ternero] === '9101' && d2[COL.id_ternero] === '9102');

console.log('\n4. Cria muerta -> --- de G a Q');
r = post(partoBase({ uuid: 'u-muerto-0003', id_vaca: '6865', sexo: '7 Macho Muerto', terneros: [] }));
check('responde ok', r.ok === true, JSON.stringify(r));
const m = formato()[3];
const bloque = m.slice(COL.id_ternero, COL.lts_ternero + 1);
check('G a Q en ---', bloque.every((v) => v === '---'), JSON.stringify(bloque));
check('conserva vaca y tambo', m[COL.id_vaca] === '6865' && m[COL.tambo] === '2');

console.log('\n5. Rechazos');
check('token invalido', post(partoBase({ uuid: 'x1', token: 'mal' })).error === 'token invalido');
check('sin uuid', post(partoBase({ uuid: '' })).error === 'falta uuid');
r = post(partoBase({ uuid: 'u-oper-0004', operario: 'Adrian' }));
check('operario fuera de lista', r.ok === false && /operario fuera de lista/.test(r.detalles.join()),
      JSON.stringify(r));
r = post(partoBase({ uuid: 'u-viva-0005', sexo: '1 Hembra Viva', terneros: [] }));
check('cria viva sin ternero', r.ok === false && /sin datos de ternero/.test(r.detalles.join()));
r = post(partoBase({ uuid: 'u-mej-0006',
  calostro: { calidad_sin_mejorar: '26', mejorado: 'Si', calidad_mejorado: '---' } }));
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
check('columna del rodeo vacia', formato().slice(-1)[0][COL.rodeo] === '',
      JSON.stringify(formato().slice(-1)[0][COL.rodeo]));

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
check('acepta DD/MM/YYYY', r.ok === true && formato()[0][COL.fecha].getDate() === 12,
      JSON.stringify(r));
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
                    calostro: { origen: 'Otra vaca', id_vaca_origen: '226',
                                calidad_ternero: '30', lts_ternero: '3' } }, t2 || {})
  ]
}, extra || {})));

let g = gemelos();
check('acepta el parto doble', g.ok === true && g.filas_escritas === 2, JSON.stringify(g));
let [m1, m2] = formato().slice(-2);
check('sexo por cria', m1[COL.sexo_cria] === 'Macho' && m2[COL.sexo_cria] === 'Hembra',
      m1[COL.sexo_cria] + ' / ' + m2[COL.sexo_cria]);
check('las dos vivas', m1[COL.estado_cria] === 'Vivo' && m2[COL.estado_cria] === 'Vivo');
/* El calostro DE LA MADRE describe lo que produjo la vaca: es del parto y va
   igual en las dos filas. Antes se cargaba por cria y un mellizo podia quedar
   con dos calidades distintas para la misma madre. Lo que SI es de cada cria es
   lo que efectivamente tomo. */
check('la calidad de la madre es la misma en las dos filas',
      m1[COL.calidad_sin_mejorar] === m2[COL.calidad_sin_mejorar] &&
      m1[COL.calidad_sin_mejorar] === '26',
      m1[COL.calidad_sin_mejorar] + ' / ' + m2[COL.calidad_sin_mejorar]);
check('mejorado y calidad mejorada tambien',
      m1[COL.mejorado] === m2[COL.mejorado] && m1[COL.calidad_mejorado] === m2[COL.calidad_mejorado]);
check('litros de la MADRE iguales en las dos filas',
      m1[COL.lts_madre] === m2[COL.lts_madre] && m1[COL.lts_madre] === 5,
      m1[COL.lts_madre] + ' / ' + m2[COL.lts_madre]);
check('pero lo que tomo cada ternero puede ser distinto',
      m1[COL.calidad_ternero] === '26' && m2[COL.calidad_ternero] === '30',
      m1[COL.calidad_ternero] + ' / ' + m2[COL.calidad_ternero]);
check('litros para el ternero distintos',
      m1[COL.lts_ternero] === 4 && m2[COL.lts_ternero] === 3,
      m1[COL.lts_ternero] + ' / ' + m2[COL.lts_ternero]);
check('origen del calostro por cria',
      m1[COL.origen_calostro] === 'Propia madre' && m2[COL.origen_calostro] === 'Otra vaca',
      m1[COL.origen_calostro] + ' / ' + m2[COL.origen_calostro]);
check('con propia madre el ID de origen es la vaca que pario',
      m1[COL.id_vaca_origen] === '5514', m1[COL.id_vaca_origen]);
check('y con otra vaca, el que se cargo', m2[COL.id_vaca_origen] === '226',
      m2[COL.id_vaca_origen]);
check('mismo ID Parto', m1[COL.id_parto] === m2[COL.id_parto]);

console.log('\n8c. Mellizos con una cria muerta');
g = gemelos({}, {}, { vive: false });
check('acepta', g.ok === true && g.filas_escritas === 2, JSON.stringify(g));
[m1, m2] = formato().slice(-2);
check('la viva conserva sus datos',
      m1[COL.id_ternero] === '9101' && m1[COL.estado_cria] === 'Vivo');
check('la muerta va en --- de G a Q',
      m2.slice(COL.id_ternero, COL.lts_ternero + 1).every((v) => v === '---'),
      JSON.stringify(m2.slice(COL.id_ternero, COL.lts_ternero + 1)));
check('pero queda registrado su sexo', m2[COL.sexo_cria] === 'Hembra', m2[COL.sexo_cria]);
check('y que nacio muerta', m2[COL.estado_cria] === 'Muerto', m2[COL.estado_cria]);

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
check('deduce Macho del codigo 6', formato()[0][COL.sexo_cria] === 'Macho', formato()[0][COL.sexo_cria]);
post(partoBase({ uuid: 'u-hembra', sexo: '1 Hembra Viva' }));
check('deduce Hembra del codigo 1', formato()[1][COL.sexo_cria] === 'Hembra', formato()[1][COL.sexo_cria]);
post(partoBase({ uuid: 'u-muerta-sexo', sexo: '4 Hembra Muerta', terneros: [] }));
check('cria muerta: Hembra y Muerto', formato()[2][COL.sexo_cria] === 'Hembra' &&
      formato()[2][COL.estado_cria] === 'Muerto',
      JSON.stringify(formato()[2].slice(COL.sexo_cria, COL.estado_cria + 1)));

console.log('\n8f. Formatos viejos siguen entrando');
/* Cuando se publica el service worker nuevo hay tablets con partos ya guardados
   en IndexedDB con el formato anterior. Si el backend los rechazara, esos partos
   quedarian trabados justo el dia del deploy. */
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
check('toma los litros de la madre de adentro de calostro',
      formato()[0][COL.lts_madre] === 5, formato()[0][COL.lts_madre]);
check('ignora "consumido", que ya no existe',
      formato()[0].indexOf('Si') === -1, JSON.stringify(formato()[0]));

// r5: el calostro venia POR CRIA, sin nada a nivel parto.
const r5 = post({
  token: TOKEN, uuid: 'u-viejo-2', operario: 'Julio', id_vaca: '4115',
  fecha_parto: '2026-08-12', hora_nacimiento: '07:00', tipo_parto: '1 Normal',
  sexo: '6 Macho Vivo', lts_madre: '7',
  terneros: [{ id_ternero: '24544', raza: 'Holando', peso: 42, vive: true,
               calostro: { calidad_sin_mejorar: '31', mejorado: 'No', calidad_mejorado: '---',
                           consumido: 'Si', lts_ternero: '4', id_vaca_origen: '226' } }],
  tambo: '2', notas: ''
});
check('acepta el calostro por cria de r5', r5.ok === true, JSON.stringify(r5));
let fr5 = formato()[1];
check('lo sube a nivel parto', fr5[COL.calidad_sin_mejorar] === '31', fr5[COL.calidad_sin_mejorar]);
check('y deduce que el calostro era de otra vaca',
      fr5[COL.origen_calostro] === 'Otra vaca' && fr5[COL.id_vaca_origen] === '226',
      fr5[COL.origen_calostro] + ' / ' + fr5[COL.id_vaca_origen]);
check('con la calidad que tomo reconstruida', fr5[COL.calidad_ternero] === '31',
      fr5[COL.calidad_ternero]);

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
check('columna I vacia', formato()[0][COL.peso] === '', JSON.stringify(formato()[0][COL.peso]));
// Vacio y '---' son estados distintos: vacio es "falta pesar", '---' es cria muerta.
check('vacio no es ---', formato()[0][COL.peso] !== '---');
r = post(partoBase({ uuid: 'u-sinpeso-02', terneros: [Object.assign({}, sinPeso, { peso: 999 })] }));
check('un peso fuera de lista sigue rechazandose', r.ok === false, JSON.stringify(r));

console.log('\n14. Editar: el peso, por el que cargo el parto');
libro = nuevoLibro();
post(partoBase({ uuid: 'u-ed-01', operario: 'Julio', terneros: [sinPeso] }));
const editar = (extra) => post(Object.assign({ token: TOKEN, accion: 'editar', uuid: 'u-ed-01',
                                               operario: 'Julio' }, extra));

r = editar({ terneros: [{ peso: 44 }] });
check('Julio pesa su parto', r.ok === true && r.cambios === 1, JSON.stringify(r));
check('la columna I quedo en 44', formato()[0][COL.peso] === 44, JSON.stringify(formato()[0][COL.peso]));
r = editar({ operario: 'Griselda', terneros: [{ peso: 46 }] });
check('Griselda no pesa un parto de Julio', r.ok === false, JSON.stringify(r));
check('el peso quedo intacto', formato()[0][COL.peso] === 44, JSON.stringify(formato()[0][COL.peso]));
// El resto de los campos si los corrige cualquiera.
r = editar({ operario: 'Griselda', tambo: '3', terneros: [{ calostro: { lts_ternero: '5' } }] });
check('Griselda corrige calostro y tambo', r.ok === true, JSON.stringify(r));
check('tambo actualizado', formato()[0][COL.tambo] === '3', JSON.stringify(formato()[0][COL.tambo]));
check('lts ternero actualizado', formato()[0][COL.lts_ternero] === 5,
      JSON.stringify(formato()[0][COL.lts_ternero]));

console.log('\n15. Editar: lo que no se puede');
r = editar({ terneros: [{ peso: 999 }] });
check('peso fuera de lista', r.ok === false, JSON.stringify(r));
r = editar({ terneros: [{ peso: '' }] });
check('vaciar un campo no es corregir', r.ok === false, JSON.stringify(r));
// Mejorado y calidad mejorada son del PARTO: viajan en calostro, no por cria.
r = editar({ calostro: { mejorado: 'Si' } });
check('mejorado=Si sin calidad_mejorado', r.ok === false, JSON.stringify(r));
r = editar({ calostro: { mejorado: 'Si', calidad_mejorado: '30' } });
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
r = editar({ operario: 'Griselda', terneros: [{ peso: 44, calostro: { lts_ternero: '6' } }] });
check('reenviar el peso igual no bloquea a otro operario', r.ok === true, JSON.stringify(r));
check('y el calostro se corrigio', formato()[0][COL.lts_ternero] === 6,
      JSON.stringify(formato()[0][COL.lts_ternero]));
// Vaciar un dato que existe se rechaza (arriba), pero un opcional que nunca se
// cargo vuelve vacio sin ser un borrado: la tablet manda el parto entero.
/* Con 'Otra vaca' el ID de origen es obligatorio, pero el campo de notas y
   otros opcionales pueden volver vacios sin que eso sea un borrado: la tablet
   manda el parto entero al corregir cualquier cosa. */
post(partoBase({ uuid: 'u-ed-vacio', id_vaca: '4116',
  terneros: [{ id_ternero: '5', raza: 'Holando', peso: 40, vive: true,
               calostro: { origen: 'Propia madre', lts_ternero: '4' } }] }));
r = post({ token: TOKEN, accion: 'editar', uuid: 'u-ed-vacio', operario: 'Julio',
           id_vaca: '4116',
           terneros: [{ calostro: { origen: 'Propia madre', lts_ternero: '5' } }] });
check('reenviar lo mismo y cambiar un dato', r.ok === true && r.cambios === 1, JSON.stringify(r));

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
check('el bloque G-Q sigue entero',
      formato()[0].slice(COL.id_ternero, COL.lts_ternero + 1).every((v) => v === '---'),
      JSON.stringify(formato()[0].slice(COL.id_ternero, COL.lts_ternero + 1)));
r = post({ token: TOKEN, accion: 'editar', uuid: 'u-ed-muerto', operario: 'Julio', tambo: '3' });
check('pero el tambo si se corrige', r.ok === true && formato()[0][COL.tambo] === '3',
      JSON.stringify(r));
// El calostro de la madre tambien vive adentro del bloque: mismo criterio.
r = post({ token: TOKEN, accion: 'editar', uuid: 'u-ed-muerto', operario: 'Julio',
           calostro: { calidad_sin_mejorar: '30' } });
check('cria muerta tampoco lleva calidad de calostro', r.ok === false, JSON.stringify(r));

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
check('cada cria con su peso', formato()[0][COL.peso] === 30 && formato()[1][COL.peso] === 35,
      JSON.stringify([formato()[0][COL.peso], formato()[1][COL.peso]]));
// Los litros que produjo la madre son del parto: van iguales en las dos filas.
check('lts madre iguales en las dos filas',
      formato()[0][COL.lts_madre] === 7 && formato()[1][COL.lts_madre] === 7,
      JSON.stringify([formato()[0][COL.lts_madre], formato()[1][COL.lts_madre]]));
// Y el resto del calostro de la madre, tambien: es del parto.
r = post({ token: TOKEN, accion: 'editar', uuid: 'u-ed-gem', operario: 'Julio',
           calostro: { calidad_sin_mejorar: '33' } });
check('corregir la calidad de la madre toca las dos filas',
      r.ok === true && formato()[0][COL.calidad_sin_mejorar] === '33' &&
      formato()[1][COL.calidad_sin_mejorar] === '33', JSON.stringify(r));
check('sigue habiendo 2 filas', formato().length === 2, 'filas=' + formato().length);

console.log('\n18. Editar: la auditoria queda entera');
const logGem = log().filter((l) => l[0] === 'u-ed-gem');
check('el alta y cada edicion son renglones distintos', logGem.length === 3,
      JSON.stringify(logGem.map((l) => l[4])));
check('el renglon del alta no se piso', /^(recibido|ok)$/.test(logGem[0][4]), logGem[0][4]);
check('la edicion dice quien la hizo', /editado por Julio/.test(logGem[1][4]), logGem[1][4]);
check('la edicion guarda el mail', logGem[1][5] === 'script', logGem[1][5]);

console.log('\n18b. Tambo 4 y calidad 0');
libro = nuevoLibro();
r = post(partoBase({ uuid: 'u-tambo4', tambo: '4' }));
check('el tambo 4 entra', r.ok === true, JSON.stringify(r));
check('y queda escrito', formato()[0][COL.tambo] === '4', formato()[0][COL.tambo]);
r = post(partoBase({ uuid: 'u-tambo9', tambo: '9' }));
check('un tambo que no esta en Maestro sigue rechazado', r.ok === false, JSON.stringify(r));

// 0 = no se midio / no hubo calostro.
r = post(partoBase({ uuid: 'u-brix0',
  calostro: { calidad_sin_mejorar: '0', mejorado: 'No', calidad_mejorado: '---' } }));
check('calidad 0 entra', r.ok === true, JSON.stringify(r));
r = post(partoBase({ uuid: 'u-brix0-mej',
  calostro: { calidad_sin_mejorar: '0', mejorado: 'Si', calidad_mejorado: '30' } }));
check('pero no se puede mejorar lo que no hubo',
      r.ok === false && /nada que mejorar/.test((r.detalles || []).join()), JSON.stringify(r));
// Y tampoco corrigiendo despues.
r = post({ token: TOKEN, accion: 'editar', uuid: 'u-brix0', operario: 'Julio',
           calostro: { mejorado: 'Si', calidad_mejorado: '30' } });
check('tampoco al corregir', r.ok === false && /nada que mejorar/.test(JSON.stringify(r)),
      JSON.stringify(r));
// Un valor intermedio, que es lo que producia el stepper viejo, sigue afuera.
r = post(partoBase({ uuid: 'u-brix17',
  calostro: { calidad_sin_mejorar: '17', mejorado: 'No', calidad_mejorado: '---' } }));
check('17 no existe en la lista y se rechaza', r.ok === false, JSON.stringify(r));

console.log('\n18c. Consultar el calostro de otra vaca');
/* Cuando el ternero toma calostro de otra madre, la tablet pregunta con cuanto
   cuenta esa vaca en vez de pedirle el numero de memoria al operario. */
libro = nuevoLibro();
post(partoBase({ uuid: 'u-cal-1', id_vaca: '700',
  calostro: { calidad_sin_mejorar: '24', mejorado: 'No', calidad_mejorado: '---' } }));
post(partoBase({ uuid: 'u-cal-2', id_vaca: '701',
  calostro: { calidad_sin_mejorar: '22', mejorado: 'Si', calidad_mejorado: '31' } }));
post(partoBase({ uuid: 'u-cal-3', id_vaca: '702', sexo: '7 Macho Muerto', terneros: [] }));

r = get({ action: 'calostro', token: TOKEN, vaca: '700' });
check('encuentra la vaca', r.ok === true && r.encontrada === true, JSON.stringify(r));
check('sin mejorar, el final es el natural', r.brix_final === '24', JSON.stringify(r));
r = get({ action: 'calostro', token: TOKEN, vaca: '701' });
check('si se mejoro, el final es el mejorado', r.brix_final === '31', JSON.stringify(r));
check('pero informa los dos', r.brix_natural === '22' && r.brix_mejorado === '31',
      JSON.stringify(r));
r = get({ action: 'calostro', token: TOKEN, vaca: '702' });
// Una fila de cria muerta va toda en '---' y no dice nada del calostro.
check('una cria muerta no cuenta como dato', r.ok === true && r.encontrada === false,
      JSON.stringify(r));
r = get({ action: 'calostro', token: TOKEN, vaca: '999' });
check('una vaca sin partos NO es un error', r.ok === true && r.encontrada === false,
      JSON.stringify(r));
check('sin credencial no contesta', get({ action: 'calostro', vaca: '700' }).ok === false);
check('sin vaca tampoco', get({ action: 'calostro', token: TOKEN }).ok === false);

// La vaca vuelve a parir: lo cacheado quedo viejo y hay que tirarlo.
post(partoBase({ uuid: 'u-cal-4', id_vaca: '700', fecha_parto: '2026-08-13',
  calostro: { calidad_sin_mejorar: '29', mejorado: 'No', calidad_mejorado: '---' } }));
r = get({ action: 'calostro', token: TOKEN, vaca: '700' });
check('un parto nuevo invalida el cache', r.brix_final === '29', JSON.stringify(r));

// Y un parto con calostro de otra vaca entra y queda rastreable.
r = post(partoBase({ uuid: 'u-cal-otra', id_vaca: '800',
  terneros: [{ id_ternero: '9500', raza: 'Holando', peso: 40, vive: true,
               calostro: { origen: 'Otra vaca', id_vaca_origen: '701',
                           calidad_ternero: '31', lts_ternero: '4' } }] }));
check('entra el calostro de otra vaca', r.ok === true, JSON.stringify(r));
r = post(partoBase({ uuid: 'u-cal-sin-id', id_vaca: '801',
  terneros: [{ id_ternero: '9501', raza: 'Holando', peso: 40, vive: true,
               calostro: { origen: 'Otra vaca', calidad_ternero: '31', lts_ternero: '4' } }] }));
check('pero sin decir de cual, no',
      r.ok === false && /ID de la vaca que dio el calostro/.test((r.detalles || []).join()),
      JSON.stringify(r));
r = post(partoBase({ uuid: 'u-cal-origen-malo', id_vaca: '802',
  terneros: [{ id_ternero: '9502', raza: 'Holando', peso: 40, vive: true,
               calostro: { origen: 'Del freezer', lts_ternero: '4' } }] }));
check('un origen inventado se rechaza',
      r.ok === false && /origen de calostro invalido/.test((r.detalles || []).join()),
      JSON.stringify(r));

console.log('\n18d. Cambiar el sexo: la unica operacion que mueve renglones');
/* Es la primera vez que el backend reestructura un parto ya escrito, asi que
   lo que se prueba no es que funcione: es que no rompa nada al lado. */
libro = nuevoLibro();
const conCrias = (n, extra) => partoBase(Object.assign({
  uuid: 'u-sex', id_vaca: '4444',
  sexo: n === 2 ? '8 Otros Gemelos (M+M o M+H)' : '6 Macho Vivo',
  terneros: n === 2
    ? [{ id_ternero: 'A1', raza: 'Holando', peso: 40, vive: true, sexo: 'Macho', calostro: calostroOk },
       { id_ternero: 'A2', raza: 'Holando', peso: 41, vive: true, sexo: 'Hembra', calostro: calostroOk }]
    : [{ id_ternero: 'A1', raza: 'Holando', peso: 40, vive: true, calostro: calostroOk }]
}, extra || {}));

post(conCrias(1));
// Un vecino de abajo, para comprobar que insertar no le pisa el rodeo a nadie.
post(partoBase({ uuid: 'u-vecino', id_vaca: '5555' }));
libro._hojas[libro._hoja].filas[1][COL.rodeo] = '21';     // rodeo cargado a mano
libro._hojas[libro._hoja].filas[2][COL.rodeo] = '23';

const cambiar = (extra) => post(Object.assign({
  token: TOKEN, accion: 'cambiar_sexo', uuid: 'u-sex', operario: 'Julio'
}, extra));

r = cambiar({ op_uuid: 'op-1', sexo: '8 Otros Gemelos (M+M o M+H)',
  calostro: calostroMadre, lts_madre: '5',
  terneros: [{ id_ternero: 'A1', raza: 'Holando', peso: 40, vive: true, sexo: 'Macho', calostro: calostroOk },
             { id_ternero: 'A2', raza: 'Holando', peso: 41, vive: true, sexo: 'Hembra', calostro: calostroOk }] });
check('de simple a mellizo agrega una fila', r.ok === true && r.agregadas === 1,
      JSON.stringify(r));
check('ahora el parto tiene 2 filas', formato().filter((f) => f[COL.uuid] === 'u-sex').length === 2,
      'filas=' + formato().length);
let ss1 = formato().filter((f) => f[COL.uuid] === 'u-sex');
check('renumera las crias', ss1[0][COL.cria] === '1/2' && ss1[1][COL.cria] === '2/2',
      ss1[0][COL.cria] + ' ' + ss1[1][COL.cria]);
check('el ID Parto es el mismo', ss1[0][COL.id_parto] === ss1[1][COL.id_parto]);
check('y el uuid tambien', ss1[1][COL.uuid] === 'u-sex');
check('el rodeo de la fila que ya estaba no se toco', ss1[0][COL.rodeo] === '21',
      JSON.stringify(ss1[0][COL.rodeo]));
check('la fila nueva arranca sin rodeo', ss1[1][COL.rodeo] === '', JSON.stringify(ss1[1][COL.rodeo]));
check('el parto de abajo conserva SU rodeo',
      formato().filter((f) => f[COL.uuid] === 'u-vecino')[0][COL.rodeo] === '23',
      JSON.stringify(formato().filter((f) => f[COL.uuid] === 'u-vecino')[0][COL.rodeo]));
check('cada cria con su sexo', ss1[0][COL.sexo_cria] === 'Macho' && ss1[1][COL.sexo_cria] === 'Hembra');

// El reintento a ciegas de la cola: NO puede agregar otra cria.
const antesDeRepetir18d = formato().length;
r = cambiar({ op_uuid: 'op-1', sexo: '8 Otros Gemelos (M+M o M+H)',
  calostro: calostroMadre, lts_madre: '5',
  terneros: [{ id_ternero: 'A1', raza: 'Holando', peso: 40, vive: true, sexo: 'Macho', calostro: calostroOk },
             { id_ternero: 'A2', raza: 'Holando', peso: 41, vive: true, sexo: 'Hembra', calostro: calostroOk }] });
check('el mismo op_uuid otra vez es duplicado', r.ok === true && r.duplicado === true,
      JSON.stringify(r));
check('y NO agrega filas', formato().length === antesDeRepetir18d,
      antesDeRepetir18d + ' -> ' + formato().length);

// De mellizo a simple: la cria que sobra se ANULA, no se borra.
r = cambiar({ op_uuid: 'op-2', sexo: '6 Macho Vivo', calostro: calostroMadre, lts_madre: '5',
  terneros: [{ id_ternero: 'A1', raza: 'Holando', peso: 40, vive: true, calostro: calostroOk }] });
check('de mellizo a simple anula una', r.ok === true && r.anuladas === 1, JSON.stringify(r));
check('el renglon NO se borro', formato().length === antesDeRepetir18d,
      antesDeRepetir18d + ' -> ' + formato().length);
ss1 = formato().filter((f) => f[COL.uuid] === 'u-sex');
check('la que queda vuelve a 1/1', ss1[0][COL.cria] === '1/1', ss1[0][COL.cria]);
check('la anulada queda marcada', ss1[1][COL.anulada] === 'Si', JSON.stringify(ss1[1][COL.anulada]));
check('con G a Q en ---',
      ss1[1].slice(COL.id_ternero, COL.lts_ternero + 1).every((x) => x === '---'),
      JSON.stringify(ss1[1].slice(COL.id_ternero, COL.lts_ternero + 1)));
check('y su contenido anterior guardado en _log',
      log().some((l) => /cria anulada/.test(l[4]) && /A2/.test(l[2])),
      JSON.stringify(log().map((l) => l[4])));
check('la lista del dia ya no la muestra',
      get({ action: 'partos', token: TOKEN, fecha: '2026-08-12' })
        .partos.filter((x) => x.uuid === 'u-sex').length === 1);

// Y si vuelve a ser doble, se reutiliza esa misma fila en vez de insertar otra.
r = cambiar({ op_uuid: 'op-3', sexo: '8 Otros Gemelos (M+M o M+H)',
  calostro: calostroMadre, lts_madre: '5',
  terneros: [{ id_ternero: 'A1', raza: 'Holando', peso: 40, vive: true, sexo: 'Macho', calostro: calostroOk },
             { id_ternero: 'A3', raza: 'Holando', peso: 39, vive: true, sexo: 'Hembra', calostro: calostroOk }] });
check('volver a mellizo reutiliza la fila anulada',
      r.ok === true && r.revividas === 1 && r.agregadas === 0, JSON.stringify(r));
check('sin agregar renglones', formato().length === antesDeRepetir18d,
      antesDeRepetir18d + ' -> ' + formato().length);
ss1 = formato().filter((f) => f[COL.uuid] === 'u-sex');
check('y ya no esta anulada', ss1[1][COL.anulada] === '' && ss1[1][COL.id_ternero] === 'A3',
      JSON.stringify([ss1[1][COL.anulada], ss1[1][COL.id_ternero]]));

// Lo que NO se puede.
r = cambiar({ sexo: '6 Macho Vivo' });
check('sin op_uuid no se hace nada', r.ok === false && /op_uuid/.test(r.error), JSON.stringify(r));
r = cambiar({ op_uuid: 'op-4', sexo: '2 Hembras Gemelas Vivas', calostro: calostroMadre,
  lts_madre: '5',
  terneros: [{ id_ternero: 'A1', raza: 'Holando', peso: 40, vive: true, sexo: 'Macho', calostro: calostroOk },
             { id_ternero: 'A3', raza: 'Holando', peso: 39, vive: true, sexo: 'Hembra', calostro: calostroOk }] });
check('el codigo 2 con un macho se sigue rechazando',
      r.ok === false && /no admite machos/.test((r.detalles || []).join()), JSON.stringify(r));
r = post({ token: TOKEN, accion: 'cambiar_sexo', uuid: 'no-existe', op_uuid: 'op-5',
           operario: 'Julio', sexo: '6 Macho Vivo' });
check('un uuid que no existe', r.ok === false && /no existe/.test(r.error), JSON.stringify(r));

// Un parto cargado otro dia: misma ventana que corregir.
post(partoBase({ uuid: 'u-sex-ayer', id_vaca: '6666', cargado_en: '2026-08-01T10:00:00.000Z' }));
r = post({ token: TOKEN, accion: 'cambiar_sexo', uuid: 'u-sex-ayer', op_uuid: 'op-6',
           operario: 'Julio', sexo: '1 Hembra Viva', calostro: calostroMadre, lts_madre: '5',
           terneros: [{ id_ternero: 'B1', raza: 'Holando', peso: 40, vive: true, calostro: calostroOk }] });
check('un parto de otro dia ya no se toca', r.ok === false && /hoy/.test(r.error), JSON.stringify(r));

// Pasar a cria muerta colapsa a una fila con todo en ---.
r = cambiar({ op_uuid: 'op-7', sexo: '7 Macho Muerto', terneros: [] });
check('vivo a muerto entra', r.ok === true, JSON.stringify(r));
ss1 = formato().filter((f) => f[COL.uuid] === 'u-sex' && f[COL.anulada] !== 'Si');
check('queda una sola cria activa', ss1.length === 1, 'filas=' + ss1.length);
check('con el bloque en ---',
      ss1[0].slice(COL.id_ternero, COL.lts_ternero + 1).every((x) => x === '---'),
      JSON.stringify(ss1[0].slice(COL.id_ternero, COL.lts_ternero + 1)));
check('y el rodeo intacto', ss1[0][COL.rodeo] === '21', JSON.stringify(ss1[0][COL.rodeo]));

// editar sigue sin mover renglones nunca: esa garantia no se toco.
const antesDeEditar = formato().length;
post({ token: TOKEN, accion: 'editar', uuid: 'u-sex', operario: 'Julio', tambo: '3' });
check('editar sigue sin agregar ni borrar filas', formato().length === antesDeEditar,
      antesDeEditar + ' -> ' + formato().length);

console.log('\n18e. La vista Datos Carga DC');
/* Es una tabla mantenida por script, no formulas: un checkbox dentro de un
   derrame queda anclado a una POSICION, y cambiar el sexo inserta filas en el
   medio de Registros. Todos los tildes de abajo pasarian a la cria equivocada,
   en silencio. Aca cada fila lleva su clave uuid|cria. */
libro = nuevoLibro();
const DC = sandbox.DC;
const vista = () => libro._hojas['Datos Carga DC'].filas.slice(1);

post(partoBase({ uuid: 'u-dc-1', id_vaca: '900',
  terneros: [{ id_ternero: '9001', raza: 'Holando', peso: 40, vive: true, sexo: 'Macho',
               calostro: calostroOk }] }));
check('la vista se llena sola al entrar un parto', vista().length === 1,
      'filas=' + vista().length);
let d = vista()[0];
check('el ID de la vaca va primero', d[DC.id_vaca] === '900', d[DC.id_vaca]);
check('la inicial del sexo va pegada al ID del ternero', d[DC.sexo_id] === 'M9001',
      d[DC.sexo_id]);
check('el metodo es fijo', d[DC.metodo] === 'Sonda', d[DC.metodo]);
check('la clave es uuid|cria', d[DC.clave] === 'u-dc-1|1/1', d[DC.clave]);
check('arranca sin rodeo y sin tildar', d[DC.rodeo] === '' && d[DC.cargado] === false,
      JSON.stringify([d[DC.rodeo], d[DC.cargado]]));

// Hembra lleva H, no F.
post(partoBase({ uuid: 'u-dc-2', id_vaca: '901', sexo: '1 Hembra Viva',
  terneros: [{ id_ternero: '9002', raza: 'Holando', peso: 40, vive: true, calostro: calostroOk }] }));
check('una hembra lleva H', vista()[1][DC.sexo_id] === 'H9002', vista()[1][DC.sexo_id]);

// Las dos calidades de la madre, natural y final.
post(partoBase({ uuid: 'u-dc-3', id_vaca: '902',
  calostro: { calidad_sin_mejorar: '22', mejorado: 'Si', calidad_mejorado: '31' },
  terneros: [{ id_ternero: '9003', raza: 'Holando', peso: 40, vive: true,
               calostro: { origen: 'Propia madre', calidad_ternero: '31', lts_ternero: '4' } }] }));
d = vista()[2];
check('informa la calidad natural de la madre', d[DC.calostro_madre] === '22', d[DC.calostro_madre]);
check('y la final por separado', d[DC.calostro_final] === '31', d[DC.calostro_final]);
check('mas lo que efectivamente tomo el ternero', d[DC.calidad_ternero] === '31',
      d[DC.calidad_ternero]);

// Una cria muerta entra igual: la vaca vuelve a un rodeo lo mismo.
post(partoBase({ uuid: 'u-dc-4', id_vaca: '903', sexo: '7 Macho Muerto', terneros: [] }));
d = vista()[3];
check('la cria muerta aparece, para poder asignarle el rodeo', d[DC.id_vaca] === '903',
      d[DC.id_vaca]);
check('pero sin datos de calostro',
      d[DC.calostro_madre] === '' && d[DC.calidad_ternero] === '' && d[DC.id_ternero] === '',
      JSON.stringify([d[DC.calostro_madre], d[DC.calidad_ternero], d[DC.id_ternero]]));

console.log('\n18f. El rodeo y el tilde se replican por clave, no por posicion');
/* Esta es la prueba que justifica que la vista sea una tabla y no una formula. */
const hojaDC = libro._hojas['Datos Carga DC'];
const registros = libro._hojas[libro._hoja];

// Nahuel escribe el rodeo de la ULTIMA fila y tilda la primera.
hojaDC.filas[4][DC.rodeo] = '207';
hojaDC.filas[1][DC.cargado] = true;
sandbox.onEdit({ range: hojaDC.getRange(5, DC.rodeo + 1, 1, 1) });
sandbox.onEdit({ range: hojaDC.getRange(2, DC.cargado + 1, 1, 1) });
check('el rodeo bajo a Registros', registros.filas[4][COL.rodeo] === '207',
      JSON.stringify(registros.filas[4][COL.rodeo]));
check('y el tilde tambien', registros.filas[1][COL.cargado_dc] === true,
      JSON.stringify(registros.filas[1][COL.cargado_dc]));

/* Ahora se inserta una fila EN EL MEDIO: es lo que hace cambiar el sexo. Con
   una vista por posicion, el rodeo de abajo pasaria a la cria equivocada. */
r = post({ token: TOKEN, accion: 'cambiar_sexo', uuid: 'u-dc-1', op_uuid: 'op-dc-1',
           operario: 'Julio', sexo: '8 Otros Gemelos (M+M o M+H)',
           calostro: calostroMadre, lts_madre: '5',
           terneros: [{ id_ternero: '9001', raza: 'Holando', peso: 40, vive: true,
                        sexo: 'Macho', calostro: calostroOk },
                      { id_ternero: '9009', raza: 'Holando', peso: 39, vive: true,
                        sexo: 'Hembra', calostro: calostroOk }] });
check('el cambio de sexo entra', r.ok === true && r.agregadas === 1, JSON.stringify(r));
const cerca = vista().find((f) => f[DC.clave] === 'u-dc-4|1/1');
check('el rodeo sigue con SU cria, aunque se corrio de fila',
      cerca && cerca[DC.rodeo] === '207', JSON.stringify(cerca && cerca[DC.rodeo]));
const tildada = vista().find((f) => f[DC.clave] === 'u-dc-1|1/2');
check('y el tilde tambien sigue a la suya', tildada && tildada[DC.cargado] === true,
      JSON.stringify(tildada && tildada[DC.cargado]));
check('la cria nueva aparece en la vista',
      vista().some((f) => f[DC.sexo_id] === 'H9009'),
      JSON.stringify(vista().map((f) => f[DC.sexo_id])));

// Una cria anulada sale de la vista: no va a DairyComp.
r = post({ token: TOKEN, accion: 'cambiar_sexo', uuid: 'u-dc-1', op_uuid: 'op-dc-2',
           operario: 'Julio', sexo: '6 Macho Vivo', calostro: calostroMadre, lts_madre: '5',
           terneros: [{ id_ternero: '9001', raza: 'Holando', peso: 40, vive: true,
                        calostro: calostroOk }] });
check('anular saca la fila de la vista',
      !vista().some((f) => f[DC.id_ternero] === '9009'),
      JSON.stringify(vista().map((f) => f[DC.id_ternero])));
check('pero el rodeo del vecino sigue intacto',
      (vista().find((f) => f[DC.clave] === 'u-dc-4|1/1') || {})[DC.rodeo] === '207');

/* Un rodeo cargado directo en Registros sube a la vista, no se pierde. (Se
   busca la fila por uuid: los cambios de sexo de arriba las corrieron.) */
registros.filas.find((f) => f[COL.uuid] === 'u-dc-2')[COL.rodeo] = '26';
post(partoBase({ uuid: 'u-dc-5', id_vaca: '904' }));       // dispara la reconstruccion
check('un rodeo escrito en Registros aparece en la vista',
      (vista().find((f) => f[DC.clave] === 'u-dc-2|1/1') || {})[DC.rodeo] === '26',
      JSON.stringify(vista().map((f) => f[DC.rodeo])));

console.log('\n19. Esquema: el backend escribe por posicion, asi que lo verifica');
libro = nuevoLibro();
r = get({ action: 'esquema', token: TOKEN });
check('el encabezado real coincide con el que espera el codigo', r.ok === true,
      JSON.stringify(r.diferencias));
check('informa cuantas columnas son', r.columnas === HEAD_FORMATO.length, r.columnas);
check('sin token no contesta', get({ action: 'esquema' }).ok === false);
// Alguien inserta una columna en la planilla: el backend seguiria escribiendo
// donde estaba y corromperia en silencio. Esto es lo que lo hace detectable.
libro._hojas[libro._hoja].filas[0][COL.tambo] = 'Otra Cosa';
r = get({ action: 'esquema', token: TOKEN });
check('detecta una columna cambiada', r.ok === false && r.diferencias.length === 1,
      JSON.stringify(r.diferencias));

console.log('\n20. La hoja se encuentra con el nombre nuevo y con el viejo');
/* Tener los dos nombres es lo que permite deployar y renombrar la pestaña en
   momentos distintos. Renombrar antes de publicar daria null y todo doPost
   explotaria. */
libro = nuevoLibro('NUEVO FORMATO PREPARTO');
r = post(partoBase({ uuid: 'u-nombre-viejo' }));
check('entra con el nombre viejo', r.ok === true, JSON.stringify(r));
check('y escribio la fila', formato().length === 1, 'filas=' + formato().length);

libro = nuevoLibro('Registros');
libro._hojas['NUEVO FORMATO PREPARTO'] = crearHoja('NUEVO FORMATO PREPARTO', [HEAD_FORMATO.slice()]);
post(partoBase({ uuid: 'u-nombre-nuevo' }));
check('con las dos, gana Registros',
      libro._hojas['Registros'].filas.length === 2 &&
      libro._hojas['NUEVO FORMATO PREPARTO'].filas.length === 1,
      libro._hojas['Registros'].filas.length + ' / ' +
      libro._hojas['NUEVO FORMATO PREPARTO'].filas.length);

console.log('\n21. Migracion r5 -> r6 del layout');
/* Es lo unico de r6 que reescribe filas de produccion, y adentro va el rodeo
   que Nahuel carga a mano. Si eso se pierde, no hay como reconstruirlo. */
const HEAD_R5 = ['Operario', 'ID Vaca', 'Fecha Parto', 'Hora Nacimiento', 'Tipo Parto',
  'Sexo, Vivo, Mellizos', 'ID Ternero', 'Raza', 'Peso Ternero (Kg)',
  'Calidad Calostro Sin Mejorar', 'Mejorado', 'Calidad de Calostro Mejorado',
  'Calostro Consumido al Momento', 'Lts Calostro Madre Produjo',
  'Lts Calostro para Ternero', 'ID Vaca Origen Calostro',
  'Tambo Vaca', 'Asignacion Rodeo Vaca', 'Notas Nahuel',
  'Sexo Cria', 'Estado Cria', 'ID Parto', 'Cria', 'UUID', 'Cargado en', 'Dispositivo'];

const cargado = new Date(2026, 7, 20, 8, 30);
const filaViva = ['Julio', '4115', new Date(2026, 7, 20), '07:00', '1 Normal', '6 Macho Vivo',
  '24543', 'Holando', 42, '26', 'No', '---', 'Si', 5, 4, '119',
  '2', '21', 'una nota', 'Macho', 'Vivo', 'IDP-1', '1/1', 'u-mig-1', cargado, 'tablet'];
const filaPropia = ['Trini', '5514', new Date(2026, 7, 20), '09:00', '1 Normal', '1 Hembra Viva',
  '9001', 'Holando', 38, '28', 'Si', '32', 'No', 6, 3, '5514',
  '1', '23', '', 'Hembra', 'Vivo', 'IDP-2', '1/1', 'u-mig-2', cargado, 'tablet'];
const filaMuerta = ['Griselda', '6865', new Date(2026, 7, 20), '11:00', '1 Normal', '7 Macho Muerto',
  '---', '---', '---', '---', '---', '---', '---', '---', '---', '---',
  '3', '26', '', 'Macho', 'Muerto', 'IDP-3', '1/1', 'u-mig-3', cargado, 'tablet'];

libro = nuevoLibro('NUEVO FORMATO PREPARTO');
libro._hojas['NUEVO FORMATO PREPARTO'].filas = [HEAD_R5.slice(), filaViva.slice(),
                                                filaPropia.slice(), filaMuerta.slice()];
sandbox.migrarR6();

const mig = libro._hojas['Registros'];
check('renombro la pestaña a Registros', !!mig, Object.keys(libro._hojas).join(', '));
check('dejo un respaldo antes de tocar nada', !!libro._hojas['Registros_backup_r5']);
check('el respaldo conserva el layout viejo',
      libro._hojas['Registros_backup_r5'].filas[0].length === 26);
check('escribio el encabezado nuevo',
      mig.filas[0].join('|') === HEAD_FORMATO.join('|'), mig.filas[0].join('|'));
check('no perdio ni agrego filas', mig.filas.length === 4, 'filas=' + mig.filas.length);

const v = mig.filas[1];
check('el rodeo de Nahuel sobrevivio', v[COL.rodeo] === '21', JSON.stringify(v[COL.rodeo]));
check('las notas tambien', v[COL.notas] === 'una nota', JSON.stringify(v[COL.notas]));
check('los litros de la madre se movieron de N a M', v[COL.lts_madre] === 5, v[COL.lts_madre]);
check('los del ternero, de O a Q', v[COL.lts_ternero] === 4, v[COL.lts_ternero]);
check('el calostro de la madre quedo donde estaba', v[COL.calidad_sin_mejorar] === '26');
check('desaparecio "consumido"', v.indexOf('Si') === -1, JSON.stringify(v));
check('deduce que el calostro era de otra vaca',
      v[COL.origen_calostro] === 'Otra vaca' && v[COL.id_vaca_origen] === '119',
      v[COL.origen_calostro] + ' / ' + v[COL.id_vaca_origen]);
check('y reconstruye lo que tomo el ternero', v[COL.calidad_ternero] === '26',
      v[COL.calidad_ternero]);
check('las tecnicas se corrieron enteras',
      v[COL.uuid] === 'u-mig-1' && v[COL.cria] === '1/1' && v[COL.dispositivo] === 'tablet',
      JSON.stringify([v[COL.uuid], v[COL.cria], v[COL.dispositivo]]));
check('arranca sin anular y sin cargar a DC',
      v[COL.anulada] === '' && v[COL.cargado_dc] === false,
      JSON.stringify([v[COL.anulada], v[COL.cargado_dc]]));

const pr = mig.filas[2];
check('calostro de la propia madre queda marcado asi',
      pr[COL.origen_calostro] === 'Propia madre' && pr[COL.id_vaca_origen] === '5514',
      pr[COL.origen_calostro] + ' / ' + pr[COL.id_vaca_origen]);
check('si fue mejorado, el ternero tomo el mejorado', pr[COL.calidad_ternero] === '32',
      pr[COL.calidad_ternero]);

const mu = mig.filas[3];
check('la cria muerta extiende los --- hasta Q',
      mu.slice(COL.id_ternero, COL.lts_ternero + 1).every((x) => x === '---'),
      JSON.stringify(mu.slice(COL.id_ternero, COL.lts_ternero + 1)));
check('pero conserva tambo, rodeo y estado',
      mu[COL.tambo] === '3' && mu[COL.rodeo] === '26' && mu[COL.estado_cria] === 'Muerto');

// Correrla dos veces no puede duplicar ni volver a tocar nada.
const antesDeRepetir = JSON.stringify(mig.filas);
sandbox.migrarR6();
check('correrla de nuevo no hace nada', JSON.stringify(mig.filas) === antesDeRepetir);

// Y despues de migrar, un parto nuevo entra normal.
r = post(partoBase({ uuid: 'u-post-migracion' }));
check('la app sigue escribiendo despues de migrar', r.ok === true, JSON.stringify(r));
check('en la hoja renombrada', mig.filas.length === 5, 'filas=' + mig.filas.length);

console.log('\n' + (fallos ? `${fallos} PRUEBAS FALLARON` : 'todas las pruebas pasaron'));
process.exit(fallos ? 1 : 0);
