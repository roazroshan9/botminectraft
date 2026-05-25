import type { Bot } from "mineflayer";
import { goals } from "../utils/pathfinder.js";
import type { MinecraftBot } from "../bot/MinecraftBot.js";
import { StructureRepo, WaypointRepo } from "../database/Database.js";
import { sleep } from "../utils/helpers.js";
import { randomUUID } from "node:crypto";

const { GoalNear } = goals;

const STRUCTURE_BLOCKS: Record<string, string[]> = {
  village:      ["bell", "composter"],
  temple:       ["sandstone_stairs", "chiseled_sandstone"],
  stronghold:   ["end_portal_frame", "iron_bars"],
  mansion:      ["dark_oak_log", "dark_oak_planks"],
  monument:     ["prismarine", "sea_lantern"],
  mineshaft:    ["chain", "oak_fence"],
  ancient_city: ["sculk_catalyst", "sculk_shrieker", "sculk_sensor"],
  bastion:      ["blackstone", "gilded_blackstone"],
  fortress:     ["nether_bricks", "blaze_spawner"],
  shipwreck:    ["spruce_planks", "spruce_log"],
  igloo:        ["packed_ice", "white_carpet"],
};

type Waypoint = { x: number; y: number; z: number; name?: string };

export class ExplorationPlugin {
  private bot: Bot;
  private mcBot: MinecraftBot;
  private cancelled = false;
  private patrolActive = false;

  constructor(bot: Bot, mcBot: MinecraftBot) {
    this.bot = bot;
    this.mcBot = mcBot;
  }

  // ─── Navigate to a single coordinate ──────────────────────────────────────
  async goTo(x: number, y: number, z: number): Promise<void> {
    this.mcBot.log(`Navigating to ${Math.round(x)} ${Math.round(y)} ${Math.round(z)}...`);
    const success = await this.navigateWithRetry(x, y, z, 2, 3);
    if (success) {
      this.mcBot.log(`Arrived at ${Math.round(x)} ${Math.round(y)} ${Math.round(z)}`);
    } else {
      this.mcBot.log(`Could not reach ${Math.round(x)} ${Math.round(y)} ${Math.round(z)} after retries`);
    }
  }

  // ─── Patrol a list of waypoints in a loop ─────────────────────────────────
  async patrol(waypoints: Waypoint[], loops = 0): Promise<void> {
    if (waypoints.length < 2) {
      this.mcBot.log("Patrol needs at least 2 waypoints");
      return;
    }
    this.cancelled = false;
    this.patrolActive = true;
    const loopLabel = loops === 0 ? "indefinitely" : `${loops} time(s)`;
    this.mcBot.log(`Starting patrol of ${waypoints.length} waypoints, ${loopLabel}`);

    let iteration = 0;
    while (this.patrolActive && !this.cancelled && (loops === 0 || iteration < loops)) {
      for (let i = 0; i < waypoints.length && !this.cancelled && this.patrolActive; i++) {
        const wp = waypoints[i]!;
        const label = wp.name || `WP${i + 1}`;
        this.mcBot.log(`Patrol → ${label} (${Math.round(wp.x)}, ${Math.round(wp.y)}, ${Math.round(wp.z)})`);
        await this.navigateWithRetry(wp.x, wp.y, wp.z, 3, 2);
        this.mcBot.taskQueue.updateProgress(
          this.mcBot.taskQueue.getCurrentId(),
          Math.round(((i + 1) / waypoints.length) * 100),
        );
        await sleep(500);
      }
      iteration++;
      if (loops === 0) this.mcBot.log("Patrol loop complete, repeating...");
    }

    this.mcBot.log("Patrol finished");
  }

  // ─── Load DB waypoints and patrol them ─────────────────────────────────────
  async patrolSavedWaypoints(loops = 0): Promise<void> {
    const dbWps = WaypointRepo.getByBot(this.mcBot.id) as Array<{
      name: string; x: number; y: number; z: number;
    }>;
    if (!dbWps.length) {
      this.mcBot.log("No saved waypoints to patrol");
      return;
    }
    await this.patrol(dbWps, loops);
  }

  // ─── Structure finder ──────────────────────────────────────────────────────
  async findStructure(structureName: string): Promise<void> {
    this.cancelled = false;
    const name = structureName.toLowerCase();
    this.mcBot.log(`Searching for ${name}...`);

    let searchRadius = 64;
    let found = false;

    while (!found && !this.cancelled && searchRadius <= 1024) {
      found = await this.scanForStructure(name, searchRadius);
      if (!found) {
        await this.moveAndScan(searchRadius);
        searchRadius *= 2;
        this.mcBot.log(`Expanding search radius to ${searchRadius} blocks...`);
      }
    }

    if (!found) this.mcBot.log(`Could not find ${name} within search area`);
  }

  // ─── Smart navigate with retries and alternate approach ────────────────────
  private async navigateWithRetry(
    x: number, y: number, z: number,
    tolerance = 2,
    maxAttempts = 3,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.bot.pathfinder.goto(new GoalNear(x, y, z, tolerance));
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < maxAttempts) {
          // Widen tolerance on retry and try from a slightly offset position
          this.mcBot.log(`Navigation attempt ${attempt} failed (${msg}), retrying with wider goal...`);
          tolerance += 2;
          await sleep(800);
        }
      }
    }
    return false;
  }

  private async scanForStructure(name: string, radius: number): Promise<boolean> {
    const indicators = STRUCTURE_BLOCKS[name] || [];
    if (!indicators.length) {
      this.mcBot.log(`No signature known for ${name}, exploring randomly`);
      return false;
    }

    for (const blockName of indicators) {
      const block = this.bot.findBlock({
        matching: (b) => b.name === blockName,
        maxDistance: radius,
      });

      if (block) {
        const pos = block.position;
        this.mcBot.log(`Found ${name} indicators at ${Math.round(pos.x)} ${Math.round(pos.y)} ${Math.round(pos.z)}!`);

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
    await sleep(1500);
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

  cancel() {
    this.cancelled = true;
    this.patrolActive = false;
  }
}
