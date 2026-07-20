const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret, defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');
const { TuyaClient } = require('./tuya');
const { HomebridgeClient } = require('./homebridge');
const { plantillaResetClave, enviar: enviarCorreo } = require('./correo');

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
// Envío de los correos propios (firebase functions:secrets:set RESEND_API_KEY).
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');

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

  if (dispositivo.modo === 'termostato') {
    // El accesorio puede ser Thermostat (TargetHeatingCoolingState/
    // TargetTemperature) o HeaterCooler/AC (Active + CoolingThresholdTemperature).
    const acc = await hb.accesorio(id);
    const vals = (acc && acc.values) || {};
    const esAC = ('Active' in vals) || ('TargetHeaterCoolerState' in vals);
    if (accion === 'temperatura') {
      const t = Number(valor);
      if (!Number.isFinite(t) || t < 4 || t > 38) {
        throw new HttpsError('invalid-argument', 'Temperatura fuera de rango (4–38°).');
      }
      const temp = Math.round(t * 2) / 2;
      await hb.setCaracteristica(id, esAC ? 'CoolingThresholdTemperature' : 'TargetTemperature', temp);
      return `temp ${t}°`;
    }
    if (accion === 'modo') {
      if (!['off', 'cool', 'heat', 'auto'].includes(valor)) {
        throw new HttpsError('invalid-argument', 'Modo de termostato no válido.');
      }
      if (esAC) {
        if (valor === 'off') {
          await hb.setCaracteristica(id, 'Active', 0);
        } else {
          await hb.setCaracteristica(id, 'Active', 1);
          const th = { auto: 0, heat: 1, cool: 2 };
          if (valor in th && ('TargetHeaterCoolerState' in vals)) {
            await hb.setCaracteristica(id, 'TargetHeaterCoolerState', th[valor]);
          }
        }
      } else {
        const mapa = { off: 0, heat: 1, cool: 2, auto: 3 };
        await hb.setCaracteristica(id, 'TargetHeatingCoolingState', mapa[valor]);
      }
      return `modo ${valor}`;
    }
    throw new HttpsError('invalid-argument', 'Acción de termostato no válida.');
  }

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
    // Apagar solo pone On=false (el accesorio conserva el brillo para recordarlo).
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
      } else if (dispositivo.modo === 'termostato') {
        throw new HttpsError('failed-precondition', 'El termostato por ahora solo funciona con Homebridge.');
      } else {
        if (accion !== 'encender' && accion !== 'apagar') {
          throw new HttpsError('invalid-argument', "La acción debe ser 'encender' o 'apagar'.");
        }
        accionRegistrada = accion;
        await tuya().enviarComandos(config.tuyaDeviceId, [
          { code: codigo, value: accion === 'encender' },
        ]);
      }
      // Termostato: recordamos lo fijado por si el accesorio no lo devuelve al leer.
      if (dispositivo.modo === 'termostato') {
        const estado = {};
        if (accion === 'temperatura') estado.temperaturaObjetivo = Math.round(Number(valor) * 2) / 2;
        if (accion === 'modo') estado.modoHVAC = valor;
        if (Object.keys(estado).length) {
          await db.doc(`dispositivos/${dispositivoId}/estado/termostato`).set(estado, { merge: true }).catch(() => {});
        }
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
  const { email, password, nombre, apellido, unidad, rol, dispositivos, inmuebles } = request.data || {};
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
    apellido: typeof apellido === 'string' ? apellido.trim().slice(0, 60) : '',
    unidad: unidad || '',
    email,
    rol: rol === 'admin' ? 'admin' : 'vecino',
    activo: true,
    dispositivos: Array.isArray(dispositivos) ? dispositivos : [],
    inmuebles: limpiarInmuebles(inmuebles) || [],
  });
  return { uid: user.uid };
});

