import { db } from "../db.js";

export class BotModel {
  static async obtenerContextoUsuario(telegramId, nombreUsuario) {
    try {
      let clienteReq = await db.execute(
        "SELECT id_cliente, nombre, identificador_externo FROM clientes WHERE identificador_externo = $1",
        [telegramId]
      );

      let cliente;
      if (clienteReq.rows.length === 0) {
        await db.execute(
          "INSERT INTO clientes (identificador_externo, nombre) VALUES ($1, $2)",
          [telegramId, nombreUsuario]
        );
        clienteReq = await db.execute(
          "SELECT id_cliente, nombre, identificador_externo FROM clientes WHERE identificador_externo = $1",
          [telegramId]
        );
      } else {
        await db.execute(
          "UPDATE clientes SET nombre = $1 WHERE identificador_externo = $2",
          [nombreUsuario, telegramId]
        );
      }
      cliente = clienteReq.rows[0];

      const sesionReq = await db.execute(
        "SELECT * FROM sesiones WHERE id_cliente = $1 AND estado != 'cerrada' ORDER BY fecha_inicio DESC LIMIT 1",
        [cliente.id_cliente]
      );

      if (sesionReq.rows.length === 0) {
        return { id_cliente: cliente.id_cliente, id_sesion: null };
      }
      const sesion = sesionReq.rows[0];

      const pasoReq = await db.execute(
        "SELECT opciones_botones, es_pregunta, siguiente_paso_default FROM bot_pasos WHERE codigo_paso = $1",
        [sesion.ultimo_paso_bot]
      );

      const pasoInfo = pasoReq.rows.length > 0 ? pasoReq.rows[0] : null;

      return {
        id_cliente: cliente.id_cliente,
        nombre: cliente.nombre,
        id_sesion: sesion.id_sesion,
        estado: sesion.estado,
        flujo_actual: sesion.flujo_actual,
        ultimo_paso_bot: sesion.ultimo_paso_bot,
        datos_temporales: typeof sesion.datos_temporales === 'string' ? JSON.parse(sesion.datos_temporales) : (sesion.datos_temporales || {}),
        opciones_botones: typeof pasoInfo?.opciones_botones === 'string' ? JSON.parse(pasoInfo.opciones_botones) : (pasoInfo?.opciones_botones || []),
        es_pregunta: pasoInfo?.es_pregunta || false,
        siguiente_paso_default: pasoInfo?.siguiente_paso_default || null
      };
    } catch (e) {
      console.error("ERROR REAL DE POSTGRES:", e);
      throw new Error("Error obteniendo contexto del usuario: " + e.message);
    }
  }

  static async crearSesion(idCliente) {
    try {
      await db.execute(
        "INSERT INTO sesiones (id_cliente, flujo_actual, ultimo_paso_bot, estado) VALUES ($1, 'principal', 'inicio', 'activa_bot')",
        [idCliente]
      );

      const sesionReq = await db.execute(
        "SELECT * FROM sesiones WHERE id_cliente = $1 ORDER BY fecha_inicio DESC LIMIT 1",
        [idCliente]
      );

      return sesionReq.rows[0];
    } catch (e) {
      throw new Error("Error creando la sesion: " + e.message);
    }
  }

  static async actualizarSesion(idSesion, siguientePaso, datosTemporales) {
    try {
      await db.execute(
        "UPDATE sesiones SET ultimo_paso_bot = $1, datos_temporales = $2 WHERE id_sesion = $3",
        [siguientePaso, JSON.stringify(datosTemporales), idSesion]
      );
    } catch (e) {
      throw new Error("Error actualizando la sesion: " + e.message);
    }
  }

  static async obtenerPasoPorCodigo(codigoPaso) {
    try {
      const paso = await db.execute(
        "SELECT * FROM bot_pasos WHERE codigo_paso = $1",
        [codigoPaso]
      );

      if (paso.rows.length === 0) {
        throw new Error("Paso no encontrado en la base de datos");
      }

      return paso.rows[0];
    } catch (e) {
      throw new Error("Error obteniendo paso: " + e.message);
    }
  }

  static async guardarMensajes(idSesion, mensajeUsuario, mensajeBot) {
    try {
      await db.execute(
        "INSERT INTO mensajes (id_sesion, remitente, contenido) VALUES ($1, 'usuario', $2)",
        [idSesion, mensajeUsuario]
      );
      await db.execute(
        "INSERT INTO mensajes (id_sesion, remitente, contenido) VALUES ($1, 'bot', $2)",
        [idSesion, mensajeBot]
      );
    } catch (e) {
      throw new Error("Error guardando mensajes en el historial: " + e.message);
    }
  }

