/**
 * Prueba automatizada de la PWA — `node pwa/test_pwa.js`
 *
 * Levanta un backend simulado que respeta el contrato de Apps Script
 * (identidad e idempotencia por uuid incluidas) y maneja Chrome de verdad para
 * reproducir el escenario del corral: iniciar sesion una vez, cargar sin señal,
 * cerrar la app, reabrirla sin señal, y confirmar que cada parto llega UNA sola vez.
 *
 * Google se simula: `window.google.accounts.id` se inyecta antes de que corra
 * la app, asi las pruebas no dependen de la red ni de una cuenta real.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PUERTO_WEB = 8791;
const PUERTO_API = 8792;
const RAIZ = __dirname;
const ADMIN = 'andresduhau@admin.com.ar';
const DISPOSITIVO = 'tablet.maternidad@admin.com.ar';

let fallos = 0;
const check = (nombre, cond, detalle) => {
  console.log((cond ? '  ok    ' : '  FALLA ') + nombre + (cond || !detalle ? '' : '  -> ' + detalle));
  if (!cond) fallos++;
};

/* ---------- credenciales de mentira ---------- */
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwtFalso = (email, minutos) =>
  b64({ alg: 'none' }) + '.' +
  b64({ email, exp: Math.floor(Date.now() / 1000) + minutos * 60 }) + '.firma';

const leerJwt = (t) => {
  try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString()); }
  catch (e) { return null; }
};

/* ---------- servidor estatico ---------- */
const TIPOS = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
const noEncontrados = [];
const web = http.createServer((req, res) => {
  const limpio = decodeURIComponent(req.url.split('?')[0]);

  // config.js se sirve apuntando al backend simulado, sin tocar el archivo real.
  if (limpio === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
    return res.end(`window.CONFIG={URL_EXEC:'http://localhost:${PUERTO_API}/exec',` +
                   `CLIENT_ID:'prueba.apps.googleusercontent.com',DOMINIO:'admin.com.ar',DIAS_SESION:30};`);
  }

  const f = path.join(RAIZ, limpio === '/' ? 'index.html' : limpio);
  if (!f.startsWith(RAIZ) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    noEncontrados.push(limpio);
    res.writeHead(404); return res.end('no');
  }
  res.writeHead(200, {
    'Content-Type': TIPOS[path.extname(f)] || 'application/octet-stream',
    'Service-Worker-Allowed': '/',
    'Cache-Control': 'no-cache'
  });
  res.end(fs.readFileSync(f));
});

/* ---------- backend simulado (mismo contrato que Apps Script) ---------- */
const recibidos = [];
const filas = [];
const uuidsVistos = new Set();
const sinSesion = [];          // requests que llegaron sin credencial valida
let caidoHasta = 0;

const LISTAS = {
  operario: ['Julio', 'Griselda', 'Martin', 'Trini'],
  tipo_parto: ['1 Normal', '2 Asistido', '4 Cesarea'],
  sexo: ['1 Hembra Viva', '2 Hembras Gemelas Vivas', '4 Hembra Muerta', '6 Macho Vivo',
         '7 Macho Muerto', '8 Otros Gemelos (M+M o M+H)'],
  raza: ['Holando', 'Angus'],
  peso: Array.from({ length: 36 }, (_, i) => String(25 + i)),
  hora_nacimiento: Array.from({ length: 48 }, (_, i) =>
    String(Math.floor(i / 2)).padStart(2, '0') + ':' + (i % 2 ? '30' : '00')),
  calidad_sin_mejorar: Array.from({ length: 18 }, (_, i) => String(18 + i)).concat(['mastitis', 'sangre', 'campo']),
  mejorado: ['Si', 'No'], calidad_mejorado: ['---'].concat(Array.from({ length: 10 }, (_, i) => String(26 + i))),
  consumido: ['Si', 'No'],
  lts_madre: Array.from({ length: 21 }, (_, i) => String(i)),
  lts_ternero: ['2', '3', '4', '5', '6'],
  tambo: ['1', '2', '3'], rodeo: ['21', '23', '26', '201', '202']
};

