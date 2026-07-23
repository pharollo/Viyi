// El ?v= va aquí y no en index.html porque este archivo se importa como módulo.
// Sin él se queda pegado en el caché del CDN (4 h) aunque app.js sí se renueve:
// pasó al cambiar el authDomain a auth.viyi.ai. Súbelo junto con el de
// index.html cada vez que cambie firebase-config.js.
import { firebaseConfig, FUNCTIONS_REGION, NOMBRE_CONDOMINIO } from './firebase-config.js?v=174';

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
      return w.charAt(0).toLocaleUpperCase() + w.slice(1);
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
      // Con un enlace de pase: pedir el correo primero (email-first) y según si
      // ya tiene cuenta, mostrar login o crear cuenta. Si no, login normal.
      mostrarVista(paseTokenPendiente ? 'vista-email' : 'vista-login');
      // El "Volver" solo tiene sentido llegando con un pase: es lo único que
      // muestra la pantalla del correo antes. Al vecino fijo, que entra directo
      // al login, no hay adónde devolverlo.
      $('btn-volver-login').classList.toggle('oculto', !paseTokenPendiente);
      $('btn-volver-reg').classList.toggle('oculto', !paseTokenPendiente);
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
    const cacheKey = `viyi-disp-${user.uid}`;
    let yaEnPanel = false;
    if (!paseTokenPendiente) {
      try {
        const guardado = JSON.parse(localStorage.getItem(cacheKey) || 'null');
        if (guardado && guardado.usuario && Array.isArray(guardado.dispositivos)) {
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
      const dispositivos = await cargarDispositivos(usuario);
      // Repinta con lo fresco (idempotente); solo cambia de vista si no venía
      // ya pintado desde la caché, para no sacar al usuario de otra pestaña.
      pintarControles(usuario, dispositivos, !yaEnPanel);
      // Guardar para el próximo arranque instantáneo.
      try {
        localStorage.setItem(cacheKey, JSON.stringify({ usuario, dispositivos }));
      } catch (e) { /* almacenamiento lleno o bloqueado: no es crítico */ }

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
      } else {
        // No tiene cuenta: a crear cuenta (correo precargado).
        $('reg-email').value = email;
        mostrarVista('vista-registro');
        $('reg-nombre').focus();
      }
    } catch (err) {
      if (err && err.code === 'functions/not-found') {
        error.textContent = 'El enlace no es válido.';
        error.classList.remove('oculto');
      } else {
        // No se pudo verificar (función no disponible u otro fallo): no
        // bloqueamos al invitado; lo llevamos a crear cuenta con el correo.
        // Si ya existe, createUser avisa y "Ya tengo cuenta" lo lleva al login.
        $('reg-email').value = email;
        mostrarVista('vista-registro');
        $('reg-nombre').focus();
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
      const resultado = await getDocs(
        query(collection(db, 'dispositivos'), where('activo', '==', true))
      );
      documentos = resultado.docs;
    } else {
      const ids = new Set(usuario.dispositivos || []);
      // Dispositivos compartidos por pases vigentes (no vencidos).
      const ahora = Date.now();
      for (const [id, info] of Object.entries(usuario.accesos || {})) {
        if (msExpira(info && info.expira) > ahora) ids.add(id);
      }
      const lecturas = await Promise.all([...ids].map((id) => getDoc(doc(db, 'dispositivos', id))));
      documentos = lecturas.filter((s) => s.exists() && s.data().activo !== false);
    }
    return documentos
      .map((s) => normalizar({ id: s.id, ...s.data() }))
      .sort((a, b) => (a.orden || 99) - (b.orden || 99));
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
      mostrarTab('tab-controles');
      mostrarVista('vista-panel');
    }
  }

  // Dimmer a lo ancho, con slider HORIZONTAL. Va fuera del carrusel (que scrollea
  // horizontal) y usa gesto horizontal, que no pelea ni con el carrusel ni con el
  // gesto vertical de inicio de iOS — por eso no necesita zona muerta abajo.
  function controlDimmer(dispositivo) {
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
      if (enviando) return;
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

    (async () => {
      try {
        const res = await consultarEstado({ dispositivoId: dispositivo.id });
        const d = res.data || {};
        if (typeof d.brillo === 'number') pintar(d.brillo);
        const mem = typeof d.brilloMemoria === 'number' ? d.brilloMemoria : d.brillo;
        if (typeof mem === 'number' && mem > 0) ultimoBrillo = mem;
      } catch (err) { /* sin estado disponible */ }
    })();

    return cont;
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
      const enCarrusel = grupo.filter((d) => d.modo !== 'dimmer');
      const dimmers = grupo.filter((d) => d.modo === 'dimmer');
      if (enCarrusel.length) {
        const fila = document.createElement('div');
        fila.className = 'grupo-controles carrusel';
        for (const dispositivo of enCarrusel) {
          fila.appendChild(tarjetaDispositivo(dispositivo));
        }
        contenedor.appendChild(fila);
        activarCarrusel(fila);
      }
      for (const dispositivo of dimmers) {
        contenedor.appendChild(controlDimmer(dispositivo));
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
  function controlJet(dispositivo) {
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
    async function disparar() {
      ir(2);
      momentaryTimer = setTimeout(() => { ir(1); momentaryTimer = null; }, 1000);
      if (enviando) return;
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

  function tarjetaDispositivo(dispositivo) {
    // Puerta de pulso con aspecto Jet: interruptor con tapa de seguridad.
    if (dispositivo.modo === 'pulso' && dispositivo.aspecto === 'jet') {
      return controlJet(dispositivo);
    }
    const control = document.createElement('div');
    control.className = 'control';
    let boton;
    if (dispositivo.modo === 'pulso') {
      const anillo = document.createElement('div');
      anillo.className = 'anillo';
      boton = document.createElement('button');
      boton.type = 'button';
      if (dispositivo.aspecto === 'argentina') {
        // Aspecto Argentina: escudo de la selección como logo del botón (imagen).
        boton.className = 'boton-circular grande boton-imagen';
        boton.innerHTML = '<img src="argentina.jpg?v=1" alt="" class="boton-logo">';
      } else {
        const iconoSub = ICONO_SUBTIPO[dispositivo.subtipo];
        const iconoCuadrado = !!iconoSub || dispositivo.tipo === 'ascensor';
        boton.className = 'boton-circular grande' + (iconoCuadrado ? ' cuadrado' : '');
        boton.innerHTML = iconoSub ? ICONOS[iconoSub]
          : (dispositivo.tipo === 'ascensor' ? ICONOS.ascensor : ICONOS.candados);
      }
      boton.setAttribute('aria-label', `${dispositivo.etiquetaBoton || 'Abrir'} ${dispositivo.nombre}`);
      boton.addEventListener('click', () => pulsar(boton, dispositivo));
      nombreEnBoton(boton, dispositivo.nombre);
      anillo.appendChild(boton);
      control.appendChild(anillo);
    } else if (dispositivo.modo === 'cortina') {
      control.appendChild(perillaCortina(dispositivo));
    } else if (dispositivo.modo === 'dimmer') {
      control.appendChild(perillaDimmer(dispositivo));
    } else if (dispositivo.modo === 'termostato') {
      control.appendChild(perillaTermostato(dispositivo));
    } else {
      boton = document.createElement('button');
      boton.type = 'button';
      boton.className = 'boton-circular medio';
      boton.innerHTML = ICONO_SUBTIPO[dispositivo.subtipo]
        ? ICONOS[ICONO_SUBTIPO[dispositivo.subtipo]]
        : (ICONOS[dispositivo.tipo] || ICONOS.otro);
      boton.setAttribute('aria-label', `Encender o apagar ${dispositivo.nombre}`);
      boton.addEventListener('click', () => alternar(boton, dispositivo));
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
    if (boton && dispositivo.modo !== 'pulso') {
      estadoInicial(boton, dispositivo);
    }
    return control;
  }

  // Refleja el estado on/off en el botón y en su etiqueta de texto.
  function pintarEstado(boton, encendido) {
    boton.classList.toggle('activo', encendido);
    boton.setAttribute('aria-pressed', encendido ? 'true' : 'false');
  }

  async function pulsar(boton, dispositivo) {
    if (boton.classList.contains('enviando')) return;
    boton.classList.add('enviando');
    try {
      await ejecutarComando({ dispositivoId: dispositivo.id });
      boton.classList.add('exito');
      // El portón anima la apertura (luz que sube ×3); necesita más tiempo.
      const duracionExito = dispositivo.subtipo === 'porton' ? 5000 : 1500;
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

  function perillaCortina(dispositivo) {
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
      if (enviando) return;
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

    (async () => {
      try {
        const res = await consultarEstado({ dispositivoId: dispositivo.id });
        if (res.data && typeof res.data.posicion === 'number') pintar(res.data.posicion);
      } catch (err) { /* sin estado disponible */ }
    })();

    return perilla;
  }

  // Perilla de termostato: se arrastra para fijar la temperatura objetivo,
  // muestra la actual, y tocar el centro enciende (frío) o apaga.
  const TERMO_MIN = 10;
  const TERMO_MAX = 32;
  function perillaTermostato(dispositivo) {
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
      if (enviando) return;
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

    (async () => {
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

  async function cargarGestion() {
    try {
      const [dispSnap, usuSnap, inmSnap] = await Promise.all([
        getDocs(collection(db, 'dispositivos')),
        getDocs(collection(db, 'usuarios')),
        getDocs(collection(db, 'inmuebles')),
      ]);
      cacheDispositivos = dispSnap.docs
        .map((s) => normalizar({ id: s.id, ...s.data() }))
        .sort((a, b) => (a.orden || 99) - (b.orden || 99));
      cacheUsuarios = usuSnap.docs
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

    const lu = $('gestion-usuarios');
    lu.textContent = '';
    for (const u of cacheUsuarios) {
      const inm = (u.inmuebles || []).map((x) => x.nombre).join(', ');
      const partes = [nombreCompleto(u), inm, u.rol === 'admin' ? 'admin' : null].filter(Boolean);
      const fila = filaGestion(partes.join(' · '), u.activo === false, () => abrirEditorUsuario(u));
      fila.dataset.uid = u.uid; // para colgarle después cómo entra
      lu.appendChild(fila);
    }
  }

  // Marca cómo entra cada vecino: con Google, con clave, o las dos. El dato
  // vive en Firebase Auth, así que se pide aparte y se pinta al llegar.
  async function pintarProveedores() {
    let mapa;
    try {
      const res = await adminProveedores();
      mapa = (res.data && res.data.proveedores) || {};
    } catch (err) { return; }
    for (const [uid, provs] of Object.entries(mapa)) {
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
    const sAspecto = selector([['normal', 'Normal'], ['jet', 'Jet Switch (tapa de seguridad)'], ['argentina', 'Argentina (escudo)']], d.aspecto || 'normal');
    const campoAspecto = campo('Aspecto', sAspecto);
    const actualizarSub = () => {
      campoSub.classList.toggle('oculto', sTipo.value !== 'puerta');
      campoAspecto.classList.toggle('oculto', !(sTipo.value === 'puerta' && sModo.value === 'pulso'));
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

  function abrirEditorInmueble(existente) {
    const esNuevo = !existente;
    const inm = existente || {};
    const sTipo = selector(Object.entries(TIPO_INMUEBLE_TXT), inm.tipo || 'edificio');
    const iNombre = entrada(inm.nombre, 'ej: Torre A, Casa 12');
    const iCiudad = entrada(inm.ciudad);
    const iEstado = entrada(inm.estado);
    const iZona = entrada(inm.zona);
    [iNombre, iCiudad, iEstado, iZona].forEach((i) => i.setAttribute('autocapitalize', 'words'));
    const filas = [
      campo('Tipo', sTipo),
      campo('Nombre', iNombre),
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

    const filas = [
      campo('Nombre', iNombre),
      campo('Apellido', iApellido),
      campo('Correo electrónico', iEmail),
      campo(esNuevo ? 'Contraseña' : 'Nueva contraseña (opcional)', iPass),
      campo('Rol', sRol),
    ];
    if (!esNuevo) filas.push(cActivo.label);
    filas.push(campo('Inmuebles', casInm.cont));
    filas.push(campo('Dispositivos permitidos (el admin ve todos)', casillas.cont));

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
  function mostrarTab(id) {
    PANELES_TAB.forEach((t) => $(t).classList.toggle('oculto', t !== id));
    document.querySelectorAll('.item-menu').forEach((p) => {
      p.classList.toggle('activa', p.dataset.tab === id);
    });
  }

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
      mostrarTab(p.dataset.tab);
      if (p.dataset.tab === 'tab-pases') prepararGeneradorPases();
      cerrarMenu();
    });
  });

  // Clic en el logo "ViYi" -> volver a Controles desde cualquier vista.
  const irInicio = () => { mostrarTab('tab-controles'); cerrarMenu(); };
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
  // Duración del pase como stepper − / +: se recorre una lista ordenada, del
  // más corto al indefinido. Los tokens deben coincidir con DURACIONES_MS del
  // backend (crearPase / darAcceso).
  const DUR_PASOS = [
    ['30m', '30 min'], ['1h', '1 h'], ['2h', '2 h'], ['3h', '3 h'],
    ['6h', '6 h'], ['12h', '12 h'], ['24h', '24 h'],
    ['2d', '2 d'], ['3d', '3 d'], ['7d', '7 d'], ['indef', 'Indefinido'],
  ];
  let paseDurIdx = DUR_PASOS.findIndex(([t]) => t === '24h'); // arranca en 24 h
  let paseDuracionSel = DUR_PASOS[paseDurIdx][0];
  function pintarDuracion() {
    paseDuracionSel = DUR_PASOS[paseDurIdx][0];
    $('dur-valor').textContent = DUR_PASOS[paseDurIdx][1];
    $('dur-menos').disabled = paseDurIdx === 0;
    $('dur-mas').disabled = paseDurIdx === DUR_PASOS.length - 1;
  }
  $('dur-menos').addEventListener('click', () => {
    if (paseDurIdx > 0) { paseDurIdx -= 1; pintarDuracion(); }
  });
  $('dur-mas').addEventListener('click', () => {
    if (paseDurIdx < DUR_PASOS.length - 1) { paseDurIdx += 1; pintarDuracion(); }
  });
  pintarDuracion();
  $('btn-generar-pase').addEventListener('click', generarEnlacePase);
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
    for (const d of compartibles) {
      const lab = document.createElement('label');
      lab.className = 'pase-casilla';
      lab.innerHTML = `<input type="checkbox" value="${escapar(d.id)}"><span>${escapar(d.nombre)}</span>`;
      cont.appendChild(lab);
    }
    $('pase-evento').value = '';
    $('pase-resultado').classList.add('oculto');
    cargarMisPases();
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
          + `<span>${escapar(nombre)}</span>`;
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
      const multiuso = $('pase-multiuso').checked;
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
      const resultado = await getDocs(
        query(collection(db, 'registros'), orderBy('fecha', 'desc'), limit(30))
      );
      if (resultado.empty) {
        const item = document.createElement('li');
        item.textContent = 'Sin actividad todavía.';
        lista.appendChild(item);
        return;
      }
      for (const registro of resultado.docs) {
        const r = registro.data();
        const item = document.createElement('li');
        item.className = r.exito ? 'registro-ok' : 'registro-error';
        const fecha = r.fecha && r.fecha.toDate
          ? r.fecha.toDate().toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })
          : '—';
        const motivo = !r.exito && r.detalle ? ` — ${r.detalle}` : '';
        item.textContent = `${fecha} · ${r.usuarioNombre}${r.unidad ? ` (${r.unidad})` : ''} · ${r.dispositivoNombre} · ${r.accion} ${r.exito ? '✓' : '✗'}${motivo}`;
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
