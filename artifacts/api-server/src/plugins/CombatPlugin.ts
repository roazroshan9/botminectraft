import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { goals } from "../utils/pathfinder.js";
import type { MinecraftBot } from "../bot/MinecraftBot.js";
import { sleep } from "../utils/helpers.js";

const { GoalNear, GoalFollow } = goals;

// Threat priority score — higher = neutralize first
const THREAT_PRIORITY: Record<string, number> = {
  creeper:        100,
  warden:          95,
  evoker:          90,
  ravager:         85,
  blaze:           80,
  ghast:           75,
  wither_skeleton: 70,
  skeleton:        65,
  pillager:        60,
  witch:           55,
  phantom:         50,
  zombie:          40,
  drowned:         38,
  husk:            35,
  spider:          30,
  cave_spider:     30,
  enderman:        20,
  hoglin:          25,
  piglin_brute:    45,
  zoglin:          40,
  stray:           35,
  vex:             50,
  vindicator:      65,
};

const HOSTILE_MOBS = new Set(Object.keys(THREAT_PRIORITY));

const WEAPONS = [
  "netherite_sword", "diamond_sword", "iron_sword",
  "stone_sword", "wooden_sword",
  "netherite_axe",   "diamond_axe",   "iron_axe",
];

const HEALING_POTIONS = [
  "potion_of_healing",   "splash_potion_of_healing",
  "potion_of_strength",  "splash_potion_of_strength",
];

export class CombatPlugin {
  private bot: Bot;
  private mcBot: MinecraftBot;
  private cancelled = false;
  private defending = false;
  private followTarget: string | null = null;

  constructor(bot: Bot, mcBot: MinecraftBot) {
    this.bot = bot;
    this.mcBot = mcBot;
  }

  // ─── Public: fight until cancelled ────────────────────────────────────────
  async fightNearestMob(mobType?: string): Promise<void> {
    this.cancelled = false;
    this.mcBot.log(`Combat mode: targeting ${mobType || "all hostile mobs"}...`);

    while (!this.cancelled) {
      const target = this.findPriorityTarget(mobType);
      if (!target) {
        this.mcBot.log("No targets in range, patrolling...");
        await sleep(2000);
        continue;
      }

      await this.engageTarget(target);
      await sleep(300);
    }
  }

  // ─── Public: defend self/player in loop ────────────────────────────────────
  async defend(playerName?: string): Promise<void> {
    this.cancelled = false;
    this.defending = true;
    this.mcBot.log(`Defending ${playerName || "self"}...`);

    while (this.defending && !this.cancelled) {
      const target = this.findPriorityTarget();
      if (target) await this.engageTarget(target);
      await sleep(800);
    }
  }

  // ─── Public: follow a player ───────────────────────────────────────────────
  async followPlayer(username: string): Promise<void> {
    this.cancelled = false;
    this.followTarget = username;
    this.mcBot.log(`Following ${username}...`);

    while (!this.cancelled && this.followTarget === username) {
      const player = this.bot.players[username];
      if (!player?.entity) {
        this.mcBot.log(`Cannot see ${username}, waiting...`);
        await sleep(2000);
        continue;
      }

      try {
        await this.bot.pathfinder.goto(new GoalFollow(player.entity, 2));
      } catch {}

      // Guard the followed player from nearby mobs
      const threat = this.findPriorityTarget();
      if (threat) {
        const dist = this.bot.entity?.position?.distanceTo(threat.position) ?? 99;
        if (dist < 10) {
          this.mcBot.log(`Defending ${username} from ${threat.name}!`);
          await this.engageTarget(threat);
        }
      }

      await sleep(400);
    }
  }

