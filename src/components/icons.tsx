// Lucide icons for things the data names by key (award types, leader categories). Inline UI icons are imported
// straight from lucide-react where they're used.
import { ArrowRightLeft, Flame, Footprints, Goal, Hand, Handshake, Medal, ShieldCheck, Star, Target, Trophy, type LucideIcon } from 'lucide-react';

export type { LucideIcon };

export const AWARD_ICONS: Record<string, LucideIcon> = {
  champion: Trophy, golden_boot: Footprints, playmaker: Target, golden_glove: Hand, mvp: Star, custom: Medal,
};

export function AwardIcon({ type, size = 14 }: { type?: string; size?: number }) {
  const I = (type && AWARD_ICONS[type]) || Medal;
  return <I size={size} aria-hidden />;
}

export const LEADER_ICONS: Record<string, LucideIcon> = {
  goals: Goal, assists: Handshake, saves: Hand, mvps: Star, interceptions: ShieldCheck, passes: ArrowRightLeft, contributions: Flame,
};

export function LeaderIcon({ category, size = 18 }: { category?: string; size?: number }) {
  const I = (category && LEADER_ICONS[category]) || Star;
  return <I size={size} aria-hidden />;
}
