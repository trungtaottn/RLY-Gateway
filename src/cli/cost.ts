import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/load-config.js";
import { RLY_STATE_DIRECTORY_NAME } from "../storage/paths.js";
import type { LedgerQuery } from "../ledger/sqlite.js";
import { queryLedger, pruneLedger } from "../ledger/sqlite.js";

const ALLOWED_GROUP_BY: Record<string, true> = { model: true, provider: true };

function parseSince(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Support 7d / 24h / ISO string
  const relative = value.match(/^(\d+)(d|h)$/);
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2];
    const ms = unit === "d" ? n * 86_400_000 : n * 3_600_000;
    return new Date(Date.now() - ms).toISOString();
  }
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  throw new Error(`invalid --since value: ${value}`);
}

export async function runCost(configPath: string, args: readonly string[]): Promise<number> {
  let since: string | undefined;
  let groupBy: "model" | "provider" | undefined;
  let json = false;
  let prune: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--since" && i + 1 < args.length) {
      since = parseSince(args[i + 1]);
      i += 1;
    } else if (arg?.startsWith("--since=")) {
      since = parseSince(arg.slice("--since=".length));
    } else if (arg === "--group-by" && i + 1 < args.length) {
      const v = args[i + 1] as string;
      if (!(v in ALLOWED_GROUP_BY)) throw new Error(`invalid --group-by: ${v}`);
      groupBy = v as "model" | "provider";
      i += 1;
    } else if (arg?.startsWith("--group-by=")) {
      const v = arg.slice("--group-by=".length);
      if (!(v in ALLOWED_GROUP_BY)) throw new Error(`invalid --group-by: ${v}`);
      groupBy = v as "model" | "provider";
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--prune" && i + 1 < args.length) {
      prune = parseSince(args[i + 1]);
      i += 1;
    } else if (arg?.startsWith("--prune=")) {
      prune = parseSince(arg.slice("--prune=".length));
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: rly cost [--since 7d|ISO] [--group-by model|provider] [--json] [--prune 90d]");
      return 0;
    }
  }

  const config = await loadConfig(configPath).catch(() => undefined);
  const directory = config?.controlPlane.dataDirectory ?? join(homedir(), RLY_STATE_DIRECTORY_NAME);

  if (prune !== undefined) {
    const deleted = await pruneLedger(directory, prune);
    console.log(JSON.stringify({ pruned: deleted, before: prune }));
    return 0;
  }

  const query: Record<string, string> = {};
  if (since !== undefined) query["since"] = since;
  if (groupBy !== undefined) query["groupBy"] = groupBy;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- exactOptionalPropertyTypes needs narrowed record
  const groups = await queryLedger(directory, query as unknown as LedgerQuery);
  // Secret-free assertion already in sqlite layer; double-check serialized output
  const payload = JSON.stringify(groups);
  if (/\bBearer\b/.test(payload)) throw new Error("cost output must be secret-free");

  if (json) {
    console.log(JSON.stringify(groups, null, 2));
    return 0;
  }
  if (groups.length === 0) {
    console.log("No ledger entries");
    return 0;
  }
  console.log("provider\tmodel\tcost\tcount\tinput\toutput");
  for (const g of groups) {
    console.log(`${g.provider}\t${g.model}\t${g.totalCost.toFixed(6)}\t${String(g.count)}\t${String(g.inputTokens)}\t${String(g.outputTokens)}`);
  }
  return 0;
}