exports.adminActualizarUsuario = onCall(async (request) => {
  await exigirAdmin(request);
  const { uid, nombre, apellido, unidad, rol, activo, dispositivos, password, inmuebles } = request.data || {};
  if (!uid || typeof uid !== 'string') {
    throw new HttpsError('invalid-argument', 'Falta el uid.');
  }
  if (uid === request.auth.uid && (activo === false || (rol && rol !== 'admin'))) {
    throw new HttpsError('failed-precondition', 'No puedes quitarte el acceso a ti mismo.');
  }
  const cambios = {};
  if (typeof nombre === 'string' && nombre) cambios.nombre = nombre;
  if (typeof apellido === 'string') cambios.apellido = apellido.trim().slice(0, 60);
  if (typeof unidad === 'string') cambios.unidad = unidad;
  if (rol === 'admin' || rol === 'vecino') cambios.rol = rol;
  if (typeof activo === 'boolean') cambios.activo = activo;
  if (Array.isArray(dispositivos)) cambios.dispositivos = dispositivos;
  const inmLimpios = limpiarInmuebles(inmuebles);
  if (inmLimpios) cambios.inmuebles = inmLimpios;
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

// Catálogo de inmuebles del condominio: los crea y asigna el admin.
const TIPOS_INMUEBLE = ['conjunto', 'residencias', 'edificio', 'quinta', 'casa', 'local', 'restaurant'];
// Normaliza la lista de inmuebles asignados a un usuario (id + snapshot del
// nombre/tipo para poder mostrarlo sin leer todo el catálogo).
function limpiarInmuebles(inmuebles) {
  if (!Array.isArray(inmuebles)) return null;
  return inmuebles
    .filter((x) => x && typeof x.id === 'string' && TIPOS_INMUEBLE.includes(x.tipo)
      && typeof x.nombre === 'string' && x.nombre.trim())
    .map((x) => ({ id: x.id, tipo: x.tipo, nombre: x.nombre.trim().slice(0, 60) }))
    .slice(0, 40);
}

// El propio usuario edita su nombre/apellido y elige sus inmuebles de un
// SELECTOR del catálogo (manda solo IDs; el tipo/nombre se resuelve del catálogo
// para que no pueda inventar inmuebles inexistentes). Nunca rol/activo/dispositivos.
exports.actualizarMiPerfil = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Inicia sesión primero.');
  }
  const uid = request.auth.uid;
  const snap = await db.doc(`usuarios/${uid}`).get();
  if (!snap.exists || snap.data().activo === false) {
    throw new HttpsError('permission-denied', 'Tu cuenta no está activa.');
  }
  // El vecino solo edita nombre/apellido. Los inmuebles los asigna el admin
  // (adminActualizarUsuario), no se aceptan aquí para que no se autoasignen.
  const { nombre, apellido } = request.data || {};
  const cambios = {};
  if (typeof nombre === 'string' && nombre.trim()) {
    cambios.nombre = nombre.trim().slice(0, 60);
  } else {
    throw new HttpsError('invalid-argument', 'El nombre no puede quedar vacío.');
  }
  if (typeof apellido === 'string') cambios.apellido = apellido.trim().slice(0, 60);
  await db.doc(`usuarios/${uid}`).set(cambios, { merge: true });
  return { ok: true, perfil: cambios };
});

