#!/usr/bin/env bash
# Verifica el /exec ya deployado contra la planilla real.
# Uso: ./scripts/verificar.sh <URL_EXEC> <TOKEN>
#
# Escribe partos de prueba en la planilla. Borrar esas filas al terminar
# (se reconocen por el operario "Julio" y las notas "PRUEBA ...").
set -uo pipefail

# Se pueden pasar por argumento o por variable de entorno. Lo recomendado es
# el entorno con TOKEN="$(pbpaste)", asi el secreto no queda en el historial.
URL="${1:-${URL:-}}"
TOKEN="${2:-${TOKEN:-}}"

# Sin token explicito, se busca en el Llavero de macOS. Es lo comodo y lo seguro:
# no queda en el historial, ni en un archivo, ni depende de que el portapapeles
# tenga lo que uno cree que tiene.
if [[ -z "$TOKEN" ]]; then
  TOKEN="$(security find-generic-password -s trst-preparto-token -w 2>/dev/null || true)"
fi

if [[ -z "$URL" || -z "$TOKEN" ]]; then
  cat >&2 <<'USO'
Falta el token.

Guardalo una sola vez en el Llavero (te lo va a pedir sin mostrarlo):

  security add-generic-password -a "$USER" -s trst-preparto-token -w

Despues alcanza con:

  source config.local && ./scripts/verificar.sh "$URL"

O, para una corrida suelta:

  TOKEN="$(pbpaste)" ./scripts/verificar.sh "$URL"
USO
  exit 2
fi

