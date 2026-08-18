/* Configuracion de la app. Ninguno de estos valores es secreto:
 * el CLIENT_ID va visible por diseño en cualquier aplicacion web, y la URL del
 * /exec ya no alcanza para entrar — el backend exige una sesion de Google
 * del dominio autorizado antes de escribir una sola fila.
 */
window.CONFIG = {
  URL_EXEC: 'https://script.google.com/macros/s/AKfycbyqOHt_TgQmvLWGNPgSHZk9xFAJA_SRG3retUT6CajTlfYyuOniF4UjbQgp_y3COVMG/exec',
  CLIENT_ID: '55795987692-qi482a0cjf657a1884dn3tl88mc0t2e9.apps.googleusercontent.com',
  DOMINIO: 'admin.com.ar',
  // Cuanto vale la sesion cacheada sin volver a ver a Google. Es lo que permite
  // que la tablet abra y cargue partos en el corral, sin señal.
  DIAS_SESION: 30
};