const api = http.createServer((req, res) => {
  const responder = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
  };
  if (Date.now() < caidoHasta) { res.writeHead(500); return res.end('caido'); }
  if (req.method === 'GET') return responder({ ok: true, hoja: 'simulada' });

  let cuerpo = '';
  req.on('data', (c) => { cuerpo += c; });
  req.on('end', () => {
    let p;
    try { p = JSON.parse(cuerpo); } catch (e) { return responder({ ok: false, error: 'json' }); }

    const datos = leerJwt(p.id_token);
    const vigente = datos && datos.exp * 1000 > Date.now();
    if (!vigente) {
      sinSesion.push(p.uuid || p.accion || '?');
      return responder({ ok: false, error: 'falta sesion', sesion: false });
    }

    if (p.accion === 'sesion') {
      return responder({ ok: true, email: datos.email, admin: datos.email === ADMIN });
    }
    if (p.accion === 'maestro') return responder({ ok: true, listas: LISTAS });
    if (p.accion === 'partos') return responder({ ok: true, partos: [] });

    recibidos.push(p.uuid);
    if (uuidsVistos.has(p.uuid)) return responder({ ok: true, duplicado: true, uuid: p.uuid });
    if (!p.operario || !p.id_vaca) {
      return responder({ ok: false, error: 'validacion', detalles: ['faltan datos'] });
    }
    uuidsVistos.add(p.uuid);
    const n = Math.max(1, (p.terneros || []).length);
    for (let i = 0; i < n; i++) filas.push({ uuid: p.uuid, vaca: p.id_vaca, cria: `${i + 1}/${n}` });
    responder({ ok: true, uuid: p.uuid, id_parto: 'X-' + p.id_vaca, filas_escritas: n });
  });
});

/* ---------- helpers de pagina ---------- */

/** Inyecta un Google de mentira antes de que corra la app. */
async function simularGoogle(page, credencial, auto) {
  await page.evaluateOnNewDocument((cred, autoEntrar) => {
    window.__cred = cred;
    window.__auto = autoEntrar;
    window.__promptPedido = 0;
    window.google = { accounts: { id: {
      initialize(o) { window.__cb = o.callback; window.__init = o; },
      renderButton(el) {
        const b = document.createElement('button');
        b.id = 'gbtn'; b.textContent = 'Acceder con Google';
        b.onclick = () => window.__cb && window.__cb({ credential: window.__cred });
        el.appendChild(b);
      },
      prompt() {
        window.__promptPedido++;
        if (window.__auto && window.__cb) {
          setTimeout(() => window.__cb({ credential: window.__cred }), 30);
        }
      },
      disableAutoSelect() { window.__auto = false; }
    } } };
  }, credencial, auto);
}

async function nuevaPagina(browser, credencial, auto = true) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1180, height: 820 });
  await simularGoogle(page, credencial, auto);
  return page;
}

