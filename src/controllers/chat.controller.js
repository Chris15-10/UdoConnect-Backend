// src/controllers/chat.controller.js
import { db } from '../db.js';
import { BotModel } from '../models/bot.model.js';

// ─────────────────────────────────────────────────────────────────
// Helper interno: ejecuta la lógica del bot para sesiones web.
// Similar a bot.controller.js pero sin enviar a Telegram.
// Guarda la respuesta del bot como remitente = 'bot' en mensajes.
// ─────────────────────────────────────────────────────────────────
async function procesarRespuestaBot(idSesion, idCliente, mensajeUsuario) {
    // Obtener estado actual de la sesión
    const { rows: sesRows } = await db.execute(
        'SELECT ultimo_paso_bot, datos_temporales, estado FROM sesiones WHERE id_sesion = $1',
        [idSesion]
    );
    if (!sesRows.length) return;
    const sesion = sesRows[0];

    // No procesar si la sesión ya fue transferida o cerrada
    if (sesion.estado === 'derivada_humano' || sesion.estado === 'cerrada') return;

    const ultimoPaso = sesion.ultimo_paso_bot || 'inicio';
    let datosTemporales = typeof sesion.datos_temporales === 'string'
        ? JSON.parse(sesion.datos_temporales)
        : (sesion.datos_temporales || {});

    // Obtener el paso actual
    const { rows: pasoRows } = await db.execute(
        'SELECT opciones_botones, es_pregunta, siguiente_paso_default FROM bot_pasos WHERE codigo_paso = $1',
        [ultimoPaso]
    );
    if (!pasoRows.length) return;
    const paso = pasoRows[0];

    let opciones = [];
    try {
        opciones = typeof paso.opciones_botones === 'string'
            ? JSON.parse(paso.opciones_botones)
            : (paso.opciones_botones || []);
    } catch (e) { opciones = []; }

    let siguientePasoCodigo = paso.siguiente_paso_default;

    if (paso.es_pregunta) {
        // Paso abierto — guardar la respuesta del usuario en datos temporales
        datosTemporales.ultimo_mensaje_abierto = mensajeUsuario;
        if (ultimoPaso === 'pedir_referencia') datosTemporales.referencia = mensajeUsuario;
        if (ultimoPaso === 'pedir_banco') datosTemporales.banco = mensajeUsuario;
        if (ultimoPaso === 'pedir_datos') datosTemporales.nombre_nuevo = mensajeUsuario;
        if (ultimoPaso === 'pedir_cedula_venta') datosTemporales.cedula = mensajeUsuario;
    } else {
        // Paso con opciones — buscar la opción elegida por el usuario
        const opcionElegida = opciones.find((op) => {
            if (op.regex) return new RegExp(op.regex, 'i').test(mensajeUsuario);
            return op.texto.toLowerCase() === mensajeUsuario.toLowerCase();
        });

        if (!opcionElegida) {
            // Opción no reconocida — enviar mensaje de error con las opciones disponibles
            let textoError = 'No entendi esa respuesta. Por favor, elige una opcion:\n\n';
            textoError += opciones.map(o => '- ' + o.texto).join('\n');
            await db.execute(
                "INSERT INTO mensajes (id_sesion, remitente, contenido) VALUES ($1, 'bot', $2)",
                [idSesion, textoError]
            );
            return;
        }

        siguientePasoCodigo = opcionElegida.valor;
        if (ultimoPaso === 'generar_factura_nueva' || ultimoPaso === 'reportar_pago') {
            datosTemporales.metodo_pago = opcionElegida.texto;
        }
    }

    // Obtener el siguiente paso
    const nuevoPaso = await BotModel.obtenerPasoPorCodigo(siguientePasoCodigo);
    let textoEnviar = nuevoPaso.mensaje_texto;
    let opcionesNuevoPaso = [];
    try {
        opcionesNuevoPaso = typeof nuevoPaso.opciones_botones === 'string'
            ? JSON.parse(nuevoPaso.opciones_botones)
            : (nuevoPaso.opciones_botones || []);
    } catch (e) { opcionesNuevoPaso = []; }

    // Ejecutar acciones del sistema
    if (nuevoPaso.accion_sistema) {
        switch (nuevoPaso.accion_sistema) {
            case 'crear_ticket':
                await BotModel.crearTicket(idCliente, mensajeUsuario, ultimoPaso);
                break;

            case 'consultar_deuda': {
                const deuda = await BotModel.consultarDeuda(idCliente);
                if (deuda.cantidadFacturas === 0) {
                    textoEnviar = 'Estas al dia! No tienes ninguna factura pendiente.\n\nEscribe Volver para ir al menu principal.';
                    opcionesNuevoPaso = [];
                } else {
                    textoEnviar = 'ESTADO DE CUENTA\n\nActualmente tienes ' + deuda.cantidadFacturas + ' factura(s) pendiente(s):\n\n' + deuda.detalleFacturas + '\n\nSUB-TOTAL A PAGAR: $' + deuda.deudaTotal + '\n\n¿Deseas reportar un pago para cancelar este saldo?';
                }
                break;
            }

            case 'verificar_pago_magico': {
                const verificacion = await BotModel.procesarPagoMagico(idCliente, datosTemporales);
                if (verificacion.exito) {
                    textoEnviar = 'Excelente! Hemos verificado tu transferencia por $' + verificacion.monto + '.\n\nTu factura ha sido pagada y tu servicio esta procesado. ¡Gracias por preferir Calibra-Net!';
                    opcionesNuevoPaso = [
                        { texto: '1. Volver al inicio', valor: 'inicio' },
                        { texto: '2. Cerrar chat', valor: 'despedida' },
                    ];
                } else {
                    textoEnviar = 'No encontramos un pago disponible con la referencia ' + (datosTemporales.referencia || '') + ', o ya fue procesada. Por favor verifica el numero e intenta de nuevo.';
                    siguientePasoCodigo = 'pedir_referencia';
                    opcionesNuevoPaso = [];
                }
                break;
            }

            case 'cerrar_sesion':
                await BotModel.cambiarEstadoSesion(idSesion, 'cerrada');
                break;

            case 'transferir_agente':
                await BotModel.cambiarEstadoSesion(idSesion, 'derivada_humano');
                textoEnviar = nuevoPaso.mensaje_texto + '\n\nUn asesor se conectara contigo en breve. Por favor espera...';
                opcionesNuevoPaso = [];
                break;
        }
    }

    // Agregar opciones al texto de respuesta
    if (opcionesNuevoPaso.length > 0) {
        textoEnviar += '\n\nResponde con una opcion:\n';
        textoEnviar += opcionesNuevoPaso.map(o => '- ' + o.texto).join('\n');
    }

    // Guardar respuesta del bot
    await db.execute(
        "INSERT INTO mensajes (id_sesion, remitente, contenido) VALUES ($1, 'bot', $2)",
        [idSesion, textoEnviar]
    );

    // Actualizar sesión
    await BotModel.actualizarSesion(idSesion, siguientePasoCodigo, datosTemporales);
}