  // ─── Core: full engagement cycle ──────────────────────────────────────────
  private async engageTarget(target: Entity): Promise<void> {
    if (!target.isValid) return;

    try {
      // Equip best weapon and shield before approaching
      await this.equipBestWeapon();
      await this.equipShield();

      // Approach
      await this.bot.pathfinder.goto(new GoalNear(
        target.position.x, target.position.y, target.position.z, 2,
      ));

      while (target.isValid && !this.cancelled) {
        // Critical health — retreat and heal before re-engaging
        if (this.bot.health <= 6) {
          this.mcBot.log(`Health critical (${Math.round(this.bot.health)}). Retreating to heal...`);
          await this.flee();
          await this.tryHeal();
          return;
        }

        // Low health — use potion if available
        if (this.bot.health <= 12) {
          await this.tryUseHealingPotion();
        }

        const dist = this.bot.entity?.position?.distanceTo(target.position) ?? 99;
        if (dist > 5) {
          // Re-close distance
          try {
            await this.bot.pathfinder.goto(new GoalNear(
              target.position.x, target.position.y, target.position.z, 2,
            ));
          } catch { break; }
        }

        // Strafe slightly before attacking to avoid projectiles (vs skeletons/blazes)
        const name = target.name?.toLowerCase() ?? "";
        if (name === "skeleton" || name === "blaze" || name === "ghast") {
          await this.strafe();
        }

        await this.bot.attack(target);
        await sleep(550);
      }

      if (!target.isValid) {
        this.mcBot.log(`Defeated ${target.name || "mob"}!`);
        await this.collectDrops(target.position);
      }
    } catch (err) {
      this.mcBot.log(`Combat error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Flee: move 20 blocks away from threats ────────────────────────────────
  async flee(): Promise<void> {
    const pos = this.bot.entity?.position;
    if (!pos) return;
    this.mcBot.log("Fleeing...");
    const angle = Math.random() * Math.PI * 2;
    const fleeX = pos.x + Math.cos(angle) * 22;
    const fleeZ = pos.z + Math.sin(angle) * 22;
    try {
      await this.bot.pathfinder.goto(new GoalNear(fleeX, pos.y, fleeZ, 5));
    } catch {}
  }

  // ─── Heal: eat food or use potion ─────────────────────────────────────────
  private async tryHeal(): Promise<void> {
    if (this.bot.health >= 18) return;
    await this.tryUseHealingPotion();
    if (this.bot.food < 18) {
      await this.eatFood();
    }
    // Wait for regen
    const wait = Math.max(0, (20 - this.bot.health) * 500);
    this.mcBot.log(`Recovering... (${Math.round(this.bot.health)}/20 HP)`);
    await sleep(Math.min(wait, 6000));
  }

  private async tryUseHealingPotion(): Promise<void> {
    for (const name of HEALING_POTIONS) {
      const item = this.bot.inventory.findInventoryItem(
        this.bot.registry.itemsByName[name]?.id ?? -1, null, false,
      );
      if (item) {
        try {
          await this.bot.equip(item, "hand");
          await this.bot.consume();
          this.mcBot.log(`Used ${name}`);
          return;
        } catch {}
      }
    }
  }

  private async eatFood(): Promise<void> {
    const foods = [
      "golden_apple", "cooked_beef", "cooked_porkchop",
      "cooked_chicken", "bread", "cooked_salmon",
    ];
    for (const name of foods) {
      const item = this.bot.inventory.findInventoryItem(
        this.bot.registry.itemsByName[name]?.id ?? -1, null, false,
      );
      if (item) {
        try {
          await this.bot.equip(item, "hand");
          await this.bot.consume();
          return;
        } catch {}
      }
    }
  }

  // ─── Strafe: take 2 steps sideways to avoid ranged attacks ────────────────
  private async strafe(): Promise<void> {
    const pos = this.bot.entity?.position;
    if (!pos) return;
    const angle = this.bot.entity.yaw + Math.PI / 2 * (Math.random() > 0.5 ? 1 : -1);
    const sx = pos.x + Math.cos(angle) * 2;
    const sz = pos.z + Math.sin(angle) * 2;
    try {
      await this.bot.pathfinder.goto(new GoalNear(sx, pos.y, sz, 1));
    } catch {}
  }

  // ─── Collect drops near kill site ─────────────────────────────────────────
  private async collectDrops(killPos: { x: number; y: number; z: number }): Promise<void> {
    await sleep(800); // Give drops time to spawn
    const objects = Object.values(this.bot.entities).filter(e =>
      e.type === "object" &&
      e.position.distanceTo(this.bot.vec3(killPos.x, killPos.y, killPos.z)) < 8,
    );
    if (!objects.length) return;
    this.mcBot.log(`Collecting ${objects.length} drops...`);
    try {
      await this.bot.pathfinder.goto(new GoalNear(killPos.x, killPos.y, killPos.z, 1));
    } catch {}
  }

  // ─── Find highest-priority target in range ─────────────────────────────────
  private findPriorityTarget(mobType?: string): Entity | null {
    const entities = Object.values(this.bot.entities);
    const pos = this.bot.entity?.position;

    const candidates = entities.filter(e => {
      if (e === this.bot.entity) return false;
      if (e.type !== "mob") return false;
      const name = e.name?.toLowerCase() ?? "";
      if (!pos || e.position.distanceTo(pos) > 24) return false;
      if (mobType) return name === mobType.toLowerCase() || name.includes(mobType.toLowerCase());
      return HOSTILE_MOBS.has(name);
    });

    if (!candidates.length) return null;

    // Sort by threat priority descending, then distance ascending
    return candidates.sort((a, b) => {
      const pa = THREAT_PRIORITY[a.name?.toLowerCase() ?? ""] ?? 0;
      const pb = THREAT_PRIORITY[b.name?.toLowerCase() ?? ""] ?? 0;
      if (pb !== pa) return pb - pa;
      const da = pos ? a.position.distanceTo(pos) : 0;
      const db = pos ? b.position.distanceTo(pos) : 0;
      return da - db;
    })[0] ?? null;
  }

  // ─── Equip helpers ─────────────────────────────────────────────────────────
  private async equipBestWeapon(): Promise<void> {
    for (const name of WEAPONS) {
      const item = this.bot.inventory.findInventoryItem(
        this.bot.registry.itemsByName[name]?.id ?? -1, null, false,
      );
      if (item) {
        try { await this.bot.equip(item, "hand"); return; } catch {}
      }
    }
  }

  private async equipShield(): Promise<void> {
    const shield = this.bot.inventory.findInventoryItem(
      this.bot.registry.itemsByName["shield"]?.id ?? -1, null, false,
    );
    if (shield) {
      try { await this.bot.equip(shield, "off-hand"); } catch {}
    }
  }

  cancel() {
    this.cancelled = true;
    this.defending = false;
    this.followTarget = null;
  }
}
