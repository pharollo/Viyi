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

  const TIPOS = [
    { clave: 'puerta', titulo: 'Puertas y portones', icono: '🚪' },
    { clave: 'ascensor', titulo: 'Ascensores', icono: '🛗' },
    { clave: 'luz', titulo: 'Luces', icono: '💡' },
    { clave: 'rele', titulo: 'Relés y equipos', icono: '🔌' },
    { clave: 'otro', titulo: 'Otros', icono: '⚙️' },
  ];

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
      titulo.textContent = `${tipo.icono} ${tipo.titulo}`;
      contenedor.appendChild(titulo);
      for (const dispositivo of grupo) {
        contenedor.appendChild(tarjetaDispositivo(dispositivo));
      }
    }
  }

  function tarjetaDispositivo(dispositivo) {
    const tarjeta = document.createElement('div');
    tarjeta.className = 'tarjeta tarjeta-dispositivo';
    const nombre = document.createElement('span');
    nombre.className = 'nombre-dispositivo';
    nombre.textContent = dispositivo.nombre;
    tarjeta.appendChild(nombre);

    const acciones = document.createElement('div');
    acciones.className = 'acciones';
    if (dispositivo.modo === 'pulso') {
      acciones.appendChild(
        botonAccion(dispositivo, null, dispositivo.etiquetaBoton || 'Abrir', 'btn-primario')
      );
    } else {
      acciones.appendChild(botonAccion(dispositivo, 'encender', 'Encender', 'btn-primario'));
      acciones.appendChild(botonAccion(dispositivo, 'apagar', 'Apagar', 'btn-secundario'));
    }
    tarjeta.appendChild(acciones);
    return tarjeta;
  }

  function botonAccion(dispositivo, accion, etiqueta, clase) {
    const boton = document.createElement('button');
    boton.type = 'button';
    boton.className = clase;
    boton.textContent = etiqueta;
    boton.addEventListener('click', async () => {
      boton.disabled = true;
      boton.textContent = 'Enviando…';
      try {
        await ejecutarComando({ dispositivoId: dispositivo.id, accion: accion || undefined });
        toast(`${dispositivo.nombre}: listo ✓`, 'ok');
      } catch (err) {
        toast(err.message || 'No se pudo enviar el comando.', 'error');
      } finally {
        boton.disabled = false;
        boton.textContent = etiqueta;
      }
    });
    return boton;
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