// ─────────────────────────────────────────────
// Helper interno: enviar mensaje de bienvenida del bot ('inicio')
// al crear una sesión web nueva.
// ─────────────────────────────────────────────
async function enviarBienvenidaWeb(idSesion) {
    try {
        const pasoInicio = await BotModel.obtenerPasoPorCodigo('inicio');
        let texto = pasoInicio.mensaje_texto;
        let opciones = [];
        try {
            opciones = typeof pasoInicio.opciones_botones === 'string'
                ? JSON.parse(pasoInicio.opciones_botones)
                : (pasoInicio.opciones_botones || []);
        } catch (e) { opciones = []; }

        if (opciones.length > 0) {
            texto += '\n\nResponde con una opcion:\n';
            texto += opciones.map(o => '- ' + o.texto).join('\n');
        }

        await db.execute(
            "INSERT INTO mensajes (id_sesion, remitente, contenido) VALUES ($1, 'bot', $2)",
            [idSesion, texto]
        );
        await db.execute(
            "UPDATE sesiones SET ultimo_paso_bot = 'inicio' WHERE id_sesion = $1",
            [idSesion]
        );
    } catch (e) {
        console.error('[chat] enviarBienvenidaWeb:', e);
    }
}

// ─────────────────────────────────────────────
// CLIENTE — obtener o crear sesión web
// POST /api/chat/session
// ─────────────────────────────────────────────
export const getOrCreateSession = async (req, res) => {
    try {
        const userId = req.user.id;
        const extId = `web_${userId}`;

        // 1. Buscar o crear registro en `clientes`
        let { rows: clientRows } = await db.execute(
            'SELECT id_cliente, nombre FROM clientes WHERE identificador_externo = $1',
            [extId]
        );
        if (clientRows.length === 0) {
            await db.execute(
                'INSERT INTO clientes (identificador_externo, nombre) VALUES ($1, $2)',
                [extId, req.user.nombre]
            );
            const { rows } = await db.execute(
                'SELECT id_cliente, nombre FROM clientes WHERE identificador_externo = $1',
                [extId]
            );
            clientRows = rows;
        }
        const cliente = clientRows[0];

        // 2. Buscar sesión activa (no cerrada)
        const { rows: sesionRows } = await db.execute(
            `SELECT id_sesion, estado FROM sesiones
             WHERE id_cliente = $1 AND estado != 'cerrada' AND canal = 'web'
             ORDER BY fecha_inicio DESC LIMIT 1`,
            [cliente.id_cliente]
        );

        if (sesionRows.length > 0) {
            return res.json({ sessionId: sesionRows[0].id_sesion, estado: sesionRows[0].estado, clienteId: cliente.id_cliente });
        }

        // 3. Crear nueva sesión web
        await db.execute(
            `INSERT INTO sesiones (id_cliente, canal, estado, flujo_actual)
             VALUES ($1, 'web', 'activa_bot', 'principal')`,
            [cliente.id_cliente]
        );
        const { rows: nueva } = await db.execute(
            `SELECT id_sesion, estado FROM sesiones
             WHERE id_cliente = $1 AND canal = 'web' AND estado != 'cerrada'
             ORDER BY fecha_inicio DESC LIMIT 1`,
            [cliente.id_cliente]
        );

        const nuevaSesionId = nueva[0].id_sesion;

        // 4. Enviar mensaje de bienvenida del bot (solo en sesiones nuevas)
        await enviarBienvenidaWeb(nuevaSesionId);

        return res.json({ sessionId: nuevaSesionId, estado: nueva[0].estado, clienteId: cliente.id_cliente });

    } catch (error) {
        console.error('[chat] getOrCreateSession:', error);
        res.status(500).json({ message: 'Error al obtener la sesión.' });
    }
};

