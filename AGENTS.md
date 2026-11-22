# A la caaarga!!

- Lee `README.md` y `docs/api.md` antes de cambiar los flujos o la API.
- Usa Node.js 24.12 o posterior dentro de la rama 24, `npm ci` y `npm test`. El frontend vive en `public/` y no tiene compilación.
- Si modificas el HTML, CSS, JS o iconos que cachea la PWA, incrementa la versión del shell en `public/sw.js`.
- Mantén separados favoritos, avisos, cola comunitaria y operaciones del cargador. No hagas pruebas de carga, reserva o cobro contra servicios reales. Usa dobles y datos sintéticos.
- No subas credenciales, tokens, bases de datos, ubicaciones privadas, APK ni detalles de infraestructura. Usa cuentas autorizadas y guarda los secretos fuera del repositorio y de `public/`.
