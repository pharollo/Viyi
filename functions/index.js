const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret, defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');
const { TuyaClient } = require('./tuya');
const { HomebridgeClient } = require('./homebridge');

admin.initializeApp();
const db = admin.firestore();

const TUYA_CLIENT_ID = defineSecret('TUYA_CLIENT_ID');
const TUYA_CLIENT_SECRET = defineSecret('TUYA_CLIENT_SECRET');
const TUYA_BASE_URL = defineString('TUYA_BASE_URL', {
  default: 'https://openapi.tuyaus.com',
});
// Homebridge (homebridge-config-ui-x) vía túnel HTTPS. Requiere estos 3
// secrets en Secret Manager (firebase functions:secrets:set NOMBRE):
// HOMEBRIDGE_URL (URL del túnel), HOMEBRIDGE_USER, HOMEBRIDGE_PASS.
const HOMEBRIDGE_URL = defineSecret('HOMEBRIDGE_URL');
const HOMEBRIDGE_USER = defineSecret('HOMEBRIDGE_USER');
const HOMEBRIDGE_PASS = defineSecret('HOMEBRIDGE_PASS');
const SECRETS_HB = [HOMEBRIDGE_URL, HOMEBRIDGE_USER, HOMEBRIDGE_PASS];

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

let clienteHb = null;
function homebridge() {
  if (!clienteHb) {
    clienteHb = new HomebridgeClient({
      baseUrl: HOMEBRIDGE_URL.value(),
      username: HOMEBRIDGE_USER.value(),
      password: HOMEBRIDGE_PASS.value(),
    });
  }
  return clienteHb;
}

// Ejecuta un comando en un accesorio de Homebridge según el modo del dispositivo.
// Devuelve el texto de la acción para el registro.
async function ejecutarHomebridge(dispositivo, config, { accion, valor, data }) {
  const id = config.accesorioId;
  if (!id) {
    throw new HttpsError('failed-precondition', 'El accesorio de Homebridge no está configurado.');
  }
  const hb = homebridge();
  const invert = config.posicionInvertida === true;
  const carac = config.caracteristica || 'On';

  if (dispositivo.modo === 'pulso') {
    if (carac === 'TargetDoorState') {
      await hb.setCaracteristica(id, 'TargetDoorState', 0); // 0 = abrir
    } else {
      await hb.setCaracteristica(id, carac, true);
      await dormir(config.pulsoMs || 1000);
      await hb.setCaracteristica(id, carac, false);
    }
    return 'pulso';
  }

  if (dispositivo.modo === 'cortina') {
    if (accion === 'posicion') {
      const pct = Number(valor);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        throw new HttpsError('invalid-argument', 'La apertura debe estar entre 0 y 100.');
      }
      const objetivo = invert ? 100 - Math.round(pct) : Math.round(pct);
      await hb.setCaracteristica(id, 'TargetPosition', objetivo);
      return `apertura ${Math.round(pct)}%`;
    }
    if (accion === 'detener' || accion === 'pausar') {
      await hb.setCaracteristica(id, 'HoldPosition', true);
      return 'detener';
    }
    if (accion === 'abrir') { await hb.setCaracteristica(id, 'TargetPosition', invert ? 0 : 100); return 'abrir'; }
    if (accion === 'cerrar') { await hb.setCaracteristica(id, 'TargetPosition', invert ? 100 : 0); return 'cerrar'; }
    throw new HttpsError('invalid-argument', 'Acción de cortina no válida.');
  }

  if (dispositivo.modo === 'dimmer') {
    const pct = Number(valor);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new HttpsError('invalid-argument', 'El brillo debe estar entre 0 y 100.');
    }
    await hb.setCaracteristica(id, 'On', pct > 0);
    if (pct > 0) await hb.setCaracteristica(id, 'Brightness', Math.round(pct));
    return `brillo ${Math.round(pct)}%`;
  }

  // interruptor
  if (accion !== 'encender' && accion !== 'apagar') {
    throw new HttpsError('invalid-argument', "La acción debe ser 'encender' o 'apagar'.");
  }
  await hb.setCaracteristica(id, carac, accion === 'encender');
  return accion;
}

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Duraciones de los pases (acceso temporal compartido).
const DURACIONES_MS = { '1h': 3600000, '24h': 86400000, '7d': 604800000 };
const msDeDuracion = (d) => (d === 'indef' ? null : DURACIONES_MS[d] || null);
// Sentinela "sin vencimiento" (fácil de comparar en reglas y backend).
const FIN_INDEFINIDO = admin.firestore.Timestamp.fromDate(new Date('9999-12-31T00:00:00Z'));

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
  let tienePermiso = esAdmin || permitidos.includes(dispositivoId);
  // Acceso temporal por un pase compartido: válido si no ha vencido.
  if (!tienePermiso) {
    const acceso = (usuario.accesos || {})[dispositivoId];
    if (acceso && acceso.expira && typeof acceso.expira.toMillis === 'function') {
      tienePermiso = acceso.expira.toMillis() > Date.now();
    }
  }
  if (!tienePermiso) {
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
    throw new HttpsError('failed-precondition', 'El dispositivo no tiene configuración cargada.');
  }
  return { usuario, dispositivo: dispSnap.data(), config: privadoSnap.data() };
}

