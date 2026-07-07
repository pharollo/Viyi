import { firebaseConfig, FUNCTIONS_REGION, NOMBRE_CONDOMINIO } from './firebase-config.js';

const $ = (id) => document.getElementById(id);
const VISTAS = ['vista-cargando', 'vista-config', 'vista-login', 'vista-sin-acceso', 'vista-panel'];

function mostrarVista(id) {
  VISTAS.forEach((v) => $(v).classList.toggle('oculto', v !== id));
}

document.title = `Viyi.io · ${NOMBRE_CONDOMINIO}`;
$('nombre-condominio').textContent = NOMBRE_CONDOMINIO;
$('condominio-login').textContent = NOMBRE_CONDOMINIO;

if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith('PEGA_')) {
  mostrarVista('vista-config');
} else {
  iniciar();
}

async function iniciar() {
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
  const {
    getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut,
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

  const TIPOS = [
    { clave: 'puerta', titulo: 'Puertas y portones' },
    { clave: 'ascensor', titulo: 'Ascensores' },
    { clave: 'luz', titulo: 'Luces' },
    { clave: 'rele', titulo: 'Relés y equipos' },
    { clave: 'otro', titulo: 'Otros' },
  ];

  const ICONOS = {
    candados: '<svg viewBox="0 0 88 40" width="88" height="40" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="17" width="24" height="19" rx="3.5"/><path d="M13 17v-5.5a7 7 0 0 1 14 0V17"/><circle cx="20" cy="26.5" r="2.3" fill="currentColor" stroke="none"/><line x1="44" y1="7" x2="44" y2="33" stroke-opacity="0.3"/><rect x="56" y="17" width="24" height="19" rx="3.5"/><path d="M61 17v-5.5a7 7 0 0 1 14 0"/><circle cx="68" cy="26.5" r="2.3" fill="currentColor" stroke="none"/></svg>',
    luz: '<svg viewBox="0 0 40 40" width="36" height="36" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="20" cy="20" r="7"/><path d="M20 4v5M20 31v5M4 20h5M31 20h5M8.7 8.7l3.5 3.5M27.8 27.8l3.5 3.5M31.3 8.7l-3.5 3.5M12.2 27.8l-3.5 3.5"/></svg>',
    ascensor: '<svg viewBox="0 0 40 40" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 15l7-9 7 9"/><path d="M13 25l7 9 7-9"/></svg>',
    rele: '<svg viewBox="0 0 40 40" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M20 5v14"/><path d="M28.8 11a12 12 0 1 1-17.6 0"/></svg>',
    otro: '<svg viewBox="0 0 40 40" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M20 5v14"/><path d="M28.8 11a12 12 0 1 1-17.6 0"/></svg>',
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
      $('nombre-usuario').textContent = usuario.unidad
        ? `${usuario.nombre} · ${usuario.unidad}`
        : usuario.nombre;
      $('info-usuario').classList.remove('oculto');

      const dispositivos = await cargarDispositivos(usuario);
      renderDispositivos(dispositivos);

      if (usuario.rol === 'admin') {
        $('seccion-admin').classList.remove('oculto');
        cargarRegistros();
      } else {
        $('seccion-admin').classList.add('oculto');
      }
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
      .map((s) => ({ id: s.id, ...s.data() }))
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
    for (const tipo of TIPOS) {
      const grupo = dispositivos.filter((d) => (d.tipo || 'otro') === tipo.clave);
      if (!grupo.length) continue;
      const titulo = document.createElement('h2');
      titulo.className = 'titulo-grupo';
      titulo.textContent = tipo.titulo;
      contenedor.appendChild(titulo);
      const fila = document.createElement('div');
      fila.className = 'grupo-controles';
      for (const dispositivo of grupo) {
        fila.appendChild(tarjetaDispositivo(dispositivo));
      }
      contenedor.appendChild(fila);
    }
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
      boton.className = 'boton-circular grande';
      boton.innerHTML = ICONOS.candados;
      boton.setAttribute('aria-label', `${dispositivo.etiquetaBoton || 'Abrir'} ${dispositivo.nombre}`);
      boton.addEventListener('click', () => pulsar(boton, dispositivo));
      anillo.appendChild(boton);
      control.appendChild(anillo);
    } else {
      boton = document.createElement('button');
      boton.type = 'button';
      boton.className = 'boton-circular medio';
      boton.innerHTML = ICONOS[dispositivo.tipo] || ICONOS.otro;
      boton.setAttribute('aria-label', `Encender o apagar ${dispositivo.nombre}`);
      boton.addEventListener('click', () => alternar(boton, dispositivo));
      control.appendChild(boton);
      estadoInicial(boton, dispositivo);
    }
    const etiqueta = document.createElement('span');
    etiqueta.className = 'etiqueta-control';
    etiqueta.textContent = dispositivo.nombre;
    control.appendChild(etiqueta);
    return control;
  }

  async function pulsar(boton, dispositivo) {
    if (boton.classList.contains('enviando')) return;
    boton.classList.add('enviando');
    try {
      await ejecutarComando({ dispositivoId: dispositivo.id });
      toast(`${dispositivo.nombre}: listo ✓`, 'ok');
      boton.classList.add('exito');
      setTimeout(() => boton.classList.remove('exito'), 1500);
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
      boton.classList.toggle('activo', !encendido);
      toast(`${dispositivo.nombre}: ${accion === 'encender' ? 'encendido ✓' : 'apagado ✓'}`, 'ok');
    } catch (err) {
      toast(err.message || 'No se pudo enviar el comando.', 'error');
    } finally {
      boton.classList.remove('enviando');
    }
  }

  async function estadoInicial(boton, dispositivo) {
    try {
      const res = await consultarEstado({ dispositivoId: dispositivo.id });
      if (res.data && res.data.encendido === true) {
        boton.classList.add('activo');
      }
    } catch (err) {
      // Sin estado disponible: el botón queda como apagado.
    }
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
        item.textContent = `${fecha} · ${r.usuarioNombre}${r.unidad ? ` (${r.unidad})` : ''} · ${r.dispositivoNombre} · ${r.accion} ${r.exito ? '✓' : '✗'}`;
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
