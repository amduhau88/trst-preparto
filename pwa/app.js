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

const cfg = {
  url: localStorage.getItem('url') || '',
  token: localStorage.getItem('token') || '',
  dispositivo: localStorage.getItem('dispositivo') || 'tablet-maternidad'
};

// Permite configurar abriendo un link: index.html?url=...&token=...
(function configDesdeURL() {
  const q = new URLSearchParams(location.search);
  let cambio = false;
  ['url', 'token', 'dispositivo'].forEach((k) => {
    if (q.get(k)) { cfg[k] = q.get(k); localStorage.setItem(k, q.get(k)); cambio = true; }
  });
  // Sacar el token de la barra de direcciones para que no quede en el historial.
  if (cambio) history.replaceState({}, '', location.pathname);
})();

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

const st = {
  fecha: '', tipo_parto: '', sexo: '', brix: null, brixExc: '', mejorado: 'No', mej: VACIO,
  consumido: 'Si', lts_madre: null, lts_ternero: '', tambo: '', terneros: []
};

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
  chips($('cBrixExc'), 'brixExc', ['Valor numérico'].concat(noNumeros('calidad_sin_mejorar')),
        st.brixExc || 'Valor numérico', { ancho: true, claseDe: (v) => v === 'Valor numérico' ? '' : 'warn' });
  chips($('cMejorado'), 'mejorado', listas.mejorado, st.mejorado, { ancho: true });
  chips($('cConsumido'), 'consumido', listas.consumido, st.consumido, { ancho: true });
  chips($('cLtsTernero'), 'lts_ternero', listas.lts_ternero, st.lts_ternero, { chico: true });
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
  $('vBrix').innerHTML = st.brixExc
    ? `<span style="font-size:15px;color:var(--warn)">${st.brixExc}</span>`
    : (st.brix === null ? '—' : `${st.brix}<span>Brix</span>`);
  $('vMej').innerHTML = st.mej === VACIO ? VACIO : `${st.mej}<span>Brix</span>`;
  $('vLtsMadre').innerHTML = st.lts_madre === null ? '—' : `${st.lts_madre}<span>L</span>`;
  $('wrapMej').classList.toggle('off', st.mejorado !== 'Si');
}

function pintarTerneros() {
  const n = esMuerto() ? 0 : (esMellizo() ? 2 : 1);
  while (st.terneros.length < n) {
    st.terneros.push({ id_ternero: '', raza: (listas.raza || [''])[0], peso: medio('peso') });
  }
  st.terneros.length = n;

  $('terneros').innerHTML = st.terneros.map((t, i) => `
    <div class="subcard" style="${i === 0 ? 'margin-top:0' : ''}">
      <h3><span class="dot"></span>${n > 1 ? 'Ternero ' + (i + 1) : 'Datos del ternero'}</h3>
      <div class="grid g3">
        <label class="f">
          <div class="lab">ID Ternero</div>
          <input type="text" inputmode="numeric" placeholder="Nº de caravana"
                 value="${t.id_ternero}" data-ternero="${i}">
        </label>
        <div>
          <div class="lab">Raza</div>
          <div class="chips" data-chips-raza="${i}"></div>
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
    </div>`).join('');

  st.terneros.forEach((t, i) => {
    chips(document.querySelector(`[data-chips-raza="${i}"]`), 'raza:' + i,
          listas.raza, t.raza, { ancho: true });
  });

  $('cardTernero').classList.toggle('off', esMuerto());
  $('cardCalostro').classList.toggle('off', esMuerto());
  $('notaMuerto').classList.toggle('hidden', !esMuerto());
  $('notaMellizo').classList.toggle('hidden', !esMellizo());
}

/* ------------------------------------------------------------------ */
/* Interaccion                                                         */
/* ------------------------------------------------------------------ */

document.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-chip]');
  if (chip) return elegirChip(chip);
  const step = e.target.closest('[data-step]');
  if (step) return mover(step.dataset.step);
  const tab = e.target.closest('.tab');
  if (tab) return ver(tab.dataset.v);
});

