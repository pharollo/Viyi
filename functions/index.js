const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret, defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { TuyaClient } = require('./tuya');

admin.initializeApp();
const db = admin.firestore();

const TUYA_CLIENT_ID = defineSecret('TUYA_CLIENT_ID');
const TUYA_CLIENT_SECRET = defineSecret('TUYA_CLIENT_SECRET');
const TUYA_BASE_URL = defineString('TUYA_BASE_URL', {
  default: 'https://openapi.tuyaus.com',
});

setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

let clienteTuya = null;
function tuya() {
  if (!clienteTuya) {
    clienteTuya = new TuyaClient({
      baseUrl: TUYA_BASE_URL.value(),
      clientId: TUYA_CLIENT_ID.value(),
      clientSecret: TUYA_CLIENT_SECRET.value(),
    });
  }
  return clienteTuya;
}

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function registrar({ uid, usuario, dispositivoId, dispositivoNombre, accion, exito, detalle }) {
  return db.collection('registros').add({
    uid,
    usuarioNombre: (usuario && usuario.nombre) || '(desconocido)',
    unidad: (usuario && usuario.unidad) || '',
    dispositivoId,
    dispositivoNombre: dispositivoNombre || dispositivoId,
    accion,
    exito,
    detalle: detalle || '',
    fecha: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function autorizar(uid, dispositivoId) {
  const usuarioSnap = await db.doc(`usuarios/${uid}`).get();
  if (!usuarioSnap.exists) {
    throw new HttpsError('permission-denied', 'Tu cuenta no está registrada en el condominio.');
  }
  const usuario = usuarioSnap.data();
  if (usuario.activo === false) {
    throw new HttpsError('permission-denied', 'Tu cuenta está desactivada.');
  }
  const esAdmin = usuario.rol === 'admin';
  const permitidos = usuario.dispositivos || [];
  if (!esAdmin && !permitidos.includes(dispositivoId)) {
    await registrar({
      uid,
      usuario,
      dispositivoId,
      accion: 'denegado',
      exito: false,
      detalle: 'Sin permiso para este dispositivo',
    });
    throw new HttpsError('permission-denied', 'No tienes permiso para este dispositivo.');
  }
  const dispSnap = await db.doc(`dispositivos/${dispositivoId}`).get();
  if (!dispSnap.exists || dispSnap.data().activo === false) {
    throw new HttpsError('not-found', 'El dispositivo no está disponible.');
  }
  const privadoSnap = await db.doc(`dispositivos/${dispositivoId}/privado/tuya`).get();
  if (!privadoSnap.exists) {
    throw new HttpsError('failed-precondition', 'El dispositivo no tiene configuración Tuya cargada.');
  }
  return { usuario, dispositivo: dispSnap.data(), config: privadoSnap.data() };
}

exports.ejecutarComando = onCall(
  { secrets: [TUYA_CLIENT_ID, TUYA_CLIENT_SECRET] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Inicia sesión primero.');
    }
    const { dispositivoId, accion, valor } = request.data || {};
    if (!dispositivoId || typeof dispositivoId !== 'string') {
      throw new HttpsError('invalid-argument', 'Falta el dispositivoId.');
    }

    const uid = request.auth.uid;
    const { usuario, dispositivo, config } = await autorizar(uid, dispositivoId);
    const codigo = config.codigo || 'switch_1';
    const dispositivoNombre = dispositivo.nombre;

    try {
      let accionRegistrada;
      if (dispositivo.modo === 'pulso') {
        accionRegistrada = 'pulso';
        await tuya().enviarComandos(config.tuyaDeviceId, [{ code: codigo, value: true }]);
        await dormir(config.pulsoMs || 1000);
        await tuya().enviarComandos(config.tuyaDeviceId, [{ code: codigo, value: false }]);
      } else if (dispositivo.modo === 'cortina') {
        const mapa = { abrir: 'open', detener: 'stop', cerrar: 'close' };
        if (!mapa[accion]) {
          throw new HttpsError('invalid-argument', "La acción debe ser 'abrir', 'detener' o 'cerrar'.");
        }
        accionRegistrada = accion;
        const codigoCortina = codigo === 'switch_1' ? 'control' : codigo;
        await tuya().enviarComandos(config.tuyaDeviceId, [
          { code: codigoCortina, value: mapa[accion] },
        ]);
      } else if (dispositivo.modo === 'dimmer') {
        const nivelPct = Number(valor);
        if (!Number.isFinite(nivelPct) || nivelPct < 0 || nivelPct > 100) {
          throw new HttpsError('invalid-argument', 'El brillo debe estar entre 0 y 100.');
        }
        accionRegistrada = `brillo ${Math.round(nivelPct)}%`;
        const codigoBrillo = config.codigoBrillo || 'bright_value_v2';
        const brilloMax = Number(config.brilloMax) || 1000;
        const brilloMin = Math.max(1, Math.round(brilloMax * 0.05));
        const bruto = (pct) => {
          const p = Math.max(0, Math.min(100, pct));
          return Math.round(brilloMin + (p / 100) * (brilloMax - brilloMin));
        };
        const conFundido = request.data.fade === true;
        const desde = Math.max(0, Math.min(100, Number(request.data.desde) || 0));
        if (conFundido && nivelPct !== desde) {
          const pasos = 6;
          if (nivelPct > 0) {
            // Fade in: encender y subir el brillo gradualmente.
            await tuya().enviarComandos(config.tuyaDeviceId, [{ code: codigo, value: true }]);
            for (let i = 1; i <= pasos; i++) {
              const p = desde + (nivelPct - desde) * (i / pasos);
              await tuya().enviarComandos(config.tuyaDeviceId, [{ code: codigoBrillo, value: bruto(p) }]);
              if (i < pasos) await dormir(160);
            }
          } else {
            // Fade out: bajar el brillo gradualmente y apagar.
            for (let i = 1; i <= pasos; i++) {
              const p = desde * (1 - i / pasos);
              await tuya().enviarComandos(config.tuyaDeviceId, [{ code: codigoBrillo, value: bruto(Math.max(p, 0.5)) }]);
              if (i < pasos) await dormir(160);
            }
            await tuya().enviarComandos(config.tuyaDeviceId, [{ code: codigo, value: false }]);
          }
        } else {
          const comandos = [{ code: codigo, value: nivelPct > 0 }];
          if (nivelPct > 0) comandos.push({ code: codigoBrillo, value: bruto(nivelPct) });
          await tuya().enviarComandos(config.tuyaDeviceId, comandos);
        }
      } else {
        if (accion !== 'encender' && accion !== 'apagar') {
          throw new HttpsError('invalid-argument', "La acción debe ser 'encender' o 'apagar'.");
        }
        accionRegistrada = accion;
        await tuya().enviarComandos(config.tuyaDeviceId, [
          { code: codigo, value: accion === 'encender' },
        ]);
      }
      await registrar({
        uid,
        usuario,
        dispositivoId,
        dispositivoNombre,
        accion: accionRegistrada,
        exito: true,
      });
      // Contador de uso por vecino, para ordenar "más usado primero".
      await db.doc(`usuarios/${uid}`).set(
        { usos: { [dispositivoId]: admin.firestore.FieldValue.increment(1) } },
        { merge: true },
      ).catch(() => {});
      return { ok: true };
    } catch (err) {
      await registrar({
        uid,
        usuario,
        dispositivoId,
        dispositivoNombre,
        accion: accion || 'pulso',
        exito: false,
        detalle: String((err && err.message) || err),
      });
      if (err instanceof HttpsError) throw err;
      throw new HttpsError('internal', 'El dispositivo no respondió. Intenta de nuevo.');
    }
  }
);

async function exigirAdmin(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Inicia sesión primero.');
  }
  const snap = await db.doc(`usuarios/${request.auth.uid}`).get();
  const usuario = snap.exists ? snap.data() : null;
  if (!usuario || usuario.rol !== 'admin' || usuario.activo === false) {
    throw new HttpsError('permission-denied', 'Solo el administrador puede hacer esto.');
  }
  return usuario;
}

exports.adminCrearUsuario = onCall(async (request) => {
  await exigirAdmin(request);
  const { email, password, nombre, unidad, rol, dispositivos } = request.data || {};
  if (!email || !password || !nombre) {
    throw new HttpsError('invalid-argument', 'Faltan correo, contraseña o nombre.');
  }
  if (String(password).length < 6) {
    throw new HttpsError('invalid-argument', 'La contraseña debe tener al menos 6 caracteres.');
  }
  let user;
  try {
    user = await admin.auth().createUser({ email, password, displayName: nombre });
  } catch (err) {
    if (err.code === 'auth/email-already-exists') {
      throw new HttpsError('already-exists', 'Ya existe una cuenta con ese correo.');
    }
    if (err.code === 'auth/invalid-email') {
      throw new HttpsError('invalid-argument', 'El correo no es válido.');
    }
    throw new HttpsError('internal', 'No se pudo crear la cuenta.');
  }
  await db.doc(`usuarios/${user.uid}`).set({
    nombre,
    unidad: unidad || '',
    email,
    rol: rol === 'admin' ? 'admin' : 'vecino',
    activo: true,
    dispositivos: Array.isArray(dispositivos) ? dispositivos : [],
  });
  return { uid: user.uid };
});

exports.adminActualizarUsuario = onCall(async (request) => {
  await exigirAdmin(request);
  const { uid, nombre, unidad, rol, activo, dispositivos, password } = request.data || {};
  if (!uid || typeof uid !== 'string') {
    throw new HttpsError('invalid-argument', 'Falta el uid.');
  }
  if (uid === request.auth.uid && (activo === false || (rol && rol !== 'admin'))) {
    throw new HttpsError('failed-precondition', 'No puedes quitarte el acceso a ti mismo.');
  }
  const cambios = {};
  if (typeof nombre === 'string' && nombre) cambios.nombre = nombre;
  if (typeof unidad === 'string') cambios.unidad = unidad;
  if (rol === 'admin' || rol === 'vecino') cambios.rol = rol;
  if (typeof activo === 'boolean') cambios.activo = activo;
  if (Array.isArray(dispositivos)) cambios.dispositivos = dispositivos;
  if (Object.keys(cambios).length) {
    await db.doc(`usuarios/${uid}`).set(cambios, { merge: true });
  }
  if (typeof activo === 'boolean') {
    await admin.auth().updateUser(uid, { disabled: !activo }).catch(() => {});
  }
  if (typeof password === 'string' && password) {
    if (password.length < 6) {
      throw new HttpsError('invalid-argument', 'La contraseña debe tener al menos 6 caracteres.');
    }
    await admin.auth().updateUser(uid, { password });
  }
  return { ok: true };
});

exports.adminGuardarDispositivo = onCall(async (request) => {
  await exigirAdmin(request);
  const {
    id, nombre, tipo, subtipo, modo, etiquetaBoton, orden, activo,
    tuyaDeviceId, codigo, pulsoMs, codigoBrillo, brilloMax,
  } = request.data || {};
  if (!id || !/^[a-z0-9-]{2,40}$/.test(id)) {
    throw new HttpsError('invalid-argument', 'El id debe ser minúsculas, números y guiones (ej: porton-garaje).');
  }
  if (!nombre || !tuyaDeviceId) {
    throw new HttpsError('invalid-argument', 'Faltan el nombre o el Device ID de Tuya.');
  }
  let tipoFinal = ['puerta', 'cortina', 'ascensor', 'luz', 'rele', 'otro'].includes(tipo) ? tipo : 'otro';
  let subFinal = ['bunker', 'porton'].includes(subtipo) ? subtipo : '';
  if (tipo === 'bunker') { tipoFinal = 'puerta'; subFinal = 'bunker'; } // compat con el tipo viejo
  if (tipoFinal !== 'puerta') subFinal = '';                            // el subtipo solo aplica a puerta
  await db.doc(`dispositivos/${id}`).set({
    nombre,
    tipo: tipoFinal,
    subtipo: subFinal,
    modo: ['interruptor', 'cortina', 'dimmer'].includes(modo) ? modo : 'pulso',
    etiquetaBoton: etiquetaBoton || '',
    orden: Number(orden) || 99,
    activo: activo !== false,
  }, { merge: true });
  await db.doc(`dispositivos/${id}/privado/tuya`).set({
    tuyaDeviceId: String(tuyaDeviceId).trim(),
    codigo: (codigo || 'switch_1').trim(),
    pulsoMs: Number(pulsoMs) || 1000,
    codigoBrillo: (codigoBrillo || 'bright_value_v2').trim(),
    brilloMax: Number(brilloMax) || 1000,
  }, { merge: true });
  return { ok: true };
});

exports.adminInspeccionarDispositivo = onCall(
  { secrets: [TUYA_CLIENT_ID, TUYA_CLIENT_SECRET] },
  async (request) => {
    await exigirAdmin(request);
    const { tuyaDeviceId } = request.data || {};
    if (!tuyaDeviceId || typeof tuyaDeviceId !== 'string') {
      throw new HttpsError('invalid-argument', 'Falta el Device ID de Tuya.');
    }
    const spec = await tuya().especificacion(tuyaDeviceId.trim()).catch(() => null);
    const estado = await tuya().estado(tuyaDeviceId.trim()).catch(() => null);
    let funciones = (spec && spec.functions) || [];
    // Fallback: si no hay especificación, usar los DPs del estado actual.
    if (!funciones.length && Array.isArray(estado)) {
      funciones = estado.map((e) => ({
        code: e.code,
        type: typeof e.value === 'boolean' ? 'Boolean' : (typeof e.value === 'number' ? 'Integer' : 'String'),
        values: '',
      }));
    }
    if (!funciones.length) {
      throw new HttpsError('failed-precondition', 'No se pudieron leer los datapoints. Revisa el Device ID.');
    }
    return {
      funciones: funciones.map((f) => ({ code: f.code, type: f.type, values: f.values || '' })),
      estado: (estado || []).map((e) => ({ code: e.code, value: e.value })),
    };
  }
);

exports.adminEliminarDispositivo = onCall(async (request) => {
  await exigirAdmin(request);
  const { id } = request.data || {};
  if (!id || typeof id !== 'string') {
    throw new HttpsError('invalid-argument', 'Falta el id.');
  }
  await db.doc(`dispositivos/${id}/privado/tuya`).delete().catch(() => {});
  await db.doc(`dispositivos/${id}`).delete();
  return { ok: true };
});

exports.consultarEstado = onCall(
  { secrets: [TUYA_CLIENT_ID, TUYA_CLIENT_SECRET] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Inicia sesión primero.');
    }
    const { dispositivoId } = request.data || {};
    if (!dispositivoId || typeof dispositivoId !== 'string') {
      throw new HttpsError('invalid-argument', 'Falta el dispositivoId.');
    }

    const { config } = await autorizar(request.auth.uid, dispositivoId);
    const codigo = config.codigo || 'switch_1';

    try {
      const estados = await tuya().estado(config.tuyaDeviceId);
      const punto = (estados || []).find((e) => e.code === codigo);
      const encendido = punto ? Boolean(punto.value) : null;
      const codigoBrillo = config.codigoBrillo || 'bright_value_v2';
      const puntoBrillo = (estados || []).find((e) => e.code === codigoBrillo);
      let brillo = null;
      if (puntoBrillo && typeof puntoBrillo.value === 'number') {
        const brilloMax = Number(config.brilloMax) || 1000;
        const brilloMin = Math.max(1, Math.round(brilloMax * 0.05));
        const pct = ((puntoBrillo.value - brilloMin) / (brilloMax - brilloMin)) * 100;
        brillo = encendido === false ? 0 : Math.max(0, Math.min(100, Math.round(pct)));
      }
      return { encendido, brillo };
    } catch (err) {
      throw new HttpsError('internal', 'No se pudo consultar el estado del dispositivo.');
    }
  }
);
