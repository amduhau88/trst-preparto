/* Preparto — PWA de carga de partos.
 *
 * Regla de oro: "Guardar parto" escribe SIEMPRE primero en IndexedDB y le responde
 * al operario al instante. La red viene despues. Un parto cargado en el corral no
 * se pierde aunque no haya senal, aunque cierre la app o se apague la tablet.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const VACIO = '---';
const SEXO_MUERTO = ['4', '7'];
const SEXO_MELLIZO = ['2', '8'];
const ORIGEN_PROPIA = 'Propia madre';
const ORIGEN_OTRA = 'Otra vaca';
// 0 Brix = no se midio / no hubo calostro. No es un numero mas.
const SIN_CALOSTRO = 0;

/* ------------------------------------------------------------------ */
/* Configuracion                                                       */
/* ------------------------------------------------------------------ */

const CONFIG = window.CONFIG || {};
const cfg = {
  url: CONFIG.URL_EXEC || '',
  dispositivo: localStorage.getItem('dispositivo') || 'tablet-maternidad'
};

// El nombre del dispositivo se puede fijar al instalar: index.html?dispositivo=tablet-2
(function configDesdeURL() {
  const q = new URLSearchParams(location.search);
  if (q.get('dispositivo')) {
    cfg.dispositivo = q.get('dispositivo');
    localStorage.setItem('dispositivo', cfg.dispositivo);
    history.replaceState({}, '', location.pathname);
  }
})();

/* ------------------------------------------------------------------ */
/* Sesion — quien puede usar la app                                    */
/* ------------------------------------------------------------------ */

/* Autenticar y usar son dos cosas distintas: se inicia sesion UNA vez con
   señal, y a partir de ahi la app abre y guarda partos en el corral sin red.
   La sesion cacheada habilita la pantalla; el ID token fresco, la escritura. */

let sesion = null;                    // { email, admin, hasta }
let idToken = { valor: '', exp: 0 };
let sesionVencida = false;

/* No poder renovar el token AHORA no es una sesion caida. En la tablet, One Tap
   se apaga solo (cooldown despues de un descarte, bloqueo de cookies de
   terceros en Safari) y el token de Google dura una hora: si cada fallo pintara
   "Sesion vencida", el cartel estaria en rojo casi todo el dia mintiendo.
   Se avisa recien al tercer fallo seguido, o cuando lo dice el backend. */
let fallosToken = 0;
let renovando = null;                 // promesa unica: dos llamadas no abren dos prompts
const MARGEN_TOKEN = 10 * 60000;      // se renueva 10 min antes de vencer
const FALLOS_PARA_AVISAR = 3;

(function cargarSesion() {
  try {
    sesion = JSON.parse(localStorage.getItem('sesion') || 'null');
    if (sesion && !(sesion.hasta > Date.now())) sesion = null;
  } catch (e) { sesion = null; }
  try {
    idToken = JSON.parse(localStorage.getItem('idToken') || 'null') || { valor: '', exp: 0 };
  } catch (e) { idToken = { valor: '', exp: 0 }; }
})();

/** Vencimiento del JWT, leido del propio token (sin verificarlo: eso lo hace el backend). */
function vencimientoDe(jwt) {
  try {
    const cuerpo = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return (JSON.parse(atob(cuerpo)).exp || 0) * 1000;
  } catch (e) { return 0; }
}

function cargarGoogle() {
  if (window.google && google.accounts && google.accounts.id) return Promise.resolve();
  return new Promise((ok, err) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.defer = true;
    s.onload = ok;
    s.onerror = () => err(new Error('sin conexion con Google'));
    document.head.appendChild(s);
  });
}

let entregarCredencial = null;
async function prepararGoogle() {
  await cargarGoogle();
  google.accounts.id.initialize({
    client_id: CONFIG.CLIENT_ID,
    callback: (r) => { if (entregarCredencial) entregarCredencial(r.credential); },
    auto_select: true,
    cancel_on_tap_outside: false,
    hd: CONFIG.DOMINIO
  });
}

/** Valida la credencial contra el backend y abre la sesion local. */
async function abrirSesion(jwt) {
  idToken = { valor: jwt, exp: vencimientoDe(jwt) };
  localStorage.setItem('idToken', JSON.stringify(idToken));

  let r;
  try { r = await enviar({ accion: 'sesion' }); }
  catch (e) { return { ok: false, error: 'sin conexion' }; }
  if (!r.ok) return r;

  // Con backend r7 llega la credencial propia de 30 dias: desde aca la tablet
  // no vuelve a depender del token de Google (1 h) para sincronizar. Con un
  // backend anterior no viene, y se sigue como antes.
  sesion = { email: r.email, admin: !!r.admin,
             token: r.sesion_token || '',
             hasta: r.sesion_hasta ? Date.parse(r.sesion_hasta)
                                   : Date.now() + (CONFIG.DIAS_SESION || 30) * 86400000 };
  localStorage.setItem('sesion', JSON.stringify(sesion));
  sesionVencida = false;
  fallosToken = 0;
  return { ok: true };
}

function cerrarSesion() {
  sesion = null;
  idToken = { valor: '', exp: 0 };
  sesionVencida = false;
  fallosToken = 0;
  renovando = null;
  localStorage.removeItem('sesion');
  localStorage.removeItem('idToken');
  try { google.accounts.id.disableAutoSelect(); } catch (e) { /* sin red */ }
  pintarCuenta();
  ver('login');
  pintarLogin();
}

const tokenSirve = (margen) => !!idToken.valor && idToken.exp - margen > Date.now();
/** La credencial propia del backend (30 dias) esta y no vencio. */
const sesionSirve = () => !!(sesion && sesion.token) && sesion.hasta - 60000 > Date.now();

/** Cualquier respuesta puede traer credencial nueva (login o renovacion silenciosa). */
function guardarCredencial(r) {
  if (!r || !r.sesion_token || !sesion) return;
  sesion.token = r.sesion_token;
  if (r.sesion_hasta) sesion.hasta = Date.parse(r.sesion_hasta);
  localStorage.setItem('sesion', JSON.stringify(sesion));
}

/**
 * Devuelve un ID token vigente, renovandolo en silencio si hace falta.
 * Solo se usa al sincronizar: guardar un parto nunca depende de esto.
 *
 * Se renueva con 10 minutos de margen para que la renovacion no caiga justo
 * cuando hay partos esperando. Si el prompt no responde pero el token viejo
 * todavia sirve, se usa ese: un token de 59 minutos es perfectamente valido.
 */
async function tokenVigente() {
  if (tokenSirve(MARGEN_TOKEN)) return idToken.valor;
  if (!navigator.onLine) return tokenSirve(60000) ? idToken.valor : '';

  if (!renovando) renovando = renovarToken().then((j) => { renovando = null; return j; });
  const jwt = await renovando;
  if (jwt) return jwt;
  return tokenSirve(60000) ? idToken.valor : '';
}

