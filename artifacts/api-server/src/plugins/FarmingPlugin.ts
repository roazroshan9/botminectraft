import type { Bot } from "mineflayer";
import { goals } from "../utils/pathfinder.js";
import type { MinecraftBot } from "../bot/MinecraftBot.js";
import { CROP_TYPES } from "../config/defaults.js";
import { sleep } from "../utils/helpers.js";

const { GoalNear, GoalBlock } = goals;

// Extended crop knowledge
const EXTENDED_CROPS: Record<string, { seed: string; mature: number; method: string }> = {
  wheat:     { seed: "wheat_seeds",    mature: 7, method: "age" },
  carrots:   { seed: "carrot",         mature: 7, method: "age" },
  potatoes:  { seed: "potato",         mature: 7, method: "age" },
  beetroot:  { seed: "beetroot_seeds", mature: 3, method: "age" },
  melon:     { seed: "melon_seeds",    mature: 7, method: "stem" },
  pumpkin:   { seed: "pumpkin_seeds",  mature: 7, method: "stem" },
  nether_wart: { seed: "nether_wart", mature: 3, method: "age" },
};

const TREE_LOGS: Record<string, string> = {
  oak: "oak_log", birch: "birch_log", spruce: "spruce_log",
  jungle: "jungle_log", acacia: "acacia_log", dark_oak: "dark_oak_log",
  mangrove: "mangrove_log", cherry: "cherry_log",
  wood: "oak_log",  // default alias
};

// Blocks that grow vertically (harvest top-down)
const VERTICAL_CROPS = new Set(["sugar_cane", "bamboo", "cactus", "kelp"]);

export class FarmingPlugin {
  private bot: Bot;
  private mcBot: MinecraftBot;
  private cancelled = false;

  constructor(bot: Bot, mcBot: MinecraftBot) {
    this.bot = bot;
    this.mcBot = mcBot;
  }

  // ── Crop farming (harvest + replant loop) ──────────────────────────────────
  async farm(cropName: string): Promise<void> {
    this.cancelled = false;
    const crop = EXTENDED_CROPS[cropName.toLowerCase()] ?? CROP_TYPES[cropName.toLowerCase()];
    const blockName = cropName.toLowerCase();

    this.mcBot.log(`Starting ${cropName} farming cycle...`);

    let cycle = 0;
    while (!this.cancelled) {
      cycle++;
      this.mcBot.log(`Farming cycle #${cycle} — scanning for mature ${cropName}...`);
      this.mcBot.taskQueue.tick(10);

      let harvested = 0;

      if (VERTICAL_CROPS.has(blockName)) {
        harvested = await this.harvestVertical(blockName);
      } else if (blockName === "melon") {
        harvested = await this.harvestMelons();
      } else if (blockName === "pumpkin") {
        harvested = await this.harvestPumpkins();
      } else {
        harvested = await this.harvestMature(blockName, crop?.mature ?? 7);
      }

      this.mcBot.taskQueue.tick(60);
      this.mcBot.log(`Harvested ${harvested} ${cropName} in cycle #${cycle}`);

      if (crop?.seed && !VERTICAL_CROPS.has(blockName) && blockName !== "melon" && blockName !== "pumpkin") {
        await this.replantCrops(crop.seed);
        this.mcBot.taskQueue.tick(85);
      }

      this.mcBot.log(`Cycle #${cycle} complete. Waiting 30s for crops to grow...`);
      this.mcBot.taskQueue.tick(100);

      await sleep(30000);
      this.mcBot.taskQueue.tick(0);
    }
  }