async function cargarParto(page, vaca, ternero) {
  await page.evaluate((v, t) => {
    document.getElementById('fVaca').value = v;
    document.querySelectorAll('[data-ternero]').forEach((inp, i) => {
      inp.value = i === 0 ? t : String(Number(t) + 1);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }, vaca, ternero);
  await page.click('#btnGuardar');
  await new Promise((r) => setTimeout(r, 350));
}

/** Elige el código de sexo del parto por su número inicial. */
const elegirSexo = (page, codigo) => page.evaluate((c) => {
  [...document.querySelectorAll('[data-chip="sexo"]')]
    .find((b) => b.dataset.val.startsWith(c)).click();
}, String(codigo));

const leerPayload = (page, vaca) => page.evaluate((v) => new Promise((ok) => {
  const req = indexedDB.open('preparto', 1);
  req.onsuccess = () => {
    const g = req.result.transaction('partos', 'readonly').objectStore('partos').getAll();
    g.onsuccess = () => ok((g.result.find((r) => r.payload.id_vaca === v) || {}).payload);
  };
}), vaca);

const contarLocal = (page) => page.evaluate(() => new Promise((ok) => {
  const req = indexedDB.open('preparto', 1);
  req.onsuccess = () => {
    const t = req.result.transaction('partos', 'readonly').objectStore('partos').getAll();
    t.onsuccess = () => ok({
      total: t.result.length,
      pendientes: t.result.filter((r) => r.estado === 'pendiente').length,
      ok: t.result.filter((r) => r.estado === 'ok').length,
      error: t.result.filter((r) => r.estado === 'error').length
    });
  };
}));

const esperarSync = async (page, seg = 12) => {
  for (let i = 0; i < seg * 2; i++) {
    const c = await contarLocal(page);
    if (c.pendientes === 0) return c;
    await new Promise((r) => setTimeout(r, 500));
  }
  return contarLocal(page);
};

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const visible = (page, sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  return !!e && !e.classList.contains('hidden') && e.offsetParent !== null;
}, sel);

/* ---------- prueba ---------- */
(async () => {
  web.listen(PUERTO_WEB);
  api.listen(PUERTO_API);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const errores = [];
  const base = `http://localhost:${PUERTO_WEB}/index.html`;
  const credDispositivo = jwtFalso(DISPOSITIVO, 60);

  let page = await nuevaPagina(browser, credDispositivo, false);   // sin auto-login
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errores.push(m.text()); });

  try {
    console.log('\n1. Sin sesion no se entra');
    await page.goto(base, { waitUntil: 'networkidle0' });
    await esperar(900);
    check('muestra la pantalla de acceso', await visible(page, '#v-login'));
    check('esconde el formulario', !(await visible(page, '#v-form')));
    check('esconde las pestañas', !(await visible(page, '.tabs')));
    check('ofrece el boton de Google', await visible(page, '#gbtn'));
    check('sin errores de JS', errores.length === 0,
          errores.join(' | ') + ' | 404: ' + noEncontrados.join(','));

    console.log('\n2. Iniciar sesion con la cuenta de la tablet');
    await page.click('#gbtn');
    await esperar(1200);
    check('entra a la app', await visible(page, '#v-form'));
    check('aparecen las pestañas', await visible(page, '.tabs'));
    check('guarda la sesion',
          await page.evaluate(() => (JSON.parse(localStorage.getItem('sesion') || '{}')).email) === DISPOSITIVO);
    check('AJUSTES OCULTO para la cuenta de dispositivo',
          !(await visible(page, '.tab[data-v="config"]')));
    check('bajo las listas del Maestro',
          await page.evaluate(() => JSON.parse(localStorage.getItem('listas') || '{}').rodeo?.length === 5));

    console.log('\n3. Marca, titulo y fecha');
    check('titulo en Title Case',
          (await page.$eval('.appbar h1', (e) => e.textContent)) === 'Preparto — Carga de Parto');
    check('logo izquierdo dice TRST',
          (await page.$eval('.logo', (e) => e.textContent.trim())) === 'TRST');
    check('logo AED cargado y visible',
          await page.$eval('.marca', (e) => e.complete && e.naturalWidth > 0));
    const chipsFecha = await page.$$eval('#cFecha .chip',
      (cs) => cs.map((c) => ({ txt: c.textContent.trim(), val: c.dataset.val, on: c.classList.contains('on') })));
    check('dos chips, Hoy seleccionado',
          chipsFecha.length === 2 && chipsFecha[0].on && !chipsFecha[1].on, JSON.stringify(chipsFecha));
    check('muestran DD/MM/AAAA', chipsFecha.every((c) => /^(Hoy|Ayer)\d{2}\/\d{2}\/\d{4}$/.test(c.txt)),
          JSON.stringify(chipsFecha.map((c) => c.txt)));
    check('Ayer es un dia antes',
          (new Date(chipsFecha[0].val) - new Date(chipsFecha[1].val)) / 86400000 === 1);
    check('no hay selector de fecha libre',
          await page.evaluate(() => !document.querySelector('input[type="date"]')));

    console.log('\n3b. Rodeo: campo abierto, pero numerico');
    check('sin lista en Maestro seria campo libre; con lista, desplegable',
          await page.evaluate(() => !!document.querySelector('#wrapRodeo select')));
    check('acepta un rodeo nuevo', await page.evaluate(() => rodeoValido('209')));
    check('acepta vacio', await page.evaluate(() => rodeoValido('')));
    check('rechaza el "-" de la planilla vieja', await page.evaluate(() => !rodeoValido('-')));
    check('rechaza "---"', await page.evaluate(() => !rodeoValido('---')));
    check('rechaza texto', await page.evaluate(() => !rodeoValido('campo')));

    console.log('\n4. Carga con señal');
    await cargarParto(page, '4115', '24543');
    let c = await esperarSync(page);
    check('queda sincronizado', c.total === 1 && c.ok === 1, JSON.stringify(c));
    check('llego 1 fila', filas.length === 1);
    check('nunca llego un request sin sesion', sinSesion.length === 0, JSON.stringify(sinSesion));

    console.log('\n4b. Mellizos: una ficha de calostro por cria');
    await elegirSexo(page, 8);
    await esperar(400);
    check('aparecen 2 fichas de ternero',
          await page.$$eval('#terneros .subcard', (c) => c.length) === 2);
    check('aparecen 2 fichas de calostro',
          await page.$$eval('#calostros .subcard', (c) => c.length) === 2);
    check('pide el sexo de cada cria (codigo 8 es ambiguo)',
          await page.$$eval('[data-caja^="sexoc:"]', (c) => c.length) === 2);
    check('los litros de la madre se piden una sola vez',
          await page.$$eval('[data-step^="ltsMadre"]', (b) => b.length) === 2);  // el - y el +

    // Cargar dos crias distintas, con calostro distinto
    await page.evaluate(() => {
      document.getElementById('fVaca').value = '5514';
      const ids = document.querySelectorAll('[data-ternero]');
      ['9101', '9102'].forEach((v, i) => {
        ids[i].value = v; ids[i].dispatchEvent(new Event('input', { bubbles: true }));
      });
      document.querySelector('[data-caja="sexoc:0"] [data-val="Macho"]').click();
      document.querySelector('[data-caja="sexoc:1"] [data-val="Hembra"]').click();
    });
    await esperar(300);
    check('el rotulo identifica cada cria',
          (await page.$$eval('#calostros .quien', (q) => q.map((x) => x.textContent)))
            .join(' | ').includes('9101 · Macho'),
          (await page.$$eval('#calostros .quien', (q) => q.map((x) => x.textContent))).join(' | '));

    await page.evaluate(() => {
      document.querySelector('[data-caja="ltsTernero:1"] [data-val="3"]').click();
      const orig = document.querySelectorAll('[data-origen]');
      orig[0].value = '119'; orig[0].dispatchEvent(new Event('input', { bubbles: true }));
      orig[1].value = '226'; orig[1].dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#btnGuardar');
    await esperar(500);
    const doble = await leerPayload(page, '5514');
    check('guarda 2 terneros', doble && doble.terneros.length === 2, JSON.stringify(doble && doble.terneros));
    check('cada uno con su sexo',
          doble.terneros[0].sexo === 'Macho' && doble.terneros[1].sexo === 'Hembra');
    check('cada uno con su calostro',
          doble.terneros[0].calostro.lts_ternero === '4' &&
          doble.terneros[1].calostro.lts_ternero === '3',
          JSON.stringify(doble.terneros.map((t) => t.calostro.lts_ternero)));
    check('cada uno con su vaca origen',
          doble.terneros[0].calostro.id_vaca_origen === '119' &&
          doble.terneros[1].calostro.id_vaca_origen === '226');
    check('los litros de la madre van al parto, no a la cria',
          doble.lts_madre !== undefined && doble.terneros[0].calostro.lts_madre === undefined);
    await esperarSync(page, 12);
    check('el servidor escribio 2 filas', filas.filter((f) => f.vaca === '5514').length === 2);

    console.log('\n4c. Mellizos con una cria muerta');
    await elegirSexo(page, 8);
    await esperar(300);
    await page.evaluate(() => {
      document.getElementById('fVaca').value = '5515';
      const ids = document.querySelectorAll('[data-ternero]');
      ids[0].value = '9200'; ids[0].dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-caja="sexoc:0"] [data-val="Macho"]').click();
      document.querySelector('[data-caja="sexoc:1"] [data-val="Hembra"]').click();
      document.querySelector('[data-caja="vive:1"] [data-val="Muerto"]').click();
    });
    await esperar(400);
    check('la cria muerta pierde su ficha de calostro',
          await page.$$eval('#calostros .subcard', (c) => c.length) === 1);
    await page.click('#btnGuardar');
    await esperar(500);
    const conMuerta = await leerPayload(page, '5515');
    check('guarda igual las 2 crias', conMuerta && conMuerta.terneros.length === 2);
    check('la muerta va marcada', conMuerta.terneros[1].vive === false);
    check('y sin calostro', conMuerta.terneros[1].calostro === undefined);
    check('no exige ID para la cria muerta', conMuerta.terneros[1].id_ternero === '');

    console.log('\n4d. Volver a parto simple');
    await elegirSexo(page, 6);
    await esperar(400);
    check('vuelve a 1 ficha de ternero',
          await page.$$eval('#terneros .subcard', (c) => c.length) === 1);
    check('y 1 de calostro', await page.$$eval('#calostros .subcard', (c) => c.length) === 1);
    check('no pregunta el sexo (el codigo 6 ya lo dice)',
          await page.$$eval('[data-caja^="sexoc:"]', (c) => c.length) === 0);

    console.log('\n5. Sin señal — lo que pasa en el corral');
    // Contadores relativos: las secciones anteriores ya dejaron partos cargados.
    const registrosAntes = (await contarLocal(page)).total;
    const filasAntes = filas.length;
    await page.setOfflineMode(true);
    await page.evaluate(() => dispatchEvent(new Event('offline')));
    await cargarParto(page, '208', '9093');
    await cargarParto(page, '214', '9094');
    await cargarParto(page, '123', '9095');
    c = await contarLocal(page);
    check('los 3 quedaron guardados',
          c.total === registrosAntes + 3 && c.pendientes === 3, JSON.stringify(c));
    check('el servidor no recibio nada', filas.length === filasAntes, 'filas=' + filas.length);
    check('el badge avisa sin señal',
          /Sin señal/.test(await page.$eval('#badgeTxt', (e) => e.textContent)));

    console.log('\n6. Cerrar la app y reabrirla SIN señal (con la sesion cacheada)');
    await page.close();
    page = await nuevaPagina(browser, credDispositivo, false);
    page.on('pageerror', (e) => errores.push(String(e)));
    await page.setOfflineMode(true);
    let abrio = true;
    try { await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 15000 }); }
    catch (e) { abrio = false; }
    check('la app abre sin conexion', abrio);
    await esperar(900);
    check('NO pide login otra vez', !(await visible(page, '#v-login')));
    check('muestra el formulario', await visible(page, '#v-form'));
    c = await contarLocal(page);
    check('los 3 partos sobrevivieron',
          c.total === registrosAntes + 3 && c.pendientes === 3, JSON.stringify(c));

    console.log('\n7. Vuelve la señal');
    await page.setOfflineMode(false);
    await page.evaluate(() => { window.__auto = true; dispatchEvent(new Event('online')); });
    c = await esperarSync(page, 15);
    check('no quedan pendientes', c.pendientes === 0, JSON.stringify(c));
    check('llegaron las 3 filas que faltaban', filas.length === filasAntes + 3,
          JSON.stringify(filas.map((f) => f.vaca)));
    check('sin duplicados: cada parto entro una sola vez',
          new Set(recibidos).size === uuidsVistos.size,
          `recibidos unicos ${new Set(recibidos).size} vs escritos ${uuidsVistos.size}`);

    console.log('\n8. Sesion vencida: la cola aguanta, no se pierde nada');
    await page.evaluate(() => {                       // credencial vencida y sin renovacion
      idToken = { valor: 'viejo', exp: Date.now() - 1000 };   // la que usa la app, en memoria
      localStorage.setItem('idToken', JSON.stringify(idToken));
      window.__auto = false;
    });
    await cargarParto(page, '999', '9099');
    await esperar(1200);
    c = await contarLocal(page);
    check('el parto queda pendiente', c.pendientes === 1, JSON.stringify(c));
    await esperar(9000);                              // que venza el intento de renovar
    c = await contarLocal(page);
    check('sigue guardado, no se perdio', c.pendientes === 1, JSON.stringify(c));
    check('el badge avisa sesion vencida',
          /Sesión vencida/.test(await page.$eval('#badgeTxt', (e) => e.textContent)),
          await page.$eval('#badgeTxt', (e) => e.textContent));
    check('no se mando nada sin credencial valida', filas.length === filasAntes + 3,
          'filas=' + filas.length);

    console.log('\n9. Renovada la sesion, se recupera solo');
    await page.evaluate((cred) => {
      window.__cred = cred; window.__auto = true;
      dispatchEvent(new Event('online'));
    }, jwtFalso(DISPOSITIVO, 60));
    c = await esperarSync(page, 15);
    check('la cola se drena', c.pendientes === 0, JSON.stringify(c));
    check('la fila llego', filas.length === filasAntes + 4, 'filas=' + filas.length);

    console.log('\n10. Reintento del mismo parto');
    const antes = filas.length;
    const uuidRepetido = await page.evaluate(() => new Promise((ok) => {
      const req = indexedDB.open('preparto', 1);
      req.onsuccess = () => {
        const s = req.result.transaction('partos', 'readwrite').objectStore('partos');
        const g = s.getAll();
        g.onsuccess = () => { const r = g.result[0]; r.estado = 'pendiente'; s.put(r); ok(r.uuid); };
      };
    }));
    await page.evaluate(() => dispatchEvent(new Event('online')));
    await esperarSync(page, 12);
    check('el servidor lo vio dos veces', recibidos.filter((u) => u === uuidRepetido).length >= 2);
    check('pero NO escribio fila nueva', filas.length === antes, `${antes} -> ${filas.length}`);

    console.log('\n11. Servidor caido');
    caidoHasta = Date.now() + 6000;
    await cargarParto(page, '5514', '9101');
    await esperar(1500);
    check('el parto quedo pendiente', (await contarLocal(page)).pendientes === 1);
    caidoHasta = 0;
    await page.evaluate(() => dispatchEvent(new Event('online')));
    check('se recupera solo', (await esperarSync(page, 15)).pendientes === 0);

    console.log('\n12. El badge no es una puerta trasera a Ajustes');
    await page.click('#badgeSync');
    await esperar(400);
    check('con cuenta de dispositivo NO abre Ajustes', !(await visible(page, '#v-config')));

    console.log('\n13. Salida de emergencia: 2 segundos sobre el logo');
    await page.evaluate(() => {
      const l = document.querySelector('.logo');
      l.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    await esperar(2400);
    check('cierra sesion y vuelve al acceso', await visible(page, '#v-login'));
    check('borro la sesion', await page.evaluate(() => localStorage.getItem('sesion') === null));

    console.log('\n14. Ajustes: visible solo para el admin');
    await page.evaluate((cred) => { window.__cred = cred; }, jwtFalso(ADMIN, 60));
    await page.click('#gbtn');
    await esperar(1500);
    check('el admin entra', await visible(page, '#v-form'));
    check('AJUSTES VISIBLE para el admin', await visible(page, '.tab[data-v="config"]'));
    await page.click('.tab[data-v="config"]');
    await esperar(300);
    check('el diagnostico muestra la sesion',
          /andresduhau@admin\.com\.ar/.test(await page.$eval('#diag', (e) => e.textContent)));
    check('ya no pide URL ni token',
          await page.evaluate(() => !document.getElementById('fUrl') && !document.getElementById('fToken')));

    console.log('\n15. Cerrar sesion desde Ajustes');
    await page.click('#btnSalir');
    await esperar(600);
    check('vuelve a la pantalla de acceso', await visible(page, '#v-login'));
    check('borro la sesion guardada',
          await page.evaluate(() => localStorage.getItem('sesion') === null));

    check('sin errores de JS en toda la corrida', errores.length === 0, errores.slice(0, 3).join(' | '));
    check('sin recursos faltantes (404)', noEncontrados.length === 0, noEncontrados.join(', '));

    console.log('\n' + (fallos ? `${fallos} PRUEBAS FALLARON` : 'todas las pruebas pasaron'));
  } catch (e) {
    console.log('\nERROR EN LA PRUEBA: ' + e.stack);
    fallos++;
  } finally {
    await browser.close();
    web.close(); api.close();
    process.exit(fallos ? 1 : 0);
  }
})();