async function renovarToken() {
  try {
    await prepararGoogle();
    const jwt = await new Promise((ok) => {
      const cortar = setTimeout(() => { entregarCredencial = null; ok(''); }, 8000);
      entregarCredencial = (c) => { clearTimeout(cortar); entregarCredencial = null; ok(c); };
      google.accounts.id.prompt();
    });
    if (!jwt) return '';
    idToken = { valor: jwt, exp: vencimientoDe(jwt) };
    localStorage.setItem('idToken', JSON.stringify(idToken));
    return jwt;
  } catch (e) {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* Listas (Maestro)                                                    */
/* ------------------------------------------------------------------ */

const rango = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
const horas = () => Array.from({ length: 48 }, (_, i) =>
  String(Math.floor(i / 2)).padStart(2, '0') + ':' + (i % 2 ? '30' : '00'));

/* Copia de Maestro para el primer arranque sin señal. En cuanto hay red se
   reemplaza por lo que diga la planilla, que es la fuente de verdad. */
const LISTAS_BASE = {
  operario: ['Julio', 'Griselda', 'Martin', 'Trini'],
  tipo_parto: ['1 Normal', '2 Asistido', '4 Cesarea'],
  sexo: ['1 Hembra Viva', '2 Hembras Gemelas Vivas', '4 Hembra Muerta', '6 Macho Vivo',
         '7 Macho Muerto', '8 Otros Gemelos (M+M o M+H)'],
  raza: ['Holando', 'Angus'],
  peso: rango(25, 60),
  hora_nacimiento: horas(),
  // El 0 significa "no se midio / no hubo calostro". La lista salta de 0 a 18
  // a proposito: entre medio no hay valores validos.
  calidad_sin_mejorar: ['0'].concat(rango(18, 35)).concat(['mastitis', 'sangre', 'campo']),
  mejorado: ['Si', 'No'],
  calidad_mejorado: [VACIO].concat(rango(26, 35)),
  lts_madre: rango(0, 20),
  lts_ternero: rango(2, 6),
  tambo: ['1', '2', '3', '4'],
  rodeo: []
};

let listas = Object.assign({}, LISTAS_BASE);
try {
  const guardadas = JSON.parse(localStorage.getItem('listas') || 'null');
  if (guardadas) listas = Object.assign({}, LISTAS_BASE, guardadas);
} catch (e) { /* listas corruptas: se usan las base */ }

const numeros = (k) => (listas[k] || []).filter((v) => /^\d+$/.test(v)).map(Number);
const noNumeros = (k) => (listas[k] || []).filter((v) => !/^\d+$/.test(v) && v !== VACIO);

/* ------------------------------------------------------------------ */
/* Base local (IndexedDB)                                              */
/* ------------------------------------------------------------------ */

let _db = null;
function db() {
  if (_db) return Promise.resolve(_db);
  return new Promise((ok, err) => {
    const req = indexedDB.open('preparto', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('partos')) {
        d.createObjectStore('partos', { keyPath: 'uuid' }).createIndex('estado', 'estado');
      }
    };
    req.onsuccess = () => { _db = req.result; ok(_db); };
    req.onerror = () => err(req.error);
  });
}

function tx(modo, fn) {
  return db().then((d) => new Promise((ok, err) => {
    const t = d.transaction('partos', modo);
    const req = fn(t.objectStore('partos'));
    t.oncomplete = () => ok(req && req.result);
    t.onerror = () => err(t.error);
  }));
}

const guardarLocal = (reg) => tx('readwrite', (s) => s.put(reg));
const todosLocal = () => tx('readonly', (s) => s.getAll());
const borrarLocal = (uuid) => tx('readwrite', (s) => s.delete(uuid));

/* ------------------------------------------------------------------ */
/* Estado del formulario                                               */
/* ------------------------------------------------------------------ */

/* Cada ternero lleva lo suyo: sexo, si nacio vivo, y su propio calostro.
   Los litros que produjo la madre son del parto, no de la cria. */
const st = {
  fecha: '', tipo_parto: '', sexo: '', lts_madre: null, tambo: '', terneros: [],
  // Lo que produjo la madre es del PARTO: una vaca produjo un calostro, no uno
  // por cria. Cargarlo por cria dejaba escribir dos calidades distintas para la
  // misma madre en un mellizo.
  cal: null,
  // uuid del parto que se esta corrigiendo, o null si se esta cargando uno nuevo.
  editando: null
};

function nuevoCalostroMadre() {
  return { brix: medio('calidad_sin_mejorar'), brixExc: '', mejorado: 'No', mej: VACIO };
}

/** Los Brix con los que quedo el calostro de la madre: el mejorado, si se mejoro. */
const brixMadre = () => (st.cal.mejorado === 'Si' && st.cal.mej !== VACIO)
  ? String(st.cal.mej) : String(st.cal.brixExc || st.cal.brix);

/** Sin calostro no hay nada que mejorar. */
const sinCalostro = () => !st.cal.brixExc && Number(st.cal.brix) === SIN_CALOSTRO;

/* El peso arranca en null, no en el medio de la lista: el ternero se pesa mas
   tarde, y un numero puesto por la app es indistinguible de uno medido. Null se
   pinta como "—" y viaja como columna I vacia: "falta pesar". */
function nuevoTernero() {
  return {
    id_ternero: '', raza: (listas.raza || [''])[0], peso: null,
    caravana_senasa: '',              // 6 digitos, obligatoria desde v15
    sexo: '', vive: true,
    cal: {
      // De quien tomo el calostro ESTE ternero. Por defecto, su propia madre.
      origen: ORIGEN_PROPIA, id_origen: '',
      // Solo se usa con 'Otra vaca': con la propia madre sale de la caja de arriba.
      brix: '', consulta: '',
      lts_ternero: String(medio('lts_ternero'))
    }
  };
}

/** Como identificar una ficha: "24543 · Macho". Es lo que evita confundir mellizos. */
function etiquetaCria(t, i) {
  const partes = [];
  if (t.id_ternero) partes.push(t.id_ternero);
  const sx = t.sexo || SEXO_POR_CODIGO[String(st.sexo).charAt(0)] || '';
  if (sx) partes.push(sx);
  if (!t.vive) partes.push('muerto');
  return partes.length ? partes.join(' · ') : 'Ternero ' + (i + 1) + ' — sin datos';
}

// El codigo del parto ya dice el sexo, salvo el 8 (M+M o M+H), que es ambiguo.
const SEXO_POR_CODIGO = { 1: 'Hembra', 2: 'Hembra', 4: 'Hembra', 6: 'Macho', 7: 'Macho' };
const sexoAmbiguo = () => String(st.sexo).charAt(0) === '8';

/* ---------- fecha: solo Hoy o Ayer ---------- */

const aISO = (d) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const aDDMMAAAA = (iso) => iso.split('-').reverse().join('/');

function fechasPosibles() {
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const ayer = new Date(hoy); ayer.setDate(ayer.getDate() - 1);
  return [{ etiqueta: 'Hoy', iso: aISO(hoy) }, { etiqueta: 'Ayer', iso: aISO(ayer) }];
}

/**
 * Cada chip muestra la fecha concreta: el operario ve con que dia va a quedar
 * registrado el parto en vez de tener que deducirlo.
 */
/* La lista del dia tiene su PROPIA fecha. Cuando compartia st.fecha con el chip
   del formulario, cargar un parto tardio como "Ayer" dejaba la lista clavada en
   ayer: el operario veia los partos del dia anterior con el cartel en verde y lo
   leia como que la app perdio los de hoy. */
// Desde v15 la lista es UNA: todo lo de la planilla mas lo local. Se conserva
// el nombre para no tocar todos los llamados.
let listaFecha = 'todos';
/* Valor especial del chip de la lista: en vez de un dia, TODO lo que esta sin
   sincronizar, de cualquier fecha. Un parto trabado de hace una semana no
   aparecia en ninguna pantalla (Hoy/Ayer no lo alcanzan) y el operario no
   tenia como verlo ni corregirlo. */
const LISTA_PENDIENTES = 'pendientes';
/* "Todos": el historico completo de la planilla mas lo local, con buscador. */
const LISTA_TODOS = 'todos';
const esAdmin = () => !!(sesion && sesion.admin);
const sinSubir = (r) => r.estado !== 'ok' || !!r.edicion || !!r.cambioSexo || !!r.revisarEdicion;

function pintarFechas() {
  const opciones = fechasPosibles();
  // Si la app quedo abierta toda la noche y cruzo la medianoche, la seleccion
  // vieja ya no corresponde a ningun boton: se reancla en Hoy.
  // Corrigiendo un parto de otro dia, su fecha se respeta aunque no sea Hoy ni
  // Ayer: si no, este repintado lo movia a hoy sin que nadie lo pidiera.
  const delForm = (st.editando && st.fecha && !opciones.some((o) => o.iso === st.fecha))
    ? [{ etiqueta: 'Del parto', iso: st.fecha }].concat(opciones) : opciones;
  if (!delForm.some((o) => o.iso === st.fecha)) st.fecha = delForm[0].iso;

  $('cFecha').innerHTML = delForm.map((o) =>
    `<button type="button" class="chip fecha ${o.iso === st.fecha ? 'on' : ''}"
             data-chip="fecha" data-val="${o.iso}">${o.etiqueta}<span class="dia">${aDDMMAAAA(o.iso)}</span></button>`
  ).join('') +
    // Un admin corrigiendo puede poner cualquier fecha: la carga sigue siendo Hoy/Ayer.
    (st.editando && esAdmin()
      ? `<label class="chip fecha" id="chipOtraFecha" style="position:relative;cursor:pointer">
           Otra fecha<span class="dia">elegir</span>
           <input type="date" id="fOtraFecha" value="${st.fecha}" max="${opciones[0].iso}" aria-label="Fecha del parto"
                  style="position:absolute;inset:0;width:100%;height:100%;opacity:0;margin:0;padding:0;border:0">
         </label>` : '');

}

const esMuerto = () => SEXO_MUERTO.includes(String(st.sexo).charAt(0));
const esMellizo = () => SEXO_MELLIZO.includes(String(st.sexo).charAt(0));
const medio = (k) => { const n = numeros(k); return n.length ? n[Math.floor(n.length / 2)] : 0; };

/* ------------------------------------------------------------------ */
/* Pintado del formulario                                              */
/* ------------------------------------------------------------------ */

function chips(cont, clave, valores, sel, opciones) {
  const o = opciones || {};
  cont.innerHTML = (valores || []).map((v) => {
    const num = o.numerar && /^\d/.test(v) ? `<span class="n">${v.charAt(0)}</span>` : '';
    const txt = o.numerar && /^\d/.test(v) ? v.replace(/^\d+\s*/, '') : v;
    const clase = o.claseDe ? o.claseDe(v) : '';
    return `<button type="button" class="chip ${o.ancho ? 'wide' : ''} ${o.chico ? 'sm' : ''} ` +
           `${clase} ${v === sel ? 'on' : ''}" data-chip="${clave}" data-val="${v}">${num}${txt}</button>`;
  }).join('');
}

function opciones(sel, valores, elegido) {
  sel.innerHTML = (valores || []).map((v) =>
    `<option ${v === elegido ? 'selected' : ''}>${v}</option>`).join('');
}

function pintarFormulario() {
  pintarFechas();
  opciones($('fOperario'), listas.operario, $('fOperario').value);
  opciones($('fHora'), listas.hora_nacimiento, $('fHora').value || '07:00');

  const malo = (v) => /muert/i.test(v) ? 'bad' : (/cesarea|asistido/i.test(v) ? 'warn' : '');
  chips($('cTipo'), 'tipo_parto', listas.tipo_parto, st.tipo_parto, { numerar: true, claseDe: malo });
  chips($('cSexo'), 'sexo', listas.sexo, st.sexo, { numerar: true, claseDe: malo });
  chips($('cTambo'), 'tambo', listas.tambo, st.tambo, { ancho: true });

  pintarSteppers();
  pintarTerneros();
  pintarModoEdicion();
}

function pintarSteppers() {
  $('vLtsMadre').innerHTML = st.lts_madre === null ? '—' : `${st.lts_madre}<span>L</span>`;
  $('vBrix').innerHTML = st.cal.brixExc
    ? `<span style="font-size:15px;color:var(--warn)">${st.cal.brixExc}</span>`
    : `${st.cal.brix}<span>Brix</span>`;
  $('vMej').innerHTML = st.cal.mej === VACIO ? VACIO : `${st.cal.mej}<span>Brix</span>`;
}

/** La caja A: lo que produjo la madre. Una por parto, no una por cria. */
function pintarCalostroMadre() {
  const c = st.cal;
  pintarSteppers();

  // Sin el chip "Valor numerico", tocar de nuevo la excepcion activa es la
  // unica forma de volver a un numero desde el teclado; el stepper ya lo hace.
  chips($('cBrixExc'), 'brixExc', noNumeros('calidad_sin_mejorar'), c.brixExc,
        { ancho: true, claseDe: () => 'warn' });
  chips($('cMejorado'), 'mejorado', listas.mejorado, c.mejorado, { ancho: true });

  const sin = sinCalostro();
  $('cajaMejorado').classList.toggle('off', sin);
  $('cajaMej').classList.toggle('off', sin || c.mejorado !== 'Si');
  $('notaSinCalostro').classList.toggle('hidden', !sin);
}

/** "—" mientras no se pesó. Un numero puesto de oficio no se distingue de uno medido. */
const pesoTxt = (v) => (v === null || v === undefined || v === '' ? '—' : `${v}<span>kg</span>`);

function pintarTerneros() {
  const n = esMuerto() ? 0 : (esMellizo() ? 2 : 1);
  while (st.terneros.length < n) st.terneros.push(nuevoTernero());
  st.terneros.length = n;

  $('terneros').innerHTML = st.terneros.map((t, i) => `
    <div class="subcard ${t.vive ? '' : 'muerta'}" style="${i === 0 ? 'margin-top:0' : ''}">
      <h3><span class="dot"></span>${n > 1 ? 'Ternero ' + (i + 1) : 'Datos del ternero'}
        ${n > 1 ? `<span class="quien ${t.id_ternero ? '' : 'sin'}">${etiquetaCria(t, i)}</span>` : ''}</h3>
      <div class="grid g3">
        <label class="f">
          <div class="lab">ID Ternero</div>
          <input type="text" inputmode="numeric" placeholder="Nº de caravana"
                 value="${t.id_ternero}" data-ternero="${i}">
        </label>
        <label class="f">
          <div class="lab">Caravana SENASA <span class="req">*</span></div>
          <input type="text" inputmode="numeric" placeholder="6 dígitos" maxlength="6" pattern="[0-9]{6}"
                 value="${t.caravana_senasa || ''}" data-senasa="${i}">
        </label>
        <div>
          <div class="lab">Raza</div>
          <div class="chips" data-caja="raza:${i}"></div>
        </div>
        <div>
          <div class="lab">Peso</div>
          <div class="stepper">
            <button type="button" data-step="peso${i}:-1">−</button>
            <div class="val">${pesoTxt(t.peso)}</div>
            <button type="button" data-step="peso${i}:1">+</button>
          </div>
        </div>
      </div>
      ${n > 1 ? `
      <div class="grid ${sexoAmbiguo() ? 'g2' : ''}" style="margin-top:12px">
        ${sexoAmbiguo() ? `<div>
          <div class="lab">Sexo de esta cría <span class="req">*</span></div>
          <div class="chips" data-caja="sexoc:${i}"></div>
        </div>` : ''}
        <div>
          <div class="lab">¿Nació viva?</div>
          <div class="chips" data-caja="vive:${i}"></div>
        </div>
      </div>` : ''}
    </div>`).join('');

  st.terneros.forEach((t, i) => {
    caja('raza:' + i, listas.raza, t.raza, { ancho: true });
    if (n > 1) {
      // Con el codigo 2 (dos hembras) el sexo ya esta dicho: preguntarlo solo
      // abriria la puerta a marcar algo que contradiga el codigo del parto.
      if (sexoAmbiguo()) caja('sexoc:' + i, ['Hembra', 'Macho'], t.sexo || '', { ancho: true });
      caja('vive:' + i, ['Vivo', 'Muerto'], t.vive ? 'Vivo' : 'Muerto',
           { ancho: true, claseDe: (v) => (v === 'Muerto' ? 'bad' : '') });
    }
  });

  $('cardTernero').classList.toggle('off', esMuerto());
  $('cardCalostroMadre').classList.toggle('off', esMuerto());
  $('cardCalostroTernero').classList.toggle('off', esMuerto());
  $('notaMuerto').classList.toggle('hidden', !esMuerto());
  $('notaMellizo').classList.toggle('hidden', !esMellizo());
  pintarCalostroMadre();
  pintarCalostros();
}

/** La caja B: lo que tomo cada cria. Una ficha por cria viva. */
function pintarCalostros() {
  const vivas = st.terneros.map((t, i) => ({ t, i })).filter((x) => x.t.vive);

  $('calostros').innerHTML = vivas.map(({ t, i }) => {
    const c = t.cal;
    const otra = c.origen === ORIGEN_OTRA;
    return `
    <div class="subcard">
      <h3><span class="dot"></span>${st.terneros.length > 1 ? 'Ternero ' + (i + 1) : 'Calostro que tomó'}
        <span class="quien ${t.id_ternero ? '' : 'sin'}">${etiquetaCria(t, i)}</span></h3>
      <div class="lab">¿De quién tomó el calostro? <span class="req">*</span></div>
      <div class="chips" data-caja="origen:${i}"></div>
      <div class="grid g3" style="margin-top:14px">
        <label class="f">
          <div class="lab">ID vaca que dio el calostro</div>
          <input type="text" inputmode="numeric" placeholder="${otra ? 'Nº de vaca' : ''}"
                 class="${otra ? '' : 'leido'}" ${otra ? '' : 'readonly'}
                 value="${otra ? c.id_origen : ($('fVaca') ? $('fVaca').value : '')}"
                 data-origen="${i}">
          <div class="dato ${/sin datos|sin señal/.test(c.consulta) ? 'warn' : ''}">${
            otra ? c.consulta : 'Es la vaca que parió'}</div>
        </label>
        <label class="f">
          <div class="lab">Calidad del calostro que tomó <span class="req">*</span></div>
          <input type="text" inputmode="numeric" placeholder="Brix"
                 class="${otra ? '' : 'leido'}" ${otra ? '' : 'readonly'}
                 value="${otra ? c.brix : brixMadre()}" data-brixternero="${i}">
          <div class="dato">${otra ? 'Se completa solo con señal' : 'Sale de lo que produjo la madre'}</div>
        </label>
        <div>
          <div class="lab">Litros para el ternero</div>
          <div class="chips" data-caja="ltsTernero:${i}"></div>
        </div>
      </div>
    </div>`;
  }).join('') || '<p class="hint" style="margin:14px 0 0">Sin crías vivas: no se carga calostro.</p>';

  vivas.forEach(({ t, i }) => {
    caja('origen:' + i, [ORIGEN_PROPIA, ORIGEN_OTRA], t.cal.origen, { ancho: true });
    caja('ltsTernero:' + i, listas.lts_ternero, t.cal.lts_ternero, { chico: true });
  });
}

/* Con "Otra vaca" se consulta la planilla en vez de pedirle los Brix de memoria
   al operario. Nunca bloquea: sin señal el campo queda editable y el parto se
   guarda igual — un parto no puede depender de una consulta. */
const relojConsulta = {};
function consultarCalostro(i) {
  const c = st.terneros[i] && st.terneros[i].cal;
  if (!c) return;
  clearTimeout(relojConsulta[i]);
  const vaca = String(c.id_origen).trim();
  if (!vaca) { c.consulta = ''; return pintarCalostros(); }

  c.consulta = 'Buscando…';
  pintarCalostros();
  relojConsulta[i] = setTimeout(async () => {
    if (String(c.id_origen).trim() !== vaca) return;      // siguió tipeando
    if (!navigator.onLine || !sesion) {
      c.consulta = 'sin señal — cargá los Brix a mano';
      return pintarCalostros();
    }
    let r;
    try { r = await enviar({ accion: 'calostro', vaca }); }
    catch (e) { r = null; }
    if (String(c.id_origen).trim() !== vaca) return;

    if (r && r.ok && r.encontrada) {
      c.brix = String(r.brix_final);
      c.consulta = `${r.brix_final} Brix` + (r.fecha ? ` · parió el ${aDDMMAAAA(r.fecha)}` : '') +
                   (String(r.mejorado) === 'Si' ? ' · mejorado' : '');
    } else if (r && r.ok) {
      c.consulta = 'sin datos de esa vaca — cargá los Brix a mano';
    } else {
      c.consulta = 'sin señal — cargá los Brix a mano';
    }
    pintarCalostros();
  }, 600);
}

/** Pinta un grupo de chips dentro de su contenedor por clave. */
function caja(clave, valores, sel, opciones) {
  const cont = document.querySelector(`[data-caja="${clave}"]`);
  if (cont) chips(cont, clave, valores, sel, opciones);
}

/* ------------------------------------------------------------------ */
/* Interaccion                                                         */
/* ------------------------------------------------------------------ */

document.addEventListener('click', (e) => {
  const cu = e.target.closest('[data-cuenta]');
  if (cu) return accionCuenta(cu.dataset.cuenta);
  if (e.target.closest('#btnCuenta')) {
    return menuAbierto ? cerrarMenuCuenta() : abrirMenuCuenta();
  }
  // Tocar fuera lo cierra, pero sin cortar el resto de la interaccion.
  if (menuAbierto) cerrarMenuCuenta();

  const ed = e.target.closest('[data-editar]');
  if (ed) return abrirEdicion(ed.dataset.editar, ed.dataset.pesar === '1');
  const rc = e.target.closest('[data-rechazar]');
  if (rc) return rechazarParto(rc.dataset.rechazar);
  const er = e.target.closest('[data-editar-remoto]');
  if (er) return abrirEdicionRemota(er.dataset.editarRemoto);
  const ord = e.target.closest('[data-orden]');
  if (ord) {
    orden = { col: ord.dataset.orden, dir: orden.col === ord.dataset.orden ? -orden.dir : (ord.dataset.orden === 'fecha' ? -1 : 1) };
    return refrescar();
  }
  if (e.target.closest('#btnLimpiarFiltros')) {
    $('fBuscar').value = ''; $('fDesde').value = ''; $('fHasta').value = '';
    return refrescar();
  }
  const chip = e.target.closest('[data-chip]');
  if (chip) return elegirChip(chip);
  const step = e.target.closest('[data-step]');
  if (step) {
    // Con dedo o mouse ya actuo pointerdown; este click es el eco. Por teclado
    // (Enter/Espacio) no hay pointerdown, asi que ahi si hay que moverlo.
    if (veniaDePuntero) { veniaDePuntero = false; return; }
    return mover(step.dataset.step, step);
  }
  const tab = e.target.closest('.tab');
  if (tab) return ver(tab.dataset.v);
});

// Filtros de la tabla: filtran en memoria lo ya bajado.
document.addEventListener('input', (e) => { if (e.target && e.target.id === 'fBuscar') refrescar(); });
document.addEventListener('change', (e) => { if (e.target && (e.target.id === 'fDesde' || e.target.id === 'fHasta')) refrescar(); });

// "Otra fecha" (admin corrigiendo): la fecha del parto pasa a ser la elegida.
document.addEventListener('change', (e) => {
  if (!e.target || e.target.id !== 'fOtraFecha') return;
  const iso = e.target.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !st.editando || !esAdmin()) return;
  st.fecha = iso;
  pintarFechas();
  pintarModoEdicion();
});


