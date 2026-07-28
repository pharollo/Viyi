const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret, defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');
const { GoogleAuth } = require('google-auth-library');
const { TuyaClient } = require('./tuya');
const { HomebridgeClient } = require('./homebridge');
const { plantillaResetClave, plantillaAccesoDado, enviar: enviarCorreo } = require('./correo');

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

// maxInstances: 1 a propósito. La cuota de Cloud Run "total allowable CPU per
// project per region" (20 CPU en este proyecto, y Google no da más porque el
// uso real no lo justifica) cuenta el TECHO de todas las funciones juntas:
// nº funciones × maxInstances × cpu. Con 23 funciones a 3 instancias pedíamos
// 69 CPU contra 20 disponibles, y por eso los despliegues fallaban con
// "Container Healthcheck failed / Quota exceeded". Con 1 el techo baja a 23.
// No perdemos capacidad: cada instancia atiende 80 peticiones a la vez
// (concurrency por defecto), de sobra para un condominio.
setGlobalOptions({ region: 'us-central1', maxInstances: 1 });

// Nombres y apellidos siempre en Title Case, con las partículas en minúscula
// ("María Pérez de la Cruz"). Se normaliza AQUÍ y no en cada formulario para
// que dé igual por dónde entró el dato: registro de invitado, Google, panel de
// admin o "Mi perfil". Recorta a 60 y colapsa los espacios de más.
const MENORES_NOMBRE = new Set([
  'de', 'del', 'la', 'las', 'los', 'y', 'e', 'da', 'das', 'do', 'dos',
  'van', 'von', 'der', 'den', 'ter', 'di', 'du', 'le', 'bin', 'ibn', 'san',
]);
function nombrePropio(s) {
  return String(s == null ? '' : s)
    .trim().replace(/\s+/g, ' ').slice(0, 60)
    .split(' ')
    .map((p, i) => {
      if (!p) return p;
      const min = p.toLocaleLowerCase('es');
      if (i > 0 && MENORES_NOMBRE.has(min)) return min;
      // Si la palabra trae mayúscula interna se respeta tal cual: es
      // intencional (McDonald, DeLuca). Solo se normaliza lo que viene todo
      // en minúsculas o todo en mayúsculas ("carlos" y "CARLOS" → "Carlos").
      const uniforme = p === min || p === p.toLocaleUpperCase('es');
      const base = uniforme ? min : p;
      return base.charAt(0).toLocaleUpperCase('es') + base.slice(1);
    })
    .join(' ');
}

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
// Aspectos del botón: los pone el admin por dispositivo (aspecto) y el vecino
// puede elegir el suyo en su vestuario (usuarios/{uid}.aspectos). 'normal' es
// válido a propósito: es la forma de que el vecino vuelva al botón de siempre
// aunque el admin le haya puesto otro.
const ASPECTOS_VALIDOS = ['normal', 'jet', 'argentina', 'bordado', 'hal', 'neon', 'acero', 'cristal', 'pop', 'cobre', 'rueda', 'ascensor', 'sabiem', 'bronce', 'lobby', 'mando'];

// Los de arriba viven en el código; los de la galería (colección `skins`) son
// datos que el admin publica sin desplegar, así que la lista no puede ser fija.
// Se cachean en memoria de la instancia: cambian poquísimo y esto corre en cada
// guardado. TTL corto para que un skin recién publicado se pueda elegir ya.
let skinsCache = { ids: null, hasta: 0 };
async function aspectosPermitidos() {
  if (skinsCache.ids && Date.now() < skinsCache.hasta) return skinsCache.ids;
  let ids = new Set(ASPECTOS_VALIDOS);
  try {
    const snap = await db.collection('skins').select().get();
    snap.docs.forEach((d) => ids.add(d.id));
  } catch (e) {
    // Sin galería disponible se sigue con los de código: peor es rechazar un
    // aspecto que el vecino ya tenía puesto.
    if (skinsCache.ids) return skinsCache.ids;
  }
  skinsCache = { ids, hasta: Date.now() + 60000 };
  return ids;
}

const DURACIONES_MS = {
  '30m': 1800000, '1h': 3600000, '2h': 7200000, '3h': 10800000,
  '4h': 14400000, '5h': 18000000, '6h': 21600000, '12h': 43200000,
  '24h': 86400000, '2d': 172800000, '3d': 259200000, '7d': 604800000,
};
// Tokens válidos = los del mapa + 'indef'. Se valida contra esto en crearPase y
// darAcceso: un token desconocido NO debe pasar, porque msDeDuracion devolvería
// null y se interpretaría como "sin vencimiento" por error.
const DURACIONES_VALIDAS = new Set([...Object.keys(DURACIONES_MS), 'indef']);
const msDeDuracion = (d) => (d === 'indef' ? null : DURACIONES_MS[d] || null);
// Sentinela "sin vencimiento" (fácil de comparar en reglas y backend).
const FIN_INDEFINIDO = admin.firestore.Timestamp.fromDate(new Date('9999-12-31T00:00:00Z'));

