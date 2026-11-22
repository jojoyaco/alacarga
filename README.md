---
type: guide
title: A la caaarga!!
last_updated: 2026-11-22
---

# A la caaarga!!

![Icono de Chiquito de la Calzada](public/icons/icon-192.png)

Cliente independiente para consultar tus cargadores y recargas de EVsare y gestionar favoritos, avisos y turnos comunitarios. Los turnos de A la caaarga!! no son reservas oficiales.

**Web:** [alacarga.jojoya.es](https://alacarga.jojoya.es).

**Seguir una zona no es ponerse en cola.** El flujo es: en cola → te toca → voy → estoy cargando → he liberado la plaza. Cada plaza tiene su propio turno; si alguien no acepta a tiempo, pasa al siguiente compatible.

## Límites importantes

- La app no está afiliada a EVsare. El catálogo privado requiere credenciales de lectura autorizadas, configuradas únicamente en el servidor. No se reutilizan credenciales del APK. Sin esa configuración, no se muestra el catálogo del operador.
- Usa exclusivamente tu propia cuenta y respeta las condiciones del proveedor. A la caaarga!! envía las credenciales a IBILcloud para autenticarte; no guarda la contraseña y conserva cifrado el token de sesión. No introduzcas credenciales de terceros ni obtenidas sin autorización.
- La disponibilidad de EVsare y los estados de las zonas comunitarias se presentan por separado. El inicio remoto es un piloto optativo, deshabilitado por defecto; no equivale a reservar una plaza.
- La hora prevista genera un recordatorio, no prueba que la batería esté cargada. Una señal de fin de carga tampoco significa que la plaza haya quedado libre.
- La cola coordina a sus usuarios; no bloquea físicamente el cargador ni realiza reservas o pagos al operador.
- Web Push depende de permisos, plataforma y conectividad. En iPhone/iPad, instala la PWA en inicio y activa los avisos con el botón correspondiente. El vencimiento siempre lo decide el servidor.

## Stack

Node.js 24 LTS, HTTP nativo, SQLite en WAL y `web-push`. HTML/CSS/JavaScript sin compilación. Un proceso del servidor mantiene las ofertas y una bandeja de salida persistente. El mapa utiliza teselas de OpenStreetMap al abrirlo.

## Arranque local

Con Node.js 24.12 o posterior, dentro de la rama 24:

```sh
npm ci
npm test
npm start
```

Abre `http://localhost:3000`. Las pruebas de cola sin EVsare están en el [laboratorio local](docs/queue-lab.md). Para configurar el catálogo, define `EVSARE_CATALOG_CREDENTIALS` con la ruta a un JSON privado y autorizado fuera de Git y de `public/`. Para una instancia propia, configura `APP_ORIGIN` y un `DATA_DIR` privado. Usa HTTPS fuera de localhost. No borres ni regeneres la clave de cifrado si conservas sesiones.

## Primer uso

1. Administración crea la zona y añade cada plaza física con su conector y potencia verificados. Los recursos comienzan en estado desconocido; no se precargan ejemplos en producción.
2. Cada conductor entra con **su propia cuenta de EVsare**. **Seguir ubicación** activa el seguimiento; **Ponerme a la cola** solicita turno. La duración prevista es opcional y ayuda a orientar a quienes esperan.
3. Cuando llegue una oferta, pulsa **Aceptar turno · Voy** antes de 120 segundos. Al ocupar la plaza, confirma **Ya estoy cargando** dentro del plazo de llegada de 10 minutos.
4. Comparte la hora prevista y, únicamente después de retirar el coche, pulsa **He liberado la plaza**. La hora prevista o el fin de carga no liberan por sí solos.
5. Instala la PWA y activa los avisos explícitamente. Usa **Probar aviso** y comprueba la recepción con la aplicación cerrada en tu teléfono; no basta con que el servidor acepte la solicitud.

Los ajustes permiten tema claro/oscuro/sistema, espaciado y perfil opcional de coche. El perfil del coche se guarda en el navegador; no se consulta el estado de su batería.

## Licencia

Que el código pueda consultarse públicamente no lo convierte en código abierto. El código propio está sujeto a la [licencia de uso privado](LICENSE). Los recursos de terceros conservan sus licencias: véase [avisos de terceros](THIRD_PARTY_NOTICES.md).

## Documentación

- [Contrato funcional y API](docs/api.md).
- [Laboratorio local con datos sintéticos](docs/queue-lab.md).
- [Guía para agentes](AGENTS.md).

No hay cuentas ni contraseñas predeterminadas. La cuenta administradora se crea exclusivamente mediante CLI privada.
