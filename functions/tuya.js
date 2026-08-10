const crypto = require('crypto');

function sha256(texto) {
  return crypto.createHash('sha256').update(texto, 'utf8').digest('hex');
}

// "El servicio se venció" no es un fallo más.
//
// El IoT Core de Tuya —lo que deja mandarle comandos a un dispositivo— se
// contrata por tiempo y caduca con fecha. Cuando caduca, TODAS las llamadas
// empiezan a fallar a la vez, y el mensaje del banco de errores genérico
// ("Tuya rechazó /v1.0/…") manda a buscar el problema al sitio equivocado: se
// revisa el dispositivo, el wifi, la cuenta… cuando lo que hay que hacer es
// renovar en el panel de Tuya.
//
// Se reconoce por el código y por el texto, no solo por uno: Tuya devuelve
// 1106 y 28841105 para permisos y suscripción, y los mensajes hablan de "not
// subscribed" o "permission". Con puertas de por medio, es mejor pasarse de
// listo aquí que dejar el diagnóstico al azar.
const CODIGOS_SIN_SERVICIO = new Set([1106, 28841002, 28841105]);

function esServicioVencido(err) {
  if (!err) return false;
  if (err.codigoTuya && CODIGOS_SIN_SERVICIO.has(Number(err.codigoTuya))) return true;
  return /not\s*subscrib|no\s*permission|permission\s*deny|expired?\b/i.test(err.message || '');
}

// El error lleva pegado el código de Tuya, para no tener que sacarlo del texto
// más adelante.
function errorDeTuya(path, data) {
  return Object.assign(
    new Error(`Tuya rechazó ${path}: ${data.msg} (código ${data.code})`),
    { codigoTuya: data.code }
  );
}

class TuyaClient {
  constructor({ baseUrl, clientId, clientSecret }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.token = null;
    this.tokenExpira = 0;
  }

  firmar(payload) {
    return crypto
      .createHmac('sha256', this.clientSecret)
      .update(payload, 'utf8')
      .digest('hex')
      .toUpperCase();
  }

  // Peticiones al propio endpoint de token: se firman SIN access_token (todavía
  // no hay ninguno). Lo comparten el token del proyecto y los de usuario.
  async sinToken(metodo, path) {
    const t = Date.now().toString();
    const stringToSign = [metodo, sha256(''), '', path].join('\n');
    const sign = this.firmar(this.clientId + t + stringToSign);
    const res = await fetch(this.baseUrl + path, {
      method: metodo,
      headers: { client_id: this.clientId, sign, t, sign_method: 'HMAC-SHA256' },
    });
    const data = await res.json();
    if (!data.success) {
      throw errorDeTuya(path, data);
    }
    return data.result;
  }

  async obtenerToken() {
    if (this.token && Date.now() < this.tokenExpira - 60000) return this.token;
    const r = await this.sinToken('GET', '/v1.0/token?grant_type=1');
    this.token = r.access_token;
    this.tokenExpira = Date.now() + r.expire_time * 1000;
    return this.token;
  }

  // ---- OAuth 2.0: que un vecino autorice SUS dispositivos ----
  // A diferencia del QR de la consola (que vincula la cuenta entera y hay que
  // hacerlo estando presente), aquí el vecino entra desde la app y ELIGE qué
  // dispositivos comparte.
  urlAutorizacion(redirectUri, estado) {
    const p = new URLSearchParams({ client_id: this.clientId, redirect_uri: redirectUri });
    // `state` es el mecanismo estándar de OAuth para saber QUIÉN volvió; sin él
    // el callback no podría atribuirle el token a nadie.
    if (estado) p.set('state', estado);
    return `${this.baseUrl}/v1.0/token/authorize?${p.toString()}`;
  }

  // Cambia el código que devuelve Tuya por el token de ESE usuario.
  tokenPorCodigo(code) {
    return this.sinToken('GET', `/v1.0/token?grant_type=2&code=${encodeURIComponent(code)}`);
  }

  renovarToken(refreshToken) {
    return this.sinToken('GET', `/v1.0/token/${encodeURIComponent(refreshToken)}`);
  }

  async peticion(metodo, path, body) {
    const token = await this.obtenerToken();
    const cuerpo = body ? JSON.stringify(body) : '';
    const t = Date.now().toString();
    const stringToSign = [metodo, sha256(cuerpo), '', path].join('\n');
    const sign = this.firmar(this.clientId + token + t + stringToSign);
    const res = await fetch(this.baseUrl + path, {
      method: metodo,
      headers: {
        client_id: this.clientId,
        access_token: token,
        sign,
        t,
        sign_method: 'HMAC-SHA256',
        'Content-Type': 'application/json',
      },
      body: cuerpo || undefined,
    });
    const data = await res.json();
    if (!data.success) {
      throw errorDeTuya(path, data);
    }
    return data.result;
  }

  enviarComandos(deviceId, commands) {
    return this.peticion('POST', `/v1.0/iot-03/devices/${deviceId}/commands`, { commands });
  }

