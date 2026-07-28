// El ?v= va aquí y no en index.html porque este archivo se importa como módulo.
// Sin él se queda pegado en el caché del CDN (4 h) aunque app.js sí se renueve:
// pasó al cambiar el authDomain a auth.viyi.ai. Súbelo junto con el de
// index.html cada vez que cambie firebase-config.js.
import { firebaseConfig, FUNCTIONS_REGION, NOMBRE_CONDOMINIO } from './firebase-config.js?v=252';

const $ = (id) => document.getElementById(id);
const VISTAS = ['vista-cargando', 'vista-config', 'vista-email', 'vista-login', 'vista-registro', 'vista-sin-acceso', 'vista-panel'];

function mostrarVista(id) {
  VISTAS.forEach((v) => $(v).classList.toggle('oculto', v !== id));
  // El header con marca + usuario solo tiene sentido dentro del panel;
  // en login/config/sin-acceso la tarjeta central ya lleva el branding.
  document.querySelector('header').classList.toggle('oculto', id !== 'vista-panel');
  // Fuera del panel, el menú lateral siempre cerrado.
  if (id !== 'vista-panel') {
    $('menu-lateral').classList.remove('abierto');
    $('backdrop').classList.add('oculto');
  }
}

document.title = 'ViYi';

if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith('PEGA_')) {
  mostrarVista('vista-config');
} else {
  iniciar();
}

