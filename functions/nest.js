// Cliente para la API de Google Smart Device Management (SDM), que es por donde
// se habla con los aparatos Nest.
//
// A diferencia de Homebridge, aquí NO hay túnel ni nada que vivir en la casa:
// se habla con Google directamente desde las Functions. Eso quita del medio al
// Raspberry, a su reloj y a su conexión —los tres se cayeron el 1 de agosto de
// 2026 y con ellos la cámara y los dos termostatos—.
//
// La autenticación es OAuth con un `refreshToken` de larga vida: se cambia por
// un token de acceso de una hora, que se cachea. El refresh token sale de la
// consola de Device Access y es el mismo que usaba el plugin de Homebridge.
class NestClient {
  constructor({ projectId, clientId, clientSecret, refreshToken }) {
    this.projectId = String(projectId || '').trim();
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.token = null;
    this.tokenExpira = 0;
  }

  get base() {
    return `https://smartdevicemanagement.googleapis.com/v1/enterprises/${this.projectId}`;
  }

  async obtenerToken() {
    if (this.token && Date.now() < this.tokenExpira - 60000) return this.token;
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      // El motivo se dice entero: `invalid_grant` aquí significa casi siempre
      // que la app de OAuth volvió a "Testing" —ahí el refresh token caduca a
      // los 7 días— y sin ese detalle el fallo parece aleatorio.
      const causa = data.error_description || data.error || `HTTP ${res.status}`;
      throw new Error(`Google no renovó el acceso a Nest: ${causa}`);
    }
    this.token = data.access_token;
    this.tokenExpira = Date.now() + (Number(data.expires_in) || 3600) * 1000;
    return this.token;
  }

  async peticion(metodo, url, body) {
    const token = await this.obtenerToken();
    const res = await fetch(url, {
      method: metodo,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const causa = (data.error && data.error.message) || `HTTP ${res.status}`;
      throw new Error(`Nest: ${causa}`);
    }
    return data;
  }

  // Se admite el `name` completo (`enterprises/…/devices/…`) o solo el id
  // pelado, que es lo que se guarda en el aparato y lo que se copia a mano.
  urlDe(idONombre) {
    const s = String(idONombre || '').trim();
    const nombre = s.startsWith('enterprises/') ? s : `enterprises/${this.projectId}/devices/${s}`;
    return `https://smartdevicemanagement.googleapis.com/v1/${nombre}`;
  }

  async listarDispositivos() {
    const data = await this.peticion('GET', `${this.base}/devices`);
    return (data.devices || []).map((d) => {
      const traits = d.traits || {};
      const info = traits['sdm.devices.traits.Info'] || {};
      const stream = traits['sdm.devices.traits.CameraLiveStream'] || null;
      const sala = (d.parentRelations || [])[0] || {};
      return {
        id: String(d.name || '').split('/').pop(),
        nombre: info.customName || sala.displayName || String(d.name || '').split('/').pop(),
        tipo: String(d.type || '').split('.').pop(),   // THERMOSTAT | CAMERA | DOORBELL | DISPLAY
        sala: sala.displayName || '',
        protocolosVideo: stream ? (stream.supportedProtocols || []) : [],
        traits,
      };
    });
  }

  dispositivo(id) {
    return this.peticion('GET', this.urlDe(id));
  }

  comando(id, command, params) {
    return this.peticion('POST', `${this.urlDe(id)}:executeCommand`, { command, params: params || {} });
  }
}

// --- Termostatos ---------------------------------------------------------
//
// Nest habla en Celsius y con dos vocabularios distintos según el modo: cuando
// está en HEAT o COOL se manda UNA temperatura (`SetHeat`/`SetCool`), y cuando
// está en HEATCOOL se mandan las DOS a la vez (`SetRange`). Mandar la que no
// toca devuelve un error del que no se deduce nada.
const MODOS_NEST = { off: 'OFF', calor: 'HEAT', frio: 'COOL', auto: 'HEATCOOL' };
const MODOS_VIYI = { OFF: 'off', HEAT: 'calor', COOL: 'frio', HEATCOOL: 'auto' };

// Nest devuelve el objetivo en crudo y con muchos decimales —un termostato
// puesto en 74 °F contesta 23.295258 °C—, así que se redondea para enseñarlo:
// el objetivo al medio grado, que es la granularidad real de la perilla, y la
// ambiente a un decimal, que es una medición y fingir precisión sería mentir.
const alMedio = (n) => (n == null ? null : Math.round(n * 2) / 2);
const aUnDecimal = (n) => (n == null ? null : Math.round(n * 10) / 10);

function estadoTermostato(traits) {
  const t = traits || {};
  const modo = (t['sdm.devices.traits.ThermostatMode'] || {}).mode || null;
  const objetivo = t['sdm.devices.traits.ThermostatTemperatureSetpoint'] || {};
  const ambiente = t['sdm.devices.traits.Temperature'] || {};
  const hvac = (t['sdm.devices.traits.ThermostatHvac'] || {}).status || null;
  return {
    encendido: modo !== null && modo !== 'OFF',
    modo: MODOS_VIYI[modo] || null,
    // En HEATCOOL hay dos objetivos; se enseña el de calor, que es el que la
    // perilla de ViYi sabe representar. El rango completo llega en `rango`.
    objetivo: alMedio(objetivo.heatCelsius != null ? objetivo.heatCelsius
      : (objetivo.coolCelsius != null ? objetivo.coolCelsius : null)),
    rango: (objetivo.heatCelsius != null && objetivo.coolCelsius != null)
      ? { calor: alMedio(objetivo.heatCelsius), frio: alMedio(objetivo.coolCelsius) } : null,
    actual: aUnDecimal(ambiente.ambientTemperatureCelsius),
    // `hvac` dice si en este momento está soplando: es lo que distingue
    // "puesto en frío" de "enfriando ahora mismo".
    activo: hvac && hvac !== 'OFF' ? String(hvac).toLowerCase() : null,
  };
}

module.exports = { NestClient, MODOS_NEST, MODOS_VIYI, estadoTermostato };
