import { BotModel } from '../models/bot.model.js';
import { enviarMensajeTelegram } from '../libs/telegram.js';

export const handleTelegramWebhook = async (req, res) => {
    try {
        const body = req.body;

        if (!body.message || !body.message.text) {
            return res.status(200).send('OK');
        }

        const telegramId = body.message.chat.id.toString();
        const nombreUsuario = body.message.from.first_name || 'Usuario';
        const mensajeUsuario = body.message.text.trim();

        let contexto = await BotModel.obtenerContextoUsuario(telegramId, nombreUsuario);

        if (!contexto.id_sesion) {
            const nuevaSesion = await BotModel.crearSesion(contexto.id_cliente);
            const pasoInicio = await BotModel.obtenerPasoPorCodigo('inicio');

            let textoBienvenida = pasoInicio.mensaje_texto;
            let opciones = [];
            try {
                opciones = typeof pasoInicio.opciones_botones === 'string'
                    ? JSON.parse(pasoInicio.opciones_botones)
                    : (pasoInicio.opciones_botones || []);
            } catch (e) { console.error("Error parseando opciones iniciales", e); }

            if (opciones.length > 0) {
                textoBienvenida += "\n\nPor favor, elige una opcion:\n";
                textoBienvenida += opciones.map(o => "- " + o.texto).join("\n");
            }

            await enviarMensajeTelegram(telegramId, textoBienvenida);
            await BotModel.guardarMensajes(nuevaSesion.id_sesion, mensajeUsuario, textoBienvenida);

            return res.status(200).send('OK');
        }

        let siguientePasoCodigo = contexto.siguiente_paso_default;
        let datosTemporales = contexto.datos_temporales || {};

        if (contexto.es_pregunta) {
            datosTemporales.ultimo_mensaje_abierto = mensajeUsuario;

            if (contexto.ultimo_paso_bot === 'pedir_referencia') {
                datosTemporales.referencia = mensajeUsuario;
            } else if (contexto.ultimo_paso_bot === 'pedir_banco') {
                datosTemporales.banco = mensajeUsuario;
            } else if (contexto.ultimo_paso_bot === 'pedir_datos') {
                datosTemporales.nombre_nuevo = mensajeUsuario;
            } else if (contexto.ultimo_paso_bot === 'pedir_cedula_venta') {
                datosTemporales.cedula = mensajeUsuario;
            }
            siguientePasoCodigo = contexto.siguiente_paso_default;
        } else {
            const opcionElegida = (contexto.opciones_botones || []).find((opcion) => {
                if (opcion.regex) {
                    const regex = new RegExp(opcion.regex, 'i');
                    return regex.test(mensajeUsuario);
                }
                return opcion.texto.toLowerCase() === mensajeUsuario.toLowerCase();
            });

            if (!opcionElegida) {
                let textoError = "Ups, no entendi esa respuesta.\n\nPor favor, intenta con una de estas opciones:\n";
                textoError += (contexto.opciones_botones || []).map(o => "- " + o.texto).join("\n");

                await enviarMensajeTelegram(telegramId, textoError);
                await BotModel.guardarMensajes(contexto.id_sesion, mensajeUsuario, textoError);
                return res.status(200).send('OK');
            }

            siguientePasoCodigo = opcionElegida.valor;

            if (contexto.ultimo_paso_bot === 'generar_factura_nueva' || contexto.ultimo_paso_bot === 'reportar_pago') {
                datosTemporales.metodo_pago = opcionElegida.texto;
            }
        }

        const nuevoPaso = await BotModel.obtenerPasoPorCodigo(siguientePasoCodigo);
        let textoEnviar = nuevoPaso.mensaje_texto;

        let opcionesNuevoPaso = [];
        try {
            opcionesNuevoPaso = typeof nuevoPaso.opciones_botones === 'string'
                ? JSON.parse(nuevoPaso.opciones_botones)
                : (nuevoPaso.opciones_botones || []);
        } catch (e) { console.error("Error parseando opciones del nuevo paso", e); }

        if (nuevoPaso.accion_sistema) {
            switch (nuevoPaso.accion_sistema) {
                case 'crear_ticket':
                    await BotModel.crearTicket(contexto.id_cliente, mensajeUsuario, contexto.ultimo_paso_bot);
                    break;

                case 'consultar_deuda':
                    const deuda = await BotModel.consultarDeuda(contexto.id_cliente);
                    if (deuda.cantidadFacturas === 0) {
                        textoEnviar = "Estas al dia! No tienes ninguna factura pendiente de pago en este momento.\n\nEscribe Volver para ir al menu principal.";
                        opcionesNuevoPaso = [];
                    } else {
                        textoEnviar = "ESTADO DE CUENTA\n\nActualmente tienes " + deuda.cantidadFacturas + " factura(s) pendiente(s):\n\n" + deuda.detalleFacturas + "\n\nSUB-TOTAL A PAGAR: $" + deuda.deudaTotal + "\n\n¿Deseas reportar un pago para cancelar este saldo?";
                    }
                    break;

                case 'verificar_pago_magico':
                    const verificacion = await BotModel.procesarPagoMagico(contexto.id_cliente, datosTemporales);
                    if (verificacion.exito) {
                        textoEnviar = "Excelente! Hemos verificado tu transferencia por $" + verificacion.monto + " con el banco.\n\nTu factura ha sido pagada y tu servicio esta procesado. Gracias por preferir UdoConnect!";
                        opcionesNuevoPaso = [
                            { texto: "1. Volver al inicio", valor: "inicio" },
                            { texto: "2. Cerrar chat", valor: "despedida" }
                        ];
                    } else {
                        textoEnviar = "No hemos podido encontrar un pago disponible con la referencia " + (datosTemporales.referencia || '') + " en nuestras cuentas, o es posible que ya haya sido procesada.\n\nPor favor, verifica el numero e intenta de nuevo.";
                        siguientePasoCodigo = 'pedir_referencia';
                        opcionesNuevoPaso = [];
                    }
                    break;

                case 'cerrar_sesion':
                    await BotModel.cambiarEstadoSesion(contexto.id_sesion, 'cerrada');
                    break;

                case 'transferir_agente':
                    // Escalar la sesión a un asesor humano
                    await BotModel.cambiarEstadoSesion(contexto.id_sesion, 'derivada_humano');
                    // Sobreescribir texto para que el bot no muestre opciones (el asesor toma el control)
                    textoEnviar = nuevoPaso.mensaje_texto + "\n\nUn asesor se conectara contigo en breve. Por favor espera...";
                    opcionesNuevoPaso = []; // Sin opciones — el asesor responde manualmente
                    break;
            }
        }

        if (opcionesNuevoPaso.length > 0) {
            textoEnviar += "\n\nResponde con una opcion:\n";
            textoEnviar += opcionesNuevoPaso.map(o => "- " + o.texto).join("\n");
        }

        await enviarMensajeTelegram(telegramId, textoEnviar);
        await BotModel.guardarMensajes(contexto.id_sesion, mensajeUsuario, textoEnviar);
        await BotModel.actualizarSesion(contexto.id_sesion, siguientePasoCodigo, datosTemporales);

        return res.status(200).send('OK');

    } catch (error) {
        console.error("Error critico en el controlador del bot:", error);
        return res.status(200).send('Error');
    }
};