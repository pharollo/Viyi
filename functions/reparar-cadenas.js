// Crear a Joanna Frewa BIEN: apartamento 7B bajo Tulipanes IV + su ficha.
// Corre en GitHub Actions con el service account del despliegue.
const admin = require('firebase-admin');
const crypto = require('crypto');
admin.initializeApp({ projectId: 'viyi-25a09' });
const db = admin.firestore();
const auth = admin.auth();

const MAX_NIVELES = 6;
const TULIPANES_ID = 'inm_0ad829540289c092';   // "Tulipanes IV" (residencias)
const MODELO_APTO_ID = 'inm_0f14c922b4120349';  // "1D" — de aquí copio el molde
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
  // --- 1. Apartamento 7B: reusar si ya existe, si no crearlo copiando a 1D ---
  const inms = (await db.collection('inmuebles').get()).docs.map((s) => ({ id: s.id, ...s.data() }));
  let apto = inms.find((i) => i.padre === TULIPANES_ID && String(i.nombre).trim().toLowerCase() === '7b');
  if (apto) {
    console.log(`7B ya existe: id=${apto.id}`);
  } else {
    const molde = (await db.doc(`inmuebles/${MODELO_APTO_ID}`).get()).data() || {};
    console.log('Molde (1D):', JSON.stringify(molde));
    const nuevoId = 'inm_' + crypto.randomBytes(8).toString('hex');
    const doc = { ...molde, nombre: '7B', padre: TULIPANES_ID };
    // No arrastrar campos que deban ser únicos del molde (por si los hubiera).
    delete doc.creado; delete doc.creadoEn;
    await db.doc(`inmuebles/${nuevoId}`).set(doc);
    apto = { id: nuevoId, ...doc };
    console.log(`7B creado: id=${nuevoId} ->`, JSON.stringify(doc));
  }

  // --- 2. Cuenta de Auth de Joanna: reusar o crear ---
  let user = null;
  try { user = await auth.getUserByEmail(EMAIL); console.log(`Auth: ya existe uid=${user.uid}`); }
  catch (e) { console.log(`Auth: no existe (${e.code})`); }
  if (!user) {
    user = await auth.createUser({ email: EMAIL, displayName: 'Joanna' });
    console.log(`Auth: creada uid=${user.uid}`);
  }

  // --- 3. Ficha de Joanna asignada al 7B (merge para no pisar lo que hubiera) ---
  const ref = db.doc(`usuarios/${user.uid}`);
  const prev = await ref.get();
  console.log('Ficha previa:', prev.exists ? JSON.stringify(prev.data()) : '(no existía)');
  const prevD = prev.exists ? prev.data() : {};
  const prevInm = Array.isArray(prevD.inmuebles) ? prevD.inmuebles : [];
  const inmuebles = [...prevInm];
  if (!inmuebles.some((x) => x && x.id === apto.id)) {
    inmuebles.push({ id: apto.id, nombre: '7B', tipo: apto.tipo || 'apartamento' });
  }
  const ficha = {
    nombre: 'Joanna',
    apellido: 'Frewa',
    unidad: prevD.unidad || '7B',
    email: EMAIL,
    rol: prevD.rol === 'admin' ? 'admin' : 'vecino',
    activo: true,
    dispositivos: Array.isArray(prevD.dispositivos) ? prevD.dispositivos : [],
    inmuebles,
    inmueblesIds: await conAncestros(inmuebles.map((x) => x && x.id).filter(Boolean)),
  };
  await ref.set(ficha, { merge: true });
  console.log('Ficha guardada:', JSON.stringify(ficha));

  // --- 4. Verificar quién la ve ---
  const admins = (await db.collection('usuarios').where('rol', '==', 'admin').get()).docs.map((s) => ({ uid: s.id, ...s.data() }));
  const B = new Set(ficha.inmueblesIds);
  for (const a of admins) {
    const global = !(a.administraIds || []).length;
    const ve = global || (a.administraIds || []).some((x) => B.has(x));
    console.log(`  ${a.nombre} <${a.email}>: ${ve ? 'LA VE ✓' : 'no la ve'}`);
  }
  console.log('LISTO.');
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e && e.stack || e); process.exit(1); });
