import type { Bot } from "mineflayer";
import { goals } from "../utils/pathfinder.js";
import type { MinecraftBot } from "../bot/MinecraftBot.js";
import { ORE_TYPES } from "../config/defaults.js";
import { sleep } from "../utils/helpers.js";

const { GoalNear, GoalBlock, GoalY } = goals;

// Optimal Y levels for each ore (1.18+ world height)
const OPTIMAL_Y: Record<string, number> = {
  diamond:  -59,
  redstone: -59,
  lapis:      0,
  gold:     -16,
  iron:      15,
  coal:      95,
  emerald:  220,
  copper:    47,
  debris:    15,   // ancient_debris
  quartz:    30,   // nether
  default:  -59,
};

const LAVA_BLOCKS  = new Set(["lava", "lava_still", "flowing_lava"]);
const WATER_BLOCKS = new Set(["water", "water_still", "flowing_water"]);

// Deepslate variants share the same loot as their surface counterpart
function oreVariants(base: string): string[] {
  return [base, `deepslate_${base}`, `nether_${base}`].filter(Boolean);
}

export class MiningPlugin {
  private bot: Bot;
  private mcBot: MinecraftBot;
  private cancelled = false;

  constructor(bot: Bot, mcBot: MinecraftBot) {
    this.bot = bot;
    this.mcBot = mcBot;
  }

