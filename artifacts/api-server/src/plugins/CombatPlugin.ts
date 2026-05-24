import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { goals } from "../utils/pathfinder.js";
import type { MinecraftBot } from "../bot/MinecraftBot.js";
import { sleep } from "../utils/helpers.js";

const { GoalNear, GoalFollow } = goals;

const HOSTILE_MOBS = new Set([
  "zombie", "skeleton", "creeper", "spider", "cave_spider", "enderman",
  "witch", "blaze", "ghast", "phantom", "drowned", "husk", "stray",
  "pillager", "ravager", "vindicator", "evoker", "vex", "warden",
  "wither_skeleton", "hoglin", "piglin_brute", "zoglin",
]);

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

  async fightNearestMob(mobType?: string): Promise<void> {
    this.cancelled = false;
    this.mcBot.log(`Searching for ${mobType || "hostile mob"}...`);

    while (!this.cancelled) {
      const target = this.findTarget(mobType);
      if (!target) {
        this.mcBot.log("No targets found, waiting...");
        await sleep(2000);
        continue;
      }

      await this.attackEntity(target);
      await sleep(500);
    }
  }

  private findTarget(mobType?: string): Entity | null {
    const entities = Object.values(this.bot.entities);
    const candidates = entities.filter(e => {
      if (e === this.bot.entity) return false;
      if (e.type !== "mob") return false;
      const name = e.name?.toLowerCase() || "";
      if (mobType) return name === mobType.toLowerCase() || name.includes(mobType.toLowerCase());
      return HOSTILE_MOBS.has(name);
    });

    if (!candidates.length) return null;

    const pos = this.bot.entity?.position;
    if (!pos) return candidates[0] || null;

    return candidates.sort((a, b) => {
      const da = a.position.distanceTo(pos);
      const db = b.position.distanceTo(pos);
      return da - db;
    })[0] || null;
  }

  private async attackEntity(target: Entity): Promise<void> {
    if (!target.isValid) return;

    try {
      await this.bot.pathfinder.goto(new GoalNear(
        target.position.x, target.position.y, target.position.z, 2
      ));

      await this.equipBestWeapon();

      while (target.isValid && !this.cancelled) {
        if (this.bot.health <= 6) {
          this.mcBot.log("Health low, fleeing...");
          await this.flee();
          return;
        }

        const dist = this.bot.entity?.position?.distanceTo(target.position) ?? 99;
        if (dist > 4) break;

        await this.bot.attack(target);
        await sleep(600);
      }

      if (!target.isValid) {
        this.mcBot.log(`Defeated ${target.name || "mob"}!`);
      }
    } catch (err) {
      this.mcBot.log(`Combat error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async flee(): Promise<void> {
    const pos = this.bot.entity?.position;
    if (!pos) return;
    const fleeX = pos.x + (Math.random() > 0.5 ? 20 : -20);
    const fleeZ = pos.z + (Math.random() > 0.5 ? 20 : -20);
    try {
      await this.bot.pathfinder.goto(new GoalNear(fleeX, pos.y, fleeZ, 5));
    } catch {}
  }

  async followPlayer(username: string): Promise<void> {
    this.cancelled = false;
    this.followTarget = username;
    this.mcBot.log(`Following ${username}...`);

    while (!this.cancelled && this.followTarget === username) {
      const player = this.bot.players[username];
      if (!player?.entity) {
        this.mcBot.log(`Can't see ${username}`);
        await sleep(2000);
        continue;
      }

      try {
        await this.bot.pathfinder.goto(new GoalFollow(player.entity, 2));
      } catch {}

      await sleep(500);
    }
  }

  async defend(playerName?: string): Promise<void> {
    this.cancelled = false;
    this.defending = true;
    this.mcBot.log(`Defending ${playerName || "self"}...`);

    while (this.defending && !this.cancelled) {
      const target = this.findTarget();
      if (target) await this.attackEntity(target);
      await sleep(1000);
    }
  }

  private async equipBestWeapon() {
    const weapons = ["netherite_sword", "diamond_sword", "iron_sword", "stone_sword", "wooden_sword", "axe"];
    for (const name of weapons) {
      const item = this.bot.inventory.findInventoryItem(
        this.bot.registry.itemsByName[name]?.id ?? -1, null
      );
      if (item) {
        await this.bot.equip(item, "hand");
        return;
      }
    }
  }

  cancel() {
    this.cancelled = true;
    this.defending = false;
    this.followTarget = null;
  }
}
