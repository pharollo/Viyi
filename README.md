<img src="docs/logo.svg" width="72" alt="Logo de Viyi.io">

# Viyi.io

*De "vigilante"* — app web para que los vecinos de un condominio enciendan/apaguen y abran/cierren dispositivos Tuya (portones, puertas, ascensores, relés, switches wifi) con permisos por usuario y registro de auditoría.

## Arquitectura

```
Vecino (navegador)
   └─> Web estática en GitHub Pages (docs/)
         └─> Firebase Authentication  (login)
         └─> Firestore                (usuarios, permisos, log de auditoría)
         └─> Cloud Functions          (única pieza que conoce las credenciales Tuya)
               └─> Tuya OpenAPI       (ejecuta el comando en el dispositivo)
```

Las credenciales de Tuya **nunca** llegan al navegador: viven como secretos en Cloud Functions. La web de GitHub Pages es pública por naturaleza, así que solo contiene interfaz.

## Estructura del repo

| Ruta | Qué es |
|---|---|
| `docs/` | La web (GitHub Pages se sirve desde aquí) |
| `functions/` | Cloud Functions: autorización, comando Tuya y auditoría |
| `firestore.rules` | Reglas de seguridad de Firestore |
| `firebase.json` | Configuración de despliegue de Firebase |

## Paso 1 — Proyecto cloud en Tuya

1. Entra a [iot.tuya.com](https://iot.tuya.com) con tu cuenta y crea un proyecto en **Cloud → Development** (elige el data center donde está tu cuenta de Smart Life, normalmente *Western America* para Latinoamérica).
2. En la pestaña **Devices → Link Tuya App Account**, escanea el QR con la app Smart Life/Tuya. Tus dispositivos aparecerán listados con su **Device ID**.
3. Copia el **Access ID (client id)** y el **Access Secret** del proyecto (pestaña Overview).
4. Para saber el código del interruptor de cada dispositivo (`switch_1`, `switch`, etc.): **Devices → Debug Device → Instruction set**.

> ⚠️ La suscripción *Trial* de IoT Core es gratuita pero **caduca y hay que renovarla** (Cloud → Cloud Services → IoT Core → Extend Trial). Si caduca, los botones dejan de funcionar. Anótalo en el calendario.

> 💡 Para portones/puertas conviene configurar el relé en modo **inching** (pulso) desde la app Smart Life. Así el pulso lo genera el propio relé y la puerta no depende de que llegue el segundo comando de apagado.

## Paso 2 — Proyecto en Firebase

1. Crea un proyecto en [console.firebase.google.com](https://console.firebase.google.com).
2. **Authentication → Sign-in method**: habilita *Email/Password*.
3. **Firestore Database**: créala en modo producción.
4. **Configuración del proyecto → Facturación**: sube al plan **Blaze** (necesario para que las Functions hagan llamadas externas a Tuya; con el uso de un condominio el costo real es ~$0).
5. **Authentication → Settings → Authorized domains**: agrega `TU-USUARIO.github.io`.
6. Registra una **App web** (Configuración del proyecto → Tus apps) y copia el objeto `firebaseConfig` en `docs/firebase-config.js`.

## Paso 3 — Desplegar reglas y funciones

```bash
npm install -g firebase-tools
firebase login
cd viyi
firebase use --add            # elige tu proyecto y llámalo "default"

# Secretos de Tuya (te los pedirá por consola)
firebase functions:secrets:set TUYA_CLIENT_ID
firebase functions:secrets:set TUYA_CLIENT_SECRET

# Data center de Tuya (solo si NO es América)
cp functions/.env.example functions/.env   # y edita TUYA_BASE_URL

cd functions && npm install && cd ..
firebase deploy --only firestore:rules,functions
```

## Paso 4 — Cargar los datos en Firestore

Todo se administra desde la consola de Firebase (la consola ignora las reglas de seguridad, por eso la app no necesita pantallas de administración para empezar).

**Usuarios** — primero créalos en *Authentication → Add user* (email y contraseña), copia su UID y crea el documento `usuarios/{UID}`:

```json
{
  "nombre": "María Pérez",
  "unidad": "Apto 3B",
  "rol": "vecino",
  "activo": true,
  "dispositivos": ["porton-garaje", "puerta-peatonal"]
}
```

- `rol`: `"vecino"` o `"admin"` (el admin ve todos los dispositivos y el registro de actividad).
- Para quitarle el acceso a alguien: `activo: false` (o edita su lista `dispositivos`). Es inmediato.

**Dispositivos** — documento `dispositivos/{id-que-tu-elijas}`:

```json
{
  "nombre": "Portón del garaje",
  "tipo": "puerta",
  "modo": "pulso",
  "etiquetaBoton": "Abrir",
  "orden": 1,
  "activo": true
}
```

- `tipo`: `puerta` | `ascensor` | `luz` | `rele` | `otro` (solo agrupa visualmente).
- `modo`: `"pulso"` (un botón que activa y desactiva solo, para puertas) o `"interruptor"` (botones Encender/Apagar).

Y dentro de ese documento, la subcolección privada que solo leen las Functions — documento `dispositivos/{id}/privado/tuya`:

```json
{
  "tuyaDeviceId": "eb1234567890abcdef",
  "codigo": "switch_1",
  "pulsoMs": 1000
}
```

## Paso 5 — Publicar la web en GitHub Pages

```bash
git init
git add .
git commit -m "Viyi.io: app de acceso del condominio"
gh repo create viyi --private --source . --push
```

Luego en GitHub: **Settings → Pages → Source: Deploy from a branch → main / `/docs`**. En un minuto la app queda en `https://TU-USUARIO.github.io/viyi/`.

> El repo puede ser privado y GitHub Pages seguir siendo público (en plan gratuito, Pages de repos privados requiere GitHub Pro; si no lo tienes, usa repo público — no pasa nada, el código no contiene secretos).

## Cómo funciona la seguridad

- El navegador jamás ve credenciales Tuya; solo llama a la función `ejecutarComando` con el ID del dispositivo.
- La función verifica en Firestore que el usuario exista, esté activo y tenga ese dispositivo asignado (o sea admin) antes de tocar Tuya.
- Cada intento —exitoso, fallido o **denegado**— queda en la colección `registros` con usuario, unidad, dispositivo, acción y fecha.
- Las reglas de Firestore impiden que un vecino lea dispositivos ajenos, perfiles de otros o el log.

## Endurecimiento opcional (cuando quieras)

- **App Check** con reCAPTCHA para que solo tu web pueda llamar a las funciones.
- **Custom claims** en vez de leer el rol de Firestore (ahorra una lectura por llamada).
- Límite de frecuencia por usuario (p. ej. máx. 10 comandos/minuto) dentro de `ejecutarComando`.
- Pantalla de administración para gestionar usuarios sin entrar a la consola de Firebase.
