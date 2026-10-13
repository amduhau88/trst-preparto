#!/usr/bin/env python3
"""Ensayo de la reconstruccion de 'Datos Carga DC' sobre una COPIA de la planilla real.

    python3 scripts/ensayo_dc.py                      # el Codigo.gs del repo
    python3 scripts/ensayo_dc.py --git f83c799        # el de un commit (p. ej. el publicado)
    python3 scripts/ensayo_dc.py --codigo otro.gs

Baja Registros y Datos Carga DC con gws (UNFORMATTED_VALUE), los carga en el
sandbox de apps-script/test_local.js y corre reconstruirDC_ en memoria. Dice si
el rodeo o el tilde de Registros cambiarian y como quedaria la vista.

No escribe nada en Google. Correrlo ANTES de publicar un cambio de layout de la
vista: el 13/10/2026 mostro que publicar f83c799 pisaba 428 rodeos.
Sale con 1 si el cambio en Registros parece un layout leido corrido (algun rodeo
TRUE/FALSE, o mas de 20 cambios). Unos pocos cambios son ediciones de la vista
que el onEdit no bajo y que la reconstruccion recupera.
"""
import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SS_ID = '12da8wxy4tJVLHuJZp-MKlornbi2U11ISWEsgglencE8'
GWS = str(Path.home() / 'bin' / 'gws')
CORTE = '/* ---------- helpers de prueba ---------- */'

ENSAYO_JS = r"""
/* ---------- ensayo contra una COPIA de la planilla real ---------- */
const vivo = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const hojas = { 'Registros': crearHoja('Registros', vivo.registros.map((f) => f.slice())),
                'Datos Carga DC': crearHoja('Datos Carga DC', vivo.dc.map((f) => f.slice())) };
libro = { getName: () => 'TRST — Partos', getSpreadsheetTimeZone: () => TZ,
          getSheetByName: (n) => hojas[n], _hojas: hojas, _hoja: 'Registros' };
Object.values(hojas).forEach((h) => { h.getParent = () => libro; });
const logs = []; sandbox.Logger.log = (m) => logs.push(m);

const clave = (f) => String(f[COL.uuid]) + '|' + String(f[COL.cria]);
const vacio = (v) => (v === undefined || v === null ? '' : String(v));
const antes = {};
vivo.registros.slice(1).forEach((f) => { antes[clave(f)] = [vacio(f[COL.rodeo]), f[COL.cargado_dc] === true]; });

console.log('version del codigo   :', sandbox.VERSION);
console.log('esquema de Registros :', sandbox.esquemaOk_(libro) ? 'ok' : 'NO COINCIDE (reconstruirDC_ no hace nada)');
console.log('reconstruirDC_       :', sandbox.reconstruirDC_(libro), 'filas');
logs.forEach((m) => console.log('Logger               :', m));

let rodeos = 0, tildes = 0, rodeoBool = 0; const ej = [];
hojas['Registros'].filas.slice(1).forEach((f) => {
  const a = antes[clave(f)]; if (!a) return;
  const r = f[COL.rodeo];
  if (a[0] !== vacio(r)) {
    rodeos++; ej.push(`vaca ${f[COL.id_vaca]} rodeo: "${a[0]}" -> "${vacio(r)}"`);
    if (typeof r === 'boolean' || /^(true|false)$/i.test(vacio(r))) rodeoBool++;
  }
  if (a[1] !== (f[COL.cargado_dc] === true)) { tildes++; ej.push(`vaca ${f[COL.id_vaca]} tilde: ${a[1]} -> ${f[COL.cargado_dc] === true}`); }
});
console.log(`Registros            : ${Object.keys(antes).length} filas | rodeos que cambiarian ${rodeos} | tildes que cambiarian ${tildes}`);
ej.slice(0, 10).forEach((e) => console.log('                       ', e));
/* Unos pocos cambios son normales: ediciones de la vista que el onEdit no bajo
   (se pierde alguno al tildar rapido) y que la reconstruccion recupera, por
   diseño. Lo que delata un layout leido corrido es el rodeo TRUE/FALSE o un
   cambio masivo. */
const danio = rodeoBool > 0 || rodeos + tildes > 20;

const DC = sandbox.DC;
const dc = hojas['Datos Carga DC'].filas;
const cuerpo = dc.slice(1).filter((f) => vacio(f[0]) !== '');
const sana = typeof sandbox.filaDCok_ === 'function'
  ? (f) => sandbox.filaDCok_(f)
  : (f) => /^[^|]+\|\d+\/\d+$/.test(vacio(f[DC.clave])) && typeof f[DC.cargado] === 'boolean';
console.log('DC encabezado        :', JSON.stringify(dc[0]) === JSON.stringify(sandbox.DC_ENCABEZADOS) ? 'igual al del codigo' : 'DISTINTO del codigo');
console.log(`DC                   : ${cuerpo.length} filas | con la forma del layout ${cuerpo.filter(sana).length}` +
            ` | tildadas ${cuerpo.filter((f) => f[DC.cargado] === true).length}` +
            ` | rodeo booleano ${cuerpo.filter((f) => typeof f[DC.rodeo] === 'boolean').length}`);
if (!danio && (rodeos || tildes)) console.log('(cambios chicos: ediciones de la vista que onEdit no bajo; la reconstruccion las recupera)');
process.exit(danio ? 1 : 0);
"""


