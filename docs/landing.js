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

// ---- Los botones de la galería: suenan y responden ----
//
// Web Audio y no `<audio>`: en el iPhone un `<audio>.play()` tarda decenas de
// milisegundos en arrancar y el clic se oye DESPUÉS de que el botón se hunde.
// Es la misma lección que costó tres vueltas en la app.
//
// Los archivos son los de la app —son los mismos controles— así que se piden de
// `app/`. Y solo se descargan al primer toque: quien viene a leer la página no
// tiene por qué bajarse tres sonidos que a lo mejor no usa.
const SONIDOS = {
  porton: 'app/pilder-sube.wav?v=2',
  ascensor: 'app/tic-rueda.wav',
  lobby: 'app/click-tapa.mp3?v=3',
};

let ctxAudio = null;
const bufers = {};

function despertarAudio() {
  if (ctxAudio) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctxAudio = new AC();
  // En iOS nace suspendido aunque se cree dentro del gesto.
  if (ctxAudio.state === 'suspended') ctxAudio.resume().catch(() => {});
  for (const [nombre, url] of Object.entries(SONIDOS)) {
    fetch(url)
      .then((r) => r.arrayBuffer())
      .then((bytes) => new Promise((ok, mal) => {
        // Con callbacks además de la promesa: Safari viejo solo tiene esa forma.
        const p = ctxAudio.decodeAudioData(bytes, ok, mal);
        if (p && p.then) p.then(ok, mal);
      }))
      .then((b) => { bufers[nombre] = b; })
      .catch(() => { /* sin sonido, pero el botón sigue respondiendo */ });
  }
}

function sonar(nombre) {
  const b = bufers[nombre];
  if (!ctxAudio || ctxAudio.state !== 'running' || !b) return;
  try {
    const f = ctxAudio.createBufferSource();
    f.buffer = b;
    f.connect(ctxAudio.destination);
    f.start();
  } catch (e) { /* ignore */ }
}

for (const boton of document.querySelectorAll('.boton-demo')) {
  // El audio se desbloquea en el `pointerdown`, que es el gesto que iOS acepta;
  // el sonido sale en el `click`, con la animación.
  boton.addEventListener('pointerdown', despertarAudio, { passive: true });
  boton.addEventListener('click', () => {
    sonar(boton.dataset.sonido);
    // Se quita y se vuelve a poner para que pulsar dos veces seguidas repita la
    // animación: si no, la segunda vez no pasa nada porque la clase ya estaba.
    boton.classList.remove('pulsado');
    void boton.offsetWidth;   // fuerza el reflow que reinicia la animación
    boton.classList.add('pulsado');

    // El que tiene capa enciende su "LLEGANDO" y lo apaga solo. Va por su
    // cuenta y no con `pulsado`, que dura cuatro décimas: un ascensor que
    // llega no llega en cuatro décimas.
    if (boton.classList.contains('capas')) {
      clearTimeout(boton._reloj);
      boton.classList.add('llegando');
      boton._reloj = setTimeout(() => boton.classList.remove('llegando'), 1600);
    }
  });
  boton.addEventListener('animationend', () => boton.classList.remove('pulsado'));
}

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
