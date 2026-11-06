#!/usr/bin/env node
import { evaluate, formatTable } from "./evaluate.mjs";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const seedsAt = args.indexOf("--seeds");
const seeds =
  seedsAt >= 0
    ? args[seedsAt + 1].split(",").flatMap((part) => {
        const [from, to = from] = part.split("-").map(Number);
        return Array.from({ length: to - from + 1 }, (_, i) => from + i);
      })
    : undefined;
const result = evaluate({ seeds });
console.log(formatTable(result));
if (verbose)
  for (const row of result.rows)
    for (const run of row.runs)
      if (run.fn || run.fp)
        console.log(
          `${row.name} seed ${run.seed}: FN ${run.fn} FP ${run.fp} missed bottoms at ${run.missed.join(", ") || "-"}`,
        );
