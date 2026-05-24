import type { Bot } from "mineflayer";
import { goals } from "../utils/pathfinder.js";
import type { MinecraftBot } from "../bot/MinecraftBot.js";
import { CROP_TYPES } from "../config/defaults.js";
import { sleep } from "../utils/helpers.js";

const { GoalBlock } = goals;

export class FarmingPlugin {
  private bot: Bot;
  private mcBot: MinecraftBot;
  private cancelled = false;

  constructor(bot: Bot, mcBot: MinecraftBot) {
    this.bot = bot;
    this.mcBot = mcBot;
  }

  async farm(cropName: string): Promise<void> {
    this.cancelled = false;
    const cropInfo = CROP_TYPES[cropName.toLowerCase()];
    const blockName = cropName.toLowerCase() === "wheat" ? "wheat" : cropName.toLowerCase();

    this.mcBot.log(`Starting ${cropName} farming cycle...`);

    while (!this.cancelled) {
      const harvested = await this.harvestMature(blockName, cropInfo?.mature ?? 7);
      this.mcBot.log(`Harvested ${harvested} ${cropName}`);

      if (cropInfo) {
        await this.replantCrops(cropInfo.seed);
      }

      this.mcBot.log("Farming cycle complete. Waiting for crops to grow...");
      await sleep(30000);
    }
  }

  private async harvestMature(blockName: string, matureAge: number): Promise<number> {
    let count = 0;
    const blocks = this.findAllBlocks(blockName, 32);

    for (const block of blocks) {
      if (this.cancelled) break;
      const age = block.getProperties?.()?.["age"];
      if (age !== undefined && Number(age) < matureAge) continue;

      try {
        await this.bot.pathfinder.goto(new GoalBlock(block.position.x, block.position.y, block.position.z));
        await this.bot.dig(block);
        count++;
        await sleep(200);
      } catch {}
    }

    return count;
  }

  private async replantCrops(seedName: string) {
    const seed = this.bot.inventory.findInventoryItem(
      this.bot.registry.itemsByName[seedName]?.id ?? -1, null
    );
    if (!seed) {
      this.mcBot.log(`No ${seedName} to replant`);
      return;
    }

    const farmlands = this.findAllBlocks("farmland", 32).filter(b => {
      const above = this.bot.blockAt(b.position.offset(0, 1, 0));
      return above?.name === "air";
    });

    await this.bot.equip(seed, "hand");

    for (const farmland of farmlands.slice(0, 20)) {
      if (this.cancelled) break;
      try {
        await this.bot.pathfinder.goto(new GoalBlock(farmland.position.x, farmland.position.y + 1, farmland.position.z));
        await this.bot.placeBlock(farmland, this.bot.vec3(0, 1, 0));
        await sleep(200);
      } catch {}
    }
  }

  private findAllBlocks(name: string, radius: number) {
    const pos = this.bot.entity?.position;
    if (!pos) return [];
    return this.bot.findBlocks({
      matching: (b) => b.name === name,
      maxDistance: radius,
      count: 100,
    }).map(p => this.bot.blockAt(p)).filter(Boolean) as NonNullable<ReturnType<Bot["blockAt"]>>[];
  }

  cancel() { this.cancelled = true; }
}