function elegirChip(chip) {
  const clave = chip.dataset.chip;
  const val = chip.dataset.val;
  [...chip.parentElement.children].forEach((c) => c.classList.remove('on'));
  chip.classList.add('on');

  // Las claves con ":" son de una cria puntual (raza:0, brixExc:1, ...)
  if (clave.includes(':')) {
    const [campo, idx] = clave.split(':');
    const t = st.terneros[+idx];
    if (!t) return;
    const c = t.cal;

    if (campo === 'raza') { t.raza = val; return pintarCalostros(); }
    if (campo === 'sexoc') { t.sexo = val; return pintarTerneros(); }
    if (campo === 'vive') { t.vive = val === 'Vivo'; return pintarTerneros(); }
    if (campo === 'origen') {
      c.origen = val;
      // Volver a la propia madre borra lo consultado: ese dato era de otra vaca.
      if (val === ORIGEN_PROPIA) { c.id_origen = ''; c.brix = ''; c.consulta = ''; }
      return pintarCalostros();
    }
    if (campo === 'ltsTernero') { c.lts_ternero = val; return; }
    return;
  }

  if (clave === 'listaFecha') {
    listaFecha = val;
    refrescar();
    return bajarPartosDelDia(val);   // con LISTA_PENDIENTES no baja nada: es todo local
  }

  // Calostro de la madre: es del parto, no de ninguna cria.
  if (clave === 'brixExc') {
    // Sin el chip "Valor numerico", tocar la excepcion activa la apaga. Si no,
    // marcar "mastitis" sin querer no se podria deshacer mas que recargando.
    st.cal.brixExc = st.cal.brixExc === val ? '' : val;
    return pintarCalostroMadre();
  }
  if (clave === 'mejorado') {
    if (sinCalostro()) {
      pintarCalostroMadre();
      return avisar('Con calidad 0 no hay calostro que mejorar', true);
    }
    st.cal.mejorado = val;
    st.cal.mej = val === 'Si'
      ? (st.cal.mej === VACIO ? medio('calidad_mejorado') : st.cal.mej) : VACIO;
    pintarCalostroMadre();
    return pintarCalostros();               // cambia el Brix que toma la cria
  }

  st[clave] = val;
  if (clave === 'sexo') { pintarTerneros(); if (st.editando) pintarModoEdicion(); }
}

/**
 * Mueve un stepper. Si se le pasa el boton, escribe el numero directo en pantalla
 * en vez de repintar la tarjeta entera: repintar destruiria el boton que el
 * operario esta manteniendo apretado, y ademas parpadea feo al repetir rapido.
 */
function mover(spec, boton) {
  const [campo, pasoTxt] = spec.split(':');
  const paso = +pasoTxt;
  const celda = boton ? boton.parentElement.querySelector('.val') : null;
  const escribir = (html) => { celda.innerHTML = html; };

  if (campo.startsWith('peso')) {
    const t = st.terneros[+campo.slice(4)];
    // Sin pesar todavia: el primer toque arranca en el medio de la lista, igual
    // que los litros de la madre. A partir de ahi se mueve de a un kilo.
    //
    // No se repinta la tarjeta: destruiria el boton que el operario esta
    // manteniendo apretado, y la repeticion rapida seguiria escribiendo en un
    // elemento que ya no esta en pantalla.
    t.peso = t.peso === null ? medio('peso') : siguienteEnLista(t.peso, paso, numeros('peso'));
    return celda ? escribir(pesoTxt(t.peso)) : pintarTerneros();
  }
  if (campo === 'brix') {
    const c = st.cal;
    const antesExc = !!c.brixExc;
    const antesSin = sinCalostro();
    c.brixExc = '';                              // tocar el numero descarta la excepcion
    c.brix = siguienteEnLista(c.brix, paso, numeros('calidad_sin_mejorar'));
    // Sin calostro no hay nada que mejorar: se apaga solo.
    if (sinCalostro()) { c.mejorado = 'No'; c.mej = VACIO; }
    // Repintar solo cuando algo mas cambio de estado; si no, se destruiria el
    // boton que el operario esta manteniendo apretado.
    if (antesExc || antesSin !== sinCalostro() || !celda) {
      pintarCalostroMadre();
      return pintarCalostros();
    }
    escribir(`${c.brix}<span>Brix</span>`);
    return pintarCalostros();                    // el Brix del ternero lo sigue
  }
  if (campo === 'mej') {
    const c = st.cal;
    if (c.mejorado !== 'Si') return;
    c.mej = c.mej === VACIO ? medio('calidad_mejorado')
                            : siguienteEnLista(c.mej, paso, numeros('calidad_mejorado'));
    if (celda) escribir(`${c.mej}<span>Brix</span>`); else pintarCalostroMadre();
    return pintarCalostros();
  }
  if (campo === 'ltsMadre') {
    st.lts_madre = st.lts_madre === null ? medio('lts_madre')
                                         : siguienteEnLista(st.lts_madre, paso, numeros('lts_madre'));
  }
  pintarSteppers();
}

/* ---------- mantener apretado para avanzar rapido ---------- */

const REPETICION = { espera: 450, inicial: 300, minimo: 55, freno: 0.82 };
let relojRepeticion = null;
let veniaDePuntero = false;

function arrancarRepeticion(spec, boton) {
  frenarRepeticion();
  mover(spec, boton);                        // el primer paso es inmediato

  let intervalo = REPETICION.inicial;
  const seguir = () => {
    relojRepeticion = setTimeout(() => {
      mover(spec, boton);
      intervalo = Math.max(REPETICION.minimo, intervalo * REPETICION.freno);
      seguir();
    }, intervalo);
  };
  // Espera antes de arrancar: un toque normal no debe disparar la repeticion.
  relojRepeticion = setTimeout(seguir, REPETICION.espera);
}

function frenarRepeticion() {
  clearTimeout(relojRepeticion);
  relojRepeticion = null;
}

document.addEventListener('pointerdown', (e) => {
  const boton = e.target.closest('[data-step]');
  if (!boton) return;
  veniaDePuntero = true;                     // que el click no repita el paso
  arrancarRepeticion(boton.dataset.step, boton);
});

// En window, no en el boton: al repintar, el boton apretado puede dejar de
// existir y su pointerup nunca llegaria — la repeticion quedaria corriendo sola.
['pointerup', 'pointercancel', 'blur'].forEach((ev) =>
  addEventListener(ev, frenarRepeticion));
addEventListener('visibilitychange', frenarRepeticion);

/**
 * Mueve un stepper UN LUGAR sobre la lista de Maestro, en vez de sumar 1 y
 * recortar contra el minimo y el maximo.
 *
 * Con una lista no contigua —0 y despues 18 a 35— la aritmetica producia 17,
 * 16, 15... valores que no estan en Maestro y que el backend rechaza: el
 * operario cargaba un parto que despues aparecia en "Revisar" sin que nada en
 * la tablet le hubiera avisado. Por indice, cualquier lista con huecos que
 * Nahuel escriba a futuro funciona sola.
 */
function siguienteEnLista(actual, paso, lista) {
  if (!lista.length) return actual;
  const orden = lista.slice().sort((a, b) => a - b);
  const n = Number(actual);
  let i = orden.indexOf(n);
  if (i === -1) {
    // El valor no esta en la lista: viene de un parto viejo, o de Maestro
    // editado. Se arranca del mas cercano.
    i = orden.reduce((mejor, v, j) =>
      Math.abs(v - n) < Math.abs(orden[mejor] - n) ? j : mejor, 0);
    // Si el mas cercano ya esta del lado hacia el que se iba, ese es el paso.
    if ((paso > 0 && orden[i] > n) || (paso < 0 && orden[i] < n)) return orden[i];
  }
  return orden[Math.min(Math.max(i + paso, 0), orden.length - 1)];
}

document.addEventListener('input', (e) => {
  const t = e.target.closest('[data-ternero]');
  if (t) {
    st.terneros[+t.dataset.ternero].id_ternero = t.value;
    // El rotulo de la ficha de calostro se actualiza al tipear la caravana.
    if (st.terneros.length > 1) pintarCalostros();
    return;
  }
  const sn = e.target.closest('[data-senasa]');
  if (sn) {
    sn.value = sn.value.replace(/\D/g, '').slice(0, 6);      // solo digitos, 6 como mucho
    st.terneros[+sn.dataset.senasa].caravana_senasa = sn.value;
    return;
  }
  const o = e.target.closest('[data-origen]');
  if (o) {
    const i = +o.dataset.origen;
    st.terneros[i].cal.id_origen = o.value;
    return consultarCalostro(i);
  }
  const b = e.target.closest('[data-brixternero]');
  if (b) st.terneros[+b.dataset.brixternero].cal.brix = b.value.trim();
});