async function iniciar() {
  // Los cuatro módulos de Firebase bajan EN PARALELO, no en fila: antes cada
  // await esperaba a que terminara el anterior, cuatro viajes al CDN apilados.
  // Con señal mala (un celular en un estacionamiento) esa suma se notaba.
  const B = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const [appMod, authMod, fsMod, fnMod] = await Promise.all([
    import(`${B}firebase-app.js`),
    import(`${B}firebase-auth.js`),
    import(`${B}firebase-firestore.js`),
    import(`${B}firebase-functions.js`),
  ]);
  const { initializeApp } = appMod;
  const {
    getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut, sendPasswordResetEmail,
    createUserWithEmailAndPassword, updateProfile,
    updatePassword, reauthenticateWithCredential, EmailAuthProvider,
    GoogleAuthProvider, signInWithPopup,
  } = authMod;
  const {
    getFirestore, doc, getDoc, collection, query, where, orderBy, limit, getDocs,
  } = fsMod;
  const { getFunctions, httpsCallable } = fnMod;

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  // OJO: no forzar auth.languageCode = 'es'. Firebase solo permite EDITAR la
  // plantilla del idioma por defecto; al forzar español usa la traducción
  // automática de Google, que es de solo lectura. Dejando el default, el texto
  // en español se escribe directo en la plantilla (Authentication → Templates).
  const db = getFirestore(app);
  const functions = getFunctions(app, FUNCTIONS_REGION);
  const ejecutarComando = httpsCallable(functions, 'ejecutarComando');
  const consultarEstado = httpsCallable(functions, 'consultarEstado');
  const adminCrearUsuario = httpsCallable(functions, 'adminCrearUsuario');
  const adminActualizarUsuario = httpsCallable(functions, 'adminActualizarUsuario');
  const adminGuardarDispositivo = httpsCallable(functions, 'adminGuardarDispositivo');
  const adminEliminarDispositivo = httpsCallable(functions, 'adminEliminarDispositivo');
  const adminGuardarInmueble = httpsCallable(functions, 'adminGuardarInmueble');
  const adminEliminarInmueble = httpsCallable(functions, 'adminEliminarInmueble');
  const adminEliminarUsuario = httpsCallable(functions, 'adminEliminarUsuario');
  const adminInspeccionarDispositivo = httpsCallable(functions, 'adminInspeccionarDispositivo');
  const adminListarAccesoriosHomebridge = httpsCallable(functions, 'adminListarAccesoriosHomebridge');
  const adminAccesorioCrudo = httpsCallable(functions, 'adminAccesorioCrudo');
  const crearPase = httpsCallable(functions, 'crearPase');
  const canjearPase = httpsCallable(functions, 'canjearPase');
  const verificarEmail = httpsCallable(functions, 'verificarEmail');
  const misInvitados = httpsCallable(functions, 'misInvitados');
  const darAcceso = httpsCallable(functions, 'darAcceso');
  const enviarResetClave = httpsCallable(functions, 'enviarResetClave');
  const estadoDispositivos = httpsCallable(functions, 'estadoDispositivos');
  const adminProveedores = httpsCallable(functions, 'adminProveedores');
  const revocarPase = httpsCallable(functions, 'revocarPase');
  const actualizarMiPerfil = httpsCallable(functions, 'actualizarMiPerfil');

  let usuarioActual = null;
  let misDispositivos = [];
  let avisoTimer = null;

  // Caché del arranque instantáneo (lo primero que se pinta al refrescar).
  // Hay que reescribirla cuando algo del perfil cambia en caliente; si no, el
  // refresh pinta lo viejo hasta que conteste Firestore y parece que no se
  // guardó.
  const claveCache = (uid) => `viyi-disp-${uid}`;
  function guardarCache() {
    const uid = auth.currentUser && auth.currentUser.uid;
    if (!uid || !usuarioActual) return;
    try {
      localStorage.setItem(claveCache(uid), JSON.stringify({
        usuario: usuarioActual, dispositivos: misDispositivos, skins: skinsGaleria,
      }));
    } catch (e) { /* almacenamiento lleno o bloqueado: no es crítico */ }
  }

  // Enlace de pase entrante (?p=TOKEN, o ?pase= de enlaces viejos).
  const paramsUrl = new URLSearchParams(location.search);
  let paseTokenPendiente = paramsUrl.get('p') || paramsUrl.get('pase');
  let registroNombrePendiente = null;
  let registroApellidoPendiente = null;
  let paseEventoPendiente = '';
  let paseInvitadorPendiente = '';
  function limpiarUrlPase() {
    const u = new URL(location.href);
    u.searchParams.delete('p');
    u.searchParams.delete('pase');
    history.replaceState(null, '', u.pathname + u.search + u.hash);
  }
  // "<Nombre> te ha invitado a <evento>" en las pantallas del flujo de pase.
  function pintarEventoPase() {
    document.querySelectorAll('.pase-evento-info').forEach((el) => {
      el.textContent = '';
      if (!paseEventoPendiente) { el.classList.add('oculto'); return; }
      el.append(paseInvitadorPendiente
        ? `${paseInvitadorPendiente} te ha invitado a `
        : 'Te invitaron a ');
      const s = document.createElement('strong');
      s.textContent = paseEventoPendiente;
      el.append(s);
      el.classList.remove('oculto');
    });
  }
  const msExpira = (exp) => {
    if (!exp) return 0;
    if (typeof exp.toMillis === 'function') return exp.toMillis();
    if (typeof exp.seconds === 'number') return exp.seconds * 1000;
    return 0;
  };

  // Timestamp de Firestore → fecha corta legible ("12/07/26 14:30").
  const fmtFecha = (t) => {
    const ms = msExpira(t);
    if (!ms) return '—';
    return new Date(ms).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' });
  };

  const nombreCompleto = (u) => [u && u.nombre, u && u.apellido].filter(Boolean).join(' ');

  // Title Case: cada palabra con mayúscula inicial, salvo conectores (de, del,
  // la, y…) que quedan en minúscula (excepto cuando son la primera palabra).
  const MENORES = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'e', 'o', 'u', 'en', 'a', 'al', 'con', 'por', 'para', 'un', 'una', 'unos', 'unas', 'sin', 'lo', 'vs']);
  const tituloCase = (s) => s.split(' ')
    .map((w, i) => {
      if (!w) return w;
      const min = w.toLocaleLowerCase();
      if (i > 0 && MENORES.has(min.replace(/[.,;:]+$/, ''))) return min;
      // Baja el resto a minúscula (si no, "PARRILLA" en CAPS se quedaba igual).
      return min.charAt(0).toLocaleUpperCase() + min.slice(1);
    })
    .join(' ');
  // Misma lógica que nombrePropio en las Functions, para que lo que ves en el
  // campo sea exactamente lo que se guarda. `autocapitalize="words"` no sirve
  // aquí: es solo una pista para el teclado del móvil y en computadora no hace
  // nada, así que se aplica al salir del campo.
  const MENORES_NOMBRE = new Set([
    'de', 'del', 'la', 'las', 'los', 'y', 'e', 'da', 'das', 'do', 'dos',
    'van', 'von', 'der', 'den', 'ter', 'di', 'du', 'le', 'bin', 'ibn', 'san',
  ]);
  const nombrePropio = (s) => String(s == null ? '' : s)
    .trim().replace(/\s+/g, ' ').slice(0, 60)
    .split(' ')
    .map((p, i) => {
      if (!p) return p;
      const min = p.toLocaleLowerCase('es');
      if (i > 0 && MENORES_NOMBRE.has(min)) return min;
      // La mayúscula interna se respeta: es intencional (McDonald, DeLuca).
      const base = (p === min || p === p.toLocaleUpperCase('es')) ? min : p;
      return base.charAt(0).toLocaleUpperCase('es') + base.slice(1);
    })
    .join(' ');
  // Deja un campo de nombre en Title Case al salir de él.
  const autoNombre = (input) => input.addEventListener('blur', () => {
    input.value = nombrePropio(input.value);
  });

  const TIPO_INMUEBLE_TXT = {
    conjunto: 'Conjunto Residencial',
    residencias: 'Residencias',
    edificio: 'Edificio',
    apartamento: 'Apartamento',
    quinta: 'Quinta',
    casa: 'Casa',
    local: 'Local',
    restaurant: 'Restaurant',
  };

  const TIPOS = [
    { clave: 'puerta', titulo: 'Puertas' },
    { clave: 'cortina', titulo: 'Cortinas y persianas' },
    { clave: 'ascensor', titulo: 'Ascensores' },
    { clave: 'luz', titulo: 'Luces' },
    { clave: 'termostato', titulo: 'Termostatos' },
    { clave: 'rele', titulo: 'Relés y equipos' },
    { clave: 'otro', titulo: 'Otros' },
  ];

  // Subcategorías por tipo: segundo dropdown en el editor. Búnker es una
  // subcategoría de "puerta" (mismo grupo, pero con icono de bomba).
  const SUBTIPOS = {
    puerta: [['', 'Peatones'], ['porton', 'Vehículos'], ['bunker', 'Búnker']],
  };

  // Subtipos que traen su propio icono (cuadrado). Los demás usan el del tipo.
  const ICONO_SUBTIPO = { bunker: 'bunker', porton: 'porton' };

  // Aspectos que son una sola imagen: la foto ES el botón y el CSS le da su
  // animación al activarse (el bordado gira, el ojo de Hal palpita). Agregar
  // uno nuevo = una línea aquí + su clase en styles.css + la opción en el
  // editor + aceptarlo en adminGuardarDispositivo.
  const ASPECTOS_IMAGEN = {
    bordado: { img: 'bordado.jpg?v=1', clase: 'boton-bordado' },
    hal: { img: 'hal.jpg?v=1', clase: 'boton-hal' },
    ascensor: { img: 'ascensor.webp?v=5', clase: 'boton-ascensor' },
    bronce: { img: 'bronce.webp?v=1', clase: 'boton-bronce' },
    lobby: { img: 'lobby.webp?v=1', clase: 'boton-lobby' },
  };

  // ---- Galería de skins (colección `skins` de Firestore) ----
  // Los de arriba son código: para agregar uno hay que tocar cuatro sitios y
  // desplegar. Los de la galería son DATOS — el admin los publica desde la app
  // y aparecen solos. Siguen el mismo patrón de una imagen dentro del botón,
  // así que se inyectan en ASPECTOS_IMAGEN al cargarlos.
  // La imagen viaja en el propio documento como data URI (un WebP de 256px son
  // ~15 KB y el límite del documento es 1 MB): así no hace falta Storage y se
  // cachea junto a los dispositivos, sin pelear con el arranque instantáneo.
  const ANIMACIONES_SKIN = {
    ninguna: { id: 'ninguna', nombre: 'Quieto', clase: '' },
    girar: { id: 'girar', nombre: 'Gira', clase: 'skin-gira' },
    latido: { id: 'latido', nombre: 'Palpita', clase: 'skin-late' },
  };
  let skinsGaleria = [];   // [{ id, nombre, imagen, animacion, tipos }]

  // Mete los skins de la galería en las dos tablas que el resto del código ya
  // sabe leer, para que no haya un camino aparte para ellos.
  function aplicarSkinsGaleria(lista) {
    for (const id of Object.keys(ASPECTOS_IMAGEN)) {
      if (ASPECTOS_IMAGEN[id].galeria) delete ASPECTOS_IMAGEN[id];
    }
    skinsGaleria = Array.isArray(lista) ? lista : [];
    for (const s of skinsGaleria) {
      const anim = ANIMACIONES_SKIN[s.animacion] || ANIMACIONES_SKIN.ninguna;
      ASPECTOS_IMAGEN[s.id] = { img: s.imagen, clase: anim.clase, galeria: true };
    }
  }

  // ---- Vestuario: catálogo de aspectos elegibles por el vecino ----
  // `modos` = en qué controles funciona de verdad. Las pieles solo reestilizan
  // un botón circular, así que sirven en pulso e interruptor; las cortinas,
  // dimmers y termostatos son perillas/sliders y hoy no tienen aspectos: no se
  // ofrecen, para no prometer un cambio que no pasa.
  // `soloPuerta` = las fotos y el Jet solo tienen sentido en puertas.
  // `piel` = skin de CSS (clase en el botón). El orden es el de la galería.
  // Las pieles visten los tres tipos de control: botón circular, perilla
  // (cortina y termostato) y slider (dimmer). Cada uno tiene su CSS.
  const MODOS_PIEL = ['pulso', 'interruptor', 'cortina', 'dimmer', 'termostato'];
  const MODOS_RUEDA = ['cortina', 'termostato', 'dimmer'];   // el rodillo reemplaza el control
  const CATALOGO_ASPECTOS = [
    { id: 'normal', nombre: 'Normal', modos: MODOS_PIEL },
    { id: 'neon', nombre: 'Neón', modos: MODOS_PIEL, piel: true },
    { id: 'acero', nombre: 'Acero', modos: MODOS_PIEL, piel: true },
    { id: 'cristal', nombre: 'Cristal', modos: MODOS_PIEL, piel: true },
    { id: 'pop', nombre: 'Pop', modos: MODOS_PIEL, piel: true },
    // Cobre es de la familia perilla/slider: su foto es un knob de audio, no
    // pega en un pulsador. `imgMuestra` = con qué se previsualiza en el Locker.
    { id: 'cobre', nombre: 'Cobre', modos: ['cortina', 'termostato', 'dimmer'], piel: true, imgMuestra: 'perilla-cobre.jpg?v=1' },
    // Rueda NO es piel: reemplaza el control entero (otro gesto y otro layout),
    // como hace el Jet Switch en los portones.
    { id: 'rueda', nombre: 'Rueda', modos: MODOS_RUEDA, imgMuestra: 'rueda-marco.jpg?v=1' },
    // Ascensor: botón de llamada de acero con la flecha y el aro ámbar. `tipos`
    // en vez de `soloPuerta`: es al revés, solo tiene sentido en un ascensor.
    { id: 'ascensor', nombre: 'Llamada', modos: ['pulso'], tipos: ['ascensor'] },
    { id: 'bronce', nombre: 'Bronce', modos: ['pulso'], tipos: ['ascensor'] },
    { id: 'sabiem', nombre: 'Sabiem', modos: ['pulso'], tipos: ['ascensor'] },
    // Lobby: 'PRESIONE PARA ABRIR', así que solo en la puerta de personas
    // (subtipo vacío); en un portón de vehículos no diría lo mismo.
    { id: 'lobby', nombre: 'Lobby', modos: ['pulso'], soloPuerta: true, subtipos: [''] },
    // El mando de portón: solo en puertas de vehículos, que es lo que abre.
    { id: 'mando', nombre: 'Mando', modos: ['pulso'], soloPuerta: true, subtipos: ['porton'] },
    { id: 'hal', nombre: 'Hal', modos: ['pulso'], soloPuerta: true },
    { id: 'bordado', nombre: 'Bordado', modos: ['pulso'], soloPuerta: true },
    { id: 'argentina', nombre: 'Argentina', modos: ['pulso'], soloPuerta: true },
    { id: 'jet', nombre: 'Jet Switch', modos: ['pulso'], soloPuerta: true },
  ];
  const PIELES = CATALOGO_ASPECTOS.filter((a) => a.piel).map((a) => a.id);

  // Catálogo completo = los de código + los de la galería. Un skin de galería
  // es un botón redondo con foto, así que sirve donde el control ES un botón:
  // pulso (puertas, ascensores) e interruptor (luces, relés). `tipos` vacío =
  // sirve para cualquier tipo de dispositivo.
  const MODOS_SKIN = ['pulso', 'interruptor'];
  function catalogoAspectos() {
    return CATALOGO_ASPECTOS.concat(skinsGaleria.map((s) => ({
      id: s.id,
      nombre: s.nombre,
      modos: MODOS_SKIN,
      tipos: Array.isArray(s.tipos) && s.tipos.length ? s.tipos : null,
    })));
  }

  // Aspectos que este dispositivo puede llevar de verdad.
  const aspectosDe = (d) => catalogoAspectos().filter((a) =>
    a.modos.includes(d.modo || 'pulso')
    && (!a.soloPuerta || d.tipo === 'puerta')
    && (!a.tipos || a.tipos.includes(d.tipo || 'otro'))
    && (!a.subtipos || a.subtipos.includes(d.subtipo || '')));

  // El aspecto que se pinta: manda la elección del vecino (usuarios/{uid}.
  // aspectos[dispositivoId]); si no eligió, el que puso el admin en el
  // dispositivo. Se valida contra el catálogo por si quedó algo viejo guardado.
  // Pone la piel en las piezas que saben vestirse: el botón circular, la perilla
  // (cortina/termostato) y la tarjeta del dimmer. `raiz` puede ser una de ellas
  // o su contenedor.
  function aplicarPiel(raiz, aspecto) {
    if (!PIELES.includes(aspecto)) return;
    const clase = `piel-${aspecto}`;
    const SEL = '.boton-circular, .perilla, .control-dimmer';
    if (raiz.matches && raiz.matches(SEL)) raiz.classList.add(clase);
    raiz.querySelectorAll(SEL).forEach((el) => el.classList.add(clase));
  }

  function aspectoDe(d) {
    const mio = usuarioActual && usuarioActual.aspectos && usuarioActual.aspectos[d.id];
    const elegido = mio || d.aspecto || 'normal';
    return aspectosDe(d).some((a) => a.id === elegido) ? elegido : 'normal';
  }

  // Compat: dispositivos viejos guardados con tipo 'bunker' se tratan como
  // puerta + subtipo bunker.
  const normalizar = (d) => (d.tipo === 'bunker' ? { ...d, tipo: 'puerta', subtipo: 'bunker' } : d);

  const ICONOS = {
    candados: '<svg class="icono-candado" viewBox="0 0 40 44" width="40" height="44" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="19" width="24" height="20" rx="4"/><path d="M13 19v-6.5a7 7 0 0 1 14 0"/><circle cx="20" cy="26" r="2.4" fill="currentColor" stroke="none"/><line x1="20" y1="28.4" x2="20" y2="32.5"/></svg>',
    luz: '<svg viewBox="0 0 40 40" width="36" height="36" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="20" cy="20" r="7"/><path d="M20 4v5M20 31v5M4 20h5M31 20h5M8.7 8.7l3.5 3.5M27.8 27.8l3.5 3.5M31.3 8.7l-3.5 3.5M12.2 27.8l-3.5 3.5"/></svg>',
    ascensor: '<svg class="icono-ascensor" viewBox="0 0 40 40" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="30" height="31" rx="3"/><path class="flecha-subir" d="M12.3 12L15 8.7L17.7 12Z"/><path class="flecha-bajar" d="M20.5 8.7L25.5 8.7L23 12Z"/><path d="M11 35V16.5H26V35"/><line x1="18.5" y1="16.5" x2="18.5" y2="35"/><circle cx="30" cy="20" r="1.1" fill="currentColor"/><circle cx="30" cy="24.5" r="1.1" fill="currentColor"/></svg>',
    bunker: '<svg class="icono-bunker" viewBox="-4 0.5 40 40" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="16" cy="25" r="10.5"/><path d="M12.8 15V12Q12.8 10.7 14.1 10.7H17.9Q19.2 10.7 19.2 12V15"/><path class="mecha" d="M16 10.7C15.5 6.5 22 5.5 23.5 9.2"/><path class="mecha" d="M23.5 9.2L27.2 6.9M23.5 9.2L28.2 10.1M23.5 9.2L25.1 5.5M23.5 9.2L25.5 12.8"/></svg>',
    porton: '<svg class="icono-porton" viewBox="0 0 40 40" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 35V11Q6 8.5 8.5 8.5H31.5Q34 8.5 34 11V35"/><g class="persianas"><line x1="10.5" y1="13.5" x2="29.5" y2="13.5"/><line x1="10.5" y1="16" x2="29.5" y2="16"/><line x1="10.5" y1="18.5" x2="29.5" y2="18.5"/><line x1="10.5" y1="21" x2="29.5" y2="21"/></g><path d="M10.28 30.95C10.28 28.36 11.36 27.49 13.52 27.49L26.48 27.49C28.64 27.49 29.72 28.36 29.72 30.95L27.2 30.95Q27.2 29.58 25.04 29.58Q22.88 29.58 22.88 30.95L17.12 30.95Q17.12 29.58 14.96 29.58Q12.8 29.58 12.8 30.95Z"/><path d="M14.1 27.49C14.46 24.32 17.12 23.89 20 23.89C22.88 23.89 25.54 24.32 25.9 27.49"/><line x1="20.29" y1="23.96" x2="20.29" y2="27.49"/><circle cx="14.96" cy="31.11" r="1.85"/><circle cx="25.04" cy="31.11" r="1.85"/><circle cx="11.86" cy="28.86" r="0.82"/></svg>',
    rele: '<svg viewBox="0 0 40 40" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M20 5v14"/><path d="M28.8 11a12 12 0 1 1-17.6 0"/></svg>',
    otro: '<svg viewBox="0 0 40 40" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M20 5v14"/><path d="M28.8 11a12 12 0 1 1-17.6 0"/></svg>',
    termostato: '<svg viewBox="0 0 40 40" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 22.4V9a3 3 0 0 0-6 0v13.4a5 5 0 1 0 6 0z"/><path d="M20 15v9"/><circle cx="20" cy="26.4" r="2.4" fill="currentColor" stroke="none"/></svg>',
    arriba: '<svg viewBox="0 0 40 40" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 25l10-11 10 11"/></svg>',
    stop: '<svg viewBox="0 0 40 40" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round" aria-hidden="true"><rect x="12" y="12" width="16" height="16" rx="3"/></svg>',
    abajo: '<svg viewBox="0 0 40 40" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 15l10 11 10-11"/></svg>',
  };

  let temporizadorToast = null;
  function toast(mensaje, tipo) {
    const el = $('toast');
    el.textContent = mensaje;
    el.className = tipo === 'error' ? 'toast-error' : 'toast-ok';
    clearTimeout(temporizadorToast);
    temporizadorToast = setTimeout(() => el.classList.add('oculto'), 3500);
  }

  $('form-login').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const boton = $('btn-login');
    const error = $('error-login');
    error.classList.add('oculto');
    boton.disabled = true;
    boton.textContent = 'Entrando…';
    try {
      await signInWithEmailAndPassword(auth, $('campo-email').value.trim(), $('campo-password').value);
    } catch (err) {
      const mensajes = {
        'auth/invalid-credential': 'Correo o contraseña incorrectos.',
        'auth/user-not-found': 'Correo o contraseña incorrectos.',
        'auth/wrong-password': 'Correo o contraseña incorrectos.',
        'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos.',
      };
      error.textContent = mensajes[err.code] || 'No se pudo iniciar sesión. Intenta de nuevo.';
      error.classList.remove('oculto');
    } finally {
      boton.disabled = false;
      boton.textContent = 'Entrar';
    }
  });

  // Mostrar / ocultar la clave.
  const OJO = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  const OJO_OFF = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/><line x1="3" y1="3" x2="21" y2="21"/></svg>';
  $('btn-ver-clave').addEventListener('click', () => {
    const campo = $('campo-password');
    const ver = campo.type === 'password';
    campo.type = ver ? 'text' : 'password';
    const btn = $('btn-ver-clave');
    btn.classList.toggle('viendo', ver);
    btn.setAttribute('aria-label', ver ? 'Ocultar clave' : 'Mostrar clave');
    btn.innerHTML = ver ? OJO_OFF : OJO;
  });

  // ¿Olvidaste tu clave? -> correo de restablecimiento.
  $('btn-olvide').addEventListener('click', async (ev) => {
    const email = $('campo-email').value.trim();
    if (!email) {
      toast('Primero escribe tu email arriba.', 'error');
      $('campo-email').focus();
      return;
    }
    const b = ev.currentTarget;
    b.disabled = true;
    try {
      // Correo propio (español, con logo). El mensaje es neutro a propósito:
      // la función no revela si la cuenta existe.
      await enviarResetClave({ email });
      toast('Revisa tu correo para restablecer la clave.', 'ok');
    } catch (errFn) {
      // Si la función no está disponible, se cae al correo de Firebase para no
      // dejar a nadie sin poder recuperar su clave.
      try {
        await sendPasswordResetEmail(auth, email);
        toast('Revisa tu correo para restablecer la clave (mira también spam).', 'ok');
      } catch (err) {
        const mensajes = {
          'auth/invalid-email': 'El email no es válido.',
          'auth/user-not-found': 'No encontramos ese email. Revísalo o contacta al administrador.',
          'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos.',
        };
        toast(mensajes[err.code] || 'No se pudo enviar el correo. Intenta de nuevo.', 'error');
      }
    } finally {
      b.disabled = false;
    }
  });

  const salir = () => signOut(auth);
  $('btn-salir').addEventListener('click', salir);
  $('btn-salir-2').addEventListener('click', salir);

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      $('info-usuario').classList.add('oculto');
      // Siempre email-first (home y pase): se pide el correo primero y, según la
      // cuenta, se ofrece clave o Google (o crear cuenta si viene con pase). Así
      // el vecino solo-Google también puede entrar desde la home.
      mostrarVista('vista-email');
      // "Volver" siempre disponible: desde el login/registro se puede regresar a
      // la pantalla del correo para cambiarlo o cambiar de método.
      $('btn-volver-login').classList.remove('oculto');
      $('btn-volver-reg').classList.remove('oculto');
      // Mostrar al invitado a qué evento lo invitan (si el pase tiene evento).
      if (paseTokenPendiente) {
        verificarEmail({ token: paseTokenPendiente })
          .then((r) => {
            paseEventoPendiente = (r.data && r.data.evento) || '';
            paseInvitadorPendiente = r.data ? [r.data.porNombre, r.data.porApellido].filter(Boolean).join(' ') : '';
            pintarEventoPase();
          })
          .catch(() => {});
      }
      return;
    }
    // Botón al instante: si este usuario ya entró antes en este teléfono, se
    // pintan los controles guardados ANTES de tocar la red, y luego se
    // verifican contra Firestore y se corrigen si algo cambió. Tocar un botón
    // viejo no abre nada indebido: el backend valida activo + permiso en cada
    // acción. No aplica llegando con un pase: ese flujo crea/modifica el perfil.
    const cacheKey = claveCache(user.uid);
    let yaEnPanel = false;
    if (!paseTokenPendiente) {
      try {
        const guardado = JSON.parse(localStorage.getItem(cacheKey) || 'null');
        if (guardado && guardado.usuario && Array.isArray(guardado.dispositivos)) {
          aplicarSkinsGaleria(guardado.skins);   // antes de pintar, o salen sin foto
          pintarControles(guardado.usuario, guardado.dispositivos, true);
          yaEnPanel = true;
        }
      } catch (e) { /* caché corrupta: se ignora y carga normal */ }
    }
    if (!yaEnPanel) mostrarVista('vista-cargando');
    try {
      // Canjear un pase pendiente antes de cargar el perfil (lo puede crear).
      if (paseTokenPendiente) {
        // Google no pasa por el formulario: separa el nombre de la cuenta en
        // nombre + apellido (la primera palabra es el nombre, el resto apellido).
        if (!registroNombrePendiente && user.displayName) {
          const partes = user.displayName.trim().split(/\s+/);
          registroNombrePendiente = partes[0] || null;
          registroApellidoPendiente = partes.slice(1).join(' ') || null;
        }
        try {
          await canjearPase({ token: paseTokenPendiente, nombre: registroNombrePendiente, apellido: registroApellidoPendiente });
          toast('¡Listo! Ya tienes acceso a los dispositivos compartidos.');
        } catch (err) {
          toast((err && err.message) || 'No se pudo canjear el enlace.', 'error');
        }
        paseTokenPendiente = null;
        registroNombrePendiente = null;
        registroApellidoPendiente = null;
        limpiarUrlPase();
      }

      const perfilSnap = await getDoc(doc(db, 'usuarios', user.uid));
      if (!perfilSnap.exists() || perfilSnap.data().activo === false) {
        try { localStorage.removeItem(cacheKey); } catch (e) { /* nada */ }
        mostrarVista('vista-sin-acceso');
        return;
      }
      const usuario = perfilSnap.data();
      // Los skins de galería bajan en paralelo con los dispositivos: son datos
      // de la misma pantalla y encadenarlos sumaría otro viaje.
      const [dispositivos, skins] = await Promise.all([
        cargarDispositivos(usuario), cargarSkins(),
      ]);
      aplicarSkinsGaleria(skins);
      // Repinta con lo fresco (idempotente); solo cambia de vista si no venía
      // ya pintado desde la caché, para no sacar al usuario de otra pestaña.
      pintarControles(usuario, dispositivos, !yaEnPanel);
      guardarCache(); // para el próximo arranque instantáneo

      if (usuario.rol === 'admin') {
        cargarGestion();
        cargarRegistros();
      }
    } catch (err) {
      console.error(err);
      // Si ya se pintó desde la caché, un fallo de red no debe botar al usuario
      // a "sin acceso": se queda con lo que tiene y el backend valida al tocar.
      if (!yaEnPanel) {
        toast('Error cargando tus datos. Recarga la página.', 'error');
        mostrarVista('vista-sin-acceso');
      }
    }
  });

  // ---- Invitación por pase: primero el correo (email-first) ----
  // El botón se adapta al correo: @gmail → "Continuar con Google"; otro → "Continuar".
  // "Continuar" (correo + clave) es SIEMPRE el camino principal; Google queda como
  // botón opcional al lado. Solo se ofrece si es gmail y la cuenta NO es de
  // solo-clave: al escribir un gmail se consulta (con debounce) verificarEmail y,
  // si ya existe con clave y sin Google, ni se muestra.
  const esGmail = (email) => /@(gmail|googlemail)\.com$/i.test(String(email || '').trim());
  let forzarEmailPase = false;
  let cuentaConClave = false;
  let soloGoogle = false; // cuenta que existe con Google y SIN clave
  let verifTimer = null;
  const usarGoogle = () => (esGmail($('pase-email').value) || soloGoogle)
    && !cuentaConClave && !forzarEmailPase;
  function actualizarBotonPase() {
    $('btn-google').classList.toggle('oculto', !usarGoogle());
  }
  $('pase-email').addEventListener('input', () => {
    forzarEmailPase = false;
    cuentaConClave = false;
    soloGoogle = false;
    actualizarBotonPase();
    clearTimeout(verifTimer);
    const email = $('pase-email').value.trim();
    if (!esGmail(email)) return; // para otros correos ya se usa la clave
    verifTimer = setTimeout(async () => {
      try {
        const res = await verificarEmail({ token: paseTokenPendiente, email });
        // Solo-clave (tiene clave y no Google): mostrar "Continuar" (clave) directo.
        if ($('pase-email').value.trim() === email && res.data
          && res.data.existe && res.data.tieneClave && !res.data.tieneGoogle) {
          cuentaConClave = true;
          actualizarBotonPase();
        }
      } catch (e) { /* si falla, queda con Google (+ fallback al canjear) */ }
    }, 500);
  });

  // Invitado que entra con Google (sin crear otra cuenta). Al firmar,
  // onAuthStateChanged canjea el pase; canjearPase toma nombre/apellido/correo
  // del token de Google.
  async function entrarConGoogle() {
    const error = $('error-email');
    error.classList.add('oculto');
    $('btn-google').disabled = true;
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (err) {
      const code = err && err.code;
      let m = 'No se pudo entrar con Google.';
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') m = '';
      else if (code === 'auth/account-exists-with-different-credential') {
        m = 'Ya tienes una cuenta con ese correo. Entra con tu clave.';
        forzarEmailPase = true; // "Continuar" ya no vuelve a Google: va a la clave
        actualizarBotonPase();
      } else if (code === 'auth/operation-not-allowed') m = 'El acceso con Google aún no está habilitado.';
      else if (code === 'auth/popup-blocked') m = 'El navegador bloqueó la ventana de Google. Habilítala e intenta de nuevo.';
      if (m) { error.textContent = m; error.classList.remove('oculto'); }
      $('btn-google').disabled = false;
    }
  }
  $('btn-google').addEventListener('click', entrarConGoogle);

  $('form-email').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const error = $('error-email');
    error.classList.add('oculto');
    const email = $('pase-email').value.trim();
    if (!email.includes('@')) {
      error.textContent = 'Escribe un correo válido.';
      error.classList.remove('oculto');
      return;
    }
    const boton = $('btn-continuar');
    boton.disabled = true;
    boton.textContent = 'Verificando…';
    try {
      const res = await verificarEmail({ token: paseTokenPendiente, email });
      paseEventoPendiente = (res.data && res.data.evento) || paseEventoPendiente;
      paseInvitadorPendiente = (res.data ? [res.data.porNombre, res.data.porApellido].filter(Boolean).join(' ') : '') || paseInvitadorPendiente;
      pintarEventoPase();
      if (res.data && res.data.existe) {
        if (res.data.tieneGoogle && !res.data.tieneClave) {
          // Cuenta creada con Google y sin clave: mandarla al login sería un
          // callejón sin salida (no tiene clave y no puede crearla porque la
          // cuenta ya existe). Se le ofrece Google, aunque el correo no sea
          // gmail. El popup no se puede abrir aquí: tiene que salir del toque
          // del usuario, si no el navegador lo bloquea.
          soloGoogle = true;
          actualizarBotonPase();
          error.textContent = 'Esta cuenta entra con Google.';
          error.classList.remove('oculto');
          return;
        }
        // Ya tiene cuenta: al login (correo precargado) para poner su clave.
        $('campo-email').value = email;
        mostrarVista('vista-login');
        $('campo-password').focus();
      } else if (paseTokenPendiente) {
        // Con pase y sin cuenta: a crear cuenta (correo precargado).
        $('reg-email').value = email;
        mostrarVista('vista-registro');
        $('reg-nombre').focus();
      } else {
        // Home y sin cuenta: no se auto-registra (a los vecinos los agrega el
        // admin). Se avisa.
        error.textContent = 'No hay una cuenta con ese correo. Pídele acceso al administrador.';
        error.classList.remove('oculto');
      }
    } catch (err) {
      if (err && err.code === 'functions/not-found') {
        error.textContent = 'El enlace no es válido.';
        error.classList.remove('oculto');
      } else if (paseTokenPendiente) {
        // Con pase, si no se pudo verificar, no bloqueamos al invitado: lo
        // llevamos a crear cuenta. Si ya existe, "Ya tengo cuenta" va al login.
        $('reg-email').value = email;
        mostrarVista('vista-registro');
        $('reg-nombre').focus();
      } else {
        // Home, si no se pudo verificar: que intente con su clave.
        $('campo-email').value = email;
        mostrarVista('vista-login');
        $('campo-password').focus();
      }
    } finally {
      boton.disabled = false;
      boton.textContent = 'Continuar';
    }
  });

  // ---- Registro de invitado (solo al llegar con un enlace de pase) ----
  $('form-registro').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const boton = $('btn-registro');
    const error = $('error-registro');
    error.classList.add('oculto');
    const nombre = $('reg-nombre').value.trim();
    const apellido = $('reg-apellido').value.trim();
    const email = $('reg-email').value.trim();
    const password = $('reg-password').value;
    if (nombre.length < 2) {
      error.textContent = 'Escribe tu nombre.';
      error.classList.remove('oculto');
      return;
    }
    if (apellido.length < 2) {
      error.textContent = 'Escribe tu apellido.';
      error.classList.remove('oculto');
      return;
    }
    if (password.length < 6) {
      error.textContent = 'La clave debe tener al menos 6 caracteres.';
      error.classList.remove('oculto');
      return;
    }
    boton.disabled = true;
    boton.textContent = 'Creando…';
    registroNombrePendiente = nombre;
    registroApellidoPendiente = apellido;
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName: [nombre, apellido].filter(Boolean).join(' ') }).catch(() => {});
      // onAuthStateChanged canjea el pase y carga el panel.
    } catch (err) {
      const mensajes = {
        'auth/email-already-in-use': 'Ya existe una cuenta con ese correo. Usa "Ya tengo cuenta".',
        'auth/invalid-email': 'El correo no es válido.',
        'auth/weak-password': 'La clave es muy débil (mín. 6 caracteres).',
      };
      error.textContent = mensajes[err.code] || 'No se pudo crear la cuenta. Intenta de nuevo.';
      error.classList.remove('oculto');
      registroNombrePendiente = null;
      registroApellidoPendiente = null;
      boton.disabled = false;
      boton.textContent = 'Entrar';
    }
  });

  // "Volver": regresa a la pantalla del correo. Sin esto, quien elegía el
  // camino de la clave quedaba atrapado ahí: no podía cambiarse a Google ni
  // corregir el correo si lo escribió mal.
  function volverAlCorreo(desde) {
    const em = $(desde).value.trim();
    if (em) $('pase-email').value = em;
    // Se reinician las banderas para que la pantalla vuelva a decidir con qué
    // botones recibirlo; si Google no aplica, su propio error lo reencamina.
    forzarEmailPase = false;
    cuentaConClave = false;
    soloGoogle = false;
    $('error-email').classList.add('oculto');
    actualizarBotonPase();
    mostrarVista('vista-email');
  }
  $('btn-volver-login').addEventListener('click', () => volverAlCorreo('campo-email'));
  $('btn-volver-reg').addEventListener('click', () => volverAlCorreo('reg-email'));

  // "Ya tengo cuenta": ir al login conservando el pase pendiente y el correo.
  $('btn-ir-login').addEventListener('click', () => {
    const em = $('reg-email').value.trim();
    if (em) $('campo-email').value = em;
    mostrarVista('vista-login');
  });

  // Ojo de la clave en el registro.
  $('btn-ver-clave-reg').addEventListener('click', () => {
    const campo = $('reg-password');
    campo.type = campo.type === 'password' ? 'text' : 'password';
  });

  async function cargarDispositivos(usuario) {
    let documentos = [];
    if (usuario.rol === 'admin') {
      const alc = usuario.administraIds || [];
      if (alc.length) {
        // Admin de edificio: solo los de su alcance (mismo motivo que en Gestión).
        const partes = [];
        for (let i = 0; i < alc.length; i += 30) partes.push(alc.slice(i, i + 30));
        const res = await Promise.all(partes.map((t) => getDocs(query(
          collection(db, 'dispositivos'), where('inmueble', 'in', t),
        )).catch((err) => { console.warn('alcance', err); return null; })));
        const vistos = new Map();
        for (const r of res) if (r) for (const d of r.docs) vistos.set(d.id, d);
        documentos = [...vistos.values()].filter((s) => s.data().activo !== false);
      } else {
        const resultado = await getDocs(
          query(collection(db, 'dispositivos'), where('activo', '==', true))
        );
        documentos = resultado.docs;
      }
    } else {
      const ids = new Set(usuario.dispositivos || []);
      // Dispositivos compartidos por pases vigentes (no vencidos).
      const ahora = Date.now();
      for (const [id, info] of Object.entries(usuario.accesos || {})) {
        if (msExpira(info && info.expira) > ahora) ids.add(id);
      }
      const lecturas = await Promise.all([...ids].map((id) => getDoc(doc(db, 'dispositivos', id))));
      documentos = lecturas.filter((s) => s.exists() && s.data().activo !== false);
      // Y los del inmueble que le corresponde (su unidad más las áreas comunes
      // del edificio y del conjunto: `inmueblesIds` viene ya con los ancestros).
      // Van en una consulta y no de uno en uno porque el vecino no tiene la
      // lista; la regla de Firestore exige que venga filtrada por inmueble.
      const mios = usuario.inmueblesIds || [];
      if (mios.length) {
        // `in` admite 30 valores; una cadena de inmuebles nunca se acerca, pero
        // se acota para que un dato raro no reviente la consulta entera.
        const trozos = [];
        for (let i = 0; i < mios.length; i += 30) trozos.push(mios.slice(i, i + 30));
        // Un solo filtro a propósito: añadir `activo == true` haría falta un
        // índice compuesto, y si faltara la consulta fallaría y el vecino se
        // quedaría sin los dispositivos de su edificio sin que nada lo avise.
        // Se filtra por activo aquí abajo, que sale gratis.
        const porInmueble = await Promise.all(trozos.map((t) => getDocs(query(
          collection(db, 'dispositivos'),
          where('inmueble', 'in', t),
        )).catch((err) => { console.warn('inmueble', err); return null; })));
        for (const res of porInmueble) {
          if (!res) continue;   // sin permiso: se queda con lo explícito
          for (const s of res.docs) {
            if (!ids.has(s.id) && s.data().activo !== false) {
              ids.add(s.id);
              documentos.push(s);
            }
          }
        }
      }
    }
    return documentos
      .map((s) => normalizar({ id: s.id, ...s.data() }))
      .sort((a, b) => (a.orden || 99) - (b.orden || 99));
  }

  // Skins publicados por el admin. Si falla la lectura no se rompe nada: la
  // app se queda con los aspectos de código y el vecino ve su botón normal.
  async function cargarSkins() {
    try {
      const snap = await getDocs(query(collection(db, 'skins'), orderBy('creado', 'desc')));
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .filter((s) => s.publico !== false && typeof s.imagen === 'string');
    } catch (e) {
      return skinsGaleria;   // se conserva lo que ya hubiera de la caché
    }
  }

  // Texto legible del tiempo restante (min / h / días).
  function restanteTexto(ms) {
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'menos de 1 minuto';
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) {
      const m = min % 60;
      return m ? `${h} h ${m} min` : `${h} h`;
    }
    const d = Math.floor(h / 24);
    const hr = h % 24;
    return hr ? `${d} día${d > 1 ? 's' : ''} ${hr} h` : `${d} día${d > 1 ? 's' : ''}`;
  }

  // Reloj con el tiempo restante de un acceso (dataset.expira en ms; 0 = sin límite).
  const ICONO_RELOJ = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v4.7l3 1.8"/></svg>';
  function pintarRelojAcceso(el) {
    const exp = Number(el.dataset.expira || 0);
    const txt = el.querySelector('.acceso-tiempo');
    if (!exp) { el.classList.remove('urgente', 'vencido'); txt.textContent = 'sin límite'; return; }
    const rem = exp - Date.now();
    el.classList.toggle('urgente', rem > 0 && rem < 3600000);
    el.classList.toggle('vencido', rem <= 0);
    txt.textContent = rem <= 0 ? 'venció' : restanteTexto(rem);
  }

  // Deja el panel con los controles listos para tocar. Idempotente: se llama al
  // instante con lo que había en caché y otra vez con lo fresco de Firestore,
  // sin duplicar (renderDispositivos y prepararGeneradorPases limpian antes).
  // `mostrar` cambia de vista solo la primera vez, para no sacar al usuario de
  // la pestaña donde esté si repinta un segundo después.
  function pintarControles(usuario, dispositivos, mostrar) {
    usuarioActual = usuario;
    misDispositivos = dispositivos;
    $('nombre-usuario').textContent = nombreCompleto(usuario);
    $('info-usuario').classList.remove('oculto');
    renderDispositivos(dispositivos);
    prepararGeneradorPases();
    const esAdmin = usuario.rol === 'admin';
    $('btn-menu').classList.remove('oculto');
    document.querySelectorAll('.solo-admin').forEach((el) => el.classList.toggle('oculto', !esAdmin));
    if (mostrar) {
      mostrarVista('vista-panel');
      entrarTab(tabDesdeHash()); // respeta la pestaña de la URL (refresh / enlace)
    }
  }

  // Dimmer a lo ancho, con slider HORIZONTAL. Va fuera del carrusel (que scrollea
  // horizontal) y usa gesto horizontal, que no pelea ni con el carrusel ni con el
  // gesto vertical de inicio de iOS — por eso no necesita zona muerta abajo.
  // `demo` = el del vestuario: se desliza y se ve igual, pero no manda nada al
  // dispositivo ni consulta su estado.
  function controlDimmer(dispositivo, demo) {
    const cont = document.createElement('div');
    cont.className = 'control-dimmer';

    const cab = document.createElement('div');
    cab.className = 'dimmer-cab';
    const btnIcono = document.createElement('button');
    btnIcono.type = 'button';
    btnIcono.className = 'dimmer-icono';
    btnIcono.innerHTML = ICONOS.luz;
    btnIcono.setAttribute('aria-label', `Encender o apagar ${dispositivo.nombre}`);
    const nombre = document.createElement('span');
    nombre.className = 'dimmer-nombre';
    nombre.textContent = dispositivo.nombre;
    const valTxt = document.createElement('span');
    valTxt.className = 'dimmer-valor';
    cab.append(btnIcono, nombre, valTxt);

    const pista = document.createElement('div');
    pista.className = 'dimmer-pista';
    pista.setAttribute('role', 'slider');
    pista.setAttribute('aria-label', `Brillo de ${dispositivo.nombre}`);
    pista.setAttribute('aria-valuemin', '0');
    pista.setAttribute('aria-valuemax', '100');
    const fill = document.createElement('div');
    fill.className = 'dimmer-fill';
    pista.appendChild(fill);

    cont.append(cab, pista);

    let valor = 0;
    let enviando = false;
    let ultimoDetente = -1;
    let ultimoBrillo = 100;
    let animId = null;

    const pintar = (v, sonar) => {
      valor = Math.max(0, Math.min(100, Math.round(v)));
      fill.style.width = `${valor}%`;
      valTxt.textContent = `${valor}%`;
      cont.classList.toggle('encendido', valor > 0);
      pista.setAttribute('aria-valuenow', String(valor));
      if (sonar) {
        const detente = Math.round(valor / 4);
        if (detente !== ultimoDetente) { tic(); ultimoDetente = detente; }
      }
    };
    pintar(0);

    const valorDesde = (e) => {
      const r = pista.getBoundingClientRect();
      return Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
    };

    async function enviarBrillo(extra) {
      if (demo || enviando) return; // en el vestuario no se manda nada
      enviando = true;
      try {
        await ejecutarComando({ dispositivoId: dispositivo.id, accion: 'brillo', valor, ...(extra || {}) });
      } catch (err) {
        toast(err.message || 'No se pudo enviar el comando.', 'error');
      } finally {
        enviando = false;
      }
    }

    function animarA(destino) {
      if (animId) cancelAnimationFrame(animId);
      const inicio = valor;
      const t0 = performance.now();
      const dur = 900;
      const paso = (t) => {
        const k = Math.min(1, (t - t0) / dur);
        const suave = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        pintar(inicio + (destino - inicio) * suave);
        animId = k < 1 ? requestAnimationFrame(paso) : null;
      };
      animId = requestAnimationFrame(paso);
    }

    // Arrastre HORIZONTAL sobre la pista. touch-action: pan-y (en el CSS) deja el
    // scroll vertical de la página al navegador y captura el horizontal para el
    // brillo; si el gesto sale vertical, llega pointercancel y no se cambia nada.
    let activo = false;
    let cambiado = false;
    const alMover = (e) => { if (!activo) return; pintar(valorDesde(e), true); cambiado = true; e.preventDefault(); };
    const finGesto = (e, cancelado) => {
      if (!activo) return;
      activo = false;
      window.removeEventListener('pointermove', alMover);
      window.removeEventListener('pointerup', alSoltar);
      window.removeEventListener('pointercancel', alCancelar);
      if (cancelado) return;
      if (!cambiado) pintar(valorDesde(e), true); // toque directo: fija ese punto
      if (valor > 0) ultimoBrillo = valor;
      enviarBrillo();
    };
    const alSoltar = (e) => finGesto(e, false);
    const alCancelar = () => finGesto(null, true);
    pista.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button > 0) return;
      if (animId) { cancelAnimationFrame(animId); animId = null; }
      activo = true;
      cambiado = false;
      window.addEventListener('pointermove', alMover);
      window.addEventListener('pointerup', alSoltar);
      window.addEventListener('pointercancel', alCancelar);
    });

    // Tap en el bulbo: apaga (fade out) o enciende al último brillo (fade in).
    btnIcono.addEventListener('click', () => {
      const destino = valor > 0 ? 0 : (ultimoBrillo || 100);
      const desde = valor;
      animarA(destino);
      enviarBrillo({ valor: destino, desde, fade: true });
    });

    if (demo) {
      pintar(65); // un valor de muestra, para que el slider se vea con vida
    } else {
      (async () => {
        try {
          const res = await consultarEstado({ dispositivoId: dispositivo.id });
          const d = res.data || {};
          if (typeof d.brillo === 'number') pintar(d.brillo);
          const mem = typeof d.brilloMemoria === 'number' ? d.brilloMemoria : d.brillo;
          if (typeof mem === 'number' && mem > 0) ultimoBrillo = mem;
        } catch (err) { /* sin estado disponible */ }
      })();
    }

    return cont;
  }

  // Ancho natural de cada control, para decidir si un grupo cabe sin carrusel.
  // El rodillo es angosto; el botón de puerta mide 168 del círculo + 26 de aro
  // a cada lado. Son medidas de CSS, no se pueden leer del DOM aquí: al pintar,
  // el panel todavía puede estar oculto y todo mediría 0.
  const ANCHO_CONTROL = (d) => (aspectoDe(d) === 'rueda' ? 150 : 220);
  const HUECO_FILA = 34;   // el gap de .grupo-controles
  function cabenEnFila(lista, contenedor) {
    const disponible = contenedor.clientWidth || (Math.min(640, window.innerWidth) - 32);
    const total = lista.reduce((s, d) => s + ANCHO_CONTROL(d), 0)
      + HUECO_FILA * (lista.length - 1);
    return total <= disponible;
  }

  function renderDispositivos(dispositivos) {
    const contenedor = $('lista-dispositivos');
    contenedor.textContent = '';
    if (!dispositivos.length) {
      const aviso = document.createElement('p');
      aviso.className = 'centrado';
      aviso.textContent = 'Aún no tienes dispositivos asignados.';
      contenedor.appendChild(aviso);
      return;
    }
    const usosDe = (id) => (usuarioActual && usuarioActual.usos && usuarioActual.usos[id]) || 0;
    for (const tipo of TIPOS) {
      const grupo = dispositivos
        .filter((d) => (d.tipo || 'otro') === tipo.clave)
        .sort((a, b) => usosDe(b.id) - usosDe(a.id) || (a.orden || 99) - (b.orden || 99));
      if (!grupo.length) continue;
      const titulo = document.createElement('h2');
      titulo.className = 'titulo-grupo';
      titulo.textContent = tipo.titulo;
      contenedor.appendChild(titulo);
      // Los dimmers van aparte, a lo ancho (slider horizontal). El resto va en
      // el carrusel como siempre.
      // El dimmer va a lo ancho (slider), salvo que lleve el aspecto Rueda:
      // ese es compacto y vertical, así que entra al carrusel como los demás.
      const enCarrusel = grupo.filter((d) => d.modo !== 'dimmer' || aspectoDe(d) === 'rueda');
      const dimmers = grupo.filter((d) => d.modo === 'dimmer' && aspectoDe(d) !== 'rueda');
      if (enCarrusel.length) {
        const fila = document.createElement('div');
        // Un carrusel de pocos siempre enseña "uno y medio" y queda corrido. Si
        // el grupo cabe entero, va en fila centrada y se ven todos completos.
        const plano = cabenEnFila(enCarrusel, contenedor);
        // Con más de dos, el carrusel va de DOS EN DOS: media pantalla cada uno
        // y los botones un poco más chicos para que quepan enteros. Con uno y
        // medio en pantalla se pierde de vista lo que hay al lado.
        const doble = !plano && enCarrusel.length > 2;
        fila.className = 'grupo-controles' + (plano ? '' : ' carrusel')
          + (doble ? ' doble compacto' : '');
        for (const dispositivo of enCarrusel) {
          fila.appendChild(tarjetaDispositivo(dispositivo));
        }
        contenedor.appendChild(fila);
        // El coverflow (escalar según distancia al centro) solo tiene sentido
        // cuando hay UNO en foco; de dos en dos los dos van a tamaño completo.
        if (!plano && !doble) activarCarrusel(fila);
      }
      for (const dispositivo of dimmers) {
        // El dimmer no pasa por tarjetaDispositivo (va a lo ancho, fuera del
        // carrusel), así que su piel se aplica aquí.
        const cd = controlDimmer(dispositivo);
        aplicarPiel(cd, aspectoDe(dispositivo));
        contenedor.appendChild(cd);
      }
    }
  }

  // Escala cada control según su distancia al centro (efecto coverflow):
  // el que está en foco se ve grande y los vecinos, más pequeños, crecen al acercarse.
  const MIN_ESCALA = 0.66; // tamaño del vecino más lejano
  const MIN_OPAC = 0.4;
  function activarCarrusel(cont) {
    const items = [...cont.children];
    if (items.length <= 1) {
      items.forEach((i) => { i.classList.add('enfoque'); i.style.transform = 'scale(1)'; i.style.opacity = '1'; });
      return;
    }
    const actualizar = () => {
      const rc = cont.getBoundingClientRect();
      const centro = rc.left + rc.width / 2;
      const paso = items[0].offsetWidth || 1; // ancho de una diapositiva (sin escalar)
      let mejor = null;
      let mejorD = Infinity;
      for (const it of items) {
        const r = it.getBoundingClientRect();
        const d = Math.abs(r.left + r.width / 2 - centro);
        const t = Math.min(1, d / paso); // 0 en el centro, 1 a una diapositiva de distancia
        const escala = 1 - (1 - MIN_ESCALA) * t;
        const opac = 1 - (1 - MIN_OPAC) * t;
        it.style.transform = `scale(${escala.toFixed(3)})`;
        it.style.opacity = opac.toFixed(3);
        if (d < mejorD) { mejorD = d; mejor = it; }
      }
      items.forEach((i) => i.classList.toggle('enfoque', i === mejor));
    };
    let raf = null;
    cont.addEventListener('scroll', () => {
      if (!raf) raf = requestAnimationFrame(() => { raf = null; actualizar(); });
    }, { passive: true });
    actualizar();
    requestAnimationFrame(actualizar);
    setTimeout(actualizar, 80);
  }

  // Coloca el nombre dentro del botón, debajo del icono.
  function nombreEnBoton(boton, nombre) {
    const s = document.createElement('span');
    s.className = 'nombre-boton';
    s.textContent = nombre;
    boton.appendChild(s);
    boton.classList.add('con-nombre');
  }

  // Audios del Jet Switch, compartidos por todos sus controles. Dos elementos
  // separados: la tapa en MP3, el toggle en WAV (su MP3 no sonaba en iPhone).
  const jetTapa = new Audio('click-tapa.mp3?v=3'); jetTapa.preload = 'auto';
  const jetToggle = new Audio('click-toggle.wav?v=2'); jetToggle.preload = 'auto';
  const jetSonar = (a) => { try { a.muted = false; a.currentTime = 0; const p = a.play(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ } };
  // Desbloqueo de iOS al primer toque (pointerdown): reproduce ambos audios en
  // silencio y los pausa, para que suenen aunque la acción salte en el
  // movimiento del dedo (que iOS a veces no cuenta como gesto válido).
  let jetDesbloqueado = false;
  const jetDesbloquear = () => {
    if (jetDesbloqueado) return; jetDesbloqueado = true;
    [jetTapa, jetToggle].forEach((a) => {
      try {
        a.muted = true; const p = a.play();
        if (p && p.then) p.then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; });
        else { a.pause(); a.muted = false; }
      } catch (e) { /* ignore */ }
    });
  };

  // Control tipo "Jet Switch": tapa de seguridad roja + palanca. Se desliza la
  // tapa hacia arriba (armar) y luego la palanca (abrir). Es MOMENTARY como un
  // portón: al abrir dispara el pulso y la palanca vuelve sola a Armado en 1 s.
  function controlJet(dispositivo, demo) {
    const control = document.createElement('div');
    control.className = 'control control-jet';

    const titulo = document.createElement('span');
    titulo.className = 'jet-titulo';
    titulo.textContent = dispositivo.nombre;

    const sw = document.createElement('div');
    sw.className = 'jet-switch';
    sw.innerHTML = '<div class="jet-capa jet-cerrado"></div>'
      + '<div class="jet-capa jet-armado"></div>'
      + '<div class="jet-capa jet-abierto"></div>';
    const capas = [sw.querySelector('.jet-cerrado'), sw.querySelector('.jet-armado'), sw.querySelector('.jet-abierto')];

    // Búnker: la bomba en la tapa roja, sobre "ENGAGE". Va dentro de la capa
    // cerrada, así solo se ve con la tapa abajo (que es donde está "ENGAGE").
    if (dispositivo.subtipo === 'bunker') {
      const bomba = document.createElement('div');
      bomba.className = 'jet-bunker';
      bomba.innerHTML = ICONOS.bunker;
      capas[0].appendChild(bomba);
    }

    control.append(titulo, sw);

    let idx = 0, momentaryTimer = null, enviando = false;
    const pintar = () => { for (let k = 0; k < 3; k++) capas[k].style.opacity = (k === idx) ? 1 : 0; };

    const ir = (nuevo) => {
      const prev = idx; idx = nuevo;
      if ((prev === 0 && nuevo === 1) || (prev === 1 && nuevo === 0)) jetSonar(jetTapa); // tapa
      else if (prev === 1 && nuevo === 2) jetSonar(jetToggle);                            // toggle (pulso)
      pintar();
    };

    // Dispara el comando real al abrir; la palanca es momentary y vuelve sola.
    // En el vestuario (demo) se anima igual pero NO se manda nada al portón.
    async function disparar() {
      ir(2);
      momentaryTimer = setTimeout(() => { ir(1); momentaryTimer = null; }, 1000);
      if (demo || enviando) return;
      enviando = true;
      try {
        await ejecutarComando({ dispositivoId: dispositivo.id });
      } catch (err) {
        toast(err.message || 'No se pudo abrir.', 'error');
      } finally {
        enviando = false;
      }
    }
    const arriba = () => {
      if (momentaryTimer) return;
      if (idx === 0) ir(1);          // tapa: cerrado -> armado
      else if (idx === 1) disparar(); // toggle: armado -> abierto (pulso)
    };
    const abajo = () => { if (!momentaryTimer && idx === 1) ir(0); }; // tapa: armado -> cerrado

    // Gesto de deslizar; la acción salta al cruzar el umbral en el movimiento.
    let y0 = null, actuado = false;
    sw.addEventListener('pointerdown', (e) => { y0 = e.clientY; actuado = false; jetDesbloquear(); if (sw.setPointerCapture) sw.setPointerCapture(e.pointerId); });
    sw.addEventListener('pointermove', (e) => {
      if (y0 === null || actuado) return;
      const dy = e.clientY - y0;
      if (dy < -22) { actuado = true; arriba(); }
      else if (dy > 22) { actuado = true; abajo(); }
    });
    sw.addEventListener('pointerup', () => { const m = actuado; y0 = null; actuado = false; if (!m) arriba(); });
    sw.addEventListener('pointercancel', () => { y0 = null; actuado = false; });

    pintar();
    return control;
  }

  // `demo` = el control del vestuario: se ve y se anima igual, pero no manda
  // nada al dispositivo ni consulta su estado. `aspectoForzado` permite
  // previsualizar un aspecto sin haberlo elegido todavía.
  // ---- Rueda: rodillo moleteado que gira, con detente y arco de luces ----
  // Aspecto alternativo para cortinas, termostatos y dimmers: en móvil el
  // arrastre vertical es más preciso que un dial rotatorio, y no pelea con el
  // carrusel horizontal de dispositivos.

  // Tic del detente. Web Audio cuando se puede: `HTMLAudio.play()` en iOS toca
  // el pipeline de medios en el hilo principal, y a 15 tics por segundo eso
  // solo trabar el arrastre. El HTMLAudio queda de respaldo, pero hay que
  // crearlo y desbloquearlo SÍNCRONO dentro del gesto: si se crea dentro de un
  // .then() iOS lo deja mudo para siempre.
  let ticPool = null, ticIdx = 0, ticCtx = null, ticBuf = null;
  function ticPrepara() {
    if (ticPool) { if (ticCtx && ticCtx.state === 'suspended') ticCtx.resume(); return; }
    ticPool = [];
    for (let i = 0; i < 4; i++) {
      const a = new Audio('tic-rueda.wav?v=3');
      a.preload = 'auto';
      try {
        a.muted = true;
        const p = a.play();
        if (p && p.then) p.then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; });
        else { a.pause(); a.muted = false; }
      } catch (e) { /* sin audio */ }
      ticPool.push(a);
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      ticCtx = new AC({ latencyHint: 'interactive' });
      const mudo = ticCtx.createBufferSource();          // desbloqueo en el gesto
      mudo.buffer = ticCtx.createBuffer(1, 1, 22050);
      mudo.connect(ticCtx.destination);
      mudo.start(0);
      if (ticCtx.state === 'suspended') ticCtx.resume();
      fetch('tic-rueda.wav?v=3')
        .then((r) => r.arrayBuffer())
        .then((ab) => ticCtx.decodeAudioData(ab.slice(0)))
        .then((b) => { ticBuf = b; })
        .catch(() => { ticCtx = null; });  // sigue el respaldo, que ya está vivo
    } catch (e) { ticCtx = null; }
  }
  function ticRueda() {
    if (ticCtx && ticBuf) {
      try {
        const s = ticCtx.createBufferSource();
        s.buffer = ticBuf;
        s.connect(ticCtx.destination);
        s.start(0);
        return;
      } catch (e) { /* cae al respaldo */ }
    }
    if (!ticPool) return;
    const a = ticPool[ticIdx++ % ticPool.length];
    try { a.currentTime = 0; const p = a.play(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ }
  }

  // Instalada como app (standalone), iOS deja dormir la sesión de audio y la
  // despierta en cada sonido: ahí se va la latencia (en Safari no pasa). Se
  // mantiene abierta con un tono inaudible mientras se usa la rueda.
  let ticVivo = null, ticVivoTimer = null;
  function ticCanalAbrir() {
    clearTimeout(ticVivoTimer);
    if (!ticCtx || ticVivo) return;
    try {
      const osc = ticCtx.createOscillator();
      const g = ticCtx.createGain();
      g.gain.value = 0.0001;
      osc.frequency.value = 40;
      osc.connect(g).connect(ticCtx.destination);
      osc.start();
      ticVivo = osc;
    } catch (e) { /* sin canal vivo */ }
  }
  function ticCanalCerrarLuego() {
    clearTimeout(ticVivoTimer);
    ticVivoTimer = setTimeout(() => {
      if (!ticVivo) return;
      try { ticVivo.stop(); } catch (e) { /* ya parado */ }
      ticVivo = null;
    }, 4000);
  }

  function controlRueda(dispositivo, demo) {
    const esTermo = dispositivo.modo === 'termostato';
    const esDimmer = dispositivo.modo === 'dimmer';
    const cfg = esTermo
      ? { min: TERMO_MIN, max: TERMO_MAX, paso: 0.5, tono: 'frio',
          fmt: (v) => `${v % 1 ? v.toFixed(1) : v}°` }
      // El dimmer va en ámbar cálido (~2500K), como la luz que controla.
      : { min: 0, max: 100, paso: 5, tono: esDimmer ? 'calido' : '', fmt: (v) => String(v) };

    const control = document.createElement('div');
    control.className = 'control control-rueda' + (cfg.tono ? ` ${cfg.tono}` : '');

    const ctrl = document.createElement('div');
    ctrl.className = 'rueda-ctrl';
    ctrl.innerHTML = '<div class="rueda-arco"></div>'
      + '<div class="rueda-marco"><div class="rueda-moleteado-caja">'
      + '<div class="rueda-moleteado"></div><div class="rueda-brillo"></div></div></div>';
    control.appendChild(ctrl);

    const valTxt = document.createElement('span');
    valTxt.className = 'rueda-valor';
    control.appendChild(valTxt);

    const etiqueta = document.createElement('span');
    etiqueta.className = 'etiqueta-control';
    etiqueta.textContent = dispositivo.nombre;
    control.appendChild(etiqueta);

    // Columna de luces al costado del bisel: el rodillo se mueve en vertical,
    // así que las luces suben y bajan con él como un vúmetro.
    const arco = ctrl.querySelector('.rueda-arco');
    const N = 13, LX = 135, ABAJO = 128, ARRIBA = 22;
    const leds = [];
    for (let i = 0; i < N; i++) {
      const d = document.createElement('span');
      d.className = 'rueda-led';
      d.style.left = `${LX}px`;
      d.style.top = `${ABAJO + (ARRIBA - ABAJO) * i / (N - 1)}px`;
      arco.appendChild(d);
      leds.push(d); // i=0 abajo … i=N-1 arriba
    }

    const moleteado = ctrl.querySelector('.rueda-moleteado');
    const esCortina = !esTermo && !esDimmer;
    let valor = esTermo ? 23 : 0;
    // Estado del toque en el centro. En la cortina es pausa/marcha (solo del
    // lado de la app: el aparato no informa si va en camino). En el dimmer
    // "apagado" es brillo 0, así que se deduce del valor y sobrevive al
    // recargar; el termostato sí necesita bandera, porque apagarlo no es una
    // temperatura.
    let pausada = false, termoApagado = false;
    let valorEncendido = 60;   // brillo al que vuelve el dimmer
    let modoTermo = 'cool';    // modo al que vuelve el termostato
    const estaApagado = () => (esDimmer ? valor === 0 : termoApagado);

    // Se escribe en el DOM solo lo que de verdad cambió: durante el arrastre
    // esto corre en cada frame y tocar 13 luces + el número por gusto se nota
    // en el teléfono.
    const ledOn = new Array(N).fill(false);
    let txtPrev = '', apagPrev = null, pausaPrev = null;
    function pintar() {
      const frac = (valor - cfg.min) / (cfg.max - cfg.min);
      const encendidos = esTermo && termoApagado ? 0 : Math.round(frac * N);
      for (let i = 0; i < N; i++) {
        const on = i < encendidos;
        if (ledOn[i] === on) continue;
        ledOn[i] = on;
        leds[i].classList.toggle('on', on);
      }
      const txt = cfg.fmt(valor);
      if (txt !== txtPrev) { txtPrev = txt; valTxt.textContent = txt; }
      // Sin iconos: apagado apaga las luces y apaga el número; en pausa las
      // luces laten.
      const apag = !esCortina && estaApagado();
      const pau = esCortina && pausada;
      if (apag !== apagPrev) { apagPrev = apag; control.classList.toggle('rueda-apagado', apag); }
      if (pau !== pausaPrev) { pausaPrev = pau; control.classList.toggle('rueda-pausa', pau); }
      ctrl.setAttribute('aria-valuenow', String(valor));
    }

    async function mandar(data) {
      if (demo) return true; // en el vestuario no se manda nada
      control.classList.add('rueda-enviando');
      try {
        await ejecutarComando({ dispositivoId: dispositivo.id, ...data });
        return true;
      } catch (err) {
        toast(err.message || 'No se pudo enviar el comando.', 'error');
        return false;
      } finally {
        control.classList.remove('rueda-enviando');
      }
    }

    async function enviar() {
      pausada = false; // mover la rueda es reanudar
      pintar();
      await mandar(esTermo ? { accion: 'temperatura', valor }
        : (esDimmer ? { accion: 'brillo', valor } : { accion: 'posicion', valor }));
    }

    // Toque en el rodillo, sin girarlo: en la cortina pausa y reanuda; en el
    // dimmer y el termostato, apaga y enciende.
    async function tocarCentro() {
      ticRueda();
      if (esCortina) {
        pausada = !pausada;
        pintar();
        const ok = await mandar(pausada
          ? { accion: 'pausar' }
          : { accion: 'posicion', valor });
        if (!ok) { pausada = !pausada; pintar(); }
        return;
      }
      if (esDimmer) {
        const previo = valor;
        if (valor > 0) { valorEncendido = valor; valor = 0; } else { valor = valorEncendido || 60; }
        pintar();
        // El ancla del gesto se mueve con el valor: si no, el próximo arrastre
        // saltaría de golpe al nivel de antes.
        giroAncla = giro; valorAncla = valor;
        if (!await mandar({ accion: 'brillo', valor })) { valor = previo; pintar(); }
        return;
      }
      termoApagado = !termoApagado;
      pintar();
      const ok = await mandar({ accion: 'modo', valor: termoApagado ? 'off' : modoTermo });
      if (!ok) { termoApagado = !termoApagado; pintar(); }
    }

    // Gesto con inercia: al soltar, la rueda sigue girando y frenando sola,
    // marcando sus detentes, en vez de congelarse en seco. El comando sale
    // cuando de verdad se detiene, no en cada paso: un flick mandaría decenas.
    const PX_PASO = 7;        // px de arrastre por escalón
    const FRICCION = 0.94;    // cuánto conserva por frame (a 60fps)
    const VEL_MIN = 0.03;     // px/ms por debajo de lo cual se considera parada
    let giro = 0, giroAncla = 0, valorAncla = valor;
    let arrastrando = false, yUlt = 0, tUlt = 0, vel = 0, raf = null, valorAlTocar = valor;

    // La textura repite cada 155px, así que el giro se toma módulo 155. Se mueve
    // con transform (compositor) y no con background-position: esta última
    // repinta en CPU en cada píxel y el arrastre se siente pegajoso.
    function aplicarGiro() {
      moleteado.style.transform = `translate3d(0,${(((-giro % 155) + 155) % 155)}px,0)`;
      const pasos = Math.round((giro - giroAncla) / PX_PASO);
      const bruto = valorAncla + pasos * cfg.paso;
      const nuevo = Math.min(cfg.max, Math.max(cfg.min, Math.round(bruto / cfg.paso) * cfg.paso));
      if (nuevo !== valor) { ticRueda(); valor = nuevo; pintar(); }
      // Tope: al llegar al extremo la inercia se corta, como un fin de carrera.
      if ((valor === cfg.max && vel > 0) || (valor === cfg.min && vel < 0)) vel = 0;
    }

    // En un iPhone con ProMotion `pointermove` llega a 120 Hz y a veces varias
    // veces por frame. Pintar en cada evento es trabajo tirado y se siente
    // tembloroso: se acumula el arrastre y se dibuja una sola vez por frame.
    let rafPintar = null;
    function pedirGiro() {
      if (rafPintar) return;
      rafPintar = requestAnimationFrame(() => { rafPintar = null; aplicarGiro(); });
    }
    function cancelarGiroPendiente() {
      if (rafPintar) { cancelAnimationFrame(rafPintar); rafPintar = null; }
    }

    function asentado() {
      ticCanalCerrarLuego();
      if (valor !== valorAlTocar) enviar();
    }

    function inercia() {
      const t = performance.now();
      const dt = Math.min(34, t - tUlt);       // si el frame se atrasó, no saltar
      tUlt = t;
      giro += vel * dt;
      vel *= Math.pow(FRICCION, dt / 16.67);   // fricción independiente del fps
      aplicarGiro();
      if (Math.abs(vel) < VEL_MIN) { raf = null; asentado(); return; }
      raf = requestAnimationFrame(inercia);
    }

    let tTocar = 0, enRodillo = false;
    ctrl.addEventListener('pointerdown', (e) => {
      ticPrepara();
      ticCanalAbrir();
      if (raf) { cancelAnimationFrame(raf); raf = null; }   // atajar la inercia
      cancelarGiroPendiente();
      arrastrando = true;
      yUlt = e.clientY; tUlt = performance.now(); vel = 0;
      giroAncla = giro; valorAncla = valor; valorAlTocar = valor;
      tTocar = tUlt;
      // El toque solo cuenta sobre el rodillo, no sobre la columna de luces.
      enRodillo = !!(e.target.closest && e.target.closest('.rueda-marco'));
      if (ctrl.setPointerCapture) ctrl.setPointerCapture(e.pointerId);
    });
    ctrl.addEventListener('pointermove', (e) => {
      if (!arrastrando) return;
      const t = performance.now();
      const dy = yUlt - e.clientY;             // arrastrar hacia arriba sube
      const dt = Math.max(1, t - tUlt);
      // Media móvil: a 120 Hz cada evento trae 0 o 1 px y la velocidad cruda
      // salta como loca; sin suavizar, el impulso al soltar sale a lo que haya
      // pasado en los últimos 8 ms.
      vel = vel * 0.7 + (dy / dt) * 0.3;
      yUlt = e.clientY; tUlt = t;
      giro += dy;
      pedirGiro();
    });
    const soltar = (cancelado) => {
      if (!arrastrando) return;
      arrastrando = false;
      // Toque limpio (apenas se movió y fue corto): es el botón del centro, no
      // un giro. Se descarta el arrastre residual para que no cambie el valor.
      if (!cancelado && enRodillo && Math.abs(giro - giroAncla) < 5
          && performance.now() - tTocar < 450) {
        cancelarGiroPendiente();
        giro = giroAncla; vel = 0;
        aplicarGiro();
        ticCanalCerrarLuego();
        tocarCentro();
        return;
      }
      cancelarGiroPendiente();
      if (Math.abs(vel) > VEL_MIN) { tUlt = performance.now(); raf = requestAnimationFrame(inercia); }
      else { aplicarGiro(); asentado(); }   // cerrar el último frame pendiente
    };
    ctrl.addEventListener('pointerup', () => soltar(false));
    ctrl.addEventListener('pointercancel', () => soltar(true));

    pintar();
    if (!demo) {
      (async () => {
        try {
          const res = await consultarEstado({ dispositivoId: dispositivo.id });
          const d = res.data || {};
          const v = esTermo ? d.temperaturaObjetivo
            : (dispositivo.modo === 'dimmer' ? d.brillo : d.posicion);
          if (typeof v === 'number') { valor = Math.min(cfg.max, Math.max(cfg.min, v)); }
          // A qué nivel/modo vuelve el toque del centro cuando está apagado.
          if (esDimmer && typeof d.brilloMemoria === 'number' && d.brilloMemoria > 0) {
            valorEncendido = d.brilloMemoria;
          }
          if (esTermo && d.modoHVAC) {
            termoApagado = d.modoHVAC === 'off';
            if (!termoApagado) modoTermo = d.modoHVAC;
          }
          valorAncla = valor;
          pintar();
        } catch (err) { /* sin estado disponible */ }
      })();
    } else {
      valor = esTermo ? 23 : 60; // valores de muestra para el Locker
      pintar();
    }
    return control;
  }

  // ---- Sabiem: placa de llamada de ascensor a la antigua ----
  // No es un botón redondo sino una placa vertical, así que va como control
  // propio (igual que el Jet Switch) en vez de por ASPECTOS_IMAGEN.
  // La foto viene con los rótulos APAGADOS; encenderlos son dos capas
  // transparentes del mismo tamaño que la placa, con las letras en ámbar. Al
  // llamar se encienden los dos y, al final, se apaga LLEGANDO y luego OCUPADO
  // — como el original, que avisa que ya llegó antes de soltar la llamada.
  function controlSabiem(dispositivo, demo) {
    const control = document.createElement('div');
    control.className = 'control control-sabiem';

    const placa = document.createElement('div');
    placa.className = 'sabiem-placa';
    placa.innerHTML = '<i class="sabiem-luz sabiem-ocupado"></i>'
      + '<i class="sabiem-luz sabiem-llegando"></i>'
      + '<button type="button" class="sabiem-boton"></button>';
    const ocupado = placa.querySelector('.sabiem-ocupado');
    const llegando = placa.querySelector('.sabiem-llegando');
    const boton = placa.querySelector('.sabiem-boton');
    boton.setAttribute('aria-label', `Llamar ${dispositivo.nombre}`);

    const etiqueta = document.createElement('span');
    etiqueta.className = 'etiqueta-control';
    etiqueta.textContent = dispositivo.nombre;
    control.append(placa, etiqueta);

    // El ascensor tarda en llegar: sin dato del admin, 6s se siente honesto
    // (el default de 1.5s de una puerta no daría para las dos fases).
    const total = (Number(dispositivo.segundosApertura) || 6) * 1000;
    const cortaLlegando = Math.max(total * 0.45, total - 1800);
    let temporizadores = [];
    let enviando = false;

    function apagar() {
      temporizadores.forEach(clearTimeout);
      temporizadores = [];
      ocupado.classList.remove('on');
      llegando.classList.remove('on');
    }

    async function llamar() {
      if (enviando) return;
      apagar();
      ocupado.classList.add('on');
      llegando.classList.add('on');
      temporizadores.push(setTimeout(() => llegando.classList.remove('on'), cortaLlegando));
      temporizadores.push(setTimeout(() => ocupado.classList.remove('on'), total));
      if (demo) return; // en el vestuario se anima pero no se llama al ascensor
      enviando = true;
      try {
        await ejecutarComando({ dispositivoId: dispositivo.id });
      } catch (err) {
        apagar();
        toast(err.message || 'No se pudo llamar al ascensor.', 'error');
      } finally {
        enviando = false;
      }
    }

    boton.addEventListener('click', llamar);
    return control;
  }

  // ---- Mando: el control remoto del portón, tal cual ----
  // No es un botón redondo sino la foto del mando recortada, así que va como
  // control propio (igual que el Jet Switch y el Sabiem). La zona de toque está
  // sobre el botón crema de la foto, no sobre todo el mando: es lo que se
  // aprieta de verdad.
  function controlMando(dispositivo, demo) {
    const control = document.createElement('div');
    control.className = 'control control-mando';
    const cuerpo = document.createElement('div');
    cuerpo.className = 'mando-cuerpo';
    cuerpo.innerHTML = '<button type="button" class="mando-boton"></button>';
    const boton = cuerpo.querySelector('.mando-boton');
    boton.setAttribute('aria-label', `${dispositivo.etiquetaBoton || 'Abrir'} ${dispositivo.nombre}`);
    const etiqueta = document.createElement('span');
    etiqueta.className = 'etiqueta-control';
    etiqueta.textContent = dispositivo.nombre;
    control.append(cuerpo, etiqueta);
    // Un mando de verdad es MOMENTARY: se hunde al apretarlo y vuelve solo,
    // no se queda hundido los 15 s que tarda el portón en abrir. Por eso el
    // hundido va con su propia clase y no con las de `pulsar`, que duran lo que
    // dura la apertura.
    let volver = null;
    boton.addEventListener('pointerdown', jetDesbloquear);   // iOS: desbloquea el audio en el gesto
    boton.addEventListener('click', () => {
      jetSonar(jetTapa);                                     // el clic del plástico
      boton.classList.add('pulsado');
      clearTimeout(volver);
      volver = setTimeout(() => boton.classList.remove('pulsado'), 1100);
      if (demo) pulsarDemo(boton, dispositivo); else pulsar(boton, dispositivo);
    });
    return control;
  }

  function tarjetaDispositivo(dispositivo, demo, aspectoForzado) {
    // El aspecto sale del vestuario del vecino (o del que puso el admin).
    const aspecto = aspectoForzado || aspectoDe(dispositivo);
    // Puerta de pulso con aspecto Jet: interruptor con tapa de seguridad.
    if (dispositivo.modo === 'pulso' && aspecto === 'jet') {
      return controlJet(dispositivo, demo);
    }
    // Aspecto Mando: el control remoto del portón (control propio, no botón).
    if (dispositivo.modo === 'pulso' && aspecto === 'mando') {
      return controlMando(dispositivo, demo);
    }
    // Aspecto Sabiem: placa de llamada de ascensor (control propio, no botón).
    if (dispositivo.modo === 'pulso' && aspecto === 'sabiem') {
      return controlSabiem(dispositivo, demo);
    }
    // Aspecto Rueda: reemplaza la perilla/slider por el rodillo.
    if (aspecto === 'rueda' && MODOS_RUEDA.includes(dispositivo.modo)) {
      return controlRueda(dispositivo, demo);
    }
    const control = document.createElement('div');
    control.className = 'control';
    let boton;
    if (dispositivo.modo === 'pulso') {
      const anillo = document.createElement('div');
      anillo.className = 'anillo';
      boton = document.createElement('button');
      boton.type = 'button';
      if (aspecto === 'argentina') {
        // Aspecto Argentina "camiseta": frente por defecto; al presionar se
        // revela la cara de atrás (MESSI 10) por un momento y vuelve.
        boton.className = 'boton-circular grande boton-imagen boton-camiseta';
        boton.innerHTML = '<img src="argentina-frente.jpg?v=2" alt="" class="boton-logo cara-frente">'
          + '<img src="argentina-atras.jpg?v=2" alt="" class="boton-logo cara-atras">';
        boton.addEventListener('click', () => {
          boton.classList.add('mostrar-atras');
          setTimeout(() => boton.classList.remove('mostrar-atras'), 2500);
        });
      } else if (ASPECTOS_IMAGEN[aspecto]) {
        // Aspectos de una sola imagen (Bordado, Hal): la foto es el botón y su
        // clase le da la animación al activarse (ver styles.css).
        const asp = ASPECTOS_IMAGEN[aspecto];
        boton.className = `boton-circular grande boton-imagen ${asp.clase}`;
        boton.innerHTML = `<img src="${asp.img}" alt="" class="boton-logo">`;
      } else {
        const iconoSub = ICONO_SUBTIPO[dispositivo.subtipo];
        const iconoCuadrado = !!iconoSub || dispositivo.tipo === 'ascensor';
        boton.className = 'boton-circular grande' + (iconoCuadrado ? ' cuadrado' : '');
        boton.innerHTML = iconoSub ? ICONOS[iconoSub]
          : (dispositivo.tipo === 'ascensor' ? ICONOS.ascensor : ICONOS.candados);
      }
      boton.setAttribute('aria-label', `${dispositivo.etiquetaBoton || 'Abrir'} ${dispositivo.nombre}`);
      boton.addEventListener('click', () => (demo ? pulsarDemo(boton, dispositivo) : pulsar(boton, dispositivo)));
      anillo.appendChild(boton);
      control.appendChild(anillo);
      if (boton.classList.contains('boton-imagen')) {
        // Botones con foto (Argentina, Bordado): el nombre va abajo DENTRO del
        // anillo (sobre la franja oscura, no sobre la imagen), no como etiqueta
        // aparte; se desvanece mientras el botón está activo (CSS). El largo se
        // limita en el campo de nombre del editor para que no se salga.
        const nom = document.createElement('div');
        nom.className = 'nombre-anillo';
        nom.textContent = dispositivo.nombre;
        anillo.appendChild(nom);
      } else {
        nombreEnBoton(boton, dispositivo.nombre);
      }
    } else if (dispositivo.modo === 'cortina') {
      control.appendChild(perillaCortina(dispositivo, demo));
    } else if (dispositivo.modo === 'dimmer') {
      control.appendChild(perillaDimmer(dispositivo));
    } else if (dispositivo.modo === 'termostato') {
      control.appendChild(perillaTermostato(dispositivo, demo));
    } else {
      boton = document.createElement('button');
      boton.type = 'button';
      const conFoto = ASPECTOS_IMAGEN[aspecto];
      if (conFoto) {
        // Interruptor con foto (skin de galería en una luz o un relé). El aro
        // verde del encendido queda tapado por la imagen, así que el estado se
        // lee en la propia foto: apagada se atenúa (ver styles.css).
        boton.className = `boton-circular medio boton-imagen ${conFoto.clase}`;
        boton.innerHTML = `<img src="${conFoto.img}" alt="" class="boton-logo">`;
      } else {
        boton.className = 'boton-circular medio';
        boton.innerHTML = ICONO_SUBTIPO[dispositivo.subtipo]
          ? ICONOS[ICONO_SUBTIPO[dispositivo.subtipo]]
          : (ICONOS[dispositivo.tipo] || ICONOS.otro);
      }
      boton.setAttribute('aria-label', `Encender o apagar ${dispositivo.nombre}`);
      boton.addEventListener('click', () => {
        // En el demo solo se ve el on/off; no se enciende nada de verdad.
        if (demo) { pintarEstado(boton, !boton.classList.contains('activo')); return; }
        alternar(boton, dispositivo);
      });
      nombreEnBoton(boton, dispositivo.nombre);
      control.appendChild(boton);
    }
    // Cortina y dimmer llevan el nombre debajo; el termostato lo pinta su propia
    // perilla (nombre + temperatura al lado); pulso/interruptor dentro.
    if (dispositivo.modo === 'cortina' || dispositivo.modo === 'dimmer') {
      const etiqueta = document.createElement('span');
      etiqueta.className = 'etiqueta-control';
      etiqueta.textContent = dispositivo.nombre;
      control.appendChild(etiqueta);
    }
    // El demo no consulta el estado real: es solo para ver y sentir el botón.
    if (boton && dispositivo.modo !== 'pulso' && !demo) {
      estadoInicial(boton, dispositivo);
    }
    // Las pieles (Neón, Acero, Cristal, Pop) solo reestilizan: la clase va en la
    // pieza —no en el body— para que cada dispositivo pueda llevar la suya.
    aplicarPiel(control, aspecto);
    return control;
  }

  // Refleja el estado on/off en el botón y en su etiqueta de texto.
  function pintarEstado(boton, encendido) {
    boton.classList.toggle('activo', encendido);
    boton.setAttribute('aria-pressed', encendido ? 'true' : 'false');
  }

  // Pulso de mentira, para el vestuario: hace exactamente la misma coreografía
  // de clases que `pulsar` (enviando → éxito, con la duración de esa puerta)
  // para que el vecino sienta el botón, pero no le manda nada al dispositivo.
  function pulsarDemo(boton, dispositivo) {
    if (boton.classList.contains('enviando') || boton.classList.contains('exito')) return;
    boton.classList.add('enviando');
    setTimeout(() => {
      boton.classList.remove('enviando');
      boton.classList.add('exito');
      const seg = Number(dispositivo.segundosApertura);
      const dur = seg > 0 ? seg * 1000 : (dispositivo.subtipo === 'porton' ? 5000 : 1500);
      setTimeout(() => boton.classList.remove('exito'), dur);
    }, 350); // simula lo que tarda el comando en salir
  }

  async function pulsar(boton, dispositivo) {
    if (boton.classList.contains('enviando')) return;
    boton.classList.add('enviando');
    try {
      await ejecutarComando({ dispositivoId: dispositivo.id });
      boton.classList.add('exito');
      // Cuánto se queda "activo" el botón = lo que tarda ESA puerta en abrir
      // (segundosApertura, configurable por dispositivo). Con eso cualquier
      // animación —persianas, bordado girando, ojo de Hal latiendo— acompaña al
      // portón real. Sin el dato, se mantiene el comportamiento de antes.
      const seg = Number(dispositivo.segundosApertura);
      const duracionExito = seg > 0 ? seg * 1000
        : (dispositivo.subtipo === 'porton' ? 5000 : 1500);
      setTimeout(() => boton.classList.remove('exito'), duracionExito);
    } catch (err) {
      toast(err.message || 'No se pudo enviar el comando.', 'error');
    } finally {
      boton.classList.remove('enviando');
    }
  }

  async function alternar(boton, dispositivo) {
    if (boton.classList.contains('enviando')) return;
    const encendido = boton.classList.contains('activo');
    const accion = encendido ? 'apagar' : 'encender';
    boton.classList.add('enviando');
    try {
      await ejecutarComando({ dispositivoId: dispositivo.id, accion });
      pintarEstado(boton, !encendido);
    } catch (err) {
      toast(err.message || 'No se pudo enviar el comando.', 'error');
    } finally {
      boton.classList.remove('enviando');
    }
  }

  async function estadoInicial(boton, dispositivo) {
    try {
      const res = await consultarEstado({ dispositivoId: dispositivo.id });
      if (res.data && typeof res.data.encendido === 'boolean') {
        pintarEstado(boton, res.data.encendido);
      }
    } catch (err) {
      // Sin estado disponible: la etiqueta queda en "—".
    }
  }

  // Clic corto tipo dial usando Web Audio (sin archivos). Se crea el contexto
  // en el primer gesto del usuario (el arrastre) y se reutiliza.
  let audioCtx = null;
  function tic() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const t = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(500, t);
      gain.gain.setValueAtTime(0.05, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.035);
    } catch (e) { /* audio no disponible */ }
  }

  // Conecta el arrastre de una perilla dejando pasar el swipe horizontal al
  // carrusel (con touch-action: pan-x el navegador desliza el carrusel en un
  // swipe horizontal y manda pointercancel; los gestos verticales/rotatorios y
  // los toques operan el dial). cb: { desde(e)->valor|null, pintar(v), enviar(),
  // centro(), inicio()? }.
  function conectarDial(perilla, cb) {
    let inicio = null;
    let cambiado = false;
    let activo = false;
    const alMover = (e) => {
      if (!activo) return;
      const v = cb.desde(e);
      if (v !== null) { cb.pintar(v); cambiado = true; }
      e.preventDefault();
    };
    const fin = (e, cancelado) => {
      if (!activo) return;
      activo = false;
      window.removeEventListener('pointermove', alMover);
      window.removeEventListener('pointerup', alSoltar);
      window.removeEventListener('pointercancel', alCancelar);
      if (cancelado) return; // el navegador se llevó el gesto (swipe del carrusel)
      if (cambiado) { cb.enviar(); return; }
      // Fue un toque sin arrastre.
      const v = cb.desde(e || inicio);
      if (v === null) cb.centro();
      else { cb.pintar(v); cb.enviar(); }
    };
    const alSoltar = (e) => fin(e, false);
    const alCancelar = (e) => fin(e, true);
    perilla.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button > 0) return;
      if (cb.inicio) cb.inicio();
      inicio = e;
      cambiado = false;
      activo = true;
      window.addEventListener('pointermove', alMover);
      window.addEventListener('pointerup', alSoltar);
      window.addEventListener('pointercancel', alCancelar);
      // Sin preventDefault ni cambio de valor aquí: dejamos que el navegador
      // decida si es swipe horizontal (scroll) o gesto sobre el dial.
    });
  }

  // Perilla giratoria para dimmers: se arrastra alrededor del aro para fijar
  // el brillo (0–100%) y al soltar envía el comando.
  function perillaDimmer(dispositivo) {
    const perilla = document.createElement('div');
    perilla.className = 'perilla';
    perilla.setAttribute('role', 'slider');
    perilla.setAttribute('aria-label', `Brillo de ${dispositivo.nombre}`);
    perilla.setAttribute('aria-valuemin', '0');
    perilla.setAttribute('aria-valuemax', '100');
    perilla.innerHTML = '<svg class="perilla-svg" viewBox="0 0 120 120" aria-hidden="true"><circle class="perilla-track" cx="60" cy="60" r="48" pathLength="100" transform="rotate(135 60 60)"/><circle class="perilla-nivel" cx="60" cy="60" r="48" pathLength="100" stroke-dasharray="0 100" transform="rotate(135 60 60)"/></svg><div class="perilla-centro"><div class="perilla-indicador"></div><span class="perilla-valor">0</span></div>';
    const nivel = perilla.querySelector('.perilla-nivel');
    const txt = perilla.querySelector('.perilla-valor');
    const indicador = perilla.querySelector('.perilla-indicador');
    let valor = 0;
    let enviando = false;
    let ultimoDetente = -1;
    let ultimoBrillo = 100;

    const pintar = (v, sonar) => {
      valor = Math.max(0, Math.min(100, Math.round(v)));
      nivel.setAttribute('stroke-dasharray', `${valor * 0.75} 100`);
      indicador.style.transform = `rotate(${valor * 2.7 - 135}deg)`;
      txt.textContent = valor;
      perilla.classList.toggle('encendido', valor > 0);
      perilla.setAttribute('aria-valuenow', String(valor));
      if (sonar) {
        const detente = Math.round(valor / 3);
        if (detente !== ultimoDetente) { tic(); ultimoDetente = detente; }
      }
    };
    pintar(0);

    // Ángulo del puntero -> valor 0–100 sobre el arco de 270° (hueco abajo).
    const valorDesde = (e) => {
      const r = perilla.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      if (Math.hypot(dx, dy) < 34) return null; // zona central: no cambiar
      const ang = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
      const d = ((ang - 135) % 360 + 360) % 360;
      if (d <= 270) return (d / 270) * 100;
      return d < 315 ? 100 : 0;
    };

    async function enviarBrillo(extra) {
      if (enviando) return;
      enviando = true;
      if (!extra) perilla.classList.add('perilla-enviando'); // el pulso solo en arrastre directo
      try {
        await ejecutarComando({ dispositivoId: dispositivo.id, accion: 'brillo', valor, ...(extra || {}) });
      } catch (err) {
        toast(err.message || 'No se pudo enviar el comando.', 'error');
      } finally {
        perilla.classList.remove('perilla-enviando');
        enviando = false;
      }
    }

    // Anima la UI de la perilla de su valor actual hasta 'destino' (suave).
    let animId = null;
    function animarA(destino) {
      if (animId) cancelAnimationFrame(animId);
      const inicio = valor;
      const t0 = performance.now();
      const dur = 1400;
      const paso = (t) => {
        const k = Math.min(1, (t - t0) / dur);
        const suave = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // easeInOut
        pintar(inicio + (destino - inicio) * suave);
        animId = k < 1 ? requestAnimationFrame(paso) : null;
      };
      animId = requestAnimationFrame(paso);
    }

    conectarDial(perilla, {
      desde: valorDesde,
      pintar: (v) => pintar(v, true),
      enviar: () => { if (valor > 0) ultimoBrillo = valor; enviarBrillo(); },
      centro: () => {
        // Toque en el centro: apaga (fade out) o enciende al último brillo (fade in).
        const destino = valor > 0 ? 0 : (ultimoBrillo || 100);
        const desde = valor;
        animarA(destino);
        enviarBrillo({ valor: destino, desde, fade: true });
      },
      inicio: () => { if (animId) { cancelAnimationFrame(animId); animId = null; } },
    });

    (async () => {
      try {
        const res = await consultarEstado({ dispositivoId: dispositivo.id });
        const d = res.data || {};
        if (typeof d.brillo === 'number') pintar(d.brillo);
        // Recordar el último brillo aunque esté apagada (para reencender ahí).
        const mem = typeof d.brilloMemoria === 'number' ? d.brilloMemoria : d.brillo;
        if (typeof mem === 'number' && mem > 0) ultimoBrillo = mem;
      } catch (err) { /* sin estado disponible */ }
    })();

    return perilla;
  }

  // Perilla para cortinas/persianas: se arrastra para fijar la apertura
  // (0–100%, sin mostrar el número). Al soltar, la persiana se mueve hasta ahí;
  // el centro pausa/reanuda y la posición se recuerda.
  const ICONO_PAUSA = '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="4.2" height="14" rx="1.3"/><rect x="13.3" y="5" width="4.2" height="14" rx="1.3"/></svg>';
  const ICONO_PLAY = '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M8 5.2v13.6l11-6.8z"/></svg>';

  function perillaCortina(dispositivo, demo) {
    const perilla = document.createElement('div');
    perilla.className = 'perilla perilla-cortina';
    perilla.setAttribute('role', 'slider');
    perilla.setAttribute('aria-label', `Apertura de ${dispositivo.nombre}`);
    perilla.setAttribute('aria-valuemin', '0');
    perilla.setAttribute('aria-valuemax', '100');
    perilla.innerHTML = '<svg class="perilla-svg" viewBox="0 0 120 120" aria-hidden="true"><circle class="perilla-track" cx="60" cy="60" r="48" pathLength="100" transform="rotate(135 60 60)"/><circle class="perilla-nivel" cx="60" cy="60" r="48" pathLength="100" stroke-dasharray="0 100" transform="rotate(135 60 60)"/></svg><div class="perilla-centro"><div class="perilla-indicador"></div><span class="perilla-accion"></span></div>';
    const nivel = perilla.querySelector('.perilla-nivel');
    const indicador = perilla.querySelector('.perilla-indicador');
    const acc = perilla.querySelector('.perilla-accion');
    let valor = 0;
    let enviando = false;
    let ultimoDetente = -1;
    let enMarcha = false;
    let marchaTimer = null;

    const pintarAccion = () => { acc.innerHTML = enMarcha ? ICONO_PAUSA : ICONO_PLAY; };
    const marcarMarcha = (v) => {
      enMarcha = v;
      pintarAccion();
      clearTimeout(marchaTimer);
      // Tras el recorrido estimado, la persiana ya llegó: pasa a "reanudar".
      if (v) marchaTimer = setTimeout(() => { enMarcha = false; pintarAccion(); }, 22000);
    };

    const pintar = (v, sonar) => {
      valor = Math.max(0, Math.min(100, Math.round(v)));
      nivel.setAttribute('stroke-dasharray', `${valor * 0.75} 100`);
      indicador.style.transform = `rotate(${valor * 2.7 - 135}deg)`;
      perilla.classList.toggle('encendido', valor > 0);
      perilla.setAttribute('aria-valuenow', String(valor));
      if (sonar) {
        const detente = Math.round(valor / 3);
        if (detente !== ultimoDetente) { tic(); ultimoDetente = detente; }
      }
    };
    pintar(0);
    pintarAccion();

    // Ángulo del puntero -> valor 0–100 sobre el arco de 270° (hueco abajo).
    const valorDesde = (e) => {
      const r = perilla.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      if (Math.hypot(dx, dy) < 34) return null; // zona central: no cambiar
      const ang = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
      const d = ((ang - 135) % 360 + 360) % 360;
      if (d <= 270) return (d / 270) * 100;
      return d < 315 ? 100 : 0;
    };

    async function enviar(data) {
      if (demo || enviando) return; // en el vestuario no se manda nada
      enviando = true;
      perilla.classList.add('perilla-enviando');
      try {
        await ejecutarComando({ dispositivoId: dispositivo.id, ...data });
      } catch (err) {
        toast(err.message || 'No se pudo enviar el comando.', 'error');
      } finally {
        perilla.classList.remove('perilla-enviando');
        enviando = false;
      }
    }

    conectarDial(perilla, {
      desde: valorDesde,
      pintar: (v) => pintar(v, true),
      enviar: () => { marcarMarcha(true); enviar({ accion: 'posicion', valor }); },
      centro: () => {
        // Toque en el centro: pausa (si va en marcha) o reanuda hacia el objetivo.
        if (enMarcha) { marcarMarcha(false); enviar({ accion: 'detener' }); }
        else { marcarMarcha(true); enviar({ accion: 'posicion', valor }); }
      },
    });

    if (demo) {
      pintar(60); // valor de muestra para el vestuario
    } else {
      (async () => {
        try {
          const res = await consultarEstado({ dispositivoId: dispositivo.id });
          if (res.data && typeof res.data.posicion === 'number') pintar(res.data.posicion);
        } catch (err) { /* sin estado disponible */ }
      })();
    }

    return perilla;
  }

  // Perilla de termostato: se arrastra para fijar la temperatura objetivo,
  // muestra la actual, y tocar el centro enciende (frío) o apaga.
  const TERMO_MIN = 10;
  const TERMO_MAX = 32;
  function perillaTermostato(dispositivo, demo) {
    const cont = document.createElement('div');
    cont.className = 'termostato';
    const perilla = document.createElement('div');
    perilla.className = 'perilla perilla-termo encendido modo-off';
    perilla.setAttribute('role', 'slider');
    perilla.setAttribute('aria-label', `Temperatura de ${dispositivo.nombre}`);
    perilla.setAttribute('aria-valuemin', String(TERMO_MIN));
    perilla.setAttribute('aria-valuemax', String(TERMO_MAX));
    perilla.innerHTML = '<svg class="perilla-svg" viewBox="0 0 120 120" aria-hidden="true"><circle class="perilla-track" cx="60" cy="60" r="48" pathLength="100" transform="rotate(135 60 60)"/><circle class="perilla-nivel" cx="60" cy="60" r="48" pathLength="100" stroke-dasharray="0 100" transform="rotate(135 60 60)"/></svg><div class="perilla-centro"><div class="perilla-indicador"></div><span class="termo-objetivo">--°</span></div>';
    const nivel = perilla.querySelector('.perilla-nivel');
    const indicador = perilla.querySelector('.perilla-indicador');
    const objTxt = perilla.querySelector('.termo-objetivo');
    let objetivo = TERMO_MIN;
    let encendido = false;
    let enviando = false;
    let ultimoDetente = -1;

    const fmt = (t) => (Number.isInteger(t) ? String(t) : t.toFixed(1));
    const clamp = (t) => Math.max(TERMO_MIN, Math.min(TERMO_MAX, Math.round(t * 2) / 2));
    const pintar = (t, sonar) => {
      objetivo = clamp(t);
      const frac = (objetivo - TERMO_MIN) / (TERMO_MAX - TERMO_MIN);
      nivel.setAttribute('stroke-dasharray', `${(frac * 75).toFixed(2)} 100`);
      indicador.style.transform = `rotate(${(frac * 270 - 135).toFixed(1)}deg)`;
      objTxt.textContent = fmt(objetivo) + '°';
      perilla.setAttribute('aria-valuenow', String(objetivo));
      if (sonar) {
        const det = Math.round(objetivo * 2);
        if (det !== ultimoDetente) { tic(); ultimoDetente = det; }
      }
    };
    const pintarEstado = () => {
      perilla.classList.remove('modo-off', 'modo-cool');
      perilla.classList.add(encendido ? 'modo-cool' : 'modo-off');
    };

    // Ángulo del puntero -> temperatura sobre el arco de 270° (hueco abajo).
    const tempDesde = (e) => {
      const r = perilla.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      // Todo el botón central (≈66% del radio) es zona de encender/apagar.
      if (Math.hypot(dx, dy) < r.width * 0.33) return null;
      const ang = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
      const d = ((ang - 135) % 360 + 360) % 360;
      const frac = d <= 270 ? d / 270 : (d < 315 ? 1 : 0);
      return TERMO_MIN + frac * (TERMO_MAX - TERMO_MIN);
    };

    async function enviarTemp() {
      if (demo || enviando) return; // en el vestuario no se manda nada
      enviando = true;
      perilla.classList.add('perilla-enviando');
      try {
        await ejecutarComando({ dispositivoId: dispositivo.id, accion: 'temperatura', valor: objetivo });
      } catch (err) {
        toast(err.message || 'No se pudo enviar el comando.', 'error');
      } finally {
        perilla.classList.remove('perilla-enviando');
        enviando = false;
      }
    }

    async function enviarModo(m) {
      if (demo) return; // en el vestuario no se manda nada
      try {
        await ejecutarComando({ dispositivoId: dispositivo.id, accion: 'modo', valor: m });
      } catch (err) {
        toast(err.message || 'No se pudo enviar el comando.', 'error');
      }
    }

    conectarDial(perilla, {
      desde: tempDesde,
      pintar: (v) => pintar(v, true),
      enviar: enviarTemp,
      centro: () => {
        // Toque en el centro: encender (frío) o apagar.
        encendido = !encendido;
        pintarEstado();
        enviarModo(encendido ? 'cool' : 'off');
      },
    });

    // Nombre + temperatura actual al lado.
    const etiqueta = document.createElement('span');
    etiqueta.className = 'etiqueta-control';
    etiqueta.textContent = dispositivo.nombre;
    const temp = document.createElement('span');
    temp.className = 'termo-temp';
    etiqueta.appendChild(temp);
    pintar(TERMO_MIN);
    pintarEstado();
    cont.append(perilla, etiqueta);

    if (demo) {
      // Valores de muestra para el vestuario, sin consultar el termostato.
      pintar(23);
      encendido = true;
      pintarEstado();
    } else (async () => {
      try {
        const res = await consultarEstado({ dispositivoId: dispositivo.id });
        const d = res.data || {};
        if (typeof d.temperaturaObjetivo === 'number') pintar(d.temperaturaObjetivo);
        if (typeof d.temperaturaActual === 'number') temp.textContent = ` · ${fmt(Math.round(d.temperaturaActual * 2) / 2)}°`;
        encendido = !!(d.modoHVAC && d.modoHVAC !== 'off');
        pintarEstado();
      } catch (err) { /* sin estado disponible */ }
    })();

    return cont;
  }

  // ── Gestión (solo admin) ──────────────────────────────────────────────

  let cacheDispositivos = [];
  let cacheUsuarios = [];
  let cacheInmuebles = [];

  // Alcance del admin que está mirando: vacío = el dueño, que ve todo.
  const miAlcance = () => (usuarioActual && usuarioActual.administraIds) || [];

  // `in` y `array-contains-any` admiten 30 valores; un alcance grande se parte.
  const enTrozos = (lista, n = 30) => {
    const out = [];
    for (let i = 0; i < lista.length; i += n) out.push(lista.slice(i, i + n));
    return out;
  };
  const unirDocs = (resultados) => {
    const vistos = new Map();
    for (const r of resultados) {
      if (!r) continue;
      for (const d of r.docs) vistos.set(d.id, d);
    }
    return [...vistos.values()];
  };

  async function cargarGestion() {
    try {
      // Un admin de edificio tiene que pedir SOLO lo suyo: la regla de Firestore
      // se evalúa por documento, así que una consulta sin filtrar le fallaría
      // entera en cuanto cayera algo de otro edificio.
      const alc = miAlcance();
      const pedirDisp = alc.length
        ? Promise.all(enTrozos(alc).map((t) => getDocs(query(
            collection(db, 'dispositivos'), where('inmueble', 'in', t))))).then(unirDocs)
        : getDocs(collection(db, 'dispositivos')).then((r) => r.docs);
      const pedirUsu = alc.length
        ? Promise.all(enTrozos(alc).map((t) => getDocs(query(
            collection(db, 'usuarios'), where('inmueblesIds', 'array-contains-any', t))))).then(unirDocs)
        : getDocs(collection(db, 'usuarios')).then((r) => r.docs);
      const [dispDocs, usuDocs, inmSnap] = await Promise.all([
        pedirDisp, pedirUsu, getDocs(collection(db, 'inmuebles')),
      ]);
      cacheDispositivos = dispDocs
        .map((s) => normalizar({ id: s.id, ...s.data() }))
        .sort((a, b) => (a.orden || 99) - (b.orden || 99));
      cacheUsuarios = usuDocs
        .map((s) => ({ uid: s.id, ...s.data() }))
        .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
      cacheInmuebles = inmSnap.docs
        .map((s) => ({ id: s.id, ...s.data() }))
        .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
      renderGestion();
      pintarConexion(conexionGuardada());
      pintarProveedores(); // sin await: la lista no espera por Auth
    } catch (err) {
      toast('No se pudo cargar la gestión.', 'error');
    }
  }

  function filaGestion(texto, inactivo, alEditar) {
    const li = document.createElement('li');
    if (inactivo) li.classList.add('inactivo');
    const info = document.createElement('span');
    info.textContent = texto;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-secundario';
    btn.textContent = 'Editar';
    btn.addEventListener('click', alEditar);
    li.append(info, btn);
    return li;
  }

  // Pinta el punto de conexión de cada dispositivo. Si no se sabe el estado no
  // se pinta nada: mejor sin dato que un rojo mentiroso.
  function pintarConexion(lista) {
    for (const d of lista || []) {
      const fila = document.querySelector(`#gestion-dispositivos li[data-disp="${d.id}"]`);
      if (!fila) continue;
      const info = fila.querySelector('span');
      if (!info) continue;
      const viejo = info.querySelector('.punto-con');
      if (viejo) viejo.remove();
      if (d.online === null || d.online === undefined) continue;
      const punto = document.createElement('i');
      punto.className = `punto-con ${d.online ? 'con-ok' : 'con-mal'}`;
      const desde = d.desde ? ` desde ${fmtFecha(d.desde)}` : '';
      punto.title = (d.online ? 'En línea' : 'Sin conexión') + desde;
      info.prepend(punto);
    }
  }

  // Estado guardado por el chequeo automático (cada 10 min). Sale al instante,
  // sin llamar a Tuya: ya viene en el documento de cada dispositivo.
  const conexionGuardada = () => cacheDispositivos.map((d) => {
    const c = d.conexion || {};
    const ms = c.desde && typeof c.desde.toMillis === 'function' ? c.desde.toMillis() : null;
    return { id: d.id, online: typeof c.online === 'boolean' ? c.online : null, desde: ms };
  });

  // Botón de actualizar: consulta en vivo, por si no quieres esperar los 10 min.
  async function refrescarConexion(boton) {
    if (boton) boton.disabled = true;
    try {
      const res = await estadoDispositivos();
      pintarConexion((res.data && res.data.dispositivos) || []);
      toast('Estado actualizado.', 'ok');
    } catch (err) {
      toast('No se pudo consultar el estado.', 'error');
    } finally {
      if (boton) boton.disabled = false;
    }
  }

  function renderGestion() {
    const ld = $('gestion-dispositivos');
    ld.textContent = '';
    // Agrupados por proveedor: Tuya primero, luego Homebridge.
    const grupos = [
      ['Tuya', (d) => (d.proveedor || 'tuya') !== 'homebridge'],
      ['Homebridge', (d) => d.proveedor === 'homebridge'],
    ];
    const MODOS = { pulso: 'pulso', interruptor: 'interruptor', cortina: 'cortina', dimmer: 'dimmer', termostato: 'termostato' };
    for (const [titulo, filtro] of grupos) {
      const items = cacheDispositivos.filter(filtro);
      if (!items.length) continue;
      const cab = document.createElement('li');
      cab.className = 'grupo-gestion';
      cab.textContent = titulo;
      ld.appendChild(cab);
      for (const d of items) {
        const texto = `${d.nombre} · ${MODOS[d.modo] || 'pulso'}`;
        const fila = filaGestion(texto, d.activo === false, () => abrirEditorDispositivo(d));
        fila.dataset.disp = d.id; // para colgarle después el punto de conexión
        ld.appendChild(fila);
      }
    }
    const li = $('gestion-inmuebles');
    li.textContent = '';
    if (!cacheInmuebles.length) {
      const vacio = document.createElement('li');
      vacio.className = 'vacio';
      vacio.textContent = 'Aún no hay inmuebles. Créalos para asignarlos a los vecinos.';
      li.appendChild(vacio);
    }
    for (const inm of cacheInmuebles) {
      const texto = `${inm.nombre} · ${TIPO_INMUEBLE_TXT[inm.tipo] || inm.tipo}`;
      li.appendChild(filaGestion(texto, false, () => abrirEditorInmueble(inm)));
    }

    renderVecinos();
  }

  // Residente = el que tiene algo permanente: su inmueble, dispositivos
  // sueltos, o es admin. Visitante = quien entró por una invitación y solo
  // tiene accesos temporales, sin nada asignado.
  const esResidente = (u) => (u.inmuebles || []).length > 0
    || (u.dispositivos || []).length > 0
    || u.rol === 'admin';

  function renderVecinos() {
    const lu = $('gestion-usuarios');
    lu.textContent = '';
    const q = ($('buscar-vecino').value || '').trim().toLowerCase();
    const coincide = (u) => !q
      || `${nombreCompleto(u)} ${u.email || ''}`.toLowerCase().includes(q);
    const visibles = cacheUsuarios.filter(coincide);   // ya vienen por nombre
    const grupos = [
      ['Residentes', visibles.filter(esResidente)],
      ['Visitantes', visibles.filter((u) => !esResidente(u))],
    ];
    for (const [titulo, lista] of grupos) {
      if (!lista.length) continue;
      const cab = document.createElement('li');
      cab.className = 'grupo-gestion';
      cab.textContent = `${titulo} (${lista.length})`;
      lu.appendChild(cab);
      for (const u of lista) {
        const inm = (u.inmuebles || []).map((x) => x.nombre).join(', ');
        const partes = [nombreCompleto(u), inm, u.rol === 'admin' ? 'admin' : null].filter(Boolean);
        const fila = filaGestion(partes.join(' · '), u.activo === false, () => abrirEditorUsuario(u));
        fila.dataset.uid = u.uid; // para colgarle después cómo entra
        lu.appendChild(fila);
      }
    }
    if (!visibles.length) {
      const vacio = document.createElement('li');
      vacio.className = 'grupo-gestion';
      vacio.textContent = q ? 'Nadie coincide con la búsqueda.' : 'Sin vecinos todavía.';
      lu.appendChild(vacio);
    }
    marcarProveedores();   // repintar tras filtrar, o se perderían las marcas
  }

  // Marca cómo entra cada vecino: con Google, con clave, o las dos. El dato
  // vive en Firebase Auth, así que se pide aparte y se pinta al llegar.
  let cacheProveedores = null;

  async function pintarProveedores() {
    try {
      const res = await adminProveedores();
      cacheProveedores = (res.data && res.data.proveedores) || {};
    } catch (err) { return; }
    marcarProveedores();
  }

  // Cuelga "cómo entra" de cada fila. Se llama tras cada repintado de la lista
  // (buscar la rehace) porque las marcas viven en el DOM, no en los datos.
  function marcarProveedores() {
    if (!cacheProveedores) return;
    for (const [uid, provs] of Object.entries(cacheProveedores)) {
      const fila = document.querySelector(`#gestion-usuarios li[data-uid="${uid}"]`);
      if (!fila) continue;
      const info = fila.querySelector('span');
      if (!info || info.querySelector('.como-entra')) continue;
      const conGoogle = provs.includes('google.com');
      const conClave = provs.includes('password');
      const txt = conGoogle && conClave ? 'Google + clave' : (conGoogle ? 'Google' : (conClave ? 'Clave' : ''));
      if (!txt) continue;
      const tag = document.createElement('em');
      tag.className = 'como-entra';
      tag.textContent = txt;
      info.append(tag);
    }
  }

  function campo(etiqueta, control) {
    const label = document.createElement('label');
    label.className = 'campo';
    const span = document.createElement('span');
    span.textContent = etiqueta;
    label.append(span, control);
    return label;
  }

  // Campo que arranca replegado. Para lo que ya no es el camino normal pero
  // sigue estando disponible (reutiliza el mismo botón con chevrón del resto).
  function campoDesplegable(etiqueta, control, abierto, ayuda) {
    const caja = document.createElement('div');
    caja.className = 'campo';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-desplegar';
    btn.textContent = etiqueta;
    btn.setAttribute('aria-expanded', String(!!abierto));
    const cuerpo = document.createElement('div');
    if (ayuda) {
      const nota = document.createElement('p');
      nota.className = 'campo-ayuda';
      nota.textContent = ayuda;
      cuerpo.appendChild(nota);
    }
    cuerpo.appendChild(control);
    cuerpo.classList.toggle('oculto', !abierto);
    btn.addEventListener('click', () => {
      const mostrar = cuerpo.classList.contains('oculto');
      cuerpo.classList.toggle('oculto', !mostrar);
      btn.setAttribute('aria-expanded', String(mostrar));
    });
    caja.append(btn, cuerpo);
    return { caja, etiquetar: (txt) => { btn.textContent = txt; } };
  }

  function entrada(valor, placeholder, tipo) {
    const i = document.createElement('input');
    i.type = tipo || 'text';
    i.value = valor == null ? '' : valor;
    if (placeholder) i.placeholder = placeholder;
    return i;
  }

  function selector(opciones, valor) {
    const s = document.createElement('select');
    for (const [v, t] of opciones) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      s.appendChild(o);
    }
    if (valor != null) s.value = valor;
    return s;
  }

  function casilla(texto, marcada) {
    const label = document.createElement('label');
    label.className = 'casilla';
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = Boolean(marcada);
    const span = document.createElement('span');
    span.textContent = texto;
    label.append(c, span);
    const sync = () => label.classList.toggle('marcada', c.checked);
    c.addEventListener('change', sync);
    sync();
    return { label, c };
  }

  function casillasDispositivos(asignados) {
    const cont = document.createElement('div');
    cont.className = 'casillas';
    const set = new Set(asignados || []);
    const mapa = new Map();
    for (const d of cacheDispositivos) {
      const { label, c } = casilla(d.nombre, set.has(d.id));
      mapa.set(d.id, c);
      cont.appendChild(label);
    }
    return { cont, seleccionados: () => [...mapa].filter(([, c]) => c.checked).map(([id]) => id) };
  }

  // Alcance de un administrador: qué inmuebles administra. Solo lo reparte el
  // dueño, y solo tiene sentido si el rol es admin. Vacío = admin global.
  function casillasAlcance(ids) {
    const cont = document.createElement('div');
    cont.className = 'casillas';
    const set = new Set(ids || []);
    const mapa = new Map();
    for (const inm of cacheInmuebles) {
      const { label, c } = casilla(rutaInmueble(inm.id), set.has(inm.id));
      mapa.set(inm.id, c);
      cont.appendChild(label);
    }
    return { cont, seleccionados: () => [...mapa].filter(([, c]) => c.checked).map(([id]) => id) };
  }

  function casillasInmuebles(asignados) {
    const cont = document.createElement('div');
    cont.className = 'casillas';
    const set = new Set((asignados || []).map((x) => x.id));
    const mapa = new Map();
    if (!cacheInmuebles.length) {
      const p = document.createElement('p');
      p.className = 'ayuda-pase';
      p.textContent = 'No hay inmuebles creados todavía.';
      cont.appendChild(p);
    }
    for (const inm of cacheInmuebles) {
      const { label, c } = casilla(`${inm.nombre} · ${TIPO_INMUEBLE_TXT[inm.tipo] || inm.tipo}`, set.has(inm.id));
      mapa.set(inm.id, c);
      cont.appendChild(label);
    }
    return {
      cont,
      seleccionados: () => cacheInmuebles
        .filter((inm) => mapa.get(inm.id) && mapa.get(inm.id).checked)
        .map((inm) => ({ id: inm.id, tipo: inm.tipo, nombre: inm.nombre })),
    };
  }

  function botonForm(texto, clase, alHacerClic) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = clase;
    b.textContent = texto;
    b.addEventListener('click', alHacerClic);
    return b;
  }

  function abrirEditor(titulo, filas, acciones) {
    const ed = $('editor');
    ed.textContent = '';
    const h = document.createElement('h3');
    h.className = 'titulo-editor';
    h.textContent = titulo;
    ed.appendChild(h);
    for (const f of filas) ed.appendChild(f);
    const barra = document.createElement('div');
    barra.className = 'barra-editor';
    for (const a of acciones) barra.appendChild(a);
    ed.appendChild(barra);
    ed.classList.remove('oculto');
    ed.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function cerrarEditor() {
    $('editor').classList.add('oculto');
    $('editor').textContent = '';
  }

  async function trasGuardar(boton) {
    cerrarEditor();
    await cargarGestion();
    renderDispositivos(await cargarDispositivos(usuarioActual));
  }

  async function abrirEditorDispositivo(existente) {
    const esNuevo = !existente;
    const d = existente || {};
    let tuya = { tuyaDeviceId: '', codigo: 'switch_1', pulsoMs: 1000, codigoBrillo: 'bright_value_v2', brilloMax: 1000, posicionInvertida: false, accesorioId: '', caracteristica: '' };
    if (!esNuevo) {
      try {
        const s = await getDoc(doc(db, `dispositivos/${d.id}/privado/tuya`));
        if (s.exists()) tuya = { ...tuya, ...s.data() };
      } catch (err) { /* sin acceso todavía: campos vacíos */ }
    }
    const iId = entrada(d.id, 'se genera del nombre');
    if (!esNuevo) iId.disabled = true;
    const iNombre = entrada(d.nombre, 'ej: Portón del Garaje');
    iNombre.maxLength = 18; // límite para que el nombre no se salga del botón
    // Identificador = nombre en minúsculas, sin acentos, palabras con guion.
    const aSlug = (s) => s.toLowerCase()
      .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i')
      .replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u').replace(/ñ/g, 'n')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    let idManual = !esNuevo; // en edición el id ya está fijo; no se regenera
    iId.addEventListener('input', () => { idManual = true; });
    iNombre.addEventListener('input', () => {
      const pos = iNombre.selectionStart;
      iNombre.value = tituloCase(iNombre.value);
      try { iNombre.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
      if (!idManual) iId.value = aSlug(iNombre.value);
    });
    const sTipo = selector([['puerta', 'Puerta'], ['cortina', 'Cortina / persiana'], ['ascensor', 'Ascensor'], ['luz', 'Luz'], ['termostato', 'Termostato'], ['rele', 'Relé / equipo'], ['otro', 'Otro']], d.tipo || 'puerta');
    const sSub = selector(SUBTIPOS.puerta, d.subtipo || '');
    const campoSub = campo('Subcategoría', sSub);
    // Aspecto del control: normal, o el Jet Switch con tapa de seguridad. Solo
    // se ofrece para puertas de pulso (portones), donde la tapa evita aperturas
    // accidentales; en otros casos se oculta y no aplica.
    const sAspecto = selector([['normal', 'Normal'], ['jet', 'Jet Switch (tapa de seguridad)'], ['argentina', 'Argentina (escudo)'], ['bordado', 'Bordado (parche)'], ['hal', 'Hal (ojo rojo)']], d.aspecto || 'normal');
    const campoAspecto = campo('Aspecto', sAspecto);
    // Cuánto tarda esta puerta en abrir completo: la animación del botón (ojo de
    // Hal, bordado, persianas) dura ese tiempo, para acompañar al portón real.
    // Es por dispositivo porque cada portón tarda lo suyo.
    const iSegundos = entrada(d.segundosApertura || 15, '', 'number');
    const campoSegundos = campo('Segundos en abrir (animación del botón)', iSegundos);
    // Inmueble donde está físicamente. Hace dos cosas: los vecinos de ese
    // inmueble heredan el acceso, y queda registrado dónde buscar el aparato si
    // se cae la luz o el internet.
    const sInmueble = selector(opcionesInmueble(undefined, '— sin asignar —'), d.inmueble || '');
    const actualizarSub = () => {
      campoSub.classList.toggle('oculto', sTipo.value !== 'puerta');
      const esPuertaPulso = sTipo.value === 'puerta' && sModo.value === 'pulso';
      campoAspecto.classList.toggle('oculto', !esPuertaPulso);
      campoSegundos.classList.toggle('oculto', !esPuertaPulso);
    };
    sTipo.addEventListener('change', actualizarSub);
    // (sModo aún no existe aquí; el cambio de modo y la llamada inicial van más
    // abajo, cuando sModo ya está definido.)
    const sModo = selector([['pulso', 'Pulso (abrir y soltar)'], ['interruptor', 'Interruptor (on/off)'], ['cortina', 'Cortina (perilla de apertura)'], ['dimmer', 'Dimmer (perilla de brillo)'], ['termostato', 'Termostato (temperatura)']], d.modo || 'pulso');
    const campoModo = campo('Modo', sModo);
    // Un termostato solo tiene el modo termostato: al elegir ese tipo se
    // auto-selecciona el modo y se oculta el campo; al salir, se restablece.
    const sincronizarModoTipo = () => {
      if (sTipo.value === 'termostato') {
        sModo.value = 'termostato';
        campoModo.classList.add('oculto');
      } else {
        campoModo.classList.remove('oculto');
        if (sModo.value === 'termostato') sModo.value = 'pulso';
      }
      actualizarCampos();
    };
    sTipo.addEventListener('change', sincronizarModoTipo);
    const iOrden = entrada(d.orden != null ? d.orden : 10, '', 'number');
    const cActivo = casilla('Activo', d.activo !== false);
    const iDevice = entrada(tuya.tuyaDeviceId, 'Device ID de Tuya');
    const iCodigo = entrada(tuya.codigo, 'switch_1');
    const iPulso = entrada(tuya.pulsoMs, '', 'number');
    const iCodigoBrillo = entrada(tuya.codigoBrillo, 'bright_value_v2');
    const iBrilloMax = entrada(tuya.brilloMax, '', 'number');
    const campoBrilloCodigo = campo('Código de brillo (Tuya)', iCodigoBrillo);
    const campoBrilloMax = campo('Brillo máximo (rango Tuya, ej. 1000)', iBrilloMax);
    const cInvertir = casilla('Invertir apertura (marca si la persiana abre al revés)', tuya.posicionInvertida === true);

    // Proveedor: Tuya (nube) o Homebridge (API de UI-X vía túnel).
    const sProveedor = selector([['tuya', 'Tuya'], ['homebridge', 'Homebridge']], d.proveedor || 'tuya');
    const campoDevice = campo('Device ID de Tuya', iDevice);
    const campoCodigo = campo('Código del interruptor (Debug Device)', iCodigo);
    // Homebridge: elegir el accesorio de la lista de UI-X.
    const selAcc = document.createElement('select');
    if (tuya.accesorioId) {
      const o = document.createElement('option');
      o.value = tuya.accesorioId;
      o.textContent = tuya.accesorioId + ' (actual)';
      selAcc.appendChild(o);
    }
    const iCaracteristica = entrada(tuya.caracteristica, 'On (por defecto)');
    const campoCaracteristica = campo('Característica HomeKit (avanzado, ej. On, TargetDoorState)', iCaracteristica);
    const estadoAcc = document.createElement('div');
    estadoAcc.className = 'dps-detectados';
    const btnAcc = botonForm('Traer accesorios de Homebridge', 'btn-secundario', async (ev) => {
      const b = ev.currentTarget;
      b.disabled = true;
      const orig = b.textContent;
      b.textContent = 'Consultando…';
      estadoAcc.textContent = '';
      try {
        const res = await adminListarAccesoriosHomebridge({});
        const lista = (res.data && res.data.accesorios) || [];
        selAcc.textContent = '';
        for (const a of lista) {
          const o = document.createElement('option');
          o.value = a.uniqueId;
          o.textContent = `${a.nombre}${a.tipo ? ' — ' + a.tipo : ''}`;
          selAcc.appendChild(o);
        }
        if (tuya.accesorioId) selAcc.value = tuya.accesorioId;
        estadoAcc.textContent = lista.length ? `${lista.length} accesorios cargados.` : 'No se encontraron accesorios.';
      } catch (err) {
        estadoAcc.textContent = err.message || 'No se pudo consultar Homebridge.';
      } finally {
        b.disabled = false;
        b.textContent = orig;
      }
    });
    // Diagnóstico: muestra el estado crudo del accesorio (tipo, características, valores).
    const debugAcc = document.createElement('pre');
    debugAcc.className = 'dps-detectados';
    debugAcc.style.whiteSpace = 'pre-wrap';
    const btnDebug = botonForm('Ver estado del accesorio (debug)', 'btn-secundario', async (ev) => {
      const idAcc = (selAcc.value || tuya.accesorioId || '').trim();
      if (!idAcc) { toast('Elige un accesorio primero.', 'error'); return; }
      const b = ev.currentTarget;
      b.disabled = true;
      const orig = b.textContent;
      b.textContent = 'Consultando…';
      debugAcc.textContent = '';
      try {
        const res = await adminAccesorioCrudo({ accesorioId: idAcc });
        debugAcc.textContent = JSON.stringify(res.data, null, 2);
      } catch (err) {
        debugAcc.textContent = err.message || 'No se pudo consultar.';
      } finally {
        b.disabled = false;
        b.textContent = orig;
      }
    });
    const campoAccesorio = document.createElement('div');
    campoAccesorio.className = 'campo';
    const spanAcc = document.createElement('span');
    spanAcc.textContent = 'Accesorio de Homebridge';
    campoAccesorio.append(spanAcc, selAcc, btnAcc, estadoAcc, btnDebug, debugAcc);
    const iResultadoDps = document.createElement('div');
    iResultadoDps.className = 'dps-detectados';
    const btnDetectar = botonForm('Detectar DPs del dispositivo', 'btn-secundario', async (ev) => {
      const b = ev.currentTarget;
      const idTuya = iDevice.value.trim();
      if (!idTuya) { toast('Primero pon el Device ID de Tuya.', 'error'); return; }
      b.disabled = true;
      const orig = b.textContent;
      b.textContent = 'Detectando…';
      iResultadoDps.textContent = '';
      try {
        const res = await adminInspeccionarDispositivo({ tuyaDeviceId: idTuya });
        const funciones = (res.data && res.data.funciones) || [];
        const sw = funciones.find((f) => f.type === 'Boolean' && /switch|light/i.test(f.code)) || funciones.find((f) => f.type === 'Boolean');
        const brillo = funciones.find((f) => /bright/i.test(f.code));
        if (sw) iCodigo.value = sw.code;
        if (brillo) {
          iCodigoBrillo.value = brillo.code;
          try { const v = JSON.parse(brillo.values || '{}'); if (v.max) iBrilloMax.value = v.max; } catch (e) { /* sin rango */ }
        }
        const lista = funciones.map((f) => f.code).join(', ');
        iResultadoDps.innerHTML = (brillo
          ? `✓ Brillo detectado: <b>${brillo.code}</b>${iBrilloMax.value ? ` (máx ${iBrilloMax.value})` : ''}`
          : '⚠ No encontré un DP de brillo; elige a mano uno con "bright".')
          + `<br>DPs disponibles: ${lista}`;
      } catch (err) {
        iResultadoDps.textContent = err.message || 'No se pudo detectar.';
      } finally {
        b.disabled = false;
        b.textContent = orig;
      }
    });
    const campoDetectar = document.createElement('div');
    campoDetectar.className = 'campo';
    campoDetectar.append(btnDetectar, iResultadoDps);
    const actualizarCampos = () => {
      const esHb = sProveedor.value === 'homebridge';
      const esDimmer = sModo.value === 'dimmer';
      campoDevice.classList.toggle('oculto', esHb);
      campoCodigo.classList.toggle('oculto', esHb);
      campoBrilloCodigo.classList.toggle('oculto', esHb || !esDimmer);
      campoBrilloMax.classList.toggle('oculto', esHb || !esDimmer);
      // El inspector de DPs sirve para cualquier dispositivo Tuya (no solo
      // dimmers): es la herramienta para depurar suiches, cortinas, etc.
      campoDetectar.classList.toggle('oculto', esHb);
      campoAccesorio.classList.toggle('oculto', !esHb);
      campoCaracteristica.classList.toggle('oculto', !esHb);
      cInvertir.label.classList.toggle('oculto', sModo.value !== 'cortina');
    };
    sProveedor.addEventListener('change', actualizarCampos);
    sModo.addEventListener('change', actualizarCampos);
    sModo.addEventListener('change', actualizarSub); // el aspecto Jet solo aplica a pulso
    actualizarCampos();
    sincronizarModoTipo();
    actualizarSub();

    const acciones = [
      botonForm('Guardar', 'btn-primario', async (ev) => {
        const b = ev.currentTarget;
        b.disabled = true;
        try {
          await adminGuardarDispositivo({
            id: (iId.value || '').trim().toLowerCase(),
            nombre: iNombre.value.trim(),
            tipo: sTipo.value,
            subtipo: sTipo.value === 'puerta' ? sSub.value : '',
            aspecto: (sTipo.value === 'puerta' && sModo.value === 'pulso') ? sAspecto.value : 'normal',
            segundosApertura: Number(iSegundos.value) || 15,
            inmueble: sInmueble.value,
            modo: sModo.value,
            proveedor: sProveedor.value,
            orden: Number(iOrden.value) || 99,
            activo: cActivo.c.checked,
            tuyaDeviceId: iDevice.value.trim(),
            codigo: iCodigo.value.trim(),
            pulsoMs: Number(iPulso.value) || 1000,
            codigoBrillo: iCodigoBrillo.value.trim(),
            brilloMax: Number(iBrilloMax.value) || 1000,
            posicionInvertida: cInvertir.c.checked,
            accesorioId: sProveedor.value === 'homebridge' ? selAcc.value : '',
            caracteristica: iCaracteristica.value.trim(),
          });
          toast('Dispositivo guardado ✓', 'ok');
          await trasGuardar();
        } catch (err) {
          toast(err.message || 'No se pudo guardar.', 'error');
          b.disabled = false;
        }
      }),
      botonForm('Cancelar', 'btn-secundario', cerrarEditor),
    ];
    if (!esNuevo) {
      acciones.push(botonForm('Eliminar', 'btn-peligro', async (ev) => {
        if (!confirm(`¿Eliminar "${d.nombre}"? Esta acción no se puede deshacer.`)) return;
        const b = ev.currentTarget;
        b.disabled = true;
        try {
          await adminEliminarDispositivo({ id: d.id });
          toast('Dispositivo eliminado.', 'ok');
          await trasGuardar();
        } catch (err) {
          toast(err.message || 'No se pudo eliminar.', 'error');
          b.disabled = false;
        }
      }));
    }

    abrirEditor(esNuevo ? 'Nuevo dispositivo' : `Editar: ${d.nombre}`, [
      campo('Nombre visible', iNombre),
      campo('Identificador (se genera solo, no cambia después)', iId),
      campo('Tipo', sTipo),
      campoSub,
      campoModo,
      campoAspecto,
      campoSegundos,
      campo('Inmueble (dónde está)', sInmueble),
      campo('Proveedor', sProveedor),
      campo('Orden (menor = primero)', iOrden),
      cActivo.label,
      campoDevice,
      campoCodigo,
      campoAccesorio,
      campoCaracteristica,
      campo('Duración del pulso (ms)', iPulso),
      campoBrilloCodigo,
      campoBrilloMax,
      cInvertir.label,
      campoDetectar,
    ], acciones);
  }

  // Nombre de un inmueble con su cadena hacia arriba, para que en un selector
  // se distinga "Apto 3B" de Torre A del "Apto 3B" de Torre B.
  function rutaInmueble(id, tope = 6) {
    const partes = [];
    let actual = id;
    for (let n = 0; n < tope && actual; n++) {
      const inm = cacheInmuebles.find((x) => x.id === actual);
      if (!inm) break;
      partes.push(inm.nombre);
      actual = inm.padre || '';
    }
    return partes.join(' · ');
  }

  // Opciones de inmueble para un selector. `excluir` saca al propio inmueble
  // (nadie es su padre) y a sus descendientes se los rechaza el backend.
  function opcionesInmueble(excluir, vacio = '— sin inmueble —') {
    return [['', vacio]].concat(
      cacheInmuebles
        .filter((x) => x.id !== excluir)
        .map((x) => [x.id, rutaInmueble(x.id)]),
    );
  }

  function abrirEditorInmueble(existente) {
    const esNuevo = !existente;
    const inm = existente || {};
    const sTipo = selector(Object.entries(TIPO_INMUEBLE_TXT), inm.tipo || 'edificio');
    const iNombre = entrada(inm.nombre, 'ej: Torre A, Casa 12');
    const iCiudad = entrada(inm.ciudad);
    const iEstado = entrada(inm.estado);
    const iZona = entrada(inm.zona);
    [iNombre, iCiudad, iEstado, iZona].forEach((i) => i.setAttribute('autocapitalize', 'words'));
    // Padre: arma la jerarquía conjunto -> edificio -> apartamento. Quien tenga
    // asignado el apartamento alcanza también lo común del edificio y del
    // conjunto; al revés no.
    const sPadre = selector(opcionesInmueble(inm.id, '— no está dentro de nada —'), inm.padre || '');
    const filas = [
      campo('Tipo', sTipo),
      campo('Nombre', iNombre),
      campo('Dentro de (el conjunto o edificio que lo contiene)', sPadre),
      campo('Ciudad', iCiudad),
      campo('Estado', iEstado),
      campo('Zona', iZona),
    ];
    const acciones = [
      botonForm('Guardar', 'btn-primario', async (ev) => {
        const b = ev.currentTarget;
        if (!iNombre.value.trim()) { toast('Escribe el nombre del inmueble.', 'error'); return; }
        b.disabled = true;
        try {
          await adminGuardarInmueble({
            id: esNuevo ? undefined : inm.id,
            tipo: sTipo.value,
            nombre: iNombre.value.trim(),
            ciudad: iCiudad.value.trim(),
            estado: iEstado.value.trim(),
            zona: iZona.value.trim(),
            padre: sPadre.value,
          });
          toast(esNuevo ? 'Inmueble creado ✓' : 'Inmueble actualizado ✓', 'ok');
          await trasGuardar();
        } catch (err) {
          toast(err.message || 'No se pudo guardar.', 'error');
          b.disabled = false;
        }
      }),
      botonForm('Cancelar', 'btn-secundario', cerrarEditor),
    ];
    if (!esNuevo) {
      acciones.push(botonForm('Eliminar', 'btn-peligro', async (ev) => {
        if (!confirm(`¿Eliminar el inmueble "${inm.nombre}"? Se quitará de los vecinos que lo tengan asignado.`)) return;
        const b = ev.currentTarget;
        b.disabled = true;
        try {
          await adminEliminarInmueble({ id: inm.id });
          toast('Inmueble eliminado.', 'ok');
          await trasGuardar();
        } catch (err) {
          toast(err.message || 'No se pudo eliminar.', 'error');
          b.disabled = false;
        }
      }));
    }
    abrirEditor(esNuevo ? 'Nuevo inmueble' : `Editar: ${inm.nombre}`, filas, acciones);
  }

  function abrirEditorUsuario(existente) {
    const esNuevo = !existente;
    const u = existente || {};
    const iNombre = entrada(u.nombre);
    const iApellido = entrada(u.apellido);
    [iNombre, iApellido].forEach((i) => {
      i.setAttribute('autocapitalize', 'words'); // pista para el teclado móvil
      autoNombre(i); // y el Title Case de verdad, que también sirve en escritorio
    });
    const iEmail = entrada(u.email, 'correo@ejemplo.com', 'email');
    if (!esNuevo) iEmail.disabled = true;
    const iPass = entrada('', esNuevo ? 'Mínimo 6 caracteres' : 'Dejar vacío para no cambiarla', 'password');
    const sRol = selector([['vecino', 'Vecino'], ['admin', 'Administrador']], u.rol || 'vecino');
    const cActivo = casilla('Cuenta activa', u.activo !== false);
    const casillas = casillasDispositivos(u.dispositivos);
    const casInm = casillasInmuebles(u.inmuebles);
    // El campo de alcance solo lo ve el dueño (admin global): un admin de
    // edificio no puede repartir alcance, y el backend también lo rechaza.
    const casAlcance = casillasAlcance(u.administra);
    const campoAlcance = campo('Administra (vacío = todo el condominio)', casAlcance.cont);
    const soyDueno = !miAlcance().length;
    const actualizarAlcance = () => {
      campoAlcance.classList.toggle('oculto', !soyDueno || sRol.value !== 'admin');
    };

    const filas = [
      campo('Nombre', iNombre),
      campo('Apellido', iApellido),
      campo('Correo electrónico', iEmail),
      campo(esNuevo ? 'Contraseña' : 'Nueva contraseña (opcional)', iPass),
      campo('Rol', sRol),
    ];
    if (!esNuevo) filas.push(cActivo.label);
    filas.push(campoAlcance);
    filas.push(campo('Inmuebles', casInm.cont));
    // El acceso normal lo da el inmueble; esta lista son EXTRAS encima. Va
    // replegada para que el camino habitual sea elegir el apartamento y nada
    // más — verla abierta invitaba a seguir asignando a mano, que es justo el
    // trabajo que la herencia vino a quitar.
    const yaTieneExtras = (u.dispositivos || []).length > 0;
    const desplExtras = campoDesplegable(
      `Dispositivos extra${yaTieneExtras ? ` (${u.dispositivos.length})` : ''}`,
      casillas.cont,
      yaTieneExtras,
      'Además de los que ya hereda de su inmueble. Normalmente no hace falta ninguno.',
    );
    casillas.cont.addEventListener('change', () => {
      const n = casillas.seleccionados().length;
      desplExtras.etiquetar(`Dispositivos extra${n ? ` (${n})` : ''}`);
    });
    filas.push(desplExtras.caja);

    sRol.addEventListener('change', actualizarAlcance);
    actualizarAlcance();

    const accionesUsuario = [
      botonForm('Guardar', 'btn-primario', async (ev) => {
        const b = ev.currentTarget;
        b.disabled = true;
        try {
          if (esNuevo) {
            await adminCrearUsuario({
              nombre: iNombre.value.trim(),
              apellido: iApellido.value.trim(),
              email: iEmail.value.trim(),
              password: iPass.value,
              rol: sRol.value,
              dispositivos: casillas.seleccionados(),
              inmuebles: casInm.seleccionados(),
            });
            toast('Vecino creado ✓ Ya puede entrar con su correo y contraseña.', 'ok');
          } else {
            await adminActualizarUsuario({
              uid: u.uid,
              nombre: iNombre.value.trim(),
              apellido: iApellido.value.trim(),
              rol: sRol.value,
              ...(soyDueno ? { administra: sRol.value === 'admin' ? casAlcance.seleccionados() : [] } : {}),
              activo: cActivo.c.checked,
              dispositivos: casillas.seleccionados(),
              inmuebles: casInm.seleccionados(),
              password: iPass.value || undefined,
            });
            toast('Vecino actualizado ✓', 'ok');
          }
          await trasGuardar();
        } catch (err) {
          toast(err.message || 'No se pudo guardar.', 'error');
          b.disabled = false;
        }
      }),
      botonForm('Cancelar', 'btn-secundario', cerrarEditor),
    ];
    // Eliminar solo en vecinos ya creados, y nunca sobre uno mismo: el admin se
    // quedaría fuera de su propio panel.
    if (!esNuevo && u.uid !== (auth.currentUser && auth.currentUser.uid)) {
      accionesUsuario.push(botonForm('Eliminar', 'btn-peligro', async (ev) => {
        if (!confirm(`¿Eliminar a ${nombreCompleto(u)}? Se borra su cuenta y se revocan los pases que haya enviado. No se puede deshacer.`)) return;
        const b = ev.currentTarget;
        b.disabled = true;
        try {
          const res = await adminEliminarUsuario({ uid: u.uid });
          const n = (res.data && res.data.pasesRevocados) || 0;
          toast(n ? `Vecino eliminado. Se revocaron ${n} pase(s).` : 'Vecino eliminado.', 'ok');
          await trasGuardar();
        } catch (err) {
          toast(err.message || 'No se pudo eliminar.', 'error');
          b.disabled = false;
        }
      }));
    }
    abrirEditor(esNuevo ? 'Nuevo vecino' : `Editar: ${nombreCompleto(u)}`, filas, accionesUsuario);
  }

  $('btn-nuevo-dispositivo').addEventListener('click', () => abrirEditorDispositivo(null));
  $('btn-refrescar-conexion').addEventListener('click', (ev) => refrescarConexion(ev.currentTarget));
  $('btn-nuevo-inmueble').addEventListener('click', () => abrirEditorInmueble(null));
  $('btn-nuevo-usuario').addEventListener('click', () => abrirEditorUsuario(null));

  const PANELES_TAB = ['tab-controles', 'tab-pases', 'tab-gestion', 'tab-registro', 'tab-perfil'];
  const TABS_ADMIN = ['tab-gestion', 'tab-registro'];
  // La pestaña activa se refleja en la URL (#pases, #perfil…) para que el
  // refresh la mantenga y el botón "atrás" del navegador funcione. Controles =
  // sin hash. Un tab de admin cae a Controles si el usuario no es admin.
  function tabValida(id) {
    if (!PANELES_TAB.includes(id)) return 'tab-controles';
    if (TABS_ADMIN.includes(id) && !(usuarioActual && usuarioActual.rol === 'admin')) return 'tab-controles';
    return id;
  }
  function tabDesdeHash() {
    return tabValida('tab-' + (location.hash.replace(/^#/, '') || 'controles'));
  }
  function mostrarTab(id) {
    id = tabValida(id);
    PANELES_TAB.forEach((t) => $(t).classList.toggle('oculto', t !== id));
    document.querySelectorAll('.item-menu').forEach((p) => {
      p.classList.toggle('activa', p.dataset.tab === id);
    });
    // Reflejar en la URL (solo si cambió, para no duplicar el historial).
    const objHash = id === 'tab-controles' ? '' : '#' + id.replace('tab-', '');
    if (location.hash !== objHash) {
      history.pushState(null, '', objHash || location.pathname + location.search);
    }
  }
  // Entrar a una pestaña + su setup (dispositivos / perfil). Lo usan la
  // navegación, el arranque y el botón "atrás" (popstate).
  function entrarTab(id) {
    id = tabValida(id);
    if (id === 'tab-perfil') { abrirPerfil(); return; }
    mostrarTab(id);
    if (id === 'tab-pases') prepararGeneradorPases();
  }
  window.addEventListener('popstate', () => entrarTab(tabDesdeHash()));

  // Al girar el teléfono puede cambiar si un grupo cabe en fila o necesita
  // carrusel. Solo se repinta si cambió el ANCHO: en iOS abrir el teclado
  // dispara resize por el alto, y eso no debe reiniciar los carruseles.
  let anchoPrevio = window.innerWidth;
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (window.innerWidth === anchoPrevio) return;
    anchoPrevio = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (misDispositivos && misDispositivos.length) renderDispositivos(misDispositivos);
    }, 200);
  });

  const abrirMenu = () => {
    $('menu-lateral').classList.add('abierto');
    $('backdrop').classList.remove('oculto');
  };
  const cerrarMenu = () => {
    $('menu-lateral').classList.remove('abierto');
    $('backdrop').classList.add('oculto');
  };
  $('btn-menu').addEventListener('click', abrirMenu);
  $('backdrop').addEventListener('click', cerrarMenu);
  document.querySelectorAll('.item-menu').forEach((p) => {
    p.addEventListener('click', () => {
      entrarTab(p.dataset.tab);
      cerrarMenu();
    });
  });

  // Clic en el logo "ViYi" -> volver a Controles desde cualquier vista.
  const irInicio = () => { entrarTab('tab-controles'); cerrarMenu(); };
  $('ir-inicio').addEventListener('click', irInicio);
  $('ir-inicio').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); irInicio(); }
  });

  // ---- Mi perfil (clic en el nombre arriba a la derecha) ----
  // Los inmuebles los asigna el ADMIN (Gestión → Vecinos); aquí son solo lectura.
  function renderInmueblesPerfil(lista) {
    const ul = $('lista-inmuebles');
    ul.textContent = '';
    const items = Array.isArray(lista) ? lista : [];
    $('titulo-inmuebles').textContent = items.length === 1 ? 'Inmueble' : 'Inmuebles';
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'vacio';
      li.textContent = 'Sin inmuebles asignados.';
      ul.appendChild(li);
      return;
    }
    for (const inm of items) {
      const li = document.createElement('li');
      li.className = 'inmueble-ro';
      li.innerHTML = `<span class="pase-meta">${TIPO_INMUEBLE_TXT[inm.tipo] || inm.tipo}</span>`
        + `<strong>${escapar(inm.nombre)}</strong>`;
      ul.appendChild(li);
    }
  }

  async function abrirPerfil() {
    if (!usuarioActual) return;
    $('perfil-nombre').value = usuarioActual.nombre || '';
    $('perfil-apellido').value = usuarioActual.apellido || '';
    $('perfil-email').value = (auth.currentUser && auth.currentUser.email) || usuarioActual.email || '';
    $('perfil-msg').classList.add('oculto');
    $('clave-msg').classList.add('oculto');
    $('form-clave').reset();
    $('form-clave').classList.add('oculto');
    $('btn-toggle-clave').setAttribute('aria-expanded', 'false');
    // "Cambiar clave" solo si la cuenta tiene clave (no si entró con Google).
    const proveedores = (auth.currentUser && auth.currentUser.providerData) || [];
    const tieneClave = proveedores.some((p) => p && p.providerId === 'password');
    $('seccion-clave').classList.toggle('oculto', !tieneClave);
    mostrarTab('tab-perfil');
    cerrarMenu();
    // Inmuebles: solo lectura (los asigna el admin en Gestión). La sección solo
    // aparece si hay al menos uno y no es invitado (a los invitados no se asigna).
    const esInvitado = usuarioActual.invitado === true;
    const inmuebles = Array.isArray(usuarioActual.inmuebles) ? usuarioActual.inmuebles : [];
    const mostrarInmuebles = !esInvitado && inmuebles.length > 0;
    $('seccion-inmuebles').classList.toggle('oculto', !mostrarInmuebles);
    if (mostrarInmuebles) renderInmueblesPerfil(inmuebles);
    renderVestuario(); // el vestuario se arma con los dispositivos que ve hoy
  }
  $('info-usuario').addEventListener('click', abrirPerfil);
  $('info-usuario').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrirPerfil(); }
  });

  // Desplegar/ocultar el cambio de clave (menos clutter por defecto).
  $('btn-toggle-clave').addEventListener('click', () => {
    const form = $('form-clave');
    const mostrar = form.classList.contains('oculto');
    form.classList.toggle('oculto', !mostrar);
    $('btn-toggle-clave').setAttribute('aria-expanded', String(mostrar));
    $('clave-msg').classList.add('oculto');
    if (mostrar) $('clave-actual').focus();
    else form.reset();
  });

  $('form-perfil').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('perfil-msg');
    msg.classList.add('oculto');
    const nombre = $('perfil-nombre').value.trim();
    const apellido = $('perfil-apellido').value.trim();
    if (!nombre) {
      msg.textContent = 'El nombre no puede quedar vacío.';
      msg.classList.remove('oculto');
      return;
    }
    const btn = $('btn-guardar-perfil');
    btn.disabled = true;
    try {
      await actualizarMiPerfil({ nombre, apellido });
      usuarioActual.nombre = nombre;
      usuarioActual.apellido = apellido;
      $('nombre-usuario').textContent = nombreCompleto(usuarioActual);
      toast('Perfil actualizado.');
    } catch (err) {
      msg.textContent = (err && err.message) || 'No se pudo guardar el perfil.';
      msg.classList.remove('oculto');
    } finally {
      btn.disabled = false;
    }
  });

  $('form-clave').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('clave-msg');
    msg.classList.add('oculto');
    const actual = $('clave-actual').value;
    const nueva = $('clave-nueva').value;
    const nueva2 = $('clave-nueva2').value;
    if (nueva.length < 6) {
      msg.textContent = 'La clave nueva debe tener al menos 6 caracteres.';
      msg.classList.remove('oculto');
      return;
    }
    if (nueva !== nueva2) {
      msg.textContent = 'Las claves nuevas no coinciden.';
      msg.classList.remove('oculto');
      return;
    }
    const btn = $('btn-cambiar-clave');
    btn.disabled = true;
    try {
      const cred = EmailAuthProvider.credential(auth.currentUser.email, actual);
      await reauthenticateWithCredential(auth.currentUser, cred);
      await updatePassword(auth.currentUser, nueva);
      $('form-clave').reset();
      $('form-clave').classList.add('oculto');
      $('btn-toggle-clave').setAttribute('aria-expanded', 'false');
      toast('Clave actualizada.');
    } catch (err) {
      const code = err && err.code;
      let m = 'No se pudo cambiar la clave.';
      if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') m = 'La clave actual no es correcta.';
      else if (code === 'auth/weak-password') m = 'La clave nueva es muy débil.';
      else if (code === 'auth/too-many-requests') m = 'Demasiados intentos. Espera un momento.';
      else if (code === 'auth/requires-recent-login') m = 'Vuelve a iniciar sesión e inténtalo de nuevo.';
      msg.textContent = m;
      msg.classList.remove('oculto');
    } finally {
      btn.disabled = false;
    }
  });

  // ---- Pases: generar / listar / revocar ----
  const escapar = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Duración del pase: una sola rueda horizontal con scroll (3h · 6h · 24h ·
  // 7d · Indefinido). Se ve un valor faded a cada lado y el del centro es el
  // elegido. Los tokens coinciden con DURACIONES_MS del backend.
  const DUR_RUEDA = [
    ['3h', '3 h'], ['6h', '6 h'], ['24h', '24 h'], ['7d', '7 d'], ['indef', 'Indefinido'],
  ];
  let paseDuracionSel = '6h'; // por defecto la rueda en 6 h
  const elRueda = $('dur-rueda');
  const opsRueda = Array.from(elRueda.querySelectorAll('.dur-op'));
  let ruedaCentrando = false;
  let ruedaCentTmr = null;
  let ruedaTmr = null;

  function idxCentradoRueda() {
    const cr = elRueda.getBoundingClientRect();
    const centro = cr.left + cr.width / 2;
    let best = 0;
    let bestD = Infinity;
    opsRueda.forEach((op, i) => {
      const r = op.getBoundingClientRect();
      const d = Math.abs(r.left + r.width / 2 - centro);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }
  function pintarCentroRueda() {
    const i = idxCentradoRueda();
    opsRueda.forEach((op, k) => op.classList.toggle('centro', k === i));
    return i;
  }
  function centrarRueda(idx, suave) {
    const op = opsRueda[idx];
    if (!op) return;
    const cr = elRueda.getBoundingClientRect();
    const or = op.getBoundingClientRect();
    const delta = (or.left + or.width / 2) - (cr.left + cr.width / 2);
    if (Math.abs(delta) < 1) { pintarCentroRueda(); return; }
    ruedaCentrando = true; // no cambiar la selección durante el scroll programático
    clearTimeout(ruedaCentTmr);
    ruedaCentTmr = setTimeout(() => { ruedaCentrando = false; }, suave ? 500 : 180);
    elRueda.scrollTo({ left: elRueda.scrollLeft + delta, behavior: suave ? 'smooth' : 'auto' });
  }
  // Re-centrar en el valor actual cuando el panel se hace visible (oculto mide
  // 0 y el centrado falla). Lo llama prepararGeneradorPases al abrir Pases.
  function recentrarRueda() {
    let i = DUR_RUEDA.findIndex(([t]) => t === paseDuracionSel);
    if (i < 0) i = DUR_RUEDA.findIndex(([t]) => t === '6h');
    centrarRueda(i, false);
  }
  elRueda.addEventListener('scroll', () => {
    pintarCentroRueda();
    if (ruedaCentrando) return;
    clearTimeout(ruedaTmr);
    ruedaTmr = setTimeout(() => {
      paseDuracionSel = DUR_RUEDA[idxCentradoRueda()][0];
    }, 100);
  });
  opsRueda.forEach((op, i) => op.addEventListener('click', () => {
    centrarRueda(i, true);
    paseDuracionSel = DUR_RUEDA[i][0];
  }));

  // ---- Vestuario: el vecino elige el aspecto de CADA botón ----
  // La elección vive en su cuenta (usuarios/{uid}.aspectos[dispositivoId]), así
  // lo sigue a cualquier teléfono, y solo la ve él: no toca lo que ven los demás.
  // El aspecto que puso el admin en el dispositivo queda como el de fábrica.

  // Icono con el que se previsualiza un dispositivo (el mismo del botón real).
  function iconoDe(d) {
    const sub = ICONO_SUBTIPO[d.subtipo];
    if (sub) return ICONOS[sub];
    if (d.tipo === 'ascensor') return ICONOS.ascensor;
    if (d.tipo === 'luz') return ICONOS.luz;
    return ICONOS.candados;
  }

  // Muestra (mini botón) de un aspecto para ese dispositivo.
  function muestraAspecto(a, d) {
    // La foto del knob solo se muestra donde el control ES una perilla; en el
    // dimmer (slider horizontal) prometería algo que no va a aparecer.
    if (a.imgMuestra) {
      return d.modo === 'dimmer'
        ? { clase: 'muestra-cobre', html: '' }
        : { clase: '', html: `<img src="${a.imgMuestra}" alt="">` };
    }
    if (a.id === 'argentina') return { clase: '', html: '<img src="argentina-frente.jpg?v=2" alt="">' };
    if (ASPECTOS_IMAGEN[a.id]) {
      // La miniatura lleva la MISMA clase del aspecto para que muestre su
      // estado en reposo. Sin esto, el ascensor se previsualizaba con el aro
      // ámbar encendido y el botón de verdad aparecía apagado: la miniatura
      // prometía algo distinto de lo que ibas a ver.
      return { clase: ASPECTOS_IMAGEN[a.id].clase || '', html: `<img src="${ASPECTOS_IMAGEN[a.id].img}" alt="">` };
    }
    if (a.id === 'jet') return { clase: 'muestra-jet', html: '' };
    if (a.id === 'sabiem') return { clase: 'muestra-sabiem', html: '' };
    if (a.id === 'mando') return { clase: 'muestra-mando', html: '' };
    // Normal y las pieles: el icono del propio dispositivo, con la piel puesta.
    return { clase: a.piel ? `piel-${a.id}` : '', html: iconoDe(d) };
  }

  // Dispositivos que tienen algo que elegir. Las cortinas, dimmers y termostatos
  // son perillas/sliders y todavía no tienen aspectos, así que quedan fuera.
  const dispConAspectos = () => (misDispositivos || []).filter((d) => aspectosDe(d).length > 1);

  let vestDisp = null;      // dispositivo que se está vistiendo
  let vestAspecto = null;   // opción centrada en el carrusel
  let vestTimer = null;
  let vestTocado = false;   // ¿el último scroll del carrusel lo hizo el dedo?

  // Pinta el demo: el control REAL del dispositivo con el aspecto elegido, pero
  // en modo demo (se toca y se anima, sin mandarle nada al portón).
  function pintarDemoVestuario() {
    const cont = $('vest-demo');
    cont.textContent = '';
    if (!vestDisp) return;
    // El dimmer se arma con su propio constructor (va a lo ancho, fuera del
    // carrusel); el resto pasa por tarjetaDispositivo.
    let ctrl;
    if (vestDisp.modo === 'dimmer' && vestAspecto !== 'rueda') {
      ctrl = controlDimmer(vestDisp, true);
      aplicarPiel(ctrl, vestAspecto);
    } else {
      ctrl = tarjetaDispositivo(vestDisp, true, vestAspecto);
    }
    cont.appendChild(ctrl);
  }

  // Carrusel de opciones: la que queda centrada es la elegida.
  function pintarOpcionesVestuario() {
    const cont = $('vest-opciones');
    cont.textContent = '';
    if (!vestDisp) return;
    const ops = aspectosDe(vestDisp);
    for (const a of ops) {
      const m = muestraAspecto(a, vestDisp);
      const op = document.createElement('button');
      op.type = 'button';
      op.className = 'skin-op';
      op.dataset.aspecto = a.id;
      op.innerHTML = `<span class="skin-muestra ${m.clase}">${m.html}</span>`
        + `<span class="skin-nom">${escapar(a.nombre)}</span>`;
      cont.appendChild(op);
    }
    activarCarrusel(cont); // coverflow + marca la centrada con .enfoque
    // Este scroll es NUESTRO, no del dedo: que no se tome por una elección.
    // Y se cancela cualquier decisión a medio cocer del carrusel anterior.
    clearTimeout(vestTimer);
    vestTocado = false;
    centrarElegida(cont, ops);
    // Si el panel todavía no estaba visible al pintar, clientWidth es 0 y el
    // centro sale mal. Se repite en el siguiente frame, ya con layout de verdad.
    requestAnimationFrame(() => { vestTocado = false; centrarElegida(cont, ops); });
  }

  // Deja centrada la opción que ya está elegida, sin animación (estado inicial).
  function centrarElegida(cont, ops) {
    if (!cont.clientWidth) return;
    const i = Math.max(0, ops.findIndex((a) => a.id === vestAspecto));
    const el = cont.children[i];
    if (!el) return;
    // Por rectángulos y NO por offsetLeft: .vest-opciones no es
    // position:relative, así que offsetLeft se mide contra un ancestro y el
    // scroll salía enorme → el navegador lo recortaba al máximo y centraba la
    // ÚLTIMA opción. No se notaba porque Jet Switch ERA la última; al entrar
    // los skins de galería dejó de serlo y quedó marcando el skin equivocado.
    const rc = cont.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    cont.scrollLeft += (r.left + r.width / 2) - (rc.left + rc.width / 2);
  }

  function renderVestuario() {
    const lista = dispConAspectos();
    const sel = $('vest-disp');
    const nota = $('vest-nota');
    const sinAspectos = (misDispositivos || []).length - lista.length;
    // Nota de los que no tienen estilos todavía (perillas y sliders).
    nota.classList.toggle('oculto', !sinAspectos);
    if (sinAspectos) {
      nota.textContent = sinAspectos === 1
        ? 'Tu otro dispositivo (perilla o slider) todavía no tiene estilos.'
        : `Tus otros ${sinAspectos} dispositivos (perillas y sliders) todavía no tienen estilos.`;
    }
    sel.classList.toggle('oculto', lista.length < 2); // con uno solo, no hay qué elegir
    if (!lista.length) {
      sel.classList.add('oculto');
      $('vest-demo').textContent = '';
      $('vest-opciones').textContent = '';
      vestDisp = null;
      nota.classList.remove('oculto');
      nota.textContent = 'Tus dispositivos todavía no tienen estilos para elegir.';
      return;
    }
    // Mantener el dispositivo elegido si sigue existiendo; si no, el primero.
    if (!vestDisp || !lista.some((d) => d.id === vestDisp.id)) vestDisp = lista[0];
    else vestDisp = lista.find((d) => d.id === vestDisp.id);
    sel.textContent = '';
    for (const d of lista) {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = d.nombre;
      o.selected = d.id === vestDisp.id;
      sel.appendChild(o);
    }
    vestAspecto = aspectoDe(vestDisp);
    pintarDemoVestuario();
    pintarOpcionesVestuario();
  }

  // Aplica la opción elegida: repinta el demo y la guarda. Lo llaman tanto el
  // toque como el scroll del carrusel.
  function seleccionarAspecto(asp) {
    if (!vestDisp || !asp || asp === vestAspecto) return;
    vestAspecto = asp;
    pintarDemoVestuario();
    guardarAspecto(vestDisp.id, asp);
  }

  // Al centrar otra opción deslizando el carrusel.
  // `paraId` = el dispositivo que estaba puesto cuando el carrusel se asentó.
  // Si mientras se esperaban los 140 ms cambiaste de dispositivo, esta decisión
  // ya no es de nadie: escribirla le pondría al NUEVO el aspecto del anterior
  // (así el búnker acabó con el skin de una luz).
  function alCentrarOpcion(paraId) {
    if (!vestDisp || (paraId && vestDisp.id !== paraId)) return;
    const foco = $('vest-opciones').querySelector('.skin-op.enfoque');
    if (foco) seleccionarAspecto(foco.dataset.aspecto);
  }

  async function guardarAspecto(dispId, aspectoId) {
    if (!usuarioActual) return;
    const mapa = Object.assign({}, usuarioActual.aspectos || {});
    // Se guarda incluso 'normal': es una elección explícita que debe poder
    // ganarle al aspecto que puso el admin, no un "sin preferencia".
    mapa[dispId] = aspectoId;
    usuarioActual.aspectos = mapa;
    renderDispositivos(misDispositivos); // los controles de verdad se repintan
    guardarCache(); // que el refresh pinte el elegido, no el de la caché vieja
    try {
      const res = await actualizarMiPerfil({ aspectos: mapa });
      // El backend descarta en silencio los aspectos que no conoce, así que se
      // compara con lo que devolvió: si no quedó, el refresh lo perdería y hay
      // que decirlo aquí, no dejar que se vea como si se hubiera guardado.
      const guardado = res && res.data && res.data.perfil && res.data.perfil.aspectos;
      if (guardado && guardado[dispId] !== aspectoId) {
        const motivo = ((res.data.descartados || []).join(', ') || 'motivo desconocido');
        toast(`El servidor no guardó el estilo (${motivo}).`, 'error');
      }
    } catch (err) {
      toast('No se pudo guardar el estilo.', 'error');
    }
  }

  $('vest-disp').addEventListener('change', (e) => {
    const d = dispConAspectos().find((x) => x.id === e.target.value);
    if (!d) return;
    vestDisp = d;
    vestAspecto = aspectoDe(d);
    pintarDemoVestuario();
    pintarOpcionesVestuario();
  });
  // El carrusel elige al asentarse el scroll (no en cada píxel).
  // Solo el scroll que viene del dedo elige. Sin esto, el scrollLeft que pone
  // pintarOpcionesVestuario para centrar la opción actual disparaba este mismo
  // listener y GUARDABA en Firestore el aspecto que quedara enfocado — que al
  // refrescar, con el panel aún oculto y clientWidth 0, era el equivocado. Un
  // repintado nunca debe escribir nada.
  $('vest-opciones').addEventListener('pointerdown', () => { vestTocado = true; }, { passive: true });
  $('vest-opciones').addEventListener('wheel', () => { vestTocado = true; }, { passive: true });
  $('vest-opciones').addEventListener('scroll', () => {
    if (!vestTocado) return;
    clearTimeout(vestTimer);
    const paraId = vestDisp && vestDisp.id;
    vestTimer = setTimeout(() => alCentrarOpcion(paraId), 140);
  }, { passive: true });
  // Tocar una opción la elige de una vez (y de paso la centra). Antes se
  // esperaba a que el scroll la centrara, pero si el carrusel no llegaba a
  // moverse ese evento nunca llegaba y el toque no hacía nada.
  $('vest-opciones').addEventListener('click', (e) => {
    const b = e.target.closest('.skin-op');
    if (!b) return;
    b.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    seleccionarAspecto(b.dataset.aspecto);
  });

  // ---- Crear un skin con IA (solo admin) ----
  // La imagen la procesa el NAVEGADOR, no la función: recortar y comprimir en
  // el servidor obligaría a meter sharp (dependencia nativa pesada) y a que la
  // función arrastre ese arranque en frío por algo que se usa muy de vez en
  // cuando. Aquí es un canvas y ya.
  const adminSkins = httpsCallable(functions, 'adminSkins');
  // La imagen sin publicar vive en `recImg` + el estado del recorte; el WebP se
  // genera al publicar, para no rehacerlo en cada frame del gesto.

  // A qué tipos puede aplicar un skin: solo donde el control ES un botón
  // redondo. Cortinas, dimmers y termostatos son perillas, ruedas o sliders y
  // una foto no los viste, así que no se ofrecen.
  const TIPOS_SKIN = [
    { id: 'puerta', nombre: 'Puertas' },
    { id: 'ascensor', nombre: 'Ascensores' },
    { id: 'luz', nombre: 'Luces' },
    { id: 'rele', nombre: 'Relés' },
    { id: 'otro', nombre: 'Otros' },
  ];

  // `elegidos` vacío significa "todos" (así se guarda), por eso arrancan todos
  // marcados. No se deja desmarcar el último: cero marcados no querría decir
  // "ninguno" sino "todos", y sería justo lo contrario de lo que parece.
  function pintarChipsTipos(cont, elegidos) {
    const marcados = Array.isArray(elegidos) && elegidos.length ? elegidos : TIPOS_SKIN.map((t) => t.id);
    cont.textContent = '';
    for (const t of TIPOS_SKIN) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip-tipo' + (marcados.includes(t.id) ? ' activa' : '');
      b.dataset.tipo = t.id;
      b.textContent = t.nombre;
      b.addEventListener('click', () => {
        b.classList.toggle('activa');
        if (!cont.querySelector('.chip-tipo.activa')) b.classList.add('activa');
      });
      cont.appendChild(b);
    }
  }

  // Si están todos marcados se manda [] = "todos", que es como lo guarda el
  // backend; así no hay dos formas de decir lo mismo.
  function tiposElegidos(cont) {
    const sel = [...cont.querySelectorAll('.chip-tipo.activa')].map((b) => b.dataset.tipo);
    return sel.length === TIPOS_SKIN.length ? [] : sel;
  }

  // El botón es un círculo con la foto a `cover`, así que basta un cuadrado:
  // el CSS hace el recorte. Se cuadra por el lado corto y se centra.
  // ---- Recorte ajustable de la previa ----
  // La previa ES el botón real, así que se recorta ahí mismo: arrastras y haces
  // pinza dentro del círculo que vas a publicar. El WebP definitivo se genera al
  // publicar, no en cada frame del gesto.
  const CAJA_PREVIA = 168;    // diámetro del botón .grande, en px
  let gestosRecorteListos = false;
  let recImg = null;          // la imagen fuente cargada
  let recBase = 1;            // px de pantalla por px de imagen, con el lado corto justo cubriendo
  let recEsc = 1, recDx = 0, recDy = 0;

  function cargarImagen(fuente) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('No se pudo leer la imagen.'));
      img.src = fuente;
    });
  }

  // Mantiene la foto cubriendo el círculo: sin huecos por los bordes.
  function acotarRecorte() {
    recEsc = Math.min(6, Math.max(1, recEsc));
    const margenX = (recImg.naturalWidth * recBase * recEsc - CAJA_PREVIA) / 2;
    const margenY = (recImg.naturalHeight * recBase * recEsc - CAJA_PREVIA) / 2;
    recDx = Math.max(-margenX, Math.min(margenX, recDx));
    recDy = Math.max(-margenY, Math.min(margenY, recDy));
  }

  function pintarRecorte() {
    const el = $('skin-previa-img');
    acotarRecorte();
    el.style.width = `${recImg.naturalWidth * recBase}px`;
    el.style.height = `${recImg.naturalHeight * recBase}px`;
    // El scale va a la derecha (se aplica primero), así el arrastre se mide en
    // píxeles de pantalla y el dedo mueve la foto 1:1 a cualquier zoom.
    el.style.transform = `translate(-50%, -50%) translate(${recDx}px, ${recDy}px) scale(${recEsc})`;
    $('skin-zoom').value = String(Math.min(4, recEsc));   // que la pinza mueva el deslizador
  }

  // El cuadrado de la imagen que está visible ahora mismo, a 256px.
  function recorteWebp(lado = 256) {
    const t = recBase * recEsc;                       // imagen -> pantalla
    const medio = (CAJA_PREVIA / 2) / t;              // medio lado, en px de imagen
    const cx = recImg.naturalWidth / 2 - recDx / t;
    const cy = recImg.naturalHeight / 2 - recDy / t;
    const c = document.createElement('canvas');
    c.width = lado; c.height = lado;
    c.getContext('2d').drawImage(recImg, cx - medio, cy - medio, medio * 2, medio * 2, 0, 0, lado, lado);
    return c.toDataURL('image/webp', 0.86);
  }

  // Gestos sobre el círculo: un dedo arrastra, dos hacen pinza. En escritorio,
  // la rueda del ratón hace zoom.
  function activarGestosRecorte() {
    // Deslizador de zoom: es la vía obvia y funciona con ratón y con dedo. La
    // pinza sigue estando, pero sin esto nada indicaba que se podía acercar.
    $('skin-zoom').addEventListener('input', (e) => {
      if (!recImg) return;
      recEsc = Number(e.target.value) || 1;
      pintarRecorte();
    });
    const zona = $('skin-previa-img').parentElement;
    const dedos = new Map();
    let pinza = 0;
    zona.addEventListener('pointerdown', (e) => {
      if (!recImg) return;
      dedos.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (dedos.size === 2) {
        const [a, b] = [...dedos.values()];
        pinza = Math.hypot(a.x - b.x, a.y - b.y);
      }
      if (zona.setPointerCapture) zona.setPointerCapture(e.pointerId);
    });
    zona.addEventListener('pointermove', (e) => {
      if (!recImg || !dedos.has(e.pointerId)) return;
      const prev = dedos.get(e.pointerId);
      dedos.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (dedos.size === 1) {
        recDx += e.clientX - prev.x;
        recDy += e.clientY - prev.y;
      } else if (dedos.size === 2 && pinza) {
        const [a, b] = [...dedos.values()];
        const ahora = Math.hypot(a.x - b.x, a.y - b.y);
        recEsc *= ahora / pinza;
        pinza = ahora;
      }
      pintarRecorte();
    });
    const soltar = (e) => { dedos.delete(e.pointerId); pinza = 0; };
    zona.addEventListener('pointerup', soltar);
    zona.addEventListener('pointercancel', soltar);
    zona.addEventListener('wheel', (e) => {
      if (!recImg) return;
      e.preventDefault();
      recEsc *= e.deltaY < 0 ? 1.08 : 1 / 1.08;
      pintarRecorte();
    }, { passive: false });
  }

  function msgSkin(texto, error) {
    const el = $('skin-msg');
    el.textContent = texto || '';
    el.classList.toggle('oculto', !texto);
    el.classList.toggle('mensaje-error', !!error);
    el.classList.toggle('mensaje-ok', !error && !!texto);
  }

  // Deja una imagen (venga de la IA o del carrete) lista para publicar: la
  // cuadra, la muestra en la previa y propone un nombre. Es el único sitio que
  // monta el recorte, así que las dos vías se comportan igual.
  async function usarImagen(fuente, nombreSugerido) {
    recImg = await cargarImagen(fuente);
    // El lado corto cubre justo el círculo: es el zoom mínimo sin huecos.
    recBase = CAJA_PREVIA / Math.min(recImg.naturalWidth, recImg.naturalHeight);
    recEsc = 1; recDx = 0; recDy = 0;
    $('skin-previa-img').src = recImg.src;
    $('skin-previa').classList.remove('oculto');
    pintarRecorte();
    if (!$('skin-nombre').value.trim() && nombreSugerido) {
      $('skin-nombre').value = tituloCase(nombreSugerido).slice(0, 24);
    }
  }

  // Subir una foto del carrete. El navegador hace todo el trabajo: la foto de
  // 12 MP no sale del teléfono, solo el WebP de 256px (~12 KB).
  $('skin-archivo').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    msgSkin('');
    const url = URL.createObjectURL(f);
    try {
      // El nombre del archivo sin extensión sirve de nombre propuesto.
      await usarImagen(url, f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '));
    } catch (err) {
      // Las fotos del iPhone son HEIC; Safari suele convertirlas al subirlas,
      // pero si llega el HEIC crudo ningún navegador lo decodifica. Se avisa en
      // vez de fallar en silencio.
      const heic = /\.hei[cf]$/i.test(f.name);
      msgSkin(heic
        ? 'Esa foto está en HEIC y el navegador no la puede abrir. Ábrela en Fotos, compártela como JPG y súbela.'
        : 'No se pudo leer esa imagen. Prueba con otra.', true);
    } finally {
      URL.revokeObjectURL(url);
      e.target.value = '';   // que se pueda volver a elegir la misma foto
    }
  });

  $('btn-toggle-skin').addEventListener('click', () => {
    const form = $('form-skin');
    const mostrar = form.classList.contains('oculto');
    form.classList.toggle('oculto', !mostrar);
    $('btn-toggle-skin').setAttribute('aria-expanded', String(mostrar));
    if (mostrar) {
      pintarChipsTipos($('skin-tipos'), null);
      pintarListaSkins();
      if (!gestosRecorteListos) { activarGestosRecorte(); gestosRecorteListos = true; }
    }
  });

  $('btn-generar-skin').addEventListener('click', async () => {
    const prompt = $('skin-prompt').value.trim();
    if (prompt.length < 3) { msgSkin('Describe el botón.', true); return; }
    const btn = $('btn-generar-skin');
    btn.disabled = true;
    btn.textContent = 'Generando…';
    msgSkin('');
    try {
      const r = await adminSkins({ accion: 'generar', prompt });
      const d = r.data || {};
      await usarImagen(`data:${d.mimeType};base64,${d.data}`,
        prompt.split(/[\s,.]+/).slice(0, 2).join(' '));
    } catch (err) {
      msgSkin((err && err.message) || 'No se pudo generar.', true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Generar';
    }
  });

  $('btn-publicar-skin').addEventListener('click', async () => {
    if (!recImg) return;
    const nombre = $('skin-nombre').value.trim();
    if (!nombre) { msgSkin('Ponle un nombre.', true); return; }
    // El id sale del nombre; si ya existe se le añade un sufijo para no pisar
    // un skin que algún vecino ya pueda tener puesto.
    const base = nombre.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 34) || 'skin';
    let id = base;
    for (let i = 2; skinsGaleria.some((s) => s.id === id); i++) id = `${base}-${i}`;
    const btn = $('btn-publicar-skin');
    btn.disabled = true;
    try {
      await adminSkins({
        accion: 'publicar',
        id,
        nombre,
        imagen: recorteWebp(),
        animacion: $('skin-animacion').value,
        tipos: tiposElegidos($('skin-tipos')),
        prompt: $('skin-prompt').value.trim(),
      });
      recImg = null;
      $('skin-previa').classList.add('oculto');
      $('skin-prompt').value = '';
      $('skin-nombre').value = '';
      pintarChipsTipos($('skin-tipos'), null);
      msgSkin('Publicado. Ya se puede elegir en el Locker.');
      // Repintar va en su PROPIO try: en este punto ya está guardado, y si
      // fallara el repintado decir "no se pudo publicar" sería mentira y te
      // haría gastar otra generación repitiéndolo.
      try { await refrescarSkins(); } catch (e) { /* se verá al recargar */ }
    } catch (err) {
      msgSkin((err && err.message) || 'No se pudo publicar.', true);
    } finally {
      btn.disabled = false;
    }
  });

  // Vuelve a leer la galería y repinta todo lo que la usa.
  async function refrescarSkins() {
    aplicarSkinsGaleria(await cargarSkins());
    guardarCache();
    if (misDispositivos && misDispositivos.length) renderDispositivos(misDispositivos);
    renderVestuario();
    pintarListaSkins();
  }

  // Cada skin de la lista se puede editar: cambiar el nombre, la animación o a
  // qué tipos aplica SIN volver a generar la imagen (equivocarse de nombre no
  // debe costar otra generación).
  function pintarListaSkins() {
    const cont = $('skin-lista');
    cont.textContent = '';
    if (!skinsGaleria.length) return;
    for (const s of skinsGaleria) {
      const caja = document.createElement('div');
      caja.className = 'skin-item';

      const fila = document.createElement('div');
      fila.className = 'skin-fila';
      fila.innerHTML = `<img src="${s.imagen}" alt=""><span>${escapar(s.nombre)}</span>`;

      const editor = document.createElement('div');
      editor.className = 'skin-editor oculto';
      editor.innerHTML = '<label class="campo-perfil">Nombre'
        + `<input type="text" class="ed-nombre" maxlength="24" value="${escapar(s.nombre)}"></label>`
        + '<label class="campo-perfil">Al activarse<select class="ed-animacion">'
        + Object.values(ANIMACIONES_SKIN).map((a) =>
          `<option value="${a.id}"${a.id === (s.animacion || 'ninguna') ? ' selected' : ''}>${a.nombre}</option>`).join('')
        + '</select></label>'
        + '<div class="campo-perfil">Para<div class="skin-tipos ed-tipos"></div></div>';
      pintarChipsTipos(editor.querySelector('.ed-tipos'), s.tipos);

      const acciones = document.createElement('div');
      acciones.className = 'skin-acciones';
      const guardar = document.createElement('button');
      guardar.type = 'button';
      guardar.className = 'btn-secundario';
      guardar.textContent = 'Guardar';
      guardar.addEventListener('click', async () => {
        const nombre = editor.querySelector('.ed-nombre').value.trim();
        if (!nombre) { msgSkin('Ponle un nombre.', true); return; }
        guardar.disabled = true;
        try {
          await adminSkins({
            accion: 'editar',
            id: s.id,
            nombre,
            animacion: editor.querySelector('.ed-animacion').value,
            tipos: tiposElegidos(editor.querySelector('.ed-tipos')),
          });
          await refrescarSkins();
          msgSkin('Guardado.');
        } catch (err) {
          msgSkin((err && err.message) || 'No se pudo guardar.', true);
          guardar.disabled = false;
        }
      });

      const borrar = document.createElement('button');
      borrar.type = 'button';
      borrar.className = 'btn-borrar-skin';
      borrar.textContent = 'Borrar';
      borrar.addEventListener('click', async () => {
        // Los vecinos que lo tuvieran puesto vuelven solos a su botón normal:
        // aspectoDe() valida contra el catálogo y descarta lo que ya no existe.
        if (!confirm(`¿Borrar "${s.nombre}" de la galería?`)) return;
        borrar.disabled = true;
        try {
          await adminSkins({ accion: 'eliminar', id: s.id });
          await refrescarSkins();
        } catch (err) {
          msgSkin((err && err.message) || 'No se pudo borrar.', true);
          borrar.disabled = false;
        }
      });
      acciones.append(guardar, borrar);
      editor.appendChild(acciones);

      fila.addEventListener('click', () => editor.classList.toggle('oculto'));
      caja.append(fila, editor);
      cont.appendChild(caja);
    }
  }

  // Buscar vecino: filtra sin volver a leer Firestore (ya está todo en caché).
  $('buscar-vecino').addEventListener('input', renderVecinos);

  $('btn-generar-pase').addEventListener('click', generarEnlacePase);
  // Al encender/apagar un dispositivo, refrescar el conteo de su grupo.
  $('pase-dispositivos').addEventListener('change', actualizarConteosGrupos);

  // ---- Tipo de enlace: Simple (default) / Multiuso, con ayuda desplegable ----
  let paseMultiuso = false;
  $('pase-tipo').addEventListener('click', (e) => {
    const b = e.target.closest('.chip-scope');
    if (!b) return;
    paseMultiuso = b.dataset.tipo === 'multiuso';
    document.querySelectorAll('#pase-tipo .chip-scope').forEach((c) => c.classList.toggle('activa', c === b));
  });
  function ocultarAyudaEnlace() {
    $('info-enlace').classList.add('oculto');
    $('btn-info-enlace').setAttribute('aria-expanded', 'false');
  }
  $('btn-info-enlace').addEventListener('click', () => {
    const oculto = $('info-enlace').classList.toggle('oculto');
    $('btn-info-enlace').setAttribute('aria-expanded', oculto ? 'false' : 'true');
  });
  $('pase-modo').addEventListener('click', (e) => {
    const b = e.target.closest('.chip-scope');
    if (!b) return;
    paseModo = b.dataset.modo;
    aplicarModoPase();
  });
  $('btn-refrescar-pases').addEventListener('click', cargarMisPases);
  // Toggle admin: ver solo mis pases o todos los del condominio.
  $('pase-scope').addEventListener('click', (e) => {
    const b = e.target.closest('.chip-scope');
    if (!b) return;
    paseVerTodos = b.dataset.scope === 'todos';
    document.querySelectorAll('#pase-scope .chip-scope').forEach((c) => c.classList.toggle('activa', c === b));
    $('titulo-mis-pases').textContent = paseVerTodos ? 'Todos los pases' : 'Mis pases';
    cargarMisPases();
  });
  // Evento en Title Case al salir del campo (no en cada tecla: reescribir el
  // value mientras se escribe rompe el teclado en móviles y cortaba el texto).
  // Nombres y apellidos en Title Case al salir del campo, en las tres pantallas
  // fijas. Los del editor de admin se enganchan al crearse.
  ['reg-nombre', 'reg-apellido', 'perfil-nombre', 'perfil-apellido'].forEach((id) => autoNombre($(id)));

  $('pase-evento').addEventListener('blur', () => {
    $('pase-evento').value = tituloCase($('pase-evento').value);
  });

  // Dispositivos propios que el usuario puede compartir (admin: todos).
  function dispositivosCompartibles() {
    if (!usuarioActual) return [];
    return usuarioActual.rol === 'admin'
      ? misDispositivos
      : misDispositivos.filter((d) => (usuarioActual.dispositivos || []).includes(d.id));
  }

  // Tarjeta "Tu acceso temporal": aparece si el usuario recibió un pase con
  // vencimiento (independiente de si además tiene dispositivos propios).
  function refrescarAccesoInvitado() {
    const card = $('pase-invitado');
    clearInterval(avisoTimer);
    avisoTimer = null;
    const conAcceso = misDispositivos
      .filter((d) => usuarioActual.accesos && usuarioActual.accesos[d.id]);
    if (!conAcceso.length) { card.classList.add('oculto'); card.textContent = ''; return; }
    card.classList.remove('oculto');
    card.textContent = '';
    const limiteIndef = Date.now() + 100 * 365 * 24 * 3600 * 1000; // >100 años = indefinido
    // Agrupar por pase (token) para mostrar el evento y quién invitó por grupo.
    const grupos = new Map();
    for (const d of conAcceso) {
      const acc = usuarioActual.accesos[d.id] || {};
      const clave = acc.token || '_';
      if (!grupos.has(clave)) grupos.set(clave, { evento: acc.evento || '', invitador: [acc.porNombre, acc.porApellido].filter(Boolean).join(' '), fechaMs: msExpira(acc.creado), disp: [] });
      grupos.get(clave).disp.push(d);
    }
    for (const g of grupos.values()) {
      const fecha = g.fechaMs ? new Date(g.fechaMs).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }) : '';
      let subtexto = '';
      if (g.invitador && fecha) subtexto = `Te invitó ${g.invitador} · ${fecha}`;
      else if (g.invitador) subtexto = `Te invitó ${g.invitador}`;
      else if (fecha) subtexto = `Invitado el ${fecha}`;
      if (g.evento || subtexto) {
        const cab = document.createElement('div');
        cab.className = 'acceso-cab';
        if (g.evento) {
          const ev = document.createElement('strong');
          ev.textContent = g.evento;
          cab.appendChild(ev);
        }
        if (subtexto) {
          const inv = document.createElement('span');
          inv.className = 'acceso-invitador';
          inv.textContent = subtexto;
          cab.appendChild(inv);
        }
        card.appendChild(cab);
      }
      for (const d of g.disp) {
        const ms = msExpira(usuarioActual.accesos[d.id] && usuarioActual.accesos[d.id].expira);
        const fila = document.createElement('div');
        fila.className = 'acceso-fila';
        const nombre = document.createElement('span');
        nombre.className = 'acceso-nombre';
        nombre.textContent = d.nombre;
        const reloj = document.createElement('span');
        reloj.className = 'acceso-reloj';
        reloj.dataset.expira = (ms && ms < limiteIndef) ? String(ms) : '0';
        reloj.innerHTML = `${ICONO_RELOJ}<span class="acceso-tiempo"></span>`;
        pintarRelojAcceso(reloj);
        fila.append(nombre, reloj);
        card.appendChild(fila);
      }
    }
    avisoTimer = setInterval(() => {
      const relojes = card.querySelectorAll('.acceso-reloj');
      if (!relojes.length) { clearInterval(avisoTimer); avisoTimer = null; return; }
      relojes.forEach(pintarRelojAcceso);
    }, 30000);
  }

  // Prepara la vista Pases: tarjeta de acceso (si recibió un pase) y el
  // generador + "Mis pases" (solo si tiene dispositivos propios para compartir).
  function prepararGeneradorPases() {
    refrescarAccesoInvitado();
    const compartibles = dispositivosCompartibles();
    const puedeCompartir = compartibles.length > 0;
    $('pase-generador').classList.toggle('oculto', !puedeCompartir);
    $('pase-mis').classList.toggle('oculto', !puedeCompartir);
    if (!puedeCompartir) return;
    cargarMisInvitados(); // sin await: el generador no espera por la lista
    aplicarModoPase();
    const cont = $('pase-dispositivos');
    cont.textContent = '';
    // Dispositivos agrupados por tipo en desplegables (<details>), colapsados
    // por defecto; el conteo verde en la cabecera muestra cuántos hay elegidos
    // dentro de un grupo cerrado.
    const filaCasilla = (id, nombre) => {
      const lab = document.createElement('label');
      lab.className = 'pase-casilla';
      lab.innerHTML = `<input type="checkbox" value="${escapar(id)}"><span class="pase-tgl" aria-hidden="true"></span><span class="pase-nom">${escapar(nombre)}</span>`;
      return lab;
    };
    let primerGrupo = true;
    for (const t of TIPOS) {
      const delTipo = compartibles.filter((d) => (d.tipo || 'otro') === t.clave);
      if (!delTipo.length) continue;
      const grupo = document.createElement('details');
      grupo.className = 'pase-grupo';
      if (primerGrupo) { grupo.open = true; primerGrupo = false; } // el primero (Puertas) abierto
      grupo.innerHTML = '<summary class="pase-grupo-cab">'
        + '<svg class="pase-grupo-flecha" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>'
        + `<span class="pase-grupo-tit">${escapar(t.titulo)}</span>`
        + '<span class="pase-grupo-conteo" hidden></span></summary>';
      const cuerpo = document.createElement('div');
      cuerpo.className = 'pase-grupo-cuerpo';
      for (const d of delTipo) cuerpo.appendChild(filaCasilla(d.id, d.nombre));
      grupo.appendChild(cuerpo);
      cont.appendChild(grupo);
    }
    actualizarConteosGrupos();
    $('pase-evento').value = '';
    // El tipo de enlace vuelve a Simple (lo más común) cada vez que se abre.
    paseMultiuso = false;
    document.querySelectorAll('#pase-tipo .chip-scope').forEach((c) =>
      c.classList.toggle('activa', c.dataset.tipo === 'simple'));
    ocultarAyudaEnlace();
    $('pase-resultado').classList.add('oculto');
    cargarMisPases();
    // La rueda de duración necesita centrarse ya con el panel visible (oculto
    // mide 0). En el frame siguiente ya hay layout.
    requestAnimationFrame(recentrarRueda);
  }

  // Pinta en la cabecera de cada grupo (desplegable por tipo) cuántos
  // dispositivos hay elegidos dentro; se oculta si es 0. Así un grupo colapsado
  // avisa si tiene selecciones adentro.
  function actualizarConteosGrupos() {
    document.querySelectorAll('#pase-dispositivos .pase-grupo').forEach((g) => {
      const n = g.querySelectorAll('input:checked').length;
      const badge = g.querySelector('.pase-grupo-conteo');
      if (badge) { badge.textContent = n; badge.hidden = n === 0; }
    });
  }

  let paseModo = 'enlace';

  // Mis invitados frecuentes: quienes ya canjearon algún pase mío, del que más
  // veces al que menos. Si no hay ninguno, ni se ofrece la pestaña — no tiene
  // sentido mostrarle una lista vacía a quien todavía no ha compartido nada.
  async function cargarMisInvitados() {
    const cont = $('pase-invitados-lista');
    try {
      const res = await misInvitados();
      const lista = (res.data && res.data.invitados) || [];
      $('pase-modo').classList.toggle('oculto', !lista.length);
      cont.textContent = '';
      for (const inv of lista) {
        const nombre = [inv.nombre, inv.apellido].filter(Boolean).join(' ') || inv.email;
        const lab = document.createElement('label');
        lab.className = 'pase-casilla';
        lab.innerHTML = `<input type="checkbox" value="${escapar(inv.uid)}">`
          + `<span class="pase-tgl" aria-hidden="true"></span>`
          + `<span class="pase-nom">${escapar(nombre)}</span>`;
        cont.appendChild(lab);
      }
    } catch (err) {
      $('pase-modo').classList.add('oculto');
    }
  }

  // Los dos modos comparten dispositivos, evento y duración; solo cambia a
  // quién va. "Multiuso" se esconde en frecuentes porque solo aplica a enlaces.
  function aplicarModoPase() {
    const frec = paseModo === 'frecuentes';
    $('pase-invitados-lista').classList.toggle('oculto', !frec);
    $('btn-generar-pase').textContent = frec ? 'Invitar' : 'Generar';
    document.querySelector('.pase-multi').classList.toggle('oculto', frec);
    if (frec) ocultarAyudaEnlace(); // su ayuda tampoco aplica en frecuentes
    document.querySelectorAll('#pase-modo .chip-scope').forEach((c) =>
      c.classList.toggle('activa', (c.dataset.modo === 'frecuentes') === frec));
    if (frec) $('pase-resultado').classList.add('oculto');
  }

  async function darAccesoDirecto() {
    const seleccion = [...document.querySelectorAll('#pase-dispositivos input:checked')].map((i) => i.value);
    if (!seleccion.length) { toast('Elige al menos un dispositivo.', 'error'); return; }
    const aQuienes = [...document.querySelectorAll('#pase-invitados-lista input:checked')].map((i) => i.value);
    if (!aQuienes.length) { toast('Elige al menos un invitado.', 'error'); return; }
    const boton = $('btn-generar-pase');
    boton.disabled = true;
    boton.textContent = 'Invitando…';
    try {
      const evento = tituloCase($('pase-evento').value.trim());
      const res = await darAcceso({
        uids: aQuienes, dispositivos: seleccion, duracion: paseDuracionSel, evento,
      });
      const d = (res.data && res.data.dados) || 0;
      const a = (res.data && res.data.avisados) || 0;
      toast(d === a
        ? `Invitaste a ${d}. Les llegó el correo.`
        : `Invitaste a ${d}. Se avisó a ${a} por correo.`, 'ok');
      document.querySelectorAll('#pase-invitados-lista input:checked').forEach((i) => { i.checked = false; });
      cargarMisPases();
    } catch (err) {
      toast((err && err.message) || 'No se pudo dar el acceso.', 'error');
    } finally {
      boton.disabled = false;
      boton.textContent = 'Invitar';
    }
  }

  async function generarEnlacePase() {
    if (paseModo === 'frecuentes') return darAccesoDirecto();
    const seleccion = [...document.querySelectorAll('#pase-dispositivos input:checked')].map((i) => i.value);
    if (!seleccion.length) { toast('Elige al menos un dispositivo.', 'error'); return; }
    const boton = $('btn-generar-pase');
    boton.disabled = true;
    boton.textContent = 'Generando…';
    try {
      const multiuso = paseMultiuso;
      const evento = tituloCase($('pase-evento').value.trim());
      const res = await crearPase({ dispositivos: seleccion, duracion: paseDuracionSel, multiuso, evento });
      const url = `${location.origin}${location.pathname}?p=${res.data.token}`;
      mostrarResultadoPase(url);
      cargarMisPases();
    } catch (err) {
      toast((err && err.message) || 'No se pudo generar el enlace.', 'error');
    } finally {
      boton.disabled = false;
      boton.textContent = 'Generar';
    }
  }

  function copiarTexto(texto) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(texto).then(() => true).catch(() => false);
    }
    return Promise.resolve(false);
  }

  // Mensaje que se comparte con el invitado (no solo la URL pelada).
  const mensajePase = (url) => `Usa ViYi para abrir la puerta, esta es tu llave ${url}`;

  function mostrarResultadoPase(url) {
    const cont = $('pase-resultado');
    cont.classList.remove('oculto');
    cont.innerHTML = '';
    const titulo = document.createElement('p');
    titulo.className = 'pase-ok';
    titulo.textContent = '¡Enlace listo! ¡Compártelo!';
    const campo = document.createElement('input');
    campo.type = 'text';
    campo.readOnly = true;
    campo.value = mensajePase(url);
    campo.className = 'pase-url';
    campo.addEventListener('focus', () => campo.select());
    const acciones = document.createElement('div');
    acciones.className = 'pase-acciones';
    const bCopiar = document.createElement('button');
    bCopiar.type = 'button';
    bCopiar.className = 'btn-secundario';
    bCopiar.textContent = 'Copiar';
    bCopiar.addEventListener('click', async () => {
      const ok = await copiarTexto(mensajePase(url));
      if (ok) toast('Copiado');
      else { campo.select(); toast('Selecciona y copia el mensaje.'); }
    });
    acciones.appendChild(bCopiar);
    if (navigator.share) {
      const bShare = document.createElement('button');
      bShare.type = 'button';
      bShare.className = 'btn-secundario';
      bShare.textContent = 'Compartir';
      bShare.addEventListener('click', () => {
        navigator.share({ title: 'ViYi', text: mensajePase(url) }).catch(() => {});
      });
      acciones.appendChild(bShare);
    }
    cont.appendChild(titulo);
    cont.appendChild(campo);
    cont.appendChild(acciones);
  }

  let paseVerTodos = false; // admin: ver todos los pases del condominio vs solo los míos
  async function cargarMisPases() {
    const lista = $('lista-pases');
    if (!usuarioActual || !auth.currentUser) return;
    const todos = paseVerTodos && usuarioActual.rol === 'admin';
    lista.textContent = '';
    try {
      const consulta = todos
        ? query(collection(db, 'pases'))
        : query(collection(db, 'pases'), where('por', '==', auth.currentUser.uid));
      const res = await getDocs(consulta);
      if (res.empty) {
        const li = document.createElement('li');
        li.className = 'vacio';
        li.textContent = todos ? 'No hay pases todavía.' : 'Aún no has generado pases.';
        lista.appendChild(li);
        return;
      }
      const nombrePorId = Object.fromEntries(misDispositivos.map((d) => [d.id, d.nombre]));
      const items = res.docs.map((d) => ({ token: d.id, ...d.data() }))
        .sort((a, b) => msExpira(b.creado) - msExpira(a.creado));
      for (const p of items) lista.appendChild(filaPase(p, nombrePorId, todos));
    } catch (err) {
      const li = document.createElement('li');
      li.textContent = 'No se pudieron cargar los pases.';
      lista.appendChild(li);
    }
  }

  function filaPase(p, nombrePorId, mostrarEmisor) {
    const li = document.createElement('li');
    li.className = 'fila-pase';
    const nombres = (p.dispositivos || []).map((id) => nombrePorId[id] || id).join(', ');
    const emisor = [p.porNombre, p.porApellido].filter(Boolean).join(' ');
    let estado = 'activo';
    const venc = msExpira(p.expira);
    if (p.revocado) estado = 'revocado';
    else if (!p.multiuso && p.usado) estado = 'usado';
    else if (venc && venc <= Date.now()) estado = 'vencido';

    // Quiénes canjearon el pase (nombre + hora en pases.invitados[]).
    const inv = Array.isArray(p.invitados) ? p.invitados : [];
    let invitadoTxt;
    if (p.multiuso) {
      // Multiuso: en vez de "Para X", el conteo de canjes (+ botón Detalle).
      const n = p.usos || inv.length;
      invitadoTxt = `Multiuso · ${n} canje${n === 1 ? '' : 's'}`;
    } else {
      const nombresInv = inv.map((x) => x && x.nombre).filter(Boolean);
      if (nombresInv.length) {
        invitadoTxt = 'Para ' + nombresInv.slice(0, 3).join(', ');
        if (nombresInv.length > 3) invitadoTxt += ` +${nombresInv.length - 3}`;
      } else if (p.usos > 0) {
        invitadoTxt = 'Canjeado'; // pase viejo, sin nombre registrado
      } else {
        invitadoTxt = 'Sin canjear aún';
      }
    }

    // Cuándo se emitió y cuándo vence/venció (Vence en verde, Venció en rojo).
    const esIndef = p.duracion === 'indef';
    const vencido = !esIndef && venc && venc <= Date.now();
    const vencLabel = esIndef
      ? '<span class="vence-ok">sin vencimiento</span>'
      : `<span class="${vencido ? 'vence-mal' : 'vence-ok'}">${vencido ? 'Venció' : 'Vence'}</span>`;
    const fechasHtml = esIndef
      ? `Emitido ${fmtFecha(p.creado)} · ${vencLabel}`
      : `Emitido ${fmtFecha(p.creado)} · ${vencLabel} ${fmtFecha(p.expira)}`;

    const info = document.createElement('div');
    info.className = 'pase-info';
    const eventoHtml = p.evento ? `<span class="pase-evento-lbl">${escapar(p.evento)}</span>` : '';
    const emisorHtml = (mostrarEmisor && emisor) ? `<span class="pase-meta">de ${escapar(emisor)}</span>` : '';
    info.innerHTML = `<strong>${escapar(nombres)}</strong>`
      + emisorHtml
      + eventoHtml
      + `<span class="pase-meta">${escapar(invitadoTxt)}</span>`
      + `<span class="pase-meta">${fechasHtml}</span>`;

    // Detalle de canjes (solo multiuso con canjes): quién y a qué hora.
    let detalle = null;
    let btnDetalle = null;
    if (p.multiuso && inv.length) {
      detalle = document.createElement('div');
      detalle.className = 'pase-detalle oculto';
      for (const x of inv) {
        const item = document.createElement('div');
        item.className = 'pase-detalle-item';
        item.innerHTML = `<span>${escapar(nombreCompleto(x) || x.email || 'Invitado')}</span>`
          + `<span class="pase-meta">${fmtFecha(x.cuando)}</span>`;
        detalle.appendChild(item);
      }
      btnDetalle = document.createElement('button');
      btnDetalle.type = 'button';
      btnDetalle.className = 'btn-mini';
      btnDetalle.textContent = 'Detalle';
      btnDetalle.addEventListener('click', () => {
        const oculto = detalle.classList.toggle('oculto');
        btnDetalle.textContent = oculto ? 'Detalle' : 'Ocultar';
      });
    }

    const acciones = document.createElement('div');
    acciones.className = 'pase-fila-acciones';
    const badge = document.createElement('span');
    badge.className = 'pase-estado estado-' + estado;
    badge.textContent = estado;
    acciones.appendChild(badge);
    if (btnDetalle) acciones.appendChild(btnDetalle);

    // Copiar: solo mientras el enlace sigue vivo y compartible.
    if (estado === 'activo') {
      const url = `${location.origin}${location.pathname}?p=${p.token}`;
      const bCopiar = document.createElement('button');
      bCopiar.type = 'button';
      bCopiar.className = 'btn-mini';
      bCopiar.textContent = 'Copiar';
      bCopiar.addEventListener('click', async () => {
        const ok = await copiarTexto(mensajePase(url));
        toast(ok ? 'Copiado' : 'No se pudo copiar.', ok ? undefined : 'error');
      });
      acciones.appendChild(bCopiar);
    }
    // Revocar: mientras el pase todavía pueda estar dando acceso (no revocado ni
    // vencido), aunque sea de un solo uso ya canjeado — ese es justo el caso en
    // que hay que poder cortarlo. revocarPase borra el acceso de quien lo canjeó.
    if (!p.revocado && !vencido) {
      const bRev = document.createElement('button');
      bRev.type = 'button';
      bRev.className = 'btn-mini btn-mini-peligro';
      bRev.textContent = 'Revocar';
      bRev.addEventListener('click', async () => {
        if (!confirm('¿Revocar este pase? Quien lo haya canjeado perderá el acceso.')) return;
        bRev.disabled = true;
        try {
          await revocarPase({ token: p.token });
          toast('Pase revocado.');
          cargarMisPases();
        } catch (err) {
          toast((err && err.message) || 'No se pudo revocar.', 'error');
          bRev.disabled = false;
        }
      });
      acciones.appendChild(bRev);
    }

    li.appendChild(info);
    li.appendChild(acciones);
    if (detalle) li.appendChild(detalle);
    return li;
  }

  async function cargarRegistros() {
    const lista = $('lista-registros');
    lista.textContent = '';
    try {
      // El admin de un edificio pide solo el historial de su torre (la regla se
      // evalúa por documento, así que tiene que venir filtrado). El dueño pide
      // todo, como siempre.
      const alc = miAlcance();
      const resultado = alc.length
        ? await getDocs(query(collection(db, 'registros'),
            where('inmueble', 'in', alc.slice(0, 30)), orderBy('fecha', 'desc'), limit(30)))
        : await getDocs(query(collection(db, 'registros'), orderBy('fecha', 'desc'), limit(30)));
      if (resultado.empty) {
        const item = document.createElement('li');
        item.textContent = 'Sin actividad todavía.';
        lista.appendChild(item);
        return;
      }
      // Quién fue vive en `privado/quien` y solo el dueño puede leerlo. Se
      // piden en paralelo; el admin de edificio ni lo intenta y verá la
      // actividad sin identificar a nadie, que es justo la intención.
      const quienes = new Map();
      if (!miAlcance().length) {
        const lecturas = await Promise.all(resultado.docs.map((d) =>
          getDoc(doc(db, 'registros', d.id, 'privado', 'quien')).catch(() => null)));
        lecturas.forEach((snap, i) => {
          if (snap && snap.exists()) quienes.set(resultado.docs[i].id, snap.data());
        });
      }
      for (const registro of resultado.docs) {
        const r = registro.data();
        // Los registros de antes de partir el documento traen el nombre dentro.
        const quien = quienes.get(registro.id) || { usuarioNombre: r.usuarioNombre, unidad: r.unidad };
        const item = document.createElement('li');
        item.className = r.exito ? 'registro-ok' : 'registro-error';
        const fecha = r.fecha && r.fecha.toDate
          ? r.fecha.toDate().toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })
          : '—';
        const motivo = !r.exito && r.detalle ? ` — ${r.detalle}` : '';
        const quienTxt = quien.usuarioNombre
          ? `${quien.usuarioNombre}${quien.unidad ? ` (${quien.unidad})` : ''} · ` : '';
        item.textContent = `${fecha} · ${quienTxt}${r.dispositivoNombre} · ${r.accion} ${r.exito ? '✓' : '✗'}${motivo}`;
        lista.appendChild(item);
      }
    } catch (err) {
      const item = document.createElement('li');
      item.textContent = 'No se pudo cargar el registro.';
      lista.appendChild(item);
    }
  }

  $('btn-refrescar').addEventListener('click', cargarRegistros);
}
