#!/usr/bin/env python3
"""Diagnostico de solo lectura de TRST Preparto: backend, PWA publicada,
planilla y (opcional) la cola exportada desde la tablet.

    python3 scripts/diagnostico.py [--vaca 1576] [--uuid UUID] [--cola cola.json]

No escribe nada: ni la planilla ni el repo. Nunca imprime id_token.
Lo usa la skill /preparto-diagnostico.
"""
import argparse
import json
import re
import subprocess
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SS_ID = '12da8wxy4tJVLHuJZp-MKlornbi2U11ISWEsgglencE8'
PAGES = 'https://amduhau88.github.io/trst-preparto/pwa/'
GWS = str(Path.home() / 'bin' / 'gws')
# Columnas de Registros (ver COL en Codigo.gs)
C_OPER, C_VACA, C_FECHA, C_SEXO, C_IDPARTO, C_CRIA, C_UUID, C_CARGADO, C_DISP, C_ANUL = 0, 1, 2, 5, 23, 24, 25, 26, 27, 28


def h(t):
    print('\n## ' + t)


def get(url, timeout=30):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read().decode('utf-8')


def url_exec():
    m = re.search(r"URL='([^']+)'", (REPO / 'config.local').read_text())
    return m.group(1) if m else None


def version_repo():
    m = re.search(r"var VERSION = '([^']+)'", (REPO / 'apps-script' / 'Codigo.gs').read_text())
    return m.group(1) if m else None


def leer(rango):
    o = subprocess.run([GWS, 'sheets', 'spreadsheets', 'values', 'get', '--params',
                        json.dumps({'spreadsheetId': SS_ID, 'range': rango})],
                       capture_output=True, text=True)
    if o.returncode:
        sys.exit('gws fallo leyendo ' + rango + ': ' + o.stderr[:300])
    return json.loads(o.stdout).get('values', [])


def sin_token(payload_json):
    try:
        p = json.loads(payload_json)
    except Exception:
        return None
    if isinstance(p, dict):
        for k in ('id_token', 'token', 'sesion_token'):
            p.pop(k, None)
    return p


PRUEBA = re.compile(r'^[a-z]+-\d+$')   # uuids de verificar.sh: simple-1787878815, oper-...


def col(r, i):
    return r[i] if len(r) > i else ''