exports.ejecutarComando = onCall(
  { secrets: [TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, ...SECRETS_HB] },
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
    const proveedor = dispositivo.proveedor || 'tuya';

    try {
      let accionRegistrada;
      if (proveedor === 'homebridge') {
        accionRegistrada = await ejecutarHomebridge(dispositivo, config, { accion, valor, data: request.data });
      } else if (dispositivo.modo === 'pulso') {
        accionRegistrada = 'pulso';
        await tuya().enviarComandos(config.tuyaDeviceId, [{ code: codigo, value: true }]);
        await dormir(config.pulsoMs || 1000);
        await tuya().enviarComandos(config.tuyaDeviceId, [{ code: codigo, value: false }]);
      } else if (dispositivo.modo === 'cortina') {
        const codigoControl = codigo === 'switch_1' ? 'control' : codigo;
        if (accion === 'posicion') {
          // Fijar la apertura por porcentaje (percent_control).
          const pct = Number(valor);
          if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
            throw new HttpsError('invalid-argument', 'La apertura debe estar entre 0 y 100.');
          }
          const codigoPos = config.codigoPosicion || 'percent_control';
          const objetivo = config.posicionInvertida ? 100 - Math.round(pct) : Math.round(pct);
          accionRegistrada = `apertura ${Math.round(pct)}%`;
          await tuya().enviarComandos(config.tuyaDeviceId, [{ code: codigoPos, value: objetivo }]);
        } else {
          const mapa = { abrir: 'open', detener: 'stop', pausar: 'stop', cerrar: 'close' };
          if (!mapa[accion]) {
            throw new HttpsError('invalid-argument', 'Acción de cortina no válida.');
          }
          accionRegistrada = accion;
          await tuya().enviarComandos(config.tuyaDeviceId, [
            { code: codigoControl, value: mapa[accion] },
          ]);
        }
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
    proveedor, tuyaDeviceId, codigo, pulsoMs, codigoBrillo, brilloMax,
    codigoPosicion, codigoPosicionEstado, posicionInvertida,
    accesorioId, caracteristica,
  } = request.data || {};
  if (!id || !/^[a-z0-9-]{2,40}$/.test(id)) {
    throw new HttpsError('invalid-argument', 'El id debe ser minúsculas, números y guiones (ej: porton-garaje).');
  }
  const provFinal = proveedor === 'homebridge' ? 'homebridge' : 'tuya';
  if (!nombre) {
    throw new HttpsError('invalid-argument', 'Falta el nombre del dispositivo.');
  }
  if (provFinal === 'homebridge' ? !accesorioId : !tuyaDeviceId) {
    throw new HttpsError('invalid-argument', provFinal === 'homebridge'
      ? 'Falta el accesorio de Homebridge.'
      : 'Falta el Device ID de Tuya.');
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
    proveedor: provFinal,
    etiquetaBoton: etiquetaBoton || '',
    orden: Number(orden) || 99,
    activo: activo !== false,
  }, { merge: true });
  const privado = {
    tuyaDeviceId: String(tuyaDeviceId || '').trim(),
    codigo: (codigo || 'switch_1').trim(),
    pulsoMs: Number(pulsoMs) || 1000,
    codigoBrillo: (codigoBrillo || 'bright_value_v2').trim(),
    brilloMax: Number(brilloMax) || 1000,
  };
  // Homebridge: id del accesorio y característica (opcional; por defecto On).
  if (accesorioId) privado.accesorioId = String(accesorioId).trim();
  if (caracteristica) privado.caracteristica = String(caracteristica).trim();
  // Cortina: código de posición e inversión (opcionales; por defecto
  // percent_control / percent_state). Solo se guardan si se envían.
  if (codigoPosicion) privado.codigoPosicion = String(codigoPosicion).trim();
  if (codigoPosicionEstado) privado.codigoPosicionEstado = String(codigoPosicionEstado).trim();
  if (typeof posicionInvertida === 'boolean') privado.posicionInvertida = posicionInvertida;
  await db.doc(`dispositivos/${id}/privado/tuya`).set(privado, { merge: true });
  return { ok: true };
});

