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
  'Notas', 'ID Parto', 'Cria', 'UUID', 'Cargado en', 'Dispositivo'];

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
  consumido: 'Si', lts_madre: '5', lts_ternero: '4', id_vaca_origen: '119'
};

const partoBase = (extra) => Object.assign({
  token: TOKEN, uuid: 'u-simple-0001', dispositivo: 'tablet-maternidad',
  operario: 'Julio', id_vaca: '4115', fecha_parto: '2026-08-12',
  hora_nacimiento: '07:00', tipo_parto: '1 Normal', sexo: '6 Macho Vivo',
  terneros: [{ id_ternero: '24543', raza: 'Holando', peso: 42 }],
  calostro: calostroOk, tambo: '2', rodeo: '26', notas: ''
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
check('cria 1/1', f[20] === '1/1', f[20]);
check('uuid en la fila', f[21] === 'u-simple-0001');
check('log en ok', log()[0][4] === 'ok' && log()[0][3] === 1, JSON.stringify(log()[0].slice(3)));

console.log('\n2. Mismo uuid otra vez (la prueba que mas importa)');
r = post(partoBase());
check('marca duplicado', r.ok === true && r.duplicado === true, JSON.stringify(r));
check('NO agrega fila', formato().length === 1, 'filas=' + formato().length);

console.log('\n3. Parto doble -> 2 filas');
r = post(partoBase({
  uuid: 'u-doble-0002', id_vaca: '5514', sexo: '2 Hembras Gemelas Vivas',
  terneros: [{ id_ternero: '9101', raza: 'Holando', peso: 32 },
             { id_ternero: '9102', raza: 'Holando', peso: 30 }]
}));
check('responde ok', r.ok === true, JSON.stringify(r));
check('escribe 2 filas', r.filas_escritas === 2 && formato().length === 3);
const [d1, d2] = formato().slice(1);
check('mismo ID Parto', d1[19] === d2[19], d1[19] + ' vs ' + d2[19]);
check('cria 1/2 y 2/2', d1[20] === '1/2' && d2[20] === '2/2', d1[20] + ' ' + d2[20]);
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
r = post(partoBase({ uuid: 'u-mej-0006', calostro: Object.assign({}, calostroOk, { mejorado: 'Si', calidad_mejorado: '---' }) }));
check('mejorado=Si sin calidad', r.ok === false, JSON.stringify(r));
r = post(partoBase({ uuid: 'u-simple2-0007', terneros: [
  { id_ternero: '1', raza: 'Holando', peso: 40 }, { id_ternero: '2', raza: 'Holando', peso: 40 }] }));
check('sexo simple con 2 crias', r.ok === false && /no es de parto doble/.test(r.detalles.join()));
check('rechazos no escriben filas', formato().length === 4, 'filas=' + formato().length);
check('rechazos quedan en _log', log().filter((l) => /rechazado/.test(l[4])).length === 4,
      JSON.stringify(log().map((l) => l[4])));

console.log('\n6. Rodeo: Maestro vacio = sin restriccion');
r = post(partoBase({ uuid: 'u-rodeo-0008', rodeo: '207' }));
check('acepta rodeo cualquiera', r.ok === true, JSON.stringify(r));

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

console.log('\n' + (fallos ? `${fallos} PRUEBAS FALLARON` : 'todas las pruebas pasaron'));
process.exit(fallos ? 1 : 0);
