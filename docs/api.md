---
type: specification
title: Contrato de A la caaarga!! (cliente EVsare con cola propia)
last_updated: 2026-11-21
---

# A la caaarga!! — contrato de implementación

PWA independiente, sin afiliación a EVsare. Node.js 24 LTS, SQLite local (WAL), HTTP nativo y `web-push`; frontend sin compilación ni CDN. Un proceso con worker de vencimientos y outbox. La autenticación es la de la cuenta EVsare del propio usuario, mediada por el servidor; la cola, las zonas seguidas y los avisos son de A la caaarga!!. No se reutilizan secretos del APK ni cuentas compartidas. No se crean datos ficticios en producción.

## Acceso: dos vías separadas

- **Cuenta EVsare** (`POST /api/login`): el servidor llama a `POST https://appkbs.ibilcloud.com/user/login2` con `{idUsuario,password,idsubop:1}` y los encabezados que exige el operador. La contraseña se reenvía tal cual (sin recortes ni hash local) y no se guarda. La identidad local se ancla solo a `provider='evsare'` + `userId` upstream, nunca al correo ni al nombre de usuario. Los roles de EVsare no conceden privilegios locales: toda cuenta externa es `user`.
- **Administración local** (`POST /api/admin/login`): usuario `[a-zA-Z0-9_-]{3,32}` y contraseña 12–128; solo funciona para cuentas con rol `admin` creadas por CLI. Un `username` externo no puede entrar por esta vía y una cuenta admin no puede reclamarse por EVsare.

`POST /api/register` responde **410** con `LOCAL_REGISTRATION_REMOVED`: no hay registro público en A la caaarga!!.

## Métricas privadas

Por defecto el exportador está deshabilitado. `METRICS_PORT` habilita un puerto separado y `METRICS_PEERS` exige una lista de IP de scrapers autorizados. Limita también el puerto en el firewall y no lo incluyas en el proxy público. `GET /metrics` solo existe en ese puerto y usa la IP del socket, no encabezados reenviados.

Las series `alacarga_*` contienen solo agregados: cargas HTTP de portada, resultados de login, acciones confirmadas, respuestas y latencia de API, y estado de la última sincronización del catálogo. No incluyen personas, IP, ubicaciones ni rutas individuales. Las cargas de portada no son visitantes únicos; los turnos no son recargas. Los contadores del proceso se reinician al arrancar; usa `increase()` para comparar periodos en Prometheus. La lectura de métricas no refresca el catálogo ni genera acciones.

## API JSON (mismo origen)

Fechas: milisegundos Unix; IDs: números. Errores: `{error: "mensaje", code: "CODE"}`. Cambios requieren `Content-Type: application/json`, `Origin` válido y, tras login, `X-CSRF-Token` recibido de sesión. Cookies HttpOnly, SameSite=Lax, Secure en HTTPS. Nunca guardar contraseña o sesión en localStorage.

