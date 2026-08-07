const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret, defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');
const { GoogleAuth } = require('google-auth-library');
const { TuyaClient, esServicioVencido } = require('./tuya');
const { HomebridgeClient } = require('./homebridge');
const { ShellyClient } = require('./shelly');
const { plantillaResetClave, plantillaInvitacion, plantillaAccesoDado, maqueta: maquetaCorreo, enviar: enviarCorreo, esc: escaparHtml } = require('./correo');

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
// Shelly, Cloud Control API. Los dos van como SECRET aunque el servidor no lo
// sea: el workflow de despliegue SOBREESCRIBE `functions/.env` con solo
// TUYA_BASE_URL, así que un defineString aquí rompería el deploy en silencio.
// Se ponen con: npx firebase-tools functions:secrets:set NOMBRE
const SHELLY_SERVER = defineSecret('SHELLY_SERVER');
const SHELLY_AUTH_KEY = defineSecret('SHELLY_AUTH_KEY');
const SECRETS_SHELLY = [SHELLY_SERVER, SHELLY_AUTH_KEY];
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

// Reparto de CPU POR FUNCIÓN. maxInstances 1 no alcanzó: la cuota cuenta el
// techo de todas juntas y ya somos 31 funciones, o sea 31 CPU pedidos contra
// 20. Estábamos crónicamente por encima, y como en un despliegue conviven la
// revisión vieja y la nueva, cada push era una tirada de dados sobre cuáles se
// actualizaban (el 5-ago-2026 fallaron 15 y luego 11, y el workflow lo tapaba).
//
// El criterio es quién llama a cada función y cada cuánto:
//   · Sin marcar (1 CPU, 80 peticiones a la vez) — lo que se toca a diario o en
//     la puerta: abrir, estado, canjear un pase, entrar, el perfil, y adminSkins
//     (genera imágenes, hasta 120 s: serializarla bloquearía a todo el edificio).
//   · OCASIONAL — cosas de vecino de vez en cuando: pases, vincular, recuperar
//     clave. Si dos coinciden, el segundo espera lo que dura el primero.
//   · RARA — panel de administración (lo usa una persona) y la programada.
//
// ⚠️ Con cpu < 1 Cloud Run EXIGE concurrency 1: si no, la configuración es
// inválida y rechaza el deploy sin crear revisión. Por eso cada nivel lleva las
// dos cosas juntas y se aplica con spread — separarlas es romperlo.
//
// Techo resultante: 7×1 + 6×0,5 + 18×0,25 = 14,5 CPU contra 20 de cuota, que
// deja aire para las revisiones que conviven durante un despliegue.
const OCASIONAL = { cpu: 0.5, concurrency: 1 };
const RARA = { cpu: 0.25, concurrency: 1 };

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
let clienteShelly = null;

function shelly() {
  if (!clienteShelly) {
    clienteShelly = new ShellyClient({
      servidor: SHELLY_SERVER.value(),
      authKey: SHELLY_AUTH_KEY.value(),
    });
  }
  return clienteShelly;
}

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
// Shelly por su nube. Solo relé (pulso e interruptor): el Plus 1 no hace más,
// y los otros modos se rechazan con un mensaje claro en vez de caer por el
// camino de Tuya y hacer algo raro.
async function ejecutarShelly(dispositivo, config, { accion }) {
  const id = String(config.shellyId || '').trim();
  if (!id) {
    throw new HttpsError('failed-precondition', 'Falta el Device ID de Shelly.');
  }
  const canal = Number(config.shellyCanal) || 0;
  const modo = dispositivo.modo || 'pulso';
  if (modo === 'pulso') {
    // `toggle_after` en vez de encender y apagar seguidos: el aparato se apaga
    // solo, así que si se cae la red a mitad del pulso el relé NO se queda
    // cerrado — y de paso respeta el límite de una petición por segundo.
    const segundos = Math.max(1, Math.round((Number(config.pulsoMs) || 1000) / 1000));
    await shelly().interruptor(id, canal, true, segundos);
    return 'pulso';
  }
  if (modo === 'interruptor') {
    if (accion !== 'encender' && accion !== 'apagar') {
      throw new HttpsError('invalid-argument', "La acción debe ser 'encender' o 'apagar'.");
    }
    await shelly().interruptor(id, canal, accion === 'encender');
    return accion;
  }
  throw new HttpsError('failed-precondition', `Shelly todavía no maneja el modo ${modo} en ViYi.`);
}

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
// ¿Se anota la actividad de este aparato en el registro del condominio?
//
// El registro es sobre ACCESOS —quién entró y por dónde—, no sobre confort.
// Así que por omisión se anota lo que abre algo (puertas, portones,
// ascensores: los de modo pulso) y NO los aires, dimmers ni persianas, que
// generan mucho ruido y no dicen nada útil. Y nunca lo de un vecino: el
// interruptor de su pared no es asunto del condominio.
//
// El admin decide por aparato con el campo `registrar`, que manda sobre esto.
const TIPOS_DE_ACCESO = ['puerta', 'ascensor'];
const seRegistra = (d) => {
  const disp = d || {};
  if (typeof disp.registrar === 'boolean') return disp.registrar;
  if (disp.dueno) return false;
  return (disp.modo || 'pulso') === 'pulso' || TIPOS_DE_ACCESO.includes(disp.tipo);
};

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
  { secrets: [TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, ...SECRETS_HB, ...SECRETS_SHELLY] },
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
      if (proveedor === 'shelly') {
        accionRegistrada = await ejecutarShelly(dispositivo, config, { accion });
      } else if (proveedor === 'homebridge') {
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
      if (seRegistra(dispositivo)) {
        await registrar({
          uid,
          usuario,
          dispositivoId,
          dispositivoNombre,
          accion: accionRegistrada,
          exito: true,
        });
      }
      // Contador de uso por vecino, para ordenar "más usado primero".
      await db.doc(`usuarios/${uid}`).set(
        { usos: { [dispositivoId]: admin.firestore.FieldValue.increment(1) } },
        { merge: true },
      ).catch(() => {});
      return { ok: true };
    } catch (err) {
      // Tampoco los fallos: si su actividad es privada, lo es entera.
      if (seRegistra(dispositivo)) {
        await registrar({
          uid,
          usuario,
          dispositivoId,
          dispositivoNombre,
          accion: accion || 'pulso',
          exito: false,
          detalle: String((err && err.message) || err),
        });
      }
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

// Sesión de cualquier vecino activo (sin exigir que sea admin). Devuelve su
// documento para que quien llama decida qué puede hacer según el rol.
async function exigirSesion(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Inicia sesión primero.');
  }
  const snap = await db.doc(`usuarios/${request.auth.uid}`).get();
  if (!snap.exists || snap.data().activo === false) {
    throw new HttpsError('permission-denied', 'Tu cuenta no está activa.');
  }
  return snap.data();
}

