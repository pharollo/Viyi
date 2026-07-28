const crypto = require('crypto');

function sha256(texto) {
  return crypto.createHash('sha256').update(texto, 'utf8').digest('hex');
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
      throw new Error(`Tuya rechazó ${path}: ${data.msg} (código ${data.code})`);
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
      throw new Error(`Tuya rechazó ${path}: ${data.msg} (código ${data.code})`);
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
      '/v1.0/iot-01/associated-users/devices?page_size=100',
      '/v1.3/iot-03/devices?page_size=100',
      '/v1.0/iot-03/devices?page_size=100',
    ];
    let ultimo = null;
    for (const ruta of rutas) {
      try {
        const res = await this.peticion('GET', ruta);
        const arr = Array.isArray(res) ? res : ((res && (res.devices || res.list)) || []);
        return { ruta, dispositivos: arr };
      } catch (e) {
        ultimo = e;
      }
    }
    throw ultimo || new Error('Tuya no devolvió la lista de dispositivos.');
  }

  // Info de varios dispositivos en UNA sola llamada (trae el campo `online`).
  // Se pide por lotes porque Tuya limita cuántos ids acepta por petición.
  async infoLote(deviceIds) {
    const ids = (deviceIds || []).filter(Boolean);
    const salida = [];
    for (let i = 0; i < ids.length; i += 20) {
      const lote = ids.slice(i, i + 20);
      const res = await this.peticion('GET', `/v1.0/iot-03/devices?device_ids=${lote.join(',')}`);
      // Según el endpoint, Tuya devuelve el arreglo suelto o dentro de `list`.
      const arr = Array.isArray(res) ? res : ((res && res.list) || []);
      salida.push(...arr);
    }
    return salida;
  }
}

module.exports = { TuyaClient };
