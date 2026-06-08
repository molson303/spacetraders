import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

export const config = {
  token: required('SPACETRADERS_TOKEN'),
  baseUrl: (process.env.SPACETRADERS_BASE_URL ?? 'https://api.spacetraders.io/v2').replace(/\/$/, ''),
  databasePath: process.env.DATABASE_PATH ?? 'data/state.db',
} as const;

export type Config = typeof config;
