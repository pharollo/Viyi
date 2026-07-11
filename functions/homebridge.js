// Cliente para la API REST de homebridge-config-ui-x (el plugin de interfaz web
// de Homebridge). Se expone típicamente por un túnel HTTPS (Cloudflare Tunnel /
// Tailscale) y se autentica con usuario/clave, devolviendo un JWT temporal.
class HomebridgeClient {
  constructor({ baseUrl, username, password }) {
    this.baseUrl = String(baseUrl || '').trim().replace(/\/$/, '');
    this.username = username;
    this.password = password;
    this.token = null;
    this.tokenExpira = 0;
  }

  async obtenerToken() {
    if (this.token && Date.now() < this.tokenExpira - 60000) return this.token;
    const res = await fetch(this.baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password }),
    });
    if (!res.ok) {
      throw new Error(`Homebridge no autorizó el acceso (HTTP ${res.status}).`);
    }
    const data = await res.json();
    if (!data || !data.access_token) {
      throw new Error('Homebridge no entregó un token de acceso.');
    }
    this.token = data.access_token;
    // expires_in viene en segundos (por defecto ~8 h). Se cachea conservador.
    this.tokenExpira = Date.now() + (Number(data.expires_in) || 28800) * 1000;
    return this.token;
  }

  async peticion(metodo, path, body) {
    const token = await this.obtenerToken();
    const res = await fetch(this.baseUrl + path, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      this.token = null; // fuerza re-login la próxima vez
      throw new Error('La sesión de Homebridge expiró; reintenta.');
    }
    if (!res.ok) {
      throw new Error(`Homebridge rechazó ${path} (HTTP ${res.status}).`);
    }
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
  }

  // Lista todos los accesorios con sus características.
  listarAccesorios() {
    return this.peticion('GET', '/api/accessories');
  }

  // Estado (values) de un accesorio.
  accesorio(uniqueId) {
    return this.peticion('GET', `/api/accessories/${encodeURIComponent(uniqueId)}`);
  }

  // Fija una característica (On, Brightness, TargetPosition, HoldPosition, …).
  setCaracteristica(uniqueId, characteristicType, value) {
    return this.peticion('PUT', `/api/accessories/${encodeURIComponent(uniqueId)}`, {
      characteristicType,
      value,
    });
  }
}

module.exports = { HomebridgeClient };