# Dos formas validas: la generica y la de dominio Workspace
# (https://script.google.com/a/macros/<dominio>/s/<id>/exec).
if [[ ! "$URL" =~ ^https://script\.google\.com/(a/macros/[^/]+|macros)/s/[^/]+/exec$ ]]; then
  echo "URL sospechosa: '$URL'" >&2
  echo "Tiene que ser la de la aplicacion web y terminar en /exec" >&2
  exit 2
fi

# Con TOKEN="$(pbpaste)" es facil que el portapapeles tenga otra cosa: la URL,
# un pedazo de codigo, lo ultimo que se copio. Sin este control fallan las 16
# pruebas con un error enganoso y el motivo real queda tapado.
# El token es un chorizo de caracteres sin espacios; cualquier otra cosa no lo es.
if [[ ! "$TOKEN" =~ ^[A-Za-z0-9._-]{16,}$ ]]; then
  echo "Lo que hay en TOKEN no tiene forma de token." >&2
  printf '  largo: %s caracteres, %s lineas\n' "${#TOKEN}" "$(grep -c '' <<<"$TOKEN")" >&2
  echo "  (se esperan 40 caracteres hexadecimales, sin espacios ni comillas)" >&2
  echo "Copia el token al portapapeles y volve a correrlo." >&2
  exit 2
fi

# Sufijo por corrida: si no, la 2a vez todo da "duplicado" y las pruebas mienten.
RUN="$(date +%s)"
FECHA="$(date +%Y-%m-%d)"
FALLOS=0

# text/plain igual que la PWA: es "simple request", no dispara el preflight
# OPTIONS que Apps Script no responde.
#
# OJO: nada de -X POST. Apps Script contesta el POST con un 302 a
# googleusercontent.com, y -X POST obligaria a curl a repetir el POST contra
# ese destino, que solo acepta GET ("No se encontro la pagina"). Sin -X, curl
# sigue el redirect como GET, que es lo correcto.
post() { curl -sSL -H 'Content-Type: text/plain' --data-binary "$1" "$URL"; }
get()  { curl -sSL "$URL?$1"; }

# Las respuestas de error de Google son paginas HTML enormes: recortar.
resumir() {
  local r="$1"
  if [[ "${r:0:1}" == "<" ]]; then
    printf 'HTML: %s' "$(sed -e 's/<[^>]*>//g' <<<"$r" | tr -s ' \n' ' ' | cut -c1-160)"
  else
    printf '%s' "$(cut -c1-300 <<<"$r")"
  fi
}

check() { # <nombre> <respuesta> <patron-esperado>
  if grep -qE "$3" <<<"$2"; then
    printf '  ok    %s\n' "$1"
  else
    FALLOS=$((FALLOS + 1))
    printf '  FALLA %s\n        esperaba /%s/\n        recibio %s\n' "$1" "$3" "$(resumir "$2")"
  fi
}

parto() { # <uuid> <id_vaca> <sexo> <terneros_json> <nota>   [TOK=... para forzar otro token]
  cat <<JSON
{"token":"${TOK:-$TOKEN}","uuid":"$1","dispositivo":"verificar.sh",
 "operario":"Julio","id_vaca":"$2","fecha_parto":"$FECHA","hora_nacimiento":"07:00",
 "tipo_parto":"1 Normal","sexo":"$3","terneros":$4,
 "lts_madre":"5",
 "calostro":{"calidad_sin_mejorar":"26","mejorado":"No","calidad_mejorado":"---"},
 "tambo":"2","notas":"PRUEBA $5 · $RUN"}
JSON
}

editar() { # <uuid> <operario> <cuerpo_json_extra>
  cat <<JSON
{"token":"$TOKEN","accion":"editar","uuid":"$1","operario":"$2",$3}
JSON
}

# Version que espera este script. Tiene que coincidir con VERSION en Codigo.gs:
# si no, lo que esta publicado no es el codigo de este repo.
VERSION_ESPERADA='r6-calostro-2026-08-26'

echo
echo "1. Conectividad"
PING="$(get 'action=ping')"
check "ping responde" "$PING" '"ok":true'
if ! grep -q "\"version\":\"$VERSION_ESPERADA\"" <<<"$PING"; then
  FALLOS=$((FALLOS + 1))
  printf '  FALLA la version publicada no es la de este repo\n'
  printf '        esperaba  %s\n' "$VERSION_ESPERADA"
  printf '        publicado %s\n' "$(sed -n 's/.*"version":"\([^"]*\)".*/\1/p' <<<"$PING" | head -1 || echo '(sin version: codigo viejo)')"
  printf '        >> Implementar -> Gestionar implementaciones -> lapiz -> Version: NUEVA\n'
  echo
  echo "Se corta aca: seguir probando contra un deploy viejo solo genera confusion."
  exit 1
fi
printf '  ok    version publicada: %s\n' "$VERSION_ESPERADA"
check "token invalido rechazado" \
      "$(post "$(TOK=token-que-no-es parto "tok-$RUN" 4115 '6 Macho Vivo' '[]' x)")" \
      'token invalido'

echo
echo "2. Parto simple"
R=$(post "$(parto "simple-$RUN" 4115 '6 Macho Vivo' \
     '[{"id_ternero":"24543","raza":"Holando","peso":42}]' simple)")
check "guarda" "$R" '"ok":true'
check "escribe 1 fila" "$R" '"filas_escritas":1'
check "devuelve id_parto" "$R" '"id_parto":"[0-9]{8}-4115-'

echo
echo "3. Mismo UUID otra vez — la prueba que mas importa"
R=$(post "$(parto "simple-$RUN" 4115 '6 Macho Vivo' \
     '[{"id_ternero":"24543","raza":"Holando","peso":42}]' simple)")
check "marca duplicado" "$R" '"duplicado":true'
# Exigir que sea una respuesta de duplicado de verdad: si no, una respuesta vacia
# (por ejemplo un curl fallado) tambien "pasaria" por no contener filas_escritas.
if ! grep -q '"duplicado":true' <<<"$R"; then
  FALLOS=$((FALLOS + 1))
  printf '  FALLA sin respuesta de duplicado, no se puede afirmar nada: %s\n' "$R"
elif grep -q '"filas_escritas"' <<<"$R"; then
  FALLOS=$((FALLOS + 1))
  printf '  FALLA el duplicado escribio filas: %s\n' "$R"
else
  printf '  ok    el duplicado no escribio filas\n'
fi

echo
echo "4. Parto doble"
R=$(post "$(parto "doble-$RUN" 5514 '2 Hembras Gemelas Vivas' \
     '[{"id_ternero":"9101","raza":"Holando","peso":32},{"id_ternero":"9102","raza":"Holando","peso":30}]' doble)")
check "escribe 2 filas" "$R" '"filas_escritas":2'

echo
echo "5. Cria muerta"
check "acepta sin ternero" \
      "$(post "$(parto "muerto-$RUN" 6865 '7 Macho Muerto' '[]' muerta)")" '"ok":true'

echo
echo "6. Validacion"
check "operario fuera de lista" \
      "$(post "$(parto "oper-$RUN" 4115 '6 Macho Vivo' \
        '[{"id_ternero":"1","raza":"Holando","peso":40}]' oper | sed 's/"Julio"/"Adrian"/')")" \
      'fuera de lista'
check "cria viva sin ternero" \
      "$(post "$(parto "viva-$RUN" 4115 '1 Hembra Viva' '[]' viva)")" 'sin datos de ternero'

echo
echo "7. Peso en un segundo paso"
R=$(post "$(parto "pesar-$RUN" 7001 '6 Macho Vivo' \
     '[{"id_ternero":"7788","raza":"Holando"}]' pesar)")
check "el alta entra sin peso" "$R" '"ok":true'
check "y escribe su fila igual" "$R" '"filas_escritas":1'

echo
echo "8. Corregir un parto del dia"
check "el que cargo el parto lo pesa" \
      "$(post "$(editar "pesar-$RUN" Julio '"terneros":[{"peso":44}]')")" '"cambios":1'
check "reenviar el mismo peso no cambia nada" \
      "$(post "$(editar "pesar-$RUN" Julio '"terneros":[{"peso":44}]')")" '"cambios":0'
check "otro operario no puede pesarlo" \
      "$(post "$(editar "pesar-$RUN" Griselda '"terneros":[{"peso":46}]')")" 'lo carga Julio'
check "pero si corrige el calostro" \
      "$(post "$(editar "pesar-$RUN" Griselda '"terneros":[{"calostro":{"lts_ternero":"5"}}]')")" \
      '"ok":true'
check "y el tambo" \
      "$(post "$(editar "pesar-$RUN" Griselda '"tambo":"3"')")" '"ok":true'
check "un uuid que no existe" \
      "$(post "$(editar "no-existe-$RUN" Julio '"terneros":[{"peso":40}]')")" 'no existe el parto'
check "un peso fuera de lista" \
      "$(post "$(editar "pesar-$RUN" Julio '"terneros":[{"peso":999}]')")" 'fuera de lista'
check "mas crias que filas" \
      "$(post "$(editar "pesar-$RUN" Julio '"terneros":[{"peso":40},{"peso":41}]')")" 'cria'

echo
echo "9. Esquema de la hoja"
# El backend escribe POR POSICION. Si alguien inserta o mueve una columna en la
# planilla, sigue escribiendo donde estaba y corrompe en silencio hasta que
# alguien lo nota a ojo. Esto es lo unico que lo detecta antes.
ESQ="$(get "action=esquema&token=$TOKEN")"
check "el encabezado coincide con el que espera el codigo" "$ESQ" '"ok":true'
if ! grep -q '"ok":true' <<<"$ESQ"; then
  printf '        diferencias: %s\n' "$(sed -n 's/.*"diferencias":\(\[[^]]*\]\).*/\1/p' <<<"$ESQ")"
  printf '        >> NO deployar hasta arreglar esto: el backend escribiria en la columna equivocada.\n'
fi
check "la hoja es Registros" "$ESQ" '"hoja":"Registros"'
check "esquema sin credencial" "$(get 'action=esquema')" 'falta sesion'

echo
echo "10. Lectura"
check "maestro con token" "$(get "action=maestro&token=$TOKEN")" '"operario":\["Julio"'
check "maestro sin credencial" "$(get 'action=maestro')" 'falta sesion'
check "maestro con token malo" "$(get 'action=maestro&token=nopenope')" 'token invalido'
check "partos del dia" "$(get "action=partos&token=$TOKEN&fecha=$FECHA")" '"ok":true'

echo
if [[ $FALLOS -eq 0 ]]; then
  echo "todas las pruebas pasaron"
  echo "recorda borrar de la planilla las filas con notas 'PRUEBA ... · $RUN'"
else
  echo "$FALLOS PRUEBAS FALLARON"
fi
exit $((FALLOS > 0))