def resumen_payload(p):
    if not isinstance(p, dict):
        return str(p)[:300]
    if 'accion' in p:  # edicion / cambio de sexo / anulacion
        return json.dumps(p, ensure_ascii=False)[:600]
    ts = [{k: t.get(k) for k in ('id_ternero', 'sexo', 'vive', 'peso') if k in t} for t in p.get('terneros', [])]
    return (f"vaca {p.get('id_vaca')} · {p.get('fecha_parto')} {p.get('hora_nacimiento', '')} · "
            f"{p.get('sexo')} · {p.get('operario')} · {p.get('dispositivo')} · terneros {ts}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--vaca')
    ap.add_argument('--uuid')
    ap.add_argument('--cola', help='JSON de «Copiar partos sin sincronizar»')
    a = ap.parse_args()

    print('# Diagnostico TRST Preparto — ' + datetime.now().strftime('%Y-%m-%d %H:%M'))

    h('1. Backend')
    vr = version_repo()
    try:
        ping = json.loads(get(url_exec() + '?action=ping'))
        vl = ping.get('version')
        print(f"ping ok={ping.get('ok')} version={vl} hoja={ping.get('hoja')}")
        print('repo   version=' + str(vr) + ('  ✓ coinciden' if vl == vr else '  ✗ NO COINCIDEN (falta «Versión: Nueva» o repo atrasado)'))
    except Exception as e:
        print('✗ ping fallo: ' + str(e) + ' (404 los primeros minutos tras publicar es normal: reintentar)')

    h('2. PWA publicada vs repo')
    for f in ('app.js', 'sw.js', 'index.html'):
        try:
            live = get(PAGES + f + '?nc=' + str(datetime.now().timestamp()))
            print(f + (': igual' if live == (REPO / 'pwa' / f).read_text() else ': ✗ DIFIERE (Pages sin publicar o repo sin push)'))
        except Exception as e:
            print(f + ': ✗ no se pudo bajar: ' + str(e))
    m = re.search(r"const CACHE = '([^']+)'", (REPO / 'pwa' / 'sw.js').read_text())
    print('CACHE del repo: ' + (m.group(1) if m else '?') + ' (la tablet muestra la suya en Diagnóstico)')

    h('3. Planilla')
    reg = leer('Registros!A1:AD5000')[1:]
    log = leer('_log!A1:F10000')[1:]
    print(f'Registros: {len(reg)} filas · _log: {len(log)} filas')
    if log:
        u = log[-1]
        print(f"ultima fila _log: {col(u, 1)} · {col(u, 4)} · {col(u, 5)}")
    uuids_reg = {col(r, C_UUID) for r in reg}
    por_uuid = defaultdict(list)
    for i, r in enumerate(log):
        por_uuid[col(r, 0)].append((i + 2, r))

    h('4. Anomalias')
    activas = defaultdict(list)   # vaca -> (fecha, uuid) de partos activos
    for r in reg:
        if col(r, C_ANUL) != 'Si':
            activas[col(r, C_VACA)].append((col(r, C_FECHA), col(r, C_UUID)))
    solo_rech = [(u, ev) for u, ev in por_uuid.items()
                 if not PRUEBA.match(u) and u not in uuids_reg and ev
                 and all(col(r, 4).startswith('rechazado') for _, r in ev)]
    print(f'uuids con solo rechazos y sin filas en Registros (sin pruebas de verificar.sh): {len(solo_rech)}')
    for u, ev in solo_rech[-15:]:
        p = sin_token(col(ev[-1][1], 2))
        print(f"  {u} · {col(ev[-1][1], 1)} · {resumen_payload(p)}\n     motivo: {col(ev[-1][1], 4)}")
        vaca = str(p.get('id_vaca', '')) if isinstance(p, dict) else ''
        fp = p.get('fecha_parto', '') if isinstance(p, dict) else ''
        fp = '/'.join(reversed(fp.split('-'))) if fp else ''
        luego = sorted({uu for f, uu in activas.get(vaca, []) if f == fp})
        print('     → ' + (f'RESUELTO: la vaca tiene parto activo ese día ({", ".join(luego)}); en la tablet queda un fantasma a Rechazar'
                           if luego else 'PENDIENTE: el parto no está en la planilla'))
    print('  (si la tablet lo muestra en verde o en Revisar: es un fantasma; desde r9 un reenvio corregido con el mismo uuid sí escribe)')
    medio = [(u, ev) for u, ev in por_uuid.items()
             if any(col(r, 4) == 'recibido' for _, r in ev) and u not in uuids_reg]
    print(f"'recibido' sin filas en Registros (escritura a medias): {len(medio)}")
    for u, ev in medio:
        print(f'  {u} · fila _log {ev[0][0]}')
    # mismo vaca + fecha con mas de un uuid activo
    dup = defaultdict(set)
    for r in reg:
        if col(r, C_ANUL) != 'Si':
            dup[(col(r, C_VACA), col(r, C_FECHA))].add(col(r, C_UUID))
    d = [(k, v) for k, v in dup.items() if len({u for u in v if not PRUEBA.match(u)}) > 1]
    print(f'misma vaca y fecha con mas de un parto activo: {len(d)}')
    for (v, f), us in d[-10:]:
        print(f'  vaca {v} {f}: {sorted(us)}')

    if a.vaca or a.uuid:
        h('5. Parto pedido: ' + (('vaca ' + a.vaca) if a.vaca else ('uuid ' + a.uuid)))
        uu = set()
        if a.uuid:
            uu.add(a.uuid)
        if a.vaca:
            uu |= {col(r, C_UUID) for r in reg if col(r, C_VACA) == a.vaca}
            for u, ev in por_uuid.items():
                for _, r in ev:
                    p = sin_token(col(r, 2))
                    if isinstance(p, dict) and str(p.get('id_vaca', '')) == a.vaca:
                        uu.add(u)
            otros = [r for r in reg if a.vaca in (col(r, 14),)]
            if otros:
                print(f'(aparece como origen de calostro en {len(otros)} filas de otras vacas)')
        if not uu:
            print('✗ ni en Registros ni en _log: el parto nunca salio de la tablet (cola, sesion o red). Pedir el volcado de la cola.')
        for u in sorted(uu):
            filas = [(i + 2, r) for i, r in enumerate(reg) if col(r, C_UUID) == u]
            print(f'\n### {u}')
            if filas:
                for n, r in filas:
                    print(f"  Registros fila {n}: vaca {col(r, C_VACA)} {col(r, C_FECHA)} {col(r, C_SEXO)} cria {col(r, C_CRIA)} "
                          f"cargado {col(r, C_CARGADO)} {col(r, C_DISP)} anulada={col(r, C_ANUL) or 'No'}")
            else:
                print('  ✗ sin filas en Registros')
            for n, r in por_uuid.get(u, []):
                print(f"  _log fila {n}: {col(r, 1)} · filas={col(r, 3)} · {col(r, 4)} · {col(r, 5)}")
                p = sin_token(col(r, 2))
                if p is not None:
                    print('     ' + resumen_payload(p))

    if a.cola:
        h('6. Cola de la tablet')
        cola = json.loads(Path(a.cola).read_text())
        print(f'{len(cola)} registros sin sincronizar')
        for r in cola:
            p = r.get('payload') or {}
            tipo = 'sexo' if r.get('cambioSexo') else 'editar' if r.get('edicion') else 'alta'
            en_reg = r.get('uuid') in uuids_reg
            en_log = r.get('uuid') in por_uuid
            print(f"  {r.get('uuid')} · {tipo} · estado={r.get('estado')} · intentos={r.get('intentos')} · "
                  f"vaca {p.get('id_vaca')} {p.get('fecha_parto')} · creado {r.get('creado')} · "
                  f"Registros={'si' if en_reg else 'no'} _log={'si' if en_log else 'no'}"
                  + (f"\n     error: {r.get('error')}" if r.get('error') else ''))
        ints = [r.get('intentos') or 0 for r in cola]
        if ints and max(ints) >= 10 and min(ints) == 0:
            print('  ⚠ intentos altos delante y ceros detrás: COLA TRABADA por el primero con muchos intentos')


if __name__ == '__main__':
    main()