  estado(deviceId) {
    return this.peticion('GET', `/v1.0/iot-03/devices/${deviceId}/status`);
  }

  especificacion(deviceId) {
    return this.peticion('GET', `/v1.0/iot-03/devices/${deviceId}/specification`);
  }

  // Todos los dispositivos que alcanza el proyecto, vengan de la cuenta que
  // vengan. Tuya ha movido este listado de sitio entre versiones y el que
  // enumera usuarios exige conocer el `schema` de la app (que varía según sea
  // Smart Life o Tuya Smart), así que se prueban varias rutas y se usa la
  // primera que responda. Cada dispositivo trae `uid`: eso es lo que dice de
  // QUÉ cuenta vinculada vino.
  async listarTodos() {
    const rutas = [
      { base: '/v1.0/iot-01/associated-users/devices', pagina: 'last_row_key' },
      { base: '/v1.3/iot-03/devices', pagina: 'page' },
      { base: '/v1.0/iot-03/devices', pagina: 'page' },
    ];
    let ultimo = null;
    for (const r of rutas) {
      try {
        return { ruta: r.base, dispositivos: await this.paginar(r) };
      } catch (e) {
        ultimo = e;
      }
    }
    throw ultimo || new Error('Tuya no devolvió la lista de dispositivos.');
  }

  // Recorre TODAS las páginas. Sin esto solo llegaban las primeras 20 y los
  // demás dispositivos desaparecían sin que nada lo avisara — el peor tipo de
  // fallo: una lista que parece completa y no lo es.
  async paginar({ base, pagina }) {
    const salida = [];
    let clave = '';
    for (let vuelta = 0; vuelta < 50; vuelta++) {
      const sep = base.includes('?') ? '&' : '?';
      const q = pagina === 'last_row_key'
        ? `${sep}size=100${clave ? `&last_row_key=${encodeURIComponent(clave)}` : ''}`
        : `${sep}page_size=100&page_no=${vuelta + 1}`;
      const res = await this.peticion('GET', base + q);
      const arr = Array.isArray(res) ? res : ((res && (res.devices || res.list)) || []);
      salida.push(...arr);
      const hayMas = res && res.has_more === true;
      clave = (res && res.last_row_key) || '';
      // Se corta cuando Tuya dice que no hay más, cuando la página viene vacía,
      // o cuando no devuelve con qué pedir la siguiente.
      if (!arr.length || !hayMas || (pagina === 'last_row_key' && !clave)) break;
    }
    return salida;
  }

  // Quién es el dueño de una cuenta vinculada. Solo necesita el uid (no el
  // `schema` de la app, que no sabemos cuál es), así que sirve para ponerle
  // nombre a las cuentas en vez de enseñar un identificador ilegible.
  infoUsuario(uid) {
    return this.peticion('GET', `/v1.0/users/${encodeURIComponent(uid)}/infos`);
  }

  // Info de varios dispositivos en UNA sola llamada (trae el campo `online`).
  // Se pide por lotes porque Tuya limita cuántos ids acepta por petición.
  // ⚠️ Un aparato inaccesible hace que Tuya rechace el LOTE ENTERO, no solo su
  // parte. El 10 de agosto de 2026 dos aparatos de una cuenta que dejó de estar
  // vinculada devolvían "permission denied", y con eso los DIECIOCHO se
  // quedaron sin revisar durante dieciséis horas: el informe de conexión seguía
  // enseñando la última foto buena, con un aparato en rojo que ya estaba
  // arreglado. El fallo era mudo —se capturaba arriba y se seguía— y de esos
  // los peores: no se ve un error, se ve un dato viejo que parece fresco.
  //
  // Por eso, si un lote falla, se vuelve a preguntar uno por uno: se paga una
  // llamada por aparato solo cuando algo va mal, y los sanos se salvan.
  async infoLote(deviceIds) {
    const ids = (deviceIds || []).filter(Boolean);
    const salida = [];
    const pedir = async (lote) => {
      const res = await this.peticion('GET', `/v1.0/iot-03/devices?device_ids=${lote.join(',')}`);
      // Según el endpoint, Tuya devuelve el arreglo suelto o dentro de `list`.
      return Array.isArray(res) ? res : ((res && res.list) || []);
    };
    for (let i = 0; i < ids.length; i += 20) {
      const lote = ids.slice(i, i + 20);
      try {
        salida.push(...await pedir(lote));
      } catch (err) {
        if (lote.length === 1) {
          // Este aparato concreto no se puede consultar. Se deja fuera y se
          // dice cuál: sin el id en el registro, encontrarlo entre dieciocho
          // costó una hora.
          console.error(`Tuya no da información de ${lote[0]}: ${err.message}`);
          continue;
        }
        console.error(`El lote de Tuya falló (${lote.length} aparatos); voy uno por uno: ${err.message}`);
        for (const id of lote) {
          try {
            salida.push(...await pedir([id]));
          } catch (err2) {
            console.error(`Tuya no da información de ${id}: ${err2.message}`);
          }
        }
      }
    }
    return salida;
  }
}

module.exports = { TuyaClient, esServicioVencido };