exports.adminCrearUsuario = onCall(RARA, async (request) => {
  const alcance = alcanceDe(await exigirAdmin(request));
  const { email, password, nombre, apellido, unidad, rol, dispositivos, inmuebles } = request.data || {};
  if (!email || !nombre) {
    throw new HttpsError('invalid-argument', 'Faltan el correo o el nombre.');
  }
  // La clave es OPCIONAL. Sin ella la cuenta nace sin clave y su dueño entra
  // con Google o pone la suya con el enlace de la invitación. Exigirla dejaba
  // un callejón sin salida: para alguien que va a entrar con Google, el admin
  // tenía que inventarle una clave que nadie iba a usar.
  if (password && String(password).length < 6) {
    throw new HttpsError('invalid-argument', 'La contraseña debe tener al menos 6 caracteres.');
  }
  let user;
  try {
    user = await admin.auth().createUser(
      password ? { email, password, displayName: nombre } : { email, displayName: nombre },
    );
  } catch (err) {
    if (err.code === 'auth/email-already-exists') {
      // Ya entró por su cuenta con Google desde la portada: existe en Auth pero
      // sin ficha, así que no salía en la lista Y tampoco se dejaba crear —
      // callejón sin salida. Se reutiliza su cuenta y se le hace la ficha.
      try {
        user = await admin.auth().getUserByEmail(email);
      } catch (err2) {
        throw new HttpsError('already-exists', 'Ya existe una cuenta con ese correo.');
      }
      if ((await db.doc(`usuarios/${user.uid}`).get()).exists) {
        throw new HttpsError('already-exists', 'Ese vecino ya está dado de alta.');
      }
    } else if (err.code === 'auth/invalid-email') {
      throw new HttpsError('invalid-argument', 'El correo no es válido.');
    } else {
      throw new HttpsError('internal', 'No se pudo crear la cuenta.');
    }
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
  return { uid: user.uid, sinClave: !password };
});

exports.adminActualizarUsuario = onCall(RARA, async (request) => {
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
  { ...OCASIONAL, secrets: [TUYA_CLIENT_ID, TUYA_CLIENT_SECRET] },
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
  { ...RARA, secrets: [TUYA_CLIENT_ID, TUYA_CLIENT_SECRET] },
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
  { ...RARA, secrets: [TUYA_CLIENT_ID, TUYA_CLIENT_SECRET] },
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
exports.adminGuardarInmueble = onCall(RARA, async (request) => {
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

exports.adminCrearInmuebleLote = onCall(RARA, async (request) => {
  const alcance = alcanceDe(await exigirAdmin(request));
  const { raiz } = request.data || {};
  if (!raiz) throw new HttpsError('invalid-argument', 'Falta el inmueble a crear.');
  // Con `raiz.id` el edificio YA existe y solo se le cuelgan sus unidades: es
  // el caso de dar de alta el directorio de apartamentos meses después de
  // haber creado el edificio, que es como pasa de verdad.
  const existente = typeof raiz.id === 'string' && raiz.id.trim() ? raiz.id.trim() : '';
  const arbol = nodoLote(raiz, 0);
  const total = contarLote(arbol) - (existente ? 1 : 0);
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
  if (existente) {
    if (!(await db.doc(`inmuebles/${existente}`).get()).exists) {
      throw new HttpsError('invalid-argument', 'Ese inmueble ya no existe.');
    }
    exigirInmueble(alcance, existente, 'Ese inmueble');
  } else if (alcance) {
    exigirInmueble(alcance, padreFinal, 'Ese inmueble padre');
  }
  // Si ya tiene unidades, no se duplican: agregar el directorio dos veces
  // dejaría dos "1A" indistinguibles, y eso no se ve hasta que se asignan.
  let yaHay = new Set();
  let omitidos = 0;
  if (existente) {
    const previos = await db.collection('inmuebles').where('padre', '==', existente).get();
    yaHay = new Set(previos.docs.map((d) => (d.data().nombre || '').trim().toLowerCase()));
    const antes = arbol.hijos.length;
    arbol.hijos = arbol.hijos.filter((h) => !yaHay.has(h.nombre.toLowerCase()));
    omitidos = antes - arbol.hijos.length;
    if (!arbol.hijos.length) {
      throw new HttpsError('failed-precondition', 'Todos esos ya existen en ese inmueble.');
    }
  }
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
  let raizId = existente;
  if (existente) {
    for (const h of arbol.hijos) apilar(h, existente);
  } else {
    raizId = apilar(arbol, padreFinal);
  }
  // En trozos: un batch de Firestore admite 500 escrituras.
  for (let i = 0; i < escrituras.length; i += 400) {
    const batch = db.batch();
    for (const [id, datos] of escrituras.slice(i, i + 400)) batch.set(db.doc(`inmuebles/${id}`), datos);
    await batch.commit();
  }
  // Imprescindible: si el lote cuelga de algo que administra un admin de
  // edificio, su alcance (administraIds) tiene que incluir lo recién creado.
  await resincronizarInmuebles();
  return { ok: true, id: raizId, total: escrituras.length, omitidos };
});

// ---- Alta de vecinos en lote ----
// Un edificio recién montado son 20-30 vecinos, y a mano son 30 formularios.
// Se crean SIN CLAVE a propósito: el admin no debe inventar ni conocer la
// clave de nadie. El vecino entra con Google (Firebase enlaza por correo) o
// pone la suya con el enlace de la invitación, que se manda APARTE.
const MAX_VECINOS_LOTE = 200;

exports.adminCrearVecinosLote = onCall(RARA, async (request) => {
  const alcance = alcanceDe(await exigirAdmin(request));
  const filas = Array.isArray((request.data || {}).filas) ? request.data.filas : [];
  if (!filas.length) throw new HttpsError('invalid-argument', 'No hay vecinos que crear.');
  if (filas.length > MAX_VECINOS_LOTE) {
    throw new HttpsError('invalid-argument', `El máximo por lote es ${MAX_VECINOS_LOTE}.`);
  }
  // El inmueble de cada fila se resuelve del catálogo, no de lo que mande el
  // navegador: así no se puede colar un inmueble inventado ni ajeno.
  const ids = [...new Set(filas.map((f) => String((f && f.inmueble) || '')).filter(Boolean))];
  const docs = await Promise.all(ids.map((x) => db.doc(`inmuebles/${x}`).get()));
  const catalogo = new Map();
  docs.forEach((d) => { if (d.exists) catalogo.set(d.id, { id: d.id, tipo: d.data().tipo, nombre: d.data().nombre }); });
  exigirInmueblesAsignables(alcance, [...catalogo.values()]);

  const creados = [];
  const asignados = [];
  const fallos = [];
  for (const f of filas) {
    const email = String((f && f.email) || '').trim().toLowerCase();
    const nombre = String((f && f.nombre) || '').trim();
    const inm = catalogo.get(String((f && f.inmueble) || ''));
    const etiqueta = inm ? inm.nombre : email;
    if (!email.includes('@') || email.length > 200) { fallos.push({ etiqueta, motivo: 'correo no válido' }); continue; }
    if (!nombre) { fallos.push({ etiqueta, motivo: 'falta el nombre' }); continue; }
    if (!inm) { fallos.push({ etiqueta, motivo: 'ese inmueble no existe' }); continue; }
    try {
      // Si ya tiene cuenta (el amigo que ya usaba ViYi) NO se falla: se le
      // suma el inmueble. Fallar obligaría a sacarlo del lote a mano.
      let uid = null;
      try {
        uid = (await admin.auth().getUserByEmail(email)).uid;
      } catch (err) {
        if (err.code !== 'auth/user-not-found') throw err;
      }
      if (uid) {
        const ref = db.doc(`usuarios/${uid}`);
        const prev = (await ref.get()).data() || {};
        const lista = prev.inmuebles || [];
        if (!lista.some((x) => x.id === inm.id)) {
          const nuevos = [...lista, inm];
          await ref.set({ inmuebles: nuevos, inmueblesIds: await conAncestros(nuevos.map((x) => x.id)) }, { merge: true });
        }
        asignados.push({ uid, email, inmueble: inm.nombre });
        continue;
      }
      // Sin `password`: la cuenta nace sin clave y solo su dueño podrá ponerla.
      const user = await admin.auth().createUser({ email, displayName: nombre });
      await db.doc(`usuarios/${user.uid}`).set({
        nombre: nombrePropio(nombre),
        apellido: nombrePropio((f && f.apellido) || ''),
        unidad: '',
        email,
        rol: 'vecino',
        activo: true,
        dispositivos: [],
        inmuebles: [inm],
        inmueblesIds: await conAncestros([inm.id]),
      });
      creados.push({ uid: user.uid, email, inmueble: inm.nombre });
    } catch (err) {
      console.error('Alta en lote falló para', email, err.code || err.message);
      fallos.push({ etiqueta, motivo: err.code === 'auth/invalid-email' ? 'correo no válido' : 'no se pudo crear' });
    }
  }
  return { creados, asignados, fallos };
});

// El nombre de más arriba del árbol: el conjunto o el edificio suelto. Es lo
// que el vecino reconoce ("Residencias Bunker"), mejor que un nombre global
// del condominio que además tendría que estar duplicado aquí y en el frontend.
async function nombreRaiz(id) {
  let actual = id;
  let nombre = '';
  for (let n = 0; n < MAX_NIVELES_INMUEBLE && actual; n++) {
    const snap = await db.doc(`inmuebles/${actual}`).get();
    if (!snap.exists) break;
    nombre = snap.data().nombre || nombre;
    actual = snap.data().padre || '';
  }
  return nombre;
}

// Manda la invitación para que el vecino ponga su clave. Va SEPARADO del alta
// a propósito: un correo mal escrito, una vez enviado, no se recoge.
exports.adminInvitarVecinos = onCall({ ...RARA, secrets: [RESEND_API_KEY] }, async (request) => {
  const alcance = alcanceDe(await exigirAdmin(request));
  const uids = [...new Set((((request.data || {}).uids) || []).filter((x) => typeof x === 'string' && x))];
  if (!uids.length) throw new HttpsError('invalid-argument', 'No hay a quién invitar.');
  if (uids.length > MAX_VECINOS_LOTE) {
    throw new HttpsError('invalid-argument', `El máximo por lote es ${MAX_VECINOS_LOTE}.`);
  }
  let enviados = 0;
  const fallos = [];
  for (const uid of uids) {
    const snap = await db.doc(`usuarios/${uid}`).get();
    if (!snap.exists) { fallos.push({ etiqueta: uid, motivo: 'no existe' }); continue; }
    const u = { uid, ...snap.data() };
    if (alcance && !vecinoEnAlcance(alcance, u)) {
      fallos.push({ etiqueta: u.email || uid, motivo: 'fuera de tu alcance' });
      continue;
    }
    const email = String(u.email || '').trim().toLowerCase();
    if (!email.includes('@')) { fallos.push({ etiqueta: uid, motivo: 'sin correo' }); continue; }
    try {
      let enlace = await admin.auth().generatePasswordResetLink(email, {
        url: 'https://www.viyi.ai/',
        handleCodeInApp: false,
      });
      // Mismo apaño que en el reset: la pantalla la sirve Firebase y sin
      // lang=es sale en inglés aunque el correo vaya en español.
      enlace = /[?&]lang=/.test(enlace)
        ? enlace.replace(/([?&])lang=[^&]*/, '$1lang=es')
        : `${enlace}${enlace.includes('?') ? '&' : '?'}lang=es`;
      const suyos = u.inmuebles || [];
      const { asunto, html, texto } = plantillaInvitacion({
        enlace,
        condominio: (suyos[0] && await nombreRaiz(suyos[0].id)) || 'tu condominio',
        inmueble: suyos.map((x) => x.nombre).join(', '),
      });
      await enviarCorreo({ apiKey: RESEND_API_KEY.value(), para: email, asunto, html, texto });
      enviados += 1;
    } catch (err) {
      console.error('Invitación falló para', email, err.code || err.message);
      fallos.push({ etiqueta: email, motivo: 'no se pudo enviar' });
    }
  }
  return { enviados, fallos };
});

// Elimina un inmueble del catálogo y lo quita de los vecinos asignados.
exports.adminEliminarInmueble = onCall(RARA, async (request) => {
  const alcance = alcanceDe(await exigirAdmin(request));
  const { id, ids: varios, conDescendientes } = request.data || {};
  // Uno o una lista: la lista hace falta para recoger los huérfanos que dejó
  // un borrado antiguo, que si no habría que quitar de uno en uno.
  const raices = Array.isArray(varios) && varios.length
    ? varios.filter((x) => typeof x === 'string' && x)
    : [id];
  if (!raices.length || raices.some((x) => !x || typeof x !== 'string')) {
    throw new HttpsError('invalid-argument', 'Falta el id.');
  }
  for (const r of raices) exigirInmueble(alcance, r, 'Ese inmueble');
  // Borrar solo la torre dejaría sus apartamentos colgando de un id que ya no
  // existe: seguirían asignados a vecinos y no habría forma de llegar a ellos
  // desde el listado. O se borra el subárbol entero, o no se borra.
  const ids = await subarbolInmuebles(raices);
  if (ids.length > raices.length && !conDescendientes) {
    throw new HttpsError('failed-precondition', `Ese inmueble contiene ${ids.length - raices.length} inmuebles más.`);
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
exports.adminEliminarUsuario = onCall(RARA, async (request) => {
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

exports.adminGuardarDispositivo = onCall(RARA, async (request) => {
  const alcance = alcanceDe(await exigirAdmin(request));
  const {
    id, nombre, tipo, subtipo, modo, etiquetaBoton, aspecto, segundosApertura, orden, activo, inmueble,
    dueno, cuentaTuya, registrar: registrarPedido, shellyId, shellyCanal,
    proveedor, tuyaDeviceId, codigo, pulsoMs, codigoBrillo, brilloMax,
    codigoPosicion, codigoPosicionEstado, posicionInvertida,
    accesorioId, caracteristica,
  } = request.data || {};
  if (!id || !/^[a-z0-9-]{2,40}$/.test(id)) {
    throw new HttpsError('invalid-argument', 'El id debe ser minúsculas, números y guiones (ej: porton-garaje).');
  }
  const provFinal = ['homebridge', 'shelly'].includes(proveedor) ? proveedor : 'tuya';
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
  // Cada proveedor tiene su identificador obligatorio: sin él el aparato queda
  // dado de alta pero sin forma de alcanzarlo.
  const FALTA = {
    homebridge: [accesorioId, 'Falta el accesorio de Homebridge.'],
    shelly: [shellyId, 'Falta el Device ID de Shelly.'],
    tuya: [tuyaDeviceId, 'Falta el Device ID de Tuya.'],
  };
  if (!FALTA[provFinal][0]) {
    throw new HttpsError('invalid-argument', FALTA[provFinal][1]);
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
    // Si su actividad se anota en el registro del condominio. Se guarda solo
    // cuando el admin lo decide a mano; si no, manda el valor por omisión de
    // `seRegistra()`: lo de un vecino es privado, lo del condominio se anota.
    ...(typeof registrarPedido === 'boolean' ? { registrar: registrarPedido } : {}),
  }, { merge: true });
  const privado = {
    tuyaDeviceId: String(tuyaDeviceId || '').trim(),
    // De qué cuenta Smart Life vinculada vino este aparato. Con una sola cuenta
    // da igual, pero en cuanto haya varias (una por edificio, o la de un vecino)
    // es lo único que distingue "se cayó un aparato" de "se desvinculó una
    // cuenta entera". Etiqueta libre: la pone quien vincula.
    cuenta: String(cuentaTuya || '').trim().slice(0, 40),
    codigo: (codigo || 'switch_1').trim(),
    // Shelly (Cloud Control API): el id del aparato y el canal de la salida.
    shellyId: String(shellyId || '').trim(),
    shellyCanal: Math.max(0, Math.min(7, Number(shellyCanal) || 0)),
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
  { ...RARA, secrets: SECRETS_HB },
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

// Lista los aparatos de la cuenta de Shelly, para no copiar el Device ID a mano
// de la app. Marca cuáles ya están dados de alta y cuántas salidas tiene cada
// uno, que es lo que evita adivinar el canal.
//
// La parte que enumera se apoya en la v1, deprecada (ver `listarIds`). Por eso
// el fallo NO se propaga como error: se devuelve la lista vacía con un aviso, el
// editor se queda con su campo de Device ID a mano y dar de alta un aparato
// sigue funcionando igual que antes de que existiera esto.
exports.adminListarDispositivosShelly = onCall(
  { ...RARA, secrets: SECRETS_SHELLY },
  async (request) => {
    await exigirAdmin(request);
    let lista;
    try {
      lista = await shelly().listar();
    } catch (err) {
      return { dispositivos: [], aviso: `No pude traer la lista de Shelly: ${err.message}` };
    }
    // Los que ya están en ViYi, para no ofrecerlos como nuevos.
    const snap = await db.collection('dispositivos').get();
    const yaEstan = new Map();
    for (const doc of snap.docs) {
      const cfg = await db.doc(`dispositivos/${doc.id}/privado/tuya`).get();
      const sid = cfg.exists ? (cfg.data().shellyId || '') : '';
      if (sid) yaEstan.set(sid, doc.data().nombre || doc.id);
    }
    return {
      dispositivos: lista.map((d) => ({ ...d, yaEsta: yaEstan.get(d.id) || '' })),
    };
  },
);

// Diagnóstico: estado crudo de un accesorio de Homebridge (tipo + características + valores).
exports.adminAccesorioCrudo = onCall(
  { ...RARA, secrets: SECRETS_HB },
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
  { ...RARA, secrets: [TUYA_CLIENT_ID, TUYA_CLIENT_SECRET] },
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

exports.adminEliminarDispositivo = onCall(RARA, async (request) => {
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

// ---- Galería de skins (fase C: cada vecino crea el suyo) ----

// Una sola función con varias acciones a propósito: cada función desplegada
// cuenta contra la cuota de CPU de Cloud Run (ver setGlobalOptions arriba), así
// que tres exports serían tres slots por algo de uso esporádico.
const ANIMACIONES_SKIN = ['ninguna', 'girar', 'latido',
  'balanceo', 'rebote', 'vibracion', 'destello', 'latidoFuerte'];
const TIPOS_SKIN = ['puerta', 'cortina', 'ascensor', 'luz', 'termostato', 'rele', 'otro'];
// Un data URI de WebP de 256px ronda los 20 KB. Se topa MUY por debajo del
// límite de 1 MB del documento para que un skin no pueda inflar la lectura de
// la galería, que baja entera al arrancar la app.
const MAX_IMAGEN_SKIN = 220000;
// Generaciones con IA por vecino y por día. Cada imagen se paga, así que el tope
// es lo que evita que un rato de juego se convierta en una factura. Al admin no
// se le aplica: él es quien cura la galería. Subir del carrete NO cuenta —no
// cuesta nada— y por eso quien agote el día todavía puede hacer su botón.
const MAX_IA_DIA = 3;

// El día se cuenta en hora de Venezuela (UTC-4), no en UTC: si no, el cupo se
// reiniciaría a las 8 de la noche y "3 al día" no significaría lo que parece.
function diaLocal() {
  return new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10);
}

// Consume una generación del cupo del vecino, o falla si ya no le quedan. Va en
// transacción porque el cupo es lo único que separa el juego de la factura: dos
// toques rápidos al botón no deben colarse los dos.
async function consumirCupoIA(uid) {
  const ref = db.doc(`usuarios/${uid}`);
  const hoy = diaLocal();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const previo = (snap.exists && snap.data().iaSkins) || {};
    const usadas = previo.dia === hoy ? Number(previo.n) || 0 : 0;
    if (usadas >= MAX_IA_DIA) {
      throw new HttpsError(
        'resource-exhausted',
        `Ya generaste ${MAX_IA_DIA} botones hoy. Mañana tienes otros ${MAX_IA_DIA}, `
        + 'y mientras puedes subir una foto del carrete.',
      );
    }
    tx.set(ref, { iaSkins: { dia: hoy, n: usadas + 1 } }, { merge: true });
    return MAX_IA_DIA - usadas - 1;
  });
}

// Avisa a los admin de que hay botones de vecinos esperando aprobación.
//
// UNA VEZ AL DÍA como mucho, aunque se publiquen diez. Un correo por botón
// convierte una tarde creativa en diez correos, y a partir del tercero se dejan
// de leer — que es exactamente el problema que esto viene a resolver. El correo
// dice CUÁNTOS esperan, así que uno solo cuenta la historia completa.
//
// La marca del día vive en `ajustes/skins.avisado` y se cuenta en hora de
// Venezuela, igual que el cupo de IA.
const AJUSTES_SKINS = 'ajustes/skins';

async function avisarDeSkinsEsperando({ apiKey, nombre, autor }) {
  const ref = db.doc(AJUSTES_SKINS);
  const hoy = diaLocal();

  // La marca se pone en transacción y ANTES de mandar nada: dos vecinos
  // publicando a la vez leerían los dos "hoy no se ha avisado" y saldrían dos
  // correos. Quien gane la transacción es el que avisa.
  const meToca = await db.runTransaction(async (tx) => {
    const previo = (await tx.get(ref)).data() || {};
    if (previo.avisado === hoy) return false;
    tx.set(ref, { avisado: hoy }, { merge: true });
    return true;
  });
  if (!meToca) return;

  // Si algo falla a partir de aquí hay que DEVOLVER la marca. Si no, el día
  // queda quemado por un correo que nunca salió y el aviso no llega hasta
  // mañana — justo el silencio que esto viene a romper.
  try {
    // Se cuentan después de guardar el que acaba de entrar, así que este ya está
    // incluido. `count()` no baja los documentos: las imágenes van dentro y
    // traerlas para contarlas sería descargar la galería entera.
    const { count } = (await db.collection('skins').where('publico', '==', false).count().get()).data();
    // El nombre lo escribió un vecino y `maqueta` interpola el cuerpo tal cual:
    // sin escapar, cualquiera podría meter HTML en un correo que lee el admin.
    const comoSeLlama = escaparHtml(nombre);
    const quien = autor.nombre ? ` de ${escaparHtml(autor.nombre)}` : '';
    const cuantos = count === 1
      ? `Hay un botón esperando tu aprobación: "${comoSeLlama}"${quien}.`
      : `Hay ${count} botones esperando tu aprobación. El último es "${comoSeLlama}"${quien}.`;

    const enviados = await avisarAlDueno({
      apiKey,
      asunto: count === 1 ? 'ViYi · un botón espera tu aprobación' : `ViYi · ${count} botones esperan tu aprobación`,
      titulo: 'Botones esperando',
      cuerpo: `${cuantos} Mientras no lo apruebes solo lo ve quien lo hizo, así que nadie más puede ponérselo. `
        + 'Los tienes en Perfil → Locker → Crear un botón, marcados como "esperando".',
      textoBoton: 'Abrir ViYi',
      enlace: 'https://www.viyi.ai/',
    });
    if (!enviados) throw new Error('el correo no llegó a ningún administrador');
  } catch (err) {
    await ref.set({ avisado: '' }, { merge: true }).catch(() => {});
    throw err;
  }
}

// Devuelve la generación cuando el generador no entregó imagen. El cupo se cobra
// ANTES de llamar a Vertex (si no, dos toques seguidos se cuelan los dos), y sin
// esto un fallo nuestro le costaría un intento a quien no hizo nada mal.
async function devolverCupoIA(uid) {
  const ref = db.doc(`usuarios/${uid}`);
  const hoy = diaLocal();
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const previo = (snap.exists && snap.data().iaSkins) || {};
      if (previo.dia !== hoy) return;   // ya cambió el día: no hay nada que devolver
      const n = Math.max(0, (Number(previo.n) || 0) - 1);
      tx.set(ref, { iaSkins: { dia: hoy, n } }, { merge: true });
    });
  } catch (e) {
    // Que falle la devolución no puede tapar el error de verdad, que es el que
    // el vecino necesita leer.
    console.warn('No se pudo devolver el cupo de IA:', e.message);
  }
}

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

// El nombre del export dice `admin` por historia (nació en la fase B, cuando
// solo el admin creaba botones) y se conserva a propósito: renombrarlo obliga a
// desplegar una función nueva y borrar la vieja, churn que no compra nada. Hoy
// entra cualquier vecino activo y lo que cambia es qué puede hacer cada uno.
exports.adminSkins = onCall({ timeoutSeconds: 120, secrets: [RESEND_API_KEY] }, async (request) => {
  const yo = await exigirSesion(request);
  const soyAdmin = yo.rol === 'admin';
  const uid = request.auth.uid;
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
    // El cupo se cobra aquí, antes de gastar la imagen. Si el generador no
    // entrega nada se devuelve; el admin no tiene tope porque él cura la galería.
    const restantes = soyAdmin ? null : await consumirCupoIA(uid);
    try {
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
          if (img) return { ok: true, mimeType: img.mimeType, data: img.data, restantes };
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
    } catch (err) {
      // Sin imagen no se cobra el intento: el vecino no hizo nada mal.
      if (!soyAdmin) await devolverCupoIA(uid);
      throw err;
    }
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
    // El id sale del nombre, así que dos vecinos pueden pedir el mismo. Antes
    // esto era `merge` a secas y bastaba con que el admin no se repitiera; ahora
    // publica cualquiera y sin este guardia el botón de uno PISARÍA el de otro
    // —que además no ve, porque los privados no salen en su galería—.
    const ref = db.doc(`skins/${id}`);
    const previo = await ref.get();
    // Vale también para el admin: pisar el botón de un vecino sin querer, y
    // quedarse además como su autor, no es una potestad que haga falta. Para
    // quitarlo tiene `eliminar`.
    if (previo.exists && previo.data().autor !== uid) {
      throw new HttpsError('already-exists', 'Ese nombre ya está tomado. Ponle otro.');
    }
    await ref.set({
      nombre, imagen, animacion, tipos,
      prompt: String(d.prompt || '').slice(0, 700),
      autor: uid,
      // Un botón de vecino nace PRIVADO: solo lo ve él, hasta que el admin lo
      // publique en la galería. Es lo que hace que abrir la creación no exija una
      // cola de moderación — sin aprobar, un diseño no llega a nadie más.
      publico: soyAdmin,
      // El contador solo se estrena al crear: volver a publicar encima del
      // propio botón no debe borrar cuánta gente lo usa.
      ...(previo.exists ? {} : { usos: 0 }),
      creado: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    skinsCache = { ids: null, hasta: 0 };   // que se pueda elegir de una vez

    // El botón de un vecino nace privado esperando aprobación, y hasta ahora el
    // admin solo se enteraba si abría el Locker por su cuenta: en la práctica la
    // curaduría podía no pasar nunca y el vecino se quedaba esperando sin saber
    // a qué. El aviso va DESPUÉS de guardar y en su propio try: en este punto el
    // botón ya está publicado, y fallar aquí no puede deshacer eso ni contarle
    // al vecino que su botón no se guardó.
    if (!soyAdmin) {
      try {
        await avisarDeSkinsEsperando({ apiKey: RESEND_API_KEY.value(), nombre, autor: yo });
      } catch (e) {
        console.error('No pude avisar de los botones esperando:', e.message);
      }
    }
    return { ok: true, id, publico: soyAdmin };
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
    const doc = await ref.get();
    if (!doc.exists) {
      throw new HttpsError('not-found', 'Ese botón ya no existe.');
    }
    if (!soyAdmin && doc.data().autor !== uid) {
      throw new HttpsError('permission-denied', 'Ese botón no es tuyo.');
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
    const ref = db.doc(`skins/${id}`);
    const doc = await ref.get();
    // Borrar algo que ya no está es el resultado que se pedía: no es un error.
    if (doc.exists) {
      if (!soyAdmin && doc.data().autor !== uid) {
        throw new HttpsError('permission-denied', 'Ese botón no es tuyo.');
      }
      await ref.delete();
    }
    skinsCache = { ids: null, hasta: 0 };
    return { ok: true };
  }

  // Curaduría: el admin decide qué botón de un vecino entra a la galería común y
  // qué se vuelve a guardar. Ocultar no borra —el autor sigue usando el suyo—,
  // así que retirar algo de la galería no le quita a nadie su botón.
  if (accion === 'aprobar') {
    if (!soyAdmin) {
      throw new HttpsError('permission-denied', 'Solo el administrador publica en la galería.');
    }
    const d = request.data || {};
    const id = String(d.id || '').trim();
    if (!/^[a-z0-9-]{2,40}$/.test(id)) {
      throw new HttpsError('invalid-argument', 'Falta el id.');
    }
    const ref = db.doc(`skins/${id}`);
    if (!(await ref.get()).exists) {
      throw new HttpsError('not-found', 'Ese botón ya no existe.');
    }
    await ref.set({ publico: d.publico !== false }, { merge: true });
    skinsCache = { ids: null, hasta: 0 };
    return { ok: true, id, publico: d.publico !== false };
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
exports.enviarResetClave = onCall({ ...OCASIONAL, secrets: [RESEND_API_KEY] }, async (request) => {
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

    const deTuya = disps.filter((d) => !['homebridge', 'shelly'].includes(d.proveedor) && d.cfg && d.cfg.tuyaDeviceId);
    const deHb = disps.filter((d) => d.proveedor === 'homebridge' && d.cfg && d.cfg.accesorioId);
    const deShelly = disps.filter((d) => d.proveedor === 'shelly' && d.cfg && d.cfg.shellyId);

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

    // Shelly aparte, como los otros dos: que su nube esté caída no debe ocultar
    // el estado de los Tuya.
    const onlineShelly = new Map();
    if (deShelly.length) {
      try {
        const info = await shelly().infoLote(deShelly.map((d) => d.cfg.shellyId));
        for (const [id, v] of info) onlineShelly.set(id, v.online);
      } catch (err) {
        console.warn('Shelly no respondió al revisar conexión:', err.message);
      }
    }

    const ahora = admin.firestore.Timestamp.now();
    const lista = [];
    for (const d of disps) {
      let online = null; // null = no se pudo averiguar
      if (!d.cfg) online = null;
      else if (d.proveedor === 'homebridge') {
        if (onlineHb.size) online = onlineHb.has(d.cfg.accesorioId);
      } else if (d.proveedor === 'shelly') {
        if (onlineShelly.size) online = onlineShelly.get(d.cfg.shellyId) === true;
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
exports.adminProveedores = onCall(RARA, async (request) => {
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
  { secrets: [TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, ...SECRETS_HB, ...SECRETS_SHELLY] },
  async (request) => {
    await exigirAdmin(request);
    return revisarConexion();
  },
);

// Chequeo automático cada 10 minutos, para que la caída quede registrada con su
// hora aunque nadie esté mirando el panel.
// La fecha en que vence el servicio de Tuya, desde la propia app.
//
// Vivía solo en Firestore y para cambiarla había que entrar a la consola de
// Firebase, buscar la colección y editar el campo a mano. Es un dato que se
// renueva cada pocos meses, así que ese paseo se repetiría para siempre — y
// olvidarlo significa quedarse sin aviso anticipado justo la vez que importa.
//
// Solo el admin GLOBAL: es el que puede renovar en Tuya. Un admin de un
// edificio no tiene nada que hacer aquí.
exports.ajusteTuya = onCall(OCASIONAL, async (request) => {
  const usuario = await exigirAdmin(request);
  if ((usuario.administraIds || []).length) {
    throw new HttpsError('permission-denied', 'Esto lo lleva el administrador general.');
  }

  const ref = db.doc(AJUSTES_TUYA);
  const vence = request.data && request.data.vence;

  // Sin `vence` es una consulta; con él, se guarda.
  if (vence !== undefined) {
    const limpio = String(vence || '').trim();
    // Vacío borra la fecha — es la forma de decir "no la sé todavía".
    if (limpio && !/^\d{4}-\d{2}-\d{2}$/.test(limpio)) {
      throw new HttpsError('invalid-argument', 'La fecha va como 2027-02-07.');
    }
    if (limpio && Number.isNaN(new Date(limpio).getTime())) {
      throw new HttpsError('invalid-argument', 'Esa fecha no existe.');
    }
    await ref.set({ vence: limpio || null }, { merge: true });
  }

  const guardado = (await ref.get()).data() || {};
  return {
    vence: guardado.vence || '',
    // Lo que vio la última revisión: sirve para que la pantalla pueda decir si
    // Tuya está respondiendo, no solo cuándo vence.
    caido: guardado.caido === true,
    revisado: guardado.revisado || null,
  };
});

// --- Que el servicio de Tuya no se venza sin avisar ------------------------
//
// El IoT Core de Tuya es lo que deja abrirle a alguien: sin él, todos los
// dispositivos Tuya dejan de responder a la vez. Y se contrata por tiempo.
//
// El 6 de agosto de 2026 llegó el aviso de vencimiento por correo **el día
// antes**, y solo porque el dueño abrió ese correo. Sin eso, la primera señal
// habría sido un vecino parado frente a una puerta que no abre. Eso no puede
// depender de que alguien lea un correo a tiempo.
//
// Dos capas, porque fallan por motivos distintos:
//
//   1. **La fecha.** Se guarda cuándo vence y se avisa desde tres semanas
//      antes, todos los días. Es lo único que da aviso ANTICIPADO — cuando el
//      servicio ya falló, avisar llega tarde.
//   2. **El canario.** Una llamada de verdad a Tuya, por si la fecha guardada
//      quedó vieja o Tuya corta antes de lo dicho. Detecta el corte el mismo
//      día, aunque nadie haya actualizado nada.
//
// La fecha vive en Firestore (`ajustes/tuya.vence`) y no en el código: se
// renueva cada pocos meses, y un dato que cambia no se despliega.
const DIAS_DE_AVISO = 21;
const AJUSTES_TUYA = 'ajustes/tuya';

const enDias = (ms) => Math.ceil(ms / 86400000);

async function avisarAlDueno({ asunto, titulo, cuerpo, textoBoton, enlace, apiKey }) {
  // A los administradores globales: son los que pueden hacer algo al respecto.
  const snap = await db.collection('usuarios').where('rol', '==', 'admin').get();
  const correos = snap.docs.map((d) => d.data().email).filter(Boolean);
  if (!correos.length) {
    console.error('Nadie a quien avisar:', asunto);
    return 0;
  }
  const html = maquetaCorreo({ titulo, cuerpo, textoBoton, enlace, cierre: 'ViYi' });
  // Un fallo con un admin no debe dejar sin aviso a los demás, así que se sigue
  // con la lista. Pero se devuelve cuántos SALIERON de verdad: quien avise una
  // sola vez (los botones esperando) necesita saber si el aviso llegó a alguien
  // o si el correo se perdió y hay que reintentar.
  let enviados = 0;
  for (const para of correos) {
    await enviarCorreo({ apiKey, para, asunto, html, texto: `${titulo}\n\n${cuerpo}` })
      .then(() => { enviados += 1; })
      .catch((e) => console.error('No pude avisar a', para, e.message));
  }
  return enviados;
}

exports.vigilarServicioTuya = onSchedule(
  {
    ...RARA,
    // Una vez al día basta: lo que se vigila cambia en semanas, no en minutos.
    schedule: 'every day 09:00',
    timeZone: 'America/Caracas',
    secrets: [TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, RESEND_API_KEY],
  },
  async () => {
    const ref = db.doc(AJUSTES_TUYA);
    const guardado = (await ref.get()).data() || {};
    const apiKey = RESEND_API_KEY.value();

    // --- 1. El canario ---
    // Una llamada barata y real. Si Tuya contesta, el servicio está vivo. Va
    // PRIMERO porque es la única fuente de verdad: la fecha guardada es una
    // nota nuestra y puede estar vieja; esto es el banco contestando.
    let vivo = true;
    let motivo = '';
    try {
      const tuya = new TuyaClient({
        baseUrl: TUYA_BASE_URL.value(),
        clientId: TUYA_CLIENT_ID.value(),
        clientSecret: TUYA_CLIENT_SECRET.value(),
      });
      await tuya.obtenerToken();
    } catch (err) {
      // Solo el servicio vencido cuenta como caída. Un fallo de red o un
      // tropiezo de Tuya no es lo mismo, y avisar por eso sería el cuento del
      // lobo: a la tercera nadie lee el correo.
      if (esServicioVencido(err)) { vivo = false; motivo = err.message; }
      else console.warn('El canario de Tuya no pudo comprobar (no es vencimiento):', err.message);
    }

    // --- 2. La fecha, para avisar ANTES ---
    if (!guardado.vence) {
      // Sin fecha guardada no hay aviso anticipado posible, y eso hay que
      // decirlo en vez de dar por hecho que todo está bien.
      console.warn(`Sin fecha de vencimiento en ${AJUSTES_TUYA}: no puedo avisar con antelación.`);
    } else {
      const faltan = enDias(new Date(guardado.vence).getTime() - Date.now());

      if (faltan > 0 && faltan <= DIAS_DE_AVISO) {
        await avisarAlDueno({
          apiKey,
          asunto: `ViYi · el servicio de Tuya vence en ${faltan} día${faltan === 1 ? '' : 's'}`,
          titulo: `Quedan ${faltan} día${faltan === 1 ? '' : 's'}`,
          cuerpo: `El IoT Core de Tuya vence el ${guardado.vence}. Sin él, los dispositivos Tuya dejan de abrir. `
            + 'La extensión gratuita tarda uno o dos días hábiles en aprobarse, así que conviene pedirla ya.',
          textoBoton: 'Renovar en Tuya',
          enlace: 'https://www.tuya.com/vas/user/service',
        });
      } else if (faltan <= 0 && vivo) {
        // La fecha pasó y Tuya sigue contestando: se renovó y nadie actualizó la
        // nota. NO se avisa de un vencimiento que no ocurrió —eso es la falsa
        // alarma que hace que se dejen de leer los avisos— pero sí queda dicho
        // que la fecha está vieja, porque mientras lo esté no hay aviso
        // anticipado la próxima vez.
        console.warn(
          `La fecha de Tuya (${guardado.vence}) ya pasó y el servicio responde: se renovó. `
          + `Actualiza \`vence\` en ${AJUSTES_TUYA} o el próximo vencimiento llegará sin aviso.`
        );
      }
    }

    // Se avisa UNA vez por caída, no todos los días: un correo diario sobre algo
    // que ya sabes se vuelve ruido y se deja de leer.
    if (!vivo && !guardado.caido) {
      await avisarAlDueno({
        apiKey,
        asunto: 'ViYi · Tuya dejó de responder — servicio vencido',
        titulo: 'Los dispositivos Tuya no responden',
        cuerpo: `Tuya está rechazando las llamadas por falta de servicio: ${motivo}. `
          + 'Hasta que se renueve, los botones de dispositivos Tuya no van a abrir. '
          + 'Los de Homebridge y Shelly siguen funcionando.',
        textoBoton: 'Renovar en Tuya',
        enlace: 'https://www.tuya.com/vas/user/service',
      });
    }
    if (vivo !== !guardado.caido) {
      await ref.set({ caido: !vivo, revisado: new Date().toISOString() }, { merge: true });
    }
  },
);

exports.revisarConexionProgramada = onSchedule(
  { ...RARA, schedule: 'every 10 minutes', timeZone: 'America/Caracas', secrets: [TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, ...SECRETS_HB, ...SECRETS_SHELLY] },
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
exports.misInvitados = onCall(OCASIONAL, async (request) => {
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
exports.darAcceso = onCall({ ...OCASIONAL, secrets: [RESEND_API_KEY] }, async (request) => {
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
exports.crearPase = onCall(OCASIONAL, async (request) => {
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
exports.revocarPase = onCall(OCASIONAL, async (request) => {
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
  { secrets: [TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, ...SECRETS_HB, ...SECRETS_SHELLY], minInstances: 1 },
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
      if ((dispositivo.proveedor || 'tuya') === 'shelly') {
        // Un portón de pulso no tiene estado que leer (el relé vuelve solo), y
        // el interruptor sí, pero lee de otro sitio. Se devuelve desconocido en
        // vez de caer por el camino de Tuya con un id que no existe allí.
        return { estado: null };
      }
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