  // ── Tree chopping ──────────────────────────────────────────────────────────
  async chopTrees(treeType: string, quantity: number): Promise<void> {
    this.cancelled = false;
    const logBlock = TREE_LOGS[treeType.toLowerCase()] ?? `${treeType.toLowerCase()}_log`;
    this.mcBot.log(`Chopping ${quantity} ${treeType} logs...`);

    let chopped = 0;
    while (chopped < quantity && !this.cancelled) {
      const block = this.bot.findBlock({
        matching: (b) => b.name === logBlock || b.name === `stripped_${logBlock}`,
        maxDistance: 48,
      });

      if (!block) {
        this.mcBot.log(`No ${treeType} trees found nearby. Expanding search...`);
        await this.wanderToFindTrees(logBlock);
        await sleep(2000);
        continue;
      }

      try {
        await this.equipAxe();
        // Navigate to the base of the tree
        const base = { x: block.position.x, y: block.position.y, z: block.position.z };
        await this.bot.pathfinder.goto(new GoalNear(base.x, base.y, base.z, 2));

        // Chop entire column of the same tree (follow log up)
        let logPos = block.position;
        let chopCount = 0;
        while (chopCount < 20 && !this.cancelled) {
          const logBlock2 = this.bot.blockAt(logPos);
          if (!logBlock2 || (!logBlock2.name.includes("_log") && !logBlock2.name.includes("log"))) break;
          if (await this.bot.canDigBlock(logBlock2)) {
            await this.bot.dig(logBlock2);
            chopped++;
            chopCount++;
            this.mcBot.taskQueue.tick(Math.round((chopped / quantity) * 100));
            await sleep(300);
          }
          logPos = logPos.offset(0, 1, 0);
        }

        // Grab leaf drops (just walk under the canopy)
        await sleep(800);
        this.mcBot.log(`Chopped ${chopped}/${quantity} logs`);
      } catch (err) {
        this.mcBot.log(`Chop error: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(2000);
      }
    }

    this.mcBot.log(`Tree chopping complete — got ${chopped} logs`);
  }

  // ── Sugar cane / bamboo / cactus (vertical harvest, leave base) ─────────────
  private async harvestVertical(blockName: string): Promise<number> {
    let count = 0;
    const columns = this.findAllBlocks(blockName, 48);
    const bases = new Set<string>();

    for (const block of columns) {
      // Only snap to base blocks (no same-type block below)
      const below = this.bot.blockAt(block.position.offset(0, -1, 0));
      if (below?.name === blockName) continue; // not a base
      bases.add(`${block.position.x},${block.position.y},${block.position.z}`);
    }

    for (const baseKey of bases) {
      if (this.cancelled) break;
      const [bx, by, bz] = baseKey.split(",").map(Number);
      // Harvest from Y+1 upwards (leave base intact)
      let y = by! + 1;
      let first = true;
      while (!this.cancelled) {
        const above = this.bot.blockAt(this.bot.vec3(bx!, y, bz!));
        if (!above || above.name !== blockName) break;
        try {
          if (first) {
            await this.bot.pathfinder.goto(new GoalNear(bx!, by!, bz!, 2));
            first = false;
          }
          if (await this.bot.canDigBlock(above)) {
            await this.bot.dig(above);
            count++;
          }
        } catch {}
        y++;
        await sleep(150);
      }
    }
    return count;
  }

  // ── Melon / pumpkin (harvest the fruit block, not the stem) ────────────────
  private async harvestMelons(): Promise<number> {
    return this.harvestFruit("melon");
  }
  private async harvestPumpkins(): Promise<number> {
    return this.harvestFruit("pumpkin");
  }

  private async harvestFruit(fruitName: string): Promise<number> {
    let count = 0;
    const blocks = this.findAllBlocks(fruitName, 32);
    for (const block of blocks) {
      if (this.cancelled) break;
      try {
        await this.bot.pathfinder.goto(new GoalNear(block.position.x, block.position.y, block.position.z, 2));
        if (await this.bot.canDigBlock(block)) {
          await this.bot.dig(block);
          count++;
          await sleep(300);
        }
      } catch {}
    }
    return count;
  }

  // ── Standard crop harvest (age-gated) ─────────────────────────────────────
  private async harvestMature(blockName: string, matureAge: number): Promise<number> {
    let count = 0;
    const blocks = this.findAllBlocks(blockName, 40);

    for (const block of blocks) {
      if (this.cancelled) break;
      const age = block.getProperties?.()?.["age"];
      if (age !== undefined && Number(age) < matureAge) continue;

      try {
        await this.bot.pathfinder.goto(new GoalNear(block.position.x, block.position.y, block.position.z, 2));
        if (await this.bot.canDigBlock(block)) {
          await this.bot.dig(block);
          count++;
          await sleep(200);
        }
      } catch {}
    }
    return count;
  }

  // ── Replant seeds on empty farmland ────────────────────────────────────────
  private async replantCrops(seedName: string) {
    const seed = this.bot.inventory.findInventoryItem(
      this.bot.registry.itemsByName[seedName]?.id ?? -1, null,
    );
    if (!seed) { this.mcBot.log(`No ${seedName} to replant`); return; }

    const farmlands = this.findAllBlocks("farmland", 40).filter(b => {
      const above = this.bot.blockAt(b.position.offset(0, 1, 0));
      return above?.name === "air";
    });

    if (!farmlands.length) { this.mcBot.log("No empty farmland found to replant"); return; }

    await this.bot.equip(seed, "hand");
    let replanted = 0;
    for (const farmland of farmlands.slice(0, 64)) {
      if (this.cancelled) break;
      try {
        await this.bot.pathfinder.goto(new GoalNear(farmland.position.x, farmland.position.y + 1, farmland.position.z, 2));
        await this.bot.placeBlock(farmland, this.bot.vec3(0, 1, 0));
        replanted++;
        await sleep(200);
      } catch {}
    }
    this.mcBot.log(`Replanted ${replanted} ${seedName}`);
  }

  // ── Wander looking for trees ────────────────────────────────────────────────
  private async wanderToFindTrees(logBlock: string) {
    const pos = this.bot.entity?.position;
    if (!pos) return;
    const angle = Math.random() * Math.PI * 2;
    const tx = pos.x + Math.cos(angle) * 32;
    const tz = pos.z + Math.sin(angle) * 32;
    try {
      await this.bot.pathfinder.goto(new GoalNear(tx, pos.y, tz, 5));
    } catch {}
  }

  // ── Equip best axe ──────────────────────────────────────────────────────────
  private async equipAxe() {
    const axes = ["netherite_axe", "diamond_axe", "iron_axe", "stone_axe", "wooden_axe"];
    for (const name of axes) {
      const item = this.bot.inventory.findInventoryItem(
        this.bot.registry.itemsByName[name]?.id ?? -1, null,
      );
      if (item) { try { await this.bot.equip(item, "hand"); } catch {} return; }
    }
  }

  // ── Utility ────────────────────────────────────────────────────────────────
  private findAllBlocks(name: string, radius: number) {
    const pos = this.bot.entity?.position;
    if (!pos) return [];
    return this.bot.findBlocks({
      matching: (b) => b.name === name,
      maxDistance: radius,
      count: 200,
    }).map(p => this.bot.blockAt(p)).filter(Boolean) as NonNullable<ReturnType<Bot["blockAt"]>>[];
  }

  cancel() { this.cancelled = true; }
}