- `GET /api/health`: `{ok:true}`; sin secretos.
- `GET /api/session`: `{user: null | {id,username,role,provider}, csrfToken: string|null}`. `provider` es `evsare` o `local`.
- `POST /api/login`: `{username,password}` con credenciales de EVsare → sesión como arriba con `provider:"evsare"`. `username` ≤254 caracteres (admite correo), contraseña ≤1024; sin `pattern` local ni longitud mínima propia. Credenciales rechazadas por el operador → `401 INVALID_CREDENTIALS`. Fallo del operador → `502 EVSARE_UNAVAILABLE`.
- `POST /api/admin/login`: `{username,password}` de administración local → sesión con `provider:"local"`. `403 INVALID_CREDENTIALS` para cuentas no admin.
- `GET /api/evsare/profile`: `{profile:{displayName,email,privacyAccepted,readAt}, integration:{status:"partial"}}`. Requiere sesión `evsare` y token vigente. Solo lectura.
- `GET /api/evsare/rfid-cards`: `{cards:[{label:"Tarjeta RFID",ending:"1234"}]}`. Por defecto solo entrega el sufijo de la referencia mostrada por Android. `POST /api/evsare/rfid-cards/reveal` acepta `{ending}` y, si identifica una única tarjeta devuelta por EVsare para esa sesión, entrega su número RFID (`number`), si EVsare lo proporciona. No entrega el ID interno usado para cargar. Requiere sesión y CSRF; la respuesta no se cachea. Ninguna lectura inicia una recarga.
- `reportedCost` en `/api/evsare/recharges` es el `importe` numérico que EVsare devuelve para una recarga finalizada. La interfaz lo presenta en euros según el criterio confirmado para este historial, sin aplicar conversiones de escala. La gráfica de tiempo usa el intervalo entre inicio y fin.
- `POST /api/evsare/start-charge` es una integración piloto, deshabilitada por defecto. Requiere `remoteCharge:true` en la configuración efectiva y `{zoneId,terminalId,connectorId}` de un conector físico expresamente habilitado. No se deduce el conector a partir de la plaza. El servidor resuelve la tarjeta y no reintenta la orden. No inicia, acepta ni libera un turno comunitario.
- `GET /api/evsare/start-charge/status` devuelve el resultado local de la última orden (`null`, `UNCONFIRMED`, `ACCEPTED` o `REJECTED`), no el estado en vivo del coche. Ningún registro anterior impide solicitar otra carga; el servidor solo evita tramitar solicitudes simultáneas para la misma cuenta o terminal y no reintenta órdenes automáticamente.
- `GET /api/evsare/start-charge/check` contrasta la última orden propia con el historial del terminal y, cuando procede, sus lecturas. `NOT_FOUND` no demuestra que la orden no se iniciara.
- `POST /api/evsare/start-charge/finish` acepta `{rechargeId}` solo para una recarga activa propia asociada a la orden. Envía una sola solicitud de fin al operador; `{submitted:true}` no confirma que la recarga haya terminado. Se vuelve a consultar con `check`. No consulta ni muestra tarifa previa.
- `GET /api/evsare/recharges/:id/curve` devuelve hasta 500 lecturas `{time,energyKwh}`. Primero verifica que el ID pertenece a las últimas 20 recargas propias de IBILSARE. No interpreta la curva como estado de batería o de plaza.
- Perfil, tarjetas enmascaradas, historial de consulta y curvas de recargas finalizadas se reutilizan en memoria durante hasta 12 minutos por sesión. La curva vuelve a comprobar la pertenencia en el historial de EVsare antes de reutilizar las lecturas. El refresco explícito de perfil, tarjetas o historial (`?fresh=1`) omite la copia. La revelación de la tarjeta y las comprobaciones para cargar no usan esta caché.
- `GET /api/evsare/recharges`: `{recharges:[{id,location,terminal,startedAt,finishedAt}], readAt, integration:{status:"partial"}}`. Consulta `GET /recargas` con `todosUsuarios=false` y como máximo 20 filas propias; sin kWh ni importes porque sus unidades no están verificadas y sin inferir carga activa a partir de una fecha de fin ausente.
- `POST /api/register`: **410** `LOCAL_REGISTRATION_REMOVED`.
- `POST /api/logout`: `{}` → `{ok:true}`. Destruye también el token cifrado de la sesión.
- `GET /api/config`: `{source:"manual", integrationStatus:"partial", authProvider:"evsare", mapStatus:"unavailable"|"private", offerSeconds:120, arrivalSeconds:600, staleSeconds:300, vapidPublicKey:string|null}`. `private` habilita el catálogo privado; no garantiza que su última lectura haya sido exitosa.
- `GET /api/evsare/chargers`: devuelve `observedAt` y `sites`, cada sitio con `id`, `zoneId`, datos de ubicación y sus terminales autorizados. Cada terminal incluye conectores y `parcels` con las etiquetas explícitas de EVsare. Las ubicaciones privadas no se publican en `/api/zones`.
- Con `zoneId` privado, las altas en `/api/subscriptions` y `/api/queue` comprueban el vínculo. La cola acepta `connector:"ANY"` y contabiliza cada terminal una sola vez. Una liberación local no cambia EVsare ni confirma disponibilidad por sí sola.
- `POST /api/evsare/favorites`: `{zoneId,enabled}` → `{ok:true}`. Guarda emplazamientos por cuenta, independientemente de los avisos y de la cola. `/api/me` devuelve `favorites`. La cola y los avisos son por emplazamiento, y solo consideran terminales autorizados para esa cuenta. Las parcelas no se asignan a conectores por orden.
- `GET /api/zones`: `{zones:[{id,name,description,latitude,longitude,radiusMeters,waitingCount,availableCount,resources:[{id,name,connector,powerKw,status,observedAt,source:"manual"}]}]}`. `status`: AVAILABLE, BUSY, RESERVED, RECHARGING, MAINTENANCE, UNKNOWN, STALE. `connector`: TYPE2, CCS2, CHADEMO, SCHUKO. Disponibilidad no significa ausencia de turno asignado; availableCount excluye recursos asignados.
- `GET /api/me`: `{queue:null|{id,zoneId,zoneName,state,position,connector,resourceId,resourceName,expiresAt,arrivalExpiresAt,expectedReleaseAt,reason}, subscriptions:[zoneId,...], pushEnabled:boolean, notifications:[{id,title,body,createdAt}]}`. Devuelve participación activa o última terminal para explicar vencimiento. `state`: WAITING/OFFERED/ACCEPTED/CHARGING/EXPIRED/CANCELLED/COMPLETED.
- `POST /api/queue`: `{zoneId,connector:"ANY"|connector,plannedMinutes?:integer|null}` → `{queue:...}`. Una participación activa por usuario. Orden FIFO por secuencia persistida, compatible con recurso. Duración opcional declarada 1–720 minutos; no inventar una duración si se omite. Persistir `plannedMinutes` y devolverlo en queue. Al pasar a CHARGING, puede derivarse la previsión `expectedReleaseAt` de esta duración si el usuario no indicó otra.
- `POST /api/queue/:id/accept`, `/leave`, `/complete`: `{}` → `{queue:...}`. Accept solo propietario con oferta vigente; repetición idempotente. Leave rechaza oferta o sale. Complete solo ACCEPTED, cierre conservador sin afirmar plaza libre. Un recurso consumido queda UNKNOWN hasta nueva observación manual.
- `POST /api/queue/:id/start`: `{expectedReleaseAt?:timestamp}` → `{queue:...}`. Propietario ACCEPTED confirma «Estoy cargando», pasa CHARGING, recurso RECHARGING con source community. Tiempo previsto opcional, no libera automáticamente.
- `POST /api/queue/:id/estimate`: `{expectedReleaseAt:timestamp|null}` → `{queue:...}`. Propietario CHARGING actualiza previsión; se muestra junto al recurso sin revelar identidad.
- `POST /api/queue/:id/release`: `{}` → `{queue:...}`. Solo propietario CHARGING confirma «He liberado la plaza»: COMPLETED, recurso AVAILABLE fresco source community, oferta al siguiente compatible en la misma transacción. Reintento idempotente NO vuelve a liberar un recurso ya ofrecido a otro.
- `POST /api/resources/:id/claim`: `{expectedReleaseAt?:timestamp}` → `{queue:...}`. «Ya estoy cargando aquí», para registrar ocupación preexistente al comenzar a usar la app. Solo si no hay propietario/oferta activa del recurso, usuario sin participación activa y nadie esperando/ofrecido/aceptado en la zona; de lo contrario debe respetar cola. No desplaza usuarios ni se puede reclamar mantenimiento/reservado. Crea CHARGING, fuente community.
- `POST /api/subscriptions`: `{zoneId,enabled:boolean}` → `{ok:true}`. Seguir una zona NO entra en cola. Push de suscripción informa de disponibilidad, nunca otorga turno.
- `POST /api/push/subscribe`: objeto PushSubscription completo → `{ok:true}`. Endpoints HTTPS de proveedores conocidos exclusivamente, no URL arbitraria/SSRF.
- `POST /api/push/unsubscribe`: `{endpoint}` → `{ok:true}`. Solo propia.
- `POST /api/push/test`: `{}` → `{ok:true}`; prueba al usuario actual.
- `POST /api/admin/zones`: `{name,description,latitude?,longitude?,radiusMeters?}` → `{zone:...}`.
- `POST /api/admin/resources`: `{zoneId,name,connector,powerKw}` → `{resource:...}`. Cada recurso es una unidad física independiente, de una sola zona; starts UNKNOWN.
- `POST /api/admin/resources/:id/status`: `{status}` → `{ok:true}`. Solo administrador; etiqueta manual visible. Tiempo de observación siempre del servidor.
- `POST /api/admin/resources/:id/charge-finished`: `{}` → `{ok:true}`. Señal manual confirmada por administrador, solo si existe propietario CHARGING. Persiste `chargeFinishedAt` y notifica push al propietario para retirar coche, una vez. No libera recurso ni cambia prioridad. Adaptador autorizado futuro reutilizará esta operación de dominio; no se presenta como telemetría automática.

