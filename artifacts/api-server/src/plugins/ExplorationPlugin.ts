import type { Bot } from "mineflayer";
import { goals } from "../utils/pathfinder.js";
import type { MinecraftBot } from "../bot/MinecraftBot.js";
import { StructureRepo, WaypointRepo } from "../database/Database.js";
import { sleep } from "../utils/helpers.js";
import { randomUUID } from "node:crypto";

const { GoalNear } = goals;

const STRUCTURE_BLOCKS: Record<string, string[]> = {
  village:      ["bell", "villager_head"],
  temple:       ["sandstone_stairs", "chiseled_sandstone"],
  stronghold:   ["end_portal_frame", "iron_bars"],
  mansion:      ["dark_oak_log", "dark_oak_planks"],
  monument:     ["prismarine", "sea_lantern"],
  mineshaft:    ["chain", "minecart_with_chest", "oak_fence"],
  ancient_city: ["sculk_catalyst", "sculk_shrieker", "sculk_sensor"],
};

export class ExplorationPlugin {
  private bot: Bot;
  private mcBot: MinecraftBot;
  private cancelled = false;

  constructor(bot: Bot, mcBot: MinecraftBot) {
    this.bot = bot;
    this.mcBot = mcBot;
  }

  async goTo(x: number, y: number, z: number): Promise<void> {
    this.mcBot.log(`Navigating to ${Math.round(x)} ${Math.round(y)} ${Math.round(z)}...`);
    try {
      await this.bot.pathfinder.goto(new GoalNear(x, y, z, 2));
      this.mcBot.log(`Arrived at ${Math.round(x)} ${Math.round(y)} ${Math.round(z)}`);
    } catch (err) {
      this.mcBot.log(`Navigation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async findStructure(structureName: string): Promise<void> {
    this.cancelled = false;
    const name = structureName.toLowerCase();
    this.mcBot.log(`Searching for ${name}...`);

    let searchRadius = 64;
    let found = false;

    while (!found && !this.cancelled && searchRadius <= 512) {
      found = await this.scanForStructure(name, searchRadius);
      if (!found) {
        await this.moveAndScan(searchRadius);
        searchRadius *= 2;
      }
    }

    if (!found) this.mcBot.log(`Could not find ${name} within search area`);
  }

  private async scanForStructure(name: string, radius: number): Promise<boolean> {
    const indicators = STRUCTURE_BLOCKS[name] || [];
    if (!indicators.length) {
      this.mcBot.log(`No structure signature for ${name}, exploring randomly`);
      return false;
    }

    for (const blockName of indicators) {
      const block = this.bot.findBlock({
        matching: (b) => b.name === blockName,
        maxDistance: radius,
      });

      if (block) {
        const pos = block.position;
        this.mcBot.log(`Found ${name} at ${Math.round(pos.x)} ${Math.round(pos.y)} ${Math.round(pos.z)}!`);

        StructureRepo.create({
          id: randomUUID(),
          bot_id: this.mcBot.id,
          type: name,
          x: pos.x,
          y: pos.y,
          z: pos.z,
        });

        WaypointRepo.create({
          id: randomUUID(),
          bot_id: this.mcBot.id,
          name: `${name}_${Date.now()}`,
          x: pos.x,
          y: pos.y,
          z: pos.z,
          description: `Auto-discovered ${name}`,
        });

        await this.goTo(pos.x, pos.y, pos.z);
        return true;
      }
    }
    return false;
  }

  private async moveAndScan(radius: number) {
    const pos = this.bot.entity?.position;
    if (!pos) return;
    const angle = Math.random() * Math.PI * 2;
    const tx = pos.x + Math.cos(angle) * radius * 0.5;
    const tz = pos.z + Math.sin(angle) * radius * 0.5;
    try {
      await this.bot.pathfinder.goto(new GoalNear(tx, pos.y, tz, 10));
    } catch {}
    await sleep(2000);
  }

  getBiome(): string {
    const pos = this.bot.entity?.position;
    if (!pos || !this.bot.world) return "unknown";
    try {
      const biome = this.bot.world.getBiome(this.bot.vec3(pos.x, pos.y, pos.z));
      return String(biome ?? "unknown");
    } catch {
      return "unknown";
    }
  }

  cancel() { this.cancelled = true; }
}
