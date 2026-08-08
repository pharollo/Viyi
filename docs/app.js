// El ?v= va aquí y no en index.html porque este archivo se importa como módulo.
// Sin él se queda pegado en el caché del CDN (4 h) aunque app.js sí se renueve:
// pasó al cambiar el authDomain a auth.viyi.ai. Súbelo junto con el de
// index.html cada vez que cambie firebase-config.js.
import { firebaseConfig, FUNCTIONS_REGION, NOMBRE_CONDOMINIO } from './firebase-config.js?v=289';

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
  const adminCrearInmuebleLote = httpsCallable(functions, 'adminCrearInmuebleLote');
  const adminCrearVecinosLote = httpsCallable(functions, 'adminCrearVecinosLote');
  const adminInvitarVecinos = httpsCallable(functions, 'adminInvitarVecinos');
  const adminEliminarUsuario = httpsCallable(functions, 'adminEliminarUsuario');
  const adminInspeccionarDispositivo = httpsCallable(functions, 'adminInspeccionarDispositivo');
  const adminListarAccesoriosHomebridge = httpsCallable(functions, 'adminListarAccesoriosHomebridge');
  const adminListarDispositivosTuya = httpsCallable(functions, 'adminListarDispositivosTuya');
  const adminListarDispositivosShelly = httpsCallable(functions, 'adminListarDispositivosShelly');
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


  // Ciudades de Venezuela con su estado. Sirven para dos cosas: sugerir la
  // ciudad mientras se escribe y rellenar el estado solo, que es un dato que
  // no cambia y no tiene sentido teclear en cada inmueble.
  const CIUDADES_VE = {
    'Puerto Ayacucho': 'Amazonas',
    'Barcelona': 'Anzoátegui', 'Puerto La Cruz': 'Anzoátegui', 'Lechería': 'Anzoátegui',
    'El Tigre': 'Anzoátegui', 'Anaco': 'Anzoátegui', 'Cantaura': 'Anzoátegui', 'Guanta': 'Anzoátegui',
    'San Fernando de Apure': 'Apure', 'Guasdualito': 'Apure', 'Achaguas': 'Apure', 'Biruaca': 'Apure',
    'Maracay': 'Aragua', 'Turmero': 'Aragua', 'La Victoria': 'Aragua', 'Cagua': 'Aragua',
    'Villa de Cura': 'Aragua', 'Palo Negro': 'Aragua', 'El Limón': 'Aragua', 'San Mateo': 'Aragua',
    'Colonia Tovar': 'Aragua', 'Ocumare de la Costa': 'Aragua', 'Choroní': 'Aragua',
    'Barinas': 'Barinas', 'Socopó': 'Barinas', 'Sabaneta': 'Barinas', 'Santa Bárbara de Barinas': 'Barinas',
    'Ciudad Bolívar': 'Bolívar', 'Ciudad Guayana': 'Bolívar', 'Puerto Ordaz': 'Bolívar',
    'San Félix': 'Bolívar', 'Upata': 'Bolívar', 'El Callao': 'Bolívar', 'Tumeremo': 'Bolívar',
    'Caicara del Orinoco': 'Bolívar', 'Santa Elena de Uairén': 'Bolívar',
    'Valencia': 'Carabobo', 'Naguanagua': 'Carabobo', 'San Diego': 'Carabobo', 'Guacara': 'Carabobo',
    'Puerto Cabello': 'Carabobo', 'Los Guayos': 'Carabobo', 'Tocuyito': 'Carabobo',
    'Morón': 'Carabobo', 'Bejuma': 'Carabobo', 'Güigüe': 'Carabobo',
    'San Carlos': 'Cojedes', 'Tinaquillo': 'Cojedes', 'El Baúl': 'Cojedes',
    'Tucupita': 'Delta Amacuro',
    'Caracas': 'Distrito Capital',
    'Coro': 'Falcón', 'Punto Fijo': 'Falcón', 'Punta Cardón': 'Falcón', 'Tucacas': 'Falcón',
    'Chichiriviche': 'Falcón', 'Dabajuro': 'Falcón', 'Puerto Cumarebo': 'Falcón',
    'San Juan de los Morros': 'Guárico', 'Calabozo': 'Guárico', 'Valle de la Pascua': 'Guárico',
    'Zaraza': 'Guárico', 'Altagracia de Orituco': 'Guárico',
    'Barquisimeto': 'Lara', 'Cabudare': 'Lara', 'Carora': 'Lara', 'El Tocuyo': 'Lara',
    'Quíbor': 'Lara', 'Duaca': 'Lara', 'Sanare': 'Lara',
    'Mérida': 'Mérida', 'El Vigía': 'Mérida', 'Ejido': 'Mérida', 'Tovar': 'Mérida',
    'Santa Cruz de Mora': 'Mérida', 'Timotes': 'Mérida',
    'Los Teques': 'Miranda', 'Guarenas': 'Miranda', 'Guatire': 'Miranda', 'Charallave': 'Miranda',
    'Cúa': 'Miranda', 'Ocumare del Tuy': 'Miranda', 'Santa Teresa del Tuy': 'Miranda',
    'San Antonio de los Altos': 'Miranda', 'Carrizal': 'Miranda', 'Higuerote': 'Miranda',
    'Río Chico': 'Miranda', 'Caucagua': 'Miranda', 'Baruta': 'Miranda', 'Chacao': 'Miranda',
    'El Hatillo': 'Miranda', 'Petare': 'Miranda', 'Los Salias': 'Miranda',
    'Maturín': 'Monagas', 'Punta de Mata': 'Monagas', 'Caripito': 'Monagas',
    'Caripe': 'Monagas', 'Temblador': 'Monagas',
    'Porlamar': 'Nueva Esparta', 'La Asunción': 'Nueva Esparta', 'Pampatar': 'Nueva Esparta',
    'Juan Griego': 'Nueva Esparta', 'Punta de Piedras': 'Nueva Esparta',
    'Guanare': 'Portuguesa', 'Acarigua': 'Portuguesa', 'Araure': 'Portuguesa',
    'Villa Bruzual': 'Portuguesa', 'Turén': 'Portuguesa',
    'Cumaná': 'Sucre', 'Carúpano': 'Sucre', 'Güiria': 'Sucre', 'Cariaco': 'Sucre',
    'San Cristóbal': 'Táchira', 'Táriba': 'Táchira', 'San Antonio del Táchira': 'Táchira',
    'Rubio': 'Táchira', 'La Fría': 'Táchira', 'Ureña': 'Táchira', 'San Juan de Colón': 'Táchira',
    'Trujillo': 'Trujillo', 'Valera': 'Trujillo', 'Boconó': 'Trujillo',
    'Carvajal': 'Trujillo', 'La Puerta': 'Trujillo',
    'La Guaira': 'La Guaira', 'Catia La Mar': 'La Guaira', 'Maiquetía': 'La Guaira',
    'Macuto': 'La Guaira', 'Naiguatá': 'La Guaira', 'Caraballeda': 'La Guaira',
    'San Felipe': 'Yaracuy', 'Yaritagua': 'Yaracuy', 'Chivacoa': 'Yaracuy',
    'Nirgua': 'Yaracuy', 'Cocorote': 'Yaracuy',
    'Maracaibo': 'Zulia', 'San Francisco': 'Zulia', 'Cabimas': 'Zulia', 'Ciudad Ojeda': 'Zulia',
    'Santa Bárbara del Zulia': 'Zulia', 'Machiques': 'Zulia', 'La Concepción': 'Zulia',
    'Mene Grande': 'Zulia', 'Villa del Rosario': 'Zulia', 'Los Puertos de Altagracia': 'Zulia',
  };

  const ESTADOS_VE = [...new Set(Object.values(CIUDADES_VE))].sort((a, b) => a.localeCompare(b));

  // Sin tildes ni mayúsculas: quien escribe "merida" en el teléfono espera que
  // se lo reconozca igual.
  const sinTildes = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const ESTADO_POR_CIUDAD = new Map(Object.entries(CIUDADES_VE).map(([c, e]) => [sinTildes(c), e]));

  // Un <datalist> por lista, creado una vez y reutilizado por todos los
  // formularios que lo pidan.
  function listaSugerencias(id, valores) {
    let dl = document.getElementById(id);
    if (dl) return id;
    dl = document.createElement('datalist');
    dl.id = id;
    for (const v of valores) {
      const o = document.createElement('option');
      o.value = v;
      dl.appendChild(o);
    }
    document.body.appendChild(dl);
    return id;
  }

  // Mismo tope que el servidor (MAX_LOTE en functions/index.js): se avisa en
  // la vista previa en vez de dejar que falle al guardar.
  const MAX_LOTE = 600;

  const TIPO_INMUEBLE_TXT = {
    conjunto: 'Conjunto Residencial',
    residencias: 'Residencias',
    edificio: 'Edificio',
    oficinas: 'Edificio de Oficinas',
    apartamento: 'Apartamento',
    oficina: 'Oficina',
    quinta: 'Quinta',
    casa: 'Casa',
    local: 'Local Comercial',
    galpon: 'Galpón',
    restaurant: 'Restaurant',
  };

  // Qué contiene cada tipo cuando se crea en lote: el tipo elegido decide el
  // resto del formulario. Lo que no está aquí (una casa, un galpón) se crea
  // solo, sin pisos ni unidades.
  const UNIDAD_DE = {
    conjunto: 'apartamento',
    residencias: 'apartamento',
    edificio: 'apartamento',
    oficinas: 'oficina',
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
    latidoFuerte: { id: 'latidoFuerte', nombre: 'Late fuerte', clase: 'skin-late-fuerte' },
    balanceo: { id: 'balanceo', nombre: 'Se balancea', clase: 'skin-balancea' },
    rebote: { id: 'rebote', nombre: 'Rebota', clase: 'skin-rebota' },
    vibracion: { id: 'vibracion', nombre: 'Vibra', clase: 'skin-vibra' },
    destello: { id: 'destello', nombre: 'Destella', clase: 'skin-destella' },
    barrido: { id: 'barrido', nombre: 'Reluce', clase: 'skin-barre' },
    onda: { id: 'onda', nombre: 'Irradia', clase: 'skin-irradia' },
    orbita: { id: 'orbita', nombre: 'Orbita', clase: 'skin-orbita' },
    volteo: { id: 'volteo', nombre: 'Voltea', clase: 'skin-voltea' },
    titileo: { id: 'titileo', nombre: 'Titila', clase: 'skin-titila' },
    compuerta: { id: 'compuerta', nombre: 'Se abre', clase: 'skin-compuerta' },
    radar: { id: 'radar', nombre: 'Rastrea', clase: 'skin-rastrea' },
    chispa: { id: 'chispa', nombre: 'Chispea', clase: 'skin-chispea' },
    acercamiento: { id: 'acercamiento', nombre: 'Se acerca', clase: 'skin-acerca' },
    holo: { id: 'holo', nombre: 'Holo', clase: 'skin-holo' },
    capa: { id: 'capa', nombre: 'Se envuelve', clase: 'skin-envuelve' },
    color: { id: 'color', nombre: 'Colorea', clase: 'skin-colorea' },
  };
  let skinsGaleria = [];   // [{ id, nombre, imagen, animacion, tipos, autor, publico }]
  // La animación que tenía un skin antes de empezar a probarle otras, para
  // reponerla si cancelas. `null` = no hay nada que deshacer.
  let animacionOriginal = null;

  // Mete los skins de la galería en las dos tablas que el resto del código ya
  // sabe leer, para que no haya un camino aparte para ellos.
  function aplicarSkinsGaleria(lista) {
    // Se rehace el catálogo desde el servidor, así que ya no hay nada que
    // deshacer: lo que queda escrito ES la verdad.
    //
    // Sin esto, guardar un cambio de animación no se aplicaba al botón. El
    // guardado recarga la galería y repinta; ese repintado cierra el editor, y
    // al cerrarse reponía la animación de ANTES de empezar a probar — pisando
    // lo que se acababa de grabar. Se veía bien en la muestra (repintada
    // durante la prueba) y mal en el botón de verdad, hasta recargar la página.
    animacionOriginal = null;
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
  // Donde el control ES un botón redondo: pulso (puertas, ascensores) e
  // interruptor (luces, relés). Va AQUÍ, con las otras y antes del catálogo:
  // `const` no se iza, así que usarla desde `CATALOGO_ASPECTOS` estando
  // declarada más abajo revienta la app entera al arrancar — y `node --check`
  // no lo ve, porque de sintaxis está bien.
  const MODOS_SKIN = ['pulso', 'interruptor'];
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
    // Pilder: la palanca sirve donde hay un estado que enseñar, así que va en
    // interruptores (se queda arriba mientras está encendido) y en puertas
    // (sube al abrir y baja al cerrarse). Es el primer control propio que
    // tienen los interruptores: hasta ahora eran todos el botón redondo.
    { id: 'pilder', nombre: 'Pilder', modos: MODOS_SKIN },
  ];
  const PIELES = CATALOGO_ASPECTOS.filter((a) => a.piel).map((a) => a.id);

  // Catálogo completo = los de código + los de la galería. Un skin de galería
  // es un botón redondo con foto, así que sirve donde el control ES un botón:
  // pulso (puertas, ascensores) e interruptor (luces, relés). `tipos` vacío =
  // sirve para cualquier tipo de dispositivo.
  // `creado` viaja de tres maneras: Timestamp de Firestore recién traído, el
  // {seconds, nanoseconds} en que se convierte al pasar por localStorage, o
  // nada (los aspectos de fábrica). Sin aplanarlo, comparar fechas ordena por
  // casualidad.
  function milisegundosDe(creado) {
    if (!creado) return 0;
    if (typeof creado.toMillis === 'function') return creado.toMillis();
    if (typeof creado.seconds === 'number') return creado.seconds * 1000;
    const t = Date.parse(creado);
    return Number.isNaN(t) ? 0 : t;
  }

  function catalogoAspectos() {
    return CATALOGO_ASPECTOS.concat(skinsGaleria.map((s) => ({
      id: s.id,
      nombre: s.nombre,
      modos: MODOS_SKIN,
      tipos: Array.isArray(s.tipos) && s.tipos.length ? s.tipos : null,
      // Para ordenar la galería: cuándo llegó y cuánta gente se lo ha puesto.
      // Los de fábrica no tienen ninguno de los dos —nacieron con la app y no
      // están en la colección—, y por eso nunca entran en "Los últimos".
      creado: milisegundosDe(s.creado),
      usos: Number(s.usos) || 0,
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

  // El título del evento de un pase, si este dispositivo le llegó al invitado
  // por uno. Es la identidad que le puso quien invitó, y viste el botón mientras
  // el pase viva; al vencer, el dispositivo ya desaparece solo del panel
  // (renderDispositivos filtra por vigencia), y con él su vestido.
  //
  // No para lo propio: un dispositivo que es tuyo de forma permanente no es "de
  // un evento" aunque además tengas un pase suyo.
  // Milisegundos de un Timestamp de Firestore, venga recién traído o de la
  // caché de localStorage (donde se convierte en {seconds, nanoseconds}).
  function msDeCampo(t) {
    if (!t) return 0;
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    const n = Date.parse(t);
    return Number.isNaN(n) ? 0 : n;
  }

  // Cuándo empieza un acceso que todavía no vale, o 0 si ya está vigente.
  //
  // Un pase se puede programar: se canjea en cuanto llega —el invitado se
  // registra tranquilo— pero no abre nada hasta su hora. El botón tiene que
  // decir CUÁNDO; si no, es un botón que no funciona y nadie sabe por qué, que
  // es la forma más rápida de que te llamen por teléfono.
  function empiezaEn(d) {
    if (!usuarioActual || (usuarioActual.dispositivos || []).includes(d.id)) return 0;
    const acc = (usuarioActual.accesos || {})[d.id];
    const ms = msDeCampo(acc && acc.desde);
    return ms > Date.now() ? ms : 0;
  }

  function cuandoEmpiezaTexto(ms) {
    const f = new Date(ms);
    const hoy = new Date().toDateString() === f.toDateString();
    const hora = f.toLocaleTimeString('es', { hour: 'numeric', minute: '2-digit' });
    if (hoy) return `Disponible a las ${hora}`;
    return `Disponible el ${f.toLocaleDateString('es', { day: 'numeric', month: 'short' })} a las ${hora}`;
  }

  function eventoDe(d) {
    if (!usuarioActual || !usuarioActual.accesos) return '';
    if ((usuarioActual.dispositivos || []).includes(d.id)) return '';
    const acc = usuarioActual.accesos[d.id];
    return acc && typeof acc.evento === 'string' ? acc.evento.trim() : '';
  }

  // Un color estable a partir del título: el mismo evento cae siempre en el
  // mismo color, y dos eventos distintos casi nunca coinciden. Sin imagen y sin
  // costo — el título ya trae su identidad. 68/62 lee bien sobre la superficie
  // oscura sin gritar.
  function colorDeEvento(titulo) {
    let h = 0;
    for (let i = 0; i < titulo.length; i++) h = (h * 31 + titulo.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360} 68% 62%)`;
  }

  // Le pone al control el vestido del evento: la clase, su color y el título
  // DEBAJO del botón. Envuelve el nodo ya armado, sea el botón normal o un
  // control propio (Jet, Mando…), así que vale para todos por igual.
  //
  // Debajo y no encima a propósito: la fila alinea por arriba (align-items:
  // flex-start), así que una cinta encima bajaría el botón y lo dejaría
  // desalineado con los que no tienen evento. Debajo, todos los botones quedan a
  // la misma altura y el título crece hacia abajo sin mover a nadie.
  function vestirDeEvento(control, evento) {
    if (!evento || !control) return control;
    control.classList.add('evento');
    control.style.setProperty('--evento', colorDeEvento(evento));
    const cinta = document.createElement('span');
    cinta.className = 'evento-titulo';
    cinta.textContent = evento;
    control.appendChild(cinta);
    return control;
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
      // El `uid` va DENTRO del usuario (el documento no lo trae, su id es el uid):
      // los skins propios se piden por autor, y sin esto habría que pasarlo por
      // parámetro a media app. Mismo patrón que la lista de vecinos del admin.
      const usuario = { uid: user.uid, ...perfilSnap.data() };
      // Los skins de galería bajan en paralelo con los dispositivos: son datos
      // de la misma pantalla y encadenarlos sumaría otro viaje. Se le pasa el
      // usuario a mano porque esto corre ANTES de que `usuarioActual` exista.
      const [dispositivos, skins] = await Promise.all([
        cargarDispositivos(usuario), cargarSkins(usuario),
      ]);
      aplicarSkinsGaleria(skins);
      // Repinta con lo fresco (idempotente); solo cambia de vista si no venía
      // ya pintado desde la caché, para no sacar al usuario de otra pestaña.
      pintarControles(usuario, dispositivos, !yaEnPanel);
      guardarCache(); // para el próximo arranque instantáneo

      if (usuario.rol === 'admin') {
        // En este orden: el registro descarta lo de los aparatos sin registro,
        // y para saber cuáles son necesita la caché de dispositivos.
        cargarGestion().then(cargarRegistros);
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
      // Lo de un vecino no va en los botones del admin: administrar el aparato
      // de alguien no es tenerlo en tu tablero. Se sigue viendo y editando en
      // Admin, y el backend le deja operarlo si hace falta.
      documentos = documentos.filter((s) => {
        const dueno = s.data().dueno || '';
        return !dueno || dueno === usuario.uid;
      });
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

  // Los skins que este vecino puede llevar: los de la galería (aprobados por el
  // admin) más los suyos, que nacen privados.
  //
  // Van DOS consultas porque la regla de Firestore es por documento y las reglas
  // no filtran: pedir la colección entera lo rechazaría todo. El admin ve además
  // los privados de los demás, que es lo que le permite curar.
  //
  // Si falla la lectura no se rompe nada: la app se queda con los aspectos de
  // código y el vecino ve su botón normal.
  async function cargarSkins(quien) {
    const yo = quien || usuarioActual || {};
    const uid = yo.uid;
    const col = collection(db, 'skins');
    const consultas = [query(col, where('publico', '==', true), orderBy('creado', 'desc'))];
    if (uid) consultas.push(query(col, where('autor', '==', uid), orderBy('creado', 'desc')));
    // El admin pide también los que están esperando su visto bueno.
    if (yo.rol === 'admin') {
      consultas.push(query(col, where('publico', '==', false), orderBy('creado', 'desc')));
    }
    try {
      const snaps = await Promise.all(consultas.map((c) => getDocs(c)));
      // Un mismo skin puede venir en dos consultas (el propio ya aprobado), así
      // que el Map deduplica por id y conserva el orden: primero lo aprobado.
      const porId = new Map();
      for (const snap of snaps) {
        for (const d of snap.docs) {
          if (!porId.has(d.id)) porId.set(d.id, { id: d.id, ...d.data() });
        }
      }
      return [...porId.values()].filter((s) => typeof s.imagen === 'string');
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
    // La hamburguesa ya no existe: Admin y Actividad viven en Mi perfil, para
    // que el administrador use la misma app que un vecino.
    document.querySelectorAll('.solo-admin').forEach((el) => el.classList.toggle('oculto', !esAdmin));
    // Crear un botón lo hace cualquiera, pero no significa lo mismo: el del
    // vecino nace suyo y privado; el del admin entra directo a la galería.
    $('btn-publicar-skin').textContent = esAdmin ? 'Publicar en la galería' : 'Guardar mi botón';
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
  // Ancho real de cada control según su aspecto. Estaba en 220 para todo, y el
  // Mando mide 170, el Jet 157 y el Sabiem 150: con anchos tan distintos las
  // decisiones de maquetado salían mal (se veían tres y un pedazo de otro).
  const ANCHOS_ASPECTO = { rueda: 150, jet: 157, sabiem: 150, mando: 170, pilder: 158 };
  const ANCHO_CONTROL = (d) => ANCHOS_ASPECTO[aspectoDe(d)] || 220;
  // En compacto solo se achica el botón circular (168+26+26 -> 122+17+17); los
  // controles propios (rueda, jet, sabiem, mando) no cambian de tamaño.
  const ANCHO_COMPACTO = (d) => ANCHOS_ASPECTO[aspectoDe(d)] || 156;
  const HUECO_FILA = 34;   // el gap de .grupo-controles
  function cabenEnFila(lista, contenedor, ancho = ANCHO_CONTROL) {
    const disponible = contenedor.clientWidth || (Math.min(640, window.innerWidth) - 32);
    const total = lista.reduce((s, d) => s + ancho(d), 0)
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
        // Si no caben grandes pero SÍ compactos, van en fila centrada compacta.
        // Antes esto caía en el carrusel de dos en dos, donde cada ficha ocupa
        // el 50% del contenedor: con más ancho del necesario los botones se
        // separaban y quedaba un hueco en medio (se veía en escritorio).
        const compactoEnFila = !plano && cabenEnFila(enCarrusel, contenedor, ANCHO_COMPACTO);
        // Desde DOS, de dos en dos: media pantalla cada uno y los botones algo
        // más chicos para que quepan enteros, con el nombre debajo. Solo un
        // control solitario se queda grande y centrado — con dos ya se veía uno
        // y una rebanada, que era el problema.
        const doble = !plano && !compactoEnFila && enCarrusel.length >= 2;
        fila.className = 'grupo-controles'
          + (plano || compactoEnFila ? '' : ' carrusel')
          + (doble ? ' doble' : '')
          + (doble || compactoEnFila ? ' compacto' : '');
        // Los de la columna DERECHA van espejados: ahí el pulgar tapa el
        // costado derecho, que es donde vive la columna de luces de la rueda.
        // Espejar los pares deja las luces del lado que queda libre.
        const menudo = doble || compactoEnFila;   // botón chico y nombre debajo
        const dosPorFila = menudo || enCarrusel.length === 2;
        enCarrusel.forEach((dispositivo, i) => {
          const t = tarjetaDispositivo(dispositivo);
          // En dos-en-dos el botón es más chico y el nombre ya no cabe dentro
          // (ni en el círculo ni en la franja del anillo): se baja debajo.
          if (dosPorFila && i % 2 === 1) t.classList.add('espejo');
          fila.appendChild(t);
        });
        contenedor.appendChild(fila);
        if (doble) {
          // El hueco de cada ficha se reparte en partes ENTERAS del ancho, así
          // se ven 2, 3 o 4 controles completos y nunca "tres y un pedazo".
          const disp = fila.clientWidth || (Math.min(640, window.innerWidth) - 32);
          const mayor = Math.max(...enCarrusel.map(ANCHO_COMPACTO));
          const cuantos = Math.max(2, Math.floor(disp / mayor));
          fila.style.setProperty('--hueco-ficha', `${100 / cuantos}%`);
        }
        // El coverflow (escalar según distancia al centro) solo tiene sentido
        // cuando hay UNO en foco; de dos en dos los dos van a tamaño completo.
        if (!plano && !compactoEnFila && !doble) activarCarrusel(fila);
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
    // El del Pilder entra en el MISMO desbloqueo: iOS lo concede por gesto del
    // usuario, no por audio, y montar un segundo mecanismo significaría que el
    // primer toque de una palanca fuera mudo según por dónde hubieras entrado.
    [jetTapa, jetToggle, pilderAudio].forEach((a) => {
      try {
        a.muted = true; const p = a.play();
        if (p && p.then) p.then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; });
        else { a.pause(); a.muted = false; }
      } catch (e) { /* ignore */ }
    });
  };

  // El sonido del Pilder: los DOS clics viven en un solo archivo, así que se
  // reproduce por tramos. Un `<audio>` por sonido sería más simple, pero el
  // archivo llegó así y partirlo a mano es una pieza más que mantener.
  //
  // Dónde corta: medido sobre la envolvente del wav, no a ojo. Subir ocupa
  // 0.15-0.30s (es un racimo: una palanca de verdad hace varios chasquidos) y
  // bajar 0.40-0.50s.
  const pilderAudio = new Audio('toggle_pilder.wav?v=1'); pilderAudio.preload = 'auto';
  const PILDER_TRAMOS = { subir: [0.15, 0.30], bajar: [0.40, 0.50] };
  let pilderCorte = null;
  function pilderSonar(cual) {
    const [desde, hasta] = PILDER_TRAMOS[cual] || PILDER_TRAMOS.subir;
    try {
      clearTimeout(pilderCorte);
      pilderAudio.muted = false;
      pilderAudio.currentTime = desde;
      const p = pilderAudio.play();
      if (p && p.catch) p.catch(() => {});
      // Se para solo al acabar SU tramo; si no, seguiría hasta el final del
      // archivo y sonarían los dos clics de un tirón.
      pilderCorte = setTimeout(() => { try { pilderAudio.pause(); } catch (e) { /* ignore */ } },
        (hasta - desde) * 1000);
    } catch (e) { /* ignore */ }
  }

  // Control tipo "Jet Switch": tapa de seguridad roja + palanca. Se desliza la
  // tapa hacia arriba (armar) y luego la palanca (abrir). Es MOMENTARY como un
  // portón: al abrir dispara el pulso y la palanca vuelve sola a Armado en 1 s.
  function controlJet(dispositivo, demo) {
    const control = document.createElement('div');
    control.className = 'control control-jet';

    // El nombre va DEBAJO como en todos los demás controles (antes iba arriba
    // con su propio estilo de plantilla; quedaba desalineado al lado de los
    // otros). Misma clase que el resto para que todas las etiquetas coincidan.
    const titulo = document.createElement('span');
    titulo.className = 'etiqueta-control';
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

    control.append(sw, titulo);

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


  // --- Mantener pulsado un botón lo viste ---------------------------------
  //
  // La puerta al Locker que está DONDE ESTÁ EL OBJETO. La otra —la pestaña— es
  // la visible, y es la que cuenta que este gesto existe; sola, una pulsación
  // larga que nadie anuncia no existe para nadie, que es la lección que este
  // mismo feature ya nos dio dos veces.
  //
  // De paso enseña el alcance sin una línea de texto: vistes ESE botón, porque
  // es el que tenías debajo del dedo.
  const PULSACION_LARGA = 500;
  const ARRASTRE_MAXIMO = 10;   // px; más que esto es un scroll, no una pulsación

  function vestirAlMantenerPulsado(control, boton, dispositivo) {
    // Sin aspectos que elegir no hay nada que vestir, y un gesto que abre una
    // pantalla vacía es peor que no tenerlo.
    if (aspectosDe(dispositivo).length < 2) return;

    let reloj = null;
    let desde = null;
    let seVistio = false;

    const soltar = () => { clearTimeout(reloj); reloj = null; desde = null; };

    boton.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // Se limpia AQUÍ y no solo al tragarse el clic: al abrir el Locker la
      // pestaña se esconde y puede que ese clic no llegue nunca. Sin esto la
      // bandera se quedaría armada y se comería el siguiente toque de verdad
      // —o sea, la puerta no abriría— la próxima vez que volvieras.
      seVistio = false;
      desde = { x: e.clientX, y: e.clientY };
      reloj = setTimeout(() => {
        reloj = null;
        seVistio = true;
        navigator.vibrate?.(12);   // donde exista; en iOS no, y ahí lo dice la pantalla
        abrirLocker(dispositivo);
      }, PULSACION_LARGA);
    });

    boton.addEventListener('pointermove', (e) => {
      if (!desde) return;
      if (Math.hypot(e.clientX - desde.x, e.clientY - desde.y) > ARRASTRE_MAXIMO) soltar();
    }, { passive: true });

    ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => boton.addEventListener(ev, soltar));

    // El toque que viene después de la pulsación larga NO puede abrir la puerta.
    // Va en el ANCESTRO y en captura a propósito: en el propio botón los
    // listeners corren en orden de registro aunque uno sea de captura, así que
    // no habría manera de garantizar llegar antes que el que abre el portón.
    control.addEventListener('click', (e) => {
      if (!seVistio) return;
      seVistio = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }


  // --- Pilder: tablero industrial con palanca -------------------------------
  //
  // Dos fotos de un mismo panel: palanca abajo con el piloto y la barra
  // apagados, y palanca arriba con todo encendido. Se cruzan por opacidad.
  //
  // No lleva lógica propia a propósito: por dentro es un `<button>` que pasa por
  // `pulsar` o `alternar` como cualquier otro control, así que hereda gratis el
  // estado inicial, la duración de apertura de esa puerta y el modo demo. Lo
  // único suyo es qué se ve en cada clase.
  //
  // Sirve en los dos modos porque una palanca significa lo mismo en ambos: en
  // un interruptor se queda arriba mientras está encendido, y en una puerta sube
  // al abrir y baja sola cuando pasan los segundos de apertura — o sea que dice
  // "está abierta AHORA", que es justo lo que el botón redondo no sabe decir.
  function controlPilder(dispositivo, demo) {
    const control = document.createElement('div');
    control.className = 'control control-pilder';

    const boton = document.createElement('button');
    boton.type = 'button';
    // El modo va en la clase: una palanca de interruptor y una de puerta se
    // encienden por motivos distintos, y el CSS tiene que poder distinguirlas.
    boton.className = 'pilder ' + (dispositivo.modo === 'interruptor' ? 'pilder-llave' : 'pilder-pulso');
    boton.innerHTML = '<span class="pilder-capa pilder-off"></span>'
      + '<span class="pilder-capa pilder-on"></span>';
    boton.setAttribute('aria-label', dispositivo.modo === 'interruptor'
      ? `Encender o apagar ${dispositivo.nombre}`
      : `${dispositivo.etiquetaBoton || 'Abrir'} ${dispositivo.nombre}`);

    // El sonido va con la PALANCA, no con el toque: suena cuando la palanca se
    // mueve de verdad. En un interruptor eso es al saberse el nuevo estado; en
    // una puerta, al subir (al tocar) y al bajar (cuando se cierra).
    boton.addEventListener('pointerdown', jetDesbloquear, { passive: true });
    boton.addEventListener('click', () => {
      if (dispositivo.modo === 'interruptor') {
        // El clic suena YA, en la dirección hacia la que la empujas. La palanca
        // en cambio no se mueve hasta que el aparato confirma, porque enseña el
        // estado real y no lo que quisiste.
        //
        // Antes el sonido también esperaba a la confirmación, "por no adivinar".
        // Estaba mal pensado y se notó: con un interruptor de Tuya (Lobby) el
        // clic llegaba tarde, mientras que en una puerta salía al instante. El
        // clic es el MECANISMO bajo el dedo; que la luz encienda es el
        // resultado, y son dos cosas distintas. Si el comando falla, oíste el
        // clic y la palanca no se movió — que es exactamente lo que pasa al
        // accionar un interruptor que no engancha.
        const antes = boton.classList.contains('activo');
        pilderSonar(antes ? 'bajar' : 'subir');
        if (demo) { pintarEstado(boton, !antes); return; }
        alternar(boton, dispositivo);
        return;
      }
      // Puerta: sube ya —el chasquido es la respuesta al toque— y el de bajar
      // se programa para cuando la palanca vuelve, que es al cerrarse.
      if (boton.classList.contains('enviando') || boton.classList.contains('exito')) return;
      pilderSonar('subir');
      const alBajar = () => pilderSonar('bajar');
      if (demo) pulsarDemo(boton, dispositivo, alBajar); else pulsar(boton, dispositivo, alBajar);
    });
    if (!demo) vestirAlMantenerPulsado(control, boton, dispositivo);

    const titulo = document.createElement('span');
    titulo.className = 'etiqueta-control';
    titulo.textContent = dispositivo.nombre;
    control.append(boton, titulo);

    if (dispositivo.modo === 'interruptor' && !demo) estadoInicial(boton, dispositivo);
    return control;
  }

  // Un pase programado todavía no vale: el control se apaga y DICE desde
  // cuándo. Se hace aquí, en la puerta de salida por la que pasan todas las
  // formas de control (botón, Jet, Pilder, Sabiem, rueda…), en vez de repetirlo
  // en cada una.
  function tarjetaDispositivo(dispositivo, demo, aspectoForzado) {
    const control = construirTarjeta(dispositivo, demo, aspectoForzado);
    // Ni en la muestra del Locker ni en el demo: ahí no se abre nada de verdad.
    const empieza = (demo || aspectoForzado) ? 0 : empiezaEn(dispositivo);
    if (empieza) {
      control.classList.add('aun-no');
      control.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      const aviso = document.createElement('span');
      aviso.className = 'aun-no-texto';
      aviso.textContent = cuandoEmpiezaTexto(empieza);
      control.appendChild(aviso);
    }
    return control;
  }

  function construirTarjeta(dispositivo, demo, aspectoForzado) {
    // El aspecto sale del vestuario del vecino (o del que puso el admin).
    const aspecto = aspectoForzado || aspectoDe(dispositivo);
    // Si le llegó por un pase con título, el botón se viste de ese evento. Se
    // resuelve una vez y se aplica a cualquier forma de control que se devuelva.
    // `aspectoForzado` es el Locker (previsualización del vestuario): ahí no va
    // el vestido de evento, que es cosa del panel real.
    const evento = aspectoForzado ? '' : eventoDe(dispositivo);
    // Puerta de pulso con aspecto Jet: interruptor con tapa de seguridad.
    if (dispositivo.modo === 'pulso' && aspecto === 'jet') {
      return vestirDeEvento(controlJet(dispositivo, demo), evento);
    }
    // Aspecto Pilder: tablero con palanca. Vale en pulso y en interruptor.
    if (aspecto === 'pilder' && MODOS_SKIN.includes(dispositivo.modo)) {
      return vestirDeEvento(controlPilder(dispositivo, demo), evento);
    }
    // Aspecto Mando: el control remoto del portón (control propio, no botón).
    if (dispositivo.modo === 'pulso' && aspecto === 'mando') {
      return vestirDeEvento(controlMando(dispositivo, demo), evento);
    }
    // Aspecto Sabiem: placa de llamada de ascensor (control propio, no botón).
    if (dispositivo.modo === 'pulso' && aspecto === 'sabiem') {
      return vestirDeEvento(controlSabiem(dispositivo, demo), evento);
    }
    // Aspecto Rueda: reemplaza la perilla/slider por el rodillo.
    if (aspecto === 'rueda' && MODOS_RUEDA.includes(dispositivo.modo)) {
      return vestirDeEvento(controlRueda(dispositivo, demo), evento);
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
      // En el demo no: ahí el botón es una muestra DENTRO del Locker, y volver
      // a abrir el Locker desde el Locker no lleva a ningún sitio.
      if (!demo) vestirAlMantenerPulsado(control, boton, dispositivo);
      anillo.appendChild(boton);
      control.appendChild(anillo);
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
      if (!demo) vestirAlMantenerPulsado(control, boton, dispositivo);
      boton.addEventListener('click', () => {
        // En el demo solo se ve el on/off; no se enciende nada de verdad.
        if (demo) { pintarEstado(boton, !boton.classList.contains('activo')); return; }
        alternar(boton, dispositivo);
      });
      control.appendChild(boton);
    }
    // Cortina y dimmer llevan el nombre debajo; el termostato lo pinta su propia
    // perilla (nombre + temperatura al lado); pulso/interruptor dentro.
    // El nombre va SIEMPRE debajo, en todos los controles. Antes vivía en tres
    // sitios según el caso —dentro del círculo, dentro del anillo sobre la foto,
    // o debajo— y con los botones compactos no cabía en los dos primeros. Una
    // sola regla es más consistente y una menos que recordar. El termostato lo
    // pinta su propia perilla (nombre + temperatura al lado).
    if (dispositivo.modo !== 'termostato') {
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
    return vestirDeEvento(control, evento);
  }

  // Refleja el estado on/off en el botón y en su etiqueta de texto.
  function pintarEstado(boton, encendido) {
    boton.classList.toggle('activo', encendido);
    boton.setAttribute('aria-pressed', encendido ? 'true' : 'false');
  }

  // Pulso de mentira, para el vestuario: hace exactamente la misma coreografía
  // de clases que `pulsar` (enviando → éxito, con la duración de esa puerta)
  // para que el vecino sienta el botón, pero no le manda nada al dispositivo.
  // Es una muestra, no una puerta: el segundo toque la para. Con animaciones de
  // portón (que duran lo que dure la apertura real) esperar de brazos cruzados
  // a que termine para probar la siguiente es una espera tonta.
  function pulsarDemo(boton, dispositivo, alCerrar) {
    if (boton.classList.contains('enviando') || boton.classList.contains('exito')) {
      pararDemo(boton);
      return;
    }
    const relojes = [];
    boton._relojesDemo = relojes;
    boton.classList.add('enviando');
    const ESPERA_FINGIDA = 350;   // lo que tarda el comando en salir
    relojes.push(setTimeout(() => {
      boton.classList.remove('enviando');
      boton.classList.add('exito');
      // Menos la espera fingida, por lo mismo que en `pulsar`: la muestra tiene
      // que durar lo que dura de verdad, no eso más el viaje.
      const queda = Math.max(0, duracionAbierto(dispositivo) - ESPERA_FINGIDA);
      relojes.push(setTimeout(() => { boton.classList.remove('exito'); if (alCerrar) alCerrar(); }, queda));
    }, ESPERA_FINGIDA));
  }

  // Corta la coreografía a media música. Hay que matar los relojes además de
  // quitar las clases: si no, el que quedaba vivo vuelve a encender el botón.
  function pararDemo(boton) {
    (boton._relojesDemo || []).forEach(clearTimeout);
    boton._relojesDemo = null;
    boton.classList.remove('enviando', 'exito');
  }

  // Cuánto se queda "activo" un control tras pulsarlo: lo que tarda ESA puerta
  // en abrir (`segundosApertura`, por dispositivo). Con eso cualquier animación
  // —persianas, bordado girando, el ojo de Hal, la palanca del Pilder— acompaña
  // al portón real en vez de durar lo que le parezca.
  function duracionAbierto(dispositivo) {
    const seg = Number(dispositivo.segundosApertura);
    return seg > 0 ? seg * 1000 : (dispositivo.subtipo === 'porton' ? 5000 : 1500);
  }

  async function pulsar(boton, dispositivo, alCerrar) {
    if (boton.classList.contains('enviando')) return;
    // El reloj arranca en el TOQUE, no cuando contesta el servidor.
    //
    // El control se enciende al tocarlo (`enviando`) y antes se le sumaba
    // encima la duración entera al recibir respuesta, así que un portón puesto
    // en 1 segundo se quedaba encendido el viaje a la nube MÁS ese segundo —dos
    // o tres en total— y no se parecía al número configurado. Se notó con la
    // palanca del Pilder, que al quedarse arriba lo hace evidente; a las otras
    // animaciones les pasaba igual sin que saltara a la vista.
    //
    // El suelo sigue siendo el viaje de ida y vuelta: no se puede apagar antes
    // de saber si la puerta abrió.
    const desdeElToque = Date.now();
    // `alCerrar` avisa cuando el control VUELVE A REPOSO, salga bien o mal. Sale
    // del mismo reloj que lo apaga: quien quiera acompañar el cierre (el clic de
    // la palanca del Pilder) no puede llevar su propio temporizador, o se
    // separan en cuanto la red tarde.
    let yaCerro = false;
    const cerrar = () => { if (yaCerro) return; yaCerro = true; if (alCerrar) alCerrar(); };
    boton.classList.add('enviando');
    try {
      await ejecutarComando({ dispositivoId: dispositivo.id });
      boton.classList.add('exito');
      const queda = Math.max(0, duracionAbierto(dispositivo) - (Date.now() - desdeElToque));
      setTimeout(() => { boton.classList.remove('exito'); cerrar(); }, queda);
    } catch (err) {
      toast(err.message || 'No se pudo enviar el comando.', 'error');
      // También aquí: el aparato no contestó, así que la palanca cae de golpe
      // sin haber abierto nada — y esa caída hace su clic igual. Sin esto, un
      // dispositivo desconectado subía la palanca, la bajaba en seco y en
      // silencio, que se lee como que la app se tragó el gesto.
      cerrar();
    } finally {
      boton.classList.remove('enviando');
    }
  }

  async function alternar(boton, dispositivo) {
    if (boton.classList.contains('enviando')) return;
    const encendido = boton.classList.contains('activo');
    const accion = encendido ? 'apagar' : 'encender';
    boton.classList.add('enviando');
    // El control cambia YA y se deshace si el aparato no obedece.
    //
    // Antes esperaba la confirmación, y con la palanca del Pilder eso se veía:
    // el chasquido sonaba y la palanca bajaba un segundo después. Un
    // interruptor de verdad se mueve bajo el dedo; que la luz apague es otra
    // cosa. Si falla, vuelve a donde estaba y sale el aviso, así que no se
    // queda enseñando un estado que no es.
    pintarEstado(boton, !encendido);
    try {
      await ejecutarComando({ dispositivoId: dispositivo.id, accion });
    } catch (err) {
      pintarEstado(boton, encendido);
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
      // Los datos de conexión vienen en los propios dispositivos, así que se
      // recalculan al recargar en vez de quedarse con lo pintado antes.
      cacheConexion = null;
      renderGestion();     // pinta los puntos por su cuenta
      pintarProveedores(); // sin await: la lista no espera por Auth
      // Sin await tampoco: la fecha de Tuya no debe retrasar la lista, y si
      // falla su consulta lo demás sigue en pie.
      cargarTuya().catch((e) => console.warn('Tuya', e));
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

  // Un inmueble del listado. Si contiene otros, se pinta plegado con el
  // conteo al lado; el botón Editar va dentro del resumen, así que abrir y
  // editar no se pisan.
  function nodoInmueble(inm, hijosDe) {
    const hijos = hijosDe.get(inm.id) || [];
    const texto = `${inm.nombre} · ${TIPO_INMUEBLE_TXT[inm.tipo] || inm.tipo}`;
    if (!hijos.length) {
      const hoja = filaGestion(texto, false, () => abrirEditorInmueble(inm));
      // Sangrada lo que ocupa la flecha, para que el nombre de una casa suelta
      // arranque en la misma vertical que el de un edificio desplegable.
      hoja.className = 'inm-hoja';
      return hoja;
    }
    return ramaInmuebles(texto, hijos.map((h) => nodoInmueble(h, hijosDe)), {
      texto: 'Editar',
      clase: 'btn-secundario',
      alPulsar: () => abrirEditorInmueble(inm),
    });
  }

  // Una rama plegable del listado, con su conteo y un botón en el resumen.
  function ramaInmuebles(texto, nodos, boton) {
    const li = document.createElement('li');
    li.className = 'inm-rama';
    const det = document.createElement('details');
    det.open = Boolean(filtroGestion());
    const sum = document.createElement('summary');
    sum.innerHTML = '<svg class="pase-grupo-flecha" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>'
      + `<span>${escapar(texto)} <em>(${nodos.length})</em></span>`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = boton.clase;
    btn.textContent = boton.texto;
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();   // si no, el summary se abre o se cierra a la vez
      ev.stopPropagation();
      boton.alPulsar(ev);
    });
    sum.appendChild(btn);
    const ul = document.createElement('ul');
    ul.className = 'lista-gestion';
    for (const n of nodos) ul.appendChild(n);
    det.append(sum, ul);
    li.appendChild(det);
    return li;
  }

  // Pinta el punto de conexión de cada dispositivo. Si no se sabe el estado no
  // se pinta nada: mejor sin dato que un rojo mentiroso.
  // Lo último que se pintó. Los puntos viven en el DOM y CUALQUIER repintado
  // de la lista se los lleva (el buscador la rehace en cada tecla), así que se
  // guarda el dato para poder recolgarlos. Mismo caso que `cacheProveedores`.
  let cacheConexion = null;

  function pintarConexion(lista) {
    if (lista) cacheConexion = lista;
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

  // Lo que se está buscando, en minúsculas y sin tildes: un buscador para las
  // tres listas en vez de uno por sección.
  const filtroGestion = () => sinTildes(($('buscar-gestion') || {}).value || '');
  const coincide = (...partes) => {
    const q = filtroGestion();
    return !q || sinTildes(partes.filter(Boolean).join(' ')).includes(q);
  };

  // Oculta la sección entera (encabezado incluido) cuando se está buscando y
  // no queda nada: si no, quedan tres títulos sueltos sobre listas vacías.
  function mostrarSeccion(nombre, lista, hay) {
    const cab = document.querySelector(`.encabezado-admin[data-seccion="${nombre}"]`);
    const vacia = Boolean(filtroGestion()) && !hay;
    if (cab) cab.classList.toggle('oculto', vacia);
    lista.classList.toggle('oculto', vacia);
  }

  // El servicio de Tuya y cuándo vence.
  //
  // Solo para el administrador GENERAL —el que puede renovar en Tuya—, no para
  // los admins de un edificio: no es su trámite y solo sería ruido.
  //
  // Se pinta el estado que dejó la última revisión además de la fecha: saber
  // "vence el 7 de febrero" no dice si HOY está respondiendo, y esas son dos
  // preguntas distintas.
  async function cargarTuya() {
    const soyElGeneral = usuarioActual && usuarioActual.rol === 'admin' && !miAlcance().length;
    $('seccion-tuya').classList.toggle('oculto', !soyElGeneral);
    $('caja-tuya').classList.toggle('oculto', !soyElGeneral);
    if (!soyElGeneral) return;

    const r = await ajusteTuya({}).catch(() => null);
    if (!r) return;
    const { vence, caido, revisado } = r.data;

    $('tuya-vence').value = vence || '';
    const cuando = revisado ? new Date(revisado).toLocaleDateString('es-VE') : null;
    $('estado-tuya').textContent = caido
      ? 'Tuya no está respondiendo: los dispositivos Tuya no abren hasta renovar.'
      : cuando
        ? `Respondiendo bien. Última revisión: ${cuando}.`
        : 'Sin revisar todavía.';
  }

  $('btn-guardar-tuya').addEventListener('click', async () => {
    const boton = $('btn-guardar-tuya');
    const error = $('error-tuya');
    error.classList.add('oculto');
    boton.disabled = true;
    const antes = boton.textContent;
    boton.textContent = 'Guardando…';
    try {
      await ajusteTuya({ vence: $('tuya-vence').value });
      // Se dice que quedó guardado, no solo se calla: sin confirmación nadie
      // sabe si el cambio se grabó.
      boton.textContent = 'Guardado';
      await cargarTuya();
      setTimeout(() => { boton.textContent = antes; }, 2000);
    } catch (e) {
      error.textContent = e.message || 'No pude guardarlo.';
      error.classList.remove('oculto');
      boton.textContent = antes;
    } finally {
      boton.disabled = false;
    }
  });

  function renderGestion() {
    const ld = $('gestion-dispositivos');
    ld.textContent = '';
    const MODOS = { pulso: 'pulso', interruptor: 'interruptor', cortina: 'cortina', dimmer: 'dimmer', termostato: 'termostato' };
    const nombreDueno = (uid) => {
      const u = cacheUsuarios.find((x) => x.uid === uid);
      return u ? nombreCompleto(u) : 'un vecino';
    };
    const pintarFila = (d) => {
      // Se marca de quién es cuando NO es del condominio: son los que pueden
      // desaparecer si el vecino desvincula su cuenta.
      const texto = `${d.nombre} · ${MODOS[d.modo] || 'pulso'}`
        + (d.dueno ? ` · de ${nombreDueno(d.dueno)}` : '')
        + (seRegistra(d) ? '' : ' · sin registro')
        + (malColgado(d) ? ' · lo ve todo el edificio' : '');
      const fila = filaGestion(texto, d.activo === false, () => abrirEditorDispositivo(d));
      fila.dataset.disp = d.id; // para colgarle después el punto de conexión
      ld.appendChild(fila);
    };
    // Agrupados por INMUEBLE, no por proveedor: así una caída de todo un
    // edificio salta a la vista (si se desvincula su cuenta Tuya, se van todos
    // juntos). Con una cuenta por edificio el proveedor deja de ser el criterio
    // útil para agrupar.
    const caidos = (items) => items.filter((d) => d.conexion && d.conexion.online === false).length;
    const encabezado = (txt, items) => {
      const n = caidos(items);
      const cab = document.createElement('li');
      cab.className = 'grupo-gestion' + (n ? ' grupo-alerta' : '');
      cab.textContent = n ? `${txt} · ${n} sin conexión` : txt;
      ld.appendChild(cab);
    };
    // Primero los que no tienen inmueble: nadie los ve, porque el vecino solo
    // alcanza lo de su inmueble, así que se quedan invisibles hasta que alguien
    // se acuerda. Aquí se delatan.
    // Se filtra por lo que se ve en la fila y además por el inmueble donde
    // está: buscar "Torre A" tiene que sacar sus dispositivos.
    const visiblesD = cacheDispositivos.filter((d) => coincide(d.nombre, d.modo, rutaInmueble(d.inmueble)));
    const sueltos = visiblesD.filter((d) => !d.inmueble);
    if (sueltos.length) {
      encabezado(`Sin inmueble (${sueltos.length})`, sueltos);
      sueltos.forEach(pintarFila);
    }
    const porInmueble = new Map();
    for (const d of visiblesD) {
      if (!d.inmueble) continue;
      if (!porInmueble.has(d.inmueble)) porInmueble.set(d.inmueble, []);
      porInmueble.get(d.inmueble).push(d);
    }
    [...porInmueble.entries()]
      .map(([id, items]) => ({ id, items, titulo: rutaInmueble(id) || '(inmueble borrado)' }))
      .sort((a, b) => a.titulo.localeCompare(b.titulo))
      .forEach(({ items, titulo }) => {
        encabezado(titulo, items);
        items.forEach(pintarFila);
      });
    mostrarSeccion('dispositivos', ld, visiblesD.length);
    pintarConexion(cacheConexion || conexionGuardada());

    const li = $('gestion-inmuebles');
    li.textContent = '';
    if (!cacheInmuebles.length) {
      const vacio = document.createElement('li');
      vacio.className = 'vacio';
      vacio.textContent = 'Aún no hay inmuebles. Créalos para asignarlos a los vecinos.';
      li.appendChild(vacio);
    }
    // En árbol: un edificio con sus 24 apartamentos en una lista plana es
    // ilegible. Cada inmueble con hijos se pliega y solo se abre si hace falta.
    // Al buscar se conservan también los ANCESTROS de lo que coincide: si no,
    // el "3B" que casa se quedaría sin la torre de la que cuelga y no habría
    // dónde pintarlo.
    let listaInm = cacheInmuebles;
    if (filtroGestion()) {
      const porId = new Map(cacheInmuebles.map((x) => [x.id, x]));
      const dejar = new Set();
      for (const inm of cacheInmuebles) {
        if (!coincide(inm.nombre, TIPO_INMUEBLE_TXT[inm.tipo], inm.ciudad)) continue;
        let x = inm;
        for (let n = 0; n < 6 && x; n++) {
          dejar.add(x.id);
          x = porId.get(x.padre);
        }
      }
      listaInm = cacheInmuebles.filter((x) => dejar.has(x.id));
    }
    const hijosDe = new Map();
    const conocidos = new Set(listaInm.map((x) => x.id));
    const raices = [];
    // Huérfano = su padre ya no existe. Pasa si se borró el edificio sin
    // llevarse los apartamentos; sin esto no se verían en ningún lado.
    const huerfanos = [];
    for (const inm of listaInm) {
      if (!inm.padre) { raices.push(inm); continue; }
      if (!conocidos.has(inm.padre)) { huerfanos.push(inm); continue; }
      if (!hijosDe.has(inm.padre)) hijosDe.set(inm.padre, []);
      hijosDe.get(inm.padre).push(inm);
    }
    for (const raiz of raices) li.appendChild(nodoInmueble(raiz, hijosDe));
    if (huerfanos.length) {
      li.appendChild(ramaInmuebles(
        'Sin edificio · el suyo ya no existe',
        huerfanos.map((h) => nodoInmueble(h, hijosDe)),
        {
          texto: 'Eliminar todos',
          clase: 'btn-peligro',
          alPulsar: async (ev) => {
            if (!confirm(`¿Eliminar los ${huerfanos.length} inmuebles que quedaron sin edificio?`)) return;
            const b = ev.currentTarget;
            b.disabled = true;
            try {
              await adminEliminarInmueble({ ids: huerfanos.map((h) => h.id), conDescendientes: true });
              toast('Inmuebles eliminados.', 'ok');
              await trasGuardar();
            } catch (err) {
              toast(err.message || 'No se pudo eliminar.', 'error');
              b.disabled = false;
            }
          },
        },
      ));
    }

    mostrarSeccion('inmuebles', li, listaInm.length);

    renderVecinos();
  }

  // Residente = el que tiene algo permanente: su inmueble, dispositivos
  // sueltos, o es admin. Visitante = quien entró por una invitación y solo
  // tiene accesos temporales, sin nada asignado.
  const esResidente = (u) => (u.inmuebles || []).length > 0
    || (u.dispositivos || []).length > 0
    || u.rol === 'admin';

  // Un aparato de un vecino colgado de un EDIFICIO (no de su apartamento) lo
  // heredan todos los residentes de ese edificio. Pasa cuando el apartamento
  // todavía no existe como inmueble, y no se nota mirando: el aparato
  // funciona, solo que lo ve quien no debe.
  const malColgado = (d) => {
    if (!d.dueno || !d.inmueble) return false;
    const inm = cacheInmuebles.find((x) => x.id === d.inmueble);
    return Boolean(inm) && CONTENEDORES.includes(inm.tipo);
  };

  // Misma regla que `seRegistra()` en functions/index.js: el registro es sobre
  // accesos, no sobre confort. Se anota lo que abre algo; los aires, dimmers y
  // persianas no, y lo de un vecino nunca. El admin manda con `registrar`.
  const TIPOS_DE_ACCESO = ['puerta', 'ascensor'];
  const seRegistra = (d) => {
    const disp = d || {};
    if (typeof disp.registrar === 'boolean') return disp.registrar;
    if (disp.dueno) return false;
    return (disp.modo || 'pulso') === 'pulso' || TIPOS_DE_ACCESO.includes(disp.tipo);
  };

  // Contenedor = lo que agrupa unidades. El resto (apartamento, oficina,
  // casa, quinta, local…) es una unidad donde vive o trabaja alguien.
  const CONTENEDORES = ['conjunto', 'residencias', 'edificio', 'oficinas'];

  // Se le asignó el edificio antes de que existiera el directorio de
  // apartamentos, y al generarlo nadie lo movió a su unidad. Sigue abriendo
  // las áreas comunes, así que no da error: simplemente no alcanza lo suyo, y
  // eso no se nota mirando. Solo cuenta si ese contenedor YA tiene unidades;
  // antes de eso, tener el edificio es lo correcto.
  const sinUnidad = (u) => {
    // Un admin con el conjunto asignado lo tiene a propósito, no por olvido.
    if (u.rol === 'admin') return false;
    const suyos = u.inmuebles || [];
    if (!suyos.length) return false;
    if (suyos.some((x) => !CONTENEDORES.includes(x.tipo))) return false;
    return suyos.some((x) => cacheInmuebles.some((i) => i.padre === x.id));
  };

  function renderVecinos() {
    const lu = $('gestion-usuarios');
    lu.textContent = '';
    const visibles = cacheUsuarios.filter((u) => coincide(
      nombreCompleto(u),
      u.email,
      (u.inmuebles || []).map((x) => x.nombre).join(' '),
    ));   // ya vienen por nombre
    const residentes = visibles.filter(esResidente);
    const grupos = [
      ['Sin apartamento', residentes.filter(sinUnidad), true],
      ['Residentes', residentes.filter((u) => !sinUnidad(u))],
      ['Visitantes', visibles.filter((u) => !esResidente(u))],
    ];
    for (const [titulo, lista, alerta] of grupos) {
      if (!lista.length) continue;
      const cab = document.createElement('li');
      cab.className = 'grupo-gestion' + (alerta ? ' grupo-alerta' : '');
      cab.textContent = `${titulo} (${lista.length})`;
      lu.appendChild(cab);
      for (const u of lista) {
        // Con la ruta completa: "1D" suelto no dice nada, y un mismo número de
        // apartamento se repite en cada edificio.
        const inm = (u.inmuebles || []).map((x) => rutaInmueble(x.id) || x.nombre).join(', ');
        const partes = [nombreCompleto(u), inm, u.rol === 'admin' ? 'admin' : null].filter(Boolean);
        const fila = filaGestion(partes.join(' · '), u.activo === false, () => abrirEditorUsuario(u));
        fila.dataset.uid = u.uid; // para colgarle después cómo entra
        lu.appendChild(fila);
      }
    }
    if (!visibles.length) {
      const vacio = document.createElement('li');
      vacio.className = 'grupo-gestion';
      vacio.textContent = filtroGestion() ? 'Nadie coincide con la búsqueda.' : 'Sin vecinos todavía.';
      lu.appendChild(vacio);
    }
    mostrarSeccion('vecinos', lu, visibles.length);
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

  // Interruptor deslizante para los formularios. Reutiliza las clases del
  // selector de pases (.pase-casilla/.pase-tgl) en vez de crear otro estilo:
  // una sola definición de "toggle" en toda la app.
  function interruptor(texto, marcado) {
    const label = document.createElement('label');
    label.className = 'pase-casilla';
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = Boolean(marcado);
    const tgl = document.createElement('span');
    tgl.className = 'pase-tgl';
    tgl.setAttribute('aria-hidden', 'true');
    const nom = document.createElement('span');
    nom.className = 'pase-nom';
    nom.textContent = texto;
    label.append(c, tgl, nom);
    return { label, c };
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
    const cActivo = interruptor('Activo', d.activo !== false);
    const cRegistrar = interruptor('Registrar su actividad', seRegistra(d));
    // Dueño: vacío = del condominio. Si es de un vecino, él puede desvincular
    // su cuenta Tuya cuando quiera, así que el edificio no debería depender de
    // ese aparato. Hoy es informativo; no cambia quién puede usarlo.
    // Solo RESIDENTES: un visitante entró por una invitación y no vive ahí, así
    // que no puede ser dueño de un aparato. Se reutiliza el mismo criterio que
    // separa la lista de Vecinos, para que no haya dos definiciones.
    const sDueno = selector(
      [['', '— del condominio —']].concat(
        cacheUsuarios
          .filter((u) => u.rol !== 'admin' && esResidente(u))
          .map((u) => [u.uid, nombreCompleto(u)])),
      d.dueno || '');
    const iCuenta = entrada(tuya.cuenta, 'ej: Torre A, Ana Pérez');
    const iDevice = entrada(tuya.tuyaDeviceId, 'Device ID de Tuya');
    const iCodigo = entrada(tuya.codigo, 'switch_1');
    const iPulso = entrada(tuya.pulsoMs, '', 'number');
    const iCodigoBrillo = entrada(tuya.codigoBrillo, 'bright_value_v2');
    const iBrilloMax = entrada(tuya.brilloMax, '', 'number');
    const campoBrilloCodigo = campo('Código de brillo (Tuya)', iCodigoBrillo);
    const campoBrilloMax = campo('Brillo máximo (rango Tuya, ej. 1000)', iBrilloMax);
    const cInvertir = casilla('Invertir apertura (marca si la persiana abre al revés)', tuya.posicionInvertida === true);

    // Proveedor: Tuya (nube) o Homebridge (API de UI-X vía túnel).
    const sProveedor = selector([['tuya', 'Tuya'], ['homebridge', 'Homebridge'], ['shelly', 'Shelly']], d.proveedor || 'tuya');
    // Shelly por su nube: el id del aparato (Device Information en la app) y el
    // canal de la salida, que en un Plus 1 es siempre 0.
    const iShelly = entrada(tuya.shellyId, 'ej: b48a0a1cd978');
    iShelly.setAttribute('autocapitalize', 'none');
    const iShellyCanal = entrada(tuya.shellyCanal == null ? '' : tuya.shellyCanal, '0', 'number');
    iShellyCanal.min = '0';
    iShellyCanal.max = '7';
    const campoShelly = campo('Device ID de Shelly', iShelly);
    const campoShellyCanal = campo('Canal de la salida (0 en un Plus 1)', iShellyCanal);
    // Shelly: traer la lista en vez de copiar el Device ID de la app a mano.
    // Puede venir vacía con un aviso —lo que enumera es la parte deprecada de su
    // API—, y por eso el campo de arriba nunca se esconde: si esto falla, el
    // alta a mano sigue siendo el camino.
    const estadoShelly = document.createElement('div');
    estadoShelly.className = 'dps-detectados';
    const selShelly = document.createElement('select');
    selShelly.classList.add('oculto');
    selShelly.addEventListener('change', () => {
      const op = selShelly.selectedOptions[0];
      if (!op || !op.value) return;
      iShelly.value = op.value;
      if (!iNombre.value.trim()) iNombre.value = tituloCase(op.dataset.nombre || '');
      // El canal de la primera salida: en un Plus 1 es el único que hay, y en
      // uno de dos deja el formulario en un valor válido en vez de en blanco.
      if (op.dataset.canal) iShellyCanal.value = op.dataset.canal;
    });
    const btnShelly = botonForm('Traer dispositivos de Shelly', 'btn-secundario', async (ev) => {
      const b = ev.currentTarget;
      b.disabled = true;
      const orig = b.textContent;
      b.textContent = 'Consultando…';
      estadoShelly.textContent = '';
      try {
        const res = await adminListarDispositivosShelly({});
        const lista = (res.data && res.data.dispositivos) || [];
        selShelly.textContent = '';
        const vacio = document.createElement('option');
        vacio.value = '';
        vacio.textContent = `— elige uno (${lista.length}) —`;
        selShelly.appendChild(vacio);
        for (const s of lista) {
          const o = document.createElement('option');
          o.value = s.id;
          o.textContent = `${s.nombre}${s.modelo ? ` · ${s.modelo}` : ''}`
            + (s.online ? '' : ' · sin conexión')
            + ((s.canales || []).length > 1 ? ` · ${s.canales.length} salidas` : '')
            + (s.yaEsta ? ` · ya es "${s.yaEsta}"` : '');
          o.dataset.nombre = s.nombre;
          o.dataset.canal = (s.canales || []).length ? String(s.canales[0]) : '';
          selShelly.appendChild(o);
        }
        selShelly.classList.toggle('oculto', !lista.length);
        // Sin mensaje cuando va bien: el número ya está en "elige uno (N)".
        estadoShelly.textContent = (res.data && res.data.aviso)
          || (lista.length ? '' : 'Shelly no devolvió dispositivos.');
      } catch (err) {
        estadoShelly.textContent = err.message || 'No se pudo consultar Shelly.';
      } finally {
        b.disabled = false;
        b.textContent = orig;
      }
    });
    const cajaShelly = document.createElement('div');
    cajaShelly.className = 'tuya-lista';
    cajaShelly.append(btnShelly, selShelly, estadoShelly);
    const campoShellyLista = campo('', cajaShelly);
    const campoDevice = campo('Device ID de Tuya', iDevice);
    const campoCuenta = campo('Cuenta Tuya Origen', iCuenta);
    // Tuya: traer la lista en vez de copiar el Device ID de la consola a mano.
    // Al elegir uno se rellenan el id, el nombre y la etiqueta de cuenta.
    const estadoTuya = document.createElement('div');
    estadoTuya.className = 'dps-detectados';
    const selTuya = document.createElement('select');
    selTuya.classList.add('oculto');
    selTuya.addEventListener('change', () => {
      const op = selTuya.selectedOptions[0];
      if (!op || !op.value) return;
      iDevice.value = op.value;
      if (!iNombre.value.trim()) iNombre.value = tituloCase(op.dataset.nombre || '');
      if (!iCuenta.value.trim() && op.dataset.cuenta) iCuenta.value = op.dataset.cuenta;
    });
    const btnTuya = botonForm('Traer dispositivos de Tuya', 'btn-secundario', async (ev) => {
      const b = ev.currentTarget;
      b.disabled = true;
      const orig = b.textContent;
      b.textContent = 'Consultando…';
      estadoTuya.textContent = '';
      try {
        const res = await adminListarDispositivosTuya({});
        const lista = (res.data && res.data.dispositivos) || [];
        selTuya.textContent = '';
        const vacio = document.createElement('option');
        vacio.value = '';
        vacio.textContent = `— elige uno (${lista.length}) —`;
        selTuya.appendChild(vacio);
        // Agrupados POR CUENTA: con varias cuentas vinculadas, la lista venía
        // mezclada y no había forma de saber de cuál era cada aparato antes de
        // elegirlo. El UID de Tuya no dice nada a la vista, así que se numeran
        // y se muestra un trozo para poder distinguirlas.
        const porCuenta = new Map();
        for (const t of lista) {
          const k = t.cuenta || '';
          if (!porCuenta.has(k)) porCuenta.set(k, []);
          porCuenta.get(k).push(t);
        }
        for (const [cuenta, items] of porCuenta) {
          const grupo = document.createElement('optgroup');
          // El correo de la cuenta, que sí dice de quién es. Si Tuya no lo
          // devuelve se cae al identificador, recortado para que no ocupe media
          // línea.
          const quien = (items[0] && items[0].cuentaNombre)
            || (cuenta ? `${cuenta.slice(0, 6)}…${cuenta.slice(-4)}` : 'sin cuenta');
          grupo.label = porCuenta.size > 1
            ? `${quien} (${items.length})`
            : `Tu cuenta · ${quien} (${items.length})`;
          for (const t of items) {
            const o = document.createElement('option');
            o.value = t.id;
            // Se marca lo que ya está dado de alta para no duplicarlo por error.
            o.textContent = `${t.nombre}${t.online ? '' : ' · sin conexión'}`
              + (t.yaEsta ? ` · ya es "${t.yaEsta}"` : '');
            o.dataset.nombre = t.nombre;
            o.dataset.cuenta = t.cuentaNombre || t.cuenta || '';
            grupo.appendChild(o);
          }
          selTuya.appendChild(grupo);
        }
        selTuya.classList.toggle('oculto', !lista.length);
        // Sin mensaje cuando va bien: el número ya está en "elige uno (N)".
        estadoTuya.textContent = lista.length ? '' : 'Tuya no devolvió dispositivos.';
      } catch (err) {
        estadoTuya.textContent = err.message || 'No se pudo consultar Tuya.';
      } finally {
        b.disabled = false;
        b.textContent = orig;
      }
    });
    // Va dentro de un campo (aunque sin etiqueta: el botón ya dice lo que
    // hace) para heredar el ancho y el aire del resto del formulario; suelto
    // se solapaba con el control de arriba.
    const cajaTuya = document.createElement('div');
    cajaTuya.className = 'tuya-lista';
    cajaTuya.append(btnTuya, selTuya, estadoTuya);
    const campoTuyaLista = campo('', cajaTuya);

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
      const esShelly = sProveedor.value === 'shelly';
      const esTuya = !esHb && !esShelly;
      const esDimmer = sModo.value === 'dimmer';
      campoDevice.classList.toggle('oculto', !esTuya);
      campoTuyaLista.classList.toggle('oculto', !esTuya);
      campoCuenta.classList.toggle('oculto', !esTuya);
      campoCodigo.classList.toggle('oculto', !esTuya);
      campoBrilloCodigo.classList.toggle('oculto', !esTuya || !esDimmer);
      campoBrilloMax.classList.toggle('oculto', !esTuya || !esDimmer);
      // El inspector de DPs sirve para cualquier dispositivo Tuya (no solo
      // dimmers): es la herramienta para depurar suiches, cortinas, etc.
      campoDetectar.classList.toggle('oculto', !esTuya);
      campoAccesorio.classList.toggle('oculto', !esHb);
      campoCaracteristica.classList.toggle('oculto', !esHb);
      campoShellyLista.classList.toggle('oculto', !esShelly);
      campoShelly.classList.toggle('oculto', !esShelly);
      campoShellyCanal.classList.toggle('oculto', !esShelly);
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
            dueno: sDueno.value,
            cuentaTuya: iCuenta.value.trim(),
            modo: sModo.value,
            proveedor: sProveedor.value,
            orden: Number(iOrden.value) || 99,
            activo: cActivo.c.checked,
            registrar: cRegistrar.c.checked,
            tuyaDeviceId: iDevice.value.trim(),
            codigo: iCodigo.value.trim(),
            pulsoMs: Number(iPulso.value) || 1000,
            codigoBrillo: iCodigoBrillo.value.trim(),
            brilloMax: Number(iBrilloMax.value) || 1000,
            posicionInvertida: cInvertir.c.checked,
            accesorioId: sProveedor.value === 'homebridge' ? selAcc.value : '',
            shellyId: sProveedor.value === 'shelly' ? iShelly.value.trim() : '',
            shellyCanal: Number(iShellyCanal.value) || 0,
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
      campo('Dueño del aparato', sDueno),
      campo('Proveedor', sProveedor),
      campo('Orden (menor = primero)', iOrden),
      campoTuyaLista,
      campoCuenta,
      campoDevice,
      campoShellyLista,
      campoShelly,
      campoShellyCanal,
      campoCodigo,
      campoAccesorio,
      campoCaracteristica,
      campo('Duración del pulso (ms)', iPulso),
      campoBrilloCodigo,
      campoBrilloMax,
      cInvertir.label,
      campoDetectar,
      // Al final de la ficha: no son datos del aparato sino interruptores de
      // cómo se usa, y ahí no parten el formulario en dos.
      cRegistrar.label,
      cActivo.label,
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
    // De arriba abajo: "Tulipanes IV · 1D". Se sube por `padre`, así que la
    // cadena sale al revés de como se lee una ubicación. Además así los grupos
    // de la lista se ordenan por edificio en vez de esparcirse por el nombre
    // de la unidad.
    return partes.reverse().join(' · ');
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

  // Cuántos inmuebles cuelgan de este, a cualquier profundidad.
  function descendientesDe(id) {
    let n = 0;
    let frente = [id];
    for (let nivel = 0; nivel < 6 && frente.length; nivel++) {
      frente = cacheInmuebles.filter((x) => frente.includes(x.padre)).map((x) => x.id);
      n += frente.length;
    }
    return n;
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
    iCiudad.setAttribute('list', listaSugerencias('ciudades-ve', Object.keys(CIUDADES_VE).sort((a, b) => a.localeCompare(b))));
    iEstado.setAttribute('list', listaSugerencias('estados-ve', ESTADOS_VE));
    // El estado se deduce de la ciudad: es un dato fijo y no tiene sentido
    // teclearlo en cada inmueble. Se sigue pudiendo escribir a mano.
    iCiudad.addEventListener('input', () => {
      const est = ESTADO_POR_CIUDAD.get(sinTildes(iCiudad.value));
      if (est) iEstado.value = est;
    });
    // Padre: arma la jerarquía conjunto -> edificio -> apartamento. Quien tenga
    // asignado el apartamento alcanza también lo común del edificio y del
    // conjunto; al revés no.
    const sPadre = selector(opcionesInmueble(inm.id, '— no está dentro de nada —'), inm.padre || '');
    // Alta en lote. Un conjunto no se crea solo: se crea con sus torres y cada
    // torre con sus apartamentos. Un edificio suelto salta el paso de torres.
    // Solo al crear: editar uno existente no debe tocarle el árbol.
    const iTorres = entrada('', 'ej: 4', 'number');
    const iPisos = entrada('', 'ej: 8', 'number');
    const iPorPiso = entrada('', 'ej: 4', 'number');
    const iPH = entrada('', 'ej: 1', 'number');
    [iTorres, iPisos, iPorPiso, iPH].forEach((i) => {
      i.min = '0';
      i.inputMode = 'numeric';
    });
    // Torres y unidades por piso se nombran con letras (A…Z), así que ahí el
    // tope es 26. Los pisos van numerados y admiten más.
    iTorres.max = '26';
    iPorPiso.max = '26';
    iPisos.max = '60';
    iPH.max = '26';
    // Un conjunto no siempre son torres: puede ser de casas o quintas que
    // comparten los accesos comunes. Eso cambia qué se pregunta después.
    const sCompone = selector([
      ['torres', 'Torres con apartamentos'],
      ['casa', 'Casas'],
      ['quinta', 'Quintas'],
    ], 'torres');
    const campoCompone = campo('Se compone de', sCompone);
    // Las casas y quintas venezolanas tienen nombre propio ("Quinta Anaís"),
    // a veces con número, así que no se pueden generar: se escriben. Los
    // apartamentos sí siguen el patrón piso+letra y sí se generan.
    const tNombres = document.createElement('textarea');
    tNombres.rows = 4;
    tNombres.placeholder = 'Un nombre por línea:\nQuinta Anaís\nQuinta El Roble 12\nCasa 3';
    const campoNombres = campo('Nombres', tNombres);
    const campoTorres = campo('Torres', iTorres);
    const campoPisos = campo('Pisos', iPisos);
    const campoPorPiso = campo('Apartamentos por piso', iPorPiso);
    // El último piso suele ser solo el PH, así que va aparte y no como un piso
    // más: si no, saldría "13A" donde debería decir "PH".
    const campoPH = campo('Penthouses, encima del último piso', iPH);
    const previa = document.createElement('p');
    previa.className = 'dps-detectados lote-previa';
    const filas = [
      campo('Tipo', sTipo),
      campo('Nombre', iNombre),
      campo('Dentro de (el conjunto o edificio que lo contiene)', sPadre),
      campo('Ciudad', iCiudad),
      campo('Estado', iEstado),
      campo('Zona', iZona),
      campoCompone,
      campoTorres,
      campoNombres,
      campoPisos,
      campoPorPiso,
      campoPH,
      previa,
    ];

    const LETRAS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const esConjunto = () => sTipo.value === 'conjunto';
    // Lo que cuelga directamente de la raíz: torres de un conjunto, o casas y
    // quintas si el conjunto es de esos. Vacío = la raíz no tiene ese nivel.
    const bloque = () => (esConjunto() ? sCompone.value : '');
    const conTorres = () => bloque() === 'torres';
    // Y lo que cuelga de cada torre (o del edificio suelto).
    const unidad = () => {
      if (esConjunto()) return conTorres() ? 'apartamento' : '';
      return UNIDAD_DE[sTipo.value] || '';
    };
    const num = (i) => Math.min(Number(i.max), Math.max(0, parseInt(i.value, 10) || 0));
    const plural = (n, sing) => `${n} ${n === 1 ? sing : sing + 's'}`;
    const nombreUnidad = () => (unidad() === 'oficina' ? 'oficina' : 'apartamento');
    const nombreBloque = () => (conTorres() ? 'torre' : (bloque() === 'quinta' ? 'quinta' : 'casa'));
    // Se parte por líneas y también por comas: pegar "Casa 1, Casa 2" es lo
    // bastante natural como para que crear UNA casa llamada "Casa 1, Casa 2"
    // sea un fallo silencioso.
    const nombresSueltos = () => tNombres.value
      .split(/[\n,]/)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 200);

    // Arma el árbol de nombres que se va a crear. Vive solo aquí: es lo mismo
    // que se enseña en la vista previa y lo que se manda al servidor, así que
    // el admin crea exactamente lo que leyó.
    function arbolLote() {
      const aptos = [];
      if (unidad()) {
        for (let piso = 1; piso <= num(iPisos); piso++) {
          for (let k = 0; k < num(iPorPiso); k++) {
            aptos.push({ nombre: `${piso}${LETRAS[k]}`, tipo: unidad(), hijos: [] });
          }
        }
        const ph = num(iPH);
        for (let k = 0; k < ph; k++) {
          aptos.push({ nombre: ph === 1 ? 'PH' : `PH-${LETRAS[k]}`, tipo: unidad(), hijos: [] });
        }
      }
      if (!bloque()) return aptos;
      if (!conTorres()) {
        return nombresSueltos().map((nombre) => ({ nombre, tipo: bloque(), hijos: [] }));
      }
      return Array.from({ length: num(iTorres) }, (_, i) => ({
        nombre: `Torre ${LETRAS[i]}`,
        tipo: 'edificio',
        hijos: aptos.map((a) => ({ ...a })),
      }));
    }

    function sincronizarLote() {
      campoCompone.classList.toggle('oculto', !esConjunto());
      campoTorres.classList.toggle('oculto', !conTorres());
      campoNombres.classList.toggle('oculto', !bloque() || conTorres());
      campoPisos.classList.toggle('oculto', !unidad());
      campoPorPiso.classList.toggle('oculto', !unidad());
      campoPH.classList.toggle('oculto', !unidad());
      campoNombres.querySelector('span').textContent = bloque() === 'quinta' ? 'Nombre de cada quinta' : 'Nombre de cada casa';
      campoPisos.querySelector('span').textContent = conTorres() ? 'Pisos por torre' : 'Pisos';
      campoPorPiso.querySelector('span').textContent = unidad() === 'oficina' ? 'Oficinas por piso' : 'Apartamentos por piso';
      const hijos = arbolLote();
      if (!hijos.length) { previa.textContent = ''; previa.classList.remove('mensaje-error'); return; }
      const aptos = bloque() ? hijos[0].hijos : hijos;
      const rango = (l) => (l.length > 1 ? `${l[0].nombre} … ${l[l.length - 1].nombre}` : l[0].nombre);
      const total = (esNuevo ? 1 : 0) + hijos.length + hijos.reduce((t, h) => t + h.hijos.length, 0);
      // Se avisa aquí, no al pulsar Guardar: con 26 torres de 26 pisos salen
      // miles de inmuebles y el servidor lo rechazaría después de rellenarlo
      // todo.
      previa.classList.toggle('mensaje-error', total > MAX_LOTE);
      if (total > MAX_LOTE) {
        previa.textContent = `Son ${total} inmuebles y el máximo por lote es ${MAX_LOTE}. Créalo por partes.`;
        return;
      }
      const partes = [];
      if (bloque()) partes.push(`${plural(hijos.length, nombreBloque())} (${rango(hijos)})`);
      if (aptos.length) {
        partes.push(`${plural(aptos.length, nombreUnidad())}${bloque() ? ' en cada una' : ''} (${rango(aptos)})`);
      }
      previa.textContent = esNuevo
        ? `Se crearán ${partes.join(' y ')}. ${total} inmuebles en total.`
        : `Se agregarán ${partes.join(' y ')} a ${inm.nombre || 'este inmueble'}. Los que ya existan se dejan como están.`;
    }
    [sTipo, sCompone].forEach((x) => x.addEventListener('change', sincronizarLote));
    [iTorres, iPisos, iPorPiso, iPH, tNombres].forEach((i) => i.addEventListener('input', sincronizarLote));
    sincronizarLote();
    const acciones = [
      botonForm('Guardar', 'btn-primario', async (ev) => {
        const b = ev.currentTarget;
        if (!iNombre.value.trim()) { toast('Escribe el nombre del inmueble.', 'error'); return; }
        b.disabled = true;
        const datos = {
          tipo: sTipo.value,
          nombre: iNombre.value.trim(),
          ciudad: iCiudad.value.trim(),
          estado: iEstado.value.trim(),
          zona: iZona.value.trim(),
          padre: sPadre.value,
        };
        const hijos = arbolLote();
        const totalLote = (esNuevo ? 1 : 0) + hijos.length + hijos.reduce((t, h) => t + h.hijos.length, 0);
        if (totalLote > MAX_LOTE) {
          toast(`Son ${totalLote} inmuebles y el máximo por lote es ${MAX_LOTE}.`, 'error');
          b.disabled = false;
          return;
        }
        try {
          if (esNuevo && hijos.length) {
            const res = await adminCrearInmuebleLote({ raiz: { ...datos, hijos } });
            toast(`${(res.data && res.data.total) || ''} inmuebles creados ✓`, 'ok');
          } else {
            await adminGuardarInmueble({ id: esNuevo ? undefined : inm.id, ...datos });
            if (hijos.length) {
              // Dos pasos a propósito: primero se guarda lo que se editó de la
              // ficha y después se le cuelgan las unidades nuevas.
              const res = await adminCrearInmuebleLote({ raiz: { ...datos, id: inm.id, hijos } });
              const om = (res.data && res.data.omitidos) || 0;
              toast(`${(res.data && res.data.total) || ''} agregados ✓${om ? ` · ${om} ya existían` : ''}`, 'ok');
            } else {
              toast(esNuevo ? 'Inmueble creado ✓' : 'Inmueble actualizado ✓', 'ok');
            }
          }
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
        // Cuántos se lleva por delante: el admin tiene que verlo ANTES, no
        // enterarse de que borró 24 apartamentos al mirar el listado.
        const dentro = descendientesDe(inm.id);
        const aviso = dentro
          ? `¿Eliminar "${inm.nombre}" y los ${dentro} inmuebles que contiene? Se quitarán de los vecinos que los tengan asignados.`
          : `¿Eliminar el inmueble "${inm.nombre}"? Se quitará de los vecinos que lo tengan asignado.`;
        if (!confirm(aviso)) return;
        const b = ev.currentTarget;
        b.disabled = true;
        try {
          await adminEliminarInmueble({ id: inm.id, conDescendientes: true });
          toast(dentro ? `${dentro + 1} inmuebles eliminados.` : 'Inmueble eliminado.', 'ok');
          await trasGuardar();
        } catch (err) {
          toast(err.message || 'No se pudo eliminar.', 'error');
          b.disabled = false;
        }
      }));
    }
    abrirEditor(esNuevo ? 'Nuevo inmueble' : `Editar: ${inm.nombre}`, filas, acciones);
  }


  // Alta de vecinos en lote: se elige el edificio y sale una fila por cada
  // unidad suya, con quien ya la tiene puesto y bloqueado. Las filas vacías se
  // ignoran, así que se puede ir llenando a medida que llega la información.
  function abrirEditorVecinosLote() {
    const contenedores = cacheInmuebles
      .filter((x) => cacheInmuebles.some((h) => h.padre === x.id))
      .map((x) => [x.id, rutaInmueble(x.id)])
      .sort((a, b) => a[1].localeCompare(b[1]));
    if (!contenedores.length) {
      toast('Primero crea un edificio con sus apartamentos.', 'error');
      return;
    }
    const sDonde = selector(contenedores, contenedores[0][0]);
    const cuerpo = document.createElement('div');
    cuerpo.className = 'lote-vecinos';
    const resumen = document.createElement('p');
    resumen.className = 'dps-detectados';
    let campos = [];

    function pintarUnidades() {
      cuerpo.textContent = '';
      campos = [];
      const unidades = cacheInmuebles
        .filter((x) => x.padre === sDonde.value)
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { numeric: true }));
      for (const u of unidades) {
        const fila = document.createElement('div');
        fila.className = 'lote-fila';
        const tit = document.createElement('span');
        tit.className = 'lote-unidad';
        tit.textContent = u.nombre;
        fila.appendChild(tit);
        // Quién vive ahí ya, si hay alguien. Se enseña pero NO se bloquea: en
        // un apartamento vive más de una persona, y todas heredan sus
        // dispositivos, así que hay que poder sumar al resto de la casa.
        const ya = cacheUsuarios.filter((v) => (v.inmuebles || []).some((x) => x.id === u.id));
        if (ya.length) {
          const quien = document.createElement('span');
          quien.className = 'lote-ocupado';
          quien.textContent = `ya: ${ya.map(nombreCompleto).join(', ')}`;
          fila.appendChild(quien);
        }
        const iNom = entrada('', 'Nombre');
        const iApe = entrada('', 'Apellido');
        const iMail = entrada('', 'correo@ejemplo.com', 'email');
        [iNom, iApe].forEach((i) => i.setAttribute('autocapitalize', 'words'));
        iMail.setAttribute('autocapitalize', 'none');
        iMail.setAttribute('autocomplete', 'off');
        fila.append(iNom, iApe, iMail);
        campos.push({ inmueble: u.id, iNom, iApe, iMail });
        [iNom, iApe, iMail].forEach((i) => i.addEventListener('input', pintarResumen));
        cuerpo.appendChild(fila);
      }
      if (!unidades.length) {
        const vacio = document.createElement('p');
        vacio.className = 'dps-detectados';
        vacio.textContent = 'Ese inmueble todavía no tiene unidades.';
        cuerpo.appendChild(vacio);
      }
      pintarResumen();
    }

    const llenas = () => campos
      .map((c) => ({
        inmueble: c.inmueble,
        nombre: c.iNom.value.trim(),
        apellido: c.iApe.value.trim(),
        email: c.iMail.value.trim(),
      }))
      .filter((f) => f.nombre || f.email);

    function pintarResumen() {
      const n = llenas().length;
      const malas = llenas().filter((f) => !f.nombre || !f.email.includes('@')).length;
      resumen.classList.toggle('mensaje-error', malas > 0);
      resumen.textContent = !n
        ? 'Rellena las unidades que ya tengas; las vacías se ignoran.'
        : (malas
          ? `${malas} de ${n} sin nombre o sin correo válido.`
          : `Se ${n === 1 ? 'creará 1 cuenta' : `crearán ${n} cuentas`}, sin clave. La invitación se manda después.`);
    }

    sDonde.addEventListener('change', pintarUnidades);
    pintarUnidades();

    const acciones = [
      botonForm('Crear cuentas', 'btn-primario', async (ev) => {
        const filas = llenas();
        if (!filas.length) { toast('No hay ningún vecino que crear.', 'error'); return; }
        if (filas.some((f) => !f.nombre || !f.email.includes('@'))) {
          toast('Faltan nombres o hay correos sin @.', 'error');
          return;
        }
        const b = ev.currentTarget;
        b.disabled = true;
        try {
          const res = await adminCrearVecinosLote({ filas });
          const d = res.data || {};
          await cargarGestion();
          pantallaInvitar(d);
        } catch (err) {
          toast(err.message || 'No se pudieron crear.', 'error');
          b.disabled = false;
        }
      }),
      botonForm('Cancelar', 'btn-secundario', cerrarEditor),
    ];
    abrirEditor('Vecinos en lote', [campo('Edificio', sDonde), cuerpo, resumen], acciones);
  }

  // Segundo paso, a propósito separado: primero se ven las cuentas creadas y
  // solo entonces salen los correos. Uno mal escrito, ya enviado, no se recoge.
  function pantallaInvitar(d) {
    const creados = d.creados || [];
    const asignados = d.asignados || [];
    const fallos = d.fallos || [];
    const filas = [];
    const linea = (txt, clase) => {
      const p = document.createElement('p');
      p.className = clase || 'dps-detectados';
      p.textContent = txt;
      return p;
    };
    if (creados.length) {
      // Por unidad cuando viene del lote, por correo cuando es uno suelto.
      const quienes = creados.map((x) => x.inmueble || x.email).join(', ');
      filas.push(linea(creados.length === 1
        ? `Cuenta nueva: ${quienes}`
        : `${creados.length} cuentas nuevas: ${quienes}`));
    }
    if (asignados.length) filas.push(linea(`${asignados.length} ya tenían cuenta y se les sumó su inmueble.`));
    for (const f of fallos) filas.push(linea(`${f.etiqueta}: ${f.motivo}`, 'dps-detectados mensaje-error'));
    filas.push(linea(creados.length
      ? 'Ninguno tiene clave todavía. La invitación les manda el enlace para que pongan la suya.'
      : 'No hay cuentas nuevas a las que invitar.'));
    const acciones = [];
    if (creados.length) {
      acciones.push(botonForm(creados.length === 1 ? 'Enviar invitación' : `Enviar invitación a ${creados.length}`, 'btn-primario', async (ev) => {
        const b = ev.currentTarget;
        b.disabled = true;
        try {
          const res = await adminInvitarVecinos({ uids: creados.map((x) => x.uid) });
          const r = res.data || {};
          toast(`${r.enviados || 0} invitaciones enviadas ✓`
            + ((r.fallos || []).length ? ` · ${r.fallos.length} fallaron` : ''), 'ok');
          cerrarEditor();
        } catch (err) {
          toast(err.message || 'No se pudieron enviar.', 'error');
          b.disabled = false;
        }
      }));
    }
    acciones.push(botonForm('Listo, sin enviar', 'btn-secundario', cerrarEditor));
    abrirEditor('Cuentas creadas', filas, acciones);
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
    const iPass = entrada('', esNuevo ? 'Vacío: entra con Google o la pone él' : 'Dejar vacío para no cambiarla', 'password');
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
      campo(esNuevo ? 'Contraseña (opcional)' : 'Nueva contraseña (opcional)', iPass),
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
            const res = await adminCrearUsuario({
              nombre: iNombre.value.trim(),
              apellido: iApellido.value.trim(),
              email: iEmail.value.trim(),
              password: iPass.value,
              rol: sRol.value,
              dispositivos: casillas.seleccionados(),
              inmuebles: casInm.seleccionados(),
            });
            if (res.data && res.data.sinClave) {
              await cargarGestion();
              pantallaInvitar({ creados: [{ uid: res.data.uid, email: iEmail.value.trim(), inmueble: '' }] });
              return;
            }
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

  const PANELES_TAB = ['tab-controles', 'tab-pases', 'tab-locker', 'tab-gestion', 'tab-registro', 'tab-perfil'];
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
    // Arriba del todo al cambiar de sección.
    //
    // Las pestañas no son páginas: son bloques que se muestran y se ocultan
    // dentro del MISMO documento, así que el scroll no tenía motivo para
    // moverse y entrabas a la sección nueva por la mitad. Sin animación a
    // propósito: un desplazamiento suave al cambiar de pestaña se siente como
    // que la app va lenta.
    window.scrollTo(0, 0);
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
    if (id === 'tab-locker') { abrirLocker(); return; }
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
    // Los campos vuelven a lo guardado, así que aquí no hay nada que guardar.
    $('btn-guardar-perfil').classList.add('oculto');
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
    // Inmuebles: solo lectura (los asigna el admin en Gestión). Aparece si tiene
    // alguno, y nada más.
    //
    // Antes exigía además que NO fuera invitado, y eso escondía la sección a
    // quien entró por un pase y DESPUÉS se mudó al edificio: la marca
    // `invitado` se pone al canjear y no se quita nunca, así que se quedaba sin
    // ver su propio apartamento. Tener inmuebles ya dice lo mismo — un invitado
    // de verdad no tiene ninguno — y se corrige solo cuando deja de serlo.
    const inmuebles = Array.isArray(usuarioActual.inmuebles) ? usuarioActual.inmuebles : [];
    const mostrarInmuebles = inmuebles.length > 0;
    $('seccion-inmuebles').classList.toggle('oculto', !mostrarInmuebles);
    if (mostrarInmuebles) renderInmueblesPerfil(inmuebles);
  }

  // El Locker vivía dentro de "Mi perfil", y a Perfil solo se llegaba tocando
  // tu propio nombre en la cabecera —un control sin nada que dijera que lo era—.
  // O sea que la única puerta al Locker era invisible: no es que no se entendiera
  // la función, es que casi nadie llegaba a verla. Ahora es una pestaña del menú.
  //
  // `dispositivo` opcional: al entrar desde una pulsación larga se abre ya
  // vistiendo ESE botón, que además es lo que enseña el alcance sin decirlo.
  function abrirLocker(dispositivo) {
    if (dispositivo) vestDisp = dispositivo;
    mostrarTab('tab-locker');
    cerrarMenu();
    // El taller se recoge al ENTRAR, no al repintar. Si estuviera en
    // `renderVestuario` se cerraría solo justo después de publicar un botón,
    // que es cuando `refrescarSkins` repinta — en las manos de quien lo usaba.
    $('seccion-crear-skin').classList.add('oculto');
    renderVestuario();   // se arma con los dispositivos que ve hoy
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

  // El "Guardar datos" solo existe cuando hay un dato cambiado. Se compara con lo
  // que está guardado en vez de encenderlo al primer tecleo: si escribes algo y lo
  // deshaces, el botón se va, que es lo que promete. El email no cuenta (está
  // deshabilitado) ni los inmuebles (los asigna el admin, aquí son de lectura).
  function revisarCambiosPerfil() {
    if (!usuarioActual) return;
    const cambiado = $('perfil-nombre').value.trim() !== (usuarioActual.nombre || '')
      || $('perfil-apellido').value.trim() !== (usuarioActual.apellido || '');
    $('btn-guardar-perfil').classList.toggle('oculto', !cambiado);
  }
  ['perfil-nombre', 'perfil-apellido'].forEach((id) =>
    $(id).addEventListener('input', revisarCambiosPerfil));

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
      revisarCambiosPerfil();   // ya no hay nada que guardar: el botón se retira
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
    if (a.id === 'pilder') return { clase: 'muestra-pilder', html: '' };
    if (a.id === 'sabiem') return { clase: 'muestra-sabiem', html: '' };
    if (a.id === 'mando') return { clase: 'muestra-mando', html: '' };
    // Normal y las pieles: el icono del propio dispositivo, con la piel puesta.
    return { clase: a.piel ? `piel-${a.id}` : '', html: iconoDe(d) };
  }

  // Dispositivos que tienen algo que elegir. Las cortinas, dimmers y termostatos
  // son perillas/sliders y todavía no tienen aspectos, así que quedan fuera.
  const dispConAspectos = () => (misDispositivos || []).filter((d) => aspectosDe(d).length > 1);

  // Cuántos diseños se destacan arriba, en "Los más usados".
  const CUANTOS_ARRIBA = 5;

  let vestDisp = null;      // dispositivo que se está vistiendo
  let vestAspecto = null;   // opción centrada en el carrusel

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

    // Rejilla, no fila.
    //
    // Era un carrusel horizontal con coverflow: bonito con cuatro opciones,
    // inservible con veinte —todo en una línea, sin orden, y para ver el final
    // había que arrastrar a ciegas—. En rejilla se ven de golpe, y de paso se
    // va la máquina que más errores ha dado del proyecto (centrar la elegida,
    // elegir por scroll, el enfoque); aquí elegir es tocar, y ya.
    const ops = aspectosDe(vestDisp);
    const marca = (a) => {
      const m = muestraAspecto(a, vestDisp);
      const op = document.createElement('button');
      op.type = 'button';
      op.className = 'skin-op' + (a.id === vestAspecto ? ' activa' : '');
      op.dataset.aspecto = a.id;
      op.innerHTML = `<span class="skin-muestra ${m.clase}">${m.html}</span>`
        + `<span class="skin-nom">${escapar(a.nombre)}</span>`;
      return op;
    };
    const titulo = (texto) => {
      const h = document.createElement('h3');
      h.className = 'vest-grupo';
      h.textContent = texto;
      return h;
    };

    // Arriba LOS MÁS USADOS; abajo el resto por fecha, y los de fábrica al final.
    //
    // El grupo de arriba era por recencia y pasó a ser por uso: así la
    // popularidad tiene su escaparate y abajo queda un orden cronológico
    // limpio, en vez de dos bloques peleándose por el mismo criterio.
    //
    // El grupo de arriba existe SIEMPRE: son cinco huecos fijos, no un grupo que
    // aparece y desaparece. Se probó a que solo entraran los que tuvieran usos
    // —para que ninguno flojo ocupara sitio por ser reciente— y el resultado
    // fue peor: hoy nadie tiene usos, así que la galería se quedaba en una
    // lista corrida y se perdían las tres secciones.
    //
    // Manda el uso y la fecha es el desempate, así que hoy se llena con lo más
    // reciente y se va convirtiendo en popularidad solo, conforme la gente se
    // ponga diseños. Por eso el encabezado es "Destacados" y no "Los más
    // usados": hoy no sería verdad.
    const populares = ops.filter((a) => a.creado)
      .sort((a, b) => b.usos - a.usos || b.creado - a.creado)
      .slice(0, CUANTOS_ARRIBA);
    const resto = ops.filter((a) => !populares.includes(a));
    // Abajo, del más nuevo al más viejo. La popularidad NO va de segunda clave a
    // propósito: no hay dos diseños con la misma fecha de creación, así que
    // nunca llegaría a decidir nada y sería una regla escrita para no usarse.
    const porFecha = resto.filter((a) => a.creado).sort((a, b) => b.creado - a.creado);
    // Los de fábrica cierran. No están en la colección, así que no tienen fecha
    // ni usos que comparar: conservan el orden del catálogo entre ellos.
    // De los de fábrica, los LISOS cierran la lista: Normal y las cuatro pieles
    // (Neón, Acero, Cristal, Pop) son color sobre el botón de siempre, mientras
    // que Hal, Bordado, Argentina, Jet o Pilder son diseños con su propia
    // imagen. Lo que se viene a mirar es lo segundo; lo primero es a lo que se
    // vuelve, y para volver no hace falta que esté arriba.
    const esLiso = (a) => a.id === 'normal' || PIELES.includes(a.id);
    const deFabrica = resto.filter((a) => !a.creado && !esLiso(a))
      .concat(resto.filter((a) => !a.creado && esLiso(a)));
    const nuevos = populares;
    const usados = porFecha;

    // La ficha de fabricar.
    //
    // Antes esto era una sección plegada DEBAJO ("Crear un botón"), o sea una
    // decisión aparte que había que tomar antes de saber que existía. Aquí se
    // topa uno con ella eligiendo, que es justo el ánimo de mirar opciones: si
    // ninguna te gusta, la siguiente ficha es hacerte una.
    const hacer = document.createElement('button');
    hacer.type = 'button';
    hacer.className = 'skin-op skin-op-crear';
    // Sin `dataset.aspecto` A PROPÓSITO: no es un aspecto y no debe poder
    // elegirse como tal.
    hacer.innerHTML = '<span class="skin-muestra skin-muestra-crear">+</span>'
      + '<span class="skin-nom">Diseña Uno</span>';

    // Sin novedades no se escriben encabezados: un solo grupo titulado "Los
    // demás" es una etiqueta que no separa nada de nada.
    if (nuevos.length) {
      cont.appendChild(titulo('Destacados'));
      for (const a of nuevos) cont.appendChild(marca(a));
      // Cierra el grupo de arriba; si ese grupo todavía no existe, la ficha
      // abre la lista (más arriba). En cualquiera de los dos casos queda a la
      // vista: al final de todo quedaría debajo de todo el catálogo, que es
      // donde no mira nadie.
      cont.appendChild(hacer);
      cont.appendChild(titulo('Los demás'));
    }
    for (const a of porFecha.concat(deFabrica)) cont.appendChild(marca(a));


    // Con muchas opciones la puesta puede quedar fuera de la vista. `nearest`
    // no mueve nada si ya se ve, así que no da un salto al abrir.
    cont.querySelector('.skin-op.activa')?.scrollIntoView({ block: 'nearest' });
  }

  function renderVestuario() {
    const lista = dispConAspectos();
    const sel = $('vest-disp');
    const nota = $('vest-nota');
    // Los que no se pueden vestir SALEN, apagados, en vez de desaparecer.
    //
    // Antes se filtraban y en su lugar iba una nota contándolos ("tus otros 2
    // dispositivos…"). Quien solo tiene cortinas abría el Locker, veía una
    // pantalla casi vacía y una frase, y no tenía forma de relacionarla con
    // nada. Verlos ahí en gris dice qué abarca esto y dónde termina sin
    // explicarlo: reconoces tu cortina y ves que a esa no se le puede.
    const sinEstilos = (misDispositivos || []).filter((d) => !lista.some((x) => x.id === d.id));
    nota.classList.add('oculto');

    // El desplegable se esconde solo si NO HAY NADA que mirar. Con uno vestible
    // y otros apagados sí vale la pena: es donde se ve el alcance.
    const hayQueElegir = lista.length + sinEstilos.length > 1;
    sel.classList.toggle('oculto', !hayQueElegir);
    if (!lista.length) {
      $('vest-demo').textContent = '';
      $('vest-opciones').textContent = '';
      vestDisp = null;
      nota.classList.remove('oculto');
      nota.textContent = sinEstilos.length
        ? 'Las perillas y los sliders todavía no se pueden vestir.'
        : 'Todavía no tienes dispositivos.';
      refrescarBotonEstilo();
      if (!hayQueElegir) return;
    }
    // Mantener el dispositivo elegido si sigue existiendo; si no, el primero.
    if (lista.length) {
      if (!vestDisp || !lista.some((d) => d.id === vestDisp.id)) vestDisp = lista[0];
      else vestDisp = lista.find((d) => d.id === vestDisp.id);
    }
    sel.textContent = '';
    for (const d of lista) {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = d.nombre;
      o.selected = vestDisp && d.id === vestDisp.id;
      sel.appendChild(o);
    }
    // Los apagados van al final y no se pueden elegir. `disabled` ya los pinta
    // en gris en los cinco navegadores, sin CSS nuestro.
    for (const d of sinEstilos) {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = d.nombre;
      o.disabled = true;
      sel.appendChild(o);
    }
    if (!lista.length) return;
    vestAspecto = aspectoDe(vestDisp);
    pintarDemoVestuario();
    pintarOpcionesVestuario();
    // Al abrir el Locker, lo puesto ya está guardado: el botón nace apagado
    // diciendo "Guardado", que es la señal de que no hay nada pendiente.
    refrescarBotonEstilo();
    refrescarEditorSkin();
  }

  // Aplica la opción elegida: repinta el demo y la guarda. Lo llaman tanto el
  // toque como el scroll del carrusel.
  // Elegir es PROBARSE: repinta el demo y enciende el botón. No guarda.
  //
  // Antes escribía en Firestore en cuanto centrabas una opción. Funcionaba, pero
  // no daba seguridad de que hubiera quedado: el aviso de abajo dura segundo y
  // medio y aparece bajo el carrusel, mientras los ojos están en el botón. Con
  // un Guardar que hay que tocar, se sabe qué se grabó y cuándo.
  function seleccionarAspecto(asp) {
    if (!vestDisp || !asp || asp === vestAspecto) return;
    vestAspecto = asp;
    marcarElegida();
    refrescarEditorSkin();
    pintarDemoVestuario();
    enseñarLaAnimacion();
    refrescarBotonEstilo();
  }

  // El diseño elegido, si es de la galería (los de fábrica no se editan: son
  // parte de la app, no de nadie).
  const skinElegido = () => skinsGaleria.find((s) => s.id === vestAspecto) || null;

  // Enseña "Editar diseño" solo cuando hay algo tuyo elegido, y recoge el
  // editor al cambiar de diseño: dejarlo abierto con OTRO skin delante haría
  // que editaras el que ya no estás mirando.
  function refrescarEditorSkin() {
    const s = skinElegido();
    $('btn-editar-skin').classList.toggle('oculto', !puedoEditarSkin(s));
    cerrarEditorSkin();
  }

  // Sale del modo edición y deja la pantalla como estaba.
  function cerrarEditorSkin() {
    $('vestuario').classList.remove('editando');
    document.querySelector('.vest-guardar-skin')?.remove();   // vive fuera del editor
    $('btn-editar-skin').classList.toggle('oculto', !puedoEditarSkin(skinElegido()));
    $('vest-editor').classList.add('oculto');
    $('vest-editor').textContent = '';
    msgEditorSkin('');
    // Deshace la animación que se estaba probando. Se prueba tocando el mapa
    // que usa el pintado, así que si no se repone, una animación elegida y NO
    // guardada se quedaría puesta hasta recargar — y parecería guardada.
    if (animacionOriginal) {
      const { id, clase } = animacionOriginal;
      if (ASPECTOS_IMAGEN[id]) ASPECTOS_IMAGEN[id].clase = clase;
      animacionOriginal = null;
      pintarDemoVestuario();
    }
  }



  function msgEditorSkin(texto, error) {
    const el = $('vest-editor-msg');
    el.textContent = texto || '';
    el.classList.toggle('oculto', !texto);
    el.classList.toggle('mensaje-error', !!error);
    el.classList.toggle('mensaje-ok', !error && !!texto);
  }

  // El anillo verde sigue a lo que tienes elegido, no a lo guardado.
  //
  // Se pintaba una sola vez, al armar la rejilla, y no se movía nunca: elegías
  // otro diseño, la muestra cambiaba, y el anillo seguía marcando el anterior.
  // Con veinte fichas eso es no saber en cuál estás.
  //
  // Quién marca qué: el ANILLO dice cuál te estás probando, y el botón de abajo
  // dice si eso está guardado ("Guardar" encendido = te falta grabarlo,
  // "Guardado" apagado = ya está). Dos preguntas distintas, dos señales.
  function marcarElegida() {
    $('vest-opciones').querySelectorAll('.skin-op').forEach((op) => {
      // `Boolean(vestAspecto)` no sobra: la ficha de "Diseña Uno" no tiene
      // `dataset.aspecto`, así que sin esto un `vestAspecto` vacío casa con
      // ella (undefined === undefined) y el anillo verde se le va a la ficha
      // de fabricar, que no es un diseño que puedas llevar puesto.
      op.classList.toggle('activa', Boolean(vestAspecto) && op.dataset.aspecto === vestAspecto);
    });
  }

  // Al elegir un skin que se mueve, la muestra lo hace SOLA una vez.
  //
  // La animación solo se veía tocando el botón de muestra, y nada decía que se
  // pudiera tocar: elegías "Gira", veías una imagen quieta, y la opción parecía
  // no hacer nada. No estaba rota — el resultado estaba detrás de un gesto que
  // nadie te contó. Así "Gira" deja de ser una promesa y es una demostración.
  //
  // Se reusa el pulso de mentira del demo, que hace la misma coreografía que un
  // pulso de verdad sin mandarle nada a ningún dispositivo. Cambiar de opción
  // repinta la muestra antes de esto, así que cada elección arranca en limpio
  // aunque pases rápido por varias.
  function enseñarLaAnimacion() {
    const conFoto = ASPECTOS_IMAGEN[vestAspecto];
    if (!conFoto || !conFoto.clase) return;   // ese skin no se mueve
    const boton = $('vest-demo').querySelector('.boton-circular');
    if (boton) pulsarDemo(boton, vestDisp);
  }

  // El aspecto que el servidor tiene guardado para este dispositivo — no lo que
  // se está probando.
  function aspectoGuardado() {
    if (!vestDisp) return null;
    return (usuarioActual && usuarioActual.aspectos && usuarioActual.aspectos[vestDisp.id])
      || vestDisp.aspecto || 'normal';
  }

  // El botón solo se enciende cuando hay algo que guardar. Apagado dice "esto ya
  // es lo tuyo", que es justo la seguridad que faltaba.
  function refrescarBotonEstilo() {
    const b = $('btn-guardar-estilo');
    if (!b) return;
    // Sin nada que vestir el botón se va entero: un "Guardado" apagado debajo
    // de un hueco dice que se guardó algo, y no hay nada.
    b.classList.toggle('oculto', !vestDisp);
    const hayCambio = Boolean(vestDisp) && vestAspecto !== aspectoGuardado();
    b.disabled = !hayCambio;
    if (!b.dataset.ocupado) b.textContent = hayCambio ? 'Guardar' : 'Guardado';
  }

  // Al centrar otra opción deslizando el carrusel.
  // `paraId` = el dispositivo que estaba puesto cuando el carrusel se asentó.
  // Si mientras se esperaban los 140 ms cambiaste de dispositivo, esta decisión
  // ya no es de nadie: escribirla le pondría al NUEVO el aspecto del anterior
  // (así el búnker acabó con el skin de una luz).
  // "Estilo guardado" bajo la rejilla: se enseña solo cuando el servidor YA
  // confirmó, que es lo que la línea promete. Si vuelves a elegir antes de que se
  // desvanezca, el temporizador se reinicia en vez de encadenar avisos.
  let vestAvisoTimer = null;
  function avisarEstiloGuardado() {
    const el = $('vest-guardado');
    if (!el) return;
    el.classList.add('visible');
    clearTimeout(vestAvisoTimer);
    vestAvisoTimer = setTimeout(() => el.classList.remove('visible'), 1800);
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
        return;
      }
      avisarEstiloGuardado();
    } catch (err) {
      toast('No se pudo guardar el estilo.', 'error');
    }
  }

  // El acto de guardar. Se deja el botón en "Guardando…" mientras va, para que
  // no parezca que el toque no hizo nada, y en "Guardado" al volver.
  $('btn-guardar-estilo').addEventListener('click', async () => {
    if (!vestDisp || !vestAspecto) return;
    const b = $('btn-guardar-estilo');
    b.dataset.ocupado = '1';
    b.disabled = true;
    b.textContent = 'Guardando…';
    try {
      await guardarAspecto(vestDisp.id, vestAspecto);
    } finally {
      delete b.dataset.ocupado;
      refrescarBotonEstilo();
    }
  });

  $('btn-editar-skin').addEventListener('click', () => {
    const caja = $('vest-editor');
    if (!caja.classList.contains('oculto')) { cerrarEditorSkin(); return; }
    const s = skinElegido();
    if (!puedoEditarSkin(s)) return;

    animacionOriginal = { id: s.id, clase: (ASPECTOS_IMAGEN[s.id] || {}).clase };
    caja.textContent = '';
    const ed = editorDeSkin(s, msgEditorSkin, (valor) => {
      // Se prueba en la muestra de verdad, que está justo encima: el mismo
      // botón, del tamaño real, moviéndose como se movería al abrir la puerta.
      const anim = ANIMACIONES_SKIN[valor] || ANIMACIONES_SKIN.ninguna;
      if (ASPECTOS_IMAGEN[s.id]) ASPECTOS_IMAGEN[s.id].clase = anim.clase;
      pintarDemoVestuario();
      enseñarLaAnimacion();
    }, cerrarEditorSkin);
    caja.appendChild(ed);
    // Guardar sube al hueco donde estaba "Editar diseño", pegado a la muestra;
    // abajo se quedan las de voz baja (cancelar, borrar, curar).
    ed.botonGuardar.classList.add('vest-guardar-skin');
    caja.before(ed.botonGuardar);
    caja.classList.remove('oculto');
    // La galería, el Guardar del aspecto y el propio "Editar diseño" se
    // apartan: editando, lo único que importa es la muestra de arriba y el
    // formulario, y la salida vive dentro del formulario (Cancelar).
    $('vestuario').classList.add('editando');
    $('btn-editar-skin').classList.add('oculto');
    // Y se recoge el taller. Vive en una tarjeta HERMANA, fuera de `#vestuario`,
    // así que la regla de `editando` no lo alcanza: si lo habías abierto antes
    // con "Diseña Uno", su lista —con la miniatura de cada botón tuyo— se
    // quedaba justo debajo del editor. Editas uno; los demás sobran.
    $('seccion-crear-skin').classList.add('oculto');
    $('vest-demo').scrollIntoView({ block: 'start', behavior: 'smooth' });
  });

  $('vest-disp').addEventListener('change', (e) => {
    const d = dispConAspectos().find((x) => x.id === e.target.value);
    if (!d) return;
    vestDisp = d;
    vestAspecto = aspectoDe(d);
    pintarDemoVestuario();
    pintarOpcionesVestuario();
    // Cada dispositivo tiene su propio estilo guardado: al cambiar de uno a
    // otro el botón vuelve a decir la verdad de ESTE.
    refrescarBotonEstilo();
    refrescarEditorSkin();
  });
  // Tocar una opción la elige. Punto. Antes esto convivía con elegir-por-scroll
  // —el carrusel decidía al asentarse— y de esa convivencia salieron tres bugs:
  // un toque que no hacía nada si el carrusel no llegaba a moverse, y un
  // repintado que ESCRIBÍA en Firestore porque su propio scroll se tomaba por
  // una elección. Con rejilla solo hay una manera de elegir.
  $('vest-opciones').addEventListener('click', (e) => {
    const b = e.target.closest('.skin-op');
    if (!b) return;
    b.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    if (!b.dataset.aspecto) { abrirCreador(); return; }   // la ficha de fabricar
    seleccionarAspecto(b.dataset.aspecto);
  });

  // Aparece el taller y baja hasta él.
  //
  // La tarjeta entera nace oculta: antes estaba siempre ahí abajo, plegada bajo
  // un "Crear un botón" que competía con la ficha del carrusel — dos puertas al
  // mismo sitio en la misma pantalla. Ahora la única puerta es "Diseñar botón",
  // y esta tarjeta es a dónde lleva.
  function abrirCreador() {
    cerrarEditorSkin();   // uno u otro, no los dos abiertos a la vez
    $('seccion-crear-skin').classList.remove('oculto');
    const form = $('form-skin');
    if (form.classList.contains('oculto')) $('btn-toggle-skin').click();
    $('seccion-crear-skin').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  // ---- Crear un skin con IA (solo admin) ----
  // La imagen la procesa el NAVEGADOR, no la función: recortar y comprimir en
  // el servidor obligaría a meter sharp (dependencia nativa pesada) y a que la
  // función arrastre ese arranque en frío por algo que se usa muy de vez en
  // cuando. Aquí es un canvas y ya.
  const adminSkins = httpsCallable(functions, 'adminSkins');
  const ajusteTuya = httpsCallable(functions, 'ajusteTuya');
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
  // El tope del servidor (`MAX_IMAGEN_SKIN`), con un margen: se comprueba aquí
  // para no gastar un viaje en algo que va a rebotar.
  const TOPE_IMAGEN = 210000;

  function lienzoDelRecorte(lado) {
    const t = recBase * recEsc;                       // imagen -> pantalla
    const medio = (CAJA_PREVIA / 2) / t;              // medio lado, en px de imagen
    const cx = recImg.naturalWidth / 2 - recDx / t;
    const cy = recImg.naturalHeight / 2 - recDy / t;
    const c = document.createElement('canvas');
    c.width = lado; c.height = lado;
    c.getContext('2d').drawImage(recImg, cx - medio, cy - medio, medio * 2, medio * 2, 0, 0, lado, lado);
    return c;
  }

  // ⚠️ `toDataURL` con un formato que el navegador no sabe escribir NO falla:
  // devuelve un PNG en silencio y se traga la calidad. Safari solo encodea WebP
  // desde la 16.4, así que en un iPhone de antes esto salía en PNG — y un PNG
  // de 256px de un dibujo con mucho detalle pesa diez veces más que su WebP y
  // se pasaba del tope del servidor. El vecino solo veía "La imagen pesa
  // demasiado" al guardar, sin nada que pudiera hacer al respecto.
  //
  // Así que no se confía en lo que se pidió: se mira lo que VOLVIÓ. Y si aun
  // así no cabe, se baja la calidad y por último el tamaño, en vez de mandarlo
  // y que reboten.
  function recorteImagen(lado = 256) {
    const c = lienzoDelRecorte(lado);
    let d = c.toDataURL('image/webp', 0.86);
    // JPEG y no PNG: es el que sabe TODO navegador y, en fotos y dibujos, el
    // que se acerca al WebP. Caer al PNG es justo lo que rompía esto.
    if (!d.startsWith('data:image/webp')) d = c.toDataURL('image/jpeg', 0.86);
    if (d.length <= TOPE_IMAGEN) return d;

    const tipo = d.slice(11, d.indexOf(';'));
    for (const q of [0.7, 0.55, 0.4]) {
      d = c.toDataURL(`image/${tipo}`, q);
      if (d.length <= TOPE_IMAGEN) return d;
    }
    // Último recurso: menos píxeles. 192 sigue viéndose bien en un botón de
    // 168px, que es lo más grande que se pinta.
    for (const menor of [224, 192]) {
      d = lienzoDelRecorte(menor).toDataURL(`image/${tipo}`, 0.7);
      if (d.length <= TOPE_IMAGEN) return d;
    }
    return d;   // que lo rechace el servidor; aquí ya no hay más que apretar
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
      // Cada imagen se paga, así que el cupo del día se dice DESPUÉS de gastarlo,
      // cuando la cifra ya es real. `restantes` viene null para el admin, que no
      // tiene tope.
      if (typeof d.restantes === 'number') {
        msgSkin(d.restantes > 0
          ? `Te quedan ${d.restantes} generaciones hoy.`
          : 'Era tu última generación de hoy. Mañana tienes más, y subir una foto no gasta cupo.');
      }
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
        imagen: recorteImagen(),
        animacion: $('skin-animacion').value,
        tipos: tiposElegidos($('skin-tipos')),
        prompt: $('skin-prompt').value.trim(),
      });
      recImg = null;
      $('skin-previa').classList.add('oculto');
      $('skin-prompt').value = '';
      $('skin-nombre').value = '';
      pintarChipsTipos($('skin-tipos'), null);
      msgSkin(usuarioActual && usuarioActual.rol === 'admin'
        ? 'Publicado. Ya se puede elegir en el Locker.'
        : 'Listo, ya puedes elegirlo aquí abajo. Es tuyo: nadie más lo ve hasta que el administrador lo publique en la galería.');
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
  // El editor de un diseño: nombre, animación, para qué sirve, y sus acciones.
  //
  // Vive aparte porque lo usan DOS sitios: la lista del taller y la propia
  // galería, al tener elegido un diseño tuyo. Antes solo existía en la lista, o
  // sea que para cambiarle el nombre a un botón había que abrir el taller de
  // fabricar y buscarlo ahí abajo — abrir "haz uno nuevo" para editar el que ya
  // tienes puesto.
  //
  // `avisar` lo pone quien lo usa, y no es un detalle: los mensajes de la lista
  // van a `#skin-msg`, que vive DENTRO del taller. Desde la galería, con el
  // taller recogido, un "no se pudo guardar" se escribiría donde nadie lo ve.
  function editorDeSkin(s, avisar, alCambiarAnimacion, alCancelar) {
    const editor = document.createElement('div');
    editor.className = 'skin-editor';
    editor.innerHTML = '<label class="campo-perfil">Nombre'
      + `<input type="text" class="ed-nombre" maxlength="24" value="${escapar(s.nombre)}"></label>`
      + '<label class="campo-perfil">Al activarse<select class="ed-animacion">'
      + Object.values(ANIMACIONES_SKIN).map((a) =>
        `<option value="${a.id}"${a.id === (s.animacion || 'ninguna') ? ' selected' : ''}>${a.nombre}</option>`).join('')
      + '</select></label>'
      + '<div class="campo-perfil">Para<div class="skin-tipos ed-tipos"></div></div>';
    pintarChipsTipos(editor.querySelector('.ed-tipos'), s.tipos);
    // "Al activarse" nombra un movimiento, y un nombre no es el movimiento.
    // Quien lo use puede enseñarlo en la muestra en cuanto se elija.
    if (alCambiarAnimacion) {
      editor.querySelector('.ed-animacion')
        .addEventListener('change', (e) => alCambiarAnimacion(e.target.value));
    }

    const soyAdmin = usuarioActual && usuarioActual.rol === 'admin';
    const pendiente = s.publico === false;

    const acciones = document.createElement('div');
    acciones.className = 'skin-acciones';

    // Una sola acción con cuerpo —guardar— y el resto como texto callado. Antes
    // "Guardar cambios", "Borrar" y "Quitar de la galería" competían en la
    // misma fila con el mismo peso, y encima había un "Listo" arriba que se
    // leía igual de terminal que guardar.
    const menores = document.createElement('div');
    menores.className = 'skin-acciones-menores';

    const guardar = document.createElement('button');
    guardar.type = 'button';
    guardar.className = 'btn-secundario';
    // "Guardar cambios" y no "Guardar": en la galería este botón convive con el
    // Guardar del aspecto (el que te lo pone), y dos "Guardar" a la vista
    // obligan a adivinar cuál hace qué.
    guardar.textContent = 'Guardar cambios';
    guardar.addEventListener('click', async () => {
      const nombre = editor.querySelector('.ed-nombre').value.trim();
      if (!nombre) { avisar('Ponle un nombre.', true); return; }
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
        avisar('Guardado.');
      } catch (err) {
        avisar((err && err.message) || 'No se pudo guardar.', true);
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
        avisar((err && err.message) || 'No se pudo borrar.', true);
        borrar.disabled = false;
      }
    });
    acciones.appendChild(guardar);
    // Salir SIN guardar. Se llama Cancelar y no "Listo": lo que hace es
    // descartar, y "Listo" prometía lo mismo que el botón de guardar.
    if (alCancelar) {
      const cancelar = document.createElement('button');
      cancelar.type = 'button';
      cancelar.className = 'btn-quieto';
      cancelar.textContent = 'Cancelar';
      cancelar.addEventListener('click', alCancelar);
      menores.appendChild(cancelar);
    }
    menores.appendChild(borrar);

    // Curaduría, solo para el admin: abrir el botón de un vecino a la galería o
    // retirarlo. Retirar NO borra: su autor lo sigue usando.
    if (soyAdmin) {
      const publicar = document.createElement('button');
      publicar.type = 'button';
      publicar.className = 'btn-quieto';
      publicar.textContent = pendiente ? 'Publicar en la galería' : 'Quitar de la galería';
      publicar.addEventListener('click', async () => {
        publicar.disabled = true;
        try {
          await adminSkins({ accion: 'aprobar', id: s.id, publico: pendiente });
          await refrescarSkins();
          avisar(pendiente ? 'Publicado en la galería.' : 'Retirado de la galería.');
        } catch (err) {
          avisar((err && err.message) || 'No se pudo cambiar.', true);
          publicar.disabled = false;
        }
      });
      menores.appendChild(publicar);
    }
    acciones.appendChild(menores);
    editor.appendChild(acciones);
    // Se expone para que la galería pueda SUBIRLO al hueco de "Editar diseño":
    // es la acción principal y ahí es donde ya está la mano. Mover el nodo se
    // lleva sus listeners con él; no hay que volver a atar nada.
    editor.botonGuardar = guardar;
    return editor;
  }

  // Un vecino solo administra LO SUYO: ofrecerle el botón de otro para que el
  // backend se lo niegue sería enseñar una puerta cerrada. El admin lo ve todo,
  // que es como cura la galería.
  function puedoEditarSkin(s) {
    if (!s) return false;
    if (usuarioActual && usuarioActual.rol === 'admin') return true;
    return Boolean(usuarioActual && s.autor === usuarioActual.uid);
  }

  function pintarListaSkins() {
    const cont = $('skin-lista');
    cont.textContent = '';
    const mios = skinsGaleria.filter(puedoEditarSkin);
    if (!mios.length) return;
    for (const s of mios) {
      const caja = document.createElement('div');
      caja.className = 'skin-item';

      const fila = document.createElement('div');
      fila.className = 'skin-fila';
      // "Esperando" es el estado normal de un botón recién hecho por un vecino:
      // ya lo puede usar, lo que falta es que el admin lo abra a los demás.
      fila.innerHTML = `<img src="${s.imagen}" alt=""><span>${escapar(s.nombre)}</span>`
        + (s.publico === false ? '<span class="skin-estado">esperando</span>' : '');

      const editor = editorDeSkin(s, msgSkin);
      editor.classList.add('oculto');
      fila.addEventListener('click', () => editor.classList.toggle('oculto'));
      caja.append(fila, editor);
      cont.appendChild(caja);
    }
  }

  // Buscar vecino: filtra sin volver a leer Firestore (ya está todo en caché).
  $('buscar-gestion').addEventListener('input', renderGestion);
  $('btn-vecinos-lote').addEventListener('click', () => abrirEditorVecinosLote());

  // Vincular la cuenta Tuya del propio vecino (OAuth). Se abre la página de
  // Tuya, él elige qué dispositivos comparte, y vuelve al callback del backend.
  const vincularTuya = httpsCallable(functions, 'vincularTuya');
  $('btn-vincular-tuya').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    const orig = b.textContent;
    b.textContent = 'Abriendo…';
    try {
      const r = await vincularTuya({});
      // Se abre en otra pestaña: si volviera en la misma, la PWA instalada
      // perdería el estado y el vecino acabaría fuera de la app.
      window.open(r.data.url, '_blank', 'noopener');
      $('tuya-msg').textContent = 'Autoriza en la ventana de Tuya y vuelve aquí.';
    } catch (err) {
      $('tuya-msg').textContent = (err && err.message) || 'No se pudo abrir Tuya.';
    } finally {
      b.disabled = false;
      b.textContent = orig;
    }
  });

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
    if (usuarioActual.rol === 'admin') return misDispositivos;
    // Lo suyo explícito MÁS lo que hereda de su inmueble. Esto último faltaba
    // desde que el inmueble empezó a dar acceso: un vecino con su apartamento
    // asignado y sin dispositivos sueltos se quedaba sin la pestaña de Pases
    // entera, aunque el backend sí le dejaba compartir. Lo recibido POR un pase
    // no se re-comparte, igual que en `puedeCompartir()` del servidor.
    const mios = new Set(usuarioActual.dispositivos || []);
    const heredados = usuarioActual.inmueblesIds || [];
    return misDispositivos.filter((d) => mios.has(d.id)
      || (d.inmueble && heredados.includes(d.inmueble)));
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

  // Cuándo empieza el pase, en milisegundos. `null` = ya.
  //
  // `datetime-local` da una hora SIN zona, y el navegador la interpreta en la
  // del teléfono — que es justo lo que quiere quien la escribe: "a las 8 de la
  // noche" es su 8 de la noche. Al servidor va como milisegundos absolutos, así
  // que no hay ambigüedad después.
  function desdeElegido() {
    if (!$('pase-cuando').querySelector('[data-cuando="luego"]').classList.contains('activa')) return null;
    const v = $('pase-desde').value;
    if (!v) return null;
    const ms = new Date(v).getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  // La fecha elegida, escrita en español. El campo nativo la enseña en el
  // idioma del teléfono y no se puede forzar; esta línea sí es nuestra.
  function decirDesde() {
    const el = $('pase-desde-dicho');
    const v = $('pase-desde').value;
    const ms = v ? new Date(v).getTime() : NaN;
    if (!Number.isFinite(ms)) { el.textContent = 'Elige la fecha'; return; }
    const f = new Date(ms);
    const dia = f.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });
    const hora = f.toLocaleTimeString('es', { hour: 'numeric', minute: '2-digit' });
    el.textContent = `${dia.charAt(0).toUpperCase()}${dia.slice(1)} a las ${hora}`;
  }
  $('pase-desde').addEventListener('input', decirDesde);
  $('pase-desde').addEventListener('change', decirDesde);

  $('pase-cuando').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cuando]');
    if (!b) return;
    $('pase-cuando').querySelectorAll('[data-cuando]').forEach((x) => x.classList.toggle('activa', x === b));
    const programado = b.dataset.cuando === 'luego';
    $('pase-desde-caja').classList.toggle('oculto', !programado);
    // Se propone dentro de una hora, redondeado: es lo más cercano a "no ahora"
    // y evita que el campo arranque vacío, que obliga a teclearlo todo.
    if (programado && !$('pase-desde').value) {
      const t = new Date(Date.now() + 3600000);
      t.setMinutes(0, 0, 0);
      $('pase-desde').value = new Date(t.getTime() - t.getTimezoneOffset() * 60000)
        .toISOString().slice(0, 16);
    }
    decirDesde();
  });

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
        uids: aQuienes, dispositivos: seleccion, duracion: paseDuracionSel, evento, desde: desdeElegido(),
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
      const res = await crearPase({ dispositivos: seleccion, duracion: paseDuracionSel, multiuso, evento, desde: desdeElegido() });
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
      // Se piden más de las que se enseñan: al descartar el ruido de los
      // aparatos sin registro, con 30 se quedaba corto.
      const resultado = alc.length
        ? await getDocs(query(collection(db, 'registros'),
            where('inmueble', 'in', alc.slice(0, 30)), orderBy('fecha', 'desc'), limit(120)))
        : await getDocs(query(collection(db, 'registros'), orderBy('fecha', 'desc'), limit(120)));
      if (resultado.empty) {
        const item = document.createElement('li');
        item.textContent = 'Sin actividad todavía.';
        lista.appendChild(item);
        return;
      }
      // Quién fue vive en `privado/quien` y solo el dueño puede leerlo. Se
      // piden en paralelo; el admin de edificio ni lo intenta y verá la
      // actividad sin identificar a nadie, que es justo la intención.
      // El historial de lo que hoy NO se registra tampoco se enseña: si el
      // admin apagó el registro de un aire, no quiere ver el ruido de antes.
      const mudos = new Set(cacheDispositivos.filter((d) => !seRegistra(d)).map((d) => d.id));
      const docs = resultado.docs.filter((d) => !mudos.has(d.data().dispositivoId)).slice(0, 30);
      if (!docs.length) {
        const item = document.createElement('li');
        item.textContent = 'Sin actividad todavía.';
        lista.appendChild(item);
        return;
      }
      const quienes = new Map();
      if (!miAlcance().length) {
        const lecturas = await Promise.all(docs.map((d) =>
          getDoc(doc(db, 'registros', d.id, 'privado', 'quien')).catch(() => null)));
        lecturas.forEach((snap, i) => {
          if (snap && snap.exists()) quienes.set(docs[i].id, snap.data());
        });
      }
      for (const registro of docs) {
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
