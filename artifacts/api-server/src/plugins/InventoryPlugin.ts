import type { Bot } from "mineflayer";
import { goals } from "../utils/pathfinder.js";
import type { MinecraftBot } from "../bot/MinecraftBot.js";
import { sleep } from "../utils/helpers.js";

const { GoalBlock } = goals;

const FOOD_ITEMS = [
  "cooked_beef", "cooked_pork", "cooked_chicken", "cooked_mutton",
  "bread", "golden_apple", "cooked_salmon", "cooked_cod",
  "baked_potato", "carrot", "apple",
];

const JUNK_ITEMS = ["cobblestone", "dirt", "gravel", "sand"];

export class InventoryPlugin {
  private bot: Bot;
  private mcBot: MinecraftBot;

  constructor(bot: Bot, mcBot: MinecraftBot) {
    this.bot = bot;
    this.mcBot = mcBot;
  }

  async organize(): Promise<void> {
    this.mcBot.log("Organizing inventory...");
    await this.dropJunk();
    await this.equipBestArmor();
    this.mcBot.log("Inventory organized");
  }

  private async dropJunk() {
    for (const name of JUNK_ITEMS) {
      const item = this.bot.inventory.findInventoryItem(
        this.bot.registry.itemsByName[name]?.id ?? -1, null
      );
      if (item && item.count > 32) {
        try {
          await this.bot.tossStack(item);
          await sleep(200);
        } catch {}
      }
    }
  }

  private async equipBestArmor() {
    const armorSets = [
      { slot: "head",   items: ["netherite_helmet",     "diamond_helmet",     "iron_helmet",     "golden_helmet",     "chainmail_helmet",     "leather_helmet"]     },
      { slot: "torso",  items: ["netherite_chestplate", "diamond_chestplate", "iron_chestplate", "golden_chestplate", "chainmail_chestplate", "leather_chestplate"] },
      { slot: "legs",   items: ["netherite_leggings",   "diamond_leggings",   "iron_leggings",   "golden_leggings",   "chainmail_leggings",   "leather_leggings"]   },
      { slot: "feet",   items: ["netherite_boots",      "diamond_boots",      "iron_boots",      "golden_boots",      "chainmail_boots",      "leather_boots"]      },
    ];

    for (const { slot, items } of armorSets) {
      for (const name of items) {
        const item = this.bot.inventory.findInventoryItem(
          this.bot.registry.itemsByName[name]?.id ?? -1, null
        );
        if (item) {
          try {
            await this.bot.equip(item, slot as Parameters<Bot["equip"]>[1]);
          } catch {}
          break;
        }
      }
    }
  }

  async eatFood(): Promise<void> {
    for (const name of FOOD_ITEMS) {
      const item = this.bot.inventory.findInventoryItem(
        this.bot.registry.itemsByName[name]?.id ?? -1, null
      );
      if (item) {
        try {
          await this.bot.equip(item, "hand");
          await this.bot.consume();
          this.mcBot.log(`Ate ${name}`);
          return;
        } catch {}
      }
    }
    this.mcBot.log("No food available!");
  }

  async depositToNearestChest(): Promise<void> {
    this.mcBot.log("Looking for nearby chest...");
    const chest = this.bot.findBlock({
      matching: (b) => b.name === "chest" || b.name === "barrel",
      maxDistance: 32,
    });

    if (!chest) {
      this.mcBot.log("No chest found nearby");
      return;
    }

    try {
      await this.bot.pathfinder.goto(new GoalBlock(chest.position.x, chest.position.y, chest.position.z));
      const container = await this.bot.openChest(chest);
      const items = this.bot.inventory.items();

      for (const item of items) {
        const keepItems = ["diamond_sword", "iron_pickaxe", "torch", "bread", "water_bucket"];
        if (keepItems.some(k => item.name.includes(k))) continue;
        try {
          await container.deposit(item.type, null, item.count);
          await sleep(100);
        } catch {}
      }

      container.close();
      this.mcBot.log("Items deposited to chest");
    } catch (err) {
      this.mcBot.log(`Chest deposit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async craft(itemName: string, quantity: number): Promise<void> {
    this.mcBot.log(`Crafting ${quantity}x ${itemName}...`);
    const item = this.bot.registry.itemsByName[itemName];
    if (!item) {
      this.mcBot.log(`Unknown item: ${itemName}`);
      return;
    }

    const recipes = this.bot.recipesFor(item.id, null, 1, null);
    if (!recipes.length) {
      this.mcBot.log(`No recipe found for ${itemName}`);
      return;
    }

    const craftingTable = this.bot.findBlock({
      matching: this.bot.registry.blocksByName["crafting_table"]?.id ?? -1,
      maxDistance: 32,
    });

    try {
      if (craftingTable) {
        await this.bot.pathfinder.goto(new GoalBlock(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z));
        await this.bot.craft(recipes[0]!, quantity, craftingTable);
      } else {
        await this.bot.craft(recipes[0]!, quantity, undefined);
      }
      this.mcBot.log(`Crafted ${quantity}x ${itemName}`);
    } catch (err) {
      this.mcBot.log(`Crafting failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  getItems() {
    return this.bot.inventory.slots.filter(Boolean).map(item => ({
      name: item!.name,
      count: item!.count,
      slot: item!.slot,
      displayName: item!.displayName,
    }));
  }
}