def leer(rango):
    o = subprocess.run([GWS, 'sheets', 'spreadsheets', 'values', 'get', '--params',
                        json.dumps({'spreadsheetId': SS_ID, 'range': rango,
                                    'valueRenderOption': 'UNFORMATTED_VALUE'})],
                       capture_output=True, text=True)
    if o.returncode != 0:
        sys.exit('gws fallo leyendo ' + rango + ': ' + o.stderr[:300])
    return json.loads(o.stdout).get('values', [])


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    g = ap.add_mutually_exclusive_group()
    g.add_argument('--codigo', help='ruta a un Codigo.gs (default: el del repo)')
    g.add_argument('--git', metavar='REV', help='usar el Codigo.gs de un commit')
    a = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix='ensayo_dc_'))
    if a.git:
        codigo = tmp / 'Codigo.gs'
        codigo.write_text(subprocess.run(['git', '-C', str(REPO), 'show', a.git + ':apps-script/Codigo.gs'],
                                         capture_output=True, text=True, check=True).stdout, encoding='utf-8')
    else:
        codigo = Path(a.codigo).resolve() if a.codigo else REPO / 'apps-script' / 'Codigo.gs'

    test = (REPO / 'apps-script' / 'test_local.js').read_text(encoding='utf-8')
    assert test.count(CORTE) == 1, 'no encuentro el corte del sandbox en test_local.js'
    cabeza = test.split(CORTE)[0]
    viejo = "path.join(__dirname, 'Codigo.gs')"
    assert cabeza.count(viejo) == 1, 'test_local.js ya no carga Codigo.gs como espera el ensayo'
    (tmp / 'ensayo.js').write_text(cabeza.replace(viejo, 'process.argv[2]') + ENSAYO_JS, encoding='utf-8')

    print('bajando la planilla (solo lectura)...', flush=True)
    (tmp / 'vivo.json').write_text(json.dumps({'registros': leer('Registros!A1:AE5000'),
                                               'dc': leer('Datos Carga DC!A1:T5000')}), encoding='utf-8')
    r = subprocess.run(['node', str(tmp / 'ensayo.js'), str(codigo), str(tmp / 'vivo.json')])
    print('\n' + ('OK: sin daño en Registros.' if r.returncode == 0
                  else 'OJO: Registros cambiaria como si la vista se leyera corrida. No publicar asi.'))
    sys.exit(r.returncode)


if __name__ == '__main__':
    main()
