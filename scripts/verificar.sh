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

if [[ -z "$URL" || -z "$TOKEN" ]]; then
  cat >&2 <<'USO'
Faltan datos.

  URL='https://script.google.com/macros/s/XXXX/exec' \
  TOKEN="$(pbpaste)" \
  ./scripts/verificar.sh

(copiar el token al portapapeles antes de correrlo)
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
 "calostro":{"calidad_sin_mejorar":"26","mejorado":"No","calidad_mejorado":"---",
             "consumido":"Si","lts_madre":"5","lts_ternero":"4","id_vaca_origen":"119"},
 "tambo":"2","rodeo":"26","notas":"PRUEBA $5 · $RUN"}
JSON
}

echo
echo "1. Conectividad"
check "ping responde" "$(get 'action=ping')" '"ok":true'
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
echo "7. Lectura"
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