  // ── Public: mine a specific ore ───────────────────────────────────────────
  async mine(oreName: string, quantity: number): Promise<void> {
    this.cancelled = false;
    const oreInfo = ORE_TYPES[oreName.toLowerCase()];
    const baseBlock = oreInfo?.block ?? `${oreName.toLowerCase()}_ore`;

    this.mcBot.log(`⛏ Smart mine: ${quantity}× ${oreName} (targeting Y=${OPTIMAL_Y[oreName.toLowerCase()] ?? OPTIMAL_Y["default"]})`);
    const taskId = this.mcBot.taskQueue.getCurrentId();

    // 1 — descend to optimal Y level
    await this.descendToOptimalY(oreName);

    let mined = 0;
    let branchCycles = 0;

    while (mined < quantity && !this.cancelled) {
      // Safety sweep
      if (!await this.safetyCheck()) { await sleep(1500); continue; }

      const block = this.findNearestOre(baseBlock);
      if (!block) {
        // No ore in scan radius → branch mine
        branchCycles++;
        this.mcBot.log(`No ${oreName} visible — branch mining (cycle ${branchCycles})...`);
        await this.branchMine(oreName, 24);
        await sleep(600);
        continue;
      }

      try {
        await this.equipBestPickaxe();
        const gained = await this.veinMine(block, baseBlock, quantity - mined);
        mined += gained;
        const pct = Math.round((mined / quantity) * 100);
        this.mcBot.taskQueue.updateProgress(taskId, pct);
        this.mcBot.log(`⛏ ${mined}/${quantity} ${oreName} (${pct}%)`);
        await this.manageTorches();
        await this.manageInventory();
      } catch (err) {
        this.mcBot.log(`Mining error: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(2000);
      }
    }

    this.mcBot.log(`✅ Mining complete — got ${mined}/${quantity} ${oreName}`);
  }

  // ── Public: collect a named block (surface/generic) ───────────────────────
  async collectBlock(blockName: string, quantity: number): Promise<void> {
    this.cancelled = false;
    this.mcBot.log(`Collecting ${quantity}× ${blockName}...`);
    const taskId = this.mcBot.taskQueue.getCurrentId();
    let collected = 0;

    while (collected < quantity && !this.cancelled) {
      await this.equipBestPickaxe();

      const block = this.bot.findBlock({
        matching: (b) => b.name === blockName || b.name.startsWith(blockName),
        maxDistance: 64,
      });

      if (!block) {
        this.mcBot.log(`No ${blockName} found within 64 blocks`);
        await sleep(3000);
        continue;
      }

      if (!await this.isPosSafe(block.position)) { await sleep(1000); continue; }

      try {
        await this.bot.pathfinder.goto(new GoalNear(block.position.x, block.position.y, block.position.z, 2));
        const b = this.bot.blockAt(block.position);
        if (b && await this.bot.canDigBlock(b)) {
          await this.bot.dig(b);
          collected++;
          this.mcBot.taskQueue.updateProgress(taskId, Math.round((collected / quantity) * 100));
        }
        await sleep(250);
      } catch (err) {
        this.mcBot.log(`Collect error: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(2000);
      }
    }

    this.mcBot.log(`✅ Collected ${collected}/${quantity} ${blockName}`);
  }

  // ── Smart: vein mine — follow all connected ore blocks ────────────────────
  private async veinMine(
    startBlock: { position: { x: number; y: number; z: number } },
    baseBlockName: string,
    maxCount: number,
  ): Promise<number> {
    const variants = new Set(oreVariants(baseBlockName));
    const visited  = new Set<string>();
    const queue    = [{ ...startBlock.position }];
    let count      = 0;

    while (queue.length > 0 && count < maxCount && !this.cancelled) {
      const pos = queue.shift()!;
      const key = `${pos.x},${pos.y},${pos.z}`;
      if (visited.has(key)) continue;
      visited.add(key);

      const block = this.bot.blockAt(this.bot.vec3(pos.x, pos.y, pos.z));
      if (!block) continue;
      if (!variants.has(block.name)) continue;
      if (LAVA_BLOCKS.has(block.name)) { this.mcBot.log("⚠ Lava in vein — stopping"); break; }

      try {
        await this.bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, 2));
        if (await this.bot.canDigBlock(block)) {
          await this.bot.dig(block);
          count++;
          // Enqueue all 6 face-adjacent neighbours
          for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
            queue.push({ x: pos.x+dx, y: pos.y+dy, z: pos.z+dz });
          }
        }
      } catch { /* keep going */ }
    }
    return count;
  }

  // ── Smart: branch mining pattern at current Y ─────────────────────────────
  private async branchMine(oreName: string, branchLen: number): Promise<void> {
    const pos = this.bot.entity?.position;
    if (!pos) return;

    // Choose a cardinal direction semi-randomly to spread branches
    const dirs = [{ dx:1,dz:0 },{ dx:-1,dz:0 },{ dx:0,dz:1 },{ dx:0,dz:-1 }];
    const dir  = dirs[Math.floor(Math.random() * dirs.length)]!;

    for (let i = 0; i < branchLen && !this.cancelled; i++) {
      const tx = pos.x + dir.dx * i;
      const tz = pos.z + dir.dz * i;
      try {
        await this.bot.pathfinder.goto(new GoalNear(tx, pos.y, tz, 1));
        if (i % 6 === 0) {
          await this.manageTorches();
          if (!await this.safetyCheck()) break;
        }
      } catch { break; }
    }
  }

  // ── Descend to optimal Y for this ore ─────────────────────────────────────
  private async descendToOptimalY(oreName: string): Promise<void> {
    const targetY = OPTIMAL_Y[oreName.toLowerCase()] ?? OPTIMAL_Y["default"]!;
    const pos = this.bot.entity?.position;
    if (!pos) return;
    if (Math.abs(pos.y - targetY) < 8) return; // already close enough

    this.mcBot.log(`Descending to Y=${targetY} for ${oreName}...`);
    try {
      await this.bot.pathfinder.goto(new GoalY(targetY));
    } catch {
      this.mcBot.log(`Cannot reach Y=${targetY}, mining from Y=${Math.round(pos.y)}`);
    }
  }

  // ── Safety: scan 5×3×5 cube for lava ──────────────────────────────────────
  private async safetyCheck(): Promise<boolean> {
    const pos = this.bot.entity?.position;
    if (!pos) return true;

    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -2; dz <= 2; dz++) {
          const b = this.bot.blockAt(pos.offset(dx, dy, dz));
          if (b && LAVA_BLOCKS.has(b.name)) {
            this.mcBot.log("⚠ Lava detected — retreating!");
            try {
              await this.bot.pathfinder.goto(new GoalNear(pos.x, pos.y + 5, pos.z + 12, 4));
            } catch {}
            return false;
          }
        }
      }
    }
    return true;
  }

  private async isPosSafe(target: { x: number; y: number; z: number }): Promise<boolean> {
    const b = this.bot.blockAt(this.bot.vec3(target.x, target.y, target.z));
    return !b || (!LAVA_BLOCKS.has(b.name) && !WATER_BLOCKS.has(b.name));
  }

  // ── Equip best pickaxe ────────────────────────────────────────────────────
  private async equipBestPickaxe() {
    const picks = ["netherite_pickaxe","diamond_pickaxe","iron_pickaxe","stone_pickaxe","wooden_pickaxe"];
    for (const name of picks) {
      const item = this.bot.inventory.findInventoryItem(
        this.bot.registry.itemsByName[name]?.id ?? -1, null, false,
      );
      if (item) { try { await this.bot.equip(item, "hand"); } catch {} return; }
    }
  }

  // ── Torch placement every ~8 blocks ───────────────────────────────────────
  private async manageTorches() {
    const pos = this.bot.entity?.position;
    if (!pos) return;
    const torchId = this.bot.registry.itemsByName["torch"]?.id ?? 50;
    const torch = this.bot.inventory.findInventoryItem(torchId, null, false);
    if (!torch) return;

    const nearTorch = this.bot.findBlock({
      matching: (b) => b.name === "torch" || b.name === "wall_torch",
      maxDistance: 8,
    });
    if (!nearTorch) {
      try {
        const below = this.bot.blockAt(pos.offset(0, -1, 0));
        if (below && below.name !== "air") {
          await this.bot.equip(torch, "hand");
          await this.bot.placeBlock(below, this.bot.vec3(0, 1, 0));
        }
      } catch {}
    }
  }

  // ── Drop junk if inventory near-full ──────────────────────────────────────
  private async manageInventory() {
    const items = this.bot.inventory.items();
    if (items.length < 32) return;
    for (const item of items) {
      if (["cobblestone","cobbled_deepslate","gravel","dirt","sand","andesite","diorite","granite"].includes(item.name) && item.count > 32) {
        try { await this.bot.tossStack(item); } catch {}
      }
    }
  }

  // ── Find nearest ore (all variants) ───────────────────────────────────────
  private findNearestOre(baseBlockName: string) {
    const variants = oreVariants(baseBlockName);
    return this.bot.findBlock({
      matching: (b) => variants.some(v => b.name === v),
      maxDistance: 64,
    });
  }

  cancel() { this.cancelled = true; }
}
