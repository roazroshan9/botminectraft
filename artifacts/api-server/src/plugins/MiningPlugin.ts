import type { Bot } from "mineflayer";
import { goals } from "../utils/pathfinder.js";
import type { MinecraftBot } from "../bot/MinecraftBot.js";
import { ORE_TYPES } from "../config/defaults.js";
import { sleep } from "../utils/helpers.js";

const { GoalNear, GoalBlock, GoalY } = goals;

// Optimal Y levels for branch mining per ore type
const OPTIMAL_Y: Record<string, number> = {
  diamond: -59,
  redstone: -59,
  gold: -16,
  iron: 15,
  coal: 95,
  lapis: 0,
  emerald: 220,
  copper: 47,
  debris: 15,
  default: -59,
};

// Threat priority: higher = more dangerous, flee faster
const LAVA_BLOCKS = new Set(["lava", "lava_still", "flowing_lava"]);
const WATER_BLOCKS = new Set(["water", "water_still", "flowing_water"]);

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

    this.mcBot.log(`Starting smart mining: ${quantity}x ${oreName}`);
    let mined = 0;

    // Descend to optimal Y level first
    await this.descendToOptimalY(oreName);

    while (mined < quantity && !this.cancelled) {
      if (!await this.safetyCheck()) {
        await sleep(1000);
        continue;
      }

      // Try vein mining first (most efficient)
      const block = this.findNearestOre(blockName);
      if (!block) {
        this.mcBot.log(`No ${oreName} in range. Starting branch mine...`);
        await this.branchMine(oreName, 16);
        await sleep(500);
        continue;
      }

      try {
        await this.equipBestPickaxe();
        const count = await this.veinMine(block, blockName, quantity - mined);
        mined += count;
        this.mcBot.log(`Mined ${mined}/${quantity} ${oreName}`);
        this.mcBot.taskQueue.updateProgress(
          this.mcBot.taskQueue.getCurrent()?.id || "",
          Math.round((mined / quantity) * 100),
        );
        await this.manageTorches();
        await this.manageInventory();
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
      await this.equipBestPickaxe();
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
        if (!await this.isPathSafe(block.position)) {
          this.mcBot.log(`Path to ${blockName} seems unsafe, skipping...`);
          await sleep(1000);
          continue;
        }
        await this.navigateAndMine(block);
        collected++;
        await sleep(300);
      } catch (err) {
        this.mcBot.log(`Collect error: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(2000);
      }
    }

    this.mcBot.log(`Collected ${collected}/${quantity} ${blockName}`);
  }

  // ─── Smart: descend to optimal Y for the ore ───────────────────────────────
  private async descendToOptimalY(oreName: string): Promise<void> {
    const optY = OPTIMAL_Y[oreName.toLowerCase()] ?? OPTIMAL_Y["default"]!;
    const pos = this.bot.entity?.position;
    if (!pos) return;
    if (Math.abs(pos.y - optY) < 10) return;

    this.mcBot.log(`Descending to optimal Y=${optY} for ${oreName}...`);
    try {
      await this.bot.pathfinder.goto(new GoalY(optY));
    } catch {
      this.mcBot.log(`Could not reach Y=${optY}, mining from current level`);
    }
  }

  // ─── Smart: follow and mine entire ore vein ────────────────────────────────
  private async veinMine(
    startBlock: { position: { x: number; y: number; z: number } },
    blockName: string,
    maxCount: number,
  ): Promise<number> {
    const visited = new Set<string>();
    const queue = [startBlock.position];
    let count = 0;

    while (queue.length > 0 && count < maxCount && !this.cancelled) {
      const pos = queue.shift()!;
      const key = `${pos.x},${pos.y},${pos.z}`;
      if (visited.has(key)) continue;
      visited.add(key);

      const block = this.bot.blockAt(this.bot.vec3(pos.x, pos.y, pos.z));
      if (!block) continue;
      const isOre = block.name === blockName || block.name === `deepslate_${blockName}`;
      if (!isOre) continue;

      if (LAVA_BLOCKS.has(block.name)) {
        this.mcBot.log("⚠ Lava in vein path, stopping vein");
        break;
      }

      try {
        await this.bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, 3));
        if (await this.bot.canDigBlock(block)) {
          await this.bot.dig(block);
          count++;

          // Enqueue face-adjacent neighbors
          for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
            queue.push({ x: pos.x + dx, y: pos.y + dy, z: pos.z + dz });
          }
        }
      } catch { /* continue */ }
    }

    return count;
  }

  // ─── Smart: branch mining pattern ─────────────────────────────────────────
  private async branchMine(oreName: string, branchLength: number): Promise<void> {
    const pos = this.bot.entity?.position;
    if (!pos) return;
    this.mcBot.log(`Branch mining at Y=${Math.round(pos.y)} for ${oreName}...`);

    // Mine two parallel tunnels 3 apart in each cardinal direction
    const directions = [
      { dx: 1, dz: 0 },
      { dx: -1, dz: 0 },
      { dx: 0, dz: 1 },
      { dx: 0, dz: -1 },
    ];

    const dir = directions[Math.floor(Math.random() * directions.length)]!;

    for (let i = 0; i < branchLength && !this.cancelled; i++) {
      const tx = pos.x + dir.dx * i;
      const tz = pos.z + dir.dz * i;
      try {
        await this.bot.pathfinder.goto(new GoalNear(tx, pos.y, tz, 1));
        await this.manageTorches();
        await this.safetyCheck();
      } catch {
        break;
      }
    }
  }

  // ─── Safety: check all 6 faces around bot for lava/fall hazards ───────────
  private async safetyCheck(): Promise<boolean> {
    const pos = this.bot.entity?.position;
    if (!pos) return true;

    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -2; dz <= 2; dz++) {
          const b = this.bot.blockAt(pos.offset(dx, dy, dz));
          if (b && LAVA_BLOCKS.has(b.name)) {
            this.mcBot.log("⚠ Lava nearby! Retreating 10 blocks...");
            try {
              await this.bot.pathfinder.goto(new GoalNear(pos.x, pos.y + 5, pos.z + 10, 3));
            } catch {}
            return false;
          }
        }
      }
    }
    return true;
  }

  private async isPathSafe(target: { x: number; y: number; z: number }): Promise<boolean> {
    const block = this.bot.blockAt(this.bot.vec3(target.x, target.y, target.z));
    if (!block) return true;
    return !LAVA_BLOCKS.has(block.name) && !WATER_BLOCKS.has(block.name);
  }

  // ─── Tool: equip best available pickaxe ────────────────────────────────────
  private async equipBestPickaxe(): Promise<void> {
    const picks = [
      "netherite_pickaxe", "diamond_pickaxe", "iron_pickaxe",
      "stone_pickaxe", "wooden_pickaxe",
    ];
    for (const name of picks) {
      const item = this.bot.inventory.findInventoryItem(
        this.bot.registry.itemsByName[name]?.id ?? -1, null,
      );
      if (item) {
        try { await this.bot.equip(item, "hand"); } catch {}
        return;
      }
    }
  }

  // ─── Navigate to block and dig it ──────────────────────────────────────────
  private async navigateAndMine(block: { position: { x: number; y: number; z: number } }) {
    const { x, y, z } = block.position;
    await this.bot.pathfinder.goto(new GoalBlock(x, y, z));
    await sleep(150);
    const b = this.bot.blockAt(this.bot.vec3(x, y, z));
    if (b && await this.bot.canDigBlock(b)) {
      await this.bot.dig(b);
    }
  }

  private findNearestOre(blockName: string) {
    const names = [blockName, `deepslate_${blockName}`];
    return this.bot.findBlock({
      matching: (b) => names.some(n => b.name === n),
      maxDistance: 64,
    });
  }

  private async manageTorches() {
    const pos = this.bot.entity?.position;
    if (!pos) return;
    const torch = this.bot.inventory.findInventoryItem(
      this.bot.registry.itemsByName["torch"]?.id ?? 50, null,
    );
    if (!torch) return;
    const nearby = this.bot.findBlock({
      matching: (b) => b.name === "torch" || b.name === "wall_torch",
      maxDistance: 8,
    });
    if (!nearby) {
      try {
        const below = this.bot.blockAt(pos.offset(0, -1, 0));
        if (below && below.name !== "air") {
          await this.bot.equip(torch, "hand");
          await this.bot.placeBlock(below, this.bot.vec3(0, 1, 0));
        }
      } catch {}
    }
  }

  private async manageInventory() {
    const items = this.bot.inventory.items();
    if (items.length < 32) return;
    // Drop cobblestone / dirt if inventory is getting full
    for (const item of items) {
      if (["cobblestone", "dirt", "gravel"].includes(item.name) && item.count > 32) {
        try { await this.bot.tossStack(item); } catch {}
      }
    }
  }

  cancel() { this.cancelled = true; }
}