// Crea o actualiza un inmueble del catálogo (solo admin).
exports.adminGuardarInmueble = onCall(async (request) => {
  await exigirAdmin(request);
  const { id, tipo, nombre, ciudad, estado, zona } = request.data || {};
  if (!TIPOS_INMUEBLE.includes(tipo)) {
    throw new HttpsError('invalid-argument', 'Tipo de inmueble no válido.');
  }
  if (typeof nombre !== 'string' || !nombre.trim()) {
    throw new HttpsError('invalid-argument', 'Falta el nombre del inmueble.');
  }
  const texto = (v) => (typeof v === 'string' ? v.trim() : '').slice(0, 60);
  const datos = {
    tipo,
    nombre: nombre.trim().slice(0, 60),
    ciudad: texto(ciudad),
    estado: texto(estado),
    zona: texto(zona),
  };
  let inmuebleId = id;
  if (id && typeof id === 'string') {
    await db.doc(`inmuebles/${id}`).set(datos, { merge: true });
    // Propaga el nuevo nombre/tipo al snapshot de los vecinos que lo tengan
    // (el snapshot solo guarda id/tipo/nombre, no la ubicación).
    const usuarios = await db.collection('usuarios').get();
    const batch = db.batch();
    let hayCambios = false;
    usuarios.forEach((s) => {
      const lista = s.data().inmuebles || [];
      if (lista.some((x) => x.id === id)) {
        hayCambios = true;
        batch.set(s.ref, {
          inmuebles: lista.map((x) => (x.id === id ? { id, tipo: datos.tipo, nombre: datos.nombre } : x)),
        }, { merge: true });
      }
    });
    if (hayCambios) await batch.commit();
  } else {
    inmuebleId = 'inm_' + crypto.randomBytes(8).toString('hex');
    datos.creado = admin.firestore.FieldValue.serverTimestamp();
    await db.doc(`inmuebles/${inmuebleId}`).set(datos);
  }
  return { ok: true, id: inmuebleId };
});