## Invariantes

1. Cambios de cola + asignación + outbox en transacción BEGIN IMMEDIATE. Índices únicos parciales por usuario activo y por recurso ofrecido/aceptado.
2. Solo AVAILABLE reciente puede generar o aceptar oferta. Oferta 120s; vencimiento pasa al siguiente compatible si el dato sigue reciente. Nadie ausente se reencola automáticamente. Las fuentes son manual (administración) o community (declaración autenticada del ocupante), nunca EVsare vivo.
3. Worker independiente del navegador, recuperación tras reinicio y reevaluación antes de cada mutación. Aceptación concurrente no duplica turno. No hay bloqueos físicos ni reservas de operador.
4. ACCEPTED tiene 600s de llegada; al completar, salir o vencer una aceptación, marcar recurso UNKNOWN antes de liberar. No inferir carga ni volver a ofrecer una observación consumida.
5. Cambio a ocupado/desconocido/obsoleto invalida ofertas. El servidor no confía en temporizadores, IDs de usuario ni roles suministrados por cliente.
6. Outbox persistente con TTL de oferta y reintentos acotados; eliminar endpoints 404/410. No afirmar entrega por HTTP 201 del servicio push. No registrar endpoints, cuerpos sensibles, contraseñas o tokens.
   Los estados administrativos MAINTENANCE y RESERVED cancelan también un turno ACCEPTED previo. Ningún inicio, salida, cierre o vencimiento de ese turno puede quitar el bloqueo; requiere otra corrección administrativa.