/* ------------------------------------------------------------------ */
/* Guardar                                                             */
/* ------------------------------------------------------------------ */

const nuevoUuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : Date.now() + '-' + Math.random().toString(16).slice(2));

function armarPayload() {
  const p = {
    uuid: nuevoUuid(),
    dispositivo: cfg.dispositivo,
    cargado_en: new Date().toISOString(),
    operario: $('fOperario').value,
    id_vaca: $('fVaca').value.trim(),
    fecha_parto: st.fecha,
    hora_nacimiento: $('fHora').value,
    tipo_parto: st.tipo_parto,
    sexo: st.sexo,
    terneros: [],
    tambo: st.tambo,
    notas: $('fNotas').value.trim(),
    // Version del payload: desde 2 la caravana SENASA es obligatoria. Un
    // backend viejo lo ignora; el nuevo deja pasar sin caravana solo a las
    // colas anteriores, que no traen este numero.
    formato: 2
  };

  if (!esMuerto()) {
    p.lts_madre = String(st.lts_madre);           // del parto, no de la cria
    // Lo que produjo la madre: una vaca, un calostro.
    p.calostro = {
      calidad_sin_mejorar: st.cal.brixExc || String(st.cal.brix),
      mejorado: st.cal.mejorado,
      calidad_mejorado: st.cal.mejorado === 'Si' ? String(st.cal.mej) : VACIO
    };
    p.terneros = st.terneros.map((t) => {
      const cria = {
        id_ternero: String(t.id_ternero).trim(),
        caravana_senasa: String(t.caravana_senasa || '').trim(),
        raza: t.raza,
        sexo: t.sexo || SEXO_POR_CODIGO[String(st.sexo).charAt(0)] || '',
        vive: t.vive
      };
      // Sin pesar: el peso no viaja y la columna I queda vacia. Mandar '' o 0
      // seria inventar un dato que nadie midio.
      if (t.peso !== null) cria.peso = t.peso;
      if (t.vive) cria.calostro = calostroDeLaCria(t.cal);
      return cria;
    });
  }
  return p;
}

/* Con 'Propia madre' ni el ID ni los Brix se le piden al operario: salen del
   parto. Dejarlos escribibles abriria la puerta a marcar como propio un
   calostro que en la planilla figura de otra vaca. */
function calostroDeLaCria(c) {
  const otra = c.origen === ORIGEN_OTRA;
  return {
    origen: c.origen,
    id_vaca_origen: otra ? String(c.id_origen).trim() : $('fVaca').value.trim(),
    calidad_ternero: otra ? String(c.brix).trim() : brixMadre(),
    lts_ternero: c.lts_ternero
  };
}

function faltantes(p) {
  const f = [];
  if (!p.operario) f.push('operario');
  if (!p.id_vaca) f.push('ID de vaca');
  if (!p.fecha_parto) f.push('fecha');
  if (!p.tipo_parto) f.push('tipo de parto');
  if (!p.sexo) f.push('sexo');
  if (!esMuerto()) {
    if (st.lts_madre === null) f.push('litros de la madre');
    if (st.cal.brix === null && !st.cal.brixExc) f.push('calidad del calostro de la madre');
    if (st.cal.mejorado === 'Si' && (st.cal.mej === VACIO || !st.cal.mej)) {
      f.push('calidad del calostro mejorado');
    }
    const varias = st.terneros.length > 1;
    st.terneros.forEach((t, i) => {
      const cual = varias ? ` (ternero ${i + 1})` : '';
      if (!t.vive) return;                       // cria muerta: no lleva datos
      if (!String(t.id_ternero).trim()) f.push('ID de ternero' + cual);
      if (!/^\d{6}$/.test(String(t.caravana_senasa || '').trim())) f.push('caravana SENASA de 6 dígitos' + cual);
      if (sexoAmbiguo() && !t.sexo) f.push('sexo' + cual);
      if (!t.cal.lts_ternero) f.push('litros para el ternero' + cual);
      if (t.cal.origen === ORIGEN_OTRA) {
        if (!String(t.cal.id_origen).trim()) f.push('de qué vaca salió el calostro' + cual);
        // Sin señal la consulta no completa nada, pero el dato sigue haciendo
        // falta: se carga a mano y el parto entra igual.
        if (!String(t.cal.brix).trim()) f.push('los Brix del calostro que tomó' + cual);
      }
    });
    if (st.terneros.length && st.terneros.every((t) => !t.vive)) {
      f.push('al menos una cría viva, o cambiá el código del parto');
    }
  }
  if (!p.tambo) f.push('tambo');
  return f;
}

/**
 * El codigo del parto y el sexo de las crias tienen que decir lo mismo.
 * El 8 es M+M o M+H: dos hembras corresponden al codigo 2. Sin esto entran
 * filas contradictorias que despues nadie sabe como interpretar.
 */
function coherenciaSexo() {
  if (esMuerto() || st.terneros.length < 2 || !sexoAmbiguo()) return '';
  if (st.terneros.every((t) => t.sexo === 'Hembra')) {
    return 'Dos hembras es el código «2 Hembras Gemelas Vivas». El 8 es M+M o M+H.';
  }
  return '';
}


async function guardarParto() {
  const p = armarPayload();
  const faltan = faltantes(p);
  if (faltan.length) {
    return avisar('Falta: ' + faltan.join(', '), true);
  }
  const incoherencia = coherenciaSexo();
  if (incoherencia) return avisar(incoherencia, true);

  await guardarLocal({
    uuid: p.uuid, estado: 'pendiente', intentos: 0, error: '',
    creado: Date.now(), payload: p
  });

  mostrarExito(p);          // antes de limpiar: el resumen sale del parto recien guardado
  limpiar();
  await refrescar();
  sincronizar();
}

/* ------------------------------------------------------------------ */
/* Corregir un parto del dia                                           */
/* ------------------------------------------------------------------ */

/* Se corrige en el MISMO formulario con el que se cargo, no en una pantalla
   aparte: el operario ya sabe donde esta cada cosa, y no hay una segunda copia
   de los chips y los steppers que pueda quedar desincronizada de la primera.
   Lo que no se corrige queda a la vista pero bloqueado, para que se pueda
   confirmar que es el parto buscado sin poder cambiarle la identidad.

   El codigo de sexo SI se corrige, desde r6: es el error tipico (macho por
   hembra, un mellizo que no se vio) y mandarlo a la planilla significaba que
   nadie lo arreglara. Pero dice cuantas crias tiene el parto, asi que va por
   su propia accion en el backend y puede agregar o anular un renglon.

   ID de ternero y raza se desbloquean SOLO cuando el sexo cambio: no se puede
   agregar una cria sin darle una caravana. Hora y tipo de parto siguen
   afuera: los corrige Nahuel en la planilla. */

const BLOQUEADO_AL_EDITAR = ['cFecha', 'cTipo', 'fVaca', 'fHora', 'fNotas'];

/** El codigo de sexo cambio respecto de como estaba guardado el parto. */
const sexoCambio = () => !!st.editando && st.sexo !== st.sexoOriginal;

/** Pasa un parto guardado al estado del formulario. Es el inverso de armarPayload. */
function aEstado(p) {
  st.editando = p.uuid;
  st.fecha = p.fecha_parto;
  st.tipo_parto = p.tipo_parto;
  st.sexo = p.sexo;
  st.sexoOriginal = p.sexo;
  st.tambo = p.tambo || '';
  st.lts_madre = p.lts_madre === undefined || p.lts_madre === '' ? null : +p.lts_madre;

  /* El calostro de la madre viaja arriba desde r6. En un parto guardado antes
     del deploy viene adentro de la primera cria: la tablet puede tener partos
     viejos en IndexedDB cuando se publica el service worker nuevo, y abrirlos
     con el formulario nuevo no puede perder lo que ya se habia cargado. */
  const m = (p.calostro && p.calostro.calidad_sin_mejorar !== undefined) ? p.calostro
    : (((p.terneros || []).find((t) => t.vive !== false) || {}).calostro || {});
  // calidad_sin_mejorar guarda un numero de Brix o una excepcion ('mastitis',
  // 'sangre', 'campo'). Se separan de nuevo por la forma del valor.
  const esNumero = /^\d+$/.test(String(m.calidad_sin_mejorar || ''));
  st.cal = {
    brix: esNumero ? +m.calidad_sin_mejorar : medio('calidad_sin_mejorar'),
    brixExc: esNumero ? '' : (m.calidad_sin_mejorar || ''),
    mejorado: m.mejorado || 'No',
    mej: !m.calidad_mejorado || m.calidad_mejorado === VACIO ? VACIO : +m.calidad_mejorado
  };

  st.terneros = (p.terneros || []).map((t) => {
    const c = t.calostro || {};
    // Formato viejo: solo estaba el ID de la vaca origen. Si no es la que pario,
    // el calostro era de otra.
    const origen = c.origen ||
      (c.id_vaca_origen && String(c.id_vaca_origen) !== String(p.id_vaca)
        ? ORIGEN_OTRA : ORIGEN_PROPIA);
    return {
      id_ternero: t.id_ternero || '',
      caravana_senasa: t.caravana_senasa && String(t.caravana_senasa) !== VACIO ? String(t.caravana_senasa) : '',
      raza: t.raza || (listas.raza || [''])[0],
      peso: t.peso === undefined || t.peso === '' ? null : +t.peso,
      sexo: t.sexo || '',
      vive: t.vive !== false,
      cal: {
        origen: origen,
        id_origen: origen === ORIGEN_OTRA ? (c.id_vaca_origen || '') : '',
        brix: origen === ORIGEN_OTRA ? String(c.calidad_ternero || '') : '',
        consulta: '',
        lts_ternero: String(c.lts_ternero === undefined ? medio('lts_ternero') : c.lts_ternero)
      }
    };
  });

  $('fVaca').value = p.id_vaca || '';
  $('fNotas').value = p.notas || '';
  opciones($('fOperario'), listas.operario, p.operario);
  opciones($('fHora'), listas.hora_nacimiento, p.hora_nacimiento);
}

/* Admin: corregir un parto que esta en la planilla pero no en esta tablet. Se
   baja completo (accion=parto) y se guarda como registro local "sombra": desde
   ahi la correccion viaja por la misma cola que cualquier otra. */
async function abrirEdicionRemota(uuid) {
  if (!esAdmin()) return;
  if ((await todosLocal()).some((r) => r.uuid === uuid)) return abrirEdicion(uuid, false);
  if (!navigator.onLine) return avisar('Sin señal: ese parto está en la planilla, no en esta tablet', true);
  let j;
  try { j = await enviar({ accion: 'parto', uuid }); } catch (e) { j = null; }
  if (!j || !j.ok || !j.parto) return avisar('No se pudo traer el parto: ' + ((j && j.error) || 'sin respuesta'), true);
  const p = j.parto;
  await guardarLocal({
    uuid, estado: 'ok', intentos: 0, error: '', sombra: true,
    creado: Date.parse(p.cargado_en) || Date.now(),
    payload: p
  });
  return abrirEdicion(uuid, false);
}

async function abrirEdicion(uuid, focoPeso) {
  const reg = (await todosLocal()).find((r) => r.uuid === uuid);
  if (!reg) return avisar('Ese parto ya no está en la tablet', true);

  aEstado(reg.payload);
  pintarFormulario();
  ver('form');
  $('body').scrollTop = 0;

  if (focoPeso) {
    // Pesar es el motivo mas comun para volver a abrir un parto: se lleva
    // directo al bloque del ternero en vez de dejarlo buscar.
    const card = $('cardTernero');
    if (card) card.scrollIntoView({ block: 'center' });
  }
}

/* Rechazar un parto. Solo admin. Tres casos, y en los tres la fila desaparece
   de la tablet:
   - Todavia no entro a la planilla (pendiente o rechazado): se borra de la tablet.
   - Ya esta en la planilla (local o de otra tablet): el backend lo ANULA
     (Anulada = Si), no lo borra: deja de contar, de listarse y de ir a DC, y
     queda en _log quien lo rechazo. Borrar filas es lo que dejaba fantasmas.
   - Tenia una correccion sin subir: se anula igual; la correccion se descarta. */
