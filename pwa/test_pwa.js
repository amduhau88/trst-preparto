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

/* Modo demo: `node pwa/test_pwa.js --demo` abre Chrome a la vista, con sesion
   iniciada y el backend simulado, y se queda ahi para poder tocar la app.
   No corre ninguna asercion. Sirve para ver una version antes de publicarla
   sin escribir una sola fila en la planilla real. */
const DEMO = process.argv.includes('--demo');

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
const ediciones = [];
const filas = [];
const uuidsVistos = new Set();
const sinSesion = [];          // requests que llegaron sin credencial valida
let caidoHasta = 0;
let rechazarSesion = false;    // el backend dice "sesion:false" aunque el token parezca vivo
let colgadoHasta = 0;          // acepta la conexion y NO contesta: el WiFi "presente pero muerto"

const LISTAS = {
  operario: ['Julio', 'Griselda', 'Martin', 'Trini'],
  tipo_parto: ['1 Normal', '2 Asistido', '4 Cesarea'],
  sexo: ['1 Hembra Viva', '2 Hembras Gemelas Vivas', '4 Hembra Muerta', '6 Macho Vivo',
         '7 Macho Muerto', '8 Otros Gemelos (M+M o M+H)'],
  raza: ['Holando', 'Angus'],
  peso: Array.from({ length: 36 }, (_, i) => String(25 + i)),
  hora_nacimiento: Array.from({ length: 48 }, (_, i) =>
    String(Math.floor(i / 2)).padStart(2, '0') + ':' + (i % 2 ? '30' : '00')),
  // 0 = no se midio / no hubo calostro. La lista salta de 0 a 18 a proposito.
  calidad_sin_mejorar: ['0'].concat(Array.from({ length: 18 }, (_, i) => String(18 + i)))
    .concat(['mastitis', 'sangre', 'campo']),
  mejorado: ['Si', 'No'], calidad_mejorado: ['---'].concat(Array.from({ length: 10 }, (_, i) => String(26 + i))),
  lts_madre: Array.from({ length: 21 }, (_, i) => String(i)),
  lts_ternero: ['2', '3', '4', '5', '6'],
  tambo: ['1', '2', '3', '4'], rodeo: ['21', '23', '26', '201', '202']
};