function elegirChip(chip) {
  const clave = chip.dataset.chip;
  const val = chip.dataset.val;
  [...chip.parentElement.children].forEach((c) => c.classList.remove('on'));
  chip.classList.add('on');

  if (clave.startsWith('raza:')) {
    st.terneros[+clave.split(':')[1]].raza = val;
    return;
  }
  if (clave === 'brixExc') {
    st.brixExc = val === 'Valor numérico' ? '' : val;
    if (st.brixExc === '' && st.brix === null) st.brix = medio('calidad_sin_mejorar');
    return pintarSteppers();
  }
  st[clave] = val;
  if (clave === 'fecha') refrescar();          // la lista del dia depende de la fecha
  if (clave === 'sexo') pintarTerneros();
  if (clave === 'mejorado') {
    st.mej = val === 'Si' ? (st.mej === VACIO ? medio('calidad_mejorado') : st.mej) : VACIO;
    pintarSteppers();
  }
}

function mover(spec) {
  const [campo, pasoTxt] = spec.split(':');
  const paso = +pasoTxt;

  if (campo.startsWith('peso')) {
    const i = +campo.slice(4);
    const n = numeros('peso');
    st.terneros[i].peso = acotar(st.terneros[i].peso + paso, n);
    return pintarTerneros();
  }
  if (campo === 'brix') {
    st.brixExc = '';
    st.brix = acotar((st.brix === null ? medio('calidad_sin_mejorar') : st.brix + paso),
                     numeros('calidad_sin_mejorar'));
    chips($('cBrixExc'), 'brixExc', ['Valor numérico'].concat(noNumeros('calidad_sin_mejorar')),
          'Valor numérico', { ancho: true, claseDe: (v) => v === 'Valor numérico' ? '' : 'warn' });
  }
  if (campo === 'mej') {
    if (st.mejorado !== 'Si') return;
    st.mej = acotar((st.mej === VACIO ? medio('calidad_mejorado') : st.mej + paso),
                    numeros('calidad_mejorado'));
  }
  if (campo === 'ltsMadre') {
    st.lts_madre = acotar((st.lts_madre === null ? medio('lts_madre') : st.lts_madre + paso),
                          numeros('lts_madre'));
  }
  pintarSteppers();
}

const acotar = (v, lista) => !lista.length ? v
  : Math.min(Math.max(v, Math.min(...lista)), Math.max(...lista));

document.addEventListener('input', (e) => {
  const t = e.target.closest('[data-ternero]');
  if (t) st.terneros[+t.dataset.ternero].id_ternero = t.value;
});

/* ------------------------------------------------------------------ */
/* Guardar                                                             */
/* ------------------------------------------------------------------ */

function armarPayload() {
  const rodeoEl = document.querySelector('#fRodeo');
  const p = {
    uuid: (crypto.randomUUID ? crypto.randomUUID()
           : Date.now() + '-' + Math.random().toString(16).slice(2)),
    token: cfg.token,
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
    p.terneros = st.terneros.map((t) => ({
      id_ternero: String(t.id_ternero).trim(), raza: t.raza, peso: t.peso
    }));
    p.calostro = {
      calidad_sin_mejorar: st.brixExc || String(st.brix),
      mejorado: st.mejorado,
      calidad_mejorado: st.mejorado === 'Si' ? String(st.mej) : VACIO,
      consumido: st.consumido,
      lts_madre: String(st.lts_madre),
      lts_ternero: st.lts_ternero,
      id_vaca_origen: $('fVacaCal').value.trim()
    };
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
    if (st.brix === null && !st.brixExc) f.push('calidad de calostro');
    if (st.lts_madre === null) f.push('litros de la madre');
    if (!st.lts_ternero) f.push('litros para el ternero');
    if (!p.terneros.every((t) => t.id_ternero)) f.push('ID de ternero');
  }
  if (!p.tambo) f.push('tambo');
  return f;
}

async function guardarParto() {
  const p = armarPayload();
  const faltan = faltantes(p);
  if (faltan.length) {
    return avisar('Falta: ' + faltan.join(', '), true);
  }

  await guardarLocal({
    uuid: p.uuid, estado: 'pendiente', intentos: 0, error: '',
    creado: Date.now(), payload: p
  });

  avisar('Parto guardado' + (navigator.onLine ? '' : ' — se sincroniza al volver la señal'));
  limpiar();
  await refrescar();
  sincronizar();
}