// Lista los accesorios de Homebridge (para elegirlos en el editor).
exports.adminListarAccesoriosHomebridge = onCall(
  { secrets: SECRETS_HB },
  async (request) => {
    await exigirAdmin(request);
    const accesorios = await homebridge().listarAccesorios();
    return {
      accesorios: (accesorios || []).map((a) => ({
        uniqueId: a.uniqueId,
        nombre: a.serviceName || (a.values && a.values.Name) || a.uniqueId,
        tipo: a.type || '',
        caracteristicas: Object.keys((a && a.values) || {}),
      })),
    };
  }
);

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

// ---- Pases: acceso temporal compartido por enlace ----

// Genera un enlace de pase con los dispositivos y la duración elegidos.
exports.crearPase = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Inicia sesión primero.');
  }
  const uid = request.auth.uid;
  const { dispositivos, duracion, multiuso } = request.data || {};
  if (!Array.isArray(dispositivos) || !dispositivos.length) {
    throw new HttpsError('invalid-argument', 'Elige al menos un dispositivo para compartir.');
  }
  if (!['1h', '24h', '7d', 'indef'].includes(duracion)) {
    throw new HttpsError('invalid-argument', 'La duración no es válida.');
  }
  const snap = await db.doc(`usuarios/${uid}`).get();
  if (!snap.exists || snap.data().activo === false) {
    throw new HttpsError('permission-denied', 'Tu cuenta no está activa.');
  }
  const usuario = snap.data();
  const esAdmin = usuario.rol === 'admin';
  const propios = usuario.dispositivos || [];
  // Solo puede compartir dispositivos a los que tiene acceso permanente.
  const compartir = [...new Set(dispositivos.filter(
    (id) => typeof id === 'string' && (esAdmin || propios.includes(id)),
  ))];
  if (!compartir.length) {
    throw new HttpsError('permission-denied', 'No puedes compartir esos dispositivos.');
  }
  // El plazo corre desde que se genera el enlace: vencimiento absoluto.
  const ms = msDeDuracion(duracion);
  const expira = ms == null
    ? FIN_INDEFINIDO
    : admin.firestore.Timestamp.fromMillis(Date.now() + ms);
  const token = crypto.randomBytes(16).toString('hex');
  await db.doc(`pases/${token}`).set({
    por: uid,
    porNombre: usuario.nombre || '',
    dispositivos: compartir,
    duracion,
    expira,
    multiuso: multiuso === true,
    usado: false,
    usos: 0,
    revocado: false,
    redimidoPor: [],
    creado: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { token };
});

