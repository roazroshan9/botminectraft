export interface ParsedCommand {
  command: string;
  args: string[];
  amount?: number;
  raw: string;
}

const ALIASES: Record<string, string> = {
  "followme": "follow",
  "go": "goto",
  "dig": "mine",
  "harvest": "farm",
  "fight": "attack",
  "kill": "attack",
  "store": "deposit",
  "sort": "organize",
  "inv": "organize",
  "wp": "waypoint",
  "tp": "goto",
};

export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\s+/);
  let command = (parts[0] || "").toLowerCase();
  command = ALIASES[command] || command;

  const rest = parts.slice(1);
  const args: string[] = [];
  let amount: number | undefined;

  for (const part of rest) {
    const num = parseInt(part, 10);
    if (!isNaN(num) && amount === undefined) {
      amount = num;
    } else {
      args.push(part.toLowerCase());
    }
  }

  return { command, args, amount, raw: trimmed };
}