async function rechazarParto(uuid) {
  if (!esAdmin()) return;
  const reg = (await todosLocal()).find((r) => r.uuid === uuid);
  const remoto = !reg ? (partosRemotos(LISTA_TODOS).find((f) => f[0].uuid === uuid) || [null])[0] : null;
  if (!reg && !remoto) return avisar('Ese parto ya no está', true);
  const vaca = reg ? reg.payload.id_vaca : remoto.id_vaca;
  const fecha = aDDMMAAAA((reg ? reg.payload.fecha_parto : remoto.fecha) || '');

  if (reg && reg.estado !== 'ok') {
    // Nunca entro a la planilla: rechazarlo es borrarlo de la tablet.
    const ok = await confirmar('Rechazar este parto',
      `El parto de la vaca <b>${vaca}</b> del ${fecha} <b>nunca entró a la planilla</b>
       (${reg.estado === 'error' ? 'la planilla lo rechazó' : 'está esperando subir'}${reg.error ? ': ' + reg.error : ''}).
       Se borra de esta tablet y no se recupera. Si hace falta, se carga de nuevo.`, 'Sí, rechazar');
    if (!ok) return;
    await borrarLocal(uuid);
    await refrescar();
    return avisar('Parto rechazado: se borró de la tablet');
  }

  if (!navigator.onLine) return avisar('Sin señal: rechazar un parto necesita conexión con la planilla', true);
  const ok = await confirmar('Rechazar este parto',
    `El parto de la vaca <b>${vaca}</b> del ${fecha} se <b>anula en la planilla</b>: deja de contar,
     desaparece de esta lista y no va a DairyComp. Queda registrado que lo rechazaste vos.
     ${reg && (reg.edicion || reg.cambioSexo) ? 'La corrección pendiente se descarta.' : ''}
     No se deshace desde la app.`, 'Sí, rechazar');
  if (!ok) return;

  let j;
  try { j = await enviar({ accion: 'anular_parto', uuid }); } catch (e) { j = null; }
  if (!j || !j.ok) {
    if (j && /no existe el parto/i.test(j.error || '')) {
      // Ya no esta en la planilla: la copia local es un fantasma, se va.
      if (reg) await borrarLocal(uuid);
      await bajarPartosDelDia(LISTA_TODOS);
      return avisar('Ese parto ya no estaba en la planilla: se sacó de la tablet');
    }
    return avisar('No se pudo rechazar: ' + ((j && j.error) || 'sin respuesta'), true);
  }
  if (reg) await borrarLocal(uuid);
  await bajarPartosDelDia(LISTA_TODOS);
  avisar(j.ya_estaba ? 'Ese parto ya estaba anulado' : 'Parto rechazado: anulado en la planilla');
}

function cancelarEdicion() {
  st.editando = null;
  limpiar();
  ver('list');
}

/** Bloquea lo que no se corrige y cambia el cartel de arriba. */
function pintarModoEdicion() {
  const editando = !!st.editando;
  const aviso = $('avisoEdicion');

  // Un admin cambia cualquier campo, identidad incluida. El operario, no.
  const bloquear = editando && !esAdmin();
  BLOQUEADO_AL_EDITAR.forEach((id) => {
    const el = $(id);
    if (el) el.classList.toggle('bloqueado', bloquear);
  });
  // ID y raza identifican al animal, asi que normalmente no se tocan. Pero si
  // el sexo cambio puede haber una cria nueva, y una cria sin caravana no sirve.
  document.querySelectorAll('#terneros [data-ternero], #terneros [data-caja^="raza:"]')
    .forEach((el) => el.classList.toggle('bloqueado', bloquear && !sexoCambio()));

  aviso.classList.toggle('hidden', !editando);
  if (!editando) return;

  aviso.innerHTML =
    `Corrigiendo el parto de la vaca <b>${$('fVaca').value}</b> · ${aDDMMAAAA(st.fecha)}.` +
    (sexoCambio()
      ? ` Cambiaste el <b>código de sexo</b>: se va a reescribir el parto entero,
         así que revisá los datos de cada cría.`
      : esAdmin()
      ? ` Como <b>admin</b> podés cambiar cualquier campo, incluidos vaca, fecha, hora,
         tipo, operario, caravanas y notas. Queda registrado en la planilla quién lo cambió.`
      : ` Se pueden cambiar <b>sexo, peso, calostro y tambo</b>;
         el resto lo corrige Nahuel en la planilla.`) +
    `<button class="btn" type="button" id="btnCancelarEd">Cancelar</button>`;
  $('btnCancelarEd').onclick = cancelarEdicion;
}

/** Lo que se manda al backend: el parto entero, que del otro lado se compara. */
/** Identidad del parto y de cada cria: solo la manda (y la aplica) un admin. */
function identidadAdmin() {
  return {
    fecha_parto: st.fecha,
    hora_nacimiento: $('fHora').value,
    tipo_parto: st.tipo_parto,
    notas: $('fNotas').value.trim()
  };
}

function armarEdicion() {
  return Object.assign(esAdmin() ? identidadAdmin() : {}, {
    accion: 'editar',
    uuid: st.editando,
    operario: $('fOperario').value,
    tambo: st.tambo,
    lts_madre: st.lts_madre === null ? undefined : String(st.lts_madre),
    id_vaca: $('fVaca').value.trim(),
    // El calostro de la madre es del parto: va una vez, no una por cria.
    calostro: {
      calidad_sin_mejorar: st.cal.brixExc || String(st.cal.brix),
      mejorado: st.cal.mejorado,
      calidad_mejorado: st.cal.mejorado === 'Si' ? String(st.cal.mej) : VACIO
    },
    terneros: st.terneros.map((t) => {
      if (!t.vive) return {};                      // cria muerta: no lleva nada
      const cria = { calostro: calostroDeLaCria(t.cal) };
      if (t.peso !== null) cria.peso = t.peso;
      // La caravana va siempre: un parto viejo sin ella se completa asi.
      if (String(t.caravana_senasa || '').trim()) cria.caravana_senasa = String(t.caravana_senasa).trim();
      if (esAdmin()) { cria.id_ternero = t.id_ternero; cria.raza = t.raza; }
      return cria;
    })
  });
}

/**
 * Se valida acá con las mismas reglas que aplica el backend. No es por
 * desconfianza del servidor: es para que el operario vea el problema mientras
 * tiene el animal delante, en vez de enterarse cuando vuelva la señal.
 */
function faltantesEdicion(reg) {
  const f = [];
  const autor = reg.payload.operario;
  const quien = $('fOperario').value;

  st.terneros.forEach((t, i) => {
    if (!t.vive) return;
    const cual = st.terneros.length > 1 ? ` (ternero ${i + 1})` : '';
    const pesoAntes = reg.payload.terneros[i] ? reg.payload.terneros[i].peso : undefined;
    const cambiaPeso = t.peso !== null && String(t.peso) !== String(pesoAntes);
    if (cambiaPeso && quien !== autor && !esAdmin()) {
      f.push(`el peso lo carga ${autor}, que fue quien cargó el parto`);
    }
    if (!t.cal.lts_ternero) f.push('litros para el ternero' + cual);
    if (t.cal.origen === ORIGEN_OTRA) {
      if (!String(t.cal.id_origen).trim()) f.push('de qué vaca salió el calostro' + cual);
      if (!String(t.cal.brix).trim()) f.push('los Brix del calostro que tomó' + cual);
    }
  });
  if (st.terneros.some((t) => t.vive)) {
    if (st.lts_madre === null) f.push('litros de la madre');
    if (st.cal.brix === null && !st.cal.brixExc) f.push('calidad del calostro de la madre');
    if (st.cal.mejorado === 'Si' && (st.cal.mej === VACIO || !st.cal.mej)) {
      f.push('calidad del calostro mejorado');
    }
  }
  if (!st.tambo) f.push('tambo');
  return f;
}

/* Cambiar el sexo reescribe el parto entero, asi que se valida con las reglas
   del ALTA, no con las de la correccion: puede haber una cria nueva que todavia
   no tiene ni caravana. */
async function guardarCambioSexo(reg) {
  const p = armarPayload();
  const faltan = faltantes(p);
  if (faltan.length) return avisar('Falta: ' + faltan.join(', '), true);
  const incoherencia = coherenciaSexo();
  if (incoherencia) return avisar(incoherencia, true);

  const antes = (reg.payload.terneros || []).length;
  const ahora = (p.terneros || []).length;
  if (ahora < antes) {
    // Se anula, no se borra. Pero se dice cual, con la caravana: esto se hace
    // con el animal delante y equivocarse de cria no se ve hasta mucho despues.
    const sobran = (reg.payload.terneros || []).slice(ahora)
      .map((t) => t.id_ternero || 'sin ID').join(', ');
    const ok = await confirmar('Se va a anular una cría',
      `El parto pasa de <b>${antes}</b> a <b>${ahora}</b> cría${ahora > 1 ? 's' : ''}.
       El renglón de <b>${sobran}</b> queda anulado en la planilla; no se borra,
       pero deja de contar y de ir a DairyComp.`, 'Sí, anular');
    if (!ok) return;
  }

  // El parto local queda como va a quedar la planilla.
  p.uuid = reg.uuid;
  p.cargado_en = reg.payload.cargado_en;
  p.dispositivo = reg.payload.dispositivo;

  if (reg.estado === 'pendiente' || reg.estado === 'error') {
    // Todavia no entro a la planilla: no hay nada que reestructurar del otro
    // lado, sube ya corregido.
    reg.payload = p;
    reg.estado = 'pendiente';
    reg.cambioSexo = null;
  } else {
    reg.payload = p;
    reg.cambioSexo = Object.assign(esAdmin() ? Object.assign(identidadAdmin(), { id_vaca: p.id_vaca }) : {}, {
      accion: 'cambiar_sexo',
      uuid: reg.uuid,
      op_uuid: nuevoUuid(),          // idempotencia de ESTA operacion
      operario: p.operario,
      sexo: p.sexo,
      lts_madre: p.lts_madre,
      calostro: p.calostro,
      tambo: p.tambo,
      terneros: p.terneros
    });
    reg.edicion = null;              // el cambio de sexo la subsume
  }
  reg.error = '';
  reg.revisarEdicion = false;

  await guardarLocal(reg);
  st.editando = null;
  limpiar();
  ver('list');
  await refrescar();
  sincronizar();
  avisar('Parto corregido');
}

async function guardarEdicion() {
  const reg = (await todosLocal()).find((r) => r.uuid === st.editando);
  if (!reg) return avisar('Ese parto ya no está en la tablet', true);

  if (sexoCambio()) return guardarCambioSexo(reg);

  const faltan = faltantesEdicion(reg);
  if (faltan.length) return avisar('Falta: ' + faltan.join(', '), true);

  const edicion = armarEdicion();

  if (reg.estado === 'pendiente' || reg.estado === 'error') {
    // Todavia no entro a la planilla: se corrige el payload y sube ya corregido.
    // Mandar una edicion de algo que no existe seria pedirle al backend que
    // arregle una fila que nunca escribio.
    aplicarEnPayload(reg.payload, edicion);
    reg.estado = 'pendiente';
    reg.error = '';
  } else {
    // Ya esta en la planilla: la correccion viaja aparte, con su propia cola.
    aplicarEnPayload(reg.payload, edicion);
    reg.edicion = edicion;
    reg.error = '';
  }

  await guardarLocal(reg);
  st.editando = null;
  limpiar();
  ver('list');
  await refrescar();
  sincronizar();
  avisar('Corrección guardada');
}

/** Deja el parto local igual a como va a quedar la planilla. */
function aplicarEnPayload(p, ed) {
  if (esAdmin()) {
    // La identidad la manda solo el admin; la copia local la sigue.
    ['operario', 'id_vaca', 'fecha_parto', 'hora_nacimiento', 'tipo_parto', 'notas'].forEach((k) => {
      if (ed[k] !== undefined) p[k] = ed[k];
    });
  }
  if (ed.tambo !== undefined) p.tambo = ed.tambo;
  if (ed.lts_madre !== undefined) p.lts_madre = ed.lts_madre;
  if (ed.calostro) p.calostro = Object.assign({}, p.calostro, ed.calostro);
  (ed.terneros || []).forEach((t, i) => {
    const destino = p.terneros[i];
    if (!destino || !t.calostro) return;
    if (t.peso !== undefined) destino.peso = t.peso;
    if (t.caravana_senasa !== undefined) destino.caravana_senasa = t.caravana_senasa;
    if (t.id_ternero !== undefined) destino.id_ternero = t.id_ternero;
    if (t.raza !== undefined) destino.raza = t.raza;
    destino.calostro = Object.assign({}, destino.calostro, t.calostro);
  });
}

/** Un parto tiene algo por pesar si alguna cria viva no tiene peso. */
const faltaPesar = (p) =>
  (p.terneros || []).some((t) => t.vive !== false && t.peso === undefined);

/* ------------------------------------------------------------------ */
/* Cartel de confirmacion                                              */
/* ------------------------------------------------------------------ */

/**
 * Un aviso que se desvanece se puede perder de vista con la tablet en la mano.
 * Este cartel obliga a un toque, asi el operario confirma que el parto entro
 * y ve exactamente que quedo registrado.
 */