const api = http.createServer((req, res) => {
  const responder = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
  };
  if (Date.now() < colgadoHasta) return;   // ni responde ni cierra: se cuelga
  if (Date.now() < caidoHasta) { res.writeHead(500); return res.end('caido'); }
  if (req.method === 'GET') return responder({ ok: true, hoja: 'simulada' });

  let cuerpo = '';
  req.on('data', (c) => { cuerpo += c; });
  req.on('end', () => {
    let p;
    try { p = JSON.parse(cuerpo); } catch (e) { return responder({ ok: false, error: 'json' }); }

    const datos = leerJwt(p.id_token);
    const vigente = datos && datos.exp * 1000 > Date.now() && !rechazarSesion;
    if (!vigente) {
      sinSesion.push(p.uuid || p.accion || '?');
      return responder({ ok: false, error: 'falta sesion', sesion: false });
    }

    if (p.accion === 'sesion') {
      return responder({ ok: true, email: datos.email, admin: datos.email === ADMIN });
    }
    if (p.accion === 'maestro') return responder({ ok: true, listas: LISTAS });
    // Mismo contrato que partosDelDia_: UNA entrada por cria, no por parto.
    if (p.accion === 'partos') {
      return responder({ ok: true, partos: filas.filter((f) => f.fecha === p.fecha) });
    }

    // Con cuanto calostro cuenta una vaca: el ultimo parto suyo que lo tenga medido.
    if (p.accion === 'calostro') {
      if (!p.vaca) return responder({ ok: false, error: 'falta el numero de vaca' });
      const suyas = filas.filter((f) => String(f.vaca) === String(p.vaca) &&
                                        f.madre && f.madre.calidad_sin_mejorar);
      if (!suyas.length) return responder({ ok: true, vaca: p.vaca, encontrada: false });
      const m = suyas[suyas.length - 1].madre;
      const mejor = m.mejorado === 'Si' && m.calidad_mejorado && m.calidad_mejorado !== '---';
      return responder({ ok: true, vaca: p.vaca, encontrada: true,
                         brix_natural: m.calidad_sin_mejorar, mejorado: m.mejorado,
                         brix_mejorado: mejor ? m.calidad_mejorado : '',
                         brix_final: mejor ? m.calidad_mejorado : m.calidad_sin_mejorar,
                         fecha: '2026-08-12' });
    }

    // Corregir: mismo contrato que Codigo.gs. Ubica las filas por uuid, no
    // agrega ni borra ninguna, y el peso solo lo mueve quien cargo el parto.
    if (p.accion === 'editar') {
      ediciones.push(p);
      const mias = filas.filter((f) => f.uuid === p.uuid);
      if (!mias.length) return responder({ ok: false, error: 'no existe el parto ' + p.uuid });

      const malas = [];
      let cambios = 0;
      mias.forEach((f, i) => {
        const t = (p.terneros || [])[i];
        if (p.tambo !== undefined && p.tambo !== f.tambo) { f.tambo = p.tambo; cambios++; }
        if (!t) return;
        if (t.peso !== undefined && String(t.peso) !== String(f.peso)) {
          if (p.operario !== f.operario) {
            malas.push('el peso lo carga ' + f.operario);
          } else { f.peso = t.peso; cambios++; }
        }
        if (t.calostro) { f.calostro = Object.assign({}, f.calostro, t.calostro); cambios++; }
      });
      if (malas.length) return responder({ ok: false, error: 'validacion', detalles: malas });
      return responder({ ok: true, uuid: p.uuid, cambios: cambios });
    }

    recibidos.push(p.uuid);
    if (uuidsVistos.has(p.uuid)) return responder({ ok: true, duplicado: true, uuid: p.uuid });
    if (!p.operario || !p.id_vaca) {
      return responder({ ok: false, error: 'validacion', detalles: ['faltan datos'] });
    }
    uuidsVistos.add(p.uuid);
    const n = Math.max(1, (p.terneros || []).length);
    for (let i = 0; i < n; i++) {
      const t = (p.terneros || [])[i] || {};
      filas.push({ uuid: p.uuid, vaca: p.id_vaca, cria: `${i + 1}/${n}`,
                   operario: p.operario, tambo: p.tambo, peso: t.peso, calostro: t.calostro,
                   madre: p.calostro,
                   // Lo que devuelve la accion 'partos', con los nombres del backend.
                   id_vaca: p.id_vaca, fecha: p.fecha_parto, hora: p.hora_nacimiento,
                   tipo_parto: p.tipo_parto, sexo: p.sexo, id_ternero: t.id_ternero,
                   estado_cria: t.vive === false ? 'Muerto' : 'Vivo',
                   cargado_en: (p.cargado_en || '').slice(0, 16).replace('T', ' '),
                   dispositivo: p.dispositivo });
    }
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
  await cerrarCartel(page);
}

/** El cartel de exito tapa el formulario: hay que cerrarlo para seguir cargando. */
const cerrarCartel = (page) => page.evaluate(() => {
  const m = document.getElementById('modalOk');
  if (m && !m.classList.contains('hidden')) document.getElementById('btnOtroParto').click();
});

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

/* El badge dice "Sincronizando..." mientras hay una tanda en vuelo, y el reloj
   de 30 s puede arrancar una justo cuando la prueba mira. Se espera a que quede
   quieto en vez de dormir un rato fijo y cruzar los dedos. */
const badgeQuieto = async (page, seg = 20) => {
  for (let i = 0; i < seg * 2; i++) {
    const t = await page.$eval('#badgeTxt', (e) => e.textContent);
    if (!/Sincronizando/.test(t)) return t;
    await esperar(500);
  }
  return page.$eval('#badgeTxt', (e) => e.textContent);
};
// Nada de offsetParent: en elementos position:fixed (el cartel) siempre da null,
// asi que los daria por invisibles aunque esten en pantalla.
const visible = (page, sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  if (!e) return false;
  const cs = getComputedStyle(e);
  const r = e.getBoundingClientRect();
  return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
}, sel);

/* ---------- prueba ---------- */
(async () => {
  web.listen(PUERTO_WEB);
  api.listen(PUERTO_API);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: !DEMO,
    defaultViewport: DEMO ? null : undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'].concat(DEMO ? ['--start-maximized'] : [])
  });

  const errores = [];
  const base = `http://localhost:${PUERTO_WEB}/index.html`;
  const credDispositivo = jwtFalso(DISPOSITIVO, 60);

  let page = await nuevaPagina(browser, credDispositivo, false);   // sin auto-login
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errores.push(m.text()); });

  if (DEMO) {
    const demo = await nuevaPagina(browser, jwtFalso(ADMIN, 600), true);
    demo.on('pageerror', (e) => console.log('  ERROR JS: ' + e));
    await demo.goto(base, { waitUntil: 'networkidle0' });
    await esperar(1200);
    // Se entra solo: en la demo el login de Google no aporta nada y estorba.
    await demo.evaluate(() => window.__cb && window.__cb({ credential: window.__cred }));
    await esperar(800);

    console.log(`
  Preparto ${require('fs').readFileSync(path.join(RAIZ, 'sw.js'), 'utf8')
    .match(/preparto-v\d+/)[0]} — MODO DEMO

  Chrome quedo abierto con la app. Es la version de este repo, sin publicar.

  El backend es simulado: NO escribe en la planilla real. Todo lo que cargues
  o corrijas queda en esta corrida y se pierde al cerrar.

  Que mirar:
    - El formulario ya no tiene Rodeo, y el Peso arranca en "—"
    - Guardas un parto sin pesarlo -> Partos del dia lo marca "Falta pesar"
    - El boton Pesar abre el mismo formulario con lo no editable bloqueado
    - Cambiando el Operario, el peso se niega y el calostro no

  Ctrl+C aca para cerrar todo.
`);
    // Mantener el proceso vivo hasta que se cierre Chrome o se corte a mano.
    browser.on('disconnected', () => { web.close(); api.close(); process.exit(0); });
    await new Promise(() => {});
  }

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

    console.log('\n3b. Rodeo: ya no se carga en la tablet');
    check('no hay campo de rodeo', await page.evaluate(() => !document.querySelector('#wrapRodeo')));
    check('tampoco quedo el input', await page.evaluate(() => !document.querySelector('#fRodeo')));
    check('el payload no lleva rodeo',
          await page.evaluate(() => armarPayload().rodeo === undefined));

    console.log('\n3c. Steppers: mantener apretado avanza rapido');
    const pesoAhora = () => page.$eval('#terneros .stepper .val', (e) => parseInt(e.textContent, 10));
    const pesoTxtAhora = () => page.$eval('#terneros .stepper .val', (e) => e.textContent.trim());

    const apretar = (sel) => page.evaluate((s) => {
      document.querySelector(s).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    }, sel);
    const soltar = () => page.evaluate(() => dispatchEvent(new PointerEvent('pointerup')));
    const MAS = '#terneros .stepper button[data-step$=":1"]';

    // El peso arranca sin valor: un numero puesto por la app no se distingue
    // de uno medido, y el ternero se pesa mas tarde.
    check('arranca sin pesar', (await pesoTxtAhora()) === '—', await pesoTxtAhora());
    await apretar(MAS); await soltar();
    check('el primer toque arranca en el medio de la lista', (await pesoAhora()) === 43,
          String(await pesoAhora()));

    const p0 = await pesoAhora();
    await apretar(MAS); await soltar();
    const p1 = await pesoAhora();
    check('un toque suelto suma exactamente 1', p1 === p0 + 1, `${p0} -> ${p1}`);

    await apretar(MAS);
    await esperar(1600);
    await soltar();
    const p2 = await pesoAhora();
    check('mantenerlo apretado suma varios', p2 - p1 >= 4, `${p1} -> ${p2} en 1,6s`);

    await esperar(700);
    check('al soltar, FRENA', (await pesoAhora()) === p2, `siguio hasta ${await pesoAhora()}`);

    // El caso que rompe todo: repintar destruye el boton apretado. Si el pointerup
    // se escuchara en el boton y no en window, la repeticion no pararia nunca.
    await apretar(MAS);
    await esperar(900);
    await page.evaluate(() => pintarTerneros());     // repinta: el boton deja de existir
    await soltar();
    const p3 = await pesoAhora();
    await esperar(800);
    check('frena aunque el boton se haya repintado', (await pesoAhora()) === p3,
          `siguio hasta ${await pesoAhora()}`);

    // No pasarse del maximo de Maestro (60 kg)
    await apretar(MAS);
    await esperar(3000);
    await soltar();
    check('no se pasa del maximo de la lista', (await pesoAhora()) === 60, String(await pesoAhora()));

    // Arrancar cerca del minimo: lo que se prueba es que corte en 25, no cuantos
    // pasos entran en N segundos.
    await page.evaluate(() => { st.terneros[0].peso = 28; pintarTerneros(); });
    await page.evaluate(() => {
      document.querySelector('#terneros .stepper button[data-step$=":-1"]')
        .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    await esperar(2000);
    await soltar();
    check('no baja del minimo de la lista', (await pesoAhora()) === 25, String(await pesoAhora()));

    // Dejarlo en un valor razonable para las pruebas que siguen
    await page.evaluate(() => { st.terneros[0].peso = 42; pintarTerneros(); });

    console.log('\n3d. Listas con huecos: el stepper salta, no inventa valores');
    /* La lista de Brix es 0 y despues 18 a 35. Sumando 1 y recortando contra el
       minimo, bajar desde 18 daba 17, 16, 15... valores que no estan en Maestro
       y que el backend rechaza: el parto entraba y aparecia en "Revisar" sin
       que nada en la tablet lo hubiera avisado. */
    const brixAhora = () => page.$eval('#vBrix', (e) => e.textContent.trim());
    const BRIX_MENOS = 'button[data-step="brix:-1"]';
    const BRIX_MAS = 'button[data-step="brix:1"]';

    await page.evaluate(() => { st.cal.brix = 18; pintarCalostroMadre(); });
    await apretar(BRIX_MENOS); await soltar();
    check('bajar desde 18 salta a 0, no a 17', /^0/.test(await brixAhora()), await brixAhora());
    await apretar(BRIX_MAS); await soltar();
    check('y subir desde 0 vuelve a 18', /^18/.test(await brixAhora()), await brixAhora());
    await apretar(BRIX_MENOS); await esperar(1200); await soltar();
    check('mantenerlo apretado no baja de 0', /^0/.test(await brixAhora()), await brixAhora());
    // Y 0 apaga "Mejorado": no hay calostro que mejorar.
    await apretar(BRIX_MENOS); await soltar();
    check('en 0 se apaga la caja de mejorado',
          await page.$eval('#cajaMejorado', (e) => e.classList.contains('off')));
    check('y lo explica', await visible(page, '#notaSinCalostro'));
    await page.evaluate(() => { st.cal.brix = 26; pintarCalostroMadre(); pintarCalostros(); });
    check('con un valor real vuelve a habilitarse',
          await page.$eval('#cajaMejorado', (e) => !e.classList.contains('off')));

    check('el tambo 4 esta disponible',
          await page.evaluate(() => [...document.querySelectorAll('[data-chip="tambo"]')]
            .some((b) => b.dataset.val === '4')));

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

    // La primera cria toma de su propia madre; la segunda, de otra vaca.
    await page.evaluate(() => {
      document.querySelector('[data-caja="ltsTernero:1"] [data-val="3"]').click();
      document.querySelector('[data-caja="origen:1"] [data-val="Otra vaca"]').click();
    });
    await esperar(300);
    check('con la propia madre el ID no se escribe a mano',
          await page.$eval('[data-origen="0"]', (e) => e.readOnly));
    check('y ya muestra la vaca que parió',
          await page.$eval('[data-origen="0"]', (e) => e.value) === '5514',
          await page.$eval('[data-origen="0"]', (e) => e.value));
    check('con otra vaca, si', await page.$eval('[data-origen="1"]', (e) => !e.readOnly));
    await page.evaluate(() => {
      const o = document.querySelector('[data-origen="1"]');
      o.value = '226'; o.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await esperar(1400);                      // consulta al backend (debounce 600 ms)
    check('avisa que de esa vaca no hay datos',
          /sin datos/.test(await page.$eval('[data-origen="1"]',
            (e) => e.closest('.f').querySelector('.dato').textContent)),
          await page.$eval('[data-origen="1"]', (e) => e.closest('.f').querySelector('.dato').textContent));
    await page.evaluate(() => {
      const b = document.querySelector('[data-brixternero="1"]');
      b.value = '29'; b.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#btnGuardar');
    await esperar(500);
    check('el cartel de confirmacion aparece', await visible(page, '#modalOk'));
    const textoCartel = await page.$eval('#okDetalle', (e) => e.textContent);
    check('el cartel nombra la vaca', /5514/.test(textoCartel), textoCartel);
    check('el cartel lista las dos crias',
          /9101/.test(textoCartel) && /9102/.test(textoCartel), textoCartel);
    check('el cartel dice el sexo de cada una',
          /Macho/.test(textoCartel) && /Hembra/.test(textoCartel), textoCartel);
    await cerrarCartel(page);
    check('se cierra al tocar el boton', !(await visible(page, '#modalOk')));
    const doble = await leerPayload(page, '5514');
    check('guarda 2 terneros', doble && doble.terneros.length === 2, JSON.stringify(doble && doble.terneros));
    check('cada uno con su sexo',
          doble.terneros[0].sexo === 'Macho' && doble.terneros[1].sexo === 'Hembra');
    check('cada uno con su calostro',
          doble.terneros[0].calostro.lts_ternero === '4' &&
          doble.terneros[1].calostro.lts_ternero === '3',
          JSON.stringify(doble.terneros.map((t) => t.calostro.lts_ternero)));
    check('cada uno con su origen',
          doble.terneros[0].calostro.origen === 'Propia madre' &&
          doble.terneros[1].calostro.origen === 'Otra vaca',
          JSON.stringify(doble.terneros.map((t) => t.calostro.origen)));
    check('con la propia madre, el ID de origen es la vaca que parió',
          doble.terneros[0].calostro.id_vaca_origen === '5514',
          doble.terneros[0].calostro.id_vaca_origen);
    check('con otra vaca, el que se cargó',
          doble.terneros[1].calostro.id_vaca_origen === '226');
    check('y los Brix que tomó cada una',
          doble.terneros[0].calostro.calidad_ternero === '26' &&
          doble.terneros[1].calostro.calidad_ternero === '29',
          JSON.stringify(doble.terneros.map((t) => t.calostro.calidad_ternero)));
    check('el calostro de la MADRE va al parto, no a la cria',
          doble.calostro && doble.calostro.calidad_sin_mejorar !== undefined &&
          doble.terneros[0].calostro.calidad_sin_mejorar === undefined,
          JSON.stringify(doble.calostro));
    check('los litros de la madre tambien',
          doble.lts_madre !== undefined && doble.terneros[0].calostro.lts_madre === undefined);
    await esperarSync(page, 12);
    check('el servidor escribio 2 filas', filas.filter((f) => f.vaca === '5514').length === 2);

    console.log('\n4b-bis. El codigo 2 no pregunta el sexo, y el 8 no acepta dos hembras');
    await elegirSexo(page, 2);                      // 2 Hembras Gemelas Vivas
    await esperar(400);
    check('con el codigo 2 hay 2 fichas de ternero',
          await page.$$eval('#terneros .subcard', (c) => c.length) === 2);
    check('pero NO pregunta el sexo: ya lo dice el codigo',
          await page.$$eval('[data-caja^="sexoc:"]', (c) => c.length) === 0);
    check('sigue preguntando si nacio viva',
          await page.$$eval('[data-caja^="vive:"]', (c) => c.length) === 2);

    await elegirSexo(page, 8);
    await esperar(400);
    await page.evaluate(() => {
      document.getElementById('fVaca').value = '7777';
      const ids = document.querySelectorAll('[data-ternero]');
      ['7101', '7102'].forEach((v, i) => {
        ids[i].value = v; ids[i].dispatchEvent(new Event('input', { bubbles: true }));
      });
      document.querySelector('[data-caja="sexoc:0"] [data-val="Hembra"]').click();
      document.querySelector('[data-caja="sexoc:1"] [data-val="Hembra"]').click();
    });
    await esperar(300);
    await page.click('#btnGuardar');
    await esperar(500);
    check('no guarda dos hembras con el codigo 8', !(await visible(page, '#modalOk')));
    check('y explica cual es el codigo correcto',
          /2 Hembras Gemelas Vivas/.test(await page.$eval('#toast', (e) => e.textContent)),
          await page.$eval('#toast', (e) => e.textContent));
    check('el parto NO quedo guardado', (await leerPayload(page, '7777')) === undefined);

    console.log('\n4c. Mellizos con una cria muerta');
    await elegirSexo(page, 8);
    await esperar(300);
    await page.evaluate(() => {
      document.getElementById('fVaca').value = '5515';
      const ids = document.querySelectorAll('[data-ternero]');
      // Limpiar: un rechazo anterior deja el formulario cargado (a proposito).
      ids.forEach((i) => { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
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
    check('el cartel avisa la cria muerta',
          /muerta/i.test(await page.$eval('#okDetalle', (e) => e.textContent)),
          await page.$eval('#okDetalle', (e) => e.textContent));
    await cerrarCartel(page);
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

    console.log('\n4e. Calostro de otra vaca: se consulta, no se pide de memoria');
    /* El operario no tiene por que acordarse de los Brix de una vaca que pario
       hace tres dias. Se carga el numero y la app lo trae de la planilla. */
    await page.evaluate(() => { st.cal.brix = 30; pintarCalostroMadre(); });
    await cargarParto(page, '3030', '9300');
    await esperarSync(page, 15);

    await page.evaluate(() => {
      document.querySelector('[data-caja="origen:0"] [data-val="Otra vaca"]').click();
    });
    await esperar(250);
    await page.evaluate(() => {
      const o = document.querySelector('[data-origen="0"]');
      o.value = '3030'; o.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await esperar(1500);
    const notaCal = () => page.$eval('[data-origen="0"]',
      (e) => e.closest('.f').querySelector('.dato').textContent.trim());
    check('trae los Brix de esa vaca', /30 Brix/.test(await notaCal()), await notaCal());
    check('y los deja cargados',
          (await page.$eval('[data-brixternero="0"]', (e) => e.value)) === '30',
          await page.$eval('[data-brixternero="0"]', (e) => e.value));
    // Pero el campo NUNCA se bloquea: sin señal se carga a mano y el parto entra igual.
    check('el campo sigue siendo editable',
          await page.$eval('[data-brixternero="0"]', (e) => !e.readOnly));

    // Volver a la propia madre borra lo de la otra vaca: ese dato no era suyo.
    await page.evaluate(() => {
      document.querySelector('[data-caja="origen:0"] [data-val="Propia madre"]').click();
    });
    await esperar(250);
    check('volver a la propia madre limpia el ID',
          (await page.$eval('[data-origen="0"]', (e) => e.value)) !== '3030',
          await page.$eval('[data-origen="0"]', (e) => e.value));

    console.log('\n4f. Las excepciones se apagan tocandolas de nuevo');
    /* Antes habia un chip "Valor numerico" para volver atras. Sin el, marcar
       "mastitis" sin querer no se podria deshacer mas que recargando la app. */
    const brixVisible = () => page.$eval('#vBrix', (e) => e.textContent.trim());
    await page.evaluate(() => document.querySelector('#cBrixExc [data-val="mastitis"]').click());
    await esperar(250);
    check('marcar la excepcion la muestra', /mastitis/.test(await brixVisible()), await brixVisible());
    await page.evaluate(() => document.querySelector('#cBrixExc [data-val="mastitis"]').click());
    await esperar(250);
    check('tocarla de nuevo vuelve al numero', /^\d/.test(await brixVisible()), await brixVisible());
    check('ya no existe el chip "Valor numérico"',
          await page.$$eval('#cBrixExc .chip',
            (c) => !c.some((x) => /Valor num/.test(x.textContent))));

    console.log('\n5. Sin señal — lo que pasa en el corral');
    // Contadores relativos: las secciones anteriores ya dejaron partos cargados.
    const registrosAntes = (await contarLocal(page)).total;
    const filasAntes = filas.length;
    await page.setOfflineMode(true);
    await page.evaluate(() => dispatchEvent(new Event('offline')));
    await page.evaluate((v, t) => {
      document.getElementById('fVaca').value = v;
      const i = document.querySelector('[data-ternero]');
      i.value = t; i.dispatchEvent(new Event('input', { bubbles: true }));
    }, '208', '9093');
    await page.click('#btnGuardar');
    await esperar(400);
    check('sin señal el cartel avisa que queda en espera',
          /se sincroniza/i.test(await page.$eval('#okEstado', (e) => e.textContent)),
          await page.$eval('#okEstado', (e) => e.textContent));
    await cerrarCartel(page);
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

    console.log('\n8. No poder renovar el token NO es una sesion caida');
    /* En la tablet, One Tap se apaga solo (cooldown, cookies de terceros): si
       cada timeout pintara "Sesion vencida", el cartel estaria en rojo casi todo
       el dia mintiendo. La cola tiene que aguantar sin gritar. */
    await page.evaluate(() => {                       // credencial vencida y sin renovacion
      idToken = { valor: 'viejo', exp: Date.now() - 1000 };   // la que usa la app, en memoria
      localStorage.setItem('idToken', JSON.stringify(idToken));
      fallosToken = 0; sesionVencida = false;
      window.__auto = false;
    });
    await cargarParto(page, '999', '9099');
    await esperar(1200);
    c = await contarLocal(page);
    check('el parto queda pendiente', c.pendientes === 1, JSON.stringify(c));
    await esperar(9000);                              // que venza el intento de renovar
    c = await contarLocal(page);
    check('sigue guardado, no se perdio', c.pendientes === 1, JSON.stringify(c));
    let badge = await badgeQuieto(page);
    check('el badge NO grita sesion vencida al primer fallo',
          !/Sesión vencida/.test(badge), badge);
    check('pero avisa que hay algo en espera', /en espera/.test(badge), badge);
    check('no se mando nada sin credencial valida', filas.length === filasAntes + 3,
          'filas=' + filas.length);

    console.log('\n8b. Al tercer fallo seguido si se avisa');
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => dispatchEvent(new Event('online')));
      await esperar(9500);
      await badgeQuieto(page);
    }
    badge = await badgeQuieto(page);
    check('ahora si dice sesion vencida', /Sesión vencida/.test(badge), badge);
    c = await contarLocal(page);
    check('y el parto sigue intacto', c.pendientes === 1, JSON.stringify(c));

    console.log('\n8c. Un rechazo del backend se cree a la primera');
    /* Esta es la unica senal autoritativa: el backend es el que verifica el
       token contra Google. Con un "sesion:false" no hace falta esperar tres. */
    rechazarSesion = true;
    await page.evaluate((cred) => {
      window.__cred = cred; window.__auto = true;
      fallosToken = 0; sesionVencida = false;
      idToken = { valor: cred, exp: Date.now() + 3600000 };
      localStorage.setItem('idToken', JSON.stringify(idToken));
      dispatchEvent(new Event('online'));
    }, jwtFalso(DISPOSITIVO, 60));
    await esperar(1500);
    badge = await badgeQuieto(page);
    check('el rechazo del servidor si la marca vencida', /Sesión vencida/.test(badge), badge);
    check('sin escribir ninguna fila', filas.length === filasAntes + 3, 'filas=' + filas.length);
    rechazarSesion = false;

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

    console.log('\n11b. El ternero se pesa en un segundo paso');
    const filasAntesDePesar = filas.length;
    await cargarParto(page, '7001', '8801');
    await esperarSync(page, 15);
    const recienEntrado = filas.find((f) => f.vaca === '7001');
    // El alta entra completa salvo el peso: la fila esta en la planilla desde
    // el minuto cero y Nahuel la ve, aunque falte pesar.
    check('la fila entro sin peso', recienEntrado && recienEntrado.peso === undefined,
          JSON.stringify(recienEntrado));

    const filaDe = (vaca) => page.evaluate((v) => {
      const r = [...document.querySelectorAll('.listrow')]
        .find((x) => x.querySelector('.id').textContent.trim() === v);
      if (!r) return null;
      const b = r.querySelector('[data-editar]');
      const tag = r.querySelector('.tag');
      return { pill: r.querySelector('.pill').textContent.trim(),
               tag: tag ? tag.textContent.trim() : null,
               btn: b ? b.textContent.trim() : null, txt: r.textContent };
    }, vaca);

    await page.evaluate(() => ver('list'));
    await esperar(300);
    let f7001 = await filaDe('7001');
    // La columna Estado dice UNA sola cosa: si el parto esta en la planilla.
    // Que falte pesar es otro eje, y va aparte: mezclarlos hacia que todo parto
    // recien cargado se viera en ambar aunque ya estuviera escrito.
    check('la pildora habla de sincronizacion, no del peso',
          f7001 && f7001.pill === 'Sincronizado', JSON.stringify(f7001));
    check('y falta pesar se marca aparte', f7001 && f7001.tag === 'falta pesar',
          JSON.stringify(f7001));
    check('ofrece el boton Pesar', f7001 && f7001.btn === 'Pesar', JSON.stringify(f7001));
    check('la cria se muestra sin pesar', f7001 && /sin pesar/.test(f7001.txt), (f7001 || {}).txt);
    check('el KPI cuenta los que faltan pesar',
          +(await page.$eval('#kPesar', (e) => e.textContent)) >= 1);

    const abrirFila = (vaca) => page.evaluate((v) => {
      [...document.querySelectorAll('.listrow')]
        .find((x) => x.querySelector('.id').textContent.trim() === v)
        .querySelector('[data-editar]').click();
    }, vaca);

    await abrirFila('7001');
    await esperar(500);
    check('abre el mismo formulario', await visible(page, '#v-form'));
    check('avisa que esta corrigiendo', await visible(page, '#avisoEdicion'));
    check('el peso vuelve a mostrarse sin valor', (await pesoTxtAhora()) === '—',
          await pesoTxtAhora());

    console.log('\n11c. Corrigiendo: lo que no se toca queda bloqueado');
    for (const [id, nombre] of [['fVaca', 'ID de vaca'], ['cSexo', 'codigo de sexo'],
                                ['cTipo', 'tipo de parto'], ['cFecha', 'fecha'],
                                ['fHora', 'hora']]) {
      check(`${nombre} bloqueado`,
            await page.$eval('#' + id, (e) => e.classList.contains('bloqueado')));
    }
    check('el ID del ternero tambien',
          await page.$eval('#terneros [data-ternero]', (e) => e.classList.contains('bloqueado')));
    // El tambo y el calostro SI se corrigen: son el objeto del pedido.
    check('el tambo NO esta bloqueado',
          await page.$eval('#cTambo', (e) => !e.classList.contains('bloqueado')));
    check('el pie ofrece guardar la correccion', await visible(page, '#btnGuardarEd'));
    check('y cancelar', await visible(page, '#btnCancelar'));

    console.log('\n11d. El peso lo carga quien cargo el parto');
    await apretar(MAS); await soltar();                       // 43 kg
    await page.select('#fOperario', 'Griselda');
    await page.click('#btnGuardarEd');
    await esperar(400);
    check('Griselda no puede pesar un parto de Julio', await visible(page, '#v-form'),
          'se fue de la pantalla igual');
    check('el aviso lo explica',
          /lo carga Julio/.test(await page.$eval('#toast', (e) => e.textContent)),
          await page.$eval('#toast', (e) => e.textContent));
    check('no llego ninguna correccion al servidor',
          !ediciones.some((e) => e.uuid === (filas.find((f) => f.vaca === '7001') || {}).uuid));

    await page.select('#fOperario', 'Julio');
    await page.click('#btnGuardarEd');
    await esperar(400);
    await esperarSync(page, 15);
    const pesado = filas.find((f) => f.vaca === '7001');
    check('Julio si lo pesa', pesado && pesado.peso === 43, JSON.stringify(pesado));
    check('no se agrego ninguna fila', filas.length === filasAntesDePesar + 1,
          `${filasAntesDePesar + 1} -> ${filas.length}`);
    await page.evaluate(() => ver('list'));
    await esperar(300);
    f7001 = await filaDe('7001');
    check('la lista ya no lo pide pesar', f7001 && !f7001.tag, JSON.stringify(f7001));
    check('y el boton pasa a Corregir', f7001 && f7001.btn === 'Corregir', JSON.stringify(f7001));

    console.log('\n11e. Corregir el tambo lo puede hacer cualquiera');
    await abrirFila('7001');
    await esperar(400);
    await page.select('#fOperario', 'Griselda');
    await page.evaluate(() => {
      [...document.querySelectorAll('[data-chip="tambo"]')].find((b) => b.dataset.val === '3').click();
    });
    await page.click('#btnGuardarEd');
    await esperar(400);
    await esperarSync(page, 15);
    // Reenviar el mismo peso no es pesar: no puede bloquear al resto del equipo.
    check('Griselda corrige el tambo', (filas.find((f) => f.vaca === '7001') || {}).tambo === '3',
          JSON.stringify(filas.find((f) => f.vaca === '7001')));
    check('sin tocar el peso', (filas.find((f) => f.vaca === '7001') || {}).peso === 43);
    check('y sigue sin agregar filas', filas.length === filasAntesDePesar + 1);

    console.log('\n11i. La lista muestra los partos de TODAS las tablets');
    /* Leia solo IndexedDB, asi que cada tablet veia unicamente lo suyo: con tres
       turnos y varios dispositivos, nadie tenia el dia completo delante. */
    await page.evaluate(() => ver('list'));
    await esperar(300);
    check('la lista tiene encabezados', await visible(page, '#cabecera'));
    check('y dicen que es cada cosa',
          /ID Vaca[\s\S]*Crías[\s\S]*Hora nac[\s\S]*Cargado[\s\S]*Operario/
            .test(await page.$eval('#cabecera', (e) => e.textContent)),
          await page.$eval('#cabecera', (e) => e.textContent.replace(/\s+/g, ' ')));

    const propios = await page.$$eval('.listrow', (r) => r.length);
    // Otra tablet carga un parto: llega a la planilla sin pasar por esta.
    const hoyISO = await page.evaluate(() => listaFecha);
    filas.push({ uuid: 'u-de-otra-tablet', id_vaca: '4242', vaca: '4242', fecha: hoyISO,
                 hora: '05:30', tipo_parto: '1 Normal', sexo: '1 Hembra Viva',
                 id_ternero: '9999', estado_cria: 'Vivo', peso: 41, cria: '1/1',
                 operario: 'Griselda', tambo: '1', cargado_en: hoyISO + ' 05:35',
                 dispositivo: 'tablet-2' });
    await page.evaluate(() => bajarPartosDelDia(listaFecha));
    await esperar(900);
    check('el parto de la otra tablet aparece',
          await page.$$eval('.listrow', (r) => r.length) === propios + 1,
          `${propios} -> ${await page.$$eval('.listrow', (r) => r.length)}`);
    const ajeno = await filaDe('4242');
    check('con su operario', /Griselda/.test(ajeno.txt), ajeno.txt);
    check('y ya sincronizado', ajeno.pill === 'Sincronizado', JSON.stringify(ajeno));
    // No se corrige desde aca: la correccion viaja con el registro local, que
    // en esta tablet no existe.
    check('pero no se puede corregir desde esta tablet', ajeno.btn === null,
          JSON.stringify(ajeno));
    check('y se dice por que', /otra tablet/.test(ajeno.txt), ajeno.txt);

    /* 7001 esta en las dos partes: se cargo en esta tablet y ya esta escrito en
       la planilla. Tiene que aparecer UNA vez, y con el boton local. */
    const cuantasVeces = (v) => page.$$eval('.listrow .id',
      (e, x) => e.filter((n) => n.textContent.trim() === x).length, v);
    check('un parto que esta local y en la planilla se muestra una sola vez',
          (await cuantasVeces('7001')) === 1, String(await cuantasVeces('7001')));
    check('y gana el local, que es el que sabe corregirse',
          (await filaDe('7001')).btn === 'Corregir', JSON.stringify(await filaDe('7001')));
    check('el de la otra tablet tampoco se duplica',
          (await cuantasVeces('4242')) === 1, String(await cuantasVeces('4242')));

    // Sin señal se sigue viendo lo ultimo que se supo, y se avisa.
    await page.evaluate(() => { remotosViejo = true; refrescar(); });
    await esperar(300);
    check('sin señal avisa que la lista es solo local', await visible(page, '#avisoRemotos'));
    await page.evaluate(() => bajarPartosDelDia(listaFecha));
    await esperar(900);
    check('y al volver la señal el aviso se va', !(await visible(page, '#avisoRemotos')));

    console.log('\n11f. La lista del dia y el formulario tienen fechas distintas');
    /* Era el mismo st.fecha para los dos. Cargar un parto tardio como "Ayer"
       dejaba la lista clavada en ayer, con el cartel en verde: el operario lo
       leia como que la app le habia perdido los partos de hoy. */
    await page.evaluate(() => ver('form'));
    await esperar(200);
    await page.evaluate(() => document.querySelectorAll('#cFecha .chip')[1].click());
    await esperar(400);
    const fechas = await page.evaluate(() => ({ form: st.fecha, lista: listaFecha }));
    check('el formulario se fue a ayer', fechas.form !== fechas.lista, JSON.stringify(fechas));
    await page.evaluate(() => ver('list'));
    await esperar(400);
    check('la lista siguio en hoy',
          await page.evaluate(() => document.querySelectorAll('#cListaFecha .chip')[0]
            .classList.contains('on')));
    check('y los partos de hoy siguen a la vista', !!(await filaDe('7001')));
    await page.evaluate(() => document.querySelectorAll('#cFecha .chip')[0].click());
    await esperar(300);

    console.log('\n11g. Con la cola llena, el badge no dice Sincronizado');
    caidoHasta = Date.now() + 7000;
    await page.evaluate(() => ver('form'));
    await cargarParto(page, '7777', '8877');
    await esperar(1500);
    await page.evaluate(() => dispatchEvent(new Event('online')));
    await esperar(120);                       // apenas despues del repintado del evento
    const badgeOnline = await page.$eval('#badgeTxt', (e) => e.textContent);
    check('no miente al llegar la señal', badgeOnline.trim() !== 'Sincronizado', badgeOnline);
    caidoHasta = 0;
    await page.evaluate(() => dispatchEvent(new Event('online')));
    c = await esperarSync(page, 20);
    check('y el parto entra igual cuando vuelve el servidor', c.pendientes === 0,
          JSON.stringify(c));

    console.log('\n11h. Un servidor colgado no deja el badge en Sincronizando');
    /* WiFi presente pero muerto: fetch no falla, se cuelga. Sin corte, el badge
       queda en "Sincronizando..." para siempre y el reloj de 30 s no vuelve a
       entrar porque la tanda anterior nunca termino. */
    colgadoHasta = Date.now() + 30000;
    await cargarParto(page, '7778', '8878');
    await esperar(1500);
    check('arranca la tanda',
          /Sincronizando/.test(await page.$eval('#badgeTxt', (e) => e.textContent)));
    const soltado = await badgeQuieto(page, 30);
    check('la tanda se corta sola', !/Sincronizando/.test(soltado), soltado);
    check('y el parto sigue en la cola',
          (await contarLocal(page)).pendientes === 1);
    colgadoHasta = 0;
    await page.evaluate(() => dispatchEvent(new Event('online')));
    c = await esperarSync(page, 20);
    check('entra cuando el servidor vuelve a contestar', c.pendientes === 0, JSON.stringify(c));

    console.log('\n12. El badge no es una puerta trasera a Ajustes');
    await page.click('#badgeSync');
    await esperar(400);
    check('con cuenta de dispositivo NO abre Ajustes', !(await visible(page, '#v-config')));

    console.log('\n12b. Menu de cuenta: tambien para la cuenta de dispositivo');
    /* Antes, salir de la sesion vivia en Ajustes (solo admin) y en un long-press
       escondido: un operario que entraba con la cuenta equivocada no tenia como
       salir. El chip tiene que estar para todos. */
    check('el chip de cuenta esta a la vista', await visible(page, '#cuenta'));
    await page.click('#btnCuenta');
    await esperar(250);
    let menu = await page.$eval('#menuCuenta', (e) => e.textContent);
    check('ofrece cambiar de usuario', /Cambiar de usuario/.test(menu), menu);
    check('ofrece cerrar sesion', /Cerrar sesión/.test(menu), menu);
    check('pero NO Ajustes, que es del admin', !/Ajustes de la tablet/.test(menu), menu);

    await page.click('[data-cuenta="salir"]');
    await esperar(250);
    check('cerrar sesion pide confirmacion',
          await page.$eval('#menuCuenta', (e) => /Sí, cerrar sesión/.test(e.textContent)));
    check('y todavia no salio', await visible(page, '#v-form'));
    await page.click('[data-cuenta="cancelar"]');
    await esperar(250);
    check('cancelar vuelve al menu',
          await page.$eval('#menuCuenta', (e) => /Cambiar de usuario/.test(e.textContent)));
    await page.click('#v-form');
    await esperar(250);
    check('tocar afuera cierra el menu', !(await visible(page, '#menuCuenta')));

    console.log('\n12c. Cerrar sesion NO se lleva los partos de la cola');
    caidoHasta = Date.now() + 60000;                   // que el parto quede esperando
    const quienCargo = await page.$eval('#fOperario', (e) => e.value);
    await cargarParto(page, '6060', '8060');
    await esperar(1200);
    const antesDeSalir = await contarLocal(page);
    check('el parto quedo pendiente', antesDeSalir.pendientes === 1,
          JSON.stringify(antesDeSalir));

    await page.click('#btnCuenta');
    await esperar(200);
    await page.click('[data-cuenta="salir"]');
    await esperar(200);
    check('avisa que hay partos sin sincronizar',
          await page.$eval('#menuCuenta', (e) => /sin sincronizar/.test(e.textContent)));
    await page.click('[data-cuenta="salir-ok"]');
    await esperar(600);
    check('vuelve al acceso', await visible(page, '#v-login'));
    check('borro la sesion', await page.evaluate(() => localStorage.getItem('sesion') === null));
    check('el chip de cuenta desaparece', !(await visible(page, '#cuenta')));
    const trasSalir = await contarLocal(page);
    check('la cola sigue intacta', trasSalir.total === antesDeSalir.total &&
          trasSalir.pendientes === 1, JSON.stringify(trasSalir));

    // Y quien entre despues la sube: los partos son de la tablet, no de la cuenta.
    caidoHasta = 0;
    await page.click('#gbtn');
    await esperar(1500);
    check('se vuelve a entrar', await visible(page, '#v-form'));
    c = await esperarSync(page, 20);
    check('y el parto de la cola entra igual', c.pendientes === 0, JSON.stringify(c));
    check('con el operario que lo cargo, no con el que lo subio',
          (filas.find((f) => f.vaca === '6060') || {}).operario === quienCargo,
          quienCargo + ' -> ' + JSON.stringify(filas.find((f) => f.vaca === '6060')));

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
    await page.click('#btnCuenta');
    await esperar(250);
    menu = await page.$eval('#menuCuenta', (e) => e.textContent);
    check('y su menu de cuenta si ofrece Ajustes', /Ajustes de la tablet/.test(menu), menu);
    await page.click('#btnCuenta');
    await esperar(150);
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