// El registro va PARTIDO en dos a propósito:
//   · `registros/{id}`               → qué pasó y dónde (sin identificar a nadie)
//   · `registros/{id}/privado/quien` → quién lo hizo
// Las reglas de Firestore no pueden ocultar campos —dan el documento entero o
// nada—, así que la única forma de que el admin de un edificio vea la actividad
// de su torre SIN saber qué vecino fue es separar la identidad en otro
// documento. Quién fue es dato privado de la app: solo el dueño.
async function registrar({ uid, usuario, dispositivoId, dispositivoNombre, accion, exito, detalle, inmueble }) {
  // `inmueble` es lo que permite filtrar el historial por edificio. Si el
  // llamador no lo trae, se busca: un registro sin inmueble sería invisible
  // para el admin de su propio edificio.
  let inm = typeof inmueble === 'string' ? inmueble : null;
  if (inm === null) {
    const snap = await db.doc(`dispositivos/${dispositivoId}`).get().catch(() => null);
    inm = snap && snap.exists ? (snap.data().inmueble || '') : '';
  }
  const ref = await db.collection('registros').add({
    dispositivoId,
    dispositivoNombre: dispositivoNombre || dispositivoId,
    inmueble: inm,
    accion,
    exito,
    detalle: detalle || '',
    fecha: admin.firestore.FieldValue.serverTimestamp(),
  });
  await ref.collection('privado').doc('quien').set({
    uid,
    usuarioNombre: (usuario && usuario.nombre) || '(desconocido)',
    unidad: (usuario && usuario.unidad) || '',
  }).catch(() => {});
  return ref;
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
  // El admin global sigue pudiendo todo; el de un edificio, solo lo suyo (se
  // resuelve más abajo con el inmueble del dispositivo, junto a la herencia).
  const alcance = usuario.rol === 'admin' ? alcanceDe(usuario) : undefined;
  const esAdminGlobal = usuario.rol === 'admin' && !alcance;
  const permitidos = usuario.dispositivos || [];
  let tienePermiso = esAdminGlobal || permitidos.includes(dispositivoId);
  // Acceso temporal por un pase compartido: válido si no ha vencido.
  if (!tienePermiso) {
    const acceso = (usuario.accesos || {})[dispositivoId];
    if (acceso && acceso.expira && typeof acceso.expira.toMillis === 'function') {
      tienePermiso = acceso.expira.toMillis() > Date.now();
    }
  }
  // Acceso heredado del inmueble. Va al final a propósito: solo se lee el
  // dispositivo si las otras vías no alcanzaron, para no gastar una lectura en
  // el camino habitual.
  if (!tienePermiso) {
    if (alcance) {
      // Admin de edificio: puede con lo que esté dentro de su alcance.
      const snap = await db.doc(`dispositivos/${dispositivoId}`).get();
      const inm = snap.exists ? (snap.data().inmueble || '') : '';
      tienePermiso = !!inm && alcance.has(inm);
    } else {
      tienePermiso = await alcanzaPorInmueble(usuario, dispositivoId);
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
  const alcance = alcanceDe(await exigirAdmin(request));
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
  const inmInicial = limpiarInmuebles(inmuebles) || [];
  exigirInmueblesAsignables(alcance, inmInicial);
  // Solo el dueño (admin global) crea administradores. Un admin de edificio
  // crea vecinos y nada más: si no, podría fabricarse pares y escalar.
  if (alcance && rol === 'admin') {
    throw new HttpsError('permission-denied', 'No puedes crear administradores.');
  }
  await db.doc(`usuarios/${user.uid}`).set({
    nombre: nombrePropio(nombre),
    apellido: nombrePropio(apellido),
    unidad: unidad || '',
    email,
    rol: rol === 'admin' ? 'admin' : 'vecino',
    activo: true,
    dispositivos: Array.isArray(dispositivos) ? dispositivos : [],
    inmuebles: inmInicial,
    inmueblesIds: await conAncestros(inmInicial.map((x) => x.id)),
  });
  return { uid: user.uid };
});

exports.adminActualizarUsuario = onCall(async (request) => {
  const alcanceMio = alcanceDe(await exigirAdmin(request));
  const { uid, nombre, apellido, unidad, rol, activo, dispositivos, password, inmuebles, administra } = request.data || {};
  if (!uid || typeof uid !== 'string') {
    throw new HttpsError('invalid-argument', 'Falta el uid.');
  }
  const destinoSnap = await db.doc(`usuarios/${uid}`).get();
  if (!destinoSnap.exists) {
    throw new HttpsError('not-found', 'Ese vecino no existe.');
  }
  // Un admin de edificio solo toca vecinos de su alcance, no puede cambiar
  // roles ni repartir alcance (ambas cosas son escalada de privilegios).
  if (alcanceMio) {
    if (!vecinoEnAlcance(alcanceMio, destinoSnap.data())) {
      throw new HttpsError('permission-denied', 'Ese vecino no pertenece a lo que administras.');
    }
    if (rol !== undefined || administra !== undefined) {
      throw new HttpsError('permission-denied', 'No puedes cambiar roles ni alcance.');
    }
  }
  if (uid === request.auth.uid && (activo === false || (rol && rol !== 'admin'))) {
    throw new HttpsError('failed-precondition', 'No puedes quitarte el acceso a ti mismo.');
  }
  const cambios = {};
  if (typeof nombre === 'string' && nombre) cambios.nombre = nombrePropio(nombre);
  if (typeof apellido === 'string') cambios.apellido = nombrePropio(apellido);
  if (typeof unidad === 'string') cambios.unidad = unidad;
  if (rol === 'admin' || rol === 'vecino') cambios.rol = rol;
  // Alcance del administrador: solo lo reparte el dueño. Vacío = admin global.
  if (!alcanceMio && Array.isArray(administra)) {
    const limpio = administra.filter((x) => typeof x === 'string' && x);
    cambios.administra = limpio;
    cambios.administraIds = await subarbolInmuebles(limpio);
  }
  if (typeof activo === 'boolean') cambios.activo = activo;
  if (Array.isArray(dispositivos)) cambios.dispositivos = dispositivos;
  const inmLimpios = limpiarInmuebles(inmuebles);
  exigirInmueblesAsignables(alcanceMio, inmLimpios);
  if (inmLimpios) {
    cambios.inmuebles = inmLimpios;
    // La cadena expandida (asignados + ancestros) es lo que consultan los
    // chequeos de acceso y las reglas de Firestore.
    cambios.inmueblesIds = await conAncestros(inmLimpios.map((x) => x.id));
  }
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
const TIPOS_INMUEBLE = ['conjunto', 'residencias', 'edificio', 'oficinas', 'apartamento', 'oficina', 'quinta', 'casa', 'local', 'galpon', 'restaurant'];
// ---- Jerarquía de inmuebles: conjunto -> edificio -> apartamento ----
// Cada inmueble puede tener `padre`. La herencia va SOLO hacia arriba: quien
// tiene asignado el apto 3B alcanza también las áreas comunes de su edificio y
// del conjunto. Al revés NO: tener el edificio no da los controles de todos sus
// apartamentos.
//
// `usuarios/{uid}.inmueblesIds` guarda la cadena YA EXPANDIDA (lo asignado más
// sus ancestros). Existe por dos razones: las reglas de Firestore no pueden
// recorrer una lista de mapas ni subir un árbol, y así los chequeos de acceso
// comparan contra una lista plana, igual de simples que antes.
const MAX_NIVELES_INMUEBLE = 6;   // corta ciclos y cadenas absurdas

async function conAncestros(ids) {
  const vistos = new Set();
  let frente = [...new Set((ids || []).filter((x) => typeof x === 'string' && x))];
  for (let nivel = 0; nivel < MAX_NIVELES_INMUEBLE && frente.length; nivel++) {
    frente.forEach((id) => vistos.add(id));
    const snaps = await Promise.all(frente.map((id) => db.doc(`inmuebles/${id}`).get()));
    frente = snaps
      .map((s) => (s.exists ? (s.data().padre || '') : ''))
      .filter((p) => p && !vistos.has(p));
  }
  return [...vistos];
}

// Los inmuebles que alcanza este usuario. Tolera registros viejos sin el espejo
// (se derivan del snapshot, sin ancestros) para no dejar a nadie fuera mientras
// no se hayan vuelto a guardar.
function inmueblesDelUsuario(usuario) {
  if (Array.isArray(usuario.inmueblesIds) && usuario.inmueblesIds.length) return usuario.inmueblesIds;
  return (usuario.inmuebles || []).map((x) => x && x.id).filter(Boolean);
}

// ¿Este usuario alcanza este dispositivo por el inmueble al que pertenece?
async function alcanzaPorInmueble(usuario, dispositivoId) {
  const mios = inmueblesDelUsuario(usuario);
  if (!mios.length) return false;
  const snap = await db.doc(`dispositivos/${dispositivoId}`).get();
  const inm = snap.exists ? (snap.data().inmueble || '') : '';
  return !!inm && mios.includes(inm);
}

// Recalcula `inmueblesIds` de TODOS los vecinos. Se llama al tocar el catálogo
// porque cambiar un padre altera la cadena de cualquier descendiente, no solo
// del inmueble editado: recorrer todos es O(vecinos) y en un condominio son
// decenas, así que es más barato que razonar quién quedó afectado — y elimina
// de raíz que la lista expandida se quede vieja.
async function resincronizarInmuebles() {
  const usuarios = await db.collection('usuarios').get();
  const batch = db.batch();
  let hay = false;
  for (const snap of usuarios.docs) {
    const d = snap.data();
    const cambios = {};
    const asignados = (d.inmuebles || []).map((x) => x && x.id).filter(Boolean);
    const expandidos = await conAncestros(asignados);
    const antes = d.inmueblesIds || [];
    if (antes.length !== expandidos.length || expandidos.some((x) => !antes.includes(x))) {
      cambios.inmueblesIds = expandidos;
    }
    // El alcance del admin también depende del árbol: mover un padre cambia
    // qué queda dentro de su edificio.
    if (Array.isArray(d.administra) && d.administra.length) {
      const sub = await subarbolInmuebles(d.administra);
      const antesSub = d.administraIds || [];
      if (antesSub.length !== sub.length || sub.some((x) => !antesSub.includes(x))) {
        cambios.administraIds = sub;
      }
    }
    if (Object.keys(cambios).length) { hay = true; batch.set(snap.ref, cambios, { merge: true }); }
  }
  if (hay) await batch.commit();
}

// ---- Alcance del administrador (admin por edificio) ----
// `usuarios/{uid}.administra` = inmuebles que administra, asignados por el
// dueño. **Vacío = admin GLOBAL** (el dueño de ViYi), que es como se comportaba
// todo hasta ahora: por eso el cambio no le quita nada a nadie.
// `administraIds` = ese alcance expandido HACIA ABAJO (el inmueble y todos sus
// descendientes).
//
// ⚠️ Las dos herencias van en direcciones OPUESTAS, y es a propósito:
//   · el VECINO hereda hacia ARRIBA  → su apto alcanza lo común del edificio
//   · el ADMIN  hereda hacia ABAJO   → quien administra la torre administra sus aptos
// Confundirlas sería un agujero: hacia arriba le daría al admin de una torre el
// portón del conjunto entero.
async function subarbolInmuebles(ids) {
  const raices = [...new Set((ids || []).filter((x) => typeof x === 'string' && x))];
  if (!raices.length) return [];
  // Se traen todos y se baja en memoria: `padre` apunta hacia arriba, así que
  // bajar con consultas serían N viajes por nivel. En un condominio son decenas.
  const todos = await db.collection('inmuebles').get();
  const hijos = new Map();
  todos.forEach((snap) => {
    const padre = snap.data().padre || '';
    if (!hijos.has(padre)) hijos.set(padre, []);
    hijos.get(padre).push(snap.id);
  });
  const vistos = new Set();
  let frente = raices;
  for (let n = 0; n < MAX_NIVELES_INMUEBLE && frente.length; n++) {
    frente.forEach((id) => vistos.add(id));
    frente = frente.flatMap((id) => hijos.get(id) || []).filter((id) => !vistos.has(id));
  }
  return [...vistos];
}

// null = sin límite (admin global). Set = solo esos inmuebles.
function alcanceDe(usuario) {
  const ids = usuario.administraIds || usuario.administra || [];
  return ids.length ? new Set(ids) : null;
}

// Corta si el admin no alcanza ese inmueble. Un dispositivo o inmueble SIN
// inmueble asignado solo lo toca el admin global: si no, un admin de edificio
// podría apropiarse de lo que está suelto.
function exigirInmueble(alcance, inmuebleId, queEs = 'Eso') {
  if (!alcance) return;
  if (!inmuebleId || !alcance.has(inmuebleId)) {
    throw new HttpsError('permission-denied', `${queEs} no pertenece a lo que administras.`);
  }
}

// ¿Este vecino cae dentro de lo que administro? Se compara contra sus inmuebles
// ASIGNADOS (no la cadena expandida): la expandida incluye los ancestros, que
// están POR ENCIMA del admin de un edificio y no le corresponden.
function vecinoEnAlcance(alcance, usuario) {
  if (!alcance) return true;
  return (usuario.inmuebles || []).some((x) => x && alcance.has(x.id));
}

// Los inmuebles que un admin puede asignar: solo los de su alcance.
function exigirInmueblesAsignables(alcance, lista) {
  if (!alcance) return;
  for (const x of lista || []) exigirInmueble(alcance, x && x.id, 'Ese inmueble');
}

// Dispositivos de la lista que este usuario puede compartir: los suyos
// explícitos más los que hereda de sus inmuebles. Lo recibido por un pase NO se
// re-comparte (siempre fue así y se mantiene).
async function puedeCompartir(usuario, ids) {
  const pedidos = [...new Set((ids || []).filter((x) => typeof x === 'string'))];
  const alcanceAdmin = usuario.rol === 'admin' ? alcanceDe(usuario) : undefined;
  if (usuario.rol === 'admin' && !alcanceAdmin) return pedidos;   // admin global
  const alcanza = new Set(usuario.dispositivos || []);
  // Un admin de edificio comparte lo de su alcance; un vecino, lo de su
  // inmueble. La lista contra la que se compara es la única diferencia.
  const mios = alcanceAdmin ? [...alcanceAdmin] : inmueblesDelUsuario(usuario);
  const fuera = pedidos.filter((id) => !alcanza.has(id));
  if (mios.length && fuera.length) {
    const snaps = await Promise.all(fuera.map((id) => db.doc(`dispositivos/${id}`).get()));
    snaps.forEach((snap) => {
      const inm = snap.exists ? (snap.data().inmueble || '') : '';
      if (inm && mios.includes(inm)) alcanza.add(snap.id);
    });
  }
  return pedidos.filter((id) => alcanza.has(id));
}

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
  // El vecino edita nombre/apellido y el aspecto de sus botones (su vestuario).
  // Los inmuebles los asigna el admin (adminActualizarUsuario), no se aceptan
  // aquí para que no se autoasignen.
  const { nombre, apellido, aspectos } = request.data || {};
  const cambios = {};
  const descartados = []; // lo que no pasó validación, para que la app lo diga
  // El vestuario se guarda solo: se puede mandar sin tocar el nombre.
  if (aspectos && typeof aspectos === 'object' && !Array.isArray(aspectos)) {
    const permitidos = await aspectosPermitidos();
    const limpio = {};
    // Las claves son ids de documento de Firestore. NO se les puede exigir el
    // formato del panel de administración (minúsculas y guiones): los
    // dispositivos creados a mano antes del panel traen mayúsculas, guion bajo
    // o espacios, y se descartaban en silencio (el vecino elegía el estilo y al
    // refrescar lo perdía). Aquí solo se rechaza lo que Firestore no admite.
    for (const [dispId, asp] of Object.entries(aspectos)) {
      if (!dispId || dispId.length > 120 || /[.\/[\]*`]/.test(dispId) || /^__.*__$/.test(dispId)) {
        descartados.push(dispId);
        continue;
      }
      if (!permitidos.has(asp)) { descartados.push(`${dispId}=${asp}`); continue; }
      limpio[dispId] = asp;
    }
    cambios.aspectos = limpio;
  }
  if (nombre !== undefined || cambios.aspectos === undefined) {
    if (typeof nombre === 'string' && nombre.trim()) {
      cambios.nombre = nombrePropio(nombre);
    } else {
      throw new HttpsError('invalid-argument', 'El nombre no puede quedar vacío.');
    }
  }
  if (typeof apellido === 'string') cambios.apellido = nombrePropio(apellido);
  await db.doc(`usuarios/${uid}`).set(cambios, { merge: true });
  return { ok: true, perfil: cambios, descartados };
});

// ---- OAuth de Tuya: que un vecino autorice SUS propios dispositivos ----
// A dónde vuelve Tuya tras la autorización. Se DERIVA del proyecto y la región
// en vez de ser un `defineString`: el workflow solo escribe TUYA_BASE_URL en
// functions/.env, así que un parámetro nuevo se queda sin valor y tumba el
// despliegue en CI (--non-interactive muere pidiéndolo). Y esta URL no cambia
// nunca. Tiene que estar registrada IGUAL en la consola de Tuya, y en el mismo
// centro de datos que TUYA_BASE_URL.
const TUYA_REDIRECT = `https://us-central1-${process.env.GCLOUD_PROJECT || 'viyi-25a09'}.cloudfunctions.net/tuyaCallback`;

// Le da al vecino el enlace para autorizar. El `state` lleva su uid firmado:
// es lo que permite saber quién volvió, y va firmado para que nadie pueda
// atribuirse la autorización de otro.
exports.vincularTuya = onCall(
  { secrets: [TUYA_CLIENT_ID, TUYA_CLIENT_SECRET] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Inicia sesión primero.');
    }
    const uid = request.auth.uid;
    const snap = await db.doc(`usuarios/${uid}`).get();
    if (!snap.exists || snap.data().activo === false) {
      throw new HttpsError('permission-denied', 'Tu cuenta no está activa.');
    }
    const firma = crypto.createHmac('sha256', TUYA_CLIENT_SECRET.value())
      .update(uid).digest('hex').slice(0, 32);
    const ya = await db.doc(`tuyaAuth/${uid}`).get();
    return {
      url: tuya().urlAutorizacion(TUYA_REDIRECT, `${uid}.${firma}`),
      vinculada: ya.exists,
    };
  },
);

// Aquí vuelve el vecino tras autorizar. Cambia el código por su token y lo
// guarda. El token NO se expone nunca al cliente: vive en una colección que las
// reglas niegan a todo el mundo y solo tocan las Functions.
exports.tuyaCallback = onRequest(
  { secrets: [TUYA_CLIENT_ID, TUYA_CLIENT_SECRET] },
  async (req, res) => {
    const pagina = (titulo, detalle) => res.status(200).send(
      `<!doctype html><meta charset="utf-8">`
      + `<meta name="viewport" content="width=device-width,initial-scale=1">`
      + `<body style="background:#1b1c1e;color:#e8eaec;font:16px/1.5 system-ui;`
      + `display:flex;flex-direction:column;align-items:center;justify-content:center;`
      + `height:100vh;margin:0;padding:24px;text-align:center">`
      + `<h2 style="margin:0 0 8px">${titulo}</h2>`
      + `<p style="color:#8d9297;margin:0;max-width:32ch">${detalle}</p></body>`);

    const { code, state } = req.query || {};
    if (!code || !state) {
      return pagina('Faltan datos', 'Tuya no devolvió el código de autorización. Vuelve a intentarlo desde la app.');
    }
    const [uid, firma] = String(state).split('.');
    const esperada = crypto.createHmac('sha256', TUYA_CLIENT_SECRET.value())
      .update(uid || '').digest('hex').slice(0, 32);
    if (!uid || firma !== esperada) {
      console.error('tuyaCallback: state inválido');
      return pagina('Enlace no válido', 'Vuelve a empezar desde la app.');
    }
    try {
      const r = await tuya().tokenPorCodigo(String(code));
      await db.doc(`tuyaAuth/${uid}`).set({
        accessToken: r.access_token,
        refreshToken: r.refresh_token,
        expira: Date.now() + (r.expire_time || 0) * 1000,
        uidTuya: r.uid || '',
        vinculado: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return pagina('Cuenta vinculada ✓', 'Ya puedes cerrar esta página y volver a ViYi.');
    } catch (err) {
      console.error('tuyaCallback', err && err.message);
      return pagina('No se pudo vincular', String((err && err.message) || err));
    }
  },
);

// Lista los dispositivos que el proyecto de Tuya alcanza, para no tener que
// copiar el Device ID a mano de la consola. Marca cuáles ya están dados de alta
// y de qué cuenta vinculada viene cada uno (`uid`), que es lo que permite
// rellenar solo la etiqueta de cuenta cuando haya más de una.
exports.adminListarDispositivosTuya = onCall(
  { secrets: [TUYA_CLIENT_ID, TUYA_CLIENT_SECRET] },
  async (request) => {
    await exigirAdmin(request);
    const { ruta, dispositivos } = await tuya().listarTodos();
    // Los que ya están en ViYi, para no ofrecerlos como nuevos.
    const snap = await db.collection('dispositivos').get();
    const yaEstan = new Map();
    for (const doc of snap.docs) {
      const cfg = await db.doc(`dispositivos/${doc.id}/privado/tuya`).get();
      const tid = cfg.exists ? (cfg.data().tuyaDeviceId || '') : '';
      if (tid) yaEstan.set(tid, doc.data().nombre || doc.id);
    }
    // Nombre de cada cuenta vinculada: se resuelve UNA vez por cuenta, no por
    // dispositivo. Si Tuya no lo da, se queda el uid (mejor eso que nada).
    const nombres = new Map();
    for (const uid of new Set((dispositivos || []).map((d) => d.uid || d.owner_id).filter(Boolean))) {
      try {
        const info = await tuya().infoUsuario(uid);
        nombres.set(uid, info.email || info.username || info.nick_name || uid);
      } catch (e) {
        nombres.set(uid, uid);
      }
    }
    return {
      ruta,
      dispositivos: (dispositivos || []).map((d) => ({
        id: d.id || d.uuid || '',
        nombre: d.name || d.product_name || '(sin nombre)',
        producto: d.product_name || '',
        online: d.online === true,
        cuenta: d.uid || d.owner_id || '',
        cuentaNombre: nombres.get(d.uid || d.owner_id) || '',
        yaEsta: yaEstan.get(d.id || d.uuid || '') || '',
      })).filter((d) => d.id),
    };
  },
);

// Crea o actualiza un inmueble del catálogo (solo admin).
exports.adminGuardarInmueble = onCall(async (request) => {
  const alcance = alcanceDe(await exigirAdmin(request));
  const { id, tipo, nombre, ciudad, estado, zona, padre } = request.data || {};
  if (!TIPOS_INMUEBLE.includes(tipo)) {
    throw new HttpsError('invalid-argument', 'Tipo de inmueble no válido.');
  }
  if (typeof nombre !== 'string' || !nombre.trim()) {
    throw new HttpsError('invalid-argument', 'Falta el nombre del inmueble.');
  }
  const texto = (v) => (typeof v === 'string' ? v.trim() : '').slice(0, 60);
  // `padre` arma la jerarquía: apartamento -> edificio -> conjunto. Se valida
  // que exista y que no se cuelgue de sí mismo ni de un descendiente suyo, o la
  // cadena de herencia entraría en bucle.
  let padreFinal = '';
  if (typeof padre === 'string' && padre.trim()) {
    padreFinal = padre.trim();
    if (padreFinal === id) {
      throw new HttpsError('invalid-argument', 'Un inmueble no puede ser su propio padre.');
    }
    if (!(await db.doc(`inmuebles/${padreFinal}`).get()).exists) {
      throw new HttpsError('invalid-argument', 'Ese inmueble padre no existe.');
    }
    if (id && (await conAncestros([padreFinal])).includes(id)) {
      throw new HttpsError('invalid-argument', 'Eso haría un círculo en la jerarquía.');
    }
  }
  // Un admin de edificio solo crea/edita dentro de su alcance: un inmueble
  // nuevo tiene que colgarse de algo suyo, y uno existente tiene que ser suyo.
  if (alcance) {
    if (id) exigirInmueble(alcance, id, 'Ese inmueble');
    else exigirInmueble(alcance, padreFinal, 'Ese inmueble padre');
  }
  const datos = {
    tipo,
    nombre: nombre.trim().slice(0, 60),
    ciudad: texto(ciudad),
    estado: texto(estado),
    zona: texto(zona),
    padre: padreFinal,
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
  await resincronizarInmuebles();
  return { ok: true, id: inmuebleId };
});

// ---- Alta en lote de inmuebles ----
// Un conjunto no se crea solo: se crea con sus torres y cada torre con sus
// apartamentos. El árbol de nombres lo arma el frontend (que es quien lo
// enseña en la vista previa) y aquí se valida y se escribe; así hay UNA sola
// implementación de cómo se nombran, y es la que el admin vio antes de crear.
const MAX_LOTE = 600;

function nodoLote(n, profundidad) {
  if (!n || typeof n.nombre !== 'string' || !n.nombre.trim()) {
    throw new HttpsError('invalid-argument', 'Falta el nombre de un inmueble del lote.');
  }
  if (!TIPOS_INMUEBLE.includes(n.tipo)) {
    throw new HttpsError('invalid-argument', 'Tipo de inmueble no válido en el lote.');
  }
  const hijos = Array.isArray(n.hijos) ? n.hijos : [];
  if (hijos.length && profundidad >= 2) {
    throw new HttpsError('invalid-argument', 'El lote no puede anidar más de tres niveles.');
  }
  return {
    nombre: n.nombre.trim().slice(0, 60),
    tipo: n.tipo,
    hijos: hijos.map((h) => nodoLote(h, profundidad + 1)),
  };
}

const contarLote = (n) => 1 + n.hijos.reduce((t, h) => t + contarLote(h), 0);

exports.adminCrearInmuebleLote = onCall(async (request) => {
  const alcance = alcanceDe(await exigirAdmin(request));
  const { raiz } = request.data || {};
  if (!raiz) throw new HttpsError('invalid-argument', 'Falta el inmueble a crear.');
  const arbol = nodoLote(raiz, 0);
  const total = contarLote(arbol);
  if (total > MAX_LOTE) {
    throw new HttpsError('invalid-argument', `Son ${total} inmuebles y el máximo por lote es ${MAX_LOTE}.`);
  }
  // Mismo criterio que al crear uno suelto: si se cuelga de algo, ese algo
  // tiene que existir, y un admin de edificio solo cuelga dentro de lo suyo.
  let padreFinal = '';
  if (typeof raiz.padre === 'string' && raiz.padre.trim()) {
    padreFinal = raiz.padre.trim();
    if (!(await db.doc(`inmuebles/${padreFinal}`).get()).exists) {
      throw new HttpsError('invalid-argument', 'Ese inmueble padre no existe.');
    }
  }
  if (alcance) exigirInmueble(alcance, padreFinal, 'Ese inmueble padre');
  // La ubicación se hereda: los apartamentos de una torre están en la misma
  // ciudad que la torre, y pedirla 128 veces no tendría sentido.
  const texto = (v) => (typeof v === 'string' ? v.trim() : '').slice(0, 60);
  const comun = {
    ciudad: texto(raiz.ciudad),
    estado: texto(raiz.estado),
    zona: texto(raiz.zona),
    creado: admin.firestore.FieldValue.serverTimestamp(),
  };
  const escrituras = [];
  const apilar = (nodo, padre) => {
    const id = 'inm_' + crypto.randomBytes(8).toString('hex');
    escrituras.push([id, { tipo: nodo.tipo, nombre: nodo.nombre, padre, ...comun }]);
    for (const h of nodo.hijos) apilar(h, id);
    return id;
  };
  const raizId = apilar(arbol, padreFinal);
  // En trozos: un batch de Firestore admite 500 escrituras.
  for (let i = 0; i < escrituras.length; i += 400) {
    const batch = db.batch();
    for (const [id, datos] of escrituras.slice(i, i + 400)) batch.set(db.doc(`inmuebles/${id}`), datos);
    await batch.commit();
  }
  // Imprescindible: si el lote cuelga de algo que administra un admin de
  // edificio, su alcance (administraIds) tiene que incluir lo recién creado.
  await resincronizarInmuebles();
  return { ok: true, id: raizId, total };
});

// Elimina un inmueble del catálogo y lo quita de los vecinos asignados.
exports.adminEliminarInmueble = onCall(async (request) => {
  const alcance = alcanceDe(await exigirAdmin(request));
  const { id, conDescendientes } = request.data || {};
  if (!id || typeof id !== 'string') {
    throw new HttpsError('invalid-argument', 'Falta el id.');
  }
  exigirInmueble(alcance, id, 'Ese inmueble');
  // Borrar solo la torre dejaría sus apartamentos colgando de un id que ya no
  // existe: seguirían asignados a vecinos y no habría forma de llegar a ellos
  // desde el listado. O se borra el subárbol entero, o no se borra.
  const ids = await subarbolInmuebles([id]);
  if (ids.length > 1 && !conDescendientes) {
    throw new HttpsError('failed-precondition', `Ese inmueble contiene ${ids.length - 1} inmuebles más.`);
  }
  for (let i = 0; i < ids.length; i += 400) {
    const batch = db.batch();
    for (const x of ids.slice(i, i + 400)) batch.delete(db.doc(`inmuebles/${x}`));
    await batch.commit();
  }
  const fuera = new Set(ids);
  const usuarios = await db.collection('usuarios').get();
  const batch = db.batch();
  let hayCambios = false;
  usuarios.forEach((s) => {
    const lista = s.data().inmuebles || [];
    if (lista.some((x) => fuera.has(x.id))) {
      hayCambios = true;
      batch.set(s.ref, { inmuebles: lista.filter((x) => !fuera.has(x.id)) }, { merge: true });
    }
  });
  if (hayCambios) await batch.commit();
  await resincronizarInmuebles();
  return { ok: true, total: ids.length };
});

// Borra un vecino de verdad: su cuenta de acceso y su ficha. Es irreversible.
//
// Tres decisiones que conviene tener presentes:
//  - Se revocan los pases que haya emitido. Si no, sus invitados seguirían
//    entrando al condominio después de que él ya no está.
//  - NO se toca el registro de actividad: es la bitácora de quién abrió qué, y
//    borrar a alguien no debería borrar la historia. Ya guarda el nombre
//    copiado, así que se sigue leyendo bien sin la ficha.
//  - El admin no puede borrarse a sí mismo, para no quedarse fuera del panel.
exports.adminEliminarUsuario = onCall(async (request) => {
  const alcance = alcanceDe(await exigirAdmin(request));
  const { uid } = request.data || {};
  if (!uid || typeof uid !== 'string') {
    throw new HttpsError('invalid-argument', 'Falta el uid.');
  }
  if (alcance) {
    const destino = await db.doc(`usuarios/${uid}`).get();
    if (!destino.exists || !vecinoEnAlcance(alcance, destino.data())) {
      throw new HttpsError('permission-denied', 'Ese vecino no pertenece a lo que administras.');
    }
  }
  if (uid === request.auth.uid) {
    throw new HttpsError('failed-precondition', 'No puedes eliminar tu propia cuenta.');
  }

  const pases = await db.collection('pases').where('por', '==', uid).get();
  if (!pases.empty) {
    const batch = db.batch();
    pases.forEach((s) => {
      if (!s.data().revocado) batch.set(s.ref, { revocado: true }, { merge: true });
    });
    await batch.commit();
  }

  try {
    await admin.auth().deleteUser(uid);
  } catch (err) {
    // Si en Auth ya no existe, igual se limpia la ficha.
    if (err.code !== 'auth/user-not-found') {
      console.error('No se pudo borrar la cuenta de Auth:', err.code || err.message);
      throw new HttpsError('internal', 'No se pudo eliminar la cuenta.');
    }
  }
  await db.doc(`usuarios/${uid}`).delete();
  return { ok: true, pasesRevocados: pases.size };
});

exports.adminGuardarDispositivo = onCall(async (request) => {
  const alcance = alcanceDe(await exigirAdmin(request));
  const {
    id, nombre, tipo, subtipo, modo, etiquetaBoton, aspecto, segundosApertura, orden, activo, inmueble,
    dueno, cuentaTuya,
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
  // Se valida contra el catálogo para que no quede apuntando a uno inexistente
  // (un id malo aquí dejaría el dispositivo sin dueño y sin herencia).
  let inmuebleFinal = '';
  if (typeof inmueble === 'string' && inmueble.trim()) {
    const inmId = inmueble.trim();
    if (!(await db.doc(`inmuebles/${inmId}`).get()).exists) {
      throw new HttpsError('invalid-argument', 'Ese inmueble no existe.');
    }
    inmuebleFinal = inmId;
  }
  // Dueño del aparato: vacío = del condominio. Si es de un vecino, ÉL puede
  // desvincular su cuenta Tuya cuando quiera, así que el edificio no debería
  // depender de ese dispositivo. Por ahora es informativo (no cambia el acceso),
  // igual que el inmueble antes de que otorgara permisos.
  let duenoFinal = '';
  if (typeof dueno === 'string' && dueno.trim()) {
    const uidDueno = dueno.trim();
    const snapDueno = await db.doc(`usuarios/${uidDueno}`).get();
    if (!snapDueno.exists) {
      throw new HttpsError('invalid-argument', 'Ese vecino no existe.');
    }
    duenoFinal = uidDueno;
  }
  // Un admin de edificio solo pone dispositivos DENTRO de lo que administra...
  exigirInmueble(alcance, inmuebleFinal, 'Ese inmueble');
  // ...y no puede tocar uno que hoy está en otro edificio (sería robárselo).
  if (alcance) {
    const antes = await db.doc(`dispositivos/${id}`).get();
    if (antes.exists) exigirInmueble(alcance, antes.data().inmueble || '', 'Ese dispositivo');
    if (duenoFinal) {
      const d = await db.doc(`usuarios/${duenoFinal}`).get();
      if (!vecinoEnAlcance(alcance, d.data() || {})) {
        throw new HttpsError('permission-denied', 'Ese vecino no pertenece a lo que administras.');
      }
    }
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
    // Aspecto del control (solo tiene sentido en puertas de pulso):
    // 'jet' = interruptor con tapa de seguridad; 'argentina' = botón con el
    // escudo de la selección; 'bordado' = parche que gira; otra cosa = normal.
    aspecto: (await aspectosPermitidos()).has(aspecto) ? aspecto : 'normal',
    // Segundos que tarda esta puerta en abrir completo: la animación del botón
    // dura ese tiempo. Se acota a 1-120s para que un dato malo no deje el botón
    // animándose eternamente.
    segundosApertura: Math.min(120, Math.max(1, Number(segundosApertura) || 15)),
    orden: Number(orden) || 99,
    activo: activo !== false,
    // Inmueble donde está físicamente. Sirve para dos cosas: de él hereda el
    // acceso el vecino, y sirve para saber dónde buscar el aparato si se cae la
    // luz o el internet (y para agrupar reportes por edificio).
    inmueble: inmuebleFinal,
    dueno: duenoFinal,
  }, { merge: true });
  const privado = {
    tuyaDeviceId: String(tuyaDeviceId || '').trim(),
    // De qué cuenta Smart Life vinculada vino este aparato. Con una sola cuenta
    // da igual, pero en cuanto haya varias (una por edificio, o la de un vecino)
    // es lo único que distingue "se cayó un aparato" de "se desvinculó una
    // cuenta entera". Etiqueta libre: la pone quien vincula.
    cuenta: String(cuentaTuya || '').trim().slice(0, 40),
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
  const alcance = alcanceDe(await exigirAdmin(request));
  const { id } = request.data || {};
  if (!id || typeof id !== 'string') {
    throw new HttpsError('invalid-argument', 'Falta el id.');
  }
  if (alcance) {
    const snap = await db.doc(`dispositivos/${id}`).get();
    exigirInmueble(alcance, snap.exists ? (snap.data().inmueble || '') : '', 'Ese dispositivo');
  }
  await db.doc(`dispositivos/${id}/privado/tuya`).delete().catch(() => {});
  await db.doc(`dispositivos/${id}`).delete();
  return { ok: true };
});

// ---- Galería de skins (fase B: los genera y cura el admin) ----

// Una sola función con varias acciones a propósito: cada función desplegada
// cuenta contra la cuota de CPU de Cloud Run (ver setGlobalOptions arriba), así
// que tres exports serían tres slots por algo que solo usa el admin.
const ANIMACIONES_SKIN = ['ninguna', 'girar', 'latido'];
const TIPOS_SKIN = ['puerta', 'cortina', 'ascensor', 'luz', 'termostato', 'rele', 'otro'];
// Un data URI de WebP de 256px ronda los 20 KB. Se topa MUY por debajo del
// límite de 1 MB del documento para que un skin no pueda inflar la lectura de
// la galería, que baja entera al arrancar la app.
const MAX_IMAGEN_SKIN = 220000;

// La generación va por VERTEX AI, no por la API de estudio: así se autentica
// con la propia cuenta de servicio de la función y NO hace falta API key ni
// secreto que rotar, y el gasto cae en la facturación que el proyecto ya tiene.
// (La API de estudio nos dejó tirados con un fallo suyo de facturación: un
// proyecto en Postpay respondía "prepayment credits are depleted".)
// Endpoint global: más disponible y con menos 429 que una región suelta.
const MODELOS_IMAGEN = [
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-image-preview',
  'gemini-2.5-flash-image',
];
const PROYECTO = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'viyi-25a09';
const urlVertex = (modelo) => 'https://aiplatform.googleapis.com/v1/projects/'
  + `${PROYECTO}/locations/global/publishers/google/models/${modelo}:generateContent`;

let authVertex = null;
async function tokenVertex() {
  if (!authVertex) {
    authVertex = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  }
  const cliente = await authVertex.getClient();
  const t = await cliente.getAccessToken();
  const token = t && (t.token || t);
  if (!token) throw new HttpsError('internal', 'No se pudo autenticar contra Vertex AI.');
  return token;
}

// La API de imágenes de Gemini ha movido de sitio los bytes más de una vez
// (candidates[].content.parts[].inlineData, output_image…). En vez de casarnos
// con una forma, se busca en el árbol el primer objeto que tenga base64 y un
// mime de imagen.
function buscarImagen(nodo, prof = 0) {
  if (!nodo || typeof nodo !== 'object' || prof > 8) return null;
  const mime = nodo.mimeType || nodo.mime_type;
  if (typeof nodo.data === 'string' && typeof mime === 'string' && mime.startsWith('image/')) {
    return { mimeType: mime, data: nodo.data };
  }
  for (const v of Object.values(nodo)) {
    const hallado = buscarImagen(v, prof + 1);
    if (hallado) return hallado;
  }
  return null;
}

exports.adminSkins = onCall({ timeoutSeconds: 120 }, async (request) => {
  await exigirAdmin(request);
  const { accion } = request.data || {};

  if (accion === 'generar') {
    const prompt = String((request.data || {}).prompt || '').trim();
    if (prompt.length < 3 || prompt.length > 700) {
      throw new HttpsError('invalid-argument', 'Describe el botón en 3 a 700 caracteres.');
    }
    // Se encuadra el pedido: el botón es un círculo, así que el motivo tiene que
    // estar centrado y llenar el cuadro, o al recortarlo se corta.
    const encuadre = 'Ilustración cuadrada para el botón redondo de una app. '
      + 'El motivo va CENTRADO y llena el cuadro, sin texto, sin marcas de agua, '
      + 'sin bordes ni marco, sin manos ni personas reconocibles. '
      + 'Fondo integrado al motivo, oscuro. Motivo: ';
    const cuerpoPeticion = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: encuadre + prompt }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    });
    const token = await tokenVertex();
    let ultimoError = 'El generador falló.';
    // El id del modelo de imágenes cambia de nombre entre versiones y entre la
    // API de estudio y Vertex. Se prueban en orden y se usa el primero que
    // exista, en vez de casarnos con uno y romper cuando Google lo renombre.
    for (const modelo of MODELOS_IMAGEN) {
      let r;
      try {
        r = await fetch(`${urlVertex(modelo)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: cuerpoPeticion,
        });
      } catch (e) {
        throw new HttpsError('unavailable', 'No se pudo hablar con el generador de imágenes.');
      }
      const cuerpo = await r.json().catch(() => null);
      if (r.ok) {
        const img = buscarImagen(cuerpo);
        if (img) return { ok: true, mimeType: img.mimeType, data: img.data };
        // Sin imagen y sin error suele ser el filtro de seguridad.
        throw new HttpsError('failed-precondition', 'No devolvió imagen. Prueba a describirlo de otra forma.');
      }
      const msg = (cuerpo && cuerpo.error && cuerpo.error.message) || `HTTP ${r.status}`;
      console.error('Vertex imagen', modelo, r.status, msg);
      ultimoError = msg;
      // 404/400 = ese id no existe aquí: se prueba el siguiente. Cualquier otra
      // cosa (permisos, API sin habilitar, cuota) es real y hay que contarla.
      if (r.status !== 404 && r.status !== 400) break;
    }
    throw new HttpsError('internal', `El generador respondió: ${ultimoError}`);
  }

  if (accion === 'publicar') {
    const d = request.data || {};
    const id = String(d.id || '').trim().toLowerCase();
    const nombre = String(d.nombre || '').trim();
    const imagen = String(d.imagen || '');
    const animacion = ANIMACIONES_SKIN.includes(d.animacion) ? d.animacion : 'ninguna';
    const tipos = Array.isArray(d.tipos) ? d.tipos.filter((t) => TIPOS_SKIN.includes(t)) : [];
    if (!/^[a-z0-9-]{2,40}$/.test(id)) {
      throw new HttpsError('invalid-argument', 'El id debe ser minúsculas, números y guiones.');
    }
    if (ASPECTOS_VALIDOS.includes(id)) {
      throw new HttpsError('already-exists', 'Ese id ya lo usa un aspecto de la app.');
    }
    if (!nombre || nombre.length > 24) {
      throw new HttpsError('invalid-argument', 'Ponle un nombre de hasta 24 caracteres.');
    }
    if (!/^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(imagen)) {
      throw new HttpsError('invalid-argument', 'La imagen no llegó en el formato esperado.');
    }
    if (imagen.length > MAX_IMAGEN_SKIN) {
      throw new HttpsError('invalid-argument', 'La imagen pesa demasiado.');
    }
    await db.doc(`skins/${id}`).set({
      nombre, imagen, animacion, tipos,
      prompt: String(d.prompt || '').slice(0, 700),
      autor: request.auth.uid,
      publico: true,
      usos: 0,
      creado: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    skinsCache = { ids: null, hasta: 0 };   // que se pueda elegir de una vez
    return { ok: true, id };
  }

  // Cambiar nombre, animación o a qué tipos aplica, SIN volver a generar la
  // imagen: equivocarse de nombre no debe costar otra imagen.
  if (accion === 'editar') {
    const d = request.data || {};
    const id = String(d.id || '').trim();
    if (!/^[a-z0-9-]{2,40}$/.test(id)) {
      throw new HttpsError('invalid-argument', 'Falta el id.');
    }
    const ref = db.doc(`skins/${id}`);
    if (!(await ref.get()).exists) {
      throw new HttpsError('not-found', 'Ese botón ya no existe.');
    }
    const cambios = {};
    if (d.nombre !== undefined) {
      const nombre = String(d.nombre || '').trim();
      if (!nombre || nombre.length > 24) {
        throw new HttpsError('invalid-argument', 'Ponle un nombre de hasta 24 caracteres.');
      }
      cambios.nombre = nombre;
    }
    if (d.animacion !== undefined) {
      cambios.animacion = ANIMACIONES_SKIN.includes(d.animacion) ? d.animacion : 'ninguna';
    }
    if (d.tipos !== undefined) {
      cambios.tipos = Array.isArray(d.tipos) ? d.tipos.filter((t) => TIPOS_SKIN.includes(t)) : [];
    }
    if (!Object.keys(cambios).length) return { ok: true, id };
    await ref.set(cambios, { merge: true });
    return { ok: true, id };
  }

  if (accion === 'eliminar') {
    const id = String((request.data || {}).id || '').trim();
    if (!/^[a-z0-9-]{2,40}$/.test(id)) {
      throw new HttpsError('invalid-argument', 'Falta el id.');
    }
    await db.doc(`skins/${id}`).delete();
    skinsCache = { ids: null, hasta: 0 };
    return { ok: true };
  }

  throw new HttpsError('invalid-argument', 'Acción no válida.');
});

// ---- Pases: acceso temporal compartido por enlace ----

// Flujo de invitación email-first: dado un pase válido y un correo, dice si ese
// correo ya tiene cuenta (para mostrar login) o no (para mostrar crear cuenta).
// Gated por un token de pase existente para limitar la enumeración de correos.
exports.verificarEmail = onCall(async (request) => {
  const { token, email } = request.data || {};
  // El token es OPCIONAL: con pase se usa para mostrar el evento; sin pase (la
  // home email-first) se consulta solo el correo para saber cómo entra la
  // cuenta (clave / Google).
  let evento = '';
  let porNombre = '';
  let porApellido = '';
  if (token) {
    if (typeof token !== 'string') {
      throw new HttpsError('invalid-argument', 'El enlace no es válido.');
    }
    const paseSnap = await db.doc(`pases/${token}`).get();
    if (!paseSnap.exists) {
      throw new HttpsError('not-found', 'El enlace no es válido.');
    }
    evento = paseSnap.data().evento || '';
    porNombre = paseSnap.data().porNombre || '';
    porApellido = paseSnap.data().porApellido || '';
  }
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
    // La pantalla donde se escribe la clave nueva la sirve Firebase y se
    // localiza con ?lang=. El enlace viene con lang=en, así que el correo
    // quedaba en español pero la página de destino en inglés.
    enlace = /[?&]lang=/.test(enlace)
      ? enlace.replace(/([?&])lang=[^&]*/, '$1lang=es')
      : `${enlace}${enlace.includes('?') ? '&' : '?'}lang=es`;
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

// Tablero de fallas: dice cuáles dispositivos están en línea. Solo admin.
//
// Se pide TODO en el menor número de llamadas posible: a Tuya se le consultan
// todos los ids de una vez (infoLote) y a Homebridge se le pide su lista de
// accesorios una sola vez. Si un proveedor falla, sus dispositivos quedan en
// `online: null` (desconocido) en vez de tumbar la respuesta completa: que
// Homebridge esté caído no debe ocultar el estado de los Tuya.
// Consulta a los proveedores y guarda el resultado en cada dispositivo, para
// que el panel lo lea sin esperar y para saber DESDE CUÁNDO está así (el campo
// `desde` solo se toca cuando el estado cambia; si no, se perdería la hora en
// que se cayó). La usan tanto el botón de actualizar como el chequeo programado.
async function revisarConexion() {
  {
    const snap = await db.collection('dispositivos').get();
    const disps = [];
    for (const doc of snap.docs) {
      const cfgSnap = await db.doc(`dispositivos/${doc.id}/privado/tuya`).get();
      disps.push({
        id: doc.id,
        nombre: doc.data().nombre || doc.id,
        proveedor: doc.data().proveedor || 'tuya',
        activo: doc.data().activo !== false,
        inmueble: doc.data().inmueble || '',
        cfg: cfgSnap.exists ? cfgSnap.data() : null,
      });
    }

    const deTuya = disps.filter((d) => d.proveedor !== 'homebridge' && d.cfg && d.cfg.tuyaDeviceId);
    const deHb = disps.filter((d) => d.proveedor === 'homebridge' && d.cfg && d.cfg.accesorioId);

    const onlineTuya = new Map();
    if (deTuya.length) {
      try {
        const info = await tuya().infoLote(deTuya.map((d) => d.cfg.tuyaDeviceId));
        for (const eq of info) onlineTuya.set(eq.id, eq.online === true);
      } catch (err) {
        console.error('No se pudo consultar el estado en Tuya:', err.message);
      }
    }

    const onlineHb = new Map();
    if (deHb.length) {
      try {
        const accs = await homebridge().listarAccesorios();
        for (const a of (accs || [])) onlineHb.set(a.uniqueId, true);
      } catch (err) {
        console.error('No se pudo consultar el estado en Homebridge:', err.message);
      }
    }

    const ahora = admin.firestore.Timestamp.now();
    const lista = [];
    for (const d of disps) {
      let online = null; // null = no se pudo averiguar
      if (!d.cfg) online = null;
      else if (d.proveedor === 'homebridge') {
        if (onlineHb.size) online = onlineHb.has(d.cfg.accesorioId);
      } else if (onlineTuya.size) {
        online = onlineTuya.get(d.cfg.tuyaDeviceId) === true;
      }

      if (online !== null) {
        const previo = (snap.docs.find((x) => x.id === d.id).data() || {}).conexion || {};
        // `desde` solo se reinicia cuando el estado cambia: así se conserva la
        // hora exacta en que se cayó, que es lo que uno quiere saber.
        const desde = previo.online === online && previo.desde ? previo.desde : ahora;
        // Al CAMBIAR de estado se cierra el tramo que termina y se guarda con su
        // duración. `dispositivos.conexion` solo guarda el estado actual y se
        // sobrescribe, así que sin esto el pasado no existe: no se puede
        // reconstruir después, a diferencia de las métricas de uso, que salen de
        // los registros crudos. Con la duración ya calculada, sumar el tiempo
        // caído de un mes es sumar un campo.
        if (typeof previo.online === 'boolean' && previo.online !== online && previo.desde) {
          await db.collection('conexiones').add({
            dispositivoId: d.id,
            nombre: d.nombre,
            inmueble: d.inmueble,
            online: previo.online,        // el estado que acaba de terminar
            desde: previo.desde,
            hasta: ahora,
            ms: ahora.toMillis() - previo.desde.toMillis(),
          }).catch(() => { /* que un fallo aquí no tumbe la revisión */ });
        }
        await db.doc(`dispositivos/${d.id}`)
          .set({ conexion: { online, revisado: ahora, desde } }, { merge: true });
        lista.push({ id: d.id, nombre: d.nombre, proveedor: d.proveedor, activo: d.activo, online, desde: desde.toMillis() });
      } else {
        lista.push({ id: d.id, nombre: d.nombre, proveedor: d.proveedor, activo: d.activo, online: null, desde: null });
      }
    }

    return { dispositivos: lista, consultado: ahora.toMillis() };
  }
}

// Cómo entra cada vecino: con clave, con Google, o ambas. El dato vive en
// Firebase Auth, no en Firestore, así que hay que preguntárselo a Auth.
// getUsers acepta 100 por llamada, así que esto es una consulta para todos.
//
// Sirve para lo práctico: si un vecino dice "no puedo entrar", ver de un
// vistazo si tiene clave o si siempre entró por Google.
exports.adminProveedores = onCall(async (request) => {
  await exigirAdmin(request);
  const snap = await db.collection('usuarios').get();
  const uids = snap.docs.map((d) => ({ uid: d.id }));
  const porUid = {};
  for (let i = 0; i < uids.length; i += 100) {
    const res = await admin.auth().getUsers(uids.slice(i, i + 100));
    for (const u of res.users) {
      porUid[u.uid] = (u.providerData || []).map((p) => p.providerId);
    }
  }
  return { proveedores: porUid };
});

// Botón "actualizar" del panel: consulta en vivo. Solo admin.
exports.estadoDispositivos = onCall(
  { secrets: [TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, ...SECRETS_HB] },
  async (request) => {
    await exigirAdmin(request);
    return revisarConexion();
  },
);

// Chequeo automático cada 10 minutos, para que la caída quede registrada con su
// hora aunque nadie esté mirando el panel.
exports.revisarConexionProgramada = onSchedule(
  { schedule: 'every 10 minutes', timeZone: 'America/Caracas', secrets: [TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, ...SECRETS_HB] },
  async () => {
    const { dispositivos } = await revisarConexion();
    const caidos = dispositivos.filter((d) => d.online === false).map((d) => d.nombre);
    if (caidos.length) console.warn('Dispositivos sin conexión:', caidos.join(', '));
  },
);

// Mis invitados frecuentes: la gente que ya canjeó algún pase mío. La lista se
// arma sola con lo que los pases ya guardan; no hay que pedir datos nuevos.
//
// Es MI lista, no un directorio: nunca devuelve usuarios con los que no he
// compartido antes, porque eso delataría quién está registrado en el condominio.
exports.misInvitados = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Inicia sesión primero.');
  }
  const pases = await db.collection('pases').where('por', '==', request.auth.uid).get();
  const porUid = new Map();
  pases.forEach((s) => {
    for (const inv of (s.data().invitados || [])) {
      if (!inv || !inv.uid || inv.uid === request.auth.uid) continue;
      const cuando = inv.cuando && inv.cuando.toMillis ? inv.cuando.toMillis() : 0;
      const previo = porUid.get(inv.uid);
      if (!previo) {
        porUid.set(inv.uid, {
          uid: inv.uid,
          nombre: inv.nombre || '',
          apellido: inv.apellido || '',
          email: inv.email || '',
          veces: 1,
          ultima: cuando,
        });
      } else {
        previo.veces += 1;
        if (cuando > previo.ultima) {
          previo.ultima = cuando;
          previo.nombre = inv.nombre || previo.nombre;
          previo.apellido = inv.apellido || previo.apellido;
          previo.email = inv.email || previo.email;
        }
      }
    }
  });
  // Del más frecuente al menos; a igual número de veces, primero el más
  // reciente. El conteo se usa solo para ordenar y no se devuelve: mostrarle a
  // alguien cuántas veces ha invitado a otro se siente invasivo.
  const lista = [...porUid.values()]
    .sort((a, b) => b.veces - a.veces || b.ultima - a.ultima)
    .map(({ uid, nombre, apellido, email }) => ({ uid, nombre, apellido, email }));
  return { invitados: lista };
});

// Da acceso directo a un invitado frecuente, sin enlace de por medio. Escribe
// el mismo `accesos[]` que escribe el canje de un pase, y avisa por correo:
// sin el enlace de WhatsApp nadie se enteraría de que ya puede abrir.
exports.darAcceso = onCall({ secrets: [RESEND_API_KEY] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Inicia sesión primero.');
  }
  const yo = request.auth.uid;
  const { uids, dispositivos, duracion, evento } = request.data || {};
  const destinos = [...new Set((Array.isArray(uids) ? uids : [])
    .filter((u) => typeof u === 'string' && u && u !== yo))];
  if (!destinos.length) {
    throw new HttpsError('invalid-argument', 'Elige a quién darle acceso.');
  }
  if (!Array.isArray(dispositivos) || !dispositivos.length) {
    throw new HttpsError('invalid-argument', 'Elige al menos un dispositivo.');
  }
  if (!DURACIONES_VALIDAS.has(duracion)) {
    throw new HttpsError('invalid-argument', 'La duración no es válida.');
  }

  const miSnap = await db.doc(`usuarios/${yo}`).get();
  if (!miSnap.exists || miSnap.data().activo === false) {
    throw new HttpsError('permission-denied', 'Tu cuenta no está activa.');
  }
  const usuario = miSnap.data();
  const compartir = await puedeCompartir(usuario, dispositivos);
  if (!compartir.length) {
    throw new HttpsError('permission-denied', 'No puedes compartir esos dispositivos.');
  }

  // Solo se le puede dar acceso a quien ya canjeó un pase mío: si no, esto
  // sería una puerta para repartir accesos a cualquier uid del sistema.
  const pasesMios = await db.collection('pases').where('por', '==', yo).get();
  const mios = new Set();
  pasesMios.forEach((s) => {
    for (const i of (s.data().invitados || [])) if (i && i.uid) mios.add(i.uid);
  });
  if (destinos.some((u) => !mios.has(u))) {
    throw new HttpsError('permission-denied', 'Esa persona no está en tus invitados.');
  }

  const ms = msDeDuracion(duracion);
  const expira = ms == null ? FIN_INDEFINIDO : admin.firestore.Timestamp.fromMillis(Date.now() + ms);
  const limpio = (typeof evento === 'string' ? evento.trim() : '').slice(0, 60);
  const vence = ms == null ? '' : new Date(expira.toMillis())
    .toLocaleString('es-VE', { timeZone: 'America/Caracas', dateStyle: 'long', timeStyle: 'short' });

  const nombresDisp = [];
  for (const id of compartir) {
    const d = await db.doc(`dispositivos/${id}`).get();
    nombresDisp.push((d.exists && d.data().nombre) || id);
  }
  const anfitrion = [usuario.nombre, usuario.apellido].filter(Boolean).join(' ') || 'Un vecino';

  let dados = 0;
  let avisados = 0;
  for (const destinoUid of destinos) {
    const destinoSnap = await db.doc(`usuarios/${destinoUid}`).get();
    // A uno inactivo se le salta sin tumbar a los demás del lote.
    if (!destinoSnap.exists || destinoSnap.data().activo === false) continue;

    const accesos = destinoSnap.data().accesos || {};
    for (const id of compartir) {
      accesos[id] = {
        expira,
        por: yo,
        token: null, // acceso directo: no nació de un enlace
        evento: limpio,
        porNombre: usuario.nombre || '',
        porApellido: usuario.apellido || '',
        creado: admin.firestore.Timestamp.now(),
      };
    }
    await db.doc(`usuarios/${destinoUid}`).set({ accesos }, { merge: true });
    dados += 1;

    // El correo es el aviso; si falla, el acceso ya quedó dado y no se deshace.
    const email = destinoSnap.data().email;
    if (!email) continue;
    try {
      const { asunto, html, texto } = plantillaAccesoDado({
        anfitrion, dispositivos: nombresDisp, evento: limpio, vence,
      });
      await enviarCorreo({ apiKey: RESEND_API_KEY.value(), para: email, asunto, html, texto });
      avisados += 1;
    } catch (err) {
      console.error('No se pudo avisar del acceso:', err.message);
    }
  }
  if (!dados) {
    throw new HttpsError('not-found', 'Esas personas ya no tienen cuenta activa.');
  }
  return { ok: true, dados, avisados };
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
  if (!DURACIONES_VALIDAS.has(duracion)) {
    throw new HttpsError('invalid-argument', 'La duración no es válida.');
  }
  const snap = await db.doc(`usuarios/${uid}`).get();
  if (!snap.exists || snap.data().activo === false) {
    throw new HttpsError('permission-denied', 'Tu cuenta no está activa.');
  }
  const usuario = snap.data();
  // Solo comparte lo que alcanza de forma permanente (propio o por inmueble).
  const compartir = await puedeCompartir(usuario, dispositivos);
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
      nombre: nombrePropio(nombreInvitado),
      // Antes guardaba el `apellido` crudo del formulario en vez del resuelto:
      // por eso quien entraba con Google quedaba sin apellido, aunque se
      // hubiera sacado de su displayName.
      apellido: nombrePropio(apellidoInvitado),
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
  // minInstances: 1 mantiene una instancia despierta 24/7 para que el estado de
  // los dispositivos no pague el arranque en frío al abrir la app (~1-2s en la
  // primera consulta tras inactividad). Reserva 1 CPU fija de la cuota, que
  // ahora cabe: con maxInstances 1 el techo bajó de 69 a 23 CPU.
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