// Elimina un inmueble del catálogo y lo quita de los vecinos asignados.
exports.adminEliminarInmueble = onCall(async (request) => {
  await exigirAdmin(request);
  const { id } = request.data || {};
  if (!id || typeof id !== 'string') {
    throw new HttpsError('invalid-argument', 'Falta el id.');
  }
  await db.doc(`inmuebles/${id}`).delete();
  const usuarios = await db.collection('usuarios').get();
  const batch = db.batch();
  let hayCambios = false;
  usuarios.forEach((s) => {
    const lista = s.data().inmuebles || [];
    if (lista.some((x) => x.id === id)) {
      hayCambios = true;
      batch.set(s.ref, { inmuebles: lista.filter((x) => x.id !== id) }, { merge: true });
    }
  });
  if (hayCambios) await batch.commit();
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
  let tipoFinal = ['puerta', 'cortina', 'ascensor', 'luz', 'termostato', 'rele', 'otro'].includes(tipo) ? tipo : 'otro';
  let subFinal = ['bunker', 'porton'].includes(subtipo) ? subtipo : '';
  if (tipo === 'bunker') { tipoFinal = 'puerta'; subFinal = 'bunker'; } // compat con el tipo viejo
  if (tipoFinal !== 'puerta') subFinal = '';                            // el subtipo solo aplica a puerta
  await db.doc(`dispositivos/${id}`).set({
    nombre,
    tipo: tipoFinal,
    subtipo: subFinal,
    modo: ['interruptor', 'cortina', 'dimmer', 'termostato'].includes(modo) ? modo : 'pulso',
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
    let accesorios;
    try {
      accesorios = await homebridge().listarAccesorios();
    } catch (err) {
      throw new HttpsError('unavailable', `No pude conectar con Homebridge: ${err.message}`);
    }
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

// Diagnóstico: estado crudo de un accesorio de Homebridge (tipo + características + valores).
exports.adminAccesorioCrudo = onCall(
  { secrets: SECRETS_HB },
  async (request) => {
    await exigirAdmin(request);
    const { accesorioId } = request.data || {};
    if (!accesorioId) {
      throw new HttpsError('invalid-argument', 'Falta el accesorioId.');
    }
    let acc;
    try {
      acc = await homebridge().accesorio(accesorioId);
    } catch (err) {
      throw new HttpsError('unavailable', `No pude leer el accesorio: ${err.message}`);
    }
    return {
      tipo: (acc && acc.type) || '',
      humanType: (acc && acc.humanType) || '',
      values: (acc && acc.values) || {},
      caracteristicas: ((acc && acc.serviceCharacteristics) || []).map((c) => ({
        type: c.type,
        value: c.value,
        canWrite: c.canWrite === true,
        format: c.format,
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

// Flujo de invitación email-first: dado un pase válido y un correo, dice si ese
// correo ya tiene cuenta (para mostrar login) o no (para mostrar crear cuenta).
// Gated por un token de pase existente para limitar la enumeración de correos.
exports.verificarEmail = onCall(async (request) => {
  const { token, email } = request.data || {};
  if (!token || typeof token !== 'string') {
    throw new HttpsError('invalid-argument', 'Falta el enlace del pase.');
  }
  const paseSnap = await db.doc(`pases/${token}`).get();
  if (!paseSnap.exists) {
    throw new HttpsError('not-found', 'El enlace no es válido.');
  }
  const evento = paseSnap.data().evento || '';
  const porNombre = paseSnap.data().porNombre || '';
  const porApellido = paseSnap.data().porApellido || '';
  // Sin correo: solo devuelve info del pase (para mostrar el evento al abrir).
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return { evento, porNombre, porApellido };
  }
  try {
    const rec = await admin.auth().getUserByEmail(email.trim());
    const metodos = (rec.providerData || []).map((p) => p.providerId);
    return {
      existe: true,
      tieneClave: metodos.includes('password'),
      tieneGoogle: metodos.includes('google.com'),
      evento,
      porNombre,
      porApellido,
    };
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      return { existe: false, tieneClave: false, tieneGoogle: false, evento, porNombre, porApellido };
    }
    throw new HttpsError('internal', 'No se pudo verificar el correo.');
  }
});

// Correo propio de "olvidé mi clave": Firebase genera el enlace y nosotros
// mandamos el mensaje (en español, con el logo y el diseño de ViYi), en vez de
// usar la plantilla de Firebase, que es texto plano y no se puede editar.
//
// No se puede exigir sesión: justamente la pide quien no puede entrar. Por eso:
//  - Nunca revela si el correo existe (responde igual en los dos casos), para
//    que no sirva para averiguar quién tiene cuenta.
//  - Limita a un envío por minuto por correo, para que nadie lo use para
//    bombardear el buzón de otra persona.
exports.enviarResetClave = onCall({ secrets: [RESEND_API_KEY] }, async (request) => {
  const email = String((request.data || {}).email || '').trim().toLowerCase();
  if (!email.includes('@') || email.length > 200) {
    throw new HttpsError('invalid-argument', 'Escribe un correo válido.');
  }

  const id = crypto.createHash('sha256').update(email).digest('hex').slice(0, 40);
  const ref = db.doc(`resets/${id}`);
  const previo = await ref.get();
  const ultimo = previo.exists ? previo.data().cuando : null;
  if (ultimo && Date.now() - ultimo.toMillis() < 60 * 1000) {
    // Silencioso a propósito: no delata si el correo existe ni invita a reintentar.
    return { ok: true };
  }
  await ref.set({ cuando: admin.firestore.FieldValue.serverTimestamp() });

  let enlace;
  try {
    enlace = await admin.auth().generatePasswordResetLink(email, {
      url: 'https://www.viyi.ai/',
      handleCodeInApp: false,
    });
  } catch (err) {
    if (err.code === 'auth/user-not-found') return { ok: true };
    console.error('generatePasswordResetLink falló:', err.code || err.message);
    throw new HttpsError('internal', 'No se pudo enviar el correo.');
  }

  const { asunto, html, texto } = plantillaResetClave(enlace);
  try {
    await enviarCorreo({ apiKey: RESEND_API_KEY.value(), para: email, asunto, html, texto });
  } catch (err) {
    console.error('Envío de correo falló:', err.message);
    throw new HttpsError('internal', 'No se pudo enviar el correo.');
  }
  return { ok: true };
});

// Genera un enlace de pase con los dispositivos y la duración elegidos.
exports.crearPase = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Inicia sesión primero.');
  }
  const uid = request.auth.uid;
  const { dispositivos, duracion, multiuso, evento } = request.data || {};
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
  // Token corto y URL-safe (12 chars, 72 bits) para un enlace más corto.
  const token = crypto.randomBytes(9).toString('base64url');
  await db.doc(`pases/${token}`).set({
    por: uid,
    porNombre: usuario.nombre || '',
    porApellido: usuario.apellido || '',
    dispositivos: compartir,
    evento: (typeof evento === 'string' ? evento.trim() : '').slice(0, 60),
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
  const { token, nombre, apellido } = request.data || {};
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
  // Denormaliza evento y nombre del invitador en el acceso, porque el invitado
  // no puede leer el pase (reglas) para mostrarlos en su tarjeta.
  const accesos = {};
  for (const id of (pase.dispositivos || [])) {
    accesos[id] = {
      expira,
      por: pase.por,
      token,
      evento: pase.evento || '',
      porNombre: pase.porNombre || '',
      porApellido: pase.porApellido || '',
      creado: pase.creado || null,
    };
  }

  const userRef = db.doc(`usuarios/${uid}`);
  const userSnap = await userRef.get();
  const emailInvitado = request.auth.token.email || '';
  const perfilPrevio = userSnap.exists ? userSnap.data() : null;
  const nombreDado = (typeof nombre === 'string' && nombre.trim()) || '';
  const apellidoDado = (typeof apellido === 'string' && apellido.trim()) || '';
  let nombreInvitado;
  let apellidoInvitado;
  if (perfilPrevio) {
    // Usuario existente: respeta lo que ya tenga.
    nombreInvitado = perfilPrevio.nombre || nombreDado || emailInvitado.split('@')[0] || 'Invitado';
    apellidoInvitado = perfilPrevio.apellido || apellidoDado || '';
  } else if (nombreDado) {
    // Registro con formulario (nombre y apellido por separado).
    nombreInvitado = nombreDado;
    apellidoInvitado = apellidoDado;
  } else {
    // Sin formulario (p.ej. Google): separa el displayName en nombre + apellido.
    const full = String(request.auth.token.name || emailInvitado.split('@')[0] || 'Invitado').trim();
    const partes = full.split(/\s+/);
    nombreInvitado = partes[0] || 'Invitado';
    apellidoInvitado = apellidoDado || partes.slice(1).join(' ');
  }
  if (!userSnap.exists) {
    await userRef.set({
      nombre: nombreInvitado,
      apellido: typeof apellido === 'string' ? apellido.trim().slice(0, 60) : '',
      unidad: '',
      email: emailInvitado,
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

  // Cuenta una sola vez por usuario: si este uid ya canjeó, no suma otro canje
  // (la misma persona puede volver a usar el enlace; el acceso ya se refrescó
  // arriba). Solo aplica a multiuso — el de un uso ya se bloqueó por `usado`.
  const yaCanjeo = Array.isArray(pase.redimidoPor) && pase.redimidoPor.includes(uid);
  const cambios = {};
  if (!yaCanjeo) {
    cambios.usos = admin.firestore.FieldValue.increment(1);
    cambios.redimidoPor = admin.firestore.FieldValue.arrayUnion(uid);
    // Quién canjeó el pase (para mostrarlo en "Mis pases"). Timestamp.now()
    // porque serverTimestamp() no se permite dentro de un array.
    cambios.invitados = admin.firestore.FieldValue.arrayUnion({
      uid,
      nombre: nombreInvitado,
      apellido: apellidoInvitado,
      email: emailInvitado,
      cuando: admin.firestore.Timestamp.now(),
    });
  }
  if (pase.multiuso !== true) cambios.usado = true;
  if (Object.keys(cambios).length) await ref.set(cambios, { merge: true });

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
    // El admin puede revocar cualquier pase; el resto, solo los suyos.
    const me = await db.doc(`usuarios/${uid}`).get();
    if (!me.exists || me.data().rol !== 'admin') {
      throw new HttpsError('permission-denied', 'No puedes revocar este pase.');
    }
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
  // minInstances: 1 mantiene una instancia despierta 24/7 para evitar el cold
  // start al cargar la app tras inactividad (tiene costo: instancia siempre on).
  { secrets: [TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, ...SECRETS_HB], minInstances: 1 },
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
        if (dispositivo.modo === 'termostato') {
          const esAC = ('Active' in vals) || ('TargetHeaterCoolerState' in vals);
          let objetivo = null;
          let modoHVAC = null;
          if (esAC) {
            objetivo = typeof vals.CoolingThresholdTemperature === 'number' ? vals.CoolingThresholdTemperature
              : (typeof vals.HeatingThresholdTemperature === 'number' ? vals.HeatingThresholdTemperature : null);
            modoHVAC = (vals.Active === 1 || vals.Active === true) ? 'cool' : 'off';
          } else {
            const modos = { 0: 'off', 1: 'heat', 2: 'cool', 3: 'auto' };
            objetivo = typeof vals.TargetTemperature === 'number' ? vals.TargetTemperature : null;
            modoHVAC = modos[vals.TargetHeatingCoolingState] || null;
          }
          // Respaldo con lo último fijado, si el accesorio no lo reporta.
          if (objetivo === null || modoHVAC === null) {
            const snap = await db.doc(`dispositivos/${dispositivoId}/estado/termostato`).get().catch(() => null);
            const e = (snap && snap.exists) ? snap.data() : {};
            if (objetivo === null && typeof e.temperaturaObjetivo === 'number') objetivo = e.temperaturaObjetivo;
            if (modoHVAC === null && e.modoHVAC) modoHVAC = e.modoHVAC;
          }
          return {
            temperaturaActual: typeof vals.CurrentTemperature === 'number' ? vals.CurrentTemperature : null,
            temperaturaObjetivo: objetivo,
            modoHVAC,
          };
        }
        if (dispositivo.modo === 'cortina') {
          let posicion = null;
          if (typeof vals.CurrentPosition === 'number') {
            posicion = Math.max(0, Math.min(100, Math.round(vals.CurrentPosition)));
            if (config.posicionInvertida) posicion = 100 - posicion;
          }
          return { posicion };
        }
        // On puede venir como boolean o como número (0/1); si falta, se infiere
        // del brillo (>0 = encendido).
        let enc = null;
        if (typeof vals.On === 'boolean') enc = vals.On;
        else if (typeof vals.On === 'number') enc = vals.On !== 0;
        else if (typeof vals.Brightness === 'number') enc = vals.Brightness > 0;
        let bri = null;
        let briMem = null;
        if (typeof vals.Brightness === 'number') {
          briMem = Math.round(vals.Brightness); // brillo guardado (para recordar)
          bri = enc ? briMem : 0;
        }
        return { encendido: enc, brillo: bri, brilloMemoria: briMem };
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
      let brilloMemoria = null;
      if (puntoBrillo && typeof puntoBrillo.value === 'number') {
        const brilloMax = Number(config.brilloMax) || 1000;
        const brilloMin = Math.max(1, Math.round(brilloMax * 0.05));
        const pct = ((puntoBrillo.value - brilloMin) / (brilloMax - brilloMin)) * 100;
        brilloMemoria = Math.max(0, Math.min(100, Math.round(pct))); // brillo guardado
        // Solo mostramos brillo si está confirmado encendido; si no, 0 (apagado).
        brillo = encendido === true ? brilloMemoria : 0;
      }
      return { encendido, brillo, brilloMemoria };
    } catch (err) {
      throw new HttpsError('internal', 'No se pudo consultar el estado del dispositivo.');
    }
  }
);
