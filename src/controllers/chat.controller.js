// src/controllers/chat.controller.js
import {
    getOrCreateSessionDB,
    sendMessageDB,
    getMessagesDB,
    getActiveSessionsDB,
    sendAdvisorMessageDB,
    checkActiveSessionDB,
    startFlowSessionDB,
    endSessionByAdvisorDB,
    getHistoryClientsDB,
    getClientMessagesDB,
    getClientProfileDB,
    getClientProfileByClientIdDB,
    enviarBienvenidaWeb,
    resolveClientPlan,
} from '../models/chat.model.js';

// ─────────────────────────────────────────────
// CLIENTE — obtener o crear sesión web
// ─────────────────────────────────────────────
export const getOrCreateSession = async (req, res) => {
    try {
        const { session, idCliente } = await getOrCreateSessionDB(req.user.id, req.user.nombre);

        if (session.is_new) {
            await enviarBienvenidaWeb(session.id_sesion);
        }

        return res.json({ sessionId: session.id_sesion, estado: session.estado, clienteId: idCliente });
    } catch (error) {
        console.error('[chat] getOrCreateSession:', error);
        res.status(500).json({ message: 'Error al obtener la sesión.' });
    }
};

// ─────────────────────────────────────────────
// CLIENTE — enviar mensaje
// ─────────────────────────────────────────────
export const sendMessage = async (req, res) => {
    try {
        const { sessionId, content } = req.body;
        if (!sessionId || !content?.trim()) {
            return res.status(400).json({ message: 'sessionId y content son requeridos.' });
        }

        await sendMessageDB(sessionId, content.trim());
        return res.status(201).json({ ok: true });
    } catch (error) {
        console.error('[chat] sendMessage:', error);
        res.status(500).json({ message: 'Error al enviar el mensaje.' });
    }
};

// ─────────────────────────────────────────────
// TODOS — obtener mensajes de una sesión
// ─────────────────────────────────────────────
export const getMessages = async (req, res) => {
    try {
        const messages = await getMessagesDB(req.params.sessionId);
        return res.json({ messages });
    } catch (error) {
        console.error('[chat] getMessages:', error);
        res.status(500).json({ message: 'Error al obtener mensajes.' });
    }
};

// ─────────────────────────────────────────────
// ASESOR — listar sesiones escaladas
// ─────────────────────────────────────────────
export const getActiveSessions = async (req, res) => {
    try {
        const sessions = await getActiveSessionsDB();
        return res.json({ sessions });
    } catch (error) {
        console.error('[chat] getActiveSessions:', error);
        res.status(500).json({ message: 'Error al obtener sesiones.' });
    }
};

// ─────────────────────────────────────────────
// ASESOR — enviar mensaje a cliente
// ─────────────────────────────────────────────
export const sendAdvisorMessage = async (req, res) => {
    try {
        const { sessionId, content } = req.body;
        if (!sessionId || !content?.trim()) {
            return res.status(400).json({ message: 'sessionId y content son requeridos.' });
        }

        await sendAdvisorMessageDB(sessionId, content.trim());
        return res.status(201).json({ ok: true });
    } catch (error) {
        console.error('[chat] sendAdvisorMessage:', error);
        res.status(500).json({ message: 'Error al enviar el mensaje.' });
    }
};

// ─────────────────────────────────────────────
// CLIENTE — comprobar si hay sesión activa
// ─────────────────────────────────────────────
export const checkActiveSession = async (req, res) => {
    try {
        const hasActive = await checkActiveSessionDB(req.user.id);
        return res.json({ hasActive });
    } catch (error) {
        console.error('[chat] checkActiveSession:', error);
        res.status(500).json({ message: 'Error al comprobar sesión.' });
    }
};

// ─────────────────────────────────────────────
// CLIENTE — iniciar flujo específico
// ─────────────────────────────────────────────
export const startFlowSession = async (req, res) => {
    try {
        const { flow } = req.body;
        if (!flow) return res.status(400).json({ message: 'Se requiere el código del flujo.' });

        const { nuevaSesion, id_cliente } = await startFlowSessionDB(req.user.id, req.user.nombre, flow);
        return res.json({ sessionId: nuevaSesion.id_sesion, estado: nuevaSesion.estado, clienteId: id_cliente });
    } catch (error) {
        console.error('[chat] startFlowSession:', error);
        res.status(500).json({ message: 'Error al iniciar el flujo.' });
    }
};

// ─────────────────────────────────────────────
// ASESOR — terminar sesión activa manualmente
// ─────────────────────────────────────────────
export const endSessionByAdvisor = async (req, res) => {
    try {
        await endSessionByAdvisorDB(req.params.sessionId);
        return res.json({ ok: true });
    } catch (error) {
        console.error('[chat] endSessionByAdvisor:', error);
        res.status(500).json({ message: 'Error al terminar la sesión.' });
    }
};

// ─────────────────────────────────────────────
// ASESOR — obtener historial de clientes
// ─────────────────────────────────────────────
export const getHistoryClients = async (req, res) => {
    try {
        const clients = await getHistoryClientsDB();
        return res.json({ clients });
    } catch (error) {
        console.error('[chat] getHistoryClients:', error);
        res.status(500).json({ message: 'Error al obtener el historial de clientes.' });
    }
};

// ─────────────────────────────────────────────
// ASESOR — obtener mensajes de un cliente
// ─────────────────────────────────────────────
export const getClientMessages = async (req, res) => {
    try {
        const messages = await getClientMessagesDB(req.params.clientId);
        return res.json({ messages });
    } catch (error) {
        console.error('[chat] getClientMessages:', error);
        res.status(500).json({ message: 'Error al obtener mensajes del cliente.' });
    }
};

// ─────────────────────────────────────────────
// ASESOR — perfil completo del cliente de una sesión
// ─────────────────────────────────────────────
export const getClientProfile = async (req, res) => {
    try {
        const row = await getClientProfileDB(req.params.sessionId);
        if (!row) return res.status(404).json({ message: 'Sesión no encontrada.' });

        const plan = await resolveClientPlan(row.id_cliente);
        return res.json({ profile: { ...row, plan } });
    } catch (error) {
        console.error('[chat] getClientProfile:', error);
        res.status(500).json({ message: 'Error al obtener el perfil del cliente.' });
    }
};

// ─────────────────────────────────────────────
// ASESOR — perfil por id_cliente (historial de Bots)
// ─────────────────────────────────────────────
export const getClientProfileByClientId = async (req, res) => {
    try {
        const row = await getClientProfileByClientIdDB(req.params.clientId);
        if (!row) return res.status(404).json({ message: 'Cliente no encontrado.' });

        const plan = await resolveClientPlan(row.id_cliente);
        return res.json({ profile: { ...row, plan } });
    } catch (error) {
        console.error('[chat] getClientProfileByClientId:', error);
        res.status(500).json({ message: 'Error al obtener el perfil del cliente.' });
    }
};