  static async crearTicket(idCliente, mensajeUsuario, codigoPaso) {
    try {
      const descripcion = "Reporte automatico en paso: " + codigoPaso + ". Mensaje: " + mensajeUsuario;
      await db.execute(
        "INSERT INTO tickets (id_cliente, descripcion, prioridad) VALUES ($1, $2, 'alta')",
        [idCliente, descripcion]
      );
    } catch (e) {
      throw new Error("Error al crear el ticket de soporte: " + e.message);
    }
  }

  static async cambiarEstadoSesion(idSesion, nuevoEstado) {
    try {
      await db.execute(
        "UPDATE sesiones SET estado = $1 WHERE id_sesion = $2",
        [nuevoEstado, idSesion]
      );
    } catch (e) {
      throw new Error("Error cambiando estado de la sesion: " + e.message);
    }
  }

  static async consultarDeuda(idCliente) {
    try {
      const facturasReq = await db.execute(
        "SELECT monto, descripcion, fecha_vencimiento FROM facturas WHERE id_cliente = $1 AND estado IN ('pendiente', 'vencida') ORDER BY fecha_vencimiento ASC",
        [idCliente]
      );

      const facturas = facturasReq.rows;
      const cantidadFacturas = facturas.length;
      const deudaTotal = facturas.reduce((acc, fac) => acc + Number(fac.monto), 0);
      const detalleFacturas = facturas.map(f => "- " + f.descripcion + " -> $" + f.monto).join('\n');

      return { cantidadFacturas, deudaTotal, detalleFacturas };
    } catch (e) {
      throw new Error("Error al consultar la deuda: " + e.message);
    }
  }

  static async procesarPagoMagico(idCliente, datosTemporales) {
    try {
      const referencia = datosTemporales.referencia || '';

      const pagoReq = await db.execute(
        "SELECT id_pago, monto_pagado FROM pagos WHERE numero_referencia = $1 AND usado = false LIMIT 1",
        [referencia]
      );

      if (pagoReq.rows.length === 0) return { exito: false };

      const pago = pagoReq.rows[0];
      const montoPagado = Number(pago.monto_pagado);

      const facturasReq = await db.execute(
        "SELECT id_factura, monto FROM facturas WHERE id_cliente = $1 AND estado IN ('pendiente', 'vencida') ORDER BY fecha_vencimiento ASC",
        [idCliente]
      );

      if (facturasReq.rows.length > 0) {
        const deudaTotal = facturasReq.rows.reduce((acc, f) => acc + Number(f.monto), 0);

        if (montoPagado >= deudaTotal) {
          await db.execute(
            "UPDATE facturas SET estado = 'pagada' WHERE id_cliente = $1 AND estado IN ('pendiente', 'vencida')",
            [idCliente]
          );

          await db.execute(
            "UPDATE pagos SET usado = true, id_factura = $1 WHERE id_pago = $2",
            [facturasReq.rows[0].id_factura, pago.id_pago]
          );
          return { exito: true, monto: montoPagado };
        } else {
          return { exito: false };
        }
      } else {
        const fechaHoy = new Date();
        const fechaVencimiento = new Date(fechaHoy.setDate(fechaHoy.getDate() + 30)).toISOString().split('T')[0];

        await db.execute(
          "INSERT INTO facturas (id_cliente, descripcion, monto, estado, fecha_vencimiento) VALUES ($1, 'Instalacion y Primer Mes', $2, 'pagada', $3)",
          [idCliente, montoPagado, fechaVencimiento]
        );

        const nuevaFacturaReq = await db.execute("SELECT id_factura FROM facturas WHERE id_cliente = $1 ORDER BY id_factura DESC LIMIT 1", [idCliente]);

        await db.execute(
          "UPDATE pagos SET usado = true, id_factura = $1 WHERE id_pago = $2",
          [nuevaFacturaReq.rows[0].id_factura, pago.id_pago]
        );

        return { exito: true, monto: montoPagado };
      }
    } catch (e) {
      console.error("Error en procesarPagoMagico:", e);
      throw new Error("Error validando pago: " + e.message);
    }
  }
}