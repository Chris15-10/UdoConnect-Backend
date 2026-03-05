import { TELEGRAM_TOKEN } from '../config.js';

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

export const enviarMensajeTelegram = async (chatId, texto) => {
  try {
    const payload = {
      chat_id: chatId,
      text: texto,
      parse_mode: 'Markdown'
    };

    const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('Error enviando mensaje a Telegram:', error);
    }
  } catch (error) {
    console.error('Fallo en la conexión con Telegram:', error);
  }
};