function limpiar() {
  $('fVaca').value = '';
  $('fVacaCal').value = '';
  $('fNotas').value = '';
  st.terneros.forEach((t) => { t.id_ternero = ''; });
  st.brixExc = '';
  pintarFormulario();
  $('body').scrollTop = 0;
  $('fVaca').focus();
}

/* ------------------------------------------------------------------ */
/* Sincronizacion                                                      */
/* ------------------------------------------------------------------ */

let sincronizando = false;

async function enviar(payload) {
  // text/plain = "simple request": no dispara el preflight OPTIONS,
  // que Apps Script no sabe responder.
  const r = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    redirect: 'follow'
  });
  return r.json();
}

async function sincronizar() {
  if (sincronizando || !cfg.url || !cfg.token || !navigator.onLine) return;
  sincronizando = true;
  pintarBadge();
  try {
    const pendientes = (await todosLocal())
      .filter((r) => r.estado === 'pendiente')
      .sort((a, b) => a.creado - b.creado);

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
        // Token mal o error del servidor: cortar, no quemar la cola entera.
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
  b.className = 'badge ' + (!navigator.onLine ? 'off-line' : p ? 'pend' : 'on-line');
  $('badgeTxt').textContent = sincronizando ? 'Sincronizando…'
    : !navigator.onLine ? (p ? `Sin señal · ${p} en espera` : 'Sin señal')
    : p ? `${p} en espera` : (err ? `${err} para revisar` : 'Sincronizado');
}

/* ------------------------------------------------------------------ */
/* Vistas                                                              */
/* ------------------------------------------------------------------ */

function ver(v) {
  document.querySelectorAll('.view').forEach((x) => x.classList.add('hidden'));
  $('v-' + v).classList.remove('hidden');
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.v === v));
  $('body').scrollTop = 0;
  pintarPie(v);
  if (v === 'config') pintarDiagnostico();
}

const vistaActual = () => document.querySelector('.tab.on').dataset.v;

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
  if (!cfg.url || !cfg.token) return false;
  try {
    const r = await fetch(`${cfg.url}?action=maestro&token=${encodeURIComponent(cfg.token)}`);
    const j = await r.json();
    if (!j.ok) { $('estadoConfig').textContent = 'El servicio respondió: ' + j.error; return false; }
    listas = Object.assign({}, LISTAS_BASE, j.listas);
    localStorage.setItem('listas', JSON.stringify(j.listas));
    pintarFormulario();
    return true;
  } catch (e) {
    return false;
  }
}

function pintarDiagnostico() {
  $('fUrl').value = cfg.url;
  $('fToken').value = cfg.token;
  $('fDispositivo').value = cfg.dispositivo;
  todosLocal().then((t) => {
    $('diag').innerHTML = [
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
  cfg.url = $('fUrl').value.trim();
  cfg.token = $('fToken').value.trim();
  cfg.dispositivo = $('fDispositivo').value.trim() || 'tablet';
  ['url', 'token', 'dispositivo'].forEach((k) => localStorage.setItem(k, cfg[k]));
  $('estadoConfig').textContent = 'Probando…';
  const ok = await bajarMaestro();
  $('estadoConfig').textContent = ok
    ? 'Conectado. Listas actualizadas desde la planilla.'
    : 'No se pudo conectar. Revisá URL y token (o puede ser falta de señal).';
  pintarDiagnostico();
  sincronizar();
};
$('btnBajarMaestro').onclick = async () => {
  $('estadoConfig').textContent = (await bajarMaestro())
    ? 'Listas actualizadas.' : 'No se pudieron actualizar.';
};
$('btnReintentar').onclick = () => { sincronizar(); avisar('Reintentando…'); };
$('badgeSync').onclick = () => ver('config');

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
  st.lts_ternero = String(medio('lts_ternero'));
  st.brix = medio('calidad_sin_mejorar');
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

  if (!cfg.url || !cfg.token) {
    ver('config');
    $('estadoConfig').textContent = 'Falta configurar la conexión con la planilla.';
  } else {
    bajarMaestro();
    sincronizar();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