// ─────────────────────────────────────────────
// CLIENTE — enviar mensaje
// POST /api/chat/message
// Body: { sessionId, content }
// ─────────────────────────────────────────────
export const sendMessage = async (req, res) => {
    try {
        const { sessionId, content } = req.body;
        if (!sessionId || !content?.trim()) {
            return res.status(400).json({ message: 'sessionId y content son requeridos.' });
        }
        const texto = content.trim();

        // 1. Guardar mensaje del usuario
        await db.execute(
            "INSERT INTO mensajes (id_sesion, remitente, contenido) VALUES ($1, 'usuario', $2)",
            [sessionId, texto]
        );

        // 2. Obtener id_cliente de la sesión para pasarlo al bot
        const { rows: sesRows } = await db.execute(
            'SELECT id_cliente, estado FROM sesiones WHERE id_sesion = $1',
            [sessionId]
        );

        // 3. Si la sesión está activa con el bot, procesar respuesta del bot
        if (sesRows.length > 0 && sesRows[0].estado === 'activa_bot') {
            await procesarRespuestaBot(sessionId, sesRows[0].id_cliente, texto);
        }

        return res.status(201).json({ ok: true });

    } catch (error) {
        console.error('[chat] sendMessage:', error);
        res.status(500).json({ message: 'Error al enviar el mensaje.' });
    }
};

// ─────────────────────────────────────────────
// TODOS — obtener mensajes de una sesión
// GET /api/chat/messages/:sessionId
// ─────────────────────────────────────────────
export const getMessages = async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { rows } = await db.execute(
            `SELECT id_mensaje, remitente, contenido, fecha_creacion
             FROM mensajes
             WHERE id_sesion = $1
             ORDER BY fecha_creacion ASC`,
            [sessionId]
        );
        return res.json({ messages: rows });
    } catch (error) {
        console.error('[chat] getMessages:', error);
        res.status(500).json({ message: 'Error al obtener mensajes.' });
    }
};

// ─────────────────────────────────────────────
// ASESOR — listar sesiones escaladas
// GET /api/chat/sessions
// ─────────────────────────────────────────────
export const getActiveSessions = async (req, res) => {
    try {
        const { rows } = await db.execute(
            `SELECT
                s.id_sesion,
                s.estado,
                s.canal,
                s.fecha_inicio,
                c.nombre AS nombre_cliente,
                c.identificador_externo,
                (
                    SELECT contenido FROM mensajes m
                    WHERE m.id_sesion = s.id_sesion
                    ORDER BY m.fecha_creacion DESC LIMIT 1
                ) AS ultimo_mensaje,
                (
                    SELECT fecha_creacion FROM mensajes m
                    WHERE m.id_sesion = s.id_sesion
                    ORDER BY m.fecha_creacion DESC LIMIT 1
                ) AS ultima_actividad
             FROM sesiones s
             JOIN clientes c ON c.id_cliente = s.id_cliente
             WHERE s.estado = 'derivada_humano'
             ORDER BY ultima_actividad DESC NULLS LAST`,
            []
        );
        return res.json({ sessions: rows });
    } catch (error) {
        console.error('[chat] getActiveSessions:', error);
        res.status(500).json({ message: 'Error al obtener sesiones.' });
    }
};

// ─────────────────────────────────────────────
// ASESOR — enviar mensaje a cliente
// POST /api/chat/advisor-message
// Body: { sessionId, content }
// ─────────────────────────────────────────────
export const sendAdvisorMessage = async (req, res) => {
    try {
        const { sessionId, content } = req.body;
        if (!sessionId || !content?.trim()) {
            return res.status(400).json({ message: 'sessionId y content son requeridos.' });
        }

        await db.execute(
            "INSERT INTO mensajes (id_sesion, remitente, contenido) VALUES ($1, 'agente', $2)",
            [sessionId, content.trim()]
        );

        // Marcar sesión como derivada_humano si aún no lo está
        await db.execute(
            `UPDATE sesiones SET estado = 'derivada_humano'
             WHERE id_sesion = $1 AND estado != 'cerrada'`,
            [sessionId]
        );

        return res.status(201).json({ ok: true });

    } catch (error) {
        console.error('[chat] sendAdvisorMessage:', error);
        res.status(500).json({ message: 'Error al enviar el mensaje.' });
    }
};
