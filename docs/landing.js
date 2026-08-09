// La página pública: el formulario y los botones de WhatsApp.
//
// Sin frameworks y sin el SDK de Firebase: el formulario es un `fetch` a una
// Function, y cargar cientos de kilobytes de SDK para mandar tres campos sería
// cobrárselo a cada visita.

// ⚠️ EL NÚMERO DE WHATSAPP VA AQUÍ, en formato internacional y sin signos:
// '584141234567'. Mientras esté vacío los botones de WhatsApp se esconden
// solos — es mejor que no exista a que exista y no lleve a ninguna parte.
const WHATSAPP = '';

const MENSAJE_WA = 'Hola, vi ViYi y quiero saber cómo ponerlo en mi edificio.';
const ENDPOINT = 'https://us-central1-viyi-25a09.cloudfunctions.net/contacto';

const $ = (id) => document.getElementById(id);

(function prepararWhatsApp() {
  const enlaces = [$('wa'), $('wa2')].filter(Boolean);
  if (!WHATSAPP) {
    // El de la portada se retira entero; el de abajo es parte de una frase, así
    // que se retira la frase con él para no dejar un "o escríbenos por" suelto.
    if ($('wa')) $('wa').remove();
    const frase = document.querySelector('.o-bien');
    if (frase) frase.remove();
    return;
  }
  const url = `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(MENSAJE_WA)}`;
  for (const a of enlaces) { a.href = url; a.target = '_blank'; }
})();

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const boton = $('enviar');
  const aviso = $('aviso');
  const decir = (txt, bien) => {
    aviso.textContent = txt;
    aviso.className = 'aviso ' + (bien ? 'bien' : 'mal');
  };

  const datos = {
    nombre: $('nombre').value.trim(),
    contacto: $('contacto-dato').value.trim(),
    lugar: $('lugar').value.trim(),
    mensaje: $('mensaje').value.trim(),
    web: $('web').value.trim(),   // la trampa para robots
  };
  if (!datos.nombre || !datos.contacto) {
    decir('Nos falta tu nombre y cómo contactarte.', false);
    return;
  }

  boton.disabled = true;
  decir('Enviando…', true);
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(datos),
    });
    if (!r.ok) throw new Error(String(r.status));
    // El formulario se vacía y el botón NO se vuelve a habilitar: mandarlo dos
    // veces no ayuda a nadie y llena la bandeja de duplicados.
    $('form').reset();
    decir('Listo. Te contactamos pronto.', true);
  } catch (err) {
    // Se dice qué hacer, no solo que falló: quien quiere contratar algo y ve
    // "error" se va, y ahí se pierde el cliente.
    boton.disabled = false;
    decir(WHATSAPP
      ? 'No se pudo enviar. Escríbenos por WhatsApp y lo resolvemos.'
      : 'No se pudo enviar. Vuelve a intentarlo en un momento.', false);
  }
});
