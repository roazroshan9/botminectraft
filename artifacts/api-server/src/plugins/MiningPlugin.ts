import type { Bot } from "mineflayer";
import { goals } from "../utils/pathfinder.js";
import type { MinecraftBot } from "../bot/MinecraftBot.js";
import { ORE_TYPES } from "../config/defaults.js";
import { sleep } from "../utils/helpers.js";

const { GoalNear, GoalBlock } = goals;

export class MiningPlugin {
  private bot: Bot;
  private mcBot: MinecraftBot;
  private cancelled = false;

  constructor(bot: Bot, mcBot: MinecraftBot) {
    this.bot = bot;
    this.mcBot = mcBot;
  }

  async mine(oreName: string, quantity: number): Promise<void> {
    this.cancelled = false;
    const oreInfo = ORE_TYPES[oreName.toLowerCase()];
    const blockName = oreInfo?.block || `${oreName}_ore`;

    this.mcBot.log(`Starting to mine ${quantity} ${oreName}...`);
    let mined = 0;

    while (mined < quantity && !this.cancelled) {
      const block = this.findNearestOre(blockName);
      if (!block) {
        this.mcBot.log(`No ${oreName} found nearby, searching deeper...`);
        await this.exploreForOres(oreInfo?.maxY ?? 16);
        await sleep(1000);
        continue;
      }

      try {
        await this.navigateAndMine(block);
        mined++;
        this.mcBot.log(`Mined ${mined}/${quantity} ${oreName}`);
        this.mcBot.taskQueue.updateProgress(
          this.mcBot.taskQueue.getCurrent()?.id || "",
          Math.round((mined / quantity) * 100),
        );
        await this.manageTorches();
        await this.checkSafety();
      } catch (err) {
        this.mcBot.log(`Mining error: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(2000);
      }
    }

    this.mcBot.log(`Mining complete! Got ${mined}/${quantity} ${oreName}`);
  }

  async collectBlock(blockName: string, quantity: number): Promise<void> {
    this.cancelled = false;
    this.mcBot.log(`Collecting ${quantity} ${blockName}...`);
    let collected = 0;

    while (collected < quantity && !this.cancelled) {
      const block = this.bot.findBlock({
        matching: (b) => b.name === blockName || b.name.includes(blockName),
        maxDistance: 64,
      });

      if (!block) {
        this.mcBot.log(`No ${blockName} found within 64 blocks`);
        await sleep(3000);
        continue;
      }

      try {
        await this.navigateAndMine(block);
        collected++;
        await sleep(500);
      } catch (err) {
        this.mcBot.log(`Collect error: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(2000);
      }
    }

    this.mcBot.log(`Collected ${collected}/${quantity} ${blockName}`);
  }

  private findNearestOre(blockName: string) {
    const names = [blockName, `deepslate_${blockName}`];
    return this.bot.findBlock({
      matching: (b) => names.some(n => b.name === n),
      maxDistance: 64,
    });
  }

  private async navigateAndMine(block: { position: { x: number; y: number; z: number } }) {
    const { x, y, z } = block.position;
    await this.bot.pathfinder.goto(new GoalBlock(x, y, z));
    await sleep(200);
    const b = this.bot.blockAt(this.bot.vec3(x, y, z));
    if (b && await this.bot.canDigBlock(b)) {
      await this.bot.dig(b);
    }
  }

  private async exploreForOres(targetY: number): Promise<void> {
    const pos = this.bot.entity?.position;
    if (!pos) return;
    const targetZ = pos.z + (Math.random() > 0.5 ? 20 : -20);
    try {
      await this.bot.pathfinder.goto(new GoalNear(pos.x, targetY, targetZ, 5));
    } catch {}
  }

  private async manageTorches() {
    const pos = this.bot.entity?.position;
    if (!pos) return;
    const torch = this.bot.inventory.findInventoryItem(this.bot.registry.itemsByName["torch"]?.id ?? 50, null);
    if (!torch) return;

    const nearbyTorch = this.bot.findBlock({
      matching: (b) => b.name === "torch" || b.name === "wall_torch",
      maxDistance: 8,
    });

    if (!nearbyTorch) {
      try {
        const below = this.bot.blockAt(pos.offset(0, -1, 0));
        if (below && below.name !== "air") {
          await this.bot.equip(torch, "hand");
          await this.bot.placeBlock(below, this.bot.vec3(0, 1, 0));
        }
      } catch {}
    }
  }

  private async checkSafety() {
    const pos = this.bot.entity?.position;
    if (!pos) return;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const b = this.bot.blockAt(pos.offset(dx, -1, dz));
        if (b?.name === "lava" || b?.name === "lava_still") {
          this.mcBot.log("⚠ Lava detected nearby! Moving away...");
          try {
            await this.bot.pathfinder.goto(new GoalNear(pos.x, pos.y + 5, pos.z, 3));
          } catch {}
          return;
        }
      }
    }
  }

  cancel() { this.cancelled = true; }
}
