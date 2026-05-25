import type { Bot } from "mineflayer";
import { goals } from "../utils/pathfinder.js";
import type { MinecraftBot } from "../bot/MinecraftBot.js";
import { sleep } from "../utils/helpers.js";

const { GoalNear, GoalBlock } = goals;

type Vec3Like = { x: number; y: number; z: number };

interface Blueprint {
  name: string;
  blocks: Array<{ dx: number; dy: number; dz: number; block: string }>;
  materials: Record<string, number>;
}

const BLUEPRINTS: Record<string, Blueprint> = {
  house: {
    name: "Simple House",
    materials: { oak_planks: 40, oak_log: 16, glass_pane: 8, oak_door: 1 },
    blocks: [
      ...makeWalls(0, 0, 0, 7, 5, 7, "oak_planks"),
      ...makeFloor(0, 0, 0, 7, 7, "oak_planks"),
      ...makeRoof(0, 5, 0, 7, 7, "oak_log"),
    ],
  },
  tower: {
    name: "Stone Tower",
    materials: { cobblestone: 80 },
    blocks: makeWalls(0, 0, 0, 5, 10, 5, "cobblestone"),
  },
  bridge: {
    name: "Wooden Bridge",
    materials: { oak_planks: 30, oak_fence: 16 },
    blocks: [
      ...makeFloor(0, 0, 0, 3, 10, "oak_planks"),
      ...makeFences(0, 1, 0, 3, 10),
    ],
  },
};

function makeWalls(x: number, y: number, z: number, w: number, h: number, d: number, block: string) {
  const blocks: Blueprint["blocks"] = [];
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (dy === 0 || dy === h - 1 || dx === 0 || dx === w - 1)
        blocks.push({ dx: x + dx, dy: y + dy, dz: z, block }, { dx: x + dx, dy: y + dy, dz: z + d - 1, block });
    }
    for (let dz = 1; dz < d - 1; dz++) {
      blocks.push({ dx: x, dy: y + dy, dz: z + dz, block }, { dx: x + w - 1, dy: y + dy, dz: z + dz, block } as Blueprint["blocks"][0]);
    }
  }
  return blocks.map(b => ({ ...b, block }));
}

function makeFloor(x: number, y: number, z: number, w: number, d: number, block: string) {
  const blocks: Blueprint["blocks"] = [];
  for (let dx = 0; dx < w; dx++)
    for (let dz = 0; dz < d; dz++)
      blocks.push({ dx: x + dx, dy: y, dz: z + dz, block });
  return blocks;
}

function makeRoof(x: number, y: number, z: number, w: number, d: number, block: string) {
  return makeFloor(x, y, z, w, d, block);
}

function makeFences(x: number, y: number, z: number, w: number, d: number) {
  const blocks: Blueprint["blocks"] = [];
  for (let dz = 0; dz < d; dz++) {
    blocks.push({ dx: x, dy: y, dz: z + dz, block: "oak_fence" });
    blocks.push({ dx: x + w - 1, dy: y, dz: z + dz, block: "oak_fence" });
  }
  return blocks;
}

export class BuildingPlugin {
  private bot: Bot;
  private mcBot: MinecraftBot;
  private cancelled = false;

  constructor(bot: Bot, mcBot: MinecraftBot) {
    this.bot = bot;
    this.mcBot = mcBot;
  }

  async build(structureName: string): Promise<void> {
    this.cancelled = false;
    const blueprint = BLUEPRINTS[structureName.toLowerCase()];
    if (!blueprint) {
      this.mcBot.log(`Unknown structure: ${structureName}. Available: ${Object.keys(BLUEPRINTS).join(", ")}`);
      return;
    }

    this.mcBot.log(`Building ${blueprint.name}...`);

    const origin = this.bot.entity?.position;
    if (!origin) return;

    const baseX = Math.round(origin.x) + 3;
    const baseY = Math.round(origin.y);
    const baseZ = Math.round(origin.z) + 3;

    let placed = 0;
    for (const spec of blueprint.blocks) {
      if (this.cancelled) break;

      const x = baseX + spec.dx;
      const y = baseY + spec.dy;
      const z = baseZ + spec.dz;

      await this.placeBlock(x, y, z, spec.block);
      placed++;

      const pct = Math.round((placed / blueprint.blocks.length) * 100);
      this.mcBot.taskQueue.updateProgress(this.mcBot.taskQueue.getCurrent()?.id || "", pct);
    }

    this.mcBot.log(`Built ${blueprint.name}! Placed ${placed} blocks`);
  }

  private async placeBlock(x: number, y: number, z: number, blockName: string) {
    const existing = this.bot.blockAt(this.bot.vec3(x, y, z));
    if (existing && existing.name !== "air") return;

    const item = this.bot.inventory.findInventoryItem(
      this.bot.registry.itemsByName[blockName]?.id ?? -1, null, false
    );
    if (!item) {
      await this.gatherMaterial(blockName);
      return;
    }

    try {
      await this.bot.pathfinder.goto(new GoalNear(x, y, z, 3));
      await this.bot.equip(item, "hand");
      const below = this.bot.blockAt(this.bot.vec3(x, y - 1, z));
      if (below) await this.bot.placeBlock(below, this.bot.vec3(0, 1, 0));
    } catch {}
    await sleep(100);
  }

  private async gatherMaterial(blockName: string) {
    const blockInWorld = this.bot.findBlock({
      matching: (b) => b.name === blockName || b.name.includes(blockName.replace("_planks", "_log")),
      maxDistance: 32,
    });
    if (!blockInWorld) {
      this.mcBot.log(`Missing material: ${blockName}`);
      return;
    }
    try {
      await this.bot.pathfinder.goto(new GoalBlock(blockInWorld.position.x, blockInWorld.position.y, blockInWorld.position.z));
      await this.bot.dig(blockInWorld);
    } catch {}
  }

  cancel() { this.cancelled = true; }
}
