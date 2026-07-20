// 1) Consola de Firebase → Configuración del proyecto → Tus apps → App web → Config
// 2) Pega aquí el objeto firebaseConfig de tu proyecto.
// Estos valores son públicos por diseño (identifican tu proyecto, no dan acceso);
// la seguridad real está en las reglas de Firestore y en las Cloud Functions.
export const firebaseConfig = {
  apiKey: "AIzaSyDgYJ9unbuT3Xw3IJ1DjqfCDRlCs6Ae1jA",
  // Dominio propio (Firebase Hosting) en vez de viyi-25a09.firebaseapp.com: es
  // el que Google le muestra al usuario al entrar con su cuenta, y el que sale
  // en el enlace del correo de clave nueva. Para revertir, basta volver a
  // "viyi-25a09.firebaseapp.com" — su URI de redirección sigue autorizado.
  authDomain: "auth.viyi.ai",
  projectId: "viyi-25a09",
  storageBucket: "viyi-25a09.firebasestorage.app",
  messagingSenderId: "1009083361507",
  appId: "1:1009083361507:web:4542a4e00a2ec17e61bdd6",
  measurementId: "G-DVRQSY6SXY",
};

// Región donde se despliegan las Cloud Functions (déjala igual salvo que la cambies allá).
export const FUNCTIONS_REGION = "us-central1";

// Nombre que se muestra en el encabezado de la app.
export const NOMBRE_CONDOMINIO = "Mi Condominio";
