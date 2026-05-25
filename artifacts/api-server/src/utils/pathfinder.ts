import { createRequire } from "node:module";
import type { Bot, Plugin } from "mineflayer";

const require = createRequire(import.meta.url);

export interface MovementsInstance {
  allowSprinting: boolean;
  allowParkour:   boolean;
  canDig:         boolean;
}

const mineflayerPathfinder = require("mineflayer-pathfinder") as {
  pathfinder: Plugin;
  Movements: new (bot: Bot) => MovementsInstance;
  goals: {
    GoalNear:   new (x: number, y: number, z: number, r: number) => unknown;
    GoalBlock:  new (x: number, y: number, z: number) => unknown;
    GoalFollow: new (entity: unknown, r: number) => unknown;
    GoalXZ:     new (x: number, z: number) => unknown;
    GoalY:      new (y: number) => unknown;
  };
};

export const pathfinder = mineflayerPathfinder.pathfinder;
export const Movements  = mineflayerPathfinder.Movements;
export const goals      = mineflayerPathfinder.goals;
