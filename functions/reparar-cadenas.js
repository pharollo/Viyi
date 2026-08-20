// Reparación de una vez: diagnostica por qué un vecino "está guardado pero no
// aparece" y resincroniza las cadenas expandidas de TODOS (inmueblesIds de los
// vecinos y administraIds de los admins), que es lo que hace la app al guardar
// un inmueble. Idempotente y seguro: solo recalcula campos derivados del árbol.
//
// Corre en GitHub Actions con el mismo service account del despliegue.
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'viyi-25a09' });
const db = admin.firestore();

const MAX_NIVELES = 6;

// Un inmueble MÁS sus ancestros (hacia arriba). Incluye el propio id.
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

// El subárbol (hacia abajo) de unos inmuebles: ellos y todos sus descendientes.
async function subarbol(ids, todos) {
  const raices = [...new Set((ids || []).filter((x) => typeof x === 'string' && x))];
  if (!raices.length) return [];
  const hijos = new Map();
  todos.forEach((i) => {
    const padre = i.padre || '';
    if (!hijos.has(padre)) hijos.set(padre, []);
    hijos.get(padre).push(i.id);
  });
  const vistos = new Set();
  let frente = raices;
  for (let n = 0; n < MAX_NIVELES && frente.length; n++) {
    frente.forEach((id) => vistos.add(id));
    frente = frente.flatMap((id) => hijos.get(id) || []).filter((id) => !vistos.has(id));
  }
  return [...vistos];
}

const idsDe = (arr) => (arr || []).map((x) => (x && x.id) || x).filter((x) => typeof x === 'string' && x);
const cruzan = (a, b) => { const B = new Set(b || []); return (a || []).some((x) => B.has(x)); };

(async () => {
  const inmSnap = await db.collection('inmuebles').get();
  const inms = inmSnap.docs.map((s) => ({ id: s.id, ...s.data() }));

  console.log('=== INMUEBLES que se parecen a "Tulipanes IV" ===');
  const tul = inms.filter((i) => /tulipanes/i.test(i.nombre || ''));
  tul.forEach((i) => {
    const hijos = inms.filter((h) => h.padre === i.id);
    console.log(`  id=${i.id} "${i.nombre}" tipo=${i.tipo} padre=${i.padre || '(raíz)'} | hijos: ${hijos.map((h) => `${h.nombre}(${h.id})`).join(', ') || 'ninguno'}`);
  });

  // --- Joanna ---
  console.log('\n=== JOANNA ===');
  let joanna = null;
  const q = await db.collection('usuarios').where('email', '==', 'joanna.frewa@gmail.com').get();
  if (!q.empty) joanna = { uid: q.docs[0].id, ...q.docs[0].data() };
  if (!joanna) {
    console.log('  NO se encontró por el email exacto; busco por nombre "frewa"…');
    const todos = await db.collection('usuarios').get();
    const m = todos.docs.find((s) => /frewa/i.test((s.data().apellido || '') + ' ' + (s.data().nombre || '') + ' ' + (s.data().email || '')));
    if (m) joanna = { uid: m.id, ...m.data() };
  }
  if (!joanna) {
    console.log('  ✗ No existe ninguna ficha de Joanna. (Entonces nunca se creó.)');
  } else {
    console.log(`  uid=${joanna.uid} "${joanna.nombre} ${joanna.apellido || ''}" email=${joanna.email} rol=${joanna.rol} activo=${joanna.activo}`);
    console.log(`  inmuebles=${JSON.stringify((joanna.inmuebles || []).map((x) => ({ id: x.id, nombre: x.nombre, tipo: x.tipo })))}`);
    console.log(`  inmueblesIds (guardado)   =${JSON.stringify(joanna.inmueblesIds || [])}`);
    console.log(`  inmueblesIds (recalculado)=${JSON.stringify(await conAncestros(idsDe(joanna.inmuebles)))}`);
  }

  // --- Admins ---
  console.log('\n=== ADMINS y si ven a Joanna ===');
  const admins = (await db.collection('usuarios').where('rol', '==', 'admin').get()).docs.map((s) => ({ uid: s.id, ...s.data() }));
  for (const a of admins) {
    const subRe = await subarbol(idsDe(a.administra), inms);
    console.log(`  ${a.nombre} <${a.email}> global=${!(a.administraIds || []).length}`);
    console.log(`    administra=${JSON.stringify(idsDe(a.administra))}`);
    console.log(`    administraIds guardado=${JSON.stringify(a.administraIds || [])}  recalculado=${JSON.stringify(subRe)}`);
    if (joanna) {
      console.log(`    ¿la ve con lo GUARDADO? ${cruzan(joanna.inmueblesIds, a.administraIds)}  | ¿la vería tras recalcular TODO? ${cruzan(await conAncestros(idsDe(joanna.inmuebles)), subRe)}`);
    }
  }

  // --- Reparar: resync de todos ---
  console.log('\n=== REPARANDO (resync de cadenas de TODOS) ===');
  const usuarios = await db.collection('usuarios').get();
  let cambios = 0;
  let batch = db.batch();
  let enLote = 0;
  for (const s of usuarios.docs) {
    const d = s.data();
    const c = {};
    const exp = await conAncestros(idsDe(d.inmuebles));
    const antes = d.inmueblesIds || [];
    if (antes.length !== exp.length || exp.some((x) => !antes.includes(x))) c.inmueblesIds = exp;
    if (Array.isArray(d.administra) && d.administra.length) {
      const sub = await subarbol(idsDe(d.administra), inms);
      const antesSub = d.administraIds || [];
      if (antesSub.length !== sub.length || sub.some((x) => !antesSub.includes(x))) c.administraIds = sub;
    }
    if (Object.keys(c).length) {
      cambios++;
      batch.set(s.ref, c, { merge: true });
      console.log(`  fix ${d.nombre || s.id} <${d.email || ''}>: ${Object.keys(c).join(', ')}`);
      if (++enLote >= 400) { await batch.commit(); batch = db.batch(); enLote = 0; }
    }
  }
  if (enLote) await batch.commit();
  console.log(`  ${cambios} fichas actualizadas.`);

  // --- Verificar Joanna después ---
  if (joanna) {
    const d = (await db.doc(`usuarios/${joanna.uid}`).get()).data();
    console.log('\n=== JOANNA DESPUÉS ===');
    console.log(`  inmueblesIds=${JSON.stringify(d.inmueblesIds || [])}`);
    const laVen = [];
    for (const a of admins) {
      const ad = (await db.doc(`usuarios/${a.uid}`).get()).data();
      if (!(ad.administraIds || []).length || cruzan(d.inmueblesIds, ad.administraIds)) laVen.push(a.nombre);
    }
    console.log(`  Ahora la ven: ${laVen.join(', ') || '(NADIE — el problema es otro)'}`);
  }
  console.log('\nLISTO.');
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e && e.stack || e); process.exit(1); });
