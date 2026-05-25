import type { Vec3 } from "vec3";

declare module "mineflayer" {
  interface Bot {
    pathfinder: {
      setMovements(movements: unknown): void;
      goto(goal: unknown): Promise<void>;
    };
    vec3(x: number, y: number, z: number): Vec3;
    game: {
      dimension: string;
      [key: string]: unknown;
    };
  }
}


