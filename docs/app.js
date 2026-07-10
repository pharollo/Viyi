import { firebaseConfig, FUNCTIONS_REGION, NOMBRE_CONDOMINIO } from './firebase-config.js';

const $ = (id) => document.getElementById(id);
const VISTAS = ['vista-cargando', 'vista-config', 'vista-login', 'vista-sin-acceso', 'vista-panel'];

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
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
  const {
    getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut, sendPasswordResetEmail,
  } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
  const {
    getFirestore, doc, getDoc, collection, query, where, orderBy, limit, getDocs,
  } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
  const { getFunctions, httpsCallable } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const functions = getFunctions(app, FUNCTIONS_REGION);
  const ejecutarComando = httpsCallable(functions, 'ejecutarComando');
  const consultarEstado = httpsCallable(functions, 'consultarEstado');
  const adminCrearUsuario = httpsCallable(functions, 'adminCrearUsuario');
  const adminActualizarUsuario = httpsCallable(functions, 'adminActualizarUsuario');
  const adminGuardarDispositivo = httpsCallable(functions, 'adminGuardarDispositivo');
  const adminEliminarDispositivo = httpsCallable(functions, 'adminEliminarDispositivo');
  const adminInspeccionarDispositivo = httpsCallable(functions, 'adminInspeccionarDispositivo');

  let usuarioActual = null;

  const TIPOS = [
    { clave: 'puerta', titulo: 'Puertas' },
    { clave: 'cortina', titulo: 'Cortinas y persianas' },
    { clave: 'ascensor', titulo: 'Ascensores' },
    { clave: 'luz', titulo: 'Luces' },
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
    porton: '<svg viewBox="0 0 40 40" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 35V11Q6 8.5 8.5 8.5H31.5Q34 8.5 34 11V35"/><line x1="10.5" y1="13.5" x2="29.5" y2="13.5"/><line x1="10.5" y1="16" x2="29.5" y2="16"/><line x1="10.5" y1="18.5" x2="29.5" y2="18.5"/><line x1="10.5" y1="21" x2="29.5" y2="21"/><path d="M9.5 30V28.6Q9.5 28 10.2 28L15.3 27.8L18 24.4Q18.4 24 19.1 24H22.9Q23.6 24 24 24.5L25.9 27.8L30 28Q30.5 28.1 30.5 28.7V30Z"/><circle cx="14.5" cy="30.6" r="2.1"/><circle cx="25.5" cy="30.6" r="2.1"/></svg>',
    rele: '<svg viewBox="0 0 40 40" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M20 5v14"/><path d="M28.8 11a12 12 0 1 1-17.6 0"/></svg>',
    otro: '<svg viewBox="0 0 40 40" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M20 5v14"/><path d="M28.8 11a12 12 0 1 1-17.6 0"/></svg>',
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
      await sendPasswordResetEmail(auth, email);
      toast('Listo: revisa tu correo para restablecer la clave (mira también spam).', 'ok');
    } catch (err) {
      const mensajes = {
        'auth/invalid-email': 'El email no es válido.',
        'auth/user-not-found': 'No encontramos ese email. Revísalo o contacta al administrador.',
        'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos.',
      };
      toast(mensajes[err.code] || 'No se pudo enviar el correo. Intenta de nuevo.', 'error');
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
      mostrarVista('vista-login');
      return;
    }
    mostrarVista('vista-cargando');
    try {
      const perfilSnap = await getDoc(doc(db, 'usuarios', user.uid));
      if (!perfilSnap.exists() || perfilSnap.data().activo === false) {
        mostrarVista('vista-sin-acceso');
        return;
      }
      const usuario = perfilSnap.data();
      usuarioActual = usuario;
      $('nombre-usuario').textContent = usuario.unidad
        ? `${usuario.nombre} · ${usuario.unidad}`
        : usuario.nombre;
      $('info-usuario').classList.remove('oculto');

      const dispositivos = await cargarDispositivos(usuario);
      renderDispositivos(dispositivos);

      const esAdmin = usuario.rol === 'admin';
      $('btn-menu').classList.remove('oculto');
      document.querySelectorAll('.solo-admin').forEach((el) => el.classList.toggle('oculto', !esAdmin));
      if (esAdmin) {
        cargarGestion();
        cargarRegistros();
      }
      mostrarTab('tab-controles');
      mostrarVista('vista-panel');
    } catch (err) {
      console.error(err);
      toast('Error cargando tus datos. Recarga la página.', 'error');
      mostrarVista('vista-sin-acceso');
    }
  });

  async function cargarDispositivos(usuario) {
    let documentos = [];
    if (usuario.rol === 'admin') {
      const resultado = await getDocs(
        query(collection(db, 'dispositivos'), where('activo', '==', true))
      );
      documentos = resultado.docs;
    } else {
      const ids = usuario.dispositivos || [];
      const lecturas = await Promise.all(ids.map((id) => getDoc(doc(db, 'dispositivos', id))));
      documentos = lecturas.filter((s) => s.exists() && s.data().activo !== false);
    }
    return documentos
      .map((s) => normalizar({ id: s.id, ...s.data() }))
      .sort((a, b) => (a.orden || 99) - (b.orden || 99));
  }

  function renderDispositivos(dispositivos) {
    const contenedor = $('lista-dispositivos');
    contenedor.textContent = '';
    if (!dispositivos.length) {
      const aviso = document.createElement('p');
      aviso.className = 'centrado';
      aviso.textContent = 'No tienes dispositivos asignados. Contacta al administrador.';
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
      const fila = document.createElement('div');
      fila.className = 'grupo-controles carrusel';
      for (const dispositivo of grupo) {
        fila.appendChild(tarjetaDispositivo(dispositivo));
      }
      contenedor.appendChild(fila);
      activarCarrusel(fila);
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

  function tarjetaDispositivo(dispositivo) {
    const control = document.createElement('div');
    control.className = 'control';
    let boton;
    if (dispositivo.modo === 'pulso') {
      const anillo = document.createElement('div');
      anillo.className = 'anillo';
      boton = document.createElement('button');
      boton.type = 'button';
      const iconoSub = ICONO_SUBTIPO[dispositivo.subtipo];
      const iconoCuadrado = !!iconoSub || dispositivo.tipo === 'ascensor';
      boton.className = 'boton-circular grande' + (iconoCuadrado ? ' cuadrado' : '');
      boton.innerHTML = iconoSub ? ICONOS[iconoSub]
        : (dispositivo.tipo === 'ascensor' ? ICONOS.ascensor : ICONOS.candados);
      boton.setAttribute('aria-label', `${dispositivo.etiquetaBoton || 'Abrir'} ${dispositivo.nombre}`);
      boton.addEventListener('click', () => pulsar(boton, dispositivo));
      nombreEnBoton(boton, dispositivo.nombre);
      anillo.appendChild(boton);
      control.appendChild(anillo);
    } else if (dispositivo.modo === 'cortina') {
      const fila = document.createElement('div');
      fila.className = 'fila-cortina';
      const acciones = [
        ['abrir', ICONOS.arriba, 'Abrir'],
        ['detener', ICONOS.stop, 'Detener'],
        ['cerrar', ICONOS.abajo, 'Cerrar'],
      ];
      for (const [accion, icono, texto] of acciones) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'boton-circular chico';
        b.innerHTML = icono;
        b.setAttribute('aria-label', `${texto} ${dispositivo.nombre}`);
        b.addEventListener('click', () => accionCortina(b, dispositivo, accion, texto));
        fila.appendChild(b);
      }
      control.appendChild(fila);
    } else if (dispositivo.modo === 'dimmer') {
      control.appendChild(perillaDimmer(dispositivo));
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
    // Cortina y dimmer llevan el nombre debajo; pulso/interruptor lo llevan dentro.
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
      setTimeout(() => boton.classList.remove('exito'), 1500);
    } catch (err) {
      toast(err.message || 'No se pudo enviar el comando.', 'error');
    } finally {
      boton.classList.remove('enviando');
    }
  }

  async function accionCortina(boton, dispositivo, accion, texto) {
    if (boton.classList.contains('enviando')) return;
    boton.classList.add('enviando');
    try {
      await ejecutarComando({ dispositivoId: dispositivo.id, accion });
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

    let arrastrando = false;
    let cambiado = false;
    let empezoCentro = false;
    const alMover = (e) => {
      if (!arrastrando) return;
      const v = valorDesde(e);
      if (v !== null) { pintar(v, true); cambiado = true; }
      e.preventDefault();
    };
    const alSoltar = () => {
      if (!arrastrando) return;
      arrastrando = false;
      window.removeEventListener('pointermove', alMover);
      window.removeEventListener('pointerup', alSoltar);
      if (cambiado) {
        if (valor > 0) ultimoBrillo = valor;
        enviarBrillo();
      } else if (empezoCentro) {
        // Toque en el centro: apaga (fade out) o enciende al último brillo (fade in).
        const destino = valor > 0 ? 0 : (ultimoBrillo || 100);
        const desde = valor;
        animarA(destino);
        enviarBrillo({ valor: destino, desde, fade: true });
      }
    };
    perilla.addEventListener('pointerdown', (e) => {
      if (animId) { cancelAnimationFrame(animId); animId = null; }
      arrastrando = true;
      cambiado = false;
      const v = valorDesde(e);
      empezoCentro = (v === null);
      if (v !== null) { pintar(v, true); cambiado = true; }
      window.addEventListener('pointermove', alMover);
      window.addEventListener('pointerup', alSoltar);
      e.preventDefault();
    });

    (async () => {
      try {
        const res = await consultarEstado({ dispositivoId: dispositivo.id });
        if (res.data && typeof res.data.brillo === 'number') {
          pintar(res.data.brillo);
          if (res.data.brillo > 0) ultimoBrillo = res.data.brillo;
        }
      } catch (err) { /* sin estado disponible */ }
    })();

    return perilla;
  }

  // ── Gestión (solo admin) ──────────────────────────────────────────────

  let cacheDispositivos = [];
  let cacheUsuarios = [];

  async function cargarGestion() {
    try {
      const [dispSnap, usuSnap] = await Promise.all([
        getDocs(collection(db, 'dispositivos')),
        getDocs(collection(db, 'usuarios')),
      ]);
      cacheDispositivos = dispSnap.docs
        .map((s) => normalizar({ id: s.id, ...s.data() }))
        .sort((a, b) => (a.orden || 99) - (b.orden || 99));
      cacheUsuarios = usuSnap.docs
        .map((s) => ({ uid: s.id, ...s.data() }))
        .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
      renderGestion();
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

  function renderGestion() {
    const ld = $('gestion-dispositivos');
    ld.textContent = '';
    for (const d of cacheDispositivos) {
      const texto = `${d.nombre} · ${d.modo === 'interruptor' ? 'interruptor' : 'pulso'}`;
      ld.appendChild(filaGestion(texto, d.activo === false, () => abrirEditorDispositivo(d)));
    }
    const lu = $('gestion-usuarios');
    lu.textContent = '';
    for (const u of cacheUsuarios) {
      const partes = [u.nombre, u.unidad, u.rol === 'admin' ? 'admin' : null].filter(Boolean);
      lu.appendChild(filaGestion(partes.join(' · '), u.activo === false, () => abrirEditorUsuario(u)));
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
    let tuya = { tuyaDeviceId: '', codigo: 'switch_1', pulsoMs: 1000, codigoBrillo: 'bright_value_v2', brilloMax: 1000 };
    if (!esNuevo) {
      try {
        const s = await getDoc(doc(db, `dispositivos/${d.id}/privado/tuya`));
        if (s.exists()) tuya = { ...tuya, ...s.data() };
      } catch (err) { /* sin acceso todavía: campos vacíos */ }
    }
    const iId = entrada(d.id, 'ej: porton-garaje');
    if (!esNuevo) iId.disabled = true;
    const iNombre = entrada(d.nombre, 'ej: Portón del garaje');
    const sTipo = selector([['puerta', 'Puerta'], ['cortina', 'Cortina / persiana'], ['ascensor', 'Ascensor'], ['luz', 'Luz'], ['rele', 'Relé / equipo'], ['otro', 'Otro']], d.tipo || 'puerta');
    const sSub = selector(SUBTIPOS.puerta, d.subtipo || '');
    const campoSub = campo('Subcategoría', sSub);
    const actualizarSub = () => campoSub.classList.toggle('oculto', sTipo.value !== 'puerta');
    sTipo.addEventListener('change', actualizarSub);
    actualizarSub();
    const sModo = selector([['pulso', 'Pulso (abrir y soltar)'], ['interruptor', 'Interruptor (on/off)'], ['cortina', 'Cortina (abrir / parar / cerrar)'], ['dimmer', 'Dimmer (perilla de brillo)']], d.modo || 'pulso');
    const iOrden = entrada(d.orden != null ? d.orden : 10, '', 'number');
    const cActivo = casilla('Activo', d.activo !== false);
    const iDevice = entrada(tuya.tuyaDeviceId, 'Device ID de Tuya');
    const iCodigo = entrada(tuya.codigo, 'switch_1');
    const iPulso = entrada(tuya.pulsoMs, '', 'number');
    const iCodigoBrillo = entrada(tuya.codigoBrillo, 'bright_value_v2');
    const iBrilloMax = entrada(tuya.brilloMax, '', 'number');
    const campoBrilloCodigo = campo('Código de brillo (Tuya)', iCodigoBrillo);
    const campoBrilloMax = campo('Brillo máximo (rango Tuya, ej. 1000)', iBrilloMax);
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
    const actualizarModo = () => {
      const esDimmer = sModo.value === 'dimmer';
      campoBrilloCodigo.classList.toggle('oculto', !esDimmer);
      campoBrilloMax.classList.toggle('oculto', !esDimmer);
      campoDetectar.classList.toggle('oculto', !esDimmer);
    };
    sModo.addEventListener('change', actualizarModo);
    actualizarModo();

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
            modo: sModo.value,
            orden: Number(iOrden.value) || 99,
            activo: cActivo.c.checked,
            tuyaDeviceId: iDevice.value.trim(),
            codigo: iCodigo.value.trim(),
            pulsoMs: Number(iPulso.value) || 1000,
            codigoBrillo: iCodigoBrillo.value.trim(),
            brilloMax: Number(iBrilloMax.value) || 1000,
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
      campo('Identificador (no cambia después)', iId),
      campo('Nombre visible', iNombre),
      campo('Tipo', sTipo),
      campoSub,
      campo('Modo', sModo),
      campo('Orden (menor = primero)', iOrden),
      cActivo.label,
      campo('Device ID de Tuya', iDevice),
      campo('Código del interruptor (Debug Device)', iCodigo),
      campo('Duración del pulso (ms)', iPulso),
      campoBrilloCodigo,
      campoBrilloMax,
      campoDetectar,
    ], acciones);
  }

  function abrirEditorUsuario(existente) {
    const esNuevo = !existente;
    const u = existente || {};
    const iNombre = entrada(u.nombre, 'ej: María Pérez');
    const iUnidad = entrada(u.unidad, 'ej: Apto 3B');
    const iEmail = entrada(u.email, 'correo@ejemplo.com', 'email');
    if (!esNuevo) iEmail.disabled = true;
    const iPass = entrada('', esNuevo ? 'Mínimo 6 caracteres' : 'Dejar vacío para no cambiarla', 'password');
    const sRol = selector([['vecino', 'Vecino'], ['admin', 'Administrador']], u.rol || 'vecino');
    const cActivo = casilla('Cuenta activa', u.activo !== false);
    const casillas = casillasDispositivos(u.dispositivos);

    const filas = [
      campo('Nombre', iNombre),
      campo('Unidad / apartamento', iUnidad),
      campo('Correo electrónico', iEmail),
      campo(esNuevo ? 'Contraseña' : 'Nueva contraseña (opcional)', iPass),
      campo('Rol', sRol),
    ];
    if (!esNuevo) filas.push(cActivo.label);
    filas.push(campo('Dispositivos permitidos (el admin ve todos)', casillas.cont));

    abrirEditor(esNuevo ? 'Nuevo vecino' : `Editar: ${u.nombre}`, filas, [
      botonForm('Guardar', 'btn-primario', async (ev) => {
        const b = ev.currentTarget;
        b.disabled = true;
        try {
          if (esNuevo) {
            await adminCrearUsuario({
              nombre: iNombre.value.trim(),
              unidad: iUnidad.value.trim(),
              email: iEmail.value.trim(),
              password: iPass.value,
              rol: sRol.value,
              dispositivos: casillas.seleccionados(),
            });
            toast('Vecino creado ✓ Ya puede entrar con su correo y contraseña.', 'ok');
          } else {
            await adminActualizarUsuario({
              uid: u.uid,
              nombre: iNombre.value.trim(),
              unidad: iUnidad.value.trim(),
              rol: sRol.value,
              activo: cActivo.c.checked,
              dispositivos: casillas.seleccionados(),
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
    ]);
  }

  $('btn-nuevo-dispositivo').addEventListener('click', () => abrirEditorDispositivo(null));
  $('btn-nuevo-usuario').addEventListener('click', () => abrirEditorUsuario(null));

  const PANELES_TAB = ['tab-controles', 'tab-gestion', 'tab-registro'];
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
      cerrarMenu();
    });
  });

  // Clic en el logo "ViYi" -> volver a Controles desde cualquier vista.
  const irInicio = () => { mostrarTab('tab-controles'); cerrarMenu(); };
  $('ir-inicio').addEventListener('click', irInicio);
  $('ir-inicio').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); irInicio(); }
  });

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
