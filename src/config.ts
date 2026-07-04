import 'dotenv/config';

export const BASE_URL = 'https://quiz.ravenblack.net/blood.pl';
export const COOKIE_FILE = process.env.COOKIE_FILE ?? '.cookies.json';
export const METRICS_PORT = parseInt(process.env.METRICS_PORT ?? '8080', 10);
export const AP_SECS_PER_TICK = 900; // 1 AP per 15 minutes
export const MAP_SIZE = 200;

if (!process.env.VAMPIRE_NAME || !process.env.VAMPIRE_PASS) {
  throw new Error('VAMPIRE_NAME and VAMPIRE_PASS must be set in .env');
}

export const VAMPIRE_NAME = process.env.VAMPIRE_NAME;
export const VAMPIRE_PASS = process.env.VAMPIRE_PASS;
export const VAMPIRE_COOKIE_PQ = process.env.VAMPIRE_COOKIE_PQ;
export const VAMPIRE_COOKIE_IP = process.env.VAMPIRE_COOKIE_IP;
export const WAIT_FOR_FULL_AP = (process.env.WAIT_FOR_FULL_AP ?? 'true') === 'true';
export const SINGLE_RUN = (process.env.SINGLE_RUN ?? 'false') === 'true';
export const SWEEP_DELAY_MS = Math.max(3000, parseFloat(process.env.SWEEP_DELAY ?? '3') * 1000);
