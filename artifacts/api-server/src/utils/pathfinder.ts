import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const mineflayerPathfinder = require("mineflayer-pathfinder") as {
  pathfinder: unknown;
  Movements: new (...args: unknown[]) => unknown;
  goals: {
    GoalNear: new (x: number, y: number, z: number, r: number) => unknown;
    GoalBlock: new (x: number, y: number, z: number) => unknown;
    GoalFollow: new (entity: unknown, r: number) => unknown;
    GoalXZ: new (x: number, z: number) => unknown;
  };
};

export const pathfinder = mineflayerPathfinder.pathfinder;
export const Movements = mineflayerPathfinder.Movements;
export const goals = mineflayerPathfinder.goals;
