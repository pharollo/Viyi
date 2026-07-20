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

  async obtenerToken() {
    if (this.token && Date.now() < this.tokenExpira - 60000) return this.token;
    const path = '/v1.0/token?grant_type=1';
    const t = Date.now().toString();
    const stringToSign = ['GET', sha256(''), '', path].join('\n');
    const sign = this.firmar(this.clientId + t + stringToSign);
    const res = await fetch(this.baseUrl + path, {
      headers: { client_id: this.clientId, sign, t, sign_method: 'HMAC-SHA256' },
    });
    const data = await res.json();
    if (!data.success) {
      throw new Error(`Tuya no entregó token: ${data.msg} (código ${data.code})`);
    }
    this.token = data.result.access_token;
    this.tokenExpira = Date.now() + data.result.expire_time * 1000;
    return this.token;
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
