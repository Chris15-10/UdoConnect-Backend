// src/routes/chat.routes.js
import { Router } from 'express';
import { verifyToken, requireRole } from '../middlewares/auth.middleware.js';
getOrCreateSession,
    sendMessage,
    getMessages,
    getActiveSessions,
    sendAdvisorMessage,
    checkActiveSession,
    startFlowSession,
    endSessionByAdvisor
} from '../controllers/chat.controller.js';

const router = Router();

// Todas las rutas de chat requieren autenticación
router.use(verifyToken);

// ── Rutas de CLIENTE (cualquier rol autenticado) ──
router.post('/session', getOrCreateSession);
router.get('/session/check', checkActiveSession);
router.post('/session/flow', startFlowSession);
router.post('/message', sendMessage);
router.get('/messages/:sessionId', getMessages);

// ── Rutas de ASESOR / ADMIN ──
router.get('/sessions', requireRole('asesor', 'admin'), getActiveSessions);
router.post('/advisor-message', requireRole('asesor', 'admin'), sendAdvisorMessage);
router.post('/session/:sessionId/end', requireRole('asesor', 'admin'), endSessionByAdvisor);

export default router;
