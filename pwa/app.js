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

  sesion = { email: r.email, admin: !!r.admin,
             hasta: Date.now() + (CONFIG.DIAS_SESION || 30) * 86400000 };
  localStorage.setItem('sesion', JSON.stringify(sesion));
  sesionVencida = false;
  return { ok: true };
}

function cerrarSesion() {
  sesion = null;
  idToken = { valor: '', exp: 0 };
  localStorage.removeItem('sesion');
  localStorage.removeItem('idToken');
  try { google.accounts.id.disableAutoSelect(); } catch (e) { /* sin red */ }
  ver('login');
  pintarLogin();
}

/**
 * Devuelve un ID token vigente, renovandolo en silencio si hace falta.
 * Solo se usa al sincronizar: guardar un parto nunca depende de esto.
 */
async function tokenVigente() {
  if (idToken.valor && idToken.exp - 60000 > Date.now()) return idToken.valor;
  if (!navigator.onLine) return '';

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
  calidad_sin_mejorar: rango(18, 35).concat(['mastitis', 'sangre', 'campo']),
  mejorado: ['Si', 'No'],
  calidad_mejorado: [VACIO].concat(rango(26, 35)),
  consumido: ['Si', 'No'],
  lts_madre: rango(0, 20),
  lts_ternero: rango(2, 6),
  tambo: ['1', '2', '3'],
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

/* ------------------------------------------------------------------ */
/* Estado del formulario                                               */
/* ------------------------------------------------------------------ */

/* Cada ternero lleva lo suyo: sexo, si nacio vivo, y su propio calostro.
   Los litros que produjo la madre son del parto, no de la cria. */
const st = {
  fecha: '', tipo_parto: '', sexo: '', lts_madre: null, tambo: '', terneros: []
};

function nuevoTernero() {
  return {
    id_ternero: '', raza: (listas.raza || [''])[0], peso: medio('peso'),
    sexo: '', vive: true,
    cal: {
      brix: medio('calidad_sin_mejorar'), brixExc: '',
      mejorado: 'No', mej: VACIO, consumido: 'Si',
      lts_ternero: String(medio('lts_ternero')), id_origen: ''
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
function pintarFechas() {
  const opciones = fechasPosibles();
  // Si la app quedo abierta toda la noche y cruzo la medianoche, la seleccion
  // vieja ya no corresponde a ningun boton: se reancla en Hoy.
  if (!opciones.some((o) => o.iso === st.fecha)) st.fecha = opciones[0].iso;

  $('cFecha').innerHTML = opciones.map((o) =>
    `<button type="button" class="chip fecha ${o.iso === st.fecha ? 'on' : ''}"
             data-chip="fecha" data-val="${o.iso}">${o.etiqueta}<span class="dia">${aDDMMAAAA(o.iso)}</span></button>`
  ).join('');
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

  // Rodeo: si Maestro no tiene lista, campo libre en vez de un desplegable vacio.
  const wrap = $('wrapRodeo');
  if (listas.rodeo && listas.rodeo.length) {
    const actual = wrap.querySelector('select,input') ? wrap.querySelector('select,input').value : '';
    wrap.innerHTML = '<select id="fRodeo"></select>';
    opciones($('fRodeo'), listas.rodeo, actual);
  } else if (!wrap.querySelector('input')) {
    wrap.innerHTML = '<input type="text" id="fRodeo" inputmode="numeric" placeholder="Nº de rodeo">';
  }

  pintarSteppers();
  pintarTerneros();
}

function pintarSteppers() {
  $('vLtsMadre').innerHTML = st.lts_madre === null ? '—' : `${st.lts_madre}<span>L</span>`;
}

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
        <div>
          <div class="lab">Raza</div>
          <div class="chips" data-caja="raza:${i}"></div>
        </div>
        <div>
          <div class="lab">Peso</div>
          <div class="stepper">
            <button type="button" data-step="peso${i}:-1">−</button>
            <div class="val">${t.peso}<span>kg</span></div>
            <button type="button" data-step="peso${i}:1">+</button>
          </div>
        </div>
      </div>
      ${n > 1 ? `
      <div class="grid g2" style="margin-top:12px">
        <div>
          <div class="lab">Sexo de esta cría ${sexoAmbiguo() ? '<span class="req">*</span>' : ''}</div>
          <div class="chips" data-caja="sexoc:${i}"></div>
        </div>
        <div>
          <div class="lab">¿Nació viva?</div>
          <div class="chips" data-caja="vive:${i}"></div>
        </div>
      </div>` : ''}
    </div>`).join('');

  st.terneros.forEach((t, i) => {
    caja('raza:' + i, listas.raza, t.raza, { ancho: true });
    if (n > 1) {
      const sugerido = t.sexo || SEXO_POR_CODIGO[String(st.sexo).charAt(0)] || '';
      caja('sexoc:' + i, ['Hembra', 'Macho'], sugerido, { ancho: true });
      caja('vive:' + i, ['Vivo', 'Muerto'], t.vive ? 'Vivo' : 'Muerto',
           { ancho: true, claseDe: (v) => (v === 'Muerto' ? 'bad' : '') });
    }
  });

  $('cardTernero').classList.toggle('off', esMuerto());
  $('cardCalostro').classList.toggle('off', esMuerto());
  $('notaMuerto').classList.toggle('hidden', !esMuerto());
  $('notaMellizo').classList.toggle('hidden', !esMellizo());
  pintarCalostros();
}

/** Un bloque de calostro por cría viva, rotulado con cuál es. */
function pintarCalostros() {
  const vivas = st.terneros.map((t, i) => ({ t, i })).filter((x) => x.t.vive);

  $('calostros').innerHTML = vivas.map(({ t, i }) => {
    const c = t.cal;
    return `
    <div class="subcard">
      <h3><span class="dot"></span>${st.terneros.length > 1 ? 'Calostro del ternero ' + (i + 1) : 'Calostro'}
        <span class="quien ${t.id_ternero ? '' : 'sin'}">${etiquetaCria(t, i)}</span></h3>
      <div class="grid g23">
        <div>
          <div class="lab">Calidad sin mejorar</div>
          <div class="stepper">
            <button type="button" data-step="brix${i}:-1">−</button>
            <div class="val">${c.brixExc
              ? `<span style="font-size:15px;color:var(--warn)">${c.brixExc}</span>`
              : `${c.brix}<span>Brix</span>`}</div>
            <button type="button" data-step="brix${i}:1">+</button>
          </div>
        </div>
        <div>
          <div class="lab">…o marcar excepción</div>
          <div class="chips" data-caja="brixExc:${i}"></div>
        </div>
      </div>
      <div class="grid g2" style="margin-top:14px">
        <div>
          <div class="lab">¿Mejorado?</div>
          <div class="chips" data-caja="mejorado:${i}"></div>
        </div>
        <div class="${c.mejorado === 'Si' ? '' : 'off'}">
          <div class="lab">Calidad del calostro mejorado</div>
          <div class="stepper">
            <button type="button" data-step="mej${i}:-1">−</button>
            <div class="val">${c.mej === VACIO ? VACIO : `${c.mej}<span>Brix</span>`}</div>
            <button type="button" data-step="mej${i}:1">+</button>
          </div>
        </div>
      </div>
      <div class="grid g3" style="margin-top:14px">
        <div>
          <div class="lab">¿Consumido al momento?</div>
          <div class="chips" data-caja="consumido:${i}"></div>
        </div>
        <div>
          <div class="lab">Litros para el ternero</div>
          <div class="chips" data-caja="ltsTernero:${i}"></div>
        </div>
        <label class="f">
          <div class="lab">ID vaca origen del calostro</div>
          <input type="text" inputmode="numeric" placeholder="Nº de vaca"
                 value="${c.id_origen}" data-origen="${i}">
        </label>
      </div>
    </div>`;
  }).join('') || '<p class="hint" style="margin:14px 0 0">Sin crías vivas: no se carga calostro.</p>';

  vivas.forEach(({ t, i }) => {
    const c = t.cal;
    caja('brixExc:' + i, ['Valor numérico'].concat(noNumeros('calidad_sin_mejorar')),
         c.brixExc || 'Valor numérico',
         { ancho: true, claseDe: (v) => (v === 'Valor numérico' ? '' : 'warn') });
    caja('mejorado:' + i, listas.mejorado, c.mejorado, { ancho: true });
    caja('consumido:' + i, listas.consumido, c.consumido, { ancho: true });
    caja('ltsTernero:' + i, listas.lts_ternero, c.lts_ternero, { chico: true });
  });
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
    if (campo === 'brixExc') {
      c.brixExc = val === 'Valor numérico' ? '' : val;
      return pintarCalostros();
    }
    if (campo === 'mejorado') {
      c.mejorado = val;
      c.mej = val === 'Si' ? (c.mej === VACIO ? medio('calidad_mejorado') : c.mej) : VACIO;
      return pintarCalostros();
    }
    if (campo === 'consumido') { c.consumido = val; return; }
    if (campo === 'ltsTernero') { c.lts_ternero = val; return; }
    return;
  }

  st[clave] = val;
  if (clave === 'fecha') refrescar();          // la lista del dia depende de la fecha
  if (clave === 'sexo') pintarTerneros();
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
    t.peso = acotar(t.peso + paso, numeros('peso'));
    return celda ? escribir(`${t.peso}<span>kg</span>`) : pintarTerneros();
  }
  if (campo.startsWith('brix')) {
    const c = st.terneros[+campo.slice(4)].cal;
    const teniaExcepcion = !!c.brixExc;
    c.brixExc = '';                              // tocar el numero descarta la excepcion
    c.brix = acotar(c.brix + paso, numeros('calidad_sin_mejorar'));
    // Solo hace falta repintar la primera vez, para apagar el chip de excepcion.
    if (teniaExcepcion || !celda) return pintarCalostros();
    return escribir(`${c.brix}<span>Brix</span>`);
  }
  if (campo.startsWith('mej')) {
    const c = st.terneros[+campo.slice(3)].cal;
    if (c.mejorado !== 'Si') return;
    c.mej = acotar((c.mej === VACIO ? medio('calidad_mejorado') : c.mej + paso),
                   numeros('calidad_mejorado'));
    return celda ? escribir(`${c.mej}<span>Brix</span>`) : pintarCalostros();
  }
  if (campo === 'ltsMadre') {
    st.lts_madre = acotar((st.lts_madre === null ? medio('lts_madre') : st.lts_madre + paso),
                          numeros('lts_madre'));
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

const acotar = (v, lista) => !lista.length ? v
  : Math.min(Math.max(v, Math.min(...lista)), Math.max(...lista));

document.addEventListener('input', (e) => {
  const t = e.target.closest('[data-ternero]');
  if (t) {
    st.terneros[+t.dataset.ternero].id_ternero = t.value;
    // El rotulo de la ficha de calostro se actualiza al tipear la caravana.
    if (st.terneros.length > 1) pintarCalostros();
    return;
  }
  const o = e.target.closest('[data-origen]');
  if (o) st.terneros[+o.dataset.origen].cal.id_origen = o.value;
});

/* ------------------------------------------------------------------ */
/* Guardar                                                             */
/* ------------------------------------------------------------------ */

function armarPayload() {
  const rodeoEl = document.querySelector('#fRodeo');
  const p = {
    uuid: (crypto.randomUUID ? crypto.randomUUID()
           : Date.now() + '-' + Math.random().toString(16).slice(2)),
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
    rodeo: rodeoEl ? rodeoEl.value.trim() : '',
    notas: $('fNotas').value.trim()
  };

  if (!esMuerto()) {
    p.lts_madre = String(st.lts_madre);           // del parto, no de la cria
    p.terneros = st.terneros.map((t) => {
      const cria = {
        id_ternero: String(t.id_ternero).trim(),
        raza: t.raza, peso: t.peso,
        sexo: t.sexo || SEXO_POR_CODIGO[String(st.sexo).charAt(0)] || '',
        vive: t.vive
      };
      if (t.vive) {
        cria.calostro = {
          calidad_sin_mejorar: t.cal.brixExc || String(t.cal.brix),
          mejorado: t.cal.mejorado,
          calidad_mejorado: t.cal.mejorado === 'Si' ? String(t.cal.mej) : VACIO,
          consumido: t.cal.consumido,
          lts_ternero: t.cal.lts_ternero,
          id_vaca_origen: String(t.cal.id_origen).trim()
        };
      }
      return cria;
    });
  }
  return p;
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
    const varias = st.terneros.length > 1;
    st.terneros.forEach((t, i) => {
      const cual = varias ? ` (ternero ${i + 1})` : '';
      if (!t.vive) return;                       // cria muerta: no lleva datos
      if (!String(t.id_ternero).trim()) f.push('ID de ternero' + cual);
      if (sexoAmbiguo() && !t.sexo) f.push('sexo' + cual);
      if (!t.cal.lts_ternero) f.push('litros para el ternero' + cual);
      if (t.cal.brix === null && !t.cal.brixExc) f.push('calidad de calostro' + cual);
    });
    if (st.terneros.length && st.terneros.every((t) => !t.vive)) {
      f.push('al menos una cría viva, o cambiá el código del parto');
    }
  }
  if (!p.tambo) f.push('tambo');
  return f;
}

/**
 * El rodeo es campo abierto a proposito: se van definiendo sobre la marcha.
 * Pero abierto no es cualquier cosa: en la planilla vieja la columna de rodeo
 * junta "-", "---" y numeros sueltos. Un rodeo siempre es un numero.
 */
function rodeoValido(v) {
  return v === '' || /^\d{1,4}$/.test(v);
}

async function guardarParto() {
  const p = armarPayload();
  const faltan = faltantes(p);
  if (faltan.length) {
    return avisar('Falta: ' + faltan.join(', '), true);
  }
  if (!rodeoValido(p.rodeo)) {
    return avisar('El rodeo tiene que ser un número: "' + p.rodeo + '"', true);
  }

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
    partes.push(`${t.peso} kg`);
    return partes.join(' · ');
  });

  $('okDetalle').innerHTML =
    `Vaca <b>${p.id_vaca}</b> · ${aDDMMAAAA(p.fecha_parto)} · ${p.hora_nacimiento}` +
    (crias.length ? '<br>' + crias.map((c) => `<b>${c}</b>`).join('<br>')
                  : '<br><b>Sin cría viva</b>');

  const enEspera = !navigator.onLine || sesionVencida;
  const est = $('okEstado');
  est.className = 'estado' + (enEspera ? ' espera' : '');
  est.textContent = enEspera
    ? 'Guardado en la tablet — se sincroniza al volver la señal'
    : 'Guardado y sincronizado';

  $('modalOk').classList.remove('hidden');
  $('btnOtroParto').focus();
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
  $('fVaca').value = '';
  $('fNotas').value = '';
  st.terneros = st.terneros.map(() => nuevoTernero());
  pintarFormulario();
  $('body').scrollTop = 0;
  $('fVaca').focus();
}

/* ------------------------------------------------------------------ */
/* Sincronizacion                                                      */
/* ------------------------------------------------------------------ */

let sincronizando = false;

/**
 * El ID token se adjunta en el momento de enviar, no al guardar: un parto que
 * estuvo dos dias en la cola no puede llevar una credencial vencida.
 */
async function enviar(payload) {
  // text/plain = "simple request": no dispara el preflight OPTIONS,
  // que Apps Script no sabe responder.
  const r = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ id_token: idToken.valor }, payload)),
    redirect: 'follow'
  });
  return r.json();
}

async function sincronizar() {
  if (sincronizando || !cfg.url || !sesion || !navigator.onLine) return;
  sincronizando = true;
  pintarBadge();
  try {
    const pendientes = (await todosLocal())
      .filter((r) => r.estado === 'pendiente')
      .sort((a, b) => a.creado - b.creado);
    if (!pendientes.length) { sesionVencida = false; return; }

    // Sin credencial vigente no se intenta: los partos quedan en la cola,
    // intactos, y el badge avisa que hay que iniciar sesion.
    if (!(await tokenVigente())) { sesionVencida = true; return; }
    sesionVencida = false;

    for (const reg of pendientes) {
      let res;
      try {
        res = await enviar(reg.payload);
      } catch (e) {
        // Sin red: no se toca el registro, se reintenta despues. Cortar la tanda.
        reg.intentos++;
        await guardarLocal(reg);
        break;
      }
      if (res && res.ok) {
        // duplicado:true tambien es exito: el parto ya estaba en la planilla.
        reg.estado = 'ok';
        reg.error = '';
        reg.id_parto = res.id_parto || reg.id_parto || '';
      } else if (res && res.error === 'validacion') {
        // Dato malo: reintentar no lo arregla. Se marca para revisar.
        reg.estado = 'error';
        reg.error = (res.detalles || []).join(' · ');
      } else {
        // Sesion caida o error del servidor: cortar, no quemar la cola entera.
        if (res && res.sesion === false) sesionVencida = true;
        reg.intentos++;
        reg.error = (res && res.error) || 'error del servidor';
        await guardarLocal(reg);
        break;
      }
      await guardarLocal(reg);
    }
  } finally {
    sincronizando = false;
    await refrescar();
  }
}

/* ------------------------------------------------------------------ */
/* Listas y KPIs                                                       */
/* ------------------------------------------------------------------ */

async function refrescar() {
  const todos = await todosLocal();
  const delDia = todos.filter((r) => r.payload.fecha_parto === st.fecha)
                      .sort((a, b) => b.creado - a.creado);
  const pendientes = todos.filter((r) => r.estado === 'pendiente').length;
  const errores = todos.filter((r) => r.estado === 'error').length;

  let h = 0, m = 0, muertos = 0;
  delDia.forEach((r) => {
    const s = String(r.payload.sexo);
    if (/Hembra/i.test(s)) h += (s.charAt(0) === '2' ? 2 : 1);
    if (/Macho/i.test(s)) m += 1;
    if (SEXO_MUERTO.includes(s.charAt(0))) muertos++;
  });

  $('kTot').textContent = delDia.length;
  $('kHM').textContent = h + ' / ' + m;
  $('kPend').textContent = pendientes;
  $('kMuertos').textContent = muertos;

  $('filas').innerHTML = delDia.length ? delDia.map((r) => {
    const p = r.payload;
    const est = r.estado === 'ok' ? ['ok', 'Sincronizado']
              : r.estado === 'error' ? ['bad', 'Revisar']
              : ['wait', 'Sin sincronizar'];
    const cria = SEXO_MUERTO.includes(String(p.sexo).charAt(0))
      ? p.sexo
      : `${p.sexo} · ${p.terneros.map((t) => (t.id_ternero || 's/id') + ' (' + t.peso + ' kg)').join(' + ')}`;
    return `<div class="listrow">
      <div class="id">${p.id_vaca}</div>
      <div>${cria}<div class="meta">Tambo ${p.tambo}${p.rodeo ? ' · rodeo ' + p.rodeo : ''}${r.error ? ' · <span style="color:var(--danger)">' + r.error + '</span>' : ''}</div></div>
      <div>${p.hora_nacimiento}</div>
      <div class="ocultar">${p.tipo_parto}</div>
      <div><span class="pill ${est[0]}">${est[1]}</span></div>
    </div>`;
  }).join('') : '<div class="vacio">Todavía no hay partos cargados hoy.</div>';

  pintarBadge(pendientes, errores);
  pintarPie();
}

function pintarBadge(pend, err) {
  const b = $('badgeSync');
  const p = pend === undefined ? null : pend;
  const mal = sesionVencida || !navigator.onLine;
  b.className = 'badge ' + (mal ? 'off-line' : p ? 'pend' : 'on-line');
  $('badgeTxt').textContent = sincronizando ? 'Sincronizando…'
    : sesionVencida ? (p ? `Sesión vencida · ${p} en espera` : 'Sesión vencida')
    : !navigator.onLine ? (p ? `Sin señal · ${p} en espera` : 'Sin señal')
    : p ? `${p} en espera` : (err ? `${err} para revisar` : 'Sincronizado');
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
  document.querySelector('.tabs').classList.toggle('hidden', enLogin);
  $('foot').classList.toggle('hidden', enLogin);
  $('badgeSync').classList.toggle('hidden', enLogin);
  if (enLogin) return;

  pintarPie(v);
  if (v === 'config') pintarDiagnostico();
}

const vistaActual = () => (document.querySelector('.tab.on') || { dataset: {} }).dataset.v;

function pintarPie(v) {
  const vista = v || vistaActual();
  const pie = $('foot');
  if (vista === 'form') {
    pie.innerHTML = `<div class="msg">Los campos con <span class="req">*</span> son obligatorios.
      El parto queda guardado aunque no haya señal.</div>
      <button class="btn" type="button" data-ir="list">Partos del día</button>
      <button class="btn primary" type="button" id="btnGuardar">Guardar parto</button>`;
    $('btnGuardar').onclick = guardarParto;
  } else if (vista === 'list') {
    pie.innerHTML = `<div class="msg"></div>
      <button class="btn" type="button" id="btnSync">Sincronizar ahora</button>
      <button class="btn primary" type="button" data-ir="form">Nuevo parto</button>`;
    $('btnSync').onclick = () => { sincronizar(); avisar('Sincronizando…'); };
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
    if (!(await tokenVigente())) { sesionVencida = true; return false; }
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

$('badgeSync').onclick = () => {
  if (sesion && sesion.admin) return ver('config');
  if (sesionVencida) { ver('login'); return pintarLogin(); }
  sincronizar();
  avisar('Sincronizando…');
};

/* Salida de emergencia: mantener apretado el logo 2 segundos cierra la sesion.
   Sin esto, una tablet con la cuenta de dispositivo queda trabada para siempre:
   "Cerrar sesion" vive en Ajustes, y Ajustes no se le muestra a esa cuenta. */
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

(async function iniciar() {
  const hoy = new Date();
  st.fecha = aISO(hoy);
  $('subFecha').textContent = hoy.toLocaleDateString('es-AR',
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  st.tipo_parto = (listas.tipo_parto || [''])[0];
  st.sexo = (listas.sexo || [''])[0];
  st.tambo = (listas.tambo || [''])[0];
  st.lts_madre = medio('lts_madre');

  pintarFormulario();
  await refrescar();

  // La tablet puede quedar abierta toda la noche en el corral: si cruza la
  // medianoche, "Hoy" tiene que pasar a ser el dia nuevo.
  let hoyConocido = aISO(new Date());
  setInterval(() => {
    const hoyAhora = fechasPosibles()[0].iso;
    if (hoyAhora === hoyConocido) return;
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
  ver('form');
  bajarMaestro();
  sincronizar();
}
