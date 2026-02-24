import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import { PORT } from './config.js';
import botRoutes from './routes/bot.routes.js';
import authRoutes from './routes/auth.routes.js';
import chatRoutes from './routes/chat.routes.js';

const app = express();

app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/bot', botRoutes);

app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
  console.log(`Endpoint del bot: http://localhost:${PORT}/api/bot/webhook`);
});