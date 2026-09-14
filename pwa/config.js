/* Configuracion de la app. Ninguno de estos valores es secreto:
 * el CLIENT_ID va visible por diseño en cualquier aplicacion web, y la URL del
 * /exec ya no alcanza para entrar — el backend exige una sesion de Google
 * del dominio autorizado antes de escribir una sola fila.
 */
window.CONFIG = {
  URL_EXEC: 'https://script.google.com/macros/s/AKfycbwKFYj8SNgluOrJD8rIQ9PsxrkCqghkyW_UkLB8UwwRD_gfm2ol8jJOVCccki33AsZz/exec',
  CLIENT_ID: '55795987692-qi482a0cjf657a1884dn3tl88mc0t2e9.apps.googleusercontent.com',
  DOMINIO: 'admin.com.ar',
  // Cuanto vale la sesion local si el backend no entrega credencial propia
  // (backends anteriores a r7). Con r7 manda lo que diga el backend.
  DIAS_SESION: 30
};
