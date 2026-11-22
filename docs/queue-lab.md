# Laboratorio local de cola

Desde la raíz, con Node.js 24.12 o posterior de la rama 24 y las dependencias instaladas (`npm ci`):

```sh
node scripts/queue-lab.mjs
```

Abre **http://127.0.0.1:3115**. Si el puerto está ocupado, pasa otro como argumento (`node scripts/queue-lab.mjs 3116`). Para cerrar, pulsa `Ctrl+C`.

1. Los dos cargadores están **ocupados**. Alex ya espera en posición 1. Pulsa **Entrar en cola · Tipo 2**: quedas en posición 2.
2. Pulsa **Liberar Cargador A** (Tipo 2). Alex recibe la oferta y tú sigues en espera. Pulsa **Liberar Cargador B** (CCS2). Sam, que solo sigue la zona, recibe un aviso de disponibilidad, no un turno. La banda de estado muestra cada mensaje nuevo, y la actividad queda visible en la tarjeta de su destinatario.
3. Para probar el vencimiento, pulsa **Vencer oferta** en la tarjeta de Alex. El reloj salta al plazo y el servicio ofrece A a la siguiente persona. También puedes **Rechazar oferta** para cederla sin esperar.
4. Para probar la liberación, acepta una oferta, pulsa **Declarar ocupación simulada** y después **Liberar plaza**. Si solo aceptas y pulsas **Vencer llegada**, la observación pasa a desconocida; marca la plaza libre de nuevo para confirmar disponibilidad.

El reloj no corre en tiempo real. **Reiniciar escenario** abre una base SQLite temporal nueva; al cerrar se elimina la base del laboratorio. El escenario se comparte entre las pestañas de ese proceso. Usa el `Service` real de A la caaarga!! con datos sintéticos, sin credenciales, ni catálogo de EVsare, ni push, ni órdenes de recarga. La interfaz y sus rutas solo existen en el servidor del laboratorio.

Pruebas: `node --test test/queue-lab.test.mjs`.
