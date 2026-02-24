import { config } from 'dotenv';
config();

export const PORT = process.env.PORT || 3000;
export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_KEY = process.env.SUPABASE_KEY; // Usa la service_role o anon key
export const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
export const JWT_SECRET = process.env.JWT_SECRET || 'cambia_esto_en_produccion';