7. Admin bootstrap mediante CLI con contraseña por stdin; no defaults, sin registro público. Hash scrypt con salt. Sesiones persistentes con tokens aleatorios hasheados, expiración, límite de solicitudes y cuerpos. Solo el acceso local administrativo usa usuario y contraseña propios; las cuentas EVsare nunca reciben rol local distinto de `user`.
8. UI española responsive y accesible: zonas, filtros, seguir vs cola, estado propio, aceptar/rechazar, cuenta, push explícito, administración. Polling pequeño, sin refrescar ni robar foco de formularios. Estado offline explícito, sin simular éxitos. Service worker no cachea API ni muestra disponibilidad vieja como real.

## Token EVsare, renovación y errores

- El token del operador se guarda cifrado con AES-256-GCM, con datos autenticados ligados a `token_hash` y `user_id`, en `evsare-token.key` (0600). Nunca se envía al navegador, ni aparece en logs, respuestas o DOM, ni se persiste en claro.
- Un `401` de una lectura con token vigente dispara una única renovación por sesión (`/user/renewtoken`); las solicitudes concurrentes comparten el mismo intento. Si la renovación falla o el operador responde `401/403`, se olvida el token y se devuelve `401 EVSARE_REAUTH_REQUIRED` sin tocar la cola, las zonas seguidas ni la sesión local.
- Si falta la clave privada y ya existen sesiones EVsare almacenadas, el arranque falla cerrado con `EVSARE_KEY_UNAVAILABLE`: la clave original debe restaurarse, no regenerarse sobre sesiones existentes.
- Códigos propios: `EVSARE_REAUTH_REQUIRED` (401), `EVSARE_TOKEN_REJECTED`, `EVSARE_FORBIDDEN`, `EVSARE_UNAVAILABLE` (502), `EVSARE_BAD_RESPONSE`, `EVSARE_ACTION_REQUIRED`, `INVALID_CREDENTIALS` (401/403), `LOCAL_REGISTRATION_REMOVED` (410). Los mensajes al cliente no repiten cuerpos ni detalles del operador.
- El adaptador mantiene una lista blanca de rutas y límites de tamaño, tiempo y número de lecturas. Cualquier ruta fuera de `/user/login2`, `/user/renewtoken`, `/user/datosusuario` y `/recargas*` se rechaza antes de salir.
- Sin credenciales del propietario no hay lectura real: el adaptador está probado contra un doble sintético. El mapa y la disponibilidad de cargadores no tienen fuente autorizada y no se muestran como datos.

