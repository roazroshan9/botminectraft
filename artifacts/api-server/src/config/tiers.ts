export const TIERS = {
  free: {
    name: "Free",
    price: 0,
    botSlots: 1,
    microsoftAuth: false,
    logHistory: 100,
    liveSupport: false,
    aiPlugins: ["mining", "farming"],
    badge: "🆓",
  },
  premium: {
    name: "Premium",
    price: 9.99,
    botSlots: 5,
    microsoftAuth: true,
    logHistory: 5000,
    liveSupport: true,
    aiPlugins: ["mining", "farming", "combat", "building", "exploration", "inventory"],
    badge: "⭐",
  },
  enterprise: {
    name: "Enterprise",
    price: 49.99,
    botSlots: 25,
    microsoftAuth: true,
    logHistory: -1,
    liveSupport: true,
    priority: true,
    aiPlugins: ["mining", "farming", "combat", "building", "exploration", "inventory"],
    badge: "🏢",
  },
} as const;

export type Tier = keyof typeof TIERS;

export function getTier(tier: string) {
  return TIERS[tier as Tier] ?? TIERS.free;
}