function mostrarExito(p) {
  const crias = (p.terneros || []).map((t) => {
    if (t.vive === false) return `${t.sexo || 'cría'} — nació muerta`;
    const partes = [t.id_ternero || 'sin ID'];
    if (t.sexo) partes.push(t.sexo);
    partes.push(t.peso === undefined ? 'falta pesar' : `${t.peso} kg`);
    return partes.join(' · ');
  });

  $('okDetalle').innerHTML =
    `Vaca <b>${p.id_vaca}</b> · ${aDDMMAAAA(p.fecha_parto)} · ${p.hora_nacimiento}` +
    (crias.length ? '<br>' + crias.map((c) => `<b>${c}</b>`).join('<br>')
                  : '<br><b>Sin cría viva</b>');

  // Nunca dice "sincronizado": este cartel se muestra ANTES de que el parto
  // salga a la red, asi que no puede saberlo. El estado real lo dicen el badge
  // y la lista del dia, que si lo saben.
  const enEspera = !navigator.onLine || sesionVencida;
  const est = $('okEstado');
  est.className = 'estado' + (enEspera ? ' espera' : '');
  est.textContent = enEspera
    ? 'Guardado en la tablet — se sincroniza al volver la señal'
    : 'Guardado en la tablet — sincronizando';

  $('modalOk').classList.remove('hidden');
  $('btnOtroParto').focus();
}

/* Un paso irreversible con la tablet en la mano necesita un freno explicito.
   Nada de confirm(): un dialogo nativo bloquea la app entera. */
function confirmar(titulo, detalle, textoSi) {
  return new Promise((ok) => {
    $('confTitulo').textContent = titulo;
    $('confDetalle').innerHTML = detalle;
    $('btnConfSi').textContent = textoSi || 'Sí';
    $('modalConf').classList.remove('hidden');
    const cerrar = (v) => { $('modalConf').classList.add('hidden'); ok(v); };
    $('btnConfSi').onclick = () => cerrar(true);
    $('btnConfNo').onclick = () => cerrar(false);
    $('btnConfNo').focus();
  });
}

function cerrarExito() {
  $('modalOk').classList.add('hidden');
  $('fVaca').focus();
}

$('btnOtroParto').onclick = cerrarExito;
// Tocar fuera de la caja tambien cierra; adentro, no.
$('modalOk').addEventListener('click', (e) => { if (e.target === $('modalOk')) cerrarExito(); });
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modalOk').classList.contains('hidden')) cerrarExito();
});

function limpiar() {
  st.editando = null;
  $('fVaca').value = '';
  $('fNotas').value = '';
  st.cal = nuevoCalostroMadre();
  st.terneros = st.terneros.map(() => nuevoTernero());
  pintarFormulario();
  $('body').scrollTop = 0;
  $('fVaca').focus();
}

/* ------------------------------------------------------------------ */
/* Sincronizacion                                                      */
/* ------------------------------------------------------------------ */

let sincronizando = false;
let relojSync = null;

/* El WiFi del campo puede estar "presente pero muerto" (AP sin salida, portal
   cautivo): ahi fetch no falla, se cuelga. Sin corte, el badge se queda en
   "Sincronizando..." para siempre y el reloj de 30 s no vuelve a entrar. */
const ESPERA_RED = 20000;
const ESPERA_TANDA = 60000;

/**
 * El ID token se adjunta en el momento de enviar, no al guardar: un parto que
 * estuvo dos dias en la cola no puede llevar una credencial vencida.
 */
async function enviar(payload) {
  const corte = new AbortController();
  const reloj = setTimeout(() => corte.abort(), ESPERA_RED);
  try {
    // text/plain = "simple request": no dispara el preflight OPTIONS,
    // que Apps Script no sabe responder.
    const r = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      // Van las dos credenciales: el backend prefiere la propia (30 dias) y cae
      // al id_token de Google si esa no sirve. Un backend viejo ignora la propia.
      body: JSON.stringify(Object.assign({ id_token: idToken.valor,
                                           sesion_token: (sesion && sesion.token) || '' }, payload)),
      redirect: 'follow',
      signal: corte.signal
    });
    const j = await r.json();
    guardarCredencial(j);
    return j;
  } finally {
    clearTimeout(reloj);
  }
}

/* Un parto rechazado por validacion no se arregla reintentando solo... salvo
   que si: casi siempre es un valor que falta en Maestro, y en cuanto Nahuel lo
   agrega el mismo parto entra. Se reintenta espaciado y con tope, en vez de
   dejarlo muerto para siempre. */
const REINTENTO_ERROR = 10 * 60000;
const MAX_REINTENTOS_ERROR = 5;
const reintentable = (reg) =>
  (reg.reintentos || 0) < MAX_REINTENTOS_ERROR &&
  Date.now() - (reg.ultimoIntento || 0) > REINTENTO_ERROR;

async function sincronizar() {
  if (sincronizando || !cfg.url || !sesion || !navigator.onLine) return;
  sincronizando = true;
  clearTimeout(relojSync);
  relojSync = setTimeout(() => { sincronizando = false; pintarBadge(); }, ESPERA_TANDA);
  pintarBadge();
  try {
    // Un parto puede deber dos cosas: entrar a la planilla, o una correccion
    // sobre lo que ya entro. Se hacen en orden de carga, y la correccion nunca
    // antes que el alta: no se puede corregir una fila que todavia no existe.
    const tareas = [];
    (await todosLocal()).sort((a, b) => a.creado - b.creado).forEach((reg) => {
      if (reg.estado === 'pendiente') tareas.push({ reg, tipo: 'alta' });
      else if (reg.estado === 'error' && reintentable(reg)) tareas.push({ reg, tipo: 'alta' });
      // El cambio de sexo va antes que la correccion: reestructura el parto.
      else if (reg.estado === 'ok' && reg.cambioSexo) tareas.push({ reg, tipo: 'sexo' });
      else if (reg.estado === 'ok' && reg.edicion) tareas.push({ reg, tipo: 'editar' });
    });
    if (!tareas.length) { sesionVencida = false; fallosToken = 0; return; }

    // Con la credencial propia vigente no hace falta Google. Sin ella (sesion
    // anterior al backend r7) se pide el id_token y, si sirve, se aprovecha
    // para conseguir la credencial sin obligar a nadie a volver a entrar.
    if (!sesionSirve()) {
      // Sin credencial vigente no se intenta: los partos quedan en la cola,
      // intactos. Pero un fallo suelto del prompt de Google no es una sesion
      // caida — se avisa recien al tercero seguido.
      if (!(await tokenVigente())) {
        if (++fallosToken >= FALLOS_PARA_AVISAR) sesionVencida = true;
        return;
      }
      try { await enviar({ accion: 'sesion' }); } catch (e) { /* se sigue con el id_token */ }
    }
    fallosToken = 0;
    sesionVencida = false;

    // Errores de servidor seguidos en esta tanda. Uno solo es de ESE registro y
    // no tiene por que frenar a los demas; tres seguidos es el servidor caido.
    let erroresSeguidos = 0;

    for (const { reg, tipo } of tareas) {
      let res;
      try {
        res = await enviar(tipo === 'alta' ? reg.payload
                         : tipo === 'sexo' ? reg.cambioSexo : reg.edicion);
      } catch (e) {
        // Sin red: no se toca el registro, se reintenta despues. Cortar la tanda.
        reg.intentos++;
        await guardarLocal(reg);
        break;
      }
      if (res && res.ok) {
        erroresSeguidos = 0;
        if (tipo === 'alta') {
          // duplicado:true tambien es exito: el parto ya estaba en la planilla.
          reg.estado = 'ok';
          reg.id_parto = res.id_parto || reg.id_parto || '';
          reg.reintentos = 0;
        } else if (tipo === 'sexo') {
          reg.cambioSexo = null;
        } else {
          reg.edicion = null;
        }
        reg.error = '';
        reg.revisarEdicion = false;
      } else if (res && res.error === 'validacion') {
        // Dato malo: reintentar no lo arregla. Se marca para revisar.
        if (tipo === 'alta') {
          reg.estado = 'error';
          reg.error = (res.detalles || []).join(' · ');
          reg.reintentos = (reg.reintentos || 0) + 1;
          reg.ultimoIntento = Date.now();
        } else {
          // La fila de la planilla quedo como estaba y la tablet muestra lo
          // corregido: se avisa cual es, en vez de reintentar para siempre.
          // La fila no puede seguir en verde: dice una cosa y la planilla otra.
          reg.edicion = null;
          reg.cambioSexo = null;
          reg.revisarEdicion = true;
          reg.error = (tipo === 'sexo' ? 'cambio de sexo rechazado: ' : 'corrección rechazada: ') +
                      (res.detalles || []).join(' · ');
        }
      } else if (res && res.sesion === false) {
        // Sesion caida: cortar, no quemar la cola entera. Esta es la unica senal
        // autoritativa: la da el backend, que es el que verifica el token.
        sesionVencida = true; fallosToken = FALLOS_PARA_AVISAR;
        // La credencial propia ya no sirve (vencida o secreto rotado): se
        // suelta, para que el proximo login la reemplace y no la siga mandando.
        if (sesion && sesion.token) { sesion.token = ''; localStorage.setItem('sesion', JSON.stringify(sesion)); }
        reg.intentos++;
        reg.error = res.error || 'sesion vencida';
        await guardarLocal(reg);
        break;
      } else if (tipo !== 'alta' && /no existe el parto/i.test((res && res.error) || '')) {
        // La fila ya no esta en la planilla (se borro a mano): reintentar no la
        // va a traer de vuelta. Un parto asi trababa la cola entera para
        // siempre: 112 intentos y los partos de atras con cero.
        reg.edicion = null;
        reg.cambioSexo = null;
        reg.revisarEdicion = true;
        reg.error = 'ese parto ya no está en la planilla: la corrección no se puede aplicar';
        await guardarLocal(reg);
        continue;
      } else {
        // Error del servidor sobre ESTE registro: se anota y se sigue con el
        // siguiente. Solo si el servidor falla tres veces seguidas se corta la
        // tanda, porque entonces es el servidor y no el registro.
        reg.intentos++;
        reg.error = (res && res.error) || 'error del servidor';
        await guardarLocal(reg);
        if (++erroresSeguidos >= 3) break;
        continue;
      }
      await guardarLocal(reg);
    }
  } finally {
    clearTimeout(relojSync);
    sincronizando = false;
    await refrescar();
    // Si la lista esta a la vista, tambien pudo cambiar en otra tablet.
    if (vistaActual() === 'list') bajarPartosDelDia(listaFecha);
  }
}

/* ------------------------------------------------------------------ */
/* Listas y KPIs                                                       */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Partos del dia: los de esta tablet y los de las demas               */
/* ------------------------------------------------------------------ */

/* La lista leia solo IndexedDB, asi que cada tablet veia unicamente lo suyo:
   con tres turnos y varios dispositivos, nadie tenia el dia completo delante.
   Ahora se lee tambien de la planilla y se juntan.

   Lo remoto NO entra a IndexedDB: contaminaria la cola de sincronizacion con
   filas que ya estan escritas. Vive aparte, con una copia en localStorage para
   que al reabrir sin señal siga estando lo ultimo que se supo. */
let remotos = [];
let remotosFecha = '';
let remotosViejo = false;

try {
  const guardado = JSON.parse(localStorage.getItem('remotos') || 'null');
  if (guardado) { remotos = guardado.partos || []; remotosFecha = guardado.fecha || ''; }
} catch (e) { /* copia corrupta: se baja de nuevo */ }

async function bajarPartosDelDia(fecha) {
  // La vista "Sin sincronizar" es solo lo de esta tablet: no hay nada remoto que traer.
  if (fecha === LISTA_PENDIENTES) return refrescar();
  if (!cfg.url || !sesion || !navigator.onLine) { remotosViejo = true; return; }
  const todos = fecha === LISTA_TODOS;
  /* Nunca se fuerza el prompt de Google por una LECTURA: hacerlo revivia el
     falso "sesion vencida" cada hora. Si el token no sirve, se muestra lo
     local y listo. */
  if (!sesionSirve() && !tokenSirve(60000)) { remotosViejo = true; return; }

  try {
    const j = await enviar(todos ? { accion: 'partos', todos: true } : { accion: 'partos', fecha });
    if (!j || !j.ok) { remotosViejo = true; return; }
    remotos = j.partos || [];
    remotosFecha = fecha;
    remotosViejo = false;
    localStorage.setItem('remotos', JSON.stringify({ fecha, partos: remotos }));
  } catch (e) {
    remotosViejo = true;                    // se sigue mostrando la copia guardada
  }
  await refrescar();
}

/** Las filas remotas vienen por CRIA; la lista muestra PARTOS. */
function partosRemotos(fecha) {
  if (remotosFecha !== fecha) return [];
  const porUuid = new Map();
  remotos.forEach((f) => {
    if (fecha !== LISTA_TODOS && f.fecha !== fecha) return;
    if (!porUuid.has(f.uuid)) porUuid.set(f.uuid, []);
    porUuid.get(f.uuid).push(f);
  });
  return [...porUuid.values()];
}

