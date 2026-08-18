/**
 * Prueba automatizada de la PWA — `node pwa/test_pwa.js`
 *
 * Levanta un backend simulado que respeta el contrato de Apps Script
 * (idempotencia por uuid incluida) y maneja Chrome de verdad para reproducir
 * el escenario del corral: cargar sin señal, cerrar la app, reabrirla sin señal,
 * volver a tener señal y confirmar que cada parto llega UNA sola vez.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PUERTO_WEB = 8791;
const PUERTO_API = 8792;
const TOKEN = 'token-de-prueba-0123456789abcdef';
const RAIZ = __dirname;

let fallos = 0;
const check = (nombre, cond, detalle) => {
  console.log((cond ? '  ok    ' : '  FALLA ') + nombre + (cond || !detalle ? '' : '  -> ' + detalle));
  if (!cond) fallos++;
};

/* ---------- servidor estatico ---------- */
const TIPOS = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
const noEncontrados = [];
const web = http.createServer((req, res) => {
  const limpio = req.url.split('?')[0];
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
const recibidos = [];          // todo lo que llego, incluidos reintentos
const filas = [];              // lo que "se escribio en la planilla"
const uuidsVistos = new Set();
let caidoHasta = 0;            // para simular el servidor fallando

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

  if (req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    if (q.get('token') !== TOKEN) return responder({ ok: false, error: 'token invalido' });
    if (q.get('action') === 'maestro') return responder({ ok: true, listas: LISTAS });
    return responder({ ok: true, partos: [] });
  }

  let cuerpo = '';
  req.on('data', (c) => { cuerpo += c; });
  req.on('end', () => {
    let p;
    try { p = JSON.parse(cuerpo); } catch (e) { return responder({ ok: false, error: 'json' }); }
    recibidos.push(p.uuid);
    if (p.token !== TOKEN) return responder({ ok: false, error: 'token invalido' });
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
async function cargarParto(page, vaca, ternero) {
  await page.evaluate((v, t) => {
    document.getElementById('fVaca').value = v;
    const inp = document.querySelector('[data-ternero="0"]');
    inp.value = t;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }, vaca, ternero);
  await page.click('#btnGuardar');
  await new Promise((r) => setTimeout(r, 350));
}

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

/* ---------- prueba ---------- */
(async () => {
  web.listen(PUERTO_WEB);
  api.listen(PUERTO_API);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1180, height: 820 });

  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errores.push(m.text()); });

  const base = `http://localhost:${PUERTO_WEB}/index.html`;
  const api_url = `http://localhost:${PUERTO_API}/exec`;

  try {
    console.log('\n1. Arranque y configuracion');
    await page.goto(`${base}?url=${encodeURIComponent(api_url)}&token=${TOKEN}&dispositivo=tablet-test`,
                    { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 900));

    check('sin errores de JS', errores.length === 0,
          errores.join(' | ') + ' | 404: ' + noEncontrados.join(','));
    check('token fuera de la barra de direcciones', !page.url().includes(TOKEN), page.url());
    check('service worker activo',
          await page.evaluate(() => navigator.serviceWorker.ready.then(() => true)));
    check('bajo las listas del Maestro',
          await page.evaluate(() => JSON.parse(localStorage.getItem('listas') || '{}').rodeo?.length === 5));
    check('rodeo paso a ser desplegable',
          await page.evaluate(() => !!document.querySelector('#wrapRodeo select')));

    console.log('\n1b. Marca y fecha Hoy/Ayer');
    check('titulo en Title Case',
          (await page.$eval('.appbar h1', (e) => e.textContent)) === 'Preparto — Carga de Parto',
          await page.$eval('.appbar h1', (e) => e.textContent));
    check('logo izquierdo dice TRST',
          (await page.$eval('.logo', (e) => e.textContent.trim())) === 'TRST');
    check('logo AED cargado y visible',
          await page.$eval('.marca', (e) => e.complete && e.naturalWidth > 0 && e.offsetWidth > 0));
    const chipsFecha = await page.$$eval('#cFecha .chip',
      (cs) => cs.map((c) => ({ txt: c.textContent.trim(), val: c.dataset.val, on: c.classList.contains('on') })));
    check('hay dos chips de fecha', chipsFecha.length === 2, JSON.stringify(chipsFecha));
    check('Hoy viene seleccionado', chipsFecha[0].on && !chipsFecha[1].on);
    const ddmm = /^(Hoy|Ayer)\d{2}\/\d{2}\/\d{4}$/;
    check('muestran la fecha DD/MM/AAAA', chipsFecha.every((c) => ddmm.test(c.txt)),
          JSON.stringify(chipsFecha.map((c) => c.txt)));
    const dif = (new Date(chipsFecha[0].val) - new Date(chipsFecha[1].val)) / 86400000;
    check('Ayer es exactamente un dia antes', dif === 1, 'diferencia=' + dif);
    check('ya no hay selector de fecha libre',
          await page.evaluate(() => !document.querySelector('input[type="date"]')));

    console.log('\n2. Carga con señal');
    await cargarParto(page, '4115', '24543');
    let c = await esperarSync(page);
    check('queda 1 registro local', c.total === 1, JSON.stringify(c));
    check('quedo sincronizado', c.ok === 1 && c.pendientes === 0, JSON.stringify(c));
    check('llego 1 fila al servidor', filas.length === 1, JSON.stringify(filas));
    check('el formulario se limpio',
          await page.evaluate(() => document.getElementById('fVaca').value === ''));

    console.log('\n3. Sin señal — lo que pasa en el corral');
    await page.setOfflineMode(true);
    await page.evaluate(() => dispatchEvent(new Event('offline')));
    await cargarParto(page, '208', '9093');
    await cargarParto(page, '214', '9094');
    await cargarParto(page, '123', '9095');
    c = await contarLocal(page);
    check('los 3 quedaron guardados', c.total === 4, JSON.stringify(c));
    check('los 3 estan pendientes', c.pendientes === 3, JSON.stringify(c));
    check('el servidor no recibio nada', filas.length === 1, 'filas=' + filas.length);
    check('el badge avisa sin señal',
          /Sin señal/.test(await page.$eval('#badgeTxt', (e) => e.textContent)),
          await page.$eval('#badgeTxt', (e) => e.textContent));

    console.log('\n4. Cerrar la app y reabrirla SIN señal');
    await page.close();
    const page2 = await browser.newPage();
    page2.on('pageerror', (e) => errores.push(String(e)));
    await page2.setOfflineMode(true);
    let abrio = true;
    try {
      await page2.goto(base, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (e) { abrio = false; }
    check('la app abre sin conexion', abrio);
    await new Promise((r) => setTimeout(r, 800));
    check('sigue en pantalla el formulario',
          await page2.evaluate(() => !!document.getElementById('btnGuardar') ||
                                     !!document.querySelector('.appbar h1')));
    c = await contarLocal(page2);
    check('los 3 partos sobrevivieron', c.total === 4 && c.pendientes === 3, JSON.stringify(c));

    console.log('\n5. Vuelve la señal');
    await page2.setOfflineMode(false);
    await page2.evaluate(() => dispatchEvent(new Event('online')));
    c = await esperarSync(page2, 15);
    check('no quedan pendientes', c.pendientes === 0, JSON.stringify(c));
    check('llegaron las 4 filas', filas.length === 4, JSON.stringify(filas.map((f) => f.vaca)));
    const vacas = filas.map((f) => f.vaca).sort();
    check('sin duplicados', new Set(vacas).size === 4, vacas.join(','));
    check('los uuid del servidor son unicos', uuidsVistos.size === 4);

    console.log('\n6. Reintentos: el mismo parto mandado dos veces');
    const antes = filas.length;
    const uuidRepetido = await page2.evaluate(() => new Promise((ok) => {
      const req = indexedDB.open('preparto', 1);
      req.onsuccess = () => {
        const s = req.result.transaction('partos', 'readwrite').objectStore('partos');
        const g = s.getAll();
        g.onsuccess = () => {                       // forzar reenvio de uno ya sincronizado
          const r = g.result[0];
          r.estado = 'pendiente';
          s.put(r);
          ok(r.uuid);
        };
      };
    }));
    await page2.evaluate(() => dispatchEvent(new Event('online')));
    await esperarSync(page2, 12);
    check('el servidor lo vio dos veces', recibidos.filter((u) => u === uuidRepetido).length >= 2);
    check('pero NO escribio fila nueva', filas.length === antes, `${antes} -> ${filas.length}`);
    c = await contarLocal(page2);
    check('vuelve a quedar sincronizado', c.pendientes === 0, JSON.stringify(c));

    console.log('\n7. Servidor caido: la cola aguanta');
    caidoHasta = Date.now() + 6000;
    await cargarParto(page2, '5514', '9101');
    await new Promise((r) => setTimeout(r, 1500));
    c = await contarLocal(page2);
    check('el parto quedo pendiente, no perdido', c.pendientes === 1, JSON.stringify(c));
    caidoHasta = 0;
    await page2.evaluate(() => dispatchEvent(new Event('online')));
    c = await esperarSync(page2, 15);
    check('se recupera solo al volver el servidor', c.pendientes === 0, JSON.stringify(c));
    check('la fila llego', filas.length === antes + 1, 'filas=' + filas.length);

    console.log('\n8. Dato invalido: no se reintenta para siempre');
    await page2.evaluate(() => {
      document.getElementById('fOperario').innerHTML = '<option></option>';
    });
    await cargarParto(page2, '', '');
    c = await contarLocal(page2);
    // 1 (con senal) + 3 (sin senal) + 1 (servidor caido) = 5. El intento
    // incompleto no debe sumar ninguno.
    check('el formulario frena el guardado incompleto', c.total === 5, JSON.stringify(c));

    console.log('\n9. La fecha elegida es la que se guarda');
    await page2.evaluate(() => {                       // deshacer el sabotaje del caso 8
      document.getElementById('fOperario').innerHTML = '<option>Julio</option>';
    });
    const ayerISO = await page2.evaluate(() => {
      const ayer = [...document.querySelectorAll('#cFecha .chip')][1];
      ayer.click();
      return ayer.dataset.val;
    });
    await new Promise((r) => setTimeout(r, 250));
    await cargarParto(page2, '777', '8888');
    await esperarSync(page2, 12);
    const guardado = await page2.evaluate((v) => new Promise((ok) => {
      const req = indexedDB.open('preparto', 1);
      req.onsuccess = () => {
        const g = req.result.transaction('partos', 'readonly').objectStore('partos').getAll();
        g.onsuccess = () => ok((g.result.find((r) => r.payload.id_vaca === v) || {}).payload);
      };
    }), '777');
    check('guarda con la fecha de Ayer', guardado && guardado.fecha_parto === ayerISO,
          JSON.stringify({ esperado: ayerISO, guardado: guardado && guardado.fecha_parto }));

    console.log('\n10. Cruce de medianoche');
    const reancla = await page2.evaluate(() => {
      st.fecha = '2020-01-01';                         // simular seleccion vieja
      pintarFechas();
      const hoy = new Date();
      const iso = new Date(hoy.getTime() - hoy.getTimezoneOffset() * 60000)
        .toISOString().slice(0, 10);
      return { fecha: st.fecha, hoy: iso, marcados: document.querySelectorAll('#cFecha .chip.on').length };
    });
    check('una seleccion vencida vuelve a Hoy', reancla.fecha === reancla.hoy, JSON.stringify(reancla));
    check('queda exactamente un chip marcado', reancla.marcados === 1, JSON.stringify(reancla));

    check('sin errores de JS en toda la corrida', errores.length === 0, errores.slice(0, 3).join(' | '));
    check('sin recursos faltantes (404)', noEncontrados.length === 0, noEncontrados.join(', '));

    console.log('\n' + (fallos ? `${fallos} PRUEBAS FALLARON` : 'todas las pruebas pasaron'));
  } catch (e) {
    console.log('\nERROR EN LA PRUEBA: ' + e.message);
    fallos++;
  } finally {
    await browser.close();
    web.close(); api.close();
    process.exit(fallos ? 1 : 0);
  }
})();
