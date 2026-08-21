// Escanea fichas fantasma (vecino con inmueble pero SIN nombre) y las remienda
// con lo que haya en Auth (nombre de Google, correo). Corre en GitHub Actions
// con el service account del despliegue. Temporal.
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'viyi-25a09' });
const db = admin.firestore();
const auth = admin.auth();

const MAX_NIVELES = 6;

async function conAncestros(ids) {
  const vistos = new Set();
  let frente = [...new Set((ids || []).filter((x) => typeof x === 'string' && x))];
  for (let n = 0; n < MAX_NIVELES && frente.length; n++) {
    frente.forEach((id) => vistos.add(id));
    const snaps = await Promise.all(frente.map((id) => db.doc(`inmuebles/${id}`).get()));
    frente = snaps.map((s) => (s.exists ? (s.data().padre || '') : '')).filter((p) => p && !vistos.has(p));
  }
  return [...vistos];
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

(async () => {
  const snap = await db.collection('usuarios').get();
  const fantasmas = snap.docs.filter((s) => !String(s.data().nombre || '').trim());
  console.log(`Total usuarios: ${snap.size} | fichas SIN nombre: ${fantasmas.length}`);

  let remendadas = 0;
  const revisar = [];
  for (const s of fantasmas) {
    const d = s.data();
    const uid = s.id;
    let au = null;
    try { au = await auth.getUser(uid); } catch (e) { /* sin cuenta de Auth */ }
    if (!au) {
      console.log(`  ⚠ ${uid}: SIN cuenta de Auth (ficha huérfana). inmuebles=${JSON.stringify((d.inmuebles || []).map((x) => x.nombre))}. No la toco.`);
      revisar.push(uid);
      continue;
    }
    const correo = d.email || au.email || '';
    // Nombre: el de Google si lo hay; si no, la parte antes de @ (provisional).
    let nombre = '';
    let apellido = String(d.apellido || '');
    if (au.displayName && au.displayName.trim()) {
      const partes = au.displayName.trim().split(/\s+/);
      nombre = partes[0];
      if (!apellido) apellido = partes.slice(1).join(' ');
    } else if (correo.includes('@')) {
      nombre = cap(correo.split('@')[0].replace(/[._]+/g, ' ').split(' ')[0]);
      revisar.push(`${uid} (${correo}) — nombre provisional "${nombre}", revisar`);
    }
    const cambios = {
      nombre: nombre || '(sin nombre)',
      apellido,
      email: correo,
      rol: d.rol || 'vecino',
      activo: d.activo === false ? false : true,
    };
    if (Array.isArray(d.inmuebles)) {
      cambios.inmueblesIds = await conAncestros(d.inmuebles.map((x) => x && x.id).filter(Boolean));
    }
    await s.ref.set(cambios, { merge: true });
    remendadas++;
    console.log(`  ✓ ${uid} <${correo}> -> nombre="${cambios.nombre}" apellido="${apellido}" rol=${cambios.rol}`);
  }

  console.log(`\nRemendadas: ${remendadas}. A revisar a mano: ${revisar.length}`);
  revisar.forEach((r) => console.log(`  · ${r}`));
  console.log('LISTO.');
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e && e.stack || e); process.exit(1); });
