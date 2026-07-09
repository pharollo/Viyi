import { firebaseConfig, FUNCTIONS_REGION, NOMBRE_CONDOMINIO } from './firebase-config.js';

const $ = (id) => document.getElementById(id);
const VISTAS = ['vista-cargando', 'vista-config', 'vista-login', 'vista-sin-acceso', 'vista-panel'];

function mostrarVista(id) {
  VISTAS.forEach((v) => $(v).classList.toggle('oculto', v !== id));
  // El header con marca + usuario solo tiene sentido dentro del panel;
  // en login/config/sin-acceso la tarjeta central ya lleva el branding.
  document.querySelector('header').classList.toggle('oculto', id !== 'vista-panel');
}

document.title = `ViYi · ${NOMBRE_CONDOMINIO}`;
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
  const adminCrearUsuario = httpsCallable(functions, 'adminCrearUsuario');
  const adminActualizarUsuario = httpsCallable(functions, 'adminActualizarUsuario');
  const adminGuardarDispositivo = httpsCallable(functions, 'adminGuardarDispositivo');
  const adminEliminarDispositivo = httpsCallable(functions, 'adminEliminarDispositivo');

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
    candados: '<svg viewBox="0 0 88 40" width="88" height="40" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="17" width="24" height="19" rx="3.5"/><path d="M13 17v-5.5a7 7 0 0 1 14 0V17"/><circle cx="20" cy="26.5" r="2.3" fill="currentColor" stroke="none"/><line x1="44" y1="7" x2="44" y2="33" stroke-opacity="0.3"/><rect x="56" y="17" width="24" height="19" rx="3.5"/><path d="M61 17v-5.5a7 7 0 0 1 14 0"/><circle cx="68" cy="26.5" r="2.3" fill="currentColor" stroke="none"/></svg>',
    luz: '<svg viewBox="0 0 40 40" width="36" height="36" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="20" cy="20" r="7"/><path d="M20 4v5M20 31v5M4 20h5M31 20h5M8.7 8.7l3.5 3.5M27.8 27.8l3.5 3.5M31.3 8.7l-3.5 3.5M12.2 27.8l-3.5 3.5"/></svg>',
    ascensor: '<svg class="icono-ascensor" viewBox="0 0 40 40" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="30" height="31" rx="3"/><path class="flecha-subir" d="M12.3 12L15 8.7L17.7 12Z"/><path class="flecha-bajar" d="M20.5 8.7L25.5 8.7L23 12Z"/><path d="M11 35V16.5H26V35"/><line x1="18.5" y1="16.5" x2="18.5" y2="35"/><circle cx="30" cy="20" r="1.1" fill="currentColor"/><circle cx="30" cy="24.5" r="1.1" fill="currentColor"/></svg>',
    bunker: '<svg class="icono-bunker" viewBox="-4 0.5 40 40" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="16" cy="25" r="10.5"/><path d="M12.8 15V12Q12.8 10.7 14.1 10.7H17.9Q19.2 10.7 19.2 12V15"/><path class="mecha" d="M16 10.7C15.5 6.5 22 5.5 23.5 9.2"/><path class="mecha" d="M23.5 9.2L27.2 6.9M23.5 9.2L28.2 10.1M23.5 9.2L25.1 5.5M23.5 9.2L25.5 12.8"/></svg>',
    porton: '<svg viewBox="0 0 40 40" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 35V11Q6 8.5 8.5 8.5H31.5Q34 8.5 34 11V35"/><line x1="10.5" y1="13.5" x2="29.5" y2="13.5"/><line x1="10.5" y1="16" x2="29.5" y2="16"/><line x1="10.5" y1="18.5" x2="29.5" y2="18.5"/><line x1="10.5" y1="21" x2="29.5" y2="21"/><path d="M13.5 33V29Q13.5 27 15.5 26.8H24.5Q26.5 27 26.5 29V33"/><path d="M16.5 26.8L17.8 23.8Q18.1 23 19 23H21Q21.9 23 22.2 23.8L23.5 26.8"/><circle cx="16.5" cy="30.3" r="1.3"/><circle cx="23.5" cy="30.3" r="1.3"/></svg>',
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

      if (usuario.rol === 'admin') {
        $('pestanas').classList.remove('oculto');
        cargarGestion();
        cargarRegistros();
      } else {
        $('pestanas').classList.add('oculto');
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
      const iconoSub = ICONO_SUBTIPO[dispositivo.subtipo];
      const iconoCuadrado = !!iconoSub || dispositivo.tipo === 'ascensor';
      boton.className = 'boton-circular grande' + (iconoCuadrado ? ' cuadrado' : '');
      boton.innerHTML = iconoSub ? ICONOS[iconoSub]
        : (dispositivo.tipo === 'ascensor' ? ICONOS.ascensor : ICONOS.candados);
      boton.setAttribute('aria-label', `${dispositivo.etiquetaBoton || 'Abrir'} ${dispositivo.nombre}`);
      boton.addEventListener('click', () => pulsar(boton, dispositivo));
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
    } else {
      boton = document.createElement('button');
      boton.type = 'button';
      boton.className = 'boton-circular medio';
      boton.innerHTML = ICONO_SUBTIPO[dispositivo.subtipo]
        ? ICONOS[ICONO_SUBTIPO[dispositivo.subtipo]]
        : (ICONOS[dispositivo.tipo] || ICONOS.otro);
      boton.setAttribute('aria-label', `Encender o apagar ${dispositivo.nombre}`);
      boton.addEventListener('click', () => alternar(boton, dispositivo));
      control.appendChild(boton);
    }
    const etiqueta = document.createElement('span');
    etiqueta.className = 'etiqueta-control';
    etiqueta.textContent = dispositivo.nombre;
    control.appendChild(etiqueta);
    if (boton && dispositivo.modo !== 'pulso') {
      const estado = document.createElement('span');
      estado.className = 'estado-control';
      estado.textContent = '—';
      control.appendChild(estado);
      estadoInicial(boton, dispositivo);
    }
    return control;
  }

  // Refleja el estado on/off en el botón y en su etiqueta de texto.
  function pintarEstado(boton, encendido) {
    boton.classList.toggle('activo', encendido);
    boton.setAttribute('aria-pressed', encendido ? 'true' : 'false');
    const estado = boton.closest('.control')?.querySelector('.estado-control');
    if (estado) {
      estado.textContent = encendido ? 'Encendido' : 'Apagado';
      estado.classList.toggle('on', encendido);
    }
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
    let tuya = { tuyaDeviceId: '', codigo: 'switch_1', pulsoMs: 1000 };
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
    const sModo = selector([['pulso', 'Pulso (abrir y soltar)'], ['interruptor', 'Interruptor (on/off)'], ['cortina', 'Cortina (abrir / parar / cerrar)']], d.modo || 'pulso');
    const iOrden = entrada(d.orden != null ? d.orden : 10, '', 'number');
    const cActivo = casilla('Activo', d.activo !== false);
    const iDevice = entrada(tuya.tuyaDeviceId, 'Device ID de Tuya');
    const iCodigo = entrada(tuya.codigo, 'switch_1');
    const iPulso = entrada(tuya.pulsoMs, '', 'number');

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
    document.querySelectorAll('.pestana').forEach((p) => {
      p.classList.toggle('activa', p.dataset.tab === id);
    });
  }
  document.querySelectorAll('.pestana').forEach((p) => {
    p.addEventListener('click', () => mostrarTab(p.dataset.tab));
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
