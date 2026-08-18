/* Configuracion de la app. Ninguno de estos valores es secreto:
 * el CLIENT_ID va visible por diseño en cualquier aplicacion web, y la URL del
 * /exec ya no alcanza para entrar — el backend exige una sesion de Google
 * del dominio autorizado antes de escribir una sola fila.
 */
window.CONFIG = {
  URL_EXEC: 'https://script.google.com/macros/s/AKfycbw1eYQVupwun09E7jPqmE6VOvXrZycTxN8t60VISx4HlNyX6L5_uS238Sy9uxXdRkwZ/exec',
  CLIENT_ID: '55795987692-qi482a0cjf657a1884dn3tl88mc0t2e9.apps.googleusercontent.com',
  DOMINIO: 'admin.com.ar',
  // Cuanto vale la sesion cacheada sin volver a ver a Google. Es lo que permite
  // que la tablet abra y cargue partos en el corral, sin señal.
  DIAS_SESION: 30
};
