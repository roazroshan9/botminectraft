export interface ParsedCommand {
  command: string;
  args: string[];
  amount?: number;
  raw: string;
}

const ALIASES: Record<string, string> = {
  // movement
  "go":         "goto",
  "tp":         "goto",
  "navigate":   "goto",
  "nav":        "goto",
  "walk":       "goto",
  // mining
  "dig":        "mine",
  "drill":      "mine",
  "excavate":   "mine",
  "collect":    "collect",
  "gather":     "collect",
  "get":        "collect",
  "pick":       "collect",
  // farming
  "harvest":    "farm",
  "grow":       "farm",
  "crop":       "farm",
  "chop":       "chop",
  "tree":       "chop",
  "woodcut":    "chop",
  "lumber":     "chop",
  "cut":        "chop",
  // combat
  "fight":      "attack",
  "kill":       "attack",
  "slay":       "attack",
  "attack":     "attack",
  "protect":    "defend",
  "guard":      "defend",
  "shield":     "defend",
  // follow
  "followme":   "follow",
  "come":       "follow",
  "track":      "follow",
  // inventory
  "store":      "deposit",
  "deposit":    "deposit",
  "sort":       "organize",
  "inv":        "organize",
  // exploration
  "explore":    "find",
  "search":     "find",
  "locate":     "find",
  "scout":      "patrol",
  // waypoint
  "wp":         "waypoint",
  // misc
  "halt":       "stop",
  "cancel":     "stop",
  "abort":      "stop",
  "idle":       "stop",
};

export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\s+/);
  let command = (parts[0] || "").toLowerCase();
  command = ALIASES[command] ?? command;

  const rest = parts.slice(1);
  const args: string[] = [];
  let amount: number | undefined;

  for (const part of rest) {
    const num = parseInt(part, 10);
    // Only treat a token as amount if it is a non-negative integer with no extra chars.
    // Negative numbers (e.g. "-200" as a Z coordinate) are kept as positional args.
    if (!isNaN(num) && num >= 0 && String(num) === part && amount === undefined) {
      amount = num;
    } else {
      args.push(part.toLowerCase());
    }
  }

  return { command, args, amount, raw: trimmed };
}