const dosDig = (n) => String(n).padStart(2, '0');
const cuandoSeCargo = (ms) => {
  const d = new Date(ms);
  return `${dosDig(d.getDate())}/${dosDig(d.getMonth() + 1)} ${dosDig(d.getHours())}:${dosDig(d.getMinutes())}`;
};

/** Un parto local, en la forma que pinta la lista. */
function vistaLocal(r) {
  const p = r.payload;
  const pesar = faltaPesar(p);
  const muerto = SEXO_MUERTO.includes(String(p.sexo).charAt(0));
  return {
    uuid: r.uuid, mia: true, id_vaca: p.id_vaca, hora: p.hora_nacimiento, fecha: p.fecha_parto,
    tipo: p.tipo_parto, sexo: p.sexo, operario: p.operario,
    cargado: cuandoSeCargo(r.creado), cargadoTs: r.creado || 0, muerto, pesar, error: r.error || '',
    sinSubir: sinSubir(r),
    intentos: r.intentos || 0,
    crias: muerto ? [] : (p.terneros || []).map((t) => ({
      id: t.id_ternero || 's/id', vive: t.vive !== false,
      peso: t.peso === undefined ? null : t.peso,
      senasa: t.caravana_senasa || ''
    })),
    estado: (r.estado === 'error' || r.revisarEdicion) ? ['bad', 'Revisar']
          : (r.estado === 'pendiente' || r.edicion) ? ['wait', 'Sin sincronizar']
          : ['ok', 'Sincronizado']
  };
}

/** Un parto de otra tablet, leido de la planilla. */
function vistaRemota(filas) {
  const f = filas[0];
  const vivas = filas.filter((x) => String(x.estado_cria) !== 'Muerto');
  return {
    uuid: f.uuid, mia: false, id_vaca: f.id_vaca, hora: f.hora, fecha: f.fecha,
    tipo: f.tipo_parto, sexo: f.sexo, operario: f.operario,
    cargado: String(f.cargado_en || '').slice(5).replace('-', '/'),
    cargadoTs: Date.parse(String(f.cargado_en || '').replace(' ', 'T')) || 0,
    muerto: !vivas.length,
    pesar: vivas.some((x) => x.peso === '' || x.peso === null || x.peso === undefined),
    error: '',
    crias: vivas.map((x) => ({
      id: x.id_ternero || 's/id', vive: true,
      peso: x.peso === '' || x.peso === null || x.peso === undefined ? null : x.peso,
      senasa: x.caravana_senasa && String(x.caravana_senasa) !== VACIO ? String(x.caravana_senasa) : ''
    })),
    estado: ['ok', 'Sincronizado']
  };
}

/* Los contadores viven a nivel modulo porque el badge se repinta desde lugares
   que no los tienen a mano (el evento online, el cierre de sesion, el arranque
   de una tanda). Cuando pintarBadge() los recibia por parametro, esas llamadas
   pasaban undefined y el badge escribia "Sincronizado" con la cola llena. */
let ultimoPend = 0;
let ultimoErr = 0;

/* Orden de la tabla: columna y sentido. Se toca en los encabezados. */
let orden = { col: 'fecha', dir: -1 };
const TOPE_FILAS = 300;

function comparador(col, dir) {
  const val = (v) => {
    if (col === 'fecha') return String(v.fecha || '');
    if (col === 'id_vaca') return String(v.id_vaca || '').padStart(8, '0');
    if (col === 'hora') return String(v.hora || '');
    if (col === 'cargado') return v.cargadoTs || 0;
    if (col === 'operario') return String(v.operario || '');
    if (col === 'estado') return v.estado[1];
    return '';
  };
  return (a, b) => {
    const x = val(a), y = val(b);
    const r = typeof x === 'number' ? x - y : x.localeCompare(y);
    // Empate: mas nuevo primero, siempre.
    return (r * dir) || (String(b.fecha || '').localeCompare(String(a.fecha || ''))) || ((b.cargadoTs || 0) - (a.cargadoTs || 0));
  };
}

async function refrescar() {
  const todos = await todosLocal();
  ultimoPend = todos.filter((r) => r.estado === 'pendiente' || r.edicion).length;
  ultimoErr = todos.filter((r) => r.estado === 'error' || r.revisarEdicion).length;

  // El uuid es la llave: un parto que esta en las dos partes gana el local, que
  // es el unico que sabe si tiene una correccion sin subir.
  const mismos = new Set(todos.map((r) => r.uuid));
  let lista = todos.map(vistaLocal).concat(
    partosRemotos(LISTA_TODOS).filter((f) => !mismos.has(f[0].uuid)).map(vistaRemota));
  const total = lista.length;

  // Filtros: rango de fechas y buscador (vaca, caravana del ternero, caravana SENASA).
  const desde = ($('fDesde').value || '').trim();
  const hasta = ($('fHasta').value || '').trim();
  const q = ($('fBuscar').value || '').trim().toLowerCase();
  lista = lista.filter((v) => (!desde || String(v.fecha || '') >= desde) &&
                              (!hasta || String(v.fecha || '') <= hasta) &&
                              (!q || String(v.id_vaca).toLowerCase().includes(q) ||
                                v.crias.some((c) => String(c.id).toLowerCase().includes(q) ||
                                                    String(c.senasa).toLowerCase().includes(q))));
  lista.sort(comparador(orden.col, orden.dir));

  let h = 0, m = 0, muertos = 0;
  lista.forEach((v) => {
    const sx = String(v.sexo);
    if (/Hembra/i.test(sx)) h += (sx.charAt(0) === '2' ? 2 : 1);
    if (/Macho/i.test(sx)) m += 1;
    if (v.muerto) muertos++;
  });
  $('kTot').textContent = lista.length;
  $('kTotL').textContent = lista.length === total ? 'Partos' : `Partos (de ${total})`;
  $('kHM').textContent = h + ' / ' + m;
  $('kPesar').textContent = lista.filter((v) => v.pesar).length;
  $('kPend').textContent = lista.filter((v) => v.estado[0] !== 'ok').length;
  $('kMuertos').textContent = muertos;

  $('avisoRemotos').classList.toggle('hidden', !remotosViejo);
  $('btnLimpiarFiltros').classList.toggle('hidden', !desde && !hasta && !q);

  // Encabezados: flecha en la columna que ordena.
  document.querySelectorAll('#cabecera [data-orden]').forEach((el) => {
    const on = el.dataset.orden === orden.col;
    el.classList.toggle('on', on);
    el.querySelector('.flecha').textContent = on ? (orden.dir < 0 ? ' ▼' : ' ▲') : '';
  });

  $('cabecera').classList.toggle('hidden', !lista.length);
  const visibles = lista.slice(0, TOPE_FILAS);
  $('filas').innerHTML = visibles.length ? visibles.map((v) => {
    const cria = v.muerto ? v.sexo
      : v.crias.map((c) => c.id + (c.peso === null ? ' (sin pesar)' : ` (${c.peso} kg)`) +
                           (c.senasa ? ` · S&nbsp;${c.senasa}` : '')).join(' + ');
    // Un operario solo corrige lo suyo y no toca un parto con cria muerta (no hay
    // nada editable ahi salvo el sexo). Un admin corrige todo, tambien lo remoto.
    const boton = v.mia
      ? ((!v.muerto || esAdmin())
          ? `<button class="btn ${v.pesar ? 'primary' : ''}" type="button"
               data-editar="${v.uuid}" data-pesar="${v.pesar ? 1 : 0}">${v.pesar ? 'Pesar' : 'Corregir'}</button>` : '')
      : esAdmin()
        ? `<button class="btn" type="button" data-editar-remoto="${v.uuid}">Corregir</button>`
        // Un parto de otra tablet se ve, pero un operario no lo corrige desde aca:
        // la correccion viaja con el registro local, que en esta tablet no existe.
        : '<span class="tag" style="background:var(--soft);color:var(--ink-3)">otra tablet</span>';
    return `<div class="listrow">
      <div class="fecha">${aDDMMAAAA(v.fecha || '')}</div>
      <div class="id">${v.id_vaca}</div>
      <div>${cria}${v.pesar ? ' <span class="tag">falta pesar</span>' : ''}
        ${v.error ? `<div class="meta" style="color:var(--danger)">${v.error}${v.intentos > 1 ? ` · ${v.intentos} intentos` : ''}</div>` : ''}</div>
      <div>${v.hora}</div>
      <div class="ocultar">${v.cargado}</div>
      <div class="ocultar">${v.tipo}</div>
      <div class="ocultar">${v.operario}</div>
      <div><span class="pill ${v.estado[0]}">${v.estado[1]}</span></div>
      <div>${esAdmin()
          ? `<button class="btn" type="button" style="color:var(--danger)" data-rechazar="${v.uuid}">Rechazar</button> ` : ''}${boton}</div>
    </div>`;
  }).join('') + (lista.length > TOPE_FILAS
    ? `<div class="vacio">Se muestran ${TOPE_FILAS} de ${lista.length}. Afiná el rango de fechas o buscá una vaca.</div>` : '')
  : `<div class="vacio">${total ? 'Ningún parto coincide con el filtro.' : 'Todavía no hay partos cargados.'}</div>`;

  pintarBadge();
  pintarPie();
}

/* Sin parametros a proposito: lee el estado del modulo. Cualquiera puede
   repintarlo sin tener los contadores a mano y sin riesgo de mentir. */
function pintarBadge() {
  const p = ultimoPend;
  const err = ultimoErr;
  const mal = sesionVencida || !navigator.onLine;
  const b = $('badgeSync');
  b.className = 'badge ' + (mal || err ? 'off-line' : p ? 'pend' : 'on-line');
  $('badgeTxt').textContent = sincronizando ? 'Sincronizando…'
    : sesionVencida ? (p ? `Sesión vencida · ${p} en espera` : 'Sesión vencida')
    : !navigator.onLine ? (p ? `Sin señal · ${p} en espera` : 'Sin señal')
    : err && p ? `${p} en espera · ${err} para revisar`
    : err ? `${err} para revisar`
    : p ? `${p} en espera` : 'Sincronizado';
}

/* ------------------------------------------------------------------ */
/* Menu de cuenta                                                      */
/* ------------------------------------------------------------------ */

/* Es para TODOS. Antes "Cerrar sesion" vivia en Ajustes —que solo ve el
   admin— y en un long-press escondido sobre el logo: un operario que entraba
   con la cuenta equivocada no tenia como salir. */

let menuAbierto = false;

function pintarCuenta() {
  const caja = $('cuenta');
  cerrarMenuCuenta();
  caja.classList.toggle('hidden', !sesion);
  if (!sesion) return;
  const mail = sesion.email || '';
  $('cuentaIni').textContent = (mail.charAt(0) || '?').toUpperCase();
  $('cuentaQuien').textContent = mail.split('@')[0];
  $('btnCuenta').title = mail;
}

function cerrarMenuCuenta() {
  menuAbierto = false;
  $('menuCuenta').classList.add('hidden');
  $('btnCuenta').setAttribute('aria-expanded', 'false');
}

function abrirMenuCuenta() {
  if (!sesion) return;
  $('menuCuenta').innerHTML = `
    <div class="mail">${sesion.email}${sesion.admin ? ' · admin' : ''}</div>
    ${sesion.admin ? '<button type="button" data-cuenta="config">Ajustes de la tablet</button>' : ''}
    <button type="button" data-cuenta="pendientes">Copiar partos sin sincronizar</button>
    <button type="button" data-cuenta="cambiar">Cambiar de usuario</button>
    <button type="button" class="peligro" data-cuenta="salir">Cerrar sesión</button>`;
  $('menuCuenta').classList.remove('hidden');
  $('btnCuenta').setAttribute('aria-expanded', 'true');
  menuAbierto = true;
}

/* Con la tablet en la mano, un toque de mas no puede dejar a nadie afuera en
   medio de un parto: se confirma, y se dice que la cola no se pierde. */
function confirmarSalida() {
  const p = ultimoPend;
  $('menuCuenta').innerHTML = `
    <div class="mail">${p
      ? `Hay <b>${p}</b> parto${p > 1 ? 's' : ''} sin sincronizar. No se pierden:
         quedan en la tablet y suben cuando alguien vuelva a entrar.`
      : 'Los partos cargados quedan guardados en la tablet.'}</div>
    <button type="button" class="peligro" data-cuenta="salir-ok">Sí, cerrar sesión</button>
    <button type="button" data-cuenta="cancelar">Cancelar</button>`;
}

function accionCuenta(que) {
  if (que === 'config') { cerrarMenuCuenta(); return ver('config'); }
  if (que === 'pendientes') { cerrarMenuCuenta(); return abrirPendientes(); }
  if (que === 'cambiar') {
    // La cola es de la TABLET, no de la cuenta: los partos siguen ahi y en la
    // columna Operario sigue figurando quien los cargo.
    cerrarMenuCuenta();
    cerrarSesion();
    return avisar('Elegí la cuenta con la que vas a entrar');
  }
  if (que === 'salir') return confirmarSalida();
  if (que === 'cancelar') return abrirMenuCuenta();
  if (que === 'salir-ok') { cerrarMenuCuenta(); return cerrarSesion(); }
}

