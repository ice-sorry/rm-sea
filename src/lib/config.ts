// Brand + integration constants (spec §1, §5). Override via .env.local.
const env = import.meta.env;

export const BRAND = {
  appName: 'SEA Rematch League',
  short: 'SRL',
  tagline: 'Live standings, stats & fixtures',
  game: 'REMATCH',
  region: 'Southeast Asia',
  logo: '/icons/logo.png',
};
export const SOCIALS = {
  discord: env.VITE_DISCORD_INVITE || 'https://discord.gg/PmDC2zECZj',
  youtube: env.VITE_YOUTUBE_URL || '',
};
export const DISCORD_CLIENT_ID = env.VITE_DISCORD_CLIENT_ID || '1569644221718331412';

export interface NavItem { route: string; label: string; emoji: string; audience?: 'signedIn' | 'admin' }
export const NAV: NavItem[] = [
  { route: 'home', label: 'Home', emoji: '🏠' },
  { route: 'table', label: 'Table', emoji: '📊' },
  { route: 'teams', label: 'Teams', emoji: '🛡️' },
  { route: 'players', label: 'Players', emoji: '👤' },
  { route: 'fixtures', label: 'Fixtures', emoji: '🗓️' },
  { route: 'stats', label: 'Statistics', emoji: '📈' },
  { route: 'cups', label: 'Cups', emoji: '🏆' },
  { route: 'awards', label: 'Awards', emoji: '🏅' },
];

/** Feature switches. Flip to true to bring a feature back. */
export const FEATURES = {
  /** "Live" badge on fixtures whose kickoff was within the last 90 minutes. */
  liveBadge: false,
  /** Predict tab on the league table (score picks + predicted table). */
  predictions: false,
  /** Copy as PNG / Download PNG buttons on the standings and schedule cards. */
  imageExport: false,
};
