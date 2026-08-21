// Dejar a Joanna SOLO en 7B: quita el 1D (y el Tulipanes IV explícito, que se
// hereda por la cadena). Corre en GitHub Actions con el service account.
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'viyi-25a09' });
const db = admin.firestore();

const MAX_NIVELES = 6;
const TULIPANES_ID = 'inm_0ad829540289c092';
const EMAIL = 'joanna.frewa@gmail.com';

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

(async () => {
  // 7B bajo Tulipanes IV
  const inms = (await db.collection('inmuebles').get()).docs.map((s) => ({ id: s.id, ...s.data() }));
  const b7 = inms.find((i) => i.padre === TULIPANES_ID && String(i.nombre).trim().toLowerCase() === '7b');
  if (!b7) { console.error('No encuentro el 7B'); process.exit(1); }
  console.log(`7B = ${b7.id}`);

  // Joanna
  const q = await db.collection('usuarios').where('email', '==', EMAIL).get();
  if (q.empty) { console.error('No encuentro a Joanna por email'); process.exit(1); }
  const ref = q.docs[0].ref;
  console.log('Antes:', JSON.stringify(q.docs[0].data().inmuebles || []));

  const inmuebles = [{ id: b7.id, nombre: '7B', tipo: b7.tipo || 'apartamento' }];
  const inmueblesIds = await conAncestros([b7.id]);
  await ref.set({ inmuebles, inmueblesIds }, { merge: true });
  console.log('Después:', JSON.stringify(inmuebles), '| inmueblesIds:', JSON.stringify(inmueblesIds));

  // Verificar
  const admins = (await db.collection('usuarios').where('rol', '==', 'admin').get()).docs.map((s) => s.data());
  const B = new Set(inmueblesIds);
  for (const a of admins) {
    const ve = !(a.administraIds || []).length || (a.administraIds || []).some((x) => B.has(x));
    console.log(`  ${a.nombre}: ${ve ? 'LA VE ✓' : 'no la ve'}`);
  }
  console.log('LISTO.');
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e && e.stack || e); process.exit(1); });
