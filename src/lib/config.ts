// Brand + integration constants (spec §1, §5). Override via .env.local.
import { CalendarDays, ChartLine, House, ListOrdered, Medal, ScrollText, Shield, Trophy, User, type LucideIcon } from 'lucide-react';
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

export interface NavItem { route: string; label: string; icon: LucideIcon; audience?: 'signedIn' | 'admin' }
export const NAV: NavItem[] = [
  { route: 'home', label: 'Home', icon: House },
  { route: 'table', label: 'Table', icon: ListOrdered },
  { route: 'teams', label: 'Teams', icon: Shield },
  { route: 'players', label: 'Players', icon: User },
  { route: 'fixtures', label: 'Fixtures', icon: CalendarDays },
  { route: 'stats', label: 'Statistics', icon: ChartLine },
  { route: 'cups', label: 'Cups', icon: Trophy },
  { route: 'awards', label: 'Awards', icon: Medal },
  { route: 'rules', label: 'Rules', icon: ScrollText },
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
