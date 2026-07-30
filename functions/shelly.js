// Cliente de la Cloud Control API de Shelly.
//
// Es la API de AUTOSERVICIO: una `auth_key` que se genera en la propia app de
// Shelly (User settings → Authorization cloud key) y que sirve para todos los
// aparatos de ESA cuenta. No es la Integrator API, que sí permite varias
// cuentas de terceros pero exige licencia B2B pedida a soporte.
//
// Dos cosas de esta API que condicionan el diseño de aquí:
//
//  1. **Una petición por segundo.** No se puede ráfagear como con Tuya. Por eso
//     el pulso usa `toggle_after` (el propio aparato se apaga solo) en vez de
//     mandar encender y apagar seguidos.
//  2. **La `auth_key` muere si el dueño cambia su contraseña de Shelly.** Los
//     botones dejan de funcionar sin aviso, así que ese error se traduce a un
//     mensaje que lo dice con esas palabras en vez de un "no respondió".
class ShellyClient {
  constructor({ servidor, authKey }) {
    // La app de Shelly muestra el servidor a veces con esquema y a veces sin
    // él; se acepta como venga para que no haya que adivinar el formato.
    const bruto = String(servidor || '').trim().replace(/\/$/, '');
    this.servidor = bruto && !/^https?:\/\//i.test(bruto) ? `https://${bruto}` : bruto;
    this.authKey = authKey;
  }

  async pedir(path, cuerpo) {
    if (!this.servidor || !this.authKey) {
      throw new Error('Falta la configuración de Shelly (servidor o clave).');
    }
    const url = `${this.servidor}${path}?auth_key=${encodeURIComponent(this.authKey)}`;
    let res;
    let data;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cuerpo),
      });
      const texto = await res.text();
      data = texto ? JSON.parse(texto) : {};
    } catch (err) {
      throw new Error(`No se pudo hablar con Shelly: ${err.message}`);
    }
    if (!res.ok) {
      throw new Error(this.traducir(res.status, data));
    }
    return data;
  }

  // Los errores de Shelly vienen como cadenas fijas. Se traducen aquí, en un
  // solo sitio, para que quien llama no tenga que conocerlas.
  traducir(estado, data) {
    const bruto = String((data && (data.error_message || data.errors || data.error)) || '');
    if (estado === 401 || /auth/i.test(bruto)) {
      // El caso más probable y el más difícil de adivinar: alguien cambió la
      // contraseña de la cuenta Shelly y la clave de autorización cambió con
      // ella. Hay que generar una nueva y volver a guardarla.
      return 'La clave de autorización de Shelly ya no vale. Suele pasar cuando se cambia la contraseña de la cuenta: hay que generar otra en la app de Shelly y volver a guardarla.';
    }
    if (/DEVICE_OFFLINE/.test(bruto)) return 'El aparato de Shelly está desconectado.';
    if (/DEVICE_NOT_FOUND/.test(bruto)) return 'Shelly no encuentra ese aparato. Revisa el Device ID.';
    if (/DEVICE_INVALID_CHANNEL/.test(bruto)) return 'Ese canal no existe en el aparato.';
    if (/DEVICE_FAILED_COMMAND/.test(bruto)) return 'El aparato recibió la orden pero no la ejecutó.';
    if (/BAD_REQUEST/.test(bruto)) return 'Shelly rechazó la petición por mal formada.';
    return `Shelly respondió ${estado}${bruto ? `: ${bruto}` : ''}`;
  }

  // Enciende o apaga una salida. `segundosVuelta` usa `toggle_after`: el propio
  // aparato revierte el estado pasado ese tiempo, sin depender de que llegue
  // una segunda petición.
  async interruptor(id, canal, encendido, segundosVuelta) {
    const cuerpo = { id, channel: Number(canal) || 0, on: Boolean(encendido) };
    if (segundosVuelta) cuerpo.toggle_after = segundosVuelta;
    return this.pedir('/v2/devices/api/set/switch', cuerpo);
  }

  // Estado de varios aparatos. La API acepta 10 por llamada, así que se parte
  // en trozos; y como además limita a una petición por segundo, van en serie
  // con su pausa.
  async infoLote(ids) {
    const limpios = [...new Set((ids || []).filter(Boolean))];
    const salida = new Map();
    for (let i = 0; i < limpios.length; i += 10) {
      if (i > 0) await new Promise((r) => setTimeout(r, 1100));
      const data = await this.pedir('/v2/devices/api/get', {
        ids: limpios.slice(i, i + 10),
        select: ['status'],
      });
      const lista = Array.isArray(data) ? data : (data && data.data) || [];
      for (const d of lista) {
        if (d && d.id) salida.set(d.id, { online: d.online === 1 || d.online === true, datos: d });
      }
    }
    return salida;
  }
}

module.exports = { ShellyClient };