/** La pestaña Ajustes solo se le muestra a los administradores. */
function pintarPermisos() {
  const tab = document.querySelector('.tab[data-v="config"]');
  const admin = !!(sesion && sesion.admin);
  tab.classList.toggle('hidden', !admin);
  if (!admin && vistaActual() === 'config') ver('form');
}

/* ------------------------------------------------------------------ */
/* Vistas                                                              */
/* ------------------------------------------------------------------ */

function ver(v) {
  // Puerta unica: esconder la pestaña no alcanza si cualquier otro camino
  // (el badge, un link) puede abrir la vista igual.
  if (v === 'config' && !(sesion && sesion.admin)) v = 'form';

  document.querySelectorAll('.view').forEach((x) => x.classList.add('hidden'));
  $('v-' + v).classList.remove('hidden');
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.v === v));
  $('body').scrollTop = 0;

  // Sin sesion no hay pestañas ni botones: solo la pantalla de acceso.
  const enLogin = v === 'login';
  cerrarMenuCuenta();
  $('cuenta').classList.toggle('hidden', enLogin || !sesion);
  document.querySelector('.tabs').classList.toggle('hidden', enLogin);
  $('foot').classList.toggle('hidden', enLogin);
  $('badgeSync').classList.toggle('hidden', enLogin);
  if (enLogin) return;

  pintarPie(v);
  if (v === 'config') pintarDiagnostico();
  if (v === 'list') bajarPartosDelDia(listaFecha);
}

const vistaActual = () => (document.querySelector('.tab.on') || { dataset: {} }).dataset.v;

function pintarPie(v) {
  const vista = v || vistaActual();
  const pie = $('foot');
  if (vista === 'form' && st.editando) {
    pie.innerHTML = `<div class="msg">Sólo se corrigen peso, calostro y tambo.
      La corrección queda guardada aunque no haya señal.</div>
      <button class="btn" type="button" id="btnCancelar">Cancelar</button>
      <button class="btn primary" type="button" id="btnGuardarEd">Guardar corrección</button>`;
    $('btnCancelar').onclick = cancelarEdicion;
    $('btnGuardarEd').onclick = guardarEdicion;
  } else if (vista === 'form') {
    pie.innerHTML = `<div class="msg">Los campos con <span class="req">*</span> son obligatorios.
      El ternero se pesa después, desde Partos del día.</div>
      <button class="btn" type="button" data-ir="list">Partos del día</button>
      <button class="btn primary" type="button" id="btnGuardar">Guardar parto</button>`;
    $('btnGuardar').onclick = guardarParto;
  } else if (vista === 'list') {
    pie.innerHTML = `<div class="msg"></div>
      <button class="btn" type="button" id="btnSync">Sincronizar ahora</button>
      <button class="btn primary" type="button" data-ir="form">Nuevo parto</button>`;
    $('btnSync').onclick = () => {
      sincronizar();
      bajarPartosDelDia(listaFecha);
      avisar('Sincronizando…');
    };
  } else {
    pie.innerHTML = `<div class="msg">Configuración de la tablet</div>
      <button class="btn primary" type="button" data-ir="form">Volver al formulario</button>`;
  }
  pie.querySelectorAll('[data-ir]').forEach((b) => { b.onclick = () => ver(b.dataset.ir); });
}

let tToast;
function avisar(txt, malo) {
  const t = $('toast');
  t.textContent = txt;
  t.className = 'toast show' + (malo ? ' bad' : '');
  clearTimeout(tToast);
  tToast = setTimeout(() => { t.className = 'toast'; }, malo ? 4200 : 2600);
}

/* ------------------------------------------------------------------ */
/* Ajustes                                                             */
/* ------------------------------------------------------------------ */

async function bajarMaestro() {
  if (!cfg.url || !sesion) return false;
  try {
    if (!sesionSirve() && !(await tokenVigente())) return false;
    const j = await enviar({ accion: 'maestro' });
    if (!j.ok) { $('estadoConfig').textContent = 'El servicio respondió: ' + j.error; return false; }
    listas = Object.assign({}, LISTAS_BASE, j.listas);
    localStorage.setItem('listas', JSON.stringify(j.listas));
    pintarFormulario();
    return true;
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Pantalla de acceso                                                  */
/* ------------------------------------------------------------------ */

async function pintarLogin() {
  const estado = $('estadoLogin');
  $('btnGoogle').innerHTML = '';

  if (!navigator.onLine) {
    estado.innerHTML = 'Sin señal. Para iniciar sesión por primera vez hace falta conexión — ' +
                       'acercá la tablet al WiFi de la oficina.';
    return;
  }
  estado.textContent = '';

  try {
    await prepararGoogle();
  } catch (e) {
    estado.textContent = 'No se pudo contactar a Google. Revisá la conexión.';
    return;
  }

  entregarCredencial = async (jwt) => {
    estado.textContent = 'Verificando…';
    const r = await abrirSesion(jwt);
    if (!r.ok) { estado.textContent = r.error || 'No se pudo iniciar sesión.'; return; }
    arrancarApp();
  };

  google.accounts.id.renderButton($('btnGoogle'),
    { theme: 'outline', size: 'large', text: 'signin_with', locale: 'es', width: 260 });
  google.accounts.id.prompt();     // si ya hay sesion de Google, entra solo
}

function pintarDiagnostico() {
  $('fDispositivo').value = cfg.dispositivo;
  todosLocal().then((t) => {
    $('diag').innerHTML = [
      `Sesión: <b>${sesion ? sesion.email : 'ninguna'}</b>${sesion && sesion.admin ? ' (admin)' : ''}`,
      `Credencial de 30 días: <b>${sesionSirve() ? 'hasta ' + aDDMMAAAA(new Date(sesion.hasta).toISOString().slice(0, 10))
                                                : 'no (usa el token de Google de 1 h)'}</b>`,
      `Conexión: <b>${navigator.onLine ? 'con señal' : 'sin señal'}</b>`,
      `Registros locales: ${t.length} (pendientes ${t.filter((r) => r.estado === 'pendiente').length},
       con error ${t.filter((r) => r.estado === 'error').length})`,
      `Operarios en lista: ${(listas.operario || []).length}`,
      `Rodeos en lista: ${(listas.rodeo || []).length || 'ninguno (campo libre)'}`,
      `App instalada: ${matchMedia('(display-mode: standalone)').matches ? 'sí' : 'no'}`
    ].join('<br>');
  });
}

$('btnGuardarConfig').onclick = async () => {
  cfg.dispositivo = $('fDispositivo').value.trim() || 'tablet';
  localStorage.setItem('dispositivo', cfg.dispositivo);
  $('estadoConfig').textContent = 'Guardado.';
  pintarDiagnostico();
};
$('btnSalir').onclick = cerrarSesion;
$('btnBajarMaestro').onclick = async () => {
  $('estadoConfig').textContent = (await bajarMaestro())
    ? 'Listas actualizadas.' : 'No se pudieron actualizar.';
};
$('btnReintentar').onclick = () => { sincronizar(); avisar('Reintentando…'); };

/* Respaldo de la cola. Los partos que no subieron viven SOLO en IndexedDB de
   esta tablet: borrar los datos del sitio, desinstalar o borrar el icono los
   pierde, y hasta ahora no habia forma de sacarlos. Esto los vuelca como texto
   para mandarlos por WhatsApp o recargarlos a mano antes de tocar nada.
   Se abre desde el menu de cuenta, que ven TODOS los usuarios: la tablet entra
   con una cuenta que no es admin y no tiene Ajustes.
   El texto queda a la vista y no solo en el portapapeles: en las tablets el
   portapapeles falla en silencio. El payload no lleva el id_token (se agrega
   recien en enviar()), asi que el texto no contiene credenciales. */
async function abrirPendientes() {
  const caja = $('pendientesTxt');
  const est = $('pendientesEstado');
  const pend = (await todosLocal())
    .filter((r) => r.estado !== 'ok' || r.edicion || r.cambioSexo)
    .sort((a, b) => a.creado - b.creado)
    .map((r) => ({
      uuid: r.uuid, estado: r.estado, intentos: r.intentos || 0, error: r.error || '',
      creado: new Date(r.creado).toISOString(),
      edicion: r.edicion || null, cambioSexo: r.cambioSexo || null,
      payload: r.payload
    }));
  if (!pend.length) {
    caja.value = '';
    caja.classList.add('hidden');
    est.textContent = 'No hay partos sin sincronizar. Todo lo cargado ya está en la planilla.';
  } else {
    caja.value = JSON.stringify(pend, null, 1);
    caja.classList.remove('hidden');
    est.textContent = `${pend.length} sin sincronizar. Mantené apretado el texto para seleccionarlo, o tocá Copiar.`;
  }
  $('btnCopiarPendientesTxt').classList.toggle('hidden', !pend.length);
  $('modalPendientes').classList.remove('hidden');
}

function cerrarPendientes() { $('modalPendientes').classList.add('hidden'); }

$('btnCopiarPendientes').onclick = abrirPendientes;
$('btnCerrarPendientes').onclick = cerrarPendientes;
$('modalPendientes').addEventListener('click', (e) => { if (e.target === $('modalPendientes')) cerrarPendientes(); });
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modalPendientes').classList.contains('hidden')) cerrarPendientes();
});
$('btnCopiarPendientesTxt').onclick = async () => {
  const caja = $('pendientesTxt');
  caja.focus();
  caja.select();
  try {
    await navigator.clipboard.writeText(caja.value);
    avisar('Copiado. Pegalo en WhatsApp.');
  } catch (e) {
    avisar('El texto quedó seleccionado: mantenelo apretado y elegí Copiar.');
  }
};

$('badgeSync').onclick = () => {
  // La sesion caida manda, tambien para el admin: si no, la instruccion de
  // "tocar el badge e iniciar sesion" no funcionaba justo para quien la lee.
  if (sesionVencida) { ver('login'); return pintarLogin(); }
  if (sesion && sesion.admin) return ver('config');
  sincronizar();
  avisar('Sincronizando…');
};

/* Salida de emergencia, heredada de r5. Desde el menu de cuenta ya se puede
   salir sin secretos, asi que esto queda solo por si el chip no aparece. */
(function salidaPorLogo() {
  const logo = document.querySelector('.logo');
  let reloj = null;
  const soltar = () => { clearTimeout(reloj); reloj = null; };
  logo.addEventListener('pointerdown', () => {
    reloj = setTimeout(() => { avisar('Cerrando sesión…'); cerrarSesion(); }, 2000);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) =>
    logo.addEventListener(ev, soltar));
})();

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

addEventListener('online', () => { pintarBadge(); sincronizar(); });
addEventListener('offline', () => pintarBadge());
setInterval(sincronizar, 30000);

/* Renovacion proactiva: se pide token nuevo mientras NO hay nada esperando, con
   la app en primer plano. Asi el prompt de Google no cae justo cuando hay
   partos por subir, que es cuando un fallo se nota. */
setInterval(() => {
  if (!sesion || !navigator.onLine || document.hidden) return;
  if (sesionSirve() || tokenSirve(MARGEN_TOKEN)) return;
  tokenVigente().then(pintarBadge);
}, 120000);

(async function iniciar() {
  const hoy = new Date();
  st.fecha = aISO(hoy);
  listaFecha = LISTA_TODOS;
  $('subFecha').textContent = hoy.toLocaleDateString('es-AR',
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  st.tipo_parto = (listas.tipo_parto || [''])[0];
  st.sexo = (listas.sexo || [''])[0];
  st.tambo = (listas.tambo || [''])[0];
  st.lts_madre = medio('lts_madre');
  st.cal = nuevoCalostroMadre();

  pintarFormulario();
  await refrescar();

  // La tablet puede quedar abierta toda la noche en el corral: si cruza la
  // medianoche, "Hoy" tiene que pasar a ser el dia nuevo.
  let hoyConocido = aISO(new Date());
  setInterval(() => {
    const hoyAhora = fechasPosibles()[0].iso;
    if (hoyAhora === hoyConocido) return;
    // La lista sigue al dia nuevo solo si estaba mirando "hoy": si el operario
    // la dejo en ayer a proposito, se respeta.
    hoyConocido = hoyAhora;
    pintarFechas();
    $('subFecha').textContent = new Date().toLocaleDateString('es-AR',
      { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    refrescar();
  }, 60000);

  if (sesion) arrancarApp();
  else { ver('login'); pintarLogin(); }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();

/** Se llama al arrancar con sesion valida, o apenas se inicia sesion. */
function arrancarApp() {
  pintarPermisos();
  pintarCuenta();
  bajarPartosDelDia(listaFecha);
  ver('form');
  bajarMaestro();
  sincronizar();
}