// Canjea un pase: crea (o actualiza) el perfil del invitado y le da acceso
// temporal a los dispositivos compartidos.
exports.canjearPase = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Inicia sesión primero.');
  }
  const uid = request.auth.uid;
  const { token, nombre } = request.data || {};
  if (!token || typeof token !== 'string') {
    throw new HttpsError('invalid-argument', 'Falta el enlace del pase.');
  }
  const ref = db.doc(`pases/${token}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', 'El enlace no es válido.');
  }
  const pase = snap.data();
  if (pase.revocado === true) {
    throw new HttpsError('failed-precondition', 'Este enlace fue revocado.');
  }
  if (pase.multiuso !== true && pase.usado === true) {
    throw new HttpsError('failed-precondition', 'Este enlace ya fue usado.');
  }
  if (pase.por === uid) {
    throw new HttpsError('failed-precondition', 'No puedes canjear tu propio enlace.');
  }

  // El plazo cuenta desde que se generó el enlace (vencimiento absoluto).
  const expira = pase.expira || FIN_INDEFINIDO;
  if (typeof expira.toMillis === 'function' && expira.toMillis() <= Date.now()) {
    throw new HttpsError('failed-precondition', 'Este enlace ya venció.');
  }
  const accesos = {};
  for (const id of (pase.dispositivos || [])) {
    accesos[id] = { expira, por: pase.por, token };
  }

  const userRef = db.doc(`usuarios/${uid}`);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    const nombreFinal = (typeof nombre === 'string' && nombre.trim())
      || request.auth.token.name
      || (request.auth.token.email || '').split('@')[0]
      || 'Invitado';
    await userRef.set({
      nombre: nombreFinal,
      unidad: '',
      email: request.auth.token.email || '',
      rol: 'vecino',
      activo: true,
      dispositivos: [],
      accesos,
      invitado: true,
    });
  } else {
    if (userSnap.data().activo === false) {
      throw new HttpsError('permission-denied', 'Tu cuenta está desactivada.');
    }
    await userRef.set({ accesos }, { merge: true });
  }

  const cambios = {
    usos: admin.firestore.FieldValue.increment(1),
    redimidoPor: admin.firestore.FieldValue.arrayUnion(uid),
  };
  if (pase.multiuso !== true) cambios.usado = true;
  await ref.set(cambios, { merge: true });

  return { ok: true, dispositivos: pase.dispositivos || [] };
});

// Revoca un pase: invalida el enlace y quita el acceso a quienes lo canjearon.
exports.revocarPase = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Inicia sesión primero.');
  }
  const uid = request.auth.uid;
  const { token } = request.data || {};
  if (!token || typeof token !== 'string') {
    throw new HttpsError('invalid-argument', 'Falta el enlace del pase.');
  }
  const ref = db.doc(`pases/${token}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', 'El pase no existe.');
  }
  const pase = snap.data();
  if (pase.por !== uid) {
    throw new HttpsError('permission-denied', 'No puedes revocar este pase.');
  }
  await ref.set({ revocado: true }, { merge: true });
  const disp = pase.dispositivos || [];
  for (const ruid of (pase.redimidoPor || [])) {
    const cambios = {};
    for (const id of disp) {
      cambios[`accesos.${id}`] = admin.firestore.FieldValue.delete();
    }
    if (Object.keys(cambios).length) {
      await db.doc(`usuarios/${ruid}`).update(cambios).catch(() => {});
    }
  }
  return { ok: true };
});

exports.consultarEstado = onCall(
  { secrets: [TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, ...SECRETS_HB] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Inicia sesión primero.');
    }
    const { dispositivoId } = request.data || {};
    if (!dispositivoId || typeof dispositivoId !== 'string') {
      throw new HttpsError('invalid-argument', 'Falta el dispositivoId.');
    }

    const { dispositivo, config } = await autorizar(request.auth.uid, dispositivoId);
    const codigo = config.codigo || 'switch_1';

    try {
      if ((dispositivo.proveedor || 'tuya') === 'homebridge') {
        const acc = await homebridge().accesorio(config.accesorioId);
        const vals = (acc && acc.values) || {};
        if (dispositivo.modo === 'cortina') {
          let posicion = null;
          if (typeof vals.CurrentPosition === 'number') {
            posicion = Math.max(0, Math.min(100, Math.round(vals.CurrentPosition)));
            if (config.posicionInvertida) posicion = 100 - posicion;
          }
          return { posicion };
        }
        const enc = typeof vals.On === 'boolean' ? vals.On : null;
        let bri = null;
        if (typeof vals.Brightness === 'number') bri = enc === false ? 0 : Math.round(vals.Brightness);
        return { encendido: enc, brillo: bri };
      }
      const estados = await tuya().estado(config.tuyaDeviceId);
      if (dispositivo.modo === 'cortina') {
        // Posición actual de la persiana (percent_state), para recordarla.
        const codigoPosEstado = config.codigoPosicionEstado || 'percent_state';
        const puntoPos = (estados || []).find((e) => e.code === codigoPosEstado);
        let posicion = null;
        if (puntoPos && typeof puntoPos.value === 'number') {
          posicion = Math.max(0, Math.min(100, Math.round(puntoPos.value)));
          if (config.posicionInvertida) posicion = 100 - posicion;
        }
        return { posicion };
      }
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