## Caso real aportado por el usuario

La app sustituye un chat informal («voy», «me pongo en cola», «libero a las 10:15», «hay dos libres», «ya estoy cargando»). Debe mantener varias plazas independientes por zona y distinguir `ACCEPTED` («voy») de `CHARGING` («estoy cargando»). El usuario que ocupa una plaza puede anunciar hora estimada y declarar liberación. Una previsión nunca es una liberación ni telemetría. El propietario CHARGING no pierde automáticamente su plaza por el TTL de disponibilidad: la ocupación persiste hasta liberación explícita o corrección administrativa. No se infiere disponibilidad porque cierre la app.

## Aviso al terminar la carga

- El dueño CHARGING recibe push cuando llega `expectedReleaseAt`: «Hora prevista alcanzada. ¿Has terminado? Si ya has retirado el coche, confirma la liberación». Exactamente un evento outbox por participación+previsión, con reintentos acotados; reiniciar no duplica el evento.
- El fin confirmado se notifica con otro evento idempotente y `chargeFinishedAt` (en queue/recurso); el copy distingue señal manual de una futura integración. UI muestra «Carga finalizada; plaza pendiente de liberar».
- Ningún recordatorio ni señal de fin pone AVAILABLE: una batería llena puede seguir ocupando plaza. Solo liberación explícita/corrección admin cambia estado físico declarado.
- Al cancelar o liberar, los recordatorios pendientes dejan de enviarse. Un push tardío no puede aceptar ni liberar nada automáticamente.

## Posición y espera orientativa

En `queue` de `/api/me`, incluir `peopleAhead`, `estimatedTurnAt` (timestamp o null) y `estimateReason`. La posición y las personas delante representan la cola WAITING por orden de servidor de esa zona; la asignación efectiva también depende de compatibilidad, por lo que un conector distinto puede avanzar en paralelo.

La hora de oferta prevista se calcula exclusivamente de disponibilidades recientes, horas de liberación declaradas y duraciones opcionales de los turnos anteriores. Considerar plazas paralelas, tipos compatibles y ventanas de aceptación/llegada. No mezclar plazas, sumar todos los tiempos ciegamente ni presentar una cuenta atrás garantizada. Si falta información de una plaza o duración necesaria, devolver null o una estimación explícitamente basada solo en plazas con previsión. Una hora prevista ya pasada no convierte una plaza ocupada en libre.

Contrato del módulo puro (propiedad del orquestador): `estimateTurn({now,targetId,entries,resources,offerSeconds,arrivalSeconds,staleSeconds})`. `entries`: cola WAITING ordenable por id, `{id,connector,plannedMinutes}`. `resources`: `{id,connector,status,observedAt,active?:{state,expiresAt,arrivalExpiresAt,expectedReleaseAt,plannedMinutes}}`. Retorna `{peopleAhead,estimatedTurnAt,estimateReason,estimateBasis}`; `estimateBasis` es `declared` o `insufficient`. El backend mapea filas SQLite al contrato sin pasar identidades o secretos.

## Personalización visual y vehículo

Tema sistema/claro/oscuro, acento bosque/azul/grafito, densidad cómoda/compacta, tarjetas/lista y filtro de zonas seguidas. Preferencias en el dispositivo, con comportamiento seguro si localStorage no está disponible. Perfil opcional de alias/modelo/capacidad/conector, declarado por usuario; sin matrícula/VIN, secretos, SOC ficticio ni consultas automáticas al catálogo privado. Ajustes secundarios, diseño principal limpio y turno prominente. Reducir movimiento según preferencia del sistema; conservar contraste, foco visible y navegación por teclado en todas las variantes.
