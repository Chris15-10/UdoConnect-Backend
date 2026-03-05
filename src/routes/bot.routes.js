import { Router } from 'express';
import { handleTelegramWebhook } from '../controllers/bot.controller.js';

const router = Router();

// Ruta: POST /api/bot/webhook
router.post('/webhook', handleTelegramWebhook);

export default router;