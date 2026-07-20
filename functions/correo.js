// Envío de correos propios de ViYi (en vez de los de Firebase, que son texto
// plano, en inglés y no admiten logo ni diseño).
//
// Se manda por la API HTTP de Resend. El HTML va con estilos en línea y
// maquetado con tablas porque los clientes de correo ignoran <style>, flexbox
// y grid. El logo se referencia por URL: los clientes no rasterizan SVG ni
// aceptan data URIs, así que apunta al PNG publicado en el site.

const REMITENTE = 'Soporte ViYi <soporte@viyi.ai>';
const LOGO = 'https://www.viyi.ai/logo-viyi.png';

const FONDO = '#1b1c1e';
const SUPERFICIE = '#212225';
const TEXTO = '#e8eaec';
const SUAVE = '#8d9297';
const PRIMARIO = '#a5ff2e';
const SOBRE_PRIMARIO = '#16210a';

// Escapa el texto que se interpola en el HTML.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Arma el correo completo (cabecera con logo, cuerpo, botón y pie).
function maqueta({ titulo, cuerpo, textoBoton, enlace, cierre }) {
  const url = esc(enlace);
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"><title>${esc(titulo)}</title></head>
<body style="margin:0;padding:0;background:${FONDO};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${FONDO};padding:28px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:${SUPERFICIE};border-radius:18px;">
      <tr><td style="padding:30px 30px 0;" align="center">
        <img src="${LOGO}" alt="ViYi" width="64" height="64" style="display:block;border:0;border-radius:14px;">
      </td></tr>
      <tr><td style="padding:22px 30px 0;font-family:Helvetica,Arial,sans-serif;color:${TEXTO};font-size:16px;line-height:1.6;">
        ${cuerpo}
      </td></tr>
      <tr><td align="center" style="padding:26px 30px 6px;">
        <a href="${url}" style="display:inline-block;padding:13px 30px;border-radius:10px;background:${PRIMARIO};color:${SOBRE_PRIMARIO};font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:bold;text-decoration:none;">${esc(textoBoton)}</a>
      </td></tr>
      <tr><td style="padding:16px 30px 0;font-family:Helvetica,Arial,sans-serif;color:${SUAVE};font-size:13px;line-height:1.6;word-break:break-all;">
        Si el botón no funciona, copia este enlace:<br><a href="${url}" style="color:${PRIMARIO};">${url}</a>
      </td></tr>
      <tr><td style="padding:22px 30px 30px;font-family:Helvetica,Arial,sans-serif;color:${SUAVE};font-size:14px;line-height:1.6;">
        ${cierre}
      </td></tr>
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
      <tr><td align="center" style="padding:18px 12px 0;font-family:Helvetica,Arial,sans-serif;color:${SUAVE};font-size:12px;line-height:1.6;">
        ViYi · <a href="https://www.viyi.ai/privacidad.html" style="color:${SUAVE};">Privacidad</a> ·
        <a href="https://www.viyi.ai/terminos.html" style="color:${SUAVE};">Términos</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

// Correo de "olvidé mi clave".
function plantillaResetClave(enlace) {
  return {
    asunto: 'Restablece tu clave de ViYi',
    html: maqueta({
      titulo: 'Restablece tu clave de ViYi',
      cuerpo: '<p style="margin:0 0 12px;">¡Hola!</p>'
        + '<p style="margin:0;">Olvidaste tu clave, ¡eso pasa! Para crear una nueva, '
        + 'haz click en el botón o sigue el enlace de abajo.</p>',
      textoBoton: 'Clave Nueva',
      enlace,
      cierre: '<p style="margin:0 0 12px;">Si no pediste cambiar tu clave, '
        + 'puedes ignorar este correo.</p><p style="margin:0;">Saludos,<br>Soporte ViYi</p>',
    }),
    texto: '¡Hola!\n\n'
      + 'Olvidaste tu clave, ¡eso pasa! Para crear una nueva, sigue este enlace:\n\n'
      + `${enlace}\n\n`
      + 'Si no pediste cambiar tu clave, puedes ignorar este correo.\n\n'
      + 'Saludos,\nSoporte ViYi',
  };
}

// Manda el correo por la API de Resend. Node 20 ya trae fetch global.
async function enviar({ apiKey, para, asunto, html, texto }) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: REMITENTE, to: [para], subject: asunto, html, text: texto }),
  });
  if (!resp.ok) {
    const detalle = await resp.text().catch(() => '');
    // El detalle puede traer datos del destinatario: se registra recortado.
    throw new Error(`Resend respondió ${resp.status}: ${detalle.slice(0, 200)}`);
  }
  return resp.json().catch(() => ({}));
}

module.exports = { plantillaResetClave, enviar, REMITENTE };
