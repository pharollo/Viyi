// 1) Consola de Firebase → Configuración del proyecto → Tus apps → App web → Config
// 2) Pega aquí el objeto firebaseConfig de tu proyecto.
// Estos valores son públicos por diseño (identifican tu proyecto, no dan acceso);
// la seguridad real está en las reglas de Firestore y en las Cloud Functions.
export const firebaseConfig = {
  apiKey: "AIzaSyBDaYfTCgXXmKvO3y4JaGFGgZWR4PEi8q4",
  authDomain: "viyi-a1fef.firebaseapp.com",
  projectId: "viyi-a1fef",
  storageBucket: "viyi-a1fef.firebasestorage.app",
  messagingSenderId: "475503984065",
  appId: "1:475503984065:web:722225206f2349252d0340",
  measurementId: "G-TSTM3H6JYY",
};

// Región donde se despliegan las Cloud Functions (déjala igual salvo que la cambies allá).
export const FUNCTIONS_REGION = "us-central1";

// Nombre que se muestra en el encabezado de la app.
export const NOMBRE_CONDOMINIO = "Mi Condominio